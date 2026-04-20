/**
 * Auto-review engine: chamado ao fechar um trade.
 * Usa Claude Haiku para analisar o trade e preencher a tabela trade_reviews.
 */
import Anthropic from '@anthropic-ai/sdk'
import { supabaseAdmin } from './supabase'

const ERROR_CATEGORIES = [
  'Entrada precipitada',
  'Entrada atrasada',
  'Stop muito curto',
  'Stop muito largo',
  'Saída prematura',
  'Segurou demais',
  'Contra-tendência',
  'Setup fraco',
  'Gestão de risco ruim',
  'Tamanho de posição errado',
  'Execução correta',
  'Mercado desfavorável',
]

interface ReviewResult {
  score_estrutura:    number
  score_timing:       number
  score_indicadores:  number
  score_macro:        number
  score_risco:        number
  score_execucao:     number
  score_disciplina:   number
  process_class:      string
  error_category:     string
  what_went_right:    string
  what_went_wrong:    string
  main_error:         string
  main_success:       string
  next_trade_change:  string
  new_rule:           string
  trade_really_existed: boolean
  forced_entry:       boolean
}

export async function autoReview(tradeId: number): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return

  const db = supabaseAdmin()

  // ── Fetch trade ─────────────────────────────────────────────────────────────
  const { data: trade } = await db.from('trades').select('*').eq('id', tradeId).single()
  if (!trade) return

  // ── Fetch snapshots closest to entry date ────────────────────────────────────
  const entryDate = trade.opened_at?.slice(0, 10) ?? new Date().toISOString().slice(0, 10)
  const { data: snaps } = await db
    .from('snapshots')
    .select('*')
    .eq('asset', trade.asset)
    .gte('captured_at', `${entryDate}T00:00:00`)
    .lte('captured_at', `${entryDate}T23:59:59`)
    .order('captured_at', { ascending: true })
    .limit(20)

  // One snapshot per timeframe
  const tfMap: Record<string, any> = {}
  for (const s of snaps ?? []) {
    if (!tfMap[s.timeframe]) tfMap[s.timeframe] = s
  }

  const tfContext = ['1wk', '1d', '4h', '1h'].map(tf => {
    const s = tfMap[tf]
    if (!s) return `${tf}: sem dados na data de entrada`
    return `${tf}: bias=${s.bias} | EMA200=${s.price_vs_ema} | Cloud=${s.price_vs_cloud} | WT1=${s.wt1?.toFixed(1)} zona=${s.wt_zone} | BOS_up=${s.bos_up} BOS_down=${s.bos_down}`
  }).join('\n')

  // ── Fetch macro reading at time of entry ─────────────────────────────────────
  const { data: macro } = await db
    .from('macro_readings')
    .select('*')
    .lte('captured_at', trade.opened_at ?? new Date().toISOString())
    .order('captured_at', { ascending: false })
    .limit(1)
    .single()

  const macroCtx = macro
    ? `Regime: ${macro.regime} | Score: ${macro.macro_score} | DXY: ${macro.dxy_trend} | FED: ${macro.fed_stance}`
    : 'Sem leitura macro registrada.'

  // ── Calcular resultado ────────────────────────────────────────────────────────
  const pnlSign   = (trade.pnl_usd ?? 0) >= 0 ? '+' : ''
  const resultado = `${pnlSign}$${(trade.pnl_usd ?? 0).toFixed(2)} (${pnlSign}${(trade.pnl_pct ?? 0).toFixed(2)}%)`

  // ── Prompt ────────────────────────────────────────────────────────────────────
  const prompt = `Você é um coach de trading especializado em swing trade. Analise este trade encerrado e retorne APENAS um JSON válido, sem texto adicional.

TRADE:
- Ativo: ${trade.asset}
- Direção: ${trade.direction}
- Entrada: $${trade.entry_price} | Fechamento: $${trade.close_price}
- Resultado: ${resultado}
- Leverage: ${trade.leverage}x
- Notas do trader: "${trade.notes ?? 'sem notas'}"

CONTEXTO TÉCNICO NA ENTRADA:
${tfContext}

MACRO NA ENTRADA:
${macroCtx}

CATEGORIAS DE ERRO POSSÍVEIS (escolha a mais relevante):
${ERROR_CATEGORIES.join(', ')}

Responda APENAS com este JSON (sem markdown, sem texto):
{
  "score_estrutura": <0-10>,
  "score_timing": <0-10>,
  "score_indicadores": <0-10>,
  "score_macro": <0-10>,
  "score_risco": <0-10>,
  "score_execucao": <0-10>,
  "score_disciplina": <0-10>,
  "process_class": "<correto|parcialmente_correto|incorreto>",
  "error_category": "<categoria do erro principal ou 'Execução correta' se trade positivo>",
  "what_went_right": "<o que funcionou, max 2 frases>",
  "what_went_wrong": "<o que falhou, max 2 frases>",
  "main_error": "<erro principal em 5 palavras>",
  "main_success": "<acerto principal em 5 palavras>",
  "next_trade_change": "<o que mudar no próximo trade, 1 frase>",
  "new_rule": "<regra derivada deste trade, 1 frase>",
  "trade_really_existed": <true|false>,
  "forced_entry": <true|false>
}`

  // ── Call Haiku ────────────────────────────────────────────────────────────────
  try {
    const client  = new Anthropic({ apiKey })
    const message = await client.messages.create({
      model:      'claude-haiku-4-5',
      max_tokens: 700,
      messages:   [{ role: 'user', content: prompt }],
    })

    const raw = (message.content[0] as any).text as string

    // Extract JSON even if there's surrounding text
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error('No JSON in response')

    const review: ReviewResult = JSON.parse(jsonMatch[0])

    // Clamp scores 0-10
    const scores = ['score_estrutura','score_timing','score_indicadores','score_macro','score_risco','score_execucao','score_disciplina'] as const
    for (const key of scores) {
      review[key] = Math.min(10, Math.max(0, Math.round(review[key] ?? 5)))
    }

    await db.from('trade_reviews').insert({
      trade_id:    tradeId,
      reviewed_at: new Date().toISOString(),
      ...review,
    })

    console.log(`[auto-review] Trade ${tradeId} reviewed — ${review.process_class} | ${review.error_category}`)
  } catch (e: any) {
    console.error(`[auto-review] Trade ${tradeId} failed:`, e.message)
  }
}
