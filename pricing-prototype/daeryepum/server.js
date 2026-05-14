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

// --- Session Store (Supabase 영구화) ---
//   기존 in-memory Map → Supabase auth_sessions 테이블.
//   이유: 다중 컨테이너/재시작 시 세션 손실 → 로그인 루프 발생.
//   세션 ID 는 server 측 HMAC 서명으로 위변조 방지 (cookie 도메인 외부 신뢰 불가).
//
// Supabase 미설정 시 메모리 폴백 (개발 환경 호환).
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || '';
const USE_SUPABASE_AUTH = !!(SUPABASE_URL && SUPABASE_KEY);
const AUTH_REST_BASE = `${SUPABASE_URL}/rest/v1`;
const AUTH_HEADERS = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
};

// 메모리 폴백 (Supabase 미설정 환경용)
const _memorySessions = new Map();

async function _supabaseUpsertSession(sessionId, userData, expiresAt) {
  const row = {
    id: sessionId,
    email: userData.email || '',
    name: userData.name || null,
    picture: userData.picture || null,
    expires_at: new Date(expiresAt).toISOString(),
    last_seen_at: new Date().toISOString(),
  };
  const res = await fetch(`${AUTH_REST_BASE}/auth_sessions?on_conflict=id`, {
    method: 'POST',
    headers: { ...AUTH_HEADERS, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase upsert auth_sessions [${res.status}]: ${text.slice(0, 300)}`);
  }
}

async function _supabaseGetSession(sessionId) {
  const res = await fetch(`${AUTH_REST_BASE}/auth_sessions?id=eq.${encodeURIComponent(sessionId)}&select=*`, {
    headers: AUTH_HEADERS,
  });
  if (!res.ok) return null;
  const rows = await res.json();
  if (!rows.length) return null;
  const r = rows[0];
  const expiresAt = Date.parse(r.expires_at);
  if (!expiresAt || expiresAt < Date.now()) {
    // 만료 → 삭제 (best-effort, 실패해도 무시)
    _supabaseDeleteSession(sessionId).catch(() => {});
    return null;
  }
  return { email: r.email, name: r.name, picture: r.picture, expiresAt };
}

async function _supabaseDeleteSession(sessionId) {
  await fetch(`${AUTH_REST_BASE}/auth_sessions?id=eq.${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
    headers: AUTH_HEADERS,
  });
}

async function createSession(userData) {
  const sessionId = crypto.randomBytes(32).toString('hex');
  const hmac = crypto.createHmac('sha256', SESSION_SECRET).update(sessionId).digest('hex');
  const expiresAt = Date.now() + SESSION_MAX_AGE;
  if (USE_SUPABASE_AUTH) {
    try {
      await _supabaseUpsertSession(sessionId, userData, expiresAt);
    } catch (e) {
      console.error('[auth] Supabase 세션 저장 실패, 메모리 폴백:', e.message);
      _memorySessions.set(sessionId, { ...userData, expiresAt });
    }
  } else {
    _memorySessions.set(sessionId, { ...userData, expiresAt });
  }
  return sessionId + '.' + hmac;
}

async function getSession(signedId) {
  if (!signedId || !signedId.includes('.')) return null;
  const [sessionId, hmac] = signedId.split('.');
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(sessionId).digest('hex');
  if (hmac !== expected) return null;
  // Supabase 우선 조회 + 메모리 폴백 (양쪽에 존재할 수 있음)
  if (USE_SUPABASE_AUTH) {
    try {
      const s = await _supabaseGetSession(sessionId);
      if (s) return s;
    } catch (e) {
      console.warn('[auth] Supabase 세션 조회 실패, 메모리 폴백:', e.message);
    }
  }
  const memSession = _memorySessions.get(sessionId);
  if (!memSession || Date.now() > memSession.expiresAt) {
    _memorySessions.delete(sessionId);
    return null;
  }
  return memSession;
}

async function destroySession(signedId) {
  if (!signedId || !signedId.includes('.')) return;
  const sessionId = signedId.split('.')[0];
  _memorySessions.delete(sessionId);
  if (USE_SUPABASE_AUTH) {
    try { await _supabaseDeleteSession(sessionId); }
    catch (e) { console.warn('[auth] Supabase 세션 삭제 실패:', e.message); }
  }
}

/**
 * 관리자 debug/PII 라우트 감사 로그 — Docker 로그(stdout)로 기록.
 * 누가(이메일) 어떤 endpoint 를 어떤 파라미터로 호출했는지 추적용.
 * 외부 audit log DB 와 별개 (daeryepum admin 컨텍스트, bg_customer_access_log 와 분리).
 */
function logAdminAccess(session, req, action, params = {}) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket?.remoteAddress || '?';
  const admin = session?.email || 'unknown';
  console.log(`[ADMIN_AUDIT] ${new Date().toISOString()} email=${admin} ip=${ip} action=${action} params=${JSON.stringify(params)}`);
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
  options: {
    encrypt: true,
    trustServerCertificate: false,
    enableArithAbort: true,    // Azure SQL 권장
  },
  pool: {
    max: 10,
    min: 1,                    // 최소 1개 연결 유지 → idle 시점에도 풀 따뜻하게 (콜드스타트 방지)
    idleTimeoutMillis: 60000,  // 30→60초 (Azure idle close 보다 짧게 유지)
    acquireTimeoutMillis: 30000,
  },
  requestTimeout: 60000,
  connectionTimeout: 15000,
};

let pool = null;
let _poolInitPromise = null; // 동시 초기화 요청 중복 방지 (race-condition 가드)

/**
 * MSSQL 풀 획득 — 끊긴 풀 자동 감지 + 헬스체크 + 단일 재시도.
 * - pool.connected 가 stale 인 경우 (Azure SQL 이 idle 연결을 닫았지만 클라이언트가 모름)
 *   → SELECT 1 ping 으로 검증 후 실패 시 재생성.
 * - 동시 호출 시 _poolInitPromise 로 race-condition 차단.
 */
async function getPool() {
  if (pool && pool.connected) {
    // stale 검증 — 1초 timeout 핑
    try {
      await pool.request().query('SELECT 1 AS ping');
      return pool;
    } catch (e) {
      console.warn('[pool] stale 감지 — 재생성:', e.message);
      try { await pool.close(); } catch {}
      pool = null;
    }
  }
  // 초기화 중복 방지 — 이미 초기화 진행 중이면 그 Promise 공유
  if (_poolInitPromise) return _poolInitPromise;
  _poolInitPromise = (async () => {
    const p = new sql.ConnectionPool(DB_CONFIG);
    p.on('error', (err) => { console.error('Pool error:', err.message); pool = null; });
    await p.connect();
    pool = p;
    console.log('Connected to Barunson DB');
    // 제휴사명 캐시 로드 (최초 1회만)
    if (Object.keys(companyNameMap).length === 0) {
      try {
        const res = await p.request().query(`SELECT COMPANY_SEQ, COMPANY_NAME FROM COMPANY WITH (NOLOCK) WHERE COMPANY_NAME IS NOT NULL`);
        res.recordset.forEach(r => { companyNameMap[String(r.COMPANY_SEQ)] = r.COMPANY_NAME; });
        console.log(`Loaded ${Object.keys(companyNameMap).length} company names`);
      } catch (e) { console.error('Failed to load company names:', e.message); }
    }
    return p;
  })();
  try {
    return await _poolInitPromise;
  } finally {
    _poolInitPromise = null;
  }
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
//   Card_Div 코드 (S2_Card 테이블):
//     D01 = 답례품, D02 = 꽃다발, C29 = 데코소품(웨딩포스터/스티커/아크릴/photo_print 등)
//   이전 deco 필터는 'Card_Code LIKE 2026_%' prefix 였으나 photo_print_* 등 누락 발생 →
//   Card_Div 기준으로 정정 (C29 는 운영 진단으로 확인).
//   QR 스티커(2026_qr*) 는 C29 가 아닌 별도 Card_Div 에 있어 OR 조건 추가 (운영 요청).
const CATEGORY_FILTERS = {
  daeryepum: { label: '답례품', filter: `c.Card_Div = 'D01'` },
  deco:      { label: '데코소품', filter: `(c.Card_Div = 'C29' OR c.Card_Code LIKE '2026_qr%')` },
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
 *
 * 쓰기 정책:
 *   - Supabase 설정됐으면 Supabase 로만 저장. 실패 시 500 에러 throw (클라이언트 가시화).
 *     → 파일로 조용히 폴백하면 "저장 성공" 토스트가 뜨지만 새로고침시 날아간 것처럼 보임 (고아 데이터)
 *   - Supabase 미설정 (레거시/개발 모드) 만 파일로 저장.
 *
 * 읽기 정책 (readCollected): Supabase 오류시엔 파일 폴백 유지 (서비스 중단 방지)
 *
 * @returns {order_seqs, added, removed, source}
 */
async function applyCollectedChanges(body, session, category) {
  const addSeqs = (body.add || []).map(String);
  const removeSeqs = (body.remove || []).map(String);
  const email = session?.email || 'unknown';

  if (_USE_SUPABASE_COLLECTED) {
    // Supabase 가 설정된 경우 — 실패 시 throw 하여 클라이언트에 에러 노출
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
  }

  // 레거시/개발 모드 — 파일 저장
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
      ${ETC_COUPON_DIVISOR_JOIN_D01}
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
      ${ETC_COUPON_DIVISOR_JOIN_D01}
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
  // L5: 호출자가 status 필터를 SQL 단에서 적용하도록 옵션 제공.
  //   기본 빈배열 → 모든 status 반환 (주문조회 UI 호환).
  //   /api/export/orders 는 [3,5] 전달 → cancelled/draft 미전송 (네트워크 절약).
  const excludeRaw = query.exclude_status_seq || '';
  const excludeStatusList = String(excludeRaw)
    .split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isInteger(n));
  const statusExcludeClause = excludeStatusList.length
    ? `AND o.status_seq NOT IN (${excludeStatusList.join(',')})`
    : '';
  const statusExcludeClauseCo = excludeStatusList.length
    ? `AND co.status_seq NOT IN (${excludeStatusList.join(',')})`
    : '';
  // 카테고리별 cardDiv — ETC coupon 분배 분모로 사용.
  // 주문조회 화면: item_amount 는 gross(쿠폰 X), coupon_price 는 ecd.item_count 로 분배 표시.
  // (Dashboard 등 집계 쿼리는 별도로 etcAmountExpr 사용)
  const categoryCfg = CATEGORY_FILTERS[query.category] || CATEGORY_FILTERS.daeryepum;
  const etcAmountGross = etcAmountGrossExpr();
  const etcCouponDivisorForCategory = etcCouponDivisorJoin(categoryCfg.cardDiv);

  const result = await p.request()
    .input('startDate', sql.VarChar, startDate)
    .input('endDate', sql.VarChar, endDate)
    .query(`
      WITH
      card_copurchase_orders AS (
        SELECT DISTINCT coi2.order_seq
        FROM custom_order_item coi2 WITH (NOLOCK)
        INNER JOIN S2_Card c2 WITH (NOLOCK) ON coi2.card_seq = c2.Card_Seq
        WHERE c2.Card_Div = 'A01'
      ),
      etc_copurchase_orders AS (
        SELECT DISTINCT ei2.order_seq
        FROM CUSTOM_ETC_ORDER_ITEM ei2 WITH (NOLOCK)
        INNER JOIN S2_Card c2 WITH (NOLOCK) ON ei2.card_seq = c2.Card_Seq
        WHERE c2.Card_Div = 'A01'
      )
      -- 바른손몰 주문 (CUSTOM_ETC_ORDER) — 이제 청첩장+답례품 동시구매 가능
      -- 예식일: 같은 주문에 청첩장 있으면 그것 사용, 없으면 member_id 로 옛날 청첩장 매칭
      SELECT
        o.order_seq AS order_seq,
        o.member_id AS member_id,
        'ETC' AS order_type,
        CASE WHEN ecp.order_seq IS NOT NULL THEN 1 ELSE 0 END AS has_copurchase,
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
        ${etcAmountGross} AS item_amount,
        o.settle_price AS settle_price,
        ISNULL(o.coupon_price, 0) * 1.0 / ISNULL(NULLIF(ecd.item_count, 0), 1) AS coupon_price,
        o.status_seq AS status_seq,
        o.settle_method AS settle_method,  -- 결제수단 코드 (FirstMall: 1=카드/2=가상계좌/3=계좌이체/4=휴대폰/...)
        cw.event_year + '-' + RIGHT('0'+cw.event_month,2) + '-' + RIGHT('0'+cw.event_Day,2) AS wedding_date,
        ISNULL(si.SiteName, CAST(o.company_Seq AS VARCHAR)) AS site_name,
        0 AS file_count,
        1 AS delivery_seq  -- ETC 주문은 단일 배송지
      FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
      INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
      INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
      LEFT JOIN SiteInfo si WITH (NOLOCK) ON o.company_Seq = si.CompayCode
      LEFT JOIN etc_copurchase_orders ecp ON o.order_seq = ecp.order_seq
      ${etcCouponDivisorForCategory}
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
        ${statusExcludeClause}

      UNION ALL

      -- 바른손카드 주문 (custom_order)
      SELECT
        co.order_seq,
        co.member_id AS member_id,
        'CARD' AS order_type,
        CASE WHEN cp.order_seq IS NOT NULL THEN 1 ELSE 0 END AS has_copurchase,
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
        co.settle_method AS settle_method,  -- 결제수단 코드 (FirstMall: 1=카드/2=가상계좌/3=계좌이체/4=휴대폰/...)
        w.event_year + '-' + RIGHT('0'+w.event_month,2) + '-' + RIGHT('0'+w.event_Day,2) AS wedding_date,
        ISNULL(si.SiteName, CAST(co.company_Seq AS VARCHAR)) AS site_name,
        ISNULL((SELECT COUNT(*) FROM custom_order_plist p WITH (NOLOCK) INNER JOIN custom_order_plist_files f WITH (NOLOCK) ON p.id = f.pid WHERE p.order_seq = co.order_seq), 0) AS file_count,
        ISNULL(di.DELIVERY_SEQ, 1) AS delivery_seq  -- 배송지별 행 구분 (나눔배송 대응)
      FROM custom_order co WITH (NOLOCK)
      INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
      INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
      LEFT JOIN SiteInfo si WITH (NOLOCK) ON co.company_Seq = si.CompayCode
      LEFT JOIN card_copurchase_orders cp ON co.order_seq = cp.order_seq
      INNER JOIN (
        -- 배송지별 답례품 수량: DELIVERY_INFO_DETAIL 있으면 배송지별, 없으면 첫 배송지 1건
        --   delivery_seq 노출 — 같은 order_seq 에 여러 배송지가 있을 때 frontend 가
        --   (order_seq, delivery_seq) 복합키로 행 식별 가능 (정보입력현황 분리 표시).
        SELECT di.ORDER_SEQ, di.DELIVERY_SEQ, di.NAME, di.HPHONE, di.PHONE, di.ADDR, di.ADDR_DETAIL,
               di.DELIVERY_MEMO, dd.item_count AS dd_count
        FROM DELIVERY_INFO di WITH (NOLOCK)
        INNER JOIN DELIVERY_INFO_DETAIL dd WITH (NOLOCK)
          ON dd.delivery_id = di.ID AND dd.item_title = N'답례품' AND dd.item_count > 0
        UNION ALL
        -- DELIVERY_INFO_DETAIL에 답례품 기록이 없는 주문: 첫 배송지만
        SELECT di.ORDER_SEQ, di.DELIVERY_SEQ, di.NAME, di.HPHONE, di.PHONE, di.ADDR, di.ADDR_DETAIL,
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
        ${statusExcludeClauseCo}

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

  // 쿠팡 주문 UNION — Supabase coupang_orders 에서 같은 기간 조회 후 MSSQL row 와 동일 schema 로 정규화.
  //   카테고리가 'daeryepum' 일 때만 포함 (deco/flower 는 쿠팡 미운영 가정).
  //   실패해도 MSSQL 결과는 유지 (코어 운영 중단 방지).
  if (query.category === 'daeryepum' || !query.category) {
    try {
      const coupangStore = require('./coupang/store');
      const coupangRows = await coupangStore.listCoupangOrders({
        startStr: startDate,
        endStr: endDate,
        byPaid: false, // order_date 기준 (MSSQL 과 일관)
      });
      if (coupangRows && coupangRows.length) {
        const normalized = coupangRows.map(r => ({
          order_seq: r.coupang_order_id, // 쿠팡 orderId (BIGINT)
          member_id: null,
          order_type: 'COUPANG',
          has_copurchase: 0,
          order_date: r.ordered_at,
          settle_date: r.paid_at,
          order_name: r.recv_name || '',
          recv_name: r.recv_name || '',
          recv_hphone: r.recv_hphone || '',
          recv_address: r.recv_address || '',
          recv_msg: r.recv_message || '',
          card_name: r.product_name || '',
          card_code: r.product_code || '',
          item_count: r.item_count || 0,
          item_amount: r.item_total_price || 0,
          settle_price: r.settle_price || 0,
          coupon_price: 0,
          status_seq: null, // 쿠팡은 별도 status 체계 (status_label 사용)
          status_label: r.status_label || r.status || '',
          settle_method: r.settle_method || null,
          wedding_date: null,
          site_name: '쿠팡',
          file_count: 0,
          delivery_seq: 1,
          // 마킹: 프론트가 쿠팡 row 임을 구분할 수 있도록
          source: 'coupang',
          coupang_status: r.status,
          coupang_shipment_box_id: r.shipment_box_id,
          // 주문자명/받는사람 — 쿠팡은 받는사람만 있음
          display_name: r.recv_name || '',
        }));
        rows.push(...normalized);
        // 정렬 재적용 (order_date DESC)
        rows.sort((a, b) => String(b.order_date || '').localeCompare(String(a.order_date || '')));
      }
    } catch (e) {
      console.warn('[apiOrders] 쿠팡 주문 UNION 실패 (무시):', e.message);
    }
    // 네이버 스마트스토어 — 쿠팡과 동일 패턴
    try {
      const naverStore = require('./naver/store');
      const naverRows = await naverStore.listNaverOrders({
        startStr: startDate, endStr: endDate, byPaid: false,
      });
      if (naverRows && naverRows.length) {
        const normalized = naverRows.map(r => ({
          order_seq: r.product_order_id,
          member_id: null,
          order_type: 'NAVER',
          has_copurchase: 0,
          order_date: r.ordered_at,
          settle_date: r.paid_at,
          order_name: r.recv_name || '',
          recv_name: r.recv_name || '',
          recv_hphone: r.recv_hphone || '',
          recv_address: r.recv_address || '',
          recv_msg: r.recv_message || '',
          card_name: r.product_name || '',
          card_code: r.product_code || '',
          item_count: r.item_count || 0,
          item_amount: r.item_total_price || 0,
          settle_price: r.settle_price || 0,
          coupon_price: 0,
          status_seq: null,
          status_label: r.status_label || r.status || '',
          settle_method: r.settle_method || null,
          wedding_date: null,
          site_name: '네이버',
          file_count: 0,
          delivery_seq: 1,
          source: 'naver',
          naver_status: r.status,
          naver_order_id: r.order_id,
          display_name: r.recv_name || '',
        }));
        rows.push(...normalized);
        rows.sort((a, b) => String(b.order_date || '').localeCompare(String(a.order_date || '')));
      }
    } catch (e) {
      console.warn('[apiOrders] 네이버 주문 UNION 실패 (무시):', e.message);
    }
  }

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
// 쿠폰 할인 (H1 fix v2): coupon_price 를 같은 Card_Div 아이템 수로 나눠 분배 → SUM 시 정확히 1회 차감.
//   이전엔 행마다 전체 쿠폰 차감으로 N×coupon 다중 차감 버그.
//   v1(correlated scalar 서브쿼리) 은 행마다 실행돼 dashboard timeout → 폐기.
//   v2: derived table 로 주문당 1행 미리 집계 → JOIN. 1회 집계 후 hash join 으로 빠름.
//   사용 쿼리는 etcCouponDivisorJoin() 도 함께 LEFT JOIN 추가해야 함 (ecd alias).
// Unit_Value: S2_Card.Unit_Value (판매단위 수량, 예: 소프트터치=50개 단위)

/**
 * 같은 주문 내 같은 Card_Div 아이템 수를 미리 집계하는 derived table JOIN 절.
 *   GROUP BY 로 주문당 1행 → outer 행마다 재계산 X (성능).
 */
function etcCouponDivisorJoin(cardDiv = 'D01') {
  return `LEFT JOIN (
    SELECT order_seq, COUNT(*) AS item_count
    FROM CUSTOM_ETC_ORDER_ITEM oi_cpd WITH (NOLOCK)
    INNER JOIN S2_Card c_cpd WITH (NOLOCK) ON oi_cpd.card_seq = c_cpd.Card_Seq
    WHERE c_cpd.Card_Div = '${cardDiv}'
    GROUP BY order_seq
  ) ecd ON o.order_seq = ecd.order_seq`;
}

/** ETC 행 단위 매출 식 — outer 에 ecd.item_count alias (etcCouponDivisorJoin 결과) 가 있어야 함. */
function etcAmountExpr(cardDiv = 'D01') {
  return `
  CASE
    WHEN si.SiteName IS NULL
    THEN CAST(oi.card_sale_price AS float) * oi.order_count / ISNULL(NULLIF(c.Unit_Value, 0), 1)
         - ISNULL(o.coupon_price, 0) * 1.0 / NULLIF(ecd.item_count, 0)
    ELSE CAST(oi.card_sale_price AS float)
         - ISNULL(o.coupon_price, 0) * 1.0 / NULLIF(ecd.item_count, 0)
  END`;
}

/**
 * ETC 행 단위 정가 식 (쿠폰 분배 X) — 주문조회 화면 표시용.
 *   주문조회 결제금액 컬럼은 정가만 표시하고, 쿠폰할인은 별도 컬럼에서 ecd.item_count 로 분배 표시.
 *   (집계 쿼리는 etcAmountExpr 사용 — coupon 1회 차감 정확성 유지)
 */
function etcAmountGrossExpr() {
  return `
  CASE
    WHEN si.SiteName IS NULL
    THEN CAST(oi.card_sale_price AS float) * oi.order_count / ISNULL(NULLIF(c.Unit_Value, 0), 1)
    ELSE CAST(oi.card_sale_price AS float)
  END`;
}

const ETC_AMOUNT_EXPR = etcAmountExpr('D01');
const ETC_COUPON_DIVISOR_JOIN_D01 = etcCouponDivisorJoin('D01');

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
  const todayDate = today();
  const todayStr = fmtDate(todayDate);
  const tomorrowStr = fmtDate(addDays(todayDate, 1));
  const yesterdayStr = fmtDate(addDays(todayDate, -1));
  const lastWeekSameDayStr = fmtDate(addDays(todayDate, -7));
  const lastWeekSameDayNextStr = fmtDate(addDays(todayDate, -6));

  // 요일 이름
  const dayNames = ['일','월','화','수','목','금','토'];
  const todayDow = dayNames[todayDate.getDay()];

  // WoW 동기간 비교: 이번주 일요일~오늘 vs 지난주 일요일~지난주 같은 요일
  //   오늘=수: thisWeek = [Sun, Wed], lastWeek = [last Sun, last Wed] (각 4일)
  //   오늘=일: thisWeek = [Sun], lastWeek = [last Sun] (각 1일, 단일일자와 동일)
  const dayOfWeek = todayDate.getDay();
  const thisWeekStartDate = addDays(todayDate, -dayOfWeek);
  const thisWeekStartStr = fmtDate(thisWeekStartDate);
  const lastWeekStartStr = fmtDate(addDays(thisWeekStartDate, -7));
  // 지난주 동기간 끝(exclusive) = 이번주 동기간 끝(exclusive) - 7일 = today - 6
  const lastWeekPeriodEndExclusiveStr = fmtDate(addDays(todayDate, -6));

  // 각 기간별 ETC+CARD 합산 헬퍼
  //
  // 응답 구조:
  //   { order_count, total_amount, total_qty,
  //     by_site: { [site_name]: {
  //       order_count, total_amount, total_qty,
  //       copurchase: {amount, orders, qty},   // 청첩장+답례품 동시주문 (CARD 만)
  //       standalone: {amount, orders, qty},   // 답례품 단독주문 (CARD/ETC 모두)
  //     } },
  //     copurchase: {...},     // 전체 합계 (legacy 호환)
  //     standalone: {...},
  //     pending: {amount, orders, qty},  // 결제대기 별도 (status_seq=1, 매출 집계엔 미포함)
  //   }
  async function getPeriodTotal(startStr, endStr) {
    // 3개 쿼리(ETC 매출, CARD 매출, 결제대기)는 서로 독립 → Promise.all 로 병렬화 (CodeReview-H1).
    //   각 쿼리에 자기만의 request 인스턴스 부여 (mssql 모듈은 동시 input 충돌 방지 위해 권장).
    const [r, r2, rPending] = await Promise.all([
      // 1) ETC 주문 — 바른손몰도 이제 청첩장(A01) + 답례품(D01) 동시구매 가능.
      //    same as CARD: copurchase_orders CTE 적용 후 is_copurchase 분기.
      p.request()
        .input('s', sql.VarChar, startStr)
        .input('e', sql.VarChar, endStr)
        .query(`
          WITH etc_copurchase_orders AS (
            SELECT DISTINCT ei2.order_seq
            FROM CUSTOM_ETC_ORDER_ITEM ei2 WITH (NOLOCK)
            INNER JOIN S2_Card c2 WITH (NOLOCK) ON ei2.card_seq = c2.Card_Seq
            WHERE c2.Card_Div = 'A01'
          )
          SELECT
            ISNULL(si.SiteName, CAST(o.company_Seq AS VARCHAR)) AS site_name,
            CASE WHEN ecp.order_seq IS NOT NULL THEN 1 ELSE 0 END AS is_copurchase,
            COUNT(DISTINCT o.order_seq) AS order_count,
            ISNULL(SUM(${ETC_AMOUNT_EXPR}),0) AS total_amount,
            ISNULL(SUM(oi.order_count),0) AS total_qty
          FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
          INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
          INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
          LEFT JOIN SiteInfo si WITH (NOLOCK) ON o.company_Seq = si.CompayCode
          LEFT JOIN etc_copurchase_orders ecp ON o.order_seq = ecp.order_seq
          ${ETC_COUPON_DIVISOR_JOIN_D01}
          WHERE ${D01_FILTER} AND o.order_date >= @s AND o.order_date < @e AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 14, 15)
          GROUP BY ISNULL(si.SiteName, CAST(o.company_Seq AS VARCHAR)),
            CASE WHEN ecp.order_seq IS NOT NULL THEN 1 ELSE 0 END
        `),
      // 2) CARD 주문 = 같은 주문에 A01(청첩장)이 있으면 동시구매, 없으면 단독주문
      p.request()
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
        `),
      // 3) 결제대기 = status_seq=1 AND settle_date IS NULL — CARD/ETC 합산 (사이트별 분리는 생략)
      p.request()
        .input('s', sql.VarChar, startStr)
        .input('e', sql.VarChar, endStr)
        .query(`
          SELECT amount, orders, qty FROM (
            SELECT
              ISNULL(SUM(CAST(coi.item_sale_price AS float) * coi.item_count / ISNULL(NULLIF(c.Unit_Value, 0), 1)),0) AS amount,
              COUNT(DISTINCT co.order_seq) AS orders,
              ISNULL(SUM(coi.item_count),0) AS qty
            FROM custom_order co WITH (NOLOCK)
            INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
            INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
            WHERE ${D01_FILTER} AND co.order_date >= @s AND co.order_date < @e
              AND co.status_seq = 1 AND co.settle_date IS NULL
          ) AS card
          UNION ALL
          SELECT amount, orders, qty FROM (
            SELECT
              ISNULL(SUM(${ETC_AMOUNT_EXPR}),0) AS amount,
              COUNT(DISTINCT o.order_seq) AS orders,
              ISNULL(SUM(oi.order_count),0) AS qty
            FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
            INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
            INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
            LEFT JOIN SiteInfo si WITH (NOLOCK) ON o.company_Seq = si.CompayCode
            ${ETC_COUPON_DIVISOR_JOIN_D01}
            WHERE ${D01_FILTER} AND o.order_date >= @s AND o.order_date < @e
              AND o.status_seq = 1 AND o.settle_date IS NULL
          ) AS etc
        `),
    ]);
    let pendingAmount = 0, pendingOrders = 0, pendingQty = 0;
    for (const row of rPending.recordset) {
      pendingAmount += row.amount || 0;
      pendingOrders += row.orders || 0;
      pendingQty += row.qty || 0;
    }

    // 4) 사이트별 + copurchase/standalone 집계
    const siteMap = {};
    function ensureSite(sn) {
      if (!siteMap[sn]) {
        siteMap[sn] = {
          order_count: 0, total_amount: 0, total_qty: 0,
          copurchase: { amount: 0, orders: 0, qty: 0 },
          standalone: { amount: 0, orders: 0, qty: 0 },
        };
      }
      return siteMap[sn];
    }
    // 전체 합계용
    let copurchase_amount = 0, copurchase_orders = 0, copurchase_qty = 0;
    let standalone_amount = 0, standalone_orders = 0, standalone_qty = 0;

    // ETC + CARD 통합 처리 — 둘 다 is_copurchase 플래그 분기 (바른손몰도 동시구매 가능).
    const accumulateRow = (row) => {
      const sn = formatSiteName(row.site_name) || '기타';
      const site = ensureSite(sn);
      site.order_count += row.order_count || 0;
      site.total_amount += row.total_amount || 0;
      site.total_qty += row.total_qty || 0;
      const bucket = row.is_copurchase ? site.copurchase : site.standalone;
      bucket.amount += row.total_amount || 0;
      bucket.orders += row.order_count || 0;
      bucket.qty += row.total_qty || 0;
      if (row.is_copurchase) {
        copurchase_amount += row.total_amount || 0;
        copurchase_orders += row.order_count || 0;
        copurchase_qty += row.total_qty || 0;
      } else {
        standalone_amount += row.total_amount || 0;
        standalone_orders += row.order_count || 0;
        standalone_qty += row.total_qty || 0;
      }
    };
    for (const row of r.recordset) accumulateRow(row);    // ETC
    for (const row of r2.recordset) accumulateRow(row);   // CARD

    // 마켓플레이스(쿠팡/네이버) 머지 — 항상 standalone 으로 누적, site_name='쿠팡'/'네이버'.
    //   기간 차원 일관: order_date 기준 (MSSQL 와 동일하게 byPaid=false 사용).
    //   distinct order 단위 카운트: 쿠팡=(order_id, shipment_box_id) / 네이버=product_order_id.
    //   실패해도 MSSQL 결과는 유지.
    async function mergeMarketplace(siteName, listFn, getOrderKey) {
      try {
        const rows = await listFn();
        if (!rows || !rows.length) return;
        const seen = new Set();
        let amount = 0, orders = 0, qty = 0;
        for (const r of rows) {
          const k = getOrderKey(r);
          if (!seen.has(k)) { seen.add(k); orders++; }
          amount += r.item_total_price || 0;
          qty += r.item_count || 0;
        }
        if (orders === 0 && amount === 0) return;
        const site = ensureSite(siteName);
        site.order_count += orders;
        site.total_amount += amount;
        site.total_qty += qty;
        site.standalone.amount += amount;
        site.standalone.orders += orders;
        site.standalone.qty += qty;
        standalone_amount += amount;
        standalone_orders += orders;
        standalone_qty += qty;
      } catch (e) {
        console.warn(`[getPeriodTotal] ${siteName} 머지 실패 (무시):`, e.message);
      }
    }
    await mergeMarketplace(
      '쿠팡',
      () => require('./coupang/store').listCoupangOrders({ startStr, endStr, byPaid: false }),
      r => `${r.coupang_order_id}::${r.shipment_box_id}`,
    );
    await mergeMarketplace(
      '네이버',
      () => require('./naver/store').listNaverOrders({ startStr, endStr, byPaid: false }),
      r => `${r.product_order_id}`,
    );

    // 전체 합계
    let order_count = 0, total_amount = 0, total_qty = 0;
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
      pending: { amount: pendingAmount, orders: pendingOrders, qty: pendingQty },
    };
  }

  /**
   * 빠른출고 매출 집계 — 정보입력 완료 후 빠른출고 옵션 선택한 주문의 원금 매출 (Q2=b).
   * Supabase bg_order_customer_info 에서 is_express=true 인 order_id 목록을 가져와
   * MSSQL 에서 해당 주문들의 원금 매출을 합산. 기간은 order_date 기준.
   *
   * getPeriodTotal 과 동일한 구조로 사이트별·동시/단독 세분화 (Q1=a 정책 일관 적용).
   *   - 바른손카드: 동시주문(A01 청첩장 함께) / 단독주문 분리
   *   - 바른손몰  : 항상 단독주문
   *
   * @param expressInfos 호출측이 미리 fetch 한 is_express=true 고객 입력 목록 (성능 최적화).
   *                     없으면 함수 내부에서 fetch (단독 호출 시).
   * 실패해도 빈 결과 반환 (대시보드 전체 집계 멈추지 않게).
   */
  async function getExpressTotal(startStr, endStr, expressInfos) {
    const empty = { amount: 0, orders: 0, qty: 0, express_fee: 0, by_site: {},
                    copurchase: { amount: 0, orders: 0, qty: 0 },
                    standalone: { amount: 0, orders: 0, qty: 0 } };
    try {
      // 외부에서 주입받지 않았으면 한번 fetch (단독 호출 호환)
      if (!Array.isArray(expressInfos)) {
        const _bgStore = require('./barungift/store');
        expressInfos = await _bgStore.getExpressCustomerInfos();
      }
      if (!expressInfos.length) return empty;

      // CARD/ETC 분리 — ETC- 접두어로 식별
      const cardSeqs = [];
      const etcSeqs = [];
      let totalExpressFee = 0;
      expressInfos.forEach(ci => {
        const oid = String(ci.order_id || '');
        // L7: 음수/NaN 가드 — 잘못된 입력으로 매출 차감 방지
        totalExpressFee += Math.max(0, parseInt(ci.express_fee) || 0);
        if (oid.startsWith('ETC-')) {
          const seq = parseInt(oid.slice(4));
          if (seq) etcSeqs.push(seq);
        } else {
          const seq = parseInt(oid);
          if (seq) cardSeqs.push(seq);
        }
      });

      const siteMap = {};
      function ensureSite(sn) {
        if (!siteMap[sn]) {
          siteMap[sn] = {
            order_count: 0, total_amount: 0, total_qty: 0,
            copurchase: { amount: 0, orders: 0, qty: 0 },
            standalone: { amount: 0, orders: 0, qty: 0 },
          };
        }
        return siteMap[sn];
      }
      let copurchase_amount = 0, copurchase_orders = 0, copurchase_qty = 0;
      let standalone_amount = 0, standalone_orders = 0, standalone_qty = 0;

      // 1) CARD — 사이트별 + 동시/단독 분리
      if (cardSeqs.length) {
        const inList = cardSeqs.join(',');
        const rc = await p.request()
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
            WHERE ${D01_FILTER} AND co.order_seq IN (${inList})
              AND co.order_date >= @s AND co.order_date < @e
              AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5, 14)
            GROUP BY ISNULL(si.SiteName, CAST(co.company_Seq AS VARCHAR)),
              CASE WHEN cp.order_seq IS NOT NULL THEN 1 ELSE 0 END
          `);
        for (const row of rc.recordset) {
          const sn = formatSiteName(row.site_name) || '기타';
          const site = ensureSite(sn);
          site.order_count += row.order_count || 0;
          site.total_amount += row.total_amount || 0;
          site.total_qty += row.total_qty || 0;
          const bucket = row.is_copurchase ? site.copurchase : site.standalone;
          bucket.amount += row.total_amount || 0;
          bucket.orders += row.order_count || 0;
          bucket.qty += row.total_qty || 0;
          if (row.is_copurchase) {
            copurchase_amount += row.total_amount || 0;
            copurchase_orders += row.order_count || 0;
            copurchase_qty += row.total_qty || 0;
          } else {
            standalone_amount += row.total_amount || 0;
            standalone_orders += row.order_count || 0;
            standalone_qty += row.total_qty || 0;
          }
        }
      }

      // 2) ETC — 바른손몰도 청첩장+답례품 동시구매 가능 → CARD 와 동일한 copurchase CTE 적용.
      if (etcSeqs.length) {
        const inList = etcSeqs.join(',');
        const re = await p.request()
          .input('s', sql.VarChar, startStr)
          .input('e', sql.VarChar, endStr)
          .query(`
            WITH etc_copurchase_orders AS (
              SELECT DISTINCT ei2.order_seq
              FROM CUSTOM_ETC_ORDER_ITEM ei2 WITH (NOLOCK)
              INNER JOIN S2_Card c2 WITH (NOLOCK) ON ei2.card_seq = c2.Card_Seq
              WHERE c2.Card_Div = 'A01'
            )
            SELECT
              ISNULL(si.SiteName, CAST(o.company_Seq AS VARCHAR)) AS site_name,
              CASE WHEN ecp.order_seq IS NOT NULL THEN 1 ELSE 0 END AS is_copurchase,
              COUNT(DISTINCT o.order_seq) AS order_count,
              ISNULL(SUM(${ETC_AMOUNT_EXPR}),0) AS total_amount,
              ISNULL(SUM(oi.order_count),0) AS total_qty
            FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
            INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
            INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
            LEFT JOIN SiteInfo si WITH (NOLOCK) ON o.company_Seq = si.CompayCode
            LEFT JOIN etc_copurchase_orders ecp ON o.order_seq = ecp.order_seq
            ${ETC_COUPON_DIVISOR_JOIN_D01}
            WHERE ${D01_FILTER} AND o.order_seq IN (${inList})
              AND o.order_date >= @s AND o.order_date < @e
              AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 14, 15)
            GROUP BY ISNULL(si.SiteName, CAST(o.company_Seq AS VARCHAR)),
              CASE WHEN ecp.order_seq IS NOT NULL THEN 1 ELSE 0 END
          `);
        for (const row of re.recordset) {
          const sn = formatSiteName(row.site_name) || '기타';
          const site = ensureSite(sn);
          site.order_count += row.order_count || 0;
          site.total_amount += row.total_amount || 0;
          site.total_qty += row.total_qty || 0;
          const bucket = row.is_copurchase ? site.copurchase : site.standalone;
          bucket.amount += row.total_amount || 0;
          bucket.orders += row.order_count || 0;
          bucket.qty += row.total_qty || 0;
          if (row.is_copurchase) {
            copurchase_amount += row.total_amount || 0;
            copurchase_orders += row.order_count || 0;
            copurchase_qty += row.total_qty || 0;
          } else {
            standalone_amount += row.total_amount || 0;
            standalone_orders += row.order_count || 0;
            standalone_qty += row.total_qty || 0;
          }
        }
      }

      // 전체 합계
      let amount = 0, orders = 0, qty = 0;
      for (const v of Object.values(siteMap)) {
        amount += v.total_amount;
        orders += v.order_count;
        qty += v.total_qty;
      }
      return {
        amount: Math.round(amount), orders, qty,
        express_fee: totalExpressFee,
        by_site: siteMap,
        copurchase: { amount: Math.round(copurchase_amount), orders: copurchase_orders, qty: copurchase_qty },
        standalone: { amount: Math.round(standalone_amount), orders: standalone_orders, qty: standalone_qty },
      };
    } catch (e) {
      console.warn('[express] 매출 집계 실패:', e.message);
      return empty;
    }
  }

  // 빠른출고용 고객 입력 정보 — 한번만 fetch 해서 3개 기간에 재사용 (Supabase 호출 1회로 축소).
  //   기존엔 getExpressTotal 안에서 매번 fetch → 3회 중복 호출로 대시보드 로딩 지연 발생.
  let expressInfos = [];
  try {
    const _bgStore = require('./barungift/store');
    expressInfos = await _bgStore.getExpressCustomerInfos();
  } catch (e) {
    console.warn('[dashboard] expressInfos fetch 실패 (빠른출고 카드 빈 값):', e.message);
  }

  const [todayTotal, yesterdayTotal, lastWeekTotal,
         thisWeekToDateTotal, lastWeekSamePeriodTotal,
         todayExpress, yesterdayExpress, lastWeekExpress] = await Promise.all([
    getPeriodTotal(todayStr, tomorrowStr),
    getPeriodTotal(yesterdayStr, todayStr),
    getPeriodTotal(lastWeekSameDayStr, lastWeekSameDayNextStr),
    getPeriodTotal(thisWeekStartStr, tomorrowStr),
    getPeriodTotal(lastWeekStartStr, lastWeekPeriodEndExclusiveStr),
    getExpressTotal(todayStr, tomorrowStr, expressInfos),
    getExpressTotal(yesterdayStr, todayStr, expressInfos),
    getExpressTotal(lastWeekSameDayStr, lastWeekSameDayNextStr, expressInfos),
  ]);
  todayTotal.express = todayExpress;
  yesterdayTotal.express = yesterdayExpress;
  lastWeekTotal.express = lastWeekExpress;

  return {
    today: todayTotal,
    yesterday: yesterdayTotal,
    last_week_same_day: lastWeekTotal,
    this_week_to_date: thisWeekToDateTotal,
    last_week_same_period: lastWeekSamePeriodTotal,
    date: {
      today: todayStr,
      yesterday: yesterdayStr,
      last_week_same_day: lastWeekSameDayStr,
      this_week_start: thisWeekStartStr,
      last_week_start: lastWeekStartStr,
      today_dow: todayDow,
    },
  };
}

async function apiDashboardSummary(query) {
  const p = await getPool();
  const startDate = query.start_date || fmtDate(addDays(today(), -30));
  const endDate = query.end_date || fmtDate(addDays(today(), 1));

  // 두 메인 쿼리(상품×사이트×유형 매출 + 일×사이트×유형 주문건수) 는 독립 → 병렬 실행 (CodeReview-H2).
  const [result, countResult] = await Promise.all([
    p.request()
      .input('startDate', sql.VarChar, startDate)
      .input('endDate', sql.VarChar, endDate)
      .query(`
        WITH copurchase_orders AS (
          SELECT DISTINCT coi2.order_seq
          FROM custom_order_item coi2 WITH (NOLOCK)
          INNER JOIN S2_Card c2 WITH (NOLOCK) ON coi2.card_seq = c2.Card_Seq
          WHERE c2.Card_Div = 'A01'
        ),
        etc_copurchase_orders AS (
          SELECT DISTINCT ei2.order_seq
          FROM CUSTOM_ETC_ORDER_ITEM ei2 WITH (NOLOCK)
          INNER JOIN S2_Card c2 WITH (NOLOCK) ON ei2.card_seq = c2.Card_Seq
          WHERE c2.Card_Div = 'A01'
        )
        SELECT
          c.Card_Name AS card_name,
          c.Card_Code AS card_code,
          CONVERT(varchar(10), o.order_date, 120) AS order_day,
          ISNULL(si.SiteName, CAST(o.company_Seq AS VARCHAR)) AS site_name,
          CASE WHEN ecp.order_seq IS NOT NULL THEN N'동시구매' ELSE N'단독주문' END AS order_type,
          COUNT(DISTINCT o.order_seq) AS order_count,
          SUM(oi.order_count) AS total_qty,
          SUM(${ETC_AMOUNT_EXPR}) AS total_amount
        FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
        INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
        INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
        LEFT JOIN SiteInfo si WITH (NOLOCK) ON o.company_Seq = si.CompayCode
        LEFT JOIN etc_copurchase_orders ecp ON o.order_seq = ecp.order_seq
        ${ETC_COUPON_DIVISOR_JOIN_D01}
        WHERE ${D01_FILTER} AND o.order_date >= @startDate AND o.order_date < @endDate AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 14, 15)
        GROUP BY c.Card_Name, c.Card_Code, CONVERT(varchar(10), o.order_date, 120), ISNULL(si.SiteName, CAST(o.company_Seq AS VARCHAR)),
          CASE WHEN ecp.order_seq IS NOT NULL THEN N'동시구매' ELSE N'단독주문' END

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
      `),
    p.request()
      .input('startDate', sql.VarChar, startDate)
      .input('endDate', sql.VarChar, endDate)
      .query(`
        WITH copurchase_orders AS (
          SELECT DISTINCT coi2.order_seq
          FROM custom_order_item coi2 WITH (NOLOCK)
          INNER JOIN S2_Card c2 WITH (NOLOCK) ON coi2.card_seq = c2.Card_Seq
          WHERE c2.Card_Div = 'A01'
        ),
        etc_copurchase_orders AS (
          SELECT DISTINCT ei2.order_seq
          FROM CUSTOM_ETC_ORDER_ITEM ei2 WITH (NOLOCK)
          INNER JOIN S2_Card c2 WITH (NOLOCK) ON ei2.card_seq = c2.Card_Seq
          WHERE c2.Card_Div = 'A01'
        )
        SELECT
          CONVERT(varchar(10), o.order_date, 120) AS order_day,
          ISNULL(si.SiteName, CAST(o.company_Seq AS VARCHAR)) AS site_name,
          CASE WHEN ecp.order_seq IS NOT NULL THEN N'동시구매' ELSE N'단독주문' END AS order_type,
          COUNT(DISTINCT o.order_seq) AS distinct_order_count
        FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
        INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
        INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
        LEFT JOIN SiteInfo si WITH (NOLOCK) ON o.company_Seq = si.CompayCode
        LEFT JOIN etc_copurchase_orders ecp ON o.order_seq = ecp.order_seq
        WHERE ${D01_FILTER} AND o.order_date >= @startDate AND o.order_date < @endDate AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 14, 15)
        GROUP BY CONVERT(varchar(10), o.order_date, 120), ISNULL(si.SiteName, CAST(o.company_Seq AS VARCHAR)),
          CASE WHEN ecp.order_seq IS NOT NULL THEN N'동시구매' ELSE N'단독주문' END

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
      `),
  ]);

  // Clean names
  const rows = result.recordset.map(r => ({ ...r, card_name: cleanName(r.card_name), site_name: formatSiteName(r.site_name) }));

  const orderCounts = countResult.recordset.map(r => ({ ...r, site_name: formatSiteName(r.site_name) }));

  // 빠른출고 일별 매출 (정보입력 완료 + is_express=true 주문의 원금 매출).
  //   apiDashboardComparison 의 getExpressTotal 과 동일 데이터원이지만 일자 단위로 분해.
  //   실패해도 빈 배열 반환 (테이블 메인 데이터엔 영향 없음).
  let expressDaily = [];
  try {
    const _bgStore = require('./barungift/store');
    const expressInfos = await _bgStore.getExpressCustomerInfos();
    if (expressInfos && expressInfos.length) {
      const cardSeqs = [];
      const etcSeqs = [];
      expressInfos.forEach(ci => {
        const oid = String(ci.order_id || '');
        if (oid.startsWith('ETC-')) {
          const seq = parseInt(oid.slice(4));
          if (seq) etcSeqs.push(seq);
        } else {
          const seq = parseInt(oid);
          if (seq) cardSeqs.push(seq);
        }
      });
      // 빠른출고 CARD/ETC 일별 집계 — 두 쿼리 독립적이므로 병렬 실행 (CodeReview-H1 연관).
      // 동시구매(청첩장 함께 주문) / 단독주문 분리 — copurchase CTE 적용.
      const exprPromises = [];
      if (cardSeqs.length) {
        const inList = cardSeqs.join(',');
        exprPromises.push(p.request()
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
              CONVERT(varchar(10), co.order_date, 120) AS order_day,
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
            WHERE ${D01_FILTER} AND co.order_seq IN (${inList})
              AND co.order_date >= @startDate AND co.order_date < @endDate
              AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5, 14)
            GROUP BY CONVERT(varchar(10), co.order_date, 120), ISNULL(si.SiteName, CAST(co.company_Seq AS VARCHAR)),
              CASE WHEN cp.order_seq IS NOT NULL THEN 1 ELSE 0 END
          `));
      }
      if (etcSeqs.length) {
        const inList = etcSeqs.join(',');
        exprPromises.push(p.request()
          .input('startDate', sql.VarChar, startDate)
          .input('endDate', sql.VarChar, endDate)
          .query(`
            WITH etc_copurchase_orders AS (
              SELECT DISTINCT ei2.order_seq
              FROM CUSTOM_ETC_ORDER_ITEM ei2 WITH (NOLOCK)
              INNER JOIN S2_Card c2 WITH (NOLOCK) ON ei2.card_seq = c2.Card_Seq
              WHERE c2.Card_Div = 'A01'
            )
            SELECT
              CONVERT(varchar(10), o.order_date, 120) AS order_day,
              ISNULL(si.SiteName, CAST(o.company_Seq AS VARCHAR)) AS site_name,
              CASE WHEN ecp.order_seq IS NOT NULL THEN 1 ELSE 0 END AS is_copurchase,
              COUNT(DISTINCT o.order_seq) AS order_count,
              ISNULL(SUM(${ETC_AMOUNT_EXPR}),0) AS total_amount,
              ISNULL(SUM(oi.order_count),0) AS total_qty
            FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
            INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
            INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
            LEFT JOIN SiteInfo si WITH (NOLOCK) ON o.company_Seq = si.CompayCode
            LEFT JOIN etc_copurchase_orders ecp ON o.order_seq = ecp.order_seq
            ${ETC_COUPON_DIVISOR_JOIN_D01}
            WHERE ${D01_FILTER} AND o.order_seq IN (${inList})
              AND o.order_date >= @startDate AND o.order_date < @endDate
              AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 14, 15)
            GROUP BY CONVERT(varchar(10), o.order_date, 120), ISNULL(si.SiteName, CAST(o.company_Seq AS VARCHAR)),
              CASE WHEN ecp.order_seq IS NOT NULL THEN 1 ELSE 0 END
          `));
      }
      const exprResults = await Promise.all(exprPromises);
      const expressRows = exprResults.flatMap(r => r.recordset);
      expressDaily = expressRows.map(r => ({
        ...r,
        site_name: formatSiteName(r.site_name),
        total_amount: Math.round(r.total_amount || 0),
      }));
    }
  } catch (e) {
    console.warn('[summary] expressDaily 실패 (빠른출고 행 빈값):', e.message);
  }

  // 쿠팡 주문 일별 합산 — 답례품 카테고리 한정. 대시보드 사이트별 매출에 '쿠팡' 그룹 노출.
  //   apiDashboardSummary 의 summary/orderCounts 와 동일 schema 로 정규화해 push.
  try {
    const coupangStore = require('./coupang/store');
    const coupangRows = await coupangStore.listCoupangOrders({
      startStr: startDate, endStr: endDate, byPaid: false,
    });
    if (coupangRows && coupangRows.length) {
      // (order_day, product) 키로 묶어 일×상품 단위 합산 → MSSQL summary 와 동일 단위
      const byDayProduct = new Map();
      const byDayForCount = new Map();
      for (const r of coupangRows) {
        const day = String(r.ordered_at || '').slice(0, 10);
        if (!day) continue;
        const name = r.product_name || '쿠팡 답례품';
        const code = r.product_code || '';
        const key = `${day}|${code}|${name}`;
        if (!byDayProduct.has(key)) {
          byDayProduct.set(key, {
            card_name: name, card_code: code,
            order_day: day, site_name: '쿠팡',
            order_type: '단독주문',
            order_count: 0, total_qty: 0, total_amount: 0,
            _orderIds: new Set(),
          });
        }
        const bucket = byDayProduct.get(key);
        bucket.total_qty += r.item_count || 0;
        bucket.total_amount += r.item_total_price || 0;
        bucket._orderIds.add(`${r.coupang_order_id}::${r.shipment_box_id}`);
        // 일별 distinct order count
        const ck = `${day}|쿠팡|단독주문`;
        if (!byDayForCount.has(ck)) byDayForCount.set(ck, { order_day: day, site_name: '쿠팡', order_type: '단독주문', _orderIds: new Set() });
        byDayForCount.get(ck)._orderIds.add(`${r.coupang_order_id}::${r.shipment_box_id}`);
      }
      // order_count = distinct orderId|shipmentBoxId 수
      for (const v of byDayProduct.values()) {
        v.order_count = v._orderIds.size;
        delete v._orderIds;
        rows.push(v);
      }
      for (const v of byDayForCount.values()) {
        const distinct_order_count = v._orderIds.size;
        delete v._orderIds;
        orderCounts.push({ order_day: v.order_day, site_name: v.site_name, order_type: v.order_type, distinct_order_count });
      }
    }
  } catch (e) {
    console.warn('[summary] 쿠팡 주문 머지 실패 (무시):', e.message);
  }

  // 네이버 스마트스토어 일별 합산 — 쿠팡과 동일 패턴, '네이버' 사이트 그룹.
  try {
    const naverStore = require('./naver/store');
    const naverRows = await naverStore.listNaverOrders({
      startStr: startDate, endStr: endDate, byPaid: false,
    });
    if (naverRows && naverRows.length) {
      const byDayProduct = new Map();
      const byDayForCount = new Map();
      for (const r of naverRows) {
        const day = String(r.ordered_at || '').slice(0, 10);
        if (!day) continue;
        const name = r.product_name || '네이버 답례품';
        const code = r.product_code || '';
        const key = `${day}|${code}|${name}`;
        if (!byDayProduct.has(key)) {
          byDayProduct.set(key, {
            card_name: name, card_code: code,
            order_day: day, site_name: '네이버',
            order_type: '단독주문',
            order_count: 0, total_qty: 0, total_amount: 0,
            _orderIds: new Set(),
          });
        }
        const bucket = byDayProduct.get(key);
        bucket.total_qty += r.item_count || 0;
        bucket.total_amount += r.item_total_price || 0;
        bucket._orderIds.add(`${r.order_id}::${r.product_order_id}`);
        const ck = `${day}|네이버|단독주문`;
        if (!byDayForCount.has(ck)) byDayForCount.set(ck, { order_day: day, site_name: '네이버', order_type: '단독주문', _orderIds: new Set() });
        byDayForCount.get(ck)._orderIds.add(`${r.order_id}::${r.product_order_id}`);
      }
      for (const v of byDayProduct.values()) {
        v.order_count = v._orderIds.size;
        delete v._orderIds;
        rows.push(v);
      }
      for (const v of byDayForCount.values()) {
        const distinct_order_count = v._orderIds.size;
        delete v._orderIds;
        orderCounts.push({ order_day: v.order_day, site_name: v.site_name, order_type: v.order_type, distinct_order_count });
      }
    }
  } catch (e) {
    console.warn('[summary] 네이버 주문 머지 실패 (무시):', e.message);
  }

  return { summary: rows, order_counts: orderCounts, express_daily: expressDaily };
}

