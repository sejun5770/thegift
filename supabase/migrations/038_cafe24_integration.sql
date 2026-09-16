-- ============================================
-- 038_cafe24_integration.sql
--
-- 정수당(카페24, mall_id: barunn01) 주문 연동.
--   기존 barunson 수집 패턴과 동일하게 orders/order_items 로 수집.
--   - order_source 에 'cafe24' 허용
--   - cafe24_order_id (원본 주문번호) — 중복 수집 방지 유니크 키
--   - cafe24_tokens — OAuth 토큰 저장 (단일 행, service role 전용)
--
-- collection_runs.source 는 VARCHAR(50) 자유값이라 'cafe24' 추가 제약 불필요.
-- ============================================

-- 1) order_source 에 'cafe24' 허용 (기존 external/admin 유지)
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_order_source_check;
ALTER TABLE orders ADD CONSTRAINT orders_order_source_check
  CHECK (order_source IN ('external', 'admin', 'cafe24'));

-- 2) 카페24 원본 주문번호 (중복 수집 방지 유니크 키)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cafe24_order_id VARCHAR(40);
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_cafe24_order_id
  ON orders(cafe24_order_id) WHERE cafe24_order_id IS NOT NULL;

COMMENT ON COLUMN orders.cafe24_order_id IS '카페24 원본 주문번호(order_id) — 중복 수집 방지 유니크 키. order_number 는 CF-{order_id}.';

-- 3) 토큰 저장 (단일 행, service role 전용)
CREATE TABLE IF NOT EXISTS cafe24_tokens (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),  -- 단일 행 강제
  mall_id VARCHAR(50) NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  access_expires_at TIMESTAMPTZ NOT NULL,
  refresh_expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- RLS: service role 전용 (anon/authenticated 는 정책 없음 → 전면 차단).
--   service role 은 RLS 를 우회하며, 아래 GRANT 로 테이블 권한도 명시.
ALTER TABLE cafe24_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON cafe24_tokens FROM anon, authenticated;
GRANT ALL ON cafe24_tokens TO service_role;

COMMENT ON TABLE cafe24_tokens IS '카페24 OAuth 토큰 (단일 행). service role 전용. refresh_token 2주 만료 — 수집 주기(15분)로 갱신 보장.';
