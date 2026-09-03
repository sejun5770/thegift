-- ============================================
-- bg_product_settings.allow_logo_upload — 고객 로고 첨부 허용 게이트
--
-- 배경:
--   답례품 스티커에 고객사 로고 (회사 로고/캐릭터/문구 이미지) 인쇄 요구가 증가.
--   다만 모든 상품이 로고 인쇄 가능한 것은 아님 — 소량/저가/스티커 미부착 상품 제외.
--   상품설정에서 명시적으로 켠 상품만 고객 화면에 '로고 첨부' 옵션 노출.
--
-- 정책:
--   FALSE (default): 기존 동작 — 샘플문구 / 직접입력 / 입력안함 3택
--   TRUE          : 위 3택 + '로고 첨부' 옵션 추가 노출 → 고객이 PNG/JPG 업로드
--
-- 저장 위치:
--   파일 자체: Supabase Storage 버킷 'bg-customer-logos' (운영자가 별도 생성)
--   메타데이터: bg_order_customer_info.sticker_selections[i] 의 logo_url/logo_filename/logo_size
-- ============================================

ALTER TABLE bg_product_settings
  ADD COLUMN IF NOT EXISTS allow_logo_upload BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN bg_product_settings.allow_logo_upload IS
  '고객이 스티커에 로고 (PNG/JPG, ≤5MB) 를 첨부할 수 있는지 여부. true 면 order-info 스티커 입력 모드에 ''로고 첨부'' 옵션 노출.';
