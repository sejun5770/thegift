/**
 * Barunson Partner API 기반 알림톡 발송 클라이언트 + 템플릿
 *
 * InfoBank OMNI를 직접 호출하지 않고, 바른손 자체 Partner API를 경유한다.
 *   1) POST /api/Partner/authenticate   → Bearer 토큰 발급
 *   2) POST /api/Biztalk/send           → 알림톡 발송 (Authorization: Bearer)
 *
 * 환경변수:
 *   BIZTALK_API_URL         (기본: https://api.barunsoncard.com)
 *   PARTNER_CLIENT_ID       (필수, 바른손 API 담당자 문의)
 *   PARTNER_CLIENT_SECRET   (필수)
 *   KAKAO_SENDER_KEY        (필수, 비즈 채널 발신 프로필 키)
 *   KAKAO_CALLBACK          (기본: 1644-0708)
 *   BIZTALK_TEMPLATE_CODE_ORDER_INFO (기본: BH0175_3)
 *   BIZTALK_TEMPLATE_BODY   (선택, 카카오 승인본 그대로)
 *   BIZTALK_TEMPLATE_SUBJECT (선택)
 */

// ============================================
// 설정 + 토큰 캐시
// ============================================
let cachedToken = null; // { token, expires(ms), refreshToken, refreshExpires(ms) }

function getConfig() {
  const clientId = process.env.PARTNER_CLIENT_ID;
  const clientSecret = process.env.PARTNER_CLIENT_SECRET;
  const senderKey = process.env.KAKAO_SENDER_KEY;
  const baseUrl = (process.env.BIZTALK_API_URL || 'https://api.barunsoncard.com').replace(/\/$/, '');
  const callback = process.env.KAKAO_CALLBACK || '1644-0708';

  if (!clientId || !clientSecret || !senderKey) return null;
  return { baseUrl, clientId, clientSecret, senderKey, callback };
}

function isBiztalkConfigured() {
  return getConfig() !== null;
}

function parseExpires(isoStr, fallbackMs) {
  if (!isoStr) return fallbackMs;
  const t = new Date(isoStr).getTime();
  return Number.isFinite(t) ? t : fallbackMs;
}

async function authenticate(config) {
  const res = await fetch(`${config.baseUrl}/api/Partner/authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Partner 인증 실패 (${res.status}): ${text}`);
  }

  const data = await res.json();
  if (!data?.token) {
    throw new Error(`Partner 응답에 token 없음: ${JSON.stringify(data)}`);
  }

  const now = Date.now();
  cachedToken = {
    token: data.token,
    expires: parseExpires(data.expires, now + 60 * 60 * 1000),
    refreshToken: data.refreshToken || null,
    refreshExpires: parseExpires(data.refreshTokenExpires, now + 24 * 60 * 60 * 1000),
  };
  return cachedToken.token;
}

