/**
 * CJ대한통운 배송조회 + 주문 → 송장 찾기 (고객 order-info 페이지용).
 *
 * 조회 경로 (2026-08-28 실측 — trace.cjlogistics.com 공개 조회창이 쓰는 JSON):
 *   POST /next/rest/selectTrackingWaybil.do      wblNo=...  → 기본정보 (수령인·상태)
 *   POST /next/rest/selectTrackingDetailList.do  wblNo=...  → 이력 (집화→간선→배송출발→배달완료)
 *   CSRF·쿠키 불요. 구 경로 /rest/tracking/detail 은 404 (개편됨).
 *
 * 송장 소스 (우선순위):
 *   1) bg_order_invoices (출고처리 모달) — 단, 이 테이블은 아직 Supabase 에 없을 수 있어
 *      (migration 017 미실행 확인, 2026-08-28) 실패는 조용히 넘어간다.
 *   2) 운영 구글시트 (커스텀 상품·월별) — 어제 문자안내 기능이 쓰는 그 시트.
 *      열 매핑은 server.js GIFT_SHEET_KINDS 실측(2026-08-27)과 같은 값이다.
 *      ⚠ server.js 쪽 매핑을 바꾸면 여기도 같이 바꿔야 한다 (서버 헬퍼가 미노출이라 복제).
 *
 * ⚠ 주문번호 충돌: 시트 주문번호는 접두 없는 숫자라 CARD seq 와 ETC seq 가 같은 값이면
 *   구분할 수 없다 (둘 다 7자리 같은 대역). 시트에 사이트 열이 없어 원천적으로 못 가른다.
 *   같은 숫자의 다른 주문이 시트에 있을 확률은 낮지만 0이 아니다 — 그 경우 다른 주문의
 *   배송상태가 보일 수 있다. 고객 개인정보는 CJ 응답에서 걷어내므로(아래) 노출은 상태뿐이다.
 *
 * 개인정보: CJ 응답의 수령인 이름/주소(마스킹돼 있어도)는 고객 화면에 그대로 흘리지 않는다.
 *   상태 이력(일시·상태·지점)만 정규화해 내보낸다.
 */
'use strict';

const CJ_HOST = 'https://trace.cjlogistics.com';
const SHEET_ID = process.env.GIFT_SHEET_ID || '1CsoTkZ2PTaicT7jwgYE_8PiBDrG0RlR5z2R1mgOm8yY';

// 열 매핑 (0-based) — server.js GIFT_SHEET_KINDS 와 동일해야 한다
const SHEET_KINDS = {
  custom:  { headerRows: 2, cols: { order: 3, ship: 32, invoice: 33 } },
  monthly: { headerRows: 3, cols: { order: 3, ship: 22, invoice: 28 } },
};

const _cache = new Map();   // key → { at, data }
const cGet = (k, ttl) => { const h = _cache.get(k); return h && Date.now() - h.at < ttl ? h.data : null; };
const cSet = (k, d) => { _cache.set(k, { at: Date.now(), data: d }); if (_cache.size > 500) _cache.clear(); };

const digits = (s) => String(s || '').replace(/\D/g, '');

