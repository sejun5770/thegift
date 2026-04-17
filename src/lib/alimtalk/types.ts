// ============================================
// 알림톡 발송 타입 정의
// ============================================

/** 알림톡 버튼 유형 */
export type AlimtalkButtonType =
  | 'WL' // Web Link
  | 'AL' // App Link
  | 'BK' // Bot Keyword
  | 'MD' // Message Delivery
  | 'DS'; // Delivery Search

/** 알림톡 버튼 */
export interface AlimtalkButton {
  name: string;
  type: AlimtalkButtonType;
  url_mobile?: string;
  url_pc?: string;
  scheme_ios?: string;
  scheme_android?: string;
}

/** 알림톡 발송 요청 */
export interface SendAlimtalkRequest {
  to: string;
  templateCode: string;
  text: string;
  buttons?: AlimtalkButton[];
  /** 대체 SMS 발송 여부 */
  fallback?: {
    type: 'SMS' | 'LMS';
    text: string;
    from?: string;
  };
}

/** 알림톡 발송 결과 */
export interface SendAlimtalkResult {
  success: boolean;
  mock: boolean;
  messageId?: string;
  code?: string;
  message?: string;
  raw?: unknown;
}
