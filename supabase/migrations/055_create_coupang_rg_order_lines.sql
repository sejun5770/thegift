-- ============================================
-- 055_create_coupang_rg_order_lines.sql
--
-- 로켓그로스 주문 단위 라인 — 두 리포트를 한 행에 합친다.
--
-- 배경 (운영 요청 2026-08-07):
--   로켓그로스 매출을 결제완료일/배송완료일 두 각도로 보고, 매출·수수료·물류비·정산금액을
--   한 줄에서 확인하려 한다. 필요한 값이 두 리포트에 나뉘어 있다.
--     · 파일1 CATEGORY_TR (판매 수수료)  → 결제완료일 · 매출 · 수수료 · 정산대상액
--     · 파일2 WAREHOUSING_SHIPPING (CFS) → 배송완료일 · 입출고비 · 배송비
--
--   기존 coupang_rocket_growth_sales 는 (매출인식일, 옵션ID) 로 합산 저장이라 주문ID가
--   버려진다. 같은 날 같은 옵션 주문이라도 배송완료일이 제각각(1일 365건·2일 19건·3일+ 7건)
--   이라, 합쳐진 금액은 배송완료일별로 되쪼갤 수 없다. 그래서 주문 단위 테이블을 따로 둔다.
--
-- 설계:
--   · UNIQUE (order_id, vendor_item_id) — 두 파일이 같은 행을 각자 채운다.
--     업로드 순서와 무관하고, 같은 파일을 다시 올려도 덮어쓰기라 중복 계상되지 않는다.
--   · 파일1 컬럼과 파일2 컬럼을 나눠 두어 어느 리포트가 아직 안 올라왔는지 NULL 로 드러난다.
--   · 기존 집계 테이블은 그대로 둔다 — 대시보드 매출이 그것을 쓰고 있어 건드리면 파급이 크다.
--
-- 주의: 두 리포트 모두 '매출인식일' 컬럼이 있지만 가리키는 날짜가 다르다.
--   파일1 의 매출인식일 = 결제완료일, 파일2 의 매출인식일 = 배송완료일.
--   그래서 이름이 아니라 '발생일(...)' 를 명시적으로 읽는다 (파서 주석 참고).
-- ============================================

CREATE TABLE IF NOT EXISTS coupang_rg_order_lines (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id          TEXT NOT NULL,
  vendor_item_id    TEXT NOT NULL,          -- 옵션ID

  -- ── 파일1: CATEGORY_TR (판매 수수료 리포트) ──
  paid_date         DATE,                   -- 발생일(결제완료일)
  product_name      TEXT,                   -- 등록상품명 / 옵션명
  sales_qty         INTEGER,
  sales_amount      NUMERIC(14, 2),         -- 매출금액(A*B-C)
  commission        NUMERIC(14, 2),         -- 판매수수료 + VAT
  settlement_amount NUMERIC(14, 2),         -- 정산대상액
  is_cancel         BOOLEAN NOT NULL DEFAULT FALSE,  -- 거래유형이 '취소' 계열

  -- ── 파일2: WAREHOUSING_SHIPPING (CFS 정산) ──
  delivered_date    DATE,                   -- 발생일(배송완료일)
  inout_fee         NUMERIC(14, 2),         -- 입출고비 (VAT 별도)
  shipping_fee      NUMERIC(14, 2),         -- 배송비 (VAT 별도)

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS coupang_rg_lines_uniq
  ON coupang_rg_order_lines (order_id, vendor_item_id);
CREATE INDEX IF NOT EXISTS idx_coupang_rg_lines_paid      ON coupang_rg_order_lines (paid_date);
CREATE INDEX IF NOT EXISTS idx_coupang_rg_lines_delivered ON coupang_rg_order_lines (delivered_date);

COMMENT ON TABLE  coupang_rg_order_lines IS
  '로켓그로스 주문 단위 라인 — 판매 수수료 리포트와 CFS 정산 내역을 (주문ID, 옵션ID) 로 합친다';
COMMENT ON COLUMN coupang_rg_order_lines.paid_date      IS '파일1 발생일(결제완료일)';
COMMENT ON COLUMN coupang_rg_order_lines.delivered_date IS '파일2 발생일(배송완료일) — 결제완료일보다 보통 1일 늦다';
COMMENT ON COLUMN coupang_rg_order_lines.commission     IS '판매수수료 + 판매수수료 VAT';

GRANT ALL ON TABLE coupang_rg_order_lines TO anon, authenticated, service_role;
