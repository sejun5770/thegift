const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '3457');
const BASE_PATH = process.env.BASE_PATH || '';  // 예: /c/barungift

// --- 바른기프트 모듈 ---
const { handleBarungiftApi } = require('./barungift/api');

// --- Google OAuth2 ---
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const ALLOWED_DOMAIN = 'barunn.net';
const DEV_SKIP_AUTH = !GOOGLE_CLIENT_ID || GOOGLE_CLIENT_ID === 'test'; // 개발모드: 인증 우회
const SESSION_MAX_AGE = 24 * 60 * 60 * 1000; // 24시간
const EXPORT_API_KEY = process.env.EXPORT_API_KEY || '';

// --- Session Store ---
const sessions = new Map();

function createSession(userData) {
  const sessionId = crypto.randomBytes(32).toString('hex');
  const hmac = crypto.createHmac('sha256', SESSION_SECRET).update(sessionId).digest('hex');
  sessions.set(sessionId, { ...userData, expiresAt: Date.now() + SESSION_MAX_AGE });
  return sessionId + '.' + hmac;
}

function getSession(signedId) {
  if (!signedId || !signedId.includes('.')) return null;
  const [sessionId, hmac] = signedId.split('.');
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(sessionId).digest('hex');
  if (hmac !== expected) return null;
  const session = sessions.get(sessionId);
  if (!session || Date.now() > session.expiresAt) { sessions.delete(sessionId); return null; }
  return session;
}

function destroySession(signedId) {
  if (!signedId || !signedId.includes('.')) return;
  sessions.delete(signedId.split('.')[0]);
}

function parseCookies(req) {
  const cookies = {};
  (req.headers.cookie || '').split(';').forEach(c => {
    const [key, ...val] = c.trim().split('=');
    if (key) cookies[key.trim()] = decodeURIComponent(val.join('='));
  });
  return cookies;
}

// --- Export API key validation ---
function validateApiKey(req) {
  if (!EXPORT_API_KEY) return false;
  const authHeader = req.headers['authorization'] || '';
  return authHeader.startsWith('Bearer ') && authHeader.slice(7) === EXPORT_API_KEY;
}

// --- Google JWT verification (no npm) ---
let googleCertsCache = { keys: null, expiresAt: 0 };

