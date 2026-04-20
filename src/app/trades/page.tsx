'use client'
import { useState, useEffect } from 'react'
import { Trade, Asset, Direction, SetupGrade } from '@/types'
import { fmtPrice, fmtPct, cn, gradeColor, pnlColor } from '@/lib/utils'

const ASSETS: Asset[]      = ['BTC', 'ETH', 'SOL', 'GOLD', 'OIL']
const GRADES: SetupGrade[] = ['A+', 'A', 'B', 'C']

const empty = {
  asset: 'BTC' as Asset, direction: 'long' as Direction,
  leverage: 1, entry_price: '', stop_price: '', target1: '',
  target2: '', target3: '', size: '', setup_grade: 'A' as SetupGrade, notes: '',
}

export default function TradesPage() {
  const [trades, setTrades]     = useState<Trade[]>([])
  const [form, setForm]         = useState(empty)
  const [closing, setClosing]   = useState<{ id: number; price: string } | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [loading, setLoading]   = useState(false)
  const [tab, setTab]           = useState<'open' | 'closed'>('open')

  async function load() {
    const res  = await fetch('/api/trades')
    const data = await res.json()
    setTrades(data)
  }

  useEffect(() => { load() }, [])

  async function openTrade(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    const rr = form.target1 && form.entry_price && form.stop_price
      ? Math.abs(+form.target1 - +form.entry_price) / Math.abs(+form.entry_price - +form.stop_price)
      : null
    await fetch('/api/trades', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...form, entry_price: +form.entry_price, stop_price: +form.stop_price,
        target1: +form.target1 || null, target2: +form.target2 || null, target3: +form.target3 || null,
        size: +form.size || null }),
    })
    setForm(empty); setShowForm(false); setLoading(false); load()
  }

  async function closeTrade() {
    if (!closing) return
    setLoading(true)
    await fetch(`/api/trades/${closing.id}/close`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ close_price: +closing.price }),
    })
    setClosing(null); setLoading(false); load()
  }

  const open   = trades.filter(t => t.status === 'open')
  const closed = trades.filter(t => t.status === 'closed')
  const totalPnl = closed.reduce((s, t) => s + (t.pnl_usd ?? 0), 0)

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Trades</h1>
          <p className="text-sm text-gray-500">Gestão de posições e P&L</p>
        </div>
        <button onClick={() => setShowForm(!showForm)}
          className="bg-emerald-500 hover:bg-emerald-400 text-black font-semibold px-4 py-2 rounded-lg text-sm transition-colors">
          + Abrir Trade
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        {[
          { label: 'Abertos',  value: open.length,     sub: 'posições' },
          { label: 'Fechados', value: closed.length,   sub: 'trades' },
          { label: 'Winrate',  value: closed.length
              ? `${((closed.filter(t => (t.pnl_usd ?? 0) > 0).length / closed.length) * 100).toFixed(0)}%`
              : '—', sub: 'acertos' },
          { label: 'P&L Total', value: fmtPrice(totalPnl), sub: 'USD', color: pnlColor(totalPnl) },
        ].map(s => (
          <div key={s.label} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <p className="text-xs text-gray-500 mb-1">{s.label}</p>
            <p className={cn('text-2xl font-bold font-mono', s.color ?? 'text-gray-100')}>{s.value}</p>
            <p className="text-xs text-gray-600">{s.sub}</p>
          </div>
        ))}
      </div>

      {/* Open trade form */}
      {showForm && (
        <form onSubmit={openTrade} className="bg-gray-900 border border-emerald-500/30 rounded-xl p-6 mb-6">
          <h2 className="text-sm font-semibold text-emerald-400 mb-4">Nova operação</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <label className="flex flex-col gap-1 text-xs text-gray-400">
              Ativo
              <select value={form.asset} onChange={e => setForm(f => ({ ...f, asset: e.target.value as Asset }))}
                className="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm text-gray-100">
                {ASSETS.map(a => <option key={a}>{a}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-gray-400">
              Direção
              <select value={form.direction} onChange={e => setForm(f => ({ ...f, direction: e.target.value as Direction }))}
                className="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm text-gray-100">
                <option value="long">LONG</option>
                <option value="short">SHORT</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-gray-400">
              Grade
              <select value={form.setup_grade} onChange={e => setForm(f => ({ ...f, setup_grade: e.target.value as SetupGrade }))}
                className="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm text-gray-100">
                {GRADES.map(g => <option key={g}>{g}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-gray-400">
              Alavancagem
              <input type="number" value={form.leverage} onChange={e => setForm(f => ({ ...f, leverage: +e.target.value }))}
                className="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm text-gray-100" min={1} />
            </label>
            {[
              { key: 'entry_price', label: 'Entrada' },
              { key: 'stop_price',  label: 'Stop' },
              { key: 'target1',     label: 'Alvo 1' },
              { key: 'target2',     label: 'Alvo 2' },
              { key: 'target3',     label: 'Alvo 3' },
              { key: 'size',        label: 'Tamanho (USD)' },
            ].map(({ key, label }) => (
              <label key={key} className="flex flex-col gap-1 text-xs text-gray-400">
                {label}
                <input type="number" step="any" value={(form as any)[key]}
                  onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
                  className="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm text-gray-100" />
              </label>
            ))}
            <label className="flex flex-col gap-1 text-xs text-gray-400 col-span-2">
              Notas
              <input type="text" value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                className="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm text-gray-100" />
            </label>
          </div>
          <div className="flex gap-3 mt-4">
            <button type="submit" disabled={loading}
              className="bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-black font-semibold px-4 py-2 rounded-lg text-sm">
              Confirmar abertura
            </button>
            <button type="button" onClick={() => setShowForm(false)}
              className="text-gray-400 hover:text-gray-100 text-sm px-4 py-2">
              Cancelar
            </button>
          </div>
        </form>
      )}

      {/* Tabs */}
      <div className="flex gap-4 border-b border-gray-800 mb-4">
        {(['open', 'closed'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={cn('pb-2 text-sm font-medium border-b-2 transition-colors',
              tab === t ? 'border-emerald-400 text-emerald-400' : 'border-transparent text-gray-500 hover:text-gray-300'
            )}>
            {t === 'open' ? `Abertos (${open.length})` : `Fechados (${closed.length})`}
          </button>
        ))}
      </div>

      {/* Trades table */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800 text-gray-500 text-xs uppercase tracking-wide">
              {tab === 'open'
                ? ['Ativo','Dir','Grade','Entrada','Stop','Alvo 1','Alv','Ações'].map(h => (
                    <th key={h} className="text-left px-4 py-3">{h}</th>
                  ))
                : ['Ativo','Dir','Grade','Entrada','Fechamento','P&L %','P&L USD','Ações'].map(h => (
                    <th key={h} className="text-left px-4 py-3">{h}</th>
                  ))
              }
            </tr>
          </thead>
          <tbody>
            {(tab === 'open' ? open : closed).map(t => (
              <tr key={t.id} className="border-b border-gray-800/50 hover:bg-gray-800/30">
                <td className="px-4 py-3 font-semibold">{t.asset}</td>
                <td className="px-4 py-3">
                  <span className={t.direction === 'long' ? 'text-emerald-400' : 'text-red-400'}>
                    {t.direction.toUpperCase()}
                  </span>
                </td>
                <td className="px-4 py-3">
                  {t.setup_grade && <span className={cn('text-xs px-1.5 py-0.5 rounded font-bold', gradeColor(t.setup_grade))}>{t.setup_grade}</span>}
                </td>
                <td className="px-4 py-3 font-mono">${fmtPrice(t.entry_price)}</td>
                {tab === 'open' ? <>
                  <td className="px-4 py-3 font-mono text-red-400">${fmtPrice(t.stop_price)}</td>
                  <td className="px-4 py-3 font-mono text-emerald-400">${fmtPrice(t.target1 ?? 0)}</td>
                  <td className="px-4 py-3 text-gray-400">{t.leverage}x</td>
                  <td className="px-4 py-3">
                    <button onClick={() => setClosing({ id: t.id, price: '' })}
                      className="text-xs bg-red-500/20 text-red-400 hover:bg-red-500/30 px-2 py-1 rounded transition-colors">
                      Fechar
                    </button>
                  </td>
                </> : <>
                  <td className="px-4 py-3 font-mono">${fmtPrice(t.close_price ?? 0)}</td>
                  <td className={cn('px-4 py-3 font-mono font-semibold', pnlColor(t.pnl_pct ?? 0))}>{fmtPct(t.pnl_pct ?? 0)}</td>
                  <td className={cn('px-4 py-3 font-mono', pnlColor(t.pnl_usd ?? 0))}>{t.pnl_usd != null ? `$${fmtPrice(t.pnl_usd)}` : '—'}</td>
                  <td className="px-4 py-3">
                    <a href={`/review?trade=${t.id}`} className="text-xs text-emerald-400 hover:underline">Review</a>
                  </td>
                </>}
              </tr>
            ))}
            {(tab === 'open' ? open : closed).length === 0 && (
              <tr><td colSpan={8} className="px-4 py-8 text-center text-gray-600 text-sm">Nenhum trade {tab === 'open' ? 'aberto' : 'fechado'}</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Close modal */}
      {closing && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 w-80">
            <h3 className="font-semibold mb-4">Fechar trade</h3>
            <label className="text-xs text-gray-400 flex flex-col gap-1 mb-4">
              Preço de fechamento
              <input type="number" step="any" value={closing.price}
                onChange={e => setClosing(c => c ? { ...c, price: e.target.value } : null)}
                className="bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100 mt-1" autoFocus />
            </label>
            <div className="flex gap-3">
              <button onClick={closeTrade} disabled={!closing.price || loading}
                className="flex-1 bg-red-500 hover:bg-red-400 disabled:opacity-50 text-white font-semibold py-2 rounded-lg text-sm">
                Confirmar
              </button>
              <button onClick={() => setClosing(null)} className="flex-1 bg-gray-800 hover:bg-gray-700 text-gray-300 py-2 rounded-lg text-sm">
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
