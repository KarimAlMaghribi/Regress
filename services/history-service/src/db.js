import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config({ path: process.env.CONFIG || undefined });

const { DATABASE_URL } = process.env;

const pool = new pg.Pool({ connectionString: DATABASE_URL });

export async function init() {
  try {
    await pool.query('SELECT 1');
    console.log('database connection established');
  } catch (e) {
    console.error('database connection failed', e);
    throw e;
  }
  await pool.query(`CREATE TABLE IF NOT EXISTS classification_history (
    id TEXT PRIMARY KEY,
    prompt TEXT,
    result JSONB,
    pdf_url TEXT,
    timestamp TIMESTAMPTZ,
    status TEXT DEFAULT 'running'
  )`);
  await pool.query(
    `ALTER TABLE classification_history ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'running'`
  );
  console.log('database schema ensured');
}

export async function markPending({ id, prompt, pdfUrl, timestamp }) {
  try {
    await pool.query(
      `INSERT INTO classification_history(id, prompt, pdf_url, timestamp, status)
       VALUES ($1,$2,$3,$4,'running')
       ON CONFLICT (id) DO UPDATE SET
         prompt = EXCLUDED.prompt,
         pdf_url = EXCLUDED.pdf_url,
         timestamp = EXCLUDED.timestamp,
         status = 'running'`,
      [id, prompt, pdfUrl, timestamp]
    );
    console.log('pending entry stored', id);
  } catch (e) {
    console.error('failed to store pending entry', id, e);
  }
}

export async function insertResult(entry) {
  const { id, prompt, result, pdfUrl, timestamp } = entry;
  try {
    await pool.query(
      `INSERT INTO classification_history(id, prompt, result, pdf_url, timestamp, status)
       VALUES ($1,$2,$3,$4,$5,'completed')
       ON CONFLICT (id) DO UPDATE SET
         prompt = EXCLUDED.prompt,
         result = EXCLUDED.result,
         pdf_url = EXCLUDED.pdf_url,
         timestamp = EXCLUDED.timestamp,
         status = 'completed'`,
      [id, prompt, result, pdfUrl, timestamp]
    );
    console.log('result entry stored', id);
  } catch (e) {
    console.error('failed to store result entry', id, e);
  }
}

export async function latest(limit = 50) {
  const { rows } = await pool.query(
    'SELECT * FROM classification_history ORDER BY timestamp DESC LIMIT $1',
    [limit]
  );
  console.log('latest results fetched', rows.length);
  return rows;
}

export async function listByStatus(status) {
  const query = status
    ? 'SELECT * FROM classification_history WHERE status = $1 ORDER BY timestamp DESC'
    : 'SELECT * FROM classification_history ORDER BY timestamp DESC';
  const params = status ? [status] : [];
  const { rows } = await pool.query(query, params);
  console.log('listByStatus', status || 'all', 'rows', rows.length);
  return rows;
}
