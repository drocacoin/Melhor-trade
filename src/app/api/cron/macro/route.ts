/**
 * Cron de atualização automática do painel macro.
 *
 * Roda diariamente às 8h UTC (antes do scan das 9h)
 *
 * O que faz:
 *  1. Busca DXY, Yields 10Y e VIX do Yahoo Finance (free, sem key)
 *  2. Compara com SMA-20 para classificar tendência
 *  3. Calcula macro_score (-2 a +2) e classifica regime
 *  4. Claude Haiku escreve análise contextual
 *  5. Salva em macro_readings → exibido na aba Macro
 *  6. Notifica via Telegram
 */
import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { supabaseAdmin } from '@/lib/supabase'
import { fetchFearAndGreed } from '@/lib/fetcher'

export const maxDuration = 60

// ─── Buscar indicador do Yahoo Finance ───────────────────────────────────────
async function fetchMacroIndicator(symbol: string) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=35d`
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      next:    { revalidate: 0 },
    })
    if (!res.ok) return null
    const json   = await res.json()
    const result = json?.chart?.result?.[0]
    if (!result) return null

    const closes = ((result.indicators?.quote?.[0]?.close ?? []) as (number | null)[])
      .filter((v): v is number => v != null)

    if (closes.length < 5) return null

    const current = closes[closes.length - 1]
    const last20  = closes.slice(-20)
    const sma20   = last20.reduce((a, b) => a + b, 0) / last20.length

    return { current, sma20 }
  } catch {
    return null
  }
}

export async function GET(req: NextRequest) {
  const bearer = req.headers.get('authorization')?.replace('Bearer ', '')
  const secret = bearer ?? req.headers.get('x-cron-secret') ?? req.nextUrl.searchParams.get('secret')
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const db = supabaseAdmin()

  // ── Buscar indicadores em paralelo ───────────────────────────────────────
  const [dxyData, yieldsData, vixData, fg] = await Promise.all([
    fetchMacroIndicator('DX-Y.NYB'),  // Dollar Index
    fetchMacroIndicator('^TNX'),      // US 10Y Treasury Yield
    fetchMacroIndicator('^VIX'),      // Volatility Index
    fetchFearAndGreed(),
  ])

  if (!dxyData || !yieldsData || !vixData) {
    return NextResponse.json(
      { ok: false, error: 'Yahoo Finance indisponível — tente novamente mais tarde' },
      { status: 503 }
    )
  }

  const { current: dxy,    sma20: dxySma20    } = dxyData
  const { current: yields, sma20: yieldsSma20 } = yieldsData
  const { current: vix                         } = vixData

  // ── Classificar tendências ────────────────────────────────────────────────
  // DXY: desvio percentual vs SMA20 (threshold: ±0.4%)
  const dxyPctDiff = ((dxy - dxySma20) / dxySma20) * 100
  const dxy_trend: 'forte' | 'lateral' | 'fraco' =
    dxyPctDiff >  0.4 ? 'forte' :
    dxyPctDiff < -0.4 ? 'fraco' : 'lateral'

  // Yields: desvio absoluto vs SMA20 (threshold: ±8 basis points = 0.08)
  const yieldsDiff = yields - yieldsSma20
  const yields_trend: 'subindo' | 'lateral' | 'caindo' =
    yieldsDiff >  0.08 ? 'subindo' :
    yieldsDiff < -0.08 ? 'caindo'  : 'lateral'

  // FED stance: inferir dos yields
  const fed_stance: 'dovish' | 'neutro' | 'hawkish' =
    yields_trend === 'subindo' ? 'hawkish' :
    yields_trend === 'caindo'  ? 'dovish'  : 'neutro'

  // ── Calcular macro_score (-2 a +2) ────────────────────────────────────────
  // DXY fraco  → bullish para ativos de risco (+1)
  // DXY forte  → bearish para ativos de risco (-1)
  // Yields caindo → bullish (+1) | subindo → bearish (-1)
  // VIX < 15   → risk-on (+1)   | > 25   → risk-off (-1)
  let rawScore = 0
  if (dxy_trend === 'fraco')      rawScore += 1
  if (dxy_trend === 'forte')      rawScore -= 1
  if (yields_trend === 'caindo')  rawScore += 1
  if (yields_trend === 'subindo') rawScore -= 1
  if (vix < 15)                   rawScore += 1
  if (vix > 25)                   rawScore -= 1

  const macro_score = Math.max(-2, Math.min(2, rawScore))

  // ── Classificar regime ────────────────────────────────────────────────────
  const regime: 'risk-on' | 'risk-off' | 'neutro' | 'transicao' =
    macro_score >= 1  ? 'risk-on'  :
    macro_score <= -1 ? 'risk-off' :
    // score = 0 com sinais mistos → transição
    (dxy_trend !== 'lateral' || yields_trend !== 'lateral' || vix > 20)
      ? 'transicao'
      : 'neutro'

  // ── Claude Haiku gera análise contextual ──────────────────────────────────
  let notes = ''
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const fgLine = fg ? `Fear & Greed Index: ${fg.value} (${fg.label})` : ''
      const client  = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
      const message = await client.messages.create({
        model:      'claude-haiku-4-5',
        max_tokens: 250,
        messages:   [{
          role:    'user',
          content: `Analise o contexto macro atual para um trader de swing trade (BTC, ETH, GOLD, OIL, SP500).
