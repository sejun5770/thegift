-- 정보입력현황 워크플로우 고도화 — 7단계 + 다중 송장 + designer role
--
-- 데이터 모델:
--   1) sticker_selection 단위 워크플로우:
--      bg_order_customer_info.sticker_selections[i] JSONB 인라인 확장 (마이그레이션 불필요).
--      각 selection 에 다음 필드 추가:
--        sticker_completed_at, sticker_completed_by,
--        printed_at, printed_by,
--        bound_at, bound_by,
--        packed_at, packed_by,
--        shipped_at, shipped_by,
--        images: [{ filename, uploaded_at, uploaded_by, is_main, mime }]
--
--   2) 다중 송장 — 신규 테이블 (1주문 N송장 분리배송 대응)
--   3) admin_users.role 'designer' 추가

-- ============================================
-- bg_order_invoices: 송장 정보
-- ============================================
CREATE TABLE IF NOT EXISTS bg_order_invoices (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id         TEXT NOT NULL,                          -- bg_order_customer_info.order_id 와 매칭
  invoice_number   TEXT NOT NULL,                          -- 송장번호
  delivery_company TEXT NOT NULL,                          -- 택배사 (CJ대한통운/한진/롯데/우체국/로젠/기타)
  sticker_indices  INTEGER[] NOT NULL DEFAULT '{}',        -- 포함된 sticker_selections index 목록 (다중 송장 시 분할)
  shipped_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  shipped_by       TEXT,                                   -- 처리자 email
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT bg_order_invoices_unique UNIQUE (order_id, invoice_number)
);

CREATE INDEX IF NOT EXISTS idx_bg_order_invoices_order_id ON bg_order_invoices(order_id);
CREATE INDEX IF NOT EXISTS idx_bg_order_invoices_shipped_at ON bg_order_invoices(shipped_at DESC);

ALTER TABLE bg_order_invoices ENABLE ROW LEVEL SECURITY;

-- 모든 인증 사용자 조회 가능 (정보입력현황 화면용)
DROP POLICY IF EXISTS bg_order_invoices_select ON bg_order_invoices;
CREATE POLICY bg_order_invoices_select ON bg_order_invoices FOR SELECT USING (true);
-- 쓰기는 서버(service key) 에서만 — server.js 에서 admin_users.role 검증

-- ============================================
-- admin_users.role 에 'designer' 추가
-- ============================================
DO $$
BEGIN
  -- 기존 CHECK 제약 제거 후 재생성
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'admin_users' AND constraint_type = 'CHECK'
  ) THEN
    EXECUTE 'ALTER TABLE admin_users DROP CONSTRAINT IF EXISTS admin_users_role_check';
  END IF;

  EXECUTE 'ALTER TABLE admin_users ADD CONSTRAINT admin_users_role_check
           CHECK (role IN (''admin'', ''operator'', ''designer''))';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'admin_users role check 재생성 실패 (이미 존재 가능): %', SQLERRM;
END $$;

-- ============================================
-- (선택) 워크플로우 상태별 row 조회 최적화 인덱스
-- ============================================
-- sticker_selections 안에 timestamps 가 들어가서 JSONB GIN 인덱스가 도움될 수 있음.
-- 운영 데이터 규모 봐서 추후 추가.
-- CREATE INDEX idx_bg_order_customer_info_sticker_workflow
--   ON bg_order_customer_info USING GIN (sticker_selections);
