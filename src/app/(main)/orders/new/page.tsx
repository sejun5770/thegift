'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Calendar } from '@/components/ui/calendar';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { CalendarIcon, Plus, Trash2, ArrowLeft, Search } from 'lucide-react';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { ko } from 'date-fns/locale';
import { cn } from '@/lib/utils';
import { SHIPPING_METHOD_LABELS } from '@/lib/constants';
import type { ShippingMethod } from '@/types/enums';

interface OrderItemForm {
  product_name: string;
  product_code: string;
  quantity: number;
  item_price: number;
  box_type_name: string;
  sticker_type1_name: string;
  sticker_type1_quantity: number;
  sticker_type2_name: string;
  sticker_type2_quantity: number;
  sticker_type3_name: string;
  sticker_type3_quantity: number;
  input_message: string;
}

const emptyItem: OrderItemForm = {
  product_name: '',
  product_code: '',
  quantity: 1,
  item_price: 0,
  box_type_name: '',
  sticker_type1_name: '',
  sticker_type1_quantity: 0,
  sticker_type2_name: '',
  sticker_type2_quantity: 0,
  sticker_type3_name: '',
  sticker_type3_quantity: 0,
  input_message: '',
};

export default function NewOrderPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [lookupNumber, setLookupNumber] = useState('');

  // 주문 기본 정보
  const [orderNumber, setOrderNumber] = useState('');
  const [desiredShippingDate, setDesiredShippingDate] = useState<Date | undefined>();
  const [recipientName, setRecipientName] = useState('');
  const [recipientPhone, setRecipientPhone] = useState('');
  const [recipientAddress, setRecipientAddress] = useState('');
  const [recipientZipcode, setRecipientZipcode] = useState('');
  const [deliveryMessage, setDeliveryMessage] = useState('');
  const [shippingMethod, setShippingMethod] = useState<ShippingMethod>('parcel');
  const [orderAmount, setOrderAmount] = useState(0);
  const [isIncident, setIsIncident] = useState(false);
  const [memo, setMemo] = useState('');

  // 주문 상품
  const [items, setItems] = useState<OrderItemForm[]>([{ ...emptyItem }]);

  const addItem = () => {
    setItems([...items, { ...emptyItem }]);
  };

  const removeItem = (index: number) => {
    if (items.length <= 1) return;
    setItems(items.filter((_, i) => i !== index));
  };

  const updateItem = (index: number, field: keyof OrderItemForm, value: string | number) => {
    const updated = [...items];
    updated[index] = { ...updated[index], [field]: value };
    setItems(updated);
  };

  // 기존 주문번호로 조회
  const handleLookup = async () => {
    if (!lookupNumber.trim()) return;

    try {
      const res = await fetch(`/api/orders?search=${lookupNumber}&limit=1`);
      if (res.ok) {
        const data = await res.json();
        if (data.orders.length > 0) {
          const found = data.orders[0];
          setOrderNumber(found.order_number);
          setRecipientName(found.recipient_name);
          setRecipientPhone(found.recipient_phone || '');
          setRecipientAddress(found.recipient_address || '');
          setRecipientZipcode(found.recipient_zipcode || '');
          setDeliveryMessage(found.delivery_message || '');
          setShippingMethod(found.shipping_method);
          if (found.desired_shipping_date) {
            setDesiredShippingDate(new Date(found.desired_shipping_date));
          }
          toast.success('주문 정보를 불러왔습니다.');
        } else {
          toast.error('주문을 찾을 수 없습니다.');
        }
      }
    } catch {
      toast.error('조회 중 오류가 발생했습니다.');
    }
  };

  const handleSubmit = async () => {
    // 필수 정보 체크
    if (!orderNumber.trim()) {
      toast.error('주문번호를 입력해주세요.');
      return;
    }
    if (!desiredShippingDate) {
      toast.error('희망출고일을 선택해주세요.');
      return;
    }
    if (!recipientName.trim()) {
      toast.error('수령인을 입력해주세요.');
      return;
    }
    if (items.some((item) => !item.product_name.trim())) {
      toast.error('상품명을 입력해주세요.');
      return;
    }

    // 스티커 수량 체크
    for (const item of items) {
      const stickerCount =
        (item.sticker_type2_name ? 1 : 0) + (item.sticker_type3_name ? 1 : 0);
      if (stickerCount > 0) {
        const total =
          item.sticker_type1_quantity +
          item.sticker_type2_quantity +
          item.sticker_type3_quantity;
        if (total !== item.quantity) {
          toast.error(
            `상품 "${item.product_name}"의 스티커 수량 합계(${total})가 주문수량(${item.quantity})과 일치하지 않습니다.`
          );
          return;
        }
      }
    }

    setLoading(true);
    try {
      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          order_number: orderNumber,
          desired_shipping_date: format(desiredShippingDate, 'yyyy-MM-dd'),
          recipient_name: recipientName,
          recipient_phone: recipientPhone,
          recipient_address: recipientAddress,
          recipient_zipcode: recipientZipcode,
          delivery_message: deliveryMessage,
          shipping_method: shippingMethod,
          order_amount: orderAmount,
          is_incident: isIncident,
          memo: memo || undefined,
          items: items.map((item) => ({
            ...item,
            sticker_type1_quantity: item.sticker_type1_name
              ? item.sticker_type1_quantity || item.quantity
              : 0,
          })),
        }),
      });

      if (res.ok) {
        toast.success('주문이 등록되었습니다.');
        router.push('/orders?tab=collected');
      } else {
        const err = await res.json();
        toast.error(err.error || '등록에 실패했습니다.');
      }
    } catch {
      toast.error('등록 중 오류가 발생했습니다.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.back()}
        >
          <ArrowLeft className="mr-1 h-4 w-4" />
          돌아가기
        </Button>
        <h2 className="text-lg font-semibold">수동 주문 등록</h2>
      </div>

      {/* 기존 주문 조회 */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">주문번호 조회</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex gap-2">
            <Input
              value={lookupNumber}
              onChange={(e) => setLookupNumber(e.target.value)}
              placeholder="기존 주문번호를 입력하여 정보 불러오기"
              className="text-sm"
            />
            <Button variant="outline" size="sm" onClick={handleLookup}>
              <Search className="mr-1 h-3.5 w-3.5" />
              조회
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* 기본 정보 */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">기본 정보</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label className="text-xs">주문번호 *</Label>
              <Input
                value={orderNumber}
                onChange={(e) => setOrderNumber(e.target.value)}
                placeholder="주문번호 입력"
                className="text-sm"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs">희망출고일 *</Label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    className={cn(
                      'w-full justify-start text-left font-normal text-sm',
                      !desiredShippingDate && 'text-muted-foreground'
                    )}
                  >
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {desiredShippingDate
                      ? format(desiredShippingDate, 'yyyy.MM.dd', { locale: ko })
                      : '날짜 선택'}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={desiredShippingDate}
                    onSelect={setDesiredShippingDate}
                    locale={ko}
                  />
                </PopoverContent>
              </Popover>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label className="text-xs">수령인 *</Label>
              <Input
                value={recipientName}
                onChange={(e) => setRecipientName(e.target.value)}
                className="text-sm"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs">연락처</Label>
              <Input
                value={recipientPhone}
                onChange={(e) => setRecipientPhone(e.target.value)}
                className="text-sm"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label className="text-xs">배송지</Label>
            <Input
              value={recipientAddress}
              onChange={(e) => setRecipientAddress(e.target.value)}
              className="text-sm"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label className="text-xs">출고방식</Label>
              <Select
                value={shippingMethod}
                onValueChange={(v) => setShippingMethod(v as ShippingMethod)}
              >
                <SelectTrigger className="text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(SHIPPING_METHOD_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label className="text-xs">주문금액</Label>
              <Input
                type="number"
                value={orderAmount}
                onChange={(e) => setOrderAmount(Number(e.target.value))}
                className="text-sm"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label className="text-xs">배송메시지</Label>
            <Input
              value={deliveryMessage}
              onChange={(e) => setDeliveryMessage(e.target.value)}
              className="text-sm"
            />
          </div>

          <div className="flex items-center gap-2">
            <Checkbox
              checked={isIncident}
              onCheckedChange={(v) => setIsIncident(!!v)}
            />
            <Label className="text-xs">사고주문</Label>
          </div>
        </CardContent>
      </Card>

      {/* 주문 상품 */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-3">
          <CardTitle className="text-sm">주문 상품</CardTitle>
          <Button variant="outline" size="sm" onClick={addItem}>
            <Plus className="mr-1 h-3.5 w-3.5" />
            상품추가
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {items.map((item, idx) => (
            <div key={idx} className="space-y-3 rounded-lg border p-4">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">상품 {idx + 1}</span>
                {items.length > 1 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 text-gray-400 hover:text-red-500"
                    onClick={() => removeItem(idx)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1">
                  <Label className="text-[11px]">상품명 *</Label>
                  <Input
                    value={item.product_name}
                    onChange={(e) => updateItem(idx, 'product_name', e.target.value)}
                    className="h-8 text-xs"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-[11px]">상품코드</Label>
                  <Input
                    value={item.product_code}
                    onChange={(e) => updateItem(idx, 'product_code', e.target.value)}
                    className="h-8 text-xs"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-[11px]">주문수량</Label>
                  <Input
                    type="number"
                    value={item.quantity}
                    onChange={(e) => updateItem(idx, 'quantity', Number(e.target.value))}
                    className="h-8 text-xs"
                    min={1}
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-[11px]">박스타입</Label>
                  <Input
                    value={item.box_type_name}
                    onChange={(e) => updateItem(idx, 'box_type_name', e.target.value)}
                    className="h-8 text-xs"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-[11px]">금액</Label>
                  <Input
                    type="number"
                    value={item.item_price}
                    onChange={(e) => updateItem(idx, 'item_price', Number(e.target.value))}
                    className="h-8 text-xs"
                  />
                </div>
              </div>

              <Separator />

              <span className="text-[11px] font-medium text-gray-500">스티커 정보</span>
              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1">
                  <Label className="text-[11px]">스티커타입1</Label>
                  <Input
                    value={item.sticker_type1_name}
                    onChange={(e) => updateItem(idx, 'sticker_type1_name', e.target.value)}
                    className="h-8 text-xs"
                  />
                  <Input
                    type="number"
                    value={item.sticker_type1_quantity}
                    onChange={(e) =>
                      updateItem(idx, 'sticker_type1_quantity', Number(e.target.value))
                    }
                    className="h-8 text-xs"
                    placeholder="수량"
                    min={0}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-[11px]">스티커타입2</Label>
                  <Input
                    value={item.sticker_type2_name}
                    onChange={(e) => updateItem(idx, 'sticker_type2_name', e.target.value)}
                    className="h-8 text-xs"
                  />
                  <Input
                    type="number"
                    value={item.sticker_type2_quantity}
                    onChange={(e) =>
                      updateItem(idx, 'sticker_type2_quantity', Number(e.target.value))
                    }
                    className="h-8 text-xs"
                    placeholder="수량"
                    min={0}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-[11px]">스티커타입3</Label>
                  <Input
                    value={item.sticker_type3_name}
                    onChange={(e) => updateItem(idx, 'sticker_type3_name', e.target.value)}
                    className="h-8 text-xs"
                  />
                  <Input
                    type="number"
                    value={item.sticker_type3_quantity}
                    onChange={(e) =>
                      updateItem(idx, 'sticker_type3_quantity', Number(e.target.value))
                    }
                    className="h-8 text-xs"
                    placeholder="수량"
                    min={0}
                  />
                </div>
              </div>

              <div className="space-y-1">
                <Label className="text-[11px]">입력메시지</Label>
                <Textarea
                  value={item.input_message}
                  onChange={(e) => updateItem(idx, 'input_message', e.target.value)}
                  className="text-xs"
                  rows={2}
                />
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* 메모 */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">관리자 메모</CardTitle>
        </CardHeader>
        <CardContent>
          <Textarea
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            placeholder="관리자 메모 (선택)"
            rows={3}
            className="text-sm"
          />
        </CardContent>
      </Card>

      {/* 저장 */}
      <div className="flex justify-end gap-2 pb-8">
        <Button variant="outline" onClick={() => router.back()}>
          취소
        </Button>
        <Button onClick={handleSubmit} disabled={loading}>
          {loading ? '등록중...' : '주문 등록'}
        </Button>
      </div>
    </div>
  );
}
