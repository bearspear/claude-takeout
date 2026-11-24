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

// Run results (Task 2): bulkExportZip and exportArtifacts resolve what the Done / Export stopped screens show.
const vm = require('vm');
const { exportPopup, loadFixture, withUploads, runArtifacts } = require('./helpers');

// A ZIP that keeps what is written by path (the fixture's fake blobs can't go through JSZip).
function fakeZip(written = {}, prefix = '') {
  return {
    written,
    file: (name, content) => { written[prefix + name] = content; },
    folder: (name) => fakeZip(written, `${prefix}${name}/`),
    generateAsync: async () => new Blob(['zip']),
  };
}

async function bulkRun({ list, chats, failing = [], options = {}, listReply = null, stored = {} }) {
  const popup = exportPopup({ failing });
  const sb = popup.sandbox;
  const store = JSON.parse(JSON.stringify(stored));
  sb.chrome.storage.local.get = async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((k) => k in store).map((k) => [k, JSON.parse(JSON.stringify(store[k]))]));
  sb.chrome.storage.local.set = async (o) => { Object.assign(store, JSON.parse(JSON.stringify(o))); };
  sb.chrome.tabs.query = async () => [{ id: 1, url: 'https://claude.ai/chat/x' }];
  sb.chrome.tabs.sendMessage = (id, msg, cb) => {
    if (msg.action === 'fetchAllConversations') cb(listReply || { data: list, orgId: 'org-1' });
    else if (msg.action === 'fetchConversation') cb({ data: chats[msg.conversationId] });
    else cb({ error: 'no' });
  };
  const zip = fakeZip();
  sb.JSZip = function () { return zip; };
  let saved = null;
  sb.download = (blob, name) => { saved = { blob, name, written: zip.written }; };
  sb.setTimeout = (f) => setTimeout(f, 0);
  vm.runInContext('orgId = "org-1"', sb);
  sb.__opts = { withArtifacts: false, ...options };
  const result = await vm.runInContext('bulkExportZip(__opts)', sb);
  return { result: result && JSON.parse(JSON.stringify(result)), saved, store, status: sb.document.getElementById('status') };
}

