-- ============================================
-- bg_order_customer_info: customer_request / updated_at 컬럼 추가
-- 고객 요청사항 저장 및 관리자 수정 시각 기록용
-- IF NOT EXISTS로 이미 수동 ALTER된 환경에서도 안전
-- ============================================

ALTER TABLE bg_order_customer_info
  ADD COLUMN IF NOT EXISTS customer_request TEXT;

ALTER TABLE bg_order_customer_info
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
