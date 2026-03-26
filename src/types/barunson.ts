// 바른손 bar_shop1 DB 원시 타입 정의

/** 답례품 CardKind_Seq 값 (S2_CardKindInfo) */
export const DAERYEPUM_CARDKIND_SEQS = [4, 5, 16] as const;

/** 답례품으로 확인된 카드 코드 목록 */
export const DAERYEPUM_CARD_CODES = [
  'TGJSD03O2', 'TGIBK01D1', 'TGOSL006D1', 'TGOSL003D1',
  'OSL002', 'TGAMT01O1', 'TGJSD05D1', 'TGJSD08D1',
  'TGJSD01', 'OSL005', 'TGJSD02D1', 'TGJBK05D1',
  'TGJBK02D1', 'TGJBK03D1', 'TGJSD06D1', 'TGJSD04D1',
  'TGJSD07D1', 'TGJSD03O3', 'TGJBK04D1', 'TGJSD03O1',
  'TGJBK01D1', 'TGIKX01',
] as const;

/** custom_order 테이블 원시 행 */
export interface BarunsonOrderRow {
  order_seq: number;
  order_date: Date;
  status_seq: number;
  settle_status: number | null;
  settle_price: number | null;
  last_total_price: number | null;
  order_total_price: number | null;
  order_name: string | null;
  order_hphone: string | null;
  order_type: string | null;
  sales_Gubun: string | null;
  site_gubun: string | null;
  pay_Type: string | null;
}

/** custom_order_item 테이블 원시 행 */
export interface BarunsonOrderItemRow {
  item_id: number;
  order_seq: number;
  card_seq: number;
  item_type: string | null;
  item_count: number;
  item_price: number;
  item_sale_price: number | null;
  discount_rate: number | null;
}

/** S2_Card 테이블 원시 필드 */
export interface BarunsonCardRow {
  Card_Seq: number;
  Card_Code: string;
  Card_Name: string;
  Card_Price: number;
  Card_Div: string | null;
  CardBrand: string | null;
}

/** DELIVERY_INFO 테이블 원시 필드 */
export interface BarunsonDeliveryRow {
  ORDER_SEQ: number;
  DELIVERY_SEQ: number;
  NAME: string | null;
  PHONE: string | null;
  HPHONE: string | null;
  ADDR: string | null;
  ZIPCODE: string | null;
}

/** 쿼리 결과 JOIN된 단일 행 */
export interface BarunsonCollectedRow {
  // custom_order
  order_seq: number;
  order_date: Date;
  status_seq: number;
  settle_status: number | null;
  settle_price: number | null;
  last_total_price: number | null;
  order_total_price: number | null;
  order_name: string | null;
  order_hphone: string | null;
  order_type: string | null;
  sales_Gubun: string | null;
  site_gubun: string | null;
  // custom_order_item
  item_id: number;
  item_count: number;
  item_price: number;
  item_sale_price: number | null;
  // S2_Card
  Card_Code: string;
  Card_Name: string;
  Card_Price: number;
  Card_Div: string | null;
  CardBrand: string | null;
  CardKind_Seq: number;
  // DELIVERY_INFO
  delivery_name: string | null;
  delivery_phone: string | null;
  delivery_hphone: string | null;
  delivery_addr: string | null;
  delivery_zipcode: string | null;
  delivery_seq: number | null;
}

/** 수집 실행 기록 (Supabase collection_runs) */
export interface CollectionRun {
  id: string;
  source: string;
  status: 'running' | 'completed' | 'failed';
  started_at: string;
  completed_at: string | null;
  last_order_date: string | null;
  orders_collected: number;
  orders_skipped: number;
  error_message: string | null;
  created_at: string;
}

/** 수집 결과 요약 */
export interface CollectionSummary {
  orders_collected: number;
  orders_skipped: number;
  items_collected: number;
  duration_ms: number;
  since_date: string;
  latest_order_date: string | null;
}
