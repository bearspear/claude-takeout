// Archive finder and added-file scanner (tools/archive-lib.js). Synthetic fixtures only.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { findArchives, scanAdded, isGeneratedViewer, chatFromDisk, matchFile, KNOWN_ROOT_FILES, KNOWN_DIRS, IGNORED_NAMES } = require('../tools/archive-lib.js');
const { textBlob, projectResponses, exportPopup, runFolder, withUploads, oneMessage, use, result, publishedFetcher, zipStub } = require('./helpers');

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
  for (const d of ['responses', 'artefacts', 'attachments', 'uploads', 'project', 'projects', 'viewer-files', 'published']) assert.ok(KNOWN_DIRS.includes(d), d);
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

test('an Export Artifacts folder is an archive of its own, with no chats', () => {
  const tmp = tmpRoot();
  put(tmp, 'index.md');
  put(tmp, 'index.html');
  put(tmp, 'export-manifest.json', JSON.stringify({ format: 1, kind: 'artifacts', listed: 1, artifacts: [] }));
  put(tmp, 'Game_abc/index.html');
  put(tmp, 'Game_abc/artifact.json', '{}');
  const res = find(tmp);
  assert.deepStrictEqual(res.archives.map(a => [a.root, a.kind, a.chats.length, a.hasViewer]), [[tmp, 'artifacts', 0, false]]);
  assert.strictEqual(require('../tools/archive-lib.js').isArchiveRoot(tmp), true);
  // Without its manifest it is just a folder.
  fs.rmSync(path.join(tmp, 'export-manifest.json'));
  assert.deepStrictEqual(find(tmp).archives, []);
});

test('an Export Artifacts folder with a viewer is found with it; its own files are not added files', () => {
  const tmp = tmpRoot();
  const viewer = '<!doctype html><html><head><meta name="generator" content="Claude Takeout"></head><body></body></html>';
  put(tmp, 'index.md');
  put(tmp, 'index.html');
  put(tmp, 'errors.txt');
  put(tmp, 'viewer.html', viewer);
  put(tmp, 'viewer-files/part-0001.js', 'window.__archivePart(1, {})');
  put(tmp, 'viewer-files/thumbs/abc.png');
  put(tmp, 'export-manifest.json', JSON.stringify({ format: 1, kind: 'artifacts', listed: 1, thumbs: 1, artifacts: [] }));
  put(tmp, 'Game_abc/index.html');
  put(tmp, 'Game_abc/artifact.json', '{}');
  put(tmp, 'my notes.md', 'mine');
  assert.strictEqual(isGeneratedViewer(viewer), true);
  const [archive] = find(tmp).archives;
  assert.deepStrictEqual([archive.kind, archive.hasViewer], ['artifacts', true]);
  assert.deepStrictEqual(scanAdded(archive).files.map(f => f.path), ['my notes.md']);
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
  // A single-chat export writes no index.md, so this one is the owner's.
  assert.deepStrictEqual(scanAdded(res.archives[0]).files.map(f => f.path), ['index.md', 'synthesis/other-export/original.json']);
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
    if (ArrayBuffer.isView(content)) { put(dir, name, Buffer.from(content.buffer, content.byteOffset, content.byteLength)); continue; }
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

// ---- published pages ----
const PUB = 'mcp__claude-artifacts__publish_files';
const PAGE_A = '0a1b2c3d-1111-4222-8333-444455556666';
const PAGE_B = '1a1b2c3d-1111-4222-8333-444455556666';
const sha = text => require('crypto').createHash('sha256').update(Buffer.from(text)).digest('hex');
const publishBlocks = (id, uuid, ver, short, title = 'Guide', files = [{ as: 'index.html', path: '/home/claude/guide.html' }]) => [
  use(id, PUB, { title, files }),
  { type: 'tool_result', tool_use_id: id, name: PUB, content: [{ type: 'text', text: JSON.stringify({ slug: uuid, version: ver, url: `https://claude.ai/artifact/${short}`, title }) }] },
];
const amsg = (uuid, parent, content, extra = {}) => ({ uuid, parent_message_uuid: parent, sender: 'assistant', created_at: '2026-01-01T00:00:00Z', content, ...extra });
// Page A: v1 the same as guide.html as written, v2 edited on claude.ai (saved), v3 whose index.html failed its
// checksum (saved, no start); a branch off m1 publishes v2 again. Page B: its info call fails, so it has no folder.
const pagesChat = (uuid = 'c1', name = 'Pages') => ({
  uuid, name, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z', current_leaf_message_uuid: 'm3',
  chat_messages: [
    amsg('m1', null, [use('w', 'Write', { file_path: '/home/claude/guide.html', content: '<p>G1</p>' }), result('w'), ...publishBlocks('p1', PAGE_A, 'v1', 'ShortA')]),
    amsg('m2', 'm1', [...publishBlocks('p2', PAGE_A, 'v2', 'ShortA'), ...publishBlocks('pb', PAGE_B, 'w1', 'ShortB', 'Broken')]),
    amsg('m3', 'm2', publishBlocks('p3', PAGE_A, 'v3', 'ShortA', 'Guide', [{ as: 'index.html', path: '/home/claude/guide.html' }, { as: 'data.json', path: '/home/claude/data.json' }])),
    amsg('m2b', 'm1', publishBlocks('p2b', PAGE_A, 'v2', 'ShortA')),
  ],
});
const pagesTable = () => ({ [PAGE_A]: { title: 'Guide', history: ['v1', 'v2', 'v3'], versions: {
  v1: { files: { 'index.html': '<p>G1</p>' } },
  v2: { files: { 'index.html': '<p>G2 from claude.ai</p>', 'app.js': 'run()' } },
  v3: { files: { 'index.html': { body: '<p>G3</p>', sha256: sha('something else') }, 'data.json': '{"n":3}' } },
} } });

test('parity: published pages on disk rebuild the same viewer chat', async () => {
  const dir = tmpRoot();
  const { written, chat: expected } = await runFolder(exportPopup(), pagesChat(), { fetchPublished: publishedFetcher(pagesTable()).fetch });
  writeFolder(dir, written);
  assert.ok(fs.existsSync(`${dir}/published/Guide_ShortA/v2/index.html`));
  assert.ok(!fs.existsSync(`${dir}/published/Broken_ShortB`));
  const page = Object.values(expected.files).find(f => f.published);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(page.versions.map(v => [v.label, v.href, v.same]))), [
    ['v1', 'artefacts/guide.html', true], ['v2', 'published/Guide_ShortA/v2/index.html', false], ['v3', null, false]]);
  const broken = Object.values(expected.files).find(f => f.name === 'Broken');
  assert.strictEqual(broken.kind, 'missing');
  const got = chatFromDisk(singleOf(dir), singleOf(dir).chats[0]);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(got.viewerChat)), JSON.parse(JSON.stringify(expected)));
  // A version listed but never saved (skipped after a 401) keeps its start in published.json, and gets no link.
  const jsonFile = `${dir}/published/Guide_ShortA/published.json`;
  const json = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
  json.versions.v2.saved = false;
  fs.writeFileSync(jsonFile, JSON.stringify(json));
  const after = Object.values(chatFromDisk(singleOf(dir), singleOf(dir).chats[0]).viewerChat.files).find(f => f.published);
  assert.deepStrictEqual(after.versions.map(v => v.href), ['artefacts/guide.html', null, null]);
});

test('a published version folder that is a link is not read, and counts as not in this export', async () => {
  const dir = tmpRoot();
  const { written } = await runFolder(exportPopup(), pagesChat(), { fetchPublished: publishedFetcher(pagesTable()).fetch });
  writeFolder(dir, written);
  const outside = tmpRoot();
  put(outside, 'index.html', '<p>SECRET from outside the archive</p>');
  fs.rmSync(`${dir}/published/Guide_ShortA/v2`, { recursive: true });
  fs.symlinkSync(outside, `${dir}/published/Guide_ShortA/v2`);
  const got = chatFromDisk(singleOf(dir), singleOf(dir).chats[0]);
  assert.ok(!JSON.stringify(got.viewerChat).includes('SECRET'));
  const page = Object.values(got.viewerChat.files).find(f => f.published);
  assert.deepStrictEqual(page.versions.map(v => [v.label, v.href, v.text]), [['v1', 'artefacts/guide.html', '<p>G1</p>'], ['v2', null, null], ['v3', null, null]]);
});

