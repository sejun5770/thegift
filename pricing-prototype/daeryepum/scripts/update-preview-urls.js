/**
 * urls.json의 public URL을 bg_stickers.preview_image_url에 반영
 *
 * 실행: node scripts/update-preview-urls.js
 */
const fs = require('fs');
const path = require('path');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('SUPABASE_URL / SUPABASE_KEY 미설정');
  process.exit(1);
}

const TMP_DIR = path.resolve(__dirname, '..', 'tmp', 'sticker-extract');
const URLS_PATH = path.join(TMP_DIR, 'urls.json');
if (!fs.existsSync(URLS_PATH)) {
  console.error('먼저 upload-sticker-images.js 실행');
  process.exit(1);
}

const urls = JSON.parse(fs.readFileSync(URLS_PATH, 'utf8'));

const REST = `${SUPABASE_URL}/rest/v1`;
const HEADERS = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
  Prefer: 'return=minimal',
};

(async () => {
  let ok = 0, fail = 0;
  for (const { sticker_code, publicUrl } of urls) {
    const url = `${REST}/bg_stickers?sticker_code=eq.${encodeURIComponent(sticker_code)}`;
    const res = await fetch(url, {
      method: 'PATCH',
      headers: HEADERS,
      body: JSON.stringify({ preview_image_url: publicUrl, updated_at: new Date().toISOString() }),
    });
    if (res.ok) {
      ok++;
      process.stdout.write('.');
    } else {
      const text = await res.text();
      console.error(`\n${sticker_code}: ${res.status} ${text}`);
      fail++;
    }
  }
  console.log(`\nDB 업데이트 완료: ${ok} 성공 / ${fail} 실패`);
})();
