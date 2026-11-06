// Archive finder and added-file scanner (tools/archive-lib.js). Synthetic fixtures only.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { findArchives, scanAdded, isGeneratedViewer, chatFromDisk, matchFile, KNOWN_ROOT_FILES, KNOWN_DIRS, IGNORED_NAMES } = require('../tools/archive-lib.js');
const { textBlob, projectResponses, exportPopup, runFolder, withUploads, oneMessage } = require('./helpers');

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'archive-test-'));
const put = (root, rel, text = 'x') => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};
const CHAT = JSON.stringify({ uuid: 'u', chat_messages: [] });
const find = (root, exclude = []) => findArchives(root, { exclude });
const byRoot = (res, root) => res.archives.find(a => a.root === root);

test('constants cover the export layout', () => {
  for (const f of ['README.md', 'meta.md', 'original.json', 'index.md', 'viewer.html', 'viewer-check.gif']) assert.ok(KNOWN_ROOT_FILES.includes(f), f);
  for (const d of ['responses', 'artefacts', 'attachments', 'uploads', 'project', 'projects', 'viewer-files']) assert.ok(KNOWN_DIRS.includes(d), d);
  for (const n of ['.DS_Store', 'Thumbs.db', '__MACOSX', '.git', 'node_modules']) assert.ok(IGNORED_NAMES.includes(n), n);
});

test('finds a single, a mega with a renamed chat folder, and a parent of two singles', () => {
  const tmp = tmpRoot();
  put(tmp, 'single/original.json', CHAT);
  put(tmp, 'mega/index.md');
  put(tmp, 'mega/renamed folder/original.json', CHAT);
  put(tmp, 'mega/other/original.json', CHAT);
  put(tmp, 'parent/a/original.json', CHAT);
  put(tmp, 'parent/b/original.json', CHAT);
  const res = find(tmp);
  assert.strictEqual(res.archives.length, 4);
  assert.strictEqual(res.archives.filter(a => a.kind === 'mega').length, 1);
  const mega = byRoot(res, path.join(tmp, 'mega'));
  assert.deepStrictEqual(mega.chats.map(c => c.relDir), ['other', 'renamed folder']);
  assert.strictEqual(mega.chats[1].dir, path.join(tmp, 'mega', 'renamed folder'));
  const single = byRoot(res, path.join(tmp, 'single'));
  assert.strictEqual(single.kind, 'single');
  assert.strictEqual(single.chats.length, 1);
  assert.strictEqual(single.hasViewer, false);
  assert.ok(!res.archives.some(a => a.root === path.join(tmp, 'parent')));
});

test('index.md without chat subfolders is not a mega; the root itself can be an archive', () => {
  const tmp = tmpRoot();
  put(tmp, 'index.md');
  put(tmp, 'original.json', CHAT);
  const res = find(tmp);
  assert.strictEqual(res.archives.length, 1);
  assert.strictEqual(res.archives[0].kind, 'single');
  assert.strictEqual(res.archives[0].root, tmp);
});

test('hasViewer reflects viewer.html at the archive root', () => {
  const tmp = tmpRoot();
  put(tmp, 'a/original.json', CHAT);
  put(tmp, 'a/viewer.html', '<html></html>');
  assert.strictEqual(find(tmp).archives[0].hasViewer, true);
});

test('does not look for archives inside an archive', () => {
  const tmp = tmpRoot();
  put(tmp, 'single/original.json', CHAT);
  const before = find(tmp).archives.length;
  put(tmp, 'single/synthesis/old-copy/original.json', CHAT);
  put(tmp, 'single/uploads/deep/original.json', CHAT);
  const res = find(tmp);
  assert.strictEqual(res.archives.length, before);
  assert.deepStrictEqual(res.skipped, []);
});

test('ignored names are not descended into', () => {
  const tmp = tmpRoot();
  put(tmp, 'node_modules/x/original.json', CHAT);
  put(tmp, '.hidden/x/original.json', CHAT);
  put(tmp, '__MACOSX/x/original.json', CHAT);
  assert.strictEqual(find(tmp).archives.length, 0);
});

