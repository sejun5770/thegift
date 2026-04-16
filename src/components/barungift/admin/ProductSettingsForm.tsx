'use client';

import { useState, useEffect } from 'react';
import { Loader2 } from 'lucide-react';
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
import { Calendar } from '@/components/ui/calendar';
import { ko } from 'date-fns/locale';
import { parseISO, format } from 'date-fns';
import { toast } from 'sonner';
import type { BgProductSettings, BgSticker } from '@/lib/barungift/types';

interface ProductSettingsFormProps {
  productId: string;
  productName: string;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}

export function ProductSettingsForm({
  productId,
  productName,
  open,
  onClose,
  onSaved,
}: ProductSettingsFormProps) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [stickers, setStickers] = useState<BgSticker[]>([]);

  // 설정 필드
  const [leadTimeDays, setLeadTimeDays] = useState(5);
  const [expressAvailable, setExpressAvailable] = useState(false);
  const [expressFee, setExpressFee] = useState(0);
  const [expressCutoffTime, setExpressCutoffTime] = useState('14:00');
  const [availableStickerIds, setAvailableStickerIds] = useState<string[]>([]);
  const [blackoutDates, setBlackoutDates] = useState<Date[]>([]);
  const [maxSelectDays, setMaxSelectDays] = useState(60);

  // 기존 데이터 로드
  useEffect(() => {
    async function fetchData() {
      try {
        const [settingsRes, stickersRes] = await Promise.all([
          fetch(`/c/barungift/api/products/${productId}/settings`),
          fetch('/c/barungift/api/stickers?active_only=true'),
        ]);

        const settingsData = await settingsRes.json();
        const stickersData = await stickersRes.json();

        setStickers(stickersData.stickers || []);

        const settings: BgProductSettings | null = settingsData.settings;
        if (settings) {
          setLeadTimeDays(settings.lead_time_days);
          setExpressAvailable(settings.express_available);
          setExpressFee(settings.express_fee);
          setExpressCutoffTime(settings.express_cutoff_time);
          setAvailableStickerIds(settings.available_sticker_ids);
          setBlackoutDates(
            (settings.blackout_dates || []).map((d) => parseISO(d))
          );
          setMaxSelectDays(settings.max_select_days);
        }
      } catch {
        toast.error('설정을 불러오는데 실패했습니다.');
      } finally {
        setLoading(false);
      }
    }

    if (open) fetchData();
  }, [productId, open]);

  const toggleStickerId = (id: string) => {
    setAvailableStickerIds((prev) =>
      prev.includes(id) ? prev.filter((i) => i !== id) : [...prev, id]
    );
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const body = {
        lead_time_days: leadTimeDays,
        express_available: expressAvailable,
        express_fee: expressFee,
        express_cutoff_time: expressCutoffTime,
        available_sticker_ids: availableStickerIds,
        blackout_dates: blackoutDates.map((d) => format(d, 'yyyy-MM-dd')),
        max_select_days: maxSelectDays,
      };

      const res = await fetch(`/c/barungift/api/products/${productId}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await res.json();
        toast.error(err.error || '저장에 실패했습니다.');
        return;
      }

      toast.success('상품 설정이 저장되었습니다.');
      onSaved();
      onClose();
    } catch {
      toast.error('저장에 실패했습니다.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>상품 설정: {productName}</DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="flex justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
          </div>
        ) : (
          <div className="space-y-6 py-4">
            {/* 리드타임 */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label className="text-xs">리드타임 (영업일)</Label>
                <Input
                  type="number"
                  min={1}
                  max={90}
                  value={leadTimeDays}
                  onChange={(e) => setLeadTimeDays(parseInt(e.target.value) || 5)}
                  className="h-9 text-sm"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">최대 선택 기간 (일)</Label>
                <Input
                  type="number"
                  min={1}
                  max={365}
                  value={maxSelectDays}
                  onChange={(e) => setMaxSelectDays(parseInt(e.target.value) || 60)}
                  className="h-9 text-sm"
                />
              </div>
            </div>

            {/* 빠른출고 설정 */}
            <div className="rounded-lg border p-4 space-y-3">
              <div className="flex items-center gap-2">
                <Checkbox
                  id="express-available"
                  checked={expressAvailable}
                  onCheckedChange={(checked) => setExpressAvailable(checked === true)}
                />
                <Label htmlFor="express-available" className="text-sm font-medium cursor-pointer">
                  빠른출고 가능
                </Label>
              </div>

              {expressAvailable && (
                <div className="grid grid-cols-2 gap-4 pl-6">
                  <div className="space-y-1">
                    <Label className="text-xs">추가비용 (원)</Label>
                    <Input
                      type="number"
                      min={0}
                      step={1000}
                      value={expressFee}
                      onChange={(e) => setExpressFee(parseInt(e.target.value) || 0)}
                      className="h-9 text-sm"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">컷오프 시간</Label>
                    <Input
                      type="time"
                      value={expressCutoffTime}
                      onChange={(e) => setExpressCutoffTime(e.target.value)}
                      className="h-9 text-sm"
                    />
                  </div>
                </div>
              )}
            </div>

            {/* 스티커 연결 */}
            <div className="space-y-2">
              <Label className="text-sm font-semibold">사용 가능 스티커</Label>
              {stickers.length === 0 ? (
                <p className="text-sm text-gray-400">
                  등록된 스티커가 없습니다. 먼저 스티커를 생성해주세요.
                </p>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  {stickers.map((sticker) => (
                    <div
                      key={sticker.id}
                      className="flex items-center gap-2 rounded-lg border p-2"
                    >
                      <Checkbox
                        id={`sticker-${sticker.id}`}
                        checked={availableStickerIds.includes(sticker.id)}
                        onCheckedChange={() => toggleStickerId(sticker.id)}
                      />
                      <div
                        className="h-6 w-5 shrink-0 rounded border"
                        style={{ backgroundColor: sticker.preview_color }}
                      />
                      <Label
                        htmlFor={`sticker-${sticker.id}`}
                        className="text-xs cursor-pointer"
                      >
                        {sticker.name}
                      </Label>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* 블랙아웃 날짜 */}
            <div className="space-y-2">
              <Label className="text-sm font-semibold">
                블랙아웃 날짜 ({blackoutDates.length}일 선택)
              </Label>
              <p className="text-xs text-gray-500">
                출고 불가 날짜를 클릭하여 선택/해제합니다.
              </p>
              <div className="flex justify-center">
                <Calendar
                  mode="multiple"
                  selected={blackoutDates}
                  onSelect={(dates) => setBlackoutDates(dates || [])}
                  locale={ko}
                  className="rounded-lg border bg-white p-3"
                />
              </div>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            취소
          </Button>
          <Button onClick={handleSave} disabled={saving || loading}>
            {saving ? '저장 중...' : '설정 저장'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
