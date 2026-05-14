-- ============================================
-- 015_create_auth_sessions.sql
--
-- 관리자 세션 영구 저장소 — 다중 컨테이너 / 재시작 후에도 세션 유지.
-- 기존 in-memory Map 방식이 컨테이너 간 공유 안되어 로그인 루프 발생 → 영구화.
-- ============================================

CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY,              -- session ID (hex 32자, server 가 생성)
  email TEXT NOT NULL,
  name TEXT,
  picture TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,  -- 만료 시각 (기본 24시간 후)
  last_seen_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON auth_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_email ON auth_sessions(email);
