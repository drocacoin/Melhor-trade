'use client'
import { useState, useEffect, useCallback } from 'react'
import { Trade, Asset, Direction, SetupGrade } from '@/types'
import { fmtPrice, fmtPct, cn, gradeColor, pnlColor } from '@/lib/utils'

const ASSETS: Asset[]      = ['BTC', 'ETH', 'SOL', 'GOLD', 'OIL']
const GRADES: SetupGrade[] = ['A+', 'A', 'B', 'C']

const empty = {
  asset: 'BTC' as Asset, direction: 'long' as Direction,
  leverage: 1, entry_price: '', stop_price: '', target1: '',
  target2: '', target3: '', size: '', setup_grade: 'A' as SetupGrade, notes: '',
}

function calcUnrealized(trade: Trade, livePrice: number) {
  const pnl_pct = trade.direction === 'long'
    ? ((livePrice - trade.entry_price) / trade.entry_price) * 100 * (trade.leverage ?? 1)
    : ((trade.entry_price - livePrice) / trade.entry_price) * 100 * (trade.leverage ?? 1)
  const pnl_usd = trade.size ? (pnl_pct / 100) * trade.size : null
  const stop_dist_pct = trade.stop_price
    ? Math.abs(livePrice - trade.stop_price) / trade.entry_price * 100
    : null
  return { pnl_pct, pnl_usd, stop_dist_pct }
}

