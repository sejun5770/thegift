/**
 * 바른기프트 API 라우트 핸들러
 */
const url = require('url');
const store = require('./store');
const { logAccess, getRecentLogs } = require('./audit-log');
const { check: rlCheck, rateLimitResponse, LIMITS: RL_LIMITS } = require('./rate-limit');
const signedUrl = require('./signed-url');

// 답례품 필터 SQL 조건 — 자체매입 (Card_Div='D01') + 위탁답례품 (Card_Code LIKE 'COM_%')
// custom_order_item + S2_Card JOIN 후 사용. c 에일리어스 사용.
// 위탁답례품은 Card_Div 가 D01 아닌 경우 다수 — 별도 prefix 매칭 추가 (2026-06-17 합의).
const DAERYEPUM_WHERE = `(c.Card_Div = 'D01' OR c.Card_Code LIKE 'COM[_]%')`;

// 알림톡 SP 권한 가용성 캐시 (process-level).
//   null = 미시도 / 미확인
//   true = SP execute 성공 사례 있음 → 우선 시도
//   false = EXECUTE permission denied 감지 → 이후 HTTP fallback 만 사용
// DBA 가 GRANT 부여한 경우 컨테이너 재시작하면 다시 null → 시도 → true 로 회복.
let _spAvailable = null;

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (e) { reject(e); }
    });
  });
}

/**
 * ERP 변형 코드 (예: 'TGJSD1001_B') → base 코드 (예: 'TGJSD1001').
 * 매칭 안 되면 null.
 */
function stripVariantSuffix(code) {
  if (!code) return null;
  const m = String(code).match(/^(.+)_[A-Za-z0-9]+$/);
  return m ? m[1] : null;
}

/**
 * 상품 설정 lookup with 변형 suffix fallback.
 *   1순위: 입력 코드 그대로 (예: 'TGJSD1001_B')
 *   2순위: '_X' 변형 suffix 제거한 base 코드 (예: 'TGJSD1001')
 *   3순위: 그 base 의 base (이중 변형 'A_B_S' → 'A_B' → 'A', 최대 3 단계)
 * admin 이 base 코드로 등록한 매핑이 모든 변형에 자동 적용되도록.
 */
