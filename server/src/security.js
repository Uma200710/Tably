import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';

const encryptionKey = Buffer.from(process.env.TOKEN_ENCRYPTION_KEY_BASE64 || '', 'base64');

export function encryptSecret(value) {
  if (!value) return null;
  if (encryptionKey.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY_BASE64 must decode to 32 bytes');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString('base64')).join('.');
}

export function decryptSecret(value) {
  if (!value) return null;
  if (encryptionKey.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY_BASE64 must decode to 32 bytes');
  const [iv, tag, encrypted] = value.split('.').map((part) => Buffer.from(part, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

export function issueSession(restaurantId) {
  return jwt.sign({ sub: restaurantId }, process.env.JWT_SECRET, { expiresIn: '7d' });
}

export function issuePlatformSession(email) {
  return jwt.sign({ sub: email, role: 'platform_admin' }, process.env.JWT_SECRET, { expiresIn: '7d' });
}

export function requireAuth(req, res, next) {
  try {
    const token = req.cookies?.tably_session;
    if (!token) return res.status(401).json({ error: 'Iniciá sesión para continuar.' });
    const session = jwt.verify(token, process.env.JWT_SECRET);
    if (session.role) return res.status(403).json({ error: 'Esta sesión no pertenece a un café.' });
    req.restaurantId = session.sub;
    next();
  } catch {
    res.clearCookie('tably_session');
    return res.status(401).json({ error: 'La sesión venció. Iniciá sesión nuevamente.' });
  }
}

export function requirePlatformAdmin(req, res, next) {
  try {
    const token = req.cookies?.tably_session;
    if (!token) return res.status(401).json({ error: 'Iniciá sesión como administrador de Tably.' });
    const session = jwt.verify(token, process.env.JWT_SECRET);
    const adminEmail = process.env.PLATFORM_ADMIN_EMAIL?.trim().toLowerCase();
    if (session.role !== 'platform_admin' || !adminEmail || session.sub !== adminEmail) {
      return res.status(403).json({ error: 'No tenés permiso para administrar Tably.' });
    }
    req.platformAdminEmail = session.sub;
    next();
  } catch {
    res.clearCookie('tably_session');
    return res.status(401).json({ error: 'La sesión venció. Iniciá sesión nuevamente.' });
  }
}
