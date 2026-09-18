# 바른손 답례품 주문관리 대시보드

답례품 주문 수집 → 고객 정보입력 → 스티커·인쇄·제본 → 출고·문자 안내를 운영하는 대시보드입니다.

| 위치 | 내용 |
|---|---|
| `pricing-prototype/daeryepum/` | 앱 전체 — `server.js`(서버) · `index.html`(대시보드) · 채널 모듈 `barungift/ coupang/ naver/ cafe24/ ga/` |
| `pricing-prototype/daeryepum/manual.html` | 현업 운영 매뉴얼 |
| `supabase/migrations/` | DB 변경 — 번호 순으로 Supabase SQL 편집기에서 직접 실행. 커밋된 파일은 고치지 않고 새 번호로 추가 |
| `Dockerfile` | 운영 이미지 |

## 배포

운영 배포 브랜치는 `master` 가 아니라 **`feat/daeryepum-dashboard`** 입니다.

```bash
gh workflow run deploy.yml --ref feat/daeryepum-dashboard
```

GitHub Actions 가 GHCR 에 이미지를 올리면 Docker Manager 에서 재배포합니다. 원격 브랜치로 빌드하므로 푸시가 먼저입니다.

## 로컬 실행

```bash
npm install
npm start
```

설정값은 환경변수로 넣습니다. Supabase 값이 없으면 `pricing-prototype/daeryepum/data/` 의 JSON 파일로 동작하고, `GOOGLE_CLIENT_ID` 가 없으면 로그인을 건너뛰는 개발 모드가 됩니다.
