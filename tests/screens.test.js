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
const { exportPopup, loadFixture, withUploads, runArtifacts, publishedFetcher, FakeDir } = require('./helpers');

// A ZIP that keeps what is written by path (the fixture's fake blobs can't go through JSZip).
function fakeZip(written = {}, prefix = '') {
  return {
    written,
    file: (name, content) => { written[prefix + name] = content; },
    folder: (name) => fakeZip(written, `${prefix}${name}/`),
    generateAsync: async () => new Blob(['zip']),
  };
}

async function bulkRun({ list, chats, failing = [], options = {}, listReply = null, stored = {}, frames = null, pages = {}, setup = null }) {
  const popup = exportPopup({ failing });
  const sb = popup.sandbox;
  const store = JSON.parse(JSON.stringify(stored));
  sb.chrome.storage.local.get = async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((k) => k in store).map((k) => [k, JSON.parse(JSON.stringify(store[k]))]));
  sb.chrome.storage.local.set = async (o) => { Object.assign(store, JSON.parse(JSON.stringify(o))); };
  sb.chrome.tabs.query = async () => [{ id: 1, url: 'https://claude.ai/chat/x' }];
  const sets = [];
  const plainSet = sb.chrome.storage.local.set;
  sb.chrome.storage.local.set = async (o) => { sets.push(Object.keys(o)); return plainSet(o); };
  const fetcher = publishedFetcher(pages);
  sb.chrome.tabs.sendMessage = (id, msg, cb) => {
    if (msg.action === 'fetchAllConversations') cb(listReply || { data: list, orgId: 'org-1' });
    else if (msg.action === 'fetchConversation') cb({ data: chats[msg.conversationId] });
    else if (msg.action === 'listArtifacts' && frames) cb({ frames: JSON.parse(JSON.stringify(frames)) });
    else if (frames && /^publishedPage/.test(msg.action)) fetcher.fetch(msg).then(cb);
    else cb({ error: 'no' });
  };
  const zip = fakeZip();
  sb.JSZip = function () { return zip; };
  let saved = null;
  sb.download = (blob, name) => { saved = { blob, name, written: zip.written }; };
  sb.setTimeout = (f) => setTimeout(f, 0);
  vm.runInContext('orgId = "org-1"', sb);
  if (setup) setup(sb);
  sb.__opts = { withArtifacts: false, ...options };
  const result = await vm.runInContext('bulkExportZip(__opts)', sb);
  return { result: result && JSON.parse(JSON.stringify(result)), saved, store, sets, zip, status: sb.document.getElementById('status') };
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

// Progress and Stop (Task 3): onProgress events for the Exporting screen, and options.signal to stop.
const P_LIVE = '1794783850-4a6e';
const P_OLD = '1794783000-1b2c';
const P_U = 'c3c3c3c3-1111-4111-8111-111111111111';
const twoChats = () => {
  const a = Object.assign(loadFixture(), { uuid: 'c-a', name: 'Alpha' });
  const b = Object.assign(loadFixture(), { uuid: 'c-b', name: 'Beta' });
  const list = [{ uuid: 'c-a', name: 'Alpha', updated_at: '2026-01-01T00:00:00Z' }, { uuid: 'c-b', name: 'Beta', updated_at: '2026-01-02T00:00:00Z' }];
  return { list, chats: { 'c-a': a, 'c-b': b } };
};
const runFiles = (picked) => {
  const runs = [...picked.entries.values()];
  return runs.length ? runs[runs.length - 1].flat() : {};
};

