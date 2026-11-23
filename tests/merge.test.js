// tools/merge_archives.js: combining a full archive with later change archives. Synthetic fixtures only.
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const vm = require('vm');
const JSZip = require('../jszip.min.js');
const { merge, pickNewest } = require('../tools/merge_archives.js');
const { uuidToBase58 } = require('../export-core.js');
const { loadPopup } = require('./helpers');

const TOOL = path.resolve(__dirname, '..', 'tools', 'merge_archives.js');
const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'merge-test-'));
const put = (root, rel, text = 'x') => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};
const chatJson = (uuid, updated, text = 'hello') => JSON.stringify({
  uuid, name: 'Chat ' + uuid, created_at: '2026-01-01T00:00:00Z', updated_at: updated,
  chat_messages: [
    { uuid: uuid + '-1', sender: 'human', content: [{ type: 'text', text: `${text} ${uuid}` }], parent_message_uuid: null },
    { uuid: uuid + '-2', sender: 'assistant', content: [{ type: 'text', text: 'hi' }], parent_message_uuid: uuid + '-1' },
  ],
  current_leaf_message_uuid: uuid + '-2',
});
// A mega archive: index.md, export-manifest.json, a folder per chat and optional shared projects.
function mega(root, exportedAt, chats, projects = {}, manifest = true) {
  put(root, 'index.md', '# Claude Takeout - All Conversations');
  if (manifest) put(root, 'export-manifest.json', JSON.stringify({ format: 1, exported_at: exportedAt, kind: 'full', chats: [] }));
  for (const [folder, json] of Object.entries(chats)) {
    put(root, `${folder}/original.json`, json);
    put(root, `${folder}/README.md`, `# ${folder}`);
  }
  for (const [rel, text] of Object.entries(projects)) put(root, `projects/${rel}`, text);
  put(root, 'viewer.html', '<html>old viewer</html>');
}
function hashTree(root) {
  const out = {};
  const walk = (dir, rel) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, name);
      const r = rel ? rel + '/' + name : name;
      const s = fs.lstatSync(p);
      if (s.isDirectory()) { out[r] = 'dir'; walk(p, r); } else out[r] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    }
  };
  walk(root, '');
  return out;
}
const NOW = new Date('2026-11-09T12:00:00Z');

test('pickNewest takes the latest updated_at, then the later export, then the later source', () => {
  const c = (uuid, updatedAt, exportedAt, order) => ({ uuid, updatedAt, exportedAt, order });
  const { chosen, replaced } = pickNewest([
    c('a', '2026-01-02T00:00:00Z', '2026-02-01T00:00:00Z', 0), c('a', '2026-01-01T00:00:00Z', '2026-03-01T00:00:00Z', 1),
    c('b', '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z', 1), c('b', '2026-01-01T00:00:00Z', '2026-03-01T00:00:00Z', 0),
    c('d', '2026-01-01T00:00:00Z', null, 0), c('d', '2026-01-01T00:00:00Z', null, 1),
    c(null, null, null, 0), c(null, null, null, 1),
  ]);
  const of = (u) => chosen.find((x) => x.uuid === u);
  assert.deepStrictEqual([of('a').order, of('b').order, of('d').order], [0, 0, 1]);
  assert.strictEqual(chosen.filter((x) => !x.uuid).length, 2, 'chats without a uuid are all kept');
  assert.strictEqual(replaced, 3);
});