test('bulkExportZip resolves a done RunResult with counts and warnings', async () => {
  const up = Object.assign(withUploads(), { uuid: 'c-up', name: 'Trip notes' });
  const fx = Object.assign(loadFixture(), { uuid: 'c-fx' });
  const list = [{ uuid: 'c-up', name: 'Trip notes', updated_at: '2026-01-01T00:00:00Z' }, { uuid: 'c-fx', name: fx.name, updated_at: '2026-01-02T00:00:00Z' }];
  const { result, saved, store } = await bulkRun({ list, chats: { 'c-up': up, 'c-fx': fx }, failing: ['up-gone'] });
  assert.ok(saved, 'a ZIP was downloaded');
  assert.strictEqual(result.outcome, 'done');
  assert.strictEqual(result.reason, '');
  assert.deepStrictEqual(result.target, { kind: 'zip', name: saved.name });
  assert.strictEqual(result.saved.chats, 2);
  assert.ok(result.warnings >= 1);
  assert.strictEqual(result.warnings, result.warningList.length);
  assert.strictEqual(result.warningList[0].type, 'upload');
  for (const w of result.warningList) {
    assert.ok(!/\n/.test(w.text), w.text);
    assert.ok(!/https?:\/\//.test(w.text), w.text);
  }
  assert.ok(result.errorFiles.includes('errors.txt'));
  assert.ok(saved.written['Trip_notes/errors.txt'], Object.keys(saved.written).join());
  assert.ok(Date.parse(result.startedAt) <= Date.parse(result.endedAt));
  assert.strictEqual(store.exportRecord['org-1'].warnings, result.warnings);
});

test('a failed chat list resolves outcome failed with the error as reason', async () => {
  const { result, status } = await bulkRun({ listReply: { error: 'HTTP 500' } });
  assert.strictEqual(result.outcome, 'failed');
  assert.match(result.reason, /500/);
  assert.strictEqual(status.className, 'status error');
  assert.deepStrictEqual(result.saved, { chats: 0, artifacts: 0, versions: 0 });
});

test('saveExportRecord keeps the warning count', async () => {
  const { sandbox, fn } = loadPopup();
  const store = {};
  sandbox.chrome.storage.local.get = async () => JSON.parse(JSON.stringify(store));
  sandbox.chrome.storage.local.set = async (o) => { Object.assign(store, JSON.parse(JSON.stringify(o))); };
  await fn('saveExportRecord')('org-1', '2026-11-24T00:00:00Z', [{ uuid: 'a', updated_at: '1' }], [], [], 3);
  assert.strictEqual(store.exportRecord['org-1'].warnings, 3);
  const back = await fn('loadExportRecord')('org-1');
  assert.strictEqual(back.warnings, 3);
});

test('exportArtifacts resolves a RunResult', async () => {
  const LIVE = '1794783850-4a6e';
  const U1 = 'a1a1a1a1-1111-4111-8111-111111111111';
  const U2 = 'b2b2b2b2-1111-4111-8111-111111111111';
  const art = (slug, title) => ({ slug, title, typeSlug: '', typeTitle: '', sourceSurface: 'chat', rel: 'mine', live: LIVE, updatedAt: '2026-11-01T00:00:00Z', createdAt: '2026-10-01T00:00:00Z' });
  const frames = [art(U1, 'One'), art(U2, 'Two')];
  const pages = {
    [U1]: { title: 'One', live: LIVE, versions: { [LIVE]: { files: { 'index.html': '<p>one</p>' } } } },
    [U2]: { title: 'Two', live: LIVE, versions: { [LIVE]: { files: { 'index.html': '<p>two</p>' } } } },
  };
  const { result, saved } = await runArtifacts({ frames, pages, granted: false });
  assert.ok(saved);
  assert.strictEqual(result.outcome, 'done');
  assert.strictEqual(result.saved.artifacts, frames.length);
  assert.ok(result.saved.versions >= frames.length);
  assert.deepStrictEqual(result.target, { kind: 'zip', name: saved.name });
});

test('exportArtifacts resolves failed when the list fails', async () => {
  const { result } = await runArtifacts({ list: { error: 'HTTP 503' } });
  assert.strictEqual(result.outcome, 'failed');
  assert.ok(result.reason);
});

test('Export All counts a failed artifact list as a warning', async () => {
  const fx = Object.assign(loadFixture(), { uuid: 'c-fx' });
  const list = [{ uuid: 'c-fx', name: fx.name, updated_at: '2026-01-02T00:00:00Z' }];
  const { result, store } = await bulkRun({ list, chats: { 'c-fx': fx }, options: { withArtifacts: true } });
  assert.strictEqual(result.outcome, 'done');
  assert.ok(result.warnings >= 1);
  const hit = result.warningList.find((w) => w.type === 'artifact_export');
  assert.ok(hit, JSON.stringify(result.warningList));
  assert.match(hit.text, /^Artifact list could not be loaded \(.+\)$/);
  assert.ok(!/https?:\/\//.test(hit.text));
  assert.strictEqual(store.exportRecord['org-1'].warnings, result.warnings);
});

test('Export Changes with nothing changed still counts a failed artifact list', async () => {
  const list = [{ uuid: 'a', name: 'A', updated_at: '1' }];
  const stored = { exportRecord: { 'org-1': { at: '2026-01-05T00:00:00Z', chats: { a: '1' } } } };
  const { result, saved } = await bulkRun({ list, chats: {}, stored, options: { withArtifacts: true, changesOnly: true } });
  assert.strictEqual(saved, null);
  assert.strictEqual(result.outcome, 'done');
  assert.deepStrictEqual(result.warningList.map((w) => w.type), ['artifact_export']);
});
