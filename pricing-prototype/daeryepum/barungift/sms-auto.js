/**
 * 출고안내문자 자동 발송 (2026-09-14, migration 083)
 *
 *   매일 지정 시각(기본 19:00 KST)에 **출고일 기준**으로 — 커스텀 상품 주문시트와 월별 답례품 시트(전월·당월·익월)에서
 *   출고일이 오늘인 행을 읽어 (2026-09-15 운영 결정, 시트 선택 없음), 바른손카드·바른손몰 주문(사내 DB 에서 찾은 주문)에만 출고완료 안내
 *   문자를 보내고 결과를 슬랙으로 보고한다.
 *
 *   발송은 기존 [문자 바로 발송] 과 같은 경로(POST /api/bg/sms/send)를 컨테이너 내부에서 부른다 —
 *   번호·송장 검증, 주문#송장 중복 방지, 이력 기록이 모두 같다. 이미 보낸 주문은 자동으로 건너뛴다.
 *
 *   시트 읽기(giftSheetTabs/giftSmsRows)와 내부 발송 호출은 server.js 가 deps 로 넘긴다.
 *   설정은 bg_site_settings (sms_auto_*) — 화면에서 바꾸면 다음 tick 부터 반영된다 (30초 캐시).
 */
const store = require('./store');
const stockAlert = require('./stock-alert');

const DEFAULT_TIME = '19:00';
const MONTH_AUTO = '__month__';
const CATCHUP_WINDOW_MIN = 5;

let _cfgCache = { at: 0, val: null };
let _lastRun = null;   // { at, dry_run, ok, summary, error } — 화면 표시용 (프로세스 메모리)
let _running = false;

async function loadConfig() {
  if (_cfgCache.val && Date.now() - _cfgCache.at < 30000) return _cfgCache.val;
  let row = {};
  try { row = (await store.getSiteSettings()) || {}; } catch { /* 설정 조회 실패 → 기본값 */ }
  let fallbackChannel = '';
  try { fallbackChannel = (await stockAlert.loadAlertConfig()).channel || ''; } catch { /* 없으면 빈 값 */ }
  const val = {
    enabled: !!row.sms_auto_enabled,
    time: String(row.sms_auto_time || '').trim() || DEFAULT_TIME,
    sheet: String(row.sms_auto_sheet || '').trim() || MONTH_AUTO,
    channel: String(row.sms_auto_slack_channel || '').trim() || fallbackChannel,
    channel_from_db: !!String(row.sms_auto_slack_channel || '').trim(),
  };
  _cfgCache = { at: Date.now(), val };
  return val;
}
function invalidateConfig() { _cfgCache = { at: 0, val: null }; }
function getLastRun() { return _lastRun; }

/** KST 기준 오늘 'YYYY-MM-DD' */
function kstToday(now = new Date()) {
  return new Date(now.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}
function kstDateLabel(ymd) {
  const d = new Date(ymd + 'T00:00:00Z');
  return `${ymd} (${['일', '월', '화', '수', '목', '금', '토'][d.getUTCDay()]})`;
}
/** '2026-09-14' → 시트 탭 이름 '26년 9월' (giftSheetTabs 의 월별 탭 표기) */
function monthSheetName(ymd) {
  return `${ymd.slice(2, 4)}년 ${Number(ymd.slice(5, 7))}월`;
}
/** 설정값으로 실제 탭을 찾는다. 이름은 공백 차이를 무시하고 비교한다. */
function resolveSheet(sheets, setting, ymd) {
  const wanted = (!setting || setting === MONTH_AUTO) ? monthSheetName(ymd) : String(setting).trim();
  const norm = s => String(s || '').replace(/\s+/g, '');
  const tab = (sheets || []).find(t => norm(t.name) === norm(wanted)) || null;
  return { wanted, tab };
}

/** 'YYYY-MM-DD' 기준 delta 개월 뒤 월별 탭 이름 ('26년 10월') */
function monthNameOffset(ymd, delta) {
  const d = new Date(Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1 + delta, 1));
  return `${String(d.getUTCFullYear()).slice(2)}년 ${d.getUTCMonth() + 1}월`;
}
/**
 * 출고일 기준 자동 발송이 읽을 탭 — 커스텀 상품 주문시트 1개 + 월별 답례품 시트(전월·당월·익월).
 *   월별 탭은 희망출고월 기준이지만 월 착오 등록(수집누락 점검의 '다른 월 시트')이 있어 앞뒤 달도 본다.
 *   행은 어차피 출고일=오늘로 거른다.
 */