test('merges a full archive and a changes archive into a new folder with one viewer, leaving the sources alone', async () => {
  const tmp = tmpRoot();
  const base = path.join(tmp, 'claude-takeout-2026-11-01');
  const changes = path.join(tmp, 'claude-takeout-changes-2026-11-05');
  mega(base, '2026-11-01T00:00:00Z', { Chat_a: chatJson('a', '2026-10-01T00:00:00Z'), Chat_b: chatJson('b', '2026-10-02T00:00:00Z', 'old') },
    { 'Proj/files/p.md': 'old project file' });
  mega(changes, '2026-11-05T00:00:00Z', { Chat_b: chatJson('b', '2026-11-04T00:00:00Z', 'new'), Chat_c: chatJson('c', '2026-11-03T00:00:00Z') },
    { 'Proj/files/p.md': 'new project file' });
  const before = [hashTree(base), hashTree(changes)];
  const out = path.join(tmp, 'out');

  const r = await merge([base, changes], { out, now: NOW });
  assert.strictEqual(r.status, 'written', r.reason);
  assert.ok(r.ok, JSON.stringify(r.warnings));
  assert.deepStrictEqual([r.chats, r.replaced], [3, 1]);
  const dest = path.join(out, 'claude-takeout-merged-2026-11-09');
  assert.strictEqual(r.dest, dest);
  assert.deepStrictEqual(fs.readdirSync(out), ['claude-takeout-merged-2026-11-09'], 'nothing else left under --out');
  assert.match(JSON.parse(fs.readFileSync(path.join(dest, 'Chat_b', 'original.json'), 'utf8')).chat_messages[0].content[0].text, /^new /);
  assert.ok(fs.existsSync(path.join(dest, 'Chat_a', 'README.md')) && fs.existsSync(path.join(dest, 'Chat_c', 'README.md')));
  assert.strictEqual(fs.readFileSync(path.join(dest, 'projects', 'Proj', 'files', 'p.md'), 'utf8'), 'new project file', 'the newest source wins a shared project');
  const manifest = JSON.parse(fs.readFileSync(path.join(dest, 'export-manifest.json'), 'utf8'));
  assert.strictEqual(manifest.kind, 'merged');
  assert.deepStrictEqual(manifest.chats.map((c) => [c.uuid, c.from]).sort(), [['a', 'claude-takeout-2026-11-01'], ['b', 'claude-takeout-changes-2026-11-05'], ['c', 'claude-takeout-changes-2026-11-05']]);
  const index = fs.readFileSync(path.join(dest, 'index.md'), 'utf8');
  assert.match(index, /^﻿# Claude Takeout - Merged archive/);
  assert.match(index, /\[Chat b\]\(Chat_b\/README\.md\)/);
  const viewer = fs.readFileSync(path.join(dest, 'viewer.html'), 'utf8');
  assert.ok(!viewer.includes('old viewer'));
  const data = JSON.parse(/<script id="data" type="application\/json">([\s\S]*?)<\/script>/.exec(viewer)[1]);
  assert.deepStrictEqual(data.chats.map((c) => c.id).sort(), ['a', 'b', 'c']);
  assert.deepStrictEqual([hashTree(base), hashTree(changes)], before, 'sources unchanged');
});

test('single-chat archives and ZIPs are sources too; a single chat leaves its old viewer behind', async () => {
  const tmp = tmpRoot();
  const single = path.join(tmp, 'Chat_x_claude-chat');
  put(single, 'original.json', chatJson('x', '2026-10-01T00:00:00Z'));
  put(single, 'README.md', '# x');
  put(single, 'viewer.html', '<html>old</html>');
  put(single, 'viewer-files/part-0001.js', 'window.__archivePart(1, {});');
  const zip = new JSZip();
  zip.file('claude-takeout-z/index.md', '# all');
  zip.file('claude-takeout-z/Chat_y/original.json', chatJson('y', '2026-10-02T00:00:00Z'));
  zip.file('claude-takeout-z/Chat_x/original.json', chatJson('x', '2026-10-05T00:00:00Z', 'newer'));
  const zipPath = path.join(tmp, 'claude-takeout-z.zip');
  fs.writeFileSync(zipPath, await zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX' }));
  const out = path.join(tmp, 'out');

  const r = await merge([single, zipPath], { out, name: 'everything', now: NOW });
  assert.strictEqual(r.status, 'written', r.reason);
  const dest = path.join(out, 'everything');
  assert.deepStrictEqual(fs.readdirSync(out), ['everything'], 'the extracted ZIP is removed');
  assert.deepStrictEqual(fs.readdirSync(dest).sort(), ['Chat_x', 'Chat_y', 'export-manifest.json', 'index.md', 'viewer-check.gif', 'viewer.html']);
  assert.match(fs.readFileSync(path.join(dest, 'Chat_x', 'original.json'), 'utf8'), /newer x/);

  const r2 = await merge([zipPath, single], { out, name: 'single-first', now: NOW });
  assert.strictEqual(r2.status, 'written', r2.reason);
  // The ZIP's copy is newer by updated_at, whatever the order.
  assert.match(fs.readFileSync(path.join(out, 'single-first', 'Chat_x', 'original.json'), 'utf8'), /newer x/);
  const r3 = await merge([single], { out, name: 'old-only', now: NOW });
  assert.deepStrictEqual(fs.readdirSync(path.join(out, 'old-only', 'Chat_x_claude-chat')).sort(), ['README.md', 'original.json'], 'the single chat keeps only its own files');
  assert.strictEqual(r3.status, 'written');
});

test('refuses an existing destination, --out inside a source or an archive, and writes nothing on a dry run', async () => {
  const tmp = tmpRoot();
  const base = path.join(tmp, 'base');
  mega(base, '2026-11-01T00:00:00Z', { Chat_a: chatJson('a', '2026-10-01T00:00:00Z') });
  await assert.rejects(merge([base], { out: path.join(base, 'merged'), now: NOW }), /inside/);
  await assert.rejects(merge([base], {}), /--out/);
  await assert.rejects(merge([], { out: path.join(tmp, 'o') }), /Usage/);
  const out = path.join(tmp, 'out');
  fs.mkdirSync(path.join(out, 'taken'), { recursive: true });
  await assert.rejects(merge([base], { out, name: 'taken', now: NOW }), /already exists/);
  await assert.rejects(merge([base], { out, name: '../x', now: NOW }), /plain folder name/);
  const dry = await merge([base], { out, name: 'dry', dryRun: true, now: NOW });
  assert.strictEqual(dry.status, 'written');
  assert.strictEqual(dry.chats, 1);
  assert.deepStrictEqual(fs.readdirSync(out), ['taken'], 'a dry run writes nothing');
});

test('a source with no chats fails without leaving anything behind, and the CLI says so', () => {
  const tmp = tmpRoot();
  fs.mkdirSync(path.join(tmp, 'empty'));
  const out = path.join(tmp, 'out');
  const res = spawnSync(process.execPath, [TOOL, path.join(tmp, 'empty'), '--out', out], { encoding: 'utf8' });
  assert.strictEqual(res.status, 1);
  assert.match(res.stdout, /failed: no Claude chats/);
  assert.deepStrictEqual(fs.readdirSync(out), []);
});

// ---- artifacts: one 1.18 store from every layout, chat links rewritten ----
const PUB = 'mcp__claude-artifacts__publish_files';
const U = '0a1b2c3d-1111-4222-8333-444455556666';
const SID = uuidToBase58(U);
const OTHER = '9a1b2c3d-1111-4222-8333-444455556666';
const OID = uuidToBase58(OTHER);
const sha = t => crypto.createHash('sha256').update(t).digest('hex');
const pub = (id, ver, title = 'Guide', uuid = U) => [
  { type: 'tool_use', id, name: PUB, input: { title, files: [{ as: 'index.html', path: '/home/claude/guide.html' }] } },
  { type: 'tool_result', tool_use_id: id, name: PUB, content: [{ type: 'text', text: JSON.stringify({ slug: uuid, version: ver, url: `https://claude.ai/artifact/${uuidToBase58(uuid)}`, title }) }] },
];
const pubChat = (uuid, updated, blocks) => JSON.stringify({ uuid, name: 'Chat ' + uuid, created_at: '2026-01-01T00:00:00Z', updated_at: updated,
  current_leaf_message_uuid: uuid + '-1', chat_messages: [{ uuid: uuid + '-1', parent_message_uuid: null, sender: 'assistant', content: blocks }] });
const fileOf = text => ({ path: 'index.html', savedAs: 'index.html', size: Buffer.byteLength(text), contentType: 'text/html', sha256: sha(text) });
const pin = (chat, id, same = false, writtenAs = null) => ({ chat, messageUuid: chat + '-1', toolUseId: id, same, writtenAs });
// published.json (before 1.18) and its version entries.
const pubVersion = (ver, order, saved, publishedIn, text) => ({ ver, label: `v${order + 1}`, order, saved, files: [fileOf(text)], start: 'index.html',
  startSaved: saved ? 'index.html' : null, incomplete: false, needsRuntime: false, missing: [], publishedIn });
const pageJson = (versions, title = 'Guide', uuid = U) => JSON.stringify({ format: 1, title, url: `https://claude.ai/artifact/${uuidToBase58(uuid)}`, shortId: uuidToBase58(uuid), uuid, versions });
const card = (uuid, title) => ({ url: `https://claude.ai/artifact/${uuidToBase58(uuid)}`, title, typeTitle: '', sourceSurface: 'chat', rel: 'mine', public: false,
  createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' });
// artifact.json format 1 (1.15 to 1.17) and format 2 (1.18).
const format1 = (uuid, title, ver, extra = {}) => JSON.stringify({ format: 1, uuid, shortId: uuidToBase58(uuid), ...card(uuid, title), ver, files: [], missing: [], incomplete: false,
  needsRuntime: false, note: '', start: 'index.html', ...extra });
const v2 = (folder, text, publishedIn = [], extra = {}) => ({ folder, files: [{ ...fileOf(text), savedAs: folder ? 'index.html' : null, verified: true }], start: 'index.html',
  startSaved: folder ? 'index.html' : null, incomplete: false, missing: [], saved: !!folder, publishedIn, ...extra });
const format2 = (uuid, title, { listed = true, current = null, versions = {}, thumb = null } = {}) => JSON.stringify({ format: 2, uuid, shortId: uuidToBase58(uuid),
  ...card(uuid, title), listed, current, start: 'index.html', needsRuntime: false, note: '', ...(thumb ? { thumb } : {}), order: Object.keys(versions), versions });
const manifestOf = (exportedAt, kind = 'full', step = true) => JSON.stringify({ format: 1, exported_at: exportedAt, kind, since: null, listed: 1, chats: [],
  ...(step ? { artifacts: { listed: 1, thumbs: 0, items: [] } } : {}) });
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

// Every link target in a merged chat's Markdown (README.md, full_chat.md, integrated_chat.md, responses/*.md), with the
// file it is in.
function chatLinks(dest) {
  const out = [];
  for (const chat of fs.readdirSync(dest)) {
    const dir = path.join(dest, chat);
    if (!fs.existsSync(path.join(dir, 'original.json'))) continue;
    const files = ['README.md', 'full_chat.md', 'integrated_chat.md'].filter(n => fs.existsSync(path.join(dir, n)));
    if (fs.existsSync(path.join(dir, 'responses'))) files.push(...fs.readdirSync(path.join(dir, 'responses')).map(n => `responses/${n}`));
    for (const f of files) {
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      for (const m of text.matchAll(/\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g)) out.push({ chat, file: f, target: m[1] });
    }
  }
  return out;
}
// Every relative link in the merged chats opens a file of the merged archive, and none points into published/.
function assertLinksResolve(dest) {
  const links = chatLinks(dest).filter(l => !/^[a-z]+:/i.test(l.target));
  assert.ok(links.length, 'the fixture has links');
  for (const l of links) {
    const abs = path.resolve(dest, l.chat, path.dirname(l.file), l.target.split('/').map(decodeURIComponent).join('/'));
    assert.ok(abs.startsWith(dest + path.sep), `${l.chat}/${l.file}: ${l.target} stays in the archive`);
    assert.ok(fs.statSync(abs, { throwIfNoEntry: false })?.isFile(), `${l.chat}/${l.file}: ${l.target} opens a file`);
    assert.ok(!/(^|\/)published\//.test(l.target), `${l.target} no longer points into published/`);
  }
  return links;
}
// As assertLinksResolve, but a link into a published/ folder the merge kept (no published.json) may stay.
function assertLinksResolveAllowingKept(dest) {
  for (const l of chatLinks(dest).filter(x => !/^[a-z]+:/i.test(x.target))) {
    const abs = path.resolve(dest, l.chat, path.dirname(l.file), l.target.split('/').map(decodeURIComponent).join('/'));
    assert.ok(abs.startsWith(dest + path.sep) && fs.statSync(abs, { throwIfNoEntry: false })?.isFile(), `${l.chat}/${l.file}: ${l.target} opens a file`);
  }
}
const viewerData = dest => JSON.parse(/<script id="data" type="application\/json">([\s\S]*?)<\/script>/.exec(fs.readFileSync(path.join(dest, 'viewer.html'), 'utf8'))[1]);
const artifactJson = (dest, dir) => JSON.parse(fs.readFileSync(path.join(dest, 'artifacts', dir, 'artifact.json'), 'utf8'));
const treeOf = dir => Object.keys(hashTree(dir)).sort();

test('merging two pre-1.17 archives that share a page keeps one artifact folder with every version, and the chats\' links open them', async () => {
  const tmp = tmpRoot();
  const base = path.join(tmp, 'claude-takeout-2026-11-01');
  const changes = path.join(tmp, 'claude-takeout-changes-2026-11-05');
  mega(base, '2026-11-01T00:00:00Z', { Chat_a: pubChat('a', '2026-10-01T00:00:00Z', pub('p1', 'v1')) });
  put(base, 'Chat_a/README.md', `# a\n- v1: [index.html](../published/Guide_ShortA/v1/index.html)\n`);
  put(base, 'Chat_a/full_chat.md', `> **Published on claude.ai:** [Guide](https://claude.ai/artifact/${SID}) · [saved copy](../published/Guide_ShortA/v1/index.html)\n`);
  put(base, 'published/Guide_ShortA/published.json', pageJson({ v1: pubVersion('v1', 0, true, [pin('a', 'p1')], 'one') }));
  put(base, 'published/Guide_ShortA/v1/index.html', 'one');
  // The later export: the page has a new title (a new folder name); chat b published v1 again (the same as its own file,
  // not stored) and v2 (stored); a page.json of another uuid with no versions is nothing to keep.
  mega(changes, '2026-11-05T00:00:00Z', { Chat_b: pubChat('b', '2026-11-04T00:00:00Z', [...pub('q1', 'v1'), ...pub('q2', 'v2')]) });
  put(changes, 'published/Guide_2_ShortA/published.json', pageJson({
    v1: pubVersion('v1', 0, false, [pin('b', 'q1', true, 'guide.html')], 'one'),
    v2: pubVersion('v2', 1, true, [pin('b', 'q2')], 'two'),
  }, 'Guide 2'));
  put(changes, 'published/Guide_2_ShortA/v2/index.html', 'two');
  put(changes, 'Chat_b/artefacts/guide.html', 'one');
  put(changes, 'Chat_b/README.md', '# b\n- v1: same as [guide.html](artefacts/guide.html)\n- v2: [index.html](../published/Guide_2_ShortA/v2/index.html)\n');
  put(changes, 'Chat_b/responses/001_x_response.full.md', '[saved copy](../../published/Guide_2_ShortA/v2/index.html)\n');
  put(changes, 'published/Guide_ShortA/published.json', pageJson({}, 'Other', OTHER));
  const before = [hashTree(base), hashTree(changes)];
  const out = path.join(tmp, 'out');

  const r = await merge([base, changes], { out, now: NOW });
  assert.strictEqual(r.status, 'written', r.reason);
  assert.ok(r.ok, JSON.stringify(r.warnings));
  assert.deepStrictEqual(r.unmappedLinks, []);
  assert.strictEqual(r.sameCopied, 0, 'v1 comes from the older source\'s saved folder, not from chat b\'s file');
  const dest = path.join(out, 'claude-takeout-merged-2026-11-09');
  assert.ok(!fs.existsSync(path.join(dest, 'published')), 'no published/ in the merged archive');
  // One folder for the page, named as its newest copy. v1 was chat b's own file in the newest source, but chat a
  // published it too and links it: v1 gets its own folder, with the bytes it was published with.
  assert.deepStrictEqual(treeOf(path.join(dest, 'artifacts')), ['Guide_2_ShortA', 'Guide_2_ShortA/artifact.json', 'Guide_2_ShortA/v1', 'Guide_2_ShortA/v1/index.html',
    'Guide_2_ShortA/v2', 'Guide_2_ShortA/v2/index.html', 'index.html', 'index.md']);
  const json = artifactJson(dest, 'Guide_2_ShortA');
  assert.strictEqual(json.format, 2);
  assert.strictEqual(json.uuid, U);
  assert.strictEqual(json.title, 'Guide 2');
  assert.strictEqual(json.listed, false, 'no source had claude.ai\'s list');
  assert.deepStrictEqual(json.order, ['v1', 'v2']);
  assert.strictEqual(json.versions.v1.folder, 'v1');
  assert.ok(!json.versions.v1.sameAs);
  assert.deepStrictEqual(json.versions.v1.publishedIn.map(p => [p.chat, p.toolUseId, p.same]), [['b', 'q1', true], ['a', 'p1', false]]);
  assert.strictEqual(json.versions.v2.folder, 'v2');
  assert.deepStrictEqual(['v1', 'v2'].map(v => fs.readFileSync(path.join(dest, `artifacts/Guide_2_ShortA/${v}/index.html`), 'utf8')), ['one', 'two']);
  // Chat a's link into the old published/ now opens v1's folder; chat b's v2 links open the folder.
  assert.match(fs.readFileSync(path.join(dest, 'Chat_a/README.md'), 'utf8'), /\]\(\.\.\/artifacts\/Guide_2_ShortA\/v1\/index\.html\)/);
  assert.match(fs.readFileSync(path.join(dest, 'Chat_b/README.md'), 'utf8'), /\]\(\.\.\/artifacts\/Guide_2_ShortA\/v2\/index\.html\)/);
  assert.match(fs.readFileSync(path.join(dest, 'Chat_b/README.md'), 'utf8'), /\[guide\.html\]\(artefacts\/guide\.html\)/);
  assert.match(fs.readFileSync(path.join(dest, 'Chat_b/responses/001_x_response.full.md'), 'utf8'), /\(\.\.\/\.\.\/artifacts\/Guide_2_ShortA\/v2\/index\.html\)/);
  assertLinksResolve(dest);
  // The viewer: both chats' cards open existing files.
  const data = viewerData(dest);
  const hrefs = Object.fromEntries(data.chats.map(c => [c.id, Object.values(c.files).filter(f => f.published).flatMap(f => f.versions.map(v => v.href)).filter(Boolean)]));
  assert.deepStrictEqual(hrefs, { a: ['artifacts/Guide_2_ShortA/v1/index.html'], b: ['Chat_b/artefacts/guide.html', 'artifacts/Guide_2_ShortA/v2/index.html'] });
  for (const h of Object.values(hrefs).flat()) assert.ok(fs.existsSync(path.join(dest, h)), h);
  assert.deepStrictEqual([hashTree(base), hashTree(changes)], before, 'sources unchanged');
});

test('(a) a pre-1.17 Export All and a chat ZIP with its own published/: one store at the root, the chat\'s links rewritten', async () => {
  const tmp = tmpRoot();
  const all = path.join(tmp, 'claude-takeout-2026-11-01');
  mega(all, '2026-11-01T00:00:00Z', { Chat_a: pubChat('a', '2026-10-01T00:00:00Z', pub('p1', 'v1')) });
  put(all, 'Chat_a/README.md', '# a\n- v1: [index.html](../published/Guide_ShortA/v1/index.html)\n');
  put(all, 'published/Guide_ShortA/published.json', pageJson({ v1: pubVersion('v1', 0, true, [pin('a', 'p1')], 'one') }));
  put(all, 'published/Guide_ShortA/v1/index.html', 'one');
  const single = path.join(tmp, 'Chat_x_claude-chat');
  put(single, 'original.json', pubChat('x', '2026-10-05T00:00:00Z', [...pub('x1', 'v1'), ...pub('x2', 'v2')]));
  put(single, 'artefacts/guide.html', 'one');
  put(single, 'README.md', '# x\n- v1: same as [guide.html](artefacts/guide.html)\n- v2: [index.html](published/Guide_ShortA/v2/index.html)\n');
  put(single, 'integrated_chat.md', '[saved copy](published/Guide_ShortA/v2/index.html)\n');
  put(single, 'published/Guide_ShortA/published.json', pageJson({
    v1: pubVersion('v1', 0, false, [pin('x', 'x1', true, 'guide.html')], 'one'),
    v2: pubVersion('v2', 1, true, [pin('x', 'x2')], 'two'),
  }));
  put(single, 'published/Guide_ShortA/v2/index.html', 'two');
  put(single, 'viewer.html', '<html>old</html>');
  const before = [hashTree(all), hashTree(single)];
  const out = path.join(tmp, 'out');

  const r = await merge([all, single], { out, name: 'm', now: NOW });
  assert.strictEqual(r.status, 'written', r.reason);
  assert.ok(r.ok, JSON.stringify(r.warnings));
  const dest = path.join(out, 'm');
  assert.deepStrictEqual(fs.readdirSync(path.join(dest, 'Chat_x_claude-chat')).sort(), ['README.md', 'artefacts', 'integrated_chat.md', 'original.json'], 'the chat\'s published/ moved to the root');
  // v1: the Export All's saved folder (the newer source: the chat ZIP has no exported_at), v2 from the chat ZIP.
  assert.deepStrictEqual(treeOf(path.join(dest, 'artifacts/Guide_ShortA')), ['artifact.json', 'v1', 'v1/index.html', 'v2', 'v2/index.html']);
  const json = artifactJson(dest, 'Guide_ShortA');
  assert.deepStrictEqual(json.order, ['v1', 'v2']);
  assert.deepStrictEqual(json.versions.v1.publishedIn.map(p => p.chat), ['a', 'x']);
  assert.strictEqual(fs.readFileSync(path.join(dest, 'artifacts/Guide_ShortA/v1/index.html'), 'utf8'), 'one');
  assert.match(fs.readFileSync(path.join(dest, 'Chat_x_claude-chat/README.md'), 'utf8'), /\[index\.html\]\(\.\.\/artifacts\/Guide_ShortA\/v2\/index\.html\)/);
  assert.match(fs.readFileSync(path.join(dest, 'Chat_x_claude-chat/README.md'), 'utf8'), /\[guide\.html\]\(artefacts\/guide\.html\)/, 'a chat\'s own file stays');
  assert.match(fs.readFileSync(path.join(dest, 'Chat_a/README.md'), 'utf8'), /\(\.\.\/artifacts\/Guide_ShortA\/v1\/index\.html\)/);
  assertLinksResolve(dest);
  const manifest = JSON.parse(fs.readFileSync(path.join(dest, 'export-manifest.json'), 'utf8'));
  assert.strictEqual(manifest.kind, 'merged');
  assert.ok(!('artifacts' in manifest), 'no source had claude.ai\'s list');
  const data = viewerData(dest);
  assert.strictEqual(data.listFetched, false);
  assert.deepStrictEqual(data.artifacts, []);
  assert.match(fs.readFileSync(path.join(dest, 'artifacts/index.md'), 'utf8'), /claude\.ai's list isn't in this export[\s\S]*## Published from chats, not in claude\.ai's list/);
  assert.match(fs.readFileSync(path.join(dest, 'index.md'), 'utf8'), /\*\*Artifacts:\*\* 1 \(\[list\]\(artifacts\/index\.md\)\)/);
  assert.deepStrictEqual([hashTree(all), hashTree(single)], before, 'sources unchanged');
});

test('(b) Review Focus 1: a 1.17 combined archive and a newer 1.18 one of the same account: every version once, both chats\' links open their pages', async () => {
  const tmp = tmpRoot();
  const old = path.join(tmp, 'claude-takeout-2026-11-01');
  mega(old, '2026-11-01T00:00:00Z', {
    Chat_a: pubChat('a', '2026-10-01T00:00:00Z', [...pub('p1', 'v1'), ...pub('p2', 'v2')]),
    Chat_c: pubChat('c', '2026-10-02T00:00:00Z', pub('c2', 'v2')),
  });
  put(old, 'export-manifest.json', manifestOf('2026-11-01T00:00:00Z'));
  put(old, 'Chat_a/README.md', '# a\n- v1: [index.html](../published/Guide_ShortA/v1/index.html)\n- v2: [index.html](../published/Guide_ShortA/v2/index.html)\n');
  put(old, 'Chat_a/full_chat.md', '[saved copy](../published/Guide_ShortA/v2/index.html)\n');
  put(old, 'Chat_c/README.md', '# c (old)\n- v2: [index.html](../published/Guide_ShortA/v2/index.html)\n');
  put(old, 'published/Guide_ShortA/published.json', pageJson({
    v1: pubVersion('v1', 0, true, [pin('a', 'p1')], 'one'), v2: pubVersion('v2', 1, true, [pin('a', 'p2'), pin('c', 'c2')], 'two'),
  }));
  put(old, 'published/Guide_ShortA/v1/index.html', 'one');
  put(old, 'published/Guide_ShortA/v2/index.html', 'two');
  put(old, `artifacts/Guide_${SID}/artifact.json`, format1(U, 'Guide', 'v2', { files: [fileOf('two')], savedIn: { 'index.html': 'published/Guide_ShortA/v2/index.html' }, thumb: `viewer-files/thumbs/${SID}.png` }));
  put(old, 'artifacts/index.md', '# artifacts (1.17)');
  fs.mkdirSync(path.join(old, 'viewer-files/thumbs'), { recursive: true });
  fs.writeFileSync(path.join(old, `viewer-files/thumbs/${SID}.png`), PNG);
  // The 1.18 export: chat a is gone from claude.ai, chat c continued, chat b is new and published v3.
  const neu = path.join(tmp, 'claude-takeout-2026-11-10');
  mega(neu, '2026-11-10T00:00:00Z', {
    Chat_c: pubChat('c', '2026-11-08T00:00:00Z', pub('c2', 'v2')),
    Chat_b: pubChat('b', '2026-11-09T00:00:00Z', pub('b3', 'v3')),
  });
  put(neu, 'export-manifest.json', manifestOf('2026-11-10T00:00:00Z'));
  put(neu, 'Chat_c/README.md', `# c\n- v2: [index.html](../artifacts/Guide_${SID}/v2/index.html)\n`);
  put(neu, 'Chat_b/README.md', `# b\n- v3: [index.html](../artifacts/Guide_${SID}/v3/index.html)\n`);
  put(neu, `artifacts/Guide_${SID}/artifact.json`, format2(U, 'Guide', { current: 'v3', versions: { v2: v2('v2', 'two', [pin('c', 'c2')]), v3: v2('v3', 'three', [pin('b', 'b3')]) } }));
  put(neu, `artifacts/Guide_${SID}/v2/index.html`, 'two');
  put(neu, `artifacts/Guide_${SID}/v3/index.html`, 'three');
  const before = [hashTree(old), hashTree(neu)];
  const out = path.join(tmp, 'out');

  const r = await merge([old, neu], { out, name: 'm', now: NOW });
  assert.strictEqual(r.status, 'written', r.reason);
  assert.ok(r.ok, JSON.stringify(r.warnings));
  assert.deepStrictEqual(r.unmappedLinks, []);
  const dest = path.join(out, 'm');
  assert.deepStrictEqual(treeOf(path.join(dest, 'artifacts')), [`Guide_${SID}`, `Guide_${SID}/artifact.json`, `Guide_${SID}/v1`, `Guide_${SID}/v1/index.html`,
    `Guide_${SID}/v2`, `Guide_${SID}/v2/index.html`, `Guide_${SID}/v3`, `Guide_${SID}/v3/index.html`, 'index.html', 'index.md']);
  assert.deepStrictEqual(['v1', 'v2', 'v3'].map(v => fs.readFileSync(path.join(dest, `artifacts/Guide_${SID}/${v}/index.html`), 'utf8')), ['one', 'two', 'three']);
  const json = artifactJson(dest, `Guide_${SID}`);
  assert.deepStrictEqual([json.listed, json.current, json.order], [true, 'v3', ['v1', 'v2', 'v3']]);
  assert.deepStrictEqual(json.versions.v2.publishedIn.map(p => [p.chat, p.toolUseId]), [['c', 'c2'], ['a', 'p2']], 'publishedIn united, each publish once');
  assert.strictEqual(json.thumb, `viewer-files/thumbs/${SID}.png`, 'the card picture of the newest source that has one');
  assert.match(fs.readFileSync(path.join(dest, 'Chat_a/README.md'), 'utf8'), new RegExp(`\\(\\.\\./artifacts/Guide_${SID}/v1/index\\.html\\)`));
  assert.match(fs.readFileSync(path.join(dest, 'Chat_a/full_chat.md'), 'utf8'), new RegExp(`\\(\\.\\./artifacts/Guide_${SID}/v2/index\\.html\\)`));
  assert.match(fs.readFileSync(path.join(dest, 'Chat_c/README.md'), 'utf8'), /^﻿?# c\n/, 'chat c is the newer copy');
  assertLinksResolve(dest);
  const manifest = JSON.parse(fs.readFileSync(path.join(dest, 'export-manifest.json'), 'utf8'));
  assert.deepStrictEqual(manifest.artifacts, { listed: 1, thumbs: 1, decided_at: '2026-11-10T00:00:00Z', listed_at: { [U]: '2026-11-10T00:00:00Z' } });
  const data = viewerData(dest);
  assert.strictEqual(data.listFetched, true);
  assert.deepStrictEqual(data.artifacts.map(v => [v.title, v.thumb]), [['Guide', `viewer-files/thumbs/${SID}.png`]]);
  assert.deepStrictEqual(fs.readFileSync(path.join(dest, `viewer-files/thumbs/${SID}.png`)), PNG);
  const hrefs = data.chats.flatMap(c => Object.values(c.files).filter(f => f.published).flatMap(f => f.versions.map(v => v.href))).filter(Boolean);
  assert.ok(hrefs.length >= 4);
  for (const h of hrefs) assert.ok(fs.existsSync(path.join(dest, h)), h);
  assert.deepStrictEqual([hashTree(old), hashTree(neu)], before, 'sources unchanged');
});

test('(c) Review Focus 4: a renamed chat folder (_2): sameAs and rewritten links point at the right chat', async () => {
  const tmp = tmpRoot();
  const a = path.join(tmp, 'claude-takeout-2026-11-01');
  mega(a, '2026-11-01T00:00:00Z', { Chat_x: pubChat('x1', '2026-10-01T00:00:00Z', pub('p1', 'v1')) });
  put(a, 'export-manifest.json', manifestOf('2026-11-01T00:00:00Z'));
  put(a, 'Chat_x/artefacts/guide.html', 'one');
  put(a, 'Chat_x/README.md', '# x1\n- v1: same as [guide.html](artefacts/guide.html)\n');
  put(a, `artifacts/Guide_${SID}/artifact.json`, format2(U, 'Guide', { current: 'v2', versions: {
    v1: v2(null, 'one', [pin('x1', 'p1', true, 'guide.html')], { sameAs: { 'index.html': 'Chat_x/artefacts/guide.html' } }),
  } }));
  // A later Export Changes: another chat with the same folder name, the page under a new title (another folder).
  const b = path.join(tmp, 'claude-takeout-changes-2026-11-05');
  mega(b, '2026-11-05T00:00:00Z', { Chat_x: pubChat('x2', '2026-11-04T00:00:00Z', pub('q2', 'v2', 'Guide 2')) });
  put(b, 'export-manifest.json', manifestOf('2026-11-05T00:00:00Z', 'changes'));
  put(b, 'Chat_x/README.md', `# x2\n- v2: [index.html](../artifacts/Guide_2_${SID}/v2/index.html)\n`);
  put(b, `artifacts/Guide_2_${SID}/artifact.json`, format2(U, 'Guide 2', { current: 'v2', versions: { v2: v2('v2', 'two', [pin('x2', 'q2')]) } }));
  put(b, `artifacts/Guide_2_${SID}/v2/index.html`, 'two');
  const out = path.join(tmp, 'out');

  const r = await merge([a, b], { out, name: 'm', now: NOW });
  assert.strictEqual(r.status, 'written', r.reason);
  assert.ok(r.ok, JSON.stringify(r.warnings));
  const dest = path.join(out, 'm');
  const manifest = JSON.parse(fs.readFileSync(path.join(dest, 'export-manifest.json'), 'utf8'));
  assert.deepStrictEqual(manifest.chats.map(c => [c.uuid, c.folder]), [['x2', 'Chat_x'], ['x1', 'Chat_x_2']]);
  // The newer Export Changes lists the page, so its title names the folder; the full export's sameAs follows it there.
  assert.deepStrictEqual(fs.readdirSync(path.join(dest, 'artifacts')).filter(n => n.endsWith(SID)), [`Guide_2_${SID}`]);
  const json = artifactJson(dest, `Guide_2_${SID}`);
  assert.deepStrictEqual([json.title, json.current], ['Guide 2', 'v2']);
  assert.deepStrictEqual(json.versions.v1.sameAs, { 'index.html': 'Chat_x_2/artefacts/guide.html' });
  assert.match(fs.readFileSync(path.join(dest, 'Chat_x/README.md'), 'utf8'), new RegExp(`\\(\\.\\./artifacts/Guide_2_${SID}/v2/index\\.html\\)`));
  assertLinksResolve(dest);
  const data = viewerData(dest);
  const x1 = data.chats.find(c => c.id === 'x1');
  assert.deepStrictEqual(Object.values(x1.files).filter(f => f.published).flatMap(f => f.versions.map(v => v.href)), ['Chat_x_2/artefacts/guide.html']);
});

test('(d) only Export Artifacts exports (flat 1.17 and 1.18): an Export All shaped archive with no chats and the Artifacts screen', async () => {
  const tmp = tmpRoot();
  const flat = path.join(tmp, 'claude-takeout-artifacts-2026-11-01');
  put(flat, 'export-manifest.json', JSON.stringify({ format: 1, kind: 'artifacts', exported_at: '2026-11-01T00:00:00Z', listed: 1, thumbs: 0, artifacts: [] }));
  put(flat, `Guide_${SID}/artifact.json`, format1(U, 'Guide', 'v1', { files: [fileOf('one')] }));
  put(flat, `Guide_${SID}/index.html`, 'one');
  put(flat, 'index.html', '<html>index</html>');
  const v18 = path.join(tmp, 'claude-takeout-artifacts-2026-11-05.zip');
  const zip = new JSZip();
  const r18 = 'claude-takeout-artifacts-2026-11-05/';
  zip.file(r18 + 'export-manifest.json', JSON.stringify({ format: 1, kind: 'artifacts', exported_at: '2026-11-05T00:00:00Z', listed: 2, thumbs: 0, artifacts: [] }));
  zip.file(r18 + `Guide_${SID}/artifact.json`, format2(U, 'Guide', { current: 'v2', versions: { v2: v2('v2', 'two') } }));
  zip.file(r18 + `Guide_${SID}/v2/index.html`, 'two');
  zip.file(r18 + `Other_${OID}/artifact.json`, format2(OTHER, 'Other', { current: 'w1', versions: { w1: v2('w1', 'other') } }));
  zip.file(r18 + `Other_${OID}/w1/index.html`, 'other');
  fs.writeFileSync(v18, await zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX' }));
  const out = path.join(tmp, 'out');

  const r = await merge([flat, v18], { out, name: 'm', now: NOW });
  assert.strictEqual(r.status, 'written', r.reason);
  assert.ok(r.ok, JSON.stringify(r.warnings));
  assert.deepStrictEqual([r.chats, r.artifacts], [0, 2]);
  const dest = path.join(out, 'm');
  assert.deepStrictEqual(fs.readdirSync(out), ['m']);
  assert.deepStrictEqual(fs.readdirSync(dest).sort(), ['artifacts', 'export-manifest.json', 'index.md', 'viewer-check.gif', 'viewer-files', 'viewer.html']);
  assert.deepStrictEqual(treeOf(path.join(dest, 'artifacts')), [`Guide_${SID}`, `Guide_${SID}/artifact.json`, `Guide_${SID}/v1`, `Guide_${SID}/v1/index.html`,
    `Guide_${SID}/v2`, `Guide_${SID}/v2/index.html`, `Other_${OID}`, `Other_${OID}/artifact.json`, `Other_${OID}/w1`, `Other_${OID}/w1/index.html`, 'index.html', 'index.md']);
  assert.deepStrictEqual(artifactJson(dest, `Guide_${SID}`).order, ['v1', 'v2']);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dest, 'export-manifest.json'), 'utf8')).kind, 'merged');
  const found = require('../tools/archive-lib.js').findArchives(dest);
  assert.deepStrictEqual(found.archives.map(x => [x.kind, x.chats.length]), [['mega', 0]]);
  const data = viewerData(dest);
  assert.deepStrictEqual(data.chats, []);
  assert.deepStrictEqual(data.artifacts.map(v => v.title).sort(), ['Guide', 'Other']);
});

// An Export All with chat <name> and artifact folders: records [uuid, title, listed, ver = 'v1'], each holding that one version.
function artifactsMega(tmp, name, at, kind, records) {
  const root = path.join(tmp, name);
  mega(root, at, { [`Chat_${name}`]: chatJson(name, at) });
  put(root, 'export-manifest.json', manifestOf(at, kind));
  for (const [uuid, title, listed, ver = 'v1'] of records) {
    const dir = `${title.replace(/ /g, '_')}_${uuidToBase58(uuid)}`;
    put(root, `artifacts/${dir}/artifact.json`, format2(uuid, title, { listed, current: ver, versions: { [ver]: v2(ver, `${title} ${ver}`) } }));
    put(root, `artifacts/${dir}/${ver}/index.html`, `${title} ${ver}`);
  }
  return root;
}

test('(e) an artifact a newer full export no longer lists is unlisted; a newer Export Changes that doesn\'t list it doesn\'t list it again', async () => {
  const tmp = tmpRoot();
  const older = artifactsMega(tmp, 'o', '2026-11-01T00:00:00Z', 'full', [[U, 'Guide', true], [OTHER, 'Other', true]]);
  const newer = artifactsMega(tmp, 'n', '2026-11-05T00:00:00Z', 'full', [[U, 'Guide', true]]);
  // The newest: an Export Changes where a chat published Other, which claude.ai's list doesn't have.
  const changes = artifactsMega(tmp, 'c', '2026-11-07T00:00:00Z', 'changes', [[OTHER, 'Other', false]]);
  const out = path.join(tmp, 'out');
  const r = await merge([older, newer, changes], { out, name: 'm', now: NOW });
  assert.strictEqual(r.status, 'written', r.reason);
  const dest = path.join(out, 'm');
  assert.strictEqual(artifactJson(dest, `Guide_${SID}`).listed, true);
  assert.strictEqual(artifactJson(dest, `Other_${OID}`).listed, false, 'deleted on claude.ai: the newest full export doesn\'t list it');
  assert.strictEqual(fs.readFileSync(path.join(dest, `artifacts/Other_${OID}/v1/index.html`), 'utf8'), 'Other v1', 'its version is kept');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dest, 'export-manifest.json'), 'utf8')).artifacts, { listed: 1, thumbs: 0, decided_at: '2026-11-05T00:00:00Z', listed_at: { [U]: '2026-11-05T00:00:00Z' } });
  assert.match(fs.readFileSync(path.join(dest, 'artifacts/index.md'), 'utf8'), /\*\*Listed by claude\.ai:\*\* 1[\s\S]*Guide[\s\S]*## Published from chats, not in claude\.ai's list[\s\S]*Other/);
  assert.deepStrictEqual(viewerData(dest).artifacts.map(v => v.title), ['Guide']);
});