test('exclude skips a folder and everything under it, silently', () => {
  const tmp = tmpRoot();
  put(tmp, 'single/original.json', CHAT);
  put(tmp, 'out/copy/original.json', CHAT);
  put(tmp, 'out/old.zip', 'z');
  const res = find(tmp, [path.join(tmp, 'out')]);
  assert.ok(!res.archives.some(a => a.root.startsWith(path.join(tmp, 'out'))));
  assert.strictEqual(res.archives.length, 1);
  assert.deepStrictEqual(res.zips, []);
  assert.deepStrictEqual(res.skipped, []);
});

test('exclude compares resolved real paths', () => {
  const tmp = tmpRoot();
  put(tmp, 'out/copy/original.json', CHAT);
  put(tmp, 'keep/original.json', CHAT);
  const res = find(tmp, [path.join(tmp, 'keep', '..', 'out')]);
  assert.deepStrictEqual(res.archives.map(a => a.root), [path.join(tmp, 'keep')]);
  const link = path.join(os.tmpdir(), path.basename(tmp) + '-link');
  fs.symlinkSync(tmp, link);
  try {
    const viaLink = find(tmp, [path.join(link, 'out')]);
    assert.deepStrictEqual(viaLink.archives.map(a => a.root), [path.join(tmp, 'keep')]);
  } finally { fs.unlinkSync(link); }
});

test('symlinks are not followed', () => {
  const tmp = tmpRoot();
  put(tmp, 'single/original.json', CHAT);
  put(tmp, 'single/_index.md');
  fs.symlinkSync(tmp, path.join(tmp, 'single', 'loop'));
  fs.symlinkSync(tmp, path.join(tmp, 'loop2'));
  const res = find(tmp);
  assert.strictEqual(res.archives.length, 1);
  const added = scanAdded(res.archives[0]).files;
  assert.ok(!added.some(f => f.path.startsWith('loop')));
  assert.deepStrictEqual(added.map(f => f.path), ['_index.md']);
});

test('a non-Claude folder is skipped and reported', () => {
  const tmp = tmpRoot();
  put(tmp, 'gem/original.json', CHAT);
  put(tmp, 'gem/conversation.json', '{}');
  put(tmp, 'plain/original.json', JSON.stringify({ title: 'x' }));
  const res = find(tmp);
  assert.strictEqual(res.archives.length, 0);
  assert.deepStrictEqual(res.skipped.map(s => s.reason), ['not a Claude chat', 'not a Claude chat']);
  assert.deepStrictEqual(res.skipped.map(s => s.path).sort(), [path.join(tmp, 'gem'), path.join(tmp, 'plain')]);
});

test('invalid or unclassifiable original.json still counts as a chat', () => {
  const tmp = tmpRoot();
  put(tmp, 'trunc/original.json', '{"chat_messages": [{"uuid"');
  put(tmp, 'big/original.json', '{"pad":"' + 'a'.repeat(200 * 1024) + '","chat_messages":[]}');
  put(tmp, 'empty/original.json', '');
  const res = find(tmp);
  assert.deepStrictEqual(res.archives.map(a => path.basename(a.root)).sort(), ['big', 'empty', 'trunc']);
  assert.deepStrictEqual(res.skipped, []);
});

test('zips outside archives are listed; zips inside archives are not', () => {
  const tmp = tmpRoot();
  put(tmp, 'single/original.json', CHAT);
  put(tmp, 'single/loose.zip', 'z');
  put(tmp, 'elsewhere/export.ZIP', 'z');
  put(tmp, 'top.zip', 'z');
  const res = find(tmp);
  assert.deepStrictEqual(res.zips.sort(), [path.join(tmp, 'elsewhere', 'export.ZIP'), path.join(tmp, 'top.zip')]);
  assert.deepStrictEqual(scanAdded(res.archives[0]).files.map(f => f.path), ['loose.zip']);
});

test('scanAdded lists files outside the export layout', () => {
  const tmp = tmpRoot();
  const s = path.join(tmp, 'single');
  put(s, 'original.json', CHAT);
  for (const f of ['README.md', 'meta.md', 'full_chat.md', 'viewer.html', 'viewer-check.gif', '.DS_Store']) put(s, f);
  put(s, 'uploads/p01_a.pdf');
  put(s, 'uploads/stray/deep.txt');
  put(s, 'viewer-files/x.bin');
  put(s, 'synthesis/a.md', 'hello');
  put(s, 'synthesis/.DS_Store');
  put(s, 'synthesis/Thumbs.db');
  put(s, '_index.md');
  const added = scanAdded(find(tmp).archives[0]).files;
  assert.deepStrictEqual(added.map(f => f.path), ['_index.md', 'synthesis/a.md']);
  assert.strictEqual(added[1].size, 5);
  assert.strictEqual(added[1].chatDir, null);
});

