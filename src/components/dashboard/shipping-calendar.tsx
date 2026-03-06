'use client';

import { useRouter } from 'next/navigation';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { getShippingCalendarMonths } from '@/lib/date-utils';
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
    <div>
      <h3 className="mb-3 text-sm font-semibold text-gray-700">
        희망출고일 현황
      </h3>
      <div className="grid grid-cols-3 gap-3">
        {calendarMonths.map((cm) => (
          <Card
            key={cm.month}
            className={cn(
              'cursor-pointer border transition-shadow hover:shadow-md',
              cm.isCurrent
                ? 'border-blue-300 bg-blue-50'
                : 'border-gray-200 bg-white'
            )}
            onClick={() => {
              router.push(
                `/orders?tab=all&date_type=desired_shipping_date&month=${cm.month}`
              );
            }}
          >
            <CardContent className="flex flex-col items-center justify-center p-4">
              <span
                className={cn(
                  'text-xs font-medium',
                  cm.isCurrent ? 'text-blue-600' : 'text-gray-500'
                )}
              >
                {cm.label}
              </span>
              <span
                className={cn(
                  'mt-1 text-2xl font-bold',
                  cm.isCurrent ? 'text-blue-700' : 'text-gray-900'
                )}
              >
                {getCountForMonth(cm.month).toLocaleString()}
              </span>
              <span className="text-xs text-gray-400">건</span>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
