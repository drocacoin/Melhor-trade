import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { generateSignalAnalysis } from '@/lib/signal-analysis'

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const db = supabaseAdmin()

  // Buscar sinal
  const { data: signal } = await db.from('signals').select('*').eq('id', id).single()
  if (!signal) return NextResponse.json({ error: 'Signal not found' }, { status: 404 })

  // Snapshots mais recentes por timeframe para este ativo
  const { data: snaps } = await db
    .from('snapshots')
    .select('*')
    .eq('asset', signal.asset)
    .order('captured_at', { ascending: false })
    .limit(20)

  const snapshots: Record<string, any> = {}
  const seen = new Set<string>()
  for (const s of snaps ?? []) {
    if (!seen.has(s.timeframe)) { seen.add(s.timeframe); snapshots[s.timeframe] = s }
  }

  // Última leitura macro
  const { data: macro } = await db
    .from('macro_readings')
    .select('*')
    .order('captured_at', { ascending: false })
    .limit(1)
    .single()

  try {
    // Opus para análise manual — maior qualidade
    const analysis = await generateSignalAnalysis(signal, snapshots, macro, null, 'opus')

    await db.from('signals').update({ analysis }).eq('id', id)

    return NextResponse.json({ analysis })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
