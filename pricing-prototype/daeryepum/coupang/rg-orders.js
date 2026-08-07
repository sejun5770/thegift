/**
 * 로켓그로스 주문 수집.
 *
 * 로켓그로스 주문은 마켓플레이스 주문 API 로 나오지 않는다. 별도 API 로만 조회되고,
 * 그래서 coupang_orders 에 들어온 적이 없어 정보입력현황에 행 자체가 없었다.
 *
 * 정산 리포트로 대신 만들 수도 있었지만, 리포트에는 판매자배송 주문도 섞여 있어
 * 리포트만으로는 로켓그로스를 가릴 수 없다 (운영 확인 2026-08-07).
 * 그래서 RG 주문 API 를 정본 목록으로 삼는다 — 여기서 온 것만 로켓그로스다.
 *
 * API 가 안 주는 것 (쿠팡이 배송까지 처리하므로):
 *   · 수취인·배송지 → 비워 둔다. 우리가 쓸 일이 없다.
 *   · 등록상품ID   → 이미 올려둔 정산 리포트에서 (주문ID, 옵션ID) 로 채운다.
 *                    상품설정에 옵션ID 없이 등록상품ID 만 넣은 상품이 대부분이라 필요하다.
 *   · 주문상태     → 리포트의 배송완료일 유무로 추정한다.
 */
'use strict';

const api = require('./api');
const store = require('./store');
const bgStore = require('../barungift/store');
const rfmStore = require('./rfm-store');
const { enrichOrderItem, calcCoupangShipDate } = require('./option-mapper');

/** 'YYYY-MM-DD' → 그 날 정오(KST) ISO. 자정으로 잡으면 UTC 변환에서 하루 밀린다. */
function kstNoon(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ''))) return null;
  return new Date(`${dateStr}T12:00:00+09:00`).toISOString();
}

