'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
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
import { Plus, Search, Package } from 'lucide-react';
import { toast } from 'sonner';
import type { Product } from '@/types/product';

export default function ProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState({
    product_code: '',
    product_name: '',
    price: 0,
    is_sticker_product: false,
  });

  const fetchProducts = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (search) params.set('search', search);
      const res = await fetch(`/api/products?${params}`);
      if (res.ok) {
        setProducts(await res.json());
      }
    } catch {
      toast.error('상품 목록을 불러오는데 실패했습니다.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchProducts();
  }, [search]);

  const handleSubmit = async () => {
    if (!form.product_code || !form.product_name) {
      toast.error('상품코드와 상품명을 입력해주세요.');
      return;
    }

    try {
      const res = await fetch('/api/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });

      if (res.ok) {
        toast.success('상품이 등록되었습니다.');
        setDialogOpen(false);
        setForm({ product_code: '', product_name: '', price: 0, is_sticker_product: false });
        fetchProducts();
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
      <div className="flex items-center justify-between">
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-gray-400" />
          <Input
            placeholder="상품명, 상품코드 검색"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-9 w-72 pl-9 text-sm"
          />
        </div>
        <Button size="sm" className="h-9" onClick={() => setDialogOpen(true)}>
          <Plus className="mr-1 h-3.5 w-3.5" />
          상품등록
        </Button>
      </div>

      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
        <Table>
          <TableHeader>
            <TableRow className="bg-gray-50/80">
              <TableHead className="text-[11px] font-semibold text-gray-500">상품코드</TableHead>
              <TableHead className="text-[11px] font-semibold text-gray-500">상품명</TableHead>
              <TableHead className="text-[11px] font-semibold text-gray-500">가격</TableHead>
              <TableHead className="text-[11px] font-semibold text-gray-500">스티커상품</TableHead>
              <TableHead className="text-[11px] font-semibold text-gray-500">상태</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {products.map((p, idx) => (
              <TableRow key={p.id} className={idx % 2 === 0 ? 'bg-white' : 'bg-gray-50/30'}>
                <TableCell className="font-mono text-xs text-gray-600">{p.product_code}</TableCell>
                <TableCell className="text-sm font-medium text-gray-800">{p.product_name}</TableCell>
                <TableCell className="text-sm tabular-nums text-gray-700">{p.price.toLocaleString()}원</TableCell>
                <TableCell>
                  {p.is_sticker_product && (
                    <Badge variant="secondary" className="border-amber-200 bg-amber-50 text-[10px] text-amber-700">스티커</Badge>
                  )}
                </TableCell>
                <TableCell>
                  <Badge
                    className={
                      p.is_active
                        ? 'border-green-200 bg-green-50 text-[10px] text-green-700'
                        : 'border-gray-200 bg-gray-100 text-[10px] text-gray-500'
                    }
                  >
                    {p.is_active ? '활성' : '비활성'}
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
            {products.length === 0 && !loading && (
              <TableRow>
                <TableCell colSpan={5} className="h-32 text-center">
                  <div className="flex flex-col items-center gap-2 text-gray-400">
                    <Package className="h-8 w-8" />
                    <span className="text-sm">등록된 상품이 없습니다.</span>
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
            <DialogTitle className="text-base">상품 등록</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-gray-600">상품코드 *</Label>
              <Input
                value={form.product_code}
                onChange={(e) => setForm({ ...form, product_code: e.target.value })}
                placeholder="PB-A4-001"
                className="text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-gray-600">상품명 *</Label>
              <Input
                value={form.product_name}
                onChange={(e) => setForm({ ...form, product_name: e.target.value })}
                placeholder="프리미엄 포토북 A4"
                className="text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-gray-600">가격</Label>
              <Input
                type="number"
                value={form.price}
                onChange={(e) => setForm({ ...form, price: Number(e.target.value) })}
                className="text-sm"
              />
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                checked={form.is_sticker_product}
                onCheckedChange={(v) => setForm({ ...form, is_sticker_product: !!v })}
              />
              <Label className="text-xs text-gray-600">스티커 상품</Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDialogOpen(false)}>
              취소
            </Button>
            <Button size="sm" onClick={handleSubmit}>등록</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