test('(e2) a newer Export Changes lists a new artifact and moves a changed one\'s current version; an older one doesn\'t outvote the full export', async () => {
  const THIRD = '7a1b2c3d-1111-4222-8333-444455556666';
  const tmp = tmpRoot();
  // Older than the full export: listed Third, which the full export no longer lists.
  const early = artifactsMega(tmp, 'e', '2026-10-25T00:00:00Z', 'changes', [[THIRD, 'Third', true]]);
  const full = artifactsMega(tmp, 'f', '2026-11-01T00:00:00Z', 'full', [[U, 'Guide', true, 'v1']]);
  const changes = artifactsMega(tmp, 'c', '2026-11-07T00:00:00Z', 'changes', [[U, 'Guide new', true, 'v2'], [OTHER, 'Other', true, 'w1']]);
  // Other's record says some of its versions weren't saved: the merged index row says so too.
  const otherJson = path.join(changes, `artifacts/Other_${OID}/artifact.json`);
  fs.writeFileSync(otherJson, JSON.stringify({ ...JSON.parse(fs.readFileSync(otherJson, 'utf8')), incomplete: true }));
  const out = path.join(tmp, 'out');
  const r = await merge([early, full, changes], { out, name: 'm', now: NOW });
  assert.strictEqual(r.status, 'written', r.reason);
  assert.ok(r.ok, JSON.stringify(r.warnings));
  const dest = path.join(out, 'm');
  const guide = artifactJson(dest, `Guide_new_${SID}`);
  assert.deepStrictEqual([guide.listed, guide.current, guide.title, guide.order], [true, 'v2', 'Guide new', ['v1', 'v2']], 'the changed artifact: the newer current version');
  const other = artifactJson(dest, `Other_${OID}`);
  assert.deepStrictEqual([other.listed, other.current, other.incomplete], [true, 'w1', true], 'the new artifact is listed');
  assert.match(fs.readFileSync(path.join(dest, 'artifacts/index.md'), 'utf8'), /Other[^\n]*some versions not saved/);
  assert.strictEqual(artifactJson(dest, `Third_${uuidToBase58(THIRD)}`).listed, false, 'the full export is newer and doesn\'t list it');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dest, 'export-manifest.json'), 'utf8')).artifacts, { listed: 2, thumbs: 0, decided_at: '2026-11-01T00:00:00Z', listed_at: { [U]: '2026-11-07T00:00:00Z', [OTHER]: '2026-11-07T00:00:00Z' } });
  assert.deepStrictEqual(viewerData(dest).artifacts.map(v => [v.title, v.ver]).sort(), [['Guide new', 'v2'], ['Other', 'w1']]);
});

