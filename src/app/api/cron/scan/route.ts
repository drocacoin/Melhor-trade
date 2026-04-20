import { NextRequest, NextResponse } from 'next/server'
import { fetchCandles, fetchFundingRate, fetchFearAndGreed, fetchLivePrice } from '@/lib/fetcher'
import { computeSnapshot } from '@/lib/indicators'
import { supabaseAdmin } from '@/lib/supabase'
import { sendTelegram, fmtSignal, fmtScanSummary, fmtStopAlert } from '@/lib/telegram'
import { computeThreshold } from '@/lib/threshold'
import { loadWeights } from '@/lib/weights'
import { generateSignalAnalysis } from '@/lib/signal-analysis'
import { fetchSetupHistory, checkCorrelation, suggestRisk, buildExitStrategy, buildConfluence } from '@/lib/signal-context'
import { Asset } from '@/types'

export const maxDuration = 60

const ASSETS: Asset[] = ['BTC', 'ETH', 'SOL', 'HYPE', 'AAVE', 'LINK', 'AVAX', 'GOLD']
const TIMEFRAMES       = ['1wk', '1d', '4h', '1h']

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export async function GET(req: NextRequest) {
  const secret = req.headers.get('x-cron-secret') ?? req.nextUrl.searchParams.get('secret')
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const sendSummary = req.nextUrl.searchParams.get('send_summary') === 'true'

  const db = supabaseAdmin()

  // ── Contexto global ────────────────────────────────────────────────────────
  const [fg, fundings, { data: perfRows }, { data: macroRow }, { data: openTrades }] = await Promise.all([
    fetchFearAndGreed(),
    Promise.all(ASSETS.map(a => fetchFundingRate(a).then(v => [a, v] as [string, number | null]))),
    db.from('performance_summary').select('*'),
    db.from('macro_readings').select('*').order('captured_at', { ascending: false }).limit(1),
    db.from('trades').select('*').eq('status', 'open'),
  ])

  const fundingMap  = Object.fromEntries(fundings)
  const perfMap: Record<string, any>  = {}
  for (const p of perfRows ?? []) perfMap[p.asset] = p
  const latestMacro = macroRow?.[0] ?? null

  // Thresholds dinâmicos
  const thresholds: Record<string, ReturnType<typeof computeThreshold>> = {}
  for (const asset of ASSETS) thresholds[asset] = computeThreshold(perfMap[asset])

  // ── Scan ──────────────────────────────────────────────────────────────────
  const results: Record<string, any> = {}
  const biases:  Record<string, string> = {}
  let newSignals = 0

  for (const asset of ASSETS) {
    results[asset] = { threshold: thresholds[asset] }
    const snapshots: Record<string, any> = {}

    for (const tf of TIMEFRAMES) {
      try {
        const candles = await fetchCandles(asset, tf)
        if (candles.length < 60) {
          results[asset][tf] = `only ${candles.length} candles`
        } else {
          const snap = computeSnapshot(candles)
          snapshots[tf] = snap
          results[asset][tf] = { close: snap.close, bias: snap.bias }
          await db.from('snapshots').insert({ asset, timeframe: tf, ...snap })
        }
      } catch (e: any) {
        console.error(`[scan] ${asset} ${tf}:`, e.message)
        results[asset][tf] = `ERROR: ${e.message}`
      }
      await sleep(300)
    }

    if (snapshots['1d']?.bias) biases[asset] = snapshots['1d'].bias

    // ── Detectar sinal com pesos dinâmicos ────────────────────────────────
    const { threshold } = thresholds[asset]
    const weights = await loadWeights(asset)
    const signal  = detectSignal(asset, snapshots, fg, threshold, weights)

    if (signal) {
      // Enriquecer com contexto
      const [history, exitStrategy, confluence] = await Promise.all([
        fetchSetupHistory(db, asset, signal.direction),
        Promise.resolve(buildExitStrategy(signal.rr1, signal.target1, signal.target2)),
        Promise.resolve(buildConfluence(snapshots, signal.direction as 'long' | 'short')),
      ])

      const correlation = checkCorrelation(asset, signal.direction, openTrades ?? [])
      const riskSuggest = suggestRisk(history?.winRate ?? null, signal.rr1)

      const enriched = { ...signal, history, exitStrategy, confluence, correlation, riskSuggest }

      const { data } = await db.from('signals').insert(signal).select().single()
      if (data) {
        newSignals++

        // Auto-análise Haiku
        let analysis = ''
        try {
          analysis = await generateSignalAnalysis(data, snapshots, latestMacro, fg, 'haiku')
          await db.from('signals').update({ analysis }).eq('id', data.id)
        } catch (e: any) {
          console.error(`[scan] análise ${asset}:`, e.message)
        }

        await sendTelegram(fmtSignal({ ...enriched, analysis }, fg, fundingMap[asset] ?? null))
        results[asset].signal = { ...data, analysis }
      }
    }

    results[asset].funding = fundingMap[asset]
  }

  // ── Alertas de stop ───────────────────────────────────────────────────────
  await checkStopAlerts(db, openTrades ?? [])

  // ── Resumo Telegram ───────────────────────────────────────────────────────
  if (sendSummary || newSignals > 0) {
    const nowBR = new Date().toLocaleString('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    })
    await sendTelegram(fmtScanSummary(biases, fg, fundingMap, thresholds, newSignals, nowBR))
  }

  return NextResponse.json({ ok: true, scanned_at: new Date().toISOString(), fear_greed: fg, thresholds, results })
}

// ─── Detecção de sinal com pesos dinâmicos ────────────────────────────────────
function detectSignal(
  asset:    Asset,
  snaps:    Record<string, any>,
  fg:       { value: number; label: string } | null,
  minScore: number,
  weights:  Awaited<ReturnType<typeof loadWeights>>,
) {
  const d  = snaps['1d']
  const h4 = snaps['4h']
  const wk = snaps['1wk']
  if (!d || !h4) return null

  let bullScore = 0
  let bearScore = 0

  if (h4.wt_cross_up   && h4.wt_zone === 'oversold')    bullScore += weights.wt_cross_oversold
  if (h4.bos_up)                                          bullScore += weights.bos_up
  if (h4.price_vs_cloud === 'above')                      bullScore += weights.price_vs_cloud
  if (h4.tenkan_vs_kijun === 'above')                     bullScore += weights.tenkan_vs_kijun
  if (d.bias === 'ALTISTA')                               bullScore += weights.daily_bias
  if (wk?.bias === 'ALTISTA')                             bullScore += weights.weekly_bias

  if (h4.wt_cross_down && h4.wt_zone === 'overbought')   bearScore += weights.wt_cross_overbought
  if (h4.bos_down)                                        bearScore += weights.bos_down
  if (h4.price_vs_cloud === 'below')                      bearScore += weights.price_vs_cloud
  if (h4.tenkan_vs_kijun === 'below')                     bearScore += weights.tenkan_vs_kijun
  if (d.bias === 'BAIXISTA')                              bearScore += weights.daily_bias
  if (wk?.bias === 'BAIXISTA')                            bearScore += weights.weekly_bias

  if (fg) {
    if (fg.value >= 80) bullScore -= 1
    if (fg.value <= 20) bearScore -= 1
  }

  const isLong  = bullScore >= minScore
  const isShort = bearScore >= minScore
  if (!isLong && !isShort) return null

  const direction  = isLong ? 'long' : 'short'
  const close      = h4.close
  const swing_low  = h4.last_swing_low  ?? close * 0.97
  const swing_high = h4.last_swing_high ?? close * 1.03

  const stop    = isLong ? swing_low * 0.995 : swing_high * 1.005
  const target1 = isLong ? close * 1.05      : close * 0.95
  const rr1     = Math.abs(close - target1) / Math.abs(close - stop)

  if (rr1 < 2) return null

  const totalScore = isLong ? bullScore : bearScore
  const grade      = totalScore >= minScore + 2 ? 'A+' : totalScore >= minScore + 1 ? 'A' : 'B'
  const entryLow   = isLong ? close * 0.998 : close * 0.995
  const entryHigh  = isLong ? close * 1.002 : close * 1.005

  return {
    asset, direction, setup_grade: grade, macro_score: 0,
    entry_zone_low:  Math.round(entryLow  * 100) / 100,
    entry_zone_high: Math.round(entryHigh * 100) / 100,
    stop:    Math.round(stop    * 100) / 100,
    target1: Math.round(target1 * 100) / 100,
    target2: Math.round((isLong ? close * 1.10 : close * 0.90) * 100) / 100,
    target3: Math.round((isLong ? close * 1.15 : close * 0.85) * 100) / 100,
    rr1:     Math.round(rr1 * 10) / 10,
    trigger: isLong
      ? `Candle 4h fechando acima de $${entryHigh.toFixed(2)} com WT cruzado para cima`
      : `Candle 4h fechando abaixo de $${entryLow.toFixed(2)} com WT cruzado para baixo`,
    cancellation: isLong
      ? `Fechamento diário abaixo de $${(swing_low * 0.99).toFixed(2)}`
      : `Fechamento diário acima de $${(swing_high * 1.01).toFixed(2)}`,
    analysis: '', status: 'active',
  }
}

// ─── Alertas de stop ──────────────────────────────────────────────────────────
async function checkStopAlerts(db: ReturnType<typeof supabaseAdmin>, openTrades: any[]) {
  if (!openTrades.length) return

  const assets = [...new Set(openTrades.map((t: any) => t.asset))] as Asset[]
  const prices: Record<string, number> = {}
  await Promise.all(assets.map(a => fetchLivePrice(a).then(p => { prices[a] = p })))

  for (const trade of openTrades) {
    const price = prices[trade.asset]
    if (!price || !trade.stop_loss) continue
    const range   = Math.abs(trade.entry_price - trade.stop_loss)
    const toStop  = Math.abs(price - trade.stop_loss)
    const distPct = (toStop / range) * 100
    if (distPct <= 20) {
      await sendTelegram(fmtStopAlert(trade.asset, trade.direction, price, trade.stop_loss, distPct))
    }
  }
}
