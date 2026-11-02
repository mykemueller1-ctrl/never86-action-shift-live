import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { sign, verify, sessionToken, magicToken, restaurantIdFor } from '../lib/stateless.js';

process.env.SESSION_SECRET = 'test-secret-not-real';
const { default: vercelHandler } = await import('../api/index.js');
const server = http.createServer(vercelHandler); let base;
before(async () => { await new Promise(r => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${server.address().port}`; });
after(() => server.close());
const cookieOf = (r, name) => (r.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).find(c => c.startsWith(name + '='));

test('signed tokens verify and reject tampering, wrong key, expiry, wrong purpose', () => {
  const t = sign({ p: 'session', email: 'a@example.com' }, 1000, { key: 'k', now: 0 });
  assert.equal(verify(t, { key: 'k', now: 10 }).email, 'a@example.com');
  assert.equal(verify(t.slice(0, -2) + 'xx', { key: 'k', now: 10 }), null);
  assert.equal(verify(t, { key: 'other', now: 10 }), null);
  assert.equal(verify(t, { key: 'k', now: 2000 }), null);
  assert.equal(verify(t, { key: 'k', now: 10, purpose: 'magic' }), null);
  assert.equal(verify('garbage', { key: 'k' }), null);
});

test('magic token cannot be used as a session and vice versa', () => {
  assert.equal(verify(magicToken('a@example.com'), { purpose: 'session' }), null);
  assert.equal(verify(sessionToken('a@example.com'), { purpose: 'magic' }), null);
});

test('same email always maps to the same restaurant, different emails differ', () => {
  assert.equal(restaurantIdFor('a@example.com', 'k'), restaurantIdFor('a@example.com', 'k'));
  assert.notEqual(restaurantIdFor('a@example.com', 'k'), restaurantIdFor('b@example.com', 'k'));
});

test('serverless entry: email link signs in, session survives without server memory, link is single use', async () => {
  for (const route of ['/seat', '/check/menu', '/signin', '/app.css']) assert.equal((await fetch(base + route)).status, 200, route);
  const page = await (await fetch(base + '/auth/magic', { method: 'POST', body: new URLSearchParams({ email: 'Owner@Example.com' }) })).text();
  const link = page.match(/href="(\/auth\/magic\/verify[^"]+)"/)[1].replace(/&amp;/g, '&');
  const r = await fetch(base + link, { redirect: 'manual' });
  assert.equal(r.status, 303);
  const session = cookieOf(r, 'one_seat'); assert.ok(session);
  const me = await (await fetch(base + '/api/session', { headers: { cookie: session } })).json();
  assert.deepEqual({ email: me.user.email, role: me.user.role }, { email: 'owner@example.com', role: 'owner' });
  // a freshly signed token (as another serverless instance would issue) is accepted too
  const other = await (await fetch(base + '/api/session', { headers: { cookie: 'one_seat=' + sessionToken('owner@example.com') } })).json();
  assert.equal(other.user.email, 'owner@example.com');
  assert.equal((await fetch(base + link, { redirect: 'manual' })).status, 400);
  const forged = await (await fetch(base + '/api/session', { headers: { cookie: 'one_seat=' + session.split('=')[1].slice(0, -3) + 'abc' } })).json();
  assert.equal(forged.user, null);
});

test('invalid email gets no link', async () => {
  const r = await fetch(base + '/auth/magic', { method: 'POST', body: new URLSearchParams({ email: 'not-an-email' }) });
  assert.equal(r.status, 429);
});

test('OAuth callback without the signed state cookie is rejected', async () => {
  process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'x';
  const r = await fetch(base + '/auth/google/callback?state=abc&code=x', { redirect: 'manual' });
  assert.equal(r.status, 400);
});

test('saving documents requires a session', async () => {
  const r = await fetch(base + '/api/documents', { method: 'POST', body: 'name=x' });
  assert.equal(r.status, 401);
});
