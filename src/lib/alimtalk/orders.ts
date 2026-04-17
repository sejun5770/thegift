import { DAERYEPUM_CARD_CODES } from '@/types/barunson';
import { sendAlimtalk } from './biztalk';
import { buildMessagePayload } from './template';
import type { SendAlimtalkResult } from './types';

// ============================================
// 답례품 주문 × 알림톡 연결 헬퍼
// ============================================

const DAERYEPUM_CODES = DAERYEPUM_CARD_CODES as readonly string[];

export interface RecipientFilters {
  /** 희망출고일 시작 (YYYY-MM-DD) */
  startDate?: string;
  /** 희망출고일 종료 (YYYY-MM-DD) */
  endDate?: string;
  /** 알림톡 발송 이력 필터 */
  sentStatus?: 'sent' | 'unsent' | 'all';
  /** 주문번호/수신자명 검색 */
  search?: string;
  page?: number;
  limit?: number;
}

export interface RecipientRow {
  order_id: string;
  order_number: string | null;
  recipient_name: string | null;
  recipient_phone: string | null;
  status: string | null;
  desired_shipping_date: string | null;
  collected_at: string | null;
  product_name: string | null;
  product_code: string | null;
  last_alimtalk_sent_at: string | null;
  alimtalk_send_count: number;
}

interface OrderItemRow {
  product_code: string | null;
  product_name: string | null;
  sort_order: number | null;
}

interface OrderRow {
  id: string;
  order_number: string | null;
  recipient_name: string | null;
  recipient_phone: string | null;
  status: string | null;
  desired_shipping_date: string | null;
  collected_at: string | null;
  order_items: OrderItemRow[] | null;
}

type SupabaseClient = Awaited<ReturnType<typeof import('@/lib/supabase/server').createClient>>;

function pickDaeryepumItem(items: OrderItemRow[] | null): OrderItemRow | null {
  if (!items || items.length === 0) return null;
  const matched = items.find(
    (it) => it.product_code && DAERYEPUM_CODES.includes(it.product_code)
  );
  if (matched) return matched;
  return null;
}

async function fetchAlimtalkHistory(
  supabase: SupabaseClient,
  orderIds: string[]
): Promise<Map<string, { lastSentAt: string | null; count: number }>> {
  const result = new Map<string, { lastSentAt: string | null; count: number }>();
  if (orderIds.length === 0) return result;

  const { data } = await supabase
    .from('order_history')
    .select('order_id, created_at')
    .eq('action', 'alimtalk_sent')
    .in('order_id', orderIds)
    .order('created_at', { ascending: false });

  for (const row of (data ?? []) as Array<{ order_id: string; created_at: string }>) {
    const existing = result.get(row.order_id);
    if (existing) {
      existing.count += 1;
    } else {
      result.set(row.order_id, { lastSentAt: row.created_at, count: 1 });
    }
  }
  return result;
}

/**
 * 답례품 주문 수신자 목록 조회.
 *
 * Supabase 스키마상 상품코드는 `order_items.product_code`에만 존재하므로
 * inner join으로 DAERYEPUM_CARD_CODES에 해당하는 아이템이 있는 주문만 조회한다.
 */
