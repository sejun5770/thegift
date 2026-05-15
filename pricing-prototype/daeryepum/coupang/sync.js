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
  const hasTz = /[+-]\d{2}:?\d{2}$|Z$/i.test(str);
  if (!hasTz) str = str + '+09:00';
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function normalizeOrderSheet(sheet) {
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
      const setSize = extractSetSize(productNameForSet);
      const effectiveCount = cartQty * setSize;
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
    // status 가 명시되면 그것만, 없으면 ORDER_STATUSES 전체 순회 (dedupe)
    res = await api.listAllOrders({
      startMs, endMs,
      statuses: status ? [status] : undefined,
    });
  } catch (e) {
    await store.updateSyncState({ last_error: e.message, last_synced_at: new Date().toISOString() });
    return { fetched: 0, upserted: 0, filtered_out: 0, error: e.message };
  }
  const sheets = res.items || [];
  // 정규화 + 필터
  const rows = [];
  let filteredOut = 0;
  for (const sheet of sheets) {
    const itemsBefore = (sheet.orderItems || []).length;
    const normalized = normalizeOrderSheet(sheet);
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
        // 스티커 없음 (sticker_code null) 행은 자동으로 제본완료(bound) 까지 진행.
        const finalSelections = autoAdvanceNoStickerSelections(selections);
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
        const hasEnrich = stub.desired_ship_date
          || (Array.isArray(stub.sticker_selections) && stub.sticker_selections.some(s =>
            s.sticker_code || s.box_code
            || s.sticker_completed_at || s.printed_at || s.bound_at  // 자동 진행 적용된 행
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

module.exports = {
  syncRecent,
  normalizeOrderSheet, // for testing
  STATUS_LABEL,
};
