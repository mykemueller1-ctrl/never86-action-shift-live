import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { safeReturnTo, cookie, parseCookies } from './auth.js';
import { verify, sessionToken, magicToken, normalizeEmail, restaurantIdFor, sign, secret, STATE_TTL, MAGIC_TTL } from './stateless.js';
import { createSharedStore, StoreUnavailableError } from './shared-store.js';

const root = path.dirname(fileURLToPath(new URL('../server.js', import.meta.url)));
const MAX_CONTENT = 1024 * 1024;
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const emailOK = email => typeof email === 'string' && email.length <= 254 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const html = (title, content) => `<!doctype html><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/app.css"><title>${escape(title)} · One Seat</title><main class="narrow"><a href="/seat" class="brand">Action Shift · One Seat</a>${content}</main>`;
const send = (res, status, body, type = 'text/html; charset=utf-8', headers = {}) => {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff', ...headers });
  res.end(body);
};
const json = (res, status, data) => send(res, status, JSON.stringify(data), 'application/json; charset=utf-8');
const redirect = (res, location, headers = {}) => send(res, 303, '', 'text/plain', { Location:location, ...headers });
class RequestError extends Error { constructor(status, message) { super(message); this.status = status; } }
function readForm(req, limit = 16384) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    const cleanup = () => { req.off('data', data); req.off('end', end); req.off('error', error); req.off('aborted', aborted); };
    const error = err => { cleanup(); reject(err); };
    const aborted = () => error(new RequestError(400, 'The request was interrupted.'));
    const end = () => { cleanup(); resolve(new URLSearchParams(Buffer.concat(chunks).toString())); };
    const data = chunk => {
      size += chunk.length;
      if (size > limit) { cleanup(); req.resume(); reject(new RequestError(413, 'This report is too large. Keep it under 1 MB.')); }
      else chunks.push(chunk);
    };
    req.on('data', data); req.on('end', end); req.on('error', error); req.on('aborted', aborted);
  });
}

