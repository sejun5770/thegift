/**
 * healthproxy.js
 * docker-manager가 루트 / 경로로 헬스체크를 수행하지만,
 * Next.js basePath=/c/barungift 설정으로 인해 / 경로에 404가 반환되는 문제를 해결하는 래퍼.
 *
 * 동작:
 *   - GET /  →  즉시 200 {"status":"ok"} 반환 (docker-manager 헬스체크용)
 *   - 그 외   →  Next.js standalone 서버(내부 포트 PORT+1)로 프록시
 */

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const PROXY_PORT = parseInt(process.env.PORT || '3000');
const NEXT_PORT = PROXY_PORT + 1;

// Next.js standalone 서버를 내부 포트에서 시작
const nextEnv = {
  ...process.env,
  PORT: String(NEXT_PORT),
  HOSTNAME: '127.0.0.1',
};

const nextProcess = spawn('node', [path.join(__dirname, 'server.js')], {
  env: nextEnv,
  stdio: 'inherit',
  cwd: __dirname,
});

nextProcess.on('exit', (code) => {
  console.error(`[healthproxy] Next.js exited with code ${code}`);
  process.exit(code ?? 1);
});

process.on('SIGTERM', () => nextProcess.kill('SIGTERM'));
process.on('SIGINT', () => nextProcess.kill('SIGINT'));

// 프록시 서버
const proxy = http.createServer((req, res) => {
  // docker-manager 헬스체크: GET / 에 즉시 200 응답
  if (req.url === '/' || req.url === '') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"status":"ok"}');
    return;
  }

  // 나머지 요청은 Next.js로 프록시
  const options = {
    hostname: '127.0.0.1',
    port: NEXT_PORT,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: `localhost:${NEXT_PORT}` },
  };

  const proxyReq = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });

  proxyReq.on('error', (err) => {
    console.error('[healthproxy] proxy error:', err.message);
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    req.pipe(proxyReq, { end: true });
  } else {
    proxyReq.end();
  }
});

proxy.listen(PROXY_PORT, '0.0.0.0', () => {
  console.log(
    `[healthproxy] listening on :${PROXY_PORT}  →  Next.js on :${NEXT_PORT}`
  );
});
