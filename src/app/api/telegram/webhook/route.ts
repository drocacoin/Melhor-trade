/**
 * Webhook Telegram — recebe comandos e responde.
 *
 * ESSENCIAIS:
 *  /status          — Macro + regime + posições + circuit breaker
 *  /trades          — Posições abertas com P&L ao vivo
 *  /analisar        — Análise completa Claude Sonnet
 *
 * CONSULTAS:
 *  /noticias        — Notícias + sentimento ao vivo
 *  /baleias         — Top traders HyperLiquid
 *  /macro           — Atualiza leitura macro agora
 *  /detalhe {ativo} — Análise técnica do último sinal (ex: /detalhe btc)
 *
 * AVANÇADO:
 *  /scan            — Scan completo forçado
 *  /journal         — Journal IA do mês atual
 *  /help            — Esta lista
 */
import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { sendTelegram, fmtSignalDetail } from '@/lib/telegram'
import { fetchLivePrice, fetchFearAndGreed } from '@/lib/fetcher'
import { fetchWhaleSentiment } from '@/lib/whales'
import { fetchNewsSentiment } from '@/lib/news'
import { evaluateCircuitBreaker } from '@/lib/circuit-breaker'
import { fetchSetupHistory, buildExitStrategy, suggestRisk } from '@/lib/signal-context'
import { Asset } from '@/types'

export const maxDuration = 60