test('scanAdded does not list published/ at a mega root or in a chat folder', () => {
  const mega = tmpRoot();
  put(mega, 'index.md');
  put(mega, 'c/original.json', CHAT);
  put(mega, 'c/published/P_x/v1/index.html', 'p');
  put(mega, 'published/P_y/published.json', '{}');
  put(mega, 'published/P_y/v1/index.html', 'p');
  put(mega, 'notes.txt', 'mine');
  const archive = byRoot(find(mega), mega);
  assert.deepStrictEqual(scanAdded(archive).files.map(f => f.path), ['notes.txt']);
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
  assert.ok(!fs.existsSync(zipLib.partialOf(dest)));
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
  assert.ok(!fs.existsSync(zipLib.partialOf(dest)));
  const dest2 = path.join(tmp, 'out2');
  fs.mkdirSync(zipLib.partialOf(dest2));
  fs.writeFileSync(path.join(zipLib.partialOf(dest2), 'keep'), 'k');
  await assert.rejects(extractZip(zp, dest2), /remove.*\.partial/is);
  assert.ok(fs.existsSync(path.join(zipLib.partialOf(dest2), 'keep')));
  assert.ok(!fs.existsSync(dest2));
});

test('extractZip rejects a corrupt ZIP clearly and leaves nothing', async () => {
  const tmp = tmpRoot();
  const zp = path.join(tmp, 'bad.zip');
  fs.writeFileSync(zp, 'this is not a zip file at all');
  const dest = path.join(tmp, 'out');
  await assert.rejects(extractZip(zp, dest), /not a valid ZIP/i);
  assert.ok(!fs.existsSync(dest) && !fs.existsSync(zipLib.partialOf(dest)));
});

test('extractZip stops on a zip bomb and removes its partial folder', async () => {
  const tmp = tmpRoot();
  const zp = await makeZip(tmp, z => z.file('big.txt', Buffer.alloc(4 * 1024 * 1024)));
  const dest = path.join(tmp, 'out');
  await assert.rejects(extractZip(zp, dest, { maxBytes: 1024 }), /too large|zip bomb/i);
  assert.ok(!fs.existsSync(dest) && !fs.existsSync(zipLib.partialOf(dest)));
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
  assert.ok(!fs.existsSync(zipLib.partialOf(dest)));
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
  assert.ok(!fs.existsSync(dest) && !fs.existsSync(zipLib.partialOf(dest)));
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
  while (!closed && !fs.existsSync(zipLib.partialOf(dest))) await new Promise(resolve => setTimeout(resolve, 1));
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
  while (!closed && !fs.existsSync(zipLib.partialOf(path.join(out, 'big')))) await new Promise(resolve => setTimeout(resolve, 1));
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
  // They are outside the folder the viewer goes in, so they are listed without links, and the report says so.
  assert.deepStrictEqual(got.warnings.filter(w => /projects/.test(w)).map(w => /outside this folder/.test(w)), [true]);
});

test('a README project link that points nowhere is a warning', () => {
  const dir = tmpRoot();
  put(dir, 'original.json', JSON.stringify({ uuid: 'u', project_uuid: 'P', chat_messages: [] }));
  put(dir, 'README.md', '- [Paper.pdf](../projects/Gone/files/Paper.pdf)\n');
  const archive = singleOf(dir);
  const got = chatFromDisk(archive, archive.chats[0]);
  assert.ok(got.warnings.some(w => /projects\/Gone/.test(w)), got.warnings.join('|'));
});

