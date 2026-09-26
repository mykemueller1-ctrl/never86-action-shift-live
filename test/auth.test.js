import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Store, safeReturnTo } from '../lib/auth.js';

process.env.GOOGLE_CLIENT_ID='google-test'; process.env.GOOGLE_CLIENT_SECRET='not-a-real-secret';
process.env.CHATGPT_CLIENT_ID='chatgpt-test'; process.env.CHATGPT_CLIENT_SECRET='not-a-real-secret';
process.env.CHATGPT_AUTHORIZATION_URL='https://example.test/authorize'; process.env.CHATGPT_TOKEN_URL='https://example.test/token'; process.env.CHATGPT_USERINFO_URL='https://example.test/userinfo';
const { server } = await import('../server.js'); let base;
before(async()=>{await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${server.address().port}`});
after(()=>server.close());

test('all four product routes are public',async()=>{for(const route of ['/seat','/check/invoices','/check/menu','/check/labor']){const r=await fetch(base+route);assert.equal(r.status,200,route);assert.match(await r.text(),/Sample mode/)}});
test('Google and ChatGPT provider entry points redirect to OAuth',async()=>{for(const p of ['google','chatgpt']){const r=await fetch(`${base}/auth/${p}?returnTo=%2Fcheck%2Flabor`,{redirect:'manual'});assert.equal(r.status,303);const target=new URL(r.headers.get('location'));assert.equal(target.searchParams.get('state').length,32);assert.match(target.searchParams.get('redirect_uri'),new RegExp(`/auth/${p}/callback$`))}});
test('safe return-to accepts local routes and rejects open redirects',()=>{assert.equal(safeReturnTo('/check/menu?draft=1'),'/check/menu?draft=1');assert.equal(safeReturnTo('//evil.test'),'/seat');assert.equal(safeReturnTo('https://evil.test'),'/seat')});
test('magic link expires clearly',async()=>{const r=await fetch(base+'/auth/magic/verify?token=bad');assert.equal(r.status,400);assert.match(await r.text(),/expired or already used/)});
test('same verified email links providers without losing restaurant',()=>{const s=new Store();const a=s.upsertVerifiedIdentity('chatgpt','legacy','Owner@Example.com');const b=s.upsertVerifiedIdentity('google','new','owner@example.com');assert.equal(a.id,b.id);assert.equal(a.restaurantId,b.restaurantId);assert.equal(s.users.size,1)});
test('session sign-out revokes the session',()=>{const s=new Store();const u=s.upsertVerifiedIdentity('email','a@example.com','a@example.com');const token=s.createSession(u.id);assert.equal(s.session(token).user.id,u.id);s.revoke(token);assert.equal(s.session(token),null)});
test('expired magic links cannot create sessions',()=>{let now=1;const s=new Store(()=>now);const token=s.requestMagic('a@example.com','127.0.0.1');now+=16*60e3;assert.equal(s.consumeMagic(token),null)});
test('documents are isolated by restaurant',()=>{const s=new Store();const a=s.upsertVerifiedIdentity('email','a@example.com','a@example.com');const b=s.upsertVerifiedIdentity('email','b@example.com','b@example.com');const doc=s.addDocument(a,{name:'invoice'});assert.equal(s.documentFor(a,doc.id).name,'invoice');assert.equal(s.documentFor(b,doc.id),null)});
test('magic-link requests are rate limited',()=>{const s=new Store();for(let i=0;i<5;i++)assert.ok(s.requestMagic('a@example.com','ip'));assert.equal(s.requestMagic('a@example.com','ip'),null)});
