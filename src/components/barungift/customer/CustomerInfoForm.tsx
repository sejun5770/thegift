'use client';

import { useState, useCallback, useEffect } from 'react';
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { StepIndicator } from './StepIndicator';
import { ExpressSelector } from './ExpressSelector';
import { ShippingDateCalendar } from './ShippingDateCalendar';
import { StickerSelector } from './StickerSelector';
import { PaymentInfo } from './PaymentInfo';
import { OrderSummary } from './OrderSummary';
import { BG_TOTAL_STEPS, BG_ERROR_MESSAGES } from '@/lib/barungift/constants';
import type {
  BgOrderForCustomer,
  BgCustomerFormState,
  BgStickerSelection,
  BgCustomerInfoSubmitBody,
} from '@/lib/barungift/types';

interface CustomerInfoFormProps {
  order: BgOrderForCustomer;
  onComplete: () => void;
}

const STORAGE_KEY_PREFIX = 'bg_form_';

function loadFormState(orderId: string): BgCustomerFormState | null {
  try {
    const raw = sessionStorage.getItem(`${STORAGE_KEY_PREFIX}${orderId}`);
    if (raw) return JSON.parse(raw);
  } catch {
    // ignore
  }
  return null;
}

function saveFormState(orderId: string, state: BgCustomerFormState) {
  try {
    sessionStorage.setItem(`${STORAGE_KEY_PREFIX}${orderId}`, JSON.stringify(state));
  } catch {
    // ignore
  }
}

function clearFormState(orderId: string) {
  try {
    sessionStorage.removeItem(`${STORAGE_KEY_PREFIX}${orderId}`);
  } catch {
    // ignore
  }
}

const initialState: BgCustomerFormState = {
  current_step: 1,
  is_express: false,
  express_fee: 0,
  desired_ship_date: null,
  sticker_selections: [],
  cash_receipt_yn: false,
  receipt_type: null,
  receipt_number: '',
};

