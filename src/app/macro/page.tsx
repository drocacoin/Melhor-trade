import { supabaseAdmin } from '@/lib/supabase'

const MACRO_EVENTS = [
  { label: 'CPI', impact: 'alto', asset: 'BTC, GOLD, OIL' },
  { label: 'FOMC / Juros', impact: 'alto', asset: 'Todos' },
  { label: 'Payroll (NFP)', impact: 'alto', asset: 'BTC, GOLD' },
  { label: 'Estoques EIA', impact: 'medio', asset: 'OIL' },
  { label: 'Reunião OPEC', impact: 'alto', asset: 'OIL' },
  { label: 'PPI', impact: 'medio', asset: 'GOLD, BTC' },
  { label: 'PIB (GDP)', impact: 'medio', asset: 'Todos' },
  { label: 'Fala do FED', impact: 'alto', asset: 'Todos' },
]

const ASSET_MACRO = [
  { asset: 'BTC / ETH / SOL', drivers: ['Liquidez global', 'DXY', 'Yields', 'Nasdaq', 'ETF flows', 'Funding rates'], bullish: 'Dovish FED + DXY fraco + Yields caindo', bearish: 'Hawkish FED + DXY forte + Yields subindo' },
  { asset: 'Ouro (GOLD)',      drivers: ['Juros reais', 'DXY', 'Risco geopolítico', 'Busca por proteção'], bullish: 'Juros reais negativos + Aversão a risco + Inflação persistente', bearish: 'Yields altos + DXY forte + Risk-on' },
  { asset: 'Petróleo (OIL)',   drivers: ['OPEC+', 'Estoques EIA', 'Crescimento global', 'Geopolítica'], bullish: 'Oferta apertada + Demanda forte + Tensão geopolítica', bearish: 'Recessão + Demanda fraca + OPEC aumenta oferta' },
]

const SOURCE_LINKS = [
  { label: 'CME FedWatch', url: 'https://www.cmegroup.com/markets/interest-rates/cme-fedwatch-tool.html', level: 1 },
  { label: 'FRED (Fed Data)', url: 'https://fred.stlouisfed.org', level: 1 },
  { label: 'EIA Oil Data', url: 'https://www.eia.gov', level: 1 },
  { label: 'CFTC COT Report', url: 'https://www.cftc.gov/MarketReports/CommitmentsofTraders', level: 1 },
  { label: 'Glassnode', url: 'https://glassnode.com', level: 2 },
  { label: 'CryptoQuant', url: 'https://cryptoquant.com', level: 2 },
  { label: 'Kobeissi Letter', url: 'https://kobeissiletter.com', level: 2 },
]

export const revalidate = 600

export default async function MacroPage() {
  const db = supabaseAdmin()
  const { data: macroReadings } = await db
    .from('macro_readings')
    .select('*')
    .order('captured_at', { ascending: false })
    .limit(5)

  const latest = macroReadings?.[0]

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Painel Macro</h1>
        <p className="text-sm text-gray-500 mt-0.5">Contexto macroeconômico por ativo</p>
      </div>

      {/* Regime atual */}
      {latest && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-gray-500 mb-1">Regime atual</p>
              <p className={`text-2xl font-bold ${
                latest.regime === 'risk-on' ? 'text-emerald-400' :
                latest.regime === 'risk-off' ? 'text-red-400' : 'text-yellow-400'
              }`}>{(latest.regime as string).toUpperCase()}</p>
            </div>
            <div className="text-center">
              <p className="text-xs text-gray-500 mb-1">Pontuação macro</p>
              <p className={`text-4xl font-bold font-mono ${
                latest.macro_score >= 1 ? 'text-emerald-400' :
                latest.macro_score <= -1 ? 'text-red-400' : 'text-yellow-400'
              }`}>{latest.macro_score >= 0 ? '+' : ''}{latest.macro_score}</p>
              <p className="text-xs text-gray-600">(-2 a +2)</p>
            </div>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div><span className="text-gray-500">DXY: </span><span className="text-gray-200">{latest.dxy_trend}</span></div>
              <div><span className="text-gray-500">Yields: </span><span className="text-gray-200">{latest.yields_trend}</span></div>
              <div><span className="text-gray-500">FED: </span><span className="text-gray-200">{latest.fed_stance}</span></div>
            </div>
          </div>
          {latest.notes && <p className="text-sm text-gray-400 mt-3 border-t border-gray-800 pt-3">{latest.notes}</p>}
        </div>
      )}

      {!latest && (
        <div className="bg-gray-900 border border-dashed border-gray-700 rounded-xl p-8 mb-6 text-center">
          <p className="text-gray-500 text-sm">Nenhuma leitura macro registrada ainda.</p>
          <p className="text-gray-600 text-xs mt-1">O scanner atualiza automaticamente após cada varredura.</p>
        </div>
      )}

      {/* Impacto por ativo */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        {ASSET_MACRO.map(a => (
          <div key={a.asset} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <p className="font-semibold text-gray-100 mb-3 text-sm">{a.asset}</p>
            <p className="text-xs text-gray-500 mb-1">Drivers principais</p>
            <div className="flex flex-wrap gap-1 mb-3">
              {a.drivers.map(d => (
                <span key={d} className="text-xs bg-gray-800 text-gray-400 px-2 py-0.5 rounded">{d}</span>
              ))}
            </div>
            <div className="text-xs space-y-1">
              <p className="text-emerald-400">▲ {a.bullish}</p>
              <p className="text-red-400">▼ {a.bearish}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Eventos de alto impacto */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <p className="text-sm font-semibold text-gray-400 mb-3">Eventos de impacto</p>
          <div className="space-y-2">
            {MACRO_EVENTS.map(e => (
              <div key={e.label} className="flex items-center justify-between text-sm">
                <span className="text-gray-300">{e.label}</span>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-500">{e.asset}</span>
                  <span className={`text-xs px-2 py-0.5 rounded font-medium ${
                    e.impact === 'alto' ? 'bg-red-500/20 text-red-400' : 'bg-yellow-500/20 text-yellow-400'
                  }`}>{e.impact}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Fontes */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <p className="text-sm font-semibold text-gray-400 mb-3">Fontes prioritárias</p>
          <div className="space-y-2">
            {SOURCE_LINKS.map(s => (
              <div key={s.label} className="flex items-center justify-between text-sm">
                <a href={s.url} target="_blank" rel="noopener noreferrer"
                  className="text-emerald-400 hover:underline">{s.label}</a>
                <span className={`text-xs px-2 py-0.5 rounded ${
                  s.level === 1 ? 'bg-emerald-500/20 text-emerald-400' : 'bg-blue-500/20 text-blue-400'
                }`}>Nível {s.level}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Checklist macro */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <p className="text-sm font-semibold text-gray-400 mb-4">Checklist macro pré-trade (9 pontos)</p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {[
            'Regime: risk-on, risk-off ou neutro?',
            'Liquidez global aumentando ou caindo?',
            'Juros: expectativa de corte, manutenção ou alta?',
            'FED: hawkish ou dovish?',
            'DXY: forte, fraco ou lateral?',
            'Yields: subindo ou caindo?',
            'Específico do ativo (funding, OPEC, COT)',
            'Evento de alto impacto próximo?',
            'Macro confirma ou contradiz o gráfico?',
          ].map((item, i) => (
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
