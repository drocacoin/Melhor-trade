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

-- ── 3. evolution_log — colunas de holdout validation ─────────────────────────
ALTER TABLE evolution_log
  ADD COLUMN IF NOT EXISTS train_count     INTEGER,
  ADD COLUMN IF NOT EXISTS holdout_count   INTEGER,
  ADD COLUMN IF NOT EXISTS inconsistent_ct INTEGER;
