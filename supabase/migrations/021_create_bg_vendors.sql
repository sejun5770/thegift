-- ============================================
-- bg_vendors: 위탁업체(거래처) 마스터
--
-- 답례품 상품을 외부 거래처에서 위탁받아 판매하는 케이스 관리.
-- 한 상품 = 한 거래처 (1:1 가정 — 추후 N:N 필요시 별도 매핑 테이블).
-- 거래처 단위 default 수수료율 + 상품 단위 override 모델.
--
-- 정산 흐름:
--   1) admin 이 거래처 등록 + 상품 매핑
--   2) 주문 발생 → 정보입력 (희망출고일 확정)
--   3) 위탁 정산 페이지에서 희망출고일 기준 정산 처리 (별도 bg_vendor_settlement_marks 테이블)
-- ============================================

CREATE TABLE IF NOT EXISTS bg_vendors (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                     TEXT NOT NULL UNIQUE,        -- 거래처명 (예: '바른팜', '○○제과')
  contact_person           TEXT,                        -- 담당자 이름
  phone                    TEXT,                        -- 담당자 연락처
  email                    TEXT,                        -- 정산 메일 수신처
  default_commission_rate  NUMERIC(5,2) DEFAULT 0,      -- 기본 수수료율 (%) — 상품에 미설정 시 적용
  memo                     TEXT,                        -- 비고 (결제조건, 정산주기 등)
  is_active                BOOLEAN NOT NULL DEFAULT TRUE,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bg_vendors_active ON bg_vendors (is_active, name);

COMMENT ON TABLE bg_vendors IS '위탁업체(거래처) 마스터 — 답례품 위탁 매입 관리';
COMMENT ON COLUMN bg_vendors.default_commission_rate IS '기본 수수료율 (%) — bg_product_settings.commission_rate 가 NULL 이면 이 값 적용';

-- bg_product_settings 에 vendor 매핑 + 상품 단위 수수료율 override 추가
ALTER TABLE bg_product_settings
  ADD COLUMN IF NOT EXISTS vendor_id        UUID REFERENCES bg_vendors(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS commission_rate  NUMERIC(5,2) DEFAULT NULL;

COMMENT ON COLUMN bg_product_settings.vendor_id IS '위탁 거래처 — NULL 이면 자체 매입 상품 (위탁 아님)';
COMMENT ON COLUMN bg_product_settings.commission_rate IS '상품 단위 수수료율 (%) — NULL 이면 vendor.default_commission_rate 적용';

CREATE INDEX IF NOT EXISTS idx_bg_product_settings_vendor ON bg_product_settings (vendor_id) WHERE vendor_id IS NOT NULL;

-- 2026-10-30 이후 Supabase 신규 테이블 default behavior 대응 (memory: supabase_public_grant_policy)
GRANT ALL ON TABLE bg_vendors TO anon, authenticated, service_role;
