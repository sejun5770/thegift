'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import {
  LayoutDashboard,
  ClipboardList,
  Package,
  Sticker,
  Box,
} from 'lucide-react';

const navItems = [
  { href: '/dashboard', label: '대시보드', icon: LayoutDashboard },
  { href: '/orders', label: '주문관리', icon: ClipboardList },
  { href: '/products', label: '상품관리', icon: Package },
  { href: '/stickers', label: '스티커관리', icon: Sticker },
  { href: '/box-types', label: '박스타입', icon: Box },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="fixed left-0 top-0 z-40 h-screen w-60 border-r bg-white">
      <div className="flex h-14 items-center border-b px-4">
        <Link href="/dashboard" className="flex items-center gap-2">
          <span className="text-lg font-bold text-gray-900">더기프트</span>
          <span className="text-xs text-gray-500">퍼스트몰</span>
        </Link>
      </div>
      <nav className="space-y-1 p-3">
        {navItems.map((item) => {
          const isActive = pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition-colors',
                isActive
                  ? 'bg-gray-100 text-gray-900'
                  : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
              )}
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
