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
const crc32 = buf => {
  let c, crc = 0xffffffff;
  for (const b of buf) { c = (crc ^ b) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; crc = (crc >>> 8) ^ c; }
  return (crc ^ 0xffffffff) >>> 0;
};
// entries: [name, text, { deflate, lieSize }]; lieSize is written as the header's uncompressed size.
const rawZip = entries => {
  const zlib = require('zlib');
  const locals = [], centrals = [];
  let off = 0;
  for (const [name, text, o = {}] of entries) {
    const n = Buffer.from(name), raw = Buffer.from(text);
    const d = o.deflate ? zlib.deflateRawSync(raw) : raw;
    const crc = crc32(raw), usize = o.lieSize != null ? o.lieSize : raw.length, method = o.deflate ? 8 : 0;
    const l = Buffer.alloc(30);
    l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt16LE(method, 8); l.writeUInt32LE(crc, 14);
    l.writeUInt32LE(d.length, 18); l.writeUInt32LE(usize, 22); l.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(method, 10); c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(d.length, 20); c.writeUInt32LE(usize, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(off, 42);
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

test('extractZip lists a file-then-folder clash and keeps the rest', async () => {
  const tmp = tmpRoot();
  const zp = path.join(tmp, 'c.zip');
  fs.writeFileSync(zp, rawZip([['a', 'file'], ['a/b', 'child'], ['good.txt', 'g']]));
  const dest = path.join(tmp, 'out');
  const res = await extractZip(zp, dest);
  assert.deepStrictEqual(res.rejected, ['a/b']);
  assert.strictEqual(res.files, 2);
  assert.deepStrictEqual(fs.readdirSync(dest).sort(), ['a', 'good.txt']);
  assert.ok(!fs.existsSync(dest + '.partial'));
});

test('extractZip lists names too long for the filesystem and keeps the rest', async () => {
  const tmp = tmpRoot();
  const long = 'x'.repeat(300) + '.txt';
  const zp = path.join(tmp, 'l.zip');
  fs.writeFileSync(zp, rawZip([[long, 'l'], ['d/' + 'y'.repeat(256), 'l'], ['good.txt', 'g']]));
  const dest = path.join(tmp, 'out');
  const res = await extractZip(zp, dest);
  assert.deepStrictEqual(res.rejected.sort(), [long, 'd/' + 'y'.repeat(256)].sort());
  assert.strictEqual(res.files, 1);
  assert.ok(fs.existsSync(path.join(dest, 'good.txt')));
});

test('extractZip streaming guard catches a header that lies about size', async () => {
  const tmp = tmpRoot();
  const zp = path.join(tmp, 'lie.zip');
  fs.writeFileSync(zp, rawZip([['big.txt', '\0'.repeat(4 * 1024 * 1024), { deflate: true, lieSize: 10 }]]));
  const dest = path.join(tmp, 'out');
  await assert.rejects(extractZip(zp, dest, { maxBytes: 1024 * 1024 }), /zip bomb/i);
  assert.ok(!fs.existsSync(dest) && !fs.existsSync(dest + '.partial'));
});

test('extractZip keeps a decomposed name as stored', async () => {
  const tmp = tmpRoot();
  const name = 'Go\u0308del.txt';
  const zp = await makeZip(tmp, z => z.file(name, 'g'));
  const dest = path.join(tmp, 'out');
  await extractZip(zp, dest);
  const [got] = fs.readdirSync(dest);
  assert.strictEqual(Buffer.from(got).toString('hex'), Buffer.from(name).toString('hex'));
});

// ---- build_viewer (tools/build_viewer.js) ----
// Everything here runs on synthetic folders in a temp dir. Required on use, so one failure can't hide the rest.
const crypto = require('crypto');
const vm = require('vm');
const { spawn, spawnSync } = require('child_process');
const CTViewer = require('../takeout-viewer.js');
const zipLib = require('../tools/archive-zip.js');

const tool = () => require('../tools/build_viewer.js');
const TOOL_PATH = path.resolve(__dirname, '..', 'tools', 'build_viewer.js');
const cli = (...args) => spawnSync(process.execPath, [TOOL_PATH, ...args], { encoding: 'utf8' });
const chatJson = (uuid, name = 'Chat ' + uuid, extra = {}) => JSON.stringify({
  uuid, name, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z',
  chat_messages: [
    { uuid: uuid + '-1', sender: 'human', content: [{ type: 'text', text: 'hello ' + uuid }], parent_message_uuid: null },
    { uuid: uuid + '-2', sender: 'assistant', content: [{ type: 'text', text: 'hi' }], parent_message_uuid: uuid + '-1' },
  ],
  current_leaf_message_uuid: uuid + '-2', ...extra,
});
const OWN_FILES = /^(viewer\.html|viewer-check\.gif|viewer-files(\/part-\d{4}\.js)?)$/;

// rel -> kind, size, mode and content hash of every entry. Directory mtimes change by design, so they aren't in it.
function hashTree(root) {
  const out = {};
  const walk = (dir, rel) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, name);
      const r = rel ? rel + '/' + name : name;
      const s = fs.lstatSync(p);
      if (s.isSymbolicLink()) out[r] = 'link:' + fs.readlinkSync(p);
      else if (s.isDirectory()) { out[r] = 'dir:' + s.mode; walk(p, r); }
      else out[r] = `file:${s.size}:${s.mode}:${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}`;
    }
  };
  walk(root, '');
  return out;
}
const assertKept = (before, after, except = []) => {
  for (const [k, v] of Object.entries(before)) {
    if (!except.includes(k) && !k.startsWith('viewer-files/')) assert.strictEqual(after[k], v, 'changed: ' + k);
  }
};
const newEntries = (before, after) => Object.keys(after).filter(k => !(k in before));
const viewerData = root => {
  const html = fs.readFileSync(path.join(root, 'viewer.html'), 'utf8');
  return JSON.parse(/<script id="data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1]);
};
const loadPart = body => {
  const got = [];
  vm.runInNewContext(body, { window: { __archivePart: (n, data) => got.push({ n, data }) } });
  assert.strictEqual(got.length, 1);
  return got[0];
};
const single = root => findArchives(root).archives[0];
// One archive with an added note, a nested added file, a PDF, an upload and a skipped hidden file.
function richSingle(root) {
  put(root, 'original.json', chatJson('s1'));
  put(root, 'README.md', 'readme');
  put(root, '_index.md', '# index');
  put(root, 'synthesis/deep note.md', 'note </script> text');
  put(root, 'studies/paper.pdf', '%PDF-1.4 binary');
  put(root, 'uploads/p01_x.txt', 'upload');
  return root;
}

test('writeViewer numbers upload parts after added-file parts', async () => {
  const { writeViewer } = tool();
  const root = tmpRoot();
  const big = 'upload line\n'.repeat(7000);
  const human = { uuid: 'u1-1', sender: 'human', content: [{ type: 'text', text: 'see file' }], parent_message_uuid: null, files_v2: [{ file_uuid: 'f-big', file_name: 'big.md', success: true }] };
  put(root, 'original.json', chatJson('u1', 'Uploads', { chat_messages: [human, { uuid: 'u1-2', sender: 'assistant', content: [{ type: 'text', text: 'ok' }], parent_message_uuid: 'u1-1' }] }));
  put(root, 'uploads/p01_big.md', big);
  put(root, 'synthesis/note.md', 'added note');
  const before = hashTree(root);
  const res = await writeViewer(single(root), {});
  assert.strictEqual(res.status, 'written', res.reason);
  const after = hashTree(root);
  assertKept(before, after);
  assert.deepStrictEqual(newEntries(before, after).sort(), ['viewer-check.gif', 'viewer-files', 'viewer-files/part-0001.js', 'viewer-files/part-0002.js', 'viewer.html']);
  const one = loadPart(fs.readFileSync(path.join(root, 'viewer-files/part-0001.js'), 'utf8'));
  const two = loadPart(fs.readFileSync(path.join(root, 'viewer-files/part-0002.js'), 'utf8'));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(one)), { n: 1, data: { 0: 'added note' } });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(two)), { n: 2, data: { u0: big } });
  const data = viewerData(root);
  const upload = data.chats[0].messages[0].uploads[0];
  assert.deepStrictEqual([upload.name, upload.text, upload.part, upload.key, upload.lines], ['big.md', null, 2, 'u0', 7001]);
  assert.strictEqual(data.added[0].part, 1);
  assert.ok(!fs.readFileSync(path.join(root, 'viewer.html'), 'utf8').includes('upload line\nupload line'));
});

