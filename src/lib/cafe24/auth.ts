import { createServiceClient } from '@/lib/supabase/service';

const MALL = process.env.CAFE24_MALL_ID || 'barunn01';
const OAUTH_BASE = `https://${MALL}.cafe24api.com/api/v2`;

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_at: string;             // access token 만료 (ISO)
  refresh_token_expires_at: string; // refresh token 만료 (ISO, 2주)
  [k: string]: unknown;
}

/** OAuth 토큰 엔드포인트 호출 (Basic Auth = ClientID:Secret) */
async function tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
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
    throw new Error(`Cafe24 token error ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

/** 토큰을 cafe24_tokens(단일 행)에 저장. refresh_token 은 갱신 시마다 새 값 → 반드시 덮어씀. */
async function saveTokens(t: TokenResponse): Promise<void> {
  const supabase = createServiceClient();
  const { error } = await supabase.from('cafe24_tokens').upsert({
    id: 1,
    mall_id: MALL,
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    access_expires_at: t.expires_at,
    refresh_expires_at: t.refresh_token_expires_at,
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(`Cafe24 토큰 저장 실패: ${error.message}`);
}

/** 최초 1회: 앱 설치 인증코드(code) → 토큰 교환 후 저장 */
export async function exchangeAuthCode(code: string, redirectUri: string): Promise<void> {
  const t = await tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  });
  await saveTokens(t);
}

/** 유효한 access_token 반환 (만료 5분 전이면 refresh 로 자동 갱신) */
export async function getAccessToken(): Promise<string> {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from('cafe24_tokens')
    .select('*')
    .eq('id', 1)
    .single();

  if (error || !data) {
    throw new Error('Cafe24 토큰 없음 — 앱 설치/인증(OAuth) 필요');
  }

  const soon = Date.now() + 5 * 60 * 1000; // 5분 여유
  if (new Date(data.access_expires_at).getTime() > soon) {
    return data.access_token;
  }

  // 만료 임박 → 갱신 (refresh_token 도 새 값으로 교체되므로 저장 필수)
  const t = await tokenRequest({
    grant_type: 'refresh_token',
    refresh_token: data.refresh_token,
  });
  await saveTokens(t);
  return t.access_token;
}