test('scanAdded sorts by code unit and keeps the on-disk spelling', () => {
  const tmp = tmpRoot();
  const s = path.join(tmp, 's');
  put(s, 'original.json', CHAT);
  for (const f of ['c.md', 'B.md', 'a.md', 'Ä.md', 'dir/y.md', 'dir/Z.md']) put(s, f);
  assert.deepStrictEqual(scanAdded(find(tmp).archives[0]).files.map(f => f.path), ['B.md', 'a.md', 'c.md', 'dir/Z.md', 'dir/y.md', 'Ä.md']);
});

test('scanAdded in a mega sets chatDir for chat-folder files, null for root ones', () => {
  const tmp = tmpRoot();
  const m = path.join(tmp, 'mega');
  put(m, 'index.md');
  put(m, 'notes.md');
  put(m, 'projects/p/file.txt');
  put(m, 'chat one/original.json', CHAT);
  put(m, 'chat one/README.md');
  put(m, 'chat one/synthesis/s.md');
  put(m, 'chat one/uploads/p01_x.png');
  put(m, 'chat two/original.json', CHAT);
  const arch = find(tmp).archives[0];
  assert.strictEqual(arch.kind, 'mega');
  assert.deepStrictEqual(scanAdded(arch).files.map(f => [f.path, f.chatDir]), [
    ['chat one/synthesis/s.md', 'chat one'],
    ['notes.md', null],
  ]);
});

test('isGeneratedViewer recognises the marker or the template shape', () => {
  assert.ok(isGeneratedViewer('<meta name="generator" content="Claude Takeout">'));
  assert.ok(isGeneratedViewer('<script id="data" type="application/json">{}</script> function chainFrom('));
  assert.ok(!isGeneratedViewer('<html>my own page</html>'));
  assert.ok(!isGeneratedViewer('<script id="data" type="application/json">{}</script>'));
});

test('a skipped or excluded chat folder in a mega adds no files', () => {
  const tmp = tmpRoot();
  const m = path.join(tmp, 'mega');
  put(m, 'index.md');
  put(m, 'good/original.json', CHAT);
  put(m, 'gem/original.json', CHAT);
  put(m, 'gem/conversation.json', '{}');
  put(m, 'gem/notes.md');
  put(m, 'out/original.json', CHAT);
  put(m, 'out/mine.md');
  put(m, 'plain/synthesis/s.md');
  const res = find(tmp, [path.join(m, 'out')]);
  assert.deepStrictEqual(res.archives[0].chats.map(c => c.relDir), ['good']);
  assert.deepStrictEqual(scanAdded(res.archives[0]).files.map(f => f.path), ['plain/synthesis/s.md']);
});

test('a folder with its own original.json is a single even beside index.md', () => {
  const tmp = tmpRoot();
  put(tmp, 'index.md');
  put(tmp, 'original.json', CHAT);
  put(tmp, 'synthesis/other-export/original.json', CHAT);
  const res = find(tmp);
  assert.strictEqual(res.archives.length, 1);
  assert.strictEqual(res.archives[0].kind, 'single');
  assert.strictEqual(res.archives[0].root, tmp);
  assert.deepStrictEqual(scanAdded(res.archives[0]).files.map(f => f.path), ['synthesis/other-export/original.json']);
});

test('scanAdded reports an unreadable folder and keeps going', { skip: process.getuid && process.getuid() === 0 }, () => {
  const tmp = tmpRoot();
  const s = path.join(tmp, 's');
  put(s, 'original.json', CHAT);
  put(s, 'ok.md');
  put(s, 'locked/a.md');
  put(s, 'zlast.md');
  const arch = find(tmp).archives[0];
  fs.chmodSync(path.join(s, 'locked'), 0o000);
  try {
    const res = scanAdded(arch);
    assert.deepStrictEqual(res.files.map(f => f.path), ['ok.md', 'zlast.md']);
    assert.strictEqual(res.errors.length, 1);
    assert.strictEqual(res.errors[0].path, 'locked');
    assert.ok(res.errors[0].message);
  } finally { fs.chmodSync(path.join(s, 'locked'), 0o755); }
});

