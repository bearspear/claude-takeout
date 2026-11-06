// Viewer page logic: message tree and hash state.
const { test } = require('node:test');
const assert = require('node:assert');
const { chainFrom, siblingsOf, leafUnder, switchBranch, parseHash, formatHash } = require('../viewer/viewer-logic.js');

const msgs = [
  { id: 'r', parent: null, sender: 'human', at: '2026-01-01T00:00:00Z' },
  { id: 'a1', parent: 'r', sender: 'assistant', at: '2026-01-01T00:00:01Z' },
  { id: 'a2', parent: 'r', sender: 'assistant', at: '2026-01-01T00:00:02Z' },
  { id: 'h3', parent: 'a2', sender: 'human', at: '2026-01-01T00:00:03Z' },
  { id: 'a4', parent: 'h3', sender: 'assistant', at: '2026-01-01T00:00:04Z' },
];

test('chainFrom walks root to leaf', () => {
  assert.deepStrictEqual(chainFrom(msgs, 'a4').map(m => m.id), ['r', 'a2', 'h3', 'a4']);
});

test('chainFrom edge cases', () => {
  assert.deepStrictEqual(chainFrom([], null), []);
  assert.deepStrictEqual(chainFrom(msgs, 'nope').map(m => m.id), ['r', 'a2', 'h3', 'a4']);
  assert.deepStrictEqual(chainFrom([{ id: 'x', parent: 'y' }, { id: 'y', parent: 'x' }], 'x').length, 2);
  assert.deepStrictEqual(chainFrom([{ id: 'z', parent: 'gone' }], 'z').map(m => m.id), ['z']);
});

test('siblings, leafUnder and switchBranch', () => {
  assert.deepStrictEqual(siblingsOf(msgs, 'a2'), { ids: ['a1', 'a2'], index: 1 });
  assert.strictEqual(leafUnder(msgs, 'a2'), 'a4');
  assert.strictEqual(switchBranch(msgs, 'a2', -1), 'a1');
  assert.strictEqual(switchBranch(msgs, 'a2', 1), null);
});

test('hash round trip and bad input', () => {
  const s = { chat: 'c 1', leaf: 'm', file: null, version: 2 };
  assert.deepStrictEqual(parseHash(formatHash(s)), s);
  assert.deepStrictEqual(parseHash('#junk=%E0%A4'), { chat: null, leaf: null, file: null, version: null });
});

test('prototype-like ids are looked up safely', () => {
  const newest = ['r', 'a2', 'h3', 'a4'];
  assert.deepStrictEqual(chainFrom(msgs, '__proto__').map(m => m.id), newest);
  assert.deepStrictEqual(chainFrom(msgs, 'constructor').map(m => m.id), newest);
  assert.doesNotThrow(() => leafUnder(msgs, '__proto__'));
  const odd = [{ id: 'r', parent: null, at: '1' }, { id: '__proto__', parent: 'r', at: '2' }, { id: 'k', parent: '__proto__', at: '3' }];
  assert.deepStrictEqual(chainFrom(odd, '__proto__').map(m => m.id), ['r', '__proto__']);
  assert.strictEqual(leafUnder(odd, '__proto__'), 'k');
  assert.deepStrictEqual(chainFrom([{ id: 'z', parent: 'constructor', at: '1' }], 'z').map(m => m.id), ['z']);
  assert.deepStrictEqual(siblingsOf([{ id: 'z', parent: 'constructor', at: '1' }], 'z'), { ids: ['z'], index: 0 });
});

// ---- builder (takeout-viewer.js) ----
const fs = require('node:fs');
const path = require('node:path');
const V = require('../takeout-viewer.js');
const { buildViewerChat, buildViewerData, relHref, joinPath, escapeJson, assembleViewer, VIEWER_ASSETS, TOOL_TEXT_LIMIT } = V;
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/conversation.json'), 'utf8'));
const template = fs.readFileSync(path.join(__dirname, '../viewer/viewer-template.html'), 'utf8');
const assets = { template, css: '.k{}', marked: 'var marked=1;', katex: 'var katex=1;', logic: 'var logic=1;', app: 'var app=1;' };

