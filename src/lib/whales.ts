/**
 * Whale tracking via HyperLiquid public API.
 *
 * Fluxo:
 * 1. Busca leaderboard (top traders por PnL)
 * 2. Filtra por "qualidade": PnL positivo em múltiplos timeframes + conta grande
 * 3. Busca posições abertas de cada trader filtrado
 * 4. Agrega sentimento (long/short) por ativo
 */

const HL_INFO  = 'https://api.hyperliquid.xyz/info'
// Leaderboard fica num endpoint de stats separado (não aceita no /info → 422)
const HL_STATS = 'https://stats-data.hyperliquid.xyz/Mainnet/leaderboard'

const WHALE_TIMEOUT = 10_000  // 10s por chamada

/** POST para /info (clearinghouseState, allMids, etc.) */
async function hl(body: object) {
  const r = await fetch(HL_INFO, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
    signal:  AbortSignal.timeout(WHALE_TIMEOUT),
  })
  if (!r.ok) throw new Error(`HyperLiquid ${r.status}`)
  return r.json()
}

/** GET para o leaderboard de stats */
async function hlLeaderboard() {
  const r = await fetch(HL_STATS, {
    method:  'GET',
    headers: { 'Content-Type': 'application/json' },
    signal:  AbortSignal.timeout(WHALE_TIMEOUT),
  })
  if (!r.ok) throw new Error(`HyperLiquid ${r.status}`)
  return r.json()
}

// Ativos HL que mapeamos para nossos assets (crypto only)
const HL_TO_ASSET: Record<string, string> = {
  BTC: 'BTC', ETH: 'ETH', SOL: 'SOL', HYPE: 'HYPE',
  AAVE: 'AAVE', LINK: 'LINK', AVAX: 'AVAX', PAXG: 'GOLD',
  XRP: 'XRP', SUI: 'SUI', DOGE: 'DOGE', TAO: 'TAO',
}

export interface WhaleTrader {
  address:     string
  name:        string
  accountVal:  number
  pnl30d:      number
  pnl7d:       number
  pnl1d:       number
  qualScore:   number   // 0–10: proxy de win rate/consistência
}

export interface WhalePosition {
  address:    string
  traderName: string
  qualScore:  number
  asset:      string
  direction:  'long' | 'short'
  value:      number   // USD
  entryPx:    number
  pnlPct:     number
  leverage:   number
}

export interface AssetSentiment {
  asset:         string
  longCount:     number
  shortCount:    number
  longValue:     number
  shortValue:    number
  sentiment:     'bullish' | 'bearish' | 'neutral'
  sentimentPct:  number   // 0–100 (% longs por valor)
  topPositions:  WhalePosition[]
}

// ── Leaderboard + filtro de qualidade ────────────────────────────────────────
export async function fetchTopWhales(limit = 25): Promise<WhaleTrader[]> {
  const data = await hlLeaderboard()
  // stats endpoint pode retornar { leaderboardRows: [...] } ou array direto
  const rows: any[] = Array.isArray(data) ? data : (data.leaderboardRows ?? [])
  if (!rows.length) throw new Error(`HyperLiquid leaderboard vazio (shape: ${JSON.stringify(Object.keys(data ?? {})).slice(0, 80)})`)

  return rows
    .map((r: any) => {
      // HL retorna windowPerformances como array de arrays: [["day", {pnl,roi,vlm}], ...]
      const windowPerformances = (r.windowPerformances ?? []) as any[]
      const get = (name: string) => {
        const entry = windowPerformances.find((w: any) => w[0] === name)
        return parseFloat(entry?.[1]?.pnl ?? '0')
      }
      const pnl30d  = get('month')
      const pnl7d   = get('week')
      const pnl1d   = get('day')
      const accVal  = parseFloat(r.accountValue ?? '0')

      // Qualidade = consistência nos 3 timeframes + tamanho da conta
      let q = 0
      if (pnl30d  > 0) q += 3
      if (pnl7d   > 0) q += 2
      if (pnl1d   > 0) q += 1
      if (accVal  > 500_000) q += 2
      else if (accVal > 100_000) q += 1
      if (pnl30d  > accVal * 0.2) q += 1  // +20% mensal

      return {
        address:    r.ethAddress ?? '',
        name:       r.displayName ?? r.ethAddress?.slice(0, 8) ?? '?',
        accountVal: accVal,
        pnl30d, pnl7d, pnl1d,
        qualScore:  Math.min(q, 10),
      } as WhaleTrader
    })
    .filter(t => t.address && t.accountVal > 50_000 && t.pnl30d > 0)
    .sort((a, b) => b.qualScore - a.qualScore)
    .slice(0, limit)
}

