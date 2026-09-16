# 바른손더기프트 답례품 주문관리 대시보드 — 프로젝트 전체 요약

> 최종 갱신: 2026-07-22 · 대상: `pricing-prototype/daeryepum/`

---

## 1. 프로젝트 개요

**바른손더기프트(BhandsGift) 답례품 주문관리 대시보드** — 결혼 답례품(수건·커피·과자 세트 등)의 주문을 여러 판매채널에서 수집해, 스티커 편집 → 인쇄 → 제본 → 포장 → 출고까지의 작업현황을 관리하고, 매출·정산·마케팅 지표를 분석하는 운영 대시보드.

- **운영 URL**: `docker-manager.barunsoncard.com/c/barungift/`
- **핵심 역할**:
  1. 다채널 주문 수집·조회 (바른손카드/바른손몰/쿠팡/네이버)
  2. 고객 정보입력(스티커 문구·출고일) 수집 및 작업현황 추적
  3. 매출·전환율·리드타임 등 대시보드 분석
  4. 작가(디자이너) 정산 및 위탁상품 정산
  5. 수집복사(출고팀 엑셀 내보내기), 알림톡 발송

---

## 2. 시스템 아키텍처

두 개의 분리된 코드베이스가 공존한다:

| 영역 | 위치 | 스택 | 용도 |
|---|---|---|---|
| **메인 앱** | `src/` | Next.js 16 (App Router) + TS + Tailwind v4 + shadcn/ui | 초기 프로토타입 (주문/스티커/박스 관리) |
| **답례품 대시보드** | `pricing-prototype/daeryepum/` | **Node.js 커스텀 HTTP 서버** (Express 아님) + 단일 HTML SPA | **실운영 대시보드 (이 문서의 주 대상)** |

답례품 대시보드는 프레임워크 없이 순수 Node.js `http` 서버(`server.js`)와 단일 `index.html`(약 18,000줄 SPA)로 구성. 프록시(docker-manager) 뒤에서 서빙되며 **60초 프록시 타임아웃**이 있음.

---

## 3. 데이터 소스

### 3.1 MSSQL `bar_shop1` (읽기전용, FirstMall 쇼핑몰 원장)
- 접속 계정: `readonly_user` (Azure SQL)
- 주요 테이블:
  - **`custom_order` / `custom_order_item`** — 바른손카드(CARD) 주문. 청첩장(A01)·답례품(D01) 등.
  - **`CUSTOM_ETC_ORDER` / `CUSTOM_ETC_ORDER_ITEM`** — 바른손몰(ETC, 제휴사 포함) 주문. `card_opt` 컬럼(옵션 라인 → 부모 참조) 보유.
  - **`S2_Card`** — 상품 마스터. `Card_Code`, `Card_Name`, `Card_Div`(카테고리), `Unit_Value`(판매단위), `Card_Seq`.
  - **`S2_UserInfo`** — 회원. 가입일=`reg_date`, 가입사이트=`REFERER_SALES_GUBUN`, 예식일=`wedd_year/month/day`(varchar), `site_div='SB'`로 통합회원 중복제거 필수.
  - **`SiteInfo`** — 사이트 코드↔이름 매핑 (`SiteCode` ↔ `SiteName`).
  - `DELIVERY_INFO` / `DELIVERY_INFO_DETAIL` — 배송지(나눔배송), `CUSTOM_ORDER_COUPON`, `COMPANY` 등.
- **Card_Div 코드**: `A01`=청첩장, `D01`=답례품, `D02`=꽃다발, `C29`=데코소품. 위탁답례품은 `Card_Code LIKE 'COM_%'`.

### 3.2 Supabase PostgreSQL (`bg_*` 테이블, PostgREST)
- 대시보드 자체 데이터: 고객 정보입력, 상품/스티커 설정, 수동주문, 알림톡 로그 등.
- 주요 테이블: `bg_order_customer_info`(스티커 선택·출고일), `bg_product_settings`(스티커/박스/자유옵션/canonical 그룹/커스텀 안내), `bg_artist_products`·`bg_artists`(작가 정산), `bg_manual_orders`, `bg_site_settings`, `bg_alimtalk_log`, `naver_orders`, `coupang_orders` 등.
- **주의**: PostgREST 기본 `max-rows=1000` → 누적 테이블 조회 시 offset 페이지네이션 필수. 2026-10-30 이후 신규 `CREATE TABLE` 마이그레이션은 명시적 GRANT 필요.

---

## 4. 파일 구조 (`pricing-prototype/daeryepum/`)

