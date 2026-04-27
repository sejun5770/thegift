#!/usr/bin/env node
/**
 * 고객 정보입력 백필 (Backfill) 스크립트
 *
 * 목적:
 *   고객 자가 입력 화면 출시 전에 발생한 주문건을 수동으로 수집해
 *   스프레드시트에 작성한 데이터를 bg_order_customer_info 로 일괄 입력.
 *
 * 안전성:
 *   - ON CONFLICT (order_id) DO NOTHING — 이미 입력된 건은 보존 (덮어쓰기 안 함).
 *   - dry-run 모드 — 실제 INSERT 전 변환 결과 확인.
 *   - 멱등성 — 같은 파일 재실행해도 안전 (이미 들어간 건 자동 skip).
 *
 * 사용법:
 *   환경변수 필요: SUPABASE_URL, SUPABASE_ANON_KEY (또는 SERVICE_ROLE_KEY)
 *
 *   # 1) Dry-run (실제 insert 안 함, 변환 결과만 출력)
 *   node scripts/backfill-customer-info.js path/to/data.tsv --dry-run
 *
 *   # 2) Dry-run 으로 5건만 미리보기
 *   node scripts/backfill-customer-info.js path/to/data.tsv --dry-run --limit=5
 *
 *   # 3) 실제 실행
 *   node scripts/backfill-customer-info.js path/to/data.tsv
 *
 * 입력 파일 형식:
 *   - TSV (탭 구분) 또는 CSV (콤마 구분) 자동 감지
 *   - UTF-8 인코딩 권장 (Excel 저장시 'CSV UTF-8' 선택)
 *   - 첫 행은 헤더 (스킵)
 *   - 컬럼 순서 (A~W):
 *     A: 이슈 (무시)
 *     B: 출고방식 (무시 — '택배' 외엔 분류 변경 가능)
 *     C: 출고상세 (무시)
 *     D: 주문번호 (필수, 접두어 있으면 자동 제거 → 숫자만)
 *     E: 성함 (무시 — DB 에는 마스킹 처리되어 별도 저장 X)
 *     F: 연락처1 (무시)
 *     G: 연락처2 (무시)
 *     H: 수령지(도로명) (무시)
 *     I: CN (무시)
 *     J: 상품명
 *     K: 품목코드 (예: TGJSD05D1)
 *     L: 박스컬러 (선택)
 *     M: 스티커타입 1 (예: 'TGJSD05S1(150개)')
 *     N: 스티커타입 2 (선택)
 *     O: 스티커타입 3 (선택)
 *     P: 입력메시지
 *     Q: 배송메세지1 (무시)
 *     R: 합배송 (무시 — 같은 주문번호로 row 다중일 때 자동 그룹)
 *     S: 구글드라이브 (무시)
 *     T: 주문수량 (총 수량 — 스티커 수량의 합)
 *     U: 인쇄출력일 (submitted_at 으로 사용)
 *     V: 오늘출발 (날짜 — 채워지면 is_express=true, desired_ship_date=V)
 *     W: 희망출고일 (V 비었을 때 desired_ship_date 로 사용)
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
  || process.env.SUPABASE_ANON_KEY
  || '';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ SUPABASE_URL / SUPABASE_ANON_KEY 환경변수를 설정해주세요.');
  console.error('   PowerShell: $env:SUPABASE_URL="https://..."; $env:SUPABASE_ANON_KEY="eyJ..."');
  console.error('   bash:        export SUPABASE_URL=https://... && export SUPABASE_ANON_KEY=eyJ...');
  process.exit(1);
}

const REST_BASE = `${SUPABASE_URL}/rest/v1`;
const HEADERS = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
};

// ============================================
// 명령행 인자 파싱
// ============================================
const args = process.argv.slice(2);
const filePath = args.find(a => !a.startsWith('--'));
const isDryRun = args.includes('--dry-run');
const limitArg = args.find(a => a.startsWith('--limit='));
const limit = limitArg ? parseInt(limitArg.split('=')[1]) : null;

if (!filePath) {
  console.error('❌ 입력 파일 경로가 필요합니다.');
  console.error('   예: node scripts/backfill-customer-info.js data.tsv --dry-run');
  process.exit(1);
}
if (!fs.existsSync(filePath)) {
  console.error(`❌ 파일을 찾을 수 없습니다: ${filePath}`);
  process.exit(1);
}

console.log(`📂 입력 파일: ${path.resolve(filePath)}`);
console.log(`🛡️ 모드: ${isDryRun ? 'DRY-RUN (실제 insert 안 함)' : '실제 실행'}`);
if (limit) console.log(`🔢 제한: 첫 ${limit} 건만 처리`);

// ============================================
// 헬퍼
// ============================================

/** 텍스트 → 숫자 추출 (예: "(바)4716976" → "4716976", "BRS-4716976" → "4716976") */
function extractOrderId(raw) {
  if (!raw) return null;
  const digits = String(raw).match(/\d+/);
  return digits ? digits[0] : null;
}

