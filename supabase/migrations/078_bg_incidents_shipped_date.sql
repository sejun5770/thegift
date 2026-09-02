-- ============================================
-- 078_bg_incidents_shipped_date.sql
--
-- 기타출고 건에 '실제 출고일' 을 둔다.
--
-- 배경 (운영 요청 2026-09-01):
--   기타출고 처리는 출고월 기준으로 정산한다. 그런데 기간 필터에는 희망출고일과
--   사고 등록일뿐이라 출고월로 묶어 볼 수 없었다.
--
-- 왜 워크플로우의 shipped_at 을 못 쓰나:
--   기타출고는 정식 출고처리(송장 등록) 흐름을 타지 않는다 — 실측하니 사고건 19건 전부
--   sticker_selections[].shipped_at 이 비어 있었다 (전체 주문 4,670건 중 996건은 있는데도).
--   원주문의 출고일과도 다르다: 사고 보전분은 원주문이 나간 뒤 따로 나가기 때문.
--   그래서 사고건 자체에 날짜를 둔다.
--
-- 기존 행: 등록일(created_at)의 KST 날짜로 채운다 — 기타출고는 나간 뒤 바로 등록하는 흐름이라
--   실제 출고일과 거의 같다. 다르면 화면에서 고치면 된다 (되돌릴 수 있는 기본값).
-- ============================================

ALTER TABLE bg_incidents
  ADD COLUMN IF NOT EXISTS shipped_date DATE;

COMMENT ON COLUMN bg_incidents.shipped_date IS
  '기타출고가 실제로 나간 날 — 출고월 정산 기준. 워크플로우 shipped_at 을 타지 않는 건이라 직접 입력받는다';

-- 기존 기타출고 건만 등록일(KST)로 초기화. 운영사고는 출고가 없으므로 비워 둔다.
UPDATE bg_incidents
   SET shipped_date = (created_at AT TIME ZONE 'Asia/Seoul')::date
 WHERE disposition = 'extra_shipment'
   AND shipped_date IS NULL;

CREATE INDEX IF NOT EXISTS idx_bg_incidents_shipped_date
  ON bg_incidents (shipped_date DESC) WHERE shipped_date IS NOT NULL;