// ── CJ 조회 ───────────────────────────────────────────
async function cjPost(path, no) {
  const res = await fetch(CJ_HOST + path, {
    method: 'POST',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      Referer: `${CJ_HOST}/next/tracking.html?wblNo=${no}`,
    },
    body: new URLSearchParams({ wblNo: no }).toString(),
    signal: AbortSignal.timeout(10000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`CJ 조회 HTTP ${res.status}`);
  let j; try { j = JSON.parse(text); } catch { throw new Error('CJ 응답이 JSON 이 아닙니다'); }
  return j;
}

/**
 * 송장 1건 조회 → { registered, delivered, status, steps[] } (10분 캐시).
 *   등록 안 된 송장(집화 전)은 registered:false — 오류가 아니다. 출고 당일 흔한 상태.
 */
async function trackCj(invoiceNo) {
  const no = digits(invoiceNo);
  if (no.length < 10 || no.length > 14) throw new Error('송장번호 형식이 아닙니다');
  const hit = cGet(`cj:${no}`, 10 * 60 * 1000);
  if (hit) return hit;

  const detail = await cjPost('/next/rest/selectTrackingDetailList.do', no);
  const list = detail?.data?.svcOutList || [];
  const steps = list.map(x => ({
    date: x.workDt || '',
    time: String(x.workHms || '').slice(0, 5),
    status: x.crgStDnm || '',
    desc: x.crgStDcdVal || '',
    location: x.branNm || '',
    code: x.crgStDcd || '',
  })).filter(s => s.status);

  const last = steps[steps.length - 1] || null;
  const delivered = !!last && (/배달\s*완료/.test(last.status) || last.code === '91');
  const out = {
    invoice_no: no,
    registered: steps.length > 0,
    delivered,
    status: last ? last.status : '운송장 등록 전',
    status_desc: last ? last.desc : '아직 택배사에 접수되지 않았습니다. 출고 당일 저녁부터 조회됩니다.',
    last_update: last ? `${last.date} ${last.time}` : null,
    steps,
  };
  cSet(`cj:${no}`, out);
  return out;
}

// ── 시트에서 주문 → 송장 ─────────────────────────────
async function sheetFetch(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (daeryepum-dashboard)' },
    redirect: 'follow',
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  if (!res.ok || /accounts\.google\.com|ServiceLogin/i.test(text.slice(0, 3000))) {
    throw new Error('시트 접근 실패');
  }
  return text;
}

function parseCsv(text) {
  const rows = []; let row = []; let cur = ''; let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (ch !== '\r') cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

async function sheetTabs() {
  const hit = cGet('tabs', 10 * 60 * 1000);
  if (hit) return hit;
  const html = await sheetFetch(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/htmlview`);
  const tabs = [];
  const re = /items\.push\(\{name: "([^"]*)"[^}]*?gid=(\d+)/g;
  let m;
  while ((m = re.exec(html))) tabs.push({ name: m[1].split('\\/').join('/'), gid: m[2] });
  const custom = tabs.filter(t => /커스텀/.test(t.name));
  // 시트에는 미래 월 탭(26년 12월, 27년 1월 …)이 빈 채로 미리 만들어져 있다 (2026-08-28 확인).
  // 단순 최신순이면 빈 미래 탭만 골라 아무것도 못 찾는다 — '이번 달 이하' 중 최신 2개를 고른다.
  const key = t => { const mm = t.name.match(/(\d{2})년\s*(\d{1,2})월/); return Number(mm[1]) * 100 + Number(mm[2]); };
  const kst = new Date(Date.now() + 9 * 3600 * 1000);
  const nowKey = (kst.getUTCFullYear() % 100) * 100 + (kst.getUTCMonth() + 1);
  const monthly = tabs.filter(t => /^\d{2}년\s*\d{1,2}월$/.test(t.name.trim()))
    .filter(t => key(t) <= nowKey)
    .sort((a, b) => key(b) - key(a));
  // 고객 조회는 최근 주문이다 — 월별 최신 2개 + 커스텀만 훑는다 (전 탭 스캔은 느리고 불필요)
  const picked = [...monthly.slice(0, 2), ...custom];
  cSet('tabs', picked);
  return picked;
}

/** 주문번호로 시트에서 송장 찾기 → [{ invoice, ship_date, sheet }] */
async function sheetInvoicesForOrder(orderId) {
  const want = digits(String(orderId).replace(/^ETC-/i, ''));
  if (!want) return [];
  const hit = cGet(`inv:${want}`, 60 * 1000);
  if (hit) return hit;

  const out = [];
  for (const tab of await sheetTabs()) {
    const kind = /커스텀/.test(tab.name) ? 'custom' : 'monthly';
    const { headerRows, cols } = SHEET_KINDS[kind];
    let csv = cGet(`csv:${tab.gid}`, 60 * 1000);
    if (csv == null) {
      csv = await sheetFetch(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${tab.gid}`);
      cSet(`csv:${tab.gid}`, csv);
    }
    for (const r of parseCsv(csv).slice(headerRows)) {
      if (digits(r[cols.order]) !== want) continue;
      const inv = String(r[cols.invoice] ?? '').trim();
      const invDigits = digits(inv);
      // 숫자 송장만 — '취소'·'추가'·'퀵 출고' 같은 메모값 제외 (문자안내 기능과 같은 기준)
      if (!/^[\d-]+$/.test(inv) || invDigits.length < 9) continue;
      if (out.some(x => x.invoice === invDigits)) continue;
      out.push({ invoice: invDigits, ship_date: String(r[cols.ship] ?? '').trim(), sheet: tab.name });
    }
    if (out.length) break;   // 최신 시트에서 찾았으면 그걸로 충분
  }
  cSet(`inv:${want}`, out);
  return out;
}

module.exports = { trackCj, sheetInvoicesForOrder };
