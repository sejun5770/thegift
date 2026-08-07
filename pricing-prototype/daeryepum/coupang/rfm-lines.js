/**
 * 로켓그로스 주문 단위 리포트 파서 (migration 055).
 *
 * 두 종류의 쿠팡 정산 리포트를 같은 함수로 받는다 — 헤더를 보고 스스로 구분한다.
 *   파일1 CATEGORY_TR            '발생일(결제완료일)'  → 매출·수수료·정산대상액
 *   파일2 WAREHOUSING_SHIPPING   '발생일(배송완료일)'  → 입출고비(시트1)·배송비(시트2)
 *
 * ⚠ 두 리포트 모두 '매출인식일' 컬럼이 있는데 가리키는 날짜가 다르다.
 *   파일1 의 매출인식일 = 결제완료일, 파일2 의 매출인식일 = 배송완료일.
 *   이름으로 잡으면 어느 파일이냐에 따라 다른 날짜가 들어와 조용히 뒤섞인다.
 *   그래서 반드시 '발생일(...)' 을 읽고, 괄호 안 문구로 파일 종류를 판별한다.
 *
 * 병합 키 = (주문ID, 옵션ID). 두 파일이 같은 행을 각자 채우므로 업로드 순서는 상관없다.
 */
'use strict';

const { unzip } = require('./rfm-xlsx');

