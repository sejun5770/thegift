import { NextRequest, NextResponse } from 'next/server';
import { sendAlimtalk, isBiztalkConfigured } from '@/lib/alimtalk';

function buildCustomerUrl(orderId: string): string {
  const base = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, '') || '';
  return `${base}/c/barungift/order-info?oid=${orderId}`;
}

function buildMessageText(params: {
  customerName: string;
  productName: string;
  customerUrl: string;
}): string {
  return (
    `[바른손 답례품]\n` +
    `${params.customerName}님, 답례품 주문이 접수되었습니다.\n\n` +
    `· 상품: ${params.productName}\n\n` +
    `아래 버튼을 눌러 출고 희망일과 스티커 정보를 입력해 주세요.\n` +
    `${params.customerUrl}`
  );
}

/** POST /c/barungift/api/alimtalk/send - 답례품 주문 알림톡 발송 */
export async function POST(request: NextRequest) {
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

    const { order_id, customer_phone, customer_name, product_name } = parsed.data;
    const customerUrl = buildCustomerUrl(order_id);
    const text = buildMessageText({
      customerName: customer_name,
      productName: product_name,
      customerUrl,
    });

    const templateCode = process.env.BIZTALK_TEMPLATE_CODE_ORDER_INFO;
    if (isBiztalkConfigured() && !templateCode) {
      return NextResponse.json(
        {
          error:
            '알림톡 템플릿 코드가 설정되지 않았습니다. BIZTALK_TEMPLATE_CODE_ORDER_INFO 환경변수를 확인하세요.',
        },
        { status: 500 }
      );
    }

    const result = await sendAlimtalk({
      to: customer_phone,
      templateCode: templateCode || 'MOCK_TEMPLATE',
      text,
      buttons: [
        {
          name: '주문정보 입력하기',
          type: 'WL',
          url_mobile: customerUrl,
          url_pc: customerUrl,
        },
      ],
    });

    // order_history에 발송 기록 남기기 (실패해도 발송 결과는 유지)
    try {
      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
      if (supabaseUrl && !supabaseUrl.includes('your_supabase')) {
        const { createClient } = await import('@/lib/supabase/server');
        const supabase = await createClient();
        await supabase.from('order_history').insert({
          order_id,
          action: 'alimtalk_sent',
          description:
            `알림톡 발송: ${customer_phone}` +
            (result.mock ? ' (mock)' : '') +
            (result.messageId ? ` / msgId=${result.messageId}` : ''),
          new_value: customerUrl,
        });
      }
    } catch (e) {
      console.error('[Alimtalk] history 기록 실패:', e);
    }

    if (!result.success) {
      return NextResponse.json(
        {
          error: '알림톡 발송에 실패했습니다.',
          code: result.code,
          message: result.message,
        },
        { status: 502 }
      );
    }

    return NextResponse.json({
      success: true,
      mock: result.mock,
      message: result.mock
        ? '(Mock) 알림톡 발송 요청이 접수되었습니다.'
        : '알림톡 발송이 요청되었습니다.',
      message_id: result.messageId,
      customer_url: customerUrl,
    });
  } catch (e) {
    console.error('[Alimtalk] send error:', e);
    return NextResponse.json({ error: '서버 오류가 발생했습니다.' }, { status: 500 });
  }
}
