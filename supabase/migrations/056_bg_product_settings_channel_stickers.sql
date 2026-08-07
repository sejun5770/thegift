-- ============================================
-- 056_bg_product_settings_channel_stickers.sql
--
-- 채널 고정 스티커를 별도 컬럼으로 분리한다.
--
-- 배경 (운영 지적 2026-08-07 — 054 의 구멍):
--   054 로 한 상품이 여러 채널을 가질 수 있게 했는데, 스티커는 여전히
--   available_sticker_ids 하나뿐이다. 그런데 이 컬럼은 고객 주문화면이
--   "고객이 고를 수 있는 스티커 목록" 으로 그대로 내려준다 (api.js 의 stickersByProduct).
--   조회 키가 product_code 뿐이라 채널을 구분하지 않는다.
--   → 같은 코드 행에 쿠팡 스티커를 넣으면 바른손카드 고객 화면에 쿠팡 스티커가 노출된다.
--
-- 해결:
--   쿠팡은 고객이 고르는 것이 아니라 정해진 스티커가 반드시 붙어 나간다.
--   그러니 '선택 목록' 에 넣을 것이 아니라 '채널별 고정 스티커' 로 따로 둔다.
--     available_sticker_ids  = 고객이 고르는 목록 (자사 주문화면 전용, 손대지 않는다)
--     channel_stickers       = {"coupang": "TGCP01S1"} 채널별 고정 스티커 코드
--
--   고객 화면 코드는 그대로 두면 되고(= 쿠팡 스티커가 샐 일이 없다),
--   쿠팡 주문 수집 시 이 값을 스티커로 자동 지정한다.
-- ============================================

ALTER TABLE bg_product_settings
  ADD COLUMN IF NOT EXISTS channel_stickers JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN bg_product_settings.channel_stickers IS
  '채널별 고정 스티커 코드 {"coupang":"TGCP01S1"} — 고객이 고르지 않고 반드시 붙는 스티커. '
  'available_sticker_ids(고객 선택 목록)와 분리해 자사 주문화면에 다른 채널 스티커가 노출되지 않게 한다';
