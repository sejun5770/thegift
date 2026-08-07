/**
 * 쿠팡 Wing OPEN API 클라이언트
 *
 * 환경변수:
 *   COUPANG_VENDOR_ID    — A 로 시작하는 vendor id (예: A12345678)
 *   COUPANG_ACCESS_KEY   — OPEN API 키 발급 시 부여
 *   COUPANG_SECRET_KEY   — OPEN API 키 발급 시 부여
 *   COUPANG_API_HOST     — 기본 'https://api-gateway.coupang.com' (변경 거의 없음)
 *
 * 인증: HMAC-SHA256
 *   datetime: YYMMDDTHHMMSSZ (UTC)
 *   message: datetime + method + path + query
 *   signature: hex(hmac_sha256(SECRET, message))
 *   Authorization: CEA algorithm=HmacSHA256, access-key={KEY}, signed-date={datetime}, signature={sig}
 *
 * 답례품 카테고리 필터: 상품 노출카테고리 = '돌잔치답례품 > 기타답례품'.
 *   API 응답의 sellerProductId / displayCategoryCode 활용.
 */
'use strict';
const crypto = require('crypto');

const HOST = process.env.COUPANG_API_HOST || 'https://api-gateway.coupang.com';
const VENDOR_ID = process.env.COUPANG_VENDOR_ID || '';
const ACCESS_KEY = process.env.COUPANG_ACCESS_KEY || '';
const SECRET_KEY = process.env.COUPANG_SECRET_KEY || '';

function isConfigured() {
  return !!(VENDOR_ID && ACCESS_KEY && SECRET_KEY);
}

/**
 * 쿠팡 인증 datetime — UTC, 'YYMMDDTHHMMSSZ' 포맷 (마지막 Z, 2자리 연도).
 *   예: 2026-05-13 14:30:00 UTC → '260513T143000Z'
 */
function buildDatetime(now = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  const yy = String(now.getUTCFullYear()).slice(-2);
  const mm = pad(now.getUTCMonth() + 1);
  const dd = pad(now.getUTCDate());
  const HH = pad(now.getUTCHours());
  const MM = pad(now.getUTCMinutes());
  const SS = pad(now.getUTCSeconds());
  return `${yy}${mm}${dd}T${HH}${MM}${SS}Z`;
}

/**
 * 쿠팡 HMAC 서명 생성 — Authorization 헤더 전체 반환.
 *   message = datetime + method + path + query
 */
function buildAuthHeader(method, path, query, datetime) {
  const dt = datetime || buildDatetime();
  const message = dt + method.toUpperCase() + path + (query || '');
  const signature = crypto.createHmac('sha256', SECRET_KEY).update(message).digest('hex');
  return `CEA algorithm=HmacSHA256, access-key=${ACCESS_KEY}, signed-date=${dt}, signature=${signature}`;
}

/**
 * 쿠팡 API 호출 — 인증/path-query/JSON 파싱 일괄 처리.
 *   path: '/v2/providers/openapi/...' (host 제외, 쿼리 제외)
 *   query: 'key1=val1&key2=val2' (앞 ? 없음, 없으면 빈 문자열)
 */
async function callCoupang(method, path, query = '', body = null) {
  if (!isConfigured()) {
    throw new Error('Coupang API 키가 설정되지 않았습니다. 환경변수 COUPANG_VENDOR_ID/ACCESS_KEY/SECRET_KEY 확인 필요.');
  }
  const url = HOST + path + (query ? '?' + query : '');
  const auth = buildAuthHeader(method, path, query);
  const opts = {
    method: method.toUpperCase(),
    headers: {
      Authorization: auth,
      'Content-Type': 'application/json;charset=UTF-8',
      'X-EXTENDED-Timeout': '90000',
    },
  };
  if (body) opts.body = typeof body === 'string' ? body : JSON.stringify(body);
  const res = await fetch(url, opts);
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { parsed = { _raw: text }; }
  if (!res.ok) {
    const err = new Error(`Coupang API ${method} ${path} [${res.status}]: ${text.slice(0, 500)}`);
    err.status = res.status;
    err.body = parsed;
    throw err;
  }
  return parsed;
}