// ---- chatFromDisk ----
// Writes what populateConversationFolder produced into dir. A blob stub is written as its marker text.
const writeFolder = (dir, written) => {
  for (const [name, entry] of Object.entries(written)) {
    const content = entry && entry.options ? entry.content : entry;
    put(dir, name, typeof content === 'string' ? content : String(content && content.marker !== undefined ? content.marker : 'binary'));
  }
};
const singleOf = dir => ({ root: dir, kind: 'single', chats: [{ dir, relDir: '.' }] });
const exportToDisk = async (opts = {}) => {
  const dir = tmpRoot();
  const data = withUploads();
  data.chat_messages.find(m => m.sender === 'human').files_v2[3].path = '/mnt/user-data/uploads/legacy.txt';
  const legacy = [/download-file/, () => ({ ok: true, status: 200, blob: async () => textBlob('old') })];
  const { written, chat } = await runFolder(exportPopup({ routes: [...projectResponses(), legacy], texts: { 'up-text': textBlob('hello'), 'de000000-0000-4000-8000-000000000003': textBlob('x', 'application/vnd.oasis.opendocument.text') } }),
    Object.assign(data, { project_uuid: 'P' }), opts);
  writeFolder(dir, written);
  return { dir, archive: singleOf(dir), chat: singleOf(dir).chats[0], expected: chat, written };
};

test('parity: a folder written by the real export rebuilds the same viewer chat', async () => {
  const { archive, chat, expected } = await exportToDisk();
  const got = chatFromDisk(archive, chat);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(got.viewerChat)), JSON.parse(JSON.stringify(expected)));
  assert.deepStrictEqual(got.missing, []);
});

test('text survives a deleted artefact, a binary is reported missing', async () => {
  const { dir, archive, chat } = await exportToDisk();
  fs.rmSync(`${dir}/artefacts/report.html`);
  let got = chatFromDisk(archive, chat);
  const report = Object.values(got.viewerChat.files).find(f => f.name === 'report.html');
  assert.ok(report && report.versions.every(v => typeof v.text === 'string' && v.text));
  assert.deepStrictEqual(got.missing, []);
  const odt = fs.readdirSync(`${dir}/artefacts`).filter(n => /\.odt$/.test(n));
  assert.ok(odt.length);
  for (const n of odt) fs.rmSync(`${dir}/artefacts/${n}`);
  got = chatFromDisk(archive, chat);
  assert.ok(got.missing.includes('Minutes.odt'), got.missing.join());
});

test('disk text wins over the replayed text, BOM stripped', async () => {
  const { dir, archive, chat } = await exportToDisk();
  put(dir, 'artefacts/report_v3.html', '\uFEFF<p>fixed by replay_bash</p>');
  put(dir, 'artefacts/extra.txt', 'only on disk');
  const files = Object.values(chatFromDisk(archive, chat).viewerChat.files);
  assert.strictEqual(files.find(f => f.name === 'report.html').versions.slice(-1)[0].text, '<p>fixed by replay_bash</p>');
});

test('a renamed upload is found by loose match, and an upload that is gone is missing', async () => {
  const { dir, archive, chat } = await exportToDisk();
  fs.renameSync(`${dir}/uploads/p01_notes.txt`, `${dir}/uploads/P01 Notes.txt`);
  fs.rmSync(`${dir}/uploads/p01_photo.png`);
  const got = chatFromDisk(archive, chat);
  const ups = Object.fromEntries(got.viewerChat.messages.flatMap(m => m.uploads).map(u => [u.name, u]));
  assert.strictEqual(ups['notes.txt'].href, 'uploads/P01%20Notes.txt');
  assert.strictEqual(ups['notes.txt'].text, 'hello');
  assert.strictEqual(ups['photo.png'].href, null);
  assert.ok(got.missing.includes('p01_photo.png'));
});

test('older mega: no projects/ folder, project files in the chat folder', async () => {
  const { dir, written } = await exportToDisk();
  const mega = tmpRoot();
  put(mega, 'index.md');
  fs.cpSync(dir, `${mega}/chat a`, { recursive: true });
  const archive = { root: mega, kind: 'mega', chats: [{ dir: `${mega}/chat a`, relDir: 'chat a' }] };
  const p = chatFromDisk(archive, archive.chats[0]).viewerChat.project;
  assert.strictEqual(p.name, 'My Project');
  assert.deepStrictEqual(p.files.map(f => f.name), ['Paper.pdf']);
  assert.strictEqual(p.files[0].href, 'chat%20a/project/files/Paper.pdf');
  assert.ok(written['project/Brief.md']);
});

