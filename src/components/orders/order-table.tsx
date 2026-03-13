'use client';

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
      className="-ml-3 h-7 text-[11px] font-semibold text-gray-500 hover:text-gray-900"
      onClick={() => onSort(field)}
    >
      {label}
      {sortBy === field ? (
        sortOrder === 'asc' ? (
          <ArrowUp className="ml-0.5 h-3 w-3" />
        ) : (
          <ArrowDown className="ml-0.5 h-3 w-3" />
        )
      ) : (
        <ArrowUpDown className="ml-0.5 h-3 w-3 opacity-30" />
      )}
    </Button>
  );

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

  const getProductCountDisplay = (item: OrderListItem) => {
    if (item.display_item_index != null && item.display_item_total != null) {
      return `${item.display_item_index + 1}/${item.display_item_total}`;
    }
    return String(item.total_product_count || 1);
  };

  return (
    <div className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow className="border-b border-gray-200 bg-gray-50/80">
              <TableHead className="w-10 px-3">
                <Checkbox checked={allSelected} onCheckedChange={toggleAll} />
              </TableHead>
              <TableHead className="w-[90px] text-[11px] font-semibold text-gray-500">하이라이트</TableHead>
              <TableHead className="w-16 text-[11px] font-semibold text-gray-500">출고방식</TableHead>
              <TableHead className="w-28 text-[11px] font-semibold text-gray-500">
                <SortButton field="order_number" label="주문번호" />
              </TableHead>
              <TableHead className="w-24 text-[11px] font-semibold text-gray-500">
                <SortButton field="desired_shipping_date" label="희망출고일" />
              </TableHead>
              <TableHead className="w-12 text-center text-[11px] font-semibold text-gray-500">상품수</TableHead>
              <TableHead className="w-16 text-[11px] font-semibold text-gray-500">수령인</TableHead>
              <TableHead className="min-w-[120px] text-[11px] font-semibold text-gray-500">상품명</TableHead>
              <TableHead className="w-12 text-center text-[11px] font-semibold text-gray-500">수량</TableHead>
              <TableHead className="w-16 text-[11px] font-semibold text-gray-500">박스타입</TableHead>
              <TableHead className="w-24 text-[11px] font-semibold text-gray-500">스티커1</TableHead>
              <TableHead className="w-24 text-[11px] font-semibold text-gray-500">스티커2</TableHead>
              <TableHead className="w-24 text-[11px] font-semibold text-gray-500">스티커3</TableHead>
              <TableHead className="min-w-[100px] text-[11px] font-semibold text-gray-500">입력메시지</TableHead>
              <TableHead className="min-w-[80px] text-[11px] font-semibold text-gray-500">배송메시지</TableHead>
              <TableHead className="w-20 text-[11px] font-semibold text-gray-500">관리자메모</TableHead>
              <TableHead className="w-28 text-[11px] font-semibold text-gray-500">
                <SortButton field="collected_at" label="수집일시" />
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {orders.length === 0 ? (
              <TableRow>
                <TableCell colSpan={17} className="h-32 text-center">
                  <div className="flex flex-col items-center gap-1">
                    <span className="text-sm text-gray-400">주문 내역이 없습니다.</span>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              orders.map((order, idx) => {
                const sticker = getStickerDisplay(order);
                const orderItem = order.order_items?.[0];
                const isSelected = selectedIds.includes(order.id);

                return (
                  <TableRow
                    key={order.id}
                    className={cn(
                      'cursor-pointer border-b border-gray-100 transition-colors',
                      isSelected
                        ? 'bg-blue-50/70'
                        : idx % 2 === 0
                        ? 'bg-white hover:bg-gray-50'
                        : 'bg-gray-50/30 hover:bg-gray-50'
                    )}
                  >
                    <TableCell className="px-3" onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={isSelected}
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
                      className="font-mono text-xs font-medium text-blue-600 hover:text-blue-800 hover:underline"
                      onClick={() => onOrderClick(order.id)}
                    >
                      {order.order_number}
                      {order.order_source === 'admin' && (
                        <Badge variant="outline" className="ml-1 h-4 border-amber-300 bg-amber-50 px-1 py-0 text-[8px] font-bold text-amber-700">
                          A
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-xs tabular-nums text-gray-700">
                      {formatDateKo(order.desired_shipping_date)}
                    </TableCell>
                    <TableCell className="text-center text-xs tabular-nums text-gray-600">
                      {getProductCountDisplay(order)}
                    </TableCell>
                    <TableCell className="text-xs font-medium text-gray-800">{order.recipient_name}</TableCell>
                    <TableCell className="max-w-[200px] truncate text-xs text-gray-600">
                      {orderItem?.product_name || '-'}
                    </TableCell>
                    <TableCell className="text-center text-xs tabular-nums text-gray-600">
                      {orderItem?.quantity || '-'}
                    </TableCell>
                    <TableCell className="text-xs text-gray-600">
                      {orderItem?.box_type_name || '-'}
                    </TableCell>
                    <TableCell className="text-xs text-gray-600">{sticker.type1}</TableCell>
                    <TableCell className="text-xs text-gray-500">{sticker.type2}</TableCell>
                    <TableCell className="text-xs text-gray-500">{sticker.type3}</TableCell>
                    <TableCell className="max-w-[150px] truncate text-xs text-gray-600">
                      {orderItem?.input_message || '-'}
                    </TableCell>
                    <TableCell className="max-w-[120px] truncate text-xs text-gray-500">
                      {order.delivery_message || '-'}
                    </TableCell>
                    <TableCell className="max-w-[100px] truncate text-xs text-gray-500">
                      {order.latest_memo || '-'}
                    </TableCell>
                    <TableCell className="text-xs text-gray-400 tabular-nums">
                      {formatDateTimeKo(order.collected_at)}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
