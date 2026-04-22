/**
 * 고객 API Rate Limiter (IP 해시 기반 인메모리 슬라이딩 윈도우)
 *
 * - 다중 인스턴스 배포 시에는 공유 저장소(Redis/Supabase)가 필요하나,
 *   현 배포 구성은 단일 Node 컨테이너이므로 인메모리로 충분.
 * - IP 는 SHA-256(ip + salt) 로 해시해 키로 사용 — 원본 IP 미보존.
 * - 윈도우 만료 시 자동 정리 (10분 주기).
 *
 * 사용:
 *   const { check, LIMITS } = require('./rate-limit');
 *   const rl = check(req, 'search', LIMITS.search);
 *   if (!rl.allowed) return rateLimitResponse(res, rl);
 */
const crypto = require('crypto');

const SALT = process.env.SESSION_SECRET || 'bg-audit-default-salt';

// key: `${action}:${ipHash}` → { resetAt, count }
const buckets = new Map();

// 만료된 버킷 정리 (메모리 누수 방지)
const CLEANUP_INTERVAL = 10 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets) {
    if (v.resetAt < now) buckets.delete(k);
  }
}, CLEANUP_INTERVAL).unref();

function extractIp(req) {
  if (!req) return null;
  const xff = req.headers['x-forwarded-for'] || req.headers['x-real-ip'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket?.remoteAddress || null;
}

function hashIp(ip) {
  return crypto.createHash('sha256').update((ip || 'unknown') + SALT).digest('hex').slice(0, 16);
}

/**
 * 고정 윈도우 rate limit 체크 & 카운트 증가
 * @param {object} req - HTTP IncomingMessage
 * @param {string} action - 'login' | 'search' | 'view' | 'submit' 등
 * @param {{max: number, windowMs: number}} config
 * @returns {{allowed: boolean, retryAfterSec: number, ipHash: string, current: number, max: number}}
 */
function check(req, action, config) {
  const { max, windowMs } = config;
  const ipHash = hashIp(extractIp(req));
  const key = action + ':' + ipHash;
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt < now) {
    // 새 윈도우 시작
    buckets.set(key, { resetAt: now + windowMs, count: 1 });
    return { allowed: true, retryAfterSec: 0, ipHash, current: 1, max };
  }

  bucket.count++;
  if (bucket.count > max) {
    return {
      allowed: false,
      retryAfterSec: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
      ipHash,
      current: bucket.count,
      max,
    };
  }
  return { allowed: true, retryAfterSec: 0, ipHash, current: bucket.count, max };
}

/** 응답 유틸 — 429 Too Many Requests + Retry-After 헤더 */
function rateLimitResponse(res, rl) {
  res.writeHead(429, {
    'Content-Type': 'application/json; charset=utf-8',
    'Retry-After': String(rl.retryAfterSec),
  });
  res.end(JSON.stringify({
    error: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.',
    retry_after_sec: rl.retryAfterSec,
  }));
}

/**
 * 액션별 제한. 값은 환경변수로 오버라이드 가능.
 *   BG_RL_LOGIN_MAX, BG_RL_LOGIN_WINDOW_SEC, ...
 *
 * 기본 정책 (1분 윈도우):
 *   login  5회  — 무차별 로그인 대비
 *   search 10회 — 이름+전화번호 열거 공격 대비
 *   view   30회 — 정상 고객 화면 재로딩/재시도 허용 여유
 *   submit 5회  — 정보 제출은 본래 1회성
 */
function envInt(k, def) { const v = parseInt(process.env[k]); return isNaN(v) ? def : v; }
const LIMITS = {
  login:  { max: envInt('BG_RL_LOGIN_MAX', 5),   windowMs: envInt('BG_RL_LOGIN_WINDOW_SEC', 60) * 1000 },
  search: { max: envInt('BG_RL_SEARCH_MAX', 10), windowMs: envInt('BG_RL_SEARCH_WINDOW_SEC', 60) * 1000 },
  view:   { max: envInt('BG_RL_VIEW_MAX', 30),   windowMs: envInt('BG_RL_VIEW_WINDOW_SEC', 60) * 1000 },
  submit: { max: envInt('BG_RL_SUBMIT_MAX', 5),  windowMs: envInt('BG_RL_SUBMIT_WINDOW_SEC', 60) * 1000 },
};

module.exports = { check, rateLimitResponse, LIMITS, hashIp, extractIp };
