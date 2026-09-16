import { fetchOrders } from './client';
import { mapCafe24Orders, type MappedCafeOrder } from './mapper';
import type { CafeCollectionSummary } from '@/types/cafe24';

const SOURCE = 'cafe24';

/** YYYY-MM-DD (카페24 API 기간 파라미터용) */
function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 마지막 성공 수집의 last_order_date 조회 (수집 시작점) */
async function getLastCollectionDate(): Promise<Date | null> {
  const { createClient } = await import('@/lib/supabase/server');
  const supabase = await createClient();
  const { data } = await supabase
    .from('collection_runs')
    .select('last_order_date')
    .eq('source', SOURCE)
    .eq('status', 'completed')
    .order('completed_at', { ascending: false })
    .limit(1)
    .single();
  return data?.last_order_date ? new Date(data.last_order_date) : null;
}

async function createCollectionRun(): Promise<string | null> {
  const { createClient } = await import('@/lib/supabase/server');
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('collection_runs')
    .insert({ source: SOURCE, status: 'running' })
    .select('id')
    .single();
  if (error) {
    console.error('[Cafe24 Collection] run 기록 생성 실패:', error.message);
    return null;
  }
  return data.id;
}

async function updateCollectionRun(
  runId: string,
  update: {
    status: 'completed' | 'failed';
    orders_collected?: number;
    orders_skipped?: number;
    last_order_date?: string;
    error_message?: string;
  },
): Promise<void> {
  const { createClient } = await import('@/lib/supabase/server');
  const supabase = await createClient();
  await supabase
    .from('collection_runs')
    .update({ ...update, completed_at: new Date().toISOString() })
    .eq('id', runId);
}

/** 매핑된 주문을 orders/order_items 에 upsert (cafe24_order_id 유니크로 멱등) */
async function upsertOrders(orders: MappedCafeOrder[]): Promise<{ inserted: number; skipped: number }> {
  const { createClient } = await import('@/lib/supabase/server');
  const supabase = await createClient();

  let inserted = 0;
  let skipped = 0;

  for (const order of orders) {
    // 중복 수집 방지 — cafe24_order_id 존재 여부
    const { data: existing } = await supabase
      .from('orders')
      .select('id')
      .eq('cafe24_order_id', order.cafe24_order_id)
      .single();
    if (existing) {
      skipped++;
      continue;
    }

    const { data: newOrder, error: orderError } = await supabase
      .from('orders')
      .insert({
        order_number: order.order_number,
        cafe24_order_id: order.cafe24_order_id,
        order_source: order.order_source,
        status: order.status,
        shipping_method: order.shipping_method,
        desired_shipping_date: order.desired_shipping_date,
        original_desired_shipping_date: order.original_desired_shipping_date,
        recipient_name: order.recipient_name,
        recipient_phone: order.recipient_phone,
        recipient_address: order.recipient_address,
        recipient_zipcode: order.recipient_zipcode,
        delivery_message: order.delivery_message,
        order_amount: order.order_amount,
        is_incident: order.is_incident,
        total_product_count: order.total_product_count,
        total_item_quantity: order.total_item_quantity,
      })
      .select('id')
      .single();

    if (orderError || !newOrder) {
      console.error(`[Cafe24 Collection] 주문 ${order.order_number} 삽입 실패:`, orderError?.message);
      skipped++;
      continue;
    }

    if (order.items.length > 0) {
      const orderItems = order.items.map((item) => ({
        order_id: newOrder.id,
        product_name: item.product_name,
        product_code: item.product_code,
        quantity: item.quantity,
        item_price: item.item_price,
        input_message: item.input_message,
        sort_order: item.sort_order,
      }));
      await supabase.from('order_items').insert(orderItems);
    }

    await supabase.from('order_history').insert({
      order_id: newOrder.id,
      action: 'order_collected',
      description: `정수당(카페24) 주문 수집 (${order.order_number})`,
    });

    inserted++;
  }

  return { inserted, skipped };
}

/** 정수당(카페24) 주문 수집 메인 */
export async function collectCafe24Orders(sinceDate?: Date): Promise<CafeCollectionSummary> {
  const startTime = Date.now();

  let since = sinceDate ?? (await getLastCollectionDate());
  if (!since) {
    since = new Date();
    since.setDate(since.getDate() - 7); // 기본 7일 전
  }
  const until = new Date();

  const runId = await createCollectionRun();

  try {
    // 카페24 주문 API 는 최대 3개월/호출 → 기간을 최대 80일 단위로 분할
    const orders = [];
    let winStart = new Date(since);
    while (winStart < until) {
      const winEnd = new Date(winStart);
      winEnd.setDate(winEnd.getDate() + 80);
      const rangeEnd = winEnd < until ? winEnd : until;
      const batch = await fetchOrders(ymd(winStart), ymd(rangeEnd));
      orders.push(...batch);
      winStart = new Date(rangeEnd);
      winStart.setDate(winStart.getDate() + 1);
    }

    const mapped = mapCafe24Orders(orders);
    const { inserted, skipped } = await upsertOrders(mapped);

    // 최신 주문일 (다음 수집 워터마크)
    let latestOrderDate: string | null = null;
    for (const m of mapped) {
      if (m.order_date && (!latestOrderDate || m.order_date > latestOrderDate)) {
        latestOrderDate = m.order_date;
      }
    }

    if (runId) {
      await updateCollectionRun(runId, {
        status: 'completed',
        orders_collected: inserted,
        orders_skipped: skipped,
        last_order_date: latestOrderDate ?? undefined,
      });
    }

    return {
      orders_collected: inserted,
      orders_skipped: skipped,
      items_collected: mapped.reduce((s, m) => s + m.items.length, 0),
      duration_ms: Date.now() - startTime,
      since_date: since.toISOString(),
      latest_order_date: latestOrderDate,
    };
  } catch (error) {
    if (runId) {
      await updateCollectionRun(runId, {
        status: 'failed',
        error_message: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  }
}

/** 수집 대상 건수 미리보기 (결제완료 & 미매핑 기준 근사) */
export async function previewCafe24Count(sinceDate?: Date): Promise<{ count: number; since_date: string }> {
  let since = sinceDate ?? (await getLastCollectionDate());
  if (!since) {
    since = new Date();
    since.setDate(since.getDate() - 7);
  }
  const until = new Date();
  const orders = await fetchOrders(ymd(since), ymd(until));
  const count = mapCafe24Orders(orders).length;
  return { count, since_date: since.toISOString() };
}

/** 수집 이력 */
export async function getCafe24CollectionHistory(limit = 20) {
  const { createClient } = await import('@/lib/supabase/server');
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('collection_runs')
    .select('*')
    .eq('source', SOURCE)
    .order('started_at', { ascending: false })
    .limit(limit);
  if (error) {
    console.error('[Cafe24 Collection] 이력 조회 실패:', error.message);
    return [];
  }
  return data ?? [];
}
