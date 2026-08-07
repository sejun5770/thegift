-- ============================================
-- 054_bg_product_settings_channels_array.sql
--
-- 판매채널을 단수 → 복수로 바꾼다.
--
-- 배경 (운영 지적 2026-08-07):
--   053 은 상품 하나가 채널 하나에만 속한다고 봤는데, 실제로는 같은 코드가
--   자사와 쿠팡에서 동시에 팔린다. 단수 필드로는 "자사이면서 쿠팡" 을 표현할 수 없어
--   중복코드 상품이 어느 한쪽 탭에서만 보였다.
--
--   쿠팡 상품설정의 용도는 (1) 쿠팡 상품코드 (2) 쿠팡 스티커 매핑 둘뿐이다.
--   희망출고일·커스텀 입력 같은 기능은 쿠팡에 없다. 그래서:
--     · 코드가 같으면  → 설정 하나를 공유하고 채널만 여러 개 붙인다 (체크박스)
--     · 코드가 다르면  → 쿠팡 탭에서 전용 코드로 따로 등록한다
--
-- 053 은 적용 직후라 데이터가 전부 'own' 이다. 배열로 옮기고 단수 컬럼은 버린다
--   (두 벌로 두면 어느 쪽이 진짜인지 갈려 조용히 어긋난다).
-- ============================================

ALTER TABLE bg_product_settings
  ADD COLUMN IF NOT EXISTS sales_channels TEXT[] NOT NULL DEFAULT ARRAY['own']::TEXT[];

-- 053 의 단수 값을 배열로 승계 (컬럼이 남아 있을 때만)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'bg_product_settings' AND column_name = 'sales_channel') THEN
    UPDATE bg_product_settings
       SET sales_channels = ARRAY[COALESCE(NULLIF(sales_channel, ''), 'own')]::TEXT[]
     WHERE sales_channels IS NULL OR sales_channels = ARRAY['own']::TEXT[];
    ALTER TABLE bg_product_settings DROP CONSTRAINT IF EXISTS bg_ps_sales_channel_chk;
    DROP INDEX IF EXISTS idx_bg_ps_sales_channel;
    ALTER TABLE bg_product_settings DROP COLUMN sales_channel;
  END IF;
END $$;

-- 빈 배열 방지 + 값 고정. 배열 원소를 CHECK 로 거는 방식.
ALTER TABLE bg_product_settings DROP CONSTRAINT IF EXISTS bg_ps_sales_channels_chk;
ALTER TABLE bg_product_settings ADD  CONSTRAINT bg_ps_sales_channels_chk
  CHECK (
    array_length(sales_channels, 1) >= 1
    AND sales_channels <@ ARRAY['own', 'coupang', 'naver', 'cafe24', 'thegift', 'etc']::TEXT[]
  );

-- 채널 탭 필터가 배열 포함(@>) 으로 도므로 GIN 이 맞다
CREATE INDEX IF NOT EXISTS idx_bg_ps_sales_channels ON bg_product_settings USING GIN (sales_channels);

COMMENT ON COLUMN bg_product_settings.sales_channels IS
  '판매채널 복수 — own=자사 / coupang / naver / cafe24=정수당 / thegift=더기프트 / etc. 같은 코드가 여러 채널에서 팔리면 함께 담는다';