/**
 * 희망출고일별 매출 집계 — 정보입력 완료 + desired_ship_date 지정된 주문 한정.
 *
 * 용도: 출고 작업 일정 계획 — "5/8 에 출고할 매출 N원" 같은 미래 출고 부하 가시성.
 *
 * 데이터 흐름:
 *   1) Supabase bg_order_customer_info 에서 desired_ship_date 지정된 row 가져옴
 *   2) order_id 를 ETC/CARD 로 split → MSSQL 에서 매출/수량/사이트 lookup
 *   3) desired_ship_date 별 그룹핑 + 동시/단독 분리, 빠른출고/일반 분리
 *
 * 응답:
 *   {
 *     period: { start, end },
 *     ship_dates: [
 *       { date, amount, orders, qty,
 *         express: {amount, orders, qty}, regular: {amount, orders, qty},
 *         copurchase: {amount, orders, qty}, standalone: {amount, orders, qty} }
 *     ],
 *     total: { amount, orders, qty }
 *   }
 *
 * 기간 차원: desired_ship_date 기준 (apiDashboardSummary 의 order_date 기준과 다름).
 */
async function apiDashboardByShipDate(query) {
  const p = await getPool();
  // 기본 윈도우: 오늘 ~ 30일 후
  const startDate = query.start_date || fmtDate(today());
  const endDate = query.end_date || fmtDate(addDays(today(), 31)); // exclusive

  const empty = { period: { start: startDate, end: endDate }, ship_dates: [], total: { amount: 0, orders: 0, qty: 0 } };
  let cInfos = [];
  try {
    const _bgStore = require('./barungift/store');
    cInfos = await _bgStore.getCustomerInfosWithShipDate();
  } catch (e) {
    console.warn('[by-ship-date] customer-infos fetch 실패:', e.message);
    return { ...empty, error: 'customer_info: ' + e.message };
  }

  // 기간 필터 (JS 측, ship_date 는 'YYYY-MM-DD' 문자열)
  const inWindow = cInfos.filter(ci => {
    const d = String(ci.desired_ship_date || '').slice(0, 10);
    return d && d >= startDate && d < endDate;
  });
  if (!inWindow.length) return empty;

  // order_id → ci 매핑 (ETC-/raw 접두어 분리)
  const ciByCardSeq = new Map();   // CARD: order_seq → ci
  const ciByEtcSeq = new Map();    // ETC: order_seq → ci
  inWindow.forEach(ci => {
    const oid = String(ci.order_id || '');
    if (oid.startsWith('ETC-')) {
      const seq = parseInt(oid.slice(4));
      if (seq) ciByEtcSeq.set(seq, ci);
    } else {
      const seq = parseInt(oid);
      if (seq) ciByCardSeq.set(seq, ci);
    }
  });

  const queries = [];
  if (ciByCardSeq.size) {
    const inList = [...ciByCardSeq.keys()].join(',');
    queries.push(p.request().query(`
      WITH copurchase_orders AS (
        SELECT DISTINCT coi2.order_seq
        FROM custom_order_item coi2 WITH (NOLOCK)
        INNER JOIN S2_Card c2 WITH (NOLOCK) ON coi2.card_seq = c2.Card_Seq
        WHERE c2.Card_Div = 'A01'
      )
      SELECT
        co.order_seq,
        CASE WHEN cp.order_seq IS NOT NULL THEN 1 ELSE 0 END AS is_copurchase,
        ISNULL(SUM(CAST(coi.item_sale_price AS float) * coi.item_count / ISNULL(NULLIF(c.Unit_Value, 0), 1)), 0) AS amount,
        ISNULL(SUM(coi.item_count), 0) AS qty
      FROM custom_order co WITH (NOLOCK)
      INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
      INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
      LEFT JOIN copurchase_orders cp ON co.order_seq = cp.order_seq
      WHERE ${D01_FILTER} AND co.order_seq IN (${inList})
        AND co.status_seq >= 1 AND co.status_seq NOT IN (3, 5, 14)
      GROUP BY co.order_seq, CASE WHEN cp.order_seq IS NOT NULL THEN 1 ELSE 0 END
    `).then(r => r.recordset.map(row => ({ ...row, _src: 'CARD' }))));
  }
  if (ciByEtcSeq.size) {
    const inList = [...ciByEtcSeq.keys()].join(',');
    queries.push(p.request().query(`
      WITH etc_copurchase_orders AS (
        SELECT DISTINCT ei2.order_seq
        FROM CUSTOM_ETC_ORDER_ITEM ei2 WITH (NOLOCK)
        INNER JOIN S2_Card c2 WITH (NOLOCK) ON ei2.card_seq = c2.Card_Seq
        WHERE c2.Card_Div = 'A01'
      )
      SELECT
        o.order_seq,
        CASE WHEN ecp.order_seq IS NOT NULL THEN 1 ELSE 0 END AS is_copurchase,
        ISNULL(SUM(${ETC_AMOUNT_EXPR}), 0) AS amount,
        ISNULL(SUM(oi.order_count), 0) AS qty
      FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
      INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
      INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
      LEFT JOIN SiteInfo si WITH (NOLOCK) ON o.company_Seq = si.CompayCode
      LEFT JOIN etc_copurchase_orders ecp ON o.order_seq = ecp.order_seq
      ${ETC_COUPON_DIVISOR_JOIN_D01}
      WHERE ${D01_FILTER} AND o.order_seq IN (${inList})
        AND o.status_seq >= 1 AND o.status_seq NOT IN (3, 5, 14, 15)
      GROUP BY o.order_seq, CASE WHEN ecp.order_seq IS NOT NULL THEN 1 ELSE 0 END
    `).then(r => r.recordset.map(row => ({ ...row, _src: 'ETC' }))));
  }
  let salesRows = [];
  try {
    const results = await Promise.all(queries);
    salesRows = results.flat();
  } catch (e) {
    console.warn('[by-ship-date] MSSQL lookup 실패:', e.message);
    return { ...empty, error: 'mssql: ' + e.message };
  }

  // 출고일별 그룹핑
  const buckets = {}; // date → { amount, orders, qty, express, regular, copurchase, standalone }
  function ensureBucket(date) {
    if (!buckets[date]) {
      buckets[date] = {
        date, amount: 0, orders: 0, qty: 0,
        express: { amount: 0, orders: 0, qty: 0 },
        regular: { amount: 0, orders: 0, qty: 0 },
        copurchase: { amount: 0, orders: 0, qty: 0 },
        standalone: { amount: 0, orders: 0, qty: 0 },
      };
    }
    return buckets[date];
  }
  let totalAmount = 0, totalOrders = 0, totalQty = 0;
  salesRows.forEach(r => {
    const ci = r._src === 'ETC' ? ciByEtcSeq.get(r.order_seq) : ciByCardSeq.get(r.order_seq);
    if (!ci) return;
    const date = String(ci.desired_ship_date).slice(0, 10);
    const b = ensureBucket(date);
    const amount = Math.round(r.amount || 0);
    const qty = r.qty || 0;
    b.amount += amount; b.qty += qty; b.orders += 1;
    const expressBucket = ci.is_express ? b.express : b.regular;
    expressBucket.amount += amount; expressBucket.qty += qty; expressBucket.orders += 1;
    const cpBucket = r.is_copurchase ? b.copurchase : b.standalone;
    cpBucket.amount += amount; cpBucket.qty += qty; cpBucket.orders += 1;
    totalAmount += amount; totalOrders += 1; totalQty += qty;
  });

  const ship_dates = Object.values(buckets).sort((a, b) => a.date.localeCompare(b.date));
  return {
    period: { start: startDate, end: endDate },
    ship_dates,
    total: { amount: totalAmount, orders: totalOrders, qty: totalQty },
    diag: {
      customer_info_total: cInfos.length,
      customer_info_in_window: inWindow.length,
      sql_card_orders: ciByCardSeq.size,
      sql_etc_orders: ciByEtcSeq.size,
      sql_matched_rows: salesRows.length,
    },
  };
}

