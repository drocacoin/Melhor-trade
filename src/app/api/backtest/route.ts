/**
 * GET /api/backtest
 *
 * Para cada trade fechado, busca os snapshots do dia de entrada,
 * recalcula o score com os pesos atuais e simula se o sistema
 * teria gerado o sinal. Compara: todos os trades × filtrado pelo sistema.
 */
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { loadWeights, ScoringWeights } from '@/lib/weights'
import { computeThreshold } from '@/lib/threshold'

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

export async function GET() {
  const db = supabaseAdmin()

  // ── 1. Carregar dados base em paralelo ─────────────────────────────────────
  const [{ data: trades }, { data: perfRows }] = await Promise.all([
    db.from('trades').select('*').eq('status', 'closed').order('opened_at', { ascending: true }),
    db.from('performance_summary').select('*'),
  ])

  if (!trades?.length) {
    return NextResponse.json({ trades: [], summary: null })
  }

  // Mapa de performance por ativo (para thresholds)
  const perfMap: Record<string, any> = {}
  for (const p of perfRows ?? []) perfMap[p.asset] = p

  // ── 2. Pré-carregar pesos por ativo único (evita N queries) ──────────────
  const uniqueAssets = [...new Set(trades.map(t => t.asset))]
  const weightsMap: Record<string, ScoringWeights> = {}
  await Promise.all(
    uniqueAssets.map(a => loadWeights(a).then(w => { weightsMap[a] = w }))
  )

  // ── 3. Para cada trade, buscar snapshots próximos à entrada ───────────────
  const results: any[] = []

  for (const trade of trades) {
    const entryDate = trade.opened_at?.slice(0, 10)
    if (!entryDate) continue

    // Janela de ±1 dia em torno da entrada
    const from = new Date(new Date(entryDate).getTime() - 36 * 3600 * 1000).toISOString()
    const to   = new Date(new Date(entryDate).getTime() + 36 * 3600 * 1000).toISOString()

    const { data: snapsRaw } = await db
      .from('snapshots')
      .select('timeframe, bias, wt_cross_up, wt_cross_down, wt_zone, bos_up, bos_down, price_vs_cloud, tenkan_vs_kijun')
      .eq('asset', trade.asset)
      .gte('captured_at', from)
      .lte('captured_at', to)
      .order('captured_at', { ascending: false })

    // Snapshot mais recente por timeframe dentro da janela
    const snapsMap: Record<string, any> = {}
    for (const s of snapsRaw ?? []) {
      if (!snapsMap[s.timeframe]) snapsMap[s.timeframe] = s
    }

    const hasSnaps   = Object.keys(snapsMap).length > 0
    const weights    = weightsMap[trade.asset]
    const threshold  = computeThreshold(perfMap[trade.asset]).threshold
    const { bullScore, bearScore } = scoreSnaps(snapsMap, weights)

    const isLong     = trade.direction === 'long'
    const score      = isLong ? bullScore : bearScore
    const wouldSignal = hasSnaps && score >= threshold

    const isWin = trade.pnl_usd != null ? trade.pnl_usd > 0 : (trade.pnl_pct ?? 0) > 0

    results.push({
      id:           trade.id,
      asset:        trade.asset,
      direction:    trade.direction,
      opened_at:    trade.opened_at?.slice(0, 10) ?? '',
      pnl_usd:      trade.pnl_usd ?? 0,
      pnl_pct:      trade.pnl_pct ?? null,
      is_win:       isWin,
      bull_score:   bullScore,
      bear_score:   bearScore,
      score:        Math.round(score * 10) / 10,
      threshold,
      would_signal: wouldSignal,
      has_snaps:    hasSnaps,
    })
  }

  // ── 4. Métricas de comparação ──────────────────────────────────────────────
  const all     = results
  const system  = results.filter(r => r.would_signal)
  const skipped = results.filter(r => !r.would_signal)

  const stats = (arr: typeof results) => {
    const wins    = arr.filter(r => r.is_win).length
    const total   = arr.length
    const pnl     = arr.reduce((s, r) => s + (r.pnl_usd ?? 0), 0)
    const avgWin  = arr.filter(r => r.is_win).reduce((s, r) => s + (r.pnl_usd ?? 0), 0) / (wins || 1)
    const avgLoss = arr.filter(r => !r.is_win).reduce((s, r) => s + (r.pnl_usd ?? 0), 0) / ((total - wins) || 1)
    return {
      total,
      wins,
      losses: total - wins,
      winrate: total ? Math.round((wins / total) * 1000) / 10 : 0,
      pnl:     Math.round(pnl * 100) / 100,
      avg_win: Math.round(avgWin * 100) / 100,
      avg_loss: Math.round(avgLoss * 100) / 100,
    }
  }

  // Equity curves (cumulative) para comparação visual
  let cumAll = 0; let cumSys = 0
  const equity: any[] = []
  for (const r of results) {
    cumAll += r.pnl_usd
    if (r.would_signal) cumSys += r.pnl_usd
    equity.push({
      label:  `#${r.id} ${r.asset}`,
      date:   r.opened_at,
      cumAll: Math.round(cumAll * 100) / 100,
      cumSys: Math.round(cumSys * 100) / 100,
    })
  }

  // Sem snapshots = não conseguiu simular
  const noSnapCount = results.filter(r => !r.has_snaps).length

  return NextResponse.json({
    trades:   results,
    equity,
    summary: {
      all:          stats(all),
      system:       stats(system),
      skipped:      stats(skipped),
      coverage:     all.length ? Math.round((system.length / all.length) * 1000) / 10 : 0,
      no_snaps:     noSnapCount,
      wr_delta:     Math.round((stats(system).winrate - stats(all).winrate) * 10) / 10,
      pnl_delta:    Math.round((stats(system).pnl - stats(all).pnl) * 100) / 100,
    },
  })
}
