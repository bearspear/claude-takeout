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

// sessions: the listSessions reply (default: none); sessionPages: { <id>: [page, ...] | (msg) => reply }, a page
// being { events, lastId, hasMore }, picked by the previous page's lastId. asks: every fetchSessionEvents message.
async function bulkRun({ list, chats, failing = [], options = {}, listReply = null, stored = {}, frames = null, pages = {}, setup = null, sessions = null, sessionPages = {} }) {
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
    else if (msg.action === 'listSessions') cb(JSON.parse(JSON.stringify(sessions || { sessions: [], incomplete: false, orgId: 'org-1' })));
    else if (msg.action === 'fetchSessionEvents') {
      asks.push(JSON.parse(JSON.stringify(msg)));
      const got = sessionPages[msg.id];
      if (typeof got === 'function') return void Promise.resolve(got(msg)).then((r) => cb(JSON.parse(JSON.stringify(r))));
      const all = got || [];
      const i = msg.after == null ? 0 : all.findIndex((pg, k) => k > 0 && all[k - 1].lastId === msg.after);
      cb(i >= 0 && all[i] ? JSON.parse(JSON.stringify(all[i])) : { error: 'HTTP 404' });
    }
    else cb({ error: 'no' });
  };
  const asks = [];
  const zip = fakeZip();
  sb.JSZip = function () { return zip; };
  let saved = null;
  sb.download = (blob, name) => { saved = { blob, name, written: zip.written }; };
  sb.setTimeout = (f) => setTimeout(f, 0);
  vm.runInContext('orgId = "org-1"', sb);
  if (setup) setup(sb);
  sb.__opts = { withArtifacts: false, ...options };
  const result = await vm.runInContext('bulkExportZip(__opts)', sb);
  return { result: result && JSON.parse(JSON.stringify(result)), saved, store, sets, zip, asks, sb, status: sb.document.getElementById('status') };
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
  assert.strictEqual(status.textContent, '', 'the run result, not the chat card, says what happened');
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
  assert.deepStrictEqual(j(g([{ type: 'viewer', text: 'v' }, { type: 'viewer', text: 'w' }])), { lines: ['2 viewer problems (v)'], more: 0 });
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
  assert.deepStrictEqual(j(steps(p(true, true))), ['chats', 'artifacts', 'sessions', 'viewer']);
  assert.deepStrictEqual(j(steps(p(true, false))), ['chats', 'sessions', 'viewer']);
  assert.deepStrictEqual(j(steps(p(false, true))), ['artifacts', 'viewer']);
});

// Count on demand (Task 5)
function countSetup(session, stored = {}) {
  const popup = loadPopup({ session });
  const sb = popup.sandbox;
  const sent = [];
  sb.chrome.storage.local.get = async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((k) => k in stored).map((k) => [k, stored[k]]));
  sb.chrome.scripting = { executeScript: async () => {} };
  sb.chrome.tabs.sendMessage = (id, msg, cb) => {
    sent.push(msg.action);
    const reply = msg.action === 'fetchAllConversations'
      ? { data: [{ uuid: 'a', updated_at: '1' }, { uuid: 'b', updated_at: '2' }], orgId: 'o' }
      : msg.action === 'listArtifacts' ? { frames: [{ slug: '11111111-1111-1111-1111-111111111111', title: 'T', live: 'v1' }] } : {};
    if (cb) cb(reply);
  };
  return { ...popup, sent };
}

test('countEverything caches for 10 minutes', async () => {
  const session = {};
  const { fn, sent } = countSetup(session, { exportRecord: { o: { chats: { a: '1' } } } });
  const first = await fn('countEverything')({ org: 'o', tabId: 1, withArtifacts: false });
  assert.strictEqual(first.chats, 2);
  assert.strictEqual(first.changedChats, 1);
  assert.strictEqual(first.artifacts, null);
  assert.strictEqual(first.changedArtifacts, null);
  const second = await fn('countEverything')({ org: 'o', tabId: 1, withArtifacts: false });
  assert.strictEqual(second.at, first.at);
  assert.strictEqual(sent.filter((a) => a === 'fetchAllConversations').length, 1);
  assert.strictEqual((await fn('cachedCounts')('o')).chats, 2);
  assert.strictEqual(await fn('cachedCounts')('other'), null);
});

test('cache older than 10 minutes refetches', async () => {
  const old = new Date(Date.now() - 11 * 60000).toISOString();
  const session = { takeoutCounts: { o: { chats: 9, artifacts: null, changedChats: 9, changedArtifacts: null, at: old } } };
  const { fn, sent } = countSetup(session);
  assert.strictEqual(await fn('cachedCounts')('o'), null);
  const c = await fn('countEverything')({ org: 'o', tabId: 1, withArtifacts: true });
  assert.strictEqual(c.chats, 2);
  assert.strictEqual(c.changedChats, 2);
  assert.strictEqual(c.artifacts, 1);
  assert.strictEqual(c.changedArtifacts, 1);
  assert.deepStrictEqual(sent.sort(), ['fetchAllConversations', 'listArtifacts']);
  assert.strictEqual(session.takeoutCounts.o.chats, 2);
});

test('a cache without artifacts does not serve a count with artifacts', async () => {
  const session = {};
  const { fn, sent } = countSetup(session);
  await fn('countEverything')({ org: 'o', tabId: 1, withArtifacts: false });
  const c = await fn('countEverything')({ org: 'o', tabId: 1, withArtifacts: true });
  assert.strictEqual(c.artifacts, 1);
  assert.strictEqual(sent.filter((a) => a === 'listArtifacts').length, 1);
});

test('a failed list throws a code and is not cached', async () => {
  const session = {};
  const { sandbox, fn } = countSetup(session);
  sandbox.chrome.tabs.sendMessage = (id, msg, cb) => cb({ error: 'HTTP 500' });
  await assert.rejects(fn('countEverything')({ org: 'o', tabId: 1, withArtifacts: false }), /HTTP 500/);
  assert.ok(!session.takeoutCounts);
});

test('requestData never asks for the chat or artifact list', async () => {
  const { sandbox, fn, sent } = countSetup({});
  sandbox.chrome.tabs.query = async () => [{ id: 1, url: 'https://claude.ai/chat/00000000-0000-0000-0000-000000000000' }];
  sandbox.chrome.tabs.sendMessage = (id, msg, cb) => {
    sent.push(msg.action);
    cb(msg.action === 'getOrgId' ? { orgId: 'o' } : { error: 'x' });
  };
  sent.length = 0;
  await fn('requestData')();
  assert.ok(sent.length > 0);
  assert.ok(sent.every((a) => ['getOrgId', 'fetchConversation'].includes(a)), sent.join());
});

// ---- Task 6: the new markup and screens ----
const fs = require('fs');
const path = require('path');
const REPO_DIR = path.resolve(__dirname, '..');
const CHAT_U = 'aaaaaaaa-0000-4000-8000-000000000001';

// A panel over a tab at url: getOrgId answers 'org-1', fetchConversation the chat given. Records tab queries,
// listeners and keydown handlers.
function panelOn(url, { chat = null, stored = {}, location = '/sidepanel.html' } = {}) {
  const seen = { queries: 0, activated: [], keydown: null };
  const store = JSON.parse(JSON.stringify(stored));
  const popup = loadPopup({
    location,
    before: (sb) => {
      sb.chrome.tabs.query = async () => { seen.queries++; return [{ id: 1, url, active: true }]; };
      sb.chrome.tabs.onActivated = { addListener: (f) => seen.activated.push(f) };
      sb.chrome.tabs.sendMessage = (id, msg, cb) => {
        if (msg.action === 'getOrgId') cb({ orgId: 'org-1' });
        else if (msg.action === 'fetchConversation') cb(chat ? { data: JSON.parse(JSON.stringify(chat)) } : { error: 'HTTP 404' });
        else cb({});
      };
      sb.chrome.storage.local.get = async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((k) => k in store).map((k) => [k, JSON.parse(JSON.stringify(store[k]))]));
      sb.chrome.storage.local.set = async (o) => { Object.assign(store, JSON.parse(JSON.stringify(o))); };
      const add = sb.document.addEventListener;
      sb.document.addEventListener = (type, f) => { if (type === 'keydown') seen.keydown = f; return add.call(sb.document, type, f); };
    },
  });
  return { ...popup, seen, store, el: (id) => popup.sandbox.document.getElementById(id) };
}

const NEW_IDS = ['exportZip', 'exportMd', 'exportMdEmbed', 'exportJson', 'refresh', 'status', 'progress', 'progressFill', 'progressText',
  'filenameStyle', 'includeThinking', 'exportCliSessions', 'webImages', 'showShortcuts', 'useSidePanel', 'helpLink',
  'chatCard', 'chatTitle', 'chatMeta', 'countBtn', 'scopeAll', 'scopeChanges', 'pickChats', 'pickArtifacts', 'chatsSub', 'chatCount',
  'artifactCount', 'formatFolder', 'formatZip', 'exportSelected', 'summary', 'lastExport', 'settingsOpen', 'settingsBack', 'runTitle',
  'runTarget', 'runSteps', 'runWarnings', 'stopBtn', 'runStarted', 'doneCard', 'doneSummary', 'doneTarget', 'doneWarnings',
  'doneErrorFiles', 'doneBack', 'doneTook', 'stoppedReason', 'stoppedSaved', 'stoppedFix', 'tryAgain', 'stoppedBack', 'handoffNote', 'handoffDismiss'];
const GONE_IDS = ['settingsToggle', 'settingsPanel', 'settingsClose', 'megaFormat', 'megaZipScope', 'exportAllArtifacts', 'info',
  'exportAllMd', 'exportAllEmbed', 'exportAllZip', 'exportArtifacts', 'exportAllJson'];

test('popup.html and sidepanel.html are identical', () => {
  assert.ok(fs.readFileSync(path.join(REPO_DIR, 'popup.html')).equals(fs.readFileSync(path.join(REPO_DIR, 'sidepanel.html'))));
});

test('the page has the new ids and none of the removed ones', () => {
  const html = fs.readFileSync(path.join(REPO_DIR, 'popup.html'), 'utf8');
  for (const id of NEW_IDS) assert.match(html, new RegExp(`id="${id}"`), id);
  for (const id of GONE_IDS) assert.doesNotMatch(html, new RegExp(`id="${id}"`), id);
  assert.match(html, /<a [^>]*href="https:\/\/github\.com\/bearspear\/claude-takeout#changelog"/);
});

test('no chat: chat buttons disabled, card idle with the spec text', async () => {
  const p = panelOn('https://claude.ai/new');
  await sleep(50);
  for (const id of ['exportZip', 'exportMd', 'exportMdEmbed', 'exportJson']) assert.strictEqual(p.el(id).disabled, true, id);
  assert.strictEqual(p.el('chatCard').dataset.tone, 'idle');
  assert.strictEqual(p.el('chatState').textContent, 'Open a chat to export it');
  assert.strictEqual(p.el('exportSelected').disabled, false);
});

