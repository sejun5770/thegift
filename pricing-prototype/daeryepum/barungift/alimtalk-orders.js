/**
 * 답례품 주문 × 알림톡 연결 헬퍼 (daeryepum 서버용)
 *
 * barunson DB(custom_order + CUSTOM_ETC_ORDER)에서 답례품 주문을 조회하고
 * 알림톡을 발송한다. 발송 이력은 Supabase bg_alimtalk_log (또는 로컬 JSON)에 기록.
 */
const store = require('./store');
const { sendAlimtalk, buildMessagePayload } = require('./alimtalk');

// 답례품 식별 조건 (api.js와 일치)
const DAERYEPUM_CARDKIND_SEQS = [4, 5, 16];
const DAERYEPUM_CARD_CODES = [
  'TGJSD03O2','TGIBK01D1','TGOSL006D1','TGOSL003D1','OSL002','TGAMT01O1',
  'TGJSD05D1','TGJSD08D1','TGJSD01','OSL005','TGJSD02D1','TGJBK05D1',
  'TGJBK02D1','TGJBK03D1','TGJSD06D1','TGJSD04D1','TGJSD07D1','TGJSD03O3',
  'TGJBK04D1','TGJSD03O1','TGJBK01D1','TGIKX01',
];
const DAERYEPUM_WHERE = `
  (ck.CardKind_Seq IN (${DAERYEPUM_CARDKIND_SEQS.join(',')})
   OR c.Card_Code IN (${DAERYEPUM_CARD_CODES.map(c => "'" + c + "'").join(',')}))
`;

/**
 * 답례품 수신자 목록 조회 (CARD + ETC 통합)
 * filters: { startDate, endDate, sentStatus, search, page, limit }
 */
