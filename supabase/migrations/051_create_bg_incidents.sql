-- ============================================
-- 051_create_bg_incidents.sql
--
-- 사고건 원장 — 운영사고 / 기타출고를 원주문과 분리해 기록한다.
--
-- 배경 (운영 요청 2026-08-07):
--   지금은 bg_order_customer_info 에 is_special_shipping / special_shipping_reason /
--   special_shipping_memo 세 컬럼만 있어, 원주문에 "기타출고였다" 는 리마크만 남는다.
--   물류·재무는 실제로 나간 품목과 수량에 대해서만 매출을 잡아야 하는데
--   그 수량이 어디에도 없어 이 리마크로는 처리할 수 없다.
--
-- 설계:
--   · 한 주문에 사고가 여러 번 날 수 있으므로 주문 1 : 사고 N.
--   · disposition 으로 운영사고와 기타출고를 가른다.
--       operation       운영사고 — 실제 출고 없음. 유형·사유만 남긴다.
--       extra_shipment  기타출고 — 실제로 나간 품목·수량을 items 에 적는다 (재고/매출 처리 근거).
--   · incident_type 은 기존 special_shipping_reason 4종을 그대로 승계한다.
--     (운영이 쓰던 분류라 그대로 옮겨야 기존 건이 살아난다. 사유는 자유 입력으로 분리.)
--   · items 는 [{product_code, product_name, quantity}] JSONB.
--
-- 기존 컬럼은 남긴다 — 전체 탭의 🚨 강조와 기타출고 필터가 그대로 동작해야 하고,
--   사고건 등록 시 앱이 그 플래그를 함께 갱신한다 (파생값).
-- ============================================

CREATE TABLE IF NOT EXISTS bg_incidents (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      TEXT NOT NULL,          -- 정보입력현황 키 (CP-/NV-/CF-/ETC-/MO- 접두 포함)
  category      TEXT NOT NULL DEFAULT 'daeryepum',
  incident_type TEXT NOT NULL,          -- shortage | damage | omission | other
  disposition   TEXT NOT NULL,          -- operation | extra_shipment
  reason        TEXT,                   -- 자유 입력 사유
  items         JSONB NOT NULL DEFAULT '[]'::jsonb,   -- 기타출고 시 실제 출고 품목·수량
  recv_name     TEXT,                   -- 조회 편의용 스냅샷 (주문이 지워져도 목록이 읽힌다)
  order_date    TIMESTAMPTZ,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT bg_incident_type_chk CHECK (incident_type IN ('shortage', 'damage', 'omission', 'other')),
  CONSTRAINT bg_incident_disp_chk CHECK (disposition IN ('operation', 'extra_shipment'))
);

CREATE INDEX IF NOT EXISTS idx_bg_incidents_order   ON bg_incidents (order_id);
CREATE INDEX IF NOT EXISTS idx_bg_incidents_created ON bg_incidents (created_at DESC);

COMMENT ON TABLE  bg_incidents               IS '사고건 원장 — 운영사고/기타출고. 기타출고는 실제 출고 품목·수량을 담는다';
COMMENT ON COLUMN bg_incidents.disposition   IS 'operation=운영사고(출고 없음) / extra_shipment=기타출고(실제 출고, 재고·매출 처리 대상)';
COMMENT ON COLUMN bg_incidents.incident_type IS 'shortage=수량부족 / damage=상품훼손 / omission=주문누락 / other=기타';
COMMENT ON COLUMN bg_incidents.items         IS '[{product_code, product_name, quantity}] — 기타출고일 때만 채운다';

-- ── 기존 기타출고 표시를 사고건으로 이관 ────────────────────────────────
--   품목·수량은 애초에 기록된 적이 없어 빈 배열로 들어간다.
--   운영이 목록에서 품목을 채워 넣을 수 있도록 기타출고로 두고, 화면에서 '품목 미입력' 으로 표시한다.
--   재실행해도 같은 주문이 중복 생성되지 않게 NOT EXISTS 로 막는다.
INSERT INTO bg_incidents (order_id, incident_type, disposition, reason, recv_name, created_by, created_at)
SELECT ci.order_id,
       COALESCE(NULLIF(ci.special_shipping_reason, ''), 'other'),
       'extra_shipment',
       NULLIF(ci.special_shipping_memo, ''),
       NULL,
       'migration-051',
       COALESCE(ci.updated_at, NOW())
FROM bg_order_customer_info ci
WHERE ci.is_special_shipping IS TRUE
  AND COALESCE(ci.special_shipping_reason, 'other') IN ('shortage', 'damage', 'omission', 'other')
  AND NOT EXISTS (SELECT 1 FROM bg_incidents i WHERE i.order_id = ci.order_id);

-- 2026-10-30 이후 Supabase 신규 테이블 default behavior 대응
GRANT ALL ON TABLE bg_incidents TO anon, authenticated, service_role;
