/**
 * Score ao vivo — espelha a lógica de detectSignal do scan, mas retorna
 * os pontos em vez de decidir se gera sinal.
 *
 * Reutilizado no Dashboard e na API /api/advisor.
 *
 * Melhorias v3:
 *  - WaveTrend por profundidade (não só zona binária)
 *  - EMA 200 como fator de tendência de longo prazo
 *  - Funding rate como penalidade de trades lotados
 *  - Open Interest crowding: OI/volume ratio como sinal de saturação
 */
import type { OIData } from '@/lib/fetcher'

export interface LiveScore {
  bullScore:   number
  bearScore:   number
  direction:   'bull' | 'bear' | 'neutral'
  topScore:    number
  maxPossible: number
  factors: {
    label:   string
    bull:    boolean
    bear:    boolean
    points:  number
  }[]
}

export function computeLiveScore(
  snaps:   Record<string, any>,
  fg:      { value: number; label: string } | null = null,
  funding: number | null = null,      // funding rate em decimal (0.0001 = 0.01%/8h)
  oi:      OIData | null = null,      // Open Interest data do HL
): LiveScore {
  const d  = snaps['1d']
  const h4 = snaps['4h']
  const wk = snaps['1wk']

  let bullScore = 0
  let bearScore = 0

  const factors: LiveScore['factors'] = []

  function add(label: string, bull: boolean, bear: boolean, pts: number) {
    if (pts === 0) return
    if (bull) bullScore += pts
    if (bear) bearScore += pts
    if (bull || bear) factors.push({ label, bull, bear, points: +pts.toFixed(2) })
  }

  if (h4) {
    // ── WaveTrend por profundidade (wt1 está salvo no DB) ────────────────────
    // Zona oversold: -53 a -100. Quanto mais negativo, mais extremo → mais pts
    if (h4.wt_cross_up && h4.wt_zone === 'oversold') {
      const depth = Math.abs(h4.wt1 ?? 53)
      const pts   = depth > 75 ? 4 : depth > 60 ? 3 : 2
      add(`WT cruzado oversold (prof. ${depth.toFixed(0)})`, true, false, pts)
    }
    if (h4.wt_cross_down && h4.wt_zone === 'overbought') {
      const depth = Math.abs(h4.wt1 ?? 53)
      const pts   = depth > 75 ? 4 : depth > 60 ? 3 : 2
      add(`WT cruzado overbought (prof. ${depth.toFixed(0)})`, false, true, pts)
    }

    // ── Break of Structure ────────────────────────────────────────────────────
    // No DB não temos volume, então mantemos peso fixo mas ligeiramente reduzido
    // (a versão do scan usa bos_volume_ok para +25% ou -50%)
    add('BOS altista (4h)',   h4.bos_up   ?? false, false,             2)
    add('BOS baixista (4h)',  false,       h4.bos_down ?? false,        2)

    // ── Ichimoku cloud ────────────────────────────────────────────────────────
    add('Acima da nuvem (4h)',  h4.price_vs_cloud === 'above', false,   1)
    add('Abaixo da nuvem (4h)', false, h4.price_vs_cloud === 'below',   1)

    // ── Tenkan vs Kijun ────────────────────────────────────────────────────────
    add('Tenkan > Kijun (4h)',  h4.tenkan_vs_kijun === 'above', false,  1)
    add('Tenkan < Kijun (4h)',  false, h4.tenkan_vs_kijun === 'below',  1)

    // ── EMA 200 — tendência de longo prazo (novo em v2) ───────────────────────
    add('EMA200 altista (4h)',  h4.price_vs_ema === 'above', false,    0.5)
    add('EMA200 baixista (4h)', false, h4.price_vs_ema === 'below',    0.5)
  }

  if (d) {
    add('Bias diário ALTISTA',   d.bias === 'ALTISTA',  false, 2)
    add('Bias diário BAIXISTA',  false, d.bias === 'BAIXISTA', 2)

    // EMA 200 diário — confirmação de tendência maior
    add('EMA200 altista (1d)',   d.price_vs_ema === 'above', false,    0.5)
    add('EMA200 baixista (1d)',  false, d.price_vs_ema === 'below',    0.5)
  }

  if (wk) {
    add('Bias semanal ALTISTA',  wk.bias === 'ALTISTA',  false, 1)
    add('Bias semanal BAIXISTA', false, wk.bias === 'BAIXISTA', 1)
  }

  // ── Fear & Greed extremo (penalidade) ────────────────────────────────────
  if (fg) {
    if (fg.value >= 80) { bullScore -= 1; factors.push({ label: `F&G extremo greed (${fg.value})`, bull: false, bear: false, points: -1 }) }
    if (fg.value <= 20) { bearScore -= 1; factors.push({ label: `F&G extremo fear (${fg.value})`,  bull: false, bear: false, points: -1 }) }
  }

  // ── Funding rate — penalidade de trades lotados (novo em v2) ─────────────
  if (funding !== null) {
    if (funding > 0.0007) {
      bullScore -= 2
      factors.push({ label: `Funding alto +${(funding * 100).toFixed(4)}%/8h (longs lotados)`, bull: false, bear: false, points: -2 })
    } else if (funding > 0.0004) {
      bullScore -= 1
      factors.push({ label: `Funding elevado +${(funding * 100).toFixed(4)}%/8h`, bull: false, bear: false, points: -1 })
    } else if (funding < -0.0005) {
      bearScore -= 1.5
      factors.push({ label: `Funding negativo ${(funding * 100).toFixed(4)}%/8h (squeeze setup)`, bull: false, bear: false, points: -1.5 })
    } else if (funding < -0.0002) {
      bearScore -= 0.5
      factors.push({ label: `Funding levemente negativo ${(funding * 100).toFixed(4)}%/8h`, bull: false, bear: false, points: -0.5 })
    }
  }

  // ── Open Interest crowding (v3) ──────────────────────────────────────────
  // crowdingRatio = OI / volume 24h.  >4 = alto, >6 = extremo.
  // Combinado com funding indica saturação direcional.
  if (oi !== null && oi.crowdingRatio > 0) {
    const cr = oi.crowdingRatio
    const fmtOI = oi.oiUsd >= 1e9
      ? `$${(oi.oiUsd / 1e9).toFixed(1)}B`
      : `$${(oi.oiUsd / 1e6).toFixed(0)}M`

    if (cr > 4 && funding !== null && funding > 0.0003) {
      // OI alto + funding positivo = longs muito lotados
      const pen = cr > 6 ? 1.5 : 1
      bullScore -= pen
      factors.push({ label: `OI crowding ${cr.toFixed(1)}× vol (${fmtOI}) + funding alto → longs saturados`, bull: false, bear: false, points: -pen })
    } else if (cr > 4 && funding !== null && funding < -0.0002) {
      // OI alto + funding negativo = shorts muito lotados → squeeze risk
      const pen = cr > 6 ? 1.5 : 1
      bearScore -= pen
      factors.push({ label: `OI crowding ${cr.toFixed(1)}× vol (${fmtOI}) + funding neg → shorts saturados`, bull: false, bear: false, points: -pen })
    } else if (cr > 6) {
      // OI extremo sem funding decisivo = mercado sobrecarregado (move brusco esperado)
      factors.push({ label: `OI extremo ${cr.toFixed(1)}× vol (${fmtOI}) — move violento possível`, bull: false, bear: false, points: 0 })
    }
  }

  const topScore    = Math.max(bullScore, bearScore)
  const direction   = bullScore > bearScore ? 'bull' : bearScore > bullScore ? 'bear' : 'neutral'
  const maxPossible = 13  // v3: mesma base + OI como penalidade (não adiciona ao máximo)

  return { bullScore, bearScore, direction, topScore, maxPossible, factors }
}
