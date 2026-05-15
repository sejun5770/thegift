-- 쿠팡 로켓 그로스 (RFM, 판매자로켓) 매출 — 일별 × 상품 단위 aggregate
--
-- 일반 ordersheets 와 다르게 주문번호 단위가 아닌 일별 매출 보고서 형태로 제공됨.
-- 정보입력현황 / 주문조회에는 노출 X — 대시보드 매출 합산만 적용.

CREATE TABLE IF NOT EXISTS coupang_rocket_growth_sales (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_date       DATE NOT NULL,                           -- 매출 발생일 (KST)
  vendor_item_id  TEXT,                                    -- 옵션 단위 (NULL 가능)
  product_id      TEXT,                                    -- 상품 ID (NULL 가능)
  product_name    TEXT,                                    -- 상품명
  sales_qty       INTEGER NOT NULL DEFAULT 0,              -- 판매 수량
  sales_amount    NUMERIC NOT NULL DEFAULT 0,              -- 판매 금액 (정가 합)
  refund_qty      INTEGER NOT NULL DEFAULT 0,              -- 환불 수량
  refund_amount   NUMERIC NOT NULL DEFAULT 0,              -- 환불 금액
  net_amount      NUMERIC GENERATED ALWAYS AS (sales_amount - refund_amount) STORED, -- 순 매출
  raw_payload     JSONB,                                   -- API 원본 (재처리용)
  fetched_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT rg_sales_unique UNIQUE (sale_date, vendor_item_id)
);

CREATE INDEX IF NOT EXISTS idx_rg_sales_sale_date ON coupang_rocket_growth_sales (sale_date DESC);
CREATE INDEX IF NOT EXISTS idx_rg_sales_product_id ON coupang_rocket_growth_sales (product_id);

-- sync state — 마지막 동기화 시각/범위 추적
CREATE TABLE IF NOT EXISTS coupang_rocket_growth_sync_state (
  id                INTEGER PRIMARY KEY DEFAULT 1,
  last_synced_at    TIMESTAMPTZ,
  last_synced_from  DATE,
  last_synced_to    DATE,
  last_error        TEXT,
  last_rows_count   INTEGER DEFAULT 0,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT rg_sync_single_row CHECK (id = 1)
);

INSERT INTO coupang_rocket_growth_sync_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

ALTER TABLE coupang_rocket_growth_sales ENABLE ROW LEVEL SECURITY;
ALTER TABLE coupang_rocket_growth_sync_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rg_sales_select ON coupang_rocket_growth_sales;
CREATE POLICY rg_sales_select ON coupang_rocket_growth_sales FOR SELECT USING (true);
DROP POLICY IF EXISTS rg_sync_select ON coupang_rocket_growth_sync_state;
CREATE POLICY rg_sync_select ON coupang_rocket_growth_sync_state FOR SELECT USING (true);
-- 쓰기는 server (service key) 만