// ---- review fixes ----
const turnsJson = (uuid, contents, extra = {}) => {
  const chat_messages = [];
  let parent = null;
  contents.forEach((content, i) => {
    chat_messages.push({ uuid: `${uuid}-h${i}`, parent_message_uuid: parent, sender: 'human', content: [{ type: 'text', text: 'go' }], ...(extra.human && extra.human[i] ? extra.human[i] : {}) });
    chat_messages.push({ uuid: `${uuid}-a${i}`, parent_message_uuid: `${uuid}-h${i}`, sender: 'assistant', content });
    parent = `${uuid}-a${i}`;
  });
  return JSON.stringify({ uuid, name: 'Chat', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z', current_leaf_message_uuid: parent, chat_messages, ...(extra.top || {}) });
};

test('a rebuilt viewer keeps the text of files with extensions isTextFile does not know', () => {
  const dir = tmpRoot();
  put(dir, 'original.json', turnsJson('u', [[
    { type: 'tool_use', id: 't1', name: 'create_file', input: { path: '/o/flow.mmd', file_text: 'graph TD; A-->B' } },
    { type: 'tool_use', id: 't2', name: 'create_file', input: { path: '/o/Makefile', file_text: 'all:\n\techo hi' } },
  ]]));
  put(dir, 'artefacts/flow.mmd', 'graph TD; A-->B');
  put(dir, 'artefacts/Makefile', 'all:\n\techo hi');
  const archive = singleOf(dir);
  const files = Object.values(chatFromDisk(archive, archive.chats[0]).viewerChat.files);
  const byName = Object.fromEntries(files.map(f => [f.name, f]));
  assert.strictEqual(byName['flow.mmd'].versions[0].text, 'graph TD; A-->B');
  assert.strictEqual(byName['flow.mmd'].kind, 'mermaid');
  assert.strictEqual(byName.Makefile.versions[0].text, 'all:\n\techo hi');
  assert.notStrictEqual(byName.Makefile.kind, 'binary');
});

test('a chat folder taken out of a mega gets no project link that points nowhere', () => {
  const parent = tmpRoot();
  put(parent, 'c/original.json', JSON.stringify({ uuid: 'u', project_uuid: 'P', project: { uuid: 'P', name: 'Shared' }, chat_messages: [] }));
  put(parent, 'c/README.md', '- [Paper.pdf](../projects/My%20Proj/files/Paper.pdf)\n');
  put(parent, 'projects/My Proj/files/Paper.pdf', 'pdf');
  const archive = findArchives(parent).archives.find(a => a.root === path.join(parent, 'c'));
  const files = chatFromDisk(archive, archive.chats[0]).viewerChat.project.files;
  assert.deepStrictEqual(files.map(f => [f.name, f.href]), [['Paper.pdf', null]]);
});

test('symlinked project/, uploads/ and artefacts/ folders are not read', () => {
  const tmp = tmpRoot();
  put(tmp, 'secret/notes.txt', 'TOPSECRET-TOKEN');
  put(tmp, 'secret/p01_a.txt', 'TOPSECRET-UPLOAD');
  put(tmp, 'secret/x.html', 'TOPSECRET-ART');
  const dir = path.join(tmp, 'chat');
  put(dir, 'original.json', turnsJson('u', [[{ type: 'tool_use', id: 't1', name: 'create_file', input: { path: '/o/x.html', file_text: 'replayed' } }]],
    { top: { project_uuid: 'P' }, human: [{ files_v2: [{ success: true, file_name: 'a.txt', file_uuid: 'fa', file_kind: 'blob' }] }] }));
  for (const name of ['project', 'uploads', 'artefacts']) fs.symlinkSync(path.join(tmp, 'secret'), path.join(dir, name));
  const archive = singleOf(dir);
  const got = chatFromDisk(archive, archive.chats[0]);
  assert.ok(!JSON.stringify(got.viewerChat).includes('TOPSECRET'), 'nothing from the linked folder');
  assert.ok(got.warnings.some(w => /link/i.test(w)), got.warnings.join('|'));
});

test('a ZIP is read from disk once', async (t) => {
  const tmp = tmpRoot();
  const input = path.join(tmp, 'in');
  fs.mkdirSync(input);
  await makeZip(input, z => z.file('original.json', chatJson('z1')), 'a.zip');
  let loads = 0;
  const realRead = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', function (p, ...rest) { if (String(p).endsWith('a.zip')) loads++; return realRead.call(fs, p, ...rest); });
  const report = await tool().run(input, { out: path.join(tmp, 'out') });
  assert.deepStrictEqual(report.zips.map(z => z.status), ['written']);
  assert.strictEqual(loads, 1);
});

test('foo.partial.zip and foo.zip both extract', async () => {
  const tmp = tmpRoot();
  const input = path.join(tmp, 'in');
  fs.mkdirSync(input);
  await makeZip(input, z => z.file('original.json', chatJson('p1')), 'foo.partial.zip');
  await makeZip(input, z => z.file('original.json', chatJson('p2')), 'foo.zip');
  const report = await tool().run(input, { out: path.join(tmp, 'out') });
  assert.deepStrictEqual(report.zips.map(z => z.status), ['written', 'written'], JSON.stringify(report.zips.map(z => z.reason)));
});

test('a ZIP whose entries collide once their names are cleaned is refused', async () => {
  const tmp = tmpRoot();
  const zp = path.join(tmp, 'twin.zip');
  fs.writeFileSync(zp, rawZip([['original.json', 'LEGIT'], ['x/../original.json', 'EVIL']]));
  const dest = path.join(tmp, 'out');
  await assert.rejects(extractZip(zp, dest), /collide|same name/i);
  assert.ok(!fs.existsSync(dest));
});

test('loose matching does not give one file on disk to the wrong upload', () => {
  const dir = tmpRoot();
  const upload = { files_v2: [{ success: true, file_name: 'data.csv', file_uuid: '', file_kind: 'blob' }] };
  put(dir, 'original.json', turnsJson('u', [[], [], []], { human: [upload, {}, upload] }));
  put(dir, 'uploads/p02_data.csv', 'a,b');
  const archive = singleOf(dir);
  const got = chatFromDisk(archive, archive.chats[0]);
  const linked = got.viewerChat.messages.flatMap(m => m.uploads || []).filter(u => u.href);
  assert.deepStrictEqual(linked.map(u => u.href), [], 'neither upload is given the one file');
  assert.ok(got.warnings.some(w => /several|which/i.test(w)), got.warnings.join('|'));
});

test('with viewer.html deleted, our own gif and parts are replaced', async () => {
  const dir = tmpRoot();
  put(dir, 'original.json', chatJson('g1'));
  fs.writeFileSync(path.join(dir, 'viewer-check.gif'), Buffer.from(require('../takeout-viewer.js').VIEWER_CHECK_BASE64, 'base64'));
  put(dir, 'viewer-files/part-0001.js', 'window.__archivePart(1, {"u0":"x"});');
  const report = await tool().run(dir, {});
  assert.deepStrictEqual(report.archives.map(a => a.status), ['written'], JSON.stringify(report.archives.map(a => a.reason)));
  assert.ok(fs.existsSync(path.join(dir, 'viewer.html')));
});

test('a stray non-viewer folder is named as the blocker', async () => {
  const dir = tmpRoot();
  put(dir, 'original.json', chatJson('g2'));
  fs.writeFileSync(path.join(dir, 'viewer-check.gif'), Buffer.from(require('../takeout-viewer.js').VIEWER_CHECK_BASE64, 'base64'));
  put(dir, 'viewer-files/mine.txt', 'my notes');
  const report = await tool().run(dir, {});
  assert.strictEqual(report.archives[0].status, 'failed');
  assert.match(report.archives[0].reason, /viewer-files/);
  assert.doesNotMatch(report.archives[0].reason, /viewer-check\.gif/);
});

test('an index.md added to a single-chat archive is listed; a mega root index.md is not', () => {
  const single = tmpRoot();
  put(single, 'original.json', CHAT);
  put(single, 'index.md', '# my notes');
  assert.deepStrictEqual(scanAdded(singleOf(single)).files.map(f => f.path), ['index.md']);
  const mega = tmpRoot();
  put(mega, 'index.md', '# index');
  put(mega, 'c1/original.json', CHAT);
  put(mega, 'c2/original.json', CHAT);
  const archive = findArchives(mega).archives.find(a => a.root === mega);
  assert.strictEqual(archive.kind, 'mega');
  assert.deepStrictEqual(scanAdded(archive).files.map(f => f.path), []);
});

// ---- second review: archive tool ----
test('a mega chat whose shared projects/ folder is there gets no warning about it', () => {
  const mega = tmpRoot();
  put(mega, 'index.md');
  put(mega, 'c/original.json', JSON.stringify({ uuid: 'u', project_uuid: 'P', project: { uuid: 'P', name: 'Shared' }, chat_messages: [] }));
  put(mega, 'c/README.md', '- [a.pdf](../projects/P/files/a.pdf)\n');
  put(mega, 'projects/P/files/a.pdf', 'pdf');
  const archive = { root: mega, kind: 'mega', chats: [{ dir: path.join(mega, 'c'), relDir: 'c' }] };
  const got = chatFromDisk(archive, archive.chats[0]);
  assert.deepStrictEqual(got.viewerChat.project.files.map(f => f.href), ['projects/P/files/a.pdf']);
  assert.deepStrictEqual(got.warnings.filter(w => /projects/.test(w)), []);
});

test('a linked projects/ folder at the archive root is not read', () => {
  const tmp = tmpRoot();
  put(tmp, 'elsewhere/P/files/secret-name.txt', 'x');
  const mega = path.join(tmp, 'mega');
  put(mega, 'index.md');
  put(mega, 'c/original.json', JSON.stringify({ uuid: 'u', project_uuid: 'P', project: { uuid: 'P', name: 'Shared' }, chat_messages: [] }));
  put(mega, 'c/README.md', '- [s](../projects/P/files/secret-name.txt)\n');
  fs.symlinkSync(path.join(tmp, 'elsewhere'), path.join(mega, 'projects'));
  const archive = { root: mega, kind: 'mega', chats: [{ dir: path.join(mega, 'c'), relDir: 'c' }] };
  const got = chatFromDisk(archive, archive.chats[0]);
  assert.ok(!JSON.stringify(got.viewerChat).includes('secret-name'), 'no names from outside the archive');
  assert.ok(got.warnings.some(w => /projects\/ is a link/.test(w)), got.warnings.join('|'));
});

test('upload names that differ only in case are matched as the export names them', () => {
  const up = (name, uuid) => ({ success: true, file_name: name, file_uuid: uuid, file_kind: 'image' });
  const data = { uuid: 'u', current_leaf_message_uuid: 'h', chat_messages: [{ uuid: 'h', parent_message_uuid: null, sender: 'human',
    content: [{ type: 'text', text: 'two' }], files_v2: [up('Photo.PNG', 'f1'), up('photo.png', 'f2')] }] };
  const { dir, archive, chat } = chatDir(data);
  put(dir, 'uploads/p01_Photo.PNG', 'a');
  put(dir, 'uploads/p01_photo_1.png', 'b');
  const got = chatFromDisk(archive, chat);
  assert.deepStrictEqual(got.missing, []);
});

test('an old archive\'s errors.txt flags its files in the viewer', () => {
  const data = { uuid: 'u', current_leaf_message_uuid: 'a', chat_messages: [{ uuid: 'a', parent_message_uuid: null, sender: 'assistant',
    content: [{ type: 'tool_use', id: '1', name: 'create_file', input: { path: '/h/page.html', file_text: 'x' } }] }] };
  const { dir, archive, chat } = chatDir(data);
  put(dir, 'errors.txt', '﻿## Warnings\n\n### page.html\n\n- **Type:** artifact opaque mutation\n\n---\n\n## Troubleshooting Guide\n');
  const files = Object.values(chatFromDisk(archive, chat).viewerChat.files);
  assert.deepStrictEqual(files.map(f => [f.name, f.flag]), [['page.html', 'script']]);
});

test('a mega-ZIP\'s export-manifest.json is part of the export, not an added file', () => {
  const tmp = tmpRoot();
  const m = path.join(tmp, 'mega');
  put(m, 'index.md');
  put(m, 'export-manifest.json', '{"format":1,"chats":[]}');
  put(m, 'mine.md');
  put(m, 'chat one/original.json', CHAT);
  assert.deepStrictEqual(scanAdded(find(tmp).archives[0]).files.map(f => f.path), ['mine.md']);
});

test("parity: diagrams and files on Claude's own messages, also as an older export saved them", async () => {
  const dir = tmpRoot();
  const data = withUploads();
  const answer = data.chat_messages.find(m => m.sender === 'assistant');
  answer.content.push({ type: 'tool_use', id: 'wd1', name: 'mcp__visualize__show_widget', input: { title: 'flow', widget_code: '<svg viewBox="0 0 4 4"><g class="c-teal"><rect width="4" height="4"/></g></svg>' } });
  answer.files_v2 = [{ success: true, file_name: 'handout.pdf', file_uuid: 'att-9', file_kind: 'blob' }];
  const { written, chat: expected } = await runFolder(exportPopup(), data);
  writeFolder(dir, written);
  const archive = singleOf(dir);
  const got = chatFromDisk(archive, archive.chats[0]);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(got.viewerChat)), JSON.parse(JSON.stringify(expected)));
  assert.ok(Object.values(got.viewerChat.files).some(f => f.name === 'flow.svg'));
  const onAnswer = m => got.viewerChat.messages.find(x => x.id === answer.uuid).uploads.find(u => u.name === 'handout.pdf');
  assert.strictEqual(onAnswer().href, 'artefacts/handout.pdf');
  // Before v1.11.0 the export put it in uploads/ with the prompt number.
  fs.renameSync(`${dir}/artefacts/handout.pdf`, `${dir}/uploads/p01_handout.pdf`);
  const old = chatFromDisk(archive, archive.chats[0]);
  assert.strictEqual(old.viewerChat.messages.find(x => x.id === answer.uuid).uploads.find(u => u.name === 'handout.pdf').href, 'uploads/p01_handout.pdf');
});

test('parity: web search images saved in images/ are found again, and images/ holds no added files', async () => {
  const dir = tmpRoot();
  const data = oneMessage([
    { type: 'tool_use', id: 'i1', name: 'image_search', input: { query: 'q' } },
    { type: 'tool_result', tool_use_id: 'i1', name: 'image_search', content: [{ type: 'text', text: 'Found 1' }, { images: [{ url: 'https://img.example/a.jpg', title: 'Screw' }] }] },
  ]);
  Object.assign(data, { uuid: 'c', name: 'c' });
  const popup = exportPopup({ routes: [[/img\.example/, () => ({ ok: true, status: 200, headers: { get: () => 'image/jpeg' }, blob: async () => ({ size: 3, type: 'image/jpeg', marker: 'jpg' }) })]] });
  popup.sandbox.chrome.permissions = { contains: async () => true };
  const { written, chat: expected } = await runFolder(popup, data);
  writeFolder(dir, written);
  const archive = singleOf(dir);
  const got = chatFromDisk(archive, archive.chats[0]);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(got.viewerChat)), JSON.parse(JSON.stringify(expected)));
  assert.match(got.viewerChat.messages[0].blocks.find(b => b.web).web[0].href, /^images\/[0-9a-f]{8}_Screw\.jpg$/);
  assert.ok(!scanAdded(archive).files.some(f => f.path.startsWith('images/')));
});

// ---- artifacts on disk: every layout (readArtifactStore), and build_viewer keeping the Artifacts screen ----
const lib = require('../tools/archive-lib.js');
const { uuidToBase58 } = require('../export-core.js');
const { assetRoutes, runArtifacts } = require('./helpers');
const G_U = PAGE_A;
const G_ID = uuidToBase58(G_U);
const G1 = '<p>G1</p>', G2 = '<p>G2</p>';
const filesOf = text => [{ path: 'index.html', savedAs: 'index.html', size: Buffer.byteLength(text), contentType: 'text/html', sha256: sha(text) }];
const pubIn = id => [{ chat: 'c1', messageUuid: 'c1-2', toolUseId: id, same: false, writtenAs: null }];
const pubVersion = (ver, order, text) => ({ ver, label: `v${order + 1}`, order, saved: true, files: filesOf(text), start: 'index.html', startSaved: 'index.html',
  incomplete: false, needsRuntime: false, missing: [], publishedIn: pubIn(`t${ver}`) });
const card = { url: `https://claude.ai/artifact/${G_ID}`, title: 'Guide', typeTitle: '', sourceSurface: 'chat', rel: 'mine', public: false,
  createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' };
const v2Version = (ver, text) => ({ folder: ver, files: filesOf(text).map(f => ({ ...f, verified: true })), start: 'index.html', startSaved: 'index.html',
  incomplete: false, missing: [], saved: true, publishedIn: pubIn(`t${ver}`) });
const format2 = (vers) => ({ format: 2, uuid: G_U, shortId: G_ID, ...card, listed: true, current: 'v2', start: 'index.html', needsRuntime: false, note: '',
  order: vers.map(([v]) => v), versions: Object.fromEntries(vers.map(([v, t]) => [v, v2Version(v, t)])) });
const format1 = (extra = {}) => ({ format: 1, uuid: G_U, shortId: G_ID, ...card, ver: 'v2', files: filesOf(G2), missing: [], incomplete: false, needsRuntime: false,
  note: '', start: 'index.html', ...extra });
const writePublished = base => {
  put(base, 'published/Guide_x/published.json', JSON.stringify({ format: 1, title: 'Guide', url: card.url, shortId: G_ID, uuid: G_U,
    versions: { v1: pubVersion('v1', 0, G1), v2: pubVersion('v2', 1, G2) } }));
  put(base, 'published/Guide_x/v1/index.html', G1);
  put(base, 'published/Guide_x/v2/index.html', G2);
};
const megaWith = (root, manifest = null) => {
  put(root, 'index.md', '# all');
  put(root, 'Chat_a/original.json', chatJson('c1'));
  if (manifest) put(root, 'export-manifest.json', JSON.stringify(manifest));
  return root;
};
const FULL = { format: 1, kind: 'full', exported_at: '2026-11-20T00:00:00Z', listed: 1, chats: [{ uuid: 'c1', folder: 'Chat_a' }], artifacts: { listed: 1, thumbs: 0, items: [] } };
const STANDALONE = { format: 1, kind: 'artifacts', exported_at: '2026-11-20T00:00:00Z', listed: 1, thumbs: 0, artifacts: [] };
const AF = `Guide_${G_ID}`;
// The same artifact, Guide with v1 and v2 (current), in each layout an export wrote.
const LAYOUTS = {
  'published (chat ZIP)': root => { put(root, 'original.json', chatJson('c1')); writePublished(root); return root; },
  'published (Export All)': root => { writePublished(megaWith(root)); return root; },
  'v17 (savedIn)': root => {
    writePublished(megaWith(root, FULL));
    put(root, `artifacts/${AF}/artifact.json`, JSON.stringify(format1({ files: [], savedIn: { 'index.html': 'published/Guide_x/v2/index.html' } })));
    put(root, 'artifacts/index.md', '# artifacts');
    return root;
  },
  'v17 (flat)': root => {
    writePublished(megaWith(root, FULL));
    put(root, `artifacts/${AF}/artifact.json`, JSON.stringify(format1()));
    put(root, `artifacts/${AF}/index.html`, G2);
    return root;
  },
  v18: root => {
    megaWith(root, FULL);
    put(root, `artifacts/${AF}/artifact.json`, JSON.stringify(format2([['v1', G1], ['v2', G2]])));
    put(root, `artifacts/${AF}/v1/index.html`, G1);
    put(root, `artifacts/${AF}/v2/index.html`, G2);
    return root;
  },
  'standalone (flat)': root => {
    put(root, 'export-manifest.json', JSON.stringify(STANDALONE));
    put(root, `${AF}/artifact.json`, JSON.stringify(format1()));
    put(root, `${AF}/index.html`, G2);
    return root;
  },
  'standalone (v18)': root => {
    put(root, 'export-manifest.json', JSON.stringify(STANDALONE));
    put(root, `${AF}/artifact.json`, JSON.stringify(format2([['v2', G2]])));
    put(root, `${AF}/v2/index.html`, G2);
    return root;
  },
};
// What a record holds, whatever the layout: its versions in order with their start file's text on disk.
const normalized = store => [...store.records.values()].map(r => ({
  uuid: r.uuid, shortId: r.shortId, title: r.title, listed: r.listed, current: r.current,
  versions: r.order.map(ver => {
    const v = r.versions.get(ver);
    const f = v.files.find(x => x.path === v.start);
    const abs = v.folder ? f && f.abs : v.sameAsAbs && v.sameAsAbs[v.start];
    return [ver, v.start, abs ? fs.readFileSync(abs, 'utf8') : null];
  }),
}));

test('readArtifactStore reads every layout into the same records', () => {
  const both = [['v1', 'index.html', G1], ['v2', 'index.html', G2]];
  const expect = {
    'published (chat ZIP)': ['published', false, null, both],
    'published (Export All)': ['published', false, null, both],
    'v17 (savedIn)': ['v17', true, 'v2', both],
    'v17 (flat)': ['v17', true, 'v2', both],
    v18: ['v18', true, 'v2', both],
    'standalone (flat)': ['standalone-flat', true, 'v2', [both[1]]],
    'standalone (v18)': ['standalone-v18', true, 'v2', [both[1]]],
  };
  for (const [name, make] of Object.entries(LAYOUTS)) {
    const store = lib.readArtifactStore(make(tmpRoot()));
    const [layout, listed, current, versions] = expect[name];
    assert.strictEqual(store.layout, layout, name);
    assert.deepStrictEqual(store.warnings, [], name);
    assert.deepStrictEqual(normalized(store), [{ uuid: G_U, shortId: G_ID, title: 'Guide', listed, current, versions }], name);
    assert.strictEqual(store.listFetched, listed, name);
  }
});

test('artifactViewsFromDisk: a listed artifact with no rel is not the owner\'s for local links', () => {
  const views = (rel) => {
    const root = megaWith(tmpRoot(), FULL);
    put(root, `artifacts/${AF}/artifact.json`, JSON.stringify({ ...format2([['v2', G2]]), rel }));
    put(root, `artifacts/${AF}/v2/index.html`, G2);
    return lib.artifactViewsFromDisk(lib.readArtifactStore(root)).views;
  };
  assert.strictEqual(views('mine')[0].shared, false);
  assert.strictEqual(views('')[0].shared, true);
  assert.strictEqual(views('shared')[0].shared, true);
});

test('readArtifactStore: a 1.17 savedIn naming a chat\'s own file is that file, as 1.18\'s sameAs', () => {
  const root = megaWith(tmpRoot(), FULL);
  put(root, 'Chat_a/artefacts/guide.html', G2);
  put(root, `artifacts/${AF}/artifact.json`, JSON.stringify(format1({ files: [], savedIn: { 'index.html': 'Chat_a/artefacts/guide.html' } })));
  const store = lib.readArtifactStore(root);
  const v = store.records.get(G_U).versions.get('v2');
  assert.deepStrictEqual([v.folder, v.sameAs], [null, { 'index.html': 'Chat_a/artefacts/guide.html' }]);
  const { views, payloads, records } = lib.artifactViewsFromDisk(store);
  assert.deepStrictEqual([views[0].reused, views[0].folder, views[0].startSaved, views[0].files[0].savedAs], [true, `artifacts/${AF}`, 'Chat_a/artefacts/guide.html', 'Chat_a/artefacts/guide.html']);
  assert.deepStrictEqual(payloads[0], { texts: [['index.html', G2]], images: [] });
  assert.deepStrictEqual(records[0].versions.v2.sameAs, { 'index.html': 'Chat_a/artefacts/guide.html' });
});

test('artifactViewsFromDisk: an older version a chat wrote the same (no copy in published/) points at that chat\'s file', () => {
  const root = megaWith(tmpRoot());
  writePublished(root);
  const file = path.join(root, 'published/Guide_x/published.json');
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  Object.assign(json.versions.v1, { saved: false, publishedIn: [{ chat: 'c1', messageUuid: 'c1-2', toolUseId: 'tv1', same: true, writtenAs: 'guide.html' }] });
  fs.writeFileSync(file, JSON.stringify(json));
  fs.rmSync(path.join(root, 'published/Guide_x/v1'), { recursive: true });
  put(root, 'Chat_a/artefacts/guide.html', G1);
  const store = lib.readArtifactStore(root);
  assert.strictEqual(lib.artifactViewsFromDisk(store).records[0].versions.v1.sameAs, undefined, 'no chat folders given: nothing to point at');
  const out = lib.artifactViewsFromDisk(store, new Map([['c1', 'Chat_a']]));
  assert.deepStrictEqual(out.records[0].versions.v1.sameAs, { 'index.html': 'Chat_a/artefacts/guide.html' });
  assert.deepStrictEqual(out.versionPayloads.map(p => [p.ver, p.payload.texts[0][1]]), [['v1', G1], ['v2', G2]]);
});

test('readArtifactStore: the version order is artifact.json\'s order, not its keys\'', () => {
  const root = megaWith(tmpRoot(), FULL);
  const json = format2([['12', G2], ['ab-1', G1]]);
  json.order = ['ab-1', '12'];
  put(root, `artifacts/${AF}/artifact.json`, JSON.stringify(json));
  put(root, `artifacts/${AF}/12/index.html`, G2);
  put(root, `artifacts/${AF}/ab-1/index.html`, G1);
  assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(root, `artifacts/${AF}/artifact.json`), 'utf8')).versions), ['12', 'ab-1']);
  assert.deepStrictEqual([...lib.readArtifactStore(root).records.values()][0].order, ['ab-1', '12']);
  // Without order (an older 1.18 build), the keys' order.
  delete json.order;
  put(root, `artifacts/${AF}/artifact.json`, JSON.stringify(json));
  assert.deepStrictEqual([...lib.readArtifactStore(root).records.values()][0].order, ['12', 'ab-1']);
});

