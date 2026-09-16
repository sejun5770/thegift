# 답례품 주문관리 전체 검증 보고서

- **검증일**: 2026-07-16
- **검증 범위**: 답례품(바른손더기프트) 주문관리 시스템 전체
  - `pricing-prototype/daeryepum/index.html` (관리자 대시보드 SPA, ~18,000줄)
  - `pricing-prototype/daeryepum/server.js` (메인 서버, ~12,600줄)
  - `pricing-prototype/daeryepum/barungift/api.js` (bg API 핸들러, ~1,760줄)
  - `pricing-prototype/daeryepum/barungift/store.js` (Supabase 데이터 레이어, ~1,560줄)
  - `pricing-prototype/daeryepum/barungift/order-info.html` (고객용 주문정보입력, ~4,100줄)
  - workflow-store.js, audit-log.js, rate-limit.js, signed-url.js, admin-client.js
- **방법**: 4개 영역 병렬 코드 리뷰 (서버 API / 고객 페이지 / 관리자 UI / 메인 서버 보안)
- **표기**: "추정" = 실환경 재현 미확인, 코드 정황상 추론

---

## 🔴 Critical — 7건

### C-1. DB 비밀번호가 소스코드에 하드코딩
- **위치**: `server.js:388-392`
- **문제**: MSSQL readonly 계정 비밀번호가 env 미설정 시 폴백 리터럴로 Git 에 커밋됨. 저장소/이미지 접근자 = DB 서버 주소+계정+비밀번호 확보 가능. 현재 readonly 라 피해는 조회 한정이나 대상 서버 호스트명까지 노출.
- **조치**: 리터럴 폴백 제거 → env 미설정 시 기동 실패 (fail-fast). **노출된 비밀번호 로테이션**. `.env` gitignore 확인.

### C-2. 환경변수 하나 빠지면 전체 인증 우회 (fail-open)
- **위치**: `server.js:18`, `api.js:690` — `DEV_SKIP_AUTH = !GOOGLE_CLIENT_ID || GOOGLE_CLIENT_ID === 'test'`
- **문제**: 운영 컨테이너에 `GOOGLE_CLIENT_ID` 가 비어 있으면 모든 관리자 API·debug·알림톡 발송이 무인증 개방.
- **조치**: `NODE_ENV !== 'production'` AND 명시적 `ALLOW_DEV_SKIP_AUTH=true` 이중 조건으로 전환. 기동 로그에 인증 모드 경고 출력.

### C-3. 주문조회 테이블 stored XSS
- **위치**: `index.html:3825` (`renderOrderTable`)
- **문제**: `display_name`(주문자명), `recv_msg`(배송메세지), `recv_address` 등 고객 입력값이 `esc()` 없이 innerHTML 삽입. 고객이 악성 스크립트 입력 → 관리자가 주문조회 탭을 여는 순간 관리자 세션에서 실행. 같은 데이터를 렌더하는 `renderBgUnified()` (14682-14685) 는 esc 처리됨 — API 가 raw 반환하는 것이 사실상 확인됨.
- **조치**: `file_count_fmt` 등 의도적 HTML 컬럼만 화이트리스트 (`html: true` 플래그), 나머지는 `esc(r[c.key])` 적용.

### C-4. 고객 로고 업로드 UI 갱신 회귀 (buildLogoAttachSection 분리 이동)
- **위치**: `order-info.html:1257-1264` (업로드 성공), `3155-3160` (삭제), `2693-2737` (분리된 섹션)
- **문제**: 로고 UI 가 `#sticker-input-wrap-{idx}` 바깥 형제 div 로 이동했는데, 업로드 성공/삭제 후엔 여전히 `sticker-input-wrap` 만 교체 → **"업로드 중..." 영구 표시, 미리보기 미표시, 삭제 버튼 무반응처럼 보임**. 내부 state 는 정상이라 제출 데이터는 맞지만 고객은 실패로 오인 → 재업로드 반복 (선삭제 로직과 결합) / 이탈.
- **조치**: 업로드 성공/삭제 후 `renderCurrentStep()` 호출로 통일하거나, logo wrapper 에 id 부여 후 함께 교체. 성공 경로에서 `$progress` 숨김 추가.

