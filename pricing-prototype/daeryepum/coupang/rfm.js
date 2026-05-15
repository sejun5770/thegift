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

// 후보 endpoint 들 — 일반적인 Coupang RFM API naming 패턴.
//   debug-raw 호출 시 모두 시도 → 운영자가 어느 게 200 응답 주는지 확인.
const RFM_ENDPOINTS = [
  // Pattern A: marketplace_openapi + rfm prefix
  '/v2/providers/marketplace_openapi/apis/api/v1/rfm/sales-report',
  '/v2/providers/marketplace_openapi/apis/api/v1/rfm/daily-sales',
  // Pattern B: openapi vendors path + rfm
  `/v2/providers/openapi/apis/api/v1/vendors/{VENDOR_ID}/rfm/sales-report`,
  // Pattern C: seller_api
  `/v2/providers/seller_api/apis/api/v1/rfm/sales`,
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
