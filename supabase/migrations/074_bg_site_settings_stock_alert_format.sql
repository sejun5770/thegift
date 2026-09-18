-- ============================================
-- 074_bg_site_settings_stock_alert_format.sql
--
-- 슬랙 재고 알림의 메시지 구성을 운영자가 화면에서 정한다 (요청 2026-08-19).
--
-- 지금까지 구성(요약에 무엇을 넣을지, 스레드 섹션 순서, 품목당 보여줄 수치)은 코드에
-- 박혀 있어 바꿀 때마다 배포가 필요했다. 항목 켜기/끄기와 순서만 여는 방식(A안)이라
-- 자유 템플릿과 달리 잘못 만져도 발송이 깨지지 않는다.
--
-- 형태 (모든 키 선택적 — 없으면 기본값 = 지금 동작 그대로):
-- {
--   "summary":  { "counts": true, "attention": true, "attention_limit": 0 },
--   "sections": { "order": ["soldout","warn","ok"],
--                 "soldout": true, "warn": true, "ok": true, "group_by_kind": true },
--   "item":     { "available": true, "consume_30d": true, "daily_avg": true,
--                 "threshold": true, "sales_30d": false, "code": true },
--   "sort":     "days"        -- days(소진예상) | qty(가용재고) | name(이름)
-- }
-- 검증은 store._normAlertFormat 이 한다 — 모르는 키·이상값은 버리고 기본값으로.
-- ============================================

ALTER TABLE bg_site_settings
  ADD COLUMN IF NOT EXISTS stock_alert_format JSONB;

COMMENT ON COLUMN bg_site_settings.stock_alert_format IS
  '슬랙 재고 알림 메시지 구성 (요약 항목·스레드 섹션 순서·품목당 수치·정렬). NULL = 기본 구성';
