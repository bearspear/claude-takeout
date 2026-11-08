// Export logic: runs the real popup.js functions on a synthetic conversation.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const path = require('path');
const vm = require('vm');
const { DOC_URL, docTools, REPO, loadPopup, loadFixture, pythonArtifacts, use, result, oneMessage, twoMessages, textBlob, projectResponses, zipStub, exportPopup, runFolder, withUploads } = require('./helpers');

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
// textBlob, projectResponses, zipStub, exportPopup, runFolder and withUploads live in helpers.js
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

test('viewer previews show the inlined artifact on disk, and the Markdown keeps the sandbox path', async () => {
  const upload = '/mnt/user-data/uploads/x.png';
  const page = (n) => `<p>${n}</p><img src="${upload}">`;
  const data = Object.assign(twoMessages(
    [use('1', 'create_file', { path: '/h/one.html', file_text: page('one') }), use('2', 'create_file', { path: '/h/both.html', file_text: page('first') })],
    [use('3', 'create_file', { path: '/h/both.html', file_text: page('second') })],
  ), { uuid: 'c1', name: 'n' });
  data.chat_messages.unshift({ uuid: 'h', parent_message_uuid: null, sender: 'human', content: [{ type: 'text', text: 'hi' }], files: [], files_v2: [{ success: true, file_name: 'x.png', file_uuid: 'up-x', file_kind: 'image', path: upload }] });
  data.chat_messages[1].parent_message_uuid = 'h';
  const popup = exportPopup({ texts: { 'up-x': { ...textBlob('png', 'image/png'), arrayBuffer: async () => new ArrayBuffer(3) } } });
  const { chat, written, output } = await runFolder(popup, data);
  const files = Object.values(chat.files);
  const preview = (name) => files.find((f) => f.name === name);
  const onDisk = (name) => String(written[`artefacts/${name}`]).replace(/^﻿/, '');
  assert.ok(onDisk('one.html').includes('data:image/png;base64,AAAA'), 'the disk copy is inlined');
  assert.strictEqual(preview('one.html').versions[0].text, onDisk('one.html'));
  assert.deepStrictEqual(Array.from(preview('both.html').versions, (v) => v.text), [onDisk('both_v1.html'), onDisk('both_v2.html')]);
  assert.ok(onDisk('both_v2.html').includes('data:image/png;base64,AAAA'));
  assert.ok(output.artifacts['one.html'].includes(upload), 'the artifacts map stays un-inlined');
  const fullChat = written['full_chat.md'];
  assert.ok(typeof fullChat === 'string' && fullChat.includes(`<img src="${upload}">`), 'full_chat.md keeps the sandbox path');
  assert.ok(!fullChat.includes('data:image/png;base64,AAAA'));
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

test('writeViewer puts large upload text in viewer-files', async () => {
  const popup = exportPopup({ routes: assetRoutes() });
  const { chat } = await runFolder(popup, withUploads());
  const big = 'big upload line\n'.repeat(5000);
  const withBig = JSON.parse(JSON.stringify(chat));
  withBig.messages[0].uploads = [...(withBig.messages[0].uploads || []), { name: 'big.md', href: 'uploads/p01_big.md', text: big }];
  const zip = zipStub();
  popup.sandbox.__zip = zip;
  popup.sandbox.__chats = [withBig];
  assert.strictEqual(await vm.runInContext('writeViewer(__zip, __chats)', popup.sandbox), true);
  assert.deepStrictEqual(Object.keys(zip.written).sort(), ['viewer-check.gif', 'viewer-files/part-0001.js', 'viewer.html']);
  const html = zip.written['viewer.html'];
  assert.ok(!html.includes('big upload line'));
  assert.match(/http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)[1], /script-src[^;]* file:;/);
  let got = null;
  new Function('window', zip.written['viewer-files/part-0001.js'])({ __archivePart: (n, d) => { got = { n, d }; } });
  assert.deepStrictEqual(got, { n: 1, d: { u0: big } });
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

// ---- project instructions ----
const instructionRoutes = (template) => [
  [/\/projects\/P$/, () => ({ ok: true, status: 200, json: async () => ({ name: 'My Project', prompt_template: template, docs_count: 0, files_count: 0 }) })],
  [/\/projects\/P\/docs$/, () => ({ ok: true, status: 200, json: async () => [] })],
  [/\/projects\/P\/files$/, () => ({ ok: true, status: 200, json: async () => [] })],
];
const chatIn = (uuid) => Object.assign(oneMessage([{ type: 'text', text: 'hi' }]), { uuid, name: 'n', project_uuid: 'P' });

test('project instructions: the prompt template reaches the viewer, cleaned, and no export file changes', async () => {
  const { chat, written } = await runFolder(exportPopup({ routes: instructionRoutes('Be \u00e2\u0080\u0094 brief <script>x</script>') }), chatIn('c1'));
  assert.strictEqual(chat.project.instructions, 'Be \u2014 brief <script>x</script>');
  assert.ok('project/prompt_template.md' in written);
});

test('project instructions: empty when the project has none', async () => {
  const { chat } = await runFolder(exportPopup({ routes: instructionRoutes(undefined) }), chatIn('c1'));
  assert.strictEqual(chat.project.instructions, '');
  const none = await runFolder(exportPopup(), Object.assign(oneMessage([{ type: 'text', text: 'hi' }]), { uuid: 'c2', name: 'n' }));
  assert.strictEqual(none.chat.project, null);
});

test('project instructions: every chat of a shared project gets them, even if its own fetch fails', async () => {
  let calls = 0;
  const routes = [
    [/\/projects\/P$/, () => (++calls === 1
      ? { ok: true, status: 200, json: async () => ({ name: 'My Project', prompt_template: 'House rules' }) }
      : { ok: false, status: 500 })],
    [/\/projects\/P\/docs$/, () => ({ ok: true, status: 200, json: async () => [] })],
    [/\/projects\/P\/files$/, () => ({ ok: true, status: 200, json: async () => [{ file_uuid: 'pf1', file_name: 'Paper.pdf' }] })],
  ];
  const shared = { root: zipStub(), byUuid: new Map(), usedDirs: new Set() };
  const popup = exportPopup({ routes });
  const first = await runFolder(popup, chatIn('c1'), { folderName: 'chat_a', shared });
  const second = await runFolder(popup, chatIn('c2'), { folderName: 'chat_b', shared });
  assert.strictEqual(first.chat.project.instructions, 'House rules');
  assert.strictEqual(second.chat.project.instructions, 'House rules');
});

test('project instructions: over the embed limit they are cut with a note, whole in prompt_template.md', async () => {
  const long = 'y'.repeat(3 * 1024 * 1024);
  const { chat, written } = await runFolder(exportPopup({ routes: instructionRoutes(long) }), chatIn('c1'));
  assert.ok(chat.project.instructions.length < long.length);
  assert.match(chat.project.instructions, /truncated.*project\/prompt_template\.md/);
  assert.ok(written['project/prompt_template.md'].includes(long));
});

// ---- export-core.js ----
test('export-core.js exports the shared extractors', () => {
  const core = require('../export-core.js');
  const names = ['fixMojibake', 'isTextFile', 'getMessageChain', 'failedToolUseIds', 'isBashTool', 'heredocPath', 'HEREDOC_RE', 'heredocFiles',
    'extractArtifacts', 'extractUploadedFiles', 'extractPresentedFiles', 'extractDeliveredFiles', 'getModelName', 'buildViewerDeliveries'];
  for (const name of names) assert.ok(name in core, `${name} is exported`);
});

test('popup.html and sidepanel.html load export-core.js, takeout-viewer.js, then popup.js', () => {
  for (const page of ['popup.html', 'sidepanel.html']) {
    const html = fs.readFileSync(path.join(REPO, page), 'utf8');
    const scripts = Array.from(html.matchAll(/<script src="([^"]+)"/g), (m) => m[1]);
    const order = ['export-core.js', 'takeout-viewer.js', 'popup.js'].map((s) => scripts.indexOf(s));
    assert.ok(order.every((i) => i >= 0), `${page} loads all three`);
    assert.deepStrictEqual(order, [...order].sort((a, b) => a - b), `${page} order`);
  }
});

test('buildViewerDeliveries names each uuid after its first file', () => {
  const { buildViewerDeliveries } = require('../export-core.js');
  const files = [{ filename: 'a_v1.md', uuid: 'u1', path: '/p/a.md' }, { filename: 'a_v2.md', uuid: 'u2', path: '/p/a.md' }, { filename: 'a.md', uuid: 'u2', path: '/p/a.md' }];
  assert.deepStrictEqual(buildViewerDeliveries(files), { u1: { filename: 'a_v1.md', path: '/p/a.md' }, u2: { filename: 'a_v2.md', path: '/p/a.md' } });
});

// ---- Export baseline: every file populateConversationFolder writes, hashed ----
// Refresh with UPDATE_EXPORT_BASELINE=1 node --test tests/export.test.js, after confirming the change is intended.
const BASELINE = path.join(__dirname, 'fixtures', 'export-baseline.json');
test('the export of the fixture is byte-for-byte what the stored baseline says', async () => {
  const crypto = require('crypto');
  // formatTimestamp prints local time, so the export runs in UTC whatever the machine's zone is.
  // Tests in a file run one at a time, and the zone is put back in finally.
  const zone = process.env.TZ;
  process.env.TZ = 'UTC';
  let written;
  try {
    const popup = exportPopup({ failing: ['up-gone'], routes: projectResponses() });
    const data = withUploads();
    data.project_uuid = 'P';
    ({ written } = await runFolder(popup, data));
  } finally {
    if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone;
  }
  const files = everyFile(written);
  delete files['viewer.html'];
  delete files['viewer-check.gif'];
  const manifest = {};
  for (const [name, content] of Object.entries(files)) manifest[name] = crypto.createHash('sha256').update(content).digest('hex');
  if (process.env.UPDATE_EXPORT_BASELINE) fs.writeFileSync(BASELINE, JSON.stringify(manifest, null, 2) + '\n');
  assert.deepStrictEqual(manifest, JSON.parse(fs.readFileSync(BASELINE, 'utf8')));
});

test('fixMojibake sorts its map keys once, not on every call', () => {
  const core = require('../export-core.js');
  core.fixMojibake('warm up');
  const sort = Array.prototype.sort;
  let calls = 0;
  Array.prototype.sort = function (...args) { calls++; return sort.apply(this, args); };
  try {
    core.fixMojibake('another â€” string');
    core.fixMojibake('and one more');
  } finally { Array.prototype.sort = sort; }
  assert.strictEqual(calls, 0);
});

const plain = o => JSON.parse(JSON.stringify(o));

// Turns: each inner array is one assistant message's content, each after a human message.
const turns = (...contents) => {
  const chat_messages = [];
  let parent = null;
  contents.forEach((content, i) => {
    chat_messages.push({ uuid: `h${i}`, parent_message_uuid: parent, sender: 'human', content: [] });
    chat_messages.push({ uuid: `a${i}`, parent_message_uuid: `h${i}`, sender: 'assistant', content });
    parent = `a${i}`;
  });
  return { current_leaf_message_uuid: parent, chat_messages };
};

test('a file named like another artifact\'s _vN is renamed, not overwritten', () => {
  const later = turns(
    [use('1', 'create_file', { path: '/h/report.html', file_text: 'A' })],
    [use('2', 'str_replace', { path: '/h/report.html', old_str: 'A', new_str: 'B' })],
    [use('3', 'create_file', { path: '/h/report_v1.html', file_text: 'OTHER' })],
  );
  const warned = collector();
  const want = { 'report_v1.html': 'A', 'report_v2.html': 'B', 'report.html': 'B', 'report_v1_2.html': 'OTHER' };
  assert.deepStrictEqual(plain(artifacts(later, warned)), want);
  assert.deepStrictEqual(plain(warned.warnings.map(w => [w.type, w.filename])), [['artifact_basename_collision', 'report_v1_2.html']]);
  assert.deepStrictEqual(pythonArtifacts(later), want);

  const earlier = turns(
    [use('1', 'create_file', { path: '/h/report_v1.html', file_text: 'OTHER' }), use('2', 'create_file', { path: '/h/report.html', file_text: 'A' })],
    [use('3', 'str_replace', { path: '/h/report.html', old_str: 'A', new_str: 'B' })],
  );
  const want2 = { 'report_v1.html': 'OTHER', 'report_2_v1.html': 'A', 'report_2_v2.html': 'B', 'report_2.html': 'B' };
  const index = {};
  assert.deepStrictEqual(plain(artifacts(earlier, null, index)), want2);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(index['/h/report.html'])).versions, ['report_2_v1.html', 'report_2_v2.html']);
  assert.deepStrictEqual(pythonArtifacts(earlier), want2);
});

test('the artifacts tool\'s update edits and rewrite are applied', () => {
  const art = (id, input) => use(id, 'artifacts', { id: 'a1', title: 'Doc', type: 'text/markdown', ...input });
  const data = turns(
    [art('1', { command: 'create', content: 'hello world' })],
    [art('2', { command: 'update', old_str: 'world', new_str: 'there' })],
    [art('3', { command: 'rewrite', content: 'new text, there' })],
    [art('4', { command: 'update', old_str: 'there', new_str: 'here' })],
  );
  const want = { 'Doc_v1.md': 'hello world', 'Doc_v2.md': 'hello there', 'Doc_v3.md': 'new text, there', 'Doc_v4.md': 'new text, here', 'Doc.md': 'new text, here' };
  assert.deepStrictEqual(plain(artifacts(data)), want);
  assert.deepStrictEqual(pythonArtifacts(data), want);
});

test('an artifacts-tool update that does not match warns', () => {
  const data = turns(
    [use('1', 'artifacts', { command: 'create', id: 'a1', title: 'Doc', type: 'text/markdown', content: 'hello' })],
    [use('2', 'artifacts', { command: 'update', id: 'a1', old_str: 'nope', new_str: 'x' })],
  );
  const warned = collector();
  assert.deepStrictEqual(plain(artifacts(data, warned)), { 'Doc.md': 'hello' });
  assert.deepStrictEqual(plain(warned.warnings.map(w => [w.type, w.filename])), [['str_replace_failed', 'Doc.md']]);
});

test('the blob fallback takes only a full view of that exact file', () => {
  const view = (id, path, text, input = {}) => [use(id, 'view', { path, ...input }), { type: 'tool_result', tool_use_id: id, name: 'view', content: [{ type: 'text', text }] }];
  const chat = (...blocks) => ({ chat_messages: [{ uuid: 'a', sender: 'assistant', content: blocks.flat() }] });
  const listing = 'Here are the files and directories up to 2 levels deep in /mnt/user-data/uploads, excluding hidden items:\n4.0K\t/mnt/user-data/uploads\n4.0K\t/mnt/user-data/uploads/notes.md\n';
  const full = "Here's the content of /mnt/user-data/uploads/notes.md with line numbers:\n     1\thello\n     2\tworld";
  const extract = fn('extractBlobContent');
  assert.strictEqual(extract(chat(view('1', '/mnt/user-data/uploads', listing), view('2', '/mnt/user-data/uploads/notes.md', full)), '/mnt/user-data/uploads/notes.md').content, 'hello\nworld');
  assert.strictEqual(extract(chat(view('1', '/mnt/user-data/uploads', listing)), '/mnt/user-data/uploads/notes.md'), null);
  const other = "Here's the content of /mnt/user-data/uploads/old_data.csv with line numbers:\n     1\ta,b";
  assert.strictEqual(extract(chat(view('1', '/mnt/user-data/uploads/old_data.csv', other)), '/mnt/user-data/uploads/data.csv'), null);
  assert.strictEqual(extract(chat(view('1', '/mnt/user-data/uploads/notes.md', full, { view_range: [1, 2] })), '/mnt/user-data/uploads/notes.md'), null);
  // The sandbox renames odd characters to _, so a view of the sanitized name still counts.
  const sanitized = "Here's the content of /mnt/user-data/uploads/My_File__1_.md with line numbers:\n     1\tok";
  const got = extract(chat(view('1', '/mnt/user-data/uploads/My_File__1_.md', sanitized)), '/mnt/user-data/uploads/My File (1).md');
  assert.strictEqual(got.content, 'ok');
});

test('detectOpaqueMutations catches common write forms and ignores reads', () => {
  const tracked = [use('0', 'create_file', { path: '/home/claude/page.html', file_text: 'x' })];
  const warns = command => {
    const c = collector();
    fn('detectOpaqueMutations')(oneMessage([...tracked, use('1', 'bash_tool', { command })]), c);
    return c.warnings.length;
  };
  for (const cmd of [
    "python3 -c \"open('/home/claude/page.html','w', encoding='utf-8').write('y')\"",
    "python3 -c \"open('/home/claude/page.html', mode='w').write('y')\"",
    "python3 -c \"from pathlib import Path; Path('/home/claude/page.html').write_text('y')\"",
    "python3 - <<'PY'\np = '/home/claude/page.html'\nwith open(p, 'w', encoding='utf-8') as f:\n    f.write('y')\nPY",
    "sed -E -i 's/x/y/' /home/claude/page.html",
    "cd /home/claude && sed -i 's/a;b/c/' page.html && grep -c c page.html",
    "sed -i 's/x|y/z/' /home/claude/page.html",
    "sed --in-place 's/x/y/' /home/claude/page.html",
    "perl -pi -e 's/x/y/' /home/claude/page.html",
    "echo hi | tee /home/claude/page.html",
    "echo hi | tee -a /home/claude/page.html",
    "cp /tmp/other.html /home/claude/page.html",
    "mv /tmp/other.html /home/claude/page.html",
  ]) assert.strictEqual(warns(cmd), 1, cmd);
  for (const cmd of [
    "cat /home/claude/page.html",
    "python3 -c \"print(open('/home/claude/page.html').read())\"",
    "python3 -c \"open('/home/claude/page.html', 'r', encoding='utf-8').read()\"",
    "cp /home/claude/page.html /mnt/user-data/outputs/page.html",
    "grep -c div /home/claude/page.html | tee /tmp/count.txt",
    "sed -n '1,5p' /home/claude/page.html",
  ]) assert.strictEqual(warns(cmd), 0, cmd);
});

test('integrated_chat.txt keeps code blocks as written', () => {
  const plain = fn('markdownToPlainText');
  const code = 'class A:\n    def __init__(self, **kwargs):\n        x = a*b*c  # `tick`\n        y = "_x_"';
  const out = plain('Some **bold** and `code` text.\n\n```python\n' + code + '\n```\n\nAfter _that_.');
  assert.ok(out.includes(code), out);
  assert.ok(out.includes('Some bold and code text.'), out);
  assert.ok(out.includes('After that.'), out);
  assert.ok(!out.includes('```'), out);
});

// ---- Markdown and file names ----
const chatOf = (messages) => {
  const chat_messages = messages.map((m, i) => ({ uuid: `m${i}`, parent_message_uuid: i ? `m${i - 1}` : null, created_at: '2026-01-01T00:00:00Z', attachments: [], files: [], files_v2: [], ...m }));
  return { uuid: 'conv-1', name: 'Test chat', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', settings: {}, current_leaf_message_uuid: chat_messages[chat_messages.length - 1].uuid, chat_messages };
};
const presented = (id, paths) => [
  use(id, 'present_files', { filepaths: paths }),
  { type: 'tool_result', tool_use_id: id, name: 'present_files', content: paths.map((p, i) => ({ type: 'local_resource', file_path: p, uuid: `${id}-u${i}` })) },
];

test('Markdown export shows pasted text and names uploads; no fake request for assistant attachments', () => {
  const data = chatOf([
    { sender: 'human', content: [{ type: 'text', text: 'see these' }], attachments: [{ file_name: 'notes.txt', extracted_content: 'PASTED ```BODY```' }, { file_name: '', extracted_content: 'second paste' }], files_v2: [{ success: true, file_name: 'photo.png', file_uuid: 'u1' }] },
    { sender: 'assistant', content: [{ type: 'text', text: 'ok' }], attachments: [{ file_name: 'ghost.md' }] },
  ]);
  const md = fn('convertToMarkdown')(data, { embedArtifacts: true });
  assert.ok(md.includes('notes.txt') && md.includes('PASTED ```BODY```') && md.includes('second paste'), md);
  assert.ok(md.includes('````'), 'a paste holding ``` gets a longer fence');
  assert.ok(md.includes('photo.png'), md);
  assert.ok(!md.includes('/mnt/user-data/outputs/ghost.md'), md);
});

test('prompts.md links each upload to the name it was saved under', async () => {
  const nfd = 'Müller.pdf';
  const data = chatOf([
    { sender: 'human', content: [{ type: 'text', text: 'files' }], files_v2: [
      { success: true, file_name: 'image.png', file_uuid: 'i1', file_kind: 'image' },
      { success: true, file_name: 'image.png', file_uuid: 'i2', file_kind: 'image' },
      { success: true, file_name: 'Photo.PNG', file_uuid: 'i3', file_kind: 'image' },
      { success: true, file_name: 'photo.png', file_uuid: 'i4', file_kind: 'image' },
      { success: true, file_name: nfd, file_uuid: 'n1', file_kind: 'document' },
      { success: true, file_name: 'pdf_notes.txt', file_uuid: 'b1', file_kind: 'blob', path: '/mnt/user-data/uploads/pdf_notes.txt' },
      { success: true, file_name: 'lost.pdf', file_uuid: 'gone', file_kind: 'document' },
    ] },
    { sender: 'assistant', content: [use('v1', 'view', { path: '/mnt/user-data/uploads/pdf_notes.txt' }), { type: 'tool_result', tool_use_id: 'v1', name: 'view', content: [{ type: 'text', text: "Here's the content of /mnt/user-data/uploads/pdf_notes.txt with line numbers:\n     1\tnote" }] }] },
  ]);
  const { written } = await runFolder(exportPopup({ failing: ['b1', 'gone', 'pdf_notes'] }), data);
  const saved = Object.keys(written).filter((k) => k.startsWith('uploads/')).sort();
  assert.deepStrictEqual(saved, ['uploads/p01_Müller.pdf', 'uploads/p01_Photo.PNG', 'uploads/p01_image.png', 'uploads/p01_image_1.png', 'uploads/p01_pdf_notes.txt', 'uploads/p01_photo_1.png'].sort());
  const prompts = String(written['prompts.md'].content || written['prompts.md']);
  const links = [...prompts.matchAll(/\]\((uploads\/[^)]+)\)/g)].map((m) => decodeURIComponent(m[1]));
  assert.deepStrictEqual(links.slice().sort(), saved);
  assert.ok(/lost\.pdf/.test(prompts) && !/\(uploads\/[^)]*lost/.test(prompts), 'a failed upload is named without a link');
});

