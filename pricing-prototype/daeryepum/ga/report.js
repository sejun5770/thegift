/**
 * GA4 상품별 유입·구매전환 리포트 (바른손카드 · 바른손몰).
 *
 * 두 가지 방식을 둔다 — 사이트가 전자상거래 이벤트를 제대로 보내는지에 따라 갈린다:
 *
 *   item 모드 (정확)   view_item / add_to_cart / purchase 이벤트의 item 단위 집계.
 *                      상품별 조회 → 장바구니 → 구매 와 전환율을 그대로 얻는다.
 *   page 모드 (차선)   상품 상세 페이지의 조회수만. 전환을 상품별로 가를 수 없어
 *                      '유입' 만 본다. 전자상거래 이벤트가 없을 때의 대안이다.
 *
 * auto 는 item 을 먼저 시도하고 데이터가 없으면 page 로 떨어진다.
 *
 * ⚠️ GA 숫자는 실제 결제 매출과 다르다 (동의 거부·광고차단·환불 미반영). 매출의 정답은
 *    언제나 우리 DB 다. 여기 값은 '얼마나 보고 얼마나 샀는가' 의 비율을 보는 용도다.
 */
'use strict';

const api = require('./api');

/** GA4 지표 이름이 바뀌어도 리포트가 통째로 죽지 않게, 없는 지표는 빼고 재시도한다 */
const ITEM_METRICS = ['itemsViewed', 'itemsAddedToCart', 'itemsPurchased', 'itemRevenue'];

const ymd = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => ymd(new Date(Date.now() - n * 86400000 + 9 * 3600000));

/** 요청 지표 중 GA 가 거부한 것을 응답 메시지에서 걷어낸다 */
function dropRejectedMetrics(metrics, err) {
  const msg = String(err?.body?.error?.message || err?.message || '');
  const kept = metrics.filter(m => !msg.includes(m));
  return kept.length && kept.length < metrics.length ? kept : null;
}

/** item 단위 집계 */
async function itemReport(site, startDate, endDate, limit) {
  let metrics = ITEM_METRICS.slice();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await api.runReport(site, {
        dateRanges: [{ startDate, endDate }],
        dimensions: [{ name: 'itemId' }, { name: 'itemName' }],
        metrics: metrics.map(name => ({ name })),
        orderBys: [{ metric: { metricName: metrics[0] }, desc: true }],
        limit,
      });
      return { rows: api.flatten(res), metrics };
    } catch (e) {
      const kept = dropRejectedMetrics(metrics, e);
      if (!kept) throw e;
      console.warn(`[ga] ${site}: 지원하지 않는 지표를 빼고 재시도 — ${metrics.filter(m => !kept.includes(m)).join(', ')}`);
      metrics = kept;
    }
  }
  return { rows: [], metrics };
}

/** 페이지 단위 집계 — 상품 상세 경로만 */
async function pageReport(site, startDate, endDate, limit) {
  const pattern = process.env.GA_PRODUCT_PATH_REGEX || '(product|goods|item)';
  const res = await api.runReport(site, {
    dateRanges: [{ startDate, endDate }],
    dimensions: [{ name: 'pagePath' }, { name: 'pageTitle' }],
    metrics: [{ name: 'screenPageViews' }, { name: 'sessions' }],
    dimensionFilter: {
      filter: {
        fieldName: 'pagePath',
        stringFilter: { matchType: 'FULL_REGEXP', value: `.*${pattern}.*`, caseSensitive: false },
      },
    },
    orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
    limit,
  });
  return { rows: api.flatten(res) };
}

/** 사이트 전체 전환 요약 — page 모드에서 '상품별' 이 불가능할 때 최소한 이건 보여준다 */
async function siteSummary(site, startDate, endDate) {
  const res = await api.runReport(site, {
    dateRanges: [{ startDate, endDate }],
    metrics: [{ name: 'sessions' }, { name: 'transactions' }, { name: 'purchaseRevenue' }],
  });
  return api.flatten(res)[0] || null;
}

const pct = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);

/**
 * 상품별 유입·구매전환.
 * @param {string[]} opts.sites  사이트키 (기본: 설정된 전부)
 * @param {string}   opts.mode   'auto' | 'item' | 'page'
 */
