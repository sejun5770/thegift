'use client';

import { useRouter } from 'next/navigation';
import { cn } from '@/lib/utils';
import { getShippingCalendarMonths } from '@/lib/date-utils';
import { Calendar } from 'lucide-react';
import type { ShippingMonthData } from '@/types/dashboard';

interface ShippingCalendarProps {
  data: ShippingMonthData[] | null;
}

export function ShippingCalendar({ data }: ShippingCalendarProps) {
  const router = useRouter();
  const calendarMonths = getShippingCalendarMonths();

  const getCountForMonth = (month: string): number => {
    if (!data) return 0;
    const found = data.find((d) => d.month === month);
    return found?.total_count ?? 0;
  };

  return (
    <section>
      <div className="mb-3 flex items-center gap-2">
        <div className="h-4 w-1 rounded-full bg-violet-500" />
        <h3 className="text-sm font-semibold text-gray-800">희망출고일 현황</h3>
      </div>
      <div className="grid grid-cols-3 gap-3">
        {calendarMonths.map((cm) => (
          <button
            key={cm.month}
            type="button"
            className={cn(
              'flex flex-col items-center justify-center rounded-xl border p-5 transition-all',
              'hover:shadow-md hover:-translate-y-0.5 active:translate-y-0',
              'cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-400/50',
              cm.isCurrent
                ? 'border-blue-300 bg-blue-50 ring-1 ring-blue-200'
                : 'border-gray-200 bg-white'
            )}
            onClick={() => {
              router.push(
                `/orders?tab=all&date_type=desired_shipping_date&month=${cm.month}`
              );
            }}
          >
            <div className="flex items-center gap-1.5">
              <Calendar className={cn(
                'h-3.5 w-3.5',
                cm.isCurrent ? 'text-blue-500' : 'text-gray-400'
              )} />
              <span
                className={cn(
                  'text-xs font-semibold',
                  cm.isCurrent ? 'text-blue-600' : 'text-gray-500'
                )}
              >
                {cm.label}
              </span>
              {cm.isCurrent && (
                <span className="rounded-full bg-blue-500 px-1.5 py-0.5 text-[9px] font-bold text-white">
                  NOW
                </span>
              )}
            </div>
            <span
              className={cn(
                'mt-2 text-3xl font-bold tabular-nums',
                cm.isCurrent ? 'text-blue-700' : 'text-gray-900'
              )}
            >
              {getCountForMonth(cm.month).toLocaleString()}
            </span>
            <span className="mt-0.5 text-[11px] text-gray-400">건</span>
          </button>
        ))}
      </div>
    </section>
  );
}
