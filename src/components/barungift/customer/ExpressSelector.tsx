'use client';

import { Truck, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatCurrency } from '@/lib/barungift/utils';
import { BG_SHIPPING_TYPE_LABELS } from '@/lib/barungift/constants';
import type { BgProductSettings } from '@/lib/barungift/types';

interface ExpressSelectorProps {
  productSettings: BgProductSettings | null;
  isExpress: boolean;
  onSelect: (isExpress: boolean) => void;
}

export function ExpressSelector({
  productSettings,
  isExpress,
  onSelect,
}: ExpressSelectorProps) {
  const expressAvailable = productSettings?.express_available ?? false;
  const expressFee = productSettings?.express_fee ?? 0;
  const leadTimeDays = productSettings?.lead_time_days ?? 5;

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-bold text-gray-900">출고 방식을 선택해주세요</h2>
      <p className="text-sm text-gray-500">
        빠른 출고를 선택하시면 더 빠르게 받아보실 수 있습니다.
      </p>

      <div className="grid gap-3">
        {/* 일반 출고 */}
        <button
          type="button"
          onClick={() => onSelect(false)}
          className={cn(
            'flex items-start gap-4 rounded-xl border-2 p-4 text-left transition-all',
            !isExpress
              ? 'border-blue-500 bg-blue-50/50 shadow-sm'
              : 'border-gray-200 bg-white hover:border-gray-300'
          )}
        >
          <div
            className={cn(
              'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg',
              !isExpress ? 'bg-blue-500 text-white' : 'bg-gray-100 text-gray-400'
            )}
          >
            <Truck className="h-5 w-5" />
          </div>
          <div className="flex-1">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-gray-900">
                {BG_SHIPPING_TYPE_LABELS.normal}
              </span>
              <span className="text-sm text-gray-500">추가비용 없음</span>
            </div>
            <p className="mt-1 text-sm text-gray-500">
              주문일로부터 약 {leadTimeDays}영업일 후 출고
            </p>
          </div>
        </button>

        {/* 빠른 출고 */}
        <button
          type="button"
          onClick={() => expressAvailable && onSelect(true)}
          disabled={!expressAvailable}
          className={cn(
            'flex items-start gap-4 rounded-xl border-2 p-4 text-left transition-all',
            !expressAvailable && 'cursor-not-allowed opacity-50',
            isExpress && expressAvailable
              ? 'border-blue-500 bg-blue-50/50 shadow-sm'
              : 'border-gray-200 bg-white hover:border-gray-300',
            !expressAvailable && 'hover:border-gray-200'
          )}
        >
          <div
            className={cn(
              'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg',
              isExpress && expressAvailable
                ? 'bg-blue-500 text-white'
                : 'bg-gray-100 text-gray-400'
            )}
          >
            <Zap className="h-5 w-5" />
          </div>
          <div className="flex-1">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-gray-900">
                {BG_SHIPPING_TYPE_LABELS.express}
              </span>
              {expressFee > 0 && (
                <span className="text-sm font-medium text-orange-600">
                  +{formatCurrency(expressFee)}
                </span>
              )}
            </div>
            <p className="mt-1 text-sm text-gray-500">
              {expressAvailable
                ? '컷오프 시간 기준 1~2영업일 내 출고'
                : '이 상품은 빠른 출고를 지원하지 않습니다'}
            </p>
          </div>
        </button>
      </div>
    </div>
  );
}
