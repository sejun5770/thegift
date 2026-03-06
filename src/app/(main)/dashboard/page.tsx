'use client';

import { useState, useEffect, useCallback } from 'react';
import { PeriodFilter } from '@/components/dashboard/period-filter';
import { OrderStatusCards } from '@/components/dashboard/order-status-cards';
import { WorkStatusCards } from '@/components/dashboard/work-status-cards';
import { ShippingCalendar } from '@/components/dashboard/shipping-calendar';
import { getDateRangeFromPreset } from '@/lib/date-utils';
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
      // 기간 프리셋에 따른 날짜 범위 계산
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
    // 프리셋 변경 시 자동으로 날짜 범위 계산
    if (newFilter.preset !== 'custom') {
      const range = getDateRangeFromPreset(newFilter.preset, newFilter.month);
      setFilter({ ...newFilter, ...range });
    } else {
      setFilter(newFilter);
    }
  };

  return (
    <div className="space-y-6">
      {/* 기간 검색 */}
      <PeriodFilter value={filter} onChange={handleFilterChange} />

      {/* 주문 현황 */}
      <OrderStatusCards data={summary?.order_status ?? null} />

      {/* 작업 현황 */}
      <WorkStatusCards data={summary?.work_status ?? null} />

      {/* 희망 출고일 현황 */}
      <ShippingCalendar data={shippingData} />

      {loading && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-white/50">
          <div className="text-sm text-gray-500">로딩중...</div>
        </div>
      )}
    </div>
  );
}
