import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createSharedStore, StoreUnavailableError } from '../lib/shared-store.js';

const execute = promisify(execFile);
const envFor = filename => ({ NODE_ENV: 'test', DATA_FILE: filename });
const withFile = async callback => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'one-seat-storage-'));
  try { await callback(path.join(directory, 'documents.sqlite')); }
  finally { await fs.rm(directory, { recursive: true, force: true }); }
};

test('documents survive a real file close and reopen', async () => withFile(async filename => {
  const first = await createSharedStore({ env: envFor(filename) });
  const document = { id: 'report-1', restaurantId: 'operator-a', name: 'Monday close', content: 'Subtotal 1200\nLabor 300' };
  await first.set('document:report-1', document); await first.close();
  const reopened = await createSharedStore({ env: envFor(filename) });
  try { assert.deepEqual(await reopened.get('document:report-1'), document); }
  finally { await reopened.close(); }
}));

test('two independent storage instances share documents and single-use claims', async () => withFile(async filename => {
  const first = await createSharedStore({ env: envFor(filename) });
  const second = await createSharedStore({ env: envFor(filename) });
  try {
    await first.set('operator-a:document', { content: 'retained original' });
    assert.deepEqual(await second.get('operator-a:document'), { content: 'retained original' });
    const claims = await Promise.all([first.putIfAbsent('used-link:n', true, { ttlMs: 900000 }), second.putIfAbsent('used-link:n', true, { ttlMs: 900000 })]);
    assert.equal(claims.filter(Boolean).length, 1);
  } finally { await first.close(); await second.close(); }
}));

test('separate Node processes cannot both consume one single-use claim', async () => withFile(async filename => {
  const source = new URL('../lib/shared-store.js', import.meta.url).href;
  const script = `import {createSharedStore} from ${JSON.stringify(source)};
    const store=await createSharedStore({env:{NODE_ENV:'test',DATA_FILE:process.argv[1]}});
    console.log(JSON.stringify(await store.putIfAbsent('same-magic-link',true,{ttlMs:900000})));
    await store.close();`;
  const results = await Promise.all([0, 1].map(() => execute(process.execPath, ['--input-type=module', '-e', script, filename])));
  assert.equal(results.map(result => JSON.parse(result.stdout.trim())).filter(Boolean).length, 1);
}));

test('expiration makes a consumed claim reusable only after its TTL', async () => {
  let now = 1000; const store = await createSharedStore({ env: { NODE_ENV: 'test' }, now: () => now });
  try {
    assert.equal(await store.putIfAbsent('claim', 'first', { ttlMs: 100 }), true);
    now = 1099; assert.equal(await store.putIfAbsent('claim', 'second', { ttlMs: 100 }), false);
    now = 1100; assert.equal(await store.get('claim'), null);
    assert.equal(await store.putIfAbsent('claim', 'second', { ttlMs: 100 }), true);
    assert.equal(await store.get('claim'), 'second');
  } finally { await store.close(); }
});

test('rate-limit expiration is anchored to the first increment, not extended by later requests', async () => {
  let now = 1000; const store = await createSharedStore({ env: { NODE_ENV: 'test' }, now: () => now });
  try {
    assert.equal(await store.increment('email-rate', { ttlMs: 100 }), 1);
    now = 1099; assert.equal(await store.increment('email-rate', { ttlMs: 100 }), 2);
    now = 1100; assert.equal(await store.increment('email-rate', { ttlMs: 100 }), 1);
  } finally { await store.close(); }
});

test('an existing zero counter does not extend the anchored expiration', async () => {
  let now = 1000; const store = await createSharedStore({ env: { NODE_ENV: 'test' }, now: () => now });
  try {
    await store.set('counter', 0, { ttlMs: 100 });
    now = 1099; assert.equal(await store.increment('counter', { ttlMs: 100 }), 1);
    now = 1100; assert.equal(await store.get('counter'), null);
  } finally { await store.close(); }
});

test('counters without expiration fail closed rather than become an unbounded rate-limit window', async () => {
  const store = await createSharedStore({ env: { NODE_ENV: 'test' } });
  try {
    await store.set('counter', 0);
    await assert.rejects(store.increment('counter', { ttlMs: 100 }), StoreUnavailableError);
    assert.equal(await store.get('counter'), 0);
  } finally { await store.close(); }
});

test('counters serialize across independent instances', async () => withFile(async filename => {
  const first = await createSharedStore({ env: envFor(filename) });
  const second = await createSharedStore({ env: envFor(filename) });
  try {
    const counts = await Promise.all(Array.from({ length: 20 }, (_, index) => (index % 2 ? first : second).increment('requests', { ttlMs: 60000 })));
    assert.deepEqual(counts.sort((a, b) => a - b), Array.from({ length: 20 }, (_, index) => index + 1));
    assert.equal(await first.get('requests'), 20);
  } finally { await first.close(); await second.close(); }
}));

test('different namespaces cannot read or consume each other’s keys', async () => withFile(async filename => {
  const first = await createSharedStore({ env: { ...envFor(filename), DATA_NAMESPACE: 'pilot-a' } });
  const second = await createSharedStore({ env: { ...envFor(filename), DATA_NAMESPACE: 'pilot-b' } });
  try {
    await first.set('same-key', { private: 'first' });
    assert.equal(await second.get('same-key'), null);
    assert.equal(await second.putIfAbsent('same-key', { private: 'second' }), true);
    assert.deepEqual(await first.get('same-key'), { private: 'first' });
  } finally { await first.close(); await second.close(); }
}));

