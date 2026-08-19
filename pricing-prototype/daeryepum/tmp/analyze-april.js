/**
 * 답례품 4월 실적 분석 스크립트.
 *   WBR 엑셀의 [더기프트 매입 RAW] + [더기프트 위탁 RAW] + [더기프트 환불 RAW] + [더기프트 sku] 활용.
 *
 *   산출:
 *     1) 월별 매출 추이 (1~5월)
 *     2) 4월 일별 / 주차별 / 희망출고일별 매출
 *     3) 상품별 베스트 (4월 vs 3월)
 *     4) 채널/마켓별 분포
 *     5) 5월 예상 (3월/4월 패턴 + 5월 현재 진행률)
 */
'use strict';
const xlsx = require('C:/Users/LG/node_modules/xlsx');

const FILE = 'C:/Users/LG/Downloads/WBR_바른컴퍼니_FY25-26 (2).xlsx';
const wb = xlsx.readFile(FILE);

// Excel serial date → YYYY-MM-DD
function excelToDate(n) {
  if (n == null || n === '') return null;
  if (typeof n === 'string') {
    // 'YYYY-MM-DD' or 'YYYY-MM-DD HH:mm:ss'
    const m = n.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
    return null;
  }
  // Excel serial: days since 1899-12-30
  const ms = (n - 25569) * 86400 * 1000;
  const d = new Date(ms);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

// ISO week (Sun-based for KR convention) → YYYY-Wnn
function isoWeek(ymd) {
  if (!ymd) return null;
  const d = new Date(ymd + 'T00:00:00Z');
  if (isNaN(d.getTime())) return null;
  // 일요일 시작 (한국 주차 컨벤션)
  const dow = d.getUTCDay(); // 0=Sun, 6=Sat
  // 그 주의 일요일
  const sun = new Date(d.getTime() - dow * 86400000);
  // 연/월
  const yy = sun.getUTCFullYear();
  const mm = sun.getUTCMonth() + 1;
  return `${yy}-${String(mm).padStart(2,'0')}-W${Math.ceil((sun.getUTCDate())/7)}`;
}

function loadRaw(sheetName) {
  const sh = wb.Sheets[sheetName];
  const rows = xlsx.utils.sheet_to_json(sh, { header: 1, defval: null });
  const header = rows[0];
  // 핵심 열 인덱스
  const idx = {
    product: header.indexOf('상품번호'),
    payDate: header.indexOf('결제일'),
    amount: header.indexOf('결제액'),
    qty: header.indexOf('수량'),
    orderDate: header.indexOf('주문일'),
    shipDate: header.indexOf('출고일'),
    market: header.indexOf('판매마켓'),
    route: header.indexOf('주문경로'),
  };
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r[idx.payDate]) continue;
    out.push({
      product: r[idx.product] ? String(r[idx.product]) : null,
      payDate: excelToDate(r[idx.payDate]),
      amount: Number(r[idx.amount]) || 0,
      qty: Number(r[idx.qty]) || 0,
      orderDate: excelToDate(r[idx.orderDate]),
      shipDate: excelToDate(r[idx.shipDate]),
      market: r[idx.market] || null,
      route: r[idx.route] || null,
    });
  }
  return out;
}

// SKU 마스터 — 상품번호 → 상품명
function loadSku() {
  const sh = wb.Sheets['더기프트 sku'];
  const rows = xlsx.utils.sheet_to_json(sh, { header: 1, defval: null });
  const header = rows[0] || [];
  const codeCol = header.findIndex(h => h && String(h).includes('상품번호'));
  const nameCol = header.findIndex(h => h && String(h).includes('상품명'));
  const map = new Map();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    const code = r[codeCol] ? String(r[codeCol]) : null;
    const name = r[nameCol] ? String(r[nameCol]) : null;
    if (code) map.set(code, name);
  }
  return map;
}

