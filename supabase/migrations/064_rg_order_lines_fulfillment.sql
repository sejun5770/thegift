-- ============================================
-- 064_rg_order_lines_fulfillment.sql
--
-- 정산 리포트 라인의 판매 방식 구분.
--
-- 배경 (운영 확인 2026-08-07):
--   Wing 의 판매 수수료 리포트에는 로켓그로스뿐 아니라 판매자배송 주문도 섞여 있다.
--   그런데 대시보드는 이 표 전체를 '쿠팡 로켓그로스' 채널 매출로 집계한다.
--   판매자배송 주문은 coupang_orders 로도 집계되므로 같은 매출이 두 번 잡힌다.
--
--   062 로 로켓그로스 주문을 따로 표시하게 됐으니, 그걸 근거로 라인을 가른다.
--
-- 값:
--   'rocket_growth' — coupang_orders 에 로켓그로스로 들어와 있다
--   'seller'        — coupang_orders 에 판매자배송으로 들어와 있다 (쿠팡 채널에서 이미 집계)
--   NULL            — coupang_orders 에 그 주문이 없어 판단 불가.
--                     기존 동작대로 로켓그로스 매출에 포함한다 (빼면 매출이 통째로 사라진다).
--                     로켓그로스 주문 수집을 그 기간까지 돌리면 채워진다.
-- ============================================

ALTER TABLE coupang_rg_order_lines
  ADD COLUMN IF NOT EXISTS fulfillment TEXT;

CREATE INDEX IF NOT EXISTS idx_coupang_rg_lines_fulfillment
  ON coupang_rg_order_lines (fulfillment);

COMMENT ON COLUMN coupang_rg_order_lines.fulfillment IS
  '판매 방식 — rocket_growth / seller / NULL(미확인). seller 는 쿠팡 채널에서 이미 집계되므로 로켓그로스 매출에서 뺀다';
