/**
 * 바른기프트 API 라우트 핸들러
 */
const url = require('url');
const store = require('./store');
const { logAccess, getRecentLogs } = require('./audit-log');
const { check: rlCheck, rateLimitResponse, LIMITS: RL_LIMITS } = require('./rate-limit');
const signedUrl = require('./signed-url');
const stockAlert = require('./stock-alert');

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

  // GET /api/bg/orders/delivery-status?ids=a,b,c — 주문선택 목록용 배송상태 (고객용, 경량)
  //   목록 화면에서 주문마다 배송 배지를 붙인다. 이 화면은 이름+전화 검색으로도 들어오므로
  //   송장번호는 내려보내지 않는다 — 상태 문구와 완료 여부만.
  if (pathname === '/api/bg/orders/delivery-status' && method === 'GET') {
    const rl = rlCheck(req, 'view', RL_LIMITS.view);
    if (!rl.allowed) return rateLimitResponse(res, rl);
    const ids = String(query.ids || '').split(',').map(x => x.trim()).filter(Boolean).slice(0, 10);
    if (!ids.length) return json(res, { statuses: {} });
    const cj = require('./cj-tracking');
    const statuses = {};
    for (const oid of ids) {
      try {
        let invs = [];
        try {
          invs = ((await require('./workflow-store').listInvoices(oid)) || [])
            .map(iv => String(iv.invoice_number || '').replace(/\D/g, '')).filter(Boolean);
        } catch { /* bg_order_invoices 미존재 */ }
        if (!invs.length) invs = (await cj.sheetInvoicesForOrder(oid)).map(x => x.invoice);
        if (!invs.length) continue;   // 송장 없음 = 출고 전 — 배지 없음
        const t = await cj.trackCj(invs[0]).catch(() => null);
        statuses[oid] = t
          ? { registered: t.registered, delivered: t.delivered, status: t.registered ? t.status : '출고 준비' }
          : { registered: false, delivered: false, status: '출고 준비' };
      } catch { /* 개별 실패는 배지 생략 */ }
    }
    return json(res, { statuses });
  }

  // GET /api/bg/orders/:orderId/delivery — 배송조회 (고객용, 2026-08-28)
  //   송장은 ① bg_order_invoices(있으면) ② 운영 구글시트(문자안내 기능과 같은 소스)에서 찾고,
  //   CJ대한통운 공개 조회 JSON 으로 상태를 가져온다. 접근 제어는 주문 상세와 동일 (HMAC).
  const deliveryMatch = pathname.match(/^\/api\/bg\/orders\/([^/]+)\/delivery$/);
  if (deliveryMatch && method === 'GET') {
    const orderId = decodeURIComponent(deliveryMatch[1]);
    const rl = rlCheck(req, 'view', RL_LIMITS.view);
    if (!rl.allowed) {
      logAccess(req, 'rate_limited', orderId, { status_code: 429, metadata: { action: 'delivery', retry_after: rl.retryAfterSec } });
      return rateLimitResponse(res, rl);
    }
    if (query.t || query.sig || signedUrl.STRICT) {
      const sigCheck = signedUrl.verify(orderId, query.t, query.sig);
      if (!sigCheck.valid && signedUrl.STRICT) {
        return json(res, { error: '유효한 접근 링크가 아닙니다. 발송된 링크로 다시 접속해주세요.' }, 403);
      }
    }
    try {
      const cj = require('./cj-tracking');
      const found = [];
      // ① 출고처리 모달 송장 — 테이블(migration 017)이 없는 환경이 있어 실패는 조용히 넘어간다
      try {
        const invs = await require('./workflow-store').listInvoices(orderId);
        for (const iv of (invs || [])) {
          if (iv.invoice_number) {
            found.push({ invoice_no: String(iv.invoice_number).replace(/\D/g, ''),
              ship_date: iv.shipped_at ? String(iv.shipped_at).slice(0, 10) : null,
              delivery_company: iv.delivery_company || 'CJ대한통운', source: 'db' });
          }
        }
      } catch { /* bg_order_invoices 미존재 — 시트로 */ }
      // ② 운영 시트 (커스텀·월별)
      if (!found.length) {
        for (const s of await cj.sheetInvoicesForOrder(orderId)) {
          found.push({ invoice_no: s.invoice, ship_date: s.ship_date || null,
            delivery_company: 'CJ대한통운', source: 'sheet' });
        }
      }
      // CJ 조회 — 최대 2건 (나눔배송). CJ 가 아닌 택배사는 상태 조회 없이 송장만 안내.
      for (const f of found.slice(0, 2)) {
        if (!/CJ|대한통운/i.test(f.delivery_company)) { f.tracking = null; continue; }
        try { f.tracking = await cj.trackCj(f.invoice_no); }
        catch (e) { f.tracking = null; f.tracking_error = String(e.message).slice(0, 120); }
      }
      return json(res, { order_id: orderId, found: found.length > 0, invoices: found.slice(0, 2) });
    } catch (err) {
      console.error('[delivery] 조회 실패:', err.message);
      return json(res, { error: '배송 정보를 불러오지 못했습니다.' }, 500);
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
              ei.card_seq AS card_seq, -- 부모 식별용 (옵션의 card_opt 가 이 값을 가리킨다)
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
          _card_seq: r.card_seq != null ? String(r.card_seq) : null,  // 아래 사은품 연결용 (응답 전 제거)
          addons: [],
        });
      }
      // 무료 사은품(추석 미니엽서 등) — 몰 프론트에서 고른 0원 옵션 라인을 부모 상품에 붙인다.
      //   고객은 여기서 바꿀 수 없고 무엇을 골랐는지 확인만 한다.
      //   유료 옵션(수건·핸드워시 등 세트 구성품)은 상품 자체의 구성이라 여기 넣지 않는다.
      {
        const byCardSeq = new Map();
        for (const p of products) if (p._card_seq) byCardSeq.set(p._card_seq, p);
        for (const r of result.recordset) {
          if (r.card_opt == null) continue;
          if ((Number(r.item_sale_price) || 0) !== 0) continue;   // 유료 = 구성품
          const parent = byCardSeq.get(String(r.card_opt)) || products[0];
          if (!parent) continue;
          if (parent.addons.some(a => a.code === r.Card_Code)) continue;
          parent.addons.push({
            code: r.Card_Code || '',
            name: r.Card_Name || r.Card_Code || '',
            quantity: r.item_count || 0,
          });
        }
        for (const p of products) delete p._card_seq;
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
      // 공유 자유 옵션 그룹 (078) — 한 번 등록해 여러 상품에 붙이는 그룹 (기획전 미니카드 등).
      //   상품별 custom_options 와 여기서 합쳐 내려주므로 고객 화면은 둘을 구분하지 않는다.
      //   조회 실패해도 주문 화면은 떠야 한다 — 공유 그룹만 빠진다.
      let allSharedGroups = [];      // 활성 그룹 전체 — 사은품 썸네일 사전으로도 쓴다
      let sharedOptionGroups = [];   // 그중 적용 상품이 지정된 것만 — 고객이 고르는 옵션
      try {
        const site = await store.getSiteSettings();
        allSharedGroups = (store.normSharedOptionGroups(site?.shared_option_groups) || [])
          .filter(g => g.is_active && g.options.length);
        sharedOptionGroups = allSharedGroups.filter(g => g.product_codes.length);
      } catch (e) {
        console.warn('[order-info] 공유 옵션 그룹 로드 실패 (상품별 옵션만 적용):', e.message);
      }
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
        // 공유 그룹 병합 (078) — 이 상품이 적용 대상인 그룹만.
        //   같은 그룹명이 상품별 설정에도 있으면 상품별을 남긴다 (개별 예외가 공유를 이긴다).
        //   ERP 변형 코드(TGJSD04D1_A)로 들어와도 붙도록 BASE 코드까지 함께 본다.
        const pcBase = stripVariantSuffix(p.product_code) || p.product_code;
        for (const g of sharedOptionGroups) {
          if (normalizedCustom[g.name]) continue;
          const hit = g.product_codes.some(c =>
            c === p.product_code || c === pcBase || (stripVariantSuffix(c) || c) === pcBase);
          if (!hit) continue;
          normalizedCustom[g.name] = {
            use_images: g.use_images,
            options: g.options.filter(o => o.code),
          };
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
        // 사은품 썸네일 사전 — products[].addons 의 코드로 이름·이미지를 찾는다 (읽기 전용 표시용).
        //   공유 옵션 그룹에 등록해 둔 이미지를 재사용한다 (선택은 몰 프론트에서 이미 끝났다).
        addon_catalog: Object.fromEntries(allSharedGroups.flatMap(g =>
          g.options.map(o => [o.code, { name: o.name, preview_image_url: o.preview_image_url || '' }]))),
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
      // BASE 코드 추출 (TGJSD01O4_A → TGJSD01O4) — 변형 접미사 '단일 영문자'만 제거.
      //   영숫자 전체를 떼면 데코(2026_acryl_08 → 2026_acryl) / 위탁(COM_A01003 → COM) 처럼
      //   서로 다른 상품이 한 줄로 뭉친다. (2026-07-29 수정 — server.js toBase 와 동일 정책)
      const baseCodeExpr = (col) => `CASE
        WHEN CHARINDEX('_', REVERSE(${col})) = 2
          AND RIGHT(${col}, 1) NOT LIKE '%[^A-Za-z]%'
        THEN LEFT(${col}, LEN(${col}) - 2)
        ELSE ${col}
      END`;
      const pool = await getPool();
      const r = await pool.request().input('s', sql.VarChar, startStr).query(`
        WITH card_agg AS (
          SELECT c.Card_Code AS code, MAX(c.Card_Name) AS name,
                 SUM(coi.item_count) AS qty,
                 -- custom_order.item_sale_price 는 '단가' → 항상 수량 곱.
                 --   (라인합계인 CUSTOM_ETC_ORDER.card_sale_price 식을 옮겨와 자사 주문이
                 --    수량만큼 과소집계되던 버그. 2026-07-29 수정)
                 SUM(CAST(coi.item_sale_price AS float) * coi.item_count / ${cardUnitDivisor}) AS revenue,
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
      const items = r.recordset.map(row => ({
        card_code: row.code, // BASE 코드 (변형 통합)
        card_name: (row.name || '').replace(/^\[.*?\]\s*/g, ''),
        total_qty: row.total_qty || 0,
        total_revenue: Math.round(row.total_revenue || 0),
        last_sold_at: row.last_sold_at,
        variant_count: row.variant_count || 1, // 통합된 변형(_A/_B/_C) 개수
      }));

      // ── 마켓(쿠팡/네이버/정수당) + 더기프트 병합 — 답례품 카테고리 한정 ──────
      //   매출 그룹 멤버가 마켓 상품코드(쿠팡 등록상품ID / 네이버·정수당은 자사코드)로
      //   등록돼 있어 product_code 기준으로 합치면 그룹 병합이 그대로 성립한다.
      if (!query.category || query.category === 'daeryepum') {
        const CANCELLED = new Set(['CANCELED', 'RETURNED', 'EXCHANGED', 'CANCEL', 'RETURNS',
          'C00', 'C10', 'C11', 'R00', 'R10', 'E00', 'E10']);
        const byCode = new Map(items.map(i => [String(i.card_code).toLowerCase(), i]));
        const addRow = (code, name, qty, revenue, soldAt) => {
          const key = String(code || '').trim().toLowerCase();
          if (!key) return;
          let it = byCode.get(key);
          if (!it) {
            it = { card_code: String(code).trim(), card_name: name || String(code), total_qty: 0, total_revenue: 0, last_sold_at: null, variant_count: 1 };
            byCode.set(key, it); items.push(it);
          }
          it.total_qty += Number(qty) || 0;
          it.total_revenue += Math.round(Number(revenue) || 0);
          if (soldAt && (!it.last_sold_at || String(soldAt) > String(it.last_sold_at))) it.last_sold_at = soldAt;
        };
        const endPlus = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
        // 답례품 아님으로 지정된 마켓 품목 제외 (migration 042)
        let excl = [];
        try { excl = await store.listSalesExclusions(); } catch { /* 테이블 없으면 미적용 */ }
        const exclSet = new Set((excl || []).map(m => `${String(m.site_name || '').trim()}|${m.match_type}|${String(m.match_value || '').trim().toLowerCase()}`));
        const isExcluded = (site, code, name) => {
          if (!exclSet.size) return false;
          const s = String(site || '').trim();
          const c = String(code || '').trim().toLowerCase();
          const n = String(name || '').trim().toLowerCase();
          return (c && (exclSet.has(`${s}|code|${c}`) || exclSet.has(`|code|${c}`)))
            || (n && (exclSet.has(`${s}|name|${n}`) || exclSet.has(`|name|${n}`)));
        };
        const mergeMarket = async (loader, site) => {
          try {
            for (const row of (await loader()) || []) {
              if (row.status && CANCELLED.has(String(row.status).toUpperCase())) continue;
              if (isExcluded(site, row.product_code, row.product_name)) continue;
              addRow(row.product_code, row.product_name, row.item_count, row.item_total_price, row.ordered_at);
            }
          } catch (e) { console.warn('[products/sales-list] 마켓 병합 실패 (무시):', e.message); }
        };
        await mergeMarket(() => require('../coupang/store').listCoupangOrders({ startStr, endStr: endPlus, byPaid: false, excludeRocketGrowth: true }), '쿠팡');
        await mergeMarket(() => require('../naver/store').listNaverOrders({ startStr, endStr: endPlus, byPaid: false }), '네이버');
        await mergeMarket(() => require('../cafe24/store').listCafe24Orders({ startStr, endStr: endPlus, byPaid: false }), '정수당');
        // 더기프트 수동 등록 (bg_manual_orders)
        try {
          const mos = await store.listManualOrders({ category: 'daeryepum', startDate: startStr, endDate: endPlus });
          for (const mo of (mos || [])) {
            const st = Number(mo.status_seq) || 0;
            if (!(st >= 2 && ![3, 5, 15].includes(st))) continue;
            for (const it of (Array.isArray(mo.items) ? mo.items : [])) {
              const q = Number(it.quantity) || 0;
              addRow(it.product_code, it.product_name, q, Number(it.item_amount) || (Number(it.unit_price) || 0) * q, mo.order_date);
            }
          }
        } catch (e) { console.warn('[products/sales-list] 더기프트 병합 실패 (무시):', e.message); }
        items.sort((a, b) => (b.total_revenue || 0) - (a.total_revenue || 0));
      }
      return json(res, items);
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
  // 답례품 매출 제외 목록 (migration 042)
  //   마켓의 비-답례품(자개카드·탈취제·아크릴액자 등)을 매출 집계에서 제외.
  // ============================================
  if (pathname === '/api/bg/sales-exclusions' && method === 'GET') {
    try {
      return json(res, { exclusions: await store.listSalesExclusions() });
    } catch (err) {
      console.error('[sales-exclusions GET] error:', err.message);
      return json(res, { error: err.message }, 500);
    }
  }
  if (pathname === '/api/bg/sales-exclusions' && method === 'POST') {
    try {
      const body = await parseBody(req);
      const added = await store.addSalesExclusions(body.items || [], session?.email || null, body.reason || null);
      return json(res, { items: added }, 201);
    } catch (err) {
      console.error('[sales-exclusions POST] error:', err.message);
      return json(res, { error: err.message }, 400);
    }
  }
  const salesExclDelMatch = pathname.match(/^\/api\/bg\/sales-exclusions\/([^/]+)$/);
  if (salesExclDelMatch && method === 'DELETE') {
    try {
      return json(res, await store.removeSalesExclusion(decodeURIComponent(salesExclDelMatch[1])));
    } catch (err) {
      console.error('[sales-exclusions DELETE] error:', err.message);
      return json(res, { error: err.message }, 400);
    }
  }

  // ============================================
  // 재고 데일리 슬랙 알림 (migration 043)
  //   대상 품목 CRUD + 미리보기/수동 발송.
  // ============================================
  if (pathname === '/api/bg/stock-alerts' && method === 'GET') {
    try {
      const cfg = await stockAlert.loadAlertConfig().catch(() => null);
      return json(res, {
        alerts: await store.listStockItems(),
        slack_configured: stockAlert.slackConfigured(),
        schedule: cfg?.enabled ? `매일 ${cfg.time} KST` : null,
        alert_config: cfg && {
          channel: cfg.channel, time: cfg.time, enabled: cfg.enabled, from_db: cfg.from_db,
        },
      });
    } catch (err) {
      console.error('[stock-items GET] error:', err.message);
      return json(res, { error: err.message }, 500);
    }
  }
  if (pathname === '/api/bg/stock-alerts' && method === 'POST') {
    try {
      const body = await parseBody(req);
      const added = await store.addStockItems(body.items || [], session?.email || null);
      return json(res, { items: added }, 201);
    } catch (err) {
      console.error('[stock-items POST] error:', err.message);
      return json(res, { error: err.message }, 400);
    }
  }
  // POST /api/bg/stock-alerts/send  { dry_run?: true, channel?: 'C…', codes?: ['TGJBK03O1'] }
  //   dry_run 이면 메시지만 만들어 돌려주고 슬랙에는 보내지 않는다.
  //   codes 를 주면 그 품목만 보내는 개별 발송 (데일리 알림 대상이 아니어도 발송).
  if (pathname === '/api/bg/stock-alerts/send' && method === 'POST') {
    try {
      const body = await parseBody(req);
      const base = `http://localhost:${process.env.PORT || '3457'}${process.env.BASE_PATH || ''}`;
      const codes = Array.isArray(body.codes) ? body.codes
        : (body.code ? [body.code] : null);
      const out = await stockAlert.sendStockAlert(base, {
        dryRun: !!body.dry_run,
        channel: body.channel || null,
        codes,
      });
      return json(res, out);
    } catch (err) {
      console.error('[stock-alerts send] error:', err.message);
      return json(res, { error: err.message }, 400);
    }
  }
  // 알림 설정 (채널/시각/사용여부) 저장 — bg_site_settings, migration 049
  if (pathname === '/api/bg/stock-alerts/config' && method === 'PUT') {
    try {
      const body = await parseBody(req);
      const patch = {};
      if ('channel' in body) patch.stock_alert_channel = String(body.channel || '').trim() || null;
      if ('time' in body) {
        const t = String(body.time || '').trim();
        if (t && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(t)) {
          return json(res, { error: '발송 시각은 HH:MM 형식이어야 합니다 (예: 09:00)' }, 400);
        }
        patch.stock_alert_time = t || null;
      }
      if ('enabled' in body) patch.stock_alert_enabled = body.enabled == null ? null : !!body.enabled;
      // 구분별 경고 기준일 (073) — 값 검증은 store 가 한다 (ITEM_KINDS 키, 1~365)
      if ('warn_days' in body) patch.stock_alert_warn_days = body.warn_days;
      // 메시지 구성 (074) — 값 검증은 store.normAlertFormat 이 한다
      if ('format' in body) patch.stock_alert_format = body.format;
      const saved = await store.updateSiteSettings(patch, session?.email || null);
      stockAlert.invalidateAlertConfig();
      // 마이그레이션 전 컬럼이 빠졌으면 사유를 화면까지 올린다 — 조용히 유실되면 안 된다
      return json(res, { ok: true, warning: saved?._warning || null, config: await stockAlert.loadAlertConfig() });
    } catch (err) {
      console.error('[stock-alerts config] error:', err.message);
      return json(res, { error: err.message }, 400);
    }
  }

  const stockAlertIdMatch = pathname.match(/^\/api\/bg\/stock-alerts\/([^/]+)$/);
  if (stockAlertIdMatch && method === 'PATCH') {
    try {
      const body = await parseBody(req);
      const row = await store.updateStockItem(decodeURIComponent(stockAlertIdMatch[1]), body);
      return json(res, row || { error: 'not found' }, row ? 200 : 404);
    } catch (err) {
      console.error('[stock-items PATCH] error:', err.message);
      return json(res, { error: err.message }, 400);
    }
  }
  if (stockAlertIdMatch && method === 'DELETE') {
    try {
      return json(res, await store.removeStockItem(decodeURIComponent(stockAlertIdMatch[1])));
    } catch (err) {
      console.error('[stock-items DELETE] error:', err.message);
      return json(res, { error: err.message }, 400);
    }
  }

  // ============================================
  // 사고건 (migration 051) — 운영사고 / 기타출고
  //   기타출고는 실제 출고 품목·수량을 담아 물류·재무가 매출을 잡을 수 있게 한다.
  //   등록/삭제 시 customer_info 의 is_special_shipping 플래그를 함께 맞춰
  //   전체 탭의 🚨 강조·기타출고 필터가 계속 동작하도록 한다 (파생값).
  // ============================================
  async function _syncSpecialShippingFlag(orderId) {
    try {
      const rows = await store.listIncidents({ orderId });
      const has = (rows || []).length > 0;
      const top = (rows || [])[0] || null;
      // ci 행이 없는 주문(미입력)은 표시할 대상이 없으므로 건너뛴다.
      if (!(await store.getCustomerInfo(orderId))) return;
      await store.updateCustomerInfo(orderId, {
        is_special_shipping: has,
        special_shipping_reason: has ? top.incident_type : null,
        special_shipping_memo: has ? (top.reason || null) : null,
      });
    } catch (e) {
      // 플래그는 표시용이라 실패해도 사고건 자체는 유지한다.
      console.warn('[incidents] is_special_shipping 동기화 실패 (무시):', e.message);
    }
  }

  if (pathname === '/api/bg/incidents' && method === 'GET') {
    try {
      return json(res, {
        incidents: await store.listIncidents({
          category: query.category || 'daeryepum',
          orderId: query.order_id || null,
        }),
      });
    } catch (err) {
      console.error('[incidents GET] error:', err.message);
      return json(res, { error: err.message }, 500);
    }
  }
  if (pathname === '/api/bg/incidents' && method === 'POST') {
    try {
      const body = await parseBody(req);
      const row = await store.createIncident(body, session?.email || null);
      await _syncSpecialShippingFlag(row.order_id);
      return json(res, row, 201);
    } catch (err) {
      console.error('[incidents POST] error:', err.message);
      return json(res, { error: err.message }, 400);
    }
  }
  const incidentIdMatch = pathname.match(/^\/api\/bg\/incidents\/([^/]+)$/);
  if (incidentIdMatch && method === 'PATCH') {
    try {
      const body = await parseBody(req);
      const row = await store.updateIncident(decodeURIComponent(incidentIdMatch[1]), body);
      if (row) await _syncSpecialShippingFlag(row.order_id);
      return json(res, row || { error: 'not found' }, row ? 200 : 404);
    } catch (err) {
      console.error('[incidents PATCH] error:', err.message);
      return json(res, { error: err.message }, 400);
    }
  }
  if (incidentIdMatch && method === 'DELETE') {
    try {
      const id = decodeURIComponent(incidentIdMatch[1]);
      const cur = await store.getIncident(id);
      const out = await store.deleteIncident(id);
      if (cur) await _syncSpecialShippingFlag(cur.order_id);
      return json(res, out);
    } catch (err) {
      console.error('[incidents DELETE] error:', err.message);
      return json(res, { error: err.message }, 400);
    }
  }

  // ============================================
  // BOM (migration 048 → 050 재구성) — 판매상품 1개의 구성품 목록
  // ============================================
  // 코드 검증 — parent 는 판매코드(S2_Card.Card_Code).
  //   구성품은 재고관리 대상이 아니어도 되므로(부자재/포장재) "재고코드로 존재하는가" 는
  //   오류가 아니라 정보로만 표시한다. 대신 이름을 함께 내려 화면에서 확인할 수 있게 한다.
  async function annotateBomRows(rows) {
    const safe = c => String(c || '').trim().replace(/[^A-Za-z0-9_\-.]/g, '');
    const codes = [...new Set(rows.flatMap(r => [safe(r.parent_code), safe(r.component_code)]).filter(Boolean))];
    if (!codes.length) return rows.map(r => ({ ...r, parent_ok: false, component_in_erp: false }));
    // 재고관리 품목으로 등록돼 있는지 (= 소진 계산에 실제 반영되는지)
    let registered = new Set();
    try {
      registered = new Set((await store.listStockItems())
        .map(i => String(i.stock_code || '').trim()).filter(Boolean));
    } catch { /* 등록 목록을 못 읽어도 검증 자체는 진행 */ }
    const p = await getPool();
    const vals = codes.map(c => `('${c}')`).join(',');
    const r = await p.request().query(`
      SELECT v.code,
        CASE WHEN EXISTS (SELECT 1 FROM S2_Card c WITH (NOLOCK) WHERE c.Card_Code = v.code)
             THEN 1 ELSE 0 END AS is_sales,
        CASE WHEN EXISTS (SELECT 1 FROM S2_CARD_ERP_STOCK s WITH (NOLOCK) WHERE s.CARD_CODE_ERP = v.code)
             THEN 1 ELSE 0 END AS is_stock,
        (SELECT TOP 1 c3.Card_Name FROM S2_Card c3 WITH (NOLOCK) WHERE c3.Card_Code = v.code) AS card_name,
        (SELECT COUNT(DISTINCT c2.Card_Code) FROM S2_Card c2 WITH (NOLOCK)
         WHERE c2.Card_Code LIKE v.code + '[_]%') AS variant_cnt
      FROM (VALUES ${vals}) AS v(code)`);
    const info = new Map((r.recordset || []).map(x => [x.code, x]));
    return rows.map(row => {
      const pKey = safe(row.parent_code);
      const cKey = safe(row.component_code);
      const pc = info.get(pKey) || {};
      const cc = info.get(cKey) || {};
      return {
        ...row,
        parent_ok: !!pc.is_sales,
        parent_name: pc.card_name || null,
        parent_variants: pc.is_sales ? 0 : (pc.variant_cnt || 0),   // 변형코드로만 존재
        component_name: cc.card_name || null,
        component_in_erp: !!cc.is_stock,          // ERP 재고코드로 존재 (참고)
        component_registered: registered.has(cKey),  // 재고관리 품목 등록 = 소진 반영됨
      };
    });
  }

  /**
   * BOM 그룹 단위로 묶어 내려준다 (052).
   *   한 그룹에 판매코드가 여러 개(변형코드 _A/_B/_C)일 수 있으므로 group_key 로 묶고,
   *   구성품은 코드 기준으로 접는다 — 판매코드 수만큼 행이 늘어나도 화면엔 한 줄로 보인다.
   */
  function groupBomByParent(rows) {
    const byGroup = new Map();
    for (const row of rows) {
      const key = String(row.group_key || row.parent_code || '').trim();
      const parent = String(row.parent_code || '').trim();
      if (!key || !parent) continue;
      if (!byGroup.has(key)) {
        byGroup.set(key, { group_key: key, parents: new Map(), compMap: new Map() });
      }
      const g = byGroup.get(key);
      if (!g.parents.has(parent)) {
        g.parents.set(parent, { code: parent, name: row.parent_name || null, ok: row.parent_ok !== false });
      } else if (!g.parents.get(parent).name && row.parent_name) {
        g.parents.get(parent).name = row.parent_name;
      }
      // 구성품은 코드로 접는다. 판매코드마다 행이 있어도 소요수량·역할은 같아야 정상.
      if (!g.compMap.has(row.component_code)) g.compMap.set(row.component_code, row);
    }
    const ROLE_ORDER = { product: 0, material: 1, package: 2, etc: 3 };
    return [...byGroup.values()].map(g => {
      const parents = [...g.parents.values()];
      // 대표 판매코드 — 변형 접미(_A) 없는 것 우선, 그다음 사전순. 헤더 표기와 정렬에 쓴다.
      const rep = parents.slice().sort((a, b) => {
        const av = /_[A-Za-z]$/.test(a.code) ? 1 : 0, bv = /_[A-Za-z]$/.test(b.code) ? 1 : 0;
        return av - bv || a.code.localeCompare(b.code);
      })[0];
      const components = [...g.compMap.values()].sort((a, b) =>
        (ROLE_ORDER[a.component_role] ?? 9) - (ROLE_ORDER[b.component_role] ?? 9)
        || String(a.component_code).localeCompare(String(b.component_code)));
      return {
        group_key: g.group_key,
        parent_code: rep.code,                      // 대표 코드 (기존 화면 호환)
        parent_name: parents.find(p => p.name)?.name || null,
        parent_ok: parents.some(p => p.ok),          // 하나라도 실판매코드면 OK
        parent_codes: parents.map(p => p.code),      // 변형 포함 전체
        parent_missing: parents.filter(p => !p.ok).map(p => p.code),
        components,
        component_count: components.length,
        // 구성품 중 재고관리 품목이 하나도 없으면 소진 계산에 아무 영향이 없다 (화면 경고용)
        tracked_count: components.filter(c => c.component_registered).length,
      };
    }).sort((a, b) => String(a.parent_name || a.parent_code).localeCompare(String(b.parent_name || b.parent_code)));
  }

  // BOM 그룹 저장 (생성/수정) — 판매코드 N개 × 구성품 M개
  if (pathname === '/api/bg/stock-bom/group' && method === 'POST') {
    try {
      const body = await parseBody(req);
      const rows = await store.saveBomGroup(body, session?.email || null);
      return json(res, { rows, count: rows.length }, 201);
    } catch (err) {
      console.error('[stock-bom group POST] error:', err.message);
      return json(res, { error: err.message }, 400);
    }
  }
  const bomGroupMatch = pathname.match(/^\/api\/bg\/stock-bom\/group\/([^/]+)$/);
  if (bomGroupMatch && method === 'DELETE') {
    try {
      return json(res, await store.deleteBomGroup(decodeURIComponent(bomGroupMatch[1])));
    } catch (err) {
      console.error('[stock-bom group DELETE] error:', err.message);
      return json(res, { error: err.message }, 400);
    }
  }

  if (pathname === '/api/bg/stock-bom' && method === 'GET') {
    try {
      const rows = await store.listBomRows();
      const wantGroup = query.group === 'parent';
      if (query.validate === '1' || wantGroup) {
        try {
          const annotated = await annotateBomRows(rows);
          return json(res, wantGroup
            ? { parents: groupBomByParent(annotated), total_rows: annotated.length }
            : { rows: annotated });
        } catch (e) {
          return json(res, wantGroup
            ? { parents: groupBomByParent(rows), total_rows: rows.length, validate_error: e.message }
            : { rows, validate_error: e.message });
        }
      }
      return json(res, { rows });
    } catch (err) {
      console.error('[stock-bom GET] error:', err.message);
      return json(res, { error: err.message }, 500);
    }
  }
  // POST /api/bg/stock-bom/validate — 저장 전 미리보기
  if (pathname === '/api/bg/stock-bom/validate' && method === 'POST') {
    try {
      const body = await parseBody(req);
      return json(res, { rows: await annotateBomRows(body.rows || []) });
    } catch (err) {
      console.error('[stock-bom validate] error:', err.message);
      return json(res, { error: err.message }, 400);
    }
  }
  if (pathname === '/api/bg/stock-bom' && method === 'POST') {
    try {
      const body = await parseBody(req);
      const added = await store.addBomRows(body.rows || [], session?.email || null);
      return json(res, { rows: added }, 201);
    } catch (err) {
      console.error('[stock-bom POST] error:', err.message);
      return json(res, { error: err.message }, 400);
    }
  }
  const bomIdMatch = pathname.match(/^\/api\/bg\/stock-bom\/([^/]+)$/);
  if (bomIdMatch && method === 'PATCH') {
    try {
      const body = await parseBody(req);
      const row = await store.updateBomRow(decodeURIComponent(bomIdMatch[1]), body);
      return json(res, row || { error: 'not found' }, row ? 200 : 404);
    } catch (err) {
      console.error('[stock-bom PATCH] error:', err.message);
      return json(res, { error: err.message }, 400);
    }
  }
  if (bomIdMatch && method === 'DELETE') {
    try {
      return json(res, await store.removeBomRow(decodeURIComponent(bomIdMatch[1])));
    } catch (err) {
      console.error('[stock-bom DELETE] error:', err.message);
      return json(res, { error: err.message }, 400);
    }
  }

  // ============================================
  // 매뉴얼 위키 (migration 041) — 편집 + 수정 히스토리
  //   현재 문서 = 최신 revision. 저장 시마다 revision 추가 (삭제 없음 → 히스토리 보존).
  // ============================================
  const wikiMatch = pathname.match(/^\/api\/bg\/wiki\/([a-z0-9-]+)$/);
  // GET /api/bg/wiki/:slug — 현재 문서 (없으면 content:null → 프론트가 기본 내용 사용)
  if (wikiMatch && method === 'GET') {
    try {
      const cur = await store.getWikiCurrent(wikiMatch[1]);
      return json(res, cur
        ? { content: cur.content, updated_at: cur.created_at, updated_by: cur.created_by }
        : { content: null });
    } catch (err) {
      console.error('[wiki GET] error:', err.message);
      return json(res, { error: err.message }, 500);
    }
  }
  // PUT /api/bg/wiki/:slug — 저장 (revision 추가). 로그인 사용자 누구나, 수정자 기록.
  if (wikiMatch && method === 'PUT') {
    try {
      const body = await parseBody(req);
      const saved = await store.saveWikiRevision(wikiMatch[1], body.content, {
        note: body.note || null,
        created_by: session?.email || null,
      });
      return json(res, { ok: true, id: saved?.id, created_at: saved?.created_at });
    } catch (err) {
      console.error('[wiki PUT] error:', err.message);
      return json(res, { error: err.message }, 400);
    }
  }
  // GET /api/bg/wiki/:slug/revisions — 히스토리 목록
  const wikiRevListMatch = pathname.match(/^\/api\/bg\/wiki\/([a-z0-9-]+)\/revisions$/);
  if (wikiRevListMatch && method === 'GET') {
    try {
      const revisions = await store.listWikiRevisions(wikiRevListMatch[1]);
      return json(res, { revisions });
    } catch (err) {
      console.error('[wiki revisions GET] error:', err.message);
      return json(res, { error: err.message }, 500);
    }
  }
  // GET /api/bg/wiki-revision/:id — 특정 revision 내용 (미리보기/복원)
  const wikiRevMatch = pathname.match(/^\/api\/bg\/wiki-revision\/([^/]+)$/);
  if (wikiRevMatch && method === 'GET') {
    try {
      const rev = await store.getWikiRevision(decodeURIComponent(wikiRevMatch[1]));
      if (!rev) return json(res, { error: 'revision 없음' }, 404);
      return json(res, rev);
    } catch (err) {
      console.error('[wiki-revision GET] error:', err.message);
      return json(res, { error: err.message }, 500);
    }
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
  // 공유 자유 옵션 그룹 (078) — 기획전 미니카드처럼 여러 상품에 같은 옵션을 붙일 때.
  //   site-settings 컬럼에 얹혀 있지만 권한은 스티커와 같다 (기획전 담당자가 직접 관리).
  //   site-settings PUT 은 알림·공통안내까지 건드리므로 super admin 을 유지하고, 여기만 연다.
  if (pathname === '/api/bg/option-groups' && method === 'GET') {
    try {
      const s = await store.getSiteSettings();
      return json(res, { groups: store.normSharedOptionGroups(s?.shared_option_groups) || [] });
    } catch (err) {
      console.error('[option-groups GET] error:', err.message);
      return json(res, { error: err.message }, 500);
    }
  }
  if (pathname === '/api/bg/option-groups' && method === 'PUT') {
    try {
      const body = await parseBody(req).catch(() => ({}));
      if (!Array.isArray(body.groups)) return json(res, { error: 'groups 배열이 필요합니다.' }, 400);
      const updated = await store.updateSiteSettings({ shared_option_groups: body.groups }, session?.email);
      if (updated && updated._skipped_column) return json(res, { error: updated._warning }, 500);
      return json(res, { groups: store.normSharedOptionGroups(updated?.shared_option_groups) || [] });
    } catch (err) {
      console.error('[option-groups PUT] error:', err.message);
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
  // 💬 출고완료 안내 문자 발송 (문자발송 탭)
  //   PublicApi LMS 발송 API (LMS-SEND-API.md, 2026-07-30 구현):
  //     POST {base}/api/Lms/send + Bearer JWT
  //     인증: POST /api/Partner/authenticate (clientId/clientSecret — 알림톡과 공유, 'kakaotalk')
  //   응답의 성공은 '발송 접수'다 — 실발송·결과 처리는 KTRCS Worker 몫.
  //   본문이 80바이트를 넘으면(우리 안내문은 항상 넘는다) API 가 알아서 MMS/RCS 로 보낸다.
  //   비운영 환경은 서버측 allowlist 가드가 있어 고객 실발송이 차단된다.
  // ============================================
  const SMS_TEMPLATE_CODE = 'SMS_출고완료안내';
  // 기본 본문 — 운영 확정 문구. 화면에서 수정하면 bg_site_settings.sms_ship_template 에 저장된다.
  const SMS_DEFAULT_TEMPLATE = '안녕하세요,\n{이름}님, 주문 상품이 발송됩니다.\n{출고일}  \nCJ대한통운 {송장번호} \n\n감사합니다. ';
  /** 본문 렌더 — 변수만 치환한다 (임의 코드/HTML 실행 없음). */
  function _smsRender(tpl, vars) {
    return String(tpl || SMS_DEFAULT_TEMPLATE)
      .replace(/\{이름\}/g, vars.name)
      .replace(/\{출고일\}/g, vars.shipDate)
      .replace(/\{송장번호\}/g, vars.invoice);
  }
  async function _smsTemplate() {
    try {
      const st = await store.getSiteSettings();
      const t = st && st.sms_ship_template ? String(st.sms_ship_template).trim() : '';
      return t || SMS_DEFAULT_TEMPLATE;
    } catch { return SMS_DEFAULT_TEMPLATE; }
  }

  function _smsConfig() {
    // 알림톡(Partner) 과 같은 인증을 쓴다 — 이미 배포에 있는 env 를 우선 재사용.
    const base = (process.env.BARUN_SMS_API_BASE || process.env.BIZTALK_API_URL || 'https://api.barunsoncard.com').replace(/\/$/, '');
    const clientId = (process.env.BARUN_SMS_CLIENT_ID || process.env.PARTNER_CLIENT_ID || 'kakaotalk').trim();
    // docker-manager env 함정 방어 (flower-daily-report 에서 실제 겪음):
    //   값에 따옴표를 치면 따옴표가 값에 포함되고, '#' 이 있으면 그 뒤가 잘린다.
    //   앞뒤 공백·둘러싼 따옴표는 벗겨내고, 특수문자 시크릿은 *_B64 로도 받을 수 있게 한다.
    let clientSecret = '';
    let secretSource = '';
    let rawEnvLen = 0;   // 환경변수에 실제로 도달한 원본 길이 — 잘림 진단용 (값은 절대 노출 안 함)
    const _pick = (envName, decode) => {
      const v = process.env[envName];
      if (!v) return false;
      rawEnvLen = String(v).trim().length;
      secretSource = envName;
      try { clientSecret = decode ? decode(String(v).trim()) : v; } catch { clientSecret = ''; }
      return true;
    };
    // HEX 우선 — 0-9a-f 만이라 어떤 환경변수 UI 에서도 잘리거나 변형될 여지가 없다.
    _pick('BARUN_SMS_CLIENT_SECRET_HEX', v => Buffer.from(v.replace(/[^0-9a-fA-F]/g, ''), 'hex').toString('utf8'))
      || _pick('BARUN_SMS_CLIENT_SECRET')
      || _pick('PARTNER_CLIENT_SECRET')
      || _pick('BARUN_SMS_CLIENT_SECRET_B64', v => Buffer.from(v, 'base64').toString('utf8'));
    clientSecret = String(clientSecret).trim().replace(/^["']+|["']+$/g, '').trim();
    if (!clientSecret) return null;
    return {
      base, clientId, clientSecret,
      secretSource, rawEnvLen,
      sendUrl: process.env.BARUN_SMS_API_URL || `${base}/api/Lms/send`,
      // v1 은 발신번호 1661-2646 전용 (RCS BrandKey 종속 — 문서 2-8). 다른 번호는 비정상 경로.
      callback: process.env.BARUN_SMS_CALLBACK || '1661-2646',
      salesGubun: process.env.BARUN_SMS_SALES_GUBUN || 'SD',
      purpose: process.env.BARUN_SMS_PURPOSE || 'order-notice',
    };
  }

  // Partner JWT 캐시 — access 1시간 / refresh 7일 (알림톡 모듈과 동일 응답 형식: token/expires/refreshToken)
  if (!global._smsTokenCache) global._smsTokenCache = null;
  const _isTimeoutErr = e => e?.name === 'TimeoutError' || /timed? ?out/i.test(e?.message || '');
  async function _smsAuth(cfg) {
    const call = () => fetch(`${cfg.base}/api/Partner/authenticate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: cfg.clientId, clientSecret: cfg.clientSecret }),
      signal: AbortSignal.timeout(15000),
    });
    let res;
    try {
      res = await call();
    } catch (e) {
      if (!_isTimeoutErr(e)) throw new Error(`Partner 인증 서버 연결 실패 (${cfg.base}) — ${e.message}`);
      // 인증은 멱등이라 재시도해도 안전. dev 서버는 유휴 후 첫 요청이 15초를 넘길 수 있다 (콜드스타트).
      try {
        res = await call();
      } catch (e2) {
        throw new Error(`Partner 인증 응답 없음 (${cfg.base}, 15초×2회) — dev 서버 콜드스타트일 수 있습니다. 잠시 후 다시 시도해주세요.`);
      }
    }
    if (!res.ok) {
      // 값은 절대 남기지 않는다 — 길이만으로 오입력(따옴표 포함·잘림)을 가늠할 수 있게 한다.
      // 404 = base 에 경로/슬래시가 붙어 URL 이 비틀린 것 — 호출 URL 을 그대로 보여준다.
      const hint = res.status === 404
        ? ` — 호출 URL ${cfg.base}/api/Partner/authenticate 이 서버에 없습니다. BARUN_ALIMTALK_API_BASE 는 경로 없는 서버 주소만 넣으세요 (예: https://dev-api.barunsoncard.com).`
        : res.status === 401
        ? ` — 접속 서버 ${cfg.base} · clientId '${cfg.clientId}' · 출처 ${cfg.secretSource} · 환경변수 원본 ${cfg.rawEnvLen}자 → 실제 사용 ${cfg.clientSecret.length}자. 원본 길이가 넣은 값보다 짧으면 환경변수가 잘린 것입니다 (BARUN_SMS_CLIENT_SECRET_HEX 로 넣어보세요). 환경변수 변경은 재배포해야 반영됩니다. 개발용 시크릿이면 접속 서버도 개발(BARUN_ALIMTALK_API_BASE)이어야 합니다.`
        : '';
      throw new Error(`Partner 인증 실패 (${res.status})${hint}`);
    }
    const d = await res.json();
    if (!d || !d.token) throw new Error('Partner 인증 응답에 token 없음');
    const now = Date.now();
    const exp = d.expires ? new Date(d.expires).getTime() : now + 3600000;
    if (!global._smsTokenCaches) global._smsTokenCaches = {};
    global._smsTokenCaches[`${cfg.base}|${cfg.clientId}`] = { token: d.token, expires: Number.isFinite(exp) ? exp : now + 3600000 };
    return d.token;
  }
  // base|clientId 별 캐시 — 알림톡을 개발 PublicApi(별도 base)로 돌릴 때 문자(운영) 토큰과 섞이지 않게.
  async function _smsToken(cfg, force) {
    const c = global._smsTokenCaches?.[`${cfg.base}|${cfg.clientId}`];
    if (!force && c && c.expires > Date.now() + 5 * 60000) return c.token;
    return _smsAuth(cfg);
  }

  // GET /api/bg/sms/template — 현재 본문 + 기본 본문
  if (pathname === '/api/bg/sms/template' && method === 'GET') {
    try {
      const tpl = await _smsTemplate();
      return json(res, { template: tpl, is_default: tpl === SMS_DEFAULT_TEMPLATE, default_template: SMS_DEFAULT_TEMPLATE });
    } catch (err) { return json(res, { error: err.message }, 500); }
  }

  // PUT /api/bg/sms/template — {template} 저장. 빈 값이면 기본 문구로 되돌린다.
  if (pathname === '/api/bg/sms/template' && method === 'PUT') {
    try {
      const body = await parseBody(req);
      const raw = body.template == null ? '' : String(body.template);
      if (raw.length > 2000) return json(res, { error: '본문은 2000자를 넘을 수 없습니다 (문자 API 제한).' }, 400);
      const updatedBy = req._session?.user?.user_id || req._session?.user?.id || 'admin';
      await store.updateSiteSettings({ sms_ship_template: raw.trim() || null }, updatedBy);
      const tpl = await _smsTemplate();
      logAccess(req, 'sms_template_update', null, { metadata: { length: tpl.length } });
      return json(res, { template: tpl, is_default: tpl === SMS_DEFAULT_TEMPLATE });
    } catch (err) {
      // 컬럼 미적용(마이그레이션 077 전)이면 원인을 바로 알 수 있게 안내한다.
      const msg = /sms_ship_template/.test(err.message || '')
        ? '본문 저장 컬럼이 아직 없습니다 — 마이그레이션 077 을 실행한 뒤 다시 저장해주세요.'
        : err.message;
      return json(res, { error: msg }, 400);
    }
  }

  /**
   * 알림톡(PublicApi kakaotalk/send) 설정 — 기본은 문자 API 설정을 그대로 쓴다.
   *   PublicApi 반영이 개발 서버에만 된 동안은 BARUN_ALIMTALK_API_BASE / _CLIENT_SECRET 으로
   *   알림톡만 개발 서버를 보게 할 수 있다 (문자는 운영 그대로). 운영 반영 후 두 변수를 지우면
   *   문자와 같은 운영 인증으로 돌아간다.
   */
  function _alimConfig() {
    const sms = _smsConfig();   // 시크릿 없으면 null
    const base = (process.env.BARUN_ALIMTALK_API_BASE || sms?.base || 'https://api.barunsoncard.com')
      .trim().replace(/\/$/, '');
    const clientId = (process.env.BARUN_ALIMTALK_CLIENT_ID || sms?.clientId || 'kakaotalk').trim();
    const own = (process.env.BARUN_ALIMTALK_CLIENT_SECRET || '').trim().replace(/^["']|["']$/g, '');
    const clientSecret = own || sms?.clientSecret || '';
    if (!clientSecret) return null;
    return { base, clientId, clientSecret, secretSource: own ? 'BARUN_ALIMTALK_CLIENT_SECRET' : (sms?.secretSource || ''), rawEnvLen: own ? own.length : (sms?.rawEnvLen ?? 0), secretLen: clientSecret.length };
  }

  // POST /api/bg/sms/history — {order_ids:[]} → {history: {id: {count,lastSentAt}}}
  if (pathname === '/api/bg/sms/history' && method === 'POST') {
    try {
      const body = await parseBody(req);
      const ids = Array.isArray(body.order_ids) ? body.order_ids.slice(0, 2000) : [];   // 커스텀 시트 1,299행 대응 (store 가 150개씩 나눠 조회)
      const map = await store.getSmsSendHistory(ids, SMS_TEMPLATE_CODE);
      const history = {};
      for (const [k, v] of map) history[k] = v;
      return json(res, { history });
    } catch (err) { return json(res, { error: err.message }, 400); }
  }

  // POST /api/bg/sms/send — {rows:[{order_id,name,phone,ship_date,invoice}], force?}
  if (pathname === '/api/bg/sms/send' && method === 'POST') {
    const rlSms = rlCheck(req, 'sms_send', RL_LIMITS.sms_send);
    if (!rlSms.allowed) {
      logAccess(req, 'rate_limited', null, { status_code: 429, metadata: { action: 'sms_send', retry_after: rlSms.retryAfterSec } });
      return rateLimitResponse(res, rlSms);
    }
    try {
      const cfg = _smsConfig();
      if (!cfg) {
        return json(res, { error: '문자 API 인증키가 없습니다 — 환경변수 BARUN_SMS_CLIENT_SECRET(또는 PARTNER_CLIENT_SECRET)을 넣고 재배포해주세요.' }, 503);
      }
      const body = await parseBody(req);
      const rows = Array.isArray(body.rows) ? body.rows : [];
      if (!rows.length) return json(res, { error: '발송할 행이 없습니다.' }, 400);
      if (rows.length > 50) return json(res, { error: '한 번에 최대 50건까지 발송할 수 있습니다 (화면이 나눠 보냅니다).' }, 400);

      // 중복 방지 — 주문번호 없는 행은 연락처 기반 PH- 키.
      const keyOf = r => (String(r.order_id || '').trim()) || ('PH-' + String(r.phone || '').replace(/\D/g, ''));
      const history = await store.getSmsSendHistory(rows.map(keyOf), SMS_TEMPLATE_CODE);

      const tpl = await _smsTemplate();
      logAccess(req, 'sms_send_start', null, { metadata: { count: rows.length } });
      const results = [];
      for (const raw of rows) {
        const orderId = String(raw.order_id || '').trim();
        const name = String(raw.name || '').trim();
        const shipDate = String(raw.ship_date || '').trim();
        const invoice = String(raw.invoice || '').trim();
        const digits = String(raw.phone || '').replace(/\D/g, '');
        const logKey = orderId || `PH-${digits}`;
        // 서버에서 한 번 더 검증 — 화면 값을 그대로 믿지 않는다
        if (!name) { results.push({ order_id: logKey, success: false, error: '성함 누락' }); continue; }
        const isSafeNum = /^050\d{8,9}$/.test(digits);
        if (!/^01[016789]\d{7,8}$/.test(digits) && !isSafeNum) { results.push({ order_id: logKey, success: false, error: '휴대폰 번호 형식 오류' }); continue; }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(shipDate)) { results.push({ order_id: logKey, success: false, error: '출고일 형식 오류 (YYYY-MM-DD)' }); continue; }
        if (!/^[\d-]{9,}$/.test(invoice)) { results.push({ order_id: logKey, success: false, error: '송장번호 형식 오류' }); continue; }
        const dup = history.get(logKey);
        if (dup && dup.successCount > 0 && !body.force) {
          results.push({ order_id: logKey, success: false, duplicate: true, error: `이미 발송됨 (${(d => Number.isFinite(d) ? new Date(d + 9 * 3600000).toISOString().replace('T', ' ').slice(0, 16) + ' KST' : String(dup.lastSentAt).slice(0, 16))(Date.parse(dup.lastSentAt))})` });
          continue;
        }
        const phone = isSafeNum
          ? digits.replace(/^(\d{4})(\d{3,4})(\d{4})$/, '$1-$2-$3')
          : digits.replace(/^(\d{3})(\d{3,4})(\d{4})$/, '$1-$2-$3');
        // 메시지 — 운영자가 저장한 본문에 변수 치환 (80바이트 초과 → API 가 MMS/RCS 자동 처리)
        const message = _smsRender(tpl, { name, shipDate, invoice });
        let ok = false, errMsg = null, tranId = null;
        try {
          const payload = {
            recipientNum: phone,
            recipientName: name.slice(0, 20),
            message,
            callback: cfg.callback,
            salesGubun: cfg.salesGubun,
            purpose: cfg.purpose,
          };
          let token = await _smsToken(cfg);
          let r = await fetch(cfg.sendUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(15000),
          });
          if (r.status === 401) {   // 토큰 만료 → 재발급 후 1회 재시도
            token = await _smsToken(cfg, true);
            r = await fetch(cfg.sendUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
              body: JSON.stringify(payload),
              signal: AbortSignal.timeout(15000),
            });
          }
          const text = await r.text();
          let parsed = null;
          try { parsed = JSON.parse(text); } catch { /* 본문 없는 401 등 */ }
          // 문서 2-5: 200 + success=true 가 접수 성공. success=false 면 HTTP 200 이어도 실패.
          ok = r.ok && (!parsed || parsed.success !== false);
          if (!ok) {
            const detail = parsed ? (parsed.message || JSON.stringify(parsed.errors || {})) : text.slice(0, 150);
            errMsg = `HTTP ${r.status}: ${String(detail).slice(0, 180)}`;
          } else if (parsed) {
            tranId = parsed.tranId != null ? String(parsed.tranId) : null;
          }
        } catch (e) {
          errMsg = e.name === 'TimeoutError' ? '응답 시간 초과 (15초)' : e.message;
        }
        // 이력 기록 — 전화번호는 마지막 4자리만 (개인정보 최소화). tranId 는 KTRCS MSG_ID.
        try {
          await store.logAlimtalkSend({
            order_id: logKey, to_phone: `****${digits.slice(-4)}`,
            template_code: SMS_TEMPLATE_CODE, message_id: tranId,
            success: ok, error_message: errMsg,
          });
        } catch { /* 로그 실패는 발송 결과에 영향 없음 */ }
        results.push({ order_id: logKey, success: ok, tran_id: tranId, error: errMsg });
      }
      const sent = results.filter(r => r.success).length;
      const dup = results.filter(r => r.duplicate).length;
      logAccess(req, 'sms_send_done', null, { metadata: { count: rows.length, sent, dup } });
      return json(res, { total: rows.length, sent, duplicate: dup, failed: rows.length - sent - dup, results });
    } catch (err) {
      console.error('[sms send] error:', err.message);
      return json(res, { error: err.message }, 500);
    }
  }

  // ============================================
  // 알림톡 발송 API
  //   2026-05-20 정리: Partner API 직접 호출 경로 (recipients/send/preview) 제거.
  //   send-via-sp 단일 경로로 통합 (SP 우선 + 통합관리자 HTTP API fallback).
  // ============================================

  // POST /api/bg/alimtalk/history — {order_ids:[]} → {history:{id:{count,successCount,lastSentAt}}}
  //   PublicApi 경로로 보낸 발송만 잡힌다 (bg_alimtalk_log). SP/통합관리자 경로의 과거 발송
  //   이력은 바른손 백엔드에만 있어 여기 안 나온다.
  if (pathname === '/api/bg/alimtalk/history' && method === 'POST') {
    try {
      const body = await parseBody(req);
      const ids = Array.isArray(body.order_ids) ? body.order_ids.slice(0, 2000) : [];   // 커스텀 시트 1,299행 대응 (store 가 150개씩 나눠 조회)
      const map = await store.getSmsSendHistory(ids, ['BHGIFT_01', 'BMGIFT_01']);
      const history = {};
      for (const [k, v] of map) history[k] = v;
      return json(res, { history });
    } catch (err) { return json(res, { error: err.message }, 400); }
  }

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
      const viaCounts = { sp: 0, 'admin-http': 0, publicapi: 0 };
      let httpAborted = false; // 세션 만료/네트워크 차단 시 이후 HTTP 호출 skip

      // 3순위 경로: PublicApi /api/kakaotalk/send (OpenAPI 명세 2026-08-28 확보).
      //   문자 API 와 인증 공유 (clientId 'kakaotalk'). caller 는 서버 allowlist 검증이라
      //   BARUN_ALIMTALK_CALLER 등록 전엔 비활성 — 값이 있어야만 이 경로를 탄다.
      //   발송: 주문번호 + 주문자 휴대전화 기준. 템플릿의 #{name}/#{0000000} 치환.
      const alimCaller = (process.env.BARUN_ALIMTALK_CALLER || '').trim();
      const alimCfg = alimCaller ? _alimConfig() : null;
      // sales_gubun → template_code. wedd_biztalk 실측(2026-08-28) 폴백:
      //   SB(바른손카드)=BHGIFT_01 ('[바른손카드]…' 본문) · B(바른손몰)=BMGIFT_01 ('[바른손몰]…').
      //   div = 템플릿 그룹명 ('답례품_주문완료') 로 조회해 코드 개정(_260423 류)에도 따라간다.
      let alimTplByGubun = { SB: 'BHGIFT_01', B: 'BMGIFT_01' };
      if (alimCfg) {
        try {
          const tq = await pool.request()
            .input('div', sql.NVarChar, templateName)
            .query(`SELECT sales_gubun, template_code FROM wedd_biztalk WITH (NOLOCK)
                    WHERE div = @div AND USE_YORN = 'Y'`);
          if (tq.recordset.length) {
            alimTplByGubun = {};
            for (const t of tq.recordset) alimTplByGubun[String(t.sales_gubun || '').trim()] = String(t.template_code || '').trim();
          }
        } catch (e) {
          console.warn('[alimtalk] wedd_biztalk 템플릿 조회 실패 — 하드코딩 매핑 사용:', e.message);
        }
      }

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

        // 3) PublicApi KakaoTalk fallback — SP·사내망 HTTP 둘 다 실패했을 때.
        if (!sent && alimCfg) {
          try {
            // 브랜드는 테이블이 아니라 **주문의 사이트** 로 판정한다.
            //   CUSTOM_ETC_ORDER 는 바른손카드 답례품 단독주문이 대부분이다 (최근 60일 실측:
            //   바른손카드 2,090건 vs 바른손몰 1건). 테이블 기준(E=몰)으로 보내면 카드 고객이
            //   [바른손몰] 템플릿을 받는다 (2026-08-28 운영 오발송 원인).
            const oq = await pool.request().input('seq', sql.Int, seq).query(
              orderCategory === 'E'
                ? `SELECT o.order_name, o.order_hphone,
                          ISNULL(si.SiteName, CAST(o.company_Seq AS VARCHAR(20))) AS site
                   FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
                   LEFT JOIN SiteInfo si WITH (NOLOCK) ON o.company_Seq = si.CompayCode
                   WHERE o.order_seq = @seq`
                : `SELECT co.order_name, co.order_hphone,
                          ISNULL(si.SiteName, CAST(co.company_Seq AS VARCHAR(20))) AS site
                   FROM custom_order co WITH (NOLOCK)
                   LEFT JOIN SiteInfo si WITH (NOLOCK) ON co.company_Seq = si.CompayCode
                   WHERE co.order_seq = @seq`);
            const ord = oq.recordset[0];
            if (!ord) throw new Error('주문 조회 실패 (주문번호 확인)');
            // 바른손몰 계열만 B — SiteName '바른손몰' 또는 2715(바른손몰 B2B, SiteInfo 미등록이라 raw 코드).
            //   그 외(바른손카드·제휴 웨딩홀 등 카드 플랫폼 판매)는 전부 SB.
            const site = String(ord.site || '').trim();
            const gubun = (site.includes('바른손몰') || site === '2715') ? 'B' : 'SB';
            const tplCode = alimTplByGubun[gubun];
            if (!tplCode) throw new Error(`사용 가능한 템플릿 없음 (sales_gubun=${gubun})`);
            // 알림톡은 휴대폰(01X)만 허용 — 안심번호/유선은 이 경로로 발송 불가.
            const digits = String(ord.order_hphone || '').replace(/\D/g, '');
            if (!/^01[016789]\d{7,8}$/.test(digits)) throw new Error('주문자 번호가 휴대폰이 아닙니다');
            const payload = {
              caller: alimCaller,
              salesGubun: gubun,
              templateCode: tplCode,
              recipientNum: digits.replace(/^(\d{3})(\d{3,4})(\d{4})$/, '$1-$2-$3'),
              // 템플릿 변수 실측: #{name} · #{0000000}(주문번호). 버튼 링크는 고정 URL.
              variables: { name: String(ord.order_name || '고객').trim(), '0000000': String(seq) },
            };
            let token = await _smsToken(alimCfg);
            const call = tk => fetch(`${alimCfg.base}/api/kakaotalk/send`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tk}` },
              body: JSON.stringify(payload),
              signal: AbortSignal.timeout(15000),
            });
            let r = await call(token);
            if (r.status === 401) { token = await _smsToken(alimCfg, true); r = await call(token); }
            const text = await r.text();
            let parsed = null;
            try { parsed = JSON.parse(text); } catch { /* 본문 없는 401 등 */ }
            if (r.ok && parsed && parsed.success !== false) {
              sent = true;
              via = 'publicapi';
              viaCounts.publicapi++;
              // SP/사내망 경로와 달리 이력이 바른손 백엔드에 안 남을 수 있어 우리 쪽에 기록.
              try {
                await store.logAlimtalkSend({
                  order_id: oid, to_phone: `****${digits.slice(-4)}`,
                  template_code: tplCode,
                  message_id: parsed.messageId != null ? String(parsed.messageId) : null,
                  success: true,
                });
              } catch { /* 로그 실패는 발송 결과에 영향 없음 */ }
            } else {
              const detail = parsed ? (parsed.message || JSON.stringify(parsed.errors || {})) : text.slice(0, 150);
              throw new Error(`HTTP ${r.status}: ${String(detail).slice(0, 180)}`);
            }
          } catch (e) {
            lastError = (lastError ? lastError + ' | ' : '') + `PublicApi: ${_isTimeoutErr(e)
              ? `발송 호출 시간 초과 (${alimCfg.base}) — 접수 여부 불명. 발송이력을 확인한 뒤 재시도하세요 (바로 재시도하면 중복 발송 가능)`
              : e.message}`;
          }
        }

        if (sent) {
          results.push({ order_id: oid, order_seq: seq, order_type: orderCategory, success: true, via });
        } else {
          results.push({ order_id: oid, order_seq: seq, order_type: orderCategory, success: false, error: lastError || 'unknown' });
          // PublicApi 경로가 살아 있으면 다음 주문을 계속 시도한다 — abort 는 남은 경로가 없을 때만.
          if (httpAborted && !alimCfg) {
            // 남은 주문들은 어차피 같은 이유로 실패 — 일찍 끝냄
            results.push({ order_id: '_aborted', success: false, error: '경로 차단으로 이후 호출 중단 (SP 권한 X + HTTP 차단 · BARUN_ALIMTALK_CALLER 미설정)' });
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
        publicapi_enabled: !!alimCfg,
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

  // GET /api/bg/alimtalk/publicapi-probe - PublicApi 알림톡 엔드포인트 계약 확인
  //   기존 두 경로가 모두 막힌 상태에서(SP 권한 X · admin.barunsoncard.com 은 사내망 172.16.1.5
  //   라 컨테이너에서 도달 불가) 세 번째 경로를 찾기 위한 진단용.
  //   LMS 문서 2-7: 알림톡 API(BiztalkController/KakaoTalkController)는 인증 클라이언트
  //   'kakaotalk' 을 문자 API 와 공유한다 → 이미 있는 시크릿으로 호출 가능한지 확인한다.
  //   빈 바디를 보내 모델 검증 에러(필수 필드 목록)를 받아온다 — 발송은 일어나지 않는다.
  if (pathname === '/api/bg/alimtalk/publicapi-probe' && method === 'GET') {
    try {
      const cfg = _smsConfig();
      if (!cfg) return json(res, { error: '문자 API 인증키(BARUN_SMS_CLIENT_SECRET)가 없습니다.' }, 503);
      let token = null, authError = null;
      try { token = await _smsToken(cfg, true); }
      catch (e) { authError = e.message; }
      // 1단계: 빈 바디 → 필수 필드 목록.
      // 2단계(?stage=2): 필수 필드를 채우되 **존재할 수 없는 템플릿 코드**와 수신 불가 번호를 넣어
      //   다음 검증 계층(허용 Caller · 수신자/변수 필드명)을 드러낸다. 실발송은 구조적으로 불가능하다.
      const stage = String(query.stage || '1');
      const BAD_TEMPLATE = '__PROBE_NO_SUCH_TEMPLATE__';
      const BAD_PHONE = '010-0000-0000';
      const cases = stage === '2'
        ? [
            { path: '/api/KakaoTalk/send', body: { Caller: String(query.caller || 'daeryepum'), SalesGubun: cfg.salesGubun, TemplateCode: BAD_TEMPLATE } },
            { path: '/api/KakaoTalk/send', body: { Caller: String(query.caller || 'daeryepum'), SalesGubun: cfg.salesGubun, TemplateCode: BAD_TEMPLATE, RecipientNum: BAD_PHONE, OrderSeq: 0 } },
            { path: '/api/Biztalk/send', body: { Caller: String(query.caller || 'daeryepum'), SalesGubun: cfg.salesGubun, TemplateCode: BAD_TEMPLATE, Subject: 'probe', Content: 'probe', Callback: cfg.callback, SenderKey: '__PROBE__', RecipientNum: BAD_PHONE } },
          ]
        : [
            { path: '/api/Biztalk/send', body: {} },
            { path: '/api/KakaoTalk/send', body: {} },
            { path: '/api/Biztalk/sendGift', body: {} },
          ];
      const probes = [];
      for (const c of cases) {
        try {
          const r = await fetch(`${cfg.base}${c.path}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: JSON.stringify(c.body),
            signal: AbortSignal.timeout(15000),
          });
          probes.push({ path: c.path, sent_keys: Object.keys(c.body), status: r.status, body: (await r.text()).slice(0, 900) });
        } catch (e) {
          probes.push({ path: c.path, error: e.name === 'TimeoutError' ? 'timeout' : e.message });
        }
      }
      logAccess(req, 'alimtalk_publicapi_probe', null, { metadata: { authed: !!token, stage } });
      return json(res, { base: cfg.base, client_id: cfg.clientId, authenticated: !!token, auth_error: authError, probes });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
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
