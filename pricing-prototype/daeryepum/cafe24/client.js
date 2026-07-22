/**
 * 카페24 Admin API 래퍼 — src/lib/cafe24/client.ts 포팅.
 *   getAccessToken() 으로 Bearer 토큰 주입, 429 지수 백오프 재시도.
 *
 * 환경변수:
 *   CAFE24_MALL_ID     — 몰 아이디 (기본 'barunn01')
 *   CAFE24_API_VERSION — Admin API 버전 (기본 '2025-06-01')
 */
'use strict';

const { getAccessToken } = require('./auth');

const MALL = process.env.CAFE24_MALL_ID || 'barunn01';
const ADMIN_BASE = `https://${MALL}.cafe24api.com/api/v2/admin`;
const VERSION = process.env.CAFE24_API_VERSION || '2025-06-01';

function isConfigured() {
  return !!(process.env.CAFE24_CLIENT_ID && process.env.CAFE24_CLIENT_SECRET);
}

/** 카페24 Admin API GET 래퍼 (429 레이트리밋 지수 백오프 재시도) */
async function cafe24Get(path, params = {}) {
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
      throw new Error(`Cafe24 API ${res.status} (${path}): ${(await res.text()).slice(0, 500)}`);
    }
    return res.json();
  }
}

/**
 * 기간 내 주문 조회 (order_date 기준, 페이지네이션 포함).
 *   카페24 주문 API 는 최대 3개월 범위/호출 → 장기 백필 시 호출측(sync)에서 기간 분할 필요.
 *   embed=items,receivers,buyer 로 품목/수령자/주문자 포함.
 *   startDate/endDate: 'YYYY-MM-DD'
 */
async function fetchOrders(startDate, endDate) {
  const all = [];
  const limit = 500;
  let offset = 0;

  for (;;) {
    const data = await cafe24Get('/orders', {
      start_date: startDate,
      end_date: endDate,
      date_type: 'order_date',
      embed: 'items,receivers,buyer',
      limit: String(limit),
      offset: String(offset),
    });
    const orders = (data && data.orders) || [];
    all.push(...orders);
    if (orders.length < limit) break;
    offset += limit;
    if (offset > 100000) break; // 안전 상한
  }
  return all;
}

module.exports = {
  isConfigured,
  cafe24Get,
  fetchOrders,
  MALL,
  VERSION,
};