export async function fetchDaeryepumRecipients(
  supabase: SupabaseClient,
  filters: RecipientFilters
): Promise<{ rows: RecipientRow[]; total: number }> {
  const page = Math.max(1, filters.page ?? 1);
  const limit = Math.max(1, Math.min(200, filters.limit ?? 50));
  const offset = (page - 1) * limit;

  let query = supabase
    .from('orders')
    .select(
      `
        id,
        order_number,
        recipient_name,
        recipient_phone,
        status,
        desired_shipping_date,
        collected_at,
        order_items!inner (
          product_code,
          product_name,
          sort_order
        )
      `,
      { count: 'exact' }
    )
    .eq('is_deleted', false)
    .in('order_items.product_code', DAERYEPUM_CODES);

  if (filters.startDate && filters.endDate) {
    query = query
      .gte('desired_shipping_date', filters.startDate)
      .lte('desired_shipping_date', filters.endDate);
  }

  if (filters.search) {
    const s = filters.search.replace(/[%,]/g, '');
    query = query.or(
      `order_number.ilike.%${s}%,recipient_name.ilike.%${s}%`
    );
  }

  query = query
    .order('collected_at', { ascending: false })
    .range(offset, offset + limit - 1);

  const { data, error, count } = await query;
  if (error) throw new Error(error.message);

  const orders = (data ?? []) as OrderRow[];
  const orderIds = orders.map((o) => o.id);
  const history = await fetchAlimtalkHistory(supabase, orderIds);

  let rows: RecipientRow[] = orders.map((o) => {
    const item = pickDaeryepumItem(o.order_items);
    const hist = history.get(o.id);
    return {
      order_id: o.id,
      order_number: o.order_number,
      recipient_name: o.recipient_name,
      recipient_phone: o.recipient_phone,
      status: o.status,
      desired_shipping_date: o.desired_shipping_date,
      collected_at: o.collected_at,
      product_name: item?.product_name ?? null,
      product_code: item?.product_code ?? null,
      last_alimtalk_sent_at: hist?.lastSentAt ?? null,
      alimtalk_send_count: hist?.count ?? 0,
    };
  });

  if (filters.sentStatus === 'sent') {
    rows = rows.filter((r) => r.alimtalk_send_count > 0);
  } else if (filters.sentStatus === 'unsent') {
    rows = rows.filter((r) => r.alimtalk_send_count === 0);
  }

  return { rows, total: count ?? rows.length };
}

export interface SendForOrderResult {
  order_id: string;
  success: boolean;
  mock?: boolean;
  message_id?: string;
  skipped_reason?: 'not_daeryepum' | 'missing_phone' | 'order_not_found';
  error?: string;
}

/**
 * 단일 주문 ID로 알림톡 발송. 답례품 주문 여부와 수신자 전화번호를 검증한다.
 */
export async function sendAlimtalkForOrder(
  supabase: SupabaseClient,
  orderId: string
): Promise<SendForOrderResult> {
  const { data, error } = await supabase
    .from('orders')
    .select(
      `
        id,
        order_number,
        recipient_name,
        recipient_phone,
        order_items ( product_code, product_name, sort_order )
      `
    )
    .eq('id', orderId)
    .eq('is_deleted', false)
    .maybeSingle();

  if (error) {
    return { order_id: orderId, success: false, error: error.message };
  }
  if (!data) {
    return {
      order_id: orderId,
      success: false,
      skipped_reason: 'order_not_found',
    };
  }

  const order = data as {
    id: string;
    order_number: string | null;
    recipient_name: string | null;
    recipient_phone: string | null;
    order_items: OrderItemRow[] | null;
  };

  const item = pickDaeryepumItem(order.order_items);
  if (!item) {
    return {
      order_id: orderId,
      success: false,
      skipped_reason: 'not_daeryepum',
    };
  }

  if (!order.recipient_phone) {
    return {
      order_id: orderId,
      success: false,
      skipped_reason: 'missing_phone',
    };
  }

  const msg = buildMessagePayload({
    orderId: order.id,
    orderNumber: order.order_number,
    customerName: order.recipient_name,
    productName: item.product_name,
  });

  let result: SendAlimtalkResult;
  try {
    result = await sendAlimtalk({
      to: order.recipient_phone,
      templateCode: msg.templateCode,
      text: msg.text,
      buttons: msg.button ? [msg.button] : undefined,
    });
  } catch (e) {
    return {
      order_id: orderId,
      success: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }

  try {
    await supabase.from('order_history').insert({
      order_id: order.id,
      action: 'alimtalk_sent',
      description:
        `알림톡 발송: ${order.recipient_phone}` +
        (result.mock ? ' (mock)' : '') +
        (result.messageId ? ` / msgId=${result.messageId}` : ''),
      new_value: msg.customerUrl,
    });
  } catch (e) {
    console.error('[Alimtalk] history 기록 실패:', e);
  }

  if (!result.success) {
    return {
      order_id: orderId,
      success: false,
      mock: result.mock,
      error: result.message || result.code || '발송 실패',
    };
  }

  return {
    order_id: orderId,
    success: true,
    mock: result.mock,
    message_id: result.messageId,
  };
}
