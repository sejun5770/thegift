/**
 * 바른기프트 API 라우트 핸들러
 */
const url = require('url');
const store = require('./store');
const { logAccess, getRecentLogs } = require('./audit-log');
const { check: rlCheck, rateLimitResponse, LIMITS: RL_LIMITS } = require('./rate-limit');
const signedUrl = require('./signed-url');

// 답례품 필터 SQL 조건 (관리자 통합현황과 동일: S2_Card.Card_Div = 'D01')
// custom_order_item + S2_Card JOIN 후 사용. c 에일리어스 사용.
const DAERYEPUM_WHERE = `c.Card_Div = 'D01'`;

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

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

/**
 * 바른기프트 API 핸들러 (barunson DB pool도 받음)
 * @returns {boolean} 처리 여부 (true면 다른 라우터로 넘기지 않음)
 */
async function handleBarungiftApi(pathname, req, res, query, { getPool, sql, session }) {
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
      const result = await pool.request()
        .input('uid', sql.VarChar, uid)
        .input('pwd', sql.VarChar, password)
        .query(`
          SELECT uid, uname, hand_phone1, hand_phone2, hand_phone3,
                 PWDCOMPARE(@pwd, CONVERT(varbinary(200), PWD, 1)) AS pwd_match
          FROM S2_UserInfo WITH (NOLOCK)
          WHERE uid = @uid AND USE_YORN = 'Y'
        `);

      if (!result.recordset.length || !result.recordset[0].pwd_match) {
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
      const orders = await searchDaeryepumOrders(pool, sql, {
        phone: phone.slice(-8),
        phoneFull: phone,
        uname: user.uname,
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

      // 상품코드로 product_settings 조회
      const productSettings = row.Card_Code ? await store.getProductSettings(row.Card_Code) : null;
      const allActiveStickers = await store.getAllStickers(true);

      // 아이템 수집 (DELIVERY_INFO JOIN으로 인한 중복 제거: item_id 기준)
      const seenItems = new Set();
      const products = [];
      for (const r of result.recordset) {
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

      // 상품별 스티커 / 박스옵션 매핑 + 합집합 계산
      // stickersByProduct: { product_code: [sticker, ...] } — 고객 화면에서 상품별 필터링에 사용
      // boxOptionsByProduct: { product_code: [{code,name,color,preview_image_url}, ...] } — 박스 패키지 선택용
      const allMappedStickerIds = new Set();
      const stickersByProduct = {};
      const boxOptionsByProduct = {};
      const stickerById = new Map(allActiveStickers.map(s => [s.id, s]));
      for (const p of products) {
        if (!p.product_code) continue;
        const ps = await store.getProductSettings(p.product_code);
        const ids = ps?.available_sticker_ids || [];
        ids.forEach(id => allMappedStickerIds.add(id));
        stickersByProduct[p.product_code] = ids
          .map(id => stickerById.get(id))
          .filter(Boolean);
        // 박스 옵션 매핑 (없거나 비어있으면 빈 배열)
        const boxOpts = Array.isArray(ps?.available_box_options) ? ps.available_box_options : [];
        boxOptionsByProduct[p.product_code] = boxOpts;
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
        // 여러 상품이 다른 그룹에 속하는 경우는 현재 첫 상품 기준 (추후 확장 가능).
        shipping_config: await store.getShippingConfig(productSettings?.shipping_group_id || null),
        available_stickers: availableStickers,
        stickers_by_product: stickersByProduct,
        box_options_by_product: boxOptionsByProduct, // { product_code: [{code,name,color,preview_image_url}] }
        existing_info: existingInfo,
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

  // GET /api/bg/debug/schema?table=custom_order - 테이블 컬럼 목록 조회 (개발용)
  if (pathname === '/api/bg/debug/schema' && method === 'GET') {
    const tableName = query.table || 'custom_order';
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
  // 관리자용 API (인증 필요 - session 체크)
  // ============================================

  // 관리자 API는 인증 필요 (개발모드에서는 우회)
  const DEV_SKIP_AUTH = !process.env.GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID === 'test';
  if (pathname.startsWith('/api/bg/') && !session && !DEV_SKIP_AUTH) {
    return json(res, { error: '인증이 필요합니다.' }, 401);
  }

  // GET /api/bg/stickers - 스티커 목록
  if (pathname === '/api/bg/stickers' && method === 'GET') {
    const activeOnly = query.active_only === 'true';
    return json(res, { stickers: await store.getAllStickers(activeOnly) });
  }

  // POST /api/bg/stickers - 스티커 생성
  if (pathname === '/api/bg/stickers' && method === 'POST') {
    const body = await parseBody(req);
    if (!body.name) return json(res, { error: '스티커명을 입력해주세요.' }, 400);
    const sticker = await store.createSticker(body);
    return json(res, sticker, 201);
  }

  // PUT /api/bg/stickers/:id - 스티커 수정
  const stickerUpdateMatch = pathname.match(/^\/api\/bg\/stickers\/([^/]+)$/);
  if (stickerUpdateMatch && method === 'PUT') {
    const body = await parseBody(req);
    const sticker = await store.updateSticker(stickerUpdateMatch[1], body);
    if (!sticker) return json(res, { error: '스티커를 찾을 수 없습니다.' }, 404);
    return json(res, sticker);
  }

  // DELETE /api/bg/stickers/:id - 스티커 삭제
  if (stickerUpdateMatch && method === 'DELETE') {
    await store.deleteSticker(stickerUpdateMatch[1]);
    return json(res, { success: true });
  }

  // GET /api/bg/products/settings - 전체 상품 설정 목록
  if (pathname === '/api/bg/products/settings' && method === 'GET') {
    return json(res, { settings: await store.getAllProductSettings() });
  }

  // GET /api/bg/products/sales-list - 판매 이력 있는 D01 상품 목록 (상품별 판매통계 선택기용)
  if (pathname === '/api/bg/products/sales-list' && method === 'GET') {
    try {
      const days = Math.max(1, Math.min(365, parseInt(query.days) || 180));
      const startDate = new Date(Date.now() - days * 86400000);
      const startStr = startDate.toISOString().slice(0, 10);
      const pool = await getPool();
      const r = await pool.request().input('s', sql.VarChar, startStr).query(`
        WITH card_agg AS (
          SELECT c.Card_Code AS code, MAX(c.Card_Name) AS name,
                 SUM(coi.item_count) AS qty,
                 SUM(
                   CASE WHEN si.SiteName IS NULL
                        THEN CAST(coi.item_sale_price AS float) * coi.item_count
                             / ISNULL(NULLIF(c.Unit_Value, 0), 1)
                        ELSE CAST(coi.item_sale_price AS float)
                   END
                 ) AS revenue,
                 MAX(co.order_date) AS last_sold
          FROM custom_order co WITH (NOLOCK)
          INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
          INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
          LEFT JOIN SiteInfo si WITH (NOLOCK) ON co.company_Seq = si.CompayCode
          WHERE c.Card_Div = 'D01' AND co.order_date >= @s
            AND co.status_seq >= 2 AND co.status_seq NOT IN (3, 5, 14)
          GROUP BY c.Card_Code
        ),
        etc_agg AS (
          SELECT c.Card_Code AS code, MAX(c.Card_Name) AS name,
                 SUM(ei.order_count) AS qty,
                 SUM(
                   CASE WHEN si.SiteName IS NULL
                        THEN CAST(ei.card_sale_price AS float) * ei.order_count
                             / ISNULL(NULLIF(c.Unit_Value, 0), 1)
                             - ISNULL(o.coupon_price, 0)
                        ELSE CAST(ei.card_sale_price AS float) - ISNULL(o.coupon_price, 0)
                   END
                 ) AS revenue,
                 MAX(o.order_date) AS last_sold
          FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
          INNER JOIN CUSTOM_ETC_ORDER_ITEM ei WITH (NOLOCK) ON o.order_seq = ei.order_seq
          INNER JOIN S2_Card c WITH (NOLOCK) ON ei.card_seq = c.Card_Seq
          LEFT JOIN SiteInfo si WITH (NOLOCK) ON o.company_Seq = si.CompayCode
          WHERE c.Card_Div = 'D01' AND o.order_date >= @s
            AND o.status_seq >= 2 AND o.status_seq NOT IN (3, 5, 14, 15)
          GROUP BY c.Card_Code
        )
        SELECT code, MAX(name) AS name,
               SUM(qty) AS total_qty,
               SUM(revenue) AS total_revenue,
               MAX(last_sold) AS last_sold_at
        FROM (SELECT * FROM card_agg UNION ALL SELECT * FROM etc_agg) AS u
        GROUP BY code
        ORDER BY SUM(revenue) DESC
      `);
      return json(res, r.recordset.map(row => ({
        card_code: row.code,
        card_name: (row.name || '').replace(/^\[.*?\]\s*/g, ''),
        total_qty: row.total_qty || 0,
        total_revenue: Math.round(row.total_revenue || 0),
        last_sold_at: row.last_sold_at,
      })));
    } catch (err) {
      console.error('[products/sales-list] error:', err.message);
      return json(res, { error: 'MSSQL 조회 실패: ' + err.message }, 500);
    }
  }

  // GET /api/bg/products/:productId/settings
  const productSettingsMatch = pathname.match(/^\/api\/bg\/products\/([^/]+)\/settings$/);
  if (productSettingsMatch && method === 'GET') {
    const settings = await store.getProductSettings(decodeURIComponent(productSettingsMatch[1]));
    return json(res, { settings });
  }

  // PUT /api/bg/products/:productId/settings
  if (productSettingsMatch && method === 'PUT') {
    const body = await parseBody(req);
    const settings = await store.upsertProductSettings(
      decodeURIComponent(productSettingsMatch[1]), body
    );
    return json(res, settings);
  }

  // DELETE /api/bg/products/:productId/settings
  if (productSettingsMatch && method === 'DELETE') {
    const productId = decodeURIComponent(productSettingsMatch[1]);
    await store.deleteProductSettings(productId);
    return json(res, { ok: true });
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
    const enriched = infos.map(info => ({
      ...info,
      sticker_selections: (info.sticker_selections || []).map(sel => {
        const st = stickerMap.get(sel.sticker_id);
        return {
          ...sel,
          sticker_code: st?.sticker_code || null,
          sticker_name: sel.sticker_name || st?.name || sel.sticker_id,
        };
      }),
    }));
    return json(res, { infos: enriched });
  }

  // PUT /api/bg/orders/:orderId/customer-info - 관리자 수정/추가
  const customerInfoEditMatch = pathname.match(/^\/api\/bg\/orders\/([^/]+)\/customer-info$/);
  if (customerInfoEditMatch && method === 'PUT') {
    const orderId = decodeURIComponent(customerInfoEditMatch[1]);
    try {
      const body = await parseBody(req);

      // 필수 필드 검증 — submitted_at 이 세팅되어 고객이 '입력완료' 로 인식하는
      // 상태가 되므로, 최소 핵심 필드는 반드시 있어야 함.
      if (!body.desired_ship_date) {
        return json(res, { error: '희망출고일은 필수입니다.' }, 400);
      }

      // 박스 옵션이 등록된 상품은 box_code 필수 (품절 옵션 차단)
      const sels = Array.isArray(body.sticker_selections) ? body.sticker_selections : [];
      for (const sel of sels) {
        if (!sel.product_code) continue;
        const ps = await store.getProductSettings(sel.product_code);
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
  // 알림톡 관리 API (인증 필요)
  // ============================================
  const { fetchDaeryepumRecipients, sendAlimtalkForOrder } = require('./alimtalk-orders');
  const { buildMessagePayload, buildSamplePayload, getTemplateConfig, TEMPLATE_VARIABLES } = require('./alimtalk');

  // GET /api/bg/alimtalk/recipients - 답례품 수신자 목록
  if (pathname === '/api/bg/alimtalk/recipients' && method === 'GET') {
    try {
      const pool = await getPool();
      const filters = {
        startDate: query.startDate,
        endDate: query.endDate,
        sentStatus: query.sentStatus,
        search: query.search,
        page: query.page,
        limit: query.limit,
      };
      const result = await fetchDaeryepumRecipients(pool, sql, filters);
      return json(res, result);
    } catch (err) {
      console.error('alimtalk recipients error:', err.message);
      return json(res, { error: '수신자 조회 실패: ' + err.message }, 500);
    }
  }

  // POST /api/bg/alimtalk/send - 알림톡 일괄 발송
  if (pathname === '/api/bg/alimtalk/send' && method === 'POST') {
    try {
      const body = await parseBody(req);
      const orderIds = Array.isArray(body.order_ids) ? body.order_ids : [];
      if (orderIds.length === 0) return json(res, { error: '발송할 주문을 선택해주세요.' }, 400);

      const pool = await getPool();
      const results = [];
      for (const orderId of orderIds) {
        const r = await sendAlimtalkForOrder(pool, sql, orderId);
        results.push(r);
      }

      const summary = {
        total: results.length,
        sent: results.filter(r => r.success).length,
        failed: results.filter(r => !r.success && !r.skipped_reason).length,
        skipped: results.filter(r => r.skipped_reason).length,
      };

      return json(res, { summary, results });
    } catch (err) {
      console.error('alimtalk send error:', err.message);
      return json(res, { error: '발송 실패: ' + err.message }, 500);
    }
  }

  // GET /api/bg/alimtalk/preview?orderId=... - 메시지 미리보기
  if (pathname === '/api/bg/alimtalk/preview' && method === 'GET') {
    try {
      const config = getTemplateConfig();
      let payload;

      if (query.orderId) {
        const pool = await getPool();
        const orderId = String(query.orderId);
        const isEtc = orderId.startsWith('ETC-');
        const seq = parseInt(isEtc ? orderId.slice(4) : orderId) || 0;

        if (seq) {
          const q = isEtc
            ? `SELECT TOP 1 co.order_seq, co.order_name,
                 (SELECT TOP 1 c2.Card_Name FROM CUSTOM_ETC_ORDER_ITEM ei2 WITH (NOLOCK)
                  INNER JOIN S2_Card c2 WITH (NOLOCK) ON ei2.card_seq = c2.Card_Seq
                  WHERE ei2.order_seq = co.order_seq
                    AND ${DAERYEPUM_WHERE.replace(/c\./g, 'c2.')}) AS card_name
                FROM CUSTOM_ETC_ORDER co WITH (NOLOCK) WHERE co.order_seq = @seq`
            : `SELECT TOP 1 co.order_seq, co.order_name,
                 (SELECT TOP 1 c2.Card_Name FROM custom_order_item coi2 WITH (NOLOCK)
                  INNER JOIN S2_Card c2 WITH (NOLOCK) ON coi2.card_seq = c2.Card_Seq
                  WHERE coi2.order_seq = co.order_seq
                    AND ${DAERYEPUM_WHERE.replace(/c\./g, 'c2.')}) AS card_name
                FROM custom_order co WITH (NOLOCK) WHERE co.order_seq = @seq`;
          const result = await pool.request().input('seq', sql.Int, seq).query(q);
          const row = result.recordset[0];
          if (row) {
            payload = buildMessagePayload({
              orderId,
              orderNumber: (isEtc ? 'BHS-' : 'BRS-') + row.order_seq,
              customerName: row.order_name,
              productName: row.card_name || '답례품',
            });
          }
        }
      }

      if (!payload) payload = buildSamplePayload();

      return json(res, {
        payload,
        template: {
          templateCode: config.templateCode,
          body: config.body,
          button: config.button,
        },
        variables: TEMPLATE_VARIABLES,
      });
    } catch (err) {
      console.error('alimtalk preview error:', err.message);
      return json(res, { error: '미리보기 실패: ' + err.message }, 500);
    }
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
  const { phone, uname, useLike, maskCustomerName } = opts;

  // 바른손카드 (custom_order) 조회
  const cardRequest = pool.request();
  cardRequest.input('phone', sql.VarChar, phone);
  cardRequest.input('uname', sql.VarChar, uname);
  // 정규화 정책 (양쪽 일관 적용):
  //   - phone: order_hphone 의 '-' 와 ' ' 모두 제거 후 비교 (저장 형식 차이 흡수)
  //   - name : 양 끝 공백 + 중간 공백 모두 제거 후 비교 ('김 혜린' = '김혜린')
  // ⚠️ 보안: phone AND name 둘 다 일치해야 함 (OR 조건은 동명이인 주문 노출 버그).
  //   - useLike=true (로그인): phone 은 LIKE '%' 매칭 (마지막 N자리 일치)
  //   - useLike=false (수동검색): phone 은 정확 매칭
  const NORM_PHONE = "REPLACE(REPLACE(co.order_hphone, '-', ''), ' ', '')";
  const NORM_DB_NAME = "REPLACE(LTRIM(RTRIM(co.order_name)), ' ', '')";
  const NORM_PARAM_NAME = "REPLACE(LTRIM(RTRIM(@uname)), ' ', '')";
  const cardWhere = useLike
    ? `AND ${NORM_PHONE} LIKE '%' + @phone AND ${NORM_DB_NAME} = ${NORM_PARAM_NAME}`
    : `AND ${NORM_PHONE} = @phone AND ${NORM_DB_NAME} = ${NORM_PARAM_NAME}`;
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
  // ⚠️ 보안: phone AND name 둘 다 일치해야 함 (cardWhere 와 동일 정책).
  // 정규화 정책도 cardWhere 와 동일 (NORM_PHONE / NORM_DB_NAME / NORM_PARAM_NAME 재사용).
  const etcWhere = useLike
    ? `AND ${NORM_PHONE} LIKE '%' + @phone AND ${NORM_DB_NAME} = ${NORM_PARAM_NAME}`
    : `AND ${NORM_PHONE} = @phone AND ${NORM_DB_NAME} = ${NORM_PARAM_NAME}`;
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
