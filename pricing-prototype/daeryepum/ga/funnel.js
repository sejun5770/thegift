/**
 * 유입 → 구매 전환, 기간 A vs B 비교 (바른손카드 · 바른손몰).
 *
 * 왜 GA 구매를 안 쓰는가:
 *   바른손카드는 purchase 이벤트가 상품코드가 아닌 주문라인 ID 로 기록돼 조회와 이어지지 않고,
 *   itemsPurchased 는 '수량' 이라 조회수로 나누면 115% 같은 값이 나온다 (2026-08-13 실측).
 *   그래서 분모만 GA 에서 가져오고 분자는 우리 DB 주문을 쓴다:
 *
 *     전환율 = 우리 DB 주문 건수 ÷ GA 상품 조회수
 *
 *   우리 DB 는 취소·환불까지 반영된 정확한 값이고, GA 매출은 동의 거부·광고차단으로
 *   어차피 실제와 어긋난다. 각자 잘하는 것만 맡긴다.
 *
 * 코드 매칭:
 *   GA itemId 와 우리 상품코드가 같은 체계다 (TGJSD04D1, TGJBK03D1). 수작업 매핑이 필요 없다.
 *   GA 에만 '_A'/'_B' 변형 접미가 붙는 경우가 있어 그것만 떼고 맞춘다.
 *   ※ 접미 제거를 더 늘리면 다른 상품이 한 줄로 뭉친다 (BASE 코드 과잉병합 사례) — 단일 영문자만.
 */
'use strict';

const report = require('./report');

/** GA 사이트키 ↔ 우리 주문 order_type */
const SITE_MAP = { card: 'CARD', etc: 'ETC' };
const SITE_LABEL = { card: '바른손카드', etc: '바른손몰' };

/** 변형 접미 '_A' / '_B' 하나만 제거 — 그 이상 자르면 다른 상품이 뭉친다 */
function toBase(code) {
  if (!code) return '';
  const m = String(code).trim().match(/^(.+)_[A-Za-z]$/);
  return (m ? m[1] : String(code).trim()).toUpperCase();
}

const pct = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);

/** 한 기간의 GA 조회수 — (사이트, 상품코드) → 조회 */
async function viewsOf(startDate, endDate) {
  const r = await report.productReport({ startDate, endDate, mode: 'item', scope: 'gift', limit: 500 });
  const map = new Map();
  const names = new Map();
  for (const row of r.rows || []) {
    if (!row.item_id) continue;
    const key = `${row.site}|${toBase(row.item_id)}`;
    map.set(key, (map.get(key) || 0) + (row.viewed || 0));
    if (row.name && !names.has(key)) names.set(key, row.name);
  }
  return { map, names, meta: r };
}

/**
 * 한 기간의 우리 주문 건수 — (사이트, 상품코드) → 주문 건수.
 *   같은 주문에 같은 상품이 여러 줄이어도 1건으로 센다 (주문 단위 전환을 보는 것이므로).
 */
function ordersOf(rows) {
  const seen = new Map();   // key → Set(order_seq)
  const names = new Map();
  for (const r of rows || []) {
    const site = r.order_type === 'CARD' ? 'card' : r.order_type === 'ETC' ? 'etc' : null;
    if (!site) continue;                       // 마켓 주문은 GA 에 안 잡히므로 대상 아님
    const code = toBase(r.card_code);
    if (!code) continue;
    const key = `${site}|${code}`;
    if (!seen.has(key)) seen.set(key, new Set());
    seen.get(key).add(String(r.order_seq ?? r.order_id ?? ''));
    if (r.card_name && !names.has(key)) names.set(key, r.card_name);
  }
  const map = new Map();
  for (const [k, set] of seen) map.set(k, set.size);
  return { map, names };
}

/**
 * @param {object} opts
 * @param {{start,end}} opts.a       기준 기간
 * @param {{start,end}} opts.b       비교 기간 (없으면 A 만)
 * @param {function}    opts.fetchOrders  (start, end) => 주문 rows
 * @param {string[]}    opts.sites   ['card','etc']
 */
