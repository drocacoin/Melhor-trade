import { NextResponse } from 'next/server'
import { fetchLivePrice } from '@/lib/fetcher'

const ASSETS = ['BTC', 'ETH', 'SOL', 'HYPE', 'AAVE', 'LINK', 'AVAX', 'GOLD']

export const runtime = 'nodejs'
export const revalidate = 0

export async function GET() {
  const entries = await Promise.all(
    ASSETS.map(async asset => {
      try {
        const price = await fetchLivePrice(asset)
        return [asset, price] as const
      } catch {
        return [asset, null] as const
      }
    })
  )
  return NextResponse.json(Object.fromEntries(entries))
}
