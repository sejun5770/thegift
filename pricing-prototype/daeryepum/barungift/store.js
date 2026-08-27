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
  salesGroups: path.join(DATA_DIR, 'bg_sales_groups.json'),
  salesGroupMembers: path.join(DATA_DIR, 'bg_sales_group_members.json'),
  salesExclusions: path.join(DATA_DIR, 'bg_sales_exclusions.json'),
  stockItems: path.join(DATA_DIR, 'bg_stock_items.json'),
  stockBom: path.join(DATA_DIR, 'bg_stock_bom.json'),
  incidents: path.join(DATA_DIR, 'bg_incidents.json'),
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

// 판매채널 (migration 053) — 매입형태(vendor_id)와는 다른 축.
//   DB CHECK 제약과 같은 목록이어야 한다. 값이 어긋나면 저장이 통째로 실패하므로
//   여기서 먼저 걸러 'own' 으로 떨어뜨린다.
const PRODUCT_CHANNELS = ['own', 'coupang', 'naver', 'cafe24', 'thegift', 'etc'];

/** 채널별 고정 스티커 {"coupang":"TGCP01S1"} 정규화 (056).
 *  고객 선택 목록(available_sticker_ids)과 분리된 값 — 자사 화면에 다른 채널 스티커가 새지 않게 한다. */
function _normChannelStickers(v) {
  const out = {};
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, code] of Object.entries(v)) {
      if (!PRODUCT_CHANNELS.includes(k)) continue;
      const c = String(code ?? '').trim();
      if (c) out[k] = c;
    }
  }
  return out;
}

/**
 * 채널 상품코드 매핑 정규화 (057).
 *   {"coupang": {"product_ids": ["16281105078"], "option_ids": ["95408060495"]}}
 *
 *   등록상품ID 는 옵션 여러 개를 묶는 상위 코드라, 같은 등록상품 안에서 옵션마다
 *   내부코드가 갈리는 경우가 있다. 그때는 option_ids 로 잡아야 구분된다.
 *   조회 시 옵션ID 매핑을 먼저 보고, 없으면 등록상품ID 매핑을 본다.
 *
 *   구형(배열만) 값도 받아 product_ids 로 승계한다.
 */
function _normChannelProductCodes(v) {
  const out = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  const clean = list => [...new Set((Array.isArray(list) ? list : [list])
    .map(c => String(c ?? '').trim()).filter(Boolean))];
  for (const [k, val] of Object.entries(v)) {
    if (!PRODUCT_CHANNELS.includes(k)) continue;
    const productIds = Array.isArray(val) ? clean(val) : clean(val?.product_ids);
    const optionIds = Array.isArray(val) ? [] : clean(val?.option_ids);
    if (!productIds.length && !optionIds.length) continue;
    out[k] = {};
    if (productIds.length) out[k].product_ids = productIds;
    if (optionIds.length) out[k].option_ids = optionIds;
  }
  return out;
}

/** 채널별 판매단위 {"coupang":10} 정규화 (060). 1 이상 정수만. */
function _normChannelSalesUnits(v) {
  const out = {};
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, n] of Object.entries(v)) {
      if (!PRODUCT_CHANNELS.includes(k)) continue;
      const u = parseInt(n, 10);
      // 1 은 기본값이라 굳이 저장하지 않는다 — 지정된 것만 남겨 의도가 드러나게
      if (u > 1) out[k] = u;
    }
  }
  return out;
}

/** 채널 배열 정규화 — 알 수 없는 값은 버리고, 비면 'own'.
 *  빈 배열이면 DB CHECK 에 걸려 저장이 통째로 실패하므로 여기서 반드시 하나는 남긴다. */
/** 숫자만 통과 — '' / null / NaN 은 NULL (미입력). 0 은 유효한 값이라 살린다. */
function _numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function _normChannels(v) {
  const list = (Array.isArray(v) ? v : [v]).map(c => String(c ?? '').trim())
    .filter(c => PRODUCT_CHANNELS.includes(c));
  return [...new Set(list)].length ? [...new Set(list)] : ['own'];
}