async function lookupProductSettings(code) {
  if (!code) return null;
  let ps = await store.getProductSettings(code);
  if (ps) return ps;
  let cur = code;
  for (let i = 0; i < 3; i++) {
    const base = stripVariantSuffix(cur);
    if (!base || base === cur) break;
    ps = await store.getProductSettings(base);
    if (ps) return ps;
    cur = base;
  }
  return null;
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

/**
 * 바른기프트 API 핸들러 (barunson DB pool도 받음)
 * @returns {boolean} 처리 여부 (true면 다른 라우터로 넘기지 않음)
 */
async function handleBarungiftApi(pathname, req, res, query, { getPool, sql, session, isSuperAdmin }) {
  const method = req.method;

  // ============================================
  // 고객용 API (인증 불필요)
  // ============================================

  // POST /api/bg/auth/login - 바른손카드 회원 로그인
  if (pathname === '/api/bg/auth/login' && method === 'POST') {
    // Rate limit (무차별 로그인 대응)
    const rl = rlCheck(req, 'login', RL_LIMITS.login);
    if (!rl.allowed) {
      logAccess(req, 'rate_limited', null, { status_code: 429, metadata: { action: 'login', retry_after: rl.retryAfterSec } });
      return rateLimitResponse(res, rl);
    }
    try {
      const body = await parseBody(req);
      const { uid, password } = body;
      if (!uid || !password) {
        logAccess(req, 'login_fail', null, { status_code: 400, metadata: { reason: 'missing_credentials' } });
        return json(res, { error: '아이디와 비밀번호를 입력해주세요.' }, 400);
      }
      const pool = await getPool();
      // S2_UserInfo 는 통합회원 1명을 site_div(SB/SS/BM) 별 3건 저장.
      //   각 row 의 PWD 가 서로 다를 수 있음 (사용자가 일부 사이트에서만 비번 변경).
      //   → 모든 row 중 하나라도 PWDCOMPARE = 1 이면 인증 통과.
      //   site_div='SB' 우선 (메인 통합회원 정보) 으로 정렬 — 정보 일관성 위해.
      const result = await pool.request()
        .input('uid', sql.VarChar, uid)
        .input('pwd', sql.VarChar, password)
        .query(`
          SELECT TOP 1 uid, uname, hand_phone1, hand_phone2, hand_phone3
          FROM S2_UserInfo WITH (NOLOCK)
          WHERE uid = @uid
            AND USE_YORN = 'Y'
            AND PWDCOMPARE(@pwd, CONVERT(varbinary(200), PWD, 1)) = 1
          ORDER BY CASE WHEN site_div = 'SB' THEN 0 ELSE 1 END
        `);

      if (!result.recordset.length) {
        // 실패: 아이디 해시만 기록 (원문 비번/아이디 저장 금지)
        logAccess(req, 'login_fail', null, {
          status_code: 401,
          metadata: { uid_len: String(uid).length, reason: 'invalid_credentials' },
        });
        return json(res, { error: '아이디 또는 비밀번호가 올바르지 않습니다.' }, 401);
      }

      const user = result.recordset[0];
      // hand_phone 1/2/3 은 CHAR 패딩 공백 가능성 있음 → 비숫자 모두 제거
      const phoneRaw = (user.hand_phone1 || '') + (user.hand_phone2 || '') + (user.hand_phone3 || '');
      const phone = phoneRaw.replace(/\D/g, '');

      // 로그인 성공 → 해당 회원의 답례품/꽃다발 주문 조회 (CARD + ETC 통합)
      //   uid 추가 전달 — member_id 직접 매칭이 phone/name 보다 정확.
      //   (회원 정보 변경 / 비회원 → 회원 전환 / 가족 대신 주문 등 케이스 대응)
      const orders = await searchDaeryepumOrders(pool, sql, {
        phone: phone.slice(-8),
        phoneFull: phone,
        uname: user.uname,
        memberId: uid,
        useLike: true,
      });

      logAccess(req, 'login_success', null, {
        status_code: 200,
        metadata: { uid, phone_last4: phone.slice(-4), orders_found: orders.length },
      });

      return json(res, {
        success: true,
        user: { uid: user.uid, name: user.uname, phone_last4: phone.slice(-4) },
        orders,
      });
    } catch (err) {
      console.error('barungift auth error:', err.message);
      logAccess(req, 'login_fail', null, { status_code: 500, metadata: { reason: 'server_error', error: err.message } });
      return json(res, { error: '로그인 처리 중 오류가 발생했습니다.' }, 500);
    }
  }

  // GET /api/bg/orders/search?phone=xxx&name=xxx - 고객 주문 검색 (AND 조건)
  if (pathname === '/api/bg/orders/search' && method === 'GET') {
    // Rate limit (이름+전화 열거 공격 대응)
    const rl = rlCheck(req, 'search', RL_LIMITS.search);
    if (!rl.allowed) {
      logAccess(req, 'rate_limited', null, { status_code: 429, metadata: { action: 'search', retry_after: rl.retryAfterSec } });
      return rateLimitResponse(res, rl);
    }
    const phone = (query.phone || '').replace(/\D/g, '');
    const name = (query.name || '').trim();
    if (!phone || !name) {
      logAccess(req, 'search', null, { status_code: 400, metadata: { reason: 'missing_input' } });
      return json(res, { error: '전화번호와 주문자명을 모두 입력해주세요.' }, 400);
    }
    try {
      const pool = await getPool();
      const orders = await searchDaeryepumOrders(pool, sql, {
        phone,
        phoneFull: phone,
        uname: name,
        useLike: false,
        maskCustomerName: true,
      });

      logAccess(req, 'search', null, {
        status_code: 200,
        metadata: {
          phone_last4: phone.slice(-4),
          name_len: name.length,
          orders_found: orders.length,
        },
      });

      return json(res, { orders });
    } catch (err) {
      console.error('barungift order search error:', err.message);
      return json(res, { error: '검색 중 오류가 발생했습니다.' }, 500);
    }
  }

  // GET /api/bg/orders/:orderId - 주문 상세 (고객용)
  const orderDetailMatch = pathname.match(/^\/api\/bg\/orders\/([^/]+)$/);
  if (orderDetailMatch && method === 'GET') {
    const orderId = decodeURIComponent(orderDetailMatch[1]);
    // Rate limit (한 IP가 여러 주문ID 열거하는 경우 차단)
    const rl = rlCheck(req, 'view', RL_LIMITS.view);
    if (!rl.allowed) {
      logAccess(req, 'rate_limited', orderId, { status_code: 429, metadata: { action: 'view', retry_after: rl.retryAfterSec } });
      return rateLimitResponse(res, rl);
    }
    // HMAC 서명 검증 (Phase 3)
    //  - STRICT 모드: 서명 누락/무효 시 403 (관리자가 발급한 링크만 접근 허용)
    //  - 비-STRICT 모드(기본): 기존 LMS bare URL 호환 — 검증 결과를 감사로그에만 기록
    if (query.t || query.sig || signedUrl.STRICT) {
      const sigCheck = signedUrl.verify(orderId, query.t, query.sig);
      if (!sigCheck.valid) {
        logAccess(req, 'invalid_signature', orderId, {
          status_code: signedUrl.STRICT ? 403 : 200,
          metadata: { reason: sigCheck.reason, strict: signedUrl.STRICT, has_t: !!query.t, has_sig: !!query.sig },
        });
        if (signedUrl.STRICT) {
          return json(res, { error: '유효한 접근 링크가 아닙니다. 발송된 링크로 다시 접속해주세요.' }, 403);
        }
        // 비-STRICT 모드는 통과시킴 (운영 도입 전 모니터링 단계)
      }
    }
    try {
      const pool = await getPool();
      // ETC-{seq} 형식이면 바른손몰 ETC 주문, 그 외는 custom_order
      const isEtc = orderId.startsWith('ETC-');
      const seq = parseInt(isEtc ? orderId.slice(4) : orderId) || 0;

      let result;
      if (isEtc) {
        // 바른손몰 ETC 주문 — ETC는 settle_status 컬럼이 없어 settle_date 유무로 결제 판단
        result = await pool.request()
          .input('orderSeq', sql.Int, seq)
          .query(`
            SELECT
              co.order_seq, co.order_date, co.settle_price AS order_total_price, co.settle_price AS last_total_price,
              co.order_name, co.order_hphone, co.status_seq, co.settle_date,
              ei.seq AS item_id, ei.order_count AS item_count, ei.card_price AS item_price, ei.card_sale_price AS item_sale_price,
              ei.card_opt AS card_opt, -- 옵션 라인(비용변동 옵션): 부모 아이템 card_seq 참조. NULL=부모(세트/메인)
              c.Card_Code, c.Card_Name, c.Card_Price,
              co.recv_name AS delivery_name, co.recv_hphone AS delivery_hphone, co.recv_address AS delivery_addr
            FROM CUSTOM_ETC_ORDER co WITH (NOLOCK)
            INNER JOIN CUSTOM_ETC_ORDER_ITEM ei WITH (NOLOCK) ON co.order_seq = ei.order_seq
            INNER JOIN S2_Card c WITH (NOLOCK) ON ei.card_seq = c.Card_Seq
            WHERE co.order_seq = @orderSeq
              AND ${DAERYEPUM_WHERE}
          `);
      } else {
        // 바른손카드 주문 — settle_status 컬럼으로 결제 상태 판단 (2=완료, 1=대기, 0=전, 3·5=취소)
        result = await pool.request()
          .input('orderSeq', sql.Int, seq)
          .query(`
            SELECT
              co.order_seq, co.order_date, co.order_total_price, co.last_total_price,
              co.order_name, co.order_hphone, co.status_seq, co.settle_status, co.settle_date,
              coi.id AS item_id, coi.item_count, coi.item_price, coi.item_sale_price,
              c.Card_Code, c.Card_Name, c.Card_Price,
              di.NAME AS delivery_name, di.HPHONE AS delivery_hphone, di.ADDR AS delivery_addr
            FROM custom_order co WITH (NOLOCK)
            INNER JOIN custom_order_item coi WITH (NOLOCK) ON coi.order_seq = co.order_seq
            INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
            LEFT JOIN DELIVERY_INFO di WITH (NOLOCK) ON co.order_seq = di.ORDER_SEQ
            WHERE co.order_seq = @orderSeq
              AND ${DAERYEPUM_WHERE}
          `);
      }

      if (!result.recordset.length) {
        logAccess(req, 'not_found', orderId, { status_code: 404 });
        return json(res, { error: '주문을 찾을 수 없습니다.' }, 404);
      }

      const row = result.recordset[0];
      const existingInfo = await store.getCustomerInfo(orderId);

      // 상품코드로 product_settings 조회 (변형 코드 fallback 적용)
      const productSettings = row.Card_Code ? await lookupProductSettings(row.Card_Code) : null;
      const allActiveStickers = await store.getAllStickers(true);

      // 아이템 수집 (DELIVERY_INFO JOIN으로 인한 중복 제거: item_id 기준)
      const seenItems = new Set();
      const products = [];
      for (const r of result.recordset) {
        // 옵션 라인(card_opt≠null: 비용변동 옵션, 예 주방세제/수건) 은 프론트에서 이미 선택됨 →
        //   order-info 에선 스티커/출고일 대상에서 제외. 부모(세트/메인, card_opt=null) 만 노출.
        //   card_opt 은 ETC 전용 컬럼 (CARD 주문은 SELECT 에 없어 undefined → 제외 안 됨, 정상).
        if (r.card_opt != null) continue;
        const itemId = String(r.item_id || r.order_seq);
        if (seenItems.has(itemId)) continue;
        seenItems.add(itemId);
        products.push({
          id: itemId,
          product_id: null,
          product_name: r.Card_Name || '답례품',
          product_code: r.Card_Code || null,
          quantity: r.item_count || 1,
          item_price: r.item_sale_price || r.Card_Price || 0,
        });
      }

      // 상품별 스티커 / 박스옵션 / 자유옵션그룹 / 장식명칭 / 출고일그룹 매핑 + 합집합 계산
      // stickersByProduct: { product_code: [sticker, ...] } — 고객 화면에서 상품별 필터링에 사용
      // boxOptionsByProduct: { product_code: [{code,name,color,preview_image_url}, ...] } — 박스 패키지 선택용
      // customOptionsByProduct: { product_code: { groupName: {use_images, options:[...]} } } — 자유 옵션 그룹 (수건 색상 등)
      // decorationLabelByProduct: { product_code: string } — 고객 화면 장식 명칭 (스티커/띠지/라벨…), 미설정시 '스티커'
      // shippingGroupByProduct: { product_code: shipping_group_id|null } — 상품별 출고일 그룹 (멀티 그룹 주문 지원)
      //
      // 매핑 lookup 은 모듈 상단 lookupProductSettings 사용 (ERP 변형 코드 fallback 자동 적용).
      const allMappedStickerIds = new Set();
      const stickersByProduct = {};
      const boxOptionsByProduct = {};
      const customOptionsByProduct = {};
      const decorationLabelByProduct = {};
      const shippingGroupByProduct = {};
      const allowLogoUploadByProduct = {}; // migration 026 — 로고 첨부 허용 게이트
      const customGuideByProduct = {};     // migration 034 — 관리자 자유 안내 텍스트
      const customGuideTitleByProduct = {}; // migration 035 — 안내 박스 타이틀
      const stickerById = new Map(allActiveStickers.map(s => [s.id, s]));
      for (const p of products) {
        if (!p.product_code) continue;
        const ps = await lookupProductSettings(p.product_code);
        const ids = ps?.available_sticker_ids || [];
        ids.forEach(id => allMappedStickerIds.add(id));
        stickersByProduct[p.product_code] = ids
          .map(id => stickerById.get(id))
          .filter(Boolean);
        // 박스 옵션 매핑 (없거나 비어있으면 빈 배열)
        const boxOpts = Array.isArray(ps?.available_box_options) ? ps.available_box_options : [];
        boxOptionsByProduct[p.product_code] = boxOpts;
        // 장식 명칭 (decoration_label) — admin 이 자유 입력. 빈 문자열은 fallback 적용 위해 null 처리.
        const decoLabel = (ps?.decoration_label || '').trim();
        decorationLabelByProduct[p.product_code] = decoLabel || null;
        // 출고일 그룹 — 상품별로 다를 수 있음 (null = 기본 그룹)
        shippingGroupByProduct[p.product_code] = ps?.shipping_group_id || null;
        // 로고 첨부 허용 (migration 026) — admin 이 명시적으로 켠 상품만 고객 화면에 옵션 노출
        allowLogoUploadByProduct[p.product_code] = !!ps?.allow_logo_upload;
        // 커스텀 안내 텍스트 (migration 034) — 관리자 입력. 빈 문자열은 null 로 정규화.
        const guideText = (ps?.custom_guide_text || '').trim();
        customGuideByProduct[p.product_code] = guideText || null;
        // 커스텀 안내 타이틀 (migration 035) — 관리자 입력. 빈 문자열은 null.
        const guideTitle = (ps?.custom_guide_title || '').trim();
        customGuideTitleByProduct[p.product_code] = guideTitle || null;
        // 자유 옵션 그룹 매핑 — legacy array 형식 (값이 array) 도 호환
        //   normalize: { groupName: {use_images:bool, options:[...]} } 형태로 통일
        const rawCustom = (ps?.custom_options && typeof ps.custom_options === 'object' && !Array.isArray(ps.custom_options))
          ? ps.custom_options : {};
        const normalizedCustom = {};
        for (const [gName, val] of Object.entries(rawCustom)) {
          if (Array.isArray(val)) {
            // legacy
            normalizedCustom[gName] = { use_images: true, options: val };
          } else if (val && typeof val === 'object') {
            normalizedCustom[gName] = {
              use_images: val.use_images !== false,
              options: Array.isArray(val.options) ? val.options : [],
            };
          }
        }
        customOptionsByProduct[p.product_code] = normalizedCustom;
      }
      const availableStickers = allMappedStickerIds.size > 0
        ? allActiveStickers.filter(s => allMappedStickerIds.has(s.id))
        : allActiveStickers;

      // payment_status 계산 — status_seq는 주문 처리 단계이고, 결제 상태는 별도 필드
      //   CARD: settle_status === 2 면 결제완료, === 1 이면 결제대기
      //   ETC : settle_status 컬럼이 없어 settle_date IS NOT NULL 기준
      let paymentStatus;
      if (isEtc) {
        paymentStatus = row.settle_date ? 'paid' : 'pending';
      } else {
        if (row.settle_status === 2) paymentStatus = 'paid';
        else if (row.settle_status === 1) paymentStatus = 'pending';
        else if (row.settle_status === 3 || row.settle_status === 5) paymentStatus = 'cancelled';
        else paymentStatus = 'unknown'; // 0 또는 알 수 없는 값 (대개 결제 전 임시 주문)
      }

      // 나눔배송 — 답례품을 여러 배송지로 나눠 보내는 케이스 (CARD 주문만 가능, ETC 는 단일).
      //   배송지별 답례품 수량을 클라이언트에서 안내문구로 노출 (입력은 주문 단위 1번 그대로).
      let deliveries = [];
      if (!isEtc) {
        try {
          const delRes = await pool.request()
            .input('seq', sql.Int, seq)
            .query(`
              SELECT
                di.DELIVERY_SEQ AS delivery_seq,
                di.NAME AS recv_name,
                CONCAT(ISNULL(di.ADDR,''), ' ', ISNULL(di.ADDR_DETAIL,'')) AS recv_addr,
                ISNULL((
                  SELECT TOP 1 dd.item_count
                  FROM DELIVERY_INFO_DETAIL dd WITH (NOLOCK)
                  WHERE dd.delivery_id = di.ID AND dd.item_title = N'답례품' AND dd.item_count > 0
                ), 0) AS qty
              FROM DELIVERY_INFO di WITH (NOLOCK)
              WHERE di.ORDER_SEQ = @seq
              ORDER BY di.DELIVERY_SEQ
            `);
            // qty 가 0 인 배송지(답례품 미포함)는 제외 — 실제 답례품 받는 배송지만 노출
            deliveries = delRes.recordset
              .filter(d => (d.qty || 0) > 0)
              .map(d => ({
                seq: d.delivery_seq,
                recv_name: maskName(d.recv_name || ''),
                recv_addr: d.recv_addr || '',
                qty: d.qty || 0,
              }));
        } catch (e) {
          console.warn('[orders/:id] deliveries 조회 실패:', e.message);
        }
      }

      // 결제대기 상태일 때만 toss_vaccount 조회
      // toss_vaccount.order_type: 'C'=CARD, 'E'=ETC
      let virtualAccount = null;
      if (paymentStatus === 'pending') {
        try {
          const vaRes = await pool.request()
            .input('seq', sql.Int, seq)
            .input('otype', sql.Char(1), isEtc ? 'E' : 'C')
            .query(`
              SELECT TOP 1 bank_name, vacct_number, vacct_name, settle_price, due_date, status
              FROM toss_vaccount WITH (NOLOCK)
              WHERE order_seq = @seq AND order_type = @otype
              ORDER BY vacct_seq DESC
            `);
          if (vaRes.recordset.length) {
            const va = vaRes.recordset[0];
            virtualAccount = {
              bank_name: va.bank_name,
              account_number: va.vacct_number,
              account_holder: va.vacct_name,
              amount: va.settle_price,
              due_date: va.due_date,
            };
          }
        } catch (e) {
          console.warn('[orders/:id] toss_vaccount 조회 실패:', e.message);
        }
      }

      // 접근 로그: 주문 조회 성공
      logAccess(req, 'view', orderId, {
        status_code: 200,
        metadata: {
          payment_status: paymentStatus,
          info_status: existingInfo?.submitted_at ? 'completed' : 'pending',
          order_type: isEtc ? 'ETC' : 'CARD',
        },
      });

      return json(res, {
        order_id: orderId, // 원래 들어온 ID (ETC-prefix 유지)
        order_number: isEtc ? `BHS-${row.order_seq}` : `BRS-${row.order_seq}`,
        customer_name: maskName(row.order_name || row.delivery_name || ''),
        order_date: row.order_date,
        total_amount: row.last_total_price || row.order_total_price || 0,
        status_seq: row.status_seq,
        status: row.status_seq >= 1 ? 'collected' : 'cancelled',
        payment_status: paymentStatus, // 'paid' | 'pending' | 'cancelled' | 'unknown'
        info_status: existingInfo?.submitted_at ? 'completed' : 'pending',
        products,
        product_settings: productSettings,
        // 첫번째 상품의 shipping_group_id 기반으로 출고일 config 결정.
        // 단일 그룹 주문은 기존 동작 그대로 — backward compat.
        shipping_config: await store.getShippingConfig(productSettings?.shipping_group_id || null),
        // 멀티 그룹 주문 지원 — 이 주문에 사용된 unique 출고 그룹별 config 모두 응답.
        //   shipping_groups_used: [{ group_id, group_name, is_default, config, product_codes: [...] }]
        //   group_id 가 null = '기본 그룹' (운영자 default 그룹). product 별 매핑은 shipping_group_by_product 사용.
        shipping_groups_used: await (async () => {
          const uniqueGroupIds = [...new Set(Object.values(shippingGroupByProduct))];
          const groups = await store.getShippingGroups().catch(() => []);
          const groupMetaById = new Map(groups.map(g => [g.id, g]));
          const defaultMeta = groups.find(g => g.is_default) || null;
          const result = [];
          for (const gid of uniqueGroupIds) {
            const meta = gid ? groupMetaById.get(gid) : defaultMeta;
            const cfg = await store.getShippingConfig(gid);
            // group_id=null 은 '_activeCalGroupId == null' 분기와 충돌하므로 안정 키 '__default__' 부여.
            //   캘린더 클릭 / 검증 모두 같은 키로 매칭 보장.
            result.push({
              group_id: gid || '__default__',
              group_name: meta?.name || '기본 그룹',
              is_default: !!meta?.is_default || gid == null,
              config: cfg,
              product_codes: Object.keys(shippingGroupByProduct).filter(pc => shippingGroupByProduct[pc] === gid),
            });
          }
          return result;
        })(),
        // group_id=null 의 상품도 '__default__' 로 정규화 — 멀티 그룹 모드에서 일관 키.
        shipping_group_by_product: Object.fromEntries(
          Object.entries(shippingGroupByProduct).map(([pc, gid]) => [pc, gid || '__default__'])
        ),
        available_stickers: availableStickers,
        stickers_by_product: stickersByProduct,
        box_options_by_product: boxOptionsByProduct, // { product_code: [{code,name,color,preview_image_url}] }
        custom_options_by_product: customOptionsByProduct, // { product_code: { groupName: {use_images, options:[...]} } }
        decoration_label_by_product: decorationLabelByProduct, // { product_code: '스티커' | '띠지' | ... | null }
        allow_logo_upload_by_product: allowLogoUploadByProduct, // { product_code: bool } — migration 026
        custom_guide_by_product: customGuideByProduct,          // { product_code: string|null } — migration 034
        custom_guide_title_by_product: customGuideTitleByProduct, // { product_code: string|null } — migration 035
        // 사이트 공통 안내 (migration 036) — 상품별 커스텀 없을 때 폴백.
        //   실패해도 order-info 는 기본 FAQ 로 fallback → try/catch 안전.
        site_guide: await (async () => {
          try {
            const s = await store.getSiteSettings();
            return {
              title: s?.custom_guide_title || null,
              text: s?.custom_guide_text || null,
            };
          } catch (e) { return { title: null, text: null }; }
        })(),
        existing_info: existingInfo,
        deliveries,  // 배송지별 답례품 수량 (나눔배송 안내용, 입력엔 영향 없음)
        virtual_account: virtualAccount,  // 주문 결제용 가상계좌 (결제대기 상태일 때만)
        bank_info: {                       // 오늘출발 추가비용용 고정 계좌 (항상)
          bank_name: '신한은행',
          account_number: '100-013-801261',
          account_holder: '바른컴퍼니',
        },
      });
    } catch (err) {
      console.error('barungift order detail error:', err.message);
      return json(res, { error: '서버 오류가 발생했습니다.' }, 500);
    }
  }

  // POST /api/bg/orders/:orderId/customer-info - 고객 입력 저장
  const customerInfoMatch = pathname.match(/^\/api\/bg\/orders\/([^/]+)\/customer-info$/);
  if (customerInfoMatch && method === 'POST') {
    const orderId = decodeURIComponent(customerInfoMatch[1]);
    // Rate limit (제출은 본래 1회성이므로 보수적)
    const rl = rlCheck(req, 'submit', RL_LIMITS.submit);
    if (!rl.allowed) {
      logAccess(req, 'rate_limited', orderId, { status_code: 429, metadata: { action: 'submit', retry_after: rl.retryAfterSec } });
      return rateLimitResponse(res, rl);
    }
    // HMAC 서명 검증 — view 엔드포인트와 동일 정책 (STRICT 모드에서만 차단)
    if (query.t || query.sig || signedUrl.STRICT) {
      const sigCheck = signedUrl.verify(orderId, query.t, query.sig);
      if (!sigCheck.valid) {
        logAccess(req, 'invalid_signature', orderId, {
          status_code: signedUrl.STRICT ? 403 : 200,
          metadata: { reason: sigCheck.reason, strict: signedUrl.STRICT, endpoint: 'submit' },
        });
        if (signedUrl.STRICT) {
          return json(res, { error: '유효한 접근 링크가 아닙니다. 발송된 링크로 다시 접속해주세요.' }, 403);
        }
      }
    }
    try {
      const body = await parseBody(req);

      // 유효성 기본 체크
      if (!body.desired_ship_date) {
        logAccess(req, 'submit', orderId, { status_code: 400, metadata: { reason: 'missing_desired_ship_date' } });
        return json(res, { error: '희망출고일을 선택해주세요.' }, 400);
      }

      const saved = await store.saveCustomerInfo(orderId, body);
      logAccess(req, 'submit', orderId, {
        status_code: 201,
        metadata: {
          is_express: !!body.is_express,
          sticker_count: (body.sticker_selections || []).length,
          has_customer_request: !!body.customer_request,
        },
      });
      return json(res, saved, 201);
    } catch (err) {
      if (err.message === 'ALREADY_SUBMITTED') {
        logAccess(req, 'submit', orderId, { status_code: 409, metadata: { reason: 'already_submitted' } });
        return json(res, { error: '이미 정보 입력이 완료된 주문입니다.' }, 409);
      }
      console.error('barungift customer-info error:', err.message);
      logAccess(req, 'submit', orderId, { status_code: 500, metadata: { reason: 'server_error', error: err.message } });
      return json(res, { error: '서버 오류가 발생했습니다.' }, 500);
    }
  }

  // ============================================
  // 고객 로고 첨부 (Phase B, migration 026) — 인증 게이트 앞에 배치
  //   고객용 endpoint 라서 admin session 검증 X. customer-info submit 과 동일 정책.
  //   Supabase Storage 버킷 'bg-customer-logos' 에 직접 업로드 → public URL 반환.
  // ============================================
  // POST /api/bg/sticker-logo/upload?order_id=X&product_code=Y&group_id=Z
  //   Headers: Content-Type: image/png|image/jpeg, X-Filename: <원본파일명>
  //   Body: raw bytes (≤5MB)
  if (pathname === '/api/bg/sticker-logo/upload' && method === 'POST') {
    const orderId = (query.order_id || '').trim();
    const productCode = (query.product_code || '').trim();
    const groupId = (query.group_id || '').trim() || 'default';
    if (!orderId || !productCode) {
      return json(res, { error: 'order_id, product_code 필수' }, 400);
    }
    const mime = (req.headers['content-type'] || '').toLowerCase();
    const ALLOWED = ['image/png', 'image/jpeg'];
    if (!ALLOWED.includes(mime)) {
      return json(res, { error: '허용 형식: PNG / JPG 만 지원' }, 415);
    }
    const MAX_BYTES = 5 * 1024 * 1024;
    const declaredLen = parseInt(req.headers['content-length'] || '0', 10);
    if (declaredLen && declaredLen > MAX_BYTES) {
      return json(res, { error: '최대 5MB 까지 업로드 가능' }, 413);
    }
    // 보안: order_id 존재 확인 (best-effort) — CI 없어도 첫 입력 중일 수 있어 차단 X
    try { await store.getCustomerInfo(orderId); } catch (_) {}

    // raw bytes 수집 (스트림 중 size cap 적용)
    const chunks = [];
    let total = 0;
    const aborted = await new Promise((resolve) => {
      req.on('data', (c) => {
        total += c.length;
        if (total > MAX_BYTES) { req.destroy(); return resolve(true); }
        chunks.push(c);
      });
      req.on('end', () => resolve(false));
      req.on('error', () => resolve(true));
    });
    if (aborted) return json(res, { error: '최대 5MB 까지 업로드 가능' }, 413);
    const buf = Buffer.concat(chunks);

    const SUPABASE_URL = process.env.SUPABASE_URL || '';
    const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || '';
    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return json(res, { error: 'Storage 미설정 — 운영자에게 문의' }, 503);
    }
    const BUCKET = 'bg-customer-logos';
    const ext = mime === 'image/png' ? 'png' : 'jpg';
    const ts = Date.now();
    const safeProduct = productCode.replace(/[^A-Za-z0-9_-]/g, '');
    const safeGroup = groupId.replace(/[^A-Za-z0-9_-]/g, '');
    const safeOrder = orderId.replace(/[^A-Za-z0-9_.-]/g, '');
    const objectPath = `${safeOrder}/${safeProduct}_${safeGroup}_${ts}.${ext}`;
    const uploadUrl = `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${objectPath}`;
    try {
      const r = await fetch(uploadUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${SUPABASE_KEY}`,
          apikey: SUPABASE_KEY,
          'Content-Type': mime,
          'x-upsert': 'true',
        },
        body: buf,
      });
      if (!r.ok) {
        const t = await r.text();
        console.error('[sticker-logo upload] Storage 실패:', r.status, t);
        return json(res, { error: 'Storage 업로드 실패: ' + r.status }, 502);
      }
    } catch (err) {
      console.error('[sticker-logo upload] fetch error:', err.message);
      return json(res, { error: '네트워크 실패: ' + err.message }, 502);
    }
    const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${objectPath}`;
    const filename = (req.headers['x-filename'] || `logo.${ext}`).toString().slice(0, 120);
    return json(res, {
      logo_url: publicUrl,
      logo_filename: filename,
      logo_size: buf.length,
      logo_mime: mime,
    });
  }

  // DELETE /api/bg/sticker-logo/upload?path=<objectPath> — Storage 이전 파일 정리
  if (pathname === '/api/bg/sticker-logo/upload' && method === 'DELETE') {
    const objectPath = (query.path || '').trim();
    if (!objectPath || !/^[A-Za-z0-9_.\-\/]+$/.test(objectPath)) {
      return json(res, { error: 'path 필수 (안전한 경로만)' }, 400);
    }
    const SUPABASE_URL = process.env.SUPABASE_URL || '';
    const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || '';
    if (!SUPABASE_URL || !SUPABASE_KEY) return json(res, { error: 'Storage 미설정' }, 503);
    const BUCKET = 'bg-customer-logos';
    try {
      const r = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${objectPath}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${SUPABASE_KEY}`, apikey: SUPABASE_KEY },
      });
      if (!r.ok && r.status !== 404) {
        return json(res, { error: 'Storage 삭제 실패: ' + r.status }, 502);
      }
    } catch (err) {
      return json(res, { error: '네트워크 실패: ' + err.message }, 502);
    }
    return json(res, { ok: true });
  }

  // ============================================
  // 관리자용 API (인증 필요 - session 체크)
  // ============================================

  // 관리자 API는 인증 필요 (개발모드에서는 우회)
  const DEV_SKIP_AUTH = !process.env.GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID === 'test';
  if (pathname.startsWith('/api/bg/') && !session && !DEV_SKIP_AUTH) {
    return json(res, { error: '인증이 필요합니다.' }, 401);
  }

  // GET /api/bg/debug/schema?table=custom_order - 테이블 컬럼 목록 조회 (개발용, admin 전용)
  //   H3 fix: 이전엔 인증 게이트 앞에 있어 익명 접근 가능 (DB schema enumerate 가능) →
  //   admin 게이트 뒤로 이동. 어떤 frontend 에서도 호출하지 않는 순수 디버그 라우트.
  if (pathname === '/api/bg/debug/schema' && method === 'GET') {
    const tableName = query.table || 'custom_order';
    // L6: admin 감사 로그 — 누가 어떤 테이블 schema 를 조회했는지 추적
    logAccess(req, 'debug_schema', null, { metadata: { table: tableName } });
    try {
      const pool = await getPool();
      const result = await pool.request()
        .query(`
          SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
          FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_NAME = '${tableName.replace(/'/g, '')}'
          ORDER BY ORDINAL_POSITION
        `);
      return json(res, { table: tableName, columns: result.recordset });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  }

  // GET /api/bg/stickers - 스티커 목록
  if (pathname === '/api/bg/stickers' && method === 'GET') {
    const activeOnly = query.active_only === 'true';
    return json(res, { stickers: await store.getAllStickers(activeOnly) });
  }

  // POST /api/bg/stickers - 스티커 생성
  if (pathname === '/api/bg/stickers' && method === 'POST') {
    try {
      const body = await parseBody(req);
      if (!body.name) return json(res, { error: '스티커명을 입력해주세요.' }, 400);
      const sticker = await store.createSticker(body);
      return json(res, sticker, 201);
    } catch (err) {
      console.error('[bg/stickers POST]', err.message, err.stack);
      // Supabase 에러 메시지 그대로 노출 — 운영자가 즉시 진단 가능 (PGRST204 컬럼 없음 / 23505 unique 등).
      return json(res, { error: '스티커 생성 실패: ' + err.message }, 500);
    }
  }

  // PUT /api/bg/stickers/:id - 스티커 수정
  const stickerUpdateMatch = pathname.match(/^\/api\/bg\/stickers\/([^/]+)$/);
  if (stickerUpdateMatch && method === 'PUT') {
    try {
      const body = await parseBody(req);
      const sticker = await store.updateSticker(stickerUpdateMatch[1], body);
      if (!sticker) return json(res, { error: '스티커를 찾을 수 없습니다.' }, 404);
      return json(res, sticker);
    } catch (err) {
      console.error('[bg/stickers PUT]', err.message, err.stack);
      return json(res, { error: '스티커 수정 실패: ' + err.message }, 500);
    }
  }

  // DELETE /api/bg/stickers/:id - 스티커 삭제
  if (stickerUpdateMatch && method === 'DELETE') {
    try {
      await store.deleteSticker(stickerUpdateMatch[1]);
      return json(res, { success: true });
    } catch (err) {
      console.error('[bg/stickers DELETE]', err.message, err.stack);
      return json(res, { error: '스티커 삭제 실패: ' + err.message }, 500);
    }
  }

  // GET /api/bg/products/settings - 전체 상품 설정 목록
  if (pathname === '/api/bg/products/settings' && method === 'GET') {
    return json(res, { settings: await store.getAllProductSettings() });
  }

  // GET /api/bg/products/sales-list - 판매 이력 있는 카테고리별 상품 목록 (상품별 판매통계 선택기용)
  //   query.category: daeryepum(기본, D01) / deco(C29 + 2026_qr%) / flower(D02)
  //   대시보드 카테고리 탭과 동일 필터 적용 — 데코 탭에서 답례품 상품 안 보이게.
  if (pathname === '/api/bg/products/sales-list' && method === 'GET') {
    try {
      const days = Math.max(1, Math.min(365, parseInt(query.days) || 180));
      const startDate = new Date(Date.now() - days * 86400000);
      const startStr = startDate.toISOString().slice(0, 10);
      // 카테고리 분기 — server.js CATEGORY_FILTERS 와 동일 정책
      // 답례품: 자체매입 (D01) + 위탁답례품 (COM_ prefix)
      const CAT_FILTERS = {
        daeryepum: `(c.Card_Div = 'D01' OR c.Card_Code LIKE 'COM[_]%')`,
        deco:      `(c.Card_Div = 'C29' OR c.Card_Code LIKE '2026_qr%')`,
        flower:    `c.Card_Div = 'D02'`,
      };
      const catFilter = CAT_FILTERS[query.category] || CAT_FILTERS.daeryepum;
      // 데코는 Unit_Value 가 1 인 경우가 있어 분모 적용시 매출 왜곡 발생 → skip
      const skipUnitValue = query.category === 'deco';
      const cardUnitDivisor = skipUnitValue ? '1' : 'ISNULL(NULLIF(c.Unit_Value, 0), 1)';
      // BASE 코드 추출 (TGJSD01O4_A → TGJSD01O4) — 마지막 _XXX (영숫자만) 제거.
      //   사용자 정책: 동일 BASE 의 변형 (_A/_B/_C 캠페인별 분리) 을 단일 상품으로 통합.
      const baseCodeExpr = (col) => `CASE
        WHEN CHARINDEX('_', REVERSE(${col})) > 0
          AND RIGHT(${col}, CHARINDEX('_', REVERSE(${col})) - 1) NOT LIKE '%[^A-Za-z0-9]%'
        THEN LEFT(${col}, LEN(${col}) - CHARINDEX('_', REVERSE(${col})))
        ELSE ${col}
      END`;
      const pool = await getPool();
      const r = await pool.request().input('s', sql.VarChar, startStr).query(`
        WITH card_agg AS (
          SELECT c.Card_Code AS code, MAX(c.Card_Name) AS name,
                 SUM(coi.item_count) AS qty,
                 SUM(
                   CASE WHEN si.SiteName IS NULL
                        THEN CAST(coi.item_sale_price AS float) * coi.item_count
                             / ${cardUnitDivisor}
                        ELSE CAST(coi.item_sale_price AS float)
                   END
                 ) AS revenue,
                 MAX(co.order_date) AS last_sold
          FROM custom_order co WITH (NOLOCK)
          INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
          INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
          LEFT JOIN SiteInfo si WITH (NOLOCK) ON co.company_Seq = si.CompayCode
          WHERE ${catFilter} AND co.order_date >= @s
            AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5, 14)
          GROUP BY c.Card_Code
        ),
        etc_agg AS (
          SELECT c.Card_Code AS code, MAX(c.Card_Name) AS name,
                 SUM(ei.order_count) AS qty,
                 SUM(
                   CASE WHEN si.SiteName IS NULL
                        THEN CAST(ei.card_sale_price AS float) * ei.order_count
                             / ${cardUnitDivisor}
                             - ISNULL(o.coupon_price, 0)
                        ELSE CAST(ei.card_sale_price AS float) - ISNULL(o.coupon_price, 0)
                   END
                 ) AS revenue,
                 MAX(o.order_date) AS last_sold
          FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
          INNER JOIN CUSTOM_ETC_ORDER_ITEM ei WITH (NOLOCK) ON o.order_seq = ei.order_seq
          INNER JOIN S2_Card c WITH (NOLOCK) ON ei.card_seq = c.Card_Seq
          LEFT JOIN SiteInfo si WITH (NOLOCK) ON o.company_Seq = si.CompayCode
          WHERE ${catFilter} AND o.order_date >= @s
            AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 15)
          GROUP BY c.Card_Code
        )
        SELECT ${baseCodeExpr('u.code')} AS code,
               MAX(u.name) AS name,
               SUM(u.qty) AS total_qty,
               SUM(u.revenue) AS total_revenue,
               MAX(u.last_sold) AS last_sold_at,
               COUNT(DISTINCT u.code) AS variant_count
        FROM (SELECT * FROM card_agg UNION ALL SELECT * FROM etc_agg) AS u
        GROUP BY ${baseCodeExpr('u.code')}
        ORDER BY SUM(u.revenue) DESC
      `);
      return json(res, r.recordset.map(row => ({
        card_code: row.code, // BASE 코드 (변형 통합)
        card_name: (row.name || '').replace(/^\[.*?\]\s*/g, ''),
        total_qty: row.total_qty || 0,
        total_revenue: Math.round(row.total_revenue || 0),
        last_sold_at: row.last_sold_at,
        variant_count: row.variant_count || 1, // 통합된 변형(_A/_B/_C) 개수
      })));
    } catch (err) {
      console.error('[products/sales-list] error:', err.message);
      return json(res, { error: 'MSSQL 조회 실패: ' + err.message }, 500);
    }
  }

  // GET /api/bg/products/:productId/settings
  //   ERP 변형 코드 (예: TGJSD0104_B) 가 들어와도 base 코드 (TGJSD0104) 로 fallback.
  //   고객 엔드포인트와 동일 정책 — admin 수정 모달도 변형 주문에 base 설정을 적용해
  //   스티커/박스 드롭다운이 정상 노출되도록 함.
  const productSettingsMatch = pathname.match(/^\/api\/bg\/products\/([^/]+)\/settings$/);
  if (productSettingsMatch && method === 'GET') {
    const settings = await lookupProductSettings(decodeURIComponent(productSettingsMatch[1]));
    return json(res, { settings });
  }

  // PUT /api/bg/products/:productId/settings
  if (productSettingsMatch && method === 'PUT') {
    try {
      const body = await parseBody(req);
      const settings = await store.upsertProductSettings(
        decodeURIComponent(productSettingsMatch[1]), body
      );
      return json(res, settings);
    } catch (err) {
      console.error('[products/settings PUT] error:', err.message);
      return json(res, { error: err.message }, 500);
    }
  }

  // DELETE /api/bg/products/:productId/settings
  if (productSettingsMatch && method === 'DELETE') {
    const productId = decodeURIComponent(productSettingsMatch[1]);
    await store.deleteProductSettings(productId);
    return json(res, { ok: true });
  }

  // ============================================
  // 매출 데이터 그룹 (migration 040)
  //   매출 시트/상품 순위에서 여러 행을 하나의 그룹으로 묶어 합산 표시.
  //   멤버 = (site_name, match_type 'code'|'name', match_value).
  // ============================================
  // GET /api/bg/sales-groups?category=daeryepum
  if (pathname === '/api/bg/sales-groups' && method === 'GET') {
    try {
      const groups = await store.listSalesGroups({ category: query.category || null });
      return json(res, { groups });
    } catch (err) {
      console.error('[sales-groups GET] error:', err.message);
      return json(res, { error: err.message }, 500);
    }
  }
  // POST /api/bg/sales-groups — 그룹 생성 (+ members 동시 등록 가능)
  if (pathname === '/api/bg/sales-groups' && method === 'POST') {
    try {
      const body = await parseBody(req);
      const email = session?.email || null;
      const group = await store.createSalesGroup({ ...body, created_by: email });
      let members = [];
      if (Array.isArray(body.members) && body.members.length) {
        members = await store.addSalesGroupMembers(group.id, body.members, email);
      }
      return json(res, { ...group, members }, 201);
    } catch (err) {
      console.error('[sales-groups POST] error:', err.message);
      return json(res, { error: err.message }, 400);
    }
  }
  // PUT/DELETE /api/bg/sales-groups/:id
  const salesGroupMatch = pathname.match(/^\/api\/bg\/sales-groups\/([^/]+)$/);
  if (salesGroupMatch && method === 'PUT') {
    try {
      const body = await parseBody(req);
      const group = await store.updateSalesGroup(decodeURIComponent(salesGroupMatch[1]), body);
      return json(res, group);
    } catch (err) {
      console.error('[sales-groups PUT] error:', err.message);
      return json(res, { error: err.message }, 400);
    }
  }
  if (salesGroupMatch && method === 'DELETE') {
    try {
      const result = await store.deleteSalesGroup(decodeURIComponent(salesGroupMatch[1]));
      return json(res, result);
    } catch (err) {
      console.error('[sales-groups DELETE] error:', err.message);
      return json(res, { error: err.message }, 400);
    }
  }
  // POST /api/bg/sales-groups/:id/members — 멤버 추가 (다른 그룹 소속이면 이동)
  const salesGroupMembersMatch = pathname.match(/^\/api\/bg\/sales-groups\/([^/]+)\/members$/);
  if (salesGroupMembersMatch && method === 'POST') {
    try {
      const body = await parseBody(req);
      const added = await store.addSalesGroupMembers(
        decodeURIComponent(salesGroupMembersMatch[1]),
        body.members || [],
        session?.email || null,
      );
      return json(res, { members: added }, 201);
    } catch (err) {
      console.error('[sales-groups members POST] error:', err.message);
      return json(res, { error: err.message }, 400);
    }
  }
  // DELETE /api/bg/sales-group-members/:id — 멤버 해제
  const salesGroupMemberDelMatch = pathname.match(/^\/api\/bg\/sales-group-members\/([^/]+)$/);
  if (salesGroupMemberDelMatch && method === 'DELETE') {
    try {
      const result = await store.removeSalesGroupMember(decodeURIComponent(salesGroupMemberDelMatch[1]));
      return json(res, result);
    } catch (err) {
      console.error('[sales-group-members DELETE] error:', err.message);
      return json(res, { error: err.message }, 400);
    }
  }

  // ============================================
  // 위탁업체 (vendors) — Phase 1
  // ============================================
  // GET /api/bg/vendors?active_only=1
  if (pathname === '/api/bg/vendors' && method === 'GET') {
    try {
      const activeOnly = query.active_only === '1' || query.active_only === 'true';
      const vendors = await store.listVendors({ activeOnly });
      return json(res, { vendors });
    } catch (err) {
      console.error('[vendors GET] error:', err.message);
      return json(res, { error: err.message }, 500);
    }
  }
  // POST /api/bg/vendors
  if (pathname === '/api/bg/vendors' && method === 'POST') {
    try {
      const body = await parseBody(req);
      const vendor = await store.createVendor(body);
      return json(res, vendor, 201);
    } catch (err) {
      console.error('[vendors POST] error:', err.message);
      return json(res, { error: err.message }, 400);
    }
  }
  // GET/PUT/DELETE /api/bg/vendors/:id
  const vendorMatch = pathname.match(/^\/api\/bg\/vendors\/([^/]+)$/);
  if (vendorMatch && method === 'GET') {
    try {
      const vendor = await store.getVendor(decodeURIComponent(vendorMatch[1]));
      if (!vendor) return json(res, { error: '거래처를 찾을 수 없습니다' }, 404);
      return json(res, vendor);
    } catch (err) { return json(res, { error: err.message }, 500); }
  }
  if (vendorMatch && method === 'PUT') {
    try {
      const body = await parseBody(req);
      const vendor = await store.updateVendor(decodeURIComponent(vendorMatch[1]), body);
      return json(res, vendor);
    } catch (err) {
      console.error('[vendors PUT] error:', err.message);
      return json(res, { error: err.message }, 400);
    }
  }
  if (vendorMatch && method === 'DELETE') {
    try {
      const result = await store.deleteVendor(decodeURIComponent(vendorMatch[1]));
      return json(res, result);
    } catch (err) {
      console.error('[vendors DELETE] error:', err.message);
      return json(res, { error: err.message }, 400);
    }
  }

  // ============================================
  // 거래처 포털 토큰 (Phase 4 — 외부 거래처 접근)
  // ============================================
  // GET /api/bg/vendors/:id/portal-tokens — admin 발급된 토큰 목록
  const portalTokensMatch = pathname.match(/^\/api\/bg\/vendors\/([^/]+)\/portal-tokens$/);
  if (portalTokensMatch && method === 'GET') {
    try {
      const tokens = await store.listVendorPortalTokens(decodeURIComponent(portalTokensMatch[1]));
      return json(res, { tokens });
    } catch (err) { return json(res, { error: err.message }, 500); }
  }
  // POST /api/bg/vendors/:id/portal-tokens — admin 새 토큰 발급. body: { expires_days?, memo? }
  if (portalTokensMatch && method === 'POST') {
    try {
      const body = await parseBody(req);
      const expiresDays = body.expires_days != null ? Number(body.expires_days) : 30; // default 30일
      const expires_at = (expiresDays > 0)
        ? new Date(Date.now() + expiresDays * 86400000).toISOString()
        : null; // 0 = 영구
      const created_by = req._session?.user?.user_id || req._session?.user?.id || 'admin';
      const token = await store.createVendorPortalToken(decodeURIComponent(portalTokensMatch[1]), {
        expires_at, created_by, memo: body.memo || null,
      });
      return json(res, token, 201);
    } catch (err) {
      console.error('[portal-tokens POST] error:', err.message);
      return json(res, { error: err.message }, 400);
    }
  }
  // ============================================
  // 수동 주문 등록 (MSSQL 누락 사고 케이스 대응)
  // ============================================
  // GET /api/bg/manual-orders?category=&start_date=&end_date=
  if (pathname === '/api/bg/manual-orders' && method === 'GET') {
    try {
      const orders = await store.listManualOrders({
        category: query.category || null,
        startDate: query.start_date || null,
        endDate: query.end_date || null,
      });
      return json(res, { orders });
    } catch (err) {
      console.error('[manual-orders GET] error:', err.message);
      return json(res, { error: err.message }, 500);
    }
  }
  // POST /api/bg/manual-orders
  if (pathname === '/api/bg/manual-orders' && method === 'POST') {
    try {
      const body = await parseBody(req);
      body.created_by = req._session?.user?.user_id || req._session?.user?.id || 'admin';
      const order = await store.createManualOrder(body);
      return json(res, order, 201);
    } catch (err) {
      console.error('[manual-orders POST] error:', err.message);
      return json(res, { error: err.message }, 400);
    }
  }
  // ============================================
  // 사이트 공통 설정 (migration 036)
  // ============================================
  // GET /api/bg/site-settings — 공통 안내 등 조회. 인증 필요 없음? 상품설정 관리자만.
  //   /api/bg/* 는 이미 세션 인증 gate 통과 후라 별도 권한 체크 X (super admin 은 UI 에서 제어).
  if (pathname === '/api/bg/site-settings' && method === 'GET') {
    try {
      const s = await store.getSiteSettings();
      return json(res, s);
    } catch (err) {
      console.error('[site-settings GET] error:', err.message);
      return json(res, { error: err.message }, 500);
    }
  }
  // PUT /api/bg/site-settings — 공통 안내 저장 (super admin 만).
  if (pathname === '/api/bg/site-settings' && method === 'PUT') {
    try {
      if (!isSuperAdmin(session)) {
        return json(res, { error: '권한이 없습니다 (super admin 전용)' }, 403);
      }
      const body = await parseBody(req).catch(() => ({}));
      const updated = await store.updateSiteSettings(body, session?.email);
      return json(res, updated);
    } catch (err) {
      console.error('[site-settings PUT] error:', err.message);
      return json(res, { error: err.message }, 500);
    }
  }

  // POST /api/bg/manual-orders/backfill-stubs — 기존 MANUAL 주문에 ci stub 일괄 생성.
  //   body: { category?: 'daeryepum', force?: bool, offset?: number, limit?: number }
  //     offset/limit — 청크 처리용. 대량 (~1000건) backfill 시 프록시 60초 timeout 회피.
  //   response: { total, processed, offset_next, remaining, created, exists, recreated, failed, details }
  if (pathname === '/api/bg/manual-orders/backfill-stubs' && method === 'POST') {
    try {
      const body = await parseBody(req).catch(() => ({}));
      const result = await store.backfillManualOrderStubs({
        category: body.category || 'daeryepum',
        force: !!body.force,
        offset: Number(body.offset) || 0,
        limit: body.limit != null ? Number(body.limit) : null,
      });
      return json(res, result);
    } catch (err) {
      console.error('[manual-orders backfill-stubs] error:', err.message);
      return json(res, { error: err.message }, 500);
    }
  }
  // POST /api/bg/manual-orders/bulk — CSV 업로드 등 일괄 등록.
  //   body: { orders: [...], dryRun?: bool }
  //   response: { total, success, failed, skipped, details: [{index, order_id, status, reason?}] }
  if (pathname === '/api/bg/manual-orders/bulk' && method === 'POST') {
    try {
      const body = await parseBody(req);
      const orders = Array.isArray(body.orders) ? body.orders : [];
      const dryRun = !!body.dryRun;
      const overwrite = !!body.overwrite;
      const createdBy = req._session?.user?.user_id || req._session?.user?.id || 'admin';
      orders.forEach(o => { if (!o.created_by) o.created_by = createdBy; });
      const result = await store.bulkCreateManualOrders(orders, { dryRun, overwrite });
      return json(res, result);
    } catch (err) {
      console.error('[manual-orders bulk POST] error:', err.message);
      return json(res, { error: err.message }, 400);
    }
  }
  // GET/PUT/DELETE /api/bg/manual-orders/:order_id
  const manualOrderMatch = pathname.match(/^\/api\/bg\/manual-orders\/([^/]+)$/);
  if (manualOrderMatch && method === 'GET') {
    try {
      const order = await store.getManualOrder(decodeURIComponent(manualOrderMatch[1]));
      if (!order) return json(res, { error: '주문을 찾을 수 없습니다' }, 404);
      return json(res, order);
    } catch (err) { return json(res, { error: err.message }, 500); }
  }
  if (manualOrderMatch && method === 'PUT') {
    try {
      const body = await parseBody(req);
      const order = await store.updateManualOrder(decodeURIComponent(manualOrderMatch[1]), body);
      return json(res, order);
    } catch (err) {
      console.error('[manual-orders PUT] error:', err.message);
      return json(res, { error: err.message }, 400);
    }
  }
  if (manualOrderMatch && method === 'DELETE') {
    try {
      const result = await store.deleteManualOrder(decodeURIComponent(manualOrderMatch[1]));
      return json(res, result);
    } catch (err) {
      console.error('[manual-orders DELETE] error:', err.message);
      return json(res, { error: err.message }, 400);
    }
  }

  // POST /api/bg/vendor-portal-tokens/:id/revoke — admin 토큰 무효화
  const portalRevokeMatch = pathname.match(/^\/api\/bg\/vendor-portal-tokens\/([^/]+)\/revoke$/);
  if (portalRevokeMatch && method === 'POST') {
    try {
      const revoked_by = req._session?.user?.user_id || req._session?.user?.id || 'admin';
      const result = await store.revokeVendorPortalToken(decodeURIComponent(portalRevokeMatch[1]), revoked_by);
      return json(res, result);
    } catch (err) { return json(res, { error: err.message }, 400); }
  }

  // GET /api/bg/orders/shipping?ids=1,2,3 — 복수 주문 배송정보 일괄 조회 (관리자)
  if (pathname === '/api/bg/orders/shipping' && method === 'GET') {
    const rawIds = (query.ids || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!rawIds.length) return json(res, []);

    const etcSeqs = rawIds.filter(id => id.startsWith('ETC-')).map(id => parseInt(id.slice(4))).filter(n => n > 0);
    const normalSeqs = rawIds.filter(id => !id.startsWith('ETC-')).map(id => parseInt(id)).filter(n => n > 0);

    const result = [];
    const pool = await getPool();

    if (normalSeqs.length) {
      const inList = normalSeqs.join(',');
      const r = await pool.request().query(`
        SELECT co.order_seq, co.order_name,
          di.NAME AS recv_name, di.HPHONE AS recv_hphone, di.ADDR + ISNULL(' ' + di.ADDR_DETAIL, '') AS recv_addr,
          c.Card_Code, c.Card_Name
        FROM custom_order co WITH (NOLOCK)
        LEFT JOIN DELIVERY_INFO di WITH (NOLOCK) ON co.order_seq = di.ORDER_SEQ
        LEFT JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
        LEFT JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
        WHERE co.order_seq IN (${inList})
      `);
      const orderMap = new Map();
      r.recordset.forEach(row => {
        const key = String(row.order_seq);
        if (!orderMap.has(key)) {
          orderMap.set(key, {
            order_id: key,
            order_name: row.order_name || '',
            recv_name: row.recv_name || '',
            recv_hphone: row.recv_hphone || '',
            recv_addr: row.recv_addr || '',
            products: new Map(),
          });
        }
        if (row.Card_Code) orderMap.get(key).products.set(row.Card_Code, row.Card_Name || row.Card_Code);
      });
      orderMap.forEach(o => { o.products = Object.fromEntries(o.products); result.push(o); });
    }

    if (etcSeqs.length) {
      const inList = etcSeqs.join(',');
      const r = await pool.request().query(`
        SELECT co.order_seq, co.order_name, co.recv_name, co.recv_hphone,
          co.recv_address + ISNULL(' ' + co.recv_address_detail, '') AS recv_addr,
          c.Card_Code, c.Card_Name
        FROM CUSTOM_ETC_ORDER co WITH (NOLOCK)
        LEFT JOIN CUSTOM_ETC_ORDER_ITEM ei WITH (NOLOCK) ON co.order_seq = ei.order_seq
        LEFT JOIN S2_Card c WITH (NOLOCK) ON ei.card_seq = c.Card_Seq
        WHERE co.order_seq IN (${inList})
      `);
      const orderMap = new Map();
      r.recordset.forEach(row => {
        const key = 'ETC-' + String(row.order_seq);
        if (!orderMap.has(key)) {
          orderMap.set(key, {
            order_id: key,
            order_name: row.order_name || '',
            recv_name: row.recv_name || '',
            recv_hphone: row.recv_hphone || '',
            recv_addr: row.recv_addr || '',
            products: new Map(),
          });
        }
        if (row.Card_Code) orderMap.get(key).products.set(row.Card_Code, row.Card_Name || row.Card_Code);
      });
      orderMap.forEach(o => { o.products = Object.fromEntries(o.products); result.push(o); });
    }

    return json(res, result);
  }

  // GET /api/bg/customer-infos - 전체 고객 입력 목록 (관리자)
  if (pathname === '/api/bg/customer-infos' && method === 'GET') {
    const infos = await store.getAllCustomerInfos();
    // sticker_id → sticker_code / sticker_name join
    const allStickers = await store.getAllStickers(false);
    const stickerMap = new Map(allStickers.map(s => [s.id, s]));

    // GET 시점 데이터 보정:
    //   · sticker_code/name 을 sticker_id lookup 결과로 정규화 (stale sticker_code 값 교체)
    //   · 정책 변경 (2026-06): autoAdvance 호출 제거 — 정보입력완료 시 자동 bound 진행 안 함.
    //     자동 진행은 setProcessed (수집처리) 시점으로 이동.
    //   · sticker_code drift 감지 시에만 background persist (sticker_id 기반 canonicalization 용).
    const stalePatchQueue = [];
    const enriched = infos.map(info => {
      const origSels = info.sticker_selections || [];
      // enrichment — sticker_code/name 을 sticker_id lookup 결과로 정규화.
      //    (stale sticker_code 값을 canonical 값으로 교체 — sticker_id=null 이면 sticker_code=null)
      const enrichedSels = origSels.map(sel => {
        const st = stickerMap.get(sel.sticker_id);
        return {
          ...sel,
          // sticker_id 가 있으면 bg_stickers lookup 으로 canonical 정규화.
          // sticker_id 가 없으면(카페24 변형코드 등 bg_stickers 미매칭 코드) 저장된 sticker_code 를 보존.
          //   ※ 미보존 시 카페24 sticker_code(변형코드)가 null 로 drift 판정돼 백그라운드로 지워짐.
          sticker_code: sel.sticker_id ? (st?.sticker_code || null) : (sel.sticker_code || null),
          sticker_name: sel.sticker_name || st?.name || sel.sticker_id,
        };
      });
      // sticker_code drift 감지 — sticker_id 가 있는데 enriched sticker_code 가 DB 원본과 다르면 정정.
      const hasStickerCodeDrift = enrichedSels.some((sel, i) => {
        const b = origSels[i] || {};
        return (sel.sticker_code || null) !== (b.sticker_code || null);
      });
      if (hasStickerCodeDrift) {
        stalePatchQueue.push({ orderId: info.order_id, selections: enrichedSels });
      }
      return { ...info, sticker_selections: enrichedSels };
    });

    // 비동기 persist — 응답은 즉시 반환, DB 정상화는 백그라운드.
    if (stalePatchQueue.length) {
      const { updateCustomerInfo } = require('./workflow-store');
      (async () => {
        for (const { orderId, selections } of stalePatchQueue) {
          try {
            await updateCustomerInfo(orderId, { sticker_selections: selections });
          } catch (e) {
            console.warn(`[customer-infos auto-backfill] ${orderId}: ${e.message}`);
          }
        }
        console.log(`[customer-infos auto-backfill] persisted ${stalePatchQueue.length} stale rows`);
      })();
    }

    return json(res, { infos: enriched });
  }

  // PUT /api/bg/orders/:orderId/customer-info - 관리자 수정/추가
  const customerInfoEditMatch = pathname.match(/^\/api\/bg\/orders\/([^/]+)\/customer-info$/);
  if (customerInfoEditMatch && method === 'PUT') {
    const orderId = decodeURIComponent(customerInfoEditMatch[1]);
    try {
      const body = await parseBody(req);

      // 관리자 일괄 마킹 (예: '수동 수집됨 표시') 인지 — customer_request 에
      // '[admin]' 프리픽스 마커가 있으면 admin 우회 모드.
      // 일반 고객 입력 / 관리자 수정 모달은 마커 없으므로 영향 없음.
      const isAdminBulkMark = typeof body.customer_request === 'string'
        && /^\[admin\]/.test(body.customer_request);

      // 필수 필드 검증 — submitted_at 이 세팅되어 고객이 '입력완료' 로 인식하는
      // 상태가 되므로, 최소 핵심 필드는 반드시 있어야 함.
      // 단, admin bulk mark 는 외부 자료 참조가 목적이므로 검증 우회.
      if (!body.desired_ship_date && !isAdminBulkMark) {
        return json(res, { error: '희망출고일은 필수입니다.' }, 400);
      }

      // 박스 옵션이 등록된 상품은 box_code 필수 (품절 옵션 차단)
      // admin bulk mark 는 sticker_selections 가 빈 배열 → 자동 스킵.
      // 변형 코드 fallback — 위와 동일 정책 (specific 우선, base 코드 fallback).
      const sels = Array.isArray(body.sticker_selections) ? body.sticker_selections : [];
      for (const sel of sels) {
        if (!sel.product_code) continue;
        const ps = await lookupProductSettings(sel.product_code);
        const boxOpts = Array.isArray(ps?.available_box_options) ? ps.available_box_options : [];
        if (boxOpts.length > 0) {
          const picked = boxOpts.find(o => o.code === sel.box_code);
          const productLabel = sel.product_name || sel.product_code;
          if (!picked) {
            return json(res, { error: `${productLabel}: 박스 패키지 선택이 필요합니다.` }, 400);
          }
          if (picked.sold_out) {
            return json(res, { error: `${productLabel}: 선택한 박스 패키지가 품절입니다.` }, 400);
          }
        }
      }

      const updated = await store.updateCustomerInfo(orderId, body);
      return json(res, { ok: true, info: updated });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  }

  // DELETE /api/bg/orders/:orderId/customer-info - 관리자 초기화 (재입력 허용)
  if (customerInfoEditMatch && method === 'DELETE') {
    const orderId = decodeURIComponent(customerInfoEditMatch[1]);
    try {
      await store.deleteCustomerInfo(orderId);
      logAccess(req, 'reset', orderId, {
        status_code: 200,
        metadata: { actor: session?.email || 'admin' },
      });
      return json(res, { ok: true });
    } catch (err) {
      console.error('barungift delete customer-info error:', err.message);
      logAccess(req, 'reset', orderId, { status_code: 500, metadata: { error: err.message } });
      return json(res, { error: err.message }, 500);
    }
  }

  // PATCH /api/bg/orders/:orderId/processed - 후공정 처리 상태 토글
  //   body: { processed: boolean }
  const processedMatch = pathname.match(/^\/api\/bg\/orders\/([^/]+)\/processed$/);
  if (processedMatch && method === 'PATCH') {
    const orderId = decodeURIComponent(processedMatch[1]);
    try {
      const body = await parseBody(req);
      const updated = await store.setProcessed(orderId, {
        processed: !!body.processed,
        processed_by: session?.email || null,
      });
      logAccess(req, body.processed ? 'mark_processed' : 'unmark_processed', orderId, {
        status_code: 200,
        metadata: { actor: session?.email || 'admin' },
      });
      return json(res, { ok: true, info: updated });
    } catch (err) {
      if (err.message === 'NOT_FOUND') return json(res, { error: '주문 정보를 찾을 수 없습니다.' }, 404);
      if (err.message === 'PROCESSED_COLUMN_MISSING') {
        return json(res, { error: 'DB 마이그레이션 011 적용이 필요합니다.' }, 500);
      }
      console.error('setProcessed error:', err.message);
      return json(res, { error: err.message }, 500);
    }
  }

  // POST /api/bg/orders/processed-batch - 여러 주문 일괄 처리 마킹
  //   body: { order_ids: string[], processed: boolean }
  if (pathname === '/api/bg/orders/processed-batch' && method === 'POST') {
    try {
      const body = await parseBody(req);
      const orderIds = Array.isArray(body.order_ids) ? body.order_ids : [];
      if (!orderIds.length) return json(res, { error: 'order_ids 가 필요합니다.' }, 400);
      const result = await store.setProcessedBatch(orderIds, {
        processed: !!body.processed,
        processed_by: session?.email || null,
      });
      logAccess(req, body.processed ? 'mark_processed_batch' : 'unmark_processed_batch', null, {
        status_code: 200,
        metadata: { actor: session?.email || 'admin', count: orderIds.length, ok: result.ok, fail: result.fail },
      });
      return json(res, { ok: true, ...result });
    } catch (err) {
      console.error('setProcessedBatch error:', err.message);
      return json(res, { error: err.message }, 500);
    }
  }

  // GET /api/bg/audit/access-log?order_id=xxx&limit=100&since=ISO - 관리자 감사 로그 조회
  if (pathname === '/api/bg/audit/access-log' && method === 'GET') {
    const logs = await getRecentLogs({
      orderId: query.order_id,
      limit: parseInt(query.limit) || 100,
      since: query.since,
    });
    return json(res, { logs });
  }

  // GET /api/bg/audit/sign-url?oid=BHS-1234567&base=https://...  - 관리자 서명 URL 발급
  // 관리자가 수동으로 고객에게 안전한 링크를 보낼 때 사용 (LMS 자동 발송측은 미연동)
  if (pathname === '/api/bg/audit/sign-url' && method === 'GET') {
    const oid = (query.oid || '').trim();
    if (!oid) return json(res, { error: 'oid 가 필요합니다.' }, 400);
    // base 미지정 시 요청 호스트 기준 자동 구성
    const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
    const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
    const defaultBase = `${proto}://${host}/c/barungift/order-info`;
    const base = (query.base || defaultBase).trim();
    const url = signedUrl.buildUrl(base, oid);
    const { t, sig } = signedUrl.sign(oid);
    return json(res, {
      url,
      oid,
      t,
      sig,
      max_age_sec: signedUrl.MAX_AGE_SEC,
      strict_mode: signedUrl.STRICT,
      expires_at: new Date((t + signedUrl.MAX_AGE_SEC) * 1000).toISOString(),
    });
  }

  // GET /api/bg/shipping-config - 공통 출고일 설정 조회
  //   ?id=<group_id> 있으면 해당 그룹. 없으면 기본 그룹(is_default=true).
  if (pathname === '/api/bg/shipping-config' && method === 'GET') {
    return json(res, { config: await store.getShippingConfig(query.id || null) });
  }

  // PUT /api/bg/shipping-config - 공통 출고일 설정 저장
  //   ?id=<group_id> 있으면 해당 그룹 업데이트, 없으면 기본 그룹 업데이트.
  if (pathname === '/api/bg/shipping-config' && method === 'PUT') {
    const body = await parseBody(req);
    const config = await store.saveShippingConfig(body, query.id || null);
    return json(res, config);
  }

  // GET /api/bg/shipping-groups - 전체 출고일 그룹 목록
  if (pathname === '/api/bg/shipping-groups' && method === 'GET') {
    return json(res, { groups: await store.getShippingGroups() });
  }

  // POST /api/bg/shipping-groups - 새 그룹 생성 (기본 그룹 외)
  if (pathname === '/api/bg/shipping-groups' && method === 'POST') {
    try {
      const body = await parseBody(req);
      const group = await store.createShippingGroup(body);
      return json(res, group, 201);
    } catch (err) {
      return json(res, { error: err.message }, 400);
    }
  }

  // DELETE /api/bg/shipping-groups/:id - 그룹 삭제 (기본 그룹 불가, 사용 중이면 불가)
  const shippingGroupDelMatch = pathname.match(/^\/api\/bg\/shipping-groups\/([^/]+)$/);
  if (shippingGroupDelMatch && method === 'DELETE') {
    try {
      await store.deleteShippingGroup(decodeURIComponent(shippingGroupDelMatch[1]));
      return json(res, { ok: true });
    } catch (err) {
      return json(res, { error: err.message }, 400);
    }
  }

  // ============================================
  // 알림톡 발송 API
  //   2026-05-20 정리: Partner API 직접 호출 경로 (recipients/send/preview) 제거.
  //   send-via-sp 단일 경로로 통합 (SP 우선 + 통합관리자 HTTP API fallback).
  // ============================================

  // POST /api/bg/alimtalk/send-via-sp - 답례품 알림톡 발송 (auto-fallback)
  //   경로 우선순위:
  //     1) SP_GIFT_ORDER_BIZTALK_PROC 직접 EXEC (readonly_user 가 GRANT 받았으면 동작)
  //     2) 권한 에러 시 → 통합관리자 HTTP API (admin.barunsoncard.com/KakaoBizTalk/ResendGift)
  //   둘 중 어느 쪽이 unblocked 되든 자동으로 살아남 — 운영팀 인프라 의존성 분리.
  //   메모리에 SP availability 캐시 (권한 거부 1회 감지 후 같은 process 동안 SP skip).
  //
  //   엔드포인트 이름은 frontend 호환 위해 '/send-via-sp' 유지 (legacy naming).
  if (pathname === '/api/bg/alimtalk/send-via-sp' && method === 'POST') {
    // M7: rate limit — SMS 비용 폭증 가드 (5분당 5회)
    const rlAlim = rlCheck(req, 'alimtalk_send', RL_LIMITS.alimtalk_send);
    if (!rlAlim.allowed) {
      logAccess(req, 'rate_limited', null, { status_code: 429, metadata: { action: 'alimtalk_send', retry_after: rlAlim.retryAfterSec } });
      return rateLimitResponse(res, rlAlim);
    }
    try {
      const body = await parseBody(req);
      const orderIds = Array.isArray(body.order_ids) ? body.order_ids : [];
      const templateName = (body.template_name || '답례품_주문완료').trim();
      if (orderIds.length === 0) return json(res, { error: '발송할 주문을 선택해주세요.' }, 400);
      if (orderIds.length > 200) return json(res, { error: '한 번에 최대 200건까지 가능합니다.' }, 400);

      logAccess(req, 'alimtalk_send_start', null, {
        metadata: { template: templateName, order_count: orderIds.length },
      });

      const adminClient = require('./admin-client');
      const pool = await getPool();
      const results = [];
      const viaCounts = { sp: 0, 'admin-http': 0 };
      let httpAborted = false; // 세션 만료/네트워크 차단 시 이후 HTTP 호출 skip

      for (const rawId of orderIds) {
        const oid = String(rawId || '').trim();
        if (!oid) {
          results.push({ order_id: rawId, success: false, error: '빈 order_id' });
          continue;
        }
        const isEtc = oid.startsWith('ETC-');
        const seq = parseInt(isEtc ? oid.slice(4) : oid);
        const orderCategory = isEtc ? 'E' : 'W';
        if (!seq || isNaN(seq)) {
          results.push({ order_id: oid, success: false, error: 'order_seq 파싱 실패' });
          continue;
        }

        let sent = false;
        let lastError = null;
        let via = null;

        // 1) SP 경로 — 이전 호출에서 권한 거부 확인됐으면 skip.
        if (_spAvailable !== false) {
          try {
            await pool.request()
              .input('order_seq', sql.Int, seq)
              .input('order_type', sql.Char(1), orderCategory)
              .input('template_name', sql.NVarChar, templateName)
              .execute('SP_GIFT_ORDER_BIZTALK_PROC');
            sent = true;
            via = 'sp';
            viaCounts.sp++;
            _spAvailable = true;
          } catch (spErr) {
            const msg = spErr.message || '';
            const isPermDenied = /EXECUTE permission was denied/i.test(msg);
            if (isPermDenied) {
              if (_spAvailable !== false) {
                console.warn('[alimtalk] SP 권한 없음 감지 — 이후 호출은 HTTP fallback 만 사용');
              }
              _spAvailable = false;
              lastError = `SP 권한 없음: ${msg}`;
              // fallback 진행
            } else {
              // 권한 외 SP 에러 (예: order_seq 잘못 등) — HTTP fallback 도 의미 없음
              lastError = `SP 실패: ${msg}`;
            }
          }
        }

        // 2) HTTP API fallback — SP 미시도 또는 권한 실패 시.
        if (!sent && !httpAborted) {
          try {
            await adminClient.resendGift({ orderSeq: seq, orderCategory });
            sent = true;
            via = 'admin-http';
            viaCounts['admin-http']++;
          } catch (httpErr) {
            const msg = httpErr.message || '';
            lastError = (lastError ? lastError + ' | ' : '') + `HTTP: ${msg}`;
            if (/SESSION_EXPIRED|NETWORK_FAIL/.test(msg)) {
              httpAborted = true; // 이후 호출 시도 안 함 (전부 같은 이유로 실패할 것)
              console.warn('[alimtalk] HTTP fallback 차단 감지 — 이후 호출 abort:', msg);
            }
          }
        }

        if (sent) {
          results.push({ order_id: oid, order_seq: seq, order_type: orderCategory, success: true, via });
        } else {
          results.push({ order_id: oid, order_seq: seq, order_type: orderCategory, success: false, error: lastError || 'unknown' });
          if (httpAborted) {
            // 남은 주문들은 어차피 같은 이유로 실패 — 일찍 끝냄
            results.push({ order_id: '_aborted', success: false, error: '경로 차단으로 이후 호출 중단 (SP 권한 X + HTTP 차단)' });
            break;
          }
        }
      }

      const summary = {
        total: results.length,
        sent: results.filter(r => r.success).length,
        failed: results.filter(r => !r.success).length,
        template: templateName,
        via_counts: viaCounts,
        sp_available: _spAvailable,
      };
      logAccess(req, 'alimtalk_send_done', null, {
        metadata: { ...summary },
      });
      return json(res, { summary, results });
    } catch (err) {
      console.error('alimtalk send error:', err.message);
      logAccess(req, 'alimtalk_send_error', null, {
        status_code: 500, metadata: { error: err.message },
      });
      return json(res, { error: '알림톡 발송 실패: ' + err.message }, 500);
    }
  }

  // GET /api/bg/alimtalk/admin-status - 통합관리자 cookie 설정 상태 진단
  //   세션 만료 운영 점검용 (cookie 값 노출 X, 설정 여부만).
  //   ?test=1 옵션 — 실제 admin.barunsoncard.com 도달 가능 여부 ping (cookie 무관).
  if (pathname === '/api/bg/alimtalk/admin-status' && method === 'GET') {
    const adminClient = require('./admin-client');
    const config = adminClient.getConfigStatus();
    const parsed = url.parse(req.url, true);
    const base = { ...config, sp_available: _spAvailable };
    if (parsed.query.test === '1') {
      const conn = await adminClient.testConnectivity();
      return json(res, { ...base, connectivity: conn });
    }
    return json(res, base);
  }

  // POST /api/bg/alimtalk/sp-reset - SP availability 캐시 초기화
  //   DBA 가 GRANT EXECUTE 부여 후 컨테이너 재시작 없이 SP 경로 재시도하도록.
  //   다음 발송 호출 시 SP 우선 시도 → 성공하면 true, 또 실패하면 false.
  if (pathname === '/api/bg/alimtalk/sp-reset' && method === 'POST') {
    const prev = _spAvailable;
    _spAvailable = null;
    logAccess(req, 'alimtalk_sp_reset', null, { metadata: { prev } });
    return json(res, { ok: true, prev, current: null });
  }

  return false; // 미처리 → 다른 핸들러로
}

