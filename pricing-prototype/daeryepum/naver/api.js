/**
 * 네이버 스마트스토어 (커머스 API) 클라이언트
 *
 * 환경변수:
 *   NAVER_CLIENT_ID         — 커머스 API 애플리케이션 등록 시 발급
 *   NAVER_CLIENT_SECRET     — 발급된 secret
 *   NAVER_API_HOST          — 기본 'https://api.commerce.naver.com'
 *
 * 인증: OAuth 2.0 (client_credentials)
 *   1) bcrypt 서명 생성: hash("{client_id}_{timestamp}", client_secret)
 *   2) POST /external/v1/oauth2/token 으로 access_token 발급 (~3시간 유효)
 *   3) Authorization: Bearer {access_token} 으로 API 호출
 *
 * 토큰은 모듈 메모리에 캐시 (만료 5분 전 갱신).
 */
'use strict';

const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const HOST = process.env.NAVER_API_HOST || 'https://api.commerce.naver.com';
const CLIENT_ID = process.env.NAVER_CLIENT_ID || '';
const CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET || '';

function isConfigured() {
  return !!(CLIENT_ID && CLIENT_SECRET);
}

// 토큰 캐시 — 모듈 메모리
let _tokenCache = { token: null, expiresAt: 0 };

/**
 * OAuth access_token 발급 (또는 캐시 재사용).
 *   네이버 bcrypt 서명: hash("{client_id}_{timestamp}", client_secret) → base64
 */
/**
 * 네이버 client_secret_sign 생성 — 두 가지 방식 지원.
 *
 *   방식 A (bcrypt, 구버전): secret 이 '$2a$10$...' 형식인 경우.
 *     BCrypt.hashpw(client_id + '_' + timestamp, client_secret) → base64
 *
 *   방식 B (HMAC-SHA256, 신버전): secret 이 16자 URL-safe base64 (__KE...) 인 경우.
 *     HMAC-SHA256(client_secret, client_id + '_' + timestamp) → base64
 *
 *   secret 의 형식으로 자동 분기.
 */
/** Java Base64.getUrlEncoder() 와 동일 — URL-safe + padding 유지. */
function b64UrlWithPadding(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  // padding '=' 그대로 유지 (Java 기본 getUrlEncoder() 와 일관)
}

function signClientSecret(clientId, timestamp, secret) {
  const message = `${clientId}_${timestamp}`;
  // 방식 A — bcrypt 풀 형식 (네이버 spec)
  //   네이버 Java 샘플: Base64.getUrlEncoder().encodeToString(hashed.getBytes("UTF-8"))
  //   → URL-safe base64, padding 포함 ('=' 유지).
  if (/^\$2[abxy]\$/.test(secret)) {
    const hashed = bcrypt.hashSync(message, secret);
    return b64UrlWithPadding(Buffer.from(hashed, 'utf-8'));
  }
  // 방식 B — HMAC-SHA256 (신버전 추정)
  let key;
  try {
    key = Buffer.from(secret, 'base64url');
    if (!key.length) throw new Error('empty');
  } catch {
    key = Buffer.from(secret, 'utf-8');
  }
  const hmac = crypto.createHmac('sha256', key).update(message).digest();
  return b64UrlWithPadding(hmac);
}

