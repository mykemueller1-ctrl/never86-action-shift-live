const MAX_REPORT_BYTES = 1024 * 1024;
const utf8Bytes = text => new TextEncoder().encode(text).byteLength;
const PRODUCT_PATHS = ['/seat', '/check/invoices', '/check/menu', '/check/labor'];
const DRAFT_PREFIXES = ['draft:', 'draft-name:', 'draft-request:', 'draft-owner:'];

function clearPathDraft(storage, path) {
  let cleared = true;
  for (const prefix of DRAFT_PREFIXES) {
    try { storage.removeItem(prefix + path); } catch { cleared = false; }
  }
  return cleared;
}

export function clearProductDrafts(storage) {
  return PRODUCT_PATHS.map(path => clearPathDraft(storage, path)).every(Boolean);
}

export function draftAccess({ draftOwner, currentOwner, sessionChecked }) {
  if (!draftOwner) return 'anonymous';
  if (!sessionChecked || !currentOwner) return 'held';
  return draftOwner === currentOwner ? 'owned' : 'discard';
}

export async function signOutAndClearDrafts({ fetchImpl, csrf, storage }) {
  const response = await fetchImpl('/auth/signout', { method: 'POST', headers: { 'x-csrf-token': csrf }, credentials: 'same-origin' });
  if (!response.ok) throw new SaveError('SIGN_OUT_FAILED', 'Sign-out did not finish. Please retry.');
  return { cleared: clearProductDrafts(storage) };
}

function* csvCells(text) {
  let cell = '', quoted = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') { cell += '"'; index++; }
      else if (character === '"') quoted = false;
      else cell += character;
    } else if (character === '"' && !cell.trim()) {
      quoted = true;
    } else if (character === ',' || character === '\n' || character === '\r') {
      yield cell; cell = '';
      if (character === '\r' && text[index + 1] === '\n') index++;
    } else cell += character;
  }
  yield cell;
}

export function createNumberPreview(text, { format = 'csv' } = {}) {
  const numbers = [];
  if (typeof text === 'string') {
    const cells = format === 'csv' ? csvCells(text) : [text];
    for (const cell of cells) {
      for (const match of cell.matchAll(/\$?\b(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}\b/g)) {
        numbers.push(match[0]);
        if (numbers.length === 20) break;
      }
      if (numbers.length === 20) break;
    }
  }
  return { state: numbers.length ? 'needs-source-review' : 'missing', numbers };
}

export function numberPreviewMarkup(preview) {
  if (!preview.numbers.length) return '<p>No number candidates found. Check the report text and source.</p>';
  return `<h3>Numbers to review</h3><ul>${preview.numbers.map(number => `<li>${number} <span class="tag needs-review">Needs source review</span></li>`).join('')}</ul><p>Match these numbers to the original report. Confirm each field, unit and business date before using it for a decision.</p>`;
}

export class SaveError extends Error {
  constructor(code, message) { super(message); this.name = 'SaveError'; this.code = code; }
}

export function createDraftKeyProvider({ storage, storageKey, cryptoImpl = globalThis.crypto }) {
  let cached;
  return async ({ name, content }) => {
    const digest = await cryptoImpl.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([name, content])));
    const fingerprint = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    if (!cached) {
      try { cached = JSON.parse(storage.getItem(storageKey)); } catch { /* In-page retries work without browser storage. */ }
    }
    if (cached?.fingerprint !== fingerprint || typeof cached?.key !== 'string' || !/^[a-f0-9-]{36}$/i.test(cached.key)) {
      cached = { fingerprint, key: cryptoImpl.randomUUID() };
      try { storage.setItem(storageKey, JSON.stringify(cached)); } catch { /* Keep the in-memory key for retry. */ }
    }
    return cached.key;
  };
}