function parseDate(v) {
  if (!v) return null;
  let s = String(v).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return kstNoon(s);
  if (s.includes(' ') && !s.includes('T')) s = s.replace(' ', 'T');
  if (!/[+-]\d{2}:?\d{2}$|Z$/i.test(s)) s += '+09:00';
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/** 상품설정 → 옵션ID/등록상품ID 별 판매단위 (060) */
function buildUnitMap(productSettings) {
  const byOption = new Map(), byProduct = new Map();
  for (const ps of productSettings || []) {
    const unit = parseInt(ps.channel_sales_units?.coupang, 10);
    if (!(unit > 1)) continue;
    const m = ps.channel_product_codes?.coupang;
    if (!m) continue;
    const pIds = Array.isArray(m) ? m : (m.product_ids || []);
    for (const c of pIds) byProduct.set(String(c).trim(), unit);
    for (const c of (Array.isArray(m) ? [] : (m.option_ids || []))) byOption.set(String(c).trim(), unit);
  }
  return { byOption, byProduct };
}

/**
 * @param {object} opts
 * @param {string} opts.startDate / opts.endDate  결제일 범위 (YYYY-MM-DD)
 * @param {boolean} opts.dryRun  true 면 저장하지 않고 무엇이 들어올지만 돌려준다
 */
async function syncRgOrders({ startDate, endDate, dryRun = false } = {}) {
  if (!api.isConfigured()) throw new Error('Coupang API 키 미설정 (COUPANG_VENDOR_ID/ACCESS_KEY/SECRET_KEY)');
  if (!startDate || !endDate) throw new Error('조회 기간(startDate/endDate)이 필요합니다');

  const [fetched, productSettings, stickers, reportLines] = await Promise.all([
    api.listAllRgOrders({ startDate, endDate }),
    bgStore.getAllProductSettings().catch(() => []),
    bgStore.getAllStickers(true).catch(() => []),
    // 등록상품ID·배송완료일 보강용. 없으면 없는 대로 진행한다.
    rfmStore.listAllOrderLines({ startDate, endDate }).catch(() => []),
  ]);

  const byKey = new Map();
  for (const l of (reportLines || [])) {
    byKey.set(`${String(l.order_id).trim()}|${String(l.vendor_item_id).trim()}`, l);
  }
  const { byOption, byProduct } = buildUnitMap(productSettings);

  const seen = new Set();
  const rows = [];
  let skipped = 0;
  for (const it of (fetched.items || [])) {
    const orderId = String(it.orderId ?? '').trim();
    const vid = String(it.vendorItemId ?? '').trim();
    if (!orderId || !vid) { skipped++; continue; }
    // 같은 (주문, 옵션) 이 두 번 오면 upsert 가 통째로 실패한다 (ON CONFLICT 중복 키)
    const key = `${orderId}|${vid}`;
    if (seen.has(key)) { skipped++; continue; }
    seen.add(key);

    const line = byKey.get(key);
    const sellerProductId = line?.seller_product_id ? String(line.seller_product_id) : null;
    const qty = Number(it.salesQuantity) || 0;
    const unit = byOption.get(vid) || (sellerProductId ? byProduct.get(sellerProductId) : null) || 1;
    const price = Math.round(Number(it.unitSalesPrice) || 0);
    const paidAt = parseDate(it.paidAt) || kstNoon(line?.paid_date);
    // 배송완료일이 리포트에 있으면 배송완료로 본다. 없으면 아직 쿠팡 창고에 있는 것.
    const delivered = !!line?.delivered_date;
    rows.push({
      coupang_order_id: orderId,
      shipment_box_id: 0,            // RG 는 배송박스 개념이 없다 — 고정값으로 unique 키를 채운다
      vendor_item_id: vid,
      vendor_item_package_id: null,
      ordered_at: paidAt || new Date().toISOString(),
      paid_at: paidAt,
      product_name: it.productName || '로켓그로스 답례품',
      product_code: sellerProductId,
      external_vendor_sku: null,
      item_count: qty * unit,        // 실제 개수 (채널 판매단위 반영)
      item_sale_price: price,
      item_total_price: price * qty,
      recv_name: null, recv_hphone: null, recv_address: null,
      recv_postal_code: null, recv_message: null,
      settle_price: price * qty,
      settle_method: null,
      status: delivered ? 'FINAL_DELIVERY' : 'INSTRUCT',
      status_label: delivered ? '배송완료' : '상품준비중',
      is_rocket_growth: true,
      raw_payload: { source: 'rg_open_api', item: it, _cart_qty: qty, _sales_unit: unit },
      synced_at: new Date().toISOString(),
    });
  }

  const out = {
    fetched: (fetched.items || []).length,
    windows: fetched.windows, pages: fetched.pages,
    orders: new Set(rows.map(r => r.coupang_order_id)).size,
    rows: rows.length, skipped,
    withSellerProductId: rows.filter(r => r.product_code).length,
    delivered: rows.filter(r => r.status === 'FINAL_DELIVERY').length,
    upserted: 0, stubs: 0,
    dry_run: dryRun,
  };
  if (dryRun || !rows.length) {
    out.samples = rows.slice(0, 10);
    return out;
  }

  const up = await store.upsertCoupangOrders(rows);
  out.upserted = up.upserted || rows.length;

  // 정보입력현황 stub — 마켓플레이스 동기화와 같은 규칙 (CP-{주문ID}, 주문 단위 1행).
  //   이미 있으면 건드리지 않는다 (ignore-duplicates) — 운영이 손댄 상태를 지우지 않기 위해.
  const grouped = new Map();
  for (const r of rows) {
    const orderId = `CP-${r.coupang_order_id}`;
    const sel = enrichOrderItem({
      productCode: r.product_code,
      productName: r.product_name,
      quantity: r.item_count,
      modelNo: null,
      optionId: r.vendor_item_id,
      stickers,
      productSettings,
    });
    const entry = grouped.get(orderId) || { row: r, selections: [] };
    entry.selections.push(sel);
    grouped.set(orderId, entry);
  }
  const stubs = [...grouped.entries()].map(([order_id, { row, selections }]) => ({
    order_id,
    is_express: false,
    express_fee: 0,
    desired_ship_date: calcCoupangShipDate(row.ordered_at),
    sticker_selections: selections,
    cash_receipt_yn: false,
    receipt_type: null,
    receipt_number: null,
    customer_request: null,
    submitted_at: row.ordered_at,
  }));
  // 이미 있는 주문정보를 먼저 본다 — 무엇이 새로 생기고 무엇을 건드리면 안 되는지 가른다.
  const existing = new Map();
  const ids = stubs.map(s => s.order_id);
  for (let i = 0; i < ids.length; i += 200) {
    try {
      for (const r of (await bgStore.getCustomerInfoBatch(ids.slice(i, i + 200))) || []) {
        existing.set(r.order_id, r);
      }
    } catch (e) { console.warn('[rg-orders] 기존 주문정보 조회 실패:', e.message); }
  }
  out.newOrders = stubs.length - existing.size;
  out.preserved = existing.size;

  const st = await store.upsertCoupangStubCustomerInfos(stubs);
  out.stubs = st.upserted || 0;

  // ignore-duplicates 라 기존 row 는 안 채워진다 — 아직 비어 있는 것만 따로 PATCH 한다.
  //   비어 있지 않으면 손대지 않는다. sticker_selections 에는 워크플로우 시각
  //   (포장완료/출고완료)이 들어 있어, 통째로 덮으면 진행 상태가 날아간다.
  const needPatch = stubs.filter(s => {
    const cur = existing.get(s.order_id);
    if (!cur) return false;                                    // 방금 insert 됐다 — 이미 값이 들어갔다
    const sels = cur.sticker_selections;
    return !Array.isArray(sels) || !sels.length;               // 비어 있을 때만
  });
  let patched = 0;
  for (let i = 0; i < needPatch.length; i += 8) {
    await Promise.all(needPatch.slice(i, i + 8).map(async (s) => {
      try {
        await store.patchCoupangStubEnrichment(s.order_id, {
          sticker_selections: s.sticker_selections,
          desired_ship_date: s.desired_ship_date,
        });
        patched++;
      } catch (e) {
        console.warn(`[rg-orders] stub enrichment 실패 ${s.order_id}: ${e.message}`);
      }
    }));
  }
  out.enriched = patched;
  return out;
}

module.exports = { syncRgOrders, buildUnitMap, kstNoon };
