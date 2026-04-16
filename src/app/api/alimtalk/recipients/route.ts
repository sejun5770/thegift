import { NextRequest, NextResponse } from 'next/server';
import { fetchDaeryepumRecipients, type RecipientFilters } from '@/lib/alimtalk';

function isMockMode() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  return !supabaseUrl || supabaseUrl.includes('your_supabase');
}

/**
 * GET /api/alimtalk/recipients
 * 답례품 주문 알림톡 수신 대상자 목록 조회
 *
 * Query:
 *  - start_date, end_date: 희망출고일 기간 (YYYY-MM-DD)
 *  - sent_status: 'sent' | 'unsent' | 'all' (기본 'all')
 *  - search: 주문번호 또는 수신자명
 *  - page, limit
 */
export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;

  const filters: RecipientFilters = {
    startDate: sp.get('start_date') || undefined,
    endDate: sp.get('end_date') || undefined,
    sentStatus: (sp.get('sent_status') as RecipientFilters['sentStatus']) || 'all',
    search: sp.get('search') || undefined,
    page: parseInt(sp.get('page') || '1'),
    limit: parseInt(sp.get('limit') || '50'),
  };

  if (isMockMode()) {
    return NextResponse.json({
      recipients: [],
      total: 0,
      page: filters.page ?? 1,
      limit: filters.limit ?? 50,
      mock: true,
    });
  }

  try {
    const { createClient } = await import('@/lib/supabase/server');
    const supabase = await createClient();

    const { rows, total } = await fetchDaeryepumRecipients(supabase, filters);

    return NextResponse.json({
      recipients: rows,
      total,
      page: filters.page ?? 1,
      limit: filters.limit ?? 50,
    });
  } catch (e) {
    console.error('[Alimtalk] recipients error:', e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : '서버 오류가 발생했습니다.' },
      { status: 500 }
    );
  }
}
