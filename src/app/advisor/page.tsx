'use client'
import { useState } from 'react'
import { cn, fmtPrice } from '@/lib/utils'

// ── Helpers ────────────────────────────────────────────────────────────────────
const overallConfig = {
  favorável:    { bg: 'bg-emerald-500/10', border: 'border-emerald-500/30', text: 'text-emerald-400', icon: '🟢' },
  neutro:       { bg: 'bg-yellow-500/10',  border: 'border-yellow-500/30',  text: 'text-yellow-400',  icon: '🟡' },
  desfavorável: { bg: 'bg-red-500/10',     border: 'border-red-500/30',     text: 'text-red-400',     icon: '🔴' },
}

const urgencyConfig = {
  alta:  { bg: 'bg-red-500/20',     text: 'text-red-400',     label: 'Alta' },
  média: { bg: 'bg-yellow-500/20',  text: 'text-yellow-400',  label: 'Média' },
  baixa: { bg: 'bg-gray-700',       text: 'text-gray-400',    label: 'Baixa' },
}

const actionConfig: Record<string, { icon: string; color: string; label: string }> = {
  manter:     { icon: '✓', color: 'text-emerald-400', label: 'Manter' },
  fechar:     { icon: '✗', color: 'text-red-400',     label: 'Fechar' },
  mover_stop: { icon: '↑', color: 'text-yellow-400',  label: 'Mover stop' },
  parcial:    { icon: '½', color: 'text-blue-400',    label: 'Parcial' },
}

// ── Seções da análise ─────────────────────────────────────────────────────────
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-4">
      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-4">{title}</p>
      {children}
    </div>
  )
}

