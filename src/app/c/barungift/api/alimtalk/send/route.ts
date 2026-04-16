import { NextRequest, NextResponse } from 'next/server';

function isMockMode() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  return !supabaseUrl || supabaseUrl.includes('your_supabase');
}

/** POST /c/barungift/api/alimtalk/send - 알림톡 발송 (플레이스홀더) */
export async function POST(request: NextRequest) {
  if (isMockMode()) {
    const body = await request.json();
    const customerUrl = `/c/barungift/order-info?oid=${body.order_id}`;
    return NextResponse.json({
      success: true,
      message: '(Mock) 알림톡 발송 요청이 접수되었습니다.',
      customer_url: customerUrl,
    });
  }

  try {
    const { alimtalkSendSchema } = await import('@/lib/barungift/validations');

    const body = await request.json();
    const parsed = alimtalkSendSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: '입력 데이터가 올바르지 않습니다.', details: parsed.error.issues },
        { status: 400 }
      );
    }

    const customerUrl = `/c/barungift/order-info?oid=${parsed.data.order_id}`;

    // TODO: 실제 카카오 알림톡 API 연동
    // - 카카오 비즈메시지 API 호출
    // - 템플릿 ID 기반 메시지 발송
    // - 버튼 URL: customerUrl

    // order_history에 발송 기록 남기기
    try {
      const { createClient } = await import('@/lib/supabase/server');
      const supabase = await createClient();

      await supabase.from('order_history').insert({
        order_id: parsed.data.order_id,
        action: 'alimtalk_sent',
        description: `알림톡 발송: ${parsed.data.customer_phone}`,
        new_value: customerUrl,
      });
    } catch {
      // 히스토리 기록 실패는 무시
    }

    return NextResponse.json({
      success: true,
      message: '알림톡 발송이 요청되었습니다.',
      customer_url: customerUrl,
    });
  } catch {
    return NextResponse.json({ error: '서버 오류가 발생했습니다.' }, { status: 500 });
  }
}
