/**
 * 네이버 스마트스토어 주문 동기화 — 커머스 API → 정규화 → Supabase upsert.
 *
 * 멀티 스토어 지원 (NAVER_STORES JSON):
 *   각 스토어마다 product_codes / category_ids 필터 개별 설정 가능.
 *   단일 env 폴백: NAVER_CATEGORY_IDS / NAVER_PRODUCT_CODES 전역.
 *
 * 답례품 카테고리 필터:
 *   store.product_codes / store.category_ids (스토어별) 우선
 *   둘 다 비어 있으면 NAVER_CATEGORY_IDS / NAVER_PRODUCT_CODES 전역 사용
 *   그것도 비어 있으면 전체 통과 (초기 운영 진단용).
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
const { enrichFromOption } = require('./option-parser');
const { autoAdvanceNoStickerSelections } = require('../barungift/workflow-store');

// 전역 폴백 — 스토어별 필터 미설정 시 사용
const GLOBAL_CATEGORY_IDS = (process.env.NAVER_CATEGORY_IDS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const GLOBAL_PRODUCT_CODES = (process.env.NAVER_PRODUCT_CODES || '')
  .split(',').map(s => s.trim()).filter(Boolean);

function resolveFilters(storeConfig) {
  const cats = (storeConfig && storeConfig.category_ids ? storeConfig.category_ids : '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const codes = (storeConfig && storeConfig.product_codes ? storeConfig.product_codes : '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const effectiveCats = cats.length ? cats : GLOBAL_CATEGORY_IDS;
  const effectiveCodes = codes.length ? codes : GLOBAL_PRODUCT_CODES;
  return {
    categoryIds: effectiveCats,
    productCodes: effectiveCodes,
    filterDisabled: !effectiveCats.length && !effectiveCodes.length,
  };
}

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
function normalizeOrder(item, storeConfig = null, filters = null) {
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
  // 스토어별 필터 또는 전역 폴백
  const fl = filters || resolveFilters(storeConfig);
  if (!fl.filterDisabled) {
    const catOk = fl.categoryIds.length && fl.categoryIds.includes(categoryId);
    const codeOk = fl.productCodes.length && (
      (productCode && fl.productCodes.includes(productCode)) ||
      (productId && fl.productCodes.includes(productId))
    );
    if (!catOk && !codeOk) return null;
  }

  const orderedAt = order.orderDate ? new Date(order.orderDate).toISOString() : (po.orderDate ? new Date(po.orderDate).toISOString() : null);
  const paidAt = order.paymentDate ? new Date(order.paymentDate).toISOString() : (po.paymentDate ? new Date(po.paymentDate).toISOString() : null);
  // 구매확정 시점 (migration 037) — 네이버 응답의 필드명이 문서/버전에 따라 다를 수 있어 후보 4개 우선 매핑.
  //   confirmedAt 없으면 null 저장 → 다음 sync 때 채워질 여지 유지.
  const _confirmRaw = po.decisionDate || po.purchaseDecidedDate || po.completedDate || po.confirmDate
    || order.decisionDate || order.purchaseDecidedDate || order.completedDate || order.confirmDate
    || null;
  const confirmedAt = _confirmRaw ? new Date(_confirmRaw).toISOString() : null;

  const status = po.productOrderStatus || 'UNKNOWN';
  const statusLabel = STATUS_LABEL[status] || status;

  const qty = Number(po.quantity || 1) || 1;
  const unit = Number(po.unitPrice || po.productPrice || 0) || 0;
  const total = Number(po.totalPaymentAmount || po.totalPrice || (unit * qty)) || 0;

  // 수령인/배송지 — productOrder.shippingAddress 경로 (실제 응답)
  const sa = po.shippingAddress || order.shippingAddress || {};

  return {
    store_id: storeConfig ? storeConfig.id : 'main',
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
    confirmed_at: confirmedAt,  // migration 037 — 네이버 구매확정 시점
    raw_payload: {
      // 진단/재처리용 — 주요 필드만 보존
      productClass: po.productClass,
      deliveryAttributeType: po.deliveryAttributeType,
      productId: po.productId,
      sellerCustomCode1: po.sellerCustomCode1,
      inflowPath: po.inflowPath,
      // sticker_selections enrichment 입력 (sync 단계에서 사용)
      productOption: po.productOption,
      // 확정일 후보 필드 dump (migration 037) — 실제 네이버 응답의 필드명 확인용.
      //   normalize 후에도 raw_payload 로 원본 값 보존 → 어느 필드가 사용됐는지 진단 가능.
      po_decisionDate: po.decisionDate,
      po_purchaseDecidedDate: po.purchaseDecidedDate,
      po_completedDate: po.completedDate,
      po_confirmDate: po.confirmDate,
      order_decisionDate: order.decisionDate,
      order_purchaseDecidedDate: order.purchaseDecidedDate,
    },
    synced_at: new Date().toISOString(),
  };
}

/**
 * 메인 동기화 — 기간 내 변경 주문 fetch → 정규화 → upsert + stub ci.
 */
