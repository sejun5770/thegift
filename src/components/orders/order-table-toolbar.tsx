'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Search, Plus, ChevronDown, CheckCircle2, XCircle } from 'lucide-react';
import { ORDER_STATUS_LABELS, VALID_STATUS_TRANSITIONS } from '@/lib/constants';
import type { OrderStatus, OrderTab } from '@/types/enums';
import { Textarea } from '@/components/ui/textarea';

interface OrderTableToolbarProps {
  search: string;
  onSearchChange: (search: string) => void;
  selectedCount: number;
  currentTab: OrderTab;
  onBulkStatusChange: (status: OrderStatus, reason?: string) => void;
  onManualOrderClick: () => void;
}

export function OrderTableToolbar({
  search,
  onSearchChange,
  selectedCount,
  currentTab,
  onBulkStatusChange,
  onManualOrderClick,
}: OrderTableToolbarProps) {
  const [confirmDialog, setConfirmDialog] = useState<{
    open: boolean;
    status: OrderStatus | null;
    showReason: boolean;
  }>({ open: false, status: null, showReason: false });
  const [reason, setReason] = useState('');

  // 현재 탭 기준 가능한 상태 변경 옵션
  const getAvailableTransitions = (): OrderStatus[] => {
    if (currentTab === 'all') return [];
    const tabStatus = currentTab as OrderStatus;
    return VALID_STATUS_TRANSITIONS[tabStatus] || [];
  };

  const transitions = getAvailableTransitions();

  const handleStatusClick = (status: OrderStatus) => {
    setConfirmDialog({
      open: true,
      status,
      showReason: status === 'validation_failed',
    });
  };

  const handleConfirm = () => {
    if (confirmDialog.status) {
      onBulkStatusChange(confirmDialog.status, reason || undefined);
    }
    setConfirmDialog({ open: false, status: null, showReason: false });
    setReason('');
  };

  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {/* 검색 */}
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-gray-400" />
            <Input
              placeholder="주문번호, 수령인 검색"
              value={search}
              onChange={(e) => onSearchChange(e.target.value)}
              className="h-9 w-64 pl-9 text-sm"
            />
          </div>

          {/* 일괄 상태변경 */}
          {selectedCount > 0 && transitions.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="h-9">
                  선택 {selectedCount}건 처리
                  <ChevronDown className="ml-1 h-3 w-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {transitions.map((status) => (
                  <DropdownMenuItem
                    key={status}
                    onClick={() => handleStatusClick(status)}
                  >
                    {status === 'validation_failed' ? (
                      <XCircle className="mr-2 h-3.5 w-3.5 text-orange-500" />
                    ) : (
                      <CheckCircle2 className="mr-2 h-3.5 w-3.5 text-green-500" />
                    )}
                    {ORDER_STATUS_LABELS[status]}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        {/* 수동 주문 등록 */}
        <Button size="sm" className="h-9" onClick={onManualOrderClick}>
          <Plus className="mr-1 h-3.5 w-3.5" />
          수동주문등록
        </Button>
      </div>

      {/* 확인 다이얼로그 */}
      <AlertDialog
        open={confirmDialog.open}
        onOpenChange={(open) => {
          if (!open) {
            setConfirmDialog({ open: false, status: null, showReason: false });
            setReason('');
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              선택한 {selectedCount}건을{' '}
              {confirmDialog.status && ORDER_STATUS_LABELS[confirmDialog.status]}
              (으)로 변경하시겠습니까?
            </AlertDialogTitle>
            <AlertDialogDescription>
              이 작업은 되돌릴 수 없습니다.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {confirmDialog.showReason && (
            <div className="space-y-2">
              <label className="text-sm font-medium">검증실패 사유</label>
              <Textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="검증실패 사유를 입력하세요"
                rows={3}
              />
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>취소</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirm}>확인</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
