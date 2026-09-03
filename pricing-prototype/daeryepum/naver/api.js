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

// 멀티 스토어 지원 — 3가지 방식 (우선순위 순):
//
// 1) NAVER_STORES (JSON 배열, 최우선)
//    예: [{"id":"1","name":"바른손몰","client_id":"...","client_secret":"...","product_codes":"TGJSD01"}]
//
// 2) NAVER_STORE_IDS suffix 방식 (운영 권장 — Docker Manager env 등록 용이)
//    NAVER_STORE_IDS=1,2          ← 콤마 구분 ID 목록
//    NAVER_CLIENT_ID_1=...
//    NAVER_CLIENT_SECRET_1=...
//    NAVER_PRODUCT_CODES_1=...    ← 선택
//    NAVER_CATEGORY_IDS_1=...     ← 선택
//    NAVER_STORE_NAME_1=...       ← 선택 (라벨)
//    NAVER_CLIENT_ID_2=... (이하 동일)
//
// 3) NAVER_CLIENT_ID/SECRET 단일 env (구버전 호환)
//    NAVER_STORES / NAVER_STORE_IDS 둘 다 미설정 시 store_id='main' 자동 등록.
function parseStores() {
  const raw = process.env.NAVER_STORES || '';
  if (raw.trim()) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length) {
        return arr.map((s, i) => ({
          id: String(s.id || s.store_id || `store${i + 1}`),
          name: String(s.name || s.id || `store${i + 1}`),
          client_id: String(s.client_id || ''),
          client_secret: String(s.client_secret || ''),
          product_codes: String(s.product_codes || ''),
          category_ids: String(s.category_ids || ''),
        })).filter(s => s.client_id && s.client_secret);
      }
    } catch (e) {
      console.error('[naver] NAVER_STORES JSON 파싱 실패 — suffix/단일 폴백:', e.message);
    }
  }

  // Suffix 방식 — NAVER_STORE_IDS=1,2 + NAVER_CLIENT_ID_1, NAVER_CLIENT_SECRET_1, ...
  const idsRaw = process.env.NAVER_STORE_IDS || '';
  if (idsRaw.trim()) {
    const ids = idsRaw.split(',').map(s => s.trim()).filter(Boolean);
    const stores = ids.map(id => ({
      id: String(id),
      name: process.env[`NAVER_STORE_NAME_${id}`] || process.env[`NAVER_NAME_${id}`] || String(id),
      client_id: process.env[`NAVER_CLIENT_ID_${id}`] || '',
      client_secret: process.env[`NAVER_CLIENT_SECRET_${id}`] || '',
      product_codes: process.env[`NAVER_PRODUCT_CODES_${id}`] || '',
      category_ids: process.env[`NAVER_CATEGORY_IDS_${id}`] || '',
    })).filter(s => s.client_id && s.client_secret);
    if (stores.length) return stores;
  }

  // 인덱스 기반 자동 탐지 — NAVER_ID_1, NAVER_NAME_1, NAVER_CLIENT_ID_1, ... 패턴.
  //   NAVER_STORE_IDS 없이도 작동. NAVER_ID_<n> 의 값이 store_id 가 됨.
  //   NAVER_ID_<n> 비워두면 인덱스 n 그대로 store_id 사용 (1, 2, ...).
  //   최대 20개까지 자동 탐색.
  {
    const indexedStores = [];
    for (let i = 1; i <= 20; i++) {
      const clientId = process.env[`NAVER_CLIENT_ID_${i}`] || '';
      const clientSecret = process.env[`NAVER_CLIENT_SECRET_${i}`] || '';
      if (!clientId || !clientSecret) continue;
      const storeId = process.env[`NAVER_ID_${i}`] || String(i);
      indexedStores.push({
        id: String(storeId),
        name: process.env[`NAVER_NAME_${i}`] || process.env[`NAVER_STORE_NAME_${i}`] || String(storeId),
        client_id: clientId,
        client_secret: clientSecret,
        product_codes: process.env[`NAVER_PRODUCT_CODES_${i}`] || '',
        category_ids: process.env[`NAVER_CATEGORY_IDS_${i}`] || '',
      });
    }
    if (indexedStores.length) return indexedStores;
  }

  // 단일 env 폴백 (NAVER_CLIENT_ID / NAVER_CLIENT_SECRET)
  const cid = process.env.NAVER_CLIENT_ID || '';
  const csec = process.env.NAVER_CLIENT_SECRET || '';
  if (cid && csec) {
    return [{
      id: 'main',
      name: process.env.NAVER_STORE_NAME || 'main',
      client_id: cid,
      client_secret: csec,
      product_codes: process.env.NAVER_PRODUCT_CODES || '',
      category_ids: process.env.NAVER_CATEGORY_IDS || '',
    }];
  }
  return [];
}

