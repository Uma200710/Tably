import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import app from '../src/app.js';
import { pool, query } from '../src/db.js';

const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const email = `smoke-${randomUUID()}@example.invalid`;
let restaurantId;

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json') ? await response.json() : await response.arrayBuffer();
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${path} returned ${response.status}: ${JSON.stringify(body)}`);
  return { response, body };
}

try {
  const { body: health } = await request('/api/health');
  assert.equal(health.ok, true);

  const registration = await request('/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Smoke Test Cafe', email, password: 'Smoke-Test-Password-123!', tableCount: 6 }),
  });
  restaurantId = registration.body.id;
  const sessionCookie = registration.response.headers.get('set-cookie')?.split(';')[0];
  assert.ok(sessionCookie, 'registration should set an HttpOnly session cookie');
  const authHeaders = { cookie: sessionCookie };

  const [{ body: me }, { body: menu }, { body: tables }] = await Promise.all([
    request('/api/auth/me', { headers: authHeaders }),
    request('/api/admin/menu', { headers: authHeaders }),
    request('/api/admin/tables', { headers: authHeaders }),
  ]);
  assert.equal(me.slug, registration.body.slug);
  assert.equal(menu.length, 8);
  assert.equal(tables.length, 6);
  assert.match(tables[0].url, /table=1$/);

  const { body: png } = await request('/api/admin/tables/1/qr.png', { headers: authHeaders });
  const signature = Buffer.from(png).subarray(0, 8).toString('hex');
  assert.equal(signature, '89504e470d0a1a0a');

  const { body: order } = await request(`/api/public/${registration.body.slug}/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ table: 1, method: 'cash', items: [{ id: menu[0].id, quantity: 1 }] }),
  });
  await request(`/api/admin/orders/${order.id}/cash-payment`, {
    method: 'POST',
    headers: { ...authHeaders, 'content-type': 'application/json' },
    body: '{}',
  });
  await request(`/api/admin/orders/${order.id}/status`, {
    method: 'PATCH',
    headers: { ...authHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'preparing' }),
  });
  const { body: orders } = await request('/api/admin/orders', { headers: authHeaders });
  const savedOrder = orders.find((candidate) => candidate.id === order.id);
  assert.equal(savedOrder.paymentStatus, 'approved');
  assert.equal(savedOrder.orderStatus, 'preparing');

  console.log('Smoke test passed: registration, session, menu, six table links, PNG QR, persisted order, cash confirmation, and preparation status.');
} finally {
  if (restaurantId) await query('DELETE FROM restaurants WHERE id = $1', [restaurantId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
  console.log('Temporary smoke-test data removed.');
}