/**
 * 단일 스토어 sync — 내부 헬퍼.
 */
async function syncOneStore(storeConfig, { daysBack = 7 } = {}) {
  if (!store.USE_SUPABASE) {
    return { store_id: storeConfig.id, fetched: 0, upserted: 0, error: 'Supabase 미설정' };
  }
  const endMs = Date.now();
  const startMs = endMs - daysBack * 86400000;
  let res;
  try {
    res = await api.listAllOrders(storeConfig, { startMs, endMs });
  } catch (e) {
    await store.updateSyncState(storeConfig.id, { last_error: e.message, last_synced_at: new Date().toISOString() });
    return { store_id: storeConfig.id, fetched: 0, upserted: 0, error: e.message };
  }
  const items = res.items || [];

  // ── 취소 변경 별도 fetch (lastChangedType='CANCELED') ──
  //   direct list 는 active 주문만 응답 → 취소된 주문 누락.
  //   24h chunk 로 분할, CANCELED 변경 productOrderId 수집 → queryProductOrders 로 detail.
  //   같은 product_order_id 가 이미 items 에 있으면 CANCELED 가 덮어쓰기 (status='CANCELED' 정확 반영).
  const CHUNK_MS = 24 * 3600 * 1000;
  const canceledIds = new Set();
  for (let from = startMs; from < endMs; from += CHUNK_MS) {
    const to = Math.min(from + CHUNK_MS, endMs);
    try {
      const cr = await api.listChangedStatuses(storeConfig, { fromMs: from, toMs: to, lastChangedType: 'CANCELED' });
      const arr = cr.data?.lastChangeStatuses || cr.data || [];
      for (const row of (Array.isArray(arr) ? arr : [])) {
        if (row && row.productOrderId) canceledIds.add(String(row.productOrderId));
      }
    } catch (e) {
      console.warn(`[naver sync canceled chunk] ${storeConfig.id}: ${e.message}`);
    }
  }
  if (canceledIds.size) {
    try {
      const detailRes = await api.queryProductOrders(storeConfig, [...canceledIds]);
      const detailArr = Array.isArray(detailRes.data) ? detailRes.data : [];
      // flatten — content 안의 {order, productOrder} 를 root level 로
      const flat = detailArr.map(it => (
        it && it.content && (it.content.order || it.content.productOrder)
          ? { ...it.content, productOrderId: it.productOrderId }
          : it
      ));
      // CANCELED 우선 덮어쓰기 — 같은 productOrderId 가 있으면 CANCELED 가 우선
      const itemById = new Map();
      for (const it of items) {
        const pid = String(it.productOrderId || it.productOrder?.productOrderId || '');
        if (pid) itemById.set(pid, it);
      }
      for (const it of flat) {
        const pid = String(it.productOrderId || it.productOrder?.productOrderId || '');
        if (pid) itemById.set(pid, it);
      }
      items.length = 0;
      items.push(...itemById.values());
      console.log(`[naver sync] ${storeConfig.id}: CANCELED 변경 ${canceledIds.size}개 merge`);
    } catch (e) {
      console.warn(`[naver sync canceled detail] ${storeConfig.id}: ${e.message}`);
    }
  }
  const filters = resolveFilters(storeConfig);
  const rows = [];
  let filteredOut = 0;
  for (const item of items) {
    const r = normalizeOrder(item, storeConfig, filters);
    if (r) rows.push(r);
    else filteredOut++;
  }

  let upserted = 0;
  if (rows.length) {
    try {
      const r = await store.upsertNaverOrders(rows);
      upserted = r.upserted || rows.length;
    } catch (e) {
      await store.updateSyncState(storeConfig.id, { last_error: e.message, last_synced_at: new Date().toISOString() });
      return { store_id: storeConfig.id, fetched: items.length, upserted: 0, filtered_out: filteredOut, error: e.message };
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
        // 출고일은 운영팀 수동 입력 — sync 시점에 자동 설정 안 함.
        // 정책 변경: 정보입력 완료(stub upsert) 시점에 자동 bound 진행 제거.
        //   운영자가 수집처리 시점에 워크플로우 진행하도록 일관 적용 (쿠팡 sync 와 동일).
        const finalSelections = sticker_selections;
        stubs.push({
          order_id,
          is_express: false, express_fee: 0,
          desired_ship_date: null,
          sticker_selections: finalSelections,
          cash_receipt_yn: false, receipt_type: null, receipt_number: null,
          customer_request: null,
          submitted_at: row.ordered_at || new Date().toISOString(),
        });
      }
      const sr = await store.upsertNaverStubCustomerInfos(stubs);
      stubUpserted = sr.upserted || 0;

      // enrichment PATCH — ignore-duplicates 라 기존 빈 stub 은 위 upsert 로 안 채워짐.
      //   sticker_selections 만 patch (desired_ship_date / processed_at / customer_request 등은 운영팀 수동 입력값 보존).
      //   매 sync 마다 호출 → 옵션 변경 시 자동 반영, idempotent.
      //   정책 변경: 자동 bound timestamp 조건 제거 — 옵션 데이터 변경만 patch 트리거.
      for (const stub of stubs) {
        const hasEnrich = Array.isArray(stub.sticker_selections) && stub.sticker_selections.some(s =>
          s.sticker_code || s.box_code || (s.custom_values && Object.keys(s.custom_values).length)
        );
        if (!hasEnrich) continue;
        try {
          await store.patchNaverStubEnrichment(stub.order_id, {
            sticker_selections: stub.sticker_selections,
            // desired_ship_date 는 의도적으로 제외 — 운영팀 수동 입력값 보존
          });
        } catch (e) {
          console.warn(`[naver sync] enrichment patch 실패 ${stub.order_id}: ${e.message}`);
        }
      }
    } catch (e) {
      console.warn('[naver sync] stub ci upsert 실패 (수집처리 setProcessed 안전망이 처리):', e.message);
    }
  }

  await store.updateSyncState(storeConfig.id, {
    last_synced_at: new Date().toISOString(),
    last_synced_order_count: upserted,
    last_error: null,
  });

  return {
    store_id: storeConfig.id,
    store_name: storeConfig.name,
    fetched: items.length,
    upserted,
    stub_ci_upserted: stubUpserted,
    enriched: enrichedCount,
    filtered_out: filteredOut,
    items: rows.length,
    filter_disabled: filters.filterDisabled,
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

/**
 * 메인 sync entrypoint — 모든 등록 store 를 순서대로 sync.
 *   토큰/세션/API 호출은 store 별 격리 — 한 스토어 실패가 다른 스토어 차단 안 함.
 *   응답: { stores: [...], total: { fetched, upserted, ... } }
 */
async function syncRecent({ daysBack = 7 } = {}) {
  if (!api.isConfigured()) {
    const err = 'Naver API 키 미설정 (NAVER_STORES 또는 NAVER_CLIENT_ID/CLIENT_SECRET)';
    return { stores: [], total: { fetched: 0, upserted: 0 }, error: err };
  }
  const stores = api.getStores();
  const results = [];
  for (const sc of stores) {
    try {
      const r = await syncOneStore(sc, { daysBack });
      results.push(r);
    } catch (e) {
      results.push({ store_id: sc.id, store_name: sc.name, fetched: 0, upserted: 0, error: e.message });
    }
  }
  const total = results.reduce((acc, r) => ({
    fetched: acc.fetched + (r.fetched || 0),
    upserted: acc.upserted + (r.upserted || 0),
    stub_ci_upserted: acc.stub_ci_upserted + (r.stub_ci_upserted || 0),
    enriched: acc.enriched + (r.enriched || 0),
    filtered_out: acc.filtered_out + (r.filtered_out || 0),
  }), { fetched: 0, upserted: 0, stub_ci_upserted: 0, enriched: 0, filtered_out: 0 });
  return { stores: results, total };
}

module.exports = { syncRecent, syncOneStore, normalizeOrder, STATUS_LABEL };
