-- 076: bg_manual_orders 에 판매 주체(본사/위탁업체) 구분 추가
--
-- 배경:
--   바른손더기프트(퍼스트몰) 원본 export 의 B열(판매자)에는 '본사' 와 위탁업체명이 함께 들어 있다.
--   지금까지 CSV 업로드 파서가 '본사' 행만 남기고 위탁업체 주문을 통째로 버려서,
--   위탁 매출이 대시보드 어디에도 잡히지 않았다. 같은 파일 하나로 양쪽을 다 받되
--   주문 단위로 판매 주체를 구분해 둔다.
--
-- 값 규약:
--   NULL   = 본사 (매입) — 기존 행 전부가 여기 해당하므로 기본값을 NULL 로 두어 소급 영향 없음
--   '혼합' = 한 주문에 본사 품목과 위탁 품목이 섞임 (주문수집은 본사 건과 동일하게 진행)
--   그 외  = 위탁업체명 (CSV 판매자 컬럼 원문 그대로)
--
-- 주문수집(정보입력현황) 연결:
--   위탁 주문은 우리가 수집/제작하지 않으므로 MO- customer_info stub 을 만들지 않는다.
--   '혼합' 은 본사 품목이 있으므로 stub 을 만든다. (서버 bulkCreateManualOrders 에서 분기)
--
-- 대시보드:
--   매출/상품별 집계는 site_name='바른손더기프트' 그대로 합산된다 — 위탁도 같은 채널 매출로 잡힌다.
--   구분이 필요하면 이 컬럼으로 나눠 본다.

ALTER TABLE bg_manual_orders
  ADD COLUMN IF NOT EXISTS vendor_name TEXT;

COMMENT ON COLUMN bg_manual_orders.vendor_name IS
  '판매 주체. NULL=본사(매입), ''혼합''=본사+위탁 혼재, 그 외=위탁업체명 (CSV 판매자 컬럼 원문)';

-- 주문조회 매입/위탁 탭과 정보입력현황 제외 필터가 이 컬럼으로 걸린다.
CREATE INDEX IF NOT EXISTS idx_bg_manual_orders_vendor_name
  ON bg_manual_orders (vendor_name);
