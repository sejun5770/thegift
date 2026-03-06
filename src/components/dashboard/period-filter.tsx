'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { CalendarIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';
import { ko } from 'date-fns/locale';
import { PERIOD_PRESETS } from '@/lib/constants';
import type { DateFilterType, PeriodPreset } from '@/types/enums';
import type { PeriodFilter as PeriodFilterType } from '@/types/dashboard';

interface PeriodFilterProps {
  value: PeriodFilterType;
  onChange: (filter: PeriodFilterType) => void;
}

export function PeriodFilter({ value, onChange }: PeriodFilterProps) {
  const [customFrom, setCustomFrom] = useState<Date | undefined>(
    value.startDate ? new Date(value.startDate) : undefined
  );
  const [customTo, setCustomTo] = useState<Date | undefined>(
    value.endDate ? new Date(value.endDate) : undefined
  );

  const handleDateTypeChange = (dateType: DateFilterType) => {
    onChange({ ...value, dateType });
  };

  const handlePresetChange = (preset: PeriodPreset) => {
    if (preset === 'custom') {
      onChange({ ...value, preset });
      return;
    }

    if (preset === 'monthly') {
      const now = new Date();
      const month = format(now, 'yyyy-MM');
      onChange({ ...value, preset, month });
      return;
    }

    onChange({ ...value, preset });
  };

  const handleMonthChange = (month: string) => {
    onChange({ ...value, preset: 'monthly', month });
  };

  const handleCustomDateApply = () => {
    if (customFrom && customTo) {
      onChange({
        ...value,
        preset: 'custom',
        startDate: format(customFrom, 'yyyy-MM-dd'),
        endDate: format(customTo, 'yyyy-MM-dd'),
      });
    }
  };

  // 월별 선택 옵션 생성 (현재 연도 기준 +-1년)
  const currentYear = new Date().getFullYear();
  const months = [];
  for (let y = currentYear - 1; y <= currentYear + 1; y++) {
    for (let m = 1; m <= 12; m++) {
      const monthStr = `${y}-${String(m).padStart(2, '0')}`;
      months.push({ value: monthStr, label: `${y}년 ${m}월` });
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-white p-4">
      {/* 조건 선택 */}
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-gray-700">조건</span>
        <Select
          value={value.dateType}
          onValueChange={(v) => handleDateTypeChange(v as DateFilterType)}
        >
          <SelectTrigger className="w-[140px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="desired_shipping_date">희망출고일</SelectItem>
            <SelectItem value="collected_at">주문수집일</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* 구분선 */}
      <div className="h-8 w-px bg-gray-200" />

      {/* 기간 프리셋 */}
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-gray-700">기간</span>
        <div className="flex flex-wrap gap-1.5">
          {PERIOD_PRESETS.map((preset) => (
            <Button
              key={preset.value}
              variant={value.preset === preset.value ? 'default' : 'outline'}
              size="sm"
              onClick={() => handlePresetChange(preset.value)}
              className="h-8 text-xs"
            >
              {preset.label}
            </Button>
          ))}
        </div>
      </div>

      {/* 월별 선택 */}
      {value.preset === 'monthly' && (
        <Select value={value.month || ''} onValueChange={handleMonthChange}>
          <SelectTrigger className="w-[140px]">
            <SelectValue placeholder="월 선택" />
          </SelectTrigger>
          <SelectContent>
            {months.map((m) => (
              <SelectItem key={m.value} value={m.value}>
                {m.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {/* 기간 직접 선택 */}
      {value.preset === 'custom' && (
        <div className="flex items-center gap-2">
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className={cn(
                  'h-8 justify-start text-left font-normal',
                  !customFrom && 'text-muted-foreground'
                )}
              >
                <CalendarIcon className="mr-2 h-3.5 w-3.5" />
                {customFrom
                  ? format(customFrom, 'yyyy.MM.dd', { locale: ko })
                  : '시작일'}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <Calendar
                mode="single"
                selected={customFrom}
                onSelect={setCustomFrom}
                locale={ko}
              />
            </PopoverContent>
          </Popover>
          <span className="text-sm text-gray-500">~</span>
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className={cn(
                  'h-8 justify-start text-left font-normal',
                  !customTo && 'text-muted-foreground'
                )}
              >
                <CalendarIcon className="mr-2 h-3.5 w-3.5" />
                {customTo
                  ? format(customTo, 'yyyy.MM.dd', { locale: ko })
                  : '종료일'}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <Calendar
                mode="single"
                selected={customTo}
                onSelect={setCustomTo}
                locale={ko}
              />
            </PopoverContent>
          </Popover>
          <Button size="sm" className="h-8" onClick={handleCustomDateApply}>
            적용
          </Button>
        </div>
      )}
    </div>
  );
}
