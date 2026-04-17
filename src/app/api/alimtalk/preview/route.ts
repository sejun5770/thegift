import { NextRequest, NextResponse } from 'next/server';
import {
  buildMessagePayload,
  buildSamplePayload,
  getTemplateConfig,
  TEMPLATE_VARIABLES,
} from '@/lib/alimtalk';

function isMockMode() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  return !supabaseUrl || supabaseUrl.includes('your_supabase');
}

/**
 * GET /api/alimtalk/preview
 * 알림톡 메시지 미리보기
 *
 * Query:
 *  - order_id: 실제 주문 데이터로 렌더링 (선택)
 *  - 없으면 샘플 데이터로 렌더링
 *
 * Response:
 *  - text: 치환된 메시지 본문
 *  - button: 버튼 정보
 *  - variables: 사용된 변수 값
 *  - template: 원본 템플릿 + 변수 정의
 */
export async function GET(request: NextRequest) {
  const orderId = request.nextUrl.searchParams.get('order_id');

  const config = getTemplateConfig();

  if (!orderId || isMockMode()) {
    const payload = buildSamplePayload();
    return NextResponse.json({
      ...payload,
      template: {
        body: config.body,
        templateCode: config.templateCode,
        variables: TEMPLATE_VARIABLES,
      },
      sample: !orderId,
    });
  }

  try {
    const { createClient } = await import('@/lib/supabase/server');
    const supabase = await createClient();

    const { data, error } = await supabase
      .from('orders')
      .select(
        `
        id,
        order_number,
        recipient_name,
        recipient_phone,
        order_items ( product_code, product_name, sort_order )
      `
      )
      .eq('id', orderId)
      .eq('is_deleted', false)
      .maybeSingle();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    if (!data) {
      return NextResponse.json(
        { error: '주문을 찾을 수 없습니다.' },
        { status: 404 }
      );
    }

    const order = data as {
      id: string;
      order_number: string | null;
      recipient_name: string | null;
      recipient_phone: string | null;
      order_items: Array<{
        product_code: string | null;
        product_name: string | null;
        sort_order: number | null;
      }> | null;
    };

    const item = order.order_items?.[0];

    const payload = buildMessagePayload({
      orderId: order.id,
      orderNumber: order.order_number,
      customerName: order.recipient_name,
      productName: item?.product_name ?? null,
    });

    return NextResponse.json({
      ...payload,
      recipient_phone: order.recipient_phone,
      template: {
        body: config.body,
        templateCode: config.templateCode,
        variables: TEMPLATE_VARIABLES,
      },
      sample: false,
    });
  } catch (e) {
    console.error('[Alimtalk] preview error:', e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : '서버 오류' },
      { status: 500 }
    );
  }
}