test('(e4) an earlier merge doesn\'t list an artifact again that a full export older than the merge no longer lists', async () => {
  const tmp = tmpRoot();
  const old = artifactsMega(tmp, 'o', '2026-10-01T00:00:00Z', 'full', [[U, 'Guide', true], [OTHER, 'Other', true]]);
  let r = await merge([old], { out: path.join(tmp, 'm1'), name: 'm', now: new Date('2026-11-20T00:00:00Z') });
  assert.strictEqual(r.status, 'written', r.reason);
  const earlier = path.join(tmp, 'm1', 'm');
  assert.strictEqual(artifactJson(earlier, `Other_${OID}`).listed, true);
  const full = artifactsMega(tmp, 'f', '2026-11-10T00:00:00Z', 'full', [[U, 'Guide', true]]);
  r = await merge([earlier, full], { out: path.join(tmp, 'm2'), name: 'm', now: NOW });
  assert.strictEqual(r.status, 'written', r.reason);
  const dest = path.join(tmp, 'm2', 'm');
  assert.strictEqual(artifactJson(dest, `Guide_${SID}`).listed, true);
  assert.strictEqual(artifactJson(dest, `Other_${OID}`).listed, false, 'the merge is newer by exported_at, but only the full export asked claude.ai');
});

test('(e3) only Export Changes sources: their list is in the merged archive; a 1.18 source with no list in its manifest adds none', async () => {
  const tmp = tmpRoot();
  const first = artifactsMega(tmp, 'c1', '2026-11-01T00:00:00Z', 'changes', [[U, 'Guide', true]]);
  const second = artifactsMega(tmp, 'c2', '2026-11-05T00:00:00Z', 'changes', [[OTHER, 'Other', true, 'w1']]);
  let r = await merge([first, second], { out: path.join(tmp, 'out'), name: 'm', now: NOW });
  assert.strictEqual(r.status, 'written', r.reason);
  let dest = path.join(tmp, 'out', 'm');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dest, 'export-manifest.json'), 'utf8')).artifacts, { listed: 2, thumbs: 0, decided_at: null, listed_at: { [U]: '2026-11-01T00:00:00Z', [OTHER]: '2026-11-05T00:00:00Z' } });
  let data = viewerData(dest);
  assert.strictEqual(data.listFetched, true);
  assert.deepStrictEqual(data.artifacts.map(v => v.title).sort(), ['Guide', 'Other']);
  // A source whose manifest has no artifact step (its records still say listed): no list in the merge.
  const bare = artifactsMega(tmp, 'b', '2026-11-01T00:00:00Z', 'full', [[U, 'Guide', true]]);
  put(bare, 'export-manifest.json', manifestOf('2026-11-01T00:00:00Z', 'full', false));
  r = await merge([bare], { out: path.join(tmp, 'out2'), name: 'm', now: NOW });
  assert.strictEqual(r.status, 'written', r.reason);
  dest = path.join(tmp, 'out2', 'm');
  assert.ok(!('artifacts' in JSON.parse(fs.readFileSync(path.join(dest, 'export-manifest.json'), 'utf8'))));
  assert.strictEqual(viewerData(dest).listFetched, false, 'the Artifacts screen says the list isn\'t in this export');
});

