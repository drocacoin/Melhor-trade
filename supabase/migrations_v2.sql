-- ─── Melhor Trade — Migrations v2 ────────────────────────────────────────────
-- Run these statements in Supabase SQL Editor (once, in order).

-- ── 1. system_events — DB logging para circuit breaker, auto-close, etc. ─────
CREATE TABLE IF NOT EXISTS system_events (
  id          BIGSERIAL PRIMARY KEY,
  event_type  TEXT        NOT NULL,   -- 'circuit_breaker_triggered' | 'stop_auto_closed' | etc.
  asset       TEXT,
  data        JSONB,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_system_events_type_created
  ON system_events (event_type, created_at DESC);

-- ── 2. signals — adiciona confidence_pct ─────────────────────────────────────
ALTER TABLE signals
  ADD COLUMN IF NOT EXISTS confidence_pct INTEGER;   -- 0-100, scoreToConfidence()

-- ── 3. trades — colunas de posição parcial ───────────────────────────────────
-- Grava o parcial 50% executado no alvo 1 para cálculo de P&L blended no close.
ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS partial_close_1_price    NUMERIC,        -- preço de execução do parcial
  ADD COLUMN IF NOT EXISTS partial_close_1_pct      INTEGER,        -- % fechado (50)
  ADD COLUMN IF NOT EXISTS partial_close_1_pnl_pct  NUMERIC,        -- P&L % da porção fechada (com leverage)
  ADD COLUMN IF NOT EXISTS partial_close_1_at       TIMESTAMPTZ;    -- timestamp

-- ── 4. evolution_log — colunas de holdout validation ─────────────────────────
ALTER TABLE evolution_log
  ADD COLUMN IF NOT EXISTS train_count     INTEGER,
  ADD COLUMN IF NOT EXISTS holdout_count   INTEGER,
  ADD COLUMN IF NOT EXISTS inconsistent_ct INTEGER;
