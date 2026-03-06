'use client';

import { useRouter } from 'next/navigation';
import { StatusSummaryCard } from './status-summary-card';
import { ORDER_STATUS_COLORS, ORDER_STATUS_LABELS } from '@/lib/constants';
import type { DashboardSummary } from '@/types/dashboard';

interface OrderStatusCardsProps {
  data: DashboardSummary['order_status'] | null;
}

export function OrderStatusCards({ data }: OrderStatusCardsProps) {
  const router = useRouter();

  const items = [
    {
      key: 'total' as const,
      label: '전체주문',
      color: 'bg-gray-50 text-gray-700 border-gray-200',
    },
    {
      key: 'collected' as const,
      label: ORDER_STATUS_LABELS.collected,
      color: ORDER_STATUS_COLORS.collected,
    },
    {
      key: 'cancelled' as const,
      label: ORDER_STATUS_LABELS.cancelled,
      color: ORDER_STATUS_COLORS.cancelled,
    },
    {
      key: 'validation_failed' as const,
      label: ORDER_STATUS_LABELS.validation_failed,
      color: ORDER_STATUS_COLORS.validation_failed,
    },
    {
      key: 'system_error' as const,
      label: ORDER_STATUS_LABELS.system_error,
      color: ORDER_STATUS_COLORS.system_error,
    },
  ];

  return (
    <div>
      <h3 className="mb-3 text-sm font-semibold text-gray-700">주문현황</h3>
      <div className="grid grid-cols-5 gap-3">
        {items.map((item) => (
          <StatusSummaryCard
            key={item.key}
            label={item.label}
            count={data?.[item.key] ?? 0}
            colorClass={item.color}
            onClick={() => {
              if (item.key !== 'total') {
                router.push(`/orders?tab=${item.key}`);
              } else {
                router.push('/orders?tab=all');
              }
            }}
          />
        ))}
      </div>
    </div>
  );
}
