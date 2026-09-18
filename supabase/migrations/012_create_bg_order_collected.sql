-- ============================================
-- 주문조회 '수집완료' 상태 영속화 (migration 012)
--
-- 배경: 기존 관리자 '주문조회' 페이지의 수집완료 상태는 컨테이너 내부
--       /app/data/collected.json 파일에 저장되어, 볼륨 마운트 없이
--       Docker 재배포 시마다 초기화되는 문제가 있었음.
--       → Supabase 로 이전해 영구 보존.
--
-- 데이터 모델:
--   order_seq    : 주문번호 (VARCHAR PRIMARY KEY). CARD/ETC 모두 수용.
--                  CARD → 숫자 문자열 (예: "3244567")
--                  ETC  → "ETC-" 접두어 포함 가능 (현재 코드는 숫자만 저장하나
--                         미래 호환성 위해 100자 허용)
--   collected_at : 수집완료 처리 시각
--   collected_by : 처리한 관리자 이메일
--   category     : 'daeryepum' | 'deco' | 'flower' 등 (어느 탭에서 수집됐는지 — 통계용)
--
-- 정보입력현황의 processed_at 과는 별개 개념:
--   - processed_at (bg_order_customer_info): '정보 입력 후' 스프레드시트 등록 여부
--   - collected_at (bg_order_collected): '주문 자체' 를 수집 업무 처리 완료로 표시
-- ============================================

CREATE TABLE IF NOT EXISTS bg_order_collected (
  order_seq VARCHAR(100) PRIMARY KEY,
  collected_at TIMESTAMPTZ DEFAULT now(),
  collected_by VARCHAR(200),
  category VARCHAR(20)
);

CREATE INDEX IF NOT EXISTS idx_bg_order_collected_at
  ON bg_order_collected(collected_at DESC);

CREATE INDEX IF NOT EXISTS idx_bg_order_collected_category
  ON bg_order_collected(category) WHERE category IS NOT NULL;

COMMENT ON TABLE bg_order_collected IS '주문조회에서 ''수집완료'' 로 마킹된 주문 목록. 답례품/데코/꽃다발 공용.';
COMMENT ON COLUMN bg_order_collected.order_seq IS '주문번호 (CARD 는 숫자, ETC 는 ETC- 접두어 포함 가능)';
COMMENT ON COLUMN bg_order_collected.collected_at IS '관리자가 수집완료로 마킹한 시각';
COMMENT ON COLUMN bg_order_collected.collected_by IS '마킹한 관리자 이메일';
COMMENT ON COLUMN bg_order_collected.category IS '어느 카테고리 탭에서 마킹 됐는지 (daeryepum/deco/flower)';