async function fetchDaeryepumRecipients(pool, sql, filters) {
  const page = Math.max(1, parseInt(filters.page) || 1);
  const limit = Math.max(1, Math.min(200, parseInt(filters.limit) || 50));

  // 날짜 필터 (order_date 기준 — barunson에 desired_shipping_date가 없어서)
  const dateClause = [];
  if (filters.startDate) dateClause.push("co.order_date >= @startDate");
  if (filters.endDate) dateClause.push("co.order_date < DATEADD(day, 1, @endDate)");
  const dateWhere = dateClause.length ? 'AND ' + dateClause.join(' AND ') : '';

  // 검색어
  const searchClause = filters.search
    ? "AND (CAST(co.order_seq AS VARCHAR) LIKE '%' + @search + '%' OR co.order_name LIKE '%' + @search + '%')"
    : '';

  // CARD (custom_order)
  const cardReq = pool.request();
  if (filters.startDate) cardReq.input('startDate', sql.Date, filters.startDate);
  if (filters.endDate) cardReq.input('endDate', sql.Date, filters.endDate);
  if (filters.search) cardReq.input('search', sql.VarChar, filters.search);
  const cardResult = await cardReq.query(`
    SELECT DISTINCT TOP 500
      co.order_seq, co.order_date, co.order_name, co.order_hphone,
      co.order_total_price, co.last_total_price, co.status_seq,
      (SELECT TOP 1 c2.Card_Name FROM custom_order_item coi2 WITH (NOLOCK)
       INNER JOIN S2_Card c2 WITH (NOLOCK) ON coi2.card_seq = c2.Card_Seq
       LEFT JOIN S2_CardKind ck2 WITH (NOLOCK) ON c2.Card_Seq = ck2.Card_Seq AND ck2.CardKind_Seq IN (${DAERYEPUM_CARDKIND_SEQS.join(',')})
       WHERE coi2.order_seq = co.order_seq
         AND ${DAERYEPUM_WHERE.replace(/ck\./g, 'ck2.').replace(/c\./g, 'c2.')}
      ) AS card_name,
      (SELECT TOP 1 c2.Card_Code FROM custom_order_item coi2 WITH (NOLOCK)
       INNER JOIN S2_Card c2 WITH (NOLOCK) ON coi2.card_seq = c2.Card_Seq
       LEFT JOIN S2_CardKind ck2 WITH (NOLOCK) ON c2.Card_Seq = ck2.Card_Seq AND ck2.CardKind_Seq IN (${DAERYEPUM_CARDKIND_SEQS.join(',')})
       WHERE coi2.order_seq = co.order_seq
         AND ${DAERYEPUM_WHERE.replace(/ck\./g, 'ck2.').replace(/c\./g, 'c2.')}
      ) AS card_code
    FROM custom_order co WITH (NOLOCK)
    INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
    INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
    LEFT JOIN S2_CardKind ck WITH (NOLOCK) ON c.Card_Seq = ck.Card_Seq AND ck.CardKind_Seq IN (${DAERYEPUM_CARDKIND_SEQS.join(',')})
    WHERE co.status_seq >= 1
      AND co.order_date >= DATEADD(month, -6, GETDATE())
      AND ${DAERYEPUM_WHERE}
      ${dateWhere}
      ${searchClause}
    ORDER BY co.order_date DESC
  `);

  // ETC (CUSTOM_ETC_ORDER)
  const etcReq = pool.request();
  if (filters.startDate) etcReq.input('startDate', sql.Date, filters.startDate);
  if (filters.endDate) etcReq.input('endDate', sql.Date, filters.endDate);
  if (filters.search) etcReq.input('search', sql.VarChar, filters.search);
  const etcResult = await etcReq.query(`
    SELECT DISTINCT TOP 500
      co.order_seq, co.order_date, co.order_name, co.order_hphone, co.settle_price,
      co.status_seq,
      (SELECT TOP 1 c2.Card_Name FROM CUSTOM_ETC_ORDER_ITEM ei2 WITH (NOLOCK)
       INNER JOIN S2_Card c2 WITH (NOLOCK) ON ei2.card_seq = c2.Card_Seq
       LEFT JOIN S2_CardKind ck2 WITH (NOLOCK) ON c2.Card_Seq = ck2.Card_Seq AND ck2.CardKind_Seq IN (${DAERYEPUM_CARDKIND_SEQS.join(',')})
       WHERE ei2.order_seq = co.order_seq
         AND ${DAERYEPUM_WHERE.replace(/ck\./g, 'ck2.').replace(/c\./g, 'c2.')}
      ) AS card_name,
      (SELECT TOP 1 c2.Card_Code FROM CUSTOM_ETC_ORDER_ITEM ei2 WITH (NOLOCK)
       INNER JOIN S2_Card c2 WITH (NOLOCK) ON ei2.card_seq = c2.Card_Seq
       LEFT JOIN S2_CardKind ck2 WITH (NOLOCK) ON c2.Card_Seq = ck2.Card_Seq AND ck2.CardKind_Seq IN (${DAERYEPUM_CARDKIND_SEQS.join(',')})
       WHERE ei2.order_seq = co.order_seq
         AND ${DAERYEPUM_WHERE.replace(/ck\./g, 'ck2.').replace(/c\./g, 'c2.')}
      ) AS card_code
    FROM CUSTOM_ETC_ORDER co WITH (NOLOCK)
    INNER JOIN CUSTOM_ETC_ORDER_ITEM ei WITH (NOLOCK) ON co.order_seq = ei.order_seq
    INNER JOIN S2_Card c WITH (NOLOCK) ON ei.card_seq = c.Card_Seq
    LEFT JOIN S2_CardKind ck WITH (NOLOCK) ON c.Card_Seq = ck.Card_Seq AND ck.CardKind_Seq IN (${DAERYEPUM_CARDKIND_SEQS.join(',')})
    WHERE co.status_seq >= 1
      AND co.order_date >= DATEADD(month, -6, GETDATE())
      AND ${DAERYEPUM_WHERE}
      ${dateWhere}
      ${searchClause}
    ORDER BY co.order_date DESC
  `);

  // 병합
  const combined = [
    ...cardResult.recordset.map(r => ({
      order_id: String(r.order_seq),
      order_number: 'BRS-' + r.order_seq,
      recipient_name: r.order_name || '',
      recipient_phone: r.order_hphone || '',
      status: r.status_seq >= 1 ? 'collected' : 'cancelled',
      desired_shipping_date: null,
      collected_at: r.order_date,
      product_name: r.card_name || '답례품',
      product_code: r.card_code || null,
      source: 'card',
    })),
    ...etcResult.recordset.map(r => ({
      order_id: 'ETC-' + r.order_seq,
      order_number: 'BHS-' + r.order_seq,
      recipient_name: r.order_name || '',
      recipient_phone: r.order_hphone || '',
      status: r.status_seq >= 1 ? 'collected' : 'cancelled',
      desired_shipping_date: null,
      collected_at: r.order_date,
      product_name: r.card_name || '답례품',
      product_code: r.card_code || null,
      source: 'etc',
    })),
  ].sort((a, b) => new Date(b.collected_at) - new Date(a.collected_at));

  // 발송 이력 조회
  const orderIds = combined.map(o => o.order_id);
  const history = await store.getAlimtalkHistory(orderIds);

  let rows = combined.map(o => {
    const h = history.get(o.order_id);
    return {
      ...o,
      last_alimtalk_sent_at: h?.lastSentAt || null,
      alimtalk_send_count: h?.count || 0,
    };
  });

  // sentStatus 필터
  if (filters.sentStatus === 'sent') {
    rows = rows.filter(r => r.alimtalk_send_count > 0);
  } else if (filters.sentStatus === 'unsent') {
    rows = rows.filter(r => r.alimtalk_send_count === 0);
  }

  // 페이지네이션
  const total = rows.length;
  const offset = (page - 1) * limit;
  const paged = rows.slice(offset, offset + limit);

  return { rows: paged, total };
}

