/**
 * 카페24 주문 옵션 → customer_info.sticker_selections enrichment.
 *
 * 카페24 옵션 구조 (네이버의 " / " + ":" 형식과 다름):
 *   - item.option_value      = "스티커 옵션=클로버 옐로우" (옵션명=값, 다중은 콤마/슬래시)
 *   - item.additional_option_values = [{ name: "스티커 문구를 입력해주세요...", value: "동해물과..." }]
 *
 * 매핑:
 *   "스티커"류 옵션값  → 스티커 타입 → bg_stickers 매칭 → sticker_id/code, sticker_name(원문 타입 보존)
 *   "박스"류 옵션값    → bg_product_settings.available_box_options 매칭 → box_code/name
 *   스티커 문구        → custom_values.text
 *
 * 네이버 matchSticker/matchBox 재사용 (동일 bg_stickers/bg_product_settings 기준).
 */
'use strict';

const { matchSticker, matchBox } = require('../naver/option-parser');

/** "옵션명=값" 페어(콤마 구분) → 평면 객체.
 *   ※ 값/옵션명에 '/' 가 등장("(화이트/블루)")하므로 콤마로만 분리 (슬래시 분리 금지).
 *   ※ 옵션명은 첫 '=' 기준으로만 split (값에 '=' 없다고 가정). */
function parseCafe24OptionValue(optionValue) {
  const out = {};
  if (!optionValue || typeof optionValue !== 'string') return out;
  const parts = optionValue.split(/\s*,\s*/);
  for (const p of parts) {
    const idx = p.indexOf('=');
    if (idx < 0) continue;
    const k = p.slice(0, idx).trim().replace(/\s+/g, ' ');
    const v = p.slice(idx + 1).trim();
    if (k && v) out[k] = v;
  }
  return out;
}

/**
 * 한 카페24 orderItem → sticker_selection 1개.
 *   optionValue: item.option_value ("스티커 옵션=클로버 옐로우")
 *   message:     스티커 입력 문구 (additional_option_values 에서 파싱한 값)
 */
function enrichCafe24Item({
  productCode,
  productName,
  quantity,
  optionValue,
  message,
  stickers = [],
  productSettings = [],
}) {
  const parsed = parseCafe24OptionValue(optionValue);

  // 스티커 타입 — 키에 '스티커' 포함(문구 제외), 없으면 옵션값 원문 전체 시도
  let stickerType = null;
  for (const [k, v] of Object.entries(parsed)) {
    if (k.includes('스티커') && !k.includes('문구')) { stickerType = v; break; }
  }
  // 박스 타입 — 키에 '박스' 포함
  let boxType = null;
  for (const [k, v] of Object.entries(parsed)) {
    if (k.includes('박스') && v) { boxType = v; break; }
  }

  const sticker = matchSticker(stickers, productCode, stickerType);
  const box = matchBox(productSettings, productCode, boxType);
  const msg = (message == null ? '' : String(message)).trim();

  return {
    product_code: productCode || null,
    product_name: productName || null,
    quantity: Number(quantity) || 0,
    sticker_id: sticker ? sticker.id : null,
    sticker_code: sticker ? sticker.sticker_code : null,
    // 카페24: 스티커 타입 원문 보존 (매칭명 우선, 없으면 옵션 원문) — 운영자 확인용.
    sticker_name: (sticker && sticker.name) || stickerType || null,
    custom_values: msg ? { text: msg } : {},
    box_code: box ? box.code : null,
    box_name: box ? box.name : null,
  };
}

module.exports = {
  parseCafe24OptionValue,
  enrichCafe24Item,
};
