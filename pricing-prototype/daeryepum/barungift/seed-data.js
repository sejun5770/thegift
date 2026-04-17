/**
 * seed-data.js
 *
 * Reads stickers.csv and products.csv from the daeryepum directory,
 * parses them, and generates:
 *   - data/bg_stickers.json
 *   - data/bg_product_settings.json
 *
 * Usage: node barungift/seed-data.js  (from the daeryepum directory)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const BASE_DIR = path.resolve(__dirname, '..');
const STICKERS_CSV = path.join(BASE_DIR, 'stickers.csv');
const PRODUCTS_CSV = path.join(BASE_DIR, 'products.csv');
const DATA_DIR = path.join(BASE_DIR, 'data');
const STICKERS_OUT = path.join(DATA_DIR, 'bg_stickers.json');
const PRODUCTS_OUT = path.join(DATA_DIR, 'bg_product_settings.json');

// ---------------------------------------------------------------------------
// CSV Parser – handles quoted fields with commas and embedded newlines
// ---------------------------------------------------------------------------
function parseCSV(text) {
  const rows = [];
  let currentRow = [];
  let currentField = '';
  let insideQuotes = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (insideQuotes) {
      if (ch === '"') {
        // Look ahead for escaped quote ("")
        if (i + 1 < text.length && text[i + 1] === '"') {
          currentField += '"';
          i += 2;
          continue;
        }
        // End of quoted field
        insideQuotes = false;
        i++;
        continue;
      }
      currentField += ch;
      i++;
    } else {
      if (ch === '"') {
        insideQuotes = true;
        i++;
      } else if (ch === ',') {
        currentRow.push(currentField);
        currentField = '';
        i++;
      } else if (ch === '\r') {
        // Skip \r, handle \r\n as \n
        i++;
      } else if (ch === '\n') {
        currentRow.push(currentField);
        currentField = '';
        rows.push(currentRow);
        currentRow = [];
        i++;
      } else {
        currentField += ch;
        i++;
      }
    }
  }

  // Push last field/row
  if (currentField || currentRow.length > 0) {
    currentRow.push(currentField);
    rows.push(currentRow);
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function trim(s) {
  return (s || '').trim();
}

function isNumeric(s) {
  return /^\d+$/.test(trim(s));
}

// ---------------------------------------------------------------------------
// Parse stickers
// ---------------------------------------------------------------------------
function parseStickers() {
  const raw = fs.readFileSync(STICKERS_CSV, 'utf-8');
  const rows = parseCSV(raw);

  const stickers = [];

  for (const row of rows) {
    const no = trim(row[0]);
    if (!isNumeric(no)) continue;

    const brand = trim(row[1]);
    const code = trim(row[2]);
    const type = trim(row[3]).replace(/\n/g, ' '); // collapse multiline types
    const usage = trim(row[4]);
    const spec = trim(row[5]);

    // Col 8 = product mapping codes (may contain newlines)
    const rawMapping = trim(row[8] || '');
    const productCodes = rawMapping
      ? rawMapping
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];

    // Col 11 = notes
    const note = trim(row[11] || '');

    // Skip rows without a sticker code
    if (!code) continue;

    stickers.push({
      id: crypto.randomUUID(),
      name: `${brand} ${type}`,
      sticker_code: code,
      brand,
      type,
      usage,
      spec,
      product_codes: productCodes,
      note,
      preview_image_url: null,
      preview_color: '#FFFFFF',
      custom_fields: [],
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  }

  return stickers;
}

// ---------------------------------------------------------------------------
// Parse products
// ---------------------------------------------------------------------------
function parseProducts() {
  const raw = fs.readFileSync(PRODUCTS_CSV, 'utf-8');
  const rows = parseCSV(raw);

  const products = [];
  const seen = new Set();

  for (const row of rows) {
    const no = trim(row[1]); // Col 1 = NO
    if (!isNumeric(no)) continue;

    const brand = trim(row[2]);
    const productName = trim(row[3]);
    const productCode = trim(row[6]);

    // Skip rows without product code or name
    if (!productCode || !productName) continue;

    // Deduplicate by product code (same code may appear multiple times)
    if (seen.has(productCode)) continue;
    seen.add(productCode);

    products.push({
      product_id: productCode,
      product_name: productName,
      brand,
    });
  }

  return products;
}

// ---------------------------------------------------------------------------
// Build product settings with sticker mapping
// ---------------------------------------------------------------------------
function buildProductSettings(products, stickers) {
  return products.map((p) => {
    // Find stickers whose product_codes array includes this product_id
    const matchingStickers = stickers.filter((s) =>
      s.product_codes.includes(p.product_id)
    );

    return {
      id: crypto.randomUUID(),
      product_id: p.product_id,
      product_name: p.product_name,
      brand: p.brand,
      shipping_type: 'desired_date',
      cutoff_enabled: false,
      cutoff_hour: 14,
      cutoff_minute: 0,
      lead_time_days: 2,
      min_select_days: 3,
      max_select_days: 60,
      closed_weekdays: [0, 6],
      closed_dates: [],
      date_required: true,
      notice_enabled: false,
      notice_text: '',
      available_sticker_ids: matchingStickers.map((s) => s.id),
      express_available: false,
      express_fee: 0,
      express_cutoff_time: '14:00',
      blackout_dates: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('=== Barungift Seed Data Generator ===\n');

  // Ensure data directory exists
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    console.log(`Created directory: ${DATA_DIR}`);
  }

  // Parse stickers
  console.log(`Reading stickers from: ${STICKERS_CSV}`);
  const stickers = parseStickers();
  console.log(`  -> Parsed ${stickers.length} stickers`);

  // Parse products
  console.log(`Reading products from: ${PRODUCTS_CSV}`);
  const products = parseProducts();
  console.log(`  -> Parsed ${products.length} unique products`);

  // Build product settings with sticker mapping
  const productSettings = buildProductSettings(products, stickers);

  // Count products with sticker mappings
  const withStickers = productSettings.filter(
    (p) => p.available_sticker_ids.length > 0
  ).length;
  const withoutStickers = productSettings.filter(
    (p) => p.available_sticker_ids.length === 0
  ).length;

  // Write output files
  fs.writeFileSync(STICKERS_OUT, JSON.stringify(stickers, null, 2), 'utf-8');
  console.log(`\nWrote ${stickers.length} stickers to: ${STICKERS_OUT}`);

  fs.writeFileSync(
    PRODUCTS_OUT,
    JSON.stringify(productSettings, null, 2),
    'utf-8'
  );
  console.log(`Wrote ${productSettings.length} product settings to: ${PRODUCTS_OUT}`);

  // Summary
  console.log('\n=== Summary ===');
  console.log(`Stickers: ${stickers.length}`);
  console.log(`Products: ${productSettings.length}`);
  console.log(`  - with sticker mappings: ${withStickers}`);
  console.log(`  - without sticker mappings: ${withoutStickers}`);

  // Show brand breakdown
  const stickerBrands = {};
  for (const s of stickers) {
    stickerBrands[s.brand] = (stickerBrands[s.brand] || 0) + 1;
  }
  console.log('\nStickers by brand:');
  for (const [brand, count] of Object.entries(stickerBrands).sort(
    (a, b) => b[1] - a[1]
  )) {
    console.log(`  ${brand}: ${count}`);
  }

  const productBrands = {};
  for (const p of productSettings) {
    const b = p.brand || '(no brand)';
    productBrands[b] = (productBrands[b] || 0) + 1;
  }
  console.log('\nProducts by brand:');
  for (const [brand, count] of Object.entries(productBrands).sort(
    (a, b) => b[1] - a[1]
  )) {
    console.log(`  ${brand}: ${count}`);
  }

  // Show sticker-product mapping details
  console.log('\nSticker-Product mappings:');
  for (const ps of productSettings) {
    if (ps.available_sticker_ids.length > 0) {
      const stickerNames = ps.available_sticker_ids.map((id) => {
        const s = stickers.find((st) => st.id === id);
        return s ? s.sticker_code : id;
      });
      console.log(
        `  ${ps.product_id} (${ps.product_name}): ${stickerNames.join(', ')}`
      );
    }
  }

  // --------------------------------------------------------------------
  // Supabase 업로드 (환경변수 SUPABASE_URL + SUPABASE_ANON_KEY 필요)
  // --------------------------------------------------------------------
  const SUPABASE_URL = process.env.SUPABASE_URL || '';
  const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const uploadToSupabase = process.argv.includes('--supabase');

  if (uploadToSupabase) {
    if (!SUPABASE_URL || !SUPABASE_KEY) {
      console.error('\n❌ SUPABASE_URL 또는 SUPABASE_ANON_KEY 환경변수가 설정되지 않았습니다.');
      process.exit(1);
    }
    console.log('\n=== Supabase 업로드 시작 ===');
    console.log('URL:', SUPABASE_URL);

    return uploadAll(stickers, productSettings, SUPABASE_URL, SUPABASE_KEY);
  } else {
    console.log('\n💡 Supabase에 업로드하려면: node barungift/seed-data.js --supabase');
    console.log('   (SUPABASE_URL, SUPABASE_ANON_KEY 환경변수 필요)');
  }
}

async function uploadAll(stickers, productSettings, supaUrl, supaKey) {
  const headers = {
    apikey: supaKey,
    Authorization: `Bearer ${supaKey}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation,resolution=merge-duplicates',
  };

  // 1. 스티커 upsert (sticker_code 기준)
  console.log(`\n📤 Uploading ${stickers.length} stickers...`);
  const stickerRows = stickers.map((s) => ({
    id: s.id,
    name: s.name,
    preview_image_url: s.preview_image_url,
    preview_color: s.preview_color,
    custom_fields: s.custom_fields,
    is_active: s.is_active,
    sticker_code: s.sticker_code,
    brand: s.brand,
    sticker_type: s.type,
    usage: s.usage,
    spec: s.spec,
    product_codes: s.product_codes,
    note: s.note,
  }));

  let resp = await fetch(`${supaUrl}/rest/v1/bg_stickers?on_conflict=sticker_code`, {
    method: 'POST',
    headers,
    body: JSON.stringify(stickerRows),
  });
  if (!resp.ok) {
    const err = await resp.text();
    console.error('❌ Sticker upload failed:', resp.status, err);
    process.exit(1);
  }
  console.log(`✅ ${stickers.length} stickers uploaded`);

  // 2. 상품 설정 upsert (product_id 기준)
  console.log(`\n📤 Uploading ${productSettings.length} product settings...`);
  const productRows = productSettings.map((p) => ({
    id: p.id,
    product_id: p.product_id,
    product_name: p.product_name,
    brand: p.brand,
    shipping_type: p.shipping_type,
    cutoff_enabled: p.cutoff_enabled,
    cutoff_hour: p.cutoff_hour,
    cutoff_minute: p.cutoff_minute,
    lead_time_days: p.lead_time_days,
    min_select_days: p.min_select_days,
    max_select_days: p.max_select_days,
    closed_weekdays: p.closed_weekdays,
    closed_dates: p.closed_dates,
    date_required: p.date_required,
    notice_enabled: p.notice_enabled,
    notice_text: p.notice_text,
    available_sticker_ids: p.available_sticker_ids,
    express_available: p.express_available,
    express_fee: p.express_fee,
    express_cutoff_time: p.express_cutoff_time,
    blackout_dates: p.blackout_dates,
  }));

  resp = await fetch(`${supaUrl}/rest/v1/bg_product_settings?on_conflict=product_id`, {
    method: 'POST',
    headers,
    body: JSON.stringify(productRows),
  });
  if (!resp.ok) {
    const err = await resp.text();
    console.error('❌ Product settings upload failed:', resp.status, err);
    process.exit(1);
  }
  console.log(`✅ ${productSettings.length} product settings uploaded`);

  console.log('\n🎉 Supabase 업로드 완료!');
}

main();