// 환불 RAW — 결제일/금액 기준으로 차감
function loadRefund() {
  const sh = wb.Sheets['더기프트 환불 RAW'];
  const rows = xlsx.utils.sheet_to_json(sh, { header: 1, defval: null });
  const header = rows[0] || [];
  // 환불 RAW 의 헤더 구조 추측
  const idxDate = header.findIndex(h => h && (String(h).includes('환불일') || String(h).includes('결제일') || String(h).includes('날짜')));
  const idxAmount = header.findIndex(h => h && (String(h).includes('환불') && String(h).includes('금액') || String(h)==='환불액'));
  const out = [];
  if (idxDate < 0 || idxAmount < 0) return out;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r[idxDate]) continue;
    out.push({
      date: excelToDate(r[idxDate]),
      amount: Number(r[idxAmount]) || 0,
    });
  }
  return out;
}

const skuMap = loadSku();
const consign = loadRaw('더기프트 위탁 RAW');
const purchase = loadRaw('더기프트 매입 RAW');
const refund = loadRefund();

// 모든 매출 row 통합 — channel 태그 부여
const all = [
  ...consign.map(r => ({ ...r, channel: '위탁' })),
  ...purchase.map(r => ({ ...r, channel: '매입' })),
];

console.log(`총 ${all.length} rows (위탁 ${consign.length} + 매입 ${purchase.length})`);
console.log(`환불 ${refund.length} rows`);
console.log(`SKU 마스터 ${skuMap.size}개`);

// 1) 월별 매출 추이 (2025-12 ~ 2026-05)
console.log('\n=== 1) 월별 매출 추이 ===');
const byMonth = new Map();
for (const r of all) {
  if (!r.payDate) continue;
  const month = r.payDate.slice(0, 7);
  const e = byMonth.get(month) || { gmv: 0, qty: 0, orders: 0, channels: {} };
  e.gmv += r.amount;
  e.qty += r.qty;
  e.orders++;
  e.channels[r.channel] = (e.channels[r.channel] || 0) + r.amount;
  byMonth.set(month, e);
}
// 환불 차감 (월별)
const byMonthRefund = new Map();
for (const r of refund) {
  if (!r.date) continue;
  const month = r.date.slice(0, 7);
  byMonthRefund.set(month, (byMonthRefund.get(month) || 0) + r.amount);
}
const sortedMonths = [...byMonth.keys()].sort();
console.log('월\t\tGMV\t\t순매출(환불차감)\t수량\t주문수\t위탁비율\t매입비율\tAOV');
for (const m of sortedMonths) {
  const d = byMonth.get(m);
  const ref = byMonthRefund.get(m) || 0;
  const net = d.gmv - ref;
  const aov = d.gmv / d.orders;
  const ratioCon = (d.channels['위탁'] || 0) / d.gmv;
  const ratioPur = (d.channels['매입'] || 0) / d.gmv;
  console.log(`${m}\t${d.gmv.toLocaleString('ko-KR')}\t${net.toLocaleString('ko-KR')}\t${d.qty.toLocaleString('ko-KR')}\t${d.orders}\t${(ratioCon*100).toFixed(1)}%\t${(ratioPur*100).toFixed(1)}%\t${Math.round(aov).toLocaleString('ko-KR')}`);
}

// 2) 4월 일별
console.log('\n=== 2) 4월 일별 매출 ===');
const aprByDay = new Map();
for (const r of all) {
  if (!r.payDate || !r.payDate.startsWith('2026-04')) continue;
  const e = aprByDay.get(r.payDate) || { gmv: 0, qty: 0, orders: 0 };
  e.gmv += r.amount;
  e.qty += r.qty;
  e.orders++;
  aprByDay.set(r.payDate, e);
}
console.log('일자\t\tGMV\t\t수량\t주문수');
const sortedDays = [...aprByDay.keys()].sort();
let aprTotal = { gmv: 0, qty: 0, orders: 0 };
for (const d of sortedDays) {
  const data = aprByDay.get(d);
  aprTotal.gmv += data.gmv;
  aprTotal.qty += data.qty;
  aprTotal.orders += data.orders;
  console.log(`${d}\t${data.gmv.toLocaleString('ko-KR')}\t${data.qty}\t${data.orders}`);
}
console.log(`-- 4월 합계 --\t${aprTotal.gmv.toLocaleString('ko-KR')}\t${aprTotal.qty}\t${aprTotal.orders}`);