test('assembleViewer: fileScripts adds file: to the page policy only, and exports are unchanged', () => {
  const [template, logic, app, marked, katex, css] = CTViewer.VIEWER_ASSETS.map(a => fs.readFileSync(path.resolve(__dirname, '..', a), 'utf8'));
  const parts = { template, css, marked, katex, logic, app, data: { exported: 'x', chats: [] } };
  const plain = CTViewer.assembleViewer(parts);
  const withFiles = CTViewer.assembleViewer({ ...parts, fileScripts: true });
  assert.strictEqual(CTViewer.assembleViewer({ ...parts, fileScripts: false }), plain);
  assert.strictEqual(withFiles, plain
    .replace(`content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval';`, `content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' file:;`)
    .replace(`img-src file: data: blob:; media-src data: blob:;`, `img-src file: data: blob:; media-src data: blob: file:;`));
  assert.notStrictEqual(withFiles, plain);
  assert.ok(!/<meta http-equiv="Content-Security-Policy"[^>]*script-src[^;]*file:/.test(plain));
  assert.ok(withFiles.includes(`const PREVIEW_CSP = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src`), 'preview sandbox policy is untouched');
  // The template with no placeholders comes back as it went in.
  assert.strictEqual(CTViewer.assembleViewer({ ...parts, template: 'plain' }), 'plain');
});

test('assembleViewer: fileMedia opens media-src alone, so a viewer with no parts loads no scripts from disk', () => {
  const [template, logic, app, marked, katex, css] = CTViewer.VIEWER_ASSETS.map(a => fs.readFileSync(path.resolve(__dirname, '..', a), 'utf8'));
  const parts = { template, css, marked, katex, logic, app, data: { exported: 'x', chats: [] } };
  const media = CTViewer.assembleViewer({ ...parts, fileMedia: true });
  assert.strictEqual(media, CTViewer.assembleViewer(parts).replace(`img-src file: data: blob:; media-src data: blob:;`, `img-src file: data: blob:; media-src data: blob: file:;`));
  assert.ok(media.includes(`img-src data: blob:; font-src data:; media-src data: blob:; base-uri 'none'`), 'preview sandbox policy is untouched');
});

test('kindFor is exported', () => {
  assert.strictEqual(CTViewer.kindFor('a.md', null, true), 'md');
  assert.strictEqual(CTViewer.kindFor('a.txt', null, true), 'code');
  assert.strictEqual(CTViewer.kindFor('a.bin', null, false), 'binary');
});

