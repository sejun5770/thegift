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
        // 주문 건수를 세려면 주문ID 가 필요하다. 이 집계 단위는 (날짜 × 옵션) 이라
        //   행 수를 세면 상품 종류 수가 나온다 — 한 주문에 상품이 여럿이면 부풀려진다.
        order_ids: [],
      });
    }
    const a = agg.get(key);
    if (!a.product_name && r.product_name) a.product_name = r.product_name;
    const qty = Number(r.sales_qty) || 0;
    const amt = Number(r.sales_amount) || 0;
    // 주문 건수에서 취소는 뺀다 — 다른 채널도 취소 제외 순 기준이라 그쪽에 맞춘다.
    //   전체취소만 뺀다: 부분취소는 순액이 남아 주문 자체는 살아 있다.
    //   한 주문에 상품이 여럿이면 살아 있는 상품이 하나라도 있는 한 그 주문은 잡힌다.
    const fullyCancelled = !!r.is_cancel && qty <= 0 && amt <= 0;
    if (r.order_id && !fullyCancelled) a.order_ids.push(String(r.order_id));
    // 취소분은 부호로 가른다. is_cancel 을 조건에 넣으면 안 된다 —
    //   파서가 이미 (주문, 옵션) 안에서 정산 + 정산취소를 상계해 순액으로 만들어 두는데,
    //   부분취소라 순액이 양수로 남은 라인까지 환불로 보내면 그 매출이 사라지고
    //   오히려 음수로 빠진다 (2026-08-12 수정).
    //   전체취소는 순액 0 이라 어느 쪽으로 가든 결과가 같다.
    if (qty < 0 || amt < 0) {
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
      order_ids: [...new Set(a.order_ids)],
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

// ── 마진 시뮬레이션 저장값 (migration 069) ─────────────────────────────
//   판매단위(옵션ID)별 판매가·원가·입고비 가정치와 목표 마진율.
//   NULL 컬럼은 '기본값(실적/상품설정) 사용' 이므로 upsert 시 빈 값도 명시적으로 NULL 로 보낸다 —
//   빼먹으면 merge-duplicates 가 이전 값을 남겨 지운 가정치가 되살아난다.

const SIM_FIELDS = ['sim_price', 'sim_unit_cost', 'sim_inbound_cost', 'target_margin_rate'];

function _simNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 옵션ID → 저장된 가정치 */
async function listMarginSims() {
  if (!USE) return [];
  const res = await fetch(`${REST}/coupang_rg_margin_sim?select=*&limit=5000`, { headers: HDR });
  if (!res.ok) {
    const t = await res.text();
    // 테이블이 아직 없으면(069 미실행) 빈 목록 — 화면은 저장 없이도 동작해야 한다
    if (res.status === 404 || /relation .* does not exist|PGRST205/.test(t)) return [];
    throw new Error(`Supabase list rg_margin_sim [${res.status}]: ${t.slice(0, 300)}`);
  }
  return res.json();
}

/**
 * 가정치 일괄 저장 — 옵션ID 기준 upsert.
 *   rows: [{ vendor_item_id, sim_price, sim_unit_cost, sim_inbound_cost, target_margin_rate, memo,
 *            seller_product_id, internal_product_code, product_name }]
 *   네 가정치가 모두 NULL 이고 memo 도 없으면 행을 지운다 (빈 행이 쌓이지 않게).
 */
async function saveMarginSims(rows, by = null) {
  if (!USE) throw new Error('Supabase 미설정 — 시뮬레이션 저장은 Supabase 가 필요합니다');
  const upserts = [];
  const deletes = [];
  for (const r of rows || []) {
    const vid = String(r.vendor_item_id || '').trim();
    if (!vid) continue;
    const rec = {
      vendor_item_id: vid,
      seller_product_id: r.seller_product_id ? String(r.seller_product_id) : null,
      internal_product_code: r.internal_product_code ? String(r.internal_product_code) : null,
      product_name: r.product_name ? String(r.product_name).slice(0, 300) : null,
      memo: r.memo ? String(r.memo).slice(0, 500) : null,
      updated_by: by,
      updated_at: new Date().toISOString(),
    };
    for (const f of SIM_FIELDS) rec[f] = _simNum(r[f]);
    const empty = SIM_FIELDS.every(f => rec[f] === null) && !rec.memo;
    (empty ? deletes : upserts).push(empty ? vid : rec);
  }
  let saved = 0, removed = 0;
  if (upserts.length) {
    const res = await fetch(`${REST}/coupang_rg_margin_sim?on_conflict=vendor_item_id`, {
      method: 'POST',
      headers: { ...HDR, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(upserts),
    });
    if (!res.ok) throw new Error(`Supabase upsert rg_margin_sim [${res.status}]: ${(await res.text()).slice(0, 300)}`);
    saved = upserts.length;
  }
  if (deletes.length) {
    const inList = deletes.map(v => `"${v.replace(/"/g, '')}"`).join(',');
    const res = await fetch(`${REST}/coupang_rg_margin_sim?vendor_item_id=in.(${encodeURIComponent(inList)})`, {
      method: 'DELETE', headers: { ...HDR, Prefer: 'return=minimal' },
    });
    if (!res.ok) throw new Error(`Supabase delete rg_margin_sim [${res.status}]: ${(await res.text()).slice(0, 300)}`);
    removed = deletes.length;
  }
  return { saved, removed };
}

// ── 판매단위 기획 (migration 070) ──────────────────────────────────────
//   아직 없는 판매단위를 설계해 마진을 비교하는 표. 069(실재 옵션 실적)와 축이 다르다.

const PLAN_NUM_FIELDS = [
  'price', 'unit_cost', 'inbound_cost', 'inout_fee', 'ship_fee',
  'commission_rate', 'deduct_rate', 'target_margin_rate',
];

/** 070 의 plan_key 생성컬럼과 같은 규칙 — 한 요청 안의 중복을 미리 잡기 위해 JS 로도 만든다.
 *    COALESCE(NULLIF(btrim(product_code),''), '이름:'||btrim(product_name)) || '|' || sales_unit || '|' || btrim(plan_label) */
function _planKey(code, name, unit, label) {
  const c = String(code || '').trim();
  const head = c || ('이름:' + String(name || '').trim());
  return `${head}|${unit}|${String(label || '기본안').trim()}`;
}

function _planNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[,\s원]/g, ''));
  return Number.isFinite(n) ? n : null;
}