export default function TradesPage() {
  const [trades, setTrades]       = useState<Trade[]>([])
  const [prices, setPrices]       = useState<Record<string, number>>({})
  const [form, setForm]           = useState(empty)
  const [closing, setClosing]     = useState<{ id: number; price: string } | null>(null)
  const [showForm, setShowForm]   = useState(false)
  const [loading, setLoading]     = useState(false)
  const [tab, setTab]             = useState<'open' | 'closed'>('open')
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null)

  const load = useCallback(async () => {
    const res  = await fetch('/api/trades')
    const data = await res.json()
    setTrades(data)
  }, [])

  const loadPrices = useCallback(async () => {
    try {
      const res  = await fetch('/api/prices')
      const data = await res.json()
      setPrices(data)
      setLastUpdate(new Date())
    } catch {}
  }, [])

  useEffect(() => {
    load()
    loadPrices()
    const interval = setInterval(loadPrices, 30000) // atualiza a cada 30s
    return () => clearInterval(interval)
  }, [load, loadPrices])

  async function openTrade(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    await fetch('/api/trades', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...form,
        entry_price: +form.entry_price, stop_price: +form.stop_price,
        target1: +form.target1 || null, target2: +form.target2 || null,
        target3: +form.target3 || null, size: +form.size || null,
      }),
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

  const open        = trades.filter(t => t.status === 'open')
  const closed      = trades.filter(t => t.status === 'closed')
  const totalPnl    = closed.reduce((s, t) => s + (t.pnl_usd ?? 0), 0)
  const winrate     = closed.length ? (closed.filter(t => (t.pnl_usd ?? 0) > 0).length / closed.length) * 100 : null

  // P&L não realizado total dos trades abertos
  const unrealizedTotal = open.reduce((sum, t) => {
    const price = prices[t.asset]
    if (!price) return sum
    const { pnl_usd } = calcUnrealized(t, price)
    return sum + (pnl_usd ?? 0)
  }, 0)

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Trades</h1>
          <p className="text-sm text-gray-500">Gestão de posições e P&L</p>
        </div>
        <div className="flex items-center gap-3">
          {lastUpdate && (
            <span className="text-xs text-gray-600">
              Preços: {lastUpdate.toLocaleTimeString('pt-BR')}
            </span>
          )}
          <button onClick={() => setShowForm(!showForm)}
            className="bg-emerald-500 hover:bg-emerald-400 text-black font-semibold px-4 py-2 rounded-lg text-sm transition-colors">
            + Abrir Trade
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
        {[
          { label: 'Abertos',        value: open.length,             sub: 'posições',  color: undefined },
          { label: 'P&L Aberto',     value: open.length ? `${unrealizedTotal >= 0 ? '+' : ''}$${fmtPrice(unrealizedTotal)}` : '—',
                                                                      sub: 'não realizado', color: open.length ? pnlColor(unrealizedTotal) : undefined },
          { label: 'Fechados',       value: closed.length,           sub: 'trades',    color: undefined },
          { label: 'Winrate',        value: winrate != null ? `${winrate.toFixed(0)}%` : '—',
                                                                      sub: 'acertos',   color: winrate != null ? (winrate >= 50 ? 'text-emerald-400' : 'text-red-400') : undefined },
          { label: 'P&L Realizado',  value: `$${fmtPrice(totalPnl)}`, sub: 'USD',      color: pnlColor(totalPnl) },
        ].map(s => (
          <div key={s.label} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <p className="text-xs text-gray-500 mb-1">{s.label}</p>
            <p className={cn('text-xl font-bold font-mono', s.color ?? 'text-gray-100')}>{s.value}</p>
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
                <option value="long">LONG ▲</option>
                <option value="short">SHORT ▼</option>
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
              { key: 'entry_price', label: 'Entrada ($)' },
              { key: 'stop_price',  label: 'Stop ($)' },
              { key: 'target1',     label: 'Alvo 1 ($)' },
              { key: 'target2',     label: 'Alvo 2 ($)' },
              { key: 'target3',     label: 'Alvo 3 ($)' },
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

      {/* Open trades */}
      {tab === 'open' && (
        <div className="space-y-3">
          {open.length === 0 && (
            <div className="bg-gray-900 border border-dashed border-gray-700 rounded-xl p-8 text-center text-gray-600 text-sm">
              Nenhum trade aberto
            </div>
          )}
          {open.map(t => {
            const livePrice = prices[t.asset]
            const unreal    = livePrice ? calcUnrealized(t, livePrice) : null
            const isLong    = t.direction === 'long'
            const atRisk    = livePrice && t.stop_price
              ? (isLong ? livePrice <= t.stop_price : livePrice >= t.stop_price)
              : false

            return (
              <div key={t.id} className={cn(
                'bg-gray-900 border rounded-xl p-5',
                atRisk ? 'border-red-500/50' : 'border-gray-800'
              )}>
                {/* Top row */}
                <div className="flex items-start justify-between mb-4">
                  <div className="flex items-center gap-3">
                    <span className={cn('text-xl font-bold', isLong ? 'text-emerald-400' : 'text-red-400')}>
                      {isLong ? '▲' : '▼'}
                    </span>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-lg">{t.asset}</span>
                        {t.setup_grade && (
                          <span className={cn('text-xs px-2 py-0.5 rounded font-bold', gradeColor(t.setup_grade))}>
                            {t.setup_grade}
                          </span>
                        )}
                        <span className="text-xs text-gray-500">{t.leverage}x</span>
                      </div>
                      <p className="text-xs text-gray-500 mt-0.5">
                        Entrada: <span className="text-gray-300 font-mono">${fmtPrice(t.entry_price)}</span>
                        {livePrice && (
                          <span className="ml-2">
                            Atual: <span className="text-gray-100 font-mono font-semibold">${fmtPrice(livePrice)}</span>
                          </span>
                        )}
                      </p>
                    </div>
                  </div>

                  {/* Live P&L */}
                  {unreal ? (
                    <div className="text-right">
                      <p className={cn('text-2xl font-bold font-mono', pnlColor(unreal.pnl_pct))}>
                        {unreal.pnl_pct >= 0 ? '+' : ''}{unreal.pnl_pct.toFixed(2)}%
                      </p>
                      {unreal.pnl_usd != null && (
                        <p className={cn('text-sm font-mono', pnlColor(unreal.pnl_usd))}>
                          {unreal.pnl_usd >= 0 ? '+' : ''}${fmtPrice(unreal.pnl_usd)}
                        </p>
                      )}
                      <p className="text-xs text-gray-600 mt-0.5">P&L não realizado</p>
                    </div>
                  ) : (
                    <div className="text-right">
                      <p className="text-gray-600 text-sm">carregando...</p>
                    </div>
                  )}
                </div>

                {/* Levels */}
                <div className="grid grid-cols-3 md:grid-cols-5 gap-2 mb-4">
                  {[
                    { label: 'Stop',   value: t.stop_price,  color: 'text-red-400' },
                    { label: 'Alvo 1', value: t.target1,     color: 'text-emerald-400' },
                    { label: 'Alvo 2', value: t.target2,     color: 'text-emerald-300' },
                    { label: 'Alvo 3', value: t.target3,     color: 'text-emerald-200' },
                    { label: 'Dist. Stop', value: unreal?.stop_dist_pct != null
                        ? `${unreal.stop_dist_pct.toFixed(2)}%` : null, color: 'text-yellow-400' },
                  ].filter(x => x.value != null).map(item => (
                    <div key={item.label} className="bg-gray-800 rounded-lg p-2 text-center">
                      <p className="text-xs text-gray-500 mb-0.5">{item.label}</p>
                      <p className={cn('text-xs font-mono font-semibold', item.color)}>
                        {typeof item.value === 'number' ? `$${fmtPrice(item.value)}` : item.value}
                      </p>
                    </div>
                  ))}
                </div>

                {/* Notes + actions */}
                <div className="flex items-center justify-between">
                  <div>
                    {atRisk && (
                      <span className="text-xs bg-red-500/20 text-red-400 px-2 py-0.5 rounded font-medium mr-2">
                        ⚠ PRÓXIMO DO STOP
                      </span>
                    )}
                    {t.notes && <span className="text-xs text-gray-500">{t.notes}</span>}
                  </div>
                  <button
                    onClick={() => setClosing({ id: t.id, price: livePrice ? livePrice.toString() : '' })}
                    className="text-xs bg-red-500/20 text-red-400 hover:bg-red-500/30 px-3 py-1.5 rounded transition-colors font-medium">
                    Fechar posição
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Closed trades table */}
      {tab === 'closed' && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-gray-500 text-xs uppercase tracking-wide">
                {['Ativo','Dir','Grade','Entrada','Fechamento','P&L %','P&L USD','Ações'].map(h => (
                  <th key={h} className="text-left px-4 py-3">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {closed.map(t => (
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
                  <td className="px-4 py-3 font-mono">${fmtPrice(t.close_price ?? 0)}</td>
                  <td className={cn('px-4 py-3 font-mono font-semibold', pnlColor(t.pnl_pct ?? 0))}>
                    {t.pnl_pct != null ? `${t.pnl_pct >= 0 ? '+' : ''}${fmtPct(t.pnl_pct)}` : '—'}
                  </td>
                  <td className={cn('px-4 py-3 font-mono', pnlColor(t.pnl_usd ?? 0))}>
                    {t.pnl_usd != null ? `${t.pnl_usd >= 0 ? '+' : ''}$${fmtPrice(t.pnl_usd)}` : '—'}
                  </td>
                  <td className="px-4 py-3">
                    <a href={`/review?trade=${t.id}`} className="text-xs text-emerald-400 hover:underline">Review</a>
                  </td>
                </tr>
              ))}
              {closed.length === 0 && (
                <tr><td colSpan={8} className="px-4 py-8 text-center text-gray-600 text-sm">Nenhum trade fechado ainda</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Close modal */}
      {closing && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 w-80">
            <h3 className="font-semibold mb-1">Fechar posição</h3>
            {prices[open.find(t => t.id === closing.id)?.asset ?? ''] && (
              <p className="text-xs text-gray-500 mb-4">
                Preço atual: <span className="text-gray-300 font-mono">
                  ${fmtPrice(prices[open.find(t => t.id === closing.id)?.asset ?? ''])}
                </span>
              </p>
            )}
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
              <button onClick={() => setClosing(null)}
                className="flex-1 bg-gray-800 hover:bg-gray-700 text-gray-300 py-2 rounded-lg text-sm">
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
