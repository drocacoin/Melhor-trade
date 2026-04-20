'use client'
import { useState, useEffect } from 'react'
import { cn } from '@/lib/utils'

const MACRO_EVENTS = [
  { label: 'CPI',           impact: 'alto',  asset: 'BTC, GOLD, OIL' },
  { label: 'FOMC / Juros',  impact: 'alto',  asset: 'Todos' },
  { label: 'Payroll (NFP)', impact: 'alto',  asset: 'BTC, GOLD' },
  { label: 'Estoques EIA',  impact: 'medio', asset: 'OIL' },
  { label: 'Reunião OPEC',  impact: 'alto',  asset: 'OIL' },
  { label: 'PPI',           impact: 'medio', asset: 'GOLD, BTC' },
  { label: 'PIB (GDP)',     impact: 'medio', asset: 'Todos' },
  { label: 'Fala do FED',   impact: 'alto',  asset: 'Todos' },
]

const ASSET_MACRO = [
  { asset: 'BTC / ETH / SOL', drivers: ['Liquidez global','DXY','Yields','Nasdaq','ETF flows','Funding rates'], bullish: 'Dovish FED + DXY fraco + Yields caindo', bearish: 'Hawkish FED + DXY forte + Yields subindo' },
  { asset: 'Ouro (GOLD)',      drivers: ['Juros reais','DXY','Risco geopolítico','Busca por proteção'],          bullish: 'Juros reais negativos + Aversão a risco + Inflação persistente', bearish: 'Yields altos + DXY forte + Risk-on' },
  { asset: 'Petróleo (OIL)',   drivers: ['OPEC+','Estoques EIA','Crescimento global','Geopolítica'],             bullish: 'Oferta apertada + Demanda forte + Tensão geopolítica', bearish: 'Recessão + Demanda fraca + OPEC aumenta oferta' },
]

const SOURCE_LINKS = [
  { label: 'CME FedWatch',    url: 'https://www.cmegroup.com/markets/interest-rates/cme-fedwatch-tool.html', level: 1 },
  { label: 'FRED (Fed Data)', url: 'https://fred.stlouisfed.org',                                             level: 1 },
  { label: 'EIA Oil Data',    url: 'https://www.eia.gov',                                                      level: 1 },
  { label: 'CFTC COT Report', url: 'https://www.cftc.gov/MarketReports/CommitmentsofTraders',                 level: 1 },
  { label: 'Glassnode',       url: 'https://glassnode.com',                                                    level: 2 },
  { label: 'CryptoQuant',     url: 'https://cryptoquant.com',                                                  level: 2 },
  { label: 'Kobeissi Letter', url: 'https://kobeissiletter.com',                                               level: 2 },
]

const CHECKLIST = [
  'Regime: risk-on, risk-off ou neutro?',
  'Liquidez global aumentando ou caindo?',
  'Juros: expectativa de corte, manutenção ou alta?',
  'FED: hawkish ou dovish?',
  'DXY: forte, fraco ou lateral?',
  'Yields: subindo ou caindo?',
  'Específico do ativo (funding, OPEC, COT)',
  'Evento de alto impacto próximo?',
  'Macro confirma ou contradiz o gráfico?',
]

const emptyForm = {
  regime: 'neutro' as 'risk-on' | 'risk-off' | 'neutro' | 'transicao',
  macro_score: 0,
  dxy_trend: 'lateral',
  yields_trend: 'lateral',
  fed_stance: 'neutro',
  notes: '',
}

function regimeColor(r: string) {
  if (r === 'risk-on')   return 'text-emerald-400'
  if (r === 'risk-off')  return 'text-red-400'
  if (r === 'transicao') return 'text-orange-400'
  return 'text-yellow-400'
}

function scoreColor(s: number) {
  if (s >= 1)  return 'text-emerald-400'
  if (s <= -1) return 'text-red-400'
  return 'text-yellow-400'
}

