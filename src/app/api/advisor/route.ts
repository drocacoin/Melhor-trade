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
import { fetchWhaleSentiment } from '@/lib/whales'
import { fetchNewsSentiment } from '@/lib/news'
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
      whaleSentiment,
      newsResult,
    ] = await Promise.all([
      fetchFearAndGreed().catch(() => null),
      db.from('macro_readings').select('*').order('captured_at', { ascending: false }).limit(1),
      db.from('trades').select('*').eq('status', 'open'),
      db.from('trades').select('*').eq('status', 'closed').order('closed_at', { ascending: false }).limit(30),
      db.from('signals').select('*').eq('status', 'active').order('detected_at', { ascending: false }).limit(10),
      db.from('snapshots').select('*').order('captured_at', { ascending: false }).limit(500),
      db.from('performance_summary').select('*'),
      db.from('monthly_journals').select('*').order('month', { ascending: false }).limit(1),
      fetchWhaleSentiment().catch(() => null),
      fetchNewsSentiment().catch(() => null),
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

    // Top 8 por proximidade de sinal + sempre inclui macro-assets (OIL, SP500, MSTR)
    const ALWAYS_SHOW = ['OIL', 'SP500', 'MSTR']
    const top8 = scores.slice(0, 8)
    const extra = scores.filter(s =>
      ALWAYS_SHOW.includes(s.asset) && !top8.find(t => t.asset === s.asset)
    )
    const scoresForPrompt = [...top8, ...extra]

    const scoresText = scoresForPrompt.map(s =>
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

    // Sentimento das baleias
    const whaleText = whaleSentiment?.sentiment?.length
      ? whaleSentiment.sentiment
          .filter((s: any) => s.longCount + s.shortCount >= 2)
          .slice(0, 8)
          .map((s: any) =>
            `${s.asset}: ${s.sentimentPct}% long (${s.longCount}L/${s.shortCount}S) — ${s.sentiment.toUpperCase()} | vol $${Math.round((s.longValue + s.shortValue) / 1000)}k`
          ).join('\n')
      : 'Dados de baleias indisponíveis.'

    // Sentimento de notícias (últimas 12h)
    const newsText = newsResult?.byAsset && Object.keys(newsResult.byAsset).length
      ? Object.values(newsResult.byAsset)
          .filter((n: any) => n.count >= 2)
          .sort((a: any, b: any) => Math.abs(b.score) - Math.abs(a.score))
          .slice(0, 8)
          .map((n: any) =>
            `${n.asset}: ${n.sentiment.toUpperCase()} score=${n.score > 0 ? '+' : ''}${n.score} (${n.count} notícias) | "${(n.headlines[0] ?? '').slice(0, 80)}"`
          ).join('\n')
      : 'Sem dados de notícias disponíveis.'

    const mj = (monthlyJournal as any)?.[0]
    const perfText =
      `Últimos ${closed.length} trades: WR ${winrate.toFixed(1)}% (${wins}W/${closed.length - wins}L) | P&L $${totalPnl.toFixed(2)}` +
      (mj ? `\nMês ${mj.month}: WR ${mj.winrate}% | P&L $${mj.total_pnl}` : '')

    const prompt =
      `Você é um analista sênior de swing trade quantitativo. Analise os dados abaixo.\n\n` +
      `MACRO: ${macroText}\n\n` +
      `FEAR&GREED: ${fgText}\n\n` +
      `NOTICIAS (últimas 12h): ${newsText}\n\n` +
      `BALEIAS: ${whaleText}\n\n` +
      `SCORES TÉCNICOS: ${scoresText}\n\n` +
      `POSIÇÕES ABERTAS: ${openText}\n\n` +
      `SINAIS ATIVOS: ${signalsText}\n\n` +
      `PERFORMANCE: ${perfText}\n\n` +
      `INSTRUÇÕES: Responda SOMENTE com um objeto JSON válido e compacto (sem markdown, sem texto fora do JSON, sem blocos de código). Use aspas duplas, sem trailing commas. Seja breve nos textos para não truncar.\n\n` +
      `FORMATO OBRIGATÓRIO:\n` +
      `{"overall":"favorável","market_view":"resumo em 1 frase","opportunities":[{"asset":"BTC","direction":"long","urgency":"alta","rationale":"motivo curto"}],"open_positions":[{"asset":"X","action":"manter","reason":"motivo"}],"risks":["risco1","risco2"],"recommendation":"ação principal"}`

    // ── 6. Chamar Claude Haiku ───────────────────────────────────────────────
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY não configurada')

    const client = new Anthropic({ apiKey })
    const resp = await client.messages.create({
      model:      'claude-haiku-4-5',
      max_tokens: 2000,
      messages:   [{ role: 'user', content: prompt }],
    })
    const raw = (resp.content[0] as any).text?.trim() ?? ''

    // Extrai JSON — tenta o bloco mais externo {…}
    let jsonStr = ''
    const start = raw.indexOf('{')
    const end   = raw.lastIndexOf('}')
    if (start !== -1 && end !== -1 && end > start) {
      jsonStr = raw.slice(start, end + 1)
    }

    if (!jsonStr) {
      console.error('[advisor] resposta sem JSON:', raw.slice(0, 300))
      return NextResponse.json({ error: 'IA não retornou JSON válido', raw: raw.slice(0, 500) }, { status: 500 })
    }

    let analysis: any
    try {
      analysis = JSON.parse(jsonStr)
    } catch {
      // Tenta reparar JSON truncado — adiciona fechamento básico se necessário
      try {
        const repaired = jsonStr.replace(/,\s*$/, '') + '}'
        analysis = JSON.parse(repaired)
      } catch (e2: any) {
        console.error('[advisor] JSON parse error:', e2.message, jsonStr.slice(0, 300))
        return NextResponse.json({ error: 'JSON inválido da IA', raw: jsonStr.slice(0, 500) }, { status: 500 })
      }
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
