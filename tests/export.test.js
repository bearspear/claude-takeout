// Export logic: runs the real popup.js functions on a synthetic conversation.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { REPO, loadPopup, loadFixture, pythonArtifacts, use, result, oneMessage, twoMessages } = require('./helpers');

const { fn, sandbox } = loadPopup({
  fetch: async (url) => {
    if (/\/contents$|wiggle\/download-file/.test(url)) {
      return { ok: true, status: 200, blob: async () => ({ text: async () => 'live', size: 4, type: 'text/plain', arrayBuffer: async () => new ArrayBuffer(4) }) };
    }
    return { ok: false, status: 404 };
  },
});
const artifacts = (data, collector = null) => fn('extractArtifacts')(data, collector);
const collector = () => { const warnings = []; return { warnings, addWarning: (type, filename, message, details) => warnings.push({ type, filename, message, details }), addError() {} }; };

test('both implementations skip failed file tools', () => {
  const cases = [
    twoMessages([use('1', 'create_file', { path: '/h/a.py', file_text: 'one' })], [use('2', 'str_replace', { path: '/h/a.py', old_str: 'one', new_str: 'two' }), result('2', true)]),
    twoMessages([use('1', 'create_file', { path: '/h/a.py', file_text: 'one' })], [use('2', 'create_file', { path: '/h/a.py', file_text: 'rejected' }), result('2', true)]),
    twoMessages([use('1', 'Write', { file_path: '/h/a.py', content: 'one' })], [use('2', 'Edit', { file_path: '/h/a.py', old_string: 'one', new_string: 'y' }), result('2', true), use('3', 'Write', { file_path: '/h/a.py', content: 'z' }), result('3', true)]),
    twoMessages([use('1', 'create_file', { path: '/h/a.py', file_text: 'one' }), use('2', 'str_replace', { path: '/h/a.py', old_str: 'one', new_str: 'y' })], [result('2', true)]),
  ];
  for (const data of cases) {
    assert.strictEqual(artifacts(data)['a.py'], 'one');
    assert.strictEqual(pythonArtifacts(data)['a.py'], 'one');
  }
});

test('edits with no error result still apply', () => {
  const data = oneMessage([use('1', 'create_file', { path: '/h/a.py', file_text: 'x' }), use('2', 'str_replace', { path: '/h/a.py', old_str: 'x', new_str: 'y' }), result('1', false)]);
  assert.strictEqual(artifacts(data)['a.py'], 'y');
});

test('str_replace_failed only fires for edits that succeeded', () => {
  const failed = collector();
  artifacts(twoMessages([use('1', 'create_file', { path: '/h/a.py', file_text: 'x' })], [use('2', 'str_replace', { path: '/h/a.py', old_str: 'nope', new_str: 'y' }), result('2', true)]), failed);
  assert.strictEqual(failed.warnings.length, 0);
  const unreplayable = collector();
  artifacts(oneMessage([use('2', 'str_replace', { path: '/h/a.py', old_str: 'x', new_str: 'y' }), result('2', false)]), unreplayable);
  assert.strictEqual(unreplayable.warnings.length, 1);
});

test('heredocs match any delimiter in both implementations', () => {
  const cases = [
    ["cat > /h/a.html << 'HTMLEOF'\nbody\nHTMLEOF\necho hi", 'a.html', 'body'],
    ['cat > /h/b.py <<PY\nx\nPY', 'b.py', 'x'],
    ['cat > "/h/c.md" << "END"\ny\nEND', 'c.md', 'y'],
    ["cat > /h/d.sh <<-'EOF'\nz\nEOF", 'd.sh', 'z'],
    ["cat > /h/e.txt << 'EOF'\nEOFX\nsecond\nEOF", 'e.txt', 'EOFX\nsecond'],
  ];
  for (const [command, file, want] of cases) {
    const data = oneMessage([use('1', 'bash_tool', { command })]);
    assert.strictEqual(artifacts(data)[file], want, command);
    assert.strictEqual(pythonArtifacts(data)[file], want, command);
  }
});

test('fixture: rejected create_file is ignored and the heredoc wins', () => {
  const data = loadFixture();
  const warnings = collector();
  const output = artifacts(data, warnings);
  assert.strictEqual(output['report_v1.html'], '<p>first draft</p>');
  assert.strictEqual(output['report_v2.html'], '<p>second draft old</p>');
  assert.strictEqual(output['report.html'], '<p>second draft new</p>');
  assert.ok(!Object.values(output).some((text) => text.includes('REJECTED')));
  assert.strictEqual(warnings.warnings.filter((w) => w.type === 'str_replace_failed').length, 0);
});

test('fixture: failed edit leaves no phantom content or version', () => {
  const output = artifacts(loadFixture());
  assert.strictEqual(output['build.py'], 'value = 2\n');
  assert.ok(!('build_v2.py' in output));
});

test('fixture: Write, Edit and several Bash heredocs replay', () => {
  const output = artifacts(loadFixture());
  assert.strictEqual(output['notes_v1.py'], 'one one\n');
  assert.strictEqual(output['notes.py'], 'two two\n');
  assert.strictEqual(output['a.txt'], 'alpha');
  assert.strictEqual(output['b.txt'], 'beta');
});

