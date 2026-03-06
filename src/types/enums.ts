// 주문 상태
export type OrderStatus =
  | 'collected'           // 수집완료
  | 'cancelled'           // 취소주문
  | 'validation_failed'   // 검증실패
  | 'system_error'        // 시스템오류
  | 'draft_completed'     // 초안생성완료
  | 'print_ready'         // 인쇄준비
  | 'print_completed'     // 인쇄완료
  | 'binding_completed'   // 제본완료
  | 'shipping_completed'; // 출고완료

// 출고방식
export type ShippingMethod =
  | 'parcel'    // 택배
  | 'same_day'  // 오늘출발
  | 'quick'     // 퀵
  | 'terminal'; // 터미널

// 하이라이트 타입
export type HighlightType =
  | 'multi_product'     // 복수상품
  | 'check_required'    // 점검필요
  | 'split_shipping'    // 나눔배송
  | 'schedule_changed'  // 출고변경
  | 'incident'          // 사고주문
  | 'admin_memo';       // 관리자메모

// 주문 소스
export type OrderSource = 'external' | 'admin';

// 기간 검색 조건
export type DateFilterType = 'desired_shipping_date' | 'collected_at';

// 기간 프리셋
export type PeriodPreset =
  | 'today'
  | 'yesterday'
  | 'last_2_days'
  | 'last_3_days'
  | 'last_7_days'
  | 'last_30_days'
  | 'monthly'
  | 'custom';

// 주문관리 탭
export type OrderTab =
  | 'all'                // 전체
  | 'collected'          // 수집완료
  | 'draft_completed'    // 초안완료
  | 'print_ready'        // 인쇄준비
  | 'print_completed'    // 인쇄완료
  | 'binding_completed'  // 제본완료
  | 'shipping_completed' // 출고완료
  | 'validation_failed'; // 검증실패
