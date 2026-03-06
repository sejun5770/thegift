-- ============================================
-- PRODUCTS & STICKERS
-- ============================================

CREATE TABLE products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_code VARCHAR(100) NOT NULL UNIQUE,
  product_name VARCHAR(500) NOT NULL,
  price INTEGER NOT NULL DEFAULT 0,
  is_sticker_product BOOLEAN DEFAULT false,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE sticker_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sticker_code VARCHAR(100) NOT NULL UNIQUE,
  sticker_name VARCHAR(500) NOT NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE product_sticker_mapping (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sticker_type_id UUID NOT NULL REFERENCES sticker_types(id) ON DELETE CASCADE,
  slot_number INTEGER NOT NULL CHECK (slot_number BETWEEN 1 AND 3),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(product_id, sticker_type_id, slot_number)
);

CREATE TABLE box_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  box_code VARCHAR(100) NOT NULL UNIQUE,
  box_name VARCHAR(500) NOT NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================
-- ORDERS
-- ============================================

CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number VARCHAR(100) NOT NULL UNIQUE,
  order_source VARCHAR(20) NOT NULL DEFAULT 'external' CHECK (order_source IN ('external', 'admin')),
  status VARCHAR(30) NOT NULL DEFAULT 'collected' CHECK (status IN (
    'collected', 'cancelled', 'validation_failed', 'system_error',
    'draft_completed', 'print_ready', 'print_completed',
    'binding_completed', 'shipping_completed'
  )),
  shipping_method VARCHAR(20) NOT NULL DEFAULT 'parcel' CHECK (shipping_method IN (
    'parcel', 'same_day', 'quick', 'terminal'
  )),
  desired_shipping_date DATE NOT NULL,
  collected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  original_desired_shipping_date DATE,
  recipient_name VARCHAR(200) NOT NULL,
  recipient_phone VARCHAR(50),
  recipient_address TEXT,
  recipient_zipcode VARCHAR(20),
  delivery_message TEXT,
  order_amount INTEGER NOT NULL DEFAULT 0,
  total_product_count INTEGER NOT NULL DEFAULT 0,
  total_item_quantity INTEGER NOT NULL DEFAULT 0,
  is_incident BOOLEAN DEFAULT false,
  is_deleted BOOLEAN DEFAULT false,
  validation_failed_reason TEXT,
  validation_failed_at TIMESTAMPTZ,
  validation_failed_by UUID,
  draft_completed_at TIMESTAMPTZ,
  print_ready_at TIMESTAMPTZ,
  print_completed_at TIMESTAMPTZ,
  binding_completed_at TIMESTAMPTZ,
  shipping_completed_at TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ,
  confirmed_by UUID,
  created_by UUID,
  updated_by UUID,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================
-- ORDER ITEMS
-- ============================================

CREATE TABLE order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id UUID REFERENCES products(id),
  product_name VARCHAR(500) NOT NULL,
  product_code VARCHAR(100),
  quantity INTEGER NOT NULL DEFAULT 1,
  item_price INTEGER NOT NULL DEFAULT 0,
  box_type_id UUID REFERENCES box_types(id),
  box_type_name VARCHAR(500),
  sticker_type1_id UUID REFERENCES sticker_types(id),
  sticker_type1_name VARCHAR(500),
  sticker_type1_quantity INTEGER DEFAULT 0,
  sticker_type2_id UUID REFERENCES sticker_types(id),
  sticker_type2_name VARCHAR(500),
  sticker_type2_quantity INTEGER DEFAULT 0,
  sticker_type3_id UUID REFERENCES sticker_types(id),
  sticker_type3_name VARCHAR(500),
  sticker_type3_quantity INTEGER DEFAULT 0,
  input_message TEXT,
  sticker_preview_url TEXT,
  sticker_preview_uploaded_at TIMESTAMPTZ,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================
-- SHIPPING ADDRESSES
-- ============================================

CREATE TABLE order_shipping_addresses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  recipient_name VARCHAR(200) NOT NULL,
  recipient_phone VARCHAR(50),
  recipient_address TEXT NOT NULL,
  recipient_zipcode VARCHAR(20),
  delivery_message TEXT,
  quantity INTEGER NOT NULL DEFAULT 1,
  shipping_method VARCHAR(20) DEFAULT 'parcel' CHECK (shipping_method IN (
    'parcel', 'same_day', 'quick', 'terminal'
  )),
  tracking_number VARCHAR(100),
  is_primary BOOLEAN DEFAULT false,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================
-- ORDER HIGHLIGHTS
-- ============================================

CREATE TABLE order_highlights (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  highlight_type VARCHAR(30) NOT NULL CHECK (highlight_type IN (
    'multi_product', 'check_required', 'split_shipping',
    'schedule_changed', 'incident', 'admin_memo'
  )),
  is_auto BOOLEAN NOT NULL DEFAULT true,
  reason TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(order_id, highlight_type)
);

