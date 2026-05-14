/**
 * 네이버 스마트스토어 주문 동기화 — 커머스 API → 정규화 → Supabase upsert.
 *
 * 답례품 카테고리 필터:
 *   NAVER_CATEGORY_IDS    — 콤마 구분 카테고리 ID 리스트
 *   NAVER_PRODUCT_CODES   — 콤마 구분 셀러 상품코드
 *   둘 다 비어 있으면 전체 통과 (초기 운영 진단용).
 *
 * 상태 매핑 (productOrderStatus → 한글):
 *   PAYMENT_WAITING → 결제대기
 *   PAYED           → 결제완료
 *   DELIVERING      → 배송중
 *   DELIVERED       → 배송완료
 *   PURCHASE_DECIDED→ 구매확정
 *   CANCELED        → 주문취소
 *   RETURNED        → 반품
 *   EXCHANGED       → 교환
 */
'use strict';

const api = require('./api');
const store = require('./store');
const bgStore = require('../barungift/store');
const { enrichFromOption, kstYmd, addBusinessDays } = require('./option-parser');

// 출고일 = 주문일(KST) + N영업일. 운영팀 요청 기본값 2.
const SHIP_LEAD_BUSINESS_DAYS = 2;

const CATEGORY_IDS = (process.env.NAVER_CATEGORY_IDS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const PRODUCT_CODES = (process.env.NAVER_PRODUCT_CODES || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const FILTER_DISABLED = !CATEGORY_IDS.length && !PRODUCT_CODES.length;

const STATUS_LABEL = {
  PAYMENT_WAITING: '결제대기',
  PAYED: '결제완료',
  DELIVERING: '배송중',
  DELIVERED: '배송완료',
  PURCHASE_DECIDED: '구매확정',
  CANCELED: '주문취소',
  RETURNED: '반품',
  EXCHANGED: '교환',
};

/**
 * 한 productOrder detail → 정규화된 row.
 *   네이버 응답 schema (대략):
 *     { productOrder: {...}, order: {...}, delivery: {...}, ... }
 *   필드명이 실제 응답과 다를 수 있어 raw_payload 도 함께 저장 (디버깅용).
 */
function normalizeOrder(item) {
  // 네이버 detail 응답 구조: { order: {...}, productOrder: {...}, (delivery?) }
  const po = item.productOrder || item;
  const order = item.order || {};

  const productOrderId = String(po.productOrderId || '');
  const orderId = String(po.orderId || order.orderId || '');
  if (!productOrderId || !orderId) return null;

  // 카테고리/상품코드 필터 — 실제 응답 필드명 매핑
  //   sellerProductCode (예: 'TGJSD01') — 셀러센터 등록한 상품 코드 (운영팀 매핑 대상)
  //   productId (예: '13501813395') — 네이버 상품번호
  const productCode = po.sellerProductCode ? String(po.sellerProductCode) : null;
  const productId = po.productId ? String(po.productId) : null;
  const categoryId = String(po.categoryId || po.category?.categoryId || '');
  if (!FILTER_DISABLED) {
    const catOk = CATEGORY_IDS.length && CATEGORY_IDS.includes(categoryId);
    const codeOk = PRODUCT_CODES.length && (
      (productCode && PRODUCT_CODES.includes(productCode)) ||
      (productId && PRODUCT_CODES.includes(productId))
    );
    if (!catOk && !codeOk) return null;
  }

  const orderedAt = order.orderDate ? new Date(order.orderDate).toISOString() : (po.orderDate ? new Date(po.orderDate).toISOString() : null);
  const paidAt = order.paymentDate ? new Date(order.paymentDate).toISOString() : (po.paymentDate ? new Date(po.paymentDate).toISOString() : null);

  const status = po.productOrderStatus || 'UNKNOWN';
  const statusLabel = STATUS_LABEL[status] || status;

  const qty = Number(po.quantity || 1) || 1;
  const unit = Number(po.unitPrice || po.productPrice || 0) || 0;
  const total = Number(po.totalPaymentAmount || po.totalPrice || (unit * qty)) || 0;

  // 수령인/배송지 — productOrder.shippingAddress 경로 (실제 응답)
  const sa = po.shippingAddress || order.shippingAddress || {};

  return {
    product_order_id: productOrderId,
    order_id: orderId,
    ordered_at: orderedAt,
    paid_at: paidAt,
    product_name: po.productName || '네이버 답례품',
    product_option: po.productOption || null,
    // product_code: sellerProductCode 우선, 없으면 productId 폴백
    product_code: productCode || productId,
    category_id: categoryId || null,
    category_name: po.categoryName || po.category?.categoryName || null,
    item_count: qty,
    item_sale_price: unit,
    item_total_price: total,
    recv_name: sa.name || sa.receiverName || null,
    recv_hphone: sa.tel1 || sa.tel2 || sa.receiverTel1 || sa.phone || null,
    recv_address: [sa.baseAddress, sa.detailedAddress].filter(Boolean).join(' ') || sa.fullAddress || null,
    recv_postal_code: sa.zipCode || sa.postalCode || null,
    // 배송 메모 — 네이버는 'shippingMemo' 필드 사용 (deliveryMemo 아님)
    recv_message: po.shippingMemo || order.shippingMemo || null,
    settle_price: total,
    settle_method: order.paymentMeans || po.paymentMeans || null,
    status,
    status_label: statusLabel,
    raw_payload: {
      // 진단/재처리용 — 주요 필드만 보존
      productClass: po.productClass,
      deliveryAttributeType: po.deliveryAttributeType,
      productId: po.productId,
      sellerCustomCode1: po.sellerCustomCode1,
      inflowPath: po.inflowPath,
      // sticker_selections enrichment 입력 (sync 단계에서 사용)
      productOption: po.productOption,
    },
    synced_at: new Date().toISOString(),
  };
}

/**
 * 메인 동기화 — 기간 내 변경 주문 fetch → 정규화 → upsert + stub ci.
 */
async function syncRecent({ daysBack = 7 } = {}) {
  if (!api.isConfigured()) {
    const err = 'Naver API 키 미설정 (NAVER_CLIENT_ID/CLIENT_SECRET)';
    await store.updateSyncState({ last_error: err });
    return { fetched: 0, upserted: 0, filtered_out: 0, error: err };
  }
  if (!store.USE_SUPABASE) {
    return { fetched: 0, upserted: 0, error: 'Supabase 미설정' };
  }
  const endMs = Date.now();
  const startMs = endMs - daysBack * 86400000;
  let res;
  try {
    res = await api.listAllOrders({ startMs, endMs });
  } catch (e) {
    await store.updateSyncState({ last_error: e.message, last_synced_at: new Date().toISOString() });
    return { fetched: 0, upserted: 0, error: e.message };
  }
  const items = res.items || [];
  const rows = [];
  let filteredOut = 0;
  for (const item of items) {
    const r = normalizeOrder(item);
    if (r) rows.push(r);
    else filteredOut++;
  }

  let upserted = 0;
  if (rows.length) {
    try {
      const r = await store.upsertNaverOrders(rows);
      upserted = r.upserted || rows.length;
    } catch (e) {
      await store.updateSyncState({ last_error: e.message, last_synced_at: new Date().toISOString() });
      return { fetched: items.length, upserted: 0, filtered_out: filteredOut, error: e.message };
    }
  }

  // stub customer_info 자동 생성 — 정보입력현황 입력완료 탭 자동 노출 + 수집처리 가능.
  //   productOption 파싱으로 sticker_selections / desired_ship_date 자동 enrichment.
  let stubUpserted = 0;
  let enrichedCount = 0;
  if (rows.length) {
    try {
      // 참고 데이터 1회 로드 (전체 sync 동안 재사용)
      let stickers = [];
      let productSettings = [];
      try {
        [stickers, productSettings] = await Promise.all([
          bgStore.getAllStickers(true).catch(() => []),
          bgStore.getAllProductSettings().catch(() => []),
        ]);
      } catch (e) {
        console.warn('[naver sync] 스티커/상품설정 로드 실패 (enrichment 스킵):', e.message);
      }
      // 같은 NV- order_id 의 row 가 여러 개면 — 첫 enrichment 만 사용,
      // 같은 productCode 끼리 묶어 quantity 합산 (분리배송 대응)
      const grouped = new Map(); // order_id → { row, byCode: Map<code, {row, productOption, quantity}> }
      for (const r of rows) {
        const order_id = `NV-${r.product_order_id}`;
        const entry = grouped.get(order_id) || { row: r, byCode: new Map() };
        const code = r.product_code || 'UNKNOWN';
        const prev = entry.byCode.get(code);
        const productOption = r.raw_payload?.productOption || null;
        if (prev) {
          prev.quantity += Number(r.item_count) || 0;
        } else {
          entry.byCode.set(code, {
            row: r,
            productOption,
            quantity: Number(r.item_count) || 0,
          });
        }
        grouped.set(order_id, entry);
      }

      const stubs = [];
      for (const [order_id, { row, byCode }] of grouped) {
        const sticker_selections = [];
        for (const [code, info] of byCode) {
          const enriched = enrichFromOption({
            productOption: info.productOption,
            productCode: code,
            productName: row.product_name,
            quantity: info.quantity,
            stickers,
            productSettings,
          });
          sticker_selections.push(enriched.sticker_selection);
          if (enriched.sticker_selection.sticker_code || enriched.sticker_selection.box_code) {
            enrichedCount++;
          }
        }
        // 출고일 = 주문일(KST) + 2영업일 — 옵션 파싱값 대신 운영 규칙 적용 (운영팀 요청).
        //   주문일이 비어있는 비정상 케이스에만 null.
        const orderedYmd = kstYmd(row.ordered_at);
        const shipDate = orderedYmd ? addBusinessDays(orderedYmd, SHIP_LEAD_BUSINESS_DAYS) : null;
        stubs.push({
          order_id,
          is_express: false, express_fee: 0,
          desired_ship_date: shipDate,
          sticker_selections,
          cash_receipt_yn: false, receipt_type: null, receipt_number: null,
          customer_request: null,
          submitted_at: row.ordered_at || new Date().toISOString(),
        });
      }
      const sr = await store.upsertNaverStubCustomerInfos(stubs);
      stubUpserted = sr.upserted || 0;

      // enrichment PATCH — ignore-duplicates 라 기존 빈 stub 은 위 upsert 로 안 채워짐.
      //   sticker_selections / desired_ship_date 만 patch (processed_at, customer_request 등 보존).
      //   매 sync 마다 호출 → 옵션 변경 시 자동 반영, idempotent.
      for (const stub of stubs) {
        const hasEnrich = stub.desired_ship_date
          || (Array.isArray(stub.sticker_selections) && stub.sticker_selections.some(s =>
            s.sticker_code || s.box_code || (s.custom_values && Object.keys(s.custom_values).length)
          ));
        if (!hasEnrich) continue;
        try {
          await store.patchNaverStubEnrichment(stub.order_id, {
            sticker_selections: stub.sticker_selections,
            desired_ship_date: stub.desired_ship_date,
          });
        } catch (e) {
          console.warn(`[naver sync] enrichment patch 실패 ${stub.order_id}: ${e.message}`);
        }
      }
    } catch (e) {
      console.warn('[naver sync] stub ci upsert 실패 (수집처리 setProcessed 안전망이 처리):', e.message);
    }
  }

  await store.updateSyncState({
    last_synced_at: new Date().toISOString(),
    last_synced_order_count: upserted,
    last_error: null,
  });

  return {
    fetched: items.length,
    upserted,
    stub_ci_upserted: stubUpserted,
    enriched: enrichedCount,
    filtered_out: filteredOut,
    items: rows.length,
    filter_disabled: FILTER_DISABLED,
    window: {
      start_ms: startMs, end_ms: endMs, days: daysBack,
      start_kst: api.fmtKstIso(startMs),
      end_kst: api.fmtKstIso(endMs),
    },
    ids_fetched: res.idsFetched || 0,
    // 진단 정보 — 0건 원인 빠른 파악용
    sources: res.sources || [],
    chunks: res.chunks || 0,
    diagnostics: res.diagnostics || [],
  };
}

module.exports = { syncRecent, normalizeOrder, STATUS_LABEL };
