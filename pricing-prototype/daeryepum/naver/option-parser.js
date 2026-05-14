/**
 * 네이버 스마트스토어 productOption 파싱 → customer_info.sticker_selections enrichment.
 *
 * 입력 형식 (네이버 옵션 빌더 출력):
 *   "희망 출고일(예시: 26년9월27일): 5/14 / 스티커 감사 문구(예시: Thank you): 감사합니다
 *    / 스티커 성함 (예시: 준서 은재): 정오 선순 / 행사 타입: 감사&웨딩
 *    / 스티커 타입: 클로버(옐로우) / 박스 색상: 화이트"
 *
 * 구조: " / " 구분 → "key: value" 페어. 키에 "(예시: ...)" 가 붙어있으면 제거.
 *
 * 매핑:
 *   "희망 출고일"   → desired_ship_date (M/D, YYYY-MM-DD, "26년9월27일" 등 다양한 포맷)
 *   "스티커 감사 문구" + "스티커 성함" → custom_values.text (공백 결합)
 *   "스티커 타입"   → bg_stickers 의 type/name 매칭 → sticker_id/code/name
 *   "박스 ..."     → bg_product_settings.available_box_options.name 매칭 → box_code/name
 *   기타           → custom_values 에 raw 보존 (진단/재처리용)
 */
'use strict';

/** "key: value / key: value" 형태 productOption 을 평면 객체로 파싱.
 *
 *   주의: 키 뒤에 "(예시: ...)" 힌트가 붙어있고 그 안에도 콜론이 들어가는 경우가 있어
 *   첫 콜론으로 단순 split 하면 키/값이 깨짐. 따라서 예시 패턴을 먼저 제거 후 split.
 */
function parseProductOption(optionStr) {
  if (!optionStr || typeof optionStr !== 'string') return {};
  // 1) "(예시: ...)" 힌트 전체 제거 — 키의 콜론과 충돌 방지
  //    네이버 옵션 빌더는 항상 "(예시: ...)" 형식. 다른 괄호 (예: "클로버(옐로우)") 는 값에 등장 → 유지.
  const cleaned = optionStr.replace(/\s*\(예시\s*:[^)]*\)/g, '');
  const result = {};
  // 2) 구분자 " / " — 값 안 슬래시(예: "5/14") 와 다른 형태라 안전
  const parts = cleaned.split(' / ');
  for (const part of parts) {
    const idx = part.indexOf(':');
    if (idx < 0) continue;
    let key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key || !value) continue;
    // 공백 정규화 ("스티커 성함 ", "스티커 성함" 동일 취급)
    key = key.replace(/\s+/g, ' ');
    result[key] = value;
  }
  return result;
}

/**
 * 다양한 출고일 표기 → ISO date (YYYY-MM-DD).
 *   지원: "2026-05-14", "5/14", "5월14일", "26년9월27일", "2026년 9월 27일"
 */
