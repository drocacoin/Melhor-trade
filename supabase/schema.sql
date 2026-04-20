-- ================================================================
-- MELHOR TRADE — Schema Supabase
-- Cole este SQL no SQL Editor do seu projeto Supabase
-- ================================================================

-- Snapshots de indicadores por ativo e timeframe
CREATE TABLE IF NOT EXISTS snapshots (
  id            BIGSERIAL PRIMARY KEY,
  asset         TEXT NOT NULL,
  timeframe     TEXT NOT NULL,
  captured_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  close         NUMERIC,
  ema200        NUMERIC,
  bb_upper      NUMERIC,
  bb_mid        NUMERIC,
  bb_lower      NUMERIC,
  cloud_top     NUMERIC,
  cloud_bottom  NUMERIC,
  tenkan        NUMERIC,
  kijun         NUMERIC,
  wt1           NUMERIC,
  wt2           NUMERIC,
  wt_cross_up   BOOLEAN DEFAULT FALSE,
  wt_cross_down BOOLEAN DEFAULT FALSE,
  wt_zone       TEXT,
  price_vs_ema  TEXT,
  price_vs_cloud TEXT,
  tenkan_vs_kijun TEXT,
  last_swing_high NUMERIC,
  last_swing_low  NUMERIC,
  bos_up        BOOLEAN DEFAULT FALSE,
  bos_down      BOOLEAN DEFAULT FALSE,
  bias          TEXT,
  bull_pts      INT,
  bear_pts      INT
);

-- Leituras macro por data
CREATE TABLE IF NOT EXISTS macro_readings (
  id            BIGSERIAL PRIMARY KEY,
  captured_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  regime        TEXT,        -- risk-on | risk-off | neutro | transicao
  macro_score   INT,         -- -2 a +2
  dxy_trend     TEXT,
  yields_trend  TEXT,
  fed_stance    TEXT,        -- hawkish | dovish | neutro
  notes         TEXT
);

-- Sinais / gatilhos detectados pelo scanner
CREATE TABLE IF NOT EXISTS signals (
  id            BIGSERIAL PRIMARY KEY,
  asset         TEXT NOT NULL,
  detected_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  direction     TEXT NOT NULL,   -- long | short
  setup_grade   TEXT NOT NULL,   -- A+ | A | B | C
  macro_score   INT,
  entry_zone_low  NUMERIC,
  entry_zone_high NUMERIC,
  stop          NUMERIC,
  target1       NUMERIC,
  target2       NUMERIC,
  target3       NUMERIC,
  rr1           NUMERIC,
  trigger       TEXT,
  cancellation  TEXT,
  analysis      TEXT,            -- texto gerado pelo Claude
  notified      BOOLEAN DEFAULT FALSE,
  status        TEXT DEFAULT 'active'  -- active | triggered | cancelled | expired
);

-- Trades abertos e fechados
CREATE TABLE IF NOT EXISTS trades (
  id            BIGSERIAL PRIMARY KEY,
  signal_id     BIGINT REFERENCES signals(id),
  asset         TEXT NOT NULL,
  direction     TEXT NOT NULL,   -- long | short
  leverage      NUMERIC DEFAULT 1,
  entry_price   NUMERIC NOT NULL,
  stop_price    NUMERIC NOT NULL,
  target1       NUMERIC,
  target2       NUMERIC,
  target3       NUMERIC,
  size          NUMERIC,         -- tamanho da posicao em USD
  setup_grade   TEXT,
  opened_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at     TIMESTAMPTZ,
  close_price   NUMERIC,
  pnl_pct       NUMERIC,         -- resultado em %
  pnl_usd       NUMERIC,         -- resultado em USD
  status        TEXT DEFAULT 'open',  -- open | closed | cancelled
  notes         TEXT
);

-- Review de cada trade encerrado (Review Engine)
CREATE TABLE IF NOT EXISTS trade_reviews (
  id                    BIGSERIAL PRIMARY KEY,
  trade_id              BIGINT REFERENCES trades(id),
  reviewed_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  score_estrutura       INT CHECK (score_estrutura BETWEEN 0 AND 10),
  score_timing          INT CHECK (score_timing BETWEEN 0 AND 10),
  score_indicadores     INT CHECK (score_indicadores BETWEEN 0 AND 10),
  score_macro           INT CHECK (score_macro BETWEEN 0 AND 10),
  score_risco           INT CHECK (score_risco BETWEEN 0 AND 10),
  score_execucao        INT CHECK (score_execucao BETWEEN 0 AND 10),
  score_disciplina      INT CHECK (score_disciplina BETWEEN 0 AND 10),
  score_medio           NUMERIC GENERATED ALWAYS AS (
    (score_estrutura + score_timing + score_indicadores + score_macro +
     score_risco + score_execucao + score_disciplina)::NUMERIC / 7
  ) STORED,
  process_class         TEXT,    -- correto | parcialmente_correto | incorreto
  error_category        TEXT,    -- categoria do erro principal
  what_went_right       TEXT,
  what_went_wrong       TEXT,
  main_error            TEXT,
  main_success          TEXT,
  next_trade_change     TEXT,
  new_rule              TEXT,    -- regra criada a partir do erro
  trade_really_existed  BOOLEAN, -- havia confluencia suficiente?
  forced_entry          BOOLEAN  -- forcei a entrada?
);

-- Log de alertas enviados
CREATE TABLE IF NOT EXISTS alerts_log (
  id          BIGSERIAL PRIMARY KEY,
  signal_id   BIGINT REFERENCES signals(id),
  sent_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  channel     TEXT DEFAULT 'telegram',
  message     TEXT,
  delivered   BOOLEAN DEFAULT TRUE
);

-- Indices para performance
CREATE INDEX IF NOT EXISTS idx_snapshots_asset_tf   ON snapshots(asset, timeframe, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_signals_asset        ON signals(asset, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_trades_status        ON trades(status, opened_at DESC);
CREATE INDEX IF NOT EXISTS idx_reviews_trade        ON trade_reviews(trade_id);

-- View de performance consolidada
CREATE OR REPLACE VIEW performance_summary AS
SELECT
  asset,
  COUNT(*) FILTER (WHERE status = 'closed')          AS total_trades,
  COUNT(*) FILTER (WHERE status = 'closed' AND pnl_usd > 0) AS winners,
  COUNT(*) FILTER (WHERE status = 'closed' AND pnl_usd <= 0) AS losers,
  ROUND(
    COUNT(*) FILTER (WHERE status = 'closed' AND pnl_usd > 0)::NUMERIC /
    NULLIF(COUNT(*) FILTER (WHERE status = 'closed'), 0) * 100, 1
  )                                                   AS winrate_pct,
  ROUND(SUM(pnl_usd) FILTER (WHERE status = 'closed'), 2) AS total_pnl_usd,
  ROUND(AVG(pnl_pct) FILTER (WHERE status = 'closed'), 2)  AS avg_pnl_pct
FROM trades
GROUP BY asset;
