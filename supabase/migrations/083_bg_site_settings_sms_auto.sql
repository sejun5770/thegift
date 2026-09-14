-- ============================================
-- 083_bg_site_settings_sms_auto.sql
--
-- 출고안내문자 자동 발송 설정 (요청 2026-09-14).
--
-- 매일 지정 시각(기본 19:00 KST)에 지정한 기프트팀 시트(커스텀 주문 시트 / 월별 답례품 시트)에서
-- 출고일이 오늘인 행을 읽어, 바른손카드·바른손몰 주문(사내 DB 에서 찾은 주문)에만 출고완료 안내
-- 문자를 보내고 결과를 슬랙으로 보고한다. 발송 자체는 기존 [문자 바로 발송] 과 같은 경로
-- (POST /api/bg/sms/send) 라 중복 방지·이력 기록도 같다.
--
-- 컬럼 (모두 선택적 — NULL 이면 꺼짐 / 기본값):
--   sms_auto_enabled        BOOLEAN  자동 발송 사용 여부 (NULL = 꺼짐)
--   sms_auto_time           TEXT     발송 시각 'HH:MM' KST (NULL = 19:00)
--   sms_auto_sheet          TEXT     시트 이름 ('2026년 9월', '커스텀 주문 시트' …) 또는 '__month__' = 오늘이 속한 월 시트 (NULL = __month__)
--   sms_auto_slack_channel  TEXT     리포트 슬랙 채널 (NULL = 재고 알림 채널과 같음)
-- ============================================

ALTER TABLE bg_site_settings
  ADD COLUMN IF NOT EXISTS sms_auto_enabled       BOOLEAN,
  ADD COLUMN IF NOT EXISTS sms_auto_time          TEXT,
  ADD COLUMN IF NOT EXISTS sms_auto_sheet         TEXT,
  ADD COLUMN IF NOT EXISTS sms_auto_slack_channel TEXT;

COMMENT ON COLUMN bg_site_settings.sms_auto_enabled IS '출고안내문자 자동 발송 사용 여부 (083). NULL = 꺼짐';
COMMENT ON COLUMN bg_site_settings.sms_auto_time IS '자동 발송 시각 HH:MM (KST). NULL = 19:00';
COMMENT ON COLUMN bg_site_settings.sms_auto_sheet IS '대상 시트 이름 또는 __month__(이달 시트 자동). NULL = __month__';
COMMENT ON COLUMN bg_site_settings.sms_auto_slack_channel IS '발송 리포트 슬랙 채널. NULL = 재고 알림 채널';
