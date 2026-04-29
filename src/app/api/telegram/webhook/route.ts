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
import { fetchWhaleSentiment } from '@/lib/whales'
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
      `/status   — Macro + Fear &amp; Greed atual\n` +
      `/trades   — Posições abertas com P&amp;L\n` +
      `/scan     — Dispara scan manual agora\n` +
      `/macro    — Atualiza leitura macro agora\n` +
      `/journal  — Resumo IA do mês atual\n` +
      `/analisar — Análise completa + recomendação\n` +
      `/baleias  — Sentimento dos top traders HL\n` +
      `/help     — Esta mensagem`
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

  if (text === '/journal') {
    await handleJournal()
    return NextResponse.json({ ok: true })
  }

  if (text === '/analisar') {
    await handleAdvisor()
    return NextResponse.json({ ok: true })
  }

  if (text === '/baleias') {
    await handleWhales()
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
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://melhor-trade.vercel.app'

  // send_summary=true garante que o scan sempre envia mensagem ao terminar
  fetch(`${appUrl}/api/cron/scan?send_summary=true`, {
    headers: { 'Authorization': `Bearer ${process.env.CRON_SECRET}` },
  }).catch(() => {/* silencioso */})

  await sendTelegram(
    `🔍 <b>Scan iniciado em todos os 15 ativos</b>\n\n` +
    `<i>O resumo chega aqui em ~2 minutos.</i>`
  )
}

async function handleMacro() {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://melhor-trade.vercel.app'

  // Dispara sem await — macro envia o próprio Telegram ao terminar
  fetch(`${appUrl}/api/cron/macro`, {
    headers: { 'Authorization': `Bearer ${process.env.CRON_SECRET}` },
  }).catch(() => {/* silencioso */})

  await sendTelegram(`📡 <b>Atualizando macro...</b>\n\n<i>Resultado chega em instantes.</i>`)
}

async function handleJournal() {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://melhor-trade.vercel.app'

  // Gera journal do mês atual (mesmo que incompleto)
  const now   = new Date()
  const month = now.toISOString().slice(0, 7)

  await sendTelegram(`📔 <b>Gerando journal de ${month}...</b>\n\n<i>Chega em instantes.</i>`)

  // Dispara sem await — journal envia o próprio Telegram ao terminar
  fetch(`${appUrl}/api/cron/journal?month=${month}`, {
    headers: { 'Authorization': `Bearer ${process.env.CRON_SECRET}` },
  }).catch(() => {/* silencioso */})
}

async function handleAdvisor() {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://melhor-trade.vercel.app'

  await sendTelegram(`✦ <b>Analisando todos os dados...</b>\n\n<i>Claude Sonnet está avaliando macro, scores, posições e performance. Chega em ~15s.</i>`)

  try {
    const r = await fetch(`${appUrl}/api/advisor`, { method: 'POST' })

    // Extrai o body mesmo em caso de erro para mostrar a causa real
    const body = await r.json().catch(() => null)
    if (!r.ok) {
      const reason = body?.error ?? body?.details ?? `status ${r.status}`
      throw new Error(reason)
    }

    const { analysis: a, context: ctx } = body
    if (!a) throw new Error('sem análise')

    const overallEmoji = a.overall === 'favorável' ? '🟢' : a.overall === 'desfavorável' ? '🔴' : '🟡'
    const urgEmoji = (u: string) => u === 'alta' ? '🔥' : u === 'média' ? '📌' : '💡'

    const opLines = (a.opportunities ?? []).slice(0, 3).map((op: any) =>
      `${urgEmoji(op.urgency)} <b>${op.asset}</b> ${op.direction.toUpperCase()} — ${op.rationale.slice(0, 100)}`
    ).join('\n')

    const posLines = (a.open_positions ?? []).map((p: any) =>
      `${p.action === 'fechar' ? '✗' : p.action === 'manter' ? '✓' : '↑'} <b>${p.asset}</b>: ${p.reason.slice(0, 80)}`
    ).join('\n')

    const riskLines = (a.risks ?? []).slice(0, 2).map((r: string) =>
      `⚠ ${r.slice(0, 100)}`
    ).join('\n')

    let msg =
      `✦ <b>Análise Completa — Melhor Trade</b>\n\n` +
      `${overallEmoji} Mercado: <b>${a.overall.toUpperCase()}</b>\n` +
      `<i>${a.market_view}</i>\n\n`

    if (opLines) msg += `📊 <b>Oportunidades:</b>\n${opLines}\n\n`
    if (posLines) msg += `📋 <b>Posições abertas:</b>\n${posLines}\n\n`
    if (riskLines) msg += `⚠ <b>Riscos:</b>\n${riskLines}\n\n`
    if (a.recommendation) msg += `💡 <b>Recomendação:</b>\n${a.recommendation}`

    await sendTelegram(msg)
  } catch (e: any) {
    await sendTelegram(`❌ <b>Erro na análise:</b> ${e.message}\n\nTente novamente em instantes.`)
  }
}

async function handleWhales() {
  await sendTelegram(`🐳 <b>Buscando posições das baleias...</b>\n\n<i>Analisando top traders HyperLiquid. Aguarde ~15s.</i>`)

  try {
    const { traders, sentiment } = await fetchWhaleSentiment()

    const bullish = sentiment.filter((s: any) => s.sentiment === 'bullish')
    const bearish = sentiment.filter((s: any) => s.sentiment === 'bearish')

    const sentimentLines = sentiment
      .filter((s: any) => s.longCount + s.shortCount >= 2)
      .slice(0, 10)
      .map((s: any) => {
        const emoji = s.sentiment === 'bullish' ? '🟢' : s.sentiment === 'bearish' ? '🔴' : '🟡'
        return `${emoji} <b>${s.asset}</b>: ${s.sentimentPct}% long (${s.longCount}L/${s.shortCount}S)`
      }).join('\n')

    const msg =
      `🐳 <b>Baleias HyperLiquid</b>\n\n` +
      `👥 <b>${traders.length} top traders</b> rastreados\n` +
      `🟢 ${bullish.length} ativos bullish | 🔴 ${bearish.length} ativos bearish\n\n` +
      (sentimentLines ? `<b>Sentimento por ativo:</b>\n${sentimentLines}` : 'Sem posições significativas.')

    await sendTelegram(msg)
  } catch (e: any) {
    await sendTelegram(`❌ <b>Erro ao buscar baleias:</b> ${e.message}`)
  }
}
