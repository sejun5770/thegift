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

/**
 * 주문 목록 조회 (timeFrame 기준) — 최대 7일 윈도우.
 *   startMs / endMs: Date.now() 같은 epoch ms (또는 Date 객체)
 *   options:
 *     status: 'ACCEPT' | 'INSTRUCT' | 'DEPARTURE' | 'DELIVERING' | 'FINAL_DELIVERY' | 'NONE_TRACKING' | 'CANCEL' (옵션)
 *     maxPerPage: default 50 (max 50)
 *     searchType: 'timeFrame'
 *     nextToken: 페이지네이션
 *
 * 응답 핵심 필드 (orderSheet):
 *   - orderId, shipmentBoxId, orderedAt, paidAt
 *   - status (ACCEPT/INSTRUCT/DEPARTURE/DELIVERING/FINAL_DELIVERY/CANCEL...)
 *   - receiver: { name, receiverNumber, addr1, addr2, postCode }
 *   - orderItems[]: { sellerProductId, sellerProductName, vendorItemId, vendorItemName,
 *                     vendorItemPackageId, shippingCount, salesPrice, displayCategoryCode, ... }
 *   - parcelPrintMessage (배송메모)
 *   - paymentMethod (결제수단 코드)
 */
async function listOrders({ startMs, endMs, status, maxPerPage = 50, nextToken } = {}) {
  const fmt = ms => {
    const d = typeof ms === 'number' ? new Date(ms) : ms;
    // 쿠팡은 KST 기준 ISO-like 'YYYY-MM-DDTHH:mm:ss' 받음 (timezone 표기 없음)
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };
  const params = new URLSearchParams();
  params.set('createdAtFrom', fmt(startMs));
  params.set('createdAtTo', fmt(endMs));
  params.set('maxPerPage', String(maxPerPage));
  if (status) params.set('status', status);
  if (nextToken) params.set('nextToken', nextToken);
  const path = `/v2/providers/openapi/apis/api/v4/vendors/${VENDOR_ID}/ordersheets`;
  return callCoupang('GET', path, params.toString());
}

/**
 * 페이지네이션 자동 처리 — 모든 페이지 합쳐 반환.
 *   결과: { items: [...], pages: N, totalCount: N }
 */
async function listAllOrders({ startMs, endMs, status } = {}) {
  let items = [];
  let nextToken = null;
  let pages = 0;
  while (true) {
    const res = await listOrders({ startMs, endMs, status, nextToken });
    pages++;
    if (Array.isArray(res.data)) items = items.concat(res.data);
    nextToken = res.nextToken || null;
    if (!nextToken || pages >= 50) break; // 안전장치 50페이지
  }
  return { items, pages, totalCount: items.length };
}

module.exports = {
  isConfigured,
  buildAuthHeader,
  buildDatetime,
  callCoupang,
  listOrders,
  listAllOrders,
  VENDOR_ID, // for log/debug only
};
