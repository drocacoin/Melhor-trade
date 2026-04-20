'use client'
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis,
  CartesianGrid, Tooltip, ReferenceLine,
} from 'recharts'

interface Props {
  trades: {
    asset:     string
    direction: string
    pnl_usd:   number | null
    pnl_pct:   number | null
    closed_at: string | null
  }[]
}

function CustomTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null
  const d = payload[0].payload
  const sign = d.cumPnl >= 0 ? '+' : ''
  return (
    <div className="bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-xs">
      <p className="text-gray-400 mb-1">Trade #{d.index} — {d.asset} {d.direction}</p>
      <p className={d.tradePnl >= 0 ? 'text-emerald-400' : 'text-red-400'}>
        Este trade: {d.tradePnl >= 0 ? '+' : ''}${d.tradePnl.toFixed(2)}
      </p>
      <p className={d.cumPnl >= 0 ? 'text-emerald-400 font-bold' : 'text-red-400 font-bold'}>
        Acumulado: {sign}${d.cumPnl.toFixed(2)}
      </p>
    </div>
  )
}

export function EquityCurve({ trades }: Props) {
  if (trades.length < 2) return null

  // Ordenar por data de fechamento
  const sorted = [...trades].sort((a, b) =>
    (a.closed_at ?? '').localeCompare(b.closed_at ?? '')
  )

  // Montar pontos da curva — ponto 0 = início em $0
  let cumPnl = 0
  const data = [{ index: 0, cumPnl: 0, tradePnl: 0, asset: '', direction: '', date: '' }]

  for (let i = 0; i < sorted.length; i++) {
    const t        = sorted[i]
    const tradePnl = t.pnl_usd ?? 0
    cumPnl        += tradePnl
    data.push({
      index:     i + 1,
      cumPnl:    Math.round(cumPnl * 100) / 100,
      tradePnl:  Math.round(tradePnl * 100) / 100,
      asset:     t.asset,
      direction: t.direction,
      date:      t.closed_at?.slice(0, 10) ?? '',
    })
  }

  const maxAbs  = Math.max(...data.map(d => Math.abs(d.cumPnl)), 1)
  const isGreen = cumPnl >= 0

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 mb-6">
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm font-semibold text-gray-300">Curva de Equity</p>
        <div className="flex items-center gap-4 text-xs">
          <span className="text-gray-500">{trades.length} trades</span>
          <span className={isGreen ? 'text-emerald-400 font-bold' : 'text-red-400 font-bold'}>
            {isGreen ? '+' : ''}${cumPnl.toFixed(2)} total
          </span>
        </div>
      </div>

      <ResponsiveContainer width="100%" height={180}>
        <LineChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
          <XAxis
            dataKey="index"
            tick={{ fill: '#6b7280', fontSize: 11 }}
            tickLine={false}
            label={{ value: 'trades', position: 'insideBottomRight', offset: -4, fill: '#4b5563', fontSize: 10 }}
          />
          <YAxis
            tick={{ fill: '#6b7280', fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            tickFormatter={v => `$${v}`}
            domain={[-maxAbs * 1.1, maxAbs * 1.1]}
            width={56}
          />
          <Tooltip content={<CustomTooltip />} />
          <ReferenceLine y={0} stroke="#374151" strokeDasharray="4 4" />
          <Line
            type="monotone"
            dataKey="cumPnl"
            stroke={isGreen ? '#10b981' : '#ef4444'}
            strokeWidth={2}
            dot={(props: any) => {
              const { cx, cy, payload } = props
              if (payload.index === 0) return <g key="origin" />
              const color = payload.tradePnl >= 0 ? '#10b981' : '#ef4444'
              return (
                <circle
                  key={`dot-${payload.index}`}
                  cx={cx} cy={cy} r={3}
                  fill={color} stroke={color}
                />
              )
            }}
            activeDot={{ r: 5, fill: isGreen ? '#10b981' : '#ef4444' }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