test('a presented file is downloaded when replay is known to be wrong, and same-named ones are kept apart', async () => {
  const data = chatOf([
    { sender: 'human', content: [{ type: 'text', text: 'go' }] },
    { sender: 'assistant', content: [
      use('c1', 'create_file', { path: '/home/claude/page.html', file_text: 'replayed' }),
      use('b1', 'bash_tool', { command: "python3 -c \"open('/home/claude/page.html','w', encoding='utf-8').write('real')\" && cp /home/claude/page.html /mnt/user-data/outputs/page.html" }),
      use('c2', 'create_file', { path: '/home/claude/clean.html', file_text: 'clean' }),
      ...presented('p1', ['/mnt/user-data/outputs/page.html', '/mnt/user-data/outputs/clean.html', '/mnt/user-data/outputs/en/index.html', '/mnt/user-data/outputs/de/index.html', '/mnt/user-data/outputs/a/report.docx', '/mnt/user-data/outputs/b/report.docx']),
    ] },
  ]);
  const asked = [];
  const popup = exportPopup({ routes: [[/download-file\?path=/, (url) => {
    const p = decodeURIComponent(url.split('path=')[1]);
    asked.push(p);
    return { ok: true, status: 200, blob: async () => textBlob(`DISK ${p}`, 'text/html') };
  }]] });
  const { written } = await runFolder(popup, data);
  const text = (k) => { const v = written[k]; return String(v && v.content !== undefined ? v.content : v).replace(/^﻿/, ''); };
  assert.strictEqual(text('artefacts/page.html'), 'DISK /mnt/user-data/outputs/page.html');
  assert.strictEqual(text('artefacts/clean.html'), 'clean');
  assert.ok(!asked.includes('/mnt/user-data/outputs/clean.html'), 'a cleanly replayed file is not downloaded');
  assert.strictEqual(text('artefacts/index.html'), 'DISK /mnt/user-data/outputs/en/index.html');
  assert.strictEqual(text('artefacts/index_2.html'), 'DISK /mnt/user-data/outputs/de/index.html');
  assert.ok('artefacts/report.docx' in written && 'artefacts/report_2.docx' in written);
  const errors = written['errors.txt'] ? text('errors.txt') : '';
  assert.ok(!/page\.html/.test(errors.split('## Warnings')[1] || ''), errors);
  assert.ok(/index_2\.html/.test(errors) && /report_2\.docx/.test(errors), errors);
  const full = text('full_chat.md');
  assert.ok(!full.includes('(not found)'), full);
  assert.ok(full.includes('artefacts/report_2.docx'), 'a binary presented file links to its saved copy');
});

