/**
 * 답례품 재고 데일리 슬랙 알림.
 *
 *   bg_stock_alerts 에 등록된 품목코드만 골라 /api/daeryepum-stock 결과에서
 *   재고 현황을 뽑아 슬랙 메시지로 만들어 보낸다.
 *
 * 발송 채널 (둘 중 하나만 있으면 됨. 봇 토큰 우선):
 *   SLACK_BOT_TOKEN + BG_STOCK_SLACK_CHANNEL   ← chat.postMessage
 *   BG_STOCK_SLACK_WEBHOOK                     ← Incoming Webhook
 *
 * 스케줄:
 *   BG_STOCK_ALERT_ENABLED=1   자동 발송 켜기 (미설정이면 수동 발송만 가능)
 *   BG_STOCK_ALERT_TIME=09:00  KST 발송 시각 (기본 09:00)
 *
 * ※ 채널·시각·사용여부는 화면(설정)에서 바꿀 수 있고, DB 값이 환경변수보다 우선한다.
 *   (migration 049 — bg_site_settings.stock_alert_*)
 */
const https = require('https');
const store = require('./store');

const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN || '';
const SLACK_CHANNEL = process.env.BG_STOCK_SLACK_CHANNEL || '';
const SLACK_WEBHOOK = process.env.BG_STOCK_SLACK_WEBHOOK || '';

// 채널/시각은 화면에서 바꿀 수 있다 (migration 049).
//   우선순위: DB(bg_site_settings) > 환경변수.
//   30초 캐시 — 발송/미리보기마다 설정을 다시 읽지 않도록.
let _cfgCache = { at: 0, val: null };
async function loadAlertConfig() {
  if (_cfgCache.val && Date.now() - _cfgCache.at < 30000) return _cfgCache.val;
  let row = {};
  try { row = (await store.getSiteSettings()) || {}; } catch { /* 실패 시 환경변수만 */ }
  const val = {
    channel: String(row.stock_alert_channel || '').trim() || SLACK_CHANNEL,
    time: String(row.stock_alert_time || '').trim() || (process.env.BG_STOCK_ALERT_TIME || '09:00'),
    enabled: row.stock_alert_enabled == null
      ? (process.env.BG_STOCK_ALERT_ENABLED === '1')
      : !!row.stock_alert_enabled,
    from_db: {
      channel: !!String(row.stock_alert_channel || '').trim(),
      time: !!String(row.stock_alert_time || '').trim(),
      enabled: row.stock_alert_enabled != null,
    },
  };
  _cfgCache = { at: Date.now(), val };
  return val;
}
/** 설정 변경 직후 즉시 반영 */
function invalidateAlertConfig() { _cfgCache = { at: 0, val: null }; }

/** 발송 수단이 설정되어 있는지 (환경변수 기준 — 화면 표시용) */
function slackConfigured() {
  return !!((SLACK_TOKEN && SLACK_CHANNEL) || SLACK_WEBHOOK);
}

function _postJson(urlStr, payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        ...headers,
      },
      timeout: 15000,
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('timeout', () => { req.destroy(new Error('Slack 요청 timeout (15s)')); });
    req.on('error', reject);
    req.end(body);
  });
}

/**
 * 슬랙 전송 — 봇 토큰이 있으면 chat.postMessage, 없으면 webhook.
 *   threadTs 를 주면 해당 메시지의 스레드 댓글로 달린다 (봇 토큰 경로 전용).
 *   webhook 은 스레드를 지원하지 않는다.
 */
