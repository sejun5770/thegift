'use client';

import { usePathname } from 'next/navigation';

const PAGE_TITLES: Record<string, string> = {
  '/dashboard': '대시보드',
  '/orders': '주문관리',
  '/products': '상품관리',
  '/stickers': '스티커관리',
  '/box-types': '박스타입관리',
};

export function Header() {
  const pathname = usePathname();
  const title = Object.entries(PAGE_TITLES).find(([key]) =>
    pathname.startsWith(key)
  )?.[1] ?? '';

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center border-b bg-white px-6">
      <h1 className="text-lg font-semibold text-gray-900">{title}</h1>
    </header>
  );
}
