/**
 * 바른손 통합관리자 (admin.barunsoncard.com) HTTP API 클라이언트.
 *
 * 우리 backend 가 사용하는 readonly_user MSSQL 계정은 SP_GIFT_ORDER_BIZTALK_PROC
 * EXECUTE 권한이 없음 → 통합관리자 의 HTTP API (사용자 세션) 를 우회 호출.
 *
 * 환경변수:
 *   BARUN_ADMIN_BASE_URL  — 기본 'https://admin.barunsoncard.com'
 *   BARUN_ADMIN_COOKIE    — 통합관리자 로그인 후 cURL 로 추출한 cookie 전체 문자열.
 *     세션 만료 시 (보통 14일 sliding) 운영자가 재로그인 → DevTools 에서 cookie 재추출 → 환경변수 갱신.
 *     만료 detection: 응답이 HTML (로그인 페이지) 이면 throw, 운영자에게 알림.
 */
'use strict';

const ADMIN_BASE = (process.env.BARUN_ADMIN_BASE_URL || 'https://admin.barunsoncard.com').replace(/\/$/, '');
const ADMIN_COOKIE = process.env.BARUN_ADMIN_COOKIE || '';

const COMMON_HEADERS = {
  'accept': 'application/json, text/javascript, */*; q=0.01',
  'accept-language': 'ko-KR,ko;q=0.9,en;q=0.8',
  'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
  'origin': ADMIN_BASE,
  'x-requested-with': 'XMLHttpRequest',
  'user-agent': 'Mozilla/5.0 (compatible; thegift-admin-proxy/1.0)',
};

/**
 * 답례품 알림톡 재발송 — 통합관리자 KakaoBizTalk/ResendGift 호출.
 *
 *   orderSeq: BIGINT (CUSTOM_ETC_ORDER 또는 custom_order 의 order_seq)
 *   orderCategory: 'E' (ETC, 답례품 단독) 또는 'W' (CARD, 청첩장+답례품 동시)
 *
 *   성공 응답 (200 + JSON {success:'Y'}) → { ok: true, response }
 *   세션 만료 (302/401 또는 HTML body) → throw 'SESSION_EXPIRED'
 *   기타 실패 → throw with message
 */
async function resendGift({ orderSeq, orderCategory }) {
  if (!ADMIN_COOKIE) {
    throw new Error('BARUN_ADMIN_COOKIE 미설정 — 통합관리자 cookie 환경변수 필요');
  }
  if (!orderSeq) throw new Error('orderSeq 필수');
  if (!['E', 'W'].includes(orderCategory)) {
    throw new Error(`orderCategory 는 'E' 또는 'W' (받음: ${orderCategory})`);
  }

  const body = new URLSearchParams({
    orderSeq: String(orderSeq),
    orderCategory,
  });

  const url = `${ADMIN_BASE}/KakaoBizTalk/ResendGift`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        ...COMMON_HEADERS,
        cookie: ADMIN_COOKIE,
        // referer 는 SendList 페이지 가정 — anti-CSRF 검사에서 origin 일치만 보면 충분.
        referer: `${ADMIN_BASE}/KakaoBizTalk/SendList`,
      },
      body: body.toString(),
      redirect: 'manual', // 로그인 리다이렉트 감지 — 따라가지 않고 status 확인
    });
  } catch (e) {
    // Node fetch 의 'fetch failed' 는 generic 메시지 — 실제 원인은 cause 안에.
    //   ENOTFOUND/ECONNREFUSED/EAI_AGAIN/etc.
    const cause = e.cause || {};
    const causeCode = cause.code || cause.errno || cause.message || '';
    const detail = causeCode ? ` (${causeCode})` : '';
    throw new Error(`NETWORK_FAIL — fetch ${url}: ${e.message}${detail}`);
  }

  // 302/401 → 세션 만료
  if (res.status === 302 || res.status === 401 || res.status === 403) {
    throw new Error('SESSION_EXPIRED — 통합관리자 cookie 갱신 필요 (BARUN_ADMIN_COOKIE)');
  }
  if (!res.ok) {
    throw new Error(`ResendGift HTTP ${res.status}`);
  }

  const text = await res.text();
  // 로그인 페이지 HTML 응답 detection — 200 으로 와도 사실 만료된 경우
  if (text.startsWith('<') || text.toLowerCase().includes('<!doctype') || text.includes('Login')) {
    throw new Error('SESSION_EXPIRED — 응답이 HTML (로그인 페이지)');
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`ResendGift 응답 파싱 실패: ${text.slice(0, 200)}`);
  }

  if (data.success !== 'Y') {
    throw new Error(`ResendGift 실패: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return { ok: true, response: data };
}

/** 현재 cookie 설정 상태 — 진단용 (값 노출 X, 길이만). */
function getConfigStatus() {
  return {
    base_url: ADMIN_BASE,
    cookie_set: !!ADMIN_COOKIE,
    cookie_length: ADMIN_COOKIE.length,
  };
}

/**
 * 네트워크 연결 진단 — admin.barunsoncard.com 도달 가능 여부만 확인.
 *   cookie 없어도 OK (auth 검증은 안 함). 컨테이너 outbound 차단 / DNS 이슈 발견용.
 *   GET / 로 HEAD 비슷한 가벼운 요청.
 */
async function testConnectivity() {
  const url = `${ADMIN_BASE}/`;
  const startedAt = Date.now();
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'user-agent': COMMON_HEADERS['user-agent'] },
      redirect: 'manual',
    });
    return {
      reachable: true,
      status: res.status,
      url,
      elapsed_ms: Date.now() - startedAt,
      // body 는 안 읽음 (HTML 다운로드 불필요)
    };
  } catch (e) {
    const cause = e.cause || {};
    return {
      reachable: false,
      url,
      elapsed_ms: Date.now() - startedAt,
      error: e.message,
      error_code: cause.code || cause.errno || null,
      error_detail: cause.message || null,
      // 흔한 코드:
      //   ENOTFOUND     — DNS 해석 실패 (컨테이너 DNS 설정 또는 도메인 차단)
      //   ECONNREFUSED  — 호스트는 보이는데 포트 차단
      //   EAI_AGAIN     — DNS 일시 실패
      //   ETIMEDOUT     — 네트워크 timeout (방화벽)
      //   UND_ERR_*     — undici (Node fetch) 내부 에러
    };
  }
}

module.exports = {
  resendGift,
  getConfigStatus,
  testConnectivity,
};