/** 쿠팡 주요 주문 상태 (ordersheets endpoint 에서 status 는 필수 — 전체 합집합용) */
const ORDER_STATUSES = [
  'ACCEPT',          // 결제완료
  'INSTRUCT',        // 상품준비중
  'DEPARTURE',       // 배송지시
  'DELIVERING',      // 배송중
  'FINAL_DELIVERY',  // 배송완료
  'NONE_TRACKING',   // 배송중(추적불가) — 일부 운송사 자동추적 미지원 케이스
  // CANCEL/RETURNS 는 매출 집계 의도에서 제외
];

/**
 * 주문 목록 조회 — /ordersheets endpoint.
 *   ⚠️ Coupang spec: createdAtFrom/createdAtTo/status 모두 필수.
 *   startMs / endMs: epoch ms (또는 Date)
 *   status: 단일 상태 (ORDER_STATUSES 중 하나) — 필수
 *   maxPerPage: default 50 (max 50)
 *   nextToken: 페이지네이션
 *
 * 응답 핵심 필드 (orderSheet):
 *   - orderId, shipmentBoxId, orderedAt, paidAt
 *   - status, receiver{ name, receiverNumber, addr1, addr2, postCode }
 *   - orderItems[]: { sellerProductId, sellerProductName, vendorItemId, vendorItemName,
 *                     vendorItemPackageId, shippingCount, salesPrice, displayCategoryCode, ... }
 *   - parcelPrintMessage (배송메모), paymentMethod (결제수단 코드)
 */
/**
 * epoch ms → KST 기준 'YYYY-MM-DD' (날짜만, /ordersheets endpoint 가 요구하는 포맷).
 *   timeFrame 변형 endpoint 는 datetime 가능하지만 기본 endpoint 는 yyyy-MM-dd 한정.
 *   Docker 컨테이너는 일반적으로 UTC 라 명시적으로 KST(UTC+9) 로 변환.
 */
function fmtKstDate(ms) {
  const d = typeof ms === 'number' ? new Date(ms) : ms;
  const kst = new Date(d.getTime() + 9 * 3600 * 1000);
  const pad = n => String(n).padStart(2, '0');
  return `${kst.getUTCFullYear()}-${pad(kst.getUTCMonth() + 1)}-${pad(kst.getUTCDate())}`;
}

// 호환성: 기존 export 명 유지 (datetime 필요한 경우 별도 함수)
function fmtKstDateTime(ms) {
  const d = typeof ms === 'number' ? new Date(ms) : ms;
  const kst = new Date(d.getTime() + 9 * 3600 * 1000);
  const pad = n => String(n).padStart(2, '0');
  return `${kst.getUTCFullYear()}-${pad(kst.getUTCMonth() + 1)}-${pad(kst.getUTCDate())}T${pad(kst.getUTCHours())}:${pad(kst.getUTCMinutes())}:${pad(kst.getUTCSeconds())}`;
}

async function listOrders({ startMs, endMs, status, maxPerPage = 50, nextToken } = {}) {
  if (!status) throw new Error('listOrders: status 는 필수 (Coupang spec). ORDER_STATUSES 참고.');
  const params = new URLSearchParams();
  // /ordersheets endpoint 는 yyyy-MM-dd 만 허용 (datetime 보내면 400)
  params.set('createdAtFrom', fmtKstDate(startMs));
  params.set('createdAtTo', fmtKstDate(endMs));
  params.set('status', status);
  params.set('maxPerPage', String(maxPerPage));
  if (nextToken) params.set('nextToken', nextToken);
  const path = `/v2/providers/openapi/apis/api/v4/vendors/${VENDOR_ID}/ordersheets`;
  return callCoupang('GET', path, params.toString());
}

