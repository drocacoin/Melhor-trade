'use client'
import { useState, useEffect } from 'react'
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine, Cell,
} from 'recharts'
import { cn, fmtPrice } from '@/lib/utils'

function StatCard({ label, value, sub, color }: { label: string; value: string | number; sub?: string; color?: string }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <p className="text-xs text-gray-500 mb-1">{label}</p>
      <p className={cn('text-xl font-bold font-mono', color ?? 'text-gray-100')}>{value}</p>
      {sub && <p className="text-xs text-gray-600 mt-0.5">{sub}</p>}
    </div>
  )
}

function pnlColor(v: number) { return v >= 0 ? '#10b981' : '#ef4444' }

const CustomTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-xs">
      <p className="text-gray-400 mb-1">{label}</p>
      {payload.map((p: any) => (
        <p key={p.name} style={{ color: p.color }}>
          {p.name}: ${fmtPrice(p.value)}
        </p>
      ))}
    </div>
  )
}

export default function JournalPage() {
  const [data, setData]   = useState<any>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/journal')
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false) })
  }, [])

  if (loading) return (
    <div className="flex items-center justify-center h-64">
      <div className="w-6 h-6 border-2 border-emerald-400 border-t-transparent rounded-full animate-spin" />
    </div>
  )

  if (!data || data.summary.total === 0) return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Journal</h1>
        <p className="text-sm text-gray-500">Performance e análise de resultados</p>
      </div>
      <div className="bg-gray-900 border border-dashed border-gray-700 rounded-xl p-12 text-center">
        <p className="text-gray-500">Nenhum trade fechado ainda.</p>
        <p className="text-gray-600 text-xs mt-1">Feche alguns trades para ver seus gráficos aqui.</p>
      </div>
    </div>
  )

  const { summary, equity, monthly, errors, perf, avgScores, processMap, rules } = data

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Journal</h1>
        <p className="text-sm text-gray-500">Performance e análise de resultados</p>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-3 mb-6">
        <StatCard label="Trades"    value={summary.total}                                                        />
        <StatCard label="Winrate"   value={`${summary.winrate.toFixed(1)}%`}    color={summary.winrate >= 50 ? 'text-emerald-400' : 'text-red-400'} />
        <StatCard label="Wins"      value={summary.winners}                      color="text-emerald-400"        />
        <StatCard label="Losses"    value={summary.losers}                       color="text-red-400"            />
        <StatCard label="P&L Total" value={`${summary.totalPnl >= 0 ? '+' : ''}$${fmtPrice(summary.totalPnl)}`} color={summary.totalPnl >= 0 ? 'text-emerald-400' : 'text-red-400'} />
        <StatCard label="Média Win" value={`+$${fmtPrice(summary.avgWin)}`}     color="text-emerald-400"        />
        <StatCard label="Média Loss" value={`-$${fmtPrice(Math.abs(summary.avgLoss))}`} color="text-red-400"   />
        <StatCard label="Fator"
          value={summary.avgLoss !== 0 ? (Math.abs(summary.avgWin / summary.avgLoss)).toFixed(2) : '—'}
          color="text-yellow-400" sub="win/loss ratio" />
      </div>

      {/* Best / Worst */}
      {(summary.best || summary.worst) && (
        <div className="grid grid-cols-2 gap-3 mb-6">
          {summary.best && (
            <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-xl p-4 flex items-center justify-between">
              <div>
                <p className="text-xs text-gray-500 mb-1">Melhor trade</p>
                <p className="font-semibold text-emerald-400">{summary.best.asset}</p>
              </div>
              <p className="text-2xl font-bold font-mono text-emerald-400">+${fmtPrice(summary.best.pnl)}</p>
            </div>
          )}
          {summary.worst && (
            <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 flex items-center justify-between">
              <div>
                <p className="text-xs text-gray-500 mb-1">Pior trade</p>
                <p className="font-semibold text-red-400">{summary.worst.asset}</p>
              </div>
              <p className="text-2xl font-bold font-mono text-red-400">${fmtPrice(summary.worst.pnl)}</p>
            </div>
          )}
        </div>
      )}

      {/* Equity curve */}
      {equity.length > 1 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-6">
          <p className="text-sm font-semibold text-gray-400 mb-4">Curva de capital (P&L acumulado)</p>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={equity} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#6b7280' }} />
              <YAxis tick={{ fontSize: 10, fill: '#6b7280' }} tickFormatter={v => `$${v}`} />
              <Tooltip content={<CustomTooltip />} />
              <ReferenceLine y={0} stroke="#374151" strokeDasharray="4 4" />
              <Line
                type="monotone" dataKey="cumulative" name="P&L acum."
                stroke="#10b981" strokeWidth={2} dot={false}
                activeDot={{ r: 4, fill: '#10b981' }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
        {/* P&L por trade */}
        {equity.length > 0 && (
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
            <p className="text-sm font-semibold text-gray-400 mb-4">P&L por trade</p>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={equity} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                <XAxis dataKey="asset" tick={{ fontSize: 10, fill: '#6b7280' }} />
                <YAxis tick={{ fontSize: 10, fill: '#6b7280' }} tickFormatter={v => `$${v}`} />
                <Tooltip content={<CustomTooltip />} />
                <ReferenceLine y={0} stroke="#374151" />
                <Bar dataKey="pnl" name="P&L" radius={[2, 2, 0, 0]}>
                  {equity.map((e: any, i: number) => (
                    <Cell key={i} fill={pnlColor(e.pnl)} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Monthly P&L */}
        {monthly.length > 0 && (
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
            <p className="text-sm font-semibold text-gray-400 mb-4">P&L mensal</p>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={monthly} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                <XAxis dataKey="month" tick={{ fontSize: 10, fill: '#6b7280' }} />
                <YAxis tick={{ fontSize: 10, fill: '#6b7280' }} tickFormatter={v => `$${v}`} />
                <Tooltip content={<CustomTooltip />} />
                <ReferenceLine y={0} stroke="#374151" />
                <Bar dataKey="pnl" name="P&L" radius={[3, 3, 0, 0]}>
                  {monthly.map((m: any, i: number) => (
                    <Cell key={i} fill={pnlColor(m.pnl)} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* AI Review Scores */}
      {avgScores?.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-6">
          <div className="flex items-center justify-between mb-4">
            <p className="text-sm font-semibold text-gray-400">✦ Scores médios (Review IA)</p>
            <div className="flex items-center gap-3 text-xs text-gray-500">
              {processMap && Object.entries(processMap).map(([cls, n]: any) => (
                <span key={cls} className={cn(
                  'px-2 py-0.5 rounded font-medium',
                  cls === 'correto' ? 'bg-emerald-500/20 text-emerald-400' :
                  cls === 'incorreto' ? 'bg-red-500/20 text-red-400' :
                  'bg-yellow-500/20 text-yellow-400'
                )}>{cls.replace('_', ' ')}: {n}</span>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-3">
            {avgScores.map((s: any) => {
              const color = s.score >= 7 ? 'text-emerald-400' : s.score >= 5 ? 'text-yellow-400' : 'text-red-400'
              const bg    = s.score >= 7 ? 'bg-emerald-500' : s.score >= 5 ? 'bg-yellow-500' : 'bg-red-500'
              return (
                <div key={s.dimension} className="bg-gray-800 rounded-lg p-3 text-center">
                  <p className="text-xs text-gray-500 capitalize mb-2">{s.dimension}</p>
                  <p className={cn('text-2xl font-bold font-mono', color)}>{s.score}</p>
                  <div className="mt-2 h-1 bg-gray-700 rounded-full overflow-hidden">
                    <div className={cn('h-full rounded-full', bg)} style={{ width: `${s.score * 10}%` }} />
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Regras geradas pela IA */}
      {rules?.length > 0 && (
        <div className="bg-blue-500/5 border border-blue-500/20 rounded-xl p-5 mb-6">
          <p className="text-sm font-semibold text-blue-400 mb-3">✦ Regras derivadas dos seus trades (IA)</p>
          <div className="space-y-2">
            {rules.map((r: any, i: number) => (
              <div key={i} className="flex items-start gap-2 text-sm">
                <span className="text-blue-500 mt-0.5 shrink-0">→</span>
                <p className="text-gray-300">{r.rule}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
        {/* Performance por ativo */}
        {perf.length > 0 && (
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
            <p className="text-sm font-semibold text-gray-400 mb-4">Performance por ativo</p>
            <div className="space-y-3">
              {perf.map((p: any) => (
                <div key={p.asset} className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-3 w-16">
                    <span className="font-semibold">{p.asset}</span>
                  </div>
                  <div className="flex-1 mx-3">
                    <div className="flex items-center gap-1 mb-1">
                      <div className="h-1.5 rounded-full bg-emerald-500"
                        style={{ width: `${p.total_trades ? (p.winners / p.total_trades) * 100 : 0}%`, maxWidth: '100%' }} />
                      <div className="h-1.5 rounded-full bg-red-500"
                        style={{ width: `${p.total_trades ? (p.losers / p.total_trades) * 100 : 0}%`, maxWidth: '100%' }} />
                    </div>
                    <p className="text-xs text-gray-600">
                      {p.winners}W / {p.losers}L — WR {Number(p.winrate_pct).toFixed(0)}%
                    </p>
                  </div>
                  <span className={cn('font-mono text-sm font-semibold', p.total_pnl_usd >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                    {p.total_pnl_usd >= 0 ? '+' : ''}${fmtPrice(p.total_pnl_usd)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Erros mais frequentes */}
        {errors.length > 0 && (
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
            <p className="text-sm font-semibold text-gray-400 mb-4">Erros mais frequentes (Review Engine)</p>
            <div className="space-y-2">
              {errors.slice(0, 8).map((e: any) => (
                <div key={e.category} className="flex items-center gap-3">
                  <div className="flex-1">
                    <div className="flex items-center justify-between mb-0.5">
                      <span className="text-xs text-gray-300">{e.category}</span>
                      <span className="text-xs text-gray-500">{e.count}x</span>
                    </div>
                    <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
                      <div className="h-full bg-red-500/60 rounded-full"
                        style={{ width: `${(e.count / errors[0].count) * 100}%` }} />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