Seja direto e específico. Máximo 3 frases em português. Não use markdown, apenas texto simples.

DADOS ATUAIS:
- DXY: ${dxy.toFixed(2)} — tendência: ${dxy_trend} (SMA20: ${dxySma20.toFixed(2)})
- Yields 10Y: ${yields.toFixed(2)}% — tendência: ${yields_trend} (SMA20: ${yieldsSma20.toFixed(2)}%)
- VIX: ${vix.toFixed(1)}
${fgLine}
- Regime: ${regime.toUpperCase()}
- Score macro: ${macro_score >= 0 ? '+' : ''}${macro_score}

Explique o que esses dados significam para swing trade e se o ambiente favorece ou prejudica entradas de risco.`,
        }],
      })
      notes = (message.content[0] as any).text
    } catch { /* silencioso — salva sem análise */ }
  }

  // Se não teve análise, gera uma automática simples
  if (!notes) {
    const dxyDesc    = { forte: 'Dólar forte', lateral: 'Dólar lateral', fraco: 'Dólar fraco' }[dxy_trend]
    const yieldsDesc = { subindo: 'Yields subindo', lateral: 'Yields estáveis', caindo: 'Yields caindo' }[yields_trend]
    notes = `${dxyDesc} (${dxy.toFixed(2)}). ${yieldsDesc} (${yields.toFixed(2)}%). VIX em ${vix.toFixed(1)} — volatilidade ${vix < 18 ? 'baixa' : vix > 25 ? 'alta' : 'moderada'}.`
  }

  // ── Salvar no banco ───────────────────────────────────────────────────────
  const { data, error } = await db
    .from('macro_readings')
    .insert({ regime, macro_score, dxy_trend, yields_trend, fed_stance, notes })
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // ── Telegram ──────────────────────────────────────────────────────────────
  const regimeEmoji: Record<string, string> = {
    'risk-on':   '🟢',
    'risk-off':  '🔴',
    'transicao': '🟠',
    'neutro':    '🟡',
  }
  const dxyArrow    = { forte: '▲', lateral: '→', fraco: '▼' }[dxy_trend]    ?? '→'
  const yieldsArrow = { subindo: '▲', lateral: '→', caindo: '▼' }[yields_trend] ?? '→'
  const scoreStr    = macro_score >= 0 ? `+${macro_score}` : `${macro_score}`

  // Escapar HTML nos notes antes de enviar ao Telegram
  const safeNotes = notes
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

  return NextResponse.json({
    ok:    true,
    regime,
    macro_score,
    fed_stance,
    dxy:    { value: dxy,    sma20: dxySma20,    trend: dxy_trend    },
    yields: { value: yields, sma20: yieldsSma20, trend: yields_trend },
    vix,
    notes,
  })
}
