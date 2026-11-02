import crypto from 'node:crypto';

// Stateless signed tokens (HMAC-SHA256) so sign-in works on serverless hosts
// where memory is not shared between requests. Secret comes from SESSION_SECRET.
let devSecret;
export const secret = () => {
  const required = process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL || process.env.VERCEL_ENV);
  const configured = process.env.SESSION_SECRET;
  if (required && (typeof configured !== 'string' || Buffer.byteLength(configured, 'utf8') < 32)) {
    throw new Error('A stable SESSION_SECRET of at least 32 bytes is required');
  }
  if (configured) return configured;
  return (devSecret ||= crypto.randomBytes(32).toString('hex'));
};
const mac = (data, key) => crypto.createHmac('sha256', key).update(data).digest('base64url');

export function sign(payload, ttlMs, { key = secret(), now = Date.now() } = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      !Number.isSafeInteger(ttlMs) || ttlMs <= 0 ||
      !Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(now + ttlMs)) {
    throw new TypeError('Token payload, clock and lifetime must be valid.');
  }
  const data = Buffer.from(JSON.stringify({ ...payload, exp: now + ttlMs })).toString('base64url');
  return `${data}.${mac(data, key)}`;
}

export function verify(token, { key = secret(), now = Date.now(), purpose } = {}) {
  if (typeof token !== 'string' || token.length > 8192 || !Number.isSafeInteger(now) || now < 0) return null;
  const parts = token.split('.');
  if (parts.length !== 2 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) return null;
  const [data, sig] = token.split('.');
  // A token has exactly one representation. Suffixes and alternate base64
  // encodings must not produce another raw token with the same authority,
  // since revocation and replay prevention can bind the exact token hash.
  if (Buffer.from(data, 'base64url').toString('base64url') !== data) return null;
  const expected = mac(data, key);
  if (!sig || sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  let payload; try { payload = JSON.parse(Buffer.from(data, 'base64url').toString()); } catch { return null; }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      !Number.isSafeInteger(payload.exp) || payload.exp <= now) return null;
  if (purpose && payload.p !== purpose) return null;
  return payload;
}

// Deterministic per-owner restaurant id so the same email always lands in the same restaurant.
export const restaurantIdFor = (email, key = secret()) => crypto.createHmac('sha256', key).update(`restaurant:${normalizeEmail(email)}`).digest('hex').slice(0, 32);
export const normalizeEmail = (email = '') => String(email).trim().toLowerCase();

export const SESSION_TTL = 30 * 864e5;
export const MAGIC_TTL = 15 * 60e3;
export const STATE_TTL = 10 * 60e3;
export const sessionToken = (email, opts) => { const e = normalizeEmail(email); return sign({ p: 'session', email: e, restaurantId: restaurantIdFor(e, opts?.key), role: 'owner', n: crypto.randomBytes(16).toString('base64url') }, SESSION_TTL, opts); };
export const magicToken = (email, opts) => sign({ p: 'magic', email: normalizeEmail(email), n: crypto.randomBytes(16).toString('base64url') }, MAGIC_TTL, opts);