async function refreshOrReauth(config) {
  const now = Date.now();
  if (cachedToken?.refreshToken && cachedToken.refreshExpires > now + 60_000) {
    try {
      const res = await fetch(`${config.baseUrl}/api/Partner/refresh-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId: config.clientId,
          refreshToken: cachedToken.refreshToken,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data?.token) {
          cachedToken = {
            token: data.token,
            expires: parseExpires(data.expires, now + 60 * 60 * 1000),
            refreshToken: data.refreshToken || cachedToken.refreshToken,
            refreshExpires: parseExpires(data.refreshTokenExpires, cachedToken.refreshExpires),
          };
          return cachedToken.token;
        }
      }
    } catch (e) {
      console.warn('[Alimtalk] refresh 실패, 재인증 시도:', e.message);
    }
  }
  return authenticate(config);
}

async function getToken(config) {
  const now = Date.now();
  if (cachedToken && cachedToken.expires > now + 5 * 60_000) {
    return cachedToken.token;
  }
  if (cachedToken) return refreshOrReauth(config);
  return authenticate(config);
}

// 전화번호 정규화: 하이픈 포함 형식 필수
function normalizePhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('02')) {
    if (digits.length === 9) return `${digits.slice(0, 2)}-${digits.slice(2, 5)}-${digits.slice(5)}`;
    if (digits.length === 10) return `${digits.slice(0, 2)}-${digits.slice(2, 6)}-${digits.slice(6)}`;
    return digits;
  }
  if (digits.length === 10) return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  if (digits.length === 11) return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`;
  return digits;
}

async function sendViaPartner(config, req) {
  const token = await getToken(config);

  const body = {
    recipientNum: normalizePhone(req.to),
    content: req.text,
    templateCode: req.templateCode,
    senderKey: config.senderKey,
    callback: req.callback || config.callback,
    subject: req.subject || '알림톡',
    msgType: 1008,
  };

  const doSend = async (authToken) => {
    return fetch(`${config.baseUrl}/api/Biztalk/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify(body),
    });
  };

  let res = await doSend(token);

  // 401 시 토큰 갱신 후 1회 재시도
  if (res.status === 401) {
    const newToken = await refreshOrReauth(config);
    res = await doSend(newToken);
  }

  let raw = null;
  try { raw = await res.json(); } catch {}

  const success = res.ok && (raw?.success === true || raw?.code === '0000' || raw?.result === 'success');

  return {
    success,
    mock: false,
    messageId: raw?.tranId ? String(raw.tranId) : (raw?.messageId || undefined),
    code: raw?.code,
    message: raw?.message || raw?.errors,
    raw,
  };
}

/**
 * 알림톡 발송. 설정 없으면 mock 응답 반환.
 */
async function sendAlimtalk(req) {
  const config = getConfig();

  if (!config) {
    console.log('[Alimtalk][mock]', {
      to: req.to,
      templateCode: req.templateCode,
      textPreview: String(req.text || '').slice(0, 60),
    });
    return {
      success: true,
      mock: true,
      messageId: `mock_${Date.now()}`,
      message: 'mock mode',
    };
  }

  try {
    return await sendViaPartner(config, req);
  } catch (e) {
    return {
      success: false,
      mock: false,
      message: e.message,
    };
  }
}

// ============================================
// 템플릿 관리 (BH0175_3 기본)
// ============================================

const TEMPLATE_VARIABLES = {
  고객명: { description: '수신자 이름', example: '홍길동' },
  name: { description: '수신자 이름(영문 변수)', example: '홍길동' },
  상품명: { description: '답례품 상품명', example: '한지형 답례장' },
  주문번호: { description: '주문번호', example: 'BO-240417-0001' },
  주문정보URL: { description: '고객 주문정보 입력 페이지 URL', example: 'https://example.com/...' },
};

// wedd_biztalk.BH0175_3 승인본
const DEFAULT_TEMPLATE_CODE = 'BH0175_3';
const DEFAULT_TEMPLATE_SUBJECT = '[바른손카드] 회원가입 안내';
const DEFAULT_TEMPLATE =
  `[바른손카드] 회원가입 안내\n\n` +
  `안녕하세요 #{name}고객님, 바른손카드 회원가입을 축하드립니다.\n\n` +
  `바른손카드 회원님께만 드리는 '프리미엄 기프트팩' 햬택이 제공 되었습니다.\n` +
  `지금 바로 확인하고 주문을 시작해 보세요.\n\n` +
  `■회원가입 즉시 무료 혜택\n` +
  `- 청첩장 샘플 12종+배송비 무료\n` +
  `- 213종 모바일 청첩장 무료 사용\n` +
  `※예식 후에도 366일간 보관!\n\n` +
  `■프리미엄 기프트팩 (전체 무료)\n` +
  `- 거실을 빛낼 최고급 아크릴 액자\n` +
  `- 청첩장 필수옵션 봉투+스티커 SET\n` +
  `- 놓치기 쉬운 식권 (신랑/신부측)\n` +
  `- 퀄리티가 다른 식전/감사 영상\n\n` +
  `남은 결혼 준비도 바른손카드가 든든하게 지원하겠습니다.\n\n` +
  `바른손카드 고객센터 (1644-0708)`;

function getTemplateConfig() {
  return {
    templateCode: process.env.BIZTALK_TEMPLATE_CODE_ORDER_INFO || DEFAULT_TEMPLATE_CODE,
    subject: process.env.BIZTALK_TEMPLATE_SUBJECT || DEFAULT_TEMPLATE_SUBJECT,
    body: process.env.BIZTALK_TEMPLATE_BODY || DEFAULT_TEMPLATE,
    // Partner API 방식은 카카오 템플릿 자체에 버튼이 정의됨.
    // UI 미리보기를 위한 플레이스홀더만 유지.
    button: null,
  };
}

function renderTemplate(template, vars) {
  let result = String(template || '');
  for (const [key, value] of Object.entries(vars || {})) {
    if (value == null) continue;
    result = result.split(`#{${key}}`).join(String(value));
  }
  return result;
}

function buildCustomerUrl(orderId) {
  const publicBase = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  if (publicBase) {
    return `${publicBase}/order-info?oid=${encodeURIComponent(orderId)}`;
  }
  const basePath = (process.env.BASE_PATH || '').replace(/\/$/, '');
  return `${basePath}/order-info?oid=${encodeURIComponent(orderId)}`;
}

function buildMessagePayload(params) {
  const config = getTemplateConfig();
  const customerUrl = buildCustomerUrl(params.orderId);

  const customerName = params.customerName || '고객';
  const productName = params.productName || '답례품';
  const orderNumber = params.orderNumber || '-';

  const variables = {
    고객명: customerName,
    name: customerName,
    상품명: productName,
    주문번호: orderNumber,
    주문정보URL: customerUrl,
  };

  const text = renderTemplate(config.body, variables);

  return {
    text,
    templateCode: config.templateCode,
    subject: config.subject,
    customerUrl,
    button: config.button,
    variables,
  };
}

function buildSamplePayload() {
  return buildMessagePayload({
    orderId: 'sample-order-id',
    orderNumber: 'BO-240417-0001',
    customerName: '홍길동',
    productName: '한지형 답례장',
  });
}

module.exports = {
  sendAlimtalk,
  isBiztalkConfigured,
  getTemplateConfig,
  buildMessagePayload,
  buildSamplePayload,
  renderTemplate,
  TEMPLATE_VARIABLES,
};
