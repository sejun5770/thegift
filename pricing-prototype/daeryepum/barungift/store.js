/**
 * 바른기프트 JSON 파일 저장소
 * data/bg_stickers.json, data/bg_product_settings.json, data/bg_order_customer_info.json
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');

// 파일 경로
const FILES = {
  stickers: path.join(DATA_DIR, 'bg_stickers.json'),
  productSettings: path.join(DATA_DIR, 'bg_product_settings.json'),
  customerInfo: path.join(DATA_DIR, 'bg_order_customer_info.json'),
};

// 초기 데이터
const DEFAULTS = {
  stickers: [],
  productSettings: [],
  customerInfo: [],
};

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(filePath, defaultVal) {
  try {
    if (!fs.existsSync(filePath)) return defaultVal;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return defaultVal;
  }
}

function writeJson(filePath, data) {
  ensureDataDir();
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

function uuid() {
  return crypto.randomUUID();
}

function now() {
  return new Date().toISOString();
}

// ============================================
// 스티커 CRUD
// ============================================

function getAllStickers(activeOnly = false) {
  const stickers = readJson(FILES.stickers, DEFAULTS.stickers);
  return activeOnly ? stickers.filter(s => s.is_active) : stickers;
}

function getStickerById(id) {
  return getAllStickers().find(s => s.id === id) || null;
}

function createSticker(data) {
  const stickers = getAllStickers();
  const sticker = {
    id: uuid(),
    name: data.name || '',
    preview_image_url: data.preview_image_url || null,
    preview_color: data.preview_color || '#FFFFFF',
    custom_fields: data.custom_fields || [],
    is_active: data.is_active !== false,
    created_at: now(),
    updated_at: now(),
  };
  stickers.push(sticker);
  writeJson(FILES.stickers, stickers);
  return sticker;
}

function updateSticker(id, data) {
  const stickers = getAllStickers();
  const idx = stickers.findIndex(s => s.id === id);
  if (idx === -1) return null;
  stickers[idx] = { ...stickers[idx], ...data, updated_at: now() };
  writeJson(FILES.stickers, stickers);
  return stickers[idx];
}

function deleteSticker(id) {
  return updateSticker(id, { is_active: false });
}

// ============================================
// 상품 설정 CRUD
// ============================================

function getAllProductSettings() {
  return readJson(FILES.productSettings, DEFAULTS.productSettings);
}

function getProductSettings(productId) {
  return getAllProductSettings().find(s => s.product_id === productId) || null;
}

function upsertProductSettings(productId, data) {
  const settings = getAllProductSettings();
  const idx = settings.findIndex(s => s.product_id === productId);
  if (idx >= 0) {
    settings[idx] = { ...settings[idx], ...data, product_id: productId, updated_at: now() };
    writeJson(FILES.productSettings, settings);
    return settings[idx];
  }
  const newSetting = {
    id: uuid(),
    product_id: productId,
    // 출고방식: 'today_shipping' (오늘출발) | 'desired_date' (희망출고)
    shipping_type: data.shipping_type ?? 'desired_date',
    // 기본설정
    cutoff_enabled: data.cutoff_enabled ?? false,
    cutoff_hour: data.cutoff_hour ?? 14,
    cutoff_minute: data.cutoff_minute ?? 0,
    lead_time_days: data.lead_time_days ?? 2,
    min_select_days: data.min_select_days ?? 3,
    max_select_days: data.max_select_days ?? 60,
    // 휴무일 설정
    closed_weekdays: data.closed_weekdays ?? [0, 6], // 0=일, 6=토
    closed_dates: data.closed_dates ?? [], // [{date:'YYYY-MM-DD', reason:'사유'}]
    // 고객 노출 설정
    date_required: data.date_required ?? true,
    notice_enabled: data.notice_enabled ?? false,
    notice_text: data.notice_text ?? '',
    // 스티커 연결 (기존)
    available_sticker_ids: data.available_sticker_ids ?? [],
    // 레거시 호환
    express_available: data.express_available ?? (data.shipping_type === 'today_shipping'),
    express_fee: data.express_fee ?? 0,
    express_cutoff_time: data.express_cutoff_time ?? `${String(data.cutoff_hour ?? 14).padStart(2,'0')}:${String(data.cutoff_minute ?? 0).padStart(2,'0')}`,
    blackout_dates: data.blackout_dates ?? (data.closed_dates || []).map(d => d.date),
    created_at: now(),
    updated_at: now(),
  };
  settings.push(newSetting);
  writeJson(FILES.productSettings, settings);
  return newSetting;
}

// ============================================
// 고객 입력 정보
// ============================================

function getCustomerInfo(orderId) {
  const infos = readJson(FILES.customerInfo, DEFAULTS.customerInfo);
  return infos.find(i => i.order_id === orderId) || null;
}

function saveCustomerInfo(orderId, data) {
  const infos = readJson(FILES.customerInfo, DEFAULTS.customerInfo);
  // 중복 체크
  if (infos.find(i => i.order_id === orderId)) {
    throw new Error('ALREADY_SUBMITTED');
  }
  const info = {
    id: uuid(),
    order_id: orderId,
    is_express: data.is_express || false,
    express_fee: data.express_fee || 0,
    desired_ship_date: data.desired_ship_date,
    sticker_selections: data.sticker_selections || [],
    cash_receipt_yn: data.cash_receipt_yn || false,
    receipt_type: data.receipt_type || null,
    receipt_number: data.receipt_number || null,
    submitted_at: now(),
    created_at: now(),
  };
  infos.push(info);
  writeJson(FILES.customerInfo, infos);
  return info;
}

function getAllCustomerInfos() {
  return readJson(FILES.customerInfo, DEFAULTS.customerInfo);
}

module.exports = {
  getAllStickers,
  getStickerById,
  createSticker,
  updateSticker,
  deleteSticker,
  getAllProductSettings,
  getProductSettings,
  upsertProductSettings,
  getCustomerInfo,
  saveCustomerInfo,
  getAllCustomerInfos,
};