test('code_snippets.md fences grow past any backtick run in the code', () => {
  assert.strictEqual(fn('getCodeFence')('plain'), '```');
  assert.strictEqual(fn('getCodeFence')('has ``` inside'), '````');
  assert.strictEqual(fn('getCodeFence')('has ````` inside'), '``````');
  const md = fn('generateCodeSnippets')([{ lang: 'markdown', code: '# Readme\n\n```bash\nls\n```\n', filename: 'README.md' }, { lang: 'python', code: 'print(1)' }]);
  assert.ok(md.includes('````markdown\n# Readme\n\n```bash\nls\n```\n\n````\n'), md);
  assert.ok(md.includes('```python\nprint(1)\n```\n'), md);
});

test('project docs with clashing names are all kept', async () => {
  const docs = [
    { uuid: 'd1', file_name: 'notes.md', content: 'first' },
    { uuid: 'd2', file_name: 'notes.md', content: 'second' },
    { uuid: 'd3', file_name: 'project.json', content: 'a doc, not metadata' },
    { uuid: 'd4', file_name: 'Q3/Q4 plan.md', content: 'plan' },
  ];
  const data = loadFixture();
  data.project_uuid = 'P';
  data.project = { uuid: 'P', name: 'Proj' };
  const popup = exportPopup({ routes: [
    [/\/projects\/P$/, () => ({ ok: true, status: 200, json: async () => ({ name: 'Proj', prompt_template: '' }) })],
    [/\/projects\/P\/docs$/, () => ({ ok: true, status: 200, json: async () => docs })],
    [/\/projects\/P\/files$/, () => ({ ok: true, status: 200, json: async () => [] })],
  ] });
  const { written } = await runFolder(popup, data);
  const text = (k) => { const v = written[k]; return String(v && v.content !== undefined ? v.content : v).replace(/^﻿/, ''); };
  assert.strictEqual(text('project/notes.md'), 'first');
  assert.strictEqual(text('project/notes_2.md'), 'second');
  assert.strictEqual(text('project/project_2.json'), 'a doc, not metadata');
  assert.strictEqual(text('project/Q3_Q4 plan.md'), 'plan');
  assert.ok(JSON.parse(text('project/project.json')).name === 'Proj');
});

