/**
 * 오늘출발 현금영수증 슬랙 자동 전달 (2026-09-18 운영 요청, migration 085)
 *
 *   바른손카드·바른손몰 오늘출발 주문이 수집완료되면 #cs-더기프트 의 그날 스레드에 주문 1건 = 댓글 1개로
 *   현금영수증 정보를 남긴다. 재무팀이 오늘출발 서비스비용 입금을 확인하고 현금영수증을 발행하는 스레드로,
 *   지금까지 손으로 올리던 것을 자동화한 것이다.
 *
 *   스레드: "[9/18] 바른손카드, 바른손몰 답례품 오늘출발 서비스비용 입금확인 및 현금영수증 발행"
 *           + Sojeong Eo · Jiwon Chu · @팀-고객만족팀 멘션. 하루 1개, 그날 첫 대상 주문이 생길 때 만든다
 *           (대상이 없는 날은 빈 스레드를 만들지 않는다).
 *   댓글:   `3250823 / 김신애 / 소득공제 01093815077` — 정보입력현황의 [현금영수증 복사] 와 같은 형식.
 *
 *   대상 = 오늘(KST) 수집완료 + 오늘출발(주문 또는 상품 단위) + 사내 DB 주문 중 사이트가 바른손카드·바른손몰
 *          + 주문상태가 살아 있음(취소·환불·반품·미결제 취소 아님) + 아직 안 올린 주문.
 *   올린 주문은 express_receipt_posted_at 으로 표시 — 되돌리기 후 다시 수집완료해도 두 번 올리지 않는다.
 *
 *   수집완료 API 가 trigger() 를 부르면 몇 초 뒤 한 번 돌고, 5분마다도 돈다(슬랙 실패·다른 경로 수집완료 보충).
 *   실행은 한 번에 하나씩만 — 일괄 수집완료가 겹쳐도 스레드가 두 개 생기지 않는다.
 */
const store = require('./store');
const stockAlert = require('./stock-alert');

const CHANNEL = (process.env.EXPRESS_RECEIPT_SLACK_CHANNEL || 'C08TD7Y6ZNE').trim();   // #cs-더기프트
// Sojeong Eo · Jiwon Chu (재무팀) · @팀-고객만족팀 — 수동 스레드와 같은 멘션
const MENTIONS = '<@U09GW067740> <@U09V83U1GHW> <!subteam^S0946U2VA12>';
const SELF_MALL_SITES = new Set(['바른손카드', '바른손몰']);
// 이 날짜(KST)부터 수집완료된 주문만 올린다 — 배포 당일 이미 손으로 올린 스레드와 겹치지 않게.
const START_FROM = (process.env.EXPRESS_RECEIPT_SLACK_FROM || '2026-09-19').trim();
const SWEEP_MS = 5 * 60 * 1000;
const DEBOUNCE_MS = 5000;
const RECEIPT_LABEL = { personal: '소득공제', business: '지출증빙' };

let _deps = null;          // { getPool } — start() 가 넣는다
let _chain = Promise.resolve();
let _debounce = null;
let _thread = null;        // { date, ts } — DB 저장이 실패해도 같은 날 스레드를 또 만들지 않게
const _postedToday = new Set();   // `${ymd}|${order_id}` — 게시 후 표시 저장이 실패해도 다시 올리지 않게
let _warnedMigration = false;
let _lastRun = null;

