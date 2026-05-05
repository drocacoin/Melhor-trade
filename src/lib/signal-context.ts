/**
 * Enriquece um sinal com contexto histórico, correlação e gestão de saída.
 * Chamado no scan route após detectar o sinal.
 */
import { CORRELATION_GROUPS } from '@/types'

// ─── Histórico do setup ────────────────────────────────────────────────────────
export interface SetupHistory {
  lastResults:  number[]        // P&L % das últimas ocorrências
  winRate:      number          // WR histórico neste ativo+direção
  totalTrades:  number
  avgPnlPct:    number
  avgWinPct:    number          // média dos trades vencedores (positivo)
  avgLossPct:   number          // média dos trades perdedores (valor absoluto)
}

export async function fetchSetupHistory(
  db: any,
  asset: string,
  direction: string
): Promise<SetupHistory | null> {
  const { data: trades } = await db
    .from('trades')
    .select('pnl_pct, pnl_usd')
    .eq('asset', asset)
    .eq('direction', direction)
    .eq('status', 'closed')
    .order('closed_at', { ascending: false })
    .limit(10)

  if (!trades?.length) return null

  const lastResults = trades.slice(0, 5).map((t: any) => Math.round((t.pnl_pct ?? 0) * 10) / 10)
  const winners     = trades.filter((t: any) => (t.pnl_usd ?? 0) > 0)
  const losers      = trades.filter((t: any) => (t.pnl_usd ?? 0) <= 0)
  const winRate     = Math.round((winners.length / trades.length) * 100)
  const avgPnlPct   = Math.round(trades.reduce((s: number, t: any) => s + (t.pnl_pct ?? 0), 0) / trades.length * 10) / 10
  const avgWinPct   = winners.length
    ? +(winners.reduce((s: number, t: any) => s + (t.pnl_pct ?? 0), 0) / winners.length).toFixed(2)
    : 0
  const avgLossPct  = losers.length
    ? +Math.abs(losers.reduce((s: number, t: any) => s + (t.pnl_pct ?? 0), 0) / losers.length).toFixed(2)
    : 0

  return { lastResults, winRate, totalTrades: trades.length, avgPnlPct, avgWinPct, avgLossPct }
}

// ─── Correlação entre posições ────────────────────────────────────────────────
export interface CorrelationAlert {
  hasAlert:      boolean
  openAssets:    string[]
  group:         string
  message:       string
}

export function checkCorrelation(
  asset: string,
  direction: string,
  openTrades: any[]
): CorrelationAlert {
  const group = Object.entries(CORRELATION_GROUPS).find(([, assets]) =>
    assets.includes(asset as any)
  )
  if (!group) return { hasAlert: false, openAssets: [], group: '', message: '' }

  const [groupName, groupAssets] = group

  const correlated = openTrades.filter(t =>
    t.status === 'open' &&
    t.asset !== asset &&
    groupAssets.includes(t.asset) &&
    t.direction === direction   // mesma direção = correlação de risco
  )

  if (!correlated.length) return { hasAlert: false, openAssets: [], group: groupName, message: '' }

  const names = correlated.map(t => t.asset).join(', ')
  return {
    hasAlert:   true,
    openAssets: correlated.map(t => t.asset),
    group:      groupName,
    message:    `${names} ${direction} já aberto — risco concentrado em ${groupName}`,
  }
}

// ─── Tamanho de posição — Kelly Criterion (½ Kelly) ──────────────────────────
/**
 * Fórmula Kelly: f* = p − (1−p)/b
 *   p = taxa de acerto (0..1)
 *   b = razão avgWin / avgLoss (R múltiplo real)
 *
 * Usamos ½ Kelly para reduzir drawdown (~75% do retorno ótimo com ~50% da volatilidade).
 * O resultado é mapeado linearmente para [0.5%, 2.5%] de capital a arriscar por trade.
 *
 * Escala: halfKelly=0.00 → 0.5% | halfKelly=0.50 → 2.5%
 *   riskPct = 0.5 + (halfKelly / 0.5) × 2.0  (clamped 0.5–2.5)
 */
