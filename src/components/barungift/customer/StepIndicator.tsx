'use client';

import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { BG_STEP_LABELS } from '@/lib/barungift/constants';

interface StepIndicatorProps {
  currentStep: number; // 1-based
}

export function StepIndicator({ currentStep }: StepIndicatorProps) {
  return (
    <div className="w-full py-4">
      <div className="flex items-center justify-between">
        {BG_STEP_LABELS.map((label, index) => {
          const step = index + 1;
          const isCompleted = step < currentStep;
          const isCurrent = step === currentStep;

          return (
            <div key={step} className="flex flex-1 items-center">
              {/* 스텝 원 + 라벨 */}
              <div className="flex flex-col items-center gap-1.5">
                <div
                  className={cn(
                    'flex h-8 w-8 items-center justify-center rounded-full text-xs font-bold transition-colors',
                    isCompleted && 'bg-blue-500 text-white',
                    isCurrent && 'bg-blue-500 text-white ring-4 ring-blue-100',
                    !isCompleted && !isCurrent && 'bg-gray-200 text-gray-500'
                  )}
                >
                  {isCompleted ? <Check className="h-4 w-4" /> : step}
                </div>
                <span
                  className={cn(
                    'text-[10px] font-medium whitespace-nowrap',
                    isCurrent ? 'text-blue-600' : 'text-gray-400'
                  )}
                >
                  {label}
                </span>
              </div>

              {/* 연결선 */}
              {step < BG_STEP_LABELS.length && (
                <div className="mx-1 h-0.5 flex-1">
                  <div
                    className={cn(
                      'h-full transition-colors',
                      step < currentStep ? 'bg-blue-500' : 'bg-gray-200'
                    )}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