test('filenames keep letters from any script; ASCII names are unchanged', () => {
  const safe = fn('safeFilename'), clean = fn('sanitizeForFilename');
  assert.strictEqual(safe('Привет мир'), 'Привет_мир');
  assert.strictEqual(safe('日本語の質問について'), '日本語の質問について');
  assert.strictEqual(safe('My Chat: v2!'), 'My_Chat__v2_');
  assert.strictEqual(safe('a/b\\c'), 'a_b_c');
  assert.strictEqual(clean('# Привет, мир'), 'привет_мир');
  assert.strictEqual(clean('日本語の質問について'), '日本語の質問について');
  assert.strictEqual(clean('## Hello, World - Again'), 'hello_world_again');
  assert.strictEqual(clean('!!!'), 'untitled');
});

test('names from chat data cannot form paths', () => {
  const data = turns([
    use('1', 'create_file', { path: '/h/a\\b.txt', file_text: 'x' }),
    use('2', 'bash_tool', { command: "cat > /tmp/.. << 'EOF'\ny\nEOF" }),
  ]);
  const want = { 'a_b.txt': 'x', '_': 'y' };
  assert.deepStrictEqual(plain(artifacts(data)), want);
  assert.deepStrictEqual(pythonArtifacts(data), want);
  assert.strictEqual(fn('zipSafeName')('..'), '_');
  assert.strictEqual(fn('zipSafeName')('Q3/Q4\u0007.md'), 'Q3_Q4_.md');
});

test('uploads become data URIs only when a file refers to them', async () => {
  let reads = 0;
  const counted = { ...textBlob('png', 'image/png'), arrayBuffer: async () => { reads++; return new ArrayBuffer(3); } };
  const data = chatOf([
    { sender: 'human', content: [{ type: 'text', text: 'pic' }], files_v2: [{ success: true, file_name: 'x.png', file_uuid: 'up-x', file_kind: 'image', path: '/mnt/user-data/uploads/x.png' }] },
    { sender: 'assistant', content: [use('1', 'create_file', { path: '/h/plain.html', file_text: '<p>no image</p>' })] },
  ]);
  await runFolder(exportPopup({ texts: { 'up-x': counted } }), data);
  assert.strictEqual(reads, 0, 'no file refers to the upload');
  data.chat_messages[1].content.push(use('2', 'create_file', { path: '/h/pic.html', file_text: '<img src="/mnt/user-data/uploads/x.png">' }));
  const { written } = await runFolder(exportPopup({ texts: { 'up-x': counted } }), data);
  assert.strictEqual(reads, 1);
  assert.ok(String(written['artefacts/pic.html']).includes('data:image/png;base64,AAAA'));
});

test('a mega-ZIP fetches a project\'s documents once', async () => {
  const seen = [];
  const routes = [
    [/\/projects\/P$/, () => ({ ok: true, status: 200, json: async () => ({ name: 'Proj', prompt_template: 'be brief' }) })],
    [/\/projects\/P\/docs$/, () => ({ ok: true, status: 200, json: async () => [{ uuid: 'd1', file_name: 'Brief.md', content: 'be kind' }] })],
    [/\/projects\/P\/files$/, () => ({ ok: true, status: 200, json: async () => [] })],
  ].map(([re, answer]) => [re, (url) => { seen.push(url); return answer(url); }]);
  const shared = { root: zipStub(), byUuid: new Map(), usedDirs: new Set() };
  const chats = [];
  for (const id of ['c1', 'c2', 'c3']) {
    const data = Object.assign(chatOf([{ sender: 'human', content: [{ type: 'text', text: id }] }]), { uuid: id, project_uuid: 'P' });
    chats.push(await runFolder(exportPopup({ routes }), data, { shared, folderName: id }));
  }
  assert.strictEqual(seen.filter((u) => /\/projects\/P\/docs$/.test(u)).length, 1);
  assert.strictEqual(seen.filter((u) => /\/projects\/P$/.test(u)).length, 1);
  for (const { written, chat } of chats) {
    assert.ok(String(written['project/Brief.md']).includes('be kind'));
    assert.strictEqual(chat.project.instructions, 'be brief');
  }
});

test('a message chain with a parent loop ends', () => {
  const data = { current_leaf_message_uuid: 'a', chat_messages: [
    { uuid: 'a', parent_message_uuid: 'b', sender: 'assistant', content: [use('1', 'create_file', { path: '/h/x.md', file_text: 'x' })] },
    { uuid: 'b', parent_message_uuid: 'a', sender: 'human', content: [] },
  ] };
  assert.deepStrictEqual(Array.from(fn('getMessageChain')(data), (m) => m.uuid), ['b', 'a']);
  assert.deepStrictEqual(plain(artifacts(data)), { 'x.md': 'x' });
  assert.deepStrictEqual(pythonArtifacts(data), { 'x.md': 'x' });
});

