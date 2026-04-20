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
import { sendTelegram } from '@/lib/telegram'

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

export async function GET(req: NextRequest) {
  const secret = req.headers.get('x-cron-secret') ?? req.nextUrl.searchParams.get('secret')
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

  // ── Para cada trade, buscar snapshots da data de entrada ──────────────────
  const factorStats: Record<string, { wins: number; losses: number }> = {}
  const assetFactorStats: Record<string, Record<string, { wins: number; losses: number }>> = {}

  for (const factor of FACTORS) {
    factorStats[factor.key] = { wins: 0, losses: 0 }
  }

  for (const trade of trades) {
    const isWin   = (trade.pnl_usd ?? 0) > 0
    const isLong  = trade.direction === 'long'
    const date    = trade.opened_at?.slice(0, 10)

    if (!date) continue

    const { data: snaps } = await db
      .from('snapshots')
      .select('timeframe, wt_cross_up, wt_cross_down, wt_zone, bos_up, bos_down, price_vs_cloud, tenkan_vs_kijun, bias')
      .eq('asset', trade.asset)
      .gte('captured_at', `${date}T00:00:00`)
      .lte('captured_at', `${date}T23:59:59`)
      .order('captured_at', { ascending: true })

    if (!snaps?.length) continue

    // Latest snapshot per timeframe for this trade's entry day
    const byTf: Record<string, any> = {}
    for (const s of snaps) { byTf[s.timeframe] = s }

    const h4 = byTf['4h']
    const d  = byTf['1d']
    const wk = byTf['1wk']

    // Check which factors were present at entry
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

    // Aggregate stats
    for (const [factor, wasActive] of Object.entries(active)) {
      if (!wasActive) continue
      if (isWin) factorStats[factor].wins++
      else       factorStats[factor].losses++

      if (!assetFactorStats[trade.asset]) {
        assetFactorStats[trade.asset] = {}
        for (const f of FACTORS) assetFactorStats[trade.asset][f.key] = { wins: 0, losses: 0 }
      }
      if (isWin) assetFactorStats[trade.asset][factor].wins++
      else       assetFactorStats[trade.asset][factor].losses++
    }
  }

  // ── Calcular novos pesos ──────────────────────────────────────────────────
  const overallWR = trades.filter(t => (t.pnl_usd ?? 0) > 0).length / trades.length
  const changes: any[] = []

  for (const factor of FACTORS) {
    const stats   = factorStats[factor.key]
    const total   = stats.wins + stats.losses
    if (total < 3) continue  // dados insuficientes para este fator

    const factorWR   = stats.wins / total
    // Peso = quão melhor este fator é vs a média geral
    // WR do fator = overallWR → peso = 1.0 (neutro)
    // WR do fator = 80%, overallWR = 50% → peso = 1.6 (forte)
    // WR do fator = 20%, overallWR = 50% → peso = 0.4 (fraco)
    const rawWeight  = overallWR > 0 ? factorWR / overallWR : 1.0
    const newWeight  = Math.min(MAX_WEIGHT, Math.max(MIN_WEIGHT, Math.round(rawWeight * 10) / 10))

    const { error } = await db.from('scoring_weights')
      .upsert({
        asset:           null,
        factor:          factor.key,
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
      })
    }
  }

  // ── Pesos por ativo específico ────────────────────────────────────────────
  for (const [asset, aStats] of Object.entries(assetFactorStats)) {
    const assetTrades = trades.filter(t => t.asset === asset)
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
  let aiInsights = ''
  if (changes.length > 0 && process.env.ANTHROPIC_API_KEY) {
    try {
      const changeLines = changes
        .map(c => `${c.label}: WR=${c.factorWR}% | novo peso=${c.newWeight} | n=${c.total}`)
        .join('\n')

      const client  = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
      const message = await client.messages.create({
        model:      'claude-haiku-4-5',
        max_tokens: 300,
        messages:   [{
          role:    'user',
          content: `Analise esta evolução do sistema de scoring de um trader de swing trade.
Explique em 2-3 frases o que os dados revelam sobre quais indicadores estão funcionando e qual impacto isso terá nos próximos sinais.

DADOS (${trades.length} trades analisados, WR geral: ${Math.round(overallWR * 100)}%):
${changeLines}`,
        }],
      })
      aiInsights = (message.content[0] as any).text
    } catch { /* silencioso */ }
  }

  // ── Salvar log da evolução ────────────────────────────────────────────────
  await db.from('evolution_log').insert({
    trades_used: trades.length,
    changes,
    ai_insights: aiInsights,
  })

  // ── Telegram ──────────────────────────────────────────────────────────────
  if (changes.length > 0) {
    const topChanges = changes
      .sort((a, b) => Math.abs(b.newWeight - 1) - Math.abs(a.newWeight - 1))
      .slice(0, 4)
      .map(c => {
        const arrow = c.newWeight > 1 ? '⬆️' : c.newWeight < 1 ? '⬇️' : '➡️'
        return `${arrow} ${c.label}: WR ${c.factorWR}% → peso <b>${c.newWeight}x</b>`
      })
      .join('\n')

    await sendTelegram(
      `🧠 <b>Sistema evoluiu — ${trades.length} trades analisados</b>\n\n` +
      `${topChanges}\n\n` +
      (aiInsights ? `💡 <i>${aiInsights}</i>` : '')
    )
  }

  return NextResponse.json({ ok: true, tradesAnalyzed: trades.length, changes, aiInsights })
}