async function listUnitPlans() {
  if (!USE) return [];
  const res = await fetch(`${REST}/coupang_rg_unit_plan?select=*&order=product_name.asc,sales_unit.asc,plan_label.asc&limit=2000`, { headers: HDR });
  if (!res.ok) {
    const t = await res.text();
    // 070 미실행이면 빈 목록 — 화면은 저장 없이도 동작해야 한다
    if (res.status === 404 || /does not exist|PGRST205/.test(t)) return [];
    throw new Error(`Supabase list rg_unit_plan [${res.status}]: ${t.slice(0, 300)}`);
  }
  return res.json();
}

/** 행 일괄 저장 (upsert). plan_key = (상품, 판매단위, 안 이름) 중복은 갱신. */
async function saveUnitPlans(rows, by = null) {
  if (!USE) throw new Error('Supabase 미설정 — 기획 저장은 Supabase 가 필요합니다');
  const recs = [];
  for (const r of rows || []) {
    const name = String(r.product_name || '').trim();
    if (!name) continue;                       // 이름 없는 행은 저장하지 않는다
    const unit = Math.max(1, parseInt(r.sales_unit, 10) || 1);
    const rec = {
      product_code: r.product_code ? String(r.product_code).trim() : null,
      product_name: name.slice(0, 200),
      sales_unit: unit,
      plan_label: String(r.plan_label || '기본안').trim().slice(0, 60) || '기본안',
      etc_cost: _planNum(r.etc_cost) ?? 0,
      vat_rate: _planNum(r.vat_rate) ?? 0.1,
      price_vat_included: r.price_vat_included !== false,
      fulfill_basis: r.fulfill_basis ? String(r.fulfill_basis).slice(0, 400) : null,
      fulfill_estimated: !!r.fulfill_estimated,
      memo: r.memo ? String(r.memo).slice(0, 500) : null,
      sort_order: parseInt(r.sort_order, 10) || 0,
      updated_by: by,
      updated_at: new Date().toISOString(),
    };
    // 빈 값도 명시적으로 NULL 로 보낸다 — merge-duplicates 가 지운 값을 되살리지 않게
    for (const f of PLAN_NUM_FIELDS) rec[f] = _planNum(r[f]);
    if (r.id) rec.id = String(r.id);
    recs.push(rec);
  }
  if (!recs.length) return { saved: 0 };
  // 한 요청에 plan_key 가 같은 행이 둘 이상이면 Postgres 가
  //   'ON CONFLICT DO UPDATE command cannot affect row a second time' (21000) 로 죽는다.
  //   원문 대신 어느 조합이 겹쳤는지 알려준다 — 화면에서 안 이름만 바꾸면 되기 때문.
  const seen = new Map();
  const dups = [];
  for (const rec of recs) {
    const k = _planKey(rec.product_code, rec.product_name, rec.sales_unit, rec.plan_label);
    if (seen.has(k)) dups.push(`${rec.product_name} / ${rec.sales_unit}개 / ${rec.plan_label}`);
    else seen.set(k, rec);
  }
  if (dups.length) {
    throw new Error(`같은 조합이 여러 행에 있습니다 — ${[...new Set(dups)].join(', ')}. `
      + `같은 상품·판매단위를 여러 안으로 비교하려면 '안' 이름을 다르게 지어주세요.`);
  }
  const res = await fetch(`${REST}/coupang_rg_unit_plan?on_conflict=plan_key`, {
    method: 'POST',
    headers: { ...HDR, Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(recs),
  });
  if (!res.ok) {
    const t = await res.text();
    if (/23505|duplicate key/.test(t)) {
      throw new Error('같은 (상품, 판매단위, 안 이름) 조합이 이미 있습니다 — 안 이름을 다르게 지어주세요');
    }
    throw new Error(`Supabase upsert rg_unit_plan [${res.status}]: ${t.slice(0, 300)}`);
  }
  return { saved: recs.length, rows: await res.json() };
}

async function deleteUnitPlan(id) {
  if (!USE) throw new Error('Supabase 미설정');
  const res = await fetch(`${REST}/coupang_rg_unit_plan?id=eq.${encodeURIComponent(id)}`, {
    method: 'DELETE', headers: { ...HDR, Prefer: 'return=minimal' },
  });
  if (!res.ok) throw new Error(`Supabase delete rg_unit_plan [${res.status}]: ${(await res.text()).slice(0, 300)}`);
  return { ok: true };
}

/**
 * 상품별 풀필먼트 기본값 — "상품 기준으로 부과된 기존 값" 의 구현.
 *
 * ⚠ 유료 청구 라인만 표본으로 쓴다.
 *   쿠팡이 물류비를 전액 할인해 주는 기간이 있고(파서가 '최종비용'=실부담액을 읽는다),
 *   그 구간 라인은 0원이 정상값이다. 이걸 섞으면 최빈값이 0원으로 고정돼
 *   물류비가 통째로 사라진 마진이 나온다 (실측: 855행 중 780행이 0원 구간).
 *
 * 옵션 간 평균을 내지 않고 대표 옵션 하나를 고른다.
 *   실측상 물류비는 부피·무게 등급표라(10세트 1,650/2,200 · 낱개 980/1,125 · 액자 800/1,350)
 *   등급이 다른 옵션을 평균하면 실제로 청구된 적 없는 중간값이 나온다.
 *
 * 반환: { defaults: {상품코드: {...}}, fallback: {...}, sampled_from, paid_from }
 */
async function fulfillmentDefaults(lines) {
  const byProduct = new Map();
  let paidFrom = null, paidTo = null;
  for (const l of lines || []) {
    if (l.is_cancel) continue;
    const code = String(l.internal_product_code || '').trim();
    if (!code) continue;
    if (!byProduct.has(code)) {
      byProduct.set(code, { code, paid: [], all: 0, zero: 0, sales: 0, commission: 0, settlement: 0, salesLines: 0 });
    }
    const g = byProduct.get(code);
    // 수수료·차감율은 매출이 있는 라인 전체에서 (물류비 유무와 무관)
    if (Number(l.sales_amount) > 0) {
      g.sales += Number(l.sales_amount) || 0;
      g.commission += Number(l.commission) || 0;
      g.settlement += Number(l.settlement_amount) || 0;
      g.salesLines++;
    }
    const inout = Number(l.inout_fee);
    const ship = Number(l.shipping_fee);
    const qty = Number(l.sales_qty);
    if (l.inout_fee == null && l.shipping_fee == null) continue;   // 물류비 리포트 미도착
    g.all++;
    if (!(inout > 0) && !(ship > 0)) { g.zero++; continue; }        // 전액할인 구간
    if (!(qty > 0)) continue;                                       // 0 나눗셈 방지
    g.paid.push({ vid: String(l.vendor_item_id || ''), inout, ship, qty, date: l.delivered_date || null });
    if (l.delivered_date) {
      if (!paidFrom || l.delivered_date < paidFrom) paidFrom = l.delivered_date;
      if (!paidTo || l.delivered_date > paidTo) paidTo = l.delivered_date;
    }
  }

  const mode = (arr) => {
    const c = new Map();
    for (const v of arr) {
      const k = Math.round(v);
      if (!Number.isFinite(k)) continue;
      c.set(k, (c.get(k) || 0) + 1);
    }
    let best = null, bestN = 0;
    for (const [k, n] of c) if (n > bestN) { best = k; bestN = n; }
    return best;
  };

  const defaults = {};
  const paidInouts = [], paidShips = [];
  for (const g of byProduct.values()) {
    // 매출 대비 실효 차감율 — 수수료 외 판매자 부담(쿠팡 할인 분담 등)까지 포함한다.
    //   Σ수수료÷Σ매출 만 쓰면 정산에서 더 빠지는 항목이 모델에 없어 마진이 낙관적으로 나온다.
    const commRate = g.sales > 0 ? g.commission / g.sales : null;
    const deductRate = (g.sales > 0 && g.settlement > 0) ? (g.sales - g.settlement) / g.sales : commRate;

    if (!g.paid.length) {
      defaults[g.code] = {
        inout_fee: null, ship_fee: null,
        deduct_rate: deductRate, comm_rate: commRate,
        estimated: true,
        basis: g.all
          ? `유료 청구 표본 0건 — 물류비 전액할인 구간만 ${g.zero}건`
          : '물류비 정산 리포트 없음',
      };
      continue;
    }
    // 대표 옵션 = 유료 표본의 판매수량 합이 가장 큰 옵션
    const byOpt = new Map();
    for (const p of g.paid) {
      if (!byOpt.has(p.vid)) byOpt.set(p.vid, { vid: p.vid, qty: 0, rows: [] });
      const o = byOpt.get(p.vid);
      o.qty += p.qty;
      o.rows.push(p);
    }
    const rep = [...byOpt.values()].sort((a, b) => b.qty - a.qty)[0];
    const inoutPerUnit = mode(rep.rows.map(p => p.inout / p.qty));
    // 배송비는 주문(배송)건당이라 수량으로 나누지 않는다 — qty=1 라인이 있으면 그 값이 정확하다
    const q1 = rep.rows.filter(p => p.qty === 1).map(p => p.ship);
    const shipPerOrder = q1.length ? mode(q1)
      : Math.round(rep.rows.reduce((s, p) => s + p.ship, 0) / rep.rows.length);
    if (Number.isFinite(inoutPerUnit)) paidInouts.push(inoutPerUnit);
    if (Number.isFinite(shipPerOrder)) paidShips.push(shipPerOrder);
    const dates = rep.rows.map(p => p.date).filter(Boolean).sort();
    defaults[g.code] = {
      inout_fee: Number.isFinite(inoutPerUnit) ? inoutPerUnit : null,
      ship_fee: Number.isFinite(shipPerOrder) ? shipPerOrder : null,
      deduct_rate: deductRate, comm_rate: commRate,
      estimated: false,
      basis: `옵션 ${rep.vid} · 유료 ${rep.rows.length}건`
        + (q1.length ? ` (수량1 ${q1.length}건)` : ' (수량1 라인 없음 — 평균)')
        + (dates.length ? ` ${dates[0]}~${dates[dates.length - 1]}` : '')
        + (g.zero ? ` · 전액할인 ${g.zero}건 제외` : ''),
    };
  }

  const median = (a) => {
    if (!a.length) return null;
    const s = [...a].sort((x, y) => x - y);
    return s[Math.floor(s.length / 2)];
  };
  return {
    defaults,
    fallback: {
      inout_fee: median(paidInouts),
      ship_fee: median(paidShips),
      deduct_rate: 0.11,
      estimated: true,
      basis: paidInouts.length
        ? `채널 유료 청구 중앙값 (상품 ${paidInouts.length}종) — 이 상품 실적 없음`
        : '유료 청구 실적이 채널 전체에 없음 — 값을 직접 넣어야 합니다',
    },
    paid_range: paidFrom ? { from: paidFrom, to: paidTo } : null,
  };
}

module.exports = {
  listUnitPlans,
  saveUnitPlans,
  deleteUnitPlan,
  fulfillmentDefaults,
  listMarginSims,
  saveMarginSims,
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
