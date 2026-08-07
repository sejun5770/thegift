-- ============================================
-- 063_create_coupang_option_map.sql
--
-- 옵션ID → 등록상품ID 맵.
--
-- 배경 (2026-08-07):
--   로켓그로스 주문 API 는 옵션ID(vendorItemId)만 주고 등록상품ID(sellerProductId)를 주지 않는다.
--   상품설정에는 대부분 등록상품ID 만 등록돼 있어(옵션ID 는 비타민답례품 하나뿐),
--   정산 리포트가 올라오기 전 주문은 상품코드가 통째로 '미매핑' 으로 남았다.
--
--   쿠팡 상품 목록 API 가 등록상품 안에 옵션을 함께 내려준다.
--     GET /v2/providers/seller_api/apis/api/v1/marketplace/seller-products?businessTypes=rocketGrowth
--     data[].sellerProductId + data[].items[].{marketPlaceItem|rocketGrowthItem}.vendorItemId
--   이걸 미리 받아 두면 옵션ID 만 아는 주문도 등록상품ID 로 이어져 기존 매핑이 그대로 걸린다.
--
-- 설계:
--   · 스냅샷이다. 이력이 아니라 '마지막으로 본 값' 만 남긴다.
--   · 상품설정을 대체하지 않는다. 상품설정의 옵션ID 직접 매핑이 여전히 우선이고,
--     이 표는 그것이 없을 때만 등록상품ID 로 이어주는 다리 역할이다.
-- ============================================

CREATE TABLE IF NOT EXISTS coupang_option_map (
  vendor_item_id    TEXT PRIMARY KEY,        -- 옵션ID
  seller_product_id TEXT NOT NULL,           -- 등록상품ID
  product_name      TEXT,
  item_name         TEXT,                    -- 옵션명
  business_type     TEXT,                    -- 'rocketGrowth' | 'marketPlace'
  synced_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_coupang_option_map_product
  ON coupang_option_map (seller_product_id);

COMMENT ON TABLE coupang_option_map IS
  '쿠팡 옵션ID → 등록상품ID 맵 — 옵션ID 만 주는 API(로켓그로스 주문 등)를 기존 등록상품ID 매핑에 잇는다';

GRANT ALL ON TABLE coupang_option_map TO anon, authenticated, service_role;
