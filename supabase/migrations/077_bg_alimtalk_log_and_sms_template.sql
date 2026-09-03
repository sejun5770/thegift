-- 077: 발송 이력 테이블 재생성 + 출고완료 문자 본문 설정
--
-- 배경 (2026-08-27 운영 확인):
--   문자 발송은 성공하는데 화면 '발송이력' 컬럼이 비어 있었다. 확인해 보니 운영 Supabase 에
--   bg_alimtalk_log 테이블 자체가 없었다 (PGRST205 — schema cache 에 없음).
--   005_create_bg_alimtalk_log.sql 에 정의는 있지만 운영에 적용되지 않은 상태.
--   store.logAlimtalkSend 는 insert 실패 시 컨테이너 로컬 JSON 으로 폴백하므로 발송 자체는
--   되지만, 조회는 Supabase 만 보기 때문에 이력이 안 보이고 **중복 발송 방지도 동작하지 않았다.**
--   (커밋된 005 를 고쳐 재실행하지 않고 새 번호로 낸다 — 073 세트 사고 이후 규칙.)
--
--   같은 릴리스에서 필요한 문자 본문 설정 컬럼도 함께 만든다.

-- ── 1) 발송 이력 (005 와 동일 스키마) ───────────────────────────
CREATE TABLE IF NOT EXISTS bg_alimtalk_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id VARCHAR(100) NOT NULL,              -- 'ETC-{seq}' / '{seq}' / 'PH-{연락처}'(주문번호 없는 건)
  to_phone VARCHAR(30),                        -- 마스킹 저장 ('****1234')
  template_code VARCHAR(100),                  -- 알림톡 템플릿명 또는 'SMS_출고완료안내'
  message_id VARCHAR(200),                     -- 알림톡 messageId / LMS tranId(KTRCS MSG_ID)
  success BOOLEAN NOT NULL,
  is_mock BOOLEAN DEFAULT false,
  error_code VARCHAR(50),
  error_message TEXT,
  sent_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bg_alimtalk_log_order_id ON bg_alimtalk_log(order_id);
CREATE INDEX IF NOT EXISTS idx_bg_alimtalk_log_sent_at ON bg_alimtalk_log(sent_at);
-- 문자발송 화면은 (템플릿, 주문) 으로 이력을 찾는다 — 중복 발송 판정 경로.
CREATE INDEX IF NOT EXISTS idx_bg_alimtalk_log_template_order
  ON bg_alimtalk_log(template_code, order_id);

-- PostgREST 접근 권한 — 새 테이블은 명시적으로 준다 (기존 테이블 영향 없음).
GRANT SELECT, INSERT, UPDATE, DELETE ON bg_alimtalk_log TO anon, authenticated, service_role;

-- ── 2) 출고완료 안내 문자 본문 (운영자가 화면에서 수정) ──────────
--   NULL 이면 서버 기본 문구를 쓴다. 변수: {이름} {출고일} {송장번호}
ALTER TABLE bg_site_settings
  ADD COLUMN IF NOT EXISTS sms_ship_template TEXT;

COMMENT ON COLUMN bg_site_settings.sms_ship_template IS
  '출고완료 안내 문자 본문. 변수 {이름}/{출고일}/{송장번호} 치환. NULL=기본 문구';
