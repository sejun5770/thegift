'use client';

import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

interface StatusSummaryCardProps {
  label: string;
  count: number;
  colorClass: string;
  onClick?: () => void;
}

export function StatusSummaryCard({
  label,
  count,
  colorClass,
  onClick,
}: StatusSummaryCardProps) {
  return (
    <Card
      className={cn(
        'cursor-pointer border transition-shadow hover:shadow-md',
        colorClass
      )}
      onClick={onClick}
    >
      <CardContent className="flex flex-col items-center justify-center p-4">
        <span className="text-2xl font-bold">{count.toLocaleString()}</span>
        <span className="mt-1 text-xs font-medium">{label}</span>
      </CardContent>
    </Card>
  );
}
