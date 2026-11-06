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
    const out = {};
    for (const f of fs.readdirSync(path.join(dir, 'out'))) out[f] = fs.readFileSync(path.join(dir, 'out', f), 'utf8');
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

module.exports = { REPO, loadPopup, loadFixture, pythonArtifacts, use, result, oneMessage, twoMessages };
