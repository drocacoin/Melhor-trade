import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl
  const asset = searchParams.get('asset')
  const db    = supabaseAdmin()

  let query = db
    .from('snapshots')
    .select('*')
    .order('captured_at', { ascending: false })

  if (asset) query = query.eq('asset', asset)

  // Latest per asset+timeframe
  const { data, error } = await query.limit(200)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Deduplicate — keep latest per asset+timeframe
  const seen = new Set<string>()
  const deduped = (data ?? []).filter(r => {
    const key = `${r.asset}-${r.timeframe}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  return NextResponse.json(deduped)
}
