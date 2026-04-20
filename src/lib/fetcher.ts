import { OHLCV } from './indicators'

// ─── Binance (BTC, ETH, SOL) ────────────────────────────────────────────────
const BINANCE_SYMBOL: Record<string, string> = {
  BTC: 'BTCUSDT',
  ETH: 'ETHUSDT',
  SOL: 'SOLUSDT',
}

const BINANCE_TF: Record<string, string> = {
  '1wk': '1w',
  '1d':  '1d',
  '4h':  '4h',
  '1h':  '1h',
}

const BINANCE_LIMIT: Record<string, number> = {
  '1wk': 104,
  '1d':  365,
  '4h':  360,
  '1h':  500,
}

async function fetchCandlesBinance(asset: string, timeframe: string): Promise<OHLCV[]> {
  const symbol   = BINANCE_SYMBOL[asset]
  const interval = BINANCE_TF[timeframe]
  const limit    = BINANCE_LIMIT[timeframe] ?? 200

  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`
  const res  = await fetch(url, { next: { revalidate: 0 } })
  const json = await res.json()

  if (!Array.isArray(json)) {
    throw new Error(`Binance error for ${asset} ${timeframe}: ${JSON.stringify(json)}`)
  }

  return json.map((k: any[]) => ({
    open:   parseFloat(k[1]),
    high:   parseFloat(k[2]),
    low:    parseFloat(k[3]),
    close:  parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }))
}

// ─── Alpha Vantage (GOLD via XAU/USD FX) ────────────────────────────────────
const AV_KEY = () => process.env.ALPHA_VANTAGE_KEY!

function parseAVFx(json: any): OHLCV[] {
  const key = Object.keys(json).find(k => k.startsWith('Time Series') || k.startsWith('Weekly') || k.startsWith('Monthly'))
  if (!key) throw new Error(`Alpha Vantage unexpected response: ${JSON.stringify(json).slice(0, 200)}`)
  const series = json[key] as Record<string, any>
  return Object.entries(series)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, v]) => ({
      open:   parseFloat(v['1. open']),
      high:   parseFloat(v['2. high']),
      low:    parseFloat(v['3. low']),
      close:  parseFloat(v['4. close']),
      volume: 0,
    }))
}

function aggregateTo4h(candles1h: OHLCV[]): OHLCV[] {
  const result: OHLCV[] = []
  for (let i = 0; i + 3 < candles1h.length; i += 4) {
    const group = candles1h.slice(i, i + 4)
    result.push({
      open:   group[0].open,
      high:   Math.max(...group.map(c => c.high)),
      low:    Math.min(...group.map(c => c.low)),
      close:  group[group.length - 1].close,
      volume: group.reduce((s, c) => s + c.volume, 0),
    })
  }
  return result
}

async function fetchGoldAlphaVantage(timeframe: string): Promise<OHLCV[]> {
  const key = AV_KEY()

  if (timeframe === '1wk') {
    const url = `https://www.alphavantage.co/query?function=FX_WEEKLY&from_symbol=XAU&to_symbol=USD&apikey=${key}`
    const json = await fetch(url, { next: { revalidate: 0 } }).then(r => r.json())
    return parseAVFx(json)
  }

  if (timeframe === '1d') {
    const url = `https://www.alphavantage.co/query?function=FX_DAILY&from_symbol=XAU&to_symbol=USD&outputsize=full&apikey=${key}`
    const json = await fetch(url, { next: { revalidate: 0 } }).then(r => r.json())
    return parseAVFx(json)
  }

  // 4h e 1h: busca 60min e agrega se necessário
  const url = `https://www.alphavantage.co/query?function=FX_INTRADAY&from_symbol=XAU&to_symbol=USD&interval=60min&outputsize=full&apikey=${key}`
  const json = await fetch(url, { next: { revalidate: 0 } }).then(r => r.json())
  const candles1h = parseAVFx(json)
  return timeframe === '4h' ? aggregateTo4h(candles1h) : candles1h
}

// ─── Yahoo Finance (OIL via BZ=F) ───────────────────────────────────────────
const YAHOO_OIL_TF: Record<string, { interval: string; range: string }> = {
  '1wk': { interval: '1wk', range: '2y'  },
  '1d':  { interval: '1d',  range: '2y'  },
  '4h':  { interval: '60m', range: '60d' },
  '1h':  { interval: '60m', range: '30d' },
}

async function fetchOilYahoo(timeframe: string): Promise<OHLCV[]> {
  const { interval, range } = YAHOO_OIL_TF[timeframe]
  const url  = `https://query1.finance.yahoo.com/v8/finance/chart/BZ=F?interval=${interval}&range=${range}`
  const res  = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    next: { revalidate: 0 },
  })
  const json = await res.json()

  const result = json?.chart?.result?.[0]
  if (!result) throw new Error(`Yahoo Finance error for OIL ${timeframe}`)

  const timestamps: number[]  = result.timestamp ?? []
  const quote = result.indicators.quote[0]

  const candles: OHLCV[] = timestamps
    .map((_, i) => ({
      open:   parseFloat(quote.open?.[i]  ?? 0),
      high:   parseFloat(quote.high?.[i]  ?? 0),
      low:    parseFloat(quote.low?.[i]   ?? 0),
      close:  parseFloat(quote.close?.[i] ?? 0),
      volume: parseFloat(quote.volume?.[i] ?? 0),
    }))
    .filter(c => c.close > 0)

  return timeframe === '4h' ? aggregateTo4h(candles) : candles
}

// ─── Unified fetch ───────────────────────────────────────────────────────────
export async function fetchCandles(asset: string, timeframe: string): Promise<OHLCV[]> {
  if (BINANCE_SYMBOL[asset]) return fetchCandlesBinance(asset, timeframe)
  if (asset === 'GOLD')       return fetchGoldAlphaVantage(timeframe)
  if (asset === 'OIL')        return fetchOilYahoo(timeframe)
  throw new Error(`Unknown asset: ${asset}`)
}

// ─── Live price ──────────────────────────────────────────────────────────────
export async function fetchLivePrice(asset: string): Promise<number> {
  if (BINANCE_SYMBOL[asset]) {
    const res  = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${BINANCE_SYMBOL[asset]}`, { next: { revalidate: 30 } })
    const json = await res.json()
    return parseFloat(json.price)
  }

  if (asset === 'GOLD') {
    const url  = `https://www.alphavantage.co/query?function=CURRENCY_EXCHANGE_RATE&from_currency=XAU&to_currency=USD&apikey=${AV_KEY()}`
    const res  = await fetch(url, { next: { revalidate: 60 } })
    const json = await res.json()
    return parseFloat(json['Realtime Currency Exchange Rate']?.['5. Exchange Rate'] ?? '0')
  }

  if (asset === 'OIL') {
    const res  = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/BZ=F?interval=1d&range=5d', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      next: { revalidate: 60 },
    })
    const json = await res.json()
    const closes = json?.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? []
    return closes.filter(Boolean).at(-1) ?? 0
  }

  return 0
}

// ─── Funding rate (crypto only, Binance) ─────────────────────────────────────
export async function fetchFundingRate(asset: string): Promise<number | null> {
  const symbol = BINANCE_SYMBOL[asset] ? `${BINANCE_SYMBOL[asset].replace('USDT', '')}USDT` : null
  if (!symbol) return null
  try {
    const res  = await fetch(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&limit=1`)
    const json = await res.json()
    return parseFloat(json[0]?.fundingRate ?? '0')
  } catch {
    return null
  }
}
