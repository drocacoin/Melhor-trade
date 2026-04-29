/**
 * GET /api/whales/debug  — testa fontes de dados de OIL
 * REMOVER após confirmar funcionamento.
 */
import { NextResponse } from 'next/server'

export const maxDuration = 30

export async function GET() {
  const results: any = {}

  // Teste 1: Stooq
  try {
    const r = await fetch('https://stooq.com/q/d/l/?s=bz.f&i=d', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      cache: 'no-store',
    })
    const text = await r.text()
    const rows = text.trim().split('\n')
    results.stooq = {
      status: r.status,
      header: rows[0],
      lastRow: rows[rows.length - 1],
      totalRows: rows.length,
    }
  } catch (e: any) {
    results.stooq = { error: e.message }
  }

  // Teste 2: Yahoo Finance (query2)
  try {
    const r = await fetch(
      'https://query2.finance.yahoo.com/v8/finance/chart/BZ%3DF?interval=1d&range=5d',
      { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }, cache: 'no-store' }
    )
    const json = await r.json()
    const close = json?.chart?.result?.[0]?.indicators?.quote?.[0]?.close
    results.yahoo = {
      status: r.status,
      lastClose: close?.[close.length - 1] ?? null,
      error: json?.chart?.error ?? null,
    }
  } catch (e: any) {
    results.yahoo = { error: e.message }
  }

  // Teste 3: Alpha Vantage (demo key)
  try {
    const r = await fetch(
      'https://www.alphavantage.co/query?function=BRENT&interval=daily&apikey=demo',
      { cache: 'no-store' }
    )
    const json = await r.json()
    const lastEntry = json?.data?.[0]
    results.alphavantage = {
      status: r.status,
      lastEntry,
      note: json?.Note ?? json?.Information ?? 'ok',
    }
  } catch (e: any) {
    results.alphavantage = { error: e.message }
  }

  return NextResponse.json(results)
}