function resolveSheets(sheets, ymd) {
  const norm = s => String(s || '').replace(/\s+/g, '');
  const custom = (sheets || []).find(t => /커스텀/.test(t.name)) || null;
  const want = [-1, 0, 1].map(d => norm(monthNameOffset(ymd, d)));
  const monthly = (sheets || []).filter(t => want.includes(norm(t.name)));
  return { custom, monthly };
}
const KIND_LABEL = { custom: '커스텀 시트', monthly: '답례품 시트' };

/**
 * 오늘 출고 행 중 발송 대상을 고른다.
 *   대상 = 출고일이 오늘 + 사내 DB(바른손카드·바른손몰)에서 찾은 주문 + 이름·연락처·송장이 유효한 행.
 *   나머지는 사유별로 세어 리포트에 적는다 (다른 채널은 사이트별 건수까지).
 */
function selectRows(rows, ymd) {
  const today = (rows || []).filter(r => r && r.ship_date === ymd);
  const targets = [];
  const skipped = { other_channel: 0, other_by_site: {}, unknown_order: 0, no_invoice: 0, bad_phone: 0, no_name: 0, already_sent: 0, same_order: 0 };
  for (const r of today) {
    if (r.source !== 'mall') {
      if (r.source) { skipped.other_channel++; const s = r.site_name || r.source; skipped.other_by_site[s] = (skipped.other_by_site[s] || 0) + 1; }
      else skipped.unknown_order++;   // 사내 DB·더기프트·쿠팡·네이버 어디에도 없는 주문번호
      continue;
    }
    if (!r.name) { skipped.no_name++; continue; }
    if (!r.phone_ok) { skipped.bad_phone++; continue; }
    if (!r.invoice_ok) { skipped.no_invoice++; continue; }
    targets.push({ order_id: r.order_id, name: r.name, phone: r.phone, ship_date: r.ship_date, invoice: r.invoice, site_name: r.site_name || '' });
  }
  return { todayCount: today.length, targets, skipped };
}

/**
 * 이미 1회 이상 발송된 주문 제외 + 같은 주문 여러 행은 1건만 (주문 단위, 송장 무관).
 *   sentSet = 성공 발송 이력이 있는 주문번호 Set.
 */
function excludeAlreadySent(targets, sentSet) {
  const out = []; const seen = new Set(); let alreadySent = 0, sameOrder = 0;
  for (const t of targets || []) {
    const k = String(t.order_id || '');
    if (sentSet && sentSet.has(k)) { alreadySent++; continue; }
    if (seen.has(k)) { sameOrder++; continue; }
    seen.add(k); out.push(t);
  }
  return { targets: out, alreadySent, sameOrder };
}

/** 발송 결과(POST /api/bg/sms/send 응답 합산) 요약 */
function summarizeSend(results) {
  const out = { sent: 0, already: 0, merged: 0, failed: 0, failures: [] };
  for (const x of results || []) {
    if (x.success) out.sent++;
    else if (x.duplicate && /합쳤|1건만/.test(x.error || '')) out.merged++;
    else if (x.duplicate) out.already++;
    else { out.failed++; out.failures.push(`${String(x.order_id || '').split('#')[0]} — ${x.error || '알 수 없는 오류'}`); }
  }
  return out;
}

