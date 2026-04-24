'use client'
import { useState, useEffect } from 'react'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine, Legend,
} from 'recharts'
import { cn, fmtPrice } from '@/lib/utils'

// ── Helpers ────────────────────────────────────────────────────────────────────
function delta(v: number, suffix = '') {
  const sign = v > 0 ? '+' : ''
  return `${sign}${v.toFixed(1)}${suffix}`
}

// ── Comparison block ───────────────────────────────────────────────────────────
function CompareCard({
  label, total, wins, losses, winrate, pnl, highlight = false,
}: {
  label: string; total: number; wins: number; losses: number
  winrate: number; pnl: number; highlight?: boolean
}) {
  const isGreen = pnl >= 0
  return (
    <div className={cn(
      'rounded-xl border p-5',
      highlight
        ? 'bg-emerald-500/10 border-emerald-500/30'
        : 'bg-gray-900 border-gray-800'
    )}>
      <p className={cn('text-xs font-semibold mb-4 uppercase tracking-wide',
        highlight ? 'text-emerald-400' : 'text-gray-500'
      )}>{label}</p>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <p className="text-xs text-gray-600">Trades</p>
          <p className="text-2xl font-bold font-mono text-gray-100">{total}</p>
        </div>
        <div>
          <p className="text-xs text-gray-600">Win Rate</p>
          <p className={cn('text-2xl font-bold font-mono',
            winrate >= 55 ? 'text-emerald-400' : winrate >= 45 ? 'text-yellow-400' : 'text-red-400'
          )}>{winrate.toFixed(1)}%</p>
        </div>
        <div>
          <p className="text-xs text-gray-600">Wins / Losses</p>
          <p className="text-sm font-semibold">
            <span className="text-emerald-400">{wins}W</span>
            <span className="text-gray-600"> / </span>
            <span className="text-red-400">{losses}L</span>
          </p>
        </div>
        <div>
          <p className="text-xs text-gray-600">P&L total</p>
          <p className={cn('text-sm font-bold font-mono', isGreen ? 'text-emerald-400' : 'text-red-400')}>
            {isGreen ? '+' : ''}${fmtPrice(pnl)}
          </p>
        </div>
      </div>
    </div>
  )
}

// ── Tooltip customizado ────────────────────────────────────────────────────────
function BtTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-xs">
      <p className="text-gray-400 mb-1">{label}</p>
      {payload.map((p: any) => (
        <p key={p.dataKey} style={{ color: p.color }}>
          {p.name}: {p.value >= 0 ? '+' : ''}${fmtPrice(p.value)}
        </p>
      ))}
    </div>
  )
}

