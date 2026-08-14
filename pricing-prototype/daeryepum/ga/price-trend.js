/**
 * 가격 변경 × 유입·전환 (자사몰).
 *
 * 가격 이력을 어디서 얻는가:
 *   따로 기록해 온 가격 테이블이 없다. 대신 주문의 단가(주문총액 ÷ 수량)로 되살린다.
 *   실측(2026-08-14) 결과 자사몰 답례품 61종 중 28종에서 단가가 바뀐 이력이 잡혔고,
 *   구간이 시점별로 깨끗하게 갈렸다. 예: 메이플 호두정과
 *     3,299원 (05-01~05-26) → 3,399원 (05-26~08-01) → 3,499원 (08-04~)
 *
 *   ⚠ 수량 구간 할인과 헷갈리면 안 된다 — 같은 날 여러 단가가 섞이면 '가격 변경' 이
 *     아니라 수량대별 가격일 수 있다. 위 상품은 단가별 수량 분포가 완전히 겹쳐
 *     (1~300 / 1~442 / 1~110) 수량 구간이 아님을 확인했다. 그래도 데이터마다 다를 수 있어
 *     하루에 단가가 갈리는 비율(mixed_days)을 함께 돌려주고, 높으면 화면에서 경고한다.
 *
 *   ⚠ 주문이 없는 날은 가격을 알 수 없다. 구간은 '주문이 있는 날' 기준이며,
 *     빈 구간은 직전 가격이 유지된 것으로 본다 (표시상 이어 붙인다).
 *
 * 왜 상관계수를 내지 않는가:
 *   가격 구간이 보통 2~4개뿐이라 상관계수는 표본이 너무 적어 숫자가 오도한다.
 *   게다가 답례품은 예식 성수기 영향이 커서, 가격을 올린 시점이 비수기와 겹치면
 *   '가격 탓' 으로 보이기 쉽다. 그래서 구간별 실측치를 나란히 보여주고 판단은 사람이 한다.
 */
'use strict';

const api = require('./api');
const report = require('./report');

const GIFT_PREFIX = process.env.GA_GIFT_ID_PREFIX || 'TGJ';

/** 변형 접미 '_A'/'_B' 하나만 제거 — funnel.toBase 와 같은 규칙 */
function toBase(code) {
  if (!code) return '';
  const m = String(code).trim().match(/^(.+)_[A-Za-z]$/);
  return (m ? m[1] : String(code).trim()).toUpperCase();
}

const day = (v) => String(v || '').slice(0, 10);
const pct = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);

/**
 * 주문 rows → 상품코드별 일자별 단가.
 *   단가 = 주문총액 ÷ 수량. 쿠폰 적용 전 금액이라 판매가에 해당한다
 *   (쿠폰 차감액을 쓰면 같은 날에도 주문마다 값이 달라진다).
 */
function dailyPrices(rows) {
  const byCode = new Map();   // base코드 → Map(날짜 → Map(단가 → 건수))
  const names = new Map();
  for (const r of rows || []) {
    if (r.order_type !== 'CARD' && r.order_type !== 'ETC') continue;
    const code = toBase(r.card_code);
    if (!code) continue;
    const d = day(r.order_date || r.paid_at);
    if (!d) continue;
    const cnt = Number(r.item_count) || 0;
    const amt = Number(r.item_amount) || 0;
    if (cnt <= 0 || amt <= 0) continue;
    const unit = Math.round(amt / cnt);
    if (!unit) continue;
    if (!byCode.has(code)) byCode.set(code, new Map());
    const days = byCode.get(code);
    if (!days.has(d)) days.set(d, new Map());
    const m = days.get(d);
    m.set(unit, (m.get(unit) || 0) + 1);
    if (r.card_name && !names.has(code)) names.set(code, r.card_name);
  }
  return { byCode, names };
}

/**
 * 일자별 단가 → 가격 구간.
 *   하루의 대표 단가는 '가장 많이 팔린 단가'. 연속으로 같은 값이면 한 구간으로 잇는다.
 *   주문 1건짜리 튀는 날이 구간을 쪼개지 않도록, 앞뒤가 같은 값이면 흡수한다.
 */
