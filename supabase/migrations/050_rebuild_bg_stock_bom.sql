-- ============================================
-- 050_rebuild_bg_stock_bom.sql
--
-- BOM 재구성 — "재고품목이 어디서 빠지나"(역방향) → "판매상품이 무엇으로 구성되나"(정방향).
--
-- 배경 (운영 지적 2026-08-07):
--   048 은 테이블 방향은 parent→child 로 맞았지만, 실제 쓰임이 재고품목 관점이었다.
--     · 구성품이 bg_stock_items 에 등록돼 있어야만 존재할 수 있었다
--       → 핸드워시 패키지 같은 부자재는 BOM 에 넣어도 화면 어디에도 안 나왔다.
--     · bg_stock_items.consumption_codes(소진코드) 가 BOM 보다 우선해서,
--       BOM 을 제대로 채워도 옛 소진코드가 남아 있으면 조용히 무시됐다.
--   BOM 은 "핸드워시 기프트 1개 = 원물 1 + 패키지 1 + 띠지 1" 처럼
--   판매상품의 구성을 정의하는 것이고, 소진 수량은 거기서 파생돼야 한다.
--
-- 이 마이그레이션이 하는 일:
--   1. child_stock_code → component_code 로 개명 (재고품목이어야 한다는 함의 제거)
--   2. component_role 추가 — 원물/부자재/포장재/기타
--   3. consumption_codes 를 BOM 행으로 이관한 뒤 컬럼 삭제 (BOM 이 유일한 기준)
--
-- 048 을 아직 실행하지 않았어도 이 파일 하나로 최종 상태가 된다. 재실행해도 안전하다.
--
-- 소진 수량 계산 (050 이후):
--   재고코드 X 의 30일 소진
--     = Σ (component_code = X 인 BOM 행의 parent_code 30일 판매수량 × qty)
--     + (BOM parent 에 없는 매출코드의 30일 판매수량 × 1)   ← X 자체가 직접 팔린 몫
-- ============================================

-- ── 1. 테이블 (048 미실행 대비 — 처음부터 최종 형태로 생성) ──────────────
CREATE TABLE IF NOT EXISTS bg_stock_bom (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_code    TEXT NOT NULL,
  component_code TEXT NOT NULL,
  qty            INTEGER NOT NULL DEFAULT 1,
  component_role TEXT NOT NULL DEFAULT 'material',
  memo           TEXT,
  created_by     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT bg_bom_qty_chk CHECK (qty >= 1)
);

-- ── 2. 048 로 이미 만들어진 경우 업그레이드 ─────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'bg_stock_bom' AND column_name = 'child_stock_code') THEN
    ALTER TABLE bg_stock_bom RENAME COLUMN child_stock_code TO component_code;
  END IF;
END $$;

ALTER TABLE bg_stock_bom ADD COLUMN IF NOT EXISTS component_role TEXT NOT NULL DEFAULT 'material';

-- 역할 값 고정. 기존 행은 기본값 'material' 로 들어가므로 제약 추가 전에 정리할 것이 없다.
ALTER TABLE bg_stock_bom DROP CONSTRAINT IF EXISTS bg_bom_role_chk;
ALTER TABLE bg_stock_bom ADD  CONSTRAINT bg_bom_role_chk
  CHECK (component_role IN ('product', 'material', 'package', 'etc'));

-- UNIQUE 를 인덱스로 재생성 (컬럼 개명 후 제약 이름/대상 정리 + PostgREST upsert 대상)
ALTER TABLE bg_stock_bom DROP CONSTRAINT IF EXISTS bg_bom_uniq;
DROP INDEX IF EXISTS bg_bom_uniq;
CREATE UNIQUE INDEX bg_bom_uniq ON bg_stock_bom (parent_code, component_code);

DROP INDEX IF EXISTS idx_bg_bom_child;
CREATE INDEX IF NOT EXISTS idx_bg_bom_component ON bg_stock_bom (component_code);

COMMENT ON TABLE  bg_stock_bom                IS '답례품 BOM (1단) — 판매상품 1개의 구성품 목록';
COMMENT ON COLUMN bg_stock_bom.parent_code    IS '판매가 일어나는 품목코드 (S2_Card.Card_Code)';
COMMENT ON COLUMN bg_stock_bom.component_code IS '구성품 코드. 재고관리 품목이 아니어도 등록 가능 (부자재/포장재)';
COMMENT ON COLUMN bg_stock_bom.qty            IS 'parent 1개당 구성품 소요수량';
COMMENT ON COLUMN bg_stock_bom.component_role IS 'product=원물 / material=부자재 / package=포장재 / etc=기타';

-- ── 3. 소진코드 이관 후 폐기 ────────────────────────────────────────────
--   'TGJBK09D2,TGJBK03O1*5' → (parent=TGJBK09D2, component=해당품목의 stock_code, qty=1),
--                             (parent=TGJBK03O1, component=..., qty=5)
--   이미 같은 (parent, component) BOM 행이 있으면 BOM 을 우선한다 (DO NOTHING).
--   컬럼 존재 여부로 감싸 재실행에도 안전.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'bg_stock_items' AND column_name = 'consumption_codes') THEN

    INSERT INTO bg_stock_bom (parent_code, component_code, qty, component_role, memo)
    SELECT DISTINCT
      btrim(split_part(tok, '*', 1)),
      i.stock_code,
      GREATEST(1, COALESCE(NULLIF(btrim(split_part(tok, '*', 2)), '')::int, 1)),
      'product',
      '소진코드에서 자동 이관 (050)'
    FROM bg_stock_items i
    CROSS JOIN LATERAL regexp_split_to_table(i.consumption_codes, ',') AS tok
    WHERE COALESCE(i.consumption_codes, '') <> ''
      AND btrim(split_part(tok, '*', 1)) <> ''
      AND COALESCE(i.stock_code, '') <> ''
    ON CONFLICT (parent_code, component_code) DO NOTHING;

    ALTER TABLE bg_stock_items DROP COLUMN consumption_codes;
  END IF;
END $$;

-- 2026-10-30 이후 Supabase 신규 테이블 default behavior 대응
GRANT ALL ON TABLE bg_stock_bom TO anon, authenticated, service_role;