/**
 * 스티커 셀 파싱 — 'TGJSD05S1(150개)' 또는 'TGJSD05S1 150' 또는 'TGJSD05S1' 형태.
 *
 * 강화: 영문자 1자 이상 포함된 패턴만 sticker_code 로 인정.
 *   순수 숫자(85, 15, 10) 나 날짜(2026-04-16) 는 다른 컬럼이 잘못 매핑된 것이므로 거부.
 *
 * @returns { code, quantity } | null
 */
function parseStickerCell(raw) {
  if (!raw) return null;
  const text = String(raw).trim();
  if (!text) return null;
  // 영문자 검증 — 코드 후보는 반드시 영문자 1자 이상 포함 (순수 숫자/날짜 거부)
  const hasLetter = s => /[A-Za-z]/.test(s);
  // 'TGJSD05S1(150개)' 패턴
  const m1 = text.match(/^([A-Za-z0-9_-]+)\s*\(\s*(\d+)\s*개?\s*\)/);
  if (m1 && hasLetter(m1[1])) return { code: m1[1], quantity: parseInt(m1[2]) };
  // 'TGJSD05S1 150' 패턴
  const m2 = text.match(/^([A-Za-z0-9_-]+)\s+(\d+)/);
  if (m2 && hasLetter(m2[1])) return { code: m2[1], quantity: parseInt(m2[2]) };
  // 'TGJSD05S1' 만 있는 경우 (수량 없음)
  const m3 = text.match(/^([A-Za-z0-9_-]+)/);
  if (m3 && hasLetter(m3[1])) return { code: m3[1], quantity: null };
  return null;
}

/** 날짜 파싱 — 'YYYY-MM-DD', 'YYYY/MM/DD', 'YY.M.D' 등 */
function parseDate(raw) {
  if (!raw) return null;
  const text = String(raw).trim();
  if (!text) return null;
  // ISO 변형 통일 — 점(.)/슬래시(/) → 하이픈
  const cleaned = text.replace(/[./]/g, '-');
  // YY 두자리면 20XX 보정 (현재는 26.x.x → 2026)
  const parts = cleaned.split('-');
  if (parts.length === 3) {
    let [y, m, d] = parts;
    if (y.length === 2) y = '20' + y;
    if (m.length === 1) m = '0' + m;
    if (d.length === 1) d = '0' + d;
    const iso = `${y}-${m}-${d}`;
    if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  }
  return null;
}

/** TSV/CSV 파싱 — 자동 구분자 감지 */
function parseDelimited(content) {
  // BOM 제거
  if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);
  const lines = content.split(/\r?\n/).filter(l => l.length);
  if (!lines.length) return [];
  // 구분자 감지 — 첫 줄에 탭이 콤마보다 많으면 TSV
  const firstLine = lines[0];
  const tabs = (firstLine.match(/\t/g) || []).length;
  const commas = (firstLine.match(/,/g) || []).length;
  const sep = tabs >= commas ? '\t' : ',';
  console.log(`📄 구분자 감지: ${sep === '\t' ? 'TAB (TSV)' : 'COMMA (CSV)'}`);
  return lines.map(line => {
    if (sep === '\t') return line.split('\t');
    // CSV — 따옴표 포함 셀 처리
    return parseCsvLine(line);
  });
}

function parseCsvLine(line) {
  const cells = [];
  let cur = '', inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuote && line[i+1] === '"') { cur += '"'; i++; }
      else inQuote = !inQuote;
    } else if (c === ',' && !inQuote) {
      cells.push(cur); cur = '';
    } else {
      cur += c;
    }
  }
  cells.push(cur);
  return cells;
}

// ============================================
// Supabase API 호출
// ============================================

async function loadStickerCodeMap() {
  const url = `${REST_BASE}/bg_stickers?select=id,sticker_code,name`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`bg_stickers GET [${res.status}]: ${await res.text()}`);
  const rows = await res.json();
  const map = new Map();
  rows.forEach(r => { if (r.sticker_code) map.set(r.sticker_code, r); });
  return map;
}

async function loadExistingOrderIds() {
  const url = `${REST_BASE}/bg_order_customer_info?select=order_id`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`bg_order_customer_info GET [${res.status}]: ${await res.text()}`);
  const rows = await res.json();
  return new Set(rows.map(r => r.order_id));
}

