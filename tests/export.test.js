// Export logic: runs the real popup.js functions on a synthetic conversation.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const path = require('path');
const vm = require('vm');
const { DOC_URL, DOC_U, OTHER_U, docTools, REPO, loadPopup, loadFixture, pythonArtifacts, use, result, oneMessage, twoMessages, textBlob, projectResponses, zipStub, exportPopup, runFolder, withUploads, publishedFetcher } = require('./helpers');

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

const { assetRoutes, FakeDir } = require('./helpers');

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

test('writeViewer builds a viewer from artifacts alone, with their listed count and since', async () => {
  const popup = exportPopup({ routes: assetRoutes() });
  const zip = zipStub();
  popup.sandbox.__zip = zip;
  popup.sandbox.__chats = [];
  popup.sandbox.__opts = { artifacts: { views: [{ id: 'Abc', title: 'Guide', folder: 'artifacts/Guide_Abc' }], listed: 4, exported: '2026-03-01T00:00:00Z', since: '2026-02-01T00:00:00Z' }, firstPart: 2 };
  assert.strictEqual(await vm.runInContext('writeViewer(__zip, __chats, __opts)', popup.sandbox), true);
  const html = zip.written['viewer.html'];
  for (const text of ['"title":"Guide"', '"links":[]', '"docFile":null', '"listed":4', '"artifactsSince":"2026-02-01T00:00:00Z"']) assert.ok(html.includes(text), text);
  popup.sandbox.__opts = { artifacts: { views: [], listed: 0, exported: 'e', since: null } };
  assert.strictEqual(await vm.runInContext('writeViewer(__zip, __chats, __opts)', popup.sandbox), false);
});

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

// A batch on an existing document, as claude.ai writes one to add a diagram: a widget, then a section
// filled with Markdown that embeds it.
const diagramBatch = (id, sectionId, content, { caption = 'How the parts fit', extra = [] } = {}) => ({ type: 'tool_use', id, name: 'mcp__Claude_Docs__batch', input: {
  container: { kind: 'project', id: 'proj' },
  batch: [
    { $lid: 'w', engine: 'widget', object: 'node', verb: 'create', payload: { code: 'export default () => null', parent: { object: 'file', id: 'tab-1' } } },
    { verb: 'update', engine: 'prose', ref: { object: 'node', id: 'node-1' }, payload: { ops: [{ op: 'replace', target: { kind: 'blocks', ids: [sectionId] },
      with: { as: 'markdown', blocks: { dia: { type: 'embed', caption, ref: 'node/$lid:w' } }, from: { kind: 'inline', content } } }] } },
    ...extra,
  ] } });
const findEdit = (id, text, content, extra = {}) => ({ type: 'tool_use', id, name: 'mcp__Claude_Docs__update', input: { ref: { object: 'node', id: 'node-1' }, engine: 'prose', container: { kind: 'project', id: 'proj' },
  payload: { ops: [{ op: 'replace', target: { kind: 'find', text, ...extra }, with: { as: 'text', from: { kind: 'inline', content } } }] } } });

test('a batch that adds a diagram and fills a section is replayed, in both implementations', () => {
  const t = docTools();
  const data = turns(
    [t.batch, t.batchResult, t.update('u1', 'sess.10', '## Alpha\n\nalpha text'), t.result('u1', '{}')],
    [diagramBatch('b2', 'sess.11', '## Beta\n\n<?claude block dia?>\n\nUnder the picture.\n\n| a | b |\n| --- | --- |\n| 1 | 2 |'), t.result('b2', '{}')],
  );
  const md = plain(artifacts(data))['Lorber_Notes.md'];
  assert.match(md, /## Beta\n\n\[embedded content: How the parts fit\]\n\nUnder the picture\.\n\n\| a \| b \|/);
  assert.ok(!md.includes("wasn't written"), md);
  assert.deepStrictEqual(docWarnings(data), []);
  assert.deepStrictEqual(pythonArtifacts(data)['Lorber_Notes.md'], md);
  assert.strictEqual(require('../export-core.js').claudeDocKey(diagramBatch('b2', 'sess.11', 'x'), null), 'doc:node-1', 'the viewer shows a card for the document it edits');
  // A batch member the export doesn't know still warns.
  const odd = turns([t.batch, t.batchResult], [diagramBatch('b3', 'sess.11', 'text', { extra: [{ verb: 'create', object: 'file', payload: { value: { birthName: 'Tab 2' } } }] }), t.result('b3', '{}')]);
  assert.match(plain(artifacts(odd))['Lorber_Notes.md'], /text/);
  assert.deepStrictEqual(docWarnings(odd), [['claude_doc_unreplayed', 'Lorber_Notes.md']]);
});

test('a placeholder made inside a section is filled later, in both implementations', () => {
  const t = docTools();
  // The fill plants its own pending block; the update's reply gives its id.
  const fill = t.update('u1', 'sess.10', '## Alpha\n\nalpha text\n\n<?claude block dg?>\n\nafter it', { blocks: { dg: { type: 'pending', intent: 'Diagram: the parts' } } });
  const reply = t.result('u1', JSON.stringify({ verdict: 'allow', rev: 2, session: 'sess', xml: "<doc op='0'><paragraph id='.20'>Alpha</paragraph><pending id='.25' intent='Diagram: the parts'/></doc>" }));
  const unfilled = turns([t.batch, t.batchResult, fill, reply]);
  assert.match(plain(artifacts(unfilled))['Lorber_Notes.md'], /alpha text\n\n\*\(This section wasn't written\.\)\*\n\nafter it/);
  const data = turns([t.batch, t.batchResult, fill, reply],
    [diagramBatch('b2', 'sess.25', '### At a glance\n\n<?claude block dia?>\n\nOne (1:1) line.'), t.result('b2', '{}'), findEdit('f1', '(1:1)', '(2:1)'), t.result('f1', '{}')]);
  const md = plain(artifacts(data))['Lorber_Notes.md'];
  assert.match(md, /alpha text\n\n### At a glance\n\n\[embedded content: How the parts fit\]\n\nOne \(2:1\) line\.\n\nafter it/);
  assert.deepStrictEqual(docWarnings(data), []);
  assert.deepStrictEqual(pythonArtifacts(data)['Lorber_Notes.md'], md);
});

test('a Claude Docs find-and-replace edit is replayed, in both implementations', () => {
  const t = docTools();
  const base = [t.batch, t.batchResult, t.update('u1', 'sess.10', '## Alpha\n\nratios (1:1, 2:1) and (1:1, 2:1)'), t.result('u1', '{}')];
  const fixed = turns(base, [findEdit('f1', '(1:1, 2:1)', '(2:1, 3:1)'), t.result('f1', '{}'), findEdit('f2', 'A subtitle', 'A better subtitle'), t.result('f2', '{}')]);
  const md = plain(artifacts(fixed))['Lorber_Notes.md'];
  assert.match(md, /ratios \(2:1, 3:1\) and \(1:1, 2:1\)/, 'the first match by default');
  assert.match(md, /^# Lorber Notes\n\nA better subtitle\n/, 'text outside the sections too');
  assert.deepStrictEqual(docWarnings(fixed), []);
  assert.deepStrictEqual(pythonArtifacts(fixed)['Lorber_Notes.md'], md);
  const second = turns(base, [findEdit('f1', '(1:1, 2:1)', '(4:3)', { nth: 2 }), t.result('f1', '{}')]);
  assert.match(plain(artifacts(second))['Lorber_Notes.md'], /ratios \(1:1, 2:1\) and \(4:3\)/);
  assert.deepStrictEqual(pythonArtifacts(second), plain(artifacts(second)));
  // Not found, or only inside a table cell: nothing is guessed, and it warns.
  for (const edit of [findEdit('f1', 'not in the document', 'x'), findEdit('f1', '(1:1, 2:1)', 'x', { within: { kind: 'cell', table: 't', row: 1, col: 1 } })]) {
    const data = turns(base, [edit, t.result('f1', '{}')]);
    assert.match(plain(artifacts(data))['Lorber_Notes.md'], /ratios \(1:1, 2:1\) and \(1:1, 2:1\)/);
    assert.deepStrictEqual(docWarnings(data), [['claude_doc_unreplayed', 'Lorber_Notes.md']]);
    assert.deepStrictEqual(pythonArtifacts(data), plain(artifacts(data)));
  }
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

test('commandCwds: own cd wins, earlier cd carries, none is null', () => {
  const data = turns(
    [use('a', 'bash_tool', { command: 'ls' })],
    [use('b', 'bash_tool', { command: 'cd /home/claude/x && ls' }), use('c', 'Bash', { command: 'python3 run.py' })],
    [use('d', 'bash_tool', { command: 'cd /tmp; python3 a.py' }), use('e', 'bash_tool', { command: "cat > /h/s.py << 'EOF'\ncd /nowhere\nEOF" })],
    [use('f', 'bash_tool', { command: 'cd lorber && ls' }), use('g', 'create_file', { path: '/x', file_text: '' }), use('h', 'bash_tool', { command: 'cd ~' }), use('i', 'bash_tool', { command: 'ls' })],
  );
  const cwds = fn('commandCwds')(fn('getMessageChain')(data));
  assert.strictEqual(cwds.get('a'), null);
  assert.strictEqual(cwds.get('b'), '/home/claude/x');
  assert.strictEqual(cwds.get('c'), '/home/claude/x');
  assert.strictEqual(cwds.get('d'), '/tmp');
  assert.strictEqual(cwds.get('e'), '/tmp', 'a cd inside a heredoc body is text');
  assert.strictEqual(cwds.get('f'), '/tmp/lorber', 'a relative cd resolves against the carried directory');
  assert.ok(!cwds.has('g'), 'only bash commands');
  assert.strictEqual(cwds.get('i'), null, 'a cd the export cannot follow leaves the directory unknown');
});

test('commandCwds: a command that changes directory any other way than one leading cd has no known directory', () => {
  const cwdOf = (...commands) => {
    const data = turns(commands.map((command, i) => use('c' + i, 'bash_tool', { command })));
    return fn('commandCwds')(fn('getMessageChain')(data)).get('c' + (commands.length - 1));
  };
  assert.strictEqual(cwdOf("cd /a && ls; cd /b && sed -i 's/a/b/' page.html"), null, 'a second cd');
  assert.strictEqual(cwdOf('cd /b', "cd /a || exit 1\nsed -i 's/a/b/' page.html"), null, 'cd with ||');
  assert.strictEqual(cwdOf('cd /a', "python3 -c \"import os;os.chdir('/b');open('page.html','w').write('x')\""), null, 'os.chdir');
  assert.strictEqual(cwdOf('cd /a', "python3 - <<'PY'\nimport os\nos.chdir('/b')\nPY"), null, 'os.chdir in a heredoc');
  assert.strictEqual(cwdOf('cd /a', "pushd /b && sed -i 's/a/b/' page.html"), null, 'pushd');
  assert.strictEqual(cwdOf('cd /a', "(cd /b && sed -i 's/a/b/' page.html)"), null, 'cd in a subshell');
  assert.strictEqual(cwdOf('cd /a', "python3 -c \"import os;os.chdir('/b')\"", 'ls'), null, 'unknown afterwards too');
  assert.strictEqual(cwdOf('cd /a', 'pushd /b', 'ls'), null, 'unknown after pushd');
  assert.strictEqual(cwdOf('cd /a && ls; cd /b && ls', 'ls'), '/b', 'the last plain cd carries');
  assert.strictEqual(cwdOf('cd /a; ls', "cd /b && sed -i 's/a/b/' x"), '/b', 'one leading cd still wins');
});

test('detectOpaqueMutations: an edit after a second cd, a cd ||, or os.chdir is unresolved between same-named files', () => {
  const files = [use('1', 'Write', { file_path: '/a/page.html', content: 'a' }), use('2', 'Write', { file_path: '/b/page.html', content: 'a' })];
  for (const commands of [
    ["cd /a && ls; cd /b && sed -i 's/a/b/' page.html"],
    ['cd /b', "cd /a || exit 1\nsed -i 's/a/b/' page.html"],
    ['cd /a', "python3 -c \"import os;os.chdir('/b');open('page.html','w').write('x')\""],
  ]) {
    const data = turns(files, ...commands.map((command, i) => [use('c' + i, 'bash_tool', { command })]));
    const out = fn('detectOpaqueMutations')(data, collector());
    assert.deepStrictEqual([...out.byFile.keys()].sort(), ['/a/page.html', '/b/page.html'], commands.join(' / '));
    assert.ok([...out.byFile.values()].every((e) => e.resolved === false), commands.join(' / '));
  }
});

test('resolveSandboxPath: relative under cwd, unique basename without cwd, ambiguous gives candidates', () => {
  const resolve = (word, cwd, known) => plain(fn('resolveSandboxPath')(word, cwd, known));
  const known = ['/home/claude/verb/body.html', '/home/claude/verb/lorber/body.html', '/home/claude/notes.md'];
  assert.deepStrictEqual(resolve('/abs/x.html', '/home/claude', known), { path: '/abs/x.html', candidates: ['/abs/x.html'] });
  assert.deepStrictEqual(resolve('body.html', '/home/claude/verb/lorber', known).path, '/home/claude/verb/lorber/body.html');
  assert.deepStrictEqual(resolve('./lorber/../body.html', '/home/claude/verb', known).path, '/home/claude/verb/body.html');
  assert.deepStrictEqual(resolve('../notes.md', '/home/claude/verb', known).path, '/home/claude/notes.md');
  assert.deepStrictEqual(resolve('notes.md', null, known), { path: '/home/claude/notes.md', candidates: ['/home/claude/notes.md'] });
  assert.deepStrictEqual(resolve('body.html', null, known), { path: null, candidates: ['/home/claude/verb/body.html', '/home/claude/verb/lorber/body.html'] });
  assert.deepStrictEqual(resolve('lorber/body.html', null, known).path, '/home/claude/verb/lorber/body.html');
  assert.deepStrictEqual(resolve('other.html', null, known), { path: null, candidates: [] });
});

test('isUnderFolder compares segments', () => {
  const under = fn('isUnderFolder');
  assert.strictEqual(under('/home/claude/de-luce/x.html', '/home/claude/de'), false);
  assert.strictEqual(under('/a/b/out/x.odt', '/a/b'), true);
  assert.strictEqual(under('/a/b/x.odt', '/a/b/'), true);
  assert.strictEqual(under('/a/b', '/a/b'), false);
});

test('detectOpaqueMutations: names the file under cd and merges its commands', () => {
  const data = turns(
    [use('1', 'Write', { file_path: '/home/claude/verb/body.html', content: 'a' }), use('2', 'Write', { file_path: '/home/claude/verb/lorber/body.html', content: 'a' })],
    [use('3', 'bash_tool', { command: "cd /home/claude/verb/lorber && python3 - <<'E'\nimport re\np='body.html';s=open(p).read()\nopen(p,'w').write(re.sub('a','b',s))\nE" })],
    [use('4', 'bash_tool', { command: "cd /home/claude/verb/lorber && python3 - <<'E'\nimport re\np='body.html';s=open(p).read()\nopen(p,'w').write(re.sub('a','b',s))\nE" })],
  );
  const index = {};
  artifacts(data, null, index);
  assert.strictEqual(index['/home/claude/verb/lorber/body.html'].filename, 'body_2.html');
  const c = collector();
  const out = fn('detectOpaqueMutations')(data, c, { index });
  assert.strictEqual(c.warnings.length, 1);
  assert.strictEqual(c.warnings[0].filename, 'body_2.html');
  assert.strictEqual(c.warnings[0].details.path, '/home/claude/verb/lorber/body.html');
  assert.match(c.warnings[0].message, /2 commands/);
  const entry = out.byFile.get('/home/claude/verb/lorber/body.html');
  assert.deepStrictEqual(plain({ ...entry }), { path: '/home/claude/verb/lorber/body.html', filename: 'body_2.html', msgIndexes: [3, 5], lastMsgIndex: 5, count: 2, resolved: true });
  // A replayed command is skipped.
  const skipped = collector();
  fn('detectOpaqueMutations')(data, skipped, { index, replayed: new Set(['3|/home/claude/verb/lorber/body.html']) });
  assert.match(skipped.warnings[0].message, /Changed by 1 command the export/);
});

test('detectOpaqueMutations: a name two files share, with no cd, is filed under both and unresolved', () => {
  const data = turns(
    [use('1', 'Write', { file_path: '/home/claude/a/page.html', content: 'a' }), use('2', 'Write', { file_path: '/home/claude/b/page.html', content: 'a' })],
    [use('3', 'bash_tool', { command: "sed -i 's/a/b/' page.html" })],
  );
  const out = fn('detectOpaqueMutations')(data, collector());
  assert.deepStrictEqual([...out.byFile.keys()].sort(), ['/home/claude/a/page.html', '/home/claude/b/page.html']);
  assert.ok([...out.byFile.values()].every((e) => e.resolved === false));
  const one = turns(
    [use('1', 'Write', { file_path: '/home/claude/a/page.html', content: 'a' }), use('2', 'Write', { file_path: '/home/claude/b/page.html', content: 'a' })],
    [use('3', 'bash_tool', { command: "cd /home/claude/b && sed -i 's/a/b/' page.html" })],
  );
  assert.deepStrictEqual([...fn('detectOpaqueMutations')(one, collector()).byFile.keys()], ['/home/claude/b/page.html']);
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
  const popup = exportPopup();
  const doc = popup.sandbox.document;
  popup.fn('chatSaved')('JSON', '{}', chatOf([{ sender: 'human', content: [{ type: 'text', text: 'hi' }] }]));
  assert.deepStrictEqual([doc.getElementById('chatCard').dataset.tone, doc.getElementById('status').textContent], ['ready', 'Saved JSON, 2 B']);
  popup.fn('chatSaved')('JSON', '{}', { uuid: 'x', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-03T00:00:00Z', chat_messages: [] });
  assert.strictEqual(doc.getElementById('chatCard').dataset.tone, 'warn');
  assert.strictEqual(doc.getElementById('status').textContent, 'Saved JSON, 2 B · 1 warning');
  assert.match(doc.getElementById('status').title, /^claude\.ai returned no messages/);
});

test('the viewer chat of an export carries its files\' warnings', async () => {
  const data = Object.assign(turns([use('1', 'create_file', { path: '/home/claude/page.html', file_text: '<p>a</p>' }), use('2', 'bash_tool', { command: "sed -i 's/a.*/b/' /home/claude/page.html" })]), { uuid: 'fl', name: 'fl', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' });
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
async function runBulkZip({ list, chats, stored = {}, options = {}, setup = null, accountName = null, assets = false }) {
  const JSZip = require('../jszip.min.js');
  const popup = exportPopup(assets ? { routes: assetRoutes() } : {});
  const sb = popup.sandbox;
  const store = { ...stored };
  sb.chrome.storage.local.get = async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((k) => k in store).map((k) => [k, JSON.parse(JSON.stringify(store[k]))]));
  sb.chrome.storage.local.set = async (o) => { Object.assign(store, JSON.parse(JSON.stringify(o))); };
  sb.chrome.tabs.query = async () => [{ id: 1, url: 'https://claude.ai/chat/x' }];
  sb.chrome.tabs.sendMessage = (id, msg, cb) => {
    if (msg.action === 'fetchAllConversations') cb({ data: list, orgId: 'org-1', accountName: msg.withAccountName ? accountName : undefined });
    else if (msg.action === 'fetchConversation') cb({ data: chats[msg.conversationId] });
    else if (msg.action === 'listArtifacts') cb({ frames: [] });  // no artifacts unless a test lists some
    else cb({});
  };
  sb.JSZip = JSZip;
  sb.Uint8Array = Uint8Array;  // bytes the popup makes, in the realm JSZip checks them against
  let saved = null;
  sb.download = (blob, name) => { saved = { blob, name }; };
  sb.setTimeout = (f) => setTimeout(f, 0);
  vm.runInContext('orgId = "org-1"', sb);
  if (setup) setup(sb);
  sb.__opts = options;
  const res = await vm.runInContext('bulkExportZip(__opts)', sb);
  const zip = saved ? await JSZip.loadAsync(await saved.blob.arrayBuffer()) : null;
  return { store, saved, zip, result: res ? JSON.parse(JSON.stringify(res)) : res };
}
const listed = (uuid, updated) => ({ uuid, name: `Chat ${uuid}`, updated_at: updated });
const chatFor = (uuid, updated) => Object.assign(chatOf([{ sender: 'human', content: [{ type: 'text', text: `hello ${uuid}` }] }]), { uuid, name: `Chat ${uuid}`, created_at: updated, updated_at: updated });

test('a full mega-ZIP writes export-manifest.json and records what it exported', async () => {
  const list = [listed('a', '2026-01-01T00:00:00Z'), listed('b', '2026-01-02T00:00:00Z')];
  const chats = { a: chatFor('a', '2026-01-01T00:00:00Z'), b: chatFor('b', '2026-01-02T00:00:00Z') };
  const { store, saved, zip } = await runBulkZip({ list, chats });
  assert.match(saved.name, /^claude-takeout-\d{4}-\d{2}-\d{2}_\d{4}\.zip$/);
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
  assert.match(saved.name, /^claude-takeout-changes-\d{4}-\d{2}-\d{2}_\d{4}\.zip$/);
  const manifest = JSON.parse(await zip.file('export-manifest.json').async('string'));
  assert.deepStrictEqual([manifest.kind, manifest.since, manifest.chats.map((c) => c.uuid)], ['changes', '2026-01-05T00:00:00Z', ['b', 'c']]);
  assert.ok(!zip.file('Chat_a/README.md') && zip.file('Chat_b/README.md') && zip.file('Chat_c/README.md'));
  assert.match((await zip.file('index.md').async('string')).replace(/^﻿/, ''), /^# Claude Takeout - Changes since /);
  assert.deepStrictEqual(store.exportRecord['org-1'].chats, { a: '2026-01-01T00:00:00Z', b: '2026-01-09T00:00:00Z', c: '2026-01-08T00:00:00Z' });

  const again = await runBulkZip({ list, chats, stored: store, options: { changesOnly: true } });
  assert.strictEqual(again.saved, null, 'nothing to download');
  assert.match(again.result.notes.join(' '), /Nothing changed since/);
});

test('Export changes with no record exports everything and says why', async () => {
  const list = [listed('a', '2026-01-01T00:00:00Z')];
  const { saved, zip, result } = await runBulkZip({ list, chats: { a: chatFor('a', '2026-01-01T00:00:00Z') }, options: { changesOnly: true } });
  assert.ok(saved);
  assert.strictEqual(JSON.parse(await zip.file('export-manifest.json').async('string')).kind, 'full');
  assert.match(result.notes.join(' '), /no earlier export/i);
});

test('the Mega-Zip exports setting defaults to all chats, and "only new or changed" makes Export All export changes', async () => {
  const fs = require('fs');
  const stored = { exportRecord: { 'org-1': { at: '2026-01-05T00:00:00Z', chats: { a: '2026-01-01T00:00:00Z' } } } };
  const list = [listed('a', '2026-01-01T00:00:00Z'), listed('b', '2026-01-09T00:00:00Z')];
  const chats = { a: chatFor('a', '2026-01-01T00:00:00Z'), b: chatFor('b', '2026-01-09T00:00:00Z') };
  assert.strictEqual(vm.runInContext('defaultSettings.megaZipScope', exportPopup().sandbox), 'all');
  const all = await runBulkZip({ list, chats, stored });
  assert.strictEqual(JSON.parse(await all.zip.file('export-manifest.json').async('string')).kind, 'full');
  const changes = await runBulkZip({ list, chats, stored, setup: (sb) => vm.runInContext("settings.megaZipScope = 'changes'", sb) });
  const manifest = JSON.parse(await changes.zip.file('export-manifest.json').async('string'));
  assert.deepStrictEqual([manifest.kind, manifest.chats.map((c) => c.uuid)], ['changes', ['b']]);
  for (const page of ['popup.html', 'sidepanel.html']) {
    const html = fs.readFileSync(path.join(REPO, page), 'utf8');
    assert.ok(!html.includes('exportChangesZip'), `${page}: no separate Export Changes button`);
    assert.match(html, /<button id="scopeAll"[^>]*aria-pressed="true">All<\/button>\s*<button id="scopeChanges"/, `${page}: All comes first and is pressed`);
  }
});

test('the mega-ZIP name carries the account display name, cleaned for a file name', async () => {
  const megaZipName = vm.runInContext('megaZipName', exportPopup().sandbox);
  assert.strictEqual(megaZipName('Mika', 'full', '2026-11-09'), 'claude-takeout-mika-2026-11-09.zip');
  assert.strictEqual(megaZipName('Mika Example', 'changes', '2026-11-09'), 'claude-takeout-mika_example-changes-2026-11-09.zip');
  assert.strictEqual(megaZipName('../José/ <X>', 'full', '2026-11-09'), 'claude-takeout-josé_x-2026-11-09.zip');
  const stamp = vm.runInContext('exportStamp', exportPopup().sandbox);
  assert.strictEqual(stamp(new Date(2026, 10, 5, 9, 7)), '2026-11-05_0907');
  assert.strictEqual(megaZipName('', 'full', '2026-11-09'), 'claude-takeout-2026-11-09.zip');
  assert.strictEqual(megaZipName('***', 'full', '2026-11-09'), 'claude-takeout-2026-11-09.zip');
  assert.strictEqual(megaZipName(null, 'changes', '2026-11-09'), 'claude-takeout-changes-2026-11-09.zip');
  assert.strictEqual(megaZipName('x'.repeat(80), 'full', 'd').length, 'claude-takeout--d.zip'.length + 40);
  const list = [listed('a', '2026-01-01T00:00:00Z')];
  const { saved } = await runBulkZip({ list, chats: { a: chatFor('a', '2026-01-01T00:00:00Z') }, accountName: 'Mika' });
  assert.match(saved.name, /^claude-takeout-mika-\d{4}-\d{2}-\d{2}_\d{4}\.zip$/);
});

test('a chat that failed is not recorded, so the next Export changes tries it again', async () => {
  const list = [listed('a', '2026-01-01T00:00:00Z'), listed('b', '2026-01-02T00:00:00Z')];
  const { store } = await runBulkZip({ list, chats: { a: chatFor('a', '2026-01-01T00:00:00Z') } });
  assert.deepStrictEqual(Object.keys(store.exportRecord['org-1'].chats), ['a']);
});

// ---- Companion HTML for Claude Docs documents ----
// claude.ai draws a document's diagrams only on its own page, so the rebuilt .md shows them by caption.
// A self-contained HTML copy Claude made in the chat is linked from the document; without one, the
// document says the diagrams aren't included.
const companionChat = (...extraTurns) => {
  const t = docTools();
  return Object.assign(turns(
    [t.batch, t.batchResult, t.update('u1', 'sess.10', '## Alpha\n\nalpha text'), t.result('u1', '{}')],
    [diagramBatch('b2', 'sess.11', '## Beta\n\n<?claude block dia?>\n\nUnder the picture.'), t.result('b2', '{}')],
    ...extraTurns,
  ), { uuid: 'cc', name: 'cc' });
};
const docExport = (id, url = DOC_URL) => [
  use(id, 'mcp__Claude_Docs__export', { container: { kind: 'project', id: 'proj' }, file: 'tab-1', format: 'html' }),
  { type: 'tool_result', tool_use_id: id, name: 'mcp__Claude_Docs__export', content: [{ type: 'text', text: JSON.stringify({ verdict: 'allow', data: { format: 'html', bytes_b64: 'PGgxPng8L2gxPg==' }, frame: { url } }) }] },
];
const page = (title, h1) => `<!doctype html><html><head><title>${title}</title></head><body><h1>${h1}</h1><svg></svg></body></html>`;
const companions = (data) => {
  const index = {};
  const made = artifacts(data, null, index);
  const pathNames = {};
  for (const [key, e] of Object.entries(index)) if (!key.startsWith('doc:') && !key.startsWith('artifact:')) pathNames[key] = e.filename;
  return plain(fn('docCompanions')(data, made, index, pathNames));
};

test('an HTML file sent in the turn that exported the document is its companion', () => {
  const data = companionChat([
    ...docExport('x1'),
    use('w1', 'Write', { file_path: '/home/claude/out/notes_page.html', content: page('Something else', 'Not the title') }), result('w1'),
    use('s1', 'SendUserFile', { files: ['/home/claude/out/notes_page.html'] }),
  ]);
  assert.deepStrictEqual(companions(data), { 'doc:node-1': ['notes_page.html'] });
  // An export of another document links nothing here.
  const other = companionChat([
    ...docExport('x1', 'https://claude.ai/artifact/OTHER'),
    use('w1', 'Write', { file_path: '/home/claude/out/notes_page.html', content: page('Something else', 'Not the title') }), result('w1'),
    use('s1', 'SendUserFile', { files: ['/home/claude/out/notes_page.html'] }),
  ]);
  assert.deepStrictEqual(companions(other), {});
});

test("an HTML file whose title or first heading is the document's title is its companion", () => {
  const byH1 = companionChat([use('w1', 'Write', { file_path: '/home/claude/a/page.html', content: page('Page', 'Lorber <i>Notes</i>') }), result('w1')]);
  assert.deepStrictEqual(companions(byH1), { 'doc:node-1': ['page.html'] });
  const byTitle = companionChat([use('w1', 'Write', { file_path: '/home/claude/a/page.html', content: page('  lorber\n NOTES ', 'x') }), result('w1')]);
  assert.deepStrictEqual(companions(byTitle), { 'doc:node-1': ['page.html'] });
  const curly = docTools('mcp__Claude_Docs__', { title: "Verbeke's L'évolution" });
  const quotes = Object.assign(turns([curly.batch, curly.batchResult], [use('w1', 'Write', { file_path: '/h/v.html', content: page('V', 'Verbeke’s <i>L’évolution</i>') }), result('w1')]), { uuid: 'q', name: 'q' });
  assert.deepStrictEqual(companions(quotes), { 'doc:node-1': ['v.html'] });
  // A piece Claude put a page together from is not a copy of the document.
  const piece = companionChat([use('w1', 'Write', { file_path: '/home/claude/a/body.html', content: '</head>\n<body>\n<h1>Lorber Notes</h1>' }), result('w1')]);
  assert.deepStrictEqual(companions(piece), {});
  const unrelated = companionChat([use('w1', 'Write', { file_path: '/home/claude/a/page.html', content: page('Lorber Notes, part two', 'Lorber Notes, part two') }), result('w1')]);
  assert.deepStrictEqual(companions(unrelated), {});
});

test('a document with diagrams links its companion, or says plainly the diagrams are not included', async () => {
  const withCopy = companionChat([
    ...docExport('x1'),
    use('w1', 'Write', { file_path: '/home/claude/out/notes page.html', content: page('Other', 'Other') }), result('w1'),
    use('s1', 'SendUserFile', { files: ['/home/claude/out/notes page.html'] }),
  ]);
  const one = await runFolder(exportPopup(), withCopy);
  const md = docText(one.written, 'artefacts/Lorber_Notes.md');
  assert.match(md, /^# Lorber Notes\n\n> \*\*Diagram:\*\* .*\[notes page\.html\]\(notes%20page\.html\)/m, md);
  assert.ok(md.includes('[embedded content: How the parts fit]'), 'the caption stays where the diagram was');
  assert.ok(!String(docText(one.written, 'errors.txt') || '').includes('doc diagram'));
  assert.match(docText(one.written, 'artefacts/Lorber_Notes.html'), /notes page\.html/);
  // The versions stay as rebuilt; only the final document has the note.
  assert.ok(!docText(one.written, 'artefacts/Lorber_Notes_v2.md').includes('> **Diagram'));

  const without = await runFolder(exportPopup(), companionChat());
  const bare = docText(without.written, 'artefacts/Lorber_Notes.md');
  assert.match(bare, /^# Lorber Notes\n\n> \*\*⚠️ Diagram not included\.\*\* .*no self-contained copy.*ask Claude/m, bare);
  assert.match(docText(without.written, 'artefacts/Lorber_Notes.html'), /Diagram not included/);
  const errors = docText(without.written, 'errors.txt');
  assert.match(errors, /Type:\*\* doc diagram/);
  assert.match(errors, /self-contained HTML/);
  assert.ok(errors.includes(DOC_URL));
});

test('a document without diagrams gets no warning, and a note only when it has a companion', async () => {
  const t = docTools();
  const text = [t.batch, t.batchResult, t.update('u1', 'sess.10', 'text'), t.result('u1', '{}')];
  const none = await runFolder(exportPopup(), Object.assign(turns(text), { uuid: 'n', name: 'n' }));
  assert.ok(!docText(none.written, 'artefacts/Lorber_Notes.md').includes('> **'));
  assert.ok(!String(docText(none.written, 'errors.txt') || '').includes('doc diagram'));
  const copy = await runFolder(exportPopup(), Object.assign(turns(text, [use('w1', 'Write', { file_path: '/h/l.html', content: page('Lorber Notes', 'x') }), result('w1')]), { uuid: 'c', name: 'c' }));
  assert.match(docText(copy.written, 'artefacts/Lorber_Notes.md'), /^# Lorber Notes\n\n> \*\*Self-contained copy:\*\* .*\[l\.html\]\(l\.html\)/m);
});

// ---- claude.ai's visualize, image_search and claude-artifacts tools ----
const WIDGET = 'mcp__visualize__show_widget';
const svgWidget = (title, body = '<g class="c-teal"><rect x="1" y="1" width="9" height="9"/></g>') =>
  ({ title, widget_code: `<svg width="100%" viewBox="0 0 10 10" role="img"><title>T</title>${body}</svg>` });
const shown = (id) => ({ type: 'tool_result', tool_use_id: id, name: WIDGET, content: [{ type: 'text', text: 'Content rendered and shown to the user.' }] });

test('a show_widget diagram is saved as a styled SVG file, versioned by title, like the Python port', () => {
  const core = require('../export-core.js');
  const data = twoMessages(
    [use('w1', WIDGET, svgWidget('wiring_diagram')), shown('w1'), use('w2', WIDGET, { title: 'chart', widget_code: '<div class="x">hi</div><script>sendPrompt("a")</script>' }), shown('w2')],
    [use('w3', WIDGET, svgWidget('wiring_diagram', '<text class="th">B</text>')), shown('w3'), use('w4', WIDGET, svgWidget('failed')), result('w4', true)]);
  const index = {};
  const out = artifacts(data, null, index);
  assert.deepStrictEqual(plain(Object.keys(out).sort()), ['chart.html', 'wiring_diagram.svg', 'wiring_diagram_v1.svg', 'wiring_diagram_v2.svg']);
  assert.ok(out['wiring_diagram_v1.svg'].startsWith(`<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 10 10" role="img"><style>${core.WIDGET_CSS}</style><title>T</title>`));
  assert.ok(out['wiring_diagram.svg'].includes('<text class="th">B</text>'));
  assert.match(core.WIDGET_CSS, /\.c-teal>rect[^{]*\{fill:#E1F5EE;stroke:#0F6E56\}/);
  assert.match(core.WIDGET_CSS, /@media \(prefers-color-scheme:dark\)/);
  assert.match(out['chart.html'], /^<!DOCTYPE html>\n[\s\S]*<title>chart<\/title>[\s\S]*function sendPrompt\(\) \{\}[\s\S]*<div class="x">hi<\/div>/);
  assert.deepStrictEqual(plain(index['widget:wiring_diagram'].messages), ['a', 'b']);
  assert.deepStrictEqual(pythonArtifacts(data), plain(out));
  // Already has xmlns, no title, nothing drawn.
  const own = artifacts(oneMessage([use('w5', WIDGET, { widget_code: '<svg xmlns="http://www.w3.org/2000/svg"><g/></svg>' }), use('w6', WIDGET, { title: 'empty', widget_code: '  ' })]));
  assert.deepStrictEqual(plain(Object.keys(own)), ['diagram.svg']);
  assert.ok(own['diagram.svg'].startsWith('<svg xmlns="http://www.w3.org/2000/svg"><style>'));
});

const publishChat = () => ({
  uuid: 'c', name: 'Dimmer', current_leaf_message_uuid: 'b',
  chat_messages: [
    { uuid: 'h', parent_message_uuid: null, sender: 'human', content: [{ type: 'text', text: 'help' }],
      files_v2: [{ success: true, file_name: 'IMG_1.HEIC', file_uuid: 'up-1', file_kind: 'blob' }] },
    { uuid: 'a', parent_message_uuid: 'h', sender: 'assistant', content: [
      use('r1', 'mcp__visualize__read_me', { modules: ['diagram'] }),
      { type: 'tool_result', tool_use_id: 'r1', name: 'mcp__visualize__read_me', content: [{ type: 'text', text: 'SECRET GUIDE TEXT' }] },
      use('w1', WIDGET, svgWidget('wiring (main)')), shown('w1'),
      use('i1', 'image_search', { query: 'green ground screw', max_results: 2 }),
      { type: 'tool_result', tool_use_id: 'i1', name: 'image_search', content: [{ type: 'text', text: 'Found and displayed 2 images' },
        { images: [{ id: 'img_1', url: 'https://img.example/a b.jpg', title: 'Screw [green]', source: 'example.com', page_url: 'https://example.com/p(1)' },
          { id: 'img_2', url: 'https://img.example/c.jpg', title: 'Pigtail' }] }] },
      { type: 'text', text: 'Here is the diagram.' },
    ] },
    { uuid: 'b', parent_message_uuid: 'a', sender: 'assistant', content: [
      use('wr', 'Write', { file_path: '/home/claude/guide.html', content: '<html>guide</html>' }), result('wr'),
      use('p1', 'mcp__claude-artifacts__publish_files', { files: [{ as: 'index.html', path: '/home/claude/guide.html' }], title: 'Dimmer swap' }),
      { type: 'tool_result', tool_use_id: 'p1', name: 'mcp__claude-artifacts__publish_files', content: [{ type: 'text', text: JSON.stringify({ title: 'Dimmer swap', url: 'https://claude.ai/artifact/XYZ' }) }] },
      { type: 'text', text: 'Published the guide.' },
    ], files_v2: [
      { success: true, file_name: 'guide.html', file_uuid: 'att-1', file_kind: 'blob' },
      { success: true, file_name: 'extra.pdf', file_uuid: 'att-2', file_kind: 'blob' },
    ] },
  ],
});

test("files on Claude's own messages are its output, not uploads", () => {
  const data = publishChat();
  assert.deepStrictEqual(plain(fn('extractUploadedFiles')(data).map((f) => f.filename)), ['p01_IMG_1.HEIC']);
  assert.deepStrictEqual(plain(fn('extractAttachedFiles')(data, ['guide.html', 'extra.pdf'])), [
    { filename: 'guide.html', uuid: 'att-1', path: '', existing: true, messageUuid: 'b' },
    { filename: 'extra.pdf', uuid: 'att-2', path: '', existing: true, messageUuid: 'b' },
  ]);
  assert.deepStrictEqual(plain(fn('extractAttachedFiles')(data, ['guide.html']).map((f) => [f.filename, f.existing])), [['guide.html', true], ['extra.pdf', false]]);
});

test('diagrams, image searches and published pages read well in the Markdown and the ZIP', async () => {
  const md = fn('convertToMarkdown')(publishChat(), { embedArtifacts: false });
  assert.ok(!md.includes('SECRET GUIDE TEXT'));
  assert.ok(md.includes('Loading tool guidance: mcp__visualize__read_me'));
  assert.ok(md.includes('Diagram: wiring (main) (drawn in the chat on claude.ai)'));
  assert.ok(!md.includes('Content rendered and shown'));
  assert.ok(md.includes('Image search: green ground screw'));
  assert.ok(md.includes('> Found and displayed 2 images\n>\n> 1. [Screw \\[green\\]](https://example.com/p%281%29) (example.com) · [image](https://img.example/a%20b.jpg)'));
  assert.ok(md.includes('> 2. Pigtail · [image](https://img.example/c.jpg)'));
  assert.ok(md.includes('Publishing on claude.ai: Dimmer swap (guide.html)'));
  assert.ok(md.includes('> **Published on claude.ai:** [Dimmer swap](https://claude.ai/artifact/XYZ)'));
  assert.ok(!md.includes('"images"'));

  const { written, chat } = await runFolder(exportPopup(), publishChat());
  const text = (name) => { const v = written[name]; return typeof v === 'string' ? v.replace(/^﻿/, '') : v && v.content; };
  assert.ok(String(text('artefacts/wiring_main.svg')).startsWith('<svg xmlns='));
  const full = text('full_chat.md');
  assert.ok(full.includes('**Diagram: wiring (main)** - [artefacts/wiring_main.svg](artefacts/wiring_main.svg)'));
  assert.ok(full.includes('![wiring (main)](artefacts/wiring_main.svg)'));
  const response = Object.keys(written).find((n) => /^responses\/001_.*\.full\.md$/.test(n));
  assert.ok(text(response).includes('![wiring (main)](../artefacts/wiring_main.svg)'));
  assert.ok(text(response).includes('> 1. [Screw'));
  // The guide is the replayed artefact; only the PDF is downloaded, into artefacts/. Nothing of Claude's is in uploads/.
  assert.deepStrictEqual(Object.keys(written).filter((n) => n.startsWith('uploads/')), ['uploads/p01_IMG_1.HEIC']);
  assert.ok(written['artefacts/extra.pdf']);
  assert.ok(!Object.keys(written).some((n) => /guide_2|extra_2/.test(n)));
  const b = chat.messages.find((m) => m.id === 'b');
  assert.deepStrictEqual(plain(b.uploads.map((u) => [u.name, u.href])), [['guide.html', 'artefacts/guide.html'], ['extra.pdf', 'artefacts/extra.pdf']]);
  const a = chat.messages.find((m) => m.id === 'a');
  assert.ok(a.blocks.some((blk) => blk.t === 'card' && chat.files[blk.file].name === 'wiring_main.svg'));
});

// ---- images from web searches ----
const imgResult = (id, images) => ({ type: 'tool_result', tool_use_id: id, name: 'image_search', content: [{ type: 'text', text: `Found and displayed ${images.length} images` }, { images }] });
const webChat = () => ({
  uuid: 'c', name: 'Screws', current_leaf_message_uuid: 'a',
  chat_messages: [{ uuid: 'a', parent_message_uuid: null, sender: 'assistant', content: [
    use('i1', 'image_search', { query: 'screw' }),
    imgResult('i1', [
      { url: 'https://img.example/a.jpg', thumbnail_url: 'https://img.example/a.jpg', title: 'Green screw', source: 'example.com', page_url: 'https://example.com/a' },
      { url: 'https://img.example/gone.jpg', thumbnail_url: 'https://thumbs.example/gone.png', title: 'Pigtail' },
      { url: 'https://img.example/refused.jpg', title: 'Refused' },
      { url: 'http://img.example/plain.jpg', title: 'Plain http' },
    ]),
    use('i2', 'image_search', { query: 'screw again' }),
    imgResult('i2', [{ url: 'https://img.example/a.jpg', title: 'Green screw' }]),
    { type: 'text', text: 'Done.' },
  ] }],
});
const imageRoutes = [
  [/img\.example\/a\.jpg$/, () => ({ ok: true, status: 200, headers: { get: () => 'image/jpeg' }, blob: async () => ({ size: 3, type: 'image/jpeg', marker: 'jpg' }) })],
  [/img\.example\/gone\.jpg$/, () => ({ ok: false, status: 404 })],
  [/thumbs\.example\/gone\.png$/, () => ({ ok: true, status: 200, headers: { get: () => 'image/png; charset=binary' }, blob: async () => ({ size: 3, type: 'image/png', marker: 'png' }) })],
  [/img\.example\/refused\.jpg$/, () => ({ ok: true, status: 200, headers: { get: () => 'text/html' }, blob: async () => ({ size: 3, type: 'text/html' }) })],
];

test('web search images: listed once per https URL, named by a hash of the URL', () => {
  const core = require('../export-core.js');
  const list = core.webImagesOf(webChat());
  assert.deepStrictEqual(list.map((i) => i.url), ['https://img.example/a.jpg', 'https://img.example/gone.jpg', 'https://img.example/refused.jpg']);
  assert.match(list[0].key, /^[0-9a-f]{8}$/);
  assert.strictEqual(list[0].key, core.webImageKey('https://img.example/a.jpg'));
  assert.strictEqual(core.webImageName(list[0], '.jpg'), `${list[0].key}_Green_screw.jpg`);
  assert.strictEqual(core.webImageName({ key: 'k', title: '' }, '.png'), 'k.png');
});

test('web search images are saved in images/ when Chrome allows it, and shown in the Markdown and viewer', async () => {
  const core = require('../export-core.js');
  const [a, gone] = core.webImagesOf(webChat());
  const popup = exportPopup({ routes: imageRoutes });
  popup.sandbox.chrome.permissions = { contains: async () => true };
  const { written, chat } = await runFolder(popup, webChat());
  const aName = `images/${a.key}_Green_screw.jpg`;
  const goneName = `images/${gone.key}_Pigtail.png`;
  assert.deepStrictEqual(Object.keys(written).filter((n) => n.startsWith('images/')).sort(), [aName, goneName].sort());
  const full = docText(written, 'full_chat.md');
  assert.ok(full.includes(`>    ![Green screw](${aName})`), full);
  assert.ok(full.includes(`>    ![Pigtail](${goneName})`));
  assert.ok(!full.includes('![Refused]'));
  const response = Object.keys(written).find((n) => /^responses\/001_.*\.full\.md$/.test(n));
  assert.ok(docText(written, response).includes(`![Green screw](../${aName})`));
  const errors = docText(written, 'errors.txt');
  assert.match(errors, /Refused[\s\S]*not a PNG, JPEG, GIF or WebP image \(text\/html\)/);
  assert.ok(!/Pigtail/.test(errors));
  const tool = chat.messages[0].blocks.find((b) => b.t === 'tool' && b.web);
  assert.deepStrictEqual(plain(tool.web.map((w) => [w.title, w.href])), [['Green screw', aName], ['Pigtail', goneName], ['Refused', null], ['Plain http', null]]);
  assert.strictEqual(tool.web[0].page, 'https://example.com/a');
});

test('without the permission, web images are links and errors.txt says how to save them', async () => {
  const { written, chat } = await runFolder(exportPopup({ routes: imageRoutes }), webChat());
  assert.ok(!Object.keys(written).some((n) => n.startsWith('images/')));
  assert.match(docText(written, 'errors.txt'), /3 images from web searches were not saved[\s\S]*Save web images and artifact card pictures/);
  assert.ok(docText(written, 'full_chat.md').includes('> 1. [Green screw](https://example.com/a) (example.com) · [image](https://img.example/a.jpg)'));
  assert.ok(chat.messages[0].blocks.find((b) => b.t === 'tool' && b.web).web.every((w) => w.href === null));
});

// ---- images Claude viewed (tool results that only link a claude.ai file) ----
const readChat = () => ({
  uuid: 'c', name: 'Photos', current_leaf_message_uuid: 'a',
  chat_messages: [{ uuid: 'a', parent_message_uuid: null, sender: 'assistant', content: [
    use('r1', 'Read', { file_path: '/home/claude/imgs/IMG_1.jpg' }),
    { type: 'tool_result', tool_use_id: 'r1', name: 'Read', content: [{ type: 'image', file_uuid: '9eefb337-7e86-5109-9c68-3e6995e5294f', preview_url: '/api/org/files/9eefb337-7e86-5109-9c68-3e6995e5294f/preview' }] },
    use('r2', 'Read', { file_path: '/home/claude/imgs/IMG_2.jpg' }),
    { type: 'tool_result', tool_use_id: 'r2', name: 'Read', content: [{ type: 'image', file_uuid: 'aaaabbbb-0000-4000-8000-000000000000', preview_url: '/api/org/files/aaaabbbb-0000-4000-8000-000000000000/preview' }] },
    { type: 'tool_result', tool_use_id: 'x', name: 'Read', content: [{ type: 'image', file_uuid: 'cccc', preview_url: 'https://evil.example/x' }] },
    { type: 'text', text: 'Nice photos.' },
  ] }],
});

test('images Claude viewed are listed once each, from claude.ai preview paths only', () => {
  const core = require('../export-core.js');
  const list = core.toolImagesOf(readChat());
  assert.deepStrictEqual(list.map((i) => [i.uuid.slice(0, 8), i.base]), [['9eefb337', 'IMG_1'], ['aaaabbbb', 'IMG_2']]);
  assert.strictEqual(core.toolImageName(list[0], '.jpg'), '9eefb337_IMG_1.jpg');
});

test('images Claude viewed are downloaded from claude.ai into images/ and shown in the Markdown and viewer', async () => {
  const popup = exportPopup({ routes: [
    [/9eefb337-[\w-]+\/preview$/, () => ({ ok: true, status: 200, headers: { get: () => 'image/jpeg' }, blob: async () => ({ size: 3, type: 'image/jpeg', marker: 'jpg' }) })],
    [/aaaabbbb-[\w-]+\/preview$/, () => ({ ok: false, status: 404 })],
  ] });
  const { written, chat } = await runFolder(popup, readChat());
  assert.deepStrictEqual(Object.keys(written).filter((n) => n.startsWith('images/')), ['images/9eefb337_IMG_1.jpg']);
  assert.ok(docText(written, 'full_chat.md').includes('![9eefb337_IMG_1.jpg](images/9eefb337_IMG_1.jpg)'));
  assert.match(docText(written, 'errors.txt'), /IMG_2[\s\S]*Image Claude viewed not saved: HTTP 404/);
  const tools = chat.messages[0].blocks.filter((b) => b.t === 'tool');
  assert.deepStrictEqual(plain(tools.map((t) => [t.label, t.target, t.images, t.missingImages])), [['Read IMG_1.jpg', 'IMG_1.jpg', ['images/9eefb337_IMG_1.jpg'], 0], ['Read IMG_2.jpg', 'IMG_2.jpg', [], 1]]);
});

// ---- Export All into a folder ----

test('the disk folder writes what the export writes, in order per path, and reports names it refuses', async () => {
  const popup = exportPopup();
  const root = new FakeDir('run', (name) => name.includes(':'));
  popup.sandbox.__root = root;
  const failed = await vm.runInContext(`(async () => {
    const f = createDiskFolder(__root);
    f.file('a.txt', 'one');
    f.folder('chat').file('artefacts/x.md', 'first');
    f.folder('chat').file('artefacts/x.md', 'second');
    f.file('gif', 'R0lGOA==', { base64: true });
    f.file('bad:name.txt', 'no');
    return f.flush();
  })()`, popup.sandbox);
  const files = root.flat();
  assert.strictEqual(files['a.txt'], 'one');
  assert.strictEqual(files['chat/artefacts/x.md'], 'second');
  assert.deepStrictEqual(Array.from(files.gif), [0x52, 0x30, 0x6c, 0x47, 0x4f, 0x41].slice(0, 0).concat(Array.from(Buffer.from('R0lGOA==', 'base64'))));
  assert.deepStrictEqual(plain(failed.map((f) => f.path)), ['bad:name.txt']);
});

test('Export All into a folder writes the same files as the mega-ZIP, in a new folder named like it', async () => {
  const list = [listed('a', '2026-01-01T00:00:00Z'), listed('b', '2026-01-02T00:00:00Z')];
  const chats = { a: chatFor('a', '2026-01-01T00:00:00Z'), b: chatFor('b', '2026-01-02T00:00:00Z') };
  const zipped = await runBulkZip({ list, chats, accountName: 'Mika' });
  const picked = new FakeDir();
  const stampNow = vm.runInContext('exportStamp()', exportPopup().sandbox);
  await picked.getDirectoryHandle(`claude-takeout-mika-${stampNow}`, { create: true });  // an earlier run that minute
  const disk = await runBulkZip({ list, chats, accountName: 'Mika', options: { directory: picked } });
  assert.strictEqual(disk.saved, null, 'no download');
  const runName = `claude-takeout-mika-${stampNow}_2`;
  assert.ok(picked.entries.has(runName), [...picked.entries.keys()].join());
  const onDisk = Object.keys(picked.entries.get(runName).flat()).sort();
  const inZip = Object.keys(zipped.zip.files).filter((n) => !zipped.zip.files[n].dir).sort();
  assert.deepStrictEqual(onDisk, inZip);
  assert.deepStrictEqual([disk.result.outcome, disk.result.target, disk.result.saved.chats], ['done', { kind: 'folder', name: runName }, 2]);
  assert.deepStrictEqual(Object.keys(disk.store.exportRecord['org-1'].chats).sort(), ['a', 'b']);
});

test('a file the folder refuses is listed in write-errors.txt; the rest of the chat is saved', async () => {
  const list = [listed('a', '2026-01-01T00:00:00Z')];
  const chat = chatFor('a', '2026-01-01T00:00:00Z');
  chat.chat_messages.push({ uuid: 'm2', parent_message_uuid: chat.chat_messages[0].uuid, sender: 'assistant', content: [
    { type: 'tool_use', id: 't1', name: 'create_file', input: { path: '/home/claude/re:port.md', file_text: '# r' } }, { type: 'text', text: 'ok' }] });
  chat.current_leaf_message_uuid = 'm2';
  const picked = new FakeDir('picked', (name) => name.includes(':'));
  const disk = await runBulkZip({ list, chats: { a: chat }, options: { directory: picked } });
  const run = [...picked.entries.values()][0];
  const files = run.flat();
  assert.match(files['write-errors.txt'], /\/artefacts\/re:port\.md: Name is not allowed/);
  assert.ok(Object.keys(files).some((n) => /\/full_chat\.md$/.test(n)) && files['index.md'], Object.keys(files).join());
  assert.strictEqual(disk.result.outcome, 'done');
  assert.deepStrictEqual(disk.result.warningList.filter((w) => w.type === 'write').length, 1);
  assert.ok(disk.result.errorFiles.includes('write-errors.txt'));
});

test('a project document made from a PDF is saved as text with .txt, so it opens', async () => {
  const data = Object.assign(oneMessage([{ type: 'text', text: 'hi' }]), { uuid: 'c1', name: 'n', project_uuid: 'P' });
  const routes = [...projectResponses().filter(([re]) => !/docs\$/.test(re.source)),
    [/\/projects\/P\/docs$/, () => ({ ok: true, status: 200, json: async () => [
      { uuid: 'd1', file_name: 'Noack_Papers/Das_Mandala.pdf', content: 'Studiengang MAS Spiritualität' },
      { uuid: 'd2', file_name: 'Notes', content: 'plain notes' },
      { uuid: 'd3', file_name: 'Brief.md', content: 'be kind' },
    ] })]];
  const { written, chat } = await runFolder(exportPopup({ routes }), data);
  const names = Object.keys(written).filter((n) => /^project\/(?!project\.json|docs\.json|files)/.test(n)).sort();
  assert.deepStrictEqual(names, ['project/Brief.md', 'project/Noack_Papers_Das_Mandala.pdf.txt', 'project/Notes.txt']);
  assert.ok(docText(written, 'project/Noack_Papers_Das_Mandala.pdf.txt').includes('Studiengang'));
  assert.deepStrictEqual(plain(Array.from(chat.project.docs, (d) => d.name)).sort(), ['Brief.md', 'Noack_Papers_Das_Mandala.pdf.txt', 'Notes.txt']);
});

// ---- claude.ai's product cards, comparisons and questions ----
const displayChat = () => ({
  uuid: 'c', name: 'Headphones', current_leaf_message_uuid: 'a',
  chat_messages: [{ uuid: 'a', parent_message_uuid: null, sender: 'assistant', content: [
    use('p1', 'product_carousel_display_v0', { products: [{ name: 'HD 560S', price: '~$180', blurb: 'Neutral | detailed.' }, { name: 'HE400se', price: '~$150', blurb: 'Planar.' }] }),
    { type: 'tool_result', tool_use_id: 'p1', name: 'product_carousel_display_v0', content: [{ type: 'text', text: '{}' }, { images: [
      { id: 'product_0_0', url: 'https://img.example/560.jpg', title: '560S', source: 'head-fi' }, { id: 'product_1_0', url: 'https://img.example/400.jpg', title: '400se' }] }] },
    use('k1', 'comparison_card_display_v0', { products: [
      { name: 'HD 559', price: '$149', attributes: [{ label: 'Design', value: 'Open-back' }, { label: 'Mic', value: 'No' }] },
      { name: 'HD 569', price: '$179', attributes: [{ label: 'Design', value: 'Closed-back' }, { label: 'Mic', value: 'Yes' }] }] }),
    { type: 'tool_result', tool_use_id: 'k1', name: 'comparison_card_display_v0', content: [{ type: 'text', text: '{}' }] },
    use('q1', 'ask_user_input_v0', { questions: [{ type: 'single_select', question: 'Need a mic?', options: ['Yes', 'No'] }] }),
    { type: 'tool_result', tool_use_id: 'q1', name: 'ask_user_input_v0', content: [{ type: 'text', text: '{"questions": []}' }] },
    { type: 'text', text: 'Done.' },
  ] }],
});

test('product cards, comparisons and questions read as Markdown, and product images are web images', async () => {
  const core = require('../export-core.js');
  assert.deepStrictEqual(core.webImagesOf(displayChat()).map((i) => i.url), ['https://img.example/560.jpg', 'https://img.example/400.jpg']);
  const md = fn('convertToMarkdown')(displayChat(), {});
  assert.ok(md.includes('#### HD 560S (~$180)\n\nNeutral | detailed.'));
  assert.ok(md.includes('| | **HD 559** ($149) | **HD 569** ($179) |\n|---|---|---|\n| Design | Open-back | Closed-back |\n| Mic | No | Yes |'));
  assert.ok(md.includes('**Need a mic?**\n\n- Yes\n- No'));
  assert.ok(!md.includes('"products"') && !md.includes('{"questions"'));
  const popup = exportPopup({ routes: [[/img\.example/, () => ({ ok: true, status: 200, headers: { get: () => 'image/jpeg' }, blob: async () => ({ size: 3, type: 'image/jpeg', marker: 'jpg' }) })]] });
  popup.sandbox.chrome.permissions = { contains: async () => true };
  const { written, chat } = await runFolder(popup, displayChat());
  assert.match(docText(written, 'full_chat.md'), /#### HD 560S \(~\$180\)\n\nNeutral \| detailed\.\n\n!\[HD 560S\]\(images\/[0-9a-f]{8}_560S\.jpg\)/);
  const carousel = chat.messages[0].blocks.find((b) => b.t === 'tool' && b.display && b.display.kind === 'carousel');
  assert.deepStrictEqual(plain(carousel.display.products.map((p) => [p.name, p.images.map((i) => /^images\//.test(i.href))])), [['HD 560S', [true]], ['HE400se', [true]]]);
});

const core = require('../export-core.js');
const pubResult = (id, body, isError) => ({ type: 'tool_result', tool_use_id: id, is_error: !!isError, content: [{ type: 'text', text: typeof body === 'string' ? body : JSON.stringify(body) }] });
const PUB = 'mcp__claude-artifacts__publish_files';
const PUB_U = '0a1b2c3d-1111-4222-8333-444455556666';

test('publishedPagesOf lists each page version once with every message that published it', () => {
  const files = [{ as: 'index.html', path: '/home/claude/guide.html' }];
  const data = { chat_messages: [
    { uuid: 'm1', sender: 'assistant', content: [use('p1', PUB, { files }), pubResult('p1', { slug: PUB_U, version: 'v1', url: 'https://claude.ai/artifact/x', title: 'T1' })] },
    { uuid: 'm2', sender: 'assistant', content: [use('p2', PUB, { files }), pubResult('p2', { slug: PUB_U, version: 'v2', title: 'T2' })] },
    { uuid: 'm3', sender: 'assistant', content: [use('p3', PUB, { files }), pubResult('p3', { slug: PUB_U, version: 'v2', title: 'T2' }),
      use('p4', PUB, { files }), pubResult('p4', { slug: PUB_U, version: 'v3' }, true),
      use('p5', PUB, { files }), pubResult('p5', 'not json at all')] },
  ] };
  const pages = plain(core.publishedPagesOf(data));
  assert.deepStrictEqual(pages.map((p) => [p.uuid, p.ver, p.publishes.length]), [[PUB_U, 'v1', 1], [PUB_U, 'v2', 2]]);
  assert.deepStrictEqual(pages[0].sources, files);
  assert.deepStrictEqual(pages[1].publishes.map((p) => p.messageUuid), ['m2', 'm3']);
  assert.strictEqual(pages[1].publishes[0].toolUseId, 'p2');
  assert.strictEqual(pages[0].current, false);
  assert.ok(core.isPublishTool('publish_files') && !core.isPublishTool('xpublish_files'));
});

test('an old publish result with only a url gets the current version', () => {
  const data = oneMessage([use('p1', PUB, { files: [] }), pubResult('p1', { url: 'https://claude.ai/artifact/LkJGYP3ZBnSGbvhLfeWAG1', title: 'T' })]);
  const pages = plain(core.publishedPagesOf(data));
  assert.strictEqual(pages.length, 1);
  assert.strictEqual(pages[0].uuid, '9fe94226-9819-4551-8836-a76d0c116102');
  assert.strictEqual(pages[0].ver, '');
  assert.strictEqual(pages[0].current, true);
  assert.strictEqual(core.base58ToUuid('LkJGYP3ZBnSGbvhLfeWAG1'), '9fe94226-9819-4551-8836-a76d0c116102');
});

test('uuidToBase58 round-trips with base58ToUuid', () => {
  assert.strictEqual(core.uuidToBase58('9fe94226-9819-4551-8836-a76d0c116102'), 'LkJGYP3ZBnSGbvhLfeWAG1');
  // Ids under 21 characters (uuids starting with zero bytes) are for naming only and don't decode.
  const cases = ['9fe94226-9819-4551-8836-a76d0c116102', '01234567-89ab-4def-8123-456789abcdef', 'ffffffff-ffff-4fff-bfff-ffffffffffff',
    '0a1b2c3d-0000-4000-8000-000000000000', '00177014-c0ba-4e75-bda0-d80b0b12d936', '00000000-0000-4000-8000-000000000001'];
  const lengths = [];
  for (const u of cases) {
    const id = core.uuidToBase58(u);
    lengths.push(id.length);
    assert.strictEqual(core.base58ToUuid(id), id.length >= 21 ? u : '', u);
  }
  assert.ok(lengths.includes(22) && lengths.includes(21) && lengths.some((n) => n < 21));
  assert.strictEqual(core.base58ToUuid(core.uuidToBase58('00000000-0000-4000-8000-000000000001')), '');
  assert.strictEqual(core.uuidToBase58('x'), '');
});

test('uuidToBase58 keeps leading zero bytes unpadded', () => {
  const u = '00ffffff-ffff-4fff-8fff-ffffffffffff';
  const id = core.uuidToBase58(u);
  assert.ok(!id.startsWith('1'));
  assert.strictEqual(core.base58ToUuid(id), u);
});

test('artifactsFromList keeps only the safe fields', () => {
  const good = { slug: PUB_U, title: 'T', typeSlug: 'ts', typeTitle: 'Tt', sourceSurface: 'chat', rel: 'mine', live: 'v1', updatedAt: 'u', createdAt: 'c',
    owner_email: 'a@b.c', thumbImgURL: 'https://x/y.png', link: 'https://claude.ai/z' };
  const r = plain(core.artifactsFromList({ frames: [good, { ...good }, { ...good, slug: '../x' }, { ...good, slug: PUB_U.replace('0a1b', '0a1c'), live: '../v' }] }));
  assert.strictEqual(r.artifacts.length, 2);
  assert.ok(!('full' in r), 'no round-number guess');
  assert.strictEqual(r.artifacts[1].live, '');
  assert.deepStrictEqual(Object.keys(r.artifacts[0]).sort(), ['createdAt', 'live', 'public', 'rel', 'slug', 'sourceSurface', 'title', 'typeSlug', 'typeTitle', 'updatedAt']);
  assert.ok(!JSON.stringify(r).includes('a@b.c') && !JSON.stringify(r).includes('http'));
  const paged = (v) => core.artifactsFromList({ frames: [{ ...good, paged: v }] }).artifacts[0];
  assert.strictEqual(paged(true).paged, true);
  for (const v of [false, 'true', 1, undefined]) assert.ok(!('paged' in paged(v)), String(v));
  assert.deepStrictEqual(plain(core.artifactsFromList({})), { artifacts: [], listed: 0, paging: null });
});

test('artifactsFromList keeps how claude.ai\'s full list was paged, as plain values', () => {
  const pg = (paging) => plain(core.artifactsFromList({ frames: [], paging }).paging);
  assert.deepStrictEqual(pg({ status: 'ok', added: 2 }), { status: 'ok', added: 2 });
  assert.deepStrictEqual(pg({ status: 'capped', added: 0 }), { status: 'capped', added: 0 });
  assert.deepStrictEqual(pg({ status: 'failed', code: 'HTTP 500' }), { status: 'failed', code: 'HTTP 500' });
  assert.deepStrictEqual(pg({ status: 'failed', code: 'repeated page' }), { status: 'failed', code: 'repeated page' });
  assert.deepStrictEqual(pg({ status: 'failed', code: 'see https://x/?__frame_t=t' }), { status: 'failed', code: 'unknown' });
  assert.deepStrictEqual(pg({ status: 'failed', code: 'x'.repeat(41) }), { status: 'failed', code: 'unknown' });
  assert.deepStrictEqual(pg({ status: 'failed' }), { status: 'failed', code: 'unknown' });
  assert.deepStrictEqual(pg({ status: 'ok', added: -1 }), { status: 'ok', added: 0 });
  assert.deepStrictEqual(pg({ status: 'ok', added: 1.5 }), { status: 'ok', added: 0 });
  assert.deepStrictEqual(pg({ status: 'ok', added: 3, url: 'https://x' }), { status: 'ok', added: 3 });
  for (const bad of [undefined, null, 'ok', {}, { status: 'done' }]) assert.strictEqual(pg(bad), null, JSON.stringify(bad));
});

test('artifactsFromList keeps public as a boolean', () => {
  const pub = (v) => core.artifactsFromList({ frames: [{ slug: PUB_U, public: v }] }).artifacts[0].public;
  assert.strictEqual(pub(true), true);
  for (const v of [false, undefined, 'true', 1, null]) assert.strictEqual(pub(v), false, String(v));
  assert.ok(!('audience' in core.artifactsFromList({ frames: [{ slug: PUB_U, audience: 'public' }] }).artifacts[0]));
});

test('bad ids and versions are dropped', () => {
  const data = oneMessage([
    use('p1', PUB, { files: [] }), pubResult('p1', { slug: '../x', version: 'v1' }),
    use('p2', PUB, { files: [] }), pubResult('p2', { slug: PUB_U, version: '../../a' }),
  ]);
  assert.deepStrictEqual(plain(core.publishedPagesOf(data)), []);
  assert.deepStrictEqual(plain(core.publishedPagesOf(publishChat())), []);
  assert.strictEqual(core.base58ToUuid('XYZ'), '');
  assert.strictEqual(core.base58ToUuid('0OIl0OIl0OIl0OIl0OIl0O'), '');
});

test('a publish result in a later message still pairs with its tool_use', () => {
  const data = { chat_messages: [
    { uuid: 'm1', sender: 'assistant', content: [use('p1', PUB, { files: [] })] },
    { uuid: 'm2', sender: 'human', content: [pubResult('p1', { slug: PUB_U, version: 'v1' })] },
  ] };
  const pages = plain(core.publishedPagesOf(data));
  assert.deepStrictEqual(pages.map((p) => [p.uuid, p.ver, p.publishes[0].messageUuid]), [[PUB_U, 'v1', 'm1']]);
});

test('page versions follow the allowed pattern', () => {
  const vers = (v) => core.publishedPagesOf(oneMessage([use('p', PUB, { files: [] }), pubResult('p', { slug: PUB_U, version: v })])).map((p) => p.ver);
  for (const ok of ['v1.2', '_a', '-b', 'a'.repeat(64)]) assert.deepStrictEqual(vers(ok), [ok]);
  for (const bad of ['a'.repeat(65), '../../a', '.a', '']) assert.deepStrictEqual(vers(bad), []);
});

// ---- published pages saved in the export ----
const PUB_U2 = '1a1b2c3d-1111-4222-8333-444455556666';
const PUB_U3 = '2a1b2c3d-1111-4222-8333-444455556666';
const PUB_U4 = '3a1b2c3d-1111-4222-8333-444455556666';
const pubOf = (uuid, version, short = 'Short1', title = 'Guide') => ({ slug: uuid, version, url: `https://claude.ai/artifact/${short}`, title });
const pubMsg = (uuid, parent, content, extra = {}) => ({ uuid, parent_message_uuid: parent, sender: 'assistant', content, ...extra });
const pubChat = (messages, extra = {}) => ({
  uuid: 'c1', name: 'Pub', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  current_leaf_message_uuid: messages[messages.length - 1].uuid, chat_messages: messages, ...extra,
});
const publish = (id, uuid, ver, files, short, title) => [use(id, PUB, { files, title: title || 'Guide' }), { ...pubResult(id, pubOf(uuid, ver, short, title)), name: PUB }];
const guideAs = [{ as: 'index.html', path: '/home/claude/guide.html' }];
const fileText = (written, k) => {
  const v = written[k];
  if (v === undefined) return undefined;
  if (ArrayBuffer.isView(v)) return Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('utf8');
  return docText(written, k);
};
const pubWarnings = (output) => output.errorCollector.warnings.filter((w) => w.type === 'published_page').map((w) => ({ ...w, message: w.error }));
const sha = (text) => require('crypto').createHash('sha256').update(Buffer.from(text)).digest('hex');

test('a published page is saved in published/ with published.json, and no frame URL reaches any file', async () => {
  const frame = 'https://u.frame.claudeusercontent.com/_f/v1/index.html?__frame_t=SECRET';
  const data = pubChat([pubMsg('a', null, [
    use('w', 'Write', { file_path: '/home/claude/guide.html', content: '<html>guide</html>' }), result('w'),
    ...publish('p1', PUB_U, 'v1', [...guideAs, { as: 'data.json', path: '/home/claude/data.json' }]),
  ])]);
  const fetcher = publishedFetcher({ [PUB_U]: { title: 'Guide', history: ['v1', frame, 7], versions: { v1: { files: {
    'index.html': '<html>guide, published</html>', 'data.json': { body: '{"a":1}', type: `application/json; x=${frame}` },
  } } } } });
  const { written, output } = await runFolder(exportPopup(), data, { fetchPublished: fetcher.fetch });
  const dir = 'published/Guide_Short1';
  assert.strictEqual(fileText(written, `${dir}/v1/index.html`), '<html>guide, published</html>');
  assert.strictEqual(fileText(written, `${dir}/v1/data.json`), '{"a":1}');
  const json = JSON.parse(fileText(written, `${dir}/published.json`));
  assert.deepStrictEqual(json, {
    format: 1, title: 'Guide', url: 'https://claude.ai/artifact/Short1', shortId: 'Short1', uuid: PUB_U,
    versions: { v1: {
      ver: 'v1', label: 'v1', order: 0, saved: true,
      files: [
        { path: 'index.html', savedAs: 'index.html', size: 29, contentType: 'text/html', sha256: sha('<html>guide, published</html>') },
        { path: 'data.json', savedAs: 'data.json', size: 7, contentType: null, sha256: sha('{"a":1}') },
      ],
      start: 'index.html', startSaved: 'index.html', incomplete: false, needsRuntime: false, missing: [],
      publishedIn: [{ chat: 'c1', messageUuid: 'a', toolUseId: 'p1', same: false, writtenAs: null }],
    } },
  });
  const [entry] = plain(output.published);
  assert.strictEqual(entry.dir, dir);
  assert.deepStrictEqual(entry.versions.map((v) => [v.ver, v.folderName, v.label, v.start, v.startSaved, v.same, v.writtenAs, v.incomplete, v.text]),
    [['v1', 'v1', 'v1', 'index.html', 'index.html', false, null, false, '<html>guide, published</html>']]);
  assert.deepStrictEqual(entry.versions[0].publishes, [{ messageUuid: 'a', toolUseId: 'p1' }]);
  assert.ok(docText(written, 'README.md').includes('## Published pages (1)'));
  assert.ok(docText(written, 'README.md').includes(`(${dir}/v1/index.html)`));
  assert.ok(docText(written, 'full_chat.md').includes(`(${dir}/v1/index.html)`));
  for (const k of Object.keys(written)) {
    const t = fileText(written, k);
    assert.ok(!/frame\.claudeusercontent\.com|__frame_t/.test(t), k);
  }
});

test('a published file with no checksum from claude.ai is saved and marked unverified', async () => {
  const data = pubChat([pubMsg('a', null, [
    use('w', 'Write', { file_path: '/home/claude/guide.html', content: 'G' }), result('w'),
    ...publish('p1', PUB_U, 'v1', [...guideAs, { as: 'data.json', path: '/home/claude/data.json' }]),
  ])]);
  const fetcher = publishedFetcher({ [PUB_U]: { title: 'Guide', history: ['v1'], versions: { v1: { files: {
    'index.html': { body: 'G', unverified: true }, 'data.json': '{"a":1}',
  } } } } });
  const { written, output } = await runFolder(exportPopup(), data, { fetchPublished: fetcher.fetch });
  const dir = 'published/Guide_Short1';
  assert.strictEqual(fileText(written, `${dir}/v1/index.html`), 'G');
  const json = JSON.parse(fileText(written, `${dir}/published.json`));
  assert.deepStrictEqual(json.versions.v1.files, [
    { path: 'index.html', savedAs: 'index.html', size: 1, contentType: 'text/html', sha256: sha('G'), verified: false },
    { path: 'data.json', savedAs: 'data.json', size: 7, contentType: 'text/html', sha256: sha('{"a":1}') },
  ]);
  assert.strictEqual(json.versions.v1.incomplete, false);
  assert.deepStrictEqual(plain(pubWarnings(output)), []);
});

test('a listed file with a size but no valid checksum is still a bad listing', async () => {
  const data = pubChat([pubMsg('a', null, [
    use('w', 'Write', { file_path: '/home/claude/guide.html', content: 'G' }), result('w'),
    ...publish('p1', PUB_U, 'v1', guideAs),
  ])]);
  const fetcher = publishedFetcher({ [PUB_U]: { title: 'Guide', history: ['v1'], versions: { v1: { files: {
    'index.html': { body: 'G', sha256: 'not-a-hash' }, 'b.html': { body: 'B', unverified: true, size: 1 },
  } } } } });
  const { written, output } = await runFolder(exportPopup(), data, { fetchPublished: fetcher.fetch });
  const json = JSON.parse(fileText(written, 'published/Guide_Short1/published.json'));
  assert.deepStrictEqual(json.versions.v1.missing, ['index.html', 'b.html']);
  assert.ok(json.versions.v1.files.every((f) => !('verified' in f)));
  assert.strictEqual(fetcher.count('publishedPageFile'), 0);
  assert.ok(pubWarnings(output).some((w) => /index\.html \(bad listing\)/.test(w.message) && /b\.html \(bad listing\)/.test(w.message)));
});

test('a page claude.ai answers with no file list is still a warning in a chat export', async () => {
  const data = pubChat([pubMsg('a', null, [
    use('w', 'Write', { file_path: '/home/claude/guide.html', content: 'G' }), result('w'),
    ...publish('p1', PUB_U, 'v1', guideAs),
  ])]);
  const fetcher = publishedFetcher({ [PUB_U]: { error: { error: 'HTTP 404', status: 404 } } });
  const { output } = await runFolder(exportPopup(), data, { fetchPublished: fetcher.fetch });
  assert.ok(pubWarnings(output).some((w) => /could not be fetched: HTTP 404/.test(w.message)));
});

test('a version identical to the text Claude wrote is not copied; one edited later is', async () => {
  const data = pubChat([
    pubMsg('m1', null, [use('w', 'Write', { file_path: '/home/claude/guide.html', content: 'G1' }), result('w'), ...publish('p1', PUB_U, 'v1', guideAs)]),
    pubMsg('m2', 'm1', [use('e', 'Edit', { file_path: '/home/claude/guide.html', old_string: 'G1', new_string: 'G2' }), result('e'), ...publish('p2', PUB_U, 'v2', guideAs)]),
    pubMsg('m3', 'm2', [use('o', 'Write', { file_path: '/home/claude/other.txt', content: 'x' }), result('o'), ...publish('p3', PUB_U, 'v3', guideAs)]),
  ]);
  const fetcher = publishedFetcher({ [PUB_U]: { title: 'Guide', history: ['v1', 'v2', 'v3'], versions: {
    v1: { files: { 'index.html': 'G1' } }, v2: { files: { 'index.html': 'G2' } }, v3: { files: { 'index.html': 'G3, the page\'s own change' } },
  } } });
  const { written, output } = await runFolder(exportPopup(), data, { fetchPublished: fetcher.fetch });
  const versions = plain(output.published[0].versions);
  assert.deepStrictEqual(versions.map((v) => [v.label, v.order, v.same, v.writtenAs, v.text]),
    [['v1', 0, true, 'guide_v1.html', 'G1'], ['v2', 1, true, 'guide_v2.html', 'G2'], ['v3', 2, false, null, 'G3, the page\'s own change']]);
  const saved = Object.keys(written).filter((k) => k.startsWith('published/')).sort();
  assert.deepStrictEqual(saved, ['published/Guide_Short1/published.json', 'published/Guide_Short1/v3/index.html']);
  assert.strictEqual(fetcher.count('publishedPageFile'), 1);
  const json = JSON.parse(fileText(written, 'published/Guide_Short1/published.json'));
  assert.strictEqual(json.versions.v1.saved, false);
  assert.deepStrictEqual(json.versions.v1.publishedIn, [{ chat: 'c1', messageUuid: 'm1', toolUseId: 'p1', same: true, writtenAs: 'guide_v1.html' }]);
  assert.ok(docText(written, 'full_chat.md').includes('(artefacts/guide_v1.html)'));
});

// ---- claude.ai's Artifact tool: publish a file, or open an artifact ----
const ART = 'Artifact';
const artReply = (path, url, ver, n = 1) => `Published ${path} at ${url} (Version ${n}, version id ${ver}) Icon: "book".\n\nLive subscription: not supported yet.`;
const artPublish = (id, path, url, ver, n, input = {}) => [use(id, ART, { file_path: path, description: 'A page', icon: 'book', ...input }),
  { ...pubResult(id, artReply(path, url, ver, n)), name: ART }];

test('artifactPublishReply reads the Artifact tool reply, and only a publish', () => {
  const short = core.uuidToBase58(PUB_U);
  assert.deepStrictEqual(plain(core.artifactPublishReply(artReply('/home/claude/a.html', `https://claude.ai/artifact/${short}`, '1794168443-5b08'))),
    { url: `https://claude.ai/artifact/${short}`, uuid: PUB_U, shortId: short, ver: '1794168443-5b08' });
  const code = core.artifactPublishReply(`Published /home/claude/a.html at https://claude.ai/code/artifact/${PUB_U.toUpperCase()}`);
  assert.deepStrictEqual(plain(code), { url: `https://claude.ai/code/artifact/${PUB_U.toUpperCase()}`, uuid: PUB_U, shortId: short, ver: '' });
  assert.strictEqual(core.artifactPublishReply(`Opened the Artifact at https://claude.ai/artifact/${short} for the user. Nothing was published or changed.`), null);
  assert.strictEqual(core.artifactPublishReply('Published /x at https://claude.ai/artifact/0OIl (Version 1, version id v1)'), null);
  assert.strictEqual(core.artifactPublishReply(`Published /x at https://evil.example/artifact/${short}`), null);
  assert.strictEqual(core.artifactPublishReply(artReply('/x', `https://claude.ai/artifact/${short}`, '../a')).ver, '');
  assert.ok(core.isArtifactPublish('Artifact', { file_path: '/home/claude/a.html' }));
  assert.ok(core.isArtifactPublish('mcp__x__Artifact', { file_path: '/a', action: 'publish' }));
  assert.ok(!core.isArtifactPublish('Artifact', { action: 'open', url: 'https://claude.ai/artifact/x' }));
  assert.ok(!core.isArtifactPublish('Artifact', { file_path: '/a', action: 'open' }));
  assert.ok(!core.isArtifactPublish('artifacts', { file_path: '/a' }));
  assert.ok(!core.isArtifactPublish('Artifact', { file_path: '' }));
});

test('publishedPagesOf lists Artifact tool publishes, titled by file name, and skips opens and errors', () => {
  const short = core.uuidToBase58(PUB_U);
  const url = `https://claude.ai/artifact/${short}`;
  const data = { chat_messages: [
    { uuid: 'm1', sender: 'assistant', content: [...artPublish('a1', '/home/claude/verb/astral-body.html', url, 'v1')] },
    { uuid: 'm2', sender: 'assistant', content: [
      use('o1', ART, { action: 'open', url }), { ...pubResult('o1', `Opened the Artifact at ${url} for the user. Nothing was published or changed.`), name: ART },
      use('a2', ART, { file_path: '/home/claude/verb/astral-body.html' }), { ...pubResult('a2', artReply('/home/claude/verb/astral-body.html', url, 'v2', 2)), name: ART },
      use('a3', ART, { file_path: '/home/claude/b.html' }), { ...pubResult('a3', 'Error: not allowed', true), name: ART },
    ] },
  ] };
  const pages = plain(core.publishedPagesOf(data));
  assert.deepStrictEqual(pages.map((p) => [p.uuid, p.shortId, p.ver, p.title, p.url, p.current, p.publishes.map((x) => x.toolUseId)]),
    [[PUB_U, short, 'v1', 'astral-body', url, false, ['a1']], [PUB_U, short, 'v2', 'astral-body', url, false, ['a2']]]);
  assert.ok(pages.every((p) => p.titleFromFile === true));
  assert.deepStrictEqual(pages[0].sources, [{ as: '', path: '/home/claude/verb/astral-body.html' }]);
});

test('an Artifact tool publish is saved like publish_files, the same as the written file, with a card and a link', async () => {
  const short = core.uuidToBase58(PUB_U);
  const url = `https://claude.ai/artifact/${short}`;
  const data = pubChat([
    pubMsg('m1', null, [use('w', 'Write', { file_path: '/home/claude/guide.html', content: 'G1' }), result('w'), ...artPublish('a1', '/home/claude/guide.html', url, 'v1')]),
    pubMsg('m2', 'm1', [use('o', ART, { action: 'open', url }), { ...pubResult('o', `Opened the Artifact at ${url} for the user.`), name: ART }, { type: 'text', text: 'Opened it.' }]),
  ]);
  const fetcher = publishedFetcher({ [PUB_U]: { title: 'Guide', history: ['v1'], versions: { v1: { files: { 'index.html': 'G1' } } } } });
  const { written, output, chat } = await runFolder(exportPopup(), data, { fetchPublished: fetcher.fetch });
  assert.deepStrictEqual(plain(output.published[0].versions.map((v) => [v.ver, v.same, v.writtenAs])), [['v1', true, 'guide.html']]);
  // Named by claude.ai's title once the page info arrives, not by the file name it was first known by.
  assert.strictEqual(output.published[0].dir, `published/Guide_${short}`);
  assert.ok(!Object.keys(written).some((k) => k.startsWith(`published/guide_${short}`)));
  const json = JSON.parse(fileText(written, `published/Guide_${short}/published.json`));
  assert.strictEqual(json.title, 'Guide');
  assert.deepStrictEqual(json.versions.v1.publishedIn, [{ chat: 'c1', messageUuid: 'm1', toolUseId: 'a1', same: true, writtenAs: 'guide.html' }]);
  const md = docText(written, 'full_chat.md');
  assert.ok(md.includes('Publishing on claude.ai: page (guide.html)'));
  assert.ok(md.includes(`> **Published on claude.ai:** [${url}](${url}) · [saved copy](artefacts/guide.html)`));
  const blocks = chat.messages.flatMap((m) => m.blocks);
  const pub = blocks.find((b) => b.t === 'tool' && b.name === ART && b.input && b.input.file_path);
  assert.strictEqual(pub.label, 'Published a page: guide.html');
  assert.strictEqual(pub.output, true);
  // As with publish_files: the written file's card, then the page's card with its claude.ai link; no plain link line.
  const cards = blocks.filter((b) => b.t === 'card').map((b) => chat.files[b.file]);
  assert.deepStrictEqual(plain(cards.map((f) => [f.name, f.published ? f.published.url : null])), [['guide.html', null], ['Guide', url]]);
  assert.ok(!pub.published);
  const open = blocks.find((b) => b.t === 'tool' && b.name === ART && b.input && b.input.action === 'open');
  assert.strictEqual(open.label, 'Opened an artifact');
  assert.ok(!open.output && !open.published);
});

test('a page attached by claude.ai to the publishing message counts as the written copy', async () => {
  const attachedChat = pubChat([pubMsg('m1', null, publish('p1', PUB_U, 'v1', [{ as: 'index.html', path: '/mnt/user-data/outputs/guide.html' }]),
    { files_v2: [{ success: true, file_name: 'guide.html', file_uuid: 'att-1', file_kind: 'blob' }] })]);
  const pages = { [PUB_U]: { title: 'Guide', history: ['v1'], versions: { v1: { files: { 'index.html': '<p>page</p>' } } } } };
  const one = await runFolder(exportPopup({ texts: { 'att-1': textBlob('<p>page</p>') } }), attachedChat, { fetchPublished: publishedFetcher(pages).fetch });
  assert.deepStrictEqual(plain(one.output.published[0].versions.map((v) => [v.same, v.writtenAs])), [[true, 'guide.html']]);

  // The attachment has the name of a file Claude wrote, so it isn't downloaded: the written text at the publish decides.
  const existing = pubChat([
    pubMsg('m1', null, [use('w', 'Write', { file_path: '/home/claude/guide.html', content: 'A' }), result('w'), ...publish('p1', PUB_U, 'v1', guideAs)],
      { files_v2: [{ success: true, file_name: 'guide.html', file_uuid: 'att-1', file_kind: 'blob' }] }),
    pubMsg('m2', 'm1', [use('e', 'Edit', { file_path: '/home/claude/guide.html', old_string: 'A', new_string: '<p>page</p>' }), result('e')]),
  ]);
  const two = await runFolder(exportPopup({ texts: { 'att-1': textBlob('<p>page</p>') } }), existing, { fetchPublished: publishedFetcher(pages).fetch });
  assert.deepStrictEqual(plain(two.output.published[0].versions.map((v) => [v.same, v.writtenAs])), [[false, null]]);
  assert.strictEqual(fileText(two.written, 'published/Guide_Short1/v1/index.html'), '<p>page</p>');
});

test('a page whose source inlined an upload compares the inlined text on disk', async () => {
  const page = '<img src="/mnt/user-data/uploads/x.png">';
  const data = pubChat([
    { uuid: 'h', parent_message_uuid: null, sender: 'human', content: [{ type: 'text', text: 'hi' }], files_v2: [{ success: true, file_name: 'x.png', file_uuid: 'up-x', file_kind: 'image' }] },
    pubMsg('m1', 'h', [use('w', 'Write', { file_path: '/home/claude/guide.html', content: page }), result('w'), ...publish('p1', PUB_U, 'v1', guideAs)]),
  ]);
  const fetcher = publishedFetcher({ [PUB_U]: { title: 'Guide', history: ['v1'], versions: { v1: { files: { 'index.html': page } } } } });
  const { written, output } = await runFolder(exportPopup(), data, { fetchPublished: fetcher.fetch });
  assert.ok(!fileText(written, 'artefacts/guide.html').includes('/mnt/user-data/uploads/x.png'));
  assert.deepStrictEqual(plain(output.published[0].versions.map((v) => [v.same, v.writtenAs])), [[false, null]]);
  assert.strictEqual(fileText(written, 'published/Guide_Short1/v1/index.html'), page);
});

test('a two-file page where only index.html matches is copied', async () => {
  const data = pubChat([pubMsg('m1', null, [
    use('w', 'Write', { file_path: '/home/claude/guide.html', content: 'G' }), result('w'),
    use('d', 'Write', { file_path: '/home/claude/data.json', content: '{"a":1}' }), result('d'),
    ...publish('p1', PUB_U, 'v1', [...guideAs, { as: 'data.json', path: '/home/claude/data.json' }]),
  ])]);
  const fetcher = publishedFetcher({ [PUB_U]: { title: 'Guide', history: ['v1'], versions: { v1: { files: { 'index.html': 'G', 'data.json': '{"a":2}' } } } } });
  const { written, output } = await runFolder(exportPopup(), data, { fetchPublished: fetcher.fetch });
  assert.deepStrictEqual(plain(output.published[0].versions.map((v) => [v.same, v.writtenAs])), [[false, null]]);
  assert.strictEqual(fileText(written, 'published/Guide_Short1/v1/index.html'), 'G');
  assert.strictEqual(fileText(written, 'published/Guide_Short1/v1/data.json'), '{"a":2}');
});

test('a binary artefact is never the same as a published file', async () => {
  const data = pubChat([pubMsg('m1', null, [
    use('w', 'Write', { file_path: '/home/claude/pic.png', content: 'PNGDATA' }), result('w'),
    ...publish('p1', PUB_U, 'v1', [{ as: 'pic.png', path: '/home/claude/pic.png' }]),
  ])]);
  const fetcher = publishedFetcher({ [PUB_U]: { title: 'Guide', history: ['v1'], versions: { v1: { files: { 'pic.png': { body: 'PNGDATA', type: 'image/png' } } } } } });
  const { written, output } = await runFolder(exportPopup(), data, { fetchPublished: fetcher.fetch });
  assert.deepStrictEqual(plain(output.published[0].versions.map((v) => [v.same, v.writtenAs, v.start, v.text])), [[false, null, 'pic.png', null]]);
  assert.strictEqual(fileText(written, 'published/Guide_Short1/v1/pic.png'), 'PNGDATA');
});

test('pages that can\'t be fetched are warnings, and the chat still exports', async () => {
  const data = pubChat([pubMsg('m1', null, [
    use('w', 'Write', { file_path: '/home/claude/guide.html', content: 'G' }), result('w'),
    ...publish('p1', PUB_U, 'v1', guideAs, 'Gone1', 'Gone'),
    ...publish('p4', PUB_U4, 'v1', guideAs, 'Bad4', 'Bad'),
    // After a 401, later pages are skipped without fetching.
    ...publish('p2', PUB_U2, 'v1', guideAs, 'Out2', 'Out'),
    ...publish('p3', PUB_U3, 'v1', guideAs, 'Out3', 'Out too'),
  ])]);
  const signedOut = { error: 'HTTP 401', status: 401 };
  const fetcher = publishedFetcher({
    [PUB_U2]: { error: signedOut }, [PUB_U3]: { error: signedOut },
    [PUB_U4]: { title: 'Bad', history: ['v1'], versions: { v1: { files: { 'index.html': { body: 'tampered', sha256: sha('original') }, 'app.js': 'x()' } } } },
  });
  const { written, output } = await runFolder(exportPopup(), data, { fetchPublished: fetcher.fetch });
  assert.ok(docText(written, 'full_chat.md'));
  const warnings = pubWarnings(output);
  assert.ok(warnings.some((w) => /HTTP 404/.test(w.message) && /https:\/\/claude\.ai\/artifact\/Gone1/.test(`${w.message} ${w.details.note}`)));
  assert.strictEqual(warnings.filter((w) => /signed out/i.test(w.message)).length, 1);
  assert.strictEqual(fetcher.count('publishedPageInfo', PUB_U3), 0);
  const bad = plain(output.published.find((e) => e.uuid === PUB_U4));
  assert.deepStrictEqual(bad.versions.map((v) => [v.incomplete, v.start, v.startSaved]), [[true, null, null]]);
  const json = JSON.parse(fileText(written, 'published/Bad_Bad4/published.json'));
  assert.deepStrictEqual(json.versions.v1.missing, ['index.html']);
  assert.strictEqual(json.versions.v1.incomplete, true);
  assert.strictEqual(json.versions.v1.start, null);
  assert.strictEqual(fileText(written, 'published/Bad_Bad4/v1/app.js'), 'x()');
  assert.strictEqual(written['published/Bad_Bad4/v1/index.html'], undefined);
  assert.ok(warnings.some((w) => /index\.html/.test(w.message) && /Bad4/.test(`${w.message} ${w.details.note}`)));
  assert.ok(/published_page|published page/i.test(fileText(written, 'errors.txt')));
  assert.ok(!/__frame_t|frame\.claudeusercontent/.test(fileText(written, 'errors.txt')));
});

test('published file paths stay inside the page folder with distinct names', async () => {
  const data = pubChat([pubMsg('m1', null, publish('p1', PUB_U, 'v1', guideAs))]);
  const fetcher = publishedFetcher({ [PUB_U]: { title: 'Guide', history: ['v1'], versions: { v1: { rejected: ['../evil'], files: {
    'Index.html': 'I', 'index.html': 'i', a: 'file a', 'a/b': 'file b', 'con.txt': 'c', 'x:y.txt': 'xy',
  } } } } });
  const { written, output } = await runFolder(exportPopup(), data, { fetchPublished: fetcher.fetch });
  const json = JSON.parse(fileText(written, 'published/Guide_Short1/published.json'));
  assert.deepStrictEqual(json.versions.v1.files.map((f) => [f.path, f.savedAs]), [
    ['Index.html', 'Index.html'], ['index.html', 'index_2.html'], ['a', 'a'], ['a/b', 'a_2/b'], ['con.txt', '_con.txt'], ['x:y.txt', 'x_y.txt'],
  ]);
  assert.strictEqual(json.versions.v1.start, 'index.html');
  assert.strictEqual(json.versions.v1.startSaved, 'index_2.html');
  assert.strictEqual(fileText(written, 'published/Guide_Short1/v1/index_2.html'), 'i');
  assert.strictEqual(fileText(written, 'published/Guide_Short1/v1/a_2/b'), 'file b');
  assert.ok(Object.keys(written).every((k) => !k.includes('..') && !k.includes(':')));
  const warnings = pubWarnings(output);
  assert.strictEqual(warnings.length, 1);
  for (const s of ['index_2.html', 'a_2/b', '_con.txt', 'x_y.txt', '../evil']) assert.ok(warnings[0].message.includes(s), s);
});

test('a ZIP export without a claude.ai tab warns that pages were not fetched', async () => {
  const data = pubChat([pubMsg('m1', null, [...publish('p1', PUB_U, 'v1', guideAs), ...publish('p2', PUB_U2, 'v1', guideAs, 'S2')])]);
  const { written, output } = await runFolder(exportPopup(), data);
  const warnings = pubWarnings(output);
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0].message, /page not fetched: no claude\.ai tab/);
  assert.ok(!Object.keys(written).some((k) => k.startsWith('published/')));
});

const bulkWithPages = (fetcher, scripting) => (sb) => {
  const orig = sb.chrome.tabs.sendMessage;
  sb.chrome.tabs.sendMessage = (id, msg, cb) => (/^publishedPage/.test(msg.action) ? fetcher.fetch(msg).then(cb) : orig(id, msg, cb));
  sb.chrome.scripting = { executeScript: async () => { scripting.calls++; } };
};

test('the extension\'s message wiring is used', async () => {
  const chats = { a: Object.assign(pubChat([pubMsg('m1', null, publish('p1', PUB_U, 'v1', guideAs))]), { uuid: 'a', name: 'Chat a' }) };
  const fetcher = publishedFetcher({ [PUB_U]: { title: 'Guide', history: ['v1'], versions: { v1: { files: { 'index.html': 'page' } } } } });
  const scripting = { calls: 0 };
  const { zip } = await runBulkZip({ list: [listed('a', '2026-01-01T00:00:00Z')], chats, setup: bulkWithPages(fetcher, scripting) });
  assert.strictEqual(await zip.file(`artifacts/${artFolder('Guide', PUB_U)}/v1/index.html`).async('string'), 'page');
  assert.strictEqual(scripting.calls, 0);
  assert.strictEqual(fetcher.count('publishedPageInfo'), 1);
});

test('Export All stores a page published from two chats once and lists both', async () => {
  const chatA = Object.assign(pubChat([pubMsg('m1', null, [
    use('w', 'Write', { file_path: '/home/claude/guide.html', content: 'one' }), result('w'), ...publish('p1', PUB_U, 'v1', guideAs),
  ])]), { uuid: 'a', name: 'Chat a' });
  const chatB = Object.assign(pubChat([pubMsg('n1', null, [...publish('q1', PUB_U, 'v1', guideAs), ...publish('q2', PUB_U, 'v2', guideAs)])]), { uuid: 'b', name: 'Chat b' });
  const chatC = Object.assign(pubChat([{ uuid: 'h', parent_message_uuid: null, sender: 'human', content: [{ type: 'text', text: 'hi' }] }]), { uuid: 'p', name: 'published' });
  const fetcher = publishedFetcher({ [PUB_U]: { title: 'Guide', history: ['v1', 'v2'], versions: { v1: { files: { 'index.html': 'one' } }, v2: { files: { 'index.html': 'two' } } } } });
  const scripting = { calls: 0 };
  const list = [listed('a', '2026-01-01T00:00:00Z'), listed('b', '2026-01-02T00:00:00Z'), listed('p', '2026-01-03T00:00:00Z')];
  const { zip } = await runBulkZip({ list, chats: { a: chatA, b: chatB, p: chatC }, setup: bulkWithPages(fetcher, scripting) });
  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
  const f = artFolder('Guide', PUB_U);
  assert.ok(!names.some((n) => /(^|\/)published\//.test(n)), names.join());
  assert.deepStrictEqual(names.filter((n) => n.startsWith(`artifacts/${f}/`)).sort(), [`artifacts/${f}/artifact.json`, `artifacts/${f}/v1/index.html`, `artifacts/${f}/v2/index.html`]);
  assert.ok(names.some((n) => n.startsWith('published_2/README.md')));
  const json = JSON.parse(await zip.file(`artifacts/${f}/artifact.json`).async('string'));
  assert.deepStrictEqual(Object.keys(json.versions), ['v1', 'v2']);
  assert.deepStrictEqual(json.versions.v1.publishedIn, [
    { chat: 'a', messageUuid: 'm1', toolUseId: 'p1', same: true, writtenAs: 'guide.html' },
    { chat: 'b', messageUuid: 'n1', toolUseId: 'q1', same: false, writtenAs: null },
  ]);
  assert.strictEqual(json.versions.v1.saved, true);
  assert.deepStrictEqual(json.versions.v2.publishedIn, [{ chat: 'b', messageUuid: 'n1', toolUseId: 'q2', same: false, writtenAs: null }]);
  assert.strictEqual(fetcher.count('publishedPageInfo'), 2);
  assert.strictEqual(fetcher.count('publishedPageFile'), 2);
  const readmeB = await zip.file('Chat_b/README.md').async('string');
  assert.ok(readmeB.includes(`(../artifacts/${f}/v2/index.html)`));
});

test('Export All: a url-only publish joins a version another chat stored, with no second copy', async () => {
  const chatA = Object.assign(pubChat([pubMsg('m1', null, publish('p1', PUB_U, 'v3', guideAs))]), { uuid: 'a', name: 'Chat a' });
  let n = BigInt('0x' + PUB_U.replace(/-/g, '')), short = '';
  const b58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  for (; n > 0n; n /= 58n) short = b58[Number(n % 58n)] + short;
  assert.strictEqual(core.base58ToUuid(short), PUB_U);
  const urlOnly = [use('q1', PUB, { files: [], title: 'Guide' }), { ...pubResult('q1', { url: `https://claude.ai/artifact/${short}`, title: 'Guide' }), name: PUB }];
  const chatB = Object.assign(pubChat([pubMsg('n1', null, urlOnly)]), { uuid: 'b', name: 'Chat b' });
  const fetcher = publishedFetcher({ [PUB_U]: { title: 'Guide', live: 'v3', history: ['v1', 'v2', 'v3'], versions: { v3: { files: { 'index.html': 'three' } } } } });
  const list = [listed('a', '2026-01-01T00:00:00Z'), listed('b', '2026-01-02T00:00:00Z')];
  const { zip } = await runBulkZip({ list, chats: { a: chatA, b: chatB }, setup: bulkWithPages(fetcher, { calls: 0 }) });
  const f = artFolder('Guide', PUB_U);
  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir && /^(published|artifacts)\//.test(n) && !/^artifacts\/index\./.test(n)).sort();
  assert.deepStrictEqual(names, [`artifacts/${f}/artifact.json`, `artifacts/${f}/v3/index.html`]);
  assert.strictEqual(fetcher.count('publishedPageFile'), 1);
  assert.ok(fetcher.count('publishedPageInfo') <= 2);
  const json = JSON.parse(await zip.file(`artifacts/${f}/artifact.json`).async('string'));
  assert.deepStrictEqual(json.versions.v3.publishedIn.map((p) => p.chat), ['a', 'b']);
});

test('Export All: a page skipped after a 401 is "not saved", and a later chat\'s errors.txt says why', async () => {
  const signedOut = { error: 'HTTP 401', status: 401 };
  const chatA = Object.assign(pubChat([pubMsg('m1', null, publish('p1', PUB_U, 'v1', guideAs, 'Out1', 'Out'))]), { uuid: 'a', name: 'Chat a' });
  const chatB = Object.assign(pubChat([pubMsg('n1', null, publish('q1', PUB_U2, 'v1', guideAs, 'Out2', 'Out too'))]), { uuid: 'b', name: 'Chat b' });
  const fetcher = publishedFetcher({ [PUB_U]: { error: signedOut }, [PUB_U2]: { error: signedOut } });
  const list = [listed('a', '2026-01-01T00:00:00Z'), listed('b', '2026-01-02T00:00:00Z')];
  const { zip } = await runBulkZip({ list, chats: { a: chatA, b: chatB }, setup: bulkWithPages(fetcher, { calls: 0 }) });
  const readmeA = await zip.file('Chat_a/README.md').async('string');
  const readmeB = await zip.file('Chat_b/README.md').async('string');
  assert.ok(/not saved \(see errors\.txt\)/.test(readmeA), readmeA);
  assert.ok(/not saved \(see errors\.txt\)/.test(readmeB), readmeB);
  const errB = await zip.file('Chat_b/errors.txt').async('string');
  assert.strictEqual((errB.match(/an earlier request in this export was answered HTTP 401/g) || []).length, 1, errB);
  assert.ok(!/claude\.ai answered HTTP 401, as if/.test(errB), 'only the chat that met the 401 says so');
});

// ---- Export Artifacts ----
// Every artifact claude.ai lists (claude.ai/artifacts), its current version's files in a folder each, with an index.
const { runArtifacts } = require('./helpers');
const { uuidToBase58 } = require('../export-core.js');
const DOCS_TYPE = 'c8f0b311-af6a-4d22-a07b-61eb818fc35d';
const DESIGN_TYPE = 'bcd2878f-a88d-4094-a616-8e39d8a5fd8a';
const LIVE = '1794783850-4a6e';
const U = (n) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const art = (slug, title, extra = {}) => ({ slug, title, typeSlug: '', typeTitle: '', sourceSurface: 'chat', rel: 'mine', live: LIVE, updatedAt: '2026-11-01T00:00:00Z', createdAt: '2026-10-01T00:00:00Z', ...extra });
const livePage = (title, files, extra = {}) => ({ title, live: LIVE, versions: { [LIVE]: { files } }, ...extra });
const artFolder = (name, uuid) => `${name}_${uuidToBase58(uuid)}`;
// An artifact's current (LIVE) version folder, and the current version in its artifact.json (format 2).
const artVer = (name, uuid) => `${artFolder(name, uuid)}/${LIVE}`;
const curVer = (meta) => meta.versions[meta.current];
const DOCS_NOTE = "Claude Docs text isn't available as a file; export the chat that made it to get the document.";

// ---- The artifacts store: one folder per artifact, one folder per version, artifact.json format 2 ----
test('artifactJsonV2 writes format 2 with versions, listed and current', () => {
  const sb = exportPopup().sandbox;
  const sha = 'a'.repeat(64);
  sb.__in = JSON.parse(JSON.stringify({
    uuid: U(1), shortId: 'Short1', dir: 'Guide_Short1', title: 'Guide', listed: true, current: 'v2',
    meta: { url: 'https://claude.ai/artifact/Short1', typeTitle: 'Page', sourceSurface: 'chat', rel: 'mine', public: true, createdAt: 'c', updatedAt: 'u', note: 'n', start: 'index.html', needsRuntime: false, thumb: 'viewer-files/thumbs/Short1.png' },
    versions: [
      ['v1', { folder: null, files: [{ path: 'index.html', savedAs: 'index.html', size: 3, contentType: 'text/html', sha256: sha }], start: 'index.html', startSaved: 'index.html',
        incomplete: false, missing: [], saved: false, sameAs: { 'index.html': 'Chat_a/artefacts/guide.html' },
        publishedIn: [{ chat: 'a', messageUuid: 'm1', toolUseId: 'p1', same: true, writtenAs: 'guide.html' }] }],
      ['v2', { folder: 'v2', files: [{ path: 'index.html', savedAs: 'index.html', size: 4, contentType: 'text/html', sha256: sha, verified: false }], start: 'index.html', startSaved: 'index.html',
        incomplete: false, missing: [], saved: true, publishedIn: [{ chat: 'b', messageUuid: 'n1', toolUseId: 'q1', same: false, writtenAs: null }] }],
    ],
  }));
  const out = vm.runInContext(`(() => {
    const rec = { ...__in, versions: new Map(__in.versions) };
    const v2 = rec.versions.get('v2');
    Object.defineProperty(v2, 'preview', { value: { texts: [['index.html', 'x']], images: [] } });
    Object.defineProperty(v2.publishedIn[0], 'text', { value: 'x' });
    return JSON.stringify(artifactJsonV2(rec));
  })()`, sb);
  const json = JSON.parse(out);
  assert.deepStrictEqual(Object.keys(json), ['format', 'uuid', 'shortId', 'url', 'title', 'typeTitle', 'sourceSurface', 'rel', 'public', 'createdAt', 'updatedAt',
    'listed', 'current', 'start', 'needsRuntime', 'note', 'thumb', 'order', 'versions']);
  assert.deepStrictEqual([json.format, json.listed, json.current, json.uuid, json.title], [2, true, 'v2', U(1), 'Guide']);
  assert.deepStrictEqual(json.order, ['v1', 'v2']);
  assert.deepStrictEqual(Object.keys(json.versions), ['v1', 'v2']);
  assert.deepStrictEqual(Object.keys(json.versions.v1), ['folder', 'files', 'start', 'startSaved', 'incomplete', 'missing', 'saved', 'sameAs', 'publishedIn']);
  assert.deepStrictEqual(Object.keys(json.versions.v2), ['folder', 'files', 'start', 'startSaved', 'incomplete', 'missing', 'saved', 'publishedIn']);
  assert.strictEqual(json.versions.v1.folder, null);
  assert.deepStrictEqual(json.versions.v1.sameAs, { 'index.html': 'Chat_a/artefacts/guide.html' });
  assert.strictEqual(json.versions.v2.folder, 'v2');
  assert.deepStrictEqual(Object.keys(json.versions.v2.files[0]), ['path', 'savedAs', 'size', 'contentType', 'sha256', 'verified']);
  assert.deepStrictEqual([json.versions.v1.files[0].verified, json.versions.v2.files[0].verified], [true, false]);
  assert.deepStrictEqual(json.versions.v1.publishedIn, [{ chat: 'a', messageUuid: 'm1', toolUseId: 'p1', same: true, writtenAs: 'guide.html' }]);
  assert.deepStrictEqual(json.versions.v2.publishedIn, [{ chat: 'b', messageUuid: 'n1', toolUseId: 'q1', same: false, writtenAs: null }]);
  assert.ok(!out.includes('preview') && !out.includes('"text"'));
});

test('Export Artifacts writes <Title>_<id>/<ver>/ and artifact.json format 2', async () => {
  const frames = [art(U(1), 'Game'), art(U(2), 'Plan', { typeSlug: DOCS_TYPE, typeTitle: 'Docs' }), art(U(3), 'Design Empty', { typeSlug: DESIGN_TYPE, typeTitle: 'Design' })];
  const pages = {
    [U(1)]: livePage('Game', { 'index.html': '<script src="app.js"></script>', 'app.js': 'go()', 'artifact.json': '{"mine":1}' }),
    [U(3)]: livePage('Design Empty', { 'artifact-type/runtime.js': 'rt' }),
  };
  const { files, views } = await runArtifacts({ frames, pages });
  const game = artFolder('Game', U(1));
  const plan = artFolder('Plan', U(2));
  const design = artFolder('Design_Empty', U(3));
  assert.deepStrictEqual(Object.keys(files).filter((n) => n.startsWith(`${game}/`)).sort(),
    [`${game}/${LIVE}/app.js`, `${game}/${LIVE}/artifact.json`, `${game}/${LIVE}/index.html`, `${game}/${LIVE}.zip`, `${game}/artifact.json`].sort());
  assert.strictEqual(files[`${game}/${LIVE}/artifact.json`], '{"mine":1}', 'a page file named artifact.json keeps its name in its version folder');
  for (const f of [plan, design]) assert.deepStrictEqual(Object.keys(files).filter((n) => n.startsWith(`${f}/`)), [`${f}/artifact.json`]);
  const meta = JSON.parse(files[`${game}/artifact.json`]);
  assert.deepStrictEqual([meta.format, meta.listed, meta.current, meta.start], [2, true, LIVE, 'index.html']);
  assert.deepStrictEqual(Object.keys(meta.versions), [LIVE]);
  const v = meta.versions[LIVE];
  assert.deepStrictEqual([v.folder, v.saved, v.incomplete, v.start, v.startSaved], [LIVE, true, false, 'index.html', 'index.html']);
  assert.deepStrictEqual(v.files.map((f) => f.savedAs), ['index.html', 'app.js', 'artifact.json']);
  assert.ok(!('files' in meta) && !('ver' in meta));
  const docs = JSON.parse(files[`${plan}/artifact.json`]);
  assert.deepStrictEqual([docs.format, docs.listed, docs.note, docs.versions], [2, true, DOCS_NOTE, {}]);
  assert.deepStrictEqual(JSON.parse(files[`${design}/artifact.json`]).versions, {});
  assert.ok(files['index.html'].includes(`href="${game}/${LIVE}/index.html"`), files['index.html']);
  assert.ok(files['index.md'].includes(`[Game](${game}/${LIVE}/index.html)`), files['index.md']);
  assert.ok(files['index.md'].includes(`[${LIVE}](${game}/${LIVE}/index.html) (current)`), files['index.md']);
  const view = views.find((x) => x.title === 'Game');
  assert.strictEqual(view.folder, `${game}/${LIVE}`);
  assert.strictEqual(view.startSaved, 'index.html');
  const manifest = JSON.parse(files['export-manifest.json']);
  assert.deepStrictEqual(manifest.artifacts.map((e) => e.folder), [game, plan, design]);
});

test('a version with no id goes to current/', () => {
  const sb = exportPopup().sandbox;
  const root = zipStub();
  sb.__root = root;
  const out = JSON.parse(vm.runInContext(`(() => {
    const store = artifactStore(__root, { prefix: 'artifacts/' });
    const rec = store.record('${U(1)}', { title: 'Guide' });
    const again = store.record('${U(1).toUpperCase()}', { title: 'Other' });
    const a = store.versionFolder(rec, '');
    const b = store.versionFolder(rec, 'v1');
    const c = store.versionFolder(rec, 'current');
    const d = store.versionFolder(rec, 'artifact.json');
    rec.versions.set('', { folder: 'current', files: [], saved: true, publishedIn: [] });
    store.write(rec);
    return JSON.stringify({ same: rec === again, a, b, c, d, again: store.versionFolder(rec, ''), has: [store.has('${U(1)}', ''), store.has('${U(1)}', 'v1')], n: store.records().length });
  })()`, sb));
  const dir = `artifacts/${artFolder('Guide', U(1))}`;
  assert.deepStrictEqual(out, { same: true, a: `${dir}/current/`, b: `${dir}/v1/`, c: `${dir}/current_2/`, d: `${dir}/artifact.json_2/`, again: `${dir}/current/`, has: [true, false], n: 1 });
  const json = JSON.parse(root.written[`${dir}/artifact.json`]);
  assert.deepStrictEqual([json.format, json.current, Object.keys(json.versions)], [2, null, ['current']]);
});

test('runArtifactStep with a store does not fetch a version it already holds whole', async () => {
  const sb = exportPopup().sandbox;
  const fetcher = publishedFetcher({ [U(1)]: livePage('Guide', { 'index.html': 'live' }), [U(2)]: livePage('Part', { 'index.html': 'p2' }) });
  const root = zipStub();
  sb.setTimeout = (f) => setTimeout(f, 0);
  Object.assign(sb, { __root: root, __fetch: fetcher.fetch, __arts: [art(U(1), 'Guide'), art(U(2), 'Part')] });
  const out = JSON.parse(await vm.runInContext(`(async () => {
    const store = artifactStore(__root, { prefix: 'artifacts/' });
    const pub = [{ chat: 'a', messageUuid: 'm1', toolUseId: 'p1', same: false, writtenAs: null }];
    const whole = { folder: '${LIVE}', files: [{ path: 'index.html', savedAs: 'index.html', size: 4, contentType: 'text/html', sha256: '${'b'.repeat(64)}' }],
      start: 'index.html', startSaved: 'index.html', incomplete: false, missing: [], saved: true, publishedIn: pub };
    Object.defineProperty(whole, 'preview', { value: { texts: [['index.html', 'mine']], images: [] } });
    store.record('${U(1)}', { title: 'Guide' }).versions.set('${LIVE}', whole);
    // Part: incomplete, so fetched again; its publishes stay.
    store.record('${U(2)}', { title: 'Part' }).versions.set('${LIVE}', { ...whole, incomplete: true, missing: ['index.html'], publishedIn: pub.slice() });
    const step = await runArtifactStep(__root, { store, artifacts: __arts, full: false, listed: 2, fetchPublished: __fetch, picturesAllowed: false, parts: null });
    return JSON.stringify({ views: step.views, rows: step.rows, whole: step.whole });
  })()`, sb));
  // Guide's current version is held whole: no file fetched; its history is asked once (v1.21), with nothing older.
  assert.strictEqual(fetcher.count('publishedPageInfo', U(1)), 1);
  assert.strictEqual(fetcher.count('publishedPageFile', U(1)), 0);
  assert.strictEqual(fetcher.count('publishedPageFile', U(2)), 1);
  const g = artFolder('Guide', U(1));
  const p = artFolder('Part', U(2));
  assert.ok(!(`artifacts/${g}/${LIVE}/index.html` in root.written), 'not written again');
  assert.strictEqual(Buffer.from(root.written[`artifacts/${p}/${LIVE}/index.html`]).toString('utf8'), 'p2');
  assert.deepStrictEqual(out.whole, [true, true]);
  assert.strictEqual(out.views[0].folder, `artifacts/${g}/${LIVE}`);
  assert.strictEqual(out.rows[0].folder, `${g}/${LIVE}`);
  const meta = JSON.parse(root.written[`artifacts/${g}/artifact.json`]);
  assert.deepStrictEqual([meta.current, meta.versions[LIVE].publishedIn.length], [LIVE, 1]);
  const part = JSON.parse(root.written[`artifacts/${p}/artifact.json`]);
  assert.deepStrictEqual([part.versions[LIVE].incomplete, part.versions[LIVE].publishedIn.map((x) => x.chat)], [false, ['a']]);
});

test('Export Artifacts saves each artifact\'s current files with artifact.json and an index', async () => {
  const frames = [art(U(1), 'Quarterly Report'), art(U(2), 'Game', { sourceSurface: 'code' })];
  const pages = {
    [U(1)]: livePage('Quarterly Report', { 'index.html': '<h1>Q</h1>' }),
    [U(2)]: livePage('Game', { 'index.html': '<script src="app.js"></script>', 'app.js': 'go()', 'img/logo.svg': '<svg/>' }),
  };
  const { saved, files, result, fetcher, listCalls } = await runArtifacts({ frames, pages });
  assert.match(saved.name, /^claude-takeout-artifacts-mika-\d{4}-\d{2}-\d{2}_\d{4}\.zip$/);
  assert.deepStrictEqual(plain(listCalls), [{ action: 'listArtifacts', withAccountName: true }]);
  const f1 = artFolder('Quarterly_Report', U(1));
  const f2 = artFolder('Game', U(2));
  assert.deepStrictEqual(Object.keys(files).sort(), [`${f1}/artifact.json`, `${f1}/${LIVE}/index.html`, `${f2}/${LIVE}/app.js`, `${f2}/artifact.json`, `${f2}/${LIVE}/img/logo.svg`, `${f2}/${LIVE}/index.html`, `${f2}/${LIVE}.zip`,
    'export-manifest.json', 'index.html', 'index.md', 'viewer-check.gif', 'viewer-files/part-0001.js', 'viewer.html'].sort());
  assert.strictEqual(files[`${f2}/${LIVE}/app.js`], 'go()');
  const meta = JSON.parse(files[`${f2}/artifact.json`]);
  assert.deepStrictEqual(Object.keys(meta).sort(), ['createdAt', 'current', 'format', 'listed', 'needsRuntime', 'note', 'order', 'public', 'rel', 'shortId', 'sourceSurface', 'start', 'title', 'typeTitle', 'updatedAt', 'url', 'uuid', 'versions'].sort());
  const shortId = uuidToBase58(U(2));
  assert.deepStrictEqual([meta.format, meta.uuid, meta.shortId, meta.url, meta.title, meta.current, meta.sourceSurface, meta.rel, curVer(meta).incomplete, meta.needsRuntime, meta.createdAt, meta.updatedAt],
    [2, U(2), shortId, `https://claude.ai/artifact/${shortId}`, 'Game', LIVE, 'code', 'mine', false, false, '2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z']);
  assert.deepStrictEqual(curVer(meta).files.map((f) => [f.path, f.savedAs]), [['index.html', 'index.html'], ['app.js', 'app.js'], ['img/logo.svg', 'img/logo.svg']]);
  assert.ok(curVer(meta).files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256) && f.size > 0 && f.contentType && f.verified === true));
  assert.deepStrictEqual(curVer(meta).missing, []);
  const manifest = JSON.parse(files['export-manifest.json']);
  assert.deepStrictEqual([manifest.format, manifest.kind, manifest.listed], [1, 'artifacts', 2]);
  assert.ok(manifest.exported_at);
  assert.deepStrictEqual(manifest.artifacts, [{ uuid: U(1), title: 'Quarterly Report', folder: f1, ver: LIVE }, { uuid: U(2), title: 'Game', folder: f2, ver: LIVE }]);
  const md = files['index.md'];
  assert.match(md, /\*\*Listed by claude\.ai:\*\* 2/);
  assert.ok(md.includes(`[Game](${f2}/${LIVE}/index.html)`), md);
  assert.ok(md.includes(`(https://claude.ai/artifact/${shortId})`), md);
  assert.ok(/\| 3 \|/.test(md) || /3 files/.test(md), md);
  assert.match(files['index.html'], /Listed by claude\.ai: 2/);
  assert.deepStrictEqual(fetcher.calls.filter((c) => c.action === 'publishedPageInfo').map((c) => [c.uuid, c.ver]), [[U(1), LIVE], [U(2), LIVE]]);
  assert.deepStrictEqual([result.outcome, result.warnings, result.saved.artifacts], ['done', 0, 2]);
});

test('Export Artifacts to a folder writes the same files', async () => {
  const frames = [art(U(1), 'One'), art(U(2), 'Two')];
  const pages = { [U(1)]: livePage('One', { 'index.html': 'one' }), [U(2)]: livePage('Two', { 'a.html': 'two', 'b.css': 'x' }) };
  const zipped = await runArtifacts({ frames, pages });
  const picked = new FakeDir();
  const disk = await runArtifacts({ frames, pages, options: { directory: picked } });
  assert.strictEqual(disk.saved, null, 'no download');
  const runs = [...picked.entries.keys()];
  assert.strictEqual(runs.length, 1);
  assert.match(runs[0], /^claude-takeout-artifacts-mika-\d{4}-\d{2}-\d{2}_\d{4}$/);
  assert.deepStrictEqual(Object.keys(disk.files).sort(), Object.keys(zipped.files).sort());
  assert.strictEqual(disk.files[`${artVer('Two', U(2))}/a.html`], 'two');
  assert.deepStrictEqual([disk.result.outcome, disk.result.target, disk.result.saved.artifacts], ['done', { kind: 'folder', name: runs[0] }, 2]);
});

test('Export Artifacts to a folder: viewer.html that fails to write is not linked', async () => {
  const frames = [art(U(1), 'One')];
  const pages = { [U(1)]: livePage('One', { 'index.html': 'one' }) };
  const ok = await runArtifacts({ frames, pages, options: { directory: new FakeDir() } });
  assert.ok(ok.files['index.html'].includes('href="viewer.html"'), 'linked when written');
  const picked = new FakeDir('picked', (name) => name === 'viewer.html');
  const disk = await runArtifacts({ frames, pages, options: { directory: picked } });
  assert.ok(!('viewer.html' in disk.files) || disk.files['viewer.html'] === undefined);
  assert.ok(!disk.files['index.html'].includes('viewer.html'), disk.files['index.html']);
  assert.match(disk.files['write-errors.txt'], /viewer\.html/);
  assert.ok(disk.result.warningList.some((w) => w.type === 'viewer'), JSON.stringify(disk.result.warningList));
});

test('a Claude Docs artifact is listed with a note and not fetched', async () => {
  const frames = [art(U(1), 'Plan', { typeSlug: DOCS_TYPE, typeTitle: 'Docs' }), art(U(2), 'Notes', { typeTitle: 'Docs' }), art(U(3), 'Mock', { typeSlug: DESIGN_TYPE, typeTitle: 'Docs' })];
  const pages = { [U(3)]: livePage('Mock', { 'index.html': '<div>mock</div>' }) };
  const { files, fetcher } = await runArtifacts({ frames, pages });
  assert.strictEqual(fetcher.calls.filter((c) => c.uuid === U(1) || c.uuid === U(2)).length, 0, 'Docs are not fetched');
  for (const [name, uuid] of [['Plan', U(1)], ['Notes', U(2)]]) {
    const folder = artFolder(name, uuid);
    assert.deepStrictEqual(Object.keys(files).filter((n) => n.startsWith(`${folder}/`)), [`${folder}/artifact.json`]);
    const meta = JSON.parse(files[`${folder}/artifact.json`]);
    assert.strictEqual(meta.note, DOCS_NOTE);
    assert.deepStrictEqual(meta.versions, {});
  }
  assert.ok(files[`${artVer('Mock', U(3))}/index.html`], 'a typed artifact that is not Docs is fetched');
  const md = files['index.md'];
  const planRow = md.split('\n').find((l) => l.includes('Plan'));
  assert.ok(planRow.includes(`| ${DOCS_NOTE} |`), planRow);
  assert.ok(planRow.includes(`https://claude.ai/artifact/${uuidToBase58(U(1))}`) && !planRow.includes(`](${artFolder('Plan', U(1))}`), planRow);
  assert.ok(files['index.html'].includes(`<td>${DOCS_NOTE.replace(/'/g, '&#39;')}</td>`), files['index.html']);
});

test('an artifact claude.ai refuses is a warning; the rest export', async () => {
  const frames = [art(U(1), 'Theirs', { rel: 'shared' }), art(U(2), 'Mine'), art(U(3), 'Later'), art(U(4), 'Last')];
  const pages = {
    [U(2)]: livePage('Mine', { 'index.html': 'mine' }),
    [U(3)]: { error: { error: 'HTTP 401', status: 401 } },
    [U(4)]: livePage('Last', { 'index.html': 'last' }),
  };
  const { files, fetcher, result } = await runArtifacts({ frames, pages });
  assert.strictEqual(files[`${artVer('Mine', U(2))}/index.html`], 'mine');
  assert.strictEqual(fetcher.count('publishedPageInfo', U(4)), 0, 'nothing is fetched after a 401');
  assert.strictEqual(fetcher.count('publishedPageInfo', U(3)), 1);
  const errors = files['errors.txt'];
  assert.ok(errors, Object.keys(files).join());
  assert.match(errors, /Theirs[\s\S]*HTTP 404/);
  assert.strictEqual((errors.match(/HTTP 401/g) || []).length, 1, errors);
  assert.ok(!/\*\*Conversation:\*\*/.test(errors) && /Export Artifacts/.test(errors), errors.slice(0, 300));
  const theirs = JSON.parse(files[`${artFolder('Theirs', U(1))}/artifact.json`]);
  assert.match(theirs.note, /not exported/i);
  assert.deepStrictEqual(theirs.versions, {});
  const last = JSON.parse(files[`${artFolder('Last', U(4))}/artifact.json`]);
  assert.match(last.note, /not exported/i);
  const row = files['index.md'].split('\n').find((l) => l.includes('Theirs'));
  assert.match(row, /not exported/i);
  assert.deepStrictEqual([result.outcome, result.warnings > 0], ['done', true]);
});

test('same-titled artifacts get distinct folders, and unsafe titles and paths stay inside', async () => {
  const frames = [art(U(1), 'Same'), art(U(2), 'Same'), art(U(3), '../../etc/passwd'), art(U(4), '')];
  const pages = {
    [U(1)]: livePage('Same', { 'index.html': 'a' }),
    [U(2)]: livePage('Same', { 'index.html': 'b' }),
    [U(3)]: livePage('x', { 'ok.html': 'ok', 'a:b.html': 'colon', 'CON.txt': 'con', '../escape.html': 'no', 'sub/../../up.html': 'no', '/abs.html': 'no' }),
    [U(4)]: livePage('', { 'index.html': 'untitled' }),
  };
  const { files } = await runArtifacts({ frames, pages });
  const s1 = artFolder('Same', U(1));
  const s2 = artFolder('Same', U(2));
  assert.notStrictEqual(s1, s2);
  assert.strictEqual(files[`${s1}/${LIVE}/index.html`], 'a');
  assert.strictEqual(files[`${s2}/${LIVE}/index.html`], 'b');
  const evil = artVer('etcpasswd', U(3));
  assert.strictEqual(files[`${evil}/ok.html`], 'ok');
  assert.strictEqual(files[`${evil}/a_b.html`], 'colon');
  assert.strictEqual(files[`${evil}/_CON.txt`], 'con');
  assert.ok(files[`${artVer('artifact', U(4))}/index.html`]);
  for (const name of Object.keys(files)) {
    assert.ok(!name.startsWith('/') && name.split('/').every((s) => s && s !== '..' && s !== '.') && !name.includes(':'), name);
  }
  assert.ok(!Object.values(files).includes('no'), 'unsafe paths are not fetched');
  assert.ok(files['errors.txt'].includes('3 files with unsafe paths not fetched'), files['errors.txt']);
});

test('a round number of artifacts alone no longer warns', async () => {
  const frames = Array.from({ length: 500 }, (_, i) => art(U(i + 1), `A ${i}`, { live: '' }));
  const { files } = await runArtifacts({ list: { frames, paging: { status: 'ok', added: 0 }, accountName: 'Mika', orgId: 'org-1' } });
  assert.ok(!files['errors.txt'] || !/artifact list/.test(files['errors.txt']), files['errors.txt']);
  assert.match(files['index.md'], /\*\*Listed by claude\.ai:\*\* 500/);
});

test('an artifact found only by paging is saved at its live version, with a warning that counts it', async () => {
  const frames = [art(U(1), 'Quick'), art(U(2), 'Paged', { live: '', paged: true })];
  const pages = { [U(1)]: livePage('Quick', { 'index.html': 'q' }), [U(2)]: livePage('Paged', { 'index.html': 'p' }) };
  const { files, fetcher } = await runArtifacts({ list: { frames, paging: { status: 'ok', added: 1 }, accountName: 'Mika', orgId: 'org-1' }, pages });
  const f2 = artFolder('Paged', U(2));
  assert.strictEqual(files[`${f2}/${LIVE}/index.html`], 'p');
  assert.strictEqual(JSON.parse(files[`${f2}/artifact.json`]).current, LIVE);
  assert.deepStrictEqual(fetcher.calls.filter((c) => c.action === 'publishedPageInfo').map((c) => [c.uuid, c.ver]), [[U(1), LIVE], [U(2), '']]);
  const errs = files['errors.txt'] || '';
  assert.strictEqual((errs.match(/quick list missed 1 artifact\b/g) || []).length, 1, errs);
  assert.ok(!/may be incomplete/.test(errs), errs);
  assert.match(files['index.md'], /\*\*Listed by claude\.ai:\*\* 2/);
});

test('a full list that could not be paged, or was cut at the page cap, warns that the export may be incomplete', async () => {
  const frames = [art(U(1), 'One')];
  const pages = { [U(1)]: livePage('One', { 'index.html': 'o' }) };
  const failed = await runArtifacts({ list: { frames, paging: { status: 'failed', code: 'HTTP 500' }, accountName: 'Mika', orgId: 'org-1' }, pages });
  assert.match(failed.files['errors.txt'], /could not be read in full \(HTTP 500\).*may be incomplete/, failed.files['errors.txt']);
  const capped = await runArtifacts({ list: { frames, paging: { status: 'capped', added: 0 }, accountName: 'Mika', orgId: 'org-1' }, pages });
  assert.match(capped.files['errors.txt'], /longer than this export reads.*may be incomplete/, capped.files['errors.txt']);
  const plainList = await runArtifacts({ frames, pages });
  assert.ok(!plainList.files['errors.txt'], 'a reply without paging (older content.js) warns nothing');
});

test('nothing private or token-shaped reaches a file', async () => {
  const TOKEN = 'Tk9pQzLmW7xR2vBn';
  const frameUrl = (u) => `https://${u}.frame.claudeusercontent.com/_f/${LIVE}/index.html?__frame_t=${TOKEN}`;
  const leaky = (f) => ({ ...f, owner_email: 'mika@example.com', owner_account: 'acct-777', thumbImgURL: frameUrl(f.slug), thumbDarkURLs: [frameUrl(f.slug)] });
  const frames = [
    leaky(art(U(1), `Report ${frameUrl(U(1))} end`)),
    leaky(art(U(2), 'Broken')),
    leaky(art(U(3), 'Rejected')),
    leaky(art(U(4), 'Typed', { typeTitle: `Kind ${frameUrl(U(4))}` })),
  ];
  const pages = {
    [U(1)]: livePage('Report', { 'index.html': 'report' }),
    [U(2)]: { error: { error: frameUrl(U(2)) } },
    [U(3)]: { title: 'Rejected', live: LIVE, versions: { [LIVE]: { rejected: [frameUrl(U(3))], files: { 'index.html': 'r' } } } },
    [U(4)]: livePage('Typed', { 'index.html': 't' }),
  };
  for (const options of [{}, { directory: new FakeDir() }]) {
    const { files } = await runArtifacts({ frames, pages, options });
    assert.ok(files['errors.txt'], 'the failures are reported');
    for (const [name, text] of Object.entries(files)) {
      for (const bad of ['mika@example.com', 'acct-777', '__frame_t', 'frame.claudeusercontent.com', TOKEN, '_thumb.img']) {
        assert.ok(!name.includes(bad) && !text.includes(bad), `${name} holds ${bad}`);
      }
    }
  }
});

test('a typed artifact is marked needs claude.ai to run; one with no own files has only artifact.json', async () => {
  const frames = [
    art(U(1), 'Design One', { typeSlug: DESIGN_TYPE, typeTitle: 'Design' }),
    art(U(2), 'Design Empty', { typeSlug: DESIGN_TYPE, typeTitle: 'Design' }),
    art(U(3), 'Uses Runtime'),
    art(U(4), 'Plain'),
    art(U(5), 'Skipped Runtime'),
  ];
  const pages = {
    [U(1)]: livePage('Design One', { 'index.html': '<div>d</div>' }),
    [U(2)]: livePage('Design Empty', { 'artifact-type/runtime.js': 'rt' }),
    [U(3)]: livePage('Uses Runtime', { 'index.html': '<script src="/_f/x/artifact-type/r.js"></script>' }),
    [U(4)]: livePage('Plain', { 'index.html': '<p>plain</p>' }),
    [U(5)]: livePage('Skipped Runtime', { 'index.html': '<p>s</p>' }, { runtimeSkipped: 2 }),
  };
  const { files } = await runArtifacts({ frames, pages });
  const meta = (name, n) => JSON.parse(files[`${artFolder(name, U(n))}/artifact.json`]);
  assert.deepStrictEqual([1, 2, 3, 4, 5].map((n) => meta(['Design_One', 'Design_Empty', 'Uses_Runtime', 'Plain', 'Skipped_Runtime'][n - 1], n).needsRuntime), [true, true, true, false, true]);
  const empty = artFolder('Design_Empty', U(2));
  assert.deepStrictEqual(Object.keys(files).filter((n) => n.startsWith(`${empty}/`)), [`${empty}/artifact.json`]);
  assert.match(meta('Design_Empty', 2).note, /open on claude\.ai/);
  const row = files['index.md'].split('\n').find((l) => l.includes('Design One'));
  assert.match(row, /needs claude\.ai to run/);
  assert.ok(!/needs claude\.ai to run/.test(files['index.md'].split('\n').find((l) => l.includes('Plain'))));
  assert.match(files['index.html'], /needs claude\.ai to run/);
});

test('a missing live version writes the no-published-version note without fetching', async () => {
  const frames = [art(U(1), 'Draft', { live: '' }), art(U(2), 'Odd', { live: 'bad ver!' })];
  const { files, fetcher } = await runArtifacts({ frames, pages: { [U(1)]: livePage('Draft', { 'index.html': 'x' }) } });
  assert.strictEqual(fetcher.calls.length, 0);
  for (const [name, n] of [['Draft', 1], ['Odd', 2]]) {
    const folder = artFolder(name, U(n));
    assert.deepStrictEqual(Object.keys(files).filter((f) => f.startsWith(`${folder}/`)), [`${folder}/artifact.json`]);
    const meta = JSON.parse(files[`${folder}/artifact.json`]);
    assert.strictEqual(meta.note, 'no published version');
    assert.deepStrictEqual([meta.current, meta.versions], [null, {}]);
  }
});

test('shared artifacts are exported and labelled shared with you', async () => {
  const frames = [art(U(1), 'Theirs', { rel: 'shared' }), art(U(2), 'Mine')];
  const pages = { [U(1)]: livePage('Theirs', { 'index.html': 'theirs' }), [U(2)]: livePage('Mine', { 'index.html': 'mine' }) };
  const { files } = await runArtifacts({ frames, pages });
  const folder = artFolder('Theirs', U(1));
  assert.strictEqual(files[`${folder}/${LIVE}/index.html`], 'theirs');
  const meta = JSON.parse(files[`${folder}/artifact.json`]);
  assert.strictEqual(meta.rel, 'shared');
  assert.match(meta.note, /shared with you/);
  assert.ok(!/shared with you/.test(JSON.parse(files[`${artFolder('Mine', U(2))}/artifact.json`]).note));
  assert.match(files['index.md'].split('\n').find((l) => l.includes('Theirs')), /shared with you/);
  assert.ok(!/shared with you/.test(files['index.md'].split('\n').find((l) => l.includes('[Mine]'))));
  assert.match(files['index.html'], /shared with you/);
});

test('an empty list or a failed list writes nothing and says why', async () => {
  const cases = [
    [{ frames: [] }, 'done', /^No artifacts on claude\.ai\.$/],
    [{ list: { frames: [{ slug: 'not-a-uuid', title: 'x' }], orgId: 'o' } }, 'done', /^No artifacts on claude\.ai\.$/],
    [{ list: { error: 'HTTP 401', status: 401 } }, 'failed', /^Sign in to claude\.ai, then try again\.$/],
    [{ list: { error: 'network' } }, 'failed', /artifact list.*network/],
    [{ list: { connectionError: 'x' } }, 'failed', /artifact list/],
  ];
  // What it says: the Done screen's notes, or the Export stopped screen's reason.
  const says = (r) => (r.outcome === 'done' ? r.notes.join(' ') : r.reason);
  for (const [run, outcome, text] of cases) {
    const picked = new FakeDir();
    const zip = await runArtifacts(run);
    assert.strictEqual(zip.saved, null);
    assert.strictEqual(zip.result.outcome, outcome);
    assert.match(says(zip.result), text);
    const disk = await runArtifacts({ ...run, options: { directory: picked } });
    assert.strictEqual(picked.entries.size, 0, 'no folder made');
    assert.match(says(disk.result), text);
  }
  const off = await runArtifacts({ frames: [art(U(1), 'x')], setup: (sb) => { sb.chrome.tabs.query = async () => [{ id: 1, url: 'https://example.com/' }]; } });
  assert.strictEqual(off.saved, null);
  assert.strictEqual(off.listCalls.length, 0);
  assert.match(off.result.reason, /navigate to claude\.ai/);
});

test('Export Artifacts leaves the export record alone', async () => {
  const stored = { exportRecord: { 'org-1': { at: '2026-01-05T00:00:00Z', chats: { a: '2026-01-01T00:00:00Z' } } }, exporterSettings: { megaZipScope: 'changes' } };
  const reads = [];
  const { store, saved } = await runArtifacts({
    frames: [art(U(1), 'One')], pages: { [U(1)]: livePage('One', { 'index.html': 'one' }) }, stored,
    setup: (sb) => {
      // The panel reads the record for its footer; this checks only the export.
      vm.runInContext("settings.megaZipScope = 'changes'; loadEverything = async () => {}", sb);
      const get = sb.chrome.storage.local.get;
      sb.chrome.storage.local.get = async (keys) => { reads.push(keys); return get(keys); };
    },
  });
  assert.ok(saved);
  assert.deepStrictEqual(store, stored);
  assert.ok(!JSON.stringify(reads).includes('exportRecord'), JSON.stringify(reads));
});

test('a page file named artifact.json or ARTIFACT.json keeps its name in its version folder', async () => {
  const frames = [art(U(1), 'Lower'), art(U(2), 'Upper')];
  const pages = {
    [U(1)]: livePage('Lower', { 'index.html': 'i', 'artifact.json': '{"mine":1}', 'sub/artifact.json': 'deep' }),
    [U(2)]: livePage('Upper', { 'index.html': 'i', 'ARTIFACT.json': '{"mine":2}' }),
  };
  const { files } = await runArtifacts({ frames, pages });
  const lower = artFolder('Lower', U(1));
  const upper = artFolder('Upper', U(2));
  assert.strictEqual(files[`${lower}/${LIVE}/artifact.json`], '{"mine":1}');
  assert.strictEqual(files[`${lower}/${LIVE}/sub/artifact.json`], 'deep');
  assert.strictEqual(JSON.parse(files[`${lower}/artifact.json`]).format, 2);
  assert.strictEqual(files[`${upper}/${LIVE}/ARTIFACT.json`], '{"mine":2}');
  assert.strictEqual(JSON.parse(files[`${upper}/artifact.json`]).format, 2);
  const meta = JSON.parse(files[`${lower}/artifact.json`]);
  assert.strictEqual(curVer(meta).files.find((f) => f.path === 'artifact.json').savedAs, 'artifact.json');
});

test('index.md escapes titles and link targets', async () => {
  const frames = [art(U(1), 'Evil](javascript:x) <b>bold</b> | pipe')];
  const pages = { [U(1)]: livePage('x', { 'page (1).html': 'p' }) };
  const { files } = await runArtifacts({ frames, pages });
  const md = files['index.md'];
  const row = md.split('\n').find((l) => l.includes('Evil'));
  assert.ok(!/[^\\]\]\(javascript:/.test(row), row);
  assert.ok(!row.includes('<b>'), row);
  assert.ok(!/[^\\]\| pipe/.test(row), row);
  const folder = artFolder(require('../export-core.js').safeFileTitle(frames[0].title), U(1));
  assert.ok(files[`${folder}/${LIVE}/page (1).html`], Object.keys(files).join());
  assert.ok(row.includes(`](${encodeURIComponent(folder)}/${LIVE}/page%20%281%29.html)`), row);
});

test('the recovery hint for artifact_export names Export Artifacts, and errors.txt does not say Conversation', () => {
  const c = vm.runInContext("new ExportErrorCollector(null, null, { label: 'Export Artifacts' })", exportPopup().sandbox);
  c.addWarning('artifact_export', 'x', 'y');
  assert.match(c.warnings[0].recovery, /Export Artifacts/);
  const report = c.generateErrorReport();
  assert.ok(!/Conversation/.test(report) && !/\*\*UUID:\*\*/.test(report), report.slice(0, 300));
  assert.match(report, /Export Artifacts/);
  const chat = vm.runInContext("new ExportErrorCollector('Chat', 'u1')", exportPopup().sandbox);
  chat.addWarning('upload', 'f', 'm');
  assert.match(chat.generateErrorReport(), /\*\*Conversation:\*\* Chat/);
});

test('EXPORT_BUTTONS lists the chat buttons and Export selected, whose label is fixed', () => {
  const fs = require('fs');
  const popup = exportPopup();
  const sb = popup.sandbox;
  assert.deepStrictEqual(plain(vm.runInContext('EXPORT_BUTTONS', sb)), ['exportMd', 'exportMdEmbed', 'exportZip', 'exportJson', 'exportSelected']);
  for (const page of ['popup.html', 'sidepanel.html']) {
    const html = fs.readFileSync(path.join(REPO, page), 'utf8');
    assert.match(html, /<button id="exportSelected"[^>]*>\s*<span>Export selected<\/span><span class="shortcut">Alt\+A<\/span>/, page);
    assert.ok(!/The current version of every artifact/.test(html), `${page}: the stale tooltip is gone`);
  }
});

test('index.html escapes everything from claude.ai and links only local files and claude.ai', async () => {
  const frames = [
    art(U(1), 'beta <img src=x onerror=alert(1)>', { typeTitle: '<script>alert(2)</script>', sourceSurface: '"onmouseover="x' }),
    art(U(2), 'Alpha & "quotes"'),
    art(U(3), 'gamma', { typeSlug: DOCS_TYPE, typeTitle: 'Docs' }),
  ];
  const pages = { [U(1)]: livePage('b', { 'pa ge#1.html': 'b' }), [U(2)]: livePage('a', { 'index.html': 'a' }) };
  const { files } = await runArtifacts({ frames, pages });
  const html = files['index.html'];
  const fnHtml = vm.runInContext('artifactsIndexHtml', exportPopup().sandbox);
  assert.strictEqual(typeof fnHtml, 'function');
  assert.ok(!/<script/i.test(html), 'no scripts');
  assert.ok(!html.includes('<img'), 'no tags from titles');
  assert.ok(html.includes('beta &lt;img src=x onerror=alert(1)&gt;'), html);
  assert.ok(html.includes('&lt;script&gt;alert(2)&lt;/script&gt;'));
  assert.ok(html.includes('&quot;onmouseover=&quot;x'));
  assert.ok(html.includes('Alpha &amp; &quot;quotes&quot;'));
  assert.match(html, /<head>\s*<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'none'">/);
  assert.ok(html.indexOf('Alpha') < html.indexOf('beta') && html.indexOf('beta') < html.indexOf('gamma'), 'sorted by title, ignoring case');
  const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
  assert.ok(hrefs.length >= 5, hrefs.join());
  for (const h of hrefs) {
    const remote = /^https:\/\/claude\.ai\/artifact\/[1-9A-HJ-NP-Za-km-z]+$/.test(h);
    const local = !h.includes(':') && !h.startsWith('/') && !h.split('/').includes('..');
    assert.ok(remote || local, h);
  }
  assert.ok(hrefs.includes(`${encodeURIComponent(artFolder(require('../export-core.js').safeFileTitle(frames[0].title), U(1)))}/${LIVE}/pa%20ge%231.html`), hrefs.join());
  for (const m of html.matchAll(/<a [^>]*href="https:[^"]*"[^>]*>/g)) assert.match(m[0], /rel="noopener noreferrer"/);
  assert.match(html, /prefers-color-scheme: dark/);
});

// ---- Export Artifacts: review fixes ----

test('listed is claude.ai\'s raw count, even when a frame is dropped', async () => {
  const frames = Array.from({ length: 60 }, (_, i) => art(U(i + 1), `A ${i}`, { live: '' }));
  frames[5] = { ...frames[5], slug: '../bad' };
  assert.strictEqual(require('../export-core.js').artifactsFromList({ frames }).listed, 60);
  const { files } = await runArtifacts({ frames });
  assert.match(files['index.md'], /\*\*Listed by claude\.ai:\*\* 60\n/);
  assert.match(files['index.html'], /Listed by claude\.ai: 60\b/);
  assert.strictEqual(JSON.parse(files['export-manifest.json']).listed, 60);
  assert.strictEqual(JSON.parse(files['export-manifest.json']).artifacts.length, 59);
  assert.strictEqual(files['index.md'].split('\n').filter((l) => /^\| \d+ \|/.test(l)).length, 59);
});

test('an artifact whose export throws unexpectedly still gets a row, a manifest entry and artifact.json', async () => {
  const frames = [art(U(1), 'Fine'), art(U(2), 'Throws'), art(U(3), 'Boom')];
  const pages = { [U(1)]: livePage('Fine', { 'index.html': 'fine' }), [U(2)]: livePage('Throws', { 'index.html': 'x' }), [U(3)]: livePage('Boom', { 'index.html': 'y' }) };
  const NOTE = 'not exported: unexpected error (see errors.txt)';
  const { files, result } = await runArtifacts({
    frames, pages, setup: (sb) => vm.runInContext(`(() => {
      const orig = fetchPublishedFiles;
      fetchPublishedFiles = async (o) => { if (o.uuid === '${U(2)}') throw new TypeError('boom'); return orig(o); };
      const title = safeFileTitle;
      safeFileTitle = (t) => { if (t === 'Boom') throw new RangeError('bad'); return title(t); };
    })()`, sb),
  });
  assert.strictEqual(files[`${artVer('Fine', U(1))}/index.html`], 'fine');
  const manifest = JSON.parse(files['export-manifest.json']);
  assert.strictEqual(manifest.artifacts.length, 3);
  for (const [name, uuid] of [['Throws', U(2)], ['Boom', U(3)]]) {
    const entry = manifest.artifacts.find((e) => e.uuid === uuid);
    assert.ok(entry, name);
    assert.strictEqual(entry.ver, '');
    const meta = JSON.parse(files[`${entry.folder}/artifact.json`]);
    assert.strictEqual(meta.note, NOTE);
    assert.deepStrictEqual([meta.format, meta.current, meta.versions], [2, LIVE, {}]);
    const mdRow = files['index.md'].split('\n').find((l) => l.includes(name));
    assert.ok(mdRow && mdRow.includes(NOTE), mdRow);
    const htmlRow = files['index.html'].split('\n').find((l) => l.startsWith('<tr><td>') && l.includes(name));
    assert.ok(htmlRow && htmlRow.includes(NOTE), htmlRow);
  }
  assert.strictEqual((files['errors.txt'].match(/unexpected error/g) || []).length, 2, files['errors.txt']);
  assert.deepStrictEqual([result.outcome, result.warnings > 0], ['done', true]);
});

test('an artifact with an empty rel is not labelled shared', async () => {
  const frames = [art(U(1), 'Blank', { rel: '' }), art(U(2), 'Given', { rel: 'shared' })];
  const pages = { [U(1)]: livePage('Blank', { 'index.html': 'a' }), [U(2)]: livePage('Given', { 'index.html': 'b' }) };
  const { files } = await runArtifacts({ frames, pages });
  const row = (n) => files['index.md'].split('\n').find((l) => l.includes(n));
  assert.ok(!row('Blank').includes('shared with you'), row('Blank'));
  assert.ok(row('Given').includes('shared with you'), row('Given'));
  assert.ok(!files['index.html'].split('\n').find((l) => l.includes('Blank')).includes('shared with you'));
  assert.ok(!JSON.parse(files[`${artFolder('Blank', U(1))}/artifact.json`]).note.includes('shared'));
});

test('a shared artifact links its start file locally only for types the viewer would open', async () => {
  const blocked = ['page.shtml', 'page.xht', 'page.xml', 'page.xsl', 'index.html', 'art.svg'];
  const names = [...blocked, 'notes.pdf'];
  const frames = names.map((n, i) => art(U(i + 1), `S${i}`, { rel: 'shared' })).concat([art(U(20), 'OwnXml'), art(U(21), 'OwnSvg')]);
  const pages = {};
  names.forEach((n, i) => { pages[U(i + 1)] = livePage(`S${i}`, { [n]: 'x' }); });
  pages[U(20)] = livePage('OwnXml', { 'page.xml': 'x' });
  pages[U(21)] = livePage('OwnSvg', { 'art.svg': 'x' });
  const { files } = await runArtifacts({ frames, pages });
  blocked.forEach((n, i) => {
    const folder = encodeURIComponent(artFolder(`S${i}`, U(i + 1)));
    assert.ok(!files['index.md'].includes(`${folder}/`), `${n}: no local link in index.md`);
    assert.ok(!files['index.html'].includes(`${folder}/`), `${n}: no local link in index.html`);
  });
  const pdf = encodeURIComponent(artFolder('S6', U(7)));
  assert.ok(files['index.md'].includes(`(${pdf}/${LIVE}/notes.pdf)`), files['index.md']);
  assert.ok(files['index.html'].includes(`href="${pdf}/${LIVE}/notes.pdf"`));
  for (const [t, n, u] of [['OwnXml', 'page.xml', U(20)], ['OwnSvg', 'art.svg', U(21)]]) {
    const href = `${encodeURIComponent(artFolder(t, u))}/${LIVE}/${n}`;
    assert.ok(files['index.md'].includes(`(${href})`), `own ${n} keeps its link`);
    assert.ok(files['index.html'].includes(`href="${href}"`));
  }
});

test('export-core.js and the viewer allow the same file types to open', () => {
  const core = require('../export-core.js');
  const viewer = require('../viewer/viewer-logic.js');
  assert.deepStrictEqual([...core.OPENABLE_EXTENSIONS].sort(), [...viewer.OPENABLE_EXTENSIONS].sort());
  for (const name of ['a.pdf', 'b/c.PNG', 'x.html', 'y.svg', 'z.xml', 'noext', 'q.tar.gz']) {
    assert.strictEqual(core.openableName(name), viewer.openableHref(encodeURIComponent(name).replace(/%2F/g, '/')), name);
  }
});

test('errors.txt for Export Artifacts has no chat recovery steps', () => {
  const c = vm.runInContext("new ExportErrorCollector(null, null, { label: 'Export Artifacts' })", exportPopup().sandbox);
  c.addWarning('artifact_export', 'x', 'y');
  const report = c.generateErrorReport();
  assert.ok(!/Manual Recovery Steps|Debugging Tips|replay_bash|original\.json/.test(report), report);
  assert.ok(report.includes('Sign in to claude.ai, open the artifact there, and run Export Artifacts again.'), report);
  const chat = vm.runInContext("new ExportErrorCollector('Chat', 'u1')", exportPopup().sandbox);
  chat.addWarning('upload', 'f', 'm');
  assert.match(chat.generateErrorReport(), /Manual Recovery Steps[\s\S]*Debugging Tips/);
});

test('an artifact folder\'s title part is at most 200 UTF-8 bytes', async () => {
  const letter = '\u{1D400}';
  const title = letter.repeat(60);
  const { files } = await runArtifacts({ frames: [art(U(1), title)], pages: { [U(1)]: livePage(title, { 'index.html': 'a' }) } });
  const folder = `${letter.repeat(50)}_${uuidToBase58(U(1))}`;
  assert.strictEqual(files[`${folder}/${LIVE}/index.html`], 'a', Object.keys(files).join());
});

test('a throw mid-export ends the run failed, shows Export stopped and re-enables the buttons', async () => {
  const frames = [art(U(1), 'One')];
  const pages = { [U(1)]: livePage('One', { 'index.html': 'a' }) };
  const setup = (sb) => vm.runInContext("settings.megaFormat = 'zip'; settings.exportAllChats = false; artifactsIndexMd = () => { throw new Error('boom'); }", sb);
  const { result, popup, saved } = await runArtifacts({ frames, pages, setup });
  const sb = popup.sandbox;
  assert.strictEqual(saved, null);
  assert.strictEqual(result.outcome, 'failed');
  assert.match(result.reason, /boom/);
  assert.notStrictEqual(sb.document.getElementById('progress').style.display, 'block', 'the chat card\'s progress bar is not used');
  vm.runInContext('panel.onClaude = true; renderEverything()', sb);
  assert.strictEqual(sb.document.getElementById('exportSelected').disabled, false);
  await sb.document.getElementById('exportSelected').handlers.click();
  assert.strictEqual(sb.document.getElementById('screen-stopped').hidden, false);
  assert.match(sb.document.getElementById('stoppedReason').textContent, /boom/);
  assert.strictEqual(sb.document.getElementById('exportSelected').disabled, false);
});

test('Cowork and Code artifacts listed without checksums are saved unverified', async () => {
  const frames = [art(U(1), 'Cowork Page', { sourceSurface: 'cowork' }), art(U(2), 'Shared', { rel: 'shared' }), art(U(3), 'Checked')];
  const pages = {
    [U(1)]: livePage('Cowork Page', { 'index.html': { body: '<p>cowork</p>', unverified: true } }),
    [U(2)]: livePage('Shared', { 'index.html': { body: '<p>s</p>', unverified: true }, 'gone.css': { body: '', unverified: true, error: { error: 'HTTP 404', status: 404 } } }),
    [U(3)]: livePage('Checked', { 'index.html': 'ok' }),
  };
  const { files, fetcher } = await runArtifacts({ frames, pages });
  const meta = (name, n) => JSON.parse(files[`${artFolder(name, U(n))}/artifact.json`]);
  assert.strictEqual(files[`${artVer('Cowork_Page', U(1))}/index.html`], '<p>cowork</p>');
  const cowork = meta('Cowork_Page', 1);
  assert.deepStrictEqual(curVer(cowork).files, [{ path: 'index.html', savedAs: 'index.html', size: 13, contentType: 'text/html', sha256: sha('<p>cowork</p>'), verified: false }]);
  assert.strictEqual(curVer(cowork).incomplete, false);
  assert.strictEqual(cowork.note, "files not checked against claude.ai's checksum");
  const shared = meta('Shared', 2);
  assert.deepStrictEqual(curVer(shared).files.map((f) => [f.path, f.sha256, f.verified]), [['index.html', sha('<p>s</p>'), false], ['gone.css', null, false]]);
  assert.deepStrictEqual(curVer(shared).missing, ['gone.css']);
  assert.match(shared.note, /^shared with you; .*files not checked against claude\.ai's checksum/);
  const checked = meta('Checked', 3);
  assert.strictEqual(curVer(checked).files[0].verified, true);
  assert.strictEqual(checked.note, '');
  const call = fetcher.calls.find((c) => c.action === 'publishedPageFile' && c.uuid === U(1));
  assert.ok(call.size == null, 'no size is claimed for an unlisted size');
  assert.match(files['index.md'].split('\n').find((l) => l.includes('Cowork Page')), /files not checked against claude\.ai's checksum/);
  for (const [k, t] of Object.entries(files)) assert.ok(!/__frame_t|frame\.claudeusercontent/.test(t), k);
});

test('files of unknown size count their real bytes against the 50 MB page total', async () => {
  const big = 'a'.repeat(26 * 1024 * 1024);
  const frames = [art(U(1), 'Big')];
  const pages = { [U(1)]: livePage('Big', { 'index.html': { body: big, unverified: true }, 'more.html': { body: big, unverified: true } }) };
  const { files } = await runArtifacts({ frames, pages });
  const folder = artFolder('Big', U(1));
  assert.strictEqual(files[`${folder}/${LIVE}/index.html`].length, big.length);
  assert.strictEqual(files[`${folder}/${LIVE}/more.html`], undefined);
  const meta = JSON.parse(files[`${folder}/artifact.json`]);
  assert.deepStrictEqual(curVer(meta).missing, ['more.html']);
  assert.match(files['errors.txt'], /more\.html \(page over 50 MB\)/);
});

// ---- Export Artifacts: viewer data, card pictures and preview parts ----
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('picture bytes')]);
// The frame host's answer for a card picture (see runArtifacts' thumbs).
const pic = (body = PNG, type = 'image/png', extra = {}) => ({ status: 200, type, body, ...extra });
// Runs a part's body and returns { n, data }.
const readPart = (body) => {
  let got = null;
  new Function('window', body)({ __archivePart: (n, d) => { got = { n, d }; } });
  return got;
};
const partsOf = (files) => Object.keys(files).filter((n) => n.startsWith('viewer-files/part-')).sort().map((n) => readPart(files[n]));
const payloadOf = (files, view) => partsOf(files).find((p) => p.n === view.part).d[view.key];

test('each artifact gets a view record', async () => {
  const frames = [
    art(U(1), 'Quarterly Report', { public: true }),
    art(U(2), 'Game'),
    art(U(3), 'Plan', { typeSlug: DOCS_TYPE, typeTitle: 'Docs' }),
    art(U(4), 'Mock', { typeSlug: DESIGN_TYPE, typeTitle: 'Design', rel: 'shared' }),
    art(U(5), 'Broken'),
    art(U(6), 'Notes'),
  ];
  const pages = {
    [U(1)]: livePage('Quarterly Report', { 'index.html': '<h1>Q</h1>' }),
    [U(2)]: livePage('Game', { 'index.html': '<script src="app.js"></script>', 'app.js': 'go()', 'img/logo.svg': '<svg/>' }),
    [U(4)]: livePage('Mock', { 'index.html': '<div>m</div>' }),
    [U(6)]: livePage('Notes', { 'notes.md': '# n' }),
  };
  for (const options of [{}, { directory: new FakeDir() }]) {
    const { views } = await runArtifacts({ frames, pages, options });
    assert.strictEqual(views.length, 6);
    // Every view carries its versions for the version menu (v1.21); the rest of the record is pinned below.
    assert.ok(views.every((v) => Array.isArray(v.versions)));
    const game = (({ versions, ...rest }) => rest)(views[1]);
    const id = uuidToBase58(U(2));
    assert.deepStrictEqual(game, {
      id, title: 'Game', kind: 'Page', typed: false, docs: false, shared: false, foreign: false, public: false,
      createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', folder: artVer('Game', U(2)),
      start: 'index.html', startSaved: 'index.html', startKind: 'html', startSize: 30, tooLarge: false, startMissing: false, missingCount: 0,
      files: [{ path: 'index.html', savedAs: 'index.html', kind: 'html', verified: true }, { path: 'app.js', savedAs: 'app.js', kind: 'js', verified: true },
        { path: 'img/logo.svg', savedAs: 'img/logo.svg', kind: 'svg', verified: true }],
      needsRuntime: false, notExported: false, note: '', url: `https://claude.ai/artifact/${id}`, thumb: null, zip: `${artFolder('Game', U(2))}/${LIVE}.zip`, part: game.part, key: 'a1',
    });
    assert.ok(Number.isInteger(game.part) && game.part >= 1);
    assert.strictEqual(views[0].public, true);
    assert.deepStrictEqual([views[2].docs, views[2].typed, views[2].kind, views[2].start, views[2].startKind, views[2].notExported, views[2].part], [true, true, 'Docs', null, null, false, null]);
    assert.deepStrictEqual([views[3].docs, views[3].typed, views[3].kind, views[3].shared, views[3].needsRuntime], [false, true, 'Design', true, true]);
    assert.strictEqual(views[4].notExported, true);
    assert.match(views[4].note, /not exported/);
    assert.deepStrictEqual([views[4].files, views[4].part], [[], null]);
    assert.strictEqual(views[5].startKind, 'md');
  }
});

test('preview texts and images go to parts, flushed per artifact', async () => {
  const small = Buffer.concat([PNG, Buffer.from('a')]);
  const big = Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024)]);
  const frames = [art(U(1), 'Site'), art(U(2), 'Other')];
  const pages = {
    [U(1)]: livePage('Site', {
      'index.html': '<link rel="stylesheet" href="app.css"><img src="img/a.png">', 'app.css': 'body{}',
      'img/a.png': { body: small, type: 'image/png' }, 'big.png': { body: big, type: 'image/png' }, 'data.bin': { body: 'xx', type: 'application/octet-stream' },
    }),
    [U(2)]: livePage('Other', { 'index.html': 'other' }),
  };
  const zipped = await runArtifacts({ frames, pages });
  const site = zipped.views[0];
  const payload = payloadOf(zipped.files, site);
  assert.deepStrictEqual(payload.texts, [['index.html', pages[U(1)].versions[LIVE].files['index.html']], ['app.css', 'body{}']]);
  assert.deepStrictEqual(payload.images, [['img/a.png', `data:image/png;base64,${small.toString('base64')}`]]);
  assert.strictEqual(zipped.raw[`${artVer('Site', U(1))}/big.png`].length, big.length, 'the big image is still saved');

  // Folder mode, with parts that close per artifact: each part is written before that artifact's flush.
  const picked = new FakeDir();
  const disk = await runArtifacts({
    frames, pages, options: { directory: picked },
    setup: (sb) => vm.runInContext(`(() => {
      CTViewer.PART_LIMIT = 10;
      const orig = createDiskFolder;
      globalThis.__log = [];
      createDiskFolder = (h) => {
        const f = orig(h);
        const file = f.file, flush = f.flush;
        f.file = function (p, c, o) { __log.push('file ' + p); return file.call(this, p, c, o); };
        f.flush = async function () { __log.push('flush'); return flush.call(this); };
        return f;
      };
    })()`, sb),
  });
  const log = disk.popup.sandbox.__log;
  for (const view of disk.views) {
    // view.folder is the version folder; artifact.json is beside it.
    const meta = log.indexOf(`file ${view.folder.replace(/\/[^/]+$/, '')}/artifact.json`);
    const part = log.indexOf(`file viewer-files/part-${String(view.part).padStart(4, '0')}.js`);
    const nextFlush = log.indexOf('flush', meta);
    assert.ok(meta >= 0 && part > meta && part < nextFlush, JSON.stringify(log));
  }
  assert.deepStrictEqual(partsOf(disk.files).map((p) => p.n), [1, 2]);
  assert.deepStrictEqual(payloadOf(disk.files, disk.views[0]), payload);
});

test('a start file over 2 MB gets no text', async () => {
  const body = '<p>' + 'x'.repeat(2 * 1024 * 1024) + '</p>';
  const frames = [art(U(1), 'Huge')];
  const pages = { [U(1)]: livePage('Huge', { 'index.html': body, 'app.css': 'a{}' }) };
  const { views, files } = await runArtifacts({ frames, pages });
  assert.strictEqual(views[0].startSize, body.length);
  assert.strictEqual(views[0].tooLarge, true);
  assert.deepStrictEqual(payloadOf(files, views[0]).texts, [['app.css', 'a{}']]);
});

test('card pictures are saved outside artifact folders', async () => {
  const frames = [art(U(1), 'One'), art(U(2), 'Two'), art(U(3), 'Three'), art(U(4), 'Four', { typeSlug: DOCS_TYPE, typeTitle: 'Docs' })];
  const pages = { [U(1)]: livePage('One', { 'index.html': 'one' }), [U(2)]: livePage('Two', { 'index.html': 'two' }), [U(3)]: livePage('Three', { 'index.html': 'three' }) };
  const thumbs = { [U(1)]: pic(), [U(2)]: { error: 'no picture' }, [U(3)]: { status: 401 }, [U(4)]: pic() };
  for (const options of [{}, { directory: new FakeDir() }]) {
    const { files, raw, views, result, fetcher, thumbCalls, frameReqs } = await runArtifacts({ frames, pages, thumbs, options });
    assert.deepStrictEqual(thumbCalls, [U(1), U(2), U(3), U(4)], 'one after another, Docs included');
    assert.deepStrictEqual(frameReqs.map((r) => r.url.slice(8, 44)), [U(1), U(3), U(4)]);
    for (const r of frameReqs) {
      assert.strictEqual(r.opts.credentials, 'omit');
      assert.strictEqual(r.opts.referrerPolicy, 'no-referrer');
      assert.strictEqual(r.opts.redirect, 'error');
    }
    const p1 = `viewer-files/thumbs/${uuidToBase58(U(1))}.png`;
    const p4 = `viewer-files/thumbs/${uuidToBase58(U(4))}.png`;
    assert.ok(raw[p1].equals(PNG));
    assert.ok(raw[p4].equals(PNG));
    assert.deepStrictEqual(Object.keys(files).filter((n) => n.startsWith('viewer-files/thumbs/')).sort(), [p1, p4].sort());
    assert.strictEqual(JSON.parse(files[`${artFolder('One', U(1))}/artifact.json`]).thumb, p1);
    assert.ok(!('thumb' in JSON.parse(files[`${artFolder('Two', U(2))}/artifact.json`])));
    assert.ok(!('thumb' in JSON.parse(files[`${artFolder('Three', U(3))}/artifact.json`])));
    assert.deepStrictEqual(views.map((v) => v.thumb), [p1, null, null, p4]);
    assert.ok(!files['errors.txt'], files['errors.txt']);
    assert.strictEqual(result.warnings, 0);
    assert.strictEqual(fetcher.count('publishedPageInfo', U(3)), 1, 'a 401 picture does not sign the export out');
    assert.strictEqual(files[`${artVer('Three', U(3))}/index.html`], 'three');
  }
});

test('the Settings checkbox names web images and artifact card pictures', () => {
  for (const page of ['popup.html', 'sidepanel.html']) {
    const html = fs.readFileSync(path.join(__dirname, '..', page), 'utf8');
    const label = /<label class="row">\s*<span class="row-text"><span>([^<]*)<\/span><span class="sub">([^<]*)<\/span><\/span>\s*<input type="checkbox" id="webImages">/.exec(html);
    assert.ok(label, page);
    assert.strictEqual(label[1], 'Web images and card pictures');
    assert.strictEqual(label[2], 'Chrome asks once, during a ZIP export. If you say no, cards show tiles.');
  }
});

test('without the optional permission no picture is asked for or fetched', async () => {
  const frames = [art(U(1), 'One'), art(U(2), 'Two')];
  const pages = { [U(1)]: livePage('One', { 'index.html': 'one' }), [U(2)]: livePage('Two', { 'index.html': 'two' }) };
  const { files, views, result, thumbCalls, frameReqs, permissionRequests } = await runArtifacts({ frames, pages, thumbs: { [U(1)]: pic(), [U(2)]: pic() }, granted: false });
  assert.deepStrictEqual(thumbCalls, []);
  assert.deepStrictEqual(frameReqs, []);
  assert.deepStrictEqual(permissionRequests, [], 'the export itself never asks; the click does');
  assert.deepStrictEqual(views.map((v) => v.thumb), [null, null]);
  assert.ok(!Object.keys(files).some((n) => n.startsWith('viewer-files/thumbs/')));
  const need = '0 of 2 (needs the web images permission: Settings, Save web images and artifact card pictures)';
  assert.ok(files['index.md'].includes(`**Card pictures:** ${need}`), files['index.md']);
  assert.ok(files['index.html'].includes(`Card pictures: ${need}`));
  assert.strictEqual(JSON.parse(files['export-manifest.json']).thumbs, 0);
  assert.ok(!files['errors.txt'], files['errors.txt']);
  assert.strictEqual(result.warnings, 0);
  assert.ok(result.notes.includes('Card pictures need the web images permission (Settings).'), JSON.stringify(result.notes));
  const disk = await runArtifacts({ frames, pages, granted: false, options: { directory: new FakeDir() } });
  assert.ok(disk.result.notes.includes('Card pictures need the web images permission (Settings).'), JSON.stringify(disk.result.notes));
  assert.ok(disk.files['index.md'].includes(`**Card pictures:** ${need}`));
  const ok = await runArtifacts({ frames, pages, thumbs: { [U(1)]: pic() } });
  assert.ok(!ok.result.notes.join(' ').includes('permission'), JSON.stringify(ok.result.notes));
  assert.ok(!ok.files['index.md'].includes('permission') && !ok.files['index.html'].includes('needs the web images'));
});

test('Export Artifacts asks for the permission in a ZIP export\'s click, only when it is not granted; never in folder mode', async () => {
  const tick = () => new Promise((r) => setTimeout(r, 5));
  for (const [granted, format] of [[false, 'zip'], [true, 'zip'], [false, 'folder'], [true, 'folder']]) {
    const order = [];
    let release;
    const popup = loadPopup({
      before: (sb) => {
        sb.chrome.permissions = {
          contains: async () => granted,
          request: (o) => { order.push(['request', o.origins.join()]); return new Promise((r) => { release = r; }); },
        };
      },
    });
    const sb = popup.sandbox;
    await tick();
    vm.runInContext(`settings.megaFormat = '${format}'; settings.exportAllChats = false`, sb);
    let ran = null;
    vm.runInContext('exportArtifacts = async (o) => { globalThis.__ran = o; }', sb);
    sb.window.showDirectoryPicker = async () => { order.push(['picker']); return new FakeDir(); };
    const clicked = sb.document.getElementById('exportSelected').handlers.click();
    // Synchronously in the click: the request (ZIP, when not granted). Folder mode only opens the picker, which
    // needs the click's activation.
    const want = format === 'folder' ? [['picker']] : granted ? [] : [['request', 'https://*/*']];
    assert.deepStrictEqual(order, want, `${granted} ${format}`);
    if (release) release(true);
    await clicked;
    ran = sb.__ran;
    assert.ok(ran, 'export ran');
    assert.strictEqual(!!ran.directory, format === 'folder');
    if (granted || format === 'folder') assert.ok(!ran.ask, `${granted} ${format}`);
    else assert.strictEqual(await ran.ask, true);
    release = null;
  }
});

test('a 403 picture asks content.js for a fresh URL once per export', async () => {
  const frames = [art(U(1), 'One', { live: '' }), art(U(2), 'Two', { live: '' }), art(U(3), 'Three', { live: '' })];
  const thumbs = {
    [U(1)]: (url, n) => (n === 1 ? { status: 403 } : pic()),
    [U(2)]: () => ({ status: 403 }),
    [U(3)]: pic(),
  };
  const { views, thumbCalls, frameReqs, files } = await runArtifacts({ frames, thumbs });
  assert.deepStrictEqual(thumbCalls, [U(1), { uuid: U(1), refresh: true }, U(2), U(3)]);
  assert.deepStrictEqual(frameReqs.map((r) => /TOKEN(\d)X/.exec(r.url)[1] + r.url.slice(8, 16)), ['0' + U(1).slice(0, 8), '1' + U(1).slice(0, 8), '1' + U(2).slice(0, 8), '1' + U(3).slice(0, 8)]);
  assert.deepStrictEqual(views.map((v) => !!v.thumb), [true, false, true]);
  assert.ok(!files['errors.txt']);
});

test('a picture that is not a PNG, JPEG or WebP is left out', async () => {
  const frames = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => art(U(n), `A${n}`, { live: '' }));
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1]);
  const WEBP = Buffer.from('RIFF\0\0\0\0WEBPVP8 ');
  let streamed = null;
  const thumbs = {
    [U(1)]: pic(PNG, 'image/svg+xml'),
    [U(2)]: pic(Buffer.from('<svg/>')),
    [U(3)]: pic(PNG, 'TEXT/html; charset=utf-8'),
    [U(4)]: pic(Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)])),
    [U(5)]: pic(JPEG, 'application/octet-stream'),
    [U(6)]: pic(WEBP, ''),
    [U(7)]: () => { streamed = { stream: [PNG, Buffer.alloc(2 * 1024 * 1024)], type: 'image/png' }; return streamed; },
    [U(8)]: () => { throw new Error('network'); },
    [U(9)]: pic(Buffer.alloc(0)),
  };
  const { files, views } = await runArtifacts({ frames, thumbs });
  assert.deepStrictEqual(views.map((v) => v.thumb), [null, null, null, null, `viewer-files/thumbs/${uuidToBase58(U(5))}.jpg`, `viewer-files/thumbs/${uuidToBase58(U(6))}.webp`, null, null, null]);
  assert.ok(!files['errors.txt']);
});

test('no picture is asked for after claude.ai signs the export out', async () => {
  const frames = [art(U(1), 'One'), art(U(2), 'Two'), art(U(3), 'Three')];
  const pages = { [U(1)]: livePage('One', { 'index.html': 'one' }), [U(2)]: { error: { error: 'HTTP 401', status: 401 } } };
  const { thumbCalls } = await runArtifacts({ frames, pages, thumbs: { [U(1)]: pic() } });
  assert.deepStrictEqual(thumbCalls, [U(1)]);
});

test('index and manifest count card pictures', async () => {
  const frames = [art(U(1), 'One'), art(U(2), 'Two'), art(U(3), 'Three')];
  const { files } = await runArtifacts({ frames, thumbs: { [U(2)]: pic() } });
  assert.match(files['index.md'], /\*\*Card pictures:\*\* 1 of 3/);
  assert.match(files['index.html'], /Card pictures: 1 of 3/);
  assert.strictEqual(JSON.parse(files['export-manifest.json']).thumbs, 1);
});

test('artifact.json (format 2) has start and public, and the version its files', async () => {
  const frames = [art(U(1), 'Game', { sourceSurface: 'code', public: true }), art(U(2), 'Plan', { typeSlug: DOCS_TYPE, typeTitle: 'Docs' })];
  const pages = { [U(1)]: livePage('Game', { 'index.html': '<script src="app.js"></script>', 'app.js': 'go()' }) };
  const { files } = await runArtifacts({ frames, pages });
  const game = JSON.parse(files[`${artFolder('Game', U(1))}/artifact.json`]);
  const id = uuidToBase58(U(1));
  const v = game.versions[LIVE];
  assert.deepStrictEqual({ ...game, versions: { [LIVE]: { ...v, files: v.files.map((f) => f.path) } } }, {
    format: 2, uuid: U(1), shortId: id, url: `https://claude.ai/artifact/${id}`, title: 'Game', typeTitle: '', sourceSurface: 'code', rel: 'mine', public: true,
    createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', listed: true, current: LIVE, start: 'index.html', needsRuntime: false, note: '', order: [LIVE],
    versions: { [LIVE]: { folder: LIVE, files: ['index.html', 'app.js'], start: 'index.html', startSaved: 'index.html', incomplete: false, missing: [], saved: true, zip: `${LIVE}.zip`, publishedIn: [] } },
  });
  const plan = JSON.parse(files[`${artFolder('Plan', U(2))}/artifact.json`]);
  assert.deepStrictEqual([plan.start, plan.public, plan.note], [null, false, DOCS_NOTE]);
});

test('index.html and index.md drop a shared artifact\'s local HTML link; index.html links the viewer when built', async () => {
  const frames = [art(U(1), 'Theirs', { rel: 'shared' }), art(U(2), 'Mine'), art(U(3), 'Their picture', { rel: 'shared' }), art(U(4), 'Their svg', { rel: 'shared' })];
  const pages = {
    [U(1)]: livePage('Theirs', { 'deck.html': '<h1>t</h1>' }), [U(2)]: livePage('Mine', { 'index.html': 'm' }),
    [U(3)]: livePage('Their picture', { 'a.png': { body: PNG, type: 'image/png' } }), [U(4)]: livePage('Their svg', { 'a.svg': '<svg/>' }),
  };
  const { files } = await runArtifacts({ frames, pages });
  const html = files['index.html'];
  const htmlRow = (t) => html.split('\n').find((l) => l.startsWith('<tr><td>') && l.includes(t));
  const mdRow = (t) => files['index.md'].split('\n').find((l) => l.includes(t));
  for (const t of ['Theirs', 'Their svg']) {
    assert.ok(!/href="(?!https:)/.test(htmlRow(t)), htmlRow(t));
    assert.ok(htmlRow(t).includes('https://claude.ai/artifact/'), htmlRow(t));
    assert.ok(!/\]\((?!https:)/.test(mdRow(t)), mdRow(t));
    assert.ok(mdRow(t).includes('[claude.ai](https://claude.ai/artifact/'), mdRow(t));
  }
  assert.ok(htmlRow('Mine').includes(`href="${artVer('Mine', U(2))}/index.html"`), htmlRow('Mine'));
  assert.ok(htmlRow('Their picture').includes('/a.png"'), 'a shared picture keeps its link');
  assert.ok(mdRow('[Mine]'), files['index.md']);
  assert.ok(html.includes('<a href="viewer.html">'), 'the viewer link when it was built');
  const failed = await runArtifacts({ frames, pages, assets: false });
  assert.ok(!failed.files['index.html'].includes('viewer.html'), 'no viewer link when none was built');
  const built = await runArtifacts({ frames, pages, assets: false, setup: (sb) => vm.runInContext('writeArtifactsViewer = async () => true', sb) });
  assert.match(built.files['index.html'], /<a href="viewer\.html">/);
});

test('no picture URL or token reaches any file, status or console', async () => {
  const frames = [art(U(1), 'One'), art(U(2), 'Two', { live: '' }), art(U(3), 'Plan', { typeSlug: DOCS_TYPE, typeTitle: 'Docs' }), art(U(4), 'Four', { live: '' }), art(U(5), 'Five', { live: '' })];
  const pages = { [U(1)]: livePage('One', { 'index.html': '<p>one</p>', 'a.png': { body: PNG, type: 'image/png' } }) };
  const thumbs = {
    [U(1)]: pic(), [U(2)]: { status: 500 }, [U(3)]: (url, n) => (n === 1 ? { status: 403 } : pic()),
    [U(4)]: (url) => { throw new Error(`failed ${url}`); }, [U(5)]: pic(Buffer.from('<p>not a picture</p>'), 'text/html'),
  };
  for (const options of [{}, { directory: new FakeDir() }]) {
    const { files, views, result, frameReqs, consoleCalls } = await runArtifacts({ frames, pages, thumbs, options });
    assert.ok(frameReqs.length >= 5, 'the URL went through the popup');
    assert.ok(Object.keys(files).some((n) => n.startsWith('viewer-files/part-')));
    const all = { ...files, 'views.json': JSON.stringify(views), result: JSON.stringify(result), console: JSON.stringify(consoleCalls) };
    for (const [name, text] of Object.entries(all)) {
      for (const bad of ['claudeusercontent', '__frame_t', '_thumb.img', 'TOKEN0', 'TOKEN1']) assert.ok(!name.includes(bad) && !text.includes(bad), `${name} holds ${bad}`);
    }
    assert.ok(!files['errors.txt'], 'a picture never warns');
  }
});

test('an artifact that throws unexpectedly still gets a view', async () => {
  const frames = [art(U(1), 'Fine'), art(U(2), 'Boom', { rel: 'shared' })];
  const pages = { [U(1)]: livePage('Fine', { 'index.html': 'fine' }), [U(2)]: livePage('Boom', { 'index.html': 'y' }) };
  const { views } = await runArtifacts({
    frames, pages, setup: (sb) => vm.runInContext(`(() => {
      const title = safeFileTitle;
      safeFileTitle = (t) => { if (t === 'Boom') throw new RangeError('bad'); return title(t); };
    })()`, sb),
  });
  assert.strictEqual(views.length, 2);
  const boom = views[1];
  assert.deepStrictEqual([boom.id, boom.title, boom.notExported, boom.shared, boom.part, boom.thumb, boom.start, boom.files],
    [uuidToBase58(U(2)), 'Boom', true, true, null, null, null, []]);
  assert.strictEqual(boom.note, 'not exported: unexpected error (see errors.txt)');
});

test('a throwing parts step or picture step leaves the artifact exported', async () => {
  const frames = [art(U(1), 'One'), art(U(2), 'Two')];
  const pages = { [U(1)]: livePage('One', { 'index.html': 'one' }), [U(2)]: livePage('Two', { 'index.html': 'two' }) };
  const { views, files, result } = await runArtifacts({
    frames, pages, thumbs: { [U(2)]: pic() },
    setup: (sb) => vm.runInContext(`(() => {
      const orig = CTViewer.artifactViewParts;
      CTViewer.artifactViewParts = (o) => { const p = orig(o); return { add: () => { throw new Error('parts'); }, drain: p.drain, flush: p.flush, count: 0 }; };
      const thumb = saveArtifactThumb;
      saveArtifactThumb = async (root, uuid, ...rest) => { if (uuid === '${U(2)}') throw new Error('picture'); return thumb(root, uuid, ...rest); };
    })()`, sb),
  });
  assert.deepStrictEqual(views.map((v) => [v.notExported, v.part, v.key, v.thumb]), [[false, null, null, null], [false, null, null, null]]);
  assert.ok(!files['errors.txt'], files['errors.txt']);
  assert.strictEqual(result.warnings, 0);
  assert.ok(!JSON.parse(files[`${artFolder('One', U(1))}/artifact.json`]).incomplete);
});

test('large exports stay bounded', async () => {
  const many = Array.from({ length: 1000 }, (_, i) => art(U(i + 1), `A ${i}`, { live: '' }));
  const { views } = await runArtifacts({ frames: many });
  assert.strictEqual(views.length, 1000);
  assert.ok(views.every((v) => v.part === null));

  const huge = 'x'.repeat(30 * 1024 * 1024);
  const frames = [art(U(1), 'Big page'), art(U(2), 'Big script'), art(U(3), 'Small'), art(U(4), 'Later')];
  const pages = {
    [U(1)]: livePage('Big page', { 'index.html': huge }),
    [U(2)]: livePage('Big script', { 'index.html': '<script src="app.js"></script>', 'app.js': huge }),
    [U(3)]: livePage('Small', { 'index.html': 's'.repeat(100) }),
    [U(4)]: livePage('Later', { 'index.html': 'l'.repeat(100) }),
  };
  const { views: v, files } = await runArtifacts({ frames, pages, setup: (sb) => vm.runInContext('CTViewer.ARTIFACT_PARTS_BUDGET = 300', sb) });
  assert.deepStrictEqual([v[0].tooLarge, v[0].startSize, v[0].part], [true, huge.length, null]);
  assert.deepStrictEqual(payloadOf(files, v[1]).texts.map((t) => t[0]), ['index.html']);
  assert.ok(Number.isInteger(v[2].part), 'fits the budget');
  assert.strictEqual(v[3].part, null, 'past the budget');
  for (const [n, t] of Object.entries(files)) if (n.startsWith('viewer-files/')) assert.ok(t.length < 2000, n);
});

test('artifactViewParts splits at the part limit', () => {
  const { artifactViewParts } = require('../takeout-viewer.js');
  const parts = artifactViewParts({ partLimit: 200 });
  const pay = (n) => ({ texts: [[`f${n}.html`, 'x'.repeat(60)]], images: [] });
  const out = [0, 1, 2, 3].map((n) => parts.add({ id: n }, pay(n)));
  assert.deepStrictEqual(out.map((v) => v.key), ['a0', 'a1', 'a2', 'a3']);
  assert.deepStrictEqual(parts.add({ id: 9 }, null), { id: 9, part: null, key: null });
  const written = [...parts.drain(), ...parts.flush()];
  assert.ok(written.length >= 2, String(written.length));
  assert.strictEqual(parts.count, written.length);
  for (const v of out) {
    const p = written.find((w) => w.name === `part-${String(v.part).padStart(4, '0')}.js`);
    const got = readPart(p.body);
    assert.strictEqual(got.n, v.part);
    assert.deepStrictEqual(got.d[v.key], pay(v.id));
  }
  assert.ok(written.every((w) => w.body.length <= 200 || Object.keys(readPart(w.body).d).length === 1), 'only one payload may pass the limit');
  // One payload over the limit is its own part, never split.
  const one = artifactViewParts({ partLimit: 50 });
  const v = one.add({}, { texts: [['a.md', 'y'.repeat(500)]], images: [] });
  assert.deepStrictEqual(readPart(one.flush()[0].body).d[v.key].texts[0][1], 'y'.repeat(500));
  // A path such as __proto__ is just data.
  const proto = artifactViewParts();
  const pv = proto.add({}, { texts: [['__proto__', 'p']], images: [] });
  assert.deepStrictEqual(readPart(proto.flush()[0].body).d[pv.key].texts, [['__proto__', 'p']]);
});

test('the start file\'s text is kept first, and a view says when it is not in the payload', async () => {
  const sib = 'c'.repeat(1900 * 1024);
  const many = {};
  for (let i = 0; i < 5; i++) many[`s${i}.css`] = sib;
  const frames = [art(U(1), 'Late start'), art(U(2), 'Budget'), art(U(3), 'Picture')];
  const pages = {
    [U(1)]: livePage('Late start', { ...many, 'index.html': '<p>start</p>' }),
    [U(2)]: livePage('Budget', { 'index.html': '<p>b</p>' }),
    // With no HTML the start file is the first listed one.
    [U(3)]: livePage('Picture', { 'start.png': { body: PNG, type: 'image/png' },
      ...Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`p${i}.png`, { body: Buffer.concat([PNG, Buffer.alloc(1900 * 1024)]), type: 'image/png' }])) }),
  };
  const { views, files } = await runArtifacts({ frames, pages });
  const texts = payloadOf(files, views[0]).texts;
  assert.deepStrictEqual(texts[0], ['index.html', '<p>start</p>']);
  assert.strictEqual(texts.length, 5, 'four siblings fit beside the start file');
  assert.deepStrictEqual([views[0].startMissing, views[0].tooLarge], [false, false]);
  const images = payloadOf(files, views[2]).images;
  assert.deepStrictEqual(images[0], ['start.png', `data:image/png;base64,${PNG.toString('base64')}`]);
  assert.strictEqual(images.length, 5);
  assert.deepStrictEqual([views[2].startKind, views[2].startMissing], ['image', false]);
  // A start file as large as its siblings, listed after four of them, still comes first.
  const bigStart = '<p>' + 's'.repeat(1900 * 1024) + '</p>';
  const four = {};
  for (let i = 0; i < 4; i++) four[`s${i}.css`] = sib;
  const crowd = await runArtifacts({ frames: [art(U(6), 'Crowded')], pages: { [U(6)]: livePage('Crowded', { ...four, 'index.html': bigStart }) } });
  const crowdTexts = payloadOf(crowd.files, crowd.views[0]).texts;
  assert.deepStrictEqual(crowdTexts[0], ['index.html', bigStart]);
  assert.strictEqual(crowdTexts.length, 4, 'three siblings fit beside the start file in 8 MB');
  assert.deepStrictEqual([crowd.views[0].startMissing, crowd.views[0].tooLarge], [false, false]);
  // Past the parts budget the start text is not in any part.
  const tight = await runArtifacts({ frames: [art(U(2), 'Budget')], pages, setup: (sb) => vm.runInContext('CTViewer.ARTIFACT_PARTS_BUDGET = 5', sb) });
  assert.deepStrictEqual([tight.views[0].part, tight.views[0].startMissing, tight.views[0].tooLarge], [null, true, false]);
  // A throwing parts step: the same.
  const thrown = await runArtifacts({ frames: [art(U(2), 'Budget')], pages, setup: (sb) => vm.runInContext('CTViewer.artifactViewParts = () => ({ add: () => { throw new Error("x"); }, drain: () => [], flush: () => [], count: 0 })', sb) });
  assert.strictEqual(thrown.views[0].startMissing, true);
  // Over 2 MB is tooLarge, not startMissing; a start that is no preview kind is neither.
  const big = await runArtifacts({ frames: [art(U(4), 'Big'), art(U(5), 'Pdf')], pages: { [U(4)]: livePage('Big', { 'index.html': 'x'.repeat(2 * 1024 * 1024 + 1) }), [U(5)]: livePage('Pdf', { 'a.pdf': { body: '%PDF', type: 'application/pdf' } }) } });
  assert.deepStrictEqual([big.views[0].tooLarge, big.views[0].startMissing], [true, false]);
  assert.deepStrictEqual([big.views[1].tooLarge, big.views[1].startMissing], [false, false]);
});

test('file kinds and preview collection agree', async () => {
  const frames = [art(U(1), 'Kinds')];
  const pages = { [U(1)]: livePage('Kinds', {
    'readme.markdown': '# r', 'a.avif': { body: 'avif', type: 'image/avif' }, 'b.bmp': { body: 'BM', type: 'image/bmp' }, 'c.ico': { body: 'ico', type: 'image/x-icon' }, 'd.tiff': { body: 't', type: 'image/tiff' },
  }) };
  const { views, files } = await runArtifacts({ frames, pages });
  const v = views[0];
  assert.deepStrictEqual(v.files.map((f) => [f.path, f.kind]), [['readme.markdown', 'md'], ['a.avif', 'image'], ['b.bmp', 'image'], ['c.ico', 'image'], ['d.tiff', 'other']]);
  assert.strictEqual(v.startKind, 'md');
  const payload = payloadOf(files, v);
  assert.deepStrictEqual(payload.texts, [['readme.markdown', '# r']]);
  assert.deepStrictEqual(payload.images.map(([p, d]) => [p, d.split(';')[0]]), [['a.avif', 'data:image/avif'], ['b.bmp', 'data:image/bmp'], ['c.ico', 'data:image/x-icon']]);
});

test('a view counts the listed files that were not saved', async () => {
  const frames = [art(U(1), 'Gaps')];
  const pages = { [U(1)]: livePage('Gaps', { 'index.html': 'i', 'a.css': { body: 'a', error: { error: 'HTTP 404', status: 404 } }, 'b.js': { body: 'b', error: { error: 'HTTP 404', status: 404 } } }) };
  const { views } = await runArtifacts({ frames, pages });
  assert.strictEqual(views[0].missingCount, 2);
  assert.deepStrictEqual(views[0].files.map((f) => f.path), ['index.html']);
});

// ---- Export Artifacts: viewer.html ----
const CTV = require('../takeout-viewer.js');
const artifactsViewerData = (html) => JSON.parse(/<script id="data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1]);

test('Export Artifacts writes viewer.html and viewer-check.gif', async () => {
  const frames = [art(U(1), 'Quarterly Report'), art(U(2), 'Plan', { typeSlug: DOCS_TYPE, typeTitle: 'Docs' })];
  const pages = { [U(1)]: livePage('Quarterly Report', { 'index.html': '<h1>Q</h1>' }) };
  for (const options of [{}, { directory: new FakeDir() }]) {
    const { files, raw, views, result } = await runArtifacts({ frames, pages, options });
    const html = files['viewer.html'];
    assert.ok(html, 'viewer.html written');
    assert.ok(/^<!doctype html>/i.test(html));
    assert.ok(html.includes('<meta name="generator" content="Claude Takeout">'));
    const policy = /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)[1];
    assert.match(policy, /frame-src 'none'/);
    assert.ok(!/frame-src[^;]*file:/.test(policy), policy);
    assert.match(policy, /script-src[^;]*file:/, 'parts load from viewer-files/');
    const data = artifactsViewerData(html);
    assert.deepStrictEqual(Object.keys(data).sort(), ['artifacts', 'exported', 'listed']);
    assert.strictEqual(data.listed, 2);
    assert.strictEqual(data.exported, JSON.parse(files['export-manifest.json']).exported_at);
    assert.deepStrictEqual(data.artifacts, views);
    assert.ok(!/\/\*(DATA_JSON|MARKED_JS|LOGIC_JS|APP_JS)\*\//.test(html.replace(/<script id="data"[\s\S]*?<\/script>/, '')));
    assert.deepStrictEqual(raw['viewer-check.gif'], Buffer.from(CTV.VIEWER_CHECK_BASE64, 'base64'));
    assert.match(files['index.html'], /<a href="viewer\.html">/);
    assert.deepStrictEqual([result.outcome, result.warnings], ['done', 0]);
    for (const s of ['claudeusercontent', '__frame_t', '_thumb']) assert.ok(!html.includes(s), s);
  }
});

test('an artifacts export with no parts keeps file: out of the viewer\'s script-src', async () => {
  const frames = [art(U(1), 'Plan', { typeSlug: DOCS_TYPE, typeTitle: 'Docs' })];
  const { files } = await runArtifacts({ frames });
  assert.ok(!Object.keys(files).some((n) => n.startsWith('viewer-files/part-')));
  const policy = /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(files['viewer.html'])[1];
  assert.ok(!/script-src[^;]*file:/.test(policy), policy);
});

test('a viewer build failure leaves the artifacts export complete', async () => {
  const frames = [art(U(1), 'One'), art(U(2), 'Two')];
  const pages = { [U(1)]: livePage('One', { 'index.html': 'one' }), [U(2)]: livePage('Two', { 'index.html': 'two' }) };
  const throwing = [[/^chrome-extension:/, () => { throw new Error('asset gone'); }]];
  for (const options of [{}, { directory: new FakeDir() }]) {
    const { files, result } = await runArtifacts({ frames, pages, options, routes: throwing });
    assert.ok(!files['viewer.html'] && !files['viewer-check.gif']);
    assert.strictEqual(files[`${artVer('Two', U(2))}/index.html`], 'two');
    assert.ok(files['index.md'] && files['export-manifest.json']);
    assert.ok(!files['index.html'].includes('viewer.html'), 'no viewer link');
    assert.deepStrictEqual([result.outcome, result.saved.artifacts, result.warningList.map((w) => w.type)], ['done', 2, ['viewer']]);
  }
  const failed = await runArtifacts({ frames, pages, assets: false });
  assert.ok(!failed.files['viewer.html']);
  assert.ok(failed.result.warningList.some((w) => w.type === 'viewer'));
});

test('viewer.html holds no artifact texts', async () => {
  const marker = 'TEXT-MARKER-7f3a';
  const frames = [art(U(1), 'Page'), art(U(2), 'Pic')];
  const pages = {
    [U(1)]: livePage('Page', { 'index.html': `<p>${marker}</p>`, 'style.css': `/* ${marker} */`, 'notes.md': marker }),
    [U(2)]: livePage('Pic', { 'a.png': { body: PNG, type: 'image/png' } }),
  };
  const { files } = await runArtifacts({ frames, pages });
  assert.ok(!files['viewer.html'].includes(marker));
  assert.ok(!files['viewer.html'].includes(PNG.toString('base64')));
  const parts = Object.keys(files).filter((n) => n.startsWith('viewer-files/part-'));
  assert.ok(parts.some((n) => files[n].includes(marker)), 'the text is in a part');
});

test('viewer.html stays small for 1000 artifacts', async () => {
  const many = Array.from({ length: 1000 }, (_, i) => art(U(i + 1), `A rather long artifact title number ${i} with some words`, { live: '' }));
  const { files } = await runArtifacts({ frames: many });
  assert.strictEqual(artifactsViewerData(files['viewer.html']).artifacts.length, 1000);
  assert.ok(Buffer.byteLength(files['viewer.html']) < 1.5 * 1024 * 1024, String(Buffer.byteLength(files['viewer.html'])));
});

// ---- artifactLinksOf: which artifacts a chat made, published or edited ----
test('artifactLinksOf: a Docs batch made the artifact named by created.minted, with its doc key', () => {
  const t = docTools(undefined, { realShape: true });
  const data = oneMessage([t.batch, t.batchResult]);
  assert.deepStrictEqual(plain(core.artifactLinksOf(data)), [{ uuid: DOC_U, messageUuid: data.chat_messages[0].uuid, how: 'made', docKey: 'doc:node-1' }]);
});
test('artifactLinksOf: without created.minted, frame.url gives the uuid', () => {
  const t = docTools(undefined, { frameUrl: `https://claude.ai/artifact/${core.uuidToBase58(DOC_U)}` });
  const data = oneMessage([t.batch, t.batchResult]);
  assert.deepStrictEqual(plain(core.artifactLinksOf(data)), [{ uuid: DOC_U, messageUuid: data.chat_messages[0].uuid, how: 'made', docKey: 'doc:node-1' }]);
});
test('artifactLinksOf: publishes link as published, Docs container ids and edit_version as edited', () => {
  const t = docTools();
  const url2 = `https://claude.ai/artifact/${core.uuidToBase58(PUB_U2)}`;
  const data = oneMessage([
    use('p1', PUB, { files: [{ as: 'index.html', path: '/home/claude/a.html' }] }), pubResult('p1', { slug: PUB_U, version: 'v1', title: 'T' }),
    ...artPublish('a1', '/home/claude/b.html', url2, 'v1'),
    { ...t.update('u1', 's1', 'x'), input: { ...t.update('u1', 's1', 'x').input, container: { kind: 'project', id: DOC_U } } },
    use('e1', 'mcp__claude-artifacts__edit_version', { slug: PUB_U3, base_version: 'v1', edits: [], label: 'x' }), pubResult('e1', 'ok'),
  ]);
  const links = plain(core.artifactLinksOf(data));
  assert.deepStrictEqual(links.map((l) => [l.uuid, l.how]), [[PUB_U, 'published'], [PUB_U2, 'published'], [DOC_U, 'edited'], [PUB_U3, 'edited']]);
  assert.ok(links.every((l) => l.docKey === null));
});
test('artifactLinksOf: mentions, opens, list results, errors and bad ids do not link', () => {
  const t = docTools();
  const short = core.uuidToBase58(PUB_U);
  const data = oneMessage([
    use('o1', ART, { action: 'open', url: `https://claude.ai/artifact/${short}` }), pubResult('o1', `Opened the Artifact at https://claude.ai/artifact/${short}`),
    use('l1', 'mcp__claude-artifacts__list_artifacts', {}), pubResult('l1', `[{"slug":"${PUB_U}"}]`),
    { type: 'text', text: `see ${PUB_U}` },
    use('e1', 'mcp__claude-artifacts__edit_version', { slug: PUB_U3, base_version: 'v1', edits: [], label: 'x' }), pubResult('e1', 'failed', true),
    t.update('u1', 's1', 'x'),
    { ...t.update('u2', 's1', 'x'), input: { ...t.update('u2', 's1', 'x').input, container: { kind: 'project', id: DOC_U } } }, pubResult('u2', 'bad', true),
  ]);
  assert.deepStrictEqual(plain(core.artifactLinksOf(data)), []);
});

// ---- runArtifactStep: the Export Artifacts loop, under a prefix, with reuse ----
async function runStep(frames, pages, { prefix = 'artifacts/' } = {}) {
  const popup = exportPopup();
  const sb = popup.sandbox;
  const fetcher = publishedFetcher(pages);
  const root = zipStub();
  sb.setTimeout = (f) => setTimeout(f, 0);
  sb.__root = root;
  sb.__fetch = fetcher.fetch;
  sb.__prefix = prefix;
  sb.__arts = JSON.parse(JSON.stringify(frames));
  const progress = [];
  sb.__progress = (d, t) => progress.push([d, t]);
  const out = await vm.runInContext(`runArtifactStep(__root, { prefix: __prefix, artifacts: __arts, full: false, listed: __arts.length, fetchPublished: __fetch, picturesAllowed: false, parts: null, onProgress: __progress, run: false })`, sb);
  return { out: JSON.parse(JSON.stringify({ ...out, collector: undefined })), collector: out.collector, written: root.written, fetcher, progress };
}

test('runArtifactStep under artifacts/ writes folders, artifact.json and views with root-relative paths', async () => {
  const frames = [art(U(1), 'Guide')];
  const { out, written, progress } = await runStep(frames, { [U(1)]: livePage('Guide', { 'index.html': '<h1>G</h1>' }) });
  const f = artFolder('Guide', U(1));
  assert.deepStrictEqual(Object.keys(written).sort(), [`artifacts/${f}/${LIVE}/index.html`, `artifacts/${f}/artifact.json`]);
  assert.strictEqual(out.views[0].folder, `artifacts/${f}/${LIVE}`);
  assert.strictEqual(out.views[0].start, 'index.html');
  assert.strictEqual(out.rows[0].folder, `${f}/${LIVE}`);
  assert.deepStrictEqual(progress, [[0, 1], [1, 1]], 'before and after the artifact');
  assert.strictEqual(out.signedOut, false);
});

test('runArtifactStep keeps card pictures under the root viewer-files', async () => {
  const frames = [art(U(1), 'Guide')];
  const popup = exportPopup({ routes: [[/_thumb\.img/, () => ({ ok: true, status: 200, headers: { get: () => 'image/png' }, arrayBuffer: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]).buffer })]] });
  const sb = popup.sandbox;
  const fetcher = publishedFetcher({ [U(1)]: livePage('Guide', { 'index.html': 'x' }) });
  const root = zipStub();
  sb.setTimeout = (f) => setTimeout(f, 0);
  sb.__root = root;
  sb.__arts = frames;
  sb.__fetch = async (m) => (m.action === 'artifactThumbUrl' ? { url: `https://${m.uuid}.frame.claudeusercontent.com/_f/V/_thumb.img?__frame_t=T` } : fetcher.fetch(m));
  const out = await vm.runInContext(`runArtifactStep(__root, { prefix: 'artifacts/', artifacts: __arts, full: false, listed: 1, fetchPublished: __fetch, picturesAllowed: true, parts: null })`, sb);
  const id = uuidToBase58(U(1));
  assert.ok(root.written[`viewer-files/thumbs/${id}.png`]);
  assert.strictEqual(out.views[0].thumb, `viewer-files/thumbs/${id}.png`);
  assert.strictEqual(out.thumbs, 1);
  assert.ok(JSON.parse(root.written[`artifacts/${artFolder('Guide', U(1))}/artifact.json`]).thumb);
});

test('a 401 in the step stops only the step', async () => {
  const frames = [art(U(1), 'A'), art(U(2), 'B')];
  const pages = { [U(1)]: { error: { error: 'HTTP 401', status: 401 }, versions: {} }, [U(2)]: livePage('B', { 'index.html': 'b' }) };
  const { out, collector } = await runStep(frames, pages);
  assert.strictEqual(out.signedOut, true);
  assert.strictEqual(out.views.length, 2);
  assert.ok(out.views.every((v) => v.notExported));
  assert.strictEqual(collector.warnings.length, 1);
});

test('the index links a reused start file from where the index lives', () => {
  const sb = exportPopup().sandbox;
  const row = { title: 'Guide', typeTitle: 'Page', sourceSurface: 'chat', rel: 'mine', folder: 'Guide_x', startSaved: 'My Chat/artefacts/guide.html', reused: true, url: '', note: '', needsRuntime: false, fileCount: 1, missingCount: 0 };
  sb.__rows = [row];
  assert.ok(vm.runInContext("artifactsIndexMd(__rows, { base: 'artifacts/' })", sb).includes('(../My%20Chat/artefacts/guide.html)'));
  assert.ok(vm.runInContext("artifactsIndexHtml(__rows, { base: 'artifacts/' })", sb).includes('href="../My%20Chat/artefacts/guide.html"'));
  assert.ok(vm.runInContext("artifactsIndexMd(__rows)", sb).includes('(My%20Chat/artefacts/guide.html)'));
});

// ---- Export All with artifacts ----
// Export All also saves claude.ai's artifacts into artifacts/ (setting exportAllArtifacts, default on), reusing
// what the chats saved of the same version, and never asking for the optional web permission.
// setup for runBulkZip: content.js answers listArtifacts with frames (or list, as the whole reply) and the page
// calls from fetcher; calls records every message's action; permissionRequests every permission request.
const bulkWithArtifacts = ({ frames = [], list = null, fetcher = publishedFetcher({}), calls = [], permissionRequests = [], granted = false, off = false } = {}) => (sb) => {
  sb.chrome.permissions = { contains: async () => granted, request: async (o) => { permissionRequests.push(o); return granted; } };
  const orig = sb.chrome.tabs.sendMessage;
  sb.chrome.tabs.sendMessage = (id, msg, cb) => {
    calls.push(msg.action);
    if (msg.action === 'listArtifacts') return cb(list || { frames: JSON.parse(JSON.stringify(frames)) });
    if (/^publishedPage/.test(msg.action)) return fetcher.fetch(msg).then(cb);
    return orig(id, msg, cb);
  };
  if (off) vm.runInContext('settings.exportAllArtifacts = false', sb);
};
const zipFiles = async (zip) => {
  const out = {};
  for (const n of Object.keys(zip.files)) if (!zip.files[n].dir) out[n] = (await zip.file(n).async('string')).replace(/^﻿/, '');
  return out;
};
const diskFiles = (picked) => {
  const run = [...picked.entries.values()][picked.entries.size - 1];
  const out = {};
  for (const [n, d] of Object.entries(run.flat())) out[n] = (typeof d === 'string' ? d : Buffer.from(d).toString('utf8')).replace(/^﻿/, '');
  return out;
};

test('Export All with artifacts on writes artifacts/ beside the chats', async () => {
  const list = [listed('a', '2026-01-01T00:00:00Z')];
  const frames = [art(U(1), 'Quarterly Report'), art(U(2), 'Game', { sourceSurface: 'cowork' })];
  const fetcher = publishedFetcher({ [U(1)]: livePage('Quarterly Report', { 'index.html': '<h1>Q</h1>' }), [U(2)]: livePage('Game', { 'index.html': 'g', 'app.js': 'go()' }) });
  const picked = new FakeDir();
  const out = await runBulkZip({ list, chats: { a: chatFor('a', '2026-01-01T00:00:00Z') }, options: { directory: picked }, setup: bulkWithArtifacts({ frames, fetcher }), assets: true });
  const files = diskFiles(picked);
  const f1 = artFolder('Quarterly_Report', U(1));
  const f2 = artFolder('Game', U(2));
  assert.ok(files['Chat_a/README.md'], 'the chat is there');
  assert.ok(files['artifacts/index.md'] && files['artifacts/index.html']);
  assert.strictEqual(files[`artifacts/${f2}/${LIVE}/app.js`], 'go()');
  assert.strictEqual(JSON.parse(files[`artifacts/${f1}/artifact.json`]).uuid, U(1));
  assert.ok(files['artifacts/index.md'].includes(`[Game](${f2}/${LIVE}/index.html)`), files['artifacts/index.md']);
  assert.ok(!files['artifacts/errors.txt']);
  assert.ok(!Object.keys(files).some((n) => /^artifacts\/(viewer|export-manifest)/.test(n)), 'one viewer and one manifest, at the root');
  const manifest = JSON.parse(files['export-manifest.json']);
  assert.strictEqual(manifest.artifacts.items.length, 2);
  assert.deepStrictEqual([manifest.artifacts.listed, manifest.artifacts.thumbs], [2, 0]);
  assert.deepStrictEqual(manifest.artifacts.items.map((e) => [e.uuid, e.folder, e.ver]), [[U(1), f1, LIVE], [U(2), f2, LIVE]]);
  const index = files['index.md'];
  assert.match(index, /## Artifacts/);
  assert.match(index, /Listed by claude\.ai: 2/);
  assert.match(index, /Saved: 2/);
  assert.ok(index.includes('(artifacts/index.md)'), index);
  assert.ok(index.indexOf('## Conversations') < index.indexOf('## Artifacts'));
  assert.ok(Object.keys(files).some((n) => /^viewer-files\/part-\d{4}\.js$/.test(n)), 'preview parts at the root');
  assert.deepStrictEqual(out.store.exportRecord['org-1'].artifacts, { [U(1)]: LIVE, [U(2)]: LIVE });
  assert.deepStrictEqual([out.result.outcome, out.result.warnings, out.result.saved.chats, out.result.saved.artifacts], ['done', 0, 1, 2]);
  // The viewer's artifacts carry their current version and where claude.ai says they were made.
  const viewerData = JSON.parse(/<script id="data" type="application\/json">([\s\S]*?)<\/script>/.exec(files['viewer.html'])[1].replace(/<\\\//g, '</'));
  assert.deepStrictEqual(viewerData.artifacts.map((v) => [v.title, v.ver, v.sourceSurface]), [['Quarterly Report', LIVE, 'chat'], ['Game', LIVE, 'cowork']]);
});

test('the combined artifacts index links the viewer one folder up', () => {
  const sb = exportPopup().sandbox;
  sb.__rows = [];
  assert.ok(vm.runInContext("artifactsIndexHtml(__rows, { base: 'artifacts/', viewer: true })", sb).includes('href="../viewer.html"'));
  assert.ok(vm.runInContext('artifactsIndexHtml(__rows, { viewer: true })', sb).includes('href="viewer.html"'));
});

test('the setting off writes no artifacts and makes no listArtifacts call', async () => {
  const calls = [];
  const list = [listed('a', '2026-01-01T00:00:00Z')];
  const { zip, store } = await runBulkZip({ list, chats: { a: chatFor('a', '2026-01-01T00:00:00Z') }, setup: bulkWithArtifacts({ frames: [art(U(1), 'G')], calls, off: true }) });
  const files = await zipFiles(zip);
  assert.ok(!calls.includes('listArtifacts'), calls.join());
  assert.ok(!Object.keys(files).some((n) => n.startsWith('artifacts/')));
  assert.ok(!('artifacts' in JSON.parse(files['export-manifest.json'])));
  assert.ok(!files['index.md'].includes('## Artifacts'));
  assert.ok(!store.exportRecord['org-1'].artifacts);
});

test('a list failure leaves the chats complete and says so', async () => {
  for (const [reply, code] of [[{ error: 'HTTP 401', status: 401 }, 'HTTP 401'], [{ connectionError: 'gone' }, 'no connection to the claude.ai tab'], [{ frames: 'x' }, 'bad response']]) {
    const list = [listed('a', '2026-01-01T00:00:00Z')];
    const { zip, result, store } = await runBulkZip({ list, chats: { a: chatFor('a', '2026-01-01T00:00:00Z') }, setup: bulkWithArtifacts({ list: reply }) });
    const files = await zipFiles(zip);
    assert.ok(files['Chat_a/README.md'] && files['Chat_a/full_chat.md'], code);
    assert.ok(files['index.md'].includes(`Artifacts: not exported (${code})`), files['index.md']);
    assert.ok(!Object.keys(files).some((n) => n.startsWith('artifacts/')), 'no half-written artifacts/');
    assert.ok(!('artifacts' in JSON.parse(files['export-manifest.json'])));
    assert.strictEqual(result.outcome, 'done');
    assert.ok(result.warningList.some((w) => w.type === 'artifact_export' && w.text.includes(code)), JSON.stringify(result.warningList));
    assert.deepStrictEqual(Object.keys(store.exportRecord['org-1'].chats), ['a']);
  }
});

test('a chat named Artifacts gets Artifacts_2', async () => {
  const list = [listed('a', '2026-01-01T00:00:00Z')];
  const chat = Object.assign(chatFor('a', '2026-01-01T00:00:00Z'), { name: 'ARTIFACTS' });
  const fetcher = publishedFetcher({ [U(1)]: livePage('G', { 'index.html': 'g' }) });
  const { zip } = await runBulkZip({ list, chats: { a: chat }, setup: bulkWithArtifacts({ frames: [art(U(1), 'G')], fetcher }) });
  const files = await zipFiles(zip);
  assert.ok(files['ARTIFACTS_2/README.md'], Object.keys(files).join());
  assert.ok(files['artifacts/index.md']);
  assert.strictEqual(JSON.parse(files['export-manifest.json']).chats[0].folder, 'ARTIFACTS_2');
});

test('an artifact published by a chat is not fetched again', async () => {
  const chat = Object.assign(pubChat([pubMsg('m1', null, publish('p1', PUB_U, 'v1', guideAs))]), { uuid: 'a', name: 'Chat a' });
  const fetcher = publishedFetcher({ [PUB_U]: { title: 'Guide', live: 'v1', history: ['v1'], versions: { v1: { files: { 'index.html': 'PUBLISHED-PAGE' } } } } });
  const frames = [art(PUB_U, 'Guide', { live: 'v1' })];
  const { zip } = await runBulkZip({ list: [listed('a', '2026-01-01T00:00:00Z')], chats: { a: chat }, setup: bulkWithArtifacts({ frames, fetcher }) });
  const files = await zipFiles(zip);
  const f = artFolder('Guide', PUB_U);
  assert.strictEqual(files[`artifacts/${f}/v1/index.html`], 'PUBLISHED-PAGE');
  assert.strictEqual(fetcher.count('publishedPageFile', PUB_U), 1);
  assert.strictEqual(fetcher.count('publishedPageInfo', PUB_U), 1);
  assert.deepStrictEqual(Object.keys(files).filter((n) => n.startsWith(`artifacts/${f}/`)).sort(), [`artifacts/${f}/artifact.json`, `artifacts/${f}/v1/index.html`]);
  const meta = JSON.parse(files[`artifacts/${f}/artifact.json`]);
  assert.deepStrictEqual([meta.current, meta.versions.v1.folder, meta.versions.v1.publishedIn.map((p) => p.chat)], ['v1', 'v1', ['a']]);
  assert.ok(!('savedIn' in meta));
  assert.ok(files['artifacts/index.md'].includes(`(${f}/v1/index.html)`), files['artifacts/index.md']);
  assert.ok(Object.entries(files).some(([n, t]) => /^viewer-files\/part-/.test(n) && t.includes('PUBLISHED-PAGE')), 'the preview has the text');
});

test('a published version saved whole but unchecked (no checksum from claude.ai) is reused and stays marked unchecked', async () => {
  // Cowork and Artifact-tool pages come without claude.ai's checksum; fetching them again would be no better checked.
  const chat = Object.assign(pubChat([pubMsg('m1', null, publish('p1', PUB_U, 'v1', guideAs))]), { uuid: 'a', name: 'Chat a' });
  const fetcher = publishedFetcher({ [PUB_U]: { title: 'Guide', live: 'v1', history: ['v1'], versions: { v1: { files: { 'index.html': { body: 'UNCHECKED-PAGE', unverified: true } } } } } });
  const { zip } = await runBulkZip({ list: [listed('a', '2026-01-01T00:00:00Z')], chats: { a: chat }, setup: bulkWithArtifacts({ frames: [art(PUB_U, 'Guide', { live: 'v1' })], fetcher }) });
  const files = await zipFiles(zip);
  assert.strictEqual(fetcher.count('publishedPageFile', PUB_U), 1);
  const f = artFolder('Guide', PUB_U);
  assert.deepStrictEqual(Object.keys(files).filter((n) => n.startsWith(`artifacts/${f}/`)).sort(), [`artifacts/${f}/artifact.json`, `artifacts/${f}/v1/index.html`]);
  const meta = JSON.parse(files[`artifacts/${f}/artifact.json`]);
  assert.strictEqual(meta.versions.v1.files[0].verified, false);
  assert.ok(meta.note.includes("files not checked against claude.ai's checksum"), meta.note);
  assert.ok(files['artifacts/index.md'].includes("files not checked against claude.ai's checksum"));
  assert.ok(Object.entries(files).some(([n, t]) => /^viewer-files\/part-/.test(n) && t.includes('UNCHECKED-PAGE')), 'the preview has the text');
});

test('a published version saved incomplete is fetched for the artifact', async () => {
  const chat = Object.assign(pubChat([pubMsg('m1', null, publish('p1', PUB_U, 'v1', [...guideAs, { as: 'b.css', path: '/home/claude/b.css' }]))]), { uuid: 'a', name: 'Chat a' });
  const fetcher = publishedFetcher({ [PUB_U]: { title: 'Guide', live: 'v1', history: ['v1'], versions: { v1: { files: { 'index.html': 'P', 'b.css': { body: 'x', error: { error: 'HTTP 500', status: 500 } } } } } } });
  const { zip } = await runBulkZip({ list: [listed('a', '2026-01-01T00:00:00Z')], chats: { a: chat }, setup: bulkWithArtifacts({ frames: [art(PUB_U, 'Guide', { live: 'v1' })], fetcher }) });
  const files = await zipFiles(zip);
  const meta = JSON.parse(files[`artifacts/${artFolder('Guide', PUB_U)}/artifact.json`]);
  assert.ok(!('savedIn' in meta));
  assert.ok(fetcher.count('publishedPageFile', PUB_U) > 2);
});

test('a same version points at the chat\'s artefacts file', async () => {
  const chat = Object.assign(pubChat([pubMsg('m1', null, [
    use('w', 'Write', { file_path: '/home/claude/guide.html', content: 'SAME-TEXT-ONE' }), result('w'), ...publish('p1', PUB_U, 'v1', guideAs),
  ])]), { uuid: 'a', name: 'Chat a' });
  const fetcher = publishedFetcher({ [PUB_U]: { title: 'Guide', live: 'v1', history: ['v1'], versions: { v1: { files: { 'index.html': 'SAME-TEXT-ONE' } } } } });
  const { zip } = await runBulkZip({ list: [listed('a', '2026-01-01T00:00:00Z')], chats: { a: chat }, setup: bulkWithArtifacts({ frames: [art(PUB_U, 'Guide', { live: 'v1' })], fetcher }) });
  const files = await zipFiles(zip);
  assert.strictEqual(fetcher.count('publishedPageFile'), 0);
  assert.strictEqual(fetcher.count('publishedPageInfo'), 1);
  assert.ok(!Object.keys(files).some((n) => n.startsWith('published/')));
  const f = artFolder('Guide', PUB_U);
  assert.deepStrictEqual(Object.keys(files).filter((n) => n.startsWith(`artifacts/${f}/`)), [`artifacts/${f}/artifact.json`]);
  const meta = JSON.parse(files[`artifacts/${f}/artifact.json`]);
  assert.deepStrictEqual([meta.versions.v1.folder, meta.versions.v1.sameAs], [null, { 'index.html': 'Chat_a/artefacts/guide.html' }]);
  assert.strictEqual(files['Chat_a/artefacts/guide.html'], 'SAME-TEXT-ONE');
  assert.ok(!files[`artifacts/${f}/artifact.json`].includes('SAME-TEXT-ONE'), 'the text stays out of artifact.json');
  assert.ok(Object.entries(files).some(([n, t]) => /^viewer-files\/part-/.test(n) && t.includes('SAME-TEXT-ONE')), 'the preview has the text');
});

test('Export Changes records an artifact found only by paging by its update time, and fetches it again only when that changes', async () => {
  const stored = { exportRecord: { 'org-1': { at: '2026-01-05T00:00:00Z', chats: { a: '2026-01-01T00:00:00Z' }, artifacts: { [U(1)]: LIVE } } } };
  const list = [listed('a', '2026-01-01T00:00:00Z')];
  const chats = { a: chatFor('a', '2026-01-01T00:00:00Z') };
  const fetcher = publishedFetcher({ [U(1)]: livePage('One', { 'index.html': '1' }), [U(2)]: livePage('Paged', { 'index.html': 'p' }), [U(3)]: livePage('Undated', { 'index.html': 'u' }) });
  const reply = (updatedAt) => ({ frames: [art(U(1), 'One'), art(U(2), 'Paged', { live: '', paged: true, updatedAt }), art(U(3), 'Undated', { live: '', paged: true, updatedAt: '' })], paging: { status: 'ok', added: 2 } });
  const run = (stored, updatedAt) => runBulkZip({ list, chats, stored, options: { changesOnly: true }, setup: bulkWithArtifacts({ list: reply(updatedAt), fetcher }) });
  const first = await run(stored, '2026-11-01T00:00:00Z');
  const files = await zipFiles(first.zip);
  assert.strictEqual(files[`artifacts/${artFolder('Paged', U(2))}/${LIVE}/index.html`], 'p');
  assert.deepStrictEqual(first.store.exportRecord['org-1'].artifacts, { [U(1)]: LIVE, [U(2)]: 'paged:2026-11-01T00:00:00Z' }, 'one with no update time is not recorded');
  assert.strictEqual(fetcher.count('publishedPageInfo', U(2)), 1);
  await run(first.store, '2026-11-01T00:00:00Z');
  assert.strictEqual(fetcher.count('publishedPageInfo', U(2)), 1, 'unchanged: not fetched again');
  assert.strictEqual(fetcher.count('publishedPageInfo', U(3)), 2, 'no update time: included each time');
  await run(first.store, '2026-11-20T00:00:00Z');
  assert.strictEqual(fetcher.count('publishedPageInfo', U(2)), 2, 'updated: fetched again');
});

test('a paged artifact claude.ai serves no version of gets the no-published-version note, not a warning', async () => {
  const frames = [art(U(1), 'Draft', { live: '', paged: true }), art(U(2), 'Odd', { live: '', paged: true })];
  const pages = { [U(2)]: { title: 'Odd', error: { ver: 7, files: [] } } };
  const { files } = await runArtifacts({ list: { frames, paging: { status: 'ok', added: 2 }, accountName: 'Mika', orgId: 'org-1' }, pages });
  for (const [n, t] of [[1, 'Draft'], [2, 'Odd']]) {
    const meta = JSON.parse(files[`${artFolder(t, U(n))}/artifact.json`]);
    assert.strictEqual(meta.note, 'no published version', t);
    assert.ok(!meta.incomplete, t);
  }
  const errs = files['errors.txt'] || '';
  assert.ok(!/could not be fetched/.test(errs), errs);
});

test('Export Changes includes changed artifacts only and records versions', async () => {
  const stored = { exportRecord: { 'org-1': { at: '2026-01-05T00:00:00Z', chats: { a: '2026-01-01T00:00:00Z' }, artifacts: { [U(1)]: LIVE, [U(2)]: 'old-ver' }, artifactVersions: { [U(1)]: [LIVE], [U(2)]: ['old-ver'] } } } };
  const list = [listed('a', '2026-01-01T00:00:00Z'), listed('b', '2026-01-09T00:00:00Z')];
  const chats = { a: chatFor('a', '2026-01-01T00:00:00Z'), b: chatFor('b', '2026-01-09T00:00:00Z') };
  const frames = [art(U(1), 'One'), art(U(2), 'Two'), art(U(3), 'Three')];
  const fetcher = publishedFetcher({ [U(1)]: livePage('One', { 'index.html': '1' }), [U(2)]: livePage('Two', { 'index.html': '2' }), [U(3)]: livePage('Three', { 'index.html': '3' }) });
  const { zip, store } = await runBulkZip({ list, chats, stored, options: { changesOnly: true }, setup: bulkWithArtifacts({ frames, fetcher }) });
  const files = await zipFiles(zip);
  assert.strictEqual(fetcher.count('publishedPageInfo', U(1)), 0);
  const manifest = JSON.parse(files['export-manifest.json']);
  assert.deepStrictEqual(manifest.artifacts.items.map((e) => e.uuid), [U(2), U(3)]);
  assert.strictEqual(manifest.artifacts.listed, 3);
  assert.ok(!Object.keys(files).some((n) => n.startsWith(`artifacts/${artFolder('One', U(1))}/`)));
  const date = vm.runInContext('formatTimestamp', exportPopup().sandbox)('2026-01-05T00:00:00Z');
  assert.ok(files['artifacts/index.md'].includes(`Changed since ${date}: 2 of 3 listed`), files['artifacts/index.md']);
  assert.ok(files['artifacts/index.html'].includes(`Changed since ${date}: 2 of 3 listed`));
  assert.ok(files['index.md'].includes(`Changed since ${date}: 2 of 3 listed`), files['index.md']);
  assert.deepStrictEqual(store.exportRecord['org-1'].artifacts, { [U(1)]: LIVE, [U(2)]: LIVE, [U(3)]: LIVE });
  assert.deepStrictEqual(Object.keys(store.exportRecord['org-1'].chats).sort(), ['a', 'b']);
});

test('Export Changes runs when only an artifact changed', async () => {
  const stored = { exportRecord: { 'org-1': { at: '2026-01-05T00:00:00Z', chats: { a: '2026-01-01T00:00:00Z' }, artifacts: { [U(1)]: LIVE, [U(2)]: 'old-ver' }, artifactVersions: { [U(1)]: [LIVE], [U(2)]: ['old-ver'] } } } };
  const list = [listed('a', '2026-01-01T00:00:00Z')];
  const frames = [art(U(1), 'One'), art(U(2), 'Two')];
  const fetcher = publishedFetcher({ [U(2)]: livePage('Two', { 'index.html': '2' }) });
  const first = await runBulkZip({ list, chats: { a: chatFor('a', '2026-01-01T00:00:00Z') }, stored, options: { changesOnly: true }, setup: bulkWithArtifacts({ frames, fetcher }), assets: true });
  assert.ok(first.saved, JSON.stringify(first.result));
  const files = await zipFiles(first.zip);
  const manifest = JSON.parse(files['export-manifest.json']);
  assert.deepStrictEqual([manifest.chats.length, manifest.artifacts.items.map((e) => e.uuid)], [0, [U(2)]]);
  assert.ok(files['viewer.html'], 'artifacts alone still get a viewer');
  assert.ok(files[`artifacts/${artVer('Two', U(2))}/index.html`]);
  assert.deepStrictEqual(first.store.exportRecord['org-1'].artifacts, { [U(1)]: LIVE, [U(2)]: LIVE });
  assert.deepStrictEqual([first.result.outcome, first.result.saved.chats, first.result.saved.artifacts], ['done', 0, 1]);

  const again = await runBulkZip({ list, chats: { a: chatFor('a', '2026-01-01T00:00:00Z') }, stored: first.store, options: { changesOnly: true }, setup: bulkWithArtifacts({ frames, fetcher }) });
  assert.strictEqual(again.saved, null);
  assert.match(again.result.notes.join(' '), /Nothing changed since/);
});

test('an artifact that could not be exported is not recorded, so the next Export Changes tries it again', async () => {
  const list = [listed('a', '2026-01-01T00:00:00Z')];
  const frames = [art(U(1), 'One'), art(U(2), 'Two')];
  const fetcher = publishedFetcher({ [U(1)]: livePage('One', { 'index.html': '1' }) });
  const { zip, store, result } = await runBulkZip({ list, chats: { a: chatFor('a', '2026-01-01T00:00:00Z') }, setup: bulkWithArtifacts({ frames, fetcher }) });
  const files = await zipFiles(zip);
  assert.deepStrictEqual(store.exportRecord['org-1'].artifacts, { [U(1)]: LIVE });
  assert.match(files['artifacts/errors.txt'], /Two/);
  assert.ok(result.errorFiles.includes('artifacts/errors.txt'));
  assert.ok(result.warnings > 0);
});

test('Export All never asks for the web permission', async () => {
  for (const directory of [null, new FakeDir()]) {
    const permissionRequests = [];
    const list = [listed('a', '2026-01-01T00:00:00Z')];
    const fetcher = publishedFetcher({ [U(1)]: livePage('G', { 'index.html': 'g' }) });
    const out = await runBulkZip({ list, chats: { a: chatFor('a', '2026-01-01T00:00:00Z') }, options: directory ? { directory } : {}, setup: bulkWithArtifacts({ frames: [art(U(1), 'G')], fetcher, permissionRequests }) });
    assert.deepStrictEqual(permissionRequests, []);
    const files = directory ? diskFiles(directory) : await zipFiles(out.zip);
    assert.match(files['artifacts/index.md'], /Card pictures:\*\* 0 of 1 \(needs the web images permission/);
  }
});

test('exportAllChats and exportAllArtifacts default to true and round-trip through the main screen\'s boxes', async () => {
  for (const [key, id] of [['exportAllChats', 'pickChats'], ['exportAllArtifacts', 'pickArtifacts']]) {
    const sb = exportPopup().sandbox;
    assert.strictEqual(vm.runInContext(`defaultSettings.${key}`, sb), true);
    const box = sb.document.getElementById(id);
    vm.runInContext('applySettings()', sb);
    assert.strictEqual(box.checked, true);
    const store = {};
    sb.chrome.storage.local.set = async (o) => { Object.assign(store, JSON.parse(JSON.stringify(o))); };
    sb.chrome.storage.local.get = async (keys) => Object.fromEntries(keys.filter((k) => k in store).map((k) => [k, JSON.parse(JSON.stringify(store[k]))]));
    box.handlers.change({ target: { checked: false } });
    await new Promise((r) => setTimeout(r, 5));
    assert.strictEqual(store.exporterSettings[key], false);
    vm.runInContext('settings = { ...defaultSettings }', sb);
    await vm.runInContext('loadSettings()', sb);
    assert.strictEqual(vm.runInContext(`settings.${key}`, sb), false);
    assert.strictEqual(box.checked, false);
  }
  for (const page of ['popup.html', 'sidepanel.html']) {
    const html = fs.readFileSync(path.join(REPO, page), 'utf8');
    assert.match(html, /<input type="checkbox" id="pickChats" checked>\s*<span class="check-text"><span>Chats<\/span>/, page);
    assert.match(html, /<input type="checkbox" id="pickArtifacts" checked>\s*<span class="check-text"><span>Artifacts<\/span><span class="sub">Every version claude\.ai keeps<\/span>/, page);
  }
});

test('changedArtifacts takes artifacts whose listed version differs, and all with no record', () => {
  const sb = exportPopup().sandbox;
  sb.__list = [art(U(1), 'a'), art(U(2), 'b', { live: 'v2' }), art(U(3), 'c', { live: null })];
  const pick = (rec, vers = { [U(1)]: [LIVE] }) => { sb.__rec = rec; sb.__vers = vers; return vm.runInContext('changedArtifacts(__list, __rec, __vers)', sb).map((a) => a.slug); };
  assert.deepStrictEqual(pick(undefined), [U(1), U(2), U(3)]);
  assert.deepStrictEqual(pick({ [U(1)]: LIVE, [U(2)]: 'v1', [U(3)]: '' }), [U(2)]);
  assert.deepStrictEqual(pick({}), [U(1), U(2), U(3)]);
  // v1.21: a record with no versions (from before) includes an unchanged artifact once; one whose live version isn't
  // among its recorded versions too; one with no live version never.
  assert.deepStrictEqual(pick({ [U(1)]: LIVE, [U(3)]: '' }, null), [U(1), U(2)]);
  assert.deepStrictEqual(pick({ [U(1)]: LIVE, [U(3)]: '' }, { [U(1)]: ['v0'] }), [U(1), U(2)]);
});

test('an artifact saved with a file missing is not recorded, after a failed file or a 401', async () => {
  for (const failure of [{ error: 'HTTP 500', status: 500 }, { error: 'HTTP 401', status: 401 }]) {
    const list = [listed('a', '2026-01-01T00:00:00Z')];
    const frames = [art(U(1), 'One'), art(U(2), 'Two')];
    const fetcher = publishedFetcher({
      [U(1)]: livePage('One', { 'index.html': '1' }),
      [U(2)]: livePage('Two', { 'index.html': '2', 'style.css': { body: 'x', error: failure } }),
    });
    const { store, zip } = await runBulkZip({ list, chats: { a: chatFor('a', '2026-01-01T00:00:00Z') }, setup: bulkWithArtifacts({ frames, fetcher }) });
    assert.deepStrictEqual(store.exportRecord['org-1'].artifacts, { [U(1)]: LIVE }, failure.error);
    assert.ok((await zipFiles(zip))['artifacts/errors.txt'], failure.error);
  }
});

test('a multi-file page a chat saved previews with all its files', async () => {
  const files = [...guideAs, { as: 'style.css', path: '/home/claude/style.css' }];
  const chat = Object.assign(pubChat([pubMsg('m1', null, publish('p1', PUB_U, 'v1', files))]), { uuid: 'a', name: 'Chat a' });
  const fetcher = publishedFetcher({ [PUB_U]: { title: 'Guide', live: 'v1', history: ['v1'], versions: { v1: { files: { 'index.html': 'PAGE-HTML', 'style.css': { body: 'PAGE-CSS', type: 'text/css' } } } } } });
  const { zip } = await runBulkZip({ list: [listed('a', '2026-01-01T00:00:00Z')], chats: { a: chat }, setup: bulkWithArtifacts({ frames: [art(PUB_U, 'Guide', { live: 'v1' })], fetcher }) });
  const out = await zipFiles(zip);
  assert.strictEqual(fetcher.count('publishedPageFile', PUB_U), 2);
  const meta = JSON.parse(out[`artifacts/${artFolder('Guide', PUB_U)}/artifact.json`]);
  assert.deepStrictEqual([meta.versions.v1.folder, meta.versions.v1.files.map((f) => f.savedAs)], ['v1', ['index.html', 'style.css']]);
  const part = Object.entries(out).find(([n]) => /^viewer-files\/part-/.test(n));
  assert.ok(part && part[1].includes('PAGE-HTML') && part[1].includes('PAGE-CSS'), part && part[1]);
  assert.ok(part[1].indexOf('PAGE-HTML') < part[1].indexOf('PAGE-CSS'), 'start file first');
  assert.ok(!out[`artifacts/${artFolder('Guide', PUB_U)}/artifact.json`].includes('PAGE-'), 'previews stay out of artifact.json');
});

test('recordableExport leaves out chats and artifacts whose files could not be written', () => {
  const fn = vm.runInContext('recordableExport', exportPopup().sandbox);
  const chats = [{ uuid: 'a', updated_at: 't1', folder: 'Chat_a' }, { uuid: 'b', updated_at: 't2', folder: 'Chat_ab' }, { uuid: 'c', updated_at: 't3', folder: 'Chat_c', retry: true }];
  const artifacts = [{ uuid: 'u1', ver: 'v1', folder: 'artifacts/One_x' }, { uuid: 'u2', ver: 'v2', folder: 'artifacts/One_xy' }];
  const failures = [{ path: 'Chat_a/uploads/p01_big.pdf', error: 'QuotaExceededError' }, { path: 'artifacts/One_x/v1/index.html', error: 'x' }, { path: 'viewer.html', error: 'x' }];
  const out = plain(fn(chats, artifacts, failures));
  assert.deepStrictEqual(out.chats.map((c) => c.uuid), ['b'], 'a failed to write, c must be fetched again');
  assert.deepStrictEqual(out.artifacts.map((a) => a.uuid), ['u2']);
  const none = plain(fn(chats, artifacts, []));
  assert.deepStrictEqual([none.chats.length, none.artifacts.length], [2, 2]);
});

test('Export All after a sign-out mid-way: later chats say their pages were skipped, and none of them is recorded', async () => {
  const chatA = Object.assign(pubChat([pubMsg('m1', null, publish('p1', PUB_U, 'v1', guideAs))]), { uuid: 'a', name: 'Chat a' });
  const chatB = Object.assign(pubChat([pubMsg('n1', null, publish('q1', PUB_U2, 'v1', guideAs, 'Two2', 'Two'))]), { uuid: 'b', name: 'Chat b' });
  const chatC = Object.assign(pubChat([{ uuid: 'h', parent_message_uuid: null, sender: 'human', content: [{ type: 'text', text: 'hi' }] }]), { uuid: 'c', name: 'Chat c' });
  const fetcher = publishedFetcher({ [PUB_U]: { error: { error: 'HTTP 401', status: 401 } }, [PUB_U2]: { title: 'Two', history: ['v1'], versions: { v1: { files: { 'index.html': 'two' } } } } });
  const list = [listed('a', '2026-01-01T00:00:00Z'), listed('b', '2026-01-02T00:00:00Z'), listed('c', '2026-01-03T00:00:00Z')];
  const { zip, store } = await runBulkZip({ list, chats: { a: chatA, b: chatB, c: chatC }, setup: bulkWithPages(fetcher, { calls: 0 }) });
  const errB = await zip.file('Chat_b/errors.txt').async('string');
  assert.match(errB, /not fetched: an earlier request in this export was answered HTTP 401/, errB);
  assert.strictEqual(fetcher.count('publishedPageInfo', PUB_U2), 0);
  assert.deepStrictEqual(Object.keys(store.exportRecord['org-1'].chats).sort(), ['c'], 'a and b have pages to fetch again');
  const manifest = JSON.parse(await zip.file('export-manifest.json').async('string'));
  assert.deepStrictEqual(manifest.chats.map((c) => c.uuid), ['a', 'b', 'c'], 'the manifest still lists every chat exported');
});

test('a chat whose published version failed to write into the artifacts store is not recorded', async () => {
  const pageAs = [{ as: 'page.html', path: '/home/claude/page.html' }];
  const chatA = Object.assign(pubChat([pubMsg('m1', null, publish('p1', PUB_U, 'v1', pageAs))]), { uuid: 'a', name: 'Chat a' });
  const chatB = Object.assign(pubChat([{ uuid: 'h', parent_message_uuid: null, sender: 'human', content: [{ type: 'text', text: 'hi' }] }]), { uuid: 'b', name: 'Chat b' });
  const fetcher = publishedFetcher({ [PUB_U]: { title: 'Guide', history: ['v1', 'v2'], versions: { v1: { files: { 'page.html': 'old' } } } } });
  const picked = new FakeDir('picked', (name) => name === 'page.html');
  const list = [listed('a', '2026-01-01T00:00:00Z'), listed('b', '2026-01-02T00:00:00Z')];
  const { store } = await runBulkZip({ list, chats: { a: chatA, b: chatB }, options: { directory: picked }, setup: bulkWithPages(fetcher, { calls: 0 }) });
  assert.ok(diskFiles(picked)['write-errors.txt'].includes('/v1/page.html'), 'the failure is listed');
  assert.deepStrictEqual(Object.keys(store.exportRecord['org-1'].chats), ['b']);
});

test('a chat after a 401 in the middle of a version\'s files says why that version is missing, and is not recorded', async () => {
  const chatA = Object.assign(pubChat([pubMsg('m1', null, publish('p1', PUB_U, 'v1', guideAs))]), { uuid: 'a', name: 'Chat a' });
  const chatB = Object.assign(pubChat([pubMsg('n1', null, publish('q1', PUB_U, 'v1', guideAs))]), { uuid: 'b', name: 'Chat b' });
  const fetcher = publishedFetcher({ [PUB_U]: { title: 'Guide', history: ['v1'], versions: { v1: { files: { 'index.html': { body: 'x', error: { error: 'HTTP 401', status: 401 } } } } } } });
  const list = [listed('a', '2026-01-01T00:00:00Z'), listed('b', '2026-01-02T00:00:00Z')];
  const { zip, store } = await runBulkZip({ list, chats: { a: chatA, b: chatB }, setup: bulkWithPages(fetcher, { calls: 0 }) });
  const readmeB = await zip.file('Chat_b/README.md').async('string');
  assert.match(readmeB, /not saved \(see errors\.txt\)/, readmeB);
  assert.match(await zip.file('Chat_b/errors.txt').async('string'), /an earlier request in this export was answered HTTP 401/);
  assert.ok(!store.exportRecord || !store.exportRecord['org-1'] || !Object.keys(store.exportRecord['org-1'].chats).length);
});

test('a version that failed before a 401 keeps its own cause: a later chat does not blame the 401', async () => {
  const chatA = Object.assign(pubChat([pubMsg('m1', null, publish('p1', PUB_U, 'v1', guideAs))]), { uuid: 'a', name: 'Chat a' });
  const chatC = Object.assign(pubChat([pubMsg('k1', null, publish('r1', PUB_U2, 'v1', guideAs, 'Out2', 'Out'))]), { uuid: 'c', name: 'Chat c' });
  const chatD = Object.assign(pubChat([pubMsg('n1', null, publish('q1', PUB_U, 'v1', guideAs))]), { uuid: 'd', name: 'Chat d' });
  const fetcher = publishedFetcher({
    [PUB_U]: { title: 'Guide', history: ['v1'], versions: { v1: { files: { 'index.html': { body: 'tampered', sha256: sha('original') } } } } },
    [PUB_U2]: { error: { error: 'HTTP 401', status: 401 } },
  });
  const list = [listed('a', '2026-01-01T00:00:00Z'), listed('c', '2026-01-02T00:00:00Z'), listed('d', '2026-01-03T00:00:00Z')];
  const { zip } = await runBulkZip({ list, chats: { a: chatA, c: chatC, d: chatD }, setup: bulkWithPages(fetcher, { calls: 0 }) });
  const errC = await zip.file('Chat_c/errors.txt').async('string');
  assert.strictEqual((errC.match(/HTTP 401/g) || []).length, 1, 'the chat that met the 401 says so once');
  const errD = zip.file('Chat_d/errors.txt') ? await zip.file('Chat_d/errors.txt').async('string') : '';
  assert.ok(!/HTTP 401/.test(errD), errD);
});

test('runArtifactStep lets go of each version\'s preview once its part is written', async () => {
  const sb = exportPopup().sandbox;
  const fetcher = publishedFetcher({ [U(1)]: livePage('Guide', { 'index.html': 'live' }), [U(2)]: livePage('Two', { 'index.html': 'two' }) });
  const root = zipStub();
  sb.setTimeout = (f) => setTimeout(f, 0);
  Object.assign(sb, { __root: root, __fetch: fetcher.fetch, __arts: [art(U(1), 'Guide'), art(U(2), 'Two')] });
  const out = JSON.parse(await vm.runInContext(`(async () => {
    const store = artifactStore(__root, { prefix: 'artifacts/' });
    const parts = CTViewer.artifactViewParts({ partLimit: 4 * 1024 * 1024, budget: 64 * 1024 * 1024 });
    const step = await runArtifactStep(__root, { store, artifacts: __arts, listed: 2, fetchPublished: __fetch, picturesAllowed: false, parts });
    const kept = store.records().flatMap((r) => [...r.versions.values()]).filter((v) => v && v.preview).length;
    return JSON.stringify({ kept, parts: step.views.map((v) => v.part != null) });
  })()`, sb));
  assert.deepStrictEqual(out.parts, [true, true], 'the previews reached their parts');
  assert.strictEqual(out.kept, 0);
});

test('an artifact claude.ai lists with no rel is treated as not the owner\'s for local links', async () => {
  const frames = [art(U(1), 'Mine', { rel: 'mine' }), art(U(2), 'Unknown', { rel: '' })];
  const pages = { [U(1)]: livePage('Mine', { 'index.html': 'm' }), [U(2)]: livePage('Unknown', { 'index.html': 'u' }) };
  const { files, views } = await runArtifacts({ frames, pages });
  const byTitle = Object.fromEntries(views.map((v) => [v.title, v]));
  assert.deepStrictEqual([byTitle.Mine.shared, byTitle.Mine.foreign], [false, false]);
  assert.strictEqual(byTitle.Unknown.foreign, true, 'no Open file link for its HTML in the viewer');
  assert.strictEqual(byTitle.Unknown.shared, false, 'not put under Shared with you');
  const fu = artFolder('Unknown', U(2));
  assert.ok(!files['index.md'].includes(`(${fu}/${LIVE}/index.html)`), 'no local link in the index');
  assert.ok(files['index.md'].includes(`(${artFolder('Mine', U(1))}/${LIVE}/index.html)`));
  assert.notStrictEqual(JSON.parse(files[`${fu}/artifact.json`]).note, 'shared with you', 'its note does not claim it was shared');
});

// Export All keeps a published version's preview in memory only for the artifact step's listed live version.
const recordCollect = (calls) => (sb) => {
  const orig = vm.runInContext('fetchPublishedFiles', sb);
  sb.__origFetchFiles = orig;
  sb.__collectCalls = calls;
  vm.runInContext('fetchPublishedFiles = (o) => { __collectCalls.push([o.uuid, o.ver, !!o.collect]); return __origFetchFiles(o); }', sb);
};
const twoVersionChat = () => Object.assign(pubChat([
  pubMsg('m1', null, publish('p1', PUB_U, 'v1', guideAs)),
  pubMsg('m2', 'm1', publish('p2', PUB_U, 'v2', guideAs)),
]), { uuid: 'a', name: 'Chat a' });
const twoVersionPage = () => publishedFetcher({ [PUB_U]: { title: 'Guide', live: 'v2', history: ['v1', 'v2'], versions: { v1: { files: { 'index.html': 'PAGE-ONE' } }, v2: { files: { 'index.html': 'PAGE-TWO' } } } } });

test('Export All with artifacts off collects no published previews', async () => {
  const calls = [];
  const fetcher = twoVersionPage();
  const setup = (sb) => { bulkWithArtifacts({ frames: [art(PUB_U, 'Guide', { live: 'v2' })], fetcher, off: true })(sb); recordCollect(calls)(sb); };
  const { zip } = await runBulkZip({ list: [listed('a', '2026-01-01T00:00:00Z')], chats: { a: twoVersionChat() }, setup });
  const files = await zipFiles(zip);
  assert.strictEqual(files[`artifacts/${artFolder('Guide', PUB_U)}/v2/index.html`], 'PAGE-TWO');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(calls)), [[PUB_U, 'v1', false], [PUB_U, 'v2', false]]);
});

test('Export All collects a published preview only for the listed live version, and the version the chat saved still previews', async () => {
  const calls = [];
  const fetcher = twoVersionPage();
  const setup = (sb) => { bulkWithArtifacts({ frames: [art(PUB_U, 'Guide', { live: 'v2' })], fetcher })(sb); recordCollect(calls)(sb); };
  const { zip } = await runBulkZip({ list: [listed('a', '2026-01-01T00:00:00Z')], chats: { a: twoVersionChat() }, setup });
  const files = await zipFiles(zip);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(calls)), [[PUB_U, 'v1', false], [PUB_U, 'v2', true]]);
  assert.strictEqual(fetcher.count('publishedPageFile', PUB_U), 2, 'v2 reused, not fetched again');
  assert.deepStrictEqual(Object.keys(JSON.parse(files[`artifacts/${artFolder('Guide', PUB_U)}/artifact.json`]).versions), ['v1', 'v2']);
  const parts = Object.entries(files).filter(([n]) => /^viewer-files\/part-/.test(n)).map(([, t]) => t).join('');
  assert.ok(parts.includes('PAGE-TWO'), 'the reused version previews');
  assert.ok(!parts.includes('PAGE-ONE'), 'the other version was not kept for a preview');
});

test('publishedPreviewWanted takes plain artifacts at their listed live version only', () => {
  const sb = exportPopup().sandbox;
  sb.__arts = [art(U(1), 'a'), art(U(2), 'b', { live: 'v2' }), art(U(3), 'Doc', { typeSlug: 'claude-docs' }), art(U(4), 'd', { live: null })];
  const wanted = vm.runInContext('publishedPreviewWanted(__arts)', sb);
  assert.strictEqual(wanted(U(1).toUpperCase(), LIVE), true);
  assert.strictEqual(wanted(U(2), 'v2'), true);
  assert.strictEqual(wanted(U(2), 'v1'), false);
  assert.strictEqual(wanted(U(3), LIVE), false);
  assert.strictEqual(wanted(U(4), ''), false);
  assert.strictEqual(vm.runInContext('publishedPreviewWanted([])', sb)(U(1), LIVE), false);
});

test('runArtifactStep says in its collector when it stops early on an unexpected error', async () => {
  const popup = exportPopup();
  const sb = popup.sandbox;
  const fetcher = publishedFetcher({ [U(1)]: livePage('One', { 'index.html': '1' }), [U(2)]: livePage('Two', { 'index.html': '2' }) });
  sb.setTimeout = (f) => setTimeout(f, 0);
  sb.__root = zipStub();
  sb.__fetch = fetcher.fetch;
  sb.__arts = [art(U(1), 'One'), art(U(2), 'Two')];
  sb.__progress = () => { throw new Error('boom'); };
  const origError = sb.console.error;
  sb.console.error = () => {};
  const out = await vm.runInContext(`runArtifactStep(__root, { prefix: 'artifacts/', artifacts: __arts, full: false, listed: 2, fetchPublished: __fetch, picturesAllowed: false, parts: null, onProgress: __progress, run: false })`, sb);
  sb.console.error = origError;
  assert.strictEqual(out.views.length, 1, 'stopped after the first');
  const w = out.collector.warnings.find((x) => x.type === 'artifact_export' && /stopped early/.test(x.error));
  assert.ok(w, JSON.stringify(out.collector.warnings));
  assert.strictEqual(w.error, 'Artifact step stopped early: unexpected error. Artifacts after this one were not exported.');
  assert.match(out.collector.generateErrorReport(), /Artifact step stopped early/);
});

test('a combined Export All writes no frame URL, asset token or picture URL into any file, status or console', async () => {
  const TOKEN = 'SECRET-ASSET-TOKEN-42';
  const thumbUrl = (uuid) => `https://${uuid}.frame.claudeusercontent.com/_f/V/_thumb.img?__frame_t=${TOKEN}`;
  // Chat a publishes a listed page and one claude.ai no longer lists (it lands in artifacts/ all the same).
  const chat = Object.assign(pubChat([pubMsg('m1', null, [...publish('p1', PUB_U, 'v1', guideAs), ...publish('p2', PUB_U2, 'v1', guideAs, 'Short2', 'Gone')])]), { uuid: 'a', name: 'Chat a' });
  const fetcher = publishedFetcher({
    [PUB_U]: { title: 'Guide', live: 'v1', history: ['v1'], versions: { v1: { files: { 'index.html': 'PUBLISHED-PAGE' } } } },
    [PUB_U2]: { title: 'Gone', history: ['v1'], versions: { v1: { files: { 'index.html': 'UNLISTED-PAGE' } } } },
    [U(1)]: livePage('One', { 'index.html': '<p>one</p>', 'a.png': { body: PNG, type: 'image/png' } }),
  });
  const frames = [art(PUB_U, 'Guide', { live: 'v1' }), art(U(1), 'One'), art(U(2), 'Plan', { typeSlug: DOCS_TYPE, typeTitle: 'Docs' })];
  const thumbFetches = [];
  const consoleCalls = [];
  const setup = (sb) => {
    bulkWithArtifacts({ frames, fetcher, granted: true })(sb);
    const send = sb.chrome.tabs.sendMessage;
    sb.chrome.tabs.sendMessage = (id, msg, cb) => (msg.action === 'artifactThumbUrl' ? cb({ url: thumbUrl(msg.uuid) }) : send(id, msg, cb));
    const fetchOrig = sb.fetch;
    sb.fetch = async (url, opts) => {
      if (/_thumb\.img/.test(String(url))) {
        thumbFetches.push(String(url));
        return { ok: true, status: 200, headers: { get: () => 'image/png' }, arrayBuffer: async () => new Uint8Array(PNG).buffer };
      }
      return fetchOrig(url, opts);
    };
    sb.console = Object.fromEntries(['log', 'warn', 'error', 'info', 'debug'].map((k) => [k, (...a) => consoleCalls.push(a.map(String).join(' '))]));
  };
  const { zip, result } = await runBulkZip({ list: [listed('a', '2026-01-01T00:00:00Z')], chats: { a: chat }, setup, assets: true });
  assert.ok(thumbFetches.length >= 1, 'the picture URL was used');
  const files = await zipFiles(zip);
  assert.ok(files['viewer.html'] && files['artifacts/index.md'] && files[`artifacts/${artFolder('Guide', PUB_U)}/v1/index.html`], Object.keys(files).join());
  assert.ok(!Object.keys(files).some((n) => n.startsWith('published/')), 'no published/ in Export All');
  assert.strictEqual(files[`artifacts/${artFolder('Gone', PUB_U2)}/v1/index.html`], 'UNLISTED-PAGE');
  assert.ok(Object.keys(files).some((n) => /^viewer-files\/thumbs\//.test(n)), 'a card picture was saved');
  const all = { ...files, result: JSON.stringify(result), console: consoleCalls.join('\n') };
  for (const [name, text] of Object.entries(all)) {
    for (const bad of ['__frame_t', 'claudeusercontent', '_thumb.img', TOKEN, thumbUrl(U(1))]) assert.ok(!name.includes(bad) && !text.includes(bad), `${name} holds ${bad}`);
  }
});

// ---- Export All: one artifacts/ store for the chats' publishes and claude.ai's list (v1.18) ----
const storeFiles = (files, f) => Object.keys(files).filter((n) => n.startsWith(`artifacts/${f}/`)).sort();
const UNLISTED_HEADING = "Published from chats, not in claude.ai's list";
// A local link in a chat's Markdown resolves to a file in the export.
const linkResolves = (files, chatFolder, href) => {
  const parts = [];
  for (const s of `${chatFolder}/${decodeURIComponent(href)}`.split('/')) {
    if (s === '..') parts.pop(); else if (s && s !== '.') parts.push(s);
  }
  return Object.prototype.hasOwnProperty.call(files, parts.join('/'));
};

test('Export All writes no published/ and puts chat publishes in artifacts/<Title>_<id>/<ver>/', async () => {
  const fetcher = twoVersionPage();
  const { zip } = await runBulkZip({ list: [listed('a', '2026-01-01T00:00:00Z')], chats: { a: twoVersionChat() }, setup: bulkWithArtifacts({ fetcher }) });
  const files = await zipFiles(zip);
  assert.ok(!Object.keys(files).some((n) => n.startsWith('published/')), Object.keys(files).join());
  const f = artFolder('Guide', PUB_U);
  assert.deepStrictEqual(storeFiles(files, f), [`artifacts/${f}/artifact.json`, `artifacts/${f}/v1/index.html`, `artifacts/${f}/v2/index.html`]);
  assert.strictEqual(files[`artifacts/${f}/v2/index.html`], 'PAGE-TWO');
  const meta = JSON.parse(files[`artifacts/${f}/artifact.json`]);
  assert.deepStrictEqual([meta.format, meta.listed, meta.title, Object.keys(meta.versions)], [2, false, 'Guide', ['v1', 'v2']]);
  assert.deepStrictEqual(meta.versions.v2.publishedIn, [{ chat: 'a', messageUuid: 'm2', toolUseId: 'p2', same: false, writtenAs: null }]);
  assert.deepStrictEqual([meta.versions.v2.folder, meta.versions.v2.saved], ['v2', true]);
  for (const doc of ['README.md', 'full_chat.md']) {
    assert.ok(files[`Chat_a/${doc}`].includes(`(../artifacts/${f}/v2/index.html)`), doc);
  }
  assert.ok(linkResolves(files, 'Chat_a', `../artifacts/${f}/v2/index.html`));
  assert.ok(files['artifacts/index.md'].includes(UNLISTED_HEADING), files['artifacts/index.md']);
  assert.ok(files['artifacts/index.html'].includes(escapeForHtml(UNLISTED_HEADING)));
  assert.ok(files['index.md'].includes('(artifacts/index.md)'), files['index.md']);
});
const escapeForHtml = (t) => t.replace(/'/g, '&#39;');

test('a listed artifact\'s folder uses the list title from the first chat publish', async () => {
  const fetcher = twoVersionPage();
  const frames = [art(PUB_U, 'Listed Name', { live: 'v2' })];
  const { zip } = await runBulkZip({ list: [listed('a', '2026-01-01T00:00:00Z')], chats: { a: twoVersionChat() }, setup: bulkWithArtifacts({ frames, fetcher }) });
  const files = await zipFiles(zip);
  const f = artFolder('Listed_Name', PUB_U);
  assert.deepStrictEqual(storeFiles(files, f), [`artifacts/${f}/artifact.json`, `artifacts/${f}/v1/index.html`, `artifacts/${f}/v2/index.html`]);
  assert.ok(!Object.keys(files).some((n) => /^artifacts\/Guide_/.test(n)));
  const meta = JSON.parse(files[`artifacts/${f}/artifact.json`]);
  assert.deepStrictEqual([meta.title, meta.listed, meta.current, Object.keys(meta.versions)], ['Listed Name', true, 'v2', ['v1', 'v2']]);
  assert.ok(files['Chat_a/README.md'].includes(`(../artifacts/${f}/v1/index.html)`));
  assert.ok(!files['artifacts/index.md'].includes(UNLISTED_HEADING));
});

test('the artifact step adds the current version only when its folder isn\'t there', async () => {
  const chat = () => Object.assign(pubChat([pubMsg('m1', null, publish('p1', PUB_U, 'v1', guideAs))]), { uuid: 'a', name: 'Chat a' });
  const page = () => publishedFetcher({ [PUB_U]: { title: 'Guide', history: ['v1', 'v2'], versions: { v1: { files: { 'index.html': 'ONE' } }, v2: { files: { 'index.html': 'TWO' } } } } });
  // Live v1: the chat saved it whole, so the step fetches nothing for it; v2, in claude.ai's history, is saved as
  // another version (v1.21: every version).
  let fetcher = page();
  let out = await runBulkZip({ list: [listed('a', '2026-01-01T00:00:00Z')], chats: { a: chat() }, setup: bulkWithArtifacts({ frames: [art(PUB_U, 'Guide', { live: 'v1' })], fetcher }) });
  let files = await zipFiles(out.zip);
  const f = artFolder('Guide', PUB_U);
  assert.deepStrictEqual([fetcher.count('publishedPageInfo'), fetcher.count('publishedPageFile')], [2, 2]);
  assert.strictEqual(fetcher.calls.filter((c) => c.ver === 'v1' && c.action === 'publishedPageFile').length, 1, 'v1 only by the chat');
  assert.deepStrictEqual(storeFiles(files, f), [`artifacts/${f}/artifact.json`, `artifacts/${f}/v1/index.html`, `artifacts/${f}/v2/index.html`]);
  assert.deepStrictEqual(out.store.exportRecord['org-1'].artifacts, { [PUB_U]: 'v1' });
  // Live v2: the step adds it beside the chat's v1.
  fetcher = page();
  out = await runBulkZip({ list: [listed('a', '2026-01-01T00:00:00Z')], chats: { a: chat() }, setup: bulkWithArtifacts({ frames: [art(PUB_U, 'Guide', { live: 'v2' })], fetcher }) });
  files = await zipFiles(out.zip);
  assert.deepStrictEqual([fetcher.count('publishedPageInfo'), fetcher.count('publishedPageFile')], [2, 2]);
  assert.deepStrictEqual(storeFiles(files, f), [`artifacts/${f}/artifact.json`, `artifacts/${f}/v1/index.html`, `artifacts/${f}/v2/index.html`]);
  const meta = JSON.parse(files[`artifacts/${f}/artifact.json`]);
  assert.deepStrictEqual([meta.current, Object.keys(meta.versions)], ['v2', ['v1', 'v2']]);
  assert.ok(files['artifacts/index.md'].includes(`[Guide](${f}/v2/index.html)`), files['artifacts/index.md']);
});

test('Review Focus 2: same version under two names', async () => {
  // One file: one sameAs (the first chat's file), no copy and no fetch; each chat links its own file.
  const chatA = Object.assign(pubChat([pubMsg('m1', null, [
    use('w', 'Write', { file_path: '/home/claude/guide.html', content: 'SAME-TEXT' }), result('w'), ...publish('p1', PUB_U, 'v1', guideAs),
  ])]), { uuid: 'a', name: 'Chat a' });
  const chatB = Object.assign(pubChat([pubMsg('n1', null, [
    use('w', 'Write', { file_path: '/home/claude/page.html', content: 'SAME-TEXT' }), result('w'),
    ...publish('q1', PUB_U, 'v1', [{ as: 'index.html', path: '/home/claude/page.html' }]),
  ])]), { uuid: 'b', name: 'Chat b' });
  let fetcher = publishedFetcher({ [PUB_U]: { title: 'Guide', history: ['v1'], versions: { v1: { files: { 'index.html': 'SAME-TEXT' } } } } });
  const list = [listed('a', '2026-01-01T00:00:00Z'), listed('b', '2026-01-02T00:00:00Z')];
  let out = await runBulkZip({ list, chats: { a: chatA, b: chatB }, setup: bulkWithArtifacts({ frames: [art(PUB_U, 'Guide', { live: 'v1' })], fetcher }) });
  let files = await zipFiles(out.zip);
  const f = artFolder('Guide', PUB_U);
  assert.strictEqual(fetcher.count('publishedPageFile'), 0);
  assert.deepStrictEqual(storeFiles(files, f), [`artifacts/${f}/artifact.json`]);
  let meta = JSON.parse(files[`artifacts/${f}/artifact.json`]);
  assert.deepStrictEqual(meta.versions.v1.sameAs, { 'index.html': 'Chat_a/artefacts/guide.html' });
  assert.strictEqual(meta.versions.v1.folder, null);
  assert.deepStrictEqual(meta.versions.v1.publishedIn.map((p) => [p.chat, p.same, p.writtenAs]), [['a', true, 'guide.html'], ['b', true, 'page.html']]);
  assert.ok(Object.prototype.hasOwnProperty.call(files, 'Chat_a/artefacts/guide.html'));
  for (const [chatFolder, name] of [['Chat_a', 'guide.html'], ['Chat_b', 'page.html']]) {
    const readme = files[`${chatFolder}/README.md`];
    assert.ok(readme.includes(`same as [${name}](artefacts/${name})`), readme);
    assert.ok(linkResolves(files, chatFolder, `artefacts/${name}`));
  }
  assert.deepStrictEqual(out.store.exportRecord['org-1'].artifacts, { [PUB_U]: 'v1' });
  assert.ok(files['artifacts/index.md'].includes(`[Guide](../Chat_a/artefacts/guide.html)`), files['artifacts/index.md']);

  // Two files: copied once into v1/, nothing fetched; both chats link their own files.
  const two = (id, uuid, name, msg) => Object.assign(pubChat([pubMsg(msg, null, [
    use('w1', 'Write', { file_path: `/home/claude/${name}.html`, content: 'PAGE' }), result('w1'),
    use('w2', 'Write', { file_path: `/home/claude/${name}.css`, content: 'CSS' }), result('w2'),
    ...publish(id, PUB_U, 'v1', [{ as: 'index.html', path: `/home/claude/${name}.html` }, { as: 'style.css', path: `/home/claude/${name}.css` }]),
  ])]), { uuid, name: `Chat ${uuid}` });
  fetcher = publishedFetcher({ [PUB_U]: { title: 'Guide', history: ['v1'], versions: { v1: { files: { 'index.html': 'PAGE', 'style.css': { body: 'CSS', type: 'text/css' } } } } } });
  out = await runBulkZip({ list, chats: { a: two('p1', 'a', 'guide', 'm1'), b: two('q1', 'b', 'page', 'n1') }, setup: bulkWithArtifacts({ frames: [art(PUB_U, 'Guide', { live: 'v1' })], fetcher }) });
  files = await zipFiles(out.zip);
  assert.strictEqual(fetcher.count('publishedPageFile'), 0);
  assert.deepStrictEqual(storeFiles(files, f), [`artifacts/${f}/artifact.json`, `artifacts/${f}/v1.zip`, `artifacts/${f}/v1/index.html`, `artifacts/${f}/v1/style.css`]);
  assert.deepStrictEqual([files[`artifacts/${f}/v1/index.html`], files[`artifacts/${f}/v1/style.css`]], ['PAGE', 'CSS']);
  meta = JSON.parse(files[`artifacts/${f}/artifact.json`]);
  assert.deepStrictEqual([meta.versions.v1.folder, meta.versions.v1.saved, 'sameAs' in meta.versions.v1], ['v1', true, false]);
  for (const [chatFolder, name] of [['Chat_a', 'guide.html'], ['Chat_b', 'page.html']]) {
    assert.ok(files[`${chatFolder}/README.md`].includes(`(artefacts/${name})`));
    assert.ok(linkResolves(files, chatFolder, `artefacts/${name}`));
  }
});

test('Review Focus 3: setting off', async () => {
  const calls = [];
  const fetcher = twoVersionPage();
  const { zip, store } = await runBulkZip({ list: [listed('a', '2026-01-01T00:00:00Z')], chats: { a: twoVersionChat() }, setup: bulkWithArtifacts({ frames: [art(PUB_U, 'Listed Name', { live: 'v2' })], fetcher, calls, off: true }) });
  const files = await zipFiles(zip);
  assert.ok(!calls.includes('listArtifacts'), calls.join());
  const f = artFolder('Guide', PUB_U);
  assert.deepStrictEqual(storeFiles(files, f), [`artifacts/${f}/artifact.json`, `artifacts/${f}/v1/index.html`, `artifacts/${f}/v2/index.html`]);
  assert.strictEqual(JSON.parse(files[`artifacts/${f}/artifact.json`]).listed, false);
  assert.ok(files['artifacts/index.md'].includes(UNLISTED_HEADING), files['artifacts/index.md']);
  assert.ok(files['artifacts/index.md'].includes("claude.ai's list isn't in this export"), files['artifacts/index.md']);
  assert.ok(!('artifacts' in JSON.parse(files['export-manifest.json'])));
  assert.ok(!store.exportRecord['org-1'].artifacts);
  assert.ok(files['index.md'].includes('(artifacts/index.md)'), files['index.md']);
});

test('an unlisted page named after its file takes claude.ai\'s title for its folder', async () => {
  const chat = Object.assign(pubChat([pubMsg('m1', null, [
    use('w', 'Write', { file_path: '/home/claude/draft.html', content: 'X' }), result('w'),
    ...artPublish('a1', '/home/claude/draft.html', `https://claude.ai/artifact/${core.uuidToBase58(PUB_U)}`, 'v1'),
  ])]), { uuid: 'a', name: 'Chat a' });
  const fetcher = publishedFetcher({ [PUB_U]: { title: 'Real Title', history: ['v1'], versions: { v1: { files: { 'draft.html': 'Y' } } } } });
  const { zip } = await runBulkZip({ list: [listed('a', '2026-01-01T00:00:00Z')], chats: { a: chat }, setup: bulkWithArtifacts({ fetcher }) });
  const files = await zipFiles(zip);
  const f = artFolder('Real_Title', PUB_U);
  assert.deepStrictEqual(Object.keys(files).filter((n) => n.startsWith('artifacts/') && !/^artifacts\/index\./.test(n)).sort(), [`artifacts/${f}/artifact.json`, `artifacts/${f}/v1/draft.html`]);
});

test('Docs note names the chat that rebuilt it', async () => {
  const t = docTools(undefined, { realShape: true });
  const docChat = Object.assign(oneMessage([t.batch, t.batchResult]), { uuid: 'd', name: 'Planning chat', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' });
  const frames = [art(DOC_U, 'Plan', { typeSlug: DOCS_TYPE, typeTitle: 'Docs' }), art(OTHER_DOC_U, 'Other', { typeSlug: DOCS_TYPE, typeTitle: 'Docs' })];
  const { zip } = await runBulkZip({ list: [listed('d', '2026-01-01T00:00:00Z')], chats: { d: docChat }, setup: bulkWithArtifacts({ frames }) });
  const files = await zipFiles(zip);
  assert.strictEqual(JSON.parse(files[`artifacts/${artFolder('Plan', DOC_U)}/artifact.json`]).note, 'Text rebuilt from the chat Planning chat.');
  assert.strictEqual(JSON.parse(files[`artifacts/${artFolder('Other', OTHER_DOC_U)}/artifact.json`]).note, DOCS_NOTE);
});
const OTHER_DOC_U = 'd0c00001-1111-4222-8333-444455556666';

test('single-chat ZIP still writes published/ and published.json', async () => {
  const data = pubChat([pubMsg('a', null, [
    use('w', 'Write', { file_path: '/home/claude/guide.html', content: '<html>guide</html>' }), result('w'),
    ...publish('p1', PUB_U, 'v1', [...guideAs, { as: 'data.json', path: '/home/claude/data.json' }]),
    ...publish('p2', PUB_U, 'v2', guideAs),
  ])]);
  const fetcher = publishedFetcher({ [PUB_U]: { title: 'Guide', history: ['v1', 'v2'], versions: {
    v1: { files: { 'index.html': '<html>guide, published</html>', 'data.json': { body: '{"a":1}', type: 'application/json' } } },
    v2: { files: { 'index.html': '<html>guide</html>' } },
  } } });
  const { written } = await runFolder(exportPopup(), data, { fetchPublished: fetcher.fetch });
  assert.ok(!Object.keys(written).some((n) => n.startsWith('artifacts/')));
  const names = Object.keys(written).filter((n) => n.startsWith('published/')).sort();
  assert.deepStrictEqual(names, ['published/Guide_Short1/published.json', 'published/Guide_Short1/v1/data.json', 'published/Guide_Short1/v1/index.html']);
  // published.json's bytes as v1.17 wrote them.
  assert.strictEqual(sha(fileText(written, 'published/Guide_Short1/published.json')), '6584b2cde252a6b7544e25eab877793331e7c57e03c72346b29e01c15ab42b29');
});

test('artifact.json orders versions by claude.ai\'s history, keys the no-id version apart from a version named current, and keeps incomplete', () => {
  const sb = exportPopup().sandbox;
  const out = JSON.parse(vm.runInContext(`(() => {
    const v = (folder) => ({ folder, files: [], start: null, startSaved: null, incomplete: false, missing: [], saved: !!folder, publishedIn: [] });
    const rec = { uuid: 'u', shortId: 's', dir: 'd', title: 't', listed: false, current: null, history: ['v1', 'v2'], incomplete: true, meta: {},
      versions: new Map([['v2', v('v2')], ['current', v('current')], ['', v('current_2')], ['v1', v('v1')]]) };
    return JSON.stringify({ json: artifactJsonV2(rec), rows: artifactRowVersions(rec).map((r) => r.label) });
  })()`, sb));
  assert.deepStrictEqual(Object.keys(out.json.versions), ['v1', 'v2', 'current', 'current_2']);
  assert.strictEqual(out.json.versions.current_2.folder, 'current_2');
  assert.strictEqual(out.json.incomplete, true);
  assert.deepStrictEqual(out.rows, ['v1', 'v2', 'current', 'current_2']);
});

test("the viewer's versions follow claude.ai's history, a numeric-looking id too, whichever chat published first", async () => {
  const viewerData = (files) => JSON.parse(/<script id="data" type="application\/json">([\s\S]*?)<\/script>/.exec(files['viewer.html'])[1].replace(/<\\\//g, '</'));
  // Chat a (exported first) publishes the later version 12; chat b the earlier ab-1. Nothing is listed (the setting off).
  const chatA = Object.assign(pubChat([pubMsg('m1', null, publish('p1', PUB_U, '12', guideAs))]), { uuid: 'a', name: 'Chat a' });
  const chatB = Object.assign(pubChat([pubMsg('n1', null, publish('q1', PUB_U, 'ab-1', guideAs))]), { uuid: 'b', name: 'Chat b' });
  const fetcher = publishedFetcher({ [PUB_U]: { title: 'Guide', history: ['ab-1', '12'], versions: { 'ab-1': { files: { 'index.html': 'one' } }, 12: { files: { 'index.html': 'two' } } } } });
  let opts = null;
  const setup = (sb) => {
    bulkWithArtifacts({ fetcher, off: true })(sb);
    const write = sb.writeViewer;
    sb.writeViewer = (zip, chats, o) => { opts = o; return write(zip, chats, o); };
  };
  const out = await runBulkZip({ list: [listed('a', '2026-01-02T00:00:00Z'), listed('b', '2026-01-01T00:00:00Z')], chats: { a: chatA, b: chatB }, setup, assets: true });
  const data = viewerData(await zipFiles(out.zip));
  assert.deepStrictEqual([data.artifacts, data.listFetched, data.storeCount], [[], false, 1]);
  // The record keeps claude.ai's order, which artifact.json's keys can't (12 would come first), and a view of it
  // follows that order.
  const [rec] = opts.artifacts.records;
  assert.deepStrictEqual(Object.keys(rec.versions), ['12', 'ab-1']);
  assert.deepStrictEqual([...rec.versionOrder], ['ab-1', '12']);
  const V = require('../takeout-viewer.js');
  const versions = V.buildViewerData([], { artifacts: { views: [{ id: rec.shortId }], records: [rec], listFetched: false } }).artifacts[0].versions;
  assert.deepStrictEqual(versions.map((e) => [e.ver, e.label]), [['ab-1', 'v1'], ['12', 'v2']]);
});

test('a current version the chats saved with a start file too large to preview is kept, not fetched again', async () => {
  const BIG = `<!--${'x'.repeat(2 * 1024 * 1024 + 10)}-->`;
  const viewerData = (files) => JSON.parse(/<script id="data" type="application\/json">([\s\S]*?)<\/script>/.exec(files['viewer.html'])[1].replace(/<\\\//g, '</'));
  // Saved whole by the chat into v1/.
  let chat = Object.assign(pubChat([pubMsg('m1', null, publish('p1', PUB_U, 'v1', guideAs))]), { uuid: 'a', name: 'Chat a' });
  let fetcher = publishedFetcher({ [PUB_U]: { title: 'Guide', history: ['v1'], versions: { v1: { files: { 'index.html': BIG } } } } });
  let out = await runBulkZip({ list: [listed('a', '2026-01-01T00:00:00Z')], chats: { a: chat }, setup: bulkWithArtifacts({ frames: [art(PUB_U, 'Guide', { live: 'v1' })], fetcher }), assets: true });
  let files = await zipFiles(out.zip);
  const f = artFolder('Guide', PUB_U);
  assert.strictEqual(fetcher.count('publishedPageFile', PUB_U), 1, 'only the chat fetched it');
  let meta = JSON.parse(files[`artifacts/${f}/artifact.json`]);
  assert.deepStrictEqual([meta.versions.v1.folder, meta.versions.v1.saved, meta.versions.v1.incomplete], ['v1', true, false]);
  let view = viewerData(files).artifacts[0];
  assert.deepStrictEqual([view.tooLarge, view.startMissing, view.notExported], [true, false, false]);
  assert.deepStrictEqual(out.store.exportRecord['org-1'].artifacts, { [PUB_U]: 'v1' });
  // The same as the chat's file: sameAs stays, nothing fetched.
  chat = Object.assign(pubChat([pubMsg('m1', null, [use('w', 'Write', { file_path: '/home/claude/guide.html', content: BIG }), result('w'), ...publish('p1', PUB_U, 'v1', guideAs)])]), { uuid: 'a', name: 'Chat a' });
  fetcher = publishedFetcher({ [PUB_U]: { title: 'Guide', history: ['v1'], versions: { v1: { files: { 'index.html': BIG } } } } });
  out = await runBulkZip({ list: [listed('a', '2026-01-01T00:00:00Z')], chats: { a: chat }, setup: bulkWithArtifacts({ frames: [art(PUB_U, 'Guide', { live: 'v1' })], fetcher }), assets: true });
  files = await zipFiles(out.zip);
  assert.strictEqual(fetcher.count('publishedPageFile', PUB_U), 0);
  meta = JSON.parse(files[`artifacts/${f}/artifact.json`]);
  assert.deepStrictEqual([meta.versions.v1.folder, meta.versions.v1.sameAs], [null, { 'index.html': 'Chat_a/artefacts/guide.html' }]);
  view = viewerData(files).artifacts[0];
  assert.deepStrictEqual([view.tooLarge, view.reused, view.notExported], [true, true, false]);
});

test('a version the chats saved whole stays saved when the artifact step\'s fetch of it fails', async () => {
  const sb = exportPopup().sandbox;
  const fetcher = publishedFetcher({ [U(1)]: livePage('Guide', { 'index.html': { body: 'live', error: { error: 'HTTP 500', status: 500 } } }) });
  const root = zipStub();
  sb.setTimeout = (f) => setTimeout(f, 0);
  Object.assign(sb, { __root: root, __fetch: fetcher.fetch, __arts: [art(U(1), 'Guide')] });
  const step = await vm.runInContext(`(async () => {
    const store = artifactStore(__root, { prefix: 'artifacts/' });
    // Whole, but with no preview kept, so the step fetches it again.
    store.record('${U(1)}', { title: 'Guide' }).versions.set('${LIVE}', { folder: '${LIVE}', files: [{ path: 'index.html', savedAs: 'index.html', size: 4, contentType: 'text/html', sha256: '${'b'.repeat(64)}' }],
      start: 'index.html', startSaved: 'index.html', incomplete: false, missing: [], saved: true, publishedIn: [{ chat: 'a', messageUuid: 'm1', toolUseId: 'p1', same: false, writtenAs: null }] });
    return runArtifactStep(__root, { store, artifacts: __arts, full: false, listed: 1, fetchPublished: __fetch, picturesAllowed: false, parts: null });
  })()`, sb);
  assert.strictEqual(fetcher.count('publishedPageFile', U(1)), 1);
  const v = JSON.parse(root.written[`artifacts/${artFolder('Guide', U(1))}/artifact.json`]).versions[LIVE];
  assert.deepStrictEqual([v.folder, v.saved, v.incomplete, v.publishedIn.length], [LIVE, true, false, 1]);
  // The row and the view say the start file is saved, in the kept version's folder.
  const at = `${artFolder('Guide', U(1))}/${LIVE}`;
  assert.deepStrictEqual([step.rows[0].folder, step.rows[0].startSaved], [at, 'index.html']);
  assert.deepStrictEqual([step.views[0].folder, step.views[0].startSaved], [`artifacts/${at}`, 'index.html']);
});

test('a sameAs version stays complete when a later chat\'s fetch of it fails', async () => {
  const chatA = Object.assign(pubChat([pubMsg('m1', null, [
    use('w', 'Write', { file_path: '/home/claude/guide.html', content: 'SAME' }), result('w'), ...publish('p1', PUB_U, 'v1', guideAs),
  ])]), { uuid: 'a', name: 'Chat a' });
  const chatB = Object.assign(pubChat([pubMsg('n1', null, publish('q1', PUB_U, 'v1', guideAs))]), { uuid: 'b', name: 'Chat b' });
  const fetcher = publishedFetcher({ [PUB_U]: { title: 'Guide', history: ['v1'], versions: { v1: { files: { 'index.html': { body: 'SAME', error: { error: 'HTTP 500', status: 500 } } } } } } });
  const list = [listed('a', '2026-01-01T00:00:00Z'), listed('b', '2026-01-02T00:00:00Z')];
  const { zip } = await runBulkZip({ list, chats: { a: chatA, b: chatB }, setup: bulkWithArtifacts({ fetcher }) });
  const files = await zipFiles(zip);
  assert.strictEqual(fetcher.count('publishedPageFile', PUB_U), 1, 'chat b tried');
  const v = JSON.parse(files[`artifacts/${artFolder('Guide', PUB_U)}/artifact.json`]).versions.v1;
  assert.deepStrictEqual([v.folder, v.saved, v.incomplete, v.sameAs], [null, false, false, { 'index.html': 'Chat_a/artefacts/guide.html' }]);
});

test('a version an earlier chat failed to fetch, then a chat wrote the same: sameAs, complete, and the listed row and view open the chat\'s file', async () => {
  const viewerData = (files) => JSON.parse(/<script id="data" type="application\/json">([\s\S]*?)<\/script>/.exec(files['viewer.html'])[1].replace(/<\\\//g, '</'));
  // Chat b (exported first) published v1 from a file it never wrote: not the same, and its fetch fails.
  const chatB = Object.assign(pubChat([pubMsg('n1', null, publish('q1', PUB_U, 'v1', guideAs))]), { uuid: 'b', name: 'Chat b' });
  const chatA = Object.assign(pubChat([pubMsg('m1', null, [
    use('w', 'Write', { file_path: '/home/claude/guide.html', content: 'SAME' }), result('w'), ...publish('p1', PUB_U, 'v1', guideAs),
  ])]), { uuid: 'a', name: 'Chat a' });
  const fetcher = publishedFetcher({ [PUB_U]: { title: 'Guide', history: ['v1'], versions: { v1: { files: { 'index.html': { body: 'SAME', error: { error: 'HTTP 500', status: 500 } } } } } } });
  const list = [listed('b', '2026-01-02T00:00:00Z'), listed('a', '2026-01-01T00:00:00Z')];
  const { zip } = await runBulkZip({ list, chats: { a: chatA, b: chatB }, setup: bulkWithArtifacts({ frames: [art(PUB_U, 'Guide', { live: 'v1' })], fetcher }), assets: true });
  const files = await zipFiles(zip);
  const f = artFolder('Guide', PUB_U);
  const v = JSON.parse(files[`artifacts/${f}/artifact.json`]).versions.v1;
  assert.deepStrictEqual(v.publishedIn.map((p) => [p.chat, p.same]), [['b', false], ['a', true]], 'chat b went first');
  assert.deepStrictEqual([v.folder, v.saved, v.incomplete, v.missing, v.start, v.startSaved, v.sameAs],
    [null, false, false, [], 'index.html', null, { 'index.html': 'Chat_a/artefacts/guide.html' }]);
  assert.ok(files['artifacts/index.md'].includes('[Guide](../Chat_a/artefacts/guide.html)'), files['artifacts/index.md']);
  const view = viewerData(files).artifacts[0];
  assert.deepStrictEqual([view.reused, view.notExported, view.startSaved], [true, false, 'Chat_a/artefacts/guide.html']);
});

test('Review Focus 2 (mixed): a version one chat wrote the same and another didn\'t: one copy, both chats\' links resolve, in either order', async () => {
  const chatA = Object.assign(pubChat([pubMsg('m1', null, [
    use('w', 'Write', { file_path: '/home/claude/guide.html', content: 'SAME-TEXT' }), result('w'), ...publish('p1', PUB_U, 'v1', guideAs),
  ])]), { uuid: 'a', name: 'Chat a' });
  const chatB = Object.assign(pubChat([pubMsg('n1', null, [
    use('w', 'Write', { file_path: '/home/claude/guide.html', content: 'OTHER-TEXT' }), result('w'), ...publish('q1', PUB_U, 'v1', guideAs),
  ])]), { uuid: 'b', name: 'Chat b' });
  const f = artFolder('Guide', PUB_U);
  for (const order of [['a', 'b'], ['b', 'a']]) {
    const fetcher = publishedFetcher({ [PUB_U]: { title: 'Guide', history: ['v1'], versions: { v1: { files: { 'index.html': 'SAME-TEXT' } } } } });
    const list = order.map((id, i) => listed(id, `2026-01-0${2 - i}T00:00:00Z`));
    const { zip } = await runBulkZip({ list, chats: { a: chatA, b: chatB }, setup: bulkWithArtifacts({ frames: [art(PUB_U, 'Guide', { live: 'v1' })], fetcher }) });
    const files = await zipFiles(zip);
    const v = JSON.parse(files[`artifacts/${f}/artifact.json`]).versions.v1;
    assert.deepStrictEqual(v.publishedIn.map((p) => [p.chat, p.same]), order.map((id) => [id, id === 'a']), order.join());
    // One copy: the version's own folder (chat b needed it), and no sameAs beside it.
    assert.deepStrictEqual([v.folder, v.saved, v.incomplete, 'sameAs' in v], ['v1', true, false, false], order.join());
    assert.deepStrictEqual(storeFiles(files, f), [`artifacts/${f}/artifact.json`, `artifacts/${f}/v1/index.html`], order.join());
    assert.strictEqual(files[`artifacts/${f}/v1/index.html`], 'SAME-TEXT');
    assert.ok(files['Chat_a/README.md'].includes('same as [guide.html](artefacts/guide.html)'), files['Chat_a/README.md']);
    assert.ok(linkResolves(files, 'Chat_a', 'artefacts/guide.html'));
    assert.ok(files['Chat_b/README.md'].includes(`(../artifacts/${f}/v1/index.html)`), files['Chat_b/README.md']);
    assert.ok(linkResolves(files, 'Chat_b', `../artifacts/${f}/v1/index.html`));
  }
});

// ---- A ZIP of each artifact's current multi-file version (v1.19) ----
const zipEntries = async (bytes) => {
  const JSZip = require('../jszip.min.js');
  const z = await JSZip.loadAsync(bytes);
  const out = [];
  for (const n of Object.keys(z.files)) if (!z.files[n].dir) out.push({ name: n, date: z.files[n].date.toISOString(), bytes: await z.file(n).async('nodebuffer') });
  return out;
};
const rawZip = async (zip, name) => zip.file(name).async('nodebuffer');

test('versionZip is deterministic and dated', async () => {
  const sb = exportPopup().sandbox;
  sb.JSZip = require('../jszip.min.js');
  sb.Uint8Array = Uint8Array;
  const make = (date) => vm.runInContext(`versionZip([['index.html', '<p>hi</p>'], ['app.js', new Uint8Array([1, 2, 3])]], ${JSON.stringify(date)})`, sb);
  const a = Buffer.from(await make('2026-11-01T00:00:00Z'));
  const b = Buffer.from(await make('2026-11-01T00:00:00Z'));
  assert.ok(a.equals(b), 'same input, same bytes');
  assert.deepStrictEqual([...a.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
  const entries = await zipEntries(a);
  assert.deepStrictEqual(entries.map((e) => e.name), ['index.html', 'app.js']);
  assert.deepStrictEqual([entries[0].bytes.toString('utf8'), [...entries[1].bytes]], ['<p>hi</p>', [1, 2, 3]]);
  // DOS dates keep two-second precision in local time; compare the calendar day.
  assert.ok(entries.every((e) => new Date(e.date).getUTCFullYear() === 2026), entries.map((e) => e.date).join());
  for (const empty of ['', 'not a date']) {
    const z = await zipEntries(Buffer.from(await make(empty)));
    assert.ok(z.every((e) => [1979, 1980].includes(new Date(e.date).getUTCFullYear())), z.map((e) => e.date).join());
  }
});

test('Export Artifacts writes <ver>.zip for a multi-file current version, and none for one file', async () => {
  const frames = [art(U(1), 'Game'), art(U(2), 'Single')];
  const pages = {
    [U(1)]: livePage('Game', { 'index.html': '<script src="app.js"></script>', 'js/app.js': 'go()', 'img.png': { body: 'PNGBYTES', type: 'image/png' } }),
    [U(2)]: livePage('Single', { 'index.html': 'one' }),
  };
  const { files, raw, views } = await runArtifacts({ frames, pages });
  const game = artFolder('Game', U(1));
  const single = artFolder('Single', U(2));
  assert.ok(`${game}/${LIVE}.zip` in raw, Object.keys(raw).join());
  const entries = await zipEntries(raw[`${game}/${LIVE}.zip`]);
  const meta = JSON.parse(files[`${game}/artifact.json`]);
  const v = meta.versions[LIVE];
  assert.deepStrictEqual(entries.map((e) => e.name), v.files.map((f) => f.savedAs));
  for (const e of entries) assert.ok(e.bytes.equals(raw[`${game}/${LIVE}/${e.name}`]), e.name);
  assert.strictEqual(v.zip, `${LIVE}.zip`);
  assert.ok(!v.files.some((f) => /\.zip$/.test(f.savedAs)));
  assert.strictEqual(views.find((x) => x.title === 'Game').zip, `${game}/${LIVE}.zip`);
  assert.ok(!Object.keys(raw).some((n) => n.startsWith(`${single}/`) && n.endsWith('.zip')));
  assert.ok(!('zip' in JSON.parse(files[`${single}/artifact.json`]).versions[LIVE]));
  assert.strictEqual(views.find((x) => x.title === 'Single').zip, null);
});

test('an incomplete multi-file version zips what was saved; with one file saved, no ZIP', async () => {
  const fail = { body: 'x', error: { error: 'HTTP 500', status: 500 } };
  const frames = [art(U(1), 'Three'), art(U(2), 'Two')];
  const pages = {
    [U(1)]: livePage('Three', { 'index.html': 'a', 'b.js': 'b', 'c.css': fail }),
    [U(2)]: livePage('Two', { 'index.html': 'a', 'b.js': fail }),
  };
  const { files, raw } = await runArtifacts({ frames, pages });
  const three = artFolder('Three', U(1));
  const two = artFolder('Two', U(2));
  const v3 = JSON.parse(files[`${three}/artifact.json`]).versions[LIVE];
  assert.strictEqual(v3.incomplete, true);
  assert.strictEqual(v3.zip, `${LIVE}.zip`);
  assert.deepStrictEqual((await zipEntries(raw[`${three}/${LIVE}.zip`])).map((e) => e.name), ['index.html', 'b.js']);
  const v2 = JSON.parse(files[`${two}/artifact.json`]).versions[LIVE];
  assert.ok(!('zip' in v2));
  assert.ok(!(`${two}/${LIVE}.zip` in raw));
});

test('Export All zips the listed current version a chat published, not older or unlisted ones', async () => {
  const PAGE2 = { 'index.html': 'P2', 'style.css': { body: 'S2', type: 'text/css' } };
  const multi = (versions) => publishedFetcher({ [PUB_U]: { title: 'Guide', live: 'v2', history: ['v1', 'v2'], versions } });
  const twoFiles = [{ as: 'index.html', path: '/home/claude/guide.html' }, { as: 'style.css', path: '/home/claude/style.css' }];
  const chat = () => Object.assign(pubChat([pubMsg('m1', null, publish('p1', PUB_U, 'v1', twoFiles)), pubMsg('m2', 'm1', publish('p2', PUB_U, 'v2', twoFiles))]), { uuid: 'a', name: 'Chat a' });
  const versions = { v1: { files: { 'index.html': 'P1', 'style.css': { body: 'S1', type: 'text/css' } } }, v2: { files: PAGE2 } };
  const f = artFolder('Listed', PUB_U);
  // Listed, current v2: v2.zip only.
  let out = await runBulkZip({ list: [listed('a', '2026-01-01T00:00:00Z')], chats: { a: chat() }, setup: bulkWithArtifacts({ frames: [art(PUB_U, 'Listed', { live: 'v2' })], fetcher: multi(versions) }) });
  let files = await zipFiles(out.zip);
  assert.deepStrictEqual(Object.keys(files).filter((n) => n.startsWith(`artifacts/${f}/`) && n.endsWith('.zip')), [`artifacts/${f}/v2.zip`]);
  const entries = await zipEntries(await rawZip(out.zip, `artifacts/${f}/v2.zip`));
  assert.deepStrictEqual(entries.map((e) => [e.name, e.bytes.toString('utf8')]), [['index.html', 'P2'], ['style.css', 'S2']]);
  const meta = JSON.parse(files[`artifacts/${f}/artifact.json`]);
  assert.deepStrictEqual([meta.versions.v2.zip, 'zip' in meta.versions.v1], ['v2.zip', false]);
  // Unlisted: no current version, no ZIP.
  out = await runBulkZip({ list: [listed('a', '2026-01-01T00:00:00Z')], chats: { a: chat() }, setup: bulkWithArtifacts({ frames: [], fetcher: multi(versions) }) });
  files = await zipFiles(out.zip);
  assert.ok(!Object.keys(files).some((n) => n.startsWith('artifacts/') && n.endsWith('.zip')), Object.keys(files).join());
});

test('a multi-file same version copied from a chat gets a ZIP of the copy', async () => {
  const chat = Object.assign(pubChat([pubMsg('m1', null, [
    use('w1', 'Write', { file_path: '/home/claude/guide.html', content: 'PAGE' }), result('w1'),
    use('w2', 'Write', { file_path: '/home/claude/guide.css', content: 'CSS' }), result('w2'),
    ...publish('p1', PUB_U, 'v1', [{ as: 'index.html', path: '/home/claude/guide.html' }, { as: 'style.css', path: '/home/claude/guide.css' }]),
  ])]), { uuid: 'a', name: 'Chat a' });
  const fetcher = publishedFetcher({ [PUB_U]: { title: 'Guide', history: ['v1'], versions: { v1: { files: { 'index.html': 'PAGE', 'style.css': { body: 'CSS', type: 'text/css' } } } } } });
  const out = await runBulkZip({ list: [listed('a', '2026-01-01T00:00:00Z')], chats: { a: chat }, setup: bulkWithArtifacts({ frames: [art(PUB_U, 'Guide', { live: 'v1' })], fetcher }) });
  const f = artFolder('Guide', PUB_U);
  assert.strictEqual(fetcher.count('publishedPageFile'), 0);
  const entries = await zipEntries(await rawZip(out.zip, `artifacts/${f}/v1.zip`));
  assert.deepStrictEqual(entries.map((e) => [e.name, e.bytes.toString('utf8')]), [['index.html', 'PAGE'], ['style.css', 'CSS']]);
  assert.strictEqual(JSON.parse(await out.zip.file(`artifacts/${f}/artifact.json`).async('string')).versions.v1.zip, 'v1.zip');
});

test('Export Changes writes no ZIP for an artifact it does not write', async () => {
  const stored = { exportRecord: { 'org-1': { at: '2026-01-05T00:00:00Z', chats: { a: '2026-01-01T00:00:00Z' }, artifacts: { [U(1)]: LIVE }, artifactVersions: { [U(1)]: [LIVE] } } } };
  const list = [listed('a', '2026-01-01T00:00:00Z'), listed('b', '2026-01-09T00:00:00Z')];
  const chats = { a: chatFor('a', '2026-01-01T00:00:00Z'), b: chatFor('b', '2026-01-09T00:00:00Z') };
  const frames = [art(U(1), 'One'), art(U(2), 'Two')];
  const two = { 'index.html': '1', 'a.js': '2' };
  const fetcher = publishedFetcher({ [U(1)]: livePage('One', two), [U(2)]: livePage('Two', two) });
  const { zip } = await runBulkZip({ list, chats, stored, options: { changesOnly: true }, setup: bulkWithArtifacts({ frames, fetcher }) });
  const names = Object.keys(zip.files).filter((n) => n.endsWith('.zip'));
  assert.deepStrictEqual(names, [`artifacts/${artFolder('Two', U(2))}/${LIVE}.zip`]);
});

test('Export All leaves no stale ZIP when the artifact step refetches a version a chat saved in part', async () => {
  const crypto = require('crypto');
  const files = { 'index.html': 'A', 'b.js': 'B', 'c.css': 'C' };
  // c.css always fails; b.js fails from the second fetch of it on (the artifact step's).
  const seen = {};
  const fetch = async (msg) => {
    if (msg.action === 'publishedPageInfo') {
      return { ver: 'v1', title: 'Guide', history: ['v1'], rejected: [],
        files: Object.entries(files).map(([path, body]) => ({ path, size: body.length, contentType: 'text/plain', sha256: crypto.createHash('sha256').update(body).digest('hex') })) };
    }
    seen[msg.path] = (seen[msg.path] || 0) + 1;
    if (msg.path === 'c.css' || (msg.path === 'b.js' && seen[msg.path] > 1)) return { error: 'HTTP 500', status: 500 };
    return { base64: Buffer.from(files[msg.path]).toString('base64'), contentType: 'text/plain', size: files[msg.path].length };
  };
  const fetcher = { fetch };
  const three = [{ as: 'index.html', path: '/home/claude/a.html' }, { as: 'b.js', path: '/home/claude/b.js' }, { as: 'c.css', path: '/home/claude/c.css' }];
  const chat = Object.assign(pubChat([pubMsg('m1', null, publish('p1', PUB_U, 'v1', three))]), { uuid: 'a', name: 'Chat a' });
  const out = await runBulkZip({ list: [listed('a', '2026-01-01T00:00:00Z')], chats: { a: chat }, setup: bulkWithArtifacts({ frames: [art(PUB_U, 'Guide', { live: 'v1' })], fetcher }) });
  const f = artFolder('Guide', PUB_U);
  assert.ok(seen['b.js'] >= 2, 'the step fetched the version again');
  assert.deepStrictEqual(Object.keys(out.zip.files).filter((n) => n.endsWith('.zip')), [], 'no ZIP the record does not name');
  assert.ok(!('zip' in JSON.parse(await out.zip.file(`artifacts/${f}/artifact.json`).async('string')).versions.v1));
});

// ---- v1.20: claude.ai's frame preamble doesn't decide the label; .json and canvas.json in artifact previews ----
const PREAMBLE_PAGE = '<!doctype html><html><head><!-- frame-runtime --><script>window.__FRAME_PREAMBLE={"v":1}</script>'
  + '<script>(function(){fetch("/_f/"+v+"/x")})()</script></head><body><h1>Hi</h1></body></html>';

test('publishedNeedsRuntime ignores claude.ai\'s frame preamble', () => {
  const { publishedNeedsRuntime } = require('../export-core.js');
  assert.strictEqual(publishedNeedsRuntime(PREAMBLE_PAGE), false);
  assert.strictEqual(publishedNeedsRuntime(PREAMBLE_PAGE.replace('</body>', '<script src="/_f/abc/app.js"></script></body>')), true, 'the page\'s own code still counts');
  assert.strictEqual(publishedNeedsRuntime('<script>fetch("/_f/x")</script>'), true, 'no marker: as before');
  assert.strictEqual(publishedNeedsRuntime('<script src="artifact-type/app.js"></script>'), true);
  assert.strictEqual(publishedNeedsRuntime('<!-- frame-runtime --><script src="artifact-type/app.js"></script>'), true, 'a script that is not the preamble still counts');
  assert.strictEqual(publishedNeedsRuntime('<h1>plain</h1>'), false);
});

test('previewKind keeps .json', () => {
  const { previewKind } = require('../export-core.js');
  assert.strictEqual(previewKind('project/canvas.json'), 'text');
  assert.strictEqual(previewKind('a.JSON'), 'text');
});

test('Export Artifacts keeps canvas.json in a Design artifact\'s preview, after the start file', async () => {
  const frames = [art(U(1), 'Mock', { typeSlug: DESIGN_TYPE, typeTitle: 'Design' })];
  const pages = { [U(1)]: livePage('Mock', { 'project/Main.dc.html': '<p>main</p>', 'index.html': '<script src="artifact-type/app.js"></script>', 'project/canvas.json': '{"v":3,"boards":{}}' }) };
  const { files, views } = await runArtifacts({ frames, pages });
  // The view's payload, as its part file holds it: window.__archivePart(n, { <key>: payload }).
  let held = null;
  const sandbox = { window: { __archivePart: (n, o) => { held = o; } } };
  vm.runInNewContext(files[`viewer-files/part-${String(views[0].part).padStart(4, '0')}.js`], sandbox);
  assert.deepStrictEqual([...held[views[0].key].texts.map((t) => t[0])], ['index.html', 'project/canvas.json', 'project/Main.dc.html']);
});

test('a served copy with only the preamble is not labelled', async () => {
  const frames = [art(U(1), 'Served', { rel: 'shared', public: true })];
  const { files } = await runArtifacts({ frames, pages: { [U(1)]: livePage('Served', { 'index.html': PREAMBLE_PAGE }) } });
  assert.strictEqual(JSON.parse(files[`${artFolder('Served', U(1))}/artifact.json`]).needsRuntime, false);
});

test('a Design artifact\'s boards are kept ahead of its other files in the preview budget', async () => {
  const big = (n) => JSON.stringify({ n, pad: 'x'.repeat(1900 * 1024) });
  const files = { 'index.html': '<script src="artifact-type/app.js"></script>', 'project/canvas.json': '{"v":3,"boards":{"Main.dc.html":{"x":0,"y":0,"w":10,"h":10}}}' };
  for (const n of ['a', 'b', 'c', 'd', 'e']) files[`project/${n}.json`] = big(n);
  files['project/Main.dc.html'] = '<p>main</p>';
  const frames = [art(U(1), 'Mock', { typeSlug: DESIGN_TYPE, typeTitle: 'Design' })];
  const { files: out, views } = await runArtifacts({ frames, pages: { [U(1)]: livePage('Mock', files) } });
  let held = null;
  vm.runInNewContext(out[`viewer-files/part-${String(views[0].part).padStart(4, '0')}.js`], { window: { __archivePart: (n, o) => { held = o; } } });
  const kept = [...held[views[0].key].texts.map((t) => t[0])];
  assert.deepStrictEqual(kept.slice(0, 3), ['index.html', 'project/canvas.json', 'project/Main.dc.html'], kept.join());
});

test('cleanPublishedInfo keeps listFromLive only as true', () => {
  const clean = vm.runInContext('cleanPublishedInfo', exportPopup().sandbox);
  const base = { ver: 'v1', title: 'T', history: ['v1'], files: [{ path: 'index.html', size: null, contentType: 'text/html', sha256: null }], rejected: [], runtimeSkipped: 0 };
  assert.strictEqual(clean({ ...base, listFromLive: true }).listFromLive, true);
  for (const v of [false, 'true', 1, undefined]) assert.strictEqual(clean({ ...base, listFromLive: v }).listFromLive, false, String(v));
});

// ---- Every version of every artifact (v1.21) ----
const histPage = (title, versions, extra = {}) => ({ title, live: LIVE, history: Object.keys(versions), versions, ...extra });
const infoCalls = (fetcher) => fetcher.calls.filter((c) => c.action === 'publishedPageInfo').map((c) => [c.uuid, c.ver]);

test('every older version is saved in its own folder, oldest first in artifact.json', async () => {
  const frames = [art(U(1), 'Guide')];
  const pages = { [U(1)]: histPage('Guide', { v1: { files: { 'index.html': 'one' } }, v2: { files: { 'index.html': 'two' } }, [LIVE]: { files: { 'index.html': 'live' } } }) };
  const { files, fetcher } = await runArtifacts({ frames, pages });
  const f = artFolder('Guide', U(1));
  assert.deepStrictEqual([files[`${f}/v1/index.html`], files[`${f}/v2/index.html`], files[`${f}/${LIVE}/index.html`]], ['one', 'two', 'live']);
  const json = JSON.parse(files[`${f}/artifact.json`]);
  assert.deepStrictEqual([json.order, json.current], [['v1', 'v2', LIVE], LIVE]);
  for (const v of ['v1', 'v2']) {
    assert.strictEqual(json.versions[v].saved, true, v);
    assert.ok(json.versions[v].files.every((x) => x.verified === true && /^[0-9a-f]{64}$/.test(x.sha256)), v);
  }
  assert.deepStrictEqual(infoCalls(fetcher), [[U(1), LIVE], [U(1), 'v1'], [U(1), 'v2']], 'the current version first, then oldest to newest');
  assert.ok(!files['errors.txt'], files['errors.txt']);
});

test('a version the store already has whole is not fetched again', async () => {
  const sb = exportPopup().sandbox;
  const fetcher = publishedFetcher({ [U(1)]: histPage('Guide', { v1: { files: { 'index.html': 'one' } }, [LIVE]: { files: { 'index.html': 'live' } } }) });
  const root = zipStub();
  sb.setTimeout = (fn) => setTimeout(fn, 0);
  Object.assign(sb, { __root: root, __fetch: fetcher.fetch, __arts: [art(U(1), 'Guide')] });
  const out = JSON.parse(await vm.runInContext(`(async () => {
    const store = artifactStore(__root, { prefix: 'artifacts/' });
    const whole = { folder: 'v1', files: [{ path: 'index.html', savedAs: 'index.html', size: 3, contentType: 'text/html', sha256: '${'c'.repeat(64)}' }],
      start: 'index.html', startSaved: 'index.html', incomplete: false, missing: [], saved: true, publishedIn: [] };
    store.record('${U(1)}', { title: 'Guide' }).versions.set('v1', whole);
    const step = await runArtifactStep(__root, { store, artifacts: __arts, listed: 1, fetchPublished: __fetch, picturesAllowed: false, parts: null });
    return JSON.stringify({ whole: step.whole });
  })()`, sb));
  assert.deepStrictEqual(infoCalls(fetcher), [[U(1), LIVE]]);
  assert.deepStrictEqual(out.whole, [true]);
});

test('an older version claude.ai no longer serves is settled and noted, not warned', async () => {
  const frames = [art(U(1), 'Guide')];
  const page = histPage('Guide', { v1: { files: { 'index.html': 'one' } }, v2: { files: { 'index.html': 'two' } }, [LIVE]: { files: { 'index.html': 'live' } } });
  delete page.versions.v1;
  const { files } = await runArtifacts({ frames, pages: { [U(1)]: page } });
  const json = JSON.parse(files[`${artFolder('Guide', U(1))}/artifact.json`]);
  assert.match(json.note, /1 older version no longer on claude\.ai/);
  assert.ok(!files['errors.txt'], files['errors.txt']);
  assert.ok(!json.incomplete);
});

test('older versions that fail are warned once and leave the artifact not whole', async () => {
  const sb = exportPopup().sandbox;
  const fetcher = publishedFetcher({ [U(1)]: histPage('Guide', {
    v1: { files: { 'index.html': { body: 'tampered', sha256: sha('original') } } },
    v2: { files: { 'index.html': { body: 'x', error: { error: 'network' } } } },
    [LIVE]: { files: { 'index.html': 'live' } },
  }) });
  const root = zipStub();
  sb.setTimeout = (fn) => setTimeout(fn, 0);
  Object.assign(sb, { __root: root, __fetch: fetcher.fetch, __arts: [art(U(1), 'Guide')] });
  const out = JSON.parse(await vm.runInContext(`(async () => {
    const store = artifactStore(__root, { prefix: '' });
    const step = await runArtifactStep(__root, { store, artifacts: __arts, listed: 1, fetchPublished: __fetch, picturesAllowed: false, parts: null });
    return JSON.stringify({ whole: step.whole, warnings: step.collector.warnings.map((w) => w.error) });
  })()`, sb));
  assert.deepStrictEqual(out.whole, [false]);
  const mine = out.warnings.filter((w) => /older versions? could not be saved/.test(w));
  assert.strictEqual(mine.length, 1, JSON.stringify(out.warnings));
  assert.match(mine[0], /2 older versions could not be saved/);
  assert.ok(!/https?:/.test(mine[0]), 'codes only');
  const json = JSON.parse(root.written[`${artFolder('Guide', U(1))}/artifact.json`]);
  assert.deepStrictEqual([json.versions.v1.incomplete, json.versions.v2.incomplete], [true, true]);
});

test('a 401 in an artifact\'s history stops fetching', async () => {
  const frames = [art(U(1), 'Guide'), art(U(2), 'Next')];
  const pages = {
    [U(1)]: histPage('Guide', { v1: { files: { 'index.html': { body: 'x', error: { error: 'HTTP 401', status: 401 } } } }, v2: { files: { 'index.html': 'two' } }, [LIVE]: { files: { 'index.html': 'live' } } }),
    [U(2)]: livePage('Next', { 'index.html': 'n' }),
  };
  const { files, fetcher } = await runArtifacts({ frames, pages });
  assert.strictEqual(files[`${artFolder('Guide', U(1))}/${LIVE}/index.html`], 'live', 'the current version stays saved');
  assert.deepStrictEqual(infoCalls(fetcher), [[U(1), LIVE], [U(1), 'v1']]);
  assert.strictEqual((files['errors.txt'].match(/signed out|HTTP 401/g) || []).length >= 1, true);
});

test('an older Cowork version takes the live version\'s paths, unverified, a path it lacks missing', async () => {
  const frames = [art(U(1), 'Notes', { sourceSurface: 'cowork' })];
  const pages = { [U(1)]: histPage('Notes', {
    v1: { listFromLive: true, files: { 'index.html': { body: 'old', unverified: true }, 'app.js': { body: 'x', unverified: true, error: { error: 'HTTP 404', status: 404 } } } },
    [LIVE]: { files: { 'index.html': { body: 'new', unverified: true }, 'app.js': { body: 'go()', unverified: true } } },
  }) };
  const { files } = await runArtifacts({ frames, pages });
  const f = artFolder('Notes', U(1));
  assert.strictEqual(files[`${f}/v1/index.html`], 'old');
  const v1 = JSON.parse(files[`${f}/artifact.json`]).versions.v1;
  assert.ok(v1.files.every((x) => x.verified === false));
  assert.deepStrictEqual(v1.missing, ['app.js']);
  assert.strictEqual(v1.folder, 'v1');
});

test('Claude Docs fetch no history', async () => {
  const frames = [art(U(1), 'Doc', { typeSlug: DOCS_TYPE, typeTitle: 'Docs' })];
  const pages = { [U(1)]: histPage('Doc', { v1: { files: {} }, [LIVE]: { files: {} } }) };
  const { fetcher } = await runArtifacts({ frames, pages });
  assert.strictEqual(fetcher.calls.filter((c) => c.ver === 'v1').length, 0);
});

const histFetcher = (broken = {}) => publishedFetcher({ [U(1)]: histPage('Guide', {
  v1: { files: { 'index.html': 'one' } },
  v2: { files: { 'index.html': broken.v2 ? { body: 'x', error: { error: 'network' } } : 'two' } },
  [LIVE]: { files: { 'index.html': 'live' } },
}) });
const changesRun = (stored, fetcher) => runBulkZip({ list: [listed('a', '2026-01-01T00:00:00Z')], chats: { a: chatFor('a', '2026-01-01T00:00:00Z') }, stored,
  options: { changesOnly: true }, setup: bulkWithArtifacts({ frames: [art(U(1), 'Guide')], fetcher }) });
const recordOf = (store) => store.exportRecord['org-1'];

test('Export Changes skips older versions an earlier Export All saved', async () => {
  const stored = { exportRecord: { 'org-1': { at: '2026-01-05T00:00:00Z', chats: { a: '2026-01-01T00:00:00Z' }, artifacts: { [U(1)]: 'old' }, artifactVersions: { [U(1)]: ['v1'] } } } };
  const fetcher = histFetcher();
  const { store } = await changesRun(stored, fetcher);
  assert.deepStrictEqual(infoCalls(fetcher), [[U(1), LIVE], [U(1), 'v2']]);
  assert.deepStrictEqual([...recordOf(store).artifactVersions[U(1)]].sort(), [LIVE, 'v1', 'v2'].sort());
  assert.strictEqual(recordOf(store).artifacts[U(1)], LIVE);
});

test('a failed older version keeps the artifact in the next Export Changes', async () => {
  const stored = { exportRecord: { 'org-1': { at: '2026-01-05T00:00:00Z', chats: { a: '2026-01-01T00:00:00Z' }, artifacts: { [U(1)]: 'old' }, artifactVersions: { [U(1)]: ['v1'] } } } };
  const first = await changesRun(stored, histFetcher({ v2: true }));
  assert.notStrictEqual(recordOf(first.store).artifacts[U(1)], LIVE, 'not recorded as exported');
  assert.ok(!recordOf(first.store).artifactVersions[U(1)].includes('v2'));
  assert.ok(recordOf(first.store).artifactVersions[U(1)].includes(LIVE));
  const fetcher = histFetcher();
  const second = await changesRun(first.store, fetcher);
  assert.deepStrictEqual(infoCalls(fetcher).filter(([, v]) => v !== LIVE), [[U(1), 'v2']], 'only the failed older version is fetched again');
  assert.strictEqual(recordOf(second.store).artifacts[U(1)], LIVE);
});

test('a record from before v1.21 fetches every version once', async () => {
  const stored = { exportRecord: { 'org-1': { at: '2026-01-05T00:00:00Z', chats: { a: '2026-01-01T00:00:00Z' }, artifacts: { [U(1)]: 'old' } } } };
  const fetcher = histFetcher();
  const { store } = await changesRun(stored, fetcher);
  assert.deepStrictEqual(infoCalls(fetcher), [[U(1), LIVE], [U(1), 'v1'], [U(1), 'v2']]);
  assert.deepStrictEqual([...recordOf(store).artifactVersions[U(1)]].sort(), [LIVE, 'v1', 'v2'].sort());
});

test('Export Artifacts records nothing, and a full Export All fetches every version', async () => {
  const fetcher = histFetcher();
  const { store } = await runArtifacts({ frames: [art(U(1), 'Guide')], pages: { [U(1)]: histPage('Guide', { v1: { files: { 'index.html': 'one' } }, v2: { files: { 'index.html': 'two' } }, [LIVE]: { files: { 'index.html': 'live' } } }) } });
  assert.ok(!store.exportRecord);
  const stored = { exportRecord: { 'org-1': { at: '2026-01-05T00:00:00Z', chats: {}, artifacts: { [U(1)]: LIVE }, artifactVersions: { [U(1)]: ['v1', 'v2', LIVE] } } } };
  const full = histFetcher();
  await runBulkZip({ list: [listed('a', '2026-01-01T00:00:00Z')], chats: { a: chatFor('a', '2026-01-01T00:00:00Z') }, stored, setup: bulkWithArtifacts({ frames: [art(U(1), 'Guide')], fetcher: full }) });
  assert.deepStrictEqual(infoCalls(full), [[U(1), LIVE], [U(1), 'v1'], [U(1), 'v2']], 'a full export saves every version, every time');
});

test('artifactViewParts: a reserve keeps room for what comes later', () => {
  const { artifactViewParts, ARTIFACT_HISTORY_RESERVE } = require('../takeout-viewer.js');
  assert.strictEqual(ARTIFACT_HISTORY_RESERVE, 64 * 1024 * 1024);
  const older = { texts: [['a.html', 'x'.repeat(650)]], images: [] };
  const current = { texts: [['b.html', 'y'.repeat(400)]], images: [] };
  const parts = artifactViewParts({ budget: 1000, partLimit: 1e6 });
  assert.strictEqual(parts.add({}, older, { reserve: 400 }).part, null, 'an older preview past budget - reserve is left out');
  assert.notStrictEqual(parts.add({}, current).part, null, 'and the budget is not marked full');
  assert.notStrictEqual(artifactViewParts({ budget: 1000, partLimit: 1e6 }).add({}, older).part, null);
});

test('older versions get preview parts: in the standalone viewer\'s versions and Export All\'s viewer data', async () => {
  const pages = { [U(1)]: histPage('Guide', { v1: { files: { 'index.html': '<h1>one</h1><!--V1-->' } }, [LIVE]: { files: { 'index.html': 'live' } } }) };
  const { views } = await runArtifacts({ frames: [art(U(1), 'Guide')], pages });
  const vs = views[0].versions;
  assert.deepStrictEqual(vs.map((e) => [e.ver, e.current]), [['v1', false], [LIVE, true]]);
  assert.ok(Number.isSafeInteger(vs[0].part) && vs[0].part > 0 && typeof vs[0].key === 'string', JSON.stringify(vs[0]));
  assert.strictEqual(vs[0].folder, `${artFolder('Guide', U(1))}/v1`);
  const { zip } = await runBulkZip({ list: [listed('a', '2026-01-01T00:00:00Z')], chats: { a: chatFor('a', '2026-01-01T00:00:00Z') },
    setup: bulkWithArtifacts({ frames: [art(U(1), 'Guide')], fetcher: publishedFetcher(pages) }), assets: true });
  const html = await zip.file('viewer.html').async('string');
  const data = JSON.parse(/<script id="data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1]);
  const e1 = data.artifacts[0].versions.find((e) => e.ver === 'v1');
  assert.ok(e1 && Number.isSafeInteger(e1.part) && e1.folder === `artifacts/${artFolder('Guide', U(1))}/v1`, JSON.stringify(e1));
});

// ---- v1.21 final review fixes ----
const stepWithStored = async (stored, extra = '') => {
  const sb = exportPopup().sandbox;
  const fetcher = histFetcher();
  const root = zipStub();
  sb.setTimeout = (fn) => setTimeout(fn, 0);
  Object.assign(sb, { __root: root, __fetch: fetcher.fetch, __arts: [art(U(1), 'Guide')] });
  const out = JSON.parse(await vm.runInContext(`(async () => {
    const store = artifactStore(__root, { prefix: 'artifacts/' });
    const v = ${JSON.stringify(stored)};
    Object.defineProperty(v, 'preview', { value: { texts: [['index.html', 'live']], images: [] }, writable: true, configurable: true });
    store.record('${U(1)}', { title: 'Guide' }).versions.set('${LIVE}', v);
    ${extra}
    const step = await runArtifactStep(__root, { store, artifacts: __arts, listed: 1, fetchPublished: __fetch, picturesAllowed: false, parts: null });
    return JSON.stringify({ whole: step.whole, notExported: step.views[0].notExported, saved: step.versionsSaved });
  })()`, sb));
  return { out, fetcher, root };
};

test('older versions are fetched when the current version came whole from a chat (kept)', async () => {
  const { out, fetcher } = await stepWithStored({ folder: LIVE, files: [{ path: 'index.html', savedAs: 'index.html', size: 4, contentType: 'text/html', sha256: 'c'.repeat(64) }],
    start: 'index.html', startSaved: 'index.html', incomplete: false, missing: [], saved: true, publishedIn: [] });
  assert.ok(infoCalls(fetcher).some(([, v]) => v === 'v1') && infoCalls(fetcher).some(([, v]) => v === 'v2'), JSON.stringify(infoCalls(fetcher)));
  assert.deepStrictEqual([out.whole[0], out.notExported], [true, false]);
  assert.deepStrictEqual([...out.saved[0]].sort(), [LIVE, 'v1', 'v2'].sort());
});

test('older versions are fetched when the current version is a chat\'s own file (same)', async () => {
  const { fetcher } = await stepWithStored({ folder: null, files: [{ path: 'index.html', savedAs: 'index.html', size: 4, contentType: 'text/html', sha256: 'c'.repeat(64) }],
    start: 'index.html', startSaved: 'index.html', incomplete: false, missing: [], saved: false, sameAs: { 'index.html': 'Chat_a/artefacts/guide.html' }, publishedIn: [] });
  assert.ok(infoCalls(fetcher).some(([, v]) => v === 'v1'), JSON.stringify(infoCalls(fetcher)));
});

test('an unchanged artifact with a record from before v1.21 is included once for its versions', async () => {
  const stored = { exportRecord: { 'org-1': { at: '2026-01-05T00:00:00Z', chats: { a: '2026-01-01T00:00:00Z' }, artifacts: { [U(1)]: LIVE } } } };
  const fetcher = histFetcher();
  const { store } = await changesRun(stored, fetcher);
  assert.deepStrictEqual(infoCalls(fetcher), [[U(1), LIVE], [U(1), 'v1'], [U(1), 'v2']]);
  assert.deepStrictEqual([...recordOf(store).artifactVersions[U(1)]].sort(), [LIVE, 'v1', 'v2'].sort());
  const again = histFetcher();
  await changesRun(store, again);
  assert.deepStrictEqual(infoCalls(again), [], 'then left out while nothing changed');
});

test('Export All finishes when the artifact step stops early', async () => {
  const setup = (sb) => {
    bulkWithArtifacts({ frames: [art(U(1), 'Guide')], fetcher: histFetcher() })(sb);
    vm.runInContext('const __origStep = runArtifactStep; runArtifactStep = async (...a) => { const s = await __origStep(...a); s.entries = []; s.whole = []; s.versionsSaved = []; return s; };', sb);
  };
  const { zip, result } = await runBulkZip({ list: [listed('a', '2026-01-01T00:00:00Z')], chats: { a: chatFor('a', '2026-01-01T00:00:00Z') }, setup });
  assert.ok(zip, 'the export was written');
  assert.strictEqual(result.outcome, 'done', JSON.stringify(result));
});

test('collector notes: counted apart, reported under ## Notes', () => {
  const c = new (fn('ExportErrorCollector'))('n', 'u');
  c.addWarning('str_replace_failed', 'a.html', 'm');
  c.addNote('draft_superseded', 'body_2.html', 'Draft of a file Claude later rewrote', { path: '/home/claude/verb/lorber/body.html' });
  assert.strictEqual(c.warnings.length, 1);
  assert.strictEqual(c.notes.length, 1);
  assert.ok(c.hasNotes());
  const report = c.generateErrorReport();
  assert.ok(report.includes('**Notes:** 1 total'));
  const at = (s) => report.indexOf(s);
  assert.ok(at('## Notes') > at('## Warnings') && at('### body_2.html') > at('## Notes') && at('- **Type:** draft superseded') > at('### body_2.html'));
  assert.ok(report.includes('replay_bash.py can try to rebuild it.'));
});

test('collector: notes only still writes a report', () => {
  const c = new (fn('ExportErrorCollector'))('n', 'u');
  c.addNote('helper_script', 'make.py', 'm');
  assert.ok(c.hasAny());
  assert.ok(!c.hasWarnings());
  const report = c.generateErrorReport();
  assert.ok(report.includes('## Notes'));
  assert.ok(!report.includes('## Warnings'));
});

test('readmeNoteLines groups by kind', () => {
  const readmeNoteLines = fn('readmeNoteLines');
  assert.deepStrictEqual(Array.from(readmeNoteLines([])), []);
  const note = (type, filename) => ({ type, filename, error: `about ${filename}` });
  const lines = Array.from(readmeNoteLines([note('draft_superseded', 'body_2.html'), note('draft_superseded', 'b_3.html'), note('helper_script', 'make.py')]));
  assert.ok(lines.includes('## About some files'));
  const i = lines.indexOf('### Drafts');
  const j = lines.indexOf('### Helper scripts');
  assert.ok(i > 0 && j > i);
  assert.strictEqual(lines.slice(i, j).filter((l) => l.startsWith('- `')).length, 2);
  assert.strictEqual(lines.slice(j).filter((l) => l.startsWith('- `')).length, 1);
  assert.ok(lines.includes('- `body_2.html`: about body_2.html'));
  assert.ok(!lines.includes('### Renamed files'));
});

// ---- Replay of literal sed -i and cat >> appends (spec section 3) ----

// JS and Python give the same text for a file.
const bothReplay = (data, file, want) => {
  assert.strictEqual(artifacts(data)[file], want, 'JS ' + file);
  assert.strictEqual(pythonArtifacts(data)[file], want, 'Python ' + file);
};
// The warnings the detector gives once extractArtifacts' replayed commands are passed to it.
const opaqueAfterReplay = (data) => {
  const replayed = new Set();
  const index = {};
  fn('extractArtifacts')(data, null, index, replayed);
  const c = collector();
  fn('detectOpaqueMutations')(data, c, { replayed, index });
  return { warnings: c.warnings, replayed };
};
const PAGE = '<line y2="92" a="1"/><line y2="92"/>\nx <line y2="92"/>\n';

test('replay: sed -i after cd replays, per line', () => {
  const data = turns(
    [use('w', 'Write', { file_path: '/home/claude/x/page.html', content: PAGE })],
    [use('s', 'bash_tool', { command: "cd /home/claude/x && sed -i 's|<line y2=\"92\"|<line y2=\"116\"|' page.html" })],
  );
  bothReplay(data, 'page.html', '<line y2="116" a="1"/><line y2="92"/>\nx <line y2="116"/>\n');
  bothReplay(data, 'page_v1.html', PAGE);
  const { warnings, replayed } = opaqueAfterReplay(data);
  assert.deepStrictEqual([...replayed], ['s|/home/claude/x/page.html']);
  assert.strictEqual(warnings.length, 0);
});

test('replay: sed -i with g, -e twice, -i.bak and two files', () => {
  const two = (command) => turns(
    [use('w1', 'Write', { file_path: '/h/a.txt', content: 'a a\na.a\n' }), use('w2', 'Write', { file_path: '/h/b.md', content: 'a/a\n' })],
    [use('s', 'Bash', { command })],
  );
  bothReplay(two("sed -i 's/a/b/' /h/a.txt"), 'a.txt', 'b a\nb.a\n');
  bothReplay(two("sed -i 's/a/b/g' /h/a.txt"), 'a.txt', 'b b\nb.b\n');
  bothReplay(two("sed -i -e 's/a/b/' -e 's/b/c/g' /h/a.txt"), 'a.txt', 'c a\nc.a\n');
  bothReplay(two("sed -i.bak 's/a\\.a/X/' /h/a.txt"), 'a.txt', 'a a\nX\n');
  const both = two("sed -i 's#a\\/a#Y#;' /h/b.md");
  bothReplay(both, 'b.md', 'a/a\n');  // two commands in one script: not a shape, unchanged
  const files = two("cd /h && sed -i 's/a/Z/g' a.txt b.md && grep -c Z a.txt");
  bothReplay(files, 'a.txt', 'Z Z\nZ.Z\n');
  bothReplay(files, 'b.md', 'Z/Z\n');
  assert.strictEqual(opaqueAfterReplay(files).warnings.length, 0);
});

test('replay: shapes that are not literal stay opaque, unchanged, with a warning', () => {
  const original = 'a.b axb a ab\n';
  for (const command of [
    "sed -i 's/a.b/c/' /h/page.html",
    "sed -i 's/x/&y/' /h/page.html",
    "sed -i 's/\\(a\\)/\\1/' /h/page.html",
    "sed -i 's/a/b/' /h/page.html | tee /h/log.txt",
    "sed -i 's/a/b/' /h/page.html && cat /h/page.html > /h/copy.html",
    "sed -i \"s/a/$X/\" /h/page.html",
    "sed -E -i 's/a/b/' /h/page.html",
    "sed -i 's/a/b/' /h/page.html && python3 build.py",
    "sed -i 's/a/b/' page.html",
  ]) {
    const data = turns([use('w', 'Write', { file_path: '/h/page.html', content: original })], [use('s', 'bash_tool', { command })]);
    bothReplay(data, 'page.html', original);
    const { warnings, replayed } = opaqueAfterReplay(data);
    assert.strictEqual(replayed.size, 0, command);
    assert.strictEqual(warnings.length, 1, command);
  }
});

test('replay: cat >> appends a quoted heredoc; an unquoted one with $ stays opaque', () => {
  const append = (command, first = use('w', 'Write', { file_path: '/h/page.html', content: 'one\n' })) =>
    turns([first], [use('s', 'bash_tool', { command })]);
  const quoted = append("cat >> /h/page.html << 'E'\nmore\nE");
  bothReplay(quoted, 'page.html', 'one\nmore\n');
  assert.strictEqual(opaqueAfterReplay(quoted).warnings.length, 0);
  bothReplay(append('cat >> /h/page.html <<E\nplain\nE'), 'page.html', 'one\nplain\n');
  // A heredoc-made file lost its last newline in the export; the append puts it back.
  bothReplay(append("cat >>/h/page.html << 'E'\nmore\nE", use('w', 'bash_tool', { command: "cat > /h/page.html << 'E'\none\nE" })), 'page.html', 'one\nmore\n');
  const dollar = append('cat >> /h/page.html << E\n$HOME\nE');
  bothReplay(dollar, 'page.html', 'one\n');
  assert.strictEqual(opaqueAfterReplay(dollar).warnings.length, 1);
});

test('replay: a failed command, or one whose directory is unknown, is not replayed', () => {
  const failed = turns(
    [use('w', 'Write', { file_path: '/x/f.html', content: 'a\n' })],
    [use('s', 'bash_tool', { command: "cd /x && sed -i 's/a/b/' f.html && grep -c zz f.html" }), result('s', true)],
  );
  bothReplay(failed, 'f.html', 'a\n');
  assert.strictEqual(opaqueAfterReplay(failed).warnings.length, 1);
  const conditional = turns(
    [use('w', 'Write', { file_path: '/x/f.html', content: 'a\n' }), use('w2', 'Write', { file_path: '/y/f.html', content: 'a\n' })],
    [use('c', 'bash_tool', { command: 'cd /x' }), use('d', 'bash_tool', { command: 'if test -d /y; then cd /y; fi' })],
    [use('s', 'bash_tool', { command: "sed -i 's/a/b/' f.html" })],
  );
  bothReplay(conditional, 'f.html', 'a\n');
});

test('replay: stops at the first opaque command on a file and never resumes', () => {
  const data = turns(
    [use('w', 'Write', { file_path: '/h/p.html', content: 'a c\n' })],
    [use('s1', 'bash_tool', { command: "sed -i 's/a/b/' /h/p.html" })],
    [use('py', 'bash_tool', { command: "python3 -c \"import re;s=open('/h/p.html').read();open('/h/p.html','w').write(re.sub('c','d',s))\"" })],
    [use('s2', 'bash_tool', { command: "sed -i 's/b/e/' /h/p.html" })],
  );
  bothReplay(data, 'p.html', 'b c\n');
  bothReplay(data, 'p_v2.html', 'b c\n');
  const { warnings, replayed } = opaqueAfterReplay(data);
  assert.deepStrictEqual([...replayed], ['s1|/h/p.html']);
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0].message, /2 commands/);
});

test('replay: a copy to outputs or a read does not stop a later replay', () => {
  const data = turns(
    [use('w', 'Write', { file_path: '/h/p.html', content: 'a\n' })],
    [use('c', 'bash_tool', { command: 'cp /h/p.html /mnt/user-data/outputs/ && wc -l /h/p.html' })],
    [use('s', 'bash_tool', { command: "sed -i 's/a/b/' /h/p.html" })],
  );
  bothReplay(data, 'p.html', 'b\n');
});

test('commandCwds: a cd after then, do, else, { or ! is unknown, for later commands too', () => {
  for (const command of ['if test -d /b; then cd /b; fi', 'for d in /b; do cd $d; done', 'test -d /b || { cd /b; }', '! cd /b', 'if false; then :; else cd /b; fi']) {
    const data = turns([use('a', 'bash_tool', { command: 'cd /a' }), use('b', 'bash_tool', { command }), use('c', 'bash_tool', { command: 'ls' })]);
    const cwds = fn('commandCwds')(fn('getMessageChain')(data));
    assert.strictEqual(cwds.get('b'), null, command);
    assert.strictEqual(cwds.get('c'), null, command);
  }
});

test('replay: populateConversationFolder gives no warning for a replayed sed, and the file has the edit', async () => {
  const files = {};
  const data = turns(
    [use('w', 'Write', { file_path: '/h/page.html', content: 'a\n' })],
    [use('s', 'bash_tool', { command: "sed -i 's/a/b/' /h/page.html" })],
  );
  data.uuid = 'c-replay';
  sandbox.__data = data;
  sandbox.__files = files;
  const output = await vm.runInContext("populateConversationFolder(({ file(n, c) { __files[n] = c; } }), __data, null, 'org')", sandbox);
  assert.strictEqual(Array.from(output.errorCollector.warnings).filter((w) => w.type === 'artifact_opaque_mutation').length, 0);
  assert.strictEqual(String(files['artefacts/page.html']).replace(/^﻿/, ''), 'b\n');
});

test('replay helpers: commandCwds, literalSwapCommand and commandTouches agree in JS and Python', () => {
  const commands = [
    'ls', 'cd /home/claude/x && ls', 'python3 run.py', 'cd /tmp; python3 a.py', "cat > /h/s.py << 'EOF'\ncd /nowhere\nEOF",
    'cd lorber && ls', 'cd ~', "cd /a && ls; cd /b && sed -i 's/a/b/' page.html", "cd /a || exit 1\nsed -i 's/a/b/' page.html",
    "python3 -c \"import os;os.chdir('/b')\"", 'pushd /b', '(cd /b && ls)', 'if x; then cd /y; fi', 'cd "/q q" ; ls',
    "cd /h && sed -i -e 's|a\\|b|c|g' -e 's/x/y/' p.html q.md && grep -c y p.html", "sed -i.bak 's/a\\.b/\\&/' /h/p.html",
    "cat >> /h/p.html << 'E'\nmore\n\tE\nE", "cat <<-E >> /h/p.html\n\tx\n\tE", "cat >> p.html << E\n$x\nE", "sed -n '1,5p' /h/p.html; echo hi",
    "sed -i 's/a/b/' /h/p.html | tee x", 'cp /h/p.html /out/ && cp /h/q.md /out/q2.md', "python3 - << 'PY'\nopen('p.html','w')\nPY",
    "cat > /h/p.html << E\n$HOME\nE", "[ -f /h/p.html ] && sed -i 's/a/b/' /h/p.html", "sed -i 's/a/b/' *.html", 'echo x >> /h/p.html',
  ];
  const known = ['/h/p.html', '/h/q.md', '/out/q2.md', '/out/p.html', 'p.html'];
  const data = turns(commands.map((command, i) => use('c' + i, 'bash_tool', { command })));
  const core = require('../export-core.js');
  const cwds = core.commandCwds(core.getMessageChain(data));
  const js = commands.map((command, i) => {
    const cwd = cwds.get('c' + i);
    return { cwd, swap: core.literalSwapCommand(command, cwd), touches: [...core.commandTouches(command, cwd, known)].sort() };
  });
  const script = [
    'import json, sys',
    `sys.path.insert(0, ${JSON.stringify(REPO)})`,
    'import extract_artifacts as ea',
    'data, known = json.load(sys.stdin)',
    'msgs = ea.get_message_chain(data)',
    'cwds = ea.command_cwds(msgs)',
    'out = []',
    'for b in msgs[-1]["content"]:',
    '    cwd = cwds.get(b["id"])',
    '    swap = ea.literal_swap_command(b["input"]["command"], cwd)',
    '    if swap is not None:',
    '        swap = {"edits": [dict(e, subs=[{"from": f, "to": t, "global": g} for f, t, g in e["subs"]]) if e["kind"] == "sed" else e for e in swap]}',
    '    out.append({"cwd": cwd, "swap": swap, "touches": sorted(ea.command_touches(b["input"]["command"], cwd, known))})',
    'print(json.dumps(out))',
  ].join('\n');
  const python = JSON.parse(execFileSync('python3', ['-B', '-c', script], { input: JSON.stringify([data, known]) }).toString());
  assert.deepStrictEqual(python, plain(js));
  // A few values pinned, so both being wrong the same way still fails.
  assert.strictEqual(js[12].cwd, null);
  assert.deepStrictEqual(js[14].swap.edits.map((e) => e.path), ['/h/p.html', '/h/q.md']);
  assert.deepStrictEqual(js[14].swap.edits[0].subs, [{ from: 'a|b', to: 'c', global: true }, { from: 'x', to: 'y', global: false }]);
  assert.strictEqual(js[15].swap.edits[0].subs[0].to, '&');
  assert.strictEqual(js[16].swap, null, 'a tab before the delimiter needs <<-');
  assert.strictEqual(js[17].swap.edits[0].text, 'x\n');
  assert.strictEqual(js[18].swap, null);
  assert.deepStrictEqual(js[19].swap, { edits: [] });
  assert.deepStrictEqual(js[21].touches, ['/out/p.html', '/out/q2.md']);
  assert.deepStrictEqual(js[22].touches, ['/h/p.html', '/out/p.html', 'p.html']);
  assert.deepStrictEqual(js[23].touches, ['/h/p.html']);
  assert.ok(js[24].swap && js[24].swap.edits.length === 1);
  assert.strictEqual(js[25].swap, null);
  assert.strictEqual(js[26].swap, null);
});
