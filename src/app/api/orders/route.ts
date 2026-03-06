import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const tab = searchParams.get('tab') || 'all';
  const page = parseInt(searchParams.get('page') || '1');
  const limit = parseInt(searchParams.get('limit') || '50');
  const search = searchParams.get('search') || '';
  const sortBy = searchParams.get('sort_by') || 'collected_at';
  const sortOrder = searchParams.get('sort_order') || 'desc';
  const dateType = searchParams.get('date_type');
  const startDate = searchParams.get('start_date');
  const endDate = searchParams.get('end_date');

  try {
    const supabase = await createClient();
    const offset = (page - 1) * limit;

    let query = supabase
      .from('orders')
      .select(`
        *,
        order_items (*),
        order_highlights (highlight_type),
        admin_memos (id, memo_text, created_at)
      `, { count: 'exact' })
      .eq('is_deleted', false);

    // 탭별 상태 필터
    if (tab !== 'all') {
      query = query.eq('status', tab);
    }

    // 검색
    if (search) {
      query = query.or(`order_number.ilike.%${search}%,recipient_name.ilike.%${search}%`);
    }

    // 기간 필터
    if (dateType && startDate && endDate) {
      if (dateType === 'desired_shipping_date') {
        query = query
          .gte('desired_shipping_date', startDate)
          .lte('desired_shipping_date', endDate);
      } else {
        query = query
          .gte('collected_at', `${startDate}T00:00:00`)
          .lte('collected_at', `${endDate}T23:59:59`);
      }
    }

    // 정렬
    const ascending = sortOrder === 'asc';
    query = query.order(sortBy, { ascending });

    // 페이지네이션
    query = query.range(offset, offset + limit - 1);

    const { data: orders, error, count } = await query;

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // 하이라이트 목록 추출
    const formattedOrders = (orders || []).map((order) => ({
      ...order,
      highlights: (order.order_highlights || []).map(
        (h: { highlight_type: string }) => h.highlight_type
      ),
      latest_memo:
        order.admin_memos && order.admin_memos.length > 0
          ? order.admin_memos.sort(
              (a: { created_at: string }, b: { created_at: string }) =>
                new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
            )[0].memo_text
          : null,
    }));

    return NextResponse.json({
      orders: formattedOrders,
      total: count || 0,
      page,
      limit,
      totalPages: Math.ceil((count || 0) / limit),
    });
  } catch {
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const body = await request.json();

    const {
      order_number,
      desired_shipping_date,
      recipient_name,
      recipient_phone,
      recipient_address,
      recipient_zipcode,
      delivery_message,
      shipping_method = 'parcel',
      order_amount = 0,
      is_incident = false,
      items = [],
      memo,
    } = body;

    // 주문 생성
    const { data: order, error: orderError } = await supabase
      .from('orders')
      .insert({
        order_number,
        order_source: 'admin',
        status: 'collected',
        shipping_method,
        desired_shipping_date,
        original_desired_shipping_date: desired_shipping_date,
        recipient_name,
        recipient_phone,
        recipient_address,
        recipient_zipcode,
        delivery_message,
        order_amount,
        is_incident,
        total_product_count: items.length,
        total_item_quantity: items.reduce(
          (sum: number, item: { quantity: number }) => sum + (item.quantity || 1),
          0
        ),
      })
      .select()
      .single();

    if (orderError) {
      return NextResponse.json({ error: orderError.message }, { status: 500 });
    }

    // 주문 상품 생성
    if (items.length > 0) {
      const orderItems = items.map(
        (item: Record<string, unknown>, index: number) => ({
          order_id: order.id,
          product_id: item.product_id,
          product_name: item.product_name,
          product_code: item.product_code,
          quantity: item.quantity || 1,
          item_price: item.item_price || 0,
          box_type_id: item.box_type_id,
          box_type_name: item.box_type_name,
          sticker_type1_id: item.sticker_type1_id,
          sticker_type1_name: item.sticker_type1_name,
          sticker_type1_quantity: item.sticker_type1_quantity || 0,
          sticker_type2_id: item.sticker_type2_id,
          sticker_type2_name: item.sticker_type2_name,
          sticker_type2_quantity: item.sticker_type2_quantity || 0,
          sticker_type3_id: item.sticker_type3_id,
          sticker_type3_name: item.sticker_type3_name,
          sticker_type3_quantity: item.sticker_type3_quantity || 0,
          input_message: item.input_message,
          sort_order: index,
        })
      );

      const { error: itemsError } = await supabase
        .from('order_items')
        .insert(orderItems);

      if (itemsError) {
        return NextResponse.json({ error: itemsError.message }, { status: 500 });
      }
    }

    // 사고건 하이라이트
    if (is_incident) {
      await supabase.from('order_highlights').insert({
        order_id: order.id,
        highlight_type: 'incident',
        is_auto: false,
      });
    }

    // 관리자 메모
    if (memo) {
      await supabase.from('admin_memos').insert({
        order_id: order.id,
        memo_text: memo,
      });
      await supabase.from('order_highlights').upsert(
        { order_id: order.id, highlight_type: 'admin_memo', is_auto: true },
        { onConflict: 'order_id,highlight_type' }
      );
    }

    // 이력 기록
    await supabase.from('order_history').insert({
      order_id: order.id,
      action: 'order_created',
      description: '관리자 주문 등록',
    });

    return NextResponse.json(order, { status: 201 });
  } catch {
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