test('buildParts splits a 5 MB set at PART_LIMIT, and every part runs as JS', async () => {
  const { buildParts, PART_LIMIT } = tool();
  assert.strictEqual(PART_LIMIT, 4 * 1024 * 1024);
  const tmp = tmpRoot();
  const files = [];
  for (let i = 0; i < 5; i++) {
    const rel = `notes/n${i}.md`;
    const text = `</script><!-- ${i} \u2028 ` + 'x'.repeat(1024 * 1024);
    put(tmp, rel, text);
    files.push({ path: rel, chat: null, size: Buffer.byteLength(text) });
  }
  const { entries, parts } = await buildParts(files, { root: tmp });
  assert.strictEqual(parts.length, 2);
  assert.deepStrictEqual(parts.map(p => p.name), ['part-0001.js', 'part-0002.js']);
  const loaded = {};
  for (const p of parts) {
    assert.ok(Buffer.byteLength(p.body) <= PART_LIMIT, 'over the limit');
    assert.match(p.body, /^window\.__archivePart\(\d+, /);
    assert.ok(!p.body.includes('</script'), 'no raw closing tag');
    const { n, data } = loadPart(p.body);
    loaded[n] = data;
  }
  entries.forEach((e, i) => {
    assert.strictEqual(typeof e.key, 'string');
    assert.ok(loaded[e.part][e.key].startsWith(`</script><!-- ${i} \u2028 `), e.path);
  });
});

test('buildParts: what embeds, what links, and that parts can go straight to disk', async () => {
  const { buildParts } = tool();
  const tmp = tmpRoot();
  const big = 'y'.repeat(CTViewer.TEXT_EMBED_LIMIT + 1);
  const add = (rel, text, chat = null) => { put(tmp, rel, text); return { path: rel, chat, size: Buffer.byteLength(text) }; };
  const files = [
    add('a b/Größe #1.md', '﻿cafÃ©', 'chat-1'),
    add('big.txt', big),
    add('paper.pdf', '%PDF'),
    add('data.csv', 'a,b'),
    { path: 'gone.md', chat: null, size: 3 },
  ];
  const seen = [];
  const { entries, parts, warnings } = await buildParts(files, { root: tmp, onPart: p => seen.push(p) });
  assert.deepStrictEqual(parts, []);
  assert.strictEqual(seen.length, 1);
  const data = loadPart(seen[0].body).data;
  const [md, large, pdf, csv, gone] = entries;
  assert.deepStrictEqual({ ...md, key: null }, { path: 'a b/Größe #1.md', chat: 'chat-1', kind: 'md', size: md.size, href: 'a%20b/Gr%C3%B6%C3%9Fe%20%231.md', part: 1, key: null });
  assert.strictEqual(data[md.key], 'café');
  assert.deepStrictEqual(large, { path: 'big.txt', chat: null, kind: 'code', size: big.length, href: 'big.txt', part: null, key: null });
  assert.deepStrictEqual(pdf, { path: 'paper.pdf', chat: null, kind: 'pdf', size: 4, href: 'paper.pdf', part: null, key: null });
  assert.strictEqual(csv.kind, 'code');
  assert.strictEqual(data[csv.key], 'a,b');
  assert.deepStrictEqual([gone.part, gone.key], [null, null]);
  assert.ok(warnings.some(w => w.includes('gone.md')));
});

test('writeViewer: every existing file is untouched; only the viewer, gif and parts are new', async () => {
  const { writeViewer } = tool();
  const root = richSingle(tmpRoot());
  fs.chmodSync(path.join(root, '_index.md'), 0o640);
  const before = hashTree(root);
  const res = await writeViewer(single(root), {});
  assert.strictEqual(res.status, 'written', res.reason);
  assert.strictEqual(res.chats, 1);
  assert.strictEqual(res.added, 3);
  const after = hashTree(root);
  assertKept(before, after);
  assert.deepStrictEqual(newEntries(before, after).sort(), ['viewer-check.gif', 'viewer-files', 'viewer-files/part-0001.js', 'viewer.html']);
  assert.ok(isGeneratedViewer(fs.readFileSync(path.join(root, 'viewer.html'), 'utf8')));
  assert.deepStrictEqual(fs.readFileSync(path.join(root, 'viewer-check.gif')), Buffer.from(CTViewer.VIEWER_CHECK_BASE64, 'base64'));

  const data = viewerData(root);
  assert.strictEqual(data.chats[0].id, 's1');
  assert.ok(!Number.isNaN(Date.parse(data.exported)));
  assert.deepStrictEqual(data.added.map(a => [a.path, a.kind, a.part === null]), [
    ['_index.md', 'md', false], ['studies/paper.pdf', 'pdf', true], ['synthesis/deep note.md', 'md', false]]);
  assert.strictEqual(data.added[2].href, 'synthesis/deep%20note.md');
  assert.match(fs.readFileSync(path.join(root, 'viewer.html'), 'utf8'), /<meta http-equiv="Content-Security-Policy"[^>]*script-src[^;]* file:;/);
  const part = loadPart(fs.readFileSync(path.join(root, 'viewer-files/part-0001.js'), 'utf8'));
  assert.strictEqual(part.data[data.added[2].key], 'note </script> text');
  assert.ok(!fs.readFileSync(path.join(root, 'viewer.html'), 'utf8').includes('note </script> text'));
});

test('writeViewer: with no added text there is no parts folder, no file: policy and no added field', async () => {
  const { writeViewer } = tool();
  const root = tmpRoot();
  put(root, 'original.json', chatJson('s1'));
  assert.strictEqual((await writeViewer(single(root), {})).status, 'written');
  assert.ok(!fs.existsSync(path.join(root, 'viewer-files')));
  const html = fs.readFileSync(path.join(root, 'viewer.html'), 'utf8');
  assert.ok(!/<meta http-equiv="Content-Security-Policy"[^>]*script-src[^;]*file:/.test(html));
  assert.ok(!('added' in viewerData(root)));
});

test('buildParts embeds a small .mmd, so it does not read as too large', async () => {
  const { buildParts } = tool();
  const tmp = tmpRoot();
  put(tmp, 'flow.mmd', 'graph TD; A-->B');
  const seen = [];
  const { entries } = await buildParts([{ path: 'flow.mmd', chat: null, size: 15 }], { root: tmp, onPart: p => seen.push(p) });
  assert.strictEqual(entries[0].kind, 'mermaid');
  assert.strictEqual(entries[0].part, 1);
  assert.strictEqual(loadPart(seen[0].body).data[entries[0].key], 'graph TD; A-->B');
});

test('isTextFile still leaves .mmd out, so exports do not change', () => {
  assert.strictEqual(require('../export-core.js').isTextFile('flow.mmd'), false);
});

test('writeViewer: added audio with no added text can play, and no script comes from disk', async () => {
  const { writeViewer } = tool();
  const root = tmpRoot();
  put(root, 'original.json', chatJson('s1'));
  put(root, 'audio/talk.mp3', 'bytes');
  assert.strictEqual((await writeViewer(single(root), {})).status, 'written');
  const policy = /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(fs.readFileSync(path.join(root, 'viewer.html'), 'utf8'))[1];
  assert.match(policy, /media-src [^;]* file:;/);
  assert.doesNotMatch(policy, /script-src [^;]*file:/);
  assert.ok(!fs.existsSync(path.join(root, 'viewer-files')));
});

test('dry run writes nothing at all and says what would happen', () => {
  const tmp = tmpRoot();
  const root = richSingle(path.join(tmp, 'in', 'one'));
  const before = hashTree(tmp);
  const out = path.join(tmp, 'not', 'there');
  const r = cli(path.join(tmp, 'in'), '--out', out, '--dry-run', '--json');
  assert.strictEqual(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.strictEqual(report.dryRun, true);
  assert.deepStrictEqual(report.archives.map(a => [a.root.endsWith('one'), a.status, a.chats, a.added]), [[true, 'written', 1, 3]]);
  assert.deepStrictEqual(hashTree(tmp), before);
  assert.ok(!fs.existsSync(path.join(tmp, 'not')));
  assert.ok(fs.existsSync(root));
  assert.match(cli(path.join(tmp, 'in'), '--dry-run').stdout, /would write: /);
});

test('an existing viewer is skipped; --force replaces a marked one and leaves the rest alone', async () => {
  const { writeViewer } = tool();
  const root = richSingle(tmpRoot());
  await writeViewer(single(root), {});
  put(root, 'viewer-files/part-0002.js', 'window.__archivePart(2, {});'); // stale, from an older run
  const before = hashTree(root);
  const skip = await writeViewer(single(root), {});
  assert.strictEqual(skip.status, 'skipped');
  assert.match(skip.reason, /viewer/);
  assert.deepStrictEqual(hashTree(root), before);

  const res = await writeViewer(single(root), { force: true });
  assert.strictEqual(res.status, 'written', res.reason);
  const after = hashTree(root);
  assertKept(before, after, ['viewer.html']);
  assert.notStrictEqual(after['viewer.html'], before['viewer.html']);
  assert.deepStrictEqual(Object.keys(after).filter(k => k.startsWith('viewer-files/')), ['viewer-files/part-0001.js']);
  assert.ok(!fs.readdirSync(root).some(n => /\.(tmp|old)-/.test(n)), 'no temp left');
});

test('--force replaces a v1.6 viewer, and writes a gif when there was none', async () => {
  const { writeViewer } = tool();
  const root = tmpRoot();
  put(root, 'original.json', chatJson('s1'));
  put(root, 'viewer.html', '<meta name="generator" content="Claude Takeout">old');
  const res = await writeViewer(single(root), { force: true });
  assert.strictEqual(res.status, 'written', res.reason);
  assert.ok(fs.existsSync(path.join(root, 'viewer-check.gif')));
  assert.ok(!fs.readFileSync(path.join(root, 'viewer.html'), 'utf8').endsWith('old'));
});

test('--force refuses a hand-made viewer, whatever it is', async () => {
  const { writeViewer } = tool();
  const root = richSingle(tmpRoot());
  put(root, 'viewer.html', '<h1>my own page</h1>');
  const before = hashTree(root);
  const res = await writeViewer(single(root), { force: true });
  assert.strictEqual(res.status, 'failed');
  assert.match(res.reason, /not generated|hand-made/);
  assert.deepStrictEqual(hashTree(root), before);
  assert.strictEqual((await writeViewer(single(root), {})).status, 'skipped');
  assert.deepStrictEqual(hashTree(root), before);

  // A link is not followed or replaced, with or without --force.
  const other = tmpRoot();
  put(other, 'original.json', chatJson('s2'));
  put(other, 'target.html', '<h1>target</h1>');
  fs.symlinkSync('target.html', path.join(other, 'viewer.html'));
  const linked = hashTree(other);
  assert.notStrictEqual((await writeViewer(single(other), {})).status, 'written');
  assert.notStrictEqual((await writeViewer(single(other), { force: true })).status, 'written');
  assert.deepStrictEqual(hashTree(other), linked);
});

test('viewer-check.gif or viewer-files that are not ours fail the archive and stay as they are', async () => {
  const { writeViewer } = tool();
  const marked = '<meta name="generator" content="Claude Takeout">';
  const gif = Buffer.from(CTViewer.VIEWER_CHECK_BASE64, 'base64');
  const cases = [
    ['a gif that is not ours, with no viewer', { 'viewer-check.gif': Buffer.concat([gif, Buffer.from('x')]) }, false, /viewer-check\.gif/],
    ['parts with no viewer', { 'viewer-files/part-0001.js': 'x' }, false, /viewer-files/],
    ['owner gif beside a marked viewer', { 'viewer.html': marked, 'viewer-check.gif': 'my drawing' }, true, /viewer-check\.gif/],
    ['owner notes in viewer-files', { 'viewer.html': marked, 'viewer-files/notes.md': 'mine' }, true, /viewer-files/],
    ['a file called viewer-files', { 'viewer.html': marked, 'viewer-files': 'mine' }, true, /viewer-files/],
  ];
  for (const [label, files, force, reason] of cases) {
    const root = tmpRoot();
    put(root, 'original.json', chatJson('s1'));
    put(root, 'note.md', 'added');
    for (const [rel, body] of Object.entries(files)) put(root, rel, body);
    const before = hashTree(root);
    const res = await writeViewer(single(root), { force });
    assert.strictEqual(res.status, 'failed', label);
    assert.match(res.reason, reason, label);
    assert.deepStrictEqual(hashTree(root), before, label);
  }
});

test('an old mega with no projects folder gets one viewer at its root with all its chats', async () => {
  const { writeViewer } = tool();
  const root = tmpRoot();
  put(root, 'index.md', '# index');
  put(root, 'renamed folder/original.json', chatJson('c1'));
  put(root, 'renamed folder/synthesis/a.md', 'in a chat');
  put(root, 'other/original.json', chatJson('c2'));
  put(root, '_root note.md', 'at the root');
  const before = hashTree(root);
  const res = await writeViewer(single(root), {});
  assert.strictEqual(res.status, 'written', res.reason);
  assert.strictEqual(res.chats, 2);
  const after = hashTree(root);
  assertKept(before, after);
  assert.deepStrictEqual(newEntries(before, after).filter(k => !OWN_FILES.test(k)), []);
  const data = viewerData(root);
  assert.deepStrictEqual(data.chats.map(c => c.id).sort(), ['c1', 'c2']);
  const byPath = Object.fromEntries(data.added.map(a => [a.path, a]));
  assert.strictEqual(byPath['_root note.md'].chat, null);
  assert.strictEqual(byPath['renamed folder/synthesis/a.md'].chat, 'c1');
  assert.strictEqual(byPath['renamed folder/synthesis/a.md'].href, 'renamed%20folder/synthesis/a.md');
});

test('one bad original.json: the rest get a viewer and it is reported; exit 1', () => {
  const tmp = tmpRoot();
  put(tmp, 'index.md', '# index');
  put(tmp, 'good/original.json', chatJson('c1'));
  put(tmp, 'bad/original.json', '{"uuid": "broken", "chat_mess');
  put(tmp, 'bad/notes.md', 'still here');
  const before = hashTree(tmp);
  const r = cli(tmp, '--json');
  assert.strictEqual(r.status, 1, r.stderr);
  const [a] = JSON.parse(r.stdout).archives;
  assert.strictEqual(a.status, 'written');
  assert.strictEqual(a.chats, 1);
  assert.deepStrictEqual(a.failedChats.map(c => c.chat), ['bad']);
  assertKept(before, hashTree(tmp));
  const data = viewerData(tmp);
  assert.deepStrictEqual(data.chats.map(c => c.id), ['c1']);
  assert.deepStrictEqual(data.added.map(x => [x.path, x.chat]), [['bad/notes.md', null]]);
  assert.match(cli(tmp, '--force').stdout, /bad/);
});

test('every chat bad: no viewer, the archive is failed, and the next one still runs', () => {
  const tmp = tmpRoot();
  put(tmp, 'a/original.json', 'nope');
  put(tmp, 'b/original.json', chatJson('c2'));
  const r = cli(tmp, '--json');
  assert.strictEqual(r.status, 1);
  const { archives } = JSON.parse(r.stdout);
  assert.deepStrictEqual(archives.map(a => a.status), ['failed', 'written']);
  assert.ok(!fs.existsSync(path.join(tmp, 'a/viewer.html')));
  assert.ok(fs.existsSync(path.join(tmp, 'b/viewer.html')));
});

test('a read-only archive fails with no temp files, and the next archive runs', { skip: process.getuid && process.getuid() === 0 }, () => {
  const tmp = tmpRoot();
  richSingle(path.join(tmp, 'a'));
  put(tmp, 'b/original.json', chatJson('c2'));
  const before = hashTree(path.join(tmp, 'a'));
  fs.chmodSync(path.join(tmp, 'a'), 0o555);
  try {
    const r = cli(tmp, '--json');
    assert.strictEqual(r.status, 1, r.stderr);
    const { archives } = JSON.parse(r.stdout);
    assert.deepStrictEqual(archives.map(a => a.status), ['failed', 'written']);
    assert.ok(archives[0].reason);
    assert.deepStrictEqual(hashTree(path.join(tmp, 'a')), before);
  } finally { fs.chmodSync(path.join(tmp, 'a'), 0o755); }
  assert.ok(fs.existsSync(path.join(tmp, 'b/viewer.html')));
});

test('a write failure leaves no viewer, no parts and no temps', async t => {
  const { writeViewer } = tool();
  const root = richSingle(tmpRoot());
  const before = hashTree(root);
  const real = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', function (target, data, ...rest) {
    if (typeof target === 'number' && String(data).includes('Content-Security-Policy')) {
      real(target, String(data).slice(0, 100));
      throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    }
    return real(target, data, ...rest);
  });
  const res = await writeViewer(single(root), {});
  t.mock.restoreAll();
  assert.strictEqual(res.status, 'failed');
  assert.match(res.reason, /no space/);
  assert.deepStrictEqual(hashTree(root), before);
});

