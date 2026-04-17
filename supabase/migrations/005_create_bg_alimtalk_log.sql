-- ============================================
-- BG_ALIMTALK_LOG: 답례품 주문 알림톡 발송 이력
-- ============================================

CREATE TABLE IF NOT EXISTS bg_alimtalk_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id VARCHAR(100) NOT NULL,              -- 'ETC-{seq}' 또는 '{seq}'
  to_phone VARCHAR(30),
  template_code VARCHAR(100),
  message_id VARCHAR(200),
  success BOOLEAN NOT NULL,
  is_mock BOOLEAN DEFAULT false,
  error_code VARCHAR(50),
  error_message TEXT,
  sent_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bg_alimtalk_log_order_id ON bg_alimtalk_log(order_id);
CREATE INDEX IF NOT EXISTS idx_bg_alimtalk_log_sent_at ON bg_alimtalk_log(sent_at);
