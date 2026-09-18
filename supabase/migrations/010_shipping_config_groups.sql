-- ============================================
-- 출고일 그룹화 (migration 010)
--
-- 배경: 상품마다 기본 출고 리드타임/컷오프 등이 다를 수 있어, 상품별로 서로
--       다른 출고일 정책을 적용할 수 있도록 bg_shipping_config 를 그룹화.
--       기존 단일 row 구조를 유지하되 name/is_default 필드를 추가해 다중 row
--       허용. 상품은 bg_product_settings.shipping_group_id 로 1:1 매핑.
--
-- 적용:
--   1) bg_shipping_config 에 name(VARCHAR), is_default(BOOLEAN) 컬럼 추가
--   2) 기존 단일 row 를 '기본 그룹' 으로 업데이트 (is_default=true)
--   3) bg_product_settings 에 shipping_group_id(UUID) 컬럼 추가
--      · NULL = 기본 그룹 사용 (backward compat)
--      · FK 는 참조 무결성을 해치지 않기 위해 soft reference (FK constraint 없이)
--   4) is_default=true row 가 항상 정확히 1개 되도록 unique partial index
--
-- 주의:
--   · 기존 코드 (store.getShippingConfig) 는 단일 row 반환 가정 — 이번 마이그
--     레이션에서는 스키마 추가만 하고, 코드 변경은 별도 커밋에서 진행.
-- ============================================

-- 1) bg_shipping_config 확장
ALTER TABLE bg_shipping_config
  ADD COLUMN IF NOT EXISTS name VARCHAR(100),
  ADD COLUMN IF NOT EXISTS is_default BOOLEAN DEFAULT false;

-- 기존 단일 row 를 '기본 그룹' 으로 승격
UPDATE bg_shipping_config
   SET name = COALESCE(name, '기본 그룹'),
       is_default = true
 WHERE id = '00000000-0000-0000-0000-000000000001';

-- is_default 가 true 인 row 는 정확히 1개만 허용 (partial unique index)
CREATE UNIQUE INDEX IF NOT EXISTS uq_bg_shipping_config_default
  ON bg_shipping_config (is_default) WHERE is_default = true;

-- 2) bg_product_settings.shipping_group_id 추가
ALTER TABLE bg_product_settings
  ADD COLUMN IF NOT EXISTS shipping_group_id UUID;

-- 조회 효율 인덱스
CREATE INDEX IF NOT EXISTS idx_bg_product_settings_shipping_group
  ON bg_product_settings(shipping_group_id) WHERE shipping_group_id IS NOT NULL;

COMMENT ON COLUMN bg_shipping_config.name IS '그룹 이름 (예: 기본 그룹, 롱리드타임 상품 전용)';
COMMENT ON COLUMN bg_shipping_config.is_default IS '기본 그룹 여부 (정확히 1개 row 만 true)';
COMMENT ON COLUMN bg_product_settings.shipping_group_id IS '출고일 그룹 FK (NULL = 기본 그룹)';