```
server.js              # 메인 Node.js HTTP 서버 (~12,600줄) — 모든 API 라우팅, MSSQL 쿼리
index.html             # 관리자 대시보드 SPA (~18,000줄)
barungift/
  api.js               # bg(/api/bg/*) API 핸들러 위임 (handleBarungiftApi)
  store.js             # Supabase(PostgREST) 데이터 레이어
  order-info.html      # 고객용 주문정보입력 페이지 (토큰 링크)
  admin-*.html         # 관리자 상품/스티커 설정
  vendor-portal.html   # 외부 거래처 포털
  workflow-store.js    # 워크플로우 상태 (제본/출고 등)
  audit-log.js, rate-limit.js, signed-url.js, admin-client.js, seed-data.js
naver/                 # 네이버 스마트스토어 연동 (sync, api, option-parser, store)
coupang/               # 쿠팡 연동 (sync, api, rfm, option-mapper, store)
```

인증: Google OAuth(barunn.net 도메인) + HMAC 서명 세션 쿠키. 관리자 RBAC(`hasRole`/`isSuperAdmin`), 고객 endpoint는 토큰/서명 기반.

---

## 5. 주요 화면 (관리자 SPA)

| 화면 | 설명 |
|---|---|
| **대시보드** | 매출·지표 분석. 카테고리 탭(답례품/데코) + **4개 하위 탭 lazy-load** (매출현황/보조지표1/보조지표2/상품별). |
| **주문조회** | 다채널 주문 목록. 주문사이트 필터. 옵션 주문은 세트(부모) 1행 + 결제금액 합산. |
| **정보입력현황** | 고객 스티커·출고일 입력 진행상태. 미입력/입력완료/작업단계별. 옵션선택 컬럼. |
| **스티커 / 상품설정 / 출고일 설정** | 상품별 스티커·박스·자유옵션·canonical 그룹·커스텀 안내·출고일 그룹 설정. |
| **작가 정산** | 청첩장 디자이너별 매출·정산. 채널(바른손카드/바른손몰)별 행 분리, 수수료율 적용. |
| **위탁 대시보드** | 위탁상품(COM_) 거래처별 정산. |
| **로켓그로스 / 예식일 캘린더 / GNB 설정** | 쿠팡 로켓그로스, 예식일 기반 분석. |
| **order-info.html (고객용)** | 고객이 토큰 링크로 스티커 문구·출고일 입력. 옵션은 프론트에서 선택했으므로 재선택 안 함. |

---

## 6. 핵심 도메인 로직

### 6.1 매출 계산
- 아이템 매출 = `item_sale_price × count / Unit_Value` (판매단위 보정). 데코소품(C29)은 unit_value 무시.
- 바른손카드(자사) vs 바른손몰(제휴사) 구분: `SiteInfo.SiteName` 실이름=자사, 숫자/NULL=제휴사.
- 쿠폰/포인트 배분: **청첩장(A01) 아이템 수 균등** (gross 비율 아님). `쿠폰 ÷ 주문 내 A01 아이템 수`. 코드베이스 전체 컨벤션(`etcAmountExpr`). ← 2026-07-16 사용자 확인.

### 6.2 작가 정산
- `bg_artist_products.product_code` ↔ `S2_Card.Card_Code` 매칭. CARD+ETC 양쪽 집계.
- 채널별(바른손카드/바른손몰) 수량·매출 행 분리 + 합계 행. 수수료율은 동일.
- 기준일(basis): 결제일(settle)/주문일(order)/출고완료일(ship) 선택. end_date는 UI inclusive.

### 6.3 옵션(세트) 처리 — 프론트 신규 옵션 기능
- 수건/주방세제 등 **비용변동 옵션**이 별도 상품 라인으로 들어옴 (ETC 전용, `card_opt`=부모 `card_seq` 참조, 부모는 `card_opt=null`).
- **부모(세트)=0원 껍데기, 옵션이 실제 금액** 보유 (예: 세트 0 + 주방세제 3,500 + 수건 3,500 = 7,000).
- 처리:
  - **order-info**: 옵션 제외, 세트에만 스티커/출고일 입력.
  - **주문조회·정보입력현황**: 옵션을 부모로 합산 → 세트 1행, 결제금액=옵션 합. 옵션선택 컬럼에 실제 옵션 표시.
  - **수집복사**: 옵션1→K(품목코드1), 옵션2→L(품목코드2), 아이템 seq 순.
  - **수동추가**: 부모 세트의 `bg_product_settings.custom_options` 설정 시 모달에서 선택 가능.

### 6.4 리드타임 / 전환율
- 리드타임: 주문일 ~ 예식일 분포, 3-way(주문/희망출고/예식).
- **청첩장→답례품 전환율**: 기간내 청첩장 구매 회원 중 답례품도 구매한 회원. 두 방식:
  - (기존) `apiMarketing.conversion` — 기간내 청첩장 ∩ 기간내 답례품 (member_id 교차).
  - (신규) `apiConversionWindow` — 답례품을 **본인 예식일 −14~+7일** 윈도우에 구매한 회원 (실제 답례품 타이밍 포착).

