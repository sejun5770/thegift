/**
 * 카페24 주문 저장소 — Supabase cafe24_orders / cafe24_sync_state CRUD.
 *
 * apiOrders 가 MSSQL 결과와 UNION 할 때 사용. 정규화된 행 단위로 보관.
 * coupang/store.js 미러 — 동일 시그니처/동작. (cafe24_order_id 는 TEXT 이므로 in-list 인용 처리)
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
 * 다수 row upsert — 카페24 동기화 결과 일괄 저장.
 *   on_conflict: Unique 키 (cafe24_order_id, line_key) 기준 merge.
 *   resolution=merge-duplicates: 충돌 row 의 모든 컬럼 새 값으로 덮어쓰기.
 */
async function upsertCafe24Orders(rows) {
  if (!USE_SUPABASE) return { upserted: 0, skipped: rows.length, reason: 'supabase_not_configured' };
  if (!rows.length) return { upserted: 0 };
  const url = `${REST_BASE}/cafe24_orders?on_conflict=cafe24_order_id,line_key`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...HEADERS, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase upsert cafe24_orders [${res.status}]: ${text.slice(0, 500)}`);
  }
  return { upserted: rows.length };
}

/**
 * PostgREST in-list 용 TEXT 값 인용 — 콤마/공백/특수문자 방어.
 *   cafe24 order_id 는 보통 '20260722-0000012' 형태라 콤마는 없지만 안전하게 큰따옴표 래핑.
 */
function quoteInList(ids) {
  return ids.map(v => `"${String(v).replace(/"/g, '')}"`).join(',');
}

/**
 * 기간 조회 — 주문조회/대시보드 매출 집계 통합용.
 *   startStr / endStr: 'YYYY-MM-DD' (end exclusive)
 *   기간 차원은 ordered_at (paid_at 기준 원하면 byPaid=true)
 *   orderIds: cafe24_order_id(TEXT) 배열 — 지정 시 기간과 OR 조건으로 추가 매칭 (정보입력현황 옛날 CI 매칭용).
 *
 * 기본: 모든 status row 반환 (CARD/ETC 의 MSSQL 조회 패턴과 동일).
 *   매출 집계 측 (apiSummary 등) 에서 자체적으로 취소 status row 를 필터.
 */
async function listCafe24Orders({ startStr, endStr, byPaid = false, orderIds } = {}) {
  if (!USE_SUPABASE) return [];
  const col = byPaid ? 'paid_at' : 'ordered_at';
  // orderIds OR 모드 — PostgREST `or=(a.eq.x,b.eq.y)` syntax 활용.
  if (Array.isArray(orderIds) && orderIds.length) {
    const inList = quoteInList(orderIds);
    const params = [];
    if (startStr && endStr) {
      // (in range) OR (in ids) — PostgREST 의 or() 함수
      params.push(`or=(and(${col}.gte.${encodeURIComponent(startStr)},${col}.lt.${encodeURIComponent(endStr)}),cafe24_order_id.in.(${inList}))`);
    } else {
      params.push(`cafe24_order_id=in.(${inList})`);
    }
    params.push(`order=${col}.desc`);
    return sbGet('cafe24_orders', params.join('&'));
  }
  const params = [];
  if (startStr) params.push(`${col}=gte.${encodeURIComponent(startStr)}`);
  if (endStr) params.push(`${col}=lt.${encodeURIComponent(endStr)}`);
  params.push(`order=${col}.desc`);
  return sbGet('cafe24_orders', params.join('&'));
}

/**
 * 마지막 동기화 메타 조회.
 */
async function getSyncState() {
  if (!USE_SUPABASE) return null;
  const rows = await sbGet('cafe24_sync_state', 'id=eq.1');
  return rows[0] || null;
}

/**
 * 동기화 메타 업데이트 — 매 sync 끝에 호출.
 */
async function updateSyncState(patch) {
  if (!USE_SUPABASE) return null;
  const url = `${REST_BASE}/cafe24_sync_state?id=eq.1`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { ...HEADERS, Prefer: 'return=representation' },
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase update cafe24_sync_state [${res.status}]: ${text.slice(0, 300)}`);
  }
  const rows = await res.json();
  return rows[0] || null;
}

module.exports = {
  USE_SUPABASE,
  upsertCafe24Orders,
  listCafe24Orders,
  getSyncState,
  updateSyncState,
};
