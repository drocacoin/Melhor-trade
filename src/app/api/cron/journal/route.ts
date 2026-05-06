/**
 * Cron mensal — Journal com IA
 *
 * Roda no dia 1 de cada mês às 10h UTC.
 * Analisa todos os trades do mês anterior, gera narrativa com Haiku
 * e salva em monthly_journals. Envia resumo via Telegram.
 */
import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import Anthropic from '@anthropic-ai/sdk'

export const maxDuration = 60

export async function GET(req: NextRequest) {
  const bearer = req.headers.get('authorization')?.replace('Bearer ', '')
  const secret = bearer ?? req.headers.get('x-cron-secret') ?? req.nextUrl.searchParams.get('secret')
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // ── Determinar mês anterior ──────────────────────────────────────────────
  const now   = new Date()
  // Parâmetro ?month=YYYY-MM permite forçar um mês específico
  const forceMonth = req.nextUrl.searchParams.get('month')
  let month: string

  if (forceMonth) {
    month = forceMonth
  } else {
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    month = prev.toISOString().slice(0, 7)  // 'YYYY-MM'
  }

  const monthStart = `${month}-01T00:00:00.000Z`
  const monthEnd   = new Date(
    parseInt(month.slice(0, 4)),
    parseInt(month.slice(5, 7)),  // já é o mês seguinte (0-indexed + 1)
    1
  ).toISOString()

  const db = supabaseAdmin()

  // ── Buscar trades fechados no mês ────────────────────────────────────────
  const { data: trades, error: tradesErr } = await db
    .from('trades')
    .select('*')
    .eq('status', 'closed')
    .gte('closed_at', monthStart)
    .lt('closed_at', monthEnd)
    .order('closed_at', { ascending: true })

  if (tradesErr) {
    console.error('[journal] trades error:', tradesErr.message)
    return NextResponse.json({ error: tradesErr.message }, { status: 500 })
  }

  if (!trades?.length) {
    return NextResponse.json({ ok: true, month, trades: 0 })
  }

  // ── Buscar reviews dos trades ────────────────────────────────────────────
  const tradeIds = trades.map(t => t.id)
  const { data: reviews } = await db
    .from('trade_reviews')
    .select('*')
    .in('trade_id', tradeIds)

  // ── Calcular estatísticas ─────────────────────────────────────────────────
  const isWin  = (t: any) => t.pnl_usd != null ? t.pnl_usd > 0 : (t.pnl_pct ?? 0) > 0
  const wins   = trades.filter(isWin)
  const losses = trades.filter(t => !isWin(t))

  const totalPnl  = trades.reduce((s, t) => s + (t.pnl_usd ?? 0), 0)
  const avgWin    = wins.length   ? wins.reduce((s, t)   => s + (t.pnl_usd ?? 0), 0) / wins.length   : 0
  const avgLoss   = losses.length ? losses.reduce((s, t) => s + (t.pnl_usd ?? 0), 0) / losses.length : 0
  const winrate   = (wins.length / trades.length) * 100

  const sorted    = [...trades].sort((a, b) => (b.pnl_usd ?? 0) - (a.pnl_usd ?? 0))
  const bestAsset  = sorted[0]?.asset ?? null
  const worstAsset = sorted[sorted.length - 1]?.asset ?? null

  // Erros mais comuns dos reviews
  const errorCounts: Record<string, number> = {}
  for (const r of reviews ?? []) {
    for (const e of r.errors ?? []) {
      errorCounts[e] = (errorCounts[e] ?? 0) + 1
    }
  }
  const topErrors = Object.entries(errorCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([cat]) => cat)

  // P&L por ativo
  const byAsset: Record<string, { pnl: number; count: number }> = {}
  for (const t of trades) {
    if (!byAsset[t.asset]) byAsset[t.asset] = { pnl: 0, count: 0 }
    byAsset[t.asset].pnl   += t.pnl_usd ?? 0
    byAsset[t.asset].count += 1
  }

  // ── Gerar narrativa com Haiku ─────────────────────────────────────────────
  const reviewSummary = reviews?.length
    ? reviews.slice(0, 10).map(r =>
        `Trade ${r.trade_id} (${r.classification ?? '?'}): ` +
        `processo=${r.scores?.processo ?? '?'}, execução=${r.scores?.execucao ?? '?'}, ` +
        `erros=${(r.errors ?? []).join(', ') || 'nenhum'}. ` +
        (r.improvement ?? '')
      ).join('\n')
    : 'Sem reviews disponíveis.'

  const statsText = [
    `Período: ${month}`,
    `Trades: ${trades.length} (${wins.length}W / ${losses.length}L) — WR ${winrate.toFixed(1)}%`,
    `P&L total: $${totalPnl.toFixed(2)}`,
    `Média win: $${avgWin.toFixed(2)} | Média loss: $${avgLoss.toFixed(2)}`,
    `Melhor ativo: ${bestAsset} | Pior: ${worstAsset}`,
    `P&L por ativo: ${Object.entries(byAsset).map(([a, v]) => `${a}=$${v.pnl.toFixed(0)}`).join(', ')}`,
    `Erros recorrentes: ${topErrors.join(', ') || 'nenhum'}`,
  ].join('\n')

  let narrative = ''
  let highlights: string[] = []

  try {
    const client = new Anthropic()
    const resp = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 600,
      messages: [{
        role: 'user',
        content:
          `Você é um coach de trading quantitativo. Analise os resultados do mês e gere um journal.\n\n` +
          `ESTATÍSTICAS:\n${statsText}\n\n` +
          `REVIEWS DOS TRADES:\n${reviewSummary}\n\n` +
          `Responda em JSON:\n` +
          `{\n` +
          `  "narrative": "narrativa de 3-4 frases explicando o mês: o que funcionou, o que falhou e o contexto",\n` +
          `  "highlights": ["insight 1 acionável", "insight 2 acionável", "insight 3 acionável"]\n` +
          `}`,
      }],
    })

    const raw  = (resp.content[0] as any).text ?? ''
    const json = raw.match(/\{[\s\S]*\}/)
    if (json) {
      const parsed  = JSON.parse(json[0])
      narrative  = parsed.narrative ?? ''
      highlights = parsed.highlights ?? []
    }
  } catch (e: any) {
    console.error('[journal] Haiku error:', e.message)
    narrative  = `Mês ${month}: ${trades.length} trades, WR ${winrate.toFixed(1)}%, P&L $${totalPnl.toFixed(2)}.`
    highlights = topErrors.slice(0, 3).map(e => `Erro recorrente: ${e}`)
  }

  // ── Salvar no banco ───────────────────────────────────────────────────────
  const record = {
    month,
    trades_total: trades.length,
    winners:      wins.length,
    losers:       losses.length,
    winrate:      Math.round(winrate * 100) / 100,
    total_pnl:    Math.round(totalPnl * 100) / 100,
    avg_win:      Math.round(avgWin  * 100) / 100,
    avg_loss:     Math.round(avgLoss * 100) / 100,
    best_asset:   bestAsset,
    worst_asset:  worstAsset,
    top_errors:   topErrors,
    narrative,
    highlights,
  }

  const { error: upsertErr } = await db
    .from('monthly_journals')
    .upsert(record, { onConflict: 'month' })

  if (upsertErr) console.error('[journal] upsert error:', upsertErr.message)

  // ── Enviar Telegram ───────────────────────────────────────────────────────
  const sign    = totalPnl >= 0 ? '+' : ''
  const wrEmoji = winrate >= 60 ? '🟢' : winrate >= 50 ? '🟡' : '🔴'
  const pnlEmoji = totalPnl >= 0 ? '💚' : '🔴'

  const hlLines = highlights.length
    ? highlights.map(h => `  → ${h}`).join('\n')
    : ''

  const telegramMsg =
    `📔 <b>Journal Mensal — ${month}</b>\n\n` +
    `${wrEmoji} <b>${trades.length} trades</b> — ${wins.length}W / ${losses.length}L — WR <b>${winrate.toFixed(1)}%</b>\n` +
    `${pnlEmoji} P&amp;L: <b>${sign}$${Math.abs(totalPnl).toFixed(2)}</b>\n` +
    `📈 Média win: +$${avgWin.toFixed(2)} | 📉 Média loss: $${avgLoss.toFixed(2)}\n` +
    `🏆 Melhor: ${bestAsset ?? '—'} | 💀 Pior: ${worstAsset ?? '—'}\n\n` +
    (narrative ? `<i>${narrative}</i>\n\n` : '') +
    (hlLines ? `<b>Insights:</b>\n${hlLines}` : '')

  return NextResponse.json({ ok: true, month, trades: trades.length, winrate, total_pnl: totalPnl, narrative, highlights })
}
