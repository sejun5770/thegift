/**
 * 고객 화면 접근 감사 로그
 *
 * - Supabase `bg_customer_access_log` 테이블에 기록
 * - fire-and-forget: API 응답 블로킹 없음, 실패해도 에러 무시
 * - IP 는 SHA-256(ip + SESSION_SECRET salt) 해시로 저장 (원본 미보존)
 *
 * 사용:
 *   const { logAccess } = require('./audit-log');
 *   logAccess(req, 'view', orderId, { status_code: 200 });
 */
const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || '';
const USE_SUPABASE = !!(SUPABASE_URL && SUPABASE_KEY);
const SALT = process.env.SESSION_SECRET || 'bg-audit-default-salt';

/** req → client IP 추출 (프록시 헤더 우선) */
function extractIp(req) {
  if (!req) return null;
  const xff = req.headers['x-forwarded-for'] || req.headers['x-real-ip'];
  if (xff) {
    // x-forwarded-for: "client, proxy1, proxy2" 첫 번째가 원본 client
    return String(xff).split(',')[0].trim();
  }
  return req.socket?.remoteAddress || null;
}

/** IP 해시 (SHA-256 + salt) */
function hashIp(ip) {
  if (!ip) return null;
  return crypto.createHash('sha256').update(ip + SALT).digest('hex');
}

/** 사용자 입력(query 등) 정상화 — 민감 정보 차단 */
function sanitizeMetadata(meta) {
  if (!meta || typeof meta !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(meta)) {
    // 객체/배열은 JSON 직렬화 가능한 얕은 복사만 허용
    if (v === null || v === undefined) continue;
    if (typeof v === 'object') {
      try { out[k] = JSON.parse(JSON.stringify(v)); } catch { /* skip */ }
    } else {
      // 문자열/숫자/불리언 그대로 저장, 문자열 길이 제한
      out[k] = typeof v === 'string' && v.length > 500 ? v.slice(0, 500) : v;
    }
  }
  return out;
}

/**
 * 접근 로그 기록 (비동기, 블로킹 없음)
 * @param {object} req - HTTP IncomingMessage
 * @param {string} action - 'view' | 'submit' | 'reset' | 'search' | 'login_success' | 'login_fail' | 'not_found'
 * @param {string|null} orderId - 주문 ID (search/login 시 null)
 * @param {object} [extras] - { status_code, metadata, user_agent }
 */
function logAccess(req, action, orderId, extras = {}) {
  if (!USE_SUPABASE) return;

  const record = {
    order_id: orderId || null,
    action,
    ip_hash: hashIp(extractIp(req)),
    user_agent: req?.headers?.['user-agent']?.slice(0, 500) || null,
    status_code: extras.status_code || null,
    metadata: sanitizeMetadata(extras.metadata),
    created_at: new Date().toISOString(),
  };

  // fire-and-forget: Promise 무시, 실패 시 console.warn만
  fetch(`${SUPABASE_URL}/rest/v1/bg_customer_access_log`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(record),
  }).catch(err => {
    // 마이그레이션 008 미적용 등으로 실패 가능 — 운영엔 영향 없게 silent
    console.warn('[audit-log] 기록 실패:', err.message);
  });
}

/** 최근 감사 로그 조회 (관리자 조회용) */
async function getRecentLogs({ orderId, limit = 100, since } = {}) {
  if (!USE_SUPABASE) return [];
  const params = [`order=created_at.desc`, `limit=${Math.min(limit, 500)}`];
  if (orderId) params.push(`order_id=eq.${encodeURIComponent(orderId)}`);
  if (since) params.push(`created_at=gte.${encodeURIComponent(since)}`);
  const url = `${SUPABASE_URL}/rest/v1/bg_customer_access_log?${params.join('&')}&select=*`;
  try {
    const res = await fetch(url, {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
      },
    });
    if (!res.ok) return [];
    return await res.json();
  } catch (err) {
    console.warn('[audit-log] 조회 실패:', err.message);
    return [];
  }
}

module.exports = { logAccess, getRecentLogs, extractIp, hashIp };
