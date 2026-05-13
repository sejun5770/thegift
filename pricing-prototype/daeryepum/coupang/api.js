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
 */
async function listAllOrders({ startMs, endMs, statuses } = {}) {
  const list = Array.isArray(statuses) && statuses.length ? statuses : ORDER_STATUSES;
  const seen = new Set(); // `${orderId}::${shipmentBoxId}`
  const items = [];
  let pages = 0;
  const perStatus = {};
  for (const status of list) {
    try {
      const r = await listOrdersForStatus({ startMs, endMs, status });
      pages += r.pages;
      let added = 0;
      for (const sheet of r.items) {
        const k = `${sheet.orderId}::${sheet.shipmentBoxId}`;
        if (seen.has(k)) continue;
        seen.add(k);
        items.push(sheet);
        added++;
      }
      perStatus[status] = added;
    } catch (e) {
      perStatus[status] = `error: ${e.message.slice(0, 100)}`;
    }
  }
  return { items, pages, totalCount: items.length, perStatus };
}

module.exports = {
  isConfigured,
  buildAuthHeader,
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
