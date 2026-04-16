'use client';

import { useSearchParams } from 'next/navigation';
import { useState, useEffect, Suspense } from 'react';
import { Loader2, AlertCircle, CheckCircle2, Phone } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CustomerInfoForm } from '@/components/barungift/customer/CustomerInfoForm';
import { BG_ERROR_MESSAGES } from '@/lib/barungift/constants';
import type { BgOrderForCustomer } from '@/lib/barungift/types';

function OrderInfoContent() {
  const searchParams = useSearchParams();
  const orderId = searchParams.get('oid');

  const [order, setOrder] = useState<BgOrderForCustomer | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [completed, setCompleted] = useState(false);

  useEffect(() => {
    if (!orderId) {
      setError(BG_ERROR_MESSAGES.INVALID_ORDER_ID);
      setLoading(false);
      return;
    }

    async function fetchOrder() {
      try {
        const res = await fetch(`/c/barungift/api/orders/${orderId}`);
        if (!res.ok) {
          const data = await res.json();
          setError(data.error || BG_ERROR_MESSAGES.ORDER_NOT_FOUND);
          return;
        }
        const data: BgOrderForCustomer = await res.json();

        // 이미 완료된 주문
        if (data.info_status === 'completed') {
          setCompleted(true);
          setOrder(data);
          return;
        }

        setOrder(data);
      } catch {
        setError(BG_ERROR_MESSAGES.NETWORK_ERROR);
      } finally {
        setLoading(false);
      }
    }

    fetchOrder();
  }, [orderId]);

  // 로딩 상태
  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
          <p className="text-sm text-gray-500">주문 정보를 불러오는 중...</p>
        </div>
      </div>
    );
  }

  // 에러 상태
  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <div className="max-w-sm text-center">
          <AlertCircle className="mx-auto h-12 w-12 text-red-400" />
          <h2 className="mt-4 text-lg font-bold text-gray-900">
            주문 정보를 확인할 수 없습니다
          </h2>
          <p className="mt-2 text-sm text-gray-500">{error}</p>
          <div className="mt-6 flex flex-col gap-2">
            <Button
              variant="outline"
              onClick={() => window.location.reload()}
              className="w-full"
            >
              다시 시도
            </Button>
            <p className="text-xs text-gray-400">
              <Phone className="mr-1 inline h-3 w-3" />
              {BG_ERROR_MESSAGES.CS_CONTACT}
            </p>
          </div>
        </div>
      </div>
    );
  }

  // 이미 완료된 주문
  if (completed) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <div className="max-w-sm text-center">
          <CheckCircle2 className="mx-auto h-12 w-12 text-green-500" />
          <h2 className="mt-4 text-lg font-bold text-gray-900">
            정보 입력이 완료되었습니다
          </h2>
          <p className="mt-2 text-sm text-gray-500">
            이미 주문 정보 입력이 완료되었습니다.
            <br />
            수정이 필요하시면 고객센터로 문의해주세요.
          </p>
          <p className="mt-4 text-xs text-gray-400">
            <Phone className="mr-1 inline h-3 w-3" />
            {BG_ERROR_MESSAGES.CS_CONTACT}
          </p>
        </div>
      </div>
    );
  }

  // 정보 입력 완료 후 성공 화면
  if (!order) return null;

  return (
    <div className="mx-auto max-w-lg px-4 py-6">
      {/* 헤더 */}
      <div className="mb-6 text-center">
        <div className="mb-2 flex items-center justify-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-500">
            <span className="text-xs font-bold text-white">G</span>
          </div>
          <span className="text-sm font-bold text-gray-800">바른손더기프트</span>
        </div>
        <h1 className="text-xl font-bold text-gray-900">주문 정보 입력</h1>
        <p className="mt-1 text-sm text-gray-500">
          {order.customer_name}님의 주문 정보를 입력해주세요.
        </p>
      </div>

      {completed ? (
        <SuccessScreen />
      ) : (
        <CustomerInfoForm order={order} onComplete={() => setCompleted(true)} />
      )}
    </div>
  );
}

function SuccessScreen() {
  return (
    <div className="py-16 text-center">
      <CheckCircle2 className="mx-auto h-16 w-16 text-green-500" />
      <h2 className="mt-4 text-xl font-bold text-gray-900">
        정보 입력이 완료되었습니다!
      </h2>
      <p className="mt-2 text-sm text-gray-500">
        입력하신 정보를 바탕으로 제작이 진행됩니다.
        <br />
        감사합니다.
      </p>
      <p className="mt-6 text-xs text-gray-400">
        <Phone className="mr-1 inline h-3 w-3" />
        문의: {BG_ERROR_MESSAGES.CS_CONTACT}
      </p>
    </div>
  );
}

export default function OrderInfoPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
        </div>
      }
    >
      <OrderInfoContent />
    </Suspense>
  );
}
