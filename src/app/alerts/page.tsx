import { supabaseAdmin } from '@/lib/supabase'
import { cn } from '@/lib/utils'

function gradeColor(grade: string) {
  const m: Record<string, string> = {
    'A+': 'bg-emerald-500 text-white', 'A': 'bg-green-500 text-white',
    'B': 'bg-yellow-500 text-black',   'C': 'bg-orange-500 text-white',
  }
  return m[grade] ?? 'bg-gray-600 text-white'
}

export const revalidate = 60

export default async function AlertsPage() {
  const db = supabaseAdmin()
  const { data: signals } = await db
    .from('signals')
    .select('*')
    .order('detected_at', { ascending: false })
    .limit(50)

  const active   = (signals ?? []).filter(s => s.status === 'active')
  const inactive = (signals ?? []).filter(s => s.status !== 'active')

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Alertas</h1>
        <p className="text-sm text-gray-500 mt-0.5">Sinais detectados pelo scanner automático</p>
      </div>

      {/* Active */}
      <div className="mb-6">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
          Ativos ({active.length})
        </p>
        {active.length === 0
          ? <div className="bg-gray-900 border border-dashed border-gray-700 rounded-xl p-8 text-center text-gray-600 text-sm">Nenhum sinal ativo no momento</div>
          : <div className="space-y-3">
              {active.map(s => <SignalCard key={s.id} signal={s} />)}
            </div>
        }
      </div>

      {/* History */}
      {inactive.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
            Histórico ({inactive.length})
          </p>
          <div className="space-y-2">
            {inactive.map(s => <SignalCard key={s.id} signal={s} compact />)}
          </div>
        </div>
      )}
    </div>
  )
}

function SignalCard({ signal: s, compact = false }: { signal: any; compact?: boolean }) {
  const isLong = s.direction === 'long'
  const date   = new Date(s.detected_at).toLocaleString('pt-BR')

  if (compact) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-lg px-4 py-3 flex items-center justify-between text-sm opacity-60">
        <div className="flex items-center gap-3">
          <span className={isLong ? 'text-emerald-400' : 'text-red-400'}>{isLong ? '▲' : '▼'}</span>
          <span className="font-semibold">{s.asset}</span>
          <span className={cn('text-xs px-1.5 py-0.5 rounded font-bold', gradeColor(s.setup_grade))}>{s.setup_grade}</span>
          <span className="text-gray-500">{s.status}</span>
        </div>
        <span className="text-xs text-gray-600">{date}</span>
      </div>
    )
  }

  return (
    <div className="bg-gray-900 border border-emerald-500/20 rounded-xl p-5">
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-center gap-3">
          <span className={`text-2xl font-bold ${isLong ? 'text-emerald-400' : 'text-red-400'}`}>
            {isLong ? '▲' : '▼'}
          </span>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-lg font-bold">{s.asset}</span>
              <span className={cn('text-sm px-2 py-0.5 rounded font-bold', gradeColor(s.setup_grade))}>
                {s.setup_grade}
              </span>
              {s.macro_score !== 0 && (
                <span className={cn('text-xs font-mono font-bold',
                  s.macro_score > 0 ? 'text-emerald-400' : 'text-red-400'
                )}>M{s.macro_score > 0 ? '+' : ''}{s.macro_score}</span>
              )}
            </div>
            <p className="text-xs text-gray-500 mt-0.5">{date}</p>
          </div>
        </div>
        <span className="text-xs bg-emerald-500/20 text-emerald-400 px-2 py-1 rounded font-medium">ATIVO</span>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        {[
          { label: 'Entrada',  value: `$${s.entry_zone_low} – $${s.entry_zone_high}` },
          { label: 'Stop',     value: `$${s.stop}`,     color: 'text-red-400' },
          { label: 'Alvo 1',   value: `$${s.target1}`,  color: 'text-emerald-400' },
          { label: 'RR',       value: `${s.rr1}:1`,     color: 'text-yellow-400' },
        ].map(item => (
          <div key={item.label} className="bg-gray-800 rounded-lg p-2.5">
            <p className="text-xs text-gray-500 mb-0.5">{item.label}</p>
            <p className={cn('text-sm font-mono font-semibold', item.color ?? 'text-gray-100')}>{item.value}</p>
          </div>
        ))}
      </div>

      {s.trigger && (
        <div className="bg-gray-800 rounded-lg px-3 py-2 mb-2">
          <p className="text-xs text-gray-500 mb-0.5">Gatilho</p>
          <p className="text-xs text-gray-300">{s.trigger}</p>
        </div>
      )}
      {s.cancellation && (
        <div className="bg-red-500/5 border border-red-500/10 rounded-lg px-3 py-2">
          <p className="text-xs text-gray-500 mb-0.5">Cancelamento</p>
          <p className="text-xs text-gray-400">{s.cancellation}</p>
        </div>
      )}
    </div>
  )
}
