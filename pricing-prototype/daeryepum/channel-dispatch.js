/**
 * 외부채널 출고상태 변경 (2단계) — 쿠팡 · 네이버.
 *
 * 하는 일:
 *   우리가 이미 등록한 송장(bg_order_invoices)을 채널에 올려 주문을 '배송중' 으로 넘긴다.
 *   쿠팡 Wing / 네이버 판매자센터에 다시 들어가 손으로 송장을 치던 일을 없앤다.
 *
 * 권한은 probe 로 확인했다 (channel-probe.js, 2026-08-13):
 *   · 쿠팡  POST /orders/invoices                              — 있을 수 없는 주문번호로 호출 → 업무오류 = 권한 통과
 *   · 네이버 POST /pay-order/seller/product-orders/dispatch     — 동일
 *
 * ── 안전 원칙 ──────────────────────────────────────────────
 *   이 모듈은 실제 고객 주문의 상태를 바꾸고 고객에게 발송 알림이 나간다. 되돌릴 수 없다.
 *   그래서:
 *     · send() 는 confirm:true 를 명시적으로 받아야 실제 호출한다. 기본은 미리보기다.
 *     · 보낼 대상은 호출자가 지정한 건만이다. '전부 알아서' 는 없다.
 *     · 송장번호·택배사가 없는 건은 대상에서 아예 빠진다 (채널이 거부하기 전에 우리가 막는다).
 *     · 결과는 건별로 성공/실패를 그대로 돌려준다 — 부분 성공을 전체 성공으로 뭉개지 않는다.
 */
'use strict';

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';
const USE = !!(SUPABASE_URL && SUPABASE_KEY);
const REST = `${SUPABASE_URL}/rest/v1`;
const HDR = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' };

// ============================================
// 택배사 코드
// ============================================
/**
 * 우리 송장 모달의 택배사 이름 → 채널 코드.
 *   쿠팡은 코드 목록 API 가 있어 그걸 우선 쓰고, 실패하면 이 표로 떨어진다.
 *   네이버는 목록 API 가 없어 이 표가 유일한 근거다.
 */
const COURIER = {
  'CJ대한통운': { coupang: 'CJGLS', naver: 'CJGLS' },
  '한진택배': { coupang: 'HANJIN', naver: 'HANJIN' },
  '롯데택배': { coupang: 'LOTTE', naver: 'LOTTE' },
  '우체국택배': { coupang: 'EPOST', naver: 'EPOST' },
  '로젠택배': { coupang: 'LOGEN', naver: 'LOGEN' },
};

/** 이름 정규화 — '(주)', 공백, '택배' 유무 차이를 흡수한다 */
function normName(s) {
  return String(s || '').replace(/\(주\)|주식회사|\s+/g, '').replace(/택배$/, '').toLowerCase();
}

let _coupangCourierCache = null;   // { at, map: Map<normName, code> }

/** 쿠팡 택배사 코드 목록 — 하루 캐시. 실패해도 던지지 않는다 (정적 표로 떨어진다). */
async function loadCoupangCouriers() {
  if (_coupangCourierCache && Date.now() - _coupangCourierCache.at < 86400000) return _coupangCourierCache.map;
  const map = new Map();
  try {
    const api = require('./coupang/api');
    const r = await api.callCoupang('GET', '/v2/providers/openapi/apis/api/v1/marketplace/meta/courier-companies');
    const list = Array.isArray(r?.data) ? r.data : (Array.isArray(r) ? r : []);
    for (const c of list) {
      const code = c.deliveryCompanyCode || c.code;
      const name = c.deliveryCompanyName || c.name;
      if (code && name) map.set(normName(name), String(code));
    }
  } catch (e) {
    console.warn('[dispatch] 쿠팡 택배사 목록 조회 실패 — 내장 표를 씁니다:', e.message);
  }
  _coupangCourierCache = { at: Date.now(), map };
  return map;
}

/**
 * 택배사 이름 → 채널 코드.
 *   못 찾으면 null. 호출자는 그 건을 '전송 불가' 로 표시해야 한다 —
 *   임의의 코드로 대신 보내면 고객에게 틀린 택배사가 안내된다.
 */
