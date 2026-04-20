import { OHLCV } from './indicators'

// ─── HyperLiquid DEX — free, no key, POST API ─────────────────────────────────
// Covers: BTC ETH SOL HYPE AAVE LINK AVAX GOLD(PAXG)
const HL_SYMBOL: Record<string, string> = {
  BTC:  'BTC',
  ETH:  'ETH',
  SOL:  'SOL',
  HYPE: 'HYPE',
  AAVE: 'AAVE',
  LINK: 'LINK',
  AVAX: 'AVAX',
  GOLD: 'PAXG',  // PAX Gold — 1 PAXG = 1 troy oz gold
}

const HL_INTERVAL: Record<string, string> = {
  '1wk': '1w',
  '1d':  '1d',
  '4h':  '4h',
  '1h':  '1h',
}

const HL_LOOKBACK: Record<string, number> = {
  '1wk': 2 * 365 * 24 * 3600 * 1000,
  '1d':  2 * 365 * 24 * 3600 * 1000,
  '4h':  60  * 24 * 3600 * 1000,
  '1h':  30  * 24 * 3600 * 1000,
}

async function fetchCandlesHL(asset: string, timeframe: string): Promise<OHLCV[]> {
  const coin      = HL_SYMBOL[asset]
  const interval  = HL_INTERVAL[timeframe]
  const now       = Date.now()
  const startTime = now - HL_LOOKBACK[timeframe]

  const res = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'candleSnapshot',
      req: { coin, interval, startTime, endTime: now },
    }),
    next: { revalidate: 0 },
  })

  const json: any[] = await res.json()
  if (!Array.isArray(json)) throw new Error(`HyperLiquid error for ${asset} ${timeframe}`)

  return json.map(r => ({
    open:   parseFloat(r.o),
    high:   parseFloat(r.h),
    low:    parseFloat(r.l),
    close:  parseFloat(r.c),
    volume: parseFloat(r.v),
  }))
}

// ─── Yahoo Finance — OIL (BZ=F Brent), SP500 (SPY), MSTR ─────────────────────
const YAHOO_SYMBOL: Record<string, string> = {
  OIL:  'BZ=F',
  SP500: 'SPY',
  MSTR:  'MSTR',
}

const YAHOO_TF: Record<string, { interval: string; range: string }> = {
  '1wk': { interval: '1wk', range: '2y'  },
  '1d':  { interval: '1d',  range: '2y'  },
  '4h':  { interval: '60m', range: '60d' },
  '1h':  { interval: '60m', range: '30d' },
}

function aggregateTo4h(candles: OHLCV[]): OHLCV[] {
  const result: OHLCV[] = []
  for (let i = 0; i + 3 < candles.length; i += 4) {
    const g = candles.slice(i, i + 4)
    result.push({
      open:   g[0].open,
      high:   Math.max(...g.map(c => c.high)),
      low:    Math.min(...g.map(c => c.low)),
      close:  g[g.length - 1].close,
      volume: g.reduce((s, c) => s + c.volume, 0),
    })
  }
  return result
}

async function fetchCandlesYahoo(asset: string, timeframe: string): Promise<OHLCV[]> {
  const symbol              = YAHOO_SYMBOL[asset]
  const { interval, range } = YAHOO_TF[timeframe]

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    next: { revalidate: 0 },
  })
  const json = await res.json()
  const result = json?.chart?.result?.[0]
  if (!result) throw new Error(`Yahoo Finance error for ${asset} ${timeframe}`)

  const timestamps: number[] = result.timestamp ?? []
  const q = result.indicators.quote[0]

  const candles: OHLCV[] = timestamps
    .map((_, i) => ({
      open:   parseFloat(q.open?.[i]   ?? 0),
      high:   parseFloat(q.high?.[i]   ?? 0),
      low:    parseFloat(q.low?.[i]    ?? 0),
      close:  parseFloat(q.close?.[i]  ?? 0),
      volume: parseFloat(q.volume?.[i] ?? 0),
    }))
    .filter(c => c.close > 0)

  return timeframe === '4h' ? aggregateTo4h(candles) : candles
}

// ─── Unified candle fetch ─────────────────────────────────────────────────────
export async function fetchCandles(asset: string, timeframe: string): Promise<OHLCV[]> {
  if (HL_SYMBOL[asset])    return fetchCandlesHL(asset, timeframe)
  if (YAHOO_SYMBOL[asset]) return fetchCandlesYahoo(asset, timeframe)
  throw new Error(`Unknown asset: ${asset}`)
}

// ─── Live price ───────────────────────────────────────────────────────────────
export async function fetchLivePrice(asset: string): Promise<number> {
  // HyperLiquid — 8 ativos (crypto + GOLD/PAXG) via allMids (1 req para todos)
  if (HL_SYMBOL[asset]) {
    try {
      const res = await fetch('https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'allMids' }),
        next: { revalidate: 30 },
      })
      const mids: Record<string, string> = await res.json()
      const coin = HL_SYMBOL[asset]
      return mids[coin] ? parseFloat(mids[coin]) : 0
    } catch {
      return 0
    }
  }

  // Yahoo Finance — OIL, SP500, MSTR
  if (YAHOO_SYMBOL[asset]) {
    try {
      const symbol = YAHOO_SYMBOL[asset]
      const res    = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`,
        { headers: { 'User-Agent': 'Mozilla/5.0' }, next: { revalidate: 60 } }
      )
      const json   = await res.json()
      const closes = (json?.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? []) as (number | null)[]
      const valid  = closes.filter((v): v is number => v != null)
      return valid[valid.length - 1] ?? 0
    } catch {
      return 0
    }
  }

  return 0
}

// ─── Funding rate via Bybit (crypto perpetuals) — free, no key ───────────────
const BYBIT_FUNDING_SYMBOL: Record<string, string> = {
  BTC:  'BTCUSDT',
  ETH:  'ETHUSDT',
  SOL:  'SOLUSDT',
  HYPE: 'HYPEUSDT',
  AAVE: 'AAVEUSDT',
  LINK: 'LINKUSDT',
  AVAX: 'AVAXUSDT',
}

export async function fetchFundingRate(asset: string): Promise<number | null> {
  const symbol = BYBIT_FUNDING_SYMBOL[asset]
  if (!symbol) return null
  try {
    const res  = await fetch(
      `https://api.bybit.com/v5/market/tickers?category=linear&symbol=${symbol}`,
      { next: { revalidate: 300 } }
    )
    const json = await res.json()
    const item = json?.result?.list?.[0]
    return item?.fundingRate ? parseFloat(item.fundingRate) : null
  } catch {
    return null
  }
}

// ─── Fear & Greed Index (alternative.me — free, no key) ──────────────────────
export async function fetchFearAndGreed(): Promise<{ value: number; label: string } | null> {
  try {
    const res  = await fetch('https://api.alternative.me/fng/?limit=1', { next: { revalidate: 3600 } })
    const json = await res.json()
    const item = json?.data?.[0]
    if (!item) return null
    return { value: parseInt(item.value), label: item.value_classification }
  } catch {
    return null
  }
}
