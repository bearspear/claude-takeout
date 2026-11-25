// Side panel behavior: loads the real popup.js and content.js with stubbed chrome/DOM APIs.
const { test } = require('node:test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const REPO = path.resolve(__dirname, '..');
const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const C = 'cccccccc-0000-4000-8000-000000000003';
const conv = (uuid, name) => ({ uuid, name, chat_messages: [], current_leaf_message_uuid: null });
const chatUrl = (id) => `https://claude.ai/chat/${id}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SETTLE = 300;

function event() {
  const fns = [];
  return { addListener: (f) => fns.push(f), fire: (...a) => fns.forEach((f) => f(...a)), fns };
}

function makeEnv({ url = chatUrl(A), captured = conv(A, 'Chat A') } = {}) {
  const elements = {};
  const el = (id) => elements[id] || (elements[id] = {
    id, disabled: false, hidden: false, textContent: '', className: '', value: '', checked: false, title: '', style: {}, dataset: {},
    handlers: {}, addEventListener(t, f) { this.handlers[t] = f; }, appendChild() {}, querySelectorAll: () => [], replaceChildren() {},
    classList: { contains: () => false, add() {}, remove() {}, toggle() {} },
    setAttribute() {}, getAttribute: () => null,
  });

  const env = {
    tab: { id: 1, url, active: true },
    captured,
    org: 'org-1',
    fetchDelay: 0,
    fetchCalls: [],
    connectionError: false,
    server: { [A]: conv(A, 'Chat A'), [B]: conv(B, 'Chat B'), [C]: conv(C, 'Chat C') },
    el,
  };

  const chrome = {
    runtime: { lastError: null, onMessage: event(), sendMessage: (m, cb) => cb && cb() },
    storage: { local: { get: async () => ({}), set: async () => {} }, onChanged: event() },
    tabs: {
      onActivated: event(),
      onUpdated: event(),
      query: async () => [env.tab],
      reload: async () => {},
      sendMessage(tabId, msg, cb) {
        if (env.connectionError) {
          chrome.runtime.lastError = { message: 'Could not establish connection' };
          setTimeout(() => { cb(undefined); chrome.runtime.lastError = null; }, 0);
          return;
        }
        if (msg.action === 'getOrgId') {
          setTimeout(() => cb({ orgId: env.org }), 0);
        } else if (msg.action === 'fetchConversation') {
          env.fetchCalls.push(msg.conversationId);
          const hit = env.server[msg.conversationId];
          setTimeout(() => cb(hit ? { data: hit } : { error: 'Failed to fetch conversation: 404' }), env.fetchDelay);
        } else {
          setTimeout(() => cb({}), 0);
        }
      },
    },
    scripting: { executeScript: async () => { throw new Error('Cannot access this tab'); } },
    sidePanel: {},
  };
  env.chrome = chrome;

  const sandbox = {
    chrome, console: { log() {}, warn() {}, error() {} },
    document: { getElementById: el, querySelectorAll: () => [], querySelector: () => null, addEventListener() {} },
    window: { close() {} }, setTimeout, clearTimeout, URL, JSZip: function () {},
  };
  env.ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(REPO, 'export-core.js'), 'utf8'), env.ctx);
  vm.runInContext(fs.readFileSync(path.join(REPO, 'popup.js'), 'utf8'), env.ctx);

  sandbox.__downloads = [];
  vm.runInContext("download = (content, filename) => { __downloads.push({ content, filename }); };", env.ctx);
  env.downloads = sandbox.__downloads;
  env.click = (id) => el(id).handlers.click();
  env.current = () => vm.runInContext('conversationData', env.ctx);
  env.title = () => el('chatTitle').textContent;
  env.cardState = () => el('chatState').textContent;
  env.status = () => el('status').textContent;
  env.exportDisabled = () => ['exportMd', 'exportMdEmbed', 'exportZip', 'exportJson'].every((i) => el(i).disabled);
  env.navigate = (u) => {
    env.tab.url = u;
    chrome.tabs.onUpdated.fire(env.tab.id, { url: u }, env.tab);
  };
  return env;
}

// Real content.js with a recording fetch that serves the frame API, _files.json and _src.
const PUB = '9fe94226-9819-4551-8836-a76d0c116102';
function resp(status, { json, bytes, stream, headers = {} } = {}) {
  return {
    status, ok: status >= 200 && status < 300,
    headers: { get: (k) => headers[k] ?? null },
    json: async () => json,
    body: stream ? { getReader: () => { let i = 0; return { read: async () => (i < stream.length ? { done: false, value: stream[i++] } : { done: true }), cancel() { resp.cancelled = true; return stream.cancelRejects ? Promise.reject(new Error('cancel failed')) : Promise.resolve(); } }; } } : undefined,
    arrayBuffer: async () => (bytes || new Uint8Array()).buffer.slice(bytes ? bytes.byteOffset : 0, bytes ? bytes.byteOffset + bytes.byteLength : 0),
  };
}
// info(body): changes the /api/frame/<uuid> reply; filesJson(): the _files.json response; direct(): a file
// fetched by its own path under /_f/<ver>/ (not _src/). pages(url): the /api/frame/artifacts reply (404 when absent).
function publishedHarness({ src, srcThrow, files, expiresIn = 3600, frames, pages, cookie = 'lastActiveOrg=11111111-0000-4000-8000-000000000001', account, info, filesJson, direct, thumb } = {}) {
  const reqs = [], delays = [], logs = [];
  const record = (...a) => { logs.push(a.map(String).join(' ')); };
  const listing = files || {
    'index.html': { sha256: 'h1', size: 3, contentType: 'text/html' },
    'data.json': { sha256: 'h2', size: 2, contentType: 'application/json' },
    'artifact-type/x.js': { sha256: 'h3', size: 1, contentType: 'text/javascript' },
    '../evil': { sha256: 'h4', size: 1, contentType: 'text/plain' },
  };
  let onMessage;
  const sandbox = {
    window: { addEventListener() {}, location: {} }, console: { log: record, warn: record, error: record },
    setTimeout: (f, ms) => { delays.push(ms); f(); },
    crypto: require('crypto').webcrypto, btoa, atob, TextEncoder, URL, Uint8Array, String, Math, Number, Date, Map, Error,
    document: { createElement: () => ({}), head: { appendChild() {} }, cookie },
    fetch: async (url, opts) => {
      reqs.push({ url, opts });
      if (url.includes('/api/frame/frames')) return frames();
      if (url.includes('/api/frame/artifacts?')) return pages ? pages(url) : resp(404);
      if (thumb && !url.startsWith('https://claude.ai/')) return thumb(url);
      if (url.includes('/api/account')) return resp(200, { json: account });
      if (url.includes('/api/frame/')) {
        const exp = Math.floor(Date.now() / 1000) + expiresIn;
        const body = { ver: 'V', title: 'T', history: ['V'], files: [], assetToken: 'a.b.c.' + exp };
        return resp(200, { json: info ? info(body, url) : body });
      }
      if (url.includes('_files.json')) return filesJson ? filesJson() : resp(200, { json: { ver: 'V', files: listing } });
      if (direct && !url.includes('/_src/')) return direct();
      if (srcThrow) throw srcThrow;
      return src ? src() : resp(200, { bytes: new Uint8Array([1, 2, 3]) });
    },
    chrome: {
      runtime: { getURL: (p) => p, lastError: null, onMessage: { addListener: (f) => { onMessage = f; } }, sendMessage() {} },
      storage: { local: { set() {}, remove() {}, get: (k, cb) => cb({}) } },
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(REPO, 'content.js'), 'utf8'), sandbox);
  return {
    reqs, delays, logs,
    frameCalls: () => reqs.filter((r) => r.url.includes('/api/frame/')),
    call: (msg) => new Promise((r) => onMessage(msg, {}, (x) => r(JSON.parse(JSON.stringify(x))))),
  };
}


const PUB2 = '8ee94226-9819-4551-8836-a76d0c116102';
const PUB3 = '7de94226-9819-4551-8836-a76d0c116102';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const thumbUrl = (uuid = PUB, tok = 'secrettok.1') => `https://${uuid}.frame.claudeusercontent.com/_f/V/_thumb.img?__frame_t=${tok}`;
// thumb(url): the response for a picture request; frames(): the /api/frame/frames reply (default: PUB with a valid picture URL).
function thumbHarness({ thumb, frames } = {}) {
  const h = publishedHarness({
    frames: frames || (() => resp(200, { json: { frames: [{ slug: PUB, thumbImgURL: thumbUrl() }, { slug: PUB2 }] } })),
    thumb,
  });
  h.thumbReqs = () => h.reqs.filter((r) => !r.url.startsWith('https://claude.ai/'));
  h.listCalls = () => h.reqs.filter((r) => r.url.includes('/api/frame/frames')).length;
  return h;
}

// Every request carrying the token goes to the page's own frame host; the token is never in an /api/frame URL or a log.
function assertTokenStaysHome(h) {
  const withToken = h.reqs.filter((r) => r.url.includes('__frame_t'));
  assert.ok(withToken.length > 0, 'a file request carried the token');
  for (const r of withToken) assert.ok(r.url.startsWith(`https://${PUB}.frame.claudeusercontent.com/`), r.url);
  assert.ok(!h.reqs.some((r) => r.url.includes('/api/frame') && r.url.includes('__frame_t')));
  assert.ok(!h.logs.some((l) => /__frame_t|a\.b\.c/.test(l)), 'no log call holds the token');
}

const tests = {
  'startup shows the conversation in the URL': async () => {
    const e = makeEnv();
    await sleep(SETTLE);
    assert.strictEqual(e.current()?.uuid, A);
    assert.strictEqual(e.exportDisabled(), false);
  },

  'an old stored copy of the selected chat is not shown': async () => {
    const e = makeEnv({ captured: conv(A, 'Old copy') });
    e.server[A] = conv(A, 'Latest copy');
    await sleep(SETTLE);
    assert.strictEqual(e.current()?.name, 'Latest copy');
  },

  'returning to a chat loads it again': async () => {
    const e = makeEnv();
    await sleep(SETTLE);
    e.navigate(chatUrl(B));
    await sleep(SETTLE);
    e.server[A] = conv(A, 'Chat A with new messages');
    e.navigate(chatUrl(A));
    await sleep(SETTLE);
    assert.strictEqual(e.current()?.name, 'Chat A with new messages');
  },

  'a refresh of the open chat loads the latest copy': async () => {
    const e = makeEnv();
    await sleep(SETTLE);
    e.server[A] = conv(A, 'Chat A with new messages');
    e.chrome.tabs.onUpdated.fire(1, { status: 'complete' }, e.tab);
    await sleep(SETTLE);
    assert.strictEqual(e.current()?.name, 'Chat A with new messages');
  },

  'reloading the same chat keeps it exportable while loading': async () => {
    const e = makeEnv();
    await sleep(SETTLE);
    e.fetchDelay = 400;
    e.chrome.tabs.onUpdated.fire(1, { status: 'complete' }, e.tab);
    await sleep(SETTLE);
    assert.strictEqual(e.exportDisabled(), false);
  },

  'each single export writes the latest copy': async () => {
    for (const id of ['exportJson', 'exportMd', 'exportMdEmbed']) {
      const e = makeEnv();
      await sleep(SETTLE);
      e.server[A] = conv(A, 'Latest copy');
      await e.click(id);
      assert.strictEqual(e.downloads.length, 1, id);
      assert.match(e.downloads[0].content + e.downloads[0].filename, /Latest copy|Latest_copy/, id);
    }
  },

  'an export that cannot load the latest copy writes nothing': async () => {
    const e = makeEnv();
    await sleep(SETTLE);
    delete e.server[A];
    await e.click('exportJson');
    assert.strictEqual(e.downloads.length, 0);
    assert.strictEqual(e.el('chatCard').dataset.tone, 'error');
    assert.match(e.status(), /404/);
  },

  'selecting a chat the page serves from cache is fetched by ID': async () => {
    const e = makeEnv();
    await sleep(SETTLE);
    e.navigate(chatUrl(B));
    await sleep(SETTLE);
    assert.strictEqual(e.current()?.uuid, B);
    assert.deepStrictEqual(e.fetchCalls, [A, B]);
  },

  'export stays disabled while the selected chat loads': async () => {
    const e = makeEnv();
    await sleep(SETTLE);
    e.fetchDelay = 400;
    e.navigate(chatUrl(B));
    await sleep(SETTLE);
    assert.strictEqual(e.current(), null, 'old chat must not stay exportable');
    assert.strictEqual(e.exportDisabled(), true);
    await sleep(300);
    assert.strictEqual(e.current()?.uuid, B);
    assert.strictEqual(e.exportDisabled(), false);
  },

  'a slow fetch cannot overwrite a newer selection': async () => {
    const e = makeEnv();
    await sleep(SETTLE);
    e.fetchDelay = 500;
    e.navigate(chatUrl(B));
    await sleep(250);
    e.fetchDelay = 0;
    e.navigate(chatUrl(C));
    await sleep(700);
    assert.strictEqual(e.current()?.uuid, C);
  },

  'a captured payload for another chat is not trusted': async () => {
    const e = makeEnv({ url: chatUrl(B), captured: conv(A, 'Chat A') });
    await sleep(SETTLE);
    assert.strictEqual(e.current()?.uuid, B);
  },

  'a non-chat page clears the old chat': async () => {
    const e = makeEnv();
    await sleep(SETTLE);
    e.navigate('https://claude.ai/new');
    await sleep(SETTLE);
    assert.strictEqual(e.current(), null);
    assert.strictEqual(e.exportDisabled(), true);
  },

  'switching tabs updates the panel': async () => {
    const e = makeEnv();
    await sleep(SETTLE);
    e.tab = { id: 2, url: chatUrl(B), active: true };
    e.chrome.tabs.onActivated.fire({ tabId: 2, windowId: 1 });
    await sleep(SETTLE);
    assert.strictEqual(e.current()?.uuid, B);
  },

  'switching to a non-Claude tab disables single export': async () => {
    const e = makeEnv();
    await sleep(SETTLE);
    e.tab = { id: 3, active: true }; // no url: extension lacks host access
    e.chrome.tabs.onActivated.fire({ tabId: 3, windowId: 1 });
    await sleep(SETTLE);
    assert.strictEqual(e.exportDisabled(), true);
    assert.strictEqual(e.cardState(), 'Open claude.ai to export.');
  },

  'a failed fetch reports an error and keeps export disabled': async () => {
    const e = makeEnv();
    await sleep(SETTLE);
    e.navigate(chatUrl('dddddddd-0000-4000-8000-000000000004'));
    await sleep(SETTLE);
    assert.strictEqual(e.exportDisabled(), true);
    assert.strictEqual(e.cardState(), "Couldn't load this chat");
    assert.match(e.status(), /404/);
  },

  'a failed injection shows the real error': async () => {
    const e = makeEnv();
    await sleep(SETTLE);
    e.connectionError = true;
    e.navigate(chatUrl(B));
    await sleep(SETTLE);
    assert.strictEqual(e.exportDisabled(), true);
    assert.strictEqual(e.cardState(), "Couldn't load this chat");
    assert.match(e.status(), /Cannot access this tab/);
  },

  'selection during an export waits, then keeps the result status': async () => {
    const e = makeEnv();
    await sleep(SETTLE);
    vm.runInContext('exportRunning = true', e.ctx);
    e.el('status').textContent = 'Creating zip archive...';
    e.navigate(chatUrl(B));
    await sleep(SETTLE);
    assert.strictEqual(e.current()?.uuid, A, 'chat must not change mid-export');
    assert.strictEqual(e.status(), 'Creating zip archive...');
    vm.runInContext('exportRunning = false; finishRun()', e.ctx);
    e.el('status').textContent = 'Exported zip';
    await sleep(SETTLE);
    assert.strictEqual(e.current()?.uuid, B);
    assert.strictEqual(e.status(), 'Exported zip');
  },

  'Refresh reloads the chat in place': async () => {
    const e = makeEnv();
    await sleep(SETTLE);
    let reloaded = 0;
    let closed = 0;
    e.chrome.tabs.reload = async () => { reloaded++; };
    vm.runInContext('window', e.ctx).close = () => { closed++; };
    e.server[A] = conv(A, 'Chat A refreshed');
    e.el('refresh').handlers.click();
    await sleep(SETTLE);
    assert.strictEqual(e.current()?.name, 'Chat A refreshed');
    assert.strictEqual(reloaded, 0, 'must not reload the tab');
    assert.strictEqual(closed, 0, 'must not close the panel');
  },

  'content.js clears the old cached conversation': async () => {
    const removed = [];
    const w = { addEventListener() {}, location: {} };
    vm.runInNewContext(fs.readFileSync(path.join(REPO, 'content.js'), 'utf8'), {
      window: w, console: { log() {} }, setTimeout,
      document: { createElement: () => ({}), head: { appendChild() {} }, cookie: '' },
      chrome: {
        runtime: { getURL: (p) => p, onMessage: { addListener() {} } },
        storage: { local: { set() {}, remove: (k) => removed.push(k), get() {} } },
      },
    });
    assert.deepStrictEqual(removed, ['conversationData']);
  },

  'injected.js reports the org ID once and passes responses through': async () => {
    const posted = [];
    const response = { marker: true };
    const w = { fetch: async () => response, postMessage: (m) => posted.push(m) };
    vm.runInNewContext(fs.readFileSync(path.join(REPO, 'injected.js'), 'utf8'), { window: w });
    const first = await w.fetch('https://claude.ai/api/organizations/abc-1/chat_conversations/x');
    await w.fetch({ url: 'https://claude.ai/api/organizations/def-2/other' });
    assert.strictEqual(first, response);
    assert.strictEqual(posted.length, 1);
    assert.strictEqual(posted[0].type, 'CLAUDE_ORG_ID');
    assert.strictEqual(posted[0].orgId, 'abc-1');
  },

  'content.js uses the active org cookie and sends no capture message': async () => {
    const sent = [], urls = [];
    let onWindowMessage, onMessage;
    const w = { addEventListener: (t, f) => { if (t === 'message') onWindowMessage = f; }, location: {} };
    const sandbox = {
      window: w, console: { log() {} }, setTimeout,
      document: {
        createElement: () => ({}), head: { appendChild() {} },
        cookie: 'x=1; lastActiveOrg=11111111-0000-4000-8000-000000000001; y=2',
      },
      fetch: async (u) => { urls.push(u); return { ok: true, json: async () => conv(B, 'Chat B') }; },
      chrome: {
        runtime: {
          getURL: (p) => p, lastError: null,
          onMessage: { addListener: (f) => { onMessage = f; } },
          sendMessage: (m, cb) => { sent.push(m); cb && cb(); },
        },
        storage: { local: { set() {}, remove() {}, get: (k, cb) => cb({ orgId: 'stale-org' }) } },
      },
    };
    vm.runInNewContext(fs.readFileSync(path.join(REPO, 'content.js'), 'utf8'), sandbox);
    onWindowMessage({ source: w, data: { type: 'CLAUDE_ORG_ID', orgId: 'captured-org' } });
    onWindowMessage({ source: w, data: { type: 'CLAUDE_CONVERSATION_DATA', data: conv(B, 'Chat B') } });
    assert.deepStrictEqual(sent, []);
    const res = await new Promise((r) => onMessage({ action: 'fetchConversation', conversationId: B }, {}, r));
    assert.strictEqual(res.data.uuid, B);
    assert.match(urls[0], /organizations\/11111111-0000-4000-8000-000000000001\//);
    const info = await new Promise((r) => onMessage({ action: 'getOrgId' }, {}, r));
    assert.strictEqual(info.orgId, '11111111-0000-4000-8000-000000000001');
  },

  'content.js falls back to the captured org without the cookie': async () => {
    const urls = [];
    let onWindowMessage, onMessage;
    const w = { addEventListener: (t, f) => { if (t === 'message') onWindowMessage = f; }, location: {} };
    const sandbox = {
      window: w, console: { log() {} }, setTimeout,
      document: { createElement: () => ({}), head: { appendChild() {} }, cookie: '' },
      fetch: async (u) => { urls.push(u); return { ok: true, json: async () => conv(B, 'Chat B') }; },
      chrome: {
        runtime: { getURL: (p) => p, lastError: null, onMessage: { addListener: (f) => { onMessage = f; } }, sendMessage() {} },
        storage: { local: { set() {}, remove() {}, get: (k, cb) => cb({ orgId: 'stale-org' }) } },
      },
    };
    vm.runInNewContext(fs.readFileSync(path.join(REPO, 'content.js'), 'utf8'), sandbox);
    onWindowMessage({ source: w, data: { type: 'CLAUDE_ORG_ID', orgId: 'captured-org' } });
    await new Promise((r) => onMessage({ action: 'fetchConversation', conversationId: B }, {}, r));
    assert.match(urls[0], /organizations\/captured-org\//);
  },

  'content.js adds only the display name to the chat list, and only when asked': async () => {
    const urls = [];
    let onMessage;
    const account = { display_name: 'Mika', full_name: 'Mika Example', email_address: 'mika@example.com', uuid: 'acc-1' };
    const sandbox = {
      window: { addEventListener() {}, location: {} }, console: { log() {} }, setTimeout,
      document: { createElement: () => ({}), head: { appendChild() {} }, cookie: 'lastActiveOrg=11111111-0000-4000-8000-000000000001' },
      fetch: async (u) => { urls.push(u); return { ok: true, json: async () => (/\/api\/account$/.test(u) ? account : []) }; },
      chrome: {
        runtime: { getURL: (p) => p, lastError: null, onMessage: { addListener: (f) => { onMessage = f; } }, sendMessage() {} },
        storage: { local: { set() {}, remove() {}, get: (k, cb) => cb({}) } },
      },
    };
    vm.runInNewContext(fs.readFileSync(path.join(REPO, 'content.js'), 'utf8'), sandbox);
    const plain = await new Promise((r) => onMessage({ action: 'fetchAllConversations' }, {}, r));
    assert.strictEqual(plain.accountName, null);
    assert.ok(!urls.some((u) => /\/api\/account$/.test(u)), 'no account request unless asked');
    const named = await new Promise((r) => onMessage({ action: 'fetchAllConversations', withAccountName: true }, {}, r));
    assert.strictEqual(named.accountName, 'Mika');
    assert.ok(!JSON.stringify(named).includes('mika@example.com'), 'nothing else from the account');
    account.display_name = '';
    const full = await new Promise((r) => onMessage({ action: 'fetchAllConversations', withAccountName: true }, {}, r));
    assert.strictEqual(full.accountName, 'Mika Example', 'full name when there is no display name');
  },
  'publishedPageInfo sends X-Frame-CP, drops the type runtime and bad paths, and returns no token': async () => {
    const h = publishedHarness();
    const res = await h.call({ action: 'publishedPageInfo', uuid: PUB, ver: '' });
    assert.strictEqual(h.frameCalls()[0].opts.headers['X-Frame-CP'], 'go');
    assert.ok(!/[?&]ver=/.test(h.frameCalls()[0].url), 'live page sends no ver');
    assert.deepStrictEqual(res.files.map((f) => f.path), ['index.html', 'data.json']);
    assert.deepStrictEqual(res.rejected, ['../evil']);
    assert.strictEqual(res.ver, 'V');
    const text = JSON.stringify(res);
    assert.ok(!text.includes('a.b.c') && !text.includes('__frame_t'));
    const src = h.reqs.find((r) => r.url.includes('_files.json'));
    assert.strictEqual(src.opts.credentials, 'omit');
    assert.strictEqual(src.opts.redirect, 'error');
    assert.strictEqual(src.opts.referrerPolicy, 'no-referrer');
    await h.call({ action: 'publishedPageFile', uuid: PUB, ver: '', path: 'index.html', size: 3 });
    assertTokenStaysHome(h);
  },

  'publishedPageInfo counts the runtime files it drops': async () => {
    const h = publishedHarness({ files: { 'index.html': { size: 1 }, 'artifact-type/a.js': { size: 1 }, 'artifact-type/b.js': { size: 1 } } });
    const res = await h.call({ action: 'publishedPageInfo', uuid: PUB, ver: '' });
    assert.strictEqual(res.runtimeSkipped, 2);
    assert.deepStrictEqual(res.files.map((f) => f.path), ['index.html']);
  },

  'listArtifacts sends X-Frame-CP, returns only allowed fields and codes on failure': async () => {
    const frame = { slug: PUB, title: 'T', type_slug: 'ts', type_title: 'Tt', source_surface: 'chat', rel: 'mine', live: 'v1', updatedAt: 'u', created_at: 'c',
      owner_email: 'o@x.y', thumbImgURL: 'https://t/x.png', owner_account: { a: 1 } };
    const h = publishedHarness({ frames: () => resp(200, { json: { frames: [frame] } }), account: { display_name: 'Mika' } });
    const res = await h.call({ action: 'listArtifacts', withAccountName: true });
    const call = h.reqs.find((r) => r.url.includes('/api/frame/frames'));
    assert.strictEqual(call.opts.headers['X-Frame-CP'], 'go');
    assert.ok(call.url.includes('limit=1000') && call.url.includes('org=11111111-0000-4000-8000-000000000001'));
    assert.deepStrictEqual(res.frames, [{ slug: PUB, title: 'T', typeSlug: 'ts', typeTitle: 'Tt', sourceSurface: 'chat', rel: 'mine', live: 'v1', updatedAt: 'u', createdAt: 'c', public: false }]);
    assert.strictEqual(res.accountName, 'Mika');
    assert.ok(!JSON.stringify(res).includes('o@x.y') && !JSON.stringify(res).includes('t/x.png'));
    const bare = await publishedHarness({ frames: () => resp(200, { json: { frames: [] } }) }).call({ action: 'listArtifacts' });
    assert.strictEqual(bare.accountName, null);
    const err = (frames, extra) => publishedHarness({ frames, ...extra }).call({ action: 'listArtifacts' });
    assert.deepStrictEqual(await err(() => resp(401)), { error: 'HTTP 401', status: 401 });
    assert.deepStrictEqual(await err(() => resp(200, { json: { frames: {} } })), { error: 'bad response' });
    assert.deepStrictEqual(await err(() => ({ ...resp(200), json: async () => { throw new Error('x'); } })), { error: 'bad response' });
    assert.deepStrictEqual(await err(() => resp(200, {}), { cookie: '' }), { error: 'no org' });
    assert.deepStrictEqual(await err(() => { throw new Error('secret https://x'); }), { error: 'network' });
  },

  'listArtifacts pages claude.ai\'s full list and adds what its quick list missed': async () => {
    const quick = { slug: PUB, title: 'A', type_slug: '', type_title: '', source_surface: 'chat', rel: 'mine', live: 'v1', updatedAt: 'u', created_at: 'c', thumbImgURL: thumbUrl() };
    const secret = 'https://' + PUB2 + '.frame.claudeusercontent.com/_f/V2/_thumb.img?__frame_t=secrettok.2';
    const extra = { kind: 'page', id: PUB2, title: 'B', type_slug: 'ts', type_title: 'Tt', source: 'chat', rel: 'shared', updated_at: 'u2', created_at: 'c2',
      audience: 'public', thumbnail_url: secret, open_url: 'https://claude.ai/artifact/x', owner_account: { email: 'o@x.y' } };
    const pages = (url) => {
      const tok = new URL(url).searchParams.get('page_token');
      if (!tok) return resp(200, { json: { artifacts: [{ kind: 'page', id: PUB.toUpperCase() }, { kind: 'folder', id: PUB3 }], next_page_token: 'a+b/c' } });
      if (tok === 'a+b/c') return resp(200, { json: { artifacts: [extra, { kind: 'page', id: '../x' }, { kind: 'page', id: PUB2 }, null], next_page_token: '' } });
      return resp(500);
    };
    const h = publishedHarness({ frames: () => resp(200, { json: { frames: [quick] } }), pages });
    const res = await h.call({ action: 'listArtifacts' });
    assert.deepStrictEqual(res.frames.map((f) => f.slug), [PUB, PUB2]);
    assert.deepStrictEqual(res.frames[1], { slug: PUB2, title: 'B', typeSlug: 'ts', typeTitle: 'Tt', sourceSurface: 'chat', rel: 'shared', live: '', updatedAt: 'u2', createdAt: 'c2', public: true, paged: true });
    assert.deepStrictEqual(res.paging, { status: 'ok', added: 1 });
    const calls = h.reqs.filter((r) => r.url.includes('/api/frame/artifacts?'));
    assert.strictEqual(calls.length, 2);
    for (const c of calls) {
      const q = new URL(c.url).searchParams;
      assert.strictEqual(c.opts.headers['X-Frame-CP'], 'go');
      assert.strictEqual(c.opts.credentials, 'same-origin');
      assert.strictEqual(q.get('rel'), 'all');
      assert.strictEqual(q.get('org'), '11111111-0000-4000-8000-000000000001');
      assert.ok(!q.has('empty'), 'no filter that hides typed artifacts');
    }
    assert.strictEqual(new URL(calls[1].url).searchParams.get('page_token'), 'a+b/c');
    const text = JSON.stringify(res);
    for (const s of ['secrettok', 'claudeusercontent', 'o@x.y', 'open_url', 'audience']) assert.ok(!text.includes(s), s);
    assert.deepStrictEqual(await h.call({ action: 'artifactThumbUrl', uuid: PUB2 }), { error: 'no picture' }, 'a paged artifact has no picture');
    assert.ok(!h.logs.some((l) => /secrettok|claudeusercontent/.test(l)));
  },

  'listArtifacts keeps its quick list when paging fails, with a code only': async () => {
    const quick = () => resp(200, { json: { frames: [{ slug: PUB, live: 'v1' }] } });
    const run = async (pages) => publishedHarness({ frames: quick, pages }).call({ action: 'listArtifacts' });
    const second = (bad) => (url) => (new URL(url).searchParams.get('page_token') ? bad() : resp(200, { json: { artifacts: [{ kind: 'page', id: PUB2 }], next_page_token: 't' } }));
    for (const [pages, code] of [
      [second(() => resp(500)), 'HTTP 500'],
      [() => { throw new Error('secret https://x'); }, 'network'],
      [() => resp(200, { json: { artifacts: {} } }), 'bad response'],
      [() => ({ ...resp(200), json: async () => { throw new Error('x'); } }), 'bad response'],
      [() => resp(200, { json: { artifacts: [], next_page_token: 7 } }), 'bad response'],
      [undefined, 'HTTP 404'],
    ]) {
      const res = await run(pages);
      assert.deepStrictEqual(res.frames.map((f) => f.slug), [PUB], code);
      assert.deepStrictEqual(res.paging, { status: 'failed', code }, code);
    }
  },

  'listArtifacts stops on a repeated page token and after its page cap': async () => {
    const quick = () => resp(200, { json: { frames: [] } });
    const loop = publishedHarness({ frames: quick, pages: () => resp(200, { json: { artifacts: [{ kind: 'page', id: PUB }], next_page_token: 'same' } }) });
    const looped = await loop.call({ action: 'listArtifacts' });
    assert.deepStrictEqual(looped.paging, { status: 'failed', code: 'repeated page' });
    assert.deepStrictEqual(looped.frames, [], 'a list that loops adds nothing');
    let n = 0;
    const endless = publishedHarness({ frames: quick, pages: () => resp(200, { json: { artifacts: [{ kind: 'page', id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}` }], next_page_token: 't' + n } }) });
    const capped = await endless.call({ action: 'listArtifacts' });
    const calls = endless.reqs.filter((r) => r.url.includes('/api/frame/artifacts?')).length;
    assert.strictEqual(calls, 100);
    assert.deepStrictEqual(capped.paging, { status: 'capped', added: 100 });
    assert.strictEqual(capped.frames.length, 100);
  },

  'an older version with no _files.json and no files of its own lists the live version\'s files': async () => {
    const live = [{ path: 'index.html', contentType: 'text/html' }];
    const mk = (liveFiles) => publishedHarness({
      filesJson: () => resp(404),
      info: (body, url) => (new URL(url).searchParams.get('ver') === 'old' ? { ...body, ver: 'old', files: [] } : { ...body, ver: 'V', files: liveFiles }),
    });
    const res = await mk(live).call({ action: 'publishedPageInfo', uuid: PUB, ver: 'old' });
    assert.deepStrictEqual(res.files, [{ path: 'index.html', size: null, contentType: 'text/html', sha256: null }]);
    assert.strictEqual(res.ver, 'old');
    assert.strictEqual(res.listFromLive, true);
    assert.deepStrictEqual(await mk([]).call({ action: 'publishedPageInfo', uuid: PUB, ver: 'old' }), { error: 'HTTP 404', status: 404 });
    const own = await mk(live).call({ action: 'publishedPageInfo', uuid: PUB, ver: '' });
    assert.ok(!('listFromLive' in own), 'the live version lists its own files');
  },

  'publishedPageInfo gives history oldest first': async () => {
    const h = publishedHarness({ info: (body) => ({ ...body, ver: 'v3', history: ['v3', 'v2', 'v1'] }), filesJson: () => resp(200, { json: { ver: 'v3', files: { 'index.html': { sha256: 'h', size: 1, contentType: 'text/html' } } } }) });
    const res = await h.call({ action: 'publishedPageInfo', uuid: PUB, ver: '' });
    assert.deepStrictEqual(res.history, ['v1', 'v2', 'v3']);
  },

  'listArtifacts maps audience to public and never returns it': async () => {
    const frames = [{ slug: PUB, audience: 'public', thumbImgURL: thumbUrl() }, { slug: PUB2, audience: 'owner' }, { slug: PUB3 }];
    const h = publishedHarness({ frames: () => resp(200, { json: { frames } }) });
    const res = await h.call({ action: 'listArtifacts' });
    assert.deepStrictEqual(res.frames.map((f) => f.public), [true, false, false]);
    const text = JSON.stringify(res);
    for (const s of ['audience', 'thumbImgURL', '_thumb', 'claudeusercontent', '__frame_t']) assert.ok(!text.includes(s), s);
  },

  'artifactThumbUrl answers the listed picture URL and fetches nothing': async () => {
    const h = thumbHarness({ thumb: () => resp(200, { bytes: PNG }) });
    await h.call({ action: 'listArtifacts' });
    assert.deepStrictEqual(await h.call({ action: 'artifactThumbUrl', uuid: PUB }), { url: thumbUrl() });
    assert.deepStrictEqual(await h.call({ action: 'artifactThumbUrl', uuid: PUB.toUpperCase() }), { url: thumbUrl() });
    assert.deepStrictEqual(await h.call({ action: 'artifactThumbUrl', uuid: PUB2 }), { error: 'no picture' }, 'listed without a picture');
    assert.deepStrictEqual(await h.call({ action: 'artifactThumbUrl', uuid: PUB3 }), { error: 'no picture' }, 'not listed');
    assert.deepStrictEqual(await h.call({ action: 'artifactThumbUrl', uuid: 'nope' }), { error: 'no picture' });
    assert.deepStrictEqual(await h.call({ action: 'artifactThumbUrl' }), { error: 'no picture' });
    assert.strictEqual(h.thumbReqs().length, 0, 'content.js never fetches the picture');
    assert.ok(!fs.readFileSync(path.join(REPO, 'content.js'), 'utf8').includes("action === 'artifactThumb'"), 'the old fetch route is gone');
    assert.ok(!h.logs.some((l) => /__frame_t|secrettok|claudeusercontent/.test(l)), 'no log holds the URL');
  },

  'artifactThumbUrl refresh re-lists once per export': async () => {
    let n = 0;
    const h = thumbHarness({ frames: () => resp(200, { json: { frames: [{ slug: PUB, thumbImgURL: thumbUrl(PUB, `tok${++n}`) }, { slug: PUB2, thumbImgURL: thumbUrl(PUB2, `old${n}`) }] } }) });
    await h.call({ action: 'listArtifacts' });
    assert.deepStrictEqual(await h.call({ action: 'artifactThumbUrl', uuid: PUB }), { url: thumbUrl(PUB, 'tok1') });
    assert.deepStrictEqual(await h.call({ action: 'artifactThumbUrl', uuid: PUB, refresh: true }), { url: thumbUrl(PUB, 'tok2') });
    assert.strictEqual(h.listCalls(), 2);
    // A second refresh in the same export lists nothing new.
    assert.deepStrictEqual(await h.call({ action: 'artifactThumbUrl', uuid: PUB2, refresh: true }), { url: thumbUrl(PUB2, 'old2') });
    assert.strictEqual(h.listCalls(), 2);
    // A new export (listArtifacts) allows one re-list again.
    await h.call({ action: 'listArtifacts' });
    assert.deepStrictEqual(await h.call({ action: 'artifactThumbUrl', uuid: PUB, refresh: true }), { url: thumbUrl(PUB, 'tok4') });
    assert.strictEqual(h.listCalls(), 4);
    assert.strictEqual(h.thumbReqs().length, 0);
  },

  'artifactThumbUrl refresh that fails leaves no picture, codes only': async () => {
    let n = 0;
    const h = thumbHarness({ frames: () => (++n === 1 ? resp(200, { json: { frames: [{ slug: PUB, thumbImgURL: thumbUrl() }] } }) : resp(401)) });
    await h.call({ action: 'listArtifacts' });
    const res = await h.call({ action: 'artifactThumbUrl', uuid: PUB, refresh: true });
    assert.deepStrictEqual(res, { error: 'no picture' });
    assert.deepStrictEqual(await h.call({ action: 'artifactThumbUrl', uuid: PUB }), { error: 'no picture' });
    assert.ok(!h.logs.some((l) => /__frame_t|secrettok|claudeusercontent/.test(l)));
    const none = thumbHarness();
    assert.deepStrictEqual(await none.call({ action: 'artifactThumbUrl', uuid: PUB, refresh: true }), { error: 'no picture' }, 'no listing yet');
    assert.strictEqual(none.listCalls(), 0);
  },

  'artifactThumbUrl refuses a URL that isn\'t exactly claude.ai\'s picture path': async () => {
    const host = `${PUB}.frame.claudeusercontent.com`;
    const bads = [
      'https://evil.example/_f/V/_thumb.img?__frame_t=t',
      `https://${PUB2}.frame.claudeusercontent.com/_f/V/_thumb.img?__frame_t=t`,
      `http://${host}/_f/V/_thumb.img?__frame_t=t`,
      `https://${host}:8443/_f/V/_thumb.img?__frame_t=t`,
      `https://u:p@${host}/_f/V/_thumb.img?__frame_t=t`,
      `https://${host}/_f/V/_thumb.img?__frame_t=t#x`,
      `https://${host}/_f/V/x.png?__frame_t=t`,
      `https://${host}/_f/../_thumb.img?__frame_t=t`,
      `https://${host}/_f/V/_thumb.img?__frame_t=t&a=b`,
      `https://${host}/_f/V/_thumb.img?other=t`,
      `https://${host}/_f/V/_thumb.img`,
      `https://${host}.evil.example/_f/V/_thumb.img?__frame_t=t`,
      'not a url', 42,
    ];
    for (const u of bads) {
      const h = thumbHarness({ frames: () => resp(200, { json: { frames: [{ slug: PUB, thumbImgURL: u }] } }) });
      await h.call({ action: 'listArtifacts' });
      assert.deepStrictEqual(await h.call({ action: 'artifactThumbUrl', uuid: PUB }), { error: 'no picture' }, String(u));
    }
    const h = thumbHarness();
    assert.deepStrictEqual(await h.call({ action: 'artifactThumbUrl', uuid: PUB }), { error: 'no picture' }, 'no listArtifacts yet');
  },

  'artifactThumbUrl keeps the token as listed': async () => {
    const listed = thumbUrl(PUB, 'a+b%2Fc.1~_-');
    const h = thumbHarness({ frames: () => resp(200, { json: { frames: [{ slug: PUB, thumbImgURL: listed }] } }) });
    await h.call({ action: 'listArtifacts' });
    assert.deepStrictEqual(await h.call({ action: 'artifactThumbUrl', uuid: PUB }), { url: listed });
    for (const tok of ['a b', 'a&b', 'a=b', 'a"b', '']) {
      const h2 = thumbHarness({ frames: () => resp(200, { json: { frames: [{ slug: PUB, thumbImgURL: thumbUrl(PUB, tok) }] } }) });
      await h2.call({ action: 'listArtifacts' });
      assert.deepStrictEqual(await h2.call({ action: 'artifactThumbUrl', uuid: PUB }), { error: 'no picture' }, tok);
    }
  },

  'a failed listing leaves no pictures': async () => {
    let n = 0;
    const h = thumbHarness({ frames: () => (++n === 1 ? resp(200, { json: { frames: [{ slug: PUB, thumbImgURL: thumbUrl() }] } }) : resp(500)) });
    await h.call({ action: 'listArtifacts' });
    assert.deepStrictEqual(await h.call({ action: 'listArtifacts' }), { error: 'HTTP 500', status: 500 });
    assert.deepStrictEqual(await h.call({ action: 'artifactThumbUrl', uuid: PUB }), { error: 'no picture' });
  },

  'publishedPageFile retries once on 403 and encodes in chunks': async () => {
    const bytes = new Uint8Array(3 * 1024 * 1024).map((_, i) => (i * 7) % 256);
    let n = 0;
    const h = publishedHarness({ src: () => (++n === 1 ? resp(403) : resp(200, { bytes })) });
    const res = await h.call({ action: 'publishedPageFile', uuid: PUB, ver: '', path: 'index.html', size: bytes.length });
    assert.ok(Buffer.from(res.base64, 'base64').equals(Buffer.from(bytes)));
    assert.strictEqual(h.frameCalls().length, 2, 'one token request, one more after the 403');
    assert.strictEqual(res.size, bytes.length);
    assertTokenStaysHome(h);
  },

  'an expired or missing token is fetched again before the file': async () => {
    const h = publishedHarness({ expiresIn: 30 });
    await h.call({ action: 'publishedPageInfo', uuid: PUB, ver: '' });
    const before = h.frameCalls().length;
    await h.call({ action: 'publishedPageFile', uuid: PUB, ver: '', path: 'index.html', size: 3 });
    assert.strictEqual(h.frameCalls().length, before + 1, 'near expiry: one new token request');
    const last = h.reqs.length - 1;
    assert.ok(h.reqs[last].url.includes('_src/') && h.reqs[last - 1].url.includes('/api/frame/'), 'token first, then the file');
    const fresh = publishedHarness();
    await fresh.call({ action: 'publishedPageFile', uuid: PUB, ver: '', path: 'index.html', size: 3 });
    const frameIdx = fresh.reqs.findIndex((r) => r.url.includes('/api/frame/'));
    const srcIdx = fresh.reqs.findIndex((r) => r.url.includes('_src/'));
    assert.ok(frameIdx === 0 && srcIdx > frameIdx, 'no cache: token first');
    assert.strictEqual(fresh.frameCalls().length, 1);
  },

  'errors carry no token': async () => {
    const h = publishedHarness({ src: () => resp(500) });
    const r1 = await h.call({ action: 'publishedPageFile', uuid: PUB, ver: '', path: 'index.html', size: 3 });
    assert.deepStrictEqual(r1, { error: 'HTTP 500', status: 500 });
    const h2 = publishedHarness({ srcThrow: new Error('https://x.frame.claudeusercontent.com/_f/V/_src/a?__frame_t=a.b.c.9') });
    const r2 = await h2.call({ action: 'publishedPageFile', uuid: PUB, ver: '', path: 'index.html', size: 3 });
    assert.deepStrictEqual(r2, { error: 'network' });
    for (const r of [r1, r2]) assert.ok(!/__frame_t|a\.b\.c/.test(JSON.stringify(r)));
  },

  'a file over the cap is refused before fetching': async () => {
    const big = 40 * 1024 * 1024;
    const h = publishedHarness({ files: { 'big.bin': { sha256: 'x', size: big, contentType: 'application/octet-stream' } } });
    await h.call({ action: 'publishedPageInfo', uuid: PUB, ver: '' });
    const r1 = await h.call({ action: 'publishedPageFile', uuid: PUB, ver: '', path: 'big.bin', size: big });
    assert.deepStrictEqual(r1, { error: 'too large' });
    const h2 = publishedHarness({ files: { 'big.bin': { sha256: 'x', size: big, contentType: 'application/octet-stream' } } });
    const r2 = await h2.call({ action: 'publishedPageFile', uuid: PUB, ver: '', path: 'big.bin', size: 1 });
    assert.deepStrictEqual(r2, { error: 'too large' });
    for (const x of [h, h2]) assert.ok(!x.reqs.some((r) => r.url.includes('_src/')));
  },

  'a listing entry without a size is refused before fetching': async () => {
    const h = publishedHarness({ files: { 'index.html': { sha256: 'x', contentType: 'text/html' } } });
    const r = await h.call({ action: 'publishedPageFile', uuid: PUB, ver: '', path: 'index.html', size: 1 });
    assert.deepStrictEqual(r, { error: 'bad response' });
    assert.ok(!h.reqs.some((q) => q.url.includes('_src/')));
  },

  'a body that streams past the cap is cut off as too large': async () => {
    const chunk = new Uint8Array(8 * 1024 * 1024);
    const h = publishedHarness({
      files: { 'index.html': { sha256: 'x', size: 1024, contentType: 'text/html' } },
      src: () => resp(200, { stream: [chunk, chunk, chunk, chunk, chunk] }),
    });
    const r = await h.call({ action: 'publishedPageFile', uuid: PUB, ver: '', path: 'index.html', size: 1024 });
    assert.deepStrictEqual(r, { error: 'too large' });
    assert.ok(resp.cancelled, 'reader cancelled');
  },

  'a cancel that rejects still gives too large, with no unhandled rejection': async () => {
    const chunk = new Uint8Array(8 * 1024 * 1024);
    const stream = [chunk, chunk, chunk, chunk, chunk];
    stream.cancelRejects = true;
    const h = publishedHarness({
      files: { 'index.html': { sha256: 'x', size: 1024, contentType: 'text/html' } },
      src: () => resp(200, { stream }),
    });
    const seen = [];
    const on = (e) => seen.push(e);
    process.on('unhandledRejection', on);
    try {
      const r = await h.call({ action: 'publishedPageFile', uuid: PUB, ver: '', path: 'index.html', size: 1024 });
      await new Promise((ok) => setTimeout(ok, 20));
      assert.deepStrictEqual(r, { error: 'too large' });
    } finally { process.off('unhandledRejection', on); }
    assert.deepStrictEqual(seen, []);
  },

  '429 waits once for Retry-After': async () => {
    let n = 0;
    const h = publishedHarness({ src: () => (++n === 1 ? resp(429, { headers: { 'Retry-After': '1' } }) : resp(200, { bytes: new Uint8Array([1, 2, 3]) })) });
    const res = await h.call({ action: 'publishedPageFile', uuid: PUB, ver: '', path: 'index.html', size: 3 });
    assert.strictEqual(res.base64, 'AQID');
    assert.deepStrictEqual(h.delays, [1000]);
  },

  'a Cowork page whose _files.json is 404 is listed from the frame info and fetched through _src': async () => {
    const infoFiles = [{ path: 'index.html', contentType: 'text/html', size: 99, sha256: 'zz', extra: 'x' }, { path: 'artifact-type/r.js', contentType: 'text/javascript' },
      { path: '../evil', contentType: 'text/plain' }, { path: 7 }, null];
    const h = publishedHarness({ info: (b) => ({ ...b, files: infoFiles }), filesJson: () => resp(404) });
    const res = await h.call({ action: 'publishedPageInfo', uuid: PUB, ver: '' });
    assert.deepStrictEqual(res.files, [{ path: 'index.html', size: null, contentType: 'text/html', sha256: null }]);
    assert.deepStrictEqual(res.rejected, ['../evil']);
    assert.strictEqual(res.runtimeSkipped, 1);
    const file = await h.call({ action: 'publishedPageFile', uuid: PUB, ver: '', path: 'index.html', size: null });
    assert.strictEqual(file.base64, 'AQID');
    assert.strictEqual(file.size, 3);
    const got = h.reqs.filter((r) => r.url.includes('.frame.claudeusercontent.com/')).map((r) => r.url.replace(/\?.*/, ''));
    assert.deepStrictEqual(got, [`https://${PUB}.frame.claudeusercontent.com/_f/V/_files.json`, `https://${PUB}.frame.claudeusercontent.com/_f/V/_src/index.html`]);
    assert.ok(!JSON.stringify([res, file]).includes('a.b.c'));
    assertTokenStaysHome(h);
  },

  'a frame-info file missing from _src is fetched by its own path': async () => {
    const h = publishedHarness({ info: (b) => ({ ...b, files: [{ path: 'a b.html', contentType: 'text/html' }] }), filesJson: () => resp(404), src: () => resp(404), direct: () => resp(200, { bytes: new Uint8Array([9]) }) });
    const file = await h.call({ action: 'publishedPageFile', uuid: PUB, ver: '', path: 'a b.html' });
    assert.strictEqual(file.base64, 'CQ==');
    const got = h.reqs.filter((r) => r.url.includes('.frame.claudeusercontent.com/')).map((r) => r.url.replace(/\?.*/, ''));
    assert.deepStrictEqual(got.slice(1), [`https://${PUB}.frame.claudeusercontent.com/_f/V/_src/a%20b.html`, `https://${PUB}.frame.claudeusercontent.com/_f/V/a%20b.html`]);
    assertTokenStaysHome(h);
  },

  'a normal listing never falls back to the direct path': async () => {
    const h = publishedHarness({ src: () => resp(404), direct: () => resp(200, { bytes: new Uint8Array([9]) }) });
    assert.deepStrictEqual(await h.call({ action: 'publishedPageFile', uuid: PUB, ver: '', path: 'index.html', size: 3 }), { error: 'HTTP 404', status: 404 });
    assert.ok(!h.reqs.some((r) => r.url.includes('/_f/V/index.html')));
  },

  'a token reply with _files.json 403 twice is an error, not the info list': async () => {
    const h = publishedHarness({ info: (b) => ({ ...b, files: [{ path: 'index.html', contentType: 'text/html' }] }), filesJson: () => resp(403) });
    assert.deepStrictEqual(await h.call({ action: 'publishedPageInfo', uuid: PUB, ver: '' }), { error: 'HTTP 403', status: 403 });
    const h2 = publishedHarness({ info: (b) => ({ ...b, files: [{ path: 'index.html', contentType: 'text/html' }] }), filesJson: () => resp(500) });
    assert.deepStrictEqual(await h2.call({ action: 'publishedPageInfo', uuid: PUB, ver: '' }), { error: 'HTTP 500', status: 500 });
  },

  'a shared page with no asset token is fetched without one': async () => {
    const tokenless = (b) => { const { assetToken, ...rest } = b; return { ...rest, authoredByOthers: true, files: [{ path: 'index.html', contentType: 'text/html' }] }; };
    const h = publishedHarness({ info: tokenless, filesJson: () => { throw new TypeError('Failed to fetch'); }, src: () => { throw new TypeError('Failed to fetch'); }, direct: () => resp(200, { bytes: new Uint8Array([1, 2]) }) });
    const res = await h.call({ action: 'publishedPageInfo', uuid: PUB, ver: '' });
    assert.deepStrictEqual(res.files, [{ path: 'index.html', size: null, contentType: 'text/html', sha256: null }]);
    const file = await h.call({ action: 'publishedPageFile', uuid: PUB, ver: '', path: 'index.html' });
    assert.strictEqual(file.base64, 'AQI=');
    const host = h.reqs.filter((r) => r.url.includes('.frame.claudeusercontent.com/'));
    assert.deepStrictEqual(host.map((r) => r.url), [`https://${PUB}.frame.claudeusercontent.com/_f/V/index.html`], 'without a token _files.json and _src are skipped (both fail before any status on claude.ai)');
    assert.ok(!h.reqs.some((r) => r.url.includes('__frame_t')));
    assert.strictEqual(h.frameCalls().length, 1, 'no token refresh for a page without one');
    for (const r of host) assert.deepStrictEqual([r.opts.credentials, r.opts.redirect, r.opts.referrerPolicy], ['omit', 'error', 'no-referrer']);
  },

  'a page with no asset token whose file fails both ways gives the code': async () => {
    const tokenless = (b) => { const { assetToken, ...rest } = b; return { ...rest, files: [{ path: 'index.html', contentType: 'text/html' }] }; };
    const h = publishedHarness({ info: tokenless, filesJson: () => resp(403), src: () => resp(403), direct: () => resp(404) });
    assert.deepStrictEqual(await h.call({ action: 'publishedPageFile', uuid: PUB, ver: '', path: 'index.html' }), { error: 'HTTP 404', status: 404 });
    const h2 = publishedHarness({ info: tokenless, filesJson: () => resp(403), src: () => resp(404), direct: () => resp(403) });
    assert.deepStrictEqual(await h2.call({ action: 'publishedPageFile', uuid: PUB, ver: '', path: 'index.html' }), { error: 'HTTP 403', status: 403 });
    assert.strictEqual(h2.frameCalls().length, 1);
    const h3 = publishedHarness({ info: (b) => { const { assetToken, ...rest } = b; return { ...rest, ver: '' }; } });
    assert.deepStrictEqual(await h3.call({ action: 'publishedPageInfo', uuid: PUB, ver: '' }), { error: 'bad response' });
  },

  'a frame-info file that streams past the cap is too large': async () => {
    const chunk = new Uint8Array(8 * 1024 * 1024);
    const h = publishedHarness({ info: (b) => ({ ...b, files: [{ path: 'index.html', contentType: 'text/html' }] }), filesJson: () => resp(404),
      src: () => resp(200, { stream: [chunk, chunk, chunk, chunk, chunk] }) });
    assert.deepStrictEqual(await h.call({ action: 'publishedPageFile', uuid: PUB, ver: '', path: 'index.html' }), { error: 'too large' });
  },

  'a fallback status with no files in the frame info keeps the error': async () => {
    const h = publishedHarness({ filesJson: () => resp(404) });
    assert.deepStrictEqual(await h.call({ action: 'publishedPageInfo', uuid: PUB, ver: '' }), { error: 'HTTP 404', status: 404 });
    const h2 = publishedHarness({ info: (b) => { const { files, ...rest } = b; return rest; }, filesJson: () => resp(404) });
    assert.deepStrictEqual(await h2.call({ action: 'publishedPageInfo', uuid: PUB, ver: '' }), { error: 'HTTP 404', status: 404 });
    const h3 = publishedHarness({ info: (b) => { const { assetToken, ...rest } = b; return rest; }, filesJson: () => resp(403) });
    assert.deepStrictEqual(await h3.call({ action: 'publishedPageInfo', uuid: PUB, ver: '' }), { error: 'HTTP 403', status: 403 });
  },

  'a page with no asset token whose _files.json is 404 uses the frame info list': async () => {
    const tokenless = (b) => { const { assetToken, ...rest } = b; return { ...rest, files: [{ path: '__proto__', contentType: 'text/plain' }, { path: 'index.html', contentType: 'text/html' }] }; };
    const h = publishedHarness({ info: tokenless, filesJson: () => resp(404) });
    const res = await h.call({ action: 'publishedPageInfo', uuid: PUB, ver: '' });
    assert.deepStrictEqual(res.files.map((f) => f.path), ['__proto__', 'index.html']);
    assert.ok(!h.reqs.some((r) => r.url.includes('__frame_t')));
  },

  'published actions reject a bad uuid or version before any fetch': async () => {
    const h = publishedHarness();
    assert.deepStrictEqual(await h.call({ action: 'publishedPageInfo', uuid: 'nope', ver: '' }), { error: 'bad request' });
    assert.deepStrictEqual(await h.call({ action: 'publishedPageInfo', uuid: PUB, ver: '../x' }), { error: 'bad request' });
    assert.strictEqual(h.reqs.length, 0);
  },
};

for (const [name, fn] of Object.entries(tests)) test(name, fn);
