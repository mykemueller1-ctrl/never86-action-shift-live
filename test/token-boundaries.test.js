import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { sign, verify, sessionToken, magicToken, restaurantIdFor, secret } from '../lib/stateless.js';
import { safeReturnTo, parseCookies } from '../lib/auth.js';

const options = { key: 'synthetic-boundary-test-key', now: 1000 };
const rawSigned = json => {
  const data = Buffer.from(json).toString('base64url');
  return data + '.' + crypto.createHmac('sha256', options.key).update(data).digest('base64url');
};

test('appending token segments cannot bypass token-hash revocation', () => {
  const token = sessionToken('owner@example.test', options);
  assert.ok(verify(token, { ...options, purpose: 'session' }));
  for (const suffix of ['.junk', '.', '..', '.another.signature']) {
    assert.equal(verify(token + suffix, { ...options, purpose: 'session' }), null);
  }
});

test('only canonical unpadded base64url token representations verify', () => {
  const token = sign({ p: 'magic' }, 1000, options);
  const [data, signature] = token.split('.');
  for (const invalid of [data + '=.' + signature, data + '.' + signature + '=', data + '. ' + signature,
    ' ' + token, token + '\n', '.' + signature, data + '.', 'a'.repeat(8193) + '.' + signature]) {
    assert.equal(verify(invalid, options), null);
  }
});

test('malicious signed nonfinite and unsafe expiration values are rejected', () => {
  for (const exp of ['1e999', 'null', '"999999"', '9007199254740992', '-1', '1.5']) {
    assert.equal(verify(rawSigned(`{"p":"session","exp":${exp}}`), options), null);
  }
  assert.equal(verify(rawSigned('[1,2,3]'), options), null);
  assert.equal(verify(sign({ p: 'magic' }, 1000, options), { ...options, purpose: 'session' }), null);
});

test('token creation rejects unbounded, invalid and already-expired lifetimes', () => {
  for (const ttl of [Infinity, NaN, 0, -1, 1.1, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => sign({ p: 'session' }, ttl, options), TypeError);
  }
  assert.throws(() => sign({ p: 'session' }, 100, { ...options, now: NaN }), TypeError);
  assert.equal(verify(sign({ p: 'session' }, 1000, options), { ...options, now: Infinity }), null);
});

test('new sign-ins have independent session identities even at the same timestamp', () => {
  const a = sessionToken(' Owner@Example.test ', options);
  const b = sessionToken('owner@example.test', options);
  assert.notEqual(a, b);
  const first = verify(a, { ...options, purpose: 'session' });
  const second = verify(b, { ...options, purpose: 'session' });
  assert.equal(first.email, 'owner@example.test');
  assert.equal(first.restaurantId, second.restaurantId);
  assert.equal(Buffer.from(first.n, 'base64url').length, 16);
  assert.notEqual(first.n, second.n);
});

test('magic links carry at least 128 bits of per-link replay identity', () => {
  const token = magicToken(' Owner@Example.test ', options);
  const payload = verify(token, { ...options, purpose: 'magic' });
  assert.equal(payload.email, 'owner@example.test');
  assert.equal(Buffer.from(payload.n, 'base64url').length, 16);
});

test('restaurant identity always normalizes verified email input', () => {
  assert.equal(restaurantIdFor(' Owner@Example.test ', options.key), restaurantIdFor('owner@example.test', options.key));
  assert.notEqual(restaurantIdFor('other@example.test', options.key), restaurantIdFor('owner@example.test', options.key));
});

test('return destinations preserve real product tasks and reject external or unknown paths', () => {
  assert.equal(safeReturnTo('/check/menu?draft=1'), '/check/menu?draft=1');
  assert.equal(safeReturnTo('/check/invoices#original'), '/check/invoices#original');
  for (const input of ['//evil.test', '/\\evil.test', 'https://evil.test', '/%5cevil.test', '/%2f%2fevil.test',
    '/signin', '/auth/magic/verify', '/seat\r\nLocation: https://evil.test', '/seat?x=%0d%0aLocation:bad',
    '/check/menu?x=%ZZ', null, {}, '/seat/../other']) assert.equal(safeReturnTo(input), '/seat');
});

test('return destinations cannot escape the sign-in form HTML attributes', () => {
  const destination = safeReturnTo('/check/menu?draft="><script>alert(1)</script>#\'');
  assert.ok(destination.startsWith('/check/menu?'));
  assert.doesNotMatch(destination, /["'<>\r\n]/);
});

test('malformed cookies do not break valid sessions or truncate values with equals signs', () => {
  const cookies = parseCookies('bad=%ZZ; one_seat=real-token; opaque=a=b=c; x=hello%20world');
  assert.equal(cookies.one_seat, 'real-token');
  assert.equal(cookies.opaque, 'a=b=c');
  assert.equal(cookies.x, 'hello world');
  assert.equal(cookies.bad, undefined);
  assert.equal(parseCookies('one_seat=first; one_seat=second').one_seat, 'first');
  assert.equal(Object.getPrototypeOf(parseCookies('__proto__=oops')), null);
  assert.equal(parseCookies(undefined).one_seat, undefined);
});

test('production and serverless preview require stable signing keys of at least 32 UTF-8 bytes', () => {
  const names = ['NODE_ENV', 'VERCEL', 'VERCEL_ENV', 'SESSION_SECRET'];
  const before = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    for (const configuration of [{ NODE_ENV: 'production' }, { NODE_ENV: 'test', VERCEL: '1', VERCEL_ENV: 'preview' },
      { NODE_ENV: 'test', VERCEL_ENV: 'production' }]) {
      for (const name of names) delete process.env[name];
      Object.assign(process.env, configuration);
      assert.throws(() => secret(), /at least 32 bytes/);
      process.env.SESSION_SECRET = 'too-short';
      assert.throws(() => secret(), /at least 32 bytes/);
      const configured = 'a'.repeat(32);
      process.env.SESSION_SECRET = configured;
      assert.equal(secret(), configured);
      process.env.SESSION_SECRET = '🔑'.repeat(8);
      assert.equal(Buffer.byteLength(secret(), 'utf8'), 32);
    }
    for (const name of names) delete process.env[name];
    process.env.NODE_ENV = 'test';
    process.env.SESSION_SECRET = 'explicit-development-test-key';
    assert.equal(secret(), process.env.SESSION_SECRET);
    delete process.env.SESSION_SECRET;
    assert.ok(Buffer.byteLength(secret(), 'utf8') >= 32);
    // Explicit synthetic keys remain supported for isolated crypto tests.
    assert.ok(verify(sign({ p: 'test' }, 1000, { key: 'synthetic', now: 0 }), { key: 'synthetic', now: 1 }));
  } finally {
    for (const name of names) {
      if (before[name] === undefined) delete process.env[name]; else process.env[name] = before[name];
    }
  }
});
