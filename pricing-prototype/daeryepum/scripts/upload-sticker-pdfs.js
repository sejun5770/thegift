/**
 * 변환된 스티커 PNG → Supabase Storage 업로드 + bg_stickers.preview_image_url 갱신
 *
 * 사전:
 *   1. convert-sticker-pdfs.js 선행 실행
 *   2. 환경변수 (.env.local 또는 셸):
 *      - SUPABASE_URL 또는 NEXT_PUBLIC_SUPABASE_URL
 *      - SUPABASE_SERVICE_ROLE_KEY (권장, Storage 권한 필요) 또는 SUPABASE_ANON_KEY
 *      - (폴백) NEXT_PUBLIC_SUPABASE_ANON_KEY
 *   3. Supabase 대시보드에서 bucket 'bg-sticker-previews' 가 public으로 생성돼 있어야 함
 *
 * 실행:
 *   node pricing-prototype/daeryepum/scripts/upload-sticker-pdfs.js
 *   node pricing-prototype/daeryepum/scripts/upload-sticker-pdfs.js --dry-run  # 업로드 안 하고 계획만
 */
const fs = require('fs');
const path = require('path');

// .env.local 자동 로드
(function loadEnvLocal() {
  const envPath = path.resolve(__dirname, '..', '..', '..', '.env.local');
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, 'utf8');
  raw.split(/\r?\n/).forEach(line => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  });
})();

const argv = process.argv.slice(2).reduce((o, a) => {
  if (a.startsWith('--')) o[a.slice(2)] = true;
  return o;
}, {});
const DRY_RUN = !!argv['dry-run'];

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('SUPABASE_URL / SUPABASE_KEY 환경변수 필요 (.env.local 확인)');
  process.exit(1);
}

const BUCKET = 'bg-sticker-previews';
const PNG_DIR = path.resolve(__dirname, '..', 'tmp', 'sticker-png');
const MANIFEST = path.join(PNG_DIR, '_manifest.json');

if (!fs.existsSync(MANIFEST)) {
  console.error(`먼저 convert-sticker-pdfs.js 실행 필요 (매니페스트 없음: ${MANIFEST})`);
  process.exit(1);
}
const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
console.log(`[upload] 매니페스트 항목 ${manifest.entries.length}개, DPI=${manifest.dpi}, DRY_RUN=${DRY_RUN}`);

async function uploadOne(stickerCode, pngBuffer) {
  const fileName = `${stickerCode}.png`;
  const url = `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${encodeURIComponent(fileName)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'image/png',
      'x-upsert': 'true',
      'Cache-Control': 'public, max-age=3600',
    },
    body: pngBuffer,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`upload ${fileName}: ${res.status} ${text}`);
  }
  // public URL
  return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${encodeURIComponent(fileName)}`;
}

async function updateDbUrl(stickerCode, publicUrl) {
  const url = `${SUPABASE_URL}/rest/v1/bg_stickers?sticker_code=eq.${encodeURIComponent(stickerCode)}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify({ preview_image_url: publicUrl, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`db patch ${stickerCode}: ${res.status} ${text}`);
  }
  const rows = await res.json();
  return rows.length;
}

async function main() {
  let ok = 0, uploadedOnly = 0, notFoundInDb = 0, fail = 0;
  const report = [];

  for (const entry of manifest.entries) {
    const stickerCode = entry.sticker_code;
    const pngPath = path.join(PNG_DIR, entry.png);
    if (!fs.existsSync(pngPath)) {
      console.error(`  ✗ ${stickerCode}: PNG 없음 (${pngPath})`);
      fail++;
      continue;
    }
    try {
      const pngBuf = fs.readFileSync(pngPath);
      let publicUrl;
      if (DRY_RUN) {
        publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${encodeURIComponent(stickerCode + '.png')}`;
        console.log(`  [dry] ${stickerCode} → ${publicUrl}`);
      } else {
        publicUrl = await uploadOne(stickerCode, pngBuf);
        const updatedCount = await updateDbUrl(stickerCode, publicUrl);
        if (updatedCount === 0) {
          notFoundInDb++;
          console.warn(`  ⚠ ${stickerCode}: 업로드 OK, DB에 해당 sticker_code 없음`);
        } else {
          ok++;
          console.log(`  ✓ ${stickerCode} (${(pngBuf.length/1024).toFixed(1)} KB) → DB 갱신 ${updatedCount}행`);
        }
      }
      report.push({ sticker_code: stickerCode, public_url: publicUrl, size: pngBuf.length });
    } catch (e) {
      fail++;
      console.error(`  ✗ ${stickerCode}: ${e.message}`);
    }
  }

  const reportPath = path.join(PNG_DIR, '_upload_report.json');
  fs.writeFileSync(reportPath, JSON.stringify({ dry_run: DRY_RUN, ok, notFoundInDb, fail, entries: report }, null, 2));

  console.log(`\n완료: 성공 ${ok}, DB 미존재 ${notFoundInDb}, 실패 ${fail}`);
  console.log(`리포트: ${reportPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