async function postToSlack(text, { channel: channelOverride = null, threadTs = null } = {}) {
  const channel = channelOverride || SLACK_CHANNEL;
  if (SLACK_TOKEN && channel) {
    const payload = { channel, text, mrkdwn: true };
    if (threadTs) payload.thread_ts = threadTs;
    const r = await _postJson('https://slack.com/api/chat.postMessage',
      payload,
      { Authorization: `Bearer ${SLACK_TOKEN}` });
    let parsed = {};
    try { parsed = JSON.parse(r.body); } catch { /* 비-JSON 응답 */ }
    if (!parsed.ok) throw new Error(`Slack chat.postMessage 실패: ${parsed.error || r.body.slice(0, 200)}`);
    return { via: 'bot', channel, ts: parsed.ts };
  }
  if (SLACK_WEBHOOK) {
    if (threadTs) throw new Error('webhook 은 스레드 댓글을 지원하지 않습니다');
    const r = await _postJson(SLACK_WEBHOOK, { text });
    if (r.status !== 200) throw new Error(`Slack webhook 실패 [${r.status}]: ${r.body.slice(0, 200)}`);
    return { via: 'webhook' };
  }
  throw new Error('슬랙 발송 설정 없음 — SLACK_BOT_TOKEN + BG_STOCK_SLACK_CHANNEL 또는 BG_STOCK_SLACK_WEBHOOK 필요');
}

/** 스레드 댓글(= 봇 토큰 + 채널) 사용 가능 여부.
 *   channelOverride 는 sendStockAlert 가 DB 설정을 해석해 넘겨준다. */
function canThread(channelOverride = null) {
  return !!(SLACK_TOKEN && (channelOverride || SLACK_CHANNEL));
}

function _fmt(n) {
  return (Number(n) || 0).toLocaleString('ko-KR');
}

/** KST 기준 'YYYY-MM-DD (요일)' */
function _kstDateLabel(d = new Date()) {
  const kst = new Date(d.getTime() + 9 * 3600 * 1000);
  const days = ['일', '월', '화', '수', '목', '금', '토'];
  return `${kst.toISOString().slice(0, 10)} (${days[kst.getUTCDay()]})`;
}

