-- ============================================
-- bg_product_settings: 박스 패키지 옵션 컬럼 추가
--
-- 비타민답례품(TGJSD04), 이코복스(TGIKX01) 등 박스 컬러를 선택할 수 있는
-- 상품에서 관리자가 여러 박스 옵션을 등록해 고객이 선택할 수 있게 함.
--
-- 스키마: 각 옵션 = { code, name, color, preview_image_url, sold_out }
-- 예:
--   [
--     {"code":"TGIKX01B1","name":"블랙","color":"#1F2937",
--      "preview_image_url":"https://.../bg-box-previews/TGIKX01B1.png","sold_out":false},
--     {"code":"TGIKX01B2","name":"화이트","color":"#FFFFFF",
--      "preview_image_url":"https://.../bg-box-previews/TGIKX01B2.png","sold_out":false}
--   ]
--
-- 빈 배열(또는 NULL) 이면 고객 화면에 박스 선택 UI 미노출.
-- ============================================

ALTER TABLE bg_product_settings
  ADD COLUMN IF NOT EXISTS available_box_options JSONB DEFAULT '[]'::jsonb;

COMMENT ON COLUMN bg_product_settings.available_box_options IS
  '박스 패키지 옵션 배열 — [{code, name, color, preview_image_url, sold_out}]. 빈 배열이면 박스 선택 UI 비활성.';