/** UPSERT (ON CONFLICT DO NOTHING) — Supabase Prefer 헤더로 구현 */
async function bulkUpsert(rows) {
  // Supabase 의 ON CONFLICT DO NOTHING 은 Prefer: resolution=ignore-duplicates
  const url = `${REST_BASE}/bg_order_customer_info?on_conflict=order_id`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...HEADERS, Prefer: 'resolution=ignore-duplicates,return=minimal' },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    throw new Error(`UPSERT [${res.status}]: ${await res.text()}`);
  }
}

// ============================================
// 메인 변환 로직
// ============================================

/**
 * 한 행을 변환 → { order_id, stickerSelection } | null
 *   같은 order_id 의 여러 행은 caller 가 그룹핑.
 */
function transformRow(cells, stickerCodeMap, lineNumber) {
  // 컬럼 인덱스 (0-based, A=0)
  const COL = {
    주문번호: 3,    // D
    상품명: 9,      // J
    품목코드: 10,   // K
    박스컬러: 11,   // L
    스티커1: 12,    // M
    스티커2: 13,    // N
    스티커3: 14,    // O
    입력메시지: 15, // P
    주문수량: 19,   // T
    인쇄출력일: 20, // U
    오늘출발: 21,   // V
    희망출고일: 22, // W
  };

  const orderId = extractOrderId(cells[COL.주문번호]);
  if (!orderId) {
    console.warn(`  ⚠️  Line ${lineNumber}: 주문번호 파싱 실패 (값: '${cells[COL.주문번호]}') — skip`);
    return null;
  }

  const productCode = (cells[COL.품목코드] || '').trim() || null;
  const productName = (cells[COL.상품명] || '').trim() || null;
  const boxCode = (cells[COL.박스컬러] || '').trim() || null;
  const message = (cells[COL.입력메시지] || '').trim();
  const orderQty = parseInt(cells[COL.주문수량]) || null;

  // 스티커 셀 파싱 (M/N/O 중 채워진 것만)
  const stickerCells = [cells[COL.스티커1], cells[COL.스티커2], cells[COL.스티커3]];
  const stickers = [];
  stickerCells.forEach(raw => {
    const parsed = parseStickerCell(raw);
    if (parsed) stickers.push(parsed);
  });

  // 빠른출고 / 희망출고일 결정
  const expressDate = parseDate(cells[COL.오늘출발]);
  const desiredDate = parseDate(cells[COL.희망출고일]);
  const isExpress = !!expressDate;
  const shipDate = expressDate || desiredDate || null;

  const submittedDate = parseDate(cells[COL.인쇄출력일]);

  // 한 행 = 하나의 sticker_selection (스티커 다중이면 array 로)
  // sticker_input 결정: 스티커 없으면 'none', 있으면 'custom' (입력메시지 유무에 따라)
  const stickerInput = stickers.length === 0 ? 'none' : 'custom';

  // 스티커 셀들 → sticker_selections array 로 (한 product 에 여러 sticker)
  // 같은 product_code 에 여러 sticker 가 있으면, 한 selection 의
  // sticker_id/sticker_code/sticker_name 를 첫 sticker 로 잡고, 나머지는
  // 추가 메타로 유지하기보다는, sticker_selections 항목을 분리해서 만든다.
  // → 한 product 에 여러 스티커 분배는 우리 시스템에선 별도 row 가 자연스러움.
  const selections = [];
  if (!stickers.length) {
    // 스티커 정보 없음 — product 만 입력
    selections.push({
      product_id: productCode,
      product_code: productCode,
      product_name: productName,
      sticker_id: null,
      sticker_code: null,
      sticker_name: null,
      box_code: boxCode,
      box_name: null,
      sticker_input: 'none',
      custom_values: {},
    });
  } else {
    stickers.forEach((s, idx) => {
      const stickerMeta = stickerCodeMap.get(s.code);
      const customValues = (idx === 0 && message) ? { text: message } : {};
      selections.push({
        product_id: productCode,
        product_code: productCode,
        product_name: productName,
        sticker_id: stickerMeta ? stickerMeta.id : null,
        sticker_code: s.code,
        sticker_name: stickerMeta ? stickerMeta.name : null,
        quantity: s.quantity,
        box_code: boxCode,
        box_name: null,
        sticker_input: 'custom',
        custom_values: customValues,
      });
    });
  }

  return {
    order_id: orderId,
    is_express: isExpress,
    express_fee: 0,
    desired_ship_date: shipDate,
    sticker_selections_partial: selections, // caller 가 그룹핑 후 합칠 것
    cash_receipt_yn: false,
    receipt_type: null,
    receipt_number: null,
    submitted_at: submittedDate ? `${submittedDate}T00:00:00Z` : new Date().toISOString(),
    _lineNumber: lineNumber, // 디버깅용
    _orderQty: orderQty,
  };
}

