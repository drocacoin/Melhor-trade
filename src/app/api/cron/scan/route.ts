import { NextRequest, NextResponse } from 'next/server'
import { fetchCandles, fetchFundingRate, fetchFearAndGreed, fetchLivePrice } from '@/lib/fetcher'
import { computeSnapshot, computeSignalFactors, SignalFactors } from '@/lib/indicators'
import { supabaseAdmin } from '@/lib/supabase'
import { sendTelegram, fmtSignal, fmtScanSummary } from '@/lib/telegram'
import { checkStopAlerts } from '@/lib/stop-monitor'
import { evaluateCircuitBreaker } from '@/lib/circuit-breaker'
import { computeThreshold } from '@/lib/threshold'
import { loadWeights } from '@/lib/weights'
import { generateSignalAnalysis } from '@/lib/signal-analysis'
import { fetchSetupHistory, checkCorrelation, suggestRisk, buildExitStrategy, buildConfluence } from '@/lib/signal-context'
import { AssetSentiment } from '@/lib/whales'
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
  const [fg, fundings, { data: perfRows }, { data: macroRow }, { data: openTrades }, { data: recentClosed }] = await Promise.all([
    fetchFearAndGreed(),
    Promise.all(ASSETS.map(a => fetchFundingRate(a).then(v => [a, v] as [string, number | null]))),
    db.from('performance_summary').select('*'),
    db.from('macro_readings').select('*').order('captured_at', { ascending: false }).limit(1),
    db.from('trades').select('*').eq('status', 'open'),
    db.from('trades').select('id,pnl_usd,closed_at').eq('status', 'closed').order('closed_at', { ascending: false }).limit(10),
  ])

  const fundingMap  = Object.fromEntries(fundings)
  const perfMap: Record<string, any>  = {}
  for (const p of perfRows ?? []) perfMap[p.asset] = p
  const latestMacro = macroRow?.[0] ?? null

  // ── Circuit breaker — pausa sinais em sequência de perdas ──────────────────
  const cb = evaluateCircuitBreaker(recentClosed ?? [])
  if (cb.triggered) console.warn('[scan] Circuit breaker ativo:', cb.reason)

  // Whale map vazio no scan — baleias são carregadas só no advisor (HL é instável)
  const whaleMap: Record<string, AssetSentiment> = {}

  // Thresholds dinâmicos
  const thresholds: Record<string, ReturnType<typeof computeThreshold>> = {}
  for (const asset of ASSETS) thresholds[asset] = computeThreshold(perfMap[asset])

  // ── Expirar sinais com mais de 3 dias sem ser acionados ──────────────────
  const expiryCutoff = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString()
  await db.from('signals')
    .update({ status: 'expired' })
    .eq('status', 'active')
    .lt('detected_at', expiryCutoff)

  // ── Scan — busca candles em batches de 5 ativos (4 TFs cada = 20 fetches/batch) ──
  const results: Record<string, any> = {}
  const biases:  Record<string, string> = {}
  let newSignals = 0

  type TfResult   = { tf: string; snap: any | null; factors: SignalFactors | null; err: string | null; count: number }
  type AssetResult = { asset: Asset; tfs: TfResult[] }

  async function scanAsset(asset: Asset): Promise<AssetResult> {
    const tfs = await Promise.all(
      TIMEFRAMES.map(async tf => {
        try {
          const candles = await fetchCandles(asset, tf)
          if (candles.length < 60) return { tf, snap: null, factors: null, err: `only ${candles.length} candles`, count: candles.length }
          const snap    = computeSnapshot(candles)
          const factors = computeSignalFactors(candles, snap)
          return { tf, snap, factors, err: null, count: candles.length }
        } catch (e: any) {
          console.error(`[scan] ${asset} ${tf}:`, e.message)
          return { tf, snap: null, factors: null, err: e.message, count: 0 }
        }
      })
    )
    return { asset, tfs }
  }

  // Processa em batches de 5 ativos para não sobrecarregar conexões
  const BATCH_SIZE = 5
  const assetResults: AssetResult[] = []
  for (let i = 0; i < ASSETS.length; i += BATCH_SIZE) {
    const batch = ASSETS.slice(i, i + BATCH_SIZE)
    const batchResults = await Promise.all(batch.map(scanAsset))
    assetResults.push(...batchResults)
  }

  // Fase 2: salvar snapshots no DB + detectar sinais (sequencial para não sobrecarregar DB)
  for (const { asset, tfs } of assetResults) {
    results[asset] = { threshold: thresholds[asset] }
    const snapshots: Record<string, any> = {}

    const factors4h: SignalFactors | null = tfs.find(t => t.tf === '4h')?.factors ?? null

    for (const { tf, snap, factors, err, count } of tfs) {
      if (snap) {
        snapshots[tf] = { ...snap, _factors: factors }  // fatores só em memória
        results[asset][tf] = {
          close: snap.close, bias: snap.bias,
          vol_ratio: factors ? +factors.volume_ratio.toFixed(2) : null,
          atr14:     factors ? +factors.atr14.toFixed(2)        : null,
        }
        // Persiste apenas campos do schema original (sem _factors)
        await db.from('snapshots').insert({ asset, timeframe: tf, ...snap })
      } else {
        results[asset][tf] = err ?? `only ${count} candles`
      }
    }

    if (snapshots['1d']?.bias) biases[asset] = snapshots['1d'].bias

    // ── Detectar sinal com pesos dinâmicos (skip se circuit breaker ativo) ──
    const { threshold } = thresholds[asset]
    const weights = await loadWeights(asset)
    const signal  = cb.triggered ? null : detectSignal(
      asset, snapshots, fg, threshold, weights, latestMacro, whaleMap,
      fundingMap[asset] ?? null,
      factors4h,
    )

    if (signal) {
      const whale = whaleMap[asset]
      const [history, exitStrategy, confluence] = await Promise.all([
        fetchSetupHistory(db, asset, signal.direction),
        Promise.resolve(buildExitStrategy(signal.rr1, signal.target1, signal.target2)),
        Promise.resolve(buildConfluence(snapshots, signal.direction as 'long' | 'short')),
      ])

      const correlation = checkCorrelation(asset, signal.direction, openTrades ?? [])
      const riskSuggest = suggestRisk(
        history?.winRate    ?? null,
        history?.avgWinPct  ?? null,
        history?.avgLossPct ?? null,
        signal.rr1
      )

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
  if (sendSummary || newSignals > 0 || cb.triggered) {
    const nowBR = new Date().toLocaleString('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    })
    await sendTelegram(fmtScanSummary(
      biases, fg, fundingMap, thresholds, newSignals, nowBR,
      cb.triggered ? { active: true, reason: cb.reason } : { active: false }
    ))
  }

  return NextResponse.json({
    ok:              true,
    scanned_at:      new Date().toISOString(),
    fear_greed:      fg,
    thresholds,
    results,
    circuit_breaker: cb.triggered ? { active: true, reason: cb.reason } : { active: false },
  })
}

// ─── Detecção de sinal v2 — scoring por força + funding + ATR ────────────────
function detectSignal(
  asset:    Asset,
  snaps:    Record<string, any>,
  fg:       { value: number; label: string } | null,
  minScore: number,
  weights:  Awaited<ReturnType<typeof loadWeights>>,
  macro:    any,
  whaleMap: Record<string, AssetSentiment> = {},
  funding:  number | null = null,
  f4h:      SignalFactors | null = null,    // fatores do 4h ao vivo
) {
  const d  = snaps['1d']
  const h4 = snaps['4h']
  const wk = snaps['1wk']
  if (!d || !h4) return null

  let bullScore = 0
  let bearScore = 0

  // ── WaveTrend por profundidade ─────────────────────────────────────────────
  // Oversold profundo (-75 a -100) → sinal de reversão muito mais confiável
  if (h4.wt_cross_up && h4.wt_zone === 'oversold') {
    const depth = f4h?.wt1_depth ?? Math.abs(h4.wt1 ?? 53)
    const pts   = depth > 75 ? 4 : depth > 60 ? weights.wt_cross_oversold : weights.wt_cross_oversold * 0.7
    bullScore += pts
  }
  if (h4.wt_cross_down && h4.wt_zone === 'overbought') {
    const depth = f4h?.wt1_depth ?? Math.abs(h4.wt1 ?? 53)
    const pts   = depth > 75 ? 4 : depth > 60 ? weights.wt_cross_overbought : weights.wt_cross_overbought * 0.7
    bearScore += pts
  }

  // ── Break of Structure com confirmação de volume ──────────────────────────
  // BOS sem volume = falso rompimento na maioria dos casos (50-70%)
  if (h4.bos_up) {
    const mult = f4h?.bos_volume_ok ? 1.25 : (f4h ? 0.5 : 1.0)  // sem dados → peso normal
    bullScore += weights.bos_up * mult
  }
  if (h4.bos_down) {
    const mult = f4h?.bos_volume_ok ? 1.25 : (f4h ? 0.5 : 1.0)
    bearScore += weights.bos_down * mult
  }

  // ── Ichimoku cloud ────────────────────────────────────────────────────────
  if (h4.price_vs_cloud === 'above')   bullScore += weights.price_vs_cloud
  if (h4.price_vs_cloud === 'below')   bearScore += weights.price_vs_cloud

  // ── Tenkan vs Kijun ───────────────────────────────────────────────────────
  if (h4.tenkan_vs_kijun === 'above')  bullScore += weights.tenkan_vs_kijun
  if (h4.tenkan_vs_kijun === 'below')  bearScore += weights.tenkan_vs_kijun

  // ── EMA 200 — fator de tendência de longo prazo (novo) ───────────────────
  if (h4.price_vs_ema === 'above')     bullScore += 0.5
  if (h4.price_vs_ema === 'below')     bearScore += 0.5
  if (d.price_vs_ema === 'above')      bullScore += 0.5
  if (d.price_vs_ema === 'below')      bearScore += 0.5

  // ── Bias diário e semanal ─────────────────────────────────────────────────
  if (d.bias === 'ALTISTA')            bullScore += weights.daily_bias
  if (d.bias === 'BAIXISTA')           bearScore += weights.daily_bias
  if (wk?.bias === 'ALTISTA')          bullScore += weights.weekly_bias
  if (wk?.bias === 'BAIXISTA')         bearScore += weights.weekly_bias

  // ── Ajuste macro ──────────────────────────────────────────────────────────
  if (macro?.macro_score != null) {
    const ms = macro.macro_score as number
    bullScore += ms * 0.5
    bearScore -= ms * 0.5
  }

  // ── Fear & Greed extremo ──────────────────────────────────────────────────
  if (fg) {
    if (fg.value >= 80) bullScore -= 1
    if (fg.value <= 20) bearScore -= 1
  }

  // ── Funding rate — penalidade de trades lotados (novo) ───────────────────
  // Valores típicos: 0.0001 = 0.01%/8h (neutro), 0.001 = 0.1%/8h (muito lotado)
  if (funding !== null) {
    if (funding > 0.0007)       { bullScore -= 2;    bearScore += 0.3 }   // longs muito lotados
    else if (funding > 0.0004)  { bullScore -= 1 }                         // longs lotados
    if (funding < -0.0005)      { bearScore -= 1.5;  bullScore += 0.3 }   // shorts lotados → squeeze
    else if (funding < -0.0002) { bearScore -= 0.5 }
  }

  // ── Baleias HyperLiquid ───────────────────────────────────────────────────
  const whale = whaleMap[asset]
  if (whale && whale.longCount + whale.shortCount >= 2) {
    if (whale.sentiment === 'bullish') {
      bullScore += 1.5
      if (whale.sentimentPct > 75) bullScore += 0.5
    } else if (whale.sentiment === 'bearish') {
      bearScore += 1.5
      if (whale.sentimentPct < 25) bearScore += 0.5
    }
  }

  const isLong  = bullScore >= minScore
  const isShort = bearScore >= minScore
  if (!isLong && !isShort) return null

  const direction  = isLong ? 'long' : 'short'
  const close      = h4.close

  // ── Stops e targets via ATR-14 (dinâmico por ativo) ──────────────────────
  // Substitui os % fixos (5%/10%/15%) que ignoravam volatilidade real
  const atr = f4h?.atr14 ?? close * 0.02   // fallback: 2% do preço
  const stop    = isLong ? close - 1.5 * atr : close + 1.5 * atr
  const target1 = isLong ? close + 3.0 * atr : close - 3.0 * atr   // RR 2:1
  const target2 = isLong ? close + 5.0 * atr : close - 5.0 * atr   // RR 3.33:1
  const target3 = isLong ? close + 8.0 * atr : close - 8.0 * atr   // RR 5.33:1
  const rr1     = 3.0 / 1.5  // = 2.0 sempre com ATR-based

  const totalScore = isLong ? bullScore : bearScore
  const grade      = totalScore >= minScore + 3 ? 'A+' : totalScore >= minScore + 1.5 ? 'A' : 'B'

  // Zona de entrada ±0.3% do preço atual (um pouco mais folgada que antes)
  const entryLow  = isLong ? close * 0.997 : close * 0.994
  const entryHigh = isLong ? close * 1.003 : close * 1.006

  // Stop de cancelamento baseado em swing + distância do cloud
  const swing_low  = h4.last_swing_low  ?? close - 2 * atr
  const swing_high = h4.last_swing_high ?? close + 2 * atr

  return {
    asset, direction, setup_grade: grade,
    macro_score: macro?.macro_score ?? 0,
    entry_zone_low:  Math.round(entryLow  * 100) / 100,
    entry_zone_high: Math.round(entryHigh * 100) / 100,
    stop:    Math.round(stop    * 100) / 100,
    target1: Math.round(target1 * 100) / 100,
    target2: Math.round(target2 * 100) / 100,
    target3: Math.round(target3 * 100) / 100,
    rr1,
    trigger: isLong
      ? `4h fecha acima de $${entryHigh.toFixed(2)} — WT cruzado com volume`
      : `4h fecha abaixo de $${entryLow.toFixed(2)} — WT cruzado com volume`,
    cancellation: isLong
      ? `Fechamento diário abaixo de $${(swing_low * 0.99).toFixed(2)} (swing low)`
      : `Fechamento diário acima de $${(swing_high * 1.01).toFixed(2)} (swing high)`,
    analysis: '', status: 'active',
  }
}

// checkStopAlerts movido para @/lib/stop-monitor — compartilhado com scan-fast

// evaluateCircuitBreaker movido para @/lib/circuit-breaker — compartilhado com webhook /status
