'use client';

import { Badge } from '@/components/ui/badge';
import { SHIPPING_METHOD_LABELS, SHIPPING_METHOD_COLORS } from '@/lib/constants';
import type { ShippingMethod } from '@/types/enums';

interface ShippingMethodBadgeProps {
  method: ShippingMethod;
}

export function ShippingMethodBadge({ method }: ShippingMethodBadgeProps) {
  return (
    <Badge
      variant="secondary"
      className={`${SHIPPING_METHOD_COLORS[method]} text-[10px] px-1.5 py-0 font-medium`}
    >
      {SHIPPING_METHOD_LABELS[method]}
    </Badge>
  );
}
