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
  signal: any,
  fg: { value: number; label: string } | null,
  funding: number | null
): string {
  const emoji    = signal.direction === 'long' ? '🟢' : '🔴'
  const dir      = signal.direction === 'long' ? 'LONG ▲' : 'SHORT ▼'
  const gradeMap: Record<string, string> = { 'A+': '⭐⭐', A: '⭐', B: '🔵', C: '🟡' }
  const stars    = gradeMap[signal.setup_grade] ?? ''

  const lines = [
    `${emoji} <b>SINAL ${signal.setup_grade} ${stars} — ${signal.asset}</b>`,
    `Direção: <b>${dir}</b>`,
  ]

  if (fg) {
    const fgEmoji = fg.value >= 75 ? '🤑' : fg.value <= 25 ? '😱' : '😐'
    lines.push(`Fear &amp; Greed: ${fgEmoji} <b>${fg.value}</b> — ${fg.label}`)
  }

  if (funding !== null) {
    const fSign = funding >= 0 ? '+' : ''
    const fEmoji = funding > 0.0005 ? '🔥' : funding < -0.0005 ? '🧊' : '➖'
    lines.push(`Funding Rate: ${fEmoji} <code>${fSign}${(funding * 100).toFixed(4)}%</code>`)
  }

  lines.push(
    '',
    `📍 Entrada: <code>$${signal.entry_zone_low} – $${signal.entry_zone_high}</code>`,
    `🛑 Stop:    <code>$${signal.stop}</code>`,
    `🎯 Alvo 1:  <code>$${signal.target1}</code>  (RR <b>${signal.rr1}:1</b>)`,
    `🎯 Alvo 2:  <code>$${signal.target2}</code>`,
    '',
    `⚡ <i>${signal.trigger}</i>`,
    `❌ Cancela: <i>${signal.cancellation}</i>`,
  )

  // Análise IA — incluída se disponível (auto-gerada pelo Haiku no scan)
  if (signal.analysis) {
    // Limpa markdown e trunca para caber no Telegram (4096 chars total)
    const cleanAnalysis = signal.analysis
      .replace(/\*\*/g, '<b>').replace(/\*\*/g, '</b>')
      .slice(0, 900)
    lines.push('', `✦ <b>Análise Rápida IA</b>`, cleanAnalysis)
  }

  lines.push('', `👉 Abrir app → Alertas → ${signal.asset}`)

  return lines.join('\n')
}

export function fmtScanSummary(
  biases:     Record<string, string>,
  fg:         { value: number; label: string } | null,
  fundings:   Record<string, number | null>,
  thresholds: Record<string, { threshold: number; reason: string }>,
  newSignals: number,
  now:        string
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

  lines.push(
    '',
    newSignals > 0
      ? `🚨 <b>${newSignals} novo(s) sinal(is) detectado(s)!</b>`
      : '✅ Sem novos sinais.',
  )

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
