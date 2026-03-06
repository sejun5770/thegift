'use client';

import { useState } from 'react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ArrowUpDown, ArrowUp, ArrowDown } from 'lucide-react';
import { HighlightBadges } from './highlight-badges';
import { ShippingMethodBadge } from './shipping-method-badge';
import { OrderStatusBadge } from './order-status-badge';
import { formatDateKo, formatDateTimeKo } from '@/lib/date-utils';
import { cn } from '@/lib/utils';
import type { OrderListItem } from '@/types/order';
import type { OrderTab } from '@/types/enums';

interface OrderTableProps {
  orders: OrderListItem[];
  currentTab: OrderTab;
  selectedIds: string[];
  onSelectionChange: (ids: string[]) => void;
  onOrderClick: (orderId: string) => void;
  sortBy: string;
  sortOrder: 'asc' | 'desc';
  onSort: (field: string) => void;
}

export function OrderTable({
  orders,
  currentTab,
  selectedIds,
  onSelectionChange,
  onOrderClick,
  sortBy,
  sortOrder,
  onSort,
}: OrderTableProps) {
  const allSelected = orders.length > 0 && selectedIds.length === orders.length;

  const toggleAll = () => {
    if (allSelected) {
      onSelectionChange([]);
    } else {
      onSelectionChange(orders.map((o) => o.id));
    }
  };

  const toggleOne = (id: string) => {
    if (selectedIds.includes(id)) {
      onSelectionChange(selectedIds.filter((i) => i !== id));
    } else {
      onSelectionChange([...selectedIds, id]);
    }
  };

  const SortButton = ({ field, label }: { field: string; label: string }) => (
    <Button
      variant="ghost"
      size="sm"
      className="-ml-3 h-8 text-xs font-medium"
      onClick={() => onSort(field)}
    >
      {label}
      {sortBy === field ? (
        sortOrder === 'asc' ? (
          <ArrowUp className="ml-1 h-3 w-3" />
        ) : (
          <ArrowDown className="ml-1 h-3 w-3" />
        )
      ) : (
        <ArrowUpDown className="ml-1 h-3 w-3 opacity-50" />
      )}
    </Button>
  );

  // 스티커 정보 표시 로직
  const getStickerDisplay = (item: OrderListItem) => {
    const orderItem = item.order_items?.[0];
    if (!orderItem) return { type1: '-', type2: '-', type3: '-' };

    const format = (name: string | null, qty: number) => {
      if (!name || name === '선택안함') return name || '-';
      return `${name}(${qty})`;
    };

    return {
      type1: format(orderItem.sticker_type1_name, orderItem.sticker_type1_quantity),
      type2: format(orderItem.sticker_type2_name, orderItem.sticker_type2_quantity),
      type3: format(orderItem.sticker_type3_name, orderItem.sticker_type3_quantity),
    };
  };

  // 상품수 표시 (복수구매: n/N)
  const getProductCountDisplay = (item: OrderListItem) => {
    if (item.display_item_index != null && item.display_item_total != null) {
      return `${item.display_item_index + 1}/${item.display_item_total}`;
    }
    return String(item.total_product_count || 1);
  };

  return (
    <div className="rounded-md border bg-white">
      <Table>
        <TableHeader>
          <TableRow className="bg-gray-50">
            <TableHead className="w-10">
              <Checkbox checked={allSelected} onCheckedChange={toggleAll} />
            </TableHead>
            <TableHead className="w-20 text-xs">하이라이트</TableHead>
            <TableHead className="w-16 text-xs">출고방식</TableHead>
            <TableHead className="w-28 text-xs">
              <SortButton field="order_number" label="주문번호" />
            </TableHead>
            <TableHead className="w-24 text-xs">
              <SortButton field="desired_shipping_date" label="희망출고일" />
            </TableHead>
            <TableHead className="w-14 text-xs">상품수</TableHead>
            <TableHead className="w-16 text-xs">수령인</TableHead>
            <TableHead className="min-w-[120px] text-xs">상품명</TableHead>
            <TableHead className="w-14 text-xs">주문수량</TableHead>
            <TableHead className="w-16 text-xs">박스타입</TableHead>
            <TableHead className="w-24 text-xs">스티커타입1</TableHead>
            <TableHead className="w-24 text-xs">스티커타입2</TableHead>
            <TableHead className="w-24 text-xs">스티커타입3</TableHead>
            <TableHead className="min-w-[100px] text-xs">입력메시지</TableHead>
            <TableHead className="min-w-[80px] text-xs">배송메시지</TableHead>
            <TableHead className="w-20 text-xs">관리자메모</TableHead>
            <TableHead className="w-16 text-xs">주문상태</TableHead>
            <TableHead className="w-28 text-xs">
              <SortButton field="collected_at" label="수집일시" />
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {orders.length === 0 ? (
            <TableRow>
              <TableCell colSpan={18} className="h-32 text-center text-sm text-gray-500">
                주문 내역이 없습니다.
              </TableCell>
            </TableRow>
          ) : (
            orders.map((order) => {
              const sticker = getStickerDisplay(order);
              const orderItem = order.order_items?.[0];

              return (
                <TableRow
                  key={order.id}
                  className={cn(
                    'cursor-pointer hover:bg-gray-50',
                    selectedIds.includes(order.id) && 'bg-blue-50'
                  )}
                >
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      checked={selectedIds.includes(order.id)}
                      onCheckedChange={() => toggleOne(order.id)}
                    />
                  </TableCell>
                  <TableCell>
                    <HighlightBadges highlights={order.highlights} />
                  </TableCell>
                  <TableCell>
                    <ShippingMethodBadge method={order.shipping_method} />
                  </TableCell>
                  <TableCell
                    className="font-mono text-xs text-blue-600 hover:underline"
                    onClick={() => onOrderClick(order.id)}
                  >
                    {order.order_number}
                    {order.order_source === 'admin' && (
                      <Badge variant="outline" className="ml-1 text-[9px] px-1 py-0">
                        A
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-xs">
                    {formatDateKo(order.desired_shipping_date)}
                  </TableCell>
                  <TableCell className="text-center text-xs">
                    {getProductCountDisplay(order)}
                  </TableCell>
                  <TableCell className="text-xs">{order.recipient_name}</TableCell>
                  <TableCell className="max-w-[200px] truncate text-xs">
                    {orderItem?.product_name || '-'}
                  </TableCell>
                  <TableCell className="text-center text-xs">
                    {orderItem?.quantity || '-'}
                  </TableCell>
                  <TableCell className="text-xs">
                    {orderItem?.box_type_name || '-'}
                  </TableCell>
                  <TableCell className="text-xs">{sticker.type1}</TableCell>
                  <TableCell className="text-xs">{sticker.type2}</TableCell>
                  <TableCell className="text-xs">{sticker.type3}</TableCell>
                  <TableCell className="max-w-[150px] truncate text-xs">
                    {orderItem?.input_message || '-'}
                  </TableCell>
                  <TableCell className="max-w-[120px] truncate text-xs">
                    {order.delivery_message || '-'}
                  </TableCell>
                  <TableCell className="max-w-[100px] truncate text-xs">
                    {order.latest_memo || '-'}
                  </TableCell>
                  <TableCell>
                    <OrderStatusBadge status={order.status} />
                  </TableCell>
                  <TableCell className="text-xs text-gray-500">
                    {formatDateTimeKo(order.collected_at)}
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
    </div>
  );
}