test('buildViewerChat keeps every branch, sets the leaf, and leaves data alone', () => {
  const before = JSON.stringify(fixture);
  const chat = buildViewerChat(fixture, { folder: '' });
  assert.strictEqual(JSON.stringify(fixture), before);
  assert.strictEqual(chat.messages.length, fixture.chat_messages.length);
  assert.strictEqual(chat.leaf, 'm08');
  assert.strictEqual(chat.id, fixture.uuid);
  assert.strictEqual(chat.title, 'Synthetic fixture');
  assert.strictEqual(chat.model, 'claude-x');
  assert.deepStrictEqual(chat.files, {});
  assert.strictEqual(chat.project, null);
  const m = chat.messages.find(x => x.id === 'x01');
  assert.strictEqual(m.parent, 'm05');
  assert.deepStrictEqual(m.uploads, []);
});

test('ctx.model overrides and ctx.fixText applies to attachments', () => {
  const chat = buildViewerChat(fixture, { model: 'Claude Test', fixText: s => s.toUpperCase() });
  assert.strictEqual(chat.model, 'Claude Test');
  const m03 = chat.messages.find(x => x.id === 'm03');
  assert.deepStrictEqual(m03.attachments, [{ name: 'notes.txt', text: 'PASTED NOTES' }]);
});

test('thinking, citations and tool results become blocks', () => {
  const m02 = buildViewerChat(fixture, {}).messages.find(x => x.id === 'm02');
  assert.deepStrictEqual(m02.blocks[0], { t: 'thinking', text: 'Plan the report first.\nThen write it.', summary: 'Planning the report' });
  assert.deepStrictEqual(m02.blocks[1], { t: 'text', text: 'Creating it.', cites: [{ end: 8, url: 'https://example.com/a', title: 'Example A' }] });
  const tools = m02.blocks.filter(b => b.t === 'tool');
  assert.strictEqual(tools.length, 3);
  assert.strictEqual(tools[0].name, 'create_file');
  assert.strictEqual(tools[0].result, 'ok');
  assert.strictEqual(tools[0].error, false);
  assert.deepStrictEqual(tools[0].images, []);
  assert.ok(m02.blocks.every(b => b.t !== 'tool_result'));
});

test('is_error sets error; results join their tool_use across messages; orphans drop', () => {
  const data = {
    uuid: 'c', name: 'n', current_leaf_message_uuid: 'b',
    chat_messages: [
      { uuid: 'a', parent_message_uuid: null, sender: 'assistant', content: [
        { type: 'tool_use', id: 'u1', name: 'web_search', input: { query: 'cats' } },
        { type: 'tool_result', tool_use_id: 'orphan', content: [{ type: 'text', text: 'x' }] }] },
      { uuid: 'b', parent_message_uuid: 'a', sender: 'assistant', content: [
        { type: 'tool_result', tool_use_id: 'u1', is_error: true, content: [{ type: 'text', text: 'boom' }] }] }
    ]
  };
  const chat = buildViewerChat(data, {});
  const [a, b] = chat.messages;
  assert.strictEqual(a.blocks.length, 1);
  assert.strictEqual(a.blocks[0].error, true);
  assert.strictEqual(a.blocks[0].result, 'boom');
  assert.strictEqual(a.blocks[0].label, 'Searched the web: cats');
  assert.deepStrictEqual(b.blocks, []);
});

