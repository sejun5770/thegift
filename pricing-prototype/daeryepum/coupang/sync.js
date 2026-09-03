/**
 * 쿠팡 주문 동기화 — Wing API → 정규화 → Supabase upsert.
 *
 * 카테고리 필터: 답례품만 수집 (쿠팡 카테고리 '돌잔치답례품 > 기타답례품').
 *   쿠팡 API 의 displayCategoryCode 또는 sellerProductId 로 식별.
 *   설정: COUPANG_DAERYEPUM_CATEGORY_CODES (콤마 구분 카테고리 코드 리스트)
 *         또는 COUPANG_DAERYEPUM_PRODUCT_IDS (콤마 구분 sellerProductId)
 *   둘 다 비어 있으면 — 일단 전체 수집 (운영팀이 확인 후 필터 추가).
 *
 * 상태 매핑 (status → 한글):
 *   ACCEPT          → 결제완료
 *   INSTRUCT        → 상품준비중
 *   DEPARTURE       → 배송지시
 *   DELIVERING      → 배송중
 *   FINAL_DELIVERY  → 배송완료
 *   NONE_TRACKING   → 배송중(추적불가)
 *   CANCEL          → 주문취소
 *   RETURNS         → 반품
 *
 * 결제수단 (paymentMethod) → 사용자 raw 보존, frontend 에서 라벨.
 */
'use strict';

const api = require('./api');
const store = require('./store');
const bgStore = require('../barungift/store');
const { enrichOrderItem, calcCoupangShipDate } = require('./option-mapper');
const { autoAdvanceNoStickerSelections } = require('../barungift/workflow-store');

