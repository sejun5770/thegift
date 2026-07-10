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
  vendors: path.join(DATA_DIR, 'bg_vendors.json'),
  vendorPortalTokens: path.join(DATA_DIR, 'bg_vendor_portal_tokens.json'),
  manualOrders: path.join(DATA_DIR, 'bg_manual_orders.json'),
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
      sticker_code: data.sticker_code || null,
      preview_image_url: data.preview_image_url || null,
      preview_color: data.preview_color || '#FFFFFF',
      custom_fields: data.custom_fields || [],
      is_active: data.is_active !== false,
    });
  }
  const stickers = readJson(FILES.stickers, []);
  const sticker = {
    id: uuid(), name: data.name || '',
    sticker_code: data.sticker_code || null,
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

/**
 * 스티커 진짜 삭제 (DELETE).
 *   - 기존엔 is_active=false 로 soft-delete 했지만, 사용자 요청에 따라 hard-delete 로 변경.
 *   - 주의: bg_product_settings.available_sticker_ids 에서 참조 중이면 그쪽도 정리 필요.
 *     → 현재는 product_settings 의 available_sticker_ids 가 단순 배열이므로 stale id 가 있어도
 *        UI 에서 자동 무시됨 (renderBgStickerModal 등에서 lookup 실패 시 건너뜀).
 *   - 이미 backfill / 정보입력 데이터의 sticker_selections JSONB 안에 sticker_id 가 박혀있어도
 *     그쪽은 텍스트 sticker_code/name 도 함께 저장돼있어 표시 영향 거의 없음.
 */
async function deleteSticker(id) {
  if (USE_SUPABASE) {
    await sbDelete('bg_stickers', `id=eq.${encodeURIComponent(id)}`);
    return true;
  }
  const stickers = readJson(FILES.stickers, []);
  const filtered = stickers.filter(s => s.id !== id);
  writeJson(FILES.stickers, filtered);
  return true;
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
    brand: data.brand ?? null,
    product_name: data.product_name ?? null,
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
    custom_options: data.custom_options ?? {},  // {옵션그룹명: {use_images:bool, options:[{code,name,color?,preview_image_url?,sold_out}, ...]}}
    decoration_label: data.decoration_label ?? null,  // 고객 화면 장식 명칭 (NULL → '스티커' fallback)
    vendor_id: data.vendor_id ?? null,                // 위탁 거래처 (NULL = 자체매입)
    commission_rate: data.commission_rate !== undefined ? data.commission_rate : null,  // 상품 단위 수수료율 override
    shipping_group_id: data.shipping_group_id ?? null,
    express_available: data.express_available ?? (data.shipping_type === 'today_shipping'),
    express_fee: data.express_fee ?? 0,
    express_cutoff_time: data.express_cutoff_time ?? `${String(data.cutoff_hour ?? 14).padStart(2,'0')}:${String(data.cutoff_minute ?? 0).padStart(2,'0')}`,
    blackout_dates: data.blackout_dates ?? (data.closed_dates || []).map(d => d.date),
    allow_logo_upload: data.allow_logo_upload ?? false,  // 고객 로고 첨부 허용 게이트 (migration 026)
    canonical_group_key: data.canonical_group_key ?? null,       // 대시보드 상품별 매출 통합 집계용 (migration 033)
    canonical_display_name: data.canonical_display_name ?? null, // NULL 이면 product_name 사용
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
    // limit=10000 — PostgREST 기본 max-rows=1000 회피 (다수 order_ids 조회 시 누락 방지).
    const filter = `order_id=in.(${orderIds.map(id => encodeURIComponent(id)).join(',')})&limit=10000`;
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

  // L7: express_fee 음수/NaN 가드 — 입력 검증으로 잘못된 데이터 저장 방지
  const sanitizedExpressFee = Math.max(0, parseInt(data.express_fee, 10) || 0);

  // 정책: 정보입력완료 시점에는 워크플로우 timestamp 를 자동으로 추가하지 않음.
  //   스티커 없음 행의 자동 bound 진행은 수집처리(setProcessed) 시점으로 이동 (운영팀 정책 변경).
  //   sticker_selections 는 클라이언트 전달 그대로 저장.

  const info = {
    order_id: orderId,
    is_express: data.is_express || false,
    express_fee: sanitizedExpressFee,
    desired_ship_date: data.desired_ship_date,
    sticker_selections: data.sticker_selections || [],
    cash_receipt_yn: data.cash_receipt_yn || false,
    receipt_type: data.receipt_type || null,
    receipt_number: data.receipt_number || null,
    customer_request: data.customer_request || null,
    is_special_shipping: !!data.is_special_shipping,
    special_shipping_reason: data.special_shipping_reason || null,
    special_shipping_memo: data.special_shipping_memo || null,
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
  // PostgREST 의 server-side max-rows 가 1000 이라 단일 limit=N 호출로 N 보장 안 됨.
  //   → 명시적 페이지네이션 (offset 기반) 으로 전체 row 수집.
  //   증상 (수정 전): 오래된 CI 가 응답 외 → 미입력 잘못 표시 + 수동 수정 반영 안 됨.
  //   안전 ceiling 100,000 — 그 이상은 architectural redesign 필요.
  if (USE_SUPABASE) {
    const PAGE_SIZE = 1000;
    const MAX_PAGES = 100; // 안전 — 최대 100,000 row
    const all = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const offset = page * PAGE_SIZE;
      const rows = await sbGet('bg_order_customer_info', `order=submitted_at.desc&limit=${PAGE_SIZE}&offset=${offset}`);
      if (!rows || !rows.length) break;
      all.push(...rows);
      if (rows.length < PAGE_SIZE) break; // 마지막 페이지
    }
    return all;
  }
  const infos = readJson(FILES.customerInfo, []);
  return [...infos].sort((a, b) => (b.submitted_at || '').localeCompare(a.submitted_at || ''));
}

/**
 * 빠른출고 옵션 선택한 고객 입력 정보만 fetch — 대시보드 빠른출고 매출 집계용.
 * Supabase 서버측 필터 (is_express=eq.true) 로 페이로드 대폭 감소.
 *   → getAllCustomerInfos() 대비 큰 성능 개선 (대부분 주문은 is_express=false 라 제외됨).
 */
async function getExpressCustomerInfos() {
  if (USE_SUPABASE) {
    // sbGet 가 select=* 자동 포함하므로 filter 만 추가. limit 명시 — PostgREST 기본 1000 회피.
    return sbGet('bg_order_customer_info', 'is_express=eq.true&limit=10000');
  }
  const infos = readJson(FILES.customerInfo, []);
  return infos.filter(ci => ci.is_express === true);
}

/**
 * 희망출고일이 지정된(= desired_ship_date IS NOT NULL) 고객 입력 정보만 fetch — 출고일별 매출 집계용.
 *   대시보드 "희망출고일별 매출" 카드의 데이터원.
 *   PostgREST 'not.is.null' 필터 호환성 이슈 가능성으로 클라 측 필터로 단순화 (row 수 ~수백건 수준이라 성능 영향 미미).
 */
async function getCustomerInfosWithShipDate() {
  const all = await getAllCustomerInfos();
  return all.filter(ci => ci.desired_ship_date);
}

/**
 * 관리자 upsert. 기존 레코드 있으면 PATCH, 없으면 INSERT (고객이 아직 입력 안 한
 * 주문에 관리자가 수동 입력할 때 사용). 고객이 직접 제출하는 POST 경로와 달리
 * ALREADY_SUBMITTED 체크 없이 덮어쓰기.
 */
async function updateCustomerInfo(orderId, data) {
  const allowed = ['desired_ship_date', 'is_express', 'express_fee', 'sticker_selections', 'cash_receipt_yn', 'receipt_type', 'receipt_number', 'customer_request', 'is_special_shipping', 'special_shipping_reason', 'special_shipping_memo'];
  const patch = {};
  for (const k of allowed) { if (k in data) patch[k] = data[k]; }
  // L7: express_fee 음수/NaN 가드
  if ('express_fee' in patch) patch.express_fee = Math.max(0, parseInt(patch.express_fee, 10) || 0);
  // 정책: admin 수정 시점에도 자동 워크플로우 진행 안 함 — saveCustomerInfo 와 동일.
  //   sticker 없음 행 자동 bound 진행은 수집처리(setProcessed) 시점에서만 수행.
  patch.updated_at = now();

  const existing = await getCustomerInfo(orderId);

  // 멀티 출고일 그룹 호환 — admin 이 ci.desired_ship_date / is_express 만 수정해도 정보입력현황 UI 가
  // sel.desired_ship_date / sel.is_express 우선 표시라 옛값이 그대로 보이는 문제 방지.
  //
  // 동기화 정책 (단일 그룹 sel 만 적용, 멀티 그룹 sel 은 보존):
  //   patch 에 desired_ship_date / is_express 가 있고 sticker_selections 가 있으면,
  //   각 sel 중:
  //     - sel.shipping_group_id 가 명시된 멀티 그룹 sel → 그대로 (그룹별 독립)
  //     - 그 외 (단일 그룹 / 구버전) → 옛 ci 값과 같았던 경우만 새 값으로 sync
  if (Array.isArray(patch.sticker_selections) && (('desired_ship_date' in patch) || ('is_express' in patch))) {
    const hasDate = 'desired_ship_date' in patch;
    const hasExp = 'is_express' in patch;
    const newDate = patch.desired_ship_date || null;
    const newExp = !!patch.is_express;
    const oldDate = existing?.desired_ship_date ? String(existing.desired_ship_date).slice(0, 10) : null;
    const oldExp = !!existing?.is_express;
    patch.sticker_selections = patch.sticker_selections.map(sel => {
      if (!sel) return sel;
      if (sel.shipping_group_id) return sel; // 멀티 그룹 보존
      const out = { ...sel };
      if (hasDate) {
        const selDate = sel.desired_ship_date ? String(sel.desired_ship_date).slice(0, 10) : null;
        if (!selDate || selDate === oldDate) out.desired_ship_date = newDate;
      }
      if (hasExp) {
        const selExp = typeof sel.is_express === 'boolean' ? sel.is_express : null;
        if (selExp === null || selExp === oldExp) out.is_express = newExp;
      }
      return out;
    });
  }

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
      is_special_shipping: !!data.is_special_shipping,
      special_shipping_reason: data.special_shipping_reason || null,
      special_shipping_memo: data.special_shipping_memo || null,
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
  // 마켓플레이스 prefix — CP-(쿠팡) / NV-(네이버) ci stub 자동 생성 가능 채널
  const isMarketplace = String(orderId).startsWith('CP-') || String(orderId).startsWith('NV-');
  const isCoupang = isMarketplace; // 기존 변수명 호환 (분기 동일)

  if (USE_SUPABASE) {
    const existing = await sbGet('bg_order_customer_info', `order_id=eq.${encodeURIComponent(orderId)}`);
    // 정책: 수집처리(wantProcessed=true) 시점에 sticker 없음 행을 자동 bound 까지 진행.
    //   이전엔 정보입력 완료 (saveCustomerInfo) 에서 진행 → 운영팀이 미수집 상태인데도 자동
    //   제본완료로 넘어가 사후 워크플로우 분류 문제. 수집 완료를 자동 진행의 트리거로 변경.
    if (wantProcessed && existing && existing.length && existing[0].sticker_selections) {
      const { autoAdvanceNoStickerSelections } = require('./workflow-store');
      const advanced = autoAdvanceNoStickerSelections(existing[0].sticker_selections, 'system:no-sticker:processed');
      patch.sticker_selections = advanced;
    }
    if (!existing || !existing.length) {
      // 쿠팡 주문 ci stub 자동 생성 안전망 — 동기화 전 처리해도 자동으로 만들어 줌.
      //   (sync.js 가 normally 만들지만 이전 동기화/배포 격차로 누락된 row 에 대비)
      if (isCoupang) {
        try {
          await sbInsert('bg_order_customer_info', {
            order_id: orderId,
            is_express: false,
            express_fee: 0,
            desired_ship_date: null,
            sticker_selections: [],
            cash_receipt_yn: false,
            receipt_type: null,
            receipt_number: null,
            customer_request: null,
            submitted_at: now(),
          });
        } catch (e) {
          // 동시성 race 등으로 이미 생긴 경우 무시하고 update 시도
          console.warn(`[setProcessed] 쿠팡 stub 자동 생성 실패 (재시도 무시): ${e.message}`);
        }
      } else {
        throw new Error('NOT_FOUND');
      }
    }
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
  let idx = infos.findIndex(i => i.order_id === orderId);
  if (idx === -1) {
    if (isCoupang) {
      // 파일 폴백 환경에서도 stub 자동 생성
      infos.push({
        id: uuid(), order_id: orderId,
        is_express: false, express_fee: 0,
        desired_ship_date: null, sticker_selections: [],
        cash_receipt_yn: false, receipt_type: null, receipt_number: null,
        customer_request: null, submitted_at: now(), created_at: now(),
      });
      idx = infos.length - 1;
    } else {
      throw new Error('NOT_FOUND');
    }
  }
  // JSON 폴백에서도 수집처리(wantProcessed=true) 시 sticker 없음 행 자동 진행 (Supabase 경로와 일관)
  if (wantProcessed && Array.isArray(infos[idx]?.sticker_selections)) {
    const { autoAdvanceNoStickerSelections } = require('./workflow-store');
    patch.sticker_selections = autoAdvanceNoStickerSelections(infos[idx].sticker_selections, 'system:no-sticker:processed');
  }
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
// 주문조회 '수집완료' 상태 (bg_order_collected)
// 답례품/데코소품/꽃다발 주문조회 페이지에서 마킹하는 수집 상태.
// 기존 로컬 파일(collected.json) 에서 Supabase 로 이전 (migration 012).
// ============================================

/**
 * 전체 수집완료 order_seq 목록 조회.
 * Supabase 미설정 모드: 빈 배열 반환 (서버에선 호출 안 함).
 * Supabase 오류(네트워크/테이블 미존재 등): throw → 호출측 server.js 가 파일 폴백.
 */
async function getCollectedOrderSeqs() {
  if (!USE_SUPABASE) return [];
  // sbGet 이 기본으로 select=* 를 붙이므로 table 만 넘기고 컬럼은 * 그대로 받음.
  const rows = await sbGet('bg_order_collected');
  return Array.isArray(rows) ? rows.map(r => r.order_seq).filter(Boolean) : [];
}

/**
 * 다건 수집완료 마킹. category='daeryepum'|'deco'|'flower' 옵션.
 *
 * 방어:
 *   - 빈/null/undefined/공백 order_seq 제거
 *   - 중복 order_seq 제거 (Postgres ON CONFLICT 가 같은 요청 내 중복 키에서 실패함)
 */
async function addCollectedOrderSeqs(orderSeqs, { category, collectedBy } = {}) {
  // 1) 정규화 → 빈값 제거 → 중복 제거
  const list = [...new Set(
    (orderSeqs || [])
      .map(v => (v == null ? '' : String(v).trim()))
      .filter(Boolean)
  )];
  if (!list.length) return { added: 0 };
  if (!USE_SUPABASE) {
    throw new Error('LOCAL_MODE_NOT_SUPPORTED');
  }
  // Supabase UPSERT — 이미 있으면 collected_at/by 갱신 (on_conflict 지원)
  const now_ = now();
  const rows = list.map(seq => ({
    order_seq: seq,
    collected_at: now_,
    collected_by: collectedBy || null,
    category: category || null,
  }));
  // POST /rest/v1/bg_order_collected?on_conflict=order_seq
  // Prefer: resolution=merge-duplicates
  const url = `${REST_BASE}/bg_order_collected?on_conflict=order_seq`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      ...HEADERS,
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase UPSERT bg_order_collected [${res.status}] rows=${list.length}: ${text}`);
  }
  return { added: list.length };
}

/** 다건 수집해제 */
async function removeCollectedOrderSeqs(orderSeqs) {
  const list = [...new Set(
    (orderSeqs || [])
      .map(v => (v == null ? '' : String(v).trim()))
      .filter(Boolean)
  )];
  if (!list.length) return { removed: 0 };
  if (!USE_SUPABASE) {
    throw new Error('LOCAL_MODE_NOT_SUPPORTED');
  }
  // DELETE /rest/v1/bg_order_collected?order_seq=in.("a","b","c")
  const inList = list.map(s => `"${encodeURIComponent(s)}"`).join(',');
  const url = `${REST_BASE}/bg_order_collected?order_seq=in.(${inList})`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { ...HEADERS, Prefer: 'return=minimal' },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase DELETE bg_order_collected [${res.status}] rows=${list.length}: ${text}`);
  }
  return { removed: list.length };
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

// ============================================
// 위탁업체 (bg_vendors) CRUD — Phase 1
// ============================================

/**
 * 거래처 목록 조회 — active 만 / 전체 옵션.
 * @param {{ activeOnly?: boolean }} opts
 */
async function listVendors({ activeOnly = false } = {}) {
  if (USE_SUPABASE) {
    const filter = activeOnly ? 'is_active=eq.true&order=name.asc' : 'order=is_active.desc,name.asc';
    return sbGet('bg_vendors', filter);
  }
  const rows = readJson(FILES.vendors, []);
  return activeOnly ? rows.filter(v => v.is_active !== false) : rows;
}

async function getVendor(id) {
  if (!id) return null;
  if (USE_SUPABASE) {
    const rows = await sbGet('bg_vendors', `id=eq.${encodeURIComponent(id)}`);
    return rows[0] || null;
  }
  return (readJson(FILES.vendors, [])).find(v => v.id === id) || null;
}

async function createVendor(data) {
  const vendorCode = (data.vendor_code || '').trim() || null;
  const payload = {
    name: (data.name || '').trim(),
    vendor_code: vendorCode,
    contact_person: data.contact_person || null,
    phone: data.phone || null,
    email: data.email || null,
    default_commission_rate: Number(data.default_commission_rate) || 0,
    memo: data.memo || null,
    is_active: data.is_active !== false,
  };
  if (!payload.name) throw new Error('거래처명은 필수입니다');
  if (USE_SUPABASE) return sbInsert('bg_vendors', payload);
  const list = readJson(FILES.vendors, []);
  if (list.some(v => v.name === payload.name)) throw new Error('이미 존재하는 거래처명입니다');
  if (vendorCode && list.some(v => v.vendor_code === vendorCode)) throw new Error('이미 존재하는 거래처코드입니다');
  const local = { id: uuid(), ...payload, created_at: now(), updated_at: now() };
  list.push(local);
  writeJson(FILES.vendors, list);
  return local;
}

async function updateVendor(id, data) {
  if (!id) throw new Error('id 필수');
  const patch = {};
  if (data.name !== undefined) patch.name = String(data.name).trim();
  if (data.vendor_code !== undefined) patch.vendor_code = (String(data.vendor_code).trim() || null);
  if (data.contact_person !== undefined) patch.contact_person = data.contact_person || null;
  if (data.phone !== undefined) patch.phone = data.phone || null;
  if (data.email !== undefined) patch.email = data.email || null;
  if (data.default_commission_rate !== undefined) patch.default_commission_rate = Number(data.default_commission_rate) || 0;
  if (data.memo !== undefined) patch.memo = data.memo || null;
  if (data.is_active !== undefined) patch.is_active = !!data.is_active;
  patch.updated_at = now();
  if (USE_SUPABASE) return sbUpdate('bg_vendors', `id=eq.${encodeURIComponent(id)}`, patch);
  const list = readJson(FILES.vendors, []);
  const idx = list.findIndex(v => v.id === id);
  if (idx < 0) throw new Error('거래처를 찾을 수 없습니다');
  list[idx] = { ...list[idx], ...patch };
  writeJson(FILES.vendors, list);
  return list[idx];
}

async function deleteVendor(id) {
  if (!id) throw new Error('id 필수');
  if (USE_SUPABASE) {
    // 매핑된 상품이 있는지 확인 — 있으면 거절
    const linked = await sbGet('bg_product_settings', `vendor_id=eq.${encodeURIComponent(id)}&select=product_id&limit=1`);
    if (linked.length) throw new Error('이 거래처에 매핑된 상품이 있어 삭제할 수 없습니다. 먼저 상품설정에서 매핑을 해제해주세요.');
    await sbDelete('bg_vendors', `id=eq.${encodeURIComponent(id)}`);
    return { ok: true };
  }
  const list = readJson(FILES.vendors, []);
  const next = list.filter(v => v.id !== id);
  writeJson(FILES.vendors, next);
  return { ok: true };
}

// ============================================
// 거래처 포털 토큰 (bg_vendor_portal_tokens) — Phase 4 (외부 거래처 접근)
// ============================================

/** UUID v4 hex (32자) — crypto.randomUUID 사용. URL-safe. */
function _generatePortalToken() {
  // node 14+: crypto.randomUUID. dashes 제거 → 32 hex chars.
  const { randomUUID } = require('crypto');
  return randomUUID().replace(/-/g, '');
}

async function listVendorPortalTokens(vendorId) {
  if (!vendorId) return [];
  if (USE_SUPABASE) {
    return sbGet('bg_vendor_portal_tokens', `vendor_id=eq.${encodeURIComponent(vendorId)}&order=created_at.desc`);
  }
  return (readJson(FILES.vendorPortalTokens, []))
    .filter(t => t.vendor_id === vendorId);
}

async function createVendorPortalToken(vendorId, { expires_at = null, created_by = null, memo = null } = {}) {
  if (!vendorId) throw new Error('vendor_id 필수');
  const token = _generatePortalToken();
  const row = { token, vendor_id: vendorId, expires_at, created_by, memo };
  if (USE_SUPABASE) return sbInsert('bg_vendor_portal_tokens', row);
  if (!FILES.vendorPortalTokens) FILES.vendorPortalTokens = path.join(DATA_DIR, 'bg_vendor_portal_tokens.json');
  const list = readJson(FILES.vendorPortalTokens, []);
  const local = { id: uuid(), ...row, access_count: 0, created_at: now() };
  list.push(local);
  writeJson(FILES.vendorPortalTokens, list);
  return local;
}

async function revokeVendorPortalToken(id, revoked_by = null) {
  if (!id) throw new Error('id 필수');
  const patch = { revoked_at: now(), revoked_by };
  if (USE_SUPABASE) return sbUpdate('bg_vendor_portal_tokens', `id=eq.${encodeURIComponent(id)}`, patch);
  if (!FILES.vendorPortalTokens) FILES.vendorPortalTokens = path.join(DATA_DIR, 'bg_vendor_portal_tokens.json');
  const list = readJson(FILES.vendorPortalTokens, []);
  const idx = list.findIndex(t => t.id === id);
  if (idx < 0) throw new Error('토큰을 찾을 수 없습니다');
  list[idx] = { ...list[idx], ...patch };
  writeJson(FILES.vendorPortalTokens, list);
  return list[idx];
}

/** 토큰으로 거래처 조회 — 만료/무효 검증 후 vendor 반환. 실패 시 null. */
async function getVendorByPortalToken(token) {
  if (!token) return null;
  let row = null;
  if (USE_SUPABASE) {
    const rows = await sbGet('bg_vendor_portal_tokens', `token=eq.${encodeURIComponent(token)}&limit=1`);
    row = rows[0];
  } else {
    if (!FILES.vendorPortalTokens) FILES.vendorPortalTokens = path.join(DATA_DIR, 'bg_vendor_portal_tokens.json');
    row = (readJson(FILES.vendorPortalTokens, [])).find(t => t.token === token);
  }
  if (!row) return null;
  if (row.revoked_at) return null;
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return null;
  // 유효 — vendor 조회
  const vendor = await getVendor(row.vendor_id);
  if (!vendor || vendor.is_active === false) return null;
  return { vendor, token_row: row };
}

/** 접속 카운트/시각 갱신 (fire-and-forget). */
async function touchVendorPortalToken(tokenRowId) {
  if (!tokenRowId) return;
  // Supabase: 단순 PATCH (race 약간 있지만 통계용이라 허용)
  if (USE_SUPABASE) {
    try {
      const existing = await sbGet('bg_vendor_portal_tokens', `id=eq.${encodeURIComponent(tokenRowId)}&limit=1`);
      const cur = existing[0];
      if (!cur) return;
      await sbUpdate('bg_vendor_portal_tokens', `id=eq.${encodeURIComponent(tokenRowId)}`, {
        last_accessed_at: now(),
        access_count: (cur.access_count || 0) + 1,
      });
    } catch (e) { console.warn('[touchVendorPortalToken] 실패 (무시):', e.message); }
    return;
  }
  if (!FILES.vendorPortalTokens) FILES.vendorPortalTokens = path.join(DATA_DIR, 'bg_vendor_portal_tokens.json');
  const list = readJson(FILES.vendorPortalTokens, []);
  const idx = list.findIndex(t => t.id === tokenRowId);
  if (idx < 0) return;
  list[idx].last_accessed_at = now();
  list[idx].access_count = (list[idx].access_count || 0) + 1;
  writeJson(FILES.vendorPortalTokens, list);
}

// ============================================
// 수동 주문 등록 (bg_manual_orders) — MSSQL 누락 사고 케이스 대응
// ============================================

/**
 * 수동 주문 목록 조회.
 * @param {{ category?: string, start_date?: string, end_date?: string }} opts
 */
async function listManualOrders({ category = null, startDate = null, endDate = null } = {}) {
  if (USE_SUPABASE) {
    const filters = [];
    if (category) filters.push(`category=eq.${encodeURIComponent(category)}`);
    if (startDate) filters.push(`order_date=gte.${encodeURIComponent(startDate)}`);
    if (endDate) filters.push(`order_date=lte.${encodeURIComponent(endDate + 'T23:59:59')}`);
    filters.push('order=order_date.desc');
    return sbGet('bg_manual_orders', filters.join('&'));
  }
  const rows = readJson(FILES.manualOrders, []);
  return rows.filter(r => {
    if (category && r.category !== category) return false;
    if (startDate && (r.order_date || '') < startDate) return false;
    if (endDate && (r.order_date || '') > endDate + 'T23:59:59') return false;
    return true;
  });
}

async function getManualOrder(orderId) {
  if (!orderId) return null;
  if (USE_SUPABASE) {
    const rows = await sbGet('bg_manual_orders', `order_id=eq.${encodeURIComponent(orderId)}`);
    return rows[0] || null;
  }
  return (readJson(FILES.manualOrders, [])).find(r => r.order_id === orderId) || null;
}

async function createManualOrder(data) {
  const orderId = (data.order_id || '').trim();
  if (!orderId) throw new Error('order_id 필수 (실제 missing order_seq 또는 임시 ID)');
  if (!data.order_name || !String(data.order_name).trim()) throw new Error('order_name 필수');

  const payload = {
    order_id: orderId,
    order_name: String(data.order_name).trim(),
    order_hphone: data.order_hphone || null,
    order_email: data.order_email || null,
    recv_name: data.recv_name || data.order_name || null,
    recv_hphone: data.recv_hphone || data.order_hphone || null,
    recv_address: data.recv_address || null,
    recv_zip: data.recv_zip || null,
    recv_msg: data.recv_msg || null,
    order_date: data.order_date || new Date().toISOString(),
    settle_price: Math.max(0, parseInt(data.settle_price, 10) || 0),
    settle_method: data.settle_method || null,
    status_seq: parseInt(data.status_seq, 10) || 4,
    items: Array.isArray(data.items) ? data.items : [],
    site_name: data.site_name || null,
    company_seq: data.company_seq || null,
    category: data.category || 'daeryepum',
    source_memo: data.source_memo || null,
    created_by: data.created_by || null,
  };

  if (USE_SUPABASE) return sbInsert('bg_manual_orders', payload);
  const list = readJson(FILES.manualOrders, []);
  if (list.some(r => r.order_id === orderId)) throw new Error('이미 존재하는 order_id');
  const local = { id: uuid(), ...payload, created_at: now(), updated_at: now() };
  list.push(local);
  writeJson(FILES.manualOrders, list);
  return local;
}

/**
 * MANUAL 주문 → bg_order_customer_info stub 생성 헬퍼.
 *   order_id 는 `MO-{manualOrderId}` 형식.
 *   기본: 이미 있으면 skip.
 *   force=true: 기존 삭제 후 최신 items 로 재생성 (sticker_code=null 등 옛 데이터 정리).
 *   items 배열에서 sticker_selections 로 정규화.
 *   반환: 'created' | 'exists' | 'recreated' | 'error:{msg}'
 */
async function _ensureStubForManualOrder(mo, { force = false, stickerMap = null } = {}) {
  const orderId = (mo.order_id || '').trim();
  if (!orderId) return 'error:missing order_id';
  const stubId = `MO-${orderId}`;
  const existing = await getCustomerInfo(stubId);
  if (existing && !force) return 'exists';
  // force=true: 기존 stub 삭제 → saveCustomerInfo 의 ALREADY_SUBMITTED 방지
  if (existing && force) {
    if (USE_SUPABASE) {
      try { await sbDelete('bg_order_customer_info', `order_id=eq.${encodeURIComponent(stubId)}`); }
      catch (e) { return `error:delete failed - ${e.message}`; }
    } else {
      const infos = readJson(FILES.customerInfo, []);
      writeJson(FILES.customerInfo, infos.filter(i => i.order_id !== stubId));
    }
  }
  // bg_stickers 매핑 준비 (매번 로드 방지 위해 caller 가 stickerMap 전달 가능)
  if (!stickerMap) {
    try {
      const all = await getAllStickers();
      stickerMap = new Map((all || []).map(s => [String(s.sticker_code || '').trim().toUpperCase(), { id: s.id, name: s.name }]));
    } catch (e) {
      console.warn('[_ensureStubForManualOrder] bg_stickers 로드 실패 (sticker_name 매칭 skip):', e.message);
      stickerMap = new Map();
    }
  }
  const items = Array.isArray(mo.items) ? mo.items : [];
  // 상품명 prefix "오늘출발" 감지 — 하나라도 있으면 주문 전체를 빠른출고로 분류.
  //   (CSV 업로드 시 items[i].product_name 에 "[오늘출발] ..." / "오늘출발 ..." 등으로 붙어있음.)
  //   대시보드 (apiDashboardByShipDate) 는 ci.is_express 를 그대로 express 버킷 판정에 사용.
  //   단, "[오늘출발무료]" 프리픽스는 배송비 무료 이벤트 표기일 뿐 실제 빠른출고 아님 → 제외.
  const isExpressItem = it => {
    const name = String(it?.product_name || '');
    if (!name.includes('오늘출발')) return false;
    if (name.includes('오늘출발무료')) return false;   // 배송비 무료 이벤트 표기 → 일반주문 처리
    return true;
  };
  const hasExpressItem = items.some(isExpressItem);
  const stickerSelections = items.map(it => {
    // 스티커 코드 — items[i].stickers[0].code 우선. 없으면 빈 문자열.
    const stickerCode = (Array.isArray(it.stickers) && it.stickers[0]?.code) || '';
    const codeKey = String(stickerCode).trim().toUpperCase();
    const stickerInfo = codeKey ? stickerMap.get(codeKey) : null;
    // 문구 — sticker_note (K열 추가입력옵션) 을 custom_values.text 로 매핑 → 정보입력현황 문구 컬럼 노출
    const noteText = String(it.sticker_note || '').trim();
    // custom_options — 수집복사가 K/L 열을 이 값에서 뽑음 (그룹명 순서로 firstGroupOpt/secondGroupOpt).
    //   수건 등 자유옵션 2개 있는 상품은 두 code 를 그룹으로 저장 → 수집복사 K/L 모두 정상.
    const customOptions = {};
    if (it.product_code) customOptions['품목1'] = { code: it.product_code, name: it.product_name || it.product_code };
    if (it.product_code_2) customOptions['품목2'] = { code: it.product_code_2, name: '' };
    return {
      product_code: it.product_code || '',
      product_code_2: it.product_code_2 || '',
      product_name: it.product_name || '',
      quantity: Number(it.quantity) || 0,
      box_code: it.box_code || '',
      sticker_id: stickerInfo?.id || null,
      sticker_code: stickerCode,
      sticker_name: stickerInfo?.name || '',
      custom_values: noteText ? { text: noteText } : {},
      custom_options: customOptions,
      desired_ship_date: mo._desired_ship_date || null,
      is_express: isExpressItem(it),  // product 단위 빠른출고 여부 (sticker_selection 우선 lookup)
    };
  });
  try {
    await saveCustomerInfo(stubId, {
      is_express: hasExpressItem,
      express_fee: 0,
      desired_ship_date: mo._desired_ship_date || null,
      sticker_selections: stickerSelections,
      cash_receipt_yn: false,
      receipt_type: null,
      receipt_number: null,
      customer_request: mo._customer_request || null,
    });
    return force && existing ? 'recreated' : 'created';
  } catch (e) {
    if (/already/i.test(e.message || '')) return 'exists';
    return `error:${e.message}`;
  }
}

/**
 * 이미 등록된 bg_manual_orders 중 ci stub 없는 것들을 일괄 backfill.
 *   category (default 'daeryepum') 필터.
 *   force=true 이면 기존 stub 도 삭제 후 재생성 (sticker_code=null 등 옛 데이터 정리).
 *   반환: {total, created, exists, recreated, failed, details}
 */
async function backfillManualOrderStubs({ category = 'daeryepum', force = false } = {}) {
  const orders = await listManualOrders({ category });
  // stickerMap 사전 로드 — 반복 호출 방지 (수백 건도 1회만 조회)
  let stickerMap = new Map();
  try {
    const all = await getAllStickers();
    stickerMap = new Map((all || []).map(s => [String(s.sticker_code || '').trim().toUpperCase(), { id: s.id, name: s.name }]));
  } catch (e) { console.warn('[backfill] stickerMap 로드 실패:', e.message); }
  const result = { total: orders.length, created: 0, exists: 0, recreated: 0, failed: 0, details: [] };
  for (const mo of orders) {
    const status = await _ensureStubForManualOrder(mo, { force, stickerMap });
    if (status === 'created') { result.created++; result.details.push({ order_id: mo.order_id, status: 'created' }); }
    else if (status === 'recreated') { result.recreated++; result.details.push({ order_id: mo.order_id, status: 'recreated' }); }
    else if (status === 'exists') { result.exists++; }
    else { result.failed++; result.details.push({ order_id: mo.order_id, status: 'failed', reason: status.replace(/^error:/, '') }); }
  }
  return result;
}

/**
 * 배치 등록 — CSV 업로드 등 일괄 insert.
 *   각 주문 개별 try/catch → 실패한 것도 결과에 기록. 전체 실패는 없음.
 *   dryRun=true 면 실제 insert 하지 않고 valid/invalid 만 판정.
 *   재업로드 케이스: skip 되더라도 stub 은 확인/생성 (backfill 겸함).
 *   overwrite=true 이면 기존 있는 주문의 items 를 덮어씀 + stub 도 재생성.
 *     → 옛날 파서 결과 (스티커 정보 누락 등) 를 최신 파서 결과로 갱신 가능.
 */
async function bulkCreateManualOrders(orders, { dryRun = false, overwrite = false } = {}) {
  if (!Array.isArray(orders)) throw new Error('orders 는 배열이어야 합니다');
  // stickerMap 사전 로드 — 반복 호출 방지
  let stickerMap = new Map();
  try {
    const all = await getAllStickers();
    stickerMap = new Map((all || []).map(s => [String(s.sticker_code || '').trim().toUpperCase(), { id: s.id, name: s.name }]));
  } catch (e) { console.warn('[bulkCreate] stickerMap 로드 실패:', e.message); }
  const results = { total: orders.length, success: 0, failed: 0, skipped: 0, updated: 0, details: [] };
  for (const [idx, data] of orders.entries()) {
    try {
      const orderId = (data.order_id || '').trim();
      if (!orderId) throw new Error('order_id 누락');
      if (!data.order_name || !String(data.order_name).trim()) throw new Error('order_name 누락');
      // 중복 체크 — 이미 있으면 manual_order 는 skip, 하지만 ci stub 만 없으면 backfill 로 생성.
      const existing = await getManualOrder(orderId);
      if (existing) {
        if (overwrite && !dryRun) {
          // 기존 items 등을 최신 파싱 결과로 갱신 + stub 삭제 후 재생성.
          const patch = {
            order_name: data.order_name,
            order_hphone: data.order_hphone || null,
            recv_name: data.recv_name || data.order_name || null,
            recv_hphone: data.recv_hphone || data.order_hphone || null,
            recv_address: data.recv_address || null,
            recv_msg: data.recv_msg || null,
            settle_price: data.settle_price || 0,
            status_seq: data.status_seq || 4,
            items: Array.isArray(data.items) ? data.items : [],
            site_name: data.site_name || '바른손더기프트',
            source_memo: data.source_memo || null,
          };
          await updateManualOrder(orderId, patch);
          // 기존 stub 삭제 후 새로 생성 (sticker_selections 최신화)
          const stubId = `MO-${orderId}`;
          if (USE_SUPABASE) {
            try { await sbDelete('bg_order_customer_info', `order_id=eq.${encodeURIComponent(stubId)}`); } catch { /* ignore */ }
          }
          const stubStatus = await _ensureStubForManualOrder(data, { stickerMap });
          results.updated++;
          results.details.push({ index: idx, order_id: orderId, status: 'updated', stub: stubStatus });
          continue;
        }
        // 기본 (overwrite=false): 기존 유지, stub 만 backfill.
        let stubStatus = 'exists';
        try { stubStatus = await _ensureStubForManualOrder({ ...existing, _desired_ship_date: data._desired_ship_date, _customer_request: data._customer_request }, { stickerMap }); }
        catch (e) { stubStatus = 'error'; }
        results.skipped++;
        results.details.push({ index: idx, order_id: orderId, status: 'skipped', reason: '이미 존재', stub: stubStatus });
        continue;
      }
      if (dryRun) {
        results.success++;
        results.details.push({ index: idx, order_id: orderId, status: 'ok' });
        continue;
      }
      await createManualOrder(data);
      // stub 저장 — 헬퍼 재사용 (실패해도 manual_order 는 유지).
      const stubStatus = await _ensureStubForManualOrder(data, { stickerMap });
      results.success++;
      results.details.push({ index: idx, order_id: orderId, status: 'created', stub: stubStatus });
    } catch (e) {
      results.failed++;
      results.details.push({ index: idx, order_id: data.order_id || '', status: 'failed', reason: e.message });
    }
  }
  return results;
}

async function updateManualOrder(orderId, data) {
  if (!orderId) throw new Error('order_id 필수');
  const patch = {};
  const allowed = [
    'order_name', 'order_hphone', 'order_email',
    'recv_name', 'recv_hphone', 'recv_address', 'recv_zip', 'recv_msg',
    'order_date', 'settle_price', 'settle_method', 'status_seq',
    'items', 'site_name', 'company_seq', 'category', 'source_memo',
  ];
  for (const k of allowed) { if (k in data) patch[k] = data[k]; }
  if ('settle_price' in patch) patch.settle_price = Math.max(0, parseInt(patch.settle_price, 10) || 0);
  if ('status_seq' in patch) patch.status_seq = parseInt(patch.status_seq, 10) || 4;
  if ('items' in patch && !Array.isArray(patch.items)) patch.items = [];
  patch.updated_at = now();

  if (USE_SUPABASE) return sbUpdate('bg_manual_orders', `order_id=eq.${encodeURIComponent(orderId)}`, patch);
  const list = readJson(FILES.manualOrders, []);
  const idx = list.findIndex(r => r.order_id === orderId);
  if (idx < 0) throw new Error('주문을 찾을 수 없습니다');
  list[idx] = { ...list[idx], ...patch };
  writeJson(FILES.manualOrders, list);
  return list[idx];
}

async function deleteManualOrder(orderId) {
  if (!orderId) throw new Error('order_id 필수');
  // 연쇄 삭제: bg_order_customer_info stub (MO-{order_id}) 도 함께 정리 → 정보입력현황에서도 사라짐.
  //   stub 없어도 무시 (idempotent).
  const stubId = `MO-${orderId}`;
  if (USE_SUPABASE) {
    await sbDelete('bg_manual_orders', `order_id=eq.${encodeURIComponent(orderId)}`);
    try {
      await sbDelete('bg_order_customer_info', `order_id=eq.${encodeURIComponent(stubId)}`);
    } catch (e) { console.warn(`[deleteManualOrder] stub 삭제 무시 (${stubId}):`, e.message); }
    return { ok: true };
  }
  const list = readJson(FILES.manualOrders, []);
  const next = list.filter(r => r.order_id !== orderId);
  writeJson(FILES.manualOrders, next);
  // 로컬 파일 fallback 도 stub 삭제
  try {
    const infos = readJson(FILES.customerInfo, []);
    const nextInfos = infos.filter(i => i.order_id !== stubId);
    writeJson(FILES.customerInfo, nextInfos);
  } catch (e) { /* ignore */ }
  return { ok: true };
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
  getExpressCustomerInfos,
  getCustomerInfosWithShipDate,
  updateCustomerInfo,
  deleteCustomerInfo,
  setProcessed,
  setProcessedBatch,
  getCollectedOrderSeqs,
  addCollectedOrderSeqs,
  removeCollectedOrderSeqs,
  getShippingConfig,
  saveShippingConfig,
  getShippingGroups,
  createShippingGroup,
  deleteShippingGroup,
  logAlimtalkSend,
  getAlimtalkHistory,
  // 위탁업체 (Phase 1)
  listVendors,
  getVendor,
  createVendor,
  updateVendor,
  deleteVendor,
  // 거래처 포털 토큰 (Phase 4)
  listVendorPortalTokens,
  createVendorPortalToken,
  revokeVendorPortalToken,
  getVendorByPortalToken,
  touchVendorPortalToken,
  // 수동 주문 등록 (사고 케이스용)
  listManualOrders,
  getManualOrder,
  createManualOrder,
  bulkCreateManualOrders,
  backfillManualOrderStubs,
  updateManualOrder,
  deleteManualOrder,
};
