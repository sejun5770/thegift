-- ============================================
-- 065_create_channel_inquiries.sql
--
-- 외부채널 고객문의 모아보기.
--
-- 배경 (운영 요청 2026-08-13):
--   쿠팡·네이버 문의를 채널 관리자에 각각 들어가 확인하고 있다. 한 화면에 모은다.
--
-- 왜 저장하는가 (실시간 조회로 끝내지 않는 이유):
--   쿠팡 고객센터 문의조회는 조회기간이 최대 7일이다. 그보다 오래된 문의는
--   API 로 다시 꺼낼 수 없어, 화면을 열 때마다 부르는 방식으로는 지난 이력이 사라진다.
--   또 '우리가 확인했는지' 같은 운영 상태는 채널에 없으므로 우리 쪽에 둘 자리가 필요하다.
--
-- 설계:
--   · (channel, inquiry_type, external_id) 가 자연 키. 같은 문의를 다시 받아도 덮어쓴다.
--   · raw_payload 를 통째로 보관한다. 채널 응답 필드가 문서와 달라 정규화가 어긋나도
--     원본이 남아 있으면 나중에 다시 뽑을 수 있다 (로켓그로스에서 겪은 문제).
--   · answered 는 채널이 준 값이다. 우리 쪽 확인 여부(checked_at)는 따로 둔다 —
--     채널에서 답변했더라도 운영이 봤는지는 별개다.
-- ============================================

CREATE TABLE IF NOT EXISTS channel_inquiries (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel       TEXT NOT NULL,              -- 'coupang' | 'naver' (정수당은 scope 확보 후)
  inquiry_type  TEXT NOT NULL,              -- 채널 내 종류: 'callcenter' | 'online' | 'customer'
  external_id   TEXT NOT NULL,              -- 채널이 준 문의 식별자

  inquired_at   TIMESTAMPTZ,                -- 문의 시각
  order_id      TEXT,                       -- 연결된 주문번호 (있으면)
  product_name  TEXT,
  customer_name TEXT,                       -- 채널이 마스킹해 주는 경우가 많다
  title         TEXT,
  content       TEXT,

  answered      BOOLEAN NOT NULL DEFAULT FALSE,   -- 채널 기준 답변 여부
  answer_content TEXT,
  answered_at   TIMESTAMPTZ,

  checked_at    TIMESTAMPTZ,                -- 우리 쪽 확인 표시 (채널 답변과 별개)
  checked_by    TEXT,

  raw_payload   JSONB,
  synced_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS channel_inquiries_uniq
  ON channel_inquiries (channel, inquiry_type, external_id);
CREATE INDEX IF NOT EXISTS idx_channel_inquiries_at      ON channel_inquiries (inquired_at DESC);
CREATE INDEX IF NOT EXISTS idx_channel_inquiries_channel ON channel_inquiries (channel);
CREATE INDEX IF NOT EXISTS idx_channel_inquiries_open    ON channel_inquiries (answered) WHERE NOT answered;

COMMENT ON TABLE channel_inquiries IS
  '외부채널 고객문의 — 쿠팡 고객센터·상품문의, 네이버 고객문의를 한자리에 모은다';
COMMENT ON COLUMN channel_inquiries.answered IS '채널 기준 답변 여부 — 우리 확인 여부는 checked_at';
COMMENT ON COLUMN channel_inquiries.raw_payload IS
  '채널 응답 원본. 정규화가 어긋나도 여기서 다시 뽑을 수 있게 통째로 남긴다';

GRANT ALL ON TABLE channel_inquiries TO anon, authenticated, service_role;
