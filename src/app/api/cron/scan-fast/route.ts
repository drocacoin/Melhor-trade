/**
 * GET /api/cron/scan-fast
 *
 * Scan rápido — roda a cada 30 min via Vercel cron.
 * Varre apenas os ativos crypto via HyperLiquid (sem Yahoo Finance).
 * Busca candles 1h + 4h e complementa com 1d/1wk do banco (último snapshot).
 * Cruza score técnico + notícias RSS + baleias para emitir 3 tipos de alerta:
 *
 *  🚨 SINAL      — score ≥ threshold (sinal novo, sem sinal ativo no ativo)
 *  👁 FORMANDO   — score dentro de 1.5 pts do threshold + notícia ou baleia confirma
 *  ⚡ NEWS FLASH — notícia forte com setup técnico parcial (antecipação)
 *
 * NÃO grava sinais no banco — apenas alerta. O scan completo (4h) persiste.
 */

import { NextRequest, NextResponse } from 'next/server'
import { fetchCandles, fetchFearAndGreed, fetchFundingRate, fetchOpenInterestAll } from '@/lib/fetcher'
import { fetchWhaleSentiment } from '@/lib/whales'
import { fetchNewsSentiment } from '@/lib/news'
import { computeSnapshot, computeSignalFactors, SignalFactors } from '@/lib/indicators'
import { computeThreshold } from '@/lib/threshold'
import { supabaseAdmin } from '@/lib/supabase'
import { sendTelegram } from '@/lib/telegram'
import { checkStopAlerts } from '@/lib/stop-monitor'
import { evaluateCircuitBreaker } from '@/lib/circuit-breaker'
import { Asset } from '@/types'

export const maxDuration = 120

// Apenas HL (rápido). Yahoo Finance (OIL, SP500) fica no scan completo.
const FAST_ASSETS: Asset[] = [
  'BTC', 'ETH', 'SOL', 'HYPE', 'AAVE', 'LINK', 'AVAX', 'XRP', 'SUI', 'DOGE', 'TAO',
]

// Pesos padrão — evita 11 queries ao banco no scan rápido
const W = {
  wt_cross_oversold:   3,
  bos_up:              2,
  price_vs_cloud:      1,
  tenkan_vs_kijun:     1,
  daily_bias:          2,
  weekly_bias:         1,
  wt_cross_overbought: 3,
  bos_down:            2,
}

