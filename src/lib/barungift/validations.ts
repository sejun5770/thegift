import { z } from 'zod';

// ============================================
// Zod 검증 스키마
// ============================================

/** 고객 정보 제출 바디 검증 */
export const customerInfoSubmitSchema = z.object({
  is_express: z.boolean(),
  express_fee: z.number().int().min(0).default(0),
  desired_ship_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '날짜 형식이 올바르지 않습니다.'),
  sticker_selections: z.array(
    z.object({
      product_id: z.string().min(1),
      sticker_id: z.string().uuid(),
      custom_values: z.record(z.string(), z.string()),
    })
  ),
  cash_receipt_yn: z.boolean(),
  receipt_type: z.enum(['personal', 'business']).nullable().default(null),
  receipt_number: z.string().nullable().default(null),
});

/** 스티커 생성 바디 검증 */
export const stickerCreateSchema = z.object({
  name: z.string().min(1, '스티커명을 입력해주세요.').max(100),
  preview_image_url: z.string().url().optional().or(z.literal('')),
  preview_color: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/, '올바른 HEX 색상코드를 입력해주세요.')
    .default('#FFFFFF'),
  custom_fields: z
    .array(
      z.object({
        field_id: z.string().min(1),
        field_label: z.string().min(1),
        field_type: z.enum(['text', 'date', 'select']),
        max_length: z.number().int().positive().optional(),
        required: z.boolean().default(false),
        options: z.array(z.string()).optional(),
        position: z.object({
          x: z.number().min(0).max(100),
          y: z.number().min(0).max(100),
          w: z.number().min(0).max(100),
          h: z.number().min(0).max(100),
        }),
        font_size: z.number().positive().optional(),
        font_family: z.string().optional(),
      })
    )
    .default([]),
  is_active: z.boolean().default(true),
});

/** 스티커 수정 바디 검증 */
export const stickerUpdateSchema = stickerCreateSchema.partial();

/** 상품 설정 수정 바디 검증 */
export const productSettingsUpdateSchema = z.object({
  lead_time_days: z.number().int().min(1).max(90).optional(),
  express_available: z.boolean().optional(),
  express_fee: z.number().int().min(0).optional(),
  express_cutoff_time: z
    .string()
    .regex(/^\d{2}:\d{2}$/, '시간 형식이 올바르지 않습니다 (HH:mm).')
    .optional(),
  available_sticker_ids: z.array(z.string().uuid()).optional(),
  blackout_dates: z
    .array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/))
    .optional(),
  max_select_days: z.number().int().min(1).max(365).optional(),
});

/** 알림톡 발송 바디 검증 */
export const alimtalkSendSchema = z.object({
  order_id: z.string().min(1),
  customer_phone: z.string().min(1),
  customer_name: z.string().min(1),
  product_name: z.string().min(1),
});
