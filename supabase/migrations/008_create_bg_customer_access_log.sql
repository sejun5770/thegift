-- ============================================
-- 고객 화면 접근 감사 로그
-- 열거 공격 / 스크래핑 / 비정상 접근 패턴 감지 + 사고 조사
-- ============================================

CREATE TABLE IF NOT EXISTS bg_customer_access_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id VARCHAR(100),              -- search/login 시에는 NULL
  action VARCHAR(50) NOT NULL,        -- 'view' | 'submit' | 'reset' | 'search' | 'login_success' | 'login_fail' | 'not_found'
  ip_hash VARCHAR(64),                 -- SHA-256(ip + salt) — 원본 IP는 저장하지 않음
  user_agent TEXT,                     -- 브라우저/봇 식별용
  status_code INT,                     -- 응답 HTTP status (200, 404, 500 등)
  metadata JSONB,                      -- 자유 필드: { phone_masked, uname, error, duration_ms, ... }
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bg_customer_access_log_order_id
  ON bg_customer_access_log(order_id) WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bg_customer_access_log_created_at
  ON bg_customer_access_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bg_customer_access_log_ip_hash
  ON bg_customer_access_log(ip_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bg_customer_access_log_action
  ON bg_customer_access_log(action, created_at DESC);

COMMENT ON TABLE bg_customer_access_log IS '바른기프트 고객 화면 접근 감사 로그 (PII 보호: ip_hash 저장)';
COMMENT ON COLUMN bg_customer_access_log.ip_hash IS 'SHA-256(client_ip + SESSION_SECRET salt) — 동일 IP 식별은 가능, 역추적 불가';
COMMENT ON COLUMN bg_customer_access_log.action IS 'view=주문조회, submit=정보제출, reset=관리자초기화, search=검색, login_*=로그인 시도, not_found=존재하지 않는 주문 조회';
