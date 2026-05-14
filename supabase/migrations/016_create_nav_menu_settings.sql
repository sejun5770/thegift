-- GNB(상단 네비) 메뉴 표시 설정 — 단일행 (id=1)
-- super admin 만 PUT 가능. 모든 로그인 사용자는 GET 가능 (페이지 로드 시 네비 구성용).
--
-- config JSONB 구조:
--   [
--     { "id": "dashboard",       "visible": true,  "order": 0 },
--     { "id": "monthly-report",  "visible": true,  "order": 1 },
--     { "id": "orders",          "visible": true,  "order": 2 },
--     ...
--   ]
-- id 는 index.html nav 의 href="#{id}" 와 매칭.
-- 누락된 id 는 기본값(visible=true, order=index)으로 처리.

CREATE TABLE IF NOT EXISTS nav_menu_settings (
  id           INTEGER PRIMARY KEY DEFAULT 1,
  config       JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by   TEXT,
  CONSTRAINT single_row CHECK (id = 1)
);

INSERT INTO nav_menu_settings (id, config)
VALUES (1, '[]'::jsonb)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE nav_menu_settings ENABLE ROW LEVEL SECURITY;

-- 모든 인증 사용자가 읽기 가능 (네비 구성용)
CREATE POLICY nav_menu_settings_select ON nav_menu_settings
  FOR SELECT USING (true);

-- 쓰기는 서버(서비스 키) 에서만 — RLS 우회 (anon 키로는 PUT 차단)
-- 서버에서 super admin 이메일 화이트리스트 검증 후 PATCH 호출.
