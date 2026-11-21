// Loads the real popup.js in a VM with stubbed Chrome and DOM APIs.
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'conversation.json');

function element(id) {
  return {
    id, disabled: false, textContent: '', className: '', value: '', checked: false, style: {},
    handlers: {}, addEventListener(type, fn) { this.handlers[type] = fn; }, appendChild() {},
    querySelectorAll: () => [], querySelector: () => null, setAttribute() {}, getAttribute: () => null,
    classList: { contains: () => false, add() {}, remove() {}, toggle() {} },
  };
}

// location: the page's URL path, such as '/popup.html' (IS_POPUP); session: an object standing in for
// chrome.storage.session, read and written in place; before(sandbox): runs before the scripts load.
function loadPopup({ fetch = async () => ({ ok: false, status: 404 }), location = null, session = null, before = null } = {}) {
  const elements = {};
  const event = () => ({ addListener() {} });
  const sandbox = {
    chrome: {
      runtime: { lastError: null, onMessage: event(), sendMessage() {}, getURL: (p) => `chrome-extension://test/${p}` },
      storage: { local: { get: async () => ({}), set: async () => {} }, onChanged: event() },
      tabs: { onActivated: event(), onUpdated: event(), query: async () => [], reload: async () => {}, sendMessage() {} },
      sidePanel: {},
    },
    console: { log() {}, warn() {}, error() {} },
    document: {
      getElementById: (id) => elements[id] || (elements[id] = element(id)),
      querySelectorAll: () => [], querySelector: () => null, addEventListener() {},
    },
    window: { close() {} },
    setTimeout, clearTimeout, URL, encodeURIComponent, btoa, atob, TextEncoder, TextDecoder, crypto: require('crypto').webcrypto,
    JSZip: function () {},
    FileReader: class { readAsDataURL() { this.result = 'data:x;base64,'; if (this.onload) this.onload(); } },
    fetch,
  };
  if (location) sandbox.location = { pathname: location };
  if (session) {
    sandbox.chrome.storage.session = {
      get: async (key) => (key in session ? { [key]: session[key] } : {}),
      set: async (o) => { Object.assign(session, o); },
      remove: async (key) => { delete session[key]; },
    };
  }
  if (before) before(sandbox);
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(REPO, 'export-core.js'), 'utf8'), sandbox);
  vm.runInContext(fs.readFileSync(path.join(REPO, 'takeout-viewer.js'), 'utf8'), sandbox);
  vm.runInContext(fs.readFileSync(path.join(REPO, 'viewer', 'marked.min.js'), 'utf8'), sandbox);
  vm.runInContext(fs.readFileSync(path.join(REPO, 'popup.js'), 'utf8'), sandbox);
  return { sandbox, fn: (name) => vm.runInContext(name, sandbox) };
}

const loadFixture = () => JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

