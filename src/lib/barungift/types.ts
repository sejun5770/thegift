// ============================================
// Barungift 고객 정보 수집 시스템 타입 정의
// ============================================

/** 스티커 커스텀 영역 필드 정의 */
export interface BgStickerCustomField {
  field_id: string;
  field_label: string;
  field_type: 'text' | 'date' | 'select';
  max_length?: number;
  required: boolean;
  options?: string[]; // field_type === 'select' 시 선택 옵션
  position: {
    x: number; // % 기반 (0~100)
    y: number;
    w: number;
    h: number;
  };
  font_size?: number;
  font_family?: string;
}

/** 스티커 (bg_stickers 테이블) */
export interface BgSticker {
  id: string;
  name: string;
  preview_image_url: string | null;
  preview_color: string;
  custom_fields: BgStickerCustomField[];
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

/** 상품 설정 (bg_product_settings 테이블) */
export interface BgProductSettings {
  id: string;
  product_id: string;
  lead_time_days: number;
  express_available: boolean;
  express_fee: number;
  express_cutoff_time: string; // "HH:mm" 형식
  available_sticker_ids: string[];
  blackout_dates: string[]; // "YYYY-MM-DD" 배열
  max_select_days: number;
  created_at: string;
  updated_at: string;
}

/** 고객 스티커 선택 (JSONB 내부 구조) */
export interface BgStickerSelection {
  product_id: string;
  sticker_id: string;
  custom_values: Record<string, string>; // { [field_id]: value }
}

/** 고객 입력 정보 (bg_order_customer_info 테이블) */
export interface BgOrderCustomerInfo {
  id: string;
  order_id: string;
  is_express: boolean;
  express_fee: number;
  desired_ship_date: string;
  sticker_selections: BgStickerSelection[];
  cash_receipt_yn: boolean;
  receipt_type: 'personal' | 'business' | null;
  receipt_number: string | null;
  submitted_at: string;
  created_at: string;
}

/** 고객 페이지에서 사용하는 주문 아이템 정보 */
export interface BgOrderItemForCustomer {
  id: string;
  product_id: string | null;
  product_name: string;
  product_code: string | null;
  quantity: number;
  item_price: number;
}

/** 고객 페이지에서 사용하는 주문 정보 (API 응답) */
export interface BgOrderForCustomer {
  order_id: string;
  order_number: string;
  customer_name: string;
  order_date: string;
  total_amount: number;
  status: string;
  info_status: 'pending' | 'completed';
  products: BgOrderItemForCustomer[];
  product_settings: BgProductSettings | null;
  available_stickers: BgSticker[];
  existing_info: BgOrderCustomerInfo | null;
  bank_info: BgBankInfo;
}

/** 무통장입금 계좌 정보 */
export interface BgBankInfo {
  bank_name: string;
  account_number: string;
  account_holder: string;
}

/** sessionStorage에 저장하는 폼 상태 */
export interface BgCustomerFormState {
  current_step: number;
  is_express: boolean;
  express_fee: number;
  desired_ship_date: string | null;
  sticker_selections: BgStickerSelection[];
  cash_receipt_yn: boolean;
  receipt_type: 'personal' | 'business' | null;
  receipt_number: string;
}

/** POST /api/orders/[orderId]/customer-info 요청 바디 */
export interface BgCustomerInfoSubmitBody {
  is_express: boolean;
  express_fee: number;
  desired_ship_date: string;
  sticker_selections: BgStickerSelection[];
  cash_receipt_yn: boolean;
  receipt_type: 'personal' | 'business' | null;
  receipt_number: string | null;
}

/** 스티커 생성/수정 요청 바디 */
export interface BgStickerCreateBody {
  name: string;
  preview_image_url?: string;
  preview_color?: string;
  custom_fields?: BgStickerCustomField[];
  is_active?: boolean;
}

/** 상품 설정 수정 요청 바디 */
export interface BgProductSettingsUpdateBody {
  lead_time_days?: number;
  express_available?: boolean;
  express_fee?: number;
  express_cutoff_time?: string;
  available_sticker_ids?: string[];
  blackout_dates?: string[];
  max_select_days?: number;
}