test('not on claude.ai: Export selected disabled too', async () => {
  const p = panelOn('https://example.com/');
  await sleep(50);
  assert.strictEqual(p.el('chatCard').dataset.tone, 'idle');
  assert.strictEqual(p.el('chatState').textContent, 'Open claude.ai to export.');
  assert.strictEqual(p.el('exportZip').disabled, true);
  assert.strictEqual(p.el('exportSelected').disabled, true);
  assert.strictEqual(p.el('countBtn').disabled, true);
});

test('a chat that fails to load shows the grey card with Try again', async () => {
  const p = panelOn(`https://claude.ai/chat/${CHAT_U}`);
  await sleep(50);
  assert.strictEqual(p.el('chatCard').dataset.tone, 'idle');
  assert.strictEqual(p.el('chatState').textContent, "Couldn't load this chat");
  assert.match(p.el('status').textContent, /404/);
  assert.strictEqual(p.el('chatRetry').hidden, false);
});

test('a loaded chat shows the green card', async () => {
  const chat = Object.assign(loadFixture(), { uuid: CHAT_U, name: 'Trip notes' });
  const p = panelOn(`https://claude.ai/chat/${CHAT_U}`, { chat });
  await sleep(50);
  assert.strictEqual(p.el('chatCard').dataset.tone, 'ready');
  assert.strictEqual(p.el('chatState').textContent, 'Ready to export');
  assert.strictEqual(p.el('chatTitle').textContent, 'Trip notes');
  assert.strictEqual(p.el('chatTitle').title, 'Trip notes');
  assert.match(p.el('chatMeta').textContent, /^.+ · \d+ messages? · \d+ files?$/);
  assert.strictEqual(p.el('exportZip').disabled, false);
});

test('a tab change on the Done screen keeps it', async () => {
  const p = panelOn('https://claude.ai/new');
  await sleep(50);
  p.fn('showScreen')('done');
  const before = p.seen.queries;
  p.seen.activated.forEach((f) => f({ tabId: 1 }));
  await sleep(300);
  assert.strictEqual(p.el('screen-done').hidden, false);
  assert.strictEqual(p.el('screen-main').hidden, true);
  assert.strictEqual(p.seen.queries, before, 'no repaint off the main screen');
  await p.el('doneBack').handlers.click();
  await sleep(50);
  assert.strictEqual(p.el('screen-main').hidden, false);
  assert.ok(p.seen.queries > before, 'Back to export runs requestData');
});

test('the Exporting screen disables Refresh and Settings', () => {
  const p = panelOn('https://claude.ai/new');
  p.fn('showScreen')('exporting');
  assert.strictEqual(p.el('refresh').disabled, true);
  assert.strictEqual(p.el('settingsOpen').disabled, true);
  p.fn('showScreen')('main');
  assert.strictEqual(p.el('refresh').disabled, false);
  assert.strictEqual(p.el('settingsOpen').disabled, false);
});

test('Markdown export reports its size in the card', async () => {
  const chat = Object.assign(loadFixture(), { uuid: CHAT_U, name: 'Trip notes' });
  delete chat.project_uuid;
  const p = panelOn(`https://claude.ai/chat/${CHAT_U}`, { chat });
  await sleep(50);
  p.fn('download = () => {}');
  await p.el('exportMd').handlers.click();
  assert.match(p.el('status').textContent, /^Saved Markdown, \d+(\.\d)? (B|KB|MB)$/);
  assert.strictEqual(p.el('chatCard').dataset.tone, 'ready');
});

test('a single-chat failure turns the card red and stays on the main screen', async () => {
  const chat = Object.assign(loadFixture(), { uuid: CHAT_U, name: 'Trip notes' });
  const p = panelOn(`https://claude.ai/chat/${CHAT_U}`, { chat });
  await sleep(50);
  p.sandbox.chrome.tabs.sendMessage = (id, msg, cb) => cb({ error: 'HTTP 500' });
  await p.el('exportJson').handlers.click();
  assert.strictEqual(p.el('chatCard').dataset.tone, 'error');
  assert.match(p.el('status').textContent, /500/);
  assert.strictEqual(p.el('screen-main').hidden, false);
});

test('Alt+A clicks Export selected', () => {
  const p = panelOn('https://claude.ai/new');
  let clicked = 0;
  p.el('exportSelected').click = () => { clicked++; };
  p.seen.keydown({ altKey: true, key: 'A', preventDefault() {} });
  assert.strictEqual(clicked, 1);
});

test('Changes only is hidden with no record', async () => {
  const p = panelOn('https://claude.ai/new');
  await sleep(50);
  assert.strictEqual(p.el('scopeChanges').hidden, true);
  assert.strictEqual(p.el('lastExport').hidden, true);
});

test('with a record, Changes only shows, and is disabled with only Artifacts ticked', async () => {
  const stored = { exportRecord: { 'org-1': { at: '2026-11-23T09:51:00', chats: { a: '1' }, warnings: 2 } } };
  const p = panelOn('https://claude.ai/new', { stored });
  await sleep(50);
  assert.strictEqual(p.el('scopeChanges').hidden, false);
  assert.strictEqual(p.el('scopeChanges').disabled, false);
  assert.strictEqual(p.el('lastExport').hidden, false);
  assert.strictEqual(p.el('lastExport').textContent, 'Last export 2026-11-23 09:51 · 2 warnings');
  p.el('pickChats').checked = false;
  p.el('pickChats').handlers.change({ target: p.el('pickChats') });
  assert.strictEqual(p.el('scopeChanges').disabled, true);
  assert.strictEqual(p.fn('settings.exportAllChats'), false);
  p.el('pickChats').checked = true;
  p.el('pickChats').handlers.change({ target: p.el('pickChats') });
  p.el('pickArtifacts').checked = false;
  p.el('pickArtifacts').handlers.change({ target: p.el('pickArtifacts') });
  assert.strictEqual(p.el('scopeChanges').disabled, false);
  assert.strictEqual(p.el('chatsSub').textContent, 'Pages they published still go in artifacts/');
});

test('the summary follows the choices and Tick Chats or Artifacts disables Export selected', async () => {
  const p = panelOn('https://claude.ai/new');
  await sleep(50);
  assert.strictEqual(p.el('summary').textContent, 'Everything, whatever was exported before. Into a new folder inside one you pick, written as it goes.');
  p.el('formatZip').handlers.click();
  assert.strictEqual(p.fn('settings.megaFormat'), 'zip');
  assert.strictEqual(p.el('summary').textContent, 'Everything, whatever was exported before. One ZIP download when it finishes.');
  for (const id of ['pickChats', 'pickArtifacts']) { p.el(id).checked = false; p.el(id).handlers.change({ target: p.el(id) }); }
  assert.strictEqual(p.el('summary').textContent, 'Tick Chats or Artifacts.');
  assert.strictEqual(p.el('exportSelected').disabled, true);
});

test('Count shows Counting… while it runs, then the counts and Counted HH:MM', async () => {
  const p = panelOn('https://claude.ai/new');
  await sleep(50);
  let release;
  p.sandbox.chrome.tabs.sendMessage = (id, msg, cb) => {
    if (msg.action === 'fetchAllConversations') release = () => cb({ data: [{ uuid: 'a', updated_at: '1' }, { uuid: 'b', updated_at: '1' }] });
    else if (msg.action === 'listArtifacts') cb({ frames: [] });
    else cb({});
  };
  p.sandbox.chrome.storage.session = { get: async () => ({}), set: async () => {} };
  const run = p.el('countBtn').handlers.click();
  await sleep(10);
  assert.strictEqual(p.el('countBtn').textContent, 'Counting…');
  assert.strictEqual(p.el('countBtn').disabled, true);
  release();
  await run;
  assert.match(p.el('countBtn').textContent, /^Counted \d{2}:\d{2}$/);
  assert.strictEqual(p.el('countBtn').disabled, false);
  assert.strictEqual(p.el('chatCount').textContent, '2');
  assert.strictEqual(p.el('artifactCount').textContent, '0');
  assert.match(p.el('summary').textContent, /^2 chats and 0 artifacts\. /);
});

test('a failed count shows its code in the summary', async () => {
  const p = panelOn('https://claude.ai/new');
  await sleep(50);
  p.sandbox.chrome.tabs.sendMessage = (id, msg, cb) => cb({ error: 'HTTP 500', status: 500 });
  p.sandbox.chrome.storage.session = { get: async () => ({}), set: async () => {} };
  await p.el('countBtn').handlers.click();
  assert.match(p.el('summary').textContent, /HTTP 500/);
  assert.strictEqual(p.el('countBtn').textContent, 'Count');
});

test('Export selected runs the plan and shows Done, then Stop and Stopped', async () => {
  const p = panelOn('https://claude.ai/new');
  await sleep(50);
  p.fn("settings.megaFormat = 'zip'");
  const calls = [];
  let progress = null;
  p.sandbox.bulkExportZip = async (o) => {
    calls.push({ changesOnly: o.changesOnly, withArtifacts: o.withArtifacts, directory: o.directory || null });
    o.onProgress({ phase: 'chats', done: 1, total: 2, sub: 'Alpha', warnings: 1 });
    progress = {
      title: p.el('runTitle').textContent, steps: p.el('step-chats').hidden, viewer: p.el('step-viewer').hidden,
      count: p.el('step-chats-count').textContent, sub: p.el('step-chats-sub').textContent, warn: p.el('runWarnings').textContent,
      screen: p.el('screen-exporting').hidden,
    };
    return { outcome: 'done', reason: '', target: { kind: 'zip', name: 'claude-takeout-2026-11-24_1102.zip' }, saved: { chats: 2, artifacts: 3, versions: 5 },
      warnings: 1, warningList: [{ type: 'upload', text: 'x', chat: 'Trip notes' }], errorFiles: ['errors.txt', 'write-errors.txt'], notes: [],
      startedAt: '2026-11-24T11:02:00', endedAt: '2026-11-24T11:06:12' };
  };
  await p.el('exportSelected').handlers.click();
  assert.deepStrictEqual(calls, [{ changesOnly: false, withArtifacts: true, directory: null }]);
  assert.deepStrictEqual(progress, { title: 'Exporting 2 chats and artifacts', steps: false, viewer: false, count: '1 of 2', sub: 'Alpha', warn: '1 warning so far', screen: false });
  assert.strictEqual(p.el('screen-done').hidden, false);
  assert.strictEqual(p.el('doneCard').dataset.tone, 'warn');
  assert.strictEqual(p.el('doneHeadline').textContent, 'Done, with 1 warning');
  assert.strictEqual(p.el('doneSummary').textContent, '2 chats and 3 artifacts (5 versions) saved.');
  assert.strictEqual(p.el('doneWhere').textContent, 'Saved to Downloads as claude-takeout-2026-11-24_1102.zip.');
  assert.strictEqual(p.el('doneErrorFiles').textContent, "What to do about each is in errors.txt in each affected chat's folder in that ZIP.");
  assert.strictEqual(p.el('doneTook').textContent, 'Took 4 min 12 s');

  // Stop sets the signal; the run ends on the Stopped screen.
  p.sandbox.bulkExportZip = async (o) => {
    p.el('stopBtn').handlers.click();
    assert.strictEqual(o.signal.stopped, true);
    return { outcome: 'stopped', reason: 'You stopped it', target: { kind: 'zip', name: '' }, saved: { chats: 0, artifacts: 0, versions: 0 },
      warnings: 0, warningList: [], errorFiles: [], notes: [], startedAt: '2026-11-24T11:02:00', endedAt: '2026-11-24T11:03:00' };
  };
  await p.el('doneBack').handlers.click();
  await p.el('exportSelected').handlers.click();
  assert.strictEqual(p.el('screen-stopped').hidden, false);
  assert.strictEqual(p.el('stoppedReason').textContent, 'You stopped it');
  assert.strictEqual(p.el('stoppedSaved').textContent, 'Nothing was saved. A ZIP is written only when the export finishes.');
});

