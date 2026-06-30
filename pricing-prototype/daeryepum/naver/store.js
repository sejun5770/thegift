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

/**
 * 네이버 주문 목록 조회.
 *   기본 정책: CANCELED/RETURNED/EXCHANGED 자동 제외 (CARD/ETC status_seq NOT IN (3,5,...) 와 동일).
 *   매출/주문조회/정보입력 등 모든 호출에서 취소 row 자동 필터.
 *   includeCanceled=true 면 취소 포함 (운영자 진단 / 취소 전용 화면용).
 *   orderIds 명시 시: 그 ID 들은 status 무관 모두 반환 (특정 취소 주문 검색 가능).
 */
async function listNaverOrders({ startStr, endStr, byPaid = false, orderIds, includeCanceled = false } = {}) {
  if (!USE_SUPABASE) return [];
  const col = byPaid ? 'paid_at' : 'ordered_at';
  // orderIds OR 모드 — product_order_id 기준 (옛날 customer_info 매칭용). status 무관 모두 반환.
  if (Array.isArray(orderIds) && orderIds.length) {
    const params = [];
    if (startStr && endStr) {
      params.push(`or=(and(${col}.gte.${encodeURIComponent(startStr)},${col}.lt.${encodeURIComponent(endStr)}),product_order_id.in.(${orderIds.map(id => `"${id}"`).join(',')}))`);
    } else {
      params.push(`product_order_id=in.(${orderIds.map(id => `"${id}"`).join(',')})`);
    }
    params.push(`order=${col}.desc`);
    return sbGet('naver_orders', params.join('&'));
  }
  const params = [];
  if (startStr) params.push(`${col}=gte.${encodeURIComponent(startStr)}`);
  if (endStr) params.push(`${col}=lt.${encodeURIComponent(endStr)}`);
  // 취소/반품/교환 자동 제외 (기본). includeCanceled=true 면 제외 안 함.
  if (!includeCanceled) {
    params.push('status=not.in.(CANCELED,RETURNED,EXCHANGED)');
  }
  params.push(`order=${col}.desc`);
  return sbGet('naver_orders', params.join('&'));
}

/**
 * 동기화 상태 조회.
 *   storeId 미지정 시 모든 store 의 row 배열 반환.
 *   storeId 지정 시 해당 store row 1개 반환.
 *   하위 호환: storeId 가 undefined 면 store_id='main' 단일 조회 (구버전 동작).
 */
async function getSyncState(storeId) {
  if (!USE_SUPABASE) return null;
  if (storeId === undefined) {
    // 구 호환: store_id='main' 단일 조회
    const rows = await sbGet('naver_sync_state', `store_id=eq.main`);
    return rows[0] || null;
  }
  if (storeId === '*') {
    return sbGet('naver_sync_state', 'order=store_id.asc');
  }
  const rows = await sbGet('naver_sync_state', `store_id=eq.${encodeURIComponent(storeId)}`);
  return rows[0] || null;
}

/**
 * 동기화 상태 갱신 — store_id 별 row 에 upsert.
 *   첫 인자 storeId 가 string 이면 신버전 (멀티 스토어).
 *   첫 인자가 객체이면 구버전 호환 — store_id='main' 으로 처리.
 */
async function updateSyncState(storeIdOrPatch, maybePatch) {
  if (!USE_SUPABASE) return null;
  let storeId, patch;
  if (typeof storeIdOrPatch === 'string') {
    storeId = storeIdOrPatch;
    patch = maybePatch || {};
  } else {
    storeId = 'main';
    patch = storeIdOrPatch || {};
  }
  // upsert via PostgREST on_conflict=store_id (unique index)
  const url = `${REST_BASE}/naver_sync_state?on_conflict=store_id`;
  const body = {
    store_id: storeId,
    ...patch,
    updated_at: new Date().toISOString(),
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...HEADERS, Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase upsert naver_sync_state [${res.status}]: ${text.slice(0, 300)}`);
  }
  const rows = await res.json();
  return Array.isArray(rows) ? (rows[0] || null) : rows;
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
