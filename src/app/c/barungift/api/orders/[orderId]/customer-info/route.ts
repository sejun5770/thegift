import { NextRequest, NextResponse } from 'next/server';
import { MOCK_BG_SUBMITTED_INFO } from '@/lib/barungift/mock-data';

function isMockMode() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  return !supabaseUrl || supabaseUrl.includes('your_supabase');
}

/** POST /c/barungift/api/orders/[orderId]/customer-info - 고객 입력 정보 저장 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ orderId: string }> }
) {
  const { orderId } = await params;

  if (isMockMode()) {
    const body = await request.json();
    return NextResponse.json(
      {
        ...MOCK_BG_SUBMITTED_INFO,
        order_id: orderId,
        ...body,
        submitted_at: new Date().toISOString(),
      },
      { status: 201 }
    );
  }

  try {
    const { customerInfoSubmitSchema } = await import('@/lib/barungift/validations');
    const { getOrderForCustomer, saveOrderCustomerInfo } = await import('@/lib/barungift/db');

    // 주문 존재 여부 및 상태 확인
    const order = await getOrderForCustomer(orderId);
    if (!order) {
      return NextResponse.json(
        { error: '주문을 찾을 수 없습니다.' },
        { status: 404 }
      );
    }

    if (order.status === 'cancelled') {
      return NextResponse.json(
        { error: '취소된 주문입니다.' },
        { status: 410 }
      );
    }

    if (order.info_status === 'completed') {
      return NextResponse.json(
        { error: '이미 정보 입력이 완료된 주문입니다.' },
        { status: 409 }
      );
    }

    // 요청 바디 검증
    const body = await request.json();
    const parsed = customerInfoSubmitSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: '입력 데이터가 올바르지 않습니다.', details: parsed.error.issues },
        { status: 400 }
      );
    }

    // 저장
    const saved = await saveOrderCustomerInfo(orderId, parsed.data);

    return NextResponse.json(saved, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : '서버 오류가 발생했습니다.';

    if (message === 'ALREADY_SUBMITTED') {
      return NextResponse.json(
        { error: '이미 정보 입력이 완료된 주문입니다.' },
        { status: 409 }
      );
    }

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
