-- ============================================
-- 044_create_bg_stock_items.sql
--
-- 답례품 재고 관리 품목 (수동 등록).
--
-- 배경:
--   재고 화면을 S2_Card 의 답례품 코드(D01 + COM_) 전체로 자동 구성했더니
--   세트·반제·스티커·부자재·원물이 뒤섞여 290개가 나왔다. ERP 의
--   상품구분/사용여부는 bar_shop1 로 넘어오지 않아 그 값으로 거를 수 없다.
--   → 운영에서 관리할 품목만 직접 등록해 쓰기로 결정 (2026-08-05).
--
-- 코드가 두 개인 이유:
--   S2_CARD_ERP_STOCK 은 CARD_CODE 와 CARD_CODE_ERP 를 함께 갖는데,
--   품목에 따라 재고가 잡히는 쪽이 다르다.
--     예) TGJSD09O1_A → CARD_CODE_ERP='TGJSD09D1' 행에 6,439
--                       CARD_CODE_ERP='TGJSD09O1' 행에 2,197
--   어느 코드로 재고를 읽을지는 품목마다 운영이 지정해야 해서 컬럼을 분리했다.
--     product_code : 매출·판매수량 집계 기준 (S2_Card.Card_Code)
--     stock_code   : 재고 조회 기준. 비우면 product_code 를 그대로 사용.
--                    조회 시 CARD_CODE 또는 CARD_CODE_ERP 양쪽과 대조한다.
--
-- 043_create_bg_stock_alerts.sql 은 이 테이블로 대체된다.
--   (알림 대상 여부는 alert_enabled 컬럼으로 흡수)
-- ============================================

CREATE TABLE IF NOT EXISTS bg_stock_items (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_code  TEXT NOT NULL UNIQUE,        -- 매출 집계 기준 코드
  stock_code    TEXT,                        -- 재고 조회 코드 (NULL = product_code 사용)
  label         TEXT,                        -- 표시명 (비우면 S2_Card 상품명)
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

COMMENT ON TABLE bg_stock_items IS '답례품 재고 관리 품목 (수동 등록) — 재고 화면/슬랙 알림의 유일한 대상 목록';
COMMENT ON COLUMN bg_stock_items.stock_code IS '재고 조회 코드. NULL 이면 product_code. CARD_CODE / CARD_CODE_ERP 양쪽과 대조';
COMMENT ON COLUMN bg_stock_items.threshold IS '가용재고 임계치 — 이하면 경고. NULL 이면 소진예상 30일 기준';

-- 043 을 이미 실행해 등록해 둔 알림 대상이 있으면 옮겨온다 (없으면 아무 일도 하지 않음).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'bg_stock_alerts') THEN
    INSERT INTO bg_stock_items (product_code, label, threshold, sort_order, enabled, alert_enabled, memo, created_by, created_at)
    SELECT product_code, label, threshold, sort_order, TRUE, enabled, memo, created_by, created_at
    FROM bg_stock_alerts
    ON CONFLICT (product_code) DO NOTHING;
  END IF;
END $$;

-- 2026-10-30 이후 Supabase 신규 테이블 default behavior 대응
GRANT ALL ON TABLE bg_stock_items TO anon, authenticated, service_role;
