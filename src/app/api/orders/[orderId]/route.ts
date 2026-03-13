import { NextRequest, NextResponse } from 'next/server';
import { MOCK_ORDERS, MOCK_ORDER_HISTORY } from '@/lib/mock-data';

function isMockMode() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  return !supabaseUrl || supabaseUrl.includes('your_supabase');
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orderId: string }> }
) {
  const { orderId } = await params;

  if (isMockMode()) {
    const order = MOCK_ORDERS.find((o) => o.id === orderId);
    if (!order) {
      return NextResponse.json({ error: '주문을 찾을 수 없습니다.' }, { status: 404 });
    }
    const history = MOCK_ORDER_HISTORY.filter((h) => h.order_id === orderId);
    return NextResponse.json({ ...order, history });
  }

  try {
    const { createClient } = await import('@/lib/supabase/server');
    const supabase = await createClient();

    const { data: order, error } = await supabase
      .from('orders')
      .select(`
        *,
        order_items (*),
        order_highlights (id, highlight_type, is_auto, reason, created_at),
        admin_memos (id, memo_text, created_by, created_at),
        order_shipping_addresses (*)
      `)
      .eq('id', orderId)
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }

    const { data: history } = await supabase
      .from('order_history')
      .select('*')
      .eq('order_id', orderId)
      .order('performed_at', { ascending: false });

    return NextResponse.json({
      ...order,
      highlights: (order.order_highlights || []).map(
        (h: { highlight_type: string }) => h.highlight_type
      ),
      history: history || [],
    });
  } catch {
    const order = MOCK_ORDERS.find((o) => o.id === orderId);
    if (order) {
      return NextResponse.json({ ...order, history: [] });
    }
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ orderId: string }> }
) {
  const { orderId } = await params;

  if (isMockMode()) {
    const body = await request.json();
    return NextResponse.json({ id: orderId, ...body, updated_at: new Date().toISOString() });
  }

  try {
    const { createClient } = await import('@/lib/supabase/server');
    const supabase = await createClient();
    const body = await request.json();
    const { field, value, old_value } = body;

    const updateData: Record<string, unknown> = {};
    const allowedFields = [
      'recipient_name', 'recipient_phone', 'recipient_address',
      'recipient_zipcode', 'delivery_message', 'desired_shipping_date',
      'shipping_method', 'is_incident', 'order_amount',
    ];

    if (field && allowedFields.includes(field)) {
      updateData[field] = value;

      if (field === 'desired_shipping_date') {
        await supabase.from('order_highlights').upsert(
          { order_id: orderId, highlight_type: 'schedule_changed', is_auto: true },
          { onConflict: 'order_id,highlight_type' }
        );
      }

      if (field === 'is_incident') {
        if (value) {
          await supabase.from('order_highlights').upsert(
            { order_id: orderId, highlight_type: 'incident', is_auto: false },
            { onConflict: 'order_id,highlight_type' }
          );
        } else {
          await supabase
            .from('order_highlights')
            .delete()
            .eq('order_id', orderId)
            .eq('highlight_type', 'incident');
        }
      }
    } else if (typeof body === 'object' && !field) {
      for (const key of allowedFields) {
        if (key in body) {
          updateData[key] = body[key];
        }
      }
    }

    if (Object.keys(updateData).length === 0) {
      return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });
    }

    const { data, error } = await supabase
      .from('orders')
      .update(updateData)
      .eq('id', orderId)
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    await supabase.from('order_history').insert({
      order_id: orderId,
      action: 'field_updated',
      field_name: field || Object.keys(updateData).join(', '),
      old_value: old_value != null ? String(old_value) : null,
      new_value: value != null ? String(value) : null,
      description: field ? `${field} 변경` : '주문정보 수정',
    });

    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ orderId: string }> }
) {
  const { orderId } = await params;

  if (isMockMode()) {
    return NextResponse.json({ success: true });
  }

  try {
    const { createClient } = await import('@/lib/supabase/server');
    const supabase = await createClient();

    const { data: order } = await supabase
      .from('orders')
      .select('order_source')
      .eq('id', orderId)
      .single();

    if (!order || order.order_source !== 'admin') {
      return NextResponse.json(
        { error: '관리자 주문만 삭제할 수 있습니다.' },
        { status: 403 }
      );
    }

    const { error } = await supabase
      .from('orders')
      .update({ is_deleted: true })
      .eq('id', orderId);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    await supabase.from('order_history').insert({
      order_id: orderId,
      action: 'order_deleted',
      description: '관리자 주문 삭제',
    });

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
