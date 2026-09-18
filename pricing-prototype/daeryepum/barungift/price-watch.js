/**
 * 답례품 판매가 스냅샷 — 값이 바뀐 것만 기록한다.
 *
 * 왜 필요한가 (2026-08-14 조사):
 *   원본 상품 DB(S2_CARD)에는 '지금 얼마인지' 만 있고 '언제 바뀌었는지' 가 없다.
 *   가격 변경 로그 테이블(ADMIN_PRICE_LOGINFO)은 청첩장만 쌓이고 답례품은 0건이다.
 *   그래서 지금까지 주문 단가로 역산했는데, 주문이 없는 날은 가격을 알 수 없다.
 *
 * 별도 크론을 만들지 않는다 — 기존 동기화 주기에 얹는다. 값이 그대로면 아무것도
 * 쓰지 않으므로 하루 몇 행 수준이다.
 *
 * 판매 단위 주의:
 *   같은 Card_Code 가 정가/할인/시크릿특가로 여러 행이다 (TGJSD01O4_A 정가 4,800 /
 *   _B 27%할인 3,499 / _C 시크릿특가 3,499). 코드로 뭉치면 가격이 섞이므로
 *   card_seq(판매 단위) 별로 추적한다.
 */
'use strict';

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';
const USE = !!(SUPABASE_URL && SUPABASE_KEY);
const REST = `${SUPABASE_URL}/rest/v1`;
const HDR = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' };

/** 변형 접미 '_A'/'_B' 하나만 제거 — funnel/price-trend 와 같은 규칙 */
function toBase(code) {
  if (!code) return '';
  const m = String(code).trim().match(/^(.+)_[A-Za-z]$/);
  return (m ? m[1] : String(code).trim()).toUpperCase();
}

/**
 * 우리가 관리하는 답례품의 코드 접두 목록.
 *   상품설정(bg_product_settings.product_id)에서 뽑는다 — 하드코딩하면 새 코드 체계가
 *   생겼을 때 조용히 빠진다. 접두로 좁혀 S2_CARD 를 훑고, 정확한 매칭은 JS 에서 한다.
 */
async function giftCodes() {
  if (!USE) return [];
  const res = await fetch(`${REST}/bg_product_settings?select=product_id&limit=2000`, { headers: HDR });
  if (!res.ok) throw new Error(`Supabase bg_product_settings [${res.status}]: ${(await res.text()).slice(0, 200)}`);
  const rows = await res.json();
  return [...new Set(rows.map(r => toBase(r.product_id)).filter(Boolean))];
}

const MIGRATION_HINT = '가격 이력 테이블이 없습니다 — 마이그레이션 066 을 실행하세요.';
const isMissingTable = (status, body) => status === 404 || /PGRST205|schema cache|does not exist/i.test(body);

/**
 * 판매단위별 마지막 기록 — card_seq → { sale_price, list_price }.
 *   테이블이 아직 없으면 던지지 않는다. 마이그레이션 전에도 dry_run 으로
 *   무엇이 잡히는지는 볼 수 있어야 한다 (실제로 여기서 막혀 미리보기가 안 됐다).
 */
async function lastKnown() {
  const out = new Map();
  out._missing = false;
  if (!USE) return out;
  // captured_at 오름차순으로 받아 덮어쓰면 마지막(=최신)이 남는다.
  //   행이 많아지면 여기부터 무거워지니 필요한 컬럼만 가져온다.
  const res = await fetch(
    `${REST}/bg_price_history?select=card_seq,sale_price,list_price,captured_at&order=captured_at.asc&limit=20000`,
    { headers: HDR });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    if (isMissingTable(res.status, body)) { out._missing = true; return out; }
    throw new Error(`Supabase bg_price_history [${res.status}]: ${body}`);
  }
  for (const r of await res.json()) out.set(Number(r.card_seq), r);
  return out;
}

/**
 * @param {object} opts
 * @param {function} opts.getPool  MSSQL 풀 (server.js 의 것을 그대로 받는다)
 * @param {boolean}  opts.dryRun   true 면 무엇이 바뀌었는지만 돌려주고 쓰지 않는다
 */