async function upsertProductSettings(productId, data) {
  const existing = await getProductSettings(productId);
  // 채널은 넘어온 경우에만 손댄다 — 안 보낸 필드를 임의로 'own' 으로 덮으면
  // 다른 화면에서 부분 저장할 때 쿠팡 상품이 조용히 자사로 바뀐다.
  if ('sales_channels' in data) {
    data = { ...data, sales_channels: _normChannels(data.sales_channels) };
  }
  if ('channel_stickers' in data) {
    data = { ...data, channel_stickers: _normChannelStickers(data.channel_stickers) };
  }
  if ('channel_product_codes' in data) {
    data = { ...data, channel_product_codes: _normChannelProductCodes(data.channel_product_codes) };
  }
  if ('channel_sales_units' in data) {
    data = { ...data, channel_sales_units: _normChannelSalesUnits(data.channel_sales_units) };
  }

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
    // 원가 (068) — 마진 계산용. NULL(미입력) 과 0(원가 없음) 을 구분해야 하므로
    //   빈 문자열은 NULL 로 떨어뜨리고 숫자만 통과시킨다.
    unit_cost: _numOrNull(data.unit_cost),
    inbound_unit_cost: _numOrNull(data.inbound_unit_cost),
    shipping_group_id: data.shipping_group_id ?? null,
    express_available: data.express_available ?? (data.shipping_type === 'today_shipping'),
    express_fee: data.express_fee ?? 0,
    express_cutoff_time: data.express_cutoff_time ?? `${String(data.cutoff_hour ?? 14).padStart(2,'0')}:${String(data.cutoff_minute ?? 0).padStart(2,'0')}`,
    blackout_dates: data.blackout_dates ?? (data.closed_dates || []).map(d => d.date),
    allow_logo_upload: data.allow_logo_upload ?? false,  // 고객 로고 첨부 허용 게이트 (migration 026)
    canonical_group_key: data.canonical_group_key ?? null,       // 대시보드 상품별 매출 통합 집계용 (migration 033)
    canonical_display_name: data.canonical_display_name ?? null, // NULL 이면 product_name 사용
    custom_guide_text: data.custom_guide_text ?? null,           // 고객 order-info STEP1 안내 (migration 034)
    custom_guide_title: data.custom_guide_title ?? null,         // 안내 박스 타이틀 (migration 035)
    sales_channels: _normChannels(data.sales_channels),   // migration 054 (복수 채널)
    channel_stickers: _normChannelStickers(data.channel_stickers), // migration 056
    channel_product_codes: _normChannelProductCodes(data.channel_product_codes), // migration 057
    channel_sales_units: _normChannelSalesUnits(data.channel_sales_units), // migration 060
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

/**
 * 수집완료(processed_at) 됐고 희망출고일이 이미 지난 주문 목록.
 *   출고 누락 감시(barungift/missed-shipping.js) 전용 — 여기서는 우리 쪽 기록만 모으고,
 *   실제 출고 여부 판정은 MSSQL 을 함께 보는 쪽에서 한다.
 *
 * sbGet 을 쓰지 않는 이유: PostgREST 기본 상한이 1000행이라 조용히 잘린다.
 *   (실측 2026-08-21 — 6월 이후만도 2,706행이라 한 번에 못 받는다) 그래서 직접 페이징한다.
 *
 * @param {{before:string, from:string}} p  before/from 모두 'YYYY-MM-DD'.
 *   desired_ship_date 가 [from, before) 인 행. before 는 보통 오늘 = 오늘 출고분은 아직 정상.
 */
async function listProcessedShipDateBefore({ before, from }) {
  if (!USE_SUPABASE) return [];
  const PAGE = 1000;
  const out = [];
  for (let offset = 0; ; offset += PAGE) {
    const url = `${REST_BASE}/bg_order_customer_info`
      + '?select=order_id,desired_ship_date,processed_at,processed_by'
      + '&processed_at=not.is.null'
      + `&desired_ship_date=lt.${encodeURIComponent(before)}`
      + `&desired_ship_date=gte.${encodeURIComponent(from)}`
      + `&order=desired_ship_date.asc&limit=${PAGE}&offset=${offset}`;
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Supabase GET bg_order_customer_info [${res.status}]: ${text}`);
    }
    const page = await res.json();
    out.push(...page);
    if (page.length < PAGE) break;
  }
  return out;
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
 * 출고완료 안내 문자(template_code) 발송 이력 — 중복 발송 방지용.
 *   bg_alimtalk_log 를 template_code 로 걸러 order_id → {count, lastSentAt, lastSuccess} 맵.
 */
async function getSmsSendHistory(orderIds, templateCode) {
  const result = new Map();
  const ids = [...new Set((orderIds || []).map(v => String(v || '').trim()).filter(Boolean))];
  if (!ids.length) return result;
  let rows = [];
  if (USE_SUPABASE) {
    try {
      const inList = ids.map(id => `"${encodeURIComponent(id)}"`).join(',');
      rows = await sbGet('bg_alimtalk_log',
        `order_id=in.(${inList})&template_code=eq.${encodeURIComponent(templateCode)}&order=sent_at.desc`);
    } catch (e) {
      console.warn('[store] sms history 조회 실패 (무시):', e.message);
      rows = [];
    }
  } else {
    rows = (readJson(FILES.alimtalkLog, [])).filter(r => ids.includes(String(r.order_id)) && r.template_code === templateCode);
  }
  for (const r of rows) {
    const key = String(r.order_id);
    const cur = result.get(key) || { count: 0, successCount: 0, lastSentAt: null };
    cur.count++;
    if (r.success) cur.successCount++;
    if (!cur.lastSentAt || String(r.sent_at) > String(cur.lastSentAt)) cur.lastSentAt = r.sent_at;
    result.set(key, cur);
  }
  return result;
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

/**
 * vendor_name (076) 컬럼이 아직 없는 환경 폴백.
 *   마이그레이션 전에 배포되면 PostgREST 가 42703(column does not exist) 로 거절해
 *   업로드가 통째로 실패한다. 그 오류에 한해 컬럼을 빼고 한 번만 다시 시도한다 —
 *   판매 주체는 못 남기지만 주문 자체는 들어간다. 마이그레이션 후에는 이 경로를 타지 않는다.
 */
async function _withVendorColumnFallback(payload, run) {
  try {
    return await run(payload);
  } catch (e) {
    const msg = String(e && e.message || '');
    if (!('vendor_name' in payload) || !/vendor_name/.test(msg) || !/42703|column|does not exist|schema cache/i.test(msg)) throw e;
    console.warn('[manual-order] vendor_name 컬럼 없음 — 마이그레이션 076 미적용. 판매 주체 없이 저장합니다.');
    const { vendor_name, ...rest } = payload;
    return run(rest);
  }
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
    // 판매 주체 (076) — NULL=본사(매입) / '혼합' / 위탁업체명.
    //   빈 문자열이 들어오면 NULL 로 떨어뜨린다 (본사와 같은 취급).
    vendor_name: (data.vendor_name && String(data.vendor_name).trim()) || null,
    created_by: data.created_by || null,
  };

  if (USE_SUPABASE) return _withVendorColumnFallback(payload, p => sbInsert('bg_manual_orders', p));
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
  // force=true 재생성 시 preserve — bg_manual_orders 자체에 desired_ship_date 컬럼이 없어
  //   mo._desired_ship_date 는 CSV 업로드 시점 payload 에만 존재. backfill 은 그 값을 못 가짐 →
  //   기존 stub 삭제 전에 desired_ship_date / sticker_selections[i].desired_ship_date 를 뽑아둠.
  //   운영자가 정보입력현황에서 수정한 값도 그대로 유지됨.
  let preservedTopShipDate = null;
  const preservedSelShipByIdx = new Map();      // idx → date
  const preservedSelShipByCode = new Map();     // product_code → date (idx 재정렬 대비 fallback)
  // 작업 흔적 보존 (076) — 같은 파일을 '기존 덮어쓰기' 로 다시 올리면 stub 을 새로 만드는데,
  //   그때 수집완료(processed_at) 와 스티커/인쇄/제본/포장 진행 timestamp, 업로드한 이미지가
  //   통째로 날아가 작업을 처음부터 다시 해야 했다. 파일에서 다시 만들 수 없는 값들이라 되살린다.
  //   워크플로우 필드는 stage 가 늘어도 따라가도록 이름 규칙(*_at / *_by)으로 잡는다.
  const isWorkflowKey = k => /_(at|by)$/.test(k) || k === 'images';
  const preservedSelWorkByIdx = new Map();
  const preservedSelWorkByCode = new Map();
  let preservedProcessed = null;
  if (existing && force) {
    preservedTopShipDate = existing.desired_ship_date || null;
    if (existing.processed_at || existing.submitted_at) {
      preservedProcessed = {
        processed_at: existing.processed_at || null,
        processed_by: existing.processed_by || null,
        submitted_at: existing.submitted_at || null,
      };
    }
    const sels = Array.isArray(existing.sticker_selections) ? existing.sticker_selections : [];
    sels.forEach((sel, i) => {
      if (sel?.desired_ship_date) {
        preservedSelShipByIdx.set(i, sel.desired_ship_date);
        if (sel.product_code) preservedSelShipByCode.set(String(sel.product_code), sel.desired_ship_date);
      }
      const work = {};
      Object.keys(sel || {}).forEach(k => { if (isWorkflowKey(k) && sel[k] != null) work[k] = sel[k]; });
      if (Object.keys(work).length) {
        preservedSelWorkByIdx.set(i, work);
        if (sel.product_code) preservedSelWorkByCode.set(String(sel.product_code), work);
      }
    });
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
  // 혼합 주문은 본사 품목만 스티커 작업 대상 (076)
  const items = _collectItemsOf(mo);
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
  const stickerSelections = items.map((it, idx) => {
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
    // desired_ship_date preserve 우선순위:
    //   1) 이전 stub 의 같은 idx sel 값 (force 재생성 시)
    //   2) 이전 stub 의 같은 product_code sel 값 (items 순서 바뀐 케이스 fallback)
    //   3) mo._desired_ship_date (CSV payload — backfill 시엔 없음)
    //   4) preservedTopShipDate (전체 stub 값, 균일 그룹인 경우 안전 fallback)
    const preservedShip = preservedSelShipByIdx.get(idx)
      || (it.product_code && preservedSelShipByCode.get(String(it.product_code)))
      || mo._desired_ship_date
      || preservedTopShipDate
      || null;
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
      desired_ship_date: preservedShip,
      is_express: isExpressItem(it),  // product 단위 빠른출고 여부 (sticker_selection 우선 lookup)
      // 재생성 전 작업 흔적(진행 timestamp · 업로드 이미지) 되살리기 — 상품코드 우선, 없으면 순번.
      ...(preservedSelWorkByCode.get(String(it.product_code || '')) || preservedSelWorkByIdx.get(idx) || {}),
    };
  });
  try {
    await saveCustomerInfo(stubId, {
      is_express: hasExpressItem,
      express_fee: 0,
      // desired_ship_date: 기존 stub 값 preserve > CSV payload > null.
      //   backfill 재생성 시 정보입력현황에서 이미 지정된 출고일 유지.
      desired_ship_date: preservedTopShipDate || mo._desired_ship_date || null,
      sticker_selections: stickerSelections,
      cash_receipt_yn: false,
      receipt_type: null,
      receipt_number: null,
      customer_request: mo._customer_request || existing?.customer_request || null,
    });
    // saveCustomerInfo 는 submitted_at 을 now() 로 새로 찍고 processed_* 를 받지 않는다.
    //   재생성이면 원래 값으로 되돌려 수집완료 표시가 유지되게 한다.
    if (preservedProcessed) {
      try {
        if (USE_SUPABASE) {
          await sbUpdate('bg_order_customer_info', `order_id=eq.${encodeURIComponent(stubId)}`, preservedProcessed);
        } else {
          const infos = readJson(FILES.customerInfo, []);
          const idx2 = infos.findIndex(i => i.order_id === stubId);
          if (idx2 >= 0) { infos[idx2] = { ...infos[idx2], ...preservedProcessed }; writeJson(FILES.customerInfo, infos); }
        }
      } catch (e) { console.warn(`[stub] ${stubId} 수집완료 복원 실패 (무시):`, e.message); }
    }
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
 *   offset/limit — 청크 처리용. 클라이언트가 여러 번 나눠 호출해 프록시 timeout 회피.
 *   반환: {total, processed, remaining, offset_next, created, exists, recreated, failed, details}
 */
async function backfillManualOrderStubs({ category = 'daeryepum', force = false, offset = 0, limit = null } = {}) {
  const all = await listManualOrders({ category });
  const total = all.length;
  const startIdx = Math.max(0, Number(offset) || 0);
  const endIdx = limit ? Math.min(total, startIdx + Number(limit)) : total;
  const orders = all.slice(startIdx, endIdx);
  // stickerMap 사전 로드 — 반복 호출 방지 (수백 건도 1회만 조회)
  let stickerMap = new Map();
  try {
    const allSt = await getAllStickers();
    stickerMap = new Map((allSt || []).map(s => [String(s.sticker_code || '').trim().toUpperCase(), { id: s.id, name: s.name }]));
  } catch (e) { console.warn('[backfill] stickerMap 로드 실패:', e.message); }
  const result = {
    total, processed: orders.length,
    offset_next: endIdx, remaining: Math.max(0, total - endIdx),
    created: 0, exists: 0, recreated: 0, failed: 0, details: [],
  };
  for (const mo of orders) {
    // 위탁 주문은 주문수집 대상이 아니다 (076) — 여기서 걸러야 'stub 재생성' 버튼 한 번에
    //   위탁 stub 이 통째로 만들어져 정보입력현황·출고일 집계로 새어 들어간다.
    if (!_needsCollectStub(mo)) { result.skipped_vendor = (result.skipped_vendor || 0) + 1; continue; }
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
/**
 * 이 주문이 우리 주문수집(정보입력현황) 대상인가 (076).
 *   위탁업체 주문은 우리가 스티커를 만들지도, 출고하지도 않는다 — MO- stub 을 만들면
 *   정보입력현황에 영영 처리되지 않는 미입력 건으로 쌓인다. 그래서 stub 자체를 만들지 않는다.
 *   '혼합'(본사+위탁 한 주문)은 본사 품목이 있으므로 만든다.
 */
function _needsCollectStub(data) {
  const v = (data && data.vendor_name ? String(data.vendor_name).trim() : '');
  if (!v) return true;              // 본사 주문
  if (v !== '혼합') return false;   // 위탁 단독 주문
  // '혼합' 은 라벨만으로 믿지 않는다 — 위탁업체 2곳이 한 주문에 섞여도 '혼합' 이 붙는데
  //   그 주문엔 본사 품목이 하나도 없다. 품목의 vendor 로 실제 본사 품목 유무를 본다.
  const items = Array.isArray(data && data.items) ? data.items : [];
  return items.some(it => !it || !it.vendor);
}
/** 주문수집 대상 품목만 (위탁 품목은 우리가 만들지 않으니 스티커 작업 목록에서 뺀다). */
function _collectItemsOf(mo) {
  const items = Array.isArray(mo && mo.items) ? mo.items : [];
  const v = (mo && mo.vendor_name ? String(mo.vendor_name).trim() : '');
  if (v !== '혼합') return items;
  const own = items.filter(it => !it || !it.vendor);
  return own.length ? own : items;
}

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
          patch.vendor_name = (data.vendor_name && String(data.vendor_name).trim()) || null;
          await updateManualOrder(orderId, patch);
          // stub 재생성 — force 로 넘겨 수집완료·작업 진행·이미지를 보존한 채 items 만 최신화한다.
          //   (예전처럼 먼저 지우고 만들면 그 값들이 전부 사라져 작업을 다시 해야 했다.)
          //   위탁으로 바뀐 주문은 남은 stub 을 지우기만 하고 다시 만들지 않는다.
          const stubId = `MO-${orderId}`;
          let stubStatus;
          if (_needsCollectStub(data)) {
            stubStatus = await _ensureStubForManualOrder(data, { force: true, stickerMap });
          } else {
            if (USE_SUPABASE) {
              try { await sbDelete('bg_order_customer_info', `order_id=eq.${encodeURIComponent(stubId)}`); } catch { /* ignore */ }
            } else {
              const infos = readJson(FILES.customerInfo, []);
              writeJson(FILES.customerInfo, infos.filter(i => i.order_id !== stubId));
            }
            stubStatus = 'skipped:vendor';
          }
          results.updated++;
          results.details.push({ index: idx, order_id: orderId, status: 'updated', stub: stubStatus });
          continue;
        }
        // 기본 (overwrite=false): 기존 유지, stub 만 backfill.
        let stubStatus = 'exists';
        if (!_needsCollectStub(existing) || !_needsCollectStub(data)) stubStatus = 'skipped:vendor';
        else {
          try { stubStatus = await _ensureStubForManualOrder({ ...existing, _desired_ship_date: data._desired_ship_date, _customer_request: data._customer_request }, { stickerMap }); }
          catch (e) { stubStatus = 'error'; }
        }
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
      //   위탁 주문은 주문수집 대상이 아니라 stub 을 만들지 않는다 (076).
      const stubStatus = _needsCollectStub(data)
        ? await _ensureStubForManualOrder(data, { stickerMap })
        : 'skipped:vendor';
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
    'vendor_name',
  ];
  for (const k of allowed) { if (k in data) patch[k] = data[k]; }
  if ('settle_price' in patch) patch.settle_price = Math.max(0, parseInt(patch.settle_price, 10) || 0);
  if ('status_seq' in patch) patch.status_seq = parseInt(patch.status_seq, 10) || 4;
  if ('items' in patch && !Array.isArray(patch.items)) patch.items = [];
  patch.updated_at = now();

  if (USE_SUPABASE) return _withVendorColumnFallback(patch, p => sbUpdate('bg_manual_orders', `order_id=eq.${encodeURIComponent(orderId)}`, p));
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

// ============================================
// bg_site_settings — 사이트 공통 설정 (id=1 singleton). Migration 036.
// ============================================
async function getSiteSettings() {
  if (!USE_SUPABASE) {
    // 로컬 파일 폴백 — 개발 편의성만, 프로덕션은 Supabase 사용.
    return { id: 1, custom_guide_title: null, custom_guide_text: null };
  }
  try {
    const rows = await sbGet('bg_site_settings', 'id=eq.1&limit=1');
    if (rows.length) return rows[0];
    // migration 036 INSERT 가 누락된 경우 — 즉시 삽입 시도
    await sbInsert('bg_site_settings', { id: 1 });
    return { id: 1, custom_guide_title: null, custom_guide_text: null };
  } catch (e) {
    console.warn('[getSiteSettings] 실패 (기본값 반환):', e.message);
    return { id: 1, custom_guide_title: null, custom_guide_text: null };
  }
}

/**
 * 슬랙 알림 메시지 구성 (074) — 기본값 = 지금까지의 하드코딩 동작 그대로.
 *   A안(항목 켜기/끄기 + 순서)이라 값 공간이 닫혀 있다. 여기서 전부 검증해 저장하므로
 *   발송 쪽(stock-alert)은 형태를 다시 의심하지 않아도 된다.
 */
const ALERT_FORMAT_DEFAULT = {
  summary: { counts: true, attention: true, attention_limit: 0 },
  sections: { order: ['soldout', 'warn', 'ok'], soldout: true, warn: true, ok: true, group_by_kind: true },
  item: { available: true, consume_30d: true, daily_avg: true, threshold: true, sales_30d: false, code: true },
  sort: 'days',
};

function normAlertFormat(src) {
  if (src == null) return null;                       // null = 기본 구성으로 되돌리기
  const d = ALERT_FORMAT_DEFAULT;
  const bool = (v, def) => (typeof v === 'boolean' ? v : def);
  const out = {
    summary: {
      counts: bool(src?.summary?.counts, d.summary.counts),
      attention: bool(src?.summary?.attention, d.summary.attention),
      attention_limit: Math.min(Math.max(parseInt(src?.summary?.attention_limit, 10) || 0, 0), 50),
    },
    sections: {
      order: (Array.isArray(src?.sections?.order) ? src.sections.order : d.sections.order)
        .filter(k => ['soldout', 'warn', 'ok'].includes(k)),
      soldout: bool(src?.sections?.soldout, true),
      warn: bool(src?.sections?.warn, true),
      ok: bool(src?.sections?.ok, true),
      group_by_kind: bool(src?.sections?.group_by_kind, true),
    },
    item: Object.fromEntries(Object.keys(d.item)
      .map(k => [k, bool(src?.item?.[k], d.item[k])])),
    sort: ['days', 'qty', 'name'].includes(src?.sort) ? src.sort : 'days',
  };
  // 순서에서 빠진 섹션은 뒤에 붙인다 — 순서 배열이 곧 켜짐/꺼짐이 되면 헷갈린다 (별도 플래그)
  for (const k of ['soldout', 'warn', 'ok']) {
    if (!out.sections.order.includes(k)) out.sections.order.push(k);
  }
  return out;
}

async function updateSiteSettings(patch, updatedBy = null) {
  if (!USE_SUPABASE) throw new Error('Supabase 미설정 — 사이트 설정 저장 불가');
  const allowed = ['custom_guide_title', 'custom_guide_text',
                   'stock_alert_channel', 'stock_alert_time'];   // migration 049
  const clean = {};
  for (const k of allowed) if (k in patch) clean[k] = patch[k] == null ? null : String(patch[k]);
  // boolean 은 문자열 변환하면 안 됨
  if ('stock_alert_enabled' in patch) {
    clean.stock_alert_enabled = patch.stock_alert_enabled == null ? null : !!patch.stock_alert_enabled;
  }
  // 메시지 구성 (074) — 모르는 키·이상값은 버린다. 잘못 저장돼도 발송이 깨지면 안 된다.
  if ('stock_alert_format' in patch) {
    clean.stock_alert_format = normAlertFormat(patch.stock_alert_format);
  }
  // 구분별 경고 기준일 (073) — JSONB. 키는 ITEM_KINDS 만, 값은 1~365 정수만 남긴다.
  if ('stock_alert_warn_days' in patch) {
    const src = patch.stock_alert_warn_days;
    if (src == null) clean.stock_alert_warn_days = null;
    else {
      const out = {};
      for (const k of ITEM_KINDS) {
        const n = parseInt(src[k], 10);
        if (Number.isFinite(n) && n >= 1 && n <= 365) out[k] = n;
      }
      clean.stock_alert_warn_days = Object.keys(out).length ? out : null;
    }
  }
  clean.updated_at = new Date().toISOString();
  if (updatedBy) clean.updated_by = updatedBy;
  try {
    const updated = await sbUpdate('bg_site_settings', 'id=eq.1', clean);
    if (updated) return updated;
    // row 없으면 INSERT
    return sbInsert('bg_site_settings', { id: 1, ...clean });
  } catch (err) {
    // 073/074 마이그레이션 전에는 새 컬럼이 없어 PGRST204 가 난다. 그 컬럼만 빼고
    // 다시 저장한다 — 새 기능 하나 때문에 채널·시각 저장까지 막히면 안 된다.
    const m = /Could not find the '([a-z_]+)' column/.exec(err.message || '');
    if (m && ['stock_alert_format', 'stock_alert_warn_days'].includes(m[1]) && m[1] in clean) {
      delete clean[m[1]];
      const retried = Object.keys(clean).some(k => !['updated_at', 'updated_by'].includes(k))
        ? ((await sbUpdate('bg_site_settings', 'id=eq.1', clean)) || (await sbInsert('bg_site_settings', { id: 1, ...clean })))
        : { id: 1 };
      return { ...retried, _skipped_column: m[1],
        _warning: `${m[1]} 컬럼이 아직 없습니다 — 해당 설정은 저장되지 않았습니다. supabase/migrations/${m[1] === 'stock_alert_format' ? '074' : '073'}_*.sql 을 실행하세요.` };
    }
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────
// 매출 데이터 그룹 (migration 040)
//   상품 단위 설정이 아니라 "매출 행"을 그룹에 담는 방식.
//   멤버 = (site_name, match_type 'code'|'name', match_value).
//   site_name '' = 전체 사이트. 마켓(코드 없음)은 site + name 으로 지정.
// ─────────────────────────────────────────────────────────────

/** 그룹 + 멤버 목록. 반환: [{ id, name, category, memo, members: [...] }] */
async function listSalesGroups({ category = null } = {}) {
  let groups, members;
  if (USE_SUPABASE) {
    const gFilter = (category ? `category=eq.${encodeURIComponent(category)}&` : '') + 'order=name.asc';
    groups = await sbGet('bg_sales_groups', gFilter);
    members = await sbGet('bg_sales_group_members', 'order=created_at.asc&limit=5000');
  } else {
    groups = readJson(FILES.salesGroups, []);
    if (category) groups = groups.filter(g => (g.category || 'daeryepum') === category);
    members = readJson(FILES.salesGroupMembers, []);
  }
  const byGroup = new Map();
  (members || []).forEach(m => {
    if (!byGroup.has(m.group_id)) byGroup.set(m.group_id, []);
    byGroup.get(m.group_id).push(m);
  });
  return (groups || []).map(g => ({ ...g, members: byGroup.get(g.id) || [] }));
}

async function createSalesGroup(data) {
  const name = String(data?.name || '').trim();
  if (!name) throw new Error('그룹명은 필수입니다');
  const payload = {
    name,
    category: String(data.category || 'daeryepum'),
    memo: data.memo || null,
    created_by: data.created_by || null,
  };
  if (USE_SUPABASE) return sbInsert('bg_sales_groups', payload);
  const list = readJson(FILES.salesGroups, []);
  if (list.some(g => g.name === name && (g.category || 'daeryepum') === payload.category)) {
    throw new Error('이미 존재하는 그룹명입니다');
  }
  const local = { id: uuid(), ...payload, created_at: now(), updated_at: now() };
  list.push(local);
  writeJson(FILES.salesGroups, list);
  return local;
}

async function updateSalesGroup(id, data) {
  if (!id) throw new Error('id 필수');
  const patch = {};
  if (data.name !== undefined) {
    const nm = String(data.name).trim();
    if (!nm) throw new Error('그룹명은 비울 수 없습니다');
    patch.name = nm;
  }
  if (data.memo !== undefined) patch.memo = data.memo || null;
  patch.updated_at = now();
  if (USE_SUPABASE) return sbUpdate('bg_sales_groups', `id=eq.${encodeURIComponent(id)}`, patch);
  const list = readJson(FILES.salesGroups, []);
  const idx = list.findIndex(g => g.id === id);
  if (idx < 0) throw new Error('그룹을 찾을 수 없습니다');
  list[idx] = { ...list[idx], ...patch };
  writeJson(FILES.salesGroups, list);
  return list[idx];
}

/** 그룹 삭제 — 멤버도 함께 제거 (Supabase 는 FK ON DELETE CASCADE). */
async function deleteSalesGroup(id) {
  if (!id) throw new Error('id 필수');
  if (USE_SUPABASE) {
    await sbDelete('bg_sales_groups', `id=eq.${encodeURIComponent(id)}`);
    return { ok: true };
  }
  writeJson(FILES.salesGroups, readJson(FILES.salesGroups, []).filter(g => g.id !== id));
  writeJson(FILES.salesGroupMembers, readJson(FILES.salesGroupMembers, []).filter(m => m.group_id !== id));
  return { ok: true };
}

/**
 * 멤버 추가 (bulk). 이미 다른 그룹에 속한 (site,type,value) 는 그 그룹에서 옮겨온다
 *   — UNIQUE(site_name, match_type, match_value) 제약과 일치시키기 위해 선삭제 후 삽입.
 * members: [{ site_name, match_type, match_value, label }]
 */
async function addSalesGroupMembers(groupId, members, createdBy = null) {
  if (!groupId) throw new Error('group_id 필수');
  const rows = (Array.isArray(members) ? members : [])
    .map(m => ({
      group_id: groupId,
      site_name: String(m.site_name ?? '').trim(),
      match_type: m.match_type === 'name' ? 'name' : 'code',
      match_value: String(m.match_value ?? '').trim(),
      label: m.label ? String(m.label) : null,
      created_by: createdBy,
    }))
    .filter(m => m.match_value);
  if (!rows.length) return [];
  // 중복 제거 (같은 요청 안에서)
  const seen = new Set();
  const uniq = rows.filter(r => {
    const k = `${r.site_name}|${r.match_type}|${r.match_value}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (USE_SUPABASE) {
    // 기존 소속 제거 후 삽입 (그룹 이동 허용)
    for (const r of uniq) {
      const f = `site_name=eq.${encodeURIComponent(r.site_name)}`
        + `&match_type=eq.${encodeURIComponent(r.match_type)}`
        + `&match_value=eq.${encodeURIComponent(r.match_value)}`;
      try { await sbDelete('bg_sales_group_members', f); } catch { /* 없으면 무시 */ }
    }
    return sbInsert('bg_sales_group_members', uniq);
  }
  const list = readJson(FILES.salesGroupMembers, [])
    .filter(m => !uniq.some(r => r.site_name === (m.site_name || '') && r.match_type === m.match_type && r.match_value === m.match_value));
  const added = uniq.map(r => ({ id: uuid(), ...r, created_at: now() }));
  writeJson(FILES.salesGroupMembers, list.concat(added));
  return added;
}

async function removeSalesGroupMember(memberId) {
  if (!memberId) throw new Error('member id 필수');
  if (USE_SUPABASE) {
    await sbDelete('bg_sales_group_members', `id=eq.${encodeURIComponent(memberId)}`);
    return { ok: true };
  }
  writeJson(FILES.salesGroupMembers, readJson(FILES.salesGroupMembers, []).filter(m => m.id !== memberId));
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────
// 매뉴얼 위키 (migration 041) — 최신 revision = 현재 문서, 저장할 때마다 히스토리 추가
// ─────────────────────────────────────────────────────────────

/** 현재 문서 (최신 revision). 없으면 null — 프론트가 기본 manual.html 내용 사용. */
async function getWikiCurrent(slug) {
  if (!USE_SUPABASE) throw new Error('Supabase 미설정');
  const rows = await sbGet('bg_wiki_revisions',
    `slug=eq.${encodeURIComponent(slug)}&order=created_at.desc&limit=1`);
  return rows[0] || null;
}

/** revision 저장 (= 문서 갱신). */
async function saveWikiRevision(slug, content, { note = null, created_by = null } = {}) {
  if (!USE_SUPABASE) throw new Error('Supabase 미설정');
  const body = String(content ?? '');
  if (!body.trim()) throw new Error('내용이 비어 있습니다');
  if (body.length > 2_000_000) throw new Error('내용이 너무 큽니다 (2MB 초과)');
  return sbInsert('bg_wiki_revisions', { slug, content: body, note: note || null, created_by });
}

/** 히스토리 목록 (content 제외 — 목록 경량화). */
async function listWikiRevisions(slug, { limit = 100 } = {}) {
  if (!USE_SUPABASE) throw new Error('Supabase 미설정');
  return sbGet('bg_wiki_revisions',
    `slug=eq.${encodeURIComponent(slug)}&select=id,note,created_by,created_at&order=created_at.desc&limit=${Math.min(500, limit)}`);
}

/** 특정 revision 전체 (content 포함) — 미리보기/복원용. */
async function getWikiRevision(id) {
  if (!USE_SUPABASE) throw new Error('Supabase 미설정');
  const rows = await sbGet('bg_wiki_revisions', `id=eq.${encodeURIComponent(id)}`);
  return rows[0] || null;
}

// ─────────────────────────────────────────────────────────────
// 답례품 매출 제외 목록 (migration 042)
//   매칭 규칙은 매출 그룹 멤버와 동일: (site_name, 'code'|'name', match_value)
// ─────────────────────────────────────────────────────────────

async function listSalesExclusions() {
  if (USE_SUPABASE) return sbGet('bg_sales_exclusions', 'order=created_at.desc&limit=1000');
  return readJson(FILES.salesExclusions, []);
}

/** 제외 항목 추가 (bulk). 이미 있으면 무시(멱등). */
async function addSalesExclusions(items, createdBy = null, reason = null) {
  const rows = (Array.isArray(items) ? items : [])
    .map(m => ({
      site_name: String(m.site_name ?? '').trim(),
      match_type: m.match_type === 'name' ? 'name' : 'code',
      match_value: String(m.match_value ?? '').trim(),
      label: m.label ? String(m.label) : null,
      reason: m.reason || reason || null,
      created_by: createdBy,
    }))
    .filter(m => m.match_value);
  if (!rows.length) return [];
  const seen = new Set();
  const uniq = rows.filter(r => {
    const k = `${r.site_name}|${r.match_type}|${r.match_value}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (USE_SUPABASE) {
    // 중복은 무시하고 삽입 (UNIQUE 충돌 시 merge-duplicates)
    const res = await fetch(`${REST_BASE}/bg_sales_exclusions?on_conflict=site_name,match_type,match_value`, {
      method: 'POST',
      headers: { ...HEADERS, Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify(uniq),
    });
    if (!res.ok) throw new Error(`Supabase INSERT bg_sales_exclusions [${res.status}]: ${await res.text()}`);
    return res.json();
  }
  const list = readJson(FILES.salesExclusions, [])
    .filter(m => !uniq.some(r => r.site_name === (m.site_name || '') && r.match_type === m.match_type && r.match_value === m.match_value));
  const added = uniq.map(r => ({ id: uuid(), ...r, created_at: now() }));
  writeJson(FILES.salesExclusions, list.concat(added));
  return added;
}

async function removeSalesExclusion(id) {
  if (!id) throw new Error('id 필수');
  if (USE_SUPABASE) {
    await sbDelete('bg_sales_exclusions', `id=eq.${encodeURIComponent(id)}`);
    return { ok: true };
  }
  writeJson(FILES.salesExclusions, readJson(FILES.salesExclusions, []).filter(m => m.id !== id));
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────
// 재고 관리 품목 (migration 044)
//   재고 화면과 슬랙 알림이 함께 쓰는 유일한 대상 목록.
//   product_code = 매출 집계 기준 / stock_code = 재고 조회 기준 (비면 product_code).
//   품목별로 재고가 CARD_CODE 쪽에 잡히기도 CARD_CODE_ERP 쪽에 잡히기도 해서 분리했다.
// ─────────────────────────────────────────────────────────────

async function listStockItems({ enabledOnly = false, alertOnly = false } = {}) {
  let rows;
  if (USE_SUPABASE) {
    rows = await sbGet('bg_stock_items', 'order=sort_order.asc,created_at.asc&limit=1000');
  } else {
    rows = readJson(FILES.stockItems, [])
      .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  }
  if (enabledOnly || alertOnly) rows = rows.filter(r => r.enabled !== false);
  if (alertOnly) rows = rows.filter(r => r.alert_enabled !== false);
  return rows;
}

/** 'A, B ,C' → 'A,B,C' (빈 항목·중복 제거) */
function _normCodeList(v) {
  const list = String(v ?? '').split(',').map(s => s.trim()).filter(Boolean);
  return [...new Set(list)].join(',') || null;
}

// 소진코드(consumption_codes) 는 050 에서 폐기됐다. 구성·소요수량은 bg_stock_bom 이
//   유일한 기준이며, 재고품목에는 더 이상 같은 의미의 필드를 두지 않는다.

/**
 * 품목 구분 (073) — product=원물 / material=부자재 / package=포장재 / set=세트 / etc=기타.
 *   BOM 의 component_role 과 같은 값 체계를 쓴다. 값이 없거나 이상하면 코드 접미로 추정한다
 *   ('O' 계열은 원물) — 화면·마이그레이션과 같은 규칙.
 */
// 'set'(세트) 는 품목 구분에만 있다 — 완성 묶음 자체가 재고인 품목. BOM 구성품 역할로는 안 쓴다.
const ITEM_KINDS = ['product', 'material', 'package', 'set', 'etc'];
function _normItemKind(v, stockCode) {
  const s = String(v || '').trim();
  if (ITEM_KINDS.includes(s)) return s;
  return /^[A-Z]+\d+O/i.test(String(stockCode || '')) ? 'product' : 'material';
}

function _normStockItem(m, createdBy) {
  return {
    stock_code: String(m.stock_code ?? '').trim(),
    sales_codes: _normCodeList(m.sales_codes),
    item_kind: _normItemKind(m.item_kind, m.stock_code),
    label: m.label ? String(m.label) : null,
    threshold: (m.threshold === '' || m.threshold == null) ? null : Math.max(0, parseInt(m.threshold, 10) || 0),
    sort_order: parseInt(m.sort_order, 10) || 0,
    enabled: m.enabled === false ? false : true,
    alert_enabled: m.alert_enabled === false ? false : true,
    memo: m.memo ? String(m.memo) : null,
    created_by: createdBy,
  };
}

/** 품목 등록 (bulk upsert). stock_code 중복은 갱신. */
async function addStockItems(items, createdBy = null) {
  const rows = (Array.isArray(items) ? items : [])
    .map(m => _normStockItem(m, createdBy))
    .filter(m => m.stock_code);
  if (!rows.length) return [];
  const seen = new Set();
  const uniq = rows.filter(r => {
    if (seen.has(r.stock_code)) return false;
    seen.add(r.stock_code);
    return true;
  });
  if (USE_SUPABASE) {
    const res = await fetch(`${REST_BASE}/bg_stock_items?on_conflict=stock_code`, {
      method: 'POST',
      headers: { ...HEADERS, Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify(uniq),
    });
    if (!res.ok) throw new Error(`Supabase INSERT bg_stock_items [${res.status}]: ${await res.text()}`);
    return res.json();
  }
  const list = readJson(FILES.stockItems, []).filter(m => !seen.has(m.stock_code));
  const added = uniq.map(r => ({ id: uuid(), ...r, created_at: now(), updated_at: now() }));
  writeJson(FILES.stockItems, list.concat(added));
  return added;
}

async function updateStockItem(id, data) {
  if (!id) throw new Error('id 필수');
  const patch = { updated_at: now() };
  if ('threshold' in data) patch.threshold = (data.threshold === '' || data.threshold == null) ? null : Math.max(0, parseInt(data.threshold, 10) || 0);
  if ('enabled' in data) patch.enabled = !!data.enabled;
  if ('alert_enabled' in data) patch.alert_enabled = !!data.alert_enabled;
  if ('sort_order' in data) patch.sort_order = parseInt(data.sort_order, 10) || 0;
  if ('label' in data) patch.label = data.label ? String(data.label) : null;
  if ('memo' in data) patch.memo = data.memo ? String(data.memo) : null;
  if ('sales_codes' in data) patch.sales_codes = _normCodeList(data.sales_codes);
  if ('item_kind' in data) {
    const k = String(data.item_kind || '').trim();
    if (!ITEM_KINDS.includes(k)) throw new Error(`구분은 ${ITEM_KINDS.join('/')} 중 하나여야 합니다`);
    patch.item_kind = k;
  }
  if ('stock_code' in data) {
    const s = String(data.stock_code ?? '').trim();
    if (!s) throw new Error('재고코드는 비울 수 없습니다');
    patch.stock_code = s;
  }
  // sbUpdate 는 이미 행 객체(또는 null)를 반환한다 — 배열로 취급해 [0] 을 또 꺼내면
  // 성공해도 undefined 가 되어 API 가 404 'not found' 를 돌려준다 (2026-08-05 수정).
  if (USE_SUPABASE) {
    try {
      return await sbUpdate('bg_stock_items', `id=eq.${encodeURIComponent(id)}`, patch);
    } catch (err) {
      // stock_code UNIQUE 충돌 — 원문(23505 …) 대신 무엇을 해야 하는지 알려준다.
      if (/duplicate key|23505/i.test(err.message || '')) {
        throw new Error(`재고코드 '${patch.stock_code}' 는 이미 다른 품목에 등록돼 있습니다.`);
      }
      throw err;
    }
  }
  // 파일 폴백에서도 UNIQUE 동작을 맞춘다 (개발/운영 동작 불일치 방지)
  if (patch.stock_code) {
    const dup = readJson(FILES.stockItems, [])
      .find(m => m.id !== id && m.stock_code === patch.stock_code);
    if (dup) throw new Error(`재고코드 '${patch.stock_code}' 는 이미 다른 품목에 등록돼 있습니다.`);
  }
  const list = readJson(FILES.stockItems, []);
  const idx = list.findIndex(m => m.id === id);
  if (idx < 0) return null;
  list[idx] = { ...list[idx], ...patch };
  writeJson(FILES.stockItems, list);
  return list[idx];
}

async function removeStockItem(id) {
  if (!id) throw new Error('id 필수');
  if (USE_SUPABASE) {
    await sbDelete('bg_stock_items', `id=eq.${encodeURIComponent(id)}`);
    return { ok: true };
  }
  writeJson(FILES.stockItems, readJson(FILES.stockItems, []).filter(m => m.id !== id));
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────
// BOM (migration 048 → 050 재구성) — 판매상품 1개의 구성품 목록
//   parent_code    판매가 일어나는 품목코드
//   component_code 구성품 코드. 재고관리 품목이 아니어도 등록할 수 있다 (부자재/포장재).
//   component_role product=원물 / material=부자재 / package=포장재 / etc=기타
// ─────────────────────────────────────────────────────────────

const BOM_ROLES = ['product', 'material', 'package', 'etc'];
const _normRole = v => (BOM_ROLES.includes(String(v || '').trim()) ? String(v).trim() : 'material');

async function listBomRows() {
  if (USE_SUPABASE) return sbGet('bg_stock_bom', 'order=parent_code.asc,component_code.asc&limit=5000');
  return readJson(FILES.stockBom, [])
    .sort((a, b) => String(a.parent_code).localeCompare(String(b.parent_code))
      || String(a.component_code).localeCompare(String(b.component_code)));
}

/** BOM 행 일괄 등록 — (parent_code, component_code) 중복은 갱신 */
async function addBomRows(rows, createdBy = null) {
  const norm = (Array.isArray(rows) ? rows : []).map(r => {
    const parent = String(r.parent_code ?? '').trim();
    return {
      parent_code: parent,
      // group_key 미지정이면 판매코드 자신 — 052 이전과 같은 '1그룹 1판매코드' 동작
      group_key: String(r.group_key ?? '').trim() || parent,
      component_code: String(r.component_code ?? '').trim(),
      qty: Math.max(1, parseInt(r.qty, 10) || 1),
      component_role: _normRole(r.component_role),
      memo: r.memo ? String(r.memo) : null,
      created_by: createdBy,
    };
  }).filter(r => r.parent_code && r.component_code);
  if (!norm.length) return [];
  const seen = new Set();
  const uniq = norm.filter(r => {
    const k = `${r.parent_code}|${r.component_code}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (USE_SUPABASE) {
    const res = await fetch(`${REST_BASE}/bg_stock_bom?on_conflict=parent_code,component_code`, {
      method: 'POST',
      headers: { ...HEADERS, Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify(uniq),
    });
    if (!res.ok) throw new Error(`Supabase INSERT bg_stock_bom [${res.status}]: ${await res.text()}`);
    return res.json();
  }
  const list = readJson(FILES.stockBom, [])
    .filter(m => !seen.has(`${m.parent_code}|${m.component_code}`));
  const added = uniq.map(r => ({ id: uuid(), ...r, created_at: now(), updated_at: now() }));
  writeJson(FILES.stockBom, list.concat(added));
  return added;
}

/**
 * BOM 그룹 통째 저장 (생성/수정) — 052.
 *   판매코드 N개 × 구성품 M개 를 N×M 행으로 펼쳐 넣는다.
 *   수정은 "그 group_key 의 기존 행을 지우고 다시 넣는" 방식이라
 *   판매코드·구성품을 빼는 것도 그대로 반영된다.
 */
async function saveBomGroup({ group_key, parent_codes, components }, createdBy = null) {
  const key = String(group_key ?? '').trim();
  if (!key) throw new Error('그룹 키가 없습니다');
  const parents = [...new Set((Array.isArray(parent_codes) ? parent_codes : [])
    .map(c => String(c ?? '').trim()).filter(Boolean))];
  if (!parents.length) throw new Error('판매코드를 1개 이상 입력하세요');
  const comps = [];
  const seenComp = new Set();
  for (const c of (Array.isArray(components) ? components : [])) {
    const code = String(c?.component_code ?? '').trim();
    if (!code || seenComp.has(code)) continue;
    seenComp.add(code);
    comps.push({
      component_code: code,
      qty: Math.max(1, parseInt(c?.qty, 10) || 1),
      component_role: _normRole(c?.component_role),
    });
  }
  if (!comps.length) throw new Error('구성품을 1개 이상 입력하세요');

  const rows = [];
  for (const p of parents) {
    for (const c of comps) {
      rows.push({ parent_code: p, group_key: key, ...c, memo: null, created_by: createdBy });
    }
  }
  await deleteBomGroup(key);
  if (USE_SUPABASE) {
    const res = await fetch(`${REST_BASE}/bg_stock_bom?on_conflict=parent_code,component_code`, {
      method: 'POST',
      headers: { ...HEADERS, Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify(rows),
    });
    if (!res.ok) throw new Error(`Supabase INSERT bg_stock_bom [${res.status}]: ${await res.text()}`);
    return res.json();
  }
  const list = readJson(FILES.stockBom, []);
  const added = rows.map(r => ({ id: uuid(), ...r, created_at: now(), updated_at: now() }));
  writeJson(FILES.stockBom, list.concat(added));
  return added;
}

async function deleteBomGroup(groupKey) {
  const key = String(groupKey ?? '').trim();
  if (!key) throw new Error('그룹 키가 없습니다');
  if (USE_SUPABASE) {
    await sbDelete('bg_stock_bom', `group_key=eq.${encodeURIComponent(key)}`);
    return { ok: true };
  }
  writeJson(FILES.stockBom, readJson(FILES.stockBom, []).filter(r => (r.group_key || r.parent_code) !== key));
  return { ok: true };
}

async function updateBomRow(id, data) {
  if (!id) throw new Error('id 필수');
  const patch = { updated_at: now() };
  if ('qty' in data) patch.qty = Math.max(1, parseInt(data.qty, 10) || 1);
  if ('memo' in data) patch.memo = data.memo ? String(data.memo) : null;
  if ('component_role' in data) patch.component_role = _normRole(data.component_role);
  if ('component_code' in data) {
    const c = String(data.component_code ?? '').trim();
    if (!c) throw new Error('구성품 코드는 비울 수 없습니다');
    patch.component_code = c;
  }
  if (USE_SUPABASE) return sbUpdate('bg_stock_bom', `id=eq.${encodeURIComponent(id)}`, patch);
  const list = readJson(FILES.stockBom, []);
  const idx = list.findIndex(m => m.id === id);
  if (idx < 0) return null;
  list[idx] = { ...list[idx], ...patch };
  writeJson(FILES.stockBom, list);
  return list[idx];
}

async function removeBomRow(id) {
  if (!id) throw new Error('id 필수');
  if (USE_SUPABASE) {
    await sbDelete('bg_stock_bom', `id=eq.${encodeURIComponent(id)}`);
    return { ok: true };
  }
  writeJson(FILES.stockBom, readJson(FILES.stockBom, []).filter(m => m.id !== id));
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────
// 사고건 (migration 051) — 운영사고 / 기타출고
//   기타출고는 실제로 나간 품목·수량을 items 에 담는다 (물류·재무의 매출 처리 근거).
//   한 주문에 사고가 여러 번 날 수 있어 주문 1 : 사고 N.
// ─────────────────────────────────────────────────────────────

const INCIDENT_TYPES = ['shortage', 'damage', 'omission', 'other'];
const INCIDENT_DISPOSITIONS = ['operation', 'extra_shipment'];

/** items 정규화 — 코드 없는 줄·수량 0 이하는 버린다. 같은 코드는 수량을 합친다. */
function _normIncidentItems(v) {
  const merged = new Map();
  for (const raw of (Array.isArray(v) ? v : [])) {
    const code = String(raw?.product_code ?? '').trim();
    const qty = parseInt(raw?.quantity, 10);
    if (!code || !(qty > 0)) continue;
    const prev = merged.get(code);
    if (prev) prev.quantity += qty;
    else merged.set(code, {
      product_code: code,
      product_name: raw?.product_name ? String(raw.product_name) : null,
      quantity: qty,
    });
  }
  return [...merged.values()];
}

function _normIncident(data, createdBy) {
  const type = INCIDENT_TYPES.includes(data?.incident_type) ? data.incident_type : 'other';
  const disp = INCIDENT_DISPOSITIONS.includes(data?.disposition) ? data.disposition : 'operation';
  const items = _normIncidentItems(data?.items);
  // 운영사고는 실제 출고가 없다 — 품목이 딸려와도 버려서 매출 근거로 새지 않게 한다.
  return {
    order_id: String(data?.order_id ?? '').trim(),
    category: String(data?.category || 'daeryepum'),
    incident_type: type,
    disposition: disp,
    reason: data?.reason ? String(data.reason).trim() || null : null,
    items: disp === 'extra_shipment' ? items : [],
    recv_name: data?.recv_name ? String(data.recv_name) : null,
    order_date: data?.order_date || null,
    created_by: createdBy || null,
  };
}

async function listIncidents({ category = 'daeryepum', orderId = null } = {}) {
  if (USE_SUPABASE) {
    const f = [`category=eq.${encodeURIComponent(category)}`, 'order=created_at.desc', 'limit=5000'];
    if (orderId) f.unshift(`order_id=eq.${encodeURIComponent(orderId)}`);
    return sbGet('bg_incidents', f.join('&'));
  }
  let rows = readJson(FILES.incidents, []).filter(r => (r.category || 'daeryepum') === category);
  if (orderId) rows = rows.filter(r => r.order_id === orderId);
  return rows.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
}

async function getIncident(id) {
  if (!id) return null;
  if (USE_SUPABASE) {
    const rows = await sbGet('bg_incidents', `id=eq.${encodeURIComponent(id)}`);
    return (rows && rows[0]) || null;
  }
  return readJson(FILES.incidents, []).find(r => r.id === id) || null;
}

async function createIncident(data, createdBy = null) {
  const payload = _normIncident(data, createdBy);
  if (!payload.order_id) throw new Error('주문번호는 필수입니다');
  if (payload.disposition === 'extra_shipment' && !payload.items.length) {
    throw new Error('기타출고는 실제 출고된 품목과 수량을 입력해야 합니다');
  }
  if (USE_SUPABASE) return sbInsert('bg_incidents', payload);
  const list = readJson(FILES.incidents, []);
  const row = { id: uuid(), ...payload, created_at: now(), updated_at: now() };
  list.push(row);
  writeJson(FILES.incidents, list);
  return row;
}

async function updateIncident(id, data) {
  if (!id) throw new Error('id 필수');
  const patch = { updated_at: now() };
  if ('incident_type' in data) {
    patch.incident_type = INCIDENT_TYPES.includes(data.incident_type) ? data.incident_type : 'other';
  }
  if ('reason' in data) patch.reason = data.reason ? String(data.reason).trim() || null : null;
  // disposition 과 items 는 함께 판단해야 한다 — 운영사고로 바꾸면 품목을 비운다.
  if ('disposition' in data || 'items' in data) {
    const cur = await getIncident(id);
    const disp = 'disposition' in data
      ? (INCIDENT_DISPOSITIONS.includes(data.disposition) ? data.disposition : 'operation')
      : (cur?.disposition || 'operation');
    const items = 'items' in data ? _normIncidentItems(data.items) : _normIncidentItems(cur?.items);
    if (disp === 'extra_shipment' && !items.length) {
      throw new Error('기타출고는 실제 출고된 품목과 수량을 입력해야 합니다');
    }
    patch.disposition = disp;
    patch.items = disp === 'extra_shipment' ? items : [];
  }
  if (USE_SUPABASE) return sbUpdate('bg_incidents', `id=eq.${encodeURIComponent(id)}`, patch);
  const list = readJson(FILES.incidents, []);
  const idx = list.findIndex(r => r.id === id);
  if (idx < 0) return null;
  list[idx] = { ...list[idx], ...patch };
  writeJson(FILES.incidents, list);
  return list[idx];
}

async function deleteIncident(id) {
  if (!id) throw new Error('id 필수');
  if (USE_SUPABASE) {
    await sbDelete('bg_incidents', `id=eq.${encodeURIComponent(id)}`);
    return { ok: true };
  }
  writeJson(FILES.incidents, readJson(FILES.incidents, []).filter(r => r.id !== id));
  return { ok: true };
}

module.exports = {
  INCIDENT_TYPES,
  INCIDENT_DISPOSITIONS,
  listIncidents,
  getIncident,
  createIncident,
  updateIncident,
  deleteIncident,
  BOM_ROLES,
  ALERT_FORMAT_DEFAULT,
  normAlertFormat,
  ITEM_KINDS,
  listBomRows,
  addBomRows,
  saveBomGroup,
  deleteBomGroup,
  updateBomRow,
  removeBomRow,
  listStockItems,
  addStockItems,
  updateStockItem,
  removeStockItem,
  listSalesExclusions,
  addSalesExclusions,
  removeSalesExclusion,
  getWikiCurrent,
  saveWikiRevision,
  listWikiRevisions,
  getWikiRevision,
  getAllStickers,
  getStickerById,
  createSticker,
  updateSticker,
  deleteSticker,
  PRODUCT_CHANNELS,
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
  listProcessedShipDateBefore,
  getCollectedOrderSeqs,
  addCollectedOrderSeqs,
  removeCollectedOrderSeqs,
  getShippingConfig,
  saveShippingConfig,
  getShippingGroups,
  createShippingGroup,
  deleteShippingGroup,
  logAlimtalkSend,
  getSmsSendHistory,
  getAlimtalkHistory,
  // 위탁업체 (Phase 1)
  listSalesGroups,
  createSalesGroup,
  updateSalesGroup,
  deleteSalesGroup,
  addSalesGroupMembers,
  removeSalesGroupMember,
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
  // 사이트 공통 설정 (migration 036)
  getSiteSettings,
  updateSiteSettings,
};
