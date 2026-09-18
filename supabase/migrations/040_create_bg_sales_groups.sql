-- ============================================
-- 040_create_bg_sales_groups.sql
--
-- 매출 데이터 그룹핑 — 상품 단위 설정(canonical_group_key)이 아니라
-- "매출 데이터 영역에서 그룹을 만들고 해당 매출 행을 그룹에 담는" 방식.
--
-- 배경:
--   같은 상품이 채널/등록방식에 따라 다른 이름·다른 코드체계로 집계됨.
--     · 바른손몰(ETC): 세트를 구성품 옵션 카드로 기록 (TGJBK09O22 "고리수건_스퀘어34")
--     · 더기프트(CSV): 세트명 그대로 ("주방타올 2종 답례품 세트 (2구) (스퀘어34,엑스34)")
--     · 마켓(네이버/쿠팡/정수당): 상품코드 없이 마케팅 롱타이틀만
--   기존 bg_product_settings.canonical_group_key (migration 033) 는 상품설정에
--   등록된 상품만, ERP 코드를 알아야 지정 가능 → 운영자가 쓰기 어려움.
--
-- 설계:
--   bg_sales_groups          그룹 (표시명 = canonical 역할)
--   bg_sales_group_members   그룹에 담긴 매출 행의 매칭 규칙
--     · site_name  : 사이트 구분값 ('' = 전체 사이트). 마켓 롱타이틀을 사이트별로 관리.
--     · match_type : 'code' (상품코드 — 자사) | 'name' (상품명 — 마켓 등 코드 없는 채널)
--     · match_value: 매칭 대상 값
--   매칭된 매출 행은 그룹명으로 합산 표시 (수량/매출 합계).
--   상품코드/상품명 기준이라 이후 매출이 새로 발생해도 그룹이 자동 유지됨.
--
-- 우선순위 (대시보드 resolver):
--   1) bg_sales_group_members  (이 마이그레이션 — 운영자 명시 그룹)
--   2) bg_product_settings.canonical_group_key  (migration 033, 기존 매핑 유지)
--   3) 자동 규칙 (base code + 최장 이름)
-- ============================================

CREATE TABLE IF NOT EXISTS bg_sales_groups (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,                          -- 그룹 표시명 (대시보드/순위에 노출)
  category    TEXT NOT NULL DEFAULT 'daeryepum',      -- daeryepum / deco / flower
  memo        TEXT,
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT bg_sales_groups_name_uniq UNIQUE (category, name)
);

CREATE TABLE IF NOT EXISTS bg_sales_group_members (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id    UUID NOT NULL REFERENCES bg_sales_groups(id) ON DELETE CASCADE,
  -- 사이트 구분값. '' = 전체 사이트 (코드가 유일한 자사 상품에 사용).
  --   NULL 대신 '' 를 쓰는 이유: PostgreSQL UNIQUE 는 NULL 을 서로 다른 값으로 취급해
  --   중복 멤버를 막지 못함.
  site_name   TEXT NOT NULL DEFAULT '',
  match_type  TEXT NOT NULL,                          -- 'code' | 'name'
  match_value TEXT NOT NULL,                          -- 상품코드 또는 상품명
  label       TEXT,                                   -- 등록 당시 상품명 (관리 화면 표시용)
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT bg_sgm_type_chk CHECK (match_type IN ('code', 'name')),
  -- 한 매출 행(사이트+코드/이름)이 두 그룹에 동시에 속하는 모호성 차단.
  CONSTRAINT bg_sgm_uniq UNIQUE (site_name, match_type, match_value)
);

CREATE INDEX IF NOT EXISTS idx_bg_sgm_group ON bg_sales_group_members(group_id);
CREATE INDEX IF NOT EXISTS idx_bg_sgm_lookup ON bg_sales_group_members(match_type, match_value);

COMMENT ON TABLE bg_sales_groups IS '매출 데이터 그룹 — 그룹명이 대시보드 상품별 매출/판매순위의 표시명(canonical) 역할';
COMMENT ON TABLE bg_sales_group_members IS '그룹에 담긴 매출 행 매칭 규칙 (사이트 + 상품코드/상품명)';

-- 2026-10-30 이후 Supabase 신규 테이블 default behavior 대응
GRANT ALL ON TABLE bg_sales_groups TO anon, authenticated, service_role;
GRANT ALL ON TABLE bg_sales_group_members TO anon, authenticated, service_role;
