-- ============================================
-- 029_naver_sync_state_id_sequence.sql
--
-- naver_sync_state.id 를 SEQUENCE 기반으로 변경 → 멀티 스토어 row 추가 가능.
--
-- 배경:
--   014 에서 `id INTEGER PRIMARY KEY DEFAULT 1` 로 singleton 의도.
--   028 에서 singleton constraint 만 제거했지만 id 컬럼 DEFAULT 1 그대로 유지 → 새 store 추가 시 23505 충돌.
--
-- 변경:
--   - SEQUENCE 생성 후 ALTER COLUMN id SET DEFAULT nextval
--   - 기존 max(id) + 1 부터 sequence 시작 (현재 row 와 충돌 안 함)
-- ============================================

CREATE SEQUENCE IF NOT EXISTS naver_sync_state_id_seq;
ALTER TABLE naver_sync_state ALTER COLUMN id SET DEFAULT nextval('naver_sync_state_id_seq');
SELECT setval('naver_sync_state_id_seq', COALESCE((SELECT MAX(id) FROM naver_sync_state), 0));
ALTER SEQUENCE naver_sync_state_id_seq OWNED BY naver_sync_state.id;