async function productReport({ sites, startDate, endDate, mode = 'auto', limit = 250 } = {}) {
  if (!api.isConfigured()) {
    return { configured: false, config: api.configStatus(), rows: [], sites: [] };
  }
  const targets = (Array.isArray(sites) && sites.length ? sites : api.SITE_KEYS)
    .filter(s => api.PROPERTIES[s]);
  const start = startDate || daysAgo(28);
  const end = endDate || daysAgo(0);

  const out = {
    configured: true, start_date: start, end_date: end,
    sites: [], rows: [], errors: [],
  };

  for (const site of targets) {
    try {
      let used = mode;
      let rows = [];
      let metrics = null;

      if (mode === 'auto' || mode === 'item') {
        const r = await itemReport(site, start, end, limit);
        metrics = r.metrics;
        if (r.rows.length) { used = 'item'; rows = r.rows; }
        else if (mode === 'item') { used = 'item'; rows = []; }
      }
      if (!rows.length && (mode === 'auto' || mode === 'page')) {
        const r = await pageReport(site, start, end, limit);
        used = 'page';
        rows = r.rows;
      }

      const summary = await siteSummary(site, start, end).catch(() => null);
      out.sites.push({
        site, mode: used, rows: rows.length, metrics,
        sessions: summary?.sessions ?? null,
        transactions: summary?.transactions ?? null,
        revenue: summary?.purchaseRevenue ?? null,
        conversion_rate: summary ? pct(summary.transactions, summary.sessions) : null,
        // page 모드는 상품별 전환을 낼 수 없다 — 화면에서 그 사실이 드러나야 한다
        note: used === 'page'
          ? '전자상거래(view_item·purchase) 이벤트가 없어 페이지 조회수만 집계했습니다 — 상품별 전환율은 낼 수 없습니다'
          : null,
      });

      for (const r of rows) {
        if (used === 'item') {
          const viewed = r.itemsViewed || 0;
          const purchased = r.itemsPurchased || 0;
          out.rows.push({
            site, mode: 'item',
            item_id: r.itemId || null,
            name: r.itemName || null,
            viewed,
            added_to_cart: r.itemsAddedToCart ?? null,
            purchased,
            revenue: r.itemRevenue ?? null,
            cart_rate: pct(r.itemsAddedToCart || 0, viewed),
            conversion_rate: pct(purchased, viewed),
          });
        } else {
          out.rows.push({
            site, mode: 'page',
            item_id: null,
            path: r.pagePath || null,
            name: r.pageTitle || null,
            viewed: r.screenPageViews || 0,
            sessions: r.sessions || 0,
            added_to_cart: null, purchased: null, revenue: null,
            cart_rate: null, conversion_rate: null,
          });
        }
      }
    } catch (e) {
      // 한 사이트가 막혀도 다른 사이트는 보여야 한다
      out.errors.push({ site, message: String(e.message).slice(0, 400) });
    }
  }

  out.rows.sort((a, b) => (b.viewed || 0) - (a.viewed || 0));
  return out;
}

/**
 * 연결 진단 — 자격증명이 붙었는지, 어떤 방식으로 집계되는지, itemId 가 무엇으로 오는지 본다.
 *   itemId 실제 값을 봐야 우리 상품코드와 어떻게 이을지 정할 수 있다.
 */
async function probe({ days = 28 } = {}) {
  const cfg = api.configStatus();
  if (!api.isConfigured()) return { configured: false, config: cfg };

  const start = daysAgo(days), end = daysAgo(0);
  const out = { configured: true, config: cfg, start_date: start, end_date: end, sites: [] };

  for (const site of api.SITE_KEYS) {
    const entry = { site, property_id: api.PROPERTIES[site] };
    try {
      const summary = await siteSummary(site, start, end);
      entry.sessions = summary?.sessions ?? 0;
      entry.transactions = summary?.transactions ?? 0;
      entry.revenue = summary?.purchaseRevenue ?? 0;
    } catch (e) {
      entry.error = String(e.message).slice(0, 400);
      out.sites.push(entry);
      continue;
    }
    try {
      const r = await itemReport(site, start, end, 10);
      entry.item_mode = r.rows.length > 0;
      entry.item_metrics = r.metrics;
      // itemId 가 우리 상품코드인지 눈으로 확인할 샘플
      entry.item_samples = r.rows.slice(0, 10).map(x => ({
        itemId: x.itemId, itemName: x.itemName, viewed: x.itemsViewed, purchased: x.itemsPurchased,
      }));
    } catch (e) {
      entry.item_mode = false;
      entry.item_error = String(e.message).slice(0, 300);
    }
    try {
      const r = await pageReport(site, start, end, 10);
      entry.page_samples = r.rows.slice(0, 10).map(x => ({
        path: x.pagePath, views: x.screenPageViews,
      }));
    } catch (e) {
      entry.page_error = String(e.message).slice(0, 300);
    }
    // 어떤 이벤트가 실제로 쌓이고 있는지 — 요소별 클릭 집계가 가능한지는 여기서 갈린다.
    //   click / select_item 같은 이벤트가 없으면 버튼 단위 수치는 애초에 존재하지 않는다.
    try {
      const r = await api.runReport(site, {
        dateRanges: [{ startDate: start, endDate: end }],
        dimensions: [{ name: 'eventName' }],
        metrics: [{ name: 'eventCount' }],
        orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
        limit: 40,
      });
      entry.events = api.flatten(r).map(x => ({ name: x.eventName, count: x.eventCount }));
    } catch (e) {
      entry.events_error = String(e.message).slice(0, 300);
    }
    // 요소를 구분하려면 커스텀 차원(예: click_element_id)이 등록돼 있어야 한다
    try {
      const meta = await api.getMetadata(site);
      entry.custom_dimensions = (meta.dimensions || [])
        .filter(d => d.customDefinition)
        .map(d => ({ api_name: d.apiName, label: d.uiName }));
    } catch (e) {
      entry.metadata_error = String(e.message).slice(0, 300);
    }
    out.sites.push(entry);
  }
  return out;
}

module.exports = { productReport, probe, siteSummary };
