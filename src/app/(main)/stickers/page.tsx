'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Plus, Sticker } from 'lucide-react';
import { toast } from 'sonner';
import type { StickerType } from '@/types/product';

export default function StickersPage() {
  const [stickers, setStickers] = useState<StickerType[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState({ sticker_code: '', sticker_name: '' });

  const fetchStickers = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/sticker-types');
      if (res.ok) setStickers(await res.json());
    } catch {
      toast.error('스티커 목록을 불러오는데 실패했습니다.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStickers();
  }, []);

  const handleSubmit = async () => {
    if (!form.sticker_code || !form.sticker_name) {
      toast.error('스티커코드와 스티커명을 입력해주세요.');
      return;
    }

    try {
      const res = await fetch('/api/sticker-types', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });

      if (res.ok) {
        toast.success('스티커가 등록되었습니다.');
        setDialogOpen(false);
        setForm({ sticker_code: '', sticker_name: '' });
        fetchStickers();
      } else {
        const err = await res.json();
        toast.error(err.error || '등록에 실패했습니다.');
      }
    } catch {
      toast.error('등록 중 오류가 발생했습니다.');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end">
        <Button size="sm" className="h-9" onClick={() => setDialogOpen(true)}>
          <Plus className="mr-1 h-3.5 w-3.5" />
          스티커등록
        </Button>
      </div>

      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
        <Table>
          <TableHeader>
            <TableRow className="bg-gray-50/80">
              <TableHead className="text-[11px] font-semibold text-gray-500">스티커코드</TableHead>
              <TableHead className="text-[11px] font-semibold text-gray-500">스티커명</TableHead>
              <TableHead className="text-[11px] font-semibold text-gray-500">상태</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {stickers.map((s, idx) => (
              <TableRow key={s.id} className={idx % 2 === 0 ? 'bg-white' : 'bg-gray-50/30'}>
                <TableCell className="font-mono text-xs text-gray-600">{s.sticker_code}</TableCell>
                <TableCell className="text-sm font-medium text-gray-800">{s.sticker_name}</TableCell>
                <TableCell>
                  <Badge
                    className={
                      s.is_active
                        ? 'border-green-200 bg-green-50 text-[10px] text-green-700'
                        : 'border-gray-200 bg-gray-100 text-[10px] text-gray-500'
                    }
                  >
                    {s.is_active ? '활성' : '비활성'}
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
            {stickers.length === 0 && !loading && (
              <TableRow>
                <TableCell colSpan={3} className="h-32 text-center">
                  <div className="flex flex-col items-center gap-2 text-gray-400">
                    <Sticker className="h-8 w-8" />
                    <span className="text-sm">등록된 스티커가 없습니다.</span>
                  </div>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base">스티커 등록</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-gray-600">스티커코드 *</Label>
              <Input
                value={form.sticker_code}
                onChange={(e) => setForm({ ...form, sticker_code: e.target.value })}
                placeholder="ST-LOGO"
                className="text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-gray-600">스티커명 *</Label>
              <Input
                value={form.sticker_name}
                onChange={(e) => setForm({ ...form, sticker_name: e.target.value })}
                placeholder="로고스티커"
                className="text-sm"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDialogOpen(false)}>취소</Button>
            <Button size="sm" onClick={handleSubmit}>등록</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
