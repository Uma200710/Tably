import pg from 'pg';
import { Pool as NeonPool } from '@neondatabase/serverless';

// Netlify functions use Neon’s WebSocket driver. Local development keeps using
// node-postgres, so Docker Compose remains the normal local database option.
const Pool = process.env.NETLIFY ? NeonPool : pg.Pool;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : undefined,
  max: process.env.NETLIFY ? 1 : 10,
  idleTimeoutMillis: 30_000,
});

export function query(text, values) {
  return pool.query(text, values);
}