test('(f) a sameAs version whose chat copy in the merge differs: its bytes are copied into its version folder', async () => {
  const tmp = tmpRoot();
  const a = path.join(tmp, 'a');
  mega(a, '2026-11-01T00:00:00Z', { Chat_a: pubChat('a', '2026-10-01T00:00:00Z', pub('p1', 'v1')) });
  put(a, 'export-manifest.json', manifestOf('2026-11-01T00:00:00Z'));
  put(a, 'Chat_a/artefacts/guide.html', 'one');
  put(a, 'Chat_a/README.md', '# a\n- v1: same as [guide.html](artefacts/guide.html)\n');
  put(a, `artifacts/Guide_${SID}/artifact.json`, format2(U, 'Guide', { current: 'v1', versions: {
    v1: v2(null, 'one', [pin('a', 'p1', true, 'guide.html')], { sameAs: { 'index.html': 'Chat_a/artefacts/guide.html' } }),
  } }));
  // Chat a continued: its guide.html was edited after the publish.
  const b = path.join(tmp, 'b');
  mega(b, '2026-11-05T00:00:00Z', { Chat_a: pubChat('a', '2026-11-04T00:00:00Z', pub('p1', 'v1')) });
  put(b, 'export-manifest.json', manifestOf('2026-11-05T00:00:00Z', 'changes', false));
  put(b, 'Chat_a/artefacts/guide.html', 'one, edited');
  put(b, 'Chat_a/README.md', '# a\n');
  put(b, `Chat_a/published-notes.md`, 'x');
  const r = await merge([a, b], { out: path.join(tmp, 'out'), name: 'm', now: NOW });
  assert.strictEqual(r.status, 'written', r.reason);
  assert.strictEqual(r.sameCopied, 1);
  const dest = path.join(tmp, 'out', 'm');
  const json = artifactJson(dest, `Guide_${SID}`);
  assert.strictEqual(json.versions.v1.folder, 'v1');
  assert.ok(!json.versions.v1.sameAs);
  assert.deepStrictEqual([json.versions.v1.saved, json.versions.v1.startSaved, json.versions.v1.files[0].savedAs], [true, 'index.html', 'index.html']);
  assert.strictEqual(fs.readFileSync(path.join(dest, `artifacts/Guide_${SID}/v1/index.html`), 'utf8'), 'one', 'the version as published');
  assert.strictEqual(fs.readFileSync(path.join(dest, 'Chat_a/artefacts/guide.html'), 'utf8'), 'one, edited', 'the chat\'s newer copy');
});

test('(g) a link the merge can\'t map is left as it is and reported, broken or kept, also with --json', async () => {
  const tmp = tmpRoot();
  const a = path.join(tmp, 'a');
  mega(a, '2026-11-01T00:00:00Z', { Chat_a: pubChat('a', '2026-10-01T00:00:00Z', pub('p1', 'v1')) });
  put(a, 'Chat_a/README.md', '# a\n- [gone](../published/Missing_y/v1/index.html)\n- [kept](../published/Gone_x/v1/index.html)\n- v1: [index.html](../published/Guide_ShortA/v1/index.html)\n');
  put(a, 'published/Guide_ShortA/published.json', pageJson({ v1: pubVersion('v1', 0, true, [pin('a', 'p1')], 'one') }));
  put(a, 'published/Guide_ShortA/v1/index.html', 'one');
  put(a, 'published/Gone_x/v1/index.html', 'no published.json beside it');
  const r = await merge([a], { out: path.join(tmp, 'out'), name: 'm', now: NOW });
  assert.strictEqual(r.status, 'written', r.reason);
  assert.deepStrictEqual(r.unmappedLinks, [
    { chat: 'Chat_a', file: 'README.md', target: '../published/Missing_y/v1/index.html', broken: true },
    { chat: 'Chat_a', file: 'README.md', target: '../published/Gone_x/v1/index.html', broken: false },
  ]);
  assert.ok(r.warnings.some(w => w.includes('../published/Missing_y/v1/index.html') && /broken in the merged archive/.test(w)));
  assert.ok(!r.warnings.some(w => w.includes('../published/Gone_x/v1/index.html')), 'a kept page\'s link works, so no warning');
  const readme = fs.readFileSync(path.join(tmp, 'out/m/Chat_a/README.md'), 'utf8');
  assert.match(readme, /\[gone\]\(\.\.\/published\/Missing_y\/v1\/index\.html\)/);
  assert.match(readme, /\[index\.html\]\(\.\.\/artifacts\/Guide_ShortA\/v1\/index\.html\)/);
  const res = spawnSync(process.execPath, [TOOL, a, '--out', path.join(tmp, 'out2'), '--json'], { encoding: 'utf8' });
  assert.deepStrictEqual(JSON.parse(res.stdout).unmappedLinks.map(l => [l.target, l.broken]), [['../published/Missing_y/v1/index.html', true], ['../published/Gone_x/v1/index.html', false]]);
  const text = spawnSync(process.execPath, [TOOL, a, '--out', path.join(tmp, 'out3')], { encoding: 'utf8' });
  assert.match(text.stdout, /2 links left as they were, 1 broken in the merged archive/);
});

