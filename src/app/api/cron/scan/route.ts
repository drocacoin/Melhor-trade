import { NextRequest, NextResponse } from 'next/server'
import { fetchCandles, fetchFundingRate, fetchFearAndGreed, fetchLivePrice } from '@/lib/fetcher'
import { computeSnapshot } from '@/lib/indicators'
import { supabaseAdmin } from '@/lib/supabase'
import { sendTelegram, fmtSignal, fmtScanSummary, fmtStopAlert } from '@/lib/telegram'
import { computeThreshold } from '@/lib/threshold'
import { loadWeights } from '@/lib/weights'
import { generateSignalAnalysis } from '@/lib/signal-analysis'
import { fetchSetupHistory, checkCorrelation, suggestRisk, buildExitStrategy, buildConfluence } from '@/lib/signal-context'
import { fetchWhaleSentiment, AssetSentiment } from '@/lib/whales'
import { Asset } from '@/types'

export const maxDuration = 300  // Vercel Pro — até 5 min por execução

const ASSETS: Asset[] = ['BTC', 'ETH', 'SOL', 'HYPE', 'AAVE', 'LINK', 'AVAX', 'GOLD', 'OIL', 'SP500', 'MSTR', 'XRP', 'SUI', 'DOGE', 'TAO']
const TIMEFRAMES       = ['1wk', '1d', '4h', '1h']