// Artifacts from extract_artifacts.py for a conversation object.
function pythonArtifacts(data) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'takeout-test-'));
  try {
    fs.writeFileSync(path.join(dir, 'original.json'), JSON.stringify(data));
    execFileSync('python3', ['-B', path.join(REPO, 'extract_artifacts.py'), path.join(dir, 'original.json'), '-o', path.join(dir, 'out')], { stdio: 'ignore' });
    // Any name is a plain key, __proto__ included. The BOM on .md files is the exporter's, not content.
    const out = {};
    for (const f of fs.readdirSync(path.join(dir, 'out'))) {
      const value = fs.readFileSync(path.join(dir, 'out', f), 'utf8').replace(/^\uFEFF/, '');
      Object.defineProperty(out, f, { value, enumerable: true, writable: true, configurable: true });
    }
    return out;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Tool-call block builders for inline conversations.
const use = (id, name, input) => ({ type: 'tool_use', id, name, input });
const result = (id, isError) => ({ type: 'tool_result', tool_use_id: id, is_error: isError, content: [] });
const oneMessage = (content) => ({
  current_leaf_message_uuid: 'a',
  chat_messages: [{ uuid: 'a', parent_message_uuid: null, sender: 'assistant', content }],
});
const twoMessages = (first, second) => ({
  current_leaf_message_uuid: 'b',
  chat_messages: [
    { uuid: 'a', parent_message_uuid: null, sender: 'assistant', content: first },
    { uuid: 'b', parent_message_uuid: 'a', sender: 'assistant', content: second },
  ],
});

// ---- populateConversationFolder against an in-memory folder ----
const textBlob = (text, type = 'text/plain') => ({
  marker: text, size: text.length, type, text: async () => text, arrayBuffer: async () => new ArrayBuffer(0),
});
const projectResponses = (name = 'My Project') => [
  [/\/projects\/P$/, () => ({ ok: true, status: 200, json: async () => ({ name, docs_count: 1, files_count: 1 }) })],
  [/\/projects\/P\/docs$/, () => ({ ok: true, status: 200, json: async () => [{ uuid: 'd1', file_name: 'Brief.md', content: 'be kind' }] })],
  [/\/projects\/P\/files$/, () => ({ ok: true, status: 200, json: async () => [{ file_uuid: 'pf1', file_name: 'Paper.pdf' }] })],
];
const zipStub = () => {
  const written = {};
  return { written, file: (name, content, options) => { written[name] = options ? { content, options } : content; } };
};
function exportPopup({ failing = [], routes = [], texts = {} } = {}) {
  return loadPopup({
    fetch: async (url, opts) => {
      for (const [re, answer] of routes) if (re.test(url)) return answer(url, opts);
      if (failing.some((id) => url.includes(id))) return { ok: false, status: 404 };
      const hit = /\/files\/([^/]+)\/contents?$/.exec(url);
      if (hit) return { ok: true, status: 200, blob: async () => (texts[hit[1]] !== undefined ? texts[hit[1]] : textBlob(`file ${hit[1]}`)) };
      return { ok: false, status: 404 };
    },
  });
}
async function runFolder(popup, data, { folderName = '', shared = null, target = zipStub(), fetchPublished = null } = {}) {
  popup.sandbox.__folder = target;
  popup.sandbox.__data = data;
  popup.sandbox.__shared = shared;
  popup.sandbox.__name = folderName;
  popup.sandbox.__fetchPublished = fetchPublished;
  const output = await vm.runInContext("populateConversationFolder(__folder, __data, null, 'org', __shared, __name, __fetchPublished)", popup.sandbox);
  return { written: target.written, output, chat: output.viewerChat };
}
const withUploads = () => {
  const data = loadFixture();
  const first = data.chat_messages.find((m) => m.sender === 'human');
  first.files = [];
  first.files_v2 = [
    { success: true, file_name: 'notes.txt', file_uuid: 'up-text', file_kind: 'blob' },
    { success: true, file_name: 'photo.png', file_uuid: 'up-png', file_kind: 'image' },
    { success: true, file_name: 'gone.pdf', file_uuid: 'up-gone', file_kind: 'document' },
    { success: true, file_name: 'legacy.txt', file_kind: 'blob' },
  ];
  return data;
};

// A chat that writes a Claude Docs document, as claude.ai's Docs tools do: batch creates it with
// pending sections, update fills them, create adds a comment. turns: [[blocks], ...] of extra content.
const DOC_URL = 'https://claude.ai/artifact/TESTDOC123';
const DOC_U = 'd0c00000-1111-4222-8333-444455556666';
const OTHER_U = '0f0f0000-1111-4222-8333-444455556666';
function docTools(prefix = 'mcp__Claude_Docs__', { node = 'node-1', title = 'Lorber Notes', idPrefix = '', realShape = false, frameUrl = DOC_URL } = {}) {
  const acks = [{ verdict: 'allow', minted: 'm1' }, { verdict: 'allow', id: node, rev: 1, session: 'sess',
    xml: "<doc><paragraph id='sess.0' heading='1'>Lorber …</paragraph><paragraph id='.5'><date id='.6' value='2026-11-08'/></paragraph><pending id='.10' intent='a'/><pending id='.11' intent='b'/></doc>" }];
  const batchResult = JSON.stringify(realShape ? { verdict: 'allow', acks, lids: {}, created: { verdict: 'allow', minted: DOC_U, bound: true }, frame: { slug: OTHER_U } }
    : { verdict: 'allow', acks, frame: { url: frameUrl } }) + '\n\nThe doc is NOT open for the user yet. Open it NOW.';
  const docBlocks = { asof: { type: 'date', value: '2026-11-08' }, me: { type: 'mention', user: 'me' }, s1: { type: 'pending', intent: 'first' }, s2: { type: 'pending', intent: 'second' } };
  const batch = { type: 'tool_use', id: idPrefix + 'd1', name: prefix + 'batch', input: { container: { kind: 'project', create: { name: title, doc: { blocks: docBlocks,
    markdown: '# ' + title + '\n\nA subtitle\n\n<?claude block asof?> · <?claude block me?>\n\n<?claude block s1?>\n\n<?claude block s2?>' } } }, batch: [] } };
  const result = (id, text) => ({ type: 'tool_result', tool_use_id: id, name: batch.name, content: [{ type: 'text', text }] });
  const update = (id, target, content, extra = {}) => ({ type: 'tool_use', id, name: prefix + 'update', input: { ref: { object: 'node', id: node }, engine: 'prose', container: { kind: 'project', id: 'proj' },
    payload: JSON.stringify({ ops: [{ op: 'replace', target: { kind: 'blocks', ids: [target] }, with: { from: { kind: 'inline', content }, ...extra } }] }) } });
  const comment = { type: 'tool_use', id: idPrefix + 'c1', name: prefix + 'create', input: { object: 'utterance', container: { kind: 'project', id: 'proj' },
    payload: JSON.stringify({ value: { body: 'Table or prose?', parent: { object: 'node', id: node, anchor: { kind: 'find', text: 'Beta' } } } }) } };
  return { batch, batchResult: result(idPrefix + 'd1', batchResult), update, comment, result };
}

// Answers content.js's publishedPageInfo and publishedPageFile from a table, and records every call.
// pages: { <uuid>: { title, history, live: <ver of ''>, error: <info response>, versions: { <ver>: { rejected,
// files: { <path>: text | { body, sha256, type, error, unverified } } } } } }. A file's sha256 defaults to that of its
// body; an unverified one (listed from the frame info, as Cowork pages are) has no size and no sha256.
function publishedFetcher(pages) {
  const crypto = require('crypto');
  const calls = [];
  const fileOf = (f) => (typeof f === 'string' ? { body: f } : f);
  const fetch = async (msg) => {
    calls.push(JSON.parse(JSON.stringify(msg)));
    const page = pages[msg.uuid];
    if (!page) return { error: 'HTTP 404', status: 404 };
    if (page.error) return page.error;
    const ver = msg.ver === '' ? page.live : msg.ver;
    const v = page.versions[ver];
    if (!v) return { error: 'HTTP 404', status: 404 };
    if (msg.action === 'publishedPageInfo') {
      return {
        ver, title: page.title, history: page.history || Object.keys(page.versions), rejected: v.rejected || [],
        ...(page.runtimeSkipped !== undefined ? { runtimeSkipped: page.runtimeSkipped } : {}),
        files: Object.entries(v.files).map(([path, raw]) => {
          const f = fileOf(raw);
          const body = Buffer.from(f.body);
          if (f.unverified) return { path, size: f.size === undefined ? null : f.size, contentType: f.type === undefined ? 'text/html' : f.type, sha256: null };
          return { path, size: body.length, contentType: f.type === undefined ? 'text/html' : f.type, sha256: f.sha256 || crypto.createHash('sha256').update(body).digest('hex') };
        }),
      };
    }
    if (msg.action === 'publishedPageFile') {
      if (!Object.prototype.hasOwnProperty.call(v.files, msg.path)) return { error: 'not found' };
      const f = fileOf(v.files[msg.path]);
      if (f.error) return f.error;
      const body = Buffer.from(f.body);
      return { base64: body.toString('base64'), contentType: f.type || 'text/html', size: body.length };
    }
    return { error: 'bad request' };
  };
  return { fetch, calls, count: (action, uuid) => calls.filter((c) => c.action === action && (!uuid || c.uuid === uuid)).length };
}

// The extension's own files, as chrome.runtime.getURL serves them: a fetch route for exportPopup.
const assetRoutes = () => [[/^chrome-extension:\/\/test\/(.*)$/, (url) => ({ ok: true, status: 200, text: async () => fs.readFileSync(path.join(REPO, url.replace('chrome-extension://test/', '')), 'utf8') })]];

// Runs exportArtifacts in the sandbox: content.js's listArtifacts answers { frames, accountName } (or list,
// when given, as the whole reply), publishedPageInfo and publishedPageFile come from publishedFetcher(pages),
// with a real JSZip and storage kept in memory. Card pictures: thumbs maps a uuid to the frame host's answer for
// its picture ({ status, type, body } or { stream: [chunks] }, or a function (url, attempt) -> that, which may
// throw), or to { error } for content.js's artifactThumbUrl reply; a uuid not in thumbs has no picture. content.js
// answers https://<uuid>.frame.claudeusercontent.com/_f/V/_thumb.img?__frame_t=TOKEN<n>X<uuid8>, n counting refreshes.
// granted: whether chrome.permissions.contains says the optional https permission is there (default true). options go to exportArtifacts ({ directory } for a folder);
// routes go to exportPopup's fetch, before the extension's own files (assetRoutes; assets: false leaves those out,
// so viewer.html can't be built). Returns { store, saved (the download), zip, files (path -> text, from the ZIP
// or the run folder), raw (path -> Buffer), views (what writeArtifactsViewer was given, or null), status,
// fetcher, listCalls, thumbCalls (artifactThumbUrl messages), frameReqs ({ url, opts } the popup fetched from the
// frame host), consoleCalls, permissionRequests, popup }.
const THUMB_HOST = /^https:\/\/([0-9a-f-]{36})\.frame\.claudeusercontent\.com\/_f\/V\/_thumb\.img\?__frame_t=/;
function thumbResponse(spec) {
  const status = spec.status == null ? 200 : spec.status;
  const headers = { get: (h) => (String(h).toLowerCase() === 'content-type' ? (spec.type == null ? 'image/png' : spec.type) : null) };
  const res = { ok: status >= 200 && status < 300, status, headers };
  if (spec.stream) {
    const chunks = spec.stream.map((c) => new Uint8Array(c));
    res.cancelled = false;
    res.body = { getReader: () => ({ read: async () => (chunks.length ? { done: false, value: chunks.shift() } : { done: true }), cancel: async () => { res.cancelled = true; } }) };
  } else {
    const body = Buffer.from(spec.body || []);
    res.arrayBuffer = async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length);
  }
  return res;
}
async function runArtifacts({ frames = [], pages = {}, options = {}, stored = {}, accountName = 'Mika', list = null, setup = null, thumbs = {}, granted = true, routes = [], assets = true } = {}) {
  const JSZip = require('../jszip.min.js');
  const frameReqs = [];
  const attempts = {};
  const thumbRoute = [THUMB_HOST, (url, opts) => {
    frameReqs.push({ url, opts: { ...opts } });
    const uuid = THUMB_HOST.exec(url)[1];
    attempts[uuid] = (attempts[uuid] || 0) + 1;
    const spec = thumbs[uuid];
    const got = typeof spec === 'function' ? spec(url, attempts[uuid]) : spec;
    return thumbResponse(got || { status: 404 });
  }];
  const popup = exportPopup({ routes: [thumbRoute, ...routes, ...(assets ? assetRoutes() : [])] });
  const sb = popup.sandbox;
  const consoleCalls = [];
  sb.console = Object.fromEntries(['log', 'warn', 'error', 'info', 'debug'].map((k) => [k, (...a) => { consoleCalls.push([k, ...a.map((x) => { try { return typeof x === 'string' ? x : JSON.stringify(x) || String(x); } catch (e) { return String(x); } })]); }]));
  const permissionRequests = [];
  sb.chrome.permissions = { contains: async () => granted, request: async (o) => { permissionRequests.push(o); return granted; } };
  let refreshes = 0;
  const store = JSON.parse(JSON.stringify(stored));
  const fetcher = publishedFetcher(pages);
  const listCalls = [];
  const thumbCalls = [];
  sb.chrome.storage.local.get = async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((k) => k in store).map((k) => [k, JSON.parse(JSON.stringify(store[k]))]));
  sb.chrome.storage.local.set = async (o) => { Object.assign(store, JSON.parse(JSON.stringify(o))); };
  sb.chrome.tabs.query = async () => [{ id: 1, url: 'https://claude.ai/artifacts' }];
  sb.chrome.tabs.sendMessage = (id, msg, cb) => {
    if (msg.action === 'listArtifacts') {
      listCalls.push(JSON.parse(JSON.stringify(msg)));
      cb(list || { frames: JSON.parse(JSON.stringify(frames)), accountName: msg.withAccountName ? accountName : null, orgId: 'org-1' });
    } else if (msg.action === 'publishedPageInfo' || msg.action === 'publishedPageFile') {
      fetcher.fetch(msg).then(cb);
    } else if (msg.action === 'artifactThumbUrl') {
      thumbCalls.push(msg.refresh ? { uuid: msg.uuid, refresh: true } : msg.uuid);
      if (msg.refresh) refreshes++;
      const t = Object.prototype.hasOwnProperty.call(thumbs, msg.uuid) ? thumbs[msg.uuid] : { error: 'no picture' };
      cb(t && t.error ? { ...t } : { url: `https://${msg.uuid}.frame.claudeusercontent.com/_f/V/_thumb.img?__frame_t=TOKEN${refreshes}X${msg.uuid.slice(0, 8)}` });
    } else cb({});
  };
  sb.JSZip = JSZip;
  sb.Uint8Array = Uint8Array;
  let saved = null;
  sb.download = (blob, name) => { saved = { blob, name }; };
  sb.setTimeout = (f) => setTimeout(f, 0);
  vm.runInContext('orgId = "org-1"', sb);
  // Records the views the export hands the viewer step, then runs that step as it is.
  vm.runInContext(`(() => {
    const orig = writeArtifactsViewer;
    globalThis.__views = null;
    writeArtifactsViewer = async (root, views, opts) => { globalThis.__views = views; return orig(root, views, opts); };
  })()`, sb);
  if (setup) setup(sb);
  sb.__opts = options;
  await vm.runInContext('exportArtifacts(__opts)', sb);
  const zip = saved ? await JSZip.loadAsync(await saved.blob.arrayBuffer()) : null;
  const files = {};
  const raw = {};
  const text = (d) => (typeof d === 'string' ? d : Buffer.from(d).toString('utf8'));
  const buffer = (d) => (typeof d === 'string' ? Buffer.from(d, 'utf8') : Buffer.from(d));
  if (zip) {
    for (const n of Object.keys(zip.files)) {
      if (zip.files[n].dir) continue;
      raw[n] = await zip.file(n).async('nodebuffer');
      files[n] = raw[n].toString('utf8');
    }
  } else if (options.directory && typeof options.directory.flat === 'function') {
    const runs = [...options.directory.entries.values()];
    const run = runs[runs.length - 1];
    if (run && typeof run.flat === 'function') for (const [n, d] of Object.entries(run.flat())) { files[n] = text(d); raw[n] = buffer(d); }
  }
  const views = sb.__views ? JSON.parse(JSON.stringify(sb.__views)) : null;
  return { store, saved, zip, files, raw, views, status: sb.document.getElementById('status'), fetcher, listCalls, thumbCalls, frameReqs, consoleCalls, permissionRequests, popup };
}

module.exports = { runArtifacts, assetRoutes, DOC_URL, DOC_U, OTHER_U, docTools, REPO, loadPopup, loadFixture, pythonArtifacts, use, result, oneMessage, twoMessages, textBlob, projectResponses, zipStub, exportPopup, runFolder, withUploads, publishedFetcher };
