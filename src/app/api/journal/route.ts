import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export async function GET() {
  const db = supabaseAdmin()

  const [{ data: trades }, { data: reviews }, { data: perf }] = await Promise.all([
    db.from('trades').select('*').eq('status', 'closed').order('closed_at', { ascending: true }),
    db.from('trade_reviews').select('*').order('reviewed_at', { ascending: false }),
    db.from('performance_summary').select('*'),
  ])

  const closed = trades ?? []

  // Equity curve — cumulative P&L
  let cumulative = 0
  const equity = closed.map(t => {
    cumulative += t.pnl_usd ?? 0
    return {
      date:       t.closed_at?.slice(0, 10) ?? '',
      pnl:        Math.round((t.pnl_usd ?? 0) * 100) / 100,
      cumulative: Math.round(cumulative * 100) / 100,
      asset:      t.asset,
      direction:  t.direction,
    }
  })

  // Monthly P&L
  const monthlyMap: Record<string, number> = {}
  for (const t of closed) {
    const month = t.closed_at?.slice(0, 7) ?? 'N/A'
    monthlyMap[month] = (monthlyMap[month] ?? 0) + (t.pnl_usd ?? 0)
  }
  const monthly = Object.entries(monthlyMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, pnl]) => ({ month, pnl: Math.round(pnl * 100) / 100 }))

  // Error categories from reviews
  const errorMap: Record<string, number> = {}
  for (const r of reviews ?? []) {
    if (r.error_category) {
      errorMap[r.error_category] = (errorMap[r.error_category] ?? 0) + 1
    }
  }
  const errors = Object.entries(errorMap)
    .sort(([, a], [, b]) => b - a)
    .map(([category, count]) => ({ category, count }))

  // Summary stats
  const winners  = closed.filter(t => (t.pnl_usd ?? 0) > 0)
  const losers   = closed.filter(t => (t.pnl_usd ?? 0) <= 0)
  const totalPnl = closed.reduce((s, t) => s + (t.pnl_usd ?? 0), 0)
  const best     = closed.reduce((b, t) => (t.pnl_usd ?? 0) > (b.pnl_usd ?? 0) ? t : b, closed[0] ?? null)
  const worst    = closed.reduce((w, t) => (t.pnl_usd ?? 0) < (w.pnl_usd ?? 0) ? t : w, closed[0] ?? null)
  const avgWin   = winners.length ? winners.reduce((s, t) => s + (t.pnl_usd ?? 0), 0) / winners.length : 0
  const avgLoss  = losers.length  ? losers.reduce((s, t)  => s + (t.pnl_usd ?? 0), 0) / losers.length  : 0

  return NextResponse.json({
    equity, monthly, errors,
    perf: perf ?? [],
    summary: {
      total:    closed.length,
      winners:  winners.length,
      losers:   losers.length,
      winrate:  closed.length ? (winners.length / closed.length) * 100 : 0,
      totalPnl: Math.round(totalPnl * 100) / 100,
      avgWin:   Math.round(avgWin * 100) / 100,
      avgLoss:  Math.round(avgLoss * 100) / 100,
      best:     best  ? { asset: best.asset,  pnl: best.pnl_usd  } : null,
      worst:    worst ? { asset: worst.asset, pnl: worst.pnl_usd } : null,
    },
  })
}
