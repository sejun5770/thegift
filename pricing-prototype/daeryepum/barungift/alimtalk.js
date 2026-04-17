/**
 * 비즈톡(InfoBank) 알림톡 클라이언트 + 템플릿
 * Node.js HTTP 서버용 포팅 (Next.js: src/lib/alimtalk/biztalk.ts + template.ts)
 *
 * API 문서: https://omni.ibapi.kr (InfoBank OMNI)
 *  - POST /v1/auth/token : 액세스 토큰 발급
 *  - POST /v1/send/alimtalk : 알림톡 발송
 */

// ============================================
// 비즈톡 설정 + 토큰 캐시
// ============================================
let cachedToken = null;

function getConfig() {
  const clientId = process.env.BIZTALK_CLIENT_ID;
  const clientPasswd = process.env.BIZTALK_CLIENT_PASSWD;
  const senderKey = process.env.BIZTALK_SENDER_KEY;
  const baseUrl = process.env.BIZTALK_BASE_URL || 'https://omni.ibapi.kr';
  if (!clientId || !clientPasswd || !senderKey) return null;
  return { baseUrl, clientId, clientPasswd, senderKey };
}

function isBiztalkConfigured() {
  return getConfig() !== null;
}

async function fetchAccessToken(config) {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 60_000) {
    return cachedToken.token;
  }

  const res = await fetch(`${config.baseUrl}/v1/auth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-IB-Client-Id': config.clientId,
      'X-IB-Client-Passwd': config.clientPasswd,
    },
    body: JSON.stringify({}),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`비즈톡 토큰 발급 실패 (${res.status}): ${text}`);
  }

  const data = await res.json();
  const token = data?.data?.token;
  if (!token) throw new Error(`비즈톡 토큰 응답에 token 없음: ${JSON.stringify(data)}`);

  const expiredAt = data?.data?.expired
    ? new Date(data.data.expired).getTime()
    : now + 60 * 60 * 1000;

  cachedToken = { token, expiresAt: expiredAt };
  return token;
}

function normalizePhone(phone) {
  return String(phone || '').replace(/[^0-9]/g, '');
}

async function sendViaBiztalk(config, req) {
  const token = await fetchAccessToken(config);
  const body = {
    senderKey: config.senderKey,
    msgType: 'AT',
    to: normalizePhone(req.to),
    text: req.text,
    templateCode: req.templateCode,
  };
  if (Array.isArray(req.buttons) && req.buttons.length > 0) body.button = req.buttons;
  if (req.fallback) {
    body.fallback = {
      type: req.fallback.type,
      text: req.fallback.text,
      ...(req.fallback.from ? { from: req.fallback.from } : {}),
    };
  }

  const res = await fetch(`${config.baseUrl}/v1/send/alimtalk`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  let raw = null;
  try { raw = await res.json(); } catch {}

  const success = res.ok && (raw?.code === '0000' || raw?.result === 'success');

  return {
    success,
    mock: false,
    messageId: raw?.messageId,
    code: raw?.code,
    message: raw?.message,
    raw,
  };
}

/**
 * 알림톡 발송. 설정 없으면 mock 응답 반환.
 * @param {{ to, templateCode, text, buttons?, fallback? }} req
 * @returns {Promise<{success,mock,messageId?,code?,message?,raw?}>}
 */
async function sendAlimtalk(req) {
  const config = getConfig();

  if (!config) {
    console.log('[Alimtalk][mock]', {
      to: req.to,
      templateCode: req.templateCode,
      textPreview: String(req.text || '').slice(0, 60),
      buttons: req.buttons?.length ?? 0,
    });
    return {
      success: true,
      mock: true,
      messageId: `mock_${Date.now()}`,
      message: 'mock mode',
    };
  }

  return sendViaBiztalk(config, req);
}

// ============================================
// 템플릿 관리
// ============================================

const TEMPLATE_VARIABLES = {
  고객명: { description: '수신자 이름', example: '홍길동' },
  name: { description: '수신자 이름(영문 변수)', example: '홍길동' },
  상품명: { description: '답례품 상품명', example: '한지형 답례장' },
  주문번호: { description: '주문번호', example: 'BO-240417-0001' },
  주문정보URL: { description: '고객 주문정보 입력 페이지 URL', example: 'https://example.com/...' },
};

// 비즈톡 승인 템플릿 BH0175_3 (회원가입 안내, #{name} 변수 1개)
// 카카오 승인본과 1바이트도 다르면 발송 거부되므로 정확히 일치해야 함
const DEFAULT_TEMPLATE_CODE = 'BH0175_3';
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

const DEFAULT_BUTTON_NAME = '';

function getButtonConfig() {
  // BH0175_3 템플릿은 버튼이 없으므로 기본 비활성화
  // 환경변수로 강제 활성화하려면 BIZTALK_TEMPLATE_BUTTON_NAME에 값 입력
  if (process.env.BIZTALK_TEMPLATE_BUTTON_DISABLED === 'true') return null;
  const envName = process.env.BIZTALK_TEMPLATE_BUTTON_NAME;
  if (!envName) return null; // 값이 없거나 빈 문자열이면 버튼 없음
  return {
    name: envName,
    type: 'WL',
  };
}

function getTemplateConfig() {
  return {
    templateCode: process.env.BIZTALK_TEMPLATE_CODE_ORDER_INFO || DEFAULT_TEMPLATE_CODE,
    body: process.env.BIZTALK_TEMPLATE_BODY || DEFAULT_TEMPLATE,
    button: getButtonConfig(),
  };
}

function renderTemplate(template, vars) {
  let result = String(template || '');
  for (const [key, value] of Object.entries(vars || {})) {
    if (value == null) continue;
    // replaceAll로 #{key} 모두 치환
    result = result.split(`#{${key}}`).join(String(value));
  }
  return result;
}

function buildCustomerUrl(orderId) {
  // PUBLIC_BASE_URL: 전체 URL (예: https://docker-manager.barunsoncard.com/c/barungift)
  // BASE_PATH:      /c/barungift 와 같은 경로만 있는 경우 상대경로
  const publicBase = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  if (publicBase) {
    return `${publicBase}/order-info?oid=${encodeURIComponent(orderId)}`;
  }
  const basePath = (process.env.BASE_PATH || '').replace(/\/$/, '');
  return `${basePath}/order-info?oid=${encodeURIComponent(orderId)}`;
}

/**
 * 주문 정보로 발송용 메시지 페이로드를 조립.
 */
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
    customerUrl,
    button: config.button
      ? {
          name: config.button.name,
          type: config.button.type,
          url_mobile: customerUrl,
          url_pc: customerUrl,
        }
      : null,
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