/**
 * 빠른출고 추가 분석 — 채택율(전환율) + 시간대/요일 분포 + 누적 추가비용.
 *
 * 데이터원: Supabase bg_order_customer_info (정보입력 완료 데이터)
 *   - 분모: submitted_at 이 조회 기간 내 인 모든 row (정보입력 완료 건수)
 *   - 분자: 그 중 is_express=true 인 row
 *   - 시간대/요일: submitted_at timestamp 의 시(0-23) / 요일(0=일~6=토)
 *
 * 기간 차원이 다른 endpoint(apiDashboardSummary 는 order_date 기준)와 다름:
 *   '조회 기간 내 정보입력을 완료한 고객 중 빠른출고 비율' 측정이 목표.
 *   UI 에서 명시 필요.
 */
async function apiExpressAnalysis(query) {
  const startDate = query.start_date || fmtDate(addDays(today(), -30));
  const endDate = query.end_date || fmtDate(addDays(today(), 1));
  const empty = {
    period: { start: startDate, end: endDate },
    total_info_completed: 0,
    total_express: 0,
    adoption_rate: 0,
    total_express_fee: 0,
    avg_express_fee: 0,
    by_hour: Array.from({length:24}, (_, h) => ({ hour: h, total: 0, express: 0, adoption: 0 })),
    by_dow:  Array.from({length:7},  (_, d) => ({ dow: d,  total: 0, express: 0, adoption: 0 })),
  };

  try {
    const _bgStore = require('./barungift/store');
    const allInfos = await _bgStore.getAllCustomerInfos();
    if (!Array.isArray(allInfos) || !allInfos.length) return empty;

    // submitted_at 기준 기간 필터.
    //   endDate 는 dashboard 컨벤션상 exclusive (next day) 가 아닌 day boundary 일 수 있어
    //   안전하게 'YYYY-MM-DD' 비교 (lex order — submitted_at 이 ISO timestamp 라 prefix 비교 정상)
    const inRange = allInfos.filter(ci => {
      if (!ci.submitted_at) return false;
      const day = String(ci.submitted_at).slice(0, 10);
      return day >= startDate && day <= endDate;
    });

    const total = inRange.length;
    const expressInfos = inRange.filter(ci => ci.is_express);
    const expressCount = expressInfos.length;
    // L7: 음수/NaN 가드 — 잘못된 입력으로 매출 차감 방지
    const totalExpressFee = expressInfos.reduce((s, ci) => s + Math.max(0, parseInt(ci.express_fee) || 0), 0);
    const adoptionRate = total > 0 ? (expressCount / total * 100) : 0;
    const avgExpressFee = expressCount > 0 ? Math.round(totalExpressFee / expressCount) : 0;

    // 시간대 분포 (submitted_at 의 시간대)
    const byHour = Array.from({length:24}, (_, h) => ({ hour: h, total: 0, express: 0, adoption: 0 }));
    const byDow  = Array.from({length:7},  (_, d) => ({ dow: d,  total: 0, express: 0, adoption: 0 }));
    inRange.forEach(ci => {
      const dt = new Date(ci.submitted_at);
      if (isNaN(dt.getTime())) return;
      const h = dt.getHours();
      const d = dt.getDay();
      if (h >= 0 && h <= 23) {
        byHour[h].total++;
        if (ci.is_express) byHour[h].express++;
      }
      if (d >= 0 && d <= 6) {
        byDow[d].total++;
        if (ci.is_express) byDow[d].express++;
      }
    });
    byHour.forEach(b => { b.adoption = b.total > 0 ? Math.round(b.express / b.total * 1000) / 10 : 0; });
    byDow.forEach(b  => { b.adoption = b.total > 0 ? Math.round(b.express / b.total * 1000) / 10 : 0; });

    return {
      period: { start: startDate, end: endDate },
      total_info_completed: total,
      total_express: expressCount,
      adoption_rate: Math.round(adoptionRate * 10) / 10,
      total_express_fee: totalExpressFee,
      avg_express_fee: avgExpressFee,
      by_hour: byHour,
      by_dow: byDow,
    };
  } catch (e) {
    console.error('[express-analysis] 실패:', e.message);
    return { ...empty, error: e.message };
  }
}

