-- ============================================
-- 075_bg_stock_items_item_kind_set.sql
--
-- item_kind CHECK 제약에 'set'(세트) 추가.
--
-- 왜 별도 마이그레이션인가:
--   'set' 은 073 파일에 제자리 수정으로 들어갔는데, 그 시점에 073 은 이미 (4개 값으로)
--   실행된 뒤였다. 그래서 운영 DB 제약에는 set 이 없고, 화면에서 세트를 고르면
--   23514 (bg_si_item_kind_chk 위반) 로 저장이 거부됐다 (2026-08-20 실제 발생).
--   교훈: 커밋된 마이그레이션은 실행 여부와 무관하게 제자리 수정하지 않는다 — 항상 새 번호.
--
-- 멱등: 073 을 구버전(4개)으로 실행했든 신버전(5개)으로 실행했든 결과가 같다.
-- ============================================

ALTER TABLE bg_stock_items DROP CONSTRAINT IF EXISTS bg_si_item_kind_chk;
ALTER TABLE bg_stock_items ADD CONSTRAINT bg_si_item_kind_chk
  CHECK (item_kind IN ('product', 'material', 'package', 'set', 'etc'));

COMMENT ON COLUMN bg_stock_items.item_kind IS
  '품목 구분 — product=원물 / material=부자재 / package=포장재 / set=세트 / etc=기타. bg_stock_bom.component_role 과 같은 값 체계 + set. BOM 역할 기본값·임계치 기준으로 쓴다';