test('progress events name the phase in order', async () => {
  const { list, chats } = twoChats();
  const frames = [{ slug: P_U, title: 'Report', typeSlug: '', typeTitle: '', sourceSurface: 'chat', rel: 'mine', live: P_LIVE, updatedAt: '2026-11-01T00:00:00Z', createdAt: '2026-10-01T00:00:00Z' }];
  const pages = { [P_U]: { title: 'Report', live: P_LIVE, versions: { [P_OLD]: { files: { 'index.html': '<p>old</p>' } }, [P_LIVE]: { files: { 'index.html': '<p>new</p>' } } } } };
  const events = [];
  const { result } = await bulkRun({ list, chats, frames, pages, options: { withArtifacts: true, onProgress: (e) => events.push(JSON.parse(JSON.stringify(e))) } });
  assert.strictEqual(result.outcome, 'done');
  const phases = events.map((e) => e.phase).filter((p, i, all) => p !== all[i - 1]);
  assert.deepStrictEqual(phases, ['chats', 'artifacts', 'viewer']);
  for (const e of events) {
    assert.deepStrictEqual(Object.keys(e).sort(), ['done', 'phase', 'sub', 'total', 'warnings']);
    assert.ok(Number.isFinite(e.done) && Number.isFinite(e.total) && Number.isFinite(e.warnings), JSON.stringify(e));
    assert.ok(!/https?:\/\/|__frame_t/.test(e.sub), e.sub);
  }
  const chatEvents = events.filter((e) => e.phase === 'chats');
  assert.ok(chatEvents.every((e) => e.total === 2));
  assert.ok(chatEvents.some((e) => e.sub === 'Alpha') && chatEvents.some((e) => e.sub === 'Beta'));
  assert.deepStrictEqual(chatEvents[chatEvents.length - 1].done, 2);
  const versionEvent = events.find((e) => e.phase === 'artifacts' && /· version \d+ of 2$/.test(e.sub));
  assert.ok(versionEvent, JSON.stringify(events));
  assert.match(versionEvent.sub, /^Report · version 1 of 2$/);
  assert.strictEqual(events[events.length - 1].warnings, result.warnings);
});

test('Stop in folder mode keeps files, writes no viewer and no record', async () => {
  const { list, chats } = twoChats();
  const picked = new FakeDir();
  const signal = { stopped: false };
  const onProgress = (e) => { if (e.phase === 'chats' && e.done === 1) signal.stopped = true; };
  const { result, sets, saved } = await bulkRun({ list, chats, options: { changesOnly: true, directory: picked, signal, onProgress } });
  assert.strictEqual(result.outcome, 'stopped');
  assert.strictEqual(result.reason, 'You stopped it');
  assert.strictEqual(result.saved.chats, 1);
  assert.strictEqual(saved, null, 'nothing downloaded');
  const files = runFiles(picked);
  assert.ok(files['Alpha/README.md'], Object.keys(files).join());
  assert.ok(!Object.keys(files).some((n) => n.startsWith('Beta/')), 'the second chat was not started');
  for (const n of ['viewer.html', 'index.md', 'export-manifest.json']) assert.ok(!(n in files), n);
  assert.ok(!sets.some((keys) => keys.includes('exportRecord')), JSON.stringify(sets));
});

test('Stop in ZIP mode downloads nothing', async () => {
  const { list, chats } = twoChats();
  const signal = { stopped: false };
  const onProgress = (e) => { if (e.phase === 'chats' && e.done === 1) signal.stopped = true; };
  const { result, sets, saved } = await bulkRun({ list, chats, options: { changesOnly: true, signal, onProgress } });
  assert.strictEqual(result.outcome, 'stopped');
  assert.strictEqual(saved, null, 'no download');
  assert.deepStrictEqual(result.saved, { chats: 0, artifacts: 0, versions: 0 });
  assert.ok(!sets.some((keys) => keys.includes('exportRecord')));
});

test('an exception mid-run in folder mode reports the chats already written', async () => {
  const { list, chats } = twoChats();
  const picked = new FakeDir();
  const setup = (sb) => vm.runInContext('writeViewer = async () => { throw new Error("boom"); }', sb);
  const { result } = await bulkRun({ list, chats, setup, options: { directory: picked } });
  assert.strictEqual(result.outcome, 'failed');
  assert.match(result.reason, /boom/);
  assert.strictEqual(result.saved.chats, 2);
  assert.ok(runFiles(picked)['Beta/README.md']);
});

