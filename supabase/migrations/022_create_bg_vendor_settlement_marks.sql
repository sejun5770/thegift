-- ============================================
-- bg_vendor_settlement_marks: 위탁업체 정산 처리 기록
--
-- 디자인 정책: hybrid 모델
--   · 매출/수량/수수료 등은 매번 join 으로 on-demand 계산 (MSSQL + bg_order_customer_info + bg_product_settings)
--   · '정산 처리됨' 마커만 별도 테이블에 기록 → 데이터 일관성 자동 보장 + 신뢰 가능
--   · 1주문 × 1상품 = 1 마커 (multi-product 주문이면 N개의 마커)
--   · 정산 기준일 = 희망 출고일 (desired_ship_date)
--
-- 운영 흐름:
--   1) 정산 페이지에서 vendor / 기간 (희망출고일 기준) / 정산상태 필터로 조회
--   2) 미정산 row 의 "정산처리" 버튼 → INSERT into bg_vendor_settlement_marks
--   3) 정산취소 → DELETE (또는 settled_at = NULL)
-- ============================================

CREATE TABLE IF NOT EXISTS bg_vendor_settlement_marks (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id          UUID NOT NULL REFERENCES bg_vendors(id) ON DELETE RESTRICT,
  order_id           TEXT NOT NULL,                 -- bg_order_customer_info.order_id (ETC-prefix 유지)
  product_code       TEXT NOT NULL,                 -- bg_product_settings.product_id
  desired_ship_date  DATE NOT NULL,                 -- 정산 기준일 (snapshot — 추후 변경되어도 정산 기록은 유지)
  -- 매출 snapshot (정산 시점 기준값. 추후 가격 변경 등 영향 받지 않도록 보존):
  gross_amount       NUMERIC(12,2) NOT NULL DEFAULT 0,  -- 매출 (수수료 차감 전)
  commission_rate    NUMERIC(5,2) NOT NULL DEFAULT 0,   -- 적용된 수수료율 (%)
  commission_amount  NUMERIC(12,2) NOT NULL DEFAULT 0,  -- 수수료 금액
  net_amount         NUMERIC(12,2) NOT NULL DEFAULT 0,  -- 거래처 정산 금액 (= gross - commission)
  qty                INTEGER NOT NULL DEFAULT 0,
  is_copurchase      BOOLEAN NOT NULL DEFAULT FALSE,    -- 청첩장 동시구매 여부 (snapshot)
  settled_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  settled_by         TEXT,                              -- admin user_id
  memo               TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT bg_vsm_unique UNIQUE (order_id, product_code)
);

CREATE INDEX IF NOT EXISTS idx_bg_vsm_vendor_date ON bg_vendor_settlement_marks (vendor_id, desired_ship_date DESC);
CREATE INDEX IF NOT EXISTS idx_bg_vsm_settled_at ON bg_vendor_settlement_marks (settled_at DESC);

COMMENT ON TABLE bg_vendor_settlement_marks IS '위탁업체 정산 처리 기록 — 정산 완료된 (order_id, product_code) 쌍만 기록 (snapshot 형태)';

-- 2026-10-30 이후 Supabase 신규 테이블 default behavior 대응
GRANT ALL ON TABLE bg_vendor_settlement_marks TO anon, authenticated, service_role;