async function courierCode(channel, name) {
  const key = normName(name);
  if (channel === 'coupang') {
    const dyn = await loadCoupangCouriers();
    if (dyn.has(key)) return dyn.get(key);
  }
  for (const [k, v] of Object.entries(COURIER)) {
    if (normName(k) === key) return v[channel] || null;
  }
  return null;
}

// ============================================
// 우리 쪽 송장 조회
// ============================================
/**
 * order_id 여러 건의 송장을 한 번에 — order_id → 최신 송장 1건.
 *
 * 테이블이 아직 없으면(마이그레이션 017 미적용) 목록 자체를 실패시키지 않는다.
 *   송장이 없을 뿐 '출고 처리가 필요한 주문' 은 그대로 보여줘야 하고, 화면에서
 *   직접 송장을 입력해 보낼 수도 있기 때문이다. 대신 사유를 함께 올린다.
 */
async function invoicesByOrderIds(orderIds) {
  const out = new Map();
  out._warning = null;
  if (!USE || !orderIds.length) return out;
  for (let i = 0; i < orderIds.length; i += 200) {
    const chunk = orderIds.slice(i, i + 200);
    const inList = chunk.map(id => `"${String(id).replace(/"/g, '')}"`).join(',');
    const res = await fetch(
      `${REST}/bg_order_invoices?select=order_id,invoice_number,delivery_company,shipped_at&order_id=in.(${inList})&order=shipped_at.asc`,
      { headers: HDR });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      if (res.status === 404 || /PGRST205|does not exist|schema cache/i.test(body)) {
        out._warning = '송장 테이블(bg_order_invoices)이 아직 없습니다 — 마이그레이션 017 을 실행하세요. '
          + '그때까지는 이 화면에서 송장번호를 직접 입력해 전송할 수 있습니다.';
        return out;
      }
      throw new Error(`Supabase bg_order_invoices [${res.status}]: ${body}`);
    }
    // asc 로 받아 덮어쓰면 마지막(=최신) 이 남는다
    for (const r of await res.json()) out.set(String(r.order_id), r);
  }
  return out;
}