// ============================================
// 메인 흐름
// ============================================

async function main() {
  console.log('\n=== Step 1: 입력 파일 파싱 ===');
  const content = fs.readFileSync(filePath, 'utf8');
  const allCells = parseDelimited(content);
  if (allCells.length < 2) {
    console.error('❌ 데이터 행이 없습니다 (헤더 외).');
    process.exit(1);
  }
  const dataRows = allCells.slice(1); // 헤더 1행 스킵
  console.log(`✅ ${dataRows.length} 행 파싱 완료 (헤더 1행 제외)`);

  console.log('\n=== Step 2: Supabase 메타 데이터 로드 ===');
  const stickerCodeMap = await loadStickerCodeMap();
  console.log(`✅ bg_stickers 로드: ${stickerCodeMap.size} 건 (sticker_code 기반 lookup 가능)`);
  const existingOrderIds = await loadExistingOrderIds();
  console.log(`✅ bg_order_customer_info 기존 ${existingOrderIds.size} 건 (이 주문들은 자동 skip)`);

  console.log('\n=== Step 3: 행별 변환 ===');
  const transformedRows = [];
  let skipCount = 0;
  let errorCount = 0;
  let inheritedCount = 0;
  // 주문번호 상속 — 멀티상품 주문은 추가 행에서 D열을 비워두는 스프레드시트 패턴 대응.
  //   직전 유효 주문번호를 보관해두고 빈 셀에 채워넣음 (그룹핑 단계에서 자연스럽게 합쳐짐).
  let lastValidOrderId = null;
  for (let i = 0; i < dataRows.length; i++) {
    const cells = dataRows[i];
    const lineNumber = i + 2; // 1-based + header
    if (limit && transformedRows.length >= limit) break;

    // D열 (주문번호) 비어있는 경우 직전 주문번호 상속
    const dCell = cells[3];
    const dExtracted = extractOrderId(dCell);
    if (dExtracted) {
      lastValidOrderId = dExtracted;
    } else if (lastValidOrderId) {
      cells[3] = lastValidOrderId;
      inheritedCount++;
    }
    // lastValidOrderId 도 없으면 그대로 두고 transformRow 가 skip 처리

    try {
      const result = transformRow(cells, stickerCodeMap, lineNumber);
      if (!result) {
        skipCount++;
        // 진단용 — 첫 5개 skip 만 자세히 출력
        if (skipCount <= 5) {
          const cellPreview = (cells || []).slice(0, 6).map(c => `'${(c || '').toString().slice(0, 15)}'`).join(', ');
          console.warn(`     상세: cells.length=${cells.length}, 처음 6셀: [${cellPreview}]`);
        }
        continue;
      }
      transformedRows.push(result);
    } catch (e) {
      console.error(`  ❌ Line ${lineNumber} 변환 실패:`, e.message);
      errorCount++;
    }
  }
  if (inheritedCount > 0) {
    console.log(`  ℹ️ ${inheritedCount}건 — D열 비어있어 직전 주문번호 상속 (멀티상품 추가 행)`);
  }
  console.log(`✅ 변환: ${transformedRows.length}건, skip ${skipCount}건, error ${errorCount}건`);

  console.log('\n=== Step 4: 동일 주문번호 그룹핑 ===');
  const groupedMap = new Map(); // order_id → row
  for (const r of transformedRows) {
    if (!groupedMap.has(r.order_id)) {
      groupedMap.set(r.order_id, {
        order_id: r.order_id,
        is_express: r.is_express,
        express_fee: r.express_fee,
        desired_ship_date: r.desired_ship_date,
        sticker_selections: [...r.sticker_selections_partial],
        cash_receipt_yn: r.cash_receipt_yn,
        receipt_type: r.receipt_type,
        receipt_number: r.receipt_number,
        submitted_at: r.submitted_at,
      });
    } else {
      // 기존 entry 에 sticker_selections 추가
      const existing = groupedMap.get(r.order_id);
      existing.sticker_selections.push(...r.sticker_selections_partial);
      // is_express 는 OR (어느 행이라도 빠른출고면 true)
      if (r.is_express) existing.is_express = true;
      // desired_ship_date — 일찍 채워진 게 우선 (보통 같음)
      if (!existing.desired_ship_date && r.desired_ship_date) existing.desired_ship_date = r.desired_ship_date;
    }
  }
  console.log(`✅ 그룹핑: ${transformedRows.length}행 → ${groupedMap.size}개 주문`);

  console.log('\n=== Step 5: 기존 입력 건 분리 ===');
  const newRows = [];
  let alreadyExistsCount = 0;
  for (const [orderId, row] of groupedMap.entries()) {
    if (existingOrderIds.has(orderId)) { alreadyExistsCount++; continue; }
    newRows.push(row);
  }
  console.log(`✅ 신규 ${newRows.length}건 / 이미 입력됨 ${alreadyExistsCount}건 (보존)`);

  console.log('\n=== Step 6: 변환 결과 미리보기 (첫 3건) ===');
  newRows.slice(0, 3).forEach((r, i) => {
    console.log(`\n[${i+1}] order_id=${r.order_id}`);
    console.log(`    is_express=${r.is_express}, ship=${r.desired_ship_date}, submitted=${r.submitted_at}`);
    console.log(`    sticker_selections (${r.sticker_selections.length}):`);
    r.sticker_selections.forEach(s => {
      console.log(`      - product=${s.product_code}, sticker=${s.sticker_code}(${s.sticker_id?'matched':'NO MATCH'}), msg='${(s.custom_values||{}).text||''}'`);
    });
  });

  // 매칭 안 된 스티커 코드 — 첫 등장 line + product_code 추적
  const unmatchedTrace = new Map(); // sticker_code → { count, firstLine, firstProductCode }
  // 1순위: groupedMap (그룹핑된 결과) 에 들어간 sticker_selections 추적
  for (const row of groupedMap.values()) {
    row.sticker_selections.forEach(s => {
      if (s.sticker_code && !s.sticker_id) {
        if (!unmatchedTrace.has(s.sticker_code)) {
          unmatchedTrace.set(s.sticker_code, { count: 0, firstLine: '?', firstProductCode: s.product_code || '?' });
        }
        unmatchedTrace.get(s.sticker_code).count++;
      }
    });
  }
  // 2순위: line 번호는 transformedRows 의 _lineNumber 로부터 (첫 등장)
  for (const r of transformedRows) {
    for (const s of (r.sticker_selections_partial || [])) {
      if (s.sticker_code && !s.sticker_id && unmatchedTrace.has(s.sticker_code)) {
        const trace = unmatchedTrace.get(s.sticker_code);
        if (trace.firstLine === '?') {
          trace.firstLine = r._lineNumber;
          trace.firstProductCode = s.product_code || '?';
        }
      }
    }
  }
  if (unmatchedTrace.size) {
    console.log(`\n⚠️  bg_stickers 에서 매칭 안 된 sticker_code (${unmatchedTrace.size}종):`);
    [...unmatchedTrace.entries()].forEach(([code, info]) => {
      console.log(`     '${code}' — ${info.count}건 (첫 등장 Line ${info.firstLine}, 상품 ${info.firstProductCode})`);
    });
    console.log(`    → sticker_id=null 로 저장됨. 화면에선 sticker_code 텍스트만 표시.`);
    console.log(`    → 의심 코드 (단순 숫자/날짜) 는 스프레드시트 컬럼 위치 확인 필요.`);
  }

  if (isDryRun) {
    console.log(`\n🛡️  DRY-RUN 모드 — 실제 INSERT 건너뜀.`);
    console.log(`     실제 실행하려면 --dry-run 빼고 다시 실행하세요.`);
    return;
  }

  console.log('\n=== Step 7: Supabase UPSERT ===');
  // ON CONFLICT DO NOTHING 으로 안전 — 기존 입력 건이 row 안에 섞여있어도 보존
  const BATCH = 50;
  let inserted = 0;
  for (let i = 0; i < newRows.length; i += BATCH) {
    const chunk = newRows.slice(i, i + BATCH);
    try {
      await bulkUpsert(chunk);
      inserted += chunk.length;
      console.log(`  ✓ ${i+1}~${i+chunk.length} / ${newRows.length}`);
    } catch (e) {
      console.error(`  ❌ ${i+1}~${i+chunk.length} 실패:`, e.message);
    }
  }
  console.log(`\n✅ 완료 — 신규 ${inserted}건 입력 (기존 ${alreadyExistsCount}건은 보존됨)`);
  console.log(`📋 검증: 관리자 페이지의 정보입력현황에서 backfill된 주문번호들 확인 가능.`);
}

main().catch(err => {
  console.error('❌ 치명적 오류:', err);
  process.exit(1);
});
