-- ============================================
-- 080_add_coupang_confirmed_at.sql
--
-- coupang_orders 에 구매확정일 컬럼 추가 (네이버 037 과 같은 구조).
--
-- 배경:
--   출처 1) 정산현황 — 매출내역 조회 API(revenue-history) 의 recognitionDate(매출인식일).
--           쿠팡 문서: "'배송완료 + 7day' 또는 '구매확정'" 중 빠른 시점. 정산이 걸리는 기준.
--           백필(POST /api/coupang/backfill-confirmed-at, 새벽 스케줄)이 기간 조회로 채운다.
--   출처 2) ordersheet orderItems[].confirmDate("구매확정일자") — 동기화 시점에 값이 오면 저장.
--   로켓그로스 주문은 매출내역에 잡히면 채워지고, 아니면 NULL 로 남는다.
--
-- 기존 rows 는 NULL — 백필 실행 시 채워짐 (forward-only).
-- ============================================

ALTER TABLE coupang_orders
  ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_coupang_orders_confirmed_at
  ON coupang_orders(confirmed_at DESC)
  WHERE confirmed_at IS NOT NULL;

COMMENT ON COLUMN coupang_orders.confirmed_at IS '쿠팡 구매확정(매출인식) 시점 — 매출내역 조회 API recognitionDate(KST 자정) 또는 ordersheet confirmDate. NULL 이면 미확정.';
