-- ============================================
-- 070_create_coupang_rg_unit_plan.sql
--
-- 로켓그로스 판매단위 기획 — 아직 존재하지 않는 판매단위를 설계하고 마진을 시뮬레이션한다.
--
-- 배경 (운영 요청 2026-08-19):
--   "호두정과 / 판매단위 10개, 호두정과 / 판매단위 5개, 레몬즙 / 1개·3개·5개" 처럼
--   행을 직접 추가해 판매단위별 마진을 비교하고 싶다.
--   원가·입고비는 낱개(상품 1개) 기준으로 입력하고, 풀필먼트 비용은 주문건당 부과되며
--   그 상품의 기존 정산 실적에서 기본값을 가져온다.
--
-- 왜 069(coupang_rg_margin_sim) 로 안 되는가:
--   069 의 PK 는 vendor_item_id(옵션ID)다. "호두정과 5개" 는 아직 쿠팡에 등록되지 않아
--   옵션ID 자체가 없다 — 069 의 키로는 표현할 수 없는 개념이다.
--   069 = 실재하는 옵션의 실적 검증, 070 = 아직 없는 판매단위의 설계. 역할이 갈린다.
--
-- ── 단위 규약 (열 이름·화면 라벨·이 COMMENT 세 곳이 같아야 한다) ──
--   sales_unit    낱개 / 판매단위 1개      (10개 묶음이면 10)
--   price         원 / 주문 1건            (= 판매단위 1개를 파는 가격)
--   unit_cost     원 / 상품 1개(낱개)      ← sales_unit 을 곱해야 주문 원가가 된다
--   inbound_cost  원 / 상품 1개(낱개)      ← 위와 같음
--   inout_fee     원 / 판매단위 1개        ← 곱하지 않는다 (한 주문에 2개면 2배 청구되지만
--                                            이 표는 주문 1건 = 판매단위 1개를 모델링한다)
--   ship_fee      원 / 배송건 1건          ← 곱하지 않는다 (실측: 수량 1→2 여도 동일)
--   etc_cost      원 / 주문 1건
--   deduct_rate   매출 대비 차감율 (판매수수료+VAT 및 쿠팡 할인 분담 등 정산 차감 전체)
--
-- 마진 = price(공급가 환산) − price×deduct_rate(공급가 환산) − (inout+ship+etc)
--        − (unit_cost + inbound_cost) × sales_unit
--
-- ⚠ 부가세: 쿠팡 판매가와 판매수수료는 VAT 포함, 물류비(055)와 원가(068)는 VAT 별도다.
--   섞어서 빼면 마진이 과대 계산된다(실측 예: 6,475원 → 실제 4,452원). 그래서 계산 기준을
--   행마다 남긴다. price_vat_included=true 면 price 와 수수료를 (1+vat_rate) 로 나눠
--   공급가 기준으로 통일한 뒤 VAT 별도인 원가·물류비와 뺀다.
-- ============================================

CREATE TABLE IF NOT EXISTS coupang_rg_unit_plan (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 상품 — 내부 상품코드가 있으면 그것으로, 없으면 이름만으로도 행을 만들 수 있다(신상품 기획)
  product_code       TEXT,
  product_name       TEXT NOT NULL,
  sales_unit         INTEGER NOT NULL DEFAULT 1,
  plan_label         TEXT NOT NULL DEFAULT '기본안',   -- 같은 판매단위의 여러 가격안 비교용

  -- 입력값 (단위는 위 규약 참조)
  price              NUMERIC(12, 2),
  unit_cost          NUMERIC(12, 2),
  inbound_cost       NUMERIC(12, 2),
  inout_fee          NUMERIC(12, 2),
  ship_fee           NUMERIC(12, 2),
  etc_cost           NUMERIC(12, 2) NOT NULL DEFAULT 0,
  deduct_rate        NUMERIC(6, 4),
  target_margin_rate NUMERIC(6, 4),

  -- 부가세 처리 기준 — 나중에 숫자를 다시 볼 때 무슨 기준이었는지 알아야 한다
  vat_rate           NUMERIC(4, 3) NOT NULL DEFAULT 0.1,
  price_vat_included BOOLEAN NOT NULL DEFAULT TRUE,

  -- 풀필먼트 기본값의 출처. 숫자만 남기면 "이 1,650원이 어디서 왔나" 에 답할 수 없다
  fulfill_basis      TEXT,
  fulfill_estimated  BOOLEAN NOT NULL DEFAULT FALSE,   -- 유료 청구 실적이 없어 추정값을 채운 경우

  memo               TEXT,
  sort_order         INTEGER NOT NULL DEFAULT 0,
  updated_by         TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT rg_plan_unit_chk   CHECK (sales_unit >= 1),
  CONSTRAINT rg_plan_deduct_chk CHECK (deduct_rate IS NULL OR (deduct_rate >= 0 AND deduct_rate < 1)),
  CONSTRAINT rg_plan_target_chk CHECK (target_margin_rate IS NULL OR (target_margin_rate > -1 AND target_margin_rate < 1)),
  CONSTRAINT rg_plan_vat_chk    CHECK (vat_rate >= 0 AND vat_rate < 1)
);

