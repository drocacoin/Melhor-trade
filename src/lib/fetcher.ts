import { OHLCV } from './indicators'

// ─── HyperLiquid DEX — free, no key, POST API ─────────────────────────────────
// Single source for all 8 assets: BTC ETH SOL HYPE AAVE LINK AVAX GOLD(PAXG)
const HL_SYMBOL: Record<string, string> = {
  BTC:  'BTC',
  ETH:  'ETH',
  SOL:  'SOL',
  HYPE: 'HYPE',
  AAVE: 'AAVE',
  LINK: 'LINK',
  AVAX: 'AVAX',
  GOLD: 'PAXG',  // PAX Gold — 1 PAXG = 1 troy oz of gold, tracks spot gold price
}

const HL_INTERVAL: Record<string, string> = {
  '1wk': '1w',
  '1d':  '1d',
  '4h':  '4h',
  '1h':  '1h',
}

const HL_LOOKBACK: Record<string, number> = {
  '1wk': 2 * 365 * 24 * 3600 * 1000,   // 2 years
  '1d':  2 * 365 * 24 * 3600 * 1000,   // 2 years
  '4h':  60  * 24 * 3600 * 1000,       // 60 days
  '1h':  30  * 24 * 3600 * 1000,       // 30 days
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

  // Fields: o (open), h (high), l (low), c (close), v (volume) — all strings
  return json.map(r => ({
    open:   parseFloat(r.o),
    high:   parseFloat(r.h),
    low:    parseFloat(r.l),
    close:  parseFloat(r.c),
    volume: parseFloat(r.v),
  }))
}

// ─── Unified candle fetch ─────────────────────────────────────────────────────
export async function fetchCandles(asset: string, timeframe: string): Promise<OHLCV[]> {
  if (HL_SYMBOL[asset]) return fetchCandlesHL(asset, timeframe)
  throw new Error(`Unknown asset: ${asset}`)
}

// ─── Live price ───────────────────────────────────────────────────────────────
export async function fetchLivePrice(asset: string): Promise<number> {
  if (!HL_SYMBOL[asset]) return 0
  try {
    const coin = HL_SYMBOL[asset]
    const res  = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'allMids' }),
      next: { revalidate: 30 },
    })
    const mids: Record<string, string> = await res.json()
    return mids[coin] ? parseFloat(mids[coin]) : 0
  } catch {
    return 0
  }
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
