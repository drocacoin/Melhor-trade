'use client'
import { useState, useEffect } from 'react'
import { cn, fmtPrice } from '@/lib/utils'

function SentimentBar({ pct, long, short }: { pct: number; long: number; short: number }) {
  return (
    <div className="mt-2">
      <div className="flex h-2 rounded-full overflow-hidden bg-gray-800">
        <div className="bg-emerald-500 transition-all" style={{ width: `${pct}%` }} />
        <div className="bg-red-500 transition-all" style={{ width: `${100 - pct}%` }} />
      </div>
      <div className="flex justify-between text-xs mt-1 text-gray-600">
        <span className="text-emerald-500">{long}L</span>
        <span className="text-red-500">{short}S</span>
      </div>
    </div>
  )
}

function QualBadge({ score }: { score: number }) {
  const color = score >= 8 ? 'bg-emerald-500/20 text-emerald-400' :
                score >= 5 ? 'bg-yellow-500/20 text-yellow-400' :
                             'bg-gray-700 text-gray-500'
  return (
    <span className={cn('text-xs px-1.5 py-0.5 rounded font-semibold', color)}>
      Q{score}
    </span>
  )
}

export default function WhalesPage() {
  const [data, setData]       = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)
  const [filter, setFilter]   = useState<'all' | 'bullish' | 'bearish'>('all')

  async function load() {
    setLoading(true); setError(null)
    try {
      const r = await fetch('/api/whales')
      const d = await r.json()
      if (d.error) throw new Error(d.error)
      setData(d)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const sentiment: any[] = (data?.sentiment ?? []).filter((s: any) =>
    filter === 'all' ? true : s.sentiment === filter
  )
  const traders: any[]   = data?.traders ?? []
  const positions: any[] = data?.positions ?? []

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">🐳 Baleias</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Posições dos top traders HyperLiquid · ordenados por consistência
          </p>
        </div>
        <div className="flex items-center gap-2">
          {data?.updatedAt && (
            <span className="text-xs text-gray-600">
              {new Date(data.updatedAt).toLocaleTimeString('pt-BR')}
            </span>
          )}
          <button onClick={load} disabled={loading}
            className={cn('px-4 py-2 rounded-lg text-sm font-semibold transition-colors',
              loading ? 'bg-gray-800 text-gray-500 cursor-not-allowed'
                      : 'bg-gray-800 hover:bg-gray-700 text-gray-300'
            )}>
            {loading ? '⟳ Carregando...' : '⟳ Atualizar'}
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 mb-6 text-sm text-red-400">{error}</div>
      )}

      {loading && (
        <div className="space-y-4 animate-pulse">
          {[120, 200, 160].map((h, i) => (
            <div key={i} className="bg-gray-900 border border-gray-800 rounded-xl" style={{ height: h }} />
          ))}
        </div>
      )}

      {data && !loading && (
        <>
          {/* Resumo */}
          <div className="grid grid-cols-3 gap-4 mb-6">
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-center">
              <p className="text-2xl font-bold text-gray-100">{traders.length}</p>
              <p className="text-xs text-gray-500 mt-1">Top traders rastreados</p>
            </div>
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-center">
              <p className="text-2xl font-bold text-gray-100">{positions.length}</p>
              <p className="text-xs text-gray-500 mt-1">Posições ativas</p>
            </div>
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-center">
              <p className="text-2xl font-bold">
                <span className="text-emerald-400">
                  {data.sentiment?.filter((s: any) => s.sentiment === 'bullish').length ?? 0}
                </span>
                <span className="text-gray-600 mx-1">/</span>
                <span className="text-red-400">
                  {data.sentiment?.filter((s: any) => s.sentiment === 'bearish').length ?? 0}
                </span>
              </p>
              <p className="text-xs text-gray-500 mt-1">Ativos bullish / bearish</p>
            </div>
          </div>

          {/* Sentimento por ativo */}
          <div className="mb-6">
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm font-semibold text-gray-400">Sentimento das baleias por ativo</p>
              <div className="flex gap-1 text-xs">
                {(['all', 'bullish', 'bearish'] as const).map(f => (
                  <button key={f} onClick={() => setFilter(f)}
                    className={cn('px-3 py-1 rounded-md transition-colors capitalize',
                      filter === f ? 'bg-emerald-500/20 text-emerald-400 font-medium'
                                   : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800'
                    )}>
                    {f === 'all' ? 'Todos' : f === 'bullish' ? '🟢 Bullish' : '🔴 Bearish'}
                  </button>
                ))}
              </div>
            </div>

            {sentiment.length === 0 ? (
              <div className="bg-gray-900 border border-dashed border-gray-700 rounded-xl p-8 text-center">
                <p className="text-gray-500 text-sm">Sem dados de sentimento para o filtro selecionado.</p>
              </div>
            ) : (
              <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3">
                {sentiment.map((s: any) => {
                  const sentimentColor = s.sentiment === 'bullish' ? 'border-emerald-500/20 bg-emerald-500/5' :
                                         s.sentiment === 'bearish' ? 'border-red-500/20 bg-red-500/5' :
                                         'border-gray-800 bg-gray-900'
                  const sentimentText  = s.sentiment === 'bullish' ? 'text-emerald-400' :
                                         s.sentiment === 'bearish' ? 'text-red-400' : 'text-gray-500'
                  return (
                    <div key={s.asset} className={cn('rounded-xl border p-4', sentimentColor)}>
                      <div className="flex items-center justify-between mb-1">
                        <span className="font-bold text-gray-100">{s.asset}</span>
                        <span className={cn('text-xs font-semibold capitalize', sentimentText)}>
                          {s.sentiment === 'bullish' ? '🟢' : s.sentiment === 'bearish' ? '🔴' : '🟡'} {s.sentiment}
                        </span>
                      </div>
                      <p className="text-xs text-gray-500 mb-2">
                        ${fmtPrice(s.longValue + s.shortValue)} total
                      </p>
                      <SentimentBar pct={s.sentimentPct} long={s.longCount} short={s.shortCount} />
                      <p className={cn('text-lg font-bold font-mono mt-2', sentimentText)}>
                        {s.sentimentPct}% long
                      </p>

                      {/* Top posições */}
                      {s.topPositions?.length > 0 && (
                        <div className="mt-3 space-y-1.5 border-t border-gray-800 pt-2">
                          {s.topPositions.slice(0, 3).map((p: any, i: number) => (
                            <div key={i} className="flex items-center justify-between text-xs">
                              <div className="flex items-center gap-1.5">
                                <QualBadge score={p.qualScore} />
                                <span className="text-gray-500 font-mono truncate max-w-[80px]">
                                  {p.traderName}
                                </span>
                              </div>
                              <div className="flex items-center gap-1">
                                <span className={p.direction === 'long' ? 'text-emerald-400' : 'text-red-400'}>
                                  {p.direction === 'long' ? '▲' : '▼'}
                                </span>
                                <span className="text-gray-400">${fmtPrice(p.value)}</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* Top traders */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden mb-6">
            <div className="px-4 py-3 border-b border-gray-800">
              <p className="text-sm font-semibold text-gray-400">Top traders rastreados</p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-gray-600 border-b border-gray-800">
                    <th className="text-left px-4 py-2">#</th>
                    <th className="text-left px-4 py-2">Trader</th>
                    <th className="text-center px-4 py-2">Qualidade</th>
                    <th className="text-right px-4 py-2">Conta</th>
                    <th className="text-right px-4 py-2">PnL 30d</th>
                    <th className="text-right px-4 py-2">PnL 7d</th>
                    <th className="text-right px-4 py-2">PnL 1d</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800/50">
                  {traders.map((t: any, i: number) => (
                    <tr key={t.address} className="hover:bg-gray-800/30 transition-colors">
                      <td className="px-4 py-2.5 text-gray-600 text-xs">{i + 1}</td>
                      <td className="px-4 py-2.5">
                        <span className="font-mono text-xs text-gray-300">{t.name}</span>
                      </td>
                      <td className="px-4 py-2.5 text-center">
                        <QualBadge score={t.qualScore} />
                      </td>
                      <td className="px-4 py-2.5 text-right text-gray-400 font-mono text-xs">
                        ${fmtPrice(t.accountVal)}
                      </td>
                      <td className={cn('px-4 py-2.5 text-right font-mono text-xs font-semibold',
                        t.pnl30d >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                        {t.pnl30d >= 0 ? '+' : ''}${fmtPrice(t.pnl30d)}
                      </td>
                      <td className={cn('px-4 py-2.5 text-right font-mono text-xs',
                        t.pnl7d >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                        {t.pnl7d >= 0 ? '+' : ''}${fmtPrice(t.pnl7d)}
                      </td>
                      <td className={cn('px-4 py-2.5 text-right font-mono text-xs',
                        t.pnl1d >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                        {t.pnl1d >= 0 ? '+' : ''}${fmtPrice(t.pnl1d)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
