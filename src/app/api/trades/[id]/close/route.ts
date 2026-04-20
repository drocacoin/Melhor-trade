import { NextRequest, NextResponse } from 'next/server'
import { after } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { autoReview } from '@/lib/auto-review'
import { sendTelegram } from '@/lib/telegram'

export const maxDuration = 60  // dá tempo para autoReview (Haiku ~10s) rodar no after()

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { close_price, notes } = await req.json()
  const db = supabaseAdmin()

  const { data: trade } = await db.from('trades').select('*').eq('id', id).single()
  if (!trade) return NextResponse.json({ error: 'Trade not found' }, { status: 404 })

  const pnl_pct = trade.direction === 'long'
    ? ((close_price - trade.entry_price) / trade.entry_price) * 100 * trade.leverage
    : ((trade.entry_price - close_price) / trade.entry_price) * 100 * trade.leverage

  const pnl_usd = trade.size ? (pnl_pct / 100) * trade.size : null

  const { data, error } = await db
    .from('trades')
    .update({ close_price, pnl_pct, pnl_usd, closed_at: new Date().toISOString(), status: 'closed', notes })
    .eq('id', id)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // ── Background tasks (after response is sent) ─────────────────────────────
  after(async () => {
    const pnlSign = (pnl_usd ?? 0) >= 0 ? '+' : ''
    const emoji   = (pnl_usd ?? 0) >= 0 ? '✅' : '❌'
    const pctSign = pnl_pct >= 0 ? '+' : ''

    // 1. Notificação imediata de fechamento
    await sendTelegram(
      `${emoji} <b>Trade fechado — ${trade.asset}</b>\n` +
      `Direção: ${trade.direction.toUpperCase()}\n` +
      `Entrada: <code>$${trade.entry_price}</code> → Fechamento: <code>$${close_price}</code>\n` +
      `P&amp;L: <b>${pnlSign}$${Math.abs(pnl_usd ?? 0).toFixed(2)}</b> (${pctSign}${pnl_pct.toFixed(2)}%)\n\n` +
      `🤖 <i>Gerando review automático...</i>`
    )

    // 2. Auto-review com IA — retorna resultado para enviar no Telegram
    const review = await autoReview(data.id)

    // 3. Envia resultado do review
    if (review) {
      const scoreMedia = Math.round(
        (review.score_estrutura + review.score_timing + review.score_indicadores +
         review.score_risco + review.score_execucao + review.score_disciplina) / 6
      )
      const classEmoji = review.process_class === 'correto' ? '✅' : review.process_class === 'parcialmente_correto' ? '⚠️' : '❌'

      // Escapar HTML nas strings do review
      const safe = (s: string) => (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

      await sendTelegram(
        `🧠 <b>Review IA — ${trade.asset}</b>\n\n` +
        `${classEmoji} <b>${review.process_class.replace('_', ' ').toUpperCase()}</b> · Score médio: <b>${scoreMedia}/10</b>\n\n` +
        `📊 Estrutura ${review.score_estrutura} · Timing ${review.score_timing} · Indicadores ${review.score_indicadores}\n` +
        `   Risco ${review.score_risco} · Execução ${review.score_execucao} · Disciplina ${review.score_disciplina}\n\n` +
        (review.what_went_right ? `✅ <i>${safe(review.what_went_right)}</i>\n` : '') +
        (review.what_went_wrong ? `❌ <i>${safe(review.what_went_wrong)}</i>\n` : '') +
        (review.new_rule ? `\n📌 <b>Nova regra:</b> ${safe(review.new_rule)}` : '')
      )
    } else {
      // autoReview falhou (sem snapshots, sem API key, etc) — avisa mas não quebra
      await sendTelegram(
        `⚠️ <b>Review automático indisponível — ${trade.asset}</b>\n` +
        `<i>Sem dados técnicos suficientes na data de entrada. Faça o review manual no app.</i>`
      )
    }

    // 4. Verificar se atingiu múltiplo de 5 trades — dispara evolução
    const db2 = supabaseAdmin()
    const { count } = await db2.from('trades').select('*', { count: 'exact', head: true }).eq('status', 'closed')
    if (count && count % 5 === 0) {
      try {
        await fetch(
          `${process.env.NEXT_PUBLIC_APP_URL ?? 'https://melhor-trade.vercel.app'}/api/cron/evolve`,
          { headers: { 'Authorization': `Bearer ${process.env.CRON_SECRET}` } }
        )
      } catch { /* silencioso */ }
    }
  })

  return NextResponse.json(data)
}
