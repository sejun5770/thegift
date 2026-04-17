// ============================================
// 알림톡 메시지 템플릿 관리
//
// 카카오 알림톡은 사전 승인된 템플릿만 발송 가능하다.
// 템플릿 본문에 #{변수명} 형태의 치환 변수를 넣고,
// 발송 시 실제 값으로 교체한다.
// ============================================

/** 템플릿에서 사용할 수 있는 변수 정의 */
export const TEMPLATE_VARIABLES = {
  고객명: { description: '수신자 이름', example: '홍길동' },
  상품명: { description: '답례품 상품명', example: '한지형 답례장' },
  주문번호: { description: '주문번호', example: 'BO-240417-0001' },
  주문정보URL: { description: '고객 주문정보 입력 페이지 URL', example: 'https://example.com/c/barungift/order-info?oid=...' },
} as const;

export type TemplateVariableKey = keyof typeof TEMPLATE_VARIABLES;

/** 기본 템플릿 (카카오 승인용 원본과 일치해야 함) */
const DEFAULT_TEMPLATE =
  `[바른손 답례품]\n` +
  `#{고객명}님, 답례품 주문이 접수되었습니다.\n\n` +
  `· 주문번호: #{주문번호}\n` +
  `· 상품: #{상품명}\n\n` +
  `아래 버튼을 눌러 출고 희망일과 스티커 정보를 입력해 주세요.`;

/** 기본 버튼 설정 */
const DEFAULT_BUTTON = {
  name: '주문정보 입력하기',
  type: 'WL' as const,
};

export interface TemplateConfig {
  templateCode: string;
  body: string;
  button: { name: string; type: 'WL' };
}

export function getTemplateConfig(): TemplateConfig {
  return {
    templateCode: process.env.BIZTALK_TEMPLATE_CODE_ORDER_INFO || 'MOCK_TEMPLATE',
    body: process.env.BIZTALK_TEMPLATE_BODY || DEFAULT_TEMPLATE,
    button: {
      name: process.env.BIZTALK_TEMPLATE_BUTTON_NAME || DEFAULT_BUTTON.name,
      type: DEFAULT_BUTTON.type,
    },
  };
}

export type TemplateVariables = Record<TemplateVariableKey, string>;

/**
 * 템플릿 본문의 #{변수명}을 실제 값으로 치환한다.
 */
export function renderTemplate(
  template: string,
  vars: TemplateVariables
): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`#{${key}}`, value);
  }
  return result;
}

function buildCustomerUrl(orderId: string): string {
  const base = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, '') || '';
  return `${base}/c/barungift/order-info?oid=${orderId}`;
}

export interface AlimtalkMessagePayload {
  text: string;
  templateCode: string;
  customerUrl: string;
  button: { name: string; type: 'WL'; url_mobile: string; url_pc: string };
  variables: TemplateVariables;
}

/**
 * 주문 정보로 발송용 메시지 페이로드를 조립한다.
 */
export function buildMessagePayload(params: {
  orderId: string;
  orderNumber: string | null;
  customerName: string | null;
  productName: string | null;
}): AlimtalkMessagePayload {
  const config = getTemplateConfig();
  const customerUrl = buildCustomerUrl(params.orderId);

  const variables: TemplateVariables = {
    고객명: params.customerName || '고객',
    상품명: params.productName || '답례품',
    주문번호: params.orderNumber || '-',
    주문정보URL: customerUrl,
  };

  const text = renderTemplate(config.body, variables);

  return {
    text,
    templateCode: config.templateCode,
    customerUrl,
    button: {
      name: config.button.name,
      type: config.button.type,
      url_mobile: customerUrl,
      url_pc: customerUrl,
    },
    variables,
  };
}

/**
 * 샘플 데이터로 미리보기용 메시지를 생성한다.
 */
export function buildSamplePayload(): AlimtalkMessagePayload {
  return buildMessagePayload({
    orderId: 'sample-order-id',
    orderNumber: 'BO-240417-0001',
    customerName: '홍길동',
    productName: '한지형 답례장',
  });
}
