'use client';

import { usePathname } from 'next/navigation';
import { Bell, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

const PAGE_TITLES: Record<string, string> = {
  '/dashboard': '대시보드',
  '/orders/new': '수동주문등록',
  '/orders': '주문관리',
  '/products': '상품관리',
  '/stickers': '스티커관리',
  '/box-types': '박스타입관리',
};

export function Header() {
  const pathname = usePathname();

  // /orders/new 먼저 매칭 (더 구체적인 경로 우선)
  const sortedEntries = Object.entries(PAGE_TITLES).sort(
    (a, b) => b[0].length - a[0].length
  );
  const title = sortedEntries.find(([key]) =>
    pathname.startsWith(key)
  )?.[1] ?? '';

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b bg-white/95 px-6 backdrop-blur-sm">
      <div className="flex items-center gap-3">
        <h1 className="text-base font-semibold text-gray-900">{title}</h1>
      </div>
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" className="h-8 w-8 text-gray-400 hover:text-gray-600">
          <RefreshCw className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon" className="relative h-8 w-8 text-gray-400 hover:text-gray-600">
          <Bell className="h-4 w-4" />
          <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-red-500" />
        </Button>
      </div>
    </header>
  );
}
