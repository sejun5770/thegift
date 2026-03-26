# 답례품 주문 관리 시스템 — 세션 컨텍스트

> 마지막 업데이트: 2026-03-26

## 프로젝트 위치

- **앱 경로**: `/c/src/thegift/pricing-prototype/daeryepum/`
- **서버**: `server.js` (Node.js, 포트 3457)
- **프론트엔드**: `index.html` (Vanilla HTML/CSS/JS + Chart.js)
- **바른손 DB 참조**: `/c/src/xx/barunson-database-reference/`
- **접속 URL**: http://localhost:3457

## 데이터 소스

### 바른손 bar_shop1 (Azure SQL / MSSQL)
- 서버: `barun-shopdb.9925ce92729d.database.windows.net:1433`
- 인증: `readonly_user` / `barunreadonly12#`
- 읽기 전용, 모든 쿼리에 `WITH (NOLOCK)`

### 답례품 식별 기준
- `S2_Card.Card_Div = 'D01'` (답례품 카테고리)

### 주문 테이블 2개 (UNION ALL)

| 구분 | 테이블 | 주문번호 범위 |
|------|--------|-------------|
| 부가상품 단독주문 | `CUSTOM_ETC_ORDER` + `CUSTOM_ETC_ORDER_ITEM` | 3xxxxxx |
| 청첩장+답례품 주문 | `custom_order` + `custom_order_item` | 4xxxxxx |

### 결제금액 계산
- **ETC**: `card_sale_price` (총액 저장됨)
- **CARD**: `item_sale_price × item_count` (단가 × 수량 계산 필요)

### 예식일 조회 경로
- **ETC 주문**: `CUSTOM_ETC_ORDER.member_id` → `custom_order` → `custom_order_WeddInfo` (OUTER APPLY, 최근 청첩장 기준)
- **CARD 주문**: `custom_order` → `custom_order_WeddInfo` (직접 JOIN)
- ※ `CUSTOM_ETC_ORDER_WeddInfo`는 구데이터(617건)만 있어 사용 불가

### 배송 정보
- **ETC**: `recv_name`, `recv_hphone`, `recv_address + recv_address_detail`, `recv_msg`
- **CARD**: `DELIVERY_INFO.NAME`, `HPHONE`, `ADDR + ADDR_DETAIL`, `DELIVERY_MEMO`

## 구현된 기능

### 대시보드 (page: dashboard)
1. **요약 카드 4개**: 총매출, 총수량, 주문건수, 평균 리드타임
2. **어제 vs 오늘 비교**: KST(UTC+9) 기준, 3-column 레이아웃, 증감 뱃지, 시즌/요일별 피드백
3. **매출 예측 (12주)**: 청첩장 8주 lag 회귀모델
   - 회귀식: `일매출 = 23,161원 × 청첩장일주문(8주전) − 1,126,839원`
   - R²=0.223, lag=56일
   - 주차 기준: 월~일
   - 예상 매출 + 실제 매출 + 오차율 + 건수 + 수량
   - `?` 툴팁에 cross-correlation 분석 근거 표시
4. **리드타임 분포**: 평균/중앙값/표본수, 7개 구간 바 차트 (예식후(-) 포함, 빨간색)
5. **상품별 일자별 매출 차트**: Chart.js 라인 차트, 기간 선택

### 주문조회 (page: orders)
1. **기간 필터**: 시작일~종료일
2. **컬럼 선택기**: 13개 컬럼, 체크박스 (기본 7개 선택)
3. **체크박스**: 전체선택 + 행별 개별선택, 선택 건수 표시
4. **클립보드 복사**: 선택 컬럼 × 선택 행 (미선택 시 전체)
5. **엑셀 다운로드**: UTF-8 BOM TSV

### 주문조회 컬럼 (13개)
| 키 | 라벨 | 기본선택 |
|----|------|---------|
| order_seq | 주문번호 | ✅ |
| order_date_fmt | 주문일시 | |
| display_name | 주문자명 | ✅ |
| recv_hphone | 배송정보_연락처 | ✅ |
| recv_address | 배송지_주소 | ✅ |
| recv_msg | 배송메세지 | ✅ |
| card_name | 상품명 | ✅ |
| card_code | 상품코드 | |
| item_count | 상품수량 | ✅ |
| item_amount_fmt | 결제금액 | |
| wedding_date | 예식일 | |
| lead_days | 리드타임(일) | |
| order_type_label | 주문유형 | |

### 주문자명 병합 로직
- `recv_name == order_name` → 이름만 표시
- `recv_name != order_name` → `받는사람(주문자)` 예: `김개똥(홍길동)`

### 상품명 접두어 제거
- `[할인]`, `[시크릿특가]` 등 자동 제거

### 리드타임 표시
- 양수: `5일`
- 음수(예식 후 주문): `예식후 12일`

## API 엔드포인트

| Method | Path | 용도 |
|--------|------|------|
| GET | /api/orders | 주문 목록 (start_date, end_date) |
| GET | /api/dashboard/comparison | 어제 vs 오늘 비교 |
| GET | /api/dashboard/summary | 상품별 일자별 매출 집계 |
| GET | /api/dashboard/forecast | 12주 매출 예측 |
| GET | /api/dashboard/leadtime | 리드타임 분포 |

## 사내 공유
- Slack `#협업-생산-답례품` 채널에 초안 메시지 작성 완료

## 알려진 제한사항
1. API 인증 없음
2. DB 자격증명 서버 코드에 하드코딩
3. 페이지네이션/검색 미구현
4. MoM 비교 미구현
5. 예식일이 없는 고객(청첩장 미주문)은 예식일/리드타임 공란
