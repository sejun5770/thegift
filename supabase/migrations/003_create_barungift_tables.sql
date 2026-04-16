-- ============================================
-- BARUNGIFT: 고객 정보 수집 시스템
-- Docker 컨테이너 재배포 시 데이터 유실 방지를 위해
-- Supabase (PostgreSQL)에 영구 저장
-- ============================================

-- ============================================
-- BG_STICKERS: 스티커 템플릿
-- ============================================

CREATE TABLE IF NOT EXISTS bg_stickers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(500) NOT NULL DEFAULT '',
  preview_image_url TEXT,
  preview_color VARCHAR(20) DEFAULT '#FFFFFF',
  custom_fields JSONB DEFAULT '[]'::jsonb,
  -- custom_fields 구조: [{field_id, field_label, field_type, max_length, required, position:{x,y,w,h}}]
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================
-- BG_PRODUCT_SETTINGS: 상품별 출고/스티커 설정
-- ============================================

CREATE TABLE IF NOT EXISTS bg_product_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id VARCHAR(100) NOT NULL UNIQUE,
  -- 출고방식: 'today_shipping' (오늘출발) | 'desired_date' (희망출고)
  shipping_type VARCHAR(50) DEFAULT 'desired_date',
  -- 마감시간 설정
  cutoff_enabled BOOLEAN DEFAULT false,
  cutoff_hour INTEGER DEFAULT 14,
  cutoff_minute INTEGER DEFAULT 0,
  -- 리드타임/선택범위
  lead_time_days INTEGER NOT NULL DEFAULT 2,
  min_select_days INTEGER DEFAULT 3,
  max_select_days INTEGER DEFAULT 60,
  -- 휴무일 설정
  closed_weekdays JSONB DEFAULT '[0,6]'::jsonb,  -- 0=일, 6=토
  closed_dates JSONB DEFAULT '[]'::jsonb,         -- [{date:'YYYY-MM-DD', reason:'사유'}]
  -- 고객 노출 설정
  date_required BOOLEAN DEFAULT true,
  notice_enabled BOOLEAN DEFAULT false,
  notice_text TEXT DEFAULT '',
  -- 스티커 연결
  available_sticker_ids JSONB DEFAULT '[]'::jsonb,
  -- 레거시 호환
  express_available BOOLEAN DEFAULT false,
  express_fee INTEGER DEFAULT 0,
  express_cutoff_time VARCHAR(10) DEFAULT '14:00',
  blackout_dates JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================
-- BG_ORDER_CUSTOMER_INFO: 고객 입력 정보
-- ============================================

CREATE TABLE IF NOT EXISTS bg_order_customer_info (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id VARCHAR(100) NOT NULL UNIQUE,
  is_express BOOLEAN NOT NULL DEFAULT false,
  express_fee INTEGER DEFAULT 0,
  desired_ship_date DATE,
  sticker_selections JSONB DEFAULT '[]'::jsonb,
  -- [{product_id, sticker_id, custom_values:{field_id:value}}]
  cash_receipt_yn BOOLEAN NOT NULL DEFAULT false,
  receipt_type VARCHAR(50),
  receipt_number VARCHAR(100),
  submitted_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================
-- INDEXES
-- ============================================

CREATE INDEX IF NOT EXISTS idx_bg_stickers_active ON bg_stickers(is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_bg_product_settings_product_id ON bg_product_settings(product_id);
CREATE INDEX IF NOT EXISTS idx_bg_order_customer_info_order_id ON bg_order_customer_info(order_id);

-- ============================================
-- TRIGGERS: Auto-update updated_at
-- (update_updated_at() 함수는 001 마이그레이션에서 생성됨)
-- ============================================

-- DROP 후 재생성으로 멱등성 보장
DROP TRIGGER IF EXISTS trg_bg_stickers_updated_at ON bg_stickers;
CREATE TRIGGER trg_bg_stickers_updated_at
  BEFORE UPDATE ON bg_stickers FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS trg_bg_product_settings_updated_at ON bg_product_settings;
CREATE TRIGGER trg_bg_product_settings_updated_at
  BEFORE UPDATE ON bg_product_settings FOR EACH ROW EXECUTE FUNCTION update_updated_at();
