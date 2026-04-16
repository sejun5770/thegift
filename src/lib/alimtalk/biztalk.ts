import type {
  SendAlimtalkRequest,
  SendAlimtalkResult,
} from './types';

// ============================================
// 비즈톡(InfoBank) 알림톡 클라이언트
//
// API 문서: https://omni.ibapi.kr (InfoBank OMNI)
//  - POST /v1/auth/token : 액세스 토큰 발급
//  - POST /v1/send/alimtalk : 알림톡 발송
// ============================================

interface BiztalkConfig {
  baseUrl: string;
  clientId: string;
  clientPasswd: string;
  senderKey: string;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

let cachedToken: CachedToken | null = null;

function getConfig(): BiztalkConfig | null {
  const clientId = process.env.BIZTALK_CLIENT_ID;
  const clientPasswd = process.env.BIZTALK_CLIENT_PASSWD;
  const senderKey = process.env.BIZTALK_SENDER_KEY;
  const baseUrl = process.env.BIZTALK_BASE_URL || 'https://omni.ibapi.kr';

  if (!clientId || !clientPasswd || !senderKey) {
    return null;
  }

  return { baseUrl, clientId, clientPasswd, senderKey };
}

export function isBiztalkConfigured(): boolean {
  return getConfig() !== null;
}

async function fetchAccessToken(config: BiztalkConfig): Promise<string> {
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

  const data = (await res.json()) as {
    code?: string;
    data?: { token?: string; schema?: string; expired?: string };
  };

  const token = data?.data?.token;
  if (!token) {
    throw new Error(`비즈톡 토큰 응답에 token이 없습니다: ${JSON.stringify(data)}`);
  }

  // 토큰 만료 시각. 응답에 없으면 1시간 보수적으로 캐시.
  const expiredAt = data?.data?.expired
    ? new Date(data.data.expired).getTime()
    : now + 60 * 60 * 1000;

  cachedToken = { token, expiresAt: expiredAt };
  return token;
}

function normalizePhone(phone: string): string {
  return phone.replace(/[^0-9]/g, '');
}

async function sendViaBiztalk(
  config: BiztalkConfig,
  req: SendAlimtalkRequest
): Promise<SendAlimtalkResult> {
  const token = await fetchAccessToken(config);

  const body = {
    senderKey: config.senderKey,
    msgType: 'AT',
    to: normalizePhone(req.to),
    text: req.text,
    templateCode: req.templateCode,
    ...(req.buttons && req.buttons.length > 0 ? { button: req.buttons } : {}),
    ...(req.fallback
      ? {
          fallback: {
            type: req.fallback.type,
            text: req.fallback.text,
            ...(req.fallback.from ? { from: req.fallback.from } : {}),
          },
        }
      : {}),
  };

  const res = await fetch(`${config.baseUrl}/v1/send/alimtalk`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  const raw = (await res.json().catch(() => null)) as {
    code?: string;
    result?: string;
    messageId?: string;
    message?: string;
  } | null;

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
 * 알림톡 발송. API 키가 설정되지 않은 경우 mock 응답을 반환한다.
 */
export async function sendAlimtalk(
  req: SendAlimtalkRequest
): Promise<SendAlimtalkResult> {
  const config = getConfig();

  if (!config) {
    console.log('[Alimtalk][mock] 발송 요청 (API 키 미설정):', {
      to: req.to,
      templateCode: req.templateCode,
      textPreview: req.text.slice(0, 60),
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
