import type { OrderStatus, ShippingMethod, HighlightType, OrderTab, PeriodPreset } from '@/types/enums';

// 주문 상태 라벨
export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  collected: '수집완료',
  cancelled: '취소주문',
  validation_failed: '검증실패',
  system_error: '시스템오류',
  draft_completed: '초안완료',
  print_ready: '인쇄준비',
  print_completed: '인쇄완료',
  binding_completed: '제본완료',
  shipping_completed: '출고완료',
};

// 주문 상태 카드 색상
export const ORDER_STATUS_COLORS: Record<OrderStatus, string> = {
  collected: 'bg-blue-50 text-blue-700 border-blue-200',
  cancelled: 'bg-red-50 text-red-700 border-red-200',
  validation_failed: 'bg-orange-50 text-orange-700 border-orange-200',
  system_error: 'bg-red-50 text-red-700 border-red-200',
  draft_completed: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  print_ready: 'bg-violet-50 text-violet-700 border-violet-200',
  print_completed: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  binding_completed: 'bg-cyan-50 text-cyan-700 border-cyan-200',
  shipping_completed: 'bg-green-50 text-green-700 border-green-200',
};

// 배지 색상
export const ORDER_STATUS_BADGE_COLORS: Record<OrderStatus, string> = {
  collected: 'bg-blue-100 text-blue-800',
  cancelled: 'bg-red-100 text-red-800',
  validation_failed: 'bg-orange-100 text-orange-800',
  system_error: 'bg-red-100 text-red-800',
  draft_completed: 'bg-emerald-100 text-emerald-800',
  print_ready: 'bg-violet-100 text-violet-800',
  print_completed: 'bg-indigo-100 text-indigo-800',
  binding_completed: 'bg-cyan-100 text-cyan-800',
  shipping_completed: 'bg-green-100 text-green-800',
};

// 출고방식 라벨
export const SHIPPING_METHOD_LABELS: Record<ShippingMethod, string> = {
  parcel: '택배',
  same_day: '오늘출발',
  quick: '퀵',
  terminal: '터미널',
};

export const SHIPPING_METHOD_COLORS: Record<ShippingMethod, string> = {
  parcel: 'bg-gray-100 text-gray-700',
  same_day: 'bg-amber-100 text-amber-800',
  quick: 'bg-rose-100 text-rose-800',
  terminal: 'bg-purple-100 text-purple-800',
};

// 하이라이트 라벨
export const HIGHLIGHT_LABELS: Record<HighlightType, string> = {
  multi_product: '복수',
  check_required: '점검',
  split_shipping: '나눔',
  schedule_changed: '일정',
  incident: '사고',
  admin_memo: '메모',
};

export const HIGHLIGHT_COLORS: Record<HighlightType, string> = {
  multi_product: 'bg-blue-100 text-blue-800',
  check_required: 'bg-orange-100 text-orange-800',
  split_shipping: 'bg-green-100 text-green-800',
  schedule_changed: 'bg-purple-100 text-purple-800',
  incident: 'bg-red-100 text-red-800',
  admin_memo: 'bg-gray-100 text-gray-700',
};

// 상태 전이 규칙
export const VALID_STATUS_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  collected: ['draft_completed', 'cancelled', 'validation_failed'],
  draft_completed: ['print_ready', 'validation_failed', 'collected'],
  print_ready: ['print_completed', 'validation_failed', 'draft_completed'],
  print_completed: ['binding_completed', 'validation_failed', 'print_ready'],
  binding_completed: ['shipping_completed', 'validation_failed', 'print_completed'],
  shipping_completed: [],
  cancelled: ['collected'],
  validation_failed: ['collected'],
  system_error: ['collected'],
};

// 주문 현황 표시 상태 (대시보드)
export const DASHBOARD_ORDER_STATUSES: OrderStatus[] = [
  'collected',
  'cancelled',
  'validation_failed',
  'system_error',
];

// 작업 현황 표시 상태 (대시보드)
export const DASHBOARD_WORK_STATUSES: OrderStatus[] = [
  'draft_completed',
  'print_ready',
  'print_completed',
  'binding_completed',
  'shipping_completed',
];

// 주문관리 탭 정의
export const ORDER_TABS: { value: OrderTab; label: string; statuses: OrderStatus[] }[] = [
  { value: 'all', label: '전체', statuses: [] },
  { value: 'collected', label: '수집완료', statuses: ['collected'] },
  { value: 'draft_completed', label: '초안완료', statuses: ['draft_completed'] },
  { value: 'print_ready', label: '인쇄준비', statuses: ['print_ready'] },
  { value: 'print_completed', label: '인쇄완료', statuses: ['print_completed'] },
  { value: 'binding_completed', label: '제본완료', statuses: ['binding_completed'] },
  { value: 'shipping_completed', label: '출고완료', statuses: ['shipping_completed'] },
  { value: 'validation_failed', label: '검증실패', statuses: ['validation_failed'] },
];

// 기간 프리셋 정의
export const PERIOD_PRESETS: { value: PeriodPreset; label: string }[] = [
  { value: 'today', label: '오늘' },
  { value: 'yesterday', label: '어제' },
  { value: 'last_2_days', label: '최근 2일' },
  { value: 'last_3_days', label: '최근 3일' },
  { value: 'last_7_days', label: '최근 7일' },
  { value: 'last_30_days', label: '최근 30일' },
  { value: 'monthly', label: '월별' },
  { value: 'custom', label: '기간 직접 선택' },
];
