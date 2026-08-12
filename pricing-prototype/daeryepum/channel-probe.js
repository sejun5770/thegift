/**
 * 외부채널 쓰기 권한 probe — 출고상태 변경 / 고객문의 API 를 실제로 쓸 수 있는지 확인한다.
 *
 * 왜 필요한가:
 *   문서에 API 가 있어도 우리 키에 그 권한이 붙어 있는지는 알 수 없다. 쿠팡은 API 키 권한,
 *   네이버는 앱 권한, 카페24는 OAuth scope 가 각각 따로 논다. 붙여 놓고 나서 403 을 만나면
 *   그때부터 발급을 다시 받아야 하므로, 개발 전에 한 번 때려보고 가른다.
 *
 * ── 안전 원칙 (중요) ────────────────────────────────────────
 *   쓰기 API 는 '있을 수 없는 식별자' 로만 호출한다. 실제 주문번호는 절대 쓰지 않는다.
 *   그러면 결과가 이렇게 갈린다:
 *     · 401 / 403        → 권한이 없다 (키·앱·scope 를 다시 받아야 한다)
 *     · 400 / 404 / 422  → 권한은 통과했고 '그런 주문 없음' 이라는 업무 오류다 = 쓸 수 있다
 *   즉 어떤 경우에도 진짜 주문이 발송처리되거나 문의가 답변되지 않는다.
 *
 *   읽기 API(문의 조회)는 상태를 바꾸지 않으므로 실제 파라미터로 호출한다.
 */
'use strict';

// ── 있을 수 없는 식별자 — 이 값들이 실제 주문과 겹치면 안 된다 ──
//   쿠팡 주문번호는 14자리, 네이버 상품주문번호는 16자리 숫자다. 아래 값은 그 형식을 벗어나거나
//   0 이라 어떤 주문에도 매칭되지 않는다.
const FAKE = {
  coupangOrderId: 1,
  coupangShipmentBoxId: 1,
  naverProductOrderId: 'PROBE-DOES-NOT-EXIST',
  cafe24OrderId: 'PROBE-DOES-NOT-EXIST',
  invoice: '0000000000',
};

/** HTTP 상태 → 판정 */
function verdictOf(status) {
  if (status === 401 || status === 403) return 'permission_denied';
  if (status >= 200 && status < 300) return 'permission_ok';
  if ([400, 404, 409, 422, 500].includes(status)) return 'permission_ok_probably';
  return 'unknown';
}

const VERDICT_LABEL = {
  permission_ok: '권한 있음 (호출 성공)',
  permission_ok_probably: '권한 통과 — 업무 오류로 거절 (있을 수 없는 식별자를 넣었으므로 정상)',
  permission_denied: '권한 없음 — 키/앱/scope 재발급 필요',
  unknown: '판정 불가 — 원문 확인 필요',
};

async function runOne(label, channel, capability, fn) {
  try {
    const r = await fn();
    return {
      channel, capability, label,
      status: r.status, verdict: verdictOf(r.status),
      detail: String(r.body || '').replace(/\s+/g, ' ').slice(0, 300),
    };
  } catch (e) {
    // 클라이언트가 throw 하는 경우 — 메시지에서 상태코드를 건져 본다
    const m = /\[(\d{3})\]/.exec(e.message || '');
    const status = m ? Number(m[1]) : null;
    return {
      channel, capability, label,
      status, verdict: status ? verdictOf(status) : 'unknown',
      detail: String(e.message || '').replace(/\s+/g, ' ').slice(0, 300),
    };
  }
}

