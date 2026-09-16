-- ============================================
-- 048_create_bg_stock_bom.sql
--
-- 답례품 BOM (1단: 판매코드 → 재고품목).
--
-- 배경:
--   한 원물이 단독으로도 팔리고 여러 세트에도 들어가, 재고는 그 모든 경로에서 빠진다.
--   ERP 에 BOM 이 있지만 bar_shop1 으로 넘어오지 않아 (047 까지는) 소진코드를
--   품목마다 손으로 적어야 했다. 세트 구성이 바뀌면 사람이 갱신해야 하고,
--   빠뜨리면 소진예상일이 조용히 틀린다.
--     주방세제: 단독만 세면 144개/30일 → 1,699일, 전 경로 329개 → 743일
--
-- 설계 (운영 결정 2026-08-05):
--   1단만 관리한다. 반제(SFG-) 계층은 재현하지 않고, 판매되는 코드에서
--   재고 관리 품목으로 바로 연결하며 최종 소요수량만 적는다.
--
--   parent_code       판매가 일어나는 품목코드 (S2_Card.Card_Code)
--   child_stock_code  재고 관리 품목의 재고코드 (bg_stock_items.stock_code = ERP코드)
--   qty               parent 1개 판매 시 child 가 빠지는 수량 (데일리너츠 = 5)
--
--   소진 수량 계산 우선순위:
--     1) bg_stock_items.consumption_codes 를 직접 적었으면 그것만 사용
--     2) 없으면 BOM 으로 자동 구성 (매출코드 ×1 + BOM parent × qty, BOM 이 우선)
--     3) BOM 도 없으면 매출코드를 ×1 로 사용 (기존 동작)
-- ============================================

CREATE TABLE IF NOT EXISTS bg_stock_bom (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_code      TEXT NOT NULL,          -- 판매 품목코드
  child_stock_code TEXT NOT NULL,          -- 구성품의 재고코드(ERP코드)
  qty              INTEGER NOT NULL DEFAULT 1,
  memo             TEXT,
  created_by       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT bg_bom_qty_chk CHECK (qty >= 1),
  CONSTRAINT bg_bom_uniq UNIQUE (parent_code, child_stock_code)
);

CREATE INDEX IF NOT EXISTS idx_bg_bom_child ON bg_stock_bom (child_stock_code);

COMMENT ON TABLE bg_stock_bom IS '답례품 BOM (1단) — 판매코드 1개당 재고품목이 몇 개 빠지는지';
COMMENT ON COLUMN bg_stock_bom.parent_code      IS '판매가 일어나는 품목코드 (S2_Card.Card_Code)';
COMMENT ON COLUMN bg_stock_bom.child_stock_code IS '구성품의 재고코드 — bg_stock_items.stock_code (ERP코드)';
COMMENT ON COLUMN bg_stock_bom.qty              IS 'parent 1개당 child 소요수량';

-- 2026-10-30 이후 Supabase 신규 테이블 default behavior 대응
GRANT ALL ON TABLE bg_stock_bom TO anon, authenticated, service_role;
