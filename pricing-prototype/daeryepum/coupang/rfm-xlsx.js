/**
 * 쿠팡 로켓그로스 "판매 수수료 리포트" (xlsx) 파서.
 *
 * 외부 라이브러리 없이 Node 내장 zlib 으로 처리한다.
 *   xlsx = ZIP(Deflate) + XML → 중앙 디렉터리 파싱 → sheet1.xml / sharedStrings.xml 추출.
 *
 * 리포트 컬럼 (2026-07 기준):
 *   E 매출인식일 · G 거래유형(주문 정산/주문 정산취소) · K 등록상품 ID · L 옵션ID
 *   N 등록상품명 · O 옵션명 · Q 판매수량(B) · R 판매액(A*B) · S 쿠팡지원할인(C) · T 매출금액(A*B-C)
 *
 * 집계 단위 = (매출인식일, 옵션ID) — coupang_rocket_growth_sales 의 UNIQUE 키와 동일.
 *   같은 파일을 다시 올려도 upsert 로 덮어써 중복 계상되지 않는다.
 *   '주문 정산취소' 행은 수량·금액이 음수로 들어와 refund_qty/refund_amount 로 분리한다.
 */
const zlib = require('zlib');

/** ZIP 버퍼 → Map(파일명 → Buffer) */
function unzip(buf) {
  // EOCD (End of Central Directory) 탐색 — 뒤에서부터
  let eocd = -1;
  const min = Math.max(0, buf.length - 65558);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('xlsx 형식이 아닙니다 (ZIP 구조 없음)');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    // local header 에서 실제 데이터 시작 위치 계산 (extra 길이가 central 과 다를 수 있음)
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    try {
      files.set(name, method === 0 ? raw : zlib.inflateRawSync(raw));
    } catch { /* 개별 엔트리 실패는 무시 */ }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const unescapeXml = (s) => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

/** 열 참조(A1, AB12) → 0-based 열 index */
function colIndex(ref) {
  const m = String(ref).match(/^([A-Z]+)/);
  if (!m) return 0;
  let n = 0;
  for (const c of m[1]) n = n * 26 + (c.charCodeAt(0) - 64);
  return n - 1;
}

/** Excel serial date → 'YYYY-MM-DD' (1900 시스템, 1900 윤년 버그 보정 포함) */
function serialToDate(n) {
  const ms = Math.round((Number(n) - 25569) * 86400 * 1000);
  const d = new Date(ms);
  if (isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

/** xlsx Buffer → 행 배열(각 행은 셀 문자열 배열) */
function parseSheet(buf) {
  const files = unzip(buf);
  const sheetName = [...files.keys()].find(k => /^xl\/worksheets\/sheet1\.xml$/i.test(k))
    || [...files.keys()].find(k => /^xl\/worksheets\/.*\.xml$/i.test(k));
  if (!sheetName) throw new Error('워크시트를 찾을 수 없습니다');
  const sheet = files.get(sheetName).toString('utf8');

  // sharedStrings (t="s" 셀용) — 이 리포트는 inlineStr 이지만 호환 위해 함께 지원
  let shared = [];
  const ssBuf = files.get('xl/sharedStrings.xml');
  if (ssBuf) {
    shared = [...ssBuf.toString('utf8').matchAll(/<si>([\s\S]*?)<\/si>/g)]
      .map(m => unescapeXml([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x => x[1]).join('')));
  }

  return [...sheet.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map(([, body]) => {
    const out = [];
    for (const [, ref, attr, inner] of body.matchAll(/<c r="([A-Z]+\d+)"([^>]*)>([\s\S]*?)<\/c>/g)) {
      const t = (attr.match(/t="([^"]+)"/) || [])[1];
      let val = '';
      if (t === 'inlineStr') val = unescapeXml((inner.match(/<t[^>]*>([\s\S]*?)<\/t>/) || [])[1] || '');
      else if (t === 's') val = shared[Number((inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1])] || '';
      else val = unescapeXml((inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1] || '');
      out[colIndex(ref)] = val;
    }
    return out;
  });
}

/** 헤더행에서 컬럼 위치 찾기 (컬럼 순서가 바뀌어도 동작하도록 이름 기반) */
function findColumns(headerRow) {
  const idx = {};
  (headerRow || []).forEach((h, i) => {
    const s = String(h || '').replace(/\s/g, '');
    if (!s) return;
    if (idx.date === undefined && s.includes('매출인식일')) idx.date = i;
    else if (idx.type === undefined && s.includes('거래유형')) idx.type = i;
    else if (idx.productId === undefined && s.includes('등록상품ID')) idx.productId = i;
    else if (idx.optionId === undefined && s.includes('옵션ID')) idx.optionId = i;
    else if (idx.productName === undefined && s.includes('등록상품명')) idx.productName = i;
    else if (idx.optionName === undefined && s.includes('옵션명')) idx.optionName = i;
    else if (idx.qty === undefined && s.includes('판매수량')) idx.qty = i;
    else if (idx.gross === undefined && s.startsWith('판매액')) idx.gross = i;
    else if (idx.support === undefined && s.includes('쿠팡지원할인')) idx.support = i;
    else if (idx.amount === undefined && s.startsWith('매출금액')) idx.amount = i;
  });
  return idx;
}

/**
 * 리포트 파일 → 저장용 rows.
 * 반환: { rows: [{sale_date, vendor_item_id, product_id, product_name, sales_qty, sales_amount, refund_qty, refund_amount}],
 *         dates: ['YYYY-MM-DD'...], summary: {...}, skipped }
 */
function parseRfmSettlementXlsx(buf) {
  const raw = parseSheet(buf);
  // 헤더행 탐색 — '매출인식일' 이 있는 첫 행
  const headerRowIdx = raw.findIndex(r => (r || []).some(c => String(c || '').replace(/\s/g, '').includes('매출인식일')));
  if (headerRowIdx < 0) throw new Error("'매출인식일' 컬럼을 찾을 수 없습니다. 로켓그로스 '판매 수수료 리포트' 파일인지 확인해주세요.");
  const col = findColumns(raw[headerRowIdx]);
  for (const k of ['date', 'optionId', 'qty']) {
    if (col[k] === undefined) throw new Error(`필수 컬럼 누락: ${k} (매출인식일/옵션ID/판매수량 필요)`);
  }

  const agg = new Map();
  let skipped = 0;
  for (const r of raw.slice(headerRowIdx + 1)) {
    if (!r) { continue; }
    let date = String(r[col.date] || '').trim();
    if (!date) { skipped++; continue; }
    if (/^\d+(\.\d+)?$/.test(date)) date = serialToDate(date);   // 날짜가 serial 로 온 경우
    date = date.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { skipped++; continue; }

    const vid = String(r[col.optionId] || '').trim();
    if (!vid) { skipped++; continue; }
    const qty = Number(r[col.qty]) || 0;
    // 매출금액(판매액 - 쿠팡지원할인) 우선, 없으면 판매액, 그것도 없으면 0
    const amount = col.amount !== undefined ? (Number(r[col.amount]) || 0)
      : ((Number(r[col.gross]) || 0) - (col.support !== undefined ? (Number(r[col.support]) || 0) : 0));
    const isCancel = String(r[col.type] ?? '').includes('취소') || qty < 0 || amount < 0;

    const key = `${date}|${vid}`;
    if (!agg.has(key)) {
      const pName = String(r[col.productName] ?? '').trim();
      const oName = String(r[col.optionName] ?? '').trim();
      agg.set(key, {
        sale_date: date,
        vendor_item_id: vid,
        product_id: String(r[col.productId] ?? '').trim() || null,
        product_name: [pName, oName].filter(Boolean).join(' / ') || null,
        sales_qty: 0, sales_amount: 0, refund_qty: 0, refund_amount: 0,
      });
    }
    const a = agg.get(key);
    if (isCancel) { a.refund_qty += Math.abs(qty); a.refund_amount += Math.abs(amount); }
    else { a.sales_qty += qty; a.sales_amount += amount; }
  }

  const rows = [...agg.values()].sort((x, y) =>
    x.sale_date.localeCompare(y.sale_date) || String(x.vendor_item_id).localeCompare(String(y.vendor_item_id)));
  const dates = [...new Set(rows.map(r => r.sale_date))].sort();
  const summary = rows.reduce((s, r) => ({
    sales_qty: s.sales_qty + r.sales_qty,
    sales_amount: s.sales_amount + r.sales_amount,
    refund_qty: s.refund_qty + r.refund_qty,
    refund_amount: s.refund_amount + r.refund_amount,
  }), { sales_qty: 0, sales_amount: 0, refund_qty: 0, refund_amount: 0 });
  summary.net_amount = summary.sales_amount - summary.refund_amount;
  summary.row_count = rows.length;
  summary.product_count = new Set(rows.map(r => r.vendor_item_id)).size;

  return { rows, dates, summary, skipped };
}

module.exports = { parseRfmSettlementXlsx, parseSheet, unzip };
