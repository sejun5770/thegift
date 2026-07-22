/**
 * 카페24 주문 동기화 — Admin API → 정규화 → Supabase cafe24_orders upsert.
 *   coupang/sync.js 미러 + src/lib/cafe24/mapper.ts 정규화 로직 이식.
 *
 * 정책:
 *   - 결제완료(paid==='T') & 미취소(canceled!=='T') 주문만 수집.
 *   - 한 order → orderItems 펼침 (분리/다상품 케이스 row 여러 개).
 *   - 옵션에서 희망출고일 / 스티커문구 / '오늘출발' 파싱.
 *   - 카페24 주문 API 최대 3개월/호출 → since 가 3개월 초과면 기간 분할 순회.
 *
 * 상태 라벨(order_status) — 대표 코드만, 나머지는 raw 그대로.
 */
'use strict';

const client = require('./client');
const store = require('./store');

// 카페24 order_status 대표 코드 → 한글 (없으면 raw 표시)
const STATUS_LABEL = {
  N00: '입금전',
  N10: '상품준비중',
  N20: '배송준비중',
  N21: '배송대기',
  N22: '배송보류',
  N30: '배송중',
  N40: '배송완료',
  C00: '취소접수',
  C10: '취소완료',
  C11: '취소완료',
  R00: '반품접수',
  R10: '반품완료',
  E00: '교환접수',
  E10: '교환완료',
  PAID: '결제완료',
  UNPAID: '미결제',
  CANCELED: '주문취소',
};

const DATE_RE = /(\d{4})[-.\/](\d{1,2})[-.\/](\d{1,2})/;

function pad(v) { return String(v).padStart(2, '0'); }

function toInt(v, fallback) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 카페24 일시 파싱 — 명시적 KST 처리 (coupang parseCoupangDate 와 동일 원리).
 *   카페24는 보통 TZ 포함("2026-07-22T10:30:00+09:00") 반환. 없으면 +09:00 부여.
 */
function parseCafe24Date(s) {
  if (!s) return null;
  let str = String(s).trim();
  if (!str) return null;
  if (str.includes(' ') && !str.includes('T')) str = str.replace(' ', 'T');
  const hasTz = /[+-]\d{2}:?\d{2}$|Z$/i.test(str);
  if (!hasTz) str = str + '+09:00';
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/** epoch ms → KST 기준 'YYYY-MM-DD' */
function fmtKstDate(ms) {
  const d = typeof ms === 'number' ? new Date(ms) : ms;
  const kst = new Date(d.getTime() + 9 * 3600 * 1000);
  return `${kst.getUTCFullYear()}-${pad(kst.getUTCMonth() + 1)}-${pad(kst.getUTCDate())}`;
}

function normalizeDate(v) {
  const m = String(v == null ? '' : v).match(DATE_RE);
  return m ? `${m[1]}-${pad(m[2])}-${pad(m[3])}` : null;
}

/** 'YYYY-MM-DD' 유효 날짜만 반환 (카페24의 '0000-00-00'/빈값 방어). 아니면 null */
function validDateStr(v) {
  const s = String(v == null ? '' : v).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m || m[1] === '0000') return null;
  return s;
}

/** 주문일 + N영업일 (주말 건너뜀). 주문일 없으면 오늘 기준. */
function addBusinessDays(orderDate, n) {
  const base = orderDate ? new Date(orderDate) : new Date();
  const d = isNaN(base.getTime()) ? new Date() : base;
  let added = 0;
  while (added < n) {
    d.setDate(d.getDate() + 1);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) added++;
  }
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 희망출고일 파싱 — 추가입력 옵션(name 에 '희망'&'출고') 또는 옵션 문자열에서 날짜 추출 */
function parseDesiredShippingDate(items) {
  for (const it of items) {
    for (const opt of it.additional_option_values || []) {
      const nm = String(opt.name == null ? '' : opt.name);
      if (nm.includes('희망') && nm.includes('출고')) {
        const d = normalizeDate(opt.value);
        if (d) return d;
      }
    }
    const ov = String(it.option_value == null ? '' : it.option_value);
    const m = ov.match(/희망\s*출고일?\s*[:=]?\s*/);
    if (m) {
      const after = ov.slice(m.index + m[0].length);
      const dm = after.match(DATE_RE);
      if (dm) return `${dm[1]}-${pad(dm[2])}-${pad(dm[3])}`;
    }
  }
  return null;
}