test('uploads without a file UUID are told apart by prompt in the viewer', async () => {
  const data = chatOf([
    { sender: 'human', content: [{ type: 'text', text: 'one' }], files: [{ success: true, file_name: 'notes.txt', file_kind: 'blob' }] },
    { sender: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    { sender: 'human', content: [{ type: 'text', text: 'two' }], files: [{ success: true, file_name: 'notes.txt', file_kind: 'blob' }] },
  ]);
  const popup = exportPopup({ routes: [[/download-file\?path=/, () => ({ ok: true, status: 200, blob: async () => textBlob('n') })]] });
  // The legacy entries have no path, so give them the sandbox one the export tries.
  data.chat_messages[0].files[0].path = '/mnt/user-data/uploads/notes.txt';
  data.chat_messages[2].files[0].path = '/mnt/user-data/uploads/notes.txt';
  const { chat, written } = await runFolder(popup, data);
  assert.ok('uploads/p01_notes.txt' in written && 'uploads/p02_notes.txt' in written, Object.keys(written).join());
  const hrefs = chat.messages.filter((m) => m.sender === 'human').map((m) => (m.uploads || []).map((u) => u.href));
  assert.deepStrictEqual(plain(hrefs), [['uploads/p01_notes.txt'], ['uploads/p02_notes.txt']]);
});

// ---- cleanup group ----
test('an empty heredoc ends at its own terminator, and <<- strips leading tabs', () => {
  const data = turns([
    use('1', 'bash_tool', { command: "cat > /h/a.txt << 'EOF'\nEOF\ncat > /h/b.txt << 'EOF'\nhello\nEOF" }),
    use('2', 'bash_tool', { command: "cat > /h/t.txt <<- 'EOF'\n\tindented\n\t\ttwice\n\tEOF" }),
  ]);
  const want = { 'b.txt': 'hello', 't.txt': 'indented\ntwice' };
  assert.deepStrictEqual(plain(artifacts(data)), want);
  assert.deepStrictEqual(pythonArtifacts(data), want);
});

test('a file named like an Object property is kept', () => {
  const data = turns([
    use('1', 'bash_tool', { command: "cat > /h/constructor << 'EOF'\nx\nEOF" }),
    use('2', 'create_file', { path: '/h/toString', file_text: 'y' }),
    use('3', 'create_file', { path: '/h/__proto__', file_text: 'z' }),
  ]);
  const want = JSON.parse('{"constructor":"x","toString":"y","__proto__":"z"}');
  const sorted = (o) => JSON.parse(JSON.stringify(Object.entries(o))).sort();
  assert.deepStrictEqual(sorted(artifacts(data)), sorted(want));
  assert.deepStrictEqual(sorted(pythonArtifacts(data)), sorted(want));
});

test('detectOpaqueMutations ignores heredoc bodies and flags heredocs bash would expand', () => {
  const tracked = [use('0', 'create_file', { path: '/home/claude/about.html', file_text: 'x' })];
  const warned = (command) => {
    const c = collector();
    fn('detectOpaqueMutations')(oneMessage([...tracked, use('1', 'bash_tool', { command })]), c);
    return c.warnings.map((w) => w.filename);
  };
  assert.deepStrictEqual(plain(warned("cat > /home/claude/index.html << 'EOF'\n<nav><a href=\"about.html\">about.html</a></nav>\nEOF")), []);
  assert.deepStrictEqual(plain(warned('cat /home/claude/about.html > /home/claude/about.html.bak')), []);
  assert.deepStrictEqual(plain(warned("cat > /home/claude/app.js << EOF\nconst url = `${base}/x`;\nEOF")), ['app.js']);
  assert.deepStrictEqual(plain(warned("cat > /home/claude/app.js << 'EOF'\nconst url = `${base}/x`;\nEOF")), []);
  assert.deepStrictEqual(plain(warned('cat > /home/claude/plain.txt << EOF\nno expansion here\nEOF')), []);
});

test('every progress update gives a step and a total', async () => {
  const popup = exportPopup({ routes: projectResponses() });
  const data = withUploads();
  data.project_uuid = 'P';
  const calls = [];
  popup.sandbox.__folder = zipStub();
  popup.sandbox.__data = data;
  popup.sandbox.__progress = (...args) => calls.push(args);
  await vm.runInContext("populateConversationFolder(__folder, __data, __progress, 'org', null, '')", popup.sandbox);
  assert.ok(calls.length > 0);
  for (const args of calls) assert.ok(typeof args[0] === 'number' && typeof args[1] === 'number', JSON.stringify(args));
});

test('a long title keeps its _embedded suffix', () => {
  const name = fn('generateFilename')('How to configure a reverse proxy for my home server', 'md', null, '_embedded');
  assert.ok(name.endsWith('_embedded.md'), name);
});

test('an export that is running blocks a second one', async () => {
  let runs = 0, release;
  const wrapped = fn('exclusiveExport')(async () => { runs++; await new Promise((r) => { release = r; }); });
  const first = wrapped();
  await wrapped();
  release();
  await first;
  assert.strictEqual(runs, 1);
  await fn('exclusiveExport')(async () => { runs++; })();
  assert.strictEqual(runs, 2, 'a later export runs');
});

test('extract_artifacts.py writes .md files with the BOM an export gives them', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'takeout-bom-'));
  try {
    fs.writeFileSync(path.join(dir, 'original.json'), JSON.stringify(oneMessage([use('1', 'create_file', { path: '/h/a.md', file_text: '# hi' }), use('2', 'create_file', { path: '/h/b.py', file_text: 'x' })])));
    execFileSync('python3', ['-B', path.join(REPO, 'extract_artifacts.py'), path.join(dir, 'original.json'), '-o', path.join(dir, 'out'), '--quiet']);
    assert.deepStrictEqual([...fs.readFileSync(path.join(dir, 'out', 'a.md')).subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'out', 'b.py'), 'utf8'), 'x');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- Claude Docs documents ----
const DOC_V1 = '# Lorber Notes\n\nA subtitle\n\n2026-11-08\n\n## Alpha\n\nalpha text\n\n*(This section wasn\'t written.)*\n\n---\n\n*Live document on claude.ai: ' + DOC_URL + '*\n';
const DOC_V2 = '# Lorber Notes\n\nA subtitle\n\n2026-11-08\n\n## Alpha\n\nalpha text\n\n## Beta\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n---\n\n## Comments\n\n- On “Beta”: Table or prose?\n\n*Live document on claude.ai: ' + DOC_URL + '*\n';
const docChat = (prefix) => {
  const t = docTools(prefix);
  return turns(
    [t.batch, t.batchResult, t.update('u1', 'sess.10', '## Alpha\n\nalpha text'), t.result('u1', '{"verdict":"allow"}')],
    [t.update('u2', 'sess.11', '## Beta\n\n| a | b |\n| --- | --- |\n| 1 | 2 |'), t.result('u2', '{"verdict":"allow"}'), t.comment, t.result('c1', '{"verdict":"allow"}')],
  );
};

test('a Claude Docs document is rebuilt, one version per turn, in both implementations', () => {
  const data = docChat();
  const want = { 'Lorber_Notes_v1.md': DOC_V1, 'Lorber_Notes_v2.md': DOC_V2, 'Lorber_Notes.md': DOC_V2 };
  assert.deepStrictEqual(plain(artifacts(data)), want);
  assert.deepStrictEqual(pythonArtifacts(data), want);
  const other = docChat('mcp__claude_ai_Claude_Docs__');
  assert.deepStrictEqual(Object.keys(plain(artifacts(other))), Object.keys(want), 'any connector prefix');
});

test('a Claude Docs edit that is not filling a section warns', () => {
  const t = docTools();
  const odd = { type: 'tool_use', id: 'u9', name: 'mcp__Claude_Docs__update', input: { ref: { object: 'node', id: 'node-1' }, payload: JSON.stringify({ ops: [{ op: 'insert', target: { kind: 'after', id: 'sess.0' }, with: { from: { kind: 'inline', content: 'new' } } }] }) } };
  const data = turns([t.batch, t.batchResult], [odd, t.result('u9', '{"verdict":"allow"}')]);
  const warned = collector();
  artifacts(data, warned);
  assert.deepStrictEqual(plain(warned.warnings.map((w) => [w.type, w.filename])), [['claude_doc_unreplayed', 'Lorber_Notes.md']]);
  assert.match(warned.warnings[0].details.note, /claude\.ai\/artifact/);
});

