import pg from 'pg';
import { Pool as NeonPool } from '@neondatabase/serverless';

// Netlify functions set this before importing the app. Local development and
// Render continue to use node-postgres.
const useNeonPool = process.env.TABLY_DB_DRIVER === 'neon' || process.env.NETLIFY === 'true';
const Pool = useNeonPool ? NeonPool : pg.Pool;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : undefined,
  max: useNeonPool ? 1 : 10,
  idleTimeoutMillis: 30_000,
});

export function query(text, values) {
  return pool.query(text, values);
}
