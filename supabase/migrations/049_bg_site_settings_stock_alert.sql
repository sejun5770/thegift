-- ============================================
-- 049_bg_site_settings_stock_alert.sql
--
-- 재고 슬랙 알림 설정을 화면에서 바꿀 수 있게 컬럼 추가.
--
-- 배경:
--   채널·발송시각을 환경변수(BG_STOCK_SLACK_CHANNEL / BG_STOCK_ALERT_TIME)로만
--   지정할 수 있어, 채널을 바꾸려면 Docker Manager 에서 환경변수를 고치고
--   재배포해야 했다. 운영이 직접 바꿀 수 있도록 DB 설정으로 옮긴다.
--
-- 우선순위: DB 값 > 환경변수 (DB 가 비어 있으면 기존 환경변수 그대로 동작)
-- ============================================

ALTER TABLE bg_site_settings ADD COLUMN IF NOT EXISTS stock_alert_channel TEXT;
ALTER TABLE bg_site_settings ADD COLUMN IF NOT EXISTS stock_alert_time    TEXT;
ALTER TABLE bg_site_settings ADD COLUMN IF NOT EXISTS stock_alert_enabled BOOLEAN;

COMMENT ON COLUMN bg_site_settings.stock_alert_channel IS '재고 알림 슬랙 채널 ID (예: C09D0T82XU4). 비우면 BG_STOCK_SLACK_CHANNEL 환경변수 사용';
COMMENT ON COLUMN bg_site_settings.stock_alert_time    IS '재고 알림 발송 시각 HH:MM (KST). 비우면 BG_STOCK_ALERT_TIME 환경변수 사용';
COMMENT ON COLUMN bg_site_settings.stock_alert_enabled IS '재고 알림 자동 발송 여부. NULL 이면 BG_STOCK_ALERT_ENABLED 환경변수 사용';
