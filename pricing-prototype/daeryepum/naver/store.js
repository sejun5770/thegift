/**
 * 네이버 스마트스토어 주문 저장소 — Supabase naver_orders / naver_sync_state CRUD.
 *   쿠팡 store.js 와 동일 구조.
 */
'use strict';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || '';
const USE_SUPABASE = !!(SUPABASE_URL && SUPABASE_KEY);
const REST_BASE = `${SUPABASE_URL}/rest/v1`;
const HEADERS = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
};

async function sbGet(table, params = '') {
  if (!USE_SUPABASE) return [];
  const url = `${REST_BASE}/${table}?select=*${params ? '&' + params : ''}`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase GET ${table} [${res.status}]: ${text.slice(0, 300)}`);
  }
  return res.json();
}

async function upsertNaverOrders(rows) {
  if (!USE_SUPABASE) return { upserted: 0, skipped: rows.length, reason: 'supabase_not_configured' };
  if (!rows.length) return { upserted: 0 };
  const url = `${REST_BASE}/naver_orders?on_conflict=product_order_id`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...HEADERS, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase upsert naver_orders [${res.status}]: ${text.slice(0, 500)}`);
  }
  return { upserted: rows.length };
}

/**
 * 정보입력현황 자동 입력완료 처리용 stub customer_info upsert.
 *   order_id 'NV-{product_order_id}' 로 ignore-duplicates 정책 (processed_at 보존).
 */
async function upsertNaverStubCustomerInfos(stubs) {
  if (!USE_SUPABASE || !stubs.length) return { upserted: 0 };
  const url = `${REST_BASE}/bg_order_customer_info?on_conflict=order_id`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...HEADERS, Prefer: 'resolution=ignore-duplicates,return=minimal' },
    body: JSON.stringify(stubs),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase upsert bg_order_customer_info stub [${res.status}]: ${text.slice(0, 300)}`);
  }
  return { upserted: stubs.length };
}

/**
 * 네이버 stub 의 enrichment 필드(sticker_selections, desired_ship_date) 만 PATCH.
 *   processed_at / customer_request 등 운영팀이 변경할 수 있는 필드는 건드리지 않음.
 *   ignore-duplicates 로 이전 sync 에서 생성된 빈 stub 도 새 옵션 파싱 결과로 채워짐.
 */
async function patchNaverStubEnrichment(orderId, { sticker_selections, desired_ship_date }) {
  if (!USE_SUPABASE) return { patched: 0 };
  const params = `order_id=eq.${encodeURIComponent(orderId)}`;
  const url = `${REST_BASE}/bg_order_customer_info?${params}`;
  const body = {};
  if (sticker_selections !== undefined) body.sticker_selections = sticker_selections;
  if (desired_ship_date !== undefined) body.desired_ship_date = desired_ship_date;
  if (!Object.keys(body).length) return { patched: 0 };
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { ...HEADERS, Prefer: 'return=minimal' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase patch bg_order_customer_info [${res.status}]: ${text.slice(0, 300)}`);
  }
  return { patched: 1 };
}

async function listNaverOrders({ startStr, endStr, byPaid = false } = {}) {
  if (!USE_SUPABASE) return [];
  const col = byPaid ? 'paid_at' : 'ordered_at';
  const params = [];
  if (startStr) params.push(`${col}=gte.${encodeURIComponent(startStr)}`);
  if (endStr) params.push(`${col}=lt.${encodeURIComponent(endStr)}`);
  params.push(`order=${col}.desc`);
  return sbGet('naver_orders', params.join('&'));
}

async function getSyncState() {
  if (!USE_SUPABASE) return null;
  const rows = await sbGet('naver_sync_state', 'id=eq.1');
  return rows[0] || null;
}

async function updateSyncState(patch) {
  if (!USE_SUPABASE) return null;
  const url = `${REST_BASE}/naver_sync_state?id=eq.1`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { ...HEADERS, Prefer: 'return=representation' },
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase update naver_sync_state [${res.status}]: ${text.slice(0, 300)}`);
  }
  const rows = await res.json();
  return rows[0] || null;
}

module.exports = {
  USE_SUPABASE,
  upsertNaverOrders,
  upsertNaverStubCustomerInfos,
  patchNaverStubEnrichment,
  listNaverOrders,
  getSyncState,
  updateSyncState,
};
