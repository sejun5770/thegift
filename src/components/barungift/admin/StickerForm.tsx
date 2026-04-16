'use client';

import { useState } from 'react';
import { Plus, Trash2, GripVertical } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { BgSticker, BgStickerCustomField } from '@/lib/barungift/types';

interface StickerFormProps {
  sticker: BgSticker | null; // null = 생성 모드
  open: boolean;
  onClose: () => void;
  onSave: (data: Partial<BgSticker>) => Promise<void>;
}

function emptyField(): BgStickerCustomField {
  return {
    field_id: `field-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    field_label: '',
    field_type: 'text',
    max_length: 30,
    required: false,
    position: { x: 20, y: 20, w: 60, h: 10 },
  };
}

export function StickerForm({ sticker, open, onClose, onSave }: StickerFormProps) {
  const [name, setName] = useState(sticker?.name || '');
  const [previewImageUrl, setPreviewImageUrl] = useState(sticker?.preview_image_url || '');
  const [previewColor, setPreviewColor] = useState(sticker?.preview_color || '#FFFFFF');
  const [isActive, setIsActive] = useState(sticker?.is_active ?? true);
  const [customFields, setCustomFields] = useState<BgStickerCustomField[]>(
    sticker?.custom_fields || []
  );
  const [saving, setSaving] = useState(false);

  const addField = () => {
    setCustomFields((prev) => [...prev, emptyField()]);
  };

  const removeField = (index: number) => {
    setCustomFields((prev) => prev.filter((_, i) => i !== index));
  };

  const updateField = (index: number, updates: Partial<BgStickerCustomField>) => {
    setCustomFields((prev) =>
      prev.map((f, i) => (i === index ? { ...f, ...updates } : f))
    );
  };

  const handleSave = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await onSave({
        name,
        preview_image_url: previewImageUrl || null,
        preview_color: previewColor,
        is_active: isActive,
        custom_fields: customFields,
      });
      onClose();
    } catch {
      // error handled by parent
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{sticker ? '스티커 수정' : '스티커 생성'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-5 py-4">
          {/* 기본 정보 */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label className="text-xs">스티커명 *</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="클래식 감사 스티커"
                className="h-9 text-sm"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">배경색</Label>
              <div className="flex gap-2">
                <Input
                  type="color"
                  value={previewColor}
                  onChange={(e) => setPreviewColor(e.target.value)}
                  className="h-9 w-12 p-1"
                />
                <Input
                  value={previewColor}
                  onChange={(e) => setPreviewColor(e.target.value)}
                  placeholder="#FFFFFF"
                  className="h-9 text-sm font-mono"
                />
              </div>
            </div>
          </div>

          <div className="space-y-1">
            <Label className="text-xs">미리보기 이미지 URL</Label>
            <Input
              value={previewImageUrl}
              onChange={(e) => setPreviewImageUrl(e.target.value)}
              placeholder="https://example.com/sticker.png"
              className="h-9 text-sm"
            />
          </div>

          <div className="flex items-center gap-2">
            <Checkbox
              id="sticker-active"
              checked={isActive}
              onCheckedChange={(checked) => setIsActive(checked === true)}
            />
            <Label htmlFor="sticker-active" className="text-sm cursor-pointer">
              활성 상태
            </Label>
          </div>

          {/* 커스텀 영역 편집기 */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <Label className="text-sm font-semibold">커스텀 영역</Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addField}
              >
                <Plus className="mr-1 h-3 w-3" />
                영역 추가
              </Button>
            </div>

            <div className="space-y-3">
              {customFields.map((field, index) => (
                <div
                  key={field.field_id}
                  className="rounded-lg border bg-gray-50/50 p-3 space-y-2"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1 text-xs text-gray-400">
                      <GripVertical className="h-3 w-3" />
                      영역 {index + 1}
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => removeField(index)}
                      className="h-6 w-6 p-0 text-red-400 hover:text-red-600"
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>

                  <div className="grid grid-cols-3 gap-2">
                    <div className="space-y-1">
                      <Label className="text-[10px] text-gray-500">라벨</Label>
                      <Input
                        value={field.field_label}
                        onChange={(e) =>
                          updateField(index, { field_label: e.target.value })
                        }
                        placeholder="보내는 분"
                        className="h-8 text-xs"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-[10px] text-gray-500">유형</Label>
                      <Select
                        value={field.field_type}
                        onValueChange={(v) =>
                          updateField(index, {
                            field_type: v as 'text' | 'date' | 'select',
                          })
                        }
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="text">텍스트</SelectItem>
                          <SelectItem value="date">날짜</SelectItem>
                          <SelectItem value="select">선택</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-[10px] text-gray-500">최대 글자수</Label>
                      <Input
                        type="number"
                        value={field.max_length || ''}
                        onChange={(e) =>
                          updateField(index, {
                            max_length: parseInt(e.target.value) || undefined,
                          })
                        }
                        className="h-8 text-xs"
                      />
                    </div>
                  </div>

                  {/* Position */}
                  <div className="grid grid-cols-4 gap-2">
                    {(['x', 'y', 'w', 'h'] as const).map((key) => (
                      <div key={key} className="space-y-1">
                        <Label className="text-[10px] text-gray-500">
                          {key.toUpperCase()} (%)
                        </Label>
                        <Input
                          type="number"
                          min={0}
                          max={100}
                          value={field.position[key]}
                          onChange={(e) =>
                            updateField(index, {
                              position: {
                                ...field.position,
                                [key]: parseFloat(e.target.value) || 0,
                              },
                            })
                          }
                          className="h-8 text-xs"
                        />
                      </div>
                    ))}
                  </div>

                  <div className="flex items-center gap-2">
                    <Checkbox
                      id={`required-${field.field_id}`}
                      checked={field.required}
                      onCheckedChange={(checked) =>
                        updateField(index, { required: checked === true })
                      }
                    />
                    <Label
                      htmlFor={`required-${field.field_id}`}
                      className="text-xs cursor-pointer"
                    >
                      필수 입력
                    </Label>
                  </div>
                </div>
              ))}

              {customFields.length === 0 && (
                <p className="py-4 text-center text-sm text-gray-400">
                  커스텀 영역이 없습니다. 영역을 추가해주세요.
                </p>
              )}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            취소
          </Button>
          <Button onClick={handleSave} disabled={!name.trim() || saving}>
            {saving ? '저장 중...' : sticker ? '수정' : '생성'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
