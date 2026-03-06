'use client';

import { Badge } from '@/components/ui/badge';
import { HIGHLIGHT_LABELS, HIGHLIGHT_COLORS } from '@/lib/constants';
import type { HighlightType } from '@/types/enums';

interface HighlightBadgesProps {
  highlights: HighlightType[];
}

export function HighlightBadges({ highlights }: HighlightBadgesProps) {
  if (!highlights || highlights.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1">
      {highlights.map((type) => (
        <Badge
          key={type}
          variant="secondary"
          className={`${HIGHLIGHT_COLORS[type]} text-[10px] px-1.5 py-0 font-medium`}
        >
          {HIGHLIGHT_LABELS[type]}
        </Badge>
      ))}
    </div>
  );
}
