import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { VALID_STATUS_TRANSITIONS } from '@/lib/constants';
import type { OrderStatus } from '@/types/enums';

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ orderId: string }> }
) {
  const { orderId } = await params;

  try {
    const supabase = await createClient();
    const { status: newStatus, reason } = await request.json();

    // 현재 상태 조회
    const { data: order, error: fetchError } = await supabase
      .from('orders')
      .select('status')
      .eq('id', orderId)
      .single();

    if (fetchError || !order) {
      return NextResponse.json({ error: '주문을 찾을 수 없습니다.' }, { status: 404 });
    }

    const currentStatus = order.status as OrderStatus;
    const validTransitions = VALID_STATUS_TRANSITIONS[currentStatus] || [];

    if (!validTransitions.includes(newStatus as OrderStatus)) {
      return NextResponse.json(
        {
          error: `${currentStatus}에서 ${newStatus}(으)로 변경할 수 없습니다.`,
        },
        { status: 400 }
      );
    }

    // 상태별 타임스탬프 업데이트
    const updateData: Record<string, unknown> = { status: newStatus };
    const now = new Date().toISOString();

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
      .eq('id', orderId);

    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    }

    // 이력 기록
    await supabase.from('order_history').insert({
      order_id: orderId,
      action: 'status_change',
      field_name: 'status',
      old_value: currentStatus,
      new_value: newStatus,
      description: reason
        ? `상태 변경: ${currentStatus} → ${newStatus} (사유: ${reason})`
        : `상태 변경: ${currentStatus} → ${newStatus}`,
    });

    return NextResponse.json({ success: true, status: newStatus });
  } catch {
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
