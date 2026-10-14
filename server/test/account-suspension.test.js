import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import bcrypt from 'bcryptjs';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'tably-account-suspension-test-secret';
process.env.PLATFORM_ADMIN_EMAIL = 'platform-admin@example.test';
process.env.PLATFORM_ADMIN_PASSWORD = 'platform-admin-test-password';
process.env.PUBLIC_URL = 'http://127.0.0.1';

const [{ default: app }, { pool }] = await Promise.all([
  import('../src/app.js'),
  import('../src/db.js'),
]);

test('platform suspension blocks login, existing admin sessions, QR menu and new orders; re-enabling restores service', async (t) => {
  const restaurant = {
    id: '11111111-1111-4111-8111-111111111111',
    slug: 'cafe-suspension-test',
    name: 'Café de prueba',
    email: 'cafe@example.test',
    password_hash: await bcrypt.hash('cafe-test-password', 4),
    table_count: 3,
    plan: 'base',
    subscription_status: 'trial',
    subscription_due_at: '2030-01-01T00:00:00.000Z',
    subscription_paid_at: null,
    created_at: '2029-01-01T00:00:00.000Z',
    is_enabled: true,
  };
  const menu = [{
    id: '22222222-2222-4222-8222-222222222222',
    category: 'Café',
    name: 'Espresso',
    description: '',
    priceArs: 2500,
    price_ars: 2500,
    active: true,
  }];
  let insertedOrders = 0;
  const descriptor = Object.getOwnPropertyDescriptor(pool, 'query');
  Object.defineProperty(pool, 'query', {
    configurable: true,
    writable: true,
    value: async (sql, values = []) => {
      const text = sql.replace(/\s+/g, ' ').trim();
      if (text.startsWith('SELECT id, email, password_hash, is_enabled FROM restaurants WHERE email')) {
        const rows = restaurant.email === values[0] ? [restaurant] : [];
        return { rows, rowCount: rows.length };
      }
      if (text === 'SELECT is_enabled FROM restaurants WHERE id = $1') {
        const rows = restaurant.id === values[0] ? [{ is_enabled: restaurant.is_enabled }] : [];
        return { rows, rowCount: rows.length };
      }
      if (text.includes('FROM restaurants ORDER BY subscription_due_at ASC, name ASC')) {
        return { rows: [{
          id: restaurant.id,
          name: restaurant.name,
          email: restaurant.email,
          tableCount: restaurant.table_count,
          plan: restaurant.plan,
          subscriptionStatus: restaurant.subscription_status,
          subscriptionDueAt: restaurant.subscription_due_at,
          subscriptionPaidAt: restaurant.subscription_paid_at,
          createdAt: restaurant.created_at,
          enabled: restaurant.is_enabled,
        }], rowCount: 1 };
      }
      if (text.startsWith('UPDATE restaurants SET is_enabled = $1')) {
        if (values[1] !== restaurant.id) return { rows: [], rowCount: 0 };
        restaurant.is_enabled = values[0];
        return { rows: [{ id: restaurant.id, enabled: restaurant.is_enabled }], rowCount: 1 };
      }
      if (text.startsWith('SELECT id, slug, name, table_count, is_enabled FROM restaurants WHERE slug')) {
        const rows = restaurant.slug === values[0] ? [restaurant] : [];
        return { rows, rowCount: rows.length };
      }
      if (text.startsWith('SELECT * FROM restaurants WHERE slug')) {
        const rows = restaurant.slug === values[0] ? [restaurant] : [];
        return { rows, rowCount: rows.length };
      }
      if (text.startsWith('SELECT id, slug, name, email, table_count AS')) {
        const rows = restaurant.id === values[0] ? [{
          id: restaurant.id,
          slug: restaurant.slug,
          name: restaurant.name,
          email: restaurant.email,
          tableCount: restaurant.table_count,
          plan: restaurant.plan,
          subscriptionStatus: restaurant.subscription_status,
          subscriptionDueAt: restaurant.subscription_due_at,
        }] : [];
        return { rows, rowCount: rows.length };
      }
      if (text.startsWith('SELECT id, category, name, description, price_ars AS')) {
        return { rows: menu, rowCount: menu.length };
      }
      if (text.startsWith('SELECT id, name, price_ars FROM menu_items')) {
        const rows = menu.filter((item) => values[1].includes(item.id));
        return { rows, rowCount: rows.length };
      }
      if (text.startsWith('SELECT slug, table_count FROM restaurants WHERE id')) {
        const rows = restaurant.id === values[0] ? [{ slug: restaurant.slug, table_count: restaurant.table_count }] : [];
        return { rows, rowCount: rows.length };
      }
      if (text.startsWith('INSERT INTO orders')) {
        insertedOrders += 1;
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected query in suspension test: ${text}`);
    },
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    if (descriptor) Object.defineProperty(pool, 'query', descriptor);
    else delete pool.query;
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(path, { method = 'GET', cookie, body } = {}) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = response.status === 204 ? null : await response.json();
    return { response, data };
  }

  const platformLogin = await request('/api/platform/auth/login', {
    method: 'POST',
    body: { email: process.env.PLATFORM_ADMIN_EMAIL, password: process.env.PLATFORM_ADMIN_PASSWORD },
  });
  assert.equal(platformLogin.response.status, 200);
  const platformCookie = platformLogin.response.headers.get('set-cookie').split(';')[0];
  const cafeLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { email: restaurant.email, password: 'cafe-test-password' },
  });
  assert.equal(cafeLogin.response.status, 200);
  const cafeCookie = cafeLogin.response.headers.get('set-cookie').split(';')[0];

  const listing = await request('/api/platform/subscriptions', { cookie: platformCookie });
  assert.equal(listing.response.status, 200);
  assert.equal(listing.data[0].enabled, true);
  const invalidToggle = await request(`/api/platform/subscriptions/${restaurant.id}/access`, {
    method: 'PATCH', cookie: platformCookie, body: { enabled: 'false' },
  });
  assert.equal(invalidToggle.response.status, 400);
  assert.equal((await request(`/api/platform/subscriptions/${restaurant.id}/access`, {
    method: 'PATCH', body: { enabled: false },
  })).response.status, 401);

  const disabled = await request(`/api/platform/subscriptions/${restaurant.id}/access`, {
    method: 'PATCH', cookie: platformCookie, body: { enabled: false },
  });
  assert.equal(disabled.response.status, 200);
  assert.equal(disabled.data.enabled, false);

  const disabledLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { email: restaurant.email, password: 'cafe-test-password' },
  });
  assert.equal(disabledLogin.response.status, 403);
  assert.equal(disabledLogin.data.code, 'ACCOUNT_DISABLED');

  for (const path of ['/api/auth/me', '/api/admin/menu', '/api/admin/tables/1/qr.png']) {
    const blocked = await request(path, { cookie: cafeCookie });
    assert.equal(blocked.response.status, 403, path);
    assert.equal(blocked.data.code, 'ACCOUNT_DISABLED', path);
  }
  const blockedCreate = await request('/api/admin/menu', {
    method: 'POST', cookie: cafeCookie,
    body: { category: 'Test', name: 'Must not be saved', description: '', priceArs: 1000, active: true },
  });
  assert.equal(blockedCreate.response.status, 403);
  const blockedEdit = await request(`/api/admin/menu/${menu[0].id}`, {
    method: 'PATCH', cookie: cafeCookie,
    body: { category: 'Test', name: 'Must not be saved', description: '', priceArs: 1000, active: true },
  });
  assert.equal(blockedEdit.response.status, 403);
  const blockedDelete = await request(`/api/admin/menu/${menu[0].id}`, {
    method: 'DELETE', cookie: cafeCookie,
  });
  assert.equal(blockedDelete.response.status, 403);
  const qrMenu = await request(`/api/public/${restaurant.slug}?table=1`);
  assert.equal(qrMenu.response.status, 503);
  assert.equal(qrMenu.data.code, 'CAFE_UNAVAILABLE');
  assert.equal(qrMenu.data.error, '¡Lo sentimos! Este servicio no está disponible ahora mismo.');
  const rejectedOrder = await request(`/api/public/${restaurant.slug}/orders`, {
    method: 'POST',
    body: { table: 1, method: 'cash', items: [{ id: menu[0].id, quantity: 1 }] },
  });
  assert.equal(rejectedOrder.response.status, 503);
  assert.equal(rejectedOrder.data.code, 'CAFE_UNAVAILABLE');
  assert.equal(insertedOrders, 0);

  const enabled = await request(`/api/platform/subscriptions/${restaurant.id}/access`, {
    method: 'PATCH', cookie: platformCookie, body: { enabled: true },
  });
  assert.equal(enabled.response.status, 200);
  assert.equal(enabled.data.enabled, true);
  assert.equal((await request('/api/admin/menu', { cookie: cafeCookie })).response.status, 200);
  assert.equal((await request(`/api/public/${restaurant.slug}?table=1`)).response.status, 200);
  const acceptedOrder = await request(`/api/public/${restaurant.slug}/orders`, {
    method: 'POST',
    body: { table: 1, method: 'cash', items: [{ id: menu[0].id, quantity: 1 }] },
  });
  assert.equal(acceptedOrder.response.status, 201);
  assert.equal(insertedOrders, 1);
});
