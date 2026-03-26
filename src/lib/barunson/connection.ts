import sql from 'mssql';

let pool: sql.ConnectionPool | null = null;

function getConfig(): sql.config {
  const server = process.env.BARUNSON_DB_SERVER;
  const user = process.env.BARUNSON_DB_USER;
  const password = process.env.BARUNSON_DB_PASSWORD;
  const database = process.env.BARUNSON_DB_NAME || 'bar_shop1';
  const port = parseInt(process.env.BARUNSON_DB_PORT || '1433');

  if (!server || !user || !password) {
    throw new Error(
      'Barunson DB 환경변수가 설정되지 않았습니다. ' +
      'BARUNSON_DB_SERVER, BARUNSON_DB_USER, BARUNSON_DB_PASSWORD를 확인하세요.'
    );
  }

  return {
    server,
    port,
    user,
    password,
    database,
    options: {
      encrypt: true,
      trustServerCertificate: false,
    },
    pool: {
      max: 5,
      min: 0,
      idleTimeoutMillis: 30000,
    },
    requestTimeout: 30000,
    connectionTimeout: 15000,
  };
}

export async function getBarunsonPool(): Promise<sql.ConnectionPool> {
  if (pool && pool.connected) {
    return pool;
  }

  const config = getConfig();
  pool = new sql.ConnectionPool(config);

  pool.on('error', (err) => {
    console.error('[Barunson DB] Pool error:', err.message);
    pool = null;
  });

  await pool.connect();
  return pool;
}

export async function closeBarunsonPool(): Promise<void> {
  if (pool) {
    await pool.close();
    pool = null;
  }
}
