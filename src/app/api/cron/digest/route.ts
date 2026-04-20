import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { supabaseAdmin } from '@/lib/supabase'
import { sendTelegram } from '@/lib/telegram'

export async function GET(req: NextRequest) {
  const secret = req.headers.get('x-cron-secret') ?? req.nextUrl.searchParams.get('secret')
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return NextResponse.json({ error: 'No API key' }, { status: 500 })

  const db = supabaseAdmin()

  // ── Últimos 7 dias ─────────────────────────────────────────────────────────
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

  const [{ data: trades }, { data: reviews }, { data: signals }] = await Promise.all([
    db.from('trades').select('*').eq('status', 'closed').gte('closed_at', since).order('closed_at', { ascending: false }),
    db.from('trade_reviews').select('*').gte('reviewed_at', since),
    db.from('signals').select('*').gte('detected_at', since).order('detected_at', { ascending: false }),
  ])

  const closedTrades = trades ?? []
  const weekReviews  = reviews ?? []
  const weekSignals  = signals ?? []

  // ── Sem trades na semana ───────────────────────────────────────────────────
  if (closedTrades.length === 0 && weekSignals.length === 0) {
    await sendTelegram(
      `📅 <b>Digest Semanal</b>\n\nNenhum trade fechado e nenhum sinal esta semana.\n\n` +
      `Continue monitorando — o mercado oferecerá oportunidades.`
    )
    return NextResponse.json({ ok: true, message: 'no data' })
  }

  // ── Montar contexto para o Haiku ──────────────────────────────────────────
  const winners  = closedTrades.filter(t => (t.pnl_usd ?? 0) > 0)
  const losers   = closedTrades.filter(t => (t.pnl_usd ?? 0) <= 0)
  const totalPnl = closedTrades.reduce((s: number, t: any) => s + (t.pnl_usd ?? 0), 0)
  const winRate  = closedTrades.length > 0 ? (winners.length / closedTrades.length) * 100 : 0

  // Erros da semana
  const errorMap: Record<string, number> = {}
  for (const r of weekReviews) {
    if (r.error_category) errorMap[r.error_category] = (errorMap[r.error_category] ?? 0) + 1
  }
  const topErrors = Object.entries(errorMap).sort(([, a], [, b]) => b - a).slice(0, 3)

  // Scores médios da semana
  const scoreFields = ['score_estrutura','score_timing','score_indicadores','score_risco','score_execucao','score_disciplina'] as const
  const scoreTotals: Record<string, number> = {}
  let reviewsWithScores = 0
  for (const r of weekReviews) {
    if (r.score_estrutura == null) continue
    reviewsWithScores++
    for (const f of scoreFields) scoreTotals[f] = (scoreTotals[f] ?? 0) + (r[f] ?? 0)
  }
  const avgScores = reviewsWithScores > 0
    ? scoreFields.map(f => `${f.replace('score_', '')}: ${(scoreTotals[f] / reviewsWithScores).toFixed(1)}/10`).join(' | ')
    : 'sem dados'

  // Regras novas da semana
  const newRules = weekReviews.filter((r: any) => r.new_rule).map((r: any) => r.new_rule).slice(0, 3)

  const tradeLines = closedTrades.slice(0, 8).map((t: any) =>
    `${t.asset} ${t.direction} | entrada $${t.entry_price} → $${t.close_price} | P&L ${(t.pnl_usd ?? 0) >= 0 ? '+' : ''}$${(t.pnl_usd ?? 0).toFixed(2)}`
  ).join('\n')

  const signalLines = weekSignals.slice(0, 5).map((s: any) =>
    `${s.asset} ${s.direction} [${s.setup_grade}] — status: ${s.status}`
  ).join('\n')

  const prompt = `Você é um coach de trading experiente. Analise a semana de trading abaixo e gere um digest motivador e construtivo em português.

RESULTADO DA SEMANA:
- Trades fechados: ${closedTrades.length} (${winners.length} wins, ${losers.length} losses)
- Win Rate: ${winRate.toFixed(1)}%
- P&L total: ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}

TRADES:
${tradeLines || 'Nenhum trade fechado'}

SINAIS DETECTADOS:
${signalLines || 'Nenhum sinal'}

SCORES MÉDIOS DO REVIEW IA:
${avgScores}

ERROS MAIS FREQUENTES:
${topErrors.map(([e, n]) => `${e} (${n}x)`).join(', ') || 'nenhum'}

REGRAS GERADAS ESTA SEMANA:
${newRules.join('\n') || 'nenhuma'}

Gere um digest estruturado com:
1. **RESULTADO:** Avaliação objetiva da semana (2 frases)
2. **PADRÃO DETECTADO:** Comportamento repetitivo positivo ou negativo (2 frases)
3. **FOCO DA PRÓXIMA SEMANA:** O que mudar ou manter (2 frases)
4. **MENSAGEM:** Frase motivadora e direta para o trader (1 frase)

Seja honesto, construtivo e específico. Use os dados reais.`

  try {
    const client  = new Anthropic({ apiKey })
    const message = await client.messages.create({
      model:      'claude-haiku-4-5',
      max_tokens: 500,
      messages:   [{ role: 'user', content: prompt }],
    })

    const analysis = (message.content[0] as any).text as string

    const pnlSign = totalPnl >= 0 ? '+' : ''
    const emoji   = totalPnl >= 0 ? '📈' : '📉'

    const tgMsg = [
      `📅 <b>Digest Semanal — Melhor Trade</b>`,
      ``,
      `${emoji} ${winners.length}W / ${losers.length}L — WR <b>${winRate.toFixed(1)}%</b> — P&amp;L <b>${pnlSign}$${Math.abs(totalPnl).toFixed(2)}</b>`,
      ``,
      analysis,
      ``,
      `👉 Abrir Journal para análise completa`,
    ].join('\n')

    await sendTelegram(tgMsg)

    return NextResponse.json({ ok: true, winRate, totalPnl, analysis })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
