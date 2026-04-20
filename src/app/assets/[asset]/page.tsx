import { notFound } from 'next/navigation'
import Link from 'next/link'
import { supabaseAdmin } from '@/lib/supabase'
import { Asset, ASSET_LABELS, ASSET_COLORS } from '@/types'
import { cn, fmtPrice, fmtPct, gradeColor, biasColor, pnlColor } from '@/lib/utils'

export const revalidate = 120

const VALID_ASSETS: Asset[] = ['BTC', 'ETH', 'SOL', 'HYPE', 'AAVE', 'LINK', 'AVAX', 'GOLD', 'OIL', 'SP500', 'MSTR', 'XRP', 'SUI', 'DOGE', 'TAO']
const TF_ORDER = ['1wk', '1d', '4h', '1h']
const TF_LABELS: Record<string, string> = { '1wk': 'Semanal', '1d': 'Diário', '4h': '4 Horas', '1h': '1 Hora' }

async function getData(asset: Asset) {
  const db = supabaseAdmin()
  const [{ data: snaps }, { data: signals }, { data: trades }, { data: perf }] = await Promise.all([
    db.from('snapshots').select('*').eq('asset', asset).order('captured_at', { ascending: false }).limit(40),
    db.from('signals').select('*').eq('asset', asset).order('detected_at', { ascending: false }).limit(10),
    db.from('trades').select('*').eq('asset', asset).order('opened_at', { ascending: false }).limit(20),
    db.from('performance_summary').select('*').eq('asset', asset).single(),
  ])
  return { snaps: snaps ?? [], signals: signals ?? [], trades: trades ?? [], perf: perf ?? null }
}

function BiasIcon({ bias }: { bias: string }) {
  if (bias === 'ALTISTA')  return <span className="text-emerald-400 font-bold">▲</span>
  if (bias === 'BAIXISTA') return <span className="text-red-400 font-bold">▼</span>
  return <span className="text-yellow-400 font-bold">—</span>
}

function CloudLabel({ pos }: { pos: string }) {
  if (pos === 'above') return <span className="text-emerald-400">ACIMA</span>
  if (pos === 'below') return <span className="text-red-400">ABAIXO</span>
  return <span className="text-yellow-400">DENTRO</span>
}

