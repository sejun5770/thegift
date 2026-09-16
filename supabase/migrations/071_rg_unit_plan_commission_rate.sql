-- ============================================
-- 071_rg_unit_plan_commission_rate.sql
--
-- 판매단위 기획에 판매수수료율을 따로 입력받는다.
--
-- 배경 (운영 요청 2026-08-19):
--   운영자는 쿠팡 카테고리 수수료율을 알고 있어 그 값을 직접 넣고 싶어 한다.
--   070 에는 deduct_rate(총 차감율) 하나뿐이라, 수수료율을 넣으면 쿠팡 할인 분담 같은
--   그 외 차감이 모델에서 사라지고, 반대로 총 차감율만 두면 "수수료가 얼마인지" 를 볼 수 없다.
--
-- 두 컬럼의 관계:
--   commission_rate  판매수수료율 (판매수수료+VAT ÷ 매출). 운영자가 아는 값.
--   deduct_rate      총 차감율 — 정산에서 실제로 빠지는 전부. 마진 계산은 이 값을 쓴다.
--   차이(deduct_rate − commission_rate) = 쿠팡 할인 분담 등 '그 외 차감'.
--
--   commission_rate 는 화면에 수수료 '금액' 을 보여주고 총 차감과의 차이를 드러내기 위한
--   표시·분해용이다. NULL 이면 분해 없이 총 차감액만 보여준다.
-- ============================================

ALTER TABLE coupang_rg_unit_plan
  ADD COLUMN IF NOT EXISTS commission_rate NUMERIC(6, 4);

ALTER TABLE coupang_rg_unit_plan DROP CONSTRAINT IF EXISTS rg_plan_comm_chk;
ALTER TABLE coupang_rg_unit_plan ADD  CONSTRAINT rg_plan_comm_chk
  CHECK (commission_rate IS NULL OR (commission_rate >= 0 AND commission_rate < 1));

COMMENT ON COLUMN coupang_rg_unit_plan.commission_rate IS
  '판매수수료율 (판매수수료+VAT ÷ 매출). 마진 계산은 deduct_rate 를 쓰고, 이 값은 수수료 금액 표시와 그 외 차감 분해용';
