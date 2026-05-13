/**
 * 쿠팡 주문 저장소 — Supabase coupang_orders / coupang_sync_state CRUD.
 *
 * apiOrders 가 MSSQL 결과와 UNION 할 때 사용. 정규화된 행 단위로 보관.
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

/**
 * 다수 row upsert — 쿠팡 동기화 결과 일괄 저장.
 *   on_conflict: Unique 키 (coupang_order_id, shipment_box_id, vendor_item_id) 기준 merge.
 *   resolution=merge-duplicates: 충돌 row 의 모든 컬럼 새 값으로 덮어쓰기.
 */
async function upsertCoupangOrders(rows) {
  if (!USE_SUPABASE) return { upserted: 0, skipped: rows.length, reason: 'supabase_not_configured' };
  if (!rows.length) return { upserted: 0 };
  const url = `${REST_BASE}/coupang_orders?on_conflict=coupang_order_id,shipment_box_id,vendor_item_id`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...HEADERS, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase upsert coupang_orders [${res.status}]: ${text.slice(0, 500)}`);
  }
  return { upserted: rows.length };
}

/**
 * 기간 조회 — 주문조회/대시보드 매출 집계 통합용.
 *   startStr / endStr: 'YYYY-MM-DD' (end exclusive)
 *   기간 차원은 ordered_at (paid_at 기준 원하면 byPaid=true)
 */
async function listCoupangOrders({ startStr, endStr, byPaid = false } = {}) {
  if (!USE_SUPABASE) return [];
  const col = byPaid ? 'paid_at' : 'ordered_at';
  const params = [];
  if (startStr) params.push(`${col}=gte.${encodeURIComponent(startStr)}`);
  if (endStr) params.push(`${col}=lt.${encodeURIComponent(endStr)}`);
  params.push(`order=${col}.desc`);
  return sbGet('coupang_orders', params.join('&'));
}

/**
 * 마지막 동기화 메타 조회.
 */
async function getSyncState() {
  if (!USE_SUPABASE) return null;
  const rows = await sbGet('coupang_sync_state', 'id=eq.1');
  return rows[0] || null;
}

/**
 * 동기화 메타 업데이트 — 매 sync 끝에 호출.
 */
async function updateSyncState(patch) {
  if (!USE_SUPABASE) return null;
  const url = `${REST_BASE}/coupang_sync_state?id=eq.1`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { ...HEADERS, Prefer: 'return=representation' },
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase update coupang_sync_state [${res.status}]: ${text.slice(0, 300)}`);
  }
  const rows = await res.json();
  return rows[0] || null;
}

module.exports = {
  USE_SUPABASE,
  upsertCoupangOrders,
  listCoupangOrders,
  getSyncState,
  updateSyncState,
};