/**
 * 단일 status 의 페이지네이션 자동 처리 — 모든 페이지 합쳐 반환.
 */
async function listOrdersForStatus({ startMs, endMs, status, maxPerPage = 50 } = {}) {
  let items = [];
  let nextToken = null;
  let pages = 0;
  while (true) {
    const res = await listOrders({ startMs, endMs, status, maxPerPage, nextToken });
    pages++;
    if (Array.isArray(res.data)) items = items.concat(res.data);
    nextToken = res.nextToken || null;
    if (!nextToken || pages >= 50) break; // 안전장치
  }
  return { items, pages };
}

/**
 * 전 상태 순회 + 페이지네이션 통합 — 같은 (orderId, shipmentBoxId) 는 dedupe.
 *   options.statuses: 순회할 상태 배열 (기본 ORDER_STATUSES). 'CANCEL' 등 추가 가능.
 *   결과: { items: [...dedupe], pages: 총합, perStatus: {status: count} }
 *
 * dedupe 규칙 — '나중 상태가 이긴다' (2026-08-06 수정):
 *   같은 주문이 두 상태로 조회되면 statuses 배열에서 뒤에 있는 쪽을 채택한다.
 *   배열이 주문 생애주기 순(ACCEPT … FINAL_DELIVERY, CANCEL, RETURNS)이라
 *   더 진행된/종료된 상태가 남는다.
 *   이전에는 '먼저 본 것이 이긴다' 라서, 취소된 주문이 ACCEPT 로도 조회되면
 *   CANCEL(배열 마지막)이 버려져 취소가 영영 반영되지 않았다.
 */
async function listAllOrders({ startMs, endMs, statuses } = {}) {
  const list = Array.isArray(statuses) && statuses.length ? statuses : ORDER_STATUSES;
  const idxByKey = new Map(); // `${orderId}::${shipmentBoxId}` → items 내 위치
  const items = [];
  let pages = 0;
  const perStatus = {};
  const overridden = {};   // 어떤 상태가 앞선 상태를 덮었는지 (진단용)
  for (const status of list) {
    try {
      const r = await listOrdersForStatus({ startMs, endMs, status });
      pages += r.pages;
      let added = 0;
      let replaced = 0;
      for (const sheet of r.items) {
        const k = `${sheet.orderId}::${sheet.shipmentBoxId}`;
        if (idxByKey.has(k)) {
          items[idxByKey.get(k)] = sheet;   // 뒤 상태로 교체
          replaced++;
          continue;
        }
        idxByKey.set(k, items.length);
        items.push(sheet);
        added++;
      }
      perStatus[status] = added;
      if (replaced) overridden[status] = replaced;
    } catch (e) {
      perStatus[status] = `error: ${e.message.slice(0, 100)}`;
    }
  }
  return { items, pages, totalCount: items.length, perStatus, overridden };
}

/**
 * 주문 단건 조회 — /{orderId}/ordersheets.
 *   목록 조회(/ordersheets)는 status 필터가 필수라 취소 건이 안 잡히는 경우가 있는데,
 *   이 엔드포인트는 상태와 무관하게 현재 상태를 그대로 돌려준다.
 *   반환: orderSheet 배열 (배송박스 단위)
 */
async function getOrderSheet(orderId) {
  const id = String(orderId || '').trim();
  if (!id) throw new Error('getOrderSheet: orderId 필수');
  const path = `/v2/providers/openapi/apis/api/v4/vendors/${VENDOR_ID}/${id}/ordersheets`;
  const res = await callCoupang('GET', path, '');
  return Array.isArray(res?.data) ? res.data : (res?.data ? [res.data] : []);
}

/**
 * 등록상품 목록 — 옵션ID ↔ 등록상품ID 를 잇기 위해 쓴다.
 *   GET /v2/providers/seller_api/apis/api/v1/marketplace/seller-products
 *   businessTypes='rocketGrowth' 면 로켓그로스 상품만.
 *
 *   응답 data[]: { sellerProductId, sellerProductName,
 *                  items: [{ itemName, marketPlaceItem:{vendorItemId},
 *                            rocketGrowthItem:{vendorItemId} }] }
 */