/** 상세 라인들을 슬랙 메시지 길이 제한 안쪽(3500자)으로 쪼갠다 */
function _chunkLines(lines, limit = 3500) {
  const chunks = [];
  let cur = '';
  for (const l of lines) {
    if (cur && cur.length + l.length + 1 > limit) { chunks.push(cur); cur = ''; }
    cur = cur ? `${cur}\n${l}` : l;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/**
 * 등록된 품목의 재고 현황을 조회해 메시지 텍스트까지 만든다.
 *   baseUrl: 자기 자신 (예: http://localhost:3457) — 재고 API 재사용
 *
 * 본문/스레드 분리 (2026-08-04 요청):
 *   summaryText  → 채널 본문. 상태 요약(건수 + 확인 필요 품목명)만.
 *   detailChunks → 스레드 댓글. 품목별 수치 상세. 길면 여러 댓글로 쪼갠다.
 *   text         → 스레드를 못 쓰는 webhook 용 합본.
 */
async function buildStockReport(baseUrl, { codes = null } = {}) {
  // 대상 선정
  //   codes 지정(개별 발송) → 그 재고코드만. 데일리 알림에서 빠져 있는(alert_enabled=false)
  //     품목도 보낼 수 있어야 하므로 alert_enabled 는 보지 않는다. 지금 이것만 보고 싶다는 뜻.
  //   codes 없음(데일리)   → 등록 품목 중 alert_enabled 인 것 (migration 044)
  const wanted = Array.isArray(codes)
    ? [...new Set(codes.map(c => String(c || '').trim()).filter(Boolean))]
    : null;
  const selected = !!(wanted && wanted.length);
  let targets;
  if (selected) {
    const want = new Set(wanted);
    targets = (await store.listStockItems({ enabledOnly: true })).filter(t => want.has(t.stock_code));
    const found = new Set(targets.map(t => t.stock_code));
    const unknown = wanted.filter(c => !found.has(c));
    if (!targets.length) {
      throw new Error(`등록되지 않은 재고코드입니다: ${unknown.join(', ')}`);
    }
    if (unknown.length) console.warn('[stock-alert] 개별 발송 — 등록되지 않은 코드 무시:', unknown.join(', '));
  } else {
    targets = await store.listStockItems({ alertOnly: true });
  }
  if (!targets.length) {
    return {
      rows: [], missing: [], warnCount: 0, soldoutCount: 0, targetCount: 0,
      selected, summaryText: null, detailChunks: [], text: null,
    };
  }

  // 세션 없는 내부 호출 — server.js 가 발급한 프로세스 토큰으로 auth gate 통과
  const res = await fetch(`${baseUrl}/api/daeryepum-stock`, {
    headers: { 'x-internal-token': process.env.BG_INTERNAL_TOKEN || '' },
  });
  const raw = await res.text();
  let data;
  try { data = JSON.parse(raw); }
  catch { throw new Error(`재고 API 가 JSON 이 아닌 응답 반환 [${res.status}] — 인증 게이트 확인 필요`); }
  if (data.error) throw new Error(`재고 조회 실패: ${data.error}`);

  const byCode = new Map();
  for (const it of (data.items || [])) byCode.set(it.stock_code, it);

  const rows = [];
  const missing = [];
  for (const t of targets) {
    const it = byCode.get(t.stock_code);
    if (!it) { missing.push(t.stock_code); continue; }
    // 경고 판정 — threshold 가 있으면 가용재고 기준, 없으면 소진예상 30일 기준
    const warn = t.threshold != null
      ? it.available_qty <= t.threshold
      : (it.days_to_soldout !== null && it.days_to_soldout <= 30);
    rows.push({
      stock_code: it.stock_code,
      product_name: it.product_name || t.label || '',
      threshold: t.threshold,
      current_qty: it.current_qty,
      available_qty: it.available_qty,
      sales_qty_30d: it.sales_qty_30d,
      consume_qty_30d: it.consume_qty_30d,
      daily_avg_30d: it.daily_avg_30d,
      days_to_soldout: it.days_to_soldout,
      soldout: it.available_qty <= 0,
      warn,
    });
  }

  // 소진 → 경고 → 정상 순, 각 그룹 안에서는 소진예상일 오름차순
  const rank = r => (r.soldout ? 0 : r.warn ? 1 : 2);
  rows.sort((a, b) => rank(a) - rank(b) || (a.days_to_soldout ?? 99999) - (b.days_to_soldout ?? 99999));

  /** 소진예상을 사람 말로 — 급한 정도가 바로 보이게 */
  const urgency = r => {
    if (r.soldout) return '재고 없음';
    if (r.days_to_soldout === null) return '최근 소진 실적 없음';
    return `${_fmt(r.days_to_soldout)}일 후 소진`;
  };

  /**
   * 스레드 상세 — 품목당 3줄.
   *   고정폭 표도 시도했으나 한글 상품명이 길어 잘리고 열이 붙어 오히려 읽기 어려웠다.
   *   이름 한 줄 / 핵심 수치 한 줄 / 코드 한 줄 로 세로로 편다.
   */
  const itemBlock = r => {
    const parts = [`가용 *${_fmt(r.available_qty)}개*`];
    const use = r.consume_qty_30d ?? r.sales_qty_30d;
    parts.push(`30일 소진 ${_fmt(use)}개`);
    if (r.daily_avg_30d) parts.push(`일평균 ${r.daily_avg_30d}`);
    if (r.threshold != null) parts.push(`임계 ${_fmt(r.threshold)}`);
    return `${r.soldout ? '⛔' : r.warn ? '⚠️' : '✅'}  *${r.product_name || r.stock_code}*  ·  ${urgency(r)}
`
      + `　　${parts.join('  ·  ')}
`
      + `　　\`${r.stock_code}\``;
  };

  const section = (title, rs) => rs.length
    ? [title, '', ...rs.flatMap(r => [itemBlock(r), ''])]
    : [];

  const soldoutRows = rows.filter(r => r.soldout);
  const warnRows = rows.filter(r => !r.soldout && r.warn);
  const okRows = rows.filter(r => !r.soldout && !r.warn);
  const attention = [...soldoutRows, ...warnRows];

  // ── 개별 발송: 요약/스레드로 나누지 않고 요청한 품목 상세만 한 메시지로 ──
  //   "지금 이 품목 상태"를 공유하려는 것이라, 건수 요약과 스레드 분리는 방해만 된다.
  //   품목이 많아 길어지면 아래 공통 경로처럼 스레드로 이어 붙인다.
  if (selected) {
    const head = [
      '📦  *답례품 재고 현황*  _(개별 조회)_',
      `_${_kstDateLabel()} · 요청 품목 ${rows.length}건_`,
      '',
    ];
    const body = rows.flatMap(r => [itemBlock(r), '']);
    if (missing.length) body.push(`_⚠️ 재고를 찾지 못한 코드 — ${missing.join(', ')}_`);
    const chunks = _chunkLines([...head, ...body]);
    const selSummary = chunks[0];
    const selDetails = chunks.slice(1);
    return {
      rows,
      missing,
      selected: true,
      warnCount: rows.filter(r => r.warn || r.soldout).length,
      soldoutCount: rows.filter(r => r.soldout).length,
      targetCount: targets.length,
      summaryText: selSummary,
      detailChunks: selDetails,
      text: [selSummary, ...selDetails].join('\n\n'),
    };
  }

  // ── 본문: 건수 + 급한 품목(예상일 포함) ──
  //   이름만 나열하면 무엇부터 봐야 할지 알 수 없어, 소진예상과 가용수량을 함께 적는다.
  const summary = [
    '📦  *답례품 재고 현황*',
    `_${_kstDateLabel()} · 관리 품목 ${targets.length}건_`,
    '',
    `⛔ 소진 *${soldoutRows.length}*     ⚠️ 확인 필요 *${warnRows.length}*     ✅ 정상 *${okRows.length}*`,
  ];
  if (attention.length) {
    summary.push('', '━━━━━━━━━━━━━━━━━━', '*🔴 조치 필요*', '');
    // 항목 사이 빈 줄 — 슬랙에서 블록이 붙어 보이지 않게
    summary.push(...attention.flatMap(r => [
      `${r.soldout ? '⛔' : '⚠️'}  *${r.product_name || r.stock_code}*\n`
      + `　　${urgency(r)}  ·  가용 ${_fmt(r.available_qty)}개`,
      '',
    ]).slice(0, -1));
  } else if (rows.length) {
    summary.push('', '✅  전 품목 재고 정상입니다.');
  } else {
    summary.push('', '등록된 품목의 재고 데이터를 찾지 못했습니다.');
  }
  if (missing.length) {
    summary.push('', `_⚠️ 재고를 찾지 못한 코드 ${missing.length}건 — ${missing.join(', ')}_`);
  }
  if (rows.length) summary.push('', '_전체 목록은 스레드에서_ 👇');

  // ── 스레드: 고정폭 표 (열 정렬) ──
  const detailLines = [
    ...section(`*⛔ 소진 ${soldoutRows.length}건*`, soldoutRows),
    ...section(`*⚠️ 확인 필요 ${warnRows.length}건*`, warnRows),
    ...section(`*✅ 정상 ${okRows.length}건*`, okRows),
  ];

  const summaryText = summary.join('\n');
  const detailChunks = detailLines.length ? _chunkLines(detailLines) : [];

  return {
    rows,
    missing,
    selected: false,
    warnCount: warnRows.length + soldoutRows.length,
    soldoutCount: soldoutRows.length,
    targetCount: targets.length,
    summaryText,
    detailChunks,
    // 스레드를 못 쓰는 webhook 용 합본
    text: [summaryText, ...detailChunks].join('\n\n'),
  };
}

/**
 * 리포트 생성 + 발송.
 *   dryRun=true 면 메시지만 만들고 슬랙에 보내지 않는다 (미리보기).
 *   codes  를 주면 그 재고코드만 담은 개별 발송이 된다 (데일리 알림 대상이 아니어도 발송).
 */
async function sendStockAlert(baseUrl, { dryRun = false, channel = null, codes = null } = {}) {
  // 명시 채널 > DB 설정 > 환경변수
  if (!channel) {
    try { channel = (await loadAlertConfig()).channel || null; } catch { /* 환경변수 폴백 */ }
  }
  const report = await buildStockReport(baseUrl, { codes });
  if (!report.summaryText) {
    return { ok: false, skipped: true, reason: '알림 대상 품목이 없습니다', ...report };
  }
  if (dryRun) return { ok: true, dryRun: true, threaded: canThread(channel), ...report };

  // 봇 토큰 + 채널이면 본문 1건 + 스레드 댓글 N건.
  if (canThread(channel)) {
    const parent = await postToSlack(report.summaryText, { channel });
    let replies = 0;
    for (const chunk of report.detailChunks) {
      await postToSlack(chunk, { channel, threadTs: parent.ts });
      replies++;
    }
    return { ok: true, threaded: true, sent: { ...parent, thread_replies: replies }, ...report };
  }
  // webhook 은 스레드 불가 — 요약 + 상세를 한 메시지로 합쳐 보낸다.
  const sent = await postToSlack(report.text, { channel });
  return { ok: true, threaded: false, sent, ...report };
}

/** 매일 KST 지정 시각 자동 발송. BG_STOCK_ALERT_ENABLED=1 일 때만 등록. */
/**
 * 자동 발송 — 1분마다 설정을 확인해 지정 시각에 하루 1회 보낸다.
 *   기동 시 한 번만 읽으면 화면에서 채널/시각을 바꿔도 재배포 전까지 반영되지 않아,
 *   매 tick 마다 loadAlertConfig() 로 최신 설정을 본다 (30초 캐시). 2026-08-06
 */
/** 발송 시각을 "자정 이후 분" 으로 변환. 형식이 이상하면 null.
 *  주의: parseInt(h) || 9 같은 falsy 폴백을 쓰면 '00:01' 의 0시가 9시로 바뀐다.
 *  (2026-08-06 자정 발송 누락 원인 — 20:27 은 정상 동작해 더 늦게 발견됐다.) */
function _parseHhmm(s) {
  const m = /^\s*(\d{1,2})\s*:\s*(\d{1,2})\s*$/.exec(String(s || ''));
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (!(h >= 0 && h <= 23 && mi >= 0 && mi <= 59)) return null;
  return h * 60 + mi;
}

/** 지정 시각을 놓쳤을 때 따라잡기 허용 범위(분). */
const CATCHUP_WINDOW_MIN = 5;

function scheduleDailyStockAlert(baseUrl) {
  let lastSentDate = null;   // 'YYYY-MM-DD' (KST) — 같은 날 중복 발송 방지

  async function tick() {
    let cfg;
    try { cfg = await loadAlertConfig(); }
    catch (e) { return; }                       // 설정 조회 실패 시 이번 tick 은 건너뜀
    if (!cfg.enabled) return;
    if (!(SLACK_TOKEN && cfg.channel) && !SLACK_WEBHOOK) return;   // 발송 수단 없음

    const kst = new Date(Date.now() + 9 * 3600 * 1000);
    const today = kst.toISOString().slice(0, 10);
    const target = _parseHhmm(cfg.time);
    if (target == null) return;                 // 형식 이상 — 발송하지 않음
    if (lastSentDate === today) return;

    // 정각 tick 이 밀려도 그날 발송이 통째로 사라지지 않도록 창(window)으로 판정.
    //   setInterval 60s 는 이벤트루프 지연으로 특정 분을 건너뛸 수 있어 '=== 같은 분' 은 취약했다.
    //   창을 벗어난 늦은 기동(재배포 등)에는 발송하지 않는다 — 엉뚱한 시각 발송 방지.
    const nowMin = kst.getUTCHours() * 60 + kst.getUTCMinutes();
    const delta = nowMin - target;
    if (delta < 0 || delta > CATCHUP_WINDOW_MIN) return;

    lastSentDate = today;   // 발송 실패해도 같은 날 재시도하지 않도록 먼저 표시
    const targetLabel = `${String(Math.floor(target / 60)).padStart(2, '0')}:${String(target % 60).padStart(2, '0')}`;
    try {
      const r = await sendStockAlert(baseUrl, {});
      console.log(`[stock-alert] 발송 완료 (${targetLabel} KST, 채널 ${cfg.channel || 'webhook'}) —`,
        `대상 ${r.targetCount}건 / 확인필요 ${r.warnCount}건`);
    } catch (err) {
      console.error('[stock-alert] 발송 실패:', err.message);
    }
  }

  setInterval(() => { tick().catch(() => {}); }, 60000);
  console.log('[stock-alert] 자동 발송 감시 시작 — 설정(채널/시각/사용여부)은 화면에서 변경 가능');
}

module.exports = {
  slackConfigured,
  loadAlertConfig,
  invalidateAlertConfig,
  canThread,
  buildStockReport,
  sendStockAlert,
  scheduleDailyStockAlert,
};
