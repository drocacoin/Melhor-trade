import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// GET /api/journal/monthly — retorna os últimos 12 resumos mensais
export async function GET() {
  const db = supabaseAdmin()

  const { data, error } = await db
    .from('monthly_journals')
    .select('*')
    .order('month', { ascending: false })
    .limit(12)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json(data ?? [])
}
