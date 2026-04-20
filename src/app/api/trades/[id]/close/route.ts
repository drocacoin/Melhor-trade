import { NextRequest, NextResponse } from 'next/server'
import { after } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { autoReview } from '@/lib/auto-review'
import { sendTelegram } from '@/lib/telegram'

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
    // 1. Auto-review com IA
    await autoReview(data.id)

    // 2. Verificar se atingiu múltiplo de 5 trades — dispara evolução
    const db2 = supabaseAdmin()
    const { count } = await db2.from('trades').select('*', { count: 'exact', head: true }).eq('status', 'closed')
    if (count && count % 5 === 0) {
      try {
        await fetch(`${process.env.NEXT_PUBLIC_APP_URL ?? 'https://melhor-trade.vercel.app'}/api/cron/evolve?secret=${process.env.CRON_SECRET}`)
      } catch { /* silencioso */ }
    }

    // 2. Notificação Telegram
    const pnlSign  = (pnl_usd ?? 0) >= 0 ? '+' : ''
    const emoji    = (pnl_usd ?? 0) >= 0 ? '✅' : '❌'
    const pctSign  = pnl_pct >= 0 ? '+' : ''

    await sendTelegram(
      `${emoji} <b>Trade fechado — ${trade.asset}</b>\n` +
      `Direção: ${trade.direction.toUpperCase()}\n` +
      `Entrada: <code>$${trade.entry_price}</code> → Fechamento: <code>$${close_price}</code>\n` +
      `P&amp;L: <b>${pnlSign}$${Math.abs(pnl_usd ?? 0).toFixed(2)}</b> (${pctSign}${pnl_pct.toFixed(2)}%)\n` +
      `\n🤖 Analisando trade automaticamente...`
    )
  })

  return NextResponse.json(data)
}
