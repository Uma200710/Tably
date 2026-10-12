import 'dotenv/config';
import app from './app.js';
import { pool, query } from './db.js';
import { readFile } from 'node:fs/promises';

if (!process.env.PUBLIC_URL && process.env.RENDER_EXTERNAL_URL) {
  process.env.PUBLIC_URL = process.env.RENDER_EXTERNAL_URL.replace(/\/$/, '');
}

const required = ['DATABASE_URL', 'JWT_SECRET', 'TOKEN_ENCRYPTION_KEY_BASE64', 'PUBLIC_URL'];
const missing = required.filter((name) => !process.env[name]);
if (missing.length) throw new Error(`Faltan variables de entorno: ${missing.join(', ')}`);
if (process.env.JWT_SECRET.length < 32) throw new Error('JWT_SECRET debe tener al menos 32 caracteres.');
if (Buffer.from(process.env.TOKEN_ENCRYPTION_KEY_BASE64, 'base64').length !== 32) {
  throw new Error('TOKEN_ENCRYPTION_KEY_BASE64 debe contener 32 bytes codificados en Base64.');
}
if (process.env.NODE_ENV === 'production' && !process.env.PUBLIC_URL.startsWith('https://')) {
  throw new Error('PUBLIC_URL debe usar HTTPS en producción.');
}

const schema = await readFile(new URL('../sql/001_initial.sql', import.meta.url), 'utf8');
await query(schema);
const server = app.listen(Number(process.env.PORT || 3000), () => {
  console.log(`Tably escuchando en ${process.env.PUBLIC_URL}`);
});

async function shutdown() {
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);