async function getAccessToken() {
  if (_tokenCache.token && _tokenCache.expiresAt > Date.now()) {
    return _tokenCache.token;
  }
  if (!isConfigured()) throw new Error('Naver API 키 미설정 (NAVER_CLIENT_ID/CLIENT_SECRET).');

  const timestamp = Date.now();
  let signature;
  try {
    signature = signClientSecret(CLIENT_ID, timestamp, CLIENT_SECRET);
  } catch (e) {
    throw new Error(`Naver 서명 실패 (client_secret 형식 확인): ${e.message}. secret 첫 4자: ${CLIENT_SECRET.slice(0, 4)}... 길이: ${CLIENT_SECRET.length}`);
  }

  const form = new URLSearchParams();
  form.append('client_id', CLIENT_ID);
  form.append('timestamp', String(timestamp));
  form.append('client_secret_sign', signature);
  form.append('grant_type', 'client_credentials');
  form.append('type', 'SELF');

  const res = await fetch(`${HOST}/external/v1/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { _raw: text }; }
  if (!res.ok) {
    throw new Error(`Naver token [${res.status}]: ${text.slice(0, 500)}`);
  }
  if (!data.access_token) {
    throw new Error(`Naver token: access_token 없음 - ${text.slice(0, 300)}`);
  }
  // expires_in 보통 10800초 (3시간) — 5분 buffer
  const ttlSec = (data.expires_in || 10800) - 300;
  _tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + Math.max(ttlSec, 60) * 1000,
  };
  return _tokenCache.token;
}

/**
 * 네이버 API 공통 호출.
 *   path: '/external/v1/...' (host 제외)
 *   body: object — 자동 JSON 직렬화
 */
async function callNaver(method, path, body = null) {
  if (!isConfigured()) throw new Error('Naver API 키 미설정.');
  const token = await getAccessToken();
  const opts = {
    method: method.toUpperCase(),
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
  };
  if (body && opts.method !== 'GET') {
    opts.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const res = await fetch(HOST + path, opts);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { _raw: text }; }
  if (!res.ok) {
    const err = new Error(`Naver API ${method} ${path} [${res.status}]: ${text.slice(0, 500)}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

/**
 * KST 'YYYY-MM-DDTHH:mm:ss.SSS+09:00' 포맷 — 네이버 시간 입력용.
 *   Docker 컨테이너는 UTC 가정 — 명시적으로 KST 변환.
 */
function fmtKstIso(ms) {
  const d = typeof ms === 'number' ? new Date(ms) : ms;
  const kst = new Date(d.getTime() + 9 * 3600 * 1000);
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  return `${kst.getUTCFullYear()}-${pad(kst.getUTCMonth() + 1)}-${pad(kst.getUTCDate())}`
    + `T${pad(kst.getUTCHours())}:${pad(kst.getUTCMinutes())}:${pad(kst.getUTCSeconds())}`
    + `.${pad(kst.getUTCMilliseconds(), 3)}+09:00`;
}

/**
 * 변경된 주문 목록 — last-changed-statuses endpoint.
 *   ⚠️ 네이버 spec: lastChangedFrom 만 주면 자동으로 +24h 윈도우. 더 넓게는 lastChangedTo 명시 필요.
 *   ⚠️ 최대 윈도우 24h. 더 긴 기간은 24h chunk 반복 (listAllOrders 참고).
 */
async function listChangedStatuses({ fromMs, toMs, lastChangedType } = {}) {
  const params = new URLSearchParams();
  params.set('lastChangedFrom', fmtKstIso(fromMs));
  if (toMs) params.set('lastChangedTo', fmtKstIso(toMs));
  if (lastChangedType) params.set('lastChangedType', lastChangedType);
  return callNaver('GET', `/external/v1/pay-order/seller/product-orders/last-changed-statuses?${params.toString()}`);
}

/**
 * productOrderId 리스트로 상세 일괄 조회 — query endpoint.
 *   네이버 spec 상 한 번에 최대 N개 (보통 300).
 */
async function queryProductOrders(productOrderIds) {
  if (!Array.isArray(productOrderIds) || !productOrderIds.length) return { data: [] };
  return callNaver('POST', '/external/v1/pay-order/seller/product-orders/query', {
    productOrderIds,
  });
}

/**
 * 직접 주문 목록 조회 — 쿠팡 /ordersheets 와 같은 역할.
 *   네이버 spec: GET /external/v1/pay-order/seller/product-orders
 *   기간 + 페이지네이션 + 필터 등 지원 추정.
 *
 *   params (확인 필요):
 *     fromDate / toDate or createdAtFrom / createdAtTo (date)
 *     page / size
 *     productOrderStatuses
 */
async function listProductOrdersDirect({ startMs, endMs, page = 1, size = 100 } = {}) {
  const params = new URLSearchParams();
  // 후보 1: fromDate / toDate (KST yyyy-MM-dd)
  // 후보 2: orderDateFrom / orderDateTo
  // 일단 둘 다 시도하기 어려우니 가장 흔한 from/to 사용 — 실패하면 변경
  params.set('from', fmtKstIso(startMs));
  params.set('to', fmtKstIso(endMs));
  params.set('page', String(page));
  params.set('size', String(size));
  return callNaver('GET', `/external/v1/pay-order/seller/product-orders?${params.toString()}`);
}

/**
 * 통합: 기간 내 모든 주문 조회.
 *   방식 A (preferred): /product-orders 직접 리스트 (쿠팡 패턴)
 *   방식 B (fallback):  last-changed-statuses + query (이벤트 스트림 패턴, 24h chunk)
 */
/**
 * 네이버 응답 item 평면화 — direct/query 모두 한 단계 래핑되어 있음.
 *   direct: data.contents[i] = { productOrderId, content: { order, productOrder } }
 *   query:  data[i]          = { productOrderId, content: { order, productOrder } } (추정 동일)
 *
 *   → { order, productOrder } 형태로 변환 (sync.js normalizeOrder 인풋).
 */
function flattenItem(it) {
  if (it && it.content && (it.content.order || it.content.productOrder)) {
    return { ...it.content, productOrderId: it.productOrderId };
  }
  return it;
}

async function listAllOrders({ startMs, endMs } = {}) {
  // 방식 A 먼저 시도
  try {
    const res = await listProductOrdersDirect({ startMs, endMs });
    const raw = res.data?.contents || res.data?.productOrders || res.data || [];
    if (Array.isArray(raw)) {
      const items = raw.map(flattenItem);
      return { items, pages: 1, totalCount: items.length, source: 'direct' };
    }
  } catch (e) {
    console.warn(`[naver listAllOrders] direct list 실패, last-changed-statuses 폴백: ${e.message}`);
  }

  // 방식 B 폴백 — last-changed-statuses 24h chunk
  const CHUNK_MS = 24 * 3600 * 1000;
  const idSet = new Set();
  let chunks = 0;
  for (let from = startMs; from < endMs; from += CHUNK_MS) {
    const to = Math.min(from + CHUNK_MS, endMs);
    chunks++;
    try {
      const res = await listChangedStatuses({ fromMs: from, toMs: to });
      const arr = res.data?.lastChangeStatuses || res.data || [];
      for (const row of (Array.isArray(arr) ? arr : [])) {
        if (row && row.productOrderId) idSet.add(String(row.productOrderId));
      }
    } catch (e) {
      console.warn(`[naver listAllOrders] chunk ${new Date(from).toISOString()} 실패: ${e.message}`);
    }
  }
  const ids = [...idSet];
  if (!ids.length) return { items: [], pages: chunks, totalCount: 0, idsFetched: 0, chunks, source: 'last-changed-fallback' };

  let details;
  try {
    const detailRes = await queryProductOrders(ids);
    const arr = Array.isArray(detailRes.data) ? detailRes.data : [];
    details = arr.map(flattenItem);
  } catch (e) {
    console.warn(`[naver listAllOrders] detail query 실패: ${e.message}`);
    details = [];
  }

  return { items: details, pages: chunks, totalCount: details.length, idsFetched: ids.length, chunks, source: 'last-changed-fallback' };
}

module.exports = {
  isConfigured,
  getAccessToken,
  callNaver,
  signClientSecret,
  fmtKstIso,
  listChangedStatuses,
  queryProductOrders,
  listProductOrdersDirect,
  listAllOrders,
  CLIENT_ID, // for log/debug only
};
