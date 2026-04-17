-- 관리자 사용자 테이블
-- Supabase Auth 사용자를 이메일 기반으로 관리자 역할에 매핑한다.
-- role: 'admin' (전체 관리) | 'operator' (알림톡 발송 등 운영 업무)

CREATE TABLE IF NOT EXISTS admin_users (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  email       VARCHAR(255) NOT NULL UNIQUE,
  name        VARCHAR(100),
  role        VARCHAR(50) NOT NULL DEFAULT 'operator',
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_admin_users_email ON admin_users (email);
CREATE INDEX idx_admin_users_role ON admin_users (role);

-- RLS 활성화 (서비스 키로만 쓰기 가능, 인증된 사용자는 읽기만)
ALTER TABLE admin_users ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_users_select ON admin_users
  FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY admin_users_all ON admin_users
  FOR ALL
  USING (auth.role() = 'service_role');
