-- ============================================
-- 086_bg_completion_banners.sql
--
-- 고객 입력완료 화면 배너 (요청 2026-09-18).
--
-- 고객 주문정보 입력 화면(order-info)의 "제출이 완료됐어요" / "입력이 완료됐어요" 화면에
-- 자사 서비스 배너(이미지 + 링크)를 최대 5개까지 노출한다. 운영자가 대시보드 설정 화면에서
-- 이미지를 직접 올리고 링크·노출 기간·노출 채널(바른손카드/바른손몰)을 정한다.
-- 코드에 박지 않고 설정으로 두는 이유: 배너를 바꿀 때마다 배포하지 않기 위해서.
--
-- 1) bg_site_settings.completion_banners  JSONB  — 배너 목록 (최대 5개, 순서 = 노출 순서)
--    [{ id, image_url, image_path, link_url, alt, start_date, end_date, sites, enabled }]
--      id          TEXT       배너 식별자 (b_<ms>)
--      image_url   TEXT       Storage public URL (bg-customer-logos/_banners/…)
--      image_path  TEXT       Storage 객체 경로 (교체·삭제용)
--      link_url    TEXT       클릭 시 이동 (https 만)
--      alt         TEXT       이미지 대체 문구 (선택)
--      start_date  'YYYY-MM-DD' | null   노출 시작일 (KST, 포함) — null 이면 제한 없음
--      end_date    'YYYY-MM-DD' | null   노출 종료일 (KST, 포함) — null 이면 제한 없음
--      sites       TEXT[]     노출 채널 ['바른손카드','바른손몰'] — 빈 배열이면 전부
--      enabled     BOOLEAN    사용 여부
--
-- 2) bg_banner_events — 노출·클릭 기록. 어느 배너가 반응이 있는지 보기 위한 것.
--    고객 화면이 인증 없이 기록하므로 개인정보는 넣지 않는다 (주문번호·채널만).
-- ============================================

ALTER TABLE bg_site_settings
  ADD COLUMN IF NOT EXISTS completion_banners JSONB;

COMMENT ON COLUMN bg_site_settings.completion_banners IS '고객 입력완료 화면 배너 목록 (086). 최대 5개, 배열 순서 = 노출 순서';

CREATE TABLE IF NOT EXISTS bg_banner_events (
  id          BIGSERIAL PRIMARY KEY,
  banner_id   TEXT NOT NULL,
  event       TEXT NOT NULL CHECK (event IN ('view', 'click')),
  order_id    TEXT,
  site        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bg_banner_events_banner_created
  ON bg_banner_events(banner_id, created_at);

COMMENT ON TABLE bg_banner_events IS '고객 입력완료 화면 배너 노출·클릭 기록 (086)';

-- PostgREST 접근 권한 — 새 테이블은 명시적으로 준다 (기존 테이블 영향 없음).
GRANT SELECT, INSERT, UPDATE, DELETE ON bg_banner_events TO anon, authenticated, service_role;
GRANT USAGE, SELECT ON SEQUENCE bg_banner_events_id_seq TO anon, authenticated, service_role;
