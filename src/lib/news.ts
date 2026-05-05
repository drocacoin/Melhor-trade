/**
 * Monitoramento de notícias via RSS público + perfis Twitter via Nitter.
 *
 * Fontes:
 *  - Feeds RSS: CoinTelegraph, Decrypt, CoinDesk, BitcoinMag, TheDefiant
 *  - Twitter/X via Nitter RSS (zero API key): @marioNawfal, @coinbureau, @WatcherGuru
 *
 * Fluxo:
 *  1. Busca feeds RSS + Nitter em paralelo
 *  2. Nitter tenta múltiplas instâncias como fallback (instâncias caem com frequência)
 *  3. Filtra últimas 12h
 *  4. Identifica assets por keywords, calcula sentimento por palavras bullish/bearish
 *  5. Tweets de influencers recebem peso 1.5× (sinal mais direto)
 *  6. Retorna ranking de sentimento por ativo
 */

// ─── Timeouts ─────────────────────────────────────────────────────────────────
const NEWS_TIMEOUT   = 8_000   // feeds de notícias
const NITTER_TIMEOUT = 6_000   // por instância Nitter (tenta próxima se falhar)

function fetchWT(url: string, timeout = NEWS_TIMEOUT): Promise<Response> {
  return Promise.race([
    fetch(url, {
      headers: {
        'User-Agent':    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept':        'application/rss+xml, application/xml, text/xml, */*',
        'Cache-Control': 'no-cache',
      },
    }),
    new Promise<never>((_, r) =>
      setTimeout(() => r(new Error(`timeout ${url.slice(0, 50)}`)), timeout)
    ),
  ])
}

// ─── Feeds RSS de notícias ────────────────────────────────────────────────────
const NEWS_FEEDS = [
  { url: 'https://cointelegraph.com/rss',                   name: 'CoinTelegraph' },
  { url: 'https://decrypt.co/feed',                         name: 'Decrypt'       },
  { url: 'https://thedefiant.io/feed',                      name: 'TheDefiant'    },
  { url: 'https://bitcoinmagazine.com/.rss/full/',          name: 'BitcoinMag'    },
  { url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', name: 'CoinDesk'      },
]

// ─── Perfis Twitter monitorados via Nitter RSS ────────────────────────────────
// Instâncias em ordem de preferência — fallback automático se uma cair
const NITTER_INSTANCES = [
  'https://nitter.poast.org',
  'https://nitter.privacydev.net',
  'https://nitter.net',
  'https://nitter.1d4.us',
  'https://nitter.cz',
]

const TWITTER_ACCOUNTS = [
  { username: 'marioNawfal', name: '@marioNawfal' },  // breaking news, geopolítica
  { username: 'coinbureau',  name: '@CoinBureau'  },  // análise fundamentalista cripto
  { username: 'WatcherGuru', name: '@WatcherGuru' },  // breaking news cripto em tempo real
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
  OIL:   ['crude oil', 'brent', 'opec', 'oil price'],
  SP500: ["s&p 500", "s&p500", 'nasdaq', 'dow jones', 'fed rate', 'federal reserve', 'cpi', 'inflation', 'rate cut', 'rate hike'],
  GOLD:  ['gold price', 'gold rally', 'gold drops', 'xau'],
}

// ─── Palavras de sentimento — v2 (lista expandida) ───────────────────────────
const BULLISH_WORDS = [
  // Preço
  'surge', 'surges', 'surging', 'rally', 'rallies', 'rallying',
  'soar', 'soars', 'soaring', 'jump', 'jumps', 'jumping', 'spike',
  'climb', 'climbs', 'breakout', 'breaks out', 'broke out',
  'record high', 'all-time high', 'ath', 'new high', 'new record',
  'explodes', 'moons', 'parabolic', 'skyrockets',
  // Momentum / sentimento
  'bullish', 'bull run', 'bull market', 'gains', 'rises', 'pumps',
  'outperforms', 'recovery', 'rebound', 'bounces', 'bounce back',
  'accumulate', 'accumulation', 'whale buying', 'institutional buying',
  // Catalisadores
  'approved', 'approves', 'approval', 'etf', 'spot etf',
  'adoption', 'mainstream', 'partnership', 'integration',
  'launch', 'launches', 'launched', 'upgrade', 'upgraded',
  'halving', 'supply squeeze', 'inflows', 'net inflow',
  'regulation clarity', 'regulatory clarity', 'sec approves',
  'listing', 'listed', 'strategic reserve', 'treasury buys',
]
const BEARISH_WORDS = [
  // Preço
  'crash', 'crashes', 'crashing', 'plunge', 'plunges', 'plunging',
  'dump', 'dumps', 'dumping', 'drop', 'drops', 'dropping',
  'fall', 'falls', 'falling', 'collapse', 'collapses',
  'selloff', 'sell-off', 'selling pressure', 'capitulation',
  'correction', 'wipeout', 'tanks', 'tanking', 'plummets', 'nosedive',
  // Momentum / sentimento
  'bearish', 'bear market', 'losses', 'declining', 'outflows', 'net outflow',
  'exodus', 'weak', 'weakness', 'underperforms',
  // Riscos / regulação
  'banned', 'ban', 'bans', 'outlawed', 'hack', 'hacked', 'exploit', 'exploited',
  'rug pull', 'fraud', 'fraudulent', 'scam', 'ponzi', 'securities fraud',
  'liquidation', 'liquidated', 'margin call', 'forced selling',
  'crackdown', 'cracks down', 'investigation', 'indictment',
  'seized', 'seizes', 'arrest', 'arrested', 'charged',
  'delisted', 'delist', 'exchange halts', 'warning', 'vulnerability',
  'insolvency', 'insolvent', 'bankrupt', 'bankruptcy', 'contagion',
]

// ─── Types ────────────────────────────────────────────────────────────────────
export interface NewsHeadline {
  title:       string
  pubDate:     string
  source:      string
  ageH:        number    // horas atrás
  isTwitter:   boolean   // veio do Nitter
  tweetWeight: number    // 1.0 = notícia, 1.5 = tweet de influencer
}

export interface AssetNewsSentiment {
  asset:       string
  score:       number        // float -2..+2
  sentiment:   'bullish' | 'bearish' | 'neutral'
  count:       number
  tweetCount:  number        // quantos são tweets
  headlines:   string[]      // top 3 mais recentes
  sources:     string[]      // quais fontes mencionaram
}

// ─── Parser RSS (funciona tanto para news quanto para Nitter) ─────────────────
function parseRSS(xml: string, source: string, isTwitter = false): NewsHeadline[] {
  const out: NewsHeadline[] = []
  const itemRe = /<item[^>]*>([\s\S]*?)<\/item>/g
  let m: RegExpExecArray | null

  while ((m = itemRe.exec(xml)) !== null) {
    const body = m[1]

    const titleRaw =
      body.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/)?.[1] ??
      body.match(/<title>([\s\S]*?)<\/title>/)?.[1] ??
      ''

    const pubRaw = body.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] ?? ''

    if (!titleRaw.trim()) continue

    // Ignora retweets do Nitter ("RT by @username:")
    if (isTwitter && /^RT by @/i.test(titleRaw.trim())) continue

    // Limpa prefixos de reply do Nitter ("R to @username: ")
    const title = titleRaw
      .replace(/^R to @\w+:\s*/i, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#39;/g, "'")
      .trim()

    if (!title) continue

    let ageH = 0
    try { ageH = (Date.now() - new Date(pubRaw).getTime()) / 3_600_000 } catch {}
    if (ageH > 12) continue   // ignora conteúdo com mais de 12h

    out.push({
      title,
      pubDate:     pubRaw,
      source,
      ageH:        Math.round(ageH * 10) / 10,
      isTwitter,
      tweetWeight: isTwitter ? 1.5 : 1.0,   // tweets de influencer pesam mais
    })
  }

  return out
}

// ─── Fetch RSS de notícias ────────────────────────────────────────────────────
async function fetchNewsFeed(feed: { url: string; name: string }): Promise<NewsHeadline[]> {
  try {
    const r = await fetchWT(feed.url)
    if (!r.ok) return []
    const xml = await r.text()
    return parseRSS(xml, feed.name, false)
  } catch {
    return []
  }
}

// ─── Fetch Nitter com fallback entre instâncias ───────────────────────────────
async function fetchNitterAccount(account: { username: string; name: string }): Promise<NewsHeadline[]> {
  for (const instance of NITTER_INSTANCES) {
    try {
      const url = `${instance}/${account.username}/rss`
      const r   = await fetchWT(url, NITTER_TIMEOUT)
      if (!r.ok) continue
      const xml   = await r.text()
      const items = parseRSS(xml, account.name, true)
      if (items.length > 0) {
        console.log(`[news] Nitter OK: ${instance} → ${account.username} (${items.length} tweets)`)
        return items
      }
    } catch {
      // tenta próxima instância
    }
  }
  console.warn(`[news] Nitter: todas as instâncias falharam para @${account.username}`)
  return []
}

// ─── Score de sentimento de um item ──────────────────────────────────────────
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
  sources:   string[]
  fetchedAt: string
}> {
  // Busca tudo em paralelo: feeds de notícias + contas Nitter
  const [newsArrays, twitterArrays] = await Promise.all([
    Promise.allSettled(NEWS_FEEDS.map(fetchNewsFeed)),
    Promise.allSettled(TWITTER_ACCOUNTS.map(fetchNitterAccount)),
  ])

  const items: NewsHeadline[] = [
    ...newsArrays.flatMap(r   => r.status === 'fulfilled' ? r.value : []),
    ...twitterArrays.flatMap(r => r.status === 'fulfilled' ? r.value : []),
  ].sort((a, b) => a.ageH - b.ageH)   // mais recentes primeiro

  const sourceSet = new Set(items.map(i => i.source))

  const byAsset: Record<string, AssetNewsSentiment> = {}

  for (const [asset, keywords] of Object.entries(ASSET_KEYWORDS)) {
    const relevant = items.filter(it => {
      const t = ` ${it.title.toLowerCase()} `
      return keywords.some(k => t.includes(k))
    })

    if (!relevant.length) continue

    // Soma ponderada: tweets de influencer valem 1.5×
    let totalWeightedScore = 0
    let totalWeight        = 0
    let tweetCount         = 0

    for (const it of relevant) {
      const score = scoreTitle(it.title)
      totalWeightedScore += score * it.tweetWeight
      totalWeight        += it.tweetWeight
      if (it.isTwitter) tweetCount++
    }

    const avg = totalWeight > 0 ? totalWeightedScore / totalWeight : 0

    byAsset[asset] = {
      asset,
      score:      Math.round(avg * 10) / 10,
      sentiment:  avg >= 0.4 ? 'bullish' : avg <= -0.4 ? 'bearish' : 'neutral',
      count:      relevant.length,
      tweetCount,
      headlines:  relevant.slice(0, 3).map(h => `[${h.source}] ${h.title}`),
      sources:    [...new Set(relevant.map(h => h.source))],
    }
  }

  return {
    items,
    byAsset,
    total:     items.length,
    sources:   [...sourceSet],
    fetchedAt: new Date().toISOString(),
  }
}