test('a cancelled folder picker says No folder picked. on the main screen', async () => {
  const p = panelOn('https://claude.ai/new');
  await sleep(50);
  p.sandbox.window.showDirectoryPicker = async () => { const e = new Error('cancel'); e.name = 'AbortError'; throw e; };
  await p.el('exportSelected').handlers.click();
  assert.strictEqual(p.el('screen-main').hidden, false);
  assert.strictEqual(p.el('summary').textContent, 'No folder picked.');
});

// ---- Task 6 review fixes ----

test('the Exporting card names the run folder or ZIP once it is known', async () => {
  const targets = [];
  const { list, chats } = twoChats();
  const { result } = await bulkRun({ list, chats, options: { onTarget: (t) => targets.push(JSON.parse(JSON.stringify(t))) } });
  assert.strictEqual(result.outcome, 'done');
  assert.deepStrictEqual(targets, [{ kind: 'zip', name: result.target.name }]);
  assert.match(result.target.name, /^claude-takeout-.*\.zip$/);
  const disk = await runArtifacts({ frames: [{ slug: P_U, title: 'Report', typeSlug: '', typeTitle: '', sourceSurface: 'chat', rel: 'mine', live: P_LIVE, updatedAt: '2026-11-01T00:00:00Z', createdAt: '2026-10-01T00:00:00Z' }],
    pages: { [P_U]: { title: 'Report', live: P_LIVE, versions: { [P_LIVE]: { files: { 'index.html': '<p>x</p>' } } } } },
    options: { directory: new FakeDir(), onTarget: (t) => targets.push(JSON.parse(JSON.stringify(t))) } });
  assert.deepStrictEqual(targets[1], { kind: 'folder', name: disk.result.target.name });

  const p = panelOn('https://claude.ai/new');
  await sleep(50);
  p.fn("settings.megaFormat = 'zip'");
  let shown = null;
  p.sandbox.bulkExportZip = async (o) => {
    o.onTarget({ kind: 'zip', name: 'claude-takeout-2026-11-24_1102.zip' });
    shown = p.el('runTarget').textContent;
    return { outcome: 'done', reason: '', target: { kind: 'zip', name: 'claude-takeout-2026-11-24_1102.zip' }, saved: { chats: 0, artifacts: 0, versions: 0 },
      warnings: 0, warningList: [], errorFiles: [], notes: [], startedAt: '2026-11-24T11:02:00', endedAt: '2026-11-24T11:02:01' };
  };
  await p.el('exportSelected').handlers.click();
  assert.strictEqual(shown, 'Saving to claude-takeout-2026-11-24_1102.zip');
});

test('popup.html uses only the spec colours', () => {
  const html = fs.readFileSync(path.join(REPO_DIR, 'popup.html'), 'utf8');
  for (const c of ['#2e4a30', '#15803d', '#374151', '#6d28d9', '#9ca3af', '#f9fafb']) assert.ok(!html.includes(c), c);
  assert.doesNotMatch(html, /[^-]color: #d1d5db/);
});

test('Settings opened from Done goes back to Done', async () => {
  const p = panelOn('https://claude.ai/new');
  await sleep(50);
  for (const from of ['done', 'stopped']) {
    p.fn('showScreen')(from);
    p.el('settingsOpen').handlers.click();
    assert.strictEqual(p.el('screen-settings').hidden, false);
    await p.el('settingsBack').handlers.click();
    assert.strictEqual(p.el(`screen-${from}`).hidden, false, from);
    assert.strictEqual(p.el('screen-main').hidden, true, from);
  }
  p.fn('showScreen')('main');
  p.el('settingsOpen').handlers.click();
  await p.el('settingsBack').handlers.click();
  assert.strictEqual(p.el('screen-main').hidden, false);
});

test('not on claude.ai: every Everything control is disabled', async () => {
  const off = panelOn('https://example.com/');
  await sleep(50);
  const ids = ['scopeAll', 'scopeChanges', 'pickChats', 'pickArtifacts', 'formatFolder', 'formatZip', 'exportSelected', 'countBtn'];
  for (const id of ids) assert.strictEqual(off.el(id).disabled, true, id);
  const on = panelOn('https://claude.ai/new');
  await sleep(50);
  for (const id of ['scopeAll', 'pickChats', 'pickArtifacts', 'formatFolder', 'formatZip', 'exportSelected', 'countBtn']) assert.strictEqual(on.el(id).disabled, false, id);
});

// Popup to sidebar handoff (Task 7): the choices travel in the session note, not in a label.
const NOTE_QUERY = (s) => { s.chrome.tabs.query = () => new Promise(() => {}); };

test('popup folder export stores the choices and opens the side panel', async () => {
  const session = {};
  const popup = loadPopup({ location: '/popup.html', session });
  const sb = popup.sandbox;
  let picker = 0;
  let opened = null;
  let noteAtOpen = null;
  let closed = false;
  sb.window.showDirectoryPicker = async () => { picker++; return new FakeDir(); };
  sb.window.close = () => { closed = true; };
  sb.chrome.sidePanel.open = async (o) => { opened = o; noteAtOpen = session.folderExportNote; };
  vm.runInContext("currentTabId = 7; panel.onClaude = true; panel.record = { at: '2026-11-23T09:51:00Z' }; settings.megaFormat = 'folder'; settings.megaZipScope = 'changes'; settings.exportAllChats = true; settings.exportAllArtifacts = false", sb);
  await sb.document.getElementById('exportSelected').handlers.click();
  await sleep(5);
  assert.strictEqual(picker, 0);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(opened)), { tabId: 7 });
  assert.ok(closed);
  assert.ok(noteAtOpen, 'stored before the side panel opens');
  assert.ok(Number.isFinite(noteAtOpen.at));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(noteAtOpen.choices)), { scope: 'changes', chats: true, artifacts: false, format: 'folder' });
  assert.ok(!('button' in noteAtOpen) && !('label' in noteAtOpen));
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'popup.js'), 'utf8');
  assert.ok(!/FOLDER_BUTTON_LABELS|FOLDER_LABEL_RE/.test(src));
});

test('side panel applies stored choices and runs exportArtifacts for artifacts only', async () => {
  const session = { folderExportNote: { at: Date.now(), choices: { scope: 'all', chats: false, artifacts: true, format: 'folder' } } };
  const panelPage = loadPopup({ location: '/sidepanel.html', session, before: NOTE_QUERY });
  const sb = panelPage.sandbox;
  await sleep(20);
  const doc = sb.document;
  assert.ok(!('folderExportNote' in session));
  assert.strictEqual(doc.getElementById('handoffNote').hidden, false);
  assert.strictEqual(doc.getElementById('handoffText').textContent, 'Continued from the popup. Chrome lets only the sidebar pick a folder. Your choices came along: All, artifacts, Folder. Click Export selected to pick where it goes.');
  assert.ok(doc.body.classList.contains('handoff'));
  assert.strictEqual(doc.getElementById('pickChats').checked, false);
  assert.strictEqual(doc.getElementById('pickArtifacts').checked, true);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(vm.runInContext('({ a: settings.exportAllChats, b: settings.exportAllArtifacts, c: settings.megaFormat, d: settings.megaZipScope })', sb))), { a: false, b: true, c: 'folder', d: 'all' });
  const ran = [];
  vm.runInContext("exportArtifacts = async (o) => { globalThis.__ran.push('artifacts'); return runResult({ outcome: 'done', target: { kind: 'folder', name: 'x' } }); }; bulkExportZip = async () => { globalThis.__ran.push('bulk'); return runResult({ outcome: 'done', target: { kind: 'folder', name: 'x' } }); }", sb);
  sb.__ran = ran;
  sb.window.showDirectoryPicker = async () => new FakeDir();
  await doc.getElementById('exportSelected').handlers.click();
  await sleep(10);
  assert.deepStrictEqual(ran, ['artifacts']);
  assert.ok(!doc.body.classList.contains('handoff'), 'the class goes away on the click');
  assert.strictEqual(doc.getElementById('handoffNote').hidden, true);
});

test('Dismiss ends the handoff; chats and artifacts and Changes only read in the note', async () => {
  const session = { folderExportNote: { at: Date.now(), choices: { scope: 'changes', chats: true, artifacts: true, format: 'folder' } } };
  const p = loadPopup({ location: '/sidepanel.html', session, before: NOTE_QUERY });
  await sleep(20);
  const doc = p.sandbox.document;
  assert.match(doc.getElementById('handoffText').textContent, /came along: Changes only, chats and artifacts, Folder\. Click/);
  doc.getElementById('handoffDismiss').handlers.click();
  assert.ok(!doc.body.classList.contains('handoff'));
  assert.strictEqual(doc.getElementById('handoffNote').hidden, true);
});

test('a malformed note is ignored', async () => {
  const bad = [
    { at: Date.now(), button: 'exportSelected', label: 'Export selected' },
    { at: Date.now(), choices: { scope: 'x', chats: true, artifacts: true, format: 'folder' } },
    { at: Date.now(), choices: { scope: 'all', chats: false, artifacts: false, format: 'folder' } },
    { at: Date.now(), choices: { scope: 'all', chats: 'yes', artifacts: true, format: 'folder' } },
    { at: Date.now(), choices: { scope: 'all', chats: true, artifacts: true, format: 'pdf' } },
    { at: Date.now() - 61000, choices: { scope: 'all', chats: true, artifacts: true, format: 'folder' } },
    Date.now(), 'x', null,
  ];
  for (const note of bad) {
    const p = loadPopup({ location: '/sidepanel.html', session: { folderExportNote: note }, before: NOTE_QUERY });
    await sleep(15);
    const doc = p.sandbox.document;
    assert.ok(!doc.body.classList.contains('handoff'), JSON.stringify(note));
    assert.strictEqual(doc.getElementById('handoffText').textContent, '', JSON.stringify(note));
  }
});