// 3) 4월 주차별
console.log('\n=== 3) 4월 주차별 매출 ===');
const aprByWeek = new Map();
for (const r of all) {
  if (!r.payDate || !r.payDate.startsWith('2026-04')) continue;
  const wk = isoWeek(r.payDate);
  const e = aprByWeek.get(wk) || { gmv: 0, qty: 0, orders: 0 };
  e.gmv += r.amount;
  e.qty += r.qty;
  e.orders++;
  aprByWeek.set(wk, e);
}
console.log('주\t\t\tGMV\t\t수량\t주문수');
for (const w of [...aprByWeek.keys()].sort()) {
  const d = aprByWeek.get(w);
  console.log(`${w}\t${d.gmv.toLocaleString('ko-KR')}\t${d.qty}\t${d.orders}`);
}

// 4) 4월 희망출고일별
console.log('\n=== 4) 4월 결제건의 희망출고일 분포 ===');
const aprByShip = new Map();
for (const r of all) {
  if (!r.payDate || !r.payDate.startsWith('2026-04')) continue;
  if (!r.shipDate) continue;
  const e = aprByShip.get(r.shipDate) || { gmv: 0, qty: 0, orders: 0 };
  e.gmv += r.amount;
  e.qty += r.qty;
  e.orders++;
  aprByShip.set(r.shipDate, e);
}
const sortedShip = [...aprByShip.keys()].sort();
console.log('출고일\t\tGMV\t\t수량\t주문수');
for (const s of sortedShip) {
  const d = aprByShip.get(s);
  console.log(`${s}\t${d.gmv.toLocaleString('ko-KR')}\t${d.qty}\t${d.orders}`);
}

// 5) 4월 상품별 베스트
console.log('\n=== 5) 4월 상품별 베스트 (Top 20) ===');
const aprByProduct = new Map();
for (const r of all) {
  if (!r.payDate || !r.payDate.startsWith('2026-04')) continue;
  if (!r.product) continue;
  const e = aprByProduct.get(r.product) || { gmv: 0, qty: 0, orders: 0 };
  e.gmv += r.amount;
  e.qty += r.qty;
  e.orders++;
  aprByProduct.set(r.product, e);
}
const aprBest = [...aprByProduct.entries()].sort((a,b) => b[1].gmv - a[1].gmv).slice(0, 20);
console.log('순위\t상품번호\tGMV\t\t수량\t주문\t상품명');
aprBest.forEach(([code, d], i) => {
  const name = skuMap.get(code) || '';
  console.log(`${i+1}\t${code}\t${d.gmv.toLocaleString('ko-KR')}\t${d.qty}\t${d.orders}\t${name.slice(0,40)}`);
});

// 6) 3월 상품별 베스트
console.log('\n=== 6) 3월 상품별 베스트 (Top 20) ===');
const marByProduct = new Map();
for (const r of all) {
  if (!r.payDate || !r.payDate.startsWith('2026-03')) continue;
  if (!r.product) continue;
  const e = marByProduct.get(r.product) || { gmv: 0, qty: 0, orders: 0 };
  e.gmv += r.amount;
  e.qty += r.qty;
  e.orders++;
  marByProduct.set(r.product, e);
}
const marBest = [...marByProduct.entries()].sort((a,b) => b[1].gmv - a[1].gmv).slice(0, 20);
console.log('순위\t상품번호\tGMV\t\t수량\t주문\t상품명');
marBest.forEach(([code, d], i) => {
  const name = skuMap.get(code) || '';
  console.log(`${i+1}\t${code}\t${d.gmv.toLocaleString('ko-KR')}\t${d.qty}\t${d.orders}\t${name.slice(0,40)}`);
});

