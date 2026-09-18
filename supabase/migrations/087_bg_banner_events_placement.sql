-- ============================================
-- 087_bg_banner_events_placement.sql
--
-- 고객 화면 배너 노출 위치 (요청 2026-09-18).
--
-- 배너마다 노출 위치를 고를 수 있게 되면서(완료 화면 / 배송 조회 카드 아래 / 샘플 주문 안내 화면)
-- 어느 자리가 반응이 좋은지 비교하려면 노출·클릭 기록에도 위치가 필요하다.
-- 배너의 위치 설정 자체는 bg_site_settings.completion_banners(JSONB) 의 items[].placements 에 들어가므로
-- 컬럼 추가가 필요 없다.
--
--   placement  TEXT  'complete' | 'delivery' | 'noinput'. NULL = 위치 기능 전 기록 (집계에서는 complete 로 센다)
--
-- 실행 전이어도 기록은 계속된다 — 서버가 컬럼이 없으면 위치만 빼고 넣는다.
-- ============================================

ALTER TABLE bg_banner_events
  ADD COLUMN IF NOT EXISTS placement TEXT;

COMMENT ON COLUMN bg_banner_events.placement IS '배너 노출 위치 (087): complete / delivery / noinput. NULL = 위치 기능 전 기록';
