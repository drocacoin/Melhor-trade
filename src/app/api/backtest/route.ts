/**
 * GET /api/backtest
 *
 * Dois modos de análise:
 *
 * ?mode=signals (padrão) — Walk-forward nos sinais do banco:
 *   Para cada sinal gerado, baixa candles 4h e simula se stop ou target1
 *   foi atingido primeiro. Agrega por grade, ativo e confidence_pct.
 *   Responde: "sinais A+ realmente ganham mais que B?"
 *
 * ?mode=trades — Retrospectiva nos trades executados:
 *   Para cada trade fechado, recalcula o score da entrada e verifica
 *   se o sistema teria gerado o sinal. Compara WR "todos" vs "aprovados".
 *   Responde: "o score filtra losers?"
 *
 * Parâmetros comuns:
 *   ?days=90      janela (padrão 90, máx 180)
 *   ?asset=BTC    filtrar ativo (opcional)
 *   ?secret=XXX   autenticação
 */
import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { loadWeights, ScoringWeights } from '@/lib/weights'
import { computeThreshold } from '@/lib/threshold'

export const maxDuration = 120

// ── Replica a lógica de detectSignal sem efeitos colaterais ─────────────────
function scoreSnaps(
  snaps: Record<string, any>,
  weights: ScoringWeights,
): { bullScore: number; bearScore: number } {
  const d  = snaps['1d']
  const h4 = snaps['4h']
  const wk = snaps['1wk']
  if (!h4) return { bullScore: 0, bearScore: 0 }

  let bull = 0
  let bear = 0

  if (h4.wt_cross_up   && h4.wt_zone === 'oversold')   bull += weights.wt_cross_oversold
  if (h4.bos_up)                                         bull += weights.bos_up
  if (h4.price_vs_cloud === 'above')                     bull += weights.price_vs_cloud
  if (h4.tenkan_vs_kijun === 'above')                    bull += weights.tenkan_vs_kijun
  if (d?.bias === 'ALTISTA')                             bull += weights.daily_bias
  if (wk?.bias === 'ALTISTA')                            bull += weights.weekly_bias

  if (h4.wt_cross_down && h4.wt_zone === 'overbought')  bear += weights.wt_cross_overbought
  if (h4.bos_down)                                       bear += weights.bos_down
  if (h4.price_vs_cloud === 'below')                     bear += weights.price_vs_cloud
  if (h4.tenkan_vs_kijun === 'below')                    bear += weights.tenkan_vs_kijun
  if (d?.bias === 'BAIXISTA')                            bear += weights.daily_bias
  if (wk?.bias === 'BAIXISTA')                           bear += weights.weekly_bias

  return { bullScore: Math.round(bull * 10) / 10, bearScore: Math.round(bear * 10) / 10 }
}

// ─── Símbolos HyperLiquid (candles 24/7 contínuos) ───────────────────────────
const HL_SYMBOL: Record<string, string> = {
  BTC: 'BTC', ETH: 'ETH', SOL: 'SOL', HYPE: 'HYPE',
  AAVE: 'AAVE', LINK: 'LINK', AVAX: 'AVAX',
  XRP: 'XRP', SUI: 'SUI', DOGE: 'DOGE', TAO: 'TAO',
}

interface Candle { time: number; high: number; low: number }

async function fetchCandles4h(asset: string, days: number): Promise<Candle[]> {
  const coin = HL_SYMBOL[asset]
  if (!coin) return []
  const now       = Date.now()
  const startTime = now - (days + 5) * 24 * 3600 * 1000
  try {
    const res  = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'candleSnapshot', req: { coin, interval: '4h', startTime, endTime: now } }),
    })
    const json: any[] = await res.json()
    if (!Array.isArray(json)) return []
    return json.map(r => ({ time: Number(r.t), high: parseFloat(r.h), low: parseFloat(r.l) }))
  } catch { return [] }
}

type Outcome = 'win' | 'loss' | 'open'