export default async function AssetPage({ params }: { params: Promise<{ asset: string }> }) {
  const { asset: rawAsset } = await params
  const asset = rawAsset.toUpperCase() as Asset
  if (!VALID_ASSETS.includes(asset)) notFound()

  const { snaps, signals, trades, perf } = await getData(asset)

  // Latest snapshot per timeframe
  const seen = new Set<string>()
  const latest: Record<string, any> = {}
  for (const s of snaps) {
    if (!seen.has(s.timeframe)) {
      seen.add(s.timeframe)
      latest[s.timeframe] = s
    }
  }

  const price      = latest['4h']?.close ?? latest['1d']?.close ?? 0
  const color      = ASSET_COLORS[asset]
  const label      = ASSET_LABELS[asset]
  const openTrades = trades.filter((t: any) => t.status === 'open')
  const closedTrades = trades.filter((t: any) => t.status === 'closed')
  const activeSignals = signals.filter((s: any) => s.status === 'active')

  return (
    <div>
      {/* Back */}
      <Link href="/" className="text-xs text-gray-500 hover:text-gray-300 flex items-center gap-1 mb-4">
        ← Dashboard
      </Link>

      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="w-3 h-3 rounded-full mt-1" style={{ backgroundColor: color }} />
          <div>
            <h1 className="text-3xl font-bold">{asset}</h1>
            <p className="text-gray-500 text-sm">{label}</p>
          </div>
        </div>
        <div className="text-right">
          <p className="text-3xl font-mono font-bold">${fmtPrice(price)}</p>
          <p className="text-xs text-gray-500 mt-0.5">
            {latest['4h'] ? `Atualizado ${new Date(latest['4h'].captured_at).toLocaleString('pt-BR')}` : ''}
          </p>
        </div>
      </div>

      {/* Performance stats */}
      {perf && (
        <div className="grid grid-cols-2 md:grid-cols-6 gap-3 mb-6">
          {[
            { label: 'Trades',    value: perf.total_trades,                                      color: 'text-gray-100' },
            { label: 'Wins',      value: perf.winners,                                           color: 'text-emerald-400' },
            { label: 'Losses',    value: perf.losers,                                            color: 'text-red-400' },
            { label: 'Winrate',   value: `${Number(perf.winrate_pct).toFixed(1)}%`,              color: perf.winrate_pct >= 50 ? 'text-emerald-400' : 'text-red-400' },
            { label: 'P&L Total', value: `${perf.total_pnl_usd >= 0 ? '+' : ''}$${fmtPrice(perf.total_pnl_usd)}`, color: pnlColor(perf.total_pnl_usd) },
            { label: 'Média %',   value: `${perf.avg_pnl_pct >= 0 ? '+' : ''}${Number(perf.avg_pnl_pct).toFixed(1)}%`, color: pnlColor(perf.avg_pnl_pct) },
          ].map(s => (
            <div key={s.label} className="bg-gray-900 border border-gray-800 rounded-xl p-3 text-center">
              <p className="text-xs text-gray-500 mb-1">{s.label}</p>
              <p className={cn('text-lg font-bold font-mono', s.color)}>{s.value}</p>
            </div>
          ))}
        </div>
      )}

      {/* Timeframe grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4 mb-6">
        {TF_ORDER.map(tf => {
          const s = latest[tf]
          if (!s) return (
            <div key={tf} className="bg-gray-900 border border-dashed border-gray-700 rounded-xl p-4">
              <p className="text-xs text-gray-500 mb-2">{TF_LABELS[tf]}</p>
              <p className="text-gray-700 text-sm">Sem dados</p>
            </div>
          )
          return (
            <div key={tf} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
              <div className="flex items-center justify-between mb-3">
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">{TF_LABELS[tf]}</p>
                <div className="flex items-center gap-2">
                  <BiasIcon bias={s.bias} />
                  <span className={cn('text-xs font-semibold', biasColor(s.bias))}>{s.bias}</span>
                </div>
              </div>

              <p className="text-xl font-mono font-bold mb-3">${fmtPrice(s.close)}</p>

              <div className="space-y-2 text-xs">
                <div className="flex justify-between">
                  <span className="text-gray-500">EMA200</span>
                  <span className={cn('font-mono', s.price_vs_ema === 'above' ? 'text-emerald-400' : 'text-red-400')}>
                    ${fmtPrice(s.ema200)} ({s.price_vs_ema === 'above' ? 'acima' : 'abaixo'})
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Cloud</span>
                  <CloudLabel pos={s.price_vs_cloud} />
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">WaveTrend</span>
                  <span className={cn('font-mono',
                    s.wt_zone === 'overbought' ? 'text-red-400' :
                    s.wt_zone === 'oversold'   ? 'text-emerald-400' : 'text-gray-300'
                  )}>
                    {s.wt1?.toFixed(1)} <span className="text-gray-600">({s.wt_zone})</span>
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Tenkan/Kijun</span>
                  <span className={s.tenkan_vs_kijun === 'above' ? 'text-emerald-400' : 'text-red-400'}>
                    {s.tenkan_vs_kijun === 'above' ? 'Tenkan acima' : 'Tenkan abaixo'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">BB</span>
                  <span className="text-gray-400 font-mono text-xs">
                    {fmtPrice(s.bb_lower)} — {fmtPrice(s.bb_upper)}
                  </span>
                </div>
                {(s.bos_up || s.bos_down) && (
                  <div className="flex justify-between">
                    <span className="text-gray-500">Estrutura</span>
                    <span className={s.bos_up ? 'text-emerald-400' : 'text-red-400'}>
                      {s.bos_up ? 'BOS ▲' : 'BOS ▼'}
                    </span>
                  </div>
                )}
                {s.wt_cross_up && <p className="text-emerald-400 text-center mt-1">⚡ WT Cross UP</p>}
                {s.wt_cross_down && <p className="text-red-400 text-center mt-1">⚡ WT Cross DOWN</p>}
              </div>

              {/* Bull/Bear score */}
              <div className="mt-3 flex gap-2">
                <div className="flex-1 bg-emerald-500/10 rounded px-2 py-1 text-center">
                  <p className="text-xs text-gray-500">Bull</p>
                  <p className="text-emerald-400 font-bold">{s.bull_pts}</p>
                </div>
                <div className="flex-1 bg-red-500/10 rounded px-2 py-1 text-center">
                  <p className="text-xs text-gray-500">Bear</p>
                  <p className="text-red-400 font-bold">{s.bear_pts}</p>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* Active signals */}
      {activeSignals.length > 0 && (
        <div className="mb-6">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
            Sinais ativos ({activeSignals.length})
          </p>
          <div className="space-y-3">
            {activeSignals.map((s: any) => (
              <div key={s.id} className="bg-gray-900 border border-emerald-500/20 rounded-xl p-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <span className={s.direction === 'long' ? 'text-emerald-400 text-lg' : 'text-red-400 text-lg'}>
                      {s.direction === 'long' ? '▲' : '▼'}
                    </span>
                    <span className={cn('text-xs px-2 py-0.5 rounded font-bold', gradeColor(s.setup_grade))}>
                      {s.setup_grade}
                    </span>
                    <span className="text-xs text-gray-500">RR {s.rr1}:1</span>
                  </div>
                  <span className="text-xs text-gray-500">{new Date(s.detected_at).toLocaleString('pt-BR')}</span>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                  <div className="bg-gray-800 rounded p-2">
                    <p className="text-gray-500 mb-0.5">Entrada</p>
                    <p className="font-mono">${fmtPrice(s.entry_zone_low)} – ${fmtPrice(s.entry_zone_high)}</p>
                  </div>
                  <div className="bg-gray-800 rounded p-2">
                    <p className="text-gray-500 mb-0.5">Stop</p>
                    <p className="font-mono text-red-400">${fmtPrice(s.stop)}</p>
                  </div>
                  <div className="bg-gray-800 rounded p-2">
                    <p className="text-gray-500 mb-0.5">Alvo 1</p>
                    <p className="font-mono text-emerald-400">${fmtPrice(s.target1)}</p>
                  </div>
                  <div className="bg-gray-800 rounded p-2">
                    <p className="text-gray-500 mb-0.5">Gatilho</p>
                    <p className="text-gray-300 leading-tight">{s.trigger}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Open trades */}
      {openTrades.length > 0 && (
        <div className="mb-6">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
            Trades abertos ({openTrades.length})
          </p>
          <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800 text-gray-500 text-xs uppercase">
                  {['Dir','Grade','Entrada','Stop','Alvo 1','Alav'].map(h => (
                    <th key={h} className="text-left px-4 py-3">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {openTrades.map((t: any) => (
                  <tr key={t.id} className="border-b border-gray-800/50">
                    <td className="px-4 py-3">
                      <span className={t.direction === 'long' ? 'text-emerald-400' : 'text-red-400'}>
                        {t.direction.toUpperCase()}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {t.setup_grade && <span className={cn('text-xs px-1.5 py-0.5 rounded font-bold', gradeColor(t.setup_grade))}>{t.setup_grade}</span>}
                    </td>
                    <td className="px-4 py-3 font-mono">${fmtPrice(t.entry_price)}</td>
                    <td className="px-4 py-3 font-mono text-red-400">${fmtPrice(t.stop_price)}</td>
                    <td className="px-4 py-3 font-mono text-emerald-400">${fmtPrice(t.target1 ?? 0)}</td>
                    <td className="px-4 py-3 text-gray-400">{t.leverage}x</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Closed trades history */}
      {closedTrades.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
            Histórico de trades ({closedTrades.length})
          </p>
          <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800 text-gray-500 text-xs uppercase">
                  {['Dir','Grade','Entrada','Fechamento','P&L %','P&L USD','Data'].map(h => (
                    <th key={h} className="text-left px-4 py-3">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {closedTrades.map((t: any) => (
                  <tr key={t.id} className="border-b border-gray-800/50 hover:bg-gray-800/30">
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
                    <td className="px-4 py-3 text-gray-500 text-xs">
                      {new Date(t.closed_at).toLocaleDateString('pt-BR')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Empty state */}
      {signals.length === 0 && trades.length === 0 && (
        <div className="bg-gray-900 border border-dashed border-gray-700 rounded-xl p-8 text-center">
          <p className="text-gray-500 text-sm">Nenhum sinal ou trade registrado para {asset}.</p>
          <p className="text-gray-600 text-xs mt-1">Execute o scanner para detectar oportunidades.</p>
        </div>
      )}
    </div>
  )
}
