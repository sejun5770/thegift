-- ============================================
-- 052_bg_stock_bom_group_key.sql
--
-- BOM 그룹에 판매코드를 여러 개 달 수 있게 한다 (변형코드 대응).
--
-- 배경 (운영 지적 2026-08-07):
--   한 상품이 TGJSD1001_A / _B / _C 처럼 변형코드로 갈려 팔린다.
--   050 구조는 parent_code 가 곧 그룹이라 코드 하나만 넣으면 나머지 판매분이
--   소진에서 빠지고(소진예상일이 실제보다 길게 나옴), 세 개를 다 넣으면
--   그룹이 셋으로 쪼개지면서 구성품이 '공용 3' 으로 잘못 잡혔다.
--
-- 해결:
--   group_key 를 추가해 '그룹'과 '판매코드'를 분리한다.
--     · 한 그룹 = group_key 하나 + 판매코드 N개 + 구성품 M개 → 행 N×M
--     · 소진은 그 그룹의 모든 판매코드 판매량을 합산한다 (이미 그렇게 동작)
--     · 공용 판정은 parent_code 개수가 아니라 distinct group_key 개수로 센다
--       → 같은 상품의 변형코드는 더 이상 공용으로 오인되지 않는다
--
-- 기존 행은 group_key = parent_code 로 채운다 (그룹 하나에 판매코드 하나 = 종전과 동일).
-- ============================================

ALTER TABLE bg_stock_bom ADD COLUMN IF NOT EXISTS group_key TEXT;

UPDATE bg_stock_bom SET group_key = parent_code WHERE group_key IS NULL OR group_key = '';

ALTER TABLE bg_stock_bom ALTER COLUMN group_key SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_bg_bom_group ON bg_stock_bom (group_key);

COMMENT ON COLUMN bg_stock_bom.group_key IS
  'BOM 그룹 키 — 같은 그룹의 행이 공유한다. 한 그룹에 판매코드(parent_code) 여러 개를 달 수 있다 (변형코드 _A/_B/_C)';

-- (parent_code, component_code) UNIQUE 는 그대로 유지한다.
--   같은 판매코드에 같은 구성품이 두 번 들어가는 것은 여전히 막아야 하고,
--   그룹이 달라도 이 조합이 겹치면 소진이 이중 계상되므로 겹치게 두면 안 된다.
