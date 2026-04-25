/**
 * GET /api/whales/debug
 * Retorna o payload bruto do leaderboard HyperLiquid — só para diagnóstico.
 * REMOVER após confirmar o formato.
 */
import { NextResponse } from 'next/server'

export const maxDuration = 30

export async function GET() {
  try {
    const r = await fetch('https://stats-data.hyperliquid.xyz/Mainnet/leaderboard', {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
    })

    const status = r.status
    const text   = await r.text()

    // Tenta parsear para mostrar os primeiros itens e as chaves disponíveis
    let parsed: any = null
    let shape: any  = null
    try {
      parsed = JSON.parse(text)
      if (Array.isArray(parsed)) {
        shape = { type: 'array', length: parsed.length, firstItem: parsed[0] }
      } else {
        shape = { type: 'object', keys: Object.keys(parsed), firstRow: parsed[Object.keys(parsed)[0]]?.[0] }
      }
    } catch {
      shape = { type: 'not-json', preview: text.slice(0, 300) }
    }

    return NextResponse.json({ status, shape, raw_preview: text.slice(0, 1000) })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
