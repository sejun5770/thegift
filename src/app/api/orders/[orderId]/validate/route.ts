import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { validateOrderItems, isMultiProduct, isCheckRequired } from '@/lib/services/validation-service';
import type { OrderItem } from '@/types/order';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ orderId: string }> }
) {
  const { orderId } = await params;

  try {
    const supabase = await createClient();

    // 주문 상품 조회
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
      // 검증실패 처리
      const reasons = result.failures.map((f) => f.message).join('\n');

      await supabase
        .from('orders')
        .update({
          status: 'validation_failed',
          validation_failed_at: new Date().toISOString(),
          validation_failed_reason: reasons,
        })
        .eq('id', orderId);

      // 이력 기록
      await supabase.from('order_history').insert({
        order_id: orderId,
        action: 'validation_failed',
        description: `자동 검증 실패: ${reasons}`,
      });
    }

    // 하이라이트 업데이트
    // 복수상품
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

    // 점검필요
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
