import { NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'

export async function GET() {
  const apiKey = process.env.ANTHROPIC_API_KEY

  // 1. Verificar se a key existe
  if (!apiKey) {
    return NextResponse.json({ step: 'env', error: 'ANTHROPIC_API_KEY não encontrada' }, { status: 500 })
  }

  // 2. Mostrar primeiros e últimos 4 chars (diagnóstico seguro)
  const preview = `${apiKey.slice(0, 10)}...${apiKey.slice(-4)} (${apiKey.length} chars)`

  // 3. Testar chamada mínima ao Haiku
  try {
    const client = new Anthropic({ apiKey: apiKey.trim() })
    const resp = await client.messages.create({
      model:      'claude-haiku-4-5',
      max_tokens: 10,
      messages:   [{ role: 'user', content: 'say ok' }],
    })
    return NextResponse.json({
      step:    'success',
      key:     preview,
      trimmed: apiKey !== apiKey.trim(),
      reply:   (resp.content[0] as any).text,
    })
  } catch (e: any) {
    return NextResponse.json({
      step:    'anthropic_call',
      key:     preview,
      trimmed: apiKey !== apiKey.trim(),
      error:   e.message,
    }, { status: 500 })
  }
}
