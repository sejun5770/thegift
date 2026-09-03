-- ============================================
-- 045_fix_bg_stock_items_erp_code.sql
--
-- bg_stock_items 를 ERP코드 기준 스키마로 정렬한다.
--
-- 배경:
--   044 를 처음 배포할 때 등록 단위를 품목코드(product_code + stock_code)로
--   잡았다가, 재고가 ERP코드(CARD_CODE_ERP)에 매핑돼 있다는 운영 확인에 따라
--   erp_code 단일 키로 바꿨다. 044 파일은 교체했지만, 이전 버전을 이미 실행한
--   DB 에는 옛 스키마 테이블이 남아 있어 재실행 시
--     ERROR: column "erp_code" of relation "bg_stock_items" does not exist
--   가 난다 (CREATE TABLE IF NOT EXISTS 가 건너뛴 뒤 COMMENT 에서 실패).
--
-- 이 파일 하나만 실행하면 어떤 상태에서도 최종 스키마가 된다.
--   · 테이블 없음      → 새로 생성
--   · 옛 스키마로 존재 → erp_code 추가 + 기존 값 이관 + 옛 컬럼 제거
--   · 이미 최신        → 아무 변화 없음 (멱등)
-- ============================================

-- 1) 테이블이 아예 없으면 최종 스키마로 생성
CREATE TABLE IF NOT EXISTS bg_stock_items (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  erp_code      TEXT,
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

-- 2) 옛 스키마 → 새 스키마
DO $$
BEGIN
  -- erp_code 컬럼 확보
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'bg_stock_items'
                   AND column_name = 'erp_code') THEN
    ALTER TABLE bg_stock_items ADD COLUMN erp_code TEXT;
  END IF;

  -- alert_enabled 가 없던 버전 대비
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'bg_stock_items'
                   AND column_name = 'alert_enabled') THEN
    ALTER TABLE bg_stock_items ADD COLUMN alert_enabled BOOLEAN NOT NULL DEFAULT TRUE;
  END IF;

  -- 옛 컬럼이 있으면 값을 옮기고 제거한다.
  --   stock_code(재고 조회용) 가 erp_code 에 가장 가까우므로 우선 사용.
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'bg_stock_items'
               AND column_name = 'product_code') THEN
    EXECUTE 'UPDATE bg_stock_items
                SET erp_code = COALESCE(erp_code, NULLIF(btrim(stock_code), ''''), product_code)
              WHERE erp_code IS NULL';
    ALTER TABLE bg_stock_items DROP COLUMN IF EXISTS stock_code;
    ALTER TABLE bg_stock_items DROP COLUMN IF EXISTS product_code;
  END IF;
END $$;

-- 3) 빈 값 정리 후 제약 부여
DELETE FROM bg_stock_items WHERE erp_code IS NULL OR btrim(erp_code) = '';

ALTER TABLE bg_stock_items ALTER COLUMN erp_code SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'bg_stock_items'::regclass AND contype = 'u') THEN
    ALTER TABLE bg_stock_items ADD CONSTRAINT bg_stock_items_erp_code_key UNIQUE (erp_code);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'bg_stock_items'::regclass AND conname = 'bg_si_threshold_chk') THEN
    ALTER TABLE bg_stock_items ADD CONSTRAINT bg_si_threshold_chk
      CHECK (threshold IS NULL OR threshold >= 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_bg_si_enabled ON bg_stock_items (enabled, sort_order);

COMMENT ON TABLE bg_stock_items IS '답례품 재고 관리 품목 (수동 등록, ERP코드 기준) — 재고 화면/슬랙 알림의 유일한 대상 목록';
COMMENT ON COLUMN bg_stock_items.erp_code IS 'S2_CARD_ERP_STOCK.CARD_CODE_ERP — 재고가 매핑된 코드. 판매는 이 코드에 딸린 품목코드들을 합산';
COMMENT ON COLUMN bg_stock_items.threshold IS '가용재고 임계치 — 이하면 경고. NULL 이면 소진예상 30일 기준';

-- 2026-10-30 이후 Supabase 신규 테이블 default behavior 대응
GRANT ALL ON TABLE bg_stock_items TO anon, authenticated, service_role;
