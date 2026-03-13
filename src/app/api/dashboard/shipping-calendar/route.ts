import { NextResponse } from 'next/server';
import { MOCK_SHIPPING_CALENDAR } from '@/lib/mock-data';

export async function GET() {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    if (!supabaseUrl || supabaseUrl.includes('your_supabase')) {
      return NextResponse.json(MOCK_SHIPPING_CALENDAR);
    }

    const { createClient } = await import('@/lib/supabase/server');
    const { format, subMonths, addMonths, startOfMonth } = await import('date-fns');
    const supabase = await createClient();
    const today = new Date();
    const prevMonth = format(startOfMonth(subMonths(today, 1)), 'yyyy-MM-dd');
    const nextMonthEnd = format(startOfMonth(addMonths(today, 2)), 'yyyy-MM-dd');

    const { data: orders, error } = await supabase
      .from('orders')
      .select('desired_shipping_date')
      .eq('is_deleted', false)
      .gte('desired_shipping_date', prevMonth)
      .lt('desired_shipping_date', nextMonthEnd);

    if (error) {
      return NextResponse.json(MOCK_SHIPPING_CALENDAR);
    }

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
    return NextResponse.json(MOCK_SHIPPING_CALENDAR);
  }
}
