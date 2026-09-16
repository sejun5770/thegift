# OAuth2 Proxy 고객 경로 우회 설정

`docker-manager.barunsoncard.com`의 OAuth2 Proxy가 도메인 전체를 barunn.net 구글 워크스페이스로 막고 있어 외부 고객이 `/c/barungift/order-info` 에 접근할 수 없는 문제를 해결한다.

## 허용해야 할 경로

고객이 접근해야 하는 경로 (인증 없이 통과):

| 경로 | 메서드 | 용도 |
|---|---|---|
| `/c/barungift/order-info` | GET | 고객 주문정보 입력 화면 (HTML) |
| `/c/barungift/api/bg/orders/{orderId}` | GET | 특정 주문 조회 |
| `/c/barungift/api/bg/orders/{orderId}/customer-info` | POST | 고객 입력 저장 |
| `/c/barungift/api/bg/orders/search` | GET | 주문 검색 (전화번호/이름) |
| `/c/barungift/api/bg/auth/login` | POST | 바른손카드 회원 로그인 |

관리자 경로 (`/c/barungift/`, `/c/barungift/api/bg/stickers`, `/c/barungift/api/bg/products/*`, `/c/barungift/api/bg/shipping-config` 등)는 **OAuth2 Proxy 인증 유지**.

## OAuth2 Proxy 환경변수 추가

Docker Manager에서 `oauth2-proxy` 컨테이너의 환경변수에 추가:

```env
OAUTH2_PROXY_SKIP_AUTH_ROUTES=GET=^/c/barungift/order-info$,GET=^/c/barungift/api/bg/orders/[^/]+$,GET=^/c/barungift/api/bg/orders/search(\?.*)?$,POST=^/c/barungift/api/bg/orders/[^/]+/customer-info$,POST=^/c/barungift/api/bg/auth/login$
```

또는 커맨드라인 인자:

```bash
--skip-auth-route=GET=^/c/barungift/order-info$
--skip-auth-route=GET=^/c/barungift/api/bg/orders/[^/]+$
--skip-auth-route=GET=^/c/barungift/api/bg/orders/search(\\?.*)?$
--skip-auth-route=POST=^/c/barungift/api/bg/orders/[^/]+/customer-info$
--skip-auth-route=POST=^/c/barungift/api/bg/auth/login$
```

## 경로 정규식 풀이

| 정규식 | 매치 예시 |
|---|---|
| `^/c/barungift/order-info$` | `/c/barungift/order-info` (뒤에 쿼리스트링 `?oid=...` 은 정규식이 path만 검사하므로 OK) |
| `^/c/barungift/api/bg/orders/[^/]+$` | `/c/barungift/api/bg/orders/3244540`, `/c/barungift/api/bg/orders/ETC-3244540` |
| `^/c/barungift/api/bg/orders/search(\?.*)?$` | `/c/barungift/api/bg/orders/search?phone=...&name=...` |
| `^/c/barungift/api/bg/orders/[^/]+/customer-info$` | `/c/barungift/api/bg/orders/3244540/customer-info` (POST만) |
| `^/c/barungift/api/bg/auth/login$` | `/c/barungift/api/bg/auth/login` |

## 적용 후 검증

1. OAuth2 Proxy 재시작
2. 시크릿/프라이빗 브라우저(관리자 로그인 없는 상태)에서:
   ```
   https://docker-manager.barunsoncard.com/c/barungift/order-info?oid=3244540
   ```
3. OAuth2 로그인 없이 바로 고객 화면이 뜨면 성공

## 주의

- 쿼리스트링(`?oid=...`)은 정규식 path 검사에 영향 없음 → `$` 뒤에 추가 문자 매치 안 해도 OK
- 관리자 경로(`/c/barungift/api/bg/stickers`, `/c/barungift/api/bg/products/*/settings` 등)는 여전히 OAuth2 Proxy 통과 필요
- 현재 앱 내부 `server.js`도 고객 경로는 public, 관리자 경로는 세션 체크 — **이중 보안** 유지
