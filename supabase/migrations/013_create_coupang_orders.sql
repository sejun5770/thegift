-- ============================================
-- 013_create_coupang_orders.sql
--
-- 쿠팡 Wing API 에서 수집한 답례품 주문 보관.
-- MSSQL custom_order / CUSTOM_ETC_ORDER 와 별개 — 외부 마켓플레이스 채널.
-- apiOrders 가 MSSQL + Supabase coupang_orders UNION 으로 통합 조회.
--
-- 필터: 쿠팡 카테고리 '출산/유아동>출산준비물/선물>돌잔치답례품>기타답례품' 만 수집.
-- ============================================

CREATE TABLE IF NOT EXISTS coupang_orders (
  -- 식별자
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 쿠팡 주문 식별 — vendor + order + shipment 조합으로 unique
  coupang_order_id BIGINT NOT NULL,           -- 쿠팡 orderId (BIGINT)
  shipment_box_id BIGINT NOT NULL,            -- 배송 단위 (분리배송 대응)
  vendor_item_id BIGINT,                       -- 쿠팡 상품 매핑 id (옵션)
  vendor_item_package_id BIGINT,               -- 묶음 상품 id (옵션)

  -- 주문 정보
  ordered_at TIMESTAMPTZ NOT NULL,            -- 주문 일시
  paid_at TIMESTAMPTZ,                         -- 결제 완료 일시 (없으면 미결제)

  -- 상품 정보 (한 row = 한 상품 단위)
  product_name TEXT NOT NULL,
  product_code TEXT,                           -- 쿠팡 셀러센터 상품코드 (있으면)
  external_vendor_sku TEXT,                    -- 셀러 등록 SKU (있으면)
  item_count INTEGER NOT NULL DEFAULT 1,
  item_sale_price INTEGER NOT NULL DEFAULT 0,  -- 단가 (할인 후)
  item_total_price INTEGER NOT NULL DEFAULT 0, -- 행 합계 (단가 × 수량)

  -- 수령인 / 배송지 (마스킹 X — 운영 화면용)
  recv_name TEXT,
  recv_hphone TEXT,
  recv_address TEXT,
  recv_postal_code TEXT,
  recv_message TEXT,

  -- 결제 정보
  settle_price INTEGER NOT NULL DEFAULT 0,    -- 주문 결제금액 (배송비 포함 가능)
  settle_method TEXT,                         -- 쿠팡 API 결제수단 코드 (raw 보존, frontend 에서 라벨)

  -- 주문 상태
  status TEXT NOT NULL,                        -- 쿠팡 status: ACCEPT / INSTRUCT / DEPARTURE / DELIVERING / FINAL_DELIVERY / NONE_TRACKING / CANCEL ...
  status_label TEXT,                           -- 한글 라벨

  -- 동기화 메타
  raw_payload JSONB,                           -- 쿠팡 API 응답 원본 (디버깅/재처리용)
  synced_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),

  -- 같은 (order_id, shipment_box_id, vendor_item_id) 조합은 unique — upsert 키
  UNIQUE (coupang_order_id, shipment_box_id, vendor_item_id)
);

-- 빠른 조회용 인덱스
CREATE INDEX IF NOT EXISTS idx_coupang_orders_ordered_at ON coupang_orders(ordered_at DESC);
CREATE INDEX IF NOT EXISTS idx_coupang_orders_paid_at ON coupang_orders(paid_at DESC);
CREATE INDEX IF NOT EXISTS idx_coupang_orders_status ON coupang_orders(status);
CREATE INDEX IF NOT EXISTS idx_coupang_orders_synced_at ON coupang_orders(synced_at DESC);

-- updated_at 자동 갱신 트리거 (001 마이그레이션의 update_updated_at 함수 사용)
DROP TRIGGER IF EXISTS coupang_orders_updated_at ON coupang_orders;
CREATE TRIGGER coupang_orders_updated_at
  BEFORE UPDATE ON coupang_orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- 마지막 동기화 메타 보관 (전역 1행) — 다음 sync 의 fromTime 기준점
CREATE TABLE IF NOT EXISTS coupang_sync_state (
  id INTEGER PRIMARY KEY DEFAULT 1,           -- always 1
  last_synced_at TIMESTAMPTZ,                  -- 마지막 동기화 실행 시각
  last_synced_order_count INTEGER DEFAULT 0,   -- 마지막 동기화에서 가져온 row 수
  last_error TEXT,                             -- 마지막 에러 메시지 (있으면)
  updated_at TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT coupang_sync_state_singleton CHECK (id = 1)
);

INSERT INTO coupang_sync_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
