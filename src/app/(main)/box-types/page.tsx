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
import { Plus, Box } from 'lucide-react';
import { toast } from 'sonner';
import type { BoxType } from '@/types/product';

export default function BoxTypesPage() {
  const [boxTypes, setBoxTypes] = useState<BoxType[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState({ box_code: '', box_name: '' });

  const fetchBoxTypes = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/box-types');
      if (res.ok) setBoxTypes(await res.json());
    } catch {
      toast.error('박스타입 목록을 불러오는데 실패했습니다.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchBoxTypes();
  }, []);

  const handleSubmit = async () => {
    if (!form.box_code || !form.box_name) {
      toast.error('박스코드와 박스명을 입력해주세요.');
      return;
    }

    try {
      const res = await fetch('/api/box-types', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });

      if (res.ok) {
        toast.success('박스타입이 등록되었습니다.');
        setDialogOpen(false);
        setForm({ box_code: '', box_name: '' });
        fetchBoxTypes();
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
          박스타입등록
        </Button>
      </div>

      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
        <Table>
          <TableHeader>
            <TableRow className="bg-gray-50/80">
              <TableHead className="text-[11px] font-semibold text-gray-500">박스코드</TableHead>
              <TableHead className="text-[11px] font-semibold text-gray-500">박스명</TableHead>
              <TableHead className="text-[11px] font-semibold text-gray-500">상태</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {boxTypes.map((b, idx) => (
              <TableRow key={b.id} className={idx % 2 === 0 ? 'bg-white' : 'bg-gray-50/30'}>
                <TableCell className="font-mono text-xs text-gray-600">{b.box_code}</TableCell>
                <TableCell className="text-sm font-medium text-gray-800">{b.box_name}</TableCell>
                <TableCell>
                  <Badge
                    className={
                      b.is_active
                        ? 'border-green-200 bg-green-50 text-[10px] text-green-700'
                        : 'border-gray-200 bg-gray-100 text-[10px] text-gray-500'
                    }
                  >
                    {b.is_active ? '활성' : '비활성'}
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
            {boxTypes.length === 0 && !loading && (
              <TableRow>
                <TableCell colSpan={3} className="h-32 text-center">
                  <div className="flex flex-col items-center gap-2 text-gray-400">
                    <Box className="h-8 w-8" />
                    <span className="text-sm">등록된 박스타입이 없습니다.</span>
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
            <DialogTitle className="text-base">박스타입 등록</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-gray-600">박스코드 *</Label>
              <Input
                value={form.box_code}
                onChange={(e) => setForm({ ...form, box_code: e.target.value })}
                placeholder="BOX-STD"
                className="text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-gray-600">박스명 *</Label>
              <Input
                value={form.box_name}
                onChange={(e) => setForm({ ...form, box_name: e.target.value })}
                placeholder="일반박스"
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
