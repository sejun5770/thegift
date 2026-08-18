const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '3457');
const BASE_PATH = process.env.BASE_PATH || '';  // 예: /c/barungift

// 컨테이너 내부 자기호출(스케줄러 등)이 세션 없이 API 를 쓰기 위한 1회성 토큰.
//   프로세스마다 새로 만드는 랜덤값이라 외부에서 추측/재사용 불가.
//   같은 프로세스의 하위 모듈은 process.env 로 읽는다.
const INTERNAL_TOKEN = crypto.randomBytes(24).toString('hex');
process.env.BG_INTERNAL_TOKEN = INTERNAL_TOKEN;

// 프로세스 기동 시각 — /api/build-info 에서 재배포 여부 확인용
const _serverStartedAt = new Date().toISOString();

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
  // 개발모드(GOOGLE_CLIENT_ID 미설정)는 로그인 자체를 우회한다. 그런데 세션이 없으니
  //   역할 게이트가 걸린 화면은 통째로 403 이 돼 로컬에서 열어볼 수 없었다.
  //   운영에는 GOOGLE_CLIENT_ID 가 반드시 있어 이 분기가 켜지지 않는다.
  if (DEV_SKIP_AUTH) return true;
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
  // Azure SQL 은 유휴 후 재개될 때 첫 핸드셰이크가 15초를 넘기는 일이 있다.
  //   ("Failed to connect ... in 15000ms" 로 화면이 통째로 실패했다.) 25초로 늘리고,
  //   그래도 실패하면 _connectPool() 이 한 번 더 시도한다 — 재개가 이미 진행 중이라 대개 붙는다.
  connectionTimeout: 25000,
};

/**
 * 커넥션 풀 생성 + 1회 재시도.
 *   실패한 ConnectionPool 은 재사용하지 않고 새로 만든다 (mssql 이 내부 상태를 남긴다).
 *   timeout 계열 오류만 재시도한다 — 자격증명·방화벽 오류는 기다려도 달라지지 않으므로
 *   바로 올려서 원인을 빨리 드러낸다.
 */
//   주의: 연결 timeout 의 실제 메시지는 "Failed to connect to <host>:1433 in 15000ms" 로
//   'timeout' 이라는 단어가 없다. 문구만 보면 정작 재시도해야 할 케이스를 놓친다.
//   err.code(ETIMEOUT 등) 를 우선 보고, 문구는 보조로 쓴다.
const _RETRYABLE_CONN_CODE = new Set(['ETIMEOUT', 'ESOCKET', 'ECONNRESET', 'ECONNCLOSED', 'ETIMEDOUT']);
const _RETRYABLE_CONN_MSG = /Failed to connect|timeout|timed out|ETIMEOUT|ESOCKET|ECONNRESET|ECONNCLOSED|socket hang up/i;
const _isRetryableConnErr = e =>
  _RETRYABLE_CONN_CODE.has(e?.code) || _RETRYABLE_CONN_MSG.test(e?.message || '');

async function _connectPool(config, label, onError) {
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const p = new sql.ConnectionPool(config);
    p.on('error', onError);
    try {
      await p.connect();
      if (attempt > 1) console.log(`[${label}] 재시도 연결 성공`);
      return p;
    } catch (e) {
      lastErr = e;
      try { await p.close(); } catch { /* 이미 끊긴 풀 */ }
      if (attempt === 2 || !_isRetryableConnErr(e)) break;
      console.warn(`[${label}] 연결 실패 (1/2) — 3초 후 재시도: ${e.message}`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  throw lastErr;
}

let pool = null;
let _poolInitPromise = null; // 동시 초기화 요청 중복 방지 (race-condition 가드)

// ============================================
// XERP 풀 — ERP 원본 DB (같은 서버, database 만 다름)
//   bar_shop1 의 S2_CARD_ERP_STOCK 은 ERP 재고의 복제본인데 적재가 누락되는 행이 있다
//   (예: TGJSD11O1 사양벌꿀 — ERP 에는 231개, bar_shop1 에는 행 자체가 없음).
//   readonly_user 로 XERP 에 직접 접근 가능한 것을 확인해 원본을 직접 읽는다. 2026-08-05
//
//   재고 원장: mmInventory (품목 25,472 / 창고 131)
//   판매 가용 창고: MF01 (운영 확인) — ERP '스마트재고현황' 의 현재고와 일치
// ============================================
//   창고는 콤마로 여러 개 지정 가능 (합산). MF01 만 보면 답례품 203품목 중
//   27개가 MF24 에만 있어 0 으로 보이고, 34개가 음수로 나온다 (2026-08-05 확인).
const XERP_WAREHOUSES = String(process.env.XERP_WAREHOUSE || 'MF01')
  .split(',').map(s => s.trim().replace(/[^A-Za-z0-9_]/g, '')).filter(Boolean);
const XERP_WAREHOUSE = XERP_WAREHOUSES.join(',');
const XERP_CONFIG = { ...DB_CONFIG, database: process.env.XERP_DB_NAME || 'XERP' };
let _xerpPool = null;
let _xerpInitPromise = null;

async function getXerpPool() {
  if (_xerpPool && _xerpPool.connected) return _xerpPool;
  if (_xerpInitPromise) return _xerpInitPromise;
  _xerpInitPromise = (async () => {
    const p = await _connectPool(XERP_CONFIG, 'xerp',
      (err) => { console.error('[xerp] pool error:', err.message); _xerpPool = null; });
    _xerpPool = p;
    console.log(`Connected to XERP (warehouse ${XERP_WAREHOUSE})`);
    return p;
  })().finally(() => { _xerpInitPromise = null; });
  return _xerpInitPromise;
}

// ============================================
// MySQL 풀 — 디얼디어 wedding DB (별도 서버, port 3306)
//   환경변수: MYSQL_HOST, MYSQL_PORT, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE
//   미설정 시 getMysqlPool() 는 명확한 에러로 fallback (디얼디어 통합 영역에서만 호출).
// ============================================
let _mysqlPool = null;
async function getMysqlPool() {
  if (_mysqlPool) return _mysqlPool;
  const host = process.env.MYSQL_HOST;
  const port = parseInt(process.env.MYSQL_PORT, 10) || 3306;
  const user = process.env.MYSQL_USER;
  const password = process.env.MYSQL_PASSWORD;
  const database = process.env.MYSQL_DATABASE;
  if (!host || !user || !password || !database) {
    throw new Error('MYSQL_HOST/PORT/USER/PASSWORD/DATABASE 환경변수 미설정 — Docker Manager에 등록 필요');
  }
  const mysql = require('mysql2/promise');
  _mysqlPool = mysql.createPool({
    host, port, user, password, database,
    connectionLimit: 5,
    waitForConnections: true,
    queueLimit: 0,
    connectTimeout: 10000,
  });
  console.log(`Connected to MySQL (${host}:${port}/${database})`);
  return _mysqlPool;
}

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
    const p = await _connectPool(DB_CONFIG, 'bar_shop1',
      (err) => { console.error('Pool error:', err.message); pool = null; });
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

/**
 * 네이버 스마트스토어 store_id → site_name 라벨.
 *   - 등록된 스토어 1개 (또는 store_id='main') 이면 '네이버' 단일 표시 (호환)
 *   - 멀티 스토어이면 '네이버(<NAVER_NAME_n>)' 분리 표시
 *   - 알 수 없는 store_id 면 '네이버(store_id)' 폴백
 */
function naverSiteLabel(storeId) {
  try {
    const naverApi = require('./naver/api');
    const stores = naverApi.getStores();
    if (stores.length <= 1) return '네이버';
    if (storeId) {
      const s = naverApi.getStore(storeId);
      if (s && s.name) return `네이버(${s.name})`;
      return `네이버(${storeId})`;
    }
  } catch {}
  return '네이버';
}

/**
 * '네이버(...)' 형태 site_name 을 '네이버' 단일로 normalize.
 *   매출 KPI / sales report 등 통합 집계에서 사용.
 */
function normalizeNaverSite(siteName) {
  if (typeof siteName === 'string' && siteName.startsWith('네이버(')) return '네이버';
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
  daeryepum:   { label: '답례품', filter: DAERYEPUM_FILTER_SQL },
  deco:        { label: '데코소품', filter: `(c.Card_Div = 'C29' OR c.Card_Code LIKE '2026_qr%')` },
  flower:      { label: '꽃다발', filter: `c.Card_Div = 'D02'` },
  // 바른손더기프트 — API 미연동 채널. MSSQL 조회 결과 없음 (bg_manual_orders 만 UNION).
  bhands_gift: { label: '바른손더기프트', filter: `1 = 0` },
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
  const cafe24IdsList = parseStrList(query.cafe24_ids);
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
        o.order_hphone AS order_hphone,
        o.recv_name AS recv_name,
        o.recv_hphone AS recv_hphone,
        CONCAT(o.recv_address, ' ', ISNULL(o.recv_address_detail,'')) AS recv_address,
        o.recv_msg AS recv_msg,
        -- canonical name: 같은 Card_Code 여러 Card_Seq 존재 시 DISPLAY_YORN='Y' 우선 + 최신 Card_Seq 의 이름.
        --   오타/중복 등록 케이스에서 최신 정정 이름을 자동 표시.
        ISNULL(canon.canonical_name, c.Card_Name) AS card_name,
        c.Card_Name AS card_name_raw,  -- 원본 (실제 참조된 Card_Seq 의 이름)
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
        1 AS delivery_seq,  -- ETC 주문은 단일 배송지
        -- 구매확정일 — CUSTOM_ETC_ORDER.confirm_date. 실제로는 2010년 이후 신규 값 없음 (미사용) 이나 스키마 통일 위해 SELECT.
        CONVERT(varchar(19), o.confirm_date, 120) AS confirmed_at,
        -- 옵션(비용변동) 라인 식별: card_opt = 부모 아이템 card_seq. NULL=부모(세트/메인).
        --   백엔드에서 옵션을 부모로 합산 + 옵션 행 제거 (아래 JS). item_card_seq 로 매칭.
        oi.card_seq AS item_card_seq, oi.card_opt AS card_opt, oi.seq AS item_seq
      FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
      INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
      INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
      LEFT JOIN SiteInfo si WITH (NOLOCK) ON o.company_Seq = si.CompayCode
      LEFT JOIN etc_copurchase_orders ecp ON o.order_seq = ecp.order_seq
      ${etcCouponDivisorForCategory}
      OUTER APPLY (
        -- canonical name — 같은 Card_Code 여러 Card_Seq 있을 때 대표 이름 선정
        --   후보 필터: 이상 이름 (빈 문자열/사용X/사용안함/삭제/테스트) 제외
        --   우선순위:
        --     1) DISPLAY_YORN='Y' 우선
        --     2) 프리픽스 ([시크릿특가]/[XX%할인] 등) 없는 row 우선
        --     3) 최신 Card_Seq
        --   canonical row 이름에 프리픽스 있으면 첫 ']' 이후 문자열 반환 (제거)
        SELECT TOP 1
          CASE
            WHEN c2.Card_Name LIKE '[[]%[]]%'
              THEN LTRIM(SUBSTRING(c2.Card_Name, CHARINDEX(']', c2.Card_Name) + 1, LEN(c2.Card_Name)))
            ELSE c2.Card_Name
          END AS canonical_name
        FROM S2_Card c2 WITH (NOLOCK)
        WHERE c2.Card_Code = c.Card_Code
          AND LTRIM(RTRIM(ISNULL(c2.Card_Name, ''))) <> ''
          AND c2.Card_Name NOT LIKE '%사용X%'
          AND c2.Card_Name NOT LIKE '%사용안함%'
          AND c2.Card_Name NOT LIKE '%삭제%'
          AND c2.Card_Name NOT LIKE '%테스트%'
        ORDER BY
          CASE WHEN c2.DISPLAY_YORN = 'Y' THEN 0 ELSE 1 END,
          CASE WHEN c2.Card_Name LIKE '[[]%' THEN 1 ELSE 0 END,
          c2.Card_Seq DESC
      ) canon
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
        co.order_hphone AS order_hphone,
        di.NAME AS recv_name,
        ISNULL(di.HPHONE, di.PHONE) AS recv_hphone,
        CONCAT(ISNULL(di.ADDR,''), ' ', ISNULL(di.ADDR_DETAIL,'')) AS recv_address,
        di.DELIVERY_MEMO AS recv_msg,
        -- canonical name: 같은 Card_Code 여러 Card_Seq 존재 시 DISPLAY_YORN='Y' 우선 + 최신 Card_Seq 의 이름.
        ISNULL(canon.canonical_name, c.Card_Name) AS card_name,
        c.Card_Name AS card_name_raw,  -- 원본
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
        ISNULL(di.DELIVERY_SEQ, 1) AS delivery_seq,  -- 배송지별 행 구분 (나눔배송 대응)
        -- 구매확정일 — custom_order.src_confirm_date. 바른손카드에서 고객이 구매확정한 시점.
        CONVERT(varchar(19), co.src_confirm_date, 120) AS confirmed_at,
        -- 옵션 라인 식별 (ETC 파트와 컬럼 통일). custom_order_item 엔 card_opt 없음 → NULL.
        coi.card_seq AS item_card_seq, NULL AS card_opt, NULL AS item_seq
      FROM custom_order co WITH (NOLOCK)
      INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
      INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
      LEFT JOIN SiteInfo si WITH (NOLOCK) ON co.company_Seq = si.CompayCode
      LEFT JOIN card_copurchase_orders cp ON co.order_seq = cp.order_seq
      OUTER APPLY (
        -- canonical name — 같은 Card_Code 여러 Card_Seq 있을 때 대표 이름 선정
        --   후보 필터: 이상 이름 (빈 문자열/사용X/사용안함/삭제/테스트) 제외
        --   우선순위:
        --     1) DISPLAY_YORN='Y' 우선
        --     2) 프리픽스 ([시크릿특가]/[XX%할인] 등) 없는 row 우선
        --     3) 최신 Card_Seq
        --   canonical row 이름에 프리픽스 있으면 첫 ']' 이후 문자열 반환 (제거)
        SELECT TOP 1
          CASE
            WHEN c2.Card_Name LIKE '[[]%[]]%'
              THEN LTRIM(SUBSTRING(c2.Card_Name, CHARINDEX(']', c2.Card_Name) + 1, LEN(c2.Card_Name)))
            ELSE c2.Card_Name
          END AS canonical_name
        FROM S2_Card c2 WITH (NOLOCK)
        WHERE c2.Card_Code = c.Card_Code
          AND LTRIM(RTRIM(ISNULL(c2.Card_Name, ''))) <> ''
          AND c2.Card_Name NOT LIKE '%사용X%'
          AND c2.Card_Name NOT LIKE '%사용안함%'
          AND c2.Card_Name NOT LIKE '%삭제%'
          AND c2.Card_Name NOT LIKE '%테스트%'
        ORDER BY
          CASE WHEN c2.DISPLAY_YORN = 'Y' THEN 0 ELSE 1 END,
          CASE WHEN c2.Card_Name LIKE '[[]%' THEN 1 ELSE 0 END,
          c2.Card_Seq DESC
      ) canon
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

  // 옵션(비용변동) 라인 합산 — 프론트 신규 옵션 기능 (수건/주방세제 등).
  //   옵션 행(card_opt = 부모 아이템 card_seq)의 금액을 부모(item_card_seq = card_opt)에 합산하고
  //   옵션 행은 제거 → 주문조회·정보입력현황에 부모(세트)만, 결제금액은 옵션 합으로 표시.
  //   ETC 전용 (CARD 는 card_opt 항상 NULL → 영향 없음). 부모에 _options 첨부 (옵션선택 표시용).
  if (rows.some(r => r.card_opt != null)) {
    const parentByKey = new Map(); // `${order_seq}::${item_card_seq}` → 부모 row
    for (const r of rows) {
      if (r.card_opt == null && r.item_card_seq != null) {
        parentByKey.set(`${r.order_seq}::${r.item_card_seq}`, r);
      }
    }
    const kept = [];
    for (const r of rows) {
      if (r.card_opt != null) {
        const parent = parentByKey.get(`${r.order_seq}::${r.card_opt}`);
        if (parent) {
          parent.item_amount = (Number(parent.item_amount) || 0) + (Number(r.item_amount) || 0);
          (parent._options = parent._options || []).push({
            code: r.card_code, name: r.card_name,
            amount: Number(r.item_amount) || 0, qty: r.item_count,
            seq: Number(r.item_seq) || 0, // 옵션 순서(옵션1/2 = 아이템 seq) — 수집복사 K/L 매핑용
          });
          continue; // 옵션 행 제거
        }
        // 부모 못 찾은 옵션은 (비정상) 누락 방지 위해 유지
      }
      kept.push(r);
    }
    // 옵션 순서 고정 — 아이템 seq 오름차순 (옵션1=주방세제, 옵션2=수건 …). 수집복사 K/L 순서 일관.
    for (const r of kept) { if (Array.isArray(r._options)) r._options.sort((a, b) => (a.seq || 0) - (b.seq || 0)); }
    rows.splice(0, rows.length, ...kept);
  }

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
        // 쿠팡 등록상품ID(11자리) → 내부 상품코드 역맵 (migration 057).
        //   조회 시점에 치환하므로 이미 쌓인 주문도 재동기화 없이 내부코드로 보인다.
        //   실패해도 원본 코드로 그대로 보여준다 — 목록이 비는 것보다 낫다.
        //   옵션ID 매핑을 먼저 본다 — 같은 등록상품 안에서 옵션마다 내부코드가 갈리는 경우가 있다.
        const cpByOption = new Map();
        const cpByProduct = new Map();
        try {
          for (const ps of (await require('./barungift/store').getAllProductSettings()) || []) {
            const m = ps.channel_product_codes?.coupang;
            if (!m) continue;
            // 구형(배열만) 값은 등록상품ID 로 본다
            const pIds = Array.isArray(m) ? m : (m.product_ids || []);
            for (const c of pIds) cpByProduct.set(String(c).trim(), ps.product_id);
            for (const c of (Array.isArray(m) ? [] : (m.option_ids || []))) {
              cpByOption.set(String(c).trim(), ps.product_id);
            }
          }
        } catch (e) { console.warn('[apiOrders] 쿠팡 코드 매핑 로드 실패 (원본 코드 사용):', e.message); }
        // 옵션ID → 등록상품ID (063). 로켓그로스 주문은 등록상품ID 가 비어 있어
        //   이 다리가 없으면 상품설정에 옵션ID 를 일일이 넣기 전까진 계속 미매핑이다.
        let cpOptToProduct = new Map();
        try { cpOptToProduct = await require('./coupang/option-map').getOptionToProduct(); }
        catch (e) { console.warn('[apiOrders] 옵션맵 로드 실패:', e.message); }
        const cpSpid = (code, optionId) =>
          String(code || '').trim() || cpOptToProduct.get(String(optionId || '').trim()) || '';
        const mapCp = (code, optionId) =>
          cpByOption.get(String(optionId || '').trim())
          || cpByProduct.get(cpSpid(code, optionId))
          || code || '';
        const isMapped = (code, optionId) =>
          cpByOption.has(String(optionId || '').trim()) || cpByProduct.has(cpSpid(code, optionId));
        const normalized = coupangRows.map(r => ({
          order_seq: r.coupang_order_id, // 쿠팡 orderId (BIGINT)
          member_id: null,
          order_type: 'COUPANG',
          has_copurchase: 0,
          order_date: r.ordered_at,
          settle_date: r.paid_at,
          order_name: r.recv_name || '',
          order_hphone: r.recv_hphone || '',  // 쿠팡 buyer 마스킹 → 수령인 연락처 폴백
          recv_name: r.recv_name || '',
          recv_hphone: r.recv_hphone || '',
          recv_address: r.recv_address || '',
          recv_msg: r.recv_message || '',
          card_name: r.product_name || '',
          // 내부 상품코드로 치환 (057). 옵션ID 매핑 > 등록상품ID 매핑 > 원본 코드.
          // 로켓그로스 여부 (062) — 정보입력현황이 '쿠팡창고' 탭으로 가르는 기준
          is_rocket_growth: !!r.is_rocket_growth,
          card_code: mapCp(r.product_code, r.vendor_item_id),
          // 원본은 지우지 않는다 — 매핑이 틀렸을 때 추적이 끊기면 안 된다
          channel_product_code: r.product_code || '',
          channel_option_id: r.vendor_item_id || '',
          channel_code_mapped: isMapped(r.product_code, r.vendor_item_id),
          unit_value: 1,  // 쿠팡은 unit_value 개념 없음 (1:1)
          item_count: r.item_count || 0,
          item_amount: r.item_total_price || 0,
          settle_price: r.settle_price || 0,
          coupon_price: 0,
          status_seq: null, // 쿠팡은 별도 status 체계 (status_label 사용)
          // status — 클라이언트 isCancelled() / row-cancelled 시각 처리 매칭용 (raw 쿠팡 status)
          //   CARD/ETC 는 undefined → CARD/ETC 로직 영향 없음. 쿠팡은 CANCEL/ACCEPT 등.
          status: r.status,
          status_label: r.status_label || r.status || '',
          settle_method: r.settle_method || null,
          wedding_date: null,
          // 판매자배송과 로켓그로스는 우리 손이 닿는 범위가 다르다 — 주문사이트부터 갈라 둔다
          site_name: r.is_rocket_growth ? '쿠팡 로켓그로스' : '쿠팡',
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
          order_hphone: r.recv_hphone || '',  // 네이버 buyer 마스킹 → 수령인 연락처 폴백
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
          // status — 클라이언트 isCancelled() / row-cancelled 시각 처리 매칭용 (raw 네이버 status)
          //   CARD/ETC 는 undefined → CARD/ETC 로직 영향 없음. 네이버는 CANCELED/PAYED 등.
          status: r.status,
          status_label: r.status_label || r.status || '',
          settle_method: r.settle_method || null,
          wedding_date: null,
          site_name: naverSiteLabel(r.store_id),
          file_count: 0,
          delivery_seq: 1,
          source: 'naver',
          naver_store_id: r.store_id || null,
          naver_status: r.status,
          naver_order_id: r.order_id,
          display_name: r.recv_name || '',
          // 구매확정일 (migration 037) — sync 시 저장된 값 노출. NULL 이면 아직 미확정.
          confirmed_at: r.confirmed_at || null,
        }));
        rows.push(...normalized);
        rows.sort((a, b) => String(b.order_date || '').localeCompare(String(a.order_date || '')));
      }
    } catch (e) {
      console.warn('[apiOrders] 네이버 주문 UNION 실패 (무시):', e.message);
    }
    // 정수당(카페24) — 쿠팡/네이버와 동일 패턴
    try {
      const cafe24Store = require('./cafe24/store');
      const cafe24Rows = await cafe24Store.listCafe24Orders({
        startStr: startDate, endStr: endDate, byPaid: false,
        orderIds: cafe24IdsList.length ? cafe24IdsList : undefined,
      });
      if (cafe24Rows && cafe24Rows.length) {
        const normalized = cafe24Rows.map(r => ({
          order_seq: r.cafe24_order_id, // 카페24 order_id (TEXT — naver product_order_id 와 동일 처리)
          member_id: null,
          order_type: 'CAFE24',
          has_copurchase: 0,
          order_date: r.ordered_at,
          settle_date: r.paid_at,
          order_name: r.recv_name || '',
          order_hphone: r.recv_hphone || '',
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
          // status — 클라이언트 isCancelled() / row-cancelled 시각 처리 매칭용 (raw 카페24 status)
          //   CARD/ETC 는 undefined → CARD/ETC 로직 영향 없음. 카페24는 PAID/CANCELED/N40 등.
          status: r.status,
          status_label: r.status_label || r.status || '',
          settle_method: r.settle_method || null,
          wedding_date: null,
          site_name: '정수당',
          file_count: 0,
          delivery_seq: 1,
          source: 'cafe24',
          cafe24_status: r.status,
          cafe24_line_key: r.line_key,
          desired_shipping_date: r.desired_shipping_date || null,
          shipping_method: r.shipping_method || null,
          input_message: r.input_message || null,
          display_name: r.recv_name || '',
        }));
        rows.push(...normalized);
        rows.sort((a, b) => String(b.order_date || '').localeCompare(String(a.order_date || '')));
      }
    } catch (e) {
      console.warn('[apiOrders] 카페24 주문 UNION 실패 (무시):', e.message);
    }
  }
  // 바른손더기프트 수동 등록 주문 (bg_manual_orders) UNION — category='bhands_gift' 시에만.
  //   답례품 카테고리와 분리 → 매출 이중 계산 방지. 검증 편의성.
  //   API 미연동 채널이라 CSV 업로드 등으로 관리자가 직접 등록.
  //   items JSONB → 상품별 row 로 flatten. MSSQL 주문과 스키마 정규화 후 rows.push.
  if (query.category === 'bhands_gift') {
    try {
      const bgStore = require('./barungift/store');
      const manualOrders = await bgStore.listManualOrders({
        category: 'daeryepum',
        startDate,
        endDate: endDate,  // listManualOrders 는 end 를 <= 로 처리 (T23:59:59 append)
      });
      if (manualOrders && manualOrders.length) {
        const normalized = [];
        for (const mo of manualOrders) {
          const items = Array.isArray(mo.items) ? mo.items : [];
          const orderDateStr = (mo.order_date || '').toString().slice(0, 19).replace('T', ' ');
          const settlePrice = Number(mo.settle_price) || 0;
          // items 없으면 order 자체를 1 row 로 (상품 정보 없음)
          const iterItems = items.length ? items : [{ product_code: '', product_name: '', quantity: 0 }];
          iterItems.forEach((it, idx) => {
            const qty = Number(it.quantity) || 0;
            const unitPrice = Number(it.unit_price) || 0;
            // 매출 우선순위:
            //   1) items[].item_amount (CSV Q열 판매금액 합계, 신규)
            //   2) unit_price × quantity
            //   3) 첫 상품에만 settle_price 폴백 (매출 배분 안 됨)
            const itemAmount = Number(it.item_amount) || unitPrice * qty || (idx === 0 ? settlePrice : 0);
            normalized.push({
              order_seq: mo.order_id,
              member_id: null,
              order_type: 'MANUAL',   // 새 타입 — 클라이언트에서 배지 구분 가능
              has_copurchase: 0,
              order_date: orderDateStr,
              settle_date: orderDateStr,
              order_name: mo.order_name || '',
              order_hphone: mo.order_hphone || '',
              recv_name: mo.recv_name || mo.order_name || '',
              recv_hphone: mo.recv_hphone || mo.order_hphone || '',
              recv_address: mo.recv_address || '',
              recv_msg: mo.recv_msg || '',
              card_name: it.product_name || '',
              card_code: it.product_code || '',
              unit_value: 1,
              item_count: qty,
              item_amount: itemAmount,
              settle_price: settlePrice,
              coupon_price: 0,
              status_seq: mo.status_seq || 4,
              status: null,
              status_label: ({ 4: '결제확인', 3: '취소', 5: '환불', 15: '반품완료' })[mo.status_seq] || '결제확인',
              settle_method: mo.settle_method || null,
              wedding_date: null,
              site_name: mo.site_name || '바른손더기프트',
              file_count: 0,
              // items 1건당 1행으로 보이게 delivery_seq 를 순번으로 부여 (2026-08-06).
              //   프론트는 (order_seq, delivery_seq) 복합키로 행을 나눈다. 전에는 전부 1 이라
              //   items 가 2개여도 첫 행만 남았고, 두 상품의 product_code 가 같으면
              //   (수건세트: code1 = 주방세제 TGJBK03O1 공통, 옵션은 code2 로 구분)
              //   상품 목록에서도 하나로 합쳐져 옵션이 다른 2행이 1행으로 보였다.
              delivery_seq: idx + 1,
              source: 'manual',
              manual_order_id: mo.order_id,
              manual_source_memo: mo.source_memo || null,
              display_name: mo.recv_name || mo.order_name || '',
            });
          });
        }
        rows.push(...normalized);
        rows.sort((a, b) => String(b.order_date || '').localeCompare(String(a.order_date || '')));
      }
    } catch (e) {
      console.warn('[apiOrders] bg_manual_orders UNION 실패 (무시):', e.message);
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
// 쿠폰 분배 분모(ecd.item_count)는 답례품 WHERE(D01_FILTER = D01 + 위탁COM_)와 반드시 일치해야 함.
//   D01 만 세면 COM_(위탁답례품, Card_Div=D04 등) 단독주문은 item_count=NULL → 금액식의
//   coupon/NULLIF(NULL,0) = NULL → 행 전체 NULL → SUM NULL → 0원 (위탁 대시보드 0원 버그).
//   또 D01+COM_ 혼합주문은 분모가 작아 쿠폰이 과다차감되던 문제도 함께 해소.
const ETC_COUPON_DIVISOR_JOIN_D01 = etcCouponDivisorJoin("(c_cpd.Card_Div = 'D01' OR c_cpd.Card_Code LIKE 'COM[_]%')");

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

  // 매출 데이터 그룹 (migration 040) — 선택한 코드가 그룹에 속하면
  //   같은 그룹의 형제 코드까지 함께 조회해 하나의 그룹으로 합산 표시한다.
  const sgIndex = await _loadSalesGroupIndex(query.category || 'daeryepum');
  const giftExcl = await _loadGiftExclusions();   // 답례품 아님 제외 (마켓 비-답례품)
  //   목록(sales-list)은 BASE 코드를 주고 그룹 멤버는 변형코드(_A/_B)로 등록돼 있을 수 있어
  //   정확 일치 → BASE 일치 순으로 조회한다.
  const _base1 = (c) => { const m = String(c || '').match(/^(.+)_[A-Za-z]$/); return m ? m[1] : String(c || ''); };
  const groupOf = (code) => {
    const c = String(code || '').trim().toLowerCase();
    if (!c) return null;
    if (sgIndex.byCode.has(c)) return sgIndex.byCode.get(c);
    // 멤버 중 base 가 일치하는 것이 있으면 그 그룹
    for (const [mc, g] of sgIndex.byCode) if (_base1(mc) === c || _base1(c) === mc) return g;
    return null;
  };
  // 조회 대상 코드 = 입력 코드 + (그룹 소속이면) 형제 코드
  const queryCodes = [];
  const bucketKeys = [];          // 집계 단위 (그룹이면 'G:그룹명', 아니면 코드)
  const bucketLabel = new Map();  // 집계 단위 → 표시명 (그룹명)
  for (const c of productCodes) {
    const g = groupOf(c);
    const key = g ? `G:${g}` : c;
    if (!bucketKeys.includes(key)) {
      bucketKeys.push(key);
      if (g) bucketLabel.set(key, g);
    }
    const codes = g ? (sgIndex.codesByGroup.get(g) || [c]) : [c];
    codes.forEach(x => { if (!queryCodes.includes(x)) queryCodes.push(x); });
  }

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

  /** 공통 쿼리 (기간, 상품코드 리스트 → 일별 집계 rows)
   *   매칭 정책: 입력 코드(BASE) 와 정확 일치 OR 입력 코드 + '_' 변형 (_A/_B/_C 등) LIKE 매칭. */
  async function queryRange(codes, s, e) {
    const req = p.request().input('s', sql.VarChar, s).input('e', sql.VarChar, e);
    // 각 코드마다 (= OR LIKE) 절 생성 → OR 로 결합
    const matchClause = codes.map((c, i) => {
      req.input('pc' + i, sql.VarChar, c);
      return `(c.Card_Code = @pc${i} OR c.Card_Code LIKE @pc${i} + '[_]%')`;
    }).join(' OR ');

    const card = await req.query(`
      SELECT c.Card_Code AS card_code, MAX(c.Card_Name) AS card_name,
             CAST(co.order_date AS DATE) AS d, co.order_seq,
             SUM(coi.item_count) AS qty,
             -- custom_order.item_sale_price 는 '단가' → 항상 수량을 곱한다.
             --   (CUSTOM_ETC_ORDER.card_sale_price 는 라인합계라 곱하지 않는데,
             --    그 식을 CARD 쿼리에 그대로 옮겨와 자사 주문 매출이 수량만큼 과소집계됐음.
             --    2026-07-29 수정 — apiDashboardSummary 등 다른 쿼리는 원래 곱하고 있었음)
             SUM(CAST(coi.item_sale_price AS float) * coi.item_count
                 / ISNULL(NULLIF(c.Unit_Value, 0), 1)) AS amount
      FROM custom_order co WITH (NOLOCK)
      INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
      INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
      LEFT JOIN SiteInfo si WITH (NOLOCK) ON co.company_Seq = si.CompayCode
      WHERE (${matchClause})
        AND co.order_date >= @s AND co.order_date < @e
        AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5, 9)
      GROUP BY c.Card_Code, CAST(co.order_date AS DATE), co.order_seq
    `);

    const req2 = p.request().input('s', sql.VarChar, s).input('e', sql.VarChar, e);
    const matchClause2 = codes.map((c, i) => {
      req2.input('pc' + i, sql.VarChar, c);
      return `(c.Card_Code = @pc${i} OR c.Card_Code LIKE @pc${i} + '[_]%')`;
    }).join(' OR ');
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
      WHERE (${matchClause2})
        AND o.order_date >= @s AND o.order_date < @e
        AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 15)
      GROUP BY c.Card_Code, CAST(o.order_date AS DATE), o.order_seq
    `);

    // ── 마켓(쿠팡/네이버/정수당) + 더기프트 일별 행 추가 ─────────────────
    //   MSSQL rows 와 동일 스키마({card_code, card_name, d, order_seq, qty, amount})로
    //   정규화해 붙이면 아래 aggregate() 가 그대로 그룹/BASE 단위 집계한다.
    //   매칭 키 = product_code (쿠팡=등록상품ID, 네이버·정수당=자사코드).
    const mkRows = [];
    if (!query.category || query.category === 'daeryepum') {
      const wanted = new Set(codes.map(c => String(c).trim().toLowerCase()));
      const CANCELLED = new Set(['CANCELED', 'RETURNED', 'EXCHANGED', 'CANCEL', 'RETURNS',
        'C00', 'C10', 'C11', 'R00', 'R10', 'E00', 'E10']);
      const push = (code, name, day, orderKey, qty, amount, site = '') => {
        const c = String(code || '').trim();
        if (!c || !wanted.has(c.toLowerCase())) return;
        if (giftExcl.has(site, c, name)) return;   // 답례품 아님 → 제외
        mkRows.push({ card_code: c, card_name: name || c, d: String(day).slice(0, 10), order_seq: orderKey, qty: Number(qty) || 0, amount: Number(amount) || 0 });
      };
      const mergeMarket = async (loader, keyOf, site) => {
        try {
          for (const r of (await loader()) || []) {
            if (r.status && CANCELLED.has(String(r.status).toUpperCase())) continue;
            push(r.product_code, r.product_name, r.ordered_at, keyOf(r), r.item_count, r.item_total_price, site);
          }
        } catch (e) { console.warn('[product-stats] 마켓 병합 실패 (무시):', e.message); }
      };
      await mergeMarket(() => require('./coupang/store').listCoupangOrders({ startStr: s, endStr: e, byPaid: false, excludeRocketGrowth: true }), r => `CP:${r.coupang_order_id}`, '쿠팡');
      await mergeMarket(() => require('./naver/store').listNaverOrders({ startStr: s, endStr: e, byPaid: false }), r => `NV:${r.product_order_id}`, '네이버');
      await mergeMarket(() => require('./cafe24/store').listCafe24Orders({ startStr: s, endStr: e, byPaid: false }), r => `CF:${r.cafe24_order_id}`, '정수당');
      try {
        const mos = await require('./barungift/store').listManualOrders({ category: 'daeryepum', startDate: s, endDate: e });
        for (const mo of (mos || [])) {
          const st = Number(mo.status_seq) || 0;
          if (!(st >= 2 && ![3, 5, 15].includes(st))) continue;
          for (const it of (Array.isArray(mo.items) ? mo.items : [])) {
            const q = Number(it.quantity) || 0;
            push(it.product_code, it.product_name, mo.order_date, `MO:${mo.order_id}`, q, Number(it.item_amount) || (Number(it.unit_price) || 0) * q);
          }
        }
      } catch (err) { console.warn('[product-stats] 더기프트 병합 실패 (무시):', err.message); }
    }

    return [...card.recordset, ...etc.recordset, ...mkRows];
  }

  /** rows → 상품별 {name, daily[], total{}}
   *   BASE 매칭: row.card_code (예: TGJSD01O4_A) 에서 _XXX suffix 제거 → BASE 코드.
   *   입력 codes 가 BASE 단위면 모든 변형 row 가 자동 그룹핑. */
  function aggregate(rows, codes, keys = null, labels = null) {
    //   keys/labels 가 주어지면 매출 그룹 단위로 집계 (keys: 'G:그룹명' 또는 코드).
    // BASE 코드 추출 — 변형 접미사 '단일 영문자'(_A/_B/_C) 만 제거.
    //   영숫자 전체를 떼면 데코(2026_acryl_08 → 2026_acryl) / 위탁(COM_A01003 → COM) 처럼
    //   서로 다른 상품이 한 행으로 합산된다. (2026-07-29 수정)
    const toBase = (code) => {
      if (!code) return code;
      const m = String(code).match(/^(.+)_[A-Za-z]$/);
      return m ? m[1] : code;
    };
    // product_name 의 [prefix] 제거 (가장 깔끔한 이름 선호용)
    const cleanName = (n) => String(n || '').replace(/^\[.*?\]\s*/g, '').trim();
    const bucketList = keys && keys.length ? keys : codes;
    const byProduct = new Map();
    bucketList.forEach(c => byProduct.set(c, {
      product_code: c, product_name: null,
      dayMap: new Map(), allOrders: new Set(),
      variantCodes: new Set(),
    }));
    for (const r of rows) {
      // 1순위: 매출 그룹 — 그룹 소속 코드는 'G:그룹명' bucket 으로 (BASE 매칭 포함)
      const gName = keys ? groupOf(r.card_code) : null;
      // raw card_code → BASE
      const base = toBase(r.card_code);
      // BASE 가 직접 매칭되면 그 bucket, 아니면 raw 도 시도 (입력이 raw 인 경우)
      const key = (gName && byProduct.has(`G:${gName}`)) ? `G:${gName}`
        : (byProduct.has(base) ? base : (byProduct.has(r.card_code) ? r.card_code : null));
      if (!key) continue;
      const bucket = byProduct.get(key);
      bucket.variantCodes.add(r.card_code);
      // 가장 깔끔한 이름 (prefix 없는 형태) 우선
      if (r.card_name) {
        const cleaned = cleanName(r.card_name);
        if (!bucket.product_name || cleaned.length < cleanName(bucket.product_name).length || !bucket.product_name.startsWith('[')) {
          bucket.product_name = cleaned || r.card_name;
        }
      }
      const dKey = r.d instanceof Date ? fmtDate(r.d) : String(r.d).slice(0, 10);
      if (!bucket.dayMap.has(dKey)) bucket.dayMap.set(dKey, { qty: 0, orders: new Set(), revenue: 0 });
      const d = bucket.dayMap.get(dKey);
      d.qty += (r.qty || 0);
      d.revenue += (r.amount || 0);
      d.orders.add(r.order_seq);
      bucket.allOrders.add(r.order_seq);
    }
    // 최종 형태로 변환
    const products = bucketList.map(c => {
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
      const gLabel = labels ? labels.get(c) : null;   // 매출 그룹이면 그룹명 표시
      // 그룹 bucket 은 'G:그룹명' 대신 대표 코드를 노출 (프론트 선택 상태와 일치).
      //   판매 유무와 무관하게 그룹 멤버 목록에서 결정 — 기간마다 대표코드가 바뀌면
      //   전기대비(prev_total) 매칭이 깨지므로 고정값이어야 한다.
      //   대표 코드 규칙은 프론트 _sgPickRepCode 와 동일해야 선택 상태가 일치한다:
      //   숫자만인 마켓 상품ID보다 자사 코드를 우선.
      const gRepCode = gLabel
        ? (_sgPickRepCode(sgIndex.codesByGroup.get(gLabel) || []) || c)
        : null;
      return {
        product_code: gRepCode || c,
        product_name: gLabel || b.product_name,
        is_group: !!gLabel,
        variant_codes: [...b.variantCodes].sort(), // 통합된 raw 코드들 (_A/_B/_C, 그룹이면 멤버 코드)
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
  const curRows = await queryRange(queryCodes, startStr, endPlus);
  const products = aggregate(curRows, productCodes, bucketKeys, bucketLabel);

  // 전기 대비 (선택)
  if (comparePrev) {
    const prevRows = await queryRange(queryCodes, prevStart, prevEndPlus);
    const prevProducts = aggregate(prevRows, productCodes, bucketKeys, bucketLabel);
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

/**
 * GET /api/product-ranking?start_date=2026-07-20&end_date=2026-07-26
 *
 * 선택 기간(단일)의 답례품 상품 판매 순위 — 전체 채널 합산.
 *   · MSSQL (바른손카드 custom_order + 바른손몰 CUSTOM_ETC_ORDER, 답례품만 = D01_FILTER)
 *   · Supabase 마켓 (쿠팡 / 네이버 / 정수당) — 취소·반품·교환 status 제외
 *
 * 병합 키: 정규화 상품명(선행 [..] 프리픽스 제거 + trim, 소문자). MSSQL·마켓 전부 합산.
 * 반환: { period, products:[{name, qty, revenue, channels[]}], totals:{qty,revenue} } (qty 내림차순)
 */
/**
 * 매출 데이터 그룹 (migration 040) lookup 인덱스.
 *   byCode: 상품코드(소문자) → 그룹명       — 자사(코드 있는) 매출 행
 *   byName: `${site}|${상품명(소문자)}` → 그룹명, site '' 는 전체 사이트
 * 조회 실패해도 빈 인덱스 반환 (그룹 미적용으로 fallback).
 */
/** 그룹 대표 코드 선정 — 숫자만인 마켓 상품ID보다 자사 코드 우선. (프론트 _sgPickRepCode 와 동일) */
function _sgPickRepCode(codes) {
  return [...(codes || [])].sort((a, b) => {
    const na = /^\d+$/.test(a), nb = /^\d+$/.test(b);
    if (na !== nb) return na ? 1 : -1;
    return String(a).localeCompare(String(b));
  })[0] || null;
}

/**
 * 답례품 매출 제외 목록 (migration 042) — 마켓의 비-답례품 필터.
 *   자사(MSSQL)는 Card_Div 로 답례품이 걸러지지만 마켓은 구분이 없어
 *   자개 연하장·탈취제·아크릴 액자 등이 답례품 매출에 섞인다.
 *   반환: { has(site, code, name) → boolean }. 조회 실패 시 아무것도 제외 안 함(fail-open).
 *   60초 캐시 — 집계 함수마다 매번 조회하지 않도록.
 */
let _giftExclCache = { at: 0, idx: null };
async function _loadGiftExclusions() {
  const EMPTY = { size: 0, has: () => false };
  if (_giftExclCache.idx && Date.now() - _giftExclCache.at < 60000) return _giftExclCache.idx;
  try {
    const REST = process.env.SUPABASE_URL ? `${process.env.SUPABASE_URL}/rest/v1` : null;
    if (!REST) return EMPTY;
    const hdr = { apikey: process.env.SUPABASE_ANON_KEY, Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}` };
    const r = await fetch(`${REST}/bg_sales_exclusions?select=site_name,match_type,match_value&limit=2000`, { headers: hdr });
    if (!r.ok) return EMPTY;
    const rows = await r.json();
    const set = new Set();
    for (const m of (rows || [])) {
      const v = String(m.match_value || '').trim().toLowerCase();
      if (!v) continue;
      set.add(`${String(m.site_name || '').trim()}|${m.match_type}|${v}`);
    }
    const idx = {
      size: set.size,
      has(site, code, name) {
        if (!set.size) return false;
        const s = String(site || '').trim();
        const c = String(code || '').trim().toLowerCase();
        const n = String(name || '').trim().toLowerCase();
        if (c && (set.has(`${s}|code|${c}`) || set.has(`|code|${c}`))) return true;
        if (n && (set.has(`${s}|name|${n}`) || set.has(`|name|${n}`))) return true;
        return false;
      },
    };
    _giftExclCache = { at: Date.now(), idx };
    return idx;
  } catch (e) {
    console.warn('[sales-exclusions] 로드 실패 (제외 미적용):', e.message);
    return EMPTY;
  }
}

async function _loadSalesGroupIndex(category = 'daeryepum') {
  //   codesByGroup: 그룹명 → [상품코드...] (상품별 판매통계에서 형제 코드까지 확장 조회용)
  const empty = { byCode: new Map(), byName: new Map(), codesByGroup: new Map() };
  try {
    const REST = process.env.SUPABASE_URL ? `${process.env.SUPABASE_URL}/rest/v1` : null;
    if (!REST) return empty;
    const hdr = { apikey: process.env.SUPABASE_ANON_KEY, Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}` };
    const [gRes, mRes] = await Promise.all([
      fetch(`${REST}/bg_sales_groups?select=id,name,category&category=eq.${encodeURIComponent(category)}`, { headers: hdr }),
      fetch(`${REST}/bg_sales_group_members?select=group_id,site_name,match_type,match_value&limit=5000`, { headers: hdr }),
    ]);
    if (!gRes.ok || !mRes.ok) return empty;
    const groups = await gRes.json();
    const members = await mRes.json();
    const nameById = new Map((groups || []).map(g => [g.id, g.name]));
    for (const m of (members || [])) {
      const gName = nameById.get(m.group_id);
      if (!gName) continue;                       // 다른 카테고리 그룹
      const v = String(m.match_value || '').trim().toLowerCase();
      if (!v) continue;
      if (m.match_type === 'code') {
        empty.byCode.set(v, gName);
        if (!empty.codesByGroup.has(gName)) empty.codesByGroup.set(gName, []);
        // 원본 대소문자 보존 — MSSQL 조회 파라미터로 그대로 사용
        empty.codesByGroup.get(gName).push(String(m.match_value).trim());
      } else empty.byName.set(`${String(m.site_name || '').trim()}|${v}`, gName);
    }
    return empty;
  } catch (e) {
    console.warn('[sales-groups] 인덱스 로드 실패 (무시):', e.message);
    return empty;
  }
}

async function apiProductRanking(query = {}) {
  const startStr = query.start_date;
  const endStr = query.end_date;
  if (!startStr || !endStr) return { error: 'start_date and end_date required' };

  // 매출 데이터 그룹 — 운영자가 묶은 그룹은 이름/코드 규칙보다 우선 적용.
  const sgIndex = await _loadSalesGroupIndex(query.category || 'daeryepum');
  // 답례품 아님으로 지정된 마켓 품목 제외 (자개카드·탈취제·아크릴액자 등)
  const giftExcl = await _loadGiftExclusions();

  // end exclusive (+1일) — MSSQL order_date < @e / 마켓 store endStr(lt) 공통.
  const endPlus = fmtDate(addDays(new Date(endStr + 'T00:00:00'), 1));

  // 상품명 정규화 — 선행 [XX%할인]/[시크릿특가] 등 [..] 프리픽스 제거.
  const cleanName = (n) => String(n || '').replace(/^\[.*?\]\s*/g, '').trim();
  // 자사(카드/더기프트) 병합용 — 프리픽스 제거 + 끝의 (80g)/(4종 8개입) 등 괄호 규격/용량 접미사 제거.
  //   채널별 상품명 표기 차이(카드 "메이플 호두정과" vs 더기프트 "메이플 호두정과 (80g)")를 한 상품으로 병합.
  const normName = (n) => cleanName(n)
    .replace(/\s*\([^()]*\)\s*$/, '')   // 끝 괄호 그룹 1회 제거
    .replace(/\s*\([^()]*\)\s*$/, '')   // 접미 괄호 2개 대비 1회 더
    .trim();
  // BASE 코드 정규화 (apiProductStats.toBase 재사용) — 단일 영문자 변형(_A/_B) 만 base 로.
  const toBase = (code) => {
    if (!code) return code;
    const m = String(code).match(/^(.+)_[A-Za-z]$/);
    return m ? m[1] : code;
  };

  // 병합 맵 — key: 정규화 상품명(소문자). value: { name, qty, revenue, channels:Set }.
  const byName = new Map();
  //   scope 'own'          : 자사(바른손카드/바른손몰/더기프트) — normName 으로 병합(규격 접미사까지 통일).
  //   scope 'market:{채널}' : 외부 마켓 — 상품명이 마케팅 롱타이틀이라 자사와 표기가 달라 섞이지 않도록
  //                          분리하고, 채널(쿠팡/네이버/정수당)별로도 각각 나눈다.
  function addEntry(rawName, qty, revenue, channelLabel, scope = 'own', memberSpec = null) {
    // 자사 계열(own, own:*)은 같은 이름 정규화를 쓴다 — scope 를 나눴다고 표시명 규칙이
    //   달라지면 같은 상품이 섹션마다 다른 이름으로 보인다.
    const isOwn = scope === 'own' || String(scope).startsWith('own:');
    const display = isOwn
      ? (normName(rawName) || cleanName(rawName) || String(rawName || '').trim())
      : (cleanName(rawName) || String(rawName || '').trim());
    if (!display) return;
    const key = `${scope}|` + display.toLowerCase();
    if (!byName.has(key)) byName.set(key, { name: display, qty: 0, revenue: 0, channels: new Set(), scope, members: new Map() });
    const e = byName.get(key);
    e.qty += Number(qty) || 0;
    e.revenue += Number(revenue) || 0;
    if (channelLabel) e.channels.add(channelLabel);
    // 이 행을 매출 그룹에 담을 때 쓸 멤버 스펙 (프론트 '그룹으로 묶기' 가 그대로 전송).
    if (memberSpec && memberSpec.match_value) {
      const mk = `${memberSpec.site_name || ''}|${memberSpec.match_type}|${memberSpec.match_value}`;
      if (!e.members.has(mk)) e.members.set(mk, { ...memberSpec, label: memberSpec.label || display });
    }
  }

  /** 상품명 → 매출 그룹명 (사이트 지정 멤버 우선 → 전체 사이트 멤버). 없으면 null. */
  function groupForName(site, rawName) {
    if (!sgIndex.byName.size) return null;
    const s = String(site || '').trim();
    const n = String(rawName || '').trim().toLowerCase();
    const c = cleanName(rawName).trim().toLowerCase();
    for (const v of [n, c]) {
      if (!v) continue;
      const hit = sgIndex.byName.get(`${s}|${v}`) || sgIndex.byName.get(`|${v}`);
      if (hit) return hit;
    }
    return null;
  }

  // ── 1) MSSQL (CARD + ETC, 답례품만) ──────────────────────────────
  try {
    const p = await getPool();

    // CARD (바른손카드 custom_order) — 라인 단위 조회 (세트 재구성용).
    const cardQ = await p.request()
      .input('s', sql.VarChar, startStr)
      .input('e', sql.VarChar, endPlus)
      .query(`
        SELECT co.order_seq, c.Card_Code AS card_code, c.Card_Name AS card_name,
               SUM(coi.item_count) AS qty,
               -- item_sale_price = 단가 → 항상 수량 곱 (2026-07-29 수정, 위 apiProductStats 동일)
               SUM(CAST(coi.item_sale_price AS float) * coi.item_count
                   / ISNULL(NULLIF(c.Unit_Value, 0), 1)) AS amount
        FROM custom_order co WITH (NOLOCK)
        INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
        INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
        LEFT JOIN SiteInfo si WITH (NOLOCK) ON co.company_Seq = si.CompayCode
        WHERE ${D01_FILTER}
          AND co.order_date >= @s AND co.order_date < @e
          AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5, 9)
        GROUP BY co.order_seq, c.Card_Code, c.Card_Name
      `);

    // ETC (바른손몰 CUSTOM_ETC_ORDER) — 라인 단위 조회 (세트 재구성용), coupon 차감.
    const etcQ = await p.request()
      .input('s', sql.VarChar, startStr)
      .input('e', sql.VarChar, endPlus)
      .query(`
        SELECT o.order_seq, c.Card_Code AS card_code, c.Card_Name AS card_name,
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
        WHERE ${D01_FILTER}
          AND o.order_date >= @s AND o.order_date < @e
          AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 15)
        GROUP BY o.order_seq, c.Card_Code, c.Card_Name
      `);

    // ── 세트 재구성 (바른손몰 옵션구성 세트 주문) ───────────────────────
    //   바른손몰 세트 주문은 [유료 구성품 라인들 + 0원 세트 라벨 라인] 으로 기록된다.
    //     예) "수건&주방타올 세트" 150세트 = 수건무지40 150개(58.5만) + 스퀘어34 150개(46.5만)
    //         + 세트라벨 150개(0원)
    //   그대로 코드 집계하면 ① 0원 라벨 수량이 허수로 잡혀 객단가 왜곡,
    //   ② 구성품 코드(스퀘어34 등)가 여러 세트 공용이라 매출이 엉뚱한 상품/그룹에 배분,
    //   ③ 구성품 낱개명(고리수건_엑스34)으로 표시돼 그룹화가 애매해짐.
    //   → 주문 안에 0원 세트 라벨이 정확히 1종이면: 유료 라인 매출 전부를 세트명으로 귀속,
    //     수량은 라벨 수량(=세트 수) 사용. 라벨이 없거나 2종 이상(배분 모호)이면 현행 유지.
    const reconstructSets = (lines) => {
      const byOrder = new Map();
      lines.forEach(r => {
        if (!byOrder.has(r.order_seq)) byOrder.set(r.order_seq, []);
        byOrder.get(r.order_seq).push(r);
      });
      const out = [];
      for (const rows of byOrder.values()) {
        // 세트 라벨 판별: 0원 + '세트' 또는 '(N구)' 명칭 (돌잔치 수건 답례품 (2구) 등).
        //   이름 조건을 두는 이유: 0원 사은품 라인(스티커 증정 등)을 라벨로 오인해
        //   주문 전체 매출이 사은품 이름으로 귀속되는 것을 방지.
        const labels = rows.filter(r => Math.round(Number(r.amount) || 0) === 0
          && (Number(r.qty) || 0) > 0
          && /세트|\(\s*\d+\s*구\s*\)/.test(String(r.card_name || '')));
        const labelCodes = new Set(labels.map(l => l.card_code));
        const labelQty = labels.reduce((s, l) => s + (Number(l.qty) || 0), 0);
        const paid = rows.filter(r => !labels.includes(r));
        // 안전장치: 유료 라인 수량이 라벨 수량을 초과하면(세트와 무관한 단독 상품 혼재 의심)
        //   귀속이 모호하므로 재구성하지 않고 현행 유지.
        const ambiguous = paid.some(r => (Number(r.qty) || 0) > labelQty);
        if (labels.length && labelCodes.size === 1 && labelQty > 0 && paid.length && !ambiguous) {
          const label = labels[0];
          const rev = paid.reduce((s, r) => s + (Number(r.amount) || 0), 0);
          out.push({ card_code: label.card_code, card_name: label.card_name,
            qty: labelQty, amount: rev, _setRecon: true });
        } else {
          out.push(...rows);
        }
      }
      return out;
    };
    const mssqlRows = reconstructSets([...cardQ.recordset, ...etcQ.recordset]);

    // toBase 로 변형 코드(_A/_B) 를 base 로 묶어 이름 선택 후 addEntry (최종 병합은 상품명 기준).
    const baseAgg = new Map(); // base code → { name, qty, revenue }
    for (const r of mssqlRows) {
      // 매출 그룹(migration 040) 에 담긴 코드는 그룹명으로 바로 합산 — base/이름 규칙보다 우선.
      //   재구성된 세트 행(_setRecon)은 라벨 코드가 구성품 코드 계열(TGJBK09O6_A 등)이라
      //   BASE 폴백을 쓰면 엉뚱한 구성품 그룹에 붙을 수 있음 → 정확 일치만 허용.
      const gName = sgIndex.byCode.get(String(r.card_code || '').trim().toLowerCase())
        || (r._setRecon ? null : sgIndex.byCode.get(String(toBase(r.card_code) || '').trim().toLowerCase()));
      const mSpec = { site_name: '', match_type: 'code', match_value: r.card_code, label: r.card_name };
      if (gName) {
        addEntry(gName, Number(r.qty) || 0, Math.round(Number(r.amount) || 0), 'card', 'own', mSpec);
        continue;
      }
      // 재구성 세트는 라벨 코드 그대로 (BASE 병합 시 구성품 낱개 행과 뭉치는 것 방지)
      const base = r._setRecon ? r.card_code : (toBase(r.card_code) || r.card_code);
      if (!baseAgg.has(base)) baseAgg.set(base, { name: null, qty: 0, revenue: 0, specs: [] });
      baseAgg.get(base).specs.push(mSpec);
      const b = baseAgg.get(base);
      // 가장 깔끔한(프리픽스 없는) 이름 우선
      if (r.card_name) {
        const cleaned = cleanName(r.card_name);
        if (!b.name || (cleaned && cleaned.length < cleanName(b.name).length) || b.name.startsWith('[')) {
          b.name = cleaned || r.card_name;
        }
      }
      b.qty += Number(r.qty) || 0;
      b.revenue += Number(r.amount) || 0;
    }
    for (const b of baseAgg.values()) {
      // base 하나에 여러 코드(변형)가 묶일 수 있어 각 코드를 멤버 후보로 모두 전달.
      (b.specs || []).forEach((sp, i) => addEntry(b.name, i === 0 ? b.qty : 0, i === 0 ? Math.round(b.revenue) : 0, 'card', 'own', sp));
    }
  } catch (e) {
    console.warn('[product-ranking] MSSQL 집계 실패 (무시):', e.message);
  }

  // ── 2) Supabase 마켓 (쿠팡 / 네이버 / 정수당) ─────────────────────
  // 취소/반품/교환 status 제외 (CARD/ETC status_seq NOT IN 정책과 동일).
  const CANCELLED_STATUS = new Set([
    'CANCELED', 'RETURNED', 'EXCHANGED', 'CANCEL', 'RETURNS',
    'C00', 'C10', 'C11', 'R00', 'R10', 'E00', 'E10',
  ]);
  async function mergeMarket(label, loader) {
    try {
      const rows = await loader();
      for (const r of (rows || [])) {
        if (r.status && CANCELLED_STATUS.has(String(r.status).toUpperCase())) continue;
        if (giftExcl.has(label, r.product_code, r.product_name)) continue;   // 답례품 아님 → 제외
        // 매출 그룹에 담긴 마켓 상품명은 그룹명으로 합산 (사이트 지정 멤버 우선, 없으면 전체).
        // 채널별 섹션 분리를 위해 scope 에 채널명 포함 (market:쿠팡 / market:네이버 / market:정수당)
        addEntry(groupForName(label, r.product_name) || r.product_name,
          r.item_count, r.item_total_price, label, `market:${label}`,
          { site_name: label, match_type: 'name', match_value: r.product_name, label: r.product_name });
      }
    } catch (e) {
      console.warn(`[product-ranking] ${label} 집계 실패 (무시):`, e.message);
    }
  }
  await mergeMarket('쿠팡', () => require('./coupang/store').listCoupangOrders({ startStr, endStr: endPlus, byPaid: false, excludeRocketGrowth: true }));
  await mergeMarket('네이버', () => require('./naver/store').listNaverOrders({ startStr, endStr: endPlus, byPaid: false }));
  await mergeMarket('정수당', () => require('./cafe24/store').listCafe24Orders({ startStr, endStr: endPlus, byPaid: false }));

  // ── 쿠팡 로켓그로스 (RFM) — 일반 쿠팡과 별도 채널 섹션으로 분리 ────────
  //   정산 리포트 업로드분(일자×옵션 단위)만 상품 순위에 반영.
  //   vendor_item_id='_manual'(일별 합계 수동입력)은 상품이 아니므로 제외.
  //   수량/매출은 환불 차감한 순 기준 (다른 채널도 취소 제외 순 기준이라 일관).
  try {
    const rfmRows = await require('./coupang/rfm-store').listSales({ startDate: startStr, endDate: endStr });
    for (const r of (rfmRows || [])) {
      if (String(r.vendor_item_id) === '_manual') continue;
      if (giftExcl.has('쿠팡 로켓그로스', r.product_id, r.product_name)) continue;   // 답례품 아님 → 제외
      const qty = (Number(r.sales_qty) || 0) - (Number(r.refund_qty) || 0);
      const amt = Number(r.net_amount ?? ((Number(r.sales_amount) || 0) - (Number(r.refund_amount) || 0))) || 0;
      if (!qty && !amt) continue;
      const gName = sgIndex.byCode.get(String(r.product_id || '').trim().toLowerCase())
        || groupForName('쿠팡 로켓그로스', r.product_name);
      addEntry(gName || r.product_name, qty, amt, '쿠팡 로켓그로스', 'market:쿠팡 로켓그로스',
        r.product_id
          ? { site_name: '', match_type: 'code', match_value: String(r.product_id), label: r.product_name }
          : { site_name: '쿠팡 로켓그로스', match_type: 'name', match_value: r.product_name, label: r.product_name });
    }
  } catch (e) {
    console.warn('[product-ranking] 로켓그로스 집계 실패 (무시):', e.message);
  }

  // ── 3) 더기프트 수동 등록 (bg_manual_orders, category=daeryepum) ───
  //   주문조회 "답례품_더기프트" 탭 소스 — API 미연동 채널이라 CSV 업로드로 관리자 직접 등록.
  //   MSSQL 답례품과 분리 저장돼 있어(이중계산 없음) 상품별 통계엔 별도 소스로 합산.
  //   items[] flatten → 상품명 기준 병합. 매출 우선순위: item_amount > unit_price×qty.
  try {
    const manualOrders = await require('./barungift/store').listManualOrders({
      category: 'daeryepum', startDate: startStr, endDate: endStr,
    });
    for (const mo of (manualOrders || [])) {
      const items = Array.isArray(mo.items) ? mo.items : [];
      for (const it of items) {
        const qty = Number(it.quantity) || 0;
        const amt = Number(it.item_amount) || (Number(it.unit_price) || 0) * qty;
        if (!it.product_name && !qty && !amt) continue;
        // 매출 그룹 — 상품코드 매칭 우선, 없으면 (사이트 더기프트 + 상품명) 매칭.
        const gName = sgIndex.byCode.get(String(it.product_code || '').trim().toLowerCase())
          || groupForName('더기프트', it.product_name);
        const mSpec = it.product_code
          ? { site_name: '', match_type: 'code', match_value: it.product_code, label: it.product_name }
          : { site_name: '더기프트', match_type: 'name', match_value: it.product_name, label: it.product_name };
        // 더기프트는 소스가 따로라(bg_manual_orders) 섹션도 나눈다 — 바른손카드와 섞이면
        //   어느 채널에서 팔린 건지 구분이 안 된다 (운영 요청 2026-08-12).
        addEntry(gName || it.product_name, qty, amt, '더기프트', 'own:thegift', mSpec);
      }
    }
  } catch (e) {
    console.warn('[product-ranking] 더기프트 수동주문 집계 실패 (무시):', e.message);
  }

  // ── 4) 결과 정리 — qty 내림차순 ─────────────────────────────────
  const products = [...byName.values()]
    .map(e => ({
      name: e.name, qty: e.qty, revenue: Math.round(e.revenue),
      channels: [...e.channels], scope: e.scope,
      members: [...e.members.values()],   // '그룹으로 묶기' 용 멤버 스펙
    }))
    .sort((a, b) => b.qty - a.qty);

  const totals = {
    qty: products.reduce((s, p) => s + p.qty, 0),
    revenue: products.reduce((s, p) => s + p.revenue, 0),
  };

  return {
    period: { start_date: startStr, end_date: endStr },
    products,
    totals,
  };
}

/**
 * GET /api/weekly-report?weeks=12
 *
 * 주간보고용 — 최근 N주(기본 12, 주 시작=일요일, 일~토)의 주차별 상관관계 데이터.
 *   · wedding_count : 각 주차의 28일 비대칭 윈도우(-14~+7일) 내 예식(결혼) 수.
 *       (apiForecast wedding_pool 과 동일 — 답례품은 예식 전후 걸쳐 주문되므로 풀 기준)
 *       apiForecast/apiConversionWindow 의 예식 집계 로직 재사용:
 *       S2_UserInfo wedd_year/month/day, site_div='SB' 중복제거, USE_YORN='Y'.
 *   · order_count   : 해당 주 답례품 주문 수(distinct order) — 전체 채널.
 *       MSSQL: custom_order(CARD)+CUSTOM_ETC_ORDER(ETC), D01_FILTER, order_date 주,
 *              status_seq >=2 AND NOT IN(3,5,9)(CARD)/(3,5,15)(ETC), distinct order_seq.
 *       마켓: 쿠팡/네이버/정수당 — 취소status 제외 후 distinct 주문키.
 *   · revenue       : 해당 주 답례품 매출 — MSSQL 산식은 apiProductRanking 과 동일
 *       (사이트 기반, ETC coupon 차감), 마켓은 item_total_price 합.
 *
 * 각 소스 try/catch 로 격리 — 한 채널 실패가 전체를 막지 않음 (헬스체크 안전).
 *
 * 반환: { weeks:[{ week_start:'YYYY-MM-DD', label:'MM/DD~MM/DD',
 *                  wedding_count, order_count, revenue }] }  (오래된→최신 순)
 */
async function apiWeeklyReport(query = {}) {
  const nWeeks = Math.max(1, Math.min(52, parseInt(query.weeks, 10) || 12));

  // 주 시작 = 일요일 (일~토 주). JS getDay(): 일=0..토=6 → 이번주 일요일 = 오늘 - dow.
  const todayDate = today();
  const dow = todayDate.getDay();
  const thisSunday = addDays(todayDate, -dow);

  // 오래된→최신 순으로 주차 골격 생성.
  const weeks = [];
  for (let i = nWeeks - 1; i >= 0; i--) {
    const weekStart = addDays(thisSunday, -7 * i);   // 일요일
    const weekEnd = addDays(weekStart, 6);            // 토요일
    const fmtMD = (d) => `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
    const wkNo = getISOWeek(addDays(weekStart, 4));   // 일~토 주의 목요일 기준 ISO 주차 (07/19~07/25 → W30)
    weeks.push({
      week_start: fmtDate(weekStart),
      week_no: wkNo,
      label: `W${wkNo} ${fmtMD(weekStart)}~${fmtMD(weekEnd)}`,
      wedding_count: 0,
      order_count: 0,
      revenue: 0,
      conversion_rate: 0,   // = order_count / wedding_count (%) — 최종 패스에서 계산
    });
  }
  // 날짜(YYYY-MM-DD) → 주차 index 매핑 (범위 밖이면 undefined).
  const weekIndexOf = (dateStr) => {
    if (!dateStr) return undefined;
    const d = new Date(dateStr + 'T00:00:00');
    const diffDays = Math.floor((d - new Date(fmtDate(addDays(thisSunday, -7 * (nWeeks - 1))) + 'T00:00:00')) / 86400000);
    if (diffDays < 0) return undefined;
    const idx = Math.floor(diffDays / 7);
    return idx >= 0 && idx < weeks.length ? idx : undefined;
  };

  const rangeStart = weeks[0].week_start;                       // inclusive
  const rangeEndExcl = fmtDate(addDays(thisSunday, 7));         // 현재 주(토) 다음 일요일 (exclusive)
  // 예식수는 각 주차의 28일 윈도우(-14~+7일) 합산 → 예식 조회 범위를 앞뒤로 확장.
  const weddQueryStart = fmtDate(addDays(new Date(rangeStart + 'T00:00:00'), -14));
  const weddQueryEndExcl = fmtDate(addDays(thisSunday, 14));    // 마지막주 토(+6) + 7일 + 1

  // ── 1) 예식 수 (S2_UserInfo, site_div='SB' 중복제거) ────────────────
  try {
    const p = await getPool();
    const weddRes = await p.request()
      .input('ws', sql.VarChar, weddQueryStart)
      .input('we', sql.VarChar, weddQueryEndExcl)
      .query(`
        SELECT wedd_date, COUNT(*) AS wedding_count
        FROM (
          SELECT DISTINCT u.uid,
            CONVERT(varchar(10), TRY_CAST(u.wedd_year+'-'+RIGHT('0'+u.wedd_month,2)+'-'+RIGHT('0'+u.wedd_day,2) AS date), 120) AS wedd_date
          FROM S2_UserInfo u WITH (NOLOCK)
          WHERE u.site_div = 'SB'
            AND u.USE_YORN = 'Y'
            AND u.wedd_year IS NOT NULL AND LEN(u.wedd_year) = 4
            AND TRY_CAST(u.wedd_year+'-'+RIGHT('0'+u.wedd_month,2)+'-'+RIGHT('0'+u.wedd_day,2) AS date) >= @ws
            AND TRY_CAST(u.wedd_year+'-'+RIGHT('0'+u.wedd_month,2)+'-'+RIGHT('0'+u.wedd_day,2) AS date) < @we
        ) t
        GROUP BY wedd_date
      `);
    // 예식일별 카운트 맵 → 각 주차 예식수 = 28일 비대칭 윈도우(-14~+7일) 합.
    //   apiForecast 의 wedding_pool 과 동일 정책 (답례품은 예식 전후 걸쳐 주문되므로 풀 기준).
    const weddingDailyMap = {};
    for (const r of weddRes.recordset) {
      weddingDailyMap[r.wedd_date] = (weddingDailyMap[r.wedd_date] || 0) + (Number(r.wedding_count) || 0);
    }
    for (const w of weeks) {
      const ws = new Date(w.week_start + 'T00:00:00');
      let pool = 0;
      for (let dd = -14; dd <= 6 + 7; dd++) pool += weddingDailyMap[fmtDate(addDays(ws, dd))] || 0;
      w.wedding_count = pool;
    }
  } catch (e) {
    console.warn('[weekly-report] 예식 집계 실패 (무시):', e.message);
  }

  // ── 2) MSSQL 답례품 주문 수 + 매출 (CARD + ETC, 일별 → 주차 버킷) ──
  //   금액 산식은 apiProductRanking 과 동일 (사이트 기반, ETC coupon 차감).
  //   order_count = COUNT(DISTINCT order_seq) — order_date 는 주문당 단일이라 일별 distinct 합산 = 주별 distinct.
  try {
    const p = await getPool();
    const cardDaily = await p.request()
      .input('s', sql.VarChar, rangeStart)
      .input('e', sql.VarChar, rangeEndExcl)
      .query(`
        SELECT CONVERT(varchar(10), co.order_date, 120) AS d,
               COUNT(DISTINCT co.order_seq) AS order_count,
               -- item_sale_price = 단가 → 항상 수량 곱 (2026-07-29 수정)
               SUM(CAST(coi.item_sale_price AS float) * coi.item_count
                   / ISNULL(NULLIF(c.Unit_Value, 0), 1)) AS revenue
        FROM custom_order co WITH (NOLOCK)
        INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
        INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
        LEFT JOIN SiteInfo si WITH (NOLOCK) ON co.company_Seq = si.CompayCode
        WHERE ${D01_FILTER}
          AND co.order_date >= @s AND co.order_date < @e
          AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5, 9)
        GROUP BY CONVERT(varchar(10), co.order_date, 120)
      `);
    const etcDaily = await p.request()
      .input('s', sql.VarChar, rangeStart)
      .input('e', sql.VarChar, rangeEndExcl)
      .query(`
        SELECT CONVERT(varchar(10), o.order_date, 120) AS d,
               COUNT(DISTINCT o.order_seq) AS order_count,
               SUM(
                 CASE WHEN si.SiteName IS NULL
                      THEN CAST(ei.card_sale_price AS float) * ei.order_count
                           / ISNULL(NULLIF(c.Unit_Value, 0), 1)
                           - ISNULL(o.coupon_price, 0)
                      ELSE CAST(ei.card_sale_price AS float) - ISNULL(o.coupon_price, 0)
                 END
               ) AS revenue
        FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
        INNER JOIN CUSTOM_ETC_ORDER_ITEM ei WITH (NOLOCK) ON o.order_seq = ei.order_seq
        INNER JOIN S2_Card c WITH (NOLOCK) ON ei.card_seq = c.Card_Seq
        LEFT JOIN SiteInfo si WITH (NOLOCK) ON o.company_Seq = si.CompayCode
        WHERE ${D01_FILTER}
          AND o.order_date >= @s AND o.order_date < @e
          AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 15)
        GROUP BY CONVERT(varchar(10), o.order_date, 120)
      `);
    for (const r of [...cardDaily.recordset, ...etcDaily.recordset]) {
      const idx = weekIndexOf(r.d);
      if (idx === undefined) continue;
      weeks[idx].order_count += Number(r.order_count) || 0;
      weeks[idx].revenue += Number(r.revenue) || 0;
    }
  } catch (e) {
    console.warn('[weekly-report] MSSQL 주문/매출 집계 실패 (무시):', e.message);
  }

  // ── 3) 마켓 (쿠팡 / 네이버 / 정수당) ─────────────────────────────
  //   취소 status 제외 → distinct 주문키(주차별) 카운트 + item_total_price 합.
  //   ordered_at 주 기준 (byPaid=false). 각 채널 독립 try/catch.
  const CANCELLED_STATUS = new Set([
    'CANCELED', 'RETURNED', 'EXCHANGED', 'CANCEL', 'RETURNS',
    'C00', 'C10', 'C11', 'R00', 'R10', 'E00', 'E10',
  ]);
  // 주차별 distinct 주문키 집합 (order_count 계산용)
  const weekOrderKeys = weeks.map(() => new Set());
  const giftExcl = await _loadGiftExclusions();   // 답례품 아님 제외 (마켓 비-답례품)
  async function mergeMarket(loader, getKey, site = '') {
    try {
      const rows = await loader();
      for (const r of (rows || [])) {
        if (r.status && CANCELLED_STATUS.has(String(r.status).toUpperCase())) continue;
        if (giftExcl.has(site, r.product_code, r.product_name)) continue;
        const day = String(r.ordered_at || '').slice(0, 10);
        const idx = weekIndexOf(day);
        if (idx === undefined) continue;
        weeks[idx].revenue += Number(r.item_total_price) || 0;
        weekOrderKeys[idx].add(getKey(r));
      }
    } catch (e) {
      console.warn('[weekly-report] 마켓 집계 실패 (무시):', e.message);
    }
  }
  await mergeMarket(
    () => require('./coupang/store').listCoupangOrders({ startStr: rangeStart, endStr: rangeEndExcl, byPaid: false, excludeRocketGrowth: true }),
    r => `${r.coupang_order_id}::${r.shipment_box_id}`, '쿠팡',
  );
  await mergeMarket(
    () => require('./naver/store').listNaverOrders({ startStr: rangeStart, endStr: rangeEndExcl, byPaid: false }),
    r => `${r.product_order_id}`, '네이버',
  );
  await mergeMarket(
    () => require('./cafe24/store').listCafe24Orders({ startStr: rangeStart, endStr: rangeEndExcl, byPaid: false }),
    r => `${r.cafe24_order_id}`, '정수당',
  );
  // 마켓 distinct 주문키 → order_count 합산
  weeks.forEach((w, i) => { w.order_count += weekOrderKeys[i].size; });

  // 매출 반올림 + 전환율(답례품 주문수 ÷ 예식수, %) 계산
  weeks.forEach(w => {
    w.revenue = Math.round(w.revenue);
    w.conversion_rate = w.wedding_count > 0
      ? Math.round(w.order_count / w.wedding_count * 1000) / 10   // 소수점 1자리 %
      : 0;
  });

  return { weeks };
}

/**
 * 작가별 정산 합계 + 품목별 drill-down (Phase 3).
 *
 * 매출 기준:
 *   - 결제일 (settle_date) 기간 필터
 *   - status_seq: CARD NOT IN (3, 5, 9) / ETC NOT IN (3, 5, 15) — 기존 매출 SQL 정책 동일
 *
 * 매칭:
 *   - S2_Card.Card_Code == bg_artist_products.product_code (exact match)
 *
 * 응답:
 *   {
 *     period: { start, end },
 *     totals: { total_qty, total_amount, settlement_amount },
 *     by_artist: [{ artist_id, name, commission_rate, product_count, category_list, total_qty, total_amount, settlement_amount }],
 *     by_product: [{ product_code, product_name, category, artist_id, artist_name, commission_rate, card_amount, etc_amount, total_amount, total_qty, settlement_amount }]
 *   }
 */
async function apiArtistSettlements(query = {}) {
  // 1) 기간 결정 — default: 이번 달 1일 ~ 다음 달 1일 (exclusive)
  const todayDate = today();
  const defaultStart = fmtDate(new Date(todayDate.getFullYear(), todayDate.getMonth(), 1));
  const defaultEnd = fmtDate(new Date(todayDate.getFullYear(), todayDate.getMonth() + 1, 1));
  const startDate = query.start_date || defaultStart;
  const endDate = query.end_date || defaultEnd;

  // 기준일 — 'settle' (결제일, default) / 'order' (주문일) / 'ship' (출고완료일).
  //   'ship' 은 실제 발송 시점 기록 컬럼 사용:
  //     · CARD: src_send_date (발송일)
  //     · ETC:  delivery_date (배송일)
  //   해당 컬럼이 NULL 이면 아직 발송 안 된 주문 → 자동 제외 (WHERE 필터).
  const basis = (query.basis || 'settle').toLowerCase();
  let cardDateCol, etcDateCol;
  if (basis === 'ship') { cardDateCol = 'src_send_date'; etcDateCol = 'delivery_date'; }
  else if (basis === 'order') { cardDateCol = 'order_date'; etcDateCol = 'order_date'; }
  else { cardDateCol = 'settle_date'; etcDateCol = 'settle_date'; }

  // 2) Supabase: 활성 작가 + 활성 품목 (artist join)
  const artistsByCode = new Map(); // product_code → { artist_id, artist_name, commission_rate, category, product_name }
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/bg_artist_products?select=product_code,product_name,category,is_active,artist_id,bg_artists(id,name,commission_rate,is_active)`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const arr = await r.json();
    if (!r.ok) return { error: 'Supabase 조회 실패: ' + (arr?.message || r.status) };
    for (const p of (Array.isArray(arr) ? arr : [])) {
      if (!p.is_active) continue;
      const a = p.bg_artists;
      artistsByCode.set(p.product_code, {
        product_code: p.product_code,
        product_name: p.product_name || '',
        category: p.category || '',
        artist_id: p.artist_id || null,
        artist_name: a?.name || '<미매핑>',
        commission_rate: Number(a?.commission_rate || 0)
      });
    }
  } catch (e) {
    return { error: 'Supabase 조회 실패: ' + e.message };
  }

  if (artistsByCode.size === 0) {
    return {
      period: { start: startDate, end: endDate },
      totals: { total_qty: 0, total_amount: 0, settlement_amount: 0 },
      by_artist: [], by_product: [],
      message: '등록된 활성 품목이 없습니다.'
    };
  }

  // 3) MSSQL: CARD + ETC 매출 합산 (병렬)
  const productCodes = [...artistsByCode.keys()];
  const codesEscaped = productCodes.map(c => `'${String(c).replace(/'/g, "''")}'`).join(',');
  const sales = new Map(); // product_code → { card_amount, etc_amount, card_qty, etc_qty, total_amount, total_qty }
  try {
    const p = await getPool();
    // TRIM + UPPER 매칭 — 진단 endpoint 와 동일 정책. product_code 대소문자/공백 문제 방어.
    const codesUpperEscaped = codesEscaped.toUpperCase();
    // basis 별 SQL 조각 (CARD/ETC 각자 다른 컬럼 사용 가능)
    const cardDate = `co.${cardDateCol}`;
    const etcDate  = `o.${etcDateCol}`;
    // NULL 필터 — 해당 컬럼이 있어야 유효 (아직 결제/발송 안 된 주문 제외).
    //   order_date 는 항상 있으니 order 는 필터 X.
    const cardNullClause = basis === 'order' ? '' : `AND co.${cardDateCol} IS NOT NULL`;
    const etcNullClause  = basis === 'order' ? '' : `AND o.${etcDateCol} IS NOT NULL`;

    const [cardRes, etcRes] = await Promise.all([
      // CARD — 금액 비례 분배 (정률/정액 쿠폰 모두 정확):
      //   · point_price + CUSTOM_ORDER_COUPON.COUPON_AMT 합계 = 총 할인
      //   · 각 작가 아이템 gross 비율대로 배분 차감 (아이템 수 균등 X → 금액 비례)
      //   · 예: A 200,000 + B 100,000 + 쿠폰 30,000 → A -20,000 / B -10,000 (2:1)
      p.request()
        .input('s', sql.VarChar, startDate)
        .input('e', sql.VarChar, endDate)
        .query(`
          SELECT
            UPPER(RTRIM(LTRIM(c.Card_Code))) AS product_code,
            c.Card_Name AS product_name,
            ISNULL(si.SiteName, CAST(co.company_Seq AS VARCHAR)) AS site_name,
            ISNULL(SUM(coi.item_count), 0) AS total_qty,
            -- point/coupon 배분: 청첩장(A01) 아이템 수로 균등 배분 (gross X).
            --   쿠폰은 주문 내 청첩장 상품 전체에 적용 → A01 아이템 수로 나눠 SUM 시 정확히 1회 차감.
            --   코드베이스 컨벤션(etcAmountExpr 1226줄, 8421줄)과 동일. gross 비율은 청첩장 외
            --   품목(답례품 등)이 섞인 주문에서 쿠폰이 희석돼 매출이 과다 계상되던 문제가 있었음.
            ISNULL(SUM(
              CAST(coi.item_sale_price AS float) * coi.item_count / ISNULL(NULLIF(c.Unit_Value, 0), 1)
              - (ISNULL(co.point_price, 0) + ISNULL(coc.coupon_amt, 0)) * 1.0
                / NULLIF(a01c.a01_item_count, 0)
            ), 0) AS total_amount
          FROM custom_order co WITH (NOLOCK)
          INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
          INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
          LEFT JOIN SiteInfo si WITH (NOLOCK) ON co.company_Seq = si.CompayCode
          LEFT JOIN (
            -- 주문별 청첩장(A01) 아이템 수 — 쿠폰/포인트 균등 배분 분모. 기간 필터로 스캔 최소화.
            SELECT coi_a.order_seq, COUNT(*) AS a01_item_count
            FROM custom_order_item coi_a WITH (NOLOCK)
            INNER JOIN S2_Card c_a WITH (NOLOCK) ON coi_a.card_seq = c_a.Card_Seq
            INNER JOIN custom_order co_a WITH (NOLOCK) ON coi_a.order_seq = co_a.order_seq
            WHERE c_a.Card_Div = 'A01'
              AND co_a.status_seq >= 2 AND co_a.status_seq NOT IN (3, 5, 9)
              ${cardNullClause.replace('co.', 'co_a.')}
              AND co_a.${cardDateCol} >= @s AND co_a.${cardDateCol} < @e
            GROUP BY coi_a.order_seq
          ) a01c ON co.order_seq = a01c.order_seq
          LEFT JOIN (
            SELECT ORDER_SEQ, SUM(ISNULL(COUPON_AMT, 0)) AS coupon_amt
            FROM CUSTOM_ORDER_COUPON WITH (NOLOCK)
            GROUP BY ORDER_SEQ
          ) coc ON co.order_seq = coc.ORDER_SEQ
          WHERE UPPER(RTRIM(LTRIM(c.Card_Code))) IN (${codesUpperEscaped})
            AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5, 9)
            ${cardNullClause}
            AND ${cardDate} >= @s AND ${cardDate} < @e
          GROUP BY UPPER(RTRIM(LTRIM(c.Card_Code))), c.Card_Name,
            ISNULL(si.SiteName, CAST(co.company_Seq AS VARCHAR))
        `),
      // ETC — 금액 비례 분배 (CARD 와 동일 패턴):
      //   · o.coupon_price 를 각 작가 아이템 gross 비율대로 배분 차감.
      //   · SiteName IS NULL 이면 unit_value 나누기, ELSE 그대로 (기존 정책 유지).
      p.request()
        .input('s', sql.VarChar, startDate)
        .input('e', sql.VarChar, endDate)
        .query(`
          SELECT
            UPPER(RTRIM(LTRIM(c.Card_Code))) AS product_code,
            c.Card_Name AS product_name,
            ISNULL(SUM(oi.order_count), 0) AS total_qty,
            -- coupon 배분: 청첩장(A01) 아이템 수로 균등 배분 (gross X).
            --   코드베이스 etcAmountExpr(1226줄) 컨벤션과 동일.
            ISNULL(SUM(
              CASE
                WHEN si.SiteName IS NULL
                THEN CAST(oi.card_sale_price AS float) * oi.order_count / ISNULL(NULLIF(c.Unit_Value, 0), 1)
                     - ISNULL(o.coupon_price, 0) * 1.0 / NULLIF(a01e.a01_item_count, 0)
                ELSE CAST(oi.card_sale_price AS float)
                     - ISNULL(o.coupon_price, 0) * 1.0 / NULLIF(a01e.a01_item_count, 0)
              END
            ), 0) AS total_amount
          FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
          INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
          INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
          LEFT JOIN SiteInfo si WITH (NOLOCK) ON o.company_Seq = si.CompayCode
          LEFT JOIN (
            -- 주문별 청첩장(A01) 아이템 수 — 쿠폰 균등 배분 분모. 기간 필터로 스캔 최소화.
            SELECT oi_a.order_seq, COUNT(*) AS a01_item_count
            FROM CUSTOM_ETC_ORDER_ITEM oi_a WITH (NOLOCK)
            INNER JOIN S2_Card c_a WITH (NOLOCK) ON oi_a.card_seq = c_a.Card_Seq
            INNER JOIN CUSTOM_ETC_ORDER o_a WITH (NOLOCK) ON oi_a.order_seq = o_a.order_seq
            WHERE c_a.Card_Div = 'A01'
              AND o_a.status_seq >= 2 AND o_a.status_seq NOT IN (3, 5, 15)
              ${etcNullClause.replace('o.', 'o_a.')}
              AND o_a.${etcDateCol} >= @s AND o_a.${etcDateCol} < @e
            GROUP BY oi_a.order_seq
          ) a01e ON o.order_seq = a01e.order_seq
          WHERE UPPER(RTRIM(LTRIM(c.Card_Code))) IN (${codesUpperEscaped})
            AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 15)
            ${etcNullClause}
            AND ${etcDate} >= @s AND ${etcDate} < @e
          GROUP BY UPPER(RTRIM(LTRIM(c.Card_Code))), c.Card_Name
        `),
    ]);
    // MSSQL 응답의 product_code 는 이미 UPPER + TRIM 처리됨.
    //   Supabase 쪽 원본 code 와 매칭하려면 동일하게 normalize 해서 lookup.
    const codeNormMap = new Map(); // normalized → original Supabase code
    for (const c of productCodes) codeNormMap.set(String(c).trim().toUpperCase(), c);
    // site_name 이 순수 숫자 (제휴사 raw code) or NULL 이면 제휴사, 그 외 실 이름이면 자사몰.
    //   custom_order 테이블에 저장된 제휴사 청첩장 판매 (예: company_Seq=7179) 를 etc_amount 로 분류.
    //   ETC 테이블 결과는 무조건 etc 로 (기존 동작 유지).
    const isAffiliateSiteRaw = s => !s || /^\d+$/.test(String(s).trim());
    const merge = (rows, channel) => {
      for (const r of rows) {
        const originalCode = codeNormMap.get(r.product_code) || r.product_code;
        if (!sales.has(originalCode)) {
          sales.set(originalCode, {
            mssql_product_name: r.product_name || '',
            card_qty: 0, card_amount: 0,
            etc_qty: 0, etc_amount: 0,
            total_qty: 0, total_amount: 0
          });
        }
        const s = sales.get(originalCode);
        if (channel === 'card') {
          // custom_order 결과라도 site_name 이 숫자면 제휴사 판매 → etc 로 재분류.
          if (isAffiliateSiteRaw(r.site_name)) {
            s.etc_qty += Number(r.total_qty) || 0;
            s.etc_amount += Number(r.total_amount) || 0;
          } else {
            s.card_qty += Number(r.total_qty) || 0;
            s.card_amount += Number(r.total_amount) || 0;
          }
        } else {
          // ETC 테이블 (CUSTOM_ETC_ORDER) 결과는 전량 etc 로.
          s.etc_qty += Number(r.total_qty) || 0;
          s.etc_amount += Number(r.total_amount) || 0;
        }
        s.total_qty = s.card_qty + s.etc_qty;
        s.total_amount = Math.round(s.card_amount + s.etc_amount);
      }
    };
    merge(cardRes.recordset || [], 'card');
    merge(etcRes.recordset || [], 'etc');
  } catch (e) {
    return { error: 'MSSQL 조회 실패: ' + e.message };
  }

  // 4) 작가별 / 품목별 집계
  const byArtist = new Map();
  const byProduct = [];

  for (const [code, info] of artistsByCode) {
    const sale = sales.get(code);
    const totalQty = sale?.total_qty || 0;
    const totalAmount = sale?.total_amount || 0;
    const settlementAmount = Math.round(totalAmount * info.commission_rate / 100);

    byProduct.push({
      product_code: code,
      product_name: info.product_name || sale?.mssql_product_name || '',
      category: info.category,
      artist_id: info.artist_id,
      artist_name: info.artist_name,
      commission_rate: info.commission_rate,
      total_qty: totalQty,
      card_qty: sale?.card_qty || 0,
      etc_qty: sale?.etc_qty || 0,
      card_amount: sale?.card_amount ? Math.round(sale.card_amount) : 0,
      etc_amount: sale?.etc_amount ? Math.round(sale.etc_amount) : 0,
      total_amount: totalAmount,
      settlement_amount: settlementAmount
    });

    // 작가별 합계 — artist_id 없는 미매핑 품목은 제외
    if (info.artist_id) {
      const ak = info.artist_id;
      if (!byArtist.has(ak)) {
        byArtist.set(ak, {
          artist_id: info.artist_id,
          name: info.artist_name,
          commission_rate: info.commission_rate,
          product_count: 0,
          categories: new Set(),
          total_qty: 0, total_amount: 0, settlement_amount: 0
        });
      }
      const a = byArtist.get(ak);
      a.product_count++;
      if (info.category) a.categories.add(info.category);
      a.total_qty += totalQty;
      a.total_amount += totalAmount;
      a.settlement_amount += settlementAmount;
    }
  }

  const byArtistArr = [...byArtist.values()].map(a => ({
    artist_id: a.artist_id,
    name: a.name,
    commission_rate: a.commission_rate,
    product_count: a.product_count,
    category_list: [...a.categories].sort(),
    total_qty: a.total_qty,
    total_amount: a.total_amount,
    settlement_amount: a.settlement_amount
  })).sort((a, b) => b.settlement_amount - a.settlement_amount);

  byProduct.sort((a, b) => b.settlement_amount - a.settlement_amount);

  const totals = byProduct.reduce((acc, p) => ({
    total_qty: acc.total_qty + p.total_qty,
    total_amount: acc.total_amount + p.total_amount,
    settlement_amount: acc.settlement_amount + p.settlement_amount
  }), { total_qty: 0, total_amount: 0, settlement_amount: 0 });

  return {
    period: { start: startDate, end: endDate },
    totals,
    by_artist: byArtistArr,
    by_product: byProduct
  };
}

/**
 * 작가 정산 매출 매칭 진단.
 *   목적: 시드 product_code 가 MSSQL S2_Card.Card_Code 와 매칭되는지, 이번 달 매출은?
 *   응답:
 *     items[i]: { product_code, artist_name, category,
 *                 mssql_found, mssql_card_name, mssql_card_div,
 *                 similar_codes: [{Card_Code, Card_Name, Card_Div}],  // 매칭 안 될 때 유사 후보 최대 5개
 *                 this_month_qty, this_month_amount }
 *     summary: { total, found, not_found, with_sales, no_sales }
 */
async function apiArtistDiagnose() {
  // 1) Supabase 활성 품목 (bg_artist_products + bg_artists join)
  let products = [];
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/bg_artist_products?select=product_code,product_name,category,is_active,bg_artists(name)&is_active=eq.true&order=category.asc,product_code.asc`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    products = await r.json();
    if (!r.ok) return { error: 'Supabase: ' + (products?.message || r.status), items: [], summary: {} };
  } catch (e) {
    return { error: 'Supabase: ' + e.message, items: [], summary: {} };
  }
  if (!Array.isArray(products) || !products.length) {
    return { error: '등록된 활성 품목이 없습니다.', items: [], summary: {} };
  }

  const codes = products.map(p => p.product_code);
  const codesEscaped = codes.map(c => `'${String(c).replace(/'/g, "''")}'`).join(',');

  // 2) MSSQL S2_Card 직접 매칭 — TRIM + case-insensitive 로 방어적 매칭.
  //   원인 가능성: leading/trailing space, case-sensitive collation, NVARCHAR 유령문자.
  const p = await getPool();
  const foundCodes = new Map(); // input product_code → { Card_Name, Card_Div, actual_card_code }
  try {
    const res = await p.request().query(`
      SELECT
        Card_Code AS actual_card_code,
        UPPER(RTRIM(LTRIM(Card_Code))) AS normalized_code,
        Card_Name, Card_Div
      FROM S2_Card WITH (NOLOCK)
      WHERE UPPER(RTRIM(LTRIM(Card_Code))) IN (${codesEscaped.toUpperCase()})
    `);
    // normalized (대문자화 + TRIM) 로 매칭
    const normMap = new Map();
    for (const r of (res.recordset || [])) {
      normMap.set(r.normalized_code, {
        name: r.Card_Name, div: r.Card_Div, actual: r.actual_card_code
      });
    }
    for (const c of codes) {
      const key = String(c).trim().toUpperCase();
      const found = normMap.get(key);
      if (found) foundCodes.set(c, found);
    }
  } catch (e) {
    return { error: 'MSSQL 매칭 조회 실패: ' + e.message, items: [], summary: {} };
  }

  // 3) 매칭 안 된 코드마다 유사 코드 검색 (prefix 2자리 LIKE + Card_Name LIKE)
  const similarByCode = new Map();
  const notFound = codes.filter(c => !foundCodes.has(c));
  for (const nc of notFound) {
    const prefix = String(nc).slice(0, 2).replace(/%/g, '').replace(/_/g, '');
    const safePrefix = prefix.replace(/'/g, "''");
    if (!safePrefix) { similarByCode.set(nc, []); continue; }
    try {
      const res = await p.request().query(`
        SELECT TOP 10 Card_Code, Card_Name, Card_Div
        FROM S2_Card WITH (NOLOCK)
        WHERE UPPER(RTRIM(LTRIM(Card_Code))) LIKE UPPER('${safePrefix}%')
        ORDER BY Card_Code
      `);
      similarByCode.set(nc, res.recordset || []);
    } catch { similarByCode.set(nc, []); }
  }

  // 4) 이번 달 매출 (CARD + ETC) — 매칭된 코드만
  const todayDate = today();
  const startDate = fmtDate(new Date(todayDate.getFullYear(), todayDate.getMonth(), 1));
  const endDate = fmtDate(new Date(todayDate.getFullYear(), todayDate.getMonth() + 1, 1));
  const salesByCode = new Map();
  if (foundCodes.size) {
    const foundList = [...foundCodes.keys()].map(c => `'${c.replace(/'/g, "''")}'`).join(',');
    try {
      const [cardRes, etcRes] = await Promise.all([
        p.request()
          .input('s', sql.VarChar, startDate)
          .input('e', sql.VarChar, endDate)
          .query(`
            SELECT c.Card_Code AS product_code,
              ISNULL(SUM(coi.item_count), 0) AS qty,
              ISNULL(SUM(CAST(coi.item_sale_price AS float) * coi.item_count / ISNULL(NULLIF(c.Unit_Value, 0), 1)), 0) AS amount
            FROM custom_order co WITH (NOLOCK)
            INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
            INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
            WHERE c.Card_Code IN (${foundList})
              AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5, 9)
              AND co.settle_date IS NOT NULL
              AND co.settle_date >= @s AND co.settle_date < @e
            GROUP BY c.Card_Code
          `),
        p.request()
          .input('s', sql.VarChar, startDate)
          .input('e', sql.VarChar, endDate)
          .query(`
            SELECT c.Card_Code AS product_code,
              ISNULL(SUM(oi.order_count), 0) AS qty,
              ISNULL(SUM(CAST(oi.card_sale_price AS float) * oi.order_count), 0) AS amount
            FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
            INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
            INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
            WHERE c.Card_Code IN (${foundList})
              AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 15)
              AND o.settle_date IS NOT NULL
              AND o.settle_date >= @s AND o.settle_date < @e
            GROUP BY c.Card_Code
          `),
      ]);
      const merge = (rows) => {
        for (const r of rows || []) {
          if (!salesByCode.has(r.product_code)) salesByCode.set(r.product_code, { qty: 0, amount: 0 });
          const s = salesByCode.get(r.product_code);
          s.qty += Number(r.qty) || 0;
          s.amount += Number(r.amount) || 0;
        }
      };
      merge(cardRes.recordset);
      merge(etcRes.recordset);
    } catch (e) {
      // 매출 조회 실패해도 매칭 진단은 반환
      console.warn('[artists diagnose] 매출 조회 실패:', e.message);
    }
  }

  // 5) items 조립
  const items = products.map(p => {
    const mssql = foundCodes.get(p.product_code);
    const sale = salesByCode.get(p.product_code);
    return {
      product_code: p.product_code,
      product_name: p.product_name || '',
      category: p.category || '',
      artist_name: p.bg_artists?.name || '<미매핑>',
      mssql_found: !!mssql,
      mssql_card_name: mssql?.name || null,
      mssql_card_div: mssql?.div || null,
      similar_codes: similarByCode.get(p.product_code) || [],
      this_month_qty: sale?.qty || 0,
      this_month_amount: Math.round(sale?.amount || 0)
    };
  });

  const summary = {
    total: items.length,
    found: items.filter(x => x.mssql_found).length,
    not_found: items.filter(x => !x.mssql_found).length,
    with_sales: items.filter(x => x.this_month_amount > 0).length,
    no_sales: items.filter(x => x.mssql_found && x.this_month_amount === 0).length
  };

  return { period: { start: startDate, end: endDate, label: '이번 달' }, items, summary };
}

/**
 * Phase 4 — 최근 N개월 월별 정산 합계 추이.
 *   각 월에 대해 apiArtistSettlements 호출 → 합계만 추출.
 *   응답: { months: ['2025-07'...'2026-06'], totals: [...], by_artist: { artistId: [...] }, artist_names: {...} }
 */
async function apiArtistSettlementsHistory(query = {}) {
  const months = Math.min(parseInt(query.months) || 12, 24);
  const todayDate = today();
  // 최근 N개월의 1일 ~ 다음달 1일
  const monthList = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(todayDate.getFullYear(), todayDate.getMonth() - i, 1);
    monthList.push({
      label: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      start: fmtDate(d),
      end: fmtDate(new Date(d.getFullYear(), d.getMonth() + 1, 1))
    });
  }
  // 각 월 정산 합계 조회 — 순차 (병렬은 MSSQL pool 부담)
  const totals = [];
  const byArtist = {};  // artistId → [amount per month]
  const artistNames = {};
  for (const m of monthList) {
    const r = await apiArtistSettlements({ start_date: m.start, end_date: m.end });
    if (r.error) { totals.push(0); continue; }
    totals.push(r.totals?.settlement_amount || 0);
    for (const a of (r.by_artist || [])) {
      if (!byArtist[a.artist_id]) {
        byArtist[a.artist_id] = new Array(monthList.length).fill(0);
        artistNames[a.artist_id] = a.name;
      }
      const idx = monthList.findIndex(x => x.label === m.label);
      if (idx >= 0) byArtist[a.artist_id][idx] = a.settlement_amount;
    }
  }
  return {
    months: monthList.map(m => m.label),
    totals,
    by_artist: byArtist,
    artist_names: artistNames
  };
}

/**
 * Phase 4 — 월 마감 (특정 월의 작가별 정산 스냅샷 저장).
 *   해당 월의 apiArtistSettlements 호출 → 작가별 결과를 bg_artist_settlements 에 upsert (artist_id, month) PK.
 */
async function apiArtistSettlementsConfirm({ month, confirmedBy }) {
  const [y, mn] = month.split('-').map(Number);
  const start = fmtDate(new Date(y, mn - 1, 1));
  const end = fmtDate(new Date(y, mn, 1));
  const r = await apiArtistSettlements({ start_date: start, end_date: end });
  if (r.error) return { error: r.error };
  const rows = (r.by_artist || []).map(a => ({
    artist_id: a.artist_id,
    month: `${month}-01`,
    total_amount: a.total_amount,
    commission_rate: a.commission_rate,
    settlement_amount: a.settlement_amount,
    total_qty: a.total_qty,
    status: 'confirmed',
    confirmed_by: confirmedBy
  }));
  if (!rows.length) return { ok: true, upserted: 0, message: '확정할 작가 정산이 없습니다.' };
  try {
    const upRes = await fetch(`${SUPABASE_URL}/rest/v1/bg_artist_settlements?on_conflict=artist_id,month`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type':'application/json',
        Prefer: 'resolution=merge-duplicates,return=representation'
      },
      body: JSON.stringify(rows)
    });
    const j = await upRes.json();
    if (!upRes.ok) return { error: j?.message || '마감 실패' };
    return {
      ok: true,
      upserted: Array.isArray(j) ? j.length : rows.length,
      total_settlement: r.totals?.settlement_amount || 0
    };
  } catch (e) {
    return { error: e.message };
  }
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

  // WoW 동기간 비교: 이번주 일요일~어제(전일 기준) vs 지난주 일요일~지난주 어제
  //   오늘=목: thisWeek = [Sun~Wed] (4일), lastWeek = [last Sun~last Wed] (4일)
  //   오늘=일: thisWeek = [] (0일), lastWeek = [] (0일) — 표시 시 빈 값 처리
  //
  // 오늘 데이터는 아직 수집 중이라 왜곡 우려 → 사용자 정책상 전일까지로 잘라서 동기간 비교.
  const dayOfWeek = todayDate.getDay();
  const thisWeekStartDate = addDays(todayDate, -dayOfWeek);
  const thisWeekStartStr = fmtDate(thisWeekStartDate);
  const lastWeekStartStr = fmtDate(addDays(thisWeekStartDate, -7));
  // 이번주 동기간 끝(exclusive) = 오늘 = todayStr (어제까지 포함).
  // 지난주 동기간 끝(exclusive) = 지난주 같은요일 = today - 7 = lastWeekSameDayStr.
  //   기존엔 tomorrowStr / lastWeekSameDayNextStr (지난주 같은요일 다음날) 이었음 → 오늘/지난주 같은요일도 포함.
  //   이제 오늘/지난주 같은요일 제외 (전일 기준).

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
          WHERE ${D01_FILTER} AND co.order_date >= @s AND co.order_date < @e AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5, 9)
          GROUP BY ISNULL(si.SiteName, CAST(co.company_Seq AS VARCHAR)),
            CASE WHEN cp.order_seq IS NOT NULL THEN 1 ELSE 0 END
        `),
      // 3) 결제대기 = status_seq IN (1, 9) AND settle_date IS NULL — CARD/ETC 합산
      //   1: 결제대기, 9: 초안컨펌완료/결제대기 (둘 다 미결제 상태)
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
              AND co.status_seq IN (1, 9) AND co.settle_date IS NULL
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
              AND o.status_seq IN (1, 9) AND o.settle_date IS NULL
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
    const _cmpGiftExcl = await _loadGiftExclusions();   // 답례품 아님 제외 (마켓 비-답례품)
    async function mergeMarketplace(siteName, listFn, getOrderKey) {
      try {
        const rowsRaw = await listFn();
        if (!rowsRaw || !rowsRaw.length) return;
        // 매출 집계 — 취소/반품/교환 자동 제외 (CARD/ETC status_seq NOT IN (3,5,...) 와 동일 정책).
        //   네이버: CANCELED / RETURNED / EXCHANGED, 쿠팡: CANCEL / RETURNS,
        //   카페24: C00/C10/C11(취소) R00/R10(반품) E00/E10(교환).
        const CANCELED_STATUSES = ['CANCELED', 'RETURNED', 'EXCHANGED', 'CANCEL', 'RETURNS',
          'C00', 'C10', 'C11', 'R00', 'R10', 'E00', 'E10'];
        const rows = rowsRaw.filter(r => !CANCELED_STATUSES.includes(r.status)
          && !_cmpGiftExcl.has(siteName, r.product_code, r.product_name));   // 답례품 아님 제외
        if (!rows.length) return;
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
      () => require('./coupang/store').listCoupangOrders({ startStr, endStr, byPaid: false, excludeRocketGrowth: true }),
      r => `${r.coupang_order_id}::${r.shipment_box_id}`,
    );
    if (_isDaeryepumCmp) await mergeMarketplace(
      '네이버',
      () => require('./naver/store').listNaverOrders({ startStr, endStr, byPaid: false }),
      r => `${r.product_order_id}`,
    );
    // 정수당(카페24) — 답례품 전용 채널. by_site 에 '정수당' 로 누적 (주문 단위 = cafe24_order_id).
    if (_isDaeryepumCmp) await mergeMarketplace(
      '정수당',
      () => require('./cafe24/store').listCafe24Orders({ startStr, endStr, byPaid: false }),
      r => `${r.cafe24_order_id}`,
    );

    // 쿠팡 로켓그로스(RFM) 매출 — 일별 aggregate (주문 단위 X). 운영자가 Wing 셀러센터
    //   주문 건수는 주문ID(coupang_rg_order_lines.order_id) distinct 로 센다.
    //   집계 단위가 (결제완료일 × 옵션) 이라 행 수를 세면 상품 종류 수가 나온다 —
    //   한 주문에 상품이 여럿이면 그만큼 부풀려졌다 (2026-08-10 수정).
    //   endStr 는 exclusive 라 rfm listSales 의 lte 와 맞추려 -1 일.
    if (_isDaeryepumCmp) try {
      const rfmStore = require('./coupang/rfm-store');
      const endIncl = endStr ? new Date(new Date(endStr).getTime() - 86400000).toISOString().slice(0, 10) : null;
      const rfmRows = await rfmStore.listSales({ startDate: startStr, endDate: endIncl });
      // 답례품 아님으로 지정된 품목(아크릴 액자 등) 제외
      const rfmKept = (rfmRows || []).filter(r => !_cmpGiftExcl.has('쿠팡 로켓그로스', r.product_id, r.product_name));
      if (rfmKept.length) {
        let amount = 0, qty = 0;
        // 제외 필터를 통과한 행의 주문ID 만 모은다 — 금액·수량과 같은 모집단이어야 한다
        const orderIds = new Set();
        for (const r of rfmKept) {
          amount += Number(r.net_amount) || 0;
          qty += Number(r.sales_qty) || 0;
          for (const oid of (r.order_ids || [])) orderIds.add(oid);
        }
        // 옛 데이터라 주문ID 가 없으면 종전대로 행 수로 — 0 건으로 보이는 것보다 낫다
        const orders = orderIds.size || rfmKept.length;
        if (amount !== 0 || qty !== 0 || rfmKept.length) {
          const site = ensureSite('쿠팡 로켓그로스');
          site.order_count += orders;
          site.total_amount += amount;
          site.total_qty += qty;
          site.standalone.amount += amount;
          site.standalone.orders += orders;
          site.standalone.qty += qty;
          standalone_amount += amount;
          standalone_orders += orders;
          standalone_qty += qty;
        }
      }
    } catch (e) {
      console.warn('[getPeriodTotal] 쿠팡 로켓그로스 머지 실패 (무시):', e.message);
    }

    // 바른손더기프트 (bg_manual_orders) 머지 — 답례품 카테고리에서만.
    //   API 미연동 채널이라 CSV 업로드 등으로 관리자 등록. status_seq 결제완료만 카운트.
    //   실 매출 = items[].item_amount SUM (CSV Q열 판매금액 기반).
    //   copurchase 개념 없음 → standalone 으로 전체 처리.
    if (_isDaeryepumCmp) try {
      const bgStore = require('./barungift/store');
      const manualOrders = await bgStore.listManualOrders({
        category: 'daeryepum', startDate: startStr, endDate: endStr,
      });
      const validOrders = (manualOrders || []).filter(mo => {
        const st = Number(mo.status_seq) || 0;
        return st >= 2 && ![3, 5, 15].includes(st);
      });
      if (validOrders.length) {
        let amount = 0, qty = 0;
        for (const mo of validOrders) {
          const items = Array.isArray(mo.items) ? mo.items : [];
          for (const it of items) {
            const q = Number(it.quantity) || 0;
            const a = Number(it.item_amount) || (Number(it.unit_price) || 0) * q;
            amount += a;
            qty += q;
          }
        }
        const site = ensureSite('바른손더기프트');
        site.order_count += validOrders.length;
        site.total_amount += amount;
        site.total_qty += qty;
        site.standalone.amount += amount;
        site.standalone.orders += validOrders.length;
        site.standalone.qty += qty;
        standalone_amount += amount;
        standalone_orders += validOrders.length;
        standalone_qty += qty;
      }
    } catch (e) {
      console.warn('[getPeriodTotal] 바른손더기프트 머지 실패 (무시):', e.message);
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
              AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5, 9)
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
    getPeriodTotal(thisWeekStartStr, todayStr),          // 이번주 일요일 ~ 어제
    getPeriodTotal(lastWeekStartStr, lastWeekSameDayStr), // 지난주 일요일 ~ 지난주 어제
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
  // 답례품 아님으로 지정된 마켓 품목 제외 (migration 042)
  const _sumGiftExcl = await _loadGiftExclusions();
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
          CASE WHEN c.Card_Code LIKE 'COM[_]%' THEN N'위탁' ELSE N'일반' END AS consign_type,
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
          CASE WHEN ecp.order_seq IS NOT NULL THEN N'동시구매' ELSE N'단독주문' END,
          CASE WHEN c.Card_Code LIKE 'COM[_]%' THEN N'위탁' ELSE N'일반' END

        UNION ALL

        SELECT
          c.Card_Name,
          c.Card_Code,
          CONVERT(varchar(10), co.order_date, 120) AS order_day,
          ISNULL(si.SiteName, CAST(co.company_Seq AS VARCHAR)) AS site_name,
          CASE WHEN cp.order_seq IS NOT NULL THEN N'동시구매' ELSE N'단독주문' END AS order_type,
          CASE WHEN c.Card_Code LIKE 'COM[_]%' THEN N'위탁' ELSE N'일반' END AS consign_type,
          COUNT(DISTINCT co.order_seq),
          SUM(coi.item_count),
          SUM(CAST(coi.item_sale_price AS float) * coi.item_count / ${cardUnitDivisor})
        FROM custom_order co WITH (NOLOCK)
        INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
        INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
        LEFT JOIN SiteInfo si WITH (NOLOCK) ON co.company_Seq = si.CompayCode
        LEFT JOIN copurchase_orders cp ON co.order_seq = cp.order_seq
        WHERE ${categoryFilter} AND co.order_date >= @startDate AND co.order_date < @endDate AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5, 9)
        GROUP BY c.Card_Name, c.Card_Code, CONVERT(varchar(10), co.order_date, 120), ISNULL(si.SiteName, CAST(co.company_Seq AS VARCHAR)),
          CASE WHEN cp.order_seq IS NOT NULL THEN N'동시구매' ELSE N'단독주문' END,
          CASE WHEN c.Card_Code LIKE 'COM[_]%' THEN N'위탁' ELSE N'일반' END

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
          CASE WHEN c.Card_Code LIKE 'COM[_]%' THEN N'위탁' ELSE N'일반' END AS consign_type,
          COUNT(DISTINCT o.order_seq) AS distinct_order_count
        FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
        INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
        INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
        LEFT JOIN SiteInfo si WITH (NOLOCK) ON o.company_Seq = si.CompayCode
        LEFT JOIN etc_copurchase_orders ecp ON o.order_seq = ecp.order_seq
        WHERE ${categoryFilter} AND o.order_date >= @startDate AND o.order_date < @endDate AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 15)
        GROUP BY CONVERT(varchar(10), o.order_date, 120), ISNULL(si.SiteName, CAST(o.company_Seq AS VARCHAR)),
          CASE WHEN ecp.order_seq IS NOT NULL THEN N'동시구매' ELSE N'단독주문' END,
          CASE WHEN c.Card_Code LIKE 'COM[_]%' THEN N'위탁' ELSE N'일반' END

        UNION ALL

        SELECT
          CONVERT(varchar(10), co.order_date, 120) AS order_day,
          ISNULL(si.SiteName, CAST(co.company_Seq AS VARCHAR)) AS site_name,
          CASE WHEN cp.order_seq IS NOT NULL THEN N'동시구매' ELSE N'단독주문' END AS order_type,
          CASE WHEN c.Card_Code LIKE 'COM[_]%' THEN N'위탁' ELSE N'일반' END AS consign_type,
          COUNT(DISTINCT co.order_seq) AS distinct_order_count
        FROM custom_order co WITH (NOLOCK)
        INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
        INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
        LEFT JOIN SiteInfo si WITH (NOLOCK) ON co.company_Seq = si.CompayCode
        LEFT JOIN copurchase_orders cp ON co.order_seq = cp.order_seq
        WHERE ${categoryFilter} AND co.order_date >= @startDate AND co.order_date < @endDate AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5, 9)
        GROUP BY CONVERT(varchar(10), co.order_date, 120), ISNULL(si.SiteName, CAST(co.company_Seq AS VARCHAR)),
          CASE WHEN cp.order_seq IS NOT NULL THEN N'동시구매' ELSE N'단독주문' END,
          CASE WHEN c.Card_Code LIKE 'COM[_]%' THEN N'위탁' ELSE N'일반' END
      `),
  ]);

  // Clean names
  const rows = result.recordset.map(r => ({ ...r, card_name: cleanName(r.card_name), site_name: formatSiteName(r.site_name) }));

  const orderCounts = countResult.recordset.map(r => ({ ...r, site_name: formatSiteName(r.site_name) }));

  // 바른손더기프트 (bg_manual_orders) UNION — API 미연동 채널.
  //   category='daeryepum' 시에만 포함 (deco/flower 는 해당 없음).
  //   MSSQL 결과와 동일 스키마로 정규화 후 rows / orderCounts 에 push.
  //   실패해도 MSSQL 결과 유지 (fail-soft).
  if (!query.category || query.category === 'daeryepum') {
    try {
      const bgStore = require('./barungift/store');
      const manualOrders = await bgStore.listManualOrders({
        category: 'daeryepum',
        startDate,
        endDate,
      });
      if (manualOrders && manualOrders.length) {
        const SITE_LABEL = '바른손더기프트';
        const ORDER_TYPE_LABEL = '단독주문';
        // status_seq 필터 — MSSQL 결제완료 상태 기준 (3=취소, 5=환불, 15=반품완료 제외)
        const isValid = mo => {
          const st = Number(mo.status_seq) || 0;
          return st >= 2 && ![3, 5, 15].includes(st);
        };
        const validOrders = manualOrders.filter(isValid);
        // rows 상품별 flatten
        for (const mo of validOrders) {
          const day = (mo.order_date || '').toString().slice(0, 10);
          const items = Array.isArray(mo.items) ? mo.items : [];
          for (const it of items) {
            const qty = Number(it.quantity) || 0;
            const amt = Number(it.item_amount) || (Number(it.unit_price) || 0) * qty;
            if (!it.product_code && !qty && !amt) continue;
            rows.push({
              card_name: cleanName(it.product_name || ''),
              card_code: it.product_code || '',
              order_day: day,
              site_name: SITE_LABEL,
              order_type: ORDER_TYPE_LABEL,
              order_count: 1,
              total_qty: qty,
              total_amount: amt,
            });
          }
        }
        // orderCounts 일별 sum (order_id 중복 제거)
        const dayCountMap = new Map();
        for (const mo of validOrders) {
          const day = (mo.order_date || '').toString().slice(0, 10);
          if (!day) continue;
          const key = `${day}|${SITE_LABEL}|${ORDER_TYPE_LABEL}`;
          if (!dayCountMap.has(key)) dayCountMap.set(key, { order_day: day, site_name: SITE_LABEL, order_type: ORDER_TYPE_LABEL, distinct_order_count: 0 });
          dayCountMap.get(key).distinct_order_count++;
        }
        orderCounts.push(...dayCountMap.values());
      }
    } catch (e) {
      console.warn('[apiDashboardSummary] bg_manual_orders UNION 실패 (무시):', e.message);
    }
  }

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
      const manualIds = [];
      expressInfos.forEach(ci => {
        const oid = String(ci.order_id || '');
        if (oid.startsWith('ETC-')) {
          const seq = parseInt(oid.slice(4));
          if (seq) etcSeqs.push(seq);
        } else if (oid.startsWith('MO-')) {
          manualIds.push(oid.slice(3));
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
              AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5, 9)
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
      // 바른손더기프트 MANUAL 오늘출발 — bg_manual_orders 에서 개별 조회.
      //   결제완료(status_seq>=2, NOT IN 3/5/15) + 기간 (order_date) 필터.
      //   copurchase 개념 없음 → 항상 단독주문.
      if (manualIds.length) try {
        const perDay = new Map(); // day → { amount, qty, orders(Set) }
        for (const moId of manualIds) {
          try {
            const mo = await _bgStore.getManualOrder(moId);
            if (!mo) continue;
            const st = Number(mo.status_seq) || 0;
            if (st < 2 || [3, 5, 15].includes(st)) continue;
            const day = String(mo.order_date || '').slice(0, 10);
            if (!day || day < startDate || day >= endDate) continue;
            const items = Array.isArray(mo.items) ? mo.items : [];
            let amount = 0, qty = 0;
            for (const it of items) {
              const q = Number(it.quantity) || 0;
              const a = Number(it.item_amount) || (Number(it.unit_price) || 0) * q;
              amount += a; qty += q;
            }
            if (!perDay.has(day)) perDay.set(day, { amount: 0, qty: 0, orders: new Set() });
            const b = perDay.get(day);
            b.amount += amount; b.qty += qty; b.orders.add(moId);
          } catch (e) { /* 개별 실패는 skip */ }
        }
        for (const [day, b] of perDay) {
          expressDaily.push({
            order_day: day,
            site_name: '바른손더기프트',
            is_copurchase: 0,
            order_count: b.orders.size,
            total_amount: Math.round(b.amount),
            total_qty: b.qty,
          });
        }
      } catch (e) { console.warn('[summary] expressDaily MANUAL UNION 실패 (무시):', e.message); }
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
    const coupangRowsRaw = await coupangStore.listCoupangOrders({
      startStr: startDate, endStr: endDate, byPaid: false,
      excludeRocketGrowth: true,   // 로켓그로스는 정산 리포트로 별도 집계 — 여기서 세면 이중계상
    });
    // 매출 집계 — 취소/반품 자동 제외 (CARD/ETC 의 status_seq NOT IN (3,5,...) 와 동일 정책).
    //   주문조회 / 정보입력완료 등 다른 호출은 store 함수가 모든 row 반환 → 취소 표시 가능.
    const coupangRows = (coupangRowsRaw || []).filter(r => !['CANCEL', 'RETURNS'].includes(r.status)
      && !_sumGiftExcl.has('쿠팡', r.product_code, r.product_name));   // 답례품 아님 제외
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
    const naverRowsRaw = await naverStore.listNaverOrders({
      startStr: startDate, endStr: endDate, byPaid: false,
    });
    // 매출 집계 — 취소/반품/교환 자동 제외 (CARD/ETC 의 status_seq NOT IN (3,5,...) 와 동일 정책).
    const naverRows = (naverRowsRaw || []).filter(r => !['CANCELED', 'RETURNED', 'EXCHANGED'].includes(r.status)
      && !_sumGiftExcl.has('네이버', r.product_code, r.product_name));   // 답례품 아님 제외
    if (naverRows && naverRows.length) {
      const byDayProduct = new Map();
      const byDayForCount = new Map();
      for (const r of naverRows) {
        const day = String(r.ordered_at || '').slice(0, 10);
        if (!day) continue;
        const siteLabel = naverSiteLabel(r.store_id);
        const name = r.product_name || '네이버 답례품';
        const code = r.product_code || '';
        const key = `${day}|${siteLabel}|${code}|${name}`;
        if (!byDayProduct.has(key)) {
          byDayProduct.set(key, {
            card_name: name, card_code: code,
            order_day: day, site_name: siteLabel,
            order_type: '단독주문',
            order_count: 0, total_qty: 0, total_amount: 0,
            _orderIds: new Set(),
          });
        }
        const bucket = byDayProduct.get(key);
        bucket.total_qty += r.item_count || 0;
        bucket.total_amount += r.item_total_price || 0;
        bucket._orderIds.add(`${r.order_id}::${r.product_order_id}`);
        const ck = `${day}|${siteLabel}|단독주문`;
        if (!byDayForCount.has(ck)) byDayForCount.set(ck, { order_day: day, site_name: siteLabel, order_type: '단독주문', _orderIds: new Set() });
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

  // 정수당(카페24) 일별 합산 — 쿠팡·네이버와 동일 패턴. 답례품 전용.
  //   카드 보기(apiDashboardComparison)에는 진작 들어가 있었는데 여기만 빠져 있어
  //   테이블 보기에서 정수당 매출이 통째로 안 보였다 (2026-08-12 수정).
  if (_isDaeryepumCategory) try {
    const cafe24Store = require('./cafe24/store');
    const cafe24RowsRaw = await cafe24Store.listCafe24Orders({
      startStr: startDate, endStr: endDate, byPaid: false,
    });
    // 취소/반품/교환 제외 — 카페24 상태코드 계열(C**/R**/E**)까지 함께 본다
    const CF_CANCELLED = new Set(['CANCELED', 'RETURNED', 'EXCHANGED',
      'C00', 'C10', 'C11', 'R00', 'R10', 'E00', 'E10']);
    const cafe24Rows = (cafe24RowsRaw || []).filter(r =>
      !CF_CANCELLED.has(String(r.status || '').toUpperCase())
      && !_sumGiftExcl.has('정수당', r.product_code, r.product_name));   // 답례품 아님 제외
    if (cafe24Rows.length) {
      const byDayProduct = new Map();
      const byDayForCount = new Map();
      for (const r of cafe24Rows) {
        const day = String(r.ordered_at || '').slice(0, 10);
        if (!day) continue;
        const name = r.product_name || '정수당 답례품';
        const code = r.product_code || '';
        const key = `${day}|${code}|${name}`;
        if (!byDayProduct.has(key)) {
          byDayProduct.set(key, {
            card_name: name, card_code: code,
            order_day: day, site_name: '정수당',
            order_type: '단독주문',
            order_count: 0, total_qty: 0, total_amount: 0,
            _orderIds: new Set(),
          });
        }
        const bucket = byDayProduct.get(key);
        bucket.total_qty += r.item_count || 0;
        bucket.total_amount += r.item_total_price || 0;
        // 한 주문이 여러 줄(line_key)로 나뉘므로 주문번호로 센다
        bucket._orderIds.add(String(r.cafe24_order_id));
        const ck = `${day}|정수당|단독주문`;
        if (!byDayForCount.has(ck)) {
          byDayForCount.set(ck, { order_day: day, site_name: '정수당', order_type: '단독주문', _orderIds: new Set() });
        }
        byDayForCount.get(ck)._orderIds.add(String(r.cafe24_order_id));
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
    console.warn('[summary] 정수당 주문 머지 실패 (무시):', e.message);
  }

  // 쿠팡 로켓그로스 매출 (수동 입력 집계) 머지 — 일별 aggregate, '쿠팡 로켓그로스' 사이트 그룹. 답례품 전용.
  //
  // 데이터 특성:
  //   · Wing API 가 RFM 매출 노출 안 해 운영자가 수동 입력 → coupang_rocket_growth_sales 테이블
  //   · 일자당 1 row (vendor_item_id='_manual'), 상품 명세 없는 일별 합계
  //   · net_amount 는 generated column (= sales_amount - refund_amount) — Wing 셀러센터 표시값과 일관
  //   · 주문건수는 주문ID(coupang_rg_order_lines.order_id) distinct — 집계 단위가
  //     (결제완료일 × 옵션) 이라 행 수를 세면 상품 종류 수가 된다 (2026-08-12 수정)
  //
  // 컨벤션 정렬: apiDashboardComparison 의 getPeriodTotal 과 동일 패턴 — 채널별 합계 KPI
  //   카드가 비교 카드와 어긋나지 않도록 통일 (amount=net_amount, qty=sales_qty gross, order_count=row수).
  if (_isDaeryepumCategory) try {
    const rfmStore = require('./coupang/rfm-store');
    // endDate 는 exclusive — listSales 의 lte 와 맞추려 -1 일
    const endIncl = endDate ? new Date(new Date(endDate).getTime() - 86400000).toISOString().slice(0, 10) : null;
    const rgRowsRaw = await rfmStore.listSales({ startDate, endDate: endIncl });
    // 답례품 아님으로 지정된 품목(아크릴 액자 등) 제외
    const rgRows = (rgRowsRaw || []).filter(r => !_sumGiftExcl.has('쿠팡 로켓그로스', r.product_id, r.product_name));
    if (rgRows && rgRows.length) {
      // 하루의 주문 건수는 그 날 주문ID 의 distinct 수다. 집계행마다 세면
      //   한 주문이 상품 수만큼 중복된다 — 그래서 날짜별로 모아 한 번만 센다.
      const rgOrderIdsByDay = new Map();
      for (const r of rgRows) {
        const day = String(r.sale_date || '').slice(0, 10);
        if (!day) continue;
        const netAmount = Number(r.net_amount) || 0; // generated column = sales - refund
        const grossQty = Number(r.sales_qty) || 0;   // getPeriodTotal 컨벤션과 일치 (gross)
        const ids = r.order_ids || [];
        // summary rows — (날짜 × 상품) 단위. 건수는 그 칸의 주문ID distinct.
        rows.push({
          card_name: r.product_name || '쿠팡 로켓그로스 (일별 집계)',
          card_code: 'ROCKET_GROWTH',
          order_day: day,
          site_name: '쿠팡 로켓그로스',
          order_type: '단독주문',
          order_count: new Set(ids).size || 1,
          total_qty: grossQty,
          total_amount: Math.round(netAmount),
        });
        if (!rgOrderIdsByDay.has(day)) rgOrderIdsByDay.set(day, new Set());
        const daySet = rgOrderIdsByDay.get(day);
        // 주문ID 가 없는 옛 데이터는 행 하나를 한 건으로 — 종전 동작 유지
        if (ids.length) ids.forEach(id => daySet.add(id));
        else daySet.add(`_row:${r.vendor_item_id}`);
      }
      for (const [day, idSet] of rgOrderIdsByDay) {
        orderCounts.push({
          order_day: day,
          site_name: '쿠팡 로켓그로스',
          order_type: '단독주문',
          distinct_order_count: idSet.size,
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
        -- 매출처 (거래처 앞에 표기) — SiteInfo 미매칭(제휴사)이면 company_Seq 코드
        ISNULL(si.SiteName, CAST(co.company_Seq AS VARCHAR)) AS site_name,
        CASE WHEN cp.order_seq IS NOT NULL THEN 1 ELSE 0 END AS is_copurchase,
        ISNULL(SUM(coi.item_count), 0) AS qty,
        ISNULL(SUM(CAST(coi.item_sale_price AS float) * coi.item_count / ISNULL(NULLIF(c.Unit_Value, 0), 1)), 0) AS amount,
        MAX(co.settle_method) AS settle_method
      FROM custom_order co WITH (NOLOCK)
      INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
      INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
      LEFT JOIN SiteInfo si WITH (NOLOCK) ON co.company_Seq = si.CompayCode
      LEFT JOIN copurchase_orders cp ON co.order_seq = cp.order_seq
      WHERE ${D01_FILTER} AND co.order_seq IN (${inList})
        AND co.status_seq >= 1 AND co.status_seq NOT IN (3, 5, 9)
      GROUP BY co.order_seq, c.Card_Code, c.Card_Name,
        ISNULL(si.SiteName, CAST(co.company_Seq AS VARCHAR)),
        CASE WHEN cp.order_seq IS NOT NULL THEN 1 ELSE 0 END
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
        -- 매출처 (거래처 앞에 표기) — SiteInfo 미매칭(제휴사)이면 company_Seq 코드
        ISNULL(si.SiteName, CAST(o.company_Seq AS VARCHAR)) AS site_name,
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
      GROUP BY o.order_seq, c.Card_Code, c.Card_Name,
        ISNULL(si.SiteName, CAST(o.company_Seq AS VARCHAR)),
        CASE WHEN ecp.order_seq IS NOT NULL THEN 1 ELSE 0 END
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
      // 매출처 — 바른손카드/바른손몰 등. SiteInfo 미매칭(제휴사)은 코드 그대로.
      site_name: formatSiteName(row.site_name) || (row._src === 'CARD' ? '바른손카드' : '바른손몰'),
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

    // vendor — 매출처(site) × 거래처 단위로 분리 집계 (표에 매출처를 앞에 표기)
    const siteName = it.site_name || '기타';
    const vKey = `${siteName}|${it.vendor_id || '_unknown'}`;
    if (!vendorMap.has(vKey)) {
      vendorMap.set(vKey, {
        vendor_id: it.vendor_id, vendor_name: it.vendor_name || '미상',
        site_name: siteName,
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

  // order_id → ci 매핑 (ETC-/MO-/raw 접두어 분리)
  const ciByCardSeq = new Map();   // CARD: order_seq → ci
  const ciByEtcSeq = new Map();    // ETC: order_seq → ci
  const ciByManualId = new Map();  // MANUAL (바른손더기프트): manual_order_id → ci
  const ciByMarketId = new Map();  // 마켓 (쿠팡/네이버/정수당): 'CP-…' 등 order_id 그대로 → ci
  inWindow.forEach(ci => {
    const oid = String(ci.order_id || '');
    if (oid.startsWith('ETC-')) {
      const seq = parseInt(oid.slice(4));
      if (seq) ciByEtcSeq.set(seq, ci);
    } else if (oid.startsWith('MO-')) {
      ciByManualId.set(oid.slice(3), ci);
    } else if (oid.startsWith('CP-') || oid.startsWith('NV-') || oid.startsWith('CF-')) {
      // 마켓 채널 — 접두가 붙어 parseInt 가 NaN 이라 여태 통째로 빠져 있었다.
      //   우리가 출고하는 주문이므로 출고 일정에 잡혀야 한다 (2026-08-12 수정).
      //   로켓그로스는 희망출고일을 아예 넣지 않으므로 여기까지 오지 않는다 (쿠팡이 출고).
      ciByMarketId.set(oid, ci);
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
        ISNULL(si.SiteName, CAST(co.company_Seq AS VARCHAR)) AS site_name,
        CASE WHEN cp.order_seq IS NOT NULL THEN 1 ELSE 0 END AS is_copurchase,
        ISNULL(SUM(CAST(coi.item_sale_price AS float) * coi.item_count / ISNULL(NULLIF(c.Unit_Value, 0), 1)), 0) AS amount,
        ISNULL(SUM(coi.item_count), 0) AS qty
      FROM custom_order co WITH (NOLOCK)
      INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
      INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
      LEFT JOIN SiteInfo si WITH (NOLOCK) ON co.company_Seq = si.CompayCode
      LEFT JOIN copurchase_orders cp ON co.order_seq = cp.order_seq
      WHERE ${D01_FILTER} AND co.order_seq IN (${inList})
        AND co.status_seq >= 1 AND co.status_seq NOT IN (3, 5, 9)
      GROUP BY co.order_seq, ISNULL(si.SiteName, CAST(co.company_Seq AS VARCHAR)),
               CASE WHEN cp.order_seq IS NOT NULL THEN 1 ELSE 0 END
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
        ISNULL(si.SiteName, CAST(o.company_Seq AS VARCHAR)) AS site_name,
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
      GROUP BY o.order_seq, ISNULL(si.SiteName, CAST(o.company_Seq AS VARCHAR)),
               CASE WHEN ecp.order_seq IS NOT NULL THEN 1 ELSE 0 END
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
  // MANUAL (바른손더기프트) — bg_manual_orders 에서 매출 조회.
  //   items[].item_amount SUM. copurchase 개념 없음 (is_copurchase=0).
  if (ciByManualId.size) {
    try {
      const bgStore = require('./barungift/store');
      for (const [moId, _ci] of ciByManualId) {
        try {
          const mo = await bgStore.getManualOrder(moId);
          if (!mo) continue;
          const st = Number(mo.status_seq) || 0;
          if (st < 1 || [3, 5, 15].includes(st)) continue;
          const items = Array.isArray(mo.items) ? mo.items : [];
          let amount = 0, qty = 0;
          for (const it of items) {
            const q = Number(it.quantity) || 0;
            const a = Number(it.item_amount) || (Number(it.unit_price) || 0) * q;
            amount += a;
            qty += q;
          }
          salesRows.push({ order_seq: moId, is_copurchase: 0, amount, qty, site_name: mo.site_name || '바른손더기프트', _src: 'MANUAL' });
        } catch (e) { console.warn(`[by-ship-date] MANUAL ${moId} 실패 (무시):`, e.message); }
      }
    } catch (e) { console.warn('[by-ship-date] MANUAL lookup 실패:', e.message); }
  }

  // 마켓 (쿠팡 판매자배송 / 네이버 / 정수당) — 주문 단위 합계.
  //   copurchase 개념이 없어 전부 단독주문으로 본다.
  if (ciByMarketId.size) {
    const MARKET_CANCELLED = new Set([
      'CANCELED', 'RETURNED', 'EXCHANGED', 'CANCEL', 'RETURNS',
      'C00', 'C10', 'C11', 'R00', 'R10', 'E00', 'E10',
    ]);
    const CHANNELS = [
      { prefix: 'CP-', site: '쿠팡', key: r => `CP-${r.coupang_order_id}`,
        load: ids => require('./coupang/store').listCoupangOrders({ orderIds: ids, excludeRocketGrowth: true }) },
      { prefix: 'NV-', site: '네이버', key: r => `NV-${r.product_order_id}`,
        load: ids => require('./naver/store').listNaverOrders({ orderIds: ids }) },
      { prefix: 'CF-', site: '정수당', key: r => `CF-${r.cafe24_order_id}`,
        load: ids => require('./cafe24/store').listCafe24Orders({ orderIds: ids }) },
    ];
    for (const ch of CHANNELS) {
      const ids = [...ciByMarketId.keys()]
        .filter(k => k.startsWith(ch.prefix))
        .map(k => k.slice(ch.prefix.length));
      if (!ids.length) continue;
      try {
        const rows = await ch.load(ids);
        // 주문 단위로 합친다 — 한 주문이 여러 상품 줄로 나뉘어 있다
        const byOrder = new Map();
        for (const r of (rows || [])) {
          if (MARKET_CANCELLED.has(String(r.status || '').toUpperCase())) continue;
          const k = ch.key(r);
          if (!ciByMarketId.has(k)) continue;     // 이 기간 출고 대상이 아닌 주문
          if (!byOrder.has(k)) {
            byOrder.set(k, { order_seq: k, is_copurchase: 0, amount: 0, qty: 0, site_name: ch.site, _src: 'MARKET' });
          }
          const b = byOrder.get(k);
          b.amount += Number(r.item_total_price) || 0;
          b.qty += Number(r.item_count) || 0;
        }
        salesRows.push(...byOrder.values());
      } catch (e) {
        console.warn(`[by-ship-date] ${ch.site} lookup 실패 (무시):`, e.message);
      }
    }
  }

  // 출고일별 그룹핑 (by_site 추가 — 채널별 매출 breakdown)
  const buckets = {}; // date → { amount, orders, qty, express, regular, copurchase, standalone, by_site }
  function ensureBucket(date) {
    if (!buckets[date]) {
      buckets[date] = {
        date, amount: 0, orders: 0, qty: 0,
        express: { amount: 0, orders: 0, qty: 0 },
        regular: { amount: 0, orders: 0, qty: 0 },
        copurchase: { amount: 0, orders: 0, qty: 0 },
        standalone: { amount: 0, orders: 0, qty: 0 },
        by_site: {},  // site_name → { amount, orders, qty }
      };
    }
    return buckets[date];
  }
  function ensureSite(b, siteName) {
    if (!b.by_site[siteName]) b.by_site[siteName] = { amount: 0, orders: 0, qty: 0 };
    return b.by_site[siteName];
  }
  let totalAmount = 0, totalOrders = 0, totalQty = 0;
  const totalBySite = {}; // site_name → { amount, orders, qty }
  salesRows.forEach(r => {
    const ci = r._src === 'ETC' ? ciByEtcSeq.get(r.order_seq)
             : r._src === 'MANUAL' ? ciByManualId.get(r.order_seq)
             : r._src === 'MARKET' ? ciByMarketId.get(r.order_seq)
             : ciByCardSeq.get(r.order_seq);
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
    // 사이트별 breakdown — formatSiteName 은 SiteInfo 매핑 이름 정규화 (CARD/ETC 공통).
    //   그 후 제휴몰 (4자리 코드 or `이름(XXXX)` 형태) 은 모두 '바른손몰' 로 통합.
    //   isAffiliateSite 는 클라이언트 (renderSiteBreakdown) 정책과 동일 — dashboard 사이트별 매출과 일관.
    const rawSiteName = formatSiteName(r.site_name || '기타');
    const isAffiliate = /\(\d{4}\)$/.test(rawSiteName) || /^\d{4}$/.test(rawSiteName);
    const siteName = isAffiliate ? '바른손몰' : rawSiteName;
    const sb = ensureSite(b, siteName);
    sb.amount += amount; sb.orders += 1; sb.qty += qty;
    if (!totalBySite[siteName]) totalBySite[siteName] = { amount: 0, orders: 0, qty: 0 };
    totalBySite[siteName].amount += amount;
    totalBySite[siteName].orders += 1;
    totalBySite[siteName].qty += qty;
    totalAmount += amount; totalOrders += 1; totalQty += qty;
  });

  const ship_dates = Object.values(buckets).sort((a, b) => a.date.localeCompare(b.date));
  // 사이트 목록 — 전체 매출 desc 정렬 (UI 컬럼 순서용)
  const sites = Object.entries(totalBySite)
    .sort((a, b) => b[1].amount - a[1].amount)
    .map(([name, v]) => ({ site_name: name, ...v }));
  return {
    period: { start: startDate, end: endDate },
    ship_dates,
    sites,
    total: { amount: totalAmount, orders: totalOrders, qty: totalQty, by_site: totalBySite },
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
 * 리드타임 분석 (진단 endpoint) — min_select_days=2 조정 효과 측정용.
 *
 * 응답:
 *   period: { start, end }
 *   summary: { total_orders_in_period, express_orders, express_pct, avg_gap_days }
 *   express_daily: [{ order_day, orders, amount, qty }]         — order_date 별 오늘출발 시계열
 *   gap_analysis: {
 *     distribution: { 0:n, 1:n, 2:n, 3:n, 4:n, '5+':n },
 *     total: N, orders_gap_le_4: N, pct_gap_le_4: %,
 *     samples: [{order_id, order_date, ship_date, gap, is_express, is_manual}]  최대 30개
 *   }
 *   ship_date_counts: [{ ship_date, orders, express_orders, regular_orders, sites: {...} }]
 *
 * 기간 필터: order_date 기준 (조정 이후 등록된 주문의 트렌드).
 */
async function apiLeadtimeAnalysis(query) {
  const p = await getPool();
  const startDate = query.start_date || fmtDate(addDays(today(), -28));
  const endDate = query.end_date || fmtDate(addDays(today(), 1));
  const empty = {
    period: { start: startDate, end: endDate },
    summary: { total_orders_in_period: 0, express_orders: 0, express_pct: 0, avg_gap_days: null },
    express_daily: [],
    gap_analysis: { distribution: {}, total: 0, orders_gap_le_4: 0, pct_gap_le_4: 0, samples: [] },
    ship_date_counts: [],
  };

  // 1) 정보입력 완료된 ci 전체 조회 (기간 무관, order_date 로 나중에 필터)
  let cInfos = [];
  try {
    const _bgStore = require('./barungift/store');
    cInfos = await _bgStore.getCustomerInfosWithShipDate();
  } catch (e) {
    console.warn('[leadtime-analysis] customer-infos fetch 실패:', e.message);
    return { ...empty, error: 'customer_info: ' + e.message };
  }
  if (!cInfos.length) return empty;

  // 2) ci → order_id 분리 (CARD/ETC/MANUAL)
  const ciByCardSeq = new Map();
  const ciByEtcSeq = new Map();
  const ciByManualId = new Map();
  cInfos.forEach(ci => {
    const oid = String(ci.order_id || '');
    if (oid.startsWith('ETC-')) {
      const seq = parseInt(oid.slice(4));
      if (seq) ciByEtcSeq.set(seq, ci);
    } else if (oid.startsWith('MO-')) {
      ciByManualId.set(oid.slice(3), ci);
    } else {
      const seq = parseInt(oid);
      if (seq) ciByCardSeq.set(seq, ci);
    }
  });

  // 3) MSSQL 에서 order_date + site + 매출 조회 (기간 무관 전체 IN 절).
  //    답례품 카테고리 필터 (D01_FILTER) 적용 — 청첩장 등 다른 카테고리 매출 제외.
  const D01_FILTER = CATEGORY_FILTERS.daeryepum.filter;
  const ETC_AMOUNT_EXPR = etcAmountExpr({});
  const _cpdFilter = CATEGORY_FILTERS.daeryepum.filter.replace(/\bc\./g, 'c_cpd.');
  const ETC_COUPON_DIVISOR_JOIN_D01 = etcCouponDivisorJoin(_cpdFilter);
  const queries = [];
  if (ciByCardSeq.size) {
    const inList = [...ciByCardSeq.keys()].join(',');
    queries.push(p.request().query(`
      SELECT co.order_seq,
        CONVERT(varchar(10), co.order_date, 120) AS order_day,
        ISNULL(si.SiteName, CAST(co.company_Seq AS VARCHAR)) AS site_name,
        ISNULL(SUM(CAST(coi.item_sale_price AS float) * coi.item_count / ISNULL(NULLIF(c.Unit_Value, 0), 1)), 0) AS amount,
        ISNULL(SUM(coi.item_count), 0) AS qty
      FROM custom_order co WITH (NOLOCK)
      INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
      INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
      LEFT JOIN SiteInfo si WITH (NOLOCK) ON co.company_Seq = si.CompayCode
      WHERE ${D01_FILTER} AND co.order_seq IN (${inList})
        AND co.status_seq >= 1 AND co.status_seq NOT IN (3, 5, 9)
      GROUP BY co.order_seq, CONVERT(varchar(10), co.order_date, 120),
        ISNULL(si.SiteName, CAST(co.company_Seq AS VARCHAR))
    `).then(r => r.recordset.map(row => ({ ...row, _src: 'CARD' }))));
  }
  if (ciByEtcSeq.size) {
    const inList = [...ciByEtcSeq.keys()].join(',');
    queries.push(p.request().query(`
      SELECT o.order_seq,
        CONVERT(varchar(10), o.order_date, 120) AS order_day,
        ISNULL(si.SiteName, CAST(o.company_Seq AS VARCHAR)) AS site_name,
        ISNULL(SUM(${ETC_AMOUNT_EXPR}), 0) AS amount,
        ISNULL(SUM(oi.order_count), 0) AS qty
      FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
      INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
      INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
      LEFT JOIN SiteInfo si WITH (NOLOCK) ON o.company_Seq = si.CompayCode
      ${ETC_COUPON_DIVISOR_JOIN_D01}
      WHERE ${D01_FILTER} AND o.order_seq IN (${inList})
        AND o.status_seq >= 1 AND o.status_seq NOT IN (3, 5, 15)
      GROUP BY o.order_seq, CONVERT(varchar(10), o.order_date, 120),
        ISNULL(si.SiteName, CAST(o.company_Seq AS VARCHAR))
    `).then(r => r.recordset.map(row => ({ ...row, _src: 'ETC' }))));
  }
  let mssqlRows = [];
  try { mssqlRows = (await Promise.all(queries)).flat(); }
  catch (e) { console.warn('[leadtime-analysis] MSSQL 실패:', e.message); }

  // 4) MANUAL — bg_manual_orders 개별 조회 (status_seq 유효한 것만)
  const manualRows = [];
  if (ciByManualId.size) {
    try {
      const bgStore = require('./barungift/store');
      for (const [moId, _ci] of ciByManualId) {
        try {
          const mo = await bgStore.getManualOrder(moId);
          if (!mo) continue;
          const st = Number(mo.status_seq) || 0;
          if (st < 1 || [3, 5, 15].includes(st)) continue;
          const items = Array.isArray(mo.items) ? mo.items : [];
          let amount = 0, qty = 0;
          for (const it of items) {
            const q = Number(it.quantity) || 0;
            const a = Number(it.item_amount) || (Number(it.unit_price) || 0) * q;
            amount += a; qty += q;
          }
          manualRows.push({
            order_seq: moId, _src: 'MANUAL',
            order_day: String(mo.order_date || '').slice(0, 10),
            site_name: mo.site_name || '바른손더기프트',
            amount, qty,
          });
        } catch (e) { /* skip */ }
      }
    } catch (e) { console.warn('[leadtime-analysis] MANUAL 실패:', e.message); }
  }
  const allRows = [...mssqlRows, ...manualRows];

  // 5) 기간 필터 (order_date 기준) + ci lookup
  //    endDate exclusive.
  const inPeriod = allRows.filter(r => r.order_day && r.order_day >= startDate && r.order_day < endDate);
  const enriched = inPeriod.map(r => {
    const ci = r._src === 'ETC' ? ciByEtcSeq.get(r.order_seq)
             : r._src === 'MANUAL' ? ciByManualId.get(r.order_seq)
             : ciByCardSeq.get(r.order_seq);
    if (!ci) return null;
    const shipDate = String(ci.desired_ship_date || '').slice(0, 10);
    if (!shipDate) return null;
    // gap = ship_date - order_date (일 단위)
    const gapMs = new Date(shipDate + 'T00:00:00Z').getTime() - new Date(r.order_day + 'T00:00:00Z').getTime();
    const gap = Math.round(gapMs / 86400000);
    // affiliate 통합
    const rawSite = formatSiteName(r.site_name || '기타');
    const isAffiliate = /\(\d{4}\)$/.test(rawSite) || /^\d{4}$/.test(rawSite);
    const site = isAffiliate ? '바른손몰' : rawSite;
    return {
      order_id: r.order_seq, order_day: r.order_day, ship_date: shipDate,
      gap, is_express: !!ci.is_express, is_manual: r._src === 'MANUAL', site,
      amount: Math.round(Number(r.amount) || 0),
      qty: Number(r.qty) || 0,
    };
  }).filter(Boolean);

  // 6) 지표 계산
  // 6a) express_daily
  const expressDailyMap = new Map();
  enriched.forEach(r => {
    if (!r.is_express) return;
    if (!expressDailyMap.has(r.order_day)) expressDailyMap.set(r.order_day, { order_day: r.order_day, orders: 0, amount: 0 });
    const b = expressDailyMap.get(r.order_day);
    b.orders += 1; b.amount += r.amount;
  });
  const express_daily = [...expressDailyMap.values()].sort((a, b) => a.order_day.localeCompare(b.order_day));

  // 6b) gap distribution + samples — orders/amount 병기
  //     세부 확장: 0/1/2/3/4/5/6/7/8/9/10+ (기존 5+ 통합 → 개별 분리, 10일 이상은 통합)
  const gapDist = {}; // { [gap]: { orders, amount } }
  const samples = [];
  let ordersGapLe4 = 0, amountGapLe4 = 0;
  enriched.forEach(r => {
    const key = r.gap < 0 ? String(r.gap) : (r.gap >= 10 ? '10+' : String(r.gap));
    if (!gapDist[key]) gapDist[key] = { orders: 0, amount: 0 };
    gapDist[key].orders += 1;
    gapDist[key].amount += r.amount;
    if (r.gap >= 0 && r.gap <= 4) {
      ordersGapLe4 += 1;
      amountGapLe4 += r.amount;
      if (samples.length < 30) samples.push({
        order_id: r.order_id, order_date: r.order_day, ship_date: r.ship_date,
        gap: r.gap, is_express: r.is_express, is_manual: r.is_manual, site: r.site,
        amount: r.amount,
      });
    }
  });
  const total = enriched.length;
  const totalAmount = enriched.reduce((s, r) => s + r.amount, 0);
  const expressAmount = enriched.reduce((s, r) => s + (r.is_express ? r.amount : 0), 0);
  const pctGapLe4 = total > 0 ? Math.round(ordersGapLe4 / total * 1000) / 10 : 0;
  const pctAmountGapLe4 = totalAmount > 0 ? Math.round(amountGapLe4 / totalAmount * 1000) / 10 : 0;
  const avgGap = total > 0 ? Math.round(enriched.reduce((s, r) => s + r.gap, 0) / total * 10) / 10 : null;

  // 6c) ship_date_counts (사이트별 breakdown + 매출)
  const shipCountMap = new Map();
  enriched.forEach(r => {
    if (!shipCountMap.has(r.ship_date)) {
      shipCountMap.set(r.ship_date, {
        ship_date: r.ship_date, orders: 0, express_orders: 0, regular_orders: 0,
        amount: 0, express_amount: 0, regular_amount: 0,
        sites: {}, // site → { orders, amount }
      });
    }
    const b = shipCountMap.get(r.ship_date);
    b.orders += 1; b.amount += r.amount;
    if (r.is_express) { b.express_orders += 1; b.express_amount += r.amount; }
    else { b.regular_orders += 1; b.regular_amount += r.amount; }
    if (!b.sites[r.site]) b.sites[r.site] = { orders: 0, amount: 0 };
    b.sites[r.site].orders += 1;
    b.sites[r.site].amount += r.amount;
  });
  const ship_date_counts = [...shipCountMap.values()].sort((a, b) => a.ship_date.localeCompare(b.ship_date));

  const express_orders = enriched.filter(r => r.is_express).length;
  const expressPct = total > 0 ? Math.round(express_orders / total * 1000) / 10 : 0;

  return {
    period: { start: startDate, end: endDate },
    summary: {
      total_orders_in_period: total,
      total_amount: Math.round(totalAmount),
      express_orders,
      express_amount: Math.round(expressAmount),
      express_pct: expressPct,
      avg_gap_days: avgGap,
    },
    express_daily,
    gap_analysis: {
      distribution: gapDist,  // { [gap]: { orders, amount } }
      total,
      total_amount: Math.round(totalAmount),
      orders_gap_le_4: ordersGapLe4,
      amount_gap_le_4: Math.round(amountGapLe4),
      pct_gap_le_4: pctGapLe4,
      pct_amount_gap_le_4: pctAmountGapLe4,
      samples,
    },
    ship_date_counts,
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
  // 예측 카드 히스토리 유지 범위 — 2026-01 부터 현재까지 표시 (요청: 연초 데이터 유지).
  //   thisSunday 기준 과거 주차 수 = anchor(2026-01-01)까지 거리. 최소 8주 보장, 상한 60주(안전장치).
  //   NOTE: 이동평균(activeWeeks.slice(-BASE_WEEKS))은 최근 주만 사용 → 과거 확장은 표시용, 모델 영향 없음.
  const FORECAST_HISTORY_ANCHOR = new Date('2026-01-04T00:00:00'); // 2026 ISO 1주차 시작 일요일
  const PAST_WEEKS = Math.max(8, Math.min(60, Math.round((thisSunday - FORECAST_HISTORY_ANCHOR) / (7 * 86400000))));

  // 1) 예식일별 건수 — 통합회원(S2_UserInfo) 의 wedd_year/wedd_month/wedd_day 기준
  //    가입사이트(REFERER_SALES_GUBUN) 무관, 청첩장 주문 여부 무관 — 회원이 입력한 예식일
  //    이면 모두 카운트. site_div='SB' 로 통합회원 중복 제거 (한 uid 당 SB/SS/BM 3행 존재).
  //    이전 모델(custom_order_WeddInfo) 은 청첩장 주문 있는 사람만 잡혀서 '단독 답례품'
  //    구매자의 결혼식이 분모에서 누락 → 전환율 과대 평가 → 회원정보 기반으로 전환.
  //    DB 조회 범위 — 윈도우 양 끝 (가장 보수적인 PAST 사용)
  const weddStart = fmtDate(addDays(thisSunday, -7 * PAST_WEEKS - PAST_WINDOW));
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
  // 디얼디어 (MySQL wedding DB) 통합 — 매출 예측 분모에 포함 (사이트 무관 합산)
  const dmdForecast = await fetchDearMyDearWeddingDates(weddStart, weddEnd);
  dmdForecast.forEach((cnt, dateKey) => {
    weddingDailyMap[dateKey] = (weddingDailyMap[dateKey] || 0) + cnt;
  });

  // 2) 주차별 예식 윈도우 건수 (예식일 ±14일 범위)
  const weeks = [];
  for (let w = -PAST_WEEKS; w < 12; w++) {
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
  const actualWeeklyStart = fmtDate(addDays(thisSunday, -7 * PAST_WEEKS)); // 2026 1주차부터
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
        WHERE ${D01_FILTER} AND co.order_date >= @awStart AND co.order_date < @awEnd AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5, 9)
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

  // 더기프트(bg_manual_orders) 일별 매출 맵 — "실제 매출" 표시용에만 합산.
  //   예측 계산(전환율·객단가)은 자사(MSSQL)만 사용 → 아래 actual_own_* 필드와 분리.
  const manualDailyMap = {};
  try {
    const _manual = await require('./barungift/store').listManualOrders({
      category: 'daeryepum', startDate: actualWeeklyStart, endDate: todayStr,
    });
    for (const mo of (_manual || [])) {
      const st = Number(mo.status_seq) || 0;
      if (!(st >= 2 && ![3, 5, 15].includes(st))) continue;   // 취소/환불/반품 제외
      const day = (mo.order_date || '').toString().slice(0, 10);
      if (!day) continue;
      if (!manualDailyMap[day]) manualDailyMap[day] = { amount: 0, orders: 0, qty: 0 };
      manualDailyMap[day].orders += 1;                          // 주문 1건
      for (const it of (Array.isArray(mo.items) ? mo.items : [])) {
        const q = Number(it.quantity) || 0;
        manualDailyMap[day].amount += Number(it.item_amount) || (Number(it.unit_price) || 0) * q;
        manualDailyMap[day].qty += q;
      }
    }
  } catch (e) {
    console.warn('[forecast] 더기프트 실매출 집계 실패 (무시):', e.message);
  }

  // 각 주차에 실제 매출 매핑
  for (const w of weeks) {
    let actAmount = 0, actOrders = 0, actQty = 0, actDays = 0;   // 자사(MSSQL) — 예측 모델 기준
    let mAmount = 0, mOrders = 0, mQty = 0;                       // 더기프트 — 표시용 가산
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
      if (isPast && manualDailyMap[key]) {
        mAmount += manualDailyMap[key].amount;
        mOrders += manualDailyMap[key].orders;
        mQty += manualDailyMap[key].qty;
      }
    }
    // 자사 전용 (예측 모델 계산 기준 — 전환율·객단가) — 더기프트 미포함
    w.actual_own_revenue = Math.round(actAmount);
    w.actual_own_orders = actOrders;
    // 표시용 실제 = 자사 + 더기프트
    w.actual_weekly_revenue = Math.round(actAmount + mAmount);
    w.actual_orders = actOrders + mOrders;
    w.actual_qty = actQty + mQty;
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
  const activeWeeks = completedWeeks.filter(w => w.actual_own_orders >= MIN_WEEKLY_ORDERS); // 자사 기준
  const baseWeeks = activeWeeks.slice(-BASE_WEEKS);
  let baseTotalRevenue = 0, baseTotalOrders = 0, baseTotalWeddings = 0;
  let weightedOrders = 0, weightedWeddings = 0, weightedRevenue = 0, weightSum = 0;
  baseWeeks.forEach((bw, i) => {
    const weight = i + 1; // 1, 2, 3, 4 (최근일수록 높은 가중치)
    weightSum += weight;
    weightedOrders += bw.actual_own_orders * weight;
    weightedWeddings += bw.wedding_pool * weight;
    weightedRevenue += bw.actual_own_revenue * weight;
    // 단순 합계도 유지 (참고용) — 자사 기준
    baseTotalRevenue += bw.actual_own_revenue;
    baseTotalOrders += bw.actual_own_orders;
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
        WHERE ${D01_FILTER} AND co.order_date >= @start30 AND co.order_date < DATEADD(day,1,@today) AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5, 9)
      ) t
    `);

  const actual = actualStats.recordset[0] || {};
  const actualDailyAvg = actual.active_days > 0 ? Math.round(actual.total_amount / actual.active_days) : 0;

  // 주차별 전환율 트렌드 (대시보드 표시용)
  const weeklyConversionTrend = activeWeeks.slice(-6).map(w => ({
    week_no: w.week_no,
    week_start: w.week_start,
    wedding_pool: w.wedding_pool,
    actual_orders: w.actual_own_orders,
    conversion_rate: w.wedding_pool > 0 ? Math.round(w.actual_own_orders / w.wedding_pool * 10000) / 100 : 0,
    avg_order_value: w.actual_own_orders > 0 ? Math.round(w.actual_own_revenue / w.actual_own_orders) : 0,
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
      WHERE ${D01_FILTER} AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5, 9)
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
        AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5, 9)
      GROUP BY CONVERT(varchar(10), co.order_date, 120)
    `);

  // 일별 → 주차별 집계 (사이트별)
  // weddingMap: { 'YYYY-MM-DD': { total: N, '바른손카드': N, '바른손몰': N, '디얼디어': N, ... } }
  const MAIN_SITES = ['바른손카드', '바른손몰', '디얼디어', '바른손M카드'];
  const weddingMap = {};
  weddings.recordset.forEach(r => {
    if (!weddingMap[r.wd]) weddingMap[r.wd] = { total: 0 };
    weddingMap[r.wd].total += r.wedding_count;
    const site = MAIN_SITES.includes(r.site_name) ? r.site_name : '기타';
    weddingMap[r.wd][site] = (weddingMap[r.wd][site] || 0) + r.wedding_count;
  });
  // 디얼디어 (MySQL wedding DB) 통합 — '디얼디어' 사이트로 라벨링
  const dmdConv = await fetchDearMyDearWeddingDates(startDate, endDate);
  dmdConv.forEach((cnt, dateKey) => {
    if (!weddingMap[dateKey]) weddingMap[dateKey] = { total: 0 };
    weddingMap[dateKey].total += cnt;
    weddingMap[dateKey]['디얼디어'] = (weddingMap[dateKey]['디얼디어'] || 0) + cnt;
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
    } else if (oid.startsWith('ETC-') || oid.startsWith('CP-') || oid.startsWith('NV-') || oid.startsWith('CF-')) {
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
// 디얼디어 (wedding MySQL DB) 예식자 fetch — users.event_date 기반
//   varchar(50) 이라 STR_TO_DATE 다중 포맷 시도 + REGEXP 으로 안전 필터.
//   is_test='F' (실회원만) + event_date 비어있지 않음 조건.
//   반환: Map<'YYYY-MM-DD', count>
// ============================================
async function fetchDearMyDearWeddingDates(startDateStr, endDateExclStr) {
  if (!process.env.MYSQL_HOST) return new Map(); // 환경변수 미설정 — 통합 영역에서 자연 0 처리
  try {
    const mp = await getMysqlPool();
    // 가장 흔한 포맷 'YYYY-MM-DD' 우선. 다른 포맷 추가 발견 시 COALESCE 로 확장.
    //   - 'YYYY-MM-DD' (표준)
    //   - 'YYYY-MM-DD HH:mm:ss' (LEFT 10 자리만)
    //   - 'YYYY/MM/DD'
    //   - 'YYYYMMDD'
    const [rows] = await mp.query(`
      SELECT wd, COUNT(*) AS cnt
      FROM (
        SELECT DISTINCT id,
          COALESCE(
            STR_TO_DATE(LEFT(event_date, 10), '%Y-%m-%d'),
            STR_TO_DATE(LEFT(event_date, 10), '%Y/%m/%d'),
            CASE WHEN event_date REGEXP '^[0-9]{8}$' THEN STR_TO_DATE(event_date, '%Y%m%d') END
          ) AS wd
        FROM users
        WHERE is_test = 'F'
          AND event_date IS NOT NULL AND event_date <> ''
      ) t
      WHERE t.wd IS NOT NULL
        AND t.wd >= ? AND t.wd < ?
      GROUP BY wd
      ORDER BY wd
    `, [startDateStr, endDateExclStr]);
    const out = new Map();
    rows.forEach(r => {
      // Date 객체 → 'YYYY-MM-DD'
      const d = r.wd instanceof Date
        ? r.wd.toISOString().slice(0, 10)
        : String(r.wd).slice(0, 10);
      out.set(d, r.cnt);
    });
    return out;
  } catch (e) {
    console.warn('[fetchDearMyDearWeddingDates] MySQL 조회 실패 — 0건 fallback:', e.message);
    return new Map();
  }
}

// ============================================
// 디얼디어 (wedding MySQL DB) 회원 DupInfo (DI) Set — 본인인증 ID 매칭용
//   users.dupinfo 평문 (NICE/KCB DI, ~64자) → MSSQL S2_UserInfo.DupInfo 와 정확 매칭.
//   phone 은 Laravel encrypted 라 매칭 불가, 대신 본인인증 DI 사용 (가장 정확한 회원 식별자).
//   10분 캐시. 미설정/실패 시 빈 Set.
// ============================================
let _dmdDupInfosCache = null;
let _dmdDupInfosCacheTs = 0;
async function fetchDearMyDearDupInfos() {
  if (!process.env.MYSQL_HOST) return new Set();
  const TTL_MS = 10 * 60 * 1000;
  if (_dmdDupInfosCache && Date.now() - _dmdDupInfosCacheTs < TTL_MS) return _dmdDupInfosCache;
  try {
    const mp = await getMysqlPool();
    const [rows] = await mp.query(`
      SELECT DISTINCT dupinfo FROM users
      WHERE is_test = 'F' AND dupinfo IS NOT NULL AND dupinfo <> ''
    `);
    const set = new Set();
    rows.forEach(r => {
      const v = String(r.dupinfo || '').trim();
      if (v.length >= 32) set.add(v); // 너무 짧은 잘못된 값 노이즈 제거 (정상은 64자)
    });
    _dmdDupInfosCache = set;
    _dmdDupInfosCacheTs = Date.now();
    return set;
  } catch (e) {
    console.warn('[fetchDearMyDearDupInfos] MySQL 조회 실패:', e.message);
    return new Set();
  }
}

// ============================================
// 디얼디어 (wedding MySQL DB) 회원 전화번호 set — (phone 은 Laravel encrypted 라 deprecated)
//   probe endpoint 검증 용도로만 유지. 매칭 0건 확인됨.
// ============================================
let _dmdPhonesCache = null;
let _dmdPhonesCacheTs = 0;
async function fetchDearMyDearPhones() {
  if (!process.env.MYSQL_HOST) return new Set();
  // 10분 캐시 (회원 phone 은 자주 변하지 않음 — DB 부하 절감)
  const TTL_MS = 10 * 60 * 1000;
  if (_dmdPhonesCache && Date.now() - _dmdPhonesCacheTs < TTL_MS) return _dmdPhonesCache;
  try {
    const mp = await getMysqlPool();
    const [rows] = await mp.query(`
      SELECT DISTINCT phone FROM users
      WHERE is_test = 'F' AND phone IS NOT NULL AND phone <> ''
    `);
    const set = new Set();
    rows.forEach(r => {
      const norm = String(r.phone || '').replace(/\D/g, '');
      if (norm.length >= 8) set.add(norm);
    });
    _dmdPhonesCache = set;
    _dmdPhonesCacheTs = Date.now();
    return set;
  } catch (e) {
    console.warn('[fetchDearMyDearPhones] MySQL 조회 실패:', e.message);
    return new Set();
  }
}

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
  // 디얼디어 (별도 MySQL wedding DB) 통합 — users.event_date 기반
  const dmd = await fetchDearMyDearWeddingDates(fmtDate(gridStart), fmtDate(addDays(gridEnd, 1)));
  dmd.forEach((cnt, dateKey) => {
    if (!dailyMap[dateKey]) dailyMap[dateKey] = {};
    dailyMap[dateKey]['디얼디어'] = (dailyMap[dateKey]['디얼디어'] || 0) + cnt;
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
        // 월 외 셀도 실제 값 노출 — 첫째 주(이전 월 말일), 마지막 주(다음 월 초)
        //   week_total 도 7일 전체 합으로 더 정확해짐.
        //   month_summary 만 in_month 분기 유지 (정확한 월 통합).
        const v = cell[s] || 0;
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
  // 디얼디어 전년 동월 통합
  const dmdPrev = await fetchDearMyDearWeddingDates(fmtDate(prevMonthStart), fmtDate(addDays(prevMonthEnd, 1)));
  dmdPrev.forEach(cnt => { prevBySite['디얼디어'] += cnt; });
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
  // 디얼디어 (MySQL) 통합 — 일별 데이터를 월로 집계
  const dmdTrend = await fetchDearMyDearWeddingDates(fmtDate(startDate), fmtDate(endDateExclusive));
  dmdTrend.forEach((cnt, dateKey) => {
    const dt = new Date(dateKey);
    const key = `${dt.getFullYear()}-${dt.getMonth() + 1}`;
    if (!map[key]) map[key] = {};
    map[key]['디얼디어'] = (map[key]['디얼디어'] || 0) + cnt;
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

// ============================================
// 예식일 캘린더 — 사이트 분포 진단
// GET /api/dashboard/wedding-calendar/site-breakdown?year=Y&month=M
//   해당 월에 잡힌 회원들의 실제 SiteName 분포 + REFERER_SALES_GUBUN 분포.
//   '기타' 로 묶인 사이트가 무엇인지 확인용 — 운영자가 메인 4사이트 확장 결정에 사용.
//
// 응답:
//   {
//     year, month,
//     by_site_name: [{ site_name, member_count }, ...],   // SiteInfo 매칭된 사이트별 (NULL 포함)
//     by_referer_code: [{ referer_code, site_name, member_count }, ...],  // 코드 단위 raw 분포
//     unmatched_referer_codes: [...],                      // SiteInfo 에 등록 안 된 REFERER_SALES_GUBUN
//   }
// ============================================
async function apiWeddingCalendarSiteBreakdown(query = {}) {
  const now = today();
  const year = parseInt(query.year, 10) || now.getFullYear();
  const month = parseInt(query.month, 10) || (now.getMonth() + 1);
  if (year < 2000 || year > 2100 || month < 1 || month > 12) {
    return { error: 'year/month 범위 오류' };
  }

  const monthStart = new Date(year, month - 1, 1);
  const monthEndExclusive = new Date(year, month, 1);
  const p = await getPool();

  // SiteName 분포 (NULL 도 별도 행으로 표시)
  const r1 = await p.request()
    .input('ws', sql.VarChar, fmtDate(monthStart))
    .input('we', sql.VarChar, fmtDate(monthEndExclusive))
    .query(`
      SELECT site_name, COUNT(*) AS member_count
      FROM (
        SELECT DISTINCT u.uid,
          si.SiteName AS site_name
        FROM S2_UserInfo u WITH (NOLOCK)
        LEFT JOIN SiteInfo si ON u.REFERER_SALES_GUBUN = si.SiteCode
        WHERE u.site_div = 'SB'
          AND u.USE_YORN = 'Y'
          AND u.wedd_year IS NOT NULL AND LEN(u.wedd_year) = 4
          AND TRY_CAST(u.wedd_year+'-'+RIGHT('0'+u.wedd_month,2)+'-'+RIGHT('0'+u.wedd_day,2) AS date) >= @ws
          AND TRY_CAST(u.wedd_year+'-'+RIGHT('0'+u.wedd_month,2)+'-'+RIGHT('0'+u.wedd_day,2) AS date) < @we
      ) t
      GROUP BY site_name
      ORDER BY member_count DESC
    `);

  // REFERER_SALES_GUBUN 코드 단위 raw 분포 (어떤 코드가 매칭 안 되는지 확인)
  const r2 = await p.request()
    .input('ws', sql.VarChar, fmtDate(monthStart))
    .input('we', sql.VarChar, fmtDate(monthEndExclusive))
    .query(`
      SELECT referer_code, site_name, COUNT(*) AS member_count
      FROM (
        SELECT DISTINCT u.uid,
          ISNULL(u.REFERER_SALES_GUBUN, '(NULL)') AS referer_code,
          si.SiteName AS site_name
        FROM S2_UserInfo u WITH (NOLOCK)
        LEFT JOIN SiteInfo si ON u.REFERER_SALES_GUBUN = si.SiteCode
        WHERE u.site_div = 'SB'
          AND u.USE_YORN = 'Y'
          AND u.wedd_year IS NOT NULL AND LEN(u.wedd_year) = 4
          AND TRY_CAST(u.wedd_year+'-'+RIGHT('0'+u.wedd_month,2)+'-'+RIGHT('0'+u.wedd_day,2) AS date) >= @ws
          AND TRY_CAST(u.wedd_year+'-'+RIGHT('0'+u.wedd_month,2)+'-'+RIGHT('0'+u.wedd_day,2) AS date) < @we
      ) t
      GROUP BY referer_code, site_name
      ORDER BY member_count DESC
    `);

  // '기타' 로 묶이는 사이트 (메인 4 외 + NULL)
  const MAIN = WEDDING_CALENDAR_SITES;
  const otherBuckets = r1.recordset
    .filter(row => row.site_name === null || !MAIN.includes(row.site_name))
    .map(row => ({ site_name: row.site_name || '(SiteInfo 미매칭)', member_count: row.member_count }));

  // 디얼디어 (MySQL) 별도 표시 — by_site_name 에 추가
  const dmd = await fetchDearMyDearWeddingDates(fmtDate(monthStart), fmtDate(monthEndExclusive));
  let dmdTotal = 0;
  dmd.forEach(cnt => { dmdTotal += cnt; });
  const bySiteOut = r1.recordset.map(r => ({
    site_name: r.site_name || '(SiteInfo 미매칭)',
    member_count: r.member_count,
    is_main: r.site_name ? MAIN.includes(r.site_name) : false,
    source: 'MSSQL (S2_UserInfo)',
  }));
  if (dmdTotal > 0) {
    bySiteOut.push({
      site_name: '디얼디어',
      member_count: dmdTotal,
      is_main: true,
      source: 'MySQL (wedding.users.event_date)',
    });
  }

  return {
    year,
    month,
    main_sites: MAIN,
    by_site_name: bySiteOut,
    by_referer_code: r2.recordset.map(r => ({
      referer_code: r.referer_code,
      site_name: r.site_name || '(SiteInfo 미매칭)',
      member_count: r.member_count,
    })),
    other_buckets: otherBuckets,
    dearMyDear: { total: dmdTotal, source: 'MySQL wedding.users.event_date (is_test=F)' },
    hint: '"기타" 로 묶인 항목 확인용. 디얼디어는 별도 MySQL DB 에서 통합. 운영자가 메인 승격하고 싶은 사이트가 있으면 WEDDING_CALENDAR_SITES 상수에 추가.',
  };
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
          AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5, 9)
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
          AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5, 9)
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
      WHERE ${D01_FILTER} AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5, 9) AND co.order_date >= ${MK_FROM} AND co.order_date < ${MK_TO}
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
      WHERE ${D01_FILTER} AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5, 9) AND co.order_date >= ${MK_FROM} AND co.order_date < ${MK_TO}
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
      WHERE ${D01_FILTER} AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5, 9) AND co.order_date >= ${MK_FROM} AND co.order_date < ${MK_TO}
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
      WHERE ${D01_FILTER} AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5, 9) AND co.order_date >= ${MK_FROM} AND co.order_date < ${MK_TO}
        AND co.member_id IS NOT NULL AND co.member_id != ''
    ) t
  `);
  const giftSet = new Set(giftMembers.recordset.map(r => r.member_id));

  const cardMembers = await p.request().query(`
    SELECT DISTINCT co.member_id
    FROM custom_order co WITH (NOLOCK)
    INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
    INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
    WHERE c.Card_Div = 'A01' AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5, 9) AND co.order_date >= ${MK_FROM} AND co.order_date < ${MK_TO}
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
      WHERE ${D01_FILTER} AND cord.status_seq >= 2 AND cord.status_seq NOT IN (3, 5, 9)
        AND cord.order_date >= ${MK_FROM} AND cord.order_date < ${MK_TO}
    ) t GROUP BY order_site ORDER BY order_count DESC
  `);

  // 가입사이트 = 회원이 실제로 가입한 사이트 (S2_UserInfo.REFERER_SALES_GUBUN)
  //   바른손M카드 가입회원 중 답례품 구매자도 별도 행으로 표시.
  //   site_div='SB' + USE_YORN='Y' 로 통합회원 중복 제거 + 활성 회원.
  //   디얼디어 매칭: DupInfo (NICE/KCB 본인인증 DI) — MySQL users.dupinfo ↔ MSSQL DupInfo 정확 매칭.
  const signupSiteRaw = await p.request().query(`
    WITH gift_buyer_members AS (
      SELECT DISTINCT member_id FROM (
        SELECT o.member_id
        FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
        INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
        INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
        WHERE ${D01_FILTER} AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 15)
          AND o.order_date >= ${MK_FROM} AND o.order_date < ${MK_TO}
        UNION ALL
        SELECT cord.member_id
        FROM custom_order cord WITH (NOLOCK)
        INNER JOIN custom_order_item coi WITH (NOLOCK) ON cord.order_seq = coi.order_seq
        INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
        WHERE ${D01_FILTER} AND cord.status_seq >= 2 AND cord.status_seq NOT IN (3, 5, 9)
          AND cord.order_date >= ${MK_FROM} AND cord.order_date < ${MK_TO}
      ) u
      WHERE member_id IS NOT NULL
    )
    SELECT
      ISNULL(ref_si.SiteName, '기타') AS signup_site,
      ui.DupInfo AS dupinfo
    FROM gift_buyer_members gbm
    INNER JOIN S2_UserInfo ui WITH (NOLOCK) ON gbm.member_id = ui.uid
    LEFT JOIN SiteInfo ref_si ON ui.REFERER_SALES_GUBUN = ref_si.SiteCode
    WHERE ui.site_div = 'SB' AND ui.USE_YORN = 'Y'
  `);
  // 디얼디어 DupInfo 매칭 — 보조지표 (텍스트) 전용. 막대그래프 분류는 변경하지 않음.
  //   디얼디어 회원이 바른손카드/몰/M카드 등에 별도 가입했다면 그쪽 막대에 이미 포함됨.
  //   강제로 '디얼디어' 로 옮기면 다른 사이트 카운트가 부정확해지므로 그대로 두고
  //   '디얼디어 회원 중복 N명' 만 별도 메타로 노출 → 클라이언트에서 보조 텍스트로 표시.
  const _dmdDupInfos = await fetchDearMyDearDupInfos();
  const _signupCounts = {};
  let _dmdMatchedCount = 0;
  signupSiteRaw.recordset.forEach(row => {
    _signupCounts[row.signup_site] = (_signupCounts[row.signup_site] || 0) + 1;
    const dup = String(row.dupinfo || '').trim();
    if (dup.length >= 32 && _dmdDupInfos.has(dup)) _dmdMatchedCount++;
  });
  // 비회원 주문 — member_id NULL/빈값 (회원 가입 안 한 게스트 결제). 주문 단위 카운트.
  //   회원 행은 회원 단위 (1회원 = 1행), 비회원은 주문 단위라 단위 차이 있음 → 라벨에 명시.
  const guestOrdersRes = await p.request().query(`
    SELECT COUNT(DISTINCT order_key) AS guest_orders
    FROM (
      SELECT o.member_id, CONCAT('E', o.order_seq) AS order_key
      FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
      INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
      INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
      WHERE ${D01_FILTER} AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 15)
        AND o.order_date >= ${MK_FROM} AND o.order_date < ${MK_TO}
      UNION ALL
      SELECT cord.member_id, CONCAT('C', cord.order_seq) AS order_key
      FROM custom_order cord WITH (NOLOCK)
      INNER JOIN custom_order_item coi WITH (NOLOCK) ON cord.order_seq = coi.order_seq
      INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
      WHERE ${D01_FILTER} AND cord.status_seq >= 2 AND cord.status_seq NOT IN (3, 5, 9)
        AND cord.order_date >= ${MK_FROM} AND cord.order_date < ${MK_TO}
    ) u
    WHERE member_id IS NULL OR LTRIM(RTRIM(CAST(member_id AS NVARCHAR(50)))) = ''
  `);
  const guestCount = guestOrdersRes.recordset[0]?.guest_orders || 0;
  if (guestCount > 0) _signupCounts['비회원'] = guestCount;
  const signupSiteResult = {
    recordset: Object.entries(_signupCounts)
      .map(([signup_site, member_count]) => ({ signup_site, member_count }))
      .sort((a, b) => b.member_count - a.member_count),
    dearMyDearMatchedCount: _dmdMatchedCount,
    dearMyDearTotalSetSize: _dmdDupInfos.size,
    guestOrderCount: guestCount,
  };

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
      WHERE ${D01_FILTER} AND cord.status_seq >= 2 AND cord.status_seq NOT IN (3, 5, 9)
        AND cord.order_date >= ${MK_FROM} AND cord.order_date < ${MK_TO}
    ),
    -- 가입 사이트 = S2_UserInfo.REFERER_SALES_GUBUN (signupSiteRaw 와 동일 정책)
    --   이전 (최초 주문 사이트) 은 M카드 회원이 영원히 0건이라 부정확.
    --   통합회원 site_div='SB' + USE_YORN='Y' 활성 회원만.
    referer_site AS (
      SELECT u.uid AS member_id, u.REFERER_SALES_GUBUN AS referer_sg
      FROM S2_UserInfo u WITH (NOLOCK)
      WHERE u.site_div = 'SB' AND u.USE_YORN = 'Y'
    )
    SELECT
      ISNULL(rs_si.SiteName, '기타') AS signup_site,
      ISNULL(os_si.SiteName, '기타') AS order_site,
      COUNT(DISTINCT ago.order_key) AS order_count
    FROM all_gift_orders ago
    LEFT JOIN SiteInfo os_si ON ago.SALES_GUBUN = os_si.SiteCode
    INNER JOIN referer_site rs ON ago.member_id = rs.member_id
    LEFT JOIN SiteInfo rs_si ON rs.referer_sg = rs_si.SiteCode
    GROUP BY ISNULL(rs_si.SiteName, '기타'), ISNULL(os_si.SiteName, '기타')
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
      WHERE ${D01_FILTER} AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5, 9)
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
      WHERE ${D01_FILTER} AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5, 9)
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
      WHERE ${D01_FILTER} AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5, 9)
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
      WHERE ${D01_FILTER} AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5, 9)
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
    signupSiteMeta: {
      // 디얼디어 회원 중 답례품 구매자 (DupInfo 매칭). 위 막대그래프 내 다른 사이트에 이미 포함된 중복 카운트.
      dearMyDearMatchedCount: signupSiteResult.dearMyDearMatchedCount || 0,
      dearMyDearTotalSetSize: signupSiteResult.dearMyDearTotalSetSize || 0,
    },
    siteCross: siteCrossResult.recordset,
    reorder: reorderResult.recordset[0] || {},
    reorderInterval: reorderIntervalResult.recordset,
    channelMix: channelResult.recordset,
    channelTrend: channelTrendResult.recordset,
    period: `${mkStart} ~ ${mkEnd}`,
    mkStart, mkEnd,
  };
}

// ============================================
// 마케팅 분석 — 그룹별 분리 endpoint (페이지 로드 최적화)
//   전체 apiMarketing 은 11개 SQL 직렬 호출이라 무거움.
//   그룹별 자체 기간 입력기에서 호출 → 변경된 그룹만 빠르게 재조회.
// ============================================

/** 기간 검증 helper — 그룹별 함수들 공통. */
function _validateMkPeriod(query) {
  const mkStart = query.start_date || fmtDate(addDays(today(), -90));
  const mkEnd = query.end_date || fmtDate(addDays(today(), 1));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(mkStart) || !/^\d{4}-\d{2}-\d{2}$/.test(mkEnd)) {
    throw new Error('Invalid date format');
  }
  return { mkStart, mkEnd, MK_FROM: `'${mkStart}'`, MK_TO: `'${mkEnd}'` };
}

/** GET /api/dashboard/conversion-window — 청첩장→답례품 전환율 (예식 윈도우 -14~+7일 기준).
 *   기간내 청첩장(A01) 구매 회원 중, 본인 예식일 [-14, +7]일 사이에 답례품(D01) 을 구매한 회원 비율.
 *   apiMarketing.conversion(기간내 단순 교차)과 달리 답례품 타이밍을 예식 윈도우로 포착.
 *   분모 = 예식일(S2_UserInfo) 등록된 청첩장 구매 회원. 별도 endpoint — apiMarketing 부하 회피.
 */
async function apiConversionWindow(query = {}) {
  const p = await getPool();
  const { mkStart, mkEnd, MK_FROM, MK_TO } = _validateMkPeriod(query);
  const categoryCfg = CATEGORY_FILTERS[query.category] || CATEGORY_FILTERS.daeryepum;
  const D01_FILTER = categoryCfg.filter;
  const BEFORE = 14, AFTER = 7, DAY = 86400000;
  // 무거운 조인 제거 — 회원ID 축소 후 예식일·답례품을 전부 인덱스 기반 chunk IN 조회.
  //   step 라벨로 실패 지점 추적 (기존 'code: UNKNOWN' 마스킹 대응).
  let step = 'init';
  const q = async (label, sqlText) => {
    step = label;
    try { return await p.request().query(sqlText); }
    catch (e) { const err = new Error(`[step:${label}] ${e?.message || e}`); err.step = label; throw err; }
  };
  const CHUNK = 1000;
  const chunks = arr => { const o = []; for (let i = 0; i < arr.length; i += CHUNK) o.push(arr.slice(i, i + CHUNK)); return o; };
  const esc = m => `'${String(m).replace(/'/g, "''")}'`;

  // 1) 기간내 청첩장(A01) 구매 회원 ID (S2_UserInfo 조인 없이 — 경량)
  const cardRes = await q('card_members', `
    SELECT DISTINCT co.member_id
    FROM custom_order co WITH (NOLOCK)
    INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
    INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
    WHERE c.Card_Div = 'A01' AND co.status_seq >= 2 AND co.status_seq NOT IN (3,5,9)
      AND co.order_date >= ${MK_FROM} AND co.order_date < ${MK_TO}
      AND co.member_id IS NOT NULL AND co.member_id != ''
  `);
  const cardMemberIds = [...new Set((cardRes.recordset || []).map(r => r.member_id))];
  const cardMembersTotal = cardMemberIds.length;

  // 2) 그 회원들의 예식일 — S2_UserInfo uid chunk IN (인덱스 seek)
  const weddingByMember = new Map(); // member_id → Date
  const parseWed = (y, m, d) => {
    const yr = parseInt(y, 10), mo = parseInt(m, 10), dy = parseInt(d, 10);
    if (!(yr >= 2000 && yr < 2100 && mo >= 1 && mo <= 12 && dy >= 1 && dy <= 31)) return null;
    return new Date(yr, mo - 1, dy);
  };
  for (const chunk of chunks(cardMemberIds)) {
    if (!chunk.length) continue;
    const inList = chunk.map(esc).join(',');
    const wr = await q('wedding', `
      SELECT uid, wedd_year, wedd_month, wedd_day
      FROM S2_UserInfo WITH (NOLOCK)
      WHERE site_div = 'SB' AND uid IN (${inList})
        AND wedd_year IS NOT NULL AND LEN(wedd_year) = 4
    `);
    for (const row of (wr.recordset || [])) {
      if (weddingByMember.has(row.uid)) continue;
      const wd = parseWed(row.wedd_year, row.wedd_month, row.wedd_day);
      if (wd) weddingByMember.set(row.uid, wd);
    }
  }
  const cardBuyers = cardMemberIds.filter(m => weddingByMember.has(m)).map(m => ({ member_id: m, wd: weddingByMember.get(m) }));

  // 3) 예식일 등록 회원들의 답례품(D01) 주문일 — member_id chunk IN
  const giftByMember = new Map(); // member_id → [Date]
  for (const chunk of chunks(cardBuyers.map(r => r.member_id))) {
    if (!chunk.length) continue;
    const inList = chunk.map(esc).join(',');
    const gr = await q('gift', `
      SELECT member_id, order_date FROM (
        SELECT o.member_id, o.order_date
        FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
        INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
        INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
        WHERE ${D01_FILTER} AND o.status_seq >= 2 AND o.status_seq NOT IN (3,5,15)
          AND o.member_id IN (${inList})
        UNION ALL
        SELECT co.member_id, co.order_date
        FROM custom_order co WITH (NOLOCK)
        INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
        INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
        WHERE ${D01_FILTER} AND co.status_seq >= 2 AND co.status_seq NOT IN (3,5,9)
          AND co.member_id IN (${inList})
      ) t
    `);
    for (const row of (gr.recordset || [])) {
      const arr = giftByMember.get(row.member_id) || [];
      arr.push(new Date(row.order_date));
      giftByMember.set(row.member_id, arr);
    }
  }

  // 4) JS 윈도우 판정 — (B) 예식 윈도우가 이미 종료된(전환 기회가 있던) 회원만 분모.
  //    미래/진행중 예식(오늘 <= 예식일+7일)은 아직 전환 기회 전이라 분모에서 제외 → 지표 왜곡 방지.
  const now = Date.now();
  let cross = 0, eligible = 0;
  for (const cb of cardBuyers) {
    const wt = cb.wd.getTime();
    if (wt + AFTER * DAY >= now) continue; // 예식일+7일이 아직 안 지남 → 전환 기회 전 → 제외
    eligible++;
    const lo = wt - BEFORE * DAY;
    const hi = wt + (AFTER + 1) * DAY; // +7일 포함 → exclusive +8
    const gifts = giftByMember.get(cb.member_id);
    if (gifts && gifts.some(d => { const t = d.getTime(); return t >= lo && t < hi; })) cross++;
  }
  return {
    period: `${mkStart} ~ ${mkEnd}`,
    mkStart, mkEnd,
    window_days: { before: BEFORE, after: AFTER },
    card_members_total: cardMembersTotal,   // 기간내 청첩장 주문 회원 (전체)
    card_members_dated: cardBuyers.length,  // 예식일 등록 회원 (참고)
    card_members_eligible: eligible,        // 예식 윈도우 종료 = 전환율 분모 (전환 기회 있던 회원)
    cross_buy: cross,                       // 그 중 예식 윈도우(-14~+7) 내 답례품 구매 회원
    conversion_pct: eligible ? +(cross / eligible * 100).toFixed(1) : 0,
  };
}

/** GET /api/dashboard/marketing/sites — 주문 사이트 / 가입 사이트 / 크로스탭 */
async function apiMarketingSites(query = {}) {
  const p = await getPool();
  const { mkStart, mkEnd, MK_FROM, MK_TO } = _validateMkPeriod(query);

  // 5) 주문사이트 분포 - ETC + CARD 답례품 통합
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
      WHERE ${D01_FILTER} AND cord.status_seq >= 2 AND cord.status_seq NOT IN (3, 5, 9)
        AND cord.order_date >= ${MK_FROM} AND cord.order_date < ${MK_TO}
    ) t GROUP BY order_site ORDER BY order_count DESC
  `);

  // 가입사이트 raw (REFERER_SALES_GUBUN 기반)
  const signupSiteRaw = await p.request().query(`
    WITH gift_buyer_members AS (
      SELECT DISTINCT member_id FROM (
        SELECT o.member_id FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
        INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
        INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
        WHERE ${D01_FILTER} AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 15)
          AND o.order_date >= ${MK_FROM} AND o.order_date < ${MK_TO}
        UNION ALL
        SELECT cord.member_id FROM custom_order cord WITH (NOLOCK)
        INNER JOIN custom_order_item coi WITH (NOLOCK) ON cord.order_seq = coi.order_seq
        INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
        WHERE ${D01_FILTER} AND cord.status_seq >= 2 AND cord.status_seq NOT IN (3, 5, 9)
          AND cord.order_date >= ${MK_FROM} AND cord.order_date < ${MK_TO}
      ) u WHERE member_id IS NOT NULL
    )
    SELECT ISNULL(ref_si.SiteName, '기타') AS signup_site, ui.DupInfo AS dupinfo
    FROM gift_buyer_members gbm
    INNER JOIN S2_UserInfo ui WITH (NOLOCK) ON gbm.member_id = ui.uid
    LEFT JOIN SiteInfo ref_si ON ui.REFERER_SALES_GUBUN = ref_si.SiteCode
    WHERE ui.site_div = 'SB' AND ui.USE_YORN = 'Y'
  `);

  // 디얼디어 DupInfo 매칭 (보조지표 텍스트용 카운트)
  const _dmdDupInfos = await fetchDearMyDearDupInfos();
  const _signupCounts = {};
  let _dmdMatchedCount = 0;
  signupSiteRaw.recordset.forEach(row => {
    _signupCounts[row.signup_site] = (_signupCounts[row.signup_site] || 0) + 1;
    const dup = String(row.dupinfo || '').trim();
    if (dup.length >= 32 && _dmdDupInfos.has(dup)) _dmdMatchedCount++;
  });

  // 비회원 주문 (member_id NULL/빈값)
  const guestOrdersRes = await p.request().query(`
    SELECT COUNT(DISTINCT order_key) AS guest_orders FROM (
      SELECT o.member_id, CONCAT('E', o.order_seq) AS order_key
      FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
      INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
      INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
      WHERE ${D01_FILTER} AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 15)
        AND o.order_date >= ${MK_FROM} AND o.order_date < ${MK_TO}
      UNION ALL
      SELECT cord.member_id, CONCAT('C', cord.order_seq) AS order_key
      FROM custom_order cord WITH (NOLOCK)
      INNER JOIN custom_order_item coi WITH (NOLOCK) ON cord.order_seq = coi.order_seq
      INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
      WHERE ${D01_FILTER} AND cord.status_seq >= 2 AND cord.status_seq NOT IN (3, 5, 9)
        AND cord.order_date >= ${MK_FROM} AND cord.order_date < ${MK_TO}
    ) u
    WHERE member_id IS NULL OR LTRIM(RTRIM(CAST(member_id AS NVARCHAR(50)))) = ''
  `);
  const guestCount = guestOrdersRes.recordset[0]?.guest_orders || 0;
  if (guestCount > 0) _signupCounts['비회원'] = guestCount;

  // 사이트 상관관계 (가입사이트 → 주문사이트 크로스탭)
  const siteCrossResult = await p.request().query(`
    WITH all_gift_orders AS (
      SELECT o.member_id, co.SALES_GUBUN, CONCAT('E', o.order_seq) AS order_key
      FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
      INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
      INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
      LEFT JOIN COMPANY co WITH (NOLOCK) ON o.company_Seq = co.COMPANY_SEQ
      WHERE ${D01_FILTER} AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 15)
        AND o.order_date >= ${MK_FROM} AND o.order_date < ${MK_TO}
      UNION ALL
      SELECT cord.member_id, comp.SALES_GUBUN, CONCAT('C', cord.order_seq) AS order_key
      FROM custom_order cord WITH (NOLOCK)
      INNER JOIN custom_order_item coi WITH (NOLOCK) ON cord.order_seq = coi.order_seq
      INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
      LEFT JOIN COMPANY comp WITH (NOLOCK) ON cord.company_Seq = comp.COMPANY_SEQ
      WHERE ${D01_FILTER} AND cord.status_seq >= 2 AND cord.status_seq NOT IN (3, 5, 9)
        AND cord.order_date >= ${MK_FROM} AND cord.order_date < ${MK_TO}
    ),
    referer_site AS (
      SELECT u.uid AS member_id, u.REFERER_SALES_GUBUN AS referer_sg
      FROM S2_UserInfo u WITH (NOLOCK)
      WHERE u.site_div = 'SB' AND u.USE_YORN = 'Y'
    )
    SELECT
      ISNULL(rs_si.SiteName, '기타') AS signup_site,
      ISNULL(os_si.SiteName, '기타') AS order_site,
      COUNT(DISTINCT ago.order_key) AS order_count
    FROM all_gift_orders ago
    LEFT JOIN SiteInfo os_si ON ago.SALES_GUBUN = os_si.SiteCode
    INNER JOIN referer_site rs ON ago.member_id = rs.member_id
    LEFT JOIN SiteInfo rs_si ON rs.referer_sg = rs_si.SiteCode
    GROUP BY ISNULL(rs_si.SiteName, '기타'), ISNULL(os_si.SiteName, '기타')
    ORDER BY order_count DESC
  `);

  return {
    memberSite: siteResult.recordset,
    signupSite: Object.entries(_signupCounts)
      .map(([signup_site, member_count]) => ({ signup_site, member_count }))
      .sort((a, b) => b.member_count - a.member_count),
    signupSiteMeta: {
      dearMyDearMatchedCount: _dmdMatchedCount,
      dearMyDearTotalSetSize: _dmdDupInfos.size,
      guestOrderCount: guestCount,
    },
    siteCross: siteCrossResult.recordset,
    period: `${mkStart} ~ ${mkEnd}`,
    mkStart, mkEnd,
  };
}

/** GET /api/dashboard/marketing/reorder — 재주문 분석 (12/24/48/72h 구간 + 간격 분포) */
async function apiMarketingReorder(query = {}) {
  const p = await getPool();
  const { mkStart, mkEnd, MK_FROM, MK_TO } = _validateMkPeriod(query);

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
      WHERE ${D01_FILTER} AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5, 9)
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
             SUM(o.settle_price) AS total_amount
      FROM distinct_orders o GROUP BY o.member_id
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
      INNER JOIN custom_order_item coi WITH (NOLOCK) ON coi.order_seq = co.order_seq
      INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
      WHERE ${D01_FILTER} AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5, 9)
        AND co.order_date >= ${MK_FROM} AND co.order_date < ${MK_TO}
    ),
    ordered AS (
      SELECT member_id, order_key, order_date,
             ROW_NUMBER() OVER (PARTITION BY member_id ORDER BY order_date) AS rn
      FROM distinct_orders
    ),
    reorder_gap AS (
      SELECT a.member_id, DATEDIFF(hour, a.order_date, b.order_date) AS gap_hours
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
    GROUP BY
      CASE
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

  return {
    reorder: reorderResult.recordset[0] || {},
    reorderInterval: reorderIntervalResult.recordset,
    period: `${mkStart} ~ ${mkEnd}`,
    mkStart, mkEnd,
  };
}

/** GET /api/dashboard/marketing/channel — 유입채널 분석 (mix + 주차별 트렌드) */
async function apiMarketingChannel(query = {}) {
  const p = await getPool();
  const { mkStart, mkEnd, MK_FROM, MK_TO } = _validateMkPeriod(query);

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
      WHERE ${D01_FILTER} AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5, 9)
        AND co.order_date >= ${MK_FROM} AND co.order_date < ${MK_TO}
    ) t GROUP BY channel ORDER BY revenue DESC
  `);

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
      WHERE ${D01_FILTER} AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5, 9)
        AND co.order_date >= ${MK_FROM} AND co.order_date < ${MK_TO}
    ) t
    GROUP BY CONVERT(varchar(10), DATEADD(week, DATEDIFF(week, 0, order_date), 0), 120), channel
    ORDER BY week_start, channel
  `);

  return {
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
    const handled = await handleBarungiftApi(pathname, req, res, parsed.query, { getPool, sql, session, isSuperAdmin });
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
  //   크론 자동수집 예외: 채널 sync 라우트(POST)는 유효한 API 키(Authorization: Bearer EXPORT_API_KEY)면
  //   세션 없이 허용. 외부 크론/스케줄러가 로그인 없이 15분 주기로 호출 가능.
  const isCronSyncPath = req.method === 'POST' && (
    pathname === '/api/cafe24/sync' ||
    pathname === '/api/naver/sync' ||
    pathname === '/api/coupang/sync'
  );
  //   컨테이너 내부 자기호출(재고 알림 스케줄러 등): 프로세스 랜덤 토큰이면 통과.
  const isInternalCall = req.headers['x-internal-token'] === INTERNAL_TOKEN;
  if (!session && !DEV_SKIP_AUTH && !isInternalCall && !(isCronSyncPath && validateApiKey(req))) {
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
      } else if (pathname === '/api/daeryepum-stock' && req.method === 'GET') {
        // 답례품 재고 조회 — S2_Card (D01 OR COM_%) + S2_CARD_ERP_STOCK 매칭.
        //   금액 (2026-07-07 변경):
        //     sales_amount_30d = 실 order 30일 매출 SUM(item_sale_price × item_count / Unit_Value)
        //     · S2_CARD_ERP_STOCK.TOTAL_SALE_PRICE_30_DAY 는 갱신 이상으로 실 판매의 0.001%
        //       수준 오차 발생 (운영팀 인지) → 자체 계산치로 대체.
        //     unit_price  = sales_amount_30d / sales_qty_30d (실판매 평균 단가; 프로모션/할인 반영)
        //     stock_value = available_qty × unit_price (재고 자산액)
        //   재고 수량 (INVENTORY_CURRENT_QTY / INVENTORY_AVAILABLE_QTY) 은 ERP 값 그대로 사용.
        //   상품명: 주문조회와 동일한 canonical name 로직 적용
        //     · DISPLAY_YORN='Y' 우선 → 프리픽스 없음 → 최신 Card_Seq
        //     · 이상 이름 필터: 빈 문자열/사용X/사용안함/삭제/테스트 제외
        //     · '[프리픽스]이름' 형태이면 첫 ']' 이후 문자열 반환
        //   Card_Code 별 dedup — 같은 Card_Code 여러 Card_Seq 있을 때 1행만 노출.
        try {
          // 대상 품목은 bg_stock_items 에 등록된 것만 (migration 044, 운영 결정 2026-08-05).
          //   자동 목록은 세트·스티커·부자재가 섞여 290개가 나왔고 ERP 의 상품구분이
          //   bar_shop1 에 없어 거를 수 없었다 → 운영이 직접 등록해 쓴다.
          const bgStore = require('./barungift/store');
          const regItems = await bgStore.listStockItems({ enabledOnly: true });
          if (!regItems.length) {
            data = {
              items: [],
              registered: 0,
              summary: { total: 0, with_stock: 0, soldout: 0, urgent_30d: 0, total_stock_value: 0, total_sales_30d: 0 },
            };
            res.end(JSON.stringify(data));
            return;
          }
          // SQL 인젝션 방지 — 코드에 허용되는 문자만 통과시킨다.
          const safe = c => String(c || '').trim().replace(/[^A-Za-z0-9_\-.]/g, '');
          // 재고코드 / 매출코드 분리 (운영 결정 2026-08-05)
          //   재고는 stock_code 로만 조회하고, 매출은 sales_codes 에 적힌 품목코드만 합산한다.
          //   자동 매핑을 쓰면 ERP코드-품목코드가 1:N 이라 의도치 않은 코드까지 섞인다.
          // BOM (migration 050) — 구성품코드별 [판매코드 × 소요수량].
          //   BOM 은 "판매상품 1개가 무엇으로 구성되나" 를 정의하고, 재고 소진은 거기서 파생된다.
          //   050 이전의 소진코드(bg_stock_items.consumption_codes)는 폐기 — BOM 이 유일한 기준.
          let bomByComponent = new Map();
          try {
            for (const b of await bgStore.listBomRows()) {
              const comp = safe(b.component_code);
              const parent = safe(b.parent_code);
              if (!comp || !parent) continue;
              if (!bomByComponent.has(comp)) bomByComponent.set(comp, []);
              bomByComponent.get(comp).push({
                code: parent,
                mult: Math.max(1, parseInt(b.qty, 10) || 1),
                role: b.component_role || 'material',
                bom_id: b.id || null,
                // 052 — 공용 판정은 판매코드 수가 아니라 그룹 수로 센다.
                //   변형코드(_A/_B/_C)는 같은 그룹이라 공용이 아니다.
                group_key: safe(b.group_key) || parent,
              });
            }
          } catch { /* 테이블 없으면 BOM 미적용 */ }

          // 소진 대상 = BOM 구성 + 직접판매.
          //   · BOM: 이 재고코드를 구성품으로 쓰는 판매코드 × 소요수량
          //   · 직접판매: BOM parent 에 없는 매출코드 × 1 (원물이 단독으로도 팔리는 경우)
          //   매출코드가 BOM parent 와 겹치면 BOM 수량을 쓴다 — 같은 판매를 두 번 세지 않는다.
          const regRows = regItems.map(it => {
            const sales = String(it.sales_codes || '').split(',').map(s => safe(s)).filter(Boolean);
            const stock = safe(it.stock_code);
            const bomRows = bomByComponent.get(stock) || [];
            const merged = new Map(bomRows.map(b => [b.code, b.mult]));
            for (const c of sales) if (!merged.has(c)) merged.set(c, 1);
            return {
              row: it, stock, sales,
              consume: [...merged.entries()].map(([code, mult]) => ({ code, mult })),
              consumeSource: bomRows.length ? 'bom' : 'sales',
            };
          }).filter(r => r.stock);
          const valuesClause = [...new Set(regRows.map(r => r.stock))].map(c => `('${c}')`).join(',');
          if (!valuesClause) {
            data = {
              items: [], registered: regItems.length,
              summary: { total: 0, with_stock: 0, soldout: 0, urgent_30d: 0, total_stock_value: 0, total_sales_30d: 0 },
            };
            res.end(JSON.stringify(data));
            return;
          }

          const p = await getPool();
          const [stockRes, salesRes, priceRes] = await Promise.all([
            p.request().query(`
              SELECT
                reg.stock_code,
                canon.canonical_name AS product_name,
                ISNULL(s.INVENTORY_CURRENT_QTY, 0) AS current_qty,
                ISNULL(s.INVENTORY_AVAILABLE_QTY, 0) AS available_qty,
                s.BRAND_NAME,
                s.CARD_SET_PRICE AS erp_price,
                s.CARD_CODE AS matched_card_code,
                s.CARD_CODE_ERP AS matched_erp_code,
                CASE WHEN s.CARD_CODE IS NULL THEN 0 ELSE 1 END AS has_erp_record,
                hint.suggested
              FROM (VALUES ${valuesClause}) AS reg(stock_code)
              -- 재고는 ERP코드(CARD_CODE_ERP)로만 조회한다.
              --   품목코드(CARD_CODE)까지 폴백 매칭하던 예전 로직은, 품목코드 하나에
              --   ERP코드가 여러 개 달린 경우 임의로 한 행을 골라 재고가 크게 달라졌다
              --   (TGJSD01O4_A → 4,466 vs 19,061). 답례품 품목코드 166개 중 29개가
              --   ERP코드가 아니어서 조용히 틀린 값이 나올 수 있었다. 2026-08-05 제거.
              --   같은 ERP코드에 행이 여럿이면(레거시/플레이스홀더는 수량 NULL·음수)
              --   유효수량 우선 → MOD_DATE 최신 1행 채택.
              OUTER APPLY (
                SELECT TOP 1 s2.CARD_CODE, s2.CARD_CODE_ERP, s2.INVENTORY_CURRENT_QTY,
                       s2.INVENTORY_AVAILABLE_QTY, s2.BRAND_NAME, s2.CARD_SET_PRICE
                FROM S2_CARD_ERP_STOCK s2 WITH (NOLOCK)
                WHERE s2.CARD_CODE_ERP = reg.stock_code
                ORDER BY
                  CASE WHEN s2.INVENTORY_CURRENT_QTY IS NOT NULL
                        AND s2.INVENTORY_CURRENT_QTY >= 0 THEN 0 ELSE 1 END,
                  s2.MOD_DATE DESC
              ) s
              -- 못 찾았을 때: 입력값이 품목코드라면 올바른 ERP코드 후보를 알려준다.
              OUTER APPLY (
                SELECT STRING_AGG(CONVERT(nvarchar(max), x.CARD_CODE_ERP), ', ') AS suggested
                FROM (SELECT DISTINCT s3.CARD_CODE_ERP FROM S2_CARD_ERP_STOCK s3 WITH (NOLOCK)
                      WHERE s3.CARD_CODE = reg.stock_code
                        AND ISNULL(s3.CARD_CODE_ERP, '') <> '') x
              ) hint
              -- 상품명은 재고 매칭된 품목코드 기준 (매출코드는 여러 개일 수 있어 JS 에서 보정)
              OUTER APPLY (
                SELECT TOP 1
                  CASE
                    WHEN c2.Card_Name LIKE '[[]%[]]%'
                      THEN LTRIM(SUBSTRING(c2.Card_Name, CHARINDEX(']', c2.Card_Name) + 1, LEN(c2.Card_Name)))
                    ELSE c2.Card_Name
                  END AS canonical_name
                FROM S2_Card c2 WITH (NOLOCK)
                WHERE c2.Card_Code = ISNULL(s.CARD_CODE, reg.stock_code)
                  AND LTRIM(RTRIM(ISNULL(c2.Card_Name, ''))) <> ''
                  AND c2.Card_Name NOT LIKE '%사용X%'
                  AND c2.Card_Name NOT LIKE '%사용안함%'
                  AND c2.Card_Name NOT LIKE '%삭제%'
                  AND c2.Card_Name NOT LIKE '%테스트%'
                ORDER BY
                  CASE WHEN c2.DISPLAY_YORN = 'Y' THEN 0 ELSE 1 END,
                  CASE WHEN c2.Card_Name LIKE '[[]%' THEN 1 ELSE 0 END,
                  c2.Card_Seq DESC
              ) canon
            `),
            p.request().query(`
              -- 실 order 30일 매출/수량 집계 (Card_Code 단위).
              --   D01 답례품: item_sale_price × item_count / Unit_Value (묶음 단위 가격 대응)
              --   결제완료 상태만 (CARD: status_seq NOT IN 3,5,9 / ETC: NOT IN 3,5,15)
              --   S2_CARD_ERP_STOCK.TOTAL_SALE_PRICE_30_DAY 는 갱신 이상으로 미사용.
              -- qty_paid / revenue_paid: 결제금액이 0 인 라인을 뺀 집계.
              --   세트로 팔린 건은 구성품이 0원 라인으로 들어와, 그대로 평균 내면 단가가 무너진다
              --   (TGJBK09O7_A: 0원 + 9,900원 → 4,950원 = 정확히 절반). 실판매 단가는 이 값으로 계산.
              SELECT card_code,
                     SUM(qty) AS qty_30d,
                     SUM(revenue) AS revenue_30d,
                     SUM(CASE WHEN revenue > 0 THEN qty ELSE 0 END) AS qty_paid,
                     SUM(CASE WHEN revenue > 0 THEN revenue ELSE 0 END) AS revenue_paid
              FROM (
                SELECT c.Card_Code AS card_code,
                       coi.item_count AS qty,
                       CAST(coi.item_sale_price AS float) * coi.item_count
                         / ISNULL(NULLIF(c.Unit_Value, 0), 1) AS revenue
                FROM custom_order co WITH (NOLOCK)
                INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
                INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
                WHERE (c.Card_Div = 'D01' OR c.Card_Code LIKE 'COM[_]%')
                  AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5, 9)
                  AND co.settle_date >= DATEADD(day, -30, GETDATE())
                UNION ALL
                -- ETC 는 card_sale_price 의 의미가 매출처마다 다르다 (앱 공통 규칙, etcAmountExpr 참조).
                --   바른손카드 (SiteInfo 매칭)  : 이미 라인 총액 → 그대로
                --   바른손몰   (제휴사, 미매칭) : 단가 → × 수량 / Unit_Value
                -- 이 분기가 빠져 있어 총액에 수량을 또 곱했고, 단가가 실제의 100배 넘게 부풀었다
                -- (알뮤터 7,899원 → 1,237,254원). 재고 자산·30일 매출액도 같이 틀어짐. 2026-08-04 수정.
                SELECT c.Card_Code,
                       oi.order_count,
                       CASE WHEN si.SiteName IS NULL
                            THEN CAST(oi.card_sale_price AS float) * oi.order_count
                                 / ISNULL(NULLIF(c.Unit_Value, 0), 1)
                            ELSE CAST(oi.card_sale_price AS float)
                       END AS revenue
                FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
                INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
                INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
                LEFT JOIN SiteInfo si WITH (NOLOCK) ON o.company_Seq = si.CompayCode
                WHERE (c.Card_Div = 'D01' OR c.Card_Code LIKE 'COM[_]%')
                  AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 15)
                  AND o.settle_date >= DATEADD(day, -30, GETDATE())
              ) AS all_sales
              GROUP BY card_code
            `),
            // 현재 판매가 — 품목코드별 '가장 최근' 실판매 단가 (0원 라인 제외).
            //   30일 가중평균은 판매가 변경 전후가 섞여 현재가를 못 나타낸다.
            //   최근 1년까지 훑어 최신 1건을 취한다 (30일 54개 → 365일 68개 커버).
            p.request().query(`
              SELECT card_code, unit_price, settle_date
              FROM (
                SELECT card_code, unit_price, settle_date,
                       ROW_NUMBER() OVER (PARTITION BY card_code ORDER BY settle_date DESC) AS rn
                FROM (
                  SELECT c.Card_Code AS card_code, co.settle_date,
                         ROUND(CAST(coi.item_sale_price AS float)
                               / ISNULL(NULLIF(c.Unit_Value, 0), 1), 0) AS unit_price
                  FROM custom_order co WITH (NOLOCK)
                  INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
                  INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
                  WHERE (c.Card_Div = 'D01' OR c.Card_Code LIKE 'COM[_]%')
                    AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5, 9)
                    AND co.settle_date >= DATEADD(day, -365, GETDATE())
                    AND coi.item_sale_price > 0
                  UNION ALL
                  SELECT c.Card_Code, o.settle_date,
                         ROUND(CASE WHEN si.SiteName IS NULL
                                    THEN CAST(oi.card_sale_price AS float) / ISNULL(NULLIF(c.Unit_Value, 0), 1)
                                    ELSE CAST(oi.card_sale_price AS float) / NULLIF(oi.order_count, 0)
                               END, 0)
                  FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
                  INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
                  INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
                  LEFT JOIN SiteInfo si WITH (NOLOCK) ON o.company_Seq = si.CompayCode
                  WHERE (c.Card_Div = 'D01' OR c.Card_Code LIKE 'COM[_]%')
                    AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 15)
                    AND o.settle_date >= DATEADD(day, -365, GETDATE())
                    AND oi.card_sale_price > 0
                ) AS lines
              ) AS ranked
              WHERE rn = 1
            `)
          ]);
          // 매출·소진코드 검증 — 이 둘은 '품목코드(S2_Card.Card_Code)' 기준인데
          //   재고코드는 ERP코드라 헷갈리기 쉽다. ERP코드를 넣으면 매칭되는 판매가 없어
          //   조용히 0 으로 잡히므로, 존재하지 않는 코드를 찾아 알려준다.
          const refCodes = [...new Set(regRows.flatMap(r => [...r.sales, ...r.consume.map(c => c.code)]))];
          const codeIssues = new Map();   // code → 'erp' | 'unknown'
          const codeNames = new Map();    // code → Card_Name (그룹 헤더에 상품명 표시용)
          if (refCodes.length) {
            const inList = refCodes.map(c => `'${c}'`).join(',');
            const chk = await p.request().query(`
              SELECT v.code,
                     CASE WHEN EXISTS (SELECT 1 FROM S2_Card c WITH (NOLOCK) WHERE c.Card_Code = v.code)
                          THEN 1 ELSE 0 END AS is_card,
                     CASE WHEN EXISTS (SELECT 1 FROM S2_CARD_ERP_STOCK s WITH (NOLOCK)
                                       WHERE s.CARD_CODE_ERP = v.code) THEN 1 ELSE 0 END AS is_erp,
                     (SELECT TOP 1 c2.Card_Name FROM S2_Card c2 WITH (NOLOCK)
                      WHERE c2.Card_Code = v.code) AS card_name
              FROM (VALUES ${refCodes.map(c => `('${c}')`).join(',')}) AS v(code)
              WHERE v.code IN (${inList})
            `);
            for (const row of (chk.recordset || [])) {
              if (row.card_name) codeNames.set(row.code, row.card_name);
              if (row.is_card) continue;
              codeIssues.set(row.code, row.is_erp ? 'erp' : 'unknown');
            }
          }

          // XERP 원본 재고 (MF01) — bar_shop1 복제본에 빠진 품목도 여기서 잡힌다.
          //   실패해도 화면이 죽지 않도록 폴백 (bar_shop1 값 사용).
          const xerpQty = new Map();
          let xerpError = null;
          try {
            const xp = await getXerpPool();
            const codes = [...new Set(regRows.map(r => r.stock))];
            const xr = await xp.request().query(`
                SELECT LTRIM(RTRIM(ItemCode)) AS item_code,
                       SUM(OhQty) AS qty,
                       STRING_AGG(CONVERT(nvarchar(max),
                         LTRIM(RTRIM(WhCode)) + ':' + CONVERT(varchar(20), OhQty)), ' / ') AS breakdown
                FROM mmInventory WITH (NOLOCK)
                WHERE LTRIM(RTRIM(WhCode)) IN (${XERP_WAREHOUSES.map(w => `'${w}'`).join(',')})
                  AND LTRIM(RTRIM(ItemCode)) IN (${codes.map(c => `'${c}'`).join(',')})
                GROUP BY LTRIM(RTRIM(ItemCode))
              `);
            for (const row of (xr.recordset || [])) {
              xerpQty.set(row.item_code, { qty: Number(row.qty) || 0, breakdown: row.breakdown || '' });
            }
          } catch (e) {
            xerpError = e.message;
            console.error('[daeryepum-stock] XERP 조회 실패 — bar_shop1 값 사용:', e.message);
          }

          // 품목코드 → 가장 최근 판매 단가
          const latestPriceMap = new Map();
          for (const r of (priceRes.recordset || [])) {
            const price = Math.round(Number(r.unit_price) || 0);
            if (price > 0) latestPriceMap.set(r.card_code, { price, date: r.settle_date });
          }

          const salesMap = new Map();
          for (const r of (salesRes.recordset || [])) {
            salesMap.set(r.card_code, {
              qty: Number(r.qty_30d) || 0,
              revenue: Math.round(Number(r.revenue_30d) || 0),
              qtyPaid: Number(r.qty_paid) || 0,
              revenuePaid: Math.round(Number(r.revenue_paid) || 0),
            });
          }
          const regByCode = new Map(regRows.map(r => [r.stock, r]));
          // 매출은 등록된 매출코드만 합산한다.
          //   같은 매출코드를 두 품목에 걸어 두면 합계(summary)가 이중계상되므로
          //   합계는 코드 dedup 후 계산한다 (행 단위로는 각각 그대로 표시).
          const countedCodes = new Set();
          let dedupSales30d = 0;
          // 로켓창고(쿠팡 물류센터) 재고 — 저장된 스냅샷을 판매코드 단위로 붙인다 (061).
          //   API 를 여기서 부르지 않는다: 페이징 + 분당 50회 제한이라 화면 로드마다 때리면 막힌다.
          //   스냅샷이 없거나 실패해도 재고 화면은 그대로 떠야 한다.
          let cpInvByCode = new Map();
          try {
            cpInvByCode = await require('./coupang/rg-inventory').getInventoryByProductCode();
          } catch (e) {
            console.warn('[stock] 로켓창고 재고 조회 실패 (자사 재고만 표시):', e.message);
          }
          const items = (stockRes.recordset || []).map(r => {
            const regRow = regByCode.get(r.stock_code) || { row: {}, sales: [], consume: [], consumeSource: 'sales' };
            const reg = regRow.row || {};
            const cardCodes = regRow.sales || [];
            const salesRec = cardCodes.reduce((acc, cc) => {
              const s = salesMap.get(cc);
              if (!s) return acc;
              if (!countedCodes.has(cc)) { countedCodes.add(cc); dedupSales30d += s.revenue; }
              return {
                qty: acc.qty + s.qty,
                revenue: acc.revenue + s.revenue,
                qtyPaid: acc.qtyPaid + s.qtyPaid,
                revenuePaid: acc.revenuePaid + s.revenuePaid,
              };
            }, { qty: 0, revenue: 0, qtyPaid: 0, revenuePaid: 0 });
            const qty30 = salesRec.qty;
            const salesAmount30d = salesRec.revenue;

            // 소진 수량 — 재고가 실제로 빠지는 양. 매출과 분리해서 센다.
            //   한 원물이 여러 세트로도 팔리고(주방세제: 단독 144 vs 실소비 329),
            //   세트 1개에 원물이 여러 개 들어가기도 한다(데일리너츠 ×5).
            //   일평균·소진예상은 이 값 기준. 매출액·실판매가는 매출코드 기준 유지.
            const consumeQty30d = (regRow.consume || []).reduce((sum, c) => {
              const s = salesMap.get(c.code);
              return sum + (s ? s.qty * c.mult : 0);
            }, 0);

            // 재고는 XERP 원본(MF01) 우선, 없으면 bar_shop1 복제본
            const xrec = xerpQty.get(r.stock_code);
            const hasXerp = !!xrec;
            const currentQty = hasXerp ? xrec.qty : (Number(r.current_qty) || 0);
            const availableQty = hasXerp ? xrec.qty : (Number(r.available_qty) || 0);

            const dailyAvg = consumeQty30d / 30;
            const daysLeft = (dailyAvg > 0 && availableQty > 0)
              ? Math.round(availableQty / dailyAvg)
              : null;

            // 판매가 = 현재 판매가 (운영 요청 2026-08-05).
            //   정가(ERP CARD_SET_PRICE)도, 30일 가중평균도 아니다.
            //   판매가는 하나이고 바뀔 뿐이라, 매출코드 중 '가장 최근 판매' 의 단가를 쓴다.
            //   (평균을 쓰면 변경 전후가 섞이고, 0원 세트 라인이 끼면 반토막 났다)
            let salePrice = null, salePriceDate = null;
            for (const cc of cardCodes) {
              const lp = latestPriceMap.get(cc);
              if (!lp) continue;
              if (!salePriceDate || lp.date > salePriceDate) {
                salePrice = lp.price;
                salePriceDate = lp.date;
              }
            }
            const stockValue = salePrice !== null ? Math.round(salePrice * availableQty) : null;
            return {
              stock_code: r.stock_code,          // 재고 조회 코드
              sales_codes: cardCodes,            // 매출 조회 코드 (등록값 그대로)
              // 소진 기준 — 저장값이 아니라 BOM + 매출코드에서 파생된 결과 (050)
              consume_codes: (regRow.consume || []).map(c => ({ code: c.code, mult: c.mult })),
              consume_source: regRow.consumeSource,           // 'bom' | 'sales'
              // 이 재고품목이 구성품으로 들어가는 판매상품들 — 재고 목록의 상품 그룹 헤더용.
              //   한 원물이 여러 세트에 쓰이면 그룹이 여러 개가 되고, 목록에서 각 그룹에 표시된다.
              bom_parents: (bomByComponent.get(r.stock_code) || []).map(b => ({
                code: b.code,
                name: codeNames.get(b.code) || null,
                qty: b.mult,
                role: b.role,
                bom_id: b.bom_id,
                group_key: b.group_key,
                sales_qty_30d: salesMap.get(b.code)?.qty || 0,
              })),
              // 이 재고품목이 들어가는 '상품 그룹' 수 — 2 이상이면 공용 자재
              bom_group_count: new Set((bomByComponent.get(r.stock_code) || []).map(b => b.group_key)).size,
              consume_qty_30d: consumeQty30d,    // 재고 소진 수량 (배수 반영)
              // 품목코드가 아닌 값이 매출·소진코드에 들어간 경우 (조용히 0 이 되는 것 방지)
              bad_codes: [...new Set([...cardCodes, ...(regRow.consume || []).map(c => c.code)])]
                .filter(c => codeIssues.has(c))
                .map(c => ({ code: c, kind: codeIssues.get(c) })),
              product_name: reg.label || r.product_name || '',
              is_com: cardCodes.some(c => c.startsWith('COM_')) || String(r.stock_code || '').startsWith('COM_'),
              current_qty: currentQty,
              available_qty: availableQty,
              stock_source: hasXerp ? 'xerp' : 'bar_shop1',
              // 로켓창고 재고 — 이 품목이 소진되는 판매코드들의 쿠팡 창고 수량 합 (061).
              //   coupang_qty 는 판매코드 개수(= 옵션수량 × 채널 판매단위).
              //   구성품 행이면 소요수량(mult)을 곱해 '원물 상당량' 도 함께 낸다.
              coupang_stock: (() => {
                const codes = (regRow.consume || []).length ? regRow.consume : cardCodes.map(c => ({ code: c, mult: 1 }));
                const detail = [];
                let qty = 0, componentQty = 0, syncedAt = null;
                for (const c of codes) {
                  const inv = cpInvByCode.get(c.code);
                  if (!inv) continue;
                  qty += inv.item_qty;
                  componentQty += inv.item_qty * (c.mult || 1);
                  if (!syncedAt || (inv.synced_at && inv.synced_at > syncedAt)) syncedAt = inv.synced_at;
                  detail.push({ code: c.code, qty: inv.item_qty, options: inv.options, unit: inv.unit, mult: c.mult || 1 });
                }
                return detail.length ? { qty, component_qty: componentQty, synced_at: syncedAt, detail } : null;
              })(),
              stock_breakdown: hasXerp ? xrec.breakdown : null,   // 창고별 내역
              sale_price: salePrice,          // 현재 판매가 = 가장 최근 실판매 단가
              sale_price_date: salePriceDate,  // 그 판매가가 적용된 최근 판매일
              stock_value: stockValue,        // 가용재고 × 현재 판매가
              sales_amount_30d: salesAmount30d,
              sales_qty_30d: qty30,
              daily_avg_30d: Math.round(dailyAvg * 100) / 100,
              days_to_soldout: daysLeft,
              brand_name: r.BRAND_NAME || null,
              // 등록 정보 — 관리 화면에서 수정/삭제할 수 있도록 함께 내려준다.
              item_id: reg.id || null,
              matched_card_code: r.matched_card_code || null,
              matched_erp_code: r.matched_erp_code || null,
              stock_found: hasXerp || !!r.has_erp_record,   // 재고코드로 재고를 못 찾으면 false
              // 못 찾은 경우, 입력값이 품목코드였다면 올바른 ERP코드 후보
              suggested_erp_codes: r.suggested
                ? String(r.suggested).split(',').map(s => s.trim()).filter(Boolean)
                : [],
              threshold: reg.threshold ?? null,
              alert_enabled: reg.alert_enabled !== false,
            };
          }).sort((a, b) => (a.days_to_soldout ?? 99999) - (b.days_to_soldout ?? 99999));
          data = {
            items,
            registered: regItems.length,
            stock_warehouse: XERP_WAREHOUSE,
            xerp_error: xerpError,
            summary: {
              total: items.length,
              from_xerp: items.filter(x => x.stock_source === 'xerp').length,
              not_found: items.filter(x => !x.stock_found).length,
              with_stock: items.filter(x => x.available_qty > 0).length,
              soldout: items.filter(x => x.available_qty <= 0).length,
              urgent_30d: items.filter(x => x.days_to_soldout !== null && x.days_to_soldout <= 30).length,
              total_stock_value: items.reduce((s, x) => s + (Number(x.stock_value) || 0), 0),
              // 품목코드 dedup 후 합계 — 한 품목코드가 두 ERP코드에 걸려도 이중계상 안 됨
              total_sales_30d: dedupSales30d,
              // 로켓창고 재고가 붙은 품목 수 — 0 이면 아직 동기화 전이거나 매핑이 없다
              coupang_tracked: items.filter(x => x.coupang_stock).length,
              coupang_synced_at: items.reduce((a, x) => {
                const t = x.coupang_stock?.synced_at;
                return (t && (!a || t > a)) ? t : a;
              }, null)
            }
          };
        } catch (e) {
          data = { error: e.message, items: [], summary: {} };
        }
      } else if (pathname === '/api/daeryepum-stock/erp-items' && req.method === 'GET') {
        // XERP 품목 검색 — BOM/품목 등록에서 ERP 원본 품목을 고르기 위한 용도.
        //   bar_shop1 동기화에 빠진 품목도 여기서는 잡힌다.
        try {
          const q = String(parsed.query.q || '').trim();
          if (q.length < 2) { data = { results: [], hint: '2자 이상 입력' }; }
          else {
            const xp = await getXerpPool();
            const r = await xp.request()
              .input('q', sql.NVarChar, `%${q}%`)
              .query(`
                SELECT TOP 50
                  LTRIM(RTRIM(ItemCode)) AS item_code,
                  SUM(OhQty)   AS qty,
                  SUM(OhAmnt)  AS amount,
                  COUNT(*)     AS rows_
                FROM mmInventory WITH (NOLOCK)
                WHERE LTRIM(RTRIM(WhCode)) IN (${XERP_WAREHOUSES.map(w => `'${w}'`).join(',')}) AND ItemCode LIKE @q
                GROUP BY LTRIM(RTRIM(ItemCode))
                ORDER BY SUM(OhQty) DESC, LTRIM(RTRIM(ItemCode))
              `);
            data = { results: r.recordset || [], warehouse: XERP_WAREHOUSE };
          }
        } catch (e) {
          data = { error: e.message, results: [] };
        }
      } else if (pathname === '/api/daeryepum-stock/lookup' && req.method === 'GET') {
        // 품목 등록용 코드 조회 — 코드/상품명 일부로 ERP 재고 + S2_Card 상품명을 찾는다.
        //   등록 화면에서 "이 코드로 재고가 잡히는지" 를 저장 전에 확인하기 위한 용도.
        //   CARD_CODE 와 CARD_CODE_ERP 를 모두 훑는다 (품목마다 잡히는 쪽이 다름).
        try {
          const q = String(parsed.query.q || '').trim();
          if (q.length < 2) { data = { results: [], hint: '2자 이상 입력' }; }
          else {
            const p = await getPool();
            const r = await p.request()
              .input('q', sql.NVarChar, `%${q}%`)
              .query(`
                -- 등록 단위가 ERP코드이므로 ERP코드로 묶어서 반환한다.
                SELECT TOP 50
                  m.CARD_CODE_ERP AS erp_code,
                  m.card_codes,
                  m.card_type, m.brand, m.price,
                  m.current_qty, m.available_qty, m.mod_date,
                  nm.canonical_name AS product_name
                FROM (
                  SELECT s.CARD_CODE_ERP,
                         STRING_AGG(CONVERT(nvarchar(max), s.CARD_CODE), ', ') AS card_codes,
                         MAX(s.CARD_TYPE_NAME) AS card_type,
                         MAX(s.BRAND_NAME)     AS brand,
                         MAX(s.CARD_SET_PRICE) AS price,
                         MAX(s.INVENTORY_CURRENT_QTY)   AS current_qty,
                         MAX(s.INVENTORY_AVAILABLE_QTY) AS available_qty,
                         CONVERT(varchar(10), MAX(s.MOD_DATE), 120) AS mod_date
                  FROM S2_CARD_ERP_STOCK s WITH (NOLOCK)
                  WHERE ISNULL(s.CARD_CODE_ERP, '') <> ''
                    AND ISNULL(s.BRAND_NAME, '') NOT IN (N'기타', N'바른손카드')
                    AND (s.CARD_CODE LIKE @q OR s.CARD_CODE_ERP LIKE @q
                         OR EXISTS (SELECT 1 FROM S2_Card c1 WITH (NOLOCK)
                                    WHERE c1.Card_Code = s.CARD_CODE AND c1.Card_Name LIKE @q))
                  GROUP BY s.CARD_CODE_ERP
                ) m
                OUTER APPLY (
                  SELECT TOP 1
                    CASE WHEN c2.Card_Name LIKE '[[]%[]]%'
                      THEN LTRIM(SUBSTRING(c2.Card_Name, CHARINDEX(']', c2.Card_Name) + 1, LEN(c2.Card_Name)))
                      ELSE c2.Card_Name END AS canonical_name
                  FROM S2_Card c2 WITH (NOLOCK)
                  WHERE c2.Card_Code IN (SELECT s5.CARD_CODE FROM S2_CARD_ERP_STOCK s5 WITH (NOLOCK)
                                         WHERE s5.CARD_CODE_ERP = m.CARD_CODE_ERP)
                    AND LTRIM(RTRIM(ISNULL(c2.Card_Name, ''))) <> ''
                  ORDER BY CASE WHEN c2.DISPLAY_YORN = 'Y' THEN 0 ELSE 1 END, c2.Card_Seq DESC
                ) nm
                ORDER BY
                  CASE WHEN m.card_type = N'답례품' THEN 0 ELSE 1 END,
                  CASE WHEN m.available_qty > 0 THEN 0 ELSE 1 END,
                  m.CARD_CODE_ERP
              `);
            data = { results: r.recordset || [] };
          }
        } catch (e) {
          data = { error: e.message, results: [] };
        }
      } else if (pathname === '/api/daeryepum-stock-verify' && req.method === 'GET') {
        // 재고 데이터 검증 — S2_CARD_ERP_STOCK 저장값 vs 실 order 계산치 대조.
        //   1) 테이블 스키마 dump (컬럼 리스트 + 데이터 타입)
        //   2) 상위 SKU (매출액 큰 순) 30개에 대해:
        //      ERP TOTAL_SALE_PRICE_30_DAY (저장값)
        //      실 30일 매출 계산치 (custom_order + CUSTOM_ETC_ORDER, settle_date 기준, 결제완료만)
        //      편차 % = (ERP - 실계산) / max(실계산, 1) × 100
        //   3) 편차 큰 순으로 정렬해 문제 SKU 우선 노출
        //   ?code=CARD_CODE 지정 시 해당 SKU 만 상세 조회
        const specificCode = String(parsed.query.code || '').trim();
        const limit = Math.max(5, Math.min(200, parseInt(parsed.query.limit) || 30));
        try {
          const p = await getPool();
          const req0 = p.request();
          req0.timeout = 120000;
          // 1) 스키마
          const schemaRes = await req0.query(`
            SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE
            FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_NAME = 'S2_CARD_ERP_STOCK'
            ORDER BY ORDINAL_POSITION
          `);
          const schema_columns = (schemaRes.recordset || []).map(c => ({
            name: c.COLUMN_NAME, type: c.DATA_TYPE, nullable: c.IS_NULLABLE
          }));

          // 2) SKU 후보 (답례품 카테고리 + 재고 존재 or 매출 존재)
          const codeFilter = specificCode
            ? `AND s.CARD_CODE = '${specificCode.replace(/'/g, "''")}'`
            : '';
          const req1 = p.request();
          req1.timeout = 120000;
          // canonical name + Card_Code 단위 dedup — LEFT JOIN 대신 OUTER APPLY 로 대표 이름 1개만.
          const skusRes = await req1.query(`
            SELECT TOP ${specificCode ? 5 : limit}
              s.CARD_CODE AS card_code,
              canon.canonical_name AS card_name,
              canon.card_div AS card_div,
              ISNULL(s.INVENTORY_CURRENT_QTY, 0) AS current_qty,
              ISNULL(s.INVENTORY_AVAILABLE_QTY, 0) AS available_qty,
              ISNULL(s.TOTAL_SALE_PRICE_30_DAY, 0) AS erp_sales_30d
            FROM S2_CARD_ERP_STOCK s WITH (NOLOCK)
            OUTER APPLY (
              SELECT TOP 1
                CASE
                  WHEN c2.Card_Name LIKE '[[]%[]]%'
                    THEN LTRIM(SUBSTRING(c2.Card_Name, CHARINDEX(']', c2.Card_Name) + 1, LEN(c2.Card_Name)))
                  ELSE c2.Card_Name
                END AS canonical_name,
                c2.Card_Div AS card_div
              FROM S2_Card c2 WITH (NOLOCK)
              WHERE c2.Card_Code = s.CARD_CODE
                AND LTRIM(RTRIM(ISNULL(c2.Card_Name, ''))) <> ''
                AND c2.Card_Name NOT LIKE '%사용X%'
                AND c2.Card_Name NOT LIKE '%사용안함%'
                AND c2.Card_Name NOT LIKE '%삭제%'
                AND c2.Card_Name NOT LIKE '%테스트%'
              ORDER BY
                CASE WHEN c2.DISPLAY_YORN = 'Y' THEN 0 ELSE 1 END,
                CASE WHEN c2.Card_Name LIKE '[[]%' THEN 1 ELSE 0 END,
                c2.Card_Seq DESC
            ) canon
            WHERE (canon.card_div = 'D01' OR s.CARD_CODE LIKE 'COM[_]%')
              ${codeFilter}
            ORDER BY ISNULL(s.TOTAL_SALE_PRICE_30_DAY, 0) DESC
          `);
          const skus = skusRes.recordset || [];
          const codes = skus.map(r => r.card_code).filter(Boolean);

          // 3) 각 SKU 의 실 30일 매출/수량 계산 (settle_date 기준, 결제완료 상태만)
          let actualByCode = new Map();
          if (codes.length) {
            const codeList = codes.map(c => `'${c.replace(/'/g, "''")}'`).join(',');
            const req2 = p.request();
            req2.timeout = 120000;
            const actualRes = await req2.query(`
              SELECT card_code, SUM(revenue) AS actual_sales, SUM(qty) AS actual_qty
              FROM (
                -- CARD (custom_order)
                SELECT c.Card_Code AS card_code,
                       CAST(coi.item_sale_price AS float) * coi.item_count / ISNULL(NULLIF(c.Unit_Value, 0), 1) AS revenue,
                       coi.item_count AS qty
                FROM custom_order co WITH (NOLOCK)
                INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
                INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
                WHERE c.Card_Code IN (${codeList})
                  AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5, 9)
                  AND co.settle_date >= DATEADD(day, -30, GETDATE())
                UNION ALL
                -- ETC (CUSTOM_ETC_ORDER)
                SELECT c.Card_Code,
                       CAST(oi.card_sale_price AS float) * oi.order_count / ISNULL(NULLIF(c.Unit_Value, 0), 1) AS revenue,
                       oi.order_count
                FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
                INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
                INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
                WHERE c.Card_Code IN (${codeList})
                  AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 15)
                  AND o.settle_date >= DATEADD(day, -30, GETDATE())
              ) t
              GROUP BY card_code
            `);
            (actualRes.recordset || []).forEach(r => {
              actualByCode.set(r.card_code, {
                actual_sales: Math.round(Number(r.actual_sales) || 0),
                actual_qty: Number(r.actual_qty) || 0
              });
            });
          }

          // 4) 대조 결과
          const rows = skus.map(s => {
            const actual = actualByCode.get(s.card_code) || { actual_sales: 0, actual_qty: 0 };
            const erp = Number(s.erp_sales_30d) || 0;
            const diff = erp - actual.actual_sales;
            const diffPct = actual.actual_sales > 0
              ? Math.round(diff / actual.actual_sales * 1000) / 10  // 0.1% 단위
              : (erp > 0 ? 999 : 0);
            return {
              card_code: s.card_code,
              card_name: s.card_name || '',
              card_div: s.card_div,
              current_qty: s.current_qty,
              available_qty: s.available_qty,
              erp_sales_30d: erp,
              actual_sales_30d: actual.actual_sales,
              actual_qty_30d: actual.actual_qty,
              diff_amount: diff,
              diff_pct: diffPct,
              status: Math.abs(diffPct) < 10 ? 'OK'
                    : Math.abs(diffPct) < 30 ? 'WARN'
                    : 'MISMATCH'
            };
          }).sort((a, b) => Math.abs(b.diff_pct) - Math.abs(a.diff_pct));

          data = {
            filter: { code: specificCode || null, limit },
            schema_columns,
            total_checked: rows.length,
            summary: {
              ok: rows.filter(r => r.status === 'OK').length,
              warn: rows.filter(r => r.status === 'WARN').length,
              mismatch: rows.filter(r => r.status === 'MISMATCH').length
            },
            hint: 'diff_pct: (ERP - 실계산) / 실계산 %. 10% 이내 OK / 30% 이내 WARN / 30% 초과 MISMATCH.',
            rows
          };
        } catch (e) {
          data = { error: e.message };
        }
      } else if (pathname === '/api/artists/preview' && req.method === 'GET') {
        // Phase 1 — 작가/품목 시드 데이터 read-only 미리보기.
        //   bg_artist_products + bg_artists join (artist_id FK).
        try {
          const supaUrl = `${SUPABASE_URL}/rest/v1/bg_artist_products?select=product_code,product_name,category,bg_artists(name,commission_rate)&order=category.asc,product_code.asc`;
          const r = await fetch(supaUrl, {
            headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
          });
          const items = await r.json();
          if (!r.ok) {
            data = { error: items?.message || 'Supabase 조회 실패', items: [] };
          } else {
            data = {
              items: (Array.isArray(items) ? items : []).map(it => ({
                category: it.category || '',
                product_code: it.product_code || '',
                product_name: it.product_name || '',
                artist_name: it.bg_artists?.name || '',
                commission_rate: it.bg_artists?.commission_rate || 0
              }))
            };
          }
        } catch (e) {
          data = { error: e.message, items: [] };
        }
      } else if (pathname === '/api/artists' && req.method === 'GET') {
        // 작가 목록 (활성/비활성 전체) + 품목 수
        try {
          const r = await fetch(`${SUPABASE_URL}/rest/v1/bg_artists?select=id,name,commission_rate,is_active,memo,bg_artist_products(id)&order=name.asc`, {
            headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
          });
          const arr = await r.json();
          if (!r.ok) {
            data = { error: arr?.message || 'Supabase 조회 실패', items: [] };
          } else {
            data = {
              items: (Array.isArray(arr) ? arr : []).map(a => ({
                id: a.id, name: a.name, commission_rate: Number(a.commission_rate || 0),
                is_active: !!a.is_active, memo: a.memo || '',
                product_count: Array.isArray(a.bg_artist_products) ? a.bg_artist_products.length : 0
              }))
            };
          }
        } catch (e) { data = { error: e.message, items: [] }; }
      } else if (pathname === '/api/artists' && req.method === 'POST') {
        // 작가 신규 생성
        const body = await new Promise((resolve) => {
          let raw=''; req.on('data', c=>raw+=c);
          req.on('end', () => { try { resolve(raw?JSON.parse(raw):{}); } catch { resolve({}); } });
        });
        const name = String(body.name || '').trim();
        const rate = Number(body.commission_rate);
        if (!name || !Number.isFinite(rate) || rate < 0 || rate > 100) {
          data = { error: '이름 + 0~100 수수료율 필수' };
        } else {
          try {
            const r = await fetch(`${SUPABASE_URL}/rest/v1/bg_artists`, {
              method: 'POST',
              headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type':'application/json', Prefer:'return=representation' },
              body: JSON.stringify({ name, commission_rate: rate, memo: body.memo || null })
            });
            const j = await r.json();
            if (!r.ok) data = { error: j?.message || '작가 추가 실패' };
            else data = { ok: true, item: Array.isArray(j) ? j[0] : j };
          } catch (e) { data = { error: e.message }; }
        }
      } else if (pathname.match(/^\/api\/artists\/[a-f0-9-]+$/) && req.method === 'PATCH') {
        const id = pathname.split('/').pop();
        const body = await new Promise((resolve) => {
          let raw=''; req.on('data', c=>raw+=c);
          req.on('end', () => { try { resolve(raw?JSON.parse(raw):{}); } catch { resolve({}); } });
        });
        const patch = {};
        if (body.name != null) patch.name = String(body.name).trim();
        if (body.commission_rate != null) {
          const rate = Number(body.commission_rate);
          if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
            data = { error: '수수료율은 0~100' };
          } else patch.commission_rate = rate;
        }
        if (body.memo !== undefined) patch.memo = body.memo || null;
        if (typeof body.is_active === 'boolean') patch.is_active = body.is_active;
        if (!data && Object.keys(patch).length === 0) data = { error: '변경 항목 없음' };
        if (!data) {
          try {
            const r = await fetch(`${SUPABASE_URL}/rest/v1/bg_artists?id=eq.${encodeURIComponent(id)}`, {
              method: 'PATCH',
              headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type':'application/json', Prefer:'return=representation' },
              body: JSON.stringify(patch)
            });
            const j = await r.json();
            if (!r.ok) data = { error: j?.message || '작가 수정 실패' };
            else data = { ok: true, item: Array.isArray(j) ? j[0] : j };
          } catch (e) { data = { error: e.message }; }
        }
      } else if (pathname.match(/^\/api\/artists\/[a-f0-9-]+$/) && req.method === 'DELETE') {
        // is_active = false (시드 손상 방지)
        const id = pathname.split('/').pop();
        try {
          const r = await fetch(`${SUPABASE_URL}/rest/v1/bg_artists?id=eq.${encodeURIComponent(id)}`, {
            method: 'PATCH',
            headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type':'application/json', Prefer:'return=representation' },
            body: JSON.stringify({ is_active: false })
          });
          const j = await r.json();
          if (!r.ok) data = { error: j?.message || '비활성화 실패' };
          else data = { ok: true, item: Array.isArray(j) ? j[0] : j };
        } catch (e) { data = { error: e.message }; }
      } else if (pathname === '/api/artists/products' && req.method === 'GET') {
        // 전체 품목 + 작가 정보
        try {
          const r = await fetch(`${SUPABASE_URL}/rest/v1/bg_artist_products?select=id,product_code,product_name,category,is_active,artist_id,bg_artists(id,name,commission_rate)&order=category.asc,product_code.asc`, {
            headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
          });
          const arr = await r.json();
          if (!r.ok) data = { error: arr?.message || 'Supabase 조회 실패', items: [] };
          else data = {
            items: (Array.isArray(arr) ? arr : []).map(p => ({
              id: p.id, product_code: p.product_code, product_name: p.product_name || '',
              category: p.category || '', artist_id: p.artist_id || null,
              artist_name: p.bg_artists?.name || '',
              commission_rate: Number(p.bg_artists?.commission_rate || 0),
              is_active: !!p.is_active
            }))
          };
        } catch (e) { data = { error: e.message, items: [] }; }
      } else if (pathname === '/api/artists/products' && req.method === 'POST') {
        // 신규 품목 등록
        const body = await new Promise((resolve) => {
          let raw=''; req.on('data', c=>raw+=c);
          req.on('end', () => { try { resolve(raw?JSON.parse(raw):{}); } catch { resolve({}); } });
        });
        const code = String(body.product_code || '').trim();
        const cat = String(body.category || '').trim();
        if (!code) data = { error: '품목코드 필수' };
        else if (!['엽서세트','웨딩스탬프','청첩장'].includes(cat)) data = { error: '분류는 엽서세트/웨딩스탬프/청첩장 중 하나' };
        else {
          try {
            const r = await fetch(`${SUPABASE_URL}/rest/v1/bg_artist_products`, {
              method: 'POST',
              headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type':'application/json', Prefer:'return=representation' },
              body: JSON.stringify({
                product_code: code, product_name: body.product_name || null,
                category: cat, artist_id: body.artist_id || null
              })
            });
            const j = await r.json();
            if (!r.ok) data = { error: j?.message || '품목 추가 실패' };
            else data = { ok: true, item: Array.isArray(j) ? j[0] : j };
          } catch (e) { data = { error: e.message }; }
        }
      } else if (pathname.match(/^\/api\/artists\/products\/[a-f0-9-]+$/) && req.method === 'PATCH') {
        const id = pathname.split('/').pop();
        const body = await new Promise((resolve) => {
          let raw=''; req.on('data', c=>raw+=c);
          req.on('end', () => { try { resolve(raw?JSON.parse(raw):{}); } catch { resolve({}); } });
        });
        const patch = {};
        if (body.product_name !== undefined) patch.product_name = body.product_name || null;
        if (body.artist_id !== undefined) patch.artist_id = body.artist_id || null;
        if (body.category !== undefined) {
          if (!['엽서세트','웨딩스탬프','청첩장'].includes(body.category)) {
            data = { error: '분류는 엽서세트/웨딩스탬프/청첩장' };
          } else patch.category = body.category;
        }
        if (typeof body.is_active === 'boolean') patch.is_active = body.is_active;
        if (!data && Object.keys(patch).length === 0) data = { error: '변경 항목 없음' };
        if (!data) {
          try {
            const r = await fetch(`${SUPABASE_URL}/rest/v1/bg_artist_products?id=eq.${encodeURIComponent(id)}`, {
              method: 'PATCH',
              headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type':'application/json', Prefer:'return=representation' },
              body: JSON.stringify(patch)
            });
            const j = await r.json();
            if (!r.ok) data = { error: j?.message || '품목 수정 실패' };
            else data = { ok: true, item: Array.isArray(j) ? j[0] : j };
          } catch (e) { data = { error: e.message }; }
        }
      } else if (pathname.match(/^\/api\/artists\/products\/[a-f0-9-]+$/) && req.method === 'DELETE') {
        const id = pathname.split('/').pop();
        try {
          const r = await fetch(`${SUPABASE_URL}/rest/v1/bg_artist_products?id=eq.${encodeURIComponent(id)}`, {
            method: 'PATCH',
            headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type':'application/json', Prefer:'return=representation' },
            body: JSON.stringify({ is_active: false })
          });
          const j = await r.json();
          if (!r.ok) data = { error: j?.message || '비활성화 실패' };
          else data = { ok: true, item: Array.isArray(j) ? j[0] : j };
        } catch (e) { data = { error: e.message }; }
      } else if (pathname === '/api/artists/settlements' && req.method === 'GET') {
        // Phase 3 — 작가별 정산 합계 + 품목별 drill-down.
        //   기간: settle_date (결제일) 기준. status_seq NOT IN (CARD: 3,5,9 / ETC: 3,5,15).
        //   매칭: S2_Card.Card_Code == bg_artist_products.product_code
        //   반환:
        //     { period: {start, end}, by_artist: [...], by_product: [...] }
        data = await apiArtistSettlements(parsed.query);
      } else if (pathname === '/api/artists/settlements/site-breakdown' && req.method === 'GET') {
        // 특정 product_code 의 매출을 site_name 별로 breakdown.
        //   barshop1 판매종합실적 등 외부 리포트와 대조하기 위한 debug endpoint.
        //   ?product_code=BH5066&start_date=2026-04-01&end_date=2026-07-01&basis=ship
        const code = String(parsed.query.product_code || '').trim();
        if (!code) { data = { error: 'product_code 필수' }; }
        else {
          const startDate = parsed.query.start_date || '';
          const endDate = parsed.query.end_date || '';
          const basis = (parsed.query.basis || 'settle').toLowerCase();
          let cardDateCol, etcDateCol;
          if (basis === 'ship') { cardDateCol = 'src_send_date'; etcDateCol = 'delivery_date'; }
          else if (basis === 'order') { cardDateCol = 'order_date'; etcDateCol = 'order_date'; }
          else { cardDateCol = 'settle_date'; etcDateCol = 'settle_date'; }
          const cardNullClause = basis === 'order' ? '' : `AND co.${cardDateCol} IS NOT NULL`;
          const etcNullClause  = basis === 'order' ? '' : `AND o.${etcDateCol} IS NOT NULL`;
          const codeUp = code.toUpperCase().replace(/'/g, "''");
          try {
            const p = await getPool();
            const [cardRes, etcRes] = await Promise.all([
              p.request()
                .input('s', sql.VarChar, startDate)
                .input('e', sql.VarChar, endDate)
                .query(`
                  SELECT
                    ISNULL(si.SiteName, CAST(co.company_Seq AS VARCHAR)) AS site_name,
                    co.company_Seq AS company_seq,
                    COUNT(DISTINCT co.order_seq) AS order_count,
                    ISNULL(SUM(coi.item_count), 0) AS qty,
                    ISNULL(SUM(CAST(coi.item_sale_price AS float) * coi.item_count / ISNULL(NULLIF(c.Unit_Value, 0), 1)), 0) AS gross,
                    ISNULL(SUM(
                      CAST(coi.item_sale_price AS float) * coi.item_count / ISNULL(NULLIF(c.Unit_Value, 0), 1)
                      - (ISNULL(co.point_price, 0) + ISNULL(coc.coupon_amt, 0)) * 1.0
                        / NULLIF(a01c.a01_item_count, 0)
                    ), 0) AS net
                  FROM custom_order co WITH (NOLOCK)
                  INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
                  INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
                  LEFT JOIN SiteInfo si WITH (NOLOCK) ON co.company_Seq = si.CompayCode
                  LEFT JOIN (
                    SELECT coi_a.order_seq, COUNT(*) AS a01_item_count
                    FROM custom_order_item coi_a WITH (NOLOCK)
                    INNER JOIN S2_Card c_a WITH (NOLOCK) ON coi_a.card_seq = c_a.Card_Seq
                    INNER JOIN custom_order co_a WITH (NOLOCK) ON coi_a.order_seq = co_a.order_seq
                    WHERE c_a.Card_Div = 'A01'
                      AND co_a.status_seq >= 2 AND co_a.status_seq NOT IN (3, 5, 9)
                      ${cardNullClause.replace('co.', 'co_a.')}
                      AND co_a.${cardDateCol} >= @s AND co_a.${cardDateCol} < @e
                    GROUP BY coi_a.order_seq
                  ) a01c ON co.order_seq = a01c.order_seq
                  LEFT JOIN (
                    SELECT ORDER_SEQ, SUM(ISNULL(COUPON_AMT, 0)) AS coupon_amt
                    FROM CUSTOM_ORDER_COUPON WITH (NOLOCK)
                    GROUP BY ORDER_SEQ
                  ) coc ON co.order_seq = coc.ORDER_SEQ
                  WHERE UPPER(RTRIM(LTRIM(c.Card_Code))) = '${codeUp}'
                    AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5, 9)
                    ${cardNullClause}
                    AND co.${cardDateCol} >= @s AND co.${cardDateCol} < @e
                  GROUP BY ISNULL(si.SiteName, CAST(co.company_Seq AS VARCHAR)), co.company_Seq
                  ORDER BY net DESC
                `),
              p.request()
                .input('s', sql.VarChar, startDate)
                .input('e', sql.VarChar, endDate)
                .query(`
                  SELECT
                    ISNULL(si.SiteName, CAST(o.company_Seq AS VARCHAR)) AS site_name,
                    o.company_Seq AS company_seq,
                    COUNT(DISTINCT o.order_seq) AS order_count,
                    ISNULL(SUM(oi.order_count), 0) AS qty,
                    ISNULL(SUM(
                      CASE WHEN si.SiteName IS NULL
                           THEN CAST(oi.card_sale_price AS float) * oi.order_count / ISNULL(NULLIF(c.Unit_Value, 0), 1)
                           ELSE CAST(oi.card_sale_price AS float)
                      END
                    ), 0) AS gross,
                    ISNULL(SUM(
                      CASE
                        WHEN si.SiteName IS NULL
                        THEN CAST(oi.card_sale_price AS float) * oi.order_count / ISNULL(NULLIF(c.Unit_Value, 0), 1)
                             - ISNULL(o.coupon_price, 0) * 1.0 / NULLIF(a01e.a01_item_count, 0)
                        ELSE CAST(oi.card_sale_price AS float)
                             - ISNULL(o.coupon_price, 0) * 1.0 / NULLIF(a01e.a01_item_count, 0)
                      END
                    ), 0) AS net
                  FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
                  INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
                  INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
                  LEFT JOIN SiteInfo si WITH (NOLOCK) ON o.company_Seq = si.CompayCode
                  LEFT JOIN (
                    SELECT oi_a.order_seq, COUNT(*) AS a01_item_count
                    FROM CUSTOM_ETC_ORDER_ITEM oi_a WITH (NOLOCK)
                    INNER JOIN S2_Card c_a WITH (NOLOCK) ON oi_a.card_seq = c_a.Card_Seq
                    INNER JOIN CUSTOM_ETC_ORDER o_a WITH (NOLOCK) ON oi_a.order_seq = o_a.order_seq
                    WHERE c_a.Card_Div = 'A01'
                      AND o_a.status_seq >= 2 AND o_a.status_seq NOT IN (3, 5, 15)
                      ${etcNullClause.replace('o.', 'o_a.')}
                      AND o_a.${etcDateCol} >= @s AND o_a.${etcDateCol} < @e
                    GROUP BY oi_a.order_seq
                  ) a01e ON o.order_seq = a01e.order_seq
                  WHERE UPPER(RTRIM(LTRIM(c.Card_Code))) = '${codeUp}'
                    AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 15)
                    ${etcNullClause}
                    AND o.${etcDateCol} >= @s AND o.${etcDateCol} < @e
                  GROUP BY ISNULL(si.SiteName, CAST(o.company_Seq AS VARCHAR)), o.company_Seq
                  ORDER BY net DESC
                `),
            ]);
            const round = v => Math.round(Number(v) || 0);
            const norm = (rows, table) => (rows || []).map(r => ({
              table,
              site_name: r.site_name,
              company_seq: r.company_seq,
              is_affiliate: !r.site_name || /^\d+$/.test(String(r.site_name).trim()),
              order_count: Number(r.order_count) || 0,
              qty: Number(r.qty) || 0,
              gross: round(r.gross),
              net: round(r.net),
            }));
            const cardRows = norm(cardRes.recordset, 'custom_order');
            const etcRows = norm(etcRes.recordset, 'CUSTOM_ETC_ORDER');
            const sum = (arr, f) => arr.reduce((a, r) => a + (r[f] || 0), 0);
            data = {
              product_code: code,
              period: { start: startDate, end: endDate },
              basis,
              card_by_site: cardRows,
              etc_by_site: etcRows,
              totals: {
                card: { qty: sum(cardRows, 'qty'), gross: sum(cardRows, 'gross'), net: sum(cardRows, 'net'), order_count: sum(cardRows, 'order_count') },
                etc:  { qty: sum(etcRows, 'qty'),  gross: sum(etcRows, 'gross'),  net: sum(etcRows, 'net'),  order_count: sum(etcRows, 'order_count') },
              },
            };
          } catch (e) { data = { error: 'MSSQL 조회 실패: ' + e.message }; }
        }
      } else if (pathname === '/api/artists/settlements/daily-breakdown' && req.method === 'GET') {
        // 카테고리 or 특정 product_codes 의 일자별 판매수량/매출 breakdown.
        //   ?category=수건&start_date=2026-05-01&end_date=2026-07-17&basis=ship
        //   ?product_codes=BH5066,BC6951&start_date=...
        const startDate = parsed.query.start_date || '';
        const endDate = parsed.query.end_date || '';
        const basis = (parsed.query.basis || 'settle').toLowerCase();
        const category = String(parsed.query.category || '').trim();
        const codesParam = String(parsed.query.product_codes || '').trim();
        if (!startDate || !endDate) { data = { error: 'start_date, end_date 필수' }; }
        else {
          try {
            // 1) 조회 대상 product_codes 결정
            let productCodes = [];
            let supabaseError = null;
            if (codesParam) {
              productCodes = codesParam.split(',').map(s => s.trim()).filter(Boolean);
            } else {
              // Supabase 에서 활성 상품 조회 후 category 로 필터 (부분 일치)
              const r = await fetch(
                `${SUPABASE_URL}/rest/v1/bg_artist_products?select=product_code,category,is_active&is_active=eq.true`,
                { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
              );
              const arr = await r.json();
              if (!r.ok) {
                supabaseError = 'Supabase 조회 실패: ' + (arr?.message || r.status);
              } else {
                const filtered = category
                  ? (arr || []).filter(p => String(p.category || '').includes(category))
                  : (arr || []);
                productCodes = filtered.map(p => p.product_code).filter(Boolean);
              }
            }
            if (supabaseError) {
              data = { error: supabaseError };
            } else if (!productCodes.length) {
              data = { period: {start:startDate,end:endDate}, basis, category, product_codes: [], by_date: [], message: '대상 상품 없음' };
            } else {
              let cardDateCol, etcDateCol;
              if (basis === 'ship') { cardDateCol = 'src_send_date'; etcDateCol = 'delivery_date'; }
              else if (basis === 'order') { cardDateCol = 'order_date'; etcDateCol = 'order_date'; }
              else { cardDateCol = 'settle_date'; etcDateCol = 'settle_date'; }
              const cardNullClause = basis === 'order' ? '' : `AND co.${cardDateCol} IS NOT NULL`;
              const etcNullClause  = basis === 'order' ? '' : `AND o.${etcDateCol} IS NOT NULL`;
              const codesUp = productCodes.map(c => `'${String(c).trim().toUpperCase().replace(/'/g, "''")}'`).join(',');
              const p = await getPool();
              const [cardRes, etcRes] = await Promise.all([
                p.request()
                  .input('s', sql.VarChar, startDate)
                  .input('e', sql.VarChar, endDate)
                  .query(`
                    SELECT
                      CAST(co.${cardDateCol} AS DATE) AS d,
                      UPPER(RTRIM(LTRIM(c.Card_Code))) AS product_code,
                      c.Card_Name AS product_name,
                      ISNULL(SUM(coi.item_count), 0) AS qty,
                      ISNULL(SUM(CAST(coi.item_sale_price AS float) * coi.item_count / ISNULL(NULLIF(c.Unit_Value, 0), 1)), 0) AS gross
                    FROM custom_order co WITH (NOLOCK)
                    INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
                    INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
                    WHERE UPPER(RTRIM(LTRIM(c.Card_Code))) IN (${codesUp})
                      AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5, 9)
                      ${cardNullClause}
                      AND co.${cardDateCol} >= @s AND co.${cardDateCol} < @e
                    GROUP BY CAST(co.${cardDateCol} AS DATE), UPPER(RTRIM(LTRIM(c.Card_Code))), c.Card_Name
                    ORDER BY d ASC
                  `),
                p.request()
                  .input('s', sql.VarChar, startDate)
                  .input('e', sql.VarChar, endDate)
                  .query(`
                    SELECT
                      CAST(o.${etcDateCol} AS DATE) AS d,
                      UPPER(RTRIM(LTRIM(c.Card_Code))) AS product_code,
                      c.Card_Name AS product_name,
                      ISNULL(SUM(oi.order_count), 0) AS qty,
                      ISNULL(SUM(
                        CASE WHEN si.SiteName IS NULL
                             THEN CAST(oi.card_sale_price AS float) * oi.order_count / ISNULL(NULLIF(c.Unit_Value, 0), 1)
                             ELSE CAST(oi.card_sale_price AS float)
                        END
                      ), 0) AS gross
                    FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
                    INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
                    INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
                    LEFT JOIN SiteInfo si WITH (NOLOCK) ON o.company_Seq = si.CompayCode
                    WHERE UPPER(RTRIM(LTRIM(c.Card_Code))) IN (${codesUp})
                      AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 15)
                      ${etcNullClause}
                      AND o.${etcDateCol} >= @s AND o.${etcDateCol} < @e
                    GROUP BY CAST(o.${etcDateCol} AS DATE), UPPER(RTRIM(LTRIM(c.Card_Code))), c.Card_Name
                    ORDER BY d ASC
                  `),
              ]);
              // 날짜별 집계 (card + etc 합산)
              const byDateMap = new Map(); // 'YYYY-MM-DD' → { date, card_qty, etc_qty, total_qty, card_gross, etc_gross, total_gross }
              const fmtD = d => {
                if (!d) return '';
                const dt = new Date(d);
                return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
              };
              const addRow = (row, channel) => {
                const dateKey = fmtD(row.d);
                if (!byDateMap.has(dateKey)) {
                  byDateMap.set(dateKey, { date: dateKey, card_qty: 0, etc_qty: 0, total_qty: 0, card_gross: 0, etc_gross: 0, total_gross: 0 });
                }
                const b = byDateMap.get(dateKey);
                if (channel === 'card') { b.card_qty += Number(row.qty) || 0; b.card_gross += Number(row.gross) || 0; }
                else { b.etc_qty += Number(row.qty) || 0; b.etc_gross += Number(row.gross) || 0; }
                b.total_qty = b.card_qty + b.etc_qty;
                b.total_gross = Math.round(b.card_gross + b.etc_gross);
              };
              (cardRes.recordset || []).forEach(r => addRow(r, 'card'));
              (etcRes.recordset || []).forEach(r => addRow(r, 'etc'));
              const byDate = [...byDateMap.values()].sort((a, b) => a.date.localeCompare(b.date));
              // 상품별 breakdown (전체 기간 합계)
              const byProductMap = new Map();
              const addProductRow = (row, channel) => {
                const k = row.product_code;
                if (!byProductMap.has(k)) {
                  byProductMap.set(k, { product_code: k, product_name: row.product_name || '', card_qty: 0, etc_qty: 0, total_qty: 0, card_gross: 0, etc_gross: 0, total_gross: 0 });
                }
                const p = byProductMap.get(k);
                if (channel === 'card') { p.card_qty += Number(row.qty) || 0; p.card_gross += Number(row.gross) || 0; }
                else { p.etc_qty += Number(row.qty) || 0; p.etc_gross += Number(row.gross) || 0; }
                p.total_qty = p.card_qty + p.etc_qty;
                p.total_gross = Math.round(p.card_gross + p.etc_gross);
              };
              (cardRes.recordset || []).forEach(r => addProductRow(r, 'card'));
              (etcRes.recordset || []).forEach(r => addProductRow(r, 'etc'));
              const byProduct = [...byProductMap.values()].sort((a, b) => b.total_qty - a.total_qty);
              const totalQty = byDate.reduce((a, r) => a + r.total_qty, 0);
              const totalGross = byDate.reduce((a, r) => a + r.total_gross, 0);
              data = {
                period: { start: startDate, end: endDate },
                basis,
                category: category || null,
                product_codes: productCodes,
                totals: { total_qty: totalQty, total_gross: totalGross, days: byDate.length },
                by_date: byDate,
                by_product: byProduct,
              };
            }
          } catch (e) { data = { error: 'MSSQL 조회 실패: ' + e.message }; }
        }
      } else if (pathname === '/api/debug/find-columns' && req.method === 'GET') {
        // DB 전체에서 컬럼명 패턴 검색 — UTM/유입경로 추적 컬럼이 존재하는지 확인용.
        //   ?pattern=utm,refer,inflow,campaign  (콤마 구분, 영숫자/_ 만 허용 → LIKE injection 차단)
        if (!isSuperAdmin(session) && !(await hasRole(session, ['admin', 'operator']))) {
          return denyForbidden(res, 'admin/operator 필요');
        }
        const rawPat = String(parsed.query.pattern || 'utm').trim();
        const patterns = rawPat.split(',').map(s => s.trim())
          .filter(s => /^[A-Za-z0-9_]{2,30}$/.test(s)).slice(0, 10);
        if (!patterns.length) {
          data = { error: 'pattern 형식 오류 — 영문/숫자/언더스코어 2~30자, 콤마 구분 (예: utm,refer,inflow)' };
        } else {
          try {
            const p = await getPool();
            const whereCols = patterns.map(pt => `COLUMN_NAME LIKE '%${pt}%'`).join(' OR ');
            const r = await p.request().query(`
              SELECT TOP 300 TABLE_NAME, COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
              FROM INFORMATION_SCHEMA.COLUMNS
              WHERE ${whereCols}
              ORDER BY TABLE_NAME, ORDINAL_POSITION
            `);
            const cols = (r.recordset || []).map(x => ({
              table: x.TABLE_NAME,
              column: x.COLUMN_NAME,
              type: x.DATA_TYPE + (x.CHARACTER_MAXIMUM_LENGTH ? `(${x.CHARACTER_MAXIMUM_LENGTH})` : ''),
            }));
            data = { patterns, match_count: cols.length, columns: cols };
          } catch (e) { data = { error: 'MSSQL 조회 실패: ' + e.message }; }
        }
      } else if (pathname === '/api/debug/audit-sticker-mismatch' && req.method === 'GET') {
        // 과거 오출고 소급 점검 — 정보입력현황 상품명 뒤섞임 버그(커밋 bc8f873 수정 전)로
        //   잘못 표시됐을 주문 탐지. 실주문 product_code(MSSQL) ↔ 저장된 sticker_selections
        //   product_code(Supabase) 를 주문별로 대조. 실제 상품 중 매칭 sel 이 없는 주문 = 화면에서
        //   위치 fallback 으로 엉뚱한 상품명 표시됐던 케이스.
        //   ?start_date=2026-04-01&end_date=2026-07-20  (submitted_at 기준)
        if (!isSuperAdmin(session) && !(await hasRole(session, ['admin', 'operator']))) {
          return denyForbidden(res, 'admin/operator 필요');
        }
        const s = String(parsed.query.start_date || '').trim();
        const e = String(parsed.query.end_date || '').trim();
        const dateOk = v => /^\d{4}-\d{2}-\d{2}$/.test(v);
        if (!dateOk(s) || !dateOk(e)) {
          data = { error: 'start_date, end_date 필수 (YYYY-MM-DD)' };
        } else {
          try {
            // 1) Supabase CI (submitted_at 기간 내, sticker_selections 있는 것만)
            const ciRes = await fetch(
              `${SUPABASE_URL}/rest/v1/bg_order_customer_info?select=order_id,sticker_selections,submitted_at&submitted_at=gte.${s}T00:00:00&submitted_at=lt.${e}T23:59:59&order=submitted_at.desc&limit=5000`,
              { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
            );
            const cis = await ciRes.json();
            if (!ciRes.ok) {
              data = { error: 'Supabase 조회 실패: ' + (cis?.message || ciRes.status) };
            } else {
              // 2) order_id → order_seq. CARD=numeric, ETC=ETC-. MANUAL(MO-)/마켓(CP-/NV-) 제외
              //    (fallback 이 MANUAL 전용이라 정상, 마켓은 스티커 입력 없음).
              const cardSeqs = new Set(), etcSeqs = new Set();
              const targets = [];
              for (const ci of (Array.isArray(cis) ? cis : [])) {
                const id = String(ci.order_id || '');
                let seq = null, table = null;
                if (/^\d+$/.test(id)) { seq = parseInt(id, 10); table = 'CARD'; }
                else if (id.startsWith('ETC-')) { seq = parseInt(id.slice(4), 10); table = 'ETC'; }
                else continue;
                if (!seq) continue;
                const sels = Array.isArray(ci.sticker_selections) ? ci.sticker_selections : [];
                if (!sels.length) continue; // sels 없으면 fallback 미발생 → 버그 없음
                const selCodes = new Set(sels.map(x => String(x.product_code || '').trim().toUpperCase()).filter(Boolean));
                (table === 'CARD' ? cardSeqs : etcSeqs).add(seq);
                targets.push({ order_id: id, seq, table, selCodes, sel_count: sels.length });
              }
              // 3) MSSQL 실제 답례품(D01/COM_) product_code — chunk IN 조회
              const p = await getPool();
              const realCodes = new Map(); // `${table}:${seq}` → Set(codes)
              const chunk = (arr, n) => { const o = []; for (let i = 0; i < arr.length; i += n) o.push(arr.slice(i, i + n)); return o; };
              const loadCodes = async (seqs, table) => {
                const tbl = table === 'CARD' ? 'custom_order' : 'CUSTOM_ETC_ORDER';
                const itemTbl = table === 'CARD' ? 'custom_order_item' : 'CUSTOM_ETC_ORDER_ITEM';
                for (const c of chunk(seqs, 500)) {
                  if (!c.length) continue;
                  const r = await p.request().query(`
                    SELECT o.order_seq, UPPER(RTRIM(LTRIM(sc.Card_Code))) AS code
                    FROM ${tbl} o WITH (NOLOCK)
                    INNER JOIN ${itemTbl} oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
                    INNER JOIN S2_Card sc WITH (NOLOCK) ON oi.card_seq = sc.Card_Seq
                    WHERE o.order_seq IN (${c.join(',')})
                      AND (sc.Card_Div = 'D01' OR sc.Card_Code LIKE 'COM[_]%')
                  `);
                  for (const row of r.recordset) {
                    const k = `${table}:${row.order_seq}`;
                    if (!realCodes.has(k)) realCodes.set(k, new Set());
                    realCodes.get(k).add(String(row.code).trim().toUpperCase());
                  }
                }
              };
              await loadCodes([...cardSeqs], 'CARD');
              await loadCodes([...etcSeqs], 'ETC');
              // 4) 비교 — 실제 상품 중 매칭 sel 없는 코드 = 화면에서 오표시된 상품
              const mismatches = [];
              for (const t of targets) {
                const real = realCodes.get(`${t.table}:${t.seq}`);
                if (!real || !real.size) continue; // 답례품 상품 없음 (취소/마켓 등) → skip
                const unmatched = [...real].filter(code => !t.selCodes.has(code));
                if (unmatched.length) {
                  mismatches.push({
                    order_id: t.order_id, table: t.table,
                    real_product_count: real.size, sel_count: t.sel_count,
                    unmatched_real_codes: unmatched,
                    real_codes: [...real], sel_codes: [...t.selCodes],
                  });
                }
              }
              data = {
                period: { start: s, end: e },
                ci_scanned: targets.length,
                ci_truncated: Array.isArray(cis) && cis.length >= 5000,
                mismatch_count: mismatches.length,
                note: '수정(bc8f873) 이전 이 주문들의 정보입력현황이 실제와 다른 상품명으로 표시됐을 수 있음 (오출고/누락 후보). unmatched_real_codes 가 sel 매칭 실패한 실제 상품. 수정 후 화면은 정상 표시됨.',
                mismatches: mismatches.slice(0, 500),
                mismatches_truncated: mismatches.length > 500,
              };
            }
          } catch (e2) { data = { error: '조회 실패: ' + e2.message }; }
        }
      } else if (pathname === '/api/debug/scan-missing-items' && req.method === 'GET') {
        // 출고누락 전수 점검 — 정보입력현황(category=daeryepum)에서 상품이 누락될 수
        //   있는 주문을 기간 단위로 스캔.
        //   ?start_date=2026-04-01&end_date=2026-07-20
        //   원인 무관 전수: (A) 카테고리 필터 제외 아이템 (B) card_name 빈값 답례품 아이템.
        //   has_daeryepum_sibling=1 → 주문은 정보입력현황에 뜨지만 이 아이템만 누락 (핵심 증상).
        if (!isSuperAdmin(session) && !(await hasRole(session, ['admin', 'operator']))) {
          return denyForbidden(res, 'admin/operator 필요');
        }
        const s = String(parsed.query.start_date || '').trim();
        const e = String(parsed.query.end_date || '').trim();
        const dateOk = v => /^\d{4}-\d{2}-\d{2}$/.test(v);
        if (!dateOk(s) || !dateOk(e)) {
          data = { error: 'start_date, end_date 필수 (YYYY-MM-DD)' };
        } else {
          try {
            const p = await getPool();
            // (A) 카테고리 필터 제외 아이템 — Card_Div 가 알려진 카테고리(D01 답례품/A01 청첩장/
            //   C29 데코/D02 꽃)도 아니고 COM_ 위탁도 아닌 "알 수 없는 div" 아이템.
            //   has_daeryepum_sibling: 같은 주문에 D01/COM_ 답례품이 있으면 주문은 화면에 뜸 → 이 아이템만 누락.
            const scanA = await p.request()
              .input('s', sql.VarChar, s).input('e', sql.VarChar, e)
              .query(`
                SELECT TOP 500 src, order_seq, card_div, card_code, card_name, qty, has_dsib
                FROM (
                  SELECT 'CARD' AS src, co.order_seq,
                    c.Card_Div AS card_div, c.Card_Code AS card_code, c.Card_Name AS card_name,
                    coi.item_count AS qty,
                    CASE WHEN EXISTS (
                      SELECT 1 FROM custom_order_item ci2 WITH (NOLOCK)
                      INNER JOIN S2_Card c2 WITH (NOLOCK) ON ci2.card_seq = c2.Card_Seq
                      WHERE ci2.order_seq = co.order_seq
                        AND (c2.Card_Div = 'D01' OR c2.Card_Code LIKE 'COM[_]%')
                    ) THEN 1 ELSE 0 END AS has_dsib
                  FROM custom_order co WITH (NOLOCK)
                  INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
                  INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
                  WHERE co.order_date >= @s AND co.order_date < DATEADD(day, 1, CAST(@e AS date))
                    AND co.status_seq >= 1
                    AND c.Card_Div NOT IN ('D01','A01','C29','D02')
                    AND c.Card_Code NOT LIKE 'COM[_]%'
                  UNION ALL
                  SELECT 'ETC' AS src, o.order_seq,
                    c.Card_Div, c.Card_Code, c.Card_Name, oi.order_count,
                    CASE WHEN EXISTS (
                      SELECT 1 FROM CUSTOM_ETC_ORDER_ITEM oi2 WITH (NOLOCK)
                      INNER JOIN S2_Card c2 WITH (NOLOCK) ON oi2.card_seq = c2.Card_Seq
                      WHERE oi2.order_seq = o.order_seq
                        AND (c2.Card_Div = 'D01' OR c2.Card_Code LIKE 'COM[_]%')
                    ) THEN 1 ELSE 0 END
                  FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
                  INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
                  INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
                  WHERE o.order_date >= @s AND o.order_date < DATEADD(day, 1, CAST(@e AS date))
                    AND o.status_seq >= 1
                    AND c.Card_Div NOT IN ('D01','A01','C29','D02')
                    AND c.Card_Code NOT LIKE 'COM[_]%'
                ) t
                ORDER BY has_dsib DESC, order_seq DESC
              `);
            // (A) 요약 — div/code/name 별 집계 (패턴 파악)
            const scanASummary = await p.request()
              .input('s', sql.VarChar, s).input('e', sql.VarChar, e)
              .query(`
                SELECT card_div, card_code, card_name, COUNT(DISTINCT order_seq) AS order_count
                FROM (
                  SELECT co.order_seq, c.Card_Div AS card_div, c.Card_Code AS card_code, c.Card_Name AS card_name
                  FROM custom_order co WITH (NOLOCK)
                  INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
                  INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
                  WHERE co.order_date >= @s AND co.order_date < DATEADD(day, 1, CAST(@e AS date))
                    AND co.status_seq >= 1
                    AND c.Card_Div NOT IN ('D01','A01','C29','D02') AND c.Card_Code NOT LIKE 'COM[_]%'
                  UNION ALL
                  SELECT o.order_seq, c.Card_Div, c.Card_Code, c.Card_Name
                  FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
                  INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
                  INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
                  WHERE o.order_date >= @s AND o.order_date < DATEADD(day, 1, CAST(@e AS date))
                    AND o.status_seq >= 1
                    AND c.Card_Div NOT IN ('D01','A01','C29','D02') AND c.Card_Code NOT LIKE 'COM[_]%'
                ) t
                GROUP BY card_div, card_code, card_name
                ORDER BY order_count DESC
              `);
            // (B) card_name 빈값인 답례품(D01/COM_) 아이템 — productMap 이 card_name 없으면 스킵.
            const scanB = await p.request()
              .input('s', sql.VarChar, s).input('e', sql.VarChar, e)
              .query(`
                SELECT TOP 300 src, order_seq, card_code, card_div, qty FROM (
                  SELECT 'CARD' AS src, co.order_seq, c.Card_Code AS card_code, c.Card_Div AS card_div, coi.item_count AS qty
                  FROM custom_order co WITH (NOLOCK)
                  INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
                  INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
                  WHERE co.order_date >= @s AND co.order_date < DATEADD(day, 1, CAST(@e AS date))
                    AND co.status_seq >= 1
                    AND (c.Card_Div = 'D01' OR c.Card_Code LIKE 'COM[_]%')
                    AND LTRIM(RTRIM(ISNULL(c.Card_Name, ''))) = ''
                  UNION ALL
                  SELECT 'ETC' AS src, o.order_seq, c.Card_Code, c.Card_Div, oi.order_count
                  FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
                  INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON oi.order_seq = o.order_seq
                  INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
                  WHERE o.order_date >= @s AND o.order_date < DATEADD(day, 1, CAST(@e AS date))
                    AND o.status_seq >= 1
                    AND (c.Card_Div = 'D01' OR c.Card_Code LIKE 'COM[_]%')
                    AND LTRIM(RTRIM(ISNULL(c.Card_Name, ''))) = ''
                ) t
                ORDER BY order_seq DESC
              `);
            const aRows = (scanA.recordset || []).map(r => ({
              src: r.src, order_seq: r.order_seq, card_div: r.card_div,
              card_code: r.card_code, card_name: r.card_name, qty: Number(r.qty) || 0,
              order_shows_but_item_missing: r.has_dsib === 1,
            }));
            data = {
              period: { start: s, end: e },
              scan_a_category_excluded: {
                desc: '알 수 없는 Card_Div (D01/A01/C29/D02/COM_ 외) 아이템 — 카테고리 필터로 정보입력현황에서 제외됨',
                summary_by_product: scanASummary.recordset || [],
                orders: aRows,
                symptom_match_count: aRows.filter(r => r.order_shows_but_item_missing).length,
                orders_capped: (scanA.recordset || []).length >= 500,
              },
              scan_b_empty_name: {
                desc: '답례품(D01/COM_) 아이템인데 Card_Name 빈값 — productMap 이 card_name 없으면 스킵',
                orders: (scanB.recordset || []).map(r => ({ src: r.src, order_seq: r.order_seq, card_code: r.card_code, card_div: r.card_div, qty: Number(r.qty) || 0 })),
                orders_capped: (scanB.recordset || []).length >= 300,
              },
              note: 'scan_a 의 order_shows_but_item_missing=true 가 4760779 와 동일 증상. summary_by_product 에서 어떤 상품/div 가 답례품인지 확인 후 필터 보정 필요.',
            };
          } catch (e2) { data = { error: 'MSSQL 조회 실패: ' + e2.message }; }
        }
      } else if (pathname === '/api/debug/order-items' && req.method === 'GET') {
        // 특정 주문의 전 아이템을 카테고리 필터 없이 덤프 — 정보입력현황 누락 진단용.
        //   ?order_seq=4760779
        //   각 아이템의 Card_Div/Card_Code/Card_Name + daeryepum 필터(D01 OR COM_) 통과 여부.
        //   CARD(custom_order) + ETC(CUSTOM_ETC_ORDER) 양쪽 조회.
        if (!isSuperAdmin(session) && !(await hasRole(session, ['admin', 'operator']))) {
          return denyForbidden(res, 'admin/operator 필요');
        }
        const seq = parseInt(String(parsed.query.order_seq || '').trim(), 10);
        if (!seq || seq <= 0) { data = { error: 'order_seq (양의 정수) 필수' }; }
        else {
          try {
            const p = await getPool();
            const [cardRes, etcRes] = await Promise.all([
              p.request().input('seq', sql.Int, seq).query(`
                SELECT 'CARD' AS src, co.order_seq, co.status_seq,
                  c.Card_Code AS card_code, c.Card_Name AS card_name, c.Card_Div AS card_div,
                  coi.item_count AS qty,
                  CASE WHEN c.Card_Div = 'D01' OR c.Card_Code LIKE 'COM[_]%' THEN 1 ELSE 0 END AS passes_daeryepum,
                  CASE WHEN LTRIM(RTRIM(ISNULL(c.Card_Name, ''))) = '' THEN 1 ELSE 0 END AS card_name_empty
                FROM custom_order co WITH (NOLOCK)
                INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
                INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
                WHERE co.order_seq = @seq
              `),
              p.request().input('seq', sql.Int, seq).query(`
                SELECT 'ETC' AS src, o.order_seq, o.status_seq,
                  c.Card_Code AS card_code, c.Card_Name AS card_name, c.Card_Div AS card_div,
                  oi.order_count AS qty,
                  CASE WHEN c.Card_Div = 'D01' OR c.Card_Code LIKE 'COM[_]%' THEN 1 ELSE 0 END AS passes_daeryepum,
                  CASE WHEN LTRIM(RTRIM(ISNULL(c.Card_Name, ''))) = '' THEN 1 ELSE 0 END AS card_name_empty
                FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
                INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
                INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
                WHERE o.order_seq = @seq
              `),
            ]);
            // 답례품 배송 상세(DELIVERY_INFO_DETAIL) 존재 여부 — CARD 주문 누락 원인 진단.
            //   정보입력현황 CARD 쿼리는 DELIVERY_INFO_DETAIL item_title='답례품' INNER JOIN 이라
            //   답례품 배송 상세가 없으면 주문 자체가 빠질 수 있음.
            let deliveryDetail = [];
            try {
              const dd = await p.request().input('seq', sql.Int, seq).query(`
                SELECT di.DELIVERY_SEQ, di.NAME, dd.item_title, dd.item_count
                FROM DELIVERY_INFO di WITH (NOLOCK)
                LEFT JOIN DELIVERY_INFO_DETAIL dd WITH (NOLOCK) ON dd.delivery_id = di.ID
                WHERE di.ORDER_SEQ = @seq
                ORDER BY di.DELIVERY_SEQ
              `);
              deliveryDetail = dd.recordset || [];
            } catch (e) { deliveryDetail = [{ error: e.message }]; }
            // 아이템 테이블 전체 컬럼 덤프 — 옵션(별도 상품코드) 이 메인 아이템과 어떻게 연결되는지
            //   (부모 참조 seq / 옵션 플래그 컬럼 유무) 확인용. 옵션 검수 (order 3248035 케이스).
            let rawItems = { card: [], etc: [] };
            try {
              const [rc, re] = await Promise.all([
                p.request().input('seq', sql.Int, seq).query(`
                  SELECT coi.*, c.Card_Code AS _card_code, c.Card_Name AS _card_name, c.Card_Div AS _card_div
                  FROM custom_order_item coi WITH (NOLOCK)
                  INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
                  WHERE coi.order_seq = @seq
                `),
                p.request().input('seq', sql.Int, seq).query(`
                  SELECT oi.*, c.Card_Code AS _card_code, c.Card_Name AS _card_name, c.Card_Div AS _card_div
                  FROM CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK)
                  INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
                  WHERE oi.order_seq = @seq
                `),
              ]);
              rawItems = { card: rc.recordset || [], etc: re.recordset || [] };
            } catch (e) { rawItems = { error: e.message }; }
            const norm = rows => (rows || []).map(r => ({
              src: r.src, status_seq: r.status_seq,
              card_code: r.card_code, card_name: r.card_name, card_div: r.card_div,
              qty: Number(r.qty) || 0,
              passes_daeryepum_filter: r.passes_daeryepum === 1,
              card_name_empty: r.card_name_empty === 1,
            }));
            const items = [...norm(cardRes.recordset), ...norm(etcRes.recordset)];
            data = {
              order_seq: seq,
              found_in: cardRes.recordset.length ? 'CARD (custom_order)' : (etcRes.recordset.length ? 'ETC (CUSTOM_ETC_ORDER)' : '없음'),
              item_count: items.length,
              items,
              excluded_from_daeryepum: items.filter(i => !i.passes_daeryepum_filter),
              delivery_detail: deliveryDetail,
              raw_items: rawItems,
              note: 'passes_daeryepum_filter=false 인 아이템은 정보입력현황(category=daeryepum)에서 제외됨. raw_items 에서 옵션-메인 연결 컬럼(부모 seq/옵션 플래그) 확인.',
            };
          } catch (e) { data = { error: 'MSSQL 조회 실패: ' + e.message }; }
        }
      } else if (pathname === '/api/debug/signup-route' && req.method === 'GET') {
        // 사이트별 회원가입을 유입경로(inflow_route 등) 코드별로 집계.
        //   S2_UserInfo.inflow_route (varchar10) 등 코드 컬럼의 실제 값 분포 확인.
        //   ?since=2026-07-17T16:00:00&site=바른손카드&column=inflow_route
        //   column 은 화이트리스트만 허용 (injection 차단).
        if (!isSuperAdmin(session) && !(await hasRole(session, ['admin', 'operator']))) {
          return denyForbidden(res, 'admin/operator 필요');
        }
        const COL_WHITELIST = ['inflow_route', 'smembership_inflow_route', 'REFERER_SALES_GUBUN'];
        const col = String(parsed.query.column || 'inflow_route').trim();
        if (!COL_WHITELIST.includes(col)) {
          data = { error: `column 은 다음만 허용: ${COL_WHITELIST.join(', ')}` };
        } else {
          const sinceRaw = String(parsed.query.since || '').trim().replace('T', ' ');
          const hasSince = sinceRaw.length > 0;
          if (hasSince && !/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/.test(sinceRaw)) {
            data = { error: 'since 형식 오류 — YYYY-MM-DD 또는 YYYY-MM-DD HH:MM:SS' };
          } else {
            const site = String(parsed.query.site || '바른손카드').trim();
            try {
              const p = await getPool();
              const sinceClause = hasSince ? 'AND u.reg_date >= @since' : '';
              const reqq = p.request().input('site', sql.NVarChar, site);
              if (hasSince) reqq.input('since', sql.VarChar, sinceRaw);
              const r = await reqq.query(`
                SELECT
                  ISNULL(NULLIF(LTRIM(RTRIM(CAST(u.[${col}] AS NVARCHAR(50)))), ''), '(빈값)') AS route_code,
                  SUM(CASE WHEN u.USE_YORN = 'Y' THEN 1 ELSE 0 END) AS count_active,
                  COUNT(*) AS count_all
                FROM S2_UserInfo u WITH (NOLOCK)
                LEFT JOIN SiteInfo si WITH (NOLOCK) ON u.REFERER_SALES_GUBUN = si.SiteCode
                WHERE u.site_div = 'SB'
                  AND ISNULL(si.SiteName, '기타') = @site
                  ${sinceClause}
                GROUP BY ISNULL(NULLIF(LTRIM(RTRIM(CAST(u.[${col}] AS NVARCHAR(50)))), ''), '(빈값)')
                ORDER BY count_active DESC
              `);
              const rows = (r.recordset || []).map(x => ({
                route_code: x.route_code,
                count_active: Number(x.count_active) || 0,
                count_all: Number(x.count_all) || 0,
              }));
              data = {
                site,
                since: hasSince ? sinceRaw : '(전체 기간)',
                column: col,
                total_active: rows.reduce((a, r) => a + r.count_active, 0),
                routes: rows,
              };
            } catch (e) { data = { error: 'MSSQL 조회 실패: ' + e.message }; }
          }
        }
      } else if (pathname === '/api/debug/signup-count' && req.method === 'GET') {
        // 사이트별 회원가입 건수 (기간 필터).
        //   S2_UserInfo 의 가입일 컬럼명이 코드베이스 어디에도 안 쓰여 확정 불가 →
        //   date/datetime 형 컬럼을 자동 탐지해 후보별 건수 + MAX값을 함께 반환.
        //   MAX 가 현재 시각에 가까운 컬럼이 실제 가입일.
        //   ?since=2026-07-17T16:00:00&site=바른손카드
        //   가입사이트 = REFERER_SALES_GUBUN → SiteInfo.SiteCode (server.js:4589, 5217 정책)
        //   site_div='SB' 로 통합회원 중복 제거 (한 uid 당 SB/SS/BM 3행).
        if (!isSuperAdmin(session) && !(await hasRole(session, ['admin', 'operator']))) {
          return denyForbidden(res, 'admin/operator 필요');
        }
        const sinceRaw = String(parsed.query.since || '').trim().replace('T', ' ');
        // 'YYYY-MM-DD' 또는 'YYYY-MM-DD HH:MM(:SS)' 만 허용 — 컬럼명은 INFORMATION_SCHEMA
        //   출처 + [A-Za-z0-9_] 검증으로 injection 차단.
        if (!/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/.test(sinceRaw)) {
          data = { error: 'since 형식 오류 — YYYY-MM-DD 또는 YYYY-MM-DD HH:MM:SS' };
        } else {
          const site = String(parsed.query.site || '바른손카드').trim();
          try {
            const p = await getPool();
            const colsRes = await p.request().query(`
              SELECT COLUMN_NAME
              FROM INFORMATION_SCHEMA.COLUMNS
              WHERE TABLE_NAME = 'S2_UserInfo'
                AND DATA_TYPE IN ('date', 'datetime', 'datetime2', 'smalldatetime')
              ORDER BY ORDINAL_POSITION
            `);
            const dateCols = (colsRes.recordset || [])
              .map(r => r.COLUMN_NAME)
              .filter(n => /^[A-Za-z0-9_]+$/.test(n))
              .slice(0, 12);
            if (!dateCols.length) {
              data = { error: 'S2_UserInfo 에 date/datetime 형 컬럼이 없습니다 (가입일이 varchar 일 수 있음).' };
            } else {
              // 단일 스캔으로 모든 후보 컬럼 집계 (컬럼별 개별 쿼리는 스캔 N회 → 타임아웃 위험).
              const selectList = dateCols.map(c => `
                SUM(CASE WHEN u.[${c}] >= @since AND u.USE_YORN = 'Y' THEN 1 ELSE 0 END) AS c_${c},
                SUM(CASE WHEN u.[${c}] >= @since THEN 1 ELSE 0 END) AS a_${c},
                MAX(u.[${c}]) AS m_${c}`).join(',');
              const r = await p.request()
                .input('site', sql.NVarChar, site)
                .input('since', sql.VarChar, sinceRaw)
                .query(`
                  SELECT
                    COUNT(*) AS total_all,
                    SUM(CASE WHEN u.USE_YORN = 'Y' THEN 1 ELSE 0 END) AS total_active,
                    ${selectList}
                  FROM S2_UserInfo u WITH (NOLOCK)
                  LEFT JOIN SiteInfo si WITH (NOLOCK) ON u.REFERER_SALES_GUBUN = si.SiteCode
                  WHERE u.site_div = 'SB'
                    AND ISNULL(si.SiteName, '기타') = @site
                `);
              const row = r.recordset[0] || {};
              const candidates = dateCols.map(c => ({
                column: c,
                count_active: Number(row[`c_${c}`]) || 0,   // USE_YORN='Y' (탈퇴 제외)
                count_all: Number(row[`a_${c}`]) || 0,      // 탈퇴 포함
                max_value: row[`m_${c}`] || null,
              })).sort((a, b) => (b.max_value ? new Date(b.max_value) : 0) - (a.max_value ? new Date(a.max_value) : 0));
              data = {
                site,
                since: sinceRaw,
                total_members_active: Number(row.total_active) || 0,
                total_members_all: Number(row.total_all) || 0,
                note: 'max_value 가 현재 시각에 가까운 컬럼이 실제 가입일. count_active=탈퇴 제외, count_all=탈퇴 포함. site_div=SB 중복 제거 기준.',
                candidates,
              };
            }
          } catch (e) { data = { error: 'MSSQL 조회 실패: ' + e.message }; }
        }
      } else if (pathname === '/api/artists/diagnose' && req.method === 'GET') {
        // 매출 0 이슈 진단 — 시드 코드가 MSSQL Card_Code 와 매칭되는지 + 이번 달 매출.
        data = await apiArtistDiagnose();
      } else if (pathname === '/api/artists/card-seq-detail' && req.method === 'GET') {
        // 근본 원인 조사 — 여러 Card_Seq 의 모든 컬럼 비교.
        //   ?seqs=41765,41767,41769 → 스키마 + SELECT * + 차이점 자동 추출.
        const seqsStr = String(parsed.query.seqs || '').trim();
        const seqs = seqsStr.split(',').map(s => parseInt(s.trim())).filter(n => n > 0);
        if (!seqs.length) { data = { error: 'seqs 필수 (콤마 구분)' }; }
        else {
          try {
            const p = await getPool();
            const schemaRes = await p.request().query(`
              SELECT COLUMN_NAME, DATA_TYPE
              FROM INFORMATION_SCHEMA.COLUMNS
              WHERE TABLE_NAME = 'S2_Card'
              ORDER BY ORDINAL_POSITION
            `);
            const seqList = seqs.join(', ');
            const rowsRes = await p.request().query(`
              SELECT * FROM S2_Card WITH (NOLOCK)
              WHERE Card_Seq IN (${seqList})
              ORDER BY Card_Seq
            `);
            const schemaCols = (schemaRes.recordset || []).map(c => c.COLUMN_NAME);
            const rows = rowsRes.recordset || [];
            // 컬럼별 값 다양성 — row 간 값이 다른 컬럼만 추출 (원인 후보)
            const diffCols = [];
            for (const col of schemaCols) {
              const uniqueVals = new Set(rows.map(r => JSON.stringify(r[col])));
              if (uniqueVals.size > 1) {
                diffCols.push({
                  column: col,
                  values: rows.map(r => ({ card_seq: r.Card_Seq, value: r[col] }))
                });
              }
            }
            data = {
              schema_column_count: schemaCols.length,
              rows_count: rows.length,
              schema: schemaRes.recordset,
              rows,
              different_columns: diffCols,
              hint: diffCols.length === 0
                ? '모든 컬럼 값 동일 — 완전 중복 등록'
                : `${diffCols.length}개 컬럼에서 차이 있음 — 이 컬럼들이 Card_Seq 분리 원인 가능성`
            };
          } catch (e) { data = { error: e.message }; }
        }
      } else if (pathname === '/api/artists/duplicate-card-codes' && req.method === 'GET') {
        // 답례품 카테고리 (D01 + COM_) 에서 같은 Card_Code 인데 Card_Name 이 다른 케이스 자동 조회.
        //   최적화: 각 row 별 subquery 반복 → CTE + LEFT JOIN 으로 1회 pass 처리.
        //   requestTimeout 120초 (기본 30~60초 초과 방지).
        try {
          const p = await getPool();
          const request = p.request();
          request.timeout = 120000; // 120s
          const res = await request.query(`
            WITH duplicate_codes AS (
              SELECT Card_Code
              FROM S2_Card WITH (NOLOCK)
              WHERE Card_Div = 'D01' OR Card_Code LIKE 'COM[_]%'
              GROUP BY Card_Code
              HAVING COUNT(*) > 1 AND COUNT(DISTINCT Card_Name) > 1
            ),
            target_seqs AS (
              SELECT Card_Seq FROM S2_Card WITH (NOLOCK)
              WHERE Card_Code IN (SELECT Card_Code FROM duplicate_codes)
            ),
            card_agg AS (
              SELECT coi.card_seq, COUNT(*) AS cnt, MAX(co.order_date) AS max_date
              FROM custom_order_item coi WITH (NOLOCK)
              INNER JOIN custom_order co WITH (NOLOCK) ON coi.order_seq = co.order_seq
              WHERE coi.card_seq IN (SELECT Card_Seq FROM target_seqs)
              GROUP BY coi.card_seq
            ),
            etc_agg AS (
              SELECT oi.card_seq, COUNT(*) AS cnt, MAX(o.order_date) AS max_date
              FROM CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK)
              INNER JOIN CUSTOM_ETC_ORDER o WITH (NOLOCK) ON oi.order_seq = o.order_seq
              WHERE oi.card_seq IN (SELECT Card_Seq FROM target_seqs)
              GROUP BY oi.card_seq
            )
            SELECT
              c.Card_Code, c.Card_Name, c.Card_Seq, c.Unit_Value,
              ISNULL(ca.cnt, 0) AS card_orders,
              ISNULL(ea.cnt, 0) AS etc_orders,
              CASE
                WHEN ca.max_date IS NULL AND ea.max_date IS NULL THEN NULL
                WHEN ca.max_date IS NULL THEN ea.max_date
                WHEN ea.max_date IS NULL THEN ca.max_date
                WHEN ca.max_date > ea.max_date THEN ca.max_date
                ELSE ea.max_date
              END AS max_order_date
            FROM S2_Card c WITH (NOLOCK)
            LEFT JOIN card_agg ca ON ca.card_seq = c.Card_Seq
            LEFT JOIN etc_agg ea ON ea.card_seq = c.Card_Seq
            WHERE c.Card_Code IN (SELECT Card_Code FROM duplicate_codes)
            ORDER BY c.Card_Code, c.Card_Seq
          `);
          const rows = res.recordset || [];
          // Card_Code 별 그룹화 + 정상 이름 판단
          const casesByCode = new Map();
          for (const r of rows) {
            if (!casesByCode.has(r.Card_Code)) casesByCode.set(r.Card_Code, []);
            casesByCode.get(r.Card_Code).push({
              card_seq: r.Card_Seq,
              card_name: r.Card_Name,
              unit_value: r.Unit_Value,
              card_orders: r.card_orders,
              etc_orders: r.etc_orders,
              total_orders: r.card_orders + r.etc_orders,
              max_order_date: r.max_order_date
            });
          }
          const cases = [];
          for (const [code, rowList] of casesByCode) {
            // 정상 이름 후보 — 가장 최근 max_order_date 를 가진 row
            const sorted = [...rowList].sort((a, b) => {
              const ad = a.max_order_date ? new Date(a.max_order_date).getTime() : 0;
              const bd = b.max_order_date ? new Date(b.max_order_date).getTime() : 0;
              return bd - ad;
            });
            const suggestedRow = sorted[0];
            const suggestedName = suggestedRow?.card_name || '';
            const suggestedSeq = suggestedRow?.card_seq;
            // 정정 대상 = suggestedName 이외의 이름을 가진 row
            const targetSeqs = rowList
              .filter(r => r.card_name !== suggestedName)
              .map(r => r.card_seq);
            const totalRefs = rowList.reduce((s, r) => s + r.total_orders, 0);
            const safeUpdate = rowList
              .filter(r => r.card_name !== suggestedName)
              .every(r => r.total_orders === 0);
            const cleanupSql = targetSeqs.length
              ? `UPDATE S2_Card SET Card_Name = '${suggestedName.replace(/'/g, "''")}' WHERE Card_Seq IN (${targetSeqs.join(', ')});`
              : null;
            cases.push({
              card_code: code,
              row_count: rowList.length,
              unique_names: [...new Set(rowList.map(r => r.card_name))].length,
              rows: rowList,
              suggested_name: suggestedName,
              suggested_seq: suggestedSeq,
              target_seqs_to_update: targetSeqs,
              total_references: totalRefs,
              safe_to_update: safeUpdate,
              cleanup_sql: cleanupSql
            });
          }
          // 정렬: 참조 많은 순 (영향 큰 케이스 상단)
          cases.sort((a, b) => b.total_references - a.total_references);
          const allSql = cases
            .filter(c => c.cleanup_sql)
            .map(c => `-- ${c.card_code} (${c.rows.length} rows, ${c.total_references} orders, safe=${c.safe_to_update})\n${c.cleanup_sql}`)
            .join('\n\n');
          data = {
            total_cases: cases.length,
            summary: {
              total_cases: cases.length,
              safe_cases: cases.filter(c => c.safe_to_update).length,
              risky_cases: cases.filter(c => !c.safe_to_update).length,
              total_target_seqs: cases.reduce((s, c) => s + c.target_seqs_to_update.length, 0),
              total_affected_orders: cases.reduce((s, c) =>
                s + c.rows.filter(r => r.card_name !== c.suggested_name).reduce((ss, r) => ss + r.total_orders, 0), 0)
            },
            cases,
            all_cleanup_sql: allSql
          };
        } catch (e) {
          data = { error: e.message };
        }
      } else if (pathname === '/api/artists/canonical-mismatches' && req.method === 'GET') {
        // canonical name 로직이 실제로 raw 이름 → canonical 이름으로 대체하는 (Card_Code, Card_Seq) 리스트.
        //   같은 Card_Code 안에서 canonical (DISPLAY_YORN='Y' 우선 → MAX Card_Seq) 선정 후
        //   Card_Name 이 canonical 과 다른 row 만 반환.
        //   ?category=D01|COM → 답례품 카테고리만 필터. 기본은 전체.
        //   ?used=1 → 실제 주문 참조 있는 raw_seq 만 필터 (dashboard 노출되는 케이스).
        const category = String(parsed.query.category || '').trim().toUpperCase();
        const usedOnly = String(parsed.query.used || '') === '1';
        let categoryClause = '';
        if (category === 'D01') categoryClause = `AND c.Card_Div = 'D01'`;
        else if (category === 'COM') categoryClause = `AND c.Card_Code LIKE 'COM[_]%'`;
        else if (category === 'DAERYEPUM') categoryClause = `AND (c.Card_Div = 'D01' OR c.Card_Code LIKE 'COM[_]%')`;
        try {
          const p = await getPool();
          const request = p.request();
          request.timeout = 120000;
          const res = await request.query(`
            WITH mismatched AS (
              SELECT
                c.Card_Code,
                c.Card_Seq AS raw_seq,
                c.Card_Name AS raw_name,
                c.DISPLAY_YORN AS raw_display,
                canon.canonical_seq,
                canon.canonical_name,
                canon.canonical_display
              FROM S2_Card c WITH (NOLOCK)
              CROSS APPLY (
                SELECT TOP 1
                  c2.Card_Seq AS canonical_seq,
                  CASE
                    WHEN c2.Card_Name LIKE '[[]%[]]%'
                      THEN LTRIM(SUBSTRING(c2.Card_Name, CHARINDEX(']', c2.Card_Name) + 1, LEN(c2.Card_Name)))
                    ELSE c2.Card_Name
                  END AS canonical_name,
                  c2.DISPLAY_YORN AS canonical_display
                FROM S2_Card c2 WITH (NOLOCK)
                WHERE c2.Card_Code = c.Card_Code
                  AND LTRIM(RTRIM(ISNULL(c2.Card_Name, ''))) <> ''
                  AND c2.Card_Name NOT LIKE '%사용X%'
                  AND c2.Card_Name NOT LIKE '%사용안함%'
                  AND c2.Card_Name NOT LIKE '%삭제%'
                  AND c2.Card_Name NOT LIKE '%테스트%'
                ORDER BY
                  CASE WHEN c2.DISPLAY_YORN = 'Y' THEN 0 ELSE 1 END,
                  CASE WHEN c2.Card_Name LIKE '[[]%' THEN 1 ELSE 0 END,
                  c2.Card_Seq DESC
              ) canon
              WHERE c.Card_Name <> canon.canonical_name
                ${categoryClause}
            ),
            card_agg AS (
              SELECT coi.card_seq, COUNT(*) AS cnt, MAX(co.order_date) AS max_date
              FROM custom_order_item coi WITH (NOLOCK)
              INNER JOIN custom_order co WITH (NOLOCK) ON coi.order_seq = co.order_seq
              WHERE coi.card_seq IN (SELECT raw_seq FROM mismatched)
              GROUP BY coi.card_seq
            ),
            etc_agg AS (
              SELECT oi.card_seq, COUNT(*) AS cnt, MAX(o.order_date) AS max_date
              FROM CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK)
              INNER JOIN CUSTOM_ETC_ORDER o WITH (NOLOCK) ON oi.order_seq = o.order_seq
              WHERE oi.card_seq IN (SELECT raw_seq FROM mismatched)
              GROUP BY oi.card_seq
            )
            SELECT
              m.Card_Code,
              m.raw_seq,
              m.raw_name,
              m.raw_display,
              m.canonical_seq,
              m.canonical_name,
              m.canonical_display,
              ISNULL(ca.cnt, 0) AS card_orders,
              ISNULL(ea.cnt, 0) AS etc_orders,
              CASE
                WHEN ca.max_date IS NULL AND ea.max_date IS NULL THEN NULL
                WHEN ca.max_date IS NULL THEN ea.max_date
                WHEN ea.max_date IS NULL THEN ca.max_date
                WHEN ca.max_date > ea.max_date THEN ca.max_date
                ELSE ea.max_date
              END AS max_order_date
            FROM mismatched m
            LEFT JOIN card_agg ca ON ca.card_seq = m.raw_seq
            LEFT JOIN etc_agg ea ON ea.card_seq = m.raw_seq
            ${usedOnly ? 'WHERE ISNULL(ca.cnt, 0) + ISNULL(ea.cnt, 0) > 0' : ''}
            ORDER BY m.Card_Code, m.raw_seq
          `);
          const rows = res.recordset || [];
          // Card_Code 별 그룹화 (canonical_name 은 그룹당 1개 고정)
          const groupsByCode = new Map();
          for (const r of rows) {
            if (!groupsByCode.has(r.Card_Code)) {
              groupsByCode.set(r.Card_Code, {
                card_code: r.Card_Code,
                canonical_name: r.canonical_name,
                canonical_seq: r.canonical_seq,
                canonical_display: r.canonical_display,
                mismatched_rows: []
              });
            }
            groupsByCode.get(r.Card_Code).mismatched_rows.push({
              card_seq: r.raw_seq,
              raw_name: r.raw_name,
              display_yorn: r.raw_display,
              card_orders: r.card_orders,
              etc_orders: r.etc_orders,
              total_orders: r.card_orders + r.etc_orders,
              max_order_date: r.max_order_date
            });
          }
          const groups = Array.from(groupsByCode.values());
          data = {
            filter: { category: category || 'ALL', used_only: usedOnly },
            total_groups: groups.length,
            total_mismatched_rows: rows.length,
            groups
          };
        } catch (e) {
          data = { error: e.message };
        }
      } else if (pathname === '/api/artists/card-seq-usage' && req.method === 'GET') {
        // Card_Seq 별 실제 주문 참조 내역 조회.
        //   ?seqs=41765,41767,41769 → 각 Card_Seq 의 CARD/ETC 주문 수 + 기간.
        const seqsStr = String(parsed.query.seqs || '').trim();
        const seqs = seqsStr.split(',').map(s => parseInt(s.trim())).filter(n => n > 0);
        if (!seqs.length) { data = { error: 'seqs 필수 (콤마 구분 정수)' }; }
        else {
          try {
            const p = await getPool();
            const results = [];
            for (const seq of seqs) {
              const res = await p.request().input('seq', sql.Int, seq).query(`
                SELECT
                  (SELECT COUNT(*) FROM custom_order_item WITH (NOLOCK) WHERE card_seq = @seq) AS card_orders,
                  (SELECT COUNT(*) FROM CUSTOM_ETC_ORDER_ITEM WITH (NOLOCK) WHERE card_seq = @seq) AS etc_orders,
                  (SELECT MIN(co.order_date) FROM custom_order co WITH (NOLOCK) INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq WHERE coi.card_seq = @seq) AS card_min_date,
                  (SELECT MAX(co.order_date) FROM custom_order co WITH (NOLOCK) INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq WHERE coi.card_seq = @seq) AS card_max_date,
                  (SELECT MIN(o.order_date) FROM CUSTOM_ETC_ORDER o WITH (NOLOCK) INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq WHERE oi.card_seq = @seq) AS etc_min_date,
                  (SELECT MAX(o.order_date) FROM CUSTOM_ETC_ORDER o WITH (NOLOCK) INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq WHERE oi.card_seq = @seq) AS etc_max_date
              `);
              const r = res.recordset[0] || {};
              results.push({
                card_seq: seq,
                card_orders: r.card_orders || 0,
                etc_orders: r.etc_orders || 0,
                total_orders: (r.card_orders || 0) + (r.etc_orders || 0),
                card_min_date: r.card_min_date,
                card_max_date: r.card_max_date,
                etc_min_date: r.etc_min_date,
                etc_max_date: r.etc_max_date
              });
            }
            data = { results };
          } catch (e) { data = { error: e.message }; }
        }
      } else if (pathname === '/api/artists/card-lookup' && req.method === 'GET') {
        // Card_Code 로 S2_Card + bg_product_settings 동시 조회 — 매핑/캐시 진단.
        //   ?code=TGJBK09O22_A → 정확 매치 + LIKE 매치 + Supabase settings row.
        const code = String(parsed.query.code || '').trim();
        if (!code) { data = { error: 'code 파라미터 필수' }; }
        else {
          try {
            const p = await getPool();
            // S2_Card — 정확 매치 + 유사 매치
            const cardRes = await p.request()
              .input('code', sql.VarChar, code)
              .query(`
                SELECT Card_Code, Card_Name, Card_Seq, Card_Div, Unit_Value
                FROM S2_Card WITH (NOLOCK)
                WHERE Card_Code = @code OR Card_Code LIKE @code + '%'
                ORDER BY
                  CASE WHEN Card_Code = @code THEN 0 ELSE 1 END,
                  Card_Code, Card_Seq
              `);
            const cards = cardRes.recordset || [];
            // Supabase bg_product_settings 조회 — 답례품 대시보드 자체 캐시된 이름 확인
            let productSettings = null;
            try {
              const sr = await fetch(
                `${SUPABASE_URL}/rest/v1/bg_product_settings?product_id=eq.${encodeURIComponent(code)}&select=*`,
                { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
              );
              const arr = await sr.json();
              productSettings = Array.isArray(arr) ? arr : null;
            } catch { productSettings = null; }
            data = {
              query_code: code,
              s2_card_matches: cards,
              s2_card_exact_count: cards.filter(c => c.Card_Code === code).length,
              bg_product_settings: productSettings,
              hint: cards.length === 0
                ? 'S2_Card 에 해당 코드 없음'
                : cards.filter(c => c.Card_Code === code).length > 1
                  ? '⚠️ 동일 Card_Code 여러 row — order 가 잘못된 Card_Seq pointing 가능성'
                  : (productSettings && productSettings.length > 0 && productSettings[0].product_name
                    ? 'bg_product_settings 에 별도 저장된 이름 존재 — 우선 사용될 수 있음'
                    : 'S2_Card 정확 매치 1건 + Supabase 캐시 없음/일치')
            };
          } catch (e) {
            data = { error: e.message };
          }
        }
      } else if (pathname === '/api/artists/order-detail' && req.method === 'GET') {
        // 특정 주문의 매출/point_price 분배 상세 (진단용).
        //   ?order_seq=4750519 → CARD/ETC 자동 감지 + 각 아이템별 매출 계산 breakdown.
        try {
          const orderSeq = parseInt(parsed.query.order_seq || '0');
          if (!orderSeq) { data = { error: 'order_seq 필수' }; }
          else {
            const p = await getPool();
            // Supabase 활성 작가 상품 목록 (매칭 확인용)
            let artistCodes = new Set();
            try {
              const r = await fetch(
                `${SUPABASE_URL}/rest/v1/bg_artist_products?select=product_code&is_active=eq.true`,
                { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
              );
              const arr = await r.json();
              for (const p2 of (Array.isArray(arr) ? arr : [])) {
                artistCodes.add(String(p2.product_code).trim().toUpperCase());
              }
            } catch {}

            // CARD 시도 — 쿠폰/할인 관련 컬럼도 함께 조회
            const cardOrder = await p.request().input('seq', sql.Int, orderSeq).query(`
              SELECT order_seq, order_date, settle_date, src_send_date, status_seq,
                ISNULL(point_price, 0) AS point_price,
                couponseq, addition_couponseq, PB_Coupon,
                discount_rate, discount_in_advance
              FROM custom_order WITH (NOLOCK) WHERE order_seq = @seq
            `);
            const etcOrder = await p.request().input('seq', sql.Int, orderSeq).query(`
              SELECT order_seq, order_date, settle_date, delivery_date, status_seq,
                ISNULL(coupon_price, 0) AS coupon_price
              FROM CUSTOM_ETC_ORDER WITH (NOLOCK) WHERE order_seq = @seq
            `);
            const cardOrderRow = (cardOrder.recordset || [])[0];
            const etcOrderRow = (etcOrder.recordset || [])[0];

            let channel, orderInfo, items;
            if (cardOrderRow) {
              channel = 'CARD';
              orderInfo = cardOrderRow;
              // CARD 쿠폰 조회 — CUSTOM_ORDER_COUPON 테이블 (order_seq 매칭)
              try {
                const couponRes = await p.request().input('seq', sql.Int, orderSeq).query(`
                  SELECT ORDER_COUPON_SEQ, COUPON_ISSUE_SEQ, COUPON_AMT, REG_DATE
                  FROM CUSTOM_ORDER_COUPON WITH (NOLOCK)
                  WHERE ORDER_SEQ = @seq
                `);
                const coupons = couponRes.recordset || [];
                orderInfo.coupons = coupons;
                orderInfo.total_coupon_amt = coupons.reduce((s, c) => s + (c.COUPON_AMT || 0), 0);
              } catch { orderInfo.coupons = []; orderInfo.total_coupon_amt = 0; }
              const itemRes = await p.request().input('seq', sql.Int, orderSeq).query(`
                SELECT coi.item_count, coi.item_sale_price,
                  ISNULL(coi.discount_rate, 0) AS item_discount_rate,
                  coi.CardDiscount_Seq AS item_carddiscount_seq,
                  c.Card_Code, c.Card_Name, c.Card_Div,
                  ISNULL(NULLIF(c.Unit_Value, 0), 1) AS unit_value
                FROM custom_order_item coi WITH (NOLOCK)
                INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
                WHERE coi.order_seq = @seq
              `);
              items = itemRes.recordset || [];
            } else if (etcOrderRow) {
              channel = 'ETC';
              orderInfo = etcOrderRow;
              const itemRes = await p.request().input('seq', sql.Int, orderSeq).query(`
                SELECT oi.order_count AS item_count, oi.card_sale_price AS item_sale_price,
                  c.Card_Code, c.Card_Name, c.Card_Div,
                  ISNULL(NULLIF(c.Unit_Value, 0), 1) AS unit_value
                FROM CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK)
                INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
                WHERE oi.order_seq = @seq
              `);
              items = itemRes.recordset || [];
            } else {
              data = { error: `order_seq=${orderSeq} 를 CARD/ETC 어디에도 찾을 수 없음.` };
            }

            if (!data) {
              // 작가 품목 수 (분배 divisor)
              const artistItems = items.filter(it =>
                artistCodes.has(String(it.Card_Code).trim().toUpperCase())
              );
              const artistItemCount = artistItems.length;
              // CARD 차감액 = point_price + CUSTOM_ORDER_COUPON 합계 / ETC 는 order.coupon_price
              const discountAmount = channel === 'CARD'
                ? (orderInfo.point_price + (orderInfo.total_coupon_amt || 0))
                : orderInfo.coupon_price;
              const perItemShare = artistItemCount > 0 ? discountAmount / artistItemCount : 0;

              // 각 아이템별 breakdown — item 수준 discount_rate/CardDiscount_Seq 도 표시
              const itemsBreakdown = items.map(it => {
                const isArtistItem = artistCodes.has(String(it.Card_Code).trim().toUpperCase());
                const gross = it.item_sale_price * it.item_count / it.unit_value;
                const share = isArtistItem ? perItemShare : 0;
                const net = gross - share;
                return {
                  card_code: it.Card_Code,
                  card_name: it.Card_Name,
                  card_div: it.Card_Div,
                  unit_value: it.unit_value,
                  item_count: it.item_count,
                  item_sale_price: it.item_sale_price,
                  item_discount_rate: it.item_discount_rate || 0,
                  item_carddiscount_seq: it.item_carddiscount_seq || null,
                  is_artist_item: isArtistItem,
                  gross_amount: Math.round(gross),
                  discount_share: Math.round(share),
                  net_amount: Math.round(net)
                };
              });

              data = {
                channel,
                order: orderInfo,
                discount: {
                  type: channel === 'CARD' ? 'point + coupon' : 'coupon_price',
                  point_price: channel === 'CARD' ? (orderInfo.point_price || 0) : 0,
                  coupon_amt_total: channel === 'CARD' ? (orderInfo.total_coupon_amt || 0) : (orderInfo.coupon_price || 0),
                  amount: discountAmount,
                  artist_item_count: artistItemCount,
                  per_item_share: Math.round(perItemShare)
                },
                items: itemsBreakdown,
                totals: {
                  gross: Math.round(itemsBreakdown.reduce((s, x) => s + x.gross_amount, 0)),
                  artist_gross: Math.round(itemsBreakdown.filter(x => x.is_artist_item).reduce((s, x) => s + x.gross_amount, 0)),
                  artist_discount: Math.round(itemsBreakdown.reduce((s, x) => s + x.discount_share, 0)),
                  artist_net: Math.round(itemsBreakdown.filter(x => x.is_artist_item).reduce((s, x) => s + x.net_amount, 0))
                }
              };
            }
          }
        } catch (e) {
          data = { error: e.message };
        }
      } else if (pathname === '/api/artists/coupon-lookup' && req.method === 'GET') {
        // 쿠폰 마스터 테이블 자동 탐색 + 특정 couponseq 조회.
        //   ?couponseq=XXX → 쿠폰 관련 테이블에서 그 seq 매칭 시 실제 금액 컬럼 확인.
        try {
          const p = await getPool();
          // 1. 쿠폰 관련 테이블 이름 후보
          const tblRes = await p.request().query(`
            SELECT TABLE_NAME
            FROM INFORMATION_SCHEMA.TABLES
            WHERE TABLE_TYPE = 'BASE TABLE'
              AND (
                TABLE_NAME LIKE '%COUPON%' OR TABLE_NAME LIKE '%coupon%'
                OR TABLE_NAME LIKE '%DC[_]%' OR TABLE_NAME LIKE '%DISCOUNT%'
                OR TABLE_NAME LIKE '%discount%'
              )
            ORDER BY TABLE_NAME
          `);
          const couponTables = (tblRes.recordset || []).map(r => r.TABLE_NAME);
          // 2. 각 테이블의 컬럼 조사 (couponseq / price 관련)
          const tableSchemas = {};
          for (const t of couponTables) {
            try {
              const cRes = await p.request().input('t', sql.VarChar, t).query(`
                SELECT COLUMN_NAME, DATA_TYPE
                FROM INFORMATION_SCHEMA.COLUMNS
                WHERE TABLE_NAME = @t
                ORDER BY ORDINAL_POSITION
              `);
              tableSchemas[t] = cRes.recordset || [];
            } catch (e) { tableSchemas[t] = { error: e.message }; }
          }
          // 3. couponseq 로 각 테이블 조회 시도 (couponseq 컬럼 있는 테이블만)
          const couponSeq = parsed.query.couponseq;
          const seqLookup = {};
          if (couponSeq) {
            for (const t of couponTables) {
              const cols = Array.isArray(tableSchemas[t]) ? tableSchemas[t] : [];
              const hasCouponSeq = cols.find(c =>
                c.COLUMN_NAME.toLowerCase().includes('couponseq') ||
                c.COLUMN_NAME.toLowerCase() === 'seq'
              );
              if (!hasCouponSeq) continue;
              try {
                const seqCol = hasCouponSeq.COLUMN_NAME;
                // 안전 처리: 테이블/컬럼명 escape
                const safeT = t.replace(/[^A-Za-z0-9_]/g, '');
                const safeCol = seqCol.replace(/[^A-Za-z0-9_]/g, '');
                const rRes = await p.request()
                  .input('cs', sql.VarChar, String(couponSeq))
                  .query(`SELECT TOP 3 * FROM [${safeT}] WITH (NOLOCK) WHERE [${safeCol}] = @cs`);
                if ((rRes.recordset || []).length > 0) {
                  seqLookup[t] = rRes.recordset;
                }
              } catch (e) { /* skip */ }
            }
          }
          data = {
            coupon_tables: couponTables,
            table_schemas: tableSchemas,
            couponseq_query: couponSeq || null,
            seq_lookup: seqLookup
          };
        } catch (e) {
          data = { error: e.message };
        }
      } else if (pathname === '/api/artists/schema-check' && req.method === 'GET') {
        // custom_order / CUSTOM_ETC_ORDER 스키마 조사 — mod_date / coupon 컬럼 실제 이름 확인.
        try {
          const p = await getPool();
          const res = await p.request().query(`
            SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE
            FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_NAME IN ('custom_order', 'custom_order_item', 'CUSTOM_ETC_ORDER', 'CUSTOM_ETC_ORDER_ITEM')
              AND (
                COLUMN_NAME LIKE '%mod%' OR COLUMN_NAME LIKE '%update%'
                OR COLUMN_NAME LIKE '%chg%' OR COLUMN_NAME LIKE '%change%'
                OR COLUMN_NAME LIKE '%edit%' OR COLUMN_NAME LIKE '%regi%'
                OR COLUMN_NAME LIKE '%coupon%' OR COLUMN_NAME LIKE '%dc%'
                OR COLUMN_NAME LIKE '%discount%' OR COLUMN_NAME LIKE '%point%'
                OR COLUMN_NAME LIKE '%date%'
              )
            ORDER BY TABLE_NAME, COLUMN_NAME
          `);
          // 카테고리별 분류
          const rows = res.recordset || [];
          const byTable = {};
          for (const r of rows) {
            if (!byTable[r.TABLE_NAME]) byTable[r.TABLE_NAME] = { date_cols: [], discount_cols: [], other: [] };
            const bucket = byTable[r.TABLE_NAME];
            const col = r.COLUMN_NAME.toLowerCase();
            if (col.includes('coupon') || col.includes('dc') || col.includes('discount') || col.includes('point')) {
              bucket.discount_cols.push({ name: r.COLUMN_NAME, type: r.DATA_TYPE });
            } else if (col.includes('date') || col.includes('mod') || col.includes('update') || col.includes('chg') || col.includes('edit') || col.includes('regi')) {
              bucket.date_cols.push({ name: r.COLUMN_NAME, type: r.DATA_TYPE });
            } else {
              bucket.other.push({ name: r.COLUMN_NAME, type: r.DATA_TYPE });
            }
          }
          data = { tables: byTable, total_columns: rows.length };
        } catch (e) {
          data = { error: e.message };
        }
      } else if (pathname === '/api/artists/settlements/history' && req.method === 'GET') {
        // Phase 4 — 최근 N개월 (default 12) 월별 정산 합계 (전체 + 작가별).
        //   chart 용. 각 월의 apiArtistSettlements 결과를 순차 호출.
        data = await apiArtistSettlementsHistory(parsed.query);
      } else if (pathname === '/api/artists/settlements/confirm' && req.method === 'POST') {
        // Phase 4 — 월 마감 (확정 저장).
        //   Body: { month: 'YYYY-MM' }
        //   해당 월 모든 작가 정산 스냅샷을 bg_artist_settlements 에 upsert.
        const body = await new Promise((resolve) => {
          let raw=''; req.on('data', c=>raw+=c);
          req.on('end', () => { try { resolve(raw?JSON.parse(raw):{}); } catch { resolve({}); } });
        });
        const month = String(body.month || '').match(/^\d{4}-\d{2}$/) ? body.month : null;
        if (!month) data = { error: 'month 형식: YYYY-MM' };
        else data = await apiArtistSettlementsConfirm({ month, confirmedBy: session?.email || 'admin' });
      } else if (pathname === '/api/artists/settlements/confirm' && req.method === 'DELETE') {
        // 월 마감 해제
        const monthQ = parsed.query.month;
        if (!monthQ || !/^\d{4}-\d{2}$/.test(monthQ)) data = { error: 'month 형식: YYYY-MM' };
        else {
          try {
            const r = await fetch(`${SUPABASE_URL}/rest/v1/bg_artist_settlements?month=eq.${monthQ}-01`, {
              method: 'DELETE',
              headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, Prefer: 'return=representation' }
            });
            const j = await r.json().catch(() => ({}));
            if (!r.ok) data = { error: j?.message || '마감 해제 실패' };
            else data = { ok: true, deleted: Array.isArray(j) ? j.length : 0 };
          } catch (e) { data = { error: e.message }; }
        }
      } else if (pathname === '/api/artists/settlements/confirmed' && req.method === 'GET') {
        // 마감 상태 조회 (특정 월 또는 전체)
        try {
          const q = parsed.query.month ? `?month=eq.${parsed.query.month}-01` : '';
          const r = await fetch(`${SUPABASE_URL}/rest/v1/bg_artist_settlements${q}&select=*,bg_artists(name)&order=month.desc,artist_id`.replace('?&', '?'), {
            headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
          });
          const arr = await r.json();
          if (!r.ok) data = { error: arr?.message || '조회 실패', items: [] };
          else data = { items: Array.isArray(arr) ? arr : [] };
        } catch (e) { data = { error: e.message, items: [] }; }
      } else if (pathname === '/api/dashboard/comparison') {
        data = await apiDashboardComparison(parsed.query);
      } else if (pathname === '/api/dashboard/summary') {
        data = await apiDashboardSummary(parsed.query);
      } else if (pathname === '/api/dashboard/express-analysis') {
        data = await apiExpressAnalysis(parsed.query);
      } else if (pathname === '/api/dashboard/by-ship-date') {
        data = await apiDashboardByShipDate(parsed.query);
      } else if (pathname === '/api/dashboard/leadtime-analysis') {
        data = await apiLeadtimeAnalysis(parsed.query);
      } else if (pathname === '/api/dashboard/forecast') {
        data = await apiForecast(parsed.query);
      } else if (pathname === '/api/dashboard/leadtime') {
        data = await apiLeadtime(parsed.query);
      } else if (pathname === '/api/dashboard/marketing') {
        // 방어: apiMarketing 내부 쿼리 하나가 실패해도 전체 500 대신 에러 메시지를 200 으로
        //   반환 (프록시가 500 본문을 "unknown error" 로 마스킹해 원인 파악 불가했음).
        //   프론트는 스키마 불일치 시 이미 graceful skip. 원인 규명 + 콘솔 500 소음 제거 겸용.
        try {
          data = await apiMarketing(parsed.query);
        } catch (mkErr) {
          console.error('[apiMarketing] 실패:', mkErr);
          data = { error: 'marketing 조회 실패: ' + (mkErr && mkErr.message || mkErr), _marketing_failed: true };
        }
      } else if (pathname === '/api/dashboard/marketing/sites') {
        data = await apiMarketingSites(parsed.query);
      } else if (pathname === '/api/dashboard/marketing/reorder') {
        // 방어: 무거운 self-join timeout 등 실패 시 에러 메시지를 200 으로 노출 (프록시 500 마스킹 우회).
        try {
          data = await apiMarketingReorder(parsed.query);
        } catch (roErr) {
          console.error('[apiMarketingReorder] 실패:', roErr);
          data = {
            error: 'reorder 조회 실패',
            _reorder_failed: true,
            message: roErr?.message,
            name: roErr?.name,
            code: roErr?.code,
            number: roErr?.number,
            line: roErr?.lineNumber,
            original: roErr?.originalError?.message
              || roErr?.originalError?.info?.message
              || roErr?.precedingErrors?.[0]?.message
              || null,
          };
        }
      } else if (pathname === '/api/dashboard/marketing/channel') {
        data = await apiMarketingChannel(parsed.query);
      } else if (pathname === '/api/dashboard/conversion') {
        data = await apiConversion(parsed.query);
      } else if (pathname === '/api/dashboard/conversion-window') {
        // 청첩장→답례품 전환율 (예식 윈도우 -14~+7일). 별도 heavy 쿼리라 방어 처리.
        try {
          data = await apiConversionWindow(parsed.query);
        } catch (cwErr) {
          console.error('[apiConversionWindow] 실패:', cwErr);
          data = {
            error: 'conversion-window 실패', _failed: true,
            message: cwErr?.message, code: cwErr?.code, number: cwErr?.number,
            original: cwErr?.originalError?.message || cwErr?.originalError?.info?.message || null,
          };
        }
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
      } else if (pathname === '/api/dashboard/wedding-calendar/site-breakdown') {
        data = await apiWeddingCalendarSiteBreakdown(parsed.query);
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
      } else if (pathname === '/api/debug/purchase-decide-columns') {
        // 구매확정일 관련 컬럼 조사 — custom_order / CUSTOM_ETC_ORDER 스키마 검색
        //   컬럼명에 decide/confirm/purchase/finish/complete/end 포함된 것 반환.
        //   각 컬럼마다 최근 1건 샘플 값도 함께 (NOT NULL 우선).
        logAdminAccess(session, req, 'debug-purchase-columns', {});
        const pp = await getPool();
        const colsRes = await pp.request().query(`
          SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name, DATA_TYPE AS data_type
          FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_NAME IN ('custom_order','CUSTOM_ETC_ORDER')
            AND (LOWER(COLUMN_NAME) LIKE '%confirm%'
              OR LOWER(COLUMN_NAME) LIKE '%decide%'
              OR LOWER(COLUMN_NAME) LIKE '%purchase%'
              OR LOWER(COLUMN_NAME) LIKE '%finish%'
              OR LOWER(COLUMN_NAME) LIKE '%complete%'
              OR LOWER(COLUMN_NAME) LIKE '%end%'
              OR LOWER(COLUMN_NAME) LIKE '%deliver%'
              OR LOWER(COLUMN_NAME) LIKE '%receipt%'
              OR LOWER(COLUMN_NAME) LIKE '%decid%')
          ORDER BY TABLE_NAME, ORDINAL_POSITION
        `);
        const columns = colsRes.recordset || [];
        // 각 컬럼마다 최근 NOT NULL 샘플 하나
        const samples = {};
        for (const c of columns) {
          const key = `${c.table_name}.${c.column_name}`;
          try {
            const rs = await pp.request().query(`
              SELECT TOP 1 [${c.column_name}] AS v, order_seq
              FROM [${c.table_name}] WITH (NOLOCK)
              WHERE [${c.column_name}] IS NOT NULL
              ORDER BY order_seq DESC
            `);
            samples[key] = rs.recordset[0] ? { value: rs.recordset[0].v, order_seq: rs.recordset[0].order_seq } : null;
          } catch (e) { samples[key] = { error: e.message }; }
        }
        // 전체 컬럼 목록도 참고용 (첫 페이지만)
        const allColsRes = await pp.request().query(`
          SELECT TABLE_NAME AS table_name, COUNT(*) AS total_columns
          FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_NAME IN ('custom_order','CUSTOM_ETC_ORDER')
          GROUP BY TABLE_NAME
        `);
        data = {
          matched_columns: columns,
          samples,
          table_summary: allColsRes.recordset,
          hint: 'matched_columns 에 나온 것들이 구매확정 후보. samples 값 (날짜/상태) 확인해서 어느 컬럼이 진짜 구매확정일인지 판단.',
        };
      } else if (pathname === '/api/debug/artist-revenue-verify') {
        // barshop1 raw 매출 vs 정산 API 결과 대조.
        //   기간 + 카드 divisor (default A01=청첩장) 로 raw 매출 집계 후
        //   apiArtistSettlements 결과와 비교.
        //   응답: raw / settlement / diff (raw - settlement).
        //   diff 0 = 완벽 일치. > 0 이면 정산이 매출 누락. < 0 이면 초과 계산.
        logAdminAccess(session, req, 'artist-revenue-verify', {});
        try {
          const div = (parsed.query.div || 'A01').replace(/[^A-Za-z0-9_]/g, '').slice(0, 10);
          const start = parsed.query.start || fmtDate(addDays(today(), -30));
          const end = parsed.query.end || fmtDate(addDays(today(), 1));
          const basis = (parsed.query.basis || 'settle').toLowerCase();
          const dateCol = basis === 'order' ? 'order_date' : 'settle_date';
          const nullClause = basis === 'order' ? '' : ` AND {ALIAS}.${dateCol} IS NOT NULL`;
          // codes 파라미터 — 특정 상품 코드만 필터 (barshop1 리포트 1:1 대조용)
          //   미지정 시 div 전체.
          const codesParam = parsed.query.codes ? String(parsed.query.codes).split(',').map(s => s.trim()).filter(Boolean) : [];
          const codesFilter = codesParam.length
            ? ` AND UPPER(RTRIM(LTRIM(c.Card_Code))) IN (${codesParam.map(c => `'${c.toUpperCase().replace(/'/g, "''")}'`).join(',')})`
            : '';
          const codesFilterX = codesParam.length
            ? ` AND UPPER(RTRIM(LTRIM(c_x.Card_Code))) IN (${codesParam.map(c => `'${c.toUpperCase().replace(/'/g, "''")}'`).join(',')})`
            : '';
          const codesFilterY = codesParam.length
            ? ` AND UPPER(RTRIM(LTRIM(c_y.Card_Code))) IN (${codesParam.map(c => `'${c.toUpperCase().replace(/'/g, "''")}'`).join(',')})`
            : '';
          const pp = await getPool();
          // 1) custom_order (CARD 테이블) — SiteInfo 로 자사몰/제휴사 분리 + point/coupon 별도 SUM
          //    같은 주문 (order_seq) 이 여러 아이템 가지면 point/coupon 중복 SUM 방지 위해
          //    order-level 소계는 별도 서브쿼리로 계산.
          const cardRs = await pp.request()
            .input('s', sql.VarChar, start)
            .input('e', sql.VarChar, end)
            .query(`
              -- A01 주문의 order-level 정보 (order_seq 단위, point/coupon 중복 방지)
              WITH order_level AS (
                SELECT DISTINCT
                  co.order_seq,
                  co.company_Seq,
                  ISNULL(co.point_price, 0) AS point_price,
                  ISNULL(coc.coupon_amt, 0) AS coupon_amt
                FROM custom_order co WITH (NOLOCK)
                INNER JOIN custom_order_item coi_x WITH (NOLOCK) ON co.order_seq = coi_x.order_seq
                INNER JOIN S2_Card c_x WITH (NOLOCK) ON coi_x.card_seq = c_x.Card_Seq
                LEFT JOIN (
                  SELECT ORDER_SEQ, SUM(ISNULL(COUPON_AMT, 0)) AS coupon_amt
                  FROM CUSTOM_ORDER_COUPON WITH (NOLOCK) GROUP BY ORDER_SEQ
                ) coc ON co.order_seq = coc.ORDER_SEQ
                WHERE c_x.Card_Div = '${div}'
                  ${codesFilterX}
                  AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5, 9)
                  ${nullClause.replace('{ALIAS}', 'co')}
                  AND co.${dateCol} >= @s AND co.${dateCol} < @e
              )
              SELECT
                CASE
                  WHEN si.SiteName IS NULL THEN 'affiliate_raw_null'
                  WHEN si.SiteName LIKE '%[^0-9]%' THEN 'card_named'
                  ELSE 'affiliate_numeric'
                END AS bucket,
                COUNT(DISTINCT co.order_seq) AS order_count,
                ISNULL(SUM(coi.item_count), 0) AS total_qty,
                ISNULL(SUM(CAST(coi.item_sale_price AS float) * coi.item_count
                       / ISNULL(NULLIF(c.Unit_Value, 0), 1)), 0) AS gross_amount,
                -- point/coupon 은 order-level (중복 방지 위해 서브쿼리 조인, item 조인 X)
                ISNULL(SUM(ol.point_price) / NULLIF(COUNT(*), 0)
                       * COUNT(DISTINCT co.order_seq), 0) AS point_sum_approx,
                ISNULL(SUM(ol.coupon_amt) / NULLIF(COUNT(*), 0)
                       * COUNT(DISTINCT co.order_seq), 0) AS coupon_sum_approx
              FROM custom_order co WITH (NOLOCK)
              INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
              INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
              LEFT JOIN SiteInfo si WITH (NOLOCK) ON co.company_Seq = si.CompayCode
              INNER JOIN order_level ol ON co.order_seq = ol.order_seq
              WHERE c.Card_Div = '${div}'
                ${codesFilter}
                AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5, 9)
                ${nullClause.replace('{ALIAS}', 'co')}
                AND co.${dateCol} >= @s AND co.${dateCol} < @e
              GROUP BY CASE
                WHEN si.SiteName IS NULL THEN 'affiliate_raw_null'
                WHEN si.SiteName LIKE '%[^0-9]%' THEN 'card_named'
                ELSE 'affiliate_numeric'
              END
            `);
          // 2b) point/coupon 정확 집계 — order-level distinct SUM (item 조인 없이)
          const orderLevelRs = await pp.request()
            .input('s', sql.VarChar, start)
            .input('e', sql.VarChar, end)
            .query(`
              SELECT
                CASE
                  WHEN si.SiteName IS NULL THEN 'affiliate_raw_null'
                  WHEN si.SiteName LIKE '%[^0-9]%' THEN 'card_named'
                  ELSE 'affiliate_numeric'
                END AS bucket,
                COUNT(*) AS order_count_distinct,
                ISNULL(SUM(ISNULL(co.point_price, 0)), 0) AS point_sum,
                ISNULL(SUM(ISNULL(coc.coupon_amt, 0)), 0) AS coupon_sum
              FROM (
                SELECT DISTINCT co_inner.order_seq, co_inner.company_Seq,
                       co_inner.point_price, co_inner.settle_date, co_inner.order_date
                FROM custom_order co_inner WITH (NOLOCK)
                INNER JOIN custom_order_item coi_y WITH (NOLOCK) ON co_inner.order_seq = coi_y.order_seq
                INNER JOIN S2_Card c_y WITH (NOLOCK) ON coi_y.card_seq = c_y.Card_Seq
                WHERE c_y.Card_Div = '${div}'
                  ${codesFilterY}
                  AND co_inner.status_seq >= 2 AND co_inner.status_seq NOT IN (3, 5, 9)
                  ${nullClause.replace('{ALIAS}', 'co_inner')}
                  AND co_inner.${dateCol} >= @s AND co_inner.${dateCol} < @e
              ) co
              LEFT JOIN SiteInfo si WITH (NOLOCK) ON co.company_Seq = si.CompayCode
              LEFT JOIN (
                SELECT ORDER_SEQ, SUM(ISNULL(COUPON_AMT, 0)) AS coupon_amt
                FROM CUSTOM_ORDER_COUPON WITH (NOLOCK) GROUP BY ORDER_SEQ
              ) coc ON co.order_seq = coc.ORDER_SEQ
              GROUP BY CASE
                WHEN si.SiteName IS NULL THEN 'affiliate_raw_null'
                WHEN si.SiteName LIKE '%[^0-9]%' THEN 'card_named'
                ELSE 'affiliate_numeric'
              END
            `);
          // 2) CUSTOM_ETC_ORDER (ETC 테이블) — 참고
          const etcRs = await pp.request()
            .input('s', sql.VarChar, start)
            .input('e', sql.VarChar, end)
            .query(`
              SELECT
                COUNT(DISTINCT o.order_seq) AS order_count,
                ISNULL(SUM(oi.order_count), 0) AS total_qty,
                ISNULL(SUM(CAST(oi.card_sale_price AS float) * oi.order_count
                       / ISNULL(NULLIF(c.Unit_Value, 0), 1)), 0) AS gross_amount
              FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
              INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
              INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
              WHERE c.Card_Div = '${div}'
                ${codesFilter}
                AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 15)
                ${nullClause.replace('{ALIAS}', 'o')}
                AND o.${dateCol} >= @s AND o.${dateCol} < @e
            `);
          // 3) 정산 API 결과 조회 (bg_artist_products 등록 청첩장만 대상이라 raw 와 다를 수 있음)
          const settlement = await apiArtistSettlements({
            start_date: start, end_date: end, basis: basis === 'order' ? 'order' : 'settle',
          });
          const setTotal = settlement?.totals?.total_amount || 0;
          const setCard = (settlement?.by_product || []).reduce((s, p) => s + (p.card_amount || 0), 0);
          const setEtc  = (settlement?.by_product || []).reduce((s, p) => s + (p.etc_amount  || 0), 0);
          // raw 집계 — gross (item 조인 합) + point/coupon (order-level distinct 합)
          const rawBuckets = { card_named: 0, affiliate_numeric: 0, affiliate_raw_null: 0 };
          let rawOrders = 0, rawQty = 0;
          for (const r of cardRs.recordset) {
            rawBuckets[r.bucket] = Math.round(r.gross_amount);
            rawOrders += r.order_count;
            rawQty += r.total_qty;
          }
          // point/coupon 은 order-level SUM (item 조인 없이) — 정확 값
          const pointBuckets = { card_named: 0, affiliate_numeric: 0, affiliate_raw_null: 0 };
          const couponBuckets = { card_named: 0, affiliate_numeric: 0, affiliate_raw_null: 0 };
          for (const r of orderLevelRs.recordset) {
            pointBuckets[r.bucket] = Math.round(r.point_sum);
            couponBuckets[r.bucket] = Math.round(r.coupon_sum);
          }
          const rawCard = rawBuckets.card_named;
          const rawEtc  = rawBuckets.affiliate_numeric + rawBuckets.affiliate_raw_null;
          const cardPoint = pointBuckets.card_named;
          const cardCoupon = couponBuckets.card_named;
          const etcPoint = pointBuckets.affiliate_numeric + pointBuckets.affiliate_raw_null;
          const etcCoupon = couponBuckets.affiliate_numeric + couponBuckets.affiliate_raw_null;
          const cardNet = rawCard - cardPoint - cardCoupon;
          const etcNet  = rawEtc  - etcPoint  - etcCoupon;
          const etcTable = etcRs.recordset[0] || { order_count: 0, total_qty: 0, gross_amount: 0 };
          const rawEtcTable = Math.round(etcTable.gross_amount);
          const grandRaw = rawCard + rawEtc + rawEtcTable;
          data = {
            period: { start, end, basis, div },
            raw_from_barshop1: {
              custom_order: {
                card_named:         { gross: rawCard, point: cardPoint, coupon: cardCoupon, net: cardNet },
                affiliate_numeric:  { gross: rawBuckets.affiliate_numeric, point: pointBuckets.affiliate_numeric, coupon: couponBuckets.affiliate_numeric,
                                      net: rawBuckets.affiliate_numeric - pointBuckets.affiliate_numeric - couponBuckets.affiliate_numeric },
                affiliate_raw_null: { gross: rawBuckets.affiliate_raw_null, point: pointBuckets.affiliate_raw_null, coupon: couponBuckets.affiliate_raw_null,
                                      net: rawBuckets.affiliate_raw_null - pointBuckets.affiliate_raw_null - couponBuckets.affiliate_raw_null },
                orders: rawOrders,
                qty: rawQty,
                subtotal_gross: rawCard + rawEtc,
                subtotal_point: cardPoint + etcPoint,
                subtotal_coupon: cardCoupon + etcCoupon,
                subtotal_net: cardNet + etcNet,
              },
              custom_etc_order: {
                gross: rawEtcTable,
                orders: etcTable.order_count,
                qty: etcTable.total_qty,
              },
              grand_total_gross: grandRaw,
              grand_total_net: cardNet + etcNet + rawEtcTable,
            },
            settlement_api: {
              total_amount: setTotal,
              card_amount_sum: Math.round(setCard),
              etc_amount_sum: Math.round(setEtc),
              product_count_with_sales: (settlement?.by_product || []).filter(p => p.total_amount > 0).length,
            },
            diff: {
              // 정산은 bg_artist_products 등록 상품만 → raw 는 A01 전체이므로 raw > settlement 예상.
              // 정산 net = gross - point - coupon 이 정확하면 raw_card_net_vs_settlement 가 0 근처여야 함.
              raw_gross_minus_settlement_total: grandRaw - setTotal,
              raw_card_gross_vs_settlement_card: rawCard - Math.round(setCard),
              raw_card_net_vs_settlement_card:   cardNet - Math.round(setCard),
              raw_etc_gross_vs_settlement_etc: (rawEtc + rawEtcTable) - Math.round(setEtc),
              raw_etc_net_vs_settlement_etc:   (etcNet + rawEtcTable) - Math.round(setEtc),
              hint: 'net (gross - point - coupon) vs settlement 이 일치해야 정상. gross 차이만 크면 쿠폰/포인트 차감이 원인.',
            },
          };
        } catch (e) { data = { error: e.message, stack: e.stack?.slice(0, 500) }; }
      } else if (pathname === '/api/debug/etc-by-card-div') {
        // CUSTOM_ETC_ORDER 에서 특정 Card_Div (기본 A01=청첩장) 로 판매된 실제 Card_Code 목록.
        //   query: div (default 'A01'), start (default 30일전), end (default 오늘+1), limit (default 100)
        //   response: {rows: [{card_code, card_name, order_count, total_qty, first_date, last_date}]}
        logAdminAccess(session, req, 'etc-by-card-div', {});
        try {
          const div = (parsed.query.div || 'A01').replace(/[^A-Za-z0-9_]/g, '').slice(0, 10);
          const start = parsed.query.start || fmtDate(addDays(today(), -30));
          const end = parsed.query.end || fmtDate(addDays(today(), 1));
          const limit = Math.min(500, parseInt(parsed.query.limit) || 100);
          const pp = await getPool();
          const rs = await pp.request()
            .input('s', sql.VarChar, start)
            .input('e', sql.VarChar, end)
            .query(`
              SELECT TOP ${limit}
                UPPER(RTRIM(LTRIM(c.Card_Code))) AS card_code,
                MAX(c.Card_Name) AS card_name,
                c.Card_Div AS card_div,
                COUNT(DISTINCT o.order_seq) AS order_count,
                ISNULL(SUM(oi.order_count), 0) AS total_qty,
                MIN(o.order_date) AS first_date,
                MAX(o.order_date) AS last_date
              FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
              INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
              INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
              WHERE c.Card_Div = '${div}'
                AND o.status_seq >= 1
                AND o.order_date >= @s AND o.order_date < @e
              GROUP BY UPPER(RTRIM(LTRIM(c.Card_Code))), c.Card_Div
              ORDER BY order_count DESC
            `);
          data = {
            filter: { card_div: div, start, end, limit },
            rows_returned: rs.recordset.length,
            rows: rs.recordset,
            hint: '이 결과가 0 이면 해당 Card_Div 는 CUSTOM_ETC_ORDER 에서 판매 안 됨 = 자사몰 전용 카테고리. 결과가 있으면 어떤 Card_Code 로 판매되는지 목록 확인.',
          };
        } catch (e) { data = { error: e.message }; }
      } else if (pathname === '/api/debug/artist-etc-check') {
        // 청첩장 (or 임의) 코드가 CUSTOM_ETC_ORDER (바른손몰) 에서 실제 판매되는지 진단.
        //   정산 SQL 의 status/settle_date/coupon 계산 문제 배제하고 raw 매출 확인.
        //   query:
        //     codes    쉼표 구분 코드 목록 (없으면 bg_artist_products.is_active=true 전체)
        //     start    YYYY-MM-DD (default 30일 전)
        //     end      YYYY-MM-DD (default 오늘+1일 exclusive)
        //     relax    '1' 이면 status 필터 완화 (>=1 만), settle_date NULL 도 포함
        logAdminAccess(session, req, 'artist-etc-check', {});
        try {
          const start = parsed.query.start || fmtDate(addDays(today(), -30));
          const end = parsed.query.end || fmtDate(addDays(today(), 1));
          const relax = parsed.query.relax === '1';
          let codes = [];
          if (parsed.query.codes) {
            codes = String(parsed.query.codes).split(',').map(s => s.trim()).filter(Boolean);
          } else {
            // Supabase 에서 활성 청첩장 코드 fetch
            const r = await fetch(`${SUPABASE_URL}/rest/v1/bg_artist_products?select=product_code&is_active=eq.true`,
              { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } });
            const arr = await r.json();
            codes = (Array.isArray(arr) ? arr : []).map(p => p.product_code).filter(Boolean);
          }
          if (!codes.length) { data = { error: 'codes 파라미터 또는 활성 청첩장 상품 없음' }; }
          else {
            const codesUpperEscaped = codes.map(c => `'${String(c).trim().toUpperCase().replace(/'/g, "''")}'`).join(',');
            // no_filter 모드 — status/settle/date 필터 완전 제거. Card_Code IN 만 → 진짜 판매 이력 있는지 확인.
            const noFilter = parsed.query.no_filter === '1';
            const statusClause = noFilter ? ''
              : relax ? `AND o.status_seq >= 1`
              : `AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 15)`;
            const settleClause = (noFilter || relax) ? '' : `AND o.settle_date IS NOT NULL`;
            const dateCol = relax ? 'o.order_date' : 'o.settle_date';
            const dateClause = noFilter ? '' : `AND ${dateCol} >= @s AND ${dateCol} < @e`;
            const pp = await getPool();
            const rs = await pp.request()
              .input('s', sql.VarChar, start)
              .input('e', sql.VarChar, end)
              .query(`
                SELECT
                  UPPER(RTRIM(LTRIM(c.Card_Code))) AS product_code,
                  c.Card_Name AS product_name,
                  c.Card_Div AS card_div,
                  COUNT(DISTINCT o.order_seq) AS order_count,
                  ISNULL(SUM(oi.order_count), 0) AS total_qty,
                  ISNULL(SUM(CAST(oi.card_sale_price AS float) * oi.order_count), 0) AS gross_raw,
                  MIN(${dateCol}) AS first_date,
                  MAX(${dateCol}) AS last_date,
                  SUM(CASE WHEN o.settle_date IS NULL THEN 1 ELSE 0 END) AS null_settle_count,
                  SUM(CASE WHEN si.SiteName IS NULL THEN 1 ELSE 0 END) AS site_null_count,
                  SUM(CASE WHEN si.SiteName IS NOT NULL THEN 1 ELSE 0 END) AS site_present_count
                FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
                INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
                INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
                LEFT JOIN SiteInfo si WITH (NOLOCK) ON o.company_Seq = si.CompayCode
                WHERE UPPER(RTRIM(LTRIM(c.Card_Code))) IN (${codesUpperEscaped})
                  ${statusClause}
                  ${settleClause}
                  ${dateClause}
                GROUP BY UPPER(RTRIM(LTRIM(c.Card_Code))), c.Card_Name, c.Card_Div
                ORDER BY order_count DESC
              `);
            // status 분포도 함께 조회 (모든 status_seq, 필터 무관)
            let statusDistribution = [];
            if (noFilter || relax) {
              try {
                const sd = await pp.request().query(`
                  SELECT
                    UPPER(RTRIM(LTRIM(c.Card_Code))) AS product_code,
                    o.status_seq,
                    COUNT(DISTINCT o.order_seq) AS order_count,
                    ISNULL(SUM(oi.order_count), 0) AS total_qty,
                    MIN(o.order_date) AS first_order_date,
                    MAX(o.order_date) AS last_order_date
                  FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
                  INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
                  INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
                  WHERE UPPER(RTRIM(LTRIM(c.Card_Code))) IN (${codesUpperEscaped})
                  GROUP BY UPPER(RTRIM(LTRIM(c.Card_Code))), o.status_seq
                  ORDER BY UPPER(RTRIM(LTRIM(c.Card_Code))), o.status_seq
                `);
                statusDistribution = sd.recordset;
              } catch (e) { /* skip */ }
            }
            data = {
              period: { start, end, dateCol: dateCol.replace('o.', ''), relax, no_filter: noFilter },
              codes_checked: codes.length,
              rows_returned: rs.recordset.length,
              rows: rs.recordset,
              status_distribution: statusDistribution,   // 전 기간 status_seq 별 분포
              hint: noFilter
                ? '필터 완전 제거 — 전체 기간, 취소 포함. Card_Code 매칭만 확인.'
                : relax
                ? '완화 모드 — status_seq>=1, settle_date NULL 포함, 기준일=order_date'
                : '정산 SQL 과 동일 조건 — status_seq 2 이상 정상, settle_date NOT NULL, 기준일=settle_date',
            };
          }
        } catch (e) { data = { error: e.message }; }
      } else if (pathname === '/api/debug/naver-order-raw') {
        // 네이버 detail API 직접 호출 — productOrderId 로 실제 응답 원본 반환.
        //   확정일 필드명 진단용. 저장된 raw_payload 대신 실시간 fetch.
        logAdminAccess(session, req, 'debug-naver-raw', { pid: parsed.query.product_order_id });
        try {
          const pid = String(parsed.query.product_order_id || '').trim();
          if (!pid) { data = { error: 'product_order_id 파라미터 필요' }; }
          else {
            const naverApi = require('./naver/api');
            const stores = naverApi.getStores();
            // 스토어별 시도 — 첫 성공 응답 반환
            for (const st of stores) {
              try {
                const res = await naverApi.queryProductOrders(st, [pid]);
                const arr = res?.data?.contents || res?.data?.productOrders || res?.data || [];
                if (Array.isArray(arr) && arr.length) {
                  const item = arr[0];
                  data = {
                    store_id: st.id,
                    product_order_id: pid,
                    po_keys: Object.keys(item.productOrder || item || {}),
                    order_keys: Object.keys(item.order || {}),
                    productOrder: item.productOrder || item,
                    order: item.order,
                    status: (item.productOrder || item).productOrderStatus,
                    hint: 'productOrder 안 date/Date 로 끝나는 필드 확인 → 어느 게 구매확정일인지 판정.',
                  };
                  break;
                }
              } catch (e) { /* try next store */ }
            }
            if (!data) data = { error: 'productOrderId 로 데이터 없음 (모든 스토어)' };
          }
        } catch (e) { data = { error: e.message }; }
      } else if (pathname === '/api/debug/naver-purchase-decided') {
        // 네이버 구매확정 (PURCHASE_DECIDED) 주문의 raw_payload 조회 — 어떤 필드에 확정 시점이 있는지 진단.
        logAdminAccess(session, req, 'debug-naver-purchase', {});
        try {
          const bgStore = require('./barungift/store');
          if (!bgStore.USE_SUPABASE && !process.env.SUPABASE_URL) {
            data = { error: 'Supabase 미설정' };
          } else {
            const REST = `${process.env.SUPABASE_URL}/rest/v1`;
            const hdr = { apikey: process.env.SUPABASE_ANON_KEY, Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}` };
            const r = await fetch(`${REST}/naver_orders?select=product_order_id,order_id,status,status_label,ordered_at,paid_at,raw_payload,synced_at&status=eq.PURCHASE_DECIDED&order=synced_at.desc&limit=5`, { headers: hdr });
            if (!r.ok) { data = { error: `Supabase [${r.status}]: ${(await r.text()).slice(0,200)}` }; }
            else {
              const rows = await r.json();
              data = { count: rows.length, samples: rows, hint: 'raw_payload 안 decisionDate / purchaseConfirmedDate / completedDate 등 확정 시점 필드 확인' };
            }
          }
        } catch (e) { data = { error: e.message }; }
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
          // custom_order 는 coupon_price/point_price/delivery_price 컬럼 없음 (CUSTOM_ETC_ORDER 와 다른 스키마).
          //   필요한 핵심 필드만 안전하게 조회.
          const card = await pp.request().input('seq', sql.Int, seq).query(`
            SELECT co.order_seq, co.order_date,
              CONVERT(varchar(19), co.settle_date, 120) AS settle_date,
              co.settle_price, co.settle_method, co.settle_status,
              co.company_Seq, co.status_seq, co.order_name, co.member_id,
              co.last_total_price, co.order_total_price,
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
        // 취소 재확인 — 목록 API 가 CANCEL 을 못 돌려주므로 단건 조회로 보완.
        //   skip_reconcile=1 이면 생략 (대량 동기화 시 호출량 절약).
        if (!body.skip_reconcile) {
          try {
            data.reconcile = await coupangSync.reconcileCancelled({
              daysBack: parseInt(body.reconcile_days) || 14,
            });
          } catch (e) {
            data.reconcile = { error: e.message };
          }
        }
        // 로켓그로스 주문은 별도 API 라 위 동기화에 안 잡힌다 — 같은 크론 주기에 함께 가져온다.
        //   이게 없으면 정산 리포트를 올릴 때마다 사람이 '주문 가져오기' 를 눌러야 한다.
        //   실패해도 마켓플레이스 동기화 결과는 그대로 돌려준다.
        if (process.env.COUPANG_RG_SYNC_DISABLED !== '1' && !body.skip_rocket_growth) {
          // 옵션ID → 등록상품ID 맵 먼저 (063). 이게 최신이어야 새 상품의 주문도 코드가 붙는다.
          try {
            data.option_map = await require('./coupang/option-map').syncOptionMap({});
          } catch (e) {
            console.warn('[coupang sync] 옵션맵 갱신 실패:', e.message);
            data.option_map = { error: e.message };
          }
          try {
            const days = Math.min(Math.max(parseInt(body.rg_days_back, 10) || 7, 1), 30);
            const kstYmd = ms => new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 10);
            const nowMs = Date.now();
            data.rocket_growth = await require('./coupang/rg-orders').syncRgOrders({
              startDate: kstYmd(nowMs - days * 86400000),
              endDate: kstYmd(nowMs),
            });
            data.rg_order_status = await require('./coupang/rg-orders')
              .syncRgOrderStatusFromReport({});
          } catch (e) {
            console.warn('[coupang sync] 로켓그로스 주문 수집 실패:', e.message);
            data.rocket_growth = { error: e.message };
          }
        }
      } else if (pathname === '/api/build-info') {
        // 지금 돌고 있는 빌드 확인 — "고쳤는데 안 바뀐다" 가 재배포 누락인지 구분용.
        //   BUILD_SHA/BUILD_TIME 은 Dockerfile ARG 로 주입 (없으면 파일 mtime 으로 대체).
        let mtime = null;
        try { mtime = fs.statSync(path.join(__dirname, 'server.js')).mtime.toISOString(); } catch {}
        data = {
          build_sha: process.env.BUILD_SHA || null,
          build_time: process.env.BUILD_TIME || null,
          server_js_mtime: mtime,
          started_at: _serverStartedAt,
          // 기능 플래그 — 이 빌드에 포함된 최근 변경들 (배포 확인용)
          features: {
            coupang_reconcile_cancelled: true,   // 5484f66
            xerp_direct_stock: true,             // a6a1e45
            manual_order_row_per_item: true,     // 9076848
          },
        };
      } else if (pathname === '/api/coupang/reconcile-cancelled' && req.method === 'POST') {
        // 취소/반품 재확인 단독 실행 — 단건 조회로 DB 상태 보정.
        //   body: { days_back: 14, max_checks: 300 }
        logAdminAccess(session, req, 'coupang-reconcile-cancelled', {});
        const body = await new Promise((resolve) => {
          let raw = ''; req.on('data', c => raw += c);
          req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } });
        });
        const coupangSync = require('./coupang/sync');
        data = await coupangSync.reconcileCancelled({
          daysBack: parseInt(body.days_back) || 14,
          maxChecks: parseInt(body.max_checks) || 300,
        });
      } else if (pathname === '/api/coupang/probe-order') {
        // 특정 주문이 왜 반영 안 되는지 진단.
        //   URL: /api/coupang/probe-order?order_id=28102092215635&days_back=14
        //   ① 단건 조회(/{orderId}/ordersheets) — 상태 무관, 쿠팡의 현재 상태
        //   ② 상태별 목록 조회에서 이 주문이 잡히는 상태 목록
        //   ③ 우리 DB(coupang_orders) 에 저장된 현재 값
        logAdminAccess(session, req, 'coupang-probe-order', parsed.query);
        const coupangApi = require('./coupang/api');
        const orderId = String(parsed.query.order_id || '').trim();
        if (!coupangApi.isConfigured()) { data = { error: 'Coupang API 키 미설정' }; }
        else if (!orderId) { data = { error: 'order_id 필수' }; }
        else {
          const out = { order_id: orderId };
          // ① 단건 조회
          try {
            const sheets = await coupangApi.getOrderSheet(orderId);
            out.single_lookup = sheets.map(s => ({
              shipmentBoxId: s.shipmentBoxId,
              status: s.status,
              orderedAt: s.orderedAt,
              items: (s.orderItems || []).map(i => ({
                vendorItemId: i.vendorItemId,
                vendorItemName: i.vendorItemName,
                cancelCount: i.cancelCount,
                shippingCount: i.shippingCount,
              })),
            }));
          } catch (e) { out.single_lookup_error = e.message; }
          // ② 상태별 목록에서 잡히는지
          const daysBack = parseInt(parsed.query.days_back) || 14;
          const endMs = Date.now();
          const startMs = endMs - daysBack * 86400000;
          out.days_back = daysBack;
          out.found_in_statuses = {};
          const all = [...coupangApi.ORDER_STATUSES, 'CANCEL', 'RETURNS'];
          for (const st of all) {
            try {
              const r = await coupangApi.listOrdersForStatus({ startMs, endMs, status: st });
              const hit = (r.items || []).filter(s => String(s.orderId) === orderId);
              out.found_in_statuses[st] = hit.length
                ? hit.map(s => ({ shipmentBoxId: s.shipmentBoxId, status: s.status }))
                : 0;
            } catch (e) { out.found_in_statuses[st] = `error: ${String(e.message).slice(0, 400)}`; }
          }
          // ③ 우리 DB 현재 값
          try {
            const cs = require('./coupang/store');
            const rows = await cs.listCoupangOrders({ orderIds: [orderId] });
            out.db_rows = (rows || []).map(r => ({
              shipment_box_id: r.shipment_box_id, vendor_item_id: r.vendor_item_id,
              status: r.status, status_label: r.status_label,
              item_count: r.item_count, synced_at: r.synced_at,
            }));
          } catch (e) { out.db_error = e.message; }
          data = out;
        }
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
      } else if (pathname === '/api/cafe24/sync' && req.method === 'POST') {
        // 정수당(카페24) 주문 수동 동기화 — Admin API → Supabase upsert.
        //   body: { since: 'YYYY-MM-DD', days_back: 7 } (옵션, since 우선; 미지정 시 최근 7일)
        logAdminAccess(session, req, 'cafe24-sync', {});
        const body = await new Promise((resolve) => {
          let raw = ''; req.on('data', c => raw += c);
          req.on('end', () => {
            try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
          });
        });
        const cafe24Sync = require('./cafe24/sync');
        let since = body.since || undefined;
        if (!since && body.days_back) {
          since = Date.now() - (parseInt(body.days_back) || 7) * 86400000;
        }
        data = await cafe24Sync.syncCafe24Orders({ since });
      } else if (pathname === '/api/cafe24/version') {
        // 배포 검증/진단용 — 실행 중인 컨테이너에서 실제 파일·로직을 확인.
        const fsx = require('fs'), pathx = require('path');
        let hasVariant = false, syncPasses = false, testCode = null, testName = null, diagErr = null;
        try { hasVariant = /variantCode/.test(fsx.readFileSync(pathx.join(__dirname, 'cafe24/option-parser.js'), 'utf8')); } catch (e) { diagErr = 'op:' + e.message; }
        try { syncPasses = /variantCode:\s*it\.custom_variant_code/.test(fsx.readFileSync(pathx.join(__dirname, 'cafe24/sync.js'), 'utf8')); } catch (e) { diagErr = 'sync:' + e.message; }
        try {
          const { enrichCafe24Item } = require('./cafe24/option-parser');
          const t = enrichCafe24Item({ productCode: 'TGJSD04D1', productName: 't', quantity: 1, optionValue: '스티커 옵션=축하 06', message: 'm', variantCode: 'TGJSD01S7', stickers: [], productSettings: [] });
          testCode = t.sticker_code; testName = t.sticker_name;
        } catch (e) { diagErr = 'enrich:' + e.message; }
        let instHost = '', instSupa = '';
        try { instHost = require('os').hostname(); } catch {}
        try { instSupa = (String(SUPABASE_URL).match(/https?:\/\/([^.]+)/) || [])[1] || ''; } catch {}
        data = { marker: 'cafe24-v7-instance-2026-07-23', instance: { host: instHost, pid: process.pid, supabase: instSupa }, has_variant_code: hasVariant, sync_passes_variant: syncPasses, test_sticker_code: testCode, test_sticker_name: testName, diag_err: diagErr };
        // 실제 fetch + enrich — 배포 sync 경로 그대로 재현해 fetch 응답의 custom_variant_code 확인.
        try {
          const cclient = require('./cafe24/client');
          const { enrichCafe24Item } = require('./cafe24/option-parser');
          const now = new Date();
          const end = now.toISOString().slice(0, 10);
          const start = new Date(now.getTime() - 14 * 86400000).toISOString().slice(0, 10);
          const orders = await cclient.fetchOrders(start, end);
          const o = orders.find(x => String(x.order_id) === '20260722-0000042') || orders[0];
          const it = (o && Array.isArray(o.items) && o.items[0]) || {};
          const rs = enrichCafe24Item({ productCode: it.custom_product_code || it.product_code, productName: it.product_name, quantity: it.quantity, optionValue: it.option_value, message: '', variantCode: it.custom_variant_code, stickers: [], productSettings: [] });
          data.real_fetch = {
            order_id: o && o.order_id,
            fetched_count: orders.length,
            item_keys_has_variant: Object.prototype.hasOwnProperty.call(it, 'custom_variant_code'),
            item_custom_variant_code: it.custom_variant_code,
            item_option_value: it.option_value,
            real_sticker_code: rs.sticker_code,
          };
        } catch (e) { data.real_fetch_err = e.message; }
        // ?run=1 이면 실제 syncCafe24Orders 를 배포 컨테이너에서 실행하고 저장된 stub 을 읽어 반환.
        if (parsed.query.run === '1') {
          try {
            const csync = require('./cafe24/sync');
            const syncResult = await csync.syncCafe24Orders({ since: Date.now() - 7 * 86400000 });
            const ciRes = await fetch(`${SUPABASE_URL}/rest/v1/bg_order_customer_info?order_id=eq.CF-20260722-0000042&select=sticker_selections`, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } });
            const ci = (await ciRes.json())[0];
            data.full_sync_test = {
              sync_result: syncResult,
              stored_sticker_code: ci && ci.sticker_selections && ci.sticker_selections[0] && ci.sticker_selections[0].sticker_code,
            };
          } catch (e) { data.full_sync_err = e.message; }
        }
      } else if (pathname === '/api/cafe24/sync-state') {
        // 마지막 동기화 메타 조회 (관리자 UI 표시용)
        const cafe24Store = require('./cafe24/store');
        data = await cafe24Store.getSyncState();
      } else if (pathname === '/api/cafe24/oauth/callback' && req.method === 'GET') {
        // 카페24 앱 설치/인증 콜백 — code → 토큰 교환 후 저장.
        //   세션 가드(/api/ 블록 상단 auth gate)로 관리자만 접근 가능.
        //   redirect_uri 는 인증 요청 시 사용한 값과 정확히 일치해야 함 (BASE_PATH 프리픽스 포함).
        logAdminAccess(session, req, 'cafe24-oauth-callback', { has_code: !!parsed.query.code });
        const code = String(parsed.query.code || '').trim();
        if (!code) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'code_required', message: '카페24 인증 code 파라미터 없음' }));
          return;
        }
        // redirect_uri: env 우선, 없으면 요청 host + BASE_PATH 로 구성.
        const proto = req.headers['x-forwarded-proto'] || 'https';
        const host = req.headers['x-forwarded-host'] || req.headers.host || '';
        const redirectUri = process.env.CAFE24_REDIRECT_URI
          || `${proto}://${host}${BASE_PATH}/api/cafe24/oauth/callback`;
        try {
          const cafe24Auth = require('./cafe24/auth');
          const result = await cafe24Auth.exchangeAuthCode(code, redirectUri);
          // 성공 → 대시보드로 리다이렉트 (BASE_PATH 프리픽스 유지)
          res.writeHead(302, { Location: `${BASE_PATH || ''}/?cafe24=connected` });
          res.end();
          return;
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'cafe24_oauth_failed', message: e.message, redirect_uri: redirectUri }));
          return;
        }
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
      } else if (pathname === '/api/naver/backfill-confirmed-at' && req.method === 'POST') {
        // 오래된 PURCHASE_DECIDED 주문의 confirmed_at 채우기 — sync 로 안 잡히는
        // 이전 주문들을 productOrderId 로 직접 detail 조회하여 채움.
        //   body: { offset?: number, limit?: number (default 100) }
        //   response: { total, processed, offset_next, remaining, updated, no_change, failed, details }
        logAdminAccess(session, req, 'naver-backfill-confirmed', {});
        const body = await new Promise((resolve) => {
          let raw = ''; req.on('data', c => raw += c);
          req.on('end', () => {
            try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
          });
        });
        const naverSync = require('./naver/sync');
        data = await naverSync.backfillConfirmedAt({
          offset: parseInt(body.offset) || 0,
          limit: parseInt(body.limit) || 100,
          scope: body.scope || 'shippable',             // 기본: 배송중/배송완료/구매확정
          includeAllStatus: !!body.include_all_status,   // true 이면 취소 제외 전체 대상
          alsoUpdateStatus: !!body.also_update_status,   // true 이면 detail 응답 status 로 우리 DB 도 정정
        });
      } else if (pathname === '/api/naver/sync-state') {
        // ?store=<id> 로 특정 스토어 조회. 미지정 시 모든 스토어 sync state 반환.
        const naverStore = require('./naver/store');
        const naverApi = require('./naver/api');
        if (parsed.query.store) {
          data = await naverStore.getSyncState(parsed.query.store);
        } else {
          const stores = naverApi.getStores();
          const states = await naverStore.getSyncState('*');
          data = {
            stores: stores.map(s => ({ id: s.id, name: s.name })),
            states: Array.isArray(states) ? states : (states ? [states] : []),
          };
        }
      } else if (pathname === '/api/naver/debug-auth') {
        // 인증 서명 페이로드 진단 — 토큰 요청 전후 모두 노출.
        //   ?store=<store_id> 로 특정 스토어 선택 (멀티 스토어). 미지정 시 첫 번째.
        logAdminAccess(session, req, 'naver-debug-auth', parsed.query);
        const naverApi = require('./naver/api');
        const stores = naverApi.getStores();
        if (!stores.length) {
          data = { error: 'Naver API 키 미설정 (NAVER_STORES 또는 NAVER_CLIENT_ID/CLIENT_SECRET)' };
        } else {
          const storeId = parsed.query.store || stores[0].id;
          const store = naverApi.getStore(storeId);
          if (!store) {
            data = { error: `store_id=${storeId} 미등록`, available_stores: stores.map(s => s.id) };
          } else {
            const timestamp = Date.now();
            const message = `${store.client_id}_${timestamp}`;
            let signature, signError;
            try {
              signature = naverApi.signClientSecret(store.client_id, timestamp, store.client_secret);
            } catch (e) { signError = e.message; }
            let tokenResult = null;
            try {
              const token = await naverApi.getAccessToken(store);
              tokenResult = { ok: true, token_first_8: String(token).slice(0, 8) + '...', token_length: token.length };
            } catch (e) {
              tokenResult = { ok: false, error: e.message };
            }
            data = {
              store_id: store.id,
              store_name: store.name,
              available_stores: stores.map(s => ({ id: s.id, name: s.name })),
              client_id: store.client_id,
              secret_format: /^\$2[abxy]\$/.test(store.client_secret) ? 'bcrypt ($2x$)' : 'raw',
              secret_length: store.client_secret.length,
              secret_first_8: store.client_secret.slice(0, 8),
              sign_method: /^\$2[abxy]\$/.test(store.client_secret) ? 'bcrypt + base64url(padded)' : 'HMAC-SHA256 + base64url(padded)',
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
        }
      } else if (pathname === '/api/naver/debug-raw') {
        // 네이버 API raw 응답 진단 — 0건 또는 에러 원인 식별용
        // 기본 hours_back=24 (오늘 주문 잡히는지), days_back 도 옵션
        //   ?store=<store_id> 로 특정 스토어 선택. 미지정 시 첫 번째.
        logAdminAccess(session, req, 'naver-debug-raw', parsed.query);
        const naverApi = require('./naver/api');
        const stores = naverApi.getStores();
        if (!stores.length) {
          data = { error: 'Naver API 키 미설정 (NAVER_STORES 또는 NAVER_CLIENT_ID/CLIENT_SECRET)' };
        } else {
          const storeId = parsed.query.store || stores[0].id;
          const store = naverApi.getStore(storeId);
          if (!store) {
            data = { error: `store_id=${storeId} 미등록`, available_stores: stores.map(s => s.id) };
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
                directResult = await naverApi.listProductOrdersDirect(store, { startMs, endMs });
              } catch (e) {
                directError = { message: e.message, status: e.status };
              }
              // 2) 방식 B — last-changed-statuses (참고용 비교)
              const changed = await naverApi.listChangedStatuses(store, { fromMs: startMs, toMs: endMs });
              const lcStatuses = changed.data?.lastChangeStatuses || changed.data || [];
              const ids = Array.isArray(lcStatuses) ? lcStatuses.map(r => r?.productOrderId).filter(Boolean).slice(0, 10) : [];
              data = {
                query: {
                  store_id: store.id,
                  store_name: store.name,
                  hours_back: hoursBack,
                  start_kst: naverApi.fmtKstIso(startMs),
                  end_kst: naverApi.fmtKstIso(endMs),
                  client_id: store.client_id,
                },
                available_stores: stores.map(s => ({ id: s.id, name: s.name })),
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
              data = { error: e.message, store_id: store.id, client_id: store.client_id };
            }
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
      } else if (pathname === '/api/admin/campaign-impact-analysis' && req.method === 'GET') {
        // 캠페인 적용 상품 매출 영향 분석 (캠페인 기간 vs 직전 동기간 비교).
        //   URL: /api/admin/campaign-impact-analysis?codes=TGJBK01D1,TGJBK04D1,...&start=2026-06-11&end=2026-06-18
        if (!isSuperAdmin(session) && !(await hasRole(session, ['admin', 'operator']))) {
          return denyForbidden(res, 'admin/operator 필요');
        }
        const codesRaw = (parsed.query.codes || '').trim();
        const codes = codesRaw.split(',').map(s => s.trim()).filter(Boolean);
        const start = (parsed.query.start || '').trim();
        const end = (parsed.query.end || '').trim();
        if (!codes.length) return json(res, { error: 'codes 인자 필수 (콤마 구분)' }, 400);
        if (codes.length > 20) return json(res, { error: '최대 20개 코드' }, 400);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
          return json(res, { error: 'start/end YYYY-MM-DD' }, 400);
        }
        try {
          const pp = await getPool();
          // 기간 길이 + baseline 계산
          //   prev_offset (기본 0): 0 = 직전 동기간, 1 = 그 전, 2 = 그 전의 그 전
          //   각 offset 만큼 (daysInRange × offset) 일 더 이전으로 baseline 이동.
          const daysInRange = Math.round((new Date(end) - new Date(start)) / 86400000) + 1;
          const prevOffset = Math.max(0, Math.min(10, parseInt(parsed.query.prev_offset, 10) || 0));
          const offsetDays = (prevOffset + 1) * daysInRange;
          const prevEnd = new Date(new Date(start).getTime() - 86400000 - prevOffset * daysInRange * 86400000);
          const prevStart = new Date(prevEnd.getTime() - (daysInRange - 1) * 86400000);
          const fmtKstDate = (d) => d.toISOString().slice(0, 10);
          const prevStartStr = fmtKstDate(prevStart);
          const prevEndStr = fmtKstDate(prevEnd);

          // 매출 조회 — BASE 매칭 (= OR LIKE base[_]%)
          async function fetchRange(s, e) {
            const req = pp.request().input('s', sql.VarChar, s).input('e', sql.VarChar, e);
            const matchClause = codes.map((c, i) => {
              req.input('pc' + i, sql.VarChar, c);
              return `(c.Card_Code = @pc${i} OR c.Card_Code LIKE @pc${i} + '[_]%')`;
            }).join(' OR ');
            const r = await req.query(`
              SELECT order_day, card_code, card_name, SUM(qty) AS qty, SUM(revenue) AS revenue
              FROM (
                SELECT
                  CONVERT(varchar(10), o.order_date, 120) AS order_day,
                  c.Card_Code AS card_code, c.Card_Name AS card_name,
                  oi.order_count AS qty,
                  CAST(oi.card_sale_price AS float) * oi.order_count / ISNULL(NULLIF(c.Unit_Value, 0), 1) AS revenue
                FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
                INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
                INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
                WHERE (${matchClause})
                  AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 15)
                  AND o.order_date >= @s AND o.order_date < DATEADD(day, 1, @e)
                UNION ALL
                SELECT
                  CONVERT(varchar(10), co.order_date, 120),
                  c.Card_Code, c.Card_Name,
                  coi.item_count,
                  CAST(coi.item_sale_price AS float) * coi.item_count / ISNULL(NULLIF(c.Unit_Value, 0), 1)
                FROM custom_order co WITH (NOLOCK)
                INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
                INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
                WHERE (${matchClause})
                  AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5, 9)
                  AND co.order_date >= @s AND co.order_date < DATEADD(day, 1, @e)
              ) t
              GROUP BY order_day, card_code, card_name
              ORDER BY order_day, card_code
            `);
            return r.recordset.map(row => ({
              order_day: row.order_day,
              card_code: row.card_code,
              card_name: row.card_name,
              qty: row.qty || 0,
              revenue: Math.round(row.revenue || 0),
            }));
          }

          // BASE 추출 helper
          const toBase = (code) => {
            if (!code) return code;
            const m = String(code).match(/^(.+)_[A-Za-z0-9]+$/);
            return m ? m[1] : code;
          };
          const cleanName = (n) => String(n || '').replace(/^\[.*?\]\s*/g, '').trim();

          // 집계 helper
          const aggregate = (rows) => {
            const byDay = {};
            const byProduct = {};
            let totalRev = 0, totalQty = 0;
            rows.forEach(r => {
              totalRev += r.revenue;
              totalQty += r.qty;
              if (!byDay[r.order_day]) byDay[r.order_day] = { revenue: 0, qty: 0, orders: 0 };
              byDay[r.order_day].revenue += r.revenue;
              byDay[r.order_day].qty += r.qty;
              // BASE 단위로 상품 그룹
              const base = toBase(r.card_code);
              if (!byProduct[base]) byProduct[base] = { product_code: base, names: new Set(), revenue: 0, qty: 0, variants: new Set() };
              byProduct[base].names.add(cleanName(r.card_name));
              byProduct[base].revenue += r.revenue;
              byProduct[base].qty += r.qty;
              byProduct[base].variants.add(r.card_code);
            });
            return {
              by_day: Object.entries(byDay)
                .map(([order_day, v]) => ({ order_day, ...v, avg_unit_price: v.qty > 0 ? Math.round(v.revenue / v.qty) : 0 }))
                .sort((a, b) => a.order_day.localeCompare(b.order_day)),
              by_product: Object.values(byProduct)
                .map(p => ({
                  product_code: p.product_code,
                  names: [...p.names].filter(Boolean),
                  variants: [...p.variants].sort(),
                  revenue: p.revenue, qty: p.qty,
                  avg_unit_price: p.qty > 0 ? Math.round(p.revenue / p.qty) : 0,
                }))
                .sort((a, b) => b.revenue - a.revenue),
              total_revenue: totalRev,
              total_qty: totalQty,
              total_orders_estimate: rows.length, // 1 row = 1 order_day × card_code 조합
              avg_unit_price: totalQty > 0 ? Math.round(totalRev / totalQty) : 0,
            };
          };

          const [campaignRows, prevRows] = await Promise.all([
            fetchRange(start, end),
            fetchRange(prevStartStr, prevEndStr),
          ]);
          const campaign = aggregate(campaignRows);
          const prev = aggregate(prevRows);

          // delta 계산
          const pctChange = (cur, prv) => prv > 0 ? Math.round((cur - prv) / prv * 1000) / 10 : (cur > 0 ? null : 0);
          // 상품별 비교 (BASE 매칭)
          const prevByProduct = new Map(prev.by_product.map(p => [p.product_code, p]));
          const productDelta = campaign.by_product.map(c => {
            const p = prevByProduct.get(c.product_code);
            const prevRev = p ? p.revenue : 0;
            const prevQty = p ? p.qty : 0;
            const prevUnit = p ? p.avg_unit_price : 0;
            return {
              product_code: c.product_code,
              names: c.names,
              campaign_revenue: c.revenue, prev_revenue: prevRev,
              campaign_qty: c.qty, prev_qty: prevQty,
              campaign_unit_price: c.avg_unit_price, prev_unit_price: prevUnit,
              revenue_delta_pct: pctChange(c.revenue, prevRev),
              qty_delta_pct: pctChange(c.qty, prevQty),
              unit_price_delta_pct: pctChange(c.avg_unit_price, prevUnit),
            };
          });

          // 인사이트
          const topRevDay = campaign.by_day.reduce((a, b) => (b.revenue > (a?.revenue || 0) ? b : a), null);
          const lowRevDay = campaign.by_day.filter(d => d.revenue > 0).reduce((a, b) => (b.revenue < (a?.revenue || Infinity) ? b : a), null);

          data = {
            period: {
              campaign: `${start} ~ ${end}`,
              prev: `${prevStartStr} ~ ${prevEndStr}`,
              days_in_range: daysInRange,
              prev_offset: prevOffset, // 0=직전, 1=그 전, 2=그 전의 그 전
            },
            requested_codes: codes,
            campaign,
            prev,
            delta: {
              revenue_delta_pct: pctChange(campaign.total_revenue, prev.total_revenue),
              qty_delta_pct: pctChange(campaign.total_qty, prev.total_qty),
              unit_price_delta_pct: pctChange(campaign.avg_unit_price, prev.avg_unit_price),
              by_product: productDelta,
            },
            insights: {
              top_revenue_day: topRevDay,
              lowest_revenue_day: lowRevDay,
              campaign_avg_unit_price: campaign.avg_unit_price,
              prev_avg_unit_price: prev.avg_unit_price,
              // 할인 추정 — 평균 단가 감소율 (단순 추정)
              estimated_discount_pct: prev.avg_unit_price > 0 ? Math.round((prev.avg_unit_price - campaign.avg_unit_price) / prev.avg_unit_price * 1000) / 10 : null,
            },
            hint: '캠페인 평균 단가가 전기 대비 낮으면 할인 효과. 수량 ↑ 매출 ↑ 면 캠페인 성공 (price elasticity 작동). 수량 ↑ 매출 ↓ 면 할인 폭이 너무 큼.',
          };
        } catch (err) {
          console.error('[campaign-impact-analysis] error:', err.message);
          data = { error: err.message };
        }
      } else if (pathname === '/api/admin/probe-ci-product-name' && req.method === 'GET') {
        // 정보입력현황 (bg_order_customer_info.sticker_selections JSONB) 의 product_name 패턴 검색.
        //   배경: 매출 SQL 의 S2_Card.Card_Name 은 운영자가 시점별로 prefix 변경 가능 (할인율 등).
        //   고객 입력 시점의 Card_Name 은 sticker_selections 에 그대로 보존됨.
        //   → 캠페인 prefix 가 매출 SQL 에 없어도 sticker_selections 에서는 확인 가능.
        //   URL: /api/admin/probe-ci-product-name?pattern=페스타&start=2026-06-01&end=2026-06-30
        if (!isSuperAdmin(session) && !(await hasRole(session, ['admin', 'operator']))) {
          return denyForbidden(res, 'admin/operator 필요');
        }
        const pattern = (parsed.query.pattern || '').trim();
        if (!pattern) return json(res, { error: 'pattern 인자 필수' }, 400);
        const start = (parsed.query.start || '').trim();
        const end = (parsed.query.end || '').trim();
        if (start && !/^\d{4}-\d{2}-\d{2}$/.test(start)) return json(res, { error: 'start YYYY-MM-DD' }, 400);
        if (end && !/^\d{4}-\d{2}-\d{2}$/.test(end)) return json(res, { error: 'end YYYY-MM-DD' }, 400);
        try {
          const _bgStore = require('./barungift/store');
          // 전체 CI fetch — store.getAllCustomerInfos 는 페이지네이션 자동 처리
          const cis = await _bgStore.getAllCustomerInfos();
          const lowerPattern = pattern.toLowerCase();
          // 기간 필터 — submitted_at 기준 (JS 측 처리)
          const startTs = start ? new Date(start + 'T00:00:00').getTime() : -Infinity;
          const endTs = end ? new Date(end + 'T23:59:59').getTime() : Infinity;
          const matches = [];
          let scannedInPeriod = 0;
          (cis || []).forEach(ci => {
            const sa = ci.submitted_at ? new Date(ci.submitted_at).getTime() : 0;
            if (sa < startTs || sa > endTs) return;
            scannedInPeriod++;
            const sels = ci.sticker_selections || [];
            sels.forEach(sel => {
              const pn = sel?.product_name || '';
              if (pn && pn.toLowerCase().includes(lowerPattern)) {
                matches.push({
                  order_id: ci.order_id,
                  submitted_at: ci.submitted_at,
                  product_code: sel.product_code,
                  product_name: pn,
                  desired_ship_date: sel.desired_ship_date,
                  quantity: sel.quantity,
                });
              }
            });
          });
          // 매칭된 product_code 집계
          const byCode = {};
          matches.forEach(m => {
            if (!byCode[m.product_code]) byCode[m.product_code] = { product_code: m.product_code, names: new Set(), order_ids: new Set(), total_qty: 0 };
            byCode[m.product_code].names.add(m.product_name);
            byCode[m.product_code].order_ids.add(m.order_id);
            byCode[m.product_code].total_qty += (m.quantity || 0);
          });
          const summary = Object.values(byCode)
            .map(v => ({
              product_code: v.product_code,
              product_names: [...v.names],
              order_count: v.order_ids.size,
              total_qty: v.total_qty,
            }))
            .sort((a, b) => b.order_count - a.order_count);
          data = {
            pattern,
            period: (start && end) ? `${start} ~ ${end}` : '(전체)',
            total_cis_in_db: (cis || []).length,
            total_cis_in_period: scannedInPeriod,
            total_matched_selections: matches.length,
            by_product_code: summary,
            samples: matches.slice(0, 30),
            hint: 'sticker_selections 에 캠페인 prefix 가 저장된 시점 = 고객 정보입력 완료 시점. by_product_code 로 어느 상품에 캠페인이 적용됐는지 확인 → 그 product_code 로 매출 SQL 재호출 가능.',
          };
        } catch (err) {
          console.error('[probe-ci-product-name] error:', err.message);
          data = { error: err.message };
        }
      } else if (pathname === '/api/admin/summer-festa-comparison' && req.method === 'GET') {
        // 썸머 99 페스타 prefix 상품 vs 동일 Card_Code 의 다른 (prefix 없는/다른) 상품 매출 비교.
        //   URL: /api/admin/summer-festa-comparison?start=2026-06-11&end=2026-06-18&pattern=썸머
        //   매칭 패턴: pattern 인자 (기본: 썸머) 가 포함된 Card_Name 을 'campaign' 그룹, 나머지 동일 Card_Code = 'baseline'.
        if (!isSuperAdmin(session) && !(await hasRole(session, ['admin', 'operator']))) {
          return denyForbidden(res, 'admin/operator 필요');
        }
        const start = (parsed.query.start || '').trim();
        const end = (parsed.query.end || '').trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
          return json(res, { error: 'start/end YYYY-MM-DD 형식 필수' }, 400);
        }
        const pattern = (parsed.query.pattern || '썸머').trim();
        const patternSafe = pattern.replace(/[\[\]%_]/g, ''); // SQL LIKE 특수문자 제거
        try {
          const pp = await getPool();
          const r = await pp.request()
            .input('s', sql.VarChar, start)
            .input('e', sql.VarChar, end)
            .query(`
              WITH all_orders AS (
                SELECT
                  CONVERT(varchar(10), o.order_date, 120) AS order_day,
                  c.Card_Code, c.Card_Name,
                  oi.order_count AS qty,
                  CAST(oi.card_sale_price AS float) * oi.order_count / ISNULL(NULLIF(c.Unit_Value, 0), 1) AS revenue
                FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
                INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
                INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
                WHERE c.Card_Div = 'D01' AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 15)
                  AND o.order_date >= @s AND o.order_date < DATEADD(day, 1, @e)
                UNION ALL
                SELECT
                  CONVERT(varchar(10), co.order_date, 120),
                  c.Card_Code, c.Card_Name,
                  coi.item_count,
                  CAST(coi.item_sale_price AS float) * coi.item_count / ISNULL(NULLIF(c.Unit_Value, 0), 1)
                FROM custom_order co WITH (NOLOCK)
                INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
                INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
                WHERE c.Card_Div = 'D01' AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5, 9)
                  AND co.order_date >= @s AND co.order_date < DATEADD(day, 1, @e)
              )
              SELECT
                Card_Code, Card_Name,
                CASE WHEN Card_Name LIKE '%${patternSafe}%' THEN 'campaign' ELSE 'baseline' END AS group_label,
                order_day,
                SUM(qty) AS qty,
                SUM(revenue) AS revenue
              FROM all_orders
              GROUP BY Card_Code, Card_Name,
                CASE WHEN Card_Name LIKE '%${patternSafe}%' THEN 'campaign' ELSE 'baseline' END,
                order_day
              ORDER BY Card_Code, order_day
            `);
          const rows = r.recordset.map(row => ({
            card_code: row.Card_Code,
            card_name: row.Card_Name,
            group: row.group_label,
            order_day: row.order_day,
            qty: row.qty || 0,
            revenue: Math.round(row.revenue || 0),
          }));

          // campaign 매칭된 Card_Code 집합 추출 → 같은 Card_Code 의 baseline 만 비교 대상으로 한정
          const campaignCodes = new Set(rows.filter(r => r.group === 'campaign').map(r => r.card_code));
          const campaignRows = rows.filter(r => r.group === 'campaign');
          const baselineRows = rows.filter(r => r.group === 'baseline' && campaignCodes.has(r.card_code));

          // 일자별 합산 (campaign vs baseline)
          const dayAgg = (filtered) => {
            const m = {};
            filtered.forEach(r => {
              if (!m[r.order_day]) m[r.order_day] = { revenue: 0, qty: 0 };
              m[r.order_day].revenue += r.revenue;
              m[r.order_day].qty += r.qty;
            });
            return Object.entries(m).map(([order_day, v]) => ({ order_day, ...v })).sort((a, b) => a.order_day.localeCompare(b.order_day));
          };
          // Card_Code 별 합산
          const codeAgg = (filtered) => {
            const m = {};
            filtered.forEach(r => {
              const key = r.card_code;
              if (!m[key]) m[key] = { card_code: r.card_code, names: new Set(), revenue: 0, qty: 0 };
              m[key].names.add(r.card_name);
              m[key].revenue += r.revenue;
              m[key].qty += r.qty;
            });
            return Object.values(m).map(v => ({ ...v, card_names: [...v.names] })).map(({ names, ...rest }) => rest).sort((a, b) => b.revenue - a.revenue);
          };

          data = {
            period: `${start} ~ ${end}`,
            pattern: patternSafe,
            campaign: {
              card_codes: [...campaignCodes],
              by_day: dayAgg(campaignRows),
              by_card: codeAgg(campaignRows),
              total_revenue: campaignRows.reduce((s, r) => s + r.revenue, 0),
              total_qty: campaignRows.reduce((s, r) => s + r.qty, 0),
            },
            baseline: {
              by_day: dayAgg(baselineRows),
              by_card: codeAgg(baselineRows),
              total_revenue: baselineRows.reduce((s, r) => s + r.revenue, 0),
              total_qty: baselineRows.reduce((s, r) => s + r.qty, 0),
            },
            raw: rows,
            hint: 'campaign = Card_Name LIKE %' + patternSafe + '%, baseline = 같은 Card_Code 의 다른 상품. campaign 매칭 Card_Code 없으면 패턴 조정 필요 (pattern=... 인자).',
          };
        } catch (err) {
          console.error('[summer-festa-comparison] error:', err.message);
          data = { error: err.message };
        }
      } else if (pathname === '/api/admin/probe-guest-order-sites' && req.method === 'GET') {
        // 비회원 (member_id NULL/빈값) 답례품 주문의 주문 사이트 분포.
        //   URL: /api/admin/probe-guest-order-sites?days=90
        if (!isSuperAdmin(session) && !(await hasRole(session, ['admin', 'operator']))) {
          return denyForbidden(res, 'admin/operator 필요');
        }
        const days = parseInt(parsed.query.days, 10) || 90;
        try {
          const pp = await getPool();
          const r = await pp.request().input('days', sql.Int, days).query(`
            SELECT order_site, src, COUNT(DISTINCT order_key) AS guest_orders FROM (
              SELECT
                'ETC' AS src,
                ISNULL(os_si.SiteName, ISNULL(co.COMPANY_NAME, '기타')) AS order_site,
                CONCAT('E', o.order_seq) AS order_key
              FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
              INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
              INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
              LEFT JOIN COMPANY co WITH (NOLOCK) ON o.company_Seq = co.COMPANY_SEQ
              LEFT JOIN SiteInfo os_si ON co.SALES_GUBUN = os_si.SiteCode
              WHERE c.Card_Div = 'D01' AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 15)
                AND o.order_date >= DATEADD(day, -@days, GETDATE())
                AND (o.member_id IS NULL OR LTRIM(RTRIM(CAST(o.member_id AS NVARCHAR(50)))) = '')
              UNION ALL
              SELECT
                'CARD' AS src,
                ISNULL(os_si.SiteName, ISNULL(comp.COMPANY_NAME, '기타')) AS order_site,
                CONCAT('C', cord.order_seq) AS order_key
              FROM custom_order cord WITH (NOLOCK)
              INNER JOIN custom_order_item coi WITH (NOLOCK) ON cord.order_seq = coi.order_seq
              INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
              LEFT JOIN COMPANY comp WITH (NOLOCK) ON cord.company_Seq = comp.COMPANY_SEQ
              LEFT JOIN SiteInfo os_si ON comp.SALES_GUBUN = os_si.SiteCode
              WHERE c.Card_Div = 'D01' AND cord.status_seq >= 2 AND cord.status_seq NOT IN (3, 5, 9)
                AND cord.order_date >= DATEADD(day, -@days, GETDATE())
                AND (cord.member_id IS NULL OR LTRIM(RTRIM(CAST(cord.member_id AS NVARCHAR(50)))) = '')
            ) t
            GROUP BY order_site, src
            ORDER BY guest_orders DESC
          `);
          // 사이트별 합계 + src 분포
          const bySiteTotal = {};
          r.recordset.forEach(row => {
            bySiteTotal[row.order_site] = (bySiteTotal[row.order_site] || 0) + row.guest_orders;
          });
          const total = Object.values(bySiteTotal).reduce((s, v) => s + v, 0);
          const distribution = Object.entries(bySiteTotal)
            .map(([order_site, guest_orders]) => ({
              order_site, guest_orders,
              pct: total > 0 ? Math.round(guest_orders / total * 1000) / 10 : 0,
            }))
            .sort((a, b) => b.guest_orders - a.guest_orders);
          data = {
            days,
            total_guest_orders: total,
            distribution,
            raw_by_src: r.recordset,
          };
        } catch (err) {
          console.error('[probe-guest-order-sites] error:', err.message);
          data = { error: err.message };
        }
      } else if (pathname === '/api/admin/strategy-product-report' && req.method === 'GET') {
        // 운영 전략 메모 언급 상품의 재고/매출/출고 자동 조회 리포트.
        //   URL: /api/admin/strategy-product-report?format=tsv|json&patterns=노슈가,데일리너츠,...
        //   patterns 미지정 시 기본 전략 메모 (2026-06-23) 상품 패턴.
        if (!isSuperAdmin(session) && !(await hasRole(session, ['admin', 'operator']))) {
          return denyForbidden(res, 'admin/operator 필요');
        }
        const format = String(parsed.query.format || 'json').toLowerCase();
        const patternsRaw = (parsed.query.patterns || '').trim();
        const defaultPatterns = [
          '노슈가', '데일리너츠', '하루간식', '생활공작소', '주방세제',
          '레몬', '올리브', '소금', '핸드워시', '호두정과', '비타민', '꿀'
        ];
        const patterns = patternsRaw
          ? patternsRaw.split(',').map(s => s.trim()).filter(Boolean)
          : defaultPatterns;
        try {
          const pp = await getPool();
          const todayDate = today();
          const todayStr = fmtDate(todayDate);
          const prev30 = fmtDate(addDays(todayDate, -30));
          const prev90 = fmtDate(addDays(todayDate, -90));
          const todayPlus1 = fmtDate(addDays(todayDate, 1));
          const nextEnd = fmtDate(addDays(todayDate, 30));
          const toBase = (code) => {
            if (!code) return code;
            const m = String(code).match(/^(.+)_[A-Za-z0-9]+$/);
            return m ? m[1] : code;
          };
          const cleanCardName = (n) => String(n || '').replace(/^\[.*?\]\s*/g, '').trim();

          // 1) 패턴별 상품 매칭 (S2_Card.Card_Name LIKE)
          const productMap = new Map();
          for (const pattern of patterns) {
            const safePat = pattern.replace(/[\[\]%_]/g, '');
            const r = await pp.request()
              .input('pat', sql.NVarChar, `%${safePat}%`)
              .query(`
                SELECT Card_Code, Card_Name
                FROM S2_Card WITH (NOLOCK)
                WHERE (Card_Div = 'D01' OR Card_Code LIKE 'COM[_]%')
                  AND Card_Name LIKE @pat
                  AND Card_Code IS NOT NULL AND Card_Code <> ''
              `);
            r.recordset.forEach(row => {
              const base = toBase(row.Card_Code);
              if (!productMap.has(base)) productMap.set(base, {
                base_code: base, names: new Set(), raw_codes: new Set(), patterns: new Set(),
              });
              const p = productMap.get(base);
              p.names.add(cleanCardName(row.Card_Name));
              p.raw_codes.add(row.Card_Code);
              p.patterns.add(pattern);
            });
          }

          if (productMap.size === 0) {
            data = { patterns, total_matched: 0, products: [], hint: '매칭된 상품 없음. patterns 인자 조정 필요.' };
          } else {
            // 2) 재고 (S2_CARD_ERP_STOCK)
            const stockRows = await pp.request().query(`
              SELECT CARD_CODE, ISNULL(INVENTORY_CURRENT_QTY, 0) AS cur, ISNULL(INVENTORY_AVAILABLE_QTY, 0) AS avail
              FROM S2_CARD_ERP_STOCK WITH (NOLOCK)
            `);
            const stockMap = new Map();
            stockRows.recordset.forEach(r => {
              const base = toBase(r.CARD_CODE);
              if (!productMap.has(base)) return;
              if (!stockMap.has(base)) stockMap.set(base, { current: 0, available: 0 });
              const s = stockMap.get(base);
              s.current += r.cur;
              s.available += r.avail;
            });

            // 3) 매출 SQL helper (settle_date 기준)
            const fetchSales = async (startStr) => {
              const r = await pp.request()
                .input('s', sql.VarChar, startStr)
                .input('e', sql.VarChar, todayPlus1)
                .query(`
                  SELECT card_code, SUM(qty) AS qty, SUM(revenue) AS revenue
                  FROM (
                    SELECT c.Card_Code AS card_code,
                      CAST(coi.item_sale_price AS float) * coi.item_count / ISNULL(NULLIF(c.Unit_Value, 0), 1) AS revenue,
                      coi.item_count AS qty
                    FROM custom_order co WITH (NOLOCK)
                    INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
                    INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
                    WHERE (c.Card_Div = 'D01' OR c.Card_Code LIKE 'COM[_]%')
                      AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5, 9)
                      AND co.settle_date IS NOT NULL
                      AND co.settle_date >= @s AND co.settle_date < @e
                    UNION ALL
                    SELECT c.Card_Code,
                      ${ETC_AMOUNT_EXPR},
                      oi.order_count
                    FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
                    INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
                    INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
                    LEFT JOIN SiteInfo si WITH (NOLOCK) ON o.company_Seq = si.CompayCode
                    ${ETC_COUPON_DIVISOR_JOIN_D01}
                    WHERE (c.Card_Div = 'D01' OR c.Card_Code LIKE 'COM[_]%')
                      AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 15)
                      AND o.settle_date IS NOT NULL
                      AND o.settle_date >= @s AND o.settle_date < @e
                  ) t
                  GROUP BY card_code
                `);
              const map = new Map();
              r.recordset.forEach(row => {
                const base = toBase(row.card_code);
                if (!productMap.has(base)) return;
                if (!map.has(base)) map.set(base, { qty: 0, revenue: 0 });
                const s = map.get(base);
                s.qty += row.qty || 0;
                s.revenue += Math.round(row.revenue || 0);
              });
              return map;
            };
            const sales30Map = await fetchSales(prev30);
            const sales90Map = await fetchSales(prev90);

            // 4) 출고 (sticker_selections)
            const _bgStore = require('./barungift/store');
            let cis = [];
            try { cis = await _bgStore.getAllCustomerInfos(); }
            catch (e) { console.warn('[strategy-report] CIs failed:', e.message); }
            const shipMap = new Map();
            (cis || []).forEach(ci => {
              (ci.sticker_selections || []).forEach(sel => {
                const code = sel.product_code;
                if (!code) return;
                const base = toBase(code);
                if (!productMap.has(base)) return;
                const dshp = sel.desired_ship_date;
                const qty = sel.quantity || 0;
                if (!dshp || !qty) return;
                if (!shipMap.has(base)) shipMap.set(base, { prev: 0, today: 0, next: 0 });
                const s = shipMap.get(base);
                if (dshp >= prev30 && dshp < todayStr) s.prev += qty;
                else if (dshp === todayStr) s.today += qty;
                else if (dshp > todayStr && dshp <= nextEnd) s.next += qty;
              });
            });

            // 결과 정리
            const products = [...productMap.values()].map(p => {
              const stock = stockMap.get(p.base_code) || { current: 0, available: 0 };
              const s30 = sales30Map.get(p.base_code) || { qty: 0, revenue: 0 };
              const s90 = sales90Map.get(p.base_code) || { qty: 0, revenue: 0 };
              const ship = shipMap.get(p.base_code) || { prev: 0, today: 0, next: 0 };
              const namesList = [...p.names].filter(Boolean);
              const bestName = namesList.sort((a, b) => a.length - b.length)[0] || '';
              return {
                base_code: p.base_code,
                name: bestName,
                matched_patterns: [...p.patterns].join('/'),
                variant_count: p.raw_codes.size,
                current_qty: stock.current,
                available_qty: stock.available,
                sales_30d_qty: s30.qty,
                sales_30d_revenue: s30.revenue,
                sales_90d_qty: s90.qty,
                sales_90d_revenue: s90.revenue,
                ship_prev_month: ship.prev,
                ship_today: ship.today,
                ship_next_month: ship.next,
                // 회전율 추정 — 가용재고가 30일 매출 수량의 몇 배인지 (큰 값 = 재고 과잉)
                stock_to_sales_ratio: s30.qty > 0 ? Math.round(stock.available / s30.qty * 100) / 100 : null,
              };
            }).sort((a, b) => {
              // 정렬: 매칭 패턴 순서 → 재고 큰 순
              return b.current_qty - a.current_qty;
            });

            if (format === 'tsv') {
              const lines = [];
              lines.push([
                '매칭 패턴', 'BASE 품목코드', '상품명', '변형 개수',
                '현 재고', '가용 재고',
                '30일 수량', '30일 매출', '90일 수량', '90일 매출',
                '직전 30일 출고', '오늘 출고', '이후 30일 출고',
                '재고/매출 회전 (배)',
              ].join('\t'));
              products.forEach(p => {
                lines.push([
                  p.matched_patterns, p.base_code, p.name, p.variant_count,
                  p.current_qty, p.available_qty,
                  p.sales_30d_qty, p.sales_30d_revenue, p.sales_90d_qty, p.sales_90d_revenue,
                  p.ship_prev_month, p.ship_today, p.ship_next_month,
                  p.stock_to_sales_ratio === null ? '-' : p.stock_to_sales_ratio,
                ].join('\t'));
              });
              res.writeHead(200, {
                'Content-Type': 'text/tab-separated-values; charset=utf-8',
                'Content-Disposition': `inline; filename="strategy-report-${todayStr}.tsv"`,
              });
              res.end(lines.join('\n'));
              return;
            }
            data = {
              generated_at: new Date().toISOString(),
              patterns,
              total_matched: products.length,
              products,
              hint: 'stock_to_sales_ratio > 3 (3개월치 이상 재고): 재고 과잉 의심. ship_today + next: 예약 출고로 자연 소진 예상.',
            };
          }
        } catch (err) {
          console.error('[strategy-product-report] error:', err.message);
          data = { error: err.message };
        }
      } else if (pathname === '/api/admin/sales-report-by-site-time' && req.method === 'GET') {
        // 답례품 BASE 품목코드별 사이트/시간단위 매출 리포트 — TSV(스프레드시트 paste) 지원.
        //   URL: /api/admin/sales-report-by-site-time?view=daily|weekly|monthly|ship&format=tsv|json&days=N
        //   재고 제외 (사용자 요청 2026-06-23). 4개 사이트 (바른손카드/몰/쿠팡/네이버) + 기타.
        if (!isSuperAdmin(session) && !(await hasRole(session, ['admin', 'operator']))) {
          return denyForbidden(res, 'admin/operator 필요');
        }
        const format = String(parsed.query.format || 'json').toLowerCase();
        const view = String(parsed.query.view || 'daily').toLowerCase();
        const defaultDays = { daily: 90, weekly: 84, monthly: 365, ship: 60 }[view] || 90;
        const days = Math.max(1, Math.min(730, parseInt(parsed.query.days, 10) || defaultDays));
        try {
          const pp = await getPool();
          const todayDate = today();
          const todayStr = fmtDate(todayDate);
          const startStr = fmtDate(addDays(todayDate, -days));
          const endExclStr = fmtDate(addDays(todayDate, 1));

          const toBase = (code) => {
            if (!code) return code;
            const m = String(code).match(/^(.+)_[A-Za-z0-9]+$/);
            return m ? m[1] : code;
          };
          const cleanCardName = (n) => String(n || '').replace(/^\[.*?\]\s*/g, '').trim();

          // 사이트 그룹화 (사용자 정책 2026-06-23):
          //   바른손카드 = 자사몰 (별도)
          //   제휴몰 = 바른손몰 + 기타 모든 외부 제휴사 (운영팀이 바른손몰을 제휴몰로 분류)
          //   쿠팡 / 네이버 = 별도
          const MAIN_SITES = ['바른손카드', '제휴몰', '쿠팡', '네이버'];
          const mapSite = (s) => {
            // 네이버 멀티 스토어 라벨 ('네이버(바른손카드)' 등) → '네이버' 통합
            const norm = normalizeNaverSite(s);
            if (norm === '쿠팡 로켓그로스') return '쿠팡';   // 사이트 그룹은 쿠팡으로 합친다
            if (norm === '바른손카드' || norm === '쿠팡' || norm === '네이버') return norm;
            return '제휴몰'; // 바른손몰 포함 모든 제휴 채널 통합
          };

          let rows = [];

          if (view === 'ship') {
            // 출고일별 — sticker_selections.desired_ship_date 기준
            //   매출은 sticker_selections 에 없으므로 수량만. 매출 필요하면 매출 SQL 별도 매칭.
            //   기간: 직전 days 일 ~ 미래 days/2 일 (예약 출고 포함)
            const nextEndStr = fmtDate(addDays(todayDate, Math.floor(days / 2)));
            const _bgStore = require('./barungift/store');
            let cis = [];
            try { cis = await _bgStore.getAllCustomerInfos(); }
            catch (e) { console.warn('[sales-report] CIs fetch failed:', e.message); }
            const aggMap = new Map(); // key: ship_date|base → {qty, name}
            (cis || []).forEach(ci => {
              (ci.sticker_selections || []).forEach(sel => {
                const dshp = sel.desired_ship_date;
                if (!dshp || dshp < startStr || dshp > nextEndStr) return;
                const code = sel.product_code;
                if (!code) return;
                const base = toBase(code);
                const key = `${dshp}|${base}`;
                if (!aggMap.has(key)) aggMap.set(key, {
                  ship_date: dshp, base_code: base, name: sel.product_name, qty: 0,
                });
                aggMap.get(key).qty += (sel.quantity || 0);
              });
            });
            rows = [...aggMap.values()]
              .map(r => ({
                ship_date: r.ship_date,
                base_code: r.base_code,
                name: cleanCardName(r.name),
                qty: r.qty,
              }))
              .filter(r => r.qty > 0)
              .sort((a, b) => a.ship_date.localeCompare(b.ship_date) || a.base_code.localeCompare(b.base_code));
          } else {
            // settle_date 기준 — daily/weekly/monthly
            //   weekly: 주 시작일 (월요일 기준) ISO 주차
            //   monthly: YYYY-MM
            const periodSql = view === 'daily'
              ? `CONVERT(varchar(10), {DATE}, 120)`
              : view === 'weekly'
                ? `CONVERT(varchar(10), DATEADD(week, DATEDIFF(week, 0, {DATE}), 0), 120)`
                : `CONVERT(varchar(7), {DATE}, 120)`;
            const result = await pp.request()
              .input('s', sql.VarChar, startStr)
              .input('e', sql.VarChar, endExclStr)
              .query(`
                SELECT period, card_code, card_name, site_name,
                       SUM(qty) AS qty, SUM(revenue) AS revenue
                FROM (
                  SELECT ${periodSql.replace(/\{DATE\}/g, 'co.settle_date')} AS period,
                         c.Card_Code AS card_code, c.Card_Name AS card_name,
                         ISNULL(si.SiteName, ISNULL(comp.COMPANY_NAME, '기타')) AS site_name,
                         CAST(coi.item_sale_price AS float) * coi.item_count / ISNULL(NULLIF(c.Unit_Value, 0), 1) AS revenue,
                         coi.item_count AS qty
                  FROM custom_order co WITH (NOLOCK)
                  INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
                  INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
                  LEFT JOIN COMPANY comp WITH (NOLOCK) ON co.company_Seq = comp.COMPANY_SEQ
                  LEFT JOIN SiteInfo si ON comp.SALES_GUBUN = si.SiteCode
                  WHERE (c.Card_Div = 'D01' OR c.Card_Code LIKE 'COM[_]%')
                    AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5, 9)
                    AND co.settle_date IS NOT NULL
                    AND co.settle_date >= @s AND co.settle_date < @e
                  UNION ALL
                  SELECT ${periodSql.replace(/\{DATE\}/g, 'o.settle_date')},
                         c.Card_Code, c.Card_Name,
                         ISNULL(si.SiteName, '기타'),
                         ${ETC_AMOUNT_EXPR},
                         oi.order_count
                  FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
                  INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
                  INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
                  LEFT JOIN SiteInfo si WITH (NOLOCK) ON o.company_Seq = si.CompayCode
                  ${ETC_COUPON_DIVISOR_JOIN_D01}
                  WHERE (c.Card_Div = 'D01' OR c.Card_Code LIKE 'COM[_]%')
                    AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 15)
                    AND o.settle_date IS NOT NULL
                    AND o.settle_date >= @s AND o.settle_date < @e
                ) t
                GROUP BY period, card_code, card_name, site_name
                ORDER BY period, card_code
              `);
            // BASE + 사이트 정규화
            const aggMap = new Map(); // period|base|site
            result.recordset.forEach(r => {
              const base = toBase(r.card_code);
              const site = mapSite(r.site_name);
              const key = `${r.period}|${base}|${site}`;
              if (!aggMap.has(key)) aggMap.set(key, {
                period: r.period, site, base_code: base, name: r.card_name, qty: 0, revenue: 0,
              });
              const agg = aggMap.get(key);
              agg.qty += (r.qty || 0);
              agg.revenue += Math.round(r.revenue || 0);
            });
            const siteOrder = MAIN_SITES; // 기타는 모두 제휴몰로 흡수됨
            rows = [...aggMap.values()]
              .map(r => ({
                period: r.period, site: r.site, base_code: r.base_code,
                name: cleanCardName(r.name), qty: r.qty, revenue: r.revenue,
              }))
              .filter(r => r.qty > 0 || r.revenue > 0)
              .sort((a, b) =>
                a.period.localeCompare(b.period) ||
                siteOrder.indexOf(a.site) - siteOrder.indexOf(b.site) ||
                a.base_code.localeCompare(b.base_code)
              );
          }

          // TSV 응답 (구글 시트 paste 용)
          if (format === 'tsv') {
            let tsv;
            if (view === 'ship') {
              tsv = ['출고일자\tBASE품목코드\t상품명\t수량'].concat(
                rows.map(r => `${r.ship_date}\t${r.base_code}\t${r.name}\t${r.qty}`)
              ).join('\n');
            } else {
              const periodLabel = view === 'daily' ? '일자' : view === 'weekly' ? '주차시작' : '월';
              tsv = [`${periodLabel}\t사이트\tBASE품목코드\t상품명\t수량\t매출`].concat(
                rows.map(r => `${r.period}\t${r.site}\t${r.base_code}\t${r.name}\t${r.qty}\t${r.revenue}`)
              ).join('\n');
            }
            res.writeHead(200, {
              'Content-Type': 'text/tab-separated-values; charset=utf-8',
              'Content-Disposition': `inline; filename="sales-${view}-${todayStr}.tsv"`,
            });
            res.end(tsv);
            return;
          }

          data = {
            view, days,
            period: `${startStr} ~ ${todayStr}`,
            total_rows: rows.length,
            sites: MAIN_SITES, // 바른손카드 / 제휴몰 / 쿠팡 / 네이버 (기타는 모두 제휴몰로 흡수)
            rows,
            hint: 'format=tsv 추가하면 구글 시트에 paste 가능한 TSV 응답. view=daily|weekly|monthly|ship 각각 호출 후 시트에 paste.',
          };
        } catch (err) {
          console.error('[sales-report-by-site-time] error:', err.message);
          data = { error: err.message };
        }
      } else if (pathname === '/api/admin/product-summary-report' && req.method === 'GET') {
        // 답례품 BASE 품목코드별 종합 리포트 (재고 + 출고수량 + 매출).
        //   URL: /api/admin/product-summary-report?format=json|excel
        //   재고 출처: S2_CARD_ERP_STOCK (운영자 확인 2026-06-23)
        //   출고일 기준: sticker_selections.desired_ship_date (정보입력 완료)
        //   매출: settle_date 기준 직전 30일, 결제 완료 status만 (NOT IN 3,5,9 / 15)
        if (!isSuperAdmin(session) && !(await hasRole(session, ['admin', 'operator']))) {
          return denyForbidden(res, 'admin/operator 필요');
        }
        const format = String(parsed.query.format || 'json').toLowerCase();
        try {
          const pp = await getPool();
          const todayDate = today();
          const todayStr = fmtDate(todayDate);
          const prevStart = fmtDate(addDays(todayDate, -30));
          const todayPlus1 = fmtDate(addDays(todayDate, 1));
          const nextEnd = fmtDate(addDays(todayDate, 30));

          // BASE 코드 추출 (_XXX suffix 1단 제거)
          const toBase = (code) => {
            if (!code) return code;
            const m = String(code).match(/^(.+)_[A-Za-z0-9]+$/);
            return m ? m[1] : code;
          };
          const cleanCardName = (n) => String(n || '').replace(/^\[.*?\]\s*/g, '').trim();

          // 1) 답례품 상품 마스터
          const productsRaw = await pp.request().query(`
            SELECT Card_Code, Card_Name
            FROM S2_Card WITH (NOLOCK)
            WHERE (Card_Div = 'D01' OR Card_Code LIKE 'COM[_]%')
              AND Card_Code IS NOT NULL AND Card_Code <> ''
          `);

          // 2) 재고 (S2_CARD_ERP_STOCK)
          const stockRaw = await pp.request().query(`
            SELECT CARD_CODE AS card_code,
                   ISNULL(INVENTORY_CURRENT_QTY, 0) AS current_qty,
                   ISNULL(INVENTORY_AVAILABLE_QTY, 0) AS available_qty,
                   ISNULL(TOTAL_SALE_PRICE_30_DAY, 0) AS sales_30d
            FROM S2_CARD_ERP_STOCK WITH (NOLOCK)
          `);

          // 3) 매출 (직전 30일, settle_date 기준, 결제완료 상태만)
          const salesRaw = await pp.request()
            .input('s', sql.VarChar, prevStart)
            .input('e', sql.VarChar, todayPlus1)
            .query(`
              SELECT card_code, settle_day, site_name,
                     SUM(revenue) AS revenue, SUM(qty) AS qty
              FROM (
                SELECT c.Card_Code AS card_code,
                       CONVERT(varchar(10), co.settle_date, 120) AS settle_day,
                       ISNULL(si.SiteName, ISNULL(comp.COMPANY_NAME, '기타')) AS site_name,
                       CAST(coi.item_sale_price AS float) * coi.item_count / ISNULL(NULLIF(c.Unit_Value, 0), 1) AS revenue,
                       coi.item_count AS qty
                FROM custom_order co WITH (NOLOCK)
                INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
                INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
                LEFT JOIN COMPANY comp WITH (NOLOCK) ON co.company_Seq = comp.COMPANY_SEQ
                LEFT JOIN SiteInfo si ON comp.SALES_GUBUN = si.SiteCode
                WHERE (c.Card_Div = 'D01' OR c.Card_Code LIKE 'COM[_]%')
                  AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5, 9)
                  AND co.settle_date IS NOT NULL
                  AND co.settle_date >= @s AND co.settle_date < @e
                UNION ALL
                SELECT c.Card_Code,
                       CONVERT(varchar(10), o.settle_date, 120),
                       ISNULL(si.SiteName, '기타'),
                       ${ETC_AMOUNT_EXPR},
                       oi.order_count
                FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
                INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
                INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
                LEFT JOIN SiteInfo si WITH (NOLOCK) ON o.company_Seq = si.CompayCode
                ${ETC_COUPON_DIVISOR_JOIN_D01}
                WHERE (c.Card_Div = 'D01' OR c.Card_Code LIKE 'COM[_]%')
                  AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 15)
                  AND o.settle_date IS NOT NULL
                  AND o.settle_date >= @s AND o.settle_date < @e
              ) t
              GROUP BY card_code, settle_day, site_name
            `);

          // 4) Supabase — sticker_selections 의 desired_ship_date
          const _bgStore = require('./barungift/store');
          let cis = [];
          try { cis = await _bgStore.getAllCustomerInfos(); }
          catch (e) { console.warn('[product-summary] CIs fetch failed:', e.message); }

          // === BASE 단위 집계 ===
          const byBase = new Map();
          // 상품 마스터
          productsRaw.recordset.forEach(r => {
            const base = toBase(r.Card_Code);
            if (!byBase.has(base)) {
              byBase.set(base, {
                base_code: base, card_name: cleanCardName(r.Card_Name),
                variants: new Set(),
                current_qty: 0, available_qty: 0, sales_30d_erp: 0,
                ship_prev: 0, ship_today: 0, ship_next: 0,
                rev_by_day: new Map(), rev_by_site: new Map(),
                total_rev_30d: 0, total_qty_30d: 0,
              });
            }
            const p = byBase.get(base);
            p.variants.add(r.Card_Code);
            const cleaned = cleanCardName(r.Card_Name);
            if (cleaned && (!p.card_name || (cleaned.length < p.card_name.length && !cleaned.startsWith('[')))) {
              p.card_name = cleaned;
            }
          });
          // 재고
          stockRaw.recordset.forEach(r => {
            const base = toBase(r.card_code);
            const p = byBase.get(base);
            if (!p) return;
            p.current_qty += (r.current_qty || 0);
            p.available_qty += (r.available_qty || 0);
            p.sales_30d_erp += (r.sales_30d || 0);
          });
          // 매출
          salesRaw.recordset.forEach(r => {
            const base = toBase(r.card_code);
            const p = byBase.get(base);
            if (!p) return;
            const rev = Math.round(r.revenue || 0);
            const qty = r.qty || 0;
            p.rev_by_day.set(r.settle_day, (p.rev_by_day.get(r.settle_day) || 0) + rev);
            p.rev_by_site.set(r.site_name, (p.rev_by_site.get(r.site_name) || 0) + rev);
            p.total_rev_30d += rev;
            p.total_qty_30d += qty;
          });
          // 출고수량 (희망 출고일 윈도우)
          (cis || []).forEach(ci => {
            (ci.sticker_selections || []).forEach(sel => {
              const code = sel.product_code;
              if (!code) return;
              const base = toBase(code);
              const p = byBase.get(base);
              if (!p) return;
              const dshp = sel.desired_ship_date;
              const qty = sel.quantity || 0;
              if (!dshp || !qty) return;
              if (dshp >= prevStart && dshp < todayStr) p.ship_prev += qty;
              else if (dshp === todayStr) p.ship_today += qty;
              else if (dshp > todayStr && dshp <= nextEnd) p.ship_next += qty;
            });
          });

          // 결과 정리 — 활동 없는 상품 제외 (재고도 0, 매출도 0, 출고도 0)
          const products = [...byBase.values()]
            .filter(p => p.current_qty > 0 || p.total_rev_30d > 0 || p.ship_prev > 0 || p.ship_today > 0 || p.ship_next > 0 || p.sales_30d_erp > 0)
            .map(p => ({
              base_code: p.base_code,
              card_name: p.card_name,
              variant_count: p.variants.size,
              variants: [...p.variants].sort(),
              current_qty: p.current_qty,
              available_qty: p.available_qty,
              sales_30d_erp: p.sales_30d_erp,
              ship_qty_prev_month: p.ship_prev,
              ship_qty_today: p.ship_today,
              ship_qty_next_month: p.ship_next,
              total_revenue_30d: p.total_rev_30d,
              total_qty_30d: p.total_qty_30d,
              revenue_by_day: [...p.rev_by_day.entries()]
                .map(([d, v]) => ({ settle_date: d, revenue: v }))
                .sort((a, b) => a.settle_date.localeCompare(b.settle_date)),
              revenue_by_site: [...p.rev_by_site.entries()]
                .map(([s, v]) => ({ site_name: s, revenue: v }))
                .sort((a, b) => b.revenue - a.revenue),
            }))
            .sort((a, b) => b.total_revenue_30d - a.total_revenue_30d);

          // === Excel 응답 ===
          if (format === 'excel' || format === 'xlsx') {
            const XLSX = require('xlsx');
            // 모든 site_name 수집 (컬럼화)
            const allSites = new Set();
            products.forEach(p => p.revenue_by_site.forEach(s => allSites.add(s.site_name)));
            const siteList = [...allSites].sort();
            const rows = products.map(p => {
              const row = {
                'BASE 품목코드': p.base_code,
                '상품명': p.card_name,
                '변형 개수': p.variant_count,
                '변형 코드': p.variants.join(', '),
                '현재 재고': p.current_qty,
                '가용 재고': p.available_qty,
                '직전 30일 출고 (희망일)': p.ship_qty_prev_month,
                '오늘 출고 (희망일)': p.ship_qty_today,
                '이후 30일 출고 (희망일)': p.ship_qty_next_month,
                '30일 매출': p.total_revenue_30d,
                '30일 수량': p.total_qty_30d,
                '30일 매출 (ERP 캐시)': p.sales_30d_erp,
              };
              siteList.forEach(s => {
                const found = p.revenue_by_site.find(x => x.site_name === s);
                row[`매출[${s}]`] = found ? found.revenue : 0;
              });
              return row;
            });
            const ws = XLSX.utils.json_to_sheet(rows);
            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws, '상품별 종합');
            const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
            const filename = `daeryepum_product_summary_${todayStr}.xlsx`;
            res.writeHead(200, {
              'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
              'Content-Length': buf.length,
            });
            res.end(buf);
            return;
          }

          // === JSON 응답 ===
          data = {
            generated_at: new Date().toISOString(),
            period: {
              prev_month: `${prevStart} ~ ${fmtDate(addDays(todayDate, -1))}`,
              today: todayStr,
              next_month: `${todayPlus1} ~ ${nextEnd}`,
            },
            total_products: products.length,
            data_sources: {
              stock: 'S2_CARD_ERP_STOCK',
              ship_qty: 'bg_order_customer_info.sticker_selections.desired_ship_date',
              revenue: 'custom_order + CUSTOM_ETC_ORDER (settle_date 기준, status_seq 결제완료)',
            },
            products,
          };
        } catch (err) {
          console.error('[product-summary-report] error:', err.message);
          data = { error: err.message, stack: err.stack };
        }
      } else if (pathname === '/api/admin/probe-stock-tables' && req.method === 'GET') {
        // MSSQL bar_shop1 의 재고 관련 테이블 자동 탐색.
        //   URL: /api/admin/probe-stock-tables
        //         /api/admin/probe-stock-tables?describe=<table>  ← 특정 테이블 컬럼 + sample 5행
        if (!isSuperAdmin(session) && !(await hasRole(session, ['admin', 'operator']))) {
          return denyForbidden(res, 'admin/operator 필요');
        }
        try {
          const pp = await getPool();
          const describeTable = (parsed.query.describe || '').trim();
          if (describeTable && /^[A-Za-z0-9_]+$/.test(describeTable)) {
            // 단일 테이블 describe + sample
            const cols = await pp.request().query(`
              SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
              FROM INFORMATION_SCHEMA.COLUMNS
              WHERE TABLE_NAME = '${describeTable}'
              ORDER BY ORDINAL_POSITION
            `);
            let sample = { recordset: [] };
            try {
              sample = await pp.request().query(`SELECT TOP 5 * FROM [${describeTable}] WITH (NOLOCK)`);
            } catch (e) { sample = { recordset: [], error: e.message }; }
            const cnt = await pp.request().query(`SELECT COUNT(*) AS n FROM [${describeTable}] WITH (NOLOCK)`).catch(() => ({ recordset: [{ n: null }] }));
            data = {
              table: describeTable,
              columns: cols.recordset,
              row_count: cnt.recordset[0].n,
              samples: sample.recordset,
              sample_error: sample.error,
            };
          } else {
            // 전체 탐색 — 재고 관련 테이블 + 컬럼 후보
            const tbls = await pp.request().query(`
              SELECT TABLE_NAME, TABLE_TYPE
              FROM INFORMATION_SCHEMA.TABLES
              WHERE TABLE_TYPE = 'BASE TABLE'
              ORDER BY TABLE_NAME
            `);
            const allTables = tbls.recordset.map(r => r.TABLE_NAME);
            // 테이블명 키워드 — stock/inventory/jaego/재고/qty
            const tableRe = /stock|inventory|jaego|qty|jego|item_stock|product_stock/i;
            const candTables = allTables.filter(t => tableRe.test(t));
            // 컬럼명 패턴 — stock_qty / qty / inventory 컬럼이 있는 테이블 탐색
            const colsRes = await pp.request().query(`
              SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE
              FROM INFORMATION_SCHEMA.COLUMNS
              WHERE COLUMN_NAME LIKE '%stock%' OR COLUMN_NAME LIKE '%inventory%'
                 OR COLUMN_NAME = 'qty' OR COLUMN_NAME = 'remain_qty'
                 OR COLUMN_NAME LIKE '%jaego%' OR COLUMN_NAME LIKE '%jego%'
              ORDER BY TABLE_NAME, COLUMN_NAME
            `);
            // 테이블별 컬럼 그룹핑
            const tablesByCols = {};
            colsRes.recordset.forEach(r => {
              if (!tablesByCols[r.TABLE_NAME]) tablesByCols[r.TABLE_NAME] = [];
              tablesByCols[r.TABLE_NAME].push({ col: r.COLUMN_NAME, type: r.DATA_TYPE });
            });
            // 후보 테이블 row_count 조회
            const candDetail = {};
            for (const t of candTables.slice(0, 15)) {
              try {
                const r = await pp.request().query(`SELECT COUNT(*) AS n FROM [${t}] WITH (NOLOCK)`);
                const c = await pp.request().query(`
                  SELECT TOP 30 COLUMN_NAME, DATA_TYPE
                  FROM INFORMATION_SCHEMA.COLUMNS
                  WHERE TABLE_NAME = '${t}'
                  ORDER BY ORDINAL_POSITION
                `);
                candDetail[t] = { row_count: r.recordset[0].n, columns: c.recordset };
              } catch (e) {
                candDetail[t] = { error: e.message };
              }
            }
            data = {
              total_tables: allTables.length,
              candidate_tables_by_name: candTables,
              candidate_tables_by_column: Object.keys(tablesByCols),
              column_matches_summary: tablesByCols,
              candidate_table_detail: candDetail,
              hint: 'candidate_tables_by_name/column 의 row_count 가 의미 있는 (수백~수만) 테이블이 재고 마스터일 가능성 큼. 정확한 테이블 식별 후 probe-stock-tables?describe=<table> 로 컬럼/샘플 확인.',
            };
          }
        } catch (err) {
          console.error('[probe-stock-tables] error:', err.message);
          data = { error: err.message };
        }
      } else if (pathname === '/api/admin/probe-buyer-membership' && req.method === 'GET') {
        // 답례품 구매자의 회원 상태 분포 — 비회원/Orphan/정상 회원 비율.
        //   URL: /api/admin/probe-buyer-membership?days=90
        if (!isSuperAdmin(session) && !(await hasRole(session, ['admin', 'operator']))) {
          return denyForbidden(res, 'admin/operator 필요');
        }
        const days = parseInt(parsed.query.days, 10) || 90;
        try {
          const pp = await getPool();
          const r = await pp.request().input('days', sql.Int, days).query(`
            WITH gift_orders AS (
              SELECT o.member_id, o.order_seq
              FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
              INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
              INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
              WHERE c.Card_Div = 'D01' AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 15)
                AND o.order_date >= DATEADD(day, -@days, GETDATE())
              UNION ALL
              SELECT cord.member_id, cord.order_seq
              FROM custom_order cord WITH (NOLOCK)
              INNER JOIN custom_order_item coi WITH (NOLOCK) ON cord.order_seq = coi.order_seq
              INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
              WHERE c.Card_Div = 'D01' AND cord.status_seq >= 2 AND cord.status_seq NOT IN (3, 5, 9)
                AND cord.order_date >= DATEADD(day, -@days, GETDATE())
            ),
            distinct_orders AS (SELECT DISTINCT order_seq, member_id FROM gift_orders)
            SELECT
              COUNT(*) AS total_orders,
              COUNT(DISTINCT member_id) AS unique_member_ids,
              SUM(CASE WHEN member_id IS NULL OR LTRIM(RTRIM(CAST(member_id AS NVARCHAR(50)))) = '' THEN 1 ELSE 0 END) AS guest_orders,
              SUM(CASE WHEN member_id IS NOT NULL AND LTRIM(RTRIM(CAST(member_id AS NVARCHAR(50)))) <> '' THEN 1 ELSE 0 END) AS member_orders
            FROM distinct_orders
          `);
          const orphanCheck = await pp.request().input('days', sql.Int, days).query(`
            WITH gift_buyer_members AS (
              SELECT DISTINCT member_id FROM (
                SELECT o.member_id
                FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
                INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
                INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
                WHERE c.Card_Div = 'D01' AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 15)
                  AND o.order_date >= DATEADD(day, -@days, GETDATE())
                UNION ALL
                SELECT cord.member_id
                FROM custom_order cord WITH (NOLOCK)
                INNER JOIN custom_order_item coi WITH (NOLOCK) ON cord.order_seq = coi.order_seq
                INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
                WHERE c.Card_Div = 'D01' AND cord.status_seq >= 2 AND cord.status_seq NOT IN (3, 5, 9)
                  AND cord.order_date >= DATEADD(day, -@days, GETDATE())
              ) u
              WHERE member_id IS NOT NULL AND LTRIM(RTRIM(CAST(member_id AS NVARCHAR(50)))) <> ''
            )
            SELECT
              COUNT(*) AS total_member_ids,
              SUM(CASE WHEN ui.uid IS NOT NULL THEN 1 ELSE 0 END) AS matched_in_userinfo,
              SUM(CASE WHEN ui.uid IS NOT NULL AND ui.site_div = 'SB' AND ui.USE_YORN = 'Y' THEN 1 ELSE 0 END) AS active_unified,
              SUM(CASE WHEN ui.uid IS NULL THEN 1 ELSE 0 END) AS orphan_no_match,
              SUM(CASE WHEN ui.uid IS NOT NULL AND ui.USE_YORN <> 'Y' THEN 1 ELSE 0 END) AS withdrawn,
              SUM(CASE WHEN ui.uid IS NOT NULL AND ui.site_div <> 'SB' THEN 1 ELSE 0 END) AS non_sb_site_div
            FROM gift_buyer_members gbm
            LEFT JOIN S2_UserInfo ui WITH (NOLOCK) ON gbm.member_id = ui.uid
          `);
          data = {
            days,
            order_level: r.recordset[0],
            member_match: orphanCheck.recordset[0],
            hint: 'guest_orders > 0 면 비회원 주문 존재. orphan_no_match > 0 면 member_id 있지만 S2_UserInfo 미매칭 (탈퇴 등). 둘 다 현재 가입사이트 그래프에서 제외됨.',
          };
        } catch (err) {
          console.error('[probe-buyer-membership] error:', err.message);
          data = { error: err.message };
        }
      } else if (pathname === '/api/admin/probe-dmd-ci-match' && req.method === 'GET') {
        // 디얼디어 dupinfo/conninfo ↔ MSSQL S2_UserInfo CI/DI 매칭 가능성 진단.
        //   URL: /api/admin/probe-dmd-ci-match
        // 응답:
        //   · mysql.dupinfo_samples: 평문/암호화 여부 식별 (Laravel encrypted 인지)
        //   · mysql.conninfo_samples: 동일
        //   · mssql.user_columns: S2_UserInfo 의 CI/DI 관련 컬럼 후보
        //   · mssql.ci_samples: 후보 컬럼별 샘플 (마스킹)
        if (!isSuperAdmin(session) && !(await hasRole(session, ['admin', 'operator']))) {
          return denyForbidden(res, 'admin/operator 필요');
        }
        const out = {};
        try {
          // 1) MySQL: dupinfo, conninfo 샘플 + 길이/형식 확인
          if (!process.env.MYSQL_HOST) {
            out.mysql = { error: 'MYSQL_* 환경변수 미설정' };
          } else {
            const mp = await getMysqlPool();
            const [rows] = await mp.query(`
              SELECT dupinfo, conninfo FROM users
              WHERE is_test = 'F' AND (dupinfo IS NOT NULL OR conninfo IS NOT NULL)
              LIMIT 10
            `);
            const dupSamples = rows.map(r => r.dupinfo).filter(Boolean).slice(0, 5);
            const conSamples = rows.map(r => r.conninfo).filter(Boolean).slice(0, 5);
            // 길이 분포 (전체)
            const [stat] = await mp.query(`
              SELECT
                COUNT(*) AS total,
                SUM(CASE WHEN dupinfo IS NOT NULL AND dupinfo <> '' THEN 1 ELSE 0 END) AS with_dupinfo,
                SUM(CASE WHEN conninfo IS NOT NULL AND conninfo <> '' THEN 1 ELSE 0 END) AS with_conninfo,
                AVG(LENGTH(dupinfo)) AS avg_dupinfo_len,
                AVG(LENGTH(conninfo)) AS avg_conninfo_len
              FROM users WHERE is_test = 'F'
            `);
            // 마스킹 (앞 8자 + ... + 뒤 4자)
            const mask = (s) => {
              if (!s) return null;
              const str = String(s);
              if (str.length <= 12) return str.slice(0, 2) + '****' + str.slice(-2);
              return str.slice(0, 8) + '...' + str.slice(-4);
            };
            // Laravel encrypted 여부 추정 (eyJpdiI6 prefix = base64 인코딩된 {"iv":..)
            const isLaravelEncrypted = (s) => String(s || '').startsWith('eyJpdiI6');
            out.mysql = {
              stats: stat[0],
              dupinfo: {
                samples_masked: dupSamples.map(mask),
                looks_laravel_encrypted: dupSamples.length > 0 && dupSamples.every(isLaravelEncrypted),
                avg_length: stat[0].avg_dupinfo_len,
              },
              conninfo: {
                samples_masked: conSamples.map(mask),
                looks_laravel_encrypted: conSamples.length > 0 && conSamples.every(isLaravelEncrypted),
                avg_length: stat[0].avg_conninfo_len,
              },
            };
          }

          // 2) MSSQL: S2_UserInfo 의 모든 컬럼 + CI/DI 후보 추출
          const pp = await getPool();
          const colsRes = await pp.request().query(`
            SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
            FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_NAME = 'S2_UserInfo'
            ORDER BY ORDINAL_POSITION
          `);
          const allCols = colsRes.recordset;
          const ciRe = /^(ci|di|dupinfo|conninfo|cidi|user_ci|user_di)$/i;
          const ciLikeRe = /ci|di|dupinfo|conninfo|impid|nice|cretop/i;
          const exactMatches = allCols.filter(c => ciRe.test(c.COLUMN_NAME));
          const fuzzyMatches = allCols.filter(c => ciLikeRe.test(c.COLUMN_NAME) && !ciRe.test(c.COLUMN_NAME));
          out.mssql = {
            total_columns: allCols.length,
            exact_ci_di_columns: exactMatches,
            fuzzy_ci_di_columns: fuzzyMatches,
            all_column_names: allCols.map(c => c.COLUMN_NAME),
          };

          // 3) MSSQL: 후보 컬럼별 샘플 + non-null 비율 (최대 5개 컬럼)
          const tryCols = [...exactMatches, ...fuzzyMatches].slice(0, 5);
          const samples = {};
          for (const col of tryCols) {
            try {
              const sampleRes = await pp.request().query(`
                SELECT TOP 5 [${col.COLUMN_NAME}] AS val FROM S2_UserInfo WITH (NOLOCK)
                WHERE [${col.COLUMN_NAME}] IS NOT NULL AND CAST([${col.COLUMN_NAME}] AS NVARCHAR(MAX)) <> ''
              `);
              const cntRes = await pp.request().query(`
                SELECT
                  COUNT(*) AS total,
                  SUM(CASE WHEN [${col.COLUMN_NAME}] IS NOT NULL AND CAST([${col.COLUMN_NAME}] AS NVARCHAR(MAX)) <> '' THEN 1 ELSE 0 END) AS with_val
                FROM S2_UserInfo WITH (NOLOCK)
              `);
              const mask = (s) => {
                if (!s) return null;
                const str = String(s);
                if (str.length <= 12) return str.slice(0, 2) + '****' + str.slice(-2);
                return str.slice(0, 8) + '...' + str.slice(-4);
              };
              samples[col.COLUMN_NAME] = {
                type: col.DATA_TYPE,
                max_length: col.CHARACTER_MAXIMUM_LENGTH,
                samples_masked: sampleRes.recordset.map(r => mask(r.val)),
                fill_rate: cntRes.recordset[0],
              };
            } catch (e) {
              samples[col.COLUMN_NAME] = { error: e.message };
            }
          }
          out.mssql_samples = samples;

          out.hint = '· mysql.dupinfo/conninfo 가 looks_laravel_encrypted=true 면 평문 매칭 불가, Laravel APP_KEY 필요\n· mssql.exact_ci_di_columns 가 비어있으면 MSSQL 에 CI/DI 컬럼 없음 (가입 시 본인인증 안 받음 = 매칭 불가)\n· 양쪽 다 평문 + 컬럼 존재하면 정확 매칭 가능';
          data = out;
        } catch (err) {
          console.error('[probe-dmd-ci-match] error:', err.message);
          data = { ...out, error: err.message };
        }
      } else if (pathname === '/api/admin/probe-dmd-phone-match' && req.method === 'GET') {
        // 디얼디어 회원 ↔ 답례품 구매자 phone 매칭 진단.
        //   URL: /api/admin/probe-dmd-phone-match?days=90
        // 응답: MySQL phone set 크기, MSSQL 답례품 주문자 phone 분포, 매칭 통계, 샘플 (마스킹).
        if (!isSuperAdmin(session) && !(await hasRole(session, ['admin', 'operator']))) {
          return denyForbidden(res, 'admin/operator 필요');
        }
        const days = parseInt(parsed.query.days, 10) || 90;
        const out = { days };
        try {
          // 1) MySQL 디얼디어 phone set
          if (!process.env.MYSQL_HOST) {
            out.dmd = { error: 'MYSQL_* 환경변수 미설정' };
          } else {
            const mp = await getMysqlPool();
            const [rawDmd] = await mp.query(`
              SELECT phone FROM users WHERE is_test = 'F' AND phone IS NOT NULL AND phone <> '' LIMIT 50000
            `);
            const dmdRawSamples = rawDmd.slice(0, 5).map(r => r.phone);
            const dmdNorm = rawDmd.map(r => String(r.phone || '').replace(/\D/g, '')).filter(p => p.length >= 8);
            const dmdLenDist = {};
            dmdNorm.forEach(p => { dmdLenDist[p.length] = (dmdLenDist[p.length] || 0) + 1; });
            out.dmd = {
              total_users_with_phone: rawDmd.length,
              normalized_phones: dmdNorm.length,
              length_distribution: dmdLenDist,
              raw_samples: dmdRawSamples,
              normalized_samples: dmdNorm.slice(0, 5).map(p => p.slice(0,3) + '****' + p.slice(-2)),
            };
          }

          // 2) MSSQL 답례품 주문자 phone (최근 N일)
          const pp = await getPool();
          const r = await pp.request().input('days', sql.Int, days).query(`
            SELECT
              ui.hand_phone1 AS p1, ui.hand_phone2 AS p2, ui.hand_phone3 AS p3,
              first_order.member_id
            FROM (
              SELECT DISTINCT member_id
              FROM (
                SELECT o.member_id, o.order_date
                FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
                INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
                INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
                WHERE c.Card_Div = 'D01' AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 15)
                  AND o.order_date >= DATEADD(day, -@days, GETDATE())
                UNION ALL
                SELECT cord.member_id, cord.order_date
                FROM custom_order cord WITH (NOLOCK)
                INNER JOIN custom_order_item coi WITH (NOLOCK) ON cord.order_seq = coi.order_seq
                INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
                WHERE c.Card_Div = 'D01' AND cord.status_seq >= 2 AND cord.status_seq NOT IN (3, 5, 9)
                  AND cord.order_date >= DATEADD(day, -@days, GETDATE())
              ) u
            ) first_order
            LEFT JOIN S2_UserInfo ui WITH (NOLOCK) ON first_order.member_id = ui.uid
          `);
          const mssqlBuyers = r.recordset;
          const mssqlWithPhone = mssqlBuyers.filter(row => row.p1 || row.p2 || row.p3);
          const mssqlNorm = mssqlWithPhone.map(row => {
            const concat = String((row.p1||'') + (row.p2||'') + (row.p3||''));
            return concat.replace(/\D/g, '');
          });
          const mssqlLenDist = {};
          mssqlNorm.forEach(p => { mssqlLenDist[p.length] = (mssqlLenDist[p.length] || 0) + 1; });
          const mssqlSamples = mssqlNorm.slice(0, 5).map(p => p ? p.slice(0,3) + '****' + p.slice(-2) : '');
          out.mssql_buyers = {
            total_buyers: mssqlBuyers.length,
            with_phone: mssqlWithPhone.length,
            normalized_phones: mssqlNorm.filter(p => p.length >= 8).length,
            length_distribution: mssqlLenDist,
            normalized_samples: mssqlSamples,
            raw_samples: mssqlWithPhone.slice(0, 3).map(r => ({ p1: r.p1, p2: r.p2, p3: r.p3, len: ((r.p1||'')+(r.p2||'')+(r.p3||'')).replace(/\D/g, '').length })),
          };

          // 3) 매칭 통계
          if (out.dmd && !out.dmd.error) {
            const dmdSet = await fetchDearMyDearPhones();
            let matched = 0;
            const matchedSamples = [];
            mssqlNorm.forEach(p => {
              if (p.length >= 8 && dmdSet.has(p)) {
                matched++;
                if (matchedSamples.length < 3) matchedSamples.push(p.slice(0,3)+'****'+p.slice(-2));
              }
            });
            out.match = {
              dmd_set_size: dmdSet.size,
              mssql_buyers_normalized: mssqlNorm.filter(p => p.length >= 8).length,
              matched_count: matched,
              matched_samples: matchedSamples,
              hint: matched === 0 ? '매칭 0건 — 가능 원인: (1) 정말 0건 (2) phone 형식 차이 (3) hand_phone1/2/3 가 빈값 / S2_UserInfo 컬럼명 다름. length_distribution 비교 + raw_samples 형태 확인.' : '매칭 OK',
            };
          }
          data = out;
        } catch (err) {
          console.error('[probe-dmd-phone-match] error:', err.message);
          data = { ...out, error: err.message };
        }
      } else if (pathname === '/api/admin/probe-wedding-mysql' && req.method === 'GET') {
        // 디얼디어 MySQL DB (wedding) 스키마 진단 — 회원/예식 관련 테이블/컬럼 자동 탐색.
        //   URL: /api/admin/probe-wedding-mysql
        //         /api/admin/probe-wedding-mysql?describe=<table>           ← 단일 테이블
        //         /api/admin/probe-wedding-mysql?describe=t1,t2,t3          ← 콤마 구분 멀티
        //         /api/admin/probe-wedding-mysql?sample=<table>             ← 상위 5행 샘플 (PII)
        if (!isSuperAdmin(session) && !(await hasRole(session, ['admin', 'operator']))) {
          return denyForbidden(res, 'admin/operator 필요');
        }
        try {
          const mp = await getMysqlPool();
          const out = { db: process.env.MYSQL_DATABASE };
          // event_date 포맷 진단 모드 (디얼디어 통합 검증)
          //   ?check_event_date=1 → users.event_date 의 포맷별 분포 + 통합 함수 결과 샘플
          if (parsed.query.check_event_date === '1') {
            const out2 = { mode: 'check_event_date' };
            // 비어있지 않은 event_date 의 길이별 분포 (포맷 추정)
            const [byLen] = await mp.query(`
              SELECT LENGTH(event_date) AS len, COUNT(*) AS n,
                MIN(event_date) AS first_sample, MAX(event_date) AS last_sample
              FROM users WHERE is_test = 'F' AND event_date IS NOT NULL AND event_date <> ''
              GROUP BY LENGTH(event_date) ORDER BY n DESC LIMIT 10
            `);
            // STR_TO_DATE 변환 가능한 비율
            const [conv] = await mp.query(`
              SELECT
                COUNT(*) AS total_nonempty,
                SUM(CASE WHEN STR_TO_DATE(LEFT(event_date,10), '%Y-%m-%d') IS NOT NULL THEN 1 ELSE 0 END) AS std_dash,
                SUM(CASE WHEN STR_TO_DATE(LEFT(event_date,10), '%Y/%m/%d') IS NOT NULL THEN 1 ELSE 0 END) AS std_slash,
                SUM(CASE WHEN event_date REGEXP '^[0-9]{8}$' THEN 1 ELSE 0 END) AS compact_8digit
              FROM users WHERE is_test = 'F' AND event_date IS NOT NULL AND event_date <> ''
            `);
            // 현재 통합 함수가 캐치하는 최근 12개월 합계
            const todayKst = today();
            const start12 = new Date(todayKst.getFullYear(), todayKst.getMonth() - 12, 1);
            const integrated = await fetchDearMyDearWeddingDates(fmtDate(start12), fmtDate(addDays(todayKst, 30)));
            let integratedTotal = 0;
            integrated.forEach(c => { integratedTotal += c; });
            out2.length_distribution = byLen;
            out2.conversion_summary = conv[0];
            out2.integrated_recent_12mo_sample = {
              range: `${fmtDate(start12)} ~ ${fmtDate(addDays(todayKst, 30))}`,
              total_days_with_data: integrated.size,
              total_weddings: integratedTotal,
            };
            out2.hint = 'std_dash 가 total_nonempty 와 비슷하면 포맷 OK. 차이 크면 fetchDearMyDearWeddingDates 의 COALESCE 추가 포맷 필요.';
            data = { ...out, ...out2 };
          } else {
          // 단일/멀티 테이블 모드 — 콤마 구분 지원
          const describeRaw = (parsed.query.describe || '').trim();
          const sampleTable = (parsed.query.sample || '').trim();
          const describeList = describeRaw
            ? describeRaw.split(',').map(s => s.trim()).filter(s => /^[A-Za-z0-9_]+$/.test(s)).slice(0, 10)
            : [];
          if (describeList.length > 0) {
            const result = {};
            for (const t of describeList) {
              try {
                const [cols] = await mp.query(`DESCRIBE \`${t}\``);
                const [cnt] = await mp.query(`SELECT COUNT(*) AS n FROM \`${t}\``);
                result[t] = { columns: cols, row_count: cnt[0].n };
              } catch (e) { result[t] = { error: e.message }; }
            }
            out.describe = result;
            data = out;
          } else if (sampleTable && /^[A-Za-z0-9_]+$/.test(sampleTable)) {
            const [rows] = await mp.query(`SELECT * FROM \`${sampleTable}\` LIMIT 5`);
            out.sample = { table: sampleTable, rows };
            data = out;
          } else {
            // 전체 탐색 모드
            const [tables] = await mp.query('SHOW TABLES');
            const all = tables.map(r => Object.values(r)[0]);
            // 회원/예식 관련 테이블 후보 추출
            const candRe = /user|member|account|customer|wedding|wedd|guest|profile|info/i;
            const candidates = all.filter(t => candRe.test(t));
            out.total_tables = all.length;
            out.all_tables = all;
            out.candidate_tables = candidates;
            // 후보 테이블 (상위 10개) 의 컬럼 + row count 같이 조회 — 회원 / 예식일 컬럼 식별
            const detail = {};
            for (const t of candidates.slice(0, 10)) {
              try {
                const [cols] = await mp.query(`DESCRIBE \`${t}\``);
                const [cnt] = await mp.query(`SELECT COUNT(*) AS n FROM \`${t}\``);
                // 예식/wedding/날짜 키워드 컬럼 우선 노출
                const wedColRe = /wed|marri|date|year|month|day/i;
                const weddingCols = cols.filter(c => wedColRe.test(c.Field));
                detail[t] = { row_count: cnt[0].n, total_columns: cols.length, wedding_like_columns: weddingCols, all_columns: cols };
              } catch (e) {
                detail[t] = { error: e.message };
              }
            }
            out.candidate_table_detail = detail;
            out.hint = '회원 + 예식일 컬럼이 있는 테이블을 식별하면 알려주세요. probe-wedding-mysql?describe=<table> 로 특정 테이블 컬럼 전체 조회 가능. PII 노출 주의로 sample 모드는 운영자만 신중 사용.';
            data = out;
          }
          } // end of else (check_event_date 가 아닌 일반 모드 블록)
        } catch (err) {
          console.error('[probe-wedding-mysql] error:', err.message);
          data = { error: 'MySQL 진단 실패: ' + err.message };
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
              AND o.status_seq >= 1 AND o.status_seq NOT IN (3, 5, 9)
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
              AND co.status_seq >= 1 AND co.status_seq NOT IN (3, 5, 9)
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
              AND o.status_seq >= 1 AND o.status_seq NOT IN (3, 5, 9)
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
              AND o.status_seq >= 1 AND o.status_seq NOT IN (3, 5, 9)
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
      } else if (pathname === '/api/coupang/rfm/upload' && req.method === 'POST') {
        // 로켓그로스 '판매 수수료 리포트'(xlsx) 업로드 → 일자×옵션 단위 매출 등록.
        //   body: { file_base64, filename, dry_run }
        //   dry_run=true 면 저장 없이 파싱 결과만 반환 (업로드 전 미리보기).
        //   저장 시 같은 날짜의 수동입력(_manual) 합계 행은 삭제 — 이중 계상 방지.
        if (!isSuperAdmin(session) && !(await hasRole(session, ['admin', 'operator']))) {
          return denyForbidden(res, 'admin/operator 필요');
        }
        const body = await new Promise((resolve) => {
          let raw = '';
          req.on('data', c => raw += c);
          req.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
        });
        const dryRun = body.dry_run === true || body.dry_run === '1';
        logAdminAccess(session, req, 'coupang-rfm-upload', { filename: body.filename, dry_run: dryRun });
        try {
          if (!body.file_base64) throw new Error('파일이 없습니다');
          const buf = Buffer.from(String(body.file_base64), 'base64');
          if (!buf.length) throw new Error('빈 파일입니다');
          const { parseRfmSettlementXlsx } = require('./coupang/rfm-xlsx');
          const parsed = parseRfmSettlementXlsx(buf);
          if (!parsed.rows.length) throw new Error('등록할 매출 행이 없습니다 (파일 내용을 확인해주세요)');
          if (dryRun) {
            data = { ok: true, dry_run: true, ...parsed, rows: parsed.rows.slice(0, 100) };
          } else {
            const rfmStore = require('./coupang/rfm-store');
            // 1) 같은 날짜의 수동입력 합계 행 제거 (상품별 데이터로 교체)
            const del = await rfmStore.deleteManualSalesByDates(parsed.dates);
            // 2) 상품별 매출 upsert — UNIQUE(sale_date, vendor_item_id) 로 재업로드도 안전
            const up = await rfmStore.upsertSales(parsed.rows);
            data = {
              ok: true, upserted: up.upserted, manual_deleted: del.deleted,
              dates: parsed.dates, summary: parsed.summary, skipped: parsed.skipped,
            };
          }
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
          return;
        }
      } else if (pathname === '/api/coupang/sticker-backfill' && req.method === 'POST') {
        // 이미 저장된 coupang_orders 로 기존 주문의 스티커·상품코드를 채운다.
        //   쿠팡 API 를 다시 부르지 않아 동기화 기간·상태 제한과 무관하다.
        //   body: { dry_run, start_date, end_date }  — dry_run 기본 true (데이터를 쓰는 작업)
        if (!isSuperAdmin(session) && !(await hasRole(session, ['admin', 'operator']))) {
          return denyForbidden(res, 'admin/operator 필요');
        }
        const body = await new Promise((resolve) => {
          let raw = '';
          req.on('data', c => raw += c);
          req.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
        });
        const dryRun = body.dry_run !== false;
        logAdminAccess(session, req, 'coupang-sticker-backfill', {
          dry_run: dryRun, start: body.start_date, end: body.end_date,
        });
        try {
          const { backfillCoupangStickers } = require('./coupang/sticker-backfill');
          data = await backfillCoupangStickers({
            dryRun,
            startDate: body.start_date || null,
            endDate: body.end_date || null,
          });
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
          return;
        }
      } else if (pathname === '/api/coupang/rfm/lines/upload' && req.method === 'POST') {
        // 주문 단위 리포트 업로드 (migration 055) — 파일 종류를 헤더로 자동 판별한다.
        //   파일1 CATEGORY_TR          → 결제완료일·매출·수수료·정산대상액
        //   파일2 WAREHOUSING_SHIPPING → 배송완료일·입출고비·배송비
        //   같은 (주문ID, 옵션ID) 행을 두 파일이 각자 채우므로 업로드 순서는 상관없다.
        if (!isSuperAdmin(session) && !(await hasRole(session, ['admin', 'operator']))) {
          return denyForbidden(res, 'admin/operator 필요');
        }
        const body = await new Promise((resolve) => {
          let raw = '';
          req.on('data', c => raw += c);
          req.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
        });
        const dryRun = body.dry_run === true || body.dry_run === '1';
        logAdminAccess(session, req, 'coupang-rfm-lines-upload', { filename: body.filename, dry_run: dryRun });
        try {
          if (!body.file_base64) throw new Error('파일이 없습니다');
          const buf = Buffer.from(String(body.file_base64), 'base64');
          if (!buf.length) throw new Error('빈 파일입니다');
          const { parseRgLinesXlsx } = require('./coupang/rfm-lines');
          const parsed = parseRgLinesXlsx(buf);
          if (!parsed.rows.length) throw new Error('등록할 행이 없습니다 (파일 내용을 확인해주세요)');
          if (dryRun) {
            data = { ok: true, dry_run: true, ...parsed, rows: parsed.rows.slice(0, 50) };
          } else {
            const up = await require('./coupang/rfm-store').upsertOrderLines(parsed.rows);
            data = {
              ok: true, kind: parsed.kind, upserted: up.upserted,
              dates: parsed.dates, summary: parsed.summary, skipped: parsed.skipped,
            };
            // 새로 들어온 라인의 판매 방식을 가른다 (064) — 리포트엔 판매자배송도 섞여 있다.
            try {
              data.classified = await require('./coupang/rfm-store').classifyOrderLines({
                startDate: parsed.dates?.from || null,
                endDate: parsed.dates?.to || null,
              });
            } catch (e) {
              console.warn('[rfm/lines upload] 판매방식 분류 실패:', e.message);
            }
            // 리포트가 말하는 취소·배송완료를 주문 상태에 반영한다.
            //   수집 기간과 무관하게 돌아야 한다 — 그래서 수집과 분리해 여기서 부른다.
            try {
              data.order_status = await require('./coupang/rg-orders').syncRgOrderStatusFromReport({
                startDate: parsed.dates?.from || null,
                endDate: parsed.dates?.to || null,
              });
            } catch (e) {
              console.warn('[rfm/lines upload] 주문 상태 반영 실패:', e.message);
            }
            // 업로드된 내용이 곧 실제 진행 상태 — 정보입력현황 단계를 바로 맞춘다.
            //   실패해도 업로드 자체는 성공으로 둔다 (연동은 버튼으로 다시 돌릴 수 있다).
            try {
              const { syncRocketGrowthWorkflow } = require('./coupang/rg-workflow');
              data.workflow = await syncRocketGrowthWorkflow({
                dryRun: false, by: `rg-upload:${session?.email || 'system'}`,
              });
            } catch (e) {
              console.warn('[rfm/lines upload] 워크플로우 연동 실패:', e.message);
              data.workflow_error = e.message;
            }
          }
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
          return;
        }
      } else if (pathname === '/api/coupang/option-map/sync' && req.method === 'POST') {
        // 옵션ID → 등록상품ID 맵 갱신 (063).
        //   상품 구성이 자주 바뀌지 않아 크론에서도 함께 돌지만, 신상품 등록 직후엔 수동 실행.
        if (!isSuperAdmin(session) && !(await hasRole(session, ['admin', 'operator']))) {
          return denyForbidden(res, 'admin/operator 필요');
        }
        const body = await new Promise((resolve) => {
          let raw = '';
          req.on('data', c => raw += c);
          req.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
        });
        logAdminAccess(session, req, 'coupang-option-map-sync', { types: body.business_types || null });
        try {
          data = await require('./coupang/option-map').syncOptionMap({
            // 기본은 전체 — 판매자배송 상품도 옵션ID 로 조회될 수 있다
            businessTypes: body.business_types || null,
          });
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
          return;
        }
      } else if (pathname === '/api/inquiries' && req.method === 'GET') {
        // 외부채널 고객문의 목록 (065)
        if (!isSuperAdmin(session) && !(await hasRole(session, ['admin', 'operator']))) {
          return denyForbidden(res, 'admin/operator 필요');
        }
        try {
          const q = parsed.query;
          const rows = await require('./channel-inquiries').listInquiries({
            channel: q.channel || null,
            answered: q.answered === '1' ? true : (q.answered === '0' ? false : undefined),
            startDate: q.start_date || null,
            endDate: q.end_date || null,
          });
          data = { items: rows, count: rows.length };
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
          return;
        }
      } else if (pathname === '/api/inquiries/sync' && req.method === 'POST') {
        // 채널에서 문의를 가져와 저장. 쿠팡은 조회기간이 7일이라 창을 쪼개 돈다.
        if (!isSuperAdmin(session) && !(await hasRole(session, ['admin', 'operator']))) {
          return denyForbidden(res, 'admin/operator 필요');
        }
        const body = await new Promise((resolve) => {
          let raw = '';
          req.on('data', c => raw += c);
          req.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
        });
        logAdminAccess(session, req, 'inquiries-sync', { days: body.days_back });
        try {
          data = await require('./channel-inquiries').syncInquiries({ daysBack: body.days_back });
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
          return;
        }
      } else if (pathname.match(/^\/api\/inquiries\/[^/]+\/check$/) && req.method === 'POST') {
        // 우리 쪽 '확인' 표시 — 채널 답변 여부와 별개다
        if (!isSuperAdmin(session) && !(await hasRole(session, ['admin', 'operator']))) {
          return denyForbidden(res, 'admin/operator 필요');
        }
        const id = pathname.split('/')[3];
        try {
          data = await require('./channel-inquiries').markChecked(id, session?.email || null);
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
          return;
        }
      } else if (pathname === '/api/admin/channel-probe' && req.method === 'GET') {
        // 외부채널 쓰기 권한 확인 — 출고상태 변경 / 고객문의 API 를 쓸 수 있는지 가른다.
        //   쓰기 API 는 '있을 수 없는 식별자' 로만 호출하므로 실제 주문·문의는 바뀌지 않는다.
        //   ?write=0 이면 읽기(문의 조회)만 확인한다.
        if (!isSuperAdmin(session) && !(await hasRole(session, ['admin']))) {
          return denyForbidden(res, 'admin 필요');
        }
        logAdminAccess(session, req, 'channel-probe', { write: parsed.query.write !== '0' });
        try {
          data = await require('./channel-probe').probeChannels({
            includeWrite: parsed.query.write !== '0',
          });
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
          return;
        }
      } else if (pathname === '/api/cafe24/sticker-trace' && req.method === 'GET') {
        // 진단용 — 정수당 주문의 스티커코드가 왜 비었는지 근거를 모아 보여준다.
        //   코드는 두 경로로 정해진다: bg_stickers 매칭 > 카페24 변형코드.
        //   둘 다 실패하면 이름만 남고 코드가 빈다.
        if (!isSuperAdmin(session) && !(await hasRole(session, ['admin', 'operator']))) {
          return denyForbidden(res, 'admin/operator 필요');
        }
        const oid = String(parsed.query.order_id || '').trim();
        if (!oid) {
          data = { error: 'order_id 를 지정하세요 (카페24 주문번호, CF- 접두 없이)' };
        } else {
          const out = { order_id: oid };
          try {
            const rows = await require('./cafe24/store').listCafe24Orders({ orderIds: [oid] });
            const { parseCafe24OptionValue } = require('./cafe24/option-parser');
            const { matchSticker } = require('./naver/option-parser');
            const stickers = await require('./barungift/store').getAllStickers(true).catch(() => []);
            out.items = (rows || []).map(r => {
              const raw = r.raw_payload?.item || {};
              const optionValue = raw.option_value || null;
              const parsedOpt = parseCafe24OptionValue(optionValue);
              let stickerType = null;
              for (const [k, v] of Object.entries(parsedOpt)) {
                if (k.includes('스티커') && !k.includes('문구')) { stickerType = v; break; }
              }
              const hit = matchSticker(stickers, r.product_code, stickerType);
              // 이 상품코드에 걸려 있는 스티커 후보 — 매칭이 왜 실패했는지 바로 보인다
              const cands = (stickers || [])
                .filter(x => x && x.is_active !== false
                  && Array.isArray(x.product_codes) && x.product_codes.includes(r.product_code))
                .map(x => ({ code: x.sticker_code, name: x.name, type: x.type }));
              return {
                product_code: r.product_code,
                product_name: r.product_name,
                option_value: optionValue,
                parsed_option: parsedOpt,
                sticker_type_from_option: stickerType,
                custom_variant_code: raw.custom_variant_code ?? null,
                custom_product_code: raw.custom_product_code ?? null,
                matched_sticker: hit ? { code: hit.sticker_code, name: hit.name, type: hit.type } : null,
                candidates_for_product_code: cands,
              };
            });
          } catch (e) { out.items_error = e.message; }
          try {
            const ci = await require('./barungift/workflow-store').getCustomerInfoForUpdate(`CF-${oid}`);
            out.sticker_selections = (ci?.sticker_selections || []).map(x => ({
              product_code: x.product_code, sticker_code: x.sticker_code,
              sticker_name: x.sticker_name, sticker_id: x.sticker_id,
            }));
          } catch (e) { out.customer_info_error = e.message; }
          const it0 = (out.items || [])[0];
          out.diagnosis = !it0
            ? '이 주문번호로 저장된 카페24 주문이 없다'
            : (it0.matched_sticker
              ? '스티커 매칭은 됐다 — 주문정보가 옛 동기화 값이면 재동기화 필요'
              : (!it0.candidates_for_product_code.length
                ? `이 상품코드(${it0.product_code})에 연결된 스티커가 없다 — 상품설정/스티커의 상품코드 확인`
                : (it0.custom_variant_code
                  ? '스티커 이름이 후보와 안 맞는다 — 스티커 이름/타입 표기 확인'
                  : '스티커 이름도 안 맞고 카페24 변형코드도 비어 있다 — 둘 중 하나는 있어야 코드가 잡힌다')));
          data = out;
        }
      } else if (pathname === '/api/coupang/rg-trace' && req.method === 'GET') {
        // 진단용 — 한 주문이 왜 그 상태인지 근거를 한자리에 모아 보여준다.
        //   "쿠팡창고에 왜 남아 있나" 같은 질문은 세 곳을 대조해야 답이 나온다:
        //   주문 행(상태) / 정산 리포트 라인(배송완료일) / 주문정보(워크플로우 시각).
        if (!isSuperAdmin(session) && !(await hasRole(session, ['admin', 'operator']))) {
          return denyForbidden(res, 'admin/operator 필요');
        }
        const oid = String(parsed.query.order_id || '').trim();
        if (!oid) {
          data = { error: 'order_id 를 지정하세요 (예: ?order_id=32101311208245)' };
        } else {
          const pick = (o, keys) => Object.fromEntries(keys.map(k => [k, o?.[k] ?? null]));
          const out = { order_id: oid };
          try {
            const rows = await require('./coupang/store').listCoupangOrders({ orderIds: [oid] });
            out.coupang_orders = (rows || []).map(r => pick(r, [
              'shipment_box_id', 'vendor_item_id', 'product_code', 'product_name',
              'status', 'status_label', 'is_rocket_growth', 'ordered_at', 'paid_at', 'item_count',
            ]));
          } catch (e) { out.coupang_orders_error = e.message; }
          try {
            const lines = await require('./coupang/rfm-store').listAllOrderLines({});
            out.report_lines = lines
              .filter(l => String(l.order_id).trim() === oid)
              .map(l => pick(l, [
                'vendor_item_id', 'seller_product_id', 'paid_date', 'delivered_date',
                'fulfillment', 'is_cancel', 'sales_qty', 'sales_amount', 'inout_fee', 'shipping_fee',
              ]));
          } catch (e) { out.report_lines_error = e.message; }
          try {
            const ci = await require('./barungift/workflow-store').getCustomerInfoForUpdate(`CP-${oid}`);
            out.customer_info = ci ? {
              order_id: ci._resolvedOrderId || `CP-${oid}`,
              desired_ship_date: ci.desired_ship_date ?? null,
              sticker_selections: (ci.sticker_selections || []).map(s => pick(s, [
                'product_code', 'sticker_code',
                'sticker_completed_at', 'printed_at', 'bound_at', 'packed_at', 'shipped_at',
              ])),
            } : null;
          } catch (e) { out.customer_info_error = e.message; }
          // 왜 창고에 남아 있는지 한 줄로 요약
          const anyDelivered = (out.report_lines || []).some(l => l.delivered_date);
          const anyShipped = (out.customer_info?.sticker_selections || []).some(s => s.shipped_at);
          const orderDelivered = (out.coupang_orders || []).some(r => r.status === 'FINAL_DELIVERY');
          out.diagnosis = anyShipped || orderDelivered
            ? '출고완료로 잡혀야 정상 — 창고 탭에 있다면 화면 새로고침 필요'
            : (anyDelivered
              ? '리포트에 배송완료일은 있는데 반영 전 — [정보입력현황 연동] 을 돌리면 빠진다'
              : ((out.report_lines || []).length
                ? '리포트 라인은 있으나 배송완료일이 비었다 — 파일2(입출고비·배송비)에 이 주문이 아직 없다'
                : '정산 리포트에 이 주문 라인 자체가 없다 — 그 기간 파일1/파일2 업로드 여부 확인'));
          data = out;
        }
      } else if (pathname === '/api/coupang/rg-orders/probe' && req.method === 'GET') {
        // 진단용 — RG 주문 API 응답 원본을 그대로 보여준다.
        //   문서만 보고 맞춘 필드명(orderId/vendorItemId/salesQuantity)이 실제와 다르거나,
        //   API 키에 로켓그로스 권한이 없으면 '0건' 으로만 보여 원인을 알 수 없다.
        //   브라우저 주소창으로 바로 열어볼 수 있게 GET 으로 둔다.
        if (!isSuperAdmin(session) && !(await hasRole(session, ['admin', 'operator']))) {
          return denyForbidden(res, 'admin/operator 필요');
        }
        const cpApi = require('./coupang/api');
        const from = String(parsed.query.start_date || '').trim();
        const to = String(parsed.query.end_date || '').trim();
        const probeOrderId = String(parsed.query.order_id || '').trim();
        if (probeOrderId) {
          // 단건 조회 계열이 로켓그로스 주문에도 먹히는지 확인한다.
          //   먹히면 취소·배송완료를 정산 리포트 없이 크론으로 찍을 수 있다.
          //   두 경로를 다 때려 보고 어느 쪽이 상태를 주는지 그대로 보여준다.
          const tryCall = async (label, fn) => {
            try {
              const r = await fn();
              return { label, ok: true, preview: JSON.stringify(r).slice(0, 1200) };
            } catch (e) {
              return { label, ok: false, status: e.status || null, error: String(e.message).slice(0, 400) };
            }
          };
          data = {
            order_id: probeOrderId,
            results: [
              await tryCall('marketplace /{orderId}/ordersheets', () => cpApi.getOrderSheet(probeOrderId)),
              await tryCall('rg_open_api /rg/orders/{orderId}', () => cpApi.callCoupang(
                'GET',
                `/v2/providers/rg_open_api/apis/api/v1/vendors/${cpApi.VENDOR_ID}/rg/orders/${probeOrderId}`,
                '')),
            ],
          };
        } else if (!from || !to) {
          data = { error: 'start_date, end_date 를 YYYY-MM-DD 로 지정하세요 (최대 30일)' };
        } else if (!cpApi.isConfigured()) {
          data = { error: 'Coupang API 키 미설정 (COUPANG_VENDOR_ID/ACCESS_KEY/SECRET_KEY)' };
        } else {
          const ymd = d => d.replace(/-/g, '');
          const path = `/v2/providers/rg_open_api/apis/api/v1/vendors/${cpApi.VENDOR_ID}/rg/orders`;
          try {
            const raw = await cpApi.listRgOrders({ paidDateFrom: ymd(from), paidDateTo: ymd(to) });
            const list = cpApi.pickList(raw);
            data = {
              ok: true, path, range: [from, to],
              top_level_keys: Object.keys(raw || {}),
              code: raw?.code ?? null, message: raw?.message ?? null,
              count: list.length,
              next_token: raw?.nextToken ?? null,
              item_keys: list[0] ? Object.keys(list[0]) : [],
              first_items: list.slice(0, 3),
              // data 가 배열이 아니면 무엇이 왔는지 잘라서 보여준다
              data_type: Array.isArray(raw?.data) ? 'array' : typeof raw?.data,
              data_keys: (raw?.data && !Array.isArray(raw.data) && typeof raw.data === 'object')
                ? Object.keys(raw.data) : null,
              raw_preview: list.length ? null : JSON.stringify(raw).slice(0, 2000),
            };
          } catch (e) {
            data = { ok: false, path, range: [from, to], error: e.message, status: e.status || null, body: e.body || null };
          }
        }
      } else if (pathname === '/api/coupang/rg-orders/sync' && req.method === 'POST') {
        // 로켓그로스 주문 수집 (062) — 마켓플레이스 주문 API 로는 안 나오는 계열.
        //   30일 창을 쪼개 순회하므로 기간이 길면 오래 걸린다. 수동 실행만 한다.
        if (!isSuperAdmin(session) && !(await hasRole(session, ['admin', 'operator']))) {
          return denyForbidden(res, 'admin/operator 필요');
        }
        const body = await new Promise((resolve) => {
          let raw = '';
          req.on('data', c => raw += c);
          req.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
        });
        logAdminAccess(session, req, 'coupang-rg-orders-sync', {
          start: body.start_date, end: body.end_date, dry_run: body.dry_run === true,
        });
        try {
          data = await require('./coupang/rg-orders').syncRgOrders({
            startDate: body.start_date,
            endDate: body.end_date,
            dryRun: body.dry_run === true,
          });
          // 주문을 넣었으면 단계까지 맞춘다 — 사람이 버튼을 하나 더 누르게 할 이유가 없다.
          if (body.dry_run !== true) {
            // 기간을 좁혀 수집했더라도 리포트가 아는 취소·배송완료는 전부 맞춘다
            try {
              data.order_status = await require('./coupang/rg-orders').syncRgOrderStatusFromReport({});
            } catch (e) {
              console.warn('[rg-orders sync] 주문 상태 반영 실패:', e.message);
            }
            try {
              data.workflow = await require('./coupang/rg-workflow').syncRocketGrowthWorkflow({
                dryRun: false,
                startDate: body.start_date,
                endDate: body.end_date,
                by: `rg-sync:${session?.email || 'system'}`,
              });
            } catch (e) {
              console.warn('[rg-orders sync] 워크플로우 연동 실패:', e.message);
              data.workflow_error = e.message;
            }
          }
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
          return;
        }
      } else if (pathname === '/api/coupang/rg-inventory' && req.method === 'GET') {
        // 로켓창고 재고 스냅샷 조회 (061) — 저장된 값만. 갱신은 sync 로.
        if (!isSuperAdmin(session) && !(await hasRole(session, ['admin', 'operator']))) {
          return denyForbidden(res, 'admin/operator 필요');
        }
        try {
          const rows = await require('./coupang/rg-inventory').listInventory();
          data = { items: rows, count: rows.length };
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
          return;
        }
      } else if (pathname === '/api/coupang/rg-inventory/sync' && req.method === 'POST') {
        // 쿠팡 재고 API → 스냅샷 갱신. 페이징 + 분당 50회 제한이라 수동/주기 실행만 한다.
        if (!isSuperAdmin(session) && !(await hasRole(session, ['admin', 'operator']))) {
          return denyForbidden(res, 'admin/operator 필요');
        }
        logAdminAccess(session, req, 'coupang-rg-inventory-sync', {});
        try {
          data = await require('./coupang/rg-inventory').syncRgInventory();
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
          return;
        }
      } else if (pathname === '/api/ga/probe' && req.method === 'GET') {
        // GA4 연결 진단 — 자격증명·속성·집계 방식·itemId 실제 값 확인 (읽기 전용)
        if (!isSuperAdmin(session) && !(await hasRole(session, ['admin', 'operator']))) {
          return denyForbidden(res, 'admin/operator 필요');
        }
        try {
          data = await require('./ga/report').probe({ days: parsed.query.days || 28 });
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
          return;
        }
      } else if (pathname === '/api/ga/funnel' && req.method === 'GET') {
        // 유입 → 구매 전환, 기간 A vs B. 분모는 GA 조회수, 분자는 우리 DB 주문 건수.
        if (!isSuperAdmin(session) && !(await hasRole(session, ['admin', 'operator']))) {
          return denyForbidden(res, 'admin/operator 필요');
        }
        try {
          const q = parsed.query;
          const sitesRaw = String(q.sites || '').trim();
          // 매출 화면과 같은 그룹 기준으로 묶는다 (2026-08-13 요청).
          //   운영자가 묶은 매출 그룹(migration 040)이 BASE 코드 규칙보다 우선.
          //   조회 실패 시 빈 인덱스라 예전처럼 BASE 로만 묶인다 (fail-open).
          const sgIndex = await _loadSalesGroupIndex('daeryepum');
          const groupOf = sgIndex.byCode.size
            ? (code) => sgIndex.byCode.get(String(code || '').trim().toLowerCase()) || null
            : null;
          data = await require('./ga/funnel').compare({
            a: { start: q.a_start, end: q.a_end },
            b: (q.b_start && q.b_end) ? { start: q.b_start, end: q.b_end } : null,
            sites: sitesRaw ? sitesRaw.split(',').map(s => s.trim()).filter(Boolean) : undefined,
            groupOf,
            // 주문은 기존 조회 경로를 그대로 쓴다 — 집계 규칙이 화면과 어긋나지 않게.
            fetchOrders: async (start, end) => {
              const r = await apiOrders({ start_date: start, end_date: end, category: 'daeryepum' });
              return Array.isArray(r) ? r : (r.orders || r.rows || []);
            },
          });
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
          return;
        }
      } else if (pathname === '/api/price-snapshot' && req.method === 'POST') {
        // 판매가 스냅샷 — 동기화 주기에 얹혀 자동으로 돌지만 수동 실행도 열어 둔다.
        //   dry_run 이면 무엇이 바뀌었는지만 보고 쓰지 않는다.
        if (!isSuperAdmin(session) && !(await hasRole(session, ['admin', 'operator']))) {
          return denyForbidden(res, 'admin/operator 필요');
        }
        const body = await new Promise((resolve) => {
          let raw = '';
          req.on('data', c => raw += c);
          req.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
        });
        try {
          data = await require('./barungift/price-watch').snapshotPrices({
            getPool, dryRun: body.dry_run === true,
          });
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
          return;
        }
      } else if (pathname === '/api/ga/price-trend' && req.method === 'GET') {
        // 가격 변경 × 유입·전환. 가격은 주문 단가로 되살린다 (가격 이력 테이블이 없다).
        if (!isSuperAdmin(session) && !(await hasRole(session, ['admin', 'operator']))) {
          return denyForbidden(res, 'admin/operator 필요');
        }
        try {
          const q = parsed.query;
          data = await require('./ga/price-trend').priceTrend({
            startDate: q.start_date,
            endDate: q.end_date,
            code: q.code || null,
            fetchOrders: async (start, end) => {
              const r = await apiOrders({ start_date: start, end_date: end, category: 'daeryepum' });
              return Array.isArray(r) ? r : (r.orders || r.rows || []);
            },
            // 옵션명 — 주문 rows 의 card_name 은 코드 대표명이라 옵션(색상·종류)을 못 가른다.
            //   S2_CARD 에서 판매단위 이름을 직접 읽는다.
            resolveSeqNames: async (seqList) => {
              const p = await getPool();
              const req = p.request();
              const inClause = seqList.slice(0, 500).map((s, i) => {
                req.input(`s${i}`, Number(s));
                return `@s${i}`;
              }).join(',');
              const rs = await req.query(
                `SELECT Card_Seq, Card_Name FROM S2_CARD WITH (NOLOCK) WHERE Card_Seq IN (${inClause})`);
              return new Map(rs.recordset.map(r => [Number(r.Card_Seq), String(r.Card_Name || '')]));
            },
          });
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
          return;
        }
      } else if (pathname === '/api/ga/clickmap/pages' && req.method === 'GET') {
        // 클릭맵 페이지 목록 — 상세페이지 경로 + 상품코드 + 조회수
        if (!isSuperAdmin(session) && !(await hasRole(session, ['admin', 'operator']))) {
          return denyForbidden(res, 'admin/operator 필요');
        }
        try {
          data = await require('./ga/clickmap').listPages({
            site: parsed.query.site || 'card',
            startDate: parsed.query.start_date || null,
            endDate: parsed.query.end_date || null,
            giftOnly: parsed.query.gift_only !== '0',
          });
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
          return;
        }
      } else if (pathname === '/api/ga/clickmap/clicks' && req.method === 'GET') {
        // 한 상세페이지의 클릭 분해 (click_text 기준, 이벤트별 분리)
        if (!isSuperAdmin(session) && !(await hasRole(session, ['admin', 'operator']))) {
          return denyForbidden(res, 'admin/operator 필요');
        }
        try {
          data = await require('./ga/clickmap').clicksForPath({
            site: parsed.query.site || 'card',
            path: parsed.query.path || '',
            startDate: parsed.query.start_date || null,
            endDate: parsed.query.end_date || null,
            device: ['desktop', 'mobile'].includes(parsed.query.device) ? parsed.query.device : 'all',
          });
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
          return;
        }
      } else if (pathname === '/api/ga/clickmap/snapshot' && req.method === 'GET') {
        // 상세페이지 HTML 스냅샷 — 우리 origin 에서 서빙해야 iframe DOM 접근이 된다.
        //   경로 화이트리스트는 clickmap.snapshot 안에서 검증한다 (SSRF 방지).
        if (!isSuperAdmin(session) && !(await hasRole(session, ['admin', 'operator']))) {
          return denyForbidden(res, 'admin/operator 필요');
        }
        try {
          const snap = await require('./ga/clickmap').snapshot({
            site: parsed.query.site || 'card',
            path: parsed.query.path || '',
            device: parsed.query.device === 'mobile' ? 'mobile' : 'desktop',
          });
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            // 스냅샷 안에서 우리 API 로 요청이 나가면 안 된다 — 문서 자체를 봉인
            'Content-Security-Policy':
              "default-src 'none'; img-src https: data:; style-src https: 'unsafe-inline'; font-src https: data:",
            'Cache-Control': 'private, max-age=300',
          });
          res.end(snap.html);
          return;
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
          return;
        }
      } else if (pathname === '/api/ga/products' && req.method === 'GET') {
        // 상품별 유입·구매전환 (바른손카드·바른손몰)
        if (!isSuperAdmin(session) && !(await hasRole(session, ['admin', 'operator']))) {
          return denyForbidden(res, 'admin/operator 필요');
        }
        try {
          const sitesRaw = String(parsed.query.sites || '').trim();
          data = await require('./ga/report').productReport({
            sites: sitesRaw ? sitesRaw.split(',').map(s => s.trim()).filter(Boolean) : undefined,
            startDate: parsed.query.start_date || null,
            endDate: parsed.query.end_date || null,
            mode: ['item', 'page', 'auto'].includes(parsed.query.mode) ? parsed.query.mode : 'auto',
            // 기본은 답례품만 — GA 상품 대부분이 청첩장이라 섞으면 답례품이 묻힌다
            scope: parsed.query.scope === 'all' ? 'all' : 'gift',
          });
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
          return;
        }
      } else if (pathname === '/api/dispatch/pending' && req.method === 'GET') {
        // 출고상태 전송 대기 목록 — 채널에서 아직 '발송 전' 인 주문 + 우리 송장 매칭 결과.
        if (!isSuperAdmin(session) && !(await hasRole(session, ['admin', 'operator']))) {
          return denyForbidden(res, 'admin/operator 필요');
        }
        try {
          const chParam = String(parsed.query.channels || '').trim();
          data = await require('./channel-dispatch').listPending({
            daysBack: parsed.query.days || 14,
            channels: chParam ? chParam.split(',').map(s => s.trim()).filter(Boolean) : undefined,
          });
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
          return;
        }
      } else if (pathname === '/api/dispatch/send' && req.method === 'POST') {
        // 실제 출고상태 전송 — 고객에게 발송 알림이 나가고 되돌릴 수 없다.
        //   confirm:true 가 없으면 미리보기만 돌려준다 (channel-dispatch 안에서 판정).
        if (!isSuperAdmin(session) && !(await hasRole(session, ['admin', 'operator']))) {
          return denyForbidden(res, 'admin/operator 필요');
        }
        const body = await new Promise((resolve) => {
          let raw = '';
          req.on('data', c => raw += c);
          req.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
        });
        const confirm = body.confirm === true;
        logAdminAccess(session, req, 'channel-dispatch-send', {
          confirm, count: Array.isArray(body.items) ? body.items.length : 0,
        });
        try {
          data = await require('./channel-dispatch').sendDispatch({
            items: body.items || [],
            confirm,
            by: session?.email || 'system',
          });
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
          return;
        }
      } else if (pathname === '/api/coupang/rfm/workflow-sync' && req.method === 'POST') {
        // 로켓그로스 리포트 → 정보입력현황 단계 반영 (배송완료 → 출고완료 / 미배송 → 포장완료).
        //   업로드 시 자동으로 한 번 돌지만, 상품설정을 나중에 고친 경우 등 수동 재실행용.
        if (!isSuperAdmin(session) && !(await hasRole(session, ['admin', 'operator']))) {
          return denyForbidden(res, 'admin/operator 필요');
        }
        const body = await new Promise((resolve) => {
          let raw = '';
          req.on('data', c => raw += c);
          req.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
        });
        const dryRun = body.dry_run !== false;   // 기본은 미리보기
        logAdminAccess(session, req, 'coupang-rg-workflow-sync', { dry_run: dryRun });
        try {
          const { syncRocketGrowthWorkflow } = require('./coupang/rg-workflow');
          data = await syncRocketGrowthWorkflow({
            dryRun,
            startDate: body.start_date || null,
            endDate: body.end_date || null,
            by: `rg-sync:${session?.email || 'system'}`,
          });
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
          return;
        }
      } else if (pathname === '/api/coupang/rfm/lines' && req.method === 'GET') {
        // 주문 단위 목록 — basis 로 날짜 축 전환 (paid=결제완료일 / delivered=배송완료일)
        if (!isSuperAdmin(session) && !(await hasRole(session, ['admin', 'operator']))) {
          return denyForbidden(res, 'admin/operator 필요');
        }
        try {
          const rows = await require('./coupang/rfm-store').listOrderLines({
            basis: parsed.query.basis === 'delivered' ? 'delivered' : 'paid',
            startDate: parsed.query.start_date || null,
            endDate: parsed.query.end_date || null,
          });
          // 내부 상품코드·스티커코드는 저장하지 않고 조회 시점에 붙인다 (058).
          //   상품설정이 바뀌면 과거 라인 표시도 함께 따라가야 하기 때문.
          //   옵션ID 매핑 > 등록상품ID 매핑 (057 과 같은 우선순위).
          try {
            const byOption = new Map();
            const byProduct = new Map();
            for (const ps of (await require('./barungift/store').getAllProductSettings()) || []) {
              const m = ps.channel_product_codes?.coupang;
              if (!m) continue;
              const unit = parseInt(ps.channel_sales_units?.coupang, 10);
              const num = (v) => (v === null || v === undefined || v === '' ? null
                : (Number.isFinite(Number(v)) ? Number(v) : null));
              const info = {
                code: ps.product_id,
                sticker: ps.channel_stickers?.coupang || null,
                unit: unit > 1 ? unit : 1,   // 060 — 이 채널 1 주문 = 실제 상품 몇 개
                // 원가 (068) — NULL(미입력) 은 그대로 넘긴다. 0 으로 바꾸면 원가를
                //   모르는 상품이 '원가 0 = 마진 100%' 로 보인다.
                unit_cost: num(ps.unit_cost),
                inbound_unit_cost: num(ps.inbound_unit_cost),
              };
              const pIds = Array.isArray(m) ? m : (m.product_ids || []);
              // 같은 등록상품ID 를 두 상품이 등록하면 그 ID 만으로는 어느 상품인지 정할 수 없다.
              //   예전엔 나중 것이 조용히 이겨(Map.set 덮어쓰기) 화이트 주문이 통째로 블루 코드로
              //   들어갔다 (TGJSD04D1/D2 가 16191414384 를 공유, 2026-08-18 발견).
              //   그래서 모호한 ID 는 매핑하지 않고 표시해 옵션ID 등록을 유도한다.
              for (const c of pIds) {
                const k = String(c).trim();
                if (byProduct.has(k)) {
                  const prev = byProduct.get(k);
                  if (prev && prev.code !== info.code) {
                    prev.ambiguous = true;
                    prev.rivals = [...new Set([...(prev.rivals || [prev.code]), info.code])];
                  }
                } else {
                  byProduct.set(k, info);
                }
              }
              for (const c of (Array.isArray(m) ? [] : (m.option_ids || []))) {
                byOption.set(String(c).trim(), info);
              }
            }
            // 옵션ID → 등록상품ID (063) — 정산 전 주문은 등록상품ID 가 비어 있다
            let optToProduct = new Map();
            try { optToProduct = await require('./coupang/option-map').getOptionToProduct(); }
            catch (e) { console.warn('[rfm/lines] 옵션맵 로드 실패:', e.message); }
            for (const r of rows) {
              const vid = String(r.vendor_item_id || '').trim();
              const spid = String(r.seller_product_id || '').trim() || optToProduct.get(vid) || '';
              if (!r.seller_product_id && spid) r.seller_product_id = spid;   // 화면에 근거를 남긴다
              // 옵션ID 매핑이 우선 — 등록상품ID 는 옵션을 구분하지 못한다
              const byOpt = byOption.get(vid);
              const byProd = byProduct.get(spid);
              // 등록상품ID 가 여러 상품에 걸쳐 있으면 그걸로는 확정할 수 없다.
              //   틀린 코드로 집계하느니 미매핑으로 두고 사유를 알린다.
              const ambiguous = !byOpt && !!byProd?.ambiguous;
              const hit = byOpt || (ambiguous ? null : byProd);
              r.internal_product_code = hit?.code || null;
              r.sticker_code = hit?.sticker || null;
              r.map_conflict = ambiguous
                ? `등록상품ID ${spid} 를 ${(byProd.rivals || []).join(' / ')} 가 함께 쓰고 있어 옵션ID 등록이 필요합니다`
                : null;
              // 주문수량(엑셀 그대로) × 판매단위 = 상품수량(실제 출고 개수).
              //   미매핑이면 단위를 알 수 없어 1 로 둔다 — 주문수량과 같아진다.
              r.sales_unit = hit?.unit || 1;
              r.item_qty = (Number(r.sales_qty) || 0) * r.sales_unit;
              // 원가·마진 (068) — 원가는 '상품 1개당' 이므로 주문수량이 아니라 상품수량을 곱한다.
              //   원가가 미입력(NULL)이면 마진을 만들지 않는다 — 화면에서 '원가 미입력' 으로 구분.
              r.unit_cost = hit?.unit_cost ?? null;
              r.inbound_unit_cost = hit?.inbound_unit_cost ?? null;
              const costPer = (r.unit_cost === null && r.inbound_unit_cost === null)
                ? null : (Number(r.unit_cost || 0) + Number(r.inbound_unit_cost || 0));
              r.cost_total = costPer === null ? null : costPer * (Number(r.item_qty) || 0);
              if (r.cost_total === null) {
                r.margin = null;
                r.margin_rate = null;
              } else {
                // 정산금액(매출−수수료−물류비) 에서 원가를 뺀 값이 실제로 남는 돈이다
                const settle = (Number(r.settlement_amount) || 0)
                  - (Number(r.inout_fee) || 0) - (Number(r.shipping_fee) || 0);
                r.margin = settle - r.cost_total;
                const sales = Number(r.sales_amount) || 0;
                r.margin_rate = sales > 0 ? Math.round((r.margin / sales) * 1000) / 10 : null;
              }
            }
          } catch (e) {
            console.warn('[rfm/lines] 상품코드 매핑 실패 (원본만 표시):', e.message);
          }
          data = { lines: rows };
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
            AND co.status_seq NOT IN (3, 5, 9)
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
              AND co.status_seq NOT IN (3, 5, 9)
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
                AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5, 9)
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
              AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5, 9)
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
      } else if (pathname === '/api/product-ranking') {
        data = await apiProductRanking(parsed.query);
      } else if (pathname === '/api/weekly-report') {
        data = await apiWeeklyReport(parsed.query);
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
  // 경로 탈출 방지 — __dirname 밖 접근 차단
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' };
  // 이미지 등 바이너리 — utf-8 로 읽으면 깨지므로 Buffer 그대로 응답 (매뉴얼 캡처 이미지용)
  const binaryTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon' };

  try {
    if (binaryTypes[ext]) {
      const buf = fs.readFileSync(filePath);
      res.writeHead(200, { 'Content-Type': binaryTypes[ext], 'Cache-Control': 'public, max-age=3600' });
      res.end(buf);
      return;
    }
    const contentType = mimeTypes[ext] || 'application/octet-stream';
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

/**
 * 쿠팡 자동 동기화 — 컨테이너 안에서 돈다.
 *
 * /api/coupang/sync 는 외부 크론이 부를 수 있게 열려 있지만(EXPORT_API_KEY),
 * 실제로 그 크론을 걸어 둔 곳이 없어 사람이 버튼을 눌러야만 수집됐다.
 * 로켓그로스 주문·옵션맵까지 같은 핸들러에 얹혀 있으니 여기서 주기적으로 부른다.
 * 재고 알림 스케줄러와 같은 방식(자기 자신에게 내부 토큰으로 호출).
 *
 * 외부 크론을 따로 걸었다면 COUPANG_AUTO_SYNC_DISABLED=1 로 끄면 된다.
 */
function scheduleCoupangSync(baseUrl) {
  if (process.env.COUPANG_AUTO_SYNC_DISABLED === '1') {
    console.log('[coupang auto-sync] 비활성 (COUPANG_AUTO_SYNC_DISABLED=1)');
    return;
  }
  if (!require('./coupang/api').isConfigured()) {
    console.log('[coupang auto-sync] 쿠팡 API 키 미설정 — 자동 동기화 건너뜀');
    return;
  }
  const minutes = Math.min(Math.max(parseInt(process.env.COUPANG_SYNC_INTERVAL_MIN, 10) || 15, 5), 1440);
  const daysBack = Math.min(Math.max(parseInt(process.env.COUPANG_SYNC_DAYS_BACK, 10) || 7, 1), 30);
  let running = false;

  async function tick() {
    // 앞 회차가 길어지면 겹쳐 돌지 않게 한다 — 쿠팡 호출량이 두 배가 된다
    if (running) return;
    running = true;
    try {
      const res = await fetch(`${baseUrl}/api/coupang/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-token': INTERNAL_TOKEN },
        body: JSON.stringify({ days_back: daysBack }),
      });
      const d = await res.json().catch(() => ({}));
      if (d.error) {
        console.warn('[coupang auto-sync] 실패:', d.error);
      } else {
        console.log(`[coupang auto-sync] 마켓플레이스 ${d.fetched ?? '?'}건`
          + ` · 로켓그로스 ${d.rocket_growth?.orders ?? (d.rocket_growth?.error ? 'ERR' : '-')}건`
          + ` · 옵션맵 ${d.option_map?.options ?? (d.option_map?.error ? 'ERR' : '-')}개`);
      }
    } catch (e) {
      console.warn('[coupang auto-sync] 오류:', e.message);
    } finally {
      running = false;
    }
  }

  // 기동 직후는 피한다 — 부팅 중 DB/네트워크가 아직 안 붙었을 수 있다
  setTimeout(() => { tick().catch(() => {}); }, 60000);
  setInterval(() => { tick().catch(() => {}); }, minutes * 60000);
  console.log(`[coupang auto-sync] ${minutes}분 주기 시작 (최근 ${daysBack}일 · 끄려면 COUPANG_AUTO_SYNC_DISABLED=1)`);
}

/**
 * 답례품 판매가 스냅샷 — 값이 바뀐 것만 남긴다.
 *
 * 왜 이게 필요한가 (2026-08-14 조사):
 *   원본 상품 DB(S2_CARD)에는 '지금 얼마인지' 만 있고 '언제 바뀌었는지' 가 없다.
 *   가격 변경 로그(ADMIN_PRICE_LOGINFO)는 청첩장만 3,299건 쌓이고 답례품은 0건이다.
 *   그래서 우리가 주기적으로 읽어 변화를 기록해 둬야 '가격 변경 × 전환율' 이 정확해진다
 *   (지금은 주문 단가로 역산하는데, 주문이 없는 날은 가격을 알 수 없다).
 *
 * 새 크론(컨테이너·스케줄)을 만들지 않고 기존 인-프로세스 스케줄러에 얹는다.
 * 쿠팡 자동동기화와 묶지 않은 이유: 쿠팡 키가 없거나 자동동기화를 끄면 가격 추적까지
 *   조용히 멈춘다. 서로 무관한 작업이라 따로 돈다.
 *
 * 값이 그대로면 아무것도 쓰지 않으므로 비용은 조회 한 번이다. 끄려면 PRICE_SNAPSHOT_DISABLED=1.
 */
function schedulePriceSnapshot() {
  if (process.env.PRICE_SNAPSHOT_DISABLED === '1') {
    console.log('[price-snapshot] 비활성 (PRICE_SNAPSHOT_DISABLED=1)');
    return;
  }
  const minutes = Math.min(Math.max(parseInt(process.env.PRICE_SNAPSHOT_INTERVAL_MIN, 10) || 30, 5), 1440);
  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    try {
      const snap = await require('./barungift/price-watch').snapshotPrices({ getPool });
      if (snap.skipped) return;
      if (snap.error) { console.warn('[price-snapshot]', snap.error); return; }
      if (snap.changed) {
        console.log(`[price-snapshot] 가격변경 ${snap.changed}건: `
          + snap.details.map(d => `${d.code} ${d.from}→${d.to}`).join(', '));
      } else if (snap.baseline) {
        console.log(`[price-snapshot] 기준선 ${snap.baseline}건 기록`);
      }
    } catch (e) {
      console.warn('[price-snapshot] 오류:', e.message);
    } finally {
      running = false;
    }
  }

  // 기동 직후는 피한다 — 부팅 중 MSSQL/Supabase 가 아직 안 붙었을 수 있다
  setTimeout(() => { tick().catch(() => {}); }, 90000);
  setInterval(() => { tick().catch(() => {}); }, minutes * 60000);
  console.log(`[price-snapshot] ${minutes}분 주기 시작 (끄려면 PRICE_SNAPSHOT_DISABLED=1)`);
}

/**
 * 네이버 구매확정일 소급 채우기 — 하루 한 번.
 *
 * 네이버는 배송완료 한참 뒤에 자동으로 구매확정을 건다(배송완료 07-29 → 자동확정 08-06).
 * 그때쯤이면 주문 동기화 기간(최근 7일)이 그 주문을 이미 지나쳐, 우리 DB 는 '배송완료' 로
 * 멈춘 채 구매확정일이 영영 비어 있게 된다. 그래서 주문 동기화와 별개로 주기적으로 훑는다.
 *
 * 하루 한 번이면 충분하다 — 자동확정 자체가 하루 단위로 걸린다.
 * 끄려면 NAVER_CONFIRM_BACKFILL_DISABLED=1.
 */
function scheduleNaverConfirmBackfill() {
  if (process.env.NAVER_CONFIRM_BACKFILL_DISABLED === '1') {
    console.log('[naver confirm-backfill] 비활성 (NAVER_CONFIRM_BACKFILL_DISABLED=1)');
    return;
  }
  if (!require('./naver/api').isConfigured()) {
    console.log('[naver confirm-backfill] 네이버 API 키 미설정 — 건너뜀');
    return;
  }
  // 실행 시각 (KST). 기본 04:10 — 네이버 자동확정이 새벽에 걸린 뒤를 노린다.
  const target = (() => {
    const m = /^(\d{1,2}):(\d{1,2})$/.exec(process.env.NAVER_CONFIRM_BACKFILL_TIME || '04:10');
    if (!m) return 4 * 60 + 10;
    const h = Number(m[1]), mi = Number(m[2]);
    return (h >= 0 && h <= 23 && mi >= 0 && mi <= 59) ? h * 60 + mi : 4 * 60 + 10;
  })();
  const MAX_PAGES = 20;          // 한 번에 최대 2000건 — 못 채운 건은 다음 날 이어서
  let lastRunDate = null;
  let running = false;

  async function tick() {
    if (running) return;
    const kst = new Date(Date.now() + 9 * 3600 * 1000);
    const today = kst.toISOString().slice(0, 10);
    if (lastRunDate === today) return;
    const nowMin = kst.getUTCHours() * 60 + kst.getUTCMinutes();
    const delta = nowMin - target;
    // 창을 벗어난 늦은 기동(재배포 등)에는 돌지 않는다 — 엉뚱한 시각 실행 방지
    if (delta < 0 || delta > 10) return;
    lastRunDate = today;          // 실패해도 같은 날 재시도하지 않는다
    running = true;
    const total = { processed: 0, updated: 0, no_change: 0, failed: 0 };
    try {
      const naverSync = require('./naver/sync');
      let offset = 0;
      for (let i = 0; i < MAX_PAGES; i++) {
        const r = await naverSync.backfillConfirmedAt({
          offset, limit: 100, alsoUpdateStatus: true, scope: 'shippable',
        });
        if (r.error) throw new Error(r.error);
        total.processed += r.processed || 0;
        total.updated += r.updated || 0;
        total.no_change += r.no_change || 0;
        total.failed += r.failed || 0;
        if (!r.processed || !r.remaining) break;
        offset = r.offset_next;
      }
      console.log(`[naver confirm-backfill] 완료 — 확인 ${total.processed} / 채움 ${total.updated}`
        + ` / 변화없음 ${total.no_change}${total.failed ? ` / 실패 ${total.failed}` : ''}`);
    } catch (e) {
      console.error('[naver confirm-backfill] 실패:', e.message);
    } finally {
      running = false;
    }
  }

  setInterval(() => { tick().catch(() => {}); }, 60000);
  const hh = String(Math.floor(target / 60)).padStart(2, '0');
  const mm = String(target % 60).padStart(2, '0');
  console.log(`[naver confirm-backfill] 매일 ${hh}:${mm} KST 실행 (끄려면 NAVER_CONFIRM_BACKFILL_DISABLED=1)`);
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`답례품 관리 서버: http://localhost:${PORT}${BASE_PATH || ''}`);
  // 재고 데일리 슬랙 알림 — BG_STOCK_ALERT_ENABLED=1 일 때만 등록
  require('./barungift/stock-alert')
    .scheduleDailyStockAlert(`http://localhost:${PORT}${BASE_PATH || ''}`);
  scheduleCoupangSync(`http://localhost:${PORT}${BASE_PATH || ''}`);
  scheduleNaverConfirmBackfill();
  schedulePriceSnapshot();
});

// 서버 크래시 방지
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err.message, err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
