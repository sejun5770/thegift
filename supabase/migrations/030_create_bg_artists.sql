-- ============================================
-- 030_create_bg_artists.sql
--
-- 작가 정산 — 작가 master + 품목(작품) 매핑.
--
-- bg_artists: 작가 master (이름 + 기본 수수료율)
-- bg_artist_products: 품목코드 ↔ 작가 매핑 + 카테고리(분류)
--
-- 매출 집계: MSSQL custom_order/CUSTOM_ETC_ORDER 의 Card_Code 를 product_code 와 매칭.
-- 정산금액 = (해당 품목코드의 매출 합계) × (작가 commission_rate / 100).
-- ============================================

-- 1) 작가 master
CREATE TABLE IF NOT EXISTS bg_artists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL UNIQUE,
  commission_rate NUMERIC(5, 2) NOT NULL DEFAULT 3.00,  -- % (예: 3.00 = 3%)
  is_active BOOLEAN NOT NULL DEFAULT true,
  memo TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

DROP TRIGGER IF EXISTS bg_artists_updated_at ON bg_artists;
CREATE TRIGGER bg_artists_updated_at
  BEFORE UPDATE ON bg_artists
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- 2) 작가 ↔ 품목 매핑
CREATE TABLE IF NOT EXISTS bg_artist_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_code VARCHAR(100) NOT NULL UNIQUE,         -- 예: 2026card_26_set, BC0962
  product_name VARCHAR(200),                          -- 표시용 (없어도 OK — MSSQL 조회 가능)
  category VARCHAR(50),                               -- 엽서세트 / 웨딩스탬프 / 청첩장
  artist_id UUID REFERENCES bg_artists(id) ON DELETE SET NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bg_artist_products_artist ON bg_artist_products(artist_id);
CREATE INDEX IF NOT EXISTS idx_bg_artist_products_category ON bg_artist_products(category);
CREATE INDEX IF NOT EXISTS idx_bg_artist_products_code ON bg_artist_products(product_code);

DROP TRIGGER IF EXISTS bg_artist_products_updated_at ON bg_artist_products;
CREATE TRIGGER bg_artist_products_updated_at
  BEFORE UPDATE ON bg_artist_products
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- GRANT — public access (운영팀 admin UI 사용)
GRANT SELECT, INSERT, UPDATE, DELETE ON bg_artists TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON bg_artist_products TO anon, authenticated;

-- ── 시드 데이터 (캡처 기준) ──
-- 작가 11명 + 품목 ~30개. ON CONFLICT 로 멱등성 보장.

INSERT INTO bg_artists (name, commission_rate) VALUES
  ('차윤',         3.00),
  ('설찌',         3.00),
  ('미도리',       3.00),
  ('김소희',       3.00),
  ('아쌤',         3.00),
  ('흥원표',       3.00),
  ('하나그라프',   3.00),
  ('김소이',       3.00),
  ('미도리작업실', 3.00),
  ('오링',         3.00),
  ('차윤아트',     3.00)
ON CONFLICT (name) DO NOTHING;

-- 품목 시드 (artist_id 는 name lookup)
INSERT INTO bg_artist_products (product_code, category, artist_id)
SELECT v.product_code, v.category, a.id
FROM (VALUES
  -- 엽서세트
  ('2026card_26_set',   '엽서세트',   '차윤'),
  ('2026card_31_set',   '엽서세트',   '설찌'),
  ('2026card_36_set',   '엽서세트',   '미도리'),
  ('2026card_41_set',   '엽서세트',   '김소희'),
  -- 웨딩스탬프
  ('2026_stamp_04',     '웨딩스탬프', '미도리'),
  -- 청첩장 — 아쌤
  ('BC0949', '청첩장', '아쌤'),
  ('BC0950', '청첩장', '아쌤'),
  ('BC0961', '청첩장', '아쌤'),
  ('BC0962', '청첩장', '아쌤'),
  ('BC0963', '청첩장', '아쌤'),
  -- 청첩장 — 흥원표
  ('BH5066', '청첩장', '흥원표'),
  -- 청첩장 — 설찌
  ('BC0959', '청첩장', '설찌'),
  ('BC0960', '청첩장', '설찌'),
  -- 청첩장 — 하나그라프
  ('BC0951', '청첩장', '하나그라프'),
  ('BC0952', '청첩장', '하나그라프'),
  -- 청첩장 — 김소이
  ('BC0940', '청첩장', '김소이'),
  ('BC0941', '청첩장', '김소이'),
  ('BC0942', '청첩장', '김소이'),
  ('BC0943', '청첩장', '김소이'),
  ('BC0944', '청첩장', '김소이'),
  -- 청첩장 — 미도리작업실
  ('BC0938', '청첩장', '미도리작업실'),
  ('BC0939', '청첩장', '미도리작업실'),
  -- 청첩장 — 오링
  ('BC0947', '청첩장', '오링'),
  ('BC0948', '청첩장', '오링'),
  ('BC0964', '청첩장', '오링'),
  ('BC0965', '청첩장', '오링'),
  ('BC0966', '청첩장', '오링'),
  -- 청첩장 — 차윤아트
  ('BC0933', '청첩장', '차윤아트'),
  ('BC0934', '청첩장', '차윤아트'),
  ('BC0935', '청첩장', '차윤아트'),
  ('BC0936', '청첩장', '차윤아트'),
  ('BC0937', '청첩장', '차윤아트')
) AS v(product_code, category, artist_name)
JOIN bg_artists a ON a.name = v.artist_name
ON CONFLICT (product_code) DO NOTHING;
