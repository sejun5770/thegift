/**
 * 스티커 PDF → PNG 변환 (Chrome/Puppeteer 기반)
 *
 * pdfjs는 한글 임베디드 폰트를 제대로 렌더하지 못해 공백 이미지만 생성됨.
 * Chrome의 내장 PDF 렌더러(PDFium)는 한글 글리프를 정확히 처리하므로 이 쪽을 사용.
 *
 * 사용자의 로컬 Chrome을 직접 실행해서 PDF를 로드 → 스크린샷으로 저장.
 *
 * 실행:
 *   node pricing-prototype/daeryepum/scripts/convert-sticker-pdfs-chrome.js
 *   node pricing-prototype/daeryepum/scripts/convert-sticker-pdfs-chrome.js --scale=2
 */
const fs = require('fs');
const path = require('path');
const urlLib = require('url');

const argv = process.argv.slice(2).reduce((o, a) => {
  const m = a.match(/^--([^=]+)=(.*)$/);
  if (m) o[m[1]] = m[2];
  return o;
}, {});

const DEFAULT_SOURCE = 'C:\\Users\\LG\\Downloads\\답례품 스티커 샘플';
const SOURCE_DIR = argv.source || DEFAULT_SOURCE;
const OUT_DIR = path.resolve(__dirname, '..', 'tmp', 'sticker-png');
const SCALE = parseFloat(argv.scale || '2.5'); // 해상도 배율 (기본 2.5x ≈ 180dpi)
const CHROME_PATH = argv.chrome || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }

