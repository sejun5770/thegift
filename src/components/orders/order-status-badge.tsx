'use client';

import { Badge } from '@/components/ui/badge';
import { ORDER_STATUS_LABELS, ORDER_STATUS_BADGE_COLORS } from '@/lib/constants';
import type { OrderStatus } from '@/types/enums';

interface OrderStatusBadgeProps {
  status: OrderStatus;
}

export function OrderStatusBadge({ status }: OrderStatusBadgeProps) {
  return (
    <Badge
      variant="secondary"
      className={`${ORDER_STATUS_BADGE_COLORS[status]} text-[10px] px-1.5 py-0 font-medium`}
    >
      {ORDER_STATUS_LABELS[status]}
    </Badge>
  );
}
