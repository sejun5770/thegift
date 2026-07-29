-- ============================================
-- 042_create_bg_sales_exclusions.sql
--
-- 답례품 매출 집계 제외 목록.
--
-- 배경:
--   마켓(쿠팡/네이버/정수당)에는 답례품 외 품목도 함께 판매된다
--   (자개 연하장, 테넷텐 탈취제, 아크릴 액자, 방명록, 포장 헤더택 등).
--   자사(MSSQL)는 Card_Div 로 답례품만 걸러지지만 마켓은 그런 구분이 없어
--   답례품 매출·상품 순위에 섞여 들어간다.
--
-- 설계:
--   bg_sales_groups 멤버와 동일한 매칭 규칙 사용 —
--     site_name  : 사이트 구분값 ('' = 전 사이트)
--     match_type : 'code'(상품코드) | 'name'(상품명)
--     match_value: 매칭 대상 값
--   여기 등록된 항목은 매출현황·상품순위·상품별통계·주간리포트 등
--   답례품 집계에서 빠진다. (주문조회 목록에는 그대로 남음 — CS 조회 보존)
-- ============================================

CREATE TABLE IF NOT EXISTS bg_sales_exclusions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_name   TEXT NOT NULL DEFAULT '',      -- '' = 전 사이트
  match_type  TEXT NOT NULL,                 -- 'code' | 'name'
  match_value TEXT NOT NULL,
  label       TEXT,                          -- 등록 당시 상품명 (관리 화면 표시용)
  reason      TEXT,                          -- 제외 사유 메모
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT bg_sx_type_chk CHECK (match_type IN ('code', 'name')),
  CONSTRAINT bg_sx_uniq UNIQUE (site_name, match_type, match_value)
);

CREATE INDEX IF NOT EXISTS idx_bg_sx_lookup ON bg_sales_exclusions (match_type, match_value);

COMMENT ON TABLE bg_sales_exclusions IS '답례품 매출 집계 제외 품목 (마켓의 비-답례품: 자개카드/탈취제/아크릴액자 등)';

-- 2026-10-30 이후 Supabase 신규 테이블 default behavior 대응
GRANT ALL ON TABLE bg_sales_exclusions TO anon, authenticated, service_role;
