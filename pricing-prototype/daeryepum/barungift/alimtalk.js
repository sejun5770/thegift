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

const DEFAULT_TEMPLATE =
  `[바른손 답례품]\n` +
  `#{고객명}님, 답례품 주문이 접수되었습니다.\n\n` +
  `· 주문번호: #{주문번호}\n` +
  `· 상품: #{상품명}\n\n` +
  `아래 버튼을 눌러 출고 희망일과 스티커 정보를 입력해 주세요.`;

const DEFAULT_BUTTON_NAME = '주문정보 입력하기';

function getButtonConfig() {
  if (process.env.BIZTALK_TEMPLATE_BUTTON_DISABLED === 'true') return null;
  const envName = process.env.BIZTALK_TEMPLATE_BUTTON_NAME;
  if (envName === '') return null;
  return {
    name: envName || DEFAULT_BUTTON_NAME,
    type: 'WL',
  };
}

function getTemplateConfig() {
  return {
    templateCode: process.env.BIZTALK_TEMPLATE_CODE_ORDER_INFO || 'MOCK_TEMPLATE',
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
