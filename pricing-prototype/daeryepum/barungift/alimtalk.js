/**
 * 비즈톡(InfoBank OMNI API) 알림톡 클라이언트
 *
 * Node.js stdlib만 사용. 외부 패키지 없이 HTTPS로 직접 호출.
 *
 * 환경변수:
 *  - BIZTALK_CLIENT_ID
 *  - BIZTALK_CLIENT_PASSWD
 *  - BIZTALK_SENDER_KEY
 *  - BIZTALK_BASE_URL (기본: https://omni.ibapi.kr)
 *  - BIZTALK_TEMPLATE_CODE_ORDER_INFO
 *  - BIZTALK_TEMPLATE_BODY (선택, 승인본 오버라이드)
 *  - BIZTALK_TEMPLATE_BUTTON_NAME (선택, 빈 값이면 버튼 없음)
 *  - BIZTALK_TEMPLATE_BUTTON_DISABLED=true (선택)
 */
const https = require('https');
const { URL } = require('url');

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

function httpsRequest(urlStr, options, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const reqOpts = {
      method: options.method || 'GET',
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      headers: options.headers || {},
    };
    const req = https.request(reqOpts, (res) => {
      let chunks = '';
      res.on('data', (c) => (chunks += c));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: chunks,
        });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

let cachedToken = null; // { token, expiresAt }

async function fetchAccessToken(config) {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 60_000) {
    return cachedToken.token;
  }

  const res = await httpsRequest(
    `${config.baseUrl}/v1/auth/token`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-IB-Client-Id': config.clientId,
        'X-IB-Client-Passwd': config.clientPasswd,
      },
    },
    JSON.stringify({})
  );

  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`비즈톡 토큰 발급 실패 (${res.statusCode}): ${res.body}`);
  }

  let data;
  try {
    data = JSON.parse(res.body);
  } catch {
    throw new Error(`비즈톡 토큰 응답 파싱 실패: ${res.body}`);
  }

  const token = data?.data?.token;
  if (!token) throw new Error(`토큰이 응답에 없음: ${res.body}`);

  const expiredAt = data?.data?.expired
    ? new Date(data.data.expired).getTime()
    : now + 60 * 60 * 1000;

  cachedToken = { token, expiresAt: expiredAt };
  return token;
}

function normalizePhone(phone) {
  return String(phone || '').replace(/[^0-9]/g, '');
}

/**
 * 알림톡 1건 발송.
 * @returns {{ success, mock, messageId?, code?, message?, raw? }}
 */
async function sendAlimtalk(req) {
  const config = getConfig();

  if (!config) {
    console.log('[Alimtalk][mock]', {
      to: req.to,
      templateCode: req.templateCode,
      textPreview: String(req.text || '').slice(0, 60),
      buttons: (req.buttons || []).length,
    });
    return {
      success: true,
      mock: true,
      messageId: `mock_${Date.now()}`,
      message: 'mock mode',
    };
  }

  const token = await fetchAccessToken(config);

  const body = {
    senderKey: config.senderKey,
    msgType: 'AT',
    to: normalizePhone(req.to),
    text: req.text,
    templateCode: req.templateCode,
  };
  if (Array.isArray(req.buttons) && req.buttons.length > 0) {
    body.button = req.buttons;
  }
  if (req.fallback) {
    body.fallback = {
      type: req.fallback.type,
      text: req.fallback.text,
      ...(req.fallback.from ? { from: req.fallback.from } : {}),
    };
  }

  const res = await httpsRequest(
    `${config.baseUrl}/v1/send/alimtalk`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
    },
    JSON.stringify(body)
  );

  let raw = null;
  try {
    raw = res.body ? JSON.parse(res.body) : null;
  } catch {
    raw = { parseError: res.body };
  }

  const okStatus = res.statusCode >= 200 && res.statusCode < 300;
  const success = okStatus && (raw?.code === '0000' || raw?.result === 'success');

  return {
    success,
    mock: false,
    messageId: raw?.messageId,
    code: raw?.code,
    message: raw?.message,
    raw,
  };
}

module.exports = { sendAlimtalk, isBiztalkConfigured };