test('published/ folders with no published.json are kept as they are, at the root and in a chat, and their links still open', async () => {
  const tmp = tmpRoot();
  // A chat ZIP: its own published/ holds a page it read (Guide) and a loose folder and file.
  const single = path.join(tmp, 'Chat_x_claude-chat');
  put(single, 'original.json', pubChat('x', '2026-10-05T00:00:00Z', pub('x1', 'v1')));
  put(single, 'published/Guide_ShortA/published.json', pageJson({ v1: pubVersion('v1', 0, true, [pin('x', 'x1')], 'one') }));
  put(single, 'published/Guide_ShortA/v1/index.html', 'one');
  put(single, 'published/Loose/index.html', 'loose page');
  put(single, 'published/notes.txt', 'loose file');
  put(single, 'README.md', '# x\n- [v1](published/Guide_ShortA/v1/index.html)\n- [loose](published/Loose/index.html)\n- [notes](published/notes.txt)\n');
  // An Export All: the same at the root; a later source with a loose folder of the same name keeps its own.
  const all = path.join(tmp, 'all');
  mega(all, '2026-11-01T00:00:00Z', { Chat_a: pubChat('a', '2026-10-01T00:00:00Z', pub('p1', 'v1')) });
  put(all, 'Chat_a/README.md', '# a\n- [v1](../published/Guide_ShortA/v1/index.html)\n- [loose](../published/RootLoose/index.html)\n');
  put(all, 'published/Guide_ShortA/published.json', pageJson({ v1: pubVersion('v1', 0, true, [pin('a', 'p1')], 'one') }));
  put(all, 'published/Guide_ShortA/v1/index.html', 'one');
  put(all, 'published/RootLoose/index.html', 'root loose page');
  put(all, 'published/RootLoose/published.json', '{ not json');
  const before = [hashTree(single), hashTree(all)];
  const out = path.join(tmp, 'out');
  const r = await merge([single, all], { out, name: 'm', now: NOW });
  assert.strictEqual(r.status, 'written', r.reason);
  const dest = path.join(out, 'm');
  assert.deepStrictEqual(r.keptPublished.map(k => k.to).sort(), ['Chat_x_claude-chat/published/Loose', 'Chat_x_claude-chat/published/notes.txt', 'published/RootLoose']);
  assert.deepStrictEqual(treeOf(path.join(dest, 'Chat_x_claude-chat/published')), ['Loose', 'Loose/index.html', 'notes.txt']);
  assert.deepStrictEqual(treeOf(path.join(dest, 'published')), ['RootLoose', 'RootLoose/index.html', 'RootLoose/published.json']);
  assert.deepStrictEqual(r.unmappedLinks.filter(l => l.broken), []);
  assertLinksResolveAllowingKept(dest);
  assert.match(fs.readFileSync(path.join(dest, 'Chat_x_claude-chat/README.md'), 'utf8'), /\[v1\]\(\.\.\/artifacts\/Guide_ShortA\/v1\/index\.html\)/);
  assert.ok(r.warnings.some(w => /kept in published\/RootLoose \(no published\.json\)/.test(w)));
  assert.deepStrictEqual([hashTree(single), hashTree(all)], before, 'sources unchanged');
});

test('a file that can\'t be copied into artifacts/ stops the merge, and nothing is left under --out', async () => {
  const tmp = tmpRoot();
  const a = path.join(tmp, 'a');
  mega(a, '2026-11-01T00:00:00Z', { Chat_a: chatJson('a', '2026-10-01T00:00:00Z') });
  put(a, 'export-manifest.json', manifestOf('2026-11-01T00:00:00Z'));
  put(a, `artifacts/Guide_${SID}/artifact.json`, format2(U, 'Guide', { current: 'v1', versions: { v1: v2('v1', 'one') } }));
  put(a, `artifacts/Guide_${SID}/v1/index.html`, 'one');
  const out = path.join(tmp, 'out');
  const real = fs.copyFileSync;
  fs.copyFileSync = (src, dest, mode) => {
    if (dest.includes(`${path.sep}artifacts${path.sep}`)) throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
    return real(src, dest, mode);
  };
  let r;
  try { r = await merge([a], { out, name: 'm', now: NOW }); } finally { fs.copyFileSync = real; }
  assert.strictEqual(r.status, 'failed');
  assert.match(r.reason, /could not copy .*EIO/);
  assert.deepStrictEqual(fs.readdirSync(out), [], 'the build folder is removed');
});

test('a dry run of a merge with artifacts writes nothing and leaves the sources alone', async () => {
  const tmp = tmpRoot();
  const a = path.join(tmp, 'a');
  mega(a, '2026-11-01T00:00:00Z', { Chat_a: pubChat('a', '2026-10-01T00:00:00Z', pub('p1', 'v1')) });
  put(a, 'export-manifest.json', manifestOf('2026-11-01T00:00:00Z'));
  put(a, `artifacts/Guide_${SID}/artifact.json`, format2(U, 'Guide', { current: 'v1', versions: { v1: v2('v1', 'one') } }));
  put(a, `artifacts/Guide_${SID}/v1/index.html`, 'one');
  const before = hashTree(a);
  const out = path.join(tmp, 'out');
  const r = await merge([a], { out, name: 'm', dryRun: true, now: NOW });
  assert.strictEqual(r.status, 'written', r.reason);
  assert.deepStrictEqual([r.chats, r.artifacts], [1, 1]);
  assert.ok(!fs.existsSync(out));
  assert.deepStrictEqual(hashTree(a), before);
});

