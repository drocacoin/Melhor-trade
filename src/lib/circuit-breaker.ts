/**
 * Circuit breaker — avalia se o sistema deve pausar emissão de novos sinais.
 *
 * Critérios:
 *  1. Últimas 5 operações fechadas: ≥ 4 perdas → pausa
 *  2. Últimas 10 operações fechadas: WR < 25% → pausa
 *
 * Exportado como módulo para ser reutilizado no scan e no webhook /status.
 */

export interface CircuitBreakerResult {
  triggered: boolean
  reason:    string
  last5wr:   number | null   // WR dos últimos 5 trades (0-100)
  last10wr:  number | null   // WR dos últimos 10 trades (0-100)
}

export function evaluateCircuitBreaker(
  trades: { pnl_usd?: number | null; pnl_pct?: number | null }[]
): CircuitBreakerResult {
  const isWin = (t: any) => (t.pnl_usd ?? 0) > 0

  const last5   = trades.slice(0, 5)
  const last10  = trades.slice(0, 10)
  const last5wr  = last5.length  ? Math.round(last5.filter(isWin).length  / last5.length  * 100) : null
  const last10wr = last10.length ? Math.round(last10.filter(isWin).length / last10.length * 100) : null

  if (trades.length < 3) {
    return { triggered: false, reason: '', last5wr, last10wr }
  }

  // Regra 1: últimas 5 → ≥ 4 perdas (WR ≤ 20%)
  if (last5.length >= 5 && (last5wr ?? 100) <= 20) {
    const losses = last5.length - last5.filter(isWin).length
    return {
      triggered: true,
      reason:    `${losses}/${last5.length} perdas nos últimos 5 trades (WR ${last5wr}%)`,
      last5wr,
      last10wr,
    }
  }

  // Regra 2: últimas 10 → WR < 25%
  if (last10.length >= 10 && (last10wr ?? 100) < 25) {
    return {
      triggered: true,
      reason:    `WR ${last10wr}% nos últimos 10 trades — abaixo de 25%`,
      last5wr,
      last10wr,
    }
  }

  return { triggered: false, reason: '', last5wr, last10wr }
}
