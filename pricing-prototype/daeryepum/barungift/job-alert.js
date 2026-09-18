/**
 * 자동 작업 실패 슬랙 알림 — 쿠팡 주문 가져오기 · 로켓그로스 · 구매확정 보정(쿠팡/네이버) · 가격 스냅샷.
 *
 * 왜 필요한가 (2026-09-17):
 *   이 작업들은 서버 안 스케줄러로 돌며, 실패하면 컨테이너 로그에만 남았다. "쿠팡 주문이 안 보인다"는
 *   말이 나오기 전까지 아무도 몰랐다. 문자 자동 발송·재고 알림처럼 슬랙으로 알린다.
 *
 * 규칙:
 *   - 연속 실패가 threshold 회에 닿으면 1번 알린다. 짧은 주기 작업은 일시적인 네트워크 오류로
 *     알림이 쏟아지지 않게 2회부터, 하루 한 번 작업은 1회부터.
 *   - 계속 실패하면 remindHours 마다 한 번 더 알린다 (묻히지 않게).
 *   - 알린 뒤 성공하면 "복구" 를 1번 알린다.
 *   - 알림 실패가 작업을 멈추게 해선 안 된다 — 여기서 나는 오류는 전부 삼키고 로그만 남긴다.
 *   - 상태는 프로세스 메모리 — 재배포하면 연속 횟수가 0 부터 다시 센다.
 */
'use strict';

const MAX_ERROR_LEN = 300;

function _kstTime(ms) {
  const d = new Date(ms + 9 * 3600 * 1000);
  return `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')} `
    + `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

function _oneLine(err) {
  const s = String((err && err.message) || err || '알 수 없는 오류').replace(/\s+/g, ' ').trim();
  return s.length > MAX_ERROR_LEN ? s.slice(0, MAX_ERROR_LEN) + '…' : s;
}

/**
 * @param {object} job
 *   label      화면·슬랙에 보이는 이름 (예: '쿠팡 주문 가져오기')
 *   schedule   주기 설명 (예: '15분마다', '매일 04:20')
 *   impact     멈추면 생기는 일
 *   action     확인·조치 방법
 *   threshold  알림을 보낼 연속 실패 횟수 (기본 1)
 *   remindHours 계속 실패할 때 다시 알리는 간격 (기본 6, 0 이면 다시 알리지 않음)
 * @param {object} deps
 *   post(text)  슬랙 발송 — Promise. 실패하면 throw.
 *   now()       현재 ms (테스트용)
 *   log         console 호환
 */
function createJobMonitor(job, deps = {}) {
  const threshold = Math.max(1, job.threshold || 1);
  const remindMs = (job.remindHours == null ? 6 : job.remindHours) * 3600 * 1000;
  const now = deps.now || (() => Date.now());
  const log = deps.log || console;
  const state = { consecutive: 0, firstFailAt: null, lastError: '', alertedAt: null, alertCount: 0 };

  async function _send(text) {
    if (!deps.post) return false;
    try { await deps.post(text); return true; }
    catch (e) { log.warn(`[job-alert] ${job.label} 슬랙 알림 실패:`, e.message); return false; }
  }

  /** 실패 1회 기록. 알림을 보냈으면 true. */
  async function fail(err) {
    try {
      const t = now();
      state.consecutive++;
      if (state.consecutive === 1) state.firstFailAt = t;
      state.lastError = _oneLine(err);
      const due = state.alertedAt == null
        ? state.consecutive >= threshold
        : (remindMs > 0 && t - state.alertedAt >= remindMs);
      if (!due) return false;
      const again = state.alertedAt != null;
      const lines = [
        `${again ? ':rotating_light: *계속 실패 중*' : ':rotating_light: *자동 작업 실패*'} — *${job.label}* (${job.schedule})`,
        `• 연속 실패 ${state.consecutive}회 · ${_kstTime(state.firstFailAt)}부터`,
        `• 오류: \`${state.lastError}\``,
        job.impact ? `• 영향: ${job.impact}` : null,
        job.action ? `• 확인: ${job.action}` : null,
      ].filter(Boolean);
      const sent = await _send(lines.join('\n'));
      // 발송이 실패해도 알림 시각은 남긴다 — 매 회차 재시도로 로그가 넘치지 않게, 다음 알림은 remind 간격 뒤
      state.alertedAt = t;
      if (sent) state.alertCount++;
      return sent;
    } catch (e) {
      log.warn(`[job-alert] ${job.label} 처리 오류:`, e.message);
      return false;
    }
  }

  /** 성공 1회 기록. 알림을 보낸 적이 있으면 복구 알림. 복구 알림을 보냈으면 true. */
  async function ok(summary) {
    try {
      const wasAlerted = state.alertedAt != null;
      const failures = state.consecutive;
      const since = state.firstFailAt;
      state.consecutive = 0; state.firstFailAt = null; state.lastError = ''; state.alertedAt = null;
      if (!wasAlerted) return false;
      const text = `:white_check_mark: *복구* — *${job.label}* 정상 동작 (${_kstTime(since)}부터 ${failures}회 실패 후)`
        + (summary ? `\n• ${summary}` : '');
      return await _send(text);
    } catch (e) {
      log.warn(`[job-alert] ${job.label} 처리 오류:`, e.message);
      return false;
    }
  }

  function status() {
    return { label: job.label, consecutive: state.consecutive, alerted: state.alertedAt != null, last_error: state.lastError || null };
  }

  return { fail, ok, status };
}

module.exports = { createJobMonitor };
