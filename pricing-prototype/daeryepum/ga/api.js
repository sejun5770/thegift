/**
 * Google Analytics 4 Data API 클라이언트 — 서비스 계정 인증.
 *
 * 왜 서비스 계정인가:
 *   쿠팡·네이버·카페24 는 각각 키/앱/OAuth 를 따로 받아야 했지만, GA4 는 서비스 계정 하나에
 *   속성 '뷰어' 권한만 주면 끝난다. 사용자 개입 없이 서버가 계속 조회할 수 있고 재인증이 없다.
 *
 * 의존성 없이 만든 이유:
 *   googleapis 패키지를 넣으면 이미지가 수십 MB 커진다. 필요한 건 RS256 서명 하나뿐이라
 *   Node 기본 crypto 로 JWT 를 직접 만든다 (네이버 서명과 같은 방식).
 *
 * 환경변수:
 *   GA_SERVICE_ACCOUNT_JSON   서비스 계정 키 JSON 원문 또는 base64 (Docker env 는 개행이
 *                             깨지기 쉬워 base64 를 권장한다)
 *   GA_PROPERTIES             'card:412345678,mall:987654321' — 사이트키:속성ID
 *                             (사이트키는 주문사이트 필터와 같은 말을 쓴다: card / etc)
 */
'use strict';

const crypto = require('crypto');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';
const DATA_HOST = 'https://analyticsdata.googleapis.com';

/** 키 JSON 파싱 — 원문/base64 둘 다 받는다 */
function parseServiceAccount() {
  const raw = (process.env.GA_SERVICE_ACCOUNT_JSON || '').trim();
  if (!raw) return null;
  let text = raw;
  if (!text.startsWith('{')) {
    try { text = Buffer.from(raw, 'base64').toString('utf8'); } catch { return null; }
  }
  try {
    const j = JSON.parse(text);
    if (!j.client_email || !j.private_key) return null;
    // env 를 거치며 개행이 '\n' 문자열로 남는 경우가 흔하다
    j.private_key = String(j.private_key).replace(/\\n/g, '\n');
    return j;
  } catch { return null; }
}

/** 'card:412345678,mall:987654321' → { card: '412345678', ... } */
function parseProperties() {
  const out = {};
  for (const part of String(process.env.GA_PROPERTIES || '').split(',')) {
    const m = /^\s*([A-Za-z0-9_-]+)\s*:\s*(\d+)\s*$/.exec(part);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const SA = parseServiceAccount();
const PROPERTIES = parseProperties();

function isConfigured() {
  return !!SA && Object.keys(PROPERTIES).length > 0;
}

/** 설정 진단 — 무엇이 빠졌는지 화면에서 바로 보이게 */
function configStatus() {
  return {
    service_account: SA ? SA.client_email : null,
    service_account_ok: !!SA,
    properties: PROPERTIES,
    properties_ok: Object.keys(PROPERTIES).length > 0,
    hint: SA ? null
      : (process.env.GA_SERVICE_ACCOUNT_JSON
        ? 'GA_SERVICE_ACCOUNT_JSON 을 읽었지만 client_email/private_key 를 찾지 못했습니다 (base64 인코딩 권장)'
        : 'GA_SERVICE_ACCOUNT_JSON 미설정'),
  };
}

const b64url = (buf) => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

let _token = null;   // { value, exp }

/** 액세스 토큰 — 만료 1분 전까지 재사용 */
async function getAccessToken() {
  if (!SA) throw new Error('GA 서비스 계정이 설정되지 않았습니다 (GA_SERVICE_ACCOUNT_JSON)');
  if (_token && Date.now() < _token.exp - 60000) return _token.value;

  const iat = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: SA.client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat,
    exp: iat + 3600,
  }));
  const signature = b64url(
    crypto.createSign('RSA-SHA256').update(`${header}.${claim}`).sign(SA.private_key));

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claim}.${signature}`,
    }).toString(),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GA 토큰 발급 실패 [${res.status}]: ${text.slice(0, 300)}`);
  const j = JSON.parse(text);
  _token = { value: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
  return _token.value;
}

/** 사이트키 → 속성ID. 모르는 키면 던진다 (조용히 다른 사이트를 조회하면 안 된다) */
function propertyOf(site) {
  const id = PROPERTIES[site];
  if (!id) throw new Error(`GA 속성이 설정되지 않은 사이트입니다: ${site} (GA_PROPERTIES 확인)`);
  return id;
}

/** runReport 호출 — body 는 GA4 Data API 스펙 그대로 */
async function runReport(site, body) {
  const token = await getAccessToken();
  const propertyId = propertyOf(site);
  const res = await fetch(`${DATA_HOST}/v1beta/properties/${propertyId}:runReport`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`GA runReport [${res.status}] ${site}: ${text.slice(0, 400)}`);
    err.status = res.status;
    try { err.body = JSON.parse(text); } catch { /* 원문만 남긴다 */ }
    throw err;
  }
  return JSON.parse(text);
}

/** 속성 메타데이터 — 어떤 지표/차원을 쓸 수 있는지 (진단용) */
async function getMetadata(site) {
  const token = await getAccessToken();
  const propertyId = propertyOf(site);
  const res = await fetch(`${DATA_HOST}/v1beta/properties/${propertyId}/metadata`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GA metadata [${res.status}] ${site}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

/** runReport 응답 → [{dimension이름: 값, metric이름: 숫자}] 로 편평하게 */
function flatten(res) {
  const dims = (res.dimensionHeaders || []).map(h => h.name);
  const mets = (res.metricHeaders || []).map(h => h.name);
  return (res.rows || []).map(r => {
    const o = {};
    dims.forEach((n, i) => { o[n] = r.dimensionValues?.[i]?.value ?? null; });
    mets.forEach((n, i) => { o[n] = Number(r.metricValues?.[i]?.value ?? 0) || 0; });
    return o;
  });
}

module.exports = {
  isConfigured, configStatus, getAccessToken, runReport, getMetadata, flatten,
  propertyOf, PROPERTIES, SITE_KEYS: Object.keys(PROPERTIES),
};