function parseStickerCodes(baseNameNoExt) {
  return baseNameNoExt.split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * PDF viewer 스크린샷에서 PDF 페이지 영역만 crop.
 * Chrome PDF viewer 배경은 항상 어두운 회색(#525659 또는 유사). 이 배경색을 4 모서리에서
 * 샘플링해 판별하고, 그 배경색과 다른 픽셀 영역을 찾아 crop. 이렇게 하면 PDF 페이지의
 * 배경색이 흰색이든 크림색이든 관계없이 정확한 경계를 찾을 수 있음.
 */
async function autoCropPdfPage(pngBuffer) {
  const { createCanvas, loadImage } = require('@napi-rs/canvas');
  const img = await loadImage(pngBuffer);
  const w = img.width, h = img.height;
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const imgData = ctx.getImageData(0, 0, w, h);
  const data = imgData.data;

  // 4 모서리에서 샘플링해 중앙값 계산 (viewer 배경색)
  const sample = [];
  const samplePoints = [
    [2, 2], [w - 3, 2], [2, h - 3], [w - 3, h - 3],
    [5, 5], [w - 6, 5], [5, h - 6], [w - 6, h - 6],
  ];
  for (const [x, y] of samplePoints) {
    const i = (y * w + x) * 4;
    sample.push([data[i], data[i + 1], data[i + 2]]);
  }
  const median = (arr) => arr.slice().sort((a, b) => a - b)[Math.floor(arr.length / 2)];
  const bgR = median(sample.map(s => s[0]));
  const bgG = median(sample.map(s => s[1]));
  const bgB = median(sample.map(s => s[2]));

  // 각 픽셀이 배경과 유의미하게 다른지 판정 (유클리드 거리 기준)
  const THRESHOLD_SQ = 40 * 40; // 각 채널 평균 ~23 이상 차이
  const isPageContent = (i) => {
    const dr = data[i] - bgR, dg = data[i + 1] - bgG, db = data[i + 2] - bgB;
    return (dr * dr + dg * dg + db * db) > THRESHOLD_SQ;
  };

  // #toolbar=0 URL 파라미터로 툴바가 이미 숨겨져 있으므로 별도 스킵 불필요
  let top = h, bottom = 0, left = w, right = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (isPageContent(i)) {
        if (y < top) top = y;
        if (y > bottom) bottom = y;
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
  }

  if (top >= bottom || left >= right) return pngBuffer;

  // 약간의 여백 추가
  const pad = 2;
  top = Math.max(0, top - pad);
  bottom = Math.min(h - 1, bottom + pad);
  left = Math.max(0, left - pad);
  right = Math.min(w - 1, right + pad);
  const cw = right - left + 1, ch = bottom - top + 1;

  const out = createCanvas(cw, ch);
  const octx = out.getContext('2d');
  octx.drawImage(canvas, left, top, cw, ch, 0, 0, cw, ch);
  return out.toBuffer('image/png');
}

async function main() {
  const puppeteer = require('puppeteer-core');

  console.log(`[chrome-convert] source: ${SOURCE_DIR}`);
  console.log(`[chrome-convert] output: ${OUT_DIR}`);
  console.log(`[chrome-convert] scale: ${SCALE}x`);
  console.log(`[chrome-convert] chrome: ${CHROME_PATH}`);
  ensureDir(OUT_DIR);

  if (!fs.existsSync(CHROME_PATH)) {
    console.error('Chrome 실행파일을 찾을 수 없습니다: ' + CHROME_PATH);
    console.error('--chrome="C:\\Path\\To\\chrome.exe" 로 경로 지정 가능');
    process.exit(1);
  }

  const launchOpts = {
    executablePath: CHROME_PATH,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  };
  let browser = await puppeteer.launch(launchOpts);

  try {
    const files = fs.readdirSync(SOURCE_DIR).filter(f => f.toLowerCase().endsWith('.pdf'));
    console.log(`[chrome-convert] PDF ${files.length}개 발견`);

    const manifest = [];
    let ok = 0, fail = 0;
    let processed = 0;
    const BATCH_SIZE = 10;  // 매 10개마다 브라우저 재시작 (메모리/프로필 누적 방지)

    for (const file of files) {
      // 배치 크기 초과 시 브라우저 재시작
      if (processed > 0 && processed % BATCH_SIZE === 0) {
        await browser.close().catch(() => {});
        await new Promise(r => setTimeout(r, 500));
        browser = await puppeteer.launch(launchOpts);
        console.log(`  [재시작] ${processed}개 처리 후 브라우저 재시작`);
      }
      processed++;
      const baseName = file.replace(/\.pdf$/i, '');
      const codes = parseStickerCodes(baseName);
      const pdfPath = path.join(SOURCE_DIR, file);

      try {
        const page = await browser.newPage();
        // PDF 페이지가 fit-to-width로 보이도록 viewport를 크게 (스티커 크기 대비 2배 가로)
        const viewportW = Math.ceil(142 * SCALE) * 2;
        const viewportH = Math.ceil(198 * SCALE) * 2;
        await page.setViewport({ width: viewportW, height: viewportH, deviceScaleFactor: 1 });

        // PDF를 file:// URL로 직접 로드. Chrome 내장 PDF viewer가 엽니다.
        const fileUrl = urlLib.pathToFileURL(pdfPath).href;
        await page.goto(fileUrl + '#toolbar=0', { waitUntil: 'networkidle0', timeout: 30000 });

        // PDF 렌더링 대기 (한글 포함 폰트 로딩 시간)
        await new Promise(r => setTimeout(r, 2000));

        const fullBuf = await page.screenshot({ type: 'png', omitBackground: false });
        await page.close();

        // 자동 crop: viewer 배경색(모서리 샘플링)과 다른 영역 = PDF 페이지만 남김
        // 페이지 배경이 흰/크림/컬러 어떤 색이든 정확히 처리
        const buf = await autoCropPdfPage(fullBuf);

        // 각 sticker_code에 저장
        for (const code of codes) {
          const outPath = path.join(OUT_DIR, `${code}.png`);
          fs.writeFileSync(outPath, buf);
          manifest.push({ sticker_code: code, source_pdf: file, png: `${code}.png`, size: buf.length });
        }
        ok++;
        console.log(`  ✓ ${file} → ${codes.map(c => c + '.png').join(', ')} (${(buf.length/1024).toFixed(1)} KB)`);
      } catch (e) {
        fail++;
        console.error(`  ✗ ${file}: ${e.message}`);
      }
    }

    fs.writeFileSync(
      path.join(OUT_DIR, '_manifest.json'),
      JSON.stringify({ method: 'chrome', scale: SCALE, generated_at: new Date().toISOString(), ok, fail, entries: manifest }, null, 2)
    );

    console.log(`\n완료: ${ok}개 PDF 성공, ${fail}개 실패, PNG 총 ${manifest.length}개 생성`);
  } finally {
    await browser.close();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
