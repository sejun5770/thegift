import { NextRequest, NextResponse } from 'next/server';
import {
  collectDaeryepumOrders,
  previewDaeryepumCount,
  getCollectionHistory,
} from '@/lib/barunson/collection-service';

/**
 * GET /api/collect/barunson
 * 수집 이력 조회 또는 미리보기
 *
 * Query params:
 *   ?action=preview  → 수집 대상 건수만 조회
 *   ?action=history  → 수집 이력 조회 (기본값)
 *   ?since_date=2026-03-01  → 기준 날짜 (선택)
 */
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const action = searchParams.get('action') || 'history';
  const sinceDateStr = searchParams.get('since_date');

  try {
    if (action === 'preview') {
      const sinceDate = sinceDateStr ? new Date(sinceDateStr) : undefined;
      const result = await previewDaeryepumCount(sinceDate);

      return NextResponse.json({
        action: 'preview',
        ...result,
      });
    }

    // 수집 이력
    const history = await getCollectionHistory();
    return NextResponse.json({
      action: 'history',
      runs: history,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { error: message },
      { status: 500 }
    );
  }
}

/**
 * POST /api/collect/barunson
 * 답례품 주문 수집 실행
 *
 * Body (optional):
 *   { "since_date": "2026-03-01" }
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
          return NextResponse.json(
            { error: 'Invalid since_date format' },
            { status: 400 }
          );
        }
      }
    }

    const summary = await collectDaeryepumOrders(sinceDate);

    return NextResponse.json({
      success: true,
      summary,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Collect Barunson] Error:', message);

    return NextResponse.json(
      { error: message },
      { status: 500 }
    );
  }
}