test('the handoff CSS folds This chat and rings Export selected', () => {
  const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'popup.html'), 'utf8');
  assert.match(html, /body\.handoff \.this-chat \{ display: none; \}/);
  assert.match(html, /body\.handoff #exportSelected[^{]*\{[^}]*#7c3aed[^}]*0 0 0 4px #ddd6fe/);
  assert.match(html, /id="handoffNote" class="handoff-note"/);
});

// ---- Final review fixes ----

const doneRun = (extra = {}) => ({ outcome: 'done', reason: '', target: { kind: 'zip', name: 'claude-takeout-2026-11-24_1102.zip' }, saved: { chats: 1, artifacts: 0, versions: 0 },
  warnings: 0, warningList: [], errorFiles: [], notes: [], startedAt: '2026-11-24T11:02:00', endedAt: '2026-11-24T11:02:01', ...extra });

test('Count skips the cache on a click', async () => {
  const fresh = new Date().toISOString();
  const session = { takeoutCounts: { o: { chats: 9, artifacts: null, changedChats: 9, changedArtifacts: null, at: fresh } } };
  const { fn, sent } = countSetup(session);
  assert.strictEqual((await fn('countEverything')({ org: 'o', tabId: 1, withArtifacts: false })).chats, 9, 'the cache serves the panel opening');
  assert.strictEqual(sent.length, 0);
  const c = await fn('countEverything')({ org: 'o', tabId: 1, withArtifacts: false, force: true });
  assert.strictEqual(c.chats, 2);
  assert.strictEqual(session.takeoutCounts.o.chats, 2);

  const p = panelOn('https://claude.ai/new');
  await sleep(50);
  const store = { takeoutCounts: { 'org-1': { chats: 9, artifacts: 9, changedChats: 0, changedArtifacts: 0, at: fresh } } };
  p.sandbox.chrome.storage.session = { get: async (k) => (k in store ? { [k]: store[k] } : {}), set: async (o) => { Object.assign(store, o); } };
  const asked = [];
  p.sandbox.chrome.tabs.sendMessage = (id, msg, cb) => {
    asked.push(msg.action);
    if (msg.action === 'fetchAllConversations') cb({ data: [{ uuid: 'a', updated_at: '1' }, { uuid: 'b', updated_at: '1' }] });
    else if (msg.action === 'listArtifacts') cb({ frames: [] });
    else cb({});
  };
  await p.el('countBtn').handlers.click();
  assert.ok(asked.includes('fetchAllConversations'), asked.join());
  assert.strictEqual(p.el('chatCount').textContent, '2');
});

test('a run that ends Done clears the counts and their cache', async () => {
  const p = panelOn('https://claude.ai/new');
  await sleep(50);
  const store = { takeoutCounts: { 'org-1': { chats: 2, artifacts: 0, changedChats: 0, changedArtifacts: 0, at: new Date().toISOString() }, other: { chats: 1, artifacts: null, changedChats: 0, changedArtifacts: null, at: new Date().toISOString() } } };
  p.sandbox.chrome.storage.session = { get: async (k) => (k in store ? { [k]: JSON.parse(JSON.stringify(store[k])) } : {}), set: async (o) => { Object.assign(store, JSON.parse(JSON.stringify(o))); } };
  p.fn("settings.megaFormat = 'zip'");
  p.fn("panel.counts = { chats: 2, artifacts: 0, changedChats: 0, changedArtifacts: 0, at: new Date().toISOString() }");
  p.sandbox.bulkExportZip = async () => doneRun();
  await p.el('exportSelected').handlers.click();
  await sleep(10);
  assert.strictEqual(p.fn('panel.counts'), null);
  assert.ok(!('org-1' in store.takeoutCounts), JSON.stringify(store));
  assert.ok('other' in store.takeoutCounts, 'another org keeps its counts');
});

test('counts older than 10 minutes do not disable Export selected', async () => {
  const stored = { exportRecord: { 'org-1': { at: '2026-11-23T09:51:00', chats: { a: '1' } } } };
  const p = panelOn('https://claude.ai/new', { stored });
  await sleep(50);
  p.fn("settings.megaZipScope = 'changes'");
  p.fn("panel.counts = { chats: 2, artifacts: 0, changedChats: 0, changedArtifacts: 0, at: new Date().toISOString() }");
  p.fn('renderEverything')();
  assert.strictEqual(p.el('exportSelected').disabled, true, 'fresh counts say nothing changed');
  p.fn("panel.counts = { chats: 2, artifacts: 0, changedChats: 0, changedArtifacts: 0, at: new Date(Date.now() - 11 * 60000).toISOString() }");
  p.fn('renderEverything')();
  assert.strictEqual(p.el('exportSelected').disabled, false);
  assert.doesNotMatch(p.el('summary').textContent, /Nothing changed/);
});

test('the viewer step disables Stop and says what it does', async () => {
  for (const format of ['zip', 'folder']) {
    const p = panelOn('https://claude.ai/new');
    await sleep(50);
    p.fn(`settings.megaFormat = '${format}'`);
    p.sandbox.window.showDirectoryPicker = async () => new FakeDir();
    let seen = null;
    p.sandbox.bulkExportZip = async (o) => {
      o.onProgress({ phase: 'chats', done: 1, total: 1, sub: 'Alpha', warnings: 0 });
      const before = p.el('stopBtn').disabled;
      o.onProgress({ phase: 'viewer', done: 0, total: 1, sub: 'Viewer and index', warnings: 0 });
      seen = { before, after: p.el('stopBtn').disabled, sub: p.el('step-viewer-sub').textContent };
      return doneRun({ target: { kind: format, name: 'x' } });
    };
    await p.el('exportSelected').handlers.click();
    assert.deepStrictEqual(seen, { before: false, after: true, sub: format === 'zip' ? 'Compressing…' : 'Writing the viewer…' }, format);
  }
});

test('an open sidebar takes a handoff note written after it loaded', async () => {
  const session = {};
  const listeners = [];
  const p = loadPopup({ location: '/sidepanel.html', session, before: (sb) => {
    NOTE_QUERY(sb);
    sb.chrome.storage.session.onChanged = { addListener: (f) => listeners.push(f) };
  } });
  await sleep(20);
  const doc = p.sandbox.document;
  assert.ok(!doc.body.classList.contains('handoff'));
  assert.ok(listeners.length >= 1, 'listens for a note');
  const note = { at: Date.now(), choices: { scope: 'all', chats: true, artifacts: false, format: 'folder' } };
  session.folderExportNote = note;
  listeners.forEach((f) => f({ folderExportNote: { newValue: note } }, 'session'));
  await sleep(20);
  assert.ok(doc.body.classList.contains('handoff'));
  assert.strictEqual(doc.getElementById('handoffNote').hidden, false);
  assert.ok(!('folderExportNote' in session), 'the note is taken');
  assert.strictEqual(vm.runInContext('settings.exportAllArtifacts', p.sandbox), false);
});

test('after a run the Everything controls follow choices changed meanwhile', async () => {
  const p = panelOn('https://claude.ai/new');
  await sleep(50);
  p.fn("settings.megaFormat = 'zip'");
  p.sandbox.bulkExportZip = async () => {
    for (const id of ['pickChats', 'pickArtifacts']) { p.el(id).checked = false; p.el(id).handlers.change({ target: p.el(id) }); }
    return doneRun();
  };
  await p.el('exportSelected').handlers.click();
  assert.strictEqual(p.el('exportSelected').disabled, true, 'nothing ticked now');
});

test('warningGroups uses plain words for the common types', () => {
  const { fn } = loadPopup();
  const g = fn('warningGroups');
  const line = (type, n = 1) => g(Array.from({ length: n }, () => ({ type, text: 'x' }))).lines[0];
  assert.strictEqual(line('export_health'), '1 chat looks incomplete (x)');
  assert.strictEqual(line('export_health', 2), '2 chats look incomplete (x)');
  assert.strictEqual(line('str_replace_failed', 2), '2 edits could not be replayed (x)');
  assert.strictEqual(line('artifact_opaque_mutation'), "1 file changed by a command the export can't follow (x)");
  assert.strictEqual(line('write', 3), '3 files could not be written (x)');
  assert.strictEqual(line('chat'), '1 chat could not be exported (x)');
  assert.strictEqual(line('viewer'), '1 viewer could not be built (x)');
  assert.strictEqual(line('web_image', 2), '2 web images not saved (x)');
  assert.strictEqual(line('tool_image'), '1 image Claude looked at not saved (x)');
  assert.strictEqual(line('presented_file', 2), '2 files Claude made could not be downloaded (x)');
  assert.strictEqual(line('delivered_file'), '1 file Claude made could not be downloaded (x)');
  assert.strictEqual(line('project_doc', 2), '2 project documents not saved (x)');
  assert.strictEqual(line('doc_diagram', 2), '2 diagrams not included (x)');
  assert.strictEqual(line('claude_doc_unreplayed'), '1 Claude Docs edit not rebuilt (x)');
  assert.strictEqual(line('artifact_basename_collision'), '1 file renamed (x)');
  assert.strictEqual(line('session'), '1 session problem (x)');
  assert.strictEqual(line('session', 2), '2 session problems (x)');
});

test('the web_image hint names the cause, and Settings only for the no-permission warning', () => {
  const c = new (loadPopup().fn('ExportErrorCollector'))('n', 'u');
  const hint = (note) => c._getRecoveryHint('web_image', { note });
  assert.ok(!/Settings/.test(hint('HTTP 403')));
  assert.match(hint('HTTP 403'), /403/);
  assert.match(hint('No permission to fetch images from other sites'), /Settings/);
});

test('Done points Export All at each chat folder for errors.txt', async () => {
  const p = panelOn('https://claude.ai/new');
  await sleep(50);
  const plan = p.fn('exportPlan');
  const bulk = plan({ chats: true, artifacts: true, scope: 'all', hasRecord: false });
  const arts = plan({ chats: false, artifacts: true, scope: 'all', hasRecord: false });
  const show = (pl, errorFiles, kind = 'zip') => {
    p.fn('showDone')(doneRun({ warnings: 1, warningList: [{ type: 'upload', text: 'x' }], errorFiles, target: { kind, name: 'n' } }), pl);
    return p.el('doneErrorFiles').textContent;
  };
  assert.strictEqual(show(bulk, ['errors.txt']), "What to do about each is in errors.txt in each affected chat's folder in that ZIP.");
  assert.strictEqual(show(bulk, ['errors.txt', 'artifacts/errors.txt'], 'folder'), "What to do about each is in errors.txt in each affected chat's folder and in artifacts/errors.txt in that folder.");
  assert.strictEqual(show(bulk, ['artifacts/errors.txt']), 'What to do about each is in artifacts/errors.txt in that ZIP.');
  assert.strictEqual(show(arts, ['errors.txt']), 'What to do about each is in errors.txt in that ZIP.');
});

