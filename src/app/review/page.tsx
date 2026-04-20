'use client'
import { useState, useEffect, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { cn } from '@/lib/utils'

const ERROR_CATEGORIES = [
  'entrada antecipada', 'entrada atrasada', 'stop mal posicionado', 'alvo ruim',
  'excesso de confiança', 'trade contra macro', 'trade contra tendência',
  'trade sem confluência', 'ignorou liquidez', 'ignorou resistência ou suporte',
  'tamanho excessivo', 'overtrading', 'erro emocional', 'erro de interpretação', 'erro de timing',
]

const SCORES = [0,1,2,3,4,5,6,7,8,9,10]

const DIMS = [
  { key: 'score_estrutura',   label: 'Leitura Estrutural' },
  { key: 'score_timing',      label: 'Timing' },
  { key: 'score_indicadores', label: 'Indicadores' },
  { key: 'score_macro',       label: 'Leitura Macro' },
  { key: 'score_risco',       label: 'Gestão de Risco' },
  { key: 'score_execucao',    label: 'Execução' },
  { key: 'score_disciplina',  label: 'Disciplina' },
]

const empty: any = {
  trade_id: null, score_estrutura: 5, score_timing: 5, score_indicadores: 5,
  score_macro: 5, score_risco: 5, score_execucao: 5, score_disciplina: 5,
  error_category: '', what_went_right: '', what_went_wrong: '', main_error: '',
  main_success: '', next_trade_change: '', new_rule: '',
  trade_really_existed: true, forced_entry: false,
}

function ReviewForm() {
  const searchParams  = useSearchParams()
  const tradeId       = searchParams.get('trade')
  const [form, setForm] = useState({ ...empty, trade_id: tradeId ? +tradeId : null })
  const [reviews, setReviews] = useState<any[]>([])
  const [saved, setSaved] = useState(false)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    fetch('/api/review').then(r => r.json()).then(setReviews)
  }, [])

  const avg = DIMS.reduce((s, d) => s + (form[d.key] as number), 0) / DIMS.length
  const processClass = avg >= 7 ? 'correto' : avg >= 4 ? 'parcialmente correto' : 'incorreto'
  const processColor = avg >= 7 ? 'text-emerald-400' : avg >= 4 ? 'text-yellow-400' : 'text-red-400'

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    await fetch('/api/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    })
    setSaved(true)
    setLoading(false)
    const data = await (await fetch('/api/review')).json()
    setReviews(data)
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Review Engine</h1>
        <p className="text-sm text-gray-500 mt-0.5">Avaliação pós-trade — processo, não só resultado</p>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* Form */}
        <form onSubmit={submit} className="bg-gray-900 border border-gray-800 rounded-xl p-6">
          <h2 className="text-sm font-semibold text-emerald-400 mb-5">Novo review</h2>

          {tradeId && (
            <p className="text-xs text-gray-500 mb-4 bg-gray-800 px-3 py-2 rounded">Trade #{tradeId} selecionado</p>
          )}

          {/* Scores */}
          <div className="space-y-3 mb-6">
            <p className="text-xs text-gray-500 uppercase tracking-wide">Pontuação (0–10)</p>
            {DIMS.map(d => (
              <div key={d.key} className="flex items-center gap-3">
                <label className="text-xs text-gray-400 w-36 shrink-0">{d.label}</label>
                <input type="range" min={0} max={10} value={form[d.key]}
                  onChange={e => setForm((f: any) => ({ ...f, [d.key]: +e.target.value }))}
                  className="flex-1 accent-emerald-500" />
                <span className={cn('text-sm font-bold w-6 text-right',
                  form[d.key] >= 7 ? 'text-emerald-400' : form[d.key] >= 4 ? 'text-yellow-400' : 'text-red-400'
                )}>{form[d.key]}</span>
              </div>
            ))}
          </div>

          {/* Score summary */}
          <div className="bg-gray-800 rounded-lg p-3 mb-6 flex items-center justify-between">
            <span className="text-xs text-gray-400">Nota média</span>
            <span className={cn('text-lg font-bold', processColor)}>{avg.toFixed(1)}</span>
            <span className={cn('text-xs font-semibold px-2 py-1 rounded', processColor,
              avg >= 7 ? 'bg-emerald-500/20' : avg >= 4 ? 'bg-yellow-500/20' : 'bg-red-500/20'
            )}>Processo {processClass}</span>
          </div>

          {/* Checkboxes */}
          <div className="flex gap-6 mb-4">
            {[
              { key: 'trade_really_existed', label: 'Trade realmente existia?' },
              { key: 'forced_entry',         label: 'Entrada forçada?' },
            ].map(({ key, label }) => (
              <label key={key} className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
                <input type="checkbox" checked={form[key]}
                  onChange={e => setForm((f: any) => ({ ...f, [key]: e.target.checked }))}
                  className="accent-emerald-500 w-4 h-4" />
                {label}
              </label>
            ))}
          </div>

          {/* Error category */}
          <label className="flex flex-col gap-1 text-xs text-gray-400 mb-4">
            Categoria do erro principal
            <select value={form.error_category} onChange={e => setForm((f: any) => ({ ...f, error_category: e.target.value }))}
              className="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm text-gray-100">
              <option value="">Nenhum erro principal</option>
              {ERROR_CATEGORIES.map(c => <option key={c}>{c}</option>)}
            </select>
          </label>

          {/* Text fields */}
          {[
            { key: 'what_went_right',    label: 'O que foi feito corretamente' },
            { key: 'what_went_wrong',    label: 'O que foi feito errado' },
            { key: 'main_error',         label: 'Erro principal' },
            { key: 'main_success',       label: 'Acerto principal' },
            { key: 'next_trade_change',  label: 'O que muda no próximo trade' },
            { key: 'new_rule',           label: 'Regra nova criada (se houver)' },
          ].map(({ key, label }) => (
            <label key={key} className="flex flex-col gap-1 text-xs text-gray-400 mb-3">
              {label}
              <textarea value={form[key]} onChange={e => setForm((f: any) => ({ ...f, [key]: e.target.value }))}
                rows={2} className="bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100 resize-none" />
            </label>
          ))}

          <button type="submit" disabled={loading}
            className="w-full bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-black font-semibold py-2 rounded-lg text-sm mt-2">
            {saved ? 'Review salvo!' : 'Salvar review'}
          </button>
        </form>

        {/* Review history */}
        <div>
          <h2 className="text-sm font-semibold text-gray-400 mb-3">Histórico de reviews</h2>
          <div className="space-y-3">
            {reviews.length === 0 && (
              <p className="text-gray-600 text-sm text-center py-8">Nenhum review ainda</p>
            )}
            {reviews.map((r: any) => (
              <div key={r.id} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-500">Trade #{r.trade_id}</span>
                    {r.trades && <span className="text-xs font-semibold text-gray-300">{r.trades.asset} {r.trades.direction?.toUpperCase()}</span>}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={cn('text-sm font-bold',
                      r.score_medio >= 7 ? 'text-emerald-400' : r.score_medio >= 4 ? 'text-yellow-400' : 'text-red-400'
                    )}>{Number(r.score_medio).toFixed(1)}</span>
                    <span className={cn('text-xs px-2 py-0.5 rounded font-medium',
                      r.process_class === 'correto' ? 'bg-emerald-500/20 text-emerald-400' :
                      r.process_class === 'parcialmente_correto' ? 'bg-yellow-500/20 text-yellow-400' :
                      'bg-red-500/20 text-red-400'
                    )}>{r.process_class?.replace('_', ' ')}</span>
                  </div>
                </div>
                {r.error_category && (
                  <p className="text-xs text-red-400 mb-1">Erro: {r.error_category}</p>
                )}
                {r.main_error && <p className="text-xs text-gray-500">{r.main_error}</p>}
                {r.new_rule && (
                  <div className="mt-2 bg-emerald-500/10 border border-emerald-500/20 rounded px-3 py-1.5 text-xs text-emerald-400">
                    Nova regra: {r.new_rule}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

export default function ReviewPage() {
  return <Suspense><ReviewForm /></Suspense>
}
