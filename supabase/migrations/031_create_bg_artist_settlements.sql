-- ============================================
-- 031_create_bg_artist_settlements.sql
--
-- 작가 정산 월별 마감 기록 — 운영자가 특정 월을 "확정" 처리하면 저장.
--
-- 마감 후에도 재조회는 항상 MSSQL 실시간 — 다만 마감 시점 스냅샷 + status='confirmed'
-- 표시로 운영자가 추후 변경/주문 추가/취소 발생 시 인지 가능.
--
-- (artist_id, month) UNIQUE — 작가별 월별 1건만 마감.
-- ============================================

CREATE TABLE IF NOT EXISTS bg_artist_settlements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  artist_id UUID NOT NULL REFERENCES bg_artists(id) ON DELETE CASCADE,
  month DATE NOT NULL,                              -- 월 첫째 날 (예: 2026-06-01)
  total_amount BIGINT NOT NULL DEFAULT 0,           -- 매출 합계 (마감 시점 스냅샷)
  commission_rate NUMERIC(5, 2) NOT NULL,           -- 마감 시점 수수료율
  settlement_amount BIGINT NOT NULL DEFAULT 0,      -- 정산금액 = total_amount × commission_rate / 100
  total_qty INTEGER NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'confirmed',  -- confirmed / paid
  memo TEXT,
  confirmed_by TEXT,
  confirmed_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_bg_artist_settlements_artist_month
  ON bg_artist_settlements(artist_id, month);
CREATE INDEX IF NOT EXISTS idx_bg_artist_settlements_month
  ON bg_artist_settlements(month);

DROP TRIGGER IF EXISTS bg_artist_settlements_updated_at ON bg_artist_settlements;
CREATE TRIGGER bg_artist_settlements_updated_at
  BEFORE UPDATE ON bg_artist_settlements
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON bg_artist_settlements TO anon, authenticated;
