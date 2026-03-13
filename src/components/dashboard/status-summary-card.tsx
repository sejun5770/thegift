'use client';

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
    <button
      type="button"
      className={cn(
        'flex flex-col items-center justify-center rounded-xl border p-4 transition-all',
        'hover:shadow-md hover:-translate-y-0.5 active:translate-y-0',
        'cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-400/50',
        colorClass
      )}
      onClick={onClick}
    >
      <span className="text-3xl font-bold tabular-nums">{count.toLocaleString()}</span>
      <span className="mt-1.5 text-[11px] font-semibold tracking-tight">{label}</span>
    </button>
  );
}
