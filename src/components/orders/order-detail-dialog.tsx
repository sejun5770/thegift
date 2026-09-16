'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Calendar } from '@/components/ui/calendar';
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
import { Trash2, Send, CheckCircle2, Clock } from 'lucide-react';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { ko } from 'date-fns/locale';
import { HighlightBadges } from './highlight-badges';
import { OrderStatusBadge } from './order-status-badge';
import { formatDateTimeKo } from '@/lib/date-utils';
import type { Order, OrderHistory } from '@/types/order';
import type { HighlightType } from '@/types/enums';
import type { CustomerInfoDetail } from '@/app/api/orders/[orderId]/customer-info/route';

// ─── EditableField — 컴포넌트 외부 정의 (깜빡임 방지) ─────────────
interface EditableFieldProps {
  label: string;
  field: string;
  value: string;
  editable: boolean;
  editingField: string | null;
  editValues: Record<string, string>;
  onEdit: (field: string, value: string) => void;
  onCancel: () => void;
  onSave: (field: string, value: string) => void;
  onChange: (field: string, value: string) => void;
}

function EditableField({
  label,
  field,
  value,
  editable,
  editingField,
  editValues,
  onEdit,
  onCancel,
  onSave,
  onChange,
}: EditableFieldProps) {
  if (!editable) {
    return (
      <div>
        <Label className="text-xs text-gray-500">{label}</Label>
        <p className="mt-1 text-sm">{value || '-'}</p>
      </div>
    );
  }

  if (editingField === field) {
    return (
      <div>
        <Label className="text-xs text-gray-500">{label}</Label>
        <div className="mt-1 flex gap-1">
          <Input
            value={editValues[field] ?? value}
            onChange={(e) => onChange(field, e.target.value)}
            className="h-8 text-sm"
          />
          <Button
            size="sm"
            className="h-8"
            onClick={() => onSave(field, editValues[field] ?? value)}
          >
            저장
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-8"
            onClick={onCancel}
          >
            취소
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="cursor-pointer rounded p-1 hover:bg-gray-50"
      onClick={() => onEdit(field, value)}
    >
      <Label className="text-xs text-gray-500">{label}</Label>
      <p className="mt-1 text-sm">{value || '-'}</p>
    </div>
  );
}

// ─── 메인 컴포넌트 ────────────────────────────────────────────────
interface OrderDetailDialogProps {
  orderId: string;
  open: boolean;
  onClose: () => void;
  editable?: boolean;
}

export function OrderDetailDialog({
  orderId,
  open,
  onClose,
  editable = false,
}: OrderDetailDialogProps) {
  const [order, setOrder] = useState<Order | null>(null);
  const [history, setHistory] = useState<OrderHistory[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingField, setEditingField] = useState<string | null>(null);
  const [editValues, setEditValues] = useState<Record<string, string>>({});
  const [newMemo, setNewMemo] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [customerInfo, setCustomerInfo] = useState<CustomerInfoDetail | null | 'loading'>('loading');

  const fetchOrder = useCallback(async () => {
    try {
      const res = await fetch(`/api/orders/${orderId}`);
      if (res.ok) {
        const data = await res.json();
        setOrder(data);
        setHistory(data.history || []);
      }
    } catch {
      toast.error('주문 정보를 불러오는데 실패했습니다.');
    } finally {
      setLoading(false);
    }
  }, [orderId]);

  const fetchCustomerInfo = useCallback(async () => {
    setCustomerInfo('loading');
    try {
      const res = await fetch(`/api/orders/${orderId}/customer-info`);
      if (res.ok) {
        const data = await res.json();
        setCustomerInfo(data); // null이면 미입력 상태
      } else {
        setCustomerInfo(null);
      }
    } catch {
      setCustomerInfo(null);
    }
  }, [orderId]);

  useEffect(() => {
    if (open && orderId) {
      setLoading(true);
      fetchOrder();
      fetchCustomerInfo();
    }
  }, [open, orderId, fetchOrder, fetchCustomerInfo]);

  const handleFieldUpdate = async (field: string, value: string) => {
    if (!order) return;

    const oldValue = (order as unknown as Record<string, unknown>)[field];
    try {
      const res = await fetch(`/api/orders/${orderId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ field, value, old_value: oldValue }),
      });

      if (res.ok) {
        toast.success('수정되었습니다.');
        setEditingField(null);
        fetchOrder();
      } else {
        const err = await res.json();
        toast.error(err.error || '수정에 실패했습니다.');
      }
    } catch {
      toast.error('수정 중 오류가 발생했습니다.');
    }
  };

  const handleDateChange = async (date: Date | undefined) => {
    if (!date || !order) return;
    const formatted = format(date, 'yyyy-MM-dd');

    try {
      const res = await fetch(`/api/orders/${orderId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          field: 'desired_shipping_date',
          value: formatted,
          old_value: order.desired_shipping_date,
        }),
      });

      if (res.ok) {
        toast.success('희망출고일이 변경되었습니다.');
        fetchOrder();
      }
    } catch {
      toast.error('변경 중 오류가 발생했습니다.');
    }
  };

  const handleIncidentToggle = async () => {
    if (!order) return;

    try {
      const res = await fetch(`/api/orders/${orderId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          field: 'is_incident',
          value: !order.is_incident,
          old_value: order.is_incident,
        }),
      });

      if (res.ok) {
        toast.success(
          order.is_incident ? '사고건이 해제되었습니다.' : '사고건으로 등록되었습니다.'
        );
        fetchOrder();
      }
    } catch {
      toast.error('처리 중 오류가 발생했습니다.');
    }
  };

  const handleAddMemo = async () => {
    if (!newMemo.trim()) return;

    try {
      const res = await fetch(`/api/orders/${orderId}/memo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memo_text: newMemo }),
      });

      if (res.ok) {
        toast.success('메모가 추가되었습니다.');
        setNewMemo('');
        fetchOrder();
      }
    } catch {
      toast.error('메모 추가에 실패했습니다.');
    }
  };

  const handleDeleteMemo = async (memoId: string) => {
    try {
      const res = await fetch(`/api/orders/${orderId}/memo`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memo_id: memoId }),
      });

      if (res.ok) {
        toast.success('메모가 삭제되었습니다.');
        fetchOrder();
      }
    } catch {
      toast.error('메모 삭제에 실패했습니다.');
    }
  };

  const handleDeleteOrder = async () => {
    try {
      const res = await fetch(`/api/orders/${orderId}`, {
        method: 'DELETE',
      });

      if (res.ok) {
        toast.success('주문이 삭제되었습니다.');
        onClose();
      } else {
        const err = await res.json();
        toast.error(err.error);
      }
    } catch {
      toast.error('삭제 중 오류가 발생했습니다.');
    }
  };

  // EditableField에 내려줄 핸들러 (안정적인 참조를 위해 인라인 사용)
  const handleEdit = (field: string, value: string) => {
    setEditingField(field);
    setEditValues((prev) => ({ ...prev, [field]: value }));
  };
  const handleCancelEdit = () => setEditingField(null);
  const handleEditChange = (field: string, value: string) => {
    setEditValues((prev) => ({ ...prev, [field]: value }));
  };

  if (loading || !order) {
    return (
      <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="max-w-4xl">
          <div className="flex h-64 items-center justify-center">
            <span className="text-sm text-gray-500">로딩중...</span>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  const shippingDateValue = order.desired_shipping_date
    ? new Date(order.desired_shipping_date)
    : undefined;

  return (
    <>
      <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="max-h-[90vh] max-w-4xl overflow-hidden p-0">
          <DialogHeader className="border-b px-6 py-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <DialogTitle className="text-lg">
                  주문 상세 - {order.order_number}
                </DialogTitle>
                {order.order_source === 'admin' && (
                  <Badge variant="outline">관리자 등록</Badge>
                )}
                <OrderStatusBadge status={order.status} />
              </div>
              <HighlightBadges highlights={((order as unknown as { highlights: HighlightType[] }).highlights) || []} />
            </div>
          </DialogHeader>

          <ScrollArea className="max-h-[calc(90vh-80px)]">
            <div className="space-y-6 p-6">
              <Tabs defaultValue="info">
                <TabsList>
                  <TabsTrigger value="info">기본정보</TabsTrigger>
                  <TabsTrigger value="items">주문상품</TabsTrigger>
                  <TabsTrigger value="shipping">배송정보</TabsTrigger>
                  <TabsTrigger value="customer-input" className="flex items-center gap-1">
                    고객입력
                    {customerInfo && customerInfo !== 'loading' && (
                      <CheckCircle2 className="h-3 w-3 text-green-500" />
                    )}
                    {customerInfo === null && (
                      <Clock className="h-3 w-3 text-gray-400" />
                    )}
                  </TabsTrigger>
                  <TabsTrigger value="memo">메모</TabsTrigger>
                  <TabsTrigger value="history">이력</TabsTrigger>
                </TabsList>

                {/* 기본정보 */}
                <TabsContent value="info" className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <Label className="text-xs text-gray-500">주문번호</Label>
                      <p className="mt-1 text-sm font-medium">{order.order_number}</p>
                    </div>
                    <div>
                      <Label className="text-xs text-gray-500">
                        {order.order_source === 'admin' ? '등록일시' : '수집일시'}
                      </Label>
                      <p className="mt-1 text-sm">{formatDateTimeKo(order.collected_at)}</p>
                    </div>
                  </div>

                  <Separator />

                  {/* 희망출고일 — 인라인 캘린더 */}
                  <div className="space-y-2">
                    <Label className="text-xs text-gray-500">희망출고일</Label>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">
                        {order.desired_shipping_date || '-'}
                      </span>
                      {order.original_desired_shipping_date &&
                        order.original_desired_shipping_date !== order.desired_shipping_date && (
                          <span className="text-xs text-orange-600">
                            (변경전: {order.original_desired_shipping_date})
                          </span>
                        )}
                    </div>
                    {editable && (
                      <Calendar
                        mode="single"
                        selected={shippingDateValue}
                        onSelect={handleDateChange}
                        locale={ko}
                        className="rounded-lg border w-fit"
                      />
                    )}
                  </div>

                  <Separator />

                  {/* 수령인 정보 */}
                  <h4 className="text-sm font-semibold">수령인 정보</h4>
                  <div className="grid grid-cols-2 gap-4">
                    <EditableField
                      label="수령인"
                      field="recipient_name"
                      value={order.recipient_name}
                      editable={editable}
                      editingField={editingField}
                      editValues={editValues}
                      onEdit={handleEdit}
                      onCancel={handleCancelEdit}
                      onSave={handleFieldUpdate}
                      onChange={handleEditChange}
                    />
                    <EditableField
                      label="연락처"
                      field="recipient_phone"
                      value={order.recipient_phone || ''}
                      editable={editable}
                      editingField={editingField}
                      editValues={editValues}
                      onEdit={handleEdit}
                      onCancel={handleCancelEdit}
                      onSave={handleFieldUpdate}
                      onChange={handleEditChange}
                    />
                  </div>
                  <EditableField
                    label="배송지"
                    field="recipient_address"
                    value={order.recipient_address || ''}
                    editable={editable}
                    editingField={editingField}
                    editValues={editValues}
                    onEdit={handleEdit}
                    onCancel={handleCancelEdit}
                    onSave={handleFieldUpdate}
                    onChange={handleEditChange}
                  />
                  <EditableField
                    label="배송메시지"
                    field="delivery_message"
                    value={order.delivery_message || ''}
                    editable={editable}
                    editingField={editingField}
                    editValues={editValues}
                    onEdit={handleEdit}
                    onCancel={handleCancelEdit}
                    onSave={handleFieldUpdate}
                    onChange={handleEditChange}
                  />

                  <Separator />

                  {/* 사고건 */}
                  <div className="flex items-center gap-2">
                    <Checkbox
                      checked={order.is_incident}
                      onCheckedChange={editable ? handleIncidentToggle : undefined}
                      disabled={!editable}
                    />
                    <Label className="text-sm">사고주문</Label>
                  </div>

                  {/* 관리자 주문 삭제 */}
                  {order.order_source === 'admin' && editable && (
                    <>
                      <Separator />
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => setConfirmDelete(true)}
                      >
                        <Trash2 className="mr-1 h-3.5 w-3.5" />
                        주문 삭제
                      </Button>
                    </>
                  )}
                </TabsContent>

                {/* 주문상품 */}
                <TabsContent value="items" className="space-y-4">
                  {(order.order_items || []).map((item, idx) => (
                    <div key={item.id} className="rounded-lg border p-4">
                      <div className="flex items-center justify-between">
                        <h4 className="text-sm font-semibold">
                          상품 {idx + 1}: {item.product_name}
                        </h4>
                        {item.product_code && (
                          <Badge variant="outline" className="text-xs">
                            {item.product_code}
                          </Badge>
                        )}
                      </div>
                      <div className="mt-3 grid grid-cols-3 gap-4 text-sm">
                        <div>
                          <span className="text-xs text-gray-500">수량</span>
                          <p>{item.quantity}</p>
                        </div>
                        <div>
                          <span className="text-xs text-gray-500">박스타입</span>
                          <p>{item.box_type_name || '-'}</p>
                        </div>
                        <div>
                          <span className="text-xs text-gray-500">금액</span>
                          <p>{item.item_price?.toLocaleString() || 0}원</p>
                        </div>
                      </div>
                      <Separator className="my-3" />
                      <div className="space-y-2">
                        <span className="text-xs font-medium text-gray-500">스티커 정보</span>
                        <div className="grid grid-cols-3 gap-3 text-sm">
                          <div>
                            <span className="text-xs text-gray-400">타입1</span>
                            <p>{item.sticker_type1_name || '-'} ({item.sticker_type1_quantity})</p>
                          </div>
                          <div>
                            <span className="text-xs text-gray-400">타입2</span>
                            <p>{item.sticker_type2_name || '-'} ({item.sticker_type2_quantity})</p>
                          </div>
                          <div>
                            <span className="text-xs text-gray-400">타입3</span>
                            <p>{item.sticker_type3_name || '-'} ({item.sticker_type3_quantity})</p>
                          </div>
                        </div>
                      </div>
                      {item.input_message && (
                        <>
                          <Separator className="my-3" />
                          <div>
                            <span className="text-xs text-gray-500">입력메시지</span>
                            <p className="mt-1 text-sm whitespace-pre-wrap">
                              {item.input_message}
                            </p>
                          </div>
                        </>
                      )}
                    </div>
                  ))}
                  {(!order.order_items || order.order_items.length === 0) && (
                    <p className="text-center text-sm text-gray-500 py-8">
                      주문상품이 없습니다.
                    </p>
                  )}
                </TabsContent>

                {/* 배송정보 */}
                <TabsContent value="shipping" className="space-y-4">
                  {/* 기본 배송지 */}
                  <div className="rounded-lg border p-4">
                    <div className="flex items-center gap-2">
                      <h4 className="text-sm font-semibold">기본 배송지</h4>
                      <Badge variant="secondary" className="text-[10px]">기본</Badge>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
                      <div>
                        <span className="text-xs text-gray-500">수령인</span>
                        <p>{order.recipient_name}</p>
                      </div>
                      <div>
                        <span className="text-xs text-gray-500">연락처</span>
                        <p>{order.recipient_phone || '-'}</p>
                      </div>
                      <div className="col-span-2">
                        <span className="text-xs text-gray-500">주소</span>
                        <p>{order.recipient_address || '-'}</p>
                      </div>
                    </div>
                  </div>

                  {/* 추가 배송지 (나눔배송) */}
                  {(order.order_shipping_addresses || [])
                    .filter((addr) => !addr.is_primary)
                    .map((addr, idx) => (
                      <div key={addr.id} className="rounded-lg border p-4">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <h4 className="text-sm font-semibold">
                              배송지 {idx + 2}
                            </h4>
                            <Badge variant="outline" className="text-[10px] bg-green-50 text-green-700">
                              나눔
                            </Badge>
                          </div>
                        </div>
                        <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
                          <div>
                            <span className="text-xs text-gray-500">수령인</span>
                            <p>{addr.recipient_name}</p>
                          </div>
                          <div>
                            <span className="text-xs text-gray-500">연락처</span>
                            <p>{addr.recipient_phone || '-'}</p>
                          </div>
                          <div className="col-span-2">
                            <span className="text-xs text-gray-500">주소</span>
                            <p>{addr.recipient_address}</p>
                          </div>
                          <div>
                            <span className="text-xs text-gray-500">수량</span>
                            <p>{addr.quantity}</p>
                          </div>
                          {addr.tracking_number && (
                            <div>
                              <span className="text-xs text-gray-500">운송장번호</span>
                              <p>{addr.tracking_number}</p>
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                </TabsContent>

                {/* 고객입력 */}
                <TabsContent value="customer-input">
                  {customerInfo === 'loading' && (
                    <div className="flex h-32 items-center justify-center text-sm text-gray-400">
                      불러오는 중...
                    </div>
                  )}
                  {customerInfo === null && (
                    <div className="flex h-32 flex-col items-center justify-center gap-2 text-center">
                      <Clock className="h-8 w-8 text-gray-300" />
                      <p className="text-sm text-gray-400">아직 고객이 정보를 입력하지 않았습니다.</p>
                    </div>
                  )}
                  {customerInfo && customerInfo !== 'loading' && (
                    <div className="space-y-4">
                      {/* 제출 완료 배너 */}
                      <div className="flex items-center gap-2 rounded-lg bg-green-50 px-4 py-2.5">
                        <CheckCircle2 className="h-4 w-4 shrink-0 text-green-500" />
                        <span className="text-sm font-medium text-green-700">
                          고객 입력 완료
                        </span>
                        <span className="ml-auto text-xs text-green-600">
                          {formatDateTimeKo(customerInfo.submitted_at)}
                        </span>
                      </div>

                      {/* 출고 방식 */}
                      <div className="rounded-lg border p-4 space-y-3">
                        <h4 className="text-sm font-semibold text-gray-700">출고 방식</h4>
                        <div className="flex items-center gap-3">
                          <span className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ${
                            customerInfo.is_express
                              ? 'bg-orange-100 text-orange-700'
                              : 'bg-gray-100 text-gray-600'
                          }`}>
                            {customerInfo.is_express ? '⚡ 빠른출고' : '일반출고'}
                          </span>
                          {customerInfo.is_express && customerInfo.express_fee > 0 && (
                            <span className="text-xs text-gray-500">
                              추가금 +{customerInfo.express_fee.toLocaleString()}원
                            </span>
                          )}
                        </div>
                        {customerInfo.desired_ship_date && (
                          <div>
                            <span className="text-xs text-gray-500">희망출고일</span>
                            <p className="mt-0.5 text-sm font-medium">{customerInfo.desired_ship_date}</p>
                          </div>
                        )}
                      </div>

                      {/* 스티커 선택 */}
                      {customerInfo.sticker_selections_detail.length > 0 && (
                        <div className="rounded-lg border p-4 space-y-3">
                          <h4 className="text-sm font-semibold text-gray-700">스티커 선택</h4>
                          {customerInfo.sticker_selections_detail.map((sel, idx) => (
                            <div key={idx} className="space-y-2">
                              <div className="flex items-center gap-2">
                                <Badge variant="secondary" className="text-xs">{sel.sticker_name}</Badge>
                              </div>
                              {sel.custom_values_formatted.length > 0 && (
                                <div className="ml-1 space-y-1">
                                  {sel.custom_values_formatted.map((cv) => (
                                    <div key={cv.label} className="flex gap-2 text-sm">
                                      <span className="min-w-[80px] text-xs text-gray-500">{cv.label}</span>
                                      <span className="font-medium">{cv.value}</span>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}

                      {/* 현금영수증 */}
                      <div className="rounded-lg border p-4 space-y-2">
                        <h4 className="text-sm font-semibold text-gray-700">현금영수증</h4>
                        {customerInfo.cash_receipt_yn ? (
                          <div className="space-y-1 text-sm">
                            <div className="flex gap-2">
                              <span className="text-xs text-gray-500">구분</span>
                              <span className="font-medium">
                                {customerInfo.receipt_type === 'business' ? '사업자' : '개인'}
                              </span>
                            </div>
                            <div className="flex gap-2">
                              <span className="text-xs text-gray-500">번호</span>
                              <span className="font-medium font-mono">{customerInfo.receipt_number}</span>
                            </div>
                          </div>
                        ) : (
                          <p className="text-sm text-gray-400">신청 안함</p>
                        )}
                      </div>
                    </div>
                  )}
                </TabsContent>

                {/* 메모 */}
                <TabsContent value="memo" className="space-y-4">
                  <div className="flex gap-2">
                    <Textarea
                      value={newMemo}
                      onChange={(e) => setNewMemo(e.target.value)}
                      placeholder="관리자 메모를 입력하세요"
                      rows={2}
                      className="text-sm"
                    />
                    <Button
                      size="sm"
                      className="h-auto"
                      onClick={handleAddMemo}
                      disabled={!newMemo.trim()}
                    >
                      <Send className="h-4 w-4" />
                    </Button>
                  </div>

                  {(order.admin_memos || []).map((memo) => (
                    <div
                      key={memo.id}
                      className="flex items-start justify-between rounded-lg border p-3"
                    >
                      <div>
                        <p className="text-sm whitespace-pre-wrap">{memo.memo_text}</p>
                        <p className="mt-1 text-xs text-gray-400">
                          {formatDateTimeKo(memo.created_at)}
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0 text-gray-400 hover:text-red-500"
                        onClick={() => handleDeleteMemo(memo.id)}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  ))}

                  {(!order.admin_memos || order.admin_memos.length === 0) && (
                    <p className="text-center text-sm text-gray-500 py-4">
                      메모가 없습니다.
                    </p>
                  )}
                </TabsContent>

                {/* 이력 */}
                <TabsContent value="history" className="space-y-2">
                  {history.map((h) => (
                    <div
                      key={h.id}
                      className="flex items-start gap-3 rounded-lg border p-3 text-sm"
                    >
                      <div className="flex-1">
                        <p className="font-medium">{h.description || h.action}</p>
                        {h.old_value && h.new_value && (
                          <p className="mt-0.5 text-xs text-gray-500">
                            {h.old_value} → {h.new_value}
                          </p>
                        )}
                      </div>
                      <span className="text-xs text-gray-400 whitespace-nowrap">
                        {formatDateTimeKo(h.performed_at)}
                      </span>
                    </div>
                  ))}

                  {history.length === 0 && (
                    <p className="text-center text-sm text-gray-500 py-4">
                      이력이 없습니다.
                    </p>
                  )}
                </TabsContent>
              </Tabs>
            </div>
          </ScrollArea>
        </DialogContent>
      </Dialog>

      {/* 삭제 확인 */}
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>주문을 삭제하시겠습니까?</AlertDialogTitle>
            <AlertDialogDescription>
              이 작업은 되돌릴 수 없습니다. 관리자 주문만 삭제할 수 있습니다.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>취소</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteOrder}>삭제</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

    </>
  );
}
