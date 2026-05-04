-- ============================================
-- BG_SHIPPING_CONFIG: 공통 출고일 설정 (single-row)
-- Docker 컨테이너 재배포 시 설정 유실 방지를 위해 Supabase 저장
-- 단일 row 사용 (id = '00000000-0000-0000-0000-000000000001')
-- ============================================

CREATE TABLE IF NOT EXISTS bg_shipping_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shipping_type VARCHAR(50) DEFAULT 'desired_date',
  cutoff_enabled BOOLEAN DEFAULT false,
  cutoff_hour INTEGER DEFAULT 14,
  cutoff_minute INTEGER DEFAULT 0,
  lead_time_days INTEGER NOT NULL DEFAULT 2,
  min_select_days INTEGER DEFAULT 3,
  max_select_days INTEGER DEFAULT 60,
  express_fee INTEGER DEFAULT 0,
  closed_weekdays JSONB DEFAULT '[0,6]'::jsonb,
  closed_dates JSONB DEFAULT '[]'::jsonb,
  date_required BOOLEAN DEFAULT true,
  notice_enabled BOOLEAN DEFAULT false,
  notice_text TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 기본 row 삽입 (고정 ID)
INSERT INTO bg_shipping_config (id, shipping_type, lead_time_days)
VALUES ('00000000-0000-0000-0000-000000000001', 'desired_date', 2)
ON CONFLICT (id) DO NOTHING;

DROP TRIGGER IF EXISTS trg_bg_shipping_config_updated_at ON bg_shipping_config;
CREATE TRIGGER trg_bg_shipping_config_updated_at
  BEFORE UPDATE ON bg_shipping_config FOR EACH ROW EXECUTE FUNCTION update_updated_at();