test('artifactJsonV2FromDisk writes what popup.js\'s artifactJsonV2 writes, key for key', () => {
  const { sandbox } = loadPopup();
  const files = [{ path: 'index.html', savedAs: 'index.html', size: 3, contentType: 'text/html', sha256: sha('one'), verified: true },
    { path: 'a/b.js', savedAs: 'a/b.js', size: null, contentType: null, sha256: null, verified: false }];
  const ver = (folder, extra = {}) => ({ folder, files: files.map(f => ({ ...f, savedAs: folder ? f.savedAs : null })), start: 'index.html', startSaved: folder ? 'index.html' : null,
    incomplete: false, missing: [], saved: !!folder, publishedIn: [pin('c1', 't1', true, 'guide.html')], ...extra });
  const meta = { url: `https://claude.ai/artifact/${SID}`, typeTitle: 'App', sourceSurface: 'chat', rel: 'mine', public: true, createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z', note: 'a note', start: 'index.html', needsRuntime: true };
  // A version with no folder that still carries saved names (a fetch's, before a chat's file stood for it): written
  // with none.
  const unsaved = () => ver(null, { files: files.map(f => ({ ...f })), startSaved: 'index.html', saved: true, sameAs: { 'index.html': 'Chat/artefacts/guide.html' } });
  // Numeric-looking ids, so key order alone would put 10 first.
  const popupRec = { uuid: U, shortId: SID, title: 'Guide', listed: true, current: '10', history: ['1', '2', '10'], incomplete: true, meta: { ...meta, thumb: `viewer-files/thumbs/${SID}.png` },
    versions: new Map([['1', unsaved()], ['2', ver(null, { sameAs: { 'index.html': 'Chat/artefacts/guide.html' } })], ['10', ver('10', { incomplete: true, missing: ['a/b.js'] })]]) };
  const diskRec = { uuid: U, shortId: SID, title: 'Guide', listed: true, current: '10', meta: { ...meta, incomplete: true }, thumbRel: `viewer-files/thumbs/${SID}.png`, order: ['1', '2', '10'],
    versions: new Map([['1', unsaved()], ['2', ver(null, { sameAs: { 'index.html': 'Chat/artefacts/guide.html' } })], ['10', ver(`artifacts/Guide_${SID}/10`, { incomplete: true, missing: ['a/b.js'] })]]) };
  const fromPopup = vm.runInContext('artifactJsonV2', sandbox)(popupRec);
  const fromDisk = require('../tools/archive-lib.js').artifactJsonV2FromDisk(diskRec);
  assert.strictEqual(JSON.stringify(fromDisk, null, 2), JSON.stringify(fromPopup, null, 2));
  assert.deepStrictEqual(fromDisk.order, ['1', '2', '10']);
  assert.deepStrictEqual([fromPopup.versions['1'].files.map(f => f.savedAs), fromPopup.versions['1'].startSaved, fromPopup.versions['1'].saved], [[null, null], null, false]);
  // And with the optional keys left out.
  const plain = r => ({ ...r, incomplete: false, meta: { ...r.meta, thumb: undefined, incomplete: false }, thumbRel: null });
  assert.strictEqual(JSON.stringify(require('../tools/archive-lib.js').artifactJsonV2FromDisk(plain(diskRec))), JSON.stringify(vm.runInContext('artifactJsonV2', sandbox)(plain(popupRec))));
});

test('rewriteChatLinks maps links into published/ and artifacts/ only, and lists the ones it can\'t map', () => {
  const { rewriteChatLinks } = require('../tools/archive-lib.js');
  const text = '[a](../published/P/v1/index%20(1).html) [b](artefacts/x.html) [c](published/P/v2/i.html) [d](../artifacts/A/v1/i.html) [e](https://claude.ai/x) [c2](published/P/v2/i.html)';
  const got = rewriteChatLinks(text, t => (t.startsWith('published/') ? null : `NEW:${t}`));
  assert.strictEqual(got.text, '[a](NEW:../published/P/v1/index%20(1).html) [b](artefacts/x.html) [c](published/P/v2/i.html) [d](NEW:../artifacts/A/v1/i.html) [e](https://claude.ai/x) [c2](published/P/v2/i.html)');
  assert.deepStrictEqual(got.unmapped, ['published/P/v2/i.html']);
  // Code is text, not links: fenced blocks (``` and ~~~, a longer fence holding a shorter one, an unclosed one) and
  // inline code spans are left alone.
  const map = t => `NEW:${t}`;
  const code = [
    ['```\n[x](published/a)\n```\n[y](published/b)', '```\n[x](published/a)\n```\n[y](NEW:published/b)'],
    ['````md\n```\n[x](published/a)\n```\n````\n[y](published/b)', '````md\n```\n[x](published/a)\n```\n````\n[y](NEW:published/b)'],
    ['~~~\n[x](published/a)\n~~~\n[y](published/b)', '~~~\n[x](published/a)\n~~~\n[y](NEW:published/b)'],
    ['  ```js\n[x](../published/a)\n  ```\n', '  ```js\n[x](../published/a)\n  ```\n'],
    ['see `[x](published/a)` and [y](published/b)', 'see `[x](published/a)` and [y](NEW:published/b)'],
    ['``[x](published/a) ` `` [y](published/b)', '``[x](published/a) ` `` [y](NEW:published/b)'],
    ['a ` lone [y](published/b)', 'a ` lone [y](NEW:published/b)'],
    ['```\n[x](published/a)\nnever closed', '```\n[x](published/a)\nnever closed'],
    // A span never crosses a blank line: a stray backtick in one paragraph doesn't hide a link in the next.
    ['Use the ` key.\n\n[saved copy](../published/G_x/v1/index.html)\n\nThen type ` again.', 'Use the ` key.\n\n[saved copy](NEW:../published/G_x/v1/index.html)\n\nThen type ` again.'],
    ['Use the ` key.\n  \t\n[y](published/b) then ` again', 'Use the ` key.\n  \t\n[y](NEW:published/b) then ` again'],
    ['a `span\nover two lines [x](published/a)` [y](published/b)', 'a `span\nover two lines [x](published/a)` [y](NEW:published/b)'],
    // A backslash-escaped backtick opens no span; an escaped backslash before one doesn't escape it.
    ['type \\` then [y](published/b) and \\` again', 'type \\` then [y](NEW:published/b) and \\` again'],
    ['a \\\\`[x](published/a)` [y](published/b)', 'a \\\\`[x](published/a)` [y](NEW:published/b)'],
  ];
  for (const [input, want] of code) assert.strictEqual(rewriteChatLinks(input, map).text, want, input);
  assert.deepStrictEqual(rewriteChatLinks('`[x](published/a)`', () => null).unmapped, [], 'a link in code is not reported');
});

test('a source that has only artifacts is accepted, not refused', async () => {
  const tmp = tmpRoot();
  const a = path.join(tmp, 'a');
  const b = path.join(tmp, 'b');
  mega(a, '2026-10-01T00:00:00Z', { Chat_a: chatJson('a', '2026-10-01T00:00:00Z') });
  mega(b, '2026-10-02T00:00:00Z', { Chat_b: chatJson('b', '2026-10-02T00:00:00Z') });
  put(b, 'export-manifest.json', JSON.stringify({ format: 1, exported_at: '2026-10-02T00:00:00Z', kind: 'full', chats: [], artifacts: { listed: 1, thumbs: 0, items: [] } }));
  const out = path.join(tmp, 'out');
  const r = await merge([a, b], { out, name: 'all', now: NOW });
  assert.strictEqual(r.status, 'written', r.reason);
  assert.strictEqual(r.chats, 2);
  const res = spawnSync(process.execPath, [TOOL, a, b, '--out', path.join(tmp, 'out2')], { encoding: 'utf8' });
  assert.strictEqual(res.status, 0, res.stderr);
});

test('a ZIP source with artifacts/ is extracted and merged', async () => {
  const tmp = tmpRoot();
  const zip = new JSZip();
  zip.file('claude-takeout-z/index.md', '# all');
  zip.file('claude-takeout-z/export-manifest.json', manifestOf('2026-11-01T00:00:00Z'));
  zip.file('claude-takeout-z/Chat_y/original.json', chatJson('y', '2026-10-02T00:00:00Z'));
  zip.file(`claude-takeout-z/artifacts/Guide_${SID}/artifact.json`, format2(U, 'Guide', { current: 'v1', versions: { v1: v2('v1', 'one') } }));
  zip.file(`claude-takeout-z/artifacts/Guide_${SID}/v1/index.html`, 'one');
  const zipPath = path.join(tmp, 'claude-takeout-z.zip');
  fs.writeFileSync(zipPath, await zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX' }));
  const out = path.join(tmp, 'out');
  const r = await merge([zipPath], { out, name: 'all', now: NOW });
  assert.strictEqual(r.status, 'written', r.reason);
  assert.deepStrictEqual(fs.readdirSync(out), ['all']);
  assert.strictEqual(fs.readFileSync(path.join(out, `all/artifacts/Guide_${SID}/v1/index.html`), 'utf8'), 'one');
});

test('a chat folder with its own artifacts/ in a ZIP is not refused', async () => {
  const tmp = tmpRoot();
  const zip = new JSZip();
  zip.file('claude-takeout-z/index.md', '# all');
  zip.file('claude-takeout-z/Chat_y/original.json', chatJson('y', '2026-10-02T00:00:00Z'));
  zip.file('claude-takeout-z/Chat_y/artifacts/x.txt', 'x');
  const zipPath = path.join(tmp, 'claude-takeout-z.zip');
  fs.writeFileSync(zipPath, await zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX' }));
  const r = await merge([zipPath], { out: path.join(tmp, 'out'), name: 'all', now: NOW });
  assert.notStrictEqual(r.refused, true);
  assert.strictEqual(r.status, 'written', r.reason);
});

test('an Export Artifacts ZIP with no readable artifact.json holds nothing to merge', async () => {
  const tmp = tmpRoot();
  const zip = new JSZip();
  zip.file('claude-takeout-artifacts-x/export-manifest.json', JSON.stringify({ format: 1, kind: 'artifacts', artifacts: [] }));
  zip.file('claude-takeout-artifacts-x/Page_ab/artifact.json', '{}');
  const zipPath = path.join(tmp, 'claude-takeout-artifacts-x.zip');
  fs.writeFileSync(zipPath, await zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX' }));
  const r = await merge([zipPath], { out: path.join(tmp, 'out'), name: 'all', now: NOW });
  assert.notStrictEqual(r.refused, true);
  assert.strictEqual(r.status, 'failed');
  assert.match(r.reason, /no Claude chats or artifacts/);
});

test('an unwrapped ZIP whose chat folder holds artifacts/ is not refused', async () => {
  const tmp = tmpRoot();
  const zip = new JSZip();
  zip.file('Chat_y/original.json', chatJson('y', '2026-10-02T00:00:00Z'));
  zip.file('Chat_y/artifacts/x.txt', 'x');
  const zipPath = path.join(tmp, 'single.zip');
  fs.writeFileSync(zipPath, await zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX' }));
  const r = await merge([zipPath], { out: path.join(tmp, 'out'), name: 'all', now: NOW });
  assert.notStrictEqual(r.refused, true);
  assert.strictEqual(r.status, 'written', r.reason);
});

test('an Export Artifacts ZIP with a user file named original.json is not refused', async () => {
  const tmp = tmpRoot();
  const zip = new JSZip();
  zip.file('claude-takeout-artifacts-x/export-manifest.json', JSON.stringify({ format: 1, kind: 'artifacts', artifacts: [] }));
  zip.file('claude-takeout-artifacts-x/Page_ab/artifact.json', '{}');
  zip.file('claude-takeout-artifacts-x/Page_ab/original.json', '{}');
  const zipPath = path.join(tmp, 'claude-takeout-artifacts-x.zip');
  fs.writeFileSync(zipPath, await zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX' }));
  const r = await merge([zipPath], { out: path.join(tmp, 'out'), name: 'all', now: NOW });
  assert.notStrictEqual(r.refused, true);
});

test('merge_archives does not refuse an old archive whose chat folder is named Artifacts', async () => {
  const tmp = tmpRoot();
  const a = path.join(tmp, 'a');
  mega(a, '2026-10-01T00:00:00Z', { Artifacts: chatJson('a', '2026-10-01T00:00:00Z') });
  const r = await merge([a], { out: path.join(tmp, 'out'), name: 'all', now: NOW });
  assert.notStrictEqual(r.refused, true);
  assert.strictEqual(r.status, 'written', r.reason);
});

test('merge_archives does not refuse an old ZIP whose chat folder is named artifacts', async () => {
  const tmp = tmpRoot();
  const zip = new JSZip();
  zip.file('claude-takeout-z/index.md', '# all');
  zip.file('claude-takeout-z/artifacts/original.json', chatJson('y', '2026-10-02T00:00:00Z'));
  const zipPath = path.join(tmp, 'claude-takeout-z.zip');
  fs.writeFileSync(zipPath, await zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX' }));
  const r = await merge([zipPath], { out: path.join(tmp, 'out'), name: 'all', now: NOW });
  assert.notStrictEqual(r.refused, true);
  assert.strictEqual(r.status, 'written', r.reason);
});

// ---- The current version's ZIP (v1.19): copied with the version, never for an older one; the tools write no ZIP ----
const PKZIP = (tag) => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(tag)]);
// artifactsMega, with a ZIP beside the current version's folder.
function withZip(root, uuid, title, ver, bytes = PKZIP(`${title} ${ver}`)) {
  const dir = `artifacts/${title.replace(/ /g, '_')}_${uuidToBase58(uuid)}`;
  fs.writeFileSync(path.join(root, dir, `${ver}.zip`), bytes);
  const file = path.join(root, dir, 'artifact.json');
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  json.versions[ver].zip = `${ver}.zip`;
  fs.writeFileSync(file, JSON.stringify(json));
  return root;
}

test('the merged current version keeps its source\'s ZIP; an older version\'s ZIP is not copied', async () => {
  const tmp = tmpRoot();
  const older = withZip(artifactsMega(tmp, 'o', '2026-11-01T00:00:00Z', 'full', [[U, 'Guide', true, 'v1']]), U, 'Guide', 'v1');
  const newer = withZip(artifactsMega(tmp, 'n', '2026-11-05T00:00:00Z', 'full', [[U, 'Guide', true, 'v2']]), U, 'Guide', 'v2');
  const out = path.join(tmp, 'out');
  const r = await merge([older, newer], { out, name: 'm', now: NOW });
  assert.strictEqual(r.status, 'written', r.reason);
  assert.ok(r.ok, JSON.stringify(r.warnings));
  const dest = path.join(out, 'm');
  const dir = path.join(dest, 'artifacts', `Guide_${SID}`);
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['artifact.json', 'v1', 'v2', 'v2.zip']);
  assert.ok(fs.readFileSync(path.join(dir, 'v2.zip')).equals(PKZIP('Guide v2')));
  const json = artifactJson(dest, `Guide_${SID}`);
  assert.deepStrictEqual([json.current, json.versions.v2.zip, 'zip' in json.versions.v1], ['v2', 'v2.zip', false]);
  assert.strictEqual(viewerData(dest).artifacts[0].zip, `artifacts/Guide_${SID}/v2.zip`);
});

test('no ZIP when the merged current version\'s source has none, though another source has one for another version', async () => {
  const tmp = tmpRoot();
  const older = withZip(artifactsMega(tmp, 'o', '2026-11-01T00:00:00Z', 'full', [[U, 'Guide', true, 'v1']]), U, 'Guide', 'v1');
  const newer = artifactsMega(tmp, 'n', '2026-11-05T00:00:00Z', 'full', [[U, 'Guide', true, 'v2']]);
  const out = path.join(tmp, 'out');
  const r = await merge([older, newer], { out, name: 'm', now: NOW });
  assert.strictEqual(r.status, 'written', r.reason);
  const dest = path.join(out, 'm');
  assert.ok(!fs.readdirSync(path.join(dest, 'artifacts', `Guide_${SID}`)).some(n => n.endsWith('.zip')));
  const json = artifactJson(dest, `Guide_${SID}`);
  assert.ok(!('zip' in json.versions.v1) && !('zip' in json.versions.v2));
  assert.strictEqual(viewerData(dest).artifacts[0].zip, null);
});

test('a source ZIP that is not a ZIP is left out, with a report line', async () => {
  const tmp = tmpRoot();
  const only = withZip(artifactsMega(tmp, 'o', '2026-11-01T00:00:00Z', 'full', [[U, 'Guide', true, 'v1']]), U, 'Guide', 'v1', Buffer.from('<html>not a zip</html>'));
  const out = path.join(tmp, 'out');
  const r = await merge([only], { out, name: 'm', now: NOW });
  assert.strictEqual(r.status, 'written', r.reason);
  const dest = path.join(out, 'm');
  assert.ok(!fs.existsSync(path.join(dest, 'artifacts', `Guide_${SID}`, 'v1.zip')));
  assert.ok(!('zip' in artifactJson(dest, `Guide_${SID}`).versions.v1));
  assert.ok(r.warnings.some(w => w === `artifacts/Guide_${SID} v1: ZIP left out (not a ZIP)`), JSON.stringify(r.warnings));
});

test('artifactJsonV2FromDisk writes a version\'s zip as popup.js does', () => {
  const { sandbox } = loadPopup();
  const files = [{ path: 'index.html', savedAs: 'index.html', size: 3, contentType: 'text/html', sha256: sha('one'), verified: true }];
  const ver = (folder) => ({ folder, files, start: 'index.html', startSaved: 'index.html', incomplete: false, missing: [], saved: true, zip: 'v1.zip', publishedIn: [] });
  const meta = { url: `https://claude.ai/artifact/${SID}`, typeTitle: '', sourceSurface: 'chat', rel: 'mine', public: false, createdAt: '', updatedAt: '', note: '', start: 'index.html', needsRuntime: false };
  const popupRec = { uuid: U, shortId: SID, title: 'Guide', listed: true, current: 'v1', history: ['v1'], meta, versions: new Map([['v1', ver('v1')]]) };
  const diskRec = { uuid: U, shortId: SID, title: 'Guide', listed: true, current: 'v1', meta, order: ['v1'], versions: new Map([['v1', ver(`artifacts/Guide_${SID}/v1`)]]) };
  const fromPopup = vm.runInContext('artifactJsonV2', sandbox)(popupRec);
  assert.strictEqual(fromPopup.versions.v1.zip, 'v1.zip');
  assert.strictEqual(JSON.stringify(require('../tools/archive-lib.js').artifactJsonV2FromDisk(diskRec)), JSON.stringify(fromPopup));
});

// ---- Merge correctness (deep review 2026-11-22, batch B) ----

test('an earlier merge keeps the list it was made from: merged with an older full export, current and listed don\'t go back', async () => {
  const tmp = tmpRoot();
  const fnew = artifactsMega(tmp, 'fn', '2026-11-10T00:00:00Z', 'full', [[U, 'Guide', true, 'v2'], [OTHER, 'Other', true]]);
  const first = await merge([fnew], { out: path.join(tmp, 'm1'), name: 'm', now: new Date('2026-11-20T00:00:00Z') });
  assert.strictEqual(first.ok, true, first.reason);
  const M = path.join(tmp, 'm1', 'm');
  const manifest = JSON.parse(fs.readFileSync(path.join(M, 'export-manifest.json'), 'utf8'));
  assert.strictEqual(manifest.artifacts.decided_at, '2026-11-10T00:00:00Z', 'when claude.ai\'s full list was taken');
  assert.deepStrictEqual(manifest.artifacts.listed_at, { [U]: '2026-11-10T00:00:00Z', [OTHER]: '2026-11-10T00:00:00Z' });
  const fold = artifactsMega(tmp, 'fo', '2026-11-01T00:00:00Z', 'full', [[U, 'Guide', true, 'v1']]);
  const r = await merge([M, fold], { out: path.join(tmp, 'm2'), name: 'm', now: new Date('2026-11-21T00:00:00Z') });
  assert.strictEqual(r.ok, true, r.reason);
  const d = path.join(tmp, 'm2', 'm');
  const g = artifactJson(d, `Guide_${SID}`);
  assert.deepStrictEqual([g.current, g.listed], ['v2', true]);
  assert.strictEqual(artifactJson(d, `Other_${OID}`).listed, true);
  // An older Export Changes that listed v1 doesn't move it back either; a newer full export still decides.
  const ch = artifactsMega(tmp, 'ch', '2026-11-05T00:00:00Z', 'changes', [[U, 'Guide', true, 'v1']]);
  const r3 = await merge([M, ch], { out: path.join(tmp, 'm3'), name: 'm', now: new Date('2026-11-21T00:00:00Z') });
  assert.strictEqual(artifactJson(path.join(tmp, 'm3', 'm'), `Guide_${SID}`).current, 'v2', r3.reason);
  const fnewest = artifactsMega(tmp, 'fz', '2026-11-25T00:00:00Z', 'full', [[U, 'Guide', true, 'v3']]);
  await merge([M, fnewest], { out: path.join(tmp, 'm4'), name: 'm', now: new Date('2026-11-26T00:00:00Z') });
  const d4 = path.join(tmp, 'm4', 'm');
  assert.deepStrictEqual([artifactJson(d4, `Guide_${SID}`).current, artifactJson(d4, `Other_${OID}`).listed], ['v3', false]);
});

test('a complete older copy of a version wins over a newer copy that is missing files', async () => {
  const tmp = tmpRoot();
  const files2 = (both) => ({ folder: 'v1', files: [{ ...fileOf('one'), verified: true }, { path: 'app.js', savedAs: both ? 'app.js' : null, size: 2, contentType: 'text/javascript', sha256: sha('js'), verified: true }],
    start: 'index.html', startSaved: 'index.html', incomplete: !both, missing: both ? [] : ['app.js'], saved: true, publishedIn: [] });
  const mk = (name, at, both) => {
    const root = path.join(tmp, name);
    mega(root, at, { [`Chat_${name}`]: chatJson(name, at) });
    put(root, 'export-manifest.json', manifestOf(at));
    put(root, `artifacts/Guide_${SID}/artifact.json`, format2(U, 'Guide', { current: 'v1', versions: { v1: files2(both) } }));
    put(root, `artifacts/Guide_${SID}/v1/index.html`, 'one');
    if (both) put(root, `artifacts/Guide_${SID}/v1/app.js`, 'js');
    return root;
  };
  const r = await merge([mk('a', '2026-11-01T00:00:00Z', true), mk('b', '2026-11-05T00:00:00Z', false)], { out: path.join(tmp, 'o'), name: 'm', now: NOW });
  assert.strictEqual(r.ok, true, r.reason);
  const d = path.join(tmp, 'o', 'm');
  assert.deepStrictEqual(fs.readdirSync(path.join(d, 'artifacts', `Guide_${SID}`, 'v1')).sort(), ['app.js', 'index.html']);
  const v1 = artifactJson(d, `Guide_${SID}`).versions.v1;
  assert.deepStrictEqual([v1.incomplete, v1.missing], [false, []]);
});

test('notes follow the merged files, and the sources\' artifacts/errors.txt are carried over', async () => {
  const tmp = tmpRoot();
  const full = artifactsMega(tmp, 'f', '2026-11-01T00:00:00Z', 'full', [[U, 'Guide', true, 'v1']]);
  const c = path.join(tmp, 'c');
  mega(c, '2026-11-07T00:00:00Z', { Chat_c: chatJson('c', '2026-11-07T00:00:00Z') });
  put(c, 'export-manifest.json', manifestOf('2026-11-07T00:00:00Z', 'changes'));
  const j = JSON.parse(format2(U, 'Guide', { current: 'v1', versions: { v1: v2(null, 'Guide v1') } }));
  j.note = 'not exported: signed out of claude.ai (see errors.txt)';
  put(c, `artifacts/Guide_${SID}/artifact.json`, JSON.stringify(j));
  put(c, 'artifacts/errors.txt', '# Export Errors Report\n\nGuide: signed out\n');
  const r = await merge([full, c], { out: path.join(tmp, 'o'), name: 'm', now: NOW });
  assert.strictEqual(r.ok, true, r.reason);
  const d = path.join(tmp, 'o', 'm');
  const a = artifactJson(d, `Guide_${SID}`);
  assert.ok(a.versions.v1.folder, 'the full export\'s copy is there');
  assert.ok(!/not exported/.test(a.note), a.note);
  const view = viewerData(d).artifacts.find((v) => v.title === 'Guide');
  assert.strictEqual(view.notExported, false);
  const errors = fs.readFileSync(path.join(d, 'artifacts', 'errors.txt'), 'utf8');
  assert.match(errors, /Guide: signed out/);
  assert.ok(errors.includes(path.basename(c)), 'says which source it came from');
});

test('a source ZIP entry that could not be extracted fails the merge', async () => {
  const tmp = tmpRoot();
  const z = new JSZip();
  z.file('a/index.md', '#');
  z.file('a/C/original.json', chatJson('q', '2026-11-01T00:00:00Z'));
  z.file('a/C/A.md', '1');
  z.file('a/C/a.md', '2');
  const zp = path.join(tmp, 's.zip');
  fs.writeFileSync(zp, await z.generateAsync({ type: 'nodebuffer', platform: 'UNIX' }));
  const r = await merge([zp], { out: path.join(tmp, 'o'), name: 'm', now: NOW });
  assert.strictEqual(r.ok, false);
  assert.ok(r.warnings.some((w) => /not extracted/.test(w)), r.warnings.join('\n'));
});

test('the current version keeps a ZIP another source has for the same files', async () => {
  const tmp = tmpRoot();
  const older = withZip(artifactsMega(tmp, 'o', '2026-11-01T00:00:00Z', 'full', [[U, 'Guide', true, 'v1']]), U, 'Guide', 'v1');
  const newer = artifactsMega(tmp, 'n', '2026-11-05T00:00:00Z', 'full', [[U, 'Guide', true, 'v1']]);
  const r = await merge([older, newer], { out: path.join(tmp, 'o2'), name: 'm', now: NOW });
  assert.strictEqual(r.ok, true, r.reason);
  const d = path.join(tmp, 'o2', 'm');
  assert.ok(fs.existsSync(path.join(d, 'artifacts', `Guide_${SID}`, 'v1.zip')));
  assert.strictEqual(artifactJson(d, `Guide_${SID}`).versions.v1.zip, 'v1.zip');
  // Not when the other source's folder holds different files.
  const other = withZip(artifactsMega(tmp, 'x', '2026-11-01T00:00:00Z', 'full', [[U, 'Guide', true, 'v1']]), U, 'Guide', 'v1');
  fs.writeFileSync(path.join(other, 'artifacts', `Guide_${SID}`, 'v1', 'index.html'), 'different');
  const j = JSON.parse(fs.readFileSync(path.join(other, 'artifacts', `Guide_${SID}`, 'artifact.json'), 'utf8'));
  j.versions.v1.files[0].sha256 = sha('different');
  fs.writeFileSync(path.join(other, 'artifacts', `Guide_${SID}`, 'artifact.json'), JSON.stringify(j));
  await merge([other, newer], { out: path.join(tmp, 'o3'), name: 'm', now: NOW });
  assert.ok(!fs.existsSync(path.join(tmp, 'o3', 'm', 'artifacts', `Guide_${SID}`, 'v1.zip')));
});
