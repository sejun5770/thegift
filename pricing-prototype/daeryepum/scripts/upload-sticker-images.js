/**
 * 추출된 스티커 이미지를 Supabase Storage에 업로드
 *
 * 사전 준비:
 * 1. Supabase 대시보드에서 bucket 'bg-sticker-previews' 생성 (public)
 * 2. 환경변수 설정:
 *    - SUPABASE_URL
 *    - SUPABASE_SERVICE_ROLE_KEY (또는 ANON_KEY, bucket 정책에 따라)
 *
 * 실행: node scripts/upload-sticker-images.js
 * 의존성 없음 (Node 18+ 내장 fetch 사용)
 */
const fs = require('fs');
const path = require('path');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('SUPABASE_URL 또는 SUPABASE_SERVICE_ROLE_KEY(ANON_KEY) 미설정');
  process.exit(1);
}

const BUCKET = 'bg-sticker-previews';
const TMP_DIR = path.resolve(__dirname, '..', 'tmp', 'sticker-extract');
const IMG_DIR = path.join(TMP_DIR, 'images');
const MAPPING_PATH = path.join(TMP_DIR, 'mapping.json');

if (!fs.existsSync(MAPPING_PATH)) {
  console.error(`먼저 extract-sticker-images.js를 실행하세요.`);
  process.exit(1);
}

const { mapping } = JSON.parse(fs.readFileSync(MAPPING_PATH, 'utf8'));

function mimeFromExt(ext) {
  return {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
  }[ext.toLowerCase()] || 'application/octet-stream';
}

async function uploadOne(entry) {
  const filePath = path.join(IMG_DIR, entry.outputFile);
  if (!fs.existsSync(filePath)) throw new Error(`missing: ${filePath}`);
  const data = fs.readFileSync(filePath);
  const mime = mimeFromExt(path.extname(entry.outputFile));

  const url = `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${encodeURIComponent(entry.outputFile)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': mime,
      'x-upsert': 'true',
    },
    body: data,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`upload fail ${entry.outputFile}: ${res.status} ${text}`);
  }

  const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${encodeURIComponent(entry.outputFile)}`;
  return { sticker_code: entry.sticker_code, publicUrl };
}

(async () => {
  const urls = [];
  let ok = 0, fail = 0;

  for (const entry of mapping) {
    try {
      const result = await uploadOne(entry);
      urls.push(result);
      ok++;
      process.stdout.write(`.`);
    } catch (err) {
      console.error(`\n${entry.sticker_code}: ${err.message}`);
      fail++;
    }
  }

  fs.writeFileSync(path.join(TMP_DIR, 'urls.json'), JSON.stringify(urls, null, 2));
  console.log(`\n업로드 완료: ${ok} 성공 / ${fail} 실패`);
  console.log(`URL 목록: ${path.join(TMP_DIR, 'urls.json')}`);
})();
