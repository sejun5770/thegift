-- ============================================
-- bg_product_settings: decoration_label 컬럼 추가
--
-- 배경: 답례품 종류에 따라 장식 형태가 다름.
--   - 한과/정과류: 스티커 (기존 default)
--   - 수건/타올류: 띠지
--   - 그 외: 라벨, 태그 등 자유롭게 운영자 지정
--
-- 데이터 구조는 sticker_types / sticker_selections 그대로 유지 — 단지 고객 화면 UI 에
-- 표시될 명칭(label)만 상품별로 자유 설정. 기본값 NULL/빈문자열이면 '스티커' fallback.
--
-- 영향:
--   · 고객 화면(order-info.html): "스티커 선택", "스티커 문구", "스티커 안내" 등 모든
--     "스티커" 단어를 이 값으로 동적 치환.
--   · 관리자 화면: 컬럼 헤더 등은 그대로 (운영 일관성 유지).
-- ============================================

ALTER TABLE bg_product_settings
  ADD COLUMN IF NOT EXISTS decoration_label TEXT DEFAULT NULL;

COMMENT ON COLUMN bg_product_settings.decoration_label IS
  '고객 화면에 표시될 장식 형태 명칭 — 예: 스티커, 띠지, 라벨, 태그. NULL/빈문자열이면 ''스티커'' fallback.';
