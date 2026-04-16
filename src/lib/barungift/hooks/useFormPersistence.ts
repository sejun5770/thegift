'use client';

import { useState, useEffect, useCallback } from 'react';
import type { BgCustomerFormState } from '../types';

const STORAGE_KEY_PREFIX = 'bg_form_';

const defaultState: BgCustomerFormState = {
  current_step: 1,
  is_express: false,
  express_fee: 0,
  desired_ship_date: null,
  sticker_selections: [],
  cash_receipt_yn: false,
  receipt_type: null,
  receipt_number: '',
};

/**
 * sessionStorage 기반 폼 상태 저장/복원 훅
 * 페이지 이탈 후 재진입 시 이전 입력값을 복원합니다.
 */
export function useFormPersistence(orderId: string) {
  const storageKey = `${STORAGE_KEY_PREFIX}${orderId}`;

  const [state, setState] = useState<BgCustomerFormState>(() => {
    try {
      const raw = sessionStorage.getItem(storageKey);
      if (raw) {
        return { ...defaultState, ...JSON.parse(raw) };
      }
    } catch {
      // ignore
    }
    return defaultState;
  });

  // 상태 변경 시 자동 저장
  useEffect(() => {
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(state));
    } catch {
      // storage full or not available
    }
  }, [state, storageKey]);

  const updateState = useCallback(
    (updates: Partial<BgCustomerFormState>) => {
      setState((prev) => ({ ...prev, ...updates }));
    },
    []
  );

  const clearState = useCallback(() => {
    try {
      sessionStorage.removeItem(storageKey);
    } catch {
      // ignore
    }
    setState(defaultState);
  }, [storageKey]);

  return { state, updateState, clearState };
}
