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
  const bySeq = new Map();    // base코드 → Map(card_seq → { days: 같은 구조 })
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
    // 판매단위(card_seq)별로도 쌓는다 — 수건처럼 옵션마다 가격이 다른 상품은
    //   코드 합계에서 가격이 섞이므로 이 축이 있어야 갈라 보인다.
    const seq = Number(r.item_card_seq);
    if (Number.isFinite(seq) && seq > 0) {
      if (!bySeq.has(code)) bySeq.set(code, new Map());
      const seqs = bySeq.get(code);
      if (!seqs.has(seq)) seqs.set(seq, { days: new Map(), name: null });
      const e = seqs.get(seq);
      if (!e.days.has(d)) e.days.set(d, new Map());
      const sm = e.days.get(d);
      sm.set(unit, (sm.get(unit) || 0) + 1);
    }
  }
  return { byCode, bySeq, names };
}

/**
 * 일자별 단가 → 가격 구간.
 *   하루의 대표 단가는 '가장 많이 팔린 단가'. 연속으로 같은 값이면 한 구간으로 잇는다.
 *   주문 1건짜리 튀는 날이 구간을 쪼개지 않도록, 앞뒤가 같은 값이면 흡수한다.
 *
 * 경계일 처리 (2026-08-14 요청):
 *   가격은 00시에 바뀌는 게 아니라서 변경 당일에는 두 가격의 주문이 섞인다.
 *   그날의 주문은 각자의 단가로 전/후 구간에 배정한다 — 대표 단가로 뭉뚱그리면
 *   변경 당일의 반나절치가 엉뚱한 구간에 들어간다.
 *   조회수는 시각을 모르므로(GA 는 일 단위) 그날의 주문 비율로 나눈다.
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
  const segIndexOfDay = new Map();   // 날짜 → 대표 구간 index
  for (const d of daily) {
    const last = segs[segs.length - 1];
    if (last && last.price === d.price) {
      last.end = d.date; last.days++;
    } else {
      segs.push({ price: d.price, start: d.date, end: d.date, days: 1 });
    }
    segIndexOfDay.set(d.date, segs.length - 1);
  }

  // 주문을 구간에 배정한다. 기본은 그날의 대표 구간, 경계일의 다른쪽 가격 주문은
  //   그 가격의 인접 구간으로 보낸다. dayShare 는 조회수 분할용 (날짜 → 구간index → 건수).
  for (const s of segs) { s.orders = 0; s.boundary_split = 0; }
  const dayShare = new Map();
  for (const [d, m] of sorted) {
    const idx = segIndexOfDay.get(d);
    const cover = segs[idx];
    const share = new Map();
    for (const [price, count] of m) {
      let target = idx;
      if (price !== cover.price) {
        const prev = segs[idx - 1];
        const next = segs[idx + 1];
        if (prev && prev.price === price && d === cover.start) target = idx - 1;
        else if (next && next.price === price && d === cover.end) target = idx + 1;
        // 그 외의 다른 가격(옵션가·오입력)은 대표 구간에 그대로 둔다 — mixed 로 이미 표시된다
      }
      segs[target].orders += count;
      if (target !== idx) { segs[target].boundary_split += count; segs[idx].end_shared = true; }
      share.set(target, (share.get(target) || 0) + count);
    }
    dayShare.set(d, share);
  }
  const mixedDays = daily.filter(d => d.mixed).length;
  return { daily, segs, mixedDays, dayShare };
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
async function priceTrend({ startDate, endDate, fetchOrders, code = null, sites = ['card', 'etc'], resolveSeqNames = null } = {}) {
  if (!startDate || !endDate) throw new Error('기간이 필요합니다');
  if (typeof fetchOrders !== 'function') throw new Error('fetchOrders 가 필요합니다');
  if (!api.isConfigured()) return { configured: false, config: api.configStatus(), products: [] };

  const orderRows = await fetchOrders(startDate, endDate);
  const { byCode, bySeq, names } = dailyPrices(orderRows);

  // 기록된 가격 이력이 있으면 그날의 가격을 그것으로 덮는다.
  //   주문 역산은 '주문이 있는 날' 만 알고 변경 시각도 그만큼 늦게 잡힌다.
  //   스냅샷은 주문이 없어도 값을 알기 때문에 있는 날짜만큼은 이쪽이 정확하다.
  //   ⚠ 옵션이 여럿인 상품(bySeq 2개+)은 코드 합계에 덮지 않는다 — 스냅샷은 판매단위별
  //     값이라, 한 옵션의 가격을 코드 전체의 '그날 가격' 으로 박으면 다른 옵션이 지워진다.
  let historyDays = 0;
  try {
    const hist = await require('../barungift/price-watch').listPriceHistory({ startDate, endDate });
    for (const h of hist) {
      const codeKey = toBase(h.product_code || h.card_code);
      const d = day(h.captured_at);
      if (!codeKey || !d || !h.sale_price) continue;
      const seqs = bySeq.get(codeKey);
      const multiOption = (seqs?.size || 0) > 1;
      if (!multiOption) {
        if (!byCode.has(codeKey)) byCode.set(codeKey, new Map());
        // 그날의 대표 단가를 기록값으로 확정한다 (건수를 크게 줘 최빈값 선정에서 이긴다)
        byCode.get(codeKey).set(d, new Map([[Number(h.sale_price), 9999]]));
      }
      // 판매단위별 이력은 옵션 축에 정확히 얹는다 (옵션명도 여기서 온다 — 주문 rows 의
      //   card_name 은 코드 대표명이라 옵션을 구분하지 못한다)
      const seq = Number(h.card_seq);
      if (Number.isFinite(seq) && seq > 0) {
        if (!bySeq.has(codeKey)) bySeq.set(codeKey, new Map());
        const sm = bySeq.get(codeKey);
        if (!sm.has(seq)) sm.set(seq, { days: new Map(), name: null });
        const e = sm.get(seq);
        e.days.set(d, new Map([[Number(h.sale_price), 9999]]));
        if (h.product_name && !e.name) e.name = h.product_name;
      }
      if (h.product_name && !names.has(codeKey)) names.set(codeKey, h.product_name);
      historyDays++;
    }
  } catch (e) {
    console.warn('[price-trend] 가격 이력 조회 실패 — 주문 역산만 사용:', e.message);
  }

  // GA 조회수는 사이트별 속성이라 각각 받아 합친다 (자사몰 두 곳의 조회를 합쳐야
  //   주문 합계와 축이 맞는다 — 주문 rows 도 CARD+ETC 합산이다)
  const viewMaps = [];
  for (const site of sites) {
    if (!api.PROPERTIES[site]) continue;
    try { viewMaps.push(await viewsDaily(site, startDate, endDate)); }
    catch (e) { console.warn(`[price-trend] ${site} 조회수 실패:`, e.message); }
  }
  const viewsOf = (c, d) => viewMaps.reduce((s, m) => s + (m.get(`${c}|${d}`) || 0), 0);

  /** 구간별 조회수·전환율 채우기 — 경계일 조회는 그날의 주문 비율로 나눈다 */
  const fillSegs = (c, segRes, withViews = true) => {
    const { daily, segs, dayShare } = segRes;
    for (const s of segs) { s.views = 0; }
    for (const d of daily) {
      const v = withViews ? viewsOf(c, d.date) : 0;
      const share = dayShare.get(d.date) || new Map();
      const total = [...share.values()].reduce((a, b) => a + b, 0);
      if (!v || !total) {
        // 조회가 있는데 주문이 없는 날은 대표 구간에 전부
        const idx = segs.findIndex(s => d.date >= s.start && d.date <= s.end);
        if (idx >= 0) segs[idx].views += v;
        continue;
      }
      for (const [idx, cnt] of share) segs[idx].views += v * (cnt / total);
    }
    for (const s of segs) {
      s.views = Math.round(s.views);
      s.conversion_rate = pct(s.orders, s.views);
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
    return changes;
  };

  // 옵션명 해석 — 주문 rows 의 card_name 은 코드 대표명이라 옵션(색상·종류)을 구분하지
  //   못한다. 서버가 S2_CARD 를 직접 읽는 resolver 를 주면 그걸 쓴다 (스냅샷이 쌓이기
  //   전에도 이름이 나온다). 실패해도 분석은 계속 — 이름만 seq 로 남는다.
  let seqNames = new Map();
  if (typeof resolveSeqNames === 'function') {
    try {
      const allSeqs = [...bySeq.values()].flatMap(m => [...m.keys()]);
      if (allSeqs.length) seqNames = (await resolveSeqNames([...new Set(allSeqs)])) || new Map();
    } catch (e) {
      console.warn('[price-trend] 옵션명 해석 실패:', e.message);
    }
  }

  const products = [];
  for (const [c, days] of byCode) {
    if (code && toBase(code) !== c) continue;
    const seqs = bySeq.get(c);

    // ── 옵션 상품 판정 ──
    //   판매단위가 여러 개라고 다 옵션 상품은 아니다. 메이플 호두정과도 정가/할인/시크릿
    //   변형이 별도 seq 라 2개+ 로 잡히는데, 주문이 한 변형에 몰려 있으면 사실상 단일
    //   가격 상품이다 — 그걸 옵션 표시로 바꾸면 핵심(가격 변경 스토리)이 사라진다.
    //   '주문 비중 15% 이상인 판매단위가 2개 이상' 일 때만 옵션 상품으로 본다 (수건 실측
    //   78.9/15.8/5.3 이 잡히고, 할인 변형 99/1 은 안 잡히는 경계).
    let multiOption = false;
    let seqOrderCounts = null;
    if ((seqs?.size || 0) > 1) {
      seqOrderCounts = new Map([...seqs.entries()].map(([seq, e]) => [seq,
        [...e.days.values()].reduce((x, m) => x + [...m.values()].reduce((p, q) => p + q, 0), 0)]));
      const total = [...seqOrderCounts.values()].reduce((a, b) => a + b, 0);
      const significant = [...seqOrderCounts.values()].filter(n => total > 0 && n / total >= 0.15).length;
      multiOption = significant >= 2;
    }

    // ── 옵션별 분석 — 수건처럼 판매단위(card_seq)마다 가격이 다른 상품 ──
    //   조회수는 옵션으로 가를 수 없다 (GA itemId 가 코드 단위, 한 페이지에서 옵션 선택).
    //   그래서 옵션에는 전환율 대신 '주문 비중' 을 준다 — 없는 값을 만들지 않는다.
    let options = null;
    if (multiOption) {
      const totalOrders = [...seqs.values()].reduce((a, e) =>
        a + [...e.days.values()].reduce((x, m) => x + [...m.values()].reduce((p, q) => p + q, 0), 0), 0);
      options = [...seqs.entries()].map(([seq, e]) => {
        const segRes = segmentsOf(e.days);
        fillSegs(c, segRes, false);   // 옵션 조회수는 없다 — views 0/전환율 null 로
        const orders = segRes.segs.reduce((a, s) => a + s.orders, 0);
        return {
          card_seq: seq,
          name: seqNames.get(seq) || e.name || `판매단위 ${seq}`,
          orders,
          share_pct: totalOrders > 0 ? Math.round((orders / totalOrders) * 1000) / 10 : null,
          segments: segRes.segs.map(s => ({
            price: s.price, start: s.start, end: s.end, days: s.days, orders: s.orders,
          })),
          changed: segRes.segs.length > 1,
        };
      }).sort((a, b) => b.orders - a.orders);
    }

    const segRes = segmentsOf(days);
    const { daily, segs, mixedDays } = segRes;
    const optionChanged = !!options?.some(o => o.changed);
    if (!code && segs.length < 2 && !optionChanged) continue;   // 가격이 안 바뀐 상품은 뺀다

    const changes = fillSegs(c, segRes);
    products.push({
      code: c,
      name: names.get(c) || c,
      // 옵션이 여럿이면 코드 합계 구간은 옵션가가 섞인 값이라 표시하지 않는다 —
      //   보여주면 '가격 변경' 처럼 읽힌다. 대신 options 로 내려보낸다.
      segments: multiOption ? [] : segs,
      changes: multiOption ? [] : changes,
      multi_option: multiOption,
      options,
      totals: {
        views: daily.reduce((a, d) => a + viewsOf(c, d.date), 0),
        orders: segs.reduce((a, s) => a + s.orders, 0),
      },
      daily: multiOption ? [] : daily.map(d => ({ ...d, views: viewsOf(c, d.date) })),
      mixed_days: mixedDays,
      total_days: daily.length,
      // 옵션 다중이면 mixed 는 당연한 현상이라 경고하지 않는다
      mixed_warning: !multiOption && mixedDays > daily.length * 0.3
        ? '같은 날에 단가가 갈리는 날이 많습니다 — 시점별 가격 변경이 아니라 수량 구간별 가격일 수 있습니다.'
        : null,
    });
  }
  for (const p of products) {
    p.totals.conversion_rate = pct(p.totals.orders, p.totals.views);
  }
  products.sort((a, b) => (b.changes.length + (b.options?.filter(o => o.changed).length || 0))
    - (a.changes.length + (a.options?.filter(o => o.changed).length || 0))
    || b.total_days - a.total_days);

  return {
    configured: true,
    start_date: startDate, end_date: endDate,
    products,
    history_days: historyDays,
    note: (historyDays
      ? `가격은 기록된 스냅샷(${historyDays}건)을 우선 쓰고, 없는 날은 주문 단가(주문총액÷수량, `
        + '쿠폰 적용 전)로 되살립니다. 전환율 = 우리 DB 주문 건수 ÷ GA 조회수. '
      : '가격은 주문의 단가(주문총액÷수량, 쿠폰 적용 전)로 되살린 값입니다. 주문이 없는 날은 알 수 없어 '
        + '구간에서 빠집니다. 스냅샷이 쌓이면 그때부터는 주문이 없는 날의 가격도 잡힙니다. '
        + '전환율 = 우리 DB 주문 건수 ÷ GA 조회수. ')
      + '가격 변경 당일의 주문은 각 주문의 단가로 전/후 구간에 배정하고, 그날의 조회수는 주문 비율로 나눕니다.',
    caution: '가격 구간이 보통 2~4개뿐이라 상관계수 같은 통계는 내지 않습니다. '
      + '답례품은 예식 성수기 영향이 커서, 가격을 바꾼 시점이 비수기와 겹치면 가격 탓으로 보이기 쉽습니다 — '
      + '구간 비교는 참고로 보시고 시즌을 함께 감안하세요.',
  };
}

module.exports = { priceTrend, dailyPrices, segmentsOf, toBase };