function _exclusionText(skipped = {}) {
  const ex = [];
  if (skipped.other_channel) {
    const by = Object.entries(skipped.other_by_site || {}).sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s} ${n}`).join(' · ');
    ex.push(`다른 채널 ${skipped.other_channel}${by ? ` (${by})` : ''}`);
  }
  if (skipped.already_sent) ex.push(`이미 발송 ${skipped.already_sent}`);
  if (skipped.same_order) ex.push(`같은 주문 추가 행 ${skipped.same_order}`);
  if (skipped.unknown_order) ex.push(`주문 미확인 ${skipped.unknown_order}`);
  if (skipped.no_invoice) ex.push(`송장 없음 ${skipped.no_invoice}`);
  if (skipped.bad_phone) ex.push(`연락처 형식 ${skipped.bad_phone}`);
  if (skipped.no_name) ex.push(`성함 없음 ${skipped.no_name}`);
  const total = ['other_channel', 'already_sent', 'same_order', 'unknown_order', 'no_invoice', 'bad_phone', 'no_name'].reduce((a, k) => a + (skipped[k] || 0), 0);
  return { total, text: ex.join(' · ') };
}

/** 슬랙 리포트 본문 (mrkdwn). 개인정보는 넣지 않는다 — 주문번호와 건수만. 시트 종류별로 한 줄씩. */
function buildReport({ ymd, time, sources, per, dryRun, error }) {
  const head = dryRun ? '🧪 *출고안내문자 자동 발송 미리보기* (발송 없음)' : '📨 *출고안내문자 자동 발송*';
  const lines = [`${head} — ${kstDateLabel(ymd)} ${time} KST`];
  if (error) { lines.push(`• ⚠️ 실패: ${error}`); return lines.join('\n'); }
  lines.push(`• 출고일 ${ymd} · 바른손카드·바른손몰 주문 · 시트 종류별 1회`);
  let anyRow = false, anyErr = false;
  for (const kind of ['custom', 'monthly']) {
    const label = KIND_LABEL[kind];
    const names = kind === 'custom' ? (sources && sources.custom ? [sources.custom] : []) : ((sources && sources.monthly) || []);
    if (!names.length) {
      lines.push(`• ${label}: 시트를 찾지 못했습니다 ${kind === 'custom' ? "(이름에 '커스텀' 이 들어간 탭)" : `(${monthNameOffset(ymd, -1)} · ${monthNameOffset(ymd, 0)} · ${monthNameOffset(ymd, 1)})`}`);
      continue;
    }
    const p = per && per[kind];
    if (!p) continue;
    const sheetText = names.map(n => `\`${n}\``).join(' ');
    if (p.error) { anyErr = true; lines.push(`• ${label} ${sheetText} — ⚠️ ${p.error} (이 시트 종류는 발송하지 않았습니다)`); continue; }
    if (p.todayCount) anyRow = true;
    const t = p.targets.length;
    let line = `• ${label} ${sheetText} — 오늘 행 ${p.todayCount} · 발송 대상 ${dryRun ? `*${t}건*` : `${t}건`}`;
    if (!dryRun && p.send) line += ` → *발송 ${p.send.sent}* · 실패 ${p.send.failed}${p.send.already ? ` · 발송 직전 중복 ${p.send.already}` : ''}`;
    lines.push(line);
    const ex = _exclusionText(p.skipped);
    if (ex.total) lines.push(`      제외 ${ex.total} — ${ex.text}`);
    if (p.send && p.send.failures.length) lines.push(`      실패: ${p.send.failures.slice(0, 10).join(' / ')}${p.send.failures.length > 10 ? ` 외 ${p.send.failures.length - 10}건` : ''}`);
  }
  if (!anyRow && !anyErr) lines.push('• 오늘 출고일로 적힌 행이 없습니다.');
  return lines.join('\n');
}

/**
 * 슬랙 리포트 — 운영이 한눈에 보는 요약만 (2026-09-17 운영 요청). 제외 사유·실패 주문번호 같은 상세는
 *   대시보드 문자발송 화면의 실행 기록(buildReport)에 남는다.
 *   :incoming_envelope: 출고안내문자 자동 발송 — 2026-09-17 (목)
 *   커스텀 주문 : N건(성공 : n건, 실패 : n건)
 *   답례품 주문 : N건(성공 : n건, 실패 : n건)
 *   N = 발송 대상(이미 발송·다른 채널 등 제외 후). 보내지 못한 경우는 이유를 한 줄로 적는다 — 조용히 0건으로 보이면 안 된다.
 */