const STORES = parseStores();
const STORE_BY_ID = new Map(STORES.map(s => [s.id, s]));

function getStores() { return STORES; }
function getStore(id) { return STORE_BY_ID.get(id) || null; }

function isConfigured() {
  return STORES.length > 0;
}

// 토큰 캐시 — store_id 별 Map
const _tokenCacheByStore = new Map(); // store_id → { token, expiresAt }

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

async function getAccessToken(store) {
  if (!store) throw new Error('getAccessToken: store 인자 필요');
  const cached = _tokenCacheByStore.get(store.id);
  if (cached && cached.token && cached.expiresAt > Date.now()) {
    return cached.token;
  }
  const clientId = store.client_id;
  const clientSecret = store.client_secret;
  if (!clientId || !clientSecret) {
    throw new Error(`Naver API 키 미설정 (store=${store.id}).`);
  }

  const timestamp = Date.now();
  let signature;
  try {
    signature = signClientSecret(clientId, timestamp, clientSecret);
  } catch (e) {
    throw new Error(`Naver 서명 실패 store=${store.id} (client_secret 형식 확인): ${e.message}. secret 첫 4자: ${clientSecret.slice(0, 4)}... 길이: ${clientSecret.length}`);
  }

  const form = new URLSearchParams();
  form.append('client_id', clientId);
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
    throw new Error(`Naver token store=${store.id} [${res.status}]: ${text.slice(0, 500)}`);
  }
  if (!data.access_token) {
    throw new Error(`Naver token store=${store.id}: access_token 없음 - ${text.slice(0, 300)}`);
  }
  // expires_in 보통 10800초 (3시간) — 5분 buffer
  const ttlSec = (data.expires_in || 10800) - 300;
  _tokenCacheByStore.set(store.id, {
    token: data.access_token,
    expiresAt: Date.now() + Math.max(ttlSec, 60) * 1000,
  });
  return data.access_token;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * 네이버 API 공통 호출.
 *   path: '/external/v1/...' (host 제외)
 *   body: object — 자동 JSON 직렬화
 *
 *   429 (GW.RATE_LIMIT) 자동 재시도 — 기본 2회까지, 1.5s/3s backoff.
 *   Retry-After 헤더가 있으면 우선 사용.
 */
async function callNaver(store, method, path, body = null, { maxRetries = 2, baseBackoffMs = 1500 } = {}) {
  if (!store) throw new Error('callNaver: store 인자 필요');

  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const token = await getAccessToken(store);
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
    if (res.ok) return data;

    const err = new Error(`Naver API ${method} ${path} [${res.status}]: ${text.slice(0, 500)}`);
    err.status = res.status;
    err.body = data;

    // 429 RATE_LIMIT — 재시도
    if (res.status === 429 && attempt < maxRetries) {
      const retryAfterSec = parseFloat(res.headers.get('retry-after') || '0');
      const waitMs = retryAfterSec > 0
        ? Math.min(retryAfterSec * 1000, 10000)
        : baseBackoffMs * (attempt + 1);
      console.warn(`[naver] 429 RATE_LIMIT ${path} — ${waitMs}ms 후 재시도 (attempt ${attempt + 1}/${maxRetries})`);
      await sleep(waitMs);
      continue;
    }
    lastErr = err;
    break;
  }
  throw lastErr;
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
async function listChangedStatuses(store, { fromMs, toMs, lastChangedType } = {}) {
  const params = new URLSearchParams();
  params.set('lastChangedFrom', fmtKstIso(fromMs));
  if (toMs) params.set('lastChangedTo', fmtKstIso(toMs));
  if (lastChangedType) params.set('lastChangedType', lastChangedType);
  return callNaver(store, 'GET', `/external/v1/pay-order/seller/product-orders/last-changed-statuses?${params.toString()}`);
}

/**
 * productOrderId 리스트로 상세 일괄 조회 — query endpoint.
 *   네이버 spec 상 한 번에 최대 N개 (보통 300).
 */