test('readArtifactStore never leaves the archive: links, climbing names and odd files are not read', () => {
  const outside = tmpRoot();
  put(outside, 'index.html', '<p>SECRET</p>');
  const root = LAYOUTS.v18(tmpRoot());
  fs.rmSync(path.join(root, `artifacts/${AF}/v1`), { recursive: true });
  fs.symlinkSync(outside, path.join(root, `artifacts/${AF}/v1`));
  const json = JSON.parse(fs.readFileSync(path.join(root, `artifacts/${AF}/artifact.json`), 'utf8'));
  json.versions.v2.files[0].savedAs = '../../../x/index.html';
  json.versions.v3 = { folder: null, files: filesOf(G1), start: 'index.html', sameAs: { 'index.html': '../outside/index.html' }, publishedIn: [] };
  json.thumb = '../secret.png';
  put(root, `artifacts/${AF}/artifact.json`, JSON.stringify(json));
  put(root, 'artifacts/Bad_1/artifact.json', '{ not json');
  put(root, 'artifacts/Bad_2/artifact.json', '{}');
  const store = lib.readArtifactStore(root);
  const rec = store.records.get(G_U);
  assert.deepStrictEqual([rec.versions.get('v1').folder, rec.versions.get('v2').files[0].abs, rec.versions.get('v3').sameAs, rec.thumb], [null, null, null, null]);
  assert.strictEqual(store.records.size, 1);
  assert.ok(store.warnings.some(w => /Bad_1\/artifact\.json/.test(w)), store.warnings.join('|'));
  const out = lib.artifactViewsFromDisk(store);
  assert.ok(!JSON.stringify(out).includes('SECRET'));
  // 1.17: published/ a link out of the archive, and artifact.json's savedIn naming a file through it.
  const out17 = tmpRoot();
  put(out17, 'Guide_x/v2/index.html', '<p>SECRET via published</p>');
  put(out17, 'Guide_x/published.json', JSON.stringify({ uuid: G_U, versions: { v2: pubVersion('v2', 0, '<p>SECRET via published</p>') } }));
  const r17 = megaWith(tmpRoot(), FULL);
  fs.symlinkSync(out17, path.join(r17, 'published'));
  put(r17, `artifacts/${AF}/artifact.json`, JSON.stringify(format1({ files: [], savedIn: { 'index.html': 'published/Guide_x/v2/index.html' } })));
  const s17 = lib.readArtifactStore(r17);
  assert.ok(s17.warnings.some(w => /published\/ is a link/.test(w)), s17.warnings.join('|'));
  const v17 = s17.records.get(G_U).versions.get('v2');
  assert.deepStrictEqual([v17.folder, v17.abs, v17.sameAs], [null, null, null]);
  const o17 = lib.artifactViewsFromDisk(s17);
  assert.deepStrictEqual(o17.payloads, [null]);
  assert.ok(!JSON.stringify(o17).includes('SECRET') && !JSON.stringify(o17).includes('published/Guide_x'), JSON.stringify(o17));
  // 1.18: an artifact folder whose version folder's parent is a link (artifacts/<dir> itself): not read.
  const out18 = tmpRoot();
  put(out18, 'v2/index.html', '<p>SECRET via dir</p>');
  put(out18, 'artifact.json', JSON.stringify(format2([['v2', '<p>SECRET via dir</p>']])));
  const r18 = megaWith(tmpRoot(), FULL);
  fs.mkdirSync(path.join(r18, 'artifacts'));
  fs.symlinkSync(out18, path.join(r18, `artifacts/${AF}`));
  const s18 = lib.readArtifactStore(r18);
  assert.strictEqual(s18.records.size, 0);
  assert.ok(!JSON.stringify(lib.artifactViewsFromDisk(s18)).includes('SECRET'));
  // artifacts/ itself a link: not read, and said so.
  const linked = megaWith(tmpRoot(), FULL);
  fs.symlinkSync(path.join(root, 'artifacts'), path.join(linked, 'artifacts'));
  const l = lib.readArtifactStore(linked);
  assert.deepStrictEqual([l.layout, l.records.size], ['none', 0]);
  assert.ok(l.warnings.some(w => /artifacts\/ is a link/.test(w)));
});

// A viewer.html the extension made, for --force.
const GENERATED = '<!doctype html><html><head><meta name="generator" content="Claude Takeout"></head><body></body></html>';
const partsOf = root => {
  const out = {};
  const dir = path.join(root, 'viewer-files');
  for (const n of fs.existsSync(dir) ? fs.readdirSync(dir).filter(x => /^part-\d+\.js$/.test(x)) : []) {
    const got = loadPart(fs.readFileSync(path.join(dir, n), 'utf8'));
    out[got.n] = JSON.parse(JSON.stringify(got.data));  // out of the part's own realm
  }
  return out;
};
const payload = (parts, o) => (o && o.part ? parts[o.part][o.key] : null);

