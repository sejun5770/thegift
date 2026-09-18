-- ============================================
-- 088_bg_admin_logins.sql
--
-- 대시보드 로그인 이력 + 슈퍼 관리자 부여 (요청 2026-09-18).
--
-- 지금까지 슈퍼 관리자는 코드/환경변수(SUPER_ADMIN_EMAILS)의 이메일뿐이었고,
-- 로그인 이력은 어디에도 남지 않았다 (auth_sessions 는 옛 스키마라 세션이 메모리에만 있다).
-- 로그인할 때마다 이 테이블에 이메일별 한 줄을 갱신하고, 관리 › 권한 설정 화면에서
-- 로그인한 적 있는 사용자에게 슈퍼 관리자 권한을 주고 뺀다.
--   is_super_admin  슈퍼 관리자 여부 (환경변수의 기본 관리자는 여기 값과 무관하게 항상 슈퍼 관리자)
--   granted_by/at   마지막으로 권한을 바꾼 사람·시각
-- ============================================

CREATE TABLE IF NOT EXISTS bg_admin_logins (
  email           TEXT PRIMARY KEY,
  name            TEXT,
  picture         TEXT,
  first_login_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  login_count     INTEGER NOT NULL DEFAULT 0,
  is_super_admin  BOOLEAN NOT NULL DEFAULT FALSE,
  granted_by      TEXT,
  granted_at      TIMESTAMPTZ
);

COMMENT ON TABLE bg_admin_logins IS '대시보드 로그인 이력(이메일별 1행) + 슈퍼 관리자 부여 (088)';

-- 이 기능 전의 사용자 — 대시보드 작업 기록(bg_customer_access_log 의 metadata.actor)에 남은 사내 계정으로 채운다.
--   로그인 횟수는 모르니 0, 날짜는 첫·마지막 작업 시각.
INSERT INTO bg_admin_logins (email, first_login_at, last_login_at, login_count)
SELECT lower(metadata->>'actor'), MIN(created_at), MAX(created_at), 0
FROM bg_customer_access_log
WHERE metadata->>'actor' LIKE '%@barunn.net'
GROUP BY lower(metadata->>'actor')
ON CONFLICT (email) DO NOTHING;

-- PostgREST 접근 권한 — 새 테이블은 명시적으로 준다 (기존 테이블 영향 없음).
GRANT SELECT, INSERT, UPDATE, DELETE ON bg_admin_logins TO anon, authenticated, service_role;
