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
import { Plus, Search } from 'lucide-react';
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
            className="h-9 w-64 pl-9 text-sm"
          />
        </div>
        <Button size="sm" onClick={() => setDialogOpen(true)}>
          <Plus className="mr-1 h-3.5 w-3.5" />
          상품등록
        </Button>
      </div>

      <div className="rounded-md border bg-white">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="text-xs">상품코드</TableHead>
              <TableHead className="text-xs">상품명</TableHead>
              <TableHead className="text-xs">가격</TableHead>
              <TableHead className="text-xs">스티커상품</TableHead>
              <TableHead className="text-xs">상태</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {products.map((p) => (
              <TableRow key={p.id}>
                <TableCell className="font-mono text-xs">{p.product_code}</TableCell>
                <TableCell className="text-sm">{p.product_name}</TableCell>
                <TableCell className="text-sm">{p.price.toLocaleString()}원</TableCell>
                <TableCell>
                  {p.is_sticker_product && (
                    <Badge variant="secondary" className="text-[10px]">스티커</Badge>
                  )}
                </TableCell>
                <TableCell>
                  <Badge variant={p.is_active ? 'default' : 'secondary'} className="text-[10px]">
                    {p.is_active ? '활성' : '비활성'}
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
            {products.length === 0 && !loading && (
              <TableRow>
                <TableCell colSpan={5} className="h-24 text-center text-sm text-gray-500">
                  등록된 상품이 없습니다.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>상품 등록</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label className="text-xs">상품코드 *</Label>
              <Input
                value={form.product_code}
                onChange={(e) => setForm({ ...form, product_code: e.target.value })}
                className="text-sm"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs">상품명 *</Label>
              <Input
                value={form.product_name}
                onChange={(e) => setForm({ ...form, product_name: e.target.value })}
                className="text-sm"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs">가격</Label>
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
              <Label className="text-xs">스티커 상품</Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              취소
            </Button>
            <Button onClick={handleSubmit}>등록</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