const SLACK_KIND_LABEL = { custom: '커스텀 주문', monthly: '답례품 주문' };
function buildSlackReport({ ymd, sources, per, error }) {
  const lines = [`:incoming_envelope: 출고안내문자 자동 발송 — ${kstDateLabel(ymd)}`];
  if (error) { lines.push(`:warning: 발송하지 못했습니다 — ${error}`); return lines.join('\n'); }
  for (const kind of ['custom', 'monthly']) {
    const label = SLACK_KIND_LABEL[kind];
    const hasSheet = kind === 'custom' ? !!(sources && sources.custom) : !!(sources && sources.monthly && sources.monthly.length);
    const p = per && per[kind];
    if (!hasSheet || !p) { lines.push(`${label} : 시트를 찾지 못해 발송하지 않았습니다`); continue; }
    if (p.error) { lines.push(`${label} : :warning: 발송하지 못했습니다 (${p.error})`); continue; }
    const sent = p.send ? p.send.sent : 0, failed = p.send ? p.send.failed : 0;
    lines.push(`${label} : ${p.targets.length}건(성공 : ${sent}건, 실패 : ${failed}건)`);
  }
  return lines.join('\n');
}

/**
 * 한 번 실행. deps = { giftSheetTabs, giftSmsRows, sentOrders(ids, kind), sendRows(rows, kind), postToSlack }
 *   출고일 기준 — 커스텀 시트와 월별 답례품 시트를 시트 종류별로 나눠 고르고·제외하고·보낸다.
 *   dryRun 이면 대상만 고르고 문자·슬랙 모두 보내지 않는다 (화면 미리보기용).
 *   한 시트 종류에서 오류(이력 조회 실패 등)가 나면 그 종류는 보내지 않고, 다른 종류는 자기 이력으로 판단해 진행한다.
 */
async function run(deps, { dryRun = false, now = new Date() } = {}) {
  if (_running) throw new Error('자동 발송이 이미 실행 중입니다');
  _running = true;
  try {
    const startedAt = new Date().toISOString();
    const cfg = await loadConfig();
    const ymd = kstToday(now);
    const ctx = { ymd, time: cfg.time, sources: { custom: null, monthly: [] }, per: {}, dryRun, error: null };
    try {
      const { sheets } = await deps.giftSheetTabs();
      const src = resolveSheets(sheets, ymd);
      ctx.sources = { custom: src.custom ? src.custom.name : null, monthly: src.monthly.map(t => t.name) };
      for (const kind of ['custom', 'monthly']) {
        const tabs = kind === 'custom' ? (src.custom ? [src.custom] : []) : src.monthly;
        if (!tabs.length) continue;
        const p = { todayCount: 0, targets: [], skipped: {}, send: null, error: null };
        ctx.per[kind] = p;
        try {
          const rows = [];
          for (const tab of tabs) rows.push(...((((await deps.giftSmsRows(tab.gid)) || {}).rows) || []));
          const sel = selectRows(rows, ymd);
          // 이미 발송된 주문 제외 — 그 시트 종류 안에서. 미리보기에도 반영. 이력 조회 실패면 이 종류는 보내지 않는다.
          const sentSet = sel.targets.length ? await deps.sentOrders(sel.targets.map(t => t.order_id), kind) : new Set();
          const ex = excludeAlreadySent(sel.targets, sentSet);
          p.todayCount = sel.todayCount;
          p.targets = ex.targets;
          p.skipped = { ...sel.skipped, already_sent: ex.alreadySent, same_order: ex.sameOrder };
          if (!dryRun) p.send = p.targets.length ? summarizeSend(await deps.sendRows(p.targets, kind)) : summarizeSend([]);
        } catch (e) {
          p.error = e.message;
        }
      }
    } catch (e) {
      ctx.error = e.message;
    }
    const text = buildReport(ctx);   // 화면 실행 기록용 상세
    let slack = null;
    if (!dryRun) {
      try { slack = await deps.postToSlack(buildSlackReport(ctx), { channel: cfg.channel || null }); }
      catch (e) { slack = { error: e.message }; console.warn('[sms-auto] 슬랙 리포트 실패:', e.message); }
    }
    const kinds = Object.keys(ctx.per);
    const sum = f => kinds.reduce((a, k) => a + (f(ctx.per[k]) || 0), 0);
    const send = dryRun ? null : { sent: sum(p => p.send && p.send.sent), already: sum(p => p.send && p.send.already), failed: sum(p => p.send && p.send.failed) };
    const per = Object.fromEntries(kinds.map(k => { const p = ctx.per[k]; return [k, { today: p.todayCount, targets: p.targets.length, skipped: p.skipped, send: p.send, error: p.error }]; }));
    const err = ctx.error || kinds.map(k => ctx.per[k].error).find(Boolean) || null;
    const summary = { ymd, sources: ctx.sources, per, today: sum(p => p.todayCount), targets: sum(p => p.targets.length), send, slack, text };
    _lastRun = { at: startedAt, dry_run: dryRun, ok: !err, error: err, summary };
    if (err) throw Object.assign(new Error(err), { summary });
    return summary;
  } finally {
    _running = false;
  }
}

