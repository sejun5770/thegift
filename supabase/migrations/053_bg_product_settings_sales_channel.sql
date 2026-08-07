-- ============================================
-- 053_bg_product_settings_sales_channel.sql
--
-- 상품설정에 판매채널을 둔다.
--
-- 배경 (운영 요청 2026-08-07):
--   쿠팡에 올린 상품은 입고·재고는 같은 코드(또는 변형코드, 예: TGCP01D1)를 쓰지만
--   스티커코드가 다르다 (예: TGCP01S1). 그래서 쿠팡용 코드를 상품설정에 따로 등록해야
--   하는데, 지금은 채널 개념이 없어 자체매입·위탁 목록에 섞여 구분되지 않았다.
--
-- 설계:
--   · 자체매입/위탁(vendor_id 유무)은 '매입 형태' 축, 판매채널은 '판매처' 축 — 서로 독립이다.
--     둘을 섞지 않고 별도 컬럼으로 둔다.
--   · 기존 행은 전부 'own'(자사)으로 채운다. 지금까지 등록된 상품은 자사 채널 기준이었다.
--   · 쿠팡 변형 상품의 출고일·박스·옵션은 기본상품에서 승계하지 않고 각자 입력한다
--     (운영 결정) — 기본상품을 고쳐도 쿠팡 쪽이 조용히 바뀌지 않게 하기 위함.
-- ============================================

ALTER TABLE bg_product_settings ADD COLUMN IF NOT EXISTS sales_channel TEXT NOT NULL DEFAULT 'own';

-- 값 고정. 채널이 늘면 이 제약을 갱신한다 (자유 텍스트로 두면 오타가 그대로 탭이 된다).
ALTER TABLE bg_product_settings DROP CONSTRAINT IF EXISTS bg_ps_sales_channel_chk;
ALTER TABLE bg_product_settings ADD  CONSTRAINT bg_ps_sales_channel_chk
  CHECK (sales_channel IN ('own', 'coupang', 'naver', 'cafe24', 'thegift', 'etc'));

CREATE INDEX IF NOT EXISTS idx_bg_ps_sales_channel ON bg_product_settings (sales_channel);

COMMENT ON COLUMN bg_product_settings.sales_channel IS
  '판매채널 — own=자사(바른손카드/몰) / coupang / naver / cafe24=정수당 / thegift=더기프트 / etc. 매입형태(vendor_id)와는 다른 축';
