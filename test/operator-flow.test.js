import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHandler } from '../lib/operator-app.js';
import { createSharedStore } from '../lib/shared-store.js';
import { sessionToken, magicToken, sign, restaurantIdFor, STATE_TTL } from '../lib/stateless.js';

const key = 'test-only-session-key-at-least-32-bytes';
const origin = 'https://one-seat.example.test';
const cookies = (r, name) => r.headers.getSetCookie().map(value => value.split(';')[0]).find(value => value.startsWith(name + '='));

async function fixture(count = 2, options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'one-seat-flow-'));
  const env = { NODE_ENV:'test', SESSION_SECRET:key, APP_ORIGIN:origin, DATA_FILE:path.join(dir,'data.sqlite'), ...options.env };
  const apps = [];
  async function start() {
    const db = await createSharedStore({ env:{ ...env, NODE_ENV:'test', VERCEL:'' } });
    const server = http.createServer(createHandler({ env, store:db, fetchImpl:options.fetchImpl }));
    await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
    const app = { db, server, base:`http://127.0.0.1:${server.address().port}` };
    apps.push(app); return app;
  }
  async function closeApps() {
    for (const app of apps.splice(0)) {
      await new Promise(resolve => app.server.close(resolve)); await app.db.close();
    }
  }
  try { for (let i=0; i<count; i++) await start(); }
  catch (error) { await closeApps(); await rm(dir,{recursive:true,force:true}); throw error; }
  return { apps, start, closeApps, env, async close() { await closeApps(); await rm(dir,{recursive:true,force:true}); } };
}
async function login(app, email) {
  const request = await fetch(app.base+'/auth/magic', { method:'POST', body:new URLSearchParams({ email, returnTo:'/check/labor?draft=1' }) });
  assert.equal(request.status,200);
  const page = await request.text(), link = page.match(/href="(\/auth\/magic\/verify[^"]+)"/)[1].replace(/&amp;/g,'&');
  const verified = await fetch(app.base+link, { redirect:'manual' });
  assert.equal(verified.status,303); assert.equal(verified.headers.get('location'),'/check/labor?draft=1');
  return cookies(verified,'one_seat');
}
async function authHeaders(app, session) {
  const response = await fetch(app.base+'/api/session', { headers:{ cookie:session } });
  assert.equal(response.status,200); const { csrf, user } = await response.json(); assert.ok(user);
  return { cookie:`${session}; csrf=${csrf}`, 'x-csrf-token':csrf, origin };
}
async function save(app, headers, content='Subtotal\t3156.58\r\nLabor\t1087.92\r\n', idempotency='saved-report-test-0001') {
  return fetch(app.base+'/api/documents', { method:'POST', headers:{ ...headers, 'Idempotency-Key':idempotency }, body:new URLSearchParams({ name:'Original report café.txt', content }) });
}

test('new operators sign in, save exact originals and remain isolated across instances', async () => {
  const f = await fixture();
  try {
    const [a,b] = f.apps;
    const aSession = await login(a,'Operator-A@example.test'), bSession = await login(b,'operator-b@example.test');
    const headers = await authHeaders(a,aSession), other = await authHeaders(b,bSession);
    const response = await save(a,headers); assert.equal(response.status,201); const doc = await response.json();
    assert.equal(doc.content,'Subtotal\t3156.58\r\nLabor\t1087.92\r\n');
    assert.equal(doc.hash,crypto.createHash('sha256').update(doc.content).digest('hex'));
    const opened = await fetch(b.base+'/api/documents/'+doc.id,{headers}); assert.equal(opened.status,200);
    assert.equal((await opened.json()).content,doc.content);
    assert.equal((await fetch(b.base+'/api/documents/'+doc.id,{headers:other})).status,404);
    assert.equal((await fetch(b.base+'/api/documents/'+doc.id+'/original',{headers:other})).status,404);
    assert.equal((await fetch(b.base+'/api/documents/'+doc.id)).status,401);
    const original = await fetch(b.base+'/api/documents/'+doc.id+'/original',{headers});
    assert.equal(original.status,200); assert.equal(await original.text(),doc.content);
    assert.match(original.headers.get('content-disposition'),/attachment; filename\*=UTF-8''/);
  } finally { await f.close(); }
});

