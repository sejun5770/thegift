-- ============================================
-- COLLECTION RUNS (수집 실행 이력)
-- ============================================

CREATE TABLE collection_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source VARCHAR(50) NOT NULL DEFAULT 'barunson',
  status VARCHAR(20) NOT NULL DEFAULT 'running' CHECK (status IN (
    'running', 'completed', 'failed'
  )),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  last_order_date TIMESTAMPTZ,
  orders_collected INTEGER DEFAULT 0,
  orders_skipped INTEGER DEFAULT 0,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_collection_runs_source_status
  ON collection_runs(source, status);
CREATE INDEX idx_collection_runs_started_at
  ON collection_runs(started_at DESC);