// Dependencies are server-owned. Test injections never come from HTTP JSON.
export function createHandler({ env = process.env, store: suppliedStore, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const production = env.NODE_ENV === 'production' || Boolean(env.VERCEL || env.VERCEL_ENV);
  const origin = (env.APP_ORIGIN || (env.VERCEL_URL ? `https://${env.VERCEL_URL}` : `http://localhost:${Number(env.PORT || 3000)}`)).replace(/\/$/, '');
  let storePromise;
  const storage = () => suppliedStore ? Promise.resolve(suppliedStore) : (storePromise ||= createSharedStore({ env, now, fetchImpl }));
  const tokenOptions = () => {
    if ((production || env.NODE_ENV !== 'test') && (typeof env.SESSION_SECRET !== 'string' || Buffer.byteLength(env.SESSION_SECRET) < 32)) {
      throw new StoreUnavailableError('A stable session signing key is required.');
    }
    return { key:env.SESSION_SECRET || secret(), now:now() };
  };
  const configuredOrigin = () => {
    const parsed = new URL(origin);
    return !production || (Boolean(env.APP_ORIGIN) && parsed.protocol === 'https:' && parsed.origin === origin);
  };
  const requireOrigin = () => { if (!configuredOrigin()) throw new StoreUnavailableError('The application origin is not configured.'); };
  const csrfOkay = req => {
    const value = parseCookies(req.headers.cookie).csrf;
    return typeof value === 'string' && /^[A-Za-z0-9_-]{32,96}$/.test(value) && req.headers['x-csrf-token'] === value && req.headers.origin === origin;
  };
  async function userFor(req) {
    const raw = parseCookies(req.headers.cookie).one_seat;
    if (!raw) return null;
    const options = tokenOptions();
    const payload = verify(raw, { ...options, purpose:'session' });
    if (!payload || !emailOK(payload.email) || normalizeEmail(payload.email) !== payload.email || payload.role !== 'owner' ||
        payload.restaurantId !== restaurantIdFor(payload.email, options.key)) return null;
    if (await (await storage()).get(`session-revoked:${digest(raw)}`) || payload.exp <= now()) return null;
    return { id:payload.email, email:payload.email, restaurantId:payload.restaurantId, role:'owner', token:raw, expires:payload.exp };
  }
  const oauth = {
    google:{ authorize:'https://accounts.google.com/o/oauth2/v2/auth', token:'https://oauth2.googleapis.com/token', userinfo:'https://openidconnect.googleapis.com/v1/userinfo', clientId:env.GOOGLE_CLIENT_ID, secret:env.GOOGLE_CLIENT_SECRET, scope:'openid email profile' },
    chatgpt:{ authorize:env.CHATGPT_AUTHORIZATION_URL, token:env.CHATGPT_TOKEN_URL, userinfo:env.CHATGPT_USERINFO_URL, clientId:env.CHATGPT_CLIENT_ID, secret:env.CHATGPT_CLIENT_SECRET, scope:'openid email profile' },
  };
  const emailConfigured = () => Boolean(env.RESEND_API_KEY && env.EMAIL_FROM);
  const issueSession = email => sessionToken(email, tokenOptions());
  const outbound = (url, options) => fetchImpl(url, { ...options, signal:AbortSignal.timeout(10000) });

  async function handle(req, res) {
    const url = new URL(req.url, origin), pathname = url.pathname, method = req.method || 'GET';
    if (pathname === '/api/health' && method === 'GET') {
      const checks = { origin:configuredOrigin(), sessionKey:(!production && env.NODE_ENV === 'test') || Boolean(env.SESSION_SECRET && Buffer.byteLength(env.SESSION_SECRET) >= 32), email:!production || emailConfigured(), storage:false };
      try { await (await storage()).ping(); checks.storage = true; } catch { /* No credentials or internal errors in public health output. */ }
      const ready = Object.values(checks).every(Boolean);
      return json(res, ready ? 200 : 503, { status:ready ? 'ready' : 'not-ready', checks });
    }
    if (['/app.css','/app.js'].includes(pathname) && method === 'GET') return send(res, 200, await fs.readFile(path.join(root, 'public', pathname.slice(1))), pathname.endsWith('css') ? 'text/css' : 'text/javascript');
    if (pathname === '/' && method === 'GET') return redirect(res, '/seat');
    if (['/seat','/check/invoices','/check/menu','/check/labor'].includes(pathname) && method === 'GET') return send(res, 200, await fs.readFile(path.join(root, 'public/app.html')));
    if (pathname === '/signin' && method === 'GET') {
      const returnTo = safeReturnTo(url.searchParams.get('returnTo'));
      const provider = (id, label) => oauth[id].clientId && oauth[id].secret ? `<a class="button" href="/auth/${id}?returnTo=${encodeURIComponent(returnTo)}">${label}</a>` : '';
      const email = !production || emailConfigured() ? `<form method="post" action="/auth/magic"><input type="hidden" name="returnTo" value="${escape(returnTo)}"><label>Email <input required type="email" name="email" autocomplete="email"></label><button>Email my sign-in link</button></form>` : '<p>Email sign-in is temporarily unavailable. Your browser work stays here.</p>';
      return send(res, 200, html('Sign in', `<h1>Save your Action Shift</h1><p>Your browser work stays here while you sign in.</p><p class="promise">Free forever for the owner · No card · No ChatGPT account required</p>${provider('google','Continue with Google')}${email}${provider('chatgpt','Sign in with ChatGPT (optional)')}<a href="${escape(returnTo)}">Continue without signing in</a>`));
    }
    if (pathname === '/auth/magic' && method === 'POST') {
      requireOrigin(); tokenOptions();
      if (req.headers.origin && req.headers.origin !== origin) throw new RequestError(403, 'Open sign-in from this site.');
      const form = await readForm(req), returnTo = safeReturnTo(form.get('returnTo')), email = normalizeEmail(form.get('email'));
      if (!emailOK(email)) throw new RequestError(429, 'Enter a valid email address and try again.');
      if (production && !emailConfigured()) throw new StoreUnavailableError('Email sign-in is unavailable.');
      const db = await storage();
      const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
      const attempts = await db.increment(`magic-rate:${digest(`${ip}:${email}`)}`, { ttlMs:MAGIC_TTL });
      if (attempts > 5) throw new RequestError(429, 'Wait 15 minutes, then try again.');
      const token = magicToken(email, tokenOptions());
      const link = `/auth/magic/verify?token=${encodeURIComponent(token)}&returnTo=${encodeURIComponent(returnTo)}`;
      if (emailConfigured() && env.NODE_ENV !== 'test') {
        let response;
        try { response = await outbound('https://api.resend.com/emails', { method:'POST', headers:{ Authorization:`Bearer ${env.RESEND_API_KEY}`, 'Content-Type':'application/json' }, body:JSON.stringify({ from:env.EMAIL_FROM, to:email, subject:'Your One Seat sign-in link', html:`<a href="${escape(origin + link)}">Sign in to One Seat</a>` }) }); } catch { throw new StoreUnavailableError('Sign-in email is unavailable.'); }
        if (!response.ok) throw new StoreUnavailableError('Sign-in email is unavailable.');
      }
      const dev = !production ? `<p><a id="dev-magic-link" href="${escape(link)}">Development sign-in link</a></p>` : '';
      return send(res, 200, html('Check your email', `<h1>Check your email</h1><p>If that address can receive mail, a one-time link is on its way. It expires in 15 minutes.</p>${dev}<a href="/signin?returnTo=${encodeURIComponent(returnTo)}">Use another method</a>`));
    }
    if (pathname === '/auth/magic/verify' && method === 'GET') {
      requireOrigin(); const payload = verify(url.searchParams.get('token'), { ...tokenOptions(), purpose:'magic' });
      if (!payload || !emailOK(payload.email) || typeof payload.n !== 'string' || !payload.n) throw new RequestError(400, 'This sign-in link is expired or already used.');
      const db = await storage();
      const remaining = payload.exp - now();
      if (remaining <= 0) throw new RequestError(400, 'This sign-in link is expired or already used.');
      const consumed = await db.putIfAbsent(`magic-used:${digest(payload.n)}`, true, { ttlMs:remaining });
      if (!consumed) throw new RequestError(400, 'This sign-in link is expired or already used.');
      return redirect(res, safeReturnTo(url.searchParams.get('returnTo')), { 'Set-Cookie':cookie('one_seat', issueSession(payload.email)) });
    }
    if (/^\/auth\/(google|chatgpt)$/.test(pathname) && method === 'GET') {
      requireOrigin(); const provider = pathname.split('/').pop(), config = oauth[provider];
      if (!config.clientId || !config.secret || !config.authorize) throw new StoreUnavailableError('This sign-in method is not configured.');
      const state = crypto.randomBytes(24).toString('base64url');
      const stateCookie = cookie('oauth_state', sign({ p:'oauth', state, provider, returnTo:safeReturnTo(url.searchParams.get('returnTo')) }, STATE_TTL, tokenOptions()), STATE_TTL / 1000);
      const target = new URL(config.authorize);
      target.search = new URLSearchParams({ client_id:config.clientId, redirect_uri:`${origin}/auth/${provider}/callback`, response_type:'code', scope:config.scope, state }).toString();
      return redirect(res, target.href, { 'Set-Cookie':stateCookie });
    }
    if (/^\/auth\/(google|chatgpt)\/callback$/.test(pathname) && method === 'GET') {
      requireOrigin(); const provider = pathname.split('/')[2];
      const raw = parseCookies(req.headers.cookie).oauth_state;
      const state = verify(raw, { ...tokenOptions(), purpose:'oauth' });
      if (!state || state.provider !== provider || state.state !== url.searchParams.get('state') || !url.searchParams.get('code') || url.searchParams.get('error')) throw new RequestError(400, 'Sign-in did not finish. Please try again.');
      const db = await storage(), remaining = state.exp - now();
      if (remaining <= 0 || !await db.putIfAbsent(`oauth-used:${digest(raw)}`, true, { ttlMs:remaining })) throw new RequestError(400, 'This sign-in request has already been used or expired.');
      const config = oauth[provider];
      try {
        const response = await outbound(config.token, { method:'POST', headers:{ 'Content-Type':'application/x-www-form-urlencoded' }, body:new URLSearchParams({ grant_type:'authorization_code', code:url.searchParams.get('code'), redirect_uri:`${origin}/auth/${provider}/callback`, client_id:config.clientId, client_secret:config.secret }) });
        if (!response.ok) throw Error('provider');
        const tokens = await response.json(); if (typeof tokens.access_token !== 'string' || !tokens.access_token) throw Error('provider');
        const infoResponse = await outbound(config.userinfo, { headers:{ Authorization:`Bearer ${tokens.access_token}` } });
        if (!infoResponse.ok) throw Error('provider');
        const info = await infoResponse.json();
        if (!emailOK(info.email) || info.email_verified !== true) throw Error('unverified');
        return redirect(res, safeReturnTo(state.returnTo), { 'Set-Cookie':[cookie('one_seat', issueSession(info.email)), cookie('oauth_state','',0)] });
      } catch { throw new RequestError(400, 'We could not verify that account. Please try another sign-in method.'); }
    }
    if (pathname === '/api/session' && method === 'GET') {
      const user = await userFor(req), existing = parseCookies(req.headers.cookie).csrf;
      const csrf = typeof existing === 'string' && /^[A-Za-z0-9_-]{32,96}$/.test(existing) ? existing : crypto.randomBytes(24).toString('base64url');
      return send(res, 200, JSON.stringify({ user:user ? { email:user.email, role:user.role } : null, csrf }), 'application/json', { 'Set-Cookie':`csrf=${csrf}; Path=/; Secure; SameSite=Strict; Max-Age=86400` });
    }
    if (pathname === '/auth/signout' && method === 'POST') {
      requireOrigin(); if (!csrfOkay(req)) throw new RequestError(403, 'Please refresh sign-in and try again.');
      const user = await userFor(req);
      if (user && user.expires > now()) await (await storage()).putIfAbsent(`session-revoked:${digest(user.token)}`, true, { ttlMs:user.expires - now() });
      return redirect(res, '/seat', { 'Set-Cookie':cookie('one_seat','',0) });
    }
    if (pathname === '/api/documents' && method === 'POST') {
      const user = await userFor(req); if (!user) throw new RequestError(401, 'Sign in to save. Your draft stays in this browser.');
      requireOrigin(); if (!csrfOkay(req)) throw new RequestError(403, 'Please refresh sign-in and try again. Your draft is kept.');
      const form = await readForm(req, MAX_CONTENT * 3 + 4096), name = form.get('name'), content = form.get('content');
      if (typeof name !== 'string' || !name.trim() || name.length > 255 || /[\x00-\x1f\x7f]/.test(name)) throw new RequestError(400, 'Choose a report with a valid filename.');
      if (typeof content !== 'string' || !content.length) throw new RequestError(400, 'Add a report before saving.');
      if (Buffer.byteLength(content) > MAX_CONTENT) throw new RequestError(413, 'This report is too large. Keep it under 1 MB.');
      const idempotency = req.headers['idempotency-key'];
      if (idempotency !== undefined && (typeof idempotency !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(idempotency))) throw new RequestError(400, 'Retry this save from your report.');
      const id = idempotency ? crypto.createHmac('sha256', tokenOptions().key).update(`document:${user.restaurantId}:${idempotency}`).digest('hex').slice(0,32) : crypto.randomUUID();
      const item = { id, restaurantId:user.restaurantId, name, content, createdAt:new Date(now()).toISOString(), hash:digest(content) };
      const db = await storage(), key = `document:${user.restaurantId}:${id}`;
      if (await db.putIfAbsent(key, item)) return json(res, 201, item);
      const saved = await db.get(key);
      if (!saved || saved.name !== name || saved.content !== content) throw new RequestError(409, 'This save belongs to a different report. Keep your draft and retry.');
      return json(res, 200, saved);
    }
    const documentRoute = /^\/api\/documents\/([a-f0-9-]{16,64})(\/original)?$/.exec(pathname);
    if (documentRoute && method === 'GET') {
      const user = await userFor(req); if (!user) throw new RequestError(401, 'Sign in to open this report.');
      const item = await (await storage()).get(`document:${user.restaurantId}:${documentRoute[1]}`);
      if (!item || item.restaurantId !== user.restaurantId) throw new RequestError(404, 'That saved report is not available.');
      if (documentRoute[2]) return send(res, 200, item.content, 'text/plain; charset=utf-8', { 'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(item.name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16))}` });
      return json(res, 200, item);
    }
    return send(res, 404, html('Not found','<h1>That page is not here</h1><a class="button" href="/seat">Open One Seat</a>'));
  }
  return async (req, res) => {
    try { return await handle(req,res); }
    catch (error) {
      const unavailable = error instanceof StoreUnavailableError || error?.code === 'STORE_UNAVAILABLE';
      const status = unavailable ? 503 : (error instanceof RequestError ? error.status : 500);
      const message = unavailable ? 'Saving or sign-in is temporarily unavailable. Your browser draft is kept; please try again.' : (error instanceof RequestError ? error.message : 'Something went wrong. Your browser draft is kept; please try again.');
      if (res.headersSent) return res.end();
      if (String(req.url).startsWith('/api/')) return json(res, status, { error:message });
      return send(res, status, html('Please try again', `<h1>${escape(message)}</h1><a class="button" href="/signin">Return to sign-in</a><a href="/seat">Return to your report</a>`));
    }
  };
}