test('mega with a shared projects/ folder: the link comes from the chat README', async () => {
  const mega = tmpRoot();
  put(mega, 'index.md');
  put(mega, 'c/original.json', JSON.stringify({ uuid: 'u', project_uuid: 'P', project: { uuid: 'P', name: 'Shared' }, chat_messages: [] }));
  put(mega, 'c/README.md', '\uFEFF- [Paper.pdf](../projects/My%20Proj/files/Paper.pdf)\n');
  put(mega, 'projects/My Proj/files/Paper.pdf', 'pdf');
  const archive = { root: mega, kind: 'mega', chats: [{ dir: `${mega}/c`, relDir: 'c' }] };
  const p = chatFromDisk(archive, archive.chats[0]).viewerChat.project;
  assert.deepStrictEqual(p.files.map(f => f.href), ['projects/My%20Proj/files/Paper.pdf']);
});

test('project is null without a project uuid, and built from project.json when only the folder is there', () => {
  const dir = tmpRoot();
  put(dir, 'original.json', JSON.stringify({ uuid: 'u', chat_messages: [] }));
  const archive = singleOf(dir);
  assert.strictEqual(chatFromDisk(archive, archive.chats[0]).viewerChat.project, null);
  put(dir, 'project/project.json', JSON.stringify({ name: 'Old Proj', prompt_template: 'be brief' }));
  put(dir, 'project/Notes.md', '\uFEFFnotes');
  put(dir, 'project/prompt_template.md', '\uFEFFbe brief');
  const p = chatFromDisk(archive, archive.chats[0]).viewerChat.project;
  assert.strictEqual(p.name, 'Old Proj');
  assert.strictEqual(p.instructions, 'be brief');
  assert.deepStrictEqual(p.docs.map(d => d.name), ['Notes.md']);
});

test('matchFile: exact, NFC, loose, and ambiguous', () => {
  assert.strictEqual(matchFile('p01_My Report.pdf', ['p01_My_Report.pdf']), 'p01_My_Report.pdf');
  assert.strictEqual(matchFile('p01_a b.pdf', ['p01_a_b.pdf', 'p01_a-b.pdf']), null);
  assert.strictEqual(matchFile('p01_Gödel.md', ['p01_Gödel.md']), 'p01_Gödel.md');
  const nfd = 'p01_Go\u0308del.md';
  assert.strictEqual(matchFile('p01_G\u00f6del.md', [nfd]), nfd);
  assert.strictEqual(matchFile('x.pdf', ['y.pdf']), null);
  assert.strictEqual(matchFile('a.pdf', ['A.PDF', 'a.pdf']), 'a.pdf');
  assert.strictEqual(matchFile('---', ['___']), null);
});

test('unreadable original.json throws with its path; odd shapes lose detail, not the chat', () => {
  const dir = tmpRoot();
  put(dir, 'original.json', '{"chat_mess');
  assert.throws(() => chatFromDisk(singleOf(dir), { dir, relDir: '.' }), e => e.message.includes(path.join(dir, 'original.json')));
  put(dir, 'original.json', '\uFEFF' + JSON.stringify({
    uuid: 'u', current_leaf_message_uuid: 'b', chat_messages: [
      { uuid: 'a', parent_message_uuid: null, sender: 'human', content: null, attachments: {}, files: null, files_v2: 'x' },
      null,
      { uuid: 'b', parent_message_uuid: 'a', sender: 'assistant', content: [null, { type: 'text', text: 'ok' }, { type: 'tool_use', name: 'create_file', input: null }], attachments: null },
    ],
  }));
  const got = chatFromDisk(singleOf(dir), { dir, relDir: '.' });
  assert.strictEqual(got.viewerChat.id, 'u');
  assert.ok(got.viewerChat.messages.length >= 1);
});

