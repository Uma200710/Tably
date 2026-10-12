import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { pool, query } from './db.js';

try {
  const schema = await readFile(new URL('../sql/001_initial.sql', import.meta.url), 'utf8');
  await query(schema);
  console.log('Base de datos de Tably preparada.');
} finally {
  await pool.end();
}