test('a saved original survives every app/store connection closing and a fresh instance opening', async () => {
  const f = await fixture(1);
  try {
    const session = await login(f.apps[0],'restart@example.test');
    const response = await save(f.apps[0],await authHeaders(f.apps[0],session)); const doc = await response.json();
    await f.closeApps(); const restarted = await f.start();
    const reloaded = await fetch(restarted.base+'/api/documents/'+doc.id,{headers:{cookie:session}});
    assert.equal(reloaded.status,200); assert.deepEqual(await reloaded.json(),doc);
  } finally { await f.close(); }
});

test('lost-response retries are idempotent across workers; changing the same save fails truthfully', async () => {
  const f = await fixture();
  try {
    const session = await login(f.apps[0],'retry@example.test'), headers = await authHeaders(f.apps[0],session);
    const [first,second] = await Promise.all(f.apps.map(app=>save(app,headers)));
    assert.deepEqual([first.status,second.status].sort(),[200,201]);
    const a = await first.json(), b = await second.json(); assert.equal(a.id,b.id); assert.deepEqual(a,b);
    assert.equal((await save(f.apps[1],headers,'changed report')).status,409);
  } finally { await f.close(); }
});

test('the same magic link cannot sign in concurrently on two workers or after restart', async () => {
  const f = await fixture();
  try {
    const token = magicToken('single@example.test',{key}), route = '/auth/magic/verify?token='+encodeURIComponent(token);
    const results = await Promise.all(f.apps.map(app=>fetch(app.base+route,{redirect:'manual'})));
    assert.deepEqual(results.map(r=>r.status).sort(),[303,400]);
    await f.closeApps(); const restarted = await f.start();
    assert.equal((await fetch(restarted.base+route,{redirect:'manual'})).status,400);
  } finally { await f.close(); }
});

test('sign-out revokes the cookie on other workers and restart; a new login still reaches its reports', async () => {
  const f = await fixture();
  try {
    const session = await login(f.apps[0],'logout@example.test'), headers = await authHeaders(f.apps[0],session);
    const doc = await (await save(f.apps[0],headers)).json();
    const signedOut = await fetch(f.apps[0].base+'/auth/signout',{method:'POST',headers,redirect:'manual'});
    assert.equal(signedOut.status,303);
    assert.equal((await fetch(f.apps[1].base+'/api/documents/'+doc.id,{headers:{cookie:session}})).status,401);
    await f.closeApps(); const restarted = await f.start();
    assert.equal((await fetch(restarted.base+'/api/documents/'+doc.id,{headers:{cookie:session}})).status,401);
    const newSession = await login(restarted,'logout@example.test'); assert.notEqual(newSession,session);
    assert.equal((await fetch(restarted.base+'/api/documents/'+doc.id,{headers:{cookie:newSession}})).status,200);
  } finally { await f.close(); }
});

test('email rate limits are shared across workers', async () => {
  const f = await fixture();
  try {
    for (let i=0;i<5;i++) {
      const r=await fetch(f.apps[i%2].base+'/auth/magic',{method:'POST',body:new URLSearchParams({email:'limited@example.test'})});
      assert.equal(r.status,200);
    }
    assert.equal((await fetch(f.apps[1].base+'/auth/magic',{method:'POST',body:new URLSearchParams({email:'limited@example.test'})})).status,429);
  } finally { await f.close(); }
});

test('failed CSRF and oversized reports are rejected without a successful receipt', async () => {
  const f = await fixture(1);
  try {
    const app=f.apps[0],session=await login(app,'checks@example.test'),headers=await authHeaders(app,session);
    assert.equal((await save(app,{...headers,origin:'https://other.example.test'})).status,403);
    const response=await save(app,headers,'x'.repeat(1024*1024+1));
    assert.equal(response.status,413); assert.equal((await response.json()).id,undefined);
    const me=await fetch(app.base+'/api/session',{headers});assert.equal((await me.json()).csrf,headers['x-csrf-token']);
  } finally { await f.close(); }
});

