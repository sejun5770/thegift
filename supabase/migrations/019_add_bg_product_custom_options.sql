-- ============================================
-- bg_product_settings: 자유 옵션 그룹 (custom_options) 컬럼 추가
--
-- 배경: 신상품 (수건 등) 에 박스/스티커 외에 '수건 색상', '고리수건 타입' 등 다양한
--   옵션 추가가 필요. 매번 ALTER 로 컬럼 추가하기보다 generic 구조로 정착.
--
-- 스키마: { "옵션그룹명": [{ code, name, preview_image_url, sold_out, color? }, ...] }
--
-- 예:
--   {
--     "수건 색상": [
--       {"code":"TWL_WHT","name":"화이트","color":"#FFFFFF","preview_image_url":"https://...","sold_out":false},
--       {"code":"TWL_PNK","name":"핑크","color":"#FECACA","preview_image_url":"https://...","sold_out":false}
--     ],
--     "고리수건 타입": [
--       {"code":"LOOP_A","name":"걸이형","preview_image_url":"https://...","sold_out":false},
--       {"code":"LOOP_B","name":"기본형","preview_image_url":"https://...","sold_out":false}
--     ]
--   }
--
-- 빈 객체({}) 또는 NULL 이면 고객 화면에 옵션 UI 미노출.
-- 옵션 선택은 sticker_selections[i].custom_options 에 { "옵션그룹명": "선택된code", ... } 형태로 저장.
-- ============================================

ALTER TABLE bg_product_settings
  ADD COLUMN IF NOT EXISTS custom_options JSONB DEFAULT '{}'::jsonb;

COMMENT ON COLUMN bg_product_settings.custom_options IS
  '자유 옵션 그룹 — {"옵션그룹명": [{code, name, preview_image_url, sold_out, color?}, ...]}. 빈 객체면 UI 미노출.';
