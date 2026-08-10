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
const optionMap = require('./option-map');
const { enrichOrderItem, calcCoupangShipDate } = require('./option-mapper');

/** 'YYYY-MM-DD' → 그 날 정오(KST) ISO. 자정으로 잡으면 UTC 변환에서 하루 밀린다. */
function kstNoon(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ''))) return null;
  return new Date(`${dateStr}T12:00:00+09:00`).toISOString();
}

function parseDate(v) {
  if (!v) return null;
  // RG 주문 API 의 paidAt 은 epoch 밀리초로 온다 (예: 1782899908000).
  //   문자열로 바꿔 파싱하면 그대로 실패해 결제일이 통째로 비었다.
  if (typeof v === 'number' || /^\d{12,14}$/.test(String(v).trim())) {
    const d = new Date(Number(v));
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
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

  const [fetched, productSettings, stickers, reportLines, optToProduct] = await Promise.all([
    api.listAllRgOrders({ startDate, endDate }),
    bgStore.getAllProductSettings().catch(() => []),
    bgStore.getAllStickers(true).catch(() => []),
    // 등록상품ID·배송완료일 보강용. 없으면 없는 대로 진행한다.
    rfmStore.listAllOrderLines({ startDate, endDate }).catch(() => []),
    // 옵션ID → 등록상품ID (063). 리포트가 없는 기간의 상품코드를 여기서 잇는다.
    optionMap.getOptionToProduct().catch(() => new Map()),
  ]);

  const byKey = new Map();
  for (const l of (reportLines || [])) {
    byKey.set(`${String(l.order_id).trim()}|${String(l.vendor_item_id).trim()}`, l);
  }
  const { byOption, byProduct } = buildUnitMap(productSettings);

  // 응답은 주문 단위이고 상품은 orderItems 안에 또 들어 있다 (2026-08-07 실응답 확인).
  //   최상위에서 vendorItemId 를 찾으면 전부 걸러져 0건이 된다.
  const seen = new Set();
  const rows = [];
  let skipped = 0;
  let lines = 0;
  for (const o of (fetched.items || [])) {
    const orderId = String(o.orderId ?? '').trim();
    // orderItems 가 없는 모양이면 주문 자체를 한 줄로 본다 (방어적)
    const orderItems = Array.isArray(o.orderItems) ? o.orderItems : [o];
    const orderPaidAt = parseDate(o.paidAt);
    for (const it of orderItems) {
      lines++;
      const vid = String(it.vendorItemId ?? '').trim();
      if (!orderId || !vid) { skipped++; continue; }
      // 같은 (주문, 옵션) 이 두 번 오면 upsert 가 통째로 실패한다 (ON CONFLICT 중복 키)
      const key = `${orderId}|${vid}`;
      if (seen.has(key)) { skipped++; continue; }
      seen.add(key);

      const line = byKey.get(key);
      // 등록상품ID 는 API 가 안 준다 — 리포트 > 옵션맵 순으로 메운다.
      const sellerProductId = (line?.seller_product_id && String(line.seller_product_id))
        || optToProduct.get(vid)
        || null;
      const qty = Number(it.salesQuantity) || 0;
      const unit = byOption.get(vid) || (sellerProductId ? byProduct.get(sellerProductId) : null) || 1;
      // unitSalesPrice 는 "30990.0" 같은 문자열로 온다
      const price = Math.round(Number(it.unitSalesPrice) || 0);
      const paidAt = orderPaidAt || parseDate(it.paidAt) || kstNoon(line?.paid_date);
      // 취소 판정 — RG 주문 API 는 상태를 안 준다. 정산 리포트의 취소 표시로만 알 수 있다.
      //   부분취소는 순액이 남으므로, 수량·금액이 0 이하로 상계된 것만 전체취소로 본다.
      //   리포트가 아직 안 올라온 기간은 취소를 알 길이 없다 (아래 out.cancelUnknown 로 알린다).
      const cancelled = !!line?.is_cancel
        && (Number(line.sales_qty) || 0) <= 0 && (Number(line.sales_amount) || 0) <= 0;
      // 배송완료일이 리포트에 있으면 배송완료로 본다. 없으면 아직 쿠팡 창고에 있는 것.
      const delivered = !!line?.delivered_date;
      rows.push({
        coupang_order_id: orderId,
        shipment_box_id: 0,          // RG 는 배송박스 개념이 없다 — 고정값으로 unique 키를 채운다
        vendor_item_id: vid,
        vendor_item_package_id: null,
        ordered_at: paidAt || new Date().toISOString(),
        paid_at: paidAt,
        product_name: it.productName || '로켓그로스 답례품',
        product_code: sellerProductId,
        external_vendor_sku: null,
        item_count: qty * unit,      // 실제 개수 (채널 판매단위 반영)
        item_sale_price: price,
        item_total_price: price * qty,
        recv_name: null, recv_hphone: null, recv_address: null,
        recv_postal_code: null, recv_message: null,
        settle_price: price * qty,
        settle_method: null,
        status: cancelled ? 'CANCEL' : (delivered ? 'FINAL_DELIVERY' : 'INSTRUCT'),
        status_label: cancelled ? '주문취소' : (delivered ? '배송완료' : '상품준비중'),
        is_rocket_growth: true,
        raw_payload: {
          source: 'rg_open_api', item: it,
          _cart_qty: qty, _sales_unit: unit, _has_report_line: !!line,
        },
        synced_at: new Date().toISOString(),
      });
    }
  }

  const out = {
    fetched: (fetched.items || []).length,
    lines,
    windows: fetched.windows, pages: fetched.pages,
    orders: new Set(rows.map(r => r.coupang_order_id)).size,
    rows: rows.length, skipped,
    withSellerProductId: rows.filter(r => r.product_code).length,
    optionMapSize: optToProduct.size,
    delivered: rows.filter(r => r.status === 'FINAL_DELIVERY').length,
    cancelled: rows.filter(r => r.status === 'CANCEL').length,
    // 리포트에 대응 라인이 없어 취소 여부를 판단할 수 없는 행 — 리포트를 올리면 줄어든다
    cancelUnknown: rows.filter(r => !r.raw_payload._has_report_line).length,
    upserted: 0, stubs: 0,
    dry_run: dryRun,
  };
  if (dryRun || !rows.length) {
    out.samples = rows.slice(0, 10);
    return out;
  }

  // 마켓플레이스 동기화로 이미 들어와 있는 주문인지 본다.
  //   로켓그로스/마켓플레이스 동시 운영 상품은 양쪽 API 에 다 잡힌다. 그때 새 row 를 만들면
  //   unique 키의 shipment_box_id 가 달라(0 vs 실제 박스ID) 같은 주문이 두 줄로 보이고,
  //   로켓그로스 응답엔 수취인이 없어 한 줄만 고객 정보가 비는 모양이 된다.
  //   같은 (주문, 옵션) 에 행이 여러 개일 수 있다 — 앞선 버전이 만든 쌍둥이가 그것이다.
  const existingByPair = new Map();     // `${주문}|${옵션}` → row[]
  const receiverByOrder = new Map();    // 주문 → 수취인 (형제 행에서 물려받는다)
  try {
    const ids = [...new Set(rows.map(r => r.coupang_order_id))];
    for (let i = 0; i < ids.length; i += 200) {
      for (const o of await store.listCoupangOrders({ orderIds: ids.slice(i, i + 200) })) {
        const k = `${o.coupang_order_id}|${o.vendor_item_id}`;
        if (!existingByPair.has(k)) existingByPair.set(k, []);
        existingByPair.get(k).push(o);
        if (o.recv_name && !receiverByOrder.has(String(o.coupang_order_id))) {
          receiverByOrder.set(String(o.coupang_order_id), o);
        }
      }
    }
  } catch (e) { console.warn('[rg-orders] 기존 주문 조회 실패 (중복 방지 생략):', e.message); }

  const toMark = [];
  const toDedupe = [];
  const toInsert = [];
  for (const r of rows) {
    const hits = existingByPair.get(`${r.coupang_order_id}|${r.vendor_item_id}`) || [];
    // 마켓플레이스 원본 = 자리표시자(0) 가 아닌 행
    const origin = hits.find(o => String(o.shipment_box_id) !== '0');
    if (origin) {
      // 이미 있는 주문 — 표시만 남긴다. 새로 만들면 수취인 없는 쌍둥이가 생긴다.
      if (!origin.is_rocket_growth) {
        toMark.push({ orderId: r.coupang_order_id, vendorItemId: r.vendor_item_id });
      }
      // 앞선 버전이 만든 쌍둥이가 남아 있으면 치운다
      if (hits.some(o => String(o.shipment_box_id) === '0')) {
        toDedupe.push({ orderId: r.coupang_order_id, vendorItemId: r.vendor_item_id });
      }
      continue;
    }
    // 같은 주문의 다른 품목이 마켓플레이스로 들어와 있으면 수취인을 물려받는다.
    //   한 주문 안에서 한 줄만 고객 정보가 비는 것을 막는다.
    const sib = receiverByOrder.get(String(r.coupang_order_id));
    if (sib) {
      r.recv_name = sib.recv_name; r.recv_hphone = sib.recv_hphone;
      r.recv_address = sib.recv_address; r.recv_postal_code = sib.recv_postal_code;
      r.recv_message = sib.recv_message;
    }
    toInsert.push(r);
  }
  out.markedExisting = toMark.length;
  out.receiverInherited = toInsert.filter(r => r.recv_name).length;

  const up = await store.upsertCoupangOrders(toInsert);
  out.upserted = up.upserted || toInsert.length;
  if (toMark.length) {
    try { out.markedExisting = (await store.markRocketGrowth(toMark)).marked; }
    catch (e) { console.warn('[rg-orders] 로켓그로스 표시 실패:', e.message); }
  }
  // 표시를 옮긴 뒤에 지운다 — 순서가 바뀌면 로켓그로스 표시가 사라진 채로 남는다
  if (toDedupe.length) {
    try { out.duplicatesRemoved = (await store.deleteRocketGrowthTwins(toDedupe)).deleted; }
    catch (e) { console.warn('[rg-orders] 중복 행 정리 실패:', e.message); }
  }

  // 로켓그로스 목록(coupang_rg_order_lines)에도 미리 띄운다 — 정산파일을 올리기 전에도
  //   "주문은 들어왔고 배송완료일은 아직 없다" 가 보여야 한다.
  //   금액·수수료·물류비는 리포트에만 있는 값이라 비워 둔다.
  //   없는 행만 만든다(ignore-duplicates) — 리포트가 이미 넣은 값을 되돌리면 안 된다.
  try {
    const missing = rows
      .filter(r => !r.raw_payload._has_report_line && r.paid_at)
      .map(r => ({
        order_id: r.coupang_order_id,
        vendor_item_id: r.vendor_item_id,
        // 결제일은 KST 기준 — UTC 문자열을 그대로 자르면 밤 주문이 하루 앞으로 밀린다
        paid_date: new Date(new Date(r.paid_at).getTime() + 9 * 3600 * 1000)
          .toISOString().slice(0, 10),
        product_name: r.product_name,
        seller_product_id: r.product_code || null,   // 옵션맵으로 이었으면 여기서 상품코드가 잡힌다
        sales_qty: r.raw_payload._cart_qty,
        is_cancel: r.status === 'CANCEL',
      }));
    const ins = await rfmStore.insertOrderLinesIfMissing(missing);
    out.linesCreated = ins.inserted || 0;
  } catch (e) {
    console.warn('[rg-orders] 매출 목록 선반영 실패:', e.message);
    out.linesCreated = 0;
  }

  // 정보입력현황 stub — 마켓플레이스 동기화와 같은 규칙 (CP-{주문ID}, 주문 단위 1행).
  //   이미 있으면 건드리지 않는다 (ignore-duplicates) — 운영이 손댄 상태를 지우지 않기 위해.
  const grouped = new Map();
  for (const r of rows) {
    if (r.status === 'CANCEL') continue;   // 취소건은 작업 대기열에 올릴 이유가 없다
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
    // 희망출고일을 넣지 않는다 — 로켓그로스는 쿠팡 물류센터가 출고한다.
    //   우리가 맞춰야 할 날짜가 없는데 값을 넣으면 지켜야 할 기한처럼 읽힌다.
    //   (판매자배송은 우리가 출고하므로 그쪽 stub 에는 그대로 들어간다)
    desired_ship_date: null,
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
        });
        patched++;
      } catch (e) {
        console.warn(`[rg-orders] stub enrichment 실패 ${s.order_id}: ${e.message}`);
      }
    }));
  }
  out.enriched = patched;

  // 앞선 버전이 넣어 둔 희망출고일 청소.
  //   우리가 계산해 넣은 값과 정확히 같을 때만 지운다 — 사람이 손으로 넣은 값은 남긴다.
  let cleared = 0;
  const stale = stubs.filter(s => {
    const cur = existing.get(s.order_id);
    if (!cur?.desired_ship_date) return false;
    const row = grouped.get(s.order_id)?.row;
    return row && cur.desired_ship_date === calcCoupangShipDate(row.ordered_at);
  });
  for (let i = 0; i < stale.length; i += 8) {
    await Promise.all(stale.slice(i, i + 8).map(async (s) => {
      try {
        await store.patchCoupangStubEnrichment(s.order_id, { desired_ship_date: null });
        cleared++;
      } catch (e) {
        console.warn(`[rg-orders] 희망출고일 정리 실패 ${s.order_id}: ${e.message}`);
      }
    }));
  }
  out.shipDateCleared = cleared;

  // 방금 로켓그로스 플래그가 생겼다 — 정산 리포트 라인의 판매 방식을 다시 가른다 (064).
  //   리포트에 판매자배송 주문이 섞여 있어, 가르지 않으면 그 매출이 로켓그로스로도 잡힌다.
  try {
    out.classified = await rfmStore.classifyOrderLines({ startDate, endDate });
  } catch (e) {
    console.warn('[rg-orders] 판매방식 분류 실패:', e.message);
  }
  return out;
}

module.exports = { syncRgOrders, buildUnitMap, kstNoon };