test('production missing shared storage stays unavailable instead of accepting a save', async () => {
  const env={NODE_ENV:'production',APP_ORIGIN:origin,SESSION_SECRET:key};
  const server=http.createServer(createHandler({env}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(base+'/seat')).status,200);
    const health=await fetch(base+'/api/health'); assert.equal(health.status,503);assert.equal((await health.json()).checks.storage,false);
    const response=await fetch(base+'/api/documents',{method:'POST',headers:{cookie:'one_seat='+sessionToken('missing@example.test',{key})},body:'name=x&content=x'});
    assert.equal(response.status,503); const body=await response.text();assert.doesNotMatch(body,/test-only-session|redis|sqlite/i);
  } finally { await new Promise(r=>server.close(r)); }
});

test('provider delivery errors never claim an email was sent or expose a development link', async () => {
  const f=await fixture(1,{env:{NODE_ENV:'production',RESEND_API_KEY:'fake-provider-key',EMAIL_FROM:'seat@example.test'},fetchImpl:async()=>new Response('denied',{status:403})});
  try {
    const r=await fetch(f.apps[0].base+'/auth/magic',{method:'POST',body:new URLSearchParams({email:'mail@example.test'})});
    assert.equal(r.status,503); assert.doesNotMatch(await r.text(),/on its way|dev-magic-link|fake-provider-key/);
  } finally { await f.close(); }
});

test('OAuth requires explicitly verified email and consumes callback state across workers', async () => {
  let calls=0;
  const f=await fixture(2,{env:{GOOGLE_CLIENT_ID:'fake-client',GOOGLE_CLIENT_SECRET:'fake-secret'},fetchImpl:async()=>{
    calls++;return new Response(JSON.stringify(calls===1?{access_token:'fake-token'}:{email:'oauth@example.test'}));
  }});
  try {
    const state='one-time-oauth-state',raw=sign({p:'oauth',provider:'google',state,returnTo:'/seat'},STATE_TTL,{key});
    const route='/auth/google/callback?state='+state+'&code=fake';
    const first=await fetch(f.apps[0].base+route,{headers:{cookie:'oauth_state='+raw},redirect:'manual'});
    assert.equal(first.status,400);assert.equal(first.headers.get('set-cookie'),null);
    const second=await fetch(f.apps[1].base+route,{headers:{cookie:'oauth_state='+raw},redirect:'manual'});
    assert.equal(second.status,400);assert.equal(calls,2);
  } finally { await f.close(); }
});

test('expiry during the shared-session check still signs out without an invalid revocation TTL', async () => {
  let now=0,writes=0;
  const email='expiring@example.test';
  const raw=sign({p:'session',email,role:'owner',restaurantId:restaurantIdFor(email,key)},100,{key,now});
  const store={get:async()=>{now=101;return null;},putIfAbsent:async()=>{writes++;throw Error('Expired tokens need no revocation write.');}};
  const server=http.createServer(createHandler({env:{NODE_ENV:'test',APP_ORIGIN:origin,SESSION_SECRET:key},store,now:()=>now}));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try{
    const csrf='a'.repeat(32);
    const r=await fetch(`http://127.0.0.1:${server.address().port}/auth/signout`,{method:'POST',headers:{origin,cookie:`one_seat=${raw}; csrf=${csrf}`,'x-csrf-token':csrf},redirect:'manual'});
    assert.equal(r.status,303);assert.match(cookies(r,'one_seat'),/^one_seat=$/);assert.equal(writes,0);
  }finally{await new Promise(r=>server.close(r));}
});

test('non-test local sign-in requires a stable key to retain restaurant identity across restarts', async () => {
  const server=http.createServer(createHandler({env:{NODE_ENV:'development',APP_ORIGIN:origin},store:{ping:async()=>true}}));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
  try{
    const health=await fetch(base+'/api/health');assert.equal(health.status,503);assert.equal((await health.json()).checks.sessionKey,false);
    const r=await fetch(base+'/auth/magic',{method:'POST',body:new URLSearchParams({email:'local@example.test'})});
    assert.equal(r.status,503);assert.doesNotMatch(await r.text(),/dev-magic-link/);
  }finally{await new Promise(r=>server.close(r));}
});
