/**
 * 출고 누락 감시 — "수집완료로 처리됐는데 출고 흔적이 없는" 주문을 찾는다.
 *
 * 문제 (운영, 2026-08-13 발생 / 08-21 발견):
 *   정보입력현황의 '수집복사' 는 클립보드 복사가 성공하면 그것만으로 수집완료로 마킹한다.
 *   스프레드시트에 실제로 붙여넣었는지는 확인하지 않는다. 그래서 복사만 되고 붙여넣기를
 *   놓치면 시스템에는 '수집완료' 로 남아 목록에서 사라지고, 후공정은 아무것도 진행되지 않는다.
 *   ETC-3248985 / ETC-3249011 이 이렇게 8일간 결제확인 상태로 방치됐다.
 *
 * 판정 (자사 주문만):
 *   수집완료(processed_at) + 희망출고일 경과  →  MSSQL 에 출고 흔적이 있는가?
 *     · ETC (CUSTOM_ETC_ORDER):  delivery_date
 *     · CARD (custom_order):     src_send_date
 *   취소/환불 상태는 제외한다. 흔적이 없으면 '누락 의심'.
 *
 * 왜 이 신호를 쓰나 (2026-08-21 실측):
 *   수집완료 + 희망출고일 경과 2,706 건 중 걸린 건 9 건. 정상 건은 ETC 1,429 건이 전부
 *   배송완료(12), CARD 128 건이 전부 발송완료(15) 로 깨끗하게 갈린다. 오탐이 거의 없다.
 *
 * 대상 아닌 것:
 *   · 마켓(CP-/NV-)·수동등록(MO-) — 발송 상태 체계가 우리 MSSQL 에 없다. 세지도 않는다.
 *   · 희망출고일이 아직 안 지난 주문 — 정상 진행 중이다.
 */
'use strict';

// 취소·환불 — 출고 흔적이 없는 게 당연하다. ETC 15=환불완료, CARD 15=발송완료라
//   테이블마다 뜻이 다르다. 그래서 두 집합을 따로 둔다 (work-drift 에서 겪은 함정).
const ETC_DEAD = new Set([3, 5, 15]);   // 결제취소 / 주문취소 / 환불완료
const CARD_DEAD = new Set([3, 5]);      // 결제취소 / 주문취소 (15 는 발송완료 = 정상)

const ETC_STATUS = {
  0: '주문접수', 1: '결제대기', 2: '입금확인', 3: '결제취소', 4: '결제확인',
  5: '주문취소', 6: '제작준비', 7: '인쇄대기', 8: '인쇄중', 9: '제본중',
  10: '포장중', 11: '배송준비', 12: '배송완료', 13: '수령확인', 14: '포장완료', 15: '환불완료',
};
const CARD_STATUS = {
  0: '주문접수', 1: '결제대기', 3: '결제취소', 5: '주문취소', 6: '제작준비',
  7: '인쇄대기', 8: '인쇄중', 9: '초안컨펌완료/결제대기', 10: '포장중',
  11: '배송준비', 12: '배송완료', 14: '포장완료', 15: '발송완료',
};

const chunk = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

/**
 * @param {object}   opts
 * @param {function} opts.getPool      MSSQL 풀 팩토리 (server.js getPool)
 * @param {object}   opts.store        barungift/store (listProcessedBefore 용)
 * @param {string}   opts.today        'YYYY-MM-DD' — 이 날짜 '이전' 희망출고일만 본다
 * @param {number}   [opts.days=180]   거슬러 볼 기간 (희망출고일 기준)
 * @returns {{count:number, items:Array, checked:number, skipped_channel:number}}
 */