// ---- disk names across every file kind ----
const NFD = s => s.normalize('NFD');
const sendFile = (id, p, uuid) => [
  { type: 'tool_use', id, name: 'SendUserFile', input: { files: [p] } },
  { type: 'tool_result', tool_use_id: id, is_error: false, name: 'SendUserFile', content: [], file_deliveries: [{ file_uuid: uuid, path: p }] },
];
const chatDir = (data) => {
  const dir = tmpRoot();
  put(dir, 'original.json', JSON.stringify(data));
  return { dir, archive: singleOf(dir), chat: { dir, relDir: '.' } };
};

test('a decomposed artefact on disk wins over the replay and keeps its disk spelling in the href', () => {
  const data = { uuid: 'u', current_leaf_message_uuid: 'a', chat_messages: [{ uuid: 'a', parent_message_uuid: null, sender: 'assistant',
    content: [{ type: 'tool_use', id: '1', name: 'create_file', input: { path: '/h/G\u00f6del.html', file_text: 'replay' } }] }] };
  const { dir, archive, chat } = chatDir(data);
  put(dir, `artefacts/${NFD('G\u00f6del.html')}`, 'disk text');
  const files = Object.values(chatFromDisk(archive, chat).viewerChat.files);
  assert.strictEqual(files.length, 1);
  assert.strictEqual(files[0].versions[0].text, 'disk text');
  assert.strictEqual(files[0].versions[0].href, 'artefacts/' + encodeURIComponent(NFD('G\u00f6del.html')));
});

test('a decomposed delivered binary on disk is found, not missing, and linked by its disk name', () => {
  const data = { uuid: 'u', current_leaf_message_uuid: 'a', chat_messages: [{ uuid: 'a', parent_message_uuid: null, sender: 'assistant',
    content: sendFile('1', '/tmp/out/Prot\u00f3.odt', 'de1') }] };
  const { dir, archive, chat } = chatDir(data);
  put(dir, `artefacts/${NFD('Prot\u00f3.odt')}`, 'bin');
  const got = chatFromDisk(archive, chat);
  assert.deepStrictEqual(got.missing, []);
  const f = Object.values(got.viewerChat.files)[0];
  assert.strictEqual(f.versions[0].href, 'artefacts/' + encodeURIComponent(NFD('Prot\u00f3.odt')));
});

test('a decomposed presented binary is not reported missing', () => {
  const data = { uuid: 'u', current_leaf_message_uuid: 'a', chat_messages: [{ uuid: 'a', parent_message_uuid: null, sender: 'assistant',
    content: [{ type: 'tool_result', name: 'present_files', content: [{ type: 'local_resource', file_path: '/o/Prot\u00f3.odt', uuid: 'p1' }] }] }] };
  const { dir, archive, chat } = chatDir(data);
  assert.deepStrictEqual(chatFromDisk(archive, chat).missing, ['Prot\u00f3.odt']);
  put(dir, `artefacts/${NFD('Prot\u00f3.odt')}`, 'bin');
  assert.deepStrictEqual(chatFromDisk(archive, chat).missing, []);
});

test('matchFile: a different prompt number still matches, two candidates do not', () => {
  assert.strictEqual(matchFile('p02_a.pdf', ['p05_a.pdf']), 'p05_a.pdf');
  assert.strictEqual(matchFile('p02_a.pdf', ['p05_a.pdf', 'p07_a.pdf']), null);
});

test('an upload already matched exactly to another expected upload is not matched again', () => {
  const human = (files) => ({ uuid: 'h', parent_message_uuid: null, sender: 'human', content: [], files_v2: files });
  const data = { uuid: 'u', current_leaf_message_uuid: 'h', chat_messages: [human([
    { success: true, file_name: 'a b.pdf', file_uuid: 'x1' }, { success: true, file_name: 'a_b.pdf', file_uuid: 'x2' }])] };
  const { dir, archive, chat } = chatDir(data);
  put(dir, 'uploads/p01_a_b.pdf', 'pdf');
  const got = chatFromDisk(archive, chat);
  const ups = Object.fromEntries(got.viewerChat.messages.flatMap(m => m.uploads).map(u => [u.name, u]));
  assert.strictEqual(ups['a_b.pdf'].href, 'uploads/p01_a_b.pdf');
  assert.strictEqual(ups['a b.pdf'].href, null);
  assert.deepStrictEqual(got.missing, ['p01_a b.pdf']);
});