async function compare({ a, b = null, fetchOrders, sites = ['card', 'etc'] } = {}) {
  if (!a?.start || !a?.end) throw new Error('기준 기간(a)이 필요합니다');
  if (typeof fetchOrders !== 'function') throw new Error('fetchOrders 가 필요합니다');

  const load = async (p) => {
    const [views, orderRows] = await Promise.all([viewsOf(p.start, p.end), fetchOrders(p.start, p.end)]);
    return { views, orders: ordersOf(orderRows), period: p };
  };
  const A = await load(a);
  const B = b?.start && b?.end ? await load(b) : null;

  // 두 기간 · 조회/주문 어디에든 나온 (사이트, 코드) 를 모두 모은다.
  //   한쪽에만 있는 상품(신규/단종)이 빠지면 비교가 거짓이 된다.
  const keys = new Set();
  for (const src of [A, B].filter(Boolean)) {
    for (const k of src.views.map.keys()) keys.add(k);
    for (const k of src.orders.map.keys()) keys.add(k);
  }

  const nameOf = (k) => A.views.names.get(k) || A.orders.names.get(k)
    || B?.views.names.get(k) || B?.orders.names.get(k) || null;

  const side = (src, k) => {
    if (!src) return null;
    const views = src.views.map.get(k) || 0;
    const orders = src.orders.map.get(k) || 0;
    return { views, orders, conversion_rate: pct(orders, views) };
  };

  const rows = [];
  for (const k of keys) {
    const [site, code] = k.split('|');
    if (!sites.includes(site)) continue;
    const av = side(A, k);
    const bv = side(B, k);
    rows.push({
      site, site_label: SITE_LABEL[site] || site, code, name: nameOf(k),
      a: av,
      b: bv,
      delta: bv ? {
        // 증감은 B 대비 A (A 가 최근이라는 가정 없이, 화면이 정한 순서를 그대로 따른다)
        views_diff: av.views - bv.views,
        views_pct: bv.views > 0 ? Math.round(((av.views - bv.views) / bv.views) * 1000) / 10 : null,
        orders_diff: av.orders - bv.orders,
        // 전환율은 비율이라 '몇 %p' 로 본다 — 퍼센트의 퍼센트는 오해를 부른다
        cr_diff_pt: (av.conversion_rate != null && bv.conversion_rate != null)
          ? Math.round((av.conversion_rate - bv.conversion_rate) * 10) / 10 : null,
      } : null,
    });
  }
  rows.sort((x, y) => (y.a?.views || 0) - (x.a?.views || 0));

  const totalsOf = (src) => {
    if (!src) return null;
    let views = 0, orders = 0;
    for (const k of keys) {
      const [site] = k.split('|');
      if (!sites.includes(site)) continue;
      views += src.views.map.get(k) || 0;
      orders += src.orders.map.get(k) || 0;
    }
    return { views, orders, conversion_rate: pct(orders, views) };
  };

  return {
    configured: A.views.meta.configured !== false,
    config: A.views.meta.config || null,
    a: { ...a, totals: totalsOf(A) },
    b: b?.start ? { ...b, totals: totalsOf(B) } : null,
    // GA 쪽 사이트 진단은 올리되, '구매 미연결' 경고는 뺀다 — 이 화면의 전환율 분자는
    //   우리 DB 주문이라 그 경고가 참이 아니고, 켜 두면 유효한 값을 의심하게 만든다.
    sites: (A.views.meta.sites || []).map(s =>
      s.purchase_not_linked ? { ...s, note: null } : s),
    errors: A.views.meta.errors || [],
    rows,
    note: '전환율 = 우리 DB 주문 건수 ÷ GA 상품 조회수. GA 구매 데이터는 쓰지 않습니다 '
      + '(바른손카드는 구매가 상품코드로 기록되지 않고, 수량 기준이라 조회수와 단위가 맞지 않습니다).',
  };
}

module.exports = { compare, toBase, SITE_MAP, SITE_LABEL };
