/**
 * Geração de análise IA para sinais — compartilhada entre o scan (Haiku)
 * e o endpoint manual (Opus).
 *
 * Haiku → análise automática rápida ao detectar sinal
 * Opus  → análise premium acionada pelo usuário na página Alertas
 */
import Anthropic from '@anthropic-ai/sdk'

type Model = 'haiku' | 'opus'

const MODEL_ID: Record<Model, string> = {
  haiku: 'claude-haiku-4-5',
  opus:  'claude-opus-4-5',
}

const MAX_TOKENS: Record<Model, number> = {
  haiku: 400,   // rápida e direta — vai no Telegram
  opus:  700,   // detalhada — para análise manual no app
}

export async function generateSignalAnalysis(
  signal:    any,
  snapshots: Record<string, any>,
  macro:     any,
  fg:        { value: number; label: string } | null,
  model:     Model = 'haiku',
): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set')

  const tfLines = ['1wk', '1d', '4h', '1h'].map(tf => {
    const s = snapshots[tf]
    if (!s) return `${tf}: sem dados`
    return `${tf}: close=$${s.close} | bias=${s.bias} | EMA200=${s.price_vs_ema} | Cloud=${s.price_vs_cloud} | WT1=${s.wt1?.toFixed(1)} (${s.wt_zone}) | T/K=${s.tenkan_vs_kijun} | BOS_up=${s.bos_up} BOS_down=${s.bos_down} | bull_pts=${s.bull_pts} bear_pts=${s.bear_pts}`
  }).join('\n')

  const macroCtx = macro
    ? `Regime: ${macro.regime} | Score: ${macro.macro_score} | DXY: ${macro.dxy_trend} | Yields: ${macro.yields_trend} | FED: ${macro.fed_stance}\n${macro.notes ?? ''}`
    : 'Sem leitura macro registrada.'

  const fgCtx = fg
    ? `Fear & Greed: ${fg.value} — ${fg.label}`
    : ''

  const maxSentences = model === 'haiku' ? '2' : '3'

  const prompt = `Você é um analista de swing trade. Analise este sinal de forma ${model === 'haiku' ? 'concisa e direta' : 'objetiva e estruturada'}.

SINAL:
- Ativo: ${signal.asset} | Direção: ${signal.direction.toUpperCase()} | Grade: ${signal.setup_grade}
- Entrada: $${signal.entry_zone_low} – $${signal.entry_zone_high}
- Stop: $${signal.stop} | Alvo 1: $${signal.target1} (RR ${signal.rr1}:1)
- Gatilho: ${signal.trigger}
- Cancelamento: ${signal.cancellation}

CONTEXTO TÉCNICO:
${tfLines}

MACRO & SENTIMENTO:
${macroCtx}
${fgCtx}

Gere análise com estas seções (máximo ${maxSentences} frases cada):

**ESTRUTURA:** Tendência e contexto técnico.
**CONFLUÊNCIAS:** Fatores que confirmam o sinal.
**ALERTAS:** Riscos e pontos de atenção.
**VEREDICTO:** Qualidade do setup e condições para entrada.`

  const client  = new Anthropic({ apiKey })
  const message = await client.messages.create({
    model:      MODEL_ID[model],
    max_tokens: MAX_TOKENS[model],
    messages:   [{ role: 'user', content: prompt }],
  })

  return (message.content[0] as any).text as string
}