test('README link to a projects/ folder that is not there falls back to project/files', () => {
  const mega = tmpRoot();
  put(mega, 'index.md');
  put(mega, 'c/original.json', JSON.stringify({ uuid: 'u', project_uuid: 'P', chat_messages: [] }));
  put(mega, 'c/README.md', '- [Paper.pdf](../projects/Gone/files/Paper.pdf)\n');
  put(mega, 'c/project/files/Paper.pdf', 'pdf');
  const archive = { root: mega, kind: 'mega', chats: [{ dir: `${mega}/c`, relDir: 'c' }] };
  const p = chatFromDisk(archive, archive.chats[0]).viewerChat.project;
  assert.deepStrictEqual(p.files.map(f => f.href), ['c/project/files/Paper.pdf']);
});

// ---- ZIP extraction (tools/archive-zip.js) ----
const JSZip = require('../jszip.min.js');
const { extractZip, zipFreeSpaceOk } = require('../tools/archive-zip.js');

const makeZip = async (tmp, build, name = 'a.zip') => {
  const zip = new JSZip();
  build(zip);
  const p = path.join(tmp, name);
  fs.writeFileSync(p, await zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX' }));
  return p;
};

test('extractZip keeps a non-ASCII name and binary bytes', async () => {
  const tmp = tmpRoot();
  const bin = Buffer.from([0, 255, 1, 254, 80, 75, 3, 4, 0, 0]);
  const zp = await makeZip(tmp, z => { z.file('chat/Übergröße.md', 'hallo'); z.file('chat/uploads/p01_x.pdf', bin); });
  const dest = path.join(tmp, 'out');
  const res = await extractZip(zp, dest);
  assert.strictEqual(res.files, 2);
  assert.deepStrictEqual(res.rejected, []);
  assert.strictEqual(res.bytes, 5 + bin.length);
  assert.strictEqual(fs.readFileSync(path.join(dest, 'chat/Übergröße.md'), 'utf8'), 'hallo');
  assert.ok(fs.readFileSync(path.join(dest, 'chat/uploads/p01_x.pdf')).equals(bin));
  assert.ok(!fs.existsSync(dest + '.partial'));
});

test('extractZip leaves the ZIP untouched and writes nothing beside it', async () => {
  const tmp = tmpRoot();
  const zp = await makeZip(tmp, z => z.file('a.txt', 'a'));
  const before = fs.statSync(zp);
  const bytes = fs.readFileSync(zp);
  fs.mkdirSync(path.join(tmp, 'sub'));
  await extractZip(zp, path.join(tmp, 'sub', 'out'));
  const after = fs.statSync(zp);
  assert.strictEqual(after.mtimeMs, before.mtimeMs);
  assert.ok(fs.readFileSync(zp).equals(bytes));
  assert.deepStrictEqual(fs.readdirSync(tmp).sort(), ['a.zip', 'sub']);
});

// JSZip normalizes '../x' away on write, so hand-build a stored ZIP with the exact names.
const rawZip = entries => {
  const zlib = require('zlib');
  const locals = [], centrals = [];
  let off = 0;
  for (const [name, text] of entries) {
    const n = Buffer.from(name), d = Buffer.from(text);
    const crc = zlib.crc32 ? zlib.crc32(d) : 0;
    const l = Buffer.alloc(30);
    l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt32LE(crc, 14);
    l.writeUInt32LE(d.length, 18); l.writeUInt32LE(d.length, 22); l.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(d.length, 20); c.writeUInt32LE(d.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(off, 42);
    locals.push(l, n, d); centrals.push(c, n);
    off += 30 + n.length + d.length;
  }
  const cd = Buffer.concat(centrals);
  const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(entries.length, 8); e.writeUInt16LE(entries.length, 10);
  e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, e]);
};

