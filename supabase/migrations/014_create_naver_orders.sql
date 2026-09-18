-- ============================================
-- 014_create_naver_orders.sql
--
-- 네이버 스마트스토어(커머스 API) 에서 수집한 답례품 주문 보관.
-- 쿠팡(coupang_orders)과 동일 패턴 — 별도 마켓플레이스 채널.
-- apiOrders 가 MSSQL + Supabase coupang_orders + naver_orders UNION.
-- ============================================

CREATE TABLE IF NOT EXISTS naver_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 네이버 주문 식별 — productOrderId 단위 (한 orderId 에 여러 productOrder 가능)
  product_order_id TEXT NOT NULL UNIQUE,       -- 네이버 productOrderId (string)
  order_id TEXT NOT NULL,                       -- 네이버 orderId (parent)

  -- 주문 정보
  ordered_at TIMESTAMPTZ NOT NULL,             -- 주문 일시
  paid_at TIMESTAMPTZ,                          -- 결제 완료 일시

  -- 상품 정보
  product_name TEXT NOT NULL,
  product_option TEXT,                          -- 옵션명 (있으면)
  product_code TEXT,                            -- 셀러 상품 코드 (있으면)
  category_id TEXT,                             -- 네이버 카테고리 ID (필터링용)
  category_name TEXT,                           -- 네이버 카테고리 명 (가독성)
  item_count INTEGER NOT NULL DEFAULT 1,
  item_sale_price INTEGER NOT NULL DEFAULT 0,   -- 단가
  item_total_price INTEGER NOT NULL DEFAULT 0,  -- 행 합계

  -- 수령인 / 배송지
  recv_name TEXT,
  recv_hphone TEXT,
  recv_address TEXT,
  recv_postal_code TEXT,
  recv_message TEXT,

  -- 결제 정보
  settle_price INTEGER NOT NULL DEFAULT 0,
  settle_method TEXT,                           -- 네이버 paymentMeans (raw 보존)

  -- 주문 상태
  status TEXT NOT NULL,                          -- 네이버 productOrderStatus: PAYED / DELIVERING / DELIVERED / CANCELED ...
  status_label TEXT,

  -- 동기화 메타
  raw_payload JSONB,
  synced_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_naver_orders_ordered_at ON naver_orders(ordered_at DESC);
CREATE INDEX IF NOT EXISTS idx_naver_orders_paid_at ON naver_orders(paid_at DESC);
CREATE INDEX IF NOT EXISTS idx_naver_orders_status ON naver_orders(status);
CREATE INDEX IF NOT EXISTS idx_naver_orders_synced_at ON naver_orders(synced_at DESC);

DROP TRIGGER IF EXISTS naver_orders_updated_at ON naver_orders;
CREATE TRIGGER naver_orders_updated_at
  BEFORE UPDATE ON naver_orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- 동기화 메타 (싱글톤)
CREATE TABLE IF NOT EXISTS naver_sync_state (
  id INTEGER PRIMARY KEY DEFAULT 1,
  last_synced_at TIMESTAMPTZ,
  last_synced_order_count INTEGER DEFAULT 0,
  last_error TEXT,
  updated_at TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT naver_sync_state_singleton CHECK (id = 1)
);

INSERT INTO naver_sync_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
