-- ============================================
-- 046_bg_stock_items_stock_sales_codes.sql
--
-- 재고 관리 품목 = 재고코드 + 매출코드 분리 (운영 결정 2026-08-05).
--
--   stock_code  재고를 보기 위한 코드. ERP 재고(S2_CARD_ERP_STOCK)와 대조한다.
--               CARD_CODE_ERP 우선, 없으면 CARD_CODE 로도 찾는다.
--   sales_codes 매출을 조회할 품목코드(S2_Card.Card_Code). 콤마로 여러 개 가능.
--               비어 있으면 매출/판매수량을 집계하지 않는다.
--
-- 왜 나누는가:
--   재고는 ERP코드에 매핑돼 있고 판매는 품목코드로 일어나는데, 둘의 관계가
--   1:N 이고 일정하지 않다 (답례품 범위 ERP코드 156 / 품목코드 166, 1:N 19건).
--   자동으로 묶으면 의도치 않은 코드까지 합산되므로, 어떤 코드의 매출을 볼지
--   운영이 직접 지정한다.
--
-- 이 파일 하나만 실행하면 어떤 상태에서도 최종 스키마가 된다 (멱등).
--   · 테이블 없음                          → 새로 생성
--   · 044 초판 (product_code + stock_code) → 이관
--   · 045 (erp_code)                       → 이관
--   · 이미 최신                            → 변화 없음
-- ============================================

CREATE TABLE IF NOT EXISTS bg_stock_items (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stock_code    TEXT,
  sales_codes   TEXT,
  label         TEXT,
  threshold     INTEGER,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  alert_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  memo          TEXT,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
DECLARE
  has_erp  boolean;
  has_prod boolean;
  has_stk  boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='bg_stock_items' AND column_name='erp_code')     INTO has_erp;
  SELECT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='bg_stock_items' AND column_name='product_code') INTO has_prod;
  SELECT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='bg_stock_items' AND column_name='stock_code')   INTO has_stk;

  IF NOT has_stk THEN
    ALTER TABLE bg_stock_items ADD COLUMN stock_code TEXT;
    has_stk := true;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='bg_stock_items' AND column_name='sales_codes') THEN
    ALTER TABLE bg_stock_items ADD COLUMN sales_codes TEXT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='bg_stock_items' AND column_name='alert_enabled') THEN
    ALTER TABLE bg_stock_items ADD COLUMN alert_enabled BOOLEAN NOT NULL DEFAULT TRUE;
  END IF;

  -- 045 스키마: erp_code → stock_code
  IF has_erp THEN
    EXECUTE 'UPDATE bg_stock_items SET stock_code = COALESCE(NULLIF(btrim(stock_code), ''''), erp_code)';
    ALTER TABLE bg_stock_items DROP COLUMN erp_code;
  END IF;

  -- 044 초판 스키마: product_code → sales_codes (재고코드는 기존 stock_code 유지)
  IF has_prod THEN
    EXECUTE 'UPDATE bg_stock_items
                SET sales_codes = COALESCE(NULLIF(btrim(sales_codes), ''''), product_code),
                    stock_code  = COALESCE(NULLIF(btrim(stock_code), ''''), product_code)';
    ALTER TABLE bg_stock_items DROP COLUMN product_code;
  END IF;
END $$;

DELETE FROM bg_stock_items WHERE stock_code IS NULL OR btrim(stock_code) = '';

ALTER TABLE bg_stock_items ALTER COLUMN stock_code SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'bg_stock_items'::regclass AND contype = 'u') THEN
    ALTER TABLE bg_stock_items ADD CONSTRAINT bg_stock_items_stock_code_key UNIQUE (stock_code);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'bg_stock_items'::regclass AND conname = 'bg_si_threshold_chk') THEN
    ALTER TABLE bg_stock_items ADD CONSTRAINT bg_si_threshold_chk
      CHECK (threshold IS NULL OR threshold >= 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_bg_si_enabled ON bg_stock_items (enabled, sort_order);

COMMENT ON TABLE bg_stock_items IS '답례품 재고 관리 품목 (수동 등록) — 재고 화면/슬랙 알림의 유일한 대상 목록';
COMMENT ON COLUMN bg_stock_items.stock_code  IS '재고 조회용 코드 — S2_CARD_ERP_STOCK.CARD_CODE_ERP (없으면 CARD_CODE)';
COMMENT ON COLUMN bg_stock_items.sales_codes IS '매출 조회용 품목코드(S2_Card.Card_Code). 콤마로 여러 개 지정 가능';
COMMENT ON COLUMN bg_stock_items.threshold   IS '가용재고 임계치 — 이하면 경고. NULL 이면 소진예상 30일 기준';

-- 2026-10-30 이후 Supabase 신규 테이블 default behavior 대응
GRANT ALL ON TABLE bg_stock_items TO anon, authenticated, service_role;
