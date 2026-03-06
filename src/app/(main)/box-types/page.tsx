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
import { Plus } from 'lucide-react';
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
        <Button size="sm" onClick={() => setDialogOpen(true)}>
          <Plus className="mr-1 h-3.5 w-3.5" />
          박스타입등록
        </Button>
      </div>

      <div className="rounded-md border bg-white">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="text-xs">박스코드</TableHead>
              <TableHead className="text-xs">박스명</TableHead>
              <TableHead className="text-xs">상태</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {boxTypes.map((b) => (
              <TableRow key={b.id}>
                <TableCell className="font-mono text-xs">{b.box_code}</TableCell>
                <TableCell className="text-sm">{b.box_name}</TableCell>
                <TableCell>
                  <Badge variant={b.is_active ? 'default' : 'secondary'} className="text-[10px]">
                    {b.is_active ? '활성' : '비활성'}
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
            {boxTypes.length === 0 && !loading && (
              <TableRow>
                <TableCell colSpan={3} className="h-24 text-center text-sm text-gray-500">
                  등록된 박스타입이 없습니다.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>박스타입 등록</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label className="text-xs">박스코드 *</Label>
              <Input
                value={form.box_code}
                onChange={(e) => setForm({ ...form, box_code: e.target.value })}
                className="text-sm"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs">박스명 *</Label>
              <Input
                value={form.box_name}
                onChange={(e) => setForm({ ...form, box_name: e.target.value })}
                className="text-sm"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>취소</Button>
            <Button onClick={handleSubmit}>등록</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
