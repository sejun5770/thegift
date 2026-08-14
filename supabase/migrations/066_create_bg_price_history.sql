-- ============================================
-- 066_create_bg_price_history.sql
--
-- 답례품 판매가 변경 이력.
--
-- 배경 (2026-08-14 조사):
--   원본 상품 DB(MSSQL S2_CARD)에는 '지금 얼마인지' 만 있고 '언제 바뀌었는지' 가 없다.
--   가격 변경 감사 로그 테이블(ADMIN_PRICE_LOGINFO)이 존재하긴 하는데 청첩장만 3,299건이고
--   답례품은 0건이다 — 답례품 관리 화면이 그 로그를 남기지 않는다.
--   S2_CARD.DISPLAY_UPDATE_DATE 도 대부분 비어 있어 수정 시점을 알 수 없다.
--
--   그래서 지금까지는 주문 단가(주문총액÷수량)로 가격을 역산했는데, 주문이 없는 날은
--   가격을 알 수 없고 변경 시각도 '주문이 처음 찍힌 날' 까지만 좁혀진다.
--
-- 하는 일:
--   기존 동기화 주기에 얹어 S2_CARD 의 답례품 판매가를 읽고, 직전에 기록한 값과
--   다를 때만 한 줄 남긴다. 값이 그대로면 아무것도 쓰지 않는다 (하루 몇 행 수준).
--
-- 설계 메모:
--   · card_seq 가 실제 판매 단위다. 같은 Card_Code 가 정가/할인/시크릿특가로 여러 행이라
--     (예: TGJSD01O4_B 3,499 / _A 정가 4,800) 코드 단위로 뭉치면 가격이 섞인다.
--   · list_price(정가) 와 sale_price(판매가)를 함께 남긴다 — 할인율 추이도 보게 된다.
--   · prev_* 는 조회 편의를 위한 비정규화다. 직전 행을 다시 찾지 않고 변화폭을 읽는다.
--   · captured_at 은 '우리가 알아챈 시각' 이지 '바꾼 시각' 이 아니다. 동기화 주기만큼
--     늦을 수 있어 이름을 그렇게 지었다 — changed_at 으로 부르면 정확도를 오해한다.
-- ============================================

CREATE TABLE IF NOT EXISTS bg_price_history (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  card_seq      INTEGER NOT NULL,          -- S2_CARD.Card_Seq — 실제 판매 단위
  card_code     TEXT NOT NULL,             -- 원본 코드 (변형 접미 포함, 예: TGJSD01O4_B)
  product_code  TEXT NOT NULL,             -- 변형 접미를 뗀 코드 (예: TGJSD01O4)
  product_name  TEXT,

  list_price    INTEGER,                   -- 정가 (S2_CARD.Card_Price)
  sale_price    INTEGER,                   -- 판매가 (S2_CARD.CardSet_Price) ← 전환율 분석의 기준
  prev_list_price INTEGER,
  prev_sale_price INTEGER,

  -- 첫 기록(기준선)인지, 이후 변경인지. 기준선을 '가격 변경' 으로 세면 안 된다.
  is_baseline   BOOLEAN NOT NULL DEFAULT FALSE,

  captured_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),   -- 우리가 알아챈 시각 (변경 시각 아님)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 같은 판매단위의 같은 가격을 두 번 기록하지 않는다 (동기화가 겹쳐 돌아도 안전)
CREATE UNIQUE INDEX IF NOT EXISTS bg_price_history_uniq
  ON bg_price_history (card_seq, sale_price, list_price, captured_at);

CREATE INDEX IF NOT EXISTS idx_bg_price_history_seq
  ON bg_price_history (card_seq, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_bg_price_history_code
  ON bg_price_history (product_code, captured_at DESC);

COMMENT ON TABLE bg_price_history IS
  '답례품 판매가 변경 이력 — 원본 DB 에 이력이 없어 동기화 때 스냅샷으로 남긴다';
COMMENT ON COLUMN bg_price_history.captured_at IS
  '우리가 변경을 알아챈 시각. 동기화 주기만큼 늦을 수 있다 (실제 변경 시각 아님)';
COMMENT ON COLUMN bg_price_history.sale_price IS
  '판매가 (CardSet_Price) — 주문 단가와 일치하는 값. 전환율 분석의 기준';

GRANT ALL ON TABLE bg_price_history TO anon, authenticated, service_role;