test('Refresh is disabled on Done and Export stopped', () => {
  const p = panelOn('https://claude.ai/new');
  for (const s of ['done', 'stopped']) {
    p.fn('showScreen')(s);
    assert.strictEqual(p.el('refresh').disabled, true, s);
    assert.strictEqual(p.el('settingsOpen').disabled, false, s);
  }
  p.fn('showScreen')('main');
  assert.strictEqual(p.el('refresh').disabled, false);
});

test('Try again with a cancelled picker runs the refresh it skipped', async () => {
  const p = panelOn('https://claude.ai/new');
  await sleep(50);
  p.fn('showScreen')('stopped');
  p.seen.activated.forEach((f) => f({ tabId: 1 }));
  await sleep(300);
  assert.strictEqual(p.fn('refreshSkipped'), true);
  const before = p.seen.queries;
  p.sandbox.window.showDirectoryPicker = async () => { const e = new Error('cancel'); e.name = 'AbortError'; throw e; };
  await p.el('tryAgain').handlers.click();
  await sleep(20);
  assert.strictEqual(p.el('screen-main').hidden, false);
  assert.ok(p.seen.queries > before, 'the skipped refresh runs');
  assert.strictEqual(p.fn('refreshSkipped'), false);
});

test('an artifacts-only stop does not mention Changes only', () => {
  const { fn } = loadPopup();
  const plan = fn('exportPlan');
  const stopped = (pl) => fn('stoppedSavedText')({ target: { kind: 'folder', name: 'run' }, saved: { chats: 0, artifacts: 2, versions: 3 } }, pl);
  assert.strictEqual(stopped(plan({ chats: false, artifacts: true, scope: 'all', hasRecord: true })), '2 artifacts (3 versions) were saved into run.');
  assert.match(stopped(plan({ chats: true, artifacts: true, scope: 'all', hasRecord: true })), /They are not recorded, so the next Changes only export takes them again\.$/);
});

test('a cancelled picker keeps the handoff note', async () => {
  const session = { folderExportNote: { at: Date.now(), choices: { scope: 'all', chats: true, artifacts: true, format: 'folder' } } };
  const p = loadPopup({ location: '/sidepanel.html', session, before: NOTE_QUERY });
  await sleep(20);
  const doc = p.sandbox.document;
  assert.ok(doc.body.classList.contains('handoff'));
  p.sandbox.window.showDirectoryPicker = async () => { const e = new Error('cancel'); e.name = 'AbortError'; throw e; };
  await doc.getElementById('exportSelected').handlers.click();
  assert.ok(doc.body.classList.contains('handoff'), 'still there after a cancelled picker');
  assert.strictEqual(doc.getElementById('handoffNote').hidden, false);
});

// Notes are shown on the Done screen, never counted (quiet warnings, Task 2).
test('doneNotesLine and doneHeadline: notes are not warnings', () => {
  const { fn } = loadPopup();
  assert.strictEqual(fn('doneNotesLine')({ fileNotes: 0 }), '');
  assert.strictEqual(fn('doneNotesLine')({}), '');
  assert.strictEqual(fn('doneNotesLine')({ fileNotes: 1 }), "1 note about drafts and renamed files is in each chat's README.");
  assert.strictEqual(fn('doneNotesLine')({ fileNotes: 13 }), "13 notes about drafts and renamed files are in each chat's README.");
  const j = (o) => JSON.parse(JSON.stringify(o));
  assert.deepStrictEqual(j(fn('doneHeadline')({ outcome: 'done', warnings: 0, fileNotes: 13 })), j(fn('doneHeadline')({ outcome: 'done', warnings: 0 })));
  assert.strictEqual(fn('runResult')({ fileNotes: 4 }).fileNotes, 4);
  assert.strictEqual(fn('runResult')({}).fileNotes, 0);
});

test('bulkExportZip counts a chat\'s notes in fileNotes, not warnings or errorFiles', async () => {
  const fx = Object.assign(loadFixture(), { uuid: 'c-fx' });
  const list = [{ uuid: 'c-fx', name: fx.name, updated_at: '2026-01-02T00:00:00Z' }];
  const noted = (extra) => (sb) => vm.runInContext(`{ const orig = populateConversationFolder; populateConversationFolder = async (...a) => { const r = await orig(...a); r.errorCollector.warnings.length = 0; r.errorCollector.errors.length = 0; ${extra} return r; }; }`, sb);
  const base = await bulkRun({ list, chats: { 'c-fx': fx }, setup: noted('') });
  const { result, store } = await bulkRun({ list, chats: { 'c-fx': fx }, setup: noted("r.errorCollector.addNote('draft_superseded', 'a.html', 'm'); r.errorCollector.addNote('helper_script', 'b.py', 'm');") });
  assert.strictEqual(result.fileNotes, 2);
  assert.strictEqual(base.result.fileNotes, 0);
  assert.strictEqual(result.warnings, base.result.warnings);
  assert.deepStrictEqual(result.errorFiles, base.result.errorFiles);
  assert.ok(!result.errorFiles.includes('errors.txt'), result.errorFiles.join());
  assert.strictEqual(store.exportRecord['org-1'].warnings, base.result.warnings);
});

test('a single-chat ZIP with notes only reports no errors.txt to point at', async () => {
  const sb = exportPopup().sandbox;
  sb.JSZip = require('../jszip.min.js');
  sb.Uint8Array = Uint8Array;
  sb.URL = { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} };
  const mk = sb.document.createElement;
  sb.document.createElement = (t) => (t === 'a' ? { click() {} } : mk.call(sb.document, t));
  sb.__data = loadFixture();
  const run = (extra) => vm.runInContext(`(async () => { const orig = populateConversationFolder; populateConversationFolder = async (...a) => { const r = await orig(...a); r.errorCollector.warnings.length = 0; r.errorCollector.errors.length = 0; r.errorCollector.addNote('helper_script', 'b.py', 'm'); ${extra} return r; }; try { return await createZipExport(__data); } finally { populateConversationFolder = orig; } })()`, sb);
  const notesOnly = await run('');
  assert.strictEqual(notesOnly.hasErrors, false);
  const withWarning = await run("r.errorCollector.addWarning('upload', 'x', 'm');");
  assert.strictEqual(withWarning.hasErrors, true);
});

// Export All asks the tab for each chat through sendToTab: a tab that lost its content script gets it again, and
// a tab that is gone ends the run instead of failing every chat that is left.
const twoTabChats = () => {
  const a = Object.assign(loadFixture(), { uuid: 'c-a', name: 'Chat A' });
  const b = Object.assign(loadFixture(), { uuid: 'c-b', name: 'Chat B' });
  const list = [{ uuid: 'c-a', name: 'Chat A', updated_at: '2026-01-01T00:00:00Z' }, { uuid: 'c-b', name: 'Chat B', updated_at: '2026-01-02T00:00:00Z' }];
  return { list, chats: { 'c-a': a, 'c-b': b } };
};
// The tab stops answering from the chat numbered from (0 = the first). reinjects: injecting content.js works.
// url: what chrome.tabs.get says the tab shows.
const lostTab = ({ reinjects, from = 0, url = 'https://claude.ai/chat/x' }) => (sb) => {
  const plain = sb.chrome.tabs.sendMessage;
  let injected = false;
  sb.__fetches = 0;
  sb.__injects = 0;
  sb.chrome.tabs.get = async (id) => ({ id, url });
  sb.chrome.scripting = { executeScript: async () => { sb.__injects++; if (!reinjects) throw new Error('No tab with id: 1.'); injected = true; } };
  sb.chrome.tabs.sendMessage = (id, msg, cb) => {
    if (msg.action === 'fetchConversation') {
      sb.__fetches++;
      if (!injected && sb.__fetches > from) {
        sb.chrome.runtime.lastError = { message: 'Could not establish connection. Receiving end does not exist.' };
        cb(undefined);
        sb.chrome.runtime.lastError = null;
        return;
      }
    }
    plain(id, msg, cb);
  };
};

test('Export All re-injects content.js when the tab stopped answering', async () => {
  const { list, chats } = twoTabChats();
  const { result } = await bulkRun({ list, chats, setup: lostTab({ reinjects: true }) });
  assert.strictEqual(result.outcome, 'done', result.reason);
  assert.strictEqual(result.saved.chats, 2);
  assert.ok(!result.warningList.some((w) => w.type === 'chat'), JSON.stringify(result.warningList));
});

const threeTabChats = () => {
  const { list, chats } = twoTabChats();
  chats['c-c'] = Object.assign(loadFixture(), { uuid: 'c-c', name: 'Chat C' });
  list.push({ uuid: 'c-c', name: 'Chat C', updated_at: '2026-01-03T00:00:00Z' });
  return { list, chats };
};

test('Export All keeps what it has when the claude.ai tab is gone, ZIP included, and asks it nothing more', async () => {
  const { list, chats } = threeTabChats();
  let sb = null;
  const { result, store, saved } = await bulkRun({ list, chats, setup: (s) => { sb = s; lostTab({ reinjects: false, from: 1 })(s); } });
  assert.strictEqual(result.outcome, 'done', result.reason);
  assert.ok(saved, 'the ZIP is downloaded with the chat already exported');
  assert.ok(Object.keys(saved.written).some((n) => n.startsWith('Chat_A/')), Object.keys(saved.written).join());
  assert.strictEqual(result.saved.chats, 1);
  assert.strictEqual(sb.__fetches, 2, 'the third chat is never asked for');
  const mine = result.warningList.filter((w) => /claude\.ai tab closed or stopped answering/.test(w.text));
  assert.strictEqual(mine.length, 1, JSON.stringify(result.warningList));
  assert.match(mine[0].text, /2 chats not exported/);
  assert.deepStrictEqual(Object.keys(store.exportRecord['org-1'].chats), ['c-a'], 'only the exported chat is recorded');
  assert.match(saved.written['index.md'], /claude\.ai tab closed or stopped answering/);
});

test('content.js is never injected into a tab that left claude.ai', async () => {
  const { list, chats } = twoTabChats();
  let sb = null;
  const { result } = await bulkRun({ list, chats, setup: (s) => { sb = s; lostTab({ reinjects: true, url: 'https://example.com/' })(s); } });
  assert.strictEqual(sb.__injects, 0);
  assert.strictEqual(sb.__fetches, 1);
  assert.strictEqual(result.saved.chats, 0);
  assert.ok(result.warningList.some((w) => /claude\.ai tab closed or stopped answering/.test(w.text)), JSON.stringify(result.warningList));
});

