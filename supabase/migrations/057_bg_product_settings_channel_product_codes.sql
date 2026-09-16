-- ============================================
-- 057_bg_product_settings_channel_product_codes.sql
--
-- 채널 상품코드 매핑 — 쿠팡 등록상품ID(11자리) ↔ 내부 상품코드.
--
-- 배경 (운영 요청 2026-08-07):
--   주문조회 답례품에서 쿠팡 주문의 상품코드가 전부 11자리 숫자로 보인다.
--   coupang_orders.product_code 에 쿠팡 sellerProductId 가 그대로 들어가기 때문
--   (coupang/sync.js 의 normalizeOrderSheet). 사람이 읽을 수 없고 자사 코드와도 안 맞는다.
--
-- 설계:
--   내부 상품설정 행에 그 상품의 채널 코드를 담는다.
--     {"coupang": ["16281105078", "16191414384"]}
--   한 내부코드에 쿠팡 등록상품이 여러 개일 수 있어 배열로 둔다.
--
--   매핑은 '조회 시점' 에 적용한다 (동기화 시점 아님):
--     · 이미 쌓인 주문도 재동기화 없이 즉시 내부코드로 보인다
--     · 매핑을 고치면 과거 주문 표시도 함께 바로잡힌다
--     · 원본 쿠팡 코드는 지우지 않고 별도 필드로 함께 내려 추적이 끊기지 않는다
-- ============================================

ALTER TABLE bg_product_settings
  ADD COLUMN IF NOT EXISTS channel_product_codes JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN bg_product_settings.channel_product_codes IS
  '채널 상품코드 매핑 {"coupang":["16281105078"]} — 채널이 쓰는 코드를 이 내부 상품코드로 읽어들인다. '
  '주문 조회 시점에 치환하므로 기존 주문도 재동기화 없이 반영된다';

-- 역방향 조회(쿠팡코드 → 내부코드)를 위해 GIN
CREATE INDEX IF NOT EXISTS idx_bg_ps_channel_product_codes
  ON bg_product_settings USING GIN (channel_product_codes);
