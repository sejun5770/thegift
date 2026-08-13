/**
 * 상세페이지 클릭맵 — 실제 상세페이지 위에 GA 클릭수를 얹는다 (바른손카드).
 *
 * 데이터 (2026-08-13 실측):
 *   · 상세 경로: /Product/OptionDetail/{id} (답례품) · /Product/CardDetail/{id} (청첩장)
 *   · 페이지 제목이 '… | 상품코드' 형식이라 제목만으로 상품 매핑이 된다
 *   · element_click / all_link_click 이벤트에 click_id·click_text 커스텀 차원.
 *     click_id 는 대부분 비어 있고 click_text 가 실질 구분자다 — 화면 오버레이는
 *     스냅샷 DOM 의 요소 텍스트와 click_text 를 맞춰 위치를 잡는다 (클라이언트에서).
 *   · 같은 클릭이 element_click 과 all_link_click 양쪽에 잡히는 요소가 있다.
 *     둘을 합산하면 이중계상이다 — 이벤트별로 나눠 담고 절대 더하지 않는다.
 *
 * 스냅샷:
 *   상세페이지 HTML 을 서버가 대신 받아 <base> 를 붙이고 스크립트를 걷어낸 뒤 그대로 돌려준다.
 *   우리 origin 에서 서빙되므로 iframe 이 same-origin 이 되고, 클라이언트가 DOM 을 뒤져
 *   요소 위치에 배지를 붙일 수 있다. (외부 도메인 iframe 은 DOM 접근이 막힌다)
 *
 * 바른손몰(etc)은 click_text 커스텀 차원이 없어 (event_label 뿐, 건수도 빈약) v1 은 card 전용.
 */
'use strict';

const api = require('./api');

/** 사이트키 → 허용 host. 이 표에 없는 곳은 절대 fetch 하지 않는다 (SSRF 방지). */
const SNAPSHOT_HOSTS = {
  card: 'https://www.barunsoncard.com',
};

const ymd = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => ymd(new Date(Date.now() - n * 86400000 + 9 * 3600000));

/** '청첩장 브랜드 1위 바른손카드 | TGJSD01O4_B' → 'TGJSD01O4_B' */
function codeOfTitle(title) {
  const tail = String(title || '').split('|').pop().trim();
  return /^[A-Za-z0-9_\-]{3,}$/.test(tail) ? tail : null;
}

/**
 * 상세페이지 목록 — 페이지 선택 드롭다운용.
 *   giftOnly: 제목의 상품코드가 TGJ 로 시작하는 답례품만 (기본). 끄면 청첩장 포함 전체.
 */
async function listPages({ site = 'card', startDate, endDate, giftOnly = true, limit = 100 } = {}) {
  if (!SNAPSHOT_HOSTS[site]) throw new Error(`클릭맵을 지원하지 않는 사이트입니다: ${site}`);
  const start = startDate || daysAgo(28);
  const end = endDate || daysAgo(0);
  const res = await api.runReport(site, {
    dateRanges: [{ startDate: start, endDate: end }],
    dimensions: [{ name: 'pagePath' }, { name: 'pageTitle' }],
    metrics: [{ name: 'screenPageViews' }],
    dimensionFilter: {
      filter: {
        fieldName: 'pagePath',
        stringFilter: { matchType: 'CONTAINS', value: 'Detail', caseSensitive: false },
      },
    },
    orderBys: [{ metric: { metricName: 'screenPageViews' } , desc: true }],
    limit: 500,
  });
  const rows = [];
  const seen = new Set();
  for (const r of api.flatten(res)) {
    const path = String(r.pagePath || '');
    if (!/^\/Product\/(Option|Card)Detail\/\d+$/i.test(path)) continue;   // 스냅샷 가능한 형태만
    if (seen.has(path)) continue;
    const code = codeOfTitle(r.pageTitle);
    if (giftOnly && !(code && code.toUpperCase().startsWith('TGJ'))) continue;
    seen.add(path);
    rows.push({ path, code, views: r.screenPageViews || 0 });
    if (rows.length >= limit) break;
  }
  return { site, start_date: start, end_date: end, gift_only: !!giftOnly, pages: rows };
}