test('Alt shortcuts take the letter typed, and the key pressed when Option types a symbol', () => {
  const p = panelOn('https://claude.ai/new');
  const clicked = [];
  for (const id of ['exportZip', 'exportMd', 'exportSelected']) p.el(id).click = () => { clicked.push(id); };
  p.seen.keydown({ altKey: true, key: 'Ω', code: 'KeyZ', preventDefault() {} });
  p.seen.keydown({ altKey: true, key: 'µ', code: 'KeyM', preventDefault() {} });
  p.seen.keydown({ altKey: true, key: 'å', code: 'KeyA', preventDefault() {} });
  assert.deepStrictEqual(clicked, ['exportZip', 'exportMd', 'exportSelected']);
  // QWERTZ: the Z key sits where QWERTY has Y; AZERTY: A where QWERTY has Q.
  clicked.length = 0;
  p.seen.keydown({ altKey: true, key: 'z', code: 'KeyY', preventDefault() {} });
  p.seen.keydown({ altKey: true, key: 'y', code: 'KeyZ', preventDefault() {} });
  p.seen.keydown({ altKey: true, key: 'a', code: 'KeyQ', preventDefault() {} });
  assert.deepStrictEqual(clicked, ['exportZip', 'exportSelected']);
});

test('popup ZIP export hands off to the side panel too, with ZIP in the note', async () => {
  const session = {};
  const popup = loadPopup({ location: '/popup.html', session });
  const sb = popup.sandbox;
  let opened = null;
  let noteAtOpen = null;
  const ran = [];
  sb.__ran = ran;
  vm.runInContext("bulkExportZip = async () => { globalThis.__ran.push('bulk'); return runResult({ outcome: 'done', target: { kind: 'zip', name: 'x' } }); }", sb);
  sb.window.showDirectoryPicker = async () => new FakeDir();
  sb.chrome.sidePanel.open = async (o) => { opened = o; noteAtOpen = session.folderExportNote; };
  vm.runInContext("currentTabId = 7; panel.onClaude = true; settings.megaFormat = 'zip'; settings.megaZipScope = 'all'; settings.exportAllChats = true; settings.exportAllArtifacts = true", sb);
  await sb.document.getElementById('exportSelected').handlers.click();
  await sleep(5);
  assert.deepStrictEqual(ran, [], 'nothing runs in the popup, which closes when it loses focus');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(opened)), { tabId: 7 });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(noteAtOpen.choices)), { scope: 'all', chats: true, artifacts: true, format: 'zip' });
});

test('side panel takes a ZIP note and says so', async () => {
  const session = { folderExportNote: { at: Date.now(), choices: { scope: 'all', chats: true, artifacts: false, format: 'zip' } } };
  const p = loadPopup({ location: '/sidepanel.html', session, before: NOTE_QUERY });
  await sleep(20);
  const doc = p.sandbox.document;
  assert.strictEqual(vm.runInContext('settings.megaFormat', p.sandbox), 'zip');
  assert.strictEqual(doc.getElementById('handoffText').textContent, 'Continued from the popup, which closes when you click elsewhere and would stop the export. Your choices came along: All, chats, ZIP. Click Export selected to start.');
});

test('a failed side panel open takes the note back', async () => {
  const session = {};
  const popup = loadPopup({ location: '/popup.html', session });
  const sb = popup.sandbox;
  sb.chrome.sidePanel.open = async () => { throw new Error('no window'); };
  sb.window.showDirectoryPicker = async () => new FakeDir();
  vm.runInContext("currentTabId = 7; panel.onClaude = true; settings.megaFormat = 'folder'; settings.exportAllChats = true; settings.exportAllArtifacts = false", sb);
  await sb.document.getElementById('exportSelected').handlers.click();
  await sleep(5);
  assert.ok(!('folderExportNote' in session), 'a sidebar opened later does not apply it unasked');
});

// One Export selected at a time across the popup and every sidebar (navigator.locks is shared by the extension's pages).
test('Export selected waits for a run in another page', async () => {
  const held = new Set();
  const locks = { request: async (name, opts, cb) => {
    if (held.has(name)) return cb(null);
    held.add(name);
    try { return await cb({ name }); } finally { held.delete(name); }
  } };
  const pages = [0, 1].map(() => panelOn('https://claude.ai/new'));
  let release;
  const ran = [];
  for (const [i, p] of pages.entries()) {
    p.sandbox.navigator = { locks };
    p.sandbox.__ran = ran;
    p.sandbox.__i = i;
    p.fn("settings.megaFormat = 'zip'; settings.exportAllChats = true; settings.exportAllArtifacts = false; panel.onClaude = true");
  }
  await sleep(30);
  pages[0].sandbox.__wait = new Promise((r) => { release = r; });
  for (const p of pages) vm.runInContext("bulkExportZip = async () => { globalThis.__ran.push(__i); if (globalThis.__wait) await globalThis.__wait; return runResult({ outcome: 'done', target: { kind: 'zip', name: 'x' } }); }", p.sandbox);
  const first = vm.runInContext('runSelected()', pages[0].sandbox);
  await sleep(5);
  const second = await vm.runInContext('runSelected()', pages[1].sandbox);
  assert.strictEqual(second, null);
  assert.deepStrictEqual(ran, [0]);
  assert.match(vm.runInContext('panel.flash', pages[1].sandbox), /Another export is running/);
  release();
  await first;
  await vm.runInContext('runSelected()', pages[1].sandbox);
  assert.deepStrictEqual(ran, [0, 1]);
});

// Export All asks for the next chat while it writes the current one, one request at a time.
test('Export All fetches the next chat while it writes the current one', async () => {
  const { list, chats } = threeTabChats();
  const log = [];
  let inFlight = 0, most = 0;
  const { result } = await bulkRun({ list, chats, setup: (sb) => {
    const plain = sb.chrome.tabs.sendMessage;
    sb.chrome.tabs.sendMessage = (id, msg, cb) => {
      if (msg.action !== 'fetchConversation') return plain(id, msg, cb);
      log.push(`fetch ${msg.conversationId}`);
      inFlight++; most = Math.max(most, inFlight);
      setTimeout(() => { inFlight--; plain(id, msg, cb); }, 5);
    };
    sb.__log = log;
    sb.__slow = () => new Promise((r) => setTimeout(r, 30)); // a write takes longer than the gap (0 ms here)
    vm.runInContext(`populateConversationFolder = ((orig) => async (...a) => {
      __log.push('write ' + a[1].uuid); const r = await orig(...a); await __slow(); __log.push('wrote ' + a[1].uuid); return r;
    })(populateConversationFolder)`, sb);
  } });
  assert.strictEqual(result.outcome, 'done', result.reason);
  assert.strictEqual(result.saved.chats, 3);
  assert.ok(log.indexOf('fetch c-b') < log.indexOf('wrote c-a'), log.join(', '));
  assert.ok(log.indexOf('fetch c-c') < log.indexOf('wrote c-b'), log.join(', '));
  assert.strictEqual(most, 1, 'one chat request at a time');
});

// The card's file count replays the chat's files once per version of the chat, not on every refresh.
test('the This chat card counts files once per chat version', async () => {
  const chat = Object.assign(loadFixture(), { uuid: CHAT_U, name: 'Trip notes' });
  const p = panelOn(`https://claude.ai/chat/${CHAT_U}`, { chat });
  await sleep(50);
  p.sandbox.__replays = 0;
  vm.runInContext('extractArtifacts = ((orig) => (...a) => { __replays++; return orig(...a); })(extractArtifacts)', p.sandbox);
  const before = p.el('chatMeta').textContent;
  for (let i = 0; i < 3; i++) vm.runInContext('updateUI(JSON.parse(__chat), "org-1")', Object.assign(p.sandbox, { __chat: JSON.stringify(chat) }));
  assert.strictEqual(p.sandbox.__replays, 0, 'the count from the first load is reused');
  assert.strictEqual(p.el('chatMeta').textContent, before);
  const changed = Object.assign(JSON.parse(JSON.stringify(chat)), { updated_at: '2099-01-01T00:00:00Z' });
  vm.runInContext('updateUI(JSON.parse(__chat), "org-1")', Object.assign(p.sandbox, { __chat: JSON.stringify(changed) }));
  assert.strictEqual(p.sandbox.__replays, 1, 'a changed chat is counted again');
});

// ---- Sessions: record, plan and setting helpers ----
test('changedSessions takes new and changed sessions', () => {
  const { fn } = loadPopup();
  const j = (o) => JSON.parse(JSON.stringify(o));
  const f = fn('changedSessions');
  const a1 = { id: 'cse_a', last_event_at: 't1' }, b1 = { id: 'cse_b', last_event_at: 't1' }, a2 = { id: 'cse_a', last_event_at: 't2' };
  assert.deepStrictEqual(j(f([a1, b1], { cse_a: 't1' })), [b1]);
  assert.deepStrictEqual(j(f([a2], { cse_a: 't1' })), [a2]);
  assert.deepStrictEqual(j(f([a1, b1], undefined)), [a1, b1]);
});

test('sessionsToFetch leaves CLI sessions out unless the setting is on', () => {
  const { fn } = loadPopup();
  const f = fn('sessionsToFetch');
  const list = [{ id: 'cse_a', environment_kind: 'bridge' }, { id: 'cse_b', environment_kind: 'anthropic_cloud' }];
  let r = f(list, { exportCliSessions: false });
  assert.deepStrictEqual([r.fetch.length, r.leftOut], [1, 1]);
  r = f(list, { exportCliSessions: true });
  assert.deepStrictEqual([r.fetch.length, r.leftOut], [2, 0]);
});

test('saveExportRecord keeps sessions and joins them', async () => {
  const { sandbox, fn } = loadPopup();
  const store = { exportRecord: { 'org-1': { at: 'x', chats: {}, sessions: { cse_a: 't1' } } } };
  sandbox.chrome.storage.local.get = async () => JSON.parse(JSON.stringify(store));
  sandbox.chrome.storage.local.set = async (o) => { Object.assign(store, JSON.parse(JSON.stringify(o))); };
  await fn('saveExportRecord')('org-1', 'y', [], [], [], 0, [{ id: 'cse_b', last_event_at: 't2' }]);
  assert.deepStrictEqual(store.exportRecord['org-1'].sessions, { cse_a: 't1', cse_b: 't2' });
  store.exportRecord = { 'org-2': { at: 'x', chats: {} } };
  await fn('saveExportRecord')('org-2', 'y', [{ uuid: 'c', updated_at: '1' }], [], [], 0);
  assert.ok(!('sessions' in store.exportRecord['org-2']));
});

test('savedText and runTitleText name sessions', () => {
  const { fn } = loadPopup();
  const saved = fn('savedText'), title = fn('runTitleText');
  const plan = { run: 'bulk', withArtifacts: true };
  assert.strictEqual(saved({ saved: { chats: 29, sessions: 3, artifacts: 20, versions: 40 } }, plan), '29 chats, 3 sessions and 20 artifacts (40 versions)');
  assert.strictEqual(saved({ saved: { chats: 29, sessions: 0, artifacts: 20, versions: 40 } }, plan), '29 chats and 20 artifacts (40 versions)');
  assert.strictEqual(saved({ saved: { chats: 29, artifacts: 20, versions: 40 } }, plan), '29 chats and 20 artifacts (40 versions)');
  assert.strictEqual(title(plan, { chats: 27, sessions: 1, artifacts: 19 }), 'Exporting 27 chats, 1 session and 19 artifacts');
  assert.strictEqual(title(plan, { chats: 27, artifacts: 19 }), 'Exporting 27 chats and 19 artifacts');
});

