// ─── Telegram notification helpers ───────────────────────────────────────────

const TELEGRAM_API = 'https://api.telegram.org/bot'

/** Low-level send. Returns true on success. */
export async function sendTelegram(text: string): Promise<boolean> {
  const token  = process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_CHAT_ID
  if (!token || !chatId) return false

  try {
    const res = await fetch(`${TELEGRAM_API}${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    })
    return res.ok
  } catch {
    return false
  }
}

// ─── Formatters ───────────────────────────────────────────────────────────────

export function fmtSignal(
  signal:  any,
  fg:      { value: number; label: string } | null,
  funding: number | null,
): string {
  const emoji    = signal.direction === 'long' ? '🟢' : '🔴'
  const dir      = signal.direction === 'long' ? 'LONG ▲' : 'SHORT ▼'
  const gradeMap: Record<string, string> = { 'A+': '⭐⭐', A: '⭐', B: '🔵', C: '🟡' }
  const stars    = gradeMap[signal.setup_grade] ?? ''

  const confBadge = signal.confidence_pct != null
    ? ` · <b>${signal.confidence_pct}%</b> conf`
    : ''

  const lines = [
    `${emoji} <b>SINAL ${signal.setup_grade} ${stars} — ${signal.asset}</b>`,
    `Direção: <b>${dir}</b>${confBadge}`,
    '',
  ]

  // ── Warning de WR histórico baixo ─────────────────────────────────────
  if (signal.low_wr_warning && signal.history) {
    lines.push(
      `⚠️ <b>ATENÇÃO:</b> WR histórico <b>${signal.history.winRate}%</b> neste setup (${signal.history.totalTrades} trades) — reduza o tamanho.`,
      '',
    )
  }

  // ── Confluência de timeframes ──────────────────────────────────────────
  if (signal.confluence) {
    lines.push(`📊 Confluência: ${signal.confluence.visual}`)
    lines.push(`   ${signal.confluence.details}`)
  }

  // ── Sentimento ────────────────────────────────────────────────────────
  const sentLines: string[] = []
  if (fg) {
    const fgEmoji = fg.value >= 75 ? '🤑' : fg.value <= 25 ? '😱' : '😐'
    sentLines.push(`F&amp;G: ${fgEmoji} ${fg.value} (${fg.label})`)
  }
  if (funding !== null) {
    const fSign  = funding >= 0 ? '+' : ''
    const fEmoji = funding > 0.0005 ? '🔥' : funding < -0.0005 ? '🧊' : '➖'
    sentLines.push(`Funding: ${fEmoji} ${fSign}${(funding * 100).toFixed(3)}%`)
  }
  if (sentLines.length) lines.push(sentLines.join(' | '))

  // ── Baleias HyperLiquid ───────────────────────────────────────────────
  if (signal.whale_sentiment && signal.whale_count >= 2) {
    const wEmoji   = signal.whale_sentiment === 'bullish' ? '🟢'
                   : signal.whale_sentiment === 'bearish' ? '🔴' : '🟡'
    const confirms = (signal.direction === 'long'  && signal.whale_sentiment === 'bullish')
                  || (signal.direction === 'short' && signal.whale_sentiment === 'bearish')
    const tag      = confirms ? ' ✅ confirmado' : ' ⚠️ divergência'
    lines.push(
      `🐳 Baleias (${signal.whale_count} traders): ${wEmoji} ${signal.whale_pct}% long${tag}`
    )
  }

  // ── Níveis ────────────────────────────────────────────────────────────
  const entryPct = signal.entry_zone_low > 0
    ? ((signal.target1 - signal.entry_zone_high) / signal.entry_zone_high * 100).toFixed(1)
    : null
  const stopPct  = signal.entry_zone_low > 0
    ? Math.abs((signal.stop - signal.entry_zone_low) / signal.entry_zone_low * 100).toFixed(1)
    : null

  lines.push(...([
    '',
    `📍 Entrada:  <code>$${signal.entry_zone_low} – $${signal.entry_zone_high}</code>`,
    `🛑 Stop:     <code>$${signal.stop}</code>${stopPct ? ` (-${stopPct}%)` : ''}`,
    `🎯 Alvo 1:   <code>$${signal.target1}</code>${entryPct ? ` (+${entryPct}%)` : ''} | RR <b>${signal.rr1}:1</b>`,
    signal.target2 ? `🎯 Alvo 2:   <code>$${signal.target2}</code>` : '',
  ].filter(Boolean) as string[]))

  // ── Alerta de correlação ──────────────────────────────────────────────
  if (signal.correlation?.hasAlert) {
    lines.push('', `⚠️ <b>Correlação:</b> ${signal.correlation.message}`)
  }

  // ── Histórico do setup ────────────────────────────────────────────────
  if (signal.history && signal.history.totalTrades >= 3) {
    const h    = signal.history
    const res  = h.lastResults.slice(0, 4).map((p: number) => `${p >= 0 ? '+' : ''}${p}%`).join(' | ')
    const wrColor = h.winRate >= 60 ? '✅' : h.winRate >= 45 ? '⚠️' : '❌'
    lines.push(
      '',
      `📜 <b>Histórico ${signal.asset} ${signal.direction}:</b>`,
      `   ${res}`,
      `   WR: <b>${h.winRate}%</b> ${wrColor} (${h.totalTrades} trades) | Média: ${h.avgPnlPct >= 0 ? '+' : ''}${h.avgPnlPct}%`,
    )
  }

  // ── Gestão de saída ───────────────────────────────────────────────────
  if (signal.exitStrategy) {
    const e = signal.exitStrategy
    lines.push(
      '',
      `🎯 <b>Gestão sugerida:</b>`,
      `   ${e.partial1}`,
      `   ${e.trailing}`,
    )
  }

  // ── Risco sugerido ────────────────────────────────────────────────────
  if (signal.riskSuggest) {
    lines.push(`💰 Risco sugerido: <b>${signal.riskSuggest.riskPct}%</b> do capital (${signal.riskSuggest.rationale})`)
  }

  // ── Gatilho e cancelamento ────────────────────────────────────────────
  lines.push(
    '',
    `⚡ <i>${signal.trigger}</i>`,
    `❌ Cancela: <i>${signal.cancellation}</i>`,
  )

  // ── Análise IA ────────────────────────────────────────────────────────
  if (signal.analysis) {
    const clean = signal.analysis.slice(0, 800)
    lines.push('', `✦ <b>Análise IA (Haiku)</b>`, clean)
  }

  lines.push('', `👉 App → Alertas → ${signal.asset}`)

  return lines.filter(l => l !== undefined).join('\n')
}

export function fmtScanSummary(
  biases:         Record<string, string>,
  fg:             { value: number; label: string } | null,
  fundings:       Record<string, number | null>,
  thresholds:     Record<string, { threshold: number; reason: string }>,
  newSignals:     number,
  now:            string,
  circuitBreaker: { active: boolean; reason?: string } = { active: false }
): string {
  const lines = [`🔍 <b>Scan — ${now}</b>`, '']

  for (const [asset, bias] of Object.entries(biases)) {
    const icon = bias === 'ALTISTA' ? '🟢' : bias === 'BAIXISTA' ? '🔴' : '🟡'
    const fr   = fundings[asset] != null
      ? ` | FR ${fundings[asset]! >= 0 ? '+' : ''}${((fundings[asset]!) * 100).toFixed(3)}%`
      : ''
    const thr  = thresholds[asset]
    const thrStr = thr
      ? ` | min <b>${thr.threshold}</b> pts (${thr.reason})`
      : ''
    lines.push(`${icon} <b>${asset}</b>: ${bias}${fr}${thrStr}`)
  }

  if (fg) {
    const fgEmoji = fg.value >= 75 ? '🤑' : fg.value <= 25 ? '😱' : '😐'
    lines.push('', `📊 Fear &amp; Greed: ${fgEmoji} ${fg.value} — ${fg.label}`)
  }

  if (circuitBreaker.active) {
    lines.push('', `⛔ <b>Circuit Breaker Ativo</b> — ${circuitBreaker.reason ?? 'sequência de perdas'}`)
    lines.push('Sinais pausados. Stop monitoring ativo.')
  } else {
    lines.push(
      '',
      newSignals > 0
        ? `🚨 <b>${newSignals} novo(s) sinal(is) detectado(s)!</b>`
        : '✅ Sem novos sinais.',
    )
  }

  return lines.join('\n')
}

export function fmtStopAlert(
  asset: string,
  direction: string,
  price: number,
  stop: number,
  distPct: number
): string {
  return [
    `⚠️ <b>STOP PRÓXIMO — ${asset}</b>`,
    '',
    `Posição: <b>${direction.toUpperCase()}</b>`,
    `Preço atual: <code>$${price.toFixed(2)}</code>`,
    `Stop:        <code>$${stop.toFixed(2)}</code>`,
    `Distância:   <b>${distPct.toFixed(1)}%</b> do stop`,
    '',
    `⚡ Aja rápido — gerencie sua posição.`,
  ].join('\n')
}

/** Alerta quando alvo 1 é atingido — pede para fechar 50% */
export function fmtTarget1Hit(
  asset:     string,
  direction: string,
  price:     number,
  pnl1Pct:   number,
  newStop:   number,
  pnl1Usd:   number | null,
): string {
  const sign   = pnl1Pct >= 0 ? '+' : ''
  const usdStr = pnl1Usd != null ? ` (+$${pnl1Usd.toFixed(2)})` : ''
  return [
    `🎯 <b>ALVO 1 ATINGIDO — ${asset} ${direction.toUpperCase()}</b>`,
    ``,
    `Feche <b>50% agora</b> em <code>$${price.toFixed(2)}</code>${usdStr}`,
    `P&amp;L parcial: <b>${sign}${pnl1Pct.toFixed(2)}%</b>`,
    ``,
    `🔒 Stop movido para <b>breakeven</b> → <code>$${newStop.toFixed(2)}</code>`,
    `Os 50% restantes agora têm <b>risco zero</b>.`,
    ``,
    `👉 Feche metade e deixe correr para o Alvo 2.`,
  ].join('\n')
}

/** Alerta quando stop é atingido e posição é fechada automaticamente */
export function fmtStopClosed(
  asset:      string,
  direction:  string,
  price:      number,
  pnlPct:     number,
  pnlUsd:     number | null,
  hadPartial: boolean,
  partialPrice?: number,
  partialPnlPct?: number,
): string {
  const sign    = pnlPct >= 0 ? '+' : ''
  const usdStr  = pnlUsd != null ? ` (${pnlUsd >= 0 ? '+' : ''}$${pnlUsd.toFixed(2)})` : ''
  const emoji   = pnlPct >= 0 ? '💚' : '🔴'
  const lines = [
    `🛑 <b>STOP AUTO-CLOSE — ${asset} ${direction.toUpperCase()}</b>`,
    ``,
    `Posição fechada em <code>$${price.toFixed(2)}</code>`,
    `P&amp;L total: ${emoji} <b>${sign}${pnlPct.toFixed(2)}%</b>${usdStr}`,
  ]
  if (hadPartial && partialPrice != null && partialPnlPct != null) {
    const pSign = partialPnlPct >= 0 ? '+' : ''
    lines.push(
      ``,
      `<i>P&amp;L blended: parcial 50% @ $${partialPrice.toFixed(2)} (${pSign}${partialPnlPct.toFixed(2)}%) + stop 50% @ $${price.toFixed(2)}</i>`,
    )
  }
  lines.push(``, `👉 Trade encerrado. Abra o app para revisar.`)
  return lines.join('\n')
}

export function fmtWeeklyDigest(summary: {
  total: number; winrate: number; totalPnl: number;
  topError: string | null; bestAsset: string | null
}): string {
  const pnlSign = summary.totalPnl >= 0 ? '+' : ''
  return [
    `📅 <b>Digest Semanal — Melhor Trade</b>`,
    '',
    `📊 Trades fechados: <b>${summary.total}</b>`,
    `🎯 Win rate: <b>${summary.winrate.toFixed(1)}%</b>`,
    `💰 P&amp;L total: <b>${pnlSign}$${Math.abs(summary.totalPnl).toFixed(2)}</b>`,
    summary.topError  ? `❌ Erro mais frequente: <i>${summary.topError}</i>` : '',
    summary.bestAsset ? `🏆 Melhor ativo: <b>${summary.bestAsset}</b>` : '',
    '',
    `👉 Abrir Journal para análise completa`,
  ].filter(Boolean).join('\n')
}