test('a failed rename at each step leaves a new archive as it was', async t => {
  const { writeViewer } = tool();
  const real = fs.renameSync;
  for (const failing of ['viewer-files', 'viewer-check.gif', 'viewer.html']) {
    const root = richSingle(tmpRoot());
    const before = hashTree(root);
    t.mock.method(fs, 'renameSync', (from, to) => {
      if (path.basename(to) === failing) throw Object.assign(new Error('rename blocked'), { code: 'EIO' });
      return real(from, to);
    });
    const res = await writeViewer(single(root), {});
    t.mock.restoreAll();
    assert.strictEqual(res.status, 'failed', failing);
    assert.deepStrictEqual(hashTree(root), before, failing);
  }
});

test('--force: a failure puts the old viewer and parts back', async t => {
  const { writeViewer } = tool();
  const real = fs.renameSync;
  for (const failing of ['viewer-files', 'viewer.html']) {
    const root = richSingle(tmpRoot());
    assert.strictEqual((await writeViewer(single(root), {})).status, 'written');
    const before = hashTree(root);
    let blocked = false;
    t.mock.method(fs, 'renameSync', (from, to) => {
      if (!blocked && path.basename(to) === failing && from.includes('.tmp-')) {
        blocked = true;
        throw Object.assign(new Error('rename blocked'), { code: 'EIO' });
      }
      return real(from, to);
    });
    const res = await writeViewer(single(root), { force: true });
    t.mock.restoreAll();
    assert.strictEqual(res.status, 'failed', failing);
    assert.ok(blocked);
    assert.deepStrictEqual(hashTree(root), before, failing);
  }
});

test('a leftover temp from another run is reported, and never reused or removed', async () => {
  const { writeViewer } = tool();
  const root = richSingle(tmpRoot());
  put(root, `viewer-files.tmp-${process.pid}/mine.txt`, 'not this run');
  const before = hashTree(root);
  const res = await writeViewer(single(root), {});
  assert.strictEqual(res.status, 'failed');
  assert.deepStrictEqual(hashTree(root), before);
});

test('ZIP: extracted to <out>/<zip name>, viewer there, the ZIP itself unchanged', async () => {
  const tmp = tmpRoot();
  const input = path.join(tmp, 'in');
  fs.mkdirSync(input);
  await makeZip(input, z => { z.file('original.json', chatJson('z1')); z.file('Übergröße.md', 'hallo'); }, 'single.zip');
  await makeZip(input, z => { z.file('index.md', '# i'); z.file('c1/original.json', chatJson('m1')); z.file('c2/original.json', chatJson('m2')); }, 'mega.zip');
  await makeZip(input, z => { z.file('wrapper/original.json', chatJson('w1')); }, 'wrapped.ZIP');
  put(input, 'folder/original.json', chatJson('f1'));
  const zipsBefore = hashTree(input);
  const out = path.join(tmp, 'out');
  const r = cli(input, '--out', out, '--json');
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  const report = JSON.parse(r.stdout);
  assertKept(zipsBefore, hashTree(input));
  assert.ok(fs.existsSync(path.join(input, 'folder/viewer.html')));
  assert.deepStrictEqual(viewerData(path.join(out, 'single')).chats.map(c => c.id), ['z1']);
  assert.deepStrictEqual(viewerData(path.join(out, 'single')).added.map(a => a.path), ['Übergröße.md']);
  assert.deepStrictEqual(viewerData(path.join(out, 'mega')).chats.map(c => c.id).sort(), ['m1', 'm2']);
  assert.ok(fs.existsSync(path.join(out, 'wrapped/wrapper/viewer.html')));
  assert.deepStrictEqual(report.zips.map(z => z.status), ['written', 'written', 'written']);
  // Folders first, then ZIPs.
  assert.strictEqual(report.archives.length, 1);
  assert.strictEqual(report.archives[0].root, path.join(input, 'folder'));
  assert.strictEqual(report.zips[0].archives.length, 1);
});

test('ZIPs with no --out: clear message, exit 1, folders still processed', async () => {
  const tmp = tmpRoot();
  await makeZip(tmp, z => z.file('original.json', chatJson('z1')), 'a.zip');
  put(tmp, 'folder/original.json', chatJson('f1'));
  const r = cli(tmp);
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /--out/);
  assert.ok(fs.existsSync(path.join(tmp, 'folder/viewer.html')));
  assert.ok(!fs.existsSync(path.join(tmp, 'a')));
});

test('an out folder that exists is reported and left alone', async () => {
  const tmp = tmpRoot();
  const input = path.join(tmp, 'in');
  fs.mkdirSync(input);
  await makeZip(input, z => z.file('original.json', chatJson('z1')), 'a.zip');
  const out = path.join(tmp, 'out');
  put(out, 'a/mine.md', 'keep');
  const before = hashTree(out);
  const r = cli(input, '--out', out, '--json');
  assert.strictEqual(r.status, 0, r.stderr);
  const [z] = JSON.parse(r.stdout).zips;
  assert.strictEqual(z.status, 'skipped');
  assert.match(z.reason, /exists/);
  assert.match(z.reason, /run the tool on that folder/);
  assert.deepStrictEqual(hashTree(out), before);
});

