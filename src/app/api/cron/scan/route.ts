import { NextRequest, NextResponse } from 'next/server'
import { fetchCandles, fetchFundingRate, fetchFearAndGreed, fetchLivePrice } from '@/lib/fetcher'
import { computeSnapshot } from '@/lib/indicators'
import { supabaseAdmin } from '@/lib/supabase'
import { sendTelegram, fmtSignal, fmtScanSummary, fmtStopAlert } from '@/lib/telegram'
import { Asset } from '@/types'

const ASSETS: Asset[] = ['BTC', 'ETH', 'SOL', 'GOLD', 'OIL']
const TIMEFRAMES      = ['1wk', '1d', '4h', '1h']

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export async function GET(req: NextRequest) {
  const secret = req.headers.get('x-cron-secret') ?? req.nextUrl.searchParams.get('secret')
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // send_summary=true → always send Telegram summary (e.g. morning cron)
  const sendSummary = req.nextUrl.searchParams.get('send_summary') === 'true'

  const db = supabaseAdmin()

  // ── Fetch global context in parallel ───────────────────────────────────────
  const [fg, fundings] = await Promise.all([
    fetchFearAndGreed(),
    Promise.all(ASSETS.map(a => fetchFundingRate(a).then(v => [a, v] as [string, number | null]))),
  ])
  const fundingMap = Object.fromEntries(fundings)

  // ── Scan each asset × timeframe ────────────────────────────────────────────
  const results: Record<string, any> = {}
  const biases:  Record<string, string> = {}
  let newSignals = 0

  for (const asset of ASSETS) {
    results[asset] = {}
    const snapshots: Record<string, any> = {}

    for (const tf of TIMEFRAMES) {
      try {
        const candles = await fetchCandles(asset, tf)
        if (candles.length < 60) {
          results[asset][tf] = `only ${candles.length} candles`
        } else {
          const snap = computeSnapshot(candles)
          snapshots[tf] = snap
          results[asset][tf] = { close: snap.close, bias: snap.bias }
          await db.from('snapshots').insert({ asset, timeframe: tf, ...snap })
        }
      } catch (e: any) {
        console.error(`[scan] ${asset} ${tf}:`, e.message)
        results[asset][tf] = `ERROR: ${e.message}`
      }
      await sleep(500)
    }

    // Daily bias for summary
    if (snapshots['1d']?.bias) biases[asset] = snapshots['1d'].bias

    // ── Signal detection ─────────────────────────────────────────────────────
    const signal = detectSignal(asset, snapshots, fg)
    if (signal) {
      const { data } = await db.from('signals').insert(signal).select().single()
      if (data) {
        newSignals++
        const funding = fundingMap[asset] ?? null
        await sendTelegram(fmtSignal(data, fg, funding))
        results[asset].signal = data
      }
    }

    results[asset].funding = fundingMap[asset]
  }

  // ── Stop alerts for open trades ────────────────────────────────────────────
  await checkStopAlerts(db)

  // ── Scan summary (morning cron or on request) ──────────────────────────────
  if (sendSummary || newSignals > 0) {
    const nowBR = new Date().toLocaleString('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    })
    await sendTelegram(fmtScanSummary(biases, fg, fundingMap, newSignals, nowBR))
  }

  return NextResponse.json({
    ok: true,
    scanned_at: new Date().toISOString(),
    fear_greed: fg,
    results,
  })
}

// ─── Signal detection ─────────────────────────────────────────────────────────
function detectSignal(
  asset: Asset,
  snaps: Record<string, any>,
  fg: { value: number; label: string } | null
) {
  const d  = snaps['1d']
  const h4 = snaps['4h']
  if (!d || !h4) return null

  let bullScore = 0
  let bearScore = 0

  // Core signals (4h)
  if (h4.wt_cross_up   && h4.wt_zone === 'oversold')    bullScore += 3
  if (h4.bos_up)                                          bullScore += 2
  if (h4.price_vs_cloud === 'above')                      bullScore += 1
  if (d.bias === 'ALTISTA')                               bullScore += 2
  if (h4.tenkan_vs_kijun === 'above')                     bullScore += 1

  if (h4.wt_cross_down && h4.wt_zone === 'overbought')   bearScore += 3
  if (h4.bos_down)                                        bearScore += 2
  if (h4.price_vs_cloud === 'below')                      bearScore += 1
  if (d.bias === 'BAIXISTA')                              bearScore += 2
  if (h4.tenkan_vs_kijun === 'below')                     bearScore += 1

  // Fear & Greed filter: penalise longs in extreme greed, shorts in extreme fear
  if (fg) {
    if (fg.value >= 80) bullScore -= 1  // mercado sobrecomprado — cautela com longs
    if (fg.value <= 20) bearScore -= 1  // mercado sobrealavancado em short — cautela
  }

  const isLong  = bullScore >= 6
  const isShort = bearScore >= 6
  if (!isLong && !isShort) return null

  const direction   = isLong ? 'long' : 'short'
  const close       = h4.close
  const swing_low   = h4.last_swing_low  ?? close * 0.97
  const swing_high  = h4.last_swing_high ?? close * 1.03

  const stop    = isLong  ? swing_low  * 0.995 : swing_high * 1.005
  const target1 = isLong  ? close * 1.05       : close * 0.95
  const rr1     = Math.abs(close - target1) / Math.abs(close - stop)

  if (rr1 < 2) return null

  const totalScore = isLong ? bullScore : bearScore
  const grade      = totalScore >= 8 ? 'A+' : totalScore >= 6 ? 'A' : 'B'

  const entryLow  = isLong ? close * 0.998 : close * 0.995
  const entryHigh = isLong ? close * 1.002 : close * 1.005

  return {
    asset,
    direction,
    setup_grade: grade,
    macro_score: 0,
    entry_zone_low:  Math.round(entryLow  * 100) / 100,
    entry_zone_high: Math.round(entryHigh * 100) / 100,
    stop:    Math.round(stop    * 100) / 100,
    target1: Math.round(target1 * 100) / 100,
    target2: Math.round((isLong ? close * 1.10 : close * 0.90) * 100) / 100,
    target3: Math.round((isLong ? close * 1.15 : close * 0.85) * 100) / 100,
    rr1:     Math.round(rr1 * 10) / 10,
    trigger: isLong
      ? `Candle 4h fechando acima de $${(entryHigh).toFixed(2)} com WT cruzado para cima`
      : `Candle 4h fechando abaixo de $${(entryLow).toFixed(2)} com WT cruzado para baixo`,
    cancellation: isLong
      ? `Fechamento diário abaixo de $${(swing_low * 0.99).toFixed(2)}`
      : `Fechamento diário acima de $${(swing_high * 1.01).toFixed(2)}`,
    analysis: '',
    status: 'active',
  }
}

// ─── Stop proximity alerts ────────────────────────────────────────────────────
async function checkStopAlerts(db: ReturnType<typeof supabaseAdmin>) {
  const { data: trades } = await db.from('trades').select('*').eq('status', 'open')
  if (!trades?.length) return

  // Fetch live prices for assets that have open trades
  const assets = [...new Set(trades.map((t: any) => t.asset))] as Asset[]
  const prices: Record<string, number> = {}
  await Promise.all(
    assets.map(a => fetchLivePrice(a).then(p => { prices[a] = p }))
  )

  for (const trade of trades) {
    const price = prices[trade.asset]
    if (!price || !trade.stop_loss) continue

    // distance from current price to stop, as % of entry→stop range
    const range    = Math.abs(trade.entry_price - trade.stop_loss)
    const toStop   = Math.abs(price - trade.stop_loss)
    const distPct  = (toStop / range) * 100

    // Alert if within 20% of stop (price covered 80%+ of the entry→stop distance)
    if (distPct <= 20) {
      await sendTelegram(
        fmtStopAlert(trade.asset, trade.direction, price, trade.stop_loss, distPct)
      )
    }
  }
}