// ── Main Page ──────────────────────────────────────────────────────────────────
export default function BacktestPage() {
  const [data, setData]     = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<'all' | 'signal' | 'skip'>('all')

  useEffect(() => {
    fetch('/api/backtest')
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false) })
  }, [])

  if (loading) return (
    <div className="flex items-center justify-center h-64">
      <div className="w-6 h-6 border-2 border-emerald-400 border-t-transparent rounded-full animate-spin" />
    </div>
  )

  if (!data?.trades?.length) return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Backtest</h1>
        <p className="text-sm text-gray-500">Simulação dos pesos atuais no histórico de trades</p>
      </div>
      <div className="bg-gray-900 border border-dashed border-gray-700 rounded-xl p-12 text-center">
        <p className="text-gray-500">Nenhum trade fechado para simular.</p>
      </div>
    </div>
  )

  const { trades, equity, summary } = data
  const { all, system, skipped, coverage, no_snaps, wr_delta, pnl_delta } = summary

  const filtered = trades.filter((t: any) =>
    filter === 'all'    ? true :
    filter === 'signal' ? t.would_signal :
    !t.would_signal
  )

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Backtest</h1>
        <p className="text-sm text-gray-500">
          Simulação dos pesos atuais no histórico · {trades.length} trades analisados
          {no_snaps > 0 && <span className="text-yellow-500 ml-2">({no_snaps} sem snapshots históricos)</span>}
        </p>
      </div>

      {/* ── Delta badges ───────────────────────────────────────────────────── */}
      <div className="flex gap-3 mb-6 flex-wrap">
        <div className={cn(
          'px-4 py-2 rounded-lg border text-sm font-semibold',
          wr_delta > 0
            ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
            : wr_delta < 0
            ? 'bg-red-500/10 border-red-500/30 text-red-400'
            : 'bg-gray-800 border-gray-700 text-gray-400'
        )}>
          WR {delta(wr_delta, '%')} se filtrado pelo sistema
        </div>
        <div className={cn(
          'px-4 py-2 rounded-lg border text-sm font-semibold',
          pnl_delta > 0
            ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
            : pnl_delta < 0
            ? 'bg-red-500/10 border-red-500/30 text-red-400'
            : 'bg-gray-800 border-gray-700 text-gray-400'
        )}>
          P&L {pnl_delta >= 0 ? '+' : ''}${fmtPrice(pnl_delta)} se filtrado
        </div>
        <div className="px-4 py-2 rounded-lg border border-gray-700 bg-gray-800 text-sm text-gray-400">
          Cobertura: <span className="text-gray-200 font-semibold">{coverage.toFixed(1)}%</span> dos trades seriam aceitos
        </div>
      </div>

      {/* ── Comparação lado a lado ─────────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <CompareCard label="Todos os trades"            {...all}    />
        <CompareCard label="✦ Filtrado pelo sistema"    {...system} highlight />
        <CompareCard label="Ignorados pelo sistema"     {...skipped} />
      </div>

      {/* ── Equity curve comparada ────────────────────────────────────────── */}
      {equity.length > 1 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-6">
          <p className="text-sm font-semibold text-gray-400 mb-4">
            Curva de equity — Real vs Sistema
          </p>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={equity} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#6b7280' }} />
              <YAxis tick={{ fontSize: 10, fill: '#6b7280' }} tickFormatter={v => `$${v}`} />
              <Tooltip content={<BtTooltip />} />
              <ReferenceLine y={0} stroke="#374151" strokeDasharray="4 4" />
              <Legend
                formatter={(v) => v === 'cumAll' ? 'Real (todos)' : 'Sistema (filtrado)'}
                wrapperStyle={{ fontSize: 11, color: '#9ca3af' }}
              />
              <Line type="monotone" dataKey="cumAll" name="cumAll"
                stroke="#6b7280" strokeWidth={1.5} dot={false}
                activeDot={{ r: 3 }} strokeDasharray="4 4" />
              <Line type="monotone" dataKey="cumSys" name="cumSys"
                stroke="#10b981" strokeWidth={2.5} dot={false}
                activeDot={{ r: 4, fill: '#10b981' }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* ── Tabela de trades ──────────────────────────────────────────────── */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        {/* Filtros */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
          <p className="text-sm font-semibold text-gray-400">Trades simulados</p>
          <div className="flex gap-1 text-xs">
            {(['all', 'signal', 'skip'] as const).map(f => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={cn(
                  'px-3 py-1 rounded-md transition-colors',
                  filter === f
                    ? 'bg-emerald-500/20 text-emerald-400 font-medium'
                    : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800'
                )}
              >
                {f === 'all' ? `Todos (${trades.length})` : f === 'signal' ? `Sistema (${system.total})` : `Ignorados (${skipped.total})`}
              </button>
            ))}
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-gray-600 border-b border-gray-800">
                <th className="text-left px-4 py-2">Trade</th>
                <th className="text-left px-4 py-2">Data</th>
                <th className="text-center px-4 py-2">Score</th>
                <th className="text-center px-4 py-2">Threshold</th>
                <th className="text-center px-4 py-2">Sistema?</th>
                <th className="text-center px-4 py-2">Resultado</th>
                <th className="text-right px-4 py-2">P&L</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/50">
              {filtered.map((t: any) => {
                const dirEmoji = t.direction === 'long' ? '🟢' : '🔴'
                const signalBg = t.would_signal
                  ? 'bg-emerald-500/5'
                  : t.has_snaps ? '' : 'opacity-40'
                return (
                  <tr key={t.id} className={cn('hover:bg-gray-800/30 transition-colors', signalBg)}>
                    <td className="px-4 py-2.5 font-semibold">
                      {dirEmoji} {t.asset}
                      <span className="text-xs text-gray-600 font-normal ml-1">{t.direction}</span>
                    </td>
                    <td className="px-4 py-2.5 text-gray-500 text-xs">{t.opened_at}</td>
                    <td className="px-4 py-2.5 text-center">
                      {t.has_snaps ? (
                        <span className={cn(
                          'font-mono font-semibold text-sm',
                          t.score >= t.threshold ? 'text-emerald-400' : 'text-gray-400'
                        )}>{t.score}</span>
                      ) : (
                        <span className="text-gray-700 text-xs">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-center text-gray-600 text-xs">{t.threshold}</td>
                    <td className="px-4 py-2.5 text-center">
                      {!t.has_snaps ? (
                        <span className="text-xs text-gray-700">sem dados</span>
                      ) : t.would_signal ? (
                        <span className="text-xs bg-emerald-500/20 text-emerald-400 px-2 py-0.5 rounded-full font-medium">✓ sim</span>
                      ) : (
                        <span className="text-xs bg-gray-800 text-gray-600 px-2 py-0.5 rounded-full">✗ não</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-center">
                      {t.is_win
                        ? <span className="text-xs bg-emerald-500/10 text-emerald-400 px-2 py-0.5 rounded-full">Win</span>
                        : <span className="text-xs bg-red-500/10 text-red-400 px-2 py-0.5 rounded-full">Loss</span>
                      }
                    </td>
                    <td className={cn(
                      'px-4 py-2.5 text-right font-mono font-semibold',
                      t.is_win ? 'text-emerald-400' : 'text-red-400'
                    )}>
                      {t.pnl_usd >= 0 ? '+' : ''}${fmtPrice(t.pnl_usd)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
