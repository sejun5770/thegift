-- ============================================
-- BG_PRODUCT_SETTINGS: 데코레이션(decoration) 라벨 컬럼 추가
-- 답례품 상품설정 저장 시 발생하던 오류 해결:
--   PGRST204 - Could not find the 'decoration_label' column
--   of 'bg_product_settings' in the schema cache
-- 상품설정 저장 페이로드에 포함되는 decoration_label 값을
-- 저장할 수 있도록 컬럼을 추가한다. (멱등성 보장)
-- ============================================

ALTER TABLE bg_product_settings
  ADD COLUMN IF NOT EXISTS decoration_label VARCHAR(500);

-- PostgREST 스키마 캐시 갱신 (Supabase에서 새 컬럼을 즉시 인식하도록)
NOTIFY pgrst, 'reload schema';
