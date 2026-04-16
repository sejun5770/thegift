'use client';

import { Badge } from '@/components/ui/badge';
import { formatDateKorean, formatCurrency } from '@/lib/barungift/utils';
import { BG_SHIPPING_TYPE_LABELS, BG_RECEIPT_TYPE_LABELS } from '@/lib/barungift/constants';
import type { BgSticker, BgStickerSelection, BgBankInfo } from '@/lib/barungift/types';

interface OrderSummaryProps {
  isExpress: boolean;
  expressFee: number;
  desiredShipDate: string;
  stickerSelections: BgStickerSelection[];
  stickers: BgSticker[];
  cashReceiptYn: boolean;
  receiptType: 'personal' | 'business' | null;
  receiptNumber: string;
  totalAmount: number;
  bankInfo: BgBankInfo;
}

export function OrderSummary({
  isExpress,
  expressFee,
  desiredShipDate,
  stickerSelections,
  stickers,
  cashReceiptYn,
  receiptType,
  receiptNumber,
  totalAmount,
  bankInfo,
}: OrderSummaryProps) {
  const grandTotal = totalAmount + (isExpress ? expressFee : 0);

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-bold text-gray-900">입력 정보를 확인해주세요</h2>
      <p className="text-sm text-gray-500">
        아래 내용이 맞는지 확인 후 완료 버튼을 눌러주세요.
      </p>

      <div className="space-y-3">
        {/* 출고 방식 */}
        <SummaryCard title="출고 방식">
          <div className="flex items-center gap-2">
            <Badge variant={isExpress ? 'default' : 'secondary'}>
              {isExpress
                ? BG_SHIPPING_TYPE_LABELS.express
                : BG_SHIPPING_TYPE_LABELS.normal}
            </Badge>
            {isExpress && expressFee > 0 && (
              <span className="text-xs text-orange-600">
                (+{formatCurrency(expressFee)})
              </span>
            )}
          </div>
        </SummaryCard>

        {/* 희망 출고일 */}
        <SummaryCard title="희망 출고일">
          <span className="text-sm font-medium text-gray-900">
            {formatDateKorean(desiredShipDate)}
          </span>
        </SummaryCard>

        {/* 스티커 선택 */}
        <SummaryCard title="스티커">
          {stickerSelections.map((sel) => {
            const sticker = stickers.find((s) => s.id === sel.sticker_id);
            return (
              <div key={sel.product_id} className="space-y-1">
                <span className="text-sm font-medium text-gray-900">
                  {sticker?.name || '알 수 없는 스티커'}
                </span>
                {Object.entries(sel.custom_values).map(([fieldId, value]) => {
                  const field = sticker?.custom_fields.find(
                    (f) => f.field_id === fieldId
                  );
                  return (
                    <div key={fieldId} className="flex gap-2 text-xs text-gray-600">
                      <span>{field?.field_label || fieldId}:</span>
                      <span className="font-medium text-gray-800">{value}</span>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </SummaryCard>

        {/* 결제 정보 */}
        <SummaryCard title="결제 정보">
          <div className="space-y-1 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-500">입금 계좌</span>
              <span className="text-gray-900">
                {bankInfo.bank_name} {bankInfo.account_number}
              </span>
            </div>
            <div className="flex justify-between font-semibold">
              <span className="text-gray-700">총 금액</span>
              <span className="text-blue-600">{formatCurrency(grandTotal)}</span>
            </div>
          </div>
        </SummaryCard>

        {/* 현금영수증 */}
        {cashReceiptYn && (
          <SummaryCard title="현금영수증">
            <div className="space-y-1 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-500">유형</span>
                <span className="text-gray-900">
                  {receiptType ? BG_RECEIPT_TYPE_LABELS[receiptType] : '-'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">번호</span>
                <span className="font-mono text-gray-900">{receiptNumber || '-'}</span>
              </div>
            </div>
          </SummaryCard>
        )}
      </div>
    </div>
  );
}

function SummaryCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border bg-white p-4">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-400">
        {title}
      </h3>
      {children}
    </div>
  );
}