export function createSaveController({ fetchImpl, readDraft, readCsrf, readPath, readScope = () => null, getRequestKey, onState, onSignIn }) {
  let pending = false;
  let lastSaved;
  return {
    get pending() { return pending; },
    async save() {
      if (pending) return null;
      const draft = { ...readDraft() };
      const scope = readScope();
      if (typeof draft?.content !== 'string' || !draft.content.trim()) {
        onState({ state: 'error', message: 'Choose a CSV or text report before saving.' });
        return null;
      }
      if (typeof draft.name !== 'string' || !draft.name.trim() || draft.name.length > 255 || utf8Bytes(draft.content) > MAX_REPORT_BYTES) {
        onState({ state: 'error', message: 'Use a report up to 1 MiB with a filename of 255 characters or fewer. Your current draft is still here.' });
        return null;
      }
      const csrf = readCsrf();
      if (!csrf) {
        onState({ state: 'error', message: 'Check your sign-in, then retry saving. Your report is still here.' });
        return null;
      }
      if (lastSaved && lastSaved.scope === scope && lastSaved.name === draft.name && lastSaved.content === draft.content) {
        onState({ state: 'saved', document: lastSaved.document, draft });
        return lastSaved.document;
      }
      pending = true;
      onState({ state: 'saving', message: 'Saving your report…' });
      try {
        const key = await getRequestKey(draft);
        const response = await fetchImpl('/api/documents', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'x-csrf-token': csrf, 'Idempotency-Key': key },
          body: new URLSearchParams({ name: draft.name, content: draft.content }),
        });
        if (response.status === 401) {
          onState({ state: 'sign-in', message: 'Sign in to save. Your report is kept in this browser.' });
          onSignIn('/signin?returnTo=' + encodeURIComponent(readPath()));
          return null;
        }
        if (!response.ok) {
          const messages = {
            403: 'Your sign-in check expired. Check your sign-in again, then retry saving.',
            409: 'This report changed while saving. Choose it again, then retry.',
            413: 'This report is too large. Choose a CSV or text report up to 1 MiB.',
            429: 'Saving is busy. Wait a moment, then retry.',
            503: 'Saving is temporarily unavailable. Retry in a moment.',
          };
          throw new SaveError('HTTP_' + response.status, (messages[response.status] || 'We could not save this report. Please retry.') + ' Your draft is still here.');
        }
        let document;
        try { document = await response.json(); } catch { throw new SaveError('INVALID_RECEIPT', 'We could not confirm the save. Your draft is still here; retry to check it.'); }
        if (!document || typeof document.id !== 'string' || !document.id.trim() || document.content !== draft.content || document.name !== draft.name) {
          throw new SaveError('INVALID_RECEIPT', 'We could not confirm the saved report. Your draft is still here; retry to check it.');
        }
        if (scope !== readScope()) throw new SaveError('SESSION_CHANGED', 'Your sign-in changed during the save. Check your sign-in, then retry. Your report is still here.');
        lastSaved = { ...draft, scope, document };
        onState({ state: 'saved', document, draft });
        return document;
      } catch (error) {
        onState({ state: 'error', message: error instanceof SaveError ? error.message : 'The connection ended before we could confirm the save. Your report is still here; retry to check the same save.' });
        return null;
      } finally {
        pending = false;
      }
    },
  };
}

