/**
 * 옵션ID → 등록상품ID 맵 (063).
 *
 * 로켓그로스 주문 API 는 옵션ID 만 준다. 상품설정에는 대부분 등록상품ID 만 넣어 두어서,
 * 정산 리포트가 올라오기 전 주문은 상품코드가 통째로 '미매핑' 으로 남았다.
 * 쿠팡 상품 목록 API 가 등록상품 안에 옵션을 함께 내려주므로 그걸 미리 받아 다리를 놓는다.
 *
 * 이 표는 상품설정을 대체하지 않는다. 상품설정의 옵션ID 직접 매핑이 여전히 우선이고,
 * 그것이 없을 때만 등록상품ID 로 이어준다.
 */
'use strict';

const api = require('./api');

const REST = (process.env.SUPABASE_URL || '').replace(/\/$/, '') + '/rest/v1';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';
const USE = !!(process.env.SUPABASE_URL && KEY);
const HDR = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

/**
 * 상품 하나에서 (옵션ID, 옵션명, 판매유형) 을 훑는다.
 *   옵션은 items[].marketPlaceItem / items[].rocketGrowthItem 에 갈라져 들어온다.
 *   구조가 바뀌어도 items[].vendorItemId 를 함께 봐서 조용히 0건이 되지 않게 한다.
 */
function extractOptions(product) {
  const out = [];
  for (const it of (Array.isArray(product?.items) ? product.items : [])) {
    const name = it.itemName || it.vendorItemName || null;
    const push = (vid, type) => {
      const v = String(vid ?? '').trim();
      if (v) out.push({ vendor_item_id: v, item_name: name, business_type: type });
    };
    push(it.rocketGrowthItem?.vendorItemId, 'rocketGrowth');
    push(it.marketPlaceItem?.vendorItemId, 'marketPlace');
    push(it.vendorItemId, null);
  }
  return out;
}

async function upsertRows(rows) {
  if (!USE) throw new Error('Supabase 미설정 — 옵션 맵 저장 불가');
  if (!rows.length) return 0;
  const url = `${REST}/coupang_option_map?on_conflict=vendor_item_id`;
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
      throw new Error(`Supabase upsert option_map [${res.status}]: ${t.slice(0, 300)}`);
    }
    n += chunk.length;
  }
  return n;
}

/** 저장된 맵 — Map(옵션ID → 등록상품ID) */
async function getOptionToProduct() {
  if (!USE) return new Map();
  const res = await fetch(
    `${REST}/coupang_option_map?select=vendor_item_id,seller_product_id&limit=20000`,
    { headers: HDR });
  if (!res.ok) return new Map();
  const rows = await res.json();
  return new Map((rows || []).map(r => [String(r.vendor_item_id), String(r.seller_product_id)]));
}

/**
 * 쿠팡 상품 목록 → 맵 갱신.
 * @param {string} businessTypes 'rocketGrowth' 면 로켓그로스 상품만. 비우면 전체.
 */
async function syncOptionMap({ businessTypes = null } = {}) {
  if (!api.isConfigured()) throw new Error('Coupang API 키 미설정 (COUPANG_VENDOR_ID/ACCESS_KEY/SECRET_KEY)');
  const { items, pages, truncated } = await api.listAllSellerProducts({ businessTypes });
  const now = new Date().toISOString();
  const seen = new Set();
  const rows = [];
  let noOption = 0;
  for (const p of items) {
    const spid = String(p?.sellerProductId ?? '').trim();
    if (!spid) continue;
    const opts = extractOptions(p);
    if (!opts.length) { noOption++; continue; }
    for (const o of opts) {
      // 같은 옵션이 두 번 오면 upsert 가 통째로 실패한다 (ON CONFLICT 중복 키)
      if (seen.has(o.vendor_item_id)) continue;
      seen.add(o.vendor_item_id);
      rows.push({
        vendor_item_id: o.vendor_item_id,
        seller_product_id: spid,
        product_name: p.sellerProductName || null,
        item_name: o.item_name,
        business_type: o.business_type,
        synced_at: now,
      });
    }
  }
  const saved = await upsertRows(rows);
  return {
    products: items.length, options: rows.length, saved, pages, truncated,
    // 옵션을 못 찾은 상품 — 응답 구조가 또 달라졌는지 보는 신호
    productsWithoutOption: noOption,
    samples: rows.slice(0, 5),
    synced_at: now,
  };
}

module.exports = { syncOptionMap, getOptionToProduct, extractOptions, USE };
