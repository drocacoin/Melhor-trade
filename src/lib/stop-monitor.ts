/**
 * Monitor de stop/alvo — detecta automaticamente quando uma posição aberta
 * atinge o stop loss ou os alvos, e age:
 *
 *  • Stop atingido   → fecha o trade no DB (P&L mesclado se houve parcial)
 *  • Alvo 1 atingido → grava parcial 50% + move stop para breakeven + Telegram
 *  • Alvo 2 atingido → alerta Telegram
 *  • Stop próximo    → alerta Telegram (quando < 20% do range restante)
 *
 * Chamado por scan (1h) E scan-fast (30min) para máxima responsividade.
 *
 * ── Lógica de posição parcial ────────────────────────────────────────────────
 * Quando alvo 1 é atingido:
 *   1. Grava partial_close_1_price / partial_close_1_pnl_pct / partial_close_1_at
 *   2. Move stop_price para entry (breakeven) — sem mais risco
 *   3. Envia alerta "feche 50% agora em $X"
 *
 * Quando stop é atingido (com parcial já registrado):
 *   P&L total = (pnl_parcial × 50%) + (pnl_final × 50%)
 *   Ex: parcial +20%, final 0% (breakeven) → blended +10%
 */

import { fetchLivePrice } from '@/lib/fetcher'
import { supabaseAdmin } from '@/lib/supabase'
import { logEvent } from '@/lib/logger'
import { Asset } from '@/types'

export async function checkStopAlerts(
  db:         ReturnType<typeof supabaseAdmin>,
  openTrades: any[]
): Promise<{ closed: number; alerted: number }> {
  if (!openTrades.length) return { closed: 0, alerted: 0 }

  // Busca preços em paralelo — falha por ativo não para o resto
  const assets = [...new Set(openTrades.map((t: any) => t.asset))] as Asset[]
  const prices: Record<string, number> = {}
  await Promise.allSettled(
    assets.map(a =>
      fetchLivePrice(a)
        .then(p => { prices[a] = p })
        .catch(() => {})
    )
  )

  let closed  = 0
  let alerted = 0

  for (const trade of openTrades) {
    const price  = prices[trade.asset]
    const isLong = trade.direction === 'long'
    if (!price) continue

    const entry = trade.entry_price
    const lev   = trade.leverage ?? 1
    const stop  = trade.stop_price ?? trade.stop_loss

    // ── Parcial já executado? ────────────────────────────────────────────────
    const hasPartial    = trade.partial_close_1_price != null
    const partialPct    = hasPartial ? (trade.partial_close_1_pct   ?? 50)  : 0
    const remainingPct  = 100 - partialPct  // 50% se parcial tomado

    // ── 1. AUTO-CLOSE: stop cruzado ────────────────────────────────────────
    if (stop) {
      const stopHit = isLong ? price <= stop : price >= stop

      if (stopHit) {
        // P&L da porção final (restante após parcial, ou 100% se sem parcial)
        const finalPnlPct = ((isLong ? price - entry : entry - price) / entry) * 100 * lev

        let pnlPct: number
        let pnlUsd: number | null

        if (hasPartial && partialPct > 0) {
          // Blended P&L = média ponderada das duas porções
          const partialPnlPct = trade.partial_close_1_pnl_pct ?? 0
          pnlPct = +(
            (partialPnlPct  * (partialPct   / 100)) +
            (finalPnlPct    * (remainingPct / 100))
          ).toFixed(2)

          pnlUsd = trade.size != null ? +(
            (trade.size * (partialPct   / 100) * (partialPnlPct / lev / 100)) +
            (trade.size * (remainingPct / 100) * (finalPnlPct   / lev / 100))
          ).toFixed(2) : null
        } else {
          pnlPct = +finalPnlPct.toFixed(2)
          pnlUsd = trade.size != null
            ? +(pnlPct / lev / 100 * trade.size).toFixed(2)
            : null
        }

        // eq('status','open') evita duplo fechamento em race condition
        await db.from('trades').update({
          status:      'closed',
          close_price: price,
          closed_at:   new Date().toISOString(),
          pnl_pct:     pnlPct,
          ...(pnlUsd !== null ? { pnl_usd: pnlUsd } : {}),
          notes: hasPartial
            ? `[AUTO] Stop atingido @ $${price.toFixed(2)} | parcial 50% @ $${trade.partial_close_1_price} já registrado`
            : `[AUTO] Stop atingido @ $${price.toFixed(2)}`,
        }).eq('id', trade.id).eq('status', 'open')

        await logEvent('stop_auto_closed', {
          trade_id:     trade.id,
          direction:    trade.direction,
          leverage:     lev,
          entry_price:  entry,
          stop_price:   stop,
          close_price:  price,
          pnl_pct:      pnlPct,
          pnl_usd:      pnlUsd,
          had_partial:  hasPartial,
          partial_price: hasPartial ? trade.partial_close_1_price : null,
        }, trade.asset)

        closed++
        continue  // pula demais checks para este trade
      }

      // ── 2. Stop próximo — apenas registra, sem Telegram ─────────────────
      const range   = Math.abs(entry - stop)
      const toStop  = Math.abs(price - stop)
      const distPct = range > 0 ? (toStop / range) * 100 : 100
      if (distPct <= 20) {
        alerted++  // contabiliza para o log JSON, sem enviar Telegram
      }
    }

    // ── 3. Alvo 1 — parcial 50% + trailing stop para breakeven ───────────────
    if (trade.target1 && !trade.alerted_target1) {
      const hit = isLong ? price >= trade.target1 : price <= trade.target1
      if (hit) {
        const pnl1Pct = +((isLong
          ? trade.target1 - entry
          : entry - trade.target1) / entry * 100 * lev).toFixed(2)
        const pnl1Usd = trade.size != null
          ? +(trade.size * 0.5 * (pnl1Pct / lev / 100)).toFixed(2)
          : null

        // Grava parcial + move stop para breakeven (silencioso — sem Telegram)
        await db.from('trades').update({
          alerted_target1:         true,
          stop_price:              entry,
          partial_close_1_price:   price,
          partial_close_1_pct:     50,
          partial_close_1_pnl_pct: pnl1Pct,
          partial_close_1_at:      new Date().toISOString(),
          notes: `[AUTO] Parcial 50% registrado @ $${price.toFixed(2)} (+${pnl1Pct}%) | Stop → breakeven $${entry}`,
        }).eq('id', trade.id)

        await logEvent('partial_close', {
          trade_id:          trade.id,
          direction:         trade.direction,
          leverage:          lev,
          entry_price:       entry,
          partial_price:     price,
          partial_pct:       50,
          partial_pnl_pct:   pnl1Pct,
          partial_pnl_usd:   pnl1Usd,
          old_stop:          stop,
          new_stop:          entry,
        }, trade.asset)

        alerted++
      }
    }

    // ── 4. Alvo 2 — apenas grava flag, sem Telegram ───────────────────────
    if (trade.target2 && !trade.alerted_target2) {
      const hit = isLong ? price >= trade.target2 : price <= trade.target2
      if (hit) {
        await db.from('trades').update({ alerted_target2: true }).eq('id', trade.id)
        alerted++
      }
    }
  }

  return { closed, alerted }
}
