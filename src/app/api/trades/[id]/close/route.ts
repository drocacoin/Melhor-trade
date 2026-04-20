import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

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
  return NextResponse.json(data)
}