/** 스티커 문구 파싱 — 추가입력 옵션(name 에 '스티커' 또는 '문구') */
function parseStickerMessage(it) {
  for (const opt of it.additional_option_values || []) {
    const nm = String(opt.name == null ? '' : opt.name);
    if (nm.includes('스티커') || nm.includes('문구')) {
      const v = String(opt.value == null ? '' : opt.value).trim();
      if (v) return v;
    }
  }
  return null;
}

/**
 * 한 카페24 order → 정규화된 row 배열 (orderItems 펼침).
 *   결제완료(paid='T') & 미취소만 통과 (호출측에서 이미 필터하지만 방어적으로 재확인).
 */
function normalizeOrder(o) {
  if (!o || !o.order_id) return [];
  if (o.paid !== 'T') return [];
  if (o.canceled === 'T') return [];

  const orderedAt = parseCafe24Date(o.order_date);
  const paidAt = o.paid === 'T' ? (parseCafe24Date(o.paid_date) || orderedAt) : null;

  const rawItems = Array.isArray(o.items) ? o.items : [];
  // 희망출고일: 카페24 네이티브 wished_delivery_date 우선 → 옵션 파싱 → 주문일+3영업일 폴백
  //   (실주문 확인: 프런트가 wished_delivery_date 필드로 전달, 옵션엔 스티커 문구만 존재)
  const desired = validDateStr(o.wished_delivery_date)
    || parseDesiredShippingDate(rawItems)
    || addBusinessDays(o.order_date, 3);
  // shipping_method: '오늘출발' 품목 포함 시 same_day
  const isSameDay = rawItems.some(it => String(it.product_name == null ? '' : it.product_name).includes('오늘출발'));

  const receiver = (Array.isArray(o.receivers) && o.receivers[0]) || {};
  const recvName = receiver.name || (o.buyer && o.buyer.name) || null;
  const recvPhone = receiver.cellphone || receiver.phone || (o.buyer && (o.buyer.cellphone || o.buyer.phone)) || null;
  const recvAddress = receiver.address_full
    || ([receiver.address1, receiver.address2].filter(Boolean).join(' ') || null);
  const recvPostal = receiver.zipcode != null ? String(receiver.zipcode).trim() : null;
  const recvMessage = receiver.shipping_message != null ? String(receiver.shipping_message).trim() : null;

  // 상태는 품목 레벨(order_status: N10 등) — 주문 레벨엔 order_status 없음. 카페24가 준 status_text 우선 사용.
  const orderFallbackStatus = o.canceled === 'T' ? 'CANCELED' : (o.paid === 'T' ? 'PAID' : 'UNPAID');
  const settlePrice = toInt(o.payment_amount != null ? o.payment_amount : o.order_price_amount, 0);
  const settleMethod = o.payment_method || (Array.isArray(o.payment_method_name) ? o.payment_method_name.join(',') : (o.payment_method_name || null));

  return rawItems.map((it, idx) => {
    const qty = toInt(it.quantity, 1);
    const unit = toInt(it.product_price, 0);
    const itStatus = it.order_status || orderFallbackStatus;
    const lineKey = (it.order_item_code != null && String(it.order_item_code).trim())
      ? String(it.order_item_code).trim()
      : `${it.product_no != null ? it.product_no : 'p'}:${idx}`;
    return {
      cafe24_order_id: String(o.order_id),
      line_key: lineKey,
      product_no: it.product_no != null ? it.product_no : null,
      ordered_at: orderedAt,
      paid_at: paidAt,
      product_name: (String(it.product_name == null ? '' : it.product_name).trim()) || '(상품명 없음)',
      product_code: it.product_code != null ? String(it.product_code).trim() : null,
      item_count: qty,
      item_sale_price: unit,
      item_total_price: unit * qty,
      recv_name: recvName,
      recv_hphone: recvPhone,
      recv_address: recvAddress,
      recv_postal_code: recvPostal,
      recv_message: recvMessage,
      settle_price: settlePrice,
      settle_method: settleMethod,
      status: itStatus,
      status_label: it.status_text || STATUS_LABEL[itStatus] || itStatus,
      desired_shipping_date: desired,
      shipping_method: isSameDay ? 'same_day' : 'parcel',
      input_message: parseStickerMessage(it),
      raw_payload: { order_keys: Object.keys(o), item: it },
      synced_at: new Date().toISOString(),
    };
  });
}

