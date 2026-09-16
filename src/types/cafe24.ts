/**
 * 카페24 Admin Orders API 응답 타입 (부분).
 *   embed=items,receivers,buyer 기준. 실제 필드는 몰 설정/버전에 따라 다를 수 있어
 *   파싱은 방어적으로 처리한다. (실주문 1건으로 옵션 위치 확정 필요 — mapper 주석 참고)
 */

export interface Cafe24AdditionalOption {
  name?: string;
  value?: string;
}

export interface Cafe24OrderItem {
  product_no?: number;
  product_code?: string;
  product_name?: string;
  quantity?: number | string;
  product_price?: number | string;
  /** 옵션 문자열 (예: "색상=화이트/희망출고일=2026-07-25") */
  option_value?: string;
  /** 추가입력 옵션 (예: [{name:'희망출고일', value:'2026-07-25'}, {name:'스티커 문구', value:'감사합니다'}]) */
  additional_option_values?: Cafe24AdditionalOption[];
}

export interface Cafe24Receiver {
  name?: string;
  cellphone?: string;
  phone?: string;
  address_full?: string;
  address1?: string;
  address2?: string;
  zipcode?: string;
  shipping_message?: string;
}

export interface Cafe24Order {
  order_id: string;
  order_date?: string;
  /** 결제 여부 'T'|'F' */
  paid?: string;
  canceled?: string;
  order_price_amount?: number | string;
  payment_amount?: number | string;
  items?: Cafe24OrderItem[];
  receivers?: Cafe24Receiver[];
  buyer?: { name?: string; cellphone?: string; phone?: string };
}

/** 수집 결과 요약 (barunson CollectionSummary 와 동일 형태 재사용) */
export interface CafeCollectionSummary {
  orders_collected: number;
  orders_skipped: number;
  items_collected: number;
  duration_ms: number;
  since_date: string;
  latest_order_date: string | null;
}
