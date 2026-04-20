import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export async function POST(req: NextRequest) {
  const body = await req.json()
  const db   = supabaseAdmin()

  const score_medio = (
    body.score_estrutura + body.score_timing + body.score_indicadores +
    body.score_macro + body.score_risco + body.score_execucao + body.score_disciplina
  ) / 7

  const process_class =
    score_medio >= 7 ? 'correto' :
    score_medio >= 4 ? 'parcialmente_correto' : 'incorreto'

  const { data, error } = await db
    .from('trade_reviews')
    .insert({ ...body, score_medio, process_class })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data, { status: 201 })
}

export async function GET() {
  const db = supabaseAdmin()
  const { data, error } = await db
    .from('trade_reviews')
    .select('*, trades(asset, direction, entry_price, close_price, pnl_pct)')
    .order('reviewed_at', { ascending: false })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}
