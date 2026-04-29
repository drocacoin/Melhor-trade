import { OHLCV } from './indicators'

// Timeout padrão para todas as chamadas externas — evita travamentos
const FETCH_TIMEOUT = 12_000  // 12 segundos

// Promise.race garante timeout mesmo se AbortSignal não funcionar no ambiente
function fetchWithTimeout(url: string, opts: RequestInit = {}): Promise<Response> {
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`fetch timeout: ${url.slice(0, 60)}`)), FETCH_TIMEOUT)
  )
  return Promise.race([fetch(url, opts), timeoutPromise])
}

// ─── HyperLiquid DEX — free, no key, POST API ────────────────────────────────
const HL_SYMBOL: Record<string, string> = {
  BTC:  'BTC',
  ETH:  'ETH',
  SOL:  'SOL',
  HYPE: 'HYPE',
  AAVE: 'AAVE',
  LINK: 'LINK',
  AVAX: 'AVAX',
  GOLD: 'PAXG',
  XRP:  'XRP',
  SUI:  'SUI',
  DOGE: 'DOGE',
  TAO:  'TAO',
}

const HL_INTERVAL: Record<string, string> = {
  '1wk': '1w', '1d': '1d', '4h': '4h', '1h': '1h',
}

const HL_LOOKBACK: Record<string, number> = {
  '1wk': 2 * 365 * 24 * 3600 * 1000,
  '1d':  2 * 365 * 24 * 3600 * 1000,
  '4h':  60 * 24 * 3600 * 1000,
  '1h':  30 * 24 * 3600 * 1000,
}

async function fetchCandlesHL(asset: string, timeframe: string): Promise<OHLCV[]> {
  const coin      = HL_SYMBOL[asset]
  const interval  = HL_INTERVAL[timeframe]
  const now       = Date.now()
  const startTime = now - HL_LOOKBACK[timeframe]

  const res = await fetchWithTimeout('https://api.hyperliquid.xyz/info', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ type: 'candleSnapshot', req: { coin, interval, startTime, endTime: now } }),
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

// ─── Helpers ─────────────────────────────────────────────────────────────────
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

// ─── Yahoo Finance — OIL (BZ=F), SP500 (SPY), MSTR ──────────────────────────
// query2 funciona de servidores — query1 bloqueia IPs de cloud.
const YAHOO_SYMBOL: Record<string, string> = {
  OIL:   'BZ=F',
  SP500: 'SPY',
  MSTR:  'MSTR',
}

const YAHOO_TF: Record<string, { interval: string; range: string }> = {
  '1wk': { interval: '1wk', range: '2y'  },
  '1d':  { interval: '1d',  range: '2y'  },
  '4h':  { interval: '60m', range: '60d' },
  '1h':  { interval: '60m', range: '30d' },
}

const YAHOO_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept':     'application/json',
}

async function fetchCandlesYahoo(asset: string, timeframe: string): Promise<OHLCV[]> {
  const symbol              = YAHOO_SYMBOL[asset]
  const { interval, range } = YAHOO_TF[timeframe]

  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`
  const res = await fetchWithTimeout(url, { headers: YAHOO_HEADERS })
  const json   = await res.json()
  const result = json?.chart?.result?.[0]
  if (!result) throw new Error(`Yahoo Finance error for ${asset} ${timeframe}: ${JSON.stringify(json?.chart?.error)}`)

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
  if (HL_SYMBOL[asset]) {
    try {
      const res  = await fetchWithTimeout('https://api.hyperliquid.xyz/info', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ type: 'allMids' }),
      })
      const mids: Record<string, string> = await res.json()
      return mids[HL_SYMBOL[asset]] ? parseFloat(mids[HL_SYMBOL[asset]]) : 0
    } catch { return 0 }
  }

  if (YAHOO_SYMBOL[asset]) {
    try {
      const res = await fetchWithTimeout(
        `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(YAHOO_SYMBOL[asset])}?interval=1d&range=5d`,
        { headers: YAHOO_HEADERS }
      )
      const json   = await res.json()
      const closes = (json?.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? []) as (number | null)[]
      const valid  = closes.filter((v): v is number => v != null)
      return valid.length ? Math.round((valid[valid.length - 1]) * 100) / 100 : 0
    } catch { return 0 }
  }

  return 0
}

// ─── Funding rate via Bybit ───────────────────────────────────────────────────
const BYBIT_FUNDING_SYMBOL: Record<string, string> = {
  BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT', HYPE: 'HYPEUSDT',
  AAVE: 'AAVEUSDT', LINK: 'LINKUSDT', AVAX: 'AVAXUSDT',
  XRP: 'XRPUSDT', SUI: 'SUIUSDT', DOGE: 'DOGEUSDT', TAO: 'TAOUSDT',
}

export async function fetchFundingRate(asset: string): Promise<number | null> {
  const symbol = BYBIT_FUNDING_SYMBOL[asset]
  if (!symbol) return null
  try {
    const res  = await fetchWithTimeout(
      `https://api.bybit.com/v5/market/tickers?category=linear&symbol=${symbol}`
    )
    const json = await res.json()
    const item = json?.result?.list?.[0]
    return item?.fundingRate ? parseFloat(item.fundingRate) : null
  } catch { return null }
}

// ─── Fear & Greed Index ───────────────────────────────────────────────────────
export async function fetchFearAndGreed(): Promise<{ value: number; label: string } | null> {
  try {
    const res  = await fetchWithTimeout('https://api.alternative.me/fng/?limit=1')
    const json = await res.json()
    const item = json?.data?.[0]
    if (!item) return null
    return { value: parseInt(item.value), label: item.value_classification }
  } catch { return null }
}
