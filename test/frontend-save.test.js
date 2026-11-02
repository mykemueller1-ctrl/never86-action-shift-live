import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createSaveController, createDraftKeyProvider, createNumberPreview, numberPreviewMarkup, clearProductDrafts, signOutAndClearDrafts, draftAccess } from '../public/app.js';

function memoryStorage() {
  const data = new Map();
  return { getItem: key => data.get(key) || null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
}
function harness(fetchImpl, overrides = {}) {
  let draft = { name: 'daily-close.csv', content: 'Subtotal,100.00\nLabor,25.00' };
  let scope = 'owner-a@example.test';
  const states = [], signIns = [], storage = memoryStorage();
  const controller = createSaveController({
    fetchImpl, readDraft: () => draft, readCsrf: () => 'csrf-token', readPath: () => '/check/labor?week=2026-11-01',
    readScope: () => scope,
    getRequestKey: createDraftKeyProvider({ storage, storageKey: 'request', cryptoImpl: webcrypto }),
    onState: state => states.push(state), onSignIn: path => signIns.push(path), ...overrides,
  });
  return { controller, states, signIns, get draft() { return draft; }, setDraft: value => { draft = value; }, setScope: value => { scope = value; } };
}
const receipt = options => new Response(JSON.stringify({ id: 'saved-id', name: options.body.get('name'), content: options.body.get('content') }), { status: 201 });

for (const code of [403, 409, 413, 429, 500, 503]) {
  test(`HTTP ${code} cannot show Saved or discard the report`, async () => {
    const app = harness(async () => new Response('Not saved', { status: code }));
    const before = { ...app.draft };
    assert.equal(await app.controller.save(), null);
    assert.equal(app.states.at(-1).state, 'error');
    assert.match(app.states.at(-1).message, /draft|report/i);
    assert.equal(app.states.some(state => state.state === 'saved'), false);
    assert.deepEqual(app.draft, before); assert.equal(app.controller.pending, false);
  });
}

test('a 401 retains the exact report and returns sign-in to the same check', async () => {
  const app = harness(async () => new Response('Sign in', { status: 401 }));
  const before = { ...app.draft };
  await app.controller.save();
  assert.deepEqual(app.draft, before); assert.equal(app.states.at(-1).state, 'sign-in');
  assert.deepEqual(app.signIns, ['/signin?returnTo=%2Fcheck%2Flabor%3Fweek%3D2026-11-01']);
  assert.equal(app.states.some(state => state.state === 'saved'), false);
});

test('the confirmed receipt keeps the original filename and submitted content', async () => {
  let sent;
  const app = harness(async (url, options) => { sent = { url, options }; return receipt(options); });
  const document = await app.controller.save();
  assert.equal(document.id, 'saved-id'); assert.equal(document.content, app.draft.content);
  assert.equal(sent.url, '/api/documents'); assert.equal(sent.options.body.get('name'), 'daily-close.csv');
  assert.match(sent.options.headers['Idempotency-Key'], /^[a-f0-9-]{36}$/);
  assert.equal(app.states.at(-1).state, 'saved');
});

test('a dropped response retries the same save key and retains its draft', async () => {
  const keys = []; let fail = true;
  const app = harness(async (url, options) => {
    keys.push(options.headers['Idempotency-Key']);
    if (fail) { fail = false; throw new TypeError('Connection lost'); }
    return receipt(options);
  });
  await app.controller.save(); assert.equal(app.states.at(-1).state, 'error');
  await app.controller.save(); assert.equal(app.states.at(-1).state, 'saved');
  assert.equal(keys.length, 2); assert.equal(keys[0], keys[1]);
});

test('double clicks while saving and after the same receipt do not make extra requests', async () => {
  let finish, calls = 0;
  const app = harness(async (url, options) => { calls++; return new Promise(resolve => { finish = () => resolve(receipt(options)); }); });
  const first = app.controller.save();
  assert.equal(app.controller.pending, true);
  assert.equal(await app.controller.save(), null);
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  finish(); await first; await app.controller.save();
  assert.equal(calls, 1); assert.equal(app.states.at(-1).state, 'saved');
});

test('a request key survives reload but changes for new content or filename', async () => {
  const storage = memoryStorage();
  const options = { storage, storageKey: 'draft', cryptoImpl: webcrypto };
  const first = createDraftKeyProvider(options);
  const draft = { name: 'close.csv', content: '100.00' };
  const key = await first(draft);
  assert.equal(await createDraftKeyProvider(options)(draft), key);
  assert.notEqual(await first({ ...draft, content: '120.00' }), key);
  const changedContentKey = await first({ ...draft, content: '120.00' });
  assert.notEqual(await first({ name: 'another.csv', content: '120.00' }), changedContentKey);
});

test('a changed report is saved separately rather than reusing the previous success', async () => {
  const sent = [];
  const app = harness(async (url, options) => { sent.push(options.headers['Idempotency-Key']); return receipt(options); });
  await app.controller.save(); app.setDraft({ ...app.draft, content: 'Subtotal,120.00' }); await app.controller.save();
  assert.equal(sent.length, 2); assert.notEqual(sent[0], sent[1]);
  assert.equal(app.states.at(-1).document.content, 'Subtotal,120.00');
});

for (const data of [undefined, { id: '', content: 'Subtotal,100.00\nLabor,25.00' }, { id: 'wrong', content: 'another report' }, { id: 'wrong-name', name: 'other.csv', content: 'Subtotal,100.00\nLabor,25.00' }]) {
  test(`an invalid successful response is not a saved receipt: ${JSON.stringify(data)}`, async () => {
    const app = harness(async () => new Response(data === undefined ? '<html>Not a receipt</html>' : JSON.stringify(data), { status: 200 }));
    await app.controller.save(); assert.equal(app.states.at(-1).state, 'error');
    assert.equal(app.states.some(state => state.state === 'saved'), false);
  });
}

test('UTF-8 byte limits reject a large report before sending it', async () => {
  let calls = 0;
  const app = harness(async () => { calls++; });
  app.setDraft({ name: 'large.txt', content: 'é'.repeat(600000) });
  await app.controller.save(); assert.equal(calls, 0); assert.equal(app.states.at(-1).state, 'error');
});

test('a cached successful save does not cross into another owner account', async () => {
  let calls = 0;
  const app = harness(async (url, options) => { calls++; return receipt(options); });
  await app.controller.save(); app.setScope('owner-b@example.test'); await app.controller.save();
  assert.equal(calls, 2);
});

test('changing sign-in during a save cannot display the old account receipt', async () => {
  let finish;
  const app = harness(async (url, options) => new Promise(resolve => { finish = () => resolve(receipt(options)); }));
  const saving = app.controller.save();
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  app.setScope('owner-b@example.test'); finish(); await saving;
  assert.equal(app.states.at(-1).state, 'error'); assert.match(app.states.at(-1).message, /sign-in changed/);
});

test('empty reports or unavailable sign-in cannot silently post or succeed', async () => {
  let calls = 0;
  const app = harness(async () => { calls++; }, { readCsrf: () => undefined });
  await app.controller.save(); assert.equal(calls, 0); assert.equal(app.states.at(-1).state, 'error');
  app.setDraft({ name: 'empty.csv', content: '' }); await app.controller.save(); assert.equal(calls, 0);
});

test('an unset optional account context still allows the first confirmed save', async () => {
  const app = harness(async (url, options) => receipt(options), { readScope: () => undefined });
  await app.controller.save(); assert.equal(app.states.at(-1).state, 'saved');
});

test('an arbitrary decimal reference cannot become a verified financial field or operating recommendation', () => {
  const preview = createNumberPreview('Shelf reference 123.45. This is not a sales or labor total.');
  assert.deepEqual(preview.numbers, ['123.45']);
  assert.equal(preview.state, 'needs-source-review');
  const markup = numberPreviewMarkup(preview);
  assert.match(markup, /Needs source review/);
  assert.doesNotMatch(markup, /\bVerified\b|class="tag verified"|Comparison \/ projection|Expected savings/);
  assert.equal(preview.sales, undefined); assert.equal(preview.labor, undefined); assert.equal(preview.action, undefined);
});

test('confirmed sign-out clears drafts, filenames, retry keys and ownership for every product path only', async () => {
  const storage = memoryStorage();
  const paths = ['/seat', '/check/invoices', '/check/menu', '/check/labor'];
  const prefixes = ['draft:', 'draft-name:', 'draft-request:', 'draft-owner:'];
  for (const path of paths) for (const prefix of prefixes) storage.setItem(prefix + path, 'private-owner-report');
  storage.setItem('theme', 'dark'); storage.setItem('draft:/unrelated-app', 'keep');
  const result = await signOutAndClearDrafts({ storage, csrf: 'token', fetchImpl: async () => new Response('{}', { status: 200 }) });
  assert.equal(result.cleared, true);
  for (const path of paths) for (const prefix of prefixes) assert.equal(storage.getItem(prefix + path), null);
  assert.equal(storage.getItem('theme'), 'dark'); assert.equal(storage.getItem('draft:/unrelated-app'), 'keep');
});

test('failed sign-out preserves private draft and retry identity', async () => {
  const storage = memoryStorage(); storage.setItem('draft:/check/labor', 'private'); storage.setItem('draft-request:/check/labor', 'same-retry-key');
  await assert.rejects(signOutAndClearDrafts({ storage, csrf: 'token', fetchImpl: async () => new Response('Not signed out', { status: 503 }) }), { code: 'SIGN_OUT_FAILED' });
  assert.equal(storage.getItem('draft:/check/labor'), 'private'); assert.equal(storage.getItem('draft-request:/check/labor'), 'same-retry-key');
});

test('lost sign-out connection cannot discard an unsaved report', async () => {
  const storage = memoryStorage(); storage.setItem('draft:/seat', 'private');
  await assert.rejects(signOutAndClearDrafts({ storage, csrf: 'token', fetchImpl: async () => { throw new TypeError('Connection lost'); } }));
  assert.equal(storage.getItem('draft:/seat'), 'private');
});

test('owned drafts remain held before session verification and after session expiry', () => {
  assert.equal(draftAccess({ draftOwner: 'a@example.test', sessionChecked: false }), 'held');
  assert.equal(draftAccess({ draftOwner: 'a@example.test', currentOwner: null, sessionChecked: true }), 'held');
  assert.equal(draftAccess({ draftOwner: 'a@example.test', currentOwner: 'a@example.test', sessionChecked: true }), 'owned');
});

test('another operator cannot reopen the previous owner draft', () => {
  assert.equal(draftAccess({ draftOwner: 'a@example.test', currentOwner: 'b@example.test', sessionChecked: true }), 'discard');
});

test('anonymous pre-sign-in drafts remain available to the first verified owner', () => {
  assert.equal(draftAccess({ draftOwner: null, sessionChecked: false }), 'anonymous');
  assert.equal(draftAccess({ draftOwner: null, currentOwner: 'a@example.test', sessionChecked: true }), 'anonymous');
});

for (const [row, expected] of [
  ['2026-11-01,1000.00,250.00', ['1000.00', '250.00']],
  ['2026-11-01,100.00,25.00', ['100.00', '25.00']],
]) test(`CSV cells cannot merge a business-date fragment into a number candidate: ${row}`, () => {
  const preview = createNumberPreview(row);
  assert.deepEqual(preview.numbers, expected);
  assert.equal(preview.state, 'needs-source-review');
  assert.equal(preview.numbers.some(number => number.startsWith('01,')), false);
});

test('a quoted CSV thousands amount remains one raw candidate across escaped quotes and commas', () => {
  const preview = createNumberPreview('2026-11-01,"reference ""A,B"", $1,000.00",250.00');
  assert.deepEqual(preview.numbers, ['$1,000.00', '250.00']);
  assert.equal(preview.state, 'needs-source-review');
});

test('plain-text reports preserve ordinary thousands separators without treating them as CSV boundaries', () => {
  const preview = createNumberPreview('Subtotal $1,000.00. Labor $250.00.', { format: 'text' });
  assert.deepEqual(preview.numbers, ['$1,000.00', '$250.00']);
  assert.equal(preview.state, 'needs-source-review');
});
