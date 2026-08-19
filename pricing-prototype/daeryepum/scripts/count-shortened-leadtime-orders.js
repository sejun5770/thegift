/**
 * min_select_days 단축(6→4) 효과 분석 스크립트
 *
 * 목적: 5/1·5/5 연휴 대응으로 일반택배 최소 선택 가능일을 6일 → 4일로 변경.
 *       변경일(2026-04-30) 이후 제출된 주문 중, 단축으로 새로 가능해진 4~5일 범위에
 *       desired_ship_date 가 잡힌 주문이 몇 건인지 집계.
 *
 * 실행:
 *   node scripts/count-shortened-leadtime-orders.js
 *   node scripts/count-shortened-leadtime-orders.js --since=2026-04-30 --gap-min=4 --gap-max=5
 *
 * 환경변수: SUPABASE_URL, SUPABASE_ANON_KEY (또는 .env.local 사용)
 */
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

const args = require('minimist')(process.argv.slice(2));
const SINCE = args.since || '2026-04-30';
const GAP_MIN = parseInt(args['gap-min'] ?? 4, 10);
const GAP_MAX = parseInt(args['gap-max'] ?? 5, 10);

const _bgStore = require('../barungift/store');

function dayDiff(fromYmd, toYmd) {
  const a = new Date(fromYmd + 'T00:00:00Z').getTime();
  const b = new Date(toYmd + 'T00:00:00Z').getTime();
  return Math.round((b - a) / 86400000);
}

function ymd(s) {
  if (!s) return null;
  return String(s).slice(0, 10);
}

async function main() {
  console.log(`[count] 조회 시작 — since=${SINCE}, gap=[${GAP_MIN},${GAP_MAX}]일\n`);

  const all = await _bgStore.getAllCustomerInfos();
  console.log(`[count] 전체 customer_info: ${all.length}건`);

  // 필터: 변경일 이후 제출 + 일반택배(is_express=false) + desired_ship_date 존재
  const filtered = all.filter(ci => {
    const sub = ymd(ci.submitted_at);
    return sub && sub >= SINCE && ci.is_express === false && ci.desired_ship_date;
  });
  console.log(`[count] 필터 후 (since=${SINCE}, 일반택배, desired_ship_date 있음): ${filtered.length}건\n`);

  // gap 분포 + 매칭 row 수집
  const gapDist = {};
  const matched = [];
  for (const ci of filtered) {
    const sub = ymd(ci.submitted_at);
    const ship = ymd(ci.desired_ship_date);
    const gap = dayDiff(sub, ship);
    gapDist[gap] = (gapDist[gap] || 0) + 1;
    if (gap >= GAP_MIN && gap <= GAP_MAX) {
      matched.push({ order_id: ci.order_id, submitted: sub, desired: ship, gap });
    }
  }

  // 분포 출력
  console.log('=== gap (desired_ship_date − submitted_at) 분포 ===');
  const gapKeys = Object.keys(gapDist).map(Number).sort((a, b) => a - b);
  for (const g of gapKeys) {
    const marker = g >= GAP_MIN && g <= GAP_MAX ? ' ← 신규 가능 범위' : '';
    console.log(`  ${String(g).padStart(3, ' ')}일: ${String(gapDist[g]).padStart(4, ' ')}건${marker}`);
  }

  console.log(`\n=== 결과 ===`);
  console.log(`✅ 단축(6→4)으로 신규 가능해진 ${GAP_MIN}~${GAP_MAX}일 범위 주문: ${matched.length}건`);

  if (matched.length > 0) {
    console.log(`\n=== 매칭 주문 샘플 (최대 30건) ===`);
    matched.slice(0, 30).forEach(m => {
      console.log(`  ${m.order_id.padEnd(15, ' ')} | 제출 ${m.submitted} → 희망 ${m.desired} (${m.gap}일)`);
    });
    if (matched.length > 30) console.log(`  ... 외 ${matched.length - 30}건`);
  }
}

main().catch(err => {
  console.error('[count] 실패:', err);
  process.exit(1);
});
