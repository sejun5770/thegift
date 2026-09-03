import { createClient as createSupabaseClient } from '@supabase/supabase-js';

/**
 * Service-role Supabase 클라이언트 — RLS 를 우회한다.
 *
 * cafe24_tokens 처럼 service role 전용(RLS 차단) 테이블 접근에만 사용.
 * ⚠️ 서버 전용. 절대 브라우저/클라이언트 코드로 노출 금지 (service role 키 = 전체 권한).
 */
export function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('Supabase service role 환경변수 없음 (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');
  }
  return createSupabaseClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
