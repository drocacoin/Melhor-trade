'use client'
import Link from 'next/link'
import { Snapshot, Asset, ASSET_LABELS, ASSET_COLORS } from '@/types'
import { fmtPrice, gradeColor, biasColor, cn } from '@/lib/utils'

interface Props {
  asset: Asset
  snapshots: Snapshot[]
  livePrice?: number
  setupGrade?: string
  macroScore?: number
}

const TF_LABELS: Record<string, string> = {
  '1wk': 'SEM', '1d': 'DIA', '4h': '4H', '1h': '1H'
}

export function AssetCard({ asset, snapshots, livePrice, setupGrade, macroScore }: Props) {
  const color = ASSET_COLORS[asset]
  const byTf  = Object.fromEntries(snapshots.map(s => [s.timeframe, s]))

  return (
    <Link href={`/assets/${asset}`}>
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 hover:border-gray-600 transition-colors cursor-pointer">
        {/* Header */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
            <span className="font-semibold text-gray-100">{asset}</span>
            <span className="text-xs text-gray-500">{ASSET_LABELS[asset]}</span>
          </div>
          <div className="flex items-center gap-2">
            {setupGrade && (
              <span className={cn('text-xs px-2 py-0.5 rounded font-bold', gradeColor(setupGrade))}>
                {setupGrade}
              </span>
            )}
            {macroScore !== undefined && (
              <span className={cn('text-xs font-mono font-bold',
                macroScore >= 1 ? 'text-emerald-400' : macroScore <= -1 ? 'text-red-400' : 'text-yellow-400'
              )}>
                M{macroScore >= 0 ? '+' : ''}{macroScore}
              </span>
            )}
          </div>
        </div>

        {/* Price */}
        <div className="text-2xl font-mono font-bold text-gray-100 mb-3">
          ${fmtPrice(livePrice ?? byTf['4h']?.close ?? 0)}
        </div>

        {/* Timeframe bias grid */}
        <div className="grid grid-cols-4 gap-1">
          {['1wk', '1d', '4h', '1h'].map(tf => {
            const snap = byTf[tf]
            return (
              <div key={tf} className="bg-gray-800 rounded p-1.5 text-center">
                <div className="text-xs text-gray-500 mb-0.5">{TF_LABELS[tf]}</div>
                <div className={cn('text-xs font-semibold', snap ? biasColor(snap.bias) : 'text-gray-600')}>
                  {snap ? (snap.bias === 'ALTISTA' ? '▲' : snap.bias === 'BAIXISTA' ? '▼' : '—') : '?'}
                </div>
              </div>
            )
          })}
        </div>

        {/* Key levels */}
        {byTf['4h'] && (
          <div className="mt-3 grid grid-cols-3 gap-2 text-xs text-gray-500">
            <div>EMA200 <span className="text-gray-300">${fmtPrice(byTf['4h'].ema200)}</span></div>
            <div>WT1 <span className={cn('font-mono',
              byTf['4h'].wt_zone === 'overbought' ? 'text-red-400' :
              byTf['4h'].wt_zone === 'oversold'   ? 'text-emerald-400' : 'text-gray-300'
            )}>{byTf['4h'].wt1?.toFixed(1)}</span></div>
            <div>Cloud <span className={cn(
              byTf['4h'].price_vs_cloud === 'above' ? 'text-emerald-400' :
              byTf['4h'].price_vs_cloud === 'below' ? 'text-red-400' : 'text-yellow-400'
            )}>{byTf['4h'].price_vs_cloud === 'above' ? 'ACIMA' : byTf['4h'].price_vs_cloud === 'below' ? 'ABAIXO' : 'DENTRO'}</span></div>
          </div>
        )}
      </div>
    </Link>
  )
}
