-- ============================================
-- 034_add_custom_guide_text.sql
--
-- bg_product_settings 에 고객 페이지 커스텀 안내 텍스트 컬럼 추가.
--
-- 배경:
--   고객 order-info 페이지 STEP 1 (미니카드/스티커 선택) 상단에 기본 FAQ
--   ("Q. 부착돼서 배송되나요?" 등 4개) 가 하드코딩. 상품별로 안내 내용이
--   다르면 반영이 어려움. 관리자가 상품마다 자유롭게 안내 문구를 입력할
--   수 있게 자유 텍스트 컬럼 신설.
--
-- 컬럼:
--   custom_guide_text  Markdown-lite / plain text (개행 유지). NULL 이면 기본
--                       FAQ 를 그대로 표시. 값 있으면 그 텍스트로 대체.
--
-- 기존 rows 는 NULL — 서비스 영향 없음 (forward-only).
-- ============================================

ALTER TABLE bg_product_settings
  ADD COLUMN IF NOT EXISTS custom_guide_text TEXT;

COMMENT ON COLUMN bg_product_settings.custom_guide_text IS '고객 order-info 페이지 STEP 1 상단 안내 텍스트 — 관리자 자유 입력. NULL 이면 기본 FAQ 표시.';
