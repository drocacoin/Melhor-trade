import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// DELETE /api/trades/:id — apaga um trade (qualquer status)
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const db     = supabaseAdmin()

  const { error } = await db.from('trades').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

// PATCH /api/trades/:id — atualiza campos de um trade aberto (stop, alvos, notas)
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id }  = await params
  const body    = await req.json()
  const db      = supabaseAdmin()

  // Apenas campos permitidos para update
  const allowed = ['stop_price', 'target1', 'target2', 'target3', 'notes', 'alerted_target1', 'alerted_target2']
  const update  = Object.fromEntries(Object.entries(body).filter(([k]) => allowed.includes(k)))

  if (!Object.keys(update).length) {
    return NextResponse.json({ error: 'Nenhum campo válido para atualizar' }, { status: 400 })
  }

  const { data, error } = await db
    .from('trades')
    .update(update)
    .eq('id', id)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}