function kstToday(now = new Date()) {
  return new Date(now.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}
function kstDayStartIso(ymd) {
  return new Date(`${ymd}T00:00:00+09:00`).toISOString();
}
function threadText(ymd) {
  const label = `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}`;
  return `[${label}] 바른손카드, 바른손몰 답례품 오늘출발 서비스비용 입금확인 및 현금영수증 발행\n${MENTIONS}`;
}

/** 오늘출발 — 주문 단위 플래그 또는 상품(출고 그룹) 단위 선택 중 하나라도. */
function isExpress(ci) {
  if (!ci) return false;
  if (ci.is_express === true) return true;
  return Array.isArray(ci.sticker_selections) && ci.sticker_selections.some(s => s && s.is_express === true);
}

/** 댓글 한 줄 — index.html copyExpressReceiptInfo 와 같은 형식. */
function receiptLine(orderSeq, name, ci) {
  let receipt;
  if (ci.cash_receipt_yn) {
    const type = RECEIPT_LABEL[ci.receipt_type] || ci.receipt_type || '';
    const num = String(ci.receipt_number || '').trim();
    receipt = (type + (num ? ' ' + num : '')).trim() || '발행';
  } else {
    receipt = '미발행';
  }
  return `${orderSeq} / ${String(name || '').trim()} / ${receipt}`;
}

/** 주문상태가 살아 있는지 — 대시보드 isCancelled 의 CARD/ETC 규칙과 같다 (+ ETC 반품완료 15). */
function isAlive(statusSeq, settleDate) {
  const s = Number(statusSeq);
  if (!Number.isFinite(s) || s < 1) return false;
  if (s === 3 || s === 5 || s === 15) return false;
  if ((s === 1 || s === 9) && !settleDate) return false;
  return true;
}

/**
 * order_id → { seq, site, status_seq, settle_date, order_name }.
 *   'ETC-n' 은 CUSTOM_ETC_ORDER, 숫자는 custom_order 먼저·없으면 CUSTOM_ETC_ORDER (ETC bare 키 레거시).
 *   CP-/NV- 등 다른 채널 주문번호는 아예 조회하지 않는다 (자사몰 아님).
 */
async function lookupOrders(getPool, orderIds) {
  const card = [], etc = [];
  for (const oid of orderIds) {
    const m = /^(ETC-)?(\d+)$/.exec(String(oid || '').trim());
    if (!m || Number(m[2]) > 2147483647) continue;
    (m[1] ? etc : card).push(Number(m[2]));
  }
  const out = new Map();
  if (!card.length && !etc.length) return out;
  const pool = await getPool();
  const cols = `CAST(x.order_seq AS VARCHAR(20)) AS seq, ISNULL(si.SiteName, CAST(x.company_Seq AS VARCHAR(20))) AS site,
                x.status_seq, CONVERT(varchar(19), x.settle_date, 120) AS settle_date, x.order_name`;
  const found = new Set();
  if (card.length) {
    const rs = await pool.request().query(`
      SELECT ${cols} FROM custom_order x WITH (NOLOCK)
      LEFT JOIN SiteInfo si WITH (NOLOCK) ON x.company_Seq = si.CompayCode
      WHERE x.order_seq IN (${card.join(',')})`);
    for (const r of rs.recordset) { out.set(String(r.seq), r); found.add(Number(r.seq)); }
  }
  const etcSeqs = [...new Set([...etc, ...card.filter(n => !found.has(n))])];
  if (etcSeqs.length) {
    const rs = await pool.request().query(`
      SELECT ${cols} FROM CUSTOM_ETC_ORDER x WITH (NOLOCK)
      LEFT JOIN SiteInfo si WITH (NOLOCK) ON x.company_Seq = si.CompayCode
      WHERE x.order_seq IN (${etcSeqs.join(',')})`);
    for (const r of rs.recordset) {
      if (etc.includes(Number(r.seq))) out.set(`ETC-${r.seq}`, r);
      if (!found.has(Number(r.seq)) && card.includes(Number(r.seq))) out.set(String(r.seq), r);
    }
  }
  return out;
}

/** 수집완료 행 중 올릴 주문과 제외 사유별 건수 — 순수 판정 (테스트용으로 분리). */
function selectTargets(rows, orders) {
  const targets = [];
  const skipped = { not_express: 0, not_mall: 0, other_site: 0, cancelled: 0 };
  for (const ci of rows || []) {
    if (!isExpress(ci)) { skipped.not_express++; continue; }
    const o = orders.get(String(ci.order_id));
    if (!o) { skipped.not_mall++; continue; }
    if (!SELF_MALL_SITES.has(String(o.site || '').trim())) { skipped.other_site++; continue; }
    if (!isAlive(o.status_seq, o.settle_date)) { skipped.cancelled++; continue; }
    targets.push({ order_id: ci.order_id, text: receiptLine(o.seq, o.order_name, ci) });
  }
  return { targets, skipped };
}

async function ensureThread(ymd, post) {
  if (_thread && _thread.date === ymd) return _thread.ts;
  const saved = await store.getExpressReceiptThread();
  if (saved.date === ymd && saved.ts) { _thread = saved; return saved.ts; }
  const r = await post(threadText(ymd), { channel: CHANNEL });
  if (!r || !r.ts) throw new Error('스레드 메시지 ts 를 받지 못했습니다 (봇 토큰 필요)');
  _thread = { date: ymd, ts: r.ts };
  try { await store.setExpressReceiptThread(ymd, r.ts); }
  catch (e) { console.error('[express-receipt] 스레드 ts 저장 실패 — 재시작하면 스레드가 새로 생길 수 있음:', e.message); }
  return r.ts;
}

async function _run({ now = new Date() } = {}) {
  const ymd = kstToday(now);
  const res = { at: new Date().toISOString(), ymd, candidates: 0, posted: 0, failed: 0, skipped: null, error: null };
  _lastRun = res;
  if (!_deps) { res.error = 'not_started'; return res; }
  if (ymd < START_FROM) { res.error = 'before_start'; return res; }
  if (!stockAlert.canThread(CHANNEL)) { res.error = 'slack_bot_not_configured'; return res; }
  if (_thread && _thread.date !== ymd) _thread = null;
  for (const k of _postedToday) if (!k.startsWith(ymd + '|')) _postedToday.delete(k);

  let rows;
  try {
    rows = await store.listProcessedUnpostedSince(kstDayStartIso(ymd));
  } catch (e) {
    if (/express_receipt_posted_at/.test(e.message)) {
      if (!_warnedMigration) console.warn('[express-receipt] migration 085 미적용 — 오늘출발 현금영수증 슬랙 전달을 하지 않습니다');
      _warnedMigration = true;
      res.error = 'migration_085_missing';
      return res;
    }
    throw e;
  }
  rows = rows.filter(ci => !_postedToday.has(`${ymd}|${ci.order_id}`));
  const express = rows.filter(isExpress);
  res.candidates = express.length;
  if (!express.length) return res;

  const orders = await lookupOrders(_deps.getPool, express.map(ci => ci.order_id));
  const { targets, skipped } = selectTargets(express, orders);
  res.skipped = skipped;
  if (!targets.length) return res;

  const post = _deps.postToSlack || stockAlert.postToSlack;
  const threadTs = await ensureThread(ymd, post);
  for (const t of targets) {
    try {
      await post(t.text, { channel: CHANNEL, threadTs });
    } catch (e) {
      res.failed++;
      console.error(`[express-receipt] ${t.order_id} 댓글 실패 (다음 실행에 다시 시도):`, e.message);
      continue;
    }
    _postedToday.add(`${ymd}|${t.order_id}`);
    res.posted++;
    try { await store.markExpressReceiptPosted(t.order_id); }
    catch (e) { console.error(`[express-receipt] ${t.order_id} 게시 표시 저장 실패:`, e.message); }
  }
  if (res.posted || res.failed) console.log(`[express-receipt] ${ymd} 댓글 ${res.posted}건${res.failed ? ` · 실패 ${res.failed}` : ''}`);
  return res;
}

/** 한 번 실행 — 동시에 두 번 돌지 않게 줄 세운다. */
function run(opts) {
  const p = _chain.then(() => _run(opts));
  _chain = p.catch(e => { console.error('[express-receipt] 실행 실패:', e.message); if (_lastRun) _lastRun.error = e.message; });
  return p;
}

/** 수집완료 직후 호출 — 여러 번 불려도 몇 초 뒤 한 번만 돈다. */
function trigger() {
  if (!_deps) return;
  if (_debounce) clearTimeout(_debounce);
  _debounce = setTimeout(() => { _debounce = null; run().catch(() => {}); }, DEBOUNCE_MS);
}

/** 서버 시작 시 1회. deps = { getPool, postToSlack? } */
function start(deps) {
  if (process.env.EXPRESS_RECEIPT_SLACK_DISABLED === '1') {
    console.log('[express-receipt] 비활성 (EXPRESS_RECEIPT_SLACK_DISABLED=1)');
    return;
  }
  _deps = deps;
  setInterval(() => { run().catch(() => {}); }, SWEEP_MS);
  console.log(`[express-receipt] 오늘출발 현금영수증 슬랙 전달 시작 — 채널 ${CHANNEL} · ${START_FROM} 수집완료분부터`);
}

function getLastRun() { return _lastRun; }

module.exports = {
  CHANNEL, MENTIONS, START_FROM,
  kstToday, kstDayStartIso, threadText, isExpress, receiptLine, isAlive, selectTargets, lookupOrders,
  run, trigger, start, getLastRun,
};
