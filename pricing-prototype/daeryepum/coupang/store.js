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
 * 주문 단위 상태 갱신 — 취소 재확인(reconcile) 전용.
 *   목록 API 가 취소 건을 돌려주지 않아 upsert 로는 갱신되지 않는 케이스를 메운다.
 *   같은 coupang_order_id 의 모든 박스/품목 row 를 함께 갱신.
 */
async function updateCoupangOrderStatus(orderId, status, statusLabel) {
  if (!USE_SUPABASE) return { updated: 0, reason: 'supabase_not_configured' };
  const url = `${REST_BASE}/coupang_orders?coupang_order_id=eq.${encodeURIComponent(orderId)}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { ...HEADERS, Prefer: 'return=representation' },
    body: JSON.stringify({ status, status_label: statusLabel, synced_at: new Date().toISOString() }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Supabase update coupang_orders [${res.status}]: ${t.slice(0, 300)}`);
  }
  const rows = await res.json().catch(() => []);
  return { updated: Array.isArray(rows) ? rows.length : 0 };
}

/**
 * 기간 조회 — 주문조회/대시보드 매출 집계 통합용.
 *   startStr / endStr: 'YYYY-MM-DD' (end exclusive)
 *   기간 차원은 ordered_at (paid_at 기준 원하면 byPaid=true)
 *   orderIds: BIGINT 배열 — 지정 시 기간과 OR 조건으로 추가 매칭 (정보입력현황 옛날 CI 매칭용).
 */
/**
 * 쿠팡 주문 목록 조회.
 *   기본: 모든 status row 반환 (CARD/ETC 의 MSSQL 조회 패턴과 동일).
 *   주문조회 / 정보입력완료 등 모든 호출에서 취소 row 도 포함되어 표시 / 추적 가능.
 *   매출 집계 측 (apiSummary 등) 에서 자체적으로 status='CANCEL'/'RETURNS' row 를 필터.
 */
/**
 * @param {boolean} opts.excludeRocketGrowth 로켓그로스 주문 제외 (062).
 *   매출 집계에서만 켠다. 로켓그로스 매출은 정산 리포트(coupang_rg_order_lines)를
 *   소스로 별도 채널로 집계되므로, 여기서도 세면 같은 매출이 두 번 잡힌다.
 *   주문 목록·스티커 백필처럼 '주문을 보여주는' 호출은 끄고 그대로 포함한다.
 *
 *   서버에서 거르지 않고 받아온 뒤 거른다 — 062 마이그레이션 전이면 컬럼이 없어
 *   PostgREST 필터가 400 을 내고 대시보드가 통째로 죽는다.
 */
async function listCoupangOrders({ startStr, endStr, byPaid = false, orderIds, excludeRocketGrowth = false } = {}) {
  if (!USE_SUPABASE) return [];
  const col = byPaid ? 'paid_at' : 'ordered_at';
  const post = rows => (excludeRocketGrowth
    ? (rows || []).filter(r => !r.is_rocket_growth)
    : rows);
  // orderIds OR 모드 — PostgREST `or=(a.eq.x,b.eq.y)` syntax 활용.
  if (Array.isArray(orderIds) && orderIds.length) {
    const inClause = `coupang_order_id=in.(${orderIds.join(',')})`;
    const params = [];
    if (startStr && endStr) {
      // (in range) OR (in ids) — PostgREST 의 or() 함수
      params.push(`or=(and(${col}.gte.${encodeURIComponent(startStr)},${col}.lt.${encodeURIComponent(endStr)}),coupang_order_id.in.(${orderIds.join(',')}))`);
    } else {
      params.push(inClause);
    }
    params.push(`order=${col}.desc`);
    return post(await sbGet('coupang_orders', params.join('&')));
  }
  const params = [];
  if (startStr) params.push(`${col}=gte.${encodeURIComponent(startStr)}`);
  if (endStr) params.push(`${col}=lt.${encodeURIComponent(endStr)}`);
  params.push(`order=${col}.desc`);
  return post(await sbGet('coupang_orders', params.join('&')));
}

/**
 * 이미 있는 주문 row 에 로켓그로스 표시만 남긴다 (062).
 *
 * 로켓그로스 주문이 마켓플레이스 동기화로도 들어와 있는 경우가 있다(동시 운영 상품).
 * 그때 로켓그로스 쪽으로 새 row 를 만들면 unique 키의 shipment_box_id 가 달라
 * 같은 주문이 두 줄로 보인다. 게다가 로켓그로스 응답에는 수취인이 없어
 * 한 줄은 고객 정보가 있고 한 줄은 비는 이상한 모양이 된다.
 *
 * 그래서 새로 만들지 않고 기존 row 에 표시만 남긴다 — 수취인·상태를 지키기 위해서다.
 */