async function listSellerProducts({ businessTypes, nextToken, maxPerPage = 100 } = {}) {
  const params = new URLSearchParams();
  params.set('vendorId', VENDOR_ID);
  if (businessTypes) params.set('businessTypes', String(businessTypes));
  params.set('maxPerPage', String(Math.min(Math.max(parseInt(maxPerPage, 10) || 100, 1), 100)));
  if (nextToken) params.set('nextToken', String(nextToken));
  const path = '/v2/providers/seller_api/apis/api/v1/marketplace/seller-products';
  return callCoupang('GET', path, params.toString());
}

/** 전체 페이지 순회 (분당 호출 제한 고려해 페이지 사이 대기) */
async function listAllSellerProducts({ businessTypes, maxPages = 100 } = {}) {
  const items = [];
  const seen = new Set();
  let nextToken = null;
  let pages = 0;
  while (pages < maxPages) {
    const res = await listSellerProducts({ businessTypes, nextToken });
    pages++;
    items.push(...pickList(res));
    const t = pickNextToken(res);
    if (!t || seen.has(t)) break;
    seen.add(t); nextToken = t;
    await new Promise(r => setTimeout(r, 1300));
  }
  return { items, pages, truncated: pages >= maxPages };
}

/**
 * 로켓그로스 주문 목록 — 마켓플레이스 주문 API 로는 안 나오는 별도 계열.
 *   GET /v2/providers/rg_open_api/apis/api/v1/vendors/{vendorId}/rg/orders
 *   paidDateFrom / paidDateTo 는 yyyymmdd, 한 번에 최대 30일.
 *   분당 50회 제한.
 *
 *   응답 data[]: { orderId, vendorItemId, productName, salesQuantity,
 *                  unitSalesPrice, currency, paidAt }
 *   주의: 수취인·배송지·주문상태가 없다. 쿠팡이 배송까지 처리하므로 우리 쪽에 안 준다.
 */
async function listRgOrders({ paidDateFrom, paidDateTo, nextToken } = {}) {
  if (!paidDateFrom || !paidDateTo) throw new Error('listRgOrders: paidDateFrom/paidDateTo 필수 (yyyymmdd)');
  const params = new URLSearchParams();
  params.set('paidDateFrom', String(paidDateFrom));
  params.set('paidDateTo', String(paidDateTo));
  if (nextToken) params.set('nextToken', String(nextToken));
  const path = `/v2/providers/rg_open_api/apis/api/v1/vendors/${VENDOR_ID}/rg/orders`;
  return callCoupang('GET', path, params.toString());
}

/**
 * 응답에서 목록을 꺼낸다 — rg_open_api 계열은 data 가 배열일 때도, 한 겹 더 감쌀 때도 있다.
 *   배열이 아닌 모양에서 조용히 0건으로 떨어지면 '주문이 없다' 와 구분이 안 된다.
 */
function pickList(res) {
  if (Array.isArray(res)) return res;
  const d = res?.data;
  if (Array.isArray(d)) return d;
  for (const k of ['content', 'items', 'orders', 'list', 'summaries', 'inventories']) {
    if (Array.isArray(d?.[k])) return d[k];
    if (Array.isArray(res?.[k])) return res[k];
  }
  return [];
}

/** nextToken 도 한 겹 안쪽에 오는 경우가 있다 */
function pickNextToken(res) {
  const t = res?.nextToken ?? res?.data?.nextToken ?? null;
  return t ? String(t) : null;
}

/** 'YYYY-MM-DD' → 'YYYYMMDD' */
function toYmd(d) { return String(d || '').replace(/-/g, '').slice(0, 8); }