### C-5. 거래처 외부 포털 API 가 인증 게이트에 차단 — 기능 동작 불가 (추정)
- **위치**: `api.js:690-693` (게이트) vs `server.js:8281-8288` (public 핸들러), `vendor-portal.html:267` (호출측)
- **문제**: `/api/bg/vendor-portal` 은 토큰 기반 public 설계인데 api.js 의 `/api/bg/` 세션 게이트에 먼저 걸림 → 외부 거래처는 항상 401 → 포털 빈 화면. (두 검증 에이전트가 독립적으로 동일 결론)
- **조치**: api.js 게이트에 `/api/bg/vendor-portal` 화이트리스트 추가. 실배포 동작 확인 필요.

### C-6. `bg_order_collected` 1,000행 캡 — 수집완료 마크 조용히 소실
- **위치**: `store.js:663-668` (`getCollectedOrderSeqs` — 페이지네이션 없음)
- **문제**: Supabase PostgREST 기본 max-rows=1000. 누적 테이블이라 언젠가 반드시 초과 → 초과분 주문의 수집완료 마크 소실 → **중복 수집 위험**. 같은 원인으로 `store.js:404` (`getExpressCustomerInfos`) 의 `limit=10000` 도 무효 (max-rows 는 명시적 limit 도 상한 적용) → 빠른출고 매출 과소집계 가능.
- **조치**: `getAllCustomerInfos` (store.js:379) 의 offset 페이지네이션 패턴을 공용 헬퍼화해 적용. **현재 행 수 즉시 확인 권장**.

### C-7. `/api/bg/orders/shipping` 라우트 섀도잉 — 죽은 코드
- **위치**: `api.js:196-197` (주문상세 regex) vs `api.js:1108` (일괄 배송정보)
- **문제**: `/api/bg/orders/shipping` 이 주문상세 라우트 `[^/]+` 에 매칭 → `orderId='shipping'` → 항상 404. 관리자용 일괄 조회 코드 도달 불가능.
- **조치**: 고정 경로 선분기 또는 regex 를 숫자/`ETC-` 패턴으로 제한.

---

## 🟠 High — 13건

### H-1. 고객 로고 업로드/삭제 API 무방비
- **위치**: `api.js:583-659` (POST), `662-683` (DELETE)
- POST: rate limit 없음, order_id 실존 검증이 no-op (결과 미사용) → 아무나 무한 업로드 (Storage 비용/DoS, public URL 악용)
- DELETE: `path` regex 가 `.` `/` 허용 → `..` 시퀀스 통과, 주문 소유 검증 없음 → 타 주문 파일 삭제 가능
- **조치**: rlCheck + 서명 검증 추가, DELETE 는 `order_id/` prefix 강제 + `..` 명시 거부.

### H-2. 관리자 API RBAC 부재 (api.js ↔ server.js 정책 비일관)
- **위치**: api.js 전반 — 스티커 CRUD(718-760), manual-orders(977-1095), **알림톡 일괄 발송(1434)**, customer-info 수정/삭제(1234-1296) 등. `site-settings PUT` 만 isSuperAdmin 확인.
- **문제**: barunn.net 로그인만 있으면 (designer 역할 포함) 알림톡 발송(비용 발생)·주문 삭제/수정 가능. server.js 워크플로우 라우트는 hasRole 적용 — 두 파일 간 정책 격차.
- **조치**: api.js 의 상태 변경 + 알림톡 발송에 `hasRole(['admin','operator'])` 가드 추가.

### H-3. X-Forwarded-For 스푸핑으로 rate limit 무력화
- **위치**: `rate-limit.js:30-35`, `audit-log.js:20-28` — `xff.split(',')[0]` (클라이언트 임의 삽입 가능)
- **조치**: 신뢰 프록시 기준 rightmost-N 파싱 또는 프록시단에서 x-real-ip 덮어쓰기.

### H-4. 주문번호 열거로 PII 노출 (서명 STRICT 기본 off)
- **위치**: `signed-url.js:22`, `api.js:208-219`, `393-400` (배송지 전체주소), `420-428` (가상계좌)
- **문제**: order_seq 순차 정수 순회로 배송지 전체주소·가상계좌 수집 가능. rate limit 은 H-3 으로 우회됨.
- **조치**: `BG_URL_SIGN_STRICT=true` 조기 전환 (LMS URL 서명 연동 선행), 그 전까지 주소 마스킹.

