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

// ============================================
// Super Admin 권한 — GNB 설정 등 시스템 설정 변경 가능
// ============================================
//   현재 sejun.song@barunn.net 만 (env 로 override 가능: SUPER_ADMIN_EMAILS=a@b.com,c@d.com)
const SUPER_ADMIN_EMAILS = (process.env.SUPER_ADMIN_EMAILS || 'sejun.song@barunn.net')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

function isSuperAdmin(session) {
  if (!session || !session.email) return false;
  return SUPER_ADMIN_EMAILS.includes(String(session.email).toLowerCase());
}

// ============================================
// Role-based 권한 — admin_users.role ('admin' | 'operator' | 'designer')
// ============================================
//   workflow:
//     - 스티커 업로드/다운로드, 인쇄완료: admin/operator/designer
//     - 제본완료, 포장완료, 출고처리: admin/operator
//
//   미등록 사용자 default = 'operator' (기존 동작 유지, breaking change 회피).
//   super admin 은 무조건 'admin' 권한 통과.
const _roleCache = new Map(); // email → { role, cachedAt }
const ROLE_CACHE_TTL_MS = 60 * 1000; // 1분

async function getUserRole(email) {
  if (!email) return null;
  const key = String(email).toLowerCase();
  const cached = _roleCache.get(key);
  if (cached && (Date.now() - cached.cachedAt) < ROLE_CACHE_TTL_MS) return cached.role;
  if (!USE_SUPABASE_AUTH) return 'operator'; // 미설정 환경 default
  try {
    const res = await fetch(`${AUTH_REST_BASE}/admin_users?email=eq.${encodeURIComponent(key)}&select=role&limit=1`, {
      headers: AUTH_HEADERS,
    });
    if (!res.ok) {
      _roleCache.set(key, { role: 'operator', cachedAt: Date.now() });
      return 'operator';
    }
    const rows = await res.json();
    const role = rows[0]?.role || 'operator'; // 미등록 = operator default
    _roleCache.set(key, { role, cachedAt: Date.now() });
    return role;
  } catch (e) {
    console.warn(`[role] getUserRole 실패 ${email}: ${e.message}`);
    return 'operator';
  }
}

/**
 * 세션 + 허용 role 리스트 → 권한 여부.
 *   super admin 은 무조건 통과.
 *   예: await hasRole(session, ['admin', 'operator'])
 */
async function hasRole(session, allowedRoles) {
  if (!session || !session.email) return false;
  if (isSuperAdmin(session)) return true;
  const role = await getUserRole(session.email);
  return allowedRoles.includes(role);
}

/** 권한 거부 응답 헬퍼 — 라우트에서 사용. */
function denyForbidden(res, hint = 'role required') {
  res.writeHead(403, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'forbidden', message: '권한 없음 — ' + hint }));
}

// ============================================
// GNB 메뉴 설정 — Supabase nav_menu_settings (id=1 단일행)
// ============================================
async function getNavMenuConfig() {
  if (!USE_SUPABASE_AUTH) return [];
  const res = await fetch(`${AUTH_REST_BASE}/nav_menu_settings?id=eq.1&select=config`, {
    headers: AUTH_HEADERS,
  });
  if (!res.ok) return [];
  const rows = await res.json();
  if (!rows.length) return [];
  return Array.isArray(rows[0].config) ? rows[0].config : [];
}

async function setNavMenuConfig(config, updatedBy) {
  if (!USE_SUPABASE_AUTH) throw new Error('Supabase 미설정 — GNB 설정 저장 불가');
  if (!Array.isArray(config)) throw new Error('config must be array');
  // 정규화 — 허용 필드만
  const clean = config.map((it, idx) => ({
    id: String(it.id || '').trim(),
    visible: it.visible !== false,
    order: Number.isFinite(it.order) ? Number(it.order) : idx,
  })).filter(it => it.id);
  const body = {
    config: clean,
    updated_at: new Date().toISOString(),
    updated_by: updatedBy || null,
  };
  const res = await fetch(`${AUTH_REST_BASE}/nav_menu_settings?id=eq.1`, {
    method: 'PATCH',
    headers: { ...AUTH_HEADERS, Prefer: 'return=representation' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    // 행이 아예 없으면 INSERT 시도 (마이그레이션 누락 케이스 자가복구)
    if (res.status === 404 || /no rows/i.test(text)) {
      const ins = await fetch(`${AUTH_REST_BASE}/nav_menu_settings`, {
        method: 'POST',
        headers: { ...AUTH_HEADERS, Prefer: 'return=representation' },
        body: JSON.stringify({ id: 1, ...body }),
      });
      if (!ins.ok) throw new Error(`Supabase insert nav_menu_settings [${ins.status}]: ${(await ins.text()).slice(0,300)}`);
      const inserted = await ins.json();
      if (!inserted.length) {
        throw new Error('nav_menu_settings INSERT 후 응답이 비어있음 — RLS 정책으로 결과 숨김 가능. ALTER TABLE nav_menu_settings DISABLE ROW LEVEL SECURITY 필요.');
      }
      return inserted[0].config || clean;
    }
    throw new Error(`Supabase patch nav_menu_settings [${res.status}]: ${text.slice(0,300)}`);
  }
  const rows = await res.json();
  // 빈 응답 = RLS 가 결과 숨김 = 실제로 PATCH 안 됨 (silent fail 감지).
  //   migration 016 의 RLS 정책이 SELECT-only 인데 PATCH 응답을 return=representation 으로
  //   요청하면 RLS 가 row 를 가려서 빈 배열 반환. 이전에는 || clean 으로 falsy fallback 해서
  //   성공처럼 보였음. 명시적으로 throw 해서 클라이언트에 에러 전달.
  if (!rows.length) {
    throw new Error('nav_menu_settings PATCH 응답이 비어있음 — RLS 정책이 결과를 가리거나 실제로 변경 안 됨. ALTER TABLE nav_menu_settings DISABLE ROW LEVEL SECURITY 실행 필요.');
  }
  return rows[0].config || clean;
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
// 하드코딩 매핑 (운영팀 확인된 사이트, DB 등록 누락 보정용).
//   '바른손몰 B2B' 등 — COMPANY/SiteInfo 에 등록되기 전까지 fallback.
//   추후 DB 등록 시 hardcoded 우선이라 일관 유지.
const HARDCODED_SITE_NAMES = {
  '2715': '바른손몰 B2B',
};
// site_name이 숫자(제휴사 코드)인 경우 변환:
//   1순위 hardcoded map → 2순위 DB companyNameMap → 3순위 '미등록(코드)' fallback (운영자 식별성 ↑)
function formatSiteName(siteName) {
  if (!siteName) return siteName;
  const s = String(siteName).trim();
  if (/^\d+$/.test(s)) {
    if (HARDCODED_SITE_NAMES[s]) return `${HARDCODED_SITE_NAMES[s]}(${s})`;
    if (companyNameMap[s]) return `${companyNameMap[s]}(${s})`;
    return `미등록 사이트(${s})`;
  }
  return siteName;
}

// 카테고리 필터 정의
//   Card_Div 코드 (S2_Card 테이블):
//     D01 = 답례품, D02 = 꽃다발, C29 = 데코소품(웨딩포스터/스티커/아크릴/photo_print 등)
//   이전 deco 필터는 'Card_Code LIKE 2026_%' prefix 였으나 photo_print_* 등 누락 발생 →
//   Card_Div 기준으로 정정 (C29 는 운영 진단으로 확인).
//   QR 스티커(2026_qr*) 는 C29 가 아닌 별도 Card_Div 에 있어 OR 조건 추가 (운영 요청).
// 답례품 필터: D01 (자체매입) + COM_ prefix (위탁답례품)
//   위탁답례품 상품은 S2_Card.Card_Code 가 'COM_' 으로 시작하며 Card_Div != 'D01' 인 경우 다수.
//   주문조회 / 정보입력 / 대시보드 모두 답례품 통합 노출 (사용자 합의: 2026-06-17, 주문 3246815 케이스).
const DAERYEPUM_FILTER_SQL = `(c.Card_Div = 'D01' OR c.Card_Code LIKE 'COM[_]%')`;
const CATEGORY_FILTERS = {
  daeryepum: { label: '답례품', filter: DAERYEPUM_FILTER_SQL },
  deco:      { label: '데코소품', filter: `(c.Card_Div = 'C29' OR c.Card_Code LIKE '2026_qr%')` },
  flower:    { label: '꽃다발', filter: `c.Card_Div = 'D02'` },
};
// 모듈 레벨 D01_FILTER — 위탁답례품 포함 답례품 기본 필터로 alias
const D01_FILTER = DAERYEPUM_FILTER_SQL;

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
      WHERE ${D01_FILTER} AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 15)
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
      WHERE ${D01_FILTER} AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 15)
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
  // by-IDs 모드 — 정보입력현황의 customer_info 가 있는 옛날 주문 fetch 용.
  //   prefix 별로 분리 (MSSQL ETC/CARD = order_seq, COUPANG = coupang_order_id, NAVER = product_order_id).
  //   콤마 분리, 안전상 채널당 500개 제한.
  //   이 모드면 date filter 와 OR 조건 — (in range) OR (in ids) 둘 다 매칭.
  const parseIntList = (raw, max = 500) => String(raw || '').trim()
    ? String(raw).split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isInteger(n) && n > 0).slice(0, max)
    : [];
  const parseStrList = (raw, max = 500) => String(raw || '').trim()
    ? String(raw).split(',').map(s => s.trim()).filter(Boolean).slice(0, max)
    : [];
  const orderSeqsList = parseIntList(query.order_seqs);
  const coupangIdsList = parseIntList(query.coupang_ids);
  const naverIdsList = parseStrList(query.naver_ids);
  const orderSeqsClause = orderSeqsList.length ? `OR o.order_seq IN (${orderSeqsList.join(',')})` : '';
  const orderSeqsClauseCo = orderSeqsList.length ? `OR co.order_seq IN (${orderSeqsList.join(',')})` : '';
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
  //
  // 카테고리별 가격 산정 방식:
  //   - D01(답례품): card_sale_price × order_count / Unit_Value — 묶음 단위 가격 구조
  //   - C29(데코소품) / 2026_qr%: card_sale_price × order_count (Unit_Value 무시)
  //     · 데코소품은 1상품 = 1set 가격 구조라 Unit_Value 로 나누면 가격 축소됨
  //     · 예: photo_print_06 — 단위 2매, 가격 1,000원, 1주문 시 결제금액 1,000원 (아닌 500원 X)
  //   - D02(꽃다발): 일단 기존 동일 (Unit_Value 적용)
  const categoryCfg = CATEGORY_FILTERS[query.category] || CATEGORY_FILTERS.daeryepum;
  const skipUnitValue = query.category === 'deco';
  const etcAmountGross = etcAmountGrossExpr({ skipUnitValue });
  // 쿠폰 분배 분모도 카테고리 전체 filter 로 정정 (이전엔 D01 만 고정 → 데코주문에서 쿠폰 분배 오류)
  const cpdFilter = (categoryCfg.filter || DAERYEPUM_FILTER_SQL).replace(/\bc\./g, 'c_cpd.');
  const etcCouponDivisorForCategory = etcCouponDivisorJoin(cpdFilter);
  const cardUnitDivisor = skipUnitValue ? '1' : 'ISNULL(NULLIF(c.Unit_Value, 0), 1)';

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
        ISNULL(NULLIF(c.Unit_Value, 0), 1) AS unit_value,  -- 판매단위 수량 (인쇄수량 산식: item_count × unit_value)
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
        AND (o.order_date >= @startDate AND o.order_date < @endDate ${orderSeqsClause})
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
        ISNULL(NULLIF(c.Unit_Value, 0), 1) AS unit_value,  -- 판매단위 수량 (인쇄수량 산식: item_count × unit_value)
        -- dd_count (DELIVERY_INFO_DETAIL 의 '답례품' row 수량) 는 답례품(D01) 전용.
        --   같은 주문에 답례품 + 데코소품/청첩장 있을 때 다른 카테고리에 답례품 수량이
        --   그대로 적용되던 오류 fix — D01 만 dd_count 사용, 그 외는 coi.item_count 그대로.
        CASE WHEN c.Card_Div = 'D01' THEN ISNULL(di.dd_count, coi.item_count) ELSE coi.item_count END AS item_count,
        CAST(coi.item_sale_price AS float) *
          (CASE WHEN c.Card_Div = 'D01' THEN ISNULL(di.dd_count, coi.item_count) ELSE coi.item_count END)
          / ${cardUnitDivisor} AS item_amount,
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
        AND (co.order_date >= @startDate AND co.order_date < @endDate ${orderSeqsClauseCo})
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
        orderIds: coupangIdsList.length ? coupangIdsList : undefined,
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
          unit_value: 1,  // 쿠팡은 unit_value 개념 없음 (1:1)
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
        orderIds: naverIdsList.length ? naverIdsList : undefined,
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
          unit_value: 1,
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
 * 같은 주문 내 같은 카테고리 아이템 수를 미리 집계하는 derived table JOIN 절.
 *   GROUP BY 로 주문당 1행 → outer 행마다 재계산 X (성능).
 *   인자: cardDiv 문자열 'D01' (호환) 또는 filter clause "c_cpd.Card_Div = 'C29' OR ..."
 */
