import { NextRequest, NextResponse } from 'next/server';
import {
  collectCafe24Orders,
  previewCafe24Count,
  getCafe24CollectionHistory,
} from '@/lib/cafe24/collection-service';

/**
 * GET /api/collect/cafe24
 *   ?action=preview  → 수집 대상 건수
 *   ?action=history  → 수집 이력 (기본)
 *   ?since_date=YYYY-MM-DD (선택)
 */
export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const action = sp.get('action') || 'history';
  const sinceStr = sp.get('since_date');

  try {
    if (action === 'preview') {
      const since = sinceStr ? new Date(sinceStr) : undefined;
      const result = await previewCafe24Count(since);
      return NextResponse.json({ action: 'preview', ...result });
    }
    const runs = await getCafe24CollectionHistory();
    return NextResponse.json({ action: 'history', runs });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * POST /api/collect/cafe24  — 정수당(카페24) 주문 수집 실행
 *   Body(선택): { "since_date": "YYYY-MM-DD" }
 *   크론(15분 간격) 호출 지점. 멱등(cafe24_order_id 유니크).
 */
export async function POST(request: NextRequest) {
  try {
    let sinceDate: Date | undefined;
    const contentType = request.headers.get('content-type');
    if (contentType?.includes('application/json')) {
      const body = await request.json().catch(() => ({}));
      if (body.since_date) {
        sinceDate = new Date(body.since_date);
        if (isNaN(sinceDate.getTime())) {
          return NextResponse.json({ error: 'Invalid since_date format' }, { status: 400 });
        }
      }
    }

    const summary = await collectCafe24Orders(sinceDate);
    return NextResponse.json({ success: true, summary });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Collect Cafe24] Error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