/** 우리 송장 기록 — 채널 전송에 성공한 건을 남긴다. 테이블이 없으면 조용히 건너뛴다. */
async function recordInvoice({ orderId, invoiceNumber, deliveryCompany, by }) {
  if (!USE) return { saved: false, reason: 'supabase_not_configured' };
  const res = await fetch(`${REST}/bg_order_invoices?on_conflict=order_id,invoice_number`, {
    method: 'POST',
    headers: { ...HDR, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify([{
      order_id: orderId,
      invoice_number: String(invoiceNumber),
      delivery_company: deliveryCompany || null,
      shipped_at: new Date().toISOString(),
      shipped_by: by || 'channel-dispatch',
      notes: '출고상태 전송 화면에서 직접 입력',
    }]),
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    return { saved: false, reason: `[${res.status}] ${body}` };
  }
  return { saved: true };
}

const ymd = (ms) => new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 10);

// ============================================
// 쿠팡
// ============================================
/** 쿠팡에서 아직 출고 처리가 안 된 주문 (결제완료 · 상품준비중) */
async function pendingCoupang({ daysBack = 14 } = {}) {
  const api = require('./coupang/api');
  if (!api.isConfigured()) return { rows: [], skipped: '쿠팡 API 키 미설정' };

  const endMs = Date.now();
  const startMs = endMs - daysBack * 86400000;
  const sheets = [];
  for (const status of ['ACCEPT', 'INSTRUCT']) {
    const r = await api.listOrdersForStatus({ startMs, endMs, status });
    for (const s of r.items) sheets.push({ ...s, _status: status });
  }
  if (!sheets.length) return { rows: [] };

  // 우리 카테고리 주문만 — 동기화 때 이미 걸러 저장한 coupang_orders 를 기준으로 삼는다.
  //   (벤더 계정에는 다른 팀 상품 주문도 함께 들어온다)
  let mine = null;
  try {
    const store = require('./coupang/store');
    if (store.USE_SUPABASE) {
      const local = await store.listCoupangOrders({
        startStr: ymd(startMs - 2 * 86400000),
        endStr: ymd(endMs + 86400000),
        excludeRocketGrowth: true,
      });
      mine = new Set(local.map(r => String(r.coupang_order_id)));
    }
  } catch (e) {
    console.warn('[dispatch] 쿠팡 로컬 주문 조회 실패 — 필터 없이 보여줍니다:', e.message);
  }

  const picked = mine ? sheets.filter(s => mine.has(String(s.orderId))) : sheets;
  const invoices = await invoicesByOrderIds(picked.map(s => `CP-${s.orderId}`));

  const rows = [];
  for (const s of picked) {
    const inv = invoices.get(`CP-${s.orderId}`) || null;
    const code = inv ? await courierCode('coupang', inv.delivery_company) : null;
    rows.push({
      channel: 'coupang',
      order_id: String(s.orderId),
      shipment_box_id: s.shipmentBoxId != null ? String(s.shipmentBoxId) : null,
      status: s._status,
      status_label: s._status === 'ACCEPT' ? '결제완료' : '상품준비중',
      ordered_at: s.orderedAt || null,
      receiver: s.receiver?.name || null,
      product_name: (s.orderItems || []).map(i => i.vendorItemName || i.sellerProductName).filter(Boolean)[0] || null,
      item_count: (s.orderItems || []).reduce((a, i) => a + (Number(i.shippingCount) || 0), 0),
      invoice_number: inv?.invoice_number || null,
      delivery_company: inv?.delivery_company || null,
      courier_code: code,
      // 보낼 수 있는 조건: 송장번호 + 택배사 코드가 둘 다 있어야 한다
      ready: !!(inv?.invoice_number && code),
      blocked_reason: !inv ? '송장 미등록'
        : !inv.invoice_number ? '송장번호 없음'
          : !code ? `택배사 코드 없음 (${inv.delivery_company || '미지정'})` : null,
    });
  }
  rows.sort((a, b) => String(a.ordered_at || '').localeCompare(String(b.ordered_at || '')));
  return { rows, warning: invoices._warning || null };
}

/**
 * 쿠팡 송장 업로드 — 한 번에 여러 건.
 *   응답의 건별 결과를 그대로 풀어 돌려준다. 전체 200 이어도 개별 건은 실패할 수 있다.
 */
async function sendCoupang(items) {
  const api = require('./coupang/api');
  const V = api.VENDOR_ID;
  const dtos = items.map(it => ({
    shipmentBoxId: Number(it.shipment_box_id),
    orderId: Number(it.order_id),
    deliveryCompanyCode: it.courier_code,
    invoiceNumber: String(it.invoice_number),
    splitShipping: false,
    preSplitShipped: false,
  }));
  const res = await api.callCoupang('POST',
    `/v2/providers/openapi/apis/api/v4/vendors/${V}/orders/invoices`, '',
    { vendorId: V, orderSheetInvoiceApplyDtos: dtos });

  // data 는 건별 결과 배열. 형식이 바뀌어도 전체 성공/실패는 code 로 판정한다.
  const perItem = Array.isArray(res?.data) ? res.data : [];
  return items.map((it, i) => {
    const d = perItem[i] || perItem.find(x => String(x.orderId) === String(it.order_id)) || null;
    const ok = d ? (d.succeed !== false && d.success !== false) : (String(res?.code) === '200' || res?.code === 200);
    return {
      ...it,
      ok,
      message: d?.resultMessage || d?.message || res?.message || (ok ? '전송 완료' : '응답에 결과 없음'),
    };
  });
}

// ============================================
// 네이버
// ============================================
/** 네이버 발송대기(PAYED) 주문 — 로컬 동기화 데이터 기준 */
async function pendingNaver({ daysBack = 14 } = {}) {
  const api = require('./naver/api');
  if (!api.isConfigured()) return { rows: [], skipped: '네이버 API 키 미설정' };
  const store = require('./naver/store');
  if (!store.USE_SUPABASE) return { rows: [], skipped: 'Supabase 미설정' };

  const endMs = Date.now();
  const startMs = endMs - daysBack * 86400000;
  const local = await store.listNaverOrders({
    startStr: ymd(startMs),
    endStr: ymd(endMs + 86400000),
    byPaid: true,
  });
  const waiting = local.filter(r => r.status === 'PAYED');
  if (!waiting.length) return { rows: [] };

  const invoices = await invoicesByOrderIds(waiting.map(r => `NV-${r.product_order_id}`));
  const rows = [];
  for (const r of waiting) {
    const inv = invoices.get(`NV-${r.product_order_id}`) || null;
    const code = inv ? await courierCode('naver', inv.delivery_company) : null;
    rows.push({
      channel: 'naver',
      order_id: String(r.product_order_id),
      store_id: r.store_id || 'main',
      status: r.status,
      status_label: r.status_label || '결제완료',
      ordered_at: r.ordered_at || null,
      receiver: r.recv_name || null,
      product_name: r.product_name || null,
      item_count: Number(r.item_count) || 0,
      invoice_number: inv?.invoice_number || null,
      delivery_company: inv?.delivery_company || null,
      courier_code: code,
      ready: !!(inv?.invoice_number && code),
      blocked_reason: !inv ? '송장 미등록'
        : !inv.invoice_number ? '송장번호 없음'
          : !code ? `택배사 코드 없음 (${inv.delivery_company || '미지정'})` : null,
    });
  }
  rows.sort((a, b) => String(a.ordered_at || '').localeCompare(String(b.ordered_at || '')));
  return { rows, warning: invoices._warning || null };
}

/** 네이버 발송처리 — 스토어별로 나눠 호출한다 (스토어마다 토큰이 다르다) */
async function sendNaver(items) {
  const api = require('./naver/api');
  const out = [];
  const byStore = new Map();
  for (const it of items) {
    const k = it.store_id || 'main';
    if (!byStore.has(k)) byStore.set(k, []);
    byStore.get(k).push(it);
  }
  const dispatchDate = new Date().toISOString();
  for (const [storeId, list] of byStore) {
    const store = api.getStore(storeId) || api.getStores()[0];
    if (!store) {
      for (const it of list) out.push({ ...it, ok: false, message: `스토어 설정 없음 (${storeId})` });
      continue;
    }
    try {
      const res = await api.callNaver(store, 'POST',
        '/external/v1/pay-order/seller/product-orders/dispatch', {
        dispatchProductOrders: list.map(it => ({
          productOrderId: String(it.order_id),
          deliveryMethod: 'DELIVERY',
          deliveryCompanyCode: it.courier_code,
          trackingNumber: String(it.invoice_number),
          dispatchDate,
        })),
      });
      // 실패 건은 data.failProductOrderInfos 로 온다 — 나머지는 성공으로 본다
      const fails = new Map();
      for (const f of (res?.data?.failProductOrderInfos || res?.failProductOrderInfos || [])) {
        fails.set(String(f.productOrderId), f.message || f.code || '실패');
      }
      for (const it of list) {
        const msg = fails.get(String(it.order_id));
        out.push({ ...it, ok: !msg, message: msg || '발송처리 완료' });
      }
    } catch (e) {
      for (const it of list) out.push({ ...it, ok: false, message: String(e.message).slice(0, 300) });
    }
  }
  return out;
}

// ============================================
// 공개 API
// ============================================
/** 채널별 출고 대기 목록 */
async function listPending({ daysBack = 14, channels = ['coupang', 'naver'] } = {}) {
  const days = Math.min(Math.max(parseInt(daysBack, 10) || 14, 1), 60);
  const out = { days, rows: [], skipped: [], errors: [] };
  const fns = { coupang: pendingCoupang, naver: pendingNaver };
  const warnings = new Set();
  for (const ch of channels) {
    if (!fns[ch]) continue;
    try {
      const r = await fns[ch]({ daysBack: days });
      if (r.skipped) { out.skipped.push({ channel: ch, reason: r.skipped }); continue; }
      if (r.warning) warnings.add(r.warning);
      out.rows.push(...r.rows);
    } catch (e) {
      // 한 채널이 죽어도 다른 채널 목록은 보여야 한다
      out.errors.push({ channel: ch, message: String(e.message).slice(0, 300) });
    }
  }
  out.ready = out.rows.filter(r => r.ready).length;
  out.blocked = out.rows.length - out.ready;
  out.warnings = [...warnings];
  return out;
}

/**
 * 출고상태 전송.
 * @param {object[]} opts.items   listPending 이 준 행 (channel/order_id 등 그대로)
 * @param {boolean}  opts.confirm true 여야 실제로 채널에 보낸다. 기본은 미리보기.
 * @param {string}   opts.by      감사 로그용
 */
async function sendDispatch({ items = [], confirm = false, by = 'system' } = {}) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) throw new Error('전송할 주문이 없습니다');

  // 화면에서 직접 입력한 송장이 있으면 그것으로 채운다 (송장 테이블이 없거나 미등록인 경우).
  //   택배사 이름 → 채널 코드 변환은 서버에서 한다 — 클라이언트가 코드를 지어내면 안 된다.
  const prepared = [];
  for (const it of list) {
    const manualNo = String(it.manual_invoice_number || '').trim();
    const manualCo = String(it.manual_delivery_company || '').trim();
    if (manualNo && manualCo) {
      const code = await courierCode(it.channel, manualCo);
      prepared.push({
        ...it,
        invoice_number: manualNo,
        delivery_company: manualCo,
        courier_code: code,
        manual: true,
        blocked_reason: code ? null : `택배사 코드 없음 (${manualCo})`,
      });
    } else if (manualNo || manualCo) {
      prepared.push({ ...it, blocked_reason: '송장번호와 택배사를 모두 입력하세요' });
    } else {
      prepared.push(it);
    }
  }

  // 보낼 수 없는 건을 미리 걷어낸다 — 채널에 던져 놓고 에러를 받는 것보다 낫다
  const skipped = prepared.filter(it => !it.invoice_number || !it.courier_code)
    .map(it => ({ ...it, ok: false, message: it.blocked_reason || '송장번호·택배사 코드 필요' }));
  const sendable = prepared.filter(it => it.invoice_number && it.courier_code);

  if (!confirm) {
    return {
      dry_run: true,
      by,
      would_send: sendable.length,
      skipped: skipped.length,
      preview: sendable.map(it => ({
        channel: it.channel, order_id: it.order_id, receiver: it.receiver,
        invoice_number: it.invoice_number, delivery_company: it.delivery_company,
        courier_code: it.courier_code,
      })),
      skipped_rows: skipped,
    };
  }

  const results = [];
  const cp = sendable.filter(it => it.channel === 'coupang');
  const nv = sendable.filter(it => it.channel === 'naver');
  if (cp.length) {
    // 쿠팡은 한 번에 여러 건을 받지만, 한 덩어리가 통째로 죽으면 원인을 못 가른다.
    //   50건씩 끊어 실패 범위를 좁힌다.
    for (let i = 0; i < cp.length; i += 50) {
      const chunk = cp.slice(i, i + 50);
      try {
        results.push(...await sendCoupang(chunk));
      } catch (e) {
        for (const it of chunk) results.push({ ...it, ok: false, message: String(e.message).slice(0, 300) });
      }
    }
  }
  if (nv.length) results.push(...await sendNaver(nv));

  // 화면에서 직접 입력한 송장은 우리 기록에도 남긴다 — 채널에만 있고 우리는 모르는 상태를
  //   만들면 다음에 또 입력하게 된다. 테이블이 없으면 실패 사유만 담고 전송 결과는 건드리지 않는다.
  for (const r of results) {
    if (!r.ok || !r.manual) continue;
    const saved = await recordInvoice({
      orderId: r.channel === 'coupang' ? `CP-${r.order_id}` : `NV-${r.order_id}`,
      invoiceNumber: r.invoice_number,
      deliveryCompany: r.delivery_company,
      by,
    });
    r.invoice_saved = saved.saved;
    if (!saved.saved) r.invoice_save_error = saved.reason;
  }

  // 성공한 건은 로컬 상태도 앞으로 당겨 둔다 — 다음 동기화 전까지 목록에 남아 헷갈리지 않게.
  const okCp = results.filter(r => r.ok && r.channel === 'coupang');
  if (okCp.length) {
    try {
      const store = require('./coupang/store');
      for (const r of okCp) await store.updateCoupangOrderStatus(r.order_id, 'DEPARTURE', '배송지시');
    } catch (e) {
      console.warn('[dispatch] 쿠팡 로컬 상태 갱신 실패 (채널 전송은 성공):', e.message);
    }
  }

  const ok = results.filter(r => r.ok).length;
  return {
    dry_run: false,
    by,
    sent: results.length,
    ok,
    failed: results.length - ok,
    skipped: skipped.length,
    results: [...results, ...skipped],
  };
}

module.exports = { listPending, sendDispatch, courierCode, COURIER, USE };