/**
 * 기간 전체 조회 — 30일 제한을 넘으면 창을 쪼개 순회한다.
 *   페이지 사이에 잠깐 쉰다 (분당 50회 제한).
 */
async function listAllRgOrders({ startDate, endDate, maxPagesPerWindow = 100 } = {}) {
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  if (isNaN(start) || isNaN(end)) throw new Error('listAllRgOrders: startDate/endDate 는 YYYY-MM-DD');
  const items = [];
  const windows = [];
  for (let cur = start; cur <= end;) {
    const to = new Date(Math.min(cur.getTime() + 29 * 86400000, end.getTime()));
    windows.push([cur.toISOString().slice(0, 10), to.toISOString().slice(0, 10)]);
    cur = new Date(to.getTime() + 86400000);
  }
  let pages = 0;
  for (const [from, to] of windows) {
    let nextToken = null;
    const seen = new Set();
    let p = 0;
    while (p < maxPagesPerWindow) {
      const res = await listRgOrders({ paidDateFrom: toYmd(from), paidDateTo: toYmd(to), nextToken });
      p++; pages++;
      items.push(...pickList(res));
      const t = pickNextToken(res);
      if (!t || seen.has(t)) break;
      seen.add(t); nextToken = t;
      await new Promise(r => setTimeout(r, 1300));
    }
  }
  return { items, pages, windows: windows.length };
}

/**
 * 로켓창고 재고 — 쿠팡 물류센터의 주문가능 수량.
 *   GET /v2/providers/rg_open_api/apis/api/v1/vendors/{vendorId}/rg/inventory/summaries
 *   vendorItemId 를 주면 그 옵션만, 생략하면 전체(페이징).
 *   쿠팡 안내: 분당 50회 이하로 호출할 것.
 *
 *   응답 data[]: { vendorId, vendorItemId, externalSkuId,
 *                  inventoryDetails: { totalOrderableQuantity },
 *                  salesCountMap: { SALES_COUNT_LAST_THIRTY_DAYS } }
 *
 *   주의: 입고수량은 제공되지 않는다. 로켓그로스 API 에 입고 관련 엔드포인트 자체가 없다.
 */
async function listRgInventory({ vendorItemId, nextToken } = {}) {
  const params = new URLSearchParams();
  if (vendorItemId) params.set('vendorItemId', String(vendorItemId));
  if (nextToken) params.set('nextToken', String(nextToken));
  const path = `/v2/providers/rg_open_api/apis/api/v1/vendors/${VENDOR_ID}/rg/inventory/summaries`;
  return callCoupang('GET', path, params.toString());
}

/**
 * 전체 재고 페이지네이션 자동 처리.
 *   분당 50회 제한이 있어 페이지 사이에 잠깐 쉰다 (1.3초 → 분당 약 46회).
 *   nextToken 이 같은 값으로 되돌아오면 멈춘다 — 무한 루프 방지.
 */
async function listAllRgInventory({ maxPages = 100 } = {}) {
  const items = [];
  const seenTokens = new Set();
  let nextToken = null;
  let pages = 0;
  while (pages < maxPages) {
    const res = await listRgInventory({ nextToken });
    pages++;
    items.push(...pickList(res));
    const t = pickNextToken(res);
    if (!t || seenTokens.has(t)) break;
    seenTokens.add(t);
    nextToken = t;
    await new Promise(r => setTimeout(r, 1300));
  }
  return { items, pages, truncated: pages >= maxPages };
}

module.exports = {
  isConfigured,
  pickList,
  listSellerProducts,
  listAllSellerProducts,
  listRgOrders,
  listAllRgOrders,
  listRgInventory,
  listAllRgInventory,
  buildAuthHeader,
  getOrderSheet,
  buildDatetime,
  fmtKstDate,
  fmtKstDateTime,
  callCoupang,
  listOrders,
  listOrdersForStatus,
  listAllOrders,
  ORDER_STATUSES,
  VENDOR_ID, // for log/debug only
};
