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
    querySelectorAll: () => [], setAttribute() {}, getAttribute: () => null,
    classList: { contains: () => false, add() {}, remove() {}, toggle() {} },
  };
}

function loadPopup({ fetch = async () => ({ ok: false, status: 404 }) } = {}) {
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
    setTimeout, clearTimeout, URL, encodeURIComponent, btoa, atob, TextEncoder, TextDecoder,
    JSZip: function () {},
    FileReader: class { readAsDataURL() { this.result = 'data:x;base64,'; if (this.onload) this.onload(); } },
    fetch,
  };
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
    fetch: async (url) => {
      for (const [re, answer] of routes) if (re.test(url)) return answer(url);
      if (failing.some((id) => url.includes(id))) return { ok: false, status: 404 };
      const hit = /\/files\/([^/]+)\/contents?$/.exec(url);
      if (hit) return { ok: true, status: 200, blob: async () => (texts[hit[1]] !== undefined ? texts[hit[1]] : textBlob(`file ${hit[1]}`)) };
      return { ok: false, status: 404 };
    },
  });
}
async function runFolder(popup, data, { folderName = '', shared = null, target = zipStub() } = {}) {
  popup.sandbox.__folder = target;
  popup.sandbox.__data = data;
  popup.sandbox.__shared = shared;
  popup.sandbox.__name = folderName;
  const output = await vm.runInContext("populateConversationFolder(__folder, __data, null, 'org', __shared, __name)", popup.sandbox);
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
function docTools(prefix = 'mcp__Claude_Docs__') {
  const batchResult = JSON.stringify({ verdict: 'allow', acks: [{ verdict: 'allow', minted: 'm1' }, { verdict: 'allow', id: 'node-1', rev: 1, session: 'sess',
    xml: "<doc><paragraph id='sess.0' heading='1'>Lorber …</paragraph><paragraph id='.5'><date id='.6' value='2026-11-08'/></paragraph><pending id='.10' intent='a'/><pending id='.11' intent='b'/></doc>" }],
    frame: { url: DOC_URL } }) + '\n\nThe doc is NOT open for the user yet. Open it NOW.';
  const docBlocks = { asof: { type: 'date', value: '2026-11-08' }, me: { type: 'mention', user: 'me' }, s1: { type: 'pending', intent: 'first' }, s2: { type: 'pending', intent: 'second' } };
  const batch = { type: 'tool_use', id: 'd1', name: prefix + 'batch', input: { container: { kind: 'project', create: { name: 'Lorber Notes', doc: { blocks: docBlocks,
    markdown: '# Lorber Notes\n\nA subtitle\n\n<?claude block asof?> · <?claude block me?>\n\n<?claude block s1?>\n\n<?claude block s2?>' } } }, batch: [] } };
  const result = (id, text) => ({ type: 'tool_result', tool_use_id: id, name: batch.name, content: [{ type: 'text', text }] });
  const update = (id, target, content) => ({ type: 'tool_use', id, name: prefix + 'update', input: { ref: { object: 'node', id: 'node-1' }, engine: 'prose', container: { kind: 'project', id: 'proj' },
    payload: JSON.stringify({ ops: [{ op: 'replace', target: { kind: 'blocks', ids: [target] }, with: { from: { kind: 'inline', content } } }] }) } });
  const comment = { type: 'tool_use', id: 'c1', name: prefix + 'create', input: { object: 'utterance', container: { kind: 'project', id: 'proj' },
    payload: JSON.stringify({ value: { body: 'Table or prose?', parent: { object: 'node', id: 'node-1', anchor: { kind: 'find', text: 'Beta' } } } }) } };
  return { batch, batchResult: result('d1', batchResult), update, comment, result };
}

module.exports = { DOC_URL, docTools, REPO, loadPopup, loadFixture, pythonArtifacts, use, result, oneMessage, twoMessages, textBlob, projectResponses, zipStub, exportPopup, runFolder, withUploads };
