/**
 * 쿠팡 주문 enrichment — customer_info.sticker_selections + desired_ship_date 자동 산정.
 *
 * 운영 규칙 (운영팀 spec):
 *   - 상품코드     = 판매자상품코드 (sellerProductId) → 이미 normalizeOrderSheet 에서 처리
 *   - 박스/스티커  = 셀러센터의 '모델번호' 필드 → API 응답의 externalVendorSku
 *                   (코드값으로 sticker_code 또는 box_code 매칭)
 *   - 희망 출고일  = 주문일시(KST) 기준
 *                   11:00 이전 → 당일자
 *                   11:00 이후 → 익 영업일자 (토/일 스킵)
 */
'use strict';

const { kstYmd, addBusinessDays } = require('../naver/option-parser');

/**
 * 모델번호 (externalVendorSku 등) 를 스티커 코드 또는 박스 코드로 매칭.
 *   우선순위: bg_stickers 의 sticker_code → bg_product_settings 의 available_box_options.code
 *   product_code 가 일치해야 매칭 인정 (다른 상품 코드 무관 매칭 방지).
 *
 *   반환: { sticker, box } — 매칭된 항목 (없으면 null)
 */
function matchModelNo(stickers, productSettings, productCode, modelNo) {
  const result = { sticker: null, box: null };
  if (!modelNo) return result;
  const code = String(modelNo).trim();
  if (!code) return result;

  // 스티커 매칭 — sticker_code 정확일치 + product_codes 포함 검사
  if (Array.isArray(stickers)) {
    result.sticker = stickers.find(s =>
      s && s.is_active !== false &&
      s.sticker_code === code &&
      (!productCode || !Array.isArray(s.product_codes) || s.product_codes.includes(productCode))
    ) || null;
  }
  if (result.sticker) return result;

  // 박스 매칭 — product_settings 에서 해당 상품의 box_options.code 일치
  if (Array.isArray(productSettings) && productCode) {
    const setting = productSettings.find(s => s && s.product_id === productCode);
    if (setting && Array.isArray(setting.available_box_options)) {
      result.box = setting.available_box_options.find(b => b && b.code === code) || null;
    }
  }
  return result;
}

/**
 * 한 쿠팡 orderItem → sticker_selection 1개.
 *   modelNo 필드는 externalVendorSku 우선, 부재시 vendorItemPackageId 등 폴백.
 */
function enrichOrderItem({
  productCode,
  productName,
  quantity,
  modelNo,
  stickers = [],
  productSettings = [],
}) {
  const { sticker, box } = matchModelNo(stickers, productSettings, productCode, modelNo);
  return {
    product_code: productCode || null,
    product_name: productName || null,
    quantity: Number(quantity) || 0,
    sticker_id: sticker ? sticker.id : null,
    sticker_code: sticker ? sticker.sticker_code : null,
    // sticker_name: 네이버와 일관 — 미표시 정책
    sticker_name: null,
    custom_values: {},
    box_code: box ? box.code : null,
    box_name: box ? box.name : null,
  };
}

/**
 * 쿠팡 출고일 산정:
 *   ordered_at(KST) hour < 11 → 당일자
 *   hour >= 11           → 익 영업일자 (토/일 스킵, 공휴일 미반영)
 *
 *   반환: 'YYYY-MM-DD' (KST) 또는 null.
 */
function calcCoupangShipDate(orderedAt) {
  if (!orderedAt) return null;
  const d = new Date(orderedAt);
  if (isNaN(d.getTime())) return null;
  const kst = new Date(d.getTime() + 9 * 3600 * 1000);
  const hour = kst.getUTCHours();
  const ymd = kstYmd(orderedAt);
  if (!ymd) return null;
  return hour < 11 ? ymd : addBusinessDays(ymd, 1);
}

module.exports = {
  matchModelNo,
  enrichOrderItem,
  calcCoupangShipDate,
};
