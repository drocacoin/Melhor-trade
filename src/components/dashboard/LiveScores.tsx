'use client'
import { useState, useEffect } from 'react'
import { cn } from '@/lib/utils'

interface AssetScore {
  asset:       string
  bullScore:   number
  bearScore:   number
  topScore:    number
  direction:   'bull' | 'bear' | 'neutral'
  threshold:   number
  gap:         number
  pct:         number
  thr_status:  string
  factors:     { label: string; bull: boolean; bear: boolean; points: number }[]
}

export function LiveScores() {
  const [scores, setScores]     = useState<AssetScore[]>([])
  const [fg, setFg]             = useState<{ value: number; label: string } | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [loading, setLoading]   = useState(true)

  useEffect(() => {
    fetch('/api/scores')
      .then(r => r.json())
      .then(d => { setScores(d.scores ?? []); setFg(d.fear_greed); setLoading(false) })
  }, [])

  if (loading) return (
    <div className="h-20 flex items-center justify-center">
      <div className="w-4 h-4 border-2 border-emerald-400 border-t-transparent rounded-full animate-spin" />
    </div>
  )

  return (
    <div className="mb-6">
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
          Score ao vivo — aquecimento de sinal
        </p>
        {fg && (
          <p className="text-xs text-gray-500">
            F&G: <span className={cn('font-semibold',
              fg.value >= 75 ? 'text-red-400' : fg.value <= 25 ? 'text-emerald-400' : 'text-gray-300'
            )}>{fg.value} — {fg.label}</span>
          </p>
        )}
      </div>

      <div className="grid grid-cols-5 gap-2">
        {scores.map(s => {
          const isHot    = s.gap <= 1 && s.topScore > 0
          const isSinal  = s.gap <= 0
          const dirColor = s.direction === 'bull' ? 'emerald' : s.direction === 'bear' ? 'red' : 'gray'
          const bar      = Math.min(100, s.pct)

          return (
            <button
              key={s.asset}
              onClick={() => setExpanded(expanded === s.asset ? null : s.asset)}
              className={cn(
                'rounded-xl border p-3 text-left transition-all',
                isSinal ? 'border-emerald-500/50 bg-emerald-500/10 ring-1 ring-emerald-500/30' :
                isHot   ? 'border-yellow-500/30 bg-yellow-500/5' :
                          'border-gray-800 bg-gray-900',
              )}
            >
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs font-bold text-gray-300">{s.asset}</span>
                {isSinal
                  ? <span className="text-xs bg-emerald-500 text-white px-1.5 py-0.5 rounded font-bold animate-pulse">SINAL</span>
                  : isHot
                  ? <span className="text-xs text-yellow-400 font-semibold">🔥 -{s.gap}pt</span>
                  : <span className="text-xs text-gray-600">-{s.gap}pt</span>
                }
              </div>

              {/* Score number */}
              <div className="flex items-end gap-1 mb-2">
                <span className={cn('text-2xl font-bold font-mono',
                  s.direction === 'bull' ? 'text-emerald-400' :
                  s.direction === 'bear' ? 'text-red-400' : 'text-gray-500'
                )}>{s.topScore}</span>
                <span className="text-xs text-gray-600 mb-0.5">/{s.threshold}</span>
                <span className={cn('text-xs mb-0.5 ml-1',
                  s.direction === 'bull' ? 'text-emerald-500' :
                  s.direction === 'bear' ? 'text-red-500' : 'text-gray-600'
                )}>
                  {s.direction === 'bull' ? '▲' : s.direction === 'bear' ? '▼' : '—'}
                </span>
              </div>

              {/* Progress bar */}
              <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
                <div
                  className={cn('h-full rounded-full transition-all',
                    isSinal  ? 'bg-emerald-500' :
                    isHot    ? 'bg-yellow-500' :
                    s.direction === 'bull' ? 'bg-emerald-600' :
                    s.direction === 'bear' ? 'bg-red-600' : 'bg-gray-600'
                  )}
                  style={{ width: `${bar}%` }}
                />
              </div>
            </button>
          )
        })}
      </div>

      {/* Fatores expandidos ao clicar */}
      {expanded && (() => {
        const s = scores.find(x => x.asset === expanded)
        if (!s || !s.factors.length) return null
        return (
          <div className="mt-2 bg-gray-900 border border-gray-800 rounded-xl p-4">
            <p className="text-xs font-semibold text-gray-400 mb-3">
              {s.asset} — fatores ativos
            </p>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
              {s.factors.map((f, i) => (
                <div key={i} className={cn(
                  'flex items-center gap-2 text-xs px-2 py-1.5 rounded-lg',
                  f.bull ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'
                )}>
                  <span>{f.bull ? '▲' : '▼'}</span>
                  <span>{f.label}</span>
                  <span className="ml-auto font-bold">+{f.points}</span>
                </div>
              ))}
            </div>
          </div>
        )
      })()}
    </div>
  )
}