/** 텍스트 정규화 — 공백을 하나로. 매칭·병합 공통 키. */
const normText = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/** 기기 필터 — PC/모바일 레이아웃이 별개 HTML 이라 (UA 분기, 2026-08-13 확인) 클릭도 기기로 가른다 */
const DEVICE_FILTER = {
  all: null,
  desktop: ['desktop'],
  mobile: ['mobile', 'tablet'],
};

/**
 * 한 페이지의 클릭 분해.
 *   (click_text, click_id) 로 묶고 이벤트별 건수를 나란히 둔다 — 합산하지 않는다.
 *   '구매후기 (3)' 처럼 텍스트에 유동 숫자가 들어가 여러 줄로 갈라지는 것은
 *   숫자 괄호를 뗀 base_text 로 병합한다 (매칭도 base_text 기준).
 *   사용자 수(totalUsers)도 함께 — 클릭수는 반복 클릭에 부풀 수 있어 사람 수가 보정 지표다.
 *   ⚠ 병합 시 users 는 단순 합산이라, 문구 변형 양쪽을 다 누른 사용자는 중복될 수 있다
 *     (드묾 — 변형은 시간대 분할이라 겹치려면 그 경계에 걸쳐 눌러야 한다). 응답 note 에 명시.
 */
async function clicksForPath({ site = 'card', path, startDate, endDate, device = 'all' } = {}) {
  if (!SNAPSHOT_HOSTS[site]) throw new Error(`클릭맵을 지원하지 않는 사이트입니다: ${site}`);
  if (!path) throw new Error('path 가 필요합니다');
  if (!(device in DEVICE_FILTER)) throw new Error(`device 는 all/desktop/mobile 중 하나입니다: ${device}`);
  const start = startDate || daysAgo(28);
  const end = endDate || daysAgo(0);
  const exprs = [
    { filter: { fieldName: 'eventName', inListFilter: { values: ['element_click', 'all_link_click'] } } },
    { filter: { fieldName: 'pagePath', stringFilter: { value: path } } },
  ];
  if (DEVICE_FILTER[device]) {
    exprs.push({ filter: { fieldName: 'deviceCategory', inListFilter: { values: DEVICE_FILTER[device] } } });
  }
  const res = await api.runReport(site, {
    dateRanges: [{ startDate: start, endDate: end }],
    dimensions: [
      { name: 'eventName' },
      { name: 'customEvent:click_id' },
      { name: 'customEvent:click_text' },
    ],
    metrics: [{ name: 'eventCount' }, { name: 'totalUsers' }],
    dimensionFilter: { andGroup: { expressions: exprs } },
    orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
    limit: 300,
  });

  const clean = (v) => {
    const s = normText(v);
    return (s === '(not set)' || s === '') ? null : s;
  };
  // '구매후기 (3)' → '구매후기' — 후기 개수가 늘 때마다 딴 줄이 되는 것을 막는다
  const baseOf = (t) => normText(String(t).replace(/\(\s*[\d,.]+\s*\)/g, ''));

  const by = new Map();
  for (const r of api.flatten(res)) {
    const text = clean(r['customEvent:click_text']);
    const id = clean(r['customEvent:click_id']);
    const key = text ? `t:${baseOf(text)}` : (id ? `i:${id}` : 'none');
    if (!by.has(key)) {
      by.set(key, {
        text: text ? baseOf(text) : null,
        click_id: id,
        element_click: 0,
        all_link_click: 0,
        element_users: 0,
        all_link_users: 0,
        variants: new Set(),
      });
    }
    const t = by.get(key);
    if (id && !t.click_id) t.click_id = id;
    if (text) t.variants.add(text);
    const n = Number(r.eventCount) || 0;
    const u = Number(r.totalUsers) || 0;
    if (r.eventName === 'element_click') { t.element_click += n; t.element_users += u; }
    else { t.all_link_click += n; t.all_link_users += u; }
  }
  const rows = [...by.values()].map(r => {
    // 배지에 쓸 대표값 — 두 이벤트 중 큰 쪽. 합산은 이중계상이라 금지지만,
    //   'element 우선' 은 함정이었다: 병합 키가 요소가 아니라 문구라서, 같은 문구의
    //   버튼(element 40)과 링크(all_link 900)가 한 줄이 되면 900 이 통째로 숨는다
    //   (리뷰 지적). max 는 숨기지도 더하지도 않는다.
    const useElement = r.element_click >= r.all_link_click;
    return {
      ...r,
      variants: [...r.variants].slice(0, 5),
      count: Math.max(r.element_click, r.all_link_click),
      count_source: useElement ? 'element_click' : 'all_link_click',
      // 사용자 수는 대표값과 같은 이벤트에서 — 다른 이벤트의 users 를 섞으면 기준이 어긋난다
      users: useElement ? r.element_users : r.all_link_users,
    };
  });
  rows.sort((a, b) => b.count - a.count);
  return {
    site, path, start_date: start, end_date: end, device,
    rows,
    note: '같은 클릭이 element_click·all_link_click 양쪽에 잡힐 수 있어 두 수는 합산하지 않습니다. '
      + '사용자 수는 문구 변형 병합 시 근소하게 중복될 수 있습니다.',
  };
}

