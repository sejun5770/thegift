-- ============================================
-- 062_coupang_orders_rocket_growth.sql
--
-- 로켓그로스 주문 구분 플래그.
--
-- 배경 (운영 확인 2026-08-07):
--   로켓그로스 주문은 마켓플레이스 주문 API(/openapi/.../ordersheets)로 안 나온다.
--   별도 API(/rg_open_api/.../rg/orders)로만 조회되고, 그래서 coupang_orders 에
--   들어온 적이 없다 → 정보입력현황에 행 자체가 없어 워크플로우를 붙일 곳이 없었다
--   (리포트 763주문 중 761건 미매칭).
--
--   정산 리포트에는 판매자배송 주문도 섞여 있어 리포트만으로는 로켓그로스를 가릴 수 없다.
--   그래서 RG 주문 API 를 정본 목록으로 삼고, 거기서 온 주문에만 이 플래그를 세운다.
--
-- 화면:
--   로켓그로스는 쿠팡이 포장·출고까지 하므로 우리가 할 작업이 없다.
--   포장완료 탭에 섞이면 출고처리 대상으로 오인되므로 '쿠팡창고' 탭으로 따로 모은다.
-- ============================================

ALTER TABLE coupang_orders
  ADD COLUMN IF NOT EXISTS is_rocket_growth BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_coupang_orders_rg
  ON coupang_orders (is_rocket_growth) WHERE is_rocket_growth;

COMMENT ON COLUMN coupang_orders.is_rocket_growth IS
  '로켓그로스 주문 여부 — RG 주문 API 에서 수집한 건만 TRUE. 판매자배송(마켓플레이스)은 FALSE';