test('extractZip refuses traversal, absolute, drive, backslash and NUL names', async () => {
  const tmp = tmpRoot();
  const bad = ['../escape.txt', 'a/../../escape2.txt', '/abs-escape.txt', 'C:/win.txt', '..\\back.txt', 'nul\0.txt'];
  const zp = path.join(tmp, 'evil.zip');
  fs.writeFileSync(zp, rawZip([['ok.txt', 'ok'], ...bad.map(n => [n, 'bad'])]));
  // prove the hostile names really are in the ZIP, so the check below is exercised
  const names = Object.values((await JSZip.loadAsync(fs.readFileSync(zp))).files).map(f => f.unsafeOriginalName || f.name);
  for (const n of bad) assert.ok(names.includes(n), 'ZIP lacks ' + JSON.stringify(n));
  const dest = path.join(tmp, 'x', 'out');
  fs.mkdirSync(path.dirname(dest));
  const res = await extractZip(zp, dest);
  assert.strictEqual(res.files, 1);
  assert.deepStrictEqual(res.rejected.sort(), [...bad].sort());
  assert.ok(!fs.existsSync(path.join(tmp, 'x', 'escape.txt')));
  assert.ok(!fs.existsSync(path.join(tmp, 'escape.txt')));
  assert.ok(!fs.existsSync('/abs-escape.txt'));
  assert.deepStrictEqual(fs.readdirSync(dest), ['ok.txt']);
  assert.deepStrictEqual(fs.readdirSync(path.join(tmp, 'x')), ['out']);
});

test('extractZip refuses symlink entries', async () => {
  const tmp = tmpRoot();
  const zp = await makeZip(tmp, z => { z.file('ok.txt', 'ok'); z.file('link', '/etc/passwd', { unixPermissions: 0o120777 }); });
  const dest = path.join(tmp, 'out');
  const res = await extractZip(zp, dest);
  assert.deepStrictEqual(res.rejected, ['link']);
  assert.deepStrictEqual(fs.readdirSync(dest), ['ok.txt']);
});

test('extractZip skips __MACOSX and .DS_Store silently', async () => {
  const tmp = tmpRoot();
  const zp = await makeZip(tmp, z => { z.file('ok.txt', 'ok'); z.file('__MACOSX/._ok.txt', 'm'); z.file('d/.DS_Store', 'm', { createFolders: false }); });
  const dest = path.join(tmp, 'out');
  const res = await extractZip(zp, dest);
  assert.strictEqual(res.files, 1);
  assert.deepStrictEqual(res.rejected, []);
  assert.deepStrictEqual(fs.readdirSync(dest), ['ok.txt']);
});

test('extractZip rejects an existing destDir or a .partial leftover and keeps them', async () => {
  const tmp = tmpRoot();
  const zp = await makeZip(tmp, z => z.file('ok.txt', 'ok'));
  const dest = path.join(tmp, 'out');
  fs.mkdirSync(dest);
  await assert.rejects(extractZip(zp, dest), /already exists/);
  assert.deepStrictEqual(fs.readdirSync(dest), []);
  assert.ok(!fs.existsSync(dest + '.partial'));
  const dest2 = path.join(tmp, 'out2');
  fs.mkdirSync(dest2 + '.partial');
  fs.writeFileSync(path.join(dest2 + '.partial', 'keep'), 'k');
  await assert.rejects(extractZip(zp, dest2), /remove.*\.partial/is);
  assert.ok(fs.existsSync(path.join(dest2 + '.partial', 'keep')));
  assert.ok(!fs.existsSync(dest2));
});

test('extractZip rejects a corrupt ZIP clearly and leaves nothing', async () => {
  const tmp = tmpRoot();
  const zp = path.join(tmp, 'bad.zip');
  fs.writeFileSync(zp, 'this is not a zip file at all');
  const dest = path.join(tmp, 'out');
  await assert.rejects(extractZip(zp, dest), /not a valid ZIP/i);
  assert.ok(!fs.existsSync(dest) && !fs.existsSync(dest + '.partial'));
});

test('extractZip stops on a zip bomb and removes its partial folder', async () => {
  const tmp = tmpRoot();
  const zp = await makeZip(tmp, z => z.file('big.txt', Buffer.alloc(4 * 1024 * 1024)));
  const dest = path.join(tmp, 'out');
  await assert.rejects(extractZip(zp, dest, { maxBytes: 1024 }), /too large|zip bomb/i);
  assert.ok(!fs.existsSync(dest) && !fs.existsSync(dest + '.partial'));
});

test('zipFreeSpaceOk reports needed (+10%) and free', async () => {
  const tmp = tmpRoot();
  const zp = await makeZip(tmp, z => z.file('a.txt', Buffer.alloc(1000)));
  const r = await zipFreeSpaceOk(zp, path.join(tmp, 'not', 'yet', 'there'));
  assert.strictEqual(r.needed, 1100);
  assert.ok(r.free > 0 && r.ok === true);
});
