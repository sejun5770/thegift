-- ============================================
-- 035_add_custom_guide_title.sql
--
-- bg_product_settings 에 고객 안내 박스 타이틀 컬럼 추가.
--
-- 배경:
--   Migration 034 로 안내 본문 (custom_guide_text) 는 관리자가 자유 입력.
--   타이틀은 여전히 하드코딩 ('스티커 안내') → 상품에 따라 '미니카드 안내',
--   '제품 안내' 등 다른 라벨을 원할 수 있음. 타이틀도 별도 자유 입력.
--
-- 컬럼:
--   custom_guide_title  TEXT — NULL 이면 기본 '스티커 안내' 폴백.
--
-- 기존 rows 는 NULL — 서비스 영향 없음 (forward-only).
-- ============================================

ALTER TABLE bg_product_settings
  ADD COLUMN IF NOT EXISTS custom_guide_title TEXT;

COMMENT ON COLUMN bg_product_settings.custom_guide_title IS '고객 order-info 페이지 STEP 1 안내 박스 타이틀 — 관리자 자유 입력. NULL 이면 기본 ''스티커 안내'' 표시.';