async function apiForecast() {
  const p = await getPool();
  const todayStr = fmtDate(today());

  const todayDate = today();
  const dayOfWeek = todayDate.getDay();
  const thisSunday = addDays(todayDate, -dayOfWeek);

  // 예식 윈도우 (본주 기준 비대칭 4주 = 28일):
  //   PAST  = 14일 (본주 시작 이전 2주)
  //   FUTURE= 7일  (본주 종료 이후 1주)
  //   예) 본주 4/26(일)~5/2(토) → 윈도우 4/12(일)~5/9(토)
  //   답례품은 예식 전 주문이 대부분이라 미래쪽은 1주만 보고, 과거쪽은 2주까지 봐서
  //   예식 후 늦은 주문(post-wedding) 도 일부 반영. 기존 ±14일 대칭 모델에서 변경.
  const PAST_WINDOW = 14;
  const FUTURE_WINDOW = 7;
  const BASE_WEEKS = 4; // 이동평균 기준: 최근 완료 4주

  // 1) 예식일별 건수 — 통합회원(S2_UserInfo) 의 wedd_year/wedd_month/wedd_day 기준
  //    가입사이트(REFERER_SALES_GUBUN) 무관, 청첩장 주문 여부 무관 — 회원이 입력한 예식일
  //    이면 모두 카운트. site_div='SB' 로 통합회원 중복 제거 (한 uid 당 SB/SS/BM 3행 존재).
  //    이전 모델(custom_order_WeddInfo) 은 청첩장 주문 있는 사람만 잡혀서 '단독 답례품'
  //    구매자의 결혼식이 분모에서 누락 → 전환율 과대 평가 → 회원정보 기반으로 전환.
  //    DB 조회 범위 — 윈도우 양 끝 (가장 보수적인 PAST 사용)
  const weddStart = fmtDate(addDays(thisSunday, -7 * 8 - PAST_WINDOW));
  const weddEnd = fmtDate(addDays(thisSunday, 7 * 12 + 7 + FUTURE_WINDOW));

  const weddingsByDate = await p.request()
    .input('ws', sql.VarChar, weddStart)
    .input('we', sql.VarChar, weddEnd)
    .query(`
      SELECT wedd_date, COUNT(*) AS wedding_count
      FROM (
        SELECT DISTINCT u.uid,
          CONVERT(varchar(10), TRY_CAST(u.wedd_year+'-'+RIGHT('0'+u.wedd_month,2)+'-'+RIGHT('0'+u.wedd_day,2) AS date), 120) AS wedd_date
        FROM S2_UserInfo u WITH (NOLOCK)
        WHERE u.site_div = 'SB'
          AND u.USE_YORN = 'Y'  -- H4 fix: 탈퇴 회원 제외 (활성 회원만 분모에 포함)
          AND u.wedd_year IS NOT NULL AND LEN(u.wedd_year) = 4
          AND TRY_CAST(u.wedd_year+'-'+RIGHT('0'+u.wedd_month,2)+'-'+RIGHT('0'+u.wedd_day,2) AS date) >= @ws
          AND TRY_CAST(u.wedd_year+'-'+RIGHT('0'+u.wedd_month,2)+'-'+RIGHT('0'+u.wedd_day,2) AS date) < @we
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

    // 예식 윈도우: [weekStart - 14일, weekEnd + 7일] = 28일 비대칭 윈도우
    //   d 범위: -14 ~ 13 (= 6 + 7) 포함, 총 28일
    let weddingPool = 0;
    for (let d = -PAST_WINDOW; d <= 6 + FUTURE_WINDOW; d++) {
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
        -- ETC: 동시구매(청첩장+답례품) 주문에서 답례품(D01) 매출만 추출.
        --   이전엔 o.settle_price (주문 전체 결제금액) 를 그대로 사용해 청첩장 매출까지
        --   forecast actual_weekly_revenue 에 포함되는 버그 (H2). ETC_AMOUNT_EXPR 와 동일
        --   산식의 D01 한정 서브쿼리로 교체.
        --   F1 fix: 쿠폰 차감을 SUM() 안에서 빼서 N개 아이템에 N회 차감되던 H1-pattern 제거.
        --   SUM(gross) 밖에서 coupon 1회만 차감 → 주문당 실제 결제액에 정확히 일치.
        SELECT DISTINCT o.order_seq, CONVERT(varchar(10), o.order_date, 120) AS order_day,
          (SELECT ISNULL(SUM(
            CASE
              WHEN si2.SiteName IS NULL
              THEN CAST(oi2.card_sale_price AS float) * oi2.order_count / ISNULL(NULLIF(c2.Unit_Value, 0), 1)
              ELSE CAST(oi2.card_sale_price AS float)
            END
          ), 0) - ISNULL(o.coupon_price, 0)
          FROM CUSTOM_ETC_ORDER_ITEM oi2 WITH (NOLOCK)
          INNER JOIN S2_Card c2 WITH (NOLOCK) ON oi2.card_seq = c2.Card_Seq
          LEFT JOIN SiteInfo si2 WITH (NOLOCK) ON o.company_Seq = si2.CompayCode
          WHERE oi2.order_seq = o.order_seq AND ${D01_FILTER.replace(/c\./g, 'c2.')}
          ) AS settle_price,
          (SELECT SUM(oi2.order_count) FROM CUSTOM_ETC_ORDER_ITEM oi2 WITH (NOLOCK) INNER JOIN S2_Card c2 WITH (NOLOCK) ON oi2.card_seq=c2.Card_Seq WHERE oi2.order_seq=o.order_seq AND ${D01_FILTER.replace(/c\./g,'c2.')}) AS total_qty
        FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
        INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
        INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
        WHERE ${D01_FILTER} AND o.order_date >= @awStart AND o.order_date < @awEnd AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 14, 15)
      ) t GROUP BY order_day

      UNION ALL

      SELECT order_day, COUNT(*) AS order_count, SUM(settle_price) AS total_amount, SUM(total_qty) AS total_qty
      FROM (
        -- CARD: 이전부터 D01 한정 서브쿼리 사용 — 정상 동작.
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

  // 이동평균에 실제 사용된 기간 (일-토 기준) — 프론트엔드에서 카드/툴팁에 명시 노출
  const basePeriodStart = baseWeeks.length ? baseWeeks[0].week_start : null;       // 가장 오래된 주의 일요일
  const basePeriodEnd   = baseWeeks.length ? baseWeeks[baseWeeks.length - 1].week_end : null; // 가장 최근 주의 토요일
  const basePeriodLabel = (basePeriodStart && basePeriodEnd)
    ? (() => {
        // 'M/D ~ M/D' 형식 (일-토 기준임을 명시)
        const fmtMD = (s) => { const [y,m,d] = s.split('-'); return `${parseInt(m)}/${parseInt(d)}`; };
        return `${fmtMD(basePeriodStart)} ~ ${fmtMD(basePeriodEnd)}`;
      })()
    : null;

  return {
    model: {
      type: 'weighted_moving_average',
      window_past_days: PAST_WINDOW,    // 본주 시작 이전 윈도우 (일)
      window_future_days: FUTURE_WINDOW, // 본주 종료 이후 윈도우 (일)
      window_total_days: PAST_WINDOW + 7 + FUTURE_WINDOW, // 28
      base_weeks: BASE_WEEKS,
      conversion_rate: Math.round(conversionRate * 10000) / 100, // % 단위 (소수점 2자리)
      avg_order_value: Math.round(avgOrderValue),
      base_active_weeks: baseWeeks.length,
      base_week_labels: baseWeeks.map(w => w.week_no + '주차'),
      base_period_start: basePeriodStart,    // 'YYYY-MM-DD' (일요일)
      base_period_end:   basePeriodEnd,      // 'YYYY-MM-DD' (토요일)
      base_period_label: basePeriodLabel,    // 'M/D ~ M/D' (한글 카드 표기용)
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
  // 실패시 프론트가 'undefined일' 안 뜨도록 number 0 으로 폴백 (renderLeadtime 가 typeof === 'number' 체크).
  const FALLBACK = { avg_days: null, median_days: null, total_samples: 0, distribution: {}, error: null };
  let p;
  try {
    p = await getPool();
  } catch (e) {
    console.error('[leadtime] getPool 실패:', e.message);
    return { ...FALLBACK, error: 'pool: ' + e.message };
  }

  // partial 로딩 — 큰 단일 쿼리(CROSS APPLY) 대신 작은 쿼리 여러개로 분리해 timeout 위험 감소.
  //   1) ETC 주문 목록 (order_seq, member_id, order_date)
  //   2) 위 member_id 들의 최신 청첩장 정보 (chunk 단위로 IN-list)
  //   3) CARD 주문 + 청첩장 (단일 쿼리 — PK JOIN 으로 빠름)
  //   4) JS 에서 join → lead_days 계산
  // 윈도우는 90일 (기존 180일 → 데이터 부담 절반)
  const WINDOW_DAYS = 90;
  const allRows = []; // { order_key, order_date, wedding_date, lead_days }
  const t0 = Date.now();

  try {
    // === Step 1: ETC 주문 목록 + member_id ===
    const etcOrdersRes = await p.request().query(`
      SELECT DISTINCT o.order_seq, o.member_id, CONVERT(varchar(10), o.order_date, 120) AS order_date
      FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
      INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
      INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
      WHERE ${D01_FILTER} AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 14, 15)
        AND o.member_id IS NOT NULL
        AND o.order_date >= DATEADD(day, -${WINDOW_DAYS}, GETDATE())
    `);
    const etcOrders = etcOrdersRes.recordset;
    const memberIds = [...new Set(etcOrders.map(r => r.member_id).filter(Boolean))];

    // === Step 2: member_id chunk 단위로 청첩장 후보 lookup ===
    //   이전: ROW_NUMBER로 회원당 최신 청첩장 1건만 선택 → 옛날 결혼식이 매칭돼 lead_days 음수
    //         (예식후 주문) 비중이 과대 평가되는 데이터 정합성 문제 발생.
    //   수정: 회원당 모든 청첩장 후보를 수집 → Step 3 JS 에서 주문일 기준 최적 매칭.
    const CHUNK = 500;
    const memberWeddingsMap = new Map(); // member_id → Array<Date> (해당 회원의 모든 결혼식 후보)
    for (let i = 0; i < memberIds.length; i += CHUNK) {
      const chunk = memberIds.slice(i, i + CHUNK);
      const req = p.request();
      const placeholders = chunk.map((_, idx) => {
        const name = `m${idx}`;
        req.input(name, sql.VarChar, String(chunk[idx]));
        return `@${name}`;
      }).join(',');
      const r = await req.query(`
        SELECT DISTINCT
          co2.member_id,
          TRY_CAST(w2.event_year+'-'+RIGHT('0'+w2.event_month,2)+'-'+RIGHT('0'+w2.event_Day,2) AS date) AS wedding_date
        FROM custom_order co2 WITH (NOLOCK)
        INNER JOIN custom_order_WeddInfo w2 WITH (NOLOCK) ON co2.order_seq = w2.order_seq
        WHERE co2.member_id IN (${placeholders})
          AND co2.status_seq >= 1
          AND w2.event_year IS NOT NULL AND LEN(w2.event_year) = 4
          AND TRY_CAST(w2.event_year+'-'+RIGHT('0'+w2.event_month,2)+'-'+RIGHT('0'+w2.event_Day,2) AS date) IS NOT NULL
      `);
      r.recordset.forEach(row => {
        const arr = memberWeddingsMap.get(row.member_id) || [];
        arr.push(row.wedding_date);
        memberWeddingsMap.set(row.member_id, arr);
      });
    }

    // === Step 3: ETC 주문에 wedding_date join → lead_days 계산 ===
    //   매칭 정책: 주문일 이후의 결혼식 중 가장 가까운 것을 선택 (정상 답례품 패턴).
    //   주문일 이후 결혼식이 없으면 -14일 이내 과거 결혼식 허용 (늦은 답례품 케이스).
    //   둘 다 없으면 skip — 옛날 결혼식 매칭으로 인한 노이즈 제거.
    const POST_WEDDING_GRACE_DAYS = 14;
    for (const o of etcOrders) {
      const candidates = memberWeddingsMap.get(o.member_id);
      if (!candidates || !candidates.length) continue;
      const orderDt = new Date(o.order_date);
      // 후보별 lead_days 계산 후 정책에 맞는 최적 매칭 picking
      const ranked = candidates.map(wd => {
        const weddingDt = new Date(wd);
        return { wd, leadDays: Math.round((weddingDt - orderDt) / 86400000) };
      });
      // 우선순위: lead_days >= 0 (미래 결혼식) 중 가장 작은 값 → 없으면 -14 ~ -1 중 가장 큰 값
      const future = ranked.filter(c => c.leadDays >= 0).sort((a, b) => a.leadDays - b.leadDays);
      const recentPast = ranked.filter(c => c.leadDays < 0 && c.leadDays >= -POST_WEDDING_GRACE_DAYS)
        .sort((a, b) => b.leadDays - a.leadDays);
      const picked = future[0] || recentPast[0];
      if (!picked) continue;
      allRows.push({
        order_key: 'E' + o.order_seq,
        order_date: o.order_date,
        wedding_date: picked.wd,
        lead_days: picked.leadDays,
      });
    }

    // === Step 4: CARD 주문 + 청첩장 (PK JOIN — 빠름) ===
    const cardRes = await p.request().query(`
      SELECT DISTINCT
        CONCAT('C', co.order_seq) AS order_key,
        CONVERT(varchar(10), co.order_date, 120) AS order_date,
        TRY_CAST(w.event_year+'-'+RIGHT('0'+w.event_month,2)+'-'+RIGHT('0'+w.event_Day,2) AS date) AS wedding_date,
        DATEDIFF(day, co.order_date, TRY_CAST(w.event_year+'-'+RIGHT('0'+w.event_month,2)+'-'+RIGHT('0'+w.event_Day,2) AS date)) AS lead_days
      FROM custom_order co WITH (NOLOCK)
      INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
      INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
      INNER JOIN custom_order_WeddInfo w WITH (NOLOCK) ON co.order_seq = w.order_seq
      WHERE ${D01_FILTER} AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5, 14)
        AND w.event_year IS NOT NULL AND LEN(w.event_year) = 4
        AND TRY_CAST(w.event_year+'-'+RIGHT('0'+w.event_month,2)+'-'+RIGHT('0'+w.event_Day,2) AS date) IS NOT NULL
        AND co.order_date >= DATEADD(day, -${WINDOW_DAYS}, GETDATE())
    `);
    cardRes.recordset.forEach(r => allRows.push(r));
    console.log(`[leadtime] partial 로드 완료 — ETC ${etcOrders.length} (members ${memberIds.length}) + CARD ${cardRes.recordset.length} = ${allRows.length}건, ${Date.now()-t0}ms`);
  } catch (e) {
    console.error('[leadtime] SQL 실패:', e.message);
    return { ...FALLBACK, error: 'sql: ' + e.message };
  }

  const allDays = allRows.map(r => r.lead_days).filter(d => d !== null && d > -365 && d < 365);
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
          AND u.USE_YORN = 'Y'  -- H4 fix: 탈퇴 회원 제외 (활성 회원만 분모에 포함)
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
      ${ETC_COUPON_DIVISOR_JOIN_D01}
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
      ${ETC_COUPON_DIVISOR_JOIN_D01}
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
  const session = await getSession(cookies.session);
  const cookiePath = BASE_PATH || '/';

  if (pathname === '/auth/google' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { credential } = JSON.parse(body);
        const payload = await verifyGoogleToken(credential);
        const signedId = await createSession({ email: payload.email, name: payload.name, picture: payload.picture });
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
    await destroySession(cookies.session);
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
      // L5: status 3/5 제외를 SQL WHERE 로 푸시 — 네트워크/메모리 절약.
      const data = await apiOrders({ ...parsed.query, exclude_status_seq: '3,5' });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
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
      } else if (pathname === '/api/dashboard/express-analysis') {
        data = await apiExpressAnalysis(parsed.query);
      } else if (pathname === '/api/dashboard/by-ship-date') {
        data = await apiDashboardByShipDate(parsed.query);
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
        logAdminAccess(session, req, 'debug-order', { order_seq: seq });
        if (seq) {
          const pp = await getPool();
          const etc = await pp.request().input('seq', sql.Int, seq).query(`
            SELECT o.*, oi.card_sale_price, oi.order_count, oi.card_seq,
              c.Card_Name, c.Card_Code, c.Card_Div,
              ISNULL(si.SiteName, CAST(o.company_Seq AS VARCHAR)) AS site_name
            FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
            INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
            INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
            LEFT JOIN SiteInfo si WITH (NOLOCK) ON o.company_Seq = si.CompayCode
            WHERE o.order_seq = @seq
          `);
          const card = await pp.request().input('seq', sql.Int, seq).query(`
            SELECT co.order_seq, co.order_date, co.settle_price, co.company_Seq, co.status_seq,
              coi.item_sale_price, coi.item_count, coi.card_seq,
              c.Card_Name, c.Card_Code, c.Card_Div,
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
      } else if (pathname === '/api/debug-login-match') {
        // 로그인 주문조회 매칭 진단 — uid + order_seq 비교, 매칭 시뮬레이션.
        // URL: /api/debug-login-match?uid=sweetloves20&order_seq=3244813
        const dbgUid = (parsed.query.uid || '').trim();
        const dbgSeq = parseInt(parsed.query.order_seq);
        logAdminAccess(session, req, 'debug-login-match', { uid: dbgUid, order_seq: dbgSeq });
        if (!dbgUid || !dbgSeq) {
          data = { error: 'uid + order_seq 둘 다 필요. 예: /api/debug-login-match?uid=sweetloves20&order_seq=3244813' };
        } else {
          const pp = await getPool();
          // [1] S2_UserInfo
          const userInfo = await pp.request().input('uid', sql.VarChar, dbgUid).query(`
            SELECT uid, uname, hand_phone1, hand_phone2, hand_phone3, USE_YORN, site_div
            FROM S2_UserInfo WITH (NOLOCK)
            WHERE uid = @uid
          `);
          // [2] 두 테이블 각각 시도 (해당 테이블에서만 결과 나옴)
          const etcOrder = await pp.request().input('seq', sql.Int, dbgSeq).query(`
            SELECT o.order_seq, o.member_id, o.order_name, o.order_hphone,
              REPLACE(REPLACE(o.order_hphone, '-', ''), ' ', '') AS phone_normalized,
              o.order_date, o.status_seq, o.company_Seq,
              ISNULL(si.SiteName, CAST(o.company_Seq AS VARCHAR)) AS site_name
            FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
            LEFT JOIN SiteInfo si WITH (NOLOCK) ON o.company_Seq = si.CompayCode
            WHERE o.order_seq = @seq
          `);
          // ETC 주문의 상품 카테고리 (Card_Div 별로 답례품/꽃다발/etc)
          const etcItems = await pp.request().input('seq', sql.Int, dbgSeq).query(`
            SELECT c.Card_Div, c.Card_Code, c.Card_Name, ei.order_count
            FROM CUSTOM_ETC_ORDER_ITEM ei WITH (NOLOCK)
            INNER JOIN S2_Card c WITH (NOLOCK) ON ei.card_seq = c.Card_Seq
            WHERE ei.order_seq = @seq
          `);
          const cardOrder = await pp.request().input('seq', sql.Int, dbgSeq).query(`
            SELECT co.order_seq, co.member_id, co.order_name, co.order_hphone,
              REPLACE(REPLACE(co.order_hphone, '-', ''), ' ', '') AS phone_normalized,
              co.order_date, co.status_seq, co.settle_status, co.company_Seq,
              ISNULL(si.SiteName, CAST(co.company_Seq AS VARCHAR)) AS site_name
            FROM custom_order co WITH (NOLOCK)
            LEFT JOIN SiteInfo si WITH (NOLOCK) ON co.company_Seq = si.CompayCode
            WHERE co.order_seq = @seq
          `);
          // CARD 주문의 상품 카테고리
          const cardItems = await pp.request().input('seq', sql.Int, dbgSeq).query(`
            SELECT c.Card_Div, c.Card_Code, c.Card_Name, coi.item_count
            FROM custom_order_item coi WITH (NOLOCK)
            INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
            WHERE coi.order_seq = @seq
          `);

          // [3] 매칭 시뮬레이션 (현재 fix 적용된 로직)
          let matchVerdict = null;
          const userRow = userInfo.recordset[0];
          const orderRow = etcOrder.recordset[0] || cardOrder.recordset[0];
          if (userRow && orderRow) {
            const userPhoneFull = ((userRow.hand_phone1 || '') + (userRow.hand_phone2 || '') + (userRow.hand_phone3 || '')).replace(/\D/g, '');
            const userPhone8 = userPhoneFull.slice(-8);
            const userUname = String(userRow.uname || '').trim();
            const orderName = String(orderRow.order_name || '').trim();
            const orderPhoneNorm = String(orderRow.phone_normalized || '');
            const orderMemberId = String(orderRow.member_id || '').trim();
            // 매칭 조건들 평가
            const memberIdMatch = orderMemberId && (orderMemberId === dbgUid);
            const phoneLikeMatch = userPhone8 && orderPhoneNorm.endsWith(userPhone8);
            const nameStripMatch = userUname.replace(/\s+/g, '') === orderName.replace(/\s+/g, '');
            const phoneNameMatch = phoneLikeMatch && nameStripMatch;
            const wouldMatch = memberIdMatch || phoneNameMatch;
            matchVerdict = {
              would_match: wouldMatch,
              member_id_match: memberIdMatch,
              phone_match: phoneLikeMatch,
              name_match: nameStripMatch,
              user_phone_8_digits: userPhone8,
              user_uname_stripped: userUname.replace(/\s+/g, ''),
              order_phone_normalized: orderPhoneNorm,
              order_name_stripped: orderName.replace(/\s+/g, ''),
              order_member_id: orderMemberId || '(NULL/empty)',
              dbg_uid: dbgUid,
            };
          }

          // 답례품(D01) 매칭 여부 판별 — 답례품 admin 검색은 D01 만 노출
          const allItems = [...etcItems.recordset, ...cardItems.recordset];
          const hasD01 = allItems.some(it => it.Card_Div === 'D01');
          const itemDivs = [...new Set(allItems.map(it => it.Card_Div).filter(Boolean))];
          const categoryHint = hasD01
            ? '✅ 답례품(D01) 항목 있음 — 답례품 입력화면에 노출 가능'
            : `❌ 답례품(D01) 항목 없음 (실제 카테고리: ${itemDivs.join(', ') || '없음'}) — 답례품 화면에선 안 보임. 다른 카테고리(꽃다발 D02 등) 화면 확인 필요.`;

          // === 실제 SQL 실행 검증 ===
          //   현재 배포된 검색 SQL 의 핵심 WHERE 절을 그대로 실행해서
          //   '시뮬레이션 매칭' vs '실제 SQL 결과' 일치 여부 확인.
          let actualSqlResult = null;
          if (userRow) {
            try {
              const userPhoneFull = ((userRow.hand_phone1 || '') + (userRow.hand_phone2 || '') + (userRow.hand_phone3 || '')).replace(/\D/g, '');
              const userPhone8 = userPhoneFull.slice(-8);
              const NORM_PHONE = "REPLACE(REPLACE(co.order_hphone, '-', ''), ' ', '')";
              const NORM_DB_NAME = "REPLACE(LTRIM(RTRIM(co.order_name)), ' ', '')";
              const NORM_PARAM_NAME = "REPLACE(LTRIM(RTRIM(@uname)), ' ', '')";
              const sqlExec = await pp.request()
                .input('phone', sql.VarChar, userPhone8)
                .input('uname', sql.VarChar, String(userRow.uname || ''))
                .input('memberId', sql.VarChar, dbgUid)
                .input('seq', sql.Int, dbgSeq)
                .query(`
                  SELECT 'CARD' AS source, co.order_seq, co.member_id, co.order_name, co.order_hphone,
                    co.status_seq, c.Card_Div, c.Card_Code
                  FROM custom_order co WITH (NOLOCK)
                  INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
                  INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
                  WHERE co.order_seq = @seq
                    AND co.status_seq >= 1
                    AND co.order_date >= DATEADD(month, -6, GETDATE())
                    AND c.Card_Div = 'D01'
                    AND (LTRIM(RTRIM(co.member_id)) = LTRIM(RTRIM(@memberId))
                         OR (${NORM_PHONE} LIKE '%' + @phone AND ${NORM_DB_NAME} = ${NORM_PARAM_NAME}))

                  UNION ALL

                  SELECT 'ETC' AS source, co.order_seq, co.member_id, co.order_name, co.order_hphone,
                    co.status_seq, c.Card_Div, c.Card_Code
                  FROM CUSTOM_ETC_ORDER co WITH (NOLOCK)
                  INNER JOIN CUSTOM_ETC_ORDER_ITEM ei WITH (NOLOCK) ON co.order_seq = ei.order_seq
                  INNER JOIN S2_Card c WITH (NOLOCK) ON ei.card_seq = c.Card_Seq
                  WHERE co.order_seq = @seq
                    AND co.status_seq >= 1
                    AND co.order_date >= DATEADD(month, -6, GETDATE())
                    AND c.Card_Div = 'D01'
                    AND (LTRIM(RTRIM(co.member_id)) = LTRIM(RTRIM(@memberId))
                         OR (${NORM_PHONE} LIKE '%' + @phone AND ${NORM_DB_NAME} = ${NORM_PARAM_NAME}))
                `);
              actualSqlResult = {
                rows_returned: sqlExec.recordset.length,
                rows: sqlExec.recordset,
                interpretation: sqlExec.recordset.length > 0
                  ? '✅ 실제 SQL 도 매칭 — 로그인 시 정상 노출됩니다. 고객에게 재시도 안내.'
                  : '❌ 실제 SQL 매칭 실패 — 시뮬레이션과 차이 있음, 추가 조사 필요.',
              };
            } catch (e) {
              actualSqlResult = { error: e.message };
            }
          }

          data = {
            user_info: userInfo.recordset,
            etc_order: etcOrder.recordset,
            etc_items: etcItems.recordset,
            card_order: cardOrder.recordset,
            card_items: cardItems.recordset,
            match_simulation: matchVerdict,
            category_check: { has_D01: hasD01, item_divs: itemDivs, hint: categoryHint },
            actual_sql_result: actualSqlResult,
          };
        }
      } else if (pathname === '/api/coupang/sync' && req.method === 'POST') {
        // 쿠팡 주문 수동 동기화 trigger — Wing API → Supabase upsert.
        //   body: { days_back: 7, status: 'ACCEPT' } (옵션, 기본 7일/전체상태)
        logAdminAccess(session, req, 'coupang-sync', {});
        const body = await new Promise((resolve) => {
          let raw = ''; req.on('data', c => raw += c);
          req.on('end', () => {
            try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
          });
        });
        const coupangSync = require('./coupang/sync');
        data = await coupangSync.syncRecent({
          daysBack: parseInt(body.days_back) || 7,
          status: body.status || undefined,
        });
      } else if (pathname === '/api/coupang/debug-raw') {
        // 쿠팡 API raw 응답 직접 확인 — 단일 상태/기간으로 호출 후 응답 그대로 반환.
        // URL: /api/coupang/debug-raw?status=DEPARTURE&days_back=30
        logAdminAccess(session, req, 'coupang-debug-raw', parsed.query);
        const coupangApi = require('./coupang/api');
        if (!coupangApi.isConfigured()) {
          data = { error: 'Coupang API 키 미설정' };
        } else {
          const status = parsed.query.status || 'DEPARTURE';
          const daysBack = parseInt(parsed.query.days_back) || 30;
          const endMs = Date.now();
          const startMs = endMs - daysBack * 86400000;
          try {
            const res = await coupangApi.listOrders({ startMs, endMs, status, maxPerPage: 5 });
            // 응답 구조 진단 — 어떤 필드가 있는지 보기 위해 keys + 샘플 1개만 노출
            const keys = res && typeof res === 'object' ? Object.keys(res) : [];
            const dataArr = Array.isArray(res?.data) ? res.data : null;
            data = {
              query: {
                status, days_back: daysBack,
                start_kst: coupangApi.fmtKstDate ? coupangApi.fmtKstDate(startMs) : new Date(startMs).toISOString().slice(0, 10),
                end_kst: coupangApi.fmtKstDate ? coupangApi.fmtKstDate(endMs) : new Date(endMs).toISOString().slice(0, 10),
                vendor_id: coupangApi.VENDOR_ID,
              },
              response_top_keys: keys,
              response_code: res?.code,
              response_message: res?.message,
              has_next_token: !!res?.nextToken,
              data_is_array: Array.isArray(res?.data),
              data_length: dataArr ? dataArr.length : null,
              first_data_item: dataArr && dataArr.length > 0 ? dataArr[0] : null,
              raw_response: res, // 전체 raw — 큰 경우 frontend 가 truncate
            };
          } catch (e) {
            data = { error: e.message, vendor_id: coupangApi.VENDOR_ID };
          }
        }
      } else if (pathname === '/api/coupang/sync-state') {
        // 마지막 동기화 메타 조회 (관리자 UI 표시용)
        const coupangStore = require('./coupang/store');
        data = await coupangStore.getSyncState();
      } else if (pathname === '/api/naver/sync' && req.method === 'POST') {
        // 네이버 스마트스토어 수동 동기화 — 커머스 API → Supabase upsert
        logAdminAccess(session, req, 'naver-sync', {});
        const body = await new Promise((resolve) => {
          let raw = ''; req.on('data', c => raw += c);
          req.on('end', () => {
            try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
          });
        });
        const naverSync = require('./naver/sync');
        data = await naverSync.syncRecent({
          daysBack: parseInt(body.days_back) || 7,
        });
      } else if (pathname === '/api/naver/sync-state') {
        const naverStore = require('./naver/store');
        data = await naverStore.getSyncState();
      } else if (pathname === '/api/naver/debug-auth') {
        // 인증 서명 페이로드 진단 — 토큰 요청 직전에 보내는 값 노출.
        //   secret 형식, message, signature 인코딩 등 확인용. 토큰 발급도 실제 시도.
        logAdminAccess(session, req, 'naver-debug-auth', {});
        const naverApi = require('./naver/api');
        if (!naverApi.isConfigured()) {
          data = { error: 'Naver API 키 미설정' };
        } else {
          try {
            const token = await naverApi.getAccessToken();
            data = {
              status: 'success',
              token_first_8: token ? String(token).slice(0, 8) + '...' : null,
              token_length: token ? token.length : 0,
              hint: '토큰 발급 성공 — 정상 동작 중.',
            };
          } catch (e) {
            data = {
              status: 'error',
              error: e.message,
              client_id: naverApi.CLIENT_ID,
              hint: 'getAccessToken 실패. 에러 메시지로 다음 단계 진단.',
            };
          }
        }
      } else if (pathname === '/api/naver/debug-raw') {
        // 네이버 API raw 응답 진단 — 0건 또는 에러 원인 식별용
        logAdminAccess(session, req, 'naver-debug-raw', parsed.query);
        const naverApi = require('./naver/api');
        if (!naverApi.isConfigured()) {
          data = { error: 'Naver API 키 미설정 (NAVER_CLIENT_ID/CLIENT_SECRET)' };
        } else {
          const daysBack = parseInt(parsed.query.days_back) || 30;
          const endMs = Date.now();
          const startMs = endMs - daysBack * 86400000;
          try {
            const changed = await naverApi.listChangedStatuses({ fromMs: startMs });
            const lcStatuses = changed.data?.lastChangeStatuses || changed.data || [];
            const ids = Array.isArray(lcStatuses) ? lcStatuses.map(r => r?.productOrderId).filter(Boolean).slice(0, 5) : [];
            let detail = null;
            if (ids.length) {
              try { detail = await naverApi.queryProductOrders(ids.map(String)); }
              catch (e) { detail = { error: e.message }; }
            }
            data = {
              query: {
                days_back: daysBack,
                start_kst: naverApi.fmtKstIso(startMs),
                client_id: naverApi.CLIENT_ID,
              },
              changed_response_keys: changed && typeof changed === 'object' ? Object.keys(changed) : [],
              changed_data_keys: changed?.data && typeof changed.data === 'object' ? Object.keys(changed.data) : [],
              changed_count: Array.isArray(lcStatuses) ? lcStatuses.length : null,
              sample_changed_ids: ids,
              detail_response: detail,
            };
          } catch (e) {
            data = { error: e.message, client_id: naverApi.CLIENT_ID };
          }
        }
      } else if (pathname === '/api/admin/server-ip') {
        // 서버 outbound IP 확인 — 쿠팡 등 외부 API 키 발급 시 IP 화이트리스트 등록용.
        //   외부 echo 서비스 두 곳에 호출해서 일관된 IP 반환.
        logAdminAccess(session, req, 'server-ip', {});
        try {
          const results = await Promise.allSettled([
            fetch('https://api.ipify.org?format=json').then(r => r.json()),
            fetch('https://ifconfig.me/ip').then(r => r.text()),
          ]);
          const ipify = results[0].status === 'fulfilled' ? results[0].value.ip : null;
          const ifconfig = results[1].status === 'fulfilled' ? results[1].value.trim() : null;
          data = {
            outbound_ip: ipify || ifconfig || null,
            sources: {
              ipify: ipify,
              ifconfig_me: ifconfig,
              match: ipify === ifconfig,
            },
            hint: 'outbound_ip 를 쿠팡 OPEN API 키 발급 화면의 IP 주소 칸에 입력. 두 source 가 다르면 NAT/Proxy 환경 — DBA/인프라팀에 확인 필요.',
          };
        } catch (e) {
          data = { error: 'IP 조회 실패: ' + e.message };
        }
      } else if (pathname === '/api/debug-settle-method-stats') {
        // settle_method 코드 분포 + toss_vaccount 매칭 여부로 가상계좌 코드 식별 진단.
        // URL: /api/debug-settle-method-stats?days=30
        logAdminAccess(session, req, 'debug-settle-method-stats', { days: parsed.query.days });
        const pp = await getPool();
        const days = parseInt(parsed.query.days) || 30;
        // CARD 측 분포 — toss_vaccount 매칭 여부는 derived table 로 사전 집계 후 LEFT JOIN
        //   (MSSQL 은 SUM 안에 EXISTS 서브쿼리 직접 사용 불가)
        const cardDist = await pp.request().input('days', sql.Int, days).query(`
          WITH card_vbank AS (
            SELECT DISTINCT order_seq FROM toss_vaccount WITH (NOLOCK) WHERE order_type = 'C'
          )
          SELECT
            co.settle_method,
            COUNT(*) AS cnt,
            SUM(CASE WHEN cv.order_seq IS NOT NULL THEN 1 ELSE 0 END) AS has_toss_vbank_cnt
          FROM custom_order co WITH (NOLOCK)
          LEFT JOIN card_vbank cv ON cv.order_seq = co.order_seq
          WHERE co.order_date >= DATEADD(day, -@days, GETDATE())
            AND co.status_seq NOT IN (3, 5, 14)
          GROUP BY co.settle_method
          ORDER BY cnt DESC
        `);
        // ETC 측 분포
        const etcDist = await pp.request().input('days', sql.Int, days).query(`
          WITH etc_vbank AS (
            SELECT DISTINCT order_seq FROM toss_vaccount WITH (NOLOCK) WHERE order_type = 'E'
          )
          SELECT
            o.settle_method,
            COUNT(*) AS cnt,
            SUM(CASE WHEN ev.order_seq IS NOT NULL THEN 1 ELSE 0 END) AS has_toss_vbank_cnt
          FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
          LEFT JOIN etc_vbank ev ON ev.order_seq = o.order_seq
          WHERE o.order_date >= DATEADD(day, -@days, GETDATE())
            AND o.status_seq NOT IN (3, 5, 14, 15)
          GROUP BY o.settle_method
          ORDER BY cnt DESC
        `);
        // 코드별 샘플 order_seq 3개씩 (검증용)
        const cardSamples = await pp.request().input('days', sql.Int, days).query(`
          WITH card_vbank AS (
            SELECT DISTINCT order_seq FROM toss_vaccount WITH (NOLOCK) WHERE order_type = 'C'
          )
          SELECT t.settle_method, t.order_seq, t.order_date, t.has_toss_vbank
          FROM (
            SELECT
              co.settle_method, co.order_seq,
              CONVERT(varchar(19), co.order_date, 120) AS order_date,
              CASE WHEN cv.order_seq IS NOT NULL THEN 1 ELSE 0 END AS has_toss_vbank,
              ROW_NUMBER() OVER (PARTITION BY co.settle_method ORDER BY co.order_date DESC) AS rn
            FROM custom_order co WITH (NOLOCK)
            LEFT JOIN card_vbank cv ON cv.order_seq = co.order_seq
            WHERE co.order_date >= DATEADD(day, -@days, GETDATE())
              AND co.status_seq NOT IN (3, 5, 14)
          ) t WHERE t.rn <= 3
          ORDER BY t.settle_method, t.order_date DESC
        `);
        data = {
          period_days: days,
          hint: 'toss_vbank 매칭률 높은 코드 = 가상계좌. 비중 가장 높은 코드 = 신용카드일 가능성 높음.',
          card_distribution: cardDist.recordset,
          etc_distribution: etcDist.recordset,
          card_samples_per_method: cardSamples.recordset,
        };
      } else if (pathname === '/api/debug-payment-discovery') {
        // 결제수단 컬럼/테이블 자동 탐색 — MSSQL 스키마에서 payment 관련 의심 컬럼+테이블 식별.
        //   주문조회 엑셀에 결제수단 추가 위해 어디 컬럼인지 모를 때 사용.
        // URL: /api/debug-payment-discovery?order_seq=4736584  (sample row 검사용, 선택)
        logAdminAccess(session, req, 'debug-payment-discovery', { order_seq: parsed.query.order_seq });
        const pp = await getPool();
        // 1) 두 주문 테이블의 결제 관련 의심 컬럼
        const colsRes = await pp.request().query(`
          SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
          FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_NAME IN ('custom_order', 'CUSTOM_ETC_ORDER')
            AND (
              COLUMN_NAME LIKE '%settle%' OR
              COLUMN_NAME LIKE '%pay%' OR
              COLUMN_NAME LIKE '%payment%' OR
              COLUMN_NAME LIKE '%vbank%' OR
              COLUMN_NAME LIKE '%card%' OR
              COLUMN_NAME LIKE '%bank%' OR
              COLUMN_NAME LIKE '%kakao%' OR
              COLUMN_NAME LIKE '%inicis%' OR
              COLUMN_NAME LIKE '%niceps%' OR
              COLUMN_NAME LIKE '%toss%' OR
              COLUMN_NAME LIKE '%kind%' OR
              COLUMN_NAME LIKE '%method%'
            )
          ORDER BY TABLE_NAME, ORDINAL_POSITION
        `);
        // 2) 결제 관련 의심 테이블
        const tblRes = await pp.request().query(`
          SELECT TABLE_NAME, TABLE_TYPE
          FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_NAME LIKE '%toss%' OR TABLE_NAME LIKE '%pg_%' OR TABLE_NAME LIKE '%pay%'
            OR TABLE_NAME LIKE '%payment%' OR TABLE_NAME LIKE '%settle%'
            OR TABLE_NAME LIKE '%inicis%' OR TABLE_NAME LIKE '%niceps%' OR TABLE_NAME LIKE '%kakao%'
            OR TABLE_NAME LIKE '%vbank%' OR TABLE_NAME LIKE '%vacct%'
          ORDER BY TABLE_NAME
        `);
        // 3) 샘플 주문 검사 (order_seq 파라미터 있으면)
        let sampleData = null;
        const sampleSeq = parseInt(parsed.query.order_seq);
        if (sampleSeq) {
          try {
            // custom_order 전체 컬럼
            const co = await pp.request().input('seq', sql.Int, sampleSeq).query(`
              SELECT TOP 1 * FROM custom_order WITH (NOLOCK) WHERE order_seq = @seq
            `);
            const etc = await pp.request().input('seq', sql.Int, sampleSeq).query(`
              SELECT TOP 1 * FROM CUSTOM_ETC_ORDER WITH (NOLOCK) WHERE order_seq = @seq
            `);
            // payment 의심 컬럼만 추출
            const filterCols = obj => {
              if (!obj) return null;
              const filtered = {};
              for (const k of Object.keys(obj)) {
                if (/settle|pay|vbank|kind|method|bank|card|kakao|toss|inicis|niceps/i.test(k)) {
                  filtered[k] = obj[k];
                }
              }
              return filtered;
            };
            sampleData = {
              order_seq: sampleSeq,
              custom_order_payment_cols: filterCols(co.recordset[0]),
              etc_order_payment_cols: filterCols(etc.recordset[0]),
            };
          } catch (e) { sampleData = { error: e.message }; }
        }
        data = {
          suspect_columns: colsRes.recordset,
          suspect_tables: tblRes.recordset,
          sample_data: sampleData,
          hint: 'sample_data 의 *_payment_cols 에서 신용카드/무통장/가상계좌 등을 구분 가능한 컬럼을 찾으세요. order_seq 파라미터로 sample 주문 지정 가능 (예: ?order_seq=4736584).',
        };
      } else if (pathname === '/api/debug-bg-copurchase') {
        // 바른손몰(affiliate) 동시구매 진단 — D01 답례품 + 다른 Card_Div(특히 A01 청첩장) 같은 order_seq 케이스.
        // 두 테이블 모두 점검: CUSTOM_ETC_ORDER(ETC) + custom_order(CARD).
        // URL: /api/debug-bg-copurchase?start_date=2026-04-29&end_date=2026-05-07
        const dbgS = parsed.query.start_date || fmtDate(addDays(today(), -7));
        const dbgE = parsed.query.end_date || fmtDate(addDays(today(), 1));
        logAdminAccess(session, req, 'debug-bg-copurchase', { start: dbgS, end: dbgE });
        const pp = await getPool();
        // CARD(custom_order) 측 진단 — D01 + A01 가 같은 order_seq 인 affiliate 주문 (4자리 company_Seq).
        const cardSide = await pp.request()
          .input('s', sql.VarChar, dbgS).input('e', sql.VarChar, dbgE)
          .query(`
            WITH d01_orders AS (
              SELECT DISTINCT co.order_seq, co.order_date, co.company_Seq,
                ISNULL(si.SiteName, CAST(co.company_Seq AS VARCHAR)) AS site_name
              FROM custom_order co WITH (NOLOCK)
              INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
              INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
              LEFT JOIN SiteInfo si WITH (NOLOCK) ON co.company_Seq = si.CompayCode
              WHERE c.Card_Div = 'D01'
                AND co.order_date >= @s AND co.order_date < @e
                AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5, 14)
            )
            SELECT
              CONVERT(varchar(10), d.order_date, 120) AS order_day,
              d.order_seq,
              d.company_Seq,
              d.site_name,
              c.Card_Div,
              c.Card_Name,
              c.Card_Code
            FROM d01_orders d
            INNER JOIN custom_order_item coi WITH (NOLOCK) ON d.order_seq = coi.order_seq
            INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
            ORDER BY d.order_seq DESC, c.Card_Div
          `);
        // ETC 주문 중 D01 가 있는 order_seq 들의 같은 주문 내 모든 Card_Div 분포
        const r = await pp.request()
          .input('s', sql.VarChar, dbgS).input('e', sql.VarChar, dbgE)
          .query(`
            WITH d01_orders AS (
              SELECT DISTINCT o.order_seq, o.order_date, o.company_Seq,
                ISNULL(si.SiteName, CAST(o.company_Seq AS VARCHAR)) AS site_name
              FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
              INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
              INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
              LEFT JOIN SiteInfo si WITH (NOLOCK) ON o.company_Seq = si.CompayCode
              WHERE c.Card_Div = 'D01'
                AND o.order_date >= @s AND o.order_date < @e
                AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 14, 15)
            )
            SELECT
              CONVERT(varchar(10), d.order_date, 120) AS order_day,
              d.order_seq,
              d.site_name,
              c.Card_Div,
              c.Card_Name,
              oi.order_count
            FROM d01_orders d
            INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON d.order_seq = oi.order_seq
            INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
            ORDER BY d.order_seq DESC, c.Card_Div
          `);
        // 같은 회원이 별도 order 로 청첩장(custom_order)+답례품(CUSTOM_ETC_ORDER) 산 케이스도 체크
        const memberLink = await pp.request()
          .input('s', sql.VarChar, dbgS).input('e', sql.VarChar, dbgE)
          .query(`
            SELECT DISTINCT
              o.order_seq AS etc_order_seq,
              CONVERT(varchar(10), o.order_date, 120) AS etc_order_day,
              o.member_id,
              ISNULL(si.SiteName, CAST(o.company_Seq AS VARCHAR)) AS etc_site,
              co.order_seq AS card_order_seq,
              CONVERT(varchar(10), co.order_date, 120) AS card_order_day
            FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
            INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
            INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
            LEFT JOIN SiteInfo si WITH (NOLOCK) ON o.company_Seq = si.CompayCode
            INNER JOIN custom_order co WITH (NOLOCK) ON co.member_id = o.member_id
            INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
            INNER JOIN S2_Card c2 WITH (NOLOCK) ON coi.card_seq = c2.Card_Seq
            WHERE c.Card_Div = 'D01'
              AND c2.Card_Div = 'A01'
              AND o.order_date >= @s AND o.order_date < @e
              AND ABS(DATEDIFF(day, o.order_date, co.order_date)) <= 30
              AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 14, 15)
              AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5, 14)
          `);
        // 집계: order_seq 당 distinct Card_Div 수, 사이트별 분포
        const byOrder = {};
        r.recordset.forEach(row => {
          const k = row.order_seq;
          if (!byOrder[k]) byOrder[k] = { order_day: row.order_day, site_name: row.site_name, divs: {} };
          byOrder[k].divs[row.Card_Div] = (byOrder[k].divs[row.Card_Div] || 0) + 1;
        });
        const summary = { same_order_multi_div: 0, only_d01: 0, by_site: {} };
        Object.values(byOrder).forEach(o => {
          const divKeys = Object.keys(o.divs);
          if (divKeys.length > 1 || (divKeys[0] && divKeys[0] !== 'D01')) summary.same_order_multi_div++;
          else summary.only_d01++;
          const s = o.site_name;
          summary.by_site[s] = summary.by_site[s] || { d01_orders: 0, multi_div_orders: 0, divs_seen: {} };
          summary.by_site[s].d01_orders++;
          if (divKeys.length > 1) summary.by_site[s].multi_div_orders++;
          divKeys.forEach(dv => { summary.by_site[s].divs_seen[dv] = (summary.by_site[s].divs_seen[dv]||0)+1; });
        });
        // CARD 측도 같은 패턴으로 분석
        const cardByOrder = {};
        cardSide.recordset.forEach(row => {
          const k = row.order_seq;
          if (!cardByOrder[k]) cardByOrder[k] = {
            order_day: row.order_day, site_name: row.site_name, company_Seq: row.company_Seq, divs: {}
          };
          cardByOrder[k].divs[row.Card_Div] = (cardByOrder[k].divs[row.Card_Div] || 0) + 1;
        });
        const cardSummary = { same_order_multi_div: 0, only_d01: 0, has_a01: 0, by_site: {}, affiliate_copurchase_count: 0 };
        Object.entries(cardByOrder).forEach(([oseq, o]) => {
          const divKeys = Object.keys(o.divs);
          if (divKeys.length > 1 || (divKeys[0] && divKeys[0] !== 'D01')) cardSummary.same_order_multi_div++;
          else cardSummary.only_d01++;
          if (o.divs['A01']) {
            cardSummary.has_a01++;
            // 4자리 company_Seq = affiliate (바른손몰)
            if (/^\d{4}$/.test(String(o.company_Seq))) cardSummary.affiliate_copurchase_count++;
          }
          const s = o.site_name;
          cardSummary.by_site[s] = cardSummary.by_site[s] || { d01_orders: 0, has_a01_orders: 0, divs_seen: {} };
          cardSummary.by_site[s].d01_orders++;
          if (o.divs['A01']) cardSummary.by_site[s].has_a01_orders++;
          divKeys.forEach(dv => { cardSummary.by_site[s].divs_seen[dv] = (cardSummary.by_site[s].divs_seen[dv]||0)+1; });
        });
        data = {
          period: { start: dbgS, end: dbgE },
          etc_table: {
            summary,
            same_order_examples: r.recordset.slice(0, 50),
          },
          card_table: {
            summary: cardSummary,
            // 바른손몰(4자리) 동시구매 후보만 (가장 중요한 케이스)
            affiliate_copurchase_samples: Object.entries(cardByOrder)
              .filter(([_, o]) => o.divs['A01'] && /^\d{4}$/.test(String(o.company_Seq)))
              .slice(0, 20)
              .map(([oseq, o]) => ({ order_seq: parseInt(oseq), ...o })),
          },
          cross_table_member_link: {
            count: memberLink.recordset.length,
            note: '같은 member_id 가 ETC(D01) 와 custom_order(A01) 에 동시에 있는 케이스 (별도 주문, 빈 member_id 노이즈 포함)',
            samples: memberLink.recordset.slice(0, 5),
          },
        };
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
