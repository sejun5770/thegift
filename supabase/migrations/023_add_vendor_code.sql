-- ============================================
-- bg_vendors: 거래처코드 (vendor_code) 컬럼 추가
--
-- 운영자가 거래처별로 자체 부여한 식별 코드. ERP/회계/세금계산서 등 외부 시스템 연동용.
-- 예: 'V001', 'BARUN_FARM', 'COMP-2024-A' 등 자유 형식.
--
-- 중복 허용 안함 — 단, NULL/빈문자열은 허용 (코드 없는 거래처도 등록 가능).
-- ============================================

ALTER TABLE bg_vendors
  ADD COLUMN IF NOT EXISTS vendor_code TEXT DEFAULT NULL;

-- 빈 문자열은 NULL 로 통일 — UNIQUE 제약이 빈 문자열 중복 허용 안함 회피
-- (admin UI 도 trim 후 빈 문자열 입력 시 NULL 저장)
CREATE UNIQUE INDEX IF NOT EXISTS uq_bg_vendors_code
  ON bg_vendors (vendor_code)
  WHERE vendor_code IS NOT NULL;

COMMENT ON COLUMN bg_vendors.vendor_code IS '거래처 식별 코드 (ERP/회계 연동용, 자유 형식). NULL 허용, 중복 불가.';
