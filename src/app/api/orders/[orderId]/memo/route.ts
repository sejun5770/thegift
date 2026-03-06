import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ orderId: string }> }
) {
  const { orderId } = await params;

  try {
    const supabase = await createClient();
    const { memo_text } = await request.json();

    if (!memo_text?.trim()) {
      return NextResponse.json({ error: '메모 내용을 입력해주세요.' }, { status: 400 });
    }

    const { data, error } = await supabase
      .from('admin_memos')
      .insert({ order_id: orderId, memo_text: memo_text.trim() })
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // 메모 하이라이트 추가
    await supabase.from('order_highlights').upsert(
      { order_id: orderId, highlight_type: 'admin_memo', is_auto: true },
      { onConflict: 'order_id,highlight_type' }
    );

    // 이력 기록
    await supabase.from('order_history').insert({
      order_id: orderId,
      action: 'memo_added',
      description: `관리자 메모 추가: ${memo_text.trim().substring(0, 50)}`,
    });

    return NextResponse.json(data, { status: 201 });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ orderId: string }> }
) {
  const { orderId } = await params;

  try {
    const supabase = await createClient();
    const { memo_id } = await request.json();

    const { error } = await supabase
      .from('admin_memos')
      .delete()
      .eq('id', memo_id)
      .eq('order_id', orderId);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // 남은 메모가 없으면 하이라이트 제거
    const { count } = await supabase
      .from('admin_memos')
      .select('id', { count: 'exact', head: true })
      .eq('order_id', orderId);

    if (count === 0) {
      await supabase
        .from('order_highlights')
        .delete()
        .eq('order_id', orderId)
        .eq('highlight_type', 'admin_memo');
    }

    // 이력 기록
    await supabase.from('order_history').insert({
      order_id: orderId,
      action: 'memo_deleted',
      description: '관리자 메모 삭제',
    });

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
