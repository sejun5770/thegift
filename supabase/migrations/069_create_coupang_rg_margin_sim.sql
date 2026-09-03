-- ============================================
-- 069_create_coupang_rg_margin_sim.sql
--
-- 로켓그로스 판매단위별 마진 시뮬레이션 저장값.
--
-- 배경 (운영 요청 2026-08-19):
--   로켓그로스 탭의 마진 시뮬레이션은 판매가·원가·입고비를 바꿔 마진을 보는 화면인데,
--   가정치가 새로고침하면 사라져 여러 상품을 놓고 비교·검토할 수 없었다.
--   판매단위별로 저장해 두고 스프레드시트로도 내려받을 수 있어야 한다.
--
-- 왜 bg_product_settings 가 아닌가:
--   가정치는 '판매단위(옵션ID)' 단위다. 같은 상품이라도 10개묶음과 낱개는 옵션ID 가 다르고
--   판매가도 다르다. 상품 단위 테이블에 넣으면 그 구분이 사라진다.
--   원가·입고비의 정본은 계속 bg_product_settings.unit_cost / inbound_unit_cost 다 (068).
--   여기 unit_cost / inbound_unit_cost 는 그 판매단위에서만 달리 가정하고 싶을 때의 override 이고
--   NULL 이면 상품설정 값을 그대로 쓴다.
--
-- 값 의미:
--   sim_price          시뮬 판매가 (판매단위 1개당). NULL = 실적 평균단가 사용
--   sim_unit_cost      시뮬 원가 (상품 1개당). NULL = 상품설정 값
--   sim_inbound_cost   시뮬 입고비 (상품 1개당). NULL = 상품설정 값
--   target_margin_rate 목표 마진율 (0~1). 있으면 그 마진율이 되는 판매가를 화면에서 역산해 보여준다
--   memo               검토 메모 (예: '9월 프로모션 안')
-- ============================================

CREATE TABLE IF NOT EXISTS coupang_rg_margin_sim (
  vendor_item_id     TEXT PRIMARY KEY,           -- 옵션ID = 쿠팡 판매단위
  seller_product_id  TEXT,                       -- 등록상품ID (참고)
  internal_product_code TEXT,                    -- 저장 시점의 우리 상품코드 (참고 — 매핑은 조회 시 다시 붙는다)
  product_name       TEXT,                       -- 저장 시점의 상품명 (참고)
  sim_price          NUMERIC(12, 2),
  sim_unit_cost      NUMERIC(12, 2),
  sim_inbound_cost   NUMERIC(12, 2),
  target_margin_rate NUMERIC(6, 4),
  memo               TEXT,
  updated_by         TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT rg_margin_sim_target_chk CHECK (target_margin_rate IS NULL OR (target_margin_rate >= -1 AND target_margin_rate < 1))
);

COMMENT ON TABLE  coupang_rg_margin_sim IS '로켓그로스 판매단위(옵션ID)별 마진 시뮬레이션 가정치. NULL 컬럼은 실적/상품설정 값을 그대로 쓴다';
COMMENT ON COLUMN coupang_rg_margin_sim.sim_price          IS '시뮬 판매가 (판매단위 1개당). NULL = 실적 평균단가';
COMMENT ON COLUMN coupang_rg_margin_sim.sim_unit_cost      IS '시뮬 원가 (상품 1개당) override. NULL = bg_product_settings.unit_cost';
COMMENT ON COLUMN coupang_rg_margin_sim.sim_inbound_cost   IS '시뮬 입고비 (상품 1개당) override. NULL = bg_product_settings.inbound_unit_cost';
COMMENT ON COLUMN coupang_rg_margin_sim.target_margin_rate IS '목표 마진율 (0.25 = 25%). 있으면 필요한 판매가를 역산해 보여준다';

GRANT ALL ON TABLE coupang_rg_margin_sim TO anon, authenticated, service_role;
