/**
 * Monitoramento de notícias via RSS público — sem API key.
 *
 * Fluxo:
 *  1. Busca feeds RSS em paralelo (CoinTelegraph, Decrypt, CoinDesk, etc.)
 *  2. Filtra últimas 12h
 *  3. Identifica assets mencionados por keywords
 *  4. Pontua sentimento (bullish/bearish) por keywords no título
 *  5. Retorna ranking de sentimento por ativo
 */

const FETCH_TIMEOUT = 8_000

function fetchWT(url: string): Promise<Response> {
  return Promise.race([
    fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept':     'application/rss+xml, application/xml, text/xml, */*',
        'Cache-Control': 'no-cache',
      },
    }),
    new Promise<never>((_, r) =>
      setTimeout(() => r(new Error(`timeout ${url.slice(0, 50)}`)), FETCH_TIMEOUT)
    ),
  ])
}

// ─── Feeds RSS monitorados ────────────────────────────────────────────────────
const FEEDS = [
  { url: 'https://cointelegraph.com/rss',                         name: 'CoinTelegraph' },
  { url: 'https://decrypt.co/feed',                               name: 'Decrypt'       },
  { url: 'https://thedefiant.io/feed',                            name: 'TheDefiant'    },
  { url: 'https://bitcoinmagazine.com/.rss/full/',                name: 'BitcoinMag'    },
  { url: 'https://www.coindesk.com/arc/outboundfeeds/rss/',       name: 'CoinDesk'      },
]

// ─── Keywords por ativo ───────────────────────────────────────────────────────
const ASSET_KEYWORDS: Record<string, string[]> = {
  BTC:   ['bitcoin', 'btc'],
  ETH:   ['ethereum', 'eth '],
  SOL:   ['solana', ' sol '],
  HYPE:  ['hyperliquid'],
  AAVE:  ['aave'],
  LINK:  ['chainlink', ' link '],
  AVAX:  ['avalanche', 'avax'],
  XRP:   ['xrp', 'ripple'],
  SUI:   [' sui '],
  DOGE:  ['dogecoin', 'doge'],
  TAO:   ['bittensor', ' tao '],
  MSTR:  ['microstrategy', 'saylor'],
  OIL:   ['crude oil', 'brent crude', 'opec'],
  SP500: ["s&p 500", "s&p500", 'nasdaq', 'dow jones', 'fed rate', 'federal reserve', 'cpi report', 'inflation data'],
  GOLD:  ['gold price', 'gold rally', 'gold drops', 'xau'],
}

// ─── Palavras de sentimento ───────────────────────────────────────────────────
const BULLISH_WORDS = [
  'surge', 'rally', 'soar', 'jump', 'climb', 'breakout', 'record high',
  'all-time high', 'ath', 'bullish', 'bull run', 'gain', 'rises',
  'approved', 'etf', 'adoption', 'partnership', 'launch', 'upgrade',
  'buy', 'accumulate', 'recovery', 'rebound',
]
const BEARISH_WORDS = [
  'crash', 'plunge', 'dump', 'drop', 'fall', 'collapse', 'selloff',
  'bearish', 'bear', 'ban', 'hack', 'exploit', 'fraud', 'scam',
  'liquidation', 'losses', 'declining', 'warning', 'concern', 'risk',
  'regulation', 'crackdown', 'investigation',
]

// ─── Types ───────────────────────────────────────────────────────────────────
export interface NewsHeadline {
  title:   string
  pubDate: string
  source:  string
  ageH:    number   // horas atrás
}

export interface AssetNewsSentiment {
  asset:     string
  score:     number        // float -2..+2
  sentiment: 'bullish' | 'bearish' | 'neutral'
  count:     number        // notícias mencionando o ativo
  headlines: string[]      // top 3 mais recentes
}

// ─── Parser RSS simples (sem dependências) ───────────────────────────────────
function parseRSS(xml: string, source: string): NewsHeadline[] {
  const out: NewsHeadline[] = []
  const itemRe = /<item[^>]*>([\s\S]*?)<\/item>/g
  let m: RegExpExecArray | null

  while ((m = itemRe.exec(xml)) !== null) {
    const body = m[1]

    // Suporta <title>texto</title> e <title><![CDATA[texto]]></title>
    const titleRaw =
      body.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/)?.[1] ??
      body.match(/<title>([\s\S]*?)<\/title>/)?.[1] ??
      ''

    const pubRaw = body.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] ?? ''

    if (!titleRaw.trim()) continue

    let ageH = 0
    try { ageH = (Date.now() - new Date(pubRaw).getTime()) / 3_600_000 } catch {}
    if (ageH > 12) continue   // ignora notícias com mais de 12h

    out.push({
      title:   titleRaw.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim(),
      pubDate: pubRaw,
      source,
      ageH:    Math.round(ageH * 10) / 10,
    })
  }

  return out
}

async function fetchFeed(feed: { url: string; name: string }): Promise<NewsHeadline[]> {
  try {
    const r = await fetchWT(feed.url)
    if (!r.ok) return []
    const xml = await r.text()
    return parseRSS(xml, feed.name)
  } catch {
    return []
  }
}

// ─── Score de sentimento de um título ────────────────────────────────────────
function scoreTitle(title: string): number {
  const t = title.toLowerCase()
  let s = 0
  for (const w of BULLISH_WORDS) if (t.includes(w)) s += 1
  for (const w of BEARISH_WORDS) if (t.includes(w)) s -= 1
  return Math.max(-2, Math.min(2, s))
}

// ─── API principal ────────────────────────────────────────────────────────────
export async function fetchNewsSentiment(): Promise<{
  items:     NewsHeadline[]
  byAsset:   Record<string, AssetNewsSentiment>
  total:     number
  fetchedAt: string
}> {
  // Busca todos os feeds em paralelo, falhas silenciosas
  const arrays = await Promise.allSettled(FEEDS.map(fetchFeed))
  const items: NewsHeadline[] = arrays
    .flatMap(r => r.status === 'fulfilled' ? r.value : [])
    .sort((a, b) => a.ageH - b.ageH)   // mais recentes primeiro

  const byAsset: Record<string, AssetNewsSentiment> = {}

  for (const [asset, keywords] of Object.entries(ASSET_KEYWORDS)) {
    const relevant = items.filter(it => {
      const t = ` ${it.title.toLowerCase()} `
      return keywords.some(k => t.includes(k))
    })

    if (!relevant.length) continue

    let totalScore = 0
    for (const it of relevant) totalScore += scoreTitle(it.title)

    const avg = totalScore / relevant.length

    byAsset[asset] = {
      asset,
      score:     Math.round(avg * 10) / 10,
      sentiment: avg >= 0.4 ? 'bullish' : avg <= -0.4 ? 'bearish' : 'neutral',
      count:     relevant.length,
      headlines: relevant.slice(0, 3).map(h => h.title),
    }
  }

  return {
    items,
    byAsset,
    total:     items.length,
    fetchedAt: new Date().toISOString(),
  }
}
