-- ============================================
-- 044_create_bg_stock_items.sql
--
-- 답례품 재고 관리 품목 (수동 등록) — ERP코드 기준.
--
-- 배경:
--   재고 화면을 S2_Card 의 답례품 코드(D01 + COM_) 전체로 자동 구성했더니
--   세트·반제·스티커·부자재·원물이 뒤섞여 290개가 나왔다. ERP 의
--   상품구분/사용여부는 bar_shop1 로 넘어오지 않아 그 값으로 거를 수 없다.
--   → 운영에서 관리할 품목만 직접 등록해 쓰기로 결정 (2026-08-05).
--
-- 왜 ERP코드인가:
--   재고는 ERP코드(S2_CARD_ERP_STOCK.CARD_CODE_ERP)에 매핑되어 있다 (운영 확인).
--   반면 판매는 품목코드(S2_Card.Card_Code)로 일어나고, ERP코드 하나에
--   품목코드가 여러 개 달리는 경우가 있다.
--     예) TGJSD09O1 → TGJSD09O1_A, TGJSD09O1_C
--         TGJBK03O1 → TGJBK03O1,  TGJBK03O1_A
--   그래서 등록 단위는 ERP코드 1건이고,
--     재고    = 그 ERP코드 행의 수량
--     판매/매출 = 그 ERP코드에 매핑된 모든 품목코드의 합
--   로 집계한다. (답례품 범위: ERP코드 156 / 품목코드 166)
--
-- 043_create_bg_stock_alerts.sql 은 이 테이블로 대체된다.
--   (알림 대상 여부는 alert_enabled 컬럼으로 흡수)
-- ============================================

CREATE TABLE IF NOT EXISTS bg_stock_items (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  erp_code      TEXT NOT NULL UNIQUE,        -- S2_CARD_ERP_STOCK.CARD_CODE_ERP
  label         TEXT,                        -- 표시명 (비우면 상품명 자동)
  threshold     INTEGER,                     -- 가용재고 경고 임계치 (NULL = 소진예상 30일 기준)
  sort_order    INTEGER NOT NULL DEFAULT 0,
  enabled       BOOLEAN NOT NULL DEFAULT TRUE,   -- 재고 화면 표시 여부
  alert_enabled BOOLEAN NOT NULL DEFAULT TRUE,   -- 슬랙 데일리 알림 포함 여부
  memo          TEXT,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT bg_si_threshold_chk CHECK (threshold IS NULL OR threshold >= 0)
);

CREATE INDEX IF NOT EXISTS idx_bg_si_enabled ON bg_stock_items (enabled, sort_order);

COMMENT ON TABLE bg_stock_items IS '답례품 재고 관리 품목 (수동 등록, ERP코드 기준) — 재고 화면/슬랙 알림의 유일한 대상 목록';
COMMENT ON COLUMN bg_stock_items.erp_code IS 'S2_CARD_ERP_STOCK.CARD_CODE_ERP — 재고가 매핑된 코드. 판매는 이 코드에 딸린 품목코드들을 합산';
COMMENT ON COLUMN bg_stock_items.threshold IS '가용재고 임계치 — 이하면 경고. NULL 이면 소진예상 30일 기준';

-- 2026-10-30 이후 Supabase 신규 테이블 default behavior 대응
GRANT ALL ON TABLE bg_stock_items TO anon, authenticated, service_role;
