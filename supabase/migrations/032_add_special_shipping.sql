-- ============================================
-- 032_add_special_shipping.sql
--
-- 기타출고 처리 — 사고 케이스 (수량부족, 상품훼손, 주문누락 등) 대응.
--
-- 기존 정보입력 프로세스와 별개로, 사고 발생 주문을 운영자가 편집 모달에서
-- 표시하고 사유 저장. 정보입력현황 전체 탭에서 필터/시각 강조.
--
-- 컬럼:
--   is_special_shipping        기타출고 여부 (기본 false)
--   special_shipping_reason    'shortage' | 'damage' | 'omission' | 'other'
--   special_shipping_memo      'other' 선택 시 운영자 직접 입력 텍스트
--
-- 기존 row 는 default false 로 backfill — 서비스 영향 없음 (forward-only).
-- ============================================

ALTER TABLE bg_order_customer_info
  ADD COLUMN IF NOT EXISTS is_special_shipping BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE bg_order_customer_info
  ADD COLUMN IF NOT EXISTS special_shipping_reason VARCHAR(20);

ALTER TABLE bg_order_customer_info
  ADD COLUMN IF NOT EXISTS special_shipping_memo TEXT;

-- 필터/조회용 인덱스 — 기타출고 처리된 row 만 빠르게 조회
CREATE INDEX IF NOT EXISTS idx_bg_order_ci_special_shipping
  ON bg_order_customer_info(is_special_shipping)
  WHERE is_special_shipping = true;

COMMENT ON COLUMN bg_order_customer_info.is_special_shipping IS '기타출고 처리 여부 — 사고건 (수량부족/상품훼손/주문누락 등)';
COMMENT ON COLUMN bg_order_customer_info.special_shipping_reason IS 'shortage=수량부족 / damage=상품훼손 / omission=주문누락 / other=기타';
COMMENT ON COLUMN bg_order_customer_info.special_shipping_memo IS 'reason=other 선택 시 운영자 직접 입력';
