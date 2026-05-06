/**
 * Motor de auto-evolução do scoring.
 *
 * Rodado automaticamente:
 *  - Após cada 5 trades fechados (chamado pelo close route)
 *  - Toda semana junto com o digest
 *
 * O que faz:
 *  1. Analisa quais indicadores estiveram presentes em trades vencedores vs perdedores
 *  2. Recalcula o peso de cada indicador com base no win rate real
 *  3. Claude Haiku interpreta os padrões e adiciona insights
 *  4. Salva os novos pesos — scanner passa a usá-los na próxima scan
 */
import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { supabaseAdmin } from '@/lib/supabase'

const FACTORS = [
  { key: 'wt_cross_oversold',   label: 'WT cruzado + oversold (4h)' },
  { key: 'bos_up',              label: 'BOS altista (4h)' },
  { key: 'price_vs_cloud',      label: 'Acima da nuvem (4h)' },
  { key: 'tenkan_vs_kijun',     label: 'Tenkan > Kijun (4h)' },
  { key: 'daily_bias',          label: 'Bias diário ALTISTA' },
  { key: 'weekly_bias',         label: 'Bias semanal ALTISTA' },
  { key: 'wt_cross_overbought', label: 'WT cruzado + overbought (4h)' },
  { key: 'bos_down',            label: 'BOS baixista (4h)' },
]

const MIN_WEIGHT = 0.5   // nenhum fator some completamente
const MAX_WEIGHT = 2.0   // nenhum fator domina demais

// Pontos base de cada fator — loadWeights faz weight × base_points
// Estes são os mesmos do DEFAULT_WEIGHTS em src/lib/weights.ts
const FACTOR_BASE_POINTS: Record<string, number> = {
  wt_cross_oversold:   3,
  bos_up:              2,
  price_vs_cloud:      1,
  tenkan_vs_kijun:     1,
  daily_bias:          2,
  weekly_bias:         1,
  wt_cross_overbought: 3,
  bos_down:            2,
}