// ── Main Page ──────────────────────────────────────────────────────────────────
export default function AdvisorPage() {
  const [result, setResult]   = useState<any>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState<string | null>(null)

  async function generate() {
    setLoading(true)
    setError(null)
    try {
      const r = await fetch('/api/advisor', { method: 'POST' })
      if (!r.ok) throw new Error(`Erro ${r.status}`)
      const d = await r.json()
      if (d.error) throw new Error(d.error)
      setResult(d)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  const a = result?.analysis
  const ctx = result?.context
  const overall = a ? overallConfig[a.overall as keyof typeof overallConfig] ?? overallConfig['neutro'] : null

  return (
    <div>
      {/* Header */}
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold">Advisor IA</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Análise consolidada de todos os dados → recomendação clara
          </p>
        </div>
        <button
          onClick={generate}
          disabled={loading}
          className={cn(
            'flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-semibold transition-all',
            loading
              ? 'bg-gray-800 text-gray-500 cursor-not-allowed'
              : 'bg-emerald-500 hover:bg-emerald-400 text-gray-950'
          )}
        >
          {loading ? (
            <>
              <span className="w-4 h-4 border-2 border-gray-500 border-t-transparent rounded-full animate-spin" />
              Analisando…
            </>
          ) : (
            <>✦ {result ? 'Nova análise' : 'Gerar análise'}</>
          )}
        </button>
      </div>

      {/* Erro */}
      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 mb-4 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Estado inicial */}
      {!result && !loading && !error && (
        <div className="bg-gray-900 border border-dashed border-gray-700 rounded-xl p-16 text-center">
          <p className="text-4xl mb-4">✦</p>
          <p className="text-gray-400 font-medium">Análise IA de todos os dados</p>
          <p className="text-gray-600 text-sm mt-2 max-w-md mx-auto">
            Consolida macro, scores técnicos, posições abertas, sinais ativos e
            performance histórica. Claude Sonnet analisa e recomenda a melhor ação.
          </p>
          <button
            onClick={generate}
            className="mt-6 px-6 py-2.5 bg-emerald-500 hover:bg-emerald-400 text-gray-950 rounded-lg text-sm font-semibold transition-colors"
          >
            ✦ Gerar análise agora
          </button>
        </div>
      )}

      {/* Skeleton enquanto carrega */}
      {loading && (
        <div className="space-y-4 animate-pulse">
          {[200, 160, 180, 140].map((h, i) => (
            <div key={i} className="bg-gray-900 border border-gray-800 rounded-xl" style={{ height: h }} />
          ))}
        </div>
      )}

      {/* Resultado */}
      {a && (
        <>
          {/* Timestamp + contexto rápido */}
          <div className="flex flex-wrap gap-2 mb-4 text-xs text-gray-600">
            <span>Gerado às {new Date(result.generated_at).toLocaleTimeString('pt-BR')}</span>
            {ctx && (
              <>
                <span>·</span>
                <span>{ctx.open_count} posições abertas</span>
                <span>·</span>
                <span>{ctx.signals} sinais ativos</span>
                <span>·</span>
                <span>WR {ctx.winrate.toFixed(1)}%</span>
                {ctx.fear_greed && (
                  <>
                    <span>·</span>
                    <span>F&G {ctx.fear_greed.value} — {ctx.fear_greed.label}</span>
                  </>
                )}
                {ctx.macro && (
                  <>
                    <span>·</span>
                    <span>Macro: {ctx.macro.regime} ({ctx.macro.score >= 0 ? '+' : ''}{ctx.macro.score})</span>
                  </>
                )}
              </>
            )}
          </div>

          {/* Overall + market view */}
          {overall && (
            <div className={cn(
              'rounded-xl border p-5 mb-4',
              overall.bg, overall.border
            )}>
              <div className="flex items-center gap-3 mb-3">
                <span className="text-2xl">{overall.icon}</span>
                <div>
                  <p className={cn('text-lg font-bold capitalize', overall.text)}>
                    Mercado {a.overall}
                  </p>
                  <p className="text-xs text-gray-500">Avaliação geral do ambiente</p>
                </div>
              </div>
              <p className="text-sm text-gray-300 leading-relaxed">{a.market_view}</p>
            </div>
          )}

          {/* Recomendação principal */}
          {a.recommendation && (
            <div className="bg-blue-500/10 border border-blue-500/30 rounded-xl p-5 mb-4">
              <p className="text-xs font-semibold text-blue-400 uppercase tracking-wide mb-2">✦ Recomendação</p>
              <p className="text-sm text-gray-200 leading-relaxed font-medium">{a.recommendation}</p>
            </div>
          )}

          {/* Oportunidades */}
          {a.opportunities?.length > 0 && (
            <Section title="Oportunidades identificadas">
              <div className="space-y-3">
                {a.opportunities.map((op: any, i: number) => {
                  const urg = urgencyConfig[op.urgency as keyof typeof urgencyConfig] ?? urgencyConfig['baixa']
                  return (
                    <div key={i} className="flex items-start gap-3 bg-gray-800/50 rounded-lg p-3">
                      <div className="shrink-0 text-center w-8">
                        <span className={cn('text-lg', op.direction === 'long' ? 'text-emerald-400' : 'text-red-400')}>
                          {op.direction === 'long' ? '▲' : '▼'}
                        </span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="font-bold text-gray-100">{op.asset}</span>
                          <span className={cn('text-xs font-medium', op.direction === 'long' ? 'text-emerald-400' : 'text-red-400')}>
                            {op.direction.toUpperCase()}
                          </span>
                          {op.score != null && (
                            <span className="text-xs text-gray-600">score {op.score}</span>
                          )}
                          <span className={cn('text-xs px-2 py-0.5 rounded-full ml-auto', urg.bg, urg.text)}>
                            {urg.label}
                          </span>
                        </div>
                        <p className="text-xs text-gray-400 leading-relaxed">{op.rationale}</p>
                      </div>
                    </div>
                  )
                })}
              </div>
            </Section>
          )}

          {/* Posições abertas */}
          {a.open_positions?.length > 0 && (
            <Section title="Posições abertas — o que fazer">
              <div className="space-y-2">
                {a.open_positions.map((p: any, i: number) => {
                  const act = actionConfig[p.action] ?? { icon: '?', color: 'text-gray-400', label: p.action }
                  return (
                    <div key={i} className="flex items-start gap-3 py-2 border-b border-gray-800 last:border-0">
                      <span className={cn('text-lg font-bold w-6 text-center shrink-0', act.color)}>
                        {act.icon}
                      </span>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-sm text-gray-200">{p.asset}</span>
                          <span className={cn('text-xs font-semibold', act.color)}>{act.label}</span>
                        </div>
                        <p className="text-xs text-gray-500 mt-0.5">{p.reason}</p>
                      </div>
                    </div>
                  )
                })}
              </div>
            </Section>
          )}

          {/* Riscos */}
          {a.risks?.length > 0 && (
            <Section title="Riscos a observar">
              <div className="space-y-2">
                {a.risks.map((r: string, i: number) => (
                  <div key={i} className="flex items-start gap-2 text-sm">
                    <span className="text-red-500 shrink-0 mt-0.5">⚠</span>
                    <p className="text-gray-400">{r}</p>
                  </div>
                ))}
              </div>
            </Section>
          )}
        </>
      )}
    </div>
  )
}
