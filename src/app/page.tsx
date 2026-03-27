import { redirect } from 'next/navigation';

export default function Home() {
  // NEXT_PUBLIC_BASE_PATH는 빌드 시 Dockerfile에서 주입 (예: /c/barungift)
  // 로컬 dev 환경에서는 빈 문자열로 fallback → /dashboard로 이동
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';
  redirect(`${basePath}/dashboard`);
}
