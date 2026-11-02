// Dependency-free Chromium acceptance check. Uses only local synthetic data;
// it never calls a real email/OAuth service or a production application.
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHandler } from '../lib/operator-app.js';
import { createSharedStore } from '../lib/shared-store.js';

const temporary = await mkdtemp(path.join(tmpdir(),'one-seat-browser-'));
const evidence = process.env.BROWSER_EVIDENCE_DIR || path.join(temporary,'evidence');
await mkdir(evidence,{recursive:true,mode:0o700});
const report = { checkedAt:new Date().toISOString(), mode:'local synthetic browser acceptance; no real email', checks:[] };
let browser, socket, store, app;
const server = http.createServer((req,res)=>app(req,res));
try {
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://localhost:${server.address().port}`;
  const env={NODE_ENV:'test',APP_ORIGIN:base,SESSION_SECRET:'browser-fixture-only-signing-key-32bytes',DATA_FILE:path.join(temporary,'data.sqlite')};
  store=await createSharedStore({env});app=createHandler({env,store});
  browser=spawn(process.env.CHROMIUM_PATH || '/usr/bin/chromium',[
    '--headless','--no-sandbox','--disable-gpu','--no-first-run','--no-default-browser-check',
    '--disable-background-networking','--disable-component-update','--disable-sync',
    '--remote-debugging-port=0',`--user-data-dir=${path.join(temporary,'chrome')}`,'about:blank',
  ],{stdio:['ignore','ignore','pipe']});
  const endpoint=await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(Error('Chromium did not expose its local debugger.')),15000);
    let log='';browser.stderr.on('data',data=>{log+=data.toString();const match=/DevTools listening on (ws:\/\/[^\s]+)/.exec(log);if(match){clearTimeout(timeout);resolve(match[1]);}});
    browser.once('error',error=>{clearTimeout(timeout);reject(error);});
    browser.once('exit',code=>{clearTimeout(timeout);reject(Error(`Chromium exited before startup (${code}).`));});
  });
  socket=new WebSocket(endpoint);await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  let next=0;const pending=new Map();
  socket.addEventListener('message',event=>{const value=JSON.parse(event.data);const entry=pending.get(value.id);if(entry){pending.delete(value.id);clearTimeout(entry.timeout);value.error?entry.reject(Error(value.error.message)):entry.resolve(value.result);}});
  const call=(method,params={},sessionId)=>new Promise((resolve,reject)=>{
    const id=++next,timeout=setTimeout(()=>{pending.delete(id);reject(Error(`Browser command timed out: ${method}`));},15000);
    pending.set(id,{resolve,reject,timeout});socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));
  });
  const target=await call('Target.createTarget',{url:'about:blank'});
  const {sessionId}=await call('Target.attachToTarget',{targetId:target.targetId,flatten:true});
  const page=(method,params)=>call(method,params,sessionId);
  await page('Page.enable');await page('Runtime.enable');
  await page('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  async function evaluate(expression){const r=await page('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error('Browser evaluation failed: '+(r.exceptionDetails.exception?.description||r.exceptionDetails.text));return r.result.value;}
  async function until(expression){const deadline=Date.now()+15000;while(Date.now()<deadline){try{if(await evaluate(expression))return;}catch{}await new Promise(r=>setTimeout(r,100));}throw Error('Browser state did not arrive: '+expression);}
  const screenshot=async name=>{const image=await page('Page.captureScreenshot',{format:'png'});await writeFile(path.join(evidence,name+'.png'),Buffer.from(image.data,'base64'),{mode:0o600});};
  const checked=name=>report.checks.push({name,passed:true,at:new Date().toISOString()});
  await page('Page.navigate',{url:base+'/check/labor'});
  await until("document.querySelector('#account')?.textContent.includes('Sign in')");
  const file=path.join(temporary,'SYNTHETIC-QA-labor.csv');
  const content='SYNTHETIC QA ONLY\r\nDate,Subtotal,Reported labor\r\n2026-11-01,1000.00,250.00\r\n';
  await writeFile(file,content);
  const dom=await page('DOM.getDocument');const input=await page('DOM.querySelector',{nodeId:dom.root.nodeId,selector:'#file'});
  await page('DOM.setFileInputFiles',{nodeId:input.nodeId,files:[file]});
  await until("document.querySelector('#save')?.disabled === false");
  await until("document.querySelector('#results')?.textContent.includes('Needs source review')");
  assert.equal(await evaluate("document.querySelector('#results').textContent.includes('01,1000.00')"),false);
  assert.equal(await evaluate("document.querySelector('#results').textContent.includes('1000.00')"),true);
  checked('Uploaded numbers remain unverified until source review');
  await evaluate("document.querySelector('#save').click()");
  await until("location.pathname === '/signin' && document.querySelector('input[name=email]')");
  checked('Anonymous save returns to sign-in without losing the draft');await screenshot('01-sign-in');
  async function signIn(email){
    await evaluate(`document.querySelector('input[name=email]').value=${JSON.stringify(email)};document.querySelector('form').requestSubmit();true`);
    await until("Boolean(document.querySelector('#dev-magic-link'))");
    await evaluate("document.querySelector('#dev-magic-link').click();true");
    await until(`document.querySelector('#account')?.textContent.includes(${JSON.stringify(email)})`);
  }
  await signIn('browser-owner-a@example.test');
  assert.equal(await evaluate('location.pathname'),'/check/labor');
  await until("document.querySelector('#save')?.disabled === false");
  await evaluate("document.querySelector('#save').click()");
  await until("document.querySelector('#save-status')?.dataset.state === 'saved'");
  const originalPath=await evaluate("new URL(document.querySelector('#saved-original').href).pathname");
  assert.equal(await evaluate(`fetch(${JSON.stringify(originalPath)}).then(r=>r.text())`),content);
  checked('Real browser session saves and downloads the exact original');await screenshot('02-owner-saved-report');
  await page('Page.reload');
  await until("document.querySelector('#account')?.textContent.includes('browser-owner-a@example.test')");
  assert.equal(await evaluate(`fetch(${JSON.stringify(originalPath)}).then(r=>r.status)`),200);
  checked('Authenticated original is retained after browser reload');
  await evaluate("[...document.querySelectorAll('#account button')].find(b=>b.textContent==='Sign out').click();true");
  await until("location.pathname === '/seat' && document.querySelector('#account')?.textContent.includes('Sign in')");
  assert.equal(await evaluate(`fetch(${JSON.stringify(originalPath)}).then(r=>r.status)`),401);
  assert.equal(await evaluate("localStorage.getItem('draft:/check/labor')"),null);
  checked('Sign-out protects original and clears the previous operator browser draft');
  await page('Page.navigate',{url:base+'/signin?returnTo=%2Fcheck%2Flabor'});
  await until("Boolean(document.querySelector('input[name=email]'))");
  await signIn('browser-owner-b@example.test');
  assert.equal(await evaluate(`fetch(${JSON.stringify(originalPath)}).then(r=>r.status)`),404);
  assert.equal(await evaluate("document.querySelector('#results').textContent.includes('1000.00')"),false);
  checked('Second operator cannot read the first operator original or browser draft');await screenshot('03-second-owner-isolated');
  report.passed=true;
} catch(error) { report.passed=false;report.error=error.message;process.exitCode=1; }
finally {
  if(socket?.readyState === WebSocket.OPEN)socket.send(JSON.stringify({id:999999,method:'Browser.close'}));
  if(browser){const exited=browser.exitCode!==null?Promise.resolve():new Promise(resolve=>browser.once('exit',resolve));await Promise.race([exited,new Promise(resolve=>setTimeout(resolve,2000))]);if(browser.exitCode===null){browser.kill('SIGKILL');await exited;}}
  if(socket)socket.close();
  await new Promise(resolve=>server.close(resolve));if(store)await store.close();
  report.finishedAt=new Date().toISOString();await writeFile(path.join(evidence,'browser-result.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
  // Evidence outside the temporary tree is retained when explicitly requested.
  if(process.env.BROWSER_EVIDENCE_DIR)await rm(temporary,{recursive:true,force:true,maxRetries:6,retryDelay:200});
  console.log(JSON.stringify(report));
}