function aggStats(rows: { outcome: Outcome; pnl_pct: number | null }[]) {
  const decided = rows.filter(r => r.outcome !== 'open')
  const wins    = decided.filter(r => r.outcome === 'win')
  const losses  = decided.filter(r => r.outcome === 'loss')
  const wr      = decided.length ? wins.length / decided.length * 100 : null
  const avgWin  = wins.length    ? wins.reduce((s, r) => s + (r.pnl_pct ?? 0), 0) / wins.length  : 0
  const avgLoss = losses.length  ? losses.reduce((s, r) => s + (r.pnl_pct ?? 0), 0) / losses.length : 0
  const grossW  = wins.reduce((s, r) => s + (r.pnl_pct ?? 0), 0)
  const grossL  = Math.abs(losses.reduce((s, r) => s + (r.pnl_pct ?? 0), 0))
  const pf      = grossL > 0 ? grossW / grossL : null
  const exp     = wr !== null ? +((wr / 100) * avgWin + (1 - wr / 100) * avgLoss).toFixed(2) : null
  return {
    n: rows.length, decided: decided.length,
    wins: wins.length, losses: losses.length, open: rows.length - decided.length,
    winrate:       wr  !== null ? +wr.toFixed(1)       : null,
    avg_win_pct:   wins.length   ? +avgWin.toFixed(2)  : null,
    avg_loss_pct:  losses.length ? +avgLoss.toFixed(2) : null,
    profit_factor: pf  !== null  ? +pf.toFixed(2)      : null,
    expectancy:    exp,  // E[P&L por trade em %], positivo = sistema tem edge
  }
}

