import { redirect } from 'next/navigation';

export default function Home() {
  // BASE_PATH: docker-manager 환경변수 (예: /c/barungift)
  // 프록시가 접두사를 제거하고 전달하므로 리다이렉션 목적지에 접두사 포함 필요
  const basePath = process.env.BASE_PATH || '';
  redirect(`${basePath}/dashboard`);
}