test('fixture: inactive branches are not exported', () => {
  assert.ok(!('abandoned.py' in artifacts(loadFixture())));
});

test('Edit without replace_all rejects an ambiguous match', () => {
  const data = oneMessage([use('1', 'Write', { file_path: '/t/x.py', content: 'one one' }), use('2', 'Edit', { file_path: '/t/x.py', old_string: 'one', new_string: 'two' })]);
  assert.strictEqual(artifacts(data)['x.py'], 'one one');
});

test('Bash mutations warn and say the CLI does not cover them', () => {
  const warnings = collector();
  const data = oneMessage([use('1', 'Bash', { command: "cat > /t/y.md << 'EOF'\nhi\nEOF" }), use('2', 'Bash', { command: "sed -i 's/a/b/' /t/y.md" })]);
  fn('detectOpaqueMutations')(data, warnings);
  assert.strictEqual(warnings.warnings.length, 1);
  assert.match(warnings.warnings[0].details.note, /does not replay the Bash tool/);
});

test('a mutation beside a heredoc is still detected', () => {
  const warnings = collector();
  const data = oneMessage([use('1', 'bash_tool', { command: "cat > /t/y.md << 'XX'\nhi\nXX\nsed -i 's/a/b/' /t/y.md" })]);
  fn('detectOpaqueMutations')(data, warnings);
  assert.strictEqual(warnings.warnings.length, 1);
});

test('isTextFile keeps binaries as bytes', () => {
  const isText = fn('isTextFile');
  for (const f of ['a.pdf', 'a.odt', 'a.docx', 'a.zip', 'a.png', 'a.pptx', 'a.xlsx', 'noext']) assert.strictEqual(isText(f), false, f);
  for (const f of ['a.md', 'a.html', 'a.PY', 'a.csv', 'a.json']) assert.strictEqual(isText(f), true, f);
});

test('addArtefactBlob stores binaries untouched and decodes text', async () => {
  const add = fn('addArtefactBlob');
  const written = {};
  const folder = { file: (p, c) => { written[p] = c; } };
  const map = {};
  const binary = { text: async () => { throw new Error('binary must not be decoded'); } };
  await add(folder, map, 'x.odt', binary);
  assert.strictEqual(written['artefacts/x.odt'], binary);
  assert.strictEqual(map['x.odt'], '');
  await add(folder, map, 'x.html', { text: async () => 'hi' });
  assert.strictEqual(written['artefacts/x.html'], 'hi');
});

test('fixture: deliveries are versioned by path and avoid artifact names', () => {
  const data = loadFixture();
  const files = Array.from(fn('extractDeliveredFiles')(data, Object.keys(artifacts(data))));
  const byName = Object.fromEntries(files.map((f) => [f.filename, f.uuid]));
  assert.deepStrictEqual(files.map((f) => f.filename).sort(), ['Minutes.odt', 'Minutes_v1.odt', 'Minutes_v2.odt', 'report_delivered.html'].sort());
  assert.strictEqual(byName['Minutes.odt'], byName['Minutes_v2.odt']);
});

test('the /contents endpoint is tried first among UUID URLs', async () => {
  const urls = [];
  const popup = loadPopup({ fetch: async (url) => { urls.push(url); return /\/contents$/.test(url) ? { ok: true, status: 200, blob: async () => ({}) } : { ok: false, status: 404 }; } });
  await popup.fn('fetchUploadedFile')(null, 'UU', 'OO', 'CC', null);
  assert.deepStrictEqual(urls, ['https://claude.ai/api/organizations/OO/files/UU/contents']);
});

test('Read recovers full reads only', () => {
  const read = (input) => ({ chat_messages: [{ uuid: 'a', content: [use('t', 'Read', input), { type: 'tool_result', tool_use_id: 't', name: 'Read', content: [{ type: 'text', text: '1\thello\n2\tworld' }] }] }] });
  const extract = fn('extractBlobContent');
  assert.strictEqual(extract(read({ file_path: '/m/f.md' }), '/mnt/uploads/f.md').content, 'hello\nworld');
  assert.strictEqual(extract(read({ file_path: '/m/f.md', offset: 5 }), '/mnt/uploads/f.md'), null);
});

test('fixture: compaction summary and Write render in Markdown', () => {
  const markdown = fn('convertToMarkdown')(loadFixture(), { embedArtifacts: true });
  assert.match(markdown, /\*\*Context compaction summary\*\*/);
  assert.match(markdown, /Earlier context summary\./);
  assert.match(markdown, /Artifact: notes\.py/);
});

test('fixture: attachment names become NFC', () => {
  const names = Object.keys(fn('extractTextAttachments')(loadFixture()).attachments);
  assert.ok(names[0].includes('Gödel'), names[0]);
});

