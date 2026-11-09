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
    id, disabled: false, textContent: '', className: '', value: '', checked: false, style: {},
    handlers: {}, addEventListener(t, f) { this.handlers[t] = f; }, appendChild() {}, querySelectorAll: () => [],
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
  env.title = () => el('info').textContent;
  env.status = () => el('status').textContent;
  env.exportDisabled = () => ['exportMd', 'exportMdEmbed', 'exportZip', 'exportJson'].every((i) => el(i).disabled);
  env.navigate = (u) => {
    env.tab.url = u;
    chrome.tabs.onUpdated.fire(env.tab.id, { url: u }, env.tab);
  };
  return env;
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
    assert.match(e.el('status').className, /error/);
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
    assert.match(e.status(), /navigate to claude\.ai/i);
  },

  'a failed fetch reports an error and keeps export disabled': async () => {
    const e = makeEnv();
    await sleep(SETTLE);
    e.navigate(chatUrl('dddddddd-0000-4000-8000-000000000004'));
    await sleep(SETTLE);
    assert.strictEqual(e.exportDisabled(), true);
    assert.match(e.el('status').className, /error/);
    assert.match(e.status(), /404/);
  },

  'a failed injection shows the real error': async () => {
    const e = makeEnv();
    await sleep(SETTLE);
    e.connectionError = true;
    e.navigate(chatUrl(B));
    await sleep(SETTLE);
    assert.strictEqual(e.exportDisabled(), true);
    assert.match(e.el('status').className, /error/);
    assert.match(e.status(), /Cannot access this tab/);
  },

  'selection during an export waits, then keeps the result status': async () => {
    const e = makeEnv();
    await sleep(SETTLE);
    e.el('progress').style.display = 'block';
    e.el('status').textContent = 'Creating zip archive...';
    e.navigate(chatUrl(B));
    await sleep(SETTLE);
    assert.strictEqual(e.current()?.uuid, A, 'chat must not change mid-export');
    assert.strictEqual(e.status(), 'Creating zip archive...');
    vm.runInContext('hideProgress()', e.ctx);
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
};

for (const [name, fn] of Object.entries(tests)) test(name, fn);
