-- ============================================
-- BG_STICKERS / BG_PRODUCT_SETTINGS 메타 필드 확장
-- 스프레드시트 seed 데이터 보존용
-- ============================================

-- bg_stickers: 스티커 코드, 브랜드, 타입, 용도, 규격, 매핑 상품코드, 노트
ALTER TABLE bg_stickers ADD COLUMN IF NOT EXISTS sticker_code VARCHAR(100);
ALTER TABLE bg_stickers ADD COLUMN IF NOT EXISTS brand VARCHAR(100);
ALTER TABLE bg_stickers ADD COLUMN IF NOT EXISTS sticker_type VARCHAR(200);
ALTER TABLE bg_stickers ADD COLUMN IF NOT EXISTS usage VARCHAR(200);
ALTER TABLE bg_stickers ADD COLUMN IF NOT EXISTS spec VARCHAR(100);
ALTER TABLE bg_stickers ADD COLUMN IF NOT EXISTS product_codes JSONB DEFAULT '[]'::jsonb;
ALTER TABLE bg_stickers ADD COLUMN IF NOT EXISTS note TEXT;

CREATE INDEX IF NOT EXISTS idx_bg_stickers_sticker_code ON bg_stickers(sticker_code);
CREATE INDEX IF NOT EXISTS idx_bg_stickers_brand ON bg_stickers(brand);

-- bg_product_settings: 브랜드, 제품명
ALTER TABLE bg_product_settings ADD COLUMN IF NOT EXISTS product_name VARCHAR(500);
ALTER TABLE bg_product_settings ADD COLUMN IF NOT EXISTS brand VARCHAR(100);

CREATE INDEX IF NOT EXISTS idx_bg_product_settings_brand ON bg_product_settings(brand);