/** HH:MM → 자정 이후 분. 형식이 이상하면 null (stock-alert 와 같은 규칙). */
function parseHhmm(s) {
  const m = /^\s*(\d{1,2})\s*:\s*(\d{1,2})\s*$/.exec(String(s || ''));
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (!(h >= 0 && h <= 23 && mi >= 0 && mi <= 59)) return null;
  return h * 60 + mi;
}

/** 지금 tick 에서 발송해야 하는지 — 순수 판정 (테스트용으로 분리). */
function shouldFireNow(cfg, now, lastSentDate) {
  if (!cfg.enabled) return { fire: false, why: 'disabled' };
  const kst = new Date(now.getTime() + 9 * 3600 * 1000);
  const today = kst.toISOString().slice(0, 10);
  const target = parseHhmm(cfg.time);
  if (target == null) return { fire: false, why: 'bad_time' };
  if (lastSentDate === today) return { fire: false, why: 'already_today' };
  const nowMin = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  const delta = nowMin - target;
  if (delta < 0 || delta > CATCHUP_WINDOW_MIN) return { fire: false, why: 'outside_window' };
  return { fire: true, today };
}

/** 매일 지정 시각 자동 실행 — 1분마다 설정을 보고, 시각 창(+5분) 안에서 하루 1회. */
function scheduleDaily(deps) {
  let lastSentDate = null;
  async function tick() {
    let cfg;
    try { cfg = await loadConfig(); } catch { return; }
    const d = shouldFireNow(cfg, new Date(), lastSentDate);
    if (!d.fire) return;
    lastSentDate = d.today;   // 실패해도 같은 날 다시 돌지 않는다 (중복 발송 방지)
    try {
      const s = await run(deps, { dryRun: false });
      console.log(`[sms-auto] ${d.today} ${cfg.time} 실행 — 커스텀 ${s.sources && s.sources.custom ? 'O' : 'X'} · 답례품 ${((s.sources && s.sources.monthly) || []).join(',') || 'X'} · 오늘 행 ${s.today} · 대상 ${s.targets} · 발송 ${s.send ? s.send.sent : 0}`);
    } catch (e) {
      console.error('[sms-auto] 실행 실패:', e.message);
    }
  }
  setInterval(() => { tick().catch(() => {}); }, 60000);
  console.log('[sms-auto] 출고안내문자 자동 발송 감시 시작 — 설정(사용/시각/채널)은 문자발송 화면에서 변경 · 대상은 출고일 기준');
}

module.exports = {
  MONTH_AUTO, DEFAULT_TIME,
  loadConfig, invalidateConfig, getLastRun,
  kstToday, monthSheetName, monthNameOffset, resolveSheet, resolveSheets, selectRows, excludeAlreadySent, summarizeSend, buildReport, buildSlackReport,
  parseHhmm, shouldFireNow, run, scheduleDaily,
};
