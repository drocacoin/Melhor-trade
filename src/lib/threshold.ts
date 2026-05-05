/**
 * Threshold dinâmico de score por ativo.
 *
 * O threshold é o score mínimo para gerar um sinal.
 * Ajusta conforme Win Rate histórico + Profit Factor.
 *
 * Tabela de decisão:
 * | Situação              | Threshold | Status   |
 * |-----------------------|-----------|----------|
 * | < 5 trades            |     6     | default  |
 * | WR ≥ 60%              |     6     | ok       |
 * | WR 45–59%             |     7     | warning  |
 * | WR 30–44%             |     8     | danger   |
 * | WR < 30%              |     8*    | blocked  |
 * (*) 8 em vez de 9 — 9 era inalcançável com scoring máx ~12-13
 *
 * Bônus de confiança: ≥20 trades com WR ≥ 60% → threshold 5.5 (arredonda p/ 6)
 */

export const MIN_TRADES_FOR_DYNAMIC = 5

export interface ThresholdInfo {
  threshold:    number
  reason:       string
  status:       'default' | 'ok' | 'warning' | 'danger' | 'blocked'
  /** Profit Factor calculado (se disponível) */
  profit_factor?: number
}

export function computeThreshold(perf: any): ThresholdInfo {
  if (!perf || perf.total_trades < MIN_TRADES_FOR_DYNAMIC) {
    return { threshold: 6, reason: 'sem histórico suficiente', status: 'default' }
  }

  const wr    = parseFloat(perf.winrate_pct ?? '0')
  const n     = parseInt(perf.total_trades ?? '0', 10)
  const pnlW  = parseFloat(perf.avg_win_pct  ?? '0')
  const pnlL  = Math.abs(parseFloat(perf.avg_loss_pct ?? '0'))

  // Profit Factor = (avg_win × wins) / (avg_loss × losses)
  const wins    = Math.round(n * wr / 100)
  const losses  = n - wins
  const pf      = losses > 0 && pnlL > 0
    ? (pnlW * wins) / (pnlL * losses)
    : null

  // Ajuste por Profit Factor: bom PF relaxa threshold em 0.5
  const pfBonus = pf !== null && pf >= 1.5 ? 0.5 : 0

  // Ajuste por amostra grande e consistente: ≥20 trades com WR≥60% → -0.5
  const sampleBonus = n >= 20 && wr >= 60 ? 0.5 : 0

  const bonus = pfBonus + sampleBonus

  const label = `WR ${wr.toFixed(0)}% · ${n} trades${pf ? ` · PF ${pf.toFixed(2)}` : ''}`

  if (wr >= 60) {
    const thr = Math.max(5, 6 - bonus)
    return { threshold: thr, reason: label, status: 'ok', profit_factor: pf ?? undefined }
  }
  if (wr >= 45) {
    return { threshold: 7, reason: label, status: 'warning', profit_factor: pf ?? undefined }
  }
  if (wr >= 30) {
    return { threshold: 8, reason: label, status: 'danger', profit_factor: pf ?? undefined }
  }
  // WR < 30% → antes era 9 (impossível). Agora 8 com aviso de sistema em risco.
  return { threshold: 8, reason: `⚠ ${label} — sistema em risco`, status: 'blocked', profit_factor: pf ?? undefined }
}
