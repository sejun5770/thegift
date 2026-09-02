-- ============================================
-- 078_bg_site_settings_shared_option_groups.sql
--
-- 자유 옵션 그룹을 한 번 등록해 여러 상품에 적용한다 (요청 2026-09-02, 추석 미니카드).
--
-- 지금 자유 옵션 그룹은 bg_product_settings.custom_options 에 상품마다 복사본으로 들어간다.
-- 기획전처럼 같은 옵션을 15개 상품에 걸면 복사본이 15개 생기고, 선택지 하나를 추가하거나
-- 품절 처리할 때마다 15군데를 고쳐야 한다. 빠뜨린 상품은 옵션이 달라지는데 알아챌 방법도 없다.
--
-- 그래서 스티커(bg_stickers.product_codes)와 같은 방식으로, 그룹을 한 번 정의하고
-- 적용 상품코드를 그룹 쪽에 적는다. 서버가 상품별 옵션 맵을 만들 때 병합해 내려주므로
-- 고객 화면은 상품별 옵션과 공유 그룹을 구분하지 않는다.
--
-- 형태 (배열 — 순서가 곧 고객 화면 노출 순서):
-- [
--   {
--     "id": "og-xxxx",                  -- 그룹 식별자 (수정/삭제용)
--     "name": "추석 미니카드",            -- 고객 화면 라벨 = 그룹명
--     "use_images": true,               -- false 면 텍스트 카드
--     "is_active": true,                -- 끄면 전 상품에서 즉시 내려감 (기획전 종료)
--     "product_codes": ["TGOSL001D1"],  -- 적용 상품 (빈 배열 = 아무 상품에도 안 붙음)
--     "options": [
--       { "code": "TGJSD04P1", "name": "포토", "preview_image_url": "https://...",
--         "sold_out": false, "color": "#F3F4F6" }
--     ]
--   }
-- ]
--
-- 검증은 store.normSharedOptionGroups 가 한다 — 모르는 키·이상값은 버린다.
-- 상품별 custom_options 와 이름이 겹치면 상품별 설정을 우선한다 (개별 예외가 공유를 이긴다).
-- ============================================

ALTER TABLE bg_site_settings
  ADD COLUMN IF NOT EXISTS shared_option_groups JSONB;

COMMENT ON COLUMN bg_site_settings.shared_option_groups IS
  '공유 자유 옵션 그룹 (기획전 미니카드 등) — 그룹마다 적용 상품코드를 지정. NULL/[] = 없음';