test('a ZIP with no Claude chat is skipped without extracting; a broken ZIP fails alone', async () => {
  const tmp = tmpRoot();
  const input = path.join(tmp, 'in');
  fs.mkdirSync(input);
  await makeZip(input, z => z.file('conversation.json', '{}'), 'gemini.zip');
  await makeZip(input, z => z.file('not_original.json', '{}'), 'near.zip');
  put(input, 'broken.zip', 'not a zip');
  await makeZip(input, z => z.file('original.json', chatJson('z1')), 'zgood.zip');
  const out = path.join(tmp, 'out');
  const r = cli(input, '--out', out, '--json');
  assert.strictEqual(r.status, 1);
  const zips = Object.fromEntries(JSON.parse(r.stdout).zips.map(z => [path.basename(z.zip), z]));
  assert.strictEqual(zips['gemini.zip'].status, 'skipped');
  assert.strictEqual(zips['near.zip'].status, 'skipped');
  assert.strictEqual(zips['broken.zip'].status, 'failed');
  assert.strictEqual(zips['zgood.zip'].status, 'written');
  assert.deepStrictEqual(fs.readdirSync(out), ['zgood']);
});

test('a ZIP that would not fit is reported and the others run', async t => {
  const { run } = tool();
  const tmp = tmpRoot();
  const input = path.join(tmp, 'in');
  fs.mkdirSync(input);
  await makeZip(input, z => z.file('original.json', chatJson('z1')), 'a.zip');
  await makeZip(input, z => z.file('original.json', chatJson('z2')), 'b.zip');
  const out = path.join(tmp, 'out');
  t.mock.method(zipLib, 'zipFreeSpaceOk', async zp => (zp.endsWith('a.zip') ? { ok: false, needed: 2e9, free: 1e6 } : { ok: true, needed: 1, free: 2 }));
  const report = await run(input, { out });
  assert.deepStrictEqual(report.zips.map(z => z.status), ['failed', 'written']);
  assert.match(report.zips[0].reason, /space/);
  assert.strictEqual(report.ok, false);
  assert.ok(!fs.existsSync(path.join(out, 'a')));
  assert.ok(fs.existsSync(path.join(out, 'b/viewer.html')));
});

test('dry run on ZIPs reports the extraction and free space, and writes nothing', async () => {
  const tmp = tmpRoot();
  const input = path.join(tmp, 'in');
  fs.mkdirSync(input);
  await makeZip(input, z => z.file('original.json', chatJson('z1')), 'a.zip');
  const before = hashTree(tmp);
  const out = path.join(tmp, 'out');
  const r = cli(input, '--out', out, '--dry-run', '--json');
  assert.strictEqual(r.status, 0, r.stderr);
  const [z] = JSON.parse(r.stdout).zips;
  assert.strictEqual(z.status, 'written');
  assert.strictEqual(z.dest, path.join(out, 'a'));
  assert.strictEqual(z.space.ok, true);
  assert.strictEqual(z.chats, 1);
  assert.deepStrictEqual(hashTree(tmp), before);
});

test('--out inside the folder is not rescanned; --out holding the folder is refused', async () => {
  const tmp = tmpRoot();
  const input = path.join(tmp, 'in');
  fs.mkdirSync(input);
  await makeZip(input, z => z.file('original.json', chatJson('z1')), 'a.zip');
  const out = path.join(input, 'out');
  assert.strictEqual(cli(input, '--out', out).status, 0);
  const second = JSON.parse(cli(input, '--out', out, '--json').stdout);
  assert.deepStrictEqual(second.archives, []);
  assert.strictEqual(second.zips[0].status, 'skipped');
  const before = hashTree(tmp);
  for (const bad of [input, tmp]) {
    const r = cli(input, '--out', bad);
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /--out/);
  }
  assert.deepStrictEqual(hashTree(tmp), before);
});

test('dry run resolves a new --out through a linked parent', () => {
  const tmp = fs.realpathSync(tmpRoot());
  put(tmp, 'in/one/original.json', chatJson('c1'));
  fs.symlinkSync(path.join(tmp, 'in'), path.join(tmp, 'link'));
  const r = cli(path.join(tmp, 'in'), '--out', path.join(tmp, 'link'), '--dry-run');
  assert.strictEqual(r.status, 1, 'the link resolves to the folder itself');
  assert.match(r.stderr, /--out/);
  const ok = cli(path.join(tmp, 'in'), '--out', path.join(tmp, 'link', 'new', 'out'), '--dry-run', '--json');
  assert.strictEqual(ok.status, 0, ok.stderr);
  assert.strictEqual(JSON.parse(ok.stdout).archives.length, 1);
});

test('plain report: a line per archive, then capped missing files, then skipped folders', () => {
  const tmp = tmpRoot();
  const uploads = Array.from({ length: 30 }, (_, i) => ({ success: true, file_name: `f${i}.pdf`, file_uuid: 'u' + i }));
  put(tmp, 'a/original.json', chatJson('c1', 'One', { chat_messages: [{ uuid: 'm', sender: 'human', content: [], files_v2: uploads }] }));
  put(tmp, 'gemini/conversation.json', '{}');
  put(tmp, 'gemini/original.json', '{}');
  const r = cli(tmp);
  assert.strictEqual(r.status, 0, r.stderr);
  const lines = r.stdout.split('\n');
  assert.match(lines[0], /^written: .*\/a \(1 chat, 30 missing\)$/);
  const m = lines.indexOf('Missing files:');
  const s = lines.indexOf('Skipped:');
  assert.ok(m > 0 && s > m, r.stdout);
  assert.ok(lines.slice(m, s).filter(l => /f\d+\.pdf/.test(l)).length < 30);
  assert.ok(lines.some(l => /and \d+ more/.test(l)));
  assert.match(lines[s + 1], /gemini: not a Claude chat/);
});

test('command line: usage errors exit 1, and --json prints one object', () => {
  assert.strictEqual(cli().status, 1);
  assert.strictEqual(cli('--nope', 'x').status, 1);
  assert.strictEqual(cli(path.join(tmpRoot(), 'missing')).status, 1);
  const tmp = tmpRoot();
  put(tmp, 'x/original.json', chatJson('c1'));
  const r = cli(tmp, '--json');
  assert.deepStrictEqual(Object.keys(JSON.parse(r.stdout)).sort(), ['archives', 'dryRun', 'folder', 'force', 'notRun', 'ok', 'out', 'skipped', 'stopped', 'zips']);
  assert.strictEqual(JSON.parse(cli(path.join(tmp, 'missing'), '--json').stdout).ok, false);
});

