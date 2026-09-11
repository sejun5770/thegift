-- ============================================
-- 081_bg_customer_info_customer_edit.sql
--
-- 고객이 수집완료(processed_at) 전에 입력 정보를 수정할 수 있게 하면서, 수정 흔적을 남긴다.
--
-- 배경 (2026-09-11 운영 요청):
--   주문완료 → 정보입력 → (수집 전) 고객 수정 → 수집완료 → 이후 수정 요청은 고객센터 안내.
--   서버는 저장 시점에 processed_at 을 검사한다 — 고객이 수정 화면을 열어 둔 사이 운영이
--   수집완료를 눌러도 저장이 거부된다. 정보입력현황은 customer_edited_at 으로 '고객 수정' 배지를 띄운다.
--
-- 기존 rows 는 NULL / 0 (forward-only). 컬럼이 없어도 서버는 해당 필드를 빼고 재시도하므로
-- 배포 순서에 관계없이 동작한다 — 다만 배지는 이 마이그레이션이 적용돼야 보인다.
-- ============================================

ALTER TABLE bg_order_customer_info
  ADD COLUMN IF NOT EXISTS customer_edited_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS customer_edit_count INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN bg_order_customer_info.customer_edited_at IS '고객이 수집완료 전에 마지막으로 수정한 시각. NULL 이면 수정 없음.';
COMMENT ON COLUMN bg_order_customer_info.customer_edit_count IS '고객 수정 횟수.';
