export type Asset = 'BTC' | 'ETH' | 'SOL' | 'HYPE' | 'AAVE' | 'LINK' | 'AVAX' | 'GOLD' | 'OIL' | 'SP500' | 'MSTR'
export type Timeframe = 'macro' | 'trend' | 'execution' | 'refinement'
export type Direction = 'long' | 'short'
export type SetupGrade = 'A+' | 'A' | 'B' | 'C' | 'invalid'
export type MacroRegime = 'risk-on' | 'risk-off' | 'neutro' | 'transicao'
export type Bias = 'ALTISTA' | 'BAIXISTA' | 'NEUTRO/MISTO'
export type ConfidenceLevel = 'alta' | 'media' | 'baixa'
export type FactType = 'fato' | 'interpretacao' | 'hipotese'

export interface Snapshot {
  id: number
  asset: Asset
  timeframe: string
  captured_at: string
  close: number
  ema200: number
  bb_upper: number
  bb_mid: number
  bb_lower: number
  cloud_top: number
  cloud_bottom: number
  tenkan: number
  kijun: number
  wt1: number
  wt2: number
  wt_cross_up: boolean
  wt_cross_down: boolean
  wt_zone: string
  price_vs_ema: string
  price_vs_cloud: string
  tenkan_vs_kijun: string
  last_swing_high: number | null
  last_swing_low: number | null
  bos_up: boolean
  bos_down: boolean
  bias: Bias
  bull_pts: number
  bear_pts: number
}

export interface Signal {
  id: number
  asset: Asset
  detected_at: string
  direction: Direction
  setup_grade: SetupGrade
  macro_score: number
  entry_zone_low: number
  entry_zone_high: number
  stop: number
  target1: number
  target2: number | null
  target3: number | null
  rr1: number
  trigger: string
  cancellation: string
  analysis: string
  status: 'active' | 'triggered' | 'cancelled' | 'expired'
}

export interface Trade {
  id: number
  signal_id: number | null
  asset: Asset
  direction: Direction
  leverage: number
  entry_price: number
  stop_price: number
  target1: number | null
  target2: number | null
  target3: number | null
  size: number | null
  setup_grade: SetupGrade | null
  opened_at: string
  closed_at: string | null
  close_price: number | null
  pnl_pct: number | null
  pnl_usd: number | null
  status: 'open' | 'closed' | 'cancelled'
  notes: string | null
}

export interface TradeReview {
  id: number
  trade_id: number
  reviewed_at: string
  score_estrutura: number
  score_timing: number
  score_indicadores: number
  score_macro: number
  score_risco: number
  score_execucao: number
  score_disciplina: number
  score_medio: number
  process_class: 'correto' | 'parcialmente_correto' | 'incorreto'
  error_category: string | null
  what_went_right: string | null
  what_went_wrong: string | null
  main_error: string | null
  main_success: string | null
  next_trade_change: string | null
  new_rule: string | null
  trade_really_existed: boolean
  forced_entry: boolean
}

export interface MacroReading {
  id: number
  captured_at: string
  regime: MacroRegime
  macro_score: number
  dxy_trend: string
  yields_trend: string
  fed_stance: string
  notes: string | null
}

export interface PerformanceSummary {
  asset: Asset
  total_trades: number
  winners: number
  losers: number
  winrate_pct: number
  total_pnl_usd: number
  avg_pnl_pct: number
}

// Grupos de correlação — alertamos quando há posições abertas no mesmo grupo
export const CORRELATION_GROUPS: Record<string, Asset[]> = {
  crypto:      ['BTC', 'ETH', 'SOL', 'HYPE', 'AAVE', 'LINK', 'AVAX'],
  commodities: ['GOLD', 'OIL'],
  equities:    ['SP500', 'MSTR'],  // MSTR também correlacionado com BTC
}

export const ASSET_SYMBOLS: Record<Asset, string> = {
  BTC:  'BTCUSDT',  ETH:   'ETHUSDT',  SOL:  'SOLUSDT',
  HYPE: 'HYPEUSDT', AAVE:  'AAVEUSDT', LINK: 'LINKUSDT', AVAX: 'AVAXUSDT',
  GOLD: 'GOLD(XAUT)USDT', OIL: 'OIL(USOON)USDT',
  SP500: 'SPY',     MSTR:  'MSTR',
}

export const ASSET_LABELS: Record<Asset, string> = {
  BTC:  'Bitcoin',     ETH:  'Ethereum',  SOL:  'Solana',
  HYPE: 'Hyperliquid', AAVE: 'Aave',      LINK: 'Chainlink', AVAX: 'Avalanche',
  GOLD: 'Ouro (XAUT)', OIL:  'Petróleo Brent',
  SP500: 'S&P 500 (SPY)', MSTR: 'MicroStrategy',
}

export const ASSET_COLORS: Record<Asset, string> = {
  BTC:  '#F7931A', ETH:  '#627EEA', SOL:  '#9945FF',
  HYPE: '#00D4FF', AAVE: '#B6509E', LINK: '#2A5ADA', AVAX: '#E84142',
  GOLD: '#FFD700', OIL:  '#8B4513',
  SP500: '#4CAF50', MSTR: '#FF6B00',
}
