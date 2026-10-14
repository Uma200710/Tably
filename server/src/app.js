import 'dotenv/config';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import QRCode from 'qrcode';
import { z } from 'zod';
import { query } from './db.js';
import { issuePlatformSession, issueSession, requireAuth, requirePlatformAdmin } from './security.js';

const app = express();
const root = process.cwd();
const webRoot = path.join(root, 'web');
const authLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: 'draft-7' });
const serviceUnavailableMessage = '¡Lo sentimos! Este servicio no está disponible ahora mismo.';
const registerSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().email().max(254),
  password: z.string().min(10).max(72),
  tableCount: z.coerce.number().int().min(1).max(200),
});
const loginSchema = z.object({ email: z.string().trim().email(), password: z.string().min(1).max(72) });
const platformLoginSchema = z.object({ email: z.string().trim().email().max(254), password: z.string().min(1).max(256) });
const menuItemSchema = z.object({
  category: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(240).default(''),
  priceArs: z.coerce.number().int().min(1).max(100_000_000),
  active: z.boolean().default(true),
});

app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false);
app.use(helmet({ crossOriginResourcePolicy: { policy: 'same-site' } }));
app.use(express.json({ limit: '64kb' }));
app.use(cookieParser());
app.use((req, res, next) => {
  const origin = req.get('origin');
  if (origin && origin !== process.env.PUBLIC_URL) return res.status(403).json({ error: 'Origen no permitido.' });
  next();
});

function fail(res, error) {
  const status = Number.isInteger(error.status) ? error.status : 500;
  if (status >= 500) console.error(error.message);
  return res.status(status).json({ error: status >= 500 ? 'No se pudo completar la operación.' : error.message });
}

function slugify(value) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
}

