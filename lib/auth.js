import crypto from 'node:crypto';

const b64 = (value) => Buffer.from(value).toString('base64url');
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');

export class Store {
  constructor(now = () => Date.now()) {
    this.now = now; this.users = new Map(); this.identities = new Map(); this.sessions = new Map();
    this.magicLinks = new Map(); this.rateLimits = new Map(); this.restaurants = new Map(); this.documents = new Map();
  }
  upsertVerifiedIdentity(provider, subject, email) {
    const normalized = email.trim().toLowerCase();
    const identityKey = `${provider}:${subject}`;
    let user = this.identities.get(identityKey) && this.users.get(this.identities.get(identityKey));
    if (!user) user = [...this.users.values()].find((item) => item.email === normalized);
    if (!user) {
      const id = crypto.randomUUID(); const restaurantId = crypto.randomUUID();
      user = { id, email: normalized, restaurantId, role: 'owner', createdAt: this.now() };
      this.users.set(id, user);
      this.restaurants.set(restaurantId, { id: restaurantId, name: 'My restaurant', ownerId: id, seats: [{ id: crypto.randomUUID(), userId: id, role: 'owner' }] });
    }
    this.identities.set(identityKey, user.id);
    return user;
  }
  createSession(userId) {
    const token = b64(crypto.randomBytes(32));
    this.sessions.set(hash(token), { userId, expiresAt: this.now() + 30 * 864e5, refreshAfter: this.now() + 864e5 });
    return token;
  }
  session(token) {
    const key = token && hash(token); const session = key && this.sessions.get(key);
    if (!session || session.expiresAt <= this.now()) { if (key) this.sessions.delete(key); return null; }
    if (session.refreshAfter <= this.now()) { session.expiresAt = this.now() + 30 * 864e5; session.refreshAfter = this.now() + 864e5; }
    return { ...session, user: this.users.get(session.userId) };
  }
  revoke(token) { if (token) this.sessions.delete(hash(token)); }
  requestMagic(email, ip) {
    const key = `${ip}:${email.trim().toLowerCase()}`; const attempts = (this.rateLimits.get(key) || []).filter(t => t > this.now() - 15 * 60e3);
    if (attempts.length >= 5) return null;
    attempts.push(this.now()); this.rateLimits.set(key, attempts);
    const token = b64(crypto.randomBytes(32));
    this.magicLinks.set(hash(token), { email: email.trim().toLowerCase(), expiresAt: this.now() + 15 * 60e3, used: false });
    return token;
  }
  consumeMagic(token) {
    const record = token && this.magicLinks.get(hash(token));
    if (!record || record.used || record.expiresAt <= this.now()) return null;
    record.used = true; return this.upsertVerifiedIdentity('email', record.email, record.email);
  }
  addDocument(user, data) { const item = { id: crypto.randomUUID(), restaurantId: user.restaurantId, ...data }; this.documents.set(item.id, item); return item; }
  documentFor(user, id) { const item = this.documents.get(id); return item?.restaurantId === user.restaurantId ? item : null; }
}

const productPaths = new Set(['/seat', '/check/invoices', '/check/menu', '/check/labor']);
export const safeReturnTo = (value) => {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return '/seat';
  try {
    const decoded = decodeURIComponent(value);
    if (/[\\\u0000-\u001f\u007f]/.test(value) || /[\\\u0000-\u001f\u007f]/.test(decoded)) return '/seat';
    const target = new URL(value, 'https://one-seat.invalid');
    if (target.origin !== 'https://one-seat.invalid' || !productPaths.has(target.pathname)) return '/seat';
    // Callers embed this destination in HTML attributes and redirect headers.
    // Serialize and encode quote/angle characters rather than echoing input.
    return (target.pathname + target.search + target.hash).replace(/["'<>]/g,
      character => '%' + character.charCodeAt(0).toString(16).toUpperCase());
  } catch { return '/seat'; }
};
export const cookie = (name, value, maxAge = 2592000) => `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
export const parseCookies = (header = '') => {
  const cookies = Object.create(null);
  if (typeof header !== 'string') return cookies;
  for (const item of header.split(';')) {
    const separator = item.indexOf('=');
    if (separator < 1) continue;
    try {
      const name = decodeURIComponent(item.slice(0, separator).trim());
      if (!name || Object.hasOwn(cookies, name)) continue;
      cookies[name] = decodeURIComponent(item.slice(separator + 1).trim());
    } catch { /* A malformed unrelated cookie must not break sign-in. */ }
  }
  return cookies;
};
