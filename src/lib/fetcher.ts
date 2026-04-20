import { OHLCV } from './indicators'

const TWELVE_KEY = process.env.TWELVE_DATA_API_KEY!

// Binance intervals for crypto (free, no key needed)
const BINANCE_TF: Record<string, string> = {
  '1wk': '1w',
  '1d':  '1d',
  '4h':  '4h',
  '1h':  '1h',
}

const BINANCE_SYMBOL: Record<string, string> = {
  BTC: 'BTCUSDT',
  ETH: 'ETHUSDT',
  SOL: 'SOLUSDT',
}

// Twelve Data symbols (only for GOLD and OIL)
const TWELVE_SYMBOL: Record<string, string> = {
  GOLD: 'XAU/USD',
  OIL:  'BCO/USD',
}

const TWELVE_TF: Record<string, string> = {
  '1wk': '1week',
  '1d':  '1day',
  '4h':  '4h',
  '1h':  '1h',
}

const OUTPUT_SIZE: Record<string, number> = {
  '1wk': 104,
  '1d':  365,
  '4h':  360,
  '1h':  720,
}

async function fetchCandlesBinance(asset: string, timeframe: string): Promise<OHLCV[]> {
  const symbol   = BINANCE_SYMBOL[asset]
  const interval = BINANCE_TF[timeframe]
  const limit    = OUTPUT_SIZE[timeframe] ?? 200

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

async function fetchCandlesTwelve(asset: string, timeframe: string): Promise<OHLCV[]> {
  const symbol     = TWELVE_SYMBOL[asset]
  const interval   = TWELVE_TF[timeframe]
  const outputsize = OUTPUT_SIZE[timeframe] ?? 200

  const url = `https://api.twelvedata.com/time_series?symbol=${symbol}&interval=${interval}&outputsize=${outputsize}&apikey=${TWELVE_KEY}&format=JSON`
  const res  = await fetch(url, { next: { revalidate: 0 } })
  const json = await res.json()

  if (json.status === 'error' || !json.values) {
    throw new Error(`Twelve Data error for ${asset} ${timeframe}: ${json.message ?? 'unknown'}`)
  }

  return (json.values as any[])
    .reverse()
    .map((v: any) => ({
      open:   parseFloat(v.open),
      high:   parseFloat(v.high),
      low:    parseFloat(v.low),
      close:  parseFloat(v.close),
      volume: parseFloat(v.volume ?? '0'),
    }))
}

export async function fetchCandles(asset: string, timeframe: string): Promise<OHLCV[]> {
  if (BINANCE_SYMBOL[asset]) {
    return fetchCandlesBinance(asset, timeframe)
  }
  return fetchCandlesTwelve(asset, timeframe)
}

export async function fetchLivePrice(asset: string): Promise<number> {
  // Crypto: use Binance ticker (free, real-time)
  if (BINANCE_SYMBOL[asset]) {
    const symbol = BINANCE_SYMBOL[asset]
    const res    = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`, { next: { revalidate: 30 } })
    const json   = await res.json()
    return parseFloat(json.price)
  }

  // GOLD/OIL: use Twelve Data
  const symbol = TWELVE_SYMBOL[asset]
  const url    = `https://api.twelvedata.com/price?symbol=${symbol}&apikey=${TWELVE_KEY}`
  const res    = await fetch(url, { next: { revalidate: 30 } })
  const json   = await res.json()
  return parseFloat(json.price)
}

export async function fetchFundingRate(asset: string): Promise<number | null> {
  const symbolMap: Record<string, string> = {
    BTC: 'BTCUSDT',
    ETH: 'ETHUSDT',
    SOL: 'SOLUSDT',
  }
  const symbol = symbolMap[asset]
  if (!symbol) return null
  try {
    const res  = await fetch(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&limit=1`)
    const json = await res.json()
    return parseFloat(json[0]?.fundingRate ?? '0')
  } catch {
    return null
  }
}