async function markRocketGrowth(pairs) {
  if (!USE_SUPABASE || !pairs.length) return { marked: 0 };
  let marked = 0;
  for (let i = 0; i < pairs.length; i += 8) {
    await Promise.all(pairs.slice(i, i + 8).map(async ({ orderId, vendorItemId }) => {
      const q = `coupang_order_id=eq.${encodeURIComponent(orderId)}`
        + `&vendor_item_id=eq.${encodeURIComponent(vendorItemId)}`;
      const res = await fetch(`${REST_BASE}/coupang_orders?${q}`, {
        method: 'PATCH',
        headers: { ...HEADERS, Prefer: 'return=minimal' },
        body: JSON.stringify({ is_rocket_growth: true }),
      });
      if (res.ok) marked++;
      else console.warn(`[coupang store] 로켓그로스 표시 실패 ${orderId}/${vendorItemId}: ${res.status}`);
    }));
  }
  return { marked };
}

/**
 * 품목 단위 상태 갱신 — (주문ID, 옵션ID) 한 쌍만 바꾼다.
 *   updateCoupangOrderStatus 는 주문의 모든 행을 함께 바꾼다. 한 주문에서 한 옵션만
 *   취소된 경우 그걸 쓰면 멀쩡한 옵션까지 취소로 죽는다.
 */
async function updateCoupangItemStatus(items) {
  if (!USE_SUPABASE || !items.length) return { updated: 0 };
  let updated = 0;
  for (let i = 0; i < items.length; i += 8) {
    await Promise.all(items.slice(i, i + 8).map(async ({ orderId, vendorItemId, status, statusLabel }) => {
      const q = `coupang_order_id=eq.${encodeURIComponent(orderId)}`
        + `&vendor_item_id=eq.${encodeURIComponent(vendorItemId)}`;
      const res = await fetch(`${REST_BASE}/coupang_orders?${q}`, {
        method: 'PATCH',
        headers: { ...HEADERS, Prefer: 'return=minimal' },
        body: JSON.stringify({ status, status_label: statusLabel, synced_at: new Date().toISOString() }),
      });
      if (res.ok) updated++;
      else console.warn(`[coupang store] 상태 갱신 실패 ${orderId}/${vendorItemId}: ${res.status}`);
    }));
  }
  return { updated };
}

/**
 * 앞선 버전이 만든 로켓그로스 쌍둥이 행 삭제.
 *   shipment_box_id=0 은 로켓그로스 수집이 붙인 자리표시자다. 같은 (주문, 옵션) 에
 *   실제 박스ID 를 가진 마켓플레이스 행이 따로 있으면 그쪽이 원본이고 이건 중복이다.
 *   조건을 셋 다 걸어 마켓플레이스 행을 지울 여지를 없앤다.
 */
async function deleteRocketGrowthTwins(pairs) {
  if (!USE_SUPABASE || !pairs.length) return { deleted: 0 };
  let deleted = 0;
  for (let i = 0; i < pairs.length; i += 8) {
    await Promise.all(pairs.slice(i, i + 8).map(async ({ orderId, vendorItemId }) => {
      const q = `coupang_order_id=eq.${encodeURIComponent(orderId)}`
        + `&vendor_item_id=eq.${encodeURIComponent(vendorItemId)}`
        + `&shipment_box_id=eq.0&is_rocket_growth=is.true`;
      const res = await fetch(`${REST_BASE}/coupang_orders?${q}`, {
        method: 'DELETE',
        headers: { ...HEADERS, Prefer: 'return=representation' },
      });
      if (!res.ok) {
        console.warn(`[coupang store] 쌍둥이 삭제 실패 ${orderId}/${vendorItemId}: ${res.status}`);
        return;
      }
      const rows = await res.json().catch(() => []);
      deleted += Array.isArray(rows) ? rows.length : 0;
    }));
  }
  return { deleted };
}

/**
 * 쿠팡 주문용 stub customer_info 일괄 upsert — 정보입력현황 자동 입력완료 처리용.
 *   order_id 'CP-{coupang_order_id}' 로 bg_order_customer_info 에 빈 row 생성.
 *   이미 있으면 skip (processed_at 등 사용자 설정 상태 보존).
 *   → 수집처리 버튼 / 처리완료 추적이 기존 ci 로직 그대로 작동.
 */
async function upsertCoupangStubCustomerInfos(stubs) {
  if (!USE_SUPABASE || !stubs.length) return { upserted: 0 };
  const url = `${REST_BASE}/bg_order_customer_info?on_conflict=order_id`;
  const res = await fetch(url, {
    method: 'POST',
    // ignore-duplicates: 기존 row 가 있으면 skip — processed_at / submitted_at 보존
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
 * 쿠팡 stub 의 enrichment 필드(sticker_selections, desired_ship_date) PATCH.
 *   processed_at / customer_request 등 운영팀 변경 가능 필드는 건드리지 않음.
 *   ignore-duplicates upsert 로 안 채워지는 기존 빈 stub 도 새 enrichment 로 갱신.
 */
async function patchCoupangStubEnrichment(orderId, { sticker_selections, desired_ship_date }) {
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
  updateCoupangOrderStatus,
  upsertCoupangStubCustomerInfos,
  patchCoupangStubEnrichment,
  listCoupangOrders,
  markRocketGrowth,
  deleteRocketGrowthTwins,
  updateCoupangItemStatus,
  getSyncState,
  updateSyncState,
};
