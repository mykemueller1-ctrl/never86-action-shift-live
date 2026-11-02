import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export class StoreUnavailableError extends Error {
  constructor(message = 'Saved restaurant data is temporarily unavailable.') {
    super(message); this.name = 'StoreUnavailableError'; this.code = 'STORE_UNAVAILABLE';
  }
}

const serialize = value => {
  let encoded;
  try { encoded = JSON.stringify(value); } catch { throw new TypeError('Store values must be JSON serializable.'); }
  if (encoded === undefined) throw new TypeError('Store values must be JSON serializable.');
  return encoded;
};
const deserialize = encoded => {
  try { return JSON.parse(encoded); } catch { throw new StoreUnavailableError(); }
};
const duration = ttlMs => {
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new TypeError('TTL must be a positive integer in milliseconds.');
  return ttlMs;
};
const namespaceValue = value => {
  const namespace = value ?? 'one-seat:v1';
  if (typeof namespace !== 'string' || !/^[a-zA-Z0-9:_-]{1,80}$/.test(namespace))
    throw new StoreUnavailableError('The shared data namespace is not configured correctly.');
  return namespace;
};
const scopedKey = (namespace, key) => {
  if (typeof key !== 'string' || !key || key.length > 1024) throw new TypeError('A nonempty storage key is required.');
  return `${namespace}:${crypto.createHash('sha256').update(key).digest('hex')}`;
};