export async function GET(req: NextRequest) {
  const secret =
    req.headers.get('authorization')?.replace('Bearer ', '') ??
    req.nextUrl.searchParams.get('secret')
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const db = supabaseAdmin()
  const startedAt = Date.now()

  // ── 1. Contexto global em paralelo (sem whale — faz no paralelo abaixo) ───
  const [fg, { data: perfRows }, { data: macroRow }, { data: openTrades }, { data: recentClosed }] =
    await Promise.all([
      fetchFearAndGreed().catch(() => null),
      db.from('performance_summary').select('*'),
      db.from('macro_readings').select('*').order('captured_at', { ascending: false }).limit(1),
      db.from('trades').select('*').eq('status', 'open'),
      db.from('trades').select('id,pnl_usd').eq('status', 'closed').order('closed_at', { ascending: false }).limit(10),
    ])

  const macro   = macroRow?.[0] ?? null
  const perfMap = Object.fromEntries((perfRows ?? []).map((p: any) => [p.asset, p]))

  // ── Circuit breaker — bloqueia alertas SINAL se sistema em drawdown ────────
  const cb = evaluateCircuitBreaker(recentClosed ?? [])

  // ── 2. Candles + Funding + OI + Notícias + Baleias em paralelo ──────────
  const [candleResults, fundingResults, oiAll, newsResult, whaleResult] = await Promise.all([
    Promise.allSettled(
      FAST_ASSETS.map(async asset => {
        const [r4h, r1h] = await Promise.allSettled([
          fetchCandles(asset, '4h').then(c => {
            if (c.length < 60) return { snap: null, factors: null }
            const snap = computeSnapshot(c)
            return { snap, factors: computeSignalFactors(c, snap) }
          }).catch(() => ({ snap: null, factors: null as SignalFactors | null })),
          fetchCandles(asset, '1h').then(c => c.length >= 60 ? computeSnapshot(c) : null).catch(() => null),
        ])
        const r4hVal = r4h.status === 'fulfilled' ? r4h.value : { snap: null, factors: null }
        return {
          asset,
          snap4h:    r4hVal.snap,
          factors4h: r4hVal.factors,
          snap1h:    r1h.status === 'fulfilled' ? r1h.value : null,
        }
      })
    ),
    Promise.all(FAST_ASSETS.map(a => fetchFundingRate(a).then(v => [a, v] as [string, number | null]).catch(() => [a, null] as [string, null]))),
    fetchOpenInterestAll().catch(() => ({})),
    fetchNewsSentiment().catch(() => ({ items: [], byAsset: {} as Record<string, any>, total: 0, fetchedAt: '', sources: [] as string[] })),
    fetchWhaleSentiment().catch(() => null),
  ])

  const fundingMap = Object.fromEntries(fundingResults)

  const news     = newsResult.byAsset
  const whaleMap: Record<string, any> = {}
  if (whaleResult?.sentiment) {
    for (const s of whaleResult.sentiment) whaleMap[s.asset] = s
  }

  // ── 3. Último snapshot 1d + 1wk do banco (complemento) ────────────────────
  const { data: latestSnaps } = await db
    .from('snapshots')
    .select('*')
    .in('asset', FAST_ASSETS)
    .in('timeframe', ['1d', '1wk'])
    .order('captured_at', { ascending: false })
    .limit(FAST_ASSETS.length * 4)

  const seenSnap = new Set<string>()
  const snapDB: Record<string, Record<string, any>> = {}
  for (const s of latestSnaps ?? []) {
    const k = `${s.asset}-${s.timeframe}`
    if (seenSnap.has(k)) continue
    seenSnap.add(k)
    if (!snapDB[s.asset]) snapDB[s.asset] = {}
    snapDB[s.asset][s.timeframe] = s
  }

  // ── 4. Sinais ativos recentes (para não duplicar alertas) ─────────────────
  const since4h = new Date(Date.now() - 4 * 3600 * 1000).toISOString()
  const { data: recentSignals } = await db
    .from('signals')
    .select('asset, direction')
    .eq('status', 'active')
    .gte('detected_at', since4h)

  const alreadyActive = new Set((recentSignals ?? []).map((s: any) => s.asset))

  // ── 5. Análise ativo por ativo ─────────────────────────────────────────────
  type AlertType = { asset: string; dir: string; type: 'signal' | 'forming' | 'news'; score: number; gap: number; text: string }
  const alertBucket: AlertType[] = []
  const log: Record<string, any> = {}

  for (const r of candleResults) {
    if (r.status === 'rejected') continue
    const { asset, snap4h, factors4h, snap1h } = r.value
    if (!snap4h) continue

    const d       = snapDB[asset]?.['1d']  ?? null
    const wk      = snapDB[asset]?.['1wk'] ?? null
    const funding = fundingMap[asset] ?? null

    // ── Score v2 — força + volume + EMA + funding ────────────────────────────
    let bullScore = 0
    let bearScore = 0

    // WT por profundidade
    if (snap4h.wt_cross_up && snap4h.wt_zone === 'oversold') {
      const depth = factors4h?.wt1_depth ?? Math.abs(snap4h.wt1 ?? 53)
      bullScore += depth > 75 ? 4 : depth > 60 ? W.wt_cross_oversold : W.wt_cross_oversold * 0.7
    }
    if (snap4h.wt_cross_down && snap4h.wt_zone === 'overbought') {
      const depth = factors4h?.wt1_depth ?? Math.abs(snap4h.wt1 ?? 53)
      bearScore += depth > 75 ? 4 : depth > 60 ? W.wt_cross_overbought : W.wt_cross_overbought * 0.7
    }

    // BOS com volume
    if (snap4h.bos_up) {
      const mult = factors4h?.bos_volume_ok ? 1.25 : (factors4h ? 0.5 : 1.0)
      bullScore += W.bos_up * mult
    }
    if (snap4h.bos_down) {
      const mult = factors4h?.bos_volume_ok ? 1.25 : (factors4h ? 0.5 : 1.0)
      bearScore += W.bos_down * mult
    }

    if (snap4h.price_vs_cloud === 'above')   bullScore += W.price_vs_cloud
    if (snap4h.price_vs_cloud === 'below')   bearScore += W.price_vs_cloud
    if (snap4h.tenkan_vs_kijun === 'above')  bullScore += W.tenkan_vs_kijun
    if (snap4h.tenkan_vs_kijun === 'below')  bearScore += W.tenkan_vs_kijun

    // EMA 200 (novo)
    if (snap4h.price_vs_ema === 'above')     bullScore += 0.5
    if (snap4h.price_vs_ema === 'below')     bearScore += 0.5
    if (d?.price_vs_ema === 'above')         bullScore += 0.5
    if (d?.price_vs_ema === 'below')         bearScore += 0.5

    if (d?.bias === 'ALTISTA')               bullScore += W.daily_bias
    if (d?.bias === 'BAIXISTA')              bearScore += W.daily_bias
    if (wk?.bias === 'ALTISTA')              bullScore += W.weekly_bias
    if (wk?.bias === 'BAIXISTA')             bearScore += W.weekly_bias

    if (macro?.macro_score != null) {
      bullScore += macro.macro_score * 0.5
      bearScore -= macro.macro_score * 0.5
    }

    if (fg?.value != null) {
      if (fg.value >= 80) bullScore -= 1
      if (fg.value <= 20) bearScore -= 1
    }

    // Funding rate
    if (funding !== null) {
      if (funding > 0.0007)       { bullScore -= 2;    bearScore += 0.3 }
      else if (funding > 0.0004)  { bullScore -= 1 }
      if (funding < -0.0005)      { bearScore -= 1.5;  bullScore += 0.3 }
      else if (funding < -0.0002) { bearScore -= 0.5 }
    }

    // OI crowding — combinado com funding indica saturação direcional
    const oi = (oiAll as any)?.[asset]
    if (oi && oi.crowdingRatio > 0 && funding !== null) {
      if (oi.crowdingRatio > 4 && funding > 0.0003)  bullScore -= oi.crowdingRatio > 6 ? 1.5 : 1
      if (oi.crowdingRatio > 4 && funding < -0.0002) bearScore -= oi.crowdingRatio > 6 ? 1.5 : 1
    }

    // Baleias
    const whale = whaleMap[asset]
    if (whale && whale.longCount + whale.shortCount >= 2) {
      if (whale.sentiment === 'bullish') { bullScore += 1.5; if (whale.sentimentPct > 75) bullScore += 0.5 }
      if (whale.sentiment === 'bearish') { bearScore += 1.5; if (whale.sentimentPct < 25) bearScore += 0.5 }
    }

    const topScore   = Math.max(bullScore, bearScore)
    const dir        = bullScore > bearScore ? 'long' : 'short'
    const { threshold } = computeThreshold(perfMap[asset])
    const gap        = threshold - topScore
    const newsAsset  = news[asset] ?? null
    const newsDir    = newsAsset?.sentiment === 'bullish' ? 'long' : newsAsset?.sentiment === 'bearish' ? 'short' : null

    log[asset] = {
      bull:     +bullScore.toFixed(1),
      bear:     +bearScore.toFixed(1),
      threshold,
      gap:      +gap.toFixed(1),
      vol_ratio: factors4h ? +factors4h.volume_ratio.toFixed(2) : null,
      funding:  funding !== null ? +(funding * 100).toFixed(4) : null,
      news:     newsAsset?.sentiment ?? '—',
      whale:    whale?.sentiment ?? '—',
    }

    // Helpers de display
    const influencerSources = ['@marioNawfal', '@CoinBureau', '@WatcherGuru']
    const hasInfluencer = (n: any) => n?.sources?.some((s: string) => influencerSources.includes(s))
    const influencerTag = (n: any) => {
      const names = (n?.sources ?? []).filter((s: string) => influencerSources.includes(s))
      return names.length ? ` ✦${names.join('+')}` : ''
    }
    const priceStr = `$${snap4h.close.toFixed(asset === 'DOGE' ? 5 : asset === 'XRP' || asset === 'AVAX' ? 3 : 2)}`

    // ── Tipo 1: SINAL (score ≥ threshold) ───────────────────────────────────
    if (topScore >= threshold && !alreadyActive.has(asset) && !cb.triggered) {
      const newsTag   = newsAsset ? ` | 📰 ${newsAsset.sentiment}${influencerTag(newsAsset)}` : ''
      const whaleTag  = whale ? ` | 🐳 ${whale.sentiment}` : ''
      const tweetLine = newsAsset?.tweetCount
        ? `\n🐦 ${newsAsset.tweetCount} tweet(s): <i>${(newsAsset.headlines[0] ?? '').slice(0, 90)}</i>`
        : ''
      alertBucket.push({
        asset, dir, type: 'signal', score: topScore, gap,
        text:
          `${dir === 'long' ? '🟢' : '🔴'} <b>${asset}</b> ${dir.toUpperCase()}\n` +
          `Score: <b>${topScore.toFixed(1)}</b>/${threshold}${newsTag}${whaleTag}\n` +
          `Preço: <code>${priceStr}</code>${tweetLine}`,
      })
      alreadyActive.add(asset)
      continue
    }

    // ── Tipo 2: FORMANDO (gap ≤ 1.5 + confirmação externa) ─────────────────
    if (gap > 0 && gap <= 1.5 && !alreadyActive.has(asset)) {
      const newsOk  = newsAsset && newsDir === dir
      const whaleOk = whale && (dir === 'long' ? whale.sentiment === 'bullish' : whale.sentiment === 'bearish')

      if (newsOk || whaleOk) {
        const confirms = [
          newsOk  && `📰 news ${newsAsset!.sentiment}${influencerTag(newsAsset)}`,
          whaleOk && `🐳 baleias ${whale.sentiment}`,
        ].filter(Boolean).join(' + ')

        const influencerLine = newsOk && hasInfluencer(newsAsset)
          ? `\n🐦 <i>${(newsAsset!.headlines[0] ?? '').slice(0, 100)}</i>`
          : newsOk && newsAsset?.headlines?.[0]
            ? `\n<i>${newsAsset.headlines[0].slice(0, 100)}</i>`
            : ''

        alertBucket.push({
          asset, dir, type: 'forming', score: topScore, gap,
          text:
            `⏳ <b>${asset}</b> ${dir.toUpperCase()} — falta ${gap.toFixed(1)} pt(s) | ${priceStr}\n` +
            `${confirms}${influencerLine}`,
        })
      }
    }

    // ── Tipo 3: NEWS FLASH (notícia forte + setup parcial, ≥50% do threshold) ─
    if (gap > 1.5 && newsAsset && Math.abs(newsAsset.score) >= 1.5 && topScore >= threshold * 0.5 && newsDir === dir) {
      const iTag = influencerTag(newsAsset)
      alertBucket.push({
        asset, dir, type: 'news', score: topScore, gap,
        text:
          `📰 <b>${asset}</b> ${dir.toUpperCase()}${iTag} — score ${newsAsset.score > 0 ? '+' : ''}${newsAsset.score}\n` +
          `Setup: ${topScore.toFixed(1)}/${threshold} (falta ${gap.toFixed(1)} pt) | ${priceStr}\n` +
          `<i>${(newsAsset.headlines[0] ?? '').slice(0, 120)}</i>`,
      })
    }
  }

  // ── 6. Envia alertas agrupados por tipo ────────────────────────────────────
  const signals  = alertBucket.filter(a => a.type === 'signal')
  const forming  = alertBucket.filter(a => a.type === 'forming')
  const newsOnly = alertBucket.filter(a => a.type === 'news')

  if (signals.length) {
    const h = new Date().toLocaleString('pt-BR', {
      timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit',
    })
    await sendTelegram(
      `🚨 <b>SINAIS — ${h}</b>\n\n` +
      signals.map(a => a.text).join('\n\n') +
      `\n\n<i>Use /analisar para análise completa.</i>`
    )
  }

  if (forming.length) {
    await sendTelegram(
      `👁 <b>SETUPS FORMANDO</b>\n` +
      `<i>Técnico + confirmação externa — antecipação</i>\n\n` +
      forming.map(a => a.text).join('\n\n')
    )
  }

  if (newsOnly.length) {
    await sendTelegram(
      `⚡ <b>NEWS FLASH</b>\n` +
      `<i>Notícia relevante antes do setup técnico completar</i>\n\n` +
      newsOnly.map(a => a.text).join('\n\n')
    )
  }

  // ── 7. Monitor de stops/alvos (30min = mais responsivo que o scan 1h) ───────
  const stopResult = await checkStopAlerts(db, openTrades ?? [])

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
  return NextResponse.json({
    ok:            true,
    elapsed_s:     elapsed,
    news_items:    newsResult.total,
    whales:        whaleResult?.traders?.length ?? 0,
    signals:       signals.length,
    forming:       forming.length,
    newsFlash:     newsOnly.length,
    stops_closed:  stopResult.closed,
    stops_alerted: stopResult.alerted,
    log,
  })
}
