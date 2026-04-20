-- Tabela de pesos dinâmicos do scoring — atualizada automaticamente após cada batch de trades
CREATE TABLE IF NOT EXISTS scoring_weights (
  id              BIGSERIAL PRIMARY KEY,
  asset           TEXT,          -- NULL = global (todos os ativos); ou ativo específico ex: 'BTC'
  factor          TEXT NOT NULL, -- nome do indicador ex: 'wt_cross_oversold'
  weight          NUMERIC NOT NULL DEFAULT 1.0,  -- multiplicador do ponto base (1.0 = sem mudança)
  base_points     NUMERIC NOT NULL DEFAULT 1.0,  -- pontuação base original do fator
  win_count       INT DEFAULT 0,
  loss_count      INT DEFAULT 0,
  win_rate_pct    NUMERIC,
  last_evolved_at TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(asset, factor)
);

-- Inicializa com os pesos base do sistema atual
INSERT INTO scoring_weights (asset, factor, weight, base_points) VALUES
  (NULL, 'wt_cross_oversold',    1.0, 3),
  (NULL, 'bos_up',               1.0, 2),
  (NULL, 'price_vs_cloud',       1.0, 1),
  (NULL, 'tenkan_vs_kijun',      1.0, 1),
  (NULL, 'daily_bias',           1.0, 2),
  (NULL, 'weekly_bias',          1.0, 1),
  (NULL, 'wt_cross_overbought',  1.0, 3),
  (NULL, 'bos_down',             1.0, 2)
ON CONFLICT (asset, factor) DO NOTHING;

-- Log de evoluções do sistema
CREATE TABLE IF NOT EXISTS evolution_log (
  id           BIGSERIAL PRIMARY KEY,
  evolved_at   TIMESTAMPTZ DEFAULT NOW(),
  trades_used  INT,
  changes      JSONB,  -- quais pesos mudaram e por quê
  ai_insights  TEXT    -- resumo da IA sobre o que mudou
);
