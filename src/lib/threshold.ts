/**
 * Threshold dinâmico de score por ativo.
 * Reutilizado no scanner e no Dashboard.
 */

export const MIN_TRADES_FOR_DYNAMIC = 5

export interface ThresholdInfo {
  threshold: number
  reason:    string
  status:    'default' | 'ok' | 'warning' | 'danger' | 'blocked'
}

/**
 * Calcula o score mínimo necessário para gerar um sinal no ativo.
 *
 * | Win Rate    | Threshold | Status  |
 * |-------------|-----------|---------|
 * | < 5 trades  |     6     | default |
 * | >= 60%      |     6     | ok      |
 * | 45–59%      |     7     | warning |
 * | 30–44%      |     8     | danger  |
 * | < 30%       |     9     | blocked |
 */
export function computeThreshold(perf: any): ThresholdInfo {
  if (!perf || perf.total_trades < MIN_TRADES_FOR_DYNAMIC) {
    return { threshold: 6, reason: 'sem histórico', status: 'default' }
  }

  const wr = parseFloat(perf.winrate_pct)
  const n  = perf.total_trades

  if (wr >= 60) return { threshold: 6, reason: `WR ${wr.toFixed(0)}% · ${n} trades`, status: 'ok'      }
  if (wr >= 45) return { threshold: 7, reason: `WR ${wr.toFixed(0)}% · ${n} trades`, status: 'warning' }
  if (wr >= 30) return { threshold: 8, reason: `WR ${wr.toFixed(0)}% · ${n} trades`, status: 'danger'  }
  return               { threshold: 9, reason: `WR ${wr.toFixed(0)}% · ${n} trades`, status: 'blocked' }
}
