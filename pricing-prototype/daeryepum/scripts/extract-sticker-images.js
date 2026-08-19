/**
 * 스티커 이미지 추출 스크립트
 * - xlsx 파일의 "스티커관리" 시트(sheet6)에 내장된 이미지를 추출
 * - 1:2 중복 이미지는 PNG 우선 규칙 적용
 * - 출력: ./output/images/{sticker_code}.{ext} + ./output/mapping.json
 *
 * 실행: node scripts/extract-sticker-images.js <xlsx-path>
 * 의존성 없음 (Node.js 내장 모듈만 사용)
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const xlsxPath = process.argv[2];
if (!xlsxPath) {
  console.error('Usage: node extract-sticker-images.js <xlsx-path>');
  process.exit(1);
}
if (!fs.existsSync(xlsxPath)) {
  console.error(`File not found: ${xlsxPath}`);
  process.exit(1);
}

const OUT_DIR = path.resolve(__dirname, '..', 'tmp', 'sticker-extract');
const IMG_DIR = path.join(OUT_DIR, 'images');
fs.mkdirSync(IMG_DIR, { recursive: true });

// ──────────────────────────────────────────────
// 간단한 ZIP 파서 (Central Directory 읽기)
// ──────────────────────────────────────────────
function parseZip(buf) {
  // Find End of Central Directory (EOCD)
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 65536; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('EOCD not found');

  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const entryCount = buf.readUInt16LE(eocd + 10);

  const entries = {};
  let p = cdOffset;
  for (let n = 0; n < entryCount; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad CD sig');
    const compMethod = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localHeaderOffset = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    entries[name] = { localHeaderOffset, compSize, compMethod };
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readFile(buf, entries, name) {
  const e = entries[name];
  if (!e) throw new Error(`entry not found: ${name}`);
  const lh = e.localHeaderOffset;
  if (buf.readUInt32LE(lh) !== 0x04034b50) throw new Error('bad LFH');
  const nameLen = buf.readUInt16LE(lh + 26);
  const extraLen = buf.readUInt16LE(lh + 28);
  const dataStart = lh + 30 + nameLen + extraLen;
  const data = buf.slice(dataStart, dataStart + e.compSize);
  if (e.compMethod === 0) return data;
  if (e.compMethod === 8) return zlib.inflateRawSync(data);
  throw new Error(`unsupported compression: ${e.compMethod}`);
}

// ──────────────────────────────────────────────
// XLSX 분석
// ──────────────────────────────────────────────
const buf = fs.readFileSync(xlsxPath);
const entries = parseZip(buf);

// 1) workbook.xml → "스티커관리" 시트의 rId 찾기
const wb = readFile(buf, entries, 'xl/workbook.xml').toString('utf8');
const stickerSheetMatch = /<sheet[^>]*name="스티커관리"[^>]*r:id="(rId\d+)"/.exec(wb);
if (!stickerSheetMatch) throw new Error('"스티커관리" 시트를 찾을 수 없습니다');
const stickerRId = stickerSheetMatch[1];

// 2) workbook.xml.rels → rId → sheet 경로
const wbRels = readFile(buf, entries, 'xl/_rels/workbook.xml.rels').toString('utf8');
const sheetTargetRe = new RegExp(`<Relationship[^>]*Id="${stickerRId}"[^>]*Target="([^"]+)"`);
const sheetTargetMatch = sheetTargetRe.exec(wbRels);
if (!sheetTargetMatch) throw new Error('sheet target not found');
const sheetPath = 'xl/' + sheetTargetMatch[1].replace(/^\/?xl\//, '');
const sheetBase = path.basename(sheetPath, '.xml'); // sheet6

// 3) sheet6.xml.rels → drawing 참조
const sheetRels = readFile(buf, entries, `xl/worksheets/_rels/${sheetBase}.xml.rels`).toString('utf8');
const drawingRefMatch = /<Relationship[^>]*Type="[^"]*\/drawing"[^>]*Target="\.\.\/drawings\/(drawing\d+\.xml)"/.exec(sheetRels);
if (!drawingRefMatch) throw new Error('drawing reference not found in sheet rels');
const drawingFile = drawingRefMatch[1]; // drawing6.xml

// 4) drawingN.xml.rels → rId → image file
const drawingRels = readFile(buf, entries, `xl/drawings/_rels/${drawingFile}.rels`).toString('utf8');
const rIdToImage = {};
for (const m of drawingRels.matchAll(/Id="(rId\d+)"[^>]*Target="\.\.\/media\/([^"]+)"/g)) {
  rIdToImage[m[1]] = m[2];
}

// 5) drawingN.xml → anchor row + rId
const drawingXml = readFile(buf, entries, `xl/drawings/${drawingFile}`).toString('utf8');
const rIdToRow = {};
const anchorRe = /<xdr:from>[\s\S]*?<xdr:row>(\d+)<\/xdr:row>[\s\S]*?<\/xdr:from>[\s\S]*?r:embed="(rId\d+)"/g;
for (const m of drawingXml.matchAll(anchorRe)) {
  rIdToRow[m[2]] = parseInt(m[1], 10) + 1; // xlsx row는 1-based
}

// 6) sharedStrings.xml
let sharedStrings = [];
if (entries['xl/sharedStrings.xml']) {
  const ss = readFile(buf, entries, 'xl/sharedStrings.xml').toString('utf8');
  for (const m of ss.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    const texts = [...m[1].matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map(x => x[1]);
    sharedStrings.push(texts.join(''));
  }
}

// 7) sheet6.xml → row별 C열(sticker_code) 추출
const sheetXml = readFile(buf, entries, sheetPath).toString('utf8');
const rowToCode = {};
const rowRe = /<row r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
for (const rm of sheetXml.matchAll(rowRe)) {
  const rowNum = parseInt(rm[1], 10);
  const cellC = /<c r="C\d+"(?:\s+s="\d+")?(?:\s+t="([^"]+)")?[^>]*>(?:<v>([^<]*)<\/v>|<is><t[^>]*>([^<]*)<\/t><\/is>)?<\/c>/.exec(rm[2]);
  if (!cellC) continue;
  const type = cellC[1];
  const val = cellC[2] || cellC[3] || '';
  const finalVal = type === 's' ? (sharedStrings[parseInt(val, 10)] || '') : val;
  if (/^TG[A-Z0-9]+S\d+$|^[A-Z]{3}\d+S\d+$/.test(finalVal)) {
    rowToCode[rowNum] = finalVal.trim();
  }
}

// 8) row별 이미지 목록 만들고 PNG 우선 규칙 적용
const rowToImages = {};
for (const [rId, row] of Object.entries(rIdToRow)) {
  if (!rowToImages[row]) rowToImages[row] = [];
  rowToImages[row].push(rIdToImage[rId]);
}

// 9) 최종 매핑 + 이미지 파일 저장
const mapping = [];
const stats = { total: 0, extracted: 0, skipped: 0, duplicateResolved: 0 };

for (const [row, code] of Object.entries(rowToCode)) {
  const imgs = rowToImages[row];
  if (!imgs || imgs.length === 0) {
    stats.skipped++;
    continue;
  }
  stats.total++;

  let picked;
  if (imgs.length === 1) {
    picked = imgs[0];
  } else {
    // PNG 우선
    const png = imgs.find(i => i.toLowerCase().endsWith('.png'));
    picked = png || imgs[0];
    stats.duplicateResolved++;
  }

  const ext = path.extname(picked);
  const outName = `${code}${ext}`;
  const imgBuf = readFile(buf, entries, `xl/media/${picked}`);
  fs.writeFileSync(path.join(IMG_DIR, outName), imgBuf);
  stats.extracted++;

  mapping.push({
    sticker_code: code,
    row: parseInt(row, 10),
    sourceImage: picked,
    outputFile: outName,
    alternatives: imgs.filter(i => i !== picked),
  });
}

fs.writeFileSync(
  path.join(OUT_DIR, 'mapping.json'),
  JSON.stringify({ stats, mapping }, null, 2),
);

console.log('=== 추출 완료 ===');
console.log(`총 스티커 코드: ${Object.keys(rowToCode).length}`);
console.log(`추출 성공: ${stats.extracted}`);
console.log(`중복 이미지 해결: ${stats.duplicateResolved}`);
console.log(`이미지 없음(skip): ${stats.skipped}`);
console.log(`출력 폴더: ${IMG_DIR}`);
console.log(`매핑 JSON: ${path.join(OUT_DIR, 'mapping.json')}`);