// Shared Redis commands retain state between serverless instances. No failure
// falls back to a process Map or an ephemeral filesystem.
export class RedisSharedStore {
  constructor({ url, token, fetchImpl = globalThis.fetch, namespace } = {}) {
    let parsed;
    try { parsed = new URL(url); } catch { throw new StoreUnavailableError('Shared storage configuration is incomplete.'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash ||
        typeof token !== 'string' || !token.trim() || typeof fetchImpl !== 'function')
      throw new StoreUnavailableError('Shared storage configuration is incomplete.');
    this.url = parsed.href.replace(/\/$/, ''); this.token = token; this.fetchImpl = fetchImpl;
    this.namespace = namespaceValue(namespace);
  }

  async command(command) {
    try {
      const response = await this.fetchImpl(this.url, {
        method: 'POST', headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(command), signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new StoreUnavailableError();
      const data = await response.json();
      if (!data || data.error || !Object.hasOwn(data, 'result')) throw new StoreUnavailableError();
      return data.result;
    } catch { throw new StoreUnavailableError(); }
  }

  async get(key) {
    const value = await this.command(['GET', scopedKey(this.namespace, key)]);
    if (value === null) return null;
    if (typeof value !== 'string') throw new StoreUnavailableError();
    return deserialize(value);
  }

  async putIfAbsent(key, value, { ttlMs } = {}) {
    const command = ['SET', scopedKey(this.namespace, key), serialize(value), 'NX'];
    if (ttlMs !== undefined) command.push('PX', String(duration(ttlMs)));
    const result = await this.command(command);
    if (result !== null && result !== 'OK') throw new StoreUnavailableError();
    return result === 'OK';
  }

  async set(key, value, { ttlMs } = {}) {
    const command = ['SET', scopedKey(this.namespace, key), serialize(value)];
    if (ttlMs !== undefined) command.push('PX', String(duration(ttlMs)));
    if (await this.command(command) !== 'OK') throw new StoreUnavailableError();
  }

  async increment(key, { ttlMs } = {}) {
    // A single script establishes the first increment and its expiration. The
    // window cannot extend on later requests or become immortal after a crash.
    const script = "local v=redis.call('GET',KEYS[1]); if v then local n=tonumber(v); if not n or n<0 or n%1~=0 or n>=9007199254740991 or redis.call('PTTL',KEYS[1])<0 then return redis.error_reply('INVALID_COUNTER') end return redis.call('INCR',KEYS[1]) end redis.call('SET',KEYS[1],'1','PX',ARGV[1]); return 1";
    const result = await this.command(['EVAL', script, '1', scopedKey(this.namespace, key), String(duration(ttlMs))]);
    if (!Number.isSafeInteger(result) || result < 1) throw new StoreUnavailableError();
    return result;
  }

  async delete(key) { return await this.command(['DEL', scopedKey(this.namespace, key)]) > 0; }
  async ping() { if (await this.command(['PING']) !== 'PONG') throw new StoreUnavailableError(); return true; }
  async close() {}
}

export class SQLiteSharedStore {
  constructor({ database, now = Date.now, namespace } = {}) {
    this.database = database; this.now = now; this.namespace = namespaceValue(namespace); this.closed = false;
    database.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS one_seat_kv (k TEXT PRIMARY KEY NOT NULL, v TEXT NOT NULL, expires_at INTEGER);');
    this.read = database.prepare('SELECT v, expires_at FROM one_seat_kv WHERE k=?');
    this.removeExpired = database.prepare('DELETE FROM one_seat_kv WHERE k=? AND expires_at IS NOT NULL AND expires_at<=?');
    this.insert = database.prepare('INSERT INTO one_seat_kv(k,v,expires_at) VALUES(?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, expires_at=excluded.expires_at WHERE one_seat_kv.expires_at IS NOT NULL AND one_seat_kv.expires_at<=?');
    this.write = database.prepare('INSERT INTO one_seat_kv(k,v,expires_at) VALUES(?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, expires_at=excluded.expires_at');
    this.remove = database.prepare('DELETE FROM one_seat_kv WHERE k=?');
  }

  static async open({ filename, now, namespace } = {}) {
    let database;
    try {
      const { DatabaseSync } = await import('node:sqlite');
      if (filename !== ':memory:') {
        await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
        const file = await fs.open(filename, 'a', 0o600); await file.close();
        await fs.chmod(filename, 0o600);
      }
      // Two fresh processes can contend while switching a new file to WAL.
      // SQLite's busy timeout does not cover every journal/schema transition.
      // Retry only explicit busy/locked startup errors, after closing the failed
      // connection; ordinary I/O/configuration failures remain immediate.
      for (let attempt = 0; ; attempt++) {
        try {
          database = new DatabaseSync(filename);
          return new SQLiteSharedStore({ database, now, namespace });
        } catch (error) {
          try { database?.close(); } catch {}
          database = undefined;
          const code = Number(error?.errcode) & 0xff;
          if (![5, 6].includes(code) || attempt >= 3) throw error;
          await new Promise(resolve => setTimeout(resolve, 15 * 2 ** attempt));
        }
      }
    } catch {
      try { database?.close(); } catch {}
      throw new StoreUnavailableError('Local durable storage could not be opened. Use Node.js 22.13 or newer and a writable data path.');
    }
  }

  run(operation) {
    if (this.closed) throw new StoreUnavailableError();
    try { return operation(); } catch (error) {
      if (error instanceof TypeError || error instanceof StoreUnavailableError) throw error;
      throw new StoreUnavailableError();
    }
  }

  time() {
    const now = this.now();
    if (!Number.isSafeInteger(now)) throw new StoreUnavailableError();
    return now;
  }

  expiry(ttlMs, now) {
    if (ttlMs === undefined) return null;
    const expires = now + duration(ttlMs);
    if (!Number.isSafeInteger(expires)) throw new TypeError('TTL is outside the supported range.');
    return expires;
  }

  async get(key) {
    const scoped = scopedKey(this.namespace, key);
    return this.run(() => {
      const row = this.read.get(scoped); if (!row) return null;
      const now = this.time();
      if (row.expires_at !== null && row.expires_at <= now) { this.removeExpired.run(scoped, now); return null; }
      return deserialize(row.v);
    });
  }

  async putIfAbsent(key, value, { ttlMs } = {}) {
    const scoped = scopedKey(this.namespace, key), encoded = serialize(value);
    return this.run(() => { const now = this.time(); return this.insert.run(scoped, encoded, this.expiry(ttlMs, now), now).changes === 1; });
  }

  async set(key, value, { ttlMs } = {}) {
    const scoped = scopedKey(this.namespace, key), encoded = serialize(value);
    return this.run(() => { const now = this.time(); this.write.run(scoped, encoded, this.expiry(ttlMs, now)); });
  }

  async increment(key, { ttlMs } = {}) {
    const scoped = scopedKey(this.namespace, key); duration(ttlMs);
    return this.run(() => {
      let started = false;
      try {
        this.database.exec('BEGIN IMMEDIATE'); started = true;
        const now = this.time(), row = this.read.get(scoped);
        const active = row && (row.expires_at === null || row.expires_at > now);
        const current = active ? deserialize(row.v) : 0;
        if (!Number.isSafeInteger(current) || current < 0 || current >= Number.MAX_SAFE_INTEGER) throw new StoreUnavailableError();
        if (active && row.expires_at === null) throw new StoreUnavailableError();
        const expires = active ? row.expires_at : this.expiry(ttlMs, now);
        this.write.run(scoped, serialize(current + 1), expires);
        this.database.exec('COMMIT'); return current + 1;
      } catch (error) {
        if (started) { try { this.database.exec('ROLLBACK'); } catch {} }
        throw error;
      }
    });
  }

  async delete(key) { const scoped = scopedKey(this.namespace, key); return this.run(() => this.remove.run(scoped).changes > 0); }
  async ping() { return this.run(() => { this.database.prepare('SELECT 1').get(); return true; }); }
  async close() { if (!this.closed) { this.database.close(); this.closed = true; } }
}

export async function createSharedStore({ env = process.env, now = Date.now, fetchImpl = globalThis.fetch } = {}) {
  const upstash = [env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN];
  const vercel = [env.KV_REST_API_URL, env.KV_REST_API_TOKEN];
  const pair = upstash.some(Boolean) ? upstash : vercel;
  if (pair.some(Boolean)) {
    if (!pair.every(value => typeof value === 'string' && value.trim())) throw new StoreUnavailableError('Shared storage configuration is incomplete.');
    return new RedisSharedStore({ url: pair[0], token: pair[1], fetchImpl, namespace: env.DATA_NAMESPACE });
  }
  if (env.NODE_ENV === 'production' || env.VERCEL || env.VERCEL_ENV)
    throw new StoreUnavailableError('Configure shared durable storage before enabling operator accounts.');
  const filename = env.DATA_FILE || (env.NODE_ENV === 'test' ? ':memory:' : path.resolve('.data/one-seat.sqlite'));
  return SQLiteSharedStore.open({ filename, now, namespace: env.DATA_NAMESPACE });
}
