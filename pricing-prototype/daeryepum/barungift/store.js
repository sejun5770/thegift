/**
 * 바른기프트 저장소 (Supabase REST API + JSON 파일 폴백)
 *
 * 환경변수 SUPABASE_URL + SUPABASE_ANON_KEY 가 설정되면
 * Supabase PostgreSQL에 영구 저장 → 배포 시에도 데이터 유지
 *
 * 미설정 시 로컬 JSON 파일 폴백 (개발용, 배포 시 초기화됨)
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ============================================
// 설정
// ============================================

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || '';
const USE_SUPABASE = !!(SUPABASE_URL && SUPABASE_KEY);

if (USE_SUPABASE) {
  console.log('[store] Supabase 영구 저장소 사용 ✓');
} else {
  console.warn('[store] SUPABASE_URL/SUPABASE_ANON_KEY 미설정 → 로컬 JSON 파일 사용 (배포 시 초기화됨)');
}

// ============================================
// Supabase REST API 헬퍼
// ============================================

const REST_BASE = `${SUPABASE_URL}/rest/v1`;
const HEADERS = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
  Prefer: 'return=representation',
};

async function sbGet(table, params = '') {
  const url = `${REST_BASE}/${table}?select=*${params ? '&' + params : ''}`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase GET ${table} [${res.status}]: ${text}`);
  }
  return res.json();
}

async function sbInsert(table, data) {
  const res = await fetch(`${REST_BASE}/${table}`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase INSERT ${table} [${res.status}]: ${text}`);
  }
  const rows = await res.json();
  return rows[0];
}

async function sbUpdate(table, filter, data) {
  const res = await fetch(`${REST_BASE}/${table}?${filter}`, {
    method: 'PATCH',
    headers: HEADERS,
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase UPDATE ${table} [${res.status}]: ${text}`);
  }
  const rows = await res.json();
  return rows[0] || null;
}

// ============================================
// JSON 파일 폴백 (개발용)
// ============================================

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILES = {
  stickers: path.join(DATA_DIR, 'bg_stickers.json'),
  productSettings: path.join(DATA_DIR, 'bg_product_settings.json'),
  customerInfo: path.join(DATA_DIR, 'bg_order_customer_info.json'),
};

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(filePath, defaultVal) {
  try {
    if (!fs.existsSync(filePath)) return defaultVal;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch { return defaultVal; }
}

function writeJson(filePath, data) {
  ensureDataDir();
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

function uuid() { return crypto.randomUUID(); }
function now() { return new Date().toISOString(); }

// ============================================
// 스티커 CRUD
// ============================================

async function getAllStickers(activeOnly = false) {
  if (USE_SUPABASE) {
    const params = activeOnly ? 'is_active=eq.true' : '';
    return sbGet('bg_stickers', params);
  }
  const stickers = readJson(FILES.stickers, []);
  return activeOnly ? stickers.filter(s => s.is_active) : stickers;
}

async function getStickerById(id) {
  if (USE_SUPABASE) {
    const rows = await sbGet('bg_stickers', `id=eq.${id}`);
    return rows[0] || null;
  }
  return (readJson(FILES.stickers, [])).find(s => s.id === id) || null;
}

async function createSticker(data) {
  if (USE_SUPABASE) {
    return sbInsert('bg_stickers', {
      name: data.name || '',
      preview_image_url: data.preview_image_url || null,
      preview_color: data.preview_color || '#FFFFFF',
      custom_fields: data.custom_fields || [],
      is_active: data.is_active !== false,
    });
  }
  const stickers = readJson(FILES.stickers, []);
  const sticker = {
    id: uuid(), name: data.name || '',
    preview_image_url: data.preview_image_url || null,
    preview_color: data.preview_color || '#FFFFFF',
    custom_fields: data.custom_fields || [],
    is_active: data.is_active !== false,
    created_at: now(), updated_at: now(),
  };
  stickers.push(sticker);
  writeJson(FILES.stickers, stickers);
  return sticker;
}

async function updateSticker(id, data) {
  if (USE_SUPABASE) {
    const { id: _id, created_at, ...updateData } = data;
    return sbUpdate('bg_stickers', `id=eq.${id}`, {
      ...updateData,
      updated_at: now(),
    });
  }
  const stickers = readJson(FILES.stickers, []);
  const idx = stickers.findIndex(s => s.id === id);
  if (idx === -1) return null;
  stickers[idx] = { ...stickers[idx], ...data, updated_at: now() };
  writeJson(FILES.stickers, stickers);
  return stickers[idx];
}

async function deleteSticker(id) {
  return updateSticker(id, { is_active: false });
}

// ============================================
// 상품 설정 CRUD
// ============================================

async function getAllProductSettings() {
  if (USE_SUPABASE) return sbGet('bg_product_settings');
  return readJson(FILES.productSettings, []);
}

async function getProductSettings(productId) {
  if (USE_SUPABASE) {
    const rows = await sbGet('bg_product_settings', `product_id=eq.${encodeURIComponent(productId)}`);
    return rows[0] || null;
  }
  return (readJson(FILES.productSettings, [])).find(s => s.product_id === productId) || null;
}

async function upsertProductSettings(productId, data) {
  const existing = await getProductSettings(productId);

  if (existing) {
    if (USE_SUPABASE) {
      const { id: _id, created_at, ...updateData } = data;
      return sbUpdate('bg_product_settings', `product_id=eq.${encodeURIComponent(productId)}`, {
        ...updateData,
        product_id: productId,
        updated_at: now(),
      });
    }
    const settings = readJson(FILES.productSettings, []);
    const idx = settings.findIndex(s => s.product_id === productId);
    settings[idx] = { ...settings[idx], ...data, product_id: productId, updated_at: now() };
    writeJson(FILES.productSettings, settings);
    return settings[idx];
  }

  // 신규 생성
  const newSetting = {
    product_id: productId,
    shipping_type: data.shipping_type ?? 'desired_date',
    cutoff_enabled: data.cutoff_enabled ?? false,
    cutoff_hour: data.cutoff_hour ?? 14,
    cutoff_minute: data.cutoff_minute ?? 0,
    lead_time_days: data.lead_time_days ?? 2,
    min_select_days: data.min_select_days ?? 3,
    max_select_days: data.max_select_days ?? 60,
    closed_weekdays: data.closed_weekdays ?? [0, 6],
    closed_dates: data.closed_dates ?? [],
    date_required: data.date_required ?? true,
    notice_enabled: data.notice_enabled ?? false,
    notice_text: data.notice_text ?? '',
    available_sticker_ids: data.available_sticker_ids ?? [],
    express_available: data.express_available ?? (data.shipping_type === 'today_shipping'),
    express_fee: data.express_fee ?? 0,
    express_cutoff_time: data.express_cutoff_time ?? `${String(data.cutoff_hour ?? 14).padStart(2,'0')}:${String(data.cutoff_minute ?? 0).padStart(2,'0')}`,
    blackout_dates: data.blackout_dates ?? (data.closed_dates || []).map(d => d.date),
  };

  if (USE_SUPABASE) return sbInsert('bg_product_settings', newSetting);

  const settings = readJson(FILES.productSettings, []);
  const local = { id: uuid(), ...newSetting, created_at: now(), updated_at: now() };
  settings.push(local);
  writeJson(FILES.productSettings, settings);
  return local;
}

// ============================================
// 고객 입력 정보
// ============================================

async function getCustomerInfo(orderId) {
  if (USE_SUPABASE) {
    const rows = await sbGet('bg_order_customer_info', `order_id=eq.${encodeURIComponent(orderId)}`);
    return rows[0] || null;
  }
  return (readJson(FILES.customerInfo, [])).find(i => i.order_id === orderId) || null;
}

/**
 * 여러 주문의 고객 입력 정보를 한번에 조회 (N+1 방지)
 */
