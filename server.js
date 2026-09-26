import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Store, safeReturnTo, cookie, parseCookies } from './lib/auth.js';

export const store = new Store();
const port = Number(process.env.PORT || 3000);
const origin = process.env.APP_ORIGIN || `http://localhost:${port}`;
const oauth = {
  google: { authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', userinfo: 'https://openidconnect.googleapis.com/v1/userinfo', clientId: process.env.GOOGLE_CLIENT_ID, secret: process.env.GOOGLE_CLIENT_SECRET, scope: 'openid email profile' },
  chatgpt: { authorize: process.env.CHATGPT_AUTHORIZATION_URL, token: process.env.CHATGPT_TOKEN_URL, userinfo: process.env.CHATGPT_USERINFO_URL, clientId: process.env.CHATGPT_CLIENT_ID, secret: process.env.CHATGPT_CLIENT_SECRET, scope: 'openid email profile' }
};
const states = new Map();
const send = (res, status, body, type = 'text/html; charset=utf-8', headers = {}) => { res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...headers }); res.end(body); };
const redirect = (res, location, headers = {}) => send(res, 303, '', 'text/plain', { Location: location, ...headers });
const body = async req => { const chunks=[]; for await (const c of req) chunks.push(c); return new URLSearchParams(Buffer.concat(chunks).toString()); };
const html = (title, content) => `<!doctype html><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/app.css"><title>${title} · One Seat</title><main class="narrow"><a href="/seat" class="brand">Never86'd · One Seat</a>${content}</main>`;
const sessionUser = req => store.session(parseCookies(req.headers.cookie).one_seat)?.user;
const csrfOkay = req => { const c = parseCookies(req.headers.cookie); return Boolean(c.csrf && req.headers['x-csrf-token'] === c.csrf && req.headers.origin === origin); };

