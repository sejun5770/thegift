import { NextRequest, NextResponse } from 'next/server';
import { MOCK_DASHBOARD_SUMMARY } from '@/lib/mock-data';

export async function GET(request: NextRequest) {
  try {
    // Supabase 설정 확인
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    if (!supabaseUrl || supabaseUrl.includes('your_supabase')) {
      // Mock 데이터 반환
      return NextResponse.json(MOCK_DASHBOARD_SUMMARY);
    }

    const { createClient } = await import('@/lib/supabase/server');
    const searchParams = request.nextUrl.searchParams;
    const dateType = searchParams.get('date_type') || 'desired_shipping_date';
    const startDate = searchParams.get('start_date');
    const endDate = searchParams.get('end_date');

    if (!startDate || !endDate) {
      return NextResponse.json(MOCK_DASHBOARD_SUMMARY);
    }

    const supabase = await createClient();

    const { data, error } = await supabase.rpc('get_dashboard_summary', {
      p_date_type: dateType,
      p_start_date: startDate,
      p_end_date: endDate,
    });

    if (error) {
      const dateColumn = dateType === 'desired_shipping_date'
        ? 'desired_shipping_date'
        : 'collected_at';

      let query = supabase
        .from('orders')
        .select('status')
        .eq('is_deleted', false);

      if (dateType === 'desired_shipping_date') {
        query = query
          .gte('desired_shipping_date', startDate)
          .lte('desired_shipping_date', endDate);
      } else {
        query = query
          .gte('collected_at', `${startDate}T00:00:00`)
          .lte('collected_at', `${endDate}T23:59:59`);
      }

      const { data: orders, error: queryError } = await query;

      if (queryError) {
        return NextResponse.json(MOCK_DASHBOARD_SUMMARY);
      }

      const orderList = orders || [];
      const summary = {
        order_status: {
          total: orderList.length,
          collected: orderList.filter((o) => o.status === 'collected').length,
          cancelled: orderList.filter((o) => o.status === 'cancelled').length,
          validation_failed: orderList.filter((o) => o.status === 'validation_failed').length,
          system_error: orderList.filter((o) => o.status === 'system_error').length,
        },
        work_status: {
          draft_completed: orderList.filter((o) => o.status === 'draft_completed').length,
          print_ready: orderList.filter((o) => o.status === 'print_ready').length,
          print_completed: orderList.filter((o) => o.status === 'print_completed').length,
          binding_completed: orderList.filter((o) => o.status === 'binding_completed').length,
          shipping_completed: orderList.filter((o) => o.status === 'shipping_completed').length,
        },
      };

      return NextResponse.json(summary);
    }

    return NextResponse.json(data);
  } catch {
    return NextResponse.json(MOCK_DASHBOARD_SUMMARY);
  }
}
