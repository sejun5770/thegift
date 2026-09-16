-- ============================================
-- 041_create_bg_wiki_revisions.sql
--
-- 답례품 매뉴얼(위키) 편집 기능 — 수정 히스토리 저장.
--
-- 설계:
--   · 현재 문서 = slug 별 가장 최근 revision (별도 current 테이블 없음 — 단순).
--   · 저장할 때마다 revision 1행 INSERT → 히스토리가 자동으로 남는다.
--   · revision 이 하나도 없으면 프론트는 배포 이미지에 포함된 기본 manual.html
--     내용을 그대로 보여준다 (최초 seed 역할).
--   · 복원 = 옛 revision 내용으로 새 revision 저장 (히스토리 보존, 삭제 없음).
-- ============================================

CREATE TABLE IF NOT EXISTS bg_wiki_revisions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        TEXT NOT NULL,                    -- 문서 식별자 (현재 'manual' 하나)
  content     TEXT NOT NULL,                    -- 본문 HTML (main 영역 innerHTML)
  note        TEXT,                             -- 수정 메모 (선택)
  created_by  TEXT,                             -- 수정자 이메일
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bg_wiki_rev_slug ON bg_wiki_revisions (slug, created_at DESC);

COMMENT ON TABLE bg_wiki_revisions IS '답례품 매뉴얼(위키) 수정 히스토리 — 최신 revision 이 현재 문서';

-- 2026-10-30 이후 Supabase 신규 테이블 default behavior 대응
GRANT ALL ON TABLE bg_wiki_revisions TO anon, authenticated, service_role;