async function getCustomerInfoBatch(orderIds) {
  if (!orderIds.length) return [];
  if (USE_SUPABASE) {
    const filter = `order_id=in.(${orderIds.map(id => encodeURIComponent(id)).join(',')})`;
    return sbGet('bg_order_customer_info', filter);
  }
  const infos = readJson(FILES.customerInfo, []);
  const idSet = new Set(orderIds);
  return infos.filter(i => idSet.has(i.order_id));
}

async function saveCustomerInfo(orderId, data) {
  // 중복 체크
  const existing = await getCustomerInfo(orderId);
  if (existing) throw new Error('ALREADY_SUBMITTED');

  const info = {
    order_id: orderId,
    is_express: data.is_express || false,
    express_fee: data.express_fee || 0,
    desired_ship_date: data.desired_ship_date,
    sticker_selections: data.sticker_selections || [],
    cash_receipt_yn: data.cash_receipt_yn || false,
    receipt_type: data.receipt_type || null,
    receipt_number: data.receipt_number || null,
    submitted_at: now(),
  };

  if (USE_SUPABASE) return sbInsert('bg_order_customer_info', info);

  const infos = readJson(FILES.customerInfo, []);
  const local = { id: uuid(), ...info, created_at: now() };
  infos.push(local);
  writeJson(FILES.customerInfo, infos);
  return local;
}

async function getAllCustomerInfos() {
  if (USE_SUPABASE) return sbGet('bg_order_customer_info');
  return readJson(FILES.customerInfo, []);
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
  getCustomerInfoBatch,
  saveCustomerInfo,
  getAllCustomerInfos,
};
