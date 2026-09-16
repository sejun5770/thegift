import type { Cafe24Order, Cafe24OrderItem } from '@/types/cafe24';
import { maskName, maskPhone, maskAddress } from '@/lib/barunson/pii-masker';

/**
 * PII 마스킹 여부 (§주2 결정 지점).
 *   thegift 가 정수당 답례품 출고/배송을 직접 수행 → 실제 수령인 원문이 필요하다고 판단하여
 *   기본 false(원문 유지). barunson 수집은 마스킹하지만, 직접 출고 특성상 다르게 둠.
 *   ※ 원문 저장이 정책상 불가하면 true 로 바꾸면 barunson 과 동일하게 마스킹됨.
 */
const MASK_PII = false;

export interface MappedCafeItem {
  product_name: string;
  product_code: string;
  quantity: number;
  item_price: number;
  input_message: string | null;
  sort_order: number;
}

export interface MappedCafeOrder {
  order_number: string;            // CF-{order_id}
  cafe24_order_id: string;
  order_source: 'cafe24';
  status: 'collected';
  shipping_method: 'parcel' | 'same_day';
  desired_shipping_date: string;   // YYYY-MM-DD
  original_desired_shipping_date: string;
  recipient_name: string;
  recipient_phone: string | null;
  recipient_address: string | null;
  recipient_zipcode: string | null;
  delivery_message: string | null;
  order_amount: number;
  total_product_count: number;
  total_item_quantity: number;
  is_incident: boolean;
  order_date: string | null;       // 수집 워터마크 계산용
  items: MappedCafeItem[];
}

/** 결제완료(paid='T') & 미취소 주문만 → thegift 주문으로 매핑 */
export function mapCafe24Orders(orders: Cafe24Order[]): MappedCafeOrder[] {
  const result: MappedCafeOrder[] = [];

  for (const o of orders) {
    if (!o.order_id) continue;
    if (o.paid !== 'T') continue;       // 결제완료 건만
    if (o.canceled === 'T') continue;   // 취소 제외

    const rawItems = Array.isArray(o.items) ? o.items : [];
    const items: MappedCafeItem[] = rawItems.map((it, idx) => ({
      product_name: String(it.product_name ?? '').trim() || '(상품명 없음)',
      product_code: String(it.product_code ?? '').trim(),
      quantity: toInt(it.quantity, 1),
      item_price: toInt(it.product_price, 0),
      input_message: parseStickerMessage(it),
      sort_order: idx,
    }));

    // shipping_method: '오늘출발' 품목 포함 시 same_day (§223: 오늘출발 품목은 별도 유지 + 배송방식 반영)
    const isSameDay = rawItems.some((it) =>
      String(it.product_name ?? '').includes('오늘출발'),
    );

    // 희망출고일: 옵션에서 파싱, 없으면 주문일+3영업일 폴백 (§주1: 실주문으로 옵션 위치 확정 필요)
    const desired = parseDesiredShippingDate(rawItems) ?? addBusinessDays(o.order_date, 3);

    const receiver = (Array.isArray(o.receivers) && o.receivers[0]) || {};
    const rawName = receiver.name ?? o.buyer?.name ?? '';
    const rawPhone = receiver.cellphone ?? receiver.phone ?? o.buyer?.cellphone ?? '';
    const rawAddr =
      receiver.address_full ??
      ([receiver.address1, receiver.address2].filter(Boolean).join(' ') || '');

    result.push({
      order_number: `CF-${o.order_id}`,
      cafe24_order_id: o.order_id,
      order_source: 'cafe24',
      status: 'collected',
      shipping_method: isSameDay ? 'same_day' : 'parcel',
      desired_shipping_date: desired,
      original_desired_shipping_date: desired,
      recipient_name: (MASK_PII ? maskName(rawName) : rawName.trim()) || '(수령인)',
      recipient_phone: rawPhone ? (MASK_PII ? maskPhone(rawPhone) : rawPhone.trim()) : null,
      recipient_address: rawAddr ? (MASK_PII ? maskAddress(rawAddr) : rawAddr.trim()) : null,
      recipient_zipcode: receiver.zipcode ? String(receiver.zipcode).trim() : null,
      delivery_message: receiver.shipping_message ? String(receiver.shipping_message).trim() : null,
      order_amount: toInt(o.payment_amount ?? o.order_price_amount, 0),
      total_product_count: items.length,
      total_item_quantity: items.reduce((s, i) => s + i.quantity, 0),
      is_incident: false,
      order_date: o.order_date ?? null,
      items,
    });
  }

  return result;
}

// ── 옵션 파싱 헬퍼 ─────────────────────────────────────────
//   ※주1: 카페24 프런트가 희망출고일/스티커문구를 어떤 옵션 필드로 전달하는지는
//   실주문 1건 API 응답으로 확정 필요. 아래는 additional_option_values(추가입력)와
//   option_value(옵션 문자열) 양쪽을 방어적으로 파싱.

const DATE_RE = /(\d{4})[-.\/](\d{1,2})[-.\/](\d{1,2})/;

/** 희망출고일 파싱 — 추가입력 옵션(name 에 '희망'&'출고' 포함) 또는 옵션 문자열에서 날짜 추출 */
function parseDesiredShippingDate(items: Cafe24OrderItem[]): string | null {
  for (const it of items) {
    for (const opt of it.additional_option_values ?? []) {
      const nm = String(opt.name ?? '');
      if (nm.includes('희망') && nm.includes('출고')) {
        const d = normalizeDate(opt.value);
        if (d) return d;
      }
    }
    const ov = String(it.option_value ?? '');
    const m = ov.match(/희망\s*출고일?\s*[:=]?\s*/);
    if (m) {
      const after = ov.slice(m.index! + m[0].length);
      const dm = after.match(DATE_RE);
      if (dm) return `${dm[1]}-${pad(dm[2])}-${pad(dm[3])}`;
    }
  }
  return null;
}

/** 스티커 문구 파싱 — 추가입력 옵션(name 에 '스티커' 또는 '문구' 포함) */
function parseStickerMessage(it: Cafe24OrderItem): string | null {
  for (const opt of it.additional_option_values ?? []) {
    const nm = String(opt.name ?? '');
    if (nm.includes('스티커') || nm.includes('문구')) {
      const v = String(opt.value ?? '').trim();
      if (v) return v;
    }
  }
  return null;
}

// ── 날짜 헬퍼 ─────────────────────────────────────────
function normalizeDate(v: string | undefined): string | null {
  const m = String(v ?? '').match(DATE_RE);
  return m ? `${m[1]}-${pad(m[2])}-${pad(m[3])}` : null;
}

/** 주문일 + N영업일 (주말 건너뜀). 주문일 없으면 오늘 기준. */
function addBusinessDays(orderDate: string | undefined, n: number): string {
  const base = orderDate ? new Date(orderDate) : new Date();
  const d = isNaN(base.getTime()) ? new Date() : base;
  let added = 0;
  while (added < n) {
    d.setDate(d.getDate() + 1);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) added++; // 주말 제외
  }
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function pad(v: number | string): string {
  return String(v).padStart(2, '0');
}

function toInt(v: unknown, fallback: number): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : fallback;
}
