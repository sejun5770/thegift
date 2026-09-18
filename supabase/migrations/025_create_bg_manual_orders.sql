-- ============================================
-- bg_manual_orders: MSSQL 누락 사고 케이스 수동 주문 등록
--
-- 배경:
--   바른손몰 B2B 등 외부 PG 연동에서 결제 완료 후 bar_shop1 동기화 중
--   CUSTOM_ETC_ORDER_ITEM 등 일부 테이블 누락 사고가 발생할 수 있음.
--   주문 자체는 결제 완료지만 우리 시스템 (정보입력현황 / 매출집계) 에 안 잡힘.
--
-- 사고 예시 (3246585):
--   · CUSTOM_ETC_ORDER 헤더 정상 존재 (679,800원, 네이버페이)
--   · CUSTOM_ETC_ORDER_ITEM 누락 → 시스템에서 주문 조회 불가
--   · 운영자가 admin 메모 + 수동으로 작업 진행
--
-- 해결책:
--   운영자가 정보입력현황 페이지에서 직접 수동 주문 등록 → 동일 워크플로우 진행.
--   원본 시스템 데이터 복구 전까지의 임시 운영 대체.
-- ============================================

CREATE TABLE IF NOT EXISTS bg_manual_orders (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id            TEXT NOT NULL UNIQUE,               -- 운영자 입력 (실제 missing order_seq 또는 임시 ID)

  -- 주문자
  order_name          TEXT NOT NULL,
  order_hphone        TEXT,
  order_email         TEXT,

  -- 수령인 / 배송
  recv_name           TEXT,
  recv_hphone         TEXT,
  recv_address        TEXT,
  recv_zip            TEXT,
  recv_msg            TEXT,

  -- 주문 정보
  order_date          TIMESTAMPTZ NOT NULL DEFAULT NOW(), -- 사고 시점 또는 운영자 입력
  settle_price        INTEGER NOT NULL DEFAULT 0,
  settle_method       TEXT,                                -- '1'~'9' FirstMall 컨벤션
  status_seq          INTEGER NOT NULL DEFAULT 4,          -- 4=결제확인 (정상 사고 복구 가정)

  -- 상품 (JSONB 배열) — [{product_code, product_name, quantity, unit_price, ...}]
  items               JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- 메타데이터
  site_name           TEXT,                                -- '바른손몰 B2B' 등 (자유 입력)
  company_seq         TEXT,                                -- 원본 company_Seq (있다면)
  category            TEXT NOT NULL DEFAULT 'daeryepum',   -- daeryepum / deco / flower / consignment

  source_memo         TEXT,                                -- 사고 출처 메모 ('bhands_b2b CUSTOM_ETC_ORDER_ITEM 누락' 등)
  created_by          TEXT,                                -- admin user_id
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bg_manual_orders_order_id ON bg_manual_orders (order_id);
CREATE INDEX IF NOT EXISTS idx_bg_manual_orders_order_date ON bg_manual_orders (order_date DESC);
CREATE INDEX IF NOT EXISTS idx_bg_manual_orders_category ON bg_manual_orders (category);

COMMENT ON TABLE bg_manual_orders IS 'MSSQL 누락 사고 케이스 수동 주문 등록 — 정보입력현황 + 워크플로우 통합';

-- 2026-10-30 이후 Supabase 신규 테이블 default behavior 대응
GRANT ALL ON TABLE bg_manual_orders TO anon, authenticated, service_role;
