import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { computeLiveScore } from '@/lib/scoring'
import { computeThreshold } from '@/lib/threshold'
import { fetchFearAndGreed } from '@/lib/fetcher'

const ASSETS = ['BTC', 'ETH', 'SOL', 'HYPE', 'AAVE', 'LINK', 'AVAX', 'GOLD', 'OIL', 'SP500', 'MSTR']

export const revalidate = 120  // cache 2 min

export async function GET() {
  const db = supabaseAdmin()

  const [{ data: snaps }, { data: perf }, fg] = await Promise.all([
    db.from('snapshots').select('*').order('captured_at', { ascending: false }).limit(500),
    db.from('performance_summary').select('*'),
    fetchFearAndGreed(),
  ])

  // Latest snapshot per asset × timeframe
  const seen    = new Set<string>()
  const latest  = (snaps ?? []).filter(s => {
    const k = `${s.asset}-${s.timeframe}`
    if (seen.has(k)) return false
    seen.add(k); return true
  })

  const perfMap = Object.fromEntries((perf ?? []).map((p: any) => [p.asset, p]))

  const scores = ASSETS.map(asset => {
    const assetSnaps = latest.filter(s => s.asset === asset)
    const byTf: Record<string, any> = Object.fromEntries(assetSnaps.map(s => [s.timeframe, s]))

    const score     = computeLiveScore(byTf, fg)
    const threshold = computeThreshold(perfMap[asset])

    return {
      asset,
      bullScore:   score.bullScore,
      bearScore:   score.bearScore,
      topScore:    score.topScore,
      direction:   score.direction,
      maxPossible: score.maxPossible,
      threshold:   threshold.threshold,
      gap:         threshold.threshold - score.topScore,  // pts faltando para sinal
      pct:         Math.min(100, Math.round((score.topScore / threshold.threshold) * 100)),
      factors:     score.factors,
      thr_reason:  threshold.reason,
      thr_status:  threshold.status,
    }
  })

  return NextResponse.json({ scores, fear_greed: fg })
}