/**
 * 단일 주문 ID로 알림톡 발송.
 * orderId: 'ETC-{seq}' 또는 '{seq}'
 */
async function sendAlimtalkForOrder(pool, sql, orderId) {
  const isEtc = String(orderId).startsWith('ETC-');
  const seq = parseInt(isEtc ? orderId.slice(4) : orderId) || 0;
  if (!seq) {
    return { order_id: orderId, success: false, error: '잘못된 주문번호' };
  }

  // 주문 + 답례품 아이템 확인
  let orderRow;
  let itemName;
  try {
    if (isEtc) {
      const result = await pool.request()
        .input('orderSeq', sql.Int, seq)
        .query(`
          SELECT TOP 1
            co.order_seq, co.order_name, co.order_hphone,
            (SELECT TOP 1 c2.Card_Name FROM CUSTOM_ETC_ORDER_ITEM ei2 WITH (NOLOCK)
             INNER JOIN S2_Card c2 WITH (NOLOCK) ON ei2.card_seq = c2.Card_Seq
             LEFT JOIN S2_CardKind ck2 WITH (NOLOCK) ON c2.Card_Seq = ck2.Card_Seq AND ck2.CardKind_Seq IN (${DAERYEPUM_CARDKIND_SEQS.join(',')})
             WHERE ei2.order_seq = co.order_seq
               AND ${DAERYEPUM_WHERE.replace(/ck\./g, 'ck2.').replace(/c\./g, 'c2.')}
            ) AS card_name
          FROM CUSTOM_ETC_ORDER co WITH (NOLOCK)
          WHERE co.order_seq = @orderSeq
        `);
      orderRow = result.recordset[0];
      itemName = orderRow?.card_name;
    } else {
      const result = await pool.request()
        .input('orderSeq', sql.Int, seq)
        .query(`
          SELECT TOP 1
            co.order_seq, co.order_name, co.order_hphone,
            (SELECT TOP 1 c2.Card_Name FROM custom_order_item coi2 WITH (NOLOCK)
             INNER JOIN S2_Card c2 WITH (NOLOCK) ON coi2.card_seq = c2.Card_Seq
             LEFT JOIN S2_CardKind ck2 WITH (NOLOCK) ON c2.Card_Seq = ck2.Card_Seq AND ck2.CardKind_Seq IN (${DAERYEPUM_CARDKIND_SEQS.join(',')})
             WHERE coi2.order_seq = co.order_seq
               AND ${DAERYEPUM_WHERE.replace(/ck\./g, 'ck2.').replace(/c\./g, 'c2.')}
            ) AS card_name
          FROM custom_order co WITH (NOLOCK)
          WHERE co.order_seq = @orderSeq
        `);
      orderRow = result.recordset[0];
      itemName = orderRow?.card_name;
    }
  } catch (e) {
    return { order_id: orderId, success: false, error: 'DB 조회 실패: ' + e.message };
  }

  if (!orderRow) {
    return { order_id: orderId, success: false, skipped_reason: 'order_not_found' };
  }
  if (!itemName) {
    return { order_id: orderId, success: false, skipped_reason: 'not_daeryepum' };
  }
  if (!orderRow.order_hphone) {
    return { order_id: orderId, success: false, skipped_reason: 'missing_phone' };
  }

  const orderNumber = (isEtc ? 'BHS-' : 'BRS-') + orderRow.order_seq;
  const msg = buildMessagePayload({
    orderId: orderId,
    orderNumber,
    customerName: orderRow.order_name,
    productName: itemName,
  });

  let result;
  try {
    result = await sendAlimtalk({
      to: orderRow.order_hphone,
      templateCode: msg.templateCode,
      text: msg.text,
      buttons: msg.button ? [msg.button] : undefined,
    });
  } catch (e) {
    await store.logAlimtalkSend({
      order_id: orderId,
      to_phone: orderRow.order_hphone,
      template_code: msg.templateCode,
      success: false,
      error_message: e.message,
    });
    return { order_id: orderId, success: false, error: e.message };
  }

  // 이력 저장
  try {
    await store.logAlimtalkSend({
      order_id: orderId,
      to_phone: orderRow.order_hphone,
      template_code: msg.templateCode,
      message_id: result.messageId,
      success: result.success,
      is_mock: result.mock,
      error_code: result.code,
      error_message: result.success ? null : (result.message || result.code),
    });
  } catch (e) {
    console.error('[Alimtalk] log 저장 실패:', e.message);
  }

  if (!result.success) {
    return {
      order_id: orderId,
      success: false,
      mock: result.mock,
      error: result.message || result.code || '발송 실패',
    };
  }

  return {
    order_id: orderId,
    success: true,
    mock: result.mock,
    message_id: result.messageId,
  };
}

module.exports = {
  fetchDaeryepumRecipients,
  sendAlimtalkForOrder,
};
