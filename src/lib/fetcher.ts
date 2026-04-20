import { OHLCV } from './indicators'

// ─── Kraken (BTC, ETH, SOL) — free, no key, no geo restrictions ─────────────
const KRAKEN_PAIR: Record<string, string> = {
  BTC: 'XBTUSD',
  ETH: 'ETHUSD',
  SOL: 'SOLUSD',
}

const KRAKEN_INTERVAL: Record<string, number> = {
  '1wk': 10080,
  '1d':  1440,
  '4h':  240,
  '1h':  60,
}

async function fetchCandlesKraken(asset: string, timeframe: string): Promise<OHLCV[]> {
  const pair     = KRAKEN_PAIR[asset]
  const interval = KRAKEN_INTERVAL[timeframe]

  const url  = `https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=${interval}`
  const res  = await fetch(url, { next: { revalidate: 0 } })
  const json = await res.json()

  if (json.error?.length) {
    throw new Error(`Kraken error for ${asset} ${timeframe}: ${json.error.join(', ')}`)
  }

  // Result key varies (e.g. XXBTZUSD) — just take first key that isn't 'last'
  const resultKey = Object.keys(json.result).find(k => k !== 'last')!
  const rows: any[][] = json.result[resultKey]

  // [time, open, high, low, close, vwap, volume, count]
  return rows.map(r => ({
    open:   parseFloat(r[1]),
    high:   parseFloat(r[2]),
    low:    parseFloat(r[3]),
    close:  parseFloat(r[4]),
    volume: parseFloat(r[6]),
  }))
}

// ─── Yahoo Finance (GOLD via GC=F, OIL via BZ=F) — free, no key ─────────────
const YAHOO_SYMBOL: Record<string, string> = {
  GOLD: 'GC=F',
  OIL:  'BZ=F',
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
  const symbol            = YAHOO_SYMBOL[asset]
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

// ─── Unified fetch ────────────────────────────────────────────────────────────
export async function fetchCandles(asset: string, timeframe: string): Promise<OHLCV[]> {
  if (KRAKEN_PAIR[asset])   return fetchCandlesKraken(asset, timeframe)
  if (YAHOO_SYMBOL[asset])  return fetchCandlesYahoo(asset, timeframe)
  throw new Error(`Unknown asset: ${asset}`)
}

// ─── Live price ───────────────────────────────────────────────────────────────
export async function fetchLivePrice(asset: string): Promise<number> {
  if (KRAKEN_PAIR[asset]) {
    const pair = KRAKEN_PAIR[asset]
    const res  = await fetch(`https://api.kraken.com/0/public/Ticker?pair=${pair}`, { next: { revalidate: 30 } })
    const json = await res.json()
    const key  = Object.keys(json.result)[0]
    return parseFloat(json.result[key]?.c?.[0] ?? '0')
  }

  if (YAHOO_SYMBOL[asset]) {
    const symbol = YAHOO_SYMBOL[asset]
    const res    = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, next: { revalidate: 60 } }
    )
    const json   = await res.json()
    const closes = json?.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? []
    return closes.filter(Boolean).at(-1) ?? 0
  }

  return 0
}

// ─── Funding rate (crypto — Kraken perpetuals not available, skip) ────────────
export async function fetchFundingRate(_asset: string): Promise<number | null> {
  return null
}
