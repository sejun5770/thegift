/**
 * GA4 리프레시 토큰 1회 발급 — 운영자 PC 에서 한 번만 실행한다.
 *
 * 왜 이게 필요한가:
 *   바른손 조직에 iam.disableServiceAccountKeyCreation 정책이 걸려 있어 서비스 계정 키를
 *   만들 수 없다 (2026-08-13 확인). 그래서 이미 GA 권한을 가진 사람 계정으로 한 번 동의받아
 *   리프레시 토큰을 받고, 서버는 그 토큰으로 액세스 토큰을 계속 갱신해 쓴다.
 *
 * ── 사전 준비 (Google Cloud Console) ──────────────────
 *   1. API 및 서비스 → 라이브러리 → 'Google Analytics Data API' 사용 설정
 *   2. OAuth 동의 화면 → User Type '내부(Internal)' 로 만들기
 *      ※ '외부' + '테스트' 상태면 리프레시 토큰이 7일 만에 만료된다. 반드시 내부(또는 게시됨).
 *   3. 사용자 인증 정보 → 사용자 인증 정보 만들기 → OAuth 클라이언트 ID
 *      · 애플리케이션 유형: 데스크톱 앱
 *      · 만들어진 클라이언트 ID / 보안 비밀번호를 아래 실행에 쓴다
 *
 * ── 실행 ──────────────────────────────────────────────
 *   node scripts/ga-oauth.js <CLIENT_ID> <CLIENT_SECRET>
 *
 *   브라우저가 열리면 GA 권한이 있는 계정으로 로그인·동의한다.
 *   끝나면 ga-oauth-result.txt 파일이 생기고, 거기 적힌 환경변수를 서버에 넣으면 된다.
 *
 * ⚠️ 출력된 리프레시 토큰은 비밀번호와 같다. 메신저·이슈·채팅에 붙여넣지 말고
 *    서버 환경변수에만 넣는다. 파일은 등록 후 지운다.
 */
'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';
const PORT = 8731;                       // 데스크톱 앱 loopback 리디렉션용
const REDIRECT = `http://localhost:${PORT}`;

const [, , CLIENT_ID, CLIENT_SECRET] = process.argv;
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('사용법: node scripts/ga-oauth.js <CLIENT_ID> <CLIENT_SECRET>');
  process.exit(1);
}

// CSRF 방지 — 돌아온 요청이 우리가 보낸 것인지 확인한다
const STATE = crypto.randomBytes(16).toString('hex');

const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
  client_id: CLIENT_ID,
  redirect_uri: REDIRECT,
  response_type: 'code',
  scope: SCOPE,
  access_type: 'offline',      // 리프레시 토큰을 받으려면 필수
  prompt: 'consent',           // 이미 동의한 계정도 리프레시 토큰을 다시 내주게 한다
  state: STATE,
}).toString();

const reply = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<html><body style="font-family:sans-serif;padding:40px">${body}</body></html>`);
};

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, REDIRECT);
  if (u.pathname !== '/') { res.writeHead(404); res.end(); return; }

  const err = u.searchParams.get('error');
  if (err) {
    reply(res, 400, `<h3>동의가 취소되었습니다 (${err})</h3><p>창을 닫고 다시 실행하세요.</p>`);
    server.close(); process.exit(1);
  }
  if (u.searchParams.get('state') !== STATE) {
    reply(res, 400, '<h3>state 불일치 — 요청을 버렸습니다</h3>');
    return;   // 서버는 계속 띄워 둔다 (진짜 응답이 아직 올 수 있다)
  }
  const code = u.searchParams.get('code');
  if (!code) { reply(res, 400, '<h3>code 없음</h3>'); return; }

  try {
    const tokRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT, grant_type: 'authorization_code',
      }).toString(),
    });
    const text = await tokRes.text();
    if (!tokRes.ok) throw new Error(`[${tokRes.status}] ${text.slice(0, 300)}`);
    const j = JSON.parse(text);
    if (!j.refresh_token) {
      throw new Error('리프레시 토큰이 오지 않았습니다. 계정의 기존 동의를 해제하고(myaccount.google.com/permissions) 다시 실행하세요.');
    }

    const out = [
      '# daeryepum 서버 환경변수에 넣으세요 (등록 후 이 파일은 삭제)',
      `GA_OAUTH_CLIENT_ID=${CLIENT_ID}`,
      `GA_OAUTH_CLIENT_SECRET=${CLIENT_SECRET}`,
      `GA_OAUTH_REFRESH_TOKEN=${j.refresh_token}`,
      'GA_PROPERTIES=card:265717923,etc:382404737',
      '',
    ].join('\n');
    const file = path.join(process.cwd(), 'ga-oauth-result.txt');
    fs.writeFileSync(file, out, 'utf8');

    reply(res, 200, `<h3>발급 완료</h3>
      <p><code>${file}</code> 에 저장했습니다. 그 안의 값을 서버 환경변수에 넣으세요.</p>
      <p style="color:#b45309">토큰은 비밀번호와 같습니다. 채팅·메신저에 붙여넣지 말고, 등록 후 파일을 삭제하세요.</p>`);
    console.log(`\n저장: ${file}`);
    console.log('토큰 값은 콘솔에 찍지 않았습니다 — 파일을 열어 서버 환경변수에 넣으세요.\n');
    server.close(); process.exit(0);
  } catch (e) {
    reply(res, 500, `<h3>실패</h3><pre>${String(e.message)}</pre>`);
    console.error('실패:', e.message);
    server.close(); process.exit(1);
  }
});

server.listen(PORT, () => {
  console.log('\n브라우저에서 GA 권한이 있는 계정으로 로그인·동의하세요.');
  console.log('창이 안 열리면 아래 주소를 직접 여세요:\n');
  console.log(authUrl + '\n');
  // Windows 기본 브라우저로 열기 (다른 OS 도 대비)
  const cmd = process.platform === 'win32' ? `start "" "${authUrl}"`
    : process.platform === 'darwin' ? `open "${authUrl}"` : `xdg-open "${authUrl}"`;
  exec(cmd, () => { /* 실패해도 위 주소를 직접 열면 된다 */ });
});
