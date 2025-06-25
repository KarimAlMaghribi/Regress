import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config({ path: process.env.CONFIG || undefined });

const { DATABASE_URL } = process.env;

const pool = new pg.Pool({ connectionString: DATABASE_URL });

export async function init() {
  await pool.query(`CREATE TABLE IF NOT EXISTS classification_history (
    id TEXT PRIMARY KEY,
    prompt TEXT,
    result JSONB,
    pdf_url TEXT,
    timestamp TIMESTAMPTZ
  )`);
}

export async function insert(entry) {
  const { id, prompt, result, pdfUrl, timestamp } = entry;
  await pool.query(
    `INSERT INTO classification_history(id, prompt, result, pdf_url, timestamp)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (id) DO UPDATE SET
       prompt = EXCLUDED.prompt,
       result = EXCLUDED.result,
       pdf_url = EXCLUDED.pdf_url,
       timestamp = EXCLUDED.timestamp`,
    [id, prompt, result, pdfUrl, timestamp]
  );
}

export async function latest(limit = 50) {
  const { rows } = await pool.query(
    'SELECT * FROM classification_history ORDER BY timestamp DESC LIMIT $1',
    [limit]
  );
  return rows;
}