/**
 * since ~ now 를 3개월(<=90일) 이하 윈도우로 분할 — 카페24 주문 API 기간 제한 대응.
 *   반환: [{ start: 'YYYY-MM-DD', end: 'YYYY-MM-DD' }, ...] (end inclusive, API 규격)
 */
function buildWindows(sinceMs, endMs) {
  const CHUNK = 89 * 86400000; // 89일 (3개월 여유)
  const windows = [];
  let cur = sinceMs;
  while (cur <= endMs) {
    const winEnd = Math.min(cur + CHUNK, endMs);
    windows.push({ start: fmtKstDate(cur), end: fmtKstDate(winEnd) });
    cur = winEnd + 86400000; // 다음 날부터 (end inclusive 라 중복 방지)
  }
  return windows;
}

/**
 * 메인 동기화 함수.
 *   since: 'YYYY-MM-DD' 또는 Date/ms — 이 시점부터 now(KST) 까지 수집. 미지정 시 최근 7일.
 * 반환: { fetched, upserted, filtered_out, items, windows, error? }
 */
async function syncCafe24Orders({ since } = {}) {
  if (!client.isConfigured()) {
    const err = 'Cafe24 앱 미설정 (CAFE24_CLIENT_ID/CLIENT_SECRET)';
    await store.updateSyncState({ last_error: err, last_synced_at: new Date().toISOString() }).catch(() => {});
    return { fetched: 0, upserted: 0, filtered_out: 0, error: err };
  }
  if (!store.USE_SUPABASE) {
    const err = 'Supabase 미설정 (SUPABASE_URL/SUPABASE_ANON_KEY)';
    return { fetched: 0, upserted: 0, filtered_out: 0, error: err };
  }

  const endMs = Date.now();
  let sinceMs;
  if (since == null) {
    sinceMs = endMs - 7 * 86400000;
  } else if (typeof since === 'number') {
    sinceMs = since;
  } else if (since instanceof Date) {
    sinceMs = since.getTime();
  } else {
    const parsed = new Date(String(since).length <= 10 ? `${since}T00:00:00+09:00` : since);
    sinceMs = isNaN(parsed.getTime()) ? (endMs - 7 * 86400000) : parsed.getTime();
  }

  const windows = buildWindows(sinceMs, endMs);
  let fetched = 0;
  let filteredOut = 0;
  const rows = [];
  try {
    for (const w of windows) {
      const orders = await client.fetchOrders(w.start, w.end);
      fetched += orders.length;
      for (const o of orders) {
        const itemsBefore = Array.isArray(o.items) ? o.items.length : 0;
        const normalized = normalizeOrder(o);
        rows.push(...normalized);
        // 결제완료·미취소 필터 또는 품목 0 개로 빠진 수
        filteredOut += Math.max(0, itemsBefore - normalized.length);
      }
    }
  } catch (e) {
    await store.updateSyncState({ last_error: e.message, last_synced_at: new Date().toISOString() }).catch(() => {});
    return { fetched, upserted: 0, filtered_out: filteredOut, error: e.message, windows };
  }

  let upserted = 0;
  if (rows.length) {
    try {
      const r = await store.upsertCafe24Orders(rows);
      upserted = r.upserted || rows.length;
    } catch (e) {
      await store.updateSyncState({ last_error: e.message, last_synced_at: new Date().toISOString() }).catch(() => {});
      return { fetched, upserted: 0, filtered_out: filteredOut, error: e.message, windows };
    }
  }

  await store.updateSyncState({
    last_synced_at: new Date().toISOString(),
    last_synced_order_count: upserted,
    last_error: null,
  }).catch(() => {});

  return {
    fetched,
    upserted,
    filtered_out: filteredOut,
    items: rows.length,
    windows,
    since_kst: fmtKstDate(sinceMs),
    end_kst: fmtKstDate(endMs),
  };
}

module.exports = {
  syncCafe24Orders,
  normalizeOrder, // for testing
  STATUS_LABEL,
};
