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
  // 판매자배송 라인 제외 (064) — 그쪽은 coupang_orders 로 쿠팡 채널에 이미 집계된다.
  //   미확인(NULL)은 그대로 둔다. 빼면 그 매출이 어디에서도 안 잡힌다.
  //   서버 필터가 아니라 여기서 거른다 — 064 전이면 컬럼이 없어 PostgREST 가 400 을 낸다.
  const rows = (await res.json()).filter(r => r.fulfillment !== 'seller');

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
  // net_amount / net_qty — 옛 테이블의 파생 필드. 대시보드가 이 이름으로 읽는다.
  //   빠뜨리면 건수·수량은 나오는데 매출만 0 으로 뜬다 (2026-08-07 수정).
  return [...agg.values()]
    .map(a => ({
      ...a,
      net_amount: a.sales_amount - a.refund_amount,
      net_qty: a.sales_qty - a.refund_qty,
    }))
    .sort((x, y) => String(y.sale_date).localeCompare(String(x.sale_date)));
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

/**
 * 리포트 라인의 판매 방식 채우기 (064).
 *
 * 리포트에는 판매자배송 주문도 섞여 있는데 전체를 로켓그로스 매출로 집계해 왔다.
 * 판매자배송은 coupang_orders 로도 집계되므로 같은 매출이 두 번 잡힌다.
 * coupang_orders 의 is_rocket_growth 를 근거로 라인을 가른다.
 *
 * coupang_orders 에 없는 주문은 판단하지 않고 NULL 로 둔다 — 'seller' 로 찍으면
 * 그 매출이 어디에서도 안 잡혀 통째로 사라진다.
 *
 * @returns {{scanned, rocketGrowth, seller, unknown, updated}}
 */
async function classifyOrderLines({ startDate = null, endDate = null } = {}) {
  if (!USE) return { scanned: 0, rocketGrowth: 0, seller: 0, unknown: 0, updated: 0 };
  const lines = await listAllOrderLines({ startDate, endDate });
  if (!lines.length) return { scanned: 0, rocketGrowth: 0, seller: 0, unknown: 0, updated: 0 };

  // 주문ID → 로켓그로스 여부. 리포트에 있는 주문만 골라 조회한다.
  const ids = [...new Set(lines.map(l => String(l.order_id).trim()).filter(Boolean))];
  const flagById = new Map();
  for (let i = 0; i < ids.length; i += 200) {
    const inList = ids.slice(i, i + 200).join(',');
    const url = `${REST}/coupang_orders`
      + `?select=coupang_order_id,is_rocket_growth&coupang_order_id=in.(${inList})&limit=20000`;
    const res = await fetch(url, { headers: HDR });
    if (!res.ok) {
      // 062 마이그레이션 전이면 컬럼이 없어 400 — 분류를 건너뛴다 (기존 동작 유지)
      console.warn('[rfm-store] 판매방식 분류 조회 실패:', (await res.text()).slice(0, 200));
      return { scanned: lines.length, rocketGrowth: 0, seller: 0, unknown: lines.length, updated: 0 };
    }
    for (const r of await res.json()) {
      flagById.set(String(r.coupang_order_id), !!r.is_rocket_growth);
    }
  }

  const out = { scanned: lines.length, rocketGrowth: 0, seller: 0, unknown: 0, updated: 0 };
  const patch = [];
  for (const l of lines) {
    const flag = flagById.get(String(l.order_id).trim());
    const want = flag === undefined ? null : (flag ? 'rocket_growth' : 'seller');
    if (want === null) { out.unknown++; continue; }
    if (want === 'rocket_growth') out.rocketGrowth++; else out.seller++;
    if (l.fulfillment !== want) {
      patch.push({ order_id: l.order_id, vendor_item_id: l.vendor_item_id, fulfillment: want });
    }
  }
  // merge-duplicates 는 payload 에 있는 컬럼만 갱신한다 — 금액 컬럼은 건드리지 않는다
  for (let i = 0; i < patch.length; i += 500) {
    const chunk = patch.slice(i, i + 500);
    const res = await fetch(`${REST}/coupang_rg_order_lines?on_conflict=order_id,vendor_item_id`, {
      method: 'POST',
      headers: { ...HDR, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(chunk),
    });
    if (!res.ok) {
      throw new Error(`Supabase classify rg_order_lines [${res.status}]: ${(await res.text()).slice(0, 300)}`);
    }
    out.updated += chunk.length;
  }
  return out;
}

/**
 * 없는 행만 만든다 — 크론이 API 로 모은 주문을 목록에 미리 띄우기 위한 용도.
 *   ignore-duplicates 인 게 핵심이다. 리포트가 오면 그쪽이 정산 금액과 순수량(취소 상계 후)을
 *   갖고 있으므로 리포트가 이긴다. merge 로 쓰면 크론이 나중에 돌면서 원주문 수량으로
 *   되돌려 취소가 지워진다.
 */
async function insertOrderLinesIfMissing(rows) {
  if (!USE || !rows.length) return { inserted: 0 };
  const url = `${REST}/coupang_rg_order_lines?on_conflict=order_id,vendor_item_id`;
  let n = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...HDR, Prefer: 'resolution=ignore-duplicates,return=minimal' },
      body: JSON.stringify(chunk),
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`Supabase insert rg_order_lines [${res.status}]: ${t.slice(0, 300)}`);
    }
    n += chunk.length;
  }
  return { inserted: n };
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

/**
 * 날짜 축을 가리지 않고 전부 — 워크플로우 연동용.
 *   listOrderLines 는 basis 컬럼이 NULL 인 행을 잘라내는데,
 *   여기서는 배송완료일이 아직 없는 행(= 포장완료 대상)이 바로 그 대상이라 쓸 수 없다.
 *   기간을 주면 두 날짜 중 하나라도 범위에 들면 가져온다.
 */
async function listAllOrderLines({ startDate, endDate, limit = 20000 } = {}) {
  if (!USE) return [];
  const f = [`order=paid_date.desc.nullslast`, `limit=${limit}`];
  const range = (col) => {
    const parts = [];
    if (startDate) parts.push(`${col}.gte.${startDate}`);
    if (endDate) parts.push(`${col}.lte.${endDate}`);
    return parts.length > 1 ? `and(${parts.join(',')})` : parts[0];
  };
  if (startDate || endDate) f.push(`or=(${range('paid_date')},${range('delivered_date')})`);
  const res = await fetch(`${REST}/coupang_rg_order_lines?${f.join('&')}`, { headers: HDR });
  if (!res.ok) throw new Error(`Supabase rg_order_lines [${res.status}]: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

module.exports = {
  upsertOrderLines,
  insertOrderLinesIfMissing,
  classifyOrderLines,
  listOrderLines,
  listAllOrderLines,
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
