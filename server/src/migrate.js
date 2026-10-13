import 'dotenv/config';
import { readFile } from 'node:fs/promises';
// Use Neon’s direct connection for schema changes; the app’s DATABASE_URL is
// the pooled URL intended for normal requests.
process.env.DATABASE_URL = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
const { pool, query } = await import('./db.js');

try {
  const schema = await readFile(new URL('../sql/001_initial.sql', import.meta.url), 'utf8');
  await query(schema);
  console.log('Base de datos de Tably preparada.');
} finally {
  await pool.end();
}
