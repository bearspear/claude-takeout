// Archive finder and added-file scanner (tools/archive-lib.js). Synthetic fixtures only.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { findArchives, scanAdded, isGeneratedViewer, KNOWN_ROOT_FILES, KNOWN_DIRS, IGNORED_NAMES } = require('../tools/archive-lib.js');

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
  const added = scanAdded(res.archives[0]);
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
  assert.deepStrictEqual(scanAdded(res.archives[0]).map(f => f.path), ['loose.zip']);
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
  const added = scanAdded(find(tmp).archives[0]);
  assert.deepStrictEqual(added.map(f => f.path), ['_index.md', 'synthesis/a.md']);
  assert.strictEqual(added[1].size, 5);
  assert.strictEqual(added[1].chatDir, null);
});

test('scanAdded sorts by code unit and keeps the on-disk spelling', () => {
  const tmp = tmpRoot();
  const s = path.join(tmp, 's');
  put(s, 'original.json', CHAT);
  for (const f of ['c.md', 'B.md', 'a.md', 'Ä.md', 'dir/y.md', 'dir/Z.md']) put(s, f);
  assert.deepStrictEqual(scanAdded(find(tmp).archives[0]).map(f => f.path), ['B.md', 'a.md', 'c.md', 'dir/Z.md', 'dir/y.md', 'Ä.md']);
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
  assert.deepStrictEqual(scanAdded(arch).map(f => [f.path, f.chatDir]), [
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