test('an export writes a Claude Docs document as .md and a safe standalone .html', async () => {
  const t = docTools();
  // Each on its own paragraph: a line starting with raw HTML would make the whole paragraph one escaped block.
  const hostile = '## Gamma\n\n<script>window.__hit=1</script>\n\nSee [bad](javascript:alert(1)) and [ok](https://example.com).\n\nAn image ![x](javascript:alert(1)) and <img src=x onerror=alert(1)> inline.';
  const data = Object.assign(turns(
    [t.batch, t.batchResult, t.update('u1', 'sess.10', '## Alpha\n\n**bold** and *it*'), t.result('u1', '{"verdict":"allow"}')],
    [t.update('u2', 'sess.11', hostile), t.result('u2', '{"verdict":"allow"}')],
  ), { uuid: 'docs-chat', name: 'Docs chat' });
  const { written } = await runFolder(exportPopup(), data);
  const text = (k) => { const v = written[k]; return String(v && v.content !== undefined ? v.content : v).replace(/^﻿/, ''); };
  assert.ok(text('artefacts/Lorber_Notes.md').startsWith('# Lorber Notes'));
  const html = text('artefacts/Lorber_Notes.html');
  assert.match(html, /<title>Lorber Notes<\/title>/);
  assert.match(html, /<h2[^>]*>Alpha<\/h2>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /http-equiv="Content-Security-Policy" content="default-src 'none'/);
  assert.ok(!/<script/i.test(html.replace(/&lt;script/gi, '')), 'no script element');
  assert.ok(!/(href|src)="javascript:/i.test(html), 'no javascript: link or image');
  assert.match(html, /See bad and <a href="https:\/\/example\.com"/, 'an unsafe link keeps only its text');
  assert.ok(!/onerror=/i.test(html.replace(/&lt;img[^]*?&gt;/gi, '')), 'no event handler attribute');
  assert.match(html, /href="https:\/\/example\.com"/);
  const full = text('full_chat.md');
  assert.ok(!full.includes('"ops"') && !full.includes('Claude_Docs__batch'), 'no raw tool JSON');
  assert.match(full, /Document: Lorber Notes/);
});

// ---- second review: export and Claude Docs ----
const docText = (written, k) => { const v = written[k]; return v === undefined ? undefined : String(v && v.content !== undefined ? v.content : v).replace(/^﻿/, ''); };
const docWarnings = (data) => { const w = collector(); artifacts(data, w); return plain(w.warnings.map((x) => [x.type, x.filename])); };

test('full_chat.md links and embeds each document by the name it was saved under', async () => {
  const a = docTools(undefined, { node: 'n-a', title: 'Notes', idPrefix: 'a' });
  const b = docTools(undefined, { node: 'n-b', title: 'Notes', idPrefix: 'b' });
  const data = Object.assign(turns(
    [a.batch, a.batchResult, a.update('ua', 'sess.10', 'FIRST DOC'), a.result('ua', '{}')],
    [b.batch, b.batchResult, b.update('ub', 'sess.10', 'SECOND DOC'), b.result('ub', '{}')],
  ), { uuid: 'two', name: 'two docs' });
  const { written } = await runFolder(exportPopup(), data);
  assert.ok(docText(written, 'artefacts/Notes.md').includes('FIRST DOC') && docText(written, 'artefacts/Notes_2.md').includes('SECOND DOC'));
  const full = docText(written, 'full_chat.md');
  assert.ok(full.includes('artefacts/Notes_2.md') && full.includes('SECOND DOC'), 'the second document is linked and shown');
});

test('Claude Docs edits that are not section fills, empty updates and a missing batch result all warn', () => {
  const t = docTools();
  const batchEdit = { type: 'tool_use', id: 'be', name: 'mcp__Claude_Docs__batch', input: { container: { kind: 'project', id: 'node-1' }, batch: [{ op: 'replace', target: { ids: ['x'] } }] } };
  assert.deepStrictEqual(docWarnings(turns([t.batch, t.batchResult], [batchEdit, t.result('be', '{}')])), [['claude_doc_unreplayed', 'Lorber_Notes.md']]);
  const empty = { type: 'tool_use', id: 'ue', name: 'mcp__Claude_Docs__update', input: { ref: { object: 'node', id: 'node-1' }, payload: 'rename please' } };
  assert.deepStrictEqual(docWarnings(turns([t.batch, t.batchResult], [empty, t.result('ue', '{}')])), [['claude_doc_unreplayed', 'Lorber_Notes.md']]);
  // No result (the chat stopped): the document is still exported, its sections unwritten, with a warning.
  const lost = turns([t.batch]);
  const out = plain(artifacts(lost));
  assert.deepStrictEqual(Object.keys(out), ['Lorber_Notes.md']);
  assert.match(out['Lorber_Notes.md'], /wasn't written/);
  assert.deepStrictEqual(docWarnings(lost), [['claude_doc_unreplayed', 'Lorber_Notes.md']]);
  assert.deepStrictEqual(pythonArtifacts(lost), out);
});

test('a section filled with chips expands them, in both implementations', () => {
  const t = docTools();
  const data = turns([t.batch, t.batchResult, t.update('u1', 'sess.10', 'Owner <?claude block me?>, due <?claude block due?>.', { blocks: { me: { type: 'mention', user: 'me' }, due: { type: 'date', value: '2026-10-06' } } }), t.result('u1', '{}')]);
  const out = plain(artifacts(data))['Lorber_Notes.md'];
  assert.ok(out.includes('Owner , due 2026-10-06.') || out.includes('Owner, due 2026-10-06.'), out);
  assert.ok(!out.includes('<?claude'), out);
  assert.deepStrictEqual(pythonArtifacts(data)['Lorber_Notes.md'], out);
});

test('odd Claude Docs shapes do not crash the Python script and render the same in both', () => {
  const t = docTools();
  const odd = JSON.parse(JSON.stringify(t.batch));
  odd.input.container.create.doc.blocks.x = { value: 1 };
  odd.input.container.create.doc.blocks.y = 'text';
  odd.input.container.create.doc.markdown += '\n\n<?claude block x?>\n\n<?claude block y?>';
  const badOps = { type: 'tool_use', id: 'u9', name: 'mcp__Claude_Docs__update', input: { ref: { object: 'node', id: 'node-1' }, payload: JSON.stringify({ ops: ['nope', null] }) } };
  const data = turns([odd, t.batchResult], [badOps, t.result('u9', '{}')]);
  assert.deepStrictEqual(pythonArtifacts(data), plain(artifacts(data)));
  const strDoc = JSON.parse(JSON.stringify(t.batch));
  strDoc.input.container.create.doc = 'not an object';
  assert.deepStrictEqual(pythonArtifacts(turns([strDoc, t.batchResult])), plain(artifacts(turns([strDoc, t.batchResult]))));
});

test('multi-line comments stay one list item and one quote', async () => {
  const t = docTools();
  const c = JSON.parse(JSON.stringify(t.comment));
  c.input.payload = JSON.stringify({ value: { body: 'first line\n\nsecond line', parent: { object: 'node', id: 'node-1' } } });
  const data = Object.assign(turns([t.batch, t.batchResult], [c, t.result('c1', '{}')]), { uuid: 'mc', name: 'mc' });
  const md = plain(artifacts(data))['Lorber_Notes.md'];
  assert.match(md, /- first line\n\n {2}second line/);
  assert.deepStrictEqual(pythonArtifacts(data)['Lorber_Notes.md'], md);
  const { written } = await runFolder(exportPopup(), data);
  assert.match(docText(written, 'full_chat.md'), /> \*\*Comment on the document:\*\* first line\n>\n> second line/);
});

test('non-Latin titles keep their letters in file names', () => {
  const art = (id, title) => use(id, 'artifacts', { command: 'create', id, title, type: 'text/markdown', content: title });
  const data = turns([art('1', 'Резюме'), art('2', '日本語'), art('3', '!!!')]);
  const want = ['Резюме.md', '日本語.md', '3.md'];
  assert.deepStrictEqual(Object.keys(plain(artifacts(data))).sort(), want.slice().sort());
  assert.deepStrictEqual(Object.keys(pythonArtifacts(data)).sort(), want.slice().sort());
});

test('claudeDocHtml escapes text after raw tags and escapes attributes once', () => {
  const html = fn('claudeDocHtml')('T', 'Wrap it in <code> tags; it works when n<limit, and AT&T too.\n\nSee <https://e.com/?a=1&b=2> and ![Q&A](https://e.com/x.png "Tom & Jerry").');
  const body = html.split('<main>')[1];
  assert.ok(body.includes('n&lt;limit') && body.includes('AT&amp;T'), body);
  assert.ok(body.includes('href="https://e.com/?a=1&amp;b=2"'), body);
  assert.ok(body.includes('alt="Q&amp;A"') && body.includes('title="Tom &amp; Jerry"'), body);
  assert.ok(!body.includes('&amp;amp;'), body);
});

test('a document .html never clashes with another file, whatever the case, and README lists it', async () => {
  const t = docTools(undefined, { title: 'Notes' });
  const data = Object.assign(turns([use('0', 'create_file', { path: '/mnt/user-data/outputs/notes.html', file_text: '<p>mine</p>' }), t.batch, t.batchResult]), { uuid: 'nc', name: 'nc' });
  const { written } = await runFolder(exportPopup(), data);
  const arte = Object.keys(written).filter((k) => k.startsWith('artefacts/')).map((k) => k.slice(10).toLowerCase());
  assert.strictEqual(new Set(arte).size, arte.length, arte.join());
  const docHtml = Object.keys(written).find((k) => /artefacts\/Notes.*\.html$/.test(k));
  assert.ok(docHtml && docText(written, docHtml).includes('<title>Notes</title>'));
  assert.ok(docText(written, 'README.md').includes(docHtml.slice(10)), 'README lists the page');
});

test('a single Markdown file shows the document, not a link into a ZIP', () => {
  const t = docTools();
  const data = turns([t.batch, t.batchResult, t.update('u1', 'sess.10', 'SECTION ONE'), t.result('u1', '{}')]);
  const md = fn('convertToMarkdown')(data, { embedArtifacts: false });
  assert.ok(!md.includes('artefacts/'), md);
  assert.ok(md.includes(DOC_URL), 'the live document is linked');
  const embedded = fn('convertToMarkdown')(data, { embedArtifacts: true });
  assert.ok(embedded.includes('SECTION ONE'), 'the embedded export shows the document');
});

test('a presented file is matched to the artifact with its exact path', async () => {
  const data = Object.assign(chatOf([
    { sender: 'human', content: [{ type: 'text', text: 'go' }] },
    { sender: 'assistant', content: [
      use('1', 'create_file', { path: '/home/claude/index.html', file_text: 'DRAFT' }),
      use('2', 'create_file', { path: '/mnt/user-data/outputs/index.html', file_text: 'FINAL' }),
      ...presented('p', ['/mnt/user-data/outputs/index.html']),
    ] },
  ]), { uuid: 'pm', name: 'pm' });
  const asked = [];
  const popup = exportPopup({ routes: [[/download-file/, (u) => { asked.push(u); return { ok: true, status: 200, blob: async () => textBlob('DISK') }; }]] });
  const { written } = await runFolder(popup, data);
  const full = docText(written, 'full_chat.md');
  const at = full.indexOf('**Artifact: index_2.html**');
  assert.ok(at >= 0 && full.slice(at, at + 200).includes('FINAL'), 'the presented file is the outputs copy');
  assert.strictEqual(asked.length, 0, 'it was replayed cleanly, so nothing is downloaded');
});

test('detectOpaqueMutations: every changed file, Path variables, ./name, globs, other interpreters, and heredoc text', () => {
  const tracked = ['/home/claude/foo.html', '/home/claude/bar.html', '/home/claude/index.html'].map((p, i) => use('t' + i, 'create_file', { path: p, file_text: 'x' }));
  const warned = (command) => { const c = collector(); fn('detectOpaqueMutations')(oneMessage([...tracked, use('1', 'bash_tool', { command })]), c); return c.warnings.map((w) => w.filename).sort().join(','); };
  assert.strictEqual(warned("sed -i 's/v1/v2/' /home/claude/foo.html /home/claude/bar.html"), 'bar.html,foo.html');
  assert.strictEqual(warned("python3 - <<'PY'\nfrom pathlib import Path\np = Path('/home/claude/foo.html')\np.write_text(p.read_text().replace('a', 'b'))\nPY"), 'foo.html');
  assert.strictEqual(warned("cd /home/claude && sed -i 's/a/b/' ./foo.html"), 'foo.html');
  assert.strictEqual(warned("sed -i 's/a/b/' /home/claude/*.html"), 'bar.html,foo.html,index.html');
  assert.strictEqual(warned("python3 -c \"open(file='/home/claude/foo.html', mode='w').write('y')\""), 'foo.html');
  assert.strictEqual(warned("awk -i inplace '{print}' /home/claude/foo.html"), 'foo.html');
  assert.strictEqual(warned("python3 << 'EOF'\n# check the page's size\nprint(len(open('/home/claude/foo.html').read()))\nEOF\nsed -i 's/a/b/' /home/claude/foo.html"), 'foo.html');
  assert.strictEqual(warned("python3 << 'EOF'\nhtml = '<a href=\"foo.html\">foo.html</a>'\nopen('/home/claude/index.html', 'w').write(html)\nEOF"), 'index.html');
  assert.strictEqual(warned("echo '<li><a href=\"foo.html\">foo.html</a></li>' >> /home/claude/index.html"), 'index.html');
});

test('heredocs written as cat << EOF > path or cat >path << EOF are tracked, in every implementation', () => {
  const data = turns([
    use('1', 'bash_tool', { command: "cat << 'EOF' > /home/claude/app.py\nprint(1)\nEOF" }),
    use('2', 'bash_tool', { command: "cat >/home/claude/b.py <<'EOF'\nprint(2)\nEOF" }),
  ]);
  const want = { 'app.py': 'print(1)', 'b.py': 'print(2)' };
  assert.deepStrictEqual(plain(artifacts(data)), want);
  assert.deepStrictEqual(pythonArtifacts(data), want);
});

test('integrated_chat.txt keeps link paths and snake_case words', () => {
  const plainText = fn('markdownToPlainText');
  const out = plainText('- [my_notes.txt](uploads/p01_my_notes.txt)\n\nSet MAX_RETRIES and API_KEY; 2 * 3 * 4 = 24. Some _italic_ and *emphasis* and **bold**.');
  assert.ok(out.includes('my_notes.txt (uploads/p01_my_notes.txt)'), out);
  assert.ok(out.includes('MAX_RETRIES and API_KEY') && out.includes('2 * 3 * 4 = 24'), out);
  assert.ok(out.includes('Some italic and emphasis and bold.'), out);
});

test('pasted names are de-duplicated case-insensitively', () => {
  const data = chatOf([{ sender: 'human', content: [{ type: 'text', text: 'p' }], attachments: [{ file_name: 'Notes.txt', extracted_content: 'a' }, { file_name: 'notes.txt', extracted_content: 'b' }] }]);
  const names = Object.keys(fn('extractTextAttachments')(data).attachments).map((n) => n.toLowerCase());
  assert.strictEqual(new Set(names).size, 2, names.join());
});

test('an export leaves disabled buttons disabled, and bulk exports hold the lock until they finish', async () => {
  const popup = exportPopup();
  const doc = popup.sandbox.document;
  doc.getElementById('exportMd').disabled = true;
  await vm.runInContext('exclusiveExport(async () => {})()', popup.sandbox);
  assert.strictEqual(doc.getElementById('exportMd').disabled, true, 'a button that was off stays off');
  let answer;
  popup.sandbox.chrome.tabs.query = async () => [{ id: 1, url: 'https://claude.ai/chat/x' }];
  popup.sandbox.chrome.tabs.sendMessage = (id, msg, cb) => { answer = cb; };
  let done = false;
  const run = vm.runInContext('exclusiveExport(() => bulkExportZip())()', popup.sandbox).then(() => { done = true; });
  for (let i = 0; i < 5 && !answer; i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(answer, 'the list was requested');
  assert.strictEqual(done, false, 'still running while the list is fetched');
  assert.strictEqual(vm.runInContext('exportRunning', popup.sandbox), true);
  answer({ error: 'stopped' });
  await run;
  assert.strictEqual(vm.runInContext('exportRunning', popup.sandbox), false);
});

// ---- export health check ----
const { chatHealth } = require('../export-core.js');
const healthOf = (data) => chatHealth(data).map((h) => h.check);

test('chatHealth: a normal chat and a chat that was never used are healthy', () => {
  assert.deepStrictEqual(healthOf(chatOf([{ sender: 'human', content: [{ type: 'text', text: 'hi' }] }, { sender: 'assistant', content: [{ type: 'text', text: 'yo' }] }])), []);
  assert.deepStrictEqual(healthOf({ uuid: 'e', created_at: '2026-06-03T03:05:41Z', updated_at: '2026-06-03T03:05:41Z', chat_messages: [] }), []);
});

test('chatHealth flags what an API change would leave behind', () => {
  assert.deepStrictEqual(healthOf({ uuid: 'x', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z' }), ['no_messages']);
  assert.deepStrictEqual(healthOf({ uuid: 'x', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z', chat_messages: [] }), ['no_messages']);
  const hollow = chatOf([{ sender: 'human', content: [] }, { sender: 'assistant', content: [{ type: 'text', text: 'ok' }] }]);
  const h = chatHealth(hollow);
  assert.deepStrictEqual(h.map((x) => x.check), ['empty_messages']);
  assert.match(h[0].message, /1 of 2 messages/);
  const branched = chatOf([{ sender: 'human', content: [{ type: 'text', text: 'q' }] }, { sender: 'assistant', content: [{ type: 'text', text: 'a' }] }]);
  branched.chat_messages.push({ uuid: 'alt', parent_message_uuid: 'm0', sender: 'assistant', content: [{ type: 'text', text: 'b' }] });
  branched.current_leaf_message_uuid = 'gone';
  assert.deepStrictEqual(healthOf(branched), ['unknown_branch']);
  const unbranched = chatOf([{ sender: 'human', content: [{ type: 'text', text: 'q' }] }]);
  delete unbranched.current_leaf_message_uuid;
  assert.deepStrictEqual(healthOf(unbranched), [], 'one line of messages needs no leaf');
  const odd = chatOf([{ sender: 'assistant', content: [{ type: 'text', text: 'a' }, { type: 'hologram', x: 1 }, { type: 'hologram' }, { type: 'voice_note' }] }]);
  const u = chatHealth(odd);
  assert.deepStrictEqual(u.map((x) => x.check), ['unknown_blocks']);
  assert.match(u[0].message, /hologram \(2\), voice_note \(1\)/);
});

test('an export records health problems in errors.txt and says so in the result', async () => {
  const data = Object.assign(chatOf([{ sender: 'human', content: [] }, { sender: 'assistant', content: [{ type: 'text', text: 'ok' }, { type: 'hologram' }] }]), { uuid: 'hc', name: 'hc' });
  const { written, output } = await runFolder(exportPopup(), data);
  const errors = String(written['errors.txt'] && (written['errors.txt'].content ?? written['errors.txt']));
  assert.match(errors, /export_health|looks incomplete/i);
  assert.match(errors, /hologram/);
  assert.strictEqual(output.healthIssues, 2);
});

test('an export where every upload failed is a health problem', async () => {
  const data = Object.assign(chatOf([{ sender: 'human', content: [{ type: 'text', text: 'see' }], files_v2: [
    { success: true, file_name: 'a.pdf', file_uuid: 'gone-1', file_kind: 'document' }, { success: true, file_name: 'b.pdf', file_uuid: 'gone-2', file_kind: 'document' }] }]), { uuid: 'uf', name: 'uf' });
  const { output, written } = await runFolder(exportPopup({ failing: ['gone-1', 'gone-2'] }), data);
  assert.strictEqual(output.healthIssues, 1);
  assert.match(String(written['errors.txt'].content ?? written['errors.txt']), /none of the 2 uploads/i);
});

test('a single export without errors.txt turns amber when the chat looks incomplete', () => {
  const status = { className: '', textContent: '' };
  fn('exportedStatus')(status, chatOf([{ sender: 'human', content: [{ type: 'text', text: 'hi' }] }]), 'JSON exported successfully!');
  assert.deepStrictEqual([status.className, status.textContent], ['status ready', 'JSON exported successfully!']);
  fn('exportedStatus')(status, { uuid: 'x', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-03T00:00:00Z', chat_messages: [] }, 'JSON exported successfully!');
  assert.strictEqual(status.className, 'status warning');
  assert.match(status.textContent, /^JSON exported successfully\. But this chat looks incomplete: claude\.ai returned no messages/);
});

test('the viewer chat of an export carries its files\' warnings', async () => {
  const data = Object.assign(turns([use('1', 'create_file', { path: '/home/claude/page.html', file_text: '<p>a</p>' }), use('2', 'bash_tool', { command: "sed -i 's/a/b/' /home/claude/page.html" })]), { uuid: 'fl', name: 'fl', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' });
  const { chat } = await runFolder(exportPopup(), data);
  assert.deepStrictEqual(Object.values(chat.files).map(f => [f.name, f.flag]), [['page.html', 'script']]);
});

// ---- incremental export ----
test('changedSince picks chats that are new or updated since the record', () => {
  const list = [{ uuid: 'a', updated_at: '1' }, { uuid: 'b', updated_at: '2' }, { uuid: 'c', updated_at: '3' }];
  const pick = (record) => plain(fn('changedSince')(list, record)).map((c) => c.uuid);
  assert.deepStrictEqual(pick({ a: '1', b: 'old' }), ['b', 'c']);
  assert.deepStrictEqual(pick({ a: '1', b: '2', c: '3' }), []);
  assert.deepStrictEqual(pick({}), ['a', 'b', 'c']);
});

// Runs bulkExportZip in the sandbox with a chat list and chats, a real JSZip, and storage kept in memory.
async function runBulkZip({ list, chats, stored = {}, options = {} }) {
  const JSZip = require('../jszip.min.js');
  const popup = exportPopup();
  const sb = popup.sandbox;
  const store = { ...stored };
  sb.chrome.storage.local.get = async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((k) => k in store).map((k) => [k, JSON.parse(JSON.stringify(store[k]))]));
  sb.chrome.storage.local.set = async (o) => { Object.assign(store, JSON.parse(JSON.stringify(o))); };
  sb.chrome.tabs.query = async () => [{ id: 1, url: 'https://claude.ai/chat/x' }];
  sb.chrome.tabs.sendMessage = (id, msg, cb) => {
    if (msg.action === 'fetchAllConversations') cb({ data: list, orgId: 'org-1' });
    else if (msg.action === 'fetchConversation') cb({ data: chats[msg.conversationId] });
    else cb({});
  };
  sb.JSZip = JSZip;
  let saved = null;
  sb.download = (blob, name) => { saved = { blob, name }; };
  sb.setTimeout = (f) => setTimeout(f, 0);
  vm.runInContext('orgId = "org-1"', sb);
  sb.__opts = options;
  await vm.runInContext('bulkExportZip(__opts)', sb);
  const zip = saved ? await JSZip.loadAsync(await saved.blob.arrayBuffer()) : null;
  return { store, saved, zip, status: sb.document.getElementById('status') };
}
const listed = (uuid, updated) => ({ uuid, name: `Chat ${uuid}`, updated_at: updated });
const chatFor = (uuid, updated) => Object.assign(chatOf([{ sender: 'human', content: [{ type: 'text', text: `hello ${uuid}` }] }]), { uuid, name: `Chat ${uuid}`, created_at: updated, updated_at: updated });

test('a full mega-ZIP writes export-manifest.json and records what it exported', async () => {
  const list = [listed('a', '2026-01-01T00:00:00Z'), listed('b', '2026-01-02T00:00:00Z')];
  const chats = { a: chatFor('a', '2026-01-01T00:00:00Z'), b: chatFor('b', '2026-01-02T00:00:00Z') };
  const { store, saved, zip } = await runBulkZip({ list, chats });
  assert.match(saved.name, /^claude-takeout-\d{4}-\d{2}-\d{2}\.zip$/);
  const manifest = JSON.parse(await zip.file('export-manifest.json').async('string'));
  assert.strictEqual(manifest.kind, 'full');
  assert.strictEqual(manifest.listed, 2);
  assert.deepStrictEqual(manifest.chats.map((c) => [c.uuid, c.updated_at, c.folder]), [['a', '2026-01-01T00:00:00Z', 'Chat_a'], ['b', '2026-01-02T00:00:00Z', 'Chat_b']]);
  assert.deepStrictEqual(store.exportRecord['org-1'].chats, { a: '2026-01-01T00:00:00Z', b: '2026-01-02T00:00:00Z' });
  assert.ok(store.exportRecord['org-1'].at);
});

test('Export changes takes only new and updated chats, and says when nothing changed', async () => {
  const stored = { exportRecord: { 'org-1': { at: '2026-01-05T00:00:00Z', chats: { a: '2026-01-01T00:00:00Z', b: '2026-01-02T00:00:00Z' } } } };
  const list = [listed('a', '2026-01-01T00:00:00Z'), listed('b', '2026-01-09T00:00:00Z'), listed('c', '2026-01-08T00:00:00Z')];
  const chats = { a: chatFor('a', '2026-01-01T00:00:00Z'), b: chatFor('b', '2026-01-09T00:00:00Z'), c: chatFor('c', '2026-01-08T00:00:00Z') };
  const { store, saved, zip } = await runBulkZip({ list, chats, stored, options: { changesOnly: true } });
  assert.match(saved.name, /^claude-takeout-changes-\d{4}-\d{2}-\d{2}\.zip$/);
  const manifest = JSON.parse(await zip.file('export-manifest.json').async('string'));
  assert.deepStrictEqual([manifest.kind, manifest.since, manifest.chats.map((c) => c.uuid)], ['changes', '2026-01-05T00:00:00Z', ['b', 'c']]);
  assert.ok(!zip.file('Chat_a/README.md') && zip.file('Chat_b/README.md') && zip.file('Chat_c/README.md'));
  assert.match((await zip.file('index.md').async('string')).replace(/^﻿/, ''), /^# Claude Takeout - Changes since /);
  assert.deepStrictEqual(store.exportRecord['org-1'].chats, { a: '2026-01-01T00:00:00Z', b: '2026-01-09T00:00:00Z', c: '2026-01-08T00:00:00Z' });

  const again = await runBulkZip({ list, chats, stored: store, options: { changesOnly: true } });
  assert.strictEqual(again.saved, null, 'nothing to download');
  assert.match(again.status.textContent, /Nothing changed since/);
});

test('Export changes with no record exports everything and says why', async () => {
  const list = [listed('a', '2026-01-01T00:00:00Z')];
  const { saved, zip, status } = await runBulkZip({ list, chats: { a: chatFor('a', '2026-01-01T00:00:00Z') }, options: { changesOnly: true } });
  assert.ok(saved);
  assert.strictEqual(JSON.parse(await zip.file('export-manifest.json').async('string')).kind, 'full');
  assert.match(status.textContent, /no earlier export/i);
});

test('a chat that failed is not recorded, so the next Export changes tries it again', async () => {
  const list = [listed('a', '2026-01-01T00:00:00Z'), listed('b', '2026-01-02T00:00:00Z')];
  const { store } = await runBulkZip({ list, chats: { a: chatFor('a', '2026-01-01T00:00:00Z') } });
  assert.deepStrictEqual(Object.keys(store.exportRecord['org-1'].chats), ['a']);
});
