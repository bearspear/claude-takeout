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
const artifacts = (data, collector = null, index = null) => fn('extractArtifacts')(data, collector, index);
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

test('Bash mutations warn and point at the CLI', () => {
  const warnings = collector();
  const data = oneMessage([use('1', 'Bash', { command: "cat > /t/y.md << 'EOF'\nhi\nEOF" }), use('2', 'Bash', { command: "sed -i 's/a/b/' /t/y.md" })]);
  fn('detectOpaqueMutations')(data, warnings);
  assert.strictEqual(warnings.warnings.length, 1);
  assert.match(warnings.warnings[0].details.note, /replay_bash\.py/);
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

test('mega-ZIP stores project files once and every chat links to them', async () => {
  const downloads = [];
  const respond = (url) => {
    if (/\/projects\/P$/.test(url)) return { ok: true, status: 200, json: async () => ({ name: 'My Project', files_count: 2 }) };
    if (/\/projects\/P\/docs$/.test(url)) return { ok: true, status: 200, json: async () => [] };
    if (/\/projects\/P\/files$/.test(url)) return { ok: true, status: 200, json: async () => [{ file_uuid: 'f1', file_name: 'Paper.pdf' }, { file_uuid: 'f2', file_name: 'Lost.pdf' }] };
    if (/\/files\/f1\/contents$/.test(url)) { downloads.push(url); return { ok: true, status: 200, blob: async () => ({ marker: 1 }) }; }
    return { ok: false, status: 404 };
  };
  const popup = loadPopup({ fetch: async (url) => respond(url) });
  const root = {};
  const folderFor = (written) => ({ file: (name, content) => { written[name] = content; } });
  popup.sandbox.__shared = { root: folderFor(root), byUuid: new Map(), usedDirs: new Set() };
  const chats = [{}, {}];
  const results = [];
  for (const [i, written] of chats.entries()) {
    popup.sandbox.__folder = folderFor(written);
    popup.sandbox.__data = Object.assign(oneMessage([{ type: 'text', text: 'hi' }]), { uuid: `c${i}`, name: 'n', project_uuid: 'P' });
    results.push(await vm.runInContext("populateConversationFolder(__folder, __data, null, 'org', __shared)", popup.sandbox));
  }
  assert.strictEqual(downloads.length, 1);
  assert.ok('projects/My_Project/files/Paper.pdf' in root);
  assert.ok('projects/My_Project/files.json' in root);
  for (const [i, written] of chats.entries()) {
    assert.ok(!Object.keys(written).some((name) => name.startsWith('project/files')), 'no per-chat copy');
    assert.match(written['README.md'], /\.\.\/projects\/My_Project\/files\/Paper\.pdf/);
    assert.match(written['meta.md'], /\*\*Project Files\*\* \| 1/);
    assert.deepStrictEqual(Array.from(results[i].errorCollector.errors).map((e) => e.filename), ['Lost.pdf'], 'each chat reports the failure');
    assert.ok(!Array.from(results[i].errorCollector.warnings).some((w) => /reports 2 item/.test(w.error)));
  }
});

// ---- viewer.html ----
// fetch answers: uuid in failing -> 404; project endpoints from project; any other file a text blob.
const textBlob = (text, type = 'text/plain') => ({
  marker: text, size: text.length, type, text: async () => text, arrayBuffer: async () => new ArrayBuffer(0),
});
const projectResponses = (name = 'My Project') => [
  [/\/projects\/P$/, () => ({ ok: true, status: 200, json: async () => ({ name, docs_count: 1, files_count: 1 }) })],
  [/\/projects\/P\/docs$/, () => ({ ok: true, status: 200, json: async () => [{ uuid: 'd1', file_name: 'Brief.md', content: 'be kind' }] })],
  [/\/projects\/P\/files$/, () => ({ ok: true, status: 200, json: async () => [{ file_uuid: 'pf1', file_name: 'Paper.pdf' }] })],
];
const zipStub = () => {
  const written = {};
  return { written, file: (name, content, options) => { written[name] = options ? { content, options } : content; } };
};
function exportPopup({ failing = [], routes = [], texts = {} } = {}) {
  return loadPopup({
    fetch: async (url) => {
      for (const [re, answer] of routes) if (re.test(url)) return answer(url);
      if (failing.some((id) => url.includes(id))) return { ok: false, status: 404 };
      const hit = /\/files\/([^/]+)\/contents?$/.exec(url);
      if (hit) return { ok: true, status: 200, blob: async () => (texts[hit[1]] !== undefined ? texts[hit[1]] : textBlob(`file ${hit[1]}`)) };
      return { ok: false, status: 404 };
    },
  });
}
async function runFolder(popup, data, { folderName = '', shared = null, target = zipStub() } = {}) {
  popup.sandbox.__folder = target;
  popup.sandbox.__data = data;
  popup.sandbox.__shared = shared;
  popup.sandbox.__name = folderName;
  const output = await vm.runInContext("populateConversationFolder(__folder, __data, null, 'org', __shared, __name)", popup.sandbox);
  return { written: target.written, output, chat: output.viewerChat };
}
const withUploads = () => {
  const data = loadFixture();
  const first = data.chat_messages.find((m) => m.sender === 'human');
  first.files = [];
  first.files_v2 = [
    { success: true, file_name: 'notes.txt', file_uuid: 'up-text', file_kind: 'blob' },
    { success: true, file_name: 'photo.png', file_uuid: 'up-png', file_kind: 'image' },
    { success: true, file_name: 'gone.pdf', file_uuid: 'up-gone', file_kind: 'document' },
    { success: true, file_name: 'legacy.txt', file_kind: 'blob' },
  ];
  return data;
};
const uploadsOf = (chat) => Object.fromEntries(chat.messages.flatMap((m) => m.uploads).map((u) => [u.name, u]));

test('viewerChat has the right cards, and the folder prefixes every link', async () => {
  const data = withUploads();
  const { chat } = await runFolder(exportPopup(), data, { folderName: 'My Chat' });
  assert.strictEqual(chat.id, data.uuid);
  assert.strictEqual(chat.model, vm.runInContext('getModelName', loadPopup().sandbox)(data));
  const report = Object.values(chat.files).find((f) => f.name === 'report.html');
  assert.deepStrictEqual(Array.from(report.versions, (v) => v.href), ['My%20Chat/artefacts/report_v1.html', 'My%20Chat/artefacts/report_v2.html', 'My%20Chat/artefacts/report_v3.html']);
  assert.strictEqual(report.versions[0].text, '<p>first draft</p>');
  assert.strictEqual(uploadsOf(chat)['photo.png'].href, 'My%20Chat/uploads/p01_photo.png');
  assert.strictEqual(uploadsOf(chat)['notes.txt'].href, 'My%20Chat/uploads/p01_notes.txt');
  const plain = await runFolder(exportPopup(), withUploads());
  assert.strictEqual(uploadsOf(plain.chat)['photo.png'].href, 'uploads/p01_photo.png');
});

test('an upload without a UUID is found by its name', async () => {
  const { chat } = await runFolder(exportPopup({ routes: [[/download-file/, () => ({ ok: true, status: 200, blob: async () => textBlob('old') })]] }), (() => {
    const data = withUploads();
    data.chat_messages.find((m) => m.sender === 'human').files_v2[3].path = '/mnt/user-data/uploads/legacy.txt';
    return data;
  })());
  assert.strictEqual(uploadsOf(chat)['legacy.txt'].href, 'uploads/p01_legacy.txt');
  assert.strictEqual(uploadsOf(chat)['legacy.txt'].text, 'old');
});

test('a failed upload has no link, and failing changes nothing else', async () => {
  const { chat, written } = await runFolder(exportPopup({ failing: ['up-gone'] }), withUploads());
  assert.strictEqual(uploadsOf(chat)['gone.pdf'].href, null);
  assert.ok(!('uploads/p01_gone.pdf' in written));
  assert.strictEqual(uploadsOf(chat)['photo.png'].text, null, 'a binary embeds no text');
});

test('upload text: only short text files, cleaned of mojibake, and a read failure is harmless', async () => {
  const data = withUploads();
  const huge = { marker: 'huge', size: 3 * 1024 * 1024, type: 'text/plain', text: async () => { throw new Error('should not be read'); }, arrayBuffer: async () => new ArrayBuffer(0) };
  const unreadable = { marker: 'bad', size: 4, type: 'text/plain', text: async () => { throw new Error('nope'); }, arrayBuffer: async () => new ArrayBuffer(0) };
  data.chat_messages.find((m) => m.sender === 'human').files_v2.push({ success: true, file_name: 'huge.txt', file_uuid: 'up-huge' }, { success: true, file_name: 'bad.txt', file_uuid: 'up-bad' });
  const { chat, written, output } = await runFolder(exportPopup({ texts: { 'up-text': textBlob('Caf\u00c3\u00a9'), 'up-huge': huge, 'up-bad': unreadable } }), data);
  assert.strictEqual(uploadsOf(chat)['notes.txt'].text, 'Caf\u00e9');
  assert.strictEqual(uploadsOf(chat)['huge.txt'].text, null);
  assert.strictEqual(uploadsOf(chat)['huge.txt'].href, 'uploads/p01_huge.txt');
  assert.strictEqual(uploadsOf(chat)['bad.txt'].text, null);
  assert.strictEqual(written['uploads/p01_bad.txt'], unreadable);
  assert.strictEqual(output.errorCollector.errors.filter((e) => /bad\.txt/.test(e.filename)).length, 0);
});

test('an upload recovered from JSON links to the name it was saved under', async () => {
  const data = oneMessage([]);
  Object.assign(data, { uuid: 'c1', name: 'n' });
  data.chat_messages = [
    { uuid: 'h', parent_message_uuid: null, sender: 'human', content: [{ type: 'text', text: 'hi' }], files: [], files_v2: [{ success: true, file_name: 'Odd Name.txt', file_uuid: 'up-json', file_kind: 'blob', path: '/mnt/user-data/uploads/Odd_Name.txt' }] },
    { uuid: 'a', parent_message_uuid: 'h', sender: 'assistant', content: [
      use('r', 'view', { path: '/mnt/user-data/uploads/Odd_Name.txt' }),
      { type: 'tool_result', tool_use_id: 'r', name: 'view', content: [{ type: 'text', text: "Here's the content of /mnt/user-data/uploads/Odd_Name.txt with line numbers:\n     1\tCaf\u00c3\u00a9" }] }] },
  ];
  data.current_leaf_message_uuid = 'a';
  const { chat, output, written } = await runFolder(exportPopup({ failing: ['up-json'] }), data);
  const saved = Array.from(output.uploadedFiles).find((f) => f.fromJson);
  assert.ok(saved, 'the fallback ran');
  assert.ok(`uploads/${saved.name}` in written);
  const up = uploadsOf(chat)['Odd Name.txt'];
  assert.strictEqual(up.href, `uploads/${encodeURIComponent(saved.name)}`);
  assert.strictEqual(up.text, 'Caf\u00e9');
});

test('a path delivered twice keeps each version\'s own file', async () => {
  const data = loadFixture();
  const { chat, written } = await runFolder(exportPopup(), data, { folderName: 'F' });
  const minutes = Object.values(chat.files).find((f) => /^Minutes/.test(f.name));
  assert.strictEqual(minutes.name, 'Minutes.odt');
  assert.deepStrictEqual(Array.from(minutes.versions, (v) => v.href), ['F/artefacts/Minutes_v1.odt', 'F/artefacts/Minutes_v2.odt']);
  assert.ok(minutes.versions.every((v) => `artefacts/${decodeURIComponent(v.href).slice(2 + 'artefacts/'.length)}` in written));
});

test('a delivery that failed to download is a missing card', async () => {
  const data = loadFixture();
  const uuids = data.chat_messages.flatMap((m) => m.content).flatMap((b) => b.file_deliveries || []).map((d) => d.file_uuid);
  const { chat } = await runFolder(exportPopup({ failing: uuids }), data);
  const minutes = Object.values(chat.files).filter((f) => /^Minutes/.test(f.name));
  assert.deepStrictEqual(minutes.map((f) => f.kind), ['missing']);
});

test('project: files and documents, with shared files linked in a mega-ZIP', async () => {
  const data = () => Object.assign(oneMessage([{ type: 'text', text: 'hi' }]), { uuid: 'c1', name: 'n', project_uuid: 'P' });
  const routes = projectResponses();
  const one = await runFolder(exportPopup({ routes }), data());
  assert.strictEqual(one.chat.project.name, 'My Project');
  assert.deepStrictEqual(Array.from(one.chat.project.files, (f) => f.href), ['project/files/Paper.pdf']);
  assert.deepStrictEqual(Array.from(one.chat.project.docs, (d) => [d.name, d.text]), [['Brief.md', 'be kind']]);
  assert.ok('project/Brief.md' in one.written);
  const shared = { root: zipStub(), byUuid: new Map(), usedDirs: new Set() };
  const popup = exportPopup({ routes });
  const first = await runFolder(popup, data(), { folderName: 'chat_a', shared });
  const second = await runFolder(popup, data(), { folderName: 'chat_b', shared });
  assert.deepStrictEqual(Array.from(first.chat.project.files, (f) => f.href), ['projects/My_Project/files/Paper.pdf']);
  assert.deepStrictEqual(Array.from(second.chat.project.files, (f) => f.href), ['projects/My_Project/files/Paper.pdf']);
});

test('project: documents recovered from the chat use their _truncated names, and a chat without a project has none', async () => {
  const data = Object.assign(oneMessage([
    use('r', 'view', { path: '/mnt/project/Guide.md' }),
    { type: 'tool_result', tool_use_id: 'r', name: 'view', content: [{ type: 'text', text: "Here's the content of /mnt/project/Guide.md with line numbers:\n     1\tpartial guide" }] },
  ]), { uuid: 'c1', name: 'n', project_uuid: 'P' });
  const { chat, written } = await runFolder(exportPopup(), data);
  assert.deepStrictEqual(Array.from(chat.project.docs, (d) => d.name), ['Guide_truncated.md']);
  assert.ok('project/Guide_truncated.md' in written);
  assert.strictEqual(chat.project.docs[0].text, 'partial guide');
  const none = await runFolder(exportPopup(), Object.assign(oneMessage([{ type: 'text', text: 'hi' }]), { uuid: 'c2', name: 'n' }));
  assert.strictEqual(none.chat.project, null);
});

test('project: a document over the embed limit is cut in the viewer and whole on disk', async () => {
  const long = 'x'.repeat(3 * 1024 * 1024);
  const routes = [...projectResponses().filter(([re]) => !/docs/.test(re.source)),
    [/\/projects\/P\/docs$/, () => ({ ok: true, status: 200, json: async () => [{ uuid: 'd1', file_name: 'Long.md', content: long }] })]];
  const { chat, written } = await runFolder(exportPopup({ routes }), Object.assign(oneMessage([{ type: 'text', text: 'hi' }]), { uuid: 'c1', name: 'n', project_uuid: 'P' }));
  assert.ok(written['project/Long.md'].includes(long));
  assert.ok(chat.project.docs[0].text.length < long.length);
  assert.match(chat.project.docs[0].text, /truncated.*project\/Long\.md/);
});

const everyFile = (written) => {
  const stable = {};
  for (const [name, content] of Object.entries(written).sort()) {
    stable[name] = typeof content === 'string' ? content.replace(/^.*Export(ed| Date).*$/gm, '') : JSON.stringify(content);
  }
  return stable;
};

for (const [label, breakIt] of [
  ['buildViewerChat throws', "CTViewer.buildViewerChat = () => { throw new Error('boom'); }"],
  ['the whole CTViewer script is missing', 'delete globalThis.CTViewer'],
]) {
  test(`when ${label}, the export is whole and errors.txt says so`, async () => {
    const popup = exportPopup({ failing: ['up-gone'] });
    vm.runInContext(breakIt, popup.sandbox);
    const broken = await runFolder(popup, withUploads());
    const good = await runFolder(exportPopup({ failing: ['up-gone'] }), withUploads());
    assert.strictEqual(broken.chat, null);
    assert.ok(good.chat);
    const a = everyFile(broken.written);
    const b = everyFile(good.written);
    assert.match(a['errors.txt'], /viewer/);
    assert.match(a['errors.txt'], /The chat data is all in this export\. Only viewer\.html is missing or incomplete; the Markdown files are unaffected\./);
    delete a['errors.txt'];
    delete b['errors.txt'];
    assert.deepStrictEqual(Object.keys(a), Object.keys(b));
    for (const name of Object.keys(a)) assert.strictEqual(a[name], b[name], name);
  });
}

test('a working viewer build adds no warning and no file to the folder', async () => {
  const { written, output } = await runFolder(exportPopup(), withUploads());
  assert.ok(!Array.from(output.errorCollector.warnings).some((w) => w.type === 'viewer'));
  assert.ok(!('viewer.html' in written) && !('viewer-check.gif' in written));
});

const assetRoutes = () => [[/^chrome-extension:\/\/test\/(.*)$/, (url) => ({ ok: true, status: 200, text: async () => fs.readFileSync(path.join(REPO, url.replace('chrome-extension://test/', '')), 'utf8') })]];

test('writeViewer writes viewer.html and the check image at the root', async () => {
  const popup = exportPopup({ routes: assetRoutes() });
  const { chat } = await runFolder(popup, withUploads());
  const zip = zipStub();
  popup.sandbox.__zip = zip;
  popup.sandbox.__chats = [chat];
  assert.strictEqual(await vm.runInContext('writeViewer(__zip, __chats)', popup.sandbox), true);
  assert.deepStrictEqual(Object.keys(zip.written).sort(), ['viewer-check.gif', 'viewer.html']);
  assert.ok(zip.written['viewer.html'].includes('"title":' + JSON.stringify(chat.title)));
  assert.ok(zip.written['viewer.html'].startsWith('<!doctype html') || /^<!DOCTYPE html/i.test(zip.written['viewer.html']));
  assert.ok(!/\/\*(KATEX_CSS|DATA_JSON|MARKED_JS|KATEX_JS|LOGIC_JS|APP_JS)\*\//.test(zip.written['viewer.html'].replace(/<script id="data"[\s\S]*?<\/script>/, '')));
  const gif = zip.written['viewer-check.gif'];
  assert.strictEqual(gif.options.base64, true);
  assert.strictEqual(gif.content, popup.sandbox.CTViewer.VIEWER_CHECK_BASE64);
});

test('writeViewer asks for each asset once, however many chats there are', async () => {
  const asked = [];
  const routes = assetRoutes();
  const popup = exportPopup({ routes: [[routes[0][0], (url) => { asked.push(url); return routes[0][1](url); }]] });
  const { chat } = await runFolder(popup, withUploads());
  popup.sandbox.__zip = zipStub();
  popup.sandbox.__chats = [chat, { ...chat, id: 'other' }, { ...chat, id: 'third' }];
  await vm.runInContext('writeViewer(__zip, __chats)', popup.sandbox);
  assert.strictEqual(asked.length, popup.sandbox.CTViewer.VIEWER_ASSETS.length);
});

for (const [label, routes] of [
  ['a rejecting asset fetch', [[/^chrome-extension:/, () => { throw new Error('no asset'); }]]],
  ['a missing asset', [[/^chrome-extension:/, () => ({ ok: false, status: 404, text: async () => '' })]]],
]) {
  test(`writeViewer with ${label} returns false and writes nothing`, async () => {
    const popup = exportPopup({ routes });
    popup.sandbox.__zip = zipStub();
    popup.sandbox.__chats = [{ id: 'c', updated: '' }];
    assert.strictEqual(await vm.runInContext('writeViewer(__zip, __chats)', popup.sandbox), false);
    assert.deepStrictEqual(Object.keys(popup.sandbox.__zip.written), []);
  });
}

test('writeViewer with no chats, or no CTViewer, returns false and writes nothing', async () => {
  const popup = exportPopup({ routes: assetRoutes() });
  popup.sandbox.__zip = zipStub();
  popup.sandbox.__chats = [];
  assert.strictEqual(await vm.runInContext('writeViewer(__zip, __chats)', popup.sandbox), false);
  popup.sandbox.__chats = [{ id: 'c' }];
  vm.runInContext('delete globalThis.CTViewer', popup.sandbox);
  assert.strictEqual(await vm.runInContext('writeViewer(__zip, __chats)', popup.sandbox), false);
  assert.deepStrictEqual(Object.keys(popup.sandbox.__zip.written), []);
});

test('the viewer warning has its recovery hint', () => {
  const Collector = fn('ExportErrorCollector');
  const c = new Collector('n', 'u');
  c.addWarning('viewer', 'viewer.html', 'failed');
  assert.strictEqual(c.warnings[0].recovery, 'The chat data is all in this export. Only viewer.html is missing or incomplete; the Markdown files are unaffected.');
});

test('both pages load takeout-viewer.js right before popup.js, and every viewer asset exists', () => {
  for (const page of ['popup.html', 'sidepanel.html']) {
    const scripts = [...fs.readFileSync(path.join(REPO, page), 'utf8').matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
    assert.strictEqual(scripts[scripts.indexOf('popup.js') - 1], 'takeout-viewer.js', page);
  }
  for (const asset of sandbox.CTViewer.VIEWER_ASSETS) assert.ok(fs.existsSync(path.join(REPO, asset)), asset);
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

test('artifact index records the file, its version names and the messages that made them', () => {
  const data = loadFixture();
  const raw = {};
  assert.deepStrictEqual(Object.keys(artifacts(data, null, raw)), Object.keys(artifacts(data)));
  const index = JSON.parse(JSON.stringify(raw)); // out of the VM realm for deepStrictEqual
  const notes = index['/tmp/work/notes.py'];
  assert.deepStrictEqual(notes.messages, ['m06', 'm08']);
  assert.deepStrictEqual(notes.versions, ['notes_v1.py', 'notes_v2.py']);
  assert.strictEqual(notes.filename, 'notes.py');
  assert.strictEqual(notes.path, '/tmp/work/notes.py');
  assert.deepStrictEqual(index['/mnt/user-data/outputs/report.html'].messages, ['m02', 'm04', 'm06']);
  assert.deepStrictEqual(index['/home/claude/build.py'].versions, ['build.py']);
  assert.ok(!('/home/claude/abandoned.py' in index));
});