async function queryProductOrders(store, productOrderIds) {
  if (!Array.isArray(productOrderIds) || !productOrderIds.length) return { data: [] };
  return callNaver(store, 'POST', '/external/v1/pay-order/seller/product-orders/query', {
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
async function listProductOrdersDirect(store, { startMs, endMs, page = 1, size = 100 } = {}) {
  const params = new URLSearchParams();
  // 후보 1: fromDate / toDate (KST yyyy-MM-dd)
  // 후보 2: orderDateFrom / orderDateTo
  // 일단 둘 다 시도하기 어려우니 가장 흔한 from/to 사용 — 실패하면 변경
  params.set('from', fmtKstIso(startMs));
  params.set('to', fmtKstIso(endMs));
  params.set('page', String(page));
  params.set('size', String(size));
  return callNaver(store, 'GET', `/external/v1/pay-order/seller/product-orders?${params.toString()}`);
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

/**
 * 통합: 기간 내 모든 주문 조회. 24h 단위 chunk 로 분할 (네이버 API 윈도우 제한 대응).
 *   각 chunk 마다 direct list 시도 → 비면 last-changed-statuses + query 폴백.
 *
 *   반환:
 *     items, totalCount, chunks, sources[], idsFromChanged, diagnostics
 */
/**
 * 통합: 기간 내 모든 주문 조회. 24h 단위 chunk 로 분할.
 *
 * Rate limit 대응:
 *   - chunk 간 250ms delay (호출 burst 방지)
 *   - 각 callNaver 내부에서 429 시 1.5s/3s backoff 자동 재시도
 *
 * 빈 결과 처리:
 *   - direct 가 성공(throw 안 함)하면 빈 결과라도 fallback 호출 안 함
 *     (해당 24h 에 주문이 없는 것이 확정 → changed 호출도 어차피 0건)
 *   - direct 가 실패(throw — 보통 5xx/429 재시도 실패)했을 때만 changed 폴백
 */
async function listAllOrders(store, { startMs, endMs } = {}) {
  const CHUNK_MS = 24 * 3600 * 1000;
  const INTER_CHUNK_DELAY_MS = 250;
  const allItems = [];
  const seenIds = new Set();
  const sources = [];
  const diagnostics = [];
  let chunks = 0;
  let idsFromChanged = 0;

  let isFirstChunk = true;
  for (let from = startMs; from < endMs; from += CHUNK_MS) {
    if (!isFirstChunk) await sleep(INTER_CHUNK_DELAY_MS);
    isFirstChunk = false;

    const to = Math.min(from + CHUNK_MS, endMs);
    chunks++;
    const diag = { chunk: chunks, from_kst: fmtKstIso(from), to_kst: fmtKstIso(to) };

    // 방식 A — direct list 시도. 성공시 (빈 결과 포함) fallback 안 함.
    let directSucceeded = false;
    try {
      const res = await listProductOrdersDirect(store, { startMs: from, endMs: to });
      const raw = res.data?.contents || res.data?.productOrders || res.data || [];
      const items = Array.isArray(raw) ? raw.map(flattenItem) : [];
      for (const it of items) {
        const pid = String(it.productOrderId || it.productOrder?.productOrderId || '');
        if (pid && !seenIds.has(pid)) {
          seenIds.add(pid);
          allItems.push(it);
        }
      }
      diag.direct = { count: items.length };
      if (items.length) sources.push('direct');
      directSucceeded = true; // ← 빈 결과여도 성공 = fallback 불필요
    } catch (e) {
      diag.direct = { error: e.message, status: e.status };
    }

    // 방식 B — direct 가 실패한 경우만 last-changed-statuses 폴백
    if (!directSucceeded) {
      try {
        const res = await listChangedStatuses(store, { fromMs: from, toMs: to });
        const arr = res.data?.lastChangeStatuses || res.data || [];
        const chunkIds = [];
        for (const row of (Array.isArray(arr) ? arr : [])) {
          if (row && row.productOrderId) {
            const pid = String(row.productOrderId);
            if (!seenIds.has(pid)) chunkIds.push(pid);
          }
        }
        idsFromChanged += chunkIds.length;
        diag.changed = { count: chunkIds.length };
        if (chunkIds.length) {
          try {
            const detailRes = await queryProductOrders(store, chunkIds);
            const detailArr = Array.isArray(detailRes.data) ? detailRes.data : [];
            const items = detailArr.map(flattenItem);
            for (const it of items) {
              const pid = String(it.productOrderId || it.productOrder?.productOrderId || '');
              if (pid && !seenIds.has(pid)) {
                seenIds.add(pid);
                allItems.push(it);
              }
            }
            diag.query = { count: items.length };
            sources.push('last-changed-fallback');
          } catch (e) {
            diag.query = { error: e.message };
          }
        }
      } catch (e) {
        diag.changed = { error: e.message };
      }
    }

    diagnostics.push(diag);
  }

  return {
    items: allItems,
    totalCount: allItems.length,
    chunks,
    idsFetched: idsFromChanged,
    sources: [...new Set(sources)],
    diagnostics,
  };
}

module.exports = {
  isConfigured,
  getStores,
  getStore,
  getAccessToken,
  callNaver,
  signClientSecret,
  fmtKstIso,
  listChangedStatuses,
  queryProductOrders,
  listProductOrdersDirect,
  listAllOrders,
};
