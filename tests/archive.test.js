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
