-- ============================================
-- 043_create_bg_stock_alerts.sql
--
-- 답례품 재고 데일리 슬랙 알림 대상 품목.
--
-- 배경:
--   /api/daeryepum-stock 은 답례품 SKU 전체(수백 개)를 반환한다.
--   운영팀이 매일 눈으로 봐야 하는 품목은 그중 일부(주력/품절 위험 SKU)뿐이라
--   "특정 품목코드만" 골라 매일 정해진 시각에 슬랙으로 받아보기 위한 대상 목록.
--
-- 설계:
--   product_code : S2_Card.Card_Code (= 재고 API 의 product_code) — 유니크
--   threshold    : 가용재고 임계치. 이 값 이하면 ⚠️ 경고로 표시.
--                  NULL 이면 임계 대신 소진예상일 30일 이하를 경고 기준으로 사용.
--   label        : 등록 당시 상품명 스냅샷 (재고 API 에서 이름이 비는 경우 대비)
--   enabled      : 임시로 알림에서 빼고 싶을 때 사용 (행 삭제 없이 토글)
-- ============================================

CREATE TABLE IF NOT EXISTS bg_stock_alerts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_code TEXT NOT NULL UNIQUE,
  label        TEXT,
  threshold    INTEGER,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  enabled      BOOLEAN NOT NULL DEFAULT TRUE,
  memo         TEXT,
  created_by   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT bg_sa_threshold_chk CHECK (threshold IS NULL OR threshold >= 0)
);

CREATE INDEX IF NOT EXISTS idx_bg_sa_enabled ON bg_stock_alerts (enabled, sort_order);

COMMENT ON TABLE bg_stock_alerts IS '답례품 재고 데일리 슬랙 알림 대상 품목';
COMMENT ON COLUMN bg_stock_alerts.threshold IS '가용재고 임계치 — 이하면 경고. NULL 이면 소진예상 30일 기준';

-- 2026-10-30 이후 Supabase 신규 테이블 default behavior 대응
GRANT ALL ON TABLE bg_stock_alerts TO anon, authenticated, service_role;