test('the Settings switch for CLI sessions saves and loads', async () => {
  const p = panelOn('https://claude.ai/new');
  await sleep(50);
  assert.strictEqual(p.fn('settings.exportCliSessions'), false);
  assert.match(fs.readFileSync(path.join(REPO_DIR, 'popup.html'), 'utf8'), /Their tool output can contain text from your computer\./);
  p.el('exportCliSessions').checked = true;
  p.el('exportCliSessions').handlers.change({ target: p.el('exportCliSessions') });
  await sleep(20);
  assert.strictEqual(p.fn('settings.exportCliSessions'), true);
  assert.strictEqual(p.store.exporterSettings.exportCliSessions, true);
});

// ---- Sessions: Export All writes and records them (runSessionStep) ----
const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]).toString('base64');
const S_COWORK = 'cse_01AbCdEfGhIjKlMnOpQr';
const S_CLI = 'cse_01ZyXwVuTsRqPoNmLkJi';
const S_ART = 'a1a1a1a1-2222-4222-8222-222222222222';
const coworkSession = (over = {}) => ({
  id: S_COWORK, title: 'Panel refresh', status_bucket: 'idle', environment_kind: 'anthropic_cloud',
  config: { origin: 'desktop_app', model: 'claude-test' }, created_at: '2026-11-20T10:00:00Z', updated_at: '2026-11-20T11:00:00Z',
  last_event_at: '2026-11-20T11:00:00Z', external_metadata: { artifacts: [{ artifact_id: S_ART, title: 'Panel', updated_at: '2026-11-20T11:00:00Z' }] }, ...over,
});
const cliSession = (over = {}) => ({ ...coworkSession(), id: S_CLI, title: 'Notebook', environment_kind: 'bridge', config: { origin: 'claude_code_cli' }, external_metadata: { artifacts: [] }, ...over });
const sessionEventsFixture = () => [
  { type: 'user', uuid: 'e1', created_at: '2026-11-20T10:00:01Z', message: { role: 'user', content: [{ type: 'text', text: 'Refresh the panel' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_B64 } }] } },
  { type: 'assistant', uuid: 'e2', created_at: '2026-11-20T10:00:02Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Looking at it.' }, { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }] } },
  { type: 'user', uuid: 'e3', created_at: '2026-11-20T10:00:03Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: 'a.txt' }] }] } },
  { type: 'assistant', uuid: 'e4', created_at: '2026-11-20T10:00:04Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } },
];
const onePage = (events = sessionEventsFixture()) => [{ events, lastId: events[events.length - 1].uuid, hasMore: false }];
const oneChat = () => {
  const fx = Object.assign(loadFixture(), { uuid: 'c-fx' });
  return { list: [{ uuid: 'c-fx', name: fx.name, updated_at: '2026-01-02T00:00:00Z' }], chats: { 'c-fx': fx } };
};
const sessionList = (...sessions) => ({ sessions, incomplete: false, orgId: 'org-1' });
const sessionDir = (written, id = S_COWORK) => {
  const short = id.replace(/^cse_/, '').slice(-12);
  const hit = Object.keys(written).find((n) => n.startsWith('sessions/') && n.split('/')[1].endsWith(`_${short}`));
  return hit ? hit.split('/').slice(0, 2).join('/') : null;
};

test('Export All writes a Cowork session folder', async () => {
  const { list, chats } = oneChat();
  const frames = [{ slug: S_ART, title: 'Panel', typeSlug: '', typeTitle: '', sourceSurface: 'code', rel: 'mine', live: P_LIVE, updatedAt: '2026-11-01T00:00:00Z', createdAt: '2026-10-01T00:00:00Z' }];
  const pages = { [S_ART]: { title: 'Panel', live: P_LIVE, versions: { [P_LIVE]: { files: { 'index.html': '<p>Panel</p>' } } } } };
  const { result, saved, store } = await bulkRun({ list, chats, frames, pages, options: { withArtifacts: true }, sessions: sessionList(coworkSession()), sessionPages: { [S_COWORK]: onePage() } });
  assert.strictEqual(result.outcome, 'done', result.reason);
  assert.strictEqual(result.saved.sessions, 1);
  const w = saved.written;
  const dir = sessionDir(w);
  assert.strictEqual(dir, 'sessions/Panel_refresh_GhIjKlMnOpQr', Object.keys(w).join());
  const json = w[`${dir}/session.json`];
  assert.ok(json && !json.includes(PNG_B64), 'no base64 in session.json');
  const parsed = JSON.parse(json);
  assert.strictEqual(parsed.format, 1);
  assert.strictEqual(parsed.session.id, S_COWORK);
  assert.strictEqual(parsed.events.length, 4);
  assert.ok(w[`${dir}/transcript.md`].startsWith('﻿'), 'transcript.md has a BOM');
  assert.match(w[`${dir}/transcript.md`], /Refresh the panel/);
  assert.ok(w[`${dir}/README.md`].startsWith('﻿'));
  const artFolder = Object.keys(w).find((n) => /^artifacts\/[^/]+\/artifact\.json$/.test(n)).split('/')[1];
  assert.ok(w[`${dir}/README.md`].includes(`](../../artifacts/${encodeURIComponent(artFolder)}/)`), w[`${dir}/README.md`]);
  assert.strictEqual(w[`${dir}/images/1.png`], PNG_B64);
  assert.match(w['index.md'], /## Sessions/);
  assert.ok(w['index.md'].includes(`](${dir}/README.md)`), w['index.md']);
  const manifest = JSON.parse(w['export-manifest.json']);
  assert.deepStrictEqual(manifest.sessions, { listed: 1, leftOut: 0, items: [{ id: S_COWORK, title: 'Panel refresh', folder: dir, last_event_at: '2026-11-20T11:00:00Z' }] });
  assert.deepStrictEqual(store.exportRecord['org-1'].sessions, { [S_COWORK]: '2026-11-20T11:00:00Z' });
  assert.ok(!result.warningList.some((x) => x.type === 'session'), JSON.stringify(result.warningList));
});

test('a CLI session is left out unless the setting is on', async () => {
  const { list, chats } = oneChat();
  const sessions = sessionList(coworkSession(), cliSession());
  const sessionPages = { [S_COWORK]: onePage(), [S_CLI]: onePage() };
  const off = await bulkRun({ list, chats, sessions, sessionPages });
  assert.deepStrictEqual(off.asks.map((m) => m.id), [S_COWORK], 'no events request for the CLI session');
  assert.match(off.saved.written['index.md'], /CLI sessions not exported: 1 \(Settings, Include Claude Code CLI sessions\)/);
  assert.strictEqual(off.result.saved.sessions, 1);
  assert.strictEqual(sessionDir(off.saved.written, S_CLI), null);
  assert.strictEqual(JSON.parse(off.saved.written['export-manifest.json']).sessions.leftOut, 1);
  const on = await bulkRun({ list, chats, sessions, sessionPages, setup: (sb) => vm.runInContext('settings.exportCliSessions = true', sb) });
  assert.deepStrictEqual(on.asks.map((m) => m.id).sort(), [S_COWORK, S_CLI].sort());
  assert.ok(sessionDir(on.saved.written, S_CLI));
  assert.doesNotMatch(on.saved.written['index.md'], /CLI sessions not exported/);
  assert.strictEqual(on.result.saved.sessions, 2);
});

test('Changes only exports a session-only change', async () => {
  const { list, chats } = oneChat();
  const stored = { exportRecord: { 'org-1': { at: '2026-11-01T00:00:00Z', chats: { 'c-fx': list[0].updated_at }, sessions: { [S_COWORK]: '2026-11-10T00:00:00Z', [S_CLI]: '2026-11-20T11:00:00Z' } } } };
  // The harness has no viewer assets: writeViewer is stood in for, and says what it was given.
  const viewerCalls = [];
  const fakeViewer = (sb) => {
    sb.__viewer = (chats, opts) => { viewerCalls.push({ chats: chats.length, sessions: (opts.sessions || []).length }); };
    vm.runInContext('writeViewer = async (zip, chats, opts) => { __viewer(chats, opts); zip.file("viewer.html", "<html>"); return true; }', sb);
  };
  const { result, saved, store, asks } = await bulkRun({ list, chats, stored, setup: fakeViewer, options: { changesOnly: true }, sessions: sessionList(coworkSession()), sessionPages: { [S_COWORK]: onePage() } });
  assert.strictEqual(result.outcome, 'done', result.reason);
  assert.deepStrictEqual(viewerCalls, [{ chats: 0, sessions: 1 }]);
  assert.ok(!result.warningList.some((w) => w.type === 'viewer'), JSON.stringify(result.warningList));
  assert.ok(saved, 'a ZIP was made');
  assert.strictEqual(result.saved.chats, 0);
  assert.strictEqual(result.saved.sessions, 1);
  assert.strictEqual(asks.length, 1);
  assert.ok(sessionDir(saved.written));
  assert.ok(saved.written['viewer.html'], Object.keys(saved.written).join());
  assert.strictEqual(store.exportRecord['org-1'].sessions[S_COWORK], '2026-11-20T11:00:00Z');
  assert.strictEqual(store.exportRecord['org-1'].chats['c-fx'], list[0].updated_at, 'the chats stay recorded');

  const same = await bulkRun({ list, chats, stored: store, options: { changesOnly: true }, sessions: sessionList(coworkSession()), sessionPages: { [S_COWORK]: onePage() } });
  assert.strictEqual(same.saved, null, 'nothing changed: no ZIP');
  assert.strictEqual(same.asks.length, 0);
  assert.ok(same.result.notes.some((n) => /^Nothing changed since/.test(n)));
});

test('a failed session list is one warning and the chats export', async () => {
  const { list, chats } = oneChat();
  const { result, saved, asks } = await bulkRun({ list, chats, sessions: { error: 'HTTP 403' } });
  assert.strictEqual(result.outcome, 'done', result.reason);
  assert.strictEqual(result.saved.chats, 1);
  const mine = result.warningList.filter((w) => w.type === 'session');
  assert.strictEqual(mine.length, 1, JSON.stringify(result.warningList));
  assert.match(mine[0].text, /HTTP 403/);
  assert.strictEqual(asks.length, 0);
  assert.match(saved.written['index.md'], /Sessions: not exported \(HTTP 403\)/);
  assert.ok(!Object.keys(saved.written).some((n) => n.startsWith('sessions/')));
});

test('a session list that may be incomplete is warned', async () => {
  const { list, chats } = oneChat();
  const { result, saved } = await bulkRun({ list, chats, sessions: { ...sessionList(coworkSession()), incomplete: true }, sessionPages: { [S_COWORK]: onePage() } });
  const mine = result.warningList.filter((w) => w.type === 'session');
  assert.strictEqual(mine.length, 1, JSON.stringify(result.warningList));
  assert.match(mine[0].text, /session list may be incomplete/i);
  assert.ok(sessionDir(saved.written));
  assert.strictEqual(result.saved.sessions, 1);
});

test('a session over 100 pages is warned and not recorded', async () => {
  const { list, chats } = oneChat();
  const endless = (msg) => {
    const n = msg.after ? Number(msg.after.slice(1)) + 1 : 1;
    return { events: [{ type: 'assistant', uuid: `p${n}`, created_at: '2026-11-20T10:00:00Z', message: { role: 'assistant', content: [{ type: 'text', text: `page ${n}` }] } }], lastId: `p${n}`, hasMore: true };
  };
  const { result, saved, store, asks } = await bulkRun({ list, chats, sessions: sessionList(coworkSession()), sessionPages: { [S_COWORK]: endless } });
  assert.strictEqual(asks.length, 100);
  const mine = result.warningList.filter((w) => w.type === 'session');
  assert.strictEqual(mine.length, 1, JSON.stringify(result.warningList));
  assert.match(mine[0].text, /100 pages/);
  const dir = sessionDir(saved.written);
  assert.ok(dir, 'saved as far as it got');
  assert.strictEqual(JSON.parse(saved.written[`${dir}/session.json`]).events.length, 100);
  assert.ok(!(store.exportRecord['org-1'].sessions || {})[S_COWORK], 'not recorded');
});

test('session pages that do not advance stop with a warning', async () => {
  const { list, chats } = oneChat();
  for (const lastId of [null, 'same']) {
    const stuck = (msg) => ({ events: [{ type: 'assistant', uuid: 'x', created_at: '2026-11-20T10:00:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } }], lastId: lastId === 'same' ? 'x' : null, hasMore: true });
    const { result, store, asks } = await bulkRun({ list, chats, sessions: sessionList(coworkSession()), sessionPages: { [S_COWORK]: stuck } });
    assert.ok(asks.length <= 2, `${lastId}: ${asks.length} requests`);
    assert.strictEqual(result.warningList.filter((w) => w.type === 'session').length, 1, JSON.stringify(result.warningList));
    assert.ok(!(store.exportRecord['org-1'].sessions || {})[S_COWORK]);
  }
});

test('Stop during sessions records none', async () => {
  const { list, chats } = oneChat();
  const two = sessionList(coworkSession(), coworkSession({ id: 'cse_01SecondSessionXyz', title: 'Second' }));
  const picked = new FakeDir();
  const signal = { stopped: false };
  const onProgress = (e) => { if (e.phase === 'sessions' && e.done === 1) signal.stopped = true; };
  const { result, sets, asks } = await bulkRun({ list, chats, sessions: two, sessionPages: { [S_COWORK]: onePage(), cse_01SecondSessionXyz: onePage() }, options: { directory: picked, signal, onProgress } });
  assert.strictEqual(result.outcome, 'stopped');
  assert.strictEqual(result.saved.sessions, 1);
  assert.strictEqual(asks.length, 1, 'the second session is not asked for');
  const files = runFiles(picked);
  assert.ok(sessionDir(files), Object.keys(files).join());
  for (const n of ['viewer.html', 'index.md', 'export-manifest.json']) assert.ok(!(n in files), n);
  assert.ok(!sets.some((keys) => keys.includes('exportRecord')), JSON.stringify(sets));

  const zipSignal = { stopped: false };
  const zipped = await bulkRun({ list, chats, sessions: two, sessionPages: { [S_COWORK]: onePage(), cse_01SecondSessionXyz: onePage() },
    options: { signal: zipSignal, onProgress: (e) => { if (e.phase === 'sessions' && e.done === 1) zipSignal.stopped = true; } } });
  assert.strictEqual(zipped.result.outcome, 'stopped');
  assert.strictEqual(zipped.result.saved.sessions, 0);
  assert.strictEqual(zipped.saved, null);
});

test('a gone tab skips sessions', async () => {
  const { list, chats } = threeTabChats();
  const { result, asks } = await bulkRun({ list, chats, sessions: sessionList(coworkSession()), sessionPages: { [S_COWORK]: onePage() }, setup: lostTab({ reinjects: false, from: 1 }) });
  assert.strictEqual(result.outcome, 'done', result.reason);
  assert.strictEqual(asks.length, 0);
  const mine = result.warningList.filter((w) => /claude\.ai tab closed or stopped answering/.test(w.text));
  assert.strictEqual(mine.length, 1);
  assert.match(mine[0].text, /, and no sessions$/);
});

test('a chat titled "sessions" gets sessions_2', async () => {
  const fx = Object.assign(loadFixture(), { uuid: 'c-s', name: 'sessions' });
  const list = [{ uuid: 'c-s', name: 'sessions', updated_at: '2026-01-02T00:00:00Z' }];
  const { saved } = await bulkRun({ list, chats: { 'c-s': fx }, sessions: sessionList(coworkSession()), sessionPages: { [S_COWORK]: onePage() } });
  assert.ok(saved.written['sessions_2/README.md'], Object.keys(saved.written).join());
  assert.ok(sessionDir(saved.written));
});

test('session folders are claimed apart without case', async () => {
  const { list, chats } = oneChat();
  const a = coworkSession({ title: 'Same' });
  const b = coworkSession({ id: 'cse_99AbCdEfGhIjKlMnOpQr', title: 'SAME' });  // the same short id, other case of title
  const { saved } = await bulkRun({ list, chats, sessions: sessionList(a, b), sessionPages: { [a.id]: onePage(), [b.id]: onePage() } });
  const dirs = [...new Set(Object.keys(saved.written).filter((n) => n.startsWith('sessions/')).map((n) => n.split('/')[1]))];
  assert.deepStrictEqual(dirs.sort(), ['SAME_GhIjKlMnOpQr_2', 'Same_GhIjKlMnOpQr'].sort());
});

test('session folders are flushed one by one in folder mode', async () => {
  const { list, chats } = oneChat();
  const second = 'cse_01SecondSessionXyz';
  const picked = new FakeDir();
  let seenFirst = null;
  const sessionPages = {
    [S_COWORK]: onePage(),
    [second]: () => { seenFirst = Object.keys(runFiles(picked)).some((n) => /^sessions\/Panel_refresh_[^/]+\/transcript\.md$/.test(n)); return onePage()[0]; },
  };
  let flushes = 0;
  const { result } = await bulkRun({ list, chats, sessions: sessionList(coworkSession(), coworkSession({ id: second, title: 'Second' })), sessionPages,
    options: { directory: picked }, setup: (sb) => {
      sb.__flushed = () => { flushes++; };
      vm.runInContext(`createDiskFolder = ((orig) => (h) => { const v = orig(h); const f = v.flush; v.flush = async () => { __flushed(); return f(); }; return v; })(createDiskFolder)`, sb);
    } });
  assert.strictEqual(result.outcome, 'done', result.reason);
  assert.strictEqual(seenFirst, true, 'the first session is on disk before the second is asked for');
  assert.ok(flushes >= 2, `${flushes} flushes`);
  assert.strictEqual(result.saved.sessions, 2);
});

test('the sessions step is done after the viewer step starts, also with no sessions', () => {
  const p = panelOn('https://claude.ai/new');
  const states = {};
  p.sandbox.__state = (name, state) => { states[name] = state; };
  vm.runInContext('setStep = (name, state) => __state(name, state)', p.sandbox);
  p.el('step-sessions').hidden = true;
  p.fn('beginRunScreen')({ run: 'bulk', withArtifacts: false, changesOnly: false }, null);
  assert.strictEqual(p.el('step-sessions').hidden, false);
  assert.strictEqual(states.sessions, 'pending');
  p.fn('runProgress')({ phase: 'chats', done: 1, total: 1, sub: 'A', warnings: 0 });
  p.fn('runProgress')({ phase: 'viewer', done: 0, total: 1, sub: '', warnings: 0 });
  assert.strictEqual(states.sessions, 'done');
});

test('runSessionStep skips the sessions past the ZIP budget with one warning', async () => {
  const { sandbox } = exportPopup();
  const written = {};
  const root = fakeZip(written);
  const a = coworkSession({ title: 'First' });
  const b = coworkSession({ id: 'cse_01SecondSessionXyz', title: 'Second' });
  const c = coworkSession({ id: 'cse_01ThirdSessionXyzA', title: 'Third' });
  const page = onePage()[0];
  const size = page.events.reduce((n, e) => n + Buffer.byteLength(JSON.stringify(e)), 0);
  sandbox.__args = { sessions: [a, b, c], budget: size + 10, fetchPage: async () => JSON.parse(JSON.stringify(page)) };
  sandbox.__root = root;
  const out = JSON.parse(JSON.stringify(await vm.runInContext('runSessionStep(__root, __args)', sandbox)));
  assert.strictEqual(out.written, 1);
  assert.deepStrictEqual(out.saved.map((x) => x.id), [a.id]);
  assert.strictEqual(out.warnings.length, 1, out.warnings.join('\n'));
  assert.match(out.warnings[0], /256 MB was reached: 2 sessions not exported/);
  assert.ok(!Object.keys(written).some((n) => n.includes('Second')));
});

test('runSessionStep keeps a session whose later page fails, warned and not recorded', async () => {
  const { sandbox } = exportPopup();
  const written = {};
  const first = { ...onePage()[0], hasMore: true, lastId: 'e4' };
  sandbox.__args = { sessions: [coworkSession()], fetchPage: async (id, after) => (after ? { error: 'HTTP 500' } : JSON.parse(JSON.stringify(first))) };
  sandbox.__root = fakeZip(written);
  const out = JSON.parse(JSON.stringify(await vm.runInContext('runSessionStep(__root, __args)', sandbox)));
  assert.strictEqual(out.written, 1);
  assert.deepStrictEqual(out.saved, []);
  assert.match(out.warnings.join('\n'), /events could not be loaded \(HTTP 500\); saved as far as it got/);
  const readme = Object.entries(written).find(([n]) => n.endsWith('/README.md'))[1];
  assert.match(readme, /\*\*Incomplete:\*\*/);
});

test('changedSessions takes a session without last_event_at the first time', () => {
  const { fn } = loadPopup();
  const f = fn('changedSessions');
  const x = { id: 'cse_a', updated_at: 'u1' };
  assert.strictEqual(f([x], { cse_b: 't' }).length, 1, 'not in the record: changed');
  assert.strictEqual(f([x], { cse_a: 'u1' }).length, 0, 'recorded by its updated_at: unchanged');
  assert.strictEqual(f([{ id: 'cse_a', created_at: 'c1' }], { cse_a: 'u1' }).length, 1);
});

test('a session without last_event_at is recorded with its updated_at', async () => {
  const { list, chats } = oneChat();
  const s = coworkSession();
  delete s.last_event_at;
  const { store } = await bulkRun({ list, chats, sessions: sessionList(s), sessionPages: { [S_COWORK]: onePage() } });
  assert.deepStrictEqual(store.exportRecord['org-1'].sessions, { [S_COWORK]: s.updated_at });
});
