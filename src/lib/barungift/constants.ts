import type { BgBankInfo } from './types';

// ============================================
// 고객 정보 수집 상수
// ============================================

/** 5단계 스텝 라벨 */
export const BG_STEP_LABELS = [
  '출고 방식',
  '희망출고일',
  '스티커 선택',
  '결제정보',
  '최종 확인',
] as const;

/** 스텝 수 */
export const BG_TOTAL_STEPS = BG_STEP_LABELS.length;

/** 현금영수증 유형 라벨 */
export const BG_RECEIPT_TYPE_LABELS: Record<string, string> = {
  personal: '소득공제용 (휴대폰번호)',
  business: '지출증빙용 (사업자번호)',
};

/** 무통장입금 계좌 정보 */
export const BG_BANK_INFO: BgBankInfo = {
  bank_name: '신한은행',
  account_number: '100-013-801261',
  account_holder: '바른컴퍼니',
};

/** 에러 메시지 */
export const BG_ERROR_MESSAGES = {
  ORDER_NOT_FOUND: '주문 정보를 찾을 수 없습니다.',
  ORDER_CANCELLED: '취소된 주문입니다.',
  ALREADY_SUBMITTED: '이미 정보 입력이 완료된 주문입니다.',
  ALL_DATES_BLACKED_OUT: '선택 가능한 출고일이 없습니다. 고객센터로 문의해주세요.',
  SUBMIT_FAILED: '정보 저장에 실패했습니다. 다시 시도해주세요.',
  NETWORK_ERROR: '네트워크 오류가 발생했습니다. 잠시 후 다시 시도해주세요.',
  INVALID_ORDER_ID: '유효하지 않은 주문번호입니다.',
  CS_CONTACT: '고객센터: 1644-0708',
} as const;

/** 기본값 */
export const BG_DEFAULTS = {
  LEAD_TIME_DAYS: 5,
  MAX_SELECT_DAYS: 60,
  EXPRESS_CUTOFF_TIME: '14:00',
  EXPRESS_LEAD_TIME_BEFORE_CUTOFF: 1, // 컷오프 전: +1영업일
  EXPRESS_LEAD_TIME_AFTER_CUTOFF: 2,  // 컷오프 후: +2영업일
} as const;

/** 출고 방식 라벨 */
export const BG_SHIPPING_TYPE_LABELS = {
  normal: '일반 출고',
  express: '빠른 출고',
} as const;

/** 한국 공휴일 (2026년) - 필요 시 확장 */
export const BG_KOREAN_HOLIDAYS_2026 = [
  '2026-01-01', // 신정
  '2026-02-16', // 설날 연휴
  '2026-02-17', // 설날
  '2026-02-18', // 설날 연휴
  '2026-03-01', // 삼일절
  '2026-05-05', // 어린이날
  '2026-05-24', // 부처님오신날
  '2026-06-06', // 현충일
  '2026-08-15', // 광복절
  '2026-09-24', // 추석 연휴
  '2026-09-25', // 추석
  '2026-09-26', // 추석 연휴
  '2026-10-03', // 개천절
  '2026-10-09', // 한글날
  '2026-12-25', // 크리스마스
] as const;
