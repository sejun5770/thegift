-- ============================================
-- 028_naver_multi_store.sql
--
-- 네이버 스마트스토어 멀티 스토어 지원 — store_id 컬럼 추가.
-- 기존 row 는 'main' 으로 backfill (DEFAULT).
-- naver_sync_state singleton constraint 제거 + store_id 별 row 허용.
--
-- 후방 호환:
--   - 기존 NAVER_CLIENT_ID 단일 env 환경 → store_id='main' 자동 사용
--   - NAVER_STORES JSON 도입 시 store 별 row 자동 생성
-- ============================================

-- ── naver_orders: store_id 컬럼 + 인덱스 ──
ALTER TABLE naver_orders
  ADD COLUMN IF NOT EXISTS store_id TEXT NOT NULL DEFAULT 'main';

CREATE INDEX IF NOT EXISTS idx_naver_orders_store_id ON naver_orders(store_id);
CREATE INDEX IF NOT EXISTS idx_naver_orders_store_paid_at ON naver_orders(store_id, paid_at DESC);

-- ── naver_sync_state: singleton 해제 → store_id 별 row 허용 ──
ALTER TABLE naver_sync_state DROP CONSTRAINT IF EXISTS naver_sync_state_singleton;
ALTER TABLE naver_sync_state ADD COLUMN IF NOT EXISTS store_id TEXT NOT NULL DEFAULT 'main';

-- 기존 id=1 row 는 store_id='main' 으로 자동 backfill (DEFAULT)
-- 새 store 는 row 추가 — store_id UNIQUE 보장
CREATE UNIQUE INDEX IF NOT EXISTS naver_sync_state_store_id_uq ON naver_sync_state(store_id);