function segmentsOf(days) {
  const sorted = [...days.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const daily = sorted.map(([d, m]) => {
    const entries = [...m.entries()].sort((a, b) => b[1] - a[1]);
    const total = entries.reduce((s, [, n]) => s + n, 0);
    return { date: d, price: entries[0][0], orders: total, mixed: entries.length > 1 };
  });
  // 앞뒤가 같은데 가운데만 다르고 주문이 적은 날은 노이즈로 보고 흡수한다
  for (let i = 1; i < daily.length - 1; i++) {
    if (daily[i].price !== daily[i - 1].price
      && daily[i - 1].price === daily[i + 1].price
      && daily[i].orders <= 2) {
      daily[i] = { ...daily[i], price: daily[i - 1].price, absorbed: true };
    }
  }
  const segs = [];
  for (const d of daily) {
    const last = segs[segs.length - 1];
    if (last && last.price === d.price) {
      last.end = d.date; last.days++; last.orders += d.orders;
    } else {
      segs.push({ price: d.price, start: d.date, end: d.date, days: 1, orders: d.orders });
    }
  }
  const mixedDays = daily.filter(d => d.mixed).length;
  return { daily, segs, mixedDays };
}

/** GA 일자별 상품 조회수 — (base코드, 날짜) → 조회 */
async function viewsDaily(site, startDate, endDate) {
  const res = await api.runReport(site, {
    dateRanges: [{ startDate, endDate }],
    dimensions: [{ name: 'date' }, { name: 'itemId' }],
    metrics: [{ name: 'itemsViewed' }],
    dimensionFilter: {
      filter: {
        fieldName: 'itemId',
        stringFilter: { matchType: 'BEGINS_WITH', value: GIFT_PREFIX, caseSensitive: false },
      },
    },
    limit: 20000,
  });
  const map = new Map();   // `${code}|${YYYY-MM-DD}` → 조회
  for (const r of api.flatten(res)) {
    const raw = String(r.date || '');            // GA4 date 는 YYYYMMDD
    if (raw.length !== 8) continue;
    const d = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
    const code = toBase(r.itemId);
    if (!code) continue;
    const k = `${code}|${d}`;
    map.set(k, (map.get(k) || 0) + (r.itemsViewed || 0));
  }
  return map;
}

/**
 * @param {function} opts.fetchOrders (start, end) => 주문 rows
 * @param {string}   opts.code        특정 상품만 (없으면 가격이 바뀐 상품 전부)
 */
async function priceTrend({ startDate, endDate, fetchOrders, code = null, sites = ['card', 'etc'] } = {}) {
  if (!startDate || !endDate) throw new Error('기간이 필요합니다');
  if (typeof fetchOrders !== 'function') throw new Error('fetchOrders 가 필요합니다');
  if (!api.isConfigured()) return { configured: false, config: api.configStatus(), products: [] };

  const orderRows = await fetchOrders(startDate, endDate);
  const { byCode, names } = dailyPrices(orderRows);

  // GA 조회수는 사이트별 속성이라 각각 받아 합친다 (자사몰 두 곳의 조회를 합쳐야
  //   주문 합계와 축이 맞는다 — 주문 rows 도 CARD+ETC 합산이다)
  const viewMaps = [];
  for (const site of sites) {
    if (!api.PROPERTIES[site]) continue;
    try { viewMaps.push(await viewsDaily(site, startDate, endDate)); }
    catch (e) { console.warn(`[price-trend] ${site} 조회수 실패:`, e.message); }
  }
  const viewsOf = (c, d) => viewMaps.reduce((s, m) => s + (m.get(`${c}|${d}`) || 0), 0);

  const products = [];
  for (const [c, days] of byCode) {
    if (code && toBase(code) !== c) continue;
    const { daily, segs, mixedDays } = segmentsOf(days);
    if (!code && segs.length < 2) continue;   // 가격이 안 바뀐 상품은 목록에서 뺀다

    // 구간별 조회수 — 그 구간의 날짜 범위에 든 GA 조회를 더한다
    for (const s of segs) {
      let views = 0;
      for (const d of daily) {
        if (d.date >= s.start && d.date <= s.end) views += viewsOf(c, d.date);
      }
      s.views = views;
      s.conversion_rate = pct(s.orders, views);
      s.orders_per_day = Math.round((s.orders / s.days) * 10) / 10;
    }
    const changes = [];
    for (let i = 1; i < segs.length; i++) {
      const from = segs[i - 1], to = segs[i];
      changes.push({
        date: to.start,
        from_price: from.price,
        to_price: to.price,
        diff: to.price - from.price,
        diff_pct: from.price > 0 ? Math.round(((to.price - from.price) / from.price) * 1000) / 10 : null,
        cr_before: from.conversion_rate,
        cr_after: to.conversion_rate,
        cr_diff_pt: (from.conversion_rate != null && to.conversion_rate != null)
          ? Math.round((to.conversion_rate - from.conversion_rate) * 10) / 10 : null,
      });
    }
    products.push({
      code: c,
      name: names.get(c) || c,
      segments: segs,
      changes,
      daily: daily.map(d => ({ ...d, views: viewsOf(c, d.date) })),
      mixed_days: mixedDays,
      total_days: daily.length,
      // 하루에 단가가 갈리는 날이 많으면 '시점 변경' 이 아니라 수량 구간 가격일 수 있다
      mixed_warning: mixedDays > daily.length * 0.3
        ? '같은 날에 단가가 갈리는 날이 많습니다 — 시점별 가격 변경이 아니라 수량 구간별 가격일 수 있습니다.'
        : null,
    });
  }
  products.sort((a, b) => b.changes.length - a.changes.length || b.total_days - a.total_days);

  return {
    configured: true,
    start_date: startDate, end_date: endDate,
    products,
    note: '가격은 주문의 단가(주문총액÷수량, 쿠폰 적용 전)로 되살린 값입니다. 주문이 없는 날은 알 수 없어 '
      + '구간에서 빠집니다. 전환율 = 우리 DB 주문 건수 ÷ GA 조회수.',
    caution: '가격 구간이 보통 2~4개뿐이라 상관계수 같은 통계는 내지 않습니다. '
      + '답례품은 예식 성수기 영향이 커서, 가격을 바꾼 시점이 비수기와 겹치면 가격 탓으로 보이기 쉽습니다 — '
      + '구간 비교는 참고로 보시고 시즌을 함께 감안하세요.',
  };
}

module.exports = { priceTrend, dailyPrices, segmentsOf, toBase };
