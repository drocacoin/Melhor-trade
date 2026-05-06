/**
 * Sistema de logging no banco — substitui console.log para eventos críticos.
 *
 * Tabela necessária (criar no Supabase):
 *
 *   CREATE TABLE system_events (
 *     id         BIGSERIAL PRIMARY KEY,
 *     event_type TEXT        NOT NULL,
 *     asset      TEXT,
 *     data       JSONB,
 *     created_at TIMESTAMPTZ DEFAULT NOW()
 *   );
 *   CREATE INDEX ON system_events (event_type, created_at DESC);
 *   CREATE INDEX ON system_events (created_at DESC);
 *
 * Tipos de evento registrados:
 *   circuit_breaker_triggered  — CB ativado por drawdown
 *   circuit_breaker_cleared    — CB desativado (recovery)
 *   stop_auto_closed           — trade fechado automaticamente no stop
 *   trailing_stop_moved        — stop movido para breakeven no alvo 1
 *   signal_generated           — novo sinal detectado
 */

import { supabaseAdmin } from '@/lib/supabase'

export type EventType =
  | 'circuit_breaker_triggered'
  | 'circuit_breaker_cleared'
  | 'stop_auto_closed'
  | 'trailing_stop_moved'
  | 'partial_close'
  | 'signal_generated'

export async function logEvent(
  type:  EventType,
  data:  Record<string, unknown>,
  asset?: string
): Promise<void> {
  try {
    const db = supabaseAdmin()
    await db.from('system_events').insert({
      event_type: type,
      asset:      asset ?? null,
      data,
      created_at: new Date().toISOString(),
    })
  } catch {
    // Silencioso — tabela pode não existir ainda
    // Para ativar: executar o CREATE TABLE acima no Supabase SQL Editor
    console.warn(`[logger] system_events não disponível — evento ${type} não persistido`)
  }
}

/**
 * Lê os últimos N eventos de um tipo.
 * Retorna [] se a tabela não existir.
 */
export async function getRecentEvents(
  type:  EventType,
  limit: number = 10
): Promise<any[]> {
  try {
    const db = supabaseAdmin()
    const { data } = await db
      .from('system_events')
      .select('*')
      .eq('event_type', type)
      .order('created_at', { ascending: false })
      .limit(limit)
    return data ?? []
  } catch {
    return []
  }
}

/**
 * Verifica se CB já foi logado nas últimas N horas para evitar spam.
 * Retorna false se tabela não existir (assume que não foi logado).
 */
export async function wasCbLoggedRecently(hours: number = 4): Promise<boolean> {
  try {
    const db     = supabaseAdmin()
    const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString()
    const { data } = await db
      .from('system_events')
      .select('id')
      .eq('event_type', 'circuit_breaker_triggered')
      .gte('created_at', cutoff)
      .limit(1)
    return (data?.length ?? 0) > 0
  } catch {
    return false
  }
}
