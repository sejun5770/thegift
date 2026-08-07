/**
 * 로켓그로스 리포트 → 정보입력현황 워크플로우 연동.
 *
 * 로켓그로스는 쿠팡 물류센터가 출고한다. 우리 쪽에서 송장을 끊는 일이 없어
 * 정보입력현황의 단계가 영원히 초기 상태로 남는다. 실제로 나간 물건인데
 * 화면에는 대기 중인 것처럼 보이는 셈이다.
 *
 * 그래서 업로드된 정산 리포트를 실제 진행 상태로 삼는다.
 *   · 배송완료일이 있다  → 출고완료 (그 날짜로)
 *   · 배송완료일이 없다  → 포장완료 (쿠팡 물류센터에 있는 것으로 본다)
 *
 * 안전 규칙:
 *   · 앞으로만 간다 — 이미 더 진행된 행은 손대지 않는다 (되돌리기는 운영자 몫)
 *   · 취소 라인은 건너뛴다
 *   · 송장(bg_order_invoices) 은 만들지 않는다 — 우리가 끊은 송장이 아니다
 *   · dryRun 이 기본
 */
'use strict';

const rfmStore = require('./rfm-store');
const wf = require('../barungift/workflow-store');
const bgStore = require('../barungift/store');
const { buildCodeMaps } = require('./sticker-backfill');

// 워크플로우 단계 순서 — 뒤로 가지 않도록 비교에 쓴다
const ORDER = ['sticker_completed', 'printed', 'bound', 'packed', 'shipped'];

/** 현재 selection 이 어디까지 갔는지 (인덱스, 아무것도 없으면 -1) */
function stageIndex(sel) {
  for (let i = ORDER.length - 1; i >= 0; i--) {
    if (sel[`${ORDER[i]}_at`]) return i;
  }
  return -1;
}

/**
 * 'YYYY-MM-DD' → 그 날 정오(KST) ISO.
 *   자정으로 잡으면 UTC 변환에서 하루 앞으로 밀려 화면에 전날로 찍힌다.
 */
function kstNoon(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ''))) return new Date().toISOString();
  return new Date(`${dateStr}T12:00:00+09:00`).toISOString();
}

/**
 * @param {object} opts
 * @param {boolean} opts.dryRun  true 면 저장하지 않고 무엇이 바뀌는지만 돌려준다
 * @param {string}  opts.startDate / opts.endDate  결제완료일·배송완료일 범위
 * @param {string}  opts.by  진행 처리자 표기
 */
async function syncRocketGrowthWorkflow({
  dryRun = true, startDate = null, endDate = null, by = 'system:rocket-growth',
} = {}) {
  const [lines, productSettings] = await Promise.all([
    rfmStore.listAllOrderLines({ startDate, endDate }),
    bgStore.getAllProductSettings().catch(() => []),
  ]);
  const { byOption, byProduct } = buildCodeMaps(productSettings);

  // 주문 단위로 묶는다 — customer_info 가 주문 단위이기 때문
  const byOrder = new Map();
  for (const r of (lines || [])) {
    if (r.is_cancel) continue;
    const key = `CP-${r.order_id}`;
    if (!byOrder.has(key)) byOrder.set(key, []);
    byOrder.get(key).push(r);
  }

  const out = {
    scanned: byOrder.size, noCustomerInfo: 0, alreadyDone: 0,
    toShipped: 0, toPacked: 0, patchedOrders: 0, failed: 0,
    samples: [],
  };

  for (const [orderId, items] of byOrder) {
    let ci;
    try { ci = await wf.getCustomerInfoForUpdate(orderId); }
    catch { out.failed++; continue; }
    if (!ci || !Array.isArray(ci.sticker_selections) || !ci.sticker_selections.length) {
      out.noCustomerInfo++; continue;
    }

    // 라인마다 목표 단계 — 배송완료일이 있으면 출고완료, 없으면 포장완료
    const targets = items.map(r => ({
      target: r.delivered_date ? 'shipped' : 'packed',
      at: kstNoon(r.delivered_date || r.paid_date),
      internal: byOption.get(String(r.vendor_item_id ?? '').trim())
        || byProduct.get(String(r.seller_product_id ?? '').trim())
        || null,
      pc: String(r.seller_product_id ?? '').trim(),
      oid: String(r.vendor_item_id ?? '').trim(),
    }));
    // 주문 안의 라인이 모두 같은 목표면, 코드가 안 맞는 행도 같은 목표로 본다.
    //   (한 주문 안에서 일부만 배송완료인 경우에만 코드 매칭이 필요하다)
    const uniform = targets.every(t => t.target === targets[0].target) ? targets[0] : null;

    const sels = ci.sticker_selections.map(s => ({ ...s }));
    let changed = false;
    const changes = [];
    sels.forEach((sel, i) => {
      const code = String(sel.product_code ?? '').trim();
      const hit = targets.find(t => code && (t.internal === code || t.pc === code || t.oid === code))
        || uniform;
      if (!hit) return;
      const targetIdx = ORDER.indexOf(hit.target);
      const curIdx = stageIndex(sel);
      if (curIdx >= targetIdx) { return; }          // 이미 그만큼 갔다 — 뒤로 보내지 않는다
      // 목표까지의 빈 단계를 채운다 (이미 찍힌 시각은 그대로 둔다)
      for (let s = 0; s <= targetIdx; s++) {
        const k = ORDER[s];
        if (!sel[`${k}_at`]) {
          sel[`${k}_at`] = hit.at;
          sel[`${k}_by`] = by;
        }
      }
      changes.push({ index: i, product_code: code || null, from: ORDER[curIdx] || 'submitted', to: hit.target });
      if (hit.target === 'shipped') out.toShipped++; else out.toPacked++;
      changed = true;
    });

    if (!changed) { out.alreadyDone++; continue; }
    out.patchedOrders++;
    if (out.samples.length < 20) out.samples.push({ order_id: orderId, changes });
    if (!dryRun) {
      try { await wf.updateCustomerInfo(ci._resolvedOrderId || orderId, { sticker_selections: sels }); }
      catch (e) {
        out.patchedOrders--; out.failed++;
        out.samples.push({ order_id: orderId, error: e.message });
      }
    }
  }
  return { ...out, dry_run: dryRun };
}

module.exports = { syncRocketGrowthWorkflow, stageIndex, kstNoon };
