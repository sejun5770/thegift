import { addDays, format, isWeekend, isBefore, isAfter, startOfDay, parseISO } from 'date-fns';
import { ko } from 'date-fns/locale';
import { BG_DEFAULTS, BG_KOREAN_HOLIDAYS_2026 } from './constants';
import type { BgProductSettings } from './types';

// ============================================
// 날짜/시간 유틸리티
// ============================================

/** 현재 KST 시각 가져오기 */
export function getNowKST(): Date {
  // KST = UTC+9
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  return new Date(utc + 9 * 3600000);
}

/** 한국 공휴일 여부 확인 */
export function isKoreanHoliday(date: Date): boolean {
  const dateStr = format(date, 'yyyy-MM-dd');
  return (BG_KOREAN_HOLIDAYS_2026 as readonly string[]).includes(dateStr);
}

/** 영업일 여부 확인 (주말, 공휴일, 블랙아웃 제외) */
export function isBusinessDay(date: Date, blackoutDates: string[] = []): boolean {
  if (isWeekend(date)) return false;
  if (isKoreanHoliday(date)) return false;
  const dateStr = format(date, 'yyyy-MM-dd');
  if (blackoutDates.includes(dateStr)) return false;
  return true;
}

/** n영업일 후 날짜 계산 */
export function addBusinessDays(startDate: Date, days: number, blackoutDates: string[] = []): Date {
  let current = startDate;
  let remaining = days;
  while (remaining > 0) {
    current = addDays(current, 1);
    if (isBusinessDay(current, blackoutDates)) {
      remaining--;
    }
  }
  return current;
}

/** 빠른출고 컷오프 시간 경과 여부 (KST 기준) */
export function isExpressCutoffPassed(cutoffTime: string = BG_DEFAULTS.EXPRESS_CUTOFF_TIME): boolean {
  const now = getNowKST();
  const [hours, minutes] = cutoffTime.split(':').map(Number);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const cutoffMinutes = hours * 60 + minutes;
  return nowMinutes >= cutoffMinutes;
}

/** 최소 출고 가능일 계산 */
export function calculateMinShipDate(
  settings: BgProductSettings | null,
  isExpress: boolean
): Date {
  const today = startOfDay(getNowKST());
  const blackoutDates = settings?.blackout_dates || [];

  if (isExpress && settings?.express_available) {
    const cutoffTime = settings.express_cutoff_time || BG_DEFAULTS.EXPRESS_CUTOFF_TIME;
    const leadDays = isExpressCutoffPassed(cutoffTime)
      ? BG_DEFAULTS.EXPRESS_LEAD_TIME_AFTER_CUTOFF
      : BG_DEFAULTS.EXPRESS_LEAD_TIME_BEFORE_CUTOFF;
    return addBusinessDays(today, leadDays, blackoutDates);
  }

  const leadTimeDays = settings?.lead_time_days || BG_DEFAULTS.LEAD_TIME_DAYS;
  return addBusinessDays(today, leadTimeDays, blackoutDates);
}

/** 선택 가능한 날짜 범위 계산 (minDate ~ maxDate) */
export function calculateDateRange(
  settings: BgProductSettings | null,
  isExpress: boolean
): { minDate: Date; maxDate: Date } {
  const minDate = calculateMinShipDate(settings, isExpress);
  const maxSelectDays = settings?.max_select_days || BG_DEFAULTS.MAX_SELECT_DAYS;
  const maxDate = addDays(startOfDay(getNowKST()), maxSelectDays);

  return { minDate, maxDate };
}

/** 특정 날짜가 선택 가능한지 확인 */
export function isDateSelectable(
  date: Date,
  settings: BgProductSettings | null,
  isExpress: boolean
): boolean {
  const { minDate, maxDate } = calculateDateRange(settings, isExpress);
  const blackoutDates = settings?.blackout_dates || [];

  if (isBefore(startOfDay(date), startOfDay(minDate))) return false;
  if (isAfter(startOfDay(date), startOfDay(maxDate))) return false;
  if (!isBusinessDay(date, blackoutDates)) return false;

  return true;
}

/** 선택 가능한 날짜가 하나라도 있는지 확인 */
export function hasSelectableDates(
  settings: BgProductSettings | null,
  isExpress: boolean
): boolean {
  const { minDate, maxDate } = calculateDateRange(settings, isExpress);
  const blackoutDates = settings?.blackout_dates || [];

  let current = minDate;
  while (!isAfter(current, maxDate)) {
    if (isBusinessDay(current, blackoutDates)) return true;
    current = addDays(current, 1);
  }
  return false;
}

// ============================================
// 포맷 유틸리티
// ============================================

/** 날짜를 한국어 형식으로 포맷 ("2026년 4월 15일 (수)") */
export function formatDateKorean(date: Date | string): string {
  const d = typeof date === 'string' ? parseISO(date) : date;
  return format(d, 'yyyy년 M월 d일 (EEE)', { locale: ko });
}

/** 금액 포맷 ("45,000원") */
export function formatCurrency(amount: number): string {
  return `${amount.toLocaleString('ko-KR')}원`;
}

/** 전화번호 포맷 ("010-1234-5678") */
export function formatPhoneNumber(phone: string): string {
  const cleaned = phone.replace(/\D/g, '');
  if (cleaned.length === 11) {
    return `${cleaned.slice(0, 3)}-${cleaned.slice(3, 7)}-${cleaned.slice(7)}`;
  }
  if (cleaned.length === 10) {
    return `${cleaned.slice(0, 3)}-${cleaned.slice(3, 6)}-${cleaned.slice(6)}`;
  }
  return phone;
}
