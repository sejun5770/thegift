import type { DateFilterType, PeriodPreset } from './enums';

export interface PeriodFilter {
  dateType: DateFilterType;
  preset: PeriodPreset;
  startDate: string; // ISO date string YYYY-MM-DD
  endDate: string;   // ISO date string YYYY-MM-DD
  month?: string;    // YYYY-MM for monthly preset
}

export interface DashboardSummary {
  order_status: {
    total: number;
    collected: number;
    cancelled: number;
    validation_failed: number;
    system_error: number;
  };
  work_status: {
    draft_completed: number;
    print_ready: number;
    print_completed: number;
    binding_completed: number;
    shipping_completed: number;
  };
}

export interface ShippingMonthData {
  month: string;      // YYYY-MM
  label: string;      // 표시 라벨 (예: "2026년 3월")
  total_count: number;
  is_current: boolean;
}
