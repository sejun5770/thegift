'use client';

import { useState, useEffect, useCallback } from 'react';
import { PeriodFilter } from '@/components/dashboard/period-filter';
import { OrderStatusCards } from '@/components/dashboard/order-status-cards';
import { WorkStatusCards } from '@/components/dashboard/work-status-cards';
import { ShippingCalendar } from '@/components/dashboard/shipping-calendar';
import { getDateRangeFromPreset } from '@/lib/date-utils';
import { Loader2 } from 'lucide-react';
import type { PeriodFilter as PeriodFilterType, DashboardSummary, ShippingMonthData } from '@/types/dashboard';

export default function DashboardPage() {
  const initialRange = getDateRangeFromPreset('today');
  const [filter, setFilter] = useState<PeriodFilterType>({
    dateType: 'desired_shipping_date',
    preset: 'today',
    startDate: initialRange.startDate,
    endDate: initialRange.endDate,
  });
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [shippingData, setShippingData] = useState<ShippingMonthData[] | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchDashboard = useCallback(async () => {
    setLoading(true);
    try {
      const range = filter.preset === 'custom'
        ? { startDate: filter.startDate, endDate: filter.endDate }
        : getDateRangeFromPreset(filter.preset, filter.month);

      const params = new URLSearchParams({
        date_type: filter.dateType,
        start_date: range.startDate,
        end_date: range.endDate,
      });

      const [summaryRes, calendarRes] = await Promise.all([
        fetch(`/api/dashboard/summary?${params}`),
        fetch('/api/dashboard/shipping-calendar'),
      ]);

      if (summaryRes.ok) {
        const data = await summaryRes.json();
        setSummary(data);
      }

      if (calendarRes.ok) {
        const data = await calendarRes.json();
        setShippingData(data);
      }
    } catch (error) {
      console.error('Dashboard fetch error:', error);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    fetchDashboard();
  }, [fetchDashboard]);

  const handleFilterChange = (newFilter: PeriodFilterType) => {
    if (newFilter.preset !== 'custom') {
      const range = getDateRangeFromPreset(newFilter.preset, newFilter.month);
      setFilter({ ...newFilter, ...range });
    } else {
      setFilter(newFilter);
    }
  };

  return (
    <div className="relative space-y-6">
      {/* 기간 검색 */}
      <PeriodFilter value={filter} onChange={handleFilterChange} />

      {/* 주문 현황 */}
      <OrderStatusCards data={summary?.order_status ?? null} />

      {/* 작업 현황 */}
      <WorkStatusCards data={summary?.work_status ?? null} />

      {/* 희망 출고일 현황 */}
      <ShippingCalendar data={shippingData} />

      {/* 로딩 오버레이 */}
      {loading && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-white/60 backdrop-blur-[1px]">
          <div className="flex items-center gap-2 rounded-lg bg-white px-4 py-3 shadow-lg">
            <Loader2 className="h-4 w-4 animate-spin text-blue-500" />
            <span className="text-sm text-gray-600">데이터를 불러오는 중...</span>
          </div>
        </div>
      )}
    </div>
  );
}
