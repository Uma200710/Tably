import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHmac } from 'node:crypto';

process.env.TOKEN_ENCRYPTION_KEY_BASE64 = Buffer.alloc(32, 7).toString('base64');
process.env.JWT_SECRET = 'tably-test-session-secret-with-enough-length';
process.env.MP_WEBHOOK_SECRET = 'tably-test-webhook-secret';

const [{ default: app }, { createOrderPreference, createSubscription, getPlatformAccessToken, sellerAuthorizationUrl, verifyWebhook }, { decryptSecret, encryptSecret }] = await Promise.all([
  import('../src/app.js'),
  import('../src/mp.js'),
  import('../src/security.js'),
]);

test('serves the app shell, assets, health endpoint, and menu deep links', async (t) => {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  for (const path of ['/api/health', '/', '/styles.css', '/app.js', '/menu/cafe-demo?table=2']) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 200, path);
  }
  const health = await fetch(`${baseUrl}/api/health`).then((response) => response.json());
  assert.deepEqual(health, { ok: true });
});

test('encrypts and decrypts Mercado Pago tokens', () => {
  const token = 'APP_USR_sensitive-test-token';
  const encrypted = encryptSecret(token);
  assert.notEqual(encrypted, token);
  assert.equal(decryptSecret(encrypted), token);
});

test('builds the cafe authorization redirect without exposing its client secret', () => {
  process.env.MP_CLIENT_ID = 'tably-client-id';
  process.env.MP_CLIENT_SECRET = 'server-only-client-secret';
  process.env.PUBLIC_URL = 'https://tably.example';
  const url = new URL(sellerAuthorizationUrl('one-time-state'));
  assert.equal(url.origin, 'https://auth.mercadopago.com.ar');
  assert.equal(url.searchParams.get('client_id'), 'tably-client-id');
  assert.equal(url.searchParams.get('state'), 'one-time-state');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://tably.example/api/mercadopago/callback');
  assert.equal(url.href.includes('server-only-client-secret'), false);
});

test('creates cafe payment preferences with the seller token and Tably return/webhook URLs', async (t) => {
  const previousUrl = process.env.PUBLIC_URL;
  const previousFetch = globalThis.fetch;
  process.env.PUBLIC_URL = 'https://tably.example';
  let requestUrl;
  let requestOptions;
  globalThis.fetch = async (url, options) => {
    requestUrl = url;
    requestOptions = options;
    return { ok: true, json: async () => ({ id: 'preference-123', init_point: 'https://mp.example/checkout' }) };
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.PUBLIC_URL;
    else process.env.PUBLIC_URL = previousUrl;
  });

  const preference = await createOrderPreference(
    { id: 'order-123', table_number: 4 },
    { id: 'cafe-123', slug: 'cafe-brisa' },
    [{ id: 'product-123', name: 'Flat white', quantity: 2, price_ars: 4800 }],
    'seller-access-token',
  );

  assert.equal(requestUrl, 'https://api.mercadopago.com/checkout/preferences');
  assert.equal(requestOptions.headers.Authorization, 'Bearer seller-access-token');
  const body = JSON.parse(requestOptions.body);
  assert.equal(body.external_reference, 'order-123');
  assert.equal(body.items[0].unit_price, 4800);
  assert.equal(body.notification_url, 'https://tably.example/api/payments/webhook');
  assert.match(body.back_urls.success, /order_id=order-123/);
  assert.equal(preference.init_point, 'https://mp.example/checkout');
});

test('gets and caches Tably owner token through OAuth client credentials', async (t) => {
  const previousClientId = process.env.MP_CLIENT_ID;
  const previousClientSecret = process.env.MP_CLIENT_SECRET;
  const previousFetch = globalThis.fetch;
  process.env.MP_CLIENT_ID = 'tably-client-id';
  process.env.MP_CLIENT_SECRET = 'server-only-client-secret';
  let calls = 0;
  let requestBody;
  globalThis.fetch = async (url, options) => {
    calls += 1;
    requestBody = JSON.parse(options.body);
    return { ok: true, json: async () => ({ access_token: 'owner-platform-token', expires_in: 3600 }) };
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousClientId === undefined) delete process.env.MP_CLIENT_ID;
    else process.env.MP_CLIENT_ID = previousClientId;
    if (previousClientSecret === undefined) delete process.env.MP_CLIENT_SECRET;
    else process.env.MP_CLIENT_SECRET = previousClientSecret;
  });

  assert.equal(await getPlatformAccessToken(), 'owner-platform-token');
  assert.equal(await getPlatformAccessToken(), 'owner-platform-token');
  assert.equal(requestBody.grant_type, 'client_credentials');
  assert.equal(requestBody.client_id, 'tably-client-id');
  assert.equal(calls, 1);
});

test('creates the Tably subscription with one month free and a signed-webhook URL', async (t) => {
  process.env.PUBLIC_URL = 'https://tably.example';
  const originalFetch = globalThis.fetch;
  let requestUrl;
  let requestBody;
  globalThis.fetch = async (url, options) => {
    requestUrl = url;
    requestBody = JSON.parse(options.body);
    return { ok: true, json: async () => ({ id: 'subscription-123', init_point: 'https://mp.example/checkout' }) };
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const response = await createSubscription(
    { id: 'restaurant-123', name: 'Café Brisa', email: 'hola@example.com', plan: 'base' },
    'platform-access-token',
    30000,
  );

  assert.equal(requestUrl, 'https://api.mercadopago.com/preapproval');
  assert.equal(requestBody.auto_recurring.transaction_amount, 30000);
  assert.deepEqual(requestBody.auto_recurring.free_trial, { frequency: 1, frequency_type: 'months' });
  assert.equal(requestBody.status, 'pending');
  assert.equal(requestBody.notification_url, 'https://tably.example/api/payments/webhook');
  assert.equal(requestBody.external_reference, 'restaurant-123');
  assert.equal(response.init_point, 'https://mp.example/checkout');
});

test('accepts an authentic Mercado Pago webhook signature and rejects a forged one', () => {
  const timestamp = '1704908010';
  const requestId = 'request-123';
  const dataId = '98765';
  const manifest = `id:${dataId};request-id:${requestId};ts:${timestamp};`;
  const signature = createSignature(manifest);
  const headers = { 'x-signature': `ts=${timestamp},v1=${signature}`, 'x-request-id': requestId };
  const request = {
    body: { data: { id: dataId } },
    query: {},
    get: (name) => headers[name.toLowerCase()],
  };

  assert.equal(verifyWebhook(request), true);
  headers['x-request-id'] = 'different-request';
  assert.equal(verifyWebhook(request), false);
});

function createSignature(manifest) {
  return createHmac('sha256', process.env.MP_WEBHOOK_SECRET).update(manifest).digest('hex');
}