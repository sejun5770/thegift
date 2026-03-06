import type { OrderStatus, ShippingMethod, HighlightType, OrderSource } from './enums';

export interface Order {
  id: string;
  order_number: string;
  order_source: OrderSource;
  status: OrderStatus;
  shipping_method: ShippingMethod;
  desired_shipping_date: string;
  collected_at: string;
  original_desired_shipping_date: string | null;
  recipient_name: string;
  recipient_phone: string | null;
  recipient_address: string | null;
  recipient_zipcode: string | null;
  delivery_message: string | null;
  total_product_count: number;
  total_item_quantity: number;
  is_incident: boolean;
  is_deleted: boolean;
  validation_failed_reason: string | null;
  validation_failed_at: string | null;
  draft_completed_at: string | null;
  print_ready_at: string | null;
  print_completed_at: string | null;
  binding_completed_at: string | null;
  shipping_completed_at: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
  // Relations
  order_items?: OrderItem[];
  order_highlights?: OrderHighlight[];
  admin_memos?: AdminMemo[];
  order_shipping_addresses?: OrderShippingAddress[];
}

export interface OrderItem {
  id: string;
  order_id: string;
  product_id: string | null;
  product_name: string;
  product_code: string | null;
  quantity: number;
  item_price: number;
  box_type_id: string | null;
  box_type_name: string | null;
  sticker_type1_id: string | null;
  sticker_type1_name: string | null;
  sticker_type1_quantity: number;
  sticker_type2_id: string | null;
  sticker_type2_name: string | null;
  sticker_type2_quantity: number;
  sticker_type3_id: string | null;
  sticker_type3_name: string | null;
  sticker_type3_quantity: number;
  input_message: string | null;
  sticker_preview_url: string | null;
  sticker_preview_uploaded_at: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface OrderShippingAddress {
  id: string;
  order_id: string;
  recipient_name: string;
  recipient_phone: string | null;
  recipient_address: string;
  recipient_zipcode: string | null;
  delivery_message: string | null;
  quantity: number;
  shipping_method: ShippingMethod;
  tracking_number: string | null;
  is_primary: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface OrderHighlight {
  id: string;
  order_id: string;
  highlight_type: HighlightType;
  is_auto: boolean;
  reason: string | null;
  created_at: string;
}

export interface AdminMemo {
  id: string;
  order_id: string;
  memo_text: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface OrderHistory {
  id: string;
  order_id: string;
  action: string;
  field_name: string | null;
  old_value: string | null;
  new_value: string | null;
  description: string | null;
  performed_by: string | null;
  performed_at: string;
}

// 주문 목록 조회용 (확장된 타입)
export interface OrderListItem extends Order {
  highlights: HighlightType[];
  latest_memo: string | null;
  // 복수상품 분리 시 사용
  display_item?: OrderItem;
  display_item_index?: number;
  display_item_total?: number;
}

// 대시보드 요약
export interface DashboardSummary {
  order_status: {
    total: number;
    collected: number;
    cancelled: number;
    validation_failed: number;
    system_error: number;
  };
  work_status: {
    draft_completed: number;
    print_ready: number;
    print_completed: number;
    binding_completed: number;
    shipping_completed: number;
  };
}

export interface ShippingCalendarData {
  month: string; // YYYY-MM
  total_count: number;
}