### H-5. 전화번호 빈 회원 → 이름만으로 타인 주문 매칭
- **위치**: `api.js:124-136`, `1614` — phone 빈 문자열이면 `LIKE '%'` → 이름 단독 매칭 → 동명이인 주문 노출.
- **조치**: phone 없으면 memberId 매칭만 사용, 최소 8자리 미만이면 LIKE 비활성화.

### H-6. 고객 제출 서버측 검증 부재
- **위치**: `api.js:545-563`, `store.js:335-349`
- 과거/휴무일 출고일 저장 가능, `express_fee=0` 조작으로 요금 회피, `sticker_selections` 에 워크플로우 타임스탬프 위조 주입 가능, 품절 박스 제출 가능 (관리자 PUT 에는 검증 있음 — 비일관).
- **조치**: 워크플로우 필드 strip, 날짜 검증, express_fee 서버 재계산, 박스 검증 공유.

### H-7. 멀티 출고그룹 주문 결제/최종확인 화면 오표시
- **위치**: `order-info.html:2195` (renderStep2), `2318, 2439-2443` (renderStep3)
- **문제**: 멀티 그룹 모드 선택값은 `shipping_by_group` 에만 있는데 표시 로직은 `formState.shipping_type`/`desired_ship_date` 참조 → 빠른출고 선택해도 "일반출고·무료" + "미선택" 표시, expressFee +0원인데 총액은 유료 합산 → 고객 혼란/CS 유입. 제출 payload 는 정상.
- **조치**: `isMultiShippingGroups()` 분기로 그룹별 목록 렌더, fee 는 `getTotalAmount()` 기반.

### H-8. 주문 검색 실패가 "주문 없음" 으로 오표시
- **위치**: `order-info.html:3716-3719` — `resp.ok` 미체크. 429/500 → 빈 결과 화면 → 고객센터 유입.
- **조치**: `if (!resp.ok) alert(...)` 분기 (loginBarunson 은 이미 처리 — 패턴 불일치).

### H-9. order_date 타임존 규약 4갈래 분열 (추정)
- **위치**: `index.html:17443-17448` (CSV naive-KST), `17707` (fallback 진짜 UTC), `13969` (수동주문 UTC), `18187` (편집 naive)
- **문제**: 표시 함수 `fmtKstDate` (3577-3590) 는 `Z`/`+00:00` 접미사면 +9h → naive-KST 저장분이 +9h 어긋나게 표시될 수 있음. 편집→저장 반복 시 9시간씩 drift 가능.
- **조치**: 저장 규약 통일 (권장: 항상 진짜 UTC ISO + 표시에서 KST 변환). 백엔드 직렬화 형식 먼저 확인.

### H-10. stub 재생성 confirm 설계 결함 + 무한루프 가능성
- **위치**: `index.html:17906-17957` (`backfillBhgStubs`)
- confirm [확인]=강제 재생성(기존 stub 삭제), [취소]=일반 실행 — **어느 쪽이든 실행, 중단 불가**. 루프가 `offset_next` 누락 시 같은 청크 무한 반복.
- **조치**: 2단계 confirm/모달, `if (offset_next == null || offset_next <= offset) break` + 최대 청크 상한.

### H-11. 정보입력현황 productMap 더블카운트 위험 (추정, 검증 필요)
- **위치**: `index.html:14076-14080` (2개 카테고리 fetch concat), `14127` (`item_count +=` — row-level dedup 없음)
- **문제**: 백엔드가 MANUAL 주문을 daeryepum 카테고리에서도 반환하면 상품 수량 2배. (14170-14173 주석에서 개발자 스스로 2차 fetch 의 같은 문제를 인지한 이력 있음. 과거 "집계 더블링" 사례와 동일 패턴)
- **조치**: 백엔드 응답 카테고리 중복 여부 확인 → 필요 시 seen-set dedup. 주문조회의 'manual' 체크박스(1198) 죽은 UI 여부도 확인.

