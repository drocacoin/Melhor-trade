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
  const winRate     = Math.round((winners.length / trades.length) * 100)
  const avgPnlPct   = Math.round(trades.reduce((s: number, t: any) => s + (t.pnl_pct ?? 0), 0) / trades.length * 10) / 10

  return { lastResults, winRate, totalTrades: trades.length, avgPnlPct }
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

// ─── Tamanho de posição sugerido ──────────────────────────────────────────────
export function suggestRisk(
  winRate: number | null,
  rr: number
): { riskPct: number; rationale: string } {
  // Baseado em WR histórico — quanto maior o WR, mais arrojado
  let riskPct: number
  let rationale: string

  if (winRate === null) {
    riskPct  = 1.0
    rationale = 'sem histórico suficiente'
  } else if (winRate >= 65) {
    riskPct  = 2.0
    rationale = `WR ${winRate}% — histórico forte`
  } else if (winRate >= 55) {
    riskPct  = 1.5
    rationale = `WR ${winRate}% — histórico positivo`
  } else if (winRate >= 45) {
    riskPct  = 1.0
    rationale = `WR ${winRate}% — histórico misto`
  } else {
    riskPct  = 0.5
    rationale = `WR ${winRate}% — histórico fraco, cautela`
  }

  // RR bônus — se RR for excelente, risco um pouco maior vale
  if (rr >= 3.5 && riskPct < 2.0) {
    riskPct  = Math.min(riskPct + 0.5, 2.0)
    rationale += ` + RR ${rr}:1 excelente`
  }

  return { riskPct, rationale }
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