test('tool can be imported without running', () => {
  const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(TOOL_PATH)})`], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout + r.stderr, '');
});

test('--force: viewer-files is ours only if every entry is a real part or system junk', async () => {
  const { writeViewer } = tool();
  const marked = '<meta name="generator" content="Claude Takeout">';
  const good = 'window.__archivePart(1, {});';
  const refused = [
    ['owner part-0001.js', { 'viewer-files/part-0001.js': 'my own script' }],
    ['owner file beside a real part', { 'viewer-files/part-0001.js': good, 'viewer-files/part-0002.js': 'mine' }],
    ['empty part', { 'viewer-files/part-0001.js': '' }],
    ['a file called node_modules', { 'viewer-files/part-0001.js': good, 'viewer-files/node_modules': 'mine' }],
    ['.git', { 'viewer-files/part-0001.js': good, 'viewer-files/.git': 'mine' }],
    ['a folder called Thumbs.db', { 'viewer-files/Thumbs.db/x': 'mine' }],
  ];
  for (const [label, files] of refused) {
    const root = tmpRoot();
    put(root, 'original.json', chatJson('s1'));
    put(root, 'viewer.html', marked);
    for (const [rel, body] of Object.entries(files)) put(root, rel, body);
    const before = hashTree(root);
    const res = await writeViewer(single(root), { force: true });
    assert.strictEqual(res.status, 'failed', label);
    assert.match(res.reason, /viewer-files/, label);
    assert.deepStrictEqual(hashTree(root), before, label);
  }
  const root = tmpRoot();
  put(root, 'original.json', chatJson('s1'));
  put(root, 'viewer.html', marked);
  for (const name of ['part-0001.js']) put(root, 'viewer-files/' + name, good);
  put(root, 'viewer-files/.DS_Store', 'junk');
  put(root, 'viewer-files/Thumbs.db', 'junk');
  assert.strictEqual((await writeViewer(single(root), { force: true })).status, 'written');
  assert.ok(!fs.existsSync(path.join(root, 'viewer-files')));
});

const zipStatus = r => Object.fromEntries(JSON.parse(r.stdout).zips.map(z => [path.relative(path.dirname(path.dirname(z.zip)), z.zip), z]));
const twoFolders = () => {
  const tmp = tmpRoot();
  fs.mkdirSync(path.join(tmp, 'in', 'a'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'in', 'b'), { recursive: true });
  return { tmp, input: path.join(tmp, 'in'), out: path.join(tmp, 'out') };
};

test('a ZIP that was not extracted does not claim its name', async () => {
  const { input, out } = twoFolders();
  await makeZip(path.join(input, 'a'), z => z.file('conversation.json', '{}'), 'x.zip');
  await makeZip(path.join(input, 'b'), z => z.file('original.json', chatJson('real')), 'x.zip');
  const r = cli(input, '--out', out, '--json');
  assert.strictEqual(r.status, 0, r.stderr);
  const z = zipStatus(r);
  assert.strictEqual(z['a/x.zip'].status, 'skipped');
  assert.match(z['a/x.zip'].reason, /no Claude chat/);
  assert.strictEqual(z['b/x.zip'].status, 'written');
  assert.deepStrictEqual(viewerData(path.join(out, 'x')).chats.map(c => c.id), ['real']);

  const broken = twoFolders();
  put(broken.input, 'a/x.zip', 'not a zip');
  await makeZip(path.join(broken.input, 'b'), z2 => z2.file('original.json', chatJson('real')), 'x.zip');
  const r2 = cli(broken.input, '--out', broken.out, '--json');
  assert.strictEqual(r2.status, 1);
  const z2 = zipStatus(r2);
  assert.strictEqual(z2['a/x.zip'].status, 'failed');
  assert.ok(!/exists/.test(z2['a/x.zip'].reason));
  assert.strictEqual(z2['b/x.zip'].status, 'written');
});

test('two real ZIPs with one name: the second fails and names the first, in a real run and a dry run', async () => {
  for (const args of [[], ['--dry-run']]) {
    const { input, out } = twoFolders();
    await makeZip(path.join(input, 'a'), z => z.file('original.json', chatJson('one')), 'x.zip');
    await makeZip(path.join(input, 'b'), z => z.file('original.json', chatJson('two')), 'X.ZIP');
    const r = cli(input, '--out', out, '--json', ...args);
    assert.strictEqual(r.status, 1, r.stdout);
    const z = zipStatus(r);
    assert.strictEqual(z['a/x.zip'].status, 'written');
    assert.strictEqual(z['b/X.ZIP'].status, 'failed');
    assert.ok(z['b/X.ZIP'].reason.includes(path.join(input, 'a', 'x.zip')), z['b/X.ZIP'].reason);
    if (!args.length) assert.deepStrictEqual(viewerData(path.join(out, 'x')).chats.map(c => c.id), ['one']);
  }
  // A later ZIP with no chat in it is not a clash.
  const { input, out } = twoFolders();
  await makeZip(path.join(input, 'a'), z => z.file('original.json', chatJson('one')), 'x.zip');
  await makeZip(path.join(input, 'b'), z => z.file('notes.txt', 'n'), 'x.zip');
  assert.strictEqual(cli(input, '--out', out).status, 0);
});

test('an export inside an archive stays an added file, with a warning', async () => {
  const nested = 'Another export is inside this archive at ';
  const mega = tmpRoot();
  put(mega, 'index.md', '# i');
  put(mega, 'c1/original.json', chatJson('c1'));
  put(mega, 'inner/c2/original.json', chatJson('c2'));
  put(mega, 'c1/old/original.json', chatJson('c3'));
  const r = cli(mega, '--json');
  assert.strictEqual(r.status, 0, r.stderr);
  const [a] = JSON.parse(r.stdout).archives;
  assert.deepStrictEqual(a.notices.filter(w => w.startsWith(nested)).sort(), [
    `${nested}c1/old; run the tool on that folder.`, `${nested}inner/c2; run the tool on that folder.`]);
  assert.deepStrictEqual(viewerData(mega).added.map(x => x.path), ['c1/old/original.json', 'inner/c2/original.json']);
  assert.deepStrictEqual(viewerData(mega).chats.map(c => c.id), ['c1']);

  const one = tmpRoot();
  put(one, 'original.json', chatJson('s'));
  put(one, 'kept/original.json', chatJson('k'));
  const plain = cli(one, '--dry-run');
  assert.ok(plain.stdout.includes(`Needs attention:\n  ${one} (1):\n    ${nested}kept; run the tool on that folder.`), plain.stdout);
});

test('leftovers from a killed run are reported, untouched and not added files', async () => {
  const leftovers = ['viewer.html.tmp-11', 'viewer-check.gif.tmp-12', 'viewer-files.tmp-13/part-0001.js', 'viewer-files.old-14/part-0001.js'];
  const tmp = tmpRoot();
  put(tmp, 'a/original.json', chatJson('c1'));
  put(tmp, 'a/note.md', 'mine');
  put(tmp, 'a/viewer.html.tmp-x', 'owner name, no digits');
  put(tmp, 'a/deep/viewer.html.tmp-15', 'not at the root');
  for (const rel of leftovers) put(tmp, 'a/' + rel, 'left');
  put(tmp, 'b/original.json', chatJson('c2'));
  put(tmp, 'b/viewer.html', '<h1>mine</h1>');
  put(tmp, 'b/viewer-files.tmp-16/part-0001.js', 'left');
  const before = hashTree(path.join(tmp, 'a'));
  const r = cli(tmp, '--json');
  assert.strictEqual(r.status, 0, r.stderr);
  const [a, b] = JSON.parse(r.stdout).archives;
  assert.strictEqual(a.notices.filter(w => /viewer.*\.(tmp|old)-\d+/.test(w)).length, 4);
  assert.strictEqual(b.status, 'skipped');
  assert.strictEqual(b.notices.length, 1, 'warned even when skipped');
  assertKept(before, hashTree(path.join(tmp, 'a')));
  assert.deepStrictEqual(viewerData(path.join(tmp, 'a')).added.map(x => x.path), ['deep/viewer.html.tmp-15', 'note.md', 'viewer.html.tmp-x']);
  assert.match(cli(tmp).stdout, /Needs attention:[\s\S]*viewer-files\.tmp-16/);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`${signal} while parts are written: cleanup runs, nothing changes, exit is non-zero`, async () => {
    const tmp = tmpRoot();
    put(tmp, 'a/original.json', chatJson('c1'));
    const body = 'x'.repeat(30 * 1024);
    for (let i = 0; i < 1000; i++) put(tmp, `a/notes/n${i}.md`, body);
    put(tmp, 'b/original.json', chatJson('c2'));
    const before = hashTree(tmp);
    const child = spawn(process.execPath, [TOOL_PATH, tmp, '--json'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let closed = false;
    child.stdout.on('data', d => { stdout += d; });
    const done = new Promise(resolve => child.on('close', code => { closed = true; resolve(code); }));
    const temp = path.join(tmp, 'a', `viewer-files.tmp-${child.pid}`);
    while (!closed && !fs.existsSync(temp)) await new Promise(resolve => setTimeout(resolve, 1));
    assert.ok(!closed, 'the run ended before the signal could be sent');
    child.kill(signal);
    assert.notStrictEqual(await done, 0);
    assert.deepStrictEqual(hashTree(tmp), before);
    const report = JSON.parse(stdout);
    assert.strictEqual(report.stopped, true);
    assert.strictEqual(report.ok, false);
    assert.deepStrictEqual(report.archives.map(x => x.status), ['failed']);
    assert.deepStrictEqual(report.notRun, [path.join(tmp, 'b')]);
  });
}

test('an unreadable folder makes exit 1', { skip: process.getuid && process.getuid() === 0 }, () => {
  const tmp = tmpRoot();
  put(tmp, 'ok/original.json', chatJson('c1'));
  put(tmp, 'locked/x.txt', 'x');
  fs.chmodSync(path.join(tmp, 'locked'), 0);
  try {
    const r = cli(tmp);
    assert.strictEqual(r.status, 1);
    assert.match(r.stdout, /locked: unreadable/);
  } finally { fs.chmodSync(path.join(tmp, 'locked'), 0o755); }
  assert.ok(fs.existsSync(path.join(tmp, 'ok/viewer.html')));
});

test('refused ZIP entries are listed, capped, and make exit 1', () => {
  const tmp = tmpRoot();
  const input = path.join(tmp, 'in');
  fs.mkdirSync(input);
  const bad = Array.from({ length: 25 }, (_, i) => [`../evil${i}.txt`, 'x']);
  fs.writeFileSync(path.join(input, 'a.zip'), rawZip([['original.json', chatJson('z1')], ...bad]));
  const out = path.join(tmp, 'out');
  const json = cli(input, '--out', out, '--json');
  assert.strictEqual(json.status, 1);
  assert.strictEqual(JSON.parse(json.stdout).zips[0].rejected.length, 25);
  assert.ok(fs.existsSync(path.join(out, 'a/viewer.html')));
  const out2 = path.join(tmp, 'out2');
  const plain = cli(input, '--out', out2);
  assert.strictEqual(plain.status, 1);
  assert.match(plain.stdout, /Refused ZIP entries:/);
  assert.match(plain.stdout, /\.\.\/evil0\.txt/);
  assert.match(plain.stdout, /and 5 more/);
});

test('--out inside an archive is refused, and nothing is created', async () => {
  const tmp = tmpRoot();
  const input = path.join(tmp, 'in');
  put(input, 'one/original.json', chatJson('s'));
  put(input, 'one/synthesis/note.md', 'mine');
  put(input, 'mega/index.md', '# i');
  put(input, 'mega/c1/original.json', chatJson('c1'));
  await makeZip(input, z => z.file('original.json', chatJson('z1')), 'a.zip');
  const before = hashTree(tmp);
  for (const rel of ['one', 'one/new', 'one/synthesis', 'one/synthesis/deep', 'mega', 'mega/c1', 'mega/new']) {
    for (const extra of [[], ['--dry-run']]) {
      const r = cli(input, '--out', path.join(input, rel), ...extra);
      assert.strictEqual(r.status, 1, rel);
      assert.match(r.stderr, /--out.*archive/, rel);
      assert.deepStrictEqual(hashTree(tmp), before, rel);
    }
  }
});

test('a clash shows on a re-run: the second ZIP fails and names the first', async () => {
  const { input, out } = twoFolders();
  const first = path.join(input, 'a', 'x.zip');
  await makeZip(path.join(input, 'a'), z => z.file('original.json', chatJson('one')), 'x.zip');
  await makeZip(path.join(input, 'b'), z => z.file('original.json', chatJson('two')), 'x.zip');
  assert.strictEqual(cli(input, '--out', out).status, 1);
  const before = hashTree(out);
  const r = cli(input, '--out', out, '--json');
  assert.strictEqual(r.status, 1, r.stdout);
  const z = zipStatus(r);
  assert.strictEqual(z['a/x.zip'].status, 'skipped');
  assert.match(z['a/x.zip'].reason, /run the tool on that folder/);
  assert.strictEqual(z['b/x.zip'].status, 'failed');
  assert.ok(z['b/x.zip'].reason.includes(first), z['b/x.zip'].reason);
  assert.ok(!/run the tool on that folder/.test(z['b/x.zip'].reason));
  assert.deepStrictEqual(hashTree(out), before);
});

test('a clash shows when the out folder was there before the first run', async () => {
  const { input, out } = twoFolders();
  const first = path.join(input, 'a', 'x.zip');
  await makeZip(path.join(input, 'a'), z => z.file('original.json', chatJson('one')), 'x.zip');
  await makeZip(path.join(input, 'b'), z => z.file('original.json', chatJson('two')), 'x.zip');
  put(out, 'x/mine.md', 'keep');
  const before = hashTree(out);
  for (const extra of [[], ['--dry-run']]) {
    const r = cli(input, '--out', out, '--json', ...extra);
    assert.strictEqual(r.status, 1, r.stdout);
    const z = zipStatus(r);
    assert.strictEqual(z['a/x.zip'].status, 'skipped');
    assert.strictEqual(z['b/x.zip'].status, 'failed');
    assert.ok(z['b/x.zip'].reason.includes(first));
  }
  assert.deepStrictEqual(hashTree(out), before);
});

test('nested-export and leftover warnings are never cut, and print first', () => {
  const tmp = tmpRoot();
  put(tmp, 'index.md', '# i');
  for (let i = 0; i < 25; i++) {
    put(tmp, `c${i}/original.json`, chatJson('c' + i));
    put(tmp, `c${i}/project/project.json`, '{ broken');
  }
  for (let i = 0; i < 30; i++) put(tmp, `kept/old${i}/original.json`, chatJson('k' + i));
  put(tmp, 'viewer-files.tmp-99/part-0001.js', 'left');
  const { stdout, status } = cli(tmp);
  assert.strictEqual(status, 0, stdout);
  const lines = stdout.split('\n');
  assert.strictEqual(lines.filter(l => l.includes('Another export is inside this archive at ')).length, 30);
  assert.ok(lines.some(l => l.includes('viewer-files.tmp-99')));
  const notice = lines.indexOf('Needs attention:');
  const warn = lines.indexOf('Warnings:');
  assert.ok(notice > 0 && warn > notice, stdout);
  assert.deepStrictEqual(lines.filter(l => /^\S.*:$/.test(l)).slice(0, 2), ['Needs attention:', 'Warnings:']);
  assert.ok(lines.slice(warn).some(l => /and 5 more/.test(l)));
  assert.match(lines[0], /\(25 chats, 30 added, 56 warnings\)$/);
});

test('a nested export in a skipped or refused archive still gets its warning', async () => {
  const { writeViewer } = tool();
  const root = tmpRoot();
  put(root, 'original.json', chatJson('s'));
  put(root, 'kept/original.json', chatJson('k'));
  put(root, 'viewer.html', '<h1>mine</h1>');
  const nested = 'Another export is inside this archive at kept; run the tool on that folder.';
  for (const force of [false, true]) {
    const res = await writeViewer(single(root), { force });
    assert.notStrictEqual(res.status, 'written');
    assert.deepStrictEqual(res.notices, [nested]);
  }
});

test('--out inside an archive outside the input is refused, at any depth', () => {
  const tmp = tmpRoot();
  const input = path.join(tmp, 'in');
  put(input, 'a/original.json', chatJson('a'));
  put(tmp, 'other/one/original.json', chatJson('s'));
  put(tmp, 'other/mega/index.md', '# i');
  put(tmp, 'other/mega/c1/original.json', chatJson('c1'));
  put(tmp, 'other/plain/index.md', 'an index with no chats');
  const before = hashTree(tmp);
  for (const rel of ['other/one', 'other/one/new', 'other/one/new/deep', 'other/mega', 'other/mega/new/deep']) {
    const r = cli(input, '--out', path.join(tmp, rel));
    assert.strictEqual(r.status, 1, rel);
    assert.match(r.stderr, /--out.*archive/, rel);
    assert.deepStrictEqual(hashTree(tmp), before, rel);
  }
  assert.strictEqual(cli(input, '--out', path.join(tmp, 'other/plain/new'), '--dry-run').status, 0);
  assert.strictEqual(cli(input, '--out', path.join(tmp, 'elsewhere')).status, 0);
});

const foldsCase = dir => fs.existsSync(path.join(path.dirname(dir), path.basename(dir).toUpperCase()));

test('--out checks ignore the typed case on a disk that folds it', { skip: !foldsCase(fs.mkdtempSync(path.join(os.tmpdir(), 'case-probe-'))) }, async () => {
  const tmp = tmpRoot();
  const input = path.join(tmp, 'in');
  put(input, 'one/original.json', chatJson('s'));
  await makeZip(input, z => z.file('original.json', chatJson('z1')), 'a.zip');
  const before = hashTree(tmp);
  for (const [out, why] of [[path.join(input, 'ONE', 'new'), /archive/], [path.join(input, 'ONE'), /archive/], [path.join(tmp, 'IN'), /scanned/], [path.join(tmp, 'IN', 'ONE', 'x', 'y'), /archive/]]) {
    const r = cli(input, '--out', out);
    assert.strictEqual(r.status, 1, out);
    assert.match(r.stderr, why, out);
    assert.deepStrictEqual(hashTree(tmp), before, out);
  }
  // The scan sees the folder under its true name, whatever case the input was typed in.
  const out = path.join(input, 'out');
  assert.strictEqual(cli(input, '--out', out).status, 0);
  const second = JSON.parse(cli(path.join(tmp, 'IN'), '--out', out, '--json').stdout);
  assert.ok(!second.archives.some(a => a.root.toLowerCase().includes(`${path.sep}out${path.sep}`)), JSON.stringify(second.archives));
});

test('names from an archive cannot forge a report line or reach the terminal raw', async () => {
  const tmp = tmpRoot();
  const input = path.join(tmp, 'in');
  fs.mkdirSync(input);
  const evil = 'x\nwritten: /forged\u001b[31m\u0085\u2028';
  fs.writeFileSync(path.join(input, 'a.zip'), rawZip([['original.json', chatJson('z1')], [`../${evil}.txt`, 'x']]));
  const upload = { success: true, file_name: `${evil}.pdf`, file_uuid: 'u1' };
  put(input, `f${evil}/original.json`, chatJson('c1', 'One', { chat_messages: [{ uuid: 'm', sender: 'human', content: [], files_v2: [upload] }] }));
  put(input, `f${evil}/kept${evil}/original.json`, chatJson('c2'));
  const { stdout, status } = cli(input, '--out', path.join(tmp, 'out'));
  assert.strictEqual(status, 1);
  assert.ok(!/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/.test(stdout), JSON.stringify(stdout));
  assert.ok(!stdout.split('\n').some(l => /^\s*written: \/forged/.test(l)), stdout);
  assert.ok(stdout.includes('x\\u000awritten: /forged\\u001b[31m'), stdout);
  for (const heading of ['Refused ZIP entries:', 'Missing files:', 'Needs attention:']) assert.ok(stdout.includes(heading), heading);
});

test('a stop during extraction says what was really done', async () => {
  const tmp = tmpRoot();
  const input = path.join(tmp, 'in');
  fs.mkdirSync(input);
  await makeZip(input, z => {
    z.file('original.json', chatJson('z1'));
    for (let i = 0; i < 3000; i++) z.file(`notes/n${i}.md`, 'x'.repeat(4096));
  }, 'big.zip');
  const out = path.join(tmp, 'out');
  const dest = path.join(out, 'big');
  const child = spawn(process.execPath, [TOOL_PATH, input, '--out', out, '--json'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let closed = false;
  child.stdout.on('data', d => { stdout += d; });
  const done = new Promise(resolve => child.on('close', code => { closed = true; resolve(code); }));
  while (!closed && !fs.existsSync(dest + '.partial')) await new Promise(resolve => setTimeout(resolve, 1));
  assert.ok(!closed, 'the run ended before the signal could be sent');
  child.kill('SIGINT');
  assert.notStrictEqual(await done, 0);
  const [z] = JSON.parse(stdout).zips;
  assert.strictEqual(z.status, 'failed');
  assert.ok(z.reason.includes(dest), z.reason);
  assert.match(z.reason, /extracted/);
  assert.ok(!/nothing was changed/.test(z.reason), z.reason);
  assert.ok(fs.existsSync(path.join(dest, 'original.json')));
  assert.ok(!fs.existsSync(path.join(dest, 'viewer.html')));
});

test('--force keeps the aside folder if a file appeared in it during the run', async t => {
  const { writeViewer } = tool();
  const root = richSingle(tmpRoot());
  assert.strictEqual((await writeViewer(single(root), {})).status, 'written');
  const real = fs.renameSync;
  let aside = null;
  t.mock.method(fs, 'renameSync', (from, to) => {
    real(from, to);
    if (/viewer-files\.old-\d+$/.test(to)) { aside = to; fs.writeFileSync(path.join(to, 'dropped.md'), 'mine'); }
  });
  const res = await writeViewer(single(root), { force: true });
  t.mock.restoreAll();
  assert.strictEqual(res.status, 'written', res.reason);
  assert.ok(aside && fs.readFileSync(path.join(aside, 'dropped.md'), 'utf8') === 'mine');
  assert.ok(res.notices.some(n => n.includes(path.basename(aside))), JSON.stringify(res));
});

// ---- final review fixes ----
test('a non-chat original.json over 64 KB gets no viewer, exits 0 and is listed as skipped', () => {
  const tmp = tmpRoot();
  put(tmp, 'a/original.json', JSON.stringify({ unrelated: 'x'.repeat(70000) }));
  const before = hashTree(tmp);
  const r = cli(tmp, '--json');
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.deepStrictEqual(hashTree(tmp), before);
  const report = JSON.parse(r.stdout);
  assert.deepStrictEqual(report.archives.map(a => a.status), ['skipped']);
  assert.deepStrictEqual(report.archives[0].failedChats, []);
  assert.ok(report.skipped.some(s => s.path === path.join(tmp, 'a') && s.reason === 'not a Claude chat'), r.stdout);
});

test('a big non-chat next to a real chat is skipped while the real chat gets its viewer', () => {
  const tmp = tmpRoot();
  put(tmp, 'mega/index.md');
  put(tmp, 'mega/real/original.json', chatJson('r1'));
  put(tmp, 'mega/other/original.json', JSON.stringify([1, 2, 3, 'x'.repeat(70000)]));
  const r = cli(tmp, '--json');
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const report = JSON.parse(r.stdout);
  assert.strictEqual(report.archives[0].status, 'written');
  assert.strictEqual(report.archives[0].chats, 1);
  assert.ok(report.skipped.some(s => s.path === path.join(tmp, 'mega', 'other')), r.stdout);
});

test('a second signal ends the run at once with exit 130', async () => {
  const tmp = tmpRoot();
  const input = path.join(tmp, 'in');
  fs.mkdirSync(input);
  await makeZip(input, z => {
    z.file('original.json', chatJson('z1'));
    for (let i = 0; i < 6000; i++) z.file(`notes/n${i}.md`, 'x'.repeat(4096));
  }, 'big.zip');
  const out = path.join(tmp, 'out');
  const child = spawn(process.execPath, [TOOL_PATH, input, '--out', out, '--json'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let closed = false;
  const done = new Promise(resolve => child.on('close', (code, sig) => { closed = true; resolve({ code, sig }); }));
  while (!closed && !fs.existsSync(path.join(out, 'big.partial'))) await new Promise(resolve => setTimeout(resolve, 1));
  assert.ok(!closed, 'the run ended before the signal could be sent');
  child.kill('SIGINT');
  await new Promise(resolve => setTimeout(resolve, 5));
  if (!closed) child.kill('SIGINT');
  const { code } = await done;
  assert.strictEqual(code, 130);
});

test('--force: viewer.html deleted with our viewer-check.gif left behind is replaced, not a dead end', async () => {
  const { writeViewer } = tool();
  const root = tmpRoot();
  put(root, 'original.json', chatJson('s1'));
  assert.strictEqual((await writeViewer(single(root), {})).status, 'written');
  fs.unlinkSync(path.join(root, 'viewer.html'));
  const res = await writeViewer(single(root), {});
  assert.strictEqual(res.status, 'written', res.reason);
  assert.ok(fs.existsSync(path.join(root, 'viewer.html')));
});

test('a viewer-check.gif that is not ours with no viewer.html is still left alone', async () => {
  const { writeViewer } = tool();
  const root = tmpRoot();
  put(root, 'original.json', chatJson('s1'));
  put(root, 'viewer-check.gif', 'mine');
  const res = await writeViewer(single(root), {});
  assert.strictEqual(res.status, 'failed');
  assert.strictEqual(fs.readFileSync(path.join(root, 'viewer-check.gif'), 'utf8'), 'mine');
  assert.ok(!fs.existsSync(path.join(root, 'viewer.html')));
});

test('a mega whose index.md was removed still finds the shared project files', () => {
  const parent = tmpRoot();
  put(parent, 'c/original.json', JSON.stringify({ uuid: 'u', project_uuid: 'P', project: { uuid: 'P', name: 'Shared' }, chat_messages: [] }));
  put(parent, 'c/README.md', '- [Paper.pdf](../projects/My%20Proj/files/Paper.pdf)\n');
  put(parent, 'projects/My Proj/files/Paper.pdf', 'pdf');
  const archive = findArchives(parent).archives.find(a => a.root === path.join(parent, 'c'));
  assert.ok(archive, 'the chat folder is a single archive');
  const got = chatFromDisk(archive, archive.chats[0]);
  assert.deepStrictEqual(got.viewerChat.project.files.map(f => f.name), ['Paper.pdf']);
  assert.ok(!got.warnings.some(w => /projects/.test(w)), got.warnings.join('|'));
});

test('a README project link that points nowhere is a warning', () => {
  const dir = tmpRoot();
  put(dir, 'original.json', JSON.stringify({ uuid: 'u', project_uuid: 'P', chat_messages: [] }));
  put(dir, 'README.md', '- [Paper.pdf](../projects/Gone/files/Paper.pdf)\n');
  const archive = singleOf(dir);
  const got = chatFromDisk(archive, archive.chats[0]);
  assert.ok(got.warnings.some(w => /projects\/Gone/.test(w)), got.warnings.join('|'));
});
