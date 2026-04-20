export interface OHLCV {
  open: number; high: number; low: number; close: number; volume: number
}

export interface IndicatorSnapshot {
  close: number
  ema200: number
  bb_upper: number; bb_mid: number; bb_lower: number
  cloud_top: number; cloud_bottom: number
  tenkan: number; kijun: number
  wt1: number; wt2: number
  wt_cross_up: boolean; wt_cross_down: boolean
  wt_zone: 'overbought' | 'oversold' | 'neutral'
  price_vs_ema: 'above' | 'below'
  price_vs_cloud: 'above' | 'below' | 'inside'
  tenkan_vs_kijun: 'above' | 'below'
  last_swing_high: number | null
  last_swing_low: number | null
  bos_up: boolean; bos_down: boolean
  bias: 'ALTISTA' | 'BAIXISTA' | 'NEUTRO/MISTO'
  bull_pts: number; bear_pts: number
}

function ema(values: number[], span: number): number[] {
  const k = 2 / (span + 1)
  const result: number[] = []
  let prev = values[0]
  for (const v of values) {
    prev = v * k + prev * (1 - k)
    result.push(prev)
  }
  return result
}

function rollingMax(values: number[], n: number): number[] {
  return values.map((_, i) => {
    const slice = values.slice(Math.max(0, i - n + 1), i + 1)
    return Math.max(...slice)
  })
}

function rollingMin(values: number[], n: number): number[] {
  return values.map((_, i) => {
    const slice = values.slice(Math.max(0, i - n + 1), i + 1)
    return Math.min(...slice)
  })
}

function rollingMean(values: number[], n: number): number[] {
  return values.map((_, i) => {
    const slice = values.slice(Math.max(0, i - n + 1), i + 1)
    return slice.reduce((a, b) => a + b, 0) / slice.length
  })
}

function rollingStd(values: number[], n: number): number[] {
  return values.map((_, i) => {
    const slice = values.slice(Math.max(0, i - n + 1), i + 1)
    const m = slice.reduce((a, b) => a + b, 0) / slice.length
    const variance = slice.reduce((a, b) => a + (b - m) ** 2, 0) / slice.length
    return Math.sqrt(variance)
  })
}

export function computeSnapshot(candles: OHLCV[]): IndicatorSnapshot {
  const closes = candles.map(c => c.close)
  const highs  = candles.map(c => c.high)
  const lows   = candles.map(c => c.low)
  const n      = closes.length
  const last   = n - 1

  // EMA 200
  const ema200arr = ema(closes, 200)
  const ema200val = ema200arr[last]

  // Bollinger Bands (20, 2)
  const bbMidArr   = rollingMean(closes, 20)
  const bbStdArr   = rollingStd(closes, 20)
  const bb_upper   = bbMidArr[last] + 2 * bbStdArr[last]
  const bb_mid     = bbMidArr[last]
  const bb_lower   = bbMidArr[last] - 2 * bbStdArr[last]

  // Ichimoku
  const tenkanArr  = rollingMax(highs, 9).map((h, i) => (h + rollingMin(lows, 9)[i]) / 2)
  const kijunArr   = rollingMax(highs, 26).map((h, i) => (h + rollingMin(lows, 26)[i]) / 2)
  const spanA      = tenkanArr.map((t, i) => (t + kijunArr[i]) / 2)
  const spanBHigh  = rollingMax(highs, 52)
  const spanBLow   = rollingMin(lows, 52)
  const spanBArr   = spanBHigh.map((h, i) => (h + spanBLow[i]) / 2)

  const spanANow   = spanA[Math.max(0, last - 26)]
  const spanBNow   = spanBArr[Math.max(0, last - 26)]
  const cloud_top    = Math.max(spanANow, spanBNow)
  const cloud_bottom = Math.min(spanANow, spanBNow)

  // WaveTrend (10, 21)
  const hlc3 = candles.map(c => (c.high + c.low + c.close) / 3)
  const esaArr = ema(hlc3, 10)
  const dArr   = ema(hlc3.map((v, i) => Math.abs(v - esaArr[i])), 10)
  const ciArr  = hlc3.map((v, i) => (v - esaArr[i]) / (0.015 * (dArr[i] || 1)))
  const wt1Arr = ema(ciArr, 21)
  const wt2Arr = rollingMean(wt1Arr, 4)
  const wt1    = wt1Arr[last]
  const wt2    = wt2Arr[last]
  const wt_cross_up   = wt1 > wt2 && wt1Arr[last - 1] <= wt2Arr[last - 1]
  const wt_cross_down = wt1 < wt2 && wt1Arr[last - 1] >= wt2Arr[last - 1]

  // Swing highs/lows (simplified, window=5)
  const close = closes[last]
  let last_swing_high: number | null = null
  let last_swing_low:  number | null = null
  for (let i = n - 6; i >= 5; i--) {
    if (!last_swing_high) {
      const isHigh = highs[i] === Math.max(...highs.slice(i - 5, i + 6))
      if (isHigh) last_swing_high = highs[i]
    }
    if (!last_swing_low) {
      const isLow = lows[i] === Math.min(...lows.slice(i - 5, i + 6))
      if (isLow) last_swing_low = lows[i]
    }
    if (last_swing_high && last_swing_low) break
  }

  const bos_up   = last_swing_high !== null && close > last_swing_high
  const bos_down = last_swing_low  !== null && close < last_swing_low

  // Derived fields
  const price_vs_ema:   'above' | 'below'              = close > ema200val ? 'above' : 'below'
  const price_vs_cloud: 'above' | 'below' | 'inside'   = close > cloud_top ? 'above' : close < cloud_bottom ? 'below' : 'inside'
  const tenkan_vs_kijun: 'above' | 'below'             = tenkanArr[last] > kijunArr[last] ? 'above' : 'below'
  const wt_zone: 'overbought' | 'oversold' | 'neutral' = wt1 > 53 ? 'overbought' : wt1 < -53 ? 'oversold' : 'neutral'

  const bull_pts = [price_vs_ema === 'above', price_vs_cloud === 'above', tenkan_vs_kijun === 'above', wt1 > 0].filter(Boolean).length
  const bear_pts = [price_vs_ema === 'below', price_vs_cloud === 'below', tenkan_vs_kijun === 'below', wt1 < 0].filter(Boolean).length
  const bias = bull_pts >= 3 ? 'ALTISTA' : bear_pts >= 3 ? 'BAIXISTA' : 'NEUTRO/MISTO'

  return {
    close, ema200: ema200val,
    bb_upper, bb_mid, bb_lower,
    cloud_top, cloud_bottom,
    tenkan: tenkanArr[last], kijun: kijunArr[last],
    wt1, wt2, wt_cross_up, wt_cross_down, wt_zone,
    price_vs_ema, price_vs_cloud, tenkan_vs_kijun,
    last_swing_high, last_swing_low, bos_up, bos_down,
    bias, bull_pts, bear_pts,
  }
}
