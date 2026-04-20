/**
 * Lê e aplica os pesos dinâmicos do scoring.
 * O scanner usa isso em vez de pontos fixos no código.
 */
import { supabaseAdmin } from './supabase'

export interface ScoringWeights {
  wt_cross_oversold:   number
  bos_up:              number
  price_vs_cloud:      number
  tenkan_vs_kijun:     number
  daily_bias:          number
  weekly_bias:         number
  wt_cross_overbought: number
  bos_down:            number
}

// Pesos padrão — usados se a tabela ainda não tiver dados
const DEFAULT_WEIGHTS: ScoringWeights = {
  wt_cross_oversold:   3,
  bos_up:              2,
  price_vs_cloud:      1,
  tenkan_vs_kijun:     1,
  daily_bias:          2,
  weekly_bias:         1,
  wt_cross_overbought: 3,
  bos_down:            2,
}

/**
 * Busca pesos do banco para um ativo específico.
 * Prioridade: peso do ativo > peso global > padrão.
 */
export async function loadWeights(asset: string): Promise<ScoringWeights> {
  try {
    const db = supabaseAdmin()
    const { data } = await db
      .from('scoring_weights')
      .select('*')
      .or(`asset.eq.${asset},asset.is.null`)

    if (!data?.length) return DEFAULT_WEIGHTS

    // Merge: global first, then asset-specific overrides
    const merged: Record<string, number> = {}
    const globals = data.filter((r: any) => !r.asset)
    const specific = data.filter((r: any) => r.asset === asset)

    for (const row of globals) {
      merged[row.factor] = Number(row.weight) * Number(row.base_points)
    }
    for (const row of specific) {
      merged[row.factor] = Number(row.weight) * Number(row.base_points)
    }

    return {
      wt_cross_oversold:   merged['wt_cross_oversold']   ?? DEFAULT_WEIGHTS.wt_cross_oversold,
      bos_up:              merged['bos_up']              ?? DEFAULT_WEIGHTS.bos_up,
      price_vs_cloud:      merged['price_vs_cloud']      ?? DEFAULT_WEIGHTS.price_vs_cloud,
      tenkan_vs_kijun:     merged['tenkan_vs_kijun']     ?? DEFAULT_WEIGHTS.tenkan_vs_kijun,
      daily_bias:          merged['daily_bias']          ?? DEFAULT_WEIGHTS.daily_bias,
      weekly_bias:         merged['weekly_bias']         ?? DEFAULT_WEIGHTS.weekly_bias,
      wt_cross_overbought: merged['wt_cross_overbought'] ?? DEFAULT_WEIGHTS.wt_cross_overbought,
      bos_down:            merged['bos_down']            ?? DEFAULT_WEIGHTS.bos_down,
    }
  } catch {
    return DEFAULT_WEIGHTS
  }
}
