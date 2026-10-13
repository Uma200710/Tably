import pg from 'pg';

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : undefined,
  max: process.env.NETLIFY ? 1 : 10,
  idleTimeoutMillis: 30_000,
});

export function query(text, values) {
  return pool.query(text, values);
}
