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

/**
 * Sinal compacto — o que chega automaticamente no Telegram.
 * ~12 linhas: apenas o essencial para decidir se entra ou não.
 * Detalhes técnicos ficam em /detalhe {ativo}.
 */
export function fmtSignal(
  signal:  any,
  fg:      { value: number; label: string } | null,
  funding: number | null,
): string {
  const emoji = signal.direction === 'long' ? '🟢' : '🔴'
  const dir   = signal.direction === 'long' ? 'LONG ▲' : 'SHORT ▼'
  const stars = signal.setup_grade === 'A+' ? ' ⭐⭐' : signal.setup_grade === 'A' ? ' ⭐' : ''
  const conf  = signal.confidence_pct != null ? ` · <b>${signal.confidence_pct}%</b> conf` : ''

  // Distâncias percentuais baseadas no mid da zona de entrada
  const mid     = ((signal.entry_zone_low ?? 0) + (signal.entry_zone_high ?? 0)) / 2
  const stopPct = mid > 0 && signal.stop
    ? ` (-${Math.abs((signal.stop    - mid) / mid * 100).toFixed(1)}%)`
    : ''
  const t1Pct   = mid > 0 && signal.target1
    ? ` (+${Math.abs((signal.target1 - mid) / mid * 100).toFixed(1)}%)`
    : ''

  const lines: (string | null)[] = [
    `${emoji} <b>SINAL ${signal.setup_grade}${stars} — ${signal.asset} ${dir}</b>${conf}`,
    ``,
    `📍 <code>$${signal.entry_zone_low} – $${signal.entry_zone_high}</code>`,
    `🛑 Stop:   <code>$${signal.stop}</code>${stopPct}`,
    `🎯 Alvo 1: <code>$${signal.target1}</code>${t1Pct} | RR <b>${signal.rr1}:1</b>`,
    signal.target2 ? `🎯 Alvo 2: <code>$${signal.target2}</code>` : null,
    ``,
  ]

  // WR fraco — aviso direto, sem bloco técnico
  if (signal.low_wr_warning && signal.history) {
    lines.push(`⚠️ WR histórico fraco: <b>${signal.history.winRate}%</b> (${signal.history.totalTrades} trades) — reduza o tamanho.`)
  }

  // Risco sugerido — só o número, sem fórmula
  if (signal.riskSuggest) {
    lines.push(`💰 Arrisque <b>${signal.riskSuggest.riskPct}% do capital</b>`)
  }

  // Histórico resumido — 1 linha
  if (signal.history && signal.history.totalTrades >= 3) {
    const wrEmoji = signal.history.winRate >= 60 ? '✅' : signal.history.winRate >= 45 ? '⚠️' : '❌'
    lines.push(`📊 Histórico ${signal.asset}: WR <b>${signal.history.winRate}%</b> ${wrEmoji} (${signal.history.totalTrades} trades)`)
  }

  lines.push(``)

  // Correlação — aviso se houver posição correlacionada aberta
  if (signal.correlation?.hasAlert) {
    lines.push(`⚠️ <b>Correlação:</b> ${signal.correlation.message}`)
    lines.push(``)
  }

  // Análise IA — apenas 1 frase curta
  if (signal.analysis) {
    const sentence = signal.analysis.replace(/\*\*/g, '').split(/(?<=[.!?])\s/)[0]?.trim() ?? ''
    if (sentence) {
      lines.push(`✦ <i>${sentence.slice(0, 180)}.</i>`)
      lines.push(``)
    }
  }

  const assetLower = (signal.asset ?? '').toLowerCase()
  lines.push(`👉 /detalhe_${assetLower} — análise técnica completa`)

  return lines.filter(l => l !== null).join('\n')
}

/**
 * Sinal detalhado — retornado pelo comando /detalhe {ativo}.
 * Contém tudo: confluência, F&G, funding, baleias, histórico completo,
 * gestão de saída, Kelly, gatilho/cancelamento, análise IA completa.
 */
