import sql from 'mssql';
import { getBarunsonPool } from './connection';
import { DAERYEPUM_CARDKIND_SEQS, DAERYEPUM_CARD_CODES } from '@/types/barunson';
import type { BarunsonCollectedRow } from '@/types/barunson';

/**
 * 답례품 주문 수집 쿼리
 *
 * 식별 기준:
 * 1) S2_CardKind.CardKind_Seq IN (4, 5, 16) - 카드형답례장, 한지형답례장, 결혼답례카드
 * 2) 알려진 22개 답례품 카드 코드
 *
 * 두 조건을 OR로 결합하여 모든 답례품 주문을 포착
 */
const COLLECT_DAERYEPUM_ORDERS_SQL = `
SELECT DISTINCT
  co.order_seq,
  co.order_date,
  co.status_seq,
  co.settle_status,
  co.settle_price,
  co.last_total_price,
  co.order_total_price,
  co.order_name,
  co.order_hphone,
  co.order_type,
  co.sales_Gubun,
  co.site_gubun,
  coi.id AS item_id,
  coi.item_count,
  coi.item_price,
  coi.item_sale_price,
  c.Card_Code,
  c.Card_Name,
  c.Card_Price,
  c.Card_Div,
  c.CardBrand,
  ck.CardKind_Seq,
  di.NAME AS delivery_name,
  di.PHONE AS delivery_phone,
  di.HPHONE AS delivery_hphone,
  di.ADDR AS delivery_addr,
  di.ZIP AS delivery_zipcode,
  di.DELIVERY_SEQ AS delivery_seq
FROM custom_order co WITH (NOLOCK)
INNER JOIN custom_order_item coi WITH (NOLOCK)
  ON co.order_seq = coi.order_seq
INNER JOIN S2_Card c WITH (NOLOCK)
  ON coi.card_seq = c.Card_Seq
LEFT JOIN S2_CardKind ck WITH (NOLOCK)
  ON c.Card_Seq = ck.Card_Seq
  AND ck.CardKind_Seq IN (${DAERYEPUM_CARDKIND_SEQS.join(',')})
LEFT JOIN DELIVERY_INFO di WITH (NOLOCK)
  ON co.order_seq = di.ORDER_SEQ
WHERE co.order_date >= @sinceDate
  AND co.order_date < @untilDate
  AND co.status_seq >= 1
  AND (
    ck.CardKind_Seq IN (${DAERYEPUM_CARDKIND_SEQS.join(',')})
    OR c.Card_Code IN (${DAERYEPUM_CARD_CODES.map(c => `'${c}'`).join(',')})
  )
ORDER BY co.order_date ASC, co.order_seq ASC, coi.id ASC
`;

/**
 * 답례품 주문 데이터 수집
 * @param sinceDate 수집 시작일
 * @param untilDate 수집 종료일 (미포함)
 */
export async function fetchDaeryepumOrders(
  sinceDate: Date,
  untilDate: Date,
): Promise<BarunsonCollectedRow[]> {
  const pool = await getBarunsonPool();
  const request = pool.request();

  request.input('sinceDate', sql.DateTime, sinceDate);
  request.input('untilDate', sql.DateTime, untilDate);

  const result = await request.query<BarunsonCollectedRow>(
    COLLECT_DAERYEPUM_ORDERS_SQL
  );

  return result.recordset;
}

/**
 * 답례품 주문 건수만 빠르게 조회 (수집 전 미리보기용)
 */
export async function countDaeryepumOrders(
  sinceDate: Date,
  untilDate: Date,
): Promise<number> {
  const pool = await getBarunsonPool();
  const request = pool.request();

  request.input('sinceDate', sql.DateTime, sinceDate);
  request.input('untilDate', sql.DateTime, untilDate);

  const result = await request.query<{ cnt: number }>(`
    SELECT COUNT(DISTINCT co.order_seq) AS cnt
    FROM custom_order co WITH (NOLOCK)
    INNER JOIN custom_order_item coi WITH (NOLOCK)
      ON co.order_seq = coi.order_seq
    INNER JOIN S2_Card c WITH (NOLOCK)
      ON coi.card_seq = c.Card_Seq
    LEFT JOIN S2_CardKind ck WITH (NOLOCK)
      ON c.Card_Seq = ck.Card_Seq
      AND ck.CardKind_Seq IN (${DAERYEPUM_CARDKIND_SEQS.join(',')})
    WHERE co.order_date >= @sinceDate
      AND co.order_date < @untilDate
      AND co.status_seq >= 1
      AND (
        ck.CardKind_Seq IN (${DAERYEPUM_CARDKIND_SEQS.join(',')})
        OR c.Card_Code IN (${DAERYEPUM_CARD_CODES.map(c => `'${c}'`).join(',')})
      )
  `);

  return result.recordset[0]?.cnt ?? 0;
}
