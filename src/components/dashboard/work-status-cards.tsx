'use client';

import { useRouter } from 'next/navigation';
import { StatusSummaryCard } from './status-summary-card';
import { ORDER_STATUS_COLORS, ORDER_STATUS_LABELS } from '@/lib/constants';
import type { DashboardSummary } from '@/types/dashboard';

interface WorkStatusCardsProps {
  data: DashboardSummary['work_status'] | null;
}

export function WorkStatusCards({ data }: WorkStatusCardsProps) {
  const router = useRouter();

  const items = [
    {
      key: 'draft_completed' as const,
      label: ORDER_STATUS_LABELS.draft_completed,
      color: ORDER_STATUS_COLORS.draft_completed,
    },
    {
      key: 'print_ready' as const,
      label: ORDER_STATUS_LABELS.print_ready,
      color: ORDER_STATUS_COLORS.print_ready,
    },
    {
      key: 'print_completed' as const,
      label: ORDER_STATUS_LABELS.print_completed,
      color: ORDER_STATUS_COLORS.print_completed,
    },
    {
      key: 'binding_completed' as const,
      label: ORDER_STATUS_LABELS.binding_completed,
      color: ORDER_STATUS_COLORS.binding_completed,
    },
    {
      key: 'shipping_completed' as const,
      label: ORDER_STATUS_LABELS.shipping_completed,
      color: ORDER_STATUS_COLORS.shipping_completed,
    },
  ];

  return (
    <div>
      <h3 className="mb-3 text-sm font-semibold text-gray-700">작업현황</h3>
      <div className="grid grid-cols-5 gap-3">
        {items.map((item) => (
          <StatusSummaryCard
            key={item.key}
            label={item.label}
            count={data?.[item.key] ?? 0}
            colorClass={item.color}
            onClick={() => router.push(`/orders?tab=${item.key}`)}
          />
        ))}
      </div>
    </div>
  );
}
