import type { BarunsonCollectedRow } from '@/types/barunson';
import { maskName, maskPhone, maskAddress } from './pii-masker';

interface MappedOrder {
  order_number: string;
  order_source: 'external';
  status: 'collected';
  shipping_method: 'parcel';
  desired_shipping_date: string;
  collected_at: string;
  original_desired_shipping_date: string | null;
  recipient_name: string;
  recipient_phone: string | null;
  recipient_address: string | null;
  recipient_zipcode: string | null;
  delivery_message: string | null;
  order_amount: number;
  is_incident: boolean;
  total_product_count: number;
  total_item_quantity: number;
  items: MappedOrderItem[];
  barunson_order_seq: number;
  barunson_status_seq: number;
  barunson_settle_status: number | null;
}

interface MappedOrderItem {
  product_name: string;
  product_code: string;
  quantity: number;
  item_price: number;
  sort_order: number;
}

/**
 * 바른손 DB 원시 행들을 thegift 주문 형태로 변환
 * JOIN 결과(1행 = 1주문항목)를 order_seq별로 그룹핑한 뒤 매핑
 */
export function mapBarunsonRows(rows: BarunsonCollectedRow[]): MappedOrder[] {
  // order_seq별 그룹핑
  const grouped = new Map<number, BarunsonCollectedRow[]>();
  for (const row of rows) {
    const existing = grouped.get(row.order_seq);
    if (existing) {
      existing.push(row);
    } else {
      grouped.set(row.order_seq, [row]);
    }
  }

  const orders: MappedOrder[] = [];

  for (const [orderSeq, orderRows] of grouped) {
    const first = orderRows[0];

    // item_id 기준으로 중복 제거 (M:N 관계에서 발생 가능)
    const uniqueItems = deduplicateItems(orderRows);

    const items: MappedOrderItem[] = uniqueItems.map((row, index) => ({
      product_name: row.Card_Name,
      product_code: row.Card_Code,
      quantity: row.item_count,
      item_price: row.item_price,
      sort_order: index,
    }));

    const totalQuantity = items.reduce((sum, item) => sum + item.quantity, 0);
    const orderAmount = first.settle_price ?? first.last_total_price ?? first.order_total_price ?? 0;

    // desired_shipping_date: order_date + 7일 (리드타임 기본값)
    const orderDate = new Date(first.order_date);
    const desiredDate = new Date(orderDate);
    desiredDate.setDate(desiredDate.getDate() + 7);

    orders.push({
      order_number: `BRS-${orderSeq}`,
      order_source: 'external',
      status: 'collected',
      shipping_method: 'parcel',
      desired_shipping_date: formatDate(desiredDate),
      collected_at: new Date().toISOString(),
      original_desired_shipping_date: formatDate(desiredDate),
      recipient_name: maskName(first.delivery_name ?? first.order_name),
      recipient_phone: maskPhone(first.delivery_hphone ?? first.order_hphone),
      recipient_address: maskAddress(first.delivery_addr),
      recipient_zipcode: first.delivery_zipcode ?? null,
      delivery_message: null,
      order_amount: orderAmount,
      is_incident: false,
      total_product_count: items.length,
      total_item_quantity: totalQuantity,
      items,
      barunson_order_seq: orderSeq,
      barunson_status_seq: first.status_seq,
      barunson_settle_status: first.settle_status,
    });
  }

  return orders;
}

/** item_id 기준 중복 제거 */
function deduplicateItems(rows: BarunsonCollectedRow[]): BarunsonCollectedRow[] {
  const seen = new Set<number>();
  const unique: BarunsonCollectedRow[] = [];
  for (const row of rows) {
    if (!seen.has(row.item_id)) {
      seen.add(row.item_id);
      unique.push(row);
    }
  }
  return unique;
}

/** Date → YYYY-MM-DD */
function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}
