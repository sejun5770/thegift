import { getAccessToken } from './auth';
import type { Cafe24Order } from '@/types/cafe24';

const MALL = process.env.CAFE24_MALL_ID || 'barunn01';
const ADMIN_BASE = `https://${MALL}.cafe24api.com/api/v2/admin`;
const VERSION = process.env.CAFE24_API_VERSION || '2025-06-01';

/** 카페24 Admin API GET 래퍼 (429 레이트리밋 지수 백오프 재시도) */
export async function cafe24Get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const token = await getAccessToken();
  const qs = new URLSearchParams(params).toString();
  const url = `${ADMIN_BASE}${path}${qs ? `?${qs}` : ''}`;

  const MAX_RETRY = 4;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Cafe24-Api-Version': VERSION,
      },
    });

    if (res.status === 429 && attempt < MAX_RETRY) {
      // 몰당 버킷(초당) 제한 — 지수 백오프
      const wait = Math.min(2000, 200 * 2 ** attempt);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!res.ok) {
      throw new Error(`Cafe24 API ${res.status} (${path}): ${await res.text()}`);
    }
    return res.json() as Promise<T>;
  }
}

/**
 * 기간 내 주문 조회 (order_date 기준, 페이지네이션 포함).
 *   카페24 주문 API 는 최대 3개월 범위/호출 → 장기 백필 시 호출측에서 기간 분할 필요.
 *   embed=items,receivers,buyer 로 품목/수령자/주문자 포함.
 */
export async function fetchOrders(startDate: string, endDate: string): Promise<Cafe24Order[]> {
  const all: Cafe24Order[] = [];
  const limit = 500;
  let offset = 0;

  for (;;) {
    const data = await cafe24Get<{ orders?: Cafe24Order[] }>('/orders', {
      start_date: startDate, // 'YYYY-MM-DD'
      end_date: endDate,
      date_type: 'order_date',
      embed: 'items,receivers,buyer',
      limit: String(limit),
      offset: String(offset),
    });
    const orders = data.orders || [];
    all.push(...orders);
    if (orders.length < limit) break;
    offset += limit;
    if (offset > 100000) break; // 안전 상한
  }
  return all;
}
