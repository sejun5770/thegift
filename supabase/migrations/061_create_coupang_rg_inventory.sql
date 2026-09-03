-- ============================================
-- 061_create_coupang_rg_inventory.sql
--
-- 로켓창고(쿠팡 물류센터) 재고 스냅샷.
--
-- 배경 (운영 요청 2026-08-07):
--   "로켓그로스에 입고하는 입고수량을 API 로 가져올 수 있나?"
--   확인 결과 쿠팡 Open API 의 로켓그로스 API 9종에 입고 관련 API 는 없다.
--   대신 로켓창고 재고 API 가 지금 팔 수 있는 수량을 준다.
--     GET /v2/providers/rg_open_api/apis/api/v1/vendors/{vendorId}/rg/inventory/summaries
--   "얼마나 밀어넣었나" 대신 "얼마나 남았나" 를 보는 셈이고,
--   재입고 시점 판단에는 오히려 이쪽이 직접적이다.
--
-- 설계:
--   · 옵션ID(vendor_item_id) 가 키 — API 응답의 자연 키이자 상품설정 매핑 키다.
--   · 스냅샷이다. 이력이 아니라 '마지막으로 본 값' 만 남긴다.
--     이력이 필요해지면 별도 테이블로 append 하는 편이 낫다 (이 테이블은 계속 덮인다).
--   · internal_product_code / sales_unit 은 동기화 시점의 상품설정을 굳혀 둔 값이다.
--     조회는 재고 화면이 다시 매핑하므로, 여기 값은 진단용(왜 안 잡히나) 으로 본다.
-- ============================================

CREATE TABLE IF NOT EXISTS coupang_rg_inventory (
  vendor_item_id        TEXT PRIMARY KEY,       -- 옵션ID
  external_sku_id       TEXT,                   -- 쿠팡 SKU ID
  internal_product_code TEXT,                   -- 매핑된 내부 매출코드 (동기화 시점 기준)
  orderable_qty         INTEGER NOT NULL DEFAULT 0,  -- 주문가능 수량 (옵션 단위)
  sales_unit            INTEGER NOT NULL DEFAULT 1,  -- 채널 판매단위 (060) — 옵션 1 = 실제 몇 개
  sales_count_30d       INTEGER,                -- 최근 30일 판매수 (API 제공)
  synced_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_coupang_rg_inv_code ON coupang_rg_inventory (internal_product_code);

COMMENT ON TABLE  coupang_rg_inventory IS
  '로켓창고 재고 스냅샷 — 쿠팡 물류센터의 주문가능 수량. 입고수량 API 는 존재하지 않아 이것으로 대신한다';
COMMENT ON COLUMN coupang_rg_inventory.orderable_qty IS
  'totalOrderableQuantity — 옵션 단위. 실제 개수는 orderable_qty × sales_unit';
COMMENT ON COLUMN coupang_rg_inventory.sales_unit IS
  'bg_product_settings.channel_sales_units.coupang (060). 미지정이면 1';

GRANT ALL ON TABLE coupang_rg_inventory TO anon, authenticated, service_role;