// ════════════════════════════════════════════════════════════════════════════
// MODO signals — walk-forward nos sinais do banco
// ════════════════════════════════════════════════════════════════════════════
async function runSignalsMode(db: ReturnType<typeof supabaseAdmin>, days: number, assetFilter: string | null) {
  const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString()
  let q = db.from('signals')
    .select('id,asset,direction,setup_grade,confidence_pct,detected_at,entry_zone_low,entry_zone_high,stop,target1,rr1')
    .gte('detected_at', cutoff)
    .order('detected_at', { ascending: true })
  if (assetFilter) q = q.eq('asset', assetFilter)

  const { data: signals, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  const hlSigs = (signals ?? []).filter(s => HL_SYMBOL[s.asset])
  if (!hlSigs.length) return NextResponse.json({ ok: true, mode: 'signals', message: 'Sem sinais HL no período', days })

  // Candles por ativo (1 request por ativo)
  const assets = [...new Set(hlSigs.map(s => s.asset))]
  const cc: Record<string, Candle[]> = {}
  await Promise.allSettled(assets.map(async a => { cc[a] = await fetchCandles4h(a, days) }))

  // Walk-forward
  const MAX = 18  // 18 × 4h = 72h = 3 dias
  const results = hlSigs.map(s => {
    const isLong  = s.direction === 'long'
    const entry   = isLong ? (s.entry_zone_high ?? s.entry_zone_low) : (s.entry_zone_low ?? s.entry_zone_high)
    const stop    = s.stop;  const t1 = s.target1
    if (!entry || !stop || !t1) return { ...s, outcome: 'open' as Outcome, hold: 0, pnl_pct: null }

    const candles  = cc[s.asset] ?? []
    const detMs    = new Date(s.detected_at).getTime()
    const startIdx = candles.findIndex(c => c.time > detMs)
    if (startIdx === -1) return { ...s, outcome: 'open' as Outcome, hold: 0, pnl_pct: null }

    let outcome: Outcome = 'open'; let hold = 0; let pnl_pct: number | null = null
    for (const c of candles.slice(startIdx, startIdx + MAX)) {
      hold++
      if (isLong) {
        if (c.low  <= stop) { outcome = 'loss'; pnl_pct = +((stop - entry) / entry * 100).toFixed(2); break }
        if (c.high >= t1)   { outcome = 'win';  pnl_pct = +((t1  - entry) / entry * 100).toFixed(2); break }
      } else {
        if (c.high >= stop) { outcome = 'loss'; pnl_pct = +((entry - stop) / entry * 100).toFixed(2); break }
        if (c.low  <= t1)   { outcome = 'win';  pnl_pct = +((entry - t1)  / entry * 100).toFixed(2); break }
      }
    }
    return { ...s, outcome, hold, pnl_pct }
  })

  const summary = aggStats(results)

  // Por grade
  const byGrade: Record<string, ReturnType<typeof aggStats>> = {}
  for (const g of ['A+', 'A', 'B']) {
    const sub = results.filter(r => (r.setup_grade) === g)
    if (sub.length) byGrade[g] = aggStats(sub)
  }

  // Por ativo
  const byAsset: Record<string, ReturnType<typeof aggStats>> = {}
  for (const a of assets) {
    const sub = results.filter(r => r.asset === a)
    if (sub.length) byAsset[a] = aggStats(sub)
  }

  // Calibração de confidence_pct
  const buckets = [
    { label: '<55%',   min: 0, max: 55 }, { label: '55-65%', min: 55, max: 65 },
    { label: '65-75%', min: 65, max: 75 }, { label: '75-85%', min: 75, max: 85 },
    { label: '85%+',   min: 85, max: 100 },
  ]
  const calibration = buckets.map(b => {
    const sub = results.filter(r => r.confidence_pct != null && r.confidence_pct >= b.min && r.confidence_pct < b.max)
    if (!sub.length) return null
    const s = aggStats(sub)
    return { bucket: b.label, n: s.n, winrate: s.winrate, avg_pnl: s.expectancy }
  }).filter(Boolean) as any[]

  // Calibrado = winrate cresce conforme confiança aumenta
  const calOk = calibration.filter(c => c.n >= 3).length >= 2
    ? calibration.filter(c => c.n >= 3).every((c, i, a) => i === 0 || (c.winrate ?? 0) >= (a[i-1].winrate ?? 0))
    : null

  return NextResponse.json({
    ok: true, mode: 'signals', period_days: days,
    signals_total: hlSigs.length, assets_covered: assets,
    summary,
    by_grade: byGrade, by_asset: byAsset,
    by_direction: {
      long:  aggStats(results.filter(r => r.direction === 'long')),
      short: aggStats(results.filter(r => r.direction === 'short')),
    },
    calibration, calibration_ok: calOk,
    signals_detail: results,
    generated_at: new Date().toISOString(),
  })
}

// ════════════════════════════════════════════════════════════════════════════
// MODO trades — retrospectiva nos trades executados (código original melhorado)
// ════════════════════════════════════════════════════════════════════════════
async function runTradesMode(db: ReturnType<typeof supabaseAdmin>, days: number, assetFilter: string | null) {
  const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString()
  let q = db.from('trades').select('*').eq('status', 'closed').gte('opened_at', cutoff).order('opened_at', { ascending: true })
  if (assetFilter) q = q.eq('asset', assetFilter)
  const [{ data: trades }, { data: perfRows }] = await Promise.all([q, db.from('performance_summary').select('*')])

  if (!trades?.length) return NextResponse.json({ ok: true, mode: 'trades', message: 'Sem trades no período' })

  const perfMap: Record<string, any> = {}
  for (const p of perfRows ?? []) perfMap[p.asset] = p

  const uniqueAssets = [...new Set(trades.map((t: any) => t.asset))]
  const weightsMap: Record<string, ScoringWeights> = {}
  await Promise.all(uniqueAssets.map(a => loadWeights(a).then(w => { weightsMap[a] = w })))

  const results: any[] = []
  for (const trade of trades) {
    const entryDate = trade.opened_at?.slice(0, 10)
    if (!entryDate) continue

    const from = new Date(new Date(entryDate).getTime() - 36 * 3600 * 1000).toISOString()
    const to   = new Date(new Date(entryDate).getTime() + 36 * 3600 * 1000).toISOString()

    const { data: snapsRaw } = await db.from('snapshots')
      .select('timeframe, bias, wt_cross_up, wt_cross_down, wt_zone, bos_up, bos_down, price_vs_cloud, tenkan_vs_kijun')
      .eq('asset', trade.asset).gte('captured_at', from).lte('captured_at', to)
      .order('captured_at', { ascending: false })

    const snapsMap: Record<string, any> = {}
    for (const s of snapsRaw ?? []) { if (!snapsMap[s.timeframe]) snapsMap[s.timeframe] = s }

    const hasSnaps  = Object.keys(snapsMap).length > 0
    const weights   = weightsMap[trade.asset]
    const threshold = computeThreshold(perfMap[trade.asset]).threshold
    const { bullScore, bearScore } = scoreSnaps(snapsMap, weights)
    const isLong   = trade.direction === 'long'
    const score    = isLong ? bullScore : bearScore
    const isWin    = trade.pnl_usd != null ? trade.pnl_usd > 0 : (trade.pnl_pct ?? 0) > 0

    results.push({
      id: trade.id, asset: trade.asset, direction: trade.direction,
      opened_at: trade.opened_at?.slice(0, 10), pnl_usd: trade.pnl_usd ?? 0,
      pnl_pct: trade.pnl_pct ?? null, is_win: isWin,
      bull_score: bullScore, bear_score: bearScore,
      score: Math.round(score * 10) / 10, threshold,
      would_signal: hasSnaps && score >= threshold, has_snaps: hasSnaps,
    })
  }

  const legacyStats = (arr: typeof results) => {
    const wins = arr.filter(r => r.is_win).length
    const pnl  = arr.reduce((s: number, r: any) => s + r.pnl_usd, 0)
    return {
      total: arr.length, wins, losses: arr.length - wins,
      winrate: arr.length ? Math.round(wins / arr.length * 1000) / 10 : 0,
      pnl: Math.round(pnl * 100) / 100,
    }
  }

  const system  = results.filter(r => r.would_signal)
  const skipped = results.filter(r => !r.would_signal)
  let cumAll = 0; let cumSys = 0
  const equity = results.map(r => {
    cumAll += r.pnl_usd
    if (r.would_signal) cumSys += r.pnl_usd
    return { label: `#${r.id} ${r.asset}`, date: r.opened_at, cumAll: +cumAll.toFixed(2), cumSys: +cumSys.toFixed(2) }
  })

  return NextResponse.json({
    ok: true, mode: 'trades', period_days: days,
    trades: results, equity,
    summary: {
      all: legacyStats(results), system: legacyStats(system), skipped: legacyStats(skipped),
      coverage: results.length ? Math.round(system.length / results.length * 1000) / 10 : 0,
      no_snaps: results.filter(r => !r.has_snaps).length,
      wr_delta: Math.round((legacyStats(system).winrate - legacyStats(results).winrate) * 10) / 10,
    },
    generated_at: new Date().toISOString(),
  })
}

// ════════════════════════════════════════════════════════════════════════════
// Handler principal
// ════════════════════════════════════════════════════════════════════════════
export async function GET(req: NextRequest) {
  const secret = req.headers.get('authorization')?.replace('Bearer ', '') ?? req.nextUrl.searchParams.get('secret')
  if (secret !== process.env.CRON_SECRET) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const days        = Math.min(180, parseInt(req.nextUrl.searchParams.get('days') ?? '90'))
  const mode        = req.nextUrl.searchParams.get('mode') ?? 'signals'
  const assetFilter = req.nextUrl.searchParams.get('asset') ?? null
  const db          = supabaseAdmin()

  if (mode === 'trades') return runTradesMode(db, days, assetFilter)
  return runSignalsMode(db, days, assetFilter)
}