test('an exception mid-run in ZIP mode reports nothing saved', async () => {
  const { list, chats } = twoChats();
  const setup = (sb) => vm.runInContext('writeViewer = async () => { throw new Error("boom"); }', sb);
  const { result, saved } = await bulkRun({ list, chats, setup });
  assert.strictEqual(result.outcome, 'failed');
  assert.strictEqual(saved, null);
  assert.deepStrictEqual(result.saved, { chats: 0, artifacts: 0, versions: 0 });
});

test('Export Artifacts reports each version and stops between artifacts', async () => {
  const U1 = 'a1a1a1a1-1111-4111-8111-111111111111';
  const U2 = 'b2b2b2b2-1111-4111-8111-111111111111';
  const art = (slug, title) => ({ slug, title, typeSlug: '', typeTitle: '', sourceSurface: 'chat', rel: 'mine', live: P_LIVE, updatedAt: '2026-11-01T00:00:00Z', createdAt: '2026-10-01T00:00:00Z' });
  const frames = [art(U1, 'One'), art(U2, 'Two')];
  const page = (t) => ({ title: t, live: P_LIVE, versions: { [P_OLD]: { files: { 'index.html': `<p>${t} old</p>` } }, [P_LIVE]: { files: { 'index.html': `<p>${t}</p>` } } } });
  const pages = { [U1]: page('One'), [U2]: page('Two') };
  const events = [];
  const full = await runArtifacts({ frames, pages, granted: false, options: { onProgress: (e) => events.push(JSON.parse(JSON.stringify(e))) } });
  assert.strictEqual(full.result.outcome, 'done');
  const phases = events.map((e) => e.phase).filter((p, i, all) => p !== all[i - 1]);
  assert.deepStrictEqual(phases, ['artifacts', 'viewer']);
  assert.ok(events.some((e) => e.sub === 'Two · version 1 of 2'), JSON.stringify(events));

  const picked = new FakeDir();
  const signal = { stopped: false };
  const onProgress = (e) => { if (e.phase === 'artifacts' && e.done === 1) signal.stopped = true; };
  const stopped = await runArtifacts({ frames, pages, granted: false, options: { directory: picked, signal, onProgress } });
  assert.strictEqual(stopped.result.outcome, 'stopped');
  assert.strictEqual(stopped.result.reason, 'You stopped it');
  assert.strictEqual(stopped.result.saved.artifacts, 1);
  assert.strictEqual(stopped.result.saved.versions, 2);
  const files = runFiles(picked);
  assert.ok(Object.keys(files).some((n) => n.startsWith('One_')), Object.keys(files).join());
  assert.ok(!Object.keys(files).some((n) => n.startsWith('Two_')));
  for (const n of ['viewer.html', 'index.md', 'index.html', 'export-manifest.json']) assert.ok(!(n in files), n);

  const zipSignal = { stopped: false };
  const zipStop = await runArtifacts({ frames, pages, granted: false, options: { signal: zipSignal, onProgress: (e) => { if (e.phase === 'artifacts' && e.done === 1) zipSignal.stopped = true; } } });
  assert.strictEqual(zipStop.result.outcome, 'stopped');
  assert.strictEqual(zipStop.saved, null);
  assert.deepStrictEqual(zipStop.result.saved, { chats: 0, artifacts: 0, versions: 0 });
});

// Panel view-model (Task 4): every sentence the new screens show.
test('formatStamp is local YYYY-MM-DD HH:MM', () => {
  const { fn } = loadPopup();
  const d = new Date(2026, 10, 23, 9, 5);
  assert.strictEqual(fn('formatStamp')(d.toISOString()), '2026-11-23 09:05');
});

