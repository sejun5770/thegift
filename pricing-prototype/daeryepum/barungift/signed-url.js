/**
 * 바른기프트 고객 주문 URL 서명 유틸 (HMAC-SHA256)
 *
 * 목적: 주문번호만 유추해 접근하는 열거 공격 차단.
 *       `?oid=BHS-XXXXXXX&t=<unix>&sig=<hmac>` 쿼리로 접근 권한 증명.
 *
 * 정책 (Phase 3 초기 도입):
 *   - BG_URL_SIGN_STRICT=true  : 서명 누락/무효 시 403
 *   - BG_URL_SIGN_STRICT=false : 기존 LMS 링크 호환을 위해 경고만 감사로그 기록 (기본값)
 *
 * 유효기간: BG_URL_SIGN_MAX_AGE_SEC (기본 60일, 고객 LMS 링크 노출 주기 고려)
 *
 * 주의: LMS 발송측 URL 생성은 이 세션에서 구현하지 않음. 관리자 화면에서
 *      수동 복사/테스트용 API 만 제공. 기존 bare URL(oid only) 은 계속 동작.
 */
const crypto = require('crypto');

const SECRET = process.env.BG_URL_SIGN_SECRET
  || process.env.SESSION_SECRET
  || 'bg-default-sign-secret';
const MAX_AGE_SEC = parseInt(process.env.BG_URL_SIGN_MAX_AGE_SEC) || 60 * 24 * 3600; // 60일
const STRICT = process.env.BG_URL_SIGN_STRICT === 'true';
const SIG_LEN = 32; // base64url 32자 (192bit) — 주문 식별엔 충분

function computeSig(oid, ts) {
  const payload = String(oid) + ':' + ts;
  return crypto.createHmac('sha256', SECRET).update(payload).digest('base64url').slice(0, SIG_LEN);
}

/** 주어진 주문ID 에 대한 서명 쿼리 파라미터 생성 */
function sign(oid, tsOverride) {
  const ts = tsOverride || Math.floor(Date.now() / 1000);
  return { t: ts, sig: computeSig(oid, ts) };
}

/**
 * 쿼리 파라미터 `t`, `sig` 검증
 * @returns {{valid: boolean, reason?: string, expired?: boolean}}
 */
function verify(oid, t, sig) {
  if (!oid) return { valid: false, reason: 'missing_oid' };
  if (!t || !sig) return { valid: false, reason: 'missing_signature' };

  const ts = parseInt(t);
  if (!Number.isFinite(ts) || ts <= 0) return { valid: false, reason: 'invalid_timestamp' };

  const now = Math.floor(Date.now() / 1000);
  // 시계 오차 허용 5분 미래까지 인정
  if (ts > now + 300) return { valid: false, reason: 'future_timestamp' };
  if (MAX_AGE_SEC > 0 && (now - ts) > MAX_AGE_SEC) {
    return { valid: false, reason: 'expired', expired: true };
  }

  const expected = computeSig(oid, ts);
  if (typeof sig !== 'string' || sig.length !== expected.length) {
    return { valid: false, reason: 'invalid_signature' };
  }
  // Timing-safe compare
  let ok = false;
  try {
    ok = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
  } catch { ok = false; }
  if (!ok) return { valid: false, reason: 'invalid_signature' };

  return { valid: true };
}

/**
 * baseUrl 에 oid/t/sig 붙여 full URL 반환
 * 예) buildUrl('https://bg.example.com/c/barungift/order-info', 'BHS-1234567')
 */
function buildUrl(baseUrl, oid) {
  const { t, sig } = sign(oid);
  try {
    const u = new URL(baseUrl);
    u.searchParams.set('oid', String(oid));
    u.searchParams.set('t', String(t));
    u.searchParams.set('sig', sig);
    return u.toString();
  } catch (e) {
    // baseUrl 이 상대경로일 수 있으니 manual join
    const sep = baseUrl.includes('?') ? '&' : '?';
    return baseUrl + sep
      + 'oid=' + encodeURIComponent(oid)
      + '&t=' + t
      + '&sig=' + encodeURIComponent(sig);
  }
}

module.exports = {
  sign,
  verify,
  buildUrl,
  STRICT,
  MAX_AGE_SEC,
  // 테스트/진단용 — 운영에서는 사용 비권장
  _computeSig: computeSig,
};