### H-12. customer_info 키 규약 불일치 (raw seq vs prefixed) (추정)
- **위치**: `index.html:16182, 16249` (raw `order_seq`) vs `16137, 16356` (`bgCiKey` — ETC-/CP-/NV-/MO- prefix)
- **문제**: ETC 주문 수동수집 마킹이 raw seq 로 PUT → prefix 없는 orphan CI 생성. `bgFindCi` fallback 은 ETC 만 회수.
- **조치**: CI 관련 호출 전부 `bgCiKey()` 통일 + 백엔드 키 정규화 확인.

### H-13. 세션 쿠키 Secure 가 프록시 헤더 의존
- **위치**: `server.js:6718-6720` — `x-forwarded-proto` 미설정/변조 시 Secure 누락 → HTTP 로 세션 쿠키 전송 가능 (24시간 유효).
- **조치**: 운영은 항상 Secure 강제 (env 플래그).

---

## 🟡 Medium — 주요 20건

### 데이터 정합성
| # | 위치 | 문제 |
|---|---|---|
| M-1 | `store.js:1138-1139` | manual_orders 날짜 필터 — UTC 저장 vs KST 입력, 9시간 시프트 (KST 00:00~08:59 주문이 전날 필터에 걸림) |
| M-2 | `index.html:17758-17761` | XLSX 날짜 셀이 serial number 로 파싱 → 결제일 파싱 실패 → **주문일이 업로드 시각으로 조용히 대체** (`cellDates:true` + `raw:false` 필요) |
| M-3 | `store.js:325-326` | 중복 제출 경합 → UNIQUE 위반이 ALREADY_SUBMITTED 아닌 500 으로 |
| M-4 | `store.js:830-835` | saveShippingConfig — Supabase 실패 시 로컬 파일 폴백 후 성공 반환 → 재배포 시 소실 + 고객 화면과 분기 |
| M-5 | `index.html:17441-17448` | 날짜만 있는 CSV 입력이 09:00 로 저장 (`T00:00:00` 명시 필요) |
| M-6 | `order-info.html:686-694` + `api.js:247-262` | formState.products 가 배열 인덱스 키 + 주문상세 SQL ORDER BY 없음 → 재접속 시 상품 간 문구 뒤바뀜 가능 (추정) |
| M-7 | `store.js:476` | updateCustomerInfo INSERT 경로 express_fee 미검증 (PATCH 는 있음 — 비일관) |

### XSS 잔여
| # | 위치 | 문제 |
|---|---|---|
| M-8 | `index.html:3819, 14821, 14929` 등 | onclick 속성 내 `esc()` — entity 디코딩으로 무력화 (`data-*` + dataset 패턴으로 통일 필요) |
| M-9 | `index.html:10225-10302, 10566-10568` | bg 스티커/상품 테이블 escape 누락 (관리자 입력 stored XSS) |
| M-10 | `order-info.html:2615, 2677-2688` | 관리자 notice/placeholder/field_label/options 미이스케이프 |
| M-11 | `order-info.html:2674, 2791` | `safeVal` 이 `"` 만 처리 → textarea breakout (self-XSS 수준, esc() 로 교체) |

### UX
| # | 위치 | 문제 |
|---|---|---|
| M-12 | `index.html:16346-16413` | 알림톡 발송 중 버튼 비활성화 없음 → 중복 발송 위험 |
| M-13 | `index.html:17746-17771` | CSV 파싱 예외 처리 없음 → 손상 파일 업로드 시 무반응 |
| M-14 | `order-info.html:1218-1223` | 로고 교체 시 기존 파일 선삭제 → 새 업로드 실패 시 dead link |
| M-15 | `order-info.html:2141-2161` | 안내 폴백 title "커스텀 안내" 내부용어 노출 + 띠지/라벨 상품에도 "스티커" FAQ 하드코딩 |
| M-16 | `order-info.html:4002-4007` | selectOrder 시 원래 주문의 t/sig 가 따라감 → STRICT 전환 시 주문선택 플로우 깨짐 (추정) |
| M-17 | `index.html:3679` | loadOrders AbortController 없음 → 카테고리 빠른 전환 시 race (다른 탭 데이터 표시) |

