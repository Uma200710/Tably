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

export function requireAuth(req, res, next) {
  try {
    const token = req.cookies?.tably_session;
    if (!token) return res.status(401).json({ error: 'Iniciá sesión para continuar.' });
    req.restaurantId = jwt.verify(token, process.env.JWT_SECRET).sub;
    next();
  } catch {
    res.clearCookie('tably_session');
    return res.status(401).json({ error: 'La sesión venció. Iniciá sesión nuevamente.' });
  }
}