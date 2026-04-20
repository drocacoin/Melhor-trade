import { NextRequest, NextResponse } from 'next/server'
import { sendTelegram } from '@/lib/telegram'

export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get('secret')
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const token  = process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_CHAT_ID

  if (!token || !chatId) {
    return NextResponse.json({
      ok: false,
      error: 'TELEGRAM_BOT_TOKEN ou TELEGRAM_CHAT_ID não configurado no Vercel',
    }, { status: 400 })
  }

  const ok = await sendTelegram(
    `✅ <b>Melhor Trade — Telegram configurado!</b>\n\nVocê receberá alertas quando:\n• 🟢🔴 Um sinal for detectado\n• ⚠️ Uma posição se aproximar do stop\n• 🔍 Resumo do scan matinal`
  )

  return NextResponse.json({
    ok,
    token_prefix: token.slice(0, 10) + '...',
    chat_id: chatId,
    message: ok ? 'Mensagem enviada com sucesso!' : 'Falha ao enviar — verifique o token e chat_id',
  })
}