test('collector clears one warning type for one file', () => {
  const Collector = fn('ExportErrorCollector');
  const c = new Collector('n', 'u');
  c.addWarning('str_replace_failed', 'a.html', 'm');
  c.addWarning('str_replace_failed', 'b.html', 'm');
  c.addWarning('artifact_opaque_mutation', 'a.html', 'm');
  c.clearWarnings('str_replace_failed', 'a.html');
  assert.deepStrictEqual(Array.from(c.warnings).map((w) => `${w.type}:${w.filename}`), ['str_replace_failed:b.html', 'artifact_opaque_mutation:a.html']);
});

test('a downloaded presented file clears its replay warnings', async () => {
  const target = '/mnt/user-data/outputs/table.html';
  const data = oneMessage([
    use('1', 'bash_tool', { command: `cp /tmp/x ${target}` }),
    use('2', 'str_replace', { path: target, old_str: 'a', new_str: 'b' }), result('2', false),
    { type: 'tool_result', name: 'present_files', content: [{ type: 'local_resource', file_path: target, uuid: '' }] },
  ]);
  data.uuid = 'c1';
  sandbox.__data = data;
  const output = await vm.runInContext("populateConversationFolder(({ file() {} }), __data, null, 'org')", sandbox);
  assert.strictEqual(Array.from(output.errorCollector.warnings).filter((w) => w.type === 'str_replace_failed').length, 0);
});

test('project files are saved as raw bytes, and a shortfall warns', async () => {
  const bytes = { marker: 'raw-blob' };
  const respond = (url) => {
    if (/\/projects\/P$/.test(url)) return { ok: true, status: 200, json: async () => ({ name: 'P', docs_count: 0, files_count: 3 }) };
    if (/\/projects\/P\/docs$/.test(url)) return { ok: true, status: 200, json: async () => [] };
    if (/\/projects\/P\/files$/.test(url)) return { ok: true, status: 200, json: async () => [{ file_uuid: 'f1', file_name: 'Paper.pdf' }, { file_uuid: 'f2', file_name: 'paper.PDF' }] };
    if (/\/files\/f1\/contents$/.test(url)) return { ok: true, status: 200, blob: async () => bytes };
    return { ok: false, status: 404 };
  };
  const popup = loadPopup({ fetch: async (url) => respond(url) });
  const written = {};
  popup.sandbox.__folder = { file: (name, content) => { written[name] = content; } };
  popup.sandbox.__data = Object.assign(oneMessage([{ type: 'text', text: 'hi' }]), { uuid: 'c1', name: 'n', project_uuid: 'P' });
  const output = await vm.runInContext("populateConversationFolder(__folder, __data, null, 'org')", popup.sandbox);
  assert.strictEqual(written['project/files/Paper.pdf'], bytes);
  assert.ok('project/files.json' in written);
  const errors = Array.from(output.errorCollector.errors).map((e) => e.filename);
  assert.deepStrictEqual(errors, ['paper_2.PDF']);
  assert.ok(Array.from(output.errorCollector.warnings).some((w) => /reports 3 item/.test(w.error)));
  assert.match(written['meta.md'], /\*\*Project Files\*\* \| 1/);
  assert.match(written['README.md'], /project\/files\/Paper\.pdf/);
});

test('fixture: JS and Python artifacts match', () => {
  const data = loadFixture();
  const python = pythonArtifacts(data);
  const javascript = artifacts(data);
  assert.deepStrictEqual(Object.keys(javascript).sort(), Object.keys(python).sort());
  for (const name of Object.keys(python)) assert.strictEqual(javascript[name], python[name], name);
});

// Optional: point TAKEOUT_EXPORT_DIR at an unzipped mega-ZIP for a wider check.
// Real exports are private, so they never belong in this repo.
const exportDir = process.env.TAKEOUT_EXPORT_DIR;
test('real exports: JS and Python artifacts match', { skip: exportDir ? false : 'set TAKEOUT_EXPORT_DIR to run' }, () => {
  for (const name of fs.readdirSync(exportDir)) {
    const file = path.join(exportDir, name, 'original.json');
    if (!fs.existsSync(file)) continue;
    const data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    const python = pythonArtifacts(data);
    const javascript = artifacts(data);
    assert.deepStrictEqual(Object.keys(javascript).sort(), Object.keys(python).sort(), name);
    for (const f of Object.keys(python)) assert.strictEqual(javascript[f], python[f], `${name}/${f}`);
  }
});

test('the manifest version is not behind the newest changelog entry', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'manifest.json'), 'utf8'));
  const readme = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8');
  const parts = (v) => v.split('.').map(Number);
  const compare = (a, b) => { for (let i = 0; i < 3; i++) { const d = (parts(a)[i] || 0) - (parts(b)[i] || 0); if (d) return d; } return 0; };
  const newest = readme.match(/^### v(\d+\.\d+(?:\.\d+)?)$/m)[1];
  assert.ok(compare(manifest.version, newest) >= 0, `manifest ${manifest.version}, changelog ${newest}`);
});

test('nothing in the repo uses a name Chrome reserves', () => {
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      assert.ok(!entry.name.startsWith('_'), `Chrome refuses to load the extension with ${path.join(dir, entry.name)}`);
      if (entry.isDirectory()) walk(path.join(dir, entry.name));
    }
  };
  walk(REPO);
});