export function suggestRisk(
  winRate:    number | null,
  avgWinPct:  number | null,   // P&L médio dos trades vencedores (> 0)
  avgLossPct: number | null,   // P&L médio dos trades perdedores (valor absoluto, > 0)
  rr:         number
): { riskPct: number; rationale: string; kelly: number | null } {

  // ── Kelly disponível ────────────────────────────────────────────────────────
  if (
    winRate    !== null &&
    avgWinPct  !== null && avgWinPct  > 0 &&
    avgLossPct !== null && avgLossPct > 0
  ) {
    const p   = winRate / 100
    const b   = avgWinPct / avgLossPct          // reward-to-risk real
    const fk  = p - (1 - p) / b                 // Kelly completo
    const hk  = fk / 2                          // ½ Kelly

    // Mapeamento linear para % de capital: hk=0→0.5%, hk=0.5→2.5%
    const raw     = 0.5 + (hk / 0.5) * 2.0
    const riskPct = +Math.min(Math.max(raw, 0.5), 2.5).toFixed(1)

    const bStr  = b.toFixed(2)
    const hkPct = (hk * 100).toFixed(1)

    if (fk <= 0) {
      return {
        riskPct:  0.5,
        rationale: `½ Kelly negativo (WR${winRate}% b=${bStr}) — sistema desfavorável, mínimo`,
        kelly:     +hk.toFixed(4),
      }
    }

    return {
      riskPct,
      rationale: `½ Kelly ${hkPct}% · WR${winRate}% · b=${bStr} (win÷loss) → ${riskPct}% capital`,
      kelly:     +hk.toFixed(4),
    }
  }

  // ── Fallback: sem histórico suficiente ────────────────────────────────────
  let riskPct  = 1.0
  let rationale = 'sem histórico (Kelly indisponível)'

  if (winRate !== null) {
    if (winRate >= 65)      { riskPct = 1.5; rationale = `WR ${winRate}% · fallback heurístico` }
    else if (winRate >= 50) { riskPct = 1.0; rationale = `WR ${winRate}% · fallback heurístico` }
    else                    { riskPct = 0.5; rationale = `WR ${winRate}% fraco · fallback heurístico` }
  }

  if (rr >= 3.5 && riskPct < 2.0) {
    riskPct   = Math.min(riskPct + 0.5, 2.0)
    rationale += ` + RR ${rr}:1 excelente`
  }

  return { riskPct, rationale, kelly: null }
}

// ─── Estratégia de saída ──────────────────────────────────────────────────────
export interface ExitStrategy {
  partial1:   string   // o que fazer no alvo 1
  partial2:   string   // o que fazer no alvo 2
  trailing:   string   // gestão de stop
}

export function buildExitStrategy(rr: number, target1: number, target2: number | null): ExitStrategy {
  return {
    partial1: `No alvo 1 ($${target1}): feche 50% da posição`,
    partial2: target2
      ? `No alvo 2 ($${target2}): feche mais 25% — deixe 25% correr`
      : 'Sem alvo 2 definido — feche 100% no alvo 1',
    trailing: rr >= 3
      ? 'Após alvo 1: mova stop para o preço de entrada (breakeven). Após alvo 2: mova para alvo 1.'
      : 'Após alvo 1: mova stop para entrada (breakeven)',
  }
}

// ─── Confluência de timeframes ────────────────────────────────────────────────
export function buildConfluence(
  snapshots: Record<string, any>,
  direction: 'long' | 'short'
): { count: number; total: number; visual: string; details: string } {
  const tfs  = ['1wk', '1d', '4h', '1h']
  const total = tfs.length
  let count   = 0
  const details: string[] = []

  for (const tf of tfs) {
    const s = snapshots[tf]
    if (!s) continue
    const aligned = direction === 'long' ? s.bias === 'ALTISTA' : s.bias === 'BAIXISTA'
    if (aligned) {
      count++
      details.push(`${tf}✅`)
    } else {
      details.push(`${tf}❌`)
    }
  }

  const green  = '🟢'.repeat(count)
  const gray   = '⬜'.repeat(total - count)
  const visual = `${green}${gray} ${count}/${total} TFs alinhados`

  return { count, total, visual, details: details.join(' ') }
}
