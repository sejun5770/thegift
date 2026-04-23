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

async function sbDelete(table, filter) {
  const res = await fetch(`${REST_BASE}/${table}?${filter}`, {
    method: 'DELETE',
    headers: HEADERS,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase DELETE ${table} [${res.status}]: ${text}`);
  }
}

// ============================================
// JSON 파일 폴백 (개발용)
// ============================================

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILES = {
  stickers: path.join(DATA_DIR, 'bg_stickers.json'),
  productSettings: path.join(DATA_DIR, 'bg_product_settings.json'),
  customerInfo: path.join(DATA_DIR, 'bg_order_customer_info.json'),
  shippingConfig: path.join(DATA_DIR, 'bg_shipping_config.json'),
  alimtalkLog: path.join(DATA_DIR, 'bg_alimtalk_log.json'),
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
    available_box_options: data.available_box_options ?? [],
    shipping_group_id: data.shipping_group_id ?? null,
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

async function deleteProductSettings(productId) {
  if (USE_SUPABASE) {
    await sbDelete('bg_product_settings', `product_id=eq.${encodeURIComponent(productId)}`);
    return;
  }
  let settings = readJson(FILES.productSettings, []);
  settings = settings.filter(s => s.product_id !== productId);
  writeJson(FILES.productSettings, settings);
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
    customer_request: data.customer_request || null,
    submitted_at: now(),
  };

  if (USE_SUPABASE) {
    // migration 미적용 환경 대응: 스키마에 없는 컬럼 오류(PGRST204) 발생 시
    // 해당 컬럼을 제거하고 재시도. 데이터 일부 손실되지만 제출 자체는 성공
    try {
      return await sbInsert('bg_order_customer_info', info);
    } catch (err) {
      const m = err.message && err.message.match(/Could not find the '(\w+)' column/);
      if (m) {
        console.warn(`[saveCustomerInfo] 스키마에 '${m[1]}' 컬럼 없음 - 해당 필드 제거 후 재시도. migration 적용 필요.`);
        const { [m[1]]: _, ...retry } = info;
        return sbInsert('bg_order_customer_info', retry);
      }
      throw err;
    }
  }

  const infos = readJson(FILES.customerInfo, []);
  const local = { id: uuid(), ...info, created_at: now() };
  infos.push(local);
  writeJson(FILES.customerInfo, infos);
  return local;
}

async function getAllCustomerInfos() {
  if (USE_SUPABASE) return sbGet('bg_order_customer_info', 'order=submitted_at.desc');
  const infos = readJson(FILES.customerInfo, []);
  return [...infos].sort((a, b) => (b.submitted_at || '').localeCompare(a.submitted_at || ''));
}

/**
 * 관리자 upsert. 기존 레코드 있으면 PATCH, 없으면 INSERT (고객이 아직 입력 안 한
 * 주문에 관리자가 수동 입력할 때 사용). 고객이 직접 제출하는 POST 경로와 달리
 * ALREADY_SUBMITTED 체크 없이 덮어쓰기.
 */
async function updateCustomerInfo(orderId, data) {
  const allowed = ['desired_ship_date', 'is_express', 'express_fee', 'sticker_selections', 'cash_receipt_yn', 'receipt_type', 'receipt_number', 'customer_request'];
  const patch = {};
  for (const k of allowed) { if (k in data) patch[k] = data[k]; }
  patch.updated_at = now();

  const existing = await getCustomerInfo(orderId);

  if (USE_SUPABASE) {
    if (existing) {
      return sbUpdate('bg_order_customer_info', `order_id=eq.${encodeURIComponent(orderId)}`, patch);
    }
    // INSERT 경로: 필수 필드 기본값 채움
    const insert = {
      order_id: orderId,
      is_express: data.is_express || false,
      express_fee: data.express_fee || 0,
      desired_ship_date: data.desired_ship_date || null,
      sticker_selections: data.sticker_selections || [],
      cash_receipt_yn: data.cash_receipt_yn || false,
      receipt_type: data.receipt_type || null,
      receipt_number: data.receipt_number || null,
      customer_request: data.customer_request || null,
      submitted_at: now(),
    };
    // migration 미적용 대응
    try {
      return await sbInsert('bg_order_customer_info', insert);
    } catch (err) {
      const m = err.message && err.message.match(/Could not find the '(\w+)' column/);
      if (m) {
        console.warn(`[updateCustomerInfo] 스키마에 '${m[1]}' 컬럼 없음 - 제거 후 재시도`);
        const { [m[1]]: _, ...retry } = insert;
        return sbInsert('bg_order_customer_info', retry);
      }
      throw err;
    }
  }

  // 로컬 JSON fallback
  const infos = readJson(FILES.customerInfo, []);
  const idx = infos.findIndex(i => i.order_id === orderId);
  if (idx === -1) {
    const insert = {
      order_id: orderId,
      is_express: data.is_express || false,
      express_fee: data.express_fee || 0,
      desired_ship_date: data.desired_ship_date || null,
      sticker_selections: data.sticker_selections || [],
      cash_receipt_yn: data.cash_receipt_yn || false,
      receipt_type: data.receipt_type || null,
      receipt_number: data.receipt_number || null,
      customer_request: data.customer_request || null,
      submitted_at: now(),
      updated_at: patch.updated_at,
    };
    infos.push(insert);
    writeJson(FILES.customerInfo, infos);
    return insert;
  }
  infos[idx] = { ...infos[idx], ...patch };
  writeJson(FILES.customerInfo, infos);
  return infos[idx];
}

/** 고객 입력 초기화 (삭제) — 잘못 제출한 고객이 재입력 할 수 있게 */
async function deleteCustomerInfo(orderId) {
  if (USE_SUPABASE) {
    await sbDelete('bg_order_customer_info', `order_id=eq.${encodeURIComponent(orderId)}`);
    return;
  }
  let infos = readJson(FILES.customerInfo, []);
  const before = infos.length;
  infos = infos.filter(i => i.order_id !== orderId);
  if (infos.length === before) throw new Error('NOT_FOUND');
  writeJson(FILES.customerInfo, infos);
}

// ============================================
// 후공정 처리 상태 (processed_at / processed_by)
// 관리자가 스프레드시트에 복사해 후공정 진행했음을 추적.
// ============================================

/**
 * 특정 주문의 처리 상태 토글.
 * @param {string} orderId
 * @param {{processed: boolean, processed_by?: string}} data
 *   processed=true  → processed_at = now(), processed_by 세팅
 *   processed=false → processed_at = NULL, processed_by = NULL (되돌리기)
 */
async function setProcessed(orderId, data) {
  const wantProcessed = !!data.processed;
  const patch = wantProcessed
    ? { processed_at: now(), processed_by: data.processed_by || null }
    : { processed_at: null, processed_by: null };

  if (USE_SUPABASE) {
    const existing = await sbGet('bg_order_customer_info', `order_id=eq.${encodeURIComponent(orderId)}`);
    if (!existing || !existing.length) throw new Error('NOT_FOUND');
    try {
      return await sbUpdate('bg_order_customer_info', `order_id=eq.${encodeURIComponent(orderId)}`, patch);
    } catch (err) {
      const m = err.message && err.message.match(/Could not find the '(\w+)' column/);
      if (m) {
        console.warn(`[setProcessed] 스키마에 '${m[1]}' 컬럼 없음 — migration 011 적용 필요`);
        throw new Error('PROCESSED_COLUMN_MISSING');
      }
      throw err;
    }
  }
  const infos = readJson(FILES.customerInfo, []);
  const idx = infos.findIndex(i => i.order_id === orderId);
  if (idx === -1) throw new Error('NOT_FOUND');
  infos[idx] = { ...infos[idx], ...patch };
  writeJson(FILES.customerInfo, infos);
  return infos[idx];
}

/**
 * 여러 주문 일괄 처리 마킹 (수집복사 버튼 연동용).
 * @param {string[]} orderIds
 * @param {{processed: boolean, processed_by?: string}} data
 * @returns {{ok: number, fail: number, errors: Array<{order_id, error}>}}
 */
async function setProcessedBatch(orderIds, data) {
  const unique = [...new Set(orderIds.filter(Boolean))];
  let ok = 0, fail = 0;
  const errors = [];
  for (const oid of unique) {
    try { await setProcessed(oid, data); ok++; }
    catch (e) { fail++; errors.push({ order_id: oid, error: e.message }); }
  }
  return { ok, fail, errors };
}

// ============================================
// 공통 출고일 설정 (shipping config)
// ============================================

const DEFAULT_SHIPPING_CONFIG = {
  shipping_type: 'desired_date',
  cutoff_enabled: false,
  cutoff_hour: 14,
  cutoff_minute: 0,
  lead_time_days: 2,
  min_select_days: 3,
  max_select_days: 60,
  express_fee: 0,
  closed_weekdays: [0, 6],
  closed_dates: [],
  date_required: true,
  notice_enabled: false,
  notice_text: '',
};

// 단일 row 식별 ID — '기본 그룹' 의 고정 UUID (레거시 호환)
const SHIPPING_CONFIG_ID = '00000000-0000-0000-0000-000000000001';

/** 전체 그룹 목록 조회 (is_default=true 가 최상단) */
async function getShippingGroups() {
  if (USE_SUPABASE) {
    try {
      const rows = await sbGet('bg_shipping_config', 'order=is_default.desc,created_at.asc');
      if (Array.isArray(rows)) {
        return rows.map(r => ({ ...DEFAULT_SHIPPING_CONFIG, ...r }));
      }
    } catch (e) {
      console.warn('[store] bg_shipping_config list 실패:', e.message);
    }
  }
  // JSON 폴백 — 단일 row 를 기본 그룹으로 취급
  const single = readJson(FILES.shippingConfig, DEFAULT_SHIPPING_CONFIG);
  return [{
    id: SHIPPING_CONFIG_ID, name: '기본 그룹', is_default: true, ...single,
  }];
}

/** 특정 그룹 조회 (id 또는 '기본'). 없으면 기본 그룹 fallback. */
async function getShippingConfig(idOrNull) {
  const wantId = idOrNull || null;
  if (USE_SUPABASE) {
    try {
      // 명시 id 조회 → 실패시 default 조회
      if (wantId) {
        const rows = await sbGet('bg_shipping_config', `id=eq.${encodeURIComponent(wantId)}`);
        if (rows && rows[0]) return { ...DEFAULT_SHIPPING_CONFIG, ...rows[0] };
      }
      const defRows = await sbGet('bg_shipping_config', 'is_default=eq.true&limit=1');
      if (defRows && defRows[0]) return { ...DEFAULT_SHIPPING_CONFIG, ...defRows[0] };
      // 폴백: 레거시 고정 ID
      const legacy = await sbGet('bg_shipping_config', `id=eq.${SHIPPING_CONFIG_ID}`);
      if (legacy && legacy[0]) return { ...DEFAULT_SHIPPING_CONFIG, ...legacy[0] };
      return DEFAULT_SHIPPING_CONFIG;
    } catch (e) {
      console.warn('[store] bg_shipping_config fetch 실패, JSON 폴백:', e.message);
    }
  }
  return readJson(FILES.shippingConfig, DEFAULT_SHIPPING_CONFIG);
}

/**
 * 그룹 저장 (업데이트 전용 — 기본 그룹 또는 특정 그룹).
 * id 가 없으면 default 그룹을 업데이트. 기존 호환 경로.
 */
async function saveShippingConfig(data, idOrNull) {
  const targetId = idOrNull || null;
  const current = await getShippingConfig(targetId);
  const merged = { ...current, ...data, updated_at: now() };

  if (USE_SUPABASE) {
    try {
      const filter = targetId
        ? `id=eq.${encodeURIComponent(targetId)}`
        : 'is_default=eq.true';
      const existing = await sbGet('bg_shipping_config', filter);
      if (existing && existing.length) {
        const { id: _id, created_at, ...updateData } = merged;
        return await sbUpdate('bg_shipping_config', filter, updateData);
      }
      // 기본 그룹이 없으면 레거시 고정 ID 로 생성
      return await sbInsert('bg_shipping_config', {
        id: targetId || SHIPPING_CONFIG_ID,
        name: merged.name || '기본 그룹',
        is_default: !targetId,
        ...merged,
      });
    } catch (e) {
      console.warn('[store] bg_shipping_config save 실패, JSON 폴백:', e.message);
    }
  }
  writeJson(FILES.shippingConfig, merged);
  return merged;
}

/** 새 그룹 생성 (is_default 는 항상 false) */
async function createShippingGroup(data) {
  const name = (data.name || '').trim();
  if (!name) throw new Error('그룹 이름이 필요합니다.');
  const row = {
    ...DEFAULT_SHIPPING_CONFIG,
    ...data,
    name,
    is_default: false,
    created_at: now(),
    updated_at: now(),
  };
  if (USE_SUPABASE) {
    try {
      return await sbInsert('bg_shipping_config', row);
    } catch (e) {
      console.warn('[store] createShippingGroup 실패:', e.message);
      throw e;
    }
  }
  throw new Error('로컬 JSON 모드에서는 그룹 생성 미지원 — Supabase 환경변수 설정 필요');
}

/** 그룹 삭제 (기본 그룹은 삭제 불가). 삭제 전에 해당 그룹을 쓰는 상품이 있으면 에러. */
async function deleteShippingGroup(id) {
  if (!id) throw new Error('그룹 id 가 필요합니다.');
  if (id === SHIPPING_CONFIG_ID) throw new Error('기본 그룹은 삭제할 수 없습니다.');
  if (USE_SUPABASE) {
    // is_default=true 는 삭제 금지
    const target = await sbGet('bg_shipping_config', `id=eq.${encodeURIComponent(id)}`);
    if (!target || !target[0]) throw new Error('존재하지 않는 그룹입니다.');
    if (target[0].is_default) throw new Error('기본 그룹은 삭제할 수 없습니다.');

    // 사용 중인 상품 확인
    const usingProducts = await sbGet('bg_product_settings', `shipping_group_id=eq.${encodeURIComponent(id)}&select=product_id&limit=5`);
    if (usingProducts && usingProducts.length) {
      const codes = usingProducts.map(p => p.product_id).join(', ');
      throw new Error(`이 그룹을 사용하는 상품이 있어 삭제할 수 없습니다: ${codes}`);
    }

    await sbDelete('bg_shipping_config', `id=eq.${encodeURIComponent(id)}`);
    return;
  }
  throw new Error('로컬 JSON 모드에서는 그룹 삭제 미지원');
}

// ============================================
// 알림톡 발송 로그 (bg_alimtalk_log)
// ============================================

/** 발송 기록 저장 */
async function logAlimtalkSend(record) {
  const row = {
    order_id: String(record.order_id),
    to_phone: record.to_phone || null,
    template_code: record.template_code || null,
    message_id: record.message_id || null,
    success: !!record.success,
    is_mock: !!record.is_mock,
    error_code: record.error_code || null,
    error_message: record.error_message || null,
    sent_at: now(),
  };
  if (USE_SUPABASE) {
    try {
      return await sbInsert('bg_alimtalk_log', row);
    } catch (e) {
      // 테이블이 아직 없는 경우 JSON 폴백
      console.warn('[store] bg_alimtalk_log Supabase insert 실패, JSON 폴백:', e.message);
    }
  }
  const logs = readJson(FILES.alimtalkLog, []);
  const local = { id: uuid(), ...row };
  logs.push(local);
  writeJson(FILES.alimtalkLog, logs);
  return local;
}

/**
 * 주문 ID 배열로 발송 이력 조회.
 * @returns {Map<string, { lastSentAt: string, count: number, successCount: number }>}
 */
async function getAlimtalkHistory(orderIds) {
  const result = new Map();
  if (!Array.isArray(orderIds) || orderIds.length === 0) return result;

  let rows = [];
  if (USE_SUPABASE) {
    try {
      const inList = orderIds.map(encodeURIComponent).join(',');
      rows = await sbGet('bg_alimtalk_log', `order_id=in.(${inList})&order=sent_at.desc`);
    } catch (e) {
      console.warn('[store] bg_alimtalk_log Supabase fetch 실패, JSON 폴백:', e.message);
      rows = readJson(FILES.alimtalkLog, []).filter(r => orderIds.includes(r.order_id));
    }
  } else {
    rows = readJson(FILES.alimtalkLog, []).filter(r => orderIds.includes(r.order_id));
  }

  for (const r of rows) {
    const key = r.order_id;
    const prev = result.get(key) || { lastSentAt: null, count: 0, successCount: 0 };
    prev.count += 1;
    if (r.success) prev.successCount += 1;
    if (!prev.lastSentAt || new Date(r.sent_at) > new Date(prev.lastSentAt)) {
      prev.lastSentAt = r.sent_at;
    }
    result.set(key, prev);
  }
  return result;
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
  deleteProductSettings,
  getCustomerInfo,
  getCustomerInfoBatch,
  saveCustomerInfo,
  getAllCustomerInfos,
  updateCustomerInfo,
  deleteCustomerInfo,
  setProcessed,
  setProcessedBatch,
  getShippingConfig,
  saveShippingConfig,
  getShippingGroups,
  createShippingGroup,
  deleteShippingGroup,
  logAlimtalkSend,
  getAlimtalkHistory,
};
