import { NextRequest, NextResponse } from 'next/server';
import { validateOrderItems, isMultiProduct, isCheckRequired } from '@/lib/services/validation-service';
import { MOCK_ORDERS } from '@/lib/mock-data';
import type { OrderItem } from '@/types/order';

function isMockMode() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  return !supabaseUrl || supabaseUrl.includes('your_supabase');
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ orderId: string }> }
) {
  const { orderId } = await params;

  if (isMockMode()) {
    const order = MOCK_ORDERS.find((o) => o.id === orderId);
    if (!order) {
      return NextResponse.json({ error: '주문을 찾을 수 없습니다.' }, { status: 404 });
    }
    const orderItems = (order.order_items || []) as unknown as OrderItem[];
    const result = validateOrderItems(orderItems);
    return NextResponse.json({
      isValid: result.isValid,
      failures: result.failures,
    });
  }

  try {
    const { createClient } = await import('@/lib/supabase/server');
    const supabase = await createClient();

    const { data: items, error: itemsError } = await supabase
      .from('order_items')
      .select('*')
      .eq('order_id', orderId);

    if (itemsError) {
      return NextResponse.json({ error: itemsError.message }, { status: 500 });
    }

    const orderItems = (items || []) as OrderItem[];
    const result = validateOrderItems(orderItems);

    if (!result.isValid) {
      const reasons = result.failures.map((f) => f.message).join('\n');

      await supabase
        .from('orders')
        .update({
          status: 'validation_failed',
          validation_failed_at: new Date().toISOString(),
          validation_failed_reason: reasons,
        })
        .eq('id', orderId);

      await supabase.from('order_history').insert({
        order_id: orderId,
        action: 'validation_failed',
        description: `자동 검증 실패: ${reasons}`,
      });
    }

    if (isMultiProduct(orderItems)) {
      await supabase.from('order_highlights').upsert(
        { order_id: orderId, highlight_type: 'multi_product', is_auto: true },
        { onConflict: 'order_id,highlight_type' }
      );
    } else {
      await supabase
        .from('order_highlights')
        .delete()
        .eq('order_id', orderId)
        .eq('highlight_type', 'multi_product')
        .eq('is_auto', true);
    }

    if (isCheckRequired(orderItems)) {
      await supabase.from('order_highlights').upsert(
        { order_id: orderId, highlight_type: 'check_required', is_auto: true },
        { onConflict: 'order_id,highlight_type' }
      );
    } else {
      await supabase
        .from('order_highlights')
        .delete()
        .eq('order_id', orderId)
        .eq('highlight_type', 'check_required')
        .eq('is_auto', true);
    }

    return NextResponse.json({
      isValid: result.isValid,
      failures: result.failures,
    });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
