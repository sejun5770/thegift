'use client';

import { useState } from 'react';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { StickerPreview } from './StickerPreview';
import type { BgSticker, BgStickerSelection } from '@/lib/barungift/types';

interface StickerSelectorProps {
  stickers: BgSticker[];
  productId: string;
  selection: BgStickerSelection | null;
  onSelect: (selection: BgStickerSelection) => void;
}

export function StickerSelector({
  stickers,
  productId,
  selection,
  onSelect,
}: StickerSelectorProps) {
  const [expandedId, setExpandedId] = useState<string | null>(
    selection?.sticker_id || null
  );

  const selectedSticker = stickers.find((s) => s.id === expandedId);
  const customValues = selection?.custom_values || {};

  const handleStickerClick = (stickerId: string) => {
    setExpandedId(stickerId);
    if (!selection || selection.sticker_id !== stickerId) {
      onSelect({
        product_id: productId,
        sticker_id: stickerId,
        custom_values: {},
      });
    }
  };

  const handleFieldChange = (fieldId: string, value: string) => {
    if (!expandedId) return;
    const newValues = { ...customValues, [fieldId]: value };
    onSelect({
      product_id: productId,
      sticker_id: expandedId,
      custom_values: newValues,
    });
  };

  const isAllRequiredFilled = () => {
    if (!selectedSticker) return false;
    return selectedSticker.custom_fields
      .filter((f) => f.required)
      .every((f) => customValues[f.field_id]?.trim());
  };

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-bold text-gray-900">스티커를 선택해주세요</h2>
      <p className="text-sm text-gray-500">
        원하시는 스티커를 선택하고, 내용을 입력해주세요.
      </p>

      {/* 스티커 카드 목록 */}
      <div className="grid grid-cols-3 gap-3">
        {stickers.map((sticker) => {
          const isSelected = expandedId === sticker.id;
          return (
            <button
              key={sticker.id}
              type="button"
              onClick={() => handleStickerClick(sticker.id)}
              className={cn(
                'relative rounded-xl border-2 p-2 transition-all',
                isSelected
                  ? 'border-blue-500 shadow-md'
                  : 'border-gray-200 hover:border-gray-300'
              )}
            >
              {isSelected && (
                <div className="absolute -right-1.5 -top-1.5 z-10 flex h-5 w-5 items-center justify-center rounded-full bg-blue-500">
                  <Check className="h-3 w-3 text-white" />
                </div>
              )}
              <div
                className="mb-1.5 aspect-[3/4] rounded-lg"
                style={{
                  backgroundColor: sticker.preview_color,
                  backgroundImage: sticker.preview_image_url
                    ? `url(${sticker.preview_image_url})`
                    : undefined,
                  backgroundSize: 'cover',
                }}
              />
              <p className="truncate text-xs font-medium text-gray-700">
                {sticker.name}
              </p>
            </button>
          );
        })}
      </div>

      {/* 선택된 스티커 미리보기 + 커스텀 입력 */}
      {selectedSticker && (
        <div className="mt-4 space-y-4 rounded-xl border bg-white p-4">
          <div className="flex gap-4">
            {/* 미리보기 */}
            <div className="w-1/3 shrink-0">
              <StickerPreview
                sticker={selectedSticker}
                customValues={customValues}
              />
            </div>

            {/* 커스텀 입력 필드 */}
            <div className="flex-1 space-y-3">
              <h3 className="text-sm font-semibold text-gray-800">
                {selectedSticker.name}
              </h3>

              {selectedSticker.custom_fields.map((field) => (
                <div key={field.field_id} className="space-y-1">
                  <Label className="text-xs text-gray-600">
                    {field.field_label}
                    {field.required && (
                      <span className="ml-0.5 text-red-500">*</span>
                    )}
                  </Label>

                  {field.field_type === 'select' ? (
                    <Select
                      value={customValues[field.field_id] || ''}
                      onValueChange={(v) => handleFieldChange(field.field_id, v)}
                    >
                      <SelectTrigger className="h-9 text-sm">
                        <SelectValue placeholder="선택해주세요" />
                      </SelectTrigger>
                      <SelectContent>
                        {(field.options || []).map((opt) => (
                          <SelectItem key={opt} value={opt}>
                            {opt}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input
                      type={field.field_type === 'date' ? 'date' : 'text'}
                      value={customValues[field.field_id] || ''}
                      onChange={(e) =>
                        handleFieldChange(field.field_id, e.target.value)
                      }
                      maxLength={field.max_length}
                      placeholder={field.field_label}
                      className="h-9 text-sm"
                    />
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* 입력 완료 상태 표시 */}
          {selectedSticker.custom_fields.some((f) => f.required) && (
            <div
              className={cn(
                'rounded-lg px-3 py-2 text-center text-xs font-medium',
                isAllRequiredFilled()
                  ? 'bg-green-50 text-green-700'
                  : 'bg-amber-50 text-amber-700'
              )}
            >
              {isAllRequiredFilled()
                ? '✓ 모든 필수 항목이 입력되었습니다'
                : '* 필수 항목을 모두 입력해주세요'}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
