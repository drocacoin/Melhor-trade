/**
 * GET /api/news
 * Debug — retorna sentimento de notícias ao vivo por ativo.
 */
import { NextRequest, NextResponse } from 'next/server'
import { fetchNewsSentiment } from '@/lib/news'

export const maxDuration = 30

export async function GET(req: NextRequest) {
  const secret = req.headers.get('authorization')?.replace('Bearer ', '') ?? req.nextUrl.searchParams.get('secret')
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const result = await fetchNewsSentiment()

  // Ordenar assets por abs(score) decrescente
  const sorted = Object.values(result.byAsset)
    .sort((a, b) => Math.abs(b.score) - Math.abs(a.score))

  return NextResponse.json({
    ok: true,
    total_news: result.total,
    fetchedAt:  result.fetchedAt,
    assets:     sorted,
    recent_headlines: result.items.slice(0, 10).map(h => ({
      title:  h.title,
      source: h.source,
      ageH:   h.ageH,
    })),
  })
}
