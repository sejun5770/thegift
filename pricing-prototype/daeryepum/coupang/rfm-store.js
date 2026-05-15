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
  listSales,
  getSyncState,
  updateSyncState,
  getDailySalesMap,
};
