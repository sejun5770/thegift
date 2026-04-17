import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { sendAlimtalkForOrder } from '@/lib/alimtalk';
import { requireAdmin } from '@/lib/auth/admin';

function isMockMode() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  return !supabaseUrl || supabaseUrl.includes('your_supabase');
}

const bodySchema = z.object({
  order_ids: z.array(z.string().min(1)).min(1).max(500),
});

/**
 * POST /api/alimtalk/send
 * 답례품 주문 알림톡 일괄 발송 (관리자 전용)
 */
export async function POST(request: NextRequest) {
  let parsedBody: z.infer<typeof bodySchema>;
  try {
    const body = await request.json();
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: '입력 데이터가 올바르지 않습니다.', details: parsed.error.issues },
        { status: 400 }
      );
    }
    parsedBody = parsed.data;
  } catch {
    return NextResponse.json(
      { error: 'JSON 바디를 파싱할 수 없습니다.' },
      { status: 400 }
    );
  }

  if (isMockMode()) {
    return NextResponse.json({
      mock: true,
      results: parsedBody.order_ids.map((id) => ({
        order_id: id,
        success: true,
        mock: true,
        message_id: `mock_${Date.now()}_${id}`,
      })),
      summary: {
        total: parsedBody.order_ids.length,
        sent: parsedBody.order_ids.length,
        failed: 0,
        skipped: 0,
      },
    });
  }

  try {
    const { createClient } = await import('@/lib/supabase/server');
    const supabase = await createClient();

    const auth = await requireAdmin(supabase);
    if (auth.error) {
      return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const results = [];
    for (const orderId of parsedBody.order_ids) {
      const res = await sendAlimtalkForOrder(supabase, orderId);
      results.push(res);
    }

    const summary = {
      total: results.length,
      sent: results.filter((r) => r.success).length,
      failed: results.filter((r) => !r.success && !r.skipped_reason).length,
      skipped: results.filter((r) => !!r.skipped_reason).length,
    };

    return NextResponse.json({ results, summary });
  } catch (e) {
    console.error('[Alimtalk] bulk send error:', e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : '서버 오류가 발생했습니다.' },
      { status: 500 }
    );
  }
}
