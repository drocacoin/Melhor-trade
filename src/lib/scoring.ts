/**
 * Lógica de score ao vivo — espelha o detectSignal do scan route,
 * mas retorna os pontos em vez de decidir se gera sinal.
 * Reutilizado no Dashboard e na API /api/scores.
 */

export interface LiveScore {
  bullScore:  number
  bearScore:  number
  direction:  'bull' | 'bear' | 'neutral'
  topScore:   number   // maior dos dois
  maxPossible: number  // máximo teórico (para a barra de progresso)
  factors: {
    label:     string
    bull:      boolean
    bear:      boolean
    points:    number
  }[]
}

export function computeLiveScore(
  snaps: Record<string, any>,
  fg: { value: number; label: string } | null = null
): LiveScore {
  const d  = snaps['1d']
  const h4 = snaps['4h']
  const wk = snaps['1wk']

  let bullScore = 0
  let bearScore = 0

  const factors: LiveScore['factors'] = []

  function check(label: string, bull: boolean, bear: boolean, pts: number) {
    if (bull) bullScore += pts
    if (bear) bearScore += pts
    if (bull || bear) factors.push({ label, bull, bear, points: pts })
  }

  if (h4) {
    check('WT cruzado (oversold)',    h4.wt_cross_up   && h4.wt_zone === 'oversold',   false, 3)
    check('WT cruzado (overbought)',  false, h4.wt_cross_down && h4.wt_zone === 'overbought', 3)
    check('BOS altista (4h)',          h4.bos_up   ?? false, false,              2)
    check('BOS baixista (4h)',         false,       h4.bos_down ?? false,        2)
    check('Acima da nuvem (4h)',       h4.price_vs_cloud === 'above', false,      1)
    check('Abaixo da nuvem (4h)',      false, h4.price_vs_cloud === 'below',      1)
    check('Tenkan > Kijun (4h)',       h4.tenkan_vs_kijun === 'above', false,     1)
    check('Tenkan < Kijun (4h)',       false, h4.tenkan_vs_kijun === 'below',     1)
  }

  if (d) {
    check('Bias diário ALTISTA',  d.bias === 'ALTISTA',  false, 2)
    check('Bias diário BAIXISTA', false, d.bias === 'BAIXISTA', 2)
  }

  if (wk) {
    check('Bias semanal ALTISTA',  wk.bias === 'ALTISTA',  false, 1)
    check('Bias semanal BAIXISTA', false, wk.bias === 'BAIXISTA', 1)
  }

  // F&G penalisa (não aparece como fator positivo)
  if (fg) {
    if (fg.value >= 80) bullScore -= 1
    if (fg.value <= 20) bearScore -= 1
  }

  const topScore    = Math.max(bullScore, bearScore)
  const direction   = bullScore > bearScore ? 'bull' : bearScore > bullScore ? 'bear' : 'neutral'
  const maxPossible = 10 // 3+2+1+1+2+1 = 10 pts máximo

  return { bullScore, bearScore, direction, topScore, maxPossible, factors }
}
