/**
 * POST /api/advisor
 *
 * Coleta todo o contexto disponível (macro, scores, posições abertas,
 * fear & greed, sinais ativos, performance histórica, backtest) e
 * pede ao Claude Sonnet uma análise consolidada + recomendação clara.
 */
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { fetchFearAndGreed, fetchLivePrice } from '@/lib/fetcher'
import { computeLiveScore } from '@/lib/scoring'
import { computeThreshold } from '@/lib/threshold'
import { loadWeights, ScoringWeights } from '@/lib/weights'
import Anthropic from '@anthropic-ai/sdk'
import { Asset } from '@/types'

export const maxDuration = 60

const ASSETS: Asset[] = ['BTC', 'ETH', 'SOL', 'HYPE', 'AAVE', 'LINK', 'AVAX', 'GOLD', 'OIL', 'SP500', 'MSTR', 'XRP', 'SUI', 'DOGE', 'TAO']

// ── Reusa lógica de backtest scoring ─────────────────────────────────────────
function scoreSnaps(snaps: Record<string, any>, weights: ScoringWeights) {
  const d  = snaps['1d']
  const h4 = snaps['4h']
  const wk = snaps['1wk']
  if (!h4) return { bullScore: 0, bearScore: 0 }
  let bull = 0; let bear = 0
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

export async function POST() {
  const db = supabaseAdmin()

  // ── 1. Coletar contexto em paralelo ───────────────────────────────────────
  const [
    fg,
    { data: macroRow },
    { data: openTrades },
    { data: closedTrades },
    { data: activeSignals },
    { data: snapsAll },
    { data: perfRows },
    { data: monthlyJournal },
  ] = await Promise.all([
    fetchFearAndGreed(),
    db.from('macro_readings').select('*').order('captured_at', { ascending: false }).limit(1),
    db.from('trades').select('*').eq('status', 'open'),
    db.from('trades').select('*').eq('status', 'closed').order('closed_at', { ascending: false }).limit(30),
    db.from('signals').select('*').eq('status', 'active').order('detected_at', { ascending: false }).limit(10),
    db.from('snapshots').select('*').order('captured_at', { ascending: false }).limit(500),
    db.from('performance_summary').select('*'),
    db.from('monthly_journals').select('*').order('month', { ascending: false }).limit(1),
  ])

  const macro   = macroRow?.[0] ?? null
  const perfMap = Object.fromEntries((perfRows ?? []).map(p => [p.asset, p]))

  // ── 2. Scores atuais por ativo ────────────────────────────────────────────
  const seen = new Set<string>()
  const latestSnaps = (snapsAll ?? []).filter(s => {
    const k = `${s.asset}-${s.timeframe}`
    if (seen.has(k)) return false
    seen.add(k); return true
  })

  const scores = ASSETS.map(asset => {
    const byTf: Record<string, any> = Object.fromEntries(
      latestSnaps.filter(s => s.asset === asset).map(s => [s.timeframe, s])
    )
    const score = computeLiveScore(byTf, fg)
    const thr   = computeThreshold(perfMap[asset])
    return { asset, ...score, threshold: thr.threshold, gap: thr.threshold - score.topScore }
  }).sort((a, b) => a.gap - b.gap)   // mais próximos do sinal primeiro

  // ── 3. Preços ao vivo para posições abertas ───────────────────────────────
  const openAssets = [...new Set((openTrades ?? []).map(t => t.asset))] as Asset[]
  const prices: Record<string, number> = {}
  await Promise.all(openAssets.map(a => fetchLivePrice(a).then(p => { prices[a] = p })))

  // ── 4. Performance histórica resumida ─────────────────────────────────────
  const closed  = closedTrades ?? []
  const isWin   = (t: any) => t.pnl_usd != null ? t.pnl_usd > 0 : (t.pnl_pct ?? 0) > 0
  const wins    = closed.filter(isWin).length
  const winrate = closed.length ? (wins / closed.length) * 100 : 0
  const totalPnl = closed.reduce((s, t) => s + (t.pnl_usd ?? 0), 0)

  // ── 5. Montar contexto para o Sonnet ─────────────────────────────────────
  const macroText = macro
    ? `Regime: ${macro.regime.toUpperCase()} | Score: ${macro.macro_score >= 0 ? '+' : ''}${macro.macro_score}\n` +
      `DXY: ${macro.dxy_trend} | Yields: ${macro.yields_trend} | FED: ${macro.fed_stance}\n` +
      (macro.notes ? `Contexto: ${macro.notes.slice(0, 300)}` : '')
    : 'Sem leitura macro recente.'

  const fgText = fg ? `${fg.value}/100 — ${fg.label}` : 'indisponível'

  const scoresText = scores.slice(0, 8).map(s =>
    `${s.asset}: bull=${s.bullScore} bear=${s.bearScore} threshold=${s.threshold} ` +
    `(${s.gap <= 0 ? '🚨 SINAL' : `falta ${s.gap.toFixed(1)}pts`})`
  ).join('\n')

  const openText = (openTrades ?? []).length
    ? (openTrades ?? []).map(t => {
        const price  = prices[t.asset]
        const isLong = t.direction === 'long'
        const pnlPct = price && t.entry_price
          ? ((isLong ? price - t.entry_price : t.entry_price - price) / t.entry_price * 100 * (t.leverage ?? 1)).toFixed(1)
          : null
        return `${t.asset} ${t.direction.toUpperCase()} ${t.leverage ?? 1}x | entrada $${t.entry_price} | atual $${price?.toFixed(2) ?? '?'} | P&L ${pnlPct ? pnlPct + '%' : '?'} | stop $${t.stop_price ?? '?'} | alvo1 $${t.target1 ?? '?'}`
      }).join('\n')
    : 'Nenhuma posição aberta.'

  const signalsText = (activeSignals ?? []).length
    ? (activeSignals ?? []).map(s =>
        `${s.asset} ${s.direction.toUpperCase()} [${s.setup_grade}] | entrada $${s.entry_zone_low}–$${s.entry_zone_high} | stop $${s.stop} | alvo1 $${s.target1} | RR ${s.rr1}`
      ).join('\n')
    : 'Sem sinais ativos.'

  const perfText =
    `Últimos ${closed.length} trades: WR ${winrate.toFixed(1)}% (${wins}W/${closed.length - wins}L) | P&L total $${totalPnl.toFixed(2)}\n` +
    (monthlyJournal?.[0] ? `Mês ${monthlyJournal[0].month}: WR ${monthlyJournal[0].winrate}% P&L $${monthlyJournal[0].total_pnl}` : '')

  const prompt =
    `Você é um analista sênior de swing trade quantitativo. Analise todos os dados abaixo e tome as melhores decisões possíveis para o trader.\n\n` +
    `━━ MACRO ━━\n${macroText}\n\n` +
    `━━ FEAR & GREED ━━\n${fgText}\n\n` +
    `━━ SCORES TÉCNICOS (top 8) ━━\n${scoresText}\n\n` +
    `━━ POSIÇÕES ABERTAS ━━\n${openText}\n\n` +
    `━━ SINAIS ATIVOS ━━\n${signalsText}\n\n` +
    `━━ PERFORMANCE ━━\n${perfText}\n\n` +
    `━━ INSTRUÇÕES ━━\n` +
    `Seja direto e específico. Priorize o que o trader deve FAZER AGORA.\n` +
    `Considere: correlação entre posições, risco total, regime macro, qualidade dos setups.\n\n` +
    `Responda APENAS em JSON válido:\n` +
    `{\n` +
    `  "overall": "favorável" | "neutro" | "desfavorável",\n` +
    `  "market_view": "análise do ambiente atual em 2-3 frases",\n` +
    `  "opportunities": [\n` +
    `    { "asset": "X", "direction": "long"|"short", "urgency": "alta"|"média"|"baixa", "score": 0.0, "rationale": "por que este setup agora" }\n` +
    `  ],\n` +
    `  "open_positions": [\n` +
    `    { "asset": "X", "action": "manter"|"fechar"|"mover_stop"|"parcial", "reason": "justificativa" }\n` +
    `  ],\n` +
    `  "risks": ["risco 1", "risco 2", "risco 3"],\n` +
    `  "recommendation": "o que fazer agora em 2-3 frases claras e objetivas"\n` +
    `}`

  // ── 6. Chamar Claude Sonnet ────────────────────────────────────────────────
  const client = new Anthropic()
  const resp = await client.messages.create({
    model:      'claude-sonnet-4-5',
    max_tokens: 1200,
    messages:   [{ role: 'user', content: prompt }],
  })

  const raw  = (resp.content[0] as any).text ?? ''
  const json = raw.match(/\{[\s\S]*\}/)
  if (!json) {
    return NextResponse.json({ error: 'Resposta inválida da IA', raw }, { status: 500 })
  }

  let analysis: any
  try {
    analysis = JSON.parse(json[0])
  } catch {
    return NextResponse.json({ error: 'JSON inválido', raw }, { status: 500 })
  }

  // ── 7. Retornar análise + contexto usado ─────────────────────────────────
  return NextResponse.json({
    analysis,
    context: {
      macro:       macro ? { regime: macro.regime, score: macro.macro_score } : null,
      fear_greed:  fg,
      top_scores:  scores.slice(0, 5).map(s => ({ asset: s.asset, bull: s.bullScore, bear: s.bearScore, gap: s.gap })),
      open_count:  (openTrades ?? []).length,
      signals:     (activeSignals ?? []).length,
      winrate,
      total_pnl:   totalPnl,
    },
    generated_at: new Date().toISOString(),
  })
}
