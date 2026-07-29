/**
 * 쿠팡 로켓 그로스 매출 store — Supabase coupang_rocket_growth_sales / sync_state CRUD.
 */
'use strict';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || '';
const USE = !!(SUPABASE_URL && SUPABASE_KEY);
const REST = `${SUPABASE_URL}/rest/v1`;
const HDR = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
};

async function upsertSales(rows) {
  if (!USE || !rows.length) return { upserted: 0 };
  const url = `${REST}/coupang_rocket_growth_sales?on_conflict=sale_date,vendor_item_id`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...HDR, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Supabase upsert rg_sales [${res.status}]: ${t.slice(0, 300)}`);
  }
  return { upserted: rows.length };
}

/**
 * 지정 날짜들의 수동 입력(_manual) 합계 행 삭제.
 *   정산 리포트 업로드로 같은 날짜의 상품별 매출이 들어오면, 기존 일별 합계 행이 남아 있을 때
 *   같은 매출이 두 번 잡힌다(이중 계상). 업로드 직전에 해당 날짜 범위의 _manual 행만 제거한다.
 */
async function deleteManualSalesByDates(dates) {
  if (!USE || !Array.isArray(dates) || !dates.length) return { deleted: 0 };
  const inList = [...new Set(dates)].map(d => `"${d}"`).join(',');
  const url = `${REST}/coupang_rocket_growth_sales`
    + `?vendor_item_id=eq._manual&sale_date=in.(${encodeURIComponent(inList)})`;
  const res = await fetch(url, { method: 'DELETE', headers: { ...HDR, Prefer: 'return=representation' } });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Supabase delete _manual [${res.status}]: ${t.slice(0, 300)}`);
  }
  const rows = await res.json().catch(() => []);
  return { deleted: Array.isArray(rows) ? rows.length : 0 };
}

/**
 * 수동 입력 단일 row upsert — Coupang Open API 가 RFM 매출 노출 안 해서 운영자가 Wing
 *   셀러센터 보고 직접 입력하는 path. vendor_item_id 는 '_manual' 고정 (날짜당 1 row).
 *   같은 날 재제출 시 덮어씀.
 */
async function upsertManualSale({ sale_date, sales_amount = 0, sales_qty = 0, refund_amount = 0, refund_qty = 0, product_name = '로켓그로스 일별 매출', by = null } = {}) {
  if (!USE) throw new Error('Supabase 미설정');
  if (!sale_date) throw new Error('sale_date 필수');
  const row = {
    sale_date,
    vendor_item_id: '_manual',
    product_id: null,
    product_name,
    sales_qty: Number(sales_qty) || 0,
    sales_amount: Number(sales_amount) || 0,
    refund_qty: Number(refund_qty) || 0,
    refund_amount: Number(refund_amount) || 0,
    raw_payload: { source: 'manual', entered_by: by, entered_at: new Date().toISOString() },
  };
  const url = `${REST}/coupang_rocket_growth_sales?on_conflict=sale_date,vendor_item_id`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...HDR, Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Supabase upsert manual rg_sales [${res.status}]: ${t.slice(0, 300)}`);
  }
  const rows = await res.json();
  return rows[0] || row;
}

/** id 기반 단일 row 삭제. */
async function deleteSaleById(id) {
  if (!USE) throw new Error('Supabase 미설정');
  if (!id) throw new Error('id 필수');
  const url = `${REST}/coupang_rocket_growth_sales?id=eq.${encodeURIComponent(id)}`;
  const res = await fetch(url, { method: 'DELETE', headers: HDR });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Supabase delete rg_sales [${res.status}]: ${t.slice(0, 300)}`);
  }
  return { ok: true };
}

async function listSales({ startDate, endDate } = {}) {
  if (!USE) return [];
  const params = [];
  if (startDate) params.push(`sale_date=gte.${startDate}`);
  if (endDate) params.push(`sale_date=lte.${endDate}`);
  params.push('order=sale_date.desc');
  const url = `${REST}/coupang_rocket_growth_sales?select=*&${params.join('&')}`;
  const res = await fetch(url, { headers: HDR });
  if (!res.ok) return [];
  return res.json();
}

async function getSyncState() {
  if (!USE) return null;
  const url = `${REST}/coupang_rocket_growth_sync_state?id=eq.1&select=*`;
  const res = await fetch(url, { headers: HDR });
  if (!res.ok) return null;
  const rows = await res.json();
  return rows[0] || null;
}

async function updateSyncState(patch) {
  if (!USE) return null;
  const url = `${REST}/coupang_rocket_growth_sync_state?id=eq.1`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { ...HDR, Prefer: 'return=representation' },
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Supabase update rg_sync_state [${res.status}]: ${t.slice(0, 300)}`);
  }
  const rows = await res.json();
  return rows[0] || null;
}

/**
 * 일별 매출 합계 — 대시보드 합산용. 채널/상품 무관.
 *   { sale_date: { sales_amount, sales_qty, net_amount } }
 */
async function getDailySalesMap({ startDate, endDate } = {}) {
  const rows = await listSales({ startDate, endDate });
  const m = new Map();
  for (const r of rows) {
    const d = r.sale_date;
    const prev = m.get(d) || { sales_amount: 0, sales_qty: 0, refund_amount: 0, net_amount: 0 };
    prev.sales_amount += Number(r.sales_amount) || 0;
    prev.sales_qty += Number(r.sales_qty) || 0;
    prev.refund_amount += Number(r.refund_amount) || 0;
    prev.net_amount += Number(r.net_amount) || 0;
    m.set(d, prev);
  }
  return m;
}

module.exports = {
  USE,
  upsertSales,
  upsertManualSale,
  deleteManualSalesByDates,
  deleteSaleById,
  listSales,
  getSyncState,
  updateSyncState,
  getDailySalesMap,
};
