-- ============================================
-- 036_create_bg_site_settings.sql
--
-- bg_site_settings — 사이트 공통 설정 (id=1 singleton row).
--
-- 목적:
--   고객 order-info 페이지 STEP 1 안내 박스에 노출할 공통 텍스트를 상품마다
--   개별 관리하지 않고 사이트 전체에 하나로 관리. 관리자가 GNB 설정 페이지에서
--   한 번 저장하면 모든 상품에 자동 적용.
--
--   상품별 커스텀 (custom_guide_text/title in bg_product_settings, migration 034/035)
--   이 지정된 경우엔 상품별이 우선. 없으면 이 공통 값 사용.
--
-- 컬럼:
--   id                  BIGINT PRIMARY KEY DEFAULT 1  — singleton constraint (CHECK id=1)
--   custom_guide_title  TEXT  — 안내 박스 타이틀. NULL 이면 '커스텀 안내' 폴백.
--   custom_guide_text   TEXT  — 안내 박스 본문. NULL 이면 기본 FAQ 폴백.
--   updated_at          TIMESTAMPTZ
--   updated_by          TEXT  — admin user email
-- ============================================

CREATE TABLE IF NOT EXISTS bg_site_settings (
  id                  BIGINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  custom_guide_title  TEXT,
  custom_guide_text   TEXT,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by          TEXT
);

-- singleton row 사전 삽입 — GET 이 항상 성공하도록.
INSERT INTO bg_site_settings (id) VALUES (1)
ON CONFLICT (id) DO NOTHING;

-- 2026-10-30 이후 Supabase 신규 테이블 default behavior 대응
GRANT ALL ON TABLE bg_site_settings TO anon, authenticated, service_role;

COMMENT ON TABLE bg_site_settings IS '사이트 공통 설정 — id=1 singleton. 고객 order-info STEP 1 공통 안내 등.';
COMMENT ON COLUMN bg_site_settings.custom_guide_title IS '공통 안내 박스 타이틀. NULL 이면 기본 ''커스텀 안내''.';
COMMENT ON COLUMN bg_site_settings.custom_guide_text IS '공통 안내 박스 본문. NULL 이면 기본 FAQ.';
