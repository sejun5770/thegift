-- ============================================
-- 058_rg_order_lines_seller_product_id.sql
--
-- 주문 라인에 쿠팡 등록상품ID 를 함께 남긴다.
--
-- 배경 (운영 요청 2026-08-07):
--   로켓그로스 주문 단위 목록에 내부 상품코드와 스티커코드를 함께 보고 싶다.
--   매핑(057)은 옵션ID 와 등록상품ID 둘 다로 걸 수 있는데, 지금 라인에는 옵션ID
--   (vendor_item_id) 만 있어 등록상품ID 로 건 매핑을 찾을 수 없었다.
--
--   두 리포트 모두 '등록상품 ID' 열을 갖고 있으니 함께 저장한다.
--   내부코드·스티커코드 자체는 저장하지 않는다 — 상품설정이 바뀌면 따라가야 하므로
--   조회 시점에 매핑해서 내려준다 (주문조회의 상품코드 치환과 같은 방식).
-- ============================================

ALTER TABLE coupang_rg_order_lines
  ADD COLUMN IF NOT EXISTS seller_product_id TEXT;

CREATE INDEX IF NOT EXISTS idx_rg_lines_seller_product
  ON coupang_rg_order_lines (seller_product_id);

COMMENT ON COLUMN coupang_rg_order_lines.seller_product_id IS
  '쿠팡 등록상품ID — 내부 상품코드/스티커 매핑(057) 조회용. 옵션ID 매핑이 우선이고 이건 폴백';
