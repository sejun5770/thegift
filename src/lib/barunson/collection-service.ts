import { fetchDaeryepumOrders, countDaeryepumOrders } from './queries';
import { mapBarunsonRows } from './mapper';
import type { CollectionSummary } from '@/types/barunson';

function isMockMode() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  return !supabaseUrl || supabaseUrl.includes('your_supabase');
}

/**
 * Supabase에서 마지막 성공한 수집 시각 조회
 */
async function getLastCollectionDate(): Promise<Date | null> {
  if (isMockMode()) return null;

  const { createClient } = await import('@/lib/supabase/server');
  const supabase = await createClient();

  const { data } = await supabase
    .from('collection_runs')
    .select('last_order_date')
    .eq('source', 'barunson')
    .eq('status', 'completed')
    .order('completed_at', { ascending: false })
    .limit(1)
    .single();

  if (data?.last_order_date) {
    return new Date(data.last_order_date);
  }
  return null;
}

/**
 * 수집 실행 기록 생성
 */
async function createCollectionRun(): Promise<string | null> {
  if (isMockMode()) return null;

  const { createClient } = await import('@/lib/supabase/server');
  const supabase = await createClient();

  const { data, error } = await supabase
    .from('collection_runs')
    .insert({ source: 'barunson', status: 'running' })
    .select('id')
    .single();

  if (error) {
    console.error('[Collection] Failed to create run record:', error.message);
    return null;
  }
  return data.id;
}

/**
 * 수집 실행 기록 업데이트
 */
async function updateCollectionRun(
  runId: string,
  update: {
    status: 'completed' | 'failed';
    orders_collected?: number;
    orders_skipped?: number;
    last_order_date?: string;
    error_message?: string;
  }
): Promise<void> {
  if (isMockMode()) return;

  const { createClient } = await import('@/lib/supabase/server');
  const supabase = await createClient();

  await supabase
    .from('collection_runs')
    .update({
      ...update,
      completed_at: new Date().toISOString(),
    })
    .eq('id', runId);
}

/**
 * 수집된 주문을 Supabase에 upsert
 */
async function upsertOrders(
  orders: ReturnType<typeof mapBarunsonRows>
): Promise<{ inserted: number; skipped: number }> {
  if (isMockMode()) {
    return { inserted: orders.length, skipped: 0 };
  }

  const { createClient } = await import('@/lib/supabase/server');
  const supabase = await createClient();

  let inserted = 0;
  let skipped = 0;

  for (const order of orders) {
    // 기존 주문 존재 여부 확인
    const { data: existing } = await supabase
      .from('orders')
      .select('id')
      .eq('order_number', order.order_number)
      .single();

    if (existing) {
      skipped++;
      continue;
    }

    // 주문 삽입
    const { data: newOrder, error: orderError } = await supabase
      .from('orders')
      .insert({
        order_number: order.order_number,
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

    if (orderError) {
      console.error(`[Collection] Order ${order.order_number} insert failed:`, orderError.message);
      skipped++;
      continue;
    }

    // 주문 항목 삽입
    if (order.items.length > 0 && newOrder) {
      const orderItems = order.items.map((item) => ({
        order_id: newOrder.id,
        product_name: item.product_name,
        product_code: item.product_code,
        quantity: item.quantity,
        item_price: item.item_price,
        sort_order: item.sort_order,
      }));

      await supabase.from('order_items').insert(orderItems);
    }

    // 이력 기록
    if (newOrder) {
      await supabase.from('order_history').insert({
        order_id: newOrder.id,
        action: 'order_collected',
        description: `바른손 답례품 주문 수집 (BRS-${order.barunson_order_seq})`,
      });
    }

    inserted++;
  }

  return { inserted, skipped };
}

/**
 * 답례품 주문 수집 메인 함수
 */
export async function collectDaeryepumOrders(
  sinceDate?: Date
): Promise<CollectionSummary> {
  const startTime = Date.now();

  // 수집 시작일 결정
  let since = sinceDate ?? await getLastCollectionDate();
  if (!since) {
    // 기본값: 7일 전
    since = new Date();
    since.setDate(since.getDate() - 7);
  }

  const until = new Date(); // 현재까지

  // 수집 실행 기록 생성
  const runId = await createCollectionRun();

  try {
    // 바른손 DB 쿼리
    const rows = await fetchDaeryepumOrders(since, until);

    // 데이터 매핑
    const orders = mapBarunsonRows(rows);

    // Supabase에 저장
    const { inserted, skipped } = await upsertOrders(orders);

    // 최신 주문일자 계산
    let latestOrderDate: string | null = null;
    if (rows.length > 0) {
      const maxDate = rows.reduce((max, row) =>
        row.order_date > max ? row.order_date : max,
        rows[0].order_date
      );
      latestOrderDate = new Date(maxDate).toISOString();
    }

    // 수집 기록 업데이트
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
      items_collected: rows.length,
      duration_ms: Date.now() - startTime,
      since_date: since.toISOString(),
      latest_order_date: latestOrderDate,
    };
  } catch (error) {
    // 수집 실패 기록
    if (runId) {
      await updateCollectionRun(runId, {
        status: 'failed',
        error_message: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  }
}

/**
 * 답례품 주문 건수 미리보기
 */
export async function previewDaeryepumCount(
  sinceDate?: Date
): Promise<{ count: number; since_date: string }> {
  let since = sinceDate ?? await getLastCollectionDate();
  if (!since) {
    since = new Date();
    since.setDate(since.getDate() - 7);
  }

  const until = new Date();
  const count = await countDaeryepumOrders(since, until);

  return { count, since_date: since.toISOString() };
}

/**
 * 수집 이력 조회
 */
export async function getCollectionHistory(limit = 20) {
  if (isMockMode()) {
    return [];
  }

  const { createClient } = await import('@/lib/supabase/server');
  const supabase = await createClient();

  const { data, error } = await supabase
    .from('collection_runs')
    .select('*')
    .eq('source', 'barunson')
    .order('started_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('[Collection] Failed to fetch history:', error.message);
    return [];
  }

  return data ?? [];
}