export function fmtSignalDetail(
  signal:  any,
  fg:      { value: number; label: string } | null,
  funding: number | null,
): string {
  const emoji    = signal.direction === 'long' ? '🟢' : '🔴'
  const dir      = signal.direction === 'long' ? 'LONG ▲' : 'SHORT ▼'
  const gradeMap: Record<string, string> = { 'A+': '⭐⭐', A: '⭐', B: '🔵' }
  const stars    = gradeMap[signal.setup_grade] ?? ''
  const conf     = signal.confidence_pct != null ? ` · <b>${signal.confidence_pct}%</b> conf` : ''

  const lines: (string | null)[] = [
    `${emoji} <b>DETALHE — ${signal.asset} ${signal.setup_grade} ${stars} ${dir}</b>${conf}`,
    ``,
  ]

  // Confluência de timeframes
  if (signal.confluence) {
    lines.push(`📊 Confluência: ${signal.confluence.visual}`)
    lines.push(`   ${signal.confluence.details}`)
    lines.push(``)
  }

  // Sentimento macro
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
  if (sentLines.length) { lines.push(sentLines.join(' | ')); lines.push(``) }

  // Baleias
  if (signal.whale_sentiment && signal.whale_count >= 2) {
    const wEmoji   = signal.whale_sentiment === 'bullish' ? '🟢' : signal.whale_sentiment === 'bearish' ? '🔴' : '🟡'
    const confirms = (signal.direction === 'long'  && signal.whale_sentiment === 'bullish')
                  || (signal.direction === 'short' && signal.whale_sentiment === 'bearish')
    lines.push(`🐳 Baleias (${signal.whale_count} traders): ${wEmoji} ${signal.whale_pct}% long ${confirms ? '✅ confirma' : '⚠️ diverge'}`)
    lines.push(``)
  }

  // Níveis
  const mid     = ((signal.entry_zone_low ?? 0) + (signal.entry_zone_high ?? 0)) / 2
  const stopPct = mid > 0 && signal.stop    ? ` (-${Math.abs((signal.stop    - mid) / mid * 100).toFixed(1)}%)` : ''
  const t1Pct   = mid > 0 && signal.target1 ? ` (+${Math.abs((signal.target1 - mid) / mid * 100).toFixed(1)}%)` : ''

  lines.push(
    `📍 Entrada:  <code>$${signal.entry_zone_low} – $${signal.entry_zone_high}</code>`,
    `🛑 Stop:     <code>$${signal.stop}</code>${stopPct}`,
    `🎯 Alvo 1:   <code>$${signal.target1}</code>${t1Pct} | RR <b>${signal.rr1}:1</b>`,
    signal.target2 ? `🎯 Alvo 2:   <code>$${signal.target2}</code>` : null,
    ``,
  )

  // Correlação
  if (signal.correlation?.hasAlert) {
    lines.push(`⚠️ <b>Correlação:</b> ${signal.correlation.message}`, ``)
  }

  // Histórico completo
  if (signal.history && signal.history.totalTrades >= 3) {
    const h       = signal.history
    const res     = h.lastResults.slice(0, 5).map((p: number) => `${p >= 0 ? '+' : ''}${p}%`).join(' | ')
    const wrColor = h.winRate >= 60 ? '✅' : h.winRate >= 45 ? '⚠️' : '❌'
    lines.push(
      `📜 <b>Histórico ${signal.asset} ${signal.direction}:</b>`,
      `   ${res}`,
      `   WR: <b>${h.winRate}%</b> ${wrColor} (${h.totalTrades} trades) | Média: ${h.avgPnlPct >= 0 ? '+' : ''}${h.avgPnlPct}%`,
      ``,
    )
  }

  // Gestão de saída
  if (signal.exitStrategy) {
    const e = signal.exitStrategy
    lines.push(`🎯 <b>Gestão:</b>`, `   ${e.partial1}`, `   ${e.trailing}`, ``)
  }

  // Risco com racional
  if (signal.riskSuggest) {
    lines.push(`💰 Risco: <b>${signal.riskSuggest.riskPct}% do capital</b> (${signal.riskSuggest.rationale})`)
    lines.push(``)
  }

  // Gatilho e cancelamento
  lines.push(`⚡ <i>${signal.trigger}</i>`, `❌ Cancela: <i>${signal.cancellation}</i>`, ``)

  // Análise IA completa
  if (signal.analysis) {
    lines.push(`✦ <b>Análise IA</b>`, signal.analysis.slice(0, 900))
  }

  return (lines.filter(l => l !== null) as string[]).join('\n')
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
