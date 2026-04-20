import { supabaseAdmin } from '@/lib/supabase'
import { AssetCard } from '@/components/dashboard/AssetCard'
import { LiveScores } from '@/components/dashboard/LiveScores'
import { computeThreshold } from '@/lib/threshold'
import { Asset } from '@/types'

const ASSETS: Asset[] = ['BTC', 'ETH', 'SOL', 'GOLD', 'OIL']

export const revalidate = 300

function cn(...classes: (string | false | undefined)[]) {
  return classes.filter(Boolean).join(' ')
}

function gradeColor(grade: string) {
  const m: Record<string, string> = {
    'A+': 'bg-emerald-500 text-white', 'A': 'bg-green-500 text-white',
    'B': 'bg-yellow-500 text-black',   'C': 'bg-orange-500 text-white',
  }
  return m[grade] ?? 'bg-gray-600 text-white'
}

async function getData() {
  const db = supabaseAdmin()
  const [{ data: snaps }, { data: trades }, { data: signals }, { data: macro }, { data: perf }] =
    await Promise.all([
      db.from('snapshots').select('*').order('captured_at', { ascending: false }).limit(400),
      db.from('trades').select('*').eq('status', 'open'),
      db.from('signals').select('*').eq('status', 'active').order('detected_at', { ascending: false }).limit(10),
      db.from('macro_readings').select('*').order('captured_at', { ascending: false }).limit(1),
      db.from('performance_summary').select('*'),
    ])
  return {
    snaps:   snaps   ?? [],
    trades:  trades  ?? [],
    signals: signals ?? [],
    macro:   macro?.[0] ?? null,
    perf:    perf    ?? [],
  }
}

export default async function DashboardPage() {
  const { snaps, trades, signals, macro, perf } = await getData()

  const seen = new Set<string>()
  const latest = snaps.filter(s => {
    const k = `${s.asset}-${s.timeframe}`
    if (seen.has(k)) return false
    seen.add(k); return true
  })

  const byAsset    = Object.fromEntries(ASSETS.map(a => [a, latest.filter(s => s.asset === a)]))
  const latestSignal = (a: Asset) => signals.find(s => s.asset === a)

  // Thresholds dinâmicos calculados no servidor
  const perfMap    = Object.fromEntries((perf as any[]).map((p: any) => [p.asset, p]))
  const thresholds = Object.fromEntries(ASSETS.map(a => [a, computeThreshold(perfMap[a])]))

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Dashboard</h1>
          <p className="text-sm text-gray-500 mt-0.5">Swing Trade Desk · Scanner 4h</p>
        </div>
        <div className="flex items-center gap-3">
          {macro && (
            <div className="bg-gray-900 border border-gray-800 rounded-lg px-4 py-2 text-sm">
              <span className="text-gray-500">Regime: </span>
              <span className={cn('font-semibold',
                macro.regime === 'risk-on' ? 'text-emerald-400' :
                macro.regime === 'risk-off' ? 'text-red-400' : 'text-yellow-400'
              )}>{(macro.regime as string).toUpperCase()}</span>
              <span className="text-gray-500 ml-3">Macro: </span>
              <span className={cn('font-bold',
                macro.macro_score >= 1 ? 'text-emerald-400' :
                macro.macro_score <= -1 ? 'text-red-400' : 'text-yellow-400'
              )}>{macro.macro_score >= 0 ? '+' : ''}{macro.macro_score}</span>
            </div>
          )}
          {trades.length > 0 && (
            <div className="bg-gray-900 border border-gray-800 rounded-lg px-4 py-2 text-sm">
              <span className="text-gray-500">Abertos: </span>
              <span className="font-semibold">{trades.length}</span>
            </div>
          )}
        </div>
      </div>

      {/* Active signals banner */}
      {signals.length > 0 && (
        <div className="mb-6">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Sinais ativos</p>
          <div className="flex flex-wrap gap-2">
            {signals.map(s => (
              <div key={s.id} className="bg-gray-900 border border-emerald-500/30 rounded-lg px-3 py-2 text-sm flex items-center gap-2">
                <span className={s.direction === 'long' ? 'text-emerald-400' : 'text-red-400'}>
                  {s.direction === 'long' ? '▲' : '▼'}
                </span>
                <span className="font-semibold">{s.asset}</span>
                <span className={cn('text-xs px-1.5 py-0.5 rounded font-bold', gradeColor(s.setup_grade))}>
                  {s.setup_grade}
                </span>
                <span className="text-gray-500 text-xs">RR {s.rr1}:1</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Score ao vivo — componente cliente com auto-refresh */}
      <LiveScores />

      {/* Threshold dinâmico por ativo */}
      <div className="mb-6">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
          Exigência do scanner (ajuste automático por win rate)
        </p>
        <div className="grid grid-cols-5 gap-2">
          {ASSETS.map(asset => {
            const thr = thresholds[asset]
            const color =
              thr.status === 'ok'      ? 'border-emerald-500/30 bg-emerald-500/5  text-emerald-400' :
              thr.status === 'warning' ? 'border-yellow-500/30  bg-yellow-500/5   text-yellow-400'  :
              thr.status === 'danger'  ? 'border-red-500/30     bg-red-500/5      text-red-400'     :
              thr.status === 'blocked' ? 'border-red-700/40     bg-red-900/10     text-red-500'     :
                                         'border-gray-700       bg-gray-900       text-gray-400'
            return (
              <div key={asset} className={cn('rounded-lg border p-2.5 text-center', color)}>
                <p className="text-xs font-bold">{asset}</p>
                <p className="text-xl font-mono font-bold mt-0.5">{thr.threshold}<span className="text-xs font-normal opacity-60"> pts</span></p>
                <p className="text-xs opacity-60 mt-0.5 leading-tight">{thr.reason}</p>
              </div>
            )
          })}
        </div>
      </div>

      {/* Asset cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {ASSETS.map(asset => (
          <AssetCard
            key={asset}
            asset={asset}
            snapshots={byAsset[asset] ?? []}
            setupGrade={latestSignal(asset)?.setup_grade}
            macroScore={macro?.macro_score}
          />
        ))}
      </div>

      {/* Open trades table */}
      {trades.length > 0 && (
        <div className="mt-8">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Trades abertos</p>
          <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800 text-gray-500 text-xs uppercase tracking-wide">
                  {['Ativo','Direção','Entrada','Stop','Alvo 1','Alavancagem','Grade'].map(h => (
                    <th key={h} className="text-left px-4 py-3">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {trades.map((t: any) => (
                  <tr key={t.id} className="border-b border-gray-800/50 hover:bg-gray-800/30">
                    <td className="px-4 py-3 font-semibold">{t.asset}</td>
                    <td className="px-4 py-3">
                      <span className={t.direction === 'long' ? 'text-emerald-400' : 'text-red-400'}>
                        {(t.direction as string).toUpperCase()}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono">${t.entry_price?.toLocaleString()}</td>
                    <td className="px-4 py-3 font-mono text-red-400">${t.stop_price?.toLocaleString()}</td>
                    <td className="px-4 py-3 font-mono text-emerald-400">${t.target1?.toLocaleString() ?? '—'}</td>
                    <td className="px-4 py-3 text-gray-400">{t.leverage}x</td>
                    <td className="px-4 py-3">
                      {t.setup_grade && <span className={cn('text-xs px-1.5 py-0.5 rounded font-bold', gradeColor(t.setup_grade))}>{t.setup_grade}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