async function handler(req, res) {
  const url = new URL(req.url, origin); const pathname = url.pathname;
  if (pathname === '/app.css' || pathname === '/app.js') { const file = await fs.readFile(path.join('public', pathname.slice(1))); return send(res, 200, file, pathname.endsWith('css') ? 'text/css' : 'text/javascript'); }
  if (pathname === '/' ) return redirect(res, '/seat');
  if (pathname === '/seat' || ['/check/invoices','/check/menu','/check/labor'].includes(pathname)) return send(res, 200, await fs.readFile('public/app.html'));
  if (pathname === '/signin') {
    const returnTo = safeReturnTo(url.searchParams.get('returnTo'));
    return send(res, 200, html('Sign in', `<h1>Save your Action Shift</h1><p>Sign-in is optional. Your browser work stays here.</p><p class="promise">First owner seat free · No card to start · No ChatGPT sign-in required</p><a class="button" href="/auth/google?returnTo=${encodeURIComponent(returnTo)}">Continue with Google</a><form method="post" action="/auth/magic"><input type="hidden" name="returnTo" value="${returnTo}"><label>Email <input required type="email" name="email" autocomplete="email"></label><button>Send magic link</button></form><a class="button secondary" href="/auth/chatgpt?returnTo=${encodeURIComponent(returnTo)}">Sign in with ChatGPT (optional)</a><a href="${returnTo}">Continue without signing in</a>`));
  }
  if (pathname === '/auth/magic' && req.method === 'POST') {
    const form = await body(req); const returnTo = safeReturnTo(form.get('returnTo')); const token = store.requestMagic(form.get('email') || '', req.socket.remoteAddress || 'unknown');
    if (token && process.env.RESEND_API_KEY) await fetch('https://api.resend.com/emails', { method:'POST', headers:{ Authorization:`Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type':'application/json' }, body:JSON.stringify({ from:process.env.EMAIL_FROM, to:form.get('email'), subject:'Your One Seat sign-in link', html:`<a href="${origin}/auth/magic/verify?token=${token}&returnTo=${encodeURIComponent(returnTo)}">Sign in to One Seat</a>` }) });
    const dev = process.env.NODE_ENV !== 'production' && token ? `<p><a id="dev-magic-link" href="/auth/magic/verify?token=${token}&returnTo=${encodeURIComponent(returnTo)}">Development sign-in link</a></p>` : '';
    return send(res, token ? 200 : 429, html('Check your email', token ? `<h1>Check your email</h1><p>If that address can receive mail, a one-time link is on its way. It expires in 15 minutes.</p>${dev}<a href="/signin?returnTo=${encodeURIComponent(returnTo)}">Use another method</a>` : '<h1>Too many requests</h1><p>Wait 15 minutes, then try again.</p><a href="/seat">Return to Sample mode</a>'));
  }
  if (pathname === '/auth/magic/verify') {
    const user = store.consumeMagic(url.searchParams.get('token')); const returnTo = safeReturnTo(url.searchParams.get('returnTo'));
    if (!user) return send(res, 400, html('Link expired', '<h1>This link is expired or already used</h1><p>Magic links work once for 15 minutes.</p><a class="button" href="/signin">Send a new link</a><a href="/seat">Return to Sample mode</a>'));
    return redirect(res, returnTo, { 'Set-Cookie': cookie('one_seat', store.createSession(user.id)) });
  }
  if (/^\/auth\/(google|chatgpt)$/.test(pathname)) {
    const provider = pathname.split('/').pop(); const config = oauth[provider];
    if (!config.clientId || !config.authorize) return send(res, 503, html('Provider unavailable', `<h1>${provider === 'google' ? 'Google' : 'ChatGPT'} sign-in is not configured</h1><a href="/signin">Choose another way</a>`));
    const state=crypto.randomBytes(24).toString('base64url'); states.set(state,{ provider, returnTo:safeReturnTo(url.searchParams.get('returnTo')), expires:Date.now()+600000 });
    const target=new URL(config.authorize); target.search=new URLSearchParams({client_id:config.clientId,redirect_uri:`${origin}/auth/${provider}/callback`,response_type:'code',scope:config.scope,state}).toString(); return redirect(res,target.href);
  }
  if (/^\/auth\/(google|chatgpt)\/callback$/.test(pathname)) {
    const provider=pathname.split('/')[2], state=states.get(url.searchParams.get('state')); states.delete(url.searchParams.get('state'));
    if (!state || state.provider !== provider || state.expires < Date.now() || url.searchParams.get('error')) return send(res,400,html('Sign-in failed','<h1>Sign-in did not finish</h1><p>The request was cancelled, expired, or could not be verified.</p><a class="button" href="/signin">Try another way</a><a href="/seat">Return to Sample mode</a>'));
    try { const c=oauth[provider], tokenRes=await fetch(c.token,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',code:url.searchParams.get('code'),redirect_uri:`${origin}/auth/${provider}/callback`,client_id:c.clientId,client_secret:c.secret})}); const tokens=await tokenRes.json(); const infoRes=await fetch(c.userinfo,{headers:{Authorization:`Bearer ${tokens.access_token}`}}); const info=await infoRes.json(); if(!info.email || info.email_verified === false) throw Error('unverified email'); const user=store.upsertVerifiedIdentity(provider,String(info.sub),info.email); return redirect(res,state.returnTo,{'Set-Cookie':cookie('one_seat',store.createSession(user.id))}); } catch { return send(res,400,html('Sign-in failed','<h1>We could not verify that account</h1><a class="button" href="/signin">Try another way</a>')); }
  }
  if (pathname === '/api/session') { const user=sessionUser(req); const csrf=crypto.randomBytes(24).toString('base64url'); return send(res,200,JSON.stringify({ user:user ? {email:user.email,role:user.role}:null, csrf }),'application/json',{'Set-Cookie':`csrf=${csrf}; Path=/; Secure; SameSite=Strict; Max-Age=86400`}); }
  if (pathname === '/auth/signout' && req.method === 'POST') { if(!csrfOkay(req)) return send(res,403,'CSRF check failed','text/plain'); store.revoke(parseCookies(req.headers.cookie).one_seat); return redirect(res,'/seat',{'Set-Cookie':cookie('one_seat','',0)}); }
  if (pathname === '/api/documents' && req.method === 'POST') { const user=sessionUser(req); if(!user) return send(res,401,'Sign in to save','text/plain'); if(!csrfOkay(req)) return send(res,403,'CSRF check failed','text/plain'); const form=await body(req); return send(res,201,JSON.stringify(store.addDocument(user,{name:form.get('name'),content:form.get('content')})),'application/json'); }
  if (pathname.startsWith('/api/documents/')) { const user=sessionUser(req); if(!user) return send(res,401,'Sign in','text/plain'); const item=store.documentFor(user,pathname.split('/').pop()); return send(res,item?200:404,item?JSON.stringify(item):'Not found',item?'application/json':'text/plain'); }
  return send(res,404,html('Not found','<h1>That page is not here</h1><a class="button" href="/seat">Open One Seat Sample mode</a>'));
}
export const server = http.createServer((req,res)=>handler(req,res).catch(()=>send(res,500,html('Error','<h1>Something went wrong</h1><a href="/seat">Return to One Seat</a>'))));
if (process.env.NODE_ENV !== 'test') server.listen(port,()=>console.log(`One Seat listening on ${origin}`));