function fetchGoogleCerts() {
  if (googleCertsCache.keys && Date.now() < googleCertsCache.expiresAt) {
    return Promise.resolve(googleCertsCache.keys);
  }
  return new Promise((resolve, reject) => {
    https.get('https://www.googleapis.com/oauth2/v3/certs', (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          googleCertsCache.keys = data.keys;
          googleCertsCache.expiresAt = Date.now() + 6 * 60 * 60 * 1000;
          resolve(data.keys);
        } catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function verifyGoogleToken(idToken) {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('Invalid JWT');
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());

  if (payload.aud !== GOOGLE_CLIENT_ID) throw new Error('Invalid audience');
  if (payload.iss !== 'accounts.google.com' && payload.iss !== 'https://accounts.google.com') throw new Error('Invalid issuer');
  if (payload.exp * 1000 < Date.now()) throw new Error('Token expired');
  if (payload.hd !== ALLOWED_DOMAIN) throw new Error('허용되지 않은 도메인: ' + (payload.hd || payload.email));

  const keys = await fetchGoogleCerts();
  const key = keys.find(k => k.kid === header.kid);
  if (!key) throw new Error('Key not found');

  const publicKey = crypto.createPublicKey({ key, format: 'jwk' });
  const valid = crypto.verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), publicKey, Buffer.from(parts[2], 'base64url'));
  if (!valid) throw new Error('Invalid signature');
  return payload;
}

// --- Login Page ---
function getLoginPageHtml() {
  const bp = BASE_PATH;
  return `<!DOCTYPE html>
<html lang="ko"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>로그인 - 답례품 주문 관리</title>
<script src="https://accounts.google.com/gsi/client" async defer><\/script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,'Pretendard','Noto Sans KR',sans-serif;background:#f0f4ff;display:flex;align-items:center;justify-content:center;min-height:100vh}
.login-card{background:#fff;border-radius:16px;padding:48px 40px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:400px;width:100%}
.login-card .logo{font-size:32px;margin-bottom:8px}
.login-card h1{font-size:20px;font-weight:700;color:#1e293b;margin-bottom:4px}
.login-card p{color:#64748b;font-size:13px;margin-bottom:32px}
.login-card .domain{display:inline-block;background:#eff6ff;color:#2563eb;padding:4px 12px;border-radius:20px;font-size:12px;font-weight:600;margin-bottom:24px}
.error{color:#dc2626;font-size:13px;margin-top:16px;display:none}
#g_id_signin{display:flex;justify-content:center}
</style></head><body>
<div class="login-card">
  <div class="logo">🎁</div>
  <h1>답례품 주문 관리</h1>
  <p>답례품 주문내역을 조회하고 관리합니다.</p>
  <div class="domain">@${ALLOWED_DOMAIN} 계정으로 로그인</div>
  <div id="g_id_signin"></div>
  <div class="error" id="login-error"></div>
</div>
<script>
function handleCredentialResponse(response) {
  fetch('${bp}/auth/google', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({credential:response.credential})
  }).then(r=>r.json()).then(data=>{
    if(data.ok) window.location.href='${bp}/'||'/';
    else { document.getElementById('login-error').style.display='block'; document.getElementById('login-error').textContent=data.error||'로그인 실패'; }
  }).catch(()=>{ document.getElementById('login-error').style.display='block'; document.getElementById('login-error').textContent='서버 연결 실패'; });
}
window.onload=function(){
  ${GOOGLE_CLIENT_ID ? '' : 'document.getElementById("login-error").style.display="block"; document.getElementById("login-error").textContent="GOOGLE_CLIENT_ID 환경변수가 설정되지 않았습니다."; return;'}
  google.accounts.id.initialize({
    client_id:'${GOOGLE_CLIENT_ID}',
    callback:handleCredentialResponse,
    hosted_domain:'${ALLOWED_DOMAIN}'
  });
  google.accounts.id.renderButton(document.getElementById('g_id_signin'),{theme:'outline',size:'large',width:300,text:'signin_with',locale:'ko'});
};
<\/script></body></html>`;
}

// --- MSSQL connection ---
let sql;
try { sql = require('mssql'); } catch { sql = require(path.join(__dirname, '../../node_modules/mssql')); }

const DB_CONFIG = {
  server: process.env.DB_SERVER || 'barun-shopdb.9925ce92729d.database.windows.net',
  port: parseInt(process.env.DB_PORT || '1433'),
  user: process.env.DB_USER || 'readonly_user',
  password: process.env.DB_PASSWORD || 'barunreadonly12#',
  database: process.env.DB_NAME || 'bar_shop1',
  options: { encrypt: true, trustServerCertificate: false },
  pool: { max: 5, min: 0, idleTimeoutMillis: 30000 },
  requestTimeout: 60000,
  connectionTimeout: 15000,
};

let pool = null;
async function getPool() {
  if (pool && pool.connected) return pool;
  pool = new sql.ConnectionPool(DB_CONFIG);
  pool.on('error', (err) => { console.error('Pool error:', err.message); pool = null; });
  await pool.connect();
  console.log('Connected to Barunson DB');
  // 제휴사명 캐시 로드 (최초 연결 시)
  if (Object.keys(companyNameMap).length === 0) {
    try {
      const res = await pool.request().query(`SELECT COMPANY_SEQ, COMPANY_NAME FROM COMPANY WITH (NOLOCK) WHERE COMPANY_NAME IS NOT NULL`);
      res.recordset.forEach(r => { companyNameMap[String(r.COMPANY_SEQ)] = r.COMPANY_NAME; });
      console.log(`Loaded ${Object.keys(companyNameMap).length} company names`);
    } catch (e) { console.error('Failed to load company names:', e.message); }
  }
  return pool;
}

// 제휴사명 캐시: company_Seq → COMPANY_NAME
const companyNameMap = {};
// site_name이 숫자(제휴사 코드)인 경우 "제휴사명(코드)" 형태로 변환
function formatSiteName(siteName) {
  if (!siteName) return siteName;
  const s = String(siteName).trim();
  if (/^\d+$/.test(s) && companyNameMap[s]) {
    return `${companyNameMap[s]}(${s})`;
  }
  return siteName;
}

// 카테고리 필터 정의
const CATEGORY_FILTERS = {
  daeryepum: { label: '답례품', filter: `c.Card_Div = 'D01'` },
  deco:      { label: '데코소품', filter: `c.Card_Code LIKE '2026_%'` },
  flower:    { label: '꽃다발', filter: `c.Card_Div = 'D02'` },
};
// D01 category = 답례품 (기본, 대시보드용)
const D01_FILTER = `c.Card_Div = 'D01'`;

// --- JSON 파일 스토리지 ---
// /app/data 디렉토리는 Docker Manager 볼륨 마운트 경로 (배포 시 데이터 보존)
const DATA_DIR = process.env.DATA_DIR || (process.env.NODE_ENV === 'production' ? '/app/data' : __dirname);
const WORKLOG_PATH = path.join(DATA_DIR, 'worklog.json');
function readWorklog() {
  try { return JSON.parse(fs.readFileSync(WORKLOG_PATH, 'utf8')); }
  catch { return { entries: [] }; }
}
function saveWorklog(data) {
  fs.writeFileSync(WORKLOG_PATH, JSON.stringify(data, null, 2), 'utf8');
}

// --- 수집완료 상태 (Supabase 영속화 + 로컬 파일 폴백) ---
// 1순위: Supabase `bg_order_collected` 테이블 (migration 012)
// 2순위: 로컬 /app/data/collected.json — Supabase 미설정/오류 시 폴백 (호환성)
const COLLECTED_PATH = path.join(DATA_DIR, 'collected.json');
const _bgStore = require('./barungift/store');
const _USE_SUPABASE_COLLECTED = !!(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY);

function readCollectedFile() {
  try { return JSON.parse(fs.readFileSync(COLLECTED_PATH, 'utf8')); }
  catch { return { order_seqs: [], updated_by: '', updated_at: '' }; }
}
function saveCollectedFile(data) {
  try { fs.writeFileSync(COLLECTED_PATH, JSON.stringify(data, null, 2), 'utf8'); }
  catch (e) { console.warn('[collected] file save 실패:', e.message); }
}

async function readCollected() {
  if (_USE_SUPABASE_COLLECTED) {
    try {
      const seqs = await _bgStore.getCollectedOrderSeqs();
      return { order_seqs: seqs, source: 'supabase' };
    } catch (e) {
      console.warn('[collected] Supabase 읽기 실패 → 파일 폴백:', e.message);
    }
  }
  return { ...readCollectedFile(), source: 'file' };
}

/**
 * 수집 상태 반영 — body.add / body.remove 배열.
 * @returns {order_seqs, added, removed, source}
 */
async function applyCollectedChanges(body, session, category) {
  const addSeqs = (body.add || []).map(String);
  const removeSeqs = (body.remove || []).map(String);
  const email = session?.email || 'unknown';

  if (_USE_SUPABASE_COLLECTED) {
    try {
      if (addSeqs.length) {
        await _bgStore.addCollectedOrderSeqs(addSeqs, { collectedBy: email, category: category || null });
      }
      if (removeSeqs.length) {
        await _bgStore.removeCollectedOrderSeqs(removeSeqs);
      }
      const all = await _bgStore.getCollectedOrderSeqs();
      return {
        order_seqs: all,
        added: addSeqs.length,
        removed: removeSeqs.length,
        source: 'supabase',
      };
    } catch (e) {
      console.warn('[collected] Supabase 쓰기 실패 → 파일 폴백:', e.message);
    }
  }

  // 파일 폴백 (기존 로직과 동일)
  const col = readCollectedFile();
  const set = new Set(col.order_seqs);
  addSeqs.forEach(s => set.add(s));
  removeSeqs.forEach(s => set.delete(s));
  col.order_seqs = [...set];
  col.updated_by = email;
  col.updated_at = new Date().toISOString();
  saveCollectedFile(col);
  return { ...col, added: addSeqs.length, removed: removeSeqs.length, source: 'file' };
}

// 일별 메트릭 스냅샷 (해당 날짜의 주요 지표 캡처)
async function getDailyMetricsSnapshot(dateStr) {
  const p = await getPool();
  const result = await p.request()
    .input('targetDate', sql.Date, dateStr)
    .query(`
      SELECT
        COUNT(DISTINCT o.order_seq) AS order_count,
        COUNT(DISTINCT o.member_id) AS member_count,
        ISNULL(SUM(${ETC_AMOUNT_EXPR}), 0) AS revenue,
        ISNULL(SUM(oi.order_count), 0) AS total_qty
      FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
      INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
      INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
      LEFT JOIN SiteInfo si WITH (NOLOCK) ON o.company_Seq = si.CompayCode
      WHERE ${D01_FILTER} AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 14, 15)
        AND CAST(o.order_date AS date) = @targetDate
    `);
  const row = result.recordset[0] || {};
  // 상위 상품
  const topProducts = await p.request()
    .input('targetDate', sql.Date, dateStr)
    .query(`
      SELECT TOP 3 c.Card_Name AS product_name,
             SUM(oi.order_count) AS qty,
             SUM(${ETC_AMOUNT_EXPR}) AS amount
      FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
      INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
      INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
      LEFT JOIN SiteInfo si WITH (NOLOCK) ON o.company_Seq = si.CompayCode
      WHERE ${D01_FILTER} AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 14, 15)
        AND CAST(o.order_date AS date) = @targetDate
      GROUP BY c.Card_Name
      ORDER BY SUM(${ETC_AMOUNT_EXPR}) DESC
    `);
  return {
    date: dateStr,
    order_count: row.order_count || 0,
    member_count: row.member_count || 0,
    revenue: row.revenue || 0,
    total_qty: row.total_qty || 0,
    top_products: topProducts.recordset || [],
  };
}

function getCategoryFilter(category) {
  const cat = CATEGORY_FILTERS[category];
  return cat ? cat.filter : D01_FILTER;
}

// Clean product name (remove [할인], [시크릿특가] etc.)
function cleanName(name) {
  if (!name) return '';
  return name.replace(/^\[.*?\]\s*/g, '');
}

// Format date for SQL (KST timezone)
function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const dd = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${dd}`;
}
function today() {
  // KST = UTC+9
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return new Date(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate());
}
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }

// --- API handlers ---

async function apiOrders(query) {
  const p = await getPool();
  const startDate = query.start_date || fmtDate(addDays(today(), -7));
  const endDate = query.end_date || fmtDate(addDays(today(), 1));
  const categoryFilter = getCategoryFilter(query.category);

  const result = await p.request()
    .input('startDate', sql.VarChar, startDate)
    .input('endDate', sql.VarChar, endDate)
    .query(`
      -- 부가상품 단독주문 (CUSTOM_ETC_ORDER)
      -- 예식일: member_id → 최근 청첩장주문(custom_order) → custom_order_WeddInfo
      SELECT
        o.order_seq AS order_seq,
        o.member_id AS member_id,
        'ETC' AS order_type,
        CONVERT(varchar(19), o.order_date, 120) AS order_date,
        CONVERT(varchar(19), o.settle_date, 120) AS settle_date,
        o.order_name AS order_name,
        o.recv_name AS recv_name,
        o.recv_hphone AS recv_hphone,
        CONCAT(o.recv_address, ' ', ISNULL(o.recv_address_detail,'')) AS recv_address,
        o.recv_msg AS recv_msg,
        c.Card_Name AS card_name,
        c.Card_Code AS card_code,
        oi.order_count AS item_count,
        ${ETC_AMOUNT_EXPR} AS item_amount,
        o.settle_price AS settle_price,
        ISNULL(o.coupon_price, 0) AS coupon_price,
        o.status_seq AS status_seq,
        cw.event_year + '-' + RIGHT('0'+cw.event_month,2) + '-' + RIGHT('0'+cw.event_Day,2) AS wedding_date,
        ISNULL(si.SiteName, CAST(o.company_Seq AS VARCHAR)) AS site_name,
        0 AS file_count
      FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
      INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
      INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
      LEFT JOIN SiteInfo si WITH (NOLOCK) ON o.company_Seq = si.CompayCode
      OUTER APPLY (
        SELECT TOP 1 w2.event_year, w2.event_month, w2.event_Day
        FROM custom_order co2 WITH (NOLOCK)
        INNER JOIN custom_order_WeddInfo w2 WITH (NOLOCK) ON co2.order_seq = w2.order_seq
        WHERE co2.member_id = o.member_id AND co2.status_seq >= 1
          AND w2.event_year IS NOT NULL AND LEN(w2.event_year) = 4
        ORDER BY co2.order_seq DESC
      ) cw
      WHERE ${categoryFilter}
        AND o.order_date >= @startDate AND o.order_date < @endDate
        AND o.status_seq >= 1

      UNION ALL

      -- 청첩장과 함께 주문 (custom_order)
      -- 나눔배송: DELIVERY_INFO × DELIVERY_INFO_DETAIL로 배송지별 답례품 수량 표시
      SELECT
        co.order_seq,
        co.member_id AS member_id,
        'CARD' AS order_type,
        CONVERT(varchar(19), co.order_date, 120) AS order_date,
        CONVERT(varchar(19), co.settle_date, 120) AS settle_date,
        co.order_name,
        di.NAME AS recv_name,
        ISNULL(di.HPHONE, di.PHONE) AS recv_hphone,
        CONCAT(ISNULL(di.ADDR,''), ' ', ISNULL(di.ADDR_DETAIL,'')) AS recv_address,
        di.DELIVERY_MEMO AS recv_msg,
        c.Card_Name AS card_name,
        c.Card_Code AS card_code,
        ISNULL(di.dd_count, coi.item_count) AS item_count,
        CAST(coi.item_sale_price AS float) * ISNULL(di.dd_count, coi.item_count) / ISNULL(NULLIF(c.Unit_Value, 0), 1) AS item_amount,
        co.settle_price,
        0 AS coupon_price,
        co.status_seq,
        w.event_year + '-' + RIGHT('0'+w.event_month,2) + '-' + RIGHT('0'+w.event_Day,2) AS wedding_date,
        ISNULL(si.SiteName, CAST(co.company_Seq AS VARCHAR)) AS site_name,
        ISNULL((SELECT COUNT(*) FROM custom_order_plist p WITH (NOLOCK) INNER JOIN custom_order_plist_files f WITH (NOLOCK) ON p.id = f.pid WHERE p.order_seq = co.order_seq), 0) AS file_count
      FROM custom_order co WITH (NOLOCK)
      INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
      INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
      LEFT JOIN SiteInfo si WITH (NOLOCK) ON co.company_Seq = si.CompayCode
      INNER JOIN (
        -- 배송지별 답례품 수량: DELIVERY_INFO_DETAIL 있으면 배송지별, 없으면 첫 배송지 1건
        SELECT di.ORDER_SEQ, di.NAME, di.HPHONE, di.PHONE, di.ADDR, di.ADDR_DETAIL,
               di.DELIVERY_MEMO, dd.item_count AS dd_count
        FROM DELIVERY_INFO di WITH (NOLOCK)
        INNER JOIN DELIVERY_INFO_DETAIL dd WITH (NOLOCK)
          ON dd.delivery_id = di.ID AND dd.item_title = N'답례품' AND dd.item_count > 0
        UNION ALL
        -- DELIVERY_INFO_DETAIL에 답례품 기록이 없는 주문: 첫 배송지만
        SELECT di.ORDER_SEQ, di.NAME, di.HPHONE, di.PHONE, di.ADDR, di.ADDR_DETAIL,
               di.DELIVERY_MEMO, NULL AS dd_count
        FROM DELIVERY_INFO di WITH (NOLOCK)
        WHERE di.DELIVERY_SEQ = 1
          AND NOT EXISTS (
            SELECT 1 FROM DELIVERY_INFO d2 WITH (NOLOCK)
            INNER JOIN DELIVERY_INFO_DETAIL dd2 WITH (NOLOCK) ON dd2.delivery_id = d2.ID
            WHERE d2.ORDER_SEQ = di.ORDER_SEQ AND dd2.item_title = N'답례품'
          )
      ) di ON di.ORDER_SEQ = co.order_seq
      LEFT JOIN custom_order_WeddInfo w WITH (NOLOCK) ON co.order_seq = w.order_seq
      WHERE ${categoryFilter}
        AND co.order_date >= @startDate AND co.order_date < @endDate
        AND co.status_seq >= 1

      ORDER BY order_date DESC, order_seq DESC
    `);

  const rows = result.recordset.map(r => ({
    ...r,
    card_name: cleanName(r.card_name),
    order_date: r.order_date,
    settle_date: r.settle_date,
    site_name: formatSiteName(r.site_name),
    // 주문자명/받는사람 합치기
    display_name: mergeNames(r.recv_name, r.order_name),
  }));

  return rows;
}

const BBARUNSON_FILE_URL = 'https://bbarunsonweb.barunsoncard.com/PrintInfo/DownloadFile?fileId=';

async function apiOrderFiles(query) {
  const p = await getPool();
  const orderSeq = parseInt(query.order_seq);
  if (!orderSeq) return [];
  const result = await p.request()
    .input('orderSeq', sql.Int, orderSeq)
    .query(`
      SELECT f.id AS file_id, f.pid, f.FileName, f.FilePath, f.FileSize, f.FileType, f.Sort,
             p.title AS plist_title, p.card_seq,
             c.Card_Name, c.Card_Code
      FROM custom_order_plist p WITH (NOLOCK)
      INNER JOIN custom_order_plist_files f WITH (NOLOCK) ON p.id = f.pid
      LEFT JOIN S2_Card c WITH (NOLOCK) ON p.card_seq = c.Card_Seq
      WHERE p.order_seq = @orderSeq
      ORDER BY f.pid, f.Sort
    `);
  return result.recordset.map(r => ({
    ...r,
    download_url: BBARUNSON_FILE_URL + r.file_id,
    file_size_fmt: r.FileSize > 1048576
      ? (r.FileSize / 1048576).toFixed(1) + 'MB'
      : (r.FileSize / 1024).toFixed(0) + 'KB',
  }));
}

function mergeNames(recvName, orderName) {
  const r = (recvName || '').trim();
  const o = (orderName || '').trim();
  if (!r && !o) return '';
  if (!r) return o;
  if (!o) return r;
  if (r === o) return r;
  return `${r}(${o})`;
}

// ETC 결제금액 계산: 바른손카드(SiteInfo 매칭) vs 바른손몰(제휴사, SiteInfo 미매칭)
// 바른손카드: card_sale_price = 총액(단가×수량) → 그대로 사용
// 바른손몰:   card_sale_price = 단가 → × 수량 / 판매단위 = 총액
// 쿠폰 할인: coupon_price를 차감하여 실결제금액 반영
// Unit_Value: S2_Card.Unit_Value (판매단위 수량, 예: 소프트터치=50개 단위)
const ETC_AMOUNT_EXPR = `
  CASE
    WHEN si.SiteName IS NULL
    THEN CAST(oi.card_sale_price AS float) * oi.order_count / ISNULL(NULLIF(c.Unit_Value, 0), 1) - ISNULL(o.coupon_price, 0)
    ELSE CAST(oi.card_sale_price AS float) - ISNULL(o.coupon_price, 0)
  END`;

/**
 * 상품별 판매 통계 — 단일/다중 상품 + 기간 + (선택)전기대비
 * GET /api/product-stats?product_codes=TGJSD08D1,TGIBK01D1&start_date=2026-03-21&end_date=2026-04-20&compare_prev=1
 * (구버전 호환: product_code=XXX 단일도 지원)
 *
 * 반환:
 *   { period: {start, end, days},
 *     prev_period: {start, end, days} | null,
 *     products: [
 *       { product_code, product_name,
 *         total: {qty, orders, revenue, avg_order_value},
 *         max_day: {...} | null, min_day: {...} | null,
 *         daily: [{date, qty, orders, revenue}, ...],
 *         prev_total: {...} | null  (compare_prev=true일 때)
 *       }, ...
 *     ],
 *     totals: { qty, orders, revenue, avg_order_value }  (선택 전체 합계)
 *   }
 */
async function apiProductStats(query) {
  // product_codes (콤마) 또는 product_code (단일) 모두 지원
  const rawCodes = (query.product_codes || query.product_code || '').trim();
  const productCodes = rawCodes.split(',').map(s => s.trim()).filter(Boolean);
  const startStr = query.start_date;
  const endStr = query.end_date;
  const comparePrev = query.compare_prev === '1' || query.compare_prev === 'true';

  if (!productCodes.length) return { error: 'product_code(s) required' };
  if (!startStr || !endStr) return { error: 'start_date and end_date required' };
  if (productCodes.length > 10) return { error: '최대 10개까지 조회 가능' };

  const p = await getPool();

  // 기간 계산 helper
  const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);
  const daysInRange = daysBetween(startStr, endStr) + 1;
  const endPlus = fmtDate(addDays(new Date(startStr + 'T00:00:00'), daysInRange));

  // 전기 대비 기간 (동일 길이, 바로 이전)
  let prevStart = null, prevEnd = null, prevEndPlus = null;
  if (comparePrev) {
    prevEnd = fmtDate(addDays(new Date(startStr + 'T00:00:00'), -1));
    prevStart = fmtDate(addDays(new Date(prevEnd + 'T00:00:00'), -(daysInRange - 1)));
    prevEndPlus = fmtDate(addDays(new Date(prevEnd + 'T00:00:00'), 1));
  }

  /** 공통 쿼리 (기간, 상품코드 리스트 → 일별 집계 rows) */
  async function queryRange(codes, s, e) {
    // IN 절 (code1, code2 ...) 파라미터화
    const req = p.request().input('s', sql.VarChar, s).input('e', sql.VarChar, e);
    const placeholders = codes.map((c, i) => {
      req.input('pc' + i, sql.VarChar, c);
      return '@pc' + i;
    }).join(',');

    const card = await req.query(`
      SELECT c.Card_Code AS card_code, MAX(c.Card_Name) AS card_name,
             CAST(co.order_date AS DATE) AS d, co.order_seq,
             SUM(coi.item_count) AS qty,
             SUM(
               CASE WHEN si.SiteName IS NULL
                    THEN CAST(coi.item_sale_price AS float) * coi.item_count
                         / ISNULL(NULLIF(c.Unit_Value, 0), 1)
                    ELSE CAST(coi.item_sale_price AS float)
               END
             ) AS amount
      FROM custom_order co WITH (NOLOCK)
      INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
      INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
      LEFT JOIN SiteInfo si WITH (NOLOCK) ON co.company_Seq = si.CompayCode
      WHERE c.Card_Code IN (${placeholders})
        AND co.order_date >= @s AND co.order_date < @e
        AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5, 14)
      GROUP BY c.Card_Code, CAST(co.order_date AS DATE), co.order_seq
    `);

    const req2 = p.request().input('s', sql.VarChar, s).input('e', sql.VarChar, e);
    codes.forEach((c, i) => req2.input('pc' + i, sql.VarChar, c));
    const etc = await req2.query(`
      SELECT c.Card_Code AS card_code, MAX(c.Card_Name) AS card_name,
             CAST(o.order_date AS DATE) AS d, o.order_seq,
             SUM(ei.order_count) AS qty,
             SUM(
               CASE WHEN si.SiteName IS NULL
                    THEN CAST(ei.card_sale_price AS float) * ei.order_count
                         / ISNULL(NULLIF(c.Unit_Value, 0), 1)
                         - ISNULL(o.coupon_price, 0)
                    ELSE CAST(ei.card_sale_price AS float) - ISNULL(o.coupon_price, 0)
               END
             ) AS amount
      FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
      INNER JOIN CUSTOM_ETC_ORDER_ITEM ei WITH (NOLOCK) ON o.order_seq = ei.order_seq
      INNER JOIN S2_Card c WITH (NOLOCK) ON ei.card_seq = c.Card_Seq
      LEFT JOIN SiteInfo si WITH (NOLOCK) ON o.company_Seq = si.CompayCode
      WHERE c.Card_Code IN (${placeholders})
        AND o.order_date >= @s AND o.order_date < @e
        AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 14, 15)
      GROUP BY c.Card_Code, CAST(o.order_date AS DATE), o.order_seq
    `);

    return [...card.recordset, ...etc.recordset];
  }

  /** rows → 상품별 {name, daily[], total{}} */
  function aggregate(rows, codes) {
    const byProduct = new Map();
    codes.forEach(c => byProduct.set(c, {
      product_code: c, product_name: null,
      dayMap: new Map(), allOrders: new Set(),
    }));
    for (const r of rows) {
      const key = r.card_code;
      if (!byProduct.has(key)) continue;
      const bucket = byProduct.get(key);
      if (!bucket.product_name && r.card_name) bucket.product_name = r.card_name;
      const dKey = r.d instanceof Date ? fmtDate(r.d) : String(r.d).slice(0, 10);
      if (!bucket.dayMap.has(dKey)) bucket.dayMap.set(dKey, { qty: 0, orders: new Set(), revenue: 0 });
      const d = bucket.dayMap.get(dKey);
      d.qty += (r.qty || 0);
      d.revenue += (r.amount || 0);
      d.orders.add(r.order_seq);
      bucket.allOrders.add(r.order_seq);
    }
    // 최종 형태로 변환
    const products = codes.map(c => {
      const b = byProduct.get(c);
      const daily = [...b.dayMap.entries()]
        .sort((x, y) => x[0].localeCompare(y[0]))
        .map(([date, v]) => ({
          date, qty: v.qty, orders: v.orders.size, revenue: Math.round(v.revenue),
        }));
      const totalQty = daily.reduce((s, d) => s + d.qty, 0);
      const totalRevenue = daily.reduce((s, d) => s + d.revenue, 0);
      const totalOrders = b.allOrders.size;
      const withSales = daily.filter(d => d.revenue > 0);
      return {
        product_code: c,
        product_name: b.product_name,
        total: {
          qty: totalQty,
          orders: totalOrders,
          revenue: totalRevenue,
          avg_order_value: totalOrders > 0 ? Math.round(totalRevenue / totalOrders) : 0,
        },
        max_day: withSales.length ? withSales.reduce((a, b) => b.revenue > a.revenue ? b : a) : null,
        min_day: withSales.length ? withSales.reduce((a, b) => b.revenue < a.revenue ? b : a) : null,
        daily,
      };
    });
    return products;
  }

  // 현재 기간 조회
  const curRows = await queryRange(productCodes, startStr, endPlus);
  const products = aggregate(curRows, productCodes);

  // 전기 대비 (선택)
  if (comparePrev) {
    const prevRows = await queryRange(productCodes, prevStart, prevEndPlus);
    const prevProducts = aggregate(prevRows, productCodes);
    const prevMap = new Map(prevProducts.map(p => [p.product_code, p.total]));
    products.forEach(p => { p.prev_total = prevMap.get(p.product_code) || null; });
  }

  // 전체 합계 (선택된 상품들의 sum)
  const allOrdersSet = new Set();
  curRows.forEach(r => allOrdersSet.add(r.order_seq));  // 주문번호 중복 제거
  const totals = {
    qty: products.reduce((s, p) => s + p.total.qty, 0),
    orders: allOrdersSet.size,
    revenue: products.reduce((s, p) => s + p.total.revenue, 0),
  };
  totals.avg_order_value = totals.orders > 0 ? Math.round(totals.revenue / totals.orders) : 0;

  return {
    period: { start: startStr, end: endStr, days: daysInRange },
    prev_period: comparePrev ? { start: prevStart, end: prevEnd, days: daysInRange } : null,
    products,
    totals,
  };
}

async function apiDashboardComparison() {
  const p = await getPool();
  const todayStr = fmtDate(today());
  const tomorrowStr = fmtDate(addDays(today(), 1));
  const yesterdayStr = fmtDate(addDays(today(), -1));
  const lastWeekSameDayStr = fmtDate(addDays(today(), -7));
  const lastWeekSameDayNextStr = fmtDate(addDays(today(), -6));

  // 요일 이름
  const dayNames = ['일','월','화','수','목','금','토'];
  const todayDow = dayNames[today().getDay()];

  // 각 기간별 ETC+CARD 합산 헬퍼 (사이트별 분리 + 동시구매/단독주문 분리)
  async function getPeriodTotal(startStr, endStr) {
    // ETC 주문 = 항상 단독주문
    const r = await p.request()
      .input('s', sql.VarChar, startStr)
      .input('e', sql.VarChar, endStr)
      .query(`
        SELECT
          ISNULL(si.SiteName, CAST(o.company_Seq AS VARCHAR)) AS site_name,
          COUNT(DISTINCT o.order_seq) AS order_count,
          ISNULL(SUM(${ETC_AMOUNT_EXPR}),0) AS total_amount,
          ISNULL(SUM(oi.order_count),0) AS total_qty
        FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
        INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
        INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
        LEFT JOIN SiteInfo si WITH (NOLOCK) ON o.company_Seq = si.CompayCode
        WHERE ${D01_FILTER} AND o.order_date >= @s AND o.order_date < @e AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 14, 15)
        GROUP BY ISNULL(si.SiteName, CAST(o.company_Seq AS VARCHAR))
      `);
    // CARD 주문 = 같은 주문에 A01(청첩장)이 있으면 동시구매, 없으면 단독주문
    // CTE로 사전 계산하여 correlated subquery 회피 (성능 최적화)
    const r2 = await p.request()
      .input('s', sql.VarChar, startStr)
      .input('e', sql.VarChar, endStr)
      .query(`
        WITH copurchase_orders AS (
          SELECT DISTINCT coi2.order_seq
          FROM custom_order_item coi2 WITH (NOLOCK)
          INNER JOIN S2_Card c2 WITH (NOLOCK) ON coi2.card_seq = c2.Card_Seq
          WHERE c2.Card_Div = 'A01'
        )
        SELECT
          ISNULL(si.SiteName, CAST(co.company_Seq AS VARCHAR)) AS site_name,
          CASE WHEN cp.order_seq IS NOT NULL THEN 1 ELSE 0 END AS is_copurchase,
          COUNT(DISTINCT co.order_seq) AS order_count,
          ISNULL(SUM(CAST(coi.item_sale_price AS float) * coi.item_count / ISNULL(NULLIF(c.Unit_Value, 0), 1)),0) AS total_amount,
          ISNULL(SUM(coi.item_count),0) AS total_qty
        FROM custom_order co WITH (NOLOCK)
        INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
        INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
        LEFT JOIN SiteInfo si WITH (NOLOCK) ON co.company_Seq = si.CompayCode
        LEFT JOIN copurchase_orders cp ON co.order_seq = cp.order_seq
        WHERE ${D01_FILTER} AND co.order_date >= @s AND co.order_date < @e AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5, 14)
        GROUP BY ISNULL(si.SiteName, CAST(co.company_Seq AS VARCHAR)),
          CASE WHEN cp.order_seq IS NOT NULL THEN 1 ELSE 0 END
      `);
    // 사이트별 합산
    const siteMap = {};
    // 동시구매/단독주문 분리 집계
    let copurchase_amount = 0, copurchase_orders = 0, copurchase_qty = 0;
    let standalone_amount = 0, standalone_orders = 0, standalone_qty = 0;
    for (const row of r.recordset) {
      const sn = formatSiteName(row.site_name) || '기타';
      if (!siteMap[sn]) siteMap[sn] = { order_count:0, total_amount:0, total_qty:0 };
      siteMap[sn].order_count += row.order_count||0;
      siteMap[sn].total_amount += row.total_amount||0;
      siteMap[sn].total_qty += row.total_qty||0;
      // ETC = 항상 단독
      standalone_amount += row.total_amount||0;
      standalone_orders += row.order_count||0;
      standalone_qty += row.total_qty||0;
    }
    for (const row of r2.recordset) {
      const sn = formatSiteName(row.site_name) || '기타';
      if (!siteMap[sn]) siteMap[sn] = { order_count:0, total_amount:0, total_qty:0 };
      siteMap[sn].order_count += row.order_count||0;
      siteMap[sn].total_amount += row.total_amount||0;
      siteMap[sn].total_qty += row.total_qty||0;
      // CARD: is_copurchase 플래그에 따라 분리
      if (row.is_copurchase) {
        copurchase_amount += row.total_amount||0;
        copurchase_orders += row.order_count||0;
        copurchase_qty += row.total_qty||0;
      } else {
        standalone_amount += row.total_amount||0;
        standalone_orders += row.order_count||0;
        standalone_qty += row.total_qty||0;
      }
    }
    // 전체 합계
    let order_count=0, total_amount=0, total_qty=0;
    for (const v of Object.values(siteMap)) {
      order_count += v.order_count;
      total_amount += v.total_amount;
      total_qty += v.total_qty;
    }
    return {
      order_count, total_amount, total_qty,
      by_site: siteMap,
      copurchase: { amount: copurchase_amount, orders: copurchase_orders, qty: copurchase_qty },
      standalone: { amount: standalone_amount, orders: standalone_orders, qty: standalone_qty },
    };
  }

  const [todayTotal, yesterdayTotal, lastWeekTotal] = await Promise.all([
    getPeriodTotal(todayStr, tomorrowStr),
    getPeriodTotal(yesterdayStr, todayStr),
    getPeriodTotal(lastWeekSameDayStr, lastWeekSameDayNextStr),
  ]);

  return {
    today: todayTotal,
    yesterday: yesterdayTotal,
    last_week_same_day: lastWeekTotal,
    date: {
      today: todayStr,
      yesterday: yesterdayStr,
      last_week_same_day: lastWeekSameDayStr,
      today_dow: todayDow,
    },
  };
}

async function apiDashboardSummary(query) {
  const p = await getPool();
  const startDate = query.start_date || fmtDate(addDays(today(), -30));
  const endDate = query.end_date || fmtDate(addDays(today(), 1));

  const result = await p.request()
    .input('startDate', sql.VarChar, startDate)
    .input('endDate', sql.VarChar, endDate)
    .query(`
      WITH copurchase_orders AS (
        SELECT DISTINCT coi2.order_seq
        FROM custom_order_item coi2 WITH (NOLOCK)
        INNER JOIN S2_Card c2 WITH (NOLOCK) ON coi2.card_seq = c2.Card_Seq
        WHERE c2.Card_Div = 'A01'
      )
      SELECT
        c.Card_Name AS card_name,
        c.Card_Code AS card_code,
        CONVERT(varchar(10), o.order_date, 120) AS order_day,
        ISNULL(si.SiteName, CAST(o.company_Seq AS VARCHAR)) AS site_name,
        N'단독주문' AS order_type,
        COUNT(DISTINCT o.order_seq) AS order_count,
        SUM(oi.order_count) AS total_qty,
        SUM(${ETC_AMOUNT_EXPR}) AS total_amount
      FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
      INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
      INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
      LEFT JOIN SiteInfo si WITH (NOLOCK) ON o.company_Seq = si.CompayCode
      WHERE ${D01_FILTER} AND o.order_date >= @startDate AND o.order_date < @endDate AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 14, 15)
      GROUP BY c.Card_Name, c.Card_Code, CONVERT(varchar(10), o.order_date, 120), ISNULL(si.SiteName, CAST(o.company_Seq AS VARCHAR))

      UNION ALL

      SELECT
        c.Card_Name,
        c.Card_Code,
        CONVERT(varchar(10), co.order_date, 120) AS order_day,
        ISNULL(si.SiteName, CAST(co.company_Seq AS VARCHAR)) AS site_name,
        CASE WHEN cp.order_seq IS NOT NULL THEN N'동시구매' ELSE N'단독주문' END AS order_type,
        COUNT(DISTINCT co.order_seq),
        SUM(coi.item_count),
        SUM(CAST(coi.item_sale_price AS float) * coi.item_count / ISNULL(NULLIF(c.Unit_Value, 0), 1))
      FROM custom_order co WITH (NOLOCK)
      INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
      INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
      LEFT JOIN SiteInfo si WITH (NOLOCK) ON co.company_Seq = si.CompayCode
      LEFT JOIN copurchase_orders cp ON co.order_seq = cp.order_seq
      WHERE ${D01_FILTER} AND co.order_date >= @startDate AND co.order_date < @endDate AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5, 14)
      GROUP BY c.Card_Name, c.Card_Code, CONVERT(varchar(10), co.order_date, 120), ISNULL(si.SiteName, CAST(co.company_Seq AS VARCHAR)),
        CASE WHEN cp.order_seq IS NOT NULL THEN N'동시구매' ELSE N'단독주문' END

      ORDER BY order_day DESC, total_amount DESC
    `);

  // Clean names
  const rows = result.recordset.map(r => ({ ...r, card_name: cleanName(r.card_name), site_name: formatSiteName(r.site_name) }));

  // 주문번호 기준 건수 (상품 그루핑 없이 day/site/type별 COUNT DISTINCT)
  const countResult = await p.request()
    .input('startDate', sql.VarChar, startDate)
    .input('endDate', sql.VarChar, endDate)
    .query(`
      WITH copurchase_orders AS (
        SELECT DISTINCT coi2.order_seq
        FROM custom_order_item coi2 WITH (NOLOCK)
        INNER JOIN S2_Card c2 WITH (NOLOCK) ON coi2.card_seq = c2.Card_Seq
        WHERE c2.Card_Div = 'A01'
      )
      SELECT
        CONVERT(varchar(10), o.order_date, 120) AS order_day,
        ISNULL(si.SiteName, CAST(o.company_Seq AS VARCHAR)) AS site_name,
        N'단독주문' AS order_type,
        COUNT(DISTINCT o.order_seq) AS distinct_order_count
      FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
      INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
      INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
      LEFT JOIN SiteInfo si WITH (NOLOCK) ON o.company_Seq = si.CompayCode
      WHERE ${D01_FILTER} AND o.order_date >= @startDate AND o.order_date < @endDate AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 14, 15)
      GROUP BY CONVERT(varchar(10), o.order_date, 120), ISNULL(si.SiteName, CAST(o.company_Seq AS VARCHAR))

      UNION ALL

      SELECT
        CONVERT(varchar(10), co.order_date, 120) AS order_day,
        ISNULL(si.SiteName, CAST(co.company_Seq AS VARCHAR)) AS site_name,
        CASE WHEN cp.order_seq IS NOT NULL THEN N'동시구매' ELSE N'단독주문' END AS order_type,
        COUNT(DISTINCT co.order_seq) AS distinct_order_count
      FROM custom_order co WITH (NOLOCK)
      INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
      INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
      LEFT JOIN SiteInfo si WITH (NOLOCK) ON co.company_Seq = si.CompayCode
      LEFT JOIN copurchase_orders cp ON co.order_seq = cp.order_seq
      WHERE ${D01_FILTER} AND co.order_date >= @startDate AND co.order_date < @endDate AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5, 14)
      GROUP BY CONVERT(varchar(10), co.order_date, 120), ISNULL(si.SiteName, CAST(co.company_Seq AS VARCHAR)),
        CASE WHEN cp.order_seq IS NOT NULL THEN N'동시구매' ELSE N'단독주문' END
    `);

  const orderCounts = countResult.recordset.map(r => ({ ...r, site_name: formatSiteName(r.site_name) }));
  return { summary: rows, order_counts: orderCounts };
}

async function apiForecast() {
  const p = await getPool();
  const todayStr = fmtDate(today());

  const todayDate = today();
  const dayOfWeek = todayDate.getDay();
  const thisSunday = addDays(todayDate, -dayOfWeek);

  const WINDOW = 14; // 예식일 ±14일 (앞뒤 2주)
  const BASE_WEEKS = 4; // 이동평균 기준: 최근 완료 4주

  // 1) 예식일별 건수 (실제 청첩장 주문의 예식정보 기준, 주문번호 중복 제거)
  const weddStart = fmtDate(addDays(thisSunday, -7 * 8 - WINDOW));
  const weddEnd = fmtDate(addDays(thisSunday, 7 * 12 + 7 + WINDOW));

  const weddingsByDate = await p.request()
    .input('ws', sql.VarChar, weddStart)
    .input('we', sql.VarChar, weddEnd)
    .query(`
      SELECT wedd_date, COUNT(*) AS wedding_count
      FROM (
        SELECT DISTINCT co.order_seq,
          CONVERT(varchar(10), TRY_CAST(w.event_year+'-'+RIGHT('0'+w.event_month,2)+'-'+RIGHT('0'+w.event_Day,2) AS date), 120) AS wedd_date
        FROM custom_order co WITH (NOLOCK)
        INNER JOIN custom_order_WeddInfo w WITH (NOLOCK) ON co.order_seq = w.order_seq
        WHERE co.status_seq >= 1
          AND w.event_year IS NOT NULL AND LEN(w.event_year) = 4
          AND TRY_CAST(w.event_year+'-'+RIGHT('0'+w.event_month,2)+'-'+RIGHT('0'+w.event_Day,2) AS date) >= @ws
          AND TRY_CAST(w.event_year+'-'+RIGHT('0'+w.event_month,2)+'-'+RIGHT('0'+w.event_Day,2) AS date) < @we
      ) t
      GROUP BY wedd_date
      ORDER BY wedd_date
    `);

  const weddingDailyMap = {};
  for (const r of weddingsByDate.recordset) { weddingDailyMap[r.wedd_date] = r.wedding_count; }

  // 2) 주차별 예식 윈도우 건수 (예식일 ±14일 범위)
  const weeks = [];
  for (let w = -8; w < 12; w++) {
    const weekStart = addDays(thisSunday, w * 7);
    const weekEnd = addDays(thisSunday, w * 7 + 6);

    // 예식 윈도우: [weekStart - 14일, weekEnd + 14일] 범위의 예식 건수
    let weddingPool = 0;
    for (let d = -WINDOW; d <= 6 + WINDOW; d++) {
      const key = fmtDate(addDays(weekStart, d));
      weddingPool += weddingDailyMap[key] || 0;
    }

    weeks.push({
      week_no: getISOWeek(weekStart),
      week_start: fmtDate(weekStart),
      week_end: fmtDate(weekEnd),
      wedding_pool: weddingPool,
      est_weekly_revenue: 0,
      has_data: weddingPool > 0,
    });
  }

  // 3) 주차별 실제 매출 조회 (ETC + CARD 합산)
  const actualWeeklyStart = fmtDate(addDays(thisSunday, -7 * 8)); // 8주 전부터
  const actualWeeklyEnd = fmtDate(addDays(todayDate, 1));

  const actualWeekly = await p.request()
    .input('awStart', sql.VarChar, actualWeeklyStart)
    .input('awEnd', sql.VarChar, actualWeeklyEnd)
    .query(`
      SELECT order_day, COUNT(*) AS order_count, SUM(settle_price) AS total_amount, SUM(total_qty) AS total_qty
      FROM (
        SELECT DISTINCT o.order_seq, CONVERT(varchar(10), o.order_date, 120) AS order_day, o.settle_price,
          (SELECT SUM(oi2.order_count) FROM CUSTOM_ETC_ORDER_ITEM oi2 WITH (NOLOCK) INNER JOIN S2_Card c2 WITH (NOLOCK) ON oi2.card_seq=c2.Card_Seq WHERE oi2.order_seq=o.order_seq AND ${D01_FILTER.replace(/c\./g,'c2.')}) AS total_qty
        FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
        INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
        INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
        WHERE ${D01_FILTER} AND o.order_date >= @awStart AND o.order_date < @awEnd AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 14, 15)
      ) t GROUP BY order_day

      UNION ALL

      SELECT order_day, COUNT(*) AS order_count, SUM(settle_price) AS total_amount, SUM(total_qty) AS total_qty
      FROM (
        SELECT DISTINCT co.order_seq, CONVERT(varchar(10), co.order_date, 120) AS order_day,
          (SELECT ISNULL(SUM(CAST(coi2.item_sale_price AS float) * coi2.item_count / ISNULL(NULLIF(c2.Unit_Value, 0), 1)), 0) FROM custom_order_item coi2 WITH (NOLOCK) INNER JOIN S2_Card c2 WITH (NOLOCK) ON coi2.card_seq=c2.Card_Seq WHERE coi2.order_seq=co.order_seq AND ${D01_FILTER.replace(/c\./g,'c2.')}) AS settle_price,
          (SELECT SUM(coi2.item_count) FROM custom_order_item coi2 WITH (NOLOCK) INNER JOIN S2_Card c2 WITH (NOLOCK) ON coi2.card_seq=c2.Card_Seq WHERE coi2.order_seq=co.order_seq AND ${D01_FILTER.replace(/c\./g,'c2.')}) AS total_qty
        FROM custom_order co WITH (NOLOCK)
        INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
        INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
        WHERE ${D01_FILTER} AND co.order_date >= @awStart AND co.order_date < @awEnd AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5, 14)
      ) t GROUP BY order_day
    `);

  // 일별 실제 매출 맵 (ETC+CARD 합산)
  const actualDailyMap = {};
  for (const r of actualWeekly.recordset) {
    if (!actualDailyMap[r.order_day]) actualDailyMap[r.order_day] = { amount: 0, orders: 0, qty: 0 };
    actualDailyMap[r.order_day].amount += r.total_amount || 0;
    actualDailyMap[r.order_day].orders += r.order_count || 0;
    actualDailyMap[r.order_day].qty += r.total_qty || 0;
  }

  // 각 주차에 실제 매출 매핑
  for (const w of weeks) {
    let actAmount = 0, actOrders = 0, actQty = 0, actDays = 0;
    for (let d = 0; d < 7; d++) {
      const key = fmtDate(addDays(new Date(w.week_start), d));
      const isPast = new Date(key) < todayDate;
      if (isPast && actualDailyMap[key]) {
        actAmount += actualDailyMap[key].amount;
        actOrders += actualDailyMap[key].orders;
        actQty += actualDailyMap[key].qty;
        actDays++;
      } else if (isPast) {
        actDays++; // 과거인데 매출 0인 날도 카운트
      }
    }
    w.actual_weekly_revenue = Math.round(actAmount);
    w.actual_orders = actOrders;
    w.actual_qty = actQty;
    w.actual_days = actDays; // 경과일 수 (7이면 완료된 주)
    w.is_past = actDays >= 7;
    w.is_current = actDays > 0 && actDays < 7;
  }

  // 4) 가중 이동평균: 최근 주차에 높은 가중치로 시즌 트렌드 반영
  //    예상매출 = 예식건수 × 전환율 × 객단가
  //    매출이 0인 주차는 제외 (비시즌 주차가 전환율을 희석시키는 것 방지)
  //    가중치: 가장 오래된 주 1, ..., 가장 최근 주 N (선형 가중)
  const MIN_WEEKLY_ORDERS = 20; // 오퍼레이팅 초기 등 비정상 주차 제외 기준
  const completedWeeks = weeks.filter(w => w.is_past);
  const activeWeeks = completedWeeks.filter(w => w.actual_orders >= MIN_WEEKLY_ORDERS);
  const baseWeeks = activeWeeks.slice(-BASE_WEEKS);
  let baseTotalRevenue = 0, baseTotalOrders = 0, baseTotalWeddings = 0;
  let weightedOrders = 0, weightedWeddings = 0, weightedRevenue = 0, weightSum = 0;
  baseWeeks.forEach((bw, i) => {
    const weight = i + 1; // 1, 2, 3, 4 (최근일수록 높은 가중치)
    weightSum += weight;
    weightedOrders += bw.actual_orders * weight;
    weightedWeddings += bw.wedding_pool * weight;
    weightedRevenue += bw.actual_weekly_revenue * weight;
    // 단순 합계도 유지 (참고용)
    baseTotalRevenue += bw.actual_weekly_revenue;
    baseTotalOrders += bw.actual_orders;
    baseTotalWeddings += bw.wedding_pool;
  });
  const conversionRate = weightedWeddings > 0 ? weightedOrders / weightedWeddings : 0;
  const avgOrderValue = weightedOrders > 0 ? weightedRevenue / weightedOrders : 0;

  // 예측 적용 + 오차율
  for (const w of weeks) {
    w.est_orders = Math.round(w.wedding_pool * conversionRate);
    w.est_weekly_revenue = Math.round(w.wedding_pool * conversionRate * avgOrderValue);
    w.accuracy_pct = (w.is_past && w.est_weekly_revenue > 0)
      ? Math.round((w.actual_weekly_revenue - w.est_weekly_revenue) / w.est_weekly_revenue * 100)
      : null;
  }

  // 5) 실제 최근 일평균 매출 (검증용) - ETC + CARD 통합
  const actualStats = await p.request()
    .input('start30', sql.VarChar, fmtDate(addDays(today(), -30)))
    .input('today', sql.VarChar, todayStr)
    .query(`
      SELECT COUNT(*) AS total_orders, ISNULL(SUM(settle_price),0) AS total_amount, COUNT(DISTINCT order_day) AS active_days
      FROM (
        SELECT DISTINCT o.order_seq, o.settle_price, CONVERT(varchar(10), o.order_date, 120) AS order_day
        FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
        INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
        INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
        WHERE ${D01_FILTER} AND o.order_date >= @start30 AND o.order_date < DATEADD(day,1,@today) AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 14, 15)

        UNION ALL

        SELECT DISTINCT co.order_seq,
          (SELECT ISNULL(SUM(CAST(coi2.item_sale_price AS float) * coi2.item_count / ISNULL(NULLIF(c2.Unit_Value, 0), 1)), 0) FROM custom_order_item coi2 WITH (NOLOCK) INNER JOIN S2_Card c2 WITH (NOLOCK) ON coi2.card_seq=c2.Card_Seq WHERE coi2.order_seq=co.order_seq AND ${D01_FILTER.replace(/c\./g,'c2.')}) AS settle_price,
          CONVERT(varchar(10), co.order_date, 120) AS order_day
        FROM custom_order co WITH (NOLOCK)
        INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
        INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
        WHERE ${D01_FILTER} AND co.order_date >= @start30 AND co.order_date < DATEADD(day,1,@today) AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5, 14)
      ) t
    `);

  const actual = actualStats.recordset[0] || {};
  const actualDailyAvg = actual.active_days > 0 ? Math.round(actual.total_amount / actual.active_days) : 0;

  // 주차별 전환율 트렌드 (대시보드 표시용)
  const weeklyConversionTrend = activeWeeks.slice(-6).map(w => ({
    week_no: w.week_no,
    week_start: w.week_start,
    wedding_pool: w.wedding_pool,
    actual_orders: w.actual_orders,
    conversion_rate: w.wedding_pool > 0 ? Math.round(w.actual_orders / w.wedding_pool * 10000) / 100 : 0,
    avg_order_value: w.actual_orders > 0 ? Math.round(w.actual_weekly_revenue / w.actual_orders) : 0,
  }));

  return {
    model: {
      type: 'weighted_moving_average',
      window_days: WINDOW,
      base_weeks: BASE_WEEKS,
      conversion_rate: Math.round(conversionRate * 10000) / 100, // % 단위 (소수점 2자리)
      avg_order_value: Math.round(avgOrderValue),
      base_active_weeks: baseWeeks.length,
      base_week_labels: baseWeeks.map(w => w.week_no + '주차'),
      base_total_revenue: baseTotalRevenue,
      base_total_orders: baseTotalOrders,
      base_total_weddings: baseTotalWeddings,
      weekly_conversion_trend: weeklyConversionTrend,
    },
    weeks,
    actual_30d: {
      daily_avg_revenue: actualDailyAvg,
      total_orders: actual.total_orders || 0,
      total_amount: actual.total_amount || 0,
      active_days: actual.active_days || 0,
    },
  };
}

function getISOWeek(d) {
  const date = new Date(d.getTime());
  date.setHours(0,0,0,0);
  date.setDate(date.getDate() + 3 - (date.getDay() + 6) % 7);
  const week1 = new Date(date.getFullYear(), 0, 4);
  return 1 + Math.round(((date - week1) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);
}

async function apiLeadtime() {
  const p = await getPool();
  // ETC + CARD 답례품 리드타임 통합
  const result = await p.request().query(`
    SELECT order_key, order_date, wedding_date, lead_days FROM (
      -- ETC: 별도 주문 → 같은 member의 청첩장 예식일 참조
      SELECT
        CONCAT('E', o.order_seq) AS order_key,
        o.order_date,
        TRY_CAST(cw.event_year+'-'+RIGHT('0'+cw.event_month,2)+'-'+RIGHT('0'+cw.event_Day,2) AS date) AS wedding_date,
        DATEDIFF(day, o.order_date, TRY_CAST(cw.event_year+'-'+RIGHT('0'+cw.event_month,2)+'-'+RIGHT('0'+cw.event_Day,2) AS date)) AS lead_days,
        ROW_NUMBER() OVER (PARTITION BY o.order_seq ORDER BY o.order_seq) AS rn
      FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
      INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
      INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
      CROSS APPLY (
        SELECT TOP 1 w2.event_year, w2.event_month, w2.event_Day
        FROM custom_order co2 WITH (NOLOCK)
        INNER JOIN custom_order_WeddInfo w2 WITH (NOLOCK) ON co2.order_seq = w2.order_seq
        WHERE co2.member_id = o.member_id AND co2.status_seq >= 1
          AND w2.event_year IS NOT NULL AND LEN(w2.event_year) = 4
        ORDER BY co2.order_seq DESC
      ) cw
      WHERE ${D01_FILTER} AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 14, 15)
        AND TRY_CAST(cw.event_year+'-'+RIGHT('0'+cw.event_month,2)+'-'+RIGHT('0'+cw.event_Day,2) AS date) IS NOT NULL
        AND o.order_date >= DATEADD(day, -180, GETDATE())

      UNION ALL

      -- CARD: 청첩장+답례품 동시주문 → 같은 주문의 예식일 직접 참조
      SELECT
        CONCAT('C', co.order_seq) AS order_key,
        co.order_date,
        TRY_CAST(w.event_year+'-'+RIGHT('0'+w.event_month,2)+'-'+RIGHT('0'+w.event_Day,2) AS date) AS wedding_date,
        DATEDIFF(day, co.order_date, TRY_CAST(w.event_year+'-'+RIGHT('0'+w.event_month,2)+'-'+RIGHT('0'+w.event_Day,2) AS date)) AS lead_days,
        ROW_NUMBER() OVER (PARTITION BY co.order_seq ORDER BY co.order_seq) AS rn
      FROM custom_order co WITH (NOLOCK)
      INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
      INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
      INNER JOIN custom_order_WeddInfo w WITH (NOLOCK) ON co.order_seq = w.order_seq
      WHERE ${D01_FILTER} AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5, 14)
        AND w.event_year IS NOT NULL AND LEN(w.event_year) = 4
        AND TRY_CAST(w.event_year+'-'+RIGHT('0'+w.event_month,2)+'-'+RIGHT('0'+w.event_Day,2) AS date) IS NOT NULL
        AND co.order_date >= DATEADD(day, -180, GETDATE())
    ) t WHERE rn = 1
    ORDER BY order_date DESC
  `);

  const allDays = result.recordset.map(r => r.lead_days).filter(d => d !== null && d > -365 && d < 365);
  const positiveDays = allDays.filter(d => d >= 0);
  const avg = positiveDays.length ? Math.round(positiveDays.reduce((a,b) => a+b, 0) / positiveDays.length) : 0;
  const sorted = [...positiveDays].sort((a,b) => a-b);
  const median = sorted.length ? sorted[Math.floor(sorted.length/2)] : 0;

  // 분포 (마이너스 = 예식 후 주문 포함, 구간 세분화)
  const buckets = {
    '예식후 21일+':0, '예식후 15~21일':0, '예식후 8~14일':0, '예식후 1~7일':0,
    '0-7일':0, '8-14일':0, '15-21일':0,
    '22-30일':0, '31-60일':0, '60일+':0
  };
  for (const d of allDays) {
    if (d < -21) buckets['예식후 21일+']++;
    else if (d < -14) buckets['예식후 15~21일']++;
    else if (d < -7) buckets['예식후 8~14일']++;
    else if (d < 0) buckets['예식후 1~7일']++;
    else if (d <= 7) buckets['0-7일']++;
    else if (d <= 14) buckets['8-14일']++;
    else if (d <= 21) buckets['15-21일']++;
    else if (d <= 30) buckets['22-30일']++;
    else if (d <= 60) buckets['31-60일']++;
    else buckets['60일+']++;
  }

  return { avg_days: avg, median_days: median, total_samples: allDays.length, distribution: buckets };
}

// === 주차별 전환율 (예식수 vs 답례품 주문수) ===
async function apiConversion() {
  const p = await getPool();
  // 최근 12주 범위
  const todayDate = today();
  const thisSunday = addDays(todayDate, -todayDate.getDay()); // 이번 주 일요일
  const startDate = fmtDate(addDays(thisSunday, -7 * 11));
  const endDate = fmtDate(addDays(thisSunday, 7)); // 이번주 토요일까지

  // 1) 주차별 예식수 (회원가입 시 설정된 예식일 기준, 가입사이트별 분리)
  // S2_UserInfo.REFERER_SALES_GUBUN = 회원의 실제 가입 사이트
  // site_div = 'SB'로 통합회원 중복 제거 (같은 uid가 SB/SS/BM 3건씩 존재)
  const weddings = await p.request()
    .input('ws', sql.VarChar, startDate)
    .input('we', sql.VarChar, endDate)
    .query(`
      SELECT
        wd,
        site_name,
        COUNT(*) AS wedding_count
      FROM (
        SELECT DISTINCT u.uid,
          CONVERT(varchar(10), TRY_CAST(u.wedd_year+'-'+RIGHT('0'+u.wedd_month,2)+'-'+RIGHT('0'+u.wedd_day,2) AS date), 120) AS wd,
          ISNULL(si.SiteName, '기타') AS site_name
        FROM S2_UserInfo u WITH (NOLOCK)
        LEFT JOIN SiteInfo si ON u.REFERER_SALES_GUBUN = si.SiteCode
        WHERE u.site_div = 'SB'
          AND u.wedd_year IS NOT NULL AND LEN(u.wedd_year) = 4
          AND TRY_CAST(u.wedd_year+'-'+RIGHT('0'+u.wedd_month,2)+'-'+RIGHT('0'+u.wedd_day,2) AS date) >= @ws
          AND TRY_CAST(u.wedd_year+'-'+RIGHT('0'+u.wedd_month,2)+'-'+RIGHT('0'+u.wedd_day,2) AS date) < @we
      ) t
      GROUP BY wd, site_name
      ORDER BY wd
    `);

  // 2) 주차별 답례품 주문수 (주문일 기준)
  const orders = await p.request()
    .input('os', sql.VarChar, startDate)
    .input('oe', sql.VarChar, endDate)
    .query(`
      SELECT CONVERT(varchar(10), o.order_date, 120) AS od, COUNT(DISTINCT o.order_seq) AS order_count
      FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
      INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
      INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
      WHERE ${D01_FILTER} AND o.order_date >= @os AND o.order_date < @oe
        AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 14, 15)
      GROUP BY CONVERT(varchar(10), o.order_date, 120)

      UNION ALL

      SELECT CONVERT(varchar(10), co.order_date, 120), COUNT(DISTINCT co.order_seq)
      FROM custom_order co WITH (NOLOCK)
      INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
      INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
      WHERE ${D01_FILTER} AND co.order_date >= @os AND co.order_date < @oe
        AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5, 14)
      GROUP BY CONVERT(varchar(10), co.order_date, 120)
    `);

  // 일별 → 주차별 집계 (사이트별)
  // weddingMap: { 'YYYY-MM-DD': { total: N, '바른손카드': N, '바른손몰': N, ... } }
  const MAIN_SITES = ['바른손카드', '바른손몰', '바른손M카드'];
  const weddingMap = {};
  weddings.recordset.forEach(r => {
    if (!weddingMap[r.wd]) weddingMap[r.wd] = { total: 0 };
    weddingMap[r.wd].total += r.wedding_count;
    const site = MAIN_SITES.includes(r.site_name) ? r.site_name : '기타';
    weddingMap[r.wd][site] = (weddingMap[r.wd][site] || 0) + r.wedding_count;
  });
  const orderMap = {};
  orders.recordset.forEach(r => { orderMap[r.od] = (orderMap[r.od]||0) + r.order_count; });

  const weeks = [];
  for (let i = -11; i <= 0; i++) {
    const sunday = addDays(thisSunday, i * 7);
    const saturday = addDays(sunday, 6);
    const weekLabel = `${fmtDate(sunday).slice(5)}~${fmtDate(saturday).slice(5)}`;
    let weddCount = 0, ordCount = 0;
    const bySite = {};
    for (const s of [...MAIN_SITES, '기타']) bySite[s] = 0;
    for (let d = 0; d < 7; d++) {
      const key = fmtDate(addDays(sunday, d));
      const dayData = weddingMap[key];
      if (dayData) {
        weddCount += dayData.total;
        for (const s of Object.keys(bySite)) {
          bySite[s] += dayData[s] || 0;
        }
      }
      ordCount += orderMap[key] || 0;
    }
    weeks.push({
      week_label: weekLabel,
      week_start: fmtDate(sunday),
      wedding_count: weddCount,
      wedding_by_site: bySite,
      order_count: ordCount,
      conversion_pct: weddCount > 0 ? Math.round(ordCount / weddCount * 1000) / 10 : 0,
    });
  }
  return { weeks, sites: [...MAIN_SITES, '기타'] };
}

// === 샘플 주문 (수량=1) 일별 추이 ===
async function apiSamples() {
  const p = await getPool();
  const endDate = fmtDate(addDays(today(), 1));
  const startDate = fmtDate(addDays(today(), -30));

  const result = await p.request()
    .input('ss', sql.VarChar, startDate)
    .input('se', sql.VarChar, endDate)
    .query(`
      SELECT order_day, card_name, card_code, COUNT(*) AS sample_count
      FROM (
        SELECT CONVERT(varchar(10), o.order_date, 120) AS order_day,
          c.Card_Name AS card_name, c.Card_Code AS card_code
        FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
        INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
        INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
        WHERE ${D01_FILTER} AND o.order_date >= @ss AND o.order_date < @se
          AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 14, 15)
          AND oi.order_count = 1

        UNION ALL

        SELECT CONVERT(varchar(10), co.order_date, 120),
          c.Card_Name, c.Card_Code
        FROM custom_order co WITH (NOLOCK)
        INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
        INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
        WHERE ${D01_FILTER} AND co.order_date >= @ss AND co.order_date < @se
          AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5, 14)
          AND coi.item_count = 1
      ) t
      GROUP BY order_day, card_name, card_code
      ORDER BY order_day DESC, sample_count DESC
    `);

  // 상품기준 일별 합계 (수량1인 상품 각각 1건)
  const dailyMap = {};
  result.recordset.forEach(r => {
    if (!dailyMap[r.order_day]) dailyMap[r.order_day] = { total: 0, products: [] };
    dailyMap[r.order_day].total += r.sample_count;
    dailyMap[r.order_day].products.push({ name: r.card_name, code: r.card_code, count: r.sample_count });
  });

  const byProduct = Object.entries(dailyMap)
    .sort((a,b) => b[0].localeCompare(a[0]))
    .map(([day, v]) => ({ date: day, total: v.total, products: v.products }));

  // 주문건 기준 (수량1 상품이 포함된 주문 = DISTINCT order_seq)
  const orderResult = await p.request()
    .input('sos', sql.VarChar, startDate)
    .input('soe', sql.VarChar, endDate)
    .query(`
      SELECT order_day, COUNT(*) AS order_count FROM (
        SELECT DISTINCT CONVERT(varchar(10), o.order_date, 120) AS order_day, o.order_seq
        FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
        INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
        INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
        WHERE ${D01_FILTER} AND o.order_date >= @sos AND o.order_date < @soe
          AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 14, 15)
          AND oi.order_count = 1

        UNION

        SELECT DISTINCT CONVERT(varchar(10), co.order_date, 120), co.order_seq
        FROM custom_order co WITH (NOLOCK)
        INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
        INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
        WHERE ${D01_FILTER} AND co.order_date >= @sos AND co.order_date < @soe
          AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5, 14)
          AND coi.item_count = 1
      ) t
      GROUP BY order_day
      ORDER BY order_day DESC
    `);

  const byOrder = orderResult.recordset.map(r => ({ date: r.order_day, total: r.order_count }));

  return { byProduct, byOrder };
}

async function apiMarketing(query = {}) {
  const p = await getPool();
  const mkStart = query.start_date || fmtDate(addDays(today(), -90));
  const mkEnd = query.end_date || fmtDate(addDays(today(), 1));
  // Validate date format (prevent SQL injection)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(mkStart) || !/^\d{4}-\d{2}-\d{2}$/.test(mkEnd)) {
    throw new Error('Invalid date format');
  }
  const MK_FROM = `'${mkStart}'`;
  const MK_TO = `'${mkEnd}'`;

  // 1) 시간대별 주문 분포 (ETC + CARD 답례품 통합)
  const hourly = await p.request().query(`
    SELECT hr, SUM(cnt) AS cnt FROM (
      SELECT DATEPART(hour, o.order_date) AS hr, COUNT(DISTINCT o.order_seq) AS cnt
      FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
      INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
      INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
      WHERE ${D01_FILTER} AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 14, 15) AND o.order_date >= ${MK_FROM} AND o.order_date < ${MK_TO}
      GROUP BY DATEPART(hour, o.order_date)
      UNION ALL
      SELECT DATEPART(hour, co.order_date) AS hr, COUNT(DISTINCT co.order_seq) AS cnt
      FROM custom_order co WITH (NOLOCK)
      INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
      INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
      WHERE ${D01_FILTER} AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5, 14) AND co.order_date >= ${MK_FROM} AND co.order_date < ${MK_TO}
      GROUP BY DATEPART(hour, co.order_date)
    ) t GROUP BY hr ORDER BY hr
  `);

  // 2) 요일별 주문 분포 (ETC + CARD 답례품 통합)
  const weekly = await p.request().query(`
    SELECT dow, SUM(cnt) AS cnt FROM (
      SELECT DATEPART(weekday, o.order_date) AS dow, COUNT(DISTINCT o.order_seq) AS cnt
      FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
      INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
      INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
      WHERE ${D01_FILTER} AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 14, 15) AND o.order_date >= ${MK_FROM} AND o.order_date < ${MK_TO}
      GROUP BY DATEPART(weekday, o.order_date)
      UNION ALL
      SELECT DATEPART(weekday, co.order_date) AS dow, COUNT(DISTINCT co.order_seq) AS cnt
      FROM custom_order co WITH (NOLOCK)
      INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
      INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
      WHERE ${D01_FILTER} AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5, 14) AND co.order_date >= ${MK_FROM} AND co.order_date < ${MK_TO}
      GROUP BY DATEPART(weekday, co.order_date)
    ) t GROUP BY dow ORDER BY dow
  `);

  // 3) 지역별 (ETC + CARD 답례품 통합)
  const region = await p.request().query(`
    SELECT TOP 12 region, SUM(cnt) AS cnt FROM (
      SELECT LEFT(o.recv_address, CHARINDEX(' ', o.recv_address + ' ') - 1) AS region,
             COUNT(DISTINCT o.order_seq) AS cnt
      FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
      INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
      INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
      WHERE ${D01_FILTER} AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 14, 15) AND o.order_date >= ${MK_FROM} AND o.order_date < ${MK_TO}
        AND o.recv_address IS NOT NULL AND LEN(o.recv_address) > 2
      GROUP BY LEFT(o.recv_address, CHARINDEX(' ', o.recv_address + ' ') - 1)
      UNION ALL
      SELECT LEFT(di.ADDR, CHARINDEX(' ', di.ADDR + ' ') - 1) AS region,
             COUNT(DISTINCT co.order_seq) AS cnt
      FROM custom_order co WITH (NOLOCK)
      INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
      INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
      LEFT JOIN DELIVERY_INFO di WITH (NOLOCK) ON co.order_seq = di.ORDER_SEQ AND di.DELIVERY_SEQ = 1
      WHERE ${D01_FILTER} AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5, 14) AND co.order_date >= ${MK_FROM} AND co.order_date < ${MK_TO}
        AND di.ADDR IS NOT NULL AND LEN(di.ADDR) > 2
      GROUP BY LEFT(di.ADDR, CHARINDEX(' ', di.ADDR + ' ') - 1)
    ) t GROUP BY region ORDER BY cnt DESC
  `);

  // 4) 전환율 (2단계 - 답례품 구매자 member_id → 청첩장 주문자 교차)
  // ETC + CARD 답례품 구매자 통합 (CARD 주문에 답례품 포함된 고객도 gift_member로 계산)
  const giftMembers = await p.request().query(`
    SELECT DISTINCT member_id FROM (
      SELECT o.member_id
      FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
      INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
      INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
      WHERE ${D01_FILTER} AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 14, 15) AND o.order_date >= ${MK_FROM} AND o.order_date < ${MK_TO}
        AND o.member_id IS NOT NULL AND o.member_id != ''
      UNION
      SELECT co.member_id
      FROM custom_order co WITH (NOLOCK)
      INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
      INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
      WHERE ${D01_FILTER} AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5, 14) AND co.order_date >= ${MK_FROM} AND co.order_date < ${MK_TO}
        AND co.member_id IS NOT NULL AND co.member_id != ''
    ) t
  `);
  const giftSet = new Set(giftMembers.recordset.map(r => r.member_id));

  const cardMembers = await p.request().query(`
    SELECT DISTINCT co.member_id
    FROM custom_order co WITH (NOLOCK)
    INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
    INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
    WHERE c.Card_Div = 'A01' AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5, 14) AND co.order_date >= ${MK_FROM} AND co.order_date < ${MK_TO}
      AND co.member_id IS NOT NULL AND co.member_id != ''
  `);
  const cardSet = new Set(cardMembers.recordset.map(r => r.member_id));

  let crossCount = 0;
  for (const m of giftSet) { if (cardSet.has(m)) crossCount++; }

  const conversion = {
    card_members: cardSet.size,
    gift_members: giftSet.size,
    cross_buy: crossCount,
    card_to_gift_pct: cardSet.size ? +(crossCount / cardSet.size * 100).toFixed(1) : 0,
    gift_has_card_pct: giftSet.size ? +(crossCount / giftSet.size * 100).toFixed(1) : 0,
    gift_only: giftSet.size - crossCount,
    gift_only_pct: giftSet.size ? +((giftSet.size - crossCount) / giftSet.size * 100).toFixed(1) : 0,
  };

  // 시간대 정리 (0~23시 전체)
  const hourMap = {};
  for (let i = 0; i < 24; i++) hourMap[i] = 0;
  hourly.recordset.forEach(r => { hourMap[r.hr] = r.cnt; });

  // 요일 정리
  const dayNames = ['','일','월','화','수','목','금','토'];
  const dayMap = {};
  for (let i = 1; i <= 7; i++) dayMap[dayNames[i]] = 0;
  weekly.recordset.forEach(r => { dayMap[dayNames[r.dow]] = r.cnt; });

  // 5) 사이트 분포 (주문사이트 + 가입사이트) - ETC + CARD 답례품 통합
  // COMPANY.SALES_GUBUN → SiteInfo.SiteCode 매핑으로 제휴사도 올바른 사이트 분류
  const siteResult = await p.request().query(`
    SELECT order_site, COUNT(DISTINCT order_key) AS order_count, COUNT(DISTINCT member_id) AS member_count FROM (
      SELECT DISTINCT
        ISNULL(os_si.SiteName, ISNULL(co.COMPANY_NAME, '기타')) AS order_site,
        CONCAT('E', o.order_seq) AS order_key, o.member_id
      FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
      INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
      INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
      LEFT JOIN COMPANY co WITH (NOLOCK) ON o.company_Seq = co.COMPANY_SEQ
      LEFT JOIN SiteInfo os_si ON co.SALES_GUBUN = os_si.SiteCode
      WHERE ${D01_FILTER} AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 14, 15)
        AND o.order_date >= ${MK_FROM} AND o.order_date < ${MK_TO}
      UNION ALL
      SELECT DISTINCT
        ISNULL(os_si.SiteName, ISNULL(comp.COMPANY_NAME, '기타')) AS order_site,
        CONCAT('C', cord.order_seq) AS order_key, cord.member_id
      FROM custom_order cord WITH (NOLOCK)
      INNER JOIN custom_order_item coi WITH (NOLOCK) ON cord.order_seq = coi.order_seq
      INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
      LEFT JOIN COMPANY comp WITH (NOLOCK) ON cord.company_Seq = comp.COMPANY_SEQ
      LEFT JOIN SiteInfo os_si ON comp.SALES_GUBUN = os_si.SiteCode
      WHERE ${D01_FILTER} AND cord.status_seq >= 2 AND cord.status_seq NOT IN (3, 5, 14)
        AND cord.order_date >= ${MK_FROM} AND cord.order_date < ${MK_TO}
    ) t GROUP BY order_site ORDER BY order_count DESC
  `);

  // 가입사이트 = 회원의 최초 답례품 주문 사이트 기준 (ETC + CARD 통합)
  const signupSiteResult = await p.request().query(`
    SELECT
      ISNULL(first_si.SiteName, '기타') AS signup_site,
      COUNT(*) AS member_count
    FROM (
      SELECT member_id, SALES_GUBUN,
             ROW_NUMBER() OVER (PARTITION BY member_id ORDER BY order_date ASC) AS rn
      FROM (
        SELECT o.member_id, co.SALES_GUBUN, o.order_date
        FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
        INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
        INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
        LEFT JOIN COMPANY co WITH (NOLOCK) ON o.company_Seq = co.COMPANY_SEQ
        WHERE ${D01_FILTER} AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 14, 15)
          AND o.order_date >= ${MK_FROM} AND o.order_date < ${MK_TO}
        UNION ALL
        SELECT cord.member_id, comp.SALES_GUBUN, cord.order_date
        FROM custom_order cord WITH (NOLOCK)
        INNER JOIN custom_order_item coi WITH (NOLOCK) ON cord.order_seq = coi.order_seq
        INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
        LEFT JOIN COMPANY comp WITH (NOLOCK) ON cord.company_Seq = comp.COMPANY_SEQ
        WHERE ${D01_FILTER} AND cord.status_seq >= 2 AND cord.status_seq NOT IN (3, 5, 14)
          AND cord.order_date >= ${MK_FROM} AND cord.order_date < ${MK_TO}
      ) all_orders
    ) first_order
    LEFT JOIN SiteInfo first_si ON first_order.SALES_GUBUN = first_si.SiteCode
    WHERE first_order.rn = 1
    GROUP BY ISNULL(first_si.SiteName, '기타')
    ORDER BY member_count DESC
  `);

  // 사이트 상관관계 (가입사이트 → 주문사이트 크로스탭) - ETC + CARD 통합
  const siteCrossResult = await p.request().query(`
    WITH all_gift_orders AS (
      SELECT o.member_id, o.order_seq, o.order_date, co.SALES_GUBUN, CONCAT('E', o.order_seq) AS order_key
      FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
      INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
      INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
      LEFT JOIN COMPANY co WITH (NOLOCK) ON o.company_Seq = co.COMPANY_SEQ
      WHERE ${D01_FILTER} AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 14, 15)
        AND o.order_date >= ${MK_FROM} AND o.order_date < ${MK_TO}
      UNION ALL
      SELECT cord.member_id, cord.order_seq, cord.order_date, comp.SALES_GUBUN, CONCAT('C', cord.order_seq) AS order_key
      FROM custom_order cord WITH (NOLOCK)
      INNER JOIN custom_order_item coi WITH (NOLOCK) ON cord.order_seq = coi.order_seq
      INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
      LEFT JOIN COMPANY comp WITH (NOLOCK) ON cord.company_Seq = comp.COMPANY_SEQ
      WHERE ${D01_FILTER} AND cord.status_seq >= 2 AND cord.status_seq NOT IN (3, 5, 14)
        AND cord.order_date >= ${MK_FROM} AND cord.order_date < ${MK_TO}
    ),
    first_site AS (
      SELECT member_id, SALES_GUBUN AS first_sg,
             ROW_NUMBER() OVER (PARTITION BY member_id ORDER BY order_date ASC) AS rn
      FROM all_gift_orders
    )
    SELECT
      ISNULL(fs_si.SiteName, '기타') AS signup_site,
      ISNULL(os_si.SiteName, '기타') AS order_site,
      COUNT(DISTINCT ago.order_key) AS order_count
    FROM all_gift_orders ago
    LEFT JOIN SiteInfo os_si ON ago.SALES_GUBUN = os_si.SiteCode
    INNER JOIN first_site fs ON ago.member_id = fs.member_id AND fs.rn = 1
    LEFT JOIN SiteInfo fs_si ON fs.first_sg = fs_si.SiteCode
    GROUP BY ISNULL(fs_si.SiteName, '기타'), ISNULL(os_si.SiteName, '기타')
    ORDER BY order_count DESC
  `);

  // 6) 재주문 분석 (최소 시간 구간별) - ETC + CARD 답례품 통합
  // 배송지 분리 주문과 실질적 재주문을 구분하기 위해 시간 기준 적용
  // 구간: 12시간, 24시간, 48시간, 72시간+ 이후 재주문만 카운트
  const reorderResult = await p.request().query(`
    WITH distinct_orders AS (
      SELECT DISTINCT o.member_id, CONCAT('E', o.order_seq) AS order_key, o.order_date, o.settle_price
      FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
      INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
      INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
      WHERE ${D01_FILTER} AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 14, 15)
        AND o.order_date >= ${MK_FROM} AND o.order_date < ${MK_TO}
      UNION ALL
      SELECT DISTINCT co.member_id, CONCAT('C', co.order_seq) AS order_key, co.order_date, co.settle_price
      FROM custom_order co WITH (NOLOCK)
      INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
      INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
      WHERE ${D01_FILTER} AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5, 14)
        AND co.order_date >= ${MK_FROM} AND co.order_date < ${MK_TO}
    ),
    member_gaps AS (
      SELECT a.member_id,
             MIN(DATEDIFF(hour, a.order_date, b.order_date)) AS min_gap_hours
      FROM distinct_orders a
      INNER JOIN distinct_orders b ON a.member_id = b.member_id AND b.order_date > a.order_date
                                      AND a.order_key != b.order_key
      GROUP BY a.member_id
    ),
    member_stats AS (
      SELECT o.member_id,
             COUNT(DISTINCT o.order_key) AS order_cnt,
             MIN(o.order_date) AS first_order_date,
             MAX(o.order_date) AS last_order_date,
             SUM(o.settle_price) AS total_amount
      FROM distinct_orders o
      GROUP BY o.member_id
    )
    SELECT
      (SELECT COUNT(*) FROM member_stats) AS total_members,
      SUM(CASE WHEN mg.min_gap_hours >= 12 THEN 1 ELSE 0 END) AS reorder_12h,
      SUM(CASE WHEN mg.min_gap_hours >= 24 THEN 1 ELSE 0 END) AS reorder_24h,
      SUM(CASE WHEN mg.min_gap_hours >= 48 THEN 1 ELSE 0 END) AS reorder_48h,
      SUM(CASE WHEN mg.min_gap_hours >= 72 THEN 1 ELSE 0 END) AS reorder_72h,
      COUNT(*) AS reorder_any,
      AVG(mg.min_gap_hours) AS avg_gap_hours,
      AVG(CASE WHEN mg.min_gap_hours >= 12 THEN ms.total_amount END) AS avg_reorder_amount_12h,
      (SELECT AVG(total_amount) FROM member_stats WHERE order_cnt = 1) AS avg_single_amount
    FROM member_gaps mg
    INNER JOIN member_stats ms ON mg.member_id = ms.member_id
  `);

  // 재주문 간격 분포 (시간 단위로 세분화) - ETC + CARD 답례품 통합
  const reorderIntervalResult = await p.request().query(`
    WITH distinct_orders AS (
      SELECT DISTINCT o.member_id, CONCAT('E', o.order_seq) AS order_key, o.order_date
      FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
      INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
      INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
      WHERE ${D01_FILTER} AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 14, 15)
        AND o.order_date >= ${MK_FROM} AND o.order_date < ${MK_TO}
      UNION ALL
      SELECT DISTINCT co.member_id, CONCAT('C', co.order_seq) AS order_key, co.order_date
      FROM custom_order co WITH (NOLOCK)
      INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
      INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
      WHERE ${D01_FILTER} AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5, 14)
        AND co.order_date >= ${MK_FROM} AND co.order_date < ${MK_TO}
    ),
    ordered AS (
      SELECT member_id, order_key, order_date,
             ROW_NUMBER() OVER (PARTITION BY member_id ORDER BY order_date) AS rn
      FROM distinct_orders
    ),
    reorder_gap AS (
      SELECT a.member_id,
             DATEDIFF(hour, a.order_date, b.order_date) AS gap_hours
      FROM ordered a
      INNER JOIN ordered b ON a.member_id = b.member_id AND a.rn = 1 AND b.rn = 2
    )
    SELECT
      CASE
        WHEN gap_hours < 12 THEN '12시간 미만 (배송지분리)'
        WHEN gap_hours < 24 THEN '12~24시간'
        WHEN gap_hours < 48 THEN '24~48시간'
        WHEN gap_hours < 72 THEN '48~72시간'
        WHEN gap_hours < 168 THEN '3일~1주'
        WHEN gap_hours < 720 THEN '1주~1개월'
        ELSE '1개월 이상'
      END AS interval_label,
      COUNT(*) AS cnt,
      CASE WHEN gap_hours < 12 THEN 0 ELSE 1 END AS is_reorder
    FROM reorder_gap
    GROUP BY CASE
        WHEN gap_hours < 12 THEN '12시간 미만 (배송지분리)'
        WHEN gap_hours < 24 THEN '12~24시간'
        WHEN gap_hours < 48 THEN '24~48시간'
        WHEN gap_hours < 72 THEN '48~72시간'
        WHEN gap_hours < 168 THEN '3일~1주'
        WHEN gap_hours < 720 THEN '1주~1개월'
        ELSE '1개월 이상'
      END,
      CASE WHEN gap_hours < 12 THEN 0 ELSE 1 END
    ORDER BY MIN(gap_hours)
  `);

  // 7) 유입채널별 분석 (상품명 프리픽스 기반) - ETC + CARD 답례품 통합
  // [시크릿특가]=CRM/광고, [n%할인가]=퍼널/오가닉, 없음=청첩장동시구매
  const CHANNEL_CASE = `CASE
    WHEN c.Card_Name LIKE '[[]시크릿특가]%' THEN 'CRM/광고'
    WHEN c.Card_Name LIKE '[[][0-9]%할인가]%' THEN '퍼널/오가닉'
    ELSE '청첩장동시구매'
  END`;

  const channelResult = await p.request().query(`
    SELECT channel, COUNT(DISTINCT order_key) AS order_count, SUM(item_count) AS item_count, SUM(revenue) AS revenue FROM (
      SELECT CONCAT('E', o.order_seq) AS order_key,
        ${CHANNEL_CASE} AS channel,
        oi.order_count AS item_count,
        ${ETC_AMOUNT_EXPR} AS revenue
      FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
      INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
      INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
      LEFT JOIN SiteInfo si WITH (NOLOCK) ON o.company_Seq = si.CompayCode
      WHERE ${D01_FILTER} AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 14, 15)
        AND o.order_date >= ${MK_FROM} AND o.order_date < ${MK_TO}
      UNION ALL
      SELECT CONCAT('C', co.order_seq) AS order_key,
        ${CHANNEL_CASE} AS channel,
        coi.item_count AS item_count,
        CAST(coi.item_sale_price AS float) * coi.item_count / ISNULL(NULLIF(c.Unit_Value, 0), 1) AS revenue
      FROM custom_order co WITH (NOLOCK)
      INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
      INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
      WHERE ${D01_FILTER} AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5, 14)
        AND co.order_date >= ${MK_FROM} AND co.order_date < ${MK_TO}
    ) t GROUP BY channel ORDER BY revenue DESC
  `);

  // 주차별 유입채널 트렌드
  const channelTrendResult = await p.request().query(`
    SELECT
      CONVERT(varchar(10), DATEADD(week, DATEDIFF(week, 0, order_date), 0), 120) AS week_start,
      channel,
      COUNT(DISTINCT order_key) AS order_count,
      SUM(item_count) AS item_count,
      SUM(revenue) AS revenue
    FROM (
      SELECT o.order_date, CONCAT('E', o.order_seq) AS order_key,
        ${CHANNEL_CASE} AS channel,
        oi.order_count AS item_count,
        ${ETC_AMOUNT_EXPR} AS revenue
      FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
      INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
      INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
      LEFT JOIN SiteInfo si WITH (NOLOCK) ON o.company_Seq = si.CompayCode
      WHERE ${D01_FILTER} AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 14, 15)
        AND o.order_date >= ${MK_FROM} AND o.order_date < ${MK_TO}
      UNION ALL
      SELECT co.order_date, CONCAT('C', co.order_seq) AS order_key,
        ${CHANNEL_CASE} AS channel,
        coi.item_count AS item_count,
        CAST(coi.item_sale_price AS float) * coi.item_count / ISNULL(NULLIF(c.Unit_Value, 0), 1) AS revenue
      FROM custom_order co WITH (NOLOCK)
      INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
      INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
      WHERE ${D01_FILTER} AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5, 14)
        AND co.order_date >= ${MK_FROM} AND co.order_date < ${MK_TO}
    ) t
    GROUP BY CONVERT(varchar(10), DATEADD(week, DATEDIFF(week, 0, order_date), 0), 120), channel
    ORDER BY week_start, channel
  `);

  return {
    hourly: hourMap,
    weekly: dayMap,
    region: region.recordset,
    conversion,
    memberSite: siteResult.recordset,
    signupSite: signupSiteResult.recordset,
    siteCross: siteCrossResult.recordset,
    reorder: reorderResult.recordset[0] || {},
    reorderInterval: reorderIntervalResult.recordset,
    channelMix: channelResult.recordset,
    channelTrend: channelTrendResult.recordset,
    period: `${mkStart} ~ ${mkEnd}`,
    mkStart, mkEnd,
  };
}

// --- HTTP Server ---
const server = http.createServer(async (req, res) => {
  try {
  const parsed = url.parse(req.url, true);
  // BASE_PATH 접두어 제거 (docker-manager 프록시가 /c/barungift/... 형태로 전달)
  let pathname = parsed.pathname;
  if (BASE_PATH && pathname.startsWith(BASE_PATH)) {
    pathname = pathname.slice(BASE_PATH.length) || '/';
  }

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // --- Auth routes ---
  const cookies = parseCookies(req);
  const session = getSession(cookies.session);
  const cookiePath = BASE_PATH || '/';

  if (pathname === '/auth/google' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { credential } = JSON.parse(body);
        const payload = await verifyGoogleToken(credential);
        const signedId = createSession({ email: payload.email, name: payload.name, picture: payload.picture });
        const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
        res.writeHead(200, {
          'Set-Cookie': `session=${signedId}; Path=${cookiePath}; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE/1000}${secure}`,
          'Content-Type': 'application/json',
        });
        res.end(JSON.stringify({ ok: true, email: payload.email, name: payload.name }));
      } catch(err) {
        console.error('Auth error:', err.message);
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (pathname === '/auth/logout' && req.method === 'POST') {
    destroySession(cookies.session);
    res.writeHead(200, {
      'Set-Cookie': `session=; Path=${cookiePath}; HttpOnly; SameSite=Lax; Max-Age=0`,
      'Content-Type': 'application/json',
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (pathname === '/auth/me') {
    if (session) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ email: session.email, name: session.name, picture: session.picture }));
    } else {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not authenticated' }));
    }
    return;
  }

  // --- 바른기프트 라우트 (고객 페이지: 인증 불필요 / 관리 API: 인증 필요) ---
  // 고객 페이지 (정적 HTML) - 인증 불필요
  if (pathname === '/order-info') {
    const bgHtml = fs.readFileSync(path.join(__dirname, 'barungift', 'order-info.html'), 'utf-8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(bgHtml);
    return;
  }
  // API 라우트
  if (pathname.startsWith('/api/bg/')) {
    const handled = await handleBarungiftApi(pathname, req, res, parsed.query, { getPool, sql, session });
    if (handled !== false) return;
  }

  // --- Export API (API key auth, no session required) ---
  if (pathname === '/api/export/orders' && req.method === 'GET') {
    if (!validateApiKey(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid or missing API key' }));
      return;
    }
    try {
      const data = await apiOrders(parsed.query);
      const filtered = data.filter(r => r.status_seq !== 3 && r.status_seq !== 5);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(filtered));
    } catch (err) {
      console.error('Export API Error:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // --- Auth gate: require login for all other routes (개발모드 우회) ---
  if (!session && !DEV_SKIP_AUTH) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getLoginPageHtml());
    return;
  }

  // API routes
  if (pathname.startsWith('/api/')) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    try {
      let data;
      if (pathname === '/api/orders') {
        data = await apiOrders(parsed.query);
      } else if (pathname === '/api/dashboard/comparison') {
        data = await apiDashboardComparison();
      } else if (pathname === '/api/dashboard/summary') {
        data = await apiDashboardSummary(parsed.query);
      } else if (pathname === '/api/dashboard/forecast') {
        data = await apiForecast();
      } else if (pathname === '/api/dashboard/leadtime') {
        data = await apiLeadtime();
      } else if (pathname === '/api/dashboard/marketing') {
        data = await apiMarketing(parsed.query);
      } else if (pathname === '/api/dashboard/conversion') {
        data = await apiConversion();
      } else if (pathname === '/api/dashboard/samples') {
        data = await apiSamples();
      } else if (pathname === '/api/debug-order') {
        // 주문 원시 데이터 확인용 (order_seq 파라미터)
        const seq = parseInt(parsed.query.order_seq);
        if (seq) {
          const pp = await getPool();
          const etc = await pp.request().input('seq', sql.Int, seq).query(`
            SELECT o.*, oi.card_sale_price, oi.order_count, oi.card_seq,
              c.Card_Name, c.Card_Code,
              ISNULL(si.SiteName, CAST(o.company_Seq AS VARCHAR)) AS site_name
            FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
            INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
            INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
            LEFT JOIN SiteInfo si WITH (NOLOCK) ON o.company_Seq = si.CompayCode
            WHERE o.order_seq = @seq
          `);
          const card = await pp.request().input('seq', sql.Int, seq).query(`
            SELECT co.order_seq, co.settle_price, co.company_Seq,
              coi.item_sale_price, coi.item_count, coi.card_seq,
              c.Card_Name, c.Card_Code,
              ISNULL(si.SiteName, CAST(co.company_Seq AS VARCHAR)) AS site_name
            FROM custom_order co WITH (NOLOCK)
            INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
            INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
            LEFT JOIN SiteInfo si WITH (NOLOCK) ON co.company_Seq = si.CompayCode
            WHERE co.order_seq = @seq
          `);
          // 배송지 정보 (컬럼 전체 조회)
          const delivery = await pp.request().input('seq', sql.Int, seq).query(`
            SELECT * FROM DELIVERY_INFO WITH (NOLOCK) WHERE ORDER_SEQ = @seq
          `);
          // DELIVERY_INFO_DETAIL 컬럼 구조 확인
          const ddCols = await pp.request().query(`
            SELECT TOP 0 * FROM DELIVERY_INFO_DETAIL WITH (NOLOCK)
          `);
          // 배송지별 상품 상세
          const deliveryDetail = await pp.request().input('seq', sql.Int, seq).query(`
            SELECT * FROM DELIVERY_INFO_DETAIL WITH (NOLOCK) WHERE ORDER_SEQ = @seq
          `);
          data = {
            etc: etc.recordset, card: card.recordset,
            delivery: delivery.recordset,
            deliveryDetailColumns: Object.keys(ddCols.recordset.columns || {}),
            deliveryDetail: deliveryDetail.recordset
          };
        } else { data = { error: 'order_seq required' }; }
      } else if (pathname === '/api/order-files') {
        data = await apiOrderFiles(parsed.query);
      } else if (pathname === '/api/product-stats') {
        data = await apiProductStats(parsed.query);
      } else if (pathname === '/api/categories') {
        data = Object.entries(CATEGORY_FILTERS).map(([key, val]) => ({ key, label: val.label }));
      } else if (pathname === '/api/worklog') {
        if (req.method === 'GET') {
          const wl = readWorklog();
          data = wl.entries.sort((a, b) => b.date.localeCompare(a.date));
        } else if (req.method === 'POST') {
          const body = await new Promise((resolve) => {
            let raw = '';
            req.on('data', c => raw += c);
            req.on('end', () => resolve(JSON.parse(raw)));
          });
          const wl = readWorklog();
          const existing = wl.entries.findIndex(e => e.id === body.id);
          // 메트릭 스냅샷 자동 캡처
          let metrics = body.metrics_snapshot;
          if (!metrics || !metrics.order_count) {
            try { metrics = await getDailyMetricsSnapshot(body.date); } catch(e) { metrics = { error: e.message }; }
          }
          const entry = {
            id: body.id || `${body.date}_${Date.now()}`,
            date: body.date,
            author: body.author || session?.email || 'unknown',
            author_name: body.author_name || session?.name || '',
            created_at: existing >= 0 ? wl.entries[existing].created_at : new Date().toISOString(),
            updated_at: new Date().toISOString(),
            content: body.content || body.activities || '',
            memo: body.memo || '',
            category: body.category || 'other',
            sites: body.sites || [],
            tags: body.tags || [],
            metrics: metrics,
          };
          if (existing >= 0) wl.entries[existing] = entry;
          else wl.entries.push(entry);
          saveWorklog(wl);
          data = entry;
        } else if (req.method === 'DELETE') {
          let id = parsed.query.id;
          if (!id) {
            const body = await new Promise((resolve) => {
              let raw = '';
              req.on('data', c => raw += c);
              req.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
            });
            id = body.id;
          }
          const wl = readWorklog();
          wl.entries = wl.entries.filter(e => e.id !== id);
          saveWorklog(wl);
          data = { ok: true };
        }
      } else if (pathname === '/api/collected') {
        if (req.method === 'GET') {
          data = await readCollected();
        } else if (req.method === 'POST') {
          const body = await new Promise((resolve) => {
            let raw = '';
            req.on('data', c => raw += c);
            req.on('end', () => resolve(JSON.parse(raw)));
          });
          // category 는 query 에서 옵션으로 받음 (예: ?category=daeryepum)
          data = await applyCollectedChanges(body, session, parsed.query.category);
        }
      } else if (pathname === '/api/worklog/metrics') {
        const dateStr = parsed.query.date;
        if (!dateStr) { data = { error: 'date required' }; }
        else { data = await getDailyMetricsSnapshot(dateStr); }
      } else {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Not found' }));
        return;
      }
      res.writeHead(200);
      res.end(JSON.stringify(data));
    } catch (err) {
      console.error('API Error:', err);
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Static files
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.join(__dirname, filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' };
  const contentType = mimeTypes[ext] || 'application/octet-stream';

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    res.writeHead(200, { 'Content-Type': contentType + '; charset=utf-8' });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
  } catch (globalErr) {
    console.error('[HTTP handler error]', req.method, req.url, globalErr.message);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '서버 내부 오류' }));
    }
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`답례품 관리 서버: http://localhost:${PORT}${BASE_PATH || ''}`);
});

// 서버 크래시 방지
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err.message, err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