// 답례품 카테고리 필터 — env 로 운영 중 추가/제거 가능 (네이버와 명명 규칙 일관)
const CATEGORY_CODES = (process.env.COUPANG_CATEGORY_CODES || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const PRODUCT_IDS = (process.env.COUPANG_PRODUCT_IDS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const FILTER_DISABLED = !CATEGORY_CODES.length && !PRODUCT_IDS.length;

const STATUS_LABEL = {
  ACCEPT: '결제완료',
  INSTRUCT: '상품준비중',
  DEPARTURE: '배송지시',
  DELIVERING: '배송중',
  FINAL_DELIVERY: '배송완료',
  NONE_TRACKING: '배송중(추적불가)',
  CANCEL: '주문취소',
  RETURNS: '반품',
};

/**
 * 상품명에서 세트 수량 추출 — '10세트', '5세트' 등 정수 매칭.
 *   쿠팡 판매단위가 N세트 묶음일 경우 cart 수량 × N = 실제 출고 개수.
 *   매칭 없으면 1 (× 1 → 영향 X). 첫 매칭 사용.
 */
function extractSetSize(name) {
  const m = String(name || '').match(/(\d+)\s*세트/);
  if (!m) return 1;
  const n = parseInt(m[1], 10);
  return n > 0 ? n : 1;
}

/**
 * 한 orderSheet → 정규화된 row 배열 (orderItems 펼침).
 *   분리배송 / 다상품 케이스에서 row 가 여러 개 생성됨.
 *   답례품 카테고리 필터 적용 — 해당 안 되는 row 는 제외.
 */
/**
 * 쿠팡 API 응답 일시 파싱 — 명시적 KST 처리.
 *   쿠팡은 보통 naive 포맷 ("2026-05-14T11:26:00") 반환. Docker UTC 환경에서
 *   new Date(...) 가 UTC 로 잘못 해석 → 9h 어긋난 UTC ISO 저장. 명시적 +09:00 부여.
 *   이미 TZ 마커(+09:00/Z/+00:00 등) 가 있으면 그대로 파싱.
 */
function parseCoupangDate(s) {
  if (!s) return null;
  let str = String(s).trim();
  if (!str) return null;
  // 'YYYY-MM-DD HH:mm:ss' 공백 구분 → ISO 'T' 로 정규화
  if (str.includes(' ') && !str.includes('T')) str = str.replace(' ', 'T');
  // 날짜만 오는 값 (매출인식일 yyyy-MM-dd) → KST 자정
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) str += 'T00:00:00';
  const hasTz = /[+-]\d{2}:?\d{2}$|Z$/i.test(str);
  if (!hasTz) str = str + '+09:00';
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * @param {object} sheet 쿠팡 ordersheet
 * @param {(sellerProductId:string, vendorItemId:string)=>number|null} unitOf
 *   채널 판매단위 조회 (060). 설정값이 있으면 상품명 파싱보다 우선한다 —
 *   이름에 "10세트" 표기가 없거나 형식이 바뀌면 파싱이 조용히 1 로 떨어지기 때문.
 */
function normalizeOrderSheet(sheet, unitOf = null) {
  const orderId = sheet.orderId;
  const shipmentBoxId = sheet.shipmentBoxId;
  const orderedAt = parseCoupangDate(sheet.orderedAt);
  const paidAt = parseCoupangDate(sheet.paidAt);
  const status = sheet.status || 'UNKNOWN';
  const statusLabel = STATUS_LABEL[status] || status;
  const receiver = sheet.receiver || {};
  const items = Array.isArray(sheet.orderItems) ? sheet.orderItems : [];

  return items
    .filter(item => {
      // 카테고리 필터 — env 미설정이면 전체 통과 (초기 운영 진단용)
      if (FILTER_DISABLED) return true;
      const catCode = String(item.displayCategoryCode || '');
      const sellerProductId = String(item.sellerProductId || '');
      if (CATEGORY_CODES.length && CATEGORY_CODES.includes(catCode)) return true;
      if (PRODUCT_IDS.length && PRODUCT_IDS.includes(sellerProductId)) return true;
      return false;
    })
    .map(item => {
      const cartQty = Number(item.shippingCount || item.cancelCount || 0) || 0;
      const unit = Number(item.salesPrice || 0) || 0;
      // 세트 단위 판매 대응 — '10세트' 같은 상품명에서 추출해 실제 출고 개수 산정.
      //   cart_qty(고객 주문 단위) × set_size(세트당 개수) = item_count(실제 개수).
      //   매출(item_total_price)은 unit × cart_qty 그대로 (price 는 set 단가, qty 는 cart 수).
      const productNameForSet = item.vendorItemName || item.sellerProductName || '';
      const configured = unitOf
        ? unitOf(String(item.sellerProductId ?? ''), String(item.vendorItemId ?? ''))
        : null;
      const setSize = configured || extractSetSize(productNameForSet);
      const effectiveCount = cartQty * setSize;
      // 구매확정일자 (080). 확정은 배송완료 뒤에 걸려 동기화 창(7일) 안에서는 대개 비어 있다.
      //   비어 있으면 키 자체를 싣지 않는다 — upsert 가 백필해 둔 값을 null 로 덮어쓰지 않게
      //   (store.upsertCoupangOrders 가 키 집합별로 나눠 올린다).
      const confirmedAt = parseCoupangDate(item.confirmDate);
      return {
        coupang_order_id: orderId,
        shipment_box_id: shipmentBoxId,
        vendor_item_id: item.vendorItemId || null,
        vendor_item_package_id: item.vendorItemPackageId || null,
        ordered_at: orderedAt,
        paid_at: paidAt,
        product_name: item.vendorItemName || item.sellerProductName || '쿠팡 답례품',
        product_code: item.sellerProductId ? String(item.sellerProductId) : null,
        external_vendor_sku: item.externalVendorSku || null,
        // item_count: 실제 출고 개수 (cart × setSize) — 주문조회 '수량' 컬럼이 표시할 값
        item_count: effectiveCount,
        item_sale_price: unit,
        item_total_price: unit * cartQty, // 매출은 set 단가 × cart 수 (변경 없음)
        recv_name: receiver.name || null,
        recv_hphone: receiver.receiverNumber || receiver.safeNumber || null,
        recv_address: [receiver.addr1, receiver.addr2].filter(Boolean).join(' ') || null,
        recv_postal_code: receiver.postCode || null,
        recv_message: sheet.parcelPrintMessage || null,
        settle_price: Number(sheet.payment?.totalPrice || sheet.totalPrice || 0) || 0,
        settle_method: sheet.payment?.paymentMethod || sheet.paymentMethod || null,
        status,
        status_label: statusLabel,
        ...(confirmedAt ? { confirmed_at: confirmedAt } : {}),
        // raw_payload: 진단용 — set_size/cart_qty 보존 (재처리 가능)
        raw_payload: { sheet_keys: Object.keys(sheet), item, _cart_qty: cartQty, _set_size: setSize },
        synced_at: new Date().toISOString(),
      };
    });
}

/**
 * 메인 동기화 함수 — 호출자가 시간 윈도우 지정.
 *   daysBack: 몇일치 가져올지 (기본 7일, 쿠팡 timeFrame 최대 7일 정책)
 *   options.status: 특정 상태만 가져올지 (없으면 전체)
 *
 * 반환: { fetched, upserted, filtered_out, items, error? }
 */
async function syncRecent({ daysBack = 7, status } = {}) {
  if (!api.isConfigured()) {
    const err = 'Coupang API 키 미설정 (COUPANG_VENDOR_ID/ACCESS_KEY/SECRET_KEY)';
    await store.updateSyncState({ last_error: err });
    return { fetched: 0, upserted: 0, filtered_out: 0, error: err };
  }
  if (!store.USE_SUPABASE) {
    const err = 'Supabase 미설정 (SUPABASE_URL/SUPABASE_ANON_KEY)';
    return { fetched: 0, upserted: 0, filtered_out: 0, error: err };
  }
  const endMs = Date.now();
  const startMs = endMs - daysBack * 86400000;
  let res;
  try {
    // status 가 명시되면 그것만, 없으면 ORDER_STATUSES + CANCEL/RETURNS 까지 전체 순회 (dedupe).
    //   CANCEL/RETURNS 도 sync 해야 출고중지·취소·반품 발생 시 답례품 대시보드에서 정확히 인식.
    //   매출 집계 측은 status_label='주문취소'/'반품' 자동 필터 (apiOrders/apiSummary 정책).
    const FULL_STATUSES = [...api.ORDER_STATUSES, 'CANCEL', 'RETURNS'];
    res = await api.listAllOrders({
      startMs, endMs,
      statuses: status ? [status] : FULL_STATUSES,
    });
  } catch (e) {
    await store.updateSyncState({ last_error: e.message, last_synced_at: new Date().toISOString() });
    return { fetched: 0, upserted: 0, filtered_out: 0, error: e.message };
  }
  const sheets = res.items || [];
  // 정규화 + 필터
  // 채널 판매단위 (060) — 상품설정에 지정돼 있으면 상품명 파싱보다 우선.
  //   실패해도 파싱 폴백으로 기존 동작이 유지되도록 조용히 넘어간다.
  let unitOf = null;
  try {
    const settings = await bgStore.getAllProductSettings();
    const byOpt = new Map(), byProd = new Map();
    for (const ps of settings || []) {
      const unit = ps.channel_sales_units?.coupang;
      if (!(unit > 1)) continue;
      const m = ps.channel_product_codes?.coupang;
      if (!m) continue;
      const pIds = Array.isArray(m) ? m : (m.product_ids || []);
      for (const c of pIds) byProd.set(String(c).trim(), unit);
      for (const c of (Array.isArray(m) ? [] : (m.option_ids || []))) byOpt.set(String(c).trim(), unit);
    }
    if (byOpt.size || byProd.size) {
      unitOf = (pid, vid) => byOpt.get(String(vid).trim()) || byProd.get(String(pid).trim()) || null;
    }
  } catch (e) { console.warn('[coupang sync] 판매단위 로드 실패 (상품명 파싱 사용):', e.message); }

  const rows = [];
  let filteredOut = 0;
  for (const sheet of sheets) {
    const itemsBefore = (sheet.orderItems || []).length;
    const normalized = normalizeOrderSheet(sheet, unitOf);
    rows.push(...normalized);
    filteredOut += Math.max(0, itemsBefore - normalized.length);
  }
  // upsert coupang_orders
  let upserted = 0;
  if (rows.length) {
    try {
      const r = await store.upsertCoupangOrders(rows);
      upserted = r.upserted || rows.length;
    } catch (e) {
      await store.updateSyncState({ last_error: e.message, last_synced_at: new Date().toISOString() });
      return { fetched: sheets.length, upserted: 0, filtered_out: filteredOut, error: e.message };
    }
  }

  // 정보입력현황 자동 입력완료 처리 — coupang_order_id 단위로 stub customer_info row 생성.
  //   ignore-duplicates 라 이미 있으면 skip → 수집처리/processed_at 등 보존.
  //   같은 주문(coupang_order_id) 에 여러 row 가 있어도 ci 는 1개.
  //
  // 운영 규칙 enrichment:
  //   - 스티커/박스 = '모델번호' (external_vendor_sku) 로 bg_stickers/bg_product_settings 매칭
  //   - desired_ship_date = ordered_at(KST) 11시 이전 → 당일, 이후 → 익영업일
  let stubUpserted = 0;
  let enrichedCount = 0;
  if (rows.length) {
    try {
      // 참고 데이터 1회 로드
      let stickers = [];
      let productSettings = [];
      try {
        [stickers, productSettings] = await Promise.all([
          bgStore.getAllStickers(true).catch(() => []),
          bgStore.getAllProductSettings().catch(() => []),
        ]);
      } catch (e) {
        console.warn('[coupang sync] 스티커/상품설정 로드 실패 (enrichment 스킵):', e.message);
      }

      // 같은 coupang_order_id 의 row 를 묶어 sticker_selections 누적
      const grouped = new Map(); // order_id → { row, selections[] }
      for (const r of rows) {
        const order_id = `CP-${r.coupang_order_id}`;
        const sel = enrichOrderItem({
          productCode: r.product_code,
          productName: r.product_name,
          quantity: r.item_count,
          modelNo: r.external_vendor_sku, // 쿠팡 셀러센터의 '모델번호'
          optionId: r.vendor_item_id,     // 채널 고정 스티커 조회용 (056/057)
          stickers,
          productSettings,
        });
        if (sel.sticker_code || sel.box_code) enrichedCount++;
        const entry = grouped.get(order_id) || { row: r, selections: [] };
        entry.selections.push(sel);
        grouped.set(order_id, entry);
      }

      const stubs = [];
      for (const [order_id, { row, selections }] of grouped) {
        // 출고일 — ordered_at 기준 11시 컷오프, 토/일 스킵
        const shipDate = calcCoupangShipDate(row.ordered_at);
        // 정책 변경: 정보입력 완료(stub upsert) 시점에 자동 bound 진행 제거.
        //   쿠팡 일반주문도 운영자가 수집처리 시점에 워크플로우 진행하도록 일관 적용.
        const finalSelections = selections;
        stubs.push({
          order_id,
          is_express: false,
          express_fee: 0,
          desired_ship_date: shipDate,
          sticker_selections: finalSelections,
          cash_receipt_yn: false,
          receipt_type: null,
          receipt_number: null,
          customer_request: null,
          submitted_at: row.ordered_at || new Date().toISOString(),
        });
      }
      const r = await store.upsertCoupangStubCustomerInfos(stubs);
      stubUpserted = r.upserted || 0;

      // enrichment PATCH — ignore-duplicates 라 기존 빈 stub 은 위 upsert 로 안 채워짐.
      //   sticker_selections + desired_ship_date 동시 patch.
      //   processed_at / customer_request / express 관련 운영 필드는 미터치.
      //   sticker_code null 인 행도 자동 진행 timestamps 가 있으면 patch (기존 데이터 보정).
      for (const stub of stubs) {
        // 정책 변경: 자동 bound timestamp 제거 — sticker_code/box_code 또는 desired_ship_date 만 enrichment 조건.
        const hasEnrich = stub.desired_ship_date
          || (Array.isArray(stub.sticker_selections) && stub.sticker_selections.some(s =>
            s.sticker_code || s.box_code
          ));
        if (!hasEnrich) continue;
        try {
          await store.patchCoupangStubEnrichment(stub.order_id, {
            sticker_selections: stub.sticker_selections,
            desired_ship_date: stub.desired_ship_date,
          });
        } catch (e) {
          console.warn(`[coupang sync] enrichment patch 실패 ${stub.order_id}: ${e.message}`);
        }
      }
    } catch (e) {
      console.warn('[coupang sync] customer_info stub upsert 실패 (수집처리 버튼 동작 안 할 수 있음):', e.message);
    }
  }
  await store.updateSyncState({
    last_synced_at: new Date().toISOString(),
    last_synced_order_count: upserted,
    last_error: null,
  });
  // Coupang API 가 실제 받은 KST 날짜 (yyyy-MM-dd, /ordersheets endpoint 포맷)
  return {
    fetched: sheets.length,
    upserted,
    stub_ci_upserted: stubUpserted,
    enriched: enrichedCount,
    filtered_out: filteredOut,
    items: rows.length,
    filter_disabled: FILTER_DISABLED,
    window: {
      start_ms: startMs, end_ms: endMs, days: daysBack,
      start_kst: api.fmtKstDate(startMs),
      end_kst: api.fmtKstDate(endMs),
    },
    pages: res.pages,
    per_status: res.perStatus,
  };
}

/**
 * 취소/반품 재확인 — 목록 API 로는 잡히지 않는 취소를 단건 조회로 메운다.
 *
 * 배경 (2026-08-06 진단):
 *   · /ordersheets 목록 조회는 status 필수인데 CANCEL/RETURNS 로 부르면 에러가 난다.
 *     (진단 결과 FINAL_DELIVERY/NONE_TRACKING/CANCEL/RETURNS 모두 error)
 *     → 취소 건이 애초에 동기화 대상에 들어오지 못했다.
 *   · 단건 조회 /{orderId}/ordersheets 는 취소된 주문에 대해
 *     400 "해당 주문이 취소 또는 반품 되었습니다." 를 돌려준다.
 *     이 에러 자체가 확실한 취소 신호라, 이를 이용해 상태를 갱신한다.
 *
 * 대상: DB 에 있는 최근 daysBack 일 주문 중 아직 종결(CANCEL/RETURNS) 아닌 건.
 * 호출량 제한: 최대 maxChecks 건, 호출 사이 delayMs 대기.
 */
const CANCEL_HINT = /취소\s*또는\s*반품|취소되었|반품되었/;

async function reconcileCancelled({ daysBack = 14, maxChecks = 300, delayMs = 120 } = {}) {
  if (!api.isConfigured()) return { checked: 0, cancelled: 0, error: 'Coupang API 키 미설정' };
  if (!store.USE_SUPABASE) return { checked: 0, cancelled: 0, error: 'Supabase 미설정' };

  const endMs = Date.now();
  const startMs = endMs - daysBack * 86400000;
  const fmt = ms => new Date(ms + 9 * 3600000).toISOString().slice(0, 10);   // KST 날짜
  let rows;
  try {
    // 로켓그로스는 마켓플레이스 단건 조회 대상이 아니다 — 넣으면 헛호출만 늘어난다
    rows = await store.listCoupangOrders({ startStr: fmt(startMs), endStr: fmt(endMs + 86400000), excludeRocketGrowth: true });
  } catch (e) {
    return { checked: 0, cancelled: 0, error: `DB 조회 실패: ${e.message}` };
  }

  const TERMINAL = new Set(['CANCEL', 'RETURNS']);
  const pending = [...new Set((rows || [])
    .filter(r => !TERMINAL.has(String(r.status || '').toUpperCase()))
    .map(r => String(r.coupang_order_id)))];

  const targets = pending.slice(0, maxChecks);
  const cancelled = [];
  const errors = [];
  for (const id of targets) {
    try {
      await api.getOrderSheet(id);   // 정상 응답 = 아직 살아있는 주문
    } catch (e) {
      if (CANCEL_HINT.test(e.message || '')) cancelled.push(id);
      else errors.push({ order_id: id, error: String(e.message).slice(0, 120) });
    }
    if (delayMs) await new Promise(r => setTimeout(r, delayMs));
  }

  let updated = 0;
  for (const id of cancelled) {
    try {
      const r = await store.updateCoupangOrderStatus(id, 'CANCEL', STATUS_LABEL.CANCEL || '주문취소');
      updated += r.updated || 0;
    } catch (e) {
      errors.push({ order_id: id, error: `DB 갱신 실패: ${String(e.message).slice(0, 120)}` });
    }
  }

  // 크론 실행은 화면 알림이 없으니 컨테이너 로그로 남긴다.
  console.log(`[coupang-reconcile] 확인 ${targets.length}/${pending.length}건`
    + ` · 취소 ${cancelled.length}건 (row ${updated})`
    + (cancelled.length ? ` — ${cancelled.join(', ')}` : '')
    + (errors.length ? ` · 오류 ${errors.length}건: ${errors[0].error}` : ''));

  return {
    days_back: daysBack,
    pending: pending.length,
    checked: targets.length,
    truncated: pending.length > targets.length,
    cancelled: cancelled.length,
    rows_updated: updated,
    cancelled_order_ids: cancelled,
    errors: errors.slice(0, 20),
  };
}

/**
 * 구매확정일 소급 채우기 (080) — 정산현황(매출내역 조회 API)의 매출인식일로 채운다.
 *
 * 왜 이쪽인가: 쿠팡 자동 구매확정은 배송완료 며칠 뒤에 걸려 주문 동기화(최근 7일)가
 * 그 주문을 이미 지나친 뒤다. ordersheet 의 confirmDate 를 주문마다 다시 두드리는 대신,
 * 매출내역을 기간으로 한 번 훑으면 그 기간에 매출이 인식된 주문이 전부 나온다.
 * 매출인식일 = "'배송완료 + 7day' 또는 '구매확정'" 중 빠른 시점 (쿠팡 문서) — 정산이
 * 걸리는 기준이라 화면의 '구매확정일'이 뜻하는 바와 같다.
 *
 * 제약: 한 호출 최대 31일 → 31일씩 잘라 돈다. 전일까지만 조회된다. 페이지 50건.
 * 매칭 키 = (orderId, vendorItemId). REFUND 행은 무시(취소는 동기화가 status 로 잡는다).
 * 로켓그로스는 매출내역에 잡히면 같이 채워지고, 아니면 NULL 로 남는다 (따로 걸러내지 않는다).
 *
 * 반환: { window:{from,to}, segments, pages, sales_rows, keys, candidates, updated, unmatched, failed }
 */
async function backfillConfirmedAt({ daysBack = 45, endDate = null } = {}) {
  if (!store.USE_SUPABASE) return { error: 'Supabase 미설정' };
  if (!api.isConfigured()) return { error: 'Coupang API 키 미설정 (COUPANG_VENDOR_ID/ACCESS_KEY/SECRET_KEY)' };

  const days = Math.min(Math.max(parseInt(daysBack, 10) || 45, 1), 400);
  const ymd = d => api.fmtKstDate(d);
  const addDays = (s, n) => ymd(new Date(new Date(`${s}T00:00:00+09:00`).getTime() + n * 86400000));
  // 전일까지만 조회된다 — 오늘을 넣으면 400.
  const to = /^\d{4}-\d{2}-\d{2}$/.test(String(endDate || '')) ? String(endDate) : addDays(ymd(new Date()), -1);
  const from = addDays(to, -(days - 1));

  const result = { window: { from, to }, segments: 0, pages: 0, sales_rows: 0, keys: 0, candidates: 0, updated: 0, unmatched: 0, failed: 0 };
  // (orderId|vendorItemId) → 가장 이른 매출인식일
  const byKey = new Map();
  const MAX_PAGES_PER_SEG = 400;   // 31일 × 50건/페이지 — 2만 행 상한 (실제는 수백 건)
  for (let segFrom = from; segFrom <= to; segFrom = addDays(segFrom, 31)) {
    const segTo = addDays(segFrom, 30) < to ? addDays(segFrom, 30) : to;
    result.segments += 1;
    let token = '';
    for (let page = 0; page < MAX_PAGES_PER_SEG; page++) {
      let res;
      try {
        res = await api.listRevenueHistory({ from: segFrom, to: segTo, token });
      } catch (e) {
        return { ...result, error: `매출내역 조회 실패 (${segFrom}~${segTo}): ${e.message}` };
      }
      result.pages += 1;
      for (const row of (Array.isArray(res?.data) ? res.data : [])) {
        result.sales_rows += 1;
        if (String(row.saleType || '').toUpperCase() !== 'SALE') continue;
        const date = String(row.recognitionDate || '').slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
        for (const it of (row.items || [])) {
          const key = `${row.orderId ?? ''}|${it.vendorItemId ?? ''}`;
          const prev = byKey.get(key);
          if (!prev || date < prev) byKey.set(key, date);
        }
      }
      token = res?.nextToken || '';
      if (!res?.hasNext || !token) break;
      await new Promise(r => setTimeout(r, 120));   // 호출 간격
    }
  }
  result.keys = byKey.size;
  if (!byKey.size) return result;
  const applied = await applyConfirmMap(byKey);
  return { ...result, ...applied };
}

/**
 * (주문번호|옵션ID) → 매출인식일(yyyy-MM-dd) 맵을 우리 DB 에 적용 — 비어 있는 행만 채운다.
 *   API 백필과 엑셀 업로드가 같이 쓴다. 반환 { candidates, updated, unmatched, failed, error? }
 */
async function applyConfirmMap(byKey) {
  const result = { candidates: 0, updated: 0, unmatched: 0, failed: 0 };
  if (!byKey.size) return result;
  const REST = `${process.env.SUPABASE_URL}/rest/v1`;
  const hdr = { apikey: process.env.SUPABASE_ANON_KEY, Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}` };
  const orderIds = [...new Set([...byKey.keys()].map(k => k.split('|')[0]).filter(Boolean))];
  const idsByDate = new Map();   // 매출인식일 → [row id]
  for (let i = 0; i < orderIds.length; i += 100) {
    const chunk = orderIds.slice(i, i + 100);
    const url = `${REST}/coupang_orders?select=id,coupang_order_id,vendor_item_id&confirmed_at=is.null`
      + `&coupang_order_id=in.(${chunk.map(encodeURIComponent).join(',')})`;
    const r = await fetch(url, { headers: hdr });
    if (!r.ok) return { ...result, error: `Supabase list [${r.status}]: ${(await r.text()).slice(0, 200)}` };
    for (const row of await r.json()) {
      result.candidates += 1;
      const date = byKey.get(`${row.coupang_order_id ?? ''}|${row.vendor_item_id ?? ''}`);
      if (!date) { result.unmatched += 1; continue; }
      if (!idsByDate.has(date)) idsByDate.set(date, []);
      idsByDate.get(date).push(row.id);
    }
  }
  for (const [date, ids] of idsByDate) {
    const confirmedAt = parseCoupangDate(date);   // yyyy-MM-dd → KST 자정
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const r = await fetch(`${REST}/coupang_orders?id=in.(${chunk.map(encodeURIComponent).join(',')})`, {
        method: 'PATCH',
        headers: { ...hdr, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ confirmed_at: confirmedAt }),
      });
      if (r.ok) result.updated += chunk.length;
      else { result.failed += chunk.length; console.warn(`[coupang backfill] PATCH ${r.status} (${date}, ${chunk.length}건)`); }
    }
  }
  return result;
}

/** 엑셀 셀 → yyyy-MM-dd ('2026-08-04', '2026-08-04 00:00', 엑셀 일련번호 모두) */
function _xlsxCellDate(v) {
  const str = String(v ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str.slice(0, 10);
  if (/^\d{5}(\.\d+)?$/.test(str)) return new Date((Number(str) - 25569) * 86400000).toISOString().slice(0, 10);
  return '';
}

/**
 * 정산현황 > 매출내역 상세 엑셀(MSF_PAYMENT_REVENUE_DETAIL-*.xlsx)로 채우기 — API 없이도 즉시.
 *   시트 'Order Detail Report' 헤더: 주문번호 · 옵션 ID · … · 배송완료일 · 구매확정일 · 취소완료일 · 정산예정일
 *   배송료 행(옵션 ID = <기본배송료>/<추가배송료>)과 구매확정일이 빈 행은 건너뛴다.
 *   반환 { parsed_rows, skipped, keys, candidates, updated, unmatched, failed }
 */
async function backfillConfirmedAtFromXlsx(buf) {
  if (!store.USE_SUPABASE) return { error: 'Supabase 미설정' };
  const { parseAllSheets } = require('./rfm-lines');
  const byKey = new Map();
  let parsed = 0, skipped = 0, headerFound = false;
  for (const sh of parseAllSheets(buf)) {
    const hi = sh.rows.findIndex(r => r && r.some(c => String(c).trim() === '주문번호') && r.some(c => String(c).trim() === '구매확정일'));
    if (hi < 0) continue;
    const header = sh.rows[hi].map(c => String(c ?? '').trim());
    const cOrder = header.indexOf('주문번호'), cOpt = header.indexOf('옵션 ID'), cConf = header.indexOf('구매확정일');
    if (cOpt < 0) continue;
    headerFound = true;
    for (const r of sh.rows.slice(hi + 1)) {
      if (!r) continue;
      const order = String(r[cOrder] ?? '').trim();
      const opt = String(r[cOpt] ?? '').trim();
      if (!/^\d+$/.test(order) || !/^\d+$/.test(opt)) { skipped += 1; continue; }
      parsed += 1;
      const conf = _xlsxCellDate(r[cConf]);
      if (!conf) continue;   // 아직 미확정
      const key = `${order}|${opt}`;
      const prev = byKey.get(key);
      if (!prev || conf < prev) byKey.set(key, conf);
    }
  }
  if (!headerFound) throw new Error("정산현황 매출내역 파일이 아닙니다 ('주문번호'·'옵션 ID'·'구매확정일' 헤더가 필요합니다)");
  const applied = await applyConfirmMap(byKey);
  return { parsed_rows: parsed, skipped, keys: byKey.size, ...applied };
}

module.exports = {
  syncRecent,
  reconcileCancelled,
  backfillConfirmedAt,
  backfillConfirmedAtFromXlsx,
  normalizeOrderSheet, // for testing
  parseCoupangDate,    // for testing
  STATUS_LABEL,
};
