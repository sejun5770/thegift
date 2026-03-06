import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { format, subMonths, addMonths, startOfMonth } from 'date-fns';

export async function GET() {
  try {
    const supabase = await createClient();
    const today = new Date();
    const prevMonth = format(startOfMonth(subMonths(today, 1)), 'yyyy-MM-dd');
    const nextMonthEnd = format(startOfMonth(addMonths(today, 2)), 'yyyy-MM-dd');

    // 전월, 현재월, 익월 범위의 주문 조회
    const { data: orders, error } = await supabase
      .from('orders')
      .select('desired_shipping_date')
      .eq('is_deleted', false)
      .gte('desired_shipping_date', prevMonth)
      .lt('desired_shipping_date', nextMonthEnd);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // 월별 그룹핑
    const monthCounts: Record<string, number> = {};
    (orders || []).forEach((order) => {
      const month = order.desired_shipping_date?.substring(0, 7);
      if (month) {
        monthCounts[month] = (monthCounts[month] || 0) + 1;
      }
    });

    const currentMonth = format(today, 'yyyy-MM');
    const result = Object.entries(monthCounts).map(([month, total_count]) => ({
      month,
      total_count,
      label: month,
      is_current: month === currentMonth,
    }));

    return NextResponse.json(result);
  } catch {
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
