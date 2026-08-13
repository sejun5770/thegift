/**
 * 외부채널 고객문의 수집 (065) — 쿠팡 · 네이버.
 *
 * 권한은 probe 로 확인했다 (2026-08-13):
 *   · 쿠팡 고객센터 문의조회  /callCenterInquiries  — 200, partnerCounselingStatus 필수, 기간 최대 7일
 *   · 쿠팡 상품별 고객문의    /onlineInquiries      — 200
 *   · 네이버 고객문의        /external/v1/pay-user/inquiries — 200, startSearchDate/endSearchDate 필수
 *
 * 필드 이름 주의:
 *   probe 시점에 세 API 모두 조회 결과가 비어 있어(최근 문의 없음) 실제 필드명을 못 봤다.
 *   그래서 후보 키를 여러 개 놓고 먼저 잡히는 것을 쓰고, raw_payload 에 원본을 통째로 남긴다.
 *   실제 문의가 들어오면 raw_payload 를 보고 정규화를 조이면 된다 — 데이터는 잃지 않는다.
 */
'use strict';

const REST = (process.env.SUPABASE_URL || '').replace(/\/$/, '') + '/rest/v1';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';
const USE = !!(process.env.SUPABASE_URL && KEY);
const HDR = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

/** 후보 키 중 먼저 값이 있는 것 */
function pick(obj, keys) {
  for (const k of keys) {
    const v = k.split('.').reduce((o, part) => (o == null ? o : o[part]), obj);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return null;
}

function toIso(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number' || /^\d{12,14}$/.test(String(v))) {
    const d = new Date(Number(v));
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  let s = String(v).trim();
  if (s.includes(' ') && !s.includes('T')) s = s.replace(' ', 'T');
  if (!/[+-]\d{2}:?\d{2}$|Z$/i.test(s)) s += '+09:00';
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/** KST 기준 'YYYY-MM-DD' */
const ymd = (ms) => new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 10);

/** 응답에서 목록을 꺼낸다 — 채널마다 감싸는 모양이 다르다 */
function listOf(res) {
  if (Array.isArray(res)) return res;
  for (const path of ['data.content', 'content', 'data.items', 'data', 'items']) {
    const v = path.split('.').reduce((o, p) => (o == null ? o : o[p]), res);
    if (Array.isArray(v)) return v;
  }
  return [];
}

/**
 * 문의일시 후보 키.
 *   네이버 실제 필드는 inquiryRegistrationDateTime 이다 (2026-08-13 raw_payload 로 확인).
 *   이 값이 비면 목록의 기간 필터에서 통째로 빠져 '문의를 못 가져온다' 로 보인다 —
 *   실제로 그렇게 3건이 화면에서 사라져 있었다.
 */
const DATE_KEYS = [
  'inquiryRegistrationDateTime', 'inquiryAt', 'inquiryDate', 'createdAt',
  'registerDate', 'questionDate', 'receiptDate',
];
const _warnedDateShapes = new Set();

function normalize(channel, inquiryType, raw) {
  const externalId = pick(raw, [
    'inquiryId', 'onlineInquiryId', 'counselingId', 'id', 'questionId', 'inquiryNo', 'answerTemplateNo',
  ]);
  if (externalId == null) return null;   // 식별자가 없으면 저장해도 갱신이 안 된다
  // 날짜를 못 찾으면 목록 기간 필터에서 통째로 빠진다 — 조용히 null 로 두지 말고 키를 남긴다
  if (!_warnedDateShapes.has(`${channel}/${inquiryType}`)
      && !pick(raw, DATE_KEYS)) {
    _warnedDateShapes.add(`${channel}/${inquiryType}`);
    console.warn(`[inquiries] ${channel}/${inquiryType}: 문의일시 필드를 찾지 못했습니다. 응답 키: ${Object.keys(raw).join(', ')}`);
  }
  return {
    channel,
    inquiry_type: inquiryType,
    external_id: String(externalId),
    inquired_at: toIso(pick(raw, DATE_KEYS)),
    order_id: (pick(raw, ['orderId', 'orderNo', 'productOrderId', 'orderSerialNumber']) ?? null) &&
      String(pick(raw, ['orderId', 'orderNo', 'productOrderId', 'orderSerialNumber'])),
    product_name: pick(raw, ['productName', 'sellerProductName', 'itemName', 'goodsName']),
    customer_name: pick(raw, ['customerName', 'buyerName', 'memberName', 'writerName', 'customerId']),
    title: pick(raw, ['title', 'subject', 'inquiryTitle', 'questionTitle']),
    content: pick(raw, ['content', 'inquiryContent', 'question', 'questionContent', 'body']),
    answered: !!pick(raw, ['answered', 'answeredAt', 'answerDate', 'answerContent', 'replyContent']),
    answer_content: pick(raw, ['answerContent', 'replyContent', 'answer']),
    answered_at: toIso(pick(raw, ['answerRegistrationDateTime', 'answeredAt', 'answerDate', 'replyDate'])),
    raw_payload: raw,
    synced_at: new Date().toISOString(),
  };
}

async function upsert(rows) {
  if (!USE) throw new Error('Supabase 미설정 — 문의 저장 불가');
  if (!rows.length) return 0;
  // 같은 배치에 같은 키가 두 번 들어가면 upsert 가 통째로 실패한다
  const seen = new Set();
  const uniq = rows.filter(r => {
    const k = `${r.channel}|${r.inquiry_type}|${r.external_id}`;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
  let n = 0;
  for (let i = 0; i < uniq.length; i += 300) {
    const chunk = uniq.slice(i, i + 300);
    const res = await fetch(`${REST}/channel_inquiries?on_conflict=channel,inquiry_type,external_id`, {
      method: 'POST',
      headers: { ...HDR, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(chunk),
    });
    if (!res.ok) {
      throw new Error(`Supabase upsert channel_inquiries [${res.status}]: ${(await res.text()).slice(0, 300)}`);
    }
    n += chunk.length;
  }
  return n;
}

/** 쿠팡 — 조회기간 최대 7일이라 창을 쪼개 돈다 */
async function fetchCoupang(daysBack) {
  const api = require('./coupang/api');
  if (!api.isConfigured()) return { rows: [], skipped: '쿠팡 API 키 미설정' };
  const V = api.VENDOR_ID;
  const rows = [];
  const errors = [];
  const now = Date.now();
  for (let start = daysBack; start > 0; start -= 7) {
    const from = ymd(now - start * 86400000);
    const to = ymd(now - Math.max(0, start - 7) * 86400000);
    // 고객센터 문의 — partnerCounselingStatus 필수 (probe 로 확인)
    for (const status of ['NONE', 'ANSWER', 'TRANSFER']) {
      try {
        const r = await api.callCoupang('GET',
          `/v2/providers/openapi/apis/api/v4/vendors/${V}/callCenterInquiries`,
          `partnerCounselingStatus=${status}&inquiryStartAt=${from}&inquiryEndAt=${to}&pageNum=1&pageSize=50`);
        for (const it of listOf(r)) {
          const n = normalize('coupang', 'callcenter', it);
          if (n) rows.push(n);
        }
      } catch (e) {
        console.warn(`[inquiries] 쿠팡 고객센터(${status}) ${from}~${to} 실패:`, e.message);
        errors.push(`고객센터(${status}) ${from}~${to}: ${String(e.message).slice(0, 200)}`);
      }
    }
    // 상품별 문의
    try {
      const r = await api.callCoupang('GET',
        `/v2/providers/openapi/apis/api/v4/vendors/${V}/onlineInquiries`,
        `inquiryStartAt=${from}&inquiryEndAt=${to}&answeredType=ALL&pageNum=1&pageSize=50`);
      for (const it of listOf(r)) {
        const n = normalize('coupang', 'online', it);
        if (n) rows.push(n);
      }
    } catch (e) {
      console.warn(`[inquiries] 쿠팡 상품문의 ${from}~${to} 실패:`, e.message);
      errors.push(`상품문의 ${from}~${to}: ${String(e.message).slice(0, 200)}`);
    }
  }
  return { rows, errors };
}

/** 네이버 — 스토어별로 조회 */
async function fetchNaver(daysBack) {
  const api = require('./naver/api');
  if (!api.isConfigured()) return { rows: [], skipped: '네이버 API 키 미설정' };
  const rows = [];
  const errors = [];
  const now = Date.now();
  const from = ymd(now - daysBack * 86400000);
  const to = ymd(now);
  // size 는 100 으로 — 상한을 넘기면 400 이 나고 그 스토어가 통째로 비어 버린다.
  //   대신 페이지를 돌며 모은다.
  const SIZE = 100, MAX_PAGES = 20;
  for (const store of api.getStores()) {
    for (let page = 1; page <= MAX_PAGES; page++) {
      try {
        const r = await api.callNaver(store, 'GET',
          `/external/v1/pay-user/inquiries?startSearchDate=${from}&endSearchDate=${to}&page=${page}&size=${SIZE}`);
        const list = listOf(r);
        for (const it of list) {
          const n = normalize('naver', 'customer', it);
          if (n) rows.push(n);
        }
        // last=true 이거나 받은 게 한 페이지 미만이면 끝
        if (r?.last === true || list.length < SIZE) break;
      } catch (e) {
        console.warn(`[inquiries] 네이버(${store.id}) page${page} 실패:`, e.message);
        errors.push(`${store.id} page${page}: ${String(e.message).slice(0, 200)}`);
        break;
      }
    }
  }
  return { rows, errors };
}

/**
 * 수집 — 채널별로 모아 저장한다.
 * @param {number} opts.daysBack 며칠치 (기본 30). 쿠팡은 7일씩 쪼개 돈다.
 */
async function syncInquiries({ daysBack = 30 } = {}) {
  const days = Math.min(Math.max(parseInt(daysBack, 10) || 30, 1), 180);
  const out = { days, coupang: 0, naver: 0, saved: 0, skipped: [], errors: [] };
  const all = [];
  for (const [name, fn] of [['coupang', fetchCoupang], ['naver', fetchNaver]]) {
    try {
      const r = await fn(days);
      if (r.skipped) { out.skipped.push({ channel: name, reason: r.skipped }); continue; }
      out[name] = r.rows.length;
      // 실패를 삼키면 화면엔 '0건' 으로만 보여 원인을 알 수 없다 — 사유를 함께 올린다
      if (r.errors && r.errors.length) out.errors.push({ channel: name, messages: r.errors.slice(0, 5) });
      all.push(...r.rows);
    } catch (e) {
      out.skipped.push({ channel: name, reason: e.message });
    }
  }
  out.saved = await upsert(all);
  // 정규화가 비어 있는 비율 — 필드명이 어긋났는지 바로 보이게 한다
  out.missing_content = all.filter(r => !r.content).length;
  out.samples = all.slice(0, 3).map(r => r.raw_payload);
  return out;
}

/** 목록 조회 */
async function listInquiries({ channel, answered, startDate, endDate, limit = 300 } = {}) {
  if (!USE) return [];
  const f = [`limit=${Math.min(Math.max(parseInt(limit, 10) || 300, 1), 1000)}`,
    'order=inquired_at.desc.nullslast'];
  if (channel) f.push(`channel=eq.${encodeURIComponent(channel)}`);
  if (answered === true) f.push('answered=is.true');
  if (answered === false) f.push('answered=is.false');
  if (startDate) f.push(`inquired_at=gte.${startDate}`);
  if (endDate) f.push(`inquired_at=lte.${endDate}T23:59:59+09:00`);
  const res = await fetch(`${REST}/channel_inquiries?select=*&${f.join('&')}`, { headers: HDR });
  if (!res.ok) throw new Error(`Supabase channel_inquiries [${res.status}]: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/** 우리 쪽 확인 표시 — 채널 답변 여부와는 별개다 */
async function markChecked(id, by) {
  if (!USE) throw new Error('Supabase 미설정');
  const res = await fetch(`${REST}/channel_inquiries?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { ...HDR, Prefer: 'return=representation' },
    body: JSON.stringify({ checked_at: new Date().toISOString(), checked_by: by || null }),
  });
  if (!res.ok) throw new Error(`Supabase patch [${res.status}]: ${(await res.text()).slice(0, 200)}`);
  return (await res.json())[0] || null;
}

module.exports = { syncInquiries, listInquiries, markChecked, normalize, listOf, USE };
