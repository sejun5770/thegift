/**
 * 로켓창고(쿠팡 물류센터) 재고 동기화.
 *
 * 쿠팡 Open API 의 로켓그로스 API 9종에 입고 관련 엔드포인트는 없다 (2026-08 확인).
 * 대신 재고 API 가 "지금 팔 수 있는 수량" 을 주므로 그것을 가져와 스냅샷으로 남긴다.
 * 재입고 판단에는 "얼마나 밀어넣었나" 보다 "얼마나 남았나" 가 직접적이다.
 *
 * 단위 주의: API 의 totalOrderableQuantity 는 옵션(vendorItemId) 단위다.
 *   쿠팡에서 10개 묶음으로 파는 상품이면 1 = 실제 10개다.
 *   그래서 채널 판매단위(060)를 곱해 실제 개수를 따로 낸다.
 */
'use strict';

const api = require('./api');
const bgStore = require('../barungift/store');

const REST = (process.env.SUPABASE_URL || '').replace(/\/$/, '') + '/rest/v1';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';
const USE = !!(process.env.SUPABASE_URL && KEY);
const HDR = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

/**
 * 상품설정 → 옵션ID/등록상품ID 별 { 내부코드, 판매단위 }.
 *   057 과 같은 우선순위 (옵션ID > 등록상품ID).
 */
function buildOptionMap(productSettings) {
  const byOption = new Map();
  const byProduct = new Map();
  for (const ps of productSettings || []) {
    const m = ps.channel_product_codes?.coupang;
    if (!m) continue;
    const unit = parseInt(ps.channel_sales_units?.coupang, 10);
    const info = { code: ps.product_id, unit: unit > 1 ? unit : 1 };
    const pIds = Array.isArray(m) ? m : (m.product_ids || []);
    for (const c of pIds) byProduct.set(String(c).trim(), info);
    for (const c of (Array.isArray(m) ? [] : (m.option_ids || []))) {
      byOption.set(String(c).trim(), info);
    }
  }
  return { byOption, byProduct };
}

async function upsertRows(rows) {
  if (!USE) throw new Error('Supabase 미설정 — 재고 스냅샷 저장 불가');
  if (!rows.length) return 0;
  const url = `${REST}/coupang_rg_inventory?on_conflict=vendor_item_id`;
  let n = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...HDR, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(chunk),
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`Supabase upsert rg_inventory [${res.status}]: ${t.slice(0, 300)}`);
    }
    n += chunk.length;
  }
  return n;
}

/** 저장된 스냅샷 전체 */
async function listInventory() {
  if (!USE) return [];
  const res = await fetch(`${REST}/coupang_rg_inventory?order=orderable_qty.asc&limit=5000`, { headers: HDR });
  if (!res.ok) throw new Error(`Supabase rg_inventory [${res.status}]: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/**
 * 내부 매출코드 → { qty, itemQty, unit, options } 맵.
 *   한 내부코드에 옵션이 여러 개 걸릴 수 있어 합산한다 (변형코드 _A/_B 등).
 *   재고 화면이 매번 다시 매핑하므로, 스냅샷에 굳어 있는 코드가 아니라
 *   지금의 상품설정을 기준으로 붙인다 — 설정을 고치면 화면이 바로 따라온다.
 */
async function getInventoryByProductCode() {
  const [rows, settings] = await Promise.all([
    listInventory().catch(() => []),
    bgStore.getAllProductSettings().catch(() => []),
  ]);
  const { byOption, byProduct } = buildOptionMap(settings);
  const out = new Map();
  for (const r of rows) {
    const hit = byOption.get(String(r.vendor_item_id || '').trim())
      || byProduct.get(String(r.external_sku_id || '').trim());
    if (!hit) continue;
    const qty = Number(r.orderable_qty) || 0;
    const prev = out.get(hit.code) || { qty: 0, item_qty: 0, unit: hit.unit, options: 0, synced_at: null };
    prev.qty += qty;
    prev.item_qty += qty * hit.unit;
    prev.options++;
    if (!prev.synced_at || (r.synced_at && r.synced_at > prev.synced_at)) prev.synced_at = r.synced_at;
    out.set(hit.code, prev);
  }
  return out;
}

/**
 * 쿠팡 API → 스냅샷 저장.
 * @returns {{fetched, saved, mapped, unmapped, truncated, samples}}
 */
async function syncRgInventory() {
  if (!api.isConfigured()) throw new Error('Coupang API 키 미설정 (COUPANG_VENDOR_ID/ACCESS_KEY/SECRET_KEY)');
  const [{ items, pages, truncated }, settings] = await Promise.all([
    api.listAllRgInventory(),
    bgStore.getAllProductSettings().catch(() => []),
  ]);
  const { byOption, byProduct } = buildOptionMap(settings);
  const now = new Date().toISOString();

  const seen = new Set();
  const rows = [];
  let mapped = 0, unmapped = 0;
  for (const it of items) {
    const vid = String(it.vendorItemId ?? '').trim();
    if (!vid || seen.has(vid)) continue;    // 같은 옵션이 두 번 오면 upsert 가 통째로 실패한다
    seen.add(vid);
    const sku = String(it.externalSkuId ?? '').trim() || null;
    const hit = byOption.get(vid) || (sku ? byProduct.get(sku) : null);
    if (hit) mapped++; else unmapped++;
    rows.push({
      vendor_item_id: vid,
      external_sku_id: sku,
      internal_product_code: hit?.code || null,
      orderable_qty: Number(it.inventoryDetails?.totalOrderableQuantity) || 0,
      sales_unit: hit?.unit || 1,
      sales_count_30d: Number(it.salesCountMap?.SALES_COUNT_LAST_THIRTY_DAYS) || 0,
      synced_at: now,
    });
  }
  const saved = await upsertRows(rows);
  return {
    fetched: items.length, saved, mapped, unmapped, pages, truncated,
    synced_at: now,
    samples: rows.filter(r => !r.internal_product_code).slice(0, 10),
  };
}

module.exports = {
  syncRgInventory,
  listInventory,
  getInventoryByProductCode,
  buildOptionMap,
  USE,
};