test('exportPlan maps the checkboxes to a run', () => {
  const { fn } = loadPopup();
  const plan = fn('exportPlan');
  const j = (o) => JSON.parse(JSON.stringify(o));
  assert.deepStrictEqual(j(plan({ chats: true, artifacts: true, scope: 'changes', hasRecord: true })), { run: 'bulk', changesOnly: true, withArtifacts: true, changesAllowed: true });
  assert.deepStrictEqual(j(plan({ chats: true, artifacts: false, scope: 'all', hasRecord: true })), { run: 'bulk', changesOnly: false, withArtifacts: false, changesAllowed: true });
  assert.deepStrictEqual(j(plan({ chats: true, artifacts: true, scope: 'changes', hasRecord: false })), { run: 'bulk', changesOnly: false, withArtifacts: true, changesAllowed: false });
  assert.deepStrictEqual(j(plan({ chats: false, artifacts: true, scope: 'changes', hasRecord: true })), { run: 'artifacts', changesOnly: false, withArtifacts: true, changesAllowed: false });
  assert.deepStrictEqual(j(plan({ chats: false, artifacts: false, scope: 'all', hasRecord: true })), { run: null, changesOnly: false, withArtifacts: false, changesAllowed: false });
});

test('everythingSummary builds the sentences', () => {
  const { fn } = loadPopup();
  const plan = fn('exportPlan'), sum = fn('everythingSummary');
  const counts = { chats: 27, artifacts: 19, changedChats: 3, changedArtifacts: 2, at: 'x' };
  const base = { since: '2026-11-23 09:51', isPopup: false };
  const all = plan({ chats: true, artifacts: true, scope: 'all', hasRecord: true });
  assert.strictEqual(sum({ ...base, plan: all, counts, format: 'zip' }), '27 chats and 19 artifacts. Everything, whatever was exported before. One ZIP download when it finishes.');
  assert.strictEqual(sum({ ...base, plan: all, counts: null, format: 'folder', isPopup: true }),
    'Everything, whatever was exported before. Into a new folder inside one you pick, written as it goes. From the popup, this continues in the sidebar.');
  assert.strictEqual(sum({ ...base, plan: all, counts: null, format: 'folder' }), 'Everything, whatever was exported before. Into a new folder inside one you pick, written as it goes.');
  const ch = plan({ chats: true, artifacts: true, scope: 'changes', hasRecord: true });
  assert.strictEqual(sum({ ...base, plan: ch, counts, format: 'zip' }),
    '3 changed chats and 2 changed artifacts. Only what changed since the last Export All, 2026-11-23 09:51. One ZIP download when it finishes.');
  // Unticking artifacts drops the artifact count.
  const chatsOnly = plan({ chats: true, artifacts: false, scope: 'all', hasRecord: true });
  assert.ok(!/artifact/.test(sum({ ...base, plan: chatsOnly, counts, format: 'zip' })));
  assert.ok(/^27 chats\./.test(sum({ ...base, plan: chatsOnly, counts, format: 'zip' })));
  // Nothing changed.
  const zero = { ...counts, changedChats: 0, changedArtifacts: 0 };
  assert.ok(sum({ ...base, plan: ch, counts: zero, format: 'zip' }).includes('Nothing changed since 2026-11-23 09:51.'));
  assert.ok(!sum({ ...base, plan: all, counts: zero, format: 'zip' }).includes('Nothing changed'));
  // Artifacts only.
  const art = plan({ chats: false, artifacts: true, scope: 'changes', hasRecord: true });
  assert.ok(sum({ ...base, plan: art, counts, format: 'zip' }).includes('Changes only needs Chats ticked.'));
  const artNoRec = plan({ chats: false, artifacts: true, scope: 'all', hasRecord: false });
  assert.ok(!sum({ ...base, since: '', plan: artNoRec, counts, format: 'zip' }).includes('Changes only needs'));
  assert.ok(sum({ ...base, plan: art, counts, format: 'zip' }).startsWith('19 artifacts.'));
  // Nothing ticked.
  const none = plan({ chats: false, artifacts: false, scope: 'all', hasRecord: true });
  assert.strictEqual(sum({ ...base, plan: none, counts, format: 'zip' }), 'Tick Chats or Artifacts.');
});