// 7) 5월 진행 현황
console.log('\n=== 7) 5월 진행 현황 (현재까지) ===');
const mayByDay = new Map();
for (const r of all) {
  if (!r.payDate || !r.payDate.startsWith('2026-05')) continue;
  const e = mayByDay.get(r.payDate) || { gmv: 0, qty: 0, orders: 0 };
  e.gmv += r.amount;
  e.qty += r.qty;
  e.orders++;
  mayByDay.set(r.payDate, e);
}
const mayDays = [...mayByDay.keys()].sort();
let mayTotal = { gmv: 0, qty: 0, orders: 0 };
console.log('일자\t\tGMV\t\t수량\t주문수');
for (const d of mayDays) {
  const data = mayByDay.get(d);
  mayTotal.gmv += data.gmv;
  mayTotal.qty += data.qty;
  mayTotal.orders += data.orders;
  console.log(`${d}\t${data.gmv.toLocaleString('ko-KR')}\t${data.qty}\t${data.orders}`);
}
console.log(`-- 5월 누적 (${mayDays.length}일) --\t${mayTotal.gmv.toLocaleString('ko-KR')}\t${mayTotal.qty}\t${mayTotal.orders}`);

// 8) 3월/4월/5월 비교
console.log('\n=== 8) MoM 비교 ===');
const mar = byMonth.get('2026-03') || { gmv: 0, qty: 0, orders: 0 };
const apr = byMonth.get('2026-04') || { gmv: 0, qty: 0, orders: 0 };
const may = byMonth.get('2026-05') || { gmv: 0, qty: 0, orders: 0 };
console.log(`3월: GMV ${mar.gmv.toLocaleString()} / 수량 ${mar.qty.toLocaleString()} / 주문 ${mar.orders}`);
console.log(`4월: GMV ${apr.gmv.toLocaleString()} / 수량 ${apr.qty.toLocaleString()} / 주문 ${apr.orders}`);
console.log(`5월: GMV ${may.gmv.toLocaleString()} / 수량 ${may.qty.toLocaleString()} / 주문 ${may.orders}`);
console.log(`4월 MoM(GMV): ${mar.gmv ? ((apr.gmv - mar.gmv)/mar.gmv*100).toFixed(1) : 'N/A'}%`);

// 9) 4월의 출고일 → 누적 출고 분포 (어느 시점에 몰리는지)
console.log('\n=== 9) 4월 결제건 출고일까지 lead time 분포 ===');
const leadTimeBuckets = new Map();
for (const r of all) {
  if (!r.payDate || !r.payDate.startsWith('2026-04')) continue;
  if (!r.shipDate || !r.payDate) continue;
  const days = Math.round((new Date(r.shipDate) - new Date(r.payDate)) / 86400000);
  if (days < 0 || days > 60) continue;
  const bucket = days <= 2 ? '0-2일(빠른출고)'
    : days <= 5 ? '3-5일'
    : days <= 10 ? '6-10일'
    : days <= 20 ? '11-20일'
    : '21일+';
  leadTimeBuckets.set(bucket, (leadTimeBuckets.get(bucket) || 0) + 1);
}
console.log('리드타임\t건수');
for (const b of ['0-2일(빠른출고)', '3-5일', '6-10일', '11-20일', '21일+']) {
  console.log(`${b}\t${leadTimeBuckets.get(b) || 0}`);
}

// 10) 마켓별 분포 (4월)
console.log('\n=== 10) 4월 판매마켓별 매출 ===');
const aprByMarket = new Map();
for (const r of all) {
  if (!r.payDate || !r.payDate.startsWith('2026-04')) continue;
  const mk = r.market || '(미상)';
  const e = aprByMarket.get(mk) || { gmv: 0, orders: 0 };
  e.gmv += r.amount;
  e.orders++;
  aprByMarket.set(mk, e);
}
console.log('마켓\t\tGMV\t\t주문수');
for (const [mk, d] of [...aprByMarket.entries()].sort((a,b) => b[1].gmv - a[1].gmv)) {
  console.log(`${String(mk).slice(0,15)}\t${d.gmv.toLocaleString('ko-KR')}\t${d.orders}`);
}
