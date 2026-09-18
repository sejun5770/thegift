-- ============================================
-- 후공정 처리 상태 컬럼 추가 (migration 011)
--
-- 배경: 관리자 업무 흐름상 '입력완료' 주문을 스프레드시트로 복사해
--       후공정(제작/포장/출고) 을 진행. 이때 '어디까지 옮겼는지' 추적할
--       필드가 없어 중복 복사/누락 위험이 있었음.
--
-- 필드:
--   processed_at : 관리자가 스프레드시트로 복사/후공정 시작한 시각
--                  NULL = 아직 후공정 미진행
--   processed_by : 처리한 관리자 이메일 (감사 추적)
--
-- 연동:
--   - 수집복사 버튼 클릭 시 자동 세팅 (batch PATCH)
--   - 개별 행의 '📋 처리완료'/'↺ 되돌리기' 버튼으로 수동 토글
-- ============================================

ALTER TABLE bg_order_customer_info
  ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS processed_by VARCHAR(200);

COMMENT ON COLUMN bg_order_customer_info.processed_at IS '후공정 처리(스프레드시트 복사) 시각. NULL = 미처리';
COMMENT ON COLUMN bg_order_customer_info.processed_by IS '후공정 처리한 관리자 이메일';

-- 조회 효율 인덱스 (미처리만 필터링 자주 발생)
CREATE INDEX IF NOT EXISTS idx_bg_order_customer_info_unprocessed
  ON bg_order_customer_info(submitted_at DESC) WHERE processed_at IS NULL;