-- 중복 방지 키를 생성 컬럼으로 물질화한다.
--   PostgREST 의 on_conflict 는 컬럼명만 받고 표현식 인덱스를 추론하지 못하므로,
--   069 와 같은 upsert 관용구(?on_conflict=plan_key)를 쓰려면 실제 컬럼이어야 한다.
ALTER TABLE coupang_rg_unit_plan
  ADD COLUMN IF NOT EXISTS plan_key TEXT
  GENERATED ALWAYS AS (
    COALESCE(NULLIF(btrim(product_code), ''), '이름:' || btrim(product_name))
    || '|' || sales_unit::text
    || '|' || btrim(plan_label)
  ) STORED;

CREATE UNIQUE INDEX IF NOT EXISTS rg_plan_key_uniq ON coupang_rg_unit_plan (plan_key);
CREATE INDEX IF NOT EXISTS idx_rg_plan_product ON coupang_rg_unit_plan (product_code);

COMMENT ON TABLE  coupang_rg_unit_plan IS
  '로켓그로스 판매단위 기획 — 아직 없는 판매단위를 설계해 마진을 비교한다. 069(실재 옵션 실적 검증)와 역할이 다르다';
COMMENT ON COLUMN coupang_rg_unit_plan.sales_unit   IS '판매단위 — 이 1주문에 들어가는 상품 낱개 수 (10개 묶음이면 10)';
COMMENT ON COLUMN coupang_rg_unit_plan.price        IS '판매가 (원/주문 1건). 쿠팡지원할인 차감 후 매출인식액 기준 — 상세페이지 표시가가 아니다';
COMMENT ON COLUMN coupang_rg_unit_plan.unit_cost    IS '원가 (원/상품 1개, VAT 별도). 마진 계산 시 sales_unit 을 곱한다';
COMMENT ON COLUMN coupang_rg_unit_plan.inbound_cost IS '입고 부대비 (원/상품 1개, VAT 별도). 마진 계산 시 sales_unit 을 곱한다';
COMMENT ON COLUMN coupang_rg_unit_plan.inout_fee    IS '입출고비 (원/판매단위 1개, VAT 별도). sales_unit 을 곱하지 않는다';
COMMENT ON COLUMN coupang_rg_unit_plan.ship_fee     IS '배송비 (원/배송건 1건, VAT 별도). 실측상 수량 1→2 여도 동일하므로 곱하지 않는다';
COMMENT ON COLUMN coupang_rg_unit_plan.etc_cost     IS '기타 주문당 비용 (원/주문 1건, VAT 별도)';
COMMENT ON COLUMN coupang_rg_unit_plan.deduct_rate  IS '매출 대비 정산 차감율 — 판매수수료+VAT 뿐 아니라 쿠팡 할인 분담 등 정산에서 빠지는 전체';
COMMENT ON COLUMN coupang_rg_unit_plan.vat_rate     IS '부가세율. price_vat_included 와 함께 공급가 기준 통일에 쓴다';
COMMENT ON COLUMN coupang_rg_unit_plan.fulfill_basis IS '풀필먼트 기본값의 산출 근거 문자열 (대표 옵션·표본 건수·기간)';
COMMENT ON COLUMN coupang_rg_unit_plan.fulfill_estimated IS 'true = 유료 청구 실적이 없어 채널 추정값을 채운 행';
COMMENT ON COLUMN coupang_rg_unit_plan.plan_key     IS '(상품, 판매단위, 안 이름) 중복 방지 — PostgREST upsert 대상';

GRANT ALL ON TABLE coupang_rg_unit_plan TO anon, authenticated, service_role;
