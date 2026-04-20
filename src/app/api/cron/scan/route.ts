import { NextRequest, NextResponse } from 'next/server'
import { fetchCandles, fetchFundingRate } from '@/lib/fetcher'
import { computeSnapshot } from '@/lib/indicators'
import { supabaseAdmin } from '@/lib/supabase'
import { Asset } from '@/types'

const ASSETS: Asset[] = ['BTC', 'ETH', 'SOL', 'GOLD', 'OIL']
const TIMEFRAMES = ['1wk', '1d', '4h', '1h']

export async function GET(req: NextRequest) {
  const secret = req.headers.get('x-cron-secret') ?? req.nextUrl.searchParams.get('secret')
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const db = supabaseAdmin()
  const results: Record<string, any> = {}

  for (const asset of ASSETS) {
    results[asset] = {}
    const snapshots: Record<string, any> = {}

    for (const tf of TIMEFRAMES) {
      try {
        const candles = await fetchCandles(asset, tf)
        if (candles.length < 60) {
          results[asset][tf] = `only ${candles.length} candles`
          continue
        }
        const snap = computeSnapshot(candles)
        snapshots[tf] = snap
        results[asset][tf] = { close: snap.close, bias: snap.bias }

        await db.from('snapshots').insert({
          asset,
          timeframe: tf,
          ...snap,
        })
      } catch (e: any) {
        console.error(`[scan] ${asset} ${tf}:`, e.message)
        results[asset][tf] = `ERROR: ${e.message}`
      }
    }

    // Detectar gatilhos
    const signal = detectSignal(asset, snapshots)
    if (signal) {
      const { data } = await db.from('signals').insert(signal).select().single()
      if (data) {
        await notifyTelegram(data)
        results[asset].signal = data
      }
    }

    // Funding rate para crypto
    const funding = await fetchFundingRate(asset)
    if (funding !== null) results[asset].funding = funding
  }

  return NextResponse.json({ ok: true, scanned_at: new Date().toISOString(), results })
}

function detectSignal(asset: Asset, snaps: Record<string, any>) {
  const d = snaps['1d']
  const h4 = snaps['4h']
  if (!d || !h4) return null

  let bullScore = 0
  let bearScore = 0

  // Long signals
  if (h4.wt_cross_up && h4.wt_zone === 'oversold')   bullScore += 3
  if (h4.bos_up)                                       bullScore += 2
  if (h4.price_vs_cloud === 'above')                   bullScore += 1
  if (d.bias === 'ALTISTA')                            bullScore += 2
  if (h4.tenkan_vs_kijun === 'above')                  bullScore += 1

  // Short signals
  if (h4.wt_cross_down && h4.wt_zone === 'overbought') bearScore += 3
  if (h4.bos_down)                                      bearScore += 2
  if (h4.price_vs_cloud === 'below')                    bearScore += 1
  if (d.bias === 'BAIXISTA')                            bearScore += 2
  if (h4.tenkan_vs_kijun === 'below')                   bearScore += 1

  const isLong  = bullScore >= 6
  const isShort = bearScore >= 6

  if (!isLong && !isShort) return null

  const direction = isLong ? 'long' : 'short'
  const close     = h4.close
  const swing_low  = h4.last_swing_low  ?? close * 0.97
  const swing_high = h4.last_swing_high ?? close * 1.03

  const stop    = isLong  ? swing_low  * 0.995 : swing_high * 1.005
  const target1 = isLong  ? close * 1.05       : close * 0.95
  const rr1     = Math.abs(close - target1) / Math.abs(close - stop)

  if (rr1 < 2) return null

  const totalScore = isLong ? bullScore : bearScore
  const grade = totalScore >= 8 ? 'A+' : totalScore >= 6 ? 'A' : 'B'

  return {
    asset,
    direction,
    setup_grade: grade,
    macro_score: 0,
    entry_zone_low:  isLong ? close * 0.998 : close * 0.995,
    entry_zone_high: isLong ? close * 1.002 : close * 1.005,
    stop:    Math.round(stop    * 100) / 100,
    target1: Math.round(target1 * 100) / 100,
    target2: Math.round((isLong ? close * 1.10 : close * 0.90) * 100) / 100,
    target3: Math.round((isLong ? close * 1.15 : close * 0.85) * 100) / 100,
    rr1:     Math.round(rr1 * 10) / 10,
    trigger: isLong
      ? `Candle 4h fechando acima de ${(close * 1.002).toFixed(2)} com WT_LB cruzado para cima`
      : `Candle 4h fechando abaixo de ${(close * 0.998).toFixed(2)} com WT_LB cruzado para baixo`,
    cancellation: isLong
      ? `Fechamento diário abaixo de ${(swing_low * 0.99).toFixed(2)}`
      : `Fechamento diário acima de ${(swing_high * 1.01).toFixed(2)}`,
    analysis: '',
    status: 'active',
  }
}

async function notifyTelegram(signal: any) {
  const token  = process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_CHAT_ID
  if (!token || !chatId) return

  const emoji = signal.direction === 'long' ? '🟢' : '🔴'
  const msg = [
    `${emoji} *SINAL ${signal.setup_grade} — ${signal.asset}*`,
    `Direção: ${signal.direction.toUpperCase()}`,
    `Entrada: $${signal.entry_zone_low} – $${signal.entry_zone_high}`,
    `Stop: $${signal.stop}`,
    `Alvo 1: $${signal.target1} (RR ${signal.rr1}:1)`,
    `Gatilho: ${signal.trigger}`,
  ].join('\n')

  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: msg, parse_mode: 'Markdown' }),
  })
}