test('build_viewer --force on a 1.17 combined archive keeps the Artifacts screen and resolves savedIn previews', async () => {
  const root = LAYOUTS['v17 (savedIn)'](tmpRoot());
  put(root, 'viewer.html', GENERATED);
  const before = hashTree(root);
  const report = await tool().writeViewer(single(root), { force: true });
  assert.strictEqual(report.status, 'written', report.reason);
  assert.strictEqual(report.artifacts, 1);
  assertKept(before, hashTree(root), ['viewer.html']);
  const html = fs.readFileSync(path.join(root, 'viewer.html'), 'utf8');
  assert.ok(html.includes('function versionMenu('), 'the Artifacts screen is in the page');
  const data = viewerData(root);
  const parts = partsOf(root);
  assert.deepStrictEqual([data.listFetched, data.storeCount, data.exportedArtifacts], [true, 1, '2026-11-20T00:00:00Z']);
  const [view] = data.artifacts;
  assert.deepStrictEqual([view.id, view.title, view.folder, view.startSaved, view.listed, view.startMissing], [G_ID, 'Guide', 'published/Guide_x/v2', 'index.html', true, false]);
  assert.deepStrictEqual(payload(parts, view).texts, [['index.html', G2]]);
  assert.deepStrictEqual(view.versions.map(v => [v.label, v.folder, v.current]), [['v1', 'published/Guide_x/v1', false], ['v2', 'published/Guide_x/v2', true]]);
  // The older version previews from its own folder, with no chat holding it.
  assert.strictEqual(view.versions[0].copy, null);
  assert.deepStrictEqual([view.versions[0].startKind, payload(parts, view.versions[0]).texts], ['html', [['index.html', G1]]]);
});

test('build_viewer on a pre-1.17 Export All: its published pages are artifact folders, and claude.ai\'s list is not there', async () => {
  const root = LAYOUTS['published (Export All)'](tmpRoot());
  const report = await tool().writeViewer(single(root), {});
  assert.strictEqual(report.status, 'written', report.reason);
  const data = viewerData(root);
  assert.deepStrictEqual([data.listFetched, data.storeCount, data.artifacts], [false, 1, []]);
  // A chat ZIP's viewer keeps no Artifacts screen, as the extension writes it.
  const chatZip = LAYOUTS['published (chat ZIP)'](tmpRoot());
  assert.strictEqual((await tool().writeViewer(single(chatZip), {})).status, 'written');
  assert.ok(!('artifacts' in viewerData(chatZip)));
});

test('build_viewer on a 1.18 archive: an older version no chat holds previews from its own folder', async () => {
  const root = LAYOUTS.v18(tmpRoot());
  assert.strictEqual((await tool().writeViewer(single(root), {})).status, 'written');
  const data = viewerData(root);
  const parts = partsOf(root);
  const [view] = data.artifacts;
  assert.deepStrictEqual([view.folder, payload(parts, view).texts], [`artifacts/${AF}/v2`, [['index.html', G2]]]);
  assert.deepStrictEqual(view.versions.map(v => [v.label, v.folder, v.copy, v.current]), [['v1', `artifacts/${AF}/v1`, null, false], ['v2', `artifacts/${AF}/v2`, null, true]]);
  assert.deepStrictEqual(payload(parts, view.versions[0]).texts, [['index.html', G1]]);
  assert.ok(!('part' in view.versions[1]), 'the current version previews as the artifact does');
});

// Export All through the popup (bulkExportZip, a ZIP) with claude.ai's artifact list and pages, unzipped into a new
// folder. Returns { dir, data (the viewer data the extension wrote) }.
async function exportAllToDisk({ chats, frames, pages }) {
  const JSZip = require('../jszip.min.js');
  const sb = exportPopup({ routes: assetRoutes() }).sandbox;
  const fetcher = publishedFetcher(pages);
  const store = {};
  const list = Object.values(chats).map(c => ({ uuid: c.uuid, name: c.name, updated_at: c.updated_at }));
  sb.chrome.storage.local.get = async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(k => k in store).map(k => [k, store[k]]));
  sb.chrome.storage.local.set = async (o) => { Object.assign(store, JSON.parse(JSON.stringify(o))); };
  sb.chrome.permissions = { contains: async () => false, request: async () => false };
  sb.chrome.tabs.query = async () => [{ id: 1, url: 'https://claude.ai/chat/x' }];
  sb.chrome.tabs.sendMessage = (id, m, cb) => {
    if (m.action === 'fetchAllConversations') cb({ data: list, orgId: 'org-1' });
    else if (m.action === 'fetchConversation') cb({ data: JSON.parse(JSON.stringify(chats[m.conversationId])) });
    else if (m.action === 'listArtifacts') cb({ frames: JSON.parse(JSON.stringify(frames)) });
    else if (/^publishedPage/.test(m.action)) fetcher.fetch(m).then(cb);
    else cb({});
  };
  sb.JSZip = JSZip;
  sb.Uint8Array = Uint8Array;
  let saved = null;
  sb.download = (blob) => { saved = blob; };
  sb.setTimeout = (f) => setTimeout(f, 0);
  vm.runInContext('orgId = "org-1"', sb);
  await vm.runInContext('bulkExportZip({})', sb);
  assert.ok(saved, sb.document.getElementById('status').textContent);
  const zip = await JSZip.loadAsync(await saved.arrayBuffer());
  const dir = tmpRoot();
  for (const n of Object.keys(zip.files)) if (!zip.files[n].dir) put(dir, n, await zip.file(n).async('nodebuffer'));
  return { dir, data: viewerData(dir) };
}

const LIVE = '1794783850-4a6e', OLD1 = '1794700000-0a01', OLD2 = '1794700001-0a02';
const U = n => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const listItem = (slug, title, extra = {}) => ({ slug, title, typeSlug: '', typeTitle: '', sourceSurface: 'chat', rel: 'mine', live: LIVE,
  updatedAt: '2026-05-01T10:30:00Z', createdAt: '2026-05-01T10:01:00Z', ...extra });
const msgAt = (uuid, parent, sender, content) => ({ uuid, parent_message_uuid: parent, sender, created_at: '2026-05-01T10:00:00Z', content, attachments: [], files: [], files_v2: [] });
const publishCall = (id, slug, version, source, title = 'Guide page') => [
  use(id, PUB, { title, files: [{ as: 'index.html', path: source }] }),
  { type: 'tool_result', tool_use_id: id, name: PUB, content: [{ type: 'text', text: JSON.stringify({ slug, version, url: `https://claude.ai/artifact/${uuidToBase58(slug)}`, title }) }] },
];
const writeCall = (id, file, content) => [use(id, 'Write', { file_path: file, content }), { type: 'tool_result', tool_use_id: id, name: 'Write', content: [{ type: 'text', text: 'ok' }] }];
const OLDA = '<!doctype html><h1>Old A</h1>';
const OLDB = '<!doctype html><h1>Old B served</h1>';
const PNG_BYTES = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mNkYPhfz0AEYBxVSF+FAAhKDveksOjmAAAAAElFTkSuQmCC', 'base64');
// Chat "Editing" publishes Guide page (U(1)) at two older versions: the file it wrote (same), then one claude.ai served
// differently (saved in its version folder). Chat "Side" publishes a page claude.ai doesn't list (U(8)). Game (U(2)) is
// only in claude.ai's list, with a script and a picture.
const megaChats = () => ({
  'chat-edit': { uuid: 'chat-edit', name: 'Editing', model: 'claude-x', created_at: '2026-05-01T10:14:00Z', updated_at: '2026-05-01T10:18:00Z', settings: {}, current_leaf_message_uuid: 'ea2',
    chat_messages: [
      msgAt('eh1', null, 'human', [{ type: 'text', text: 'publish the old guide' }]),
      msgAt('ea1', 'eh1', 'assistant', [...writeCall('ew1', '/home/claude/old.html', OLDA), ...publishCall('ep1', U(1), OLD1, '/home/claude/old.html'), { type: 'text', text: 'Published.' }]),
      msgAt('eh2', 'ea1', 'human', [{ type: 'text', text: 'and the new one' }]),
      msgAt('ea2', 'eh2', 'assistant', [...writeCall('ew2', '/home/claude/new.html', '<!doctype html><h1>New as written</h1>'), ...publishCall('ep2', U(1), OLD2, '/home/claude/new.html'), { type: 'text', text: 'Again.' }]),
    ] },
  'chat-side': { uuid: 'chat-side', name: 'Side', model: 'claude-x', created_at: '2026-05-01T10:23:00Z', updated_at: '2026-05-01T10:24:00Z', settings: {}, current_leaf_message_uuid: 'sa1',
    chat_messages: [
      msgAt('sh1', null, 'human', [{ type: 'text', text: 'publish a side page' }]),
      msgAt('sa1', 'sh1', 'assistant', [...publishCall('sp', U(8), LIVE, '/home/claude/side.html', 'Side page'), { type: 'text', text: 'Done.' }]),
    ] },
});
const megaPages = () => ({
  [U(1)]: { title: 'Guide page', live: LIVE, history: [OLD1, OLD2, LIVE], versions: {
    [OLD1]: { files: { 'index.html': OLDA } }, [OLD2]: { files: { 'index.html': OLDB } }, [LIVE]: { files: { 'index.html': '<!doctype html><h1>Live guide</h1>' } } } },
  [U(2)]: { title: 'Game', live: LIVE, versions: { [LIVE]: { files: { 'index.html': '<script src="app.js"></script><img src="logo.png">', 'app.js': 'go()', 'logo.png': { body: PNG_BYTES, type: 'image/png' } } } } },
  [U(8)]: { title: 'Side page', live: LIVE, versions: { [LIVE]: { files: { 'index.html': '<!doctype html><h1>Side</h1>' } } } },
});

