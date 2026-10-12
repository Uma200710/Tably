import { createHmac, timingSafeEqual } from 'node:crypto';
import { query } from './db.js';
import { decryptSecret, encryptSecret } from './security.js';

const API = 'https://api.mercadopago.com';
let platformAccessToken = null;
let platformTokenExpiresAt = 0;

export async function mpRequest(path, token, method = 'GET', body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error('Mercado Pago no pudo completar la operación.');
    error.status = response.status;
    error.details = payload;
    throw error;
  }
  return payload;
}

export function requireMpApplication() {
  if (!process.env.MP_CLIENT_ID || !process.env.MP_CLIENT_SECRET) {
    const error = new Error('Falta configurar la aplicación de Mercado Pago en el servidor.');
    error.status = 503;
    throw error;
  }
}

export async function getPlatformAccessToken() {
  requireMpApplication();
  if (platformAccessToken && platformTokenExpiresAt > Date.now() + 60_000) return platformAccessToken;

  const response = await fetch(`${API}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.MP_CLIENT_ID,
      client_secret: process.env.MP_CLIENT_SECRET,
      grant_type: 'client_credentials',
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) {
    const error = new Error('No se pudo autorizar la cuenta de Tably en Mercado Pago.');
    error.status = 502;
    throw error;
  }
  platformAccessToken = payload.access_token;
  platformTokenExpiresAt = Date.now() + (Number(payload.expires_in) || 3600) * 1000;
  return platformAccessToken;
}

export function sellerAuthorizationUrl(state) {
  requireMpApplication();
  const callback = `${process.env.PUBLIC_URL}/api/mercadopago/callback`;
  const url = new URL('https://auth.mercadopago.com.ar/authorization');
  url.search = new URLSearchParams({
    client_id: process.env.MP_CLIENT_ID,
    response_type: 'code',
    platform_id: 'mp',
    redirect_uri: callback,
    state,
  }).toString();
  return url.href;
}

export async function exchangeAuthorizationCode(code) {
  requireMpApplication();
  const response = await fetch(`${API}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.MP_CLIENT_ID,
      client_secret: process.env.MP_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: `${process.env.PUBLIC_URL}/api/mercadopago/callback`,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error('No se pudo conectar la cuenta de Mercado Pago.');
    error.status = 502;
    throw error;
  }
  return payload;
}

export async function getSellerToken(restaurant) {
  const expiresAt = restaurant.mp_token_expires_at ? new Date(restaurant.mp_token_expires_at).getTime() : 0;
  if (expiresAt > Date.now() + 60_000) return decryptSecret(restaurant.mp_access_token_enc);
  const refreshToken = decryptSecret(restaurant.mp_refresh_token_enc);
  if (!refreshToken) {
    const error = new Error('Volvé a conectar la cuenta de Mercado Pago del local.');
    error.status = 409;
    throw error;
  }
  requireMpApplication();
  const response = await fetch(`${API}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.MP_CLIENT_ID,
      client_secret: process.env.MP_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error('Volvé a conectar la cuenta de Mercado Pago del local.');
    error.status = 409;
    throw error;
  }
  await query(
    `UPDATE restaurants
     SET mp_access_token_enc = $1, mp_refresh_token_enc = $2, mp_token_expires_at = NOW() + ($3 * INTERVAL '1 second')
     WHERE id = $4`,
    [encryptSecret(payload.access_token), encryptSecret(payload.refresh_token), payload.expires_in, restaurant.id],
  );
  return payload.access_token;
}

export function verifyWebhook(req) {
  const secret = process.env.MP_WEBHOOK_SECRET;
  if (!secret) return false;
  const signature = req.get('x-signature') || '';
  const requestId = req.get('x-request-id') || '';
  const dataId = String(req.query['data.id'] || req.body?.data?.id || '').toLowerCase();
  const values = Object.fromEntries(signature.split(',').map((part) => part.trim().split('=')));
  if (!values.ts || !values.v1 || !requestId || !dataId) return false;
  const manifest = `id:${dataId};request-id:${requestId};ts:${values.ts};`;
  const expected = createHmac('sha256', secret).update(manifest).digest();
  let provided;
  try {
    provided = Buffer.from(values.v1, 'hex');
  } catch {
    return false;
  }
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export function createOrderPreference(order, restaurant, items, token) {
  const returnUrl = new URL(`/menu/${restaurant.slug}`, process.env.PUBLIC_URL);
  returnUrl.searchParams.set('table', order.table_number);
  returnUrl.searchParams.set('order_id', order.id);
  return mpRequest('/checkout/preferences', token, 'POST', {
    items: items.map((item) => ({
      id: item.id,
      title: item.name,
      quantity: item.quantity,
      unit_price: item.price_ars,
      currency_id: 'ARS',
    })),
    external_reference: order.id,
    notification_url: `${process.env.PUBLIC_URL}/api/payments/webhook`,
    back_urls: {
      success: `${returnUrl.href}&payment=success`,
      pending: `${returnUrl.href}&payment=pending`,
      failure: `${returnUrl.href}&payment=failure`,
    },
    auto_return: 'approved',
    metadata: { restaurant_id: restaurant.id, order_id: order.id },
  });
}

export function createSubscription(restaurant, token, amount) {
  const backUrl = new URL('/', process.env.PUBLIC_URL);
  backUrl.searchParams.set('subscription', 'return');
  return mpRequest('/preapproval', token, 'POST', {
    reason: `Tably ${restaurant.plan === 'ampliado' ? 'Ampliado' : 'Base'} · ${restaurant.name}`,
    external_reference: restaurant.id,
    payer_email: restaurant.email,
    auto_recurring: {
      frequency: 1,
      frequency_type: 'months',
      transaction_amount: amount,
      currency_id: 'ARS',
      free_trial: { frequency: 1, frequency_type: 'months' },
    },
    back_url: backUrl.href,
    notification_url: `${process.env.PUBLIC_URL}/api/payments/webhook`,
    status: 'pending',
  });
}