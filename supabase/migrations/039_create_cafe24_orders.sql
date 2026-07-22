-- ============================================
-- 039_create_cafe24_orders.sql
--
-- 정수당(카페24, mall_id: barunn01) Admin API 에서 수집한 답례품 주문 보관.
-- MSSQL custom_order / CUSTOM_ETC_ORDER 와 별개 — 외부 커머스 채널.
-- apiOrders 가 MSSQL + Supabase coupang_orders + naver_orders + cafe24_orders
--   UNION 으로 통합 조회. (013_create_coupang_orders.sql 미러)
--
-- OAuth 토큰은 038_cafe24_integration.sql 의 cafe24_tokens 사용.
-- RLS/GRANT 정책은 coupang_orders(013) 와 동일 — 명시적 RLS/GRANT 없이 기본 grant
--   (오늘 기준 2026-10-30 이전이라 새 CREATE TABLE 도 명시 GRANT 불필요, 기존 채널과 일관).
-- ============================================

CREATE TABLE IF NOT EXISTS cafe24_orders (
  -- 식별자
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 카페24 주문 식별 — order_id(문자열) + line_key(품목 단위) 조합으로 unique
  cafe24_order_id TEXT NOT NULL,               -- 카페24 order_id (예: '20260722-0000012')
  line_key TEXT NOT NULL,                       -- 품목 line 식별 (order_item_code 우선, 없으면 product_no:index)
  product_no BIGINT,                            -- 카페24 상품 번호 (있으면)

  -- 주문 정보
  ordered_at TIMESTAMPTZ NOT NULL,             -- 주문 일시 (order_date)
  paid_at TIMESTAMPTZ,                          -- 결제 완료 일시 (없으면 미결제)

  -- 상품 정보 (한 row = 한 품목 단위)
  product_name TEXT NOT NULL,
  product_code TEXT,                            -- 카페24 상품코드 (있으면)
  item_count INTEGER NOT NULL DEFAULT 1,
  item_sale_price INTEGER NOT NULL DEFAULT 0,   -- 단가 (product_price)
  item_total_price INTEGER NOT NULL DEFAULT 0,  -- 행 합계 (단가 × 수량)

  -- 수령인 / 배송지 (마스킹 X — 직접 출고/배송 특성상 원문 보존, mapper.ts §주2 결정)
  recv_name TEXT,
  recv_hphone TEXT,
  recv_address TEXT,
  recv_postal_code TEXT,
  recv_message TEXT,

  -- 결제 정보
  settle_price INTEGER NOT NULL DEFAULT 0,     -- 주문 결제금액 (payment_amount)
  settle_method TEXT,                          -- 카페24 결제수단 (raw 보존, frontend 에서 라벨)

  -- 주문 상태
  status TEXT NOT NULL,                         -- 카페24 order_status (또는 paid/canceled 파생값)
  status_label TEXT,                            -- 한글 라벨

  -- 답례품 운영 필드 (옵션 파싱)
  desired_shipping_date DATE,                   -- 희망출고일 (옵션에서 파싱, 없으면 주문일+3영업일)
  shipping_method TEXT,                         -- 'parcel' | 'same_day' ('오늘출발' 품목 포함 여부)
  input_message TEXT,                           -- 스티커 문구 (옵션에서 파싱)

  -- 동기화 메타
  raw_payload JSONB,                            -- 카페24 API 응답 원본 (디버깅/재처리용)
  synced_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),

  -- 같은 (order_id, line_key) 조합은 unique — upsert 키
  UNIQUE (cafe24_order_id, line_key)
);

-- 빠른 조회용 인덱스
CREATE INDEX IF NOT EXISTS idx_cafe24_orders_ordered_at ON cafe24_orders(ordered_at DESC);
CREATE INDEX IF NOT EXISTS idx_cafe24_orders_paid_at ON cafe24_orders(paid_at DESC);
CREATE INDEX IF NOT EXISTS idx_cafe24_orders_status ON cafe24_orders(status);
CREATE INDEX IF NOT EXISTS idx_cafe24_orders_synced_at ON cafe24_orders(synced_at DESC);

-- updated_at 자동 갱신 트리거 (001 마이그레이션의 update_updated_at 함수 사용)
DROP TRIGGER IF EXISTS cafe24_orders_updated_at ON cafe24_orders;
CREATE TRIGGER cafe24_orders_updated_at
  BEFORE UPDATE ON cafe24_orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- 마지막 동기화 메타 보관 (전역 1행) — 다음 sync 의 since 기준점
CREATE TABLE IF NOT EXISTS cafe24_sync_state (
  id INTEGER PRIMARY KEY DEFAULT 1,            -- always 1
  last_synced_at TIMESTAMPTZ,                   -- 마지막 동기화 실행 시각
  last_synced_order_count INTEGER DEFAULT 0,    -- 마지막 동기화에서 가져온 row 수
  last_error TEXT,                              -- 마지막 에러 메시지 (있으면)
  updated_at TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT cafe24_sync_state_singleton CHECK (id = 1)
);

INSERT INTO cafe24_sync_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