// The differences a rebuilt viewer may have from the extension's, by design: when it was built (exported), where
// previews sit in viewer-files (part and key numbers), the order of the artifacts (claude.ai's list, against folder
// names), and an older version's own preview (part, key, startKind: the extension reads those from the chats).
function comparable(data) {
  const clean = x => JSON.parse(JSON.stringify(x, (k, v) => (k === 'part' || k === 'key' ? undefined : v)));
  const out = clean({ ...data, exported: null });
  if (Array.isArray(out.artifacts)) {
    out.artifacts.sort((a, b) => (a.id < b.id ? -1 : 1));
    for (const a of out.artifacts) for (const v of a.versions) delete v.startKind;
  }
  return out;
}

test('parity: build_viewer on a 1.18 Export All builds the viewer data the extension wrote', async () => {
  const frames = [listItem(U(1), 'Guide page'), listItem(U(2), 'Game', { sourceSurface: 'code' })];
  const { dir, data: expected } = await exportAllToDisk({ chats: megaChats(), frames, pages: megaPages() });
  assert.ok(!fs.existsSync(path.join(dir, 'published')));
  assert.ok(expected.artifacts.length === 2 && expected.listFetched === true);
  const store = lib.readArtifactStore(dir);
  assert.deepStrictEqual([store.layout, store.records.size, store.listFetched, store.listed], ['v18', 3, true, 2]);
  const report = await tool().writeViewer(single(dir), { force: true });
  assert.strictEqual(report.status, 'written', report.reason);
  assert.deepStrictEqual(report.warnings, []);
  const got = viewerData(dir);
  assert.deepStrictEqual(comparable(got), comparable(expected));
  // The previews are the same texts and images.
  const parts = partsOf(dir);
  const byId = list => Object.fromEntries(list.map(a => [a.id, a]));
  const game = byId(got.artifacts)[uuidToBase58(U(2))];
  const gamePayload = payload(parts, game);
  assert.deepStrictEqual(gamePayload.texts.map(t => t[0]), ['index.html', 'app.js']);
  assert.match(gamePayload.images[0][1], /^data:image\/png;base64,/);
  // Every saved older version has its own preview; the extension's took the chats' cards.
  const guide = byId(got.artifacts)[uuidToBase58(U(1))];
  assert.deepStrictEqual(guide.versions.map(v => [v.label, !!v.part, !!v.copy]), [['v1', true, true], ['v2', true, true], ['v3', false, false]]);
});

test('build_viewer on an Export Artifacts export: the artifacts page again, with its card pictures, as the extension wrote it', async () => {
  const frames = [listItem(U(1), 'Guide page'), listItem(U(2), 'Game', { sourceSurface: 'code' })];
  const run = await runArtifacts({ frames, pages: megaPages(), thumbs: { [U(2)]: { status: 200, type: 'image/png', body: PNG_BYTES } } });
  const root = tmpRoot();
  for (const [n, b] of Object.entries(run.raw)) put(root, n, b);
  const thumb = `viewer-files/thumbs/${uuidToBase58(U(2))}.png`;
  assert.ok(fs.existsSync(path.join(root, thumb)));
  const [archive] = findArchives(root).archives;
  assert.strictEqual(archive.kind, 'artifacts');
  const skip = await tool().writeViewer(archive, {});
  assert.deepStrictEqual([skip.status, skip.reason], ['skipped', 'it already has a viewer.html (--force replaces a generated one)']);
  const before = hashTree(root);
  const report = await tool().writeViewer(archive, { force: true });
  assert.strictEqual(report.status, 'written', report.reason);
  assert.deepStrictEqual([report.chats, report.artifacts], [0, 2]);
  assertKept(before, hashTree(root), ['viewer.html']);
  assert.ok(fs.readFileSync(path.join(root, thumb)).equals(PNG_BYTES), 'the card picture is kept');
  const data = viewerData(root);
  assert.deepStrictEqual(Object.keys(data).sort(), ['artifacts', 'exported', 'listed']);
  assert.strictEqual(data.listed, 2);
  const strip = list => JSON.parse(JSON.stringify(list, (k, v) => (k === 'part' || k === 'key' ? undefined : v))).sort((a, b) => (a.id < b.id ? -1 : 1));
  assert.deepStrictEqual(strip(data.artifacts), strip(run.views));
  assert.strictEqual(data.artifacts.find(a => a.thumb).thumb, thumb);
  const parts = partsOf(root);
  assert.deepStrictEqual(payload(parts, data.artifacts.find(a => a.title === 'Guide page')).texts, [['index.html', '<!doctype html><h1>Live guide</h1>']]);
});

test('build_viewer gives an archive with artifacts a viewer from the command line; a broken artifact.json is a warning', () => {
  const root = LAYOUTS.v18(tmpRoot());
  put(root, 'artifacts/Broken_1/artifact.json', '{');
  const res = cli(root, '--json');
  assert.strictEqual(res.status, 0, res.stderr);
  const report = JSON.parse(res.stdout);
  assert.ok(!report.archives[0].refused);
  assert.strictEqual(report.archives[0].artifacts, 1);
  assert.ok(report.archives[0].warnings.some(w => /Broken_1\/artifact\.json/.test(w)));
  assert.strictEqual(viewerData(root).artifacts.length, 1);
  assert.strictEqual(res.stderr, '');
});

test('build_viewer extracts a ZIP with artifacts and gives it a viewer; an Export Artifacts ZIP too', async () => {
  const JSZip = require('../jszip.min.js');
  const tmp = tmpRoot();
  const zipOf = async (root, prefix) => {
    const zip = new JSZip();
    const walk = (dir, rel) => {
      for (const n of fs.readdirSync(dir)) {
        const p = path.join(dir, n);
        if (fs.statSync(p).isDirectory()) walk(p, `${rel}${n}/`);
        else zip.file(`${prefix}${rel}${n}`, fs.readFileSync(p));
      }
    };
    walk(root, '');
    return zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX' });
  };
  fs.writeFileSync(path.join(tmp, 'combined.zip'), await zipOf(LAYOUTS.v18(tmpRoot()), 'claude-takeout-z/'));
  fs.writeFileSync(path.join(tmp, 'arts.zip'), await zipOf(LAYOUTS['standalone (v18)'](tmpRoot()), 'claude-takeout-artifacts-z/'));
  const out = path.join(tmp, 'out');
  const res = cli(tmp, '--out', out, '--json');
  assert.strictEqual(res.status, 0, res.stderr);
  const zips = Object.fromEntries(JSON.parse(res.stdout).zips.map(z => [path.basename(z.zip), z]));
  assert.deepStrictEqual([zips['combined.zip'].status, zips['arts.zip'].status], ['written', 'written']);
  assert.strictEqual(viewerData(path.join(out, 'combined', 'claude-takeout-z')).artifacts.length, 1);
  assert.strictEqual(viewerData(path.join(out, 'arts', 'claude-takeout-artifacts-z')).artifacts.length, 1);
});

