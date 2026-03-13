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
    <aside className="fixed left-0 top-0 z-40 flex h-screen w-56 flex-col border-r bg-slate-900">
      {/* 로고 */}
      <div className="flex h-14 items-center px-5">
        <Link href="/dashboard" className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-500">
            <span className="text-xs font-bold text-white">G</span>
          </div>
          <div className="flex flex-col">
            <span className="text-sm font-bold text-white leading-tight">더기프트</span>
            <span className="text-[10px] text-slate-400 leading-tight">퍼스트몰</span>
          </div>
        </Link>
      </div>

      {/* 구분선 */}
      <div className="mx-4 border-t border-slate-700" />

      {/* 네비게이션 */}
      <nav className="mt-2 flex-1 space-y-0.5 px-3">
        {navItems.map((item) => {
          const isActive = pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'flex items-center gap-3 rounded-lg px-3 py-2.5 text-[13px] font-medium transition-all',
                isActive
                  ? 'bg-blue-600 text-white shadow-lg shadow-blue-600/20'
                  : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
              )}
            >
              <item.icon className={cn('h-4 w-4', isActive ? 'text-white' : 'text-slate-500')} />
              {item.label}
            </Link>
          );
        })}
      </nav>

      {/* 하단 */}
      <div className="border-t border-slate-700 px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-full bg-slate-700">
            <span className="text-[10px] font-medium text-slate-300">AD</span>
          </div>
          <div className="flex flex-col">
            <span className="text-xs font-medium text-slate-300">관리자</span>
            <span className="text-[10px] text-slate-500">admin@thegift.co.kr</span>
          </div>
        </div>
      </div>
    </aside>
  );
}
