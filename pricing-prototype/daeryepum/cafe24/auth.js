/**
 * 카페24 OAuth 토큰 관리 — src/lib/cafe24/auth.ts 포팅.
 *   @supabase/supabase-js 대신 server.js 의 fetch 기반 Supabase 접근 사용.
 *
 * cafe24_tokens 테이블(038 마이그레이션)은 service_role 전용 (anon/authenticated 차단).
 *   → 반드시 SUPABASE_SERVICE_ROLE_KEY 로 접근. 미설정 시 명확한 에러.
 *
 * 환경변수:
 *   CAFE24_MALL_ID       — 몰 아이디 (기본 'barunn01')
 *   CAFE24_CLIENT_ID     — 앱 Client ID
 *   CAFE24_CLIENT_SECRET — 앱 Client Secret
 *   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — cafe24_tokens read/upsert
 */
'use strict';

const MALL = process.env.CAFE24_MALL_ID || 'barunn01';
const OAUTH_BASE = `https://${MALL}.cafe24api.com/api/v2`;

const SUPABASE_URL = process.env.SUPABASE_URL || '';
// cafe24_tokens 는 service_role 전용 → service key 필수 (anon 로는 RLS 차단)
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const REST_BASE = `${SUPABASE_URL}/rest/v1`;
const SERVICE_HEADERS = {
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  'Content-Type': 'application/json',
};

function assertSupabase() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error('Cafe24 토큰 저장소 미설정 — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 필요 (cafe24_tokens 는 service_role 전용)');
  }
}

/** OAuth 토큰 엔드포인트 호출 (Basic Auth = ClientID:Secret) */
async function tokenRequest(params) {
  const id = process.env.CAFE24_CLIENT_ID;
  const secret = process.env.CAFE24_CLIENT_SECRET;
  if (!id || !secret) throw new Error('CAFE24_CLIENT_ID / CAFE24_CLIENT_SECRET 환경변수 없음');

  const basic = Buffer.from(`${id}:${secret}`).toString('base64');
  const res = await fetch(`${OAUTH_BASE}/oauth/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params),
  });
  if (!res.ok) {
    throw new Error(`Cafe24 token error ${res.status}: ${(await res.text()).slice(0, 500)}`);
  }
  return res.json();
}

/**
 * 카페24 만료시각 정규화 — 카페24는 expires_at 을 KST(타임존 없이)로 준다.
 *   타임존이 없으면 +09:00(KST)로 간주해 정확한 UTC ISO 로 변환.
 *   (미변환 시 UTC 로 저장돼 실제보다 9시간 늦게 기록 → 죽은 토큰을 유효로 오판 → 401)
 */
function normalizeCafeExpiry(s) {
  if (!s) return null;
  let str = String(s).trim();
  if (!str) return null;
  if (str.includes(' ') && !str.includes('T')) str = str.replace(' ', 'T');
  const hasTz = /([+-]\d{2}:?\d{2}|Z)$/i.test(str);
  if (!hasTz) str = str + '+09:00';
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * 토큰을 cafe24_tokens(단일 행, id=1)에 저장.
 *   refresh_token 은 갱신 시마다 새 값 → 반드시 덮어씀 (merge-duplicates upsert).
 */
async function saveTokens(t) {
  assertSupabase();
  const url = `${REST_BASE}/cafe24_tokens?on_conflict=id`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...SERVICE_HEADERS, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({
      id: 1,
      mall_id: MALL,
      access_token: t.access_token,
      refresh_token: t.refresh_token,
      access_expires_at: normalizeCafeExpiry(t.expires_at),
      refresh_expires_at: normalizeCafeExpiry(t.refresh_token_expires_at),
      updated_at: new Date().toISOString(),
    }),
  });
  if (!res.ok) {
    throw new Error(`Cafe24 토큰 저장 실패 [${res.status}]: ${(await res.text()).slice(0, 300)}`);
  }
}

/** 최초 1회: 앱 설치 인증코드(code) → 토큰 교환 후 저장 */
async function exchangeAuthCode(code, redirectUri) {
  const t = await tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  });
  await saveTokens(t);
  return { ok: true, mall_id: MALL, access_expires_at: t.expires_at, refresh_expires_at: t.refresh_token_expires_at };
}

/** 저장된 토큰 행 조회. */
async function loadStored() {
  assertSupabase();
  const res = await fetch(`${REST_BASE}/cafe24_tokens?id=eq.1&select=*&limit=1`, {
    headers: SERVICE_HEADERS,
  });
  if (!res.ok) {
    throw new Error(`Cafe24 토큰 조회 실패 [${res.status}]: ${(await res.text()).slice(0, 300)}`);
  }
  const rows = await res.json();
  const data = Array.isArray(rows) ? rows[0] : null;
  if (!data) {
    throw new Error('Cafe24 토큰 없음 — 앱 설치/인증(OAuth) 필요');
  }
  return data;
}

/** refresh_token 으로 강제 갱신 → 새 access_token 반환 (401 대응/만료 임박 공용). */
async function forceRefresh() {
  const data = await loadStored();
  const t = await tokenRequest({
    grant_type: 'refresh_token',
    refresh_token: data.refresh_token,
  });
  await saveTokens(t);
  return t.access_token;
}

/** 유효한 access_token 반환 (만료 5분 전이면 refresh 로 자동 갱신) */
async function getAccessToken() {
  const data = await loadStored();
  const soon = Date.now() + 5 * 60 * 1000; // 5분 여유
  const exp = new Date(data.access_expires_at).getTime();
  if (Number.isFinite(exp) && exp > soon) {
    return data.access_token;
  }
  // 만료(임박) → 갱신
  const t = await tokenRequest({
    grant_type: 'refresh_token',
    refresh_token: data.refresh_token,
  });
  await saveTokens(t);
  return t.access_token;
}

module.exports = {
  exchangeAuthCode,
  getAccessToken,
  forceRefresh,
  MALL,
};
