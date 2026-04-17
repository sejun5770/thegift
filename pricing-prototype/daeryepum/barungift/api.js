/**
 * 바른기프트 API 라우트 핸들러
 */
const url = require('url');
const store = require('./store');

// 답례품/꽃다발 식별 조건 (청첩장 제외)
const DAERYEPUM_CARDKIND_SEQS = [4, 5, 16]; // 카드형답례장, 한지형답례장, 결혼답례카드
const DAERYEPUM_CARD_CODES = [
  'TGJSD03O2','TGIBK01D1','TGOSL006D1','TGOSL003D1','OSL002','TGAMT01O1',
  'TGJSD05D1','TGJSD08D1','TGJSD01','OSL005','TGJSD02D1','TGJBK05D1',
  'TGJBK02D1','TGJBK03D1','TGJSD06D1','TGJSD04D1','TGJSD07D1','TGJSD03O3',
  'TGJBK04D1','TGJSD03O1','TGJBK01D1','TGIKX01',
];

// 답례품 필터 SQL 조건 (custom_order_item + S2_Card + S2_CardKind JOIN 후 사용)
const DAERYEPUM_WHERE = `
  (ck.CardKind_Seq IN (${DAERYEPUM_CARDKIND_SEQS.join(',')})
   OR c.Card_Code IN (${DAERYEPUM_CARD_CODES.map(c => "'" + c + "'").join(',')}))
`;

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
    try {
      const body = await parseBody(req);
      const { uid, password } = body;
      if (!uid || !password) {
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
        return json(res, { error: '아이디 또는 비밀번호가 올바르지 않습니다.' }, 401);
      }

      const user = result.recordset[0];
      const phone = (user.hand_phone1 || '') + (user.hand_phone2 || '') + (user.hand_phone3 || '');

      // 로그인 성공 → 해당 회원의 답례품/꽃다발 주문만 조회
      const ordersResult = await pool.request()
        .input('phone', sql.VarChar, phone.slice(-8))
        .input('uname', sql.VarChar, user.uname)
        .query(`
          SELECT DISTINCT TOP 20
            co.order_seq, co.order_date, co.order_name, co.order_hphone,
            co.order_total_price, co.last_total_price, co.status_seq,
            (SELECT TOP 1 c2.Card_Name FROM custom_order_item coi2 WITH (NOLOCK)
             INNER JOIN S2_Card c2 WITH (NOLOCK) ON coi2.card_seq = c2.Card_Seq
             LEFT JOIN S2_CardKind ck2 WITH (NOLOCK) ON c2.Card_Seq = ck2.Card_Seq AND ck2.CardKind_Seq IN (${DAERYEPUM_CARDKIND_SEQS.join(',')})
             WHERE coi2.order_seq = co.order_seq
               AND ${DAERYEPUM_WHERE.replace(/ck\./g, 'ck2.').replace(/c\./g, 'c2.')}
            ) AS card_name
          FROM custom_order co WITH (NOLOCK)
          INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
          INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
          LEFT JOIN S2_CardKind ck WITH (NOLOCK) ON c.Card_Seq = ck.Card_Seq AND ck.CardKind_Seq IN (${DAERYEPUM_CARDKIND_SEQS.join(',')})
          WHERE co.status_seq >= 1
            AND co.order_date >= DATEADD(month, -6, GETDATE())
            AND (co.order_hphone LIKE '%' + @phone OR co.order_name = @uname)
            AND ${DAERYEPUM_WHERE}
          ORDER BY co.order_date DESC
        `);

      // 배치 조회로 N+1 쿼리 방지
      const orderSeqs = ordersResult.recordset.map(r => String(r.order_seq));
      const customerInfos = await store.getCustomerInfoBatch(orderSeqs);
      const infoMap = new Map(customerInfos.map(i => [i.order_id, i]));

      const orders = ordersResult.recordset.map(r => {
        const existing = infoMap.get(String(r.order_seq));
        return {
          order_id: String(r.order_seq),
          order_number: 'BRS-' + r.order_seq,
          customer_name: r.order_name || '',
          phone_last4: (r.order_hphone || '').replace(/\D/g, '').slice(-4),
          order_date: r.order_date,
          total_amount: r.last_total_price || r.order_total_price || 0,
          product_name: r.card_name || '답례품',
          info_status: existing?.submitted_at ? 'completed' : 'pending',
          status_seq: r.status_seq,
        };
      });

      return json(res, {
        success: true,
        user: { uid: user.uid, name: user.uname, phone_last4: phone.slice(-4) },
        orders,
      });
    } catch (err) {
      console.error('barungift auth error:', err.message);
      return json(res, { error: '로그인 처리 중 오류가 발생했습니다.' }, 500);
    }
  }

  // GET /api/bg/orders/search?phone=xxx&name=xxx - 고객 주문 검색 (AND 조건)
  if (pathname === '/api/bg/orders/search' && method === 'GET') {
    const phone = (query.phone || '').replace(/\D/g, '');
    const name = (query.name || '').trim();
    if (!phone || !name) {
      return json(res, { error: '전화번호와 주문자명을 모두 입력해주세요.' }, 400);
    }
    try {
      const pool = await getPool();
      const request = pool.request();
      request.input('phone', sql.VarChar, phone); // 숫자만 (예: 01054477835)
      request.input('name', sql.VarChar, name);
      const whereClause = "AND REPLACE(co.order_hphone, '-', '') = @phone AND co.order_name = @name";
      const result = await request.query(`
        SELECT DISTINCT TOP 20
          co.order_seq, co.order_date, co.order_name, co.order_hphone,
          co.order_total_price, co.last_total_price, co.status_seq,
          (SELECT TOP 1 c2.Card_Name FROM custom_order_item coi2 WITH (NOLOCK)
           INNER JOIN S2_Card c2 WITH (NOLOCK) ON coi2.card_seq = c2.Card_Seq
           LEFT JOIN S2_CardKind ck2 WITH (NOLOCK) ON c2.Card_Seq = ck2.Card_Seq AND ck2.CardKind_Seq IN (${DAERYEPUM_CARDKIND_SEQS.join(',')})
           WHERE coi2.order_seq = co.order_seq
             AND ${DAERYEPUM_WHERE.replace(/ck\./g, 'ck2.').replace(/c\./g, 'c2.')}
          ) AS card_name
        FROM custom_order co WITH (NOLOCK)
        INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
        INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
        LEFT JOIN S2_CardKind ck WITH (NOLOCK) ON c.Card_Seq = ck.Card_Seq AND ck.CardKind_Seq IN (${DAERYEPUM_CARDKIND_SEQS.join(',')})
        WHERE co.status_seq >= 1
          AND co.order_date >= DATEADD(month, -6, GETDATE())
          AND ${DAERYEPUM_WHERE}
          ${whereClause}
        ORDER BY co.order_date DESC
      `);

      // 배치 조회로 N+1 쿼리 방지
      const orderSeqs = result.recordset.map(r => String(r.order_seq));
      const customerInfos = await store.getCustomerInfoBatch(orderSeqs);
      const infoMap = new Map(customerInfos.map(i => [i.order_id, i]));

      const orders = result.recordset.map(r => {
        const existing = infoMap.get(String(r.order_seq));
        return {
          order_id: String(r.order_seq),
          order_number: 'BRS-' + r.order_seq,
          customer_name: maskName(r.order_name || ''),
          phone_last4: (r.order_hphone || '').replace(/\D/g, '').slice(-4),
          order_date: r.order_date,
          total_amount: r.last_total_price || r.order_total_price || 0,
          product_name: r.card_name || '답례품',
          info_status: existing?.submitted_at ? 'completed' : 'pending',
          status_seq: r.status_seq,
        };
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
    try {
      const pool = await getPool();
      // barunson DB에서 주문 조회 (답례품/꽃다발 아이템만)
      const result = await pool.request()
        .input('orderSeq', sql.Int, parseInt(orderId) || 0)
        .query(`
          SELECT
            co.order_seq, co.order_date, co.order_total_price, co.last_total_price,
            co.order_name, co.order_hphone, co.status_seq,
            coi.id AS item_id, coi.item_count, coi.item_price, coi.item_sale_price,
            c.Card_Code, c.Card_Name, c.Card_Price,
            di.NAME AS delivery_name, di.HPHONE AS delivery_hphone, di.ADDR AS delivery_addr
          FROM custom_order co WITH (NOLOCK)
          INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
          INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
          LEFT JOIN S2_CardKind ck WITH (NOLOCK) ON c.Card_Seq = ck.Card_Seq AND ck.CardKind_Seq IN (${DAERYEPUM_CARDKIND_SEQS.join(',')})
          LEFT JOIN DELIVERY_INFO di WITH (NOLOCK) ON co.order_seq = di.ORDER_SEQ
          WHERE co.order_seq = @orderSeq
            AND ${DAERYEPUM_WHERE}
        `);

      if (!result.recordset.length) {
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

      // 모든 상품의 매핑된 스티커 합집합 계산
      const allMappedStickerIds = new Set();
      for (const p of products) {
        if (!p.product_code) continue;
        const ps = await store.getProductSettings(p.product_code);
        (ps?.available_sticker_ids || []).forEach(id => allMappedStickerIds.add(id));
      }
      const availableStickers = allMappedStickerIds.size > 0
        ? allActiveStickers.filter(s => allMappedStickerIds.has(s.id))
        : allActiveStickers;

      return json(res, {
        order_id: String(row.order_seq),
        order_number: `BRS-${row.order_seq}`,
        customer_name: maskName(row.order_name || row.delivery_name || ''),
        order_date: row.order_date,
        total_amount: row.last_total_price || row.order_total_price || 0,
        status: row.status_seq >= 1 ? 'collected' : 'cancelled',
        info_status: existingInfo?.submitted_at ? 'completed' : 'pending',
        products,
        product_settings: productSettings,
        shipping_config: store.getShippingConfig(),
        available_stickers: availableStickers,
        existing_info: existingInfo,
        bank_info: {
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
    try {
      const body = await parseBody(req);

      // 유효성 기본 체크
      if (!body.desired_ship_date) {
        return json(res, { error: '희망출고일을 선택해주세요.' }, 400);
      }

      const saved = await store.saveCustomerInfo(orderId, body);
      return json(res, saved, 201);
    } catch (err) {
      if (err.message === 'ALREADY_SUBMITTED') {
        return json(res, { error: '이미 정보 입력이 완료된 주문입니다.' }, 409);
      }
      console.error('barungift customer-info error:', err.message);
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

  // GET /api/bg/customer-infos - 전체 고객 입력 목록 (관리자)
  if (pathname === '/api/bg/customer-infos' && method === 'GET') {
    return json(res, { infos: await store.getAllCustomerInfos() });
  }

  // GET /api/bg/shipping-config - 공통 출고일 설정 조회
  if (pathname === '/api/bg/shipping-config' && method === 'GET') {
    return json(res, { config: store.getShippingConfig() });
  }

  // PUT /api/bg/shipping-config - 공통 출고일 설정 저장
  if (pathname === '/api/bg/shipping-config' && method === 'PUT') {
    const body = await parseBody(req);
    const config = store.saveShippingConfig(body);
    return json(res, config);
  }

  return false; // 미처리 → 다른 핸들러로
}

function maskName(name) {
  if (!name || name.length <= 1) return name;
  if (name.length === 2) return name[0] + '*';
  return name[0] + '*'.repeat(name.length - 2) + name[name.length - 1];
}

module.exports = { handleBarungiftApi };
