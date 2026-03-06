import {
  format,
  startOfDay,
  endOfDay,
  subDays,
  startOfMonth,
  endOfMonth,
  addMonths,
  subMonths,
} from 'date-fns';
import { ko } from 'date-fns/locale';
import type { PeriodPreset } from '@/types/enums';

export function getDateRangeFromPreset(preset: PeriodPreset, customMonth?: string): {
  startDate: string;
  endDate: string;
} {
  const today = new Date();

  switch (preset) {
    case 'today':
      return {
        startDate: format(startOfDay(today), 'yyyy-MM-dd'),
        endDate: format(endOfDay(today), 'yyyy-MM-dd'),
      };
    case 'yesterday': {
      const yesterday = subDays(today, 1);
      return {
        startDate: format(startOfDay(yesterday), 'yyyy-MM-dd'),
        endDate: format(endOfDay(yesterday), 'yyyy-MM-dd'),
      };
    }
    case 'last_2_days':
      return {
        startDate: format(startOfDay(subDays(today, 1)), 'yyyy-MM-dd'),
        endDate: format(endOfDay(today), 'yyyy-MM-dd'),
      };
    case 'last_3_days':
      return {
        startDate: format(startOfDay(subDays(today, 2)), 'yyyy-MM-dd'),
        endDate: format(endOfDay(today), 'yyyy-MM-dd'),
      };
    case 'last_7_days':
      return {
        startDate: format(startOfDay(subDays(today, 6)), 'yyyy-MM-dd'),
        endDate: format(endOfDay(today), 'yyyy-MM-dd'),
      };
    case 'last_30_days':
      return {
        startDate: format(startOfDay(subDays(today, 29)), 'yyyy-MM-dd'),
        endDate: format(endOfDay(today), 'yyyy-MM-dd'),
      };
    case 'monthly': {
      const monthDate = customMonth ? new Date(customMonth + '-01') : today;
      return {
        startDate: format(startOfMonth(monthDate), 'yyyy-MM-dd'),
        endDate: format(endOfMonth(monthDate), 'yyyy-MM-dd'),
      };
    }
    case 'custom':
    default:
      return {
        startDate: format(startOfDay(today), 'yyyy-MM-dd'),
        endDate: format(endOfDay(today), 'yyyy-MM-dd'),
      };
  }
}

export function formatDateKo(date: string | Date): string {
  return format(new Date(date), 'yyyy.MM.dd', { locale: ko });
}

export function formatDateTimeKo(date: string | Date): string {
  return format(new Date(date), 'yyyy.MM.dd HH:mm', { locale: ko });
}

export function formatMonthKo(date: string | Date): string {
  return format(new Date(date), 'yyyy년 M월', { locale: ko });
}

export function getShippingCalendarMonths(): { month: string; label: string; isCurrent: boolean }[] {
  const today = new Date();
  const prevMonth = subMonths(today, 1);
  const nextMonth = addMonths(today, 1);

  return [
    {
      month: format(prevMonth, 'yyyy-MM'),
      label: formatMonthKo(prevMonth),
      isCurrent: false,
    },
    {
      month: format(today, 'yyyy-MM'),
      label: formatMonthKo(today),
      isCurrent: true,
    },
    {
      month: format(nextMonth, 'yyyy-MM'),
      label: formatMonthKo(nextMonth),
      isCurrent: false,
    },
  ];
}
