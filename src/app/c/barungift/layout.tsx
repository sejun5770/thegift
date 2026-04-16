import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: '바른손더기프트 - 주문정보 입력',
  description: '주문 후 고객 정보를 입력해주세요.',
};

export default function BarungiftLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-gray-50">
      {children}
    </div>
  );
}
