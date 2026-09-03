-- ============================================
-- bg_vendor_portal_tokens: 거래처 외부 포털 접속 토큰
--
-- 거래처가 본인 정산 내역만 외부에서 조회할 수 있도록 admin 이 발급하는 토큰.
-- URL: /vendor-portal?token={token}
-- 토큰은 길고 추측 어려운 값 (UUID v4 hex, 32자) — 인증서 대용.
--
-- 운영 흐름:
--   1) admin 이 위탁업체 페이지에서 거래처마다 '포털 링크 발급' 클릭
--   2) 토큰 생성 → admin 이 거래처에 이메일로 링크 공유
--   3) 거래처는 토큰만으로 자기 데이터 조회 (다른 거래처 데이터 노출 X)
--   4) 만료/무효화 시 새 토큰 발급
--
-- 보안 정책:
--   · expires_at NULL = 영구 (위험 — admin 이 명시적으로 선택 시만)
--   · revoked_at 설정 시 즉시 무효 (재발급 별도)
--   · access_count / last_accessed_at 추적 — 이상 접속 감지
-- ============================================

CREATE TABLE IF NOT EXISTS bg_vendor_portal_tokens (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token               TEXT NOT NULL UNIQUE,            -- URL 파라미터에 들어가는 public 값
  vendor_id           UUID NOT NULL REFERENCES bg_vendors(id) ON DELETE CASCADE,
  expires_at          TIMESTAMPTZ,                     -- NULL = 영구
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by          TEXT,                            -- admin user_id (감사)
  last_accessed_at    TIMESTAMPTZ,
  access_count        INTEGER NOT NULL DEFAULT 0,
  revoked_at          TIMESTAMPTZ,                     -- 무효화 시점
  revoked_by          TEXT,
  memo                TEXT
);

CREATE INDEX IF NOT EXISTS idx_bg_vpt_token_active
  ON bg_vendor_portal_tokens (token)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_bg_vpt_vendor
  ON bg_vendor_portal_tokens (vendor_id, created_at DESC);

COMMENT ON TABLE bg_vendor_portal_tokens IS '거래처 외부 포털 (정산 조회) 접속 토큰 — admin 발급, 거래처에 공유';

-- 2026-10-30 이후 Supabase 신규 테이블 default behavior 대응
GRANT ALL ON TABLE bg_vendor_portal_tokens TO anon, authenticated, service_role;