function setSession(res, restaurantId) {
  res.cookie('tably_session', issueSession(restaurantId), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

function setPlatformSession(res, email) {
  res.cookie('tably_session', issuePlatformSession(email), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

async function requireEnabledRestaurant(req, res, next) {
  try {
    const result = await query('SELECT is_enabled FROM restaurants WHERE id = $1', [req.restaurantId]);
    if (!result.rowCount) return res.status(401).json({ error: 'La cuenta ya no existe.' });
    if (!result.rows[0].is_enabled) {
      return res.status(403).json({ code: 'ACCOUNT_DISABLED', error: 'Esta cuenta está deshabilitada. Contactá a Tably.' });
    }
    next();
  } catch (error) {
    next(error);
  }
}

function serviceUnavailable(res) {
  return res.status(503).set('Cache-Control', 'no-store').json({ code: 'CAFE_UNAVAILABLE', error: serviceUnavailableMessage });
}

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.post('/api/auth/register', authLimiter, async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Revisá el nombre, email, contraseña y cantidad de mesas.' });
  const { name, email, password, tableCount } = parsed.data;
  const restaurantId = randomUUID();
  const slug = `${slugify(name) || 'cafe'}-${randomBytes(3).toString('hex')}`;
  const passwordHash = await bcrypt.hash(password, 12);
  const plan = tableCount > 15 ? 'ampliado' : 'base';
  const client = await (await import('./db.js')).pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO restaurants (id, slug, name, email, password_hash, table_count, plan)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [restaurantId, slug, name, email.toLowerCase(), passwordHash, tableCount, plan],
    );
    const seed = [
      ['Café', 'Espresso', 'Doble, tueste medio', 3200],
      ['Café', 'Flat white', 'Leche texturizada, doble shot', 4800],
      ['Café', 'Cold brew', 'Infusión en frío', 5200],
      ['Pastelería', 'Medialuna de manteca', 'Horneada en el día', 1600],
      ['Pastelería', 'Budín de limón', 'Con glaseado', 4200],
      ['Pastelería', 'Cheesecake', 'Salsa de frutos rojos', 6900],
      ['Salado', 'Tostado de jamón y queso', 'Pan de campo', 8900],
      ['Salado', 'Avocado toast', 'Con huevo poché', 10500],
    ];
    for (const [category, itemName, description, price] of seed) {
      await client.query(
        `INSERT INTO menu_items (id, restaurant_id, category, name, description, price_ars)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [randomUUID(), restaurantId, category, itemName, description, price],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') return res.status(409).json({ error: 'Ya existe una cuenta con ese email.' });
    throw error;
  } finally {
    client.release();
  }
  setSession(res, restaurantId);
  res.status(201).json({ id: restaurantId, slug, name, email: email.toLowerCase(), tableCount, plan });
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Email o contraseña incorrectos.' });
  const result = await query('SELECT id, email, password_hash, is_enabled FROM restaurants WHERE email = $1', [parsed.data.email.toLowerCase()]);
  const restaurant = result.rows[0];
  if (!restaurant || !(await bcrypt.compare(parsed.data.password, restaurant.password_hash))) {
    return res.status(401).json({ error: 'Email o contraseña incorrectos.' });
  }
  if (!restaurant.is_enabled) {
    return res.status(403).json({ code: 'ACCOUNT_DISABLED', error: 'Esta cuenta está deshabilitada. Contactá a Tably.' });
  }
  setSession(res, restaurant.id);
  res.json({ ok: true });
});

app.post('/api/auth/logout', (_req, res) => {
  res.clearCookie('tably_session', { httpOnly: true, sameSite: 'lax', path: '/' });
  res.sendStatus(204);
});

app.post('/api/platform/auth/login', authLimiter, (req, res) => {
  const parsed = platformLoginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Email o contraseña incorrectos.' });
  const configuredEmail = process.env.PLATFORM_ADMIN_EMAIL?.trim().toLowerCase();
  const configuredPassword = process.env.PLATFORM_ADMIN_PASSWORD || '';
  const submittedEmail = parsed.data.email.toLowerCase();
  const submittedBytes = Buffer.from(parsed.data.password);
  const configuredBytes = Buffer.from(configuredPassword);
  const passwordMatches = configuredBytes.length > 0 && submittedBytes.length === configuredBytes.length
    && timingSafeEqual(submittedBytes, configuredBytes);
  if (!configuredEmail || !configuredPassword || submittedEmail !== configuredEmail || !passwordMatches) {
    return res.status(401).json({ error: 'Email o contraseña incorrectos.' });
  }
  setPlatformSession(res, configuredEmail);
  res.json({ ok: true });
});

app.get('/api/platform/auth/me', requirePlatformAdmin, (req, res) => res.json({ email: req.platformAdminEmail }));

app.get('/api/platform/subscriptions', requirePlatformAdmin, async (_req, res) => {
  const result = await query(
    `SELECT id, name, email, table_count AS "tableCount", plan,
            subscription_status AS "subscriptionStatus", subscription_due_at AS "subscriptionDueAt",
            subscription_paid_at AS "subscriptionPaidAt", created_at AS "createdAt", is_enabled AS enabled
     FROM restaurants ORDER BY subscription_due_at ASC, name ASC`,
  );
  res.json(result.rows);
});

app.patch('/api/platform/subscriptions/:id/access', requirePlatformAdmin, async (req, res) => {
  const parsed = z.object({ enabled: z.boolean() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'El estado de acceso no es válido.' });
  const result = await query(
    'UPDATE restaurants SET is_enabled = $1 WHERE id = $2 RETURNING id, is_enabled AS enabled',
    [parsed.data.enabled, req.params.id],
  );
  if (!result.rowCount) return res.status(404).json({ error: 'No encontramos ese café.' });
  res.json(result.rows[0]);
});

app.post('/api/platform/subscriptions/:id/paid', requirePlatformAdmin, async (req, res) => {
  const result = await query(
    `UPDATE restaurants SET subscription_status = 'authorized', subscription_paid_at = NOW(),
       subscription_due_at = NOW() + INTERVAL '1 month'
     WHERE id = $1 RETURNING id`,
    [req.params.id],
  );
  if (!result.rowCount) return res.status(404).json({ error: 'No encontramos ese café.' });
  res.sendStatus(204);
});

app.patch('/api/platform/subscriptions/:id', requirePlatformAdmin, async (req, res) => {
  const statuses = ['trial', 'pending', 'authorized', 'cancelled', 'paused'];
  const { status, dueAt } = req.body || {};
  if (!statuses.includes(status) || typeof dueAt !== 'string' || Number.isNaN(Date.parse(dueAt))) {
    return res.status(400).json({ error: 'El estado o la fecha de vencimiento no son válidos.' });
  }
  const result = await query(
    `UPDATE restaurants SET subscription_status = $1, subscription_due_at = $2,
       subscription_paid_at = CASE WHEN $1 = 'authorized' THEN COALESCE(subscription_paid_at, NOW()) ELSE subscription_paid_at END
     WHERE id = $3 RETURNING id`,
    [status, dueAt, req.params.id],
  );
  if (!result.rowCount) return res.status(404).json({ error: 'No encontramos ese café.' });
  res.sendStatus(204);
});

app.get('/api/auth/me', requireAuth, requireEnabledRestaurant, async (req, res) => {
  const result = await query(
    `SELECT id, slug, name, email, table_count AS "tableCount", plan, subscription_status AS "subscriptionStatus",
            subscription_due_at AS "subscriptionDueAt"
     FROM restaurants WHERE id = $1`,
    [req.restaurantId],
  );
  if (!result.rowCount) return res.status(401).json({ error: 'La cuenta ya no existe.' });
  res.json(result.rows[0]);
});

app.get('/api/public/:slug', async (req, res) => {
  const table = Number(req.query.table);
  const restaurantResult = await query(
    'SELECT id, slug, name, table_count, is_enabled FROM restaurants WHERE slug = $1',
    [req.params.slug],
  );
  const restaurant = restaurantResult.rows[0];
  if (!restaurant) return res.status(404).json({ error: 'No encontramos este local.' });
  if (!restaurant.is_enabled) return serviceUnavailable(res);
  if (!Number.isInteger(table) || table < 1 || table > restaurant.table_count) {
    return res.status(404).json({ error: 'La mesa del enlace no es válida.' });
  }
  const menu = await query(
    `SELECT id, category, name, description, price_ars AS "priceArs"
     FROM menu_items WHERE restaurant_id = $1 AND active = TRUE ORDER BY category, name`,
    [restaurant.id],
  );
  res.set('Cache-Control', 'no-store').json({ restaurant: { slug: restaurant.slug, name: restaurant.name }, table, items: menu.rows });
});

app.post('/api/public/:slug/orders', async (req, res) => {
  const table = Number(req.body.table);
  const method = req.body.method;
  const requested = Array.isArray(req.body.items) ? req.body.items : [];
  if (!Number.isInteger(table) || !['cash', 'card'].includes(method) || !requested.length || requested.length > 30) {
    return res.status(400).json({ error: 'El pedido o el medio de pago no son válidos.' });
  }
  const restaurantResult = await query('SELECT * FROM restaurants WHERE slug = $1', [req.params.slug]);
  const restaurant = restaurantResult.rows[0];
  if (!restaurant) return res.status(404).json({ error: 'No encontramos este local.' });
  if (!restaurant.is_enabled) return serviceUnavailable(res);
  if (table < 1 || table > restaurant.table_count) return res.status(400).json({ error: 'La mesa no es válida.' });
  const quantities = new Map();
  for (const row of requested) {
    if (typeof row.id !== 'string' || !Number.isInteger(row.quantity) || row.quantity < 1 || row.quantity > 20) {
      return res.status(400).json({ error: 'Hay productos o cantidades inválidas.' });
    }
    quantities.set(row.id, (quantities.get(row.id) || 0) + row.quantity);
  }
  const menu = await query(
    `SELECT id, name, price_ars FROM menu_items
     WHERE restaurant_id = $1 AND active = TRUE AND id = ANY($2::uuid[])`,
    [restaurant.id, [...quantities.keys()]],
  );
  if (menu.rowCount !== quantities.size) return res.status(400).json({ error: 'El menú cambió. Actualizá la página e intentá de nuevo.' });
  const items = menu.rows.map((item) => ({ ...item, quantity: quantities.get(item.id) }));
  const total = items.reduce((sum, item) => sum + item.price_ars * item.quantity, 0);
  if (total <= 0) return res.status(400).json({ error: 'El total del pedido no es válido.' });

  const orderId = randomUUID();
  await query(
    `INSERT INTO orders (id, restaurant_id, table_number, payment_method, items, total_ars)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [orderId, restaurant.id, table, method, JSON.stringify(items), total],
  );
  res.status(201).json({ id: orderId });
});

app.get('/api/public/orders/:id', async (req, res) => {
  const result = await query(
    `SELECT id, table_number AS "tableNumber", payment_method AS "paymentMethod",
            payment_status AS "paymentStatus", order_status AS "orderStatus", items, total_ars AS "totalArs"
     FROM orders WHERE id = $1`,
    [req.params.id],
  );
  if (!result.rowCount) return res.status(404).json({ error: 'No encontramos el pedido.' });
  res.set('Cache-Control', 'no-store').json(result.rows[0]);
});

app.use('/api/admin', requireAuth, requireEnabledRestaurant);

app.get('/api/admin/orders', requireAuth, async (req, res) => {
  const result = await query(
    `SELECT id, table_number AS "tableNumber", payment_method AS "paymentMethod",
            payment_status AS "paymentStatus", order_status AS "orderStatus", items, total_ars AS "totalArs",
            created_at AS "createdAt"
     FROM orders WHERE restaurant_id = $1 ORDER BY created_at DESC LIMIT 100`,
    [req.restaurantId],
  );
  res.json(result.rows);
});

app.get('/api/admin/menu', requireAuth, async (req, res) => {
  const result = await query(
    `SELECT id, category, name, description, price_ars AS "priceArs", active
     FROM menu_items WHERE restaurant_id = $1 ORDER BY category, name`,
    [req.restaurantId],
  );
  res.json(result.rows);
});

app.post('/api/admin/menu', requireAuth, async (req, res) => {
  const parsed = menuItemSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Revisá el nombre, categoría y precio del producto.' });
  const item = parsed.data;
  const result = await query(
    `INSERT INTO menu_items (id, restaurant_id, category, name, description, price_ars, active)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, category, name, description, price_ars AS "priceArs", active`,
    [randomUUID(), req.restaurantId, item.category, item.name, item.description, item.priceArs, item.active],
  );
  res.status(201).json(result.rows[0]);
});

app.patch('/api/admin/menu/:id', requireAuth, async (req, res) => {
  const parsed = menuItemSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Revisá el nombre, categoría y precio del producto.' });
  const item = parsed.data;
  const result = await query(
    `UPDATE menu_items SET category = $1, name = $2, description = $3, price_ars = $4, active = $5
     WHERE id = $6 AND restaurant_id = $7
     RETURNING id`,
    [item.category, item.name, item.description, item.priceArs, item.active, req.params.id, req.restaurantId],
  );
  if (!result.rowCount) return res.status(404).json({ error: 'No encontramos ese producto.' });
  res.sendStatus(204);
});

app.delete('/api/admin/menu/:id', requireAuth, async (req, res) => {
  const result = await query(
    'UPDATE menu_items SET active = FALSE WHERE id = $1 AND restaurant_id = $2 RETURNING id',
    [req.params.id, req.restaurantId],
  );
  if (!result.rowCount) return res.status(404).json({ error: 'No encontramos ese producto.' });
  res.sendStatus(204);
});

app.post('/api/admin/orders/:id/collect-payment', requireAuth, async (req, res) => {
  const result = await query(
    `UPDATE orders SET payment_status = 'approved'
     WHERE id = $1 AND restaurant_id = $2 AND payment_method IN ('mercadopago', 'cash', 'card') AND payment_status = 'pending'
     RETURNING id`,
    [req.params.id, req.restaurantId],
  );
  if (!result.rowCount) return res.status(409).json({ error: 'No se pudo confirmar este cobro.' });
  res.sendStatus(204);
});

app.patch('/api/admin/orders/:id/status', requireAuth, async (req, res) => {
  const nextStatus = req.body.status;
  const transitions = { received: 'preparing', preparing: 'ready', ready: 'delivered' };
  const currentStatus = Object.keys(transitions).find((status) => transitions[status] === nextStatus);
  if (!currentStatus) return res.status(400).json({ error: 'El estado solicitado no es válido.' });
  const result = await query(
    `UPDATE orders SET order_status = $1
     WHERE id = $2 AND restaurant_id = $3 AND payment_status = 'approved' AND order_status = $4
     RETURNING id`,
    [nextStatus, req.params.id, req.restaurantId, currentStatus],
  );
  if (!result.rowCount) return res.status(409).json({ error: 'El pedido debe estar pagado y avanzar en orden.' });
  res.sendStatus(204);
});

app.get('/api/admin/tables', requireAuth, async (req, res) => {
  const result = await query('SELECT slug, table_count FROM restaurants WHERE id = $1', [req.restaurantId]);
  const restaurant = result.rows[0];
  if (!restaurant) return res.status(404).json({ error: 'No encontramos el local.' });
  res.json(Array.from({ length: restaurant.table_count }, (_, index) => {
    const table = index + 1;
    const url = new URL(`/menu/${restaurant.slug}`, process.env.PUBLIC_URL);
    url.searchParams.set('table', table);
    return { table, url: url.href, qrUrl: `/api/admin/tables/${table}/qr.png` };
  }));
});

app.get('/api/admin/tables/:table/qr.png', requireAuth, async (req, res) => {
  const table = Number(req.params.table);
  const result = await query('SELECT slug, table_count FROM restaurants WHERE id = $1', [req.restaurantId]);
  const restaurant = result.rows[0];
  if (!restaurant || !Number.isInteger(table) || table < 1 || table > restaurant.table_count) {
    return res.status(404).json({ error: 'No encontramos esa mesa.' });
  }
  const url = new URL(`/menu/${restaurant.slug}`, process.env.PUBLIC_URL);
  url.searchParams.set('table', table);
  res.type('png').set('Cache-Control', 'private, no-store');
  res.send(await QRCode.toBuffer(url.href, { type: 'png', width: 360, margin: 2, errorCorrectionLevel: 'M' }));
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'Ruta no encontrada.' }));
app.get('/platform-admin', (_req, res) => res.sendFile(path.join(webRoot, 'index.html')));
app.use(express.static(webRoot, { extensions: ['html'] }));
app.get('/menu/:slug', (_req, res) => res.sendFile(path.join(webRoot, 'index.html')));
app.use((error, _req, res, _next) => fail(res, error));

export default app;
