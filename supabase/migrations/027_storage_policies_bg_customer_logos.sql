-- ============================================
-- Storage RLS — bg-customer-logos 버킷 정책
--
-- 배경:
--   고객이 order-info 페이지에서 PNG/JPG 로고를 anon key 로 직접 업로드.
--   기본 Storage 정책은 anon insert/select/delete 모두 차단.
--   이 버킷 한정으로 정책 부여.
--
-- 사전:
--   Supabase 대시보드 → Storage → New bucket
--     · Name: bg-customer-logos
--     · Public: ✅
--     · File size limit: 5MB
--     · Allowed MIME types: image/png, image/jpeg
--
-- 적용:
--   Supabase 대시보드 → SQL Editor 에서 본 파일 실행
--   (또는 CLI: supabase db push)
-- ============================================

-- 1) 공개 읽기 — 운영자/인쇄팀이 정보입력현황 표에서 직접 다운로드.
--    (버킷이 public 이면 RLS 우회되지만, RLS 명시로 운영 정책 가시화)
DROP POLICY IF EXISTS "bg_customer_logos_public_read" ON storage.objects;
CREATE POLICY "bg_customer_logos_public_read"
  ON storage.objects FOR SELECT TO public
  USING (bucket_id = 'bg-customer-logos');

-- 2) Anon 업로드 — 고객이 로그인 없이 주문번호+서명 기반으로 업로드.
--    버킷/MIME 제한은 버킷 설정에서 차단 (DB 정책으로는 mime 검증 어려움).
DROP POLICY IF EXISTS "bg_customer_logos_anon_insert" ON storage.objects;
CREATE POLICY "bg_customer_logos_anon_insert"
  ON storage.objects FOR INSERT TO public
  WITH CHECK (bucket_id = 'bg-customer-logos');

-- 3) Anon 삭제 — 고객이 로고 교체/취소 시 이전 파일 정리 (best-effort).
--    리스크: 누구나 path 알면 삭제 가능. 단,
--      · path 는 timestamp 포함이라 추측 어려움
--      · 삭제되어도 운영 영향 미미 (sticker_selections 에 URL 만 남음 → 404)
--      · 악용 가치 낮음 (운영자 수동 재업로드 가능)
--    더 엄격한 정책 원하면 server-side service_role 키로만 삭제하도록 변경.
DROP POLICY IF EXISTS "bg_customer_logos_anon_delete" ON storage.objects;
CREATE POLICY "bg_customer_logos_anon_delete"
  ON storage.objects FOR DELETE TO public
  USING (bucket_id = 'bg-customer-logos');
