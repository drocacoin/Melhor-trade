/**
 * Monitor de stop/alvo — detecta automaticamente quando uma posição aberta
 * atinge o stop loss ou os alvos, e age:
 *
 *  • Stop atingido  → fecha o trade no DB e envia notificação Telegram
 *  • Alvo 1 atingido → alerta Telegram (marca alerted_target1)
 *  • Alvo 2 atingido → alerta Telegram (marca alerted_target2)
 *  • Stop próximo   → alerta Telegram (quando < 20% do range restante)
 *
 * Chamado por scan (1h/1h) E scan-fast (30min) para máxima responsividade.
 */

import { fetchLivePrice } from '@/lib/fetcher'
import { sendTelegram, fmtStopAlert } from '@/lib/telegram'
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

    // ── 1. AUTO-CLOSE: stop cruzado ────────────────────────────────────────
    if (stop) {
      const stopHit = isLong ? price <= stop : price >= stop

      if (stopHit) {
        const pnlPct = ((isLong ? price - entry : entry - price) / entry) * 100 * lev
        const pnlUsd = trade.size
          ? +(pnlPct / lev / 100 * trade.size).toFixed(2)
          : null

        // eq('status','open') evita duplo fechamento em race condition
        await db.from('trades').update({
          status:      'closed',
          close_price: price,
          closed_at:   new Date().toISOString(),
          pnl_pct:     +pnlPct.toFixed(2),
          ...(pnlUsd !== null ? { pnl_usd: pnlUsd } : {}),
          notes:       `[AUTO] Stop atingido @ $${price.toFixed(2)}`,
        }).eq('id', trade.id).eq('status', 'open')

        // Log persistido no banco
        await logEvent('stop_auto_closed', {
          trade_id:    trade.id,
          direction:   trade.direction,
          leverage:    lev,
          entry_price: entry,
          stop_price:  stop,
          close_price: price,
          pnl_pct:     +pnlPct.toFixed(2),
          pnl_usd:     pnlUsd,
        }, trade.asset)

        const pnlStr =
          `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%` +
          (pnlUsd !== null ? ` ($${pnlUsd >= 0 ? '+' : ''}${pnlUsd.toFixed(0)})` : '')

        await sendTelegram(
          `🛑 <b>STOP ATINGIDO — ${trade.asset}</b>\n\n` +
          `Posição: <b>${trade.direction.toUpperCase()}</b> ${lev}x\n` +
          `Entrada: <code>$${entry}</code> → Stop: <code>$${stop}</code>\n` +
          `Fechado em: <code>$${price.toFixed(2)}</code>\n` +
          `P&L: <b>${pnlStr}</b>\n\n` +
          `⚡ Trade fechado automaticamente.`
        )

        closed++
        continue  // pula demais checks para este trade
      }

      // ── 2. Stop próximo (< 20% do range restante) ───────────────────────
      const range   = Math.abs(entry - stop)
      const toStop  = Math.abs(price - stop)
      const distPct = range > 0 ? (toStop / range) * 100 : 100
      if (distPct <= 20) {
        await sendTelegram(fmtStopAlert(trade.asset, trade.direction, price, stop, distPct))
        alerted++
      }
    }

    // ── 3. Alvo 1 — trailing stop para breakeven ─────────────────────────────
    if (trade.target1 && !trade.alerted_target1) {
      const hit = isLong ? price >= trade.target1 : price <= trade.target1
      if (hit) {
        const movePct = Math.abs((trade.target1 - entry) / entry * 100).toFixed(1)
        const pnl1    = ((isLong ? trade.target1 - entry : entry - trade.target1) / entry * 100 * lev).toFixed(1)

        // Move stop para breakeven (entrada) automaticamente
        await db.from('trades').update({
          alerted_target1: true,
          stop_price:      entry,   // trailing stop → breakeven
          notes:           `[AUTO] Stop movido para breakeven $${entry} ao atingir alvo 1`,
        }).eq('id', trade.id)

        await logEvent('trailing_stop_moved', {
          trade_id:  trade.id,
          direction: trade.direction,
          old_stop:  stop,
          new_stop:  entry,
          target1:   trade.target1,
          price_at_target: price,
        }, trade.asset)

        await sendTelegram(
          `🎯 <b>ALVO 1 ATINGIDO — ${trade.asset}</b>\n\n` +
          `Posição: <b>${trade.direction.toUpperCase()}</b> ${lev}x\n` +
          `Preço atual: <code>$${price.toFixed(2)}</code>\n` +
          `Alvo 1: <code>$${trade.target1}</code> (+${movePct}% move | P&L +${pnl1}%)\n\n` +
          `🔄 <b>Stop movido para breakeven</b>: <code>$${entry}</code>\n` +
          `💡 Feche 50% da posição para garantir o lucro.`
        )
        alerted++
      }
    }

    // ── 4. Alvo 2 ──────────────────────────────────────────────────────────
    if (trade.target2 && !trade.alerted_target2) {
      const hit = isLong ? price >= trade.target2 : price <= trade.target2
      if (hit) {
        const movePct = Math.abs((trade.target2 - entry) / entry * 100).toFixed(1)
        const pnl2    = ((isLong ? trade.target2 - entry : entry - trade.target2) / entry * 100 * lev).toFixed(1)
        await sendTelegram(
          `🎯🎯 <b>ALVO 2 ATINGIDO — ${trade.asset}</b>\n\n` +
          `Posição: <b>${trade.direction.toUpperCase()}</b> ${lev}x\n` +
          `Preço atual: <code>$${price.toFixed(2)}</code>\n` +
          `Alvo 2: <code>$${trade.target2}</code> (+${movePct}% move | P&L +${pnl2}%)\n\n` +
          `💡 Feche mais 25% e deixe o restante correr com stop no alvo 1.`
        )
        await db.from('trades').update({ alerted_target2: true }).eq('id', trade.id)
        alerted++
      }
    }
  }

  return { closed, alerted }
}
