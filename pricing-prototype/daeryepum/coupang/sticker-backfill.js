/**
 * 쿠팡 스티커 백필.
 *
 * 스티커는 주문 수집 시점에만 붙는다(option-mapper). 그래서 상품설정에 채널 코드·고정
 * 스티커를 나중에 넣으면 이미 들어온 주문은 그대로 빈다. 재동기화로 메우려 해도
 * 쿠팡 API 가 오래된/배송완료 주문을 다시 내려주지 않아 손이 닿지 않는다.
 *
 * 그래서 API 를 다시 부르지 않고, 이미 저장된 coupang_orders 를 훑어
 * bg_order_customer_info.sticker_selections 를 채운다. 조회 기간도 API 상태 제한도 무관하다.
 *
 * 안전 규칙:
 *   · 이미 값이 있는 sticker_code 는 절대 덮지 않는다 (운영자가 손댄 값일 수 있다)
 *   · 매핑이 없는 주문은 건너뛴다 — 넣을 값이 없다
 *   · product_code 는 원본 채널코드일 때만 내부코드로 바꾼다 (다른 값이면 손대지 않는다)
 *   · dryRun 이 기본. 실제 반영은 명시적으로 요청해야 한다
 */
'use strict';

const bgStore = require('../barungift/store');
const coupangStore = require('./store');
const { findChannelSticker } = require('./option-mapper');

/** 상품설정에서 채널 코드 → 내부 상품코드 역맵 (057 과 같은 우선순위) */
function buildCodeMaps(productSettings) {
  const byOption = new Map();
  const byProduct = new Map();
  for (const ps of productSettings || []) {
    const m = ps.channel_product_codes?.coupang;
    if (!m) continue;
    const pIds = Array.isArray(m) ? m : (m.product_ids || []);
    for (const c of pIds) byProduct.set(String(c).trim(), ps.product_id);
    for (const c of (Array.isArray(m) ? [] : (m.option_ids || []))) {
      byOption.set(String(c).trim(), ps.product_id);
    }
  }
  return { byOption, byProduct };
}

/**
 * @param {object} opts
 * @param {boolean} opts.dryRun  true 면 저장하지 않고 무엇이 바뀌는지만 돌려준다
 * @param {string}  opts.startDate / opts.endDate  주문일 범위 (없으면 전체)
 * @returns {{scanned, mapped, unmapped, patched, filledStickers, fixedCodes, samples, skipped}}
 */
async function backfillCoupangStickers({ dryRun = true, startDate = null, endDate = null } = {}) {
  const [orders, productSettings, stickers] = await Promise.all([
    coupangStore.listCoupangOrders({ startStr: startDate, endStr: endDate }),
    bgStore.getAllProductSettings().catch(() => []),
    bgStore.getAllStickers(true).catch(() => []),
  ]);
  const { byOption, byProduct } = buildCodeMaps(productSettings);
  const stickerByCode = new Map((stickers || [])
    .filter(s => s && s.sticker_code)
    .map(s => [String(s.sticker_code).trim(), s]));

  // 주문(CP-…) 단위로 묶는다 — ci 가 주문 단위이기 때문
  const byOrder = new Map();
  for (const r of (orders || [])) {
    const key = `CP-${r.coupang_order_id}`;
    if (!byOrder.has(key)) byOrder.set(key, []);
    byOrder.get(key).push(r);
  }

  const out = {
    scanned: byOrder.size, mapped: 0, unmapped: 0,
    patched: 0, filledStickers: 0, fixedCodes: 0, skipped: 0,
    samples: [],
  };

  for (const [orderId, items] of byOrder) {
    let ci;
    try { ci = await bgStore.getCustomerInfo(orderId); }
    catch { out.skipped++; continue; }
    if (!ci || !Array.isArray(ci.sticker_selections) || !ci.sticker_selections.length) {
      out.skipped++; continue;
    }

    // 이 주문의 (원본코드 → {내부코드, 스티커}) 후보
    const cand = [];
    for (const r of items) {
      const pc = String(r.product_code ?? '').trim();
      const oid = String(r.vendor_item_id ?? '').trim();
      const internal = byOption.get(oid) || byProduct.get(pc) || null;
      const sticker = findChannelSticker(productSettings, 'coupang', pc, oid);
      if (internal || sticker) out.mapped++; else out.unmapped++;
      cand.push({ pc, oid, internal, sticker });
    }
    if (!cand.some(c => c.internal || c.sticker)) continue;   // 넣을 값이 없다

    const sels = ci.sticker_selections.map(s => ({ ...s }));
    let changed = false;
    const before = [];
    sels.forEach(sel => {
      const code = String(sel.product_code ?? '').trim();
      // 원본 채널코드(등록상품ID/옵션ID) 또는 이미 내부코드인 행을 잡는다
      const hit = cand.find(c => code && (c.pc === code || c.oid === code || c.internal === code));
      if (!hit) return;
      // 스티커 — 비어 있을 때만 채운다
      if (!String(sel.sticker_code ?? '').trim() && hit.sticker) {
        before.push({ product_code: code, from: sel.sticker_code || null, to: hit.sticker });
        sel.sticker_code = hit.sticker;
        const meta = stickerByCode.get(hit.sticker);
        if (meta?.id) sel.sticker_id = meta.id;
        out.filledStickers++; changed = true;
      }
      // 상품코드 — 원본 채널코드일 때만 내부코드로
      if (hit.internal && (code === hit.pc || code === hit.oid) && code !== hit.internal) {
        sel.product_code = hit.internal;
        out.fixedCodes++; changed = true;
      }
    });
    if (!changed) continue;

    out.patched++;
    if (out.samples.length < 20) out.samples.push({ order_id: orderId, changes: before });
    if (!dryRun) {
      try { await bgStore.updateCustomerInfo(orderId, { sticker_selections: sels }); }
      catch (e) {
        out.patched--;
        out.samples.push({ order_id: orderId, error: e.message });
      }
    }
  }
  return { ...out, dry_run: dryRun };
}

module.exports = { backfillCoupangStickers, buildCodeMaps };
