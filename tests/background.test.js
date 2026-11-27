const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

// Loads background.js against a fake chrome and returns its message listener
// and the side-panel behaviours it set.
function loadBackground({ sidePanel = true, stored = {} } = {}) {
  const behaviours = [];
  let listener = null;
  const chrome = {
    storage: {
      local: { get: async () => stored },
      onChanged: { addListener() {} },
    },
    runtime: {
      onMessage: { addListener(fn) { listener = fn; } },
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
    },
    tabs: { query() { throw new Error('background.js should not query tabs'); } },
  };
  if (sidePanel) {
    chrome.sidePanel = {
      setPanelBehavior: async (b) => { behaviours.push(b.openPanelOnActionClick); },
      open: async () => { throw new Error('background.js should not open the panel'); },
    };
  }
  vm.runInNewContext(SOURCE, { chrome, console: { log() {}, error() {} } });
  return { listener, behaviours };
}

function send(listener, message) {
  return new Promise((resolve) => {
    const out = { kept: undefined, reply: null };
    out.kept = listener(message, {}, (r) => { out.reply = JSON.parse(JSON.stringify(r)); setImmediate(() => resolve(out)); });
    if (!out.kept) setImmediate(() => resolve(out));
  });
}

test('background: enableSidePanelMode and disableSidePanelMode set the action click behaviour', async () => {
  const { listener, behaviours } = loadBackground();
  await new Promise((r) => setImmediate(r));
  behaviours.length = 0;
  assert.deepStrictEqual((await send(listener, { action: 'enableSidePanelMode' })).reply, { status: 'enabled' });
  assert.deepStrictEqual((await send(listener, { action: 'disableSidePanelMode' })).reply, { status: 'disabled' });
  assert.deepStrictEqual(behaviours, [true, false]);
});

test('background: any other message is left alone, and the channel is not held open', async () => {
  const { listener } = loadBackground();
  for (const action of ['openSidePanel', 'checkSidePanelStatus', 'fetchConversation', undefined]) {
    const { kept, reply } = await send(listener, { action });
    assert.strictEqual(kept, false, String(action));
    assert.strictEqual(reply, null, String(action));
  }
});

test('background: without the Side Panel API the two toggles say unsupported', async () => {
  const { listener } = loadBackground({ sidePanel: false });
  const { reply } = await send(listener, { action: 'enableSidePanelMode' });
  assert.strictEqual(reply.status, 'unsupported');
  assert.strictEqual((await send(listener, { action: 'openSidePanel' })).kept, false);
});

test('background: on start it applies the stored useSidePanel', async () => {
  const { behaviours } = loadBackground({ stored: { useSidePanel: true } });
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(behaviours, [true]);
});