export async function GET(req: NextRequest) {
  const bearer = req.headers.get('authorization')?.replace('Bearer ', '')
  const secret = bearer ?? req.headers.get('x-cron-secret') ?? req.nextUrl.searchParams.get('secret')
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const sendSummary = req.nextUrl.searchParams.get('send_summary') === 'true'

  const db = supabaseAdmin()

  // ── Contexto global ────────────────────────────────────────────────────────
  const [fg, fundings, { data: perfRows }, { data: macroRow }, { data: openTrades }, whaleData] = await Promise.all([
    fetchFearAndGreed(),
    Promise.all(ASSETS.map(a => fetchFundingRate(a).then(v => [a, v] as [string, number | null]))),
    db.from('performance_summary').select('*'),
    db.from('macro_readings').select('*').order('captured_at', { ascending: false }).limit(1),
    db.from('trades').select('*').eq('status', 'open'),
    fetchWhaleSentiment().catch(() => null),  // não bloqueia o scan se HL estiver fora
  ])

  const fundingMap  = Object.fromEntries(fundings)
  const perfMap: Record<string, any>  = {}
  for (const p of perfRows ?? []) perfMap[p.asset] = p
  const latestMacro = macroRow?.[0] ?? null

  // Mapa de sentimento das baleias por ativo
  const whaleMap: Record<string, AssetSentiment> = {}
  for (const s of whaleData?.sentiment ?? []) whaleMap[s.asset] = s

  // Thresholds dinâmicos
  const thresholds: Record<string, ReturnType<typeof computeThreshold>> = {}
  for (const asset of ASSETS) thresholds[asset] = computeThreshold(perfMap[asset])

  // ── Expirar sinais com mais de 3 dias sem ser acionados ──────────────────
  const expiryCutoff = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString()
  await db.from('signals')
    .update({ status: 'expired' })
    .eq('status', 'active')
    .lt('detected_at', expiryCutoff)

  // ── Scan — busca todos os timeframes de cada ativo em paralelo ───────────────
  const results: Record<string, any> = {}
  const biases:  Record<string, string> = {}
  let newSignals = 0

  // Fase 1: buscar candles de todos os ativos×timeframes em paralelo
  // (60 fetches simultâneos em vez de sequenciais — reduz de ~3min para ~15s)
  type TfResult = { tf: string; snap: any | null; err: string | null; count: number }
  type AssetResult = { asset: Asset; tfs: TfResult[] }

  const assetResults: AssetResult[] = await Promise.all(
    ASSETS.map(async asset => {
      const tfs = await Promise.all(
        TIMEFRAMES.map(async tf => {
          try {
            const candles = await fetchCandles(asset, tf)
            if (candles.length < 60) return { tf, snap: null, err: `only ${candles.length} candles`, count: candles.length }
            const snap = computeSnapshot(candles)
            return { tf, snap, err: null, count: candles.length }
          } catch (e: any) {
            console.error(`[scan] ${asset} ${tf}:`, e.message)
            return { tf, snap: null, err: e.message, count: 0 }
          }
        })
      )
      return { asset, tfs }
    })
  )

  // Fase 2: salvar snapshots no DB + detectar sinais (sequencial para não sobrecarregar DB)
  for (const { asset, tfs } of assetResults) {
    results[asset] = { threshold: thresholds[asset] }
    const snapshots: Record<string, any> = {}

    for (const { tf, snap, err, count } of tfs) {
      if (snap) {
        snapshots[tf] = snap
        results[asset][tf] = { close: snap.close, bias: snap.bias }
        await db.from('snapshots').insert({ asset, timeframe: tf, ...snap })
      } else {
        results[asset][tf] = err ?? `only ${count} candles`
      }
    }

    if (snapshots['1d']?.bias) biases[asset] = snapshots['1d'].bias

    // ── Detectar sinal com pesos dinâmicos ────────────────────────────────
    const { threshold } = thresholds[asset]
    const weights = await loadWeights(asset)
    const signal  = detectSignal(asset, snapshots, fg, threshold, weights, latestMacro, whaleMap)

    if (signal) {
      const whale = whaleMap[asset]
      const [history, exitStrategy, confluence] = await Promise.all([
        fetchSetupHistory(db, asset, signal.direction),
        Promise.resolve(buildExitStrategy(signal.rr1, signal.target1, signal.target2)),
        Promise.resolve(buildConfluence(snapshots, signal.direction as 'long' | 'short')),
      ])

      const correlation = checkCorrelation(asset, signal.direction, openTrades ?? [])
      const riskSuggest = suggestRisk(history?.winRate ?? null, signal.rr1)

      const enriched = {
        ...signal,
        history, exitStrategy, confluence, correlation, riskSuggest,
        whale_sentiment: whale?.sentiment ?? null,
        whale_pct:       whale?.sentimentPct ?? null,
        whale_count:     whale ? whale.longCount + whale.shortCount : 0,
      }

      const { data } = await db.from('signals').insert(signal).select().single()
      if (data) {
        newSignals++
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
  macro:    any,
  whaleMap: Record<string, AssetSentiment> = {},
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

  // ── Ajuste macro: risk-on favorece longs, risk-off favorece shorts ────────
  // macro_score vai de -2 a +2:
  //   +2 → bullScore +1, bearScore -1  (ambiente muito favorável para longs)
  //   -2 → bullScore -1, bearScore +1  (ambiente muito favorável para shorts)
  if (macro?.macro_score != null) {
    const ms = macro.macro_score as number
    bullScore += ms * 0.5
    bearScore -= ms * 0.5
  }

  // ── Fear & Greed extremo penaliza a direção da euforia/pânico ─────────────
  if (fg) {
    if (fg.value >= 80) bullScore -= 1
    if (fg.value <= 20) bearScore -= 1
  }

  // ── Sentimento das baleias (top traders HyperLiquid por consistência) ──────
  // Exige mínimo de 2 traders posicionados para ter relevância estatística.
  // Bullish: baleias majoritariamente long → reforça bull (+1.5, +0.5 se >75%)
  // Bearish: baleias majoritariamente short → reforça bear (+1.5, +0.5 se <25%)
  // Divergência implícita: se baleias vão na direção contrária ao sinal técnico,
  //   o boost vai para o lado delas, reduzindo a vantagem do sinal técnico.
  const whale = whaleMap[asset]
  if (whale && whale.longCount + whale.shortCount >= 2) {
    if (whale.sentiment === 'bullish') {
      bullScore += 1.5
      if (whale.sentimentPct > 75) bullScore += 0.5  // maioria esmagadora
    } else if (whale.sentiment === 'bearish') {
      bearScore += 1.5
      if (whale.sentimentPct < 25) bearScore += 0.5  // maioria esmagadora de shorts
    }
    // neutral: baleias divididas → sem ajuste
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
    asset, direction, setup_grade: grade,
    macro_score: macro?.macro_score ?? 0,
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

// ─── Alertas de stop e alvos ──────────────────────────────────────────────────
async function checkStopAlerts(db: ReturnType<typeof supabaseAdmin>, openTrades: any[]) {
  if (!openTrades.length) return

  const assets = [...new Set(openTrades.map((t: any) => t.asset))] as Asset[]
  const prices: Record<string, number> = {}
  await Promise.all(assets.map(a => fetchLivePrice(a).then(p => { prices[a] = p })))

  for (const trade of openTrades) {
    const price  = prices[trade.asset]
    const isLong = trade.direction === 'long'
    if (!price) continue

    // ── Alerta de stop próximo ──────────────────────────────────────────────
    const stop = trade.stop_price ?? trade.stop_loss
    if (stop) {
      const range    = Math.abs(trade.entry_price - stop)
      const toStop   = Math.abs(price - stop)
      const distPct  = range > 0 ? (toStop / range) * 100 : 100
      if (distPct <= 20) {
        await sendTelegram(fmtStopAlert(trade.asset, trade.direction, price, stop, distPct))
      }
    }

    // ── Alerta de alvo 1 atingido ───────────────────────────────────────────
    if (trade.target1 && !trade.alerted_target1) {
      const hit = isLong ? price >= trade.target1 : price <= trade.target1
      if (hit) {
        const pct = Math.abs((trade.target1 - trade.entry_price) / trade.entry_price * 100).toFixed(1)
        await sendTelegram(
          `🎯 <b>ALVO 1 ATINGIDO — ${trade.asset}</b>\n\n` +
          `Posição: <b>${trade.direction.toUpperCase()}</b>\n` +
          `Preço atual: <code>$${price.toFixed(2)}</code>\n` +
          `Alvo 1: <code>$${trade.target1}</code> (+${pct}%)\n\n` +
          `💡 Considere fechar 50% da posição e mover stop para entrada.`
        )
        // Marca para não alertar novamente neste trade
        await db.from('trades').update({ alerted_target1: true }).eq('id', trade.id)
      }
    }

    // ── Alerta de alvo 2 atingido ───────────────────────────────────────────
    if (trade.target2 && !trade.alerted_target2) {
      const hit = isLong ? price >= trade.target2 : price <= trade.target2
      if (hit) {
        const pct = Math.abs((trade.target2 - trade.entry_price) / trade.entry_price * 100).toFixed(1)
        await sendTelegram(
          `🎯🎯 <b>ALVO 2 ATINGIDO — ${trade.asset}</b>\n\n` +
          `Posição: <b>${trade.direction.toUpperCase()}</b>\n` +
          `Preço atual: <code>$${price.toFixed(2)}</code>\n` +
          `Alvo 2: <code>$${trade.target2}</code> (+${pct}%)\n\n` +
          `💡 Considere fechar mais 25% e deixar o restante correr com stop no alvo 1.`
        )
        await db.from('trades').update({ alerted_target2: true }).eq('id', trade.id)
      }
    }
  }
}