test('local storage rejects invalid TTLs and cannot silently overflow counters', async () => {
  const store = await createSharedStore({ env: { NODE_ENV: 'test' } });
  try {
    await assert.rejects(store.putIfAbsent('x', true, { ttlMs: 0 }), TypeError);
    await assert.rejects(store.increment('x', {}), TypeError);
    await store.set('counter', Number.MAX_SAFE_INTEGER);
    await assert.rejects(store.increment('counter', { ttlMs: 100 }), StoreUnavailableError);
    assert.equal(await store.get('counter'), Number.MAX_SAFE_INTEGER);
    await assert.rejects(store.set('', {}), TypeError);
    await assert.rejects(store.set('x', undefined), TypeError);
  } finally { await store.close(); }
});

test('production and serverless deployments never fall back to a local or in-memory store', async () => {
  for (const env of [{ NODE_ENV: 'production', DATA_FILE: ':memory:' }, { NODE_ENV: 'test', VERCEL: '1' }, { VERCEL_ENV: 'preview' }])
    await assert.rejects(createSharedStore({ env }), StoreUnavailableError);
});

test('partial or insecure Redis configuration fails closed without making a request', async () => {
  let calls = 0; const fetchImpl = async () => { calls++; throw Error('must not run'); };
  for (const env of [
    { NODE_ENV: 'production', UPSTASH_REDIS_REST_URL: 'https://redis.example.test' },
    { NODE_ENV: 'production', KV_REST_API_URL: 'http://redis.example.test', KV_REST_API_TOKEN: 'not-a-real-token' },
    { NODE_ENV: 'production', KV_REST_API_URL: 'https://user:password@redis.example.test', KV_REST_API_TOKEN: 'not-a-real-token' },
  ]) await assert.rejects(createSharedStore({ env, fetchImpl }), StoreUnavailableError);
  assert.equal(calls, 0);
});

test('Redis REST carries namespaced JSON and atomic NX/TTL/counter commands', async () => {
  const commands = [], replies = ['OK', JSON.stringify({ original: 'exact text' }), null, 2, 'PONG'];
  const store = await createSharedStore({ env: {
    NODE_ENV: 'production', UPSTASH_REDIS_REST_URL: 'https://redis.example.test', UPSTASH_REDIS_REST_TOKEN: 'test-token',
  }, fetchImpl: async (url, options) => {
    assert.equal(url, 'https://redis.example.test'); assert.equal(options.headers.Authorization, 'Bearer test-token');
    assert.ok(options.signal instanceof AbortSignal); commands.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ result: replies.shift() }) };
  } });
  assert.equal(await store.putIfAbsent('private-owner@example.test', { original: 'exact text' }, { ttlMs: 900000 }), true);
  assert.deepEqual(await store.get('private-owner@example.test'), { original: 'exact text' });
  assert.equal(await store.putIfAbsent('private-owner@example.test', false), false);
  assert.equal(await store.increment('rate', { ttlMs: 900000 }), 2); assert.equal(await store.ping(), true);
  assert.deepEqual(commands[0].slice(3), ['NX', 'PX', '900000']);
  assert.match(commands[0][1], /^one-seat:v1:[a-f0-9]{64}$/); assert.doesNotMatch(commands[0][1], /private-owner/);
  assert.equal(commands[3][0], 'EVAL'); assert.match(commands[3][1], /INCR/); assert.match(commands[3][1], /PX/);
  assert.equal(commands[3][2], '1'); assert.equal(commands[3][4], '900000');
});

test('Vercel KV-compatible variable bindings select the shared Redis adapter', async () => {
  const store = await createSharedStore({ env: { VERCEL: '1', KV_REST_API_URL: 'https://redis.example.test', KV_REST_API_TOKEN: 'test-token' },
    fetchImpl: async () => ({ ok: true, json: async () => ({ result: 'PONG' }) }) });
  assert.equal(await store.ping(), true);
});

test('shared-store network/provider failures are sanitized and never use an ephemeral fallback', async () => {
  for (const fetchImpl of [
    async () => { throw Error('Bearer secret-value https://private-host'); },
    async () => ({ ok: false, status: 401 }),
    async () => ({ ok: true, json: async () => ({ error: 'secret-provider-details' }) }),
    async () => ({ ok: true, json: async () => ({ unexpected: 'body' }) }),
  ]) {
    const store = await createSharedStore({ env: { NODE_ENV: 'production', UPSTASH_REDIS_REST_URL: 'https://redis.example.test', UPSTASH_REDIS_REST_TOKEN: 'secret-value' }, fetchImpl });
    await assert.rejects(store.get('owner-data'), error => error instanceof StoreUnavailableError && !/secret|private-host/.test(error.message));
    await assert.rejects(store.putIfAbsent('used-link', true, { ttlMs: 1000 }), StoreUnavailableError);
  }
});

test('expired values and explicit deletion do not affect permanent documents', async () => {
  let now = 1000; const store = await createSharedStore({ env: { NODE_ENV: 'test' }, now: () => now });
  try {
    await store.set('document', { content: 'keep' }); await store.set('temporary', 'expire', { ttlMs: 1 });
    now = 1001; assert.equal(await store.get('temporary'), null); assert.deepEqual(await store.get('document'), { content: 'keep' });
    assert.equal(await store.delete('document'), true); assert.equal(await store.delete('document'), false);
    assert.equal(await store.get('document'), null); assert.equal(await store.ping(), true);
  } finally { await store.close(); }
});
