import type {
  BgSticker,
  BgProductSettings,
  BgOrderCustomerInfo,
  BgOrderForCustomer,
  BgStickerCreateBody,
  BgProductSettingsUpdateBody,
  BgCustomerInfoSubmitBody,
} from './types';
import { BG_BANK_INFO } from './constants';

// ============================================
// Supabase 헬퍼
// ============================================

async function getSupabase() {
  const { createClient } = await import('@/lib/supabase/server');
  return createClient();
}

// ============================================
// 고객 페이지용 쿼리
// ============================================

/** 고객 페이지용 주문 상세 조회 */
export async function getOrderForCustomer(orderId: string): Promise<BgOrderForCustomer | null> {
  const supabase = await getSupabase();

  // 주문 기본 정보 조회
  const { data: order, error: orderError } = await supabase
    .from('orders')
    .select(`
      id, order_number, recipient_name, collected_at, order_amount, status, is_deleted,
      order_items (id, product_id, product_name, product_code, quantity, item_price)
    `)
    .eq('order_number', orderId)
    .eq('is_deleted', false)
    .single();

  if (orderError || !order) return null;

  // 첫 번째 상품의 product_code로 product_settings 조회
  const productCode = order.order_items?.[0]?.product_code;
  let productSettings: BgProductSettings | null = null;

  if (productCode) {
    const { data: settings } = await supabase
      .from('bg_product_settings')
      .select('*')
      .eq('product_id', productCode)
      .single();
    productSettings = settings;
  }

  // 사용 가능한 스티커 조회
  let availableStickers: BgSticker[] = [];
  if (productSettings?.available_sticker_ids?.length) {
    const { data: stickers } = await supabase
      .from('bg_stickers')
      .select('*')
      .in('id', productSettings.available_sticker_ids)
      .eq('is_active', true);
    availableStickers = stickers || [];
  }

  // 기존 고객 입력 정보 조회
  const { data: existingInfo } = await supabase
    .from('bg_order_customer_info')
    .select('*')
    .eq('order_id', orderId)
    .single();

  return {
    order_id: orderId,
    order_number: order.order_number,
    customer_name: order.recipient_name,
    order_date: order.collected_at,
    total_amount: order.order_amount,
    status: order.status,
    info_status: existingInfo?.submitted_at ? 'completed' : 'pending',
    products: (order.order_items || []).map((item: Record<string, unknown>) => ({
      id: item.id as string,
      product_id: item.product_id as string | null,
      product_name: item.product_name as string,
      product_code: item.product_code as string | null,
      quantity: item.quantity as number,
      item_price: item.item_price as number,
    })),
    product_settings: productSettings,
    available_stickers: availableStickers,
    existing_info: existingInfo,
    bank_info: BG_BANK_INFO,
  };
}

