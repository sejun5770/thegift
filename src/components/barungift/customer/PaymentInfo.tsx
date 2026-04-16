'use client';

import { useState } from 'react';
import { Copy, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import { formatCurrency } from '@/lib/barungift/utils';
import { BG_BANK_INFO, BG_RECEIPT_TYPE_LABELS } from '@/lib/barungift/constants';
import type { BgBankInfo } from '@/lib/barungift/types';

interface PaymentInfoProps {
  bankInfo: BgBankInfo;
  totalAmount: number;
  expressFee: number;
  cashReceiptYn: boolean;
  receiptType: 'personal' | 'business' | null;
  receiptNumber: string;
  onCashReceiptChange: (yn: boolean) => void;
  onReceiptTypeChange: (type: 'personal' | 'business') => void;
  onReceiptNumberChange: (number: string) => void;
}

export function PaymentInfo({
  bankInfo,
  totalAmount,
  expressFee,
  cashReceiptYn,
  receiptType,
  receiptNumber,
  onCashReceiptChange,
  onReceiptTypeChange,
  onReceiptNumberChange,
}: PaymentInfoProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(bankInfo.account_number);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // 클립보드 접근 실패 시 무시
    }
  };

  const grandTotal = totalAmount + expressFee;

  return (
    <div className="space-y-5">
      <h2 className="text-lg font-bold text-gray-900">결제 정보</h2>

      {/* 입금 안내 */}
      <div className="rounded-xl border bg-white p-4 space-y-3">
        <h3 className="text-sm font-semibold text-gray-700">무통장입금 안내</h3>

        <div className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-gray-500">은행</span>
            <span className="font-medium text-gray-900">{bankInfo.bank_name}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-gray-500">계좌번호</span>
            <div className="flex items-center gap-2">
              <span className="font-mono font-medium text-gray-900">
                {bankInfo.account_number}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleCopy}
                className="h-7 px-2"
              >
                {copied ? (
                  <Check className="h-3.5 w-3.5 text-green-500" />
                ) : (
                  <Copy className="h-3.5 w-3.5 text-gray-400" />
                )}
              </Button>
            </div>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500">예금주</span>
            <span className="font-medium text-gray-900">{bankInfo.account_holder}</span>
          </div>
        </div>
      </div>

      {/* 금액 요약 */}
      <div className="rounded-xl border bg-white p-4 space-y-2">
        <div className="flex justify-between text-sm">
          <span className="text-gray-500">상품 금액</span>
          <span className="text-gray-900">{formatCurrency(totalAmount)}</span>
        </div>
        {expressFee > 0 && (
          <div className="flex justify-between text-sm">
            <span className="text-gray-500">빠른출고 추가비용</span>
            <span className="text-orange-600">+{formatCurrency(expressFee)}</span>
          </div>
        )}
        <div className="border-t pt-2">
          <div className="flex justify-between">
            <span className="font-semibold text-gray-900">총 결제 금액</span>
            <span className="text-lg font-bold text-blue-600">
              {formatCurrency(grandTotal)}
            </span>
          </div>
        </div>
      </div>

      {/* 현금영수증 */}
      <div className="rounded-xl border bg-white p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Checkbox
            id="cash-receipt"
            checked={cashReceiptYn}
            onCheckedChange={(checked) => onCashReceiptChange(checked === true)}
          />
          <Label htmlFor="cash-receipt" className="text-sm font-medium cursor-pointer">
            현금영수증 발행
          </Label>
        </div>

        {cashReceiptYn && (
          <div className="space-y-3 pl-6">
            {/* 유형 선택 */}
            <div className="flex gap-2">
              {(Object.entries(BG_RECEIPT_TYPE_LABELS) as [string, string][]).map(
                ([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() =>
                      onReceiptTypeChange(key as 'personal' | 'business')
                    }
                    className={cn(
                      'flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition-colors',
                      receiptType === key
                        ? 'border-blue-500 bg-blue-50 text-blue-700'
                        : 'border-gray-200 text-gray-600 hover:bg-gray-50'
                    )}
                  >
                    {label}
                  </button>
                )
              )}
            </div>

            {/* 번호 입력 */}
            {receiptType && (
              <div className="space-y-1">
                <Label className="text-xs text-gray-600">
                  {receiptType === 'personal' ? '휴대폰번호' : '사업자번호'}
                </Label>
                <Input
                  type="tel"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  placeholder={
                    receiptType === 'personal'
                      ? '01012345678'
                      : '0000000000'
                  }
                  value={receiptNumber}
                  onChange={(e) =>
                    onReceiptNumberChange(e.target.value.replace(/\D/g, ''))
                  }
                  maxLength={receiptType === 'personal' ? 11 : 10}
                  className="h-9 text-sm"
                />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