// ── Posições abertas de um endereço ──────────────────────────────────────────
async function fetchPositions(trader: WhaleTrader): Promise<WhalePosition[]> {
  try {
    const state = await hl({ type: 'clearinghouseState', user: trader.address })
    const positions: any[] = state.assetPositions ?? []

    return positions
      .map((ap: any) => {
        const p     = ap.position ?? ap
        const coin  = p.coin ?? ''
        const asset = HL_TO_ASSET[coin]
        if (!asset) return null

        const szi   = parseFloat(p.szi ?? '0')
        if (szi === 0) return null

        const value   = Math.abs(parseFloat(p.positionValue ?? '0'))
        if (value < 5_000) return null  // ignora posições pequenas

        const entryPx   = parseFloat(p.entryPx ?? '0')
        const pnlPct    = parseFloat(p.returnOnEquity ?? '0') * 100
        const leverage  = parseFloat(p.leverage?.value ?? p.leverage ?? '1')

        return {
          address:    trader.address,
          traderName: trader.name,
          qualScore:  trader.qualScore,
          asset,
          direction:  szi > 0 ? 'long' : 'short',
          value,
          entryPx,
          pnlPct:     Math.round(pnlPct * 10) / 10,
          leverage:   Math.round(leverage),
        } as WhalePosition
      })
      .filter(Boolean) as WhalePosition[]
  } catch {
    return []
  }
}

// ── Sentimento agregado por ativo ─────────────────────────────────────────────
export async function fetchWhaleSentiment(): Promise<{
  traders:    WhaleTrader[]
  positions:  WhalePosition[]
  sentiment:  AssetSentiment[]
  updatedAt:  string
}> {
  const traders = await fetchTopWhales(25)

  // Busca posições em paralelo com timeout implícito por ativo
  const positionArrays = await Promise.allSettled(traders.map(t => fetchPositions(t)))
  const positions: WhalePosition[] = positionArrays
    .flatMap(r => r.status === 'fulfilled' ? r.value : [])

  // Agrega por ativo
  const byAsset: Record<string, AssetSentiment> = {}
  for (const pos of positions) {
    if (!byAsset[pos.asset]) {
      byAsset[pos.asset] = {
        asset: pos.asset, longCount: 0, shortCount: 0,
        longValue: 0, shortValue: 0,
        sentiment: 'neutral', sentimentPct: 50, topPositions: [],
      }
    }
    const s = byAsset[pos.asset]
    if (pos.direction === 'long') { s.longCount++; s.longValue += pos.value }
    else                          { s.shortCount++; s.shortValue += pos.value }
    s.topPositions.push(pos)
  }

  // Calcula sentimento final
  const sentiment = Object.values(byAsset)
    .map(s => {
      const total = s.longValue + s.shortValue
      const pct   = total > 0 ? (s.longValue / total) * 100 : 50
      return {
        ...s,
        sentimentPct: Math.round(pct),
        sentiment: pct >= 65 ? 'bullish' : pct <= 35 ? 'bearish' : 'neutral',
        topPositions: s.topPositions
          .sort((a, b) => b.qualScore - a.qualScore || b.value - a.value)
          .slice(0, 5),
      } as AssetSentiment
    })
    .sort((a, b) => (b.longValue + b.shortValue) - (a.longValue + a.shortValue))

  return { traders, positions, sentiment, updatedAt: new Date().toISOString() }
}
