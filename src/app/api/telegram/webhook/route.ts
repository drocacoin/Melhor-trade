/**
 * Webhook Telegram — recebe comandos e responde.
 *
 * Comandos disponíveis:
 *  /status  — regime macro + fear & greed + score dos ativos
 *  /trades  — posições abertas com P&L atual
 *  /scan    — dispara scan manual
 *  /macro   — atualiza macro agora
 *  /help    — lista comandos
 */
import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { sendTelegram } from '@/lib/telegram'
import { fetchLivePrice, fetchFearAndGreed } from '@/lib/fetcher'
import { Asset } from '@/types'

export const maxDuration = 60

export async function POST(req: NextRequest) {
  // Verificar secret token do Telegram
  const secret = req.headers.get('x-telegram-bot-api-secret-token')
  if (process.env.TELEGRAM_WEBHOOK_SECRET && secret !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: any
  try { body = await req.json() } catch { return NextResponse.json({ ok: true }) }

  const message = body?.message ?? body?.edited_message
  if (!message?.text) return NextResponse.json({ ok: true })

  const text    = message.text.trim().toLowerCase()
  const chatId  = message.chat?.id?.toString()

  // Só responde ao chat autorizado
  if (chatId !== process.env.TELEGRAM_CHAT_ID) {
    return NextResponse.json({ ok: true })
  }

  // ── Roteamento de comandos ────────────────────────────────────────────────
  if (text === '/help' || text === '/start') {
    await sendTelegram(
      `🤖 <b>Melhor Trade Bot</b>\n\n` +
      `Comandos disponíveis:\n\n` +
      `/status — Macro + Fear &amp; Greed atual\n` +
      `/trades — Posições abertas com P&amp;L\n` +
      `/scan   — Dispara scan manual agora\n` +
      `/macro  — Atualiza leitura macro agora\n` +
      `/help   — Esta mensagem`
    )
    return NextResponse.json({ ok: true })
  }

  if (text === '/status') {
    await handleStatus()
    return NextResponse.json({ ok: true })
  }

  if (text === '/trades') {
    await handleTrades()
    return NextResponse.json({ ok: true })
  }

  if (text === '/scan') {
    await handleScan()
    return NextResponse.json({ ok: true })
  }

  if (text === '/macro') {
    await handleMacro()
    return NextResponse.json({ ok: true })
  }

  // Comando desconhecido
  await sendTelegram(`❓ Comando não reconhecido. Use /help para ver os comandos disponíveis.`)
  return NextResponse.json({ ok: true })
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

async function handleStatus() {
  const db = supabaseAdmin()

  const [{ data: macro }, fg] = await Promise.all([
    db.from('macro_readings').select('*').order('captured_at', { ascending: false }).limit(1).single(),
    fetchFearAndGreed(),
  ])

  const regimeEmoji: Record<string, string> = {
    'risk-on': '🟢', 'risk-off': '🔴', 'transicao': '🟠', 'neutro': '🟡',
  }

  const macroLine = macro
    ? `${regimeEmoji[macro.regime] ?? '⚪'} Regime: <b>${macro.regime.toUpperCase()}</b> | Score: <b>${macro.macro_score >= 0 ? '+' : ''}${macro.macro_score}</b>\n` +
      `DXY: ${macro.dxy_trend} · Yields: ${macro.yields_trend} · FED: ${macro.fed_stance}\n` +
      (macro.notes ? `<i>${macro.notes.slice(0, 200)}</i>` : '')
    : 'Sem leitura macro registrada. Use /macro para atualizar.'

  const fgEmoji = !fg ? '—' : fg.value >= 75 ? '🤑' : fg.value <= 25 ? '😱' : '😐'
  const fgLine  = fg ? `📊 Fear &amp; Greed: ${fgEmoji} <b>${fg.value}</b> — ${fg.label}` : ''

  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString()
  const { data: signals } = await db
    .from('signals')
    .select('asset, direction, setup_grade, detected_at')
    .eq('status', 'active')
    .gte('detected_at', since)
    .order('detected_at', { ascending: false })

  const signalLine = signals?.length
    ? `\n🚨 <b>${signals.length} sinal(is) ativo(s) nas últimas 24h:</b>\n` +
      signals.map(s => `   ${s.direction === 'long' ? '🟢' : '🔴'} ${s.asset} ${s.direction.toUpperCase()} [${s.setup_grade}]`).join('\n')
    : '\n✅ Sem sinais ativos nas últimas 24h.'

  await sendTelegram(
    `📊 <b>Status — Melhor Trade</b>\n\n` +
    `${macroLine}\n\n` +
    `${fgLine}` +
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

  // Busca preços ao vivo
  const assets = [...new Set(trades.map(t => t.asset))] as Asset[]
  const prices: Record<string, number> = {}
  await Promise.all(assets.map(a => fetchLivePrice(a).then(p => { prices[a] = p })))

  const lines = [`📋 <b>Posições abertas (${trades.length})</b>\n`]

  for (const t of trades) {
    const price   = prices[t.asset]
    const isLong  = t.direction === 'long'
    const emoji   = isLong ? '🟢' : '🔴'

    let pnlLine = ''
    if (price && t.entry_price) {
      const pnl_pct = isLong
        ? ((price - t.entry_price) / t.entry_price) * 100 * (t.leverage ?? 1)
        : ((t.entry_price - price) / t.entry_price) * 100 * (t.leverage ?? 1)
      const sign    = pnl_pct >= 0 ? '+' : ''
      const pnlEmoji = pnl_pct >= 0 ? '💚' : '🔴'
      pnlLine = ` | ${pnlEmoji} <b>${sign}${pnl_pct.toFixed(2)}%</b>`
    }

    const stopLine = t.stop_price ? ` | Stop: $${t.stop_price}` : ''
    lines.push(
      `${emoji} <b>${t.asset}</b> ${t.direction.toUpperCase()} ${t.leverage ?? 1}x\n` +
      `   Entrada: $${t.entry_price} → Atual: $${price?.toFixed(2) ?? '—'}${pnlLine}\n` +
      `   Alvo 1: $${t.target1 ?? '—'}${stopLine}`
    )
  }

  await sendTelegram(lines.join('\n'))
}

async function handleScan() {
  await sendTelegram(`🔍 <b>Scan manual iniciado...</b>\n\n<i>Aguarde — pode levar até 2 minutos para todos os ativos.</i>`)

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://melhor-trade.vercel.app'
  try {
    const res = await fetch(`${appUrl}/api/cron/scan`, {
      headers: { 'Authorization': `Bearer ${process.env.CRON_SECRET}` },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    // O scan vai enviar o próprio resumo via Telegram ao terminar
  } catch (e: any) {
    await sendTelegram(`❌ <b>Scan falhou:</b> ${e.message}`)
  }
}

async function handleMacro() {
  await sendTelegram(`📡 <b>Atualizando macro...</b>`)

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://melhor-trade.vercel.app'
  try {
    const res  = await fetch(`${appUrl}/api/cron/macro`, {
      headers: { 'Authorization': `Bearer ${process.env.CRON_SECRET}` },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    // O macro cron envia o próprio Telegram ao terminar
  } catch (e: any) {
    await sendTelegram(`❌ <b>Macro falhou:</b> ${e.message}`)
  }
}
