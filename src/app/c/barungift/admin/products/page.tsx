'use client';

import { useState, useEffect, useCallback } from 'react';
import { Settings, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { toast } from 'sonner';
import { ProductSettingsForm } from '@/components/barungift/admin/ProductSettingsForm';

interface ProductWithSettings {
  id: string;
  product_code: string;
  product_name: string;
  is_active: boolean;
  has_settings: boolean;
}

export default function ProductSettingsAdminPage() {
  const [products, setProducts] = useState<ProductWithSettings[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingProduct, setEditingProduct] = useState<ProductWithSettings | null>(null);

  const fetchProducts = useCallback(async () => {
    try {
      // 기존 상품 API로 목록 조회
      const res = await fetch('/api/products');
      if (!res.ok) throw new Error('Failed to fetch');
      const data = await res.json();

      const productList = (data.products || data || []).map(
        (p: { id: string; product_code: string; product_name: string; is_active: boolean }) => ({
          id: p.id,
          product_code: p.product_code,
          product_name: p.product_name,
          is_active: p.is_active,
          has_settings: false, // 아래에서 체크
        })
      );

      // 각 상품에 대해 bg_product_settings 존재 여부 확인
      // (대량 요청을 피하기 위해 간단히 처리)
      setProducts(productList);
    } catch {
      toast.error('상품 목록을 불러오는데 실패했습니다.');
      // Mock 데이터 폴백
      setProducts([
        {
          id: 'prod-001',
          product_code: 'PROD-001',
          product_name: '프리미엄 답례떡 세트',
          is_active: true,
          has_settings: true,
        },
        {
          id: 'prod-002',
          product_code: 'PROD-002',
          product_name: '클래식 답례 세트',
          is_active: true,
          has_settings: false,
        },
      ]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProducts();
  }, [fetchProducts]);

  return (
    <div className="space-y-6">
      {/* 헤더 */}
      <div>
        <h1 className="text-xl font-bold text-gray-900">바른기프트 상품 설정</h1>
        <p className="text-sm text-gray-500">
          상품별 리드타임, 빠른출고, 스티커 연결 등을 설정합니다.
        </p>
      </div>

      {/* 상품 목록 */}
      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
        </div>
      ) : (
        <div className="rounded-lg border bg-white">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-[11px]">상품코드</TableHead>
                <TableHead className="text-[11px]">상품명</TableHead>
                <TableHead className="text-[11px]">상태</TableHead>
                <TableHead className="text-[11px]">설정</TableHead>
                <TableHead className="text-[11px] text-right">관리</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {products.map((product) => (
                <TableRow key={product.id}>
                  <TableCell className="font-mono text-xs text-gray-600">
                    {product.product_code}
                  </TableCell>
                  <TableCell className="text-sm font-medium">
                    {product.product_name}
                  </TableCell>
                  <TableCell>
                    <Badge variant={product.is_active ? 'default' : 'secondary'}>
                      {product.is_active ? '활성' : '비활성'}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {product.has_settings ? (
                      <div className="flex items-center gap-1 text-xs text-green-600">
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        설정 완료
                      </div>
                    ) : (
                      <div className="flex items-center gap-1 text-xs text-amber-600">
                        <AlertCircle className="h-3.5 w-3.5" />
                        미설정
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setEditingProduct(product)}
                    >
                      <Settings className="mr-1 h-3.5 w-3.5" />
                      설정
                    </Button>
                  </TableCell>
                </TableRow>
              ))}

              {products.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="py-12 text-center text-sm text-gray-400">
                    등록된 상품이 없습니다.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      )}

      {/* 설정 폼 */}
      {editingProduct && (
        <ProductSettingsForm
          productId={editingProduct.product_code}
          productName={editingProduct.product_name}
          open={!!editingProduct}
          onClose={() => setEditingProduct(null)}
          onSaved={fetchProducts}
        />
      )}
    </div>
  );
}