test('long tool results are cut and say so; only safe images and http(s) citations stay', () => {
  const long = 'x'.repeat(TOOL_TEXT_LIMIT + 50);
  const png = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };
  const svg = { type: 'image', source: { type: 'base64', media_type: 'image/svg+xml', data: 'BBBB' } };
  const data = {
    uuid: 'c', name: 'n', current_leaf_message_uuid: 'a',
    chat_messages: [{ uuid: 'a', parent_message_uuid: null, sender: 'assistant', content: [
      { type: 'tool_use', id: 'u', name: 'bash_tool', input: { command: 'ls' } },
      { type: 'tool_result', tool_use_id: 'u', content: [{ type: 'text', text: long }, png, svg] },
      { type: 'text', text: 'hi', citations: [{ end_index: 1, url: 'javascript:alert(1)', title: 'bad' }, { end_index: 2, url: 'http://ok.example/', title: 'ok' }] }
    ] }]
  };
  const [tool, text] = buildViewerChat(data, {}).messages[0].blocks;
  assert.ok(tool.result.length < long.length);
  assert.ok(tool.result.startsWith('x'.repeat(100)));
  assert.match(tool.result, /truncated/i);
  assert.deepStrictEqual(tool.images, ['data:image/png;base64,AAAA']);
  assert.strictEqual(tool.label, 'Ran a command');
  assert.deepStrictEqual(text.cites, [{ end: 2, url: 'http://ok.example/', title: 'ok' }]);
});

test('buildViewerData sorts newest first', () => {
  const mk = (id, updated) => ({ id, title: id, updated, messages: [] });
  const d = buildViewerData([mk('old', '2026-01-01'), mk('new', '2026-03-01'), mk('mid', '2026-02-01')], { exported: 'x' });
  assert.deepStrictEqual(d.chats.map(c => c.id), ['new', 'mid', 'old']);
  assert.strictEqual(d.exported, 'x');
});

test('relHref encodes each segment and refuses escapes; joinPath resolves ..', () => {
  assert.strictEqual(relHref('[p-project]_A#1', 'uploads', 'p01_a b?%.pdf'), '%5Bp-project%5D_A%231/uploads/p01_a%20b%3F%25.pdf');
  assert.strictEqual(relHref('', 'uploads', 'a.pdf'), 'uploads/a.pdf');
  assert.strictEqual(relHref('uploads', '../../etc/passwd'), null);
  assert.strictEqual(joinPath('Chat', '../projects/P/files'), 'projects/P/files');
  assert.strictEqual(joinPath('', 'artefacts/a.html'), 'artefacts/a.html');
  assert.strictEqual(joinPath('Chat', 'uploads/a.pdf'), 'Chat/uploads/a.pdf');
});

test('assembleViewer keeps hostile data inert and fills every placeholder', () => {
  const chat = buildViewerChat(fixture, {});
  const hostile = '</script><!-- $& /*APP_JS*/ \u2028';
  const html = assembleViewer({ ...assets, data: buildViewerData([{ ...chat, title: hostile }], { exported: 'x' }) });
  const raw = /<script id="data"[^>]*>([\s\S]*?)<\/script>/.exec(html)[1];
  assert.strictEqual(JSON.parse(raw).chats[0].title, hostile);
  assert.strictEqual((html.match(/<\/script>/g) || []).length, 5);
  assert.ok(!/\/\*(KATEX_CSS|DATA_JSON|MARKED_JS|KATEX_JS|LOGIC_JS|APP_JS)\*\//.test(html.replace(raw, '')));
  for (const s of ['var marked=1;', 'var katex=1;', 'var logic=1;', 'var app=1;', '.k{}']) assert.ok(html.includes(s));
  assert.strictEqual(escapeJson({ a: '</x' }), '{"a":"<\\/x"}');
});

test('VIEWER_ASSETS lists the six viewer files', () => {
  assert.deepStrictEqual(VIEWER_ASSETS, ['viewer/viewer-template.html', 'viewer/viewer-logic.js', 'viewer/viewer-app.js', 'viewer/marked.min.js', 'viewer/katex.min.js', 'viewer/katex-inline.css']);
});
