/**
 * 스티커 샘플 PDF → PNG 변환
 *
 * 입력: C:\Users\LG\Downloads\답례품 스티커 샘플\*.pdf
 *   - 파일명은 sticker_code. 콤마로 구분된 경우(예: TGJBK04S1,TGJBK05S1.pdf)
 *     각각의 sticker_code에 동일 PNG 복제 저장.
 * 출력: pricing-prototype/daeryepum/tmp/sticker-png/{sticker_code}.png
 *
 * 의존성: @napi-rs/canvas, pdfjs-dist (legacy)
 *
 * 실행:
 *   node pricing-prototype/daeryepum/scripts/convert-sticker-pdfs.js
 *   node pricing-prototype/daeryepum/scripts/convert-sticker-pdfs.js --dpi=300  # 고해상도
 *   node pricing-prototype/daeryepum/scripts/convert-sticker-pdfs.js --source="..."  # 경로 변경
 */
const fs = require('fs');
const path = require('path');
const { createCanvas } = require('@napi-rs/canvas');

// pdfjs-dist는 CJS require와 잘 맞지 않아 동적 import 사용
async function loadPdfjs() {
  return await import('pdfjs-dist/legacy/build/pdf.mjs');
}

const argv = require('minimist')
  ? require('minimist')(process.argv.slice(2))
  : parseArgv();
function parseArgv() {
  const o = {};
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) o[m[1]] = m[2];
    else if (a.startsWith('--')) o[a.slice(2)] = true;
  }
  return o;
}

const DEFAULT_SOURCE = 'C:\\Users\\LG\\Downloads\\답례품 스티커 샘플';
const SOURCE_DIR = argv.source || DEFAULT_SOURCE;
const OUT_DIR = path.resolve(__dirname, '..', 'tmp', 'sticker-png');
const DPI = parseInt(argv.dpi || '150', 10);
// PDF default is 72 DPI, so scale = DPI / 72
const SCALE = DPI / 72;

function ensureDir(d) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

/**
 * pdfjs v5의 NodeBinaryDataFactory는 `fs.promises.readFile(url)` 을 그대로 사용하므로
 * file:// 문자열이 아닌 URL 객체(또는 일반 경로)를 받아야 동작.
 * 기본 구현을 오버라이드해서 string URL을 URL 객체로 변환.
 */
async function renderPdfToPng(pdfjs, pdfPath) {
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const pdfBase = path.dirname(require.resolve('pdfjs-dist/legacy/build/pdf.mjs'));
  const pkgRoot = path.join(pdfBase, '..', '..');
  const cMapUrl = require('url').pathToFileURL(path.join(pkgRoot, 'cmaps')).href + '/';
  const fontUrl = require('url').pathToFileURL(path.join(pkgRoot, 'standard_fonts')).href + '/';

  // pdfjs v5 BaseBinaryDataFactory 호환 클래스 (Node 환경에서 file:// URL 문자열을 URL 객체로 변환)
  // pdfjs 기본 NodeBinaryDataFactory는 fs.readFile(stringURL)을 호출해 실패하므로 오버라이드.
  class FixedNodeBinaryDataFactory {
    constructor({ cMapUrl = null, standardFontDataUrl = null, wasmUrl = null }) {
      this.cMapUrl = cMapUrl;
      this.standardFontDataUrl = standardFontDataUrl;
      this.wasmUrl = wasmUrl;
    }
    async fetch({ kind, filename }) {
      const baseUrl = this[kind];
      if (!baseUrl) throw new Error(`Missing ${kind}`);
      const fullUrl = baseUrl + filename;
      const fsp = require('fs').promises;
      try {
        // string file:// URL을 URL 객체로 변환해 readFile 호출
        const urlObj = fullUrl.startsWith('file:') ? new URL(fullUrl) : fullUrl;
        const buf = await fsp.readFile(urlObj);
        return new Uint8Array(buf);
      } catch (e) {
        throw new Error(`Unable to load ${kind} data at: ${fullUrl} (${e.message})`);
      }
    }
  }

  const loadingTask = pdfjs.getDocument({
    data,
    BinaryDataFactory: FixedNodeBinaryDataFactory,
    cMapUrl,
    cMapPacked: true,
    standardFontDataUrl: fontUrl,
    disableFontFace: false,
    useSystemFonts: false,
  });
  const doc = await loadingTask.promise;
  const page = await doc.getPage(1);
  const viewport = page.getViewport({ scale: SCALE });

  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const ctx = canvas.getContext('2d');
  // 흰 배경 (투명 PDF 대비)
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  await page.render({ canvasContext: ctx, viewport }).promise;
  await doc.destroy();

  return canvas.toBuffer('image/png');
}

function parseStickerCodesFromFilename(baseNameNoExt) {
  // 파일명에 콤마 → 여러 sticker_code
  return baseNameNoExt
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

async function main() {
  console.log(`[convert] source: ${SOURCE_DIR}`);
  console.log(`[convert] output: ${OUT_DIR}`);
  console.log(`[convert] DPI: ${DPI} (scale ${SCALE}x)`);

  if (!fs.existsSync(SOURCE_DIR)) {
    console.error(`소스 폴더 없음: ${SOURCE_DIR}`);
    process.exit(1);
  }
  ensureDir(OUT_DIR);

  const pdfjs = await loadPdfjs();
  const files = fs.readdirSync(SOURCE_DIR).filter(f => f.toLowerCase().endsWith('.pdf'));
  console.log(`[convert] PDF 파일 ${files.length}개 발견`);

  const manifest = [];
  let ok = 0, fail = 0, duplicated = 0;

  for (const file of files) {
    const baseName = file.replace(/\.pdf$/i, '');
    const codes = parseStickerCodesFromFilename(baseName);
    const pdfPath = path.join(SOURCE_DIR, file);

    try {
      const pngBuf = await renderPdfToPng(pdfjs, pdfPath);
      // 각 sticker_code에 동일 PNG 저장
      for (const code of codes) {
        const outPath = path.join(OUT_DIR, `${code}.png`);
        fs.writeFileSync(outPath, pngBuf);
        manifest.push({ sticker_code: code, source_pdf: file, png: `${code}.png`, size: pngBuf.length });
        if (codes.length > 1) duplicated++;
      }
      ok++;
      console.log(`  ✓ ${file} → ${codes.map(c => c + '.png').join(', ')} (${(pngBuf.length/1024).toFixed(1)} KB)`);
    } catch (e) {
      fail++;
      console.error(`  ✗ ${file}: ${e.message}`);
    }
  }

  fs.writeFileSync(
    path.join(OUT_DIR, '_manifest.json'),
    JSON.stringify({ dpi: DPI, scale: SCALE, generated_at: new Date().toISOString(), ok, fail, duplicated, entries: manifest }, null, 2)
  );

  console.log(`\n완료: ${ok}개 PDF 성공, ${fail}개 실패, PNG 총 ${manifest.length}개 생성 (콤마 복제 ${duplicated}개 포함)`);
  console.log(`매니페스트: ${path.join(OUT_DIR, '_manifest.json')}`);
}

main().catch(e => { console.error(e); process.exit(1); });
