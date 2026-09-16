-- ============================================
-- 060_bg_product_settings_channel_sales_units.sql
--
-- 채널별 판매단위 — 같은 물건이 채널마다 다른 묶음으로 팔린다.
--
-- 배경 (운영 지적 2026-08-07):
--   메이플호두정과가 자사몰은 1개 단위, 쿠팡은 10개 단위로 팔린다.
--   지금은 쿠팡 수집 코드가 상품명에서 세트 수량을 뽑아 곱한다
--   (coupang/sync.js 의 extractSetSize → item_count = 장바구니수량 × 세트크기).
--   이름에 "10세트" 같은 표기가 없거나 형식이 바뀌면 조용히 1 로 떨어져,
--   주문 수량과 재고 차감이 어긋나도 아무도 모른다.
--
--   설정으로 명시하면 이름 파싱에 기대지 않게 되고, 두 값이 어긋날 때 드러난다.
--   설정값이 있으면 그것을 쓰고, 없으면 기존 이름 파싱으로 폴백한다 (기존 동작 보존).
--
--   로켓그로스 목록은 리포트의 '판매수량'(=주문수량)을 그대로 쓰고 있어,
--   이 값으로 상품수량(= 주문수량 × 판매단위)을 따로 계산해 나란히 보여준다.
-- ============================================

ALTER TABLE bg_product_settings
  ADD COLUMN IF NOT EXISTS channel_sales_units JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN bg_product_settings.channel_sales_units IS
  '채널별 판매단위 {"coupang":10} — 그 채널에서 1 주문이 실제 상품 몇 개인지. '
  '미지정이면 상품명 파싱(extractSetSize)으로 폴백';
