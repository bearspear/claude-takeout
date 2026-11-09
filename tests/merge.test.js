// tools/merge_archives.js: combining a full archive with later change archives. Synthetic fixtures only.
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const JSZip = require('../jszip.min.js');
const { merge, pickNewest } = require('../tools/merge_archives.js');

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
function mega(root, exportedAt, chats, projects = {}) {
  put(root, 'index.md', '# Claude Takeout - All Conversations');
  put(root, 'export-manifest.json', JSON.stringify({ format: 1, exported_at: exportedAt, kind: 'full', chats: [] }));
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
