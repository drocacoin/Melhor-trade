import { OHLCV } from './indicators'

// ─── MEXC (crypto + tokenized commodities) — free, no key ────────────────────
// Covers: BTC, ETH, SOL, HYPE, AAVE, LINK, AVAX, GOLD (XAUT), OIL (Brent)
const MEXC_SYMBOL: Record<string, string> = {
  BTC:  'BTCUSDT',
  ETH:  'ETHUSDT',
  SOL:  'SOLUSDT',
  HYPE: 'HYPEUSDT',
  AAVE: 'AAVEUSDT',
  LINK: 'LINKUSDT',
  AVAX: 'AVAXUSDT',
  GOLD: 'GOLD(XAUT)USDT',   // Tether Gold — tokenized gold (MEXC symbol with parens)
  OIL:  'OIL(BRENT)USDT',   // Brent crude futures tokenizado na MEXC
}

const MEXC_INTERVAL: Record<string, string> = {
  '1wk': '1W',
  '1d':  '1d',
  '4h':  '4h',
  '1h':  '60m',
}

async function fetchCandlesMexc(asset: string, timeframe: string): Promise<OHLCV[]> {
  const symbol   = MEXC_SYMBOL[asset]
  const interval = MEXC_INTERVAL[timeframe]
  const limit    = 200

  const url  = `https://api.mexc.com/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`
  const res  = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    next: { revalidate: 0 },
  })
  const json: any[][] = await res.json()

  if (!Array.isArray(json)) throw new Error(`MEXC error for ${asset} ${timeframe}`)

  // [openTime, open, high, low, close, volume, closeTime, quoteVolume, ...]
  return json.map(r => ({
    open:   parseFloat(r[1]),
    high:   parseFloat(r[2]),
    low:    parseFloat(r[3]),
    close:  parseFloat(r[4]),
    volume: parseFloat(r[5]),
  }))
}

// ─── Yahoo Finance (SP500 via SPY, MSTR) — free, no key ──────────────────────
const YAHOO_SYMBOL: Record<string, string> = {
  SP500: 'SPY',   // S&P 500 ETF — full OHLCV data
  MSTR:  'MSTR',  // MicroStrategy — BTC-leveraged equity
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
  if (MEXC_SYMBOL[asset])  return fetchCandlesMexc(asset, timeframe)
  if (YAHOO_SYMBOL[asset]) return fetchCandlesYahoo(asset, timeframe)
  throw new Error(`Unknown asset: ${asset}`)
}

// ─── Live price ───────────────────────────────────────────────────────────────
export async function fetchLivePrice(asset: string): Promise<number> {
  // MEXC — crypto + tokenized commodities
  if (MEXC_SYMBOL[asset]) {
    const symbol = MEXC_SYMBOL[asset]
    try {
      const res  = await fetch(
        `https://api.mexc.com/api/v3/ticker/price?symbol=${encodeURIComponent(symbol)}`,
        { headers: { 'User-Agent': 'Mozilla/5.0' }, next: { revalidate: 30 } }
      )
      const json = await res.json()
      return json?.price ? parseFloat(json.price) : 0
    } catch {
      return 0
    }
  }

  // Yahoo Finance — equities (SP500, MSTR)
  if (YAHOO_SYMBOL[asset]) {
    const symbol = YAHOO_SYMBOL[asset]
    try {
      const res  = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`,
        { headers: { 'User-Agent': 'Mozilla/5.0' }, next: { revalidate: 60 } }
      )
      const json   = await res.json()
      const closes = json?.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? []
      const validCloses = (closes as (number | null)[]).filter((v): v is number => v != null)
      return validCloses[validCloses.length - 1] ?? 0
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
