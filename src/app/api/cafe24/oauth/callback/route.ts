import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireAdmin } from '@/lib/auth/admin';
import { exchangeAuthCode } from '@/lib/cafe24/auth';

/**
 * GET /api/cafe24/oauth/callback?code=...
 *   카페24 앱 설치 후 리다이렉트되는 최초 인증 엔드포인트.
 *   관리자 세션 뒤에서만 동작 (설치 관리자가 로그인 상태로 진행).
 *   인증코드(code) → access/refresh 토큰 교환 후 cafe24_tokens 저장.
 *
 *   Redirect URI 는 개발자센터 앱 설정과 정확히 일치해야 함.
 *   기본: {origin}/api/cafe24/oauth/callback (env CAFE24_REDIRECT_URI 로 고정 권장).
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const guard = await requireAdmin(supabase);
  if (guard.error) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }

  const code = request.nextUrl.searchParams.get('code');
  if (!code) {
    return NextResponse.json({ error: 'code 파라미터 없음 (앱 설치/인증 재시도)' }, { status: 400 });
  }

  const redirectUri =
    process.env.CAFE24_REDIRECT_URI || `${request.nextUrl.origin}/api/cafe24/oauth/callback`;

  try {
    await exchangeAuthCode(code, redirectUri);
    return NextResponse.json({
      success: true,
      message: '카페24 연동 완료 — 토큰이 저장되었습니다. 이제 수집 크론이 동작합니다.',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Cafe24 OAuth] Error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