async function detectMissedShipping({ getPool, store, today, days = 180 }) {
  const from = new Date(new Date(today + 'T00:00:00').getTime() - days * 86400000)
    .toISOString().slice(0, 10);
  const rows = await store.listProcessedShipDateBefore({ before: today, from });

  // order_id 형태로 소스를 가른다.
  //   · 'ETC-123'  → ETC 확정
  //   · '123'      → CARD 우선이지만 ETC 일 수도 있다. 초기 stub 이 접두 없이 저장된 적이 있어
  //                  (bare 키 함정) 양쪽을 다 조회한다. 한쪽만 보면 정상 출고 건이 누락으로 잡힌다
  //                  — 3248335(정상 배송완료) 가 CARD 에 없어 오탐으로 걸렸던 실측 사례.
  const etcSeqs = new Set();
  const cardSeqs = new Set();
  const targets = [];
  let skippedChannel = 0;
  for (const r of rows) {
    const id = String(r.order_id || '').trim();
    let seq = null, kind = null;
    if (/^ETC-\d+$/.test(id)) { seq = Number(id.slice(4)); kind = 'etc'; }
    else if (/^\d+$/.test(id)) { seq = Number(id); kind = 'either'; }
    else { skippedChannel++; continue; }     // CP- / NV- / MO- 등
    if (!Number.isFinite(seq) || seq <= 0) continue;
    if (kind === 'etc') etcSeqs.add(seq);
    else { etcSeqs.add(seq); cardSeqs.add(seq); }
    targets.push({ ...r, seq, kind });
  }
  if (!targets.length) return { count: 0, items: [], checked: 0, skipped_channel: skippedChannel };

  const pool = await getPool();
  const etcById = new Map();
  const cardById = new Map();

  for (const c of chunk([...etcSeqs], 900)) {
    const q = await pool.request().query(`
      SELECT o.order_seq, o.status_seq, o.order_date, o.delivery_date,
             o.order_name, o.settle_price,
             (SELECT TOP 1 c.Card_Name FROM CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK)
                INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
                WHERE oi.order_seq = o.order_seq) AS card_name
      FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
      WHERE o.order_seq IN (${c.join(',')})
    `);
    q.recordset.forEach(x => etcById.set(x.order_seq, x));
  }
  for (const c of chunk([...cardSeqs], 900)) {
    const q = await pool.request().query(`
      SELECT o.order_seq, o.status_seq, o.order_date, o.src_send_date,
             o.order_name, o.settle_price
      FROM custom_order o WITH (NOLOCK)
      WHERE o.order_seq IN (${c.join(',')})
    `);
    q.recordset.forEach(x => cardById.set(x.order_seq, x));
  }

  const items = [];
  for (const t of targets) {
    const etc = etcById.get(t.seq);
    const card = t.kind === 'either' ? cardById.get(t.seq) : null;

    // 어느 쪽이든 출고 흔적이 있으면 정상 — bare 키는 두 테이블 중 하나만 실체가 있다.
    if (etc && etc.delivery_date) continue;
    if (card && card.src_send_date) continue;
    // 취소/환불이면 출고가 없는 게 정상
    if (etc && ETC_DEAD.has(Number(etc.status_seq))) continue;
    if (card && CARD_DEAD.has(Number(card.status_seq))) continue;
    // 양쪽 다 없는 주문번호 = MSSQL 에서 사라졌거나 우리가 모르는 소스 → 판단 불가라 넘긴다
    if (!etc && !card) continue;

    const src = etc || card;
    const isEtc = !!etc;
    items.push({
      order_id: t.order_id,
      order_seq: t.seq,
      source: isEtc ? 'ETC' : 'CARD',
      desired_ship_date: t.desired_ship_date,
      days_overdue: Math.round(
        (new Date(today + 'T00:00:00') - new Date(t.desired_ship_date + 'T00:00:00')) / 86400000),
      processed_at: t.processed_at,
      processed_by: t.processed_by,
      status_seq: src.status_seq,
      status_label: (isEtc ? ETC_STATUS : CARD_STATUS)[Number(src.status_seq)] || `코드${src.status_seq}`,
      order_date: src.order_date,
      order_name: src.order_name || '',
      settle_price: Number(src.settle_price) || 0,
      product_name: (isEtc ? src.card_name : null) || '',
    });
  }
  items.sort((a, b) => (a.desired_ship_date < b.desired_ship_date ? -1 : 1));
  return { count: items.length, items, checked: targets.length, skipped_channel: skippedChannel };
}

module.exports = { detectMissedShipping, ETC_STATUS, CARD_STATUS };
