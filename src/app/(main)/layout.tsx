import { Sidebar } from '@/components/layout/sidebar';
import { Header } from '@/components/layout/header';

export default function MainLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-gray-50">
      <Sidebar />
      <div className="ml-60">
        <Header />
        <main className="p-6">{children}</main>
      </div>
    </div>
  );
}
