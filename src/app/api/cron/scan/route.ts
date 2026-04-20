import { NextRequest, NextResponse } from 'next/server'
import { fetchCandles, fetchFundingRate, fetchFearAndGreed, fetchLivePrice } from '@/lib/fetcher'
import { computeSnapshot } from '@/lib/indicators'
import { supabaseAdmin } from '@/lib/supabase'
import { sendTelegram, fmtSignal, fmtScanSummary, fmtStopAlert } from '@/lib/telegram'
import { computeThreshold } from '@/lib/threshold'
import { generateSignalAnalysis } from '@/lib/signal-analysis'
import { Asset } from '@/types'

const ASSETS: Asset[] = ['BTC', 'ETH', 'SOL', 'GOLD', 'OIL']
const TIMEFRAMES      = ['1wk', '1d', '4h', '1h']

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export async function GET(req: NextRequest) {
  const secret = req.headers.get('x-cron-secret') ?? req.nextUrl.searchParams.get('secret')
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const sendSummary = req.nextUrl.searchParams.get('send_summary') === 'true'

  const db = supabaseAdmin()

  // ── Fetch contexto global em paralelo ─────────────────────────────────────
  const [fg, fundings, { data: perfRows }, { data: macroRow }] = await Promise.all([
    fetchFearAndGreed(),
    Promise.all(ASSETS.map(a => fetchFundingRate(a).then(v => [a, v] as [string, number | null]))),
    db.from('performance_summary').select('*'),
    db.from('macro_readings').select('*').order('captured_at', { ascending: false }).limit(1),
  ])
  const latestMacro = macroRow?.[0] ?? null

  const fundingMap = Object.fromEntries(fundings)

  // Mapa de performance por ativo
  const perfMap: Record<string, any> = {}
  for (const p of perfRows ?? []) perfMap[p.asset] = p

  // Thresholds dinâmicos por ativo
  const thresholds: Record<string, { threshold: number; reason: string }> = {}
  for (const asset of ASSETS) thresholds[asset] = computeThreshold(perfMap[asset])

  // ── Scan cada ativo × timeframe ────────────────────────────────────────────
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
      await sleep(500)
    }

    if (snapshots['1d']?.bias) biases[asset] = snapshots['1d'].bias

    // ── Detecção de sinal com threshold dinâmico ──────────────────────────
    const { threshold } = thresholds[asset]
    const signal = detectSignal(asset, snapshots, fg, threshold)
    if (signal) {
      const { data } = await db.from('signals').insert(signal).select().single()
      if (data) {
        newSignals++

        // Auto-análise Haiku (rápida) — enviada direto no Telegram
        let analysis = ''
        try {
          analysis = await generateSignalAnalysis(data, snapshots, latestMacro, fg, 'haiku')
          await db.from('signals').update({ analysis }).eq('id', data.id)
        } catch (e: any) {
          console.error(`[scan] análise falhou para ${asset}:`, e.message)
        }

        await sendTelegram(fmtSignal({ ...data, analysis }, fg, fundingMap[asset] ?? null))
        results[asset].signal = { ...data, analysis }
      }
    }

    results[asset].funding = fundingMap[asset]
  }

  // ── Alertas de stop para trades abertos ───────────────────────────────────
  await checkStopAlerts(db)

  // ── Resumo Telegram ────────────────────────────────────────────────────────
  if (sendSummary || newSignals > 0) {
    const nowBR = new Date().toLocaleString('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    })
    await sendTelegram(fmtScanSummary(biases, fg, fundingMap, thresholds, newSignals, nowBR))
  }

  return NextResponse.json({
    ok: true,
    scanned_at: new Date().toISOString(),
    fear_greed:  fg,
    thresholds,
    results,
  })
}

// ─── Detecção de sinal ────────────────────────────────────────────────────────
function detectSignal(
  asset: Asset,
  snaps: Record<string, any>,
  fg:    { value: number; label: string } | null,
  minScore: number,                                // threshold dinâmico
) {
  const d  = snaps['1d']
  const h4 = snaps['4h']
  const wk = snaps['1wk']
  if (!d || !h4) return null

  let bullScore = 0
  let bearScore = 0

  // ── Sinais 4h (núcleo) ─────────────────────────────────────────────────
  if (h4.wt_cross_up   && h4.wt_zone === 'oversold')    bullScore += 3
  if (h4.bos_up)                                          bullScore += 2
  if (h4.price_vs_cloud === 'above')                      bullScore += 1
  if (h4.tenkan_vs_kijun === 'above')                     bullScore += 1

  if (h4.wt_cross_down && h4.wt_zone === 'overbought')   bearScore += 3
  if (h4.bos_down)                                        bearScore += 2
  if (h4.price_vs_cloud === 'below')                      bearScore += 1
  if (h4.tenkan_vs_kijun === 'below')                     bearScore += 1

  // ── Sinais diários (+2) ────────────────────────────────────────────────
  if (d.bias === 'ALTISTA')  bullScore += 2
  if (d.bias === 'BAIXISTA') bearScore += 2

  // ── Confluência semanal (+1 bônus) ────────────────────────────────────
  if (wk) {
    if (wk.bias === 'ALTISTA')  bullScore += 1
    if (wk.bias === 'BAIXISTA') bearScore += 1
  }

  // ── Fear & Greed filter ────────────────────────────────────────────────
  if (fg) {
    if (fg.value >= 80) bullScore -= 1  // euforia: cautela com longs
    if (fg.value <= 20) bearScore -= 1  // pânico: cautela com shorts
  }

  const isLong  = bullScore >= minScore
  const isShort = bearScore >= minScore
  if (!isLong && !isShort) return null

  const direction  = isLong ? 'long' : 'short'
  const close      = h4.close
  const swing_low  = h4.last_swing_low  ?? close * 0.97
  const swing_high = h4.last_swing_high ?? close * 1.03

  const stop    = isLong  ? swing_low  * 0.995 : swing_high * 1.005
  const target1 = isLong  ? close * 1.05       : close * 0.95
  const rr1     = Math.abs(close - target1) / Math.abs(close - stop)

  if (rr1 < 2) return null

  const totalScore = isLong ? bullScore : bearScore
  // Com threshold dinâmico o grade sobe junto
  const grade = totalScore >= minScore + 2 ? 'A+' : totalScore >= minScore + 1 ? 'A' : 'B'

  const entryLow  = isLong ? close * 0.998 : close * 0.995
  const entryHigh = isLong ? close * 1.002 : close * 1.005

  return {
    asset,
    direction,
    setup_grade: grade,
    macro_score: 0,
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
    analysis: '',
    status: 'active',
  }
}

// ─── Alertas de stop ──────────────────────────────────────────────────────────
async function checkStopAlerts(db: ReturnType<typeof supabaseAdmin>) {
  const { data: trades } = await db.from('trades').select('*').eq('status', 'open')
  if (!trades?.length) return

  const assets = [...new Set(trades.map((t: any) => t.asset))] as Asset[]
  const prices: Record<string, number> = {}
  await Promise.all(assets.map(a => fetchLivePrice(a).then(p => { prices[a] = p })))

  for (const trade of trades) {
    const price = prices[trade.asset]
    if (!price || !trade.stop_loss) continue

    const range   = Math.abs(trade.entry_price - trade.stop_loss)
    const toStop  = Math.abs(price - trade.stop_loss)
    const distPct = (toStop / range) * 100

    if (distPct <= 20) {
      await sendTelegram(
        fmtStopAlert(trade.asset, trade.direction, price, trade.stop_loss, distPct)
      )
    }
  }
}
