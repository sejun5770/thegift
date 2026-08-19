-- ============================================
-- 073_bg_stock_items_item_kind.sql
--
-- 재고 관리 품목에 구분(원물/부자재/포장재/기타)을 둔다.
--
-- 배경 (운영 요청 2026-08-19):
--   원물인지 부자재인지 구분값이 있으면 재고 임계치를 달리 가져가거나 BOM 을 짤 때
--   역할을 자동으로 채울 수 있다.
--
-- 지금까지는 구분이 bg_stock_bom.component_role 로 'BOM 구성 안에서만' 존재했다.
--   같은 부자재(예: 공용 박스)가 그룹 3개에 들어가면 역할을 3번 정해야 했고,
--   그룹에 안 들어간 품목은 원물인지 부자재인지 알 길이 없었다.
--   품목 자체에 두면 BOM 은 그 값을 기본으로 끌어오면 된다.
--
-- 값 체계는 component_role 과 같다 (product / material / package / etc).
--   두 곳이 다른 말을 쓰면 화면마다 다른 라벨이 붙는다.
--
-- 기존 행 채우기:
--   1) 이미 BOM 에 구성품으로 들어가 있으면 그 role 을 가져온다 (여러 그룹에서 다르면 가장 많이 쓰인 것).
--   2) 없으면 코드 접미로 추정 — 'O' 계열(TGJSD01O4 …)은 원물, 나머지는 부자재.
--      화면의 _guessBomRole 과 같은 규칙이다. 등록 후 화면에서 바꿀 수 있다.
-- ============================================

ALTER TABLE bg_stock_items
  ADD COLUMN IF NOT EXISTS item_kind TEXT NOT NULL DEFAULT 'material';

ALTER TABLE bg_stock_items DROP CONSTRAINT IF EXISTS bg_si_item_kind_chk;
ALTER TABLE bg_stock_items ADD CONSTRAINT bg_si_item_kind_chk
  CHECK (item_kind IN ('product', 'material', 'package', 'etc'));

COMMENT ON COLUMN bg_stock_items.item_kind IS
  '품목 구분 — product=원물 / material=부자재 / package=포장재 / etc=기타. bg_stock_bom.component_role 과 같은 값 체계. BOM 역할 기본값·임계치 기준으로 쓴다';

-- 1) BOM 에 이미 역할이 있으면 그것을 (최다 사용 role)
WITH role_votes AS (
  SELECT component_code, component_role, COUNT(*) AS n,
         ROW_NUMBER() OVER (PARTITION BY component_code ORDER BY COUNT(*) DESC, component_role) AS rn
  FROM bg_stock_bom
  GROUP BY component_code, component_role
)
UPDATE bg_stock_items s
   SET item_kind = v.component_role
  FROM role_votes v
 WHERE v.rn = 1
   AND v.component_code = s.stock_code;

-- 2) BOM 에 없는 것은 코드 접미로 추정 (영문 접두 + 숫자 + 'O' = 원물)
UPDATE bg_stock_items
   SET item_kind = 'product'
 WHERE stock_code ~* '^[A-Z]+[0-9]+O'
   AND stock_code NOT IN (SELECT DISTINCT component_code FROM bg_stock_bom);

CREATE INDEX IF NOT EXISTS idx_bg_si_item_kind ON bg_stock_items (item_kind);

-- ── 구분별 경고 기준일 (슬랙 데일리 알림) ──
--   품목에 임계치(threshold)가 없을 때 '소진예상 N일 이하' 를 경고로 보는데, 지금은 전 품목
--   30일 고정이다. 원물은 발주 리드타임이 길어 더 일찍, 부자재는 더 늦게 잡고 싶다는 요청.
--   {"product":30,"material":30,"package":30,"etc":30} 형태. 비면 30.
ALTER TABLE bg_site_settings
  ADD COLUMN IF NOT EXISTS stock_alert_warn_days JSONB;
COMMENT ON COLUMN bg_site_settings.stock_alert_warn_days IS
  '구분별 소진예상 경고 기준일 {"product":30,"material":30,...}. 품목 threshold 가 없을 때만 적용. 비면 30일';
