import type { OrderItem } from '@/types/order';

export interface ValidationFailure {
  rule: string;
  field: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface ValidationResult {
  isValid: boolean;
  failures: ValidationFailure[];
}

/**
 * 주문 상품 자동 검증 규칙
 * 주문 수집 시 또는 상태 변경 시 실행
 */
export function validateOrderItems(items: OrderItem[]): ValidationResult {
  const failures: ValidationFailure[] = [];

  for (const item of items) {
    // Rule 1: 스티커 타입이 2개 이상일 때 수량 합계 검증
    const stickerTypeCount = [
      item.sticker_type1_name,
      item.sticker_type2_name,
      item.sticker_type3_name,
    ].filter((name) => name && name !== '선택안함').length;

    if (stickerTypeCount >= 2) {
      const totalStickerQty =
        (item.sticker_type1_quantity || 0) +
        (item.sticker_type2_quantity || 0) +
        (item.sticker_type3_quantity || 0);

      if (totalStickerQty !== item.quantity) {
        failures.push({
          rule: 'sticker_quantity_mismatch',
          field: `item_${item.id}`,
          message: `상품 "${item.product_name}"의 스티커 수량 합계(${totalStickerQty})가 주문수량(${item.quantity})과 일치하지 않습니다.`,
          severity: 'error',
        });
      }
    }

    // Rule 2: 스티커 타입이 '선택안함'인 경우
    if (
      item.sticker_type1_name === '선택안함' ||
      (!item.sticker_type1_name && !item.sticker_type1_id)
    ) {
      // 스티커 선택안함은 추가 검증 필요 → 검증실패
      failures.push({
        rule: 'sticker_not_selected',
        field: `item_${item.id}`,
        message: `상품 "${item.product_name}"의 스티커타입이 선택되지 않았습니다.`,
        severity: 'error',
      });
    }

    // Rule 3: 스티커는 선택안함이나 입력메시지가 존재하는 경우
    if (
      (item.sticker_type1_name === '선택안함' ||
        (!item.sticker_type1_name && !item.sticker_type1_id)) &&
      item.input_message
    ) {
      failures.push({
        rule: 'sticker_none_with_message',
        field: `item_${item.id}`,
        message: `상품 "${item.product_name}"의 스티커가 선택안함이지만 입력메시지가 존재합니다.`,
        severity: 'error',
      });
    }

    // Rule 4: 상품코드 매핑 확인 (product_id가 null인 경우)
    if (!item.product_id && item.product_code) {
      failures.push({
        rule: 'product_not_mapped',
        field: `item_${item.id}`,
        message: `상품 "${item.product_name}" (${item.product_code})이 상품관리에 등록되지 않았습니다.`,
        severity: 'error',
      });
    }
  }

  return {
    isValid: failures.filter((f) => f.severity === 'error').length === 0,
    failures,
  };
}

/**
 * 주문 수집 시 복수상품 판별
 * 복수상품 조건:
 * - 본사상품 A + 본사상품 B → 복수
 * - 같은 상품이라도 스티커타입이 다르면 → 복수
 * - 같은 상품, 같은 스티커타입이지만 입력 문구가 다르면 → 복수
 * - 같은 상품, 같은 스티커타입, 같은 입력 문구 → 복수 아님
 * - 위탁상품 + 본사상품 1종 → 복수 아님
 */
export function isMultiProduct(items: OrderItem[]): boolean {
  // 스티커 상품 제외 (product_name에 '스티커' 또는 'sticker' 포함)
  const nonStickerItems = items.filter(
    (item) =>
      !item.product_name?.toLowerCase().includes('스티커') &&
      !item.product_name?.toLowerCase().includes('sticker')
  );

  if (nonStickerItems.length <= 1) return false;

  // 상품별 고유 조합 생성 (상품코드 + 스티커타입 + 입력문구)
  const uniqueCombinations = new Set(
    nonStickerItems.map((item) => {
      const key = [
        item.product_code || item.product_name,
        item.sticker_type1_name || '',
        item.sticker_type2_name || '',
        item.sticker_type3_name || '',
        item.input_message || '',
      ].join('|');
      return key;
    })
  );

  return uniqueCombinations.size > 1;
}

/**
 * 점검필요 판별
 * 스티커를 제외한 상품 주문 금액이 0원인 경우
 */
export function isCheckRequired(items: OrderItem[]): boolean {
  const nonStickerItems = items.filter(
    (item) =>
      !item.product_name?.toLowerCase().includes('스티커') &&
      !item.product_name?.toLowerCase().includes('sticker')
  );

  return nonStickerItems.some((item) => (item.item_price || 0) === 0);
}
