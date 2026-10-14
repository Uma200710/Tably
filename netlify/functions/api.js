import { readFile } from 'node:fs/promises';
import path from 'node:path';
import serverless from 'serverless-http';

let proxy;
let initializeDatabase;

export async function handler(event, context) {
  // NETLIFY is not guaranteed to be present in the Functions runtime. Set the
  // driver choice before loading modules that create the database pool.
  process.env.TABLY_DB_DRIVER = 'neon';
  process.env.PUBLIC_URL ||= process.env.URL || `https://${event.headers?.host}`;

  if (!process.env.DATABASE_URL) throw new Error('Falta configurar DATABASE_URL en las variables de Netlify.');
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    throw new Error('JWT_SECRET debe tener al menos 32 caracteres en las variables de Netlify.');
  }

  const [{ default: app }, { query }] = await Promise.all([
    import('../../server/src/app.js'),
    import('../../server/src/db.js'),
  ]);
  proxy ||= serverless(app);
  initializeDatabase ||= readFile(
    path.join(process.cwd(), 'server/sql/001_initial.sql'),
    'utf8',
  ).then((schema) => query(schema));

  await initializeDatabase;
  return proxy(event, context);
}