async function snapshotPrices({ getPool, dryRun = false } = {}) {
  if (!USE) return { skipped: 'Supabase 미설정' };
  if (typeof getPool !== 'function') throw new Error('getPool 이 필요합니다');

  const codes = await giftCodes();
  if (!codes.length) return { skipped: '상품설정에 상품이 없습니다' };

  // 접두 4글자로 좁힌다 — 141개 코드를 통째로 IN 에 넣는 것보다 쿼리가 가볍고,
  //   정확한 매칭은 아래 JS 에서 base 코드로 다시 거른다.
  const prefixes = [...new Set(codes.map(c => c.slice(0, 4)).filter(p => p.length >= 3))];
  const pool = await getPool();
  const req = pool.request();
  const where = prefixes.map((p, i) => {
    req.input(`p${i}`, p + '%');
    return `Card_Code LIKE @p${i}`;
  }).join(' OR ');
  const rs = await req.query(`
    SELECT Card_Seq, Card_Code, Card_Name, Card_Price, CardSet_Price
    FROM S2_CARD
    WHERE ${where}`);

  const known = await lastKnown();
  const codeSet = new Set(codes);
  const now = new Date().toISOString();
  const rows = [];
  let scanned = 0;

  for (const r of rs.recordset) {
    const base = toBase(r.Card_Code);
    if (!codeSet.has(base)) continue;          // 상품설정에 없는 코드는 우리 소관이 아니다
    scanned++;
    const seq = Number(r.Card_Seq);
    const sale = Number(r.CardSet_Price);
    const list = Number(r.Card_Price);
    // 판매가가 0 이면 판매 중지/사은품 등 — 가격 변동으로 볼 값이 아니다
    if (!Number.isFinite(sale) || sale <= 0) continue;
    const prev = known.get(seq);
    if (prev && Number(prev.sale_price) === sale && Number(prev.list_price) === list) continue;
    rows.push({
      card_seq: seq,
      card_code: String(r.Card_Code),
      product_code: base,
      product_name: r.Card_Name ? String(r.Card_Name) : null,
      list_price: Number.isFinite(list) ? list : null,
      sale_price: sale,
      prev_list_price: prev ? prev.list_price : null,
      prev_sale_price: prev ? prev.sale_price : null,
      is_baseline: !prev,
      captured_at: now,
    });
  }

  const changes = rows.filter(r => !r.is_baseline);
  const out = {
    scanned,
    baseline: rows.length - changes.length,
    changed: changes.length,
    dry_run: !!dryRun,
    // 테이블이 없으면 전부 '기준선' 으로 보이는데, 그 이유를 함께 알려야 한다
    ...(known._missing ? { table_missing: true, hint: MIGRATION_HINT } : {}),
    // 무엇이 바뀌었는지는 로그·화면에서 바로 읽히게 요약해 둔다
    details: changes.slice(0, 30).map(r => ({
      code: r.card_code, name: r.product_name,
      from: r.prev_sale_price, to: r.sale_price,
    })),
  };
  if (dryRun || !rows.length) return out;

  for (let i = 0; i < rows.length; i += 300) {
    const chunk = rows.slice(i, i + 300);
    const res = await fetch(`${REST}/bg_price_history`, {
      method: 'POST',
      headers: { ...HDR, Prefer: 'resolution=ignore-duplicates,return=minimal' },
      body: JSON.stringify(chunk),
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      if (isMissingTable(res.status, body)) return { ...out, saved: 0, error: MIGRATION_HINT };
      throw new Error(`Supabase bg_price_history insert [${res.status}]: ${body}`);
    }
  }
  return { ...out, saved: rows.length };
}

/** 기록된 이력 조회 — product_code(base) 별 시간순 */
async function listPriceHistory({ startDate, endDate } = {}) {
  if (!USE) return [];
  const f = ['select=*', 'order=captured_at.asc', 'limit=20000'];
  if (startDate) f.push(`captured_at=gte.${startDate}`);
  if (endDate) f.push(`captured_at=lte.${endDate}T23:59:59+09:00`);
  const res = await fetch(`${REST}/bg_price_history?${f.join('&')}`, { headers: HDR });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    if (res.status === 404 || /PGRST205|schema cache/i.test(body)) return [];   // 아직 테이블 없음
    throw new Error(`Supabase bg_price_history [${res.status}]: ${body}`);
  }
  return res.json();
}

module.exports = { snapshotPrices, listPriceHistory, toBase, USE };
