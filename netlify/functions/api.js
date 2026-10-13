import { readFile } from 'node:fs/promises';
import path from 'node:path';
import serverless from 'serverless-http';
import app from '../../server/src/app.js';
import { query } from '../../server/src/db.js';

const initializeDatabase = readFile(
  path.join(process.cwd(), 'server/sql/001_initial.sql'),
  'utf8',
).then((schema) => query(schema));

const proxy = serverless(app);

export async function handler(event, context) {
  process.env.PUBLIC_URL ||= process.env.URL || `https://${event.headers?.host}`;
  await initializeDatabase;
  return proxy(event, context);
}
