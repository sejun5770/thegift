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
  const po = item.productOrder || item;
  const order = item.order || {};
  const delivery = item.delivery || {};

  const productOrderId = String(po.productOrderId || '');
  const orderId = String(po.orderId || order.orderId || '');
  if (!productOrderId || !orderId) return null;

  // 카테고리 필터
  const categoryId = String(po.categoryId || po.category?.categoryId || '');
  const productCode = po.sellerProductCode ? String(po.sellerProductCode) : null;
  if (!FILTER_DISABLED) {
    const catOk = CATEGORY_IDS.length && CATEGORY_IDS.includes(categoryId);
    const codeOk = PRODUCT_CODES.length && productCode && PRODUCT_CODES.includes(productCode);
    if (!catOk && !codeOk) return null;
  }

  const orderedAt = po.orderDate ? new Date(po.orderDate).toISOString() : (order.orderDate ? new Date(order.orderDate).toISOString() : null);
  const paidAt = order.paymentDate ? new Date(order.paymentDate).toISOString() : (po.paymentDate ? new Date(po.paymentDate).toISOString() : null);

  const status = po.productOrderStatus || 'UNKNOWN';
  const statusLabel = STATUS_LABEL[status] || status;

  const qty = Number(po.quantity || 1) || 1;
  const unit = Number(po.unitPrice || po.productPrice || 0) || 0;
  const total = Number(po.totalPaymentAmount || po.totalPrice || (unit * qty)) || 0;

  // 수령인/배송지 — delivery 또는 shippingAddress 경로
  const sa = delivery.shippingAddress || po.shippingAddress || order.shippingAddress || {};

  return {
    product_order_id: productOrderId,
    order_id: orderId,
    ordered_at: orderedAt,
    paid_at: paidAt,
    product_name: po.productName || '네이버 답례품',
    product_option: po.productOption || null,
    product_code: productCode,
    category_id: categoryId || null,
    category_name: po.categoryName || po.category?.categoryName || null,
    item_count: qty,
    item_sale_price: unit,
    item_total_price: total,
    recv_name: sa.name || sa.receiverName || null,
    recv_hphone: sa.tel1 || sa.tel2 || sa.receiverTel1 || sa.phone || null,
    recv_address: [sa.baseAddress, sa.detailedAddress].filter(Boolean).join(' ') || sa.fullAddress || null,
    recv_postal_code: sa.zipCode || sa.postalCode || null,
    recv_message: delivery.deliveryMemo || po.deliveryMemo || sa.deliveryMemo || null,
    settle_price: total,
    settle_method: order.paymentMeans || po.paymentMeans || null,
    status,
    status_label: statusLabel,
    raw_payload: { item_keys: Object.keys(item), po_keys: Object.keys(po) },
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
  let stubUpserted = 0;
  if (rows.length) {
    try {
      const seen = new Set();
      const stubs = [];
      for (const r of rows) {
        const order_id = `NV-${r.product_order_id}`;
        if (seen.has(order_id)) continue;
        seen.add(order_id);
        stubs.push({
          order_id,
          is_express: false, express_fee: 0,
          desired_ship_date: null, sticker_selections: [],
          cash_receipt_yn: false, receipt_type: null, receipt_number: null,
          customer_request: null,
          submitted_at: r.ordered_at || new Date().toISOString(),
        });
      }
      const sr = await store.upsertNaverStubCustomerInfos(stubs);
      stubUpserted = sr.upserted || 0;
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
    filtered_out: filteredOut,
    items: rows.length,
    filter_disabled: FILTER_DISABLED,
    window: {
      start_ms: startMs, end_ms: endMs, days: daysBack,
      start_kst: api.fmtKstIso(startMs),
      end_kst: api.fmtKstIso(endMs),
    },
    ids_fetched: res.idsFetched || 0,
  };
}

module.exports = { syncRecent, normalizeOrder, STATUS_LABEL };
