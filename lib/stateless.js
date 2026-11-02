import crypto from 'node:crypto';

// Stateless signed tokens (HMAC-SHA256) so sign-in works on serverless hosts
// where memory is not shared between requests. Secret comes from SESSION_SECRET.
let devSecret;
export const secret = () => {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production') throw new Error('SESSION_SECRET is required');
  return (devSecret ||= crypto.randomBytes(32).toString('hex'));
};
const mac = (data, key) => crypto.createHmac('sha256', key).update(data).digest('base64url');

export function sign(payload, ttlMs, { key = secret(), now = Date.now() } = {}) {
  const data = Buffer.from(JSON.stringify({ ...payload, exp: now + ttlMs })).toString('base64url');
  return `${data}.${mac(data, key)}`;
}

export function verify(token, { key = secret(), now = Date.now(), purpose } = {}) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [data, sig] = token.split('.');
  const expected = mac(data, key);
  if (!sig || sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  let payload; try { payload = JSON.parse(Buffer.from(data, 'base64url').toString()); } catch { return null; }
  if (!payload || typeof payload.exp !== 'number' || payload.exp <= now) return null;
  if (purpose && payload.p !== purpose) return null;
  return payload;
}

// Deterministic per-owner restaurant id so the same email always lands in the same restaurant.
export const restaurantIdFor = (email, key = secret()) => crypto.createHmac('sha256', key).update(`restaurant:${email}`).digest('hex').slice(0, 32);
export const normalizeEmail = (email = '') => String(email).trim().toLowerCase();

export const SESSION_TTL = 30 * 864e5;
export const MAGIC_TTL = 15 * 60e3;
export const STATE_TTL = 10 * 60e3;
export const sessionToken = (email, opts) => { const e = normalizeEmail(email); return sign({ p: 'session', email: e, restaurantId: restaurantIdFor(e, opts?.key), role: 'owner' }, SESSION_TTL, opts); };
export const magicToken = (email, opts) => sign({ p: 'magic', email: normalizeEmail(email), n: crypto.randomBytes(8).toString('base64url') }, MAGIC_TTL, opts);