function parseShipDate(raw, today = new Date()) {
  if (!raw) return null;
  const v = String(raw).trim();
  // 1) ISO
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(v)) {
    const [y, m, d] = v.split('-').map(n => parseInt(n, 10));
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  // 2) "YY년M월D일" / "YYYY년M월D일"
  let m = v.match(/^(\d{2,4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일?$/);
  if (m) {
    let yr = parseInt(m[1], 10);
    if (yr < 100) yr += 2000;
    return `${yr}-${String(parseInt(m[2])).padStart(2, '0')}-${String(parseInt(m[3])).padStart(2, '0')}`;
  }
  // 3) "M월D일" (연도 생략)
  m = v.match(/^(\d{1,2})\s*월\s*(\d{1,2})\s*일?$/);
  if (m) {
    return resolveMonthDay(parseInt(m[1]), parseInt(m[2]), today);
  }
  // 4) "M/D"
  m = v.match(/^(\d{1,2})\s*\/\s*(\d{1,2})$/);
  if (m) {
    return resolveMonthDay(parseInt(m[1]), parseInt(m[2]), today);
  }
  return null;
}

/**
 * 월/일 만 주어진 경우 연도 추정.
 *   "오늘 - 14일" 보다 더 과거면 내년, 그 외엔 올해.
 *   (배송일은 미래 또는 직전 며칠이므로 14일 마진 충분)
 */
function resolveMonthDay(mo, da, today) {
  if (!mo || !da) return null;
  let yr = today.getFullYear();
  const candidate = new Date(yr, mo - 1, da).getTime();
  const cutoff = today.getTime() - 14 * 86400 * 1000;
  if (candidate < cutoff) yr++;
  return `${yr}-${String(mo).padStart(2, '0')}-${String(da).padStart(2, '0')}`;
}

/**
 * 스티커 매칭 — productCode + 옵션값(예: "클로버(옐로우)") 으로 후보 1개 선택.
 *   우선순위: type 정확일치 → name 정확일치 → 옵션값에 type 포함 → type 에 옵션값 포함.
 *   매칭 실패시 null.
 */
function matchSticker(stickers, productCode, optionValue) {
  if (!optionValue || !productCode || !Array.isArray(stickers)) return null;
  const val = String(optionValue).trim();
  if (!val) return null;
  const candidates = stickers.filter(s =>
    s && s.is_active !== false &&
    Array.isArray(s.product_codes) &&
    s.product_codes.includes(productCode)
  );
  if (!candidates.length) return null;

  const strategies = [
    s => s.type && s.type === val,
    s => s.name && s.name === val,
    s => s.type && val.includes(s.type),
    s => s.name && val.includes(s.name),
    s => s.type && s.type.includes(val),
    s => s.name && s.name.includes(val),
  ];
  for (const fn of strategies) {
    const m = candidates.find(fn);
    if (m) return m;
  }
  return null;
}

/**
 * 박스 매칭 — productCode + 옵션값(예: "화이트") 으로 available_box_options 에서 선택.
 */
function matchBox(productSettings, productCode, optionValue) {
  if (!optionValue || !productCode || !Array.isArray(productSettings)) return null;
  const val = String(optionValue).trim();
  if (!val) return null;
  const setting = productSettings.find(s => s && s.product_id === productCode);
  if (!setting || !Array.isArray(setting.available_box_options)) return null;
  const opts = setting.available_box_options;
  return opts.find(b => b.name === val)
    || opts.find(b => b.name && val.includes(b.name))
    || opts.find(b => b.name && b.name.includes(val))
    || null;
}

/**
 * 전체 enrichment — productOption + productCode + 참고 데이터로 sticker_selection 1개 + 메타.
 *   반환: { sticker_selection, desired_ship_date, parsed }
 *     sticker_selection: customer_info.sticker_selections[] 에 들어갈 row
 *     desired_ship_date: 추출 가능 시 ISO date, 아니면 null
 *     parsed: 원본 key-value (진단/엑셀용)
 */
function enrichFromOption({
  productOption,
  productCode,
  productName,
  quantity,
  stickers = [],
  productSettings = [],
  today = new Date(),
}) {
  const parsed = parseProductOption(productOption);

  const desired_ship_date = parseShipDate(parsed['희망 출고일'] || parsed['출고일'] || parsed['희망출고일'], today);
  const stickerOptionVal = parsed['스티커 타입'] || parsed['스티커타입'] || null;
  const sticker = matchSticker(stickers, productCode, stickerOptionVal);

  // 박스 키 — "박스" 로 시작하는 첫 페어 (박스 색상, 박스 컬러, 박스 타입, 박스 선택 등)
  let boxOptionVal = null;
  for (const [k, v] of Object.entries(parsed)) {
    if (k.startsWith('박스') && v) { boxOptionVal = v; break; }
  }
  const box = matchBox(productSettings, productCode, boxOptionVal);

  // 문구 컬럼 = 감사 문구 + 성함 (공백 결합)
  const msg = (parsed['스티커 감사 문구'] || parsed['감사 문구'] || parsed['스티커 문구'] || '').trim();
  const nm = (parsed['스티커 성함'] || parsed['성함'] || '').trim();
  const combinedText = [msg, nm].filter(Boolean).join(' ');

  const sticker_selection = {
    product_code: productCode || null,
    product_name: productName || null,
    quantity: Number(quantity) || 0,
    sticker_id: sticker ? sticker.id : null,
    sticker_code: sticker ? sticker.sticker_code : null,
    // sticker_name: 운영팀 요청으로 미사용 (스티커 코드 컬럼만 표시).
    sticker_name: null,
    custom_values: combinedText ? { text: combinedText } : {},
    box_code: box ? box.code : null,
    box_name: box ? box.name : null,
  };

  return { sticker_selection, desired_ship_date, parsed };
}

/**
 * ISO timestamp (with TZ) → KST 'YYYY-MM-DD'.
 *   Docker 컨테이너 UTC 환경에서도 KST 기준 날짜 추출.
 */
function kstYmd(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const kst = new Date(d.getTime() + 9 * 3600 * 1000);
  return `${kst.getUTCFullYear()}-${String(kst.getUTCMonth() + 1).padStart(2, '0')}-${String(kst.getUTCDate()).padStart(2, '0')}`;
}

/**
 * 영업일 더하기 — 주말(토/일) 스킵. 공휴일 X (대량 매핑 필요해서 단순화).
 *   ymd: 'YYYY-MM-DD' (KST). days: 양수.
 *   반환: 'YYYY-MM-DD'.
 *
 * 예: 2026-05-14 (목) + 2영업일 = 2026-05-18 (월)
 *     2026-05-15 (금) + 2영업일 = 2026-05-19 (화)
 */
function addBusinessDays(ymd, days) {
  if (!ymd || !days || days < 0) return ymd;
  const [y, m, d] = ymd.split('-').map(Number);
  const cur = new Date(Date.UTC(y, m - 1, d));
  let added = 0;
  while (added < days) {
    cur.setUTCDate(cur.getUTCDate() + 1);
    const dow = cur.getUTCDay(); // 0=일, 6=토
    if (dow !== 0 && dow !== 6) added++;
  }
  return `${cur.getUTCFullYear()}-${String(cur.getUTCMonth() + 1).padStart(2, '0')}-${String(cur.getUTCDate()).padStart(2, '0')}`;
}

module.exports = {
  parseProductOption,
  parseShipDate,
  resolveMonthDay,
  matchSticker,
  matchBox,
  enrichFromOption,
  kstYmd,
  addBusinessDays,
};
