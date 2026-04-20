import { OHLCV } from './indicators'

const TWELVE_KEY = process.env.TWELVE_DATA_API_KEY!

const TF_MAP: Record<string, string> = {
  '1wk': '1week',
  '1d':  '1day',
  '4h':  '4h',
  '1h':  '1h',
}

const SYMBOL_MAP: Record<string, string> = {
  BTC:  'BTC/USD',
  ETH:  'ETH/USD',
  SOL:  'SOL/USD',
  GOLD: 'XAU/USD',
  OIL:  'BCO/USD',
}

const OUTPUT_SIZE: Record<string, number> = {
  '1wk': 104,
  '1d':  365,
  '4h':  360,
  '1h':  720,
}

export async function fetchCandles(asset: string, timeframe: string): Promise<OHLCV[]> {
  const symbol    = SYMBOL_MAP[asset]
  const interval  = TF_MAP[timeframe]
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

export async function fetchLivePrice(asset: string): Promise<number> {
  const symbol = SYMBOL_MAP[asset]
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