// ── 스냅샷 ─────────────────────────────────────────────
const _snapCache = new Map();   // path → { at, html }
const SNAP_TTL = 10 * 60 * 1000;

/**
 * 상세페이지 HTML 스냅샷 — 스크립트 제거 + <base> 주입.
 *   iframe 은 sandbox(스크립트 불허)로 띄우지만, 서버에서도 걷어낸다 — 이중 방어.
 */
function sanitizeHtml(html, baseUrl) {
  let s = String(html);
  s = s.replace(/<script\b[\s\S]*?<\/script\s*>/gi, '');
  s = s.replace(/<script\b[^>]*\/?>/gi, '');                       // 닫는 태그 없는 script
  s = s.replace(/<meta[^>]+http-equiv\s*=\s*["']?refresh[^>]*>/gi, '');
  s = s.replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, ''); // 인라인 핸들러
  // <base> 는 head 맨 앞 — 상대경로 리소스(css/이미지)가 원 사이트에서 로드되게
  if (/<head[^>]*>/i.test(s)) s = s.replace(/<head[^>]*>/i, (m) => `${m}<base href="${baseUrl}/">`);
  else s = `<base href="${baseUrl}/">` + s;
  return s;
}

/**
 * device 별 UA — 사이트가 UA 로 PC/모바일 HTML 을 갈라 내려준다 (PC 766KB vs 모바일 112KB,
 * 모바일엔 reviewA id 도 없음 — GA 의 기기별 click_id 유무와 일치. 2026-08-13 확인).
 */
const SNAP_UA = {
  desktop: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 daeryepum-clickmap',
  mobile: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 daeryepum-clickmap',
};

async function snapshot({ site = 'card', path, device = 'desktop' } = {}) {
  const host = SNAPSHOT_HOSTS[site];
  if (!host) throw new Error(`스냅샷을 지원하지 않는 사이트입니다: ${site}`);
  const ua = SNAP_UA[device === 'mobile' ? 'mobile' : 'desktop'];
  // 경로 화이트리스트 — 상세페이지 형태만. 이 검증이 SSRF·오픈프록시를 막는 방어선이다.
  if (!/^\/Product\/(Option|Card)Detail\/\d+$/i.test(String(path || ''))) {
    throw new Error('상세페이지 경로만 허용됩니다 (/Product/OptionDetail/{id})');
  }
  const cacheKey = `${site}|${device === 'mobile' ? 'mobile' : 'desktop'}|${path}`;
  const cached = _snapCache.get(cacheKey);
  if (cached && Date.now() - cached.at < SNAP_TTL) return { html: cached.html, cached: true };

  const res = await fetch(host + path, {
    headers: { 'User-Agent': ua, Accept: 'text/html' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`상세페이지 로드 실패 [${res.status}] ${host}${path}`);
  // 리디렉트로 다른 호스트에 다녀왔으면 버린다
  if (res.url && !res.url.startsWith(host + '/')) {
    throw new Error(`허용되지 않은 위치로 리디렉트됨: ${res.url.slice(0, 120)}`);
  }
  const html = sanitizeHtml(await res.text(), host);
  _snapCache.set(cacheKey, { at: Date.now(), html });
  return { html, cached: false };
}

module.exports = { listPages, clicksForPath, snapshot, sanitizeHtml, codeOfTitle, normText, SNAPSHOT_HOSTS };