test('exportDisabledReason', () => {
  const { fn } = loadPopup();
  const plan = fn('exportPlan'), why = fn('exportDisabledReason');
  const zero = { chats: 5, artifacts: 5, changedChats: 0, changedArtifacts: 0, at: 'x' };
  assert.strictEqual(why(plan({ chats: false, artifacts: false, scope: 'all', hasRecord: true }), null), 'Tick Chats or Artifacts.');
  assert.strictEqual(why(plan({ chats: true, artifacts: true, scope: 'all', hasRecord: true }), zero), '');
  assert.strictEqual(why(plan({ chats: true, artifacts: true, scope: 'changes', hasRecord: true }), null), '');
  assert.strictEqual(why(plan({ chats: true, artifacts: true, scope: 'changes', hasRecord: true }), { ...zero, changedChats: 1 }), '');
  assert.strictEqual(why(plan({ chats: true, artifacts: false, scope: 'changes', hasRecord: true }), { ...zero, changedArtifacts: 4 }, '2026-11-23 09:51'), 'Nothing changed since 2026-11-23 09:51.');
});

test('warningGroups groups by type and caps lines', () => {
  const { fn } = loadPopup();
  const g = fn('warningGroups');
  const j = (o) => JSON.parse(JSON.stringify(o));
  assert.deepStrictEqual(j(g([{ type: 'upload', text: 'a.png', chat: 'Trip notes' }])), { lines: ['1 upload could not be downloaded (Trip notes)'], more: 0 });
  assert.deepStrictEqual(j(g([{ type: 'upload', text: 'a.png' }, { type: 'upload', text: 'b.png' }])), { lines: ['2 uploads could not be downloaded (a.png)'], more: 0 });
  assert.deepStrictEqual(j(g([{ type: 'published_page', text: 'x' }, { type: 'artifact_export', text: 'y' }])), { lines: ['1 artifact problem (x)', '1 artifact problem (y)'], more: 0 });
  assert.deepStrictEqual(j(g([{ type: 'viewer', text: 'v' }, { type: 'viewer', text: 'w' }])), { lines: ['2 viewer warnings (v)'], more: 0 });
  const seven = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((t) => ({ type: t, text: t }));
  const r = j(g(seven));
  assert.strictEqual(r.lines.length, 5);
  assert.strictEqual(r.more, 2);
  assert.deepStrictEqual(j(g([])), { lines: [], more: 0 });
});

test('done screen text and run steps', () => {
  const { fn } = loadPopup();
  const head = fn('doneHeadline'), target = fn('doneTargetText'), steps = fn('runSteps'), plan = fn('exportPlan');
  const j = (o) => JSON.parse(JSON.stringify(o));
  assert.deepStrictEqual(j(head({ warnings: 0 })), { tone: 'ok', text: 'Done' });
  assert.deepStrictEqual(j(head({ warnings: 1 })), { tone: 'warn', text: 'Done, with 1 warning' });
  assert.deepStrictEqual(j(head({ warnings: 3 })), { tone: 'warn', text: 'Done, with 3 warnings' });
  assert.strictEqual(target({ target: { kind: 'folder', name: 'x' } }), 'inside the folder you picked. Open viewer.html in it to browse.');
  assert.strictEqual(target({ target: { kind: 'zip', name: 'a.zip' } }), 'Saved to Downloads as a.zip.');
  const p = (chats, artifacts) => plan({ chats, artifacts, scope: 'all', hasRecord: false });
  assert.deepStrictEqual(j(steps(p(true, true))), ['chats', 'artifacts', 'viewer']);
  assert.deepStrictEqual(j(steps(p(true, false))), ['chats', 'viewer']);
  assert.deepStrictEqual(j(steps(p(false, true))), ['artifacts', 'viewer']);
});
