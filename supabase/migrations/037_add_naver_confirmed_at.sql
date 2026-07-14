-- ============================================
-- 037_add_naver_confirmed_at.sql
--
-- naver_orders 에 구매확정일 컬럼 추가.
--
-- 배경:
--   네이버 커머스 productOrderStatus='PURCHASE_DECIDED' 시점을 별도로
--   저장. sync 시 productOrder 응답의 decisionDate / purchaseDecidedDate /
--   completedDate / confirmDate 중 non-null 을 매핑.
--
-- 필터/조회 편의를 위한 인덱스 추가 (NOT NULL 만).
--
-- 기존 rows 는 NULL — 다음 sync 실행 시 자동 채워짐 (forward-only).
-- ============================================

ALTER TABLE naver_orders
  ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_naver_orders_confirmed_at
  ON naver_orders(confirmed_at DESC)
  WHERE confirmed_at IS NOT NULL;

COMMENT ON COLUMN naver_orders.confirmed_at IS '네이버 구매확정 시점 — productOrder 응답의 decisionDate / purchaseDecidedDate / completedDate / confirmDate 중 non-null 값.';
