import { NextRequest, NextResponse } from 'next/server';
import { MOCK_BG_ORDER_FOR_CUSTOMER } from '@/lib/barungift/mock-data';

function isMockMode() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  return !supabaseUrl || supabaseUrl.includes('your_supabase');
}

/** GET /c/barungift/api/orders/[orderId] - 고객용 주문 상세 조회 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orderId: string }> }
) {
  const { orderId } = await params;

  if (isMockMode()) {
    if (orderId === 'test-order-1' || orderId === 'BRS-20260001') {
      return NextResponse.json(MOCK_BG_ORDER_FOR_CUSTOMER);
    }
    return NextResponse.json(
      { error: '주문을 찾을 수 없습니다.' },
      { status: 404 }
    );
  }

  try {
    const { getOrderForCustomer } = await import('@/lib/barungift/db');
    const order = await getOrderForCustomer(orderId);

    if (!order) {
      return NextResponse.json(
        { error: '주문을 찾을 수 없습니다.' },
        { status: 404 }
      );
    }

    // 취소된 주문
    if (order.status === 'cancelled') {
      return NextResponse.json(
        { error: '취소된 주문입니다.' },
        { status: 410 }
      );
    }

    return NextResponse.json(order);
  } catch {
    return NextResponse.json(
      { error: '서버 오류가 발생했습니다.' },
      { status: 500 }
    );
  }
}
