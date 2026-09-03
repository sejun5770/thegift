/**
 * 쿠팡 로켓 그로스 (RFM, 판매자로켓) — 매출 보고서 sync.
 *
 *   RFM 매출은 ordersheets 와 다르게 주문 단위가 아닌 일별 매출 보고서 형태로 제공.
 *   Wing 셀러센터: https://wing.coupang.com/tenants/rfm/rfm-home/view
 *
 *   ⚠️ API endpoint 가 공식 문서에 명확히 documented 안 됨 — 여러 후보 endpoint 시도.
 *   실제 응답 확인 후 정확한 endpoint 1개만 남기고 정리.
 */
'use strict';

const api = require('./api');

// 후보 endpoint 들 — Coupang RFM(로켓 그로스) / 일반 매출 보고서 naming 패턴 광범위 시도.
//   debug-raw 호출 시 모두 GET 시도 → 200 OK 첫 endpoint 식별.
//   기존 1차 시도(rfm/sales-report 류 4개)는 모두 404 PRECONDITION_FAILED — path 자체가 없음.
const RFM_ENDPOINTS = [
  // Group A: 일별 매출 (daily-sales / sales-daily / dailysale)
  '/v2/providers/marketplace_openapi/apis/api/v1/marketplace/dailysale',
  '/v2/providers/marketplace_openapi/apis/api/v1/dailysale',
  '/v2/providers/openapi/apis/api/v1/marketplace/dailysale',
  '/v2/providers/openapi/apis/api/v1/marketplace/sales-daily',
  '/v2/providers/openapi/apis/api/v1/vendors/{VENDOR_ID}/dailysale',
  '/v2/providers/openapi/apis/api/v1/vendors/{VENDOR_ID}/sales-daily',

  // Group B: 매출 보고서 (sales-report / sales-revenue)
  '/v2/providers/openapi/apis/api/v1/marketplace/sales-report',
  '/v2/providers/openapi/apis/api/v1/marketplace/sales-revenue',
  '/v2/providers/openapi/apis/api/v1/vendors/{VENDOR_ID}/sales-report',
  '/v2/providers/openapi/apis/api/v1/vendors/{VENDOR_ID}/sales-revenue',
  '/v2/providers/marketplace_openapi/apis/api/v1/marketplace/sales-report',

  // Group C: 정산 (settlement)
  '/v2/providers/openapi/apis/api/v1/marketplace/settlement-histories',
  '/v2/providers/openapi/apis/api/v1/vendors/{VENDOR_ID}/settlement-histories',
  '/v2/providers/openapi/apis/api/v1/marketplace/settlements',

  // Group D: RFM/Rocket-Growth 직접 명시
  '/v2/providers/openapi/apis/api/v1/marketplace/rfm/sales',
  '/v2/providers/openapi/apis/api/v1/marketplace/rocketgrowth/sales',
  '/v2/providers/openapi/apis/api/v1/marketplace/rocket-growth/sales',
  '/v2/providers/openapi/apis/api/v1/vendors/{VENDOR_ID}/rocketgrowth/sales',
  '/v2/providers/openapi/apis/api/v1/vendors/{VENDOR_ID}/marketplace/rfm/sales',

  // Group E: orderlines / product-sales (상품 단위 집계)
  '/v2/providers/openapi/apis/api/v1/marketplace/orderlines',
  '/v2/providers/openapi/apis/api/v3/marketplace/orderlines',
  '/v2/providers/openapi/apis/api/v1/marketplace/product-sales',
  '/v2/providers/openapi/apis/api/v1/vendors/{VENDOR_ID}/product-sales',
];

/** 후보 endpoint 들을 순회하며 첫 200 응답 반환 (debug 용). */
async function tryFetchRfmSalesReport({ startDate, endDate }) {
  const VENDOR_ID = process.env.COUPANG_VENDOR_ID;
  const results = [];
  for (const tmpl of RFM_ENDPOINTS) {
    const path = tmpl.replace('{VENDOR_ID}', VENDOR_ID || '') + `?startDate=${startDate}&endDate=${endDate}`;
    try {
      const res = await api.callCoupang('GET', path);
      results.push({ endpoint: tmpl, status: 'ok', sample: res });
      // 첫 200 성공 시 반환
      return { successEndpoint: tmpl, response: res, attempts: results };
    } catch (e) {
      results.push({ endpoint: tmpl, status: 'error', message: e.message });
    }
  }
  return { successEndpoint: null, response: null, attempts: results };
}

/**
 * Normalize RFM sales row to common shape.
 *   응답 구조가 endpoint 마다 다를 수 있어 best-effort 매핑.
 */
function normalizeRow(raw, fallbackDate) {
  if (!raw || typeof raw !== 'object') return null;
  // 다양한 필드명 후보
  const saleDate = raw.saleDate || raw.sale_date || raw.date || raw.aggregateDate || fallbackDate;
  if (!saleDate) return null;
  return {
    sale_date: String(saleDate).slice(0, 10),
    vendor_item_id: raw.vendorItemId ? String(raw.vendorItemId) : null,
    product_id: raw.productId ? String(raw.productId) : (raw.sellerProductId ? String(raw.sellerProductId) : null),
    product_name: raw.productName || raw.itemName || raw.sellerProductName || null,
    sales_qty: Number(raw.salesQty || raw.salesQuantity || raw.qty || 0) || 0,
    sales_amount: Number(raw.salesAmount || raw.salesPrice || raw.amount || 0) || 0,
    refund_qty: Number(raw.refundQty || raw.refundQuantity || 0) || 0,
    refund_amount: Number(raw.refundAmount || 0) || 0,
    raw_payload: raw,
  };
}

module.exports = {
  RFM_ENDPOINTS,
  tryFetchRfmSalesReport,
  normalizeRow,
};