---

## 7. 다채널 통합

| 채널 | 소스 | 비고 |
|---|---|---|
| 바른손카드 | MSSQL `custom_order` (CARD) | 자사몰 |
| 바른손몰 | MSSQL `CUSTOM_ETC_ORDER` (ETC) | 제휴사 포함, 옵션(card_opt) 지원 |
| 쿠팡 / 로켓그로스 | `coupang/` + Supabase `coupang_orders` | RFM 분석 |
| 네이버(바른손카드/테넷텐) | `naver/` + Supabase `naver_orders` | 구매확정일(decisionDate) 연동 |
| 수동/CSV·XLSX 업로드 | `bg_manual_orders` (MANUAL) | KST 타임존 처리 |

집계 시 **row-level dedup 필수** (다중 소스 fetch 시 더블카운트 위험).

---

## 8. 배포 파이프라인

```
git commit → git push origin feat/daeryepum-dashboard
  → gh workflow run deploy.yml --ref feat/daeryepum-dashboard
  → GitHub Actions 빌드 → GHCR 이미지 push
  → Docker Manager(docker-manager.barunsoncard.com)에서 수동 재배포
```

- **주의**: workflow_dispatch는 원격 브랜치 코드로 빌드 → `git push` 먼저 필수.
- **검증**: Docker Manager 배포 이력의 커밋 해시 = 최신 커밋 확인.
- **헬스체크**: `node server.js`가 기동해야 함 → SQL 문법 오류/JS 파싱 오류 시 기동 실패. 배포 전 `node --check server.js` 권장.

---

## 9. 이번 세션(2026-07) 작업 내역

### 작가 정산
- 제휴사 청첩장 판매를 바른손몰 컬럼에 분류, 채널별 행 분리(수량+매출), end_date inclusive 처리.
- 쿠폰/포인트 배분을 **청첩장(A01) 아이템 수 균등** 기준으로 변경 (gross 비율 → 코드베이스 컨벤션 통일).
- barshop1 매출과 검증: 수량 99.7% 일치, "환산"은 다른 지표(공급가 추정)로 판정.

### 옵션(세트) 기능 통합 (ETC 전용)
- order-info 옵션 제외 → 세트만 스티커 입력.
- 주문조회·정보입력현황 세트 합산(결제금액=옵션 합) + 옵션선택 컬럼 표시.
- 주문수정 모달 옵션 sel 제외, 수집복사 K/L 옵션 매핑.

### 출고누락 이슈
- **정보입력현황 상품명 뒤섞임 버그 수정** (위치 fallback으로 sel이 엉뚱한 상품에 붙던 문제). 소급 감사 endpoint로 영향 1건(4760779) 확정.

### 대시보드
- **4개 하위 탭 + 활성 탭만 lazy-load** (경량화, apiMarketing timeout 노출 감소).
- 청첩장→답례품 전환율 **예식 윈도우(-14~+7일)** endpoint 신설.
- marketing/reorder 500(timeout) 방어 처리 (에러 메시지 200으로 노출).

### 진단/디버그 endpoint (신설)
`/api/artists/settlements/site-breakdown`, `/daily-breakdown`, `/api/debug/order-items`(+raw_items), `/scan-missing-items`, `/audit-sticker-mismatch`, `/signup-count`, `/find-columns`, `/signup-route`, `/api/dashboard/conversion-window`.

---

## 10. 알려진 이슈 / 후속 과제

- **`/api/orders` 414 URI Too Long** — 커스텀 로더가 missing IDs를 URL 파라미터로 과다 첨부 (별개 이슈).
- **`apiMarketing`/`reorder` 간헐 timeout** — 무거운 self-join. 방어 처리됨, 근본 최적화 여지.
- **보안 개선 필요** (검증 보고서 `barungift-verification-report-2026-07-16.md` 참조): DB 비밀번호 하드코딩, DEV_SKIP_AUTH fail-open, api.js 관리자 RBAC 부재, 주문조회 stored XSS 등.
- **전환율 윈도우 카드 프론트 연결** — `conversion-window` endpoint를 보조지표1 탭 전환율 카드에 연결(미완).
- **비타민 답례품 박스선택** — 세트 옵션과 동일 구조로 박스선택 컬럼 확장(요청됨).

---

## 참고 문서

- `docs/barungift-verification-report-2026-07-16.md` — 답례품 주문관리 전체 코드 검증 보고서 (Critical/High/Medium/Low).
- 메모리: `쿠폰 배분 A01 아이템 수`, `MSSQL S2_UserInfo 스키마`, `집계 더블링 위험`, `Supabase public GRANT 정책`.