### 성능/안정성
| # | 위치 | 문제 |
|---|---|---|
| M-18 | `store.js:641-650` | setProcessedBatch N+1 — 300건 = 최대 900회 순차 왕복, 60초 타임아웃 위험 |
| M-19 | `api.js:1181-1231` | customer-infos 전량 fetch (수 MB) + GET 이 백그라운드 PATCH 유발 (안티패턴) |
| M-20 | `api.js:22-31` | parseBody 크기 무제한 — 인증 전 endpoint 메모리 소진 DoS |
| M-21 | `workflow-store.js:44-47` | withOrderLock 정리 조건이 항상 false → lock Map 영구 누수 |
| M-22 | server.js debug 라우트 전반 | `/api/debug*`, site-breakdown, daily-breakdown 에 RBAC 없음 — 로그인 사용자 누구나 PII 원시 덤프/스키마 열거 |
| M-23 | `server.js:6700-6702` | CORS `*` 전역 (Allow-Credentials 없어 당장은 낮음, 잠재 리스크) |
| M-24 | `api.js:1434-1553` | 알림톡 발송 멱등성 부재 (재시도 중복 발송), `_aborted` 센티넬로 summary.total 왜곡, HTTP fallback 이 template_name 무시 |

---

## 🟢 Low — 요약 (15건)

- `index.html:3518, 4288` — fmtKRW 중복 선언
- `index.html:4033` — 복사/엑셀에 HTML 마크업 포함 (`file_count_fmt`)
- `index.html:3801, 14658` — 대량 렌더링 페이지네이션 없음 + 행마다 `.find()` O(n²)
- `index.html:17867-17896` — bulkDeleteBhg/bulkCancelBhg 순차 fetch + 진행률 미표시
- `index.html:17761` — XLSX 숫자 셀 전화번호 leading zero 소실
- `index.html:17962` — CSV 덮어쓰기 모드 추가 confirm 없음
- `order-info.html:3245-3248` — 빠른출고 선택 시 현금영수증 자동 ON (넛지 의도 확인 필요)
- `order-info.html:1199-1271` — 업로드 in-flight 가드 없음 (연타 race)
- `order-info.html:671` — HOLIDAYS_2026 하드코딩 (2027 누락 예정)
- `order-info.html:5` — `user-scalable=no` 접근성
- `api.js:1738-1741` — 검색 실패 로그에 고객 실명·전화 평문 (도커 로그 유출 경로)
- `signed-url.js:18, rate-limit.js:16` — 시크릿 기본값 폴백 (env 누락 시 서명 위조 가능)
- `api.js:140` — 로그인 성공 감사로그에 uid 원문 (실패는 해시 — 비일관)
- `store.js:138, 173` — PostgREST 필터 인코딩 누락 (admin 전용, 실효 낮음)
- `store.js:211, 928, 1141` — 1000행 캡 잠재 지점 (현재 규모 안전, C-6 헬퍼 도입 시 함께)

---

## ✅ 잘 되어 있는 부분

- MSSQL 쿼리 전반 파라미터 바인딩 — 고객 입력 경로 SQL injection 없음
- 고객 입력 esc() 대체로 일관 (order-info 요약화면, renderBgUnified, CSV 미리보기)
- 더블 서브밋 방어 (`_navInFlight`), 낙관적 업데이트 + 실패 롤백
- signed-url timing-safe compare, 미래 timestamp 거부
- 파일 업로드 크기 이중 체크 (헤더 + 스트림 실측), path 정규화
- CSV 청크 업로드 + 청크별 실패 집계, loadBgUnified AbortController + allSettled
- uncaughtException/unhandledRejection 핸들러 (가용성 우선)

---

## 권장 조치 순서

1. **즉시**: C-1 (비밀번호 로테이션+폴백 제거), C-2 (fail-closed), C-3 (XSS esc 1줄)
2. **이번 주**: C-4 (로고 UI 회귀 — 고객 실사용 깨짐), C-5 (vendor-portal), C-6 (1000행 캡 — 행 수 확인 먼저), H-1 (로고 API)
3. **다음 배포**: H-2 (RBAC), H-7 (멀티그룹 표시), H-8 (검색 에러), H-9 (타임존 규약)
4. **점진**: Medium/Low
