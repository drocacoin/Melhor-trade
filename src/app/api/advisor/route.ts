/**
 * POST /api/advisor
 *
 * Coleta todo o contexto disponível (macro, scores, posições abertas,
 * fear & greed, sinais ativos, performance histórica) e pede ao Claude
 * uma análise consolidada + recomendação clara.
 */
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { fetchFearAndGreed, fetchLivePrice } from '@/lib/fetcher'
import { computeLiveScore } from '@/lib/scoring'
import { computeThreshold } from '@/lib/threshold'
import Anthropic from '@anthropic-ai/sdk'
import { Asset } from '@/types'

export const maxDuration = 60

const ASSETS: Asset[] = ['BTC', 'ETH', 'SOL', 'HYPE', 'AAVE', 'LINK', 'AVAX', 'GOLD', 'OIL', 'SP500', 'MSTR', 'XRP', 'SUI', 'DOGE', 'TAO']

export async function POST() {
  try {
    const db = supabaseAdmin()

    // ── 1. Coletar contexto em paralelo ─────────────────────────────────────
    const [
      fg,
      { data: macroRow },
      { data: openTrades },
      { data: closedTrades },
      { data: activeSignals },
      { data: snapsAll },
      { data: perfRows },
      { data: monthlyJournal },
    ] = await Promise.all([
      fetchFearAndGreed().catch(() => null),
      db.from('macro_readings').select('*').order('captured_at', { ascending: false }).limit(1),
      db.from('trades').select('*').eq('status', 'open'),
      db.from('trades').select('*').eq('status', 'closed').order('closed_at', { ascending: false }).limit(30),
      db.from('signals').select('*').eq('status', 'active').order('detected_at', { ascending: false }).limit(10),
      db.from('snapshots').select('*').order('captured_at', { ascending: false }).limit(500),
      db.from('performance_summary').select('*'),
      db.from('monthly_journals').select('*').order('month', { ascending: false }).limit(1),
    ])

    const macro   = macroRow?.[0] ?? null
    const perfMap = Object.fromEntries((perfRows ?? []).map((p: any) => [p.asset, p]))

    // ── 2. Scores atuais por ativo ──────────────────────────────────────────
    const seen = new Set<string>()
    const latestSnaps = (snapsAll ?? []).filter((s: any) => {
      const k = `${s.asset}-${s.timeframe}`
      if (seen.has(k)) return false
      seen.add(k); return true
    })

    const scores = ASSETS.map(asset => {
      const byTf: Record<string, any> = Object.fromEntries(
        latestSnaps.filter((s: any) => s.asset === asset).map((s: any) => [s.timeframe, s])
      )
      const score = computeLiveScore(byTf, fg)
      const thr   = computeThreshold(perfMap[asset])
      return { asset, ...score, threshold: thr.threshold, gap: thr.threshold - score.topScore }
    }).sort((a, b) => a.gap - b.gap)

    // ── 3. Preços ao vivo — fail-safe por ativo ─────────────────────────────
    const openAssets = [...new Set((openTrades ?? []).map((t: any) => t.asset))] as Asset[]
    const prices: Record<string, number> = {}
    await Promise.allSettled(
      openAssets.map(a => fetchLivePrice(a).then(p => { prices[a] = p }).catch(() => {}))
    )

    // ── 4. Performance resumida ──────────────────────────────────────────────
    const closed   = closedTrades ?? []
    const isWin    = (t: any) => t.pnl_usd != null ? t.pnl_usd > 0 : (t.pnl_pct ?? 0) > 0
    const wins     = closed.filter(isWin).length
    const winrate  = closed.length ? (wins / closed.length) * 100 : 0
    const totalPnl = closed.reduce((s: number, t: any) => s + (t.pnl_usd ?? 0), 0)

    // ── 5. Montar prompt ─────────────────────────────────────────────────────
    const macroText = macro
      ? `Regime: ${macro.regime.toUpperCase()} | Score: ${macro.macro_score >= 0 ? '+' : ''}${macro.macro_score}\n` +
        `DXY: ${macro.dxy_trend} | Yields: ${macro.yields_trend} | FED: ${macro.fed_stance}\n` +
        (macro.notes ? `Contexto: ${macro.notes.slice(0, 300)}` : '')
      : 'Sem leitura macro recente.'

    const fgText = fg ? `${fg.value}/100 — ${fg.label}` : 'indisponível'

    const scoresText = scores.slice(0, 8).map(s =>
      `${s.asset}: bull=${s.bullScore} bear=${s.bearScore} threshold=${s.threshold} ` +
      `(${s.gap <= 0 ? '🚨 SINAL' : `falta ${s.gap.toFixed(1)}pts`})`
    ).join('\n')

    const openText = (openTrades ?? []).length
      ? (openTrades ?? []).map((t: any) => {
          const price  = prices[t.asset]
          const isLong = t.direction === 'long'
          const pnlPct = price && t.entry_price
            ? ((isLong ? price - t.entry_price : t.entry_price - price) / t.entry_price * 100 * (t.leverage ?? 1)).toFixed(1)
            : null
          return `${t.asset} ${t.direction.toUpperCase()} ${t.leverage ?? 1}x | entrada $${t.entry_price} | atual $${price?.toFixed(2) ?? '?'} | P&L ${pnlPct != null ? pnlPct + '%' : '?'} | stop $${t.stop_price ?? '?'} | alvo1 $${t.target1 ?? '?'}`
        }).join('\n')
      : 'Nenhuma posição aberta.'

    const signalsText = (activeSignals ?? []).length
      ? (activeSignals ?? []).map((s: any) =>
          `${s.asset} ${s.direction.toUpperCase()} [${s.setup_grade}] | entrada $${s.entry_zone_low}–$${s.entry_zone_high} | stop $${s.stop} | alvo1 $${s.target1} | RR ${s.rr1}`
        ).join('\n')
      : 'Sem sinais ativos.'

    const mj = (monthlyJournal as any)?.[0]
    const perfText =
      `Últimos ${closed.length} trades: WR ${winrate.toFixed(1)}% (${wins}W/${closed.length - wins}L) | P&L $${totalPnl.toFixed(2)}` +
      (mj ? `\nMês ${mj.month}: WR ${mj.winrate}% | P&L $${mj.total_pnl}` : '')

    const prompt =
      `Você é um analista sênior de swing trade quantitativo. Analise os dados e forneça recomendações específicas.\n\n` +
      `━━ MACRO ━━\n${macroText}\n\n` +
      `━━ FEAR & GREED ━━\n${fgText}\n\n` +
      `━━ SCORES TÉCNICOS (top 8, ordenados por proximidade do sinal) ━━\n${scoresText}\n\n` +
      `━━ POSIÇÕES ABERTAS ━━\n${openText}\n\n` +
      `━━ SINAIS ATIVOS ━━\n${signalsText}\n\n` +
      `━━ PERFORMANCE ━━\n${perfText}\n\n` +
      `Seja direto. Priorize o que o trader deve FAZER AGORA.\n` +
      `Considere correlação entre posições, risco total e regime macro.\n\n` +
      `Responda APENAS com JSON válido, sem markdown, sem blocos de código:\n` +
      `{"overall":"favorável","market_view":"...","opportunities":[{"asset":"X","direction":"long","urgency":"alta","score":7.5,"rationale":"..."}],"open_positions":[{"asset":"X","action":"manter","reason":"..."}],"risks":["..."],"recommendation":"..."}`

    // ── 6. Chamar Claude Haiku ───────────────────────────────────────────────
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY não configurada no Vercel — adicione em Settings → Environment Variables')

    const client = new Anthropic({ apiKey })
    const resp = await client.messages.create({
      model:      'claude-haiku-4-5',
      max_tokens: 1200,
      messages:   [{ role: 'user', content: prompt }],
    })
    const raw = (resp.content[0] as any).text ?? ''

    // Extrair JSON da resposta (tolera markdown ```json ... ```)
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      console.error('[advisor] resposta sem JSON:', raw.slice(0, 300))
      return NextResponse.json({ error: 'IA não retornou JSON válido', raw: raw.slice(0, 500) }, { status: 500 })
    }

    let analysis: any
    try {
      analysis = JSON.parse(jsonMatch[0])
    } catch (e: any) {
      console.error('[advisor] JSON parse error:', e.message, jsonMatch[0].slice(0, 300))
      return NextResponse.json({ error: 'JSON inválido da IA', raw: jsonMatch[0].slice(0, 500) }, { status: 500 })
    }

    // ── 7. Retornar ─────────────────────────────────────────────────────────
    return NextResponse.json({
      analysis,
      context: {
        macro:      macro ? { regime: macro.regime, score: macro.macro_score } : null,
        fear_greed: fg,
        top_scores: scores.slice(0, 5).map(s => ({ asset: s.asset, bull: s.bullScore, bear: s.bearScore, gap: s.gap })),
        open_count: (openTrades ?? []).length,
        signals:    (activeSignals ?? []).length,
        winrate,
        total_pnl:  totalPnl,
      },
      generated_at: new Date().toISOString(),
    })

  } catch (e: any) {
    console.error('[advisor] erro crítico:', e.message, e.stack)
    return NextResponse.json(
      { error: e.message ?? 'Erro interno', details: e.stack?.split('\n')[0] },
      { status: 500 }
    )
  }
}
