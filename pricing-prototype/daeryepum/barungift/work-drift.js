/**
 * 작업 후 주문 변경 감지 (데코소품) — "작업했는데 주문이 바뀐 건" 을 케이스별로 가른다.
 *
 * 문제 (운영, 2026-08-19):
 *   결제완료 → 데코 작업자가 초안 작업 → 그 뒤 주문이 취소되거나, 취소 후 재결제되면서
 *   주문일이 갱신돼 목록 맨 위에 '신규' 처럼 올라온다. 작업자가 이미 작업한 건인지,
 *   품목이 바뀐 건지 알 길이 없어 중복 작업·폐기 누락이 생긴다.
 *
 * '작업했다' 의 기준:
 *   빠른손웹 커스텀팀 인쇄작업 메뉴에서 초안 이미지(jpg/png)를 올리면
 *   MSSQL custom_order_plist_choan_img 에 품목(plist → card_seq) 단위로 시각·작업자가 남는다.
 *   작업자가 따로 무엇을 찍을 필요가 없어 누락이 없고, 품목 단위라 케이스 2·4 를 가를 수 있다.
 *
 * 케이스 (운영 정의):
 *   1 cancelled       작업 후 취소됨                          → 폐기
 *   2 item_removed    취소→재결제, 작업한 품목이 사라짐         → 폐기
 *   3 unchanged       취소→재결제, 작업 품목 그대로            → 기존 작업 유효, 손대지 말 것
 *   4 item_replaced   취소→재결제, 작업 품목 대신 다른 데코 품목 → 폐기 + 신규 작업
 *
 * 판정 자료 (모두 MSSQL, 우리 쪽 스냅샷 불필요):
 *   · choan_img.reg_date  = 작업 시각 (품목별)
 *   · custom_order_history 중 작업 시각 이후 행 = 무엇이 바뀌었나 (원문 보존)
 *   · 현재 custom_order.status_seq / custom_order_item = 지금 상태
 *
 * 성능:
 *   화면에 이미 떠 있는 주문 목록(order_seq 들)만 대상으로 IN 조회 세 번. 900건 단위로 끊는다.
 *   전수 스캔은 하지 않는다 — 주문조회는 이미 무거운 화면이다.
 */
'use strict';

// 바른손카드 custom_order.status_seq: 3=결제취소, 5=주문취소.
//   15 는 '발송완료' 다 — 답례품(ETC) 쪽 15=반품과 다르다. 처음에 15 를 취소로 넣었다가
//   정상 발송 73건이 '취소됨' 으로 오판된 것을 실측으로 잡았다 (2026-08-19).
//   9(초안컨펌완료/결제대기)도 취소가 아니다.
const CANCEL_STATUSES = new Set([3, 5]);
// 판정을 일으키는 이력 유형. '상태변경'(포장중→배송준비 같은 정상 진행) 은 넣지 않는다 —
//   넣었더니 정상 출고 건이 '작업 후 변경' 으로 잡혔다 (2026-08-19 실측). 취소는 별도 유형이다.
const CHANGE_TYPES = ['주문 취소', '빠른손웹 수량변경', '빠른손웹 판삭제', '빠른손웹 판추가',
  '빠른손웹 판수정', '제품변경', '주문수량변경'];

const CASE_META = {
  cancelled:     { level: 'danger', label: '취소됨',        action: '작업물 폐기' },
  item_removed:  { level: 'danger', label: '품목 빠짐',     action: '작업물 폐기 — 재결제에서 이 품목이 빠졌습니다' },
  item_replaced: { level: 'warn',   label: '품목 교체',     action: '기존 작업물 폐기 후 새 품목으로 재작업' },
  unchanged:     { level: 'ok',     label: '재결제(동일)',  action: '기존 작업 그대로 유효 — 다시 작업하지 마세요' },
  changed:       { level: 'warn',   label: '작업 후 변경',  action: '변경 내역을 확인하세요' },
};

/** 취소 계열 판정 */
const isCancelled = (s) => CANCEL_STATUSES.has(Number(s));

/**
 * @param {object} opts
 * @param {function} opts.getPool
 * @param {number[]}  opts.orderSeqs   화면의 주문번호들 (숫자만 — MSSQL 주문)
 * @param {string}    opts.categorySql 카테고리 품목 조건 (예: deco 필터). 'c.' 별칭 기준.
 */
