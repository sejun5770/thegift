-- ============================================
-- 033_add_canonical_grouping.sql
--
-- bg_product_settings 에 상품별 매출 canonical 그룹핑용 컬럼 추가.
--
-- 배경:
--   대시보드 상품별 매출 표에서 같은 상품인데 코드 (예: 변형 옵션) 나
--   이름 (예: "메이플 호두정과" vs "정수당 메이플 호두정과 답례품") 이
--   다르면 각각 행으로 분리되어 나옴. 실질적으로 같은 상품임을 관리자가
--   명시적으로 매핑해서 하나의 매출로 집계.
--
-- 컬럼:
--   canonical_group_key    같은 그룹으로 묶을 식별자 (관리자 자유 입력, 예: '메이플_호두정과')
--   canonical_display_name 대시보드 표시명 (NULL 이면 product_name 사용)
--
-- 정책:
--   · 동일 카테고리 내에서만 그룹핑 (다른 카테고리 상품이 우연히 같은 키를 써도 대시보드는 카테고리별 필터 후 집계)
--   · canonical_group_key NULL = 미매핑 → 대시보드는 자동 규칙 (base code + longest name) 적용
--   · 기존 rows 는 NULL backfill — 서비스 영향 없음 (forward-only).
-- ============================================

ALTER TABLE bg_product_settings
  ADD COLUMN IF NOT EXISTS canonical_group_key TEXT;

ALTER TABLE bg_product_settings
  ADD COLUMN IF NOT EXISTS canonical_display_name TEXT;

-- 대시보드 조회 시 canonical_group_key 별 lookup 빠르게 — 일반 대소문자 구분 인덱스
CREATE INDEX IF NOT EXISTS idx_bg_product_settings_canonical_group
  ON bg_product_settings(canonical_group_key)
  WHERE canonical_group_key IS NOT NULL;

COMMENT ON COLUMN bg_product_settings.canonical_group_key IS '대시보드 상품별 매출 canonical 그룹 키 — 관리자 자유 입력. 같은 값을 가진 상품들은 하나의 대표 상품으로 통합 집계.';
COMMENT ON COLUMN bg_product_settings.canonical_display_name IS '대시보드 표시명 (NULL 이면 product_name 사용). 그룹 대표 이름을 다르게 노출하고 싶을 때 사용.';