export default function MacroPage() {
  const [readings, setReadings] = useState<any[]>([])
  const [form, setForm]         = useState(emptyForm)
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving]     = useState(false)
  const [saved, setSaved]       = useState(false)

  async function load() {
    const data = await fetch('/api/macro').then(r => r.json())
    setReadings(data ?? [])
  }

  useEffect(() => { load() }, [])

  const latest = readings[0] ?? null

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    await fetch('/api/macro', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    })
    setSaved(true); setSaving(false); setShowForm(false); setForm(emptyForm)
    await load()
    setTimeout(() => setSaved(false), 3000)
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Painel Macro</h1>
          <p className="text-sm text-gray-500 mt-0.5">Contexto macroeconômico por ativo</p>
        </div>
        <button onClick={() => setShowForm(!showForm)}
          className="bg-emerald-500 hover:bg-emerald-400 text-black font-semibold px-4 py-2 rounded-lg text-sm transition-colors">
          {showForm ? 'Cancelar' : '+ Nova leitura macro'}
        </button>
      </div>

      {saved && (
        <div className="mb-4 bg-emerald-500/20 border border-emerald-500/30 text-emerald-400 text-sm px-4 py-2 rounded-lg">
          ✓ Leitura macro salva com sucesso!
        </div>
      )}

      {/* Form */}
      {showForm && (
        <form onSubmit={submit} className="bg-gray-900 border border-emerald-500/30 rounded-xl p-6 mb-6">
          <h2 className="text-sm font-semibold text-emerald-400 mb-5">Nova leitura macro</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
            <label className="flex flex-col gap-1 text-xs text-gray-400">
              Regime de mercado
              <select value={form.regime} onChange={e => setForm(f => ({ ...f, regime: e.target.value as any }))}
                className="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm text-gray-100">
                <option value="risk-on">Risk-On 🟢</option>
                <option value="risk-off">Risk-Off 🔴</option>
                <option value="neutro">Neutro 🟡</option>
                <option value="transicao">Transição 🟠</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-gray-400">
              DXY (Dólar)
              <select value={form.dxy_trend} onChange={e => setForm(f => ({ ...f, dxy_trend: e.target.value }))}
                className="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm text-gray-100">
                <option value="forte">Forte ▲</option>
                <option value="lateral">Lateral —</option>
                <option value="fraco">Fraco ▼</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-gray-400">
              Yields (Juros US)
              <select value={form.yields_trend} onChange={e => setForm(f => ({ ...f, yields_trend: e.target.value }))}
                className="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm text-gray-100">
                <option value="subindo">Subindo ▲</option>
                <option value="lateral">Lateral —</option>
                <option value="caindo">Caindo ▼</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-gray-400">
              Postura do FED
              <select value={form.fed_stance} onChange={e => setForm(f => ({ ...f, fed_stance: e.target.value }))}
                className="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm text-gray-100">
                <option value="dovish">Dovish (expansivo)</option>
                <option value="neutro">Neutro</option>
                <option value="hawkish">Hawkish (restritivo)</option>
              </select>
            </label>
          </div>

          <div className="mb-4">
            <label className="text-xs text-gray-400">
              Pontuação macro
              <div className="flex items-center gap-4 mt-2">
                {[-2, -1, 0, 1, 2].map(v => (
                  <button key={v} type="button"
                    onClick={() => setForm(f => ({ ...f, macro_score: v }))}
                    className={cn(
                      'w-10 h-10 rounded-lg font-bold font-mono text-sm border transition-colors',
                      form.macro_score === v
                        ? v >= 1 ? 'bg-emerald-500 border-emerald-500 text-black'
                          : v <= -1 ? 'bg-red-500 border-red-500 text-white'
                          : 'bg-yellow-500 border-yellow-500 text-black'
                        : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-500'
                    )}>
                    {v >= 0 ? `+${v}` : v}
                  </button>
                ))}
                <span className="text-xs text-gray-500">(-2 bearish extremo → +2 bullish extremo)</span>
              </div>
            </label>
          </div>

          <label className="flex flex-col gap-1 text-xs text-gray-400 mb-4">
            Análise / contexto atual
            <textarea value={form.notes} rows={3}
              onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
              placeholder="Ex: FED sinalizou pausa nos cortes. DXY testando resistência 104. Yields 10Y em 4.5%..."
              className="bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100 resize-none" />
          </label>

          {/* Preview */}
          <div className="bg-gray-800 rounded-lg p-3 mb-4 flex flex-wrap items-center gap-6 text-sm">
            <div><span className="text-xs text-gray-500">Regime: </span>
              <span className={cn('font-semibold', regimeColor(form.regime))}>{form.regime.toUpperCase()}</span></div>
            <div><span className="text-xs text-gray-500">Score: </span>
              <span className={cn('font-bold font-mono', scoreColor(form.macro_score))}>{form.macro_score >= 0 ? '+' : ''}{form.macro_score}</span></div>
            <div><span className="text-xs text-gray-500">DXY: </span><span className="text-gray-200">{form.dxy_trend}</span></div>
            <div><span className="text-xs text-gray-500">Yields: </span><span className="text-gray-200">{form.yields_trend}</span></div>
            <div><span className="text-xs text-gray-500">FED: </span><span className="text-gray-200">{form.fed_stance}</span></div>
          </div>

          <button type="submit" disabled={saving}
            className="bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-black font-semibold px-6 py-2 rounded-lg text-sm">
            {saving ? 'Salvando...' : 'Salvar leitura macro'}
          </button>
        </form>
      )}

      {/* Current regime */}
      {latest ? (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-6">
          <div className="flex items-center justify-between flex-wrap gap-4">
            <div>
              <p className="text-xs text-gray-500 mb-1">Regime atual</p>
              <p className={cn('text-2xl font-bold', regimeColor(latest.regime))}>{latest.regime.toUpperCase()}</p>
              <p className="text-xs text-gray-600 mt-1">{new Date(latest.captured_at).toLocaleString('pt-BR')}</p>
            </div>
            <div className="text-center">
              <p className="text-xs text-gray-500 mb-1">Pontuação macro</p>
              <p className={cn('text-4xl font-bold font-mono', scoreColor(latest.macro_score))}>
                {latest.macro_score >= 0 ? '+' : ''}{latest.macro_score}
              </p>
              <p className="text-xs text-gray-600">(-2 a +2)</p>
            </div>
            <div className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm">
              <div><span className="text-gray-500">DXY: </span><span className="text-gray-200">{latest.dxy_trend}</span></div>
              <div><span className="text-gray-500">Yields: </span><span className="text-gray-200">{latest.yields_trend}</span></div>
              <div><span className="text-gray-500">FED: </span><span className="text-gray-200">{latest.fed_stance}</span></div>
            </div>
          </div>
          {latest.notes && <p className="text-sm text-gray-400 mt-3 border-t border-gray-800 pt-3">{latest.notes}</p>}
        </div>
      ) : (
        <div className="bg-gray-900 border border-dashed border-gray-700 rounded-xl p-8 mb-6 text-center">
          <p className="text-gray-500 text-sm">Nenhuma leitura macro ainda.</p>
          <p className="text-gray-600 text-xs mt-1">Clique em "Nova leitura macro" para registrar o contexto atual.</p>
        </div>
      )}

      {/* History */}
      {readings.length > 1 && (
        <div className="mb-6">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Histórico</p>
          <div className="space-y-2">
            {readings.slice(1).map((r: any) => (
              <div key={r.id} className="bg-gray-900 border border-gray-800 rounded-lg px-4 py-3 flex items-center justify-between text-sm opacity-70">
                <div className="flex items-center gap-4">
                  <span className={cn('font-semibold', regimeColor(r.regime))}>{r.regime.toUpperCase()}</span>
                  <span className={cn('font-mono font-bold', scoreColor(r.macro_score))}>{r.macro_score >= 0 ? '+' : ''}{r.macro_score}</span>
                  <span className="text-gray-500 text-xs">DXY: {r.dxy_trend} · Yields: {r.yields_trend} · FED: {r.fed_stance}</span>
                </div>
                <span className="text-xs text-gray-600">{new Date(r.captured_at).toLocaleDateString('pt-BR')}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Asset macro */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        {ASSET_MACRO.map(a => (
          <div key={a.asset} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <p className="font-semibold text-gray-100 mb-3 text-sm">{a.asset}</p>
            <div className="flex flex-wrap gap-1 mb-3">
              {a.drivers.map(d => <span key={d} className="text-xs bg-gray-800 text-gray-400 px-2 py-0.5 rounded">{d}</span>)}
            </div>
            <div className="text-xs space-y-1">
              <p className="text-emerald-400">▲ {a.bullish}</p>
              <p className="text-red-400">▼ {a.bearish}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Events + Sources */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <p className="text-sm font-semibold text-gray-400 mb-3">Eventos de impacto</p>
          <div className="space-y-2">
            {MACRO_EVENTS.map(e => (
              <div key={e.label} className="flex items-center justify-between text-sm">
                <span className="text-gray-300">{e.label}</span>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-500">{e.asset}</span>
                  <span className={cn('text-xs px-2 py-0.5 rounded font-medium',
                    e.impact === 'alto' ? 'bg-red-500/20 text-red-400' : 'bg-yellow-500/20 text-yellow-400'
                  )}>{e.impact}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <p className="text-sm font-semibold text-gray-400 mb-3">Fontes prioritárias</p>
          <div className="space-y-2">
            {SOURCE_LINKS.map(s => (
              <div key={s.label} className="flex items-center justify-between text-sm">
                <a href={s.url} target="_blank" rel="noopener noreferrer" className="text-emerald-400 hover:underline">{s.label}</a>
                <span className={cn('text-xs px-2 py-0.5 rounded',
                  s.level === 1 ? 'bg-emerald-500/20 text-emerald-400' : 'bg-blue-500/20 text-blue-400'
                )}>Nível {s.level}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Checklist */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <p className="text-sm font-semibold text-gray-400 mb-4">Checklist macro pré-trade (9 pontos)</p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {CHECKLIST.map((item, i) => (
            <div key={i} className="flex items-start gap-2 text-xs text-gray-400">
              <span className="text-emerald-500 font-bold shrink-0">{i + 1}.</span>
              <span>{item}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
