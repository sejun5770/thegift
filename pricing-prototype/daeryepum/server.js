const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 3457;

// --- MSSQL connection ---
let sql;
try { sql = require('mssql'); } catch { sql = require(path.join(__dirname, '../../node_modules/mssql')); }

const DB_CONFIG = {
  server: 'barun-shopdb.9925ce92729d.database.windows.net',
  port: 1433,
  user: 'readonly_user',
  password: 'barunreadonly12#',
  database: 'bar_shop1',
  options: { encrypt: true, trustServerCertificate: false },
  pool: { max: 5, min: 0, idleTimeoutMillis: 30000 },
  requestTimeout: 60000,
  connectionTimeout: 15000,
};

let pool = null;
async function getPool() {
  if (pool && pool.connected) return pool;
  pool = new sql.ConnectionPool(DB_CONFIG);
  pool.on('error', (err) => { console.error('Pool error:', err.message); pool = null; });
  await pool.connect();
  console.log('Connected to Barunson DB');
  return pool;
}

// D01 category = 답례품
const D01_FILTER = `c.Card_Div = 'D01'`;

// Clean product name (remove [할인], [시크릿특가] etc.)
function cleanName(name) {
  if (!name) return '';
  return name.replace(/^\[.*?\]\s*/g, '');
}