const COL_RE = /^([A-Z]+)(\d+)$/;
function colIndex(ref) {
  const m = COL_RE.exec(ref);
  if (!m) return 0;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function unescapeXml(s) {
  return String(s ?? '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#10;/g, ' ').replace(/&amp;/g, '&');
}

/** 엑셀 serial → YYYY-MM-DD */
function serialToDate(n) {
  const ms = (Number(n) - 25569) * 86400 * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** xlsx 버퍼 → [{name, rows}] (모든 시트). 파일2 는 입출고비/배송비 두 장이다. */
function parseAllSheets(buf) {
  const files = unzip(buf);
  let shared = [];
  const ssBuf = files.get('xl/sharedStrings.xml');
  if (ssBuf) {
    shared = [...ssBuf.toString('utf8').matchAll(/<si>([\s\S]*?)<\/si>/g)]
      .map(m => unescapeXml([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x => x[1]).join('')));
  }
  // 시트 이름 — workbook.xml 순서가 sheet1, sheet2 … 와 일치한다
  const wb = files.get('xl/workbook.xml')?.toString('utf8') || '';
  const names = [...wb.matchAll(/<sheet[^>]*name="([^"]+)"/g)].map(m => unescapeXml(m[1]));

  const out = [];
  const sheetKeys = [...files.keys()]
    .filter(k => /^xl\/worksheets\/sheet\d+\.xml$/i.test(k))
    .sort((a, b) => (parseInt(a.match(/(\d+)\.xml$/)[1], 10) - parseInt(b.match(/(\d+)\.xml$/)[1], 10)));
  sheetKeys.forEach((key, i) => {
    const sheet = files.get(key).toString('utf8');
    const rows = [...sheet.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map(([, body]) => {
      const cells = [];
      for (const [, ref, attr, inner] of body.matchAll(/<c r="([A-Z]+\d+)"([^>]*)>([\s\S]*?)<\/c>/g)) {
        const t = (attr.match(/t="([^"]+)"/) || [])[1];
        let val = '';
        if (t === 'inlineStr') val = unescapeXml((inner.match(/<t[^>]*>([\s\S]*?)<\/t>/) || [])[1] || '');
        else if (t === 's') val = shared[Number((inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1])] || '';
        else val = unescapeXml((inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1] || '');
        cells[colIndex(ref)] = val;
      }
      return cells;
    });
    out.push({ name: names[i] || `sheet${i + 1}`, rows });
  });
  return out;
}

const norm = s => String(s ?? '').replace(/\s/g, '');

/** 헤더행 찾기 — '발생일' 로 시작하는 셀이 있는 첫 행 */
function findHeader(rows) {
  return rows.findIndex(r => (r || []).some(c => norm(c).startsWith('발생일')));
}

/** 헤더행 → {이름조각: 열인덱스}. 같은 조각이 여러 번이면 첫 번째만 잡는다. */
function mapCols(header, spec) {
  const idx = {};
  (header || []).forEach((h, i) => {
    const s = norm(h);
    if (!s) return;
    for (const [key, test] of Object.entries(spec)) {
      if (idx[key] === undefined && test(s)) idx[key] = i;
    }
  });
  return idx;
}

function toDate(v) {
  let s = String(v ?? '').trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) s = serialToDate(s);
  s = s.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}
const num = v => Number(String(v ?? '').replace(/[,\s]/g, '')) || 0;

/** 파일1 — CATEGORY_TR (판매 수수료) */
function parseCategoryTr(rows) {
  const hi = findHeader(rows);
  const col = mapCols(rows[hi], {
    date: s => s.startsWith('발생일'),
    orderId: s => s === '주문ID',
    optionId: s => s === '옵션ID',
    type: s => s.includes('거래유형'),
    productName: s => s.includes('등록상품명'),
    optionName: s => s === '옵션명',
    qty: s => s.startsWith('판매수량'),
    amount: s => s.startsWith('매출금액'),
    settle: s => s.includes('정산대상액'),
    fee: s => s === '판매수수료',
    feeVat: s => s.includes('판매수수료VAT'),
  });
  for (const k of ['date', 'orderId', 'optionId']) {
    if (col[k] === undefined) throw new Error(`파일1 필수 컬럼 누락: ${k} (발생일/주문ID/옵션ID)`);
  }
  const out = [];
  let skipped = 0;
  for (const r of rows.slice(hi + 1)) {
    if (!r) { skipped++; continue; }
    const d = toDate(r[col.date]);
    const oid = String(r[col.orderId] ?? '').trim();
    const vid = String(r[col.optionId] ?? '').trim();
    if (!d || !oid || !vid) { skipped++; continue; }
    const pName = String(r[col.productName] ?? '').trim();
    const oName = String(r[col.optionName] ?? '').trim();
    out.push({
      order_id: oid,
      vendor_item_id: vid,
      paid_date: d,
      product_name: [pName, oName].filter(Boolean).join(' / ') || null,
      sales_qty: Math.round(num(r[col.qty])),
      sales_amount: num(r[col.amount]),
      commission: num(r[col.fee]) + num(r[col.feeVat]),
      settlement_amount: num(r[col.settle]),
      is_cancel: String(r[col.type] ?? '').includes('취소'),
    });
  }
  return { kind: 'category_tr', rows: out, skipped };
}

/** 파일2 — WAREHOUSING_SHIPPING (CFS). 시트별로 비용 항목이 다르다. */
function parseCfs(sheets) {
  const merged = new Map();   // `${order}|${option}` → row
  let skipped = 0;
  for (const sh of sheets) {
    const hi = findHeader(sh.rows);
    if (hi < 0) continue;
    const col = mapCols(sh.rows[hi], {
      date: s => s.startsWith('발생일'),
      orderId: s => s === '주문ID',
      optionId: s => s === '옵션ID',
      // 비용 열은 시트마다 이름이 다르다 — '입출고비' / '배송비' 로 구분
      inout: s => s.includes('입출고비'),
      shipping: s => s.includes('배송비') && !s.includes('입출고'),
    });
    if (col.date === undefined || col.orderId === undefined || col.optionId === undefined) continue;
    for (const r of sh.rows.slice(hi + 1)) {
      if (!r) { skipped++; continue; }
      const d = toDate(r[col.date]);
      const oid = String(r[col.orderId] ?? '').trim();
      const vid = String(r[col.optionId] ?? '').trim();
      if (!d || !oid || !vid) { skipped++; continue; }
      const key = `${oid}|${vid}`;
      if (!merged.has(key)) {
        merged.set(key, { order_id: oid, vendor_item_id: vid, delivered_date: d, inout_fee: 0, shipping_fee: 0 });
      }
      const m = merged.get(key);
      // 같은 (주문, 옵션) 이 두 시트에 다 있다 — 배송완료일은 같으므로 먼저 온 값을 유지
      if (col.inout !== undefined) m.inout_fee += num(r[col.inout]);
      if (col.shipping !== undefined) m.shipping_fee += num(r[col.shipping]);
    }
  }
  return { kind: 'cfs', rows: [...merged.values()], skipped };
}

/**
 * 업로드된 xlsx 를 종류에 맞게 파싱한다.
 * 반환: { kind, rows, skipped, dates: {from, to}, summary }
 */
function parseRgLinesXlsx(buf) {
  const sheets = parseAllSheets(buf);
  if (!sheets.length) throw new Error('워크시트를 찾을 수 없습니다');
  // 어느 리포트인지 — '발생일(결제완료일)' 이면 파일1, '발생일(배송완료일)' 이면 파일2
  const allHeaders = sheets.flatMap(s => {
    const hi = findHeader(s.rows);
    return hi >= 0 ? (s.rows[hi] || []).map(norm) : [];
  });
  const isPaid = allHeaders.some(h => h.startsWith('발생일') && h.includes('결제완료'));
  const isDelivered = allHeaders.some(h => h.startsWith('발생일') && h.includes('배송완료'));
  if (!isPaid && !isDelivered) {
    throw new Error("'발생일(결제완료일)' 또는 '발생일(배송완료일)' 컬럼을 찾을 수 없습니다. "
      + '쿠팡 로켓그로스 정산 리포트가 맞는지 확인해주세요.');
  }
  const parsed = isPaid ? parseCategoryTr(sheets[0].rows) : parseCfs(sheets);

  const dateKey = isPaid ? 'paid_date' : 'delivered_date';
  const ds = parsed.rows.map(r => r[dateKey]).filter(Boolean).sort();
  const summary = parsed.rows.reduce((s, r) => ({
    sales_amount: s.sales_amount + (r.sales_amount || 0),
    commission: s.commission + (r.commission || 0),
    settlement_amount: s.settlement_amount + (r.settlement_amount || 0),
    inout_fee: s.inout_fee + (r.inout_fee || 0),
    shipping_fee: s.shipping_fee + (r.shipping_fee || 0),
  }), { sales_amount: 0, commission: 0, settlement_amount: 0, inout_fee: 0, shipping_fee: 0 });

  return {
    ...parsed,
    dates: { from: ds[0] || null, to: ds[ds.length - 1] || null },
    summary,
  };
}

module.exports = { parseRgLinesXlsx, parseAllSheets };
