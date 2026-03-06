'use client';

import { useState, useEffect, useCallback, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { OrderTable } from '@/components/orders/order-table';
import { OrderTableToolbar } from '@/components/orders/order-table-toolbar';
import { OrderDetailDialog } from '@/components/orders/order-detail-dialog';
import { ORDER_TABS } from '@/lib/constants';
import { toast } from 'sonner';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { OrderTab, OrderStatus } from '@/types/enums';
import type { OrderListItem } from '@/types/order';

export default function OrdersPageWrapper() {
  return (
    <Suspense fallback={<div className="p-8 text-center text-sm text-gray-500">로딩중...</div>}>
      <OrdersPage />
    </Suspense>
  );
}

function OrdersPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [currentTab, setCurrentTab] = useState<OrderTab>(
    (searchParams.get('tab') as OrderTab) || 'all'
  );
  const [orders, setOrders] = useState<OrderListItem[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [search, setSearch] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [sortBy, setSortBy] = useState('collected_at');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [loading, setLoading] = useState(true);
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [tabCounts, setTabCounts] = useState<Record<string, number>>({});

  const fetchOrders = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        tab: currentTab,
        page: String(page),
        limit: '50',
        sort_by: sortBy,
        sort_order: sortOrder,
      });
      if (search) params.set('search', search);

      // URL 파라미터에서 날짜 필터
      const dateType = searchParams.get('date_type');
      const startDate = searchParams.get('start_date');
      const endDate = searchParams.get('end_date');
      const month = searchParams.get('month');

      if (dateType) params.set('date_type', dateType);
      if (startDate) params.set('start_date', startDate);
      if (endDate) params.set('end_date', endDate);
      if (month) {
        params.set('date_type', 'desired_shipping_date');
        params.set('start_date', `${month}-01`);
        const [y, m] = month.split('-').map(Number);
        const lastDay = new Date(y, m, 0).getDate();
        params.set('end_date', `${month}-${String(lastDay).padStart(2, '0')}`);
      }

      const res = await fetch(`/api/orders?${params}`);
      if (res.ok) {
        const data = await res.json();
        setOrders(data.orders);
        setTotalCount(data.total);
        setTotalPages(data.totalPages);
      }
    } catch (error) {
      console.error('Error fetching orders:', error);
    } finally {
      setLoading(false);
    }
  }, [currentTab, page, search, sortBy, sortOrder, searchParams]);

  // 탭별 건수 조회
  const fetchTabCounts = useCallback(async () => {
    try {
      const counts: Record<string, number> = {};
      for (const tab of ORDER_TABS) {
        const params = new URLSearchParams({ tab: tab.value, limit: '1' });
        const res = await fetch(`/api/orders?${params}`);
        if (res.ok) {
          const data = await res.json();
          counts[tab.value] = data.total;
        }
      }
      setTabCounts(counts);
    } catch {
      // 무시
    }
  }, []);

  useEffect(() => {
    fetchOrders();
  }, [fetchOrders]);

  useEffect(() => {
    fetchTabCounts();
  }, [fetchTabCounts]);

  const handleTabChange = (tab: string) => {
    setCurrentTab(tab as OrderTab);
    setPage(1);
    setSelectedIds([]);
    router.push(`/orders?tab=${tab}`);
  };

  const handleSort = (field: string) => {
    if (sortBy === field) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(field);
      setSortOrder('desc');
    }
  };

  const handleBulkStatusChange = async (status: OrderStatus, reason?: string) => {
    try {
      const res = await fetch('/api/orders/bulk-status', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderIds: selectedIds, newStatus: status, reason }),
      });

      if (res.ok) {
        const data = await res.json();
        toast.success(`${data.summary.success}건 처리 완료`);
        if (data.summary.failed > 0) {
          toast.error(`${data.summary.failed}건 처리 실패`);
        }
        setSelectedIds([]);
        fetchOrders();
        fetchTabCounts();
      }
    } catch {
      toast.error('처리 중 오류가 발생했습니다.');
    }
  };

  // 검색 디바운스
  useEffect(() => {
    const timer = setTimeout(() => {
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  return (
    <div className="space-y-4">
      {/* 탭 */}
      <Tabs value={currentTab} onValueChange={handleTabChange}>
        <TabsList className="h-auto flex-wrap gap-1 bg-transparent p-0">
          {ORDER_TABS.map((tab) => (
            <TabsTrigger
              key={tab.value}
              value={tab.value}
              className="data-[state=active]:bg-gray-900 data-[state=active]:text-white"
            >
              {tab.label}
              {tabCounts[tab.value] != null && (
                <Badge
                  variant="secondary"
                  className="ml-1.5 h-5 min-w-[20px] px-1.5 text-[10px]"
                >
                  {tabCounts[tab.value]}
                </Badge>
              )}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {/* 툴바 */}
      <OrderTableToolbar
        search={search}
        onSearchChange={setSearch}
        selectedCount={selectedIds.length}
        currentTab={currentTab}
        onBulkStatusChange={handleBulkStatusChange}
        onManualOrderClick={() => router.push('/orders/new')}
      />

      {/* 주문 테이블 */}
      <OrderTable
        orders={orders}
        currentTab={currentTab}
        selectedIds={selectedIds}
        onSelectionChange={setSelectedIds}
        onOrderClick={(id) => setSelectedOrderId(id)}
        sortBy={sortBy}
        sortOrder={sortOrder}
        onSort={handleSort}
      />

      {/* 페이지네이션 */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <span className="text-sm text-gray-500">
            총 {totalCount.toLocaleString()}건
          </span>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="px-3 text-sm">
              {page} / {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => setPage(page + 1)}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {loading && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-white/50">
          <div className="text-sm text-gray-500">로딩중...</div>
        </div>
      )}

      {/* 주문 상세 다이얼로그 */}
      {selectedOrderId && (
        <OrderDetailDialog
          orderId={selectedOrderId}
          open={!!selectedOrderId}
          onClose={() => {
            setSelectedOrderId(null);
            fetchOrders();
          }}
          editable={currentTab === 'collected' || currentTab === 'all'}
        />
      )}
    </div>
  );
}
