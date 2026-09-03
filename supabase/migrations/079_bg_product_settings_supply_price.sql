-- ============================================
-- 079_bg_product_settings_supply_price.sql
--
-- 제휴 채널 공급단가 (요청 2026-09-03, 웅진 매출 반영).
--
-- 웅진처럼 API 연동이 없는 제휴 채널은 주문이 주문수집 스프레드시트에만 남는다.
-- 시트에는 품목코드·수량만 있고 금액이 없어 매출을 만들 수 없었다.
-- 제휴사가 우리에게 지불하는 공급가를 상품마다 적어 두고, 그 값으로 매출을 세운다.
--
-- unit_cost(원가)·inbound_unit_cost(매입원가) 와는 다른 값이다 —
-- 이건 '우리가 받는 금액'이라 매출의 근거가 된다.
-- 미입력(NULL)이면 그 상품의 제휴 주문은 매출을 만들지 않고 건너뛴다 (0원으로 넣지 않는다).
-- ============================================

ALTER TABLE bg_product_settings
  ADD COLUMN IF NOT EXISTS supply_price INTEGER;

COMMENT ON COLUMN bg_product_settings.supply_price IS
  '제휴 채널 공급단가 (웅진 등) — 제휴사가 지불하는 개당 금액. NULL=미설정(매출 생성 안 함)';
