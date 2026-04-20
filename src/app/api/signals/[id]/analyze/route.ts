import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { supabaseAdmin } from '@/lib/supabase'

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const db      = supabaseAdmin()

  // Buscar sinal
  const { data: signal } = await db.from('signals').select('*').eq('id', id).single()
  if (!signal) return NextResponse.json({ error: 'Signal not found' }, { status: 404 })

  // Buscar snapshots do ativo (últimos por timeframe)
  const { data: snaps } = await db
    .from('snapshots')
    .select('*')
    .eq('asset', signal.asset)
    .order('captured_at', { ascending: false })
    .limit(20)

  const seen = new Set<string>()
  const latest: Record<string, any> = {}
  for (const s of snaps ?? []) {
    if (!seen.has(s.timeframe)) { seen.add(s.timeframe); latest[s.timeframe] = s }
  }

  // Buscar última leitura macro
  const { data: macro } = await db
    .from('macro_readings')
    .select('*')
    .order('captured_at', { ascending: false })
    .limit(1)
    .single()

  // Montar contexto técnico
  const tfLines = ['1wk', '1d', '4h', '1h'].map(tf => {
    const s = latest[tf]
    if (!s) return `${tf}: sem dados`
    return `${tf}: close=$${s.close} | bias=${s.bias} | EMA200=$${s.ema200} (${s.price_vs_ema}) | Cloud=${s.price_vs_cloud} | WT1=${s.wt1?.toFixed(1)} (${s.wt_zone}) | T/K=${s.tenkan_vs_kijun} | BOS_up=${s.bos_up} BOS_down=${s.bos_down} | bull_pts=${s.bull_pts} bear_pts=${s.bear_pts}`
  }).join('\n')

  const macroCtx = macro
    ? `Regime: ${macro.regime} | Score: ${macro.macro_score} | DXY: ${macro.dxy_trend} | Yields: ${macro.yields_trend} | FED: ${macro.fed_stance}\nNota macro: ${macro.notes ?? 'N/A'}`
    : 'Sem leitura macro registrada.'

  const prompt = `Você é um analista especialista em swing trade. Analise este sinal técnico de forma objetiva e concisa.

SINAL DETECTADO:
- Ativo: ${signal.asset}
- Direção: ${signal.direction.toUpperCase()}
- Grade: ${signal.setup_grade}
- Entrada: $${signal.entry_zone_low} – $${signal.entry_zone_high}
- Stop: $${signal.stop}
- Alvo 1: $${signal.target1} (RR ${signal.rr1}:1)
- Alvo 2: $${signal.target2 ?? 'N/A'}
- Gatilho: ${signal.trigger}
- Cancelamento: ${signal.cancellation}

CONTEXTO TÉCNICO POR TIMEFRAME:
${tfLines}

CONTEXTO MACRO:
${macroCtx}

Gere uma análise estruturada com exatamente estas seções (seja direto, máximo 3 frases por seção):

**CONTEXTO MACRO:** Como a macro afeta este setup.
**ESTRUTURA TÉCNICA:** Leitura da tendência e estrutura de mercado.
**CONFLUÊNCIAS:** Principais fatores técnicos que confirmam o sinal.
**ALERTAS:** Riscos ou pontos de atenção do setup.
**VEREDICTO:** Qualidade do setup, se o risco/retorno justifica e condições para entrada.`

  try {
    const client   = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    const message  = await client.messages.create({
      model:      'claude-opus-4-5',
      max_tokens: 600,
      messages:   [{ role: 'user', content: prompt }],
    })

    const analysis = (message.content[0] as any).text as string

    // Salvar no banco
    await db.from('signals').update({ analysis }).eq('id', id)

    return NextResponse.json({ analysis })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