function maskName(name) {
  if (!name || name.length <= 1) return name;
  if (name.length === 2) return name[0] + '*';
  return name[0] + '*'.repeat(name.length - 2) + name[name.length - 1];
}

/**
 * 답례품/꽃다발 주문 통합 검색 (바른손카드 + 바른손몰)
 * @param {Object} opts - {phone, phoneFull, uname, useLike, maskCustomerName}
 *   useLike=true: LIKE '%' + @phone  (로그인 플로우)
 *   useLike=false: REPLACE(...) = @phone (정확 매칭, 전화번호+이름 검색)
 */
async function searchDaeryepumOrders(pool, sql, opts) {
  const { phone, uname, useLike, maskCustomerName, memberId } = opts;

  // 바른손카드 (custom_order) 조회
  const cardRequest = pool.request();
  cardRequest.input('phone', sql.VarChar, phone);
  cardRequest.input('uname', sql.VarChar, uname);
  if (memberId) cardRequest.input('memberId', sql.VarChar, memberId);
  // 정규화 정책 (양쪽 일관 적용):
  //   - phone: order_hphone 의 '-' 와 ' ' 모두 제거 후 비교 (저장 형식 차이 흡수)
  //   - name : 양 끝 공백 + 중간 공백 모두 제거 후 비교 ('김 혜린' = '김혜린')
  // ⚠️ 보안: phone AND name 둘 다 일치해야 함 (OR 조건은 동명이인 주문 노출 버그).
  // 매칭 우선순위 (memberId 있을 때):
  //   1순위: order.member_id = @memberId (통합회원 ID 직접 매칭 — 가장 정확)
  //   2순위: phone AND name 매칭 (회원정보 변경 / 비회원→회원 전환 등 fallback)
  //   둘 다 specific 이므로 OR 안전 (동명이인 노출 X — member_id 는 1:1 식별자)
  const NORM_PHONE = "REPLACE(REPLACE(co.order_hphone, '-', ''), ' ', '')";
  const NORM_DB_NAME = "REPLACE(LTRIM(RTRIM(co.order_name)), ' ', '')";
  const NORM_PARAM_NAME = "REPLACE(LTRIM(RTRIM(@uname)), ' ', '')";
  const phoneOp = useLike ? `LIKE '%' + @phone` : `= @phone`;
  const phoneNameClause = `${NORM_PHONE} ${phoneOp} AND ${NORM_DB_NAME} = ${NORM_PARAM_NAME}`;
  const cardWhere = memberId
    ? `AND (LTRIM(RTRIM(co.member_id)) = LTRIM(RTRIM(@memberId)) OR (${phoneNameClause}))`
    : `AND ${phoneNameClause}`;
  const cardResult = await cardRequest.query(`
    SELECT DISTINCT TOP 20
      co.order_seq, co.order_date, co.order_name, co.order_hphone,
      co.order_total_price, co.last_total_price, co.status_seq,
      co.settle_status, co.settle_date,
      (SELECT TOP 1 c2.Card_Name FROM custom_order_item coi2 WITH (NOLOCK)
       INNER JOIN S2_Card c2 WITH (NOLOCK) ON coi2.card_seq = c2.Card_Seq
       WHERE coi2.order_seq = co.order_seq
         AND ${DAERYEPUM_WHERE.replace(/c\./g, 'c2.')}
      ) AS card_name,
      (SELECT COUNT(DISTINCT c3.Card_Code) FROM custom_order_item coi3 WITH (NOLOCK)
       INNER JOIN S2_Card c3 WITH (NOLOCK) ON coi3.card_seq = c3.Card_Seq
       WHERE coi3.order_seq = co.order_seq
         AND ${DAERYEPUM_WHERE.replace(/c\./g, 'c3.')}
      ) AS product_count
    FROM custom_order co WITH (NOLOCK)
    INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
    INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
    WHERE co.status_seq >= 1
      AND co.order_date >= DATEADD(month, -6, GETDATE())
      AND ${DAERYEPUM_WHERE}
      ${cardWhere}
    ORDER BY co.order_date DESC
  `);

  // 바른손몰 ETC (CUSTOM_ETC_ORDER) 조회
  const etcRequest = pool.request();
  etcRequest.input('phone', sql.VarChar, phone);
  etcRequest.input('uname', sql.VarChar, uname);
  if (memberId) etcRequest.input('memberId', sql.VarChar, memberId);
  // 매칭 정책 cardWhere 와 동일 (member_id 1순위 + phone+name 2순위).
  const etcWhere = memberId
    ? `AND (LTRIM(RTRIM(co.member_id)) = LTRIM(RTRIM(@memberId)) OR (${phoneNameClause}))`
    : `AND ${phoneNameClause}`;
  const etcResult = await etcRequest.query(`
    SELECT DISTINCT TOP 20
      co.order_seq, co.order_date, co.order_name, co.order_hphone, co.settle_price,
      co.status_seq, co.settle_date,
      (SELECT TOP 1 c2.Card_Name FROM CUSTOM_ETC_ORDER_ITEM ei2 WITH (NOLOCK)
       INNER JOIN S2_Card c2 WITH (NOLOCK) ON ei2.card_seq = c2.Card_Seq
       WHERE ei2.order_seq = co.order_seq
         AND ${DAERYEPUM_WHERE.replace(/c\./g, 'c2.')}
      ) AS card_name,
      (SELECT COUNT(DISTINCT c3.Card_Code) FROM CUSTOM_ETC_ORDER_ITEM ei3 WITH (NOLOCK)
       INNER JOIN S2_Card c3 WITH (NOLOCK) ON ei3.card_seq = c3.Card_Seq
       WHERE ei3.order_seq = co.order_seq
         AND ${DAERYEPUM_WHERE.replace(/c\./g, 'c3.')}
      ) AS product_count
    FROM CUSTOM_ETC_ORDER co WITH (NOLOCK)
    INNER JOIN CUSTOM_ETC_ORDER_ITEM ei WITH (NOLOCK) ON co.order_seq = ei.order_seq
    INNER JOIN S2_Card c WITH (NOLOCK) ON ei.card_seq = c.Card_Seq
    WHERE co.status_seq >= 1
      AND co.order_date >= DATEADD(month, -6, GETDATE())
      AND ${DAERYEPUM_WHERE}
      ${etcWhere}
    ORDER BY co.order_date DESC
  `);

  // 결제상태 계산 헬퍼 (고객 상세 API 로직과 일치)
  //   CARD : settle_status 2=완료, 1=대기, 3·5=취소
  //   ETC  : settle_status 컬럼 없음 → settle_date 유무로 판정
  function calcCardPaymentStatus(r) {
    if (r.settle_status === 2) return 'paid';
    if (r.settle_status === 1) return 'pending';
    if (r.settle_status === 3 || r.settle_status === 5) return 'cancelled';
    return 'unknown';
  }
  function calcEtcPaymentStatus(r) {
    return r.settle_date ? 'paid' : 'pending';
  }

  // 병합 + 정렬
  const combined = [
    ...cardResult.recordset.map(r => ({
      order_id: String(r.order_seq),
      order_number: 'BRS-' + r.order_seq,
      customer_name: maskCustomerName ? maskName(r.order_name || '') : (r.order_name || ''),
      phone_last4: (r.order_hphone || '').replace(/\D/g, '').slice(-4),
      order_date: r.order_date,
      total_amount: r.last_total_price || r.order_total_price || 0,
      product_name: r.card_name || '답례품',
      product_count: r.product_count || 1, // DISTINCT D01 상품 개수
      status_seq: r.status_seq,
      payment_status: calcCardPaymentStatus(r), // 'paid' | 'pending' | 'cancelled' | 'unknown'
      source: 'card',
    })),
    ...etcResult.recordset.map(r => ({
      order_id: 'ETC-' + r.order_seq,
      order_number: 'BHS-' + r.order_seq,
      customer_name: maskCustomerName ? maskName(r.order_name || '') : (r.order_name || ''),
      phone_last4: (r.order_hphone || '').replace(/\D/g, '').slice(-4),
      order_date: r.order_date,
      total_amount: r.settle_price || 0,
      product_name: r.card_name || '답례품',
      product_count: r.product_count || 1,
      status_seq: r.status_seq,
      payment_status: calcEtcPaymentStatus(r),
      source: 'etc',
    })),
  ].sort((a, b) => new Date(b.order_date) - new Date(a.order_date));

  // 검색 결과가 0건이면 어느 조건에서 탈락했는지 진단 로그 (개발 운영 지원)
  if (combined.length === 0 && !useLike) {
    try {
      const diag = await pool.request()
        .input('phone', sql.VarChar, phone)
        .input('uname', sql.VarChar, uname)
        .query(`
          SELECT TOP 5 co.order_seq, co.order_name, co.order_hphone, co.order_date, co.status_seq,
                 (SELECT TOP 1 c.Card_Div FROM custom_order_item coi WITH (NOLOCK)
                  INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
                  WHERE coi.order_seq = co.order_seq) AS first_card_div,
                 DATEDIFF(day, co.order_date, GETDATE()) AS days_ago
          FROM custom_order co WITH (NOLOCK)
          WHERE REPLACE(co.order_hphone, '-', '') = @phone
             OR LTRIM(RTRIM(co.order_name)) = LTRIM(RTRIM(@uname))
          ORDER BY co.order_date DESC
        `);
      if (diag.recordset.length) {
        console.log('[search diagnostic] phone/uname 일치 주문은 있으나 필터 탈락:');
        diag.recordset.forEach(o => console.log(`  seq=${o.order_seq} name="${o.order_name}" hphone=${o.order_hphone} status=${o.status_seq} div=${o.first_card_div} ${o.days_ago}일전`));
      } else {
        console.log(`[search diagnostic] phone="${phone}" uname="${uname}" 일치하는 주문 자체가 없음`);
      }
    } catch (e) {
      console.warn('[search diagnostic] 실패:', e.message);
    }
  }

  // 고객 입력 상태 배치 조회
  const orderSeqs = combined.map(o => o.order_id);
  const customerInfos = await store.getCustomerInfoBatch(orderSeqs);
  const infoMap = new Map(customerInfos.map(i => [i.order_id, i]));

  return combined.map(o => ({
    ...o,
    info_status: infoMap.get(o.order_id)?.submitted_at ? 'completed' : 'pending',
  }));
}

module.exports = { handleBarungiftApi };