export function CustomerInfoForm({ order, onComplete }: CustomerInfoFormProps) {
  const [form, setForm] = useState<BgCustomerFormState>(() => {
    return loadFormState(order.order_id) || initialState;
  });
  const [submitting, setSubmitting] = useState(false);

  // sessionStorage에 자동 저장
  useEffect(() => {
    saveFormState(order.order_id, form);
  }, [form, order.order_id]);

  const updateForm = useCallback(
    (updates: Partial<BgCustomerFormState>) => {
      setForm((prev) => ({ ...prev, ...updates }));
    },
    []
  );

  const goNext = () => {
    if (form.current_step < BG_TOTAL_STEPS) {
      updateForm({ current_step: form.current_step + 1 });
    }
  };

  const goBack = () => {
    if (form.current_step > 1) {
      updateForm({ current_step: form.current_step - 1 });
    }
  };

  const canProceed = (): boolean => {
    switch (form.current_step) {
      case 1: // 출고 방식: 항상 진행 가능
        return true;
      case 2: // 희망출고일: 날짜 선택 필수
        return !!form.desired_ship_date;
      case 3: { // 스티커: 필수 필드 입력 확인
        if (order.available_stickers.length === 0) return true;
        if (form.sticker_selections.length === 0) return false;
        return form.sticker_selections.every((sel) => {
          const sticker = order.available_stickers.find(
            (s) => s.id === sel.sticker_id
          );
          if (!sticker) return false;
          return sticker.custom_fields
            .filter((f) => f.required)
            .every((f) => sel.custom_values[f.field_id]?.trim());
        });
      }
      case 4: // 결제정보: 현금영수증 선택 시 번호 입력 필수
        if (form.cash_receipt_yn) {
          return !!form.receipt_type && !!form.receipt_number;
        }
        return true;
      case 5: // 최종 확인
        return true;
      default:
        return false;
    }
  };

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      const body: BgCustomerInfoSubmitBody = {
        is_express: form.is_express,
        express_fee: form.is_express ? (order.product_settings?.express_fee || 0) : 0,
        desired_ship_date: form.desired_ship_date!,
        sticker_selections: form.sticker_selections,
        cash_receipt_yn: form.cash_receipt_yn,
        receipt_type: form.cash_receipt_yn ? form.receipt_type : null,
        receipt_number: form.cash_receipt_yn ? form.receipt_number : null,
      };

      const res = await fetch(
        `/c/barungift/api/orders/${order.order_id}/customer-info`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      );

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || BG_ERROR_MESSAGES.SUBMIT_FAILED);
      }

      clearFormState(order.order_id);
      onComplete();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : BG_ERROR_MESSAGES.SUBMIT_FAILED
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <StepIndicator currentStep={form.current_step} />

      <div className="min-h-[400px]">
        {/* Step 1: 출고 방식 */}
        {form.current_step === 1 && (
          <ExpressSelector
            productSettings={order.product_settings}
            isExpress={form.is_express}
            onSelect={(isExpress) => {
              updateForm({
                is_express: isExpress,
                express_fee: isExpress
                  ? (order.product_settings?.express_fee || 0)
                  : 0,
                // 빠른출고 변경 시 날짜 초기화
                desired_ship_date: null,
              });
            }}
          />
        )}

        {/* Step 2: 희망 출고일 */}
        {form.current_step === 2 && (
          <ShippingDateCalendar
            productSettings={order.product_settings}
            isExpress={form.is_express}
            selectedDate={form.desired_ship_date}
            onSelect={(date) => updateForm({ desired_ship_date: date })}
          />
        )}

        {/* Step 3: 스티커 선택 */}
        {form.current_step === 3 && (
          <>
            {order.available_stickers.length > 0 ? (
              <StickerSelector
                stickers={order.available_stickers}
                productId={order.products[0]?.product_code || order.products[0]?.id || ''}
                selection={form.sticker_selections[0] || null}
                onSelect={(selection) => {
                  updateForm({ sticker_selections: [selection] });
                }}
              />
            ) : (
              <div className="flex flex-col items-center justify-center py-16 text-gray-400">
                <p className="text-sm">이 상품은 스티커 선택이 필요하지 않습니다.</p>
              </div>
            )}
          </>
        )}

        {/* Step 4: 결제 정보 */}
        {form.current_step === 4 && (
          <PaymentInfo
            bankInfo={order.bank_info}
            totalAmount={order.total_amount}
            expressFee={form.is_express ? (order.product_settings?.express_fee || 0) : 0}
            cashReceiptYn={form.cash_receipt_yn}
            receiptType={form.receipt_type}
            receiptNumber={form.receipt_number}
            onCashReceiptChange={(yn) =>
              updateForm({
                cash_receipt_yn: yn,
                receipt_type: yn ? form.receipt_type : null,
                receipt_number: yn ? form.receipt_number : '',
              })
            }
            onReceiptTypeChange={(type) => updateForm({ receipt_type: type })}
            onReceiptNumberChange={(number) => updateForm({ receipt_number: number })}
          />
        )}

        {/* Step 5: 최종 확인 */}
        {form.current_step === 5 && (
          <OrderSummary
            isExpress={form.is_express}
            expressFee={order.product_settings?.express_fee || 0}
            desiredShipDate={form.desired_ship_date!}
            stickerSelections={form.sticker_selections}
            stickers={order.available_stickers}
            cashReceiptYn={form.cash_receipt_yn}
            receiptType={form.receipt_type}
            receiptNumber={form.receipt_number}
            totalAmount={order.total_amount}
            bankInfo={order.bank_info}
          />
        )}
      </div>

      {/* 네비게이션 버튼 */}
      <div className="flex gap-3 pb-8">
        {form.current_step > 1 && (
          <Button
            type="button"
            variant="outline"
            onClick={goBack}
            className="flex-1"
          >
            <ChevronLeft className="mr-1 h-4 w-4" />
            이전
          </Button>
        )}

        {form.current_step < BG_TOTAL_STEPS ? (
          <Button
            type="button"
            onClick={goNext}
            disabled={!canProceed()}
            className="flex-1"
          >
            다음
            <ChevronRight className="ml-1 h-4 w-4" />
          </Button>
        ) : (
          <Button
            type="button"
            onClick={handleSubmit}
            disabled={submitting}
            className="flex-1 bg-blue-600 hover:bg-blue-700"
          >
            {submitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                저장 중...
              </>
            ) : (
              '정보 입력 완료'
            )}
          </Button>
        )}
      </div>
    </div>
  );
}
