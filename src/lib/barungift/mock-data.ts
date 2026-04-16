import type {
  BgSticker,
  BgProductSettings,
  BgOrderForCustomer,
  BgOrderCustomerInfo,
} from './types';
import { BG_BANK_INFO } from './constants';

// ============================================
// Mock 데이터 (개발용)
// ============================================

export const MOCK_BG_STICKERS: BgSticker[] = [
  {
    id: 'sticker-001',
    name: '클래식 감사 스티커',
    preview_image_url: null,
    preview_color: '#FFF5E6',
    custom_fields: [
      {
        field_id: 'field-1',
        field_label: '보내는 분',
        field_type: 'text',
        max_length: 20,
        required: true,
        position: { x: 30, y: 20, w: 40, h: 10 },
        font_size: 14,
      },
      {
        field_id: 'field-2',
        field_label: '행사일',
        field_type: 'date',
        required: true,
        position: { x: 30, y: 40, w: 40, h: 10 },
        font_size: 12,
      },
      {
        field_id: 'field-3',
        field_label: '인사말',
        field_type: 'text',
        max_length: 50,
        required: false,
        position: { x: 15, y: 60, w: 70, h: 15 },
        font_size: 11,
      },
    ],
    is_active: true,
    created_at: '2026-04-01T00:00:00Z',
    updated_at: '2026-04-01T00:00:00Z',
  },
  {
    id: 'sticker-002',
    name: '모던 미니멀 스티커',
    preview_image_url: null,
    preview_color: '#F0F4F8',
    custom_fields: [
      {
        field_id: 'field-1',
        field_label: '이름',
        field_type: 'text',
        max_length: 15,
        required: true,
        position: { x: 25, y: 35, w: 50, h: 12 },
        font_size: 16,
      },
    ],
    is_active: true,
    created_at: '2026-04-02T00:00:00Z',
    updated_at: '2026-04-02T00:00:00Z',
  },
  {
    id: 'sticker-003',
    name: '플라워 감사 스티커',
    preview_image_url: null,
    preview_color: '#FFE8EC',
    custom_fields: [
      {
        field_id: 'field-1',
        field_label: '보내는 분',
        field_type: 'text',
        max_length: 20,
        required: true,
        position: { x: 20, y: 30, w: 60, h: 10 },
        font_size: 14,
      },
      {
        field_id: 'field-2',
        field_label: '메시지 종류',
        field_type: 'select',
        required: true,
        options: ['감사합니다', '축하합니다', '사랑합니다', '고맙습니다'],
        position: { x: 20, y: 55, w: 60, h: 12 },
        font_size: 12,
      },
    ],
    is_active: true,
    created_at: '2026-04-03T00:00:00Z',
    updated_at: '2026-04-03T00:00:00Z',
  },
];

export const MOCK_BG_PRODUCT_SETTINGS: BgProductSettings[] = [
  {
    id: 'ps-001',
    product_id: 'PROD-001',
    lead_time_days: 5,
    express_available: true,
    express_fee: 5000,
    express_cutoff_time: '14:00',
    available_sticker_ids: ['sticker-001', 'sticker-002', 'sticker-003'],
    blackout_dates: ['2026-05-01'],
    max_select_days: 60,
    created_at: '2026-04-01T00:00:00Z',
    updated_at: '2026-04-01T00:00:00Z',
  },
];

export const MOCK_BG_ORDER_FOR_CUSTOMER: BgOrderForCustomer = {
  order_id: 'test-order-1',
  order_number: 'BRS-20260001',
  customer_name: '홍*동',
  order_date: '2026-04-10T09:00:00Z',
  total_amount: 150000,
  status: 'collected',
  info_status: 'pending',
  products: [
    {
      id: 'item-001',
      product_id: 'prod-uuid-001',
      product_name: '프리미엄 답례떡 세트',
      product_code: 'PROD-001',
      quantity: 50,
      item_price: 3000,
    },
  ],
  product_settings: MOCK_BG_PRODUCT_SETTINGS[0],
  available_stickers: MOCK_BG_STICKERS,
  existing_info: null,
  bank_info: BG_BANK_INFO,
};

export const MOCK_BG_SUBMITTED_INFO: BgOrderCustomerInfo = {
  id: 'info-001',
  order_id: 'test-order-1',
  is_express: false,
  express_fee: 0,
  desired_ship_date: '2026-04-25',
  sticker_selections: [
    {
      product_id: 'PROD-001',
      sticker_id: 'sticker-001',
      custom_values: {
        'field-1': '홍길동',
        'field-2': '2026-04-25',
        'field-3': '감사합니다',
      },
    },
  ],
  cash_receipt_yn: false,
  receipt_type: null,
  receipt_number: null,
  submitted_at: '2026-04-15T10:30:00Z',
  created_at: '2026-04-15T10:30:00Z',
};