// Format date for SQL (KST timezone)
function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const dd = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${dd}`;
}
function today() {
  // KST = UTC+9
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return new Date(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate());
}
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }

// --- API handlers ---

async function apiOrders(query) {
  const p = await getPool();
  const startDate = query.start_date || fmtDate(addDays(today(), -7));
  const endDate = query.end_date || fmtDate(addDays(today(), 1));

  const result = await p.request()
    .input('startDate', sql.VarChar, startDate)
    .input('endDate', sql.VarChar, endDate)
    .query(`
      -- 부가상품 단독주문 (CUSTOM_ETC_ORDER)
      -- 예식일: member_id → 최근 청첩장주문(custom_order) → custom_order_WeddInfo
      SELECT
        o.order_seq AS order_seq,
        'ETC' AS order_type,
        o.order_date AS order_date,
        o.settle_date AS settle_date,
        o.order_name AS order_name,
        o.recv_name AS recv_name,
        o.recv_hphone AS recv_hphone,
        CONCAT(o.recv_address, ' ', ISNULL(o.recv_address_detail,'')) AS recv_address,
        o.recv_msg AS recv_msg,
        c.Card_Name AS card_name,
        c.Card_Code AS card_code,
        oi.order_count AS item_count,
        oi.card_sale_price AS item_amount,
        o.settle_price AS settle_price,
        o.status_seq AS status_seq,
        cw.event_year + '-' + RIGHT('0'+cw.event_month,2) + '-' + RIGHT('0'+cw.event_Day,2) AS wedding_date
      FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
      INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
      INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
      OUTER APPLY (
        SELECT TOP 1 w2.event_year, w2.event_month, w2.event_Day
        FROM custom_order co2 WITH (NOLOCK)
        INNER JOIN custom_order_WeddInfo w2 WITH (NOLOCK) ON co2.order_seq = w2.order_seq
        WHERE co2.member_id = o.member_id AND co2.status_seq >= 1
          AND w2.event_year IS NOT NULL AND LEN(w2.event_year) = 4
        ORDER BY co2.order_seq DESC
      ) cw
      WHERE ${D01_FILTER}
        AND o.order_date >= @startDate AND o.order_date < @endDate
        AND o.status_seq >= 1

      UNION ALL

      -- 청첩장과 함께 주문 (custom_order)
      SELECT
        co.order_seq,
        'CARD' AS order_type,
        co.order_date,
        co.settle_date,
        co.order_name,
        di.NAME AS recv_name,
        ISNULL(di.HPHONE, di.PHONE) AS recv_hphone,
        CONCAT(ISNULL(di.ADDR,''), ' ', ISNULL(di.ADDR_DETAIL,'')) AS recv_address,
        di.DELIVERY_MEMO AS recv_msg,
        c.Card_Name AS card_name,
        c.Card_Code AS card_code,
        coi.item_count,
        CAST(coi.item_sale_price AS float) * coi.item_count AS item_amount,
        co.settle_price,
        co.status_seq,
        w.event_year + '-' + RIGHT('0'+w.event_month,2) + '-' + RIGHT('0'+w.event_Day,2) AS wedding_date
      FROM custom_order co WITH (NOLOCK)
      INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
      INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
      LEFT JOIN DELIVERY_INFO di WITH (NOLOCK) ON co.order_seq = di.ORDER_SEQ
      LEFT JOIN custom_order_WeddInfo w WITH (NOLOCK) ON co.order_seq = w.order_seq
      WHERE ${D01_FILTER}
        AND co.order_date >= @startDate AND co.order_date < @endDate
        AND co.status_seq >= 1

      ORDER BY order_date DESC, order_seq DESC
    `);

  const rows = result.recordset.map(r => ({
    ...r,
    card_name: cleanName(r.card_name),
    order_date: r.order_date,
    settle_date: r.settle_date,
    // 주문자명/받는사람 합치기
    display_name: mergeNames(r.recv_name, r.order_name),
  }));

  return rows;
}

function mergeNames(recvName, orderName) {
  const r = (recvName || '').trim();
  const o = (orderName || '').trim();
  if (!r && !o) return '';
  if (!r) return o;
  if (!o) return r;
  if (r === o) return r;
  return `${r}(${o})`;
}

async function apiDashboardComparison() {
  const p = await getPool();
  const todayStr = fmtDate(today());
  const tomorrowStr = fmtDate(addDays(today(), 1));
  const yesterdayStr = fmtDate(addDays(today(), -1));
  const lastWeekSameDayStr = fmtDate(addDays(today(), -7));
  const lastWeekSameDayNextStr = fmtDate(addDays(today(), -6));

  // 요일 이름
  const dayNames = ['일','월','화','수','목','금','토'];
  const todayDow = dayNames[today().getDay()];

  // 각 기간별 ETC+CARD 합산 헬퍼
  async function getPeriodTotal(startStr, endStr) {
    const r = await p.request()
      .input('s', sql.VarChar, startStr)
      .input('e', sql.VarChar, endStr)
      .query(`
        SELECT
          COUNT(DISTINCT o.order_seq) AS order_count,
          ISNULL(SUM(oi.card_sale_price),0) AS total_amount,
          ISNULL(SUM(oi.order_count),0) AS total_qty
        FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
        INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
        INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
        WHERE ${D01_FILTER} AND o.order_date >= @s AND o.order_date < @e AND o.status_seq NOT IN (3, 5)
      `);
    const r2 = await p.request()
      .input('s', sql.VarChar, startStr)
      .input('e', sql.VarChar, endStr)
      .query(`
        SELECT
          COUNT(DISTINCT co.order_seq) AS order_count,
          ISNULL(SUM(CAST(coi.item_sale_price AS float) * coi.item_count),0) AS total_amount,
          ISNULL(SUM(coi.item_count),0) AS total_qty
        FROM custom_order co WITH (NOLOCK)
        INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
        INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
        WHERE ${D01_FILTER} AND co.order_date >= @s AND co.order_date < @e AND co.status_seq NOT IN (3, 5)
      `);
    const a = r.recordset[0] || {};
    const b = r2.recordset[0] || {};
    return {
      order_count: (a.order_count||0) + (b.order_count||0),
      total_amount: (a.total_amount||0) + (b.total_amount||0),
      total_qty: (a.total_qty||0) + (b.total_qty||0),
    };
  }

  const [todayTotal, yesterdayTotal, lastWeekTotal] = await Promise.all([
    getPeriodTotal(todayStr, tomorrowStr),
    getPeriodTotal(yesterdayStr, todayStr),
    getPeriodTotal(lastWeekSameDayStr, lastWeekSameDayNextStr),
  ]);

  return {
    today: todayTotal,
    yesterday: yesterdayTotal,
    last_week_same_day: lastWeekTotal,
    date: {
      today: todayStr,
      yesterday: yesterdayStr,
      last_week_same_day: lastWeekSameDayStr,
      today_dow: todayDow,
    },
  };
}

async function apiDashboardSummary(query) {
  const p = await getPool();
  const startDate = query.start_date || fmtDate(addDays(today(), -30));
  const endDate = query.end_date || fmtDate(addDays(today(), 1));

  const result = await p.request()
    .input('startDate', sql.VarChar, startDate)
    .input('endDate', sql.VarChar, endDate)
    .query(`
      SELECT
        c.Card_Name AS card_name,
        c.Card_Code AS card_code,
        CONVERT(varchar(10), o.order_date, 120) AS order_day,
        COUNT(DISTINCT o.order_seq) AS order_count,
        SUM(oi.order_count) AS total_qty,
        SUM(oi.card_sale_price) AS total_amount
      FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
      INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
      INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
      WHERE ${D01_FILTER} AND o.order_date >= @startDate AND o.order_date < @endDate AND o.status_seq NOT IN (3, 5)
      GROUP BY c.Card_Name, c.Card_Code, CONVERT(varchar(10), o.order_date, 120)

      UNION ALL

      SELECT
        c.Card_Name,
        c.Card_Code,
        CONVERT(varchar(10), co.order_date, 120) AS order_day,
        COUNT(DISTINCT co.order_seq),
        SUM(coi.item_count),
        SUM(CAST(coi.item_sale_price AS float) * coi.item_count)
      FROM custom_order co WITH (NOLOCK)
      INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
      INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
      WHERE ${D01_FILTER} AND co.order_date >= @startDate AND co.order_date < @endDate AND co.status_seq NOT IN (3, 5)
      GROUP BY c.Card_Name, c.Card_Code, CONVERT(varchar(10), co.order_date, 120)

      ORDER BY order_day DESC, total_amount DESC
    `);

  // Clean names
  const rows = result.recordset.map(r => ({ ...r, card_name: cleanName(r.card_name) }));
  return rows;
}

async function apiForecast() {
  const p = await getPool();
  const todayStr = fmtDate(today());

  // 회귀 모델 파라미터 (cross-correlation 분석 결과)
  // 답례품 일매출 = 23,161원 × 청첩장 일주문건수(8주전) − 1,126,839원
  const COEFF = 23161;
  const INTERCEPT = -1126839;
  const LAG_DAYS = 56; // 8주
  const R_SQUARED = 0.223;

  // 1) 향후 12주 예측을 위해 과거 4~12주 전 청첩장 일별 주문수 필요
  //    (향후 N주 답례품 = N-8주 전 ~ N-8주+7일 의 청첩장 주문 기반)
  //    즉, 오늘 기준 -56일 ~ +28일 범위의 청첩장 데이터 필요
  const lagStart = fmtDate(addDays(today(), -LAG_DAYS));       // 8주 전
  const lagEnd = fmtDate(addDays(today(), 84 - LAG_DAYS));     // 12주 후 - 8주 lag = 4주 후

  const cardDaily = await p.request()
    .input('lagStart', sql.VarChar, lagStart)
    .input('lagEnd', sql.VarChar, lagEnd)
    .query(`
      SELECT
        CONVERT(varchar(10), order_date, 120) AS order_day,
        COUNT(DISTINCT order_seq) AS daily_orders
      FROM custom_order WITH (NOLOCK)
      WHERE order_date >= @lagStart AND order_date < @lagEnd
        AND status_seq >= 1
      GROUP BY CONVERT(varchar(10), order_date, 120)
      ORDER BY order_day
    `);

  // 일별 청첩장 주문수 맵
  const cardDailyMap = {};
  for (const r of cardDaily.recordset) { cardDailyMap[r.order_day] = r.daily_orders; }

  // 2) 주차별 예측 계산 (월~일 기준)
  // 이번 주 월요일 구하기
  const todayDate = today();
  const dayOfWeek = todayDate.getDay(); // 0=일, 1=월, ..., 6=토
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek; // 일요일이면 -6, 아니면 1-요일
  const thisMonday = addDays(todayDate, mondayOffset);

  const weeks = [];
  for (let w = 0; w < 12; w++) {
    const weekStart = addDays(thisMonday, w * 7);        // 월요일
    const weekEnd = addDays(thisMonday, w * 7 + 6);      // 일요일

    // 이 주차에 대응하는 청첩장 주문 기간 (8주 전)
    let totalCardOrders = 0;
    let dayCount = 0;
    for (let d = 0; d < 7; d++) {
      const targetDay = addDays(weekStart, d - LAG_DAYS);
      const key = fmtDate(targetDay);
      totalCardOrders += cardDailyMap[key] || 0;
      if (cardDailyMap[key] !== undefined) dayCount++;
    }
    const avgDailyCard = dayCount > 0 ? totalCardOrders / dayCount : 0;

    // 회귀 모델 적용 (일매출 × 7일)
    const dailyRevenue = Math.max(0, COEFF * avgDailyCard + INTERCEPT);
    const weeklyRevenue = Math.round(dailyRevenue * 7);

    const weekNo = getISOWeek(weekStart);
    weeks.push({
      week_no: weekNo,
      week_start: fmtDate(weekStart),
      week_end: fmtDate(weekEnd),
      card_orders_in_lag: totalCardOrders,
      avg_daily_card: Math.round(avgDailyCard * 10) / 10,
      est_daily_revenue: Math.round(dailyRevenue),
      est_weekly_revenue: weeklyRevenue,
      has_data: dayCount > 0,
    });
  }

  // 3) 주차별 실제 매출 조회 (ETC + CARD 합산)
  const actualWeeklyStart = fmtDate(addDays(thisMonday, -7 * 4)); // 4주 전부터
  const actualWeeklyEnd = fmtDate(addDays(todayDate, 1));

  const actualWeekly = await p.request()
    .input('awStart', sql.VarChar, actualWeeklyStart)
    .input('awEnd', sql.VarChar, actualWeeklyEnd)
    .query(`
      SELECT
        CONVERT(varchar(10), o.order_date, 120) AS order_day,
        COUNT(DISTINCT o.order_seq) AS order_count,
        ISNULL(SUM(oi.card_sale_price),0) AS total_amount,
        ISNULL(SUM(oi.order_count),0) AS total_qty
      FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
      INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
      INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
      WHERE ${D01_FILTER} AND o.order_date >= @awStart AND o.order_date < @awEnd AND o.status_seq NOT IN (3, 5)
      GROUP BY CONVERT(varchar(10), o.order_date, 120)

      UNION ALL

      SELECT
        CONVERT(varchar(10), co.order_date, 120),
        COUNT(DISTINCT co.order_seq),
        ISNULL(SUM(CAST(coi.item_sale_price AS float) * coi.item_count),0),
        ISNULL(SUM(coi.item_count),0)
      FROM custom_order co WITH (NOLOCK)
      INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
      INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
      WHERE ${D01_FILTER} AND co.order_date >= @awStart AND co.order_date < @awEnd AND co.status_seq NOT IN (3, 5)
      GROUP BY CONVERT(varchar(10), co.order_date, 120)
    `);

  // 일별 실제 매출 맵 (ETC+CARD 합산)
  const actualDailyMap = {};
  for (const r of actualWeekly.recordset) {
    if (!actualDailyMap[r.order_day]) actualDailyMap[r.order_day] = { amount: 0, orders: 0, qty: 0 };
    actualDailyMap[r.order_day].amount += r.total_amount || 0;
    actualDailyMap[r.order_day].orders += r.order_count || 0;
    actualDailyMap[r.order_day].qty += r.total_qty || 0;
  }

  // 각 주차에 실제 매출 매핑
  for (const w of weeks) {
    let actAmount = 0, actOrders = 0, actQty = 0, actDays = 0;
    for (let d = 0; d < 7; d++) {
      const key = fmtDate(addDays(new Date(w.week_start), d));
      const isPast = new Date(key) < todayDate;
      if (isPast && actualDailyMap[key]) {
        actAmount += actualDailyMap[key].amount;
        actOrders += actualDailyMap[key].orders;
        actQty += actualDailyMap[key].qty;
        actDays++;
      } else if (isPast) {
        actDays++; // 과거인데 매출 0인 날도 카운트
      }
    }
    w.actual_weekly_revenue = Math.round(actAmount);
    w.actual_orders = actOrders;
    w.actual_qty = actQty;
    w.actual_days = actDays; // 경과일 수 (7이면 완료된 주)
    w.is_past = actDays >= 7;
    w.is_current = actDays > 0 && actDays < 7;
    // 오차율 (완료된 주만)
    w.accuracy_pct = (w.is_past && w.est_weekly_revenue > 0)
      ? Math.round((w.actual_weekly_revenue - w.est_weekly_revenue) / w.est_weekly_revenue * 100)
      : null;
  }

  // 4) 실제 최근 일평균 매출 (검증용)
  const actualStats = await p.request()
    .input('start30', sql.VarChar, fmtDate(addDays(today(), -30)))
    .input('today', sql.VarChar, todayStr)
    .query(`
      SELECT
        COUNT(DISTINCT o.order_seq) AS total_orders,
        ISNULL(SUM(oi.card_sale_price),0) AS total_amount,
        COUNT(DISTINCT CONVERT(varchar(10), o.order_date, 120)) AS active_days
      FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
      INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
      INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
      WHERE ${D01_FILTER} AND o.order_date >= @start30 AND o.order_date < DATEADD(day,1,@today) AND o.status_seq NOT IN (3, 5)
    `);

  const actual = actualStats.recordset[0] || {};
  const actualDailyAvg = actual.active_days > 0 ? Math.round(actual.total_amount / actual.active_days) : 0;

  return {
    model: { coefficient: COEFF, intercept: INTERCEPT, lag_days: LAG_DAYS, r_squared: R_SQUARED },
    weeks,
    actual_30d: {
      daily_avg_revenue: actualDailyAvg,
      total_orders: actual.total_orders || 0,
      total_amount: actual.total_amount || 0,
      active_days: actual.active_days || 0,
    },
  };
}

function getISOWeek(d) {
  const date = new Date(d.getTime());
  date.setHours(0,0,0,0);
  date.setDate(date.getDate() + 3 - (date.getDay() + 6) % 7);
  const week1 = new Date(date.getFullYear(), 0, 4);
  return 1 + Math.round(((date - week1) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);
}

async function apiLeadtime() {
  const p = await getPool();
  const result = await p.request().query(`
    SELECT TOP 1000
      o.order_seq,
      o.order_date,
      TRY_CAST(cw.event_year+'-'+RIGHT('0'+cw.event_month,2)+'-'+RIGHT('0'+cw.event_Day,2) AS date) AS wedding_date,
      DATEDIFF(day, o.order_date, TRY_CAST(cw.event_year+'-'+RIGHT('0'+cw.event_month,2)+'-'+RIGHT('0'+cw.event_Day,2) AS date)) AS lead_days
    FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
    INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
    INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
    CROSS APPLY (
      SELECT TOP 1 w2.event_year, w2.event_month, w2.event_Day
      FROM custom_order co2 WITH (NOLOCK)
      INNER JOIN custom_order_WeddInfo w2 WITH (NOLOCK) ON co2.order_seq = w2.order_seq
      WHERE co2.member_id = o.member_id AND co2.status_seq >= 1
        AND w2.event_year IS NOT NULL AND LEN(w2.event_year) = 4
      ORDER BY co2.order_seq DESC
    ) cw
    WHERE ${D01_FILTER} AND o.status_seq >= 1
      AND TRY_CAST(cw.event_year+'-'+RIGHT('0'+cw.event_month,2)+'-'+RIGHT('0'+cw.event_Day,2) AS date) IS NOT NULL
      AND o.order_date >= DATEADD(day, -180, GETDATE())
    ORDER BY o.order_date DESC
  `);

  const allDays = result.recordset.map(r => r.lead_days).filter(d => d !== null && d > -365 && d < 365);
  const positiveDays = allDays.filter(d => d >= 0);
  const avg = positiveDays.length ? Math.round(positiveDays.reduce((a,b) => a+b, 0) / positiveDays.length) : 0;
  const sorted = [...positiveDays].sort((a,b) => a-b);
  const median = sorted.length ? sorted[Math.floor(sorted.length/2)] : 0;

  // 분포 (마이너스 = 예식 후 주문 포함)
  const buckets = {
    '예식후(-)':0, '0-7일':0, '8-14일':0, '15-21일':0,
    '22-30일':0, '31-60일':0, '60일+':0
  };
  for (const d of allDays) {
    if (d < 0) buckets['예식후(-)']++;
    else if (d <= 7) buckets['0-7일']++;
    else if (d <= 14) buckets['8-14일']++;
    else if (d <= 21) buckets['15-21일']++;
    else if (d <= 30) buckets['22-30일']++;
    else if (d <= 60) buckets['31-60일']++;
    else buckets['60일+']++;
  }

  return { avg_days: avg, median_days: median, total_samples: allDays.length, distribution: buckets };
}

async function apiMarketing() {
  const p = await getPool();

  // 1) 시간대별 주문 분포
  const hourly = await p.request().query(`
    SELECT DATEPART(hour, o.order_date) AS hr, COUNT(DISTINCT o.order_seq) AS cnt
    FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
    INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
    INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
    WHERE ${D01_FILTER} AND o.status_seq NOT IN (3, 5) AND o.order_date >= DATEADD(day,-90,GETDATE())
    GROUP BY DATEPART(hour, o.order_date)
    ORDER BY hr
  `);

  // 2) 요일별 주문 분포
  const weekly = await p.request().query(`
    SELECT DATEPART(weekday, o.order_date) AS dow, COUNT(DISTINCT o.order_seq) AS cnt
    FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
    INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
    INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
    WHERE ${D01_FILTER} AND o.status_seq NOT IN (3, 5) AND o.order_date >= DATEADD(day,-90,GETDATE())
    GROUP BY DATEPART(weekday, o.order_date)
    ORDER BY dow
  `);

  // 3) 지역별 (ETC 단독주문)
  const region = await p.request().query(`
    SELECT TOP 12
      LEFT(o.recv_address, CHARINDEX(' ', o.recv_address + ' ') - 1) AS region,
      COUNT(DISTINCT o.order_seq) AS cnt
    FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
    INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
    INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
    WHERE ${D01_FILTER} AND o.status_seq NOT IN (3, 5) AND o.order_date >= DATEADD(day,-90,GETDATE())
      AND o.recv_address IS NOT NULL AND LEN(o.recv_address) > 2
    GROUP BY LEFT(o.recv_address, CHARINDEX(' ', o.recv_address + ' ') - 1)
    ORDER BY cnt DESC
  `);

  // 4) 전환율 (2단계 - 답례품 구매자 member_id → 청첩장 주문자 교차)
  const giftMembers = await p.request().query(`
    SELECT DISTINCT o.member_id
    FROM CUSTOM_ETC_ORDER o WITH (NOLOCK)
    INNER JOIN CUSTOM_ETC_ORDER_ITEM oi WITH (NOLOCK) ON o.order_seq = oi.order_seq
    INNER JOIN S2_Card c WITH (NOLOCK) ON oi.card_seq = c.Card_Seq
    WHERE ${D01_FILTER} AND o.status_seq NOT IN (3, 5) AND o.order_date >= DATEADD(day,-90,GETDATE())
      AND o.member_id IS NOT NULL AND o.member_id != ''
  `);
  const giftSet = new Set(giftMembers.recordset.map(r => r.member_id));

  const cardMembers = await p.request().query(`
    SELECT DISTINCT co.member_id
    FROM custom_order co WITH (NOLOCK)
    INNER JOIN custom_order_item coi WITH (NOLOCK) ON co.order_seq = coi.order_seq
    INNER JOIN S2_Card c WITH (NOLOCK) ON coi.card_seq = c.Card_Seq
    WHERE c.Card_Div = 'A01' AND co.status_seq NOT IN (3, 5) AND co.order_date >= DATEADD(day,-90,GETDATE())
      AND co.member_id IS NOT NULL AND co.member_id != ''
  `);
  const cardSet = new Set(cardMembers.recordset.map(r => r.member_id));

  let crossCount = 0;
  for (const m of giftSet) { if (cardSet.has(m)) crossCount++; }

  const conversion = {
    card_members: cardSet.size,
    gift_members: giftSet.size,
    cross_buy: crossCount,
    card_to_gift_pct: cardSet.size ? +(crossCount / cardSet.size * 100).toFixed(1) : 0,
    gift_has_card_pct: giftSet.size ? +(crossCount / giftSet.size * 100).toFixed(1) : 0,
    gift_only: giftSet.size - crossCount,
    gift_only_pct: giftSet.size ? +((giftSet.size - crossCount) / giftSet.size * 100).toFixed(1) : 0,
  };

  // 시간대 정리 (0~23시 전체)
  const hourMap = {};
  for (let i = 0; i < 24; i++) hourMap[i] = 0;
  hourly.recordset.forEach(r => { hourMap[r.hr] = r.cnt; });

  // 요일 정리
  const dayNames = ['','일','월','화','수','목','금','토'];
  const dayMap = {};
  for (let i = 1; i <= 7; i++) dayMap[dayNames[i]] = 0;
  weekly.recordset.forEach(r => { dayMap[dayNames[r.dow]] = r.cnt; });

  return {
    hourly: hourMap,
    weekly: dayMap,
    region: region.recordset,
    conversion,
    period: '최근 90일',
  };
}

// --- HTTP Server ---
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // API routes
  if (pathname.startsWith('/api/')) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    try {
      let data;
      if (pathname === '/api/orders') {
        data = await apiOrders(parsed.query);
      } else if (pathname === '/api/dashboard/comparison') {
        data = await apiDashboardComparison();
      } else if (pathname === '/api/dashboard/summary') {
        data = await apiDashboardSummary(parsed.query);
      } else if (pathname === '/api/dashboard/forecast') {
        data = await apiForecast();
      } else if (pathname === '/api/dashboard/leadtime') {
        data = await apiLeadtime();
      } else if (pathname === '/api/dashboard/marketing') {
        data = await apiMarketing();
      } else {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Not found' }));
        return;
      }
      res.writeHead(200);
      res.end(JSON.stringify(data));
    } catch (err) {
      console.error('API Error:', err);
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Static files
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.join(__dirname, filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' };
  const contentType = mimeTypes[ext] || 'application/octet-stream';

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    res.writeHead(200, { 'Content-Type': contentType + '; charset=utf-8' });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`답례품 관리 서버: http://localhost:${PORT}`);
});
