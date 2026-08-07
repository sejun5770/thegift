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

/**
 * 대시보드용 매출 목록 — 주문 단위 라인(coupang_rg_order_lines)에서 만든다.
 *
 *   소스 일원화 (운영 결정 2026-08-07). 예전엔 coupang_rocket_growth_sales
 *   (일자×옵션 집계) 를 읽었는데, 업로드 리포트와 소스가 둘로 갈려 어긋났다.
 *   날짜 기준은 결제완료일(paid_date) — 파일1 의 '발생일(결제완료일)'.
 *
 *   반환 shape 은 옛 테이블과 동일하게 맞춘다 (호출측 3곳을 그대로 두기 위함):
 *     { sale_date, vendor_item_id, product_id, product_name,
 *       sales_qty, sales_amount, refund_qty, refund_amount }
 *
 *   취소 라인(is_cancel)은 금액·수량이 음수로 합산돼 있어 환불로 분리해 내려준다.
 */
async function listSales({ startDate, endDate } = {}) {
  if (!USE) return [];
  const params = ['paid_date=not.is.null'];
  if (startDate) params.push(`paid_date=gte.${startDate}`);
  if (endDate) params.push(`paid_date=lte.${endDate}`);
  params.push('order=paid_date.desc', 'limit=20000');
  const url = `${REST}/coupang_rg_order_lines?select=*&${params.join('&')}`;
  const res = await fetch(url, { headers: HDR });
  if (!res.ok) return [];
  const rows = await res.json();

  // (결제완료일, 옵션ID) 로 합쳐 옛 집계 단위와 같게 만든다 — 대시보드가 그 단위를 전제한다.
  const agg = new Map();
  for (const r of rows) {
    const key = `${r.paid_date}|${r.vendor_item_id}`;
    if (!agg.has(key)) {
      agg.set(key, {
        sale_date: r.paid_date,
        vendor_item_id: r.vendor_item_id,
        // 상품별 통계가 코드로 묶으므로 내부코드가 있으면 그걸 쓴다 (없으면 쿠팡 등록상품ID)
        product_id: r.seller_product_id || r.vendor_item_id || null,
        product_name: r.product_name || null,
        sales_qty: 0, sales_amount: 0, refund_qty: 0, refund_amount: 0,
      });
    }
    const a = agg.get(key);
    if (!a.product_name && r.product_name) a.product_name = r.product_name;
    const qty = Number(r.sales_qty) || 0;
    const amt = Number(r.sales_amount) || 0;
    // 취소분은 음수로 들어와 있다 — 환불로 분리해야 대시보드의 순매출 계산이 맞는다
    if (r.is_cancel || qty < 0 || amt < 0) {
      a.refund_qty += Math.abs(qty);
      a.refund_amount += Math.abs(amt);
    } else {
      a.sales_qty += qty;
      a.sales_amount += amt;
    }
  }
  return [...agg.values()].sort((x, y) => String(y.sale_date).localeCompare(String(x.sale_date)));
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


// ─────────────────────────────────────────────────────────────
// 주문 단위 라인 (migration 055) — 두 리포트를 (주문ID, 옵션ID) 로 합친다.
//   파일1 은 매출/수수료/정산 컬럼만, 파일2 는 배송완료일/물류비 컬럼만 담아 보낸다.
//   merge-duplicates 는 payload 에 있는 컬럼만 갱신하므로 상대 파일 값이 지워지지 않는다.
// ─────────────────────────────────────────────────────────────

async function upsertOrderLines(rows) {
  if (!USE) throw new Error('Supabase 미설정 — 주문 라인 저장 불가');
  if (!rows.length) return { upserted: 0 };
  const url = `${REST}/coupang_rg_order_lines?on_conflict=order_id,vendor_item_id`;
  // 한 번에 너무 크면 요청이 막힌다 — 500 행씩 끊는다
  let upserted = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500).map(r => ({ ...r, updated_at: new Date().toISOString() }));
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...HDR, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(chunk),
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`Supabase upsert rg_order_lines [${res.status}]: ${t.slice(0, 300)}`);
    }
    upserted += chunk.length;
  }
  return { upserted };
}

/** basis: 'paid'(결제완료일) | 'delivered'(배송완료일) */
async function listOrderLines({ basis = 'paid', startDate, endDate } = {}) {
  if (!USE) return [];
  const col = basis === 'delivered' ? 'delivered_date' : 'paid_date';
  const f = [`${col}=not.is.null`, `order=${col}.desc`, 'limit=5000'];
  if (startDate) f.push(`${col}=gte.${startDate}`);
  if (endDate) f.push(`${col}=lte.${endDate}`);
  const res = await fetch(`${REST}/coupang_rg_order_lines?${f.join('&')}`, { headers: HDR });
  if (!res.ok) throw new Error(`Supabase rg_order_lines [${res.status}]: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

module.exports = {
  upsertOrderLines,
  listOrderLines,
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
