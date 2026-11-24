// Panel screens: the running flag and Export All's withArtifacts option.
const { test } = require('node:test');
const assert = require('assert');
const { loadPopup, zipStub } = require('./helpers');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('scheduleRefresh defers while an export runs, whatever the progress bar shows', async () => {
  const { sandbox, fn } = loadPopup();
  let queried = 0;
  sandbox.chrome.tabs.query = async () => { queried++; return []; };
  fn('exportRunning = true');
  sandbox.document.getElementById('progress').style.display = 'none';
  fn('scheduleRefresh')();
  await sleep(200);
  assert.strictEqual(fn('refreshDeferred'), true);
  assert.strictEqual(queried, 0);
});

test('bulkExportZip honours withArtifacts over the setting', async () => {
  const { sandbox, fn } = loadPopup({ before: (sb) => { sb.JSZip = function () { return zipStub(); }; } });
  const actions = [];
  sandbox.chrome.tabs.query = async () => [{ id: 1, url: 'https://claude.ai/chat/x', active: true }];
  sandbox.chrome.tabs.sendMessage = (id, msg, cb) => {
    actions.push(msg.action);
    const reply = msg.action === 'fetchAllConversations' ? { data: [], orgId: 'o' } : { error: 'stop' };
    if (cb) cb(reply);
  };
  fn('settings.exportAllArtifacts = true');
  await fn('bulkExportZip')({ withArtifacts: false });
  assert.ok(actions.includes('fetchAllConversations'));
  assert.ok(!actions.includes('listArtifacts'), actions.join());
});