/** 쿠팡 — 서명까지 태워 그대로 호출하고 상태코드만 본다 */
async function coupangRaw(method, path, query = '', body = null) {
  const api = require('./coupang/api');
  const crypto = require('crypto');
  const HOST = process.env.COUPANG_API_HOST || 'https://api-gateway.coupang.com';
  const auth = api.buildAuthHeader(method, path, query);
  const res = await fetch(HOST + path + (query ? '?' + query : ''), {
    method,
    headers: { Authorization: auth, 'Content-Type': 'application/json;charset=UTF-8' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.text() };
}

/** 네이버 — 토큰만 빌려 쓰고 상태코드를 직접 본다 (callNaver 는 4xx 를 throw 한다) */
async function naverRaw(store, method, path, body = null) {
  const api = require('./naver/api');
  const token = await api.getAccessToken(store);
  const HOST = process.env.NAVER_API_HOST || 'https://api.commerce.naver.com';
  const res = await fetch(HOST + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.text() };
}

/** 카페24 — Admin API 임의 메서드 (운영 클라이언트는 GET 전용이라 여기서 따로 만든다) */
async function cafe24Raw(method, path, body = null) {
  const { getAccessToken } = require('./cafe24/auth');
  const MALL = process.env.CAFE24_MALL_ID || 'barunn01';
  const VERSION = process.env.CAFE24_API_VERSION || '2024-06-01';
  const token = await getAccessToken();
  const res = await fetch(`https://${MALL}.cafe24api.com/api/v2/admin${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Cafe24-Api-Version': VERSION,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.text() };
}

/**
 * @param {object} opts
 * @param {boolean} opts.includeWrite  쓰기 권한 probe 포함 여부 (기본 true).
 *   false 면 읽기(문의 조회)만 확인한다.
 */
async function probeChannels({ includeWrite = true } = {}) {
  const results = [];
  const skipped = [];

  // 채널 하나가 죽어도 나머지는 확인돼야 한다 — 모듈 로드 실패(의존성 누락)까지 포함해 격리한다
  const section = async (channel, fn) => {
    try { await fn(); }
    catch (e) { skipped.push({ channel, reason: String(e.message || e).slice(0, 200) }); }
  };

  // ── 쿠팡 ────────────────────────────────────────────────
  await section('쿠팡', async () => {
  const cpApi = require('./coupang/api');
  if (!cpApi.isConfigured()) {
    skipped.push({ channel: '쿠팡', reason: 'API 키 미설정' });
  } else {
    const V = cpApi.VENDOR_ID;
    if (includeWrite) {
      results.push(await runOne('송장업로드 처리', '쿠팡', '출고상태 변경', () =>
        coupangRaw('POST', `/v2/providers/openapi/apis/api/v4/vendors/${V}/orders/invoices`, '', {
          vendorId: V,
          orderSheetInvoiceApplyDtos: [{
            shipmentBoxId: FAKE.coupangShipmentBoxId,
            orderId: FAKE.coupangOrderId,
            deliveryCompanyCode: 'CJGLS',
            invoiceNumber: FAKE.invoice,
            splitShipping: false,
            preSplitShipped: false,
          }],
        })));
    }
    // 읽기 — 문의 조회 (상태 변경 없음). 조회기간 최대 7일.
    const today = new Date();
    const ymd = (d) => new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
    const from = ymd(new Date(today.getTime() - 6 * 86400000));
    const to = ymd(today);
    results.push(await runOne('고객센터 문의조회', '쿠팡', '고객문의', () =>
      coupangRaw('GET', `/v2/providers/openapi/apis/api/v4/vendors/${V}/callCenterInquiries`,
        `pageNum=1&pageSize=10&inquiryStartAt=${from}&inquiryEndAt=${to}`)));
    results.push(await runOne('상품별 고객문의 조회', '쿠팡', '고객문의', () =>
      coupangRaw('GET', `/v2/providers/openapi/apis/api/v4/vendors/${V}/onlineInquiries`,
        `inquiryStartAt=${from}&inquiryEndAt=${to}&answeredType=ALL&pageNum=1&pageSize=10`)));
  }
  });

  // ── 네이버 ──────────────────────────────────────────────
  await section('네이버', async () => {
  const nvApi = require('./naver/api');
  if (!nvApi.isConfigured()) {
    skipped.push({ channel: '네이버', reason: 'API 키 미설정' });
  } else {
    const store = nvApi.getStores()[0];
    if (!store) {
      skipped.push({ channel: '네이버', reason: '스토어 설정 없음' });
    } else {
      if (includeWrite) {
        results.push(await runOne('발송처리 (dispatch)', '네이버', '출고상태 변경', () =>
          naverRaw(store, 'POST', '/external/v1/pay-order/seller/product-orders/dispatch', {
            dispatchProductOrders: [{
              productOrderId: FAKE.naverProductOrderId,
              deliveryMethod: 'DELIVERY',
              deliveryCompanyCode: 'CJGLS',
              trackingNumber: FAKE.invoice,
              dispatchDate: new Date().toISOString(),
            }],
          })));
      }
      // 문의 — 공개 문서에서 경로를 확정 못 해 후보를 함께 때려 본다 (전부 읽기)
      for (const path of [
        '/external/v1/contact-leave/questions?page=1&size=10',
        '/external/v1/pay-user/inquiries?page=1&size=10',
        '/external/v2/product-inquiries?page=1&size=10',
      ]) {
        results.push(await runOne(`문의 조회 후보 ${path.split('?')[0]}`, '네이버', '고객문의', () =>
          naverRaw(store, 'GET', path)));
      }
    }
  }
  });

  // ── 카페24 (정수당) ─────────────────────────────────────
  await section('정수당', async () => {
    if (includeWrite) {
      results.push(await runOne('배송 등록 (shipments)', '정수당', '출고상태 변경', () =>
        cafe24Raw('POST', '/shipments', {
          shop_no: 1,
          requests: [{
            order_id: FAKE.cafe24OrderId,
            tracking_no: FAKE.invoice,
            shipping_company_code: '0019',
            status: 'standby',
          }],
        })));
    }
    results.push(await runOne('게시판 목록', '정수당', '고객문의', () =>
      cafe24Raw('GET', '/boards')));
    results.push(await runOne('상품 문의 게시판 글', '정수당', '고객문의', () =>
      cafe24Raw('GET', '/boards/6/articles?limit=10')));
  });

  const summary = {};
  for (const r of results) {
    const k = `${r.channel} / ${r.capability}`;
    if (!summary[k]) summary[k] = [];
    summary[k].push(`${r.label}: ${r.status} ${VERDICT_LABEL[r.verdict]}`);
  }
  return {
    note: '쓰기 API 는 있을 수 없는 식별자로만 호출했습니다 — 실제 주문·문의는 바뀌지 않습니다.',
    include_write: includeWrite,
    summary,
    results,
    skipped,
  };
}

module.exports = { probeChannels, VERDICT_LABEL };