// A pre-1.17 archive whose chat is named "Artifacts" or "artifacts" is an ordinary archive.
for (const name of ['Artifacts', 'artifacts']) {
  test(`build_viewer: an old archive with a chat folder ${name}/ is an ordinary archive`, () => {
    const root = tmpRoot();
    put(root, 'index.md', '# all');
    put(root, `${name}/original.json`, chatJson('a1'));
    put(root, 'Chat_b/original.json', chatJson('b1'));
    const res = cli(root, '--json');
    assert.strictEqual(res.status, 0, res.stderr);
    assert.ok(!JSON.parse(res.stdout).archives.some(a => a.refused));
    assert.ok(fs.existsSync(path.join(root, 'viewer.html')));
  });

  test(`build_viewer: an old ZIP with a chat folder ${name}/ is an ordinary archive`, async () => {
    const JSZip = require('../jszip.min.js');
    const tmp = tmpRoot();
    const zip = new JSZip();
    zip.file('claude-takeout-z/index.md', '# all');
    zip.file(`claude-takeout-z/${name}/original.json`, chatJson('a1'));
    zip.file('claude-takeout-z/Chat_b/original.json', chatJson('b1'));
    fs.writeFileSync(path.join(tmp, 'z.zip'), await zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX' }));
    const out = path.join(tmp, 'out');
    const res = cli(tmp, '--out', out, '--json');
    assert.strictEqual(res.status, 0, res.stderr);
    assert.ok(!JSON.parse(res.stdout).zips.some(z => z.refused));
  });
}

test('an Export Changes archive with only artifacts (no chat folders) is an archive, and build_viewer gives it the Artifacts screen', async () => {
  const root = tmpRoot();
  put(root, 'index.md', '# changes');
  put(root, 'export-manifest.json', JSON.stringify({ ...FULL, kind: 'changes', since: '2026-11-01T00:00:00Z', chats: [] }));
  put(root, `artifacts/${AF}/artifact.json`, JSON.stringify(format2([['v1', G1], ['v2', G2]])));
  put(root, `artifacts/${AF}/v1/index.html`, G1);
  put(root, `artifacts/${AF}/v2/index.html`, G2);
  const found = lib.findArchives(root);
  assert.deepStrictEqual(found.archives.map(a => [a.root, a.kind, a.chats.length]), [[root, 'mega', 0]]);
  assert.strictEqual(lib.isArchiveRoot(root), true);
  const res = await tool().writeViewer(found.archives[0], {});
  assert.strictEqual(res.status, 'written', res.reason);
  const data = viewerData(root);
  assert.deepStrictEqual(data.chats, []);
  assert.deepStrictEqual(data.artifacts.map(v => v.title), ['Guide']);
  // Not one: a chat-less folder whose manifest is an Export All's but whose artifacts/ has no artifact.json, or one
  // with no index.md.
  const bare = tmpRoot();
  put(bare, 'index.md', '# changes');
  put(bare, 'export-manifest.json', JSON.stringify({ ...FULL, kind: 'changes' }));
  put(bare, 'artifacts/index.md', '# artifacts');
  assert.deepStrictEqual(lib.findArchives(bare).archives, []);
  const noIndex = tmpRoot();
  put(noIndex, 'export-manifest.json', JSON.stringify({ ...FULL, kind: 'changes' }));
  put(noIndex, `artifacts/${AF}/artifact.json`, JSON.stringify(format2([['v2', G2]])));
  assert.deepStrictEqual(lib.findArchives(noIndex).archives, []);
});

test('chatFromDisk on a 1.18 Export All builds each artifact\'s page once per store, not once per chat', () => {
  const root = tmpRoot();
  put(root, 'index.md', '# all');
  put(root, 'export-manifest.json', JSON.stringify(FULL));
  const chat = (uuid, id) => JSON.stringify({ uuid, name: 'Chat ' + uuid, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z',
    current_leaf_message_uuid: `${uuid}-m`, chat_messages: [amsg(`${uuid}-m`, null, publishBlocks(id, G_U, 'v2', G_ID))] });
  for (const n of ['a', 'b', 'c']) put(root, `Chat_${n}/original.json`, chat(`c${n}`, `p${n}`));
  put(root, `artifacts/${AF}/artifact.json`, JSON.stringify(format2([['v1', G1], ['v2', G2]])));
  put(root, `artifacts/${AF}/v1/index.html`, G1);
  put(root, `artifacts/${AF}/v2/index.html`, G2);
  const archive = findArchives(root).archives.find(a => a.root === root);
  const store = lib.readArtifactStore(root);
  // v18Page reads each version's start file size (fs.statSync) to judge whether it needs claude.ai to run.
  const start = path.join(root, `artifacts/${AF}/v2/index.html`);
  const statSync = fs.statSync;
  let stats = 0;
  fs.statSync = (p, ...rest) => { if (path.resolve(String(p)) === start) stats++; return statSync(p, ...rest); };
  let got;
  try { got = archive.chats.map(c => chatFromDisk(archive, c, store)); } finally { fs.statSync = statSync; }
  assert.strictEqual(got.length, 3);
  for (const g of got) assert.ok(Object.values(g.viewerChat.files).some(f => f.published), 'each chat links the page');
  assert.strictEqual(stats, 1);
});

test('readArtifactStore: claude.ai\'s list is in the archive only when its manifest says so, not because a record is listed', () => {
  const noStep = { ...FULL };
  delete noStep.artifacts;
  for (const [manifest, want] of [[FULL, true], [noStep, false], [null, false], [{ ...FULL, kind: 'changes' }, true]]) {
    const root = megaWith(tmpRoot(), manifest);
    put(root, `artifacts/${AF}/artifact.json`, JSON.stringify(format2([['v1', G1]])));
    put(root, `artifacts/${AF}/v1/index.html`, G1);
    const store = lib.readArtifactStore(root);
    assert.ok([...store.records.values()][0].listed, 'the record says listed');
    assert.strictEqual(store.listFetched, want, JSON.stringify(manifest && { kind: manifest.kind, artifacts: !!manifest.artifacts }));
  }
});

// ---- A version's ZIP (v1.19): read only when artifact.json names <folder>.zip and it is a real file ----
test('a version\'s zip passes through only for a real file named <folder>.zip', () => {
  const PKZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]);
  const viewsOf = (setup) => {
    const root = tmpRoot();
    put(root, 'export-manifest.json', JSON.stringify(STANDALONE));
    const json = format2([['v1', G1], ['v2', G2]]);
    json.versions.v2.zip = 'v2.zip';
    put(root, `${AF}/v1/index.html`, G1);
    put(root, `${AF}/v2/index.html`, G2);
    setup(root, json);
    put(root, `${AF}/artifact.json`, JSON.stringify(json));
    const store = lib.readArtifactStore(root);
    return { store, views: lib.artifactViewsFromDisk(store).views };
  };
  let r = viewsOf(root => fs.writeFileSync(path.join(root, AF, 'v2.zip'), PKZIP));
  assert.strictEqual(r.views[0].zip, `${AF}/v2.zip`);
  assert.strictEqual(lib.artifactJsonV2FromDisk([...r.store.records.values()][0]).versions.v2.zip, 'v2.zip');
  r = viewsOf(() => {});
  assert.strictEqual(r.views[0].zip, null, 'named but missing');
  assert.ok(!('zip' in lib.artifactJsonV2FromDisk([...r.store.records.values()][0]).versions.v2));
  r = viewsOf(root => {
    const outside = path.join(tmpRoot(), 'secret.zip');
    fs.writeFileSync(outside, PKZIP);
    fs.symlinkSync(outside, path.join(root, AF, 'v2.zip'));
  });
  assert.strictEqual(r.views[0].zip, null, 'a link is never followed');
  r = viewsOf((root, json) => { delete json.versions.v2.zip; fs.writeFileSync(path.join(root, AF, 'v2.zip'), PKZIP); });
  assert.strictEqual(r.views[0].zip, null, 'a ZIP artifact.json does not name');
  r = viewsOf((root, json) => { json.versions.v2.zip = '../v2.zip'; fs.writeFileSync(path.join(root, 'v2.zip'), PKZIP); });
  assert.strictEqual(r.views[0].zip, null, 'only <folder>.zip beside the folder');
});

test('payloadFromDisk keeps canvas.json right after the start file', () => {
  const root = tmpRoot();
  put(root, 'export-manifest.json', JSON.stringify(STANDALONE));
  const texts = { 'index.html': '<script src="artifact-type/app.js"></script>', 'project/Main.dc.html': '<p>main</p>', 'project/canvas.json': '{"v":3,"boards":{}}' };
  const json = format2([['v2', '']]);
  json.typeTitle = 'Design';
  json.versions.v2.files = Object.entries(texts).map(([p, t]) => ({ path: p, savedAs: p, size: Buffer.byteLength(t), contentType: 'text/plain', sha256: sha(t), verified: true }));
  for (const [p, t] of Object.entries(texts)) put(root, `${AF}/v2/${p}`, t);
  put(root, `${AF}/artifact.json`, JSON.stringify(json));
  const { payloads } = lib.artifactViewsFromDisk(lib.readArtifactStore(root));
  assert.deepStrictEqual(payloads[0].texts.map(t => t[0]), ['index.html', 'project/canvas.json', 'project/Main.dc.html']);
});
