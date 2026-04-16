import { NextResponse } from 'next/server';

function isMockMode() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  return !supabaseUrl || supabaseUrl.includes('your_supabase');
}

/** GET /c/barungift/api/orders - 관리자용 주문 목록 (바른기프트 대상) */
export async function GET() {
  if (isMockMode()) {
    return NextResponse.json({
      orders: [
        {
          order_id: 'test-order-1',
          order_number: 'BRS-20260001',
          customer_name: '홍*동',
          order_date: '2026-04-10',
          info_status: 'pending',
          product_name: '프리미엄 답례떡 세트',
        },
      ],
      total: 1,
    });
  }

  try {
    const { createClient } = await import('@/lib/supabase/server');
    const supabase = await createClient();

    const { data: orders, error } = await supabase
      .from('orders')
      .select(`
        id, order_number, recipient_name, collected_at, order_amount, status,
        order_items (product_name, product_code)
      `)
      .eq('is_deleted', false)
      .order('collected_at', { ascending: false })
      .limit(100);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // 고객 정보 입력 상태 조회
    const orderNumbers = (orders || []).map((o: { order_number: string }) => o.order_number);
    const { data: customerInfos } = await supabase
      .from('bg_order_customer_info')
      .select('order_id, submitted_at')
      .in('order_id', orderNumbers);

    const infoMap = new Map(
      (customerInfos || []).map((i: { order_id: string; submitted_at: string }) => [i.order_id, i.submitted_at])
    );

    const result = (orders || []).map((o: Record<string, unknown>) => ({
      order_id: o.order_number,
      order_number: o.order_number,
      customer_name: o.recipient_name,
      order_date: o.collected_at,
      info_status: infoMap.has(o.order_number as string) ? 'completed' : 'pending',
      product_name: (o.order_items as { product_name: string }[])?.[0]?.product_name || '-',
    }));

    return NextResponse.json({ orders: result, total: result.length });
  } catch {
    return NextResponse.json({ error: '서버 오류가 발생했습니다.' }, { status: 500 });
  }
}