function etcCouponDivisorJoin(input = 'D01') {
  // 인자가 단순 cardDiv ('D01') 인지 또는 filter clause (공백 포함) 인지 자동 판별
  const filter = /\s|=|\(/.test(input) ? input : `c_cpd.Card_Div = '${input}'`;
  return `LEFT JOIN (
    SELECT order_seq, COUNT(*) AS item_count
    FROM CUSTOM_ETC_ORDER_ITEM oi_cpd WITH (NOLOCK)
    INNER JOIN S2_Card c_cpd WITH (NOLOCK) ON oi_cpd.card_seq = c_cpd.Card_Seq
    WHERE ${filter}
    GROUP BY order_seq
  ) ecd ON o.order_seq = ecd.order_seq`;
}

/** ETC 행 단위 매출 식 (집계용, 쿠폰 차감 포함) — outer 에 ecd.item_count alias 필요.
 *   skipUnitValue: 데코소품(C29/2026_qr) 처럼 단위가격 무시인 카테고리에서 true.
 *   호환성: 옛 호출 etcAmountExpr('D01') 또는 etcAmountExpr({skipUnitValue:true}) 둘 다 지원.
 */
function etcAmountExpr(arg = 'D01') {
  const skipUnitValue = (typeof arg === 'object' && arg !== null) ? !!arg.skipUnitValue : false;
  const unitDivisor = skipUnitValue ? '1' : 'ISNULL(NULLIF(c.Unit_Value, 0), 1)';
  return `
  CASE
    WHEN si.SiteName IS NULL
    THEN CAST(oi.card_sale_price AS float) * oi.order_count / ${unitDivisor}
         - ISNULL(o.coupon_price, 0) * 1.0 / NULLIF(ecd.item_count, 0)
    ELSE CAST(oi.card_sale_price AS float)
         - ISNULL(o.coupon_price, 0) * 1.0 / NULLIF(ecd.item_count, 0)
  END`;
}

/**
 * ETC 행 단위 정가 식 (쿠폰 분배 X) — 주문조회 화면 표시용.
 *   주문조회 결제금액 컬럼은 정가만 표시하고, 쿠폰할인은 별도 컬럼에서 ecd.item_count 로 분배 표시.
 *   (집계 쿼리는 etcAmountExpr 사용 — coupon 1회 차감 정확성 유지)
 *
 *   skipUnitValue: 데코소품/QR스티커 등 1상품=1set 가격 구조 카테고리에서 true.
 *     · 답례품(D01): card_sale_price × order_count / Unit_Value (묶음 단위 가격)
 *     · 데코소품(C29/2026_qr): card_sale_price × order_count (Unit_Value 무시)
 */
function etcAmountGrossExpr({ skipUnitValue = false } = {}) {
  const unitDivisor = skipUnitValue ? '1' : 'ISNULL(NULLIF(c.Unit_Value, 0), 1)';
  return `
  CASE
    WHEN si.SiteName IS NULL
    THEN CAST(oi.card_sale_price AS float) * oi.order_count / ${unitDivisor}
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
        AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5)
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
        AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 15)
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

async function apiDashboardComparison(query = {}) {
  const p = await getPool();
  // 카테고리별 필터 + amount 계산식 (apiOrders / apiDashboardSummary 와 동일 패턴).
  //   함수 안에서 module-level 상수 D01_FILTER / ETC_AMOUNT_EXPR /
  //   ETC_COUPON_DIVISOR_JOIN_D01 를 shadow 해 SQL template literal 이 자동으로 카테고리별 값 사용.
  const categoryCfg = CATEGORY_FILTERS[query.category] || CATEGORY_FILTERS.daeryepum;
  const skipUnitValue = query.category === 'deco';
  const D01_FILTER = categoryCfg.filter;
  const ETC_AMOUNT_EXPR = etcAmountExpr({ skipUnitValue });
  const _cpdFilter = categoryCfg.filter.replace(/\bc\./g, 'c_cpd.');
  const ETC_COUPON_DIVISOR_JOIN_D01 = etcCouponDivisorJoin(_cpdFilter);
  const cardUnitDivisor = skipUnitValue ? '1' : 'ISNULL(NULLIF(c.Unit_Value, 0), 1)';

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
          WHERE ${D01_FILTER} AND o.order_date >= @s AND o.order_date < @e AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 15)
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
            ISNULL(SUM(CAST(coi.item_sale_price AS float) * coi.item_count / ${cardUnitDivisor}),0) AS total_amount,
            ISNULL(SUM(coi.item_count),0) AS total_qty
          FROM custom_order co WITH (NOLOCK)
          INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
          INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
          LEFT JOIN SiteInfo si WITH (NOLOCK) ON co.company_Seq = si.CompayCode
          LEFT JOIN copurchase_orders cp ON co.order_seq = cp.order_seq
          WHERE ${D01_FILTER} AND co.order_date >= @s AND co.order_date < @e AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5)
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
              ISNULL(SUM(CAST(coi.item_sale_price AS float) * coi.item_count / ${cardUnitDivisor}),0) AS amount,
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
    // 쿠팡 / 네이버 / 쿠팡 로켓그로스 — 답례품 전용 채널. 데코소품/꽃다발 카테고리에서는 제외.
    const _isDaeryepumCmp = !query.category || query.category === 'daeryepum';
    if (_isDaeryepumCmp) await mergeMarketplace(
      '쿠팡',
      () => require('./coupang/store').listCoupangOrders({ startStr, endStr, byPaid: false }),
      r => `${r.coupang_order_id}::${r.shipment_box_id}`,
    );
    if (_isDaeryepumCmp) await mergeMarketplace(
      '네이버',
      () => require('./naver/store').listNaverOrders({ startStr, endStr, byPaid: false }),
      r => `${r.product_order_id}`,
    );

    // 쿠팡 로켓그로스(RFM) 매출 — 일별 aggregate (주문 단위 X). 운영자가 Wing 셀러센터
    //   보고 수동 입력 (Coupang Open API RFM endpoint 미공개). order_count 는 row 수
    //   (=일자 수) 사용 — 정확한 주문 수는 알 수 없음.
    //   endStr 는 exclusive 라 rfm listSales 의 lte 와 맞추려 -1 일.
    if (_isDaeryepumCmp) try {
      const rfmStore = require('./coupang/rfm-store');
      const endIncl = endStr ? new Date(new Date(endStr).getTime() - 86400000).toISOString().slice(0, 10) : null;
      const rfmRows = await rfmStore.listSales({ startDate: startStr, endDate: endIncl });
      if (rfmRows && rfmRows.length) {
        let amount = 0, qty = 0;
        for (const r of rfmRows) {
          amount += Number(r.net_amount) || 0;
          qty += Number(r.sales_qty) || 0;
        }
        if (amount !== 0 || qty !== 0 || rfmRows.length) {
          const site = ensureSite('쿠팡 로켓그로스');
          site.order_count += rfmRows.length;
          site.total_amount += amount;
          site.total_qty += qty;
          site.standalone.amount += amount;
          site.standalone.orders += rfmRows.length;
          site.standalone.qty += qty;
          standalone_amount += amount;
          standalone_orders += rfmRows.length;
          standalone_qty += qty;
        }
      }
    } catch (e) {
      console.warn('[getPeriodTotal] 쿠팡 로켓그로스 머지 실패 (무시):', e.message);
    }

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
              AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5)
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
              AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 15)
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

  // 카테고리별 필터 + amount 계산식 (apiOrders 와 동일 패턴).
  //   daeryepum (default): Card_Div='D01', unit_value 적용
  //   deco: Card_Div='C29' OR Card_Code LIKE '2026_qr%', unit_value 무시 (1상품=1set)
  //   flower: Card_Div='D02', unit_value 적용
  const categoryCfg = CATEGORY_FILTERS[query.category] || CATEGORY_FILTERS.daeryepum;
  const categoryFilter = categoryCfg.filter;
  const skipUnitValue = query.category === 'deco';
  const etcAmountExprForCat = etcAmountExpr({ skipUnitValue });
  // 쿠폰 분배 분모도 카테고리 전체 filter 적용 (이전엔 D01 고정 → 데코주문 분배 오류)
  const cpdFilter = categoryFilter.replace(/\bc\./g, 'c_cpd.');
  const etcCouponDivisorForCategory = etcCouponDivisorJoin(cpdFilter);
  const cardUnitDivisor = skipUnitValue ? '1' : 'ISNULL(NULLIF(c.Unit_Value, 0), 1)';

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
          SUM(${etcAmountExprForCat}) AS total_amount
        FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
        INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
        INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
        LEFT JOIN SiteInfo si WITH (NOLOCK) ON o.company_Seq = si.CompayCode
        LEFT JOIN etc_copurchase_orders ecp ON o.order_seq = ecp.order_seq
        ${etcCouponDivisorForCategory}
        WHERE ${categoryFilter} AND o.order_date >= @startDate AND o.order_date < @endDate AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 15)
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
          SUM(CAST(coi.item_sale_price AS float) * coi.item_count / ${cardUnitDivisor})
        FROM custom_order co WITH (NOLOCK)
        INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
        INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
        LEFT JOIN SiteInfo si WITH (NOLOCK) ON co.company_Seq = si.CompayCode
        LEFT JOIN copurchase_orders cp ON co.order_seq = cp.order_seq
        WHERE ${categoryFilter} AND co.order_date >= @startDate AND co.order_date < @endDate AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5)
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
        WHERE ${categoryFilter} AND o.order_date >= @startDate AND o.order_date < @endDate AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 15)
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
        WHERE ${categoryFilter} AND co.order_date >= @startDate AND co.order_date < @endDate AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5)
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
              AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5)
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
              AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 15)
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
  //   쿠팡/네이버/로켓그로스 는 답례품 전용 채널 — 데코소품/꽃다발 탭에서는 제외.
  const _isDaeryepumCategory = !query.category || query.category === 'daeryepum';
  if (_isDaeryepumCategory) try {
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

  // 네이버 스마트스토어 일별 합산 — 쿠팡과 동일 패턴, '네이버' 사이트 그룹. 답례품 전용.
  if (_isDaeryepumCategory) try {
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

  // 쿠팡 로켓그로스 매출 (수동 입력 집계) 머지 — 일별 aggregate, '쿠팡 로켓그로스' 사이트 그룹. 답례품 전용.
  //
  // 데이터 특성:
  //   · Wing API 가 RFM 매출 노출 안 해 운영자가 수동 입력 → coupang_rocket_growth_sales 테이블
  //   · 일자당 1 row (vendor_item_id='_manual'), 상품 명세 없는 일별 합계
  //   · net_amount 는 generated column (= sales_amount - refund_amount) — Wing 셀러센터 표시값과 일관
  //   · 주문건수는 실제 주문 단위 데이터 없음 → row 수(=일자 수) 사용
  //
  // 컨벤션 정렬: apiDashboardComparison 의 getPeriodTotal 과 동일 패턴 — 채널별 합계 KPI
  //   카드가 비교 카드와 어긋나지 않도록 통일 (amount=net_amount, qty=sales_qty gross, order_count=row수).
  if (_isDaeryepumCategory) try {
    const rfmStore = require('./coupang/rfm-store');
    // endDate 는 exclusive — listSales 의 lte 와 맞추려 -1 일
    const endIncl = endDate ? new Date(new Date(endDate).getTime() - 86400000).toISOString().slice(0, 10) : null;
    const rgRows = await rfmStore.listSales({ startDate, endDate: endIncl });
    if (rgRows && rgRows.length) {
      for (const r of rgRows) {
        const day = String(r.sale_date || '').slice(0, 10);
        if (!day) continue;
        const netAmount = Number(r.net_amount) || 0; // generated column = sales - refund
        const grossQty = Number(r.sales_qty) || 0;   // getPeriodTotal 컨벤션과 일치 (gross)
        // summary rows — 일별 단일 집계 row (상품별 분해 불가)
        rows.push({
          card_name: r.product_name || '쿠팡 로켓그로스 (일별 집계)',
          card_code: 'ROCKET_GROWTH',
          order_day: day,
          site_name: '쿠팡 로켓그로스',
          order_type: '단독주문',
          order_count: 1, // 일별 1 entry (수동 입력 단위)
          total_qty: grossQty,
          total_amount: Math.round(netAmount),
        });
        // orderCounts — row 수 = 1/일 (수동 집계 단위)
        orderCounts.push({
          order_day: day,
          site_name: '쿠팡 로켓그로스',
          order_type: '단독주문',
          distinct_order_count: 1,
        });
      }
    }
  } catch (e) {
    console.warn('[summary] 쿠팡 로켓그로스 머지 실패 (무시):', e.message);
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
// ============================================
// 위탁업체 정산 API (Phase 2)
// ============================================

/** ERP 변형 코드(예: TGJSD0104_A) → BASE 코드(TGJSD0104). 클라이언트 resolveBgMappedProductCode 와 동일. */
function _baseProductCode(rawCode) {
  if (!rawCode) return rawCode || '';
  let cur = String(rawCode);
  for (let i = 0; i < 3; i++) {
    const m = cur.match(/^(.+)_[A-Za-z0-9]+$/);
    if (!m || m[1] === cur) break;
    cur = m[1];
  }
  return cur;
}

/**
 * customer_info 의 product 단위 출고일 lookup — 멀티 출고일 그룹 주문 호환.
 *
 * 우선순위:
 *   1) sticker_selections[i].desired_ship_date (product 별 정확)
 *      → 멀티 그룹 주문에서 그룹마다 다른 날짜 가능. order-info.html submit 시 채움.
 *   2) ci.desired_ship_date (단일 그룹 / 구버전 호환)
 *
 * @returns 'YYYY-MM-DD' or ''
 */
function _shipDateForSel(ci, productCode, baseCode) {
  if (!ci) return '';
  const sels = Array.isArray(ci.sticker_selections) ? ci.sticker_selections : [];
  for (const sel of sels) {
    if (!sel || !sel.product_code) continue;
    if (sel.product_code === productCode || sel.product_code === baseCode) {
      if (sel.desired_ship_date) return String(sel.desired_ship_date).slice(0, 10);
    }
  }
  return String(ci.desired_ship_date || '').slice(0, 10);
}

/** product 단위 is_express lookup — sticker_selection 우선, fallback ci.is_express. */
function _isExpressForSel(ci, productCode, baseCode) {
  if (!ci) return false;
  const sels = Array.isArray(ci.sticker_selections) ? ci.sticker_selections : [];
  for (const sel of sels) {
    if (!sel || !sel.product_code) continue;
    if (sel.product_code === productCode || sel.product_code === baseCode) {
      if (typeof sel.is_express === 'boolean') return sel.is_express;
    }
  }
  return !!ci.is_express;
}

/**
 * ci 가 (기간 윈도우) 안에 있는지 — 멀티 그룹 호환.
 *   ci.desired_ship_date 또는 어느 sticker_selection.desired_ship_date 가 윈도우 내면 true.
 */
function _ciInDateWindow(ci, startDate, endDate) {
  const dates = [];
  if (ci.desired_ship_date) dates.push(String(ci.desired_ship_date).slice(0, 10));
  const sels = Array.isArray(ci.sticker_selections) ? ci.sticker_selections : [];
  for (const sel of sels) {
    if (sel && sel.desired_ship_date) dates.push(String(sel.desired_ship_date).slice(0, 10));
  }
  return dates.some(d => d && d >= startDate && d <= endDate);
}

/**
 * 위탁업체 정산 페이지 데이터 collector.
 *
 * Query params:
 *   - vendor_id (optional) — 특정 거래처만
 *   - start_date / end_date — 희망출고일 기준 (inclusive)
 *   - status — 'all' | 'settled' | 'unsettled'
 *   - order_type — 'all' | 'copurchase' | 'standalone'
 *
 * Return:
 *   {
 *     period, items: [
 *       { order_id, order_seq, product_code, product_name, vendor_id, vendor_name,
 *         desired_ship_date, is_copurchase, qty, gross_amount, commission_rate,
 *         commission_amount, net_amount, settled_at }
 *     ],
 *     summary: { total_count, settled_count, unsettled_count,
 *                gross_total, commission_total, net_total,
 *                settled_net, unsettled_net }
 *   }
 */
async function apiVendorSettlements(query) {
  const startDate = query.start_date || fmtDate(addDays(today(), -30));
  const endDate = query.end_date || fmtDate(addDays(today(), 31));
  const filterVendorId = query.vendor_id || null;
  const filterStatus = query.status || 'all';
  const filterOrderType = query.order_type || 'all';

  const empty = {
    period: { start: startDate, end: endDate },
    items: [],
    summary: { total_count: 0, settled_count: 0, unsettled_count: 0,
               gross_total: 0, commission_total: 0, net_total: 0,
               settled_net: 0, unsettled_net: 0 },
  };

  const _bgStore = require('./barungift/store');

  // 1) 위탁상품 매핑 (vendor_id 가진 상품 설정만)
  const allProducts = await _bgStore.getAllProductSettings();
  const consigned = allProducts.filter(s => s.vendor_id && (!filterVendorId || s.vendor_id === filterVendorId));
  if (!consigned.length) return empty;
  const productByCode = new Map(consigned.map(s => [s.product_id, s]));

  // 2) 거래처 정보 (수수료율 fallback / name lookup)
  const vendors = await _bgStore.listVendors();
  const vendorById = new Map(vendors.map(v => [v.id, v]));

  // 3) 기간 내 customer_info — 멀티 그룹 호환:
  //    ci.desired_ship_date 또는 어느 sticker_selection.desired_ship_date 라도 윈도우 내면 포함.
  //    product-level 윈도우 외 검증은 7) row 빌드에서 다시 적용 (보수적).
  const ciList = await _bgStore.getCustomerInfosWithShipDate();
  const inWindow = ciList.filter(ci => _ciInDateWindow(ci, startDate, endDate));
  if (!inWindow.length) return empty;

  // 4) order_seq 분리 (CARD/ETC)
  const ciByCardSeq = new Map();
  const ciByEtcSeq = new Map();
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

  // 5) MSSQL 에서 (order_seq, product_code) 단위 매출 + 동시구매 여부 조회
  const p = await getPool();
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
        c.Card_Code AS product_code,
        c.Card_Name AS product_name,
        CASE WHEN cp.order_seq IS NOT NULL THEN 1 ELSE 0 END AS is_copurchase,
        ISNULL(SUM(coi.item_count), 0) AS qty,
        ISNULL(SUM(CAST(coi.item_sale_price AS float) * coi.item_count / ISNULL(NULLIF(c.Unit_Value, 0), 1)), 0) AS amount,
        MAX(co.settle_method) AS settle_method
      FROM custom_order co WITH (NOLOCK)
      INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
      INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
      LEFT JOIN copurchase_orders cp ON co.order_seq = cp.order_seq
      WHERE ${D01_FILTER} AND co.order_seq IN (${inList})
        AND co.status_seq >= 1 AND co.status_seq NOT IN (3, 5)
      GROUP BY co.order_seq, c.Card_Code, c.Card_Name, CASE WHEN cp.order_seq IS NOT NULL THEN 1 ELSE 0 END
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
        c.Card_Code AS product_code,
        c.Card_Name AS product_name,
        CASE WHEN ecp.order_seq IS NOT NULL THEN 1 ELSE 0 END AS is_copurchase,
        ISNULL(SUM(oi.order_count), 0) AS qty,
        ISNULL(SUM(${ETC_AMOUNT_EXPR}), 0) AS amount,
        MAX(o.settle_method) AS settle_method
      FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
      INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
      INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
      LEFT JOIN SiteInfo si WITH (NOLOCK) ON o.company_Seq = si.CompayCode
      LEFT JOIN etc_copurchase_orders ecp ON o.order_seq = ecp.order_seq
      ${ETC_COUPON_DIVISOR_JOIN_D01}
      WHERE ${D01_FILTER} AND o.order_seq IN (${inList})
        AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 15)
      GROUP BY o.order_seq, c.Card_Code, c.Card_Name, CASE WHEN ecp.order_seq IS NOT NULL THEN 1 ELSE 0 END
    `).then(r => r.recordset.map(row => ({ ...row, _src: 'ETC' }))));
  }
  const mssqlResults = (await Promise.all(queries)).flat();

  // 6) 정산 마커 조회 (전체 한번에) — bg_vendor_settlement_marks
  let marksMap = new Map(); // key = `${order_id}|${product_code}` → mark row
  try {
    const orderIds = [...inWindow.map(ci => ci.order_id)].filter(Boolean);
    if (orderIds.length) {
      const REST = process.env.SUPABASE_URL ? `${process.env.SUPABASE_URL}/rest/v1` : null;
      if (REST) {
        const inClause = orderIds.map(o => `"${o}"`).join(',');
        const hdr = { apikey: process.env.SUPABASE_ANON_KEY, Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}` };
        const url = `${REST}/bg_vendor_settlement_marks?select=*&order_id=in.(${encodeURIComponent(inClause)})&limit=10000`;
        const r = await fetch(url, { headers: hdr });
        if (r.ok) {
          const rows = await r.json();
          for (const m of rows) marksMap.set(`${m.order_id}|${m.product_code}`, m);
        }
      }
    }
  } catch (e) {
    console.warn('[vendor-settlements] marks fetch 실패:', e.message);
  }

  // 7) 필터링 + 통합 row 빌드 — MSSQL 결과 중 위탁상품에 해당하는 (order, product) 만 추출
  //    멀티 그룹 호환: 각 product 의 실제 출고일을 sticker_selection 우선 lookup.
  //    윈도우 외 product 는 (다른 product 가 윈도우 내라 ci 자체는 inWindow 였더라도) skip.
  const items = [];
  for (const row of mssqlResults) {
    const baseCode = _baseProductCode(row.product_code);
    // 원본 또는 base 둘 다로 매핑 시도
    const ps = productByCode.get(row.product_code) || productByCode.get(baseCode);
    if (!ps) continue; // 위탁상품 아님 → 정산 대상 외

    const ciMap = row._src === 'CARD' ? ciByCardSeq : ciByEtcSeq;
    const ci = ciMap.get(row.order_seq);
    if (!ci) continue;

    const vendor = vendorById.get(ps.vendor_id);
    if (!vendor) continue;

    // product 단위 출고일 (멀티 그룹 호환)
    const productShipDate = _shipDateForSel(ci, ps.product_id, baseCode);
    // 윈도우 외 product 는 skip
    if (!productShipDate || productShipDate < startDate || productShipDate > endDate) continue;
    const productIsExpress = _isExpressForSel(ci, ps.product_id, baseCode);

    const isCopurchase = !!row.is_copurchase;
    // 주문유형 필터
    if (filterOrderType === 'copurchase' && !isCopurchase) continue;
    if (filterOrderType === 'standalone' && isCopurchase) continue;

    const grossAmount = Math.round(Number(row.amount) || 0);
    // 수수료율: 상품 override 우선, 없으면 거래처 default
    const commissionRate = (ps.commission_rate !== null && ps.commission_rate !== undefined)
      ? Number(ps.commission_rate)
      : Number(vendor.default_commission_rate || 0);
    const commissionAmount = Math.round(grossAmount * (commissionRate / 100));
    const netAmount = grossAmount - commissionAmount;

    // 정산 상태
    const markKey = `${ci.order_id}|${ps.product_id}`;
    const mark = marksMap.get(markKey);
    const settledAt = mark ? mark.settled_at : null;

    // 정산상태 필터
    if (filterStatus === 'settled' && !settledAt) continue;
    if (filterStatus === 'unsettled' && settledAt) continue;

    items.push({
      order_id: ci.order_id,
      order_seq: row.order_seq,
      product_code: ps.product_id,
      product_name: row.product_name,
      vendor_id: vendor.id,
      vendor_name: vendor.name,
      desired_ship_date: productShipDate,            // product 단위 실제 출고일
      is_express: productIsExpress,                  // product 단위 빠른출고 여부
      is_copurchase: isCopurchase,
      qty: Number(row.qty) || 0,
      gross_amount: grossAmount,
      commission_rate: commissionRate,
      commission_amount: commissionAmount,
      net_amount: netAmount,
      settle_method: row.settle_method != null ? String(row.settle_method) : null, // FirstMall char(1) 코드
      settled_at: settledAt,
      settled_by: mark?.settled_by || null,
    });
  }

  // 정렬 기본: 미정산 우선 + 희망출고일 오름차순 (정산 작업 흐름과 일관)
  items.sort((a, b) => {
    const aSettled = !!a.settled_at;
    const bSettled = !!b.settled_at;
    if (aSettled !== bSettled) return aSettled ? 1 : -1;
    return String(a.desired_ship_date).localeCompare(String(b.desired_ship_date));
  });

  // 요약 집계
  const summary = items.reduce((acc, it) => {
    acc.total_count += 1;
    acc.gross_total += it.gross_amount;
    acc.commission_total += it.commission_amount;
    acc.net_total += it.net_amount;
    if (it.settled_at) { acc.settled_count += 1; acc.settled_net += it.net_amount; }
    else { acc.unsettled_count += 1; acc.unsettled_net += it.net_amount; }
    return acc;
  }, { total_count: 0, settled_count: 0, unsettled_count: 0,
       gross_total: 0, commission_total: 0, net_total: 0,
       settled_net: 0, unsettled_net: 0 });

  return { period: { start: startDate, end: endDate }, items, summary };
}

/** 정산 처리 — bg_vendor_settlement_marks 에 row INSERT (snapshot). */
async function apiVendorSettlementMark(body, session) {
  if (!body || !Array.isArray(body.items) || !body.items.length) {
    return { error: 'items 배열이 필요합니다 (order_id, product_code 포함)' };
  }
  const REST = process.env.SUPABASE_URL ? `${process.env.SUPABASE_URL}/rest/v1` : null;
  if (!REST) return { error: 'Supabase 미설정' };
  const hdr = {
    apikey: process.env.SUPABASE_ANON_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'resolution=merge-duplicates,return=representation',
  };
  const settledBy = session?.user?.user_id || session?.user?.id || 'admin';
  const rows = body.items.map(it => ({
    vendor_id: it.vendor_id,
    order_id: it.order_id,
    product_code: it.product_code,
    desired_ship_date: it.desired_ship_date,
    gross_amount: it.gross_amount || 0,
    commission_rate: it.commission_rate || 0,
    commission_amount: it.commission_amount || 0,
    net_amount: it.net_amount || 0,
    qty: it.qty || 0,
    is_copurchase: !!it.is_copurchase,
    settled_at: new Date().toISOString(),
    settled_by: settledBy,
    memo: it.memo || null,
  }));
  const url = `${REST}/bg_vendor_settlement_marks?on_conflict=order_id,product_code`;
  const r = await fetch(url, { method: 'POST', headers: hdr, body: JSON.stringify(rows) });
  if (!r.ok) {
    const t = await r.text();
    return { error: `정산 처리 실패 [${r.status}]: ${t.slice(0, 300)}` };
  }
  const inserted = await r.json();
  return { ok: true, marked: inserted.length };
}

/** 정산 취소 — bg_vendor_settlement_marks 에서 row DELETE. */
async function apiVendorSettlementUnmark(body, session) {
  if (!body || !Array.isArray(body.items) || !body.items.length) {
    return { error: 'items 배열이 필요합니다 (order_id, product_code 포함)' };
  }
  const REST = process.env.SUPABASE_URL ? `${process.env.SUPABASE_URL}/rest/v1` : null;
  if (!REST) return { error: 'Supabase 미설정' };
  const hdr = {
    apikey: process.env.SUPABASE_ANON_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json',
  };
  let removed = 0;
  for (const it of body.items) {
    if (!it.order_id || !it.product_code) continue;
    const url = `${REST}/bg_vendor_settlement_marks?order_id=eq.${encodeURIComponent(it.order_id)}&product_code=eq.${encodeURIComponent(it.product_code)}`;
    const r = await fetch(url, { method: 'DELETE', headers: hdr });
    if (r.ok) removed += 1;
  }
  return { ok: true, removed };
}

/**
 * 위탁업체 대시보드 — apiVendorSettlements 결과를 한번 더 집계해 KPI / 시계열 / TOP 등 응답.
 *
 * Query: start_date, end_date, vendor_id (optional)
 * 응답:
 *   {
 *     period,
 *     kpi: { total_count, gross_total, commission_total, net_total,
 *            settled_net, unsettled_net, copurchase_net, standalone_net,
 *            vendor_count, product_count },
 *     by_vendor: [{ vendor_id, vendor_name, total_count, gross_total,
 *                   commission_total, net_total, settled_net, unsettled_net }],
 *     by_day: [{ date, gross, commission, net, count }],  // 희망출고일 기준
 *     by_type: { copurchase: {count, net}, standalone: {count, net} },
 *     top_products: [{ product_code, product_name, vendor_name, count, gross, net }]
 *   }
 */
async function apiVendorDashboard(query) {
  // apiVendorSettlements 로 raw items + 기간 가져옴 (필터 일관성)
  const result = await apiVendorSettlements({ ...query, status: 'all', order_type: 'all' });
  const items = Array.isArray(result.items) ? result.items : [];

  const empty = {
    period: result.period,
    kpi: {
      total_count: 0, gross_total: 0, commission_total: 0, net_total: 0,
      settled_net: 0, unsettled_net: 0,
      copurchase_net: 0, standalone_net: 0,
      vendor_count: 0, product_count: 0,
    },
    by_vendor: [], by_day: [], by_type: { copurchase: { count: 0, net: 0 }, standalone: { count: 0, net: 0 } }, top_products: [],
  };
  if (!items.length) return empty;

  // by_vendor 집계
  const vendorMap = new Map();
  const dayMap = new Map();
  const productMap = new Map();
  let copurchaseCount = 0, copurchaseNet = 0;
  let standaloneCount = 0, standaloneNet = 0;
  let grossTotal = 0, commissionTotal = 0, netTotal = 0, settledNet = 0, unsettledNet = 0;

  for (const it of items) {
    const gross = Number(it.gross_amount) || 0;
    const com = Number(it.commission_amount) || 0;
    const net = Number(it.net_amount) || 0;
    grossTotal += gross; commissionTotal += com; netTotal += net;
    if (it.settled_at) settledNet += net; else unsettledNet += net;
    if (it.is_copurchase) { copurchaseCount += 1; copurchaseNet += net; }
    else { standaloneCount += 1; standaloneNet += net; }

    // vendor
    const vKey = it.vendor_id || '_unknown';
    if (!vendorMap.has(vKey)) {
      vendorMap.set(vKey, {
        vendor_id: it.vendor_id, vendor_name: it.vendor_name || '미상',
        total_count: 0, gross_total: 0, commission_total: 0, net_total: 0,
        settled_net: 0, unsettled_net: 0,
      });
    }
    const v = vendorMap.get(vKey);
    v.total_count += 1; v.gross_total += gross; v.commission_total += com; v.net_total += net;
    if (it.settled_at) v.settled_net += net; else v.unsettled_net += net;

    // by_day (희망출고일 기준)
    const day = it.desired_ship_date || '';
    if (day) {
      if (!dayMap.has(day)) dayMap.set(day, { date: day, gross: 0, commission: 0, net: 0, count: 0 });
      const d = dayMap.get(day);
      d.gross += gross; d.commission += com; d.net += net; d.count += 1;
    }

    // top_products
    const pKey = it.product_code + '|' + it.vendor_id;
    if (!productMap.has(pKey)) {
      productMap.set(pKey, {
        product_code: it.product_code, product_name: it.product_name,
        vendor_name: it.vendor_name, count: 0, gross: 0, net: 0,
      });
    }
    const p = productMap.get(pKey);
    p.count += 1; p.gross += gross; p.net += net;
  }

  const by_vendor = [...vendorMap.values()].sort((a, b) => b.net_total - a.net_total);
  const by_day = [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date));
  const top_products = [...productMap.values()].sort((a, b) => b.net - a.net).slice(0, 10);

  return {
    period: result.period,
    kpi: {
      total_count: items.length,
      gross_total: grossTotal, commission_total: commissionTotal, net_total: netTotal,
      settled_net: settledNet, unsettled_net: unsettledNet,
      copurchase_net: copurchaseNet, standalone_net: standaloneNet,
      vendor_count: vendorMap.size, product_count: productMap.size,
    },
    by_vendor,
    by_day,
    by_type: {
      copurchase: { count: copurchaseCount, net: copurchaseNet },
      standalone: { count: standaloneCount, net: standaloneNet },
    },
    top_products,
  };
}

/**
 * 거래처 외부 포털 — 토큰 기반 자기 정산 조회.
 *   public endpoint (인증 없음 — 토큰만으로 권한 식별).
 *   토큰 검증 후 vendor_id 추출 → apiVendorDashboard(vendor_id) 호출 + vendor 정보 포함.
 *   유효하지 않은 토큰: 401 패턴으로 { error } 반환.
 */
async function apiVendorPortal(query) {
  const token = query.token;
  if (!token) return { error: '토큰이 필요합니다.', status: 401 };
  const _bgStore = require('./barungift/store');
  const result = await _bgStore.getVendorByPortalToken(token);
  if (!result) return { error: '유효하지 않거나 만료된 토큰입니다.', status: 401 };
  const { vendor, token_row } = result;
  // 접속 추적 (fire-and-forget, await 안 함)
  _bgStore.touchVendorPortalToken(token_row.id).catch(() => {});
  // 거래처 한정 대시보드 데이터
  const dashboard = await apiVendorDashboard({
    vendor_id: vendor.id,
    start_date: query.start_date,
    end_date: query.end_date,
  });
  // 정산 내역 (테이블 표시용)
  const settlements = await apiVendorSettlements({
    vendor_id: vendor.id,
    start_date: query.start_date,
    end_date: query.end_date,
    status: query.status || 'all',
    order_type: query.order_type || 'all',
  });
  return {
    vendor: {
      id: vendor.id,
      name: vendor.name,
      vendor_code: vendor.vendor_code || null,
      contact_person: vendor.contact_person,
      email: vendor.email,
      default_commission_rate: vendor.default_commission_rate,
    },
    token_info: {
      expires_at: token_row.expires_at,
      last_accessed_at: token_row.last_accessed_at,
      access_count: token_row.access_count,
    },
    period: dashboard.period,
    kpi: dashboard.kpi,
    by_day: dashboard.by_day,
    by_type: dashboard.by_type,
    top_products: dashboard.top_products,
    settlements: settlements.items,
  };
}

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

  // 기간 필터 (JS 측, ship_date 는 'YYYY-MM-DD' 문자열) — 멀티 그룹 호환:
  //   ci.desired_ship_date (대표) 또는 어느 sticker_selection.desired_ship_date 라도 윈도우 내면 포함.
  //   endDate exclusive — _ciInDateWindow 는 inclusive 라 endDate-1d 까지로 조정.
  const endInclusive = (() => {
    if (!endDate) return endDate;
    const d = new Date(endDate); d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  })();
  const inWindow = cInfos.filter(ci => _ciInDateWindow(ci, startDate, endInclusive));
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
        AND co.status_seq >= 1 AND co.status_seq NOT IN (3, 5)
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
        AND o.status_seq >= 1 AND o.status_seq NOT IN (3, 5, 15)
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
  // 카테고리 분기 (shadowing) — apiDashboardComparison 와 동일.
  const categoryCfg = CATEGORY_FILTERS[query.category] || CATEGORY_FILTERS.daeryepum;
  const skipUnitValue = query.category === 'deco';
  const D01_FILTER = categoryCfg.filter;
  const ETC_AMOUNT_EXPR = etcAmountExpr({ skipUnitValue });
  const _cpdFilter = categoryCfg.filter.replace(/\bc\./g, 'c_cpd.');
  const ETC_COUPON_DIVISOR_JOIN_D01 = etcCouponDivisorJoin(_cpdFilter);
  const cardUnitDivisor = skipUnitValue ? '1' : 'ISNULL(NULLIF(c.Unit_Value, 0), 1)';
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

async function apiForecast(query = {}) {
  const p = await getPool();
  // 카테고리 분기 — module-level 상수 shadowing (apiDashboardComparison 와 동일 패턴).
  const categoryCfg = CATEGORY_FILTERS[query.category] || CATEGORY_FILTERS.daeryepum;
  const skipUnitValue = query.category === 'deco';
  const D01_FILTER = categoryCfg.filter;
  const ETC_AMOUNT_EXPR = etcAmountExpr({ skipUnitValue });
  const _cpdFilter = categoryCfg.filter.replace(/\bc\./g, 'c_cpd.');
  const ETC_COUPON_DIVISOR_JOIN_D01 = etcCouponDivisorJoin(_cpdFilter);
  const cardUnitDivisor = skipUnitValue ? '1' : 'ISNULL(NULLIF(c.Unit_Value, 0), 1)';
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
    let weddingInWeek = 0; // 본 주차 [weekStart ~ weekEnd, 7일] 합산 — 28일 풀과 별개로 표시.
    for (let d = -PAST_WINDOW; d <= 6 + FUTURE_WINDOW; d++) {
      const key = fmtDate(addDays(weekStart, d));
      const cnt = weddingDailyMap[key] || 0;
      weddingPool += cnt;
      if (d >= 0 && d <= 6) weddingInWeek += cnt; // 본주차 7일 범위
    }

    weeks.push({
      week_no: getISOWeek(weekStart),
      week_start: fmtDate(weekStart),
      week_end: fmtDate(weekEnd),
      wedding_pool: weddingPool,
      wedding_in_week: weddingInWeek,
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
        WHERE ${D01_FILTER} AND o.order_date >= @awStart AND o.order_date < @awEnd AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 15)
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
        WHERE ${D01_FILTER} AND co.order_date >= @awStart AND co.order_date < @awEnd AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5)
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
        WHERE ${D01_FILTER} AND o.order_date >= @start30 AND o.order_date < DATEADD(day,1,@today) AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 15)

        UNION ALL

        SELECT DISTINCT co.order_seq,
          (SELECT ISNULL(SUM(CAST(coi2.item_sale_price AS float) * coi2.item_count / ISNULL(NULLIF(c2.Unit_Value, 0), 1)), 0) FROM custom_order_item coi2 WITH (NOLOCK) INNER JOIN S2_Card c2 WITH (NOLOCK) ON coi2.card_seq=c2.Card_Seq WHERE coi2.order_seq=co.order_seq AND ${D01_FILTER.replace(/c\./g,'c2.')}) AS settle_price,
          CONVERT(varchar(10), co.order_date, 120) AS order_day
        FROM custom_order co WITH (NOLOCK)
        INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
        INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
        WHERE ${D01_FILTER} AND co.order_date >= @start30 AND co.order_date < DATEADD(day,1,@today) AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5)
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

async function apiLeadtime(query = {}) {
  // 카테고리 분기 — apiDashboardComparison/Summary 와 동일 패턴 (shadowing).
  const categoryCfg = CATEGORY_FILTERS[query.category] || CATEGORY_FILTERS.daeryepum;
  const skipUnitValue = query.category === 'deco';
  const D01_FILTER = categoryCfg.filter;
  const ETC_AMOUNT_EXPR = etcAmountExpr({ skipUnitValue });
  const _cpdFilter = categoryCfg.filter.replace(/\bc\./g, 'c_cpd.');
  const ETC_COUPON_DIVISOR_JOIN_D01 = etcCouponDivisorJoin(_cpdFilter);
  const cardUnitDivisor = skipUnitValue ? '1' : 'ISNULL(NULLIF(c.Unit_Value, 0), 1)';
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
      WHERE ${D01_FILTER} AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 15)
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
      WHERE ${D01_FILTER} AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5)
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
async function apiConversion(query = {}) {
  const p = await getPool();
  // 카테고리 분기 (shadowing).
  const categoryCfg = CATEGORY_FILTERS[query.category] || CATEGORY_FILTERS.daeryepum;
  const skipUnitValue = query.category === 'deco';
  const D01_FILTER = categoryCfg.filter;
  const ETC_AMOUNT_EXPR = etcAmountExpr({ skipUnitValue });
  const _cpdFilter = categoryCfg.filter.replace(/\bc\./g, 'c_cpd.');
  const ETC_COUPON_DIVISOR_JOIN_D01 = etcCouponDivisorJoin(_cpdFilter);
  const cardUnitDivisor = skipUnitValue ? '1' : 'ISNULL(NULLIF(c.Unit_Value, 0), 1)';
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
        AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 15)
      GROUP BY CONVERT(varchar(10), o.order_date, 120)

      UNION ALL

      SELECT CONVERT(varchar(10), co.order_date, 120), COUNT(DISTINCT co.order_seq)
      FROM custom_order co WITH (NOLOCK)
      INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
      INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
      WHERE ${D01_FILTER} AND co.order_date >= @os AND co.order_date < @oe
        AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5)
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

/**
 * CI row 의 가장 최근 활동 timestamp 추출 — 정보입력 ~ 출고완료 모든 stage 포함.
 *   순회: submitted_at, updated_at, processed_at + 각 sticker_selection 의
 *         sticker_completed_at / printed_at / bound_at / packed_at / shipped_at.
 *   '기간 내 어떤 stage 든 활동한 주문 모두' 필터링 기준 timestamp.
 */
function _getCiLatestActivity(ci) {
  if (!ci) return null;
  const dates = [];
  if (ci.submitted_at) dates.push(ci.submitted_at);
  if (ci.updated_at) dates.push(ci.updated_at);
  if (ci.processed_at) dates.push(ci.processed_at);
  const sels = Array.isArray(ci.sticker_selections) ? ci.sticker_selections : [];
  for (const sel of sels) {
    if (!sel) continue;
    if (sel.sticker_completed_at) dates.push(sel.sticker_completed_at);
    if (sel.printed_at) dates.push(sel.printed_at);
    if (sel.bound_at) dates.push(sel.bound_at);
    if (sel.packed_at) dates.push(sel.packed_at);
    if (sel.shipped_at) dates.push(sel.shipped_at);
  }
  if (!dates.length) return null;
  // ISO 8601 timestamp 는 문자열 비교로도 시간 순서 정확 — Date 변환 불필요.
  return dates.reduce((mx, d) => (d > mx ? d : mx));
}

/**
 * orphan CI 스캔 + cleanup — prefix 누락된 bg_order_customer_info row 정리.
 *
 *   현재 운영 DB 에 raw 숫자 (예: '3244222') 로 저장된 CI 가 존재.
 *   frontend 의 bgCiKey 는 ETC 주문에 'ETC-3244222' 를 lookup → 미매칭으로 미입력 잘못 표시.
 *   (현재 fallback 매칭으로 display 는 해결됐지만, DB 레벨 정리가 필요)
 *
 *   classify:
 *     - to_migrate: orphan 만 존재 + MSSQL 에서 ETC 확인 → rename ('X' → 'ETC-X')
 *     - conflict: orphan AND canonical 둘 다 → manual_review 보고만
 *     - card_already_canonical: MSSQL 이 CARD 주문 → raw seq 가 이미 canonical (skip)
 *     - no_mssql_match: MSSQL 에 없음 → 보고만 (delete 위험해서 안 함)
 *
 *   options: { execute: bool }
 *     - false: dry-run, 계획만 반환
 *     - true: to_migrate 만 rename 실행
 */
async function scanAndCleanupOrphanCi({ execute }) {
  const SUPABASE_URL = process.env.SUPABASE_URL || '';
  const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || '';
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return { error: 'SUPABASE 미설정' };
  }
  const REST = `${SUPABASE_URL}/rest/v1`;
  const HDR = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' };

  // 1) 전체 CI 의 order_id 수집 (필요 필드만, 페이로드 최소화)
  const listRes = await fetch(`${REST}/bg_order_customer_info?select=order_id,submitted_at,updated_at&limit=20000`, { headers: HDR });
  if (!listRes.ok) {
    return { error: `Supabase fetch failed: ${listRes.status}` };
  }
  const allCi = await listRes.json();
  const orphans = []; // raw 숫자
  const canonicalSet = new Set(); // ETC-/CP-/NV- 접두
  for (const ci of allCi) {
    const oid = String(ci.order_id || '');
    if (/^\d+$/.test(oid)) {
      orphans.push({ order_id: oid, submitted_at: ci.submitted_at, updated_at: ci.updated_at });
    } else if (oid.startsWith('ETC-') || oid.startsWith('CP-') || oid.startsWith('NV-')) {
      canonicalSet.add(oid);
    }
  }

  if (!orphans.length) {
    return { scanned: allCi.length, orphans: 0, plan: [], message: 'orphan CI 없음' };
  }

  // 2) MSSQL 에서 orphan seq 의 order_type 확인 (chunk 단위)
  const pool = await getPool();
  const orphanSeqs = orphans.map(o => parseInt(o.order_id)).filter(n => Number.isInteger(n) && n > 0);
  const CHUNK = 500;
  const etcSet = new Set();
  const cardSet = new Set();
  for (let i = 0; i < orphanSeqs.length; i += CHUNK) {
    const chunk = orphanSeqs.slice(i, i + CHUNK);
    const phs = chunk.map((_, idx) => `@s${idx}`).join(',');
    const r1 = pool.request();
    chunk.forEach((s, idx) => r1.input(`s${idx}`, sql.Int, s));
    try {
      const etcR = await r1.query(`SELECT DISTINCT order_seq FROM CUSTOM_ETC_ORDER WITH (NOLOCK) WHERE order_seq IN (${phs})`);
      etcR.recordset.forEach(row => etcSet.add(row.order_seq));
    } catch (e) {
      console.warn('[scan-orphan-ci] ETC lookup chunk 실패:', e.message);
    }
    const r2 = pool.request();
    chunk.forEach((s, idx) => r2.input(`s${idx}`, sql.Int, s));
    try {
      const cardR = await r2.query(`SELECT DISTINCT order_seq FROM custom_order WITH (NOLOCK) WHERE order_seq IN (${phs})`);
      cardR.recordset.forEach(row => cardSet.add(row.order_seq));
    } catch (e) {
      console.warn('[scan-orphan-ci] CARD lookup chunk 실패:', e.message);
    }
  }

  // 3) 분류 및 계획 생성
  const plan = orphans.map(o => {
    const seq = parseInt(o.order_id);
    const isEtc = etcSet.has(seq);
    const isCard = cardSet.has(seq);
    if (!isEtc && !isCard) {
      return { ...o, status: 'no_mssql_match', action: 'skip', message: 'MSSQL 에 주문 없음' };
    }
    if (isCard && !isEtc) {
      return { ...o, status: 'card_already_canonical', action: 'skip', message: 'CARD 주문은 raw seq 가 canonical' };
    }
    // ETC (또는 ETC + CARD 둘 다 — 드물지만 처리)
    const newId = `ETC-${seq}`;
    if (canonicalSet.has(newId)) {
      return { ...o, status: 'conflict', action: 'manual_review', new_id: newId, message: 'canonical 도 존재 — 수동 검토 필요' };
    }
    return { ...o, status: 'to_migrate', action: 'rename', new_id: newId };
  });

  // 4) 실행 (옵션)
  const toMigrate = plan.filter(p => p.action === 'rename');
  let renamed = 0, errors = 0;
  const errorSamples = [];
  if (execute && toMigrate.length) {
    for (const item of toMigrate) {
      try {
        const url = `${REST}/bg_order_customer_info?order_id=eq.${encodeURIComponent(item.order_id)}`;
        const res = await fetch(url, {
          method: 'PATCH',
          headers: { ...HDR, Prefer: 'return=minimal' },
          body: JSON.stringify({ order_id: item.new_id, updated_at: new Date().toISOString() }),
        });
        if (res.ok) {
          renamed++;
        } else {
          errors++;
          const text = await res.text();
          if (errorSamples.length < 5) errorSamples.push({ order_id: item.order_id, status: res.status, detail: text.slice(0, 200) });
          console.warn(`[cleanup-orphan-ci] ${item.order_id} → ${item.new_id} 실패 [${res.status}]: ${text.slice(0, 200)}`);
        }
      } catch (e) {
        errors++;
        if (errorSamples.length < 5) errorSamples.push({ order_id: item.order_id, exception: e.message });
        console.warn(`[cleanup-orphan-ci] ${item.order_id} 예외:`, e.message);
      }
    }
  }

  return {
    scanned: allCi.length,
    orphan_count: orphans.length,
    summary: {
      to_migrate: plan.filter(p => p.action === 'rename').length,
      conflict: plan.filter(p => p.action === 'manual_review').length,
      no_mssql_match: plan.filter(p => p.status === 'no_mssql_match').length,
      card_already_canonical: plan.filter(p => p.status === 'card_already_canonical').length,
    },
    plan,
    executed: !!execute,
    renamed: execute ? renamed : null,
    errors: execute ? errors : null,
    error_samples: execute && errorSamples.length ? errorSamples : undefined,
    message: execute
      ? `${renamed}건 rename 완료${errors ? `, ${errors}건 실패` : ''}${plan.filter(p => p.action === 'manual_review').length ? `, 충돌 ${plan.filter(p => p.action === 'manual_review').length}건은 수동 검토 필요` : ''}.`
      : `dry-run — to_migrate ${plan.filter(p => p.action === 'rename').length}건, conflict ${plan.filter(p => p.action === 'manual_review').length}건, no_mssql ${plan.filter(p => p.status === 'no_mssql_match').length}건. POST /api/admin/cleanup-orphan-ci 로 실행.`,
  };
}

// === 3-way 리드타임 분석 (주문 / 희망출고 / 예식) ===
//   bg_order_customer_info.desired_ship_date + MSSQL order_date + wedding_date 조인.
//   3개 리드타임 계산:
//     ① 주문 → 희망출고 (제조/배송 LT — 운영 처리시간)
//     ② 희망출고 → 예식 (예식 buffer — 고객이 며칠 전 받기 원하는지)
//     ③ 주문 → 예식 (전체 LT — 고객 주문 시점 결정 패턴)
//   기간: submitted_at 기준 (default 90일).
//   대상: CI 입력 완료 + desired_ship_date 있음 + ETC/CARD 주문 (CP/NV 제외 — wedding 정보 없음).
async function apiLeadtime3way(query) {
  const _bgStore = require('./barungift/store');
  const endDate = query.end_date || fmtDate(addDays(today(), 1));
  const startDate = query.start_date || fmtDate(addDays(today(), -90));

  const FALLBACK = { order_to_ship: null, ship_to_wedding: null, order_to_wedding: null, period: { start: startDate, end: endDate, ci_with_ship_date: 0, total_samples: 0 } };

  let allCi = [];
  try {
    allCi = await _bgStore.getCustomerInfosWithShipDate();
  } catch (e) {
    console.warn('[leadtime-3way] CI fetch 실패:', e.message);
    return FALLBACK;
  }
  // 기간 + desired_ship_date 필터.
  //   '기간 내 어떤 stage 든 활동한 주문 모두' — submitted_at + 워크플로우 timestamps 의 max.
  const inRange = allCi.filter(ci => {
    if (!ci.desired_ship_date) return false;
    const latest = _getCiLatestActivity(ci);
    if (!latest) return false;
    const day = String(latest).slice(0, 10);
    return day >= startDate && day <= endDate;
  });
  if (!inRange.length) return { ...FALLBACK, period: { ...FALLBACK.period, ci_with_ship_date: 0 } };

  // order_id prefix 별 분리 — ETC-/CARD(raw 숫자)/CP-/NV-
  const etcMap = new Map(); // seq -> ci
  const cardMap = new Map();
  inRange.forEach(ci => {
    const oid = String(ci.order_id);
    if (oid.startsWith('ETC-')) {
      const seq = parseInt(oid.slice(4));
      if (Number.isInteger(seq) && seq > 0) etcMap.set(seq, ci);
    } else if (/^\d+$/.test(oid)) {
      const seq = parseInt(oid);
      if (Number.isInteger(seq) && seq > 0) cardMap.set(seq, ci);
    }
    // CP-/NV- 는 wedding_date 정보 없어 skip
  });

  let p;
  try { p = await getPool(); }
  catch (e) {
    console.warn('[leadtime-3way] pool 실패:', e.message);
    return FALLBACK;
  }

  // 결과 row: { orderDate, shipDate, weddingDate }
  const rows = [];
  const CHUNK = 500;

  // === ETC: order_date 조회 + member_id 추출 ===
  const etcSeqs = [...etcMap.keys()];
  const etcMembers = new Map(); // member_id -> [{ seq, orderDate }]
  for (let i = 0; i < etcSeqs.length; i += CHUNK) {
    const chunk = etcSeqs.slice(i, i + CHUNK);
    const req = p.request();
    const placeholders = chunk.map((_, idx) => { req.input(`s${idx}`, sql.Int, chunk[idx]); return `@s${idx}`; }).join(',');
    try {
      const r = await req.query(`
        SELECT o.order_seq, o.member_id, CONVERT(varchar(10), o.order_date, 120) AS order_date
        FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
        WHERE o.order_seq IN (${placeholders})
      `);
      r.recordset.forEach(row => {
        const ci = etcMap.get(row.order_seq);
        if (!ci) return;
        const arr = etcMembers.get(row.member_id) || [];
        arr.push({ seq: row.order_seq, orderDate: row.order_date, shipDate: ci.desired_ship_date });
        etcMembers.set(row.member_id, arr);
      });
    } catch (e) {
      console.warn('[leadtime-3way] ETC order_date fetch 실패:', e.message);
    }
  }

  // === ETC: member_id 별 wedding_date 후보 lookup (apiLeadtime 동일 패턴) ===
  const etcMemberIds = [...etcMembers.keys()].filter(Boolean);
  const memberWeddings = new Map(); // member_id -> Date[]
  for (let i = 0; i < etcMemberIds.length; i += CHUNK) {
    const chunk = etcMemberIds.slice(i, i + CHUNK);
    const req = p.request();
    const placeholders = chunk.map((_, idx) => { req.input(`m${idx}`, sql.VarChar, String(chunk[idx])); return `@m${idx}`; }).join(',');
    try {
      const r = await req.query(`
        SELECT DISTINCT co.member_id,
          TRY_CAST(w.event_year+'-'+RIGHT('0'+w.event_month,2)+'-'+RIGHT('0'+w.event_Day,2) AS date) AS wedding_date
        FROM custom_order co WITH (NOLOCK)
        INNER JOIN custom_order_WeddInfo w WITH (NOLOCK) ON co.order_seq = w.order_seq
        WHERE co.member_id IN (${placeholders})
          AND co.status_seq >= 1
          AND w.event_year IS NOT NULL AND LEN(w.event_year) = 4
          AND TRY_CAST(w.event_year+'-'+RIGHT('0'+w.event_month,2)+'-'+RIGHT('0'+w.event_Day,2) AS date) IS NOT NULL
      `);
      r.recordset.forEach(row => {
        if (!row.wedding_date) return;
        const arr = memberWeddings.get(row.member_id) || [];
        arr.push(new Date(row.wedding_date));
        memberWeddings.set(row.member_id, arr);
      });
    } catch (e) {
      console.warn('[leadtime-3way] ETC wedding lookup 실패:', e.message);
    }
  }
  // ETC: 주문일 기준 최적 wedding 매칭 (apiLeadtime 정책 — 주문 후 가장 가까운 결혼식, 없으면 -14일 까지 허용)
  for (const [memberId, orders] of etcMembers) {
    const candidates = memberWeddings.get(memberId) || [];
    orders.forEach(o => {
      const orderDt = new Date(o.orderDate);
      let best = null;
      for (const w of candidates) {
        const diff = Math.round((w - orderDt) / 86400000);
        if (diff >= -14) {
          if (!best || diff < best.diff) best = { wd: w, diff };
        }
      }
      rows.push({
        orderDate: o.orderDate,
        shipDate: o.shipDate,
        weddingDate: best ? best.wd.toISOString().slice(0, 10) : null,
      });
    });
  }

  // === CARD: order_date + wedding_date direct JOIN ===
  const cardSeqs = [...cardMap.keys()];
  for (let i = 0; i < cardSeqs.length; i += CHUNK) {
    const chunk = cardSeqs.slice(i, i + CHUNK);
    const req = p.request();
    const placeholders = chunk.map((_, idx) => { req.input(`c${idx}`, sql.Int, chunk[idx]); return `@c${idx}`; }).join(',');
    try {
      const r = await req.query(`
        SELECT co.order_seq, CONVERT(varchar(10), co.order_date, 120) AS order_date,
          TRY_CAST(w.event_year+'-'+RIGHT('0'+w.event_month,2)+'-'+RIGHT('0'+w.event_Day,2) AS date) AS wedding_date
        FROM custom_order co WITH (NOLOCK)
        LEFT JOIN custom_order_WeddInfo w WITH (NOLOCK) ON co.order_seq = w.order_seq
          AND w.event_year IS NOT NULL AND LEN(w.event_year) = 4
        WHERE co.order_seq IN (${placeholders})
      `);
      r.recordset.forEach(row => {
        const ci = cardMap.get(row.order_seq);
        if (!ci) return;
        rows.push({
          orderDate: row.order_date,
          shipDate: ci.desired_ship_date,
          weddingDate: row.wedding_date ? row.wedding_date.toISOString().slice(0, 10) : null,
        });
      });
    } catch (e) {
      console.warn('[leadtime-3way] CARD fetch 실패:', e.message);
    }
  }

  // === 3개 리드타임 계산 ===
  const orderToShip = [], shipToWedding = [], orderToWedding = [];
  for (const r of rows) {
    if (!r.orderDate || !r.shipDate) continue;
    const oDt = new Date(r.orderDate);
    const sDt = new Date(r.shipDate);
    const ots = Math.round((sDt - oDt) / 86400000);
    orderToShip.push(ots);
    if (r.weddingDate) {
      const wDt = new Date(r.weddingDate);
      const stw = Math.round((wDt - sDt) / 86400000);
      const otw = Math.round((wDt - oDt) / 86400000);
      shipToWedding.push(stw);
      orderToWedding.push(otw);
    }
  }

  // 통계 + distribution 계산
  function statsOf(values) {
    const v = values.slice().sort((a, b) => a - b);
    if (!v.length) return { samples: 0, mean: null, median: null, p25: null, p75: null, p90: null, min: null, max: null };
    const mean = Math.round(v.reduce((s, x) => s + x, 0) / v.length);
    return {
      samples: v.length,
      mean,
      median: v[Math.floor(v.length / 2)],
      p25: v[Math.floor(v.length * 0.25)],
      p75: v[Math.floor(v.length * 0.75)],
      p90: v[Math.floor(v.length * 0.90)],
      min: v[0],
      max: v[v.length - 1],
    };
  }
  function distOf(values, buckets) {
    const dist = buckets.map(b => ({ ...b, count: 0 }));
    values.forEach(v => {
      for (const b of dist) {
        if (v >= b.min && v <= b.max) { b.count++; break; }
      }
    });
    return dist;
  }

  return {
    order_to_ship: {
      ...statsOf(orderToShip),
      distribution: distOf(orderToShip, [
        { label: '0~3일', min: 0, max: 3 },
        { label: '4~7일', min: 4, max: 7 },
        { label: '8~14일', min: 8, max: 14 },
        { label: '15~21일', min: 15, max: 21 },
        { label: '22~30일', min: 22, max: 30 },
        { label: '30일+', min: 31, max: 99999 },
      ]),
    },
    ship_to_wedding: {
      ...statsOf(shipToWedding),
      distribution: distOf(shipToWedding, [
        { label: '예식 후', min: -9999, max: -1 },
        { label: '당일', min: 0, max: 0 },
        { label: '1~3일 전', min: 1, max: 3 },
        { label: '4~7일 전', min: 4, max: 7 },
        { label: '8~14일 전', min: 8, max: 14 },
        { label: '15일+ 전', min: 15, max: 9999 },
      ]),
    },
    order_to_wedding: {
      ...statsOf(orderToWedding),
      distribution: distOf(orderToWedding, [
        { label: '~7일', min: 0, max: 7 },
        { label: '8~14일', min: 8, max: 14 },
        { label: '15~21일', min: 15, max: 21 },
        { label: '22~30일', min: 22, max: 30 },
        { label: '31~60일', min: 31, max: 60 },
        { label: '60일+', min: 61, max: 99999 },
      ]),
    },
    period: { start: startDate, end: endDate, ci_with_ship_date: inRange.length, total_samples: rows.length },
  };
}

// === 스티커 · 메시지 분석 (정보입력 완료 주문 기준) ===
// ============================================
// 예식일 캘린더 — GET /api/dashboard/wedding-calendar?year=2026&month=6
//
// 운영팀이 수동 관리하던 '월별 예식자 캘린더' 스프레드시트 자동화.
//   캘린더 그리드 (일~토) × 사이트별 (바른손카드/바른손몰/디얼디어/바른손M카드/기타)
//   회원 가입사이트 = S2_UserInfo.REFERER_SALES_GUBUN → SiteInfo.SiteName 매핑
//   site_div='SB' 로 통합회원 중복 제거, USE_YORN='Y' 활성 회원만
//
// 응답:
//   {
//     year, month,
//     month_start, month_end,                        // 1일 ~ 말일
//     grid_start, grid_end,                          // 1주차 시작 일요일 ~ 마지막주차 토요일
//     weeks: [                                       // 캘린더 그리드 (보통 5~6 주차)
//       {
//         week_index: 1,
//         days: [{date, day_of_week, in_month}, ...],  // 7일
//         by_site: { 바른손카드: [d1..d7], 바른손몰: [...], ... },
//         week_total_by_site: { 바른손카드: N, ... },
//         week_total: N,
//       }, ...
//     ],
//     month_summary: {
//       by_site: {
//         바른손카드: { total, weekend, weekday, weekend_pct },
//         ...
//         합: { total, weekend, weekday, weekend_pct },
//       },
//     },
//     prev_year_summary: {                           // 전년 동월 비교
//       by_site: { 바른손카드: total, ... },
//       delta_by_site: { 바른손카드: { count: +N, pct: +X.X }, ... },
//     },
//   }
// ============================================
const WEDDING_CALENDAR_SITES = ['바른손카드', '바른손몰', '디얼디어', '바른손M카드'];

async function apiWeddingCalendar(query = {}) {
  const now = today();
  const year = parseInt(query.year, 10) || now.getFullYear();
  const month = parseInt(query.month, 10) || (now.getMonth() + 1);
  if (year < 2000 || year > 2100 || month < 1 || month > 12) {
    return { error: 'year/month 범위 오류' };
  }

  const monthStart = new Date(year, month - 1, 1);
  const monthEnd = new Date(year, month, 0); // 말일
  // 그리드 시작 = 월 1일이 속한 주의 일요일, 끝 = 말일이 속한 주의 토요일
  const gridStart = addDays(monthStart, -monthStart.getDay());
  const gridEnd = addDays(monthEnd, 6 - monthEnd.getDay());
  // 전년 동월
  const prevMonthStart = new Date(year - 1, month - 1, 1);
  const prevMonthEnd = new Date(year - 1, month, 0);

  const p = await getPool();

  // 1) 현재 월 그리드 범위의 사이트별 일별 예식자 수
  const r1 = await p.request()
    .input('ws', sql.VarChar, fmtDate(gridStart))
    .input('we', sql.VarChar, fmtDate(addDays(gridEnd, 1)))
    .query(`
      SELECT wd, site_name, COUNT(*) AS wedding_count
      FROM (
        SELECT DISTINCT u.uid,
          CONVERT(varchar(10), TRY_CAST(u.wedd_year+'-'+RIGHT('0'+u.wedd_month,2)+'-'+RIGHT('0'+u.wedd_day,2) AS date), 120) AS wd,
          ISNULL(si.SiteName, '기타') AS site_name
        FROM S2_UserInfo u WITH (NOLOCK)
        LEFT JOIN SiteInfo si ON u.REFERER_SALES_GUBUN = si.SiteCode
        WHERE u.site_div = 'SB'
          AND u.USE_YORN = 'Y'
          AND u.wedd_year IS NOT NULL AND LEN(u.wedd_year) = 4
          AND TRY_CAST(u.wedd_year+'-'+RIGHT('0'+u.wedd_month,2)+'-'+RIGHT('0'+u.wedd_day,2) AS date) >= @ws
          AND TRY_CAST(u.wedd_year+'-'+RIGHT('0'+u.wedd_month,2)+'-'+RIGHT('0'+u.wedd_day,2) AS date) < @we
      ) t
      GROUP BY wd, site_name
      ORDER BY wd
    `);

  // 2) 전년 동월 사이트별 총합 (비교 카드용)
  const r2 = await p.request()
    .input('ws', sql.VarChar, fmtDate(prevMonthStart))
    .input('we', sql.VarChar, fmtDate(addDays(prevMonthEnd, 1)))
    .query(`
      SELECT site_name, COUNT(*) AS wedding_count
      FROM (
        SELECT DISTINCT u.uid,
          ISNULL(si.SiteName, '기타') AS site_name
        FROM S2_UserInfo u WITH (NOLOCK)
        LEFT JOIN SiteInfo si ON u.REFERER_SALES_GUBUN = si.SiteCode
        WHERE u.site_div = 'SB'
          AND u.USE_YORN = 'Y'
          AND u.wedd_year IS NOT NULL AND LEN(u.wedd_year) = 4
          AND TRY_CAST(u.wedd_year+'-'+RIGHT('0'+u.wedd_month,2)+'-'+RIGHT('0'+u.wedd_day,2) AS date) >= @ws
          AND TRY_CAST(u.wedd_year+'-'+RIGHT('0'+u.wedd_month,2)+'-'+RIGHT('0'+u.wedd_day,2) AS date) < @we
      ) t
      GROUP BY site_name
    `);

  // 사이트 정규화: 4개 메인 외 모두 '기타'
  const normSite = (s) => WEDDING_CALENDAR_SITES.includes(s) ? s : '기타';
  const ALL_SITES = [...WEDDING_CALENDAR_SITES, '기타'];

  // dailyMap: { 'YYYY-MM-DD': { 바른손카드: N, ... } }
  const dailyMap = {};
  r1.recordset.forEach(row => {
    if (!dailyMap[row.wd]) dailyMap[row.wd] = {};
    const s = normSite(row.site_name);
    dailyMap[row.wd][s] = (dailyMap[row.wd][s] || 0) + row.wedding_count;
  });

  // 그리드 weeks 빌드
  const weeks = [];
  let weekIdx = 0;
  for (let d = new Date(gridStart); d <= gridEnd; d = addDays(d, 7)) {
    weekIdx++;
    const days = [];
    const bySite = {};
    const weekTotalBySite = {};
    ALL_SITES.forEach(s => { bySite[s] = []; weekTotalBySite[s] = 0; });
    let weekTotal = 0;
    for (let i = 0; i < 7; i++) {
      const dt = addDays(d, i);
      const key = fmtDate(dt);
      const inMonth = dt.getMonth() === (month - 1) && dt.getFullYear() === year;
      days.push({ date: key, day_of_week: dt.getDay(), in_month: inMonth });
      const cell = dailyMap[key] || {};
      ALL_SITES.forEach(s => {
        const v = inMonth ? (cell[s] || 0) : 0; // 월 외 셀은 0 (캡쳐와 동일 — 회색 처리)
        bySite[s].push(v);
        weekTotalBySite[s] += v;
        weekTotal += v;
      });
    }
    weeks.push({
      week_index: weekIdx,
      days,
      by_site: bySite,
      week_total_by_site: weekTotalBySite,
      week_total: weekTotal,
    });
  }

  // 월 통합 KPI: 사이트별 total / weekend (토일) / weekday / 주말비중
  const monthSummary = { by_site: {} };
  ALL_SITES.forEach(s => { monthSummary.by_site[s] = { total: 0, weekend: 0, weekday: 0, weekend_pct: 0 }; });
  let totalAll = 0, weekendAll = 0;
  weeks.forEach(w => {
    w.days.forEach((day, i) => {
      if (!day.in_month) return;
      const cell = dailyMap[day.date] || {};
      const isWeekend = day.day_of_week === 0 || day.day_of_week === 6;
      ALL_SITES.forEach(s => {
        const v = cell[s] || 0;
        monthSummary.by_site[s].total += v;
        if (isWeekend) monthSummary.by_site[s].weekend += v;
        else monthSummary.by_site[s].weekday += v;
      });
      const dayTotal = ALL_SITES.reduce((sum, s) => sum + (cell[s] || 0), 0);
      totalAll += dayTotal;
      if (isWeekend) weekendAll += dayTotal;
    });
  });
  ALL_SITES.forEach(s => {
    const row = monthSummary.by_site[s];
    row.weekend_pct = row.total > 0 ? Math.round(row.weekend / row.total * 1000) / 10 : 0;
  });
  monthSummary.total = totalAll;
  monthSummary.weekend = weekendAll;
  monthSummary.weekday = totalAll - weekendAll;
  monthSummary.weekend_pct = totalAll > 0 ? Math.round(weekendAll / totalAll * 1000) / 10 : 0;

  // 전년 비교
  const prevBySite = {};
  ALL_SITES.forEach(s => prevBySite[s] = 0);
  r2.recordset.forEach(row => { prevBySite[normSite(row.site_name)] += row.wedding_count; });
  const prevTotalAll = ALL_SITES.reduce((sum, s) => sum + prevBySite[s], 0);
  const deltaBySite = {};
  ALL_SITES.forEach(s => {
    const cur = monthSummary.by_site[s].total;
    const prev = prevBySite[s];
    deltaBySite[s] = {
      count: cur - prev,
      pct: prev > 0 ? Math.round((cur - prev) / prev * 1000) / 10 : (cur > 0 ? null : 0),
    };
  });
  const deltaTotal = {
    count: totalAll - prevTotalAll,
    pct: prevTotalAll > 0 ? Math.round((totalAll - prevTotalAll) / prevTotalAll * 1000) / 10 : (totalAll > 0 ? null : 0),
  };

  return {
    year,
    month,
    month_start: fmtDate(monthStart),
    month_end: fmtDate(monthEnd),
    grid_start: fmtDate(gridStart),
    grid_end: fmtDate(gridEnd),
    sites: ALL_SITES,
    weeks,
    month_summary: monthSummary,
    prev_year_summary: {
      year: year - 1,
      month,
      by_site: prevBySite,
      total: prevTotalAll,
      delta_by_site: deltaBySite,
      delta_total: deltaTotal,
    },
  };
}

// ============================================
// 예식일 캘린더 트렌드 — GET /api/dashboard/wedding-calendar/trend?end_year=Y&end_month=M&months=12
//
// 사이트별 월별 합계 시계열 — Chart.js 라인 차트 데이터.
//   end_year/end_month 까지의 최근 N개월 (기본 12개월).
//   응답: { months: [{year, month, label, by_site:{사이트: total}, total}, ...] }
// ============================================
async function apiWeddingCalendarTrend(query = {}) {
  const now = today();
  const endYear = parseInt(query.end_year, 10) || now.getFullYear();
  const endMonth = parseInt(query.end_month, 10) || (now.getMonth() + 1);
  const months = Math.min(36, Math.max(3, parseInt(query.months, 10) || 12));

  // 범위: 마지막 월 말일 + 1일 ~ 시작 월 1일
  const endDateExclusive = new Date(endYear, endMonth, 1); // 다음달 1일
  const startDate = new Date(endYear, endMonth - months, 1);
  if (startDate < new Date(2000, 0, 1)) return { error: '기간 범위 오류' };

  const p = await getPool();
  const r = await p.request()
    .input('ws', sql.VarChar, fmtDate(startDate))
    .input('we', sql.VarChar, fmtDate(endDateExclusive))
    .query(`
      SELECT
        YEAR(t.wd_date) AS y,
        MONTH(t.wd_date) AS m,
        t.site_name,
        COUNT(*) AS wedding_count
      FROM (
        SELECT DISTINCT u.uid,
          TRY_CAST(u.wedd_year+'-'+RIGHT('0'+u.wedd_month,2)+'-'+RIGHT('0'+u.wedd_day,2) AS date) AS wd_date,
          ISNULL(si.SiteName, '기타') AS site_name
        FROM S2_UserInfo u WITH (NOLOCK)
        LEFT JOIN SiteInfo si ON u.REFERER_SALES_GUBUN = si.SiteCode
        WHERE u.site_div = 'SB'
          AND u.USE_YORN = 'Y'
          AND u.wedd_year IS NOT NULL AND LEN(u.wedd_year) = 4
          AND TRY_CAST(u.wedd_year+'-'+RIGHT('0'+u.wedd_month,2)+'-'+RIGHT('0'+u.wedd_day,2) AS date) >= @ws
          AND TRY_CAST(u.wedd_year+'-'+RIGHT('0'+u.wedd_month,2)+'-'+RIGHT('0'+u.wedd_day,2) AS date) < @we
      ) t
      GROUP BY YEAR(t.wd_date), MONTH(t.wd_date), t.site_name
      ORDER BY YEAR(t.wd_date), MONTH(t.wd_date)
    `);

  const normSite = (s) => WEDDING_CALENDAR_SITES.includes(s) ? s : '기타';
  const ALL_SITES = [...WEDDING_CALENDAR_SITES, '기타'];
  // key = `${y}-${m}` → { 바른손카드: n, ... }
  const map = {};
  r.recordset.forEach(row => {
    const key = `${row.y}-${row.m}`;
    if (!map[key]) map[key] = {};
    const s = normSite(row.site_name);
    map[key][s] = (map[key][s] || 0) + row.wedding_count;
  });
  // months 배열 빌드 (시작월부터 endMonth 까지 순서)
  const out = [];
  let cur = new Date(startDate);
  while (cur < endDateExclusive) {
    const y = cur.getFullYear();
    const m = cur.getMonth() + 1;
    const cell = map[`${y}-${m}`] || {};
    const bySite = {};
    let total = 0;
    ALL_SITES.forEach(s => { const v = cell[s] || 0; bySite[s] = v; total += v; });
    out.push({ year: y, month: m, label: `${y}.${String(m).padStart(2, '0')}`, by_site: bySite, total });
    cur = new Date(y, m, 1); // 다음 달
  }

  return { end_year: endYear, end_month: endMonth, months: out, sites: ALL_SITES };
}

//   bg_order_customer_info.sticker_selections JSONB 를 집계 — 다음 두 가지 분석:
//   1) 상품별 스티커 인기도 (Top 10 상품 × 스티커별 선택률)
//   2) 메시지 분석 — 입력률, 길이 통계, 자주 등장 단어 / 키워드 카테고리
//   기간 필터: submitted_at 기준 (기본 최근 90일).
async function apiStickerAnalytics(query) {
  const _bgStore = require('./barungift/store');
  const endDate = query.end_date || fmtDate(addDays(today(), 1));
  const startDate = query.start_date || fmtDate(addDays(today(), -90));

  let allCi = [];
  try {
    allCi = await _bgStore.getAllCustomerInfos();
  } catch (e) {
    console.warn('[sticker-analytics] CI fetch 실패:', e.message);
    return { products: [], messages: { total: 0 }, period: { start: startDate, end: endDate, ci_count: 0 } };
  }
  // 기간 필터 — '기간 내 어떤 stage 든 활동한 주문 모두' (submitted + 모든 워크플로우 timestamps max).
  //   입력완료 → 출고완료 까지 어느 stage 에서든 timestamp 가 기간 내면 포함.
  const inRange = allCi.filter(ci => {
    const latest = _getCiLatestActivity(ci);
    if (!latest) return false;
    const day = String(latest).slice(0, 10);
    return day >= startDate && day <= endDate;
  });

  // 집계
  const productMap = new Map(); // product_code -> { product_name, total, stickerMap }
  const messages = [];
  for (const ci of inRange) {
    const sels = Array.isArray(ci.sticker_selections) ? ci.sticker_selections : [];
    for (const sel of sels) {
      const pc = sel.product_code;
      if (!pc) continue;
      let p = productMap.get(pc);
      if (!p) {
        p = { product_code: pc, product_name: sel.product_name || pc, total: 0, stickerMap: new Map() };
        productMap.set(pc, p);
      }
      p.total++;
      const sCode = (sel.sticker_code || '').trim() || null;
      const sName = (sel.sticker_name || '').trim() || null;
      const key = sCode || '_no_sticker';
      let s = p.stickerMap.get(key);
      if (!s) {
        s = { sticker_code: sCode, sticker_name: sName, count: 0 };
        p.stickerMap.set(key, s);
      }
      s.count++;
      // 메시지 수집 (custom_values 모든 string 값)
      const cv = sel.custom_values || {};
      for (const v of Object.values(cv)) {
        if (typeof v === 'string') messages.push(v);
      }
    }
  }

  // 상품별 스티커 인기도 (Top 10 상품)
  const products = [...productMap.values()]
    .sort((a, b) => b.total - a.total)
    .slice(0, 10)
    .map(p => ({
      product_code: p.product_code,
      product_name: p.product_name,
      total: p.total,
      stickers: [...p.stickerMap.values()]
        .sort((a, b) => b.count - a.count)
        .map(s => ({
          sticker_code: s.sticker_code,
          sticker_name: s.sticker_name,
          count: s.count,
          pct: Math.round(s.count / p.total * 100),
        })),
    }));

  // 메시지 분석
  const total = messages.length;
  const nonEmpty = messages.filter(m => m.trim().length > 0);
  const lengths = nonEmpty.map(m => m.length).sort((a, b) => a - b);
  const sum = lengths.reduce((s, v) => s + v, 0);
  const avgLength = lengths.length ? Math.round(sum / lengths.length) : 0;
  const medianLength = lengths.length ? lengths[Math.floor(lengths.length / 2)] : 0;
  const maxLength = lengths.length ? lengths[lengths.length - 1] : 0;

  // 자주 등장 단어 (whitespace split, 2자 이상, 한글/영문/숫자만, 불용어 제외)
  const stopWords = new Set(['그리고', '하지만', '그래서', '이번', '저희', '저는', '저의', '우리', '우리의']);
  const wordCounts = new Map();
  for (const msg of nonEmpty) {
    const tokens = msg.split(/[\s,\.!?·,]+/);
    for (const raw of tokens) {
      const w = raw.replace(/[^가-힯\w]/g, '').trim();
      if (!w || w.length < 2 || stopWords.has(w)) continue;
      // 숫자만은 제외
      if (/^\d+$/.test(w)) continue;
      wordCounts.set(w, (wordCounts.get(w) || 0) + 1);
    }
  }
  const topWords = [...wordCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([word, count]) => ({ word, count }));

  // === 행사 유추 (Event Inference) ===
  //   메시지 키워드로 행사 종류 추론 — 답례품 도메인 사전 (우선순위 mutually exclusive).
  //   각 메시지는 첫 매칭 카테고리에 1회만 카운트.
  //   미분류 = 어떤 행사 키워드도 없음 (이름만 / 일반 인사 등).
  const EVENT_INFERENCE_TYPES = [
    // 우선순위 — 위에서부터 매칭. 더 구체적인 행사가 먼저.
    { type: '결혼식', icon: '💒', keywords: ['결혼', '웨딩', '예식', '신랑', '신부', '신혼', '부부', 'wedding', '백년가약', '혼인', '러브스토리', '러브 스토리'] },
    { type: '돌잔치/첫돌', icon: '🎂', keywords: ['돌잔치', '첫돌', '첫 돌', '첫 생일', '돌상', '돌떡', '돌맞이', '돌선물'] },
    { type: '백일', icon: '👶', keywords: ['백일', '100일'] },
    { type: '회갑/칠순/팔순', icon: '🎉', keywords: ['회갑', '환갑', '칠순', '팔순', '고희', '미수', '구순', '백수연', '진갑'] },
    { type: '출산/탄생', icon: '🍼', keywords: ['출산', '탄생', '베이비', '아가', '아기', '태어남'] },
    { type: '약혼/상견례', icon: '💍', keywords: ['약혼', '상견례', '프로포즈'] },
    { type: '개업/오픈', icon: '🏪', keywords: ['개업', '오픈', '창립', '개원', '리뉴얼'] },
    { type: '입학/졸업', icon: '🎓', keywords: ['입학', '졸업', '학사', '석사', '박사 학위'] },
    { type: '추모/장례', icon: '🕯️', keywords: ['추모', '영전', '명복', '고인', '장례', '추도'] },
    { type: '기타 행사', icon: '🎁', keywords: ['행사', '이벤트', '기념', '축하'] }, // 일반 축하 — 행사 미상이나 명확히 축하 의도
  ];
  function inferEvent(msg) {
    const lc = msg.toLowerCase();
    for (const { type, icon, keywords } of EVENT_INFERENCE_TYPES) {
      if (keywords.some(k => lc.includes(k.toLowerCase()))) return { type, icon };
    }
    return { type: '미분류', icon: '❓' };
  }
  const eventCounts = new Map(); // type → { type, icon, count }
  // 초기화 (분포 표시 일관성)
  EVENT_INFERENCE_TYPES.forEach(({ type, icon }) => eventCounts.set(type, { type, icon, count: 0 }));
  eventCounts.set('미분류', { type: '미분류', icon: '❓', count: 0 });
  nonEmpty.forEach(msg => {
    const { type, icon } = inferEvent(msg);
    const e = eventCounts.get(type);
    if (e) e.count++;
    else eventCounts.set(type, { type, icon, count: 1 });
  });
  const eventInference = [...eventCounts.values()]
    .map(e => ({
      ...e,
      pct: nonEmpty.length > 0 ? Math.round(e.count / nonEmpty.length * 100) : 0,
    }))
    .filter(e => e.count > 0) // 0건은 표시 안 함 (시각적 노이즈 감소)
    .sort((a, b) => b.count - a.count);

  return {
    products,
    messages: {
      total,
      non_empty: nonEmpty.length,
      avg_length: avgLength,
      median_length: medianLength,
      max_length: maxLength,
      top_words: topWords,
      event_inference: eventInference,
    },
    period: { start: startDate, end: endDate, ci_count: inRange.length },
  };
}

// === 샘플 주문 (수량=1) 일별 추이 ===
async function apiSamples(query = {}) {
  const p = await getPool();
  // 카테고리 분기 (shadowing).
  const categoryCfg = CATEGORY_FILTERS[query.category] || CATEGORY_FILTERS.daeryepum;
  const skipUnitValue = query.category === 'deco';
  const D01_FILTER = categoryCfg.filter;
  const ETC_AMOUNT_EXPR = etcAmountExpr({ skipUnitValue });
  const _cpdFilter = categoryCfg.filter.replace(/\bc\./g, 'c_cpd.');
  const ETC_COUPON_DIVISOR_JOIN_D01 = etcCouponDivisorJoin(_cpdFilter);
  const cardUnitDivisor = skipUnitValue ? '1' : 'ISNULL(NULLIF(c.Unit_Value, 0), 1)';
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
          AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 15)
          AND oi.order_count = 1

        UNION ALL

        SELECT CONVERT(varchar(10), co.order_date, 120),
          c.Card_Name, c.Card_Code
        FROM custom_order co WITH (NOLOCK)
        INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
        INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
        WHERE ${D01_FILTER} AND co.order_date >= @ss AND co.order_date < @se
          AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5)
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
          AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 15)
          AND oi.order_count = 1

        UNION

        SELECT DISTINCT CONVERT(varchar(10), co.order_date, 120), co.order_seq
        FROM custom_order co WITH (NOLOCK)
        INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
        INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
        WHERE ${D01_FILTER} AND co.order_date >= @sos AND co.order_date < @soe
          AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5)
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
      WHERE ${D01_FILTER} AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 15) AND o.order_date >= ${MK_FROM} AND o.order_date < ${MK_TO}
      GROUP BY DATEPART(hour, o.order_date)
      UNION ALL
      SELECT DATEPART(hour, co.order_date) AS hr, COUNT(DISTINCT co.order_seq) AS cnt
      FROM custom_order co WITH (NOLOCK)
      INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
      INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
      WHERE ${D01_FILTER} AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5) AND co.order_date >= ${MK_FROM} AND co.order_date < ${MK_TO}
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
      WHERE ${D01_FILTER} AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 15) AND o.order_date >= ${MK_FROM} AND o.order_date < ${MK_TO}
      GROUP BY DATEPART(weekday, o.order_date)
      UNION ALL
      SELECT DATEPART(weekday, co.order_date) AS dow, COUNT(DISTINCT co.order_seq) AS cnt
      FROM custom_order co WITH (NOLOCK)
      INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
      INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
      WHERE ${D01_FILTER} AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5) AND co.order_date >= ${MK_FROM} AND co.order_date < ${MK_TO}
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
      WHERE ${D01_FILTER} AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 15) AND o.order_date >= ${MK_FROM} AND o.order_date < ${MK_TO}
        AND o.recv_address IS NOT NULL AND LEN(o.recv_address) > 2
      GROUP BY LEFT(o.recv_address, CHARINDEX(' ', o.recv_address + ' ') - 1)
      UNION ALL
      SELECT LEFT(di.ADDR, CHARINDEX(' ', di.ADDR + ' ') - 1) AS region,
             COUNT(DISTINCT co.order_seq) AS cnt
      FROM custom_order co WITH (NOLOCK)
      INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
      INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
      LEFT JOIN DELIVERY_INFO di WITH (NOLOCK) ON co.order_seq = di.ORDER_SEQ AND di.DELIVERY_SEQ = 1
      WHERE ${D01_FILTER} AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5) AND co.order_date >= ${MK_FROM} AND co.order_date < ${MK_TO}
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
      WHERE ${D01_FILTER} AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 15) AND o.order_date >= ${MK_FROM} AND o.order_date < ${MK_TO}
        AND o.member_id IS NOT NULL AND o.member_id != ''
      UNION
      SELECT co.member_id
      FROM custom_order co WITH (NOLOCK)
      INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
      INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
      WHERE ${D01_FILTER} AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5) AND co.order_date >= ${MK_FROM} AND co.order_date < ${MK_TO}
        AND co.member_id IS NOT NULL AND co.member_id != ''
    ) t
  `);
  const giftSet = new Set(giftMembers.recordset.map(r => r.member_id));

  const cardMembers = await p.request().query(`
    SELECT DISTINCT co.member_id
    FROM custom_order co WITH (NOLOCK)
    INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
    INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
    WHERE c.Card_Div = 'A01' AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5) AND co.order_date >= ${MK_FROM} AND co.order_date < ${MK_TO}
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
      WHERE ${D01_FILTER} AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 15)
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
      WHERE ${D01_FILTER} AND cord.status_seq >= 2 AND cord.status_seq NOT IN (3, 5)
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
        WHERE ${D01_FILTER} AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 15)
          AND o.order_date >= ${MK_FROM} AND o.order_date < ${MK_TO}
        UNION ALL
        SELECT cord.member_id, comp.SALES_GUBUN, cord.order_date
        FROM custom_order cord WITH (NOLOCK)
        INNER JOIN custom_order_item coi WITH (NOLOCK) ON cord.order_seq = coi.order_seq
        INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
        LEFT JOIN COMPANY comp WITH (NOLOCK) ON cord.company_Seq = comp.COMPANY_SEQ
        WHERE ${D01_FILTER} AND cord.status_seq >= 2 AND cord.status_seq NOT IN (3, 5)
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
      WHERE ${D01_FILTER} AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 15)
        AND o.order_date >= ${MK_FROM} AND o.order_date < ${MK_TO}
      UNION ALL
      SELECT cord.member_id, cord.order_seq, cord.order_date, comp.SALES_GUBUN, CONCAT('C', cord.order_seq) AS order_key
      FROM custom_order cord WITH (NOLOCK)
      INNER JOIN custom_order_item coi WITH (NOLOCK) ON cord.order_seq = coi.order_seq
      INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
      LEFT JOIN COMPANY comp WITH (NOLOCK) ON cord.company_Seq = comp.COMPANY_SEQ
      WHERE ${D01_FILTER} AND cord.status_seq >= 2 AND cord.status_seq NOT IN (3, 5)
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
      WHERE ${D01_FILTER} AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 15)
        AND o.order_date >= ${MK_FROM} AND o.order_date < ${MK_TO}
      UNION ALL
      SELECT DISTINCT co.member_id, CONCAT('C', co.order_seq) AS order_key, co.order_date, co.settle_price
      FROM custom_order co WITH (NOLOCK)
      INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
      INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
      WHERE ${D01_FILTER} AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5)
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
      WHERE ${D01_FILTER} AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 15)
        AND o.order_date >= ${MK_FROM} AND o.order_date < ${MK_TO}
      UNION ALL
      SELECT DISTINCT co.member_id, CONCAT('C', co.order_seq) AS order_key, co.order_date
      FROM custom_order co WITH (NOLOCK)
      INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
      INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
      WHERE ${D01_FILTER} AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5)
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
      WHERE ${D01_FILTER} AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 15)
        AND o.order_date >= ${MK_FROM} AND o.order_date < ${MK_TO}
      UNION ALL
      SELECT CONCAT('C', co.order_seq) AS order_key,
        ${CHANNEL_CASE} AS channel,
        coi.item_count AS item_count,
        CAST(coi.item_sale_price AS float) * coi.item_count / ISNULL(NULLIF(c.Unit_Value, 0), 1) AS revenue
      FROM custom_order co WITH (NOLOCK)
      INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
      INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
      WHERE ${D01_FILTER} AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5)
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
      WHERE ${D01_FILTER} AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 15)
        AND o.order_date >= ${MK_FROM} AND o.order_date < ${MK_TO}
      UNION ALL
      SELECT co.order_date, CONCAT('C', co.order_seq) AS order_key,
        ${CHANNEL_CASE} AS channel,
        coi.item_count AS item_count,
        CAST(coi.item_sale_price AS float) * coi.item_count / ISNULL(NULLIF(c.Unit_Value, 0), 1) AS revenue
      FROM custom_order co WITH (NOLOCK)
      INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
      INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
      WHERE ${D01_FILTER} AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5)
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
      // role 도 함께 반환 (워크플로우 권한 UI 분기용). super admin 은 'admin'.
      let role = 'operator';
      try {
        if (isSuperAdmin(session)) role = 'admin';
        else role = await getUserRole(session.email);
      } catch {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        email: session.email,
        name: session.name,
        picture: session.picture,
        role,
        is_super_admin: isSuperAdmin(session),
      }));
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
  // 거래처 외부 포털 (정적 HTML) - 토큰으로 자체 인증, 세션 불필요
  if (pathname === '/vendor-portal') {
    const portalHtml = fs.readFileSync(path.join(__dirname, 'barungift', 'vendor-portal.html'), 'utf-8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(portalHtml);
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
        data = await apiDashboardComparison(parsed.query);
      } else if (pathname === '/api/dashboard/summary') {
        data = await apiDashboardSummary(parsed.query);
      } else if (pathname === '/api/dashboard/express-analysis') {
        data = await apiExpressAnalysis(parsed.query);
      } else if (pathname === '/api/dashboard/by-ship-date') {
        data = await apiDashboardByShipDate(parsed.query);
      } else if (pathname === '/api/dashboard/forecast') {
        data = await apiForecast(parsed.query);
      } else if (pathname === '/api/dashboard/leadtime') {
        data = await apiLeadtime(parsed.query);
      } else if (pathname === '/api/dashboard/marketing') {
        data = await apiMarketing(parsed.query);
      } else if (pathname === '/api/dashboard/conversion') {
        data = await apiConversion(parsed.query);
      } else if (pathname === '/api/dashboard/samples') {
        data = await apiSamples(parsed.query);
      } else if (pathname === '/api/dashboard/sticker-analytics') {
        data = await apiStickerAnalytics(parsed.query);
      } else if (pathname === '/api/dashboard/leadtime-3way') {
        data = await apiLeadtime3way(parsed.query);
      } else if (pathname === '/api/dashboard/wedding-calendar') {
        data = await apiWeddingCalendar(parsed.query);
      } else if (pathname === '/api/dashboard/wedding-calendar/trend') {
        data = await apiWeddingCalendarTrend(parsed.query);
      } else if (pathname === '/api/bg/vendor-settlements') {
        data = await apiVendorSettlements(parsed.query);
      } else if (pathname === '/api/bg/vendor-dashboard') {
        data = await apiVendorDashboard(parsed.query);
      } else if (pathname === '/api/bg/vendor-portal') {
        // public — 토큰 기반 거래처 자기 정산 조회 (인증 X, 토큰만으로 접근)
        data = await apiVendorPortal(parsed.query);
        if (data && data.status) {
          res.writeHead(data.status, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: data.error }));
          return;
        }
      } else if (pathname === '/api/bg/vendor-settlements/mark' && req.method === 'POST') {
        const body = await new Promise((resolve, reject) => {
          let raw = ''; req.on('data', c => raw += c); req.on('end', () => { try { resolve(JSON.parse(raw||'{}')); } catch (e) { reject(e); } });
        });
        data = await apiVendorSettlementMark(body, session);
      } else if (pathname === '/api/bg/vendor-settlements/unmark' && req.method === 'POST') {
        const body = await new Promise((resolve, reject) => {
          let raw = ''; req.on('data', c => raw += c); req.on('end', () => { try { resolve(JSON.parse(raw||'{}')); } catch (e) { reject(e); } });
        });
        data = await apiVendorSettlementUnmark(body, session);
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
            SELECT co.order_seq, co.order_date,
              CONVERT(varchar(19), co.settle_date, 120) AS settle_date,
              co.settle_price, co.settle_method, co.settle_status,
              co.company_Seq, co.status_seq, co.order_name, co.member_id,
              co.last_total_price, co.order_total_price,
              co.coupon_price, co.point_price, co.delivery_price,
              coi.item_sale_price, coi.item_count, coi.card_seq,
              c.Card_Name, c.Card_Code, c.Card_Div, c.Unit_Value,
              ISNULL(si.SiteName, CAST(co.company_Seq AS VARCHAR)) AS site_name
            FROM custom_order co WITH (NOLOCK)
            INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
            INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
            LEFT JOIN SiteInfo si WITH (NOLOCK) ON co.company_Seq = si.CompayCode
            WHERE co.order_seq = @seq
          `);
          // toss_vaccount — 가상계좌 발급 정보 (결제대기/가상계좌 진단)
          let vbank = { recordset: [] };
          try {
            vbank = await pp.request().input('seq', sql.Int, seq).query(`
              SELECT order_type, vacct_seq, bank_name, vacct_number, vacct_name,
                CONVERT(varchar(19), due_date, 120) AS due_date,
                settle_price, status, CONVERT(varchar(19), created_at, 120) AS created_at
              FROM toss_vaccount WITH (NOLOCK) WHERE order_seq = @seq
              ORDER BY vacct_seq DESC
            `);
          } catch (e) { /* toss_vaccount 없을 수도 — 무시 */ }
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
            toss_vaccount: vbank.recordset,
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
        // 인증 서명 페이로드 진단 — 토큰 요청 전후 모두 노출.
        logAdminAccess(session, req, 'naver-debug-auth', {});
        const naverApi = require('./naver/api');
        if (!naverApi.isConfigured()) {
          data = { error: 'Naver API 키 미설정' };
        } else {
          // 직접 서명 만들어보고 페이로드 노출 + 실제 호출 시도
          const timestamp = Date.now();
          const message = `${naverApi.CLIENT_ID}_${timestamp}`;
          let signature, signError;
          try {
            signature = naverApi.signClientSecret(naverApi.CLIENT_ID, timestamp, process.env.NAVER_CLIENT_SECRET);
          } catch (e) { signError = e.message; }
          let tokenResult = null;
          try {
            const token = await naverApi.getAccessToken();
            tokenResult = { ok: true, token_first_8: String(token).slice(0, 8) + '...', token_length: token.length };
          } catch (e) {
            tokenResult = { ok: false, error: e.message };
          }
          data = {
            client_id: naverApi.CLIENT_ID,
            secret_format: /^\$2[abxy]\$/.test(process.env.NAVER_CLIENT_SECRET || '') ? 'bcrypt ($2x$)' : 'raw',
            secret_length: (process.env.NAVER_CLIENT_SECRET || '').length,
            secret_first_8: (process.env.NAVER_CLIENT_SECRET || '').slice(0, 8),
            sign_method: /^\$2[abxy]\$/.test(process.env.NAVER_CLIENT_SECRET || '') ? 'bcrypt + base64url(padded)' : 'HMAC-SHA256 + base64url(padded)',
            timestamp,
            timestamp_iso: new Date(timestamp).toISOString(),
            message_to_sign: message,
            signature_length: signature ? signature.length : 0,
            signature_first_16: signature ? signature.slice(0, 16) + '...' : null,
            signature_last_8: signature ? '...' + signature.slice(-8) : null,
            sign_error: signError,
            token_result: tokenResult,
          };
        }
      } else if (pathname === '/api/naver/debug-raw') {
        // 네이버 API raw 응답 진단 — 0건 또는 에러 원인 식별용
        // 기본 hours_back=24 (오늘 주문 잡히는지), days_back 도 옵션
        logAdminAccess(session, req, 'naver-debug-raw', parsed.query);
        const naverApi = require('./naver/api');
        if (!naverApi.isConfigured()) {
          data = { error: 'Naver API 키 미설정 (NAVER_CLIENT_ID/CLIENT_SECRET)' };
        } else {
          const hoursBack = parsed.query.hours_back
            ? parseInt(parsed.query.hours_back)
            : (parsed.query.days_back ? parseInt(parsed.query.days_back) * 24 : 24);
          const endMs = Date.now();
          const startMs = endMs - hoursBack * 3600000;
          try {
            // 1) 방식 A — 직접 리스트
            let directResult, directError;
            try {
              directResult = await naverApi.listProductOrdersDirect({ startMs, endMs });
            } catch (e) {
              directError = { message: e.message, status: e.status };
            }
            // 2) 방식 B — last-changed-statuses (참고용 비교)
            const changed = await naverApi.listChangedStatuses({ fromMs: startMs, toMs: endMs });
            const lcStatuses = changed.data?.lastChangeStatuses || changed.data || [];
            const ids = Array.isArray(lcStatuses) ? lcStatuses.map(r => r?.productOrderId).filter(Boolean).slice(0, 10) : [];
            data = {
              query: {
                hours_back: hoursBack,
                start_kst: naverApi.fmtKstIso(startMs),
                end_kst: naverApi.fmtKstIso(endMs),
                client_id: naverApi.CLIENT_ID,
              },
              direct_list: {
                error: directError,
                raw_response: directResult,
                response_keys: directResult && typeof directResult === 'object' ? Object.keys(directResult) : [],
              },
              last_changed_statuses: {
                raw_response: changed,
                response_keys: changed && typeof changed === 'object' ? Object.keys(changed) : [],
                count: Array.isArray(lcStatuses) ? lcStatuses.length : null,
                sample_ids: ids,
              },
            };
          } catch (e) {
            data = { error: e.message, client_id: naverApi.CLIENT_ID };
          }
        }
      } else if (pathname === '/api/admin/nav-menu' && req.method === 'GET') {
        // GNB 메뉴 설정 조회 — 모든 로그인 사용자 허용 (페이지 init 에서 호출)
        const config = await getNavMenuConfig();
        data = { config, is_super_admin: isSuperAdmin(session), super_admin_emails: SUPER_ADMIN_EMAILS };
      } else if (pathname === '/api/admin/nav-menu' && req.method === 'PUT') {
        // GNB 메뉴 설정 저장 — super admin 전용
        if (!isSuperAdmin(session)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'forbidden', message: '권한 없음 (super admin 만 변경 가능)' }));
          return;
        }
        logAdminAccess(session, req, 'nav-menu-update', {});
        const body = await new Promise((resolve) => {
          let raw = '';
          req.on('data', c => raw += c);
          req.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
        });
        try {
          const saved = await setNavMenuConfig(body.config, session.email);
          data = { ok: true, config: saved };
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'save_failed', message: e.message }));
          return;
        }
      } else if (pathname === '/api/admin/scan-orphan-ci' && req.method === 'GET') {
        // bg_order_customer_info 의 orphan CI (prefix 누락된 raw seq) 식별 — dry run.
        //   /api/admin/scan-orphan-ci → 마이그레이션 계획만 출력 (실제 변경 X).
        if (!isSuperAdmin(session) && !(await hasRole(session, ['admin', 'operator']))) {
          return denyForbidden(res, 'admin/operator 필요');
        }
        data = await scanAndCleanupOrphanCi({ execute: false });
      } else if (pathname === '/api/admin/cleanup-orphan-ci' && req.method === 'POST') {
        // 충돌 없는 orphan CI 를 canonical prefix (ETC-X) 로 rename — 실제 실행.
        //   /api/admin/cleanup-orphan-ci (POST) → scan 후 to_migrate 만 rename.
        //   충돌 케이스 (canonical 도 존재) 는 건드리지 않음 — 보고만.
        if (!isSuperAdmin(session) && !(await hasRole(session, ['admin', 'operator']))) {
          return denyForbidden(res, 'admin/operator 필요');
        }
        logAdminAccess(session, req, 'cleanup-orphan-ci', {});
        data = await scanAndCleanupOrphanCi({ execute: true });
      } else if (pathname === '/api/admin/probe-barunson-db' && req.method === 'GET') {
        // barunson DB (모바일 청첩장 시스템) 의 화환/꽃다발 데이터 접근 가능성 진단.
        //   같은 SQL Server 다른 database. readonly_user 권한 + cross-DB query 가능 여부 확인.
        //   바른손M카드 모바일 청첩장 → 하객이 화환/꽃다발/꽃바구니 구매 흐름.
        if (!isSuperAdmin(session) && !(await hasRole(session, ['admin', 'operator']))) {
          return denyForbidden(res, 'admin/operator 필요');
        }
        const pp = await getPool();
        const probes = {};
        // 1) barunson DB 의 TB_Order 카운트
        try {
          const r1 = await pp.request().query(`SELECT COUNT(*) AS total FROM barunson.dbo.TB_Order WITH (NOLOCK)`);
          probes.tb_order = { ok: true, total: r1.recordset[0]?.total };
        } catch (e) {
          probes.tb_order = { ok: false, error: e.message };
        }
        // 2) TB_Product_Category — 화환 카테고리 코드 식별
        try {
          const r2 = await pp.request().query(`
            SELECT TOP 50 Product_Category_Code, Product_Category_Name
            FROM barunson.dbo.TB_Product_Category WITH (NOLOCK)
            ORDER BY Product_Category_Code
          `);
          probes.tb_product_category = { ok: true, samples: r2.recordset };
        } catch (e) {
          probes.tb_product_category = { ok: false, error: e.message };
        }
        // 3) TB_Product 의 카테고리별 분포 (화환 후보 추출)
        try {
          const r3 = await pp.request().query(`
            SELECT TOP 30 Product_Category_Code, COUNT(*) AS cnt,
              MIN(Product_Name) AS sample_name1, MAX(Product_Name) AS sample_name2
            FROM barunson.dbo.TB_Product WITH (NOLOCK)
            GROUP BY Product_Category_Code
            ORDER BY cnt DESC
          `);
          probes.tb_product_by_category = { ok: true, samples: r3.recordset };
        } catch (e) {
          probes.tb_product_by_category = { ok: false, error: e.message };
        }
        // 4) 화환/꽃 키워드 직접 검색
        try {
          const r4 = await pp.request().query(`
            SELECT TOP 30 Product_ID, Product_Code, Product_Name, Product_Category_Code
            FROM barunson.dbo.TB_Product WITH (NOLOCK)
            WHERE Product_Name LIKE N'%화환%' OR Product_Name LIKE N'%꽃다발%'
              OR Product_Name LIKE N'%꽃바구니%' OR Product_Name LIKE N'%근조%'
          `);
          probes.flower_wreath_products = { ok: true, samples: r4.recordset };
        } catch (e) {
          probes.flower_wreath_products = { ok: false, error: e.message };
        }
        data = {
          message: 'barunson DB 접근 진단. ok=true 면 cross-DB query 가능. 화환 카테고리 코드 식별 후 CATEGORY_FILTERS 에 추가하면 정보입력현황/대시보드에 통합 가능.',
          probes,
        };
      } else if (pathname === '/api/admin/find-order-everywhere' && req.method === 'GET') {
        // bar_shop1 의 모든 테이블 중 ORDER_SEQ / order_seq 컬럼이 있는 곳에서 매치 검색.
        //   header 는 있는데 item 이 안 보이는 케이스 (3246585) 추적용 — 별도 B2B item 테이블 식별.
        //   URL: /api/admin/find-order-everywhere?order_seq=3246585
        if (!isSuperAdmin(session) && !(await hasRole(session, ['admin', 'operator']))) {
          return denyForbidden(res, 'admin/operator 필요');
        }
        const pp = await getPool();
        const orderSeqInt = parseInt(parsed.query.order_seq) || 0;
        if (!orderSeqInt) { data = { error: 'order_seq 필수' }; }
        else {
          // 1) ORDER_SEQ 또는 order_seq 컬럼이 있는 모든 테이블 찾기
          const tblCols = await pp.request().query(`
            SELECT t.TABLE_SCHEMA, t.TABLE_NAME, c.COLUMN_NAME, c.DATA_TYPE
            FROM INFORMATION_SCHEMA.TABLES t
            INNER JOIN INFORMATION_SCHEMA.COLUMNS c
              ON c.TABLE_SCHEMA = t.TABLE_SCHEMA AND c.TABLE_NAME = t.TABLE_NAME
            WHERE t.TABLE_TYPE = 'BASE TABLE'
              AND c.COLUMN_NAME IN ('ORDER_SEQ', 'order_seq', 'OrderSeq', 'Order_Seq')
            ORDER BY t.TABLE_SCHEMA, t.TABLE_NAME
          `);

          // 2) 각 테이블에서 매치 시도 — TOP 5 row 추출
          const matches = [];
          for (const tcol of tblCols.recordset) {
            const fullName = `[${tcol.TABLE_SCHEMA}].[${tcol.TABLE_NAME}]`;
            try {
              const q = `SELECT TOP 5 * FROM ${fullName} WITH (NOLOCK) WHERE [${tcol.COLUMN_NAME}] = @seq`;
              const r = await pp.request().input('seq', sql.Int, orderSeqInt).query(q);
              if (r.recordset && r.recordset.length) {
                matches.push({
                  table: fullName,
                  column: tcol.COLUMN_NAME,
                  row_count: r.recordset.length,
                  rows: r.recordset,
                });
              }
            } catch (e) {
              // 권한 / 컬럼 에러 — skip
            }
          }

          data = {
            order_seq: orderSeqInt,
            tables_with_order_seq_col: tblCols.recordset.map(r => `${r.TABLE_SCHEMA}.${r.TABLE_NAME}.${r.COLUMN_NAME}`),
            total_tables_checked: tblCols.recordset.length,
            matched_tables: matches,
            hint: '매치 테이블에서 item / order_item 패턴 찾기. ' +
                  '바른손몰 B2B 별도 schema 일 경우 그 테이블명 식별 후 apiOrders UNION 추가 필요.',
          };
        }
      } else if (pathname === '/api/admin/probe-order-items' && req.method === 'GET') {
        // 특정 주문의 모든 item 정보 raw 조회 — S2_Card / barunson.TB_Product LEFT JOIN.
        //   주문은 존재하는데 주문조회에 안 잡히는 케이스 진단용 (S2_Card 미매핑 상품 등).
        //   URL: /api/admin/probe-order-items?order_seq=3246585
        if (!isSuperAdmin(session) && !(await hasRole(session, ['admin', 'operator']))) {
          return denyForbidden(res, 'admin/operator 필요');
        }
        const pp = await getPool();
        const orderSeqInt = parseInt(parsed.query.order_seq) || 0;
        if (!orderSeqInt) { data = { error: 'order_seq 필수' }; }
        else {
          const results = { order_seq: orderSeqInt };
          // 1) CUSTOM_ETC_ORDER_ITEM + LEFT JOIN S2_Card — 매핑 누락 즉시 보임
          try {
            const r = await pp.request().input('seq', sql.Int, orderSeqInt).query(`
              SELECT oi.order_seq, oi.card_seq, oi.order_count, oi.card_sale_price,
                c.Card_Code, c.Card_Name, c.Card_Div, c.Unit_Value,
                CASE WHEN c.Card_Seq IS NULL THEN 1 ELSE 0 END AS s2_card_unmapped
              FROM CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK)
              LEFT JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
              WHERE oi.order_seq = @seq
            `);
            results.etc_items = r.recordset;
          } catch (e) { results.etc_items = { error: e.message }; }

          // 2) custom_order_item + LEFT JOIN S2_Card
          try {
            const r = await pp.request().input('seq', sql.Int, orderSeqInt).query(`
              SELECT coi.order_seq, coi.card_seq, coi.item_count, coi.item_sale_price,
                c.Card_Code, c.Card_Name, c.Card_Div, c.Unit_Value,
                CASE WHEN c.Card_Seq IS NULL THEN 1 ELSE 0 END AS s2_card_unmapped
              FROM custom_order_item coi WITH (NOLOCK)
              LEFT JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
              WHERE coi.order_seq = @seq
            `);
            results.card_items = r.recordset;
          } catch (e) { results.card_items = { error: e.message }; }

          // 3) 매핑 누락 card_seq 들 — barunson.TB_Product 에서 찾기
          const unmappedSeqs = [
            ...((Array.isArray(results.etc_items) ? results.etc_items : []).filter(r => r.s2_card_unmapped).map(r => r.card_seq)),
            ...((Array.isArray(results.card_items) ? results.card_items : []).filter(r => r.s2_card_unmapped).map(r => r.card_seq)),
          ].filter(Boolean);
          if (unmappedSeqs.length) {
            const inList = unmappedSeqs.join(',');
            // 다양한 PK 가능성 — TB_Product 의 Product_ID / Product_Code / 다른 컬럼 시도
            const tries = [
              `SELECT TOP 30 * FROM barunson.dbo.TB_Product WITH (NOLOCK) WHERE Product_ID IN (${inList})`,
              `SELECT TOP 30 * FROM barunson.dbo.TB_Product WITH (NOLOCK) WHERE Product_Seq IN (${inList})`,
            ];
            const tbProductHits = [];
            for (const sqlText of tries) {
              try {
                const r = await pp.request().query(sqlText);
                if (r.recordset && r.recordset.length) {
                  tbProductHits.push({ query: sqlText, rows: r.recordset });
                }
              } catch (e) { /* skip */ }
            }
            results.unmapped_card_seqs = unmappedSeqs;
            results.tb_product_lookup = tbProductHits;
          }

          // 4) CUSTOM_ETC_ORDER_ITEM 모든 컬럼도 추가로 보기 (Card_Code 같은 컬럼이 item 에 직접 있을 수 있음)
          try {
            const r = await pp.request().input('seq', sql.Int, orderSeqInt).query(`
              SELECT TOP 20 * FROM CUSTOM_ETC_ORDER_ITEM WITH (NOLOCK) WHERE order_seq = @seq
            `);
            results.etc_items_raw = r.recordset;
          } catch (e) { results.etc_items_raw = { error: e.message }; }

          data = {
            hint: 's2_card_unmapped=1 인 item 이 있으면 그 상품이 S2_Card 에 미등록. ' +
                  'tb_product_lookup 에 row 있으면 barunson.TB_Product 에 별도 등록. ' +
                  'apiOrders 의 INNER JOIN S2_Card 가 이 row 들을 누락시킴 — LEFT JOIN 또는 UNION 으로 수정 필요.',
            ...results,
          };
        }
      } else if (pathname === '/api/admin/probe-com-products' && req.method === 'GET') {
        // 위탁답례품(COM_ 시작 Card_Code) 상품 분포 진단.
        //   현재 CATEGORY_FILTERS.daeryepum 은 Card_Div='D01' 만 → COM_ 이 D01 아니면 누락.
        //   URL: /api/admin/probe-com-products?days=90&order_seq=3246585
        if (!isSuperAdmin(session) && !(await hasRole(session, ['admin', 'operator']))) {
          return denyForbidden(res, 'admin/operator 필요');
        }
        const pp = await getPool();
        const days = parseInt(parsed.query.days) || 90;
        const orderSeqInt = parseInt(parsed.query.order_seq) || 0;
        const results = {};

        // 1) S2_Card 에서 COM_ 시작 상품 분포 + Card_Div 별 그룹화
        try {
          const r = await pp.request().query(`
            SELECT Card_Div, COUNT(*) AS cnt,
              MIN(Card_Code) AS first_code, MAX(Card_Code) AS last_code,
              MIN(Card_Name) AS first_name, MAX(Card_Name) AS last_name
            FROM S2_Card WITH (NOLOCK)
            WHERE Card_Code LIKE 'COM[_]%'
            GROUP BY Card_Div
            ORDER BY cnt DESC
          `);
          results.com_products_by_div = r.recordset;
        } catch (e) { results.com_products_by_div = { error: e.message }; }

        // 2) 샘플 상품 30개 (Card_Code / Card_Name / Card_Div / Unit_Value)
        try {
          const r = await pp.request().query(`
            SELECT TOP 30 Card_Seq, Card_Code, Card_Name, Card_Div, Unit_Value
            FROM S2_Card WITH (NOLOCK)
            WHERE Card_Code LIKE 'COM[_]%'
            ORDER BY Card_Seq DESC
          `);
          results.com_product_samples = r.recordset;
        } catch (e) { results.com_product_samples = { error: e.message }; }

        // 3) 최근 90일 COM_ 상품 주문 분포 (ETC + CARD)
        try {
          const r = await pp.request().input('days', sql.Int, days).query(`
            SELECT 'ETC' AS src, COUNT(DISTINCT o.order_seq) AS order_cnt,
              ISNULL(SUM(oi.order_count), 0) AS total_qty,
              MIN(CONVERT(varchar(10), o.order_date, 120)) AS first_date,
              MAX(CONVERT(varchar(10), o.order_date, 120)) AS last_date
            FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
            INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
            INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
            WHERE c.Card_Code LIKE 'COM[_]%'
              AND o.order_date >= DATEADD(day, -@days, GETDATE())
              AND o.status_seq >= 1 AND o.status_seq NOT IN (3, 5)
            UNION ALL
            SELECT 'CARD' AS src, COUNT(DISTINCT co.order_seq) AS order_cnt,
              ISNULL(SUM(coi.item_count), 0) AS total_qty,
              MIN(CONVERT(varchar(10), co.order_date, 120)) AS first_date,
              MAX(CONVERT(varchar(10), co.order_date, 120)) AS last_date
            FROM custom_order co WITH (NOLOCK)
            INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
            INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
            WHERE c.Card_Code LIKE 'COM[_]%'
              AND co.order_date >= DATEADD(day, -@days, GETDATE())
              AND co.status_seq >= 1 AND co.status_seq NOT IN (3, 5)
          `);
          results.recent_com_orders = r.recordset;
        } catch (e) { results.recent_com_orders = { error: e.message }; }

        // 4) 특정 order_seq 매치 (3246585 등) — COM_ 상품 포함된 ETC/CARD 주문 직접 조회
        if (orderSeqInt) {
          try {
            const r1 = await pp.request().input('seq', sql.Int, orderSeqInt).query(`
              SELECT 'ETC' AS src, o.order_seq, o.order_date, o.settle_date, o.status_seq,
                o.order_name, o.recv_name, o.recv_hphone, o.settle_price,
                c.Card_Code, c.Card_Name, c.Card_Div, c.Unit_Value,
                oi.order_count AS item_count, oi.card_sale_price
              FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
              INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
              INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
              WHERE o.order_seq = @seq AND c.Card_Code LIKE 'COM[_]%'
            `);
            const r2 = await pp.request().input('seq', sql.Int, orderSeqInt).query(`
              SELECT 'CARD' AS src, co.order_seq, co.order_date, co.settle_date, co.status_seq,
                co.order_name, co.member_id, co.settle_price,
                c.Card_Code, c.Card_Name, c.Card_Div, c.Unit_Value,
                coi.item_count, coi.item_sale_price
              FROM custom_order co WITH (NOLOCK)
              INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
              INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
              WHERE co.order_seq = @seq AND c.Card_Code LIKE 'COM[_]%'
            `);
            results.specific_order_match = {
              etc: r1.recordset,
              card: r2.recordset,
            };
          } catch (e) { results.specific_order_match = { error: e.message }; }
        }

        // 5) 현재 CATEGORY_FILTERS 노출
        results.current_category_filters = Object.entries(CATEGORY_FILTERS).map(([k, v]) => ({ key: k, filter: v.filter }));

        data = {
          period_days: days,
          probe_order_seq: orderSeqInt || null,
          hint: "com_products_by_div 의 Card_Div 값 확인 — D01 외 다른 값이면 현재 답례품 카테고리에서 누락. " +
                "specific_order_match 에 row 있으면 위탁답례품 주문이 3246585 임을 확인. " +
                "CATEGORY_FILTERS.daeryepum 을 (D01 OR Card_Code LIKE 'COM[_]%') 로 확장하면 통합 가능.",
          ...results,
        };
      } else if (pathname === '/api/admin/search-order-deep' && req.method === 'GET') {
        // 휴대폰 / 이름 / 주문번호로 모든 가능 DB·테이블 깊이 검색.
        //   URL: /api/admin/search-order-deep?phone=010-4103-2321&name=김현지&order_seq=3246585
        //   bar_shop1 (CUSTOM_ETC_ORDER, custom_order, DELIVERY_INFO) + barunson DB 검색.
        //   주문 못 찾을 때 마지막 진단.
        if (!isSuperAdmin(session) && !(await hasRole(session, ['admin', 'operator']))) {
          return denyForbidden(res, 'admin/operator 필요');
        }
        const pp = await getPool();
        const phone = (parsed.query.phone || '').trim();
        const name = (parsed.query.name || '').trim();
        const orderSeq = (parsed.query.order_seq || '').trim();
        const orderSeqInt = parseInt(orderSeq) || 0;
        // 휴대폰 정규화 — '-' 제거한 숫자만
        const phoneDigits = phone.replace(/[^0-9]/g, '');
        const results = {};

        async function _tryQuery(label, query, inputs = {}) {
          try {
            const req = pp.request();
            for (const [k, v] of Object.entries(inputs)) req.input(k, v.type, v.value);
            const r = await req.query(query);
            return { ok: true, rows: r.recordset };
          } catch (e) {
            return { ok: false, error: e.message };
          }
        }

        // 1) bar_shop1 ETC — order_seq + phone + name
        if (orderSeqInt || phoneDigits || name) {
          const conds = [];
          if (orderSeqInt) conds.push('o.order_seq = @oseq');
          if (phoneDigits) conds.push("REPLACE(REPLACE(o.recv_hphone, '-', ''), ' ', '') LIKE @phLike OR REPLACE(REPLACE(o.order_hphone, '-', ''), ' ', '') LIKE @phLike");
          if (name) conds.push("o.order_name = @nm OR o.recv_name = @nm");
          if (conds.length) {
            results.etc = await _tryQuery('CUSTOM_ETC_ORDER', `
              SELECT TOP 20 o.order_seq, o.company_Seq, o.status_seq,
                CONVERT(varchar(19), o.order_date, 120) AS order_date,
                CONVERT(varchar(19), o.settle_date, 120) AS settle_date,
                o.order_name, o.recv_name, o.recv_hphone, o.order_hphone,
                o.settle_price, o.settle_method
              FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
              WHERE ${conds.join(' OR ')}
              ORDER BY o.order_date DESC
            `, {
              oseq: { type: sql.Int, value: orderSeqInt },
              phLike: { type: sql.VarChar, value: phoneDigits ? `%${phoneDigits}%` : '' },
              nm: { type: sql.NVarChar, value: name },
            });
          }
        }

        // 2) bar_shop1 CARD — order_seq + member_id + order_name
        if (orderSeqInt || name) {
          const conds = [];
          if (orderSeqInt) conds.push('co.order_seq = @oseq');
          if (name) conds.push('co.order_name = @nm');
          if (conds.length) {
            results.card = await _tryQuery('custom_order', `
              SELECT TOP 20 co.order_seq, co.company_Seq, co.status_seq,
                CONVERT(varchar(19), co.order_date, 120) AS order_date,
                CONVERT(varchar(19), co.settle_date, 120) AS settle_date,
                co.order_name, co.member_id, co.settle_price, co.settle_method
              FROM custom_order co WITH (NOLOCK)
              WHERE ${conds.join(' OR ')}
              ORDER BY co.order_date DESC
            `, {
              oseq: { type: sql.Int, value: orderSeqInt },
              nm: { type: sql.NVarChar, value: name },
            });
          }
        }

        // 3) bar_shop1 DELIVERY_INFO — 휴대폰/이름 매치 (CARD 의 배송지 인덱스)
        if (phoneDigits || name) {
          const conds = [];
          if (phoneDigits) conds.push("REPLACE(REPLACE(di.HPHONE, '-', ''), ' ', '') LIKE @phLike");
          if (name) conds.push("di.NAME = @nm");
          if (conds.length) {
            results.delivery_info = await _tryQuery('DELIVERY_INFO', `
              SELECT TOP 20 di.ID, di.ORDER_SEQ, di.DELIVERY_SEQ, di.NAME, di.HPHONE, di.ADDR
              FROM DELIVERY_INFO di WITH (NOLOCK)
              WHERE ${conds.join(' OR ')}
              ORDER BY di.ID DESC
            `, {
              phLike: { type: sql.VarChar, value: phoneDigits ? `%${phoneDigits}%` : '' },
              nm: { type: sql.NVarChar, value: name },
            });
          }
        }

        // 4) barunson DB TB_Order — order_seq 매치 (스키마 추정)
        if (orderSeqInt) {
          const guessQueries = [
            `SELECT TOP 5 * FROM barunson.dbo.TB_Order WITH (NOLOCK) WHERE Order_ID = @oseq`,
            `SELECT TOP 5 * FROM barunson.dbo.TB_Order WITH (NOLOCK) WHERE OrderID = @oseq`,
            `SELECT TOP 5 * FROM barunson.dbo.TB_Order WITH (NOLOCK) WHERE OrderNo = @oseq`,
            `SELECT TOP 5 * FROM barunson.dbo.TB_Order WITH (NOLOCK) WHERE order_seq = @oseq`,
          ];
          const barunsonHits = [];
          for (const q of guessQueries) {
            try {
              const r = await pp.request().input('oseq', sql.Int, orderSeqInt).query(q);
              if (r.recordset && r.recordset.length) barunsonHits.push({ query: q, rows: r.recordset });
            } catch (e) { /* 컬럼 없음 — skip */ }
          }
          results.barunson_tb_order = { ok: true, hits: barunsonHits };
        }

        // 5) 정보입력현황 (Supabase bg_order_customer_info) — 같은 order_id 패턴
        try {
          const _bgStore = require('./barungift/store');
          const candidates = [];
          if (orderSeq) {
            candidates.push(orderSeq);
            candidates.push(`ETC-${orderSeq}`);
            candidates.push(`CP-${orderSeq}`);
            candidates.push(`NV-${orderSeq}`);
          }
          const bgHits = [];
          for (const cid of candidates) {
            try {
              const ci = await _bgStore.getCustomerInfo(cid);
              if (ci) bgHits.push({ order_id: cid, ci });
            } catch (e) { /* ignore */ }
          }
          results.bg_customer_info = { ok: true, hits: bgHits };
        } catch (e) {
          results.bg_customer_info = { ok: false, error: e.message };
        }

        data = {
          query: { phone, phone_digits: phoneDigits, name, order_seq: orderSeq },
          hint: '주문번호 / 이름 / 전화 어느 하나라도 매치되는 row 검색. ' +
                '못 찾으면 다른 시스템 (Supabase coupang_orders/naver_orders) 도 별도 확인 필요.',
          results,
        };
      } else if (pathname === '/api/admin/unmapped-sites' && req.method === 'GET') {
        // 매출 통과 주문 중 site_name 이 숫자 raw 로 표시되는 (= SiteInfo/COMPANY 매핑 누락) company_Seq 분포.
        //   URL: /api/admin/unmapped-sites?days=90
        //   응답: CARD/ETC 각각의 미매핑 company_Seq + 건수 + 매출 + 샘플 order_seq + Card_Div 분포
        //   운영팀이 이 목록 보고 SiteInfo / COMPANY 에 등록하거나 HARDCODED_SITE_NAMES 에 추가 결정.
        if (!isSuperAdmin(session) && !(await hasRole(session, ['admin', 'operator']))) {
          return denyForbidden(res, 'admin/operator 필요');
        }
        const pp = await getPool();
        const days = parseInt(parsed.query.days) || 90;

        // 매핑 있는 company_Seq 집합 (companyNameMap 캐시 + hardcoded)
        const mappedSet = new Set([
          ...Object.keys(companyNameMap),
          ...Object.keys(HARDCODED_SITE_NAMES),
        ]);

        async function _unmappedDist(table, dateCol, statusFilter) {
          const r = await pp.request().input('days', sql.Int, days).query(`
            SELECT
              o.company_Seq,
              COUNT(DISTINCT o.order_seq) AS order_cnt,
              ISNULL(SUM(o.settle_price), 0) AS total_settle_price,
              MIN(CONVERT(varchar(10), o.${dateCol}, 120)) AS first_date,
              MAX(CONVERT(varchar(10), o.${dateCol}, 120)) AS last_date
            FROM ${table} o WITH (NOLOCK)
            LEFT JOIN SiteInfo si WITH (NOLOCK) ON o.company_Seq = si.CompayCode
            WHERE o.${dateCol} >= DATEADD(day, -@days, GETDATE())
              AND o.status_seq >= 1 AND o.status_seq NOT IN (3, 5)
              AND si.SiteName IS NULL  -- SiteInfo 미매핑
              AND o.company_Seq IS NOT NULL
            GROUP BY o.company_Seq
            ORDER BY order_cnt DESC
          `);
          // application-side: HARDCODED + DB companyNameMap 매핑된 코드는 제거 (정말 raw 로 표시되는 것만)
          return r.recordset.filter(row => !mappedSet.has(String(row.company_Seq)));
        }

        async function _samples(table, dateCol, companySeqs) {
          if (!companySeqs.length) return [];
          const inList = companySeqs.map(c => parseInt(c)).filter(Boolean).join(',');
          if (!inList) return [];
          const r = await pp.request().input('days', sql.Int, days).query(`
            SELECT TOP 30 o.company_Seq, o.order_seq,
              CONVERT(varchar(19), o.${dateCol}, 120) AS order_date,
              o.status_seq, o.order_name, o.settle_price
            FROM ${table} o WITH (NOLOCK)
            WHERE o.${dateCol} >= DATEADD(day, -@days, GETDATE())
              AND o.company_Seq IN (${inList})
              AND o.status_seq >= 1 AND o.status_seq NOT IN (3, 5)
            ORDER BY o.order_date DESC
          `);
          return r.recordset;
        }

        const cardDist = await _unmappedDist('custom_order', 'order_date').catch(e => ({ error: e.message }));
        const etcDist = await _unmappedDist('CUSTOM_ETC_ORDER', 'order_date').catch(e => ({ error: e.message }));
        const cardSamples = Array.isArray(cardDist) ? await _samples('custom_order', 'order_date', cardDist.map(r => r.company_Seq)) : [];
        const etcSamples = Array.isArray(etcDist) ? await _samples('CUSTOM_ETC_ORDER', 'order_date', etcDist.map(r => r.company_Seq)) : [];

        data = {
          period_days: days,
          hint: 'site_name 이 운영자에게 raw 숫자 코드로 노출되고 있는 company_Seq 목록. ' +
                '운영팀이 이 코드를 식별 후 (1) SiteInfo 에 직접 등록 또는 (2) ' +
                'server.js HARDCODED_SITE_NAMES 에 추가하면 "사이트명(코드)" 형식으로 노출됨.',
          mapped_company_seqs_in_cache: Object.keys(companyNameMap).length,
          hardcoded_mappings: HARDCODED_SITE_NAMES,
          card_unmapped: cardDist,
          card_samples: cardSamples,
          etc_unmapped: etcDist,
          etc_samples: etcSamples,
        };
      } else if (pathname === '/api/admin/probe-barunson-order' && req.method === 'GET') {
        // barunson DB 의 TB_Order 등에서 특정 order_seq / order_id 검색.
        //   URL: /api/admin/probe-barunson-order?id=3246585
        //   1) TB_Order 의 컬럼 구조 조회 (어떤 컬럼이 PK 인지)
        //   2) id 가 들어갈 만한 모든 컬럼에서 검색 (숫자형 컬럼 우선)
        //   3) 매칭 row 의 전체 컬럼 노출
        if (!isSuperAdmin(session) && !(await hasRole(session, ['admin', 'operator']))) {
          return denyForbidden(res, 'admin/operator 필요');
        }
        const pp = await getPool();
        const probeId = (parsed.query.id || '').trim();
        if (!probeId) { data = { error: 'id 파라미터 필수 (예: ?id=3246585)' }; }
        else {
          const probes = {};
          // 1) TB_Order 컬럼 구조
          try {
            const cols = await pp.request().query(`
              SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, IS_NULLABLE
              FROM barunson.INFORMATION_SCHEMA.COLUMNS
              WHERE TABLE_NAME = 'TB_Order'
              ORDER BY ORDINAL_POSITION
            `);
            probes.tb_order_columns = { ok: true, columns: cols.recordset };
          } catch (e) {
            probes.tb_order_columns = { ok: false, error: e.message };
          }
          // 2) ID 가 들어갈 수 있는 모든 컬럼에서 직접 검색 — *_id, *_seq, *_no, *_code, *_num 끝 컬럼
          //    INT 형이라면 = 비교, 문자형이면 = 비교 (numeric str), LIKE 도 시도
          try {
            const idCols = await pp.request().input('id', sql.VarChar, probeId).query(`
              SELECT TOP 20 COLUMN_NAME, DATA_TYPE
              FROM barunson.INFORMATION_SCHEMA.COLUMNS
              WHERE TABLE_NAME = 'TB_Order'
                AND (
                  COLUMN_NAME LIKE '%[_]id' OR COLUMN_NAME LIKE 'ID' OR
                  COLUMN_NAME LIKE '%[_]seq' OR COLUMN_NAME LIKE '%[_]no' OR
                  COLUMN_NAME LIKE '%[_]code' OR COLUMN_NAME LIKE '%[_]num' OR
                  COLUMN_NAME LIKE '%order%' OR COLUMN_NAME = 'OrderID' OR
                  COLUMN_NAME LIKE 'Card_%'
                )
            `);
            probes.candidate_columns = { ok: true, columns: idCols.recordset };
          } catch (e) {
            probes.candidate_columns = { ok: false, error: e.message };
          }
          // 3) 일반적 PK 후보로 매칭 시도 — 동적 SQL 위험 회피 위해 try/catch 다중 attempts
          const tryQueries = [
            { hint: 'Order_ID/OrderID 정수 매치',
              sql: `SELECT TOP 5 * FROM barunson.dbo.TB_Order WITH (NOLOCK) WHERE Order_ID = @id OR OrderID = @id` },
            { hint: 'OrderNo 정수 매치',
              sql: `SELECT TOP 5 * FROM barunson.dbo.TB_Order WITH (NOLOCK) WHERE OrderNo = @id` },
            { hint: 'order_seq 정수 매치',
              sql: `SELECT TOP 5 * FROM barunson.dbo.TB_Order WITH (NOLOCK) WHERE order_seq = @id` },
            { hint: 'Order_Code 문자 매치',
              sql: `SELECT TOP 5 * FROM barunson.dbo.TB_Order WITH (NOLOCK) WHERE Order_Code = @idStr OR OrderCode = @idStr` },
          ];
          const matches = [];
          for (const q of tryQueries) {
            try {
              const r = await pp.request()
                .input('id', sql.Int, parseInt(probeId) || 0)
                .input('idStr', sql.VarChar, probeId)
                .query(q.sql);
              if (r.recordset && r.recordset.length) {
                matches.push({ hint: q.hint, rows: r.recordset });
              }
            } catch (e) {
              // 컬럼 없으면 SQL error — skip
            }
          }
          probes.matched = matches;
          data = {
            probe_id: probeId,
            hint: 'tb_order_columns 보고 정확한 컬럼명 확인 → matched 에 row 있으면 그 컬럼이 PK. ' +
                  '바른손몰 ETC 또는 별도 시스템인지 판정.',
            ...probes,
          };
        }
      } else if (pathname === '/api/admin/discover-card-divs' && req.method === 'GET') {
        // S2_Card 의 Card_Div 분포 + 샘플 — 화환 등 미등록 카테고리 식별용.
        if (!isSuperAdmin(session) && !(await hasRole(session, ['admin', 'operator']))) {
          return denyForbidden(res, 'admin/operator 필요');
        }
        const pp = await getPool();
        const r = await pp.request().query(`
          WITH ranked AS (
            SELECT Card_Div, Card_Name, Card_Code,
              ROW_NUMBER() OVER (PARTITION BY Card_Div ORDER BY Card_Seq DESC) AS rn,
              COUNT(*) OVER (PARTITION BY Card_Div) AS total
            FROM S2_Card WITH (NOLOCK)
          )
          SELECT Card_Div, total, Card_Name, Card_Code
          FROM ranked
          WHERE rn <= 5
          ORDER BY total DESC, Card_Div, rn
        `);
        // Group by Card_Div for cleaner output
        const byDiv = {};
        r.recordset.forEach(row => {
          if (!byDiv[row.Card_Div]) byDiv[row.Card_Div] = { card_div: row.Card_Div, total: row.total, samples: [] };
          byDiv[row.Card_Div].samples.push({ name: row.Card_Name, code: row.Card_Code });
        });
        data = {
          known_categories: Object.entries(CATEGORY_FILTERS).map(([key, v]) => ({ category_key: key, label: v.label, filter: v.filter })),
          card_divs: Object.values(byDiv).sort((a, b) => b.total - a.total),
          hint: '화환 / M카드 전용 상품 등을 위 목록에서 식별 후 CATEGORY_FILTERS 에 추가 요청해주세요.',
        };
      } else if (pathname.startsWith('/api/admin/debug-by-seq/')) {
        // 종합 진단 — order_seq 로 MSSQL + Supabase 모든 변형 prefix CI 조회.
        //   /api/admin/debug-by-seq/3244610
        //   "수동 입력해도 입력완료 탭으로 안 넘어감" 류 이슈 진단용.
        const mm = pathname.match(/^\/api\/admin\/debug-by-seq\/(\d+)$/);
        const seq = mm ? parseInt(mm[1]) : null;
        if (!seq) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'order_seq required' }));
          return;
        }
        const pp = await getPool();
        const wf = require('./barungift/workflow-store');
        // 1) MSSQL — ETC / CARD 어느 테이블에 있는지 확인
        const [etcR, cardR] = await Promise.all([
          pp.request().input('s', sql.Int, seq).query(
            `SELECT TOP 1 order_seq, member_id, CONVERT(varchar(10), order_date, 120) AS order_date FROM CUSTOM_ETC_ORDER WITH (NOLOCK) WHERE order_seq = @s`
          ),
          pp.request().input('s', sql.Int, seq).query(
            `SELECT TOP 1 order_seq, member_id, CONVERT(varchar(10), order_date, 120) AS order_date FROM custom_order WITH (NOLOCK) WHERE order_seq = @s`
          ),
        ]);
        const etcRow = etcR.recordset[0] || null;
        const cardRow = cardR.recordset[0] || null;
        // 2) Supabase — 모든 prefix 변형 CI row 검색
        const variants = [`ETC-${seq}`, `${seq}`, `CP-${seq}`, `NV-${seq}`];
        const ciResults = await Promise.all(variants.map(async v => {
          try {
            const ci = await wf.getCustomerInfoForUpdate(v);
            return { order_id: v, exists: !!ci, ci: ci ? {
              order_id: ci.order_id,
              submitted_at: ci.submitted_at,
              updated_at: ci.updated_at,
              processed_at: ci.processed_at,
              has_sticker_selections: Array.isArray(ci.sticker_selections) ? ci.sticker_selections.length : null,
              has_desired_ship_date: !!ci.desired_ship_date,
            } : null };
          } catch (e) {
            return { order_id: v, error: e.message };
          }
        }));
        // 3) 진단 — 어떤 order_type 이면 frontend 가 어떤 prefix 를 쓸지
        const expectedKey = etcRow ? `ETC-${seq}` : cardRow ? `${seq}` : '?';
        const mismatch = ciResults
          .filter(r => r.exists)
          .filter(r => r.order_id !== expectedKey);
        data = {
          query: { seq, expected_ci_key: expectedKey },
          mssql: {
            etc: etcRow,
            card: cardRow,
            order_type: etcRow ? 'ETC' : cardRow ? 'CARD' : 'NOT_FOUND',
          },
          ci_variants: ciResults,
          diagnosis: {
            ci_exists_at_expected: ciResults.find(r => r.order_id === expectedKey)?.exists || false,
            mismatched_rows: mismatch, // 다른 prefix 로 저장된 row (key mismatch 원인)
            advice: mismatch.length > 0
              ? `⚠️ CI row 가 ${mismatch.map(m => m.order_id).join(',')} 로 존재하는데 frontend 는 ${expectedKey} 를 lookup 함. order_id 정리 필요.`
              : (!ciResults.find(r => r.order_id === expectedKey)?.exists
                  ? `CI row 없음 — 저장이 실제로 안 됐거나 다른 prefix 로 됨 (모든 변형 확인 완료, 발견 X).`
                  : `정상 — ${expectedKey} 에 CI 존재.`),
          },
        };
      } else if (pathname.startsWith('/api/admin/debug-ci/')) {
        // CI row raw 조회 — sticker_selections 의 timestamps / sticker_code 검증용
        //   /api/admin/debug-ci/{order_id} — order_id 예: ETC-3245371 또는 raw seq
        const m = pathname.match(/^\/api\/admin\/debug-ci\/(.+)$/);
        const orderId = m ? decodeURIComponent(m[1]) : null;
        if (!orderId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'order_id required' }));
          return;
        }
        const wf = require('./barungift/workflow-store');
        const ci = await wf.getCustomerInfoForUpdate(orderId);
        if (!ci) {
          data = { error: 'not_found', orderId, tried: orderId };
        } else {
          data = {
            order_id: orderId,
            submitted_at: ci.submitted_at,
            updated_at: ci.updated_at,
            processed_at: ci.processed_at,
            sticker_selections: ci.sticker_selections,
            // 각 selection 의 stage 진단
            diagnostics: (ci.sticker_selections || []).map((s, i) => ({
              index: i,
              product_code: s?.product_code,
              sticker_code: s?.sticker_code,
              sticker_id: s?.sticker_id,
              has_sticker_code: !!(s?.sticker_code && String(s.sticker_code).trim()),
              has_sticker_id: !!(s?.sticker_id && String(s.sticker_id).trim()),
              images_count: Array.isArray(s?.images) ? s.images.length : 0,
              sticker_completed_at: s?.sticker_completed_at,
              printed_at: s?.printed_at,
              bound_at: s?.bound_at,
              packed_at: s?.packed_at,
              shipped_at: s?.shipped_at,
            })),
          };
        }
      } else if (pathname === '/api/admin/backfill-no-sticker' && req.method === 'POST') {
        // 전체 customer_info 순회 → sticker_code 없는 sticker_selection 자동 진행 적용 (멱등)
        if (!isSuperAdmin(session) && !(await hasRole(session, ['admin', 'operator']))) {
          return denyForbidden(res, 'admin/operator 필요');
        }
        logAdminAccess(session, req, 'backfill-no-sticker', {});
        const wf = require('./barungift/workflow-store');
        // 모든 ci 조회 (limit 큰 단위로)
        const supabaseUrl = `${AUTH_REST_BASE}/bg_order_customer_info?select=*&limit=10000`;
        const listRes = await fetch(supabaseUrl, { headers: AUTH_HEADERS });
        if (!listRes.ok) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'list_failed', message: await listRes.text() }));
          return;
        }
        const allCi = await listRes.json();
        let scanned = 0, patched = 0, errors = 0;
        for (const ci of allCi) {
          scanned++;
          const orig = Array.isArray(ci.sticker_selections) ? ci.sticker_selections : [];
          const advanced = wf.autoAdvanceNoStickerSelections(orig, 'system:no-sticker');
          // 변경된 row 가 있는지 비교 (sticker_completed_at 등)
          const hasChange = advanced.some((sel, i) => {
            const a = sel || {};
            const b = orig[i] || {};
            return (a.sticker_completed_at && !b.sticker_completed_at)
                || (a.printed_at && !b.printed_at)
                || (a.bound_at && !b.bound_at);
          });
          if (!hasChange) continue;
          try {
            await wf.updateCustomerInfo(ci.order_id, { sticker_selections: advanced });
            patched++;
          } catch (e) {
            errors++;
            console.warn(`[backfill-no-sticker] ${ci.order_id}: ${e.message}`);
          }
        }
        data = { scanned, patched, errors };
      } else if (pathname === '/api/coupang/rfm/debug-raw') {
        // 쿠팡 로켓 그로스 (RFM) — endpoint 후보들 순회 시도 + 응답 확인용 debug
        logAdminAccess(session, req, 'coupang-rfm-debug-raw', parsed.query);
        const rfm = require('./coupang/rfm');
        const days = parseInt(parsed.query.days) || 7;
        const end = new Date();
        const start = new Date(end.getTime() - days * 86400000);
        const startDate = start.toISOString().slice(0, 10);
        const endDate = end.toISOString().slice(0, 10);
        const result = await rfm.tryFetchRfmSalesReport({ startDate, endDate });
        data = { query: { startDate, endDate, days }, ...result };
      } else if (pathname === '/api/coupang/rfm/sync' && req.method === 'POST') {
        // 쿠팡 로켓 그로스 동기화 — endpoint 식별 후 매출 데이터 upsert
        logAdminAccess(session, req, 'coupang-rfm-sync', {});
        const body = await new Promise((resolve) => {
          let raw = '';
          req.on('data', c => raw += c);
          req.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
        });
        const rfm = require('./coupang/rfm');
        const rfmStore = require('./coupang/rfm-store');
        const days = parseInt(body.days_back) || 7;
        const end = new Date();
        const start = new Date(end.getTime() - days * 86400000);
        const startDate = start.toISOString().slice(0, 10);
        const endDate = end.toISOString().slice(0, 10);
        try {
          const fetchResult = await rfm.tryFetchRfmSalesReport({ startDate, endDate });
          if (!fetchResult.successEndpoint) {
            await rfmStore.updateSyncState({ last_error: 'no endpoint succeeded', last_synced_at: new Date().toISOString() });
            data = { error: 'API endpoint 식별 실패 — debug-raw 로 응답 확인 필요', attempts: fetchResult.attempts };
          } else {
            // 응답 구조 확인 후 normalize
            const raw = fetchResult.response;
            const items = Array.isArray(raw?.data) ? raw.data
                        : Array.isArray(raw?.contents) ? raw.contents
                        : Array.isArray(raw) ? raw : [];
            const rows = items.map(r => rfm.normalizeRow(r, startDate)).filter(Boolean);
            let upserted = 0;
            if (rows.length) {
              const r = await rfmStore.upsertSales(rows);
              upserted = r.upserted || 0;
            }
            await rfmStore.updateSyncState({
              last_synced_at: new Date().toISOString(),
              last_synced_from: startDate,
              last_synced_to: endDate,
              last_rows_count: upserted,
              last_error: null,
            });
            data = {
              ok: true,
              endpoint: fetchResult.successEndpoint,
              window: { startDate, endDate },
              fetched: items.length,
              upserted,
            };
          }
        } catch (e) {
          await rfmStore.updateSyncState({ last_error: e.message, last_synced_at: new Date().toISOString() });
          data = { error: e.message };
        }
      } else if (pathname === '/api/coupang/rfm/sync-state') {
        const rfmStore = require('./coupang/rfm-store');
        data = await rfmStore.getSyncState();
      } else if (pathname === '/api/coupang/rfm/sales' && req.method === 'GET') {
        // 로켓그로스 매출 row 목록 (수동 입력 + 향후 API sync 포함) — 관리 UI 용.
        if (!isSuperAdmin(session) && !(await hasRole(session, ['admin', 'operator']))) {
          return denyForbidden(res, 'admin/operator 필요');
        }
        const rfmStore = require('./coupang/rfm-store');
        const startDate = parsed.query.startDate || null;
        const endDate = parsed.query.endDate || null;
        const rows = await rfmStore.listSales({ startDate, endDate });
        data = { rows };
      } else if (pathname === '/api/coupang/rfm/manual' && req.method === 'POST') {
        // 운영자 수동 입력 (Wing 셀러센터 → 손으로 옮김). Coupang Open API 가 RFM
        //   매출 endpoint 미공개라 fallback path. 날짜당 1 row, 같은 날 재제출 시 덮어쓰기.
        if (!isSuperAdmin(session) && !(await hasRole(session, ['admin', 'operator']))) {
          return denyForbidden(res, 'admin/operator 필요');
        }
        const body = await new Promise((resolve) => {
          let raw = '';
          req.on('data', c => raw += c);
          req.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
        });
        logAdminAccess(session, req, 'coupang-rfm-manual', { sale_date: body.sale_date, sales_amount: body.sales_amount });
        const rfmStore = require('./coupang/rfm-store');
        try {
          const row = await rfmStore.upsertManualSale({
            sale_date: body.sale_date,
            sales_amount: body.sales_amount,
            sales_qty: body.sales_qty,
            refund_amount: body.refund_amount,
            refund_qty: body.refund_qty,
            product_name: body.product_name,
            by: session?.user?.email || null,
          });
          data = { ok: true, row };
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
          return;
        }
      } else if (pathname.match(/^\/api\/coupang\/rfm\/sales\/[^/]+$/) && req.method === 'DELETE') {
        // 단일 row 삭제 (잘못 입력 정정용)
        if (!isSuperAdmin(session) && !(await hasRole(session, ['admin', 'operator']))) {
          return denyForbidden(res, 'admin/operator 필요');
        }
        const id = pathname.split('/').pop();
        logAdminAccess(session, req, 'coupang-rfm-delete', { id });
        const rfmStore = require('./coupang/rfm-store');
        try {
          await rfmStore.deleteSaleById(decodeURIComponent(id));
          data = { ok: true };
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
          return;
        }
      } else if (pathname.startsWith('/api/bg/orders/')) {
        // ============================================
        // 정보입력현황 워크플로우 + 스티커 이미지 + 송장
        // ============================================
        //   /api/bg/orders/:order_id/stickers/:idx/images          (POST/GET)
        //   /api/bg/orders/:order_id/stickers/:idx/images/:filename (DELETE)
        //   /api/bg/orders/:order_id/stickers/:idx/main            (PATCH body { filename })
        //   /api/bg/orders/:order_id/stickers/:idx/workflow        (PATCH body { stage, jump? })
        //   /api/bg/orders/:order_id/invoices                      (GET/POST)
        //   /api/bg/orders/:order_id/invoices/:id                  (DELETE)
        const wf = require('./barungift/workflow-store');
        const m = pathname.match(/^\/api\/bg\/orders\/([^/]+)(?:\/stickers\/(\d+))?(?:\/(images|main|workflow|invoices))?(?:\/([^/]+))?$/);
        if (!m) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'not_found' }));
          return;
        }
        const orderId = decodeURIComponent(m[1]);
        const stickerIdx = m[2] != null ? parseInt(m[2], 10) : null;
        const subResource = m[3] || null;
        const subId = m[4] ? decodeURIComponent(m[4]) : null;

        async function readJsonBody() {
          const raw = await new Promise((resolve) => {
            let buf = '';
            req.on('data', c => buf += c);
            req.on('end', () => resolve(buf));
          });
          try { return JSON.parse(raw); } catch { return {}; }
        }

        // --- 스티커 이미지 routes ---
        if (subResource === 'images' && stickerIdx != null) {
          if (req.method === 'POST') {
            // 업로드 — body: { filename, mime, data(base64) }
            if (!(await hasRole(session, ['admin', 'operator', 'designer']))) {
              return denyForbidden(res, 'admin/operator/designer 필요');
            }
            const body = await readJsonBody();
            if (!body.filename || !body.data) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'invalid_body', message: 'filename, data(base64) 필수' }));
              return;
            }
            // ============================================
            // 파일명 검증 — 주문번호 + 스티커코드 포함 강제 (클라이언트 우회 방지)
            // ============================================
            try {
              const ciCheck = await wf.getCustomerInfoForUpdate(orderId);
              const selCheck = ciCheck?.sticker_selections?.[stickerIdx];
              const rawOrderSeq = String(orderId).replace(/^(ETC|CP|NV)-/, '');
              const errors = [];
              if (rawOrderSeq && !body.filename.includes(rawOrderSeq)) {
                errors.push(`주문번호 '${rawOrderSeq}' 누락`);
              }
              if (selCheck?.sticker_code && !body.filename.includes(selCheck.sticker_code)) {
                errors.push(`스티커코드 '${selCheck.sticker_code}' 누락`);
              }
              if (errors.length) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                  error: 'filename_validation_failed',
                  message: '파일명 검증 실패: ' + errors.join(', '),
                  details: errors,
                }));
                return;
              }
            } catch (e) {
              console.warn('[sticker upload] 파일명 검증 중 ci 조회 실패 (검증 생략):', e.message);
              // ci 조회 실패 시 검증 생략 (업로드 자체는 진행)
            }
            try {
              const buffer = Buffer.from(body.data, 'base64');
              if (buffer.length > 10 * 1024 * 1024) {
                res.writeHead(413, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'too_large', message: '10MB 초과' }));
                return;
              }
              const uploaded = await wf.uploadStickerImage({
                orderId, stickerIndex: stickerIdx,
                filename: body.filename, buffer, mime: body.mime,
              });
              await wf.addStickerImageMeta({
                orderId, stickerIndex: stickerIdx,
                image: {
                  filename: uploaded.filename,
                  original_filename: uploaded.original_filename,
                  path: uploaded.path,
                  mime: body.mime,
                  size: buffer.length,
                },
                by: session.email,
              });
              logAdminAccess(session, req, 'sticker-upload', { orderId, stickerIdx, filename: uploaded.filename });
              data = { ok: true, ...uploaded };
            } catch (e) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'upload_failed', message: e.message }));
              return;
            }
          } else if (req.method === 'GET') {
            // 리스트 + signed URL — 모든 인증 사용자
            try {
              const ci = await wf.getCustomerInfoForUpdate(orderId);
              const sel = ci?.sticker_selections?.[stickerIdx] || null;
              const images = sel?.images || [];
              // signed URL 부여 (1시간)
              const urls = await Promise.all(images.map(async (img) => {
                if (!img.path) return { ...img, url: null };
                try {
                  return { ...img, url: await wf.getStickerImageSignedUrl(img.path, 3600) };
                } catch {
                  return { ...img, url: null };
                }
              }));
              data = { images: urls };
            } catch (e) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'list_failed', message: e.message }));
              return;
            }
          } else if (req.method === 'DELETE' && subId) {
            // 이미지 삭제
            if (!(await hasRole(session, ['admin', 'operator', 'designer']))) {
              return denyForbidden(res, 'admin/operator/designer 필요');
            }
            try {
              const ci = await wf.getCustomerInfoForUpdate(orderId);
              const sel = ci?.sticker_selections?.[stickerIdx] || null;
              const img = (sel?.images || []).find(x => x.filename === subId);
              if (img && img.path) await wf.deleteStickerImage(img.path);
              await wf.removeStickerImageMeta({ orderId, stickerIndex: stickerIdx, filename: subId });
              logAdminAccess(session, req, 'sticker-delete', { orderId, stickerIdx, filename: subId });
              data = { ok: true };
            } catch (e) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'delete_failed', message: e.message }));
              return;
            }
          } else {
            res.writeHead(405, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'method_not_allowed' }));
            return;
          }
        }
        // --- 메인 이미지 지정 ---
        else if (subResource === 'main' && stickerIdx != null && req.method === 'PATCH') {
          if (!(await hasRole(session, ['admin', 'operator', 'designer']))) {
            return denyForbidden(res, 'admin/operator/designer 필요');
          }
          const body = await readJsonBody();
          try {
            await wf.setStickerMainImage({ orderId, stickerIndex: stickerIdx, filename: body.filename });
            data = { ok: true };
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'set_main_failed', message: e.message }));
            return;
          }
        }
        // --- 워크플로우 stage 진행/점프 ---
        else if (subResource === 'workflow' && stickerIdx != null && req.method === 'PATCH') {
          const body = await readJsonBody();
          // 권한 — stage 별 다름
          //   shipped 는 직접 workflow PATCH 가 아닌 invoices POST 로만 처리되어야 하나
          //   defense-in-depth 차원에서 admin-only 명시
          const stage = body.stage;
          const adminOnlyStages = ['bound', 'packed', 'shipped'];
          const allowed = adminOnlyStages.includes(stage)
            ? ['admin', 'operator']
            : ['admin', 'operator', 'designer'];
          if (!(await hasRole(session, allowed))) {
            return denyForbidden(res, `stage=${stage} 처리 권한 없음`);
          }
          try {
            const result = await wf.patchStickerWorkflow({
              orderId, stickerIndex: stickerIdx,
              stage: stage === null ? null : stage,
              jump: !!body.jump,
              by: session.email,
            });
            logAdminAccess(session, req, 'sticker-workflow', { orderId, stickerIdx, stage, jump: !!body.jump });
            data = { ok: true, result };
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'workflow_failed', message: e.message }));
            return;
          }
        }
        // --- 송장 routes ---
        else if (subResource === 'invoices') {
          if (req.method === 'GET') {
            data = { invoices: await wf.listInvoices(orderId) };
          } else if (req.method === 'POST') {
            if (!(await hasRole(session, ['admin', 'operator']))) {
              return denyForbidden(res, 'admin/operator 필요');
            }
            const body = await readJsonBody();
            try {
              const inv = await wf.insertInvoice({
                orderId,
                invoiceNumber: String(body.invoice_number || '').trim(),
                deliveryCompany: String(body.delivery_company || '').trim(),
                stickerIndices: Array.isArray(body.sticker_indices) ? body.sticker_indices.map(Number) : [],
                shippedBy: session.email,
                notes: body.notes || null,
              });
              logAdminAccess(session, req, 'invoice-create', { orderId, invoice_number: inv.invoice_number });
              data = { ok: true, invoice: inv };
            } catch (e) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'invoice_failed', message: e.message }));
              return;
            }
          } else if (req.method === 'DELETE' && subId) {
            if (!(await hasRole(session, ['admin', 'operator']))) {
              return denyForbidden(res, 'admin/operator 필요');
            }
            try {
              await wf.deleteInvoice(subId);
              logAdminAccess(session, req, 'invoice-delete', { orderId, id: subId });
              data = { ok: true };
            } catch (e) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'invoice_delete_failed', message: e.message }));
              return;
            }
          } else {
            res.writeHead(405, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'method_not_allowed' }));
            return;
          }
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'not_found' }));
          return;
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
            AND co.status_seq NOT IN (3, 5)
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
            AND o.status_seq NOT IN (3, 5, 15)
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
              AND co.status_seq NOT IN (3, 5)
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
      } else if (pathname === '/api/debug-status-seq') {
        // status_seq 분포 분석 — STATUS_MAP 매핑 검증용.
        //   URL: /api/debug-status-seq?days=90
        //   각 status_seq 별 건수 + 샘플 order_seq 5개씩 + 최근 settle_date 까지 노출.
        //   CARD/ETC 분리 — 매핑 정확도 진단.
        logAdminAccess(session, req, 'debug-status-seq', { days: parsed.query.days });
        const pp = await getPool();
        const days = parseInt(parsed.query.days) || 90;
        const ssq = parsed.query.status_seq != null ? parseInt(parsed.query.status_seq) : null;
        const sampleCount = parseInt(parsed.query.samples) || 5;

        // CARD 분포
        const cardDist = await pp.request().input('days', sql.Int, days).query(`
          SELECT
            co.status_seq,
            COUNT(*) AS cnt,
            SUM(CASE WHEN co.settle_date IS NOT NULL THEN 1 ELSE 0 END) AS settled_cnt,
            MIN(CONVERT(varchar(19), co.order_date, 120)) AS min_order_date,
            MAX(CONVERT(varchar(19), co.order_date, 120)) AS max_order_date
          FROM custom_order co WITH (NOLOCK)
          WHERE co.order_date >= DATEADD(day, -@days, GETDATE())
          GROUP BY co.status_seq
          ORDER BY co.status_seq
        `);
        // ETC 분포
        const etcDist = await pp.request().input('days', sql.Int, days).query(`
          SELECT
            o.status_seq,
            COUNT(*) AS cnt,
            SUM(CASE WHEN o.settle_date IS NOT NULL THEN 1 ELSE 0 END) AS settled_cnt,
            MIN(CONVERT(varchar(19), o.order_date, 120)) AS min_order_date,
            MAX(CONVERT(varchar(19), o.order_date, 120)) AS max_order_date
          FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
          WHERE o.order_date >= DATEADD(day, -@days, GETDATE())
          GROUP BY o.status_seq
          ORDER BY o.status_seq
        `);

        // 특정 status_seq 샘플 (필터 없으면 모든 status 의 N건)
        // 운영자가 admin 화면에서 그 주문 확인하면 status 실제 의미 파악 가능
        const cardSamplesReq = pp.request().input('days', sql.Int, days).input('n', sql.Int, sampleCount);
        if (ssq != null) cardSamplesReq.input('ssq', sql.Int, ssq);
        const cardSamples = await cardSamplesReq.query(`
          SELECT TOP (@n) co.order_seq, co.status_seq,
            CONVERT(varchar(19), co.order_date, 120) AS order_date,
            CONVERT(varchar(19), co.settle_date, 120) AS settle_date,
            co.order_name, co.settle_price
          FROM custom_order co WITH (NOLOCK)
          WHERE co.order_date >= DATEADD(day, -@days, GETDATE())
            ${ssq != null ? 'AND co.status_seq = @ssq' : ''}
          ORDER BY co.order_date DESC
        `);
        const etcSamplesReq = pp.request().input('days', sql.Int, days).input('n', sql.Int, sampleCount);
        if (ssq != null) etcSamplesReq.input('ssq', sql.Int, ssq);
        const etcSamples = await etcSamplesReq.query(`
          SELECT TOP (@n) o.order_seq, o.status_seq,
            CONVERT(varchar(19), o.order_date, 120) AS order_date,
            CONVERT(varchar(19), o.settle_date, 120) AS settle_date,
            o.order_name, o.settle_price
          FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
          WHERE o.order_date >= DATEADD(day, -@days, GETDATE())
            ${ssq != null ? 'AND o.status_seq = @ssq' : ''}
          ORDER BY o.order_date DESC
        `);

        data = {
          period_days: days,
          filter_status_seq: ssq,
          hint: '각 status_seq 별 분포 + 샘플 order_seq 확인. ' +
                'admin 화면(FirstMall) 에서 샘플 주문번호 직접 확인해 status 의 실제 의미 검증.',
          card_distribution: cardDist.recordset,
          etc_distribution: etcDist.recordset,
          card_samples: cardSamples.recordset,
          etc_samples: etcSamples.recordset,
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
                AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5)
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
                AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 15)
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
              AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 15)
              AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5)
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