export async function GET(req: NextRequest) {
  const bearer = req.headers.get('authorization')?.replace('Bearer ', '')
  const secret = bearer ?? req.headers.get('x-cron-secret') ?? req.nextUrl.searchParams.get('secret')
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const db = supabaseAdmin()

  // ── Buscar trades fechados com seus snapshots de entrada ──────────────────
  const { data: trades } = await db
    .from('trades')
    .select('id, asset, direction, pnl_usd, opened_at, closed_at')
    .eq('status', 'closed')
    .order('closed_at', { ascending: false })
    .limit(100)  // últimos 100 trades

  if (!trades?.length || trades.length < 10) {
    return NextResponse.json({ ok: true, message: 'Poucos dados — mínimo 10 trades para evoluir' })
  }

  // ── Holdout split: treina em trades mais antigos, valida em mais recentes ──
  // Trades estão ordenados desc (mais recente primeiro).
  // Holdout = 20% mais recentes (simulação fora-de-amostra)
  // Treino  = 80% mais antigos
  const holdoutCount = Math.max(2, Math.floor(trades.length * 0.2))
  const holdoutTrades = trades.slice(0, holdoutCount)
  const trainTrades   = trades.slice(holdoutCount)

  // ── Função auxiliar: extrai factor stats de um conjunto de trades ─────────
  type FactorStats = Record<string, { wins: number; losses: number }>
  type AssetStats  = Record<string, FactorStats>

  async function computeFactorStats(tradeSet: NonNullable<typeof trades>): Promise<{ global: FactorStats; byAsset: AssetStats }> {
    const global: FactorStats = {}
    const byAsset: AssetStats = {}
    for (const factor of FACTORS) global[factor.key] = { wins: 0, losses: 0 }

    for (const trade of tradeSet) {
      const isWin  = (trade.pnl_usd ?? 0) > 0
      const isLong = trade.direction === 'long'
      const date   = trade.opened_at?.slice(0, 10)
      if (!date) continue

      const { data: snaps } = await db
        .from('snapshots')
        .select('timeframe, wt_cross_up, wt_cross_down, wt_zone, bos_up, bos_down, price_vs_cloud, tenkan_vs_kijun, bias')
        .eq('asset', trade.asset)
        .gte('captured_at', `${date}T00:00:00`)
        .lte('captured_at', `${date}T23:59:59`)
        .order('captured_at', { ascending: true })

      if (!snaps?.length) continue

      const byTf: Record<string, any> = {}
      for (const s of snaps) { byTf[s.timeframe] = s }

      const h4 = byTf['4h']
      const d  = byTf['1d']
      const wk = byTf['1wk']

      const active: Record<string, boolean> = {
        wt_cross_oversold:   isLong  && h4?.wt_cross_up   && h4?.wt_zone === 'oversold',
        bos_up:              isLong  && h4?.bos_up,
        price_vs_cloud:      isLong  ? h4?.price_vs_cloud === 'above' : h4?.price_vs_cloud === 'below',
        tenkan_vs_kijun:     isLong  ? h4?.tenkan_vs_kijun === 'above' : h4?.tenkan_vs_kijun === 'below',
        daily_bias:          isLong  ? d?.bias === 'ALTISTA' : d?.bias === 'BAIXISTA',
        weekly_bias:         isLong  ? wk?.bias === 'ALTISTA' : wk?.bias === 'BAIXISTA',
        wt_cross_overbought: !isLong && h4?.wt_cross_down  && h4?.wt_zone === 'overbought',
        bos_down:            !isLong && h4?.bos_down,
      }

      for (const [factor, wasActive] of Object.entries(active)) {
        if (!wasActive) continue
        if (isWin) global[factor].wins++
        else       global[factor].losses++

        if (!byAsset[trade.asset]) {
          byAsset[trade.asset] = {}
          for (const f of FACTORS) byAsset[trade.asset][f.key] = { wins: 0, losses: 0 }
        }
        if (isWin) byAsset[trade.asset][factor].wins++
        else       byAsset[trade.asset][factor].losses++
      }
    }
    return { global, byAsset }
  }

  // Computa stats em paralelo para treino e holdout
  const [trainResult, holdoutResult] = await Promise.all([
    computeFactorStats(trainTrades),
    computeFactorStats(holdoutTrades),
  ])

  const factorStats     = trainResult.global
  const assetFactorStats = trainResult.byAsset

  // ── Calcular novos pesos com validação holdout ────────────────────────────
  const overallWR        = trainTrades.filter(t => (t.pnl_usd ?? 0) > 0).length / trainTrades.length
  const holdoutOverallWR = holdoutTrades.filter(t => (t.pnl_usd ?? 0) > 0).length / holdoutTrades.length
  const changes: any[] = []

  for (const factor of FACTORS) {
    const stats   = factorStats[factor.key]
    const total   = stats.wins + stats.losses
    if (total < 3) continue  // dados insuficientes para este fator

    const factorWR  = stats.wins / total
    // Peso = quão melhor este fator é vs a média geral
    const rawWeight = overallWR > 0 ? factorWR / overallWR : 1.0
    let   newWeight = Math.min(MAX_WEIGHT, Math.max(MIN_WEIGHT, Math.round(rawWeight * 10) / 10))

    // ── Validação holdout: verifica consistência direcional ──────────────
    // Se treino diz "fator bom" mas holdout diz "fator ruim" → possível overfit
    let holdoutValidated = true
    let holdoutNote      = ''
    const hStats = holdoutResult.global[factor.key]
    const hTotal = hStats.wins + hStats.losses

    if (hTotal >= 2) {
      const holdoutFactorWR  = hStats.wins / hTotal
      const trainAboveBase   = factorWR   > overallWR
      const holdoutAboveBase = holdoutFactorWR > holdoutOverallWR
      // Consistente = ambos acima ou ambos abaixo da baseline
      if (trainAboveBase !== holdoutAboveBase) {
        holdoutValidated = false
        holdoutNote = `holdout inconsistente (train WR=${Math.round(factorWR*100)}% vs holdout WR=${Math.round(holdoutFactorWR*100)}%)`
        // Regressão para neutro — não aplica mudança extrema
        newWeight = Math.round((newWeight + 1.0) / 2 * 10) / 10
      } else {
        holdoutNote = `ok (holdout WR=${Math.round(holdoutFactorWR*100)}%, n=${hTotal})`
      }
    }

    const { error } = await db.from('scoring_weights')
      .upsert({
        asset:           null,
        factor:          factor.key,
        base_points:     FACTOR_BASE_POINTS[factor.key] ?? 1,
        weight:          newWeight,
        win_count:       stats.wins,
        loss_count:      stats.losses,
        win_rate_pct:    Math.round(factorWR * 1000) / 10,
        last_evolved_at: new Date().toISOString(),
        updated_at:      new Date().toISOString(),
      }, { onConflict: 'asset,factor' })

    if (!error) {
      changes.push({
        factor:   factor.key,
        label:    factor.label,
        newWeight,
        factorWR: Math.round(factorWR * 100),
        total,
        holdoutValidated,
        holdoutNote,
      })
    }
  }

  // ── Pesos por ativo específico (usando apenas trainTrades) ──────────────────
  for (const [asset, aStats] of Object.entries(assetFactorStats)) {
    const assetTrades = trainTrades.filter(t => t.asset === asset)
    if (assetTrades.length < 5) continue  // mínimo 5 trades por ativo

    const assetWR = assetTrades.filter(t => (t.pnl_usd ?? 0) > 0).length / assetTrades.length

    for (const factor of FACTORS) {
      const stats = aStats[factor.key]
      const total = stats.wins + stats.losses
      if (total < 3) continue

      const factorWR  = stats.wins / total
      const rawWeight = assetWR > 0 ? factorWR / assetWR : 1.0
      const newWeight = Math.min(MAX_WEIGHT, Math.max(MIN_WEIGHT, Math.round(rawWeight * 10) / 10))

      await db.from('scoring_weights').upsert({
        asset,
        factor:          factor.key,
        base_points:     FACTOR_BASE_POINTS[factor.key] ?? 1,
        weight:          newWeight,
        win_count:       stats.wins,
        loss_count:      stats.losses,
        win_rate_pct:    Math.round(factorWR * 1000) / 10,
        last_evolved_at: new Date().toISOString(),
        updated_at:      new Date().toISOString(),
      }, { onConflict: 'asset,factor' })
    }
  }

  // ── Claude Haiku interpreta as mudanças ───────────────────────────────────
  const inconsistentCount = changes.filter(c => !c.holdoutValidated).length
  let aiInsights = ''
  if (changes.length > 0 && process.env.ANTHROPIC_API_KEY) {
    try {
      const changeLines = changes
        .map(c => {
          const hvTag = c.holdoutValidated ? `✓ ${c.holdoutNote}` : `⚠ ${c.holdoutNote} → peso suavizado`
          return `${c.label}: WR=${c.factorWR}% | peso=${c.newWeight} | n=${c.total} | ${hvTag}`
        })
        .join('\n')

      const client  = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
      const message = await client.messages.create({
        model:      'claude-haiku-4-5',
        max_tokens: 350,
        messages:   [{
          role:    'user',
          content: `Analise esta evolução do sistema de scoring de um trader de swing trade.
Treino: ${trainTrades.length} trades (WR ${Math.round(overallWR * 100)}%) | Holdout: ${holdoutTrades.length} trades (WR ${Math.round(holdoutOverallWR * 100)}%) | ${inconsistentCount} fatores inconsistentes.
Explique em 2-3 frases quais indicadores estão funcionando e se o modelo parece overfit.

DADOS:
${changeLines}`,
        }],
      })
      aiInsights = (message.content[0] as any).text
    } catch { /* silencioso */ }
  }

  // ── Salvar log da evolução ────────────────────────────────────────────────
  await db.from('evolution_log').insert({
    trades_used:     trades.length,
    train_count:     trainTrades.length,
    holdout_count:   holdoutTrades.length,
    inconsistent_ct: inconsistentCount,
    changes,
    ai_insights:     aiInsights,
  })

  // ── Telegram ──────────────────────────────────────────────────────────────
  if (changes.length > 0) {
    const topChanges = changes
      .sort((a, b) => Math.abs(b.newWeight - 1) - Math.abs(a.newWeight - 1))
      .slice(0, 4)
      .map(c => {
        const arrow  = c.newWeight > 1 ? '⬆️' : c.newWeight < 1 ? '⬇️' : '➡️'
        const hvIcon = c.holdoutValidated ? '' : ' ⚠️'
        return `${arrow} ${c.label}: WR ${c.factorWR}% → <b>${c.newWeight}x</b>${hvIcon}`
      })
      .join('\n')

  }

  return NextResponse.json({
    ok: true,
    tradesAnalyzed: trades.length,
    trainCount:     trainTrades.length,
    holdoutCount:   holdoutTrades.length,
    inconsistentFactors: inconsistentCount,
    changes,
    aiInsights,
  })
}