export async function POST(req: NextRequest) {
  const secret = req.headers.get('x-telegram-bot-api-secret-token')
  if (process.env.TELEGRAM_WEBHOOK_SECRET && secret !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: any
  try { body = await req.json() } catch { return NextResponse.json({ ok: true }) }

  const message = body?.message ?? body?.edited_message
  if (!message?.text) return NextResponse.json({ ok: true })

  const text   = message.text.trim().toLowerCase()
  const chatId = message.chat?.id?.toString()

  if (chatId !== process.env.TELEGRAM_CHAT_ID) {
    return NextResponse.json({ ok: true })
  }

  // ── Roteamento ────────────────────────────────────────────────────────────

  if (text === '/help' || text === '/start') {
    await sendTelegram(
      `🤖 <b>Melhor Trade Bot</b>\n\n` +
      `<b>ESSENCIAIS</b>\n` +
      `/status   — Macro, posições e saúde do sistema\n` +
      `/trades   — Posições abertas com P&amp;L ao vivo\n` +
      `/analisar — Análise completa + recomendação IA\n\n` +
      `<b>CONSULTAS</b>\n` +
      `/noticias        — Notícias + sentimento ao vivo\n` +
      `/baleias         — Top traders HyperLiquid\n` +
      `/macro           — Atualizar leitura macro agora\n` +
      `/detalhe {ativo} — Análise técnica do último sinal\n` +
      `<i>Ex: /detalhe btc  /detalhe eth  /detalhe sol</i>\n\n` +
      `<b>AVANÇADO</b>\n` +
      `/scan    — Forçar scan completo agora\n` +
      `/journal — Journal IA do mês atual`
    )
    return NextResponse.json({ ok: true })
  }

  if (text === '/status')   { await handleStatus();   return NextResponse.json({ ok: true }) }
  if (text === '/trades')   { await handleTrades();   return NextResponse.json({ ok: true }) }
  if (text === '/scan')     { await handleScan();     return NextResponse.json({ ok: true }) }
  if (text === '/macro')    { await handleMacro();    return NextResponse.json({ ok: true }) }
  if (text === '/journal')  { await handleJournal();  return NextResponse.json({ ok: true }) }
  if (text === '/analisar') { await handleAdvisor();  return NextResponse.json({ ok: true }) }
  if (text === '/baleias')  { await handleWhales();   return NextResponse.json({ ok: true }) }
  if (text === '/noticias') { await handleNews();     return NextResponse.json({ ok: true }) }
  if (text === '/scanfast') { await handleScanFast(); return NextResponse.json({ ok: true }) }

  // /detalhe {ativo}  ou  /detalhe_{ativo}
  const detalheMatch = text.match(/^\/detalhe[_ ](\w+)/)
  if (detalheMatch) {
    await handleDetalhe(detalheMatch[1].toUpperCase())
    return NextResponse.json({ ok: true })
  }

  await sendTelegram(`❓ Comando não reconhecido. Use /help para ver os comandos disponíveis.`)
  return NextResponse.json({ ok: true })
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

async function handleStatus() {
  const db = supabaseAdmin()

  const [{ data: macro }, fg, { data: openTrades }, { data: recentClosed }] = await Promise.all([
    db.from('macro_readings').select('*').order('captured_at', { ascending: false }).limit(1).single(),
    fetchFearAndGreed(),
    db.from('trades').select('id,asset,direction,leverage,entry_price,stop_price,target1').eq('status', 'open'),
    db.from('trades').select('id,pnl_usd,pnl_pct,closed_at').eq('status', 'closed').order('closed_at', { ascending: false }).limit(10),
  ])

  const regimeEmoji: Record<string, string> = {
    'risk-on': '🟢', 'risk-off': '🔴', 'transicao': '🟠', 'neutro': '🟡',
  }

  const macroLine = macro
    ? `${regimeEmoji[macro.regime] ?? '⚪'} Regime: <b>${macro.regime.toUpperCase()}</b> | Score: <b>${macro.macro_score >= 0 ? '+' : ''}${macro.macro_score}</b>\n` +
      `DXY: ${macro.dxy_trend} · Yields: ${macro.yields_trend} · FED: ${macro.fed_stance}\n` +
      (macro.notes ? `<i>${macro.notes.slice(0, 150)}</i>` : '')
    : 'Sem leitura macro registrada.'

  const fgEmoji = !fg ? '—' : fg.value >= 75 ? '🤑' : fg.value <= 25 ? '😱' : '😐'
  const fgLine  = fg ? `📊 Fear &amp; Greed: ${fgEmoji} <b>${fg.value}</b> — ${fg.label}` : ''

  const cb = evaluateCircuitBreaker(recentClosed ?? [])
  const cbLine = cb.triggered
    ? `⛔ <b>Circuit Breaker ATIVO</b> — ${cb.reason}`
    : `✅ Circuit Breaker: inativo (WR5=${cb.last5wr ?? '—'}% | WR10=${cb.last10wr ?? '—'}%)`

  const closed   = recentClosed ?? []
  const isWin    = (t: any) => (t.pnl_usd ?? 0) > 0
  const wins     = closed.filter(isWin).length
  const pnlTotal = closed.reduce((s: number, t: any) => s + (t.pnl_usd ?? 0), 0)
  const perfLine = closed.length
    ? `📈 Últimos ${closed.length} trades: <b>${wins}W/${closed.length - wins}L</b> | P&L ${pnlTotal >= 0 ? '+' : ''}$${Math.abs(pnlTotal).toFixed(0)}`
    : ''

  const posLine = openTrades?.length
    ? `📋 <b>${openTrades.length} posição(ões) aberta(s):</b>\n` +
      openTrades.map((t: any) =>
        `  ${t.direction === 'long' ? '🟢' : '🔴'} ${t.asset} ${t.direction.toUpperCase()} ${t.leverage}x @ $${t.entry_price} | stop $${t.stop_price ?? '?'}`
      ).join('\n')
    : '📭 Sem posições abertas.'

  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString()
  const { data: signals } = await db
    .from('signals')
    .select('asset, direction, setup_grade, confidence_pct, detected_at')
    .eq('status', 'active')
    .gte('detected_at', since)
    .order('detected_at', { ascending: false })

  const signalLine = signals?.length
    ? `🚨 <b>${signals.length} sinal(is) ativo(s):</b>\n` +
      signals.map(s =>
        `  ${s.direction === 'long' ? '🟢' : '🔴'} ${s.asset} ${s.direction.toUpperCase()} [${s.setup_grade}]${s.confidence_pct ? ` ${s.confidence_pct}%` : ''}\n` +
        `  👉 /detalhe_${s.asset.toLowerCase()}`
      ).join('\n')
    : '✅ Sem sinais ativos (24h).'

  await sendTelegram(
    `📊 <b>Status — Melhor Trade</b>\n\n` +
    `${macroLine}\n\n` +
    `${fgLine}\n` +
    `${perfLine}\n\n` +
    `${cbLine}\n\n` +
    `${posLine}\n\n` +
    `${signalLine}`
  )
}

async function handleTrades() {
  const db = supabaseAdmin()
  const { data: trades } = await db.from('trades').select('*').eq('status', 'open')

  if (!trades?.length) {
    await sendTelegram(`📭 <b>Sem posições abertas</b>\n\nNenhum trade aberto no momento.`)
    return
  }

  const assets = [...new Set(trades.map(t => t.asset))] as Asset[]
  const prices: Record<string, number> = {}
  await Promise.all(assets.map(a => fetchLivePrice(a).then(p => { prices[a] = p })))

  const lines = [`📋 <b>Posições abertas (${trades.length})</b>\n`]

  for (const t of trades) {
    const price  = prices[t.asset]
    const isLong = t.direction === 'long'
    const emoji  = isLong ? '🟢' : '🔴'

    let pnlLine = ''
    if (price && t.entry_price) {
      const pnl_pct  = isLong
        ? ((price - t.entry_price) / t.entry_price) * 100 * (t.leverage ?? 1)
        : ((t.entry_price - price) / t.entry_price) * 100 * (t.leverage ?? 1)
      const sign     = pnl_pct >= 0 ? '+' : ''
      const pnlEmoji = pnl_pct >= 0 ? '💚' : '🔴'
      pnlLine = ` | ${pnlEmoji} <b>${sign}${pnl_pct.toFixed(2)}%</b>`
    }

    const stopLine = t.stop_price ? ` | Stop: $${t.stop_price}` : ''
    // Parcial já registrado?
    const partialLine = t.partial_close_1_price
      ? `\n   ✂️ Parcial 50% @ $${t.partial_close_1_price} (${t.partial_close_1_pnl_pct >= 0 ? '+' : ''}${t.partial_close_1_pnl_pct?.toFixed(1)}%) — stop em breakeven`
      : ''

    lines.push(
      `${emoji} <b>${t.asset}</b> ${t.direction.toUpperCase()} ${t.leverage ?? 1}x\n` +
      `   Entrada: $${t.entry_price} → Atual: $${price?.toFixed(2) ?? '—'}${pnlLine}\n` +
      `   Alvo 1: $${t.target1 ?? '—'}${stopLine}${partialLine}`
    )
  }

  await sendTelegram(lines.join('\n'))
}

async function handleDetalhe(asset: string) {
  const db = supabaseAdmin()

  // Busca o sinal mais recente para este ativo (qualquer status)
  const { data: signal } = await db
    .from('signals')
    .select('*')
    .eq('asset', asset)
    .order('detected_at', { ascending: false })
    .limit(1)
    .single()

  if (!signal) {
    await sendTelegram(`📭 Nenhum sinal encontrado para <b>${asset}</b>.\n\nAtivos disponíveis: BTC, ETH, SOL, HYPE, AAVE, LINK, AVAX, XRP, SUI, DOGE, TAO, GOLD, OIL, SP500, MSTR`)
    return
  }

  // Reconstruir contexto a partir do DB
  const [history] = await Promise.all([
    fetchSetupHistory(db, asset, signal.direction),
  ])

  const exitStrategy = buildExitStrategy(signal.rr1, signal.target1, signal.target2)
  const riskSuggest  = suggestRisk(
    history?.winRate    ?? null,
    history?.avgWinPct  ?? null,
    history?.avgLossPct ?? null,
    signal.rr1,
  )
  const low_wr_warning = history !== null && history.totalTrades >= 5 && history.winRate < 40

  const enriched = {
    ...signal,
    history,
    exitStrategy,
    riskSuggest,
    low_wr_warning,
    confluence:     null,
    correlation:    null,
    whale_sentiment: null,
    whale_pct:      null,
    whale_count:    0,
  }

  // Data do sinal para contexto
  const detectedAt = new Date(signal.detected_at).toLocaleString('pt-BR', { timeZone: 'UTC', dateStyle: 'short', timeStyle: 'short' })
  const statusTag  = signal.status === 'active' ? '🟢 ativo' : signal.status === 'expired' ? '⏸ expirado' : signal.status

  const header = `📋 Sinal de ${detectedAt} UTC — ${statusTag}\n\n`
  const body   = fmtSignalDetail(enriched, null, null)
  const msg    = header + body

  if (msg.length > 3800) {
    const mid = msg.lastIndexOf('\n\n', 3800)
    await sendTelegram(msg.slice(0, mid))
    await sendTelegram(msg.slice(mid).trim())
  } else {
    await sendTelegram(msg)
  }
}

async function handleScan() {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://melhor-trade.vercel.app'
  fetch(`${appUrl}/api/cron/scan`, {
    headers: { 'Authorization': `Bearer ${process.env.CRON_SECRET}` },
  }).catch(() => {})

  await sendTelegram(`🔍 <b>Scan iniciado</b> — todos os 15 ativos\n\n<i>Sinais chegam automaticamente se detectados (~2 min).</i>`)
}

async function handleMacro() {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://melhor-trade.vercel.app'
  await sendTelegram(`📡 <b>Atualizando macro...</b> <i>Aguarde ~5s.</i>`)

  try {
    const r    = await fetch(`${appUrl}/api/cron/macro`, {
      headers: { 'Authorization': `Bearer ${process.env.CRON_SECRET}` },
    })
    const data = await r.json()
    if (!r.ok) throw new Error(data.error ?? `status ${r.status}`)

    const regimeEmoji: Record<string, string> = {
      'risk-on': '🟢', 'risk-off': '🔴', 'transicao': '🟠', 'neutro': '🟡',
    }
    const dxyArrow    = ({ forte: '▲', lateral: '→', fraco: '▼' } as any)[data.dxy?.trend]    ?? '→'
    const yieldsArrow = ({ subindo: '▲', lateral: '→', caindo: '▼' } as any)[data.yields?.trend] ?? '→'
    const scoreStr    = data.macro_score >= 0 ? `+${data.macro_score}` : `${data.macro_score}`

    const msg = [
      `📊 <b>Macro Atualizado</b>`,
      ``,
      `${regimeEmoji[data.regime] ?? '⚪'} Regime: <b>${(data.regime ?? '').toUpperCase()}</b> | Score: <b>${scoreStr}</b>`,
      ``,
      `DXY ${dxyArrow} ${data.dxy?.value?.toFixed(2)} (SMA20: ${data.dxy?.sma20?.toFixed(2)}) · FED: ${data.fed_stance}`,
      `Yields 10Y ${yieldsArrow} ${data.yields?.value?.toFixed(2)}%`,
      `VIX: ${data.vix?.toFixed(1)}`,
      ``,
      data.notes ? `<i>${data.notes.slice(0, 250)}</i>` : '',
    ].filter(Boolean).join('\n')

    await sendTelegram(msg)
  } catch (e: any) {
    await sendTelegram(`❌ <b>Erro macro:</b> ${e.message}`)
  }
}

async function handleJournal() {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://melhor-trade.vercel.app'
  const month  = new Date().toISOString().slice(0, 7)

  await sendTelegram(`📔 <b>Gerando journal de ${month}...</b> <i>Aguarde ~10s.</i>`)

  try {
    const r    = await fetch(`${appUrl}/api/cron/journal?month=${month}`, {
      headers: { 'Authorization': `Bearer ${process.env.CRON_SECRET}` },
    })
    const data = await r.json()
    if (!r.ok) throw new Error(data.error ?? `status ${r.status}`)

    if (!data.trades) {
      await sendTelegram(`📔 <b>Journal ${month}</b>\n\nNenhum trade fechado no mês ainda.`)
      return
    }

    const wrEmoji  = data.winrate >= 60 ? '🟢' : data.winrate >= 50 ? '🟡' : '🔴'
    const pnlEmoji = data.total_pnl >= 0 ? '💚' : '🔴'
    const sign     = data.total_pnl >= 0 ? '+' : ''

    let msg =
      `📔 <b>Journal — ${month}</b>\n\n` +
      `${wrEmoji} <b>${data.trades} trades</b> — WR <b>${data.winrate?.toFixed(1)}%</b>\n` +
      `${pnlEmoji} P&amp;L: <b>${sign}$${Math.abs(data.total_pnl).toFixed(2)}</b>\n\n`

    if (data.narrative) msg += `<i>${data.narrative}</i>\n\n`

    if (data.highlights?.length) {
      msg += `<b>Insights:</b>\n`
      msg += data.highlights.slice(0, 3).map((h: string) => `  → ${h}`).join('\n')
    }

    await sendTelegram(msg)
  } catch (e: any) {
    await sendTelegram(`❌ <b>Erro journal:</b> ${e.message}`)
  }
}

async function handleAdvisor() {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://melhor-trade.vercel.app'
  await sendTelegram(`✦ <b>Analisando...</b>\n\n<i>Claude Sonnet avaliando macro, scores, posições e performance. ~15s.</i>`)

  try {
    const r    = await fetch(`${appUrl}/api/advisor`, { method: 'POST' })
    const body = await r.json().catch(() => null)
    if (!r.ok) throw new Error(body?.error ?? body?.details ?? `status ${r.status}`)

    const { analysis: a } = body
    if (!a) throw new Error('sem análise')

    const overallEmoji = a.overall === 'favorável' ? '🟢' : a.overall === 'desfavorável' ? '🔴' : '🟡'
    const urgEmoji     = (u: string) => u === 'alta' ? '🔥' : u === 'média' ? '📌' : '💡'

    const opLines  = (a.opportunities ?? []).slice(0, 3).map((op: any) =>
      `${urgEmoji(op.urgency)} <b>${op.asset}</b> ${op.direction.toUpperCase()} — ${(op.rationale ?? '').slice(0, 120)}`
    ).join('\n')

    const posLines = (a.open_positions ?? []).map((p: any) =>
      `${p.action === 'fechar' ? '✗' : p.action === 'manter' ? '✓' : '↑'} <b>${p.asset}</b>: ${(p.reason ?? '').slice(0, 100)}`
    ).join('\n')

    const riskLines = (a.risks ?? []).slice(0, 2).map((r: string) => `⚠ ${(r ?? '').slice(0, 120)}`).join('\n')

    let msg =
      `✦ <b>Análise Completa</b>\n\n` +
      `${overallEmoji} Mercado: <b>${a.overall.toUpperCase()}</b>\n` +
      `<i>${(a.market_view ?? '').slice(0, 200)}</i>\n\n`

    if (opLines)          msg += `📊 <b>Oportunidades:</b>\n${opLines}\n\n`
    if (posLines)         msg += `📋 <b>Posições abertas:</b>\n${posLines}\n\n`
    if (riskLines)        msg += `⚠ <b>Riscos:</b>\n${riskLines}\n\n`
    if (a.recommendation) msg += `💡 <b>Recomendação:</b>\n${(a.recommendation ?? '').slice(0, 400)}`

    if (msg.length > 3800) {
      const mid = msg.lastIndexOf('\n\n', 3800)
      await sendTelegram(msg.slice(0, mid))
      await sendTelegram(msg.slice(mid).trim())
    } else {
      await sendTelegram(msg)
    }
  } catch (e: any) {
    await sendTelegram(`❌ <b>Erro na análise:</b> ${e.message}\n\nTente novamente em instantes.`)
  }
}

async function handleWhales() {
  await sendTelegram(`🐳 <b>Buscando baleias...</b> <i>~10s.</i>`)

  try {
    const { traders, sentiment } = await fetchWhaleSentiment()

    const bullish      = sentiment.filter((s: any) => s.sentiment === 'bullish')
    const bearish      = sentiment.filter((s: any) => s.sentiment === 'bearish')
    const sentLines    = sentiment
      .filter((s: any) => s.longCount + s.shortCount >= 2)
      .slice(0, 10)
      .map((s: any) => {
        const emoji = s.sentiment === 'bullish' ? '🟢' : s.sentiment === 'bearish' ? '🔴' : '🟡'
        return `${emoji} <b>${s.asset}</b>: ${s.sentimentPct}% long (${s.longCount}L/${s.shortCount}S)`
      }).join('\n')

    await sendTelegram(
      `🐳 <b>Baleias HyperLiquid</b>\n\n` +
      `👥 <b>${traders.length} top traders</b> rastreados\n` +
      `🟢 ${bullish.length} bullish | 🔴 ${bearish.length} bearish\n\n` +
      (sentLines || 'Sem posições significativas.')
    )
  } catch (e: any) {
    await sendTelegram(`❌ <b>Erro baleias:</b> ${e.message}`)
  }
}

async function handleNews() {
  await sendTelegram(`📰 <b>Buscando notícias...</b> <i>Aguarde.</i>`)

  try {
    const { byAsset, total, items, sources } = await fetchNewsSentiment()

    if (!total) {
      await sendTelegram(`📰 <b>Notícias</b>\n\nNenhuma notícia encontrada nas últimas 12h.`)
      return
    }

    const tweetItems  = items.filter((i: any) => i.isTwitter)
    const newsItems   = items.filter((i: any) => !i.isTwitter)
    const sorted      = Object.values(byAsset).sort((a: any, b: any) => Math.abs(b.score) - Math.abs(a.score))
    const bullishAssets = sorted.filter((a: any) => a.sentiment === 'bullish')
    const bearishAssets = sorted.filter((a: any) => a.sentiment === 'bearish')

    let msg = `📰 <b>Notícias — Últimas 12h</b>\n<i>${newsItems.length} artigos · ${tweetItems.length} tweets · ${sources.slice(0, 4).join(', ')}</i>\n\n`

    if (bullishAssets.length) {
      msg += `🟢 <b>Bullish:</b>\n`
      msg += (bullishAssets as any[]).slice(0, 4).map((a: any) => {
        const srcBadge = a.sources?.some((s: string) => ['@marioNawfal','@CoinBureau','@WatcherGuru'].includes(s)) ? ' ✦' : ''
        const tweet    = a.tweetCount > 0 ? ` 🐦${a.tweetCount}` : ''
        return `   <b>${a.asset}</b>+${a.score}${tweet}${srcBadge}\n   <i>${(a.headlines[0] ?? '').slice(0, 80)}</i>`
      }).join('\n') + '\n\n'
    }

    if (bearishAssets.length) {
      msg += `🔴 <b>Bearish:</b>\n`
      msg += (bearishAssets as any[]).slice(0, 4).map((a: any) =>
        `   <b>${a.asset}</b>${a.score}\n   <i>${(a.headlines[0] ?? '').slice(0, 80)}</i>`
      ).join('\n') + '\n\n'
    }

    const influencerTweets = tweetItems.slice(0, 3)
    if (influencerTweets.length) {
      msg += `🐦 <b>Influencers:</b>\n`
      msg += (influencerTweets as any[]).map((h: any) =>
        `   <b>${h.source}</b>: <i>"${h.title.slice(0, 80)}"</i>`
      ).join('\n')
    }

    if (msg.length > 3800) {
      const mid = msg.lastIndexOf('\n\n', 3800)
      await sendTelegram(msg.slice(0, mid))
      await sendTelegram(msg.slice(mid).trim())
    } else {
      await sendTelegram(msg)
    }
  } catch (e: any) {
    await sendTelegram(`❌ <b>Erro notícias:</b> ${e.message}`)
  }
}

async function handleScanFast() {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://melhor-trade.vercel.app'
  fetch(`${appUrl}/api/cron/scan-fast`, {
    headers: { 'Authorization': `Bearer ${process.env.CRON_SECRET}` },
  }).catch(() => {})

  await sendTelegram(`⚡ <b>Scan rápido iniciado</b>\n\n<i>Crypto 24/7. Sinais chegam automaticamente se detectados.</i>`)
}
