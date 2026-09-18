-- ============================================
-- 085_express_receipt_slack.sql
--
-- 오늘출발 현금영수증 슬랙 자동 전달 (요청 2026-09-18).
--
-- 바른손카드·바른손몰 오늘출발 주문이 수집완료되면 #cs-더기프트 의 그날 스레드
-- "[9/18] 바른손카드, 바른손몰 답례품 오늘출발 서비스비용 입금확인 및 현금영수증 발행" 에
-- 주문 1건 = 댓글 1개로 현금영수증 정보를 남긴다 (barungift/express-receipt-slack.js).
--
-- 컬럼 (새 테이블 없음 — ALTER 만):
--   bg_order_customer_info.express_receipt_posted_at  TIMESTAMPTZ  슬랙에 올린 시각 (NULL = 아직). 되돌리기 후 다시 수집완료해도 두 번 올리지 않는다.
--   bg_site_settings.express_receipt_thread_date      TEXT         오늘 스레드의 날짜 'YYYY-MM-DD' (KST)
--   bg_site_settings.express_receipt_thread_ts        TEXT         오늘 스레드 부모 메시지 ts — 재시작해도 같은 스레드에 댓글을 단다
-- 이 마이그레이션이 없으면 자동 전달은 아무것도 올리지 않는다 (중복 방지 기록이 없어서).
-- ============================================

ALTER TABLE bg_order_customer_info
  ADD COLUMN IF NOT EXISTS express_receipt_posted_at TIMESTAMPTZ;

ALTER TABLE bg_site_settings
  ADD COLUMN IF NOT EXISTS express_receipt_thread_date TEXT,
  ADD COLUMN IF NOT EXISTS express_receipt_thread_ts   TEXT;

COMMENT ON COLUMN bg_order_customer_info.express_receipt_posted_at IS '오늘출발 현금영수증 슬랙 댓글 게시 시각 (085). NULL = 미게시';
COMMENT ON COLUMN bg_site_settings.express_receipt_thread_date IS '오늘출발 현금영수증 스레드 날짜 YYYY-MM-DD KST (085)';
COMMENT ON COLUMN bg_site_settings.express_receipt_thread_ts IS '오늘출발 현금영수증 스레드 부모 메시지 ts (085)';