/** 고객 입력 정보 저장 + 관리자 orders/order_items 자동 반영 */
export async function saveOrderCustomerInfo(
  orderId: string, // order_number (VARCHAR)
  data: BgCustomerInfoSubmitBody
): Promise<BgOrderCustomerInfo> {
  const supabase = await getSupabase();

  // ── 1. bg_order_customer_info 저장 ─────────────────────────────
  const { data: saved, error } = await supabase
    .from('bg_order_customer_info')
    .insert({
      order_id: orderId,
      is_express: data.is_express,
      express_fee: data.express_fee,
      desired_ship_date: data.desired_ship_date,
      sticker_selections: data.sticker_selections,
      cash_receipt_yn: data.cash_receipt_yn,
      receipt_type: data.receipt_type,
      receipt_number: data.receipt_number,
      submitted_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (error) {
    if (error.code === '23505') throw new Error('ALREADY_SUBMITTED');
    throw new Error(error.message);
  }

  // ── 2. orders 테이블에서 UUID + order_items 조회 ───────────────
  const { data: order } = await supabase
    .from('orders')
    .select('id, order_items(id)')
    .eq('order_number', orderId)
    .eq('is_deleted', false)
    .single();

  if (!order) return saved; // orders에 없으면 bg 저장만 완료

  // ── 3. orders 핵심 필드 업데이트 ───────────────────────────────
  const orderUpdates: Record<string, unknown> = {
    desired_shipping_date: data.desired_ship_date,
  };
  if (data.is_express) {
    orderUpdates.shipping_method = 'same_day';
  }
  await supabase.from('orders').update(orderUpdates).eq('id', order.id);

  // ── 4. 스티커 선택 → order_items 반영 ─────────────────────────
  const firstItem = (order.order_items as { id: string }[])?.[0];
  const firstSel = data.sticker_selections?.[0];

  if (firstItem && firstSel?.sticker_id) {
    // 스티커 이름 + custom_fields(레이블) 조회
    const { data: sticker } = await supabase
      .from('bg_stickers')
      .select('name, custom_fields')
      .eq('id', firstSel.sticker_id)
      .single();

    let stickerName = sticker?.name ?? '';
    let inputMessage: string | null = null;

    if (sticker?.custom_fields) {
      const fields = sticker.custom_fields as Array<{
        field_id: string;
        field_label: string;
      }>;
      const parts = fields
        .filter((f) => firstSel.custom_values?.[f.field_id])
        .map((f) => `${f.field_label}: ${firstSel.custom_values[f.field_id]}`);
      if (parts.length) inputMessage = parts.join(' / ');
    }

    await supabase
      .from('order_items')
      .update({
        sticker_type1_name: stickerName || null,
        input_message: inputMessage,
      })
      .eq('id', firstItem.id);
  }

  // ── 5. 현금영수증 → admin_memo 자동 추가 ──────────────────────
  if (data.cash_receipt_yn && data.receipt_number) {
    const typeLabel = data.receipt_type === 'business' ? '사업자' : '개인';
    await supabase.from('admin_memos').insert({
      order_id: order.id,
      memo_text: `[현금영수증] ${typeLabel} / ${data.receipt_number}`,
    });
  }

  // ── 6. order_history 기록 ─────────────────────────────────────
  await supabase.from('order_history').insert({
    order_id: order.id,
    action: 'customer_info_submitted',
    description: '고객이 스티커·출고일 정보를 입력했습니다.',
    new_value: data.desired_ship_date,
  });

  return saved;
}

// ============================================
// 스티커 CRUD
// ============================================

/** 스티커 목록 조회 */
export async function getAllStickers(activeOnly = false): Promise<BgSticker[]> {
  const supabase = await getSupabase();

  let query = supabase.from('bg_stickers').select('*').order('created_at', { ascending: false });

  if (activeOnly) {
    query = query.eq('is_active', true);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data || [];
}

/** 스티커 생성 */
export async function createSticker(body: BgStickerCreateBody): Promise<BgSticker> {
  const supabase = await getSupabase();

  const { data, error } = await supabase
    .from('bg_stickers')
    .insert({
      name: body.name,
      preview_image_url: body.preview_image_url || null,
      preview_color: body.preview_color || '#FFFFFF',
      custom_fields: body.custom_fields || [],
      is_active: body.is_active ?? true,
    })
    .select()
    .single();

  if (error) throw new Error(error.message);
  return data;
}

/** 스티커 수정 */
export async function updateSticker(
  stickerId: string,
  body: Partial<BgStickerCreateBody>
): Promise<BgSticker> {
  const supabase = await getSupabase();

  const { data, error } = await supabase
    .from('bg_stickers')
    .update(body)
    .eq('id', stickerId)
    .select()
    .single();

  if (error) throw new Error(error.message);
  return data;
}

/** 스티커 소프트 삭제 */
export async function deleteSticker(stickerId: string): Promise<void> {
  const supabase = await getSupabase();

  const { error } = await supabase
    .from('bg_stickers')
    .update({ is_active: false })
    .eq('id', stickerId);

  if (error) throw new Error(error.message);
}

// ============================================
// 상품 설정 CRUD
// ============================================

/** 상품 설정 조회 */
export async function getProductSettings(productId: string): Promise<BgProductSettings | null> {
  const supabase = await getSupabase();

  const { data, error } = await supabase
    .from('bg_product_settings')
    .select('*')
    .eq('product_id', productId)
    .single();

  if (error && error.code !== 'PGRST116') throw new Error(error.message);
  return data;
}

/** 상품 설정 upsert */
export async function upsertProductSettings(
  productId: string,
  body: BgProductSettingsUpdateBody
): Promise<BgProductSettings> {
  const supabase = await getSupabase();

  const { data, error } = await supabase
    .from('bg_product_settings')
    .upsert(
      { product_id: productId, ...body },
      { onConflict: 'product_id' }
    )
    .select()
    .single();

  if (error) throw new Error(error.message);
  return data;
}

/** 모든 상품 설정 목록 조회 */
export async function getAllProductSettings(): Promise<BgProductSettings[]> {
  const supabase = await getSupabase();

  const { data, error } = await supabase
    .from('bg_product_settings')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) throw new Error(error.message);
  return data || [];
}