function mountOwnerDesk() {
  const path = location.pathname;
  const returnPath = path + location.search;
  const names = {
    '/check/invoices': ['Invoice check', 'Preview numbers in invoice CSV/text. Check the item, pack, quantity and price against the original.'],
    '/check/menu': ['Menu check', 'Preview numbers in a menu or recipe export. Check the ingredient quantities and units against the original.'],
    '/check/labor': ['Labor check', 'Preview numbers in a labor export. Check which fields are sales, wages or hours against the original.'],
    '/seat': ['One Seat Sample', 'Choose a check above or upload CSV/text here.'],
  };
  const [title, help] = names[path] || names['/seat'];
  document.querySelector('#check-title').textContent = title;
  document.querySelector('#check-help').textContent = help;
  document.title = `${title} · One Seat`;
  const result = document.querySelector('#results');
  const saveButton = document.querySelector('#save');
  const fileInput = document.querySelector('#file');
  const status = document.querySelector('#save-status');
  const receipt = document.querySelector('#saved-receipt');
  let storage;
  try { storage = localStorage; } catch { storage = { getItem: () => null, setItem: () => { throw Error('Storage unavailable'); }, removeItem: () => {} }; }
  let draft = '', filename = title, draftOwner = null, draftVisible = true, draftPersisted = true, csrf, sessionReady = false, loadingFile = false, savedDraft, savedDocument, accountIdentity;
  try { draft = storage.getItem(`draft:${path}`) || ''; filename = storage.getItem(`draft-name:${path}`) || title; draftOwner = storage.getItem(`draft-owner:${path}`) || null; } catch { /* Checking still works in this page. */ }
  draftVisible = draftAccess({ draftOwner, sessionChecked: false }) === 'anonymous';
  const updateSave = () => {
    saveButton.disabled = !sessionReady || !draftVisible || loadingFile || controller.pending || !draft.trim() || (savedDraft?.content === draft && savedDraft?.name === filename);
    fileInput.disabled = controller.pending || loadingFile;
    saveButton.textContent = controller.pending ? 'Saving…' : savedDraft?.content === draft && savedDraft?.name === filename ? 'Saved' : 'Save these results';
  };
  const showStatus = (message, state = 'error') => { status.textContent = message; status.dataset.state = state; };
  function render(text) {
    result.innerHTML = numberPreviewMarkup(createNumberPreview(text, { format: /\.txt$/i.test(filename) ? 'text' : 'csv' }));
  }
  const controller = createSaveController({
    fetchImpl: (...args) => fetch(...args), readDraft: () => ({ content: draftVisible ? draft : '', name: filename }),
    readCsrf: () => csrf, readPath: () => returnPath, readScope: () => accountIdentity,
    getRequestKey: createDraftKeyProvider({ storage, storageKey: `draft-request:${path}` }),
    onState: state => {
      receipt.hidden = state.state !== 'saved';
      if (state.state === 'saved') {
        savedDraft = state.draft; savedDocument = state.document;
        showStatus('Saved to your restaurant.', 'saved');
        document.querySelector('#saved-name').textContent = state.document.name || state.draft.name;
        document.querySelector('#saved-original').href = '/api/documents/' + encodeURIComponent(state.document.id) + '/original';
      } else showStatus(state.message, state.state);
      queueMicrotask(updateSave);
    },
    onSignIn: url => {
      if (draftPersisted) location.assign(url);
      else {
        showStatus('Keep this page open. Sign in using the owner-seat link in a new tab, then check your sign-in here and retry saving.');
        const link = document.querySelector('#invite'); link.target = '_blank'; link.rel = 'noopener';
      }
    },
  });
  if (draft && draftVisible) render(draft);
  if (draft && !draftVisible) showStatus('Check your sign-in to reopen this browser draft.', 'ready');
  fileInput.addEventListener('change', async event => {
    const file = event.target.files[0];
    if (!file) return;
    if (file.size > MAX_REPORT_BYTES || file.name.length > 255 || !/\.(csv|txt)$/i.test(file.name)) {
      showStatus('Choose a CSV or text report up to 1 MiB, with a filename of 255 characters or fewer. Your previous draft is still here.');
      return;
    }
    loadingFile = true; updateSave();
    try {
      const text = await file.text();
      if (utf8Bytes(text) > MAX_REPORT_BYTES) throw new SaveError('TOO_LARGE', 'Choose a CSV or text report up to 1 MiB.');
      draft = text; filename = file.name; draftOwner = sessionReady && accountIdentity ? accountIdentity : null; draftVisible = true; savedDraft = null; savedDocument = null; receipt.hidden = true;
      try {
        if (!clearPathDraft(storage, path)) throw Error('Draft cleanup unavailable');
        if (draftOwner) storage.setItem(`draft-owner:${path}`, draftOwner);
        storage.setItem(`draft:${path}`, draft); storage.setItem(`draft-name:${path}`, filename); draftPersisted = true;
      } catch { draftPersisted = false; clearPathDraft(storage, path); }
      render(draft);
      showStatus(draftPersisted ? `${filename} is ready to check. Nothing has been sent.` : 'This browser could not keep a return-visit draft. Keep this page open until you save.', draftPersisted ? 'ready' : 'error');
    } catch (error) { showStatus(error instanceof SaveError ? error.message : 'This file could not be read. Your previous draft is still here.'); }
    finally { loadingFile = false; updateSave(); }
  });
  saveButton.addEventListener('click', async () => { const saving = controller.save(); updateSave(); await saving; updateSave(); });
  const account = document.querySelector('#account');
  async function loadSession() {
    sessionReady = false; csrf = undefined;
    if (draftOwner) { draftVisible = false; result.replaceChildren(); receipt.hidden = true; showStatus('Checking sign-in before reopening this browser draft.', 'ready'); }
    updateSave(); account.textContent = 'Checking sign-in…';
    try {
      const response = await fetch('/api/session', { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) throw Error('Session unavailable');
      const session = await response.json();
      if (typeof session.csrf !== 'string' || !session.csrf) throw Error('Session unavailable');
      const nextIdentity = session.user?.email || null;
      if (accountIdentity !== nextIdentity) { savedDraft = null; savedDocument = null; receipt.hidden = true; status.textContent = ''; }
      const access = draftAccess({ draftOwner, currentOwner: nextIdentity, sessionChecked: true });
      if (access === 'discard') {
        clearPathDraft(storage, path); draft = ''; filename = title; draftOwner = null; draftVisible = true; result.replaceChildren(); fileInput.value = '';
      } else if (access === 'held') {
        draftVisible = false; result.replaceChildren(); showStatus('Sign in to reopen this browser draft.', 'ready');
      } else {
        draftVisible = true;
        if (draft && nextIdentity) {
          draftOwner = nextIdentity;
          try { storage.setItem(`draft-owner:${path}`, draftOwner); }
          catch { draftPersisted = false; clearPathDraft(storage, path); }
        }
        if (draft) render(draft);
        if (savedDocument && savedDraft?.content === draft && savedDraft?.name === filename) {
          receipt.hidden = false; showStatus('Saved to your restaurant.', 'saved');
        } else if (draft) showStatus(`${filename} is ready for source review.`, 'ready');
      }
      if (nextIdentity) {
        for (const productPath of PRODUCT_PATHS) {
          try { const owner = storage.getItem(`draft-owner:${productPath}`); if (owner && owner !== nextIdentity) clearPathDraft(storage, productPath); } catch { /* Marked drafts remain hidden until ownership can be checked. */ }
        }
      }
      accountIdentity = nextIdentity; csrf = session.csrf; sessionReady = true; account.replaceChildren();
      if (session.user) {
        const email = document.createElement('span'); email.textContent = session.user.email;
        const out = document.createElement('button'); out.className = 'desk-button'; out.textContent = 'Sign out';
        out.addEventListener('click', async () => {
          out.disabled = true;
          try {
            const cleanup = await signOutAndClearDrafts({ fetchImpl: (...args) => fetch(...args), csrf, storage });
            draft = ''; filename = title; draftOwner = null; draftVisible = true; savedDraft = null; savedDocument = null; accountIdentity = null; csrf = undefined; sessionReady = false;
            result.replaceChildren(); receipt.hidden = true; fileInput.value = ''; updateSave();
            if (cleanup.cleared) location.assign('/seat');
            else { account.textContent = 'Signed out'; showStatus('Signed out. This browser could not clear every report draft. Close this private window before sharing the device.'); }
          }
          catch { showStatus('Sign-out did not finish. Please retry.'); out.disabled = false; }
        });
        account.append(email, out);
      } else {
        const signIn = document.createElement('a'); signIn.className = 'desk-button primary'; signIn.href = '/signin?returnTo=' + encodeURIComponent(returnPath); signIn.textContent = 'Sign in'; account.append(signIn);
      }
    } catch {
      account.textContent = 'Sign-in check unavailable. ';
    }
    const retry = document.createElement('button'); retry.className = 'desk-button subtle'; retry.textContent = sessionReady ? 'Check sign-in again' : 'Retry sign-in check'; retry.addEventListener('click', loadSession); account.append(retry);
    updateSave();
  }
  document.querySelector('#invite').href = '/signin?returnTo=' + encodeURIComponent(returnPath);
  document.querySelectorAll('.desk-nav-button').forEach(link => { if (link.getAttribute('href') === path) link.setAttribute('aria-current', 'page'); });
  window.addEventListener('storage', event => {
    if (event.storageArea === storage && (event.key === `draft:${path}` && event.newValue === null || event.key === null)) {
      draft = ''; filename = title; draftOwner = null; draftVisible = true; savedDraft = null; savedDocument = null; accountIdentity = undefined; csrf = undefined; sessionReady = false;
      result.replaceChildren(); receipt.hidden = true; fileInput.value = ''; showStatus('The browser draft was cleared.', 'ready'); updateSave(); loadSession();
    }
  });
  loadSession();
}

if (typeof document !== 'undefined' && document.querySelector('#save')) mountOwnerDesk();
