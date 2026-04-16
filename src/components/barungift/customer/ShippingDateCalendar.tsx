'use client';

import { useMemo } from 'react';
import { Calendar } from '@/components/ui/calendar';
import { ko } from 'date-fns/locale';
import { parseISO, isWeekend, startOfDay } from 'date-fns';
import { calculateDateRange, isKoreanHoliday, formatDateKorean } from '@/lib/barungift/utils';
import type { BgProductSettings } from '@/lib/barungift/types';

interface ShippingDateCalendarProps {
  productSettings: BgProductSettings | null;
  isExpress: boolean;
  selectedDate: string | null; // YYYY-MM-DD
  onSelect: (date: string) => void;
}

export function ShippingDateCalendar({
  productSettings,
  isExpress,
  selectedDate,
  onSelect,
}: ShippingDateCalendarProps) {
  const { minDate, maxDate } = useMemo(
    () => calculateDateRange(productSettings, isExpress),
    [productSettings, isExpress]
  );

  const blackoutDates = useMemo(() => {
    return (productSettings?.blackout_dates || []).map((d) => startOfDay(parseISO(d)));
  }, [productSettings]);

  const disabledMatcher = useMemo(() => {
    return (date: Date) => {
      const day = startOfDay(date);
      // 범위 밖
      if (day < startOfDay(minDate) || day > startOfDay(maxDate)) return true;
      // 주말
      if (isWeekend(day)) return true;
      // 공휴일
      if (isKoreanHoliday(day)) return true;
      // 블랙아웃
      if (blackoutDates.some((bd) => bd.getTime() === day.getTime())) return true;
      return false;
    };
  }, [minDate, maxDate, blackoutDates]);

  const selected = selectedDate ? parseISO(selectedDate) : undefined;

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-bold text-gray-900">희망 출고일을 선택해주세요</h2>
      <p className="text-sm text-gray-500">
        주말, 공휴일, 블랙아웃 날짜는 선택할 수 없습니다.
      </p>

      <div className="flex justify-center">
        <Calendar
          mode="single"
          selected={selected}
          onSelect={(date) => {
            if (date) {
              const yyyy = date.getFullYear();
              const mm = String(date.getMonth() + 1).padStart(2, '0');
              const dd = String(date.getDate()).padStart(2, '0');
              onSelect(`${yyyy}-${mm}-${dd}`);
            }
          }}
          disabled={disabledMatcher}
          locale={ko}
          defaultMonth={minDate}
          fromDate={minDate}
          toDate={maxDate}
          className="rounded-xl border bg-white p-3 shadow-sm"
        />
      </div>

      {selectedDate && (
        <div className="rounded-lg bg-blue-50 p-3 text-center">
          <span className="text-sm font-medium text-blue-700">
            선택하신 출고일: {formatDateKorean(selectedDate)}
          </span>
        </div>
      )}
    </div>
  );
}