async function detectWorkDrift({ getPool, orderSeqs, categorySql }) {
  const seqs = [...new Set((orderSeqs || []).map(Number).filter(n => Number.isFinite(n) && n > 0))];
  if (!seqs.length) return { by_order: {}, count: 0 };
  const pool = await getPool();
  const byOrder = {};

  for (let i = 0; i < seqs.length; i += 900) {
    const chunk = seqs.slice(i, i + 900);
    const inList = chunk.join(',');

    // 1) 작업 기록 — 이 카테고리 품목에 초안 이미지가 올라간 (주문, card_seq)
    const worked = await pool.request().query(`
      SELECT p.order_seq, p.card_seq, c.Card_Code, c.Card_Name,
             MIN(i.reg_date) AS worked_at, MIN(i.reg_admin_id) AS worked_by, COUNT(*) AS img_cnt
      FROM custom_order_plist_choan_img i WITH (NOLOCK)
      INNER JOIN custom_order_plist p WITH (NOLOCK) ON p.id = i.pid
      INNER JOIN S2_Card c WITH (NOLOCK) ON c.Card_Seq = p.card_seq
      WHERE p.order_seq IN (${inList}) AND (${categorySql})
      GROUP BY p.order_seq, p.card_seq, c.Card_Code, c.Card_Name`);
    if (!worked.recordset.length) continue;

    const workedByOrder = new Map();
    for (const w of worked.recordset) {
      const k = String(w.order_seq);
      if (!workedByOrder.has(k)) workedByOrder.set(k, []);
      workedByOrder.get(k).push(w);
    }
    const workedSeqs = [...workedByOrder.keys()];
    const inWorked = workedSeqs.join(',');

    // 2) 현재 상태 + 현재 카테고리 품목 — 두 쿼리로 나눈다.
    //   한 쿼리에서 'LEFT JOIN S2_Card ... AND (카테고리 필터)' 로 묶으면 tedious 가
    //   'An unknown error has occurred' 로 죽는다 (2026-08-19, 140건 IN 에서 재현).
    //   상태는 취소된 주문(품목 없음)도 필요하므로 따로 받는다.
    const st = await pool.request().query(`
      SELECT co.order_seq, co.status_seq, CONVERT(varchar(19), co.order_date, 120) AS order_date
      FROM custom_order co WITH (NOLOCK)
      WHERE co.order_seq IN (${inWorked})`);
    const curByOrder = new Map();
    for (const r of st.recordset) {
      curByOrder.set(String(r.order_seq), { status_seq: r.status_seq, order_date: r.order_date, items: [] });
    }
    const items = await pool.request().query(`
      SELECT coi.order_seq, coi.card_seq, c.Card_Code, c.Card_Name, coi.item_count
      FROM custom_order_item coi WITH (NOLOCK)
      INNER JOIN S2_Card c WITH (NOLOCK) ON c.Card_Seq = coi.card_seq
      WHERE coi.order_seq IN (${inWorked}) AND (${categorySql})`);
    for (const r of items.recordset) {
      const o = curByOrder.get(String(r.order_seq));
      if (o) o.items.push({ card_seq: r.card_seq, code: r.Card_Code, name: r.Card_Name, qty: r.item_count });
    }

    // 3) 작업 이후 이력 — 원문을 그대로 가져와 툴팁에 보여준다
    const typeList = CHANGE_TYPES.map(t => `N'${t}'`).join(',');
    const hist = await pool.request().query(`
      SELECT h.order_seq, h.htype, h.admin_id, h.memo, h.system_sql, h.reg_date
      FROM custom_order_history h WITH (NOLOCK)
      WHERE h.order_seq IN (${inWorked}) AND h.htype IN (${typeList})
      ORDER BY h.order_seq, h.reg_date, h.id`);
    const histByOrder = new Map();
    for (const h of hist.recordset) {
      const k = String(h.order_seq);
      if (!histByOrder.has(k)) histByOrder.set(k, []);
      histByOrder.get(k).push(h);
    }

    // 4) 판정
    for (const [k, works] of workedByOrder) {
      const now = curByOrder.get(k);
      if (!now) continue;
      const firstWork = works.reduce((a, w) => (!a || w.worked_at < a ? w.worked_at : a), null);
      const after = (histByOrder.get(k) || []).filter(h => new Date(h.reg_date) > new Date(firstWork));
      if (!after.length && !isCancelled(now.status_seq)) continue;   // 작업 후 아무 일 없음 — 정상

      const workedSeqSet = new Set(works.map(w => Number(w.card_seq)));
      const curSeqSet = new Set(now.items.map(it => Number(it.card_seq)));
      const stillThere = works.filter(w => curSeqSet.has(Number(w.card_seq)));
      const gone = works.filter(w => !curSeqSet.has(Number(w.card_seq)));
      const newOnes = now.items.filter(it => !workedSeqSet.has(Number(it.card_seq)));

      let kind;
      if (isCancelled(now.status_seq)) kind = 'cancelled';
      else if (gone.length && newOnes.length) kind = 'item_replaced';
      else if (gone.length) kind = 'item_removed';
      else if (after.some(h => h.htype === '주문 취소')) kind = 'unchanged';   // 취소→재결제, 품목 그대로
      else {
        // 취소 없이 뭔가 바뀌었는데 작업한 데코 품목은 그대로다.
        //   봉투 추가/청첩장 수량 변경처럼 데코와 무관한 변경이 대부분이라, 이력 원문에
        //   작업 품목 코드/이름이 등장할 때만 '작업 후 변경' 으로 올린다. 아니면 무시.
        const keys = works.flatMap(w => [w.Card_Code, w.Card_Name]).filter(Boolean).map(String);
        const touchesWorked = after.some(h => {
          const txt = `${h.memo || ''} ${h.system_sql || ''}`;
          return keys.some(k => k && txt.includes(k));
        });
        if (!touchesWorked) continue;
        kind = 'changed';
      }

      byOrder[k] = {
        kind,
        ...CASE_META[kind],
        worked_at: firstWork,
        worked_by: works[0]?.worked_by || null,
        worked_items: works.map(w => ({ code: w.Card_Code, name: w.Card_Name })),
        gone_items: gone.map(w => ({ code: w.Card_Code, name: w.Card_Name })),
        new_items: newOnes.map(it => ({ code: it.code, name: it.name, qty: it.qty })),
        status_seq: now.status_seq,
        // 이력 원문 — 무엇이 바뀌었는지 사람이 읽을 수 있게 (select 문은 뺀다)
        history: after.map(h => ({
          at: h.reg_date, type: h.htype, by: h.admin_id, memo: h.memo || '',
          detail: (h.system_sql && !/^\s*(select|update)/i.test(String(h.system_sql)))
            ? String(h.system_sql).replace(/\r/g, '').trim().slice(0, 600) : '',
        })),
      };
    }
  }
  return { by_order: byOrder, count: Object.keys(byOrder).length };
}

module.exports = { detectWorkDrift, CASE_META };
