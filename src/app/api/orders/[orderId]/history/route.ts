import { NextRequest, NextResponse } from 'next/server';
import { MOCK_ORDER_HISTORY } from '@/lib/mock-data';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orderId: string }> }
) {
  const { orderId } = await params;

  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    if (!supabaseUrl || supabaseUrl.includes('your_supabase')) {
      return NextResponse.json(MOCK_ORDER_HISTORY.filter((h) => h.order_id === orderId));
    }

    const { createClient } = await import('@/lib/supabase/server');
    const supabase = await createClient();

    const { data, error } = await supabase
      .from('order_history')
      .select('*')
      .eq('order_id', orderId)
      .order('performed_at', { ascending: false });

    if (error) {
      return NextResponse.json(MOCK_ORDER_HISTORY.filter((h) => h.order_id === orderId));
    }

    return NextResponse.json(data || []);
  } catch {
    return NextResponse.json(MOCK_ORDER_HISTORY.filter((h) => h.order_id === orderId));
  }
}
