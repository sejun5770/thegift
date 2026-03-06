import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { VALID_STATUS_TRANSITIONS } from '@/lib/constants';
import type { OrderStatus } from '@/types/enums';

export async function PATCH(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { orderIds, newStatus, reason } = await request.json();

    if (!orderIds || !Array.isArray(orderIds) || orderIds.length === 0) {
      return NextResponse.json(
        { error: '주문을 선택해주세요.' },
        { status: 400 }
      );
    }

    // 각 주문의 현재 상태 조회
    const { data: orders, error: fetchError } = await supabase
      .from('orders')
      .select('id, status')
      .in('id', orderIds);

    if (fetchError) {
      return NextResponse.json({ error: fetchError.message }, { status: 500 });
    }

    const results: { id: string; success: boolean; error?: string }[] = [];
    const now = new Date().toISOString();

    for (const order of orders || []) {
      const currentStatus = order.status as OrderStatus;
      const validTransitions = VALID_STATUS_TRANSITIONS[currentStatus] || [];

      if (!validTransitions.includes(newStatus as OrderStatus)) {
        results.push({
          id: order.id,
          success: false,
          error: `${currentStatus}에서 ${newStatus}(으)로 변경 불가`,
        });
        continue;
      }

      const updateData: Record<string, unknown> = { status: newStatus };

      switch (newStatus) {
        case 'draft_completed':
          updateData.draft_completed_at = now;
          break;
        case 'print_ready':
          updateData.print_ready_at = now;
          break;
        case 'print_completed':
          updateData.print_completed_at = now;
          break;
        case 'binding_completed':
          updateData.binding_completed_at = now;
          break;
        case 'shipping_completed':
          updateData.shipping_completed_at = now;
          break;
        case 'validation_failed':
          updateData.validation_failed_at = now;
          updateData.validation_failed_reason = reason || null;
          break;
      }

      const { error: updateError } = await supabase
        .from('orders')
        .update(updateData)
        .eq('id', order.id);

      if (updateError) {
        results.push({ id: order.id, success: false, error: updateError.message });
      } else {
        results.push({ id: order.id, success: true });

        // 이력 기록
        await supabase.from('order_history').insert({
          order_id: order.id,
          action: 'status_change',
          field_name: 'status',
          old_value: currentStatus,
          new_value: newStatus,
          description: `일괄 상태 변경: ${currentStatus} → ${newStatus}`,
        });
      }
    }

    const successCount = results.filter((r) => r.success).length;
    const failCount = results.filter((r) => !r.success).length;

    return NextResponse.json({
      results,
      summary: { total: results.length, success: successCount, failed: failCount },
    });
  } catch {
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