-- ============================================
-- ADMIN MEMOS
-- ============================================

CREATE TABLE admin_memos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  memo_text TEXT NOT NULL,
  created_by UUID,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================
-- ORDER HISTORY
-- ============================================

CREATE TABLE order_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  action VARCHAR(100) NOT NULL,
  field_name VARCHAR(200),
  old_value TEXT,
  new_value TEXT,
  description TEXT,
  performed_by UUID,
  performed_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================
-- INDEXES
-- ============================================

CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_desired_shipping_date ON orders(desired_shipping_date);
CREATE INDEX idx_orders_collected_at ON orders(collected_at);
CREATE INDEX idx_orders_order_number ON orders(order_number);
CREATE INDEX idx_orders_status_shipping_date ON orders(status, desired_shipping_date);
CREATE INDEX idx_orders_not_deleted ON orders(is_deleted) WHERE is_deleted = false;
CREATE INDEX idx_order_items_order_id ON order_items(order_id);
CREATE INDEX idx_order_shipping_order_id ON order_shipping_addresses(order_id);
CREATE INDEX idx_order_highlights_order_id ON order_highlights(order_id);
CREATE INDEX idx_order_highlights_type ON order_highlights(order_id, highlight_type);
CREATE INDEX idx_admin_memos_order_id ON admin_memos(order_id);
CREATE INDEX idx_order_history_order_id ON order_history(order_id);
CREATE INDEX idx_order_history_performed_at ON order_history(performed_at);

-- ============================================
-- TRIGGERS: Auto-update updated_at
-- ============================================

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_orders_updated_at
  BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_order_items_updated_at
  BEFORE UPDATE ON order_items FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_products_updated_at
  BEFORE UPDATE ON products FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_sticker_types_updated_at
  BEFORE UPDATE ON sticker_types FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_box_types_updated_at
  BEFORE UPDATE ON box_types FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_order_shipping_updated_at
  BEFORE UPDATE ON order_shipping_addresses FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_admin_memos_updated_at
  BEFORE UPDATE ON admin_memos FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================
-- FUNCTION: Dashboard summary
-- ============================================

CREATE OR REPLACE FUNCTION get_dashboard_summary(
  p_date_type TEXT,
  p_start_date DATE,
  p_end_date DATE
)
RETURNS JSON AS $$
DECLARE
  result JSON;
BEGIN
  SELECT json_build_object(
    'order_status', (
      SELECT json_build_object(
        'total', COUNT(*),
        'collected', COUNT(*) FILTER (WHERE status = 'collected'),
        'cancelled', COUNT(*) FILTER (WHERE status = 'cancelled'),
        'validation_failed', COUNT(*) FILTER (WHERE status = 'validation_failed'),
        'system_error', COUNT(*) FILTER (WHERE status = 'system_error')
      )
      FROM orders
      WHERE is_deleted = false
        AND CASE
          WHEN p_date_type = 'desired_shipping_date'
            THEN desired_shipping_date BETWEEN p_start_date AND p_end_date
          ELSE collected_at::date BETWEEN p_start_date AND p_end_date
        END
    ),
    'work_status', (
      SELECT json_build_object(
        'draft_completed', COUNT(*) FILTER (WHERE status = 'draft_completed'),
        'print_ready', COUNT(*) FILTER (WHERE status = 'print_ready'),
        'print_completed', COUNT(*) FILTER (WHERE status = 'print_completed'),
        'binding_completed', COUNT(*) FILTER (WHERE status = 'binding_completed'),
        'shipping_completed', COUNT(*) FILTER (WHERE status = 'shipping_completed')
      )
      FROM orders
      WHERE is_deleted = false
        AND CASE
          WHEN p_date_type = 'desired_shipping_date'
            THEN desired_shipping_date BETWEEN p_start_date AND p_end_date
          ELSE collected_at::date BETWEEN p_start_date AND p_end_date
        END
    )
  ) INTO result;

  RETURN result;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- FUNCTION: Shipping calendar monthly counts
-- ============================================

CREATE OR REPLACE FUNCTION get_shipping_calendar(
  p_start_month DATE,
  p_end_month DATE
)
RETURNS JSON AS $$
BEGIN
  RETURN (
    SELECT json_agg(row_to_json(t))
    FROM (
      SELECT
        to_char(desired_shipping_date, 'YYYY-MM') AS month,
        COUNT(*) AS total_count
      FROM orders
      WHERE is_deleted = false
        AND desired_shipping_date >= p_start_month
        AND desired_shipping_date < p_end_month + INTERVAL '1 month'
      GROUP BY to_char(desired_shipping_date, 'YYYY-MM')
      ORDER BY month
    ) t
  );
END;
$$ LANGUAGE plpgsql;
