import { NextResponse } from 'next/server'
import { fetchWhaleSentiment } from '@/lib/whales'

export const maxDuration = 60

export async function GET() {
  try {
    const data = await fetchWhaleSentiment()
    return NextResponse.json(data)
  } catch (e: any) {
    console.error('[whales]', e.message)
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
