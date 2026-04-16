import { Sidebar } from '@/components/layout/sidebar';
import { Header } from '@/components/layout/header';

export default function BarungiftAdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-screen">
      <Sidebar />
      <div className="flex flex-1 flex-col pl-56">
        <Header />
        <main className="flex-1 overflow-auto bg-gray-50/30 p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
