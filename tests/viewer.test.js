// Viewer page logic: message tree and hash state.
const { test } = require('node:test');
const assert = require('node:assert');
const { chainFrom, siblingsOf, leafUnder, switchBranch, parseHash, formatHash, protectMath, placeholderMark, splitPlaceholders, addCitations, beforeCitation, toolInputText, buildSearchIndex, searchChats, groupChats, copyText } = require('../viewer/viewer-logic.js');

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
const assets = { template, css: '.k{}', marked: 'var marked=1;', katex: 'var katex=1;', highlight: 'var hljs=1;', logic: 'var logic=1;', app: 'var app=1;' };

test('buildViewerChat keeps every branch, sets the leaf, and leaves data alone', () => {
  const before = JSON.stringify(fixture);
  const chat = buildViewerChat(fixture, { folder: '' });
  assert.strictEqual(JSON.stringify(fixture), before);
  assert.strictEqual(chat.messages.length, fixture.chat_messages.length);
  assert.strictEqual(chat.leaf, 'm08');
  assert.strictEqual(chat.id, fixture.uuid);
  assert.strictEqual(chat.title, 'Synthetic fixture');
  assert.strictEqual(chat.model, 'claude-x');
  // No ctx: only the inactive branch's own create_file can be shown; the deliveries have no file here.
  assert.deepStrictEqual(Object.values(chat.files).map(f => [f.name, f.kind]), [['Minutes.odt', 'missing'], ['report.html', 'missing'], ['abandoned.py', 'code']]);
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
  assert.deepStrictEqual(m02.blocks[0], { t: 'thinking', text: 'Plan the report first.\nThen write it.', summaries: ['Planning the report'], summary: 'Planning the report' });
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

test('tool blocks count result images that are not in the export', () => {
  const png = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };
  const link = () => ({ type: 'image', file_uuid: 'f-1', preview_url: '/synthetic/preview', thumbnail_url: '/synthetic/thumb' });
  const tool = items => buildViewerChat({
    uuid: 'c', name: 'n', current_leaf_message_uuid: 'a',
    chat_messages: [{ uuid: 'a', parent_message_uuid: null, sender: 'assistant', content: [
      { type: 'tool_use', id: 'u', name: 'view', input: { path: '/x' } },
      { type: 'tool_result', tool_use_id: 'u', content: items }] }]
  }, {}).messages[0].blocks[0];
  assert.strictEqual(tool([{ type: 'text', text: 'ok' }, png]).missingImages, 0);
  const one = tool([png, link()]);
  assert.strictEqual(one.missingImages, 1);
  assert.deepStrictEqual(one.images, ['data:image/png;base64,AAAA']);
  assert.strictEqual(tool([link(), link()]).missingImages, 2);
  assert.ok(!JSON.stringify(one).includes('f-1') && !JSON.stringify(one).includes('/synthetic'));
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
  assert.strictEqual((html.match(/<\/script>/g) || []).length, 6);
  assert.ok(!/\/\*(KATEX_CSS|DATA_JSON|MARKED_JS|KATEX_JS|HIGHLIGHT_JS|LOGIC_JS|APP_JS)\*\//.test(html.replace(raw, '')));
  for (const s of ['var marked=1;', 'var katex=1;', 'var hljs=1;', 'var logic=1;', 'var app=1;', '.k{}']) assert.ok(html.includes(s));
  assert.strictEqual(escapeJson({ a: '</x' }), '{"a":"<\\/x"}');
});

test('VIEWER_ASSETS lists the seven viewer files', () => {
  assert.deepStrictEqual(VIEWER_ASSETS, ['viewer/viewer-template.html', 'viewer/viewer-logic.js', 'viewer/viewer-app.js', 'viewer/marked.min.js', 'viewer/katex.min.js', 'viewer/katex-inline.css', 'viewer/highlight.min.js']);
});

const Logic = require('../viewer/viewer-logic.js');

test('the highlighter survives being inlined, and the worker can use it', () => {
  const highlight = fs.readFileSync(path.join(__dirname, '../viewer/highlight.min.js'), 'utf8');
  const html = assembleViewer({ ...assets, highlight, data: { chats: [] } });
  const source = /<script id="highlighter" type="text\/plain">([\s\S]*?)<\/script>/.exec(html)[1];
  const hljs = new Function(`${source}\nreturn hljs;`)();
  assert.match(hljs.highlight('def f(): pass', { language: 'py', ignoreIllegals: true }).value, /hljs-keyword/);
  assert.match(hljs.highlight('<!-- x --><script>a</script>', { language: 'xml', ignoreIllegals: true }).value, /hljs-comment/);
  assert.strictEqual(hljs.getLanguage('__proto__'), undefined);
  assert.strictEqual(hljs.getLanguage('constructor'), undefined);
});

test('the page allows blob workers, and previews still do not', () => {
  const policy = /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(template)[1];
  assert.match(policy, /worker-src blob:/);
  assert.ok(!/worker-src|child-src|blob:\s*;?\s*script/.test(Logic.PREVIEW_CSP) && !/script-src[^;]*blob:/.test(Logic.PREVIEW_CSP));
});

test('languageOfFile takes the extension, in lower case', () => {
  assert.strictEqual(Logic.languageOfFile('a/b.PY'), 'py');
  assert.strictEqual(Logic.languageOfFile('page.htm'), 'xml');
  assert.strictEqual(Logic.languageOfFile('archive.tar.gz'), 'gz');
  assert.strictEqual(Logic.languageOfFile('Makefile'), '');
  assert.strictEqual(Logic.languageOfFile(''), '');
  assert.strictEqual(Logic.languageOfFile(null), '');
});

test('protectMath takes math and leaves money and code alone', () => {
  assert.deepStrictEqual(protectMath('costs $5 and $10').math, []);
  assert.deepStrictEqual(protectMath('`$x$` and ```\n$y$\n```').math, []);
  assert.deepStrictEqual(protectMath('so $x^2$ and\n$$y$$').math, ['$x^2$', '$$y$$']);
  assert.deepStrictEqual(protectMath('```\n$a$\n').math, [], 'unclosed fence runs to the end');
  assert.deepStrictEqual(protectMath('~~~\n$a$\n~~~\n$b$').math, ['$b$']);
  assert.deepStrictEqual(protectMath('``$a$`` $b$').math, ['$b$']);
  assert.deepStrictEqual(protectMath('a \\$5 b$').math, [], 'escaped dollar is not an opener');
  assert.deepStrictEqual(protectMath('a ` lone\n\n$b$ ` c').math, ['$b$'], 'a stray backtick is not a span across paragraphs');
  assert.deepStrictEqual(protectMath('$$\na\nb\n$$').math, ['$$\na\nb\n$$']);
});

test('protectMath leaves dollars in web addresses alone', () => {
  assert.deepStrictEqual(protectMath('https://a.test/?a=$x$&b=$y$ and $z$').math, ['$z$']);
  assert.deepStrictEqual(protectMath('[go](https://a.test/$x$/$y$)').math, []);
  assert.deepStrictEqual(protectMath('www.a.test/$x$/$y$').math, []);
  assert.deepStrictEqual(protectMath('awww.test $x$').math, ['$x$']);
});

test('protectMath placeholders split back out by index', () => {
  const p = protectMath('so $x$ and $$y$$');
  assert.ok(!p.text.includes('$'));
  assert.deepStrictEqual(splitPlaceholders(p.text, p.mark).map(x => (typeof x === 'string' ? x : x.kind + x.index)), ['so ', 'M0', ' and ', 'M1']);
});

test('placeholders can never be typed in a chat', () => {
  assert.notStrictEqual(placeholderMark('plain'), placeholderMark(placeholderMark('plain')));
  const typed = `${placeholderMark('')}M0⟧ and $x$`;
  const p = protectMath(typed);
  assert.deepStrictEqual(splitPlaceholders(p.text, p.mark).filter(x => typeof x !== 'string').length, 1);
  assert.ok(p.text.startsWith(typed.slice(0, 8)));
  const old = protectMath('XMATHX0XEND');
  assert.strictEqual(old.text, 'XMATHX0XEND');
  assert.deepStrictEqual(splitPlaceholders(old.text, old.mark), ['XMATHX0XEND']);
});

test('placeholders count as punctuation, so emphasis beside them still closes', () => {
  const m = placeholderMark('');
  assert.ok(/^\p{P}/u.test(m));
  assert.ok(/\p{P}$/u.test(protectMath('$x$').text));
});

const citeIds = (c) => splitPlaceholders(c.text, c.mark).filter(x => typeof x !== 'string').map(x => x.kind + x.index);

test('addCitations marks the text and numbers each source once', () => {
  const c = addCitations('Hello world', [{ end: 5, url: 'https://a.test', title: 'A' }]);
  assert.strictEqual(c.sources[0].n, 1);
  const parts = splitPlaceholders(c.text, c.mark);
  assert.strictEqual(parts[0], 'Hello');
  assert.strictEqual(parts[1].kind, 'C');
  assert.strictEqual(parts[2], ' world');
  const two = addCitations('one two three', [
    { end: 3, url: 'https://a.test', title: 'A' }, { end: 7, url: 'https://b.test', title: 'B' }, { end: 13, url: 'https://a.test', title: 'A' }]);
  assert.deepStrictEqual(two.sources.map(s => s.n), [1, 2]);
  assert.deepStrictEqual(citeIds(two), ['C1', 'C2', 'C1']);
});

test('addCitations puts no chat value into the text, and tolerates a bad offset', () => {
  const c = addCitations('Hi', [{ end: 99, url: 'https://a.test/?a="b"', title: '"><img src=x>' }, { url: 'https://b.test', title: 'B' }]);
  assert.ok(!/img|a\.test/.test(c.text));
  assert.ok(c.text.startsWith('Hi⟦'));
  assert.strictEqual(c.sources[0].title, '"><img src=x>');
  assert.strictEqual(addCitations('Hi', []).text, 'Hi');
  assert.strictEqual(addCitations('Hi').sources.length, 0);
});

test('addCitations continues numbering across blocks of one message', () => {
  const seen = [];
  addCitations('a', [{ end: 1, url: 'https://a.test', title: 'A' }], seen);
  const c = addCitations('b', [{ end: 1, url: 'https://b.test', title: 'B' }, { end: 1, url: 'https://a.test', title: 'A' }], seen);
  assert.deepStrictEqual(c.sources.map(s => s.n), [1, 2]);
  assert.deepStrictEqual(citeIds(c), ['C2', 'C1']);
});

test('beforeCitation ends a bare address at a citation, not at math', () => {
  const c = addCitations('https://a.test/x now', [{ end: 16, url: 'https://b.test', title: 'B' }]);
  assert.strictEqual(beforeCitation(c.text), 'https://a.test/x');
  assert.strictEqual(beforeCitation('https://a.test/⟦T0M0⟧'), 'https://a.test/⟦T0M0⟧');
  assert.strictEqual(beforeCitation('plain'), 'plain');
});

test('toolInputText shows commands bare and everything else as JSON', () => {
  assert.strictEqual(toolInputText('ls'), 'ls');
  assert.strictEqual(toolInputText({ command: 'ls\n-l' }), 'ls\n-l');
  assert.strictEqual(toolInputText({ query: 'x' }), 'x');
  assert.strictEqual(toolInputText({ path: 'a', file_text: 'b' }), '{\n  "path": "a",\n  "file_text": "b"\n}');
  assert.strictEqual(toolInputText({}), '');
  assert.strictEqual(toolInputText(null), '');
});

// ---- generated-file cards ----
const { loadPopup } = require('./helpers');
const popup = loadPopup();
const ctxFor = (data, extra = {}) => {
  const artifactIndex = {};
  const artifacts = popup.fn('extractArtifacts')(data, null, artifactIndex);
  const deliveries = {};
  for (const f of popup.fn('extractDeliveredFiles')(data, Object.keys(artifacts))) {
    if (!deliveries[f.uuid]) deliveries[f.uuid] = { filename: f.filename, path: f.path };
  }
  const plain = {};
  for (const k of Object.keys(artifacts)) plain[k] = artifacts[k];
  return Object.assign({ folder: '', artifacts: plain, artifactIndex, deliveries, heredocs: popup.fn('heredocFiles') }, extra);
};
const cardsOf = (chat, id) => chat.messages.find(m => m.id === id).blocks.filter(b => b.t === 'card');
const fileOf = (chat, card) => chat.files[card.file];
const dataClone = () => JSON.parse(JSON.stringify(fixture));

test('a versioned artifact is one file with one entry per version and cards pointing at the version as of that message', () => {
  const chat = buildViewerChat(fixture, ctxFor(fixture));
  const [c2] = cardsOf(chat, 'm02').filter(c => fileOf(chat, c).name === 'report.html');
  const f = fileOf(chat, c2);
  assert.strictEqual(f.kind, 'html');
  assert.deepStrictEqual(f.versions.map(v => v.label), ['v1', 'v2', 'v3']);
  assert.deepStrictEqual(f.versions.map(v => v.text), ['<p>first draft</p>', '<p>second draft old</p>', '<p>second draft new</p>']);
  assert.deepStrictEqual(f.versions.map(v => v.href), ['artefacts/report_v1.html', 'artefacts/report_v2.html', 'artefacts/report_v3.html']);
  assert.strictEqual(c2.version, 0);
  assert.strictEqual(cardsOf(chat, 'm04').filter(c => c.file === c2.file)[0].version, 1);
  assert.strictEqual(cardsOf(chat, 'm06').filter(c => c.file === c2.file)[0].version, 2);
  assert.strictEqual(Object.values(chat.files).filter(g => g.name === 'report.html').length, 1);
});

test('file ids are a1, a2... in order of first appearance and stable', () => {
  const a = buildViewerChat(fixture, ctxFor(fixture));
  const b = buildViewerChat(fixture, ctxFor(fixture));
  assert.deepStrictEqual(a.files, b.files);
  const order = [];
  for (const m of a.messages) for (const bl of m.blocks) if (bl.t === 'card' && !order.includes(bl.file)) order.push(bl.file);
  assert.deepStrictEqual(order, order.map((_, i) => 'a' + (i + 1)));
  assert.deepStrictEqual(Object.keys(a.files).sort(), order.slice().sort());
});

test('cards follow the block that made them, once per file per message, and tool blocks stay', () => {
  const chat = buildViewerChat(fixture, ctxFor(fixture));
  const m02 = chat.messages.find(m => m.id === 'm02');
  const names = m02.blocks.map(b => b.t === 'card' ? 'card:' + chat.files[b.file].name : b.t === 'tool' ? b.name : b.t);
  // build.py is touched by create_file and then str_replace: one card, after the str_replace.
  assert.deepStrictEqual(names, ['thinking', 'text', 'create_file', 'card:report.html', 'create_file', 'str_replace', 'card:build.py']);
  const m06 = chat.messages.find(m => m.id === 'm06');
  assert.ok(m06.blocks.filter(b => b.t === 'card').length === new Set(m06.blocks.filter(b => b.t === 'card').map(b => b.file)).size);
});

test('a failed tool leaves no card; a failed edit of a file still made earlier does not either', () => {
  const chat = buildViewerChat(fixture, ctxFor(fixture));
  const m04 = chat.messages.find(m => m.id === 'm04');
  const cardFiles = m04.blocks.filter(b => b.t === 'card').map(b => chat.files[b.file].name);
  assert.deepStrictEqual(cardFiles, ['report.html']); // only the bash heredoc; t04 and t06 failed
  const t04Index = m04.blocks.findIndex(b => b.t === 'tool' && b.error);
  assert.notStrictEqual(m04.blocks[t04Index + 1] && m04.blocks[t04Index + 1].t, 'card');
});

test('Bash heredocs get a card per file and Write/Edit versions line up', () => {
  const chat = buildViewerChat(fixture, ctxFor(fixture));
  const m06 = cardsOf(chat, 'm06').map(c => chat.files[c.file].name);
  assert.deepStrictEqual(m06.sort(), ['a.txt', 'b.txt', 'notes.py', 'report.html']);
  const notes = Object.values(chat.files).find(f => f.name === 'notes.py');
  assert.deepStrictEqual(notes.versions.map(v => v.text), ['one one\n', 'two two\n']);
  assert.strictEqual(cardsOf(chat, 'm08').find(c => fileOf(chat, c).name === 'notes.py').version, 1);
  assert.strictEqual(Object.values(chat.files).find(f => f.name === 'build.py').versions.length, 1);
  assert.strictEqual(Object.values(chat.files).find(f => f.name === 'build.py').versions[0].label, '');
});

test('without ctx.heredocs, Bash blocks yield no cards', () => {
  const ctx = ctxFor(fixture);
  delete ctx.heredocs;
  const chat = buildViewerChat(fixture, ctx);
  assert.ok(!Object.values(chat.files).some(f => f.name === 'a.txt'));
});

test('an inactive branch card holds the create_file text; its str_replace is missing', () => {
  const chat = buildViewerChat(fixture, ctxFor(fixture));
  const [c] = cardsOf(chat, 'x01');
  const f = fileOf(chat, c);
  assert.strictEqual(f.name, 'abandoned.py');
  assert.strictEqual(f.kind, 'code');
  assert.strictEqual(f.versions[0].text, 'off branch');
  const data = dataClone();
  data.chat_messages.find(m => m.uuid === 'x01').content.push(
    { type: 'tool_use', id: 't91', name: 'str_replace', input: { path: '/home/claude/other.py', old_str: 'a', new_str: 'b' } });
  const chat2 = buildViewerChat(data, ctxFor(data));
  const missing = cardsOf(chat2, 'x01').map(c => fileOf(chat2, c)).find(g => g.name === 'other.py');
  assert.strictEqual(missing.kind, 'missing');
  assert.strictEqual(missing.versions[0].text, null);
});

test('an inactive branch heredoc shows its body from the tool call', () => {
  const data = dataClone();
  const command = "cat > /home/claude/off.py << 'EOF'\nbody line\nEOF\ncat > /home/claude/blank.py << 'EOF'\n\nEOF";
  data.chat_messages.find(m => m.uuid === 'x01').content.push({ type: 'tool_use', id: 't92', name: 'bash_tool', input: { command } });
  const chat = buildViewerChat(data, ctxFor(data));
  const f = cardsOf(chat, 'x01').map(c => fileOf(chat, c)).find(g => g.name === 'off.py');
  assert.strictEqual(f.kind, 'code');
  assert.strictEqual(f.versions[0].text, 'body line');
  assert.ok(!Object.values(chat.files).some(g => g.name === 'blank.py'), 'an empty heredoc made no artifact');
});

test('an inactive branch SendUserFile delivery is a missing card named from its path', () => {
  const data = dataClone();
  data.chat_messages.find(m => m.uuid === 'x01').content.push(
    { type: 'tool_use', id: 't93', name: 'SendUserFile', input: { files: ['/tmp/out/Off.odt'] } },
    { type: 'tool_result', tool_use_id: 't93', name: 'SendUserFile', content: [], file_deliveries: [{ file_uuid: 'off-uuid', path: '/tmp/out/Off.odt' }] });
  const chat = buildViewerChat(data, ctxFor(data));
  const f = cardsOf(chat, 'x01').map(c => fileOf(chat, c)).find(g => g.name === 'Off.odt');
  assert.strictEqual(f.kind, 'missing');
  assert.deepStrictEqual(f.versions.map(v => [v.text, v.href]), [[null, null]]);
});

test('an active delivery that was not saved is a missing card, not a dead link', () => {
  const ctx = ctxFor(fixture);
  ctx.deliveries = {};
  const chat = buildViewerChat(fixture, ctx);
  const cards = Object.values(chat.files).filter(g => g.name === 'Minutes.odt');
  assert.strictEqual(cards.length, 1);
  assert.strictEqual(cards[0].kind, 'missing');
});

test('viewer-check.gif is a real 1x1 GIF', () => {
  assert.strictEqual(V.VIEWER_CHECK_FILE, 'viewer-check.gif');
  const gif = Buffer.from(V.VIEWER_CHECK_BASE64, 'base64');
  assert.ok(/^GIF8[79]a/.test(gif.toString('latin1', 0, 6)));
  assert.strictEqual(gif.readUInt16LE(6), 1);
  assert.strictEqual(gif.readUInt16LE(8), 1);
});

test('a SendUserFile delivery of a binary links to artefacts and has no text', () => {
  const data = fixture;
  const ctx = ctxFor(data);
  assert.strictEqual(ctx.artifacts['Minutes.odt'], undefined);
  ctx.artifacts['Minutes.odt'] = '';
  ctx.artifacts['Minutes_v1.odt'] = '';
  const chat = buildViewerChat(data, ctx);
  const cards = cardsOf(chat, 'm08').map(c => ({ c, f: fileOf(chat, c) })).filter(x => /^Minutes/.test(x.f.name));
  assert.ok(cards.length >= 1);
  const f = cards[0].f;
  assert.strictEqual(f.kind, 'binary');
  assert.strictEqual(f.name, 'Minutes.odt');
  assert.deepStrictEqual(f.versions.map(v => v.label), ['v1', 'v2']);
  assert.deepStrictEqual(f.versions.map(v => v.href), ['artefacts/Minutes_v1.odt', 'artefacts/Minutes_v2.odt']);
  assert.ok(Object.values(chat.files).some(x => x.name === 'report_delivered.html'));
  assert.ok(f.versions.every(v => v.text === null && /^artefacts\/Minutes/.test(v.href)));
  const ctxFolder = ctxFor(data, { folder: 'A B' });
  ctxFolder.artifacts['Minutes.odt'] = '';
  ctxFolder.artifacts['Minutes_v1.odt'] = '';
  const chat2 = buildViewerChat(data, ctxFolder);
  const g = Object.values(chat2.files).find(x => /^Minutes/.test(x.name));
  assert.ok(g.versions.every(v => v.href.startsWith('A%20B/artefacts/Minutes')));
});

test('present_files resolves through the index, then by basename in ctx.artifacts', () => {
  const data = {
    uuid: 'c', name: 'n', current_leaf_message_uuid: 'b',
    chat_messages: [
      { uuid: 'a', parent_message_uuid: null, sender: 'assistant', content: [
        { type: 'tool_use', id: 'u1', name: 'create_file', input: { path: '/out/p.html', file_text: '<b>x</b>' } },
        { type: 'tool_result', tool_use_id: 'u1', content: [] }] },
      { uuid: 'b', parent_message_uuid: 'a', sender: 'assistant', content: [
        { type: 'tool_use', id: 'u2', name: 'present_files', input: { filepaths: ['/out/p.html', '/elsewhere/pic.png', '/nowhere/gone.bin'] } },
        { type: 'tool_result', tool_use_id: 'u2', content: [] }] }
    ]
  };
  const ctx = ctxFor(data);
  ctx.artifacts['pic.png'] = '';
  const chat = buildViewerChat(data, ctx);
  const cards = cardsOf(chat, 'b').map(c => ({ c, f: fileOf(chat, c) }));
  assert.deepStrictEqual(cards.map(x => x.f.name), ['p.html', 'pic.png', 'gone.bin']);
  assert.deepStrictEqual(cards.map(x => x.f.kind), ['html', 'image', 'missing']);
  assert.strictEqual(cards[0].f.versions[0].text, '<b>x</b>');
  assert.strictEqual(cards[1].f.versions[0].href, 'artefacts/pic.png');
  assert.strictEqual(cards[1].f.versions[0].text, null);
});

test('kind comes from the extension and the artifacts type', () => {
  const mk = (name, input) => ({
    uuid: 'c', name: 'n', current_leaf_message_uuid: 'a',
    chat_messages: [{ uuid: 'a', parent_message_uuid: null, sender: 'assistant', content: [{ type: 'tool_use', id: 'u', name, input }] }]
  });
  const kindOf = (data) => { const chat = buildViewerChat(data, ctxFor(data)); return Object.values(chat.files).map(f => f.kind); };
  const cf = (p, t = 'x') => mk('create_file', { path: p, file_text: t });
  assert.deepStrictEqual(kindOf(cf('/a/b.svg')), ['svg']);
  assert.deepStrictEqual(kindOf(cf('/a/b.md')), ['md']);
  assert.deepStrictEqual(kindOf(cf('/a/b.htm')), ['html']);
  assert.deepStrictEqual(kindOf(cf('/a/b.jsx')), ['react']);
  assert.deepStrictEqual(kindOf(cf('/a/b.mmd')), ['mermaid']);
  assert.deepStrictEqual(kindOf(cf('/a/b.pdf')), ['pdf']);
  assert.deepStrictEqual(kindOf(cf('/a/b.JPG')), ['image']);
  assert.deepStrictEqual(kindOf(mk('artifacts', { command: 'create', id: 'r', title: 'App', type: 'application/vnd.ant.react', content: 'x' })), ['react']);
  assert.deepStrictEqual(kindOf(mk('artifacts', { command: 'create', id: 'm', title: 'Flow', type: 'application/vnd.ant.mermaid', content: 'x' })), ['mermaid']);
});

// Side panel: what a generated file may load, and how it opens.
const { inlineSiblings, remoteScripts, previewDoc, PREVIEW_CSP, resolveFile, fileViews, fileKindLabel, openableHref, OPENABLE_EXTENSIONS } = require('../viewer/viewer-logic.js');

const look = n => ({ 'app.js': 'run("</script>")', 'a.css': 'b{}', 'mod.js': 'go()', 'dollar.js': "x='$& $1 $`'", 'dollar.css': 'a{content:"$&"}' })[n] ?? null;

test('PREVIEW_CSP is the agreed policy', () => {
  assert.strictEqual(PREVIEW_CSP, "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; base-uri 'none'; form-action 'none'");
});

test('inlineSiblings feeds in ./name and name, and escapes closing tags', () => {
  assert.ok(inlineSiblings('<script src="./app.js"></script>', look).includes('run("<\\/script>")'));
  assert.ok(inlineSiblings('<link rel="stylesheet" href="a.css">', look).includes('<style>b{}</style>'));
  assert.strictEqual(inlineSiblings('<script src="app.js"></script>', n => n === 'app.js' ? 'a</SCRIPT>b</style>' : null), '<script>a<\\/SCRIPT>b</style></script>');
  assert.strictEqual(inlineSiblings('<link rel=stylesheet href=a.css>', n => n === 'a.css' ? 'a</STYLE>b</script>' : null), '<style>a<\\/STYLE>b</script></style>');
  assert.strictEqual(inlineSiblings('<script src="app.js"></script>', () => 'x="<!--<script>"'), '<script>x="<\\!--<script>"</script>');
});

test('inlineSiblings handles attribute order and quote styles', () => {
  assert.strictEqual(inlineSiblings('<script type="module" src=mod.js></script>', look), '<script type="module">go()</script>');
  assert.strictEqual(inlineSiblings("<script src='./mod.js' defer></script>", look), '<script defer>go()</script>');
  assert.strictEqual(inlineSiblings('<SCRIPT SRC="mod.js"></SCRIPT>', look), '<script>go()</script>');
  assert.strictEqual(inlineSiblings('<script data-src="mod.js" src="mod.js"></script>', look), '<script data-src="mod.js">go()</script>');
  assert.strictEqual(inlineSiblings('<link href="a.css" rel="stylesheet">', look), '<style>b{}</style>');
  assert.strictEqual(inlineSiblings("<link href='./a.css' rel='stylesheet' />", look), '<style>b{}</style>');
  assert.strictEqual(inlineSiblings('<link media="print" rel="stylesheet" href="a.css">', look), '<style media="print">b{}</style>');
  assert.strictEqual(inlineSiblings('<script src="\n mod.js "></script>', look), '<script>go()</script>');
});

test('inlineSiblings keeps a space before the next attribute', () => {
  assert.strictEqual(inlineSiblings('<script src="mod.js"type="module"></script>', look), '<script type="module">go()</script>');
  assert.strictEqual(inlineSiblings('<link rel="stylesheet" href="a.css"media="print">', look), '<style media="print">b{}</style>');
  assert.strictEqual(inlineSiblings('<script src="mod.js"/data-x=1></script>', look), '<script data-x=1>go()</script>');
});

test('inlineSiblings moves a deferred or async script to the end, since inline defer does nothing', () => {
  assert.strictEqual(inlineSiblings('<head><script defer src="mod.js"></script></head><body>x</body>', look), '<head></head><body>x</body><script defer>go()</script>');
  assert.strictEqual(inlineSiblings('<script async src="mod.js"></script><p>x</p>', look), '<p>x</p><script async>go()</script>');
  // Modules are deferred already; a plain script stays where it was.
  assert.strictEqual(inlineSiblings('<script type="module" defer src="mod.js"></script>', look), '<script type="module" defer>go()</script>');
  assert.strictEqual(inlineSiblings('<script src="mod.js"></script><p>x</p>', look), '<script>go()</script><p>x</p>');
});

test('inlineSiblings leaves everything but a plain sibling name alone', () => {
  const names = ['https://x.test/app.js', 'http://x.test/app.js', '//x.test/app.js', '/app.js', '../app.js', './../app.js', 'sub/app.js', 'a/../app.js', 'data:text/javascript,1', 'javascript:app.js', 'file:///app.js', '\\\\x.test\\app.js', '..', '.', ''];
  const all = () => 'SHOULD NOT APPEAR';
  for (const n of names) {
    assert.strictEqual(inlineSiblings(`<script src="${n}"></script>`, all), `<script src="${n}"></script>`, n);
    assert.strictEqual(inlineSiblings(`<link rel="stylesheet" href="${n}">`, all), `<link rel="stylesheet" href="${n}">`, n);
  }
  assert.strictEqual(inlineSiblings('<script src="gone.js"></script>', look), '<script src="gone.js"></script>');
  assert.strictEqual(inlineSiblings('<link rel="icon" href="a.css">', look), '<link rel="icon" href="a.css">');
  assert.strictEqual(inlineSiblings('<link rel="preload" href="a.css"><link href="a.css">', look), '<link rel="preload" href="a.css"><link href="a.css">');
});

test('inlineSiblings only feeds in scripts and stylesheets', () => {
  const any = () => 'SHOULD NOT APPEAR';
  for (const html of [
    '<link rel=stylesheet href=notes.txt>',
    '<script type=text/plain src=other.html></script>',
    '<script src="notes.txt"></script>',
    '<script src="data.json"></script>',
    '<script src="app"></script>',
    '<script src="app.js.txt"></script>',
    '<script src="a.css"></script>',
    '<link rel="stylesheet" href="other.html">',
    '<link rel="stylesheet" href="app.js">',
    '<link rel="stylesheet" href="a.css.md">',
    '<link rel="stylesheet" href="css">',
  ]) assert.strictEqual(inlineSiblings(html, any), html);
  const asked = [];
  inlineSiblings('<link rel=stylesheet href=notes.txt><script src=other.html></script>', n => { asked.push(n); return null; });
  assert.deepStrictEqual(asked, []);
  assert.strictEqual(inlineSiblings('<script src="a.mjs"></script><script src="B.JS"></script><link rel="stylesheet" href="C.CSS">', () => 'x'), '<script>x</script><script>x</script><style>x</style>');
});

test('inlineSiblings only touches real tags', () => {
  for (const html of [
    '<!-- <script src="app.js"></script> -->',
    '<script>var s = \'<script src="app.js"><\\/script>\';</script>',
    '<style>/* <link rel="stylesheet" href="a.css"> */</style>',
    '<textarea><script src="app.js"></script></textarea>',
    '<title><link rel="stylesheet" href="a.css"></title>',
    '<script src="app.js">',
    '<!-- never closed <script src="app.js"></script>',
    '<script src="app.js',
    '<img alt=\'<script src="app.js"></script>\'>',
    '<iframe srcdoc="<link rel=stylesheet href=a.css>"></iframe>',
  ]) assert.strictEqual(inlineSiblings(html, look), html);
});

test('inlineSiblings keeps $ patterns in sibling text', () => {
  assert.strictEqual(inlineSiblings('<script src="dollar.js"></script>', look), "<script>x='$& $1 $`'</script>");
  assert.strictEqual(inlineSiblings('<link rel="stylesheet" href="dollar.css">', look), '<style>a{content:"$&"}</style>');
});

test('inlineSiblings stays quick on unfinished tags', () => {
  const t = Date.now();
  inlineSiblings('<script a="'.repeat(200000), look);
  inlineSiblings('<script>'.repeat(200000), look);
  inlineSiblings('<!--'.repeat(200000), look);
  inlineSiblings('<link '.repeat(200000), look);
  assert.ok(Date.now() - t < 1000, `${Date.now() - t}ms`);
});

test('remoteScripts counts scripts from the network only', () => {
  assert.strictEqual(remoteScripts('<script src="https://x.test/a.js"></script><script src="b.js"></script>'), 1);
  assert.strictEqual(remoteScripts('<script src=http://x.test/a.js></script><script src="//x.test/b.js"></script><SCRIPT SRC=\'HTTPS://x.test/c.js\'></SCRIPT>'), 3);
  assert.strictEqual(remoteScripts('<!-- <script src="https://x.test/a.js"></script> --><script>"<script src=https://x.test/a.js>"</script>'), 0);
  assert.strictEqual(remoteScripts('<img alt=\'<script src="https://x.test/a.js"></script>\'>'), 0);
  assert.strictEqual(remoteScripts('<link rel="stylesheet" href="https://x.test/a.css"><img src="https://x.test/a.png">'), 0);
  assert.strictEqual(remoteScripts('<script src=" https://x.test/a.js"></script><script src="\\\\x.test/b.js"></script>'), 2);
});

test('previewDoc leads with the policy', () => {
  const head = `<!doctype html><meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`;
  // The policy leads the document, so a comment holding "<head>" can't push it out of force
  const d = previewDoc('<!doctype html><!-- <head> --><html><head></head>x', () => null);
  assert.ok(d.srcdoc.startsWith(head));
  assert.strictEqual(d.srcdoc, `${head}<!-- <head> --><html><head></head>x`);
  assert.strictEqual(d.remote, 0);
  assert.strictEqual(previewDoc('﻿\n <!DOCTYPE HTML PUBLIC "x">a', () => null).srcdoc, `${head}a`);
  assert.strictEqual(previewDoc('<svg></svg>', () => null).srcdoc, `${head}<svg></svg>`);
  assert.strictEqual(previewDoc('<!doctype html><!doctype html>a', () => null).srcdoc, `${head}<!doctype html>a`);
  const r = previewDoc('<script src="https://x.test/a.js"></script><script src="app.js"></script>', look);
  assert.strictEqual(r.remote, 1);
  assert.ok(r.srcdoc.includes('run("<\\/script>")'));
});

test('resolveFile finds real ids only, and settles the version', () => {
  const files = { a1: { versions: [{}, {}, {}] }, a2: { versions: [{}] } };
  assert.deepStrictEqual(resolveFile(files, 'a1', 1), { file: 'a1', version: 1 });
  assert.deepStrictEqual(resolveFile(files, 'a1', null), { file: 'a1', version: 2 });
  assert.deepStrictEqual(resolveFile(files, 'a1', 9), { file: 'a1', version: 2 });
  assert.deepStrictEqual(resolveFile(files, 'a1', -1), { file: 'a1', version: 2 });
  for (const id of ['nope', '__proto__', 'constructor', 'toString', null]) assert.strictEqual(resolveFile(files, id, 0), null);
  assert.strictEqual(resolveFile(undefined, 'a1', 0), null);
  assert.strictEqual(resolveFile({ a1: { versions: [] } }, 'a1', 0), null);
});

test('fileViews picks what each kind can show', () => {
  const v = (text, href) => ({ label: '', text, href });
  const views = (kind, ver) => fileViews(kind, ver).views.join();
  assert.strictEqual(views('html', v('x', 'a.html')), 'preview,code');
  assert.strictEqual(views('svg', v('x', null)), 'preview,code');
  assert.strictEqual(views('md', v('x', 'a.md')), 'preview,code');
  assert.strictEqual(views('code', v('x', 'a.py')), 'code');
  assert.strictEqual(views('react', v('x', 'a.jsx')), 'code');
  assert.strictEqual(views('mermaid', v('x', 'a.mmd')), 'code');
  assert.strictEqual(views('image', v(null, 'a.png')), 'preview');
  assert.strictEqual(views('image', v('x', null)), 'code');
  assert.strictEqual(views('pdf', v(null, 'a.pdf')), 'preview');
  assert.strictEqual(views('pdf', v(null, 'a.html')), '');
  assert.strictEqual(views('binary', v(null, 'a.zip')), '');
  assert.strictEqual(views('html', v(null, 'a.html')), '');
  assert.strictEqual(fileViews('react', v('x', null)).note, "This file type can't preview offline. Code view shows the full source.");
  assert.strictEqual(fileViews('mermaid', v('x', null)).note, "This file type can't preview offline. Code view shows the full source.");
  assert.strictEqual(fileViews('code', v('x', null)).note, '');
  assert.strictEqual(fileViews('missing', v(null, null)).missing, true);
  assert.strictEqual(fileViews('html', v(null, null)).missing, true);
  assert.strictEqual(fileViews('html', v('x', null)).missing, false);
});

test('fileKindLabel reads like the card in the mockup', () => {
  assert.strictEqual(fileKindLabel({ name: 'a.html', kind: 'html' }), 'Document · HTML');
  assert.strictEqual(fileKindLabel({ name: 'a.py', kind: 'code' }), 'Code · PY');
  assert.strictEqual(fileKindLabel({ name: 'Chart', kind: 'react' }), 'Component');
  assert.strictEqual(fileKindLabel({ name: 'a.mmd', kind: 'mermaid' }), 'Diagram · MMD');
  assert.strictEqual(fileKindLabel({ name: 'a.png', kind: 'missing' }), 'Not in this export');
});

test('openableHref offers exactly the allowlisted types', () => {
  const allowed = 'pdf doc docx xls xlsx ppt pptx odt ods odp rtf pages numbers key epub zip gz tar 7z rar csv tsv txt log md markdown json png jpg jpeg gif webp heic tif tiff bmp mp3 m4a wav ogg flac aac mp4 mov webm m4v mkv avi'.split(' ');
  assert.deepStrictEqual([...OPENABLE_EXTENSIONS].sort(), [...allowed].sort());
  for (const ext of allowed) {
    assert.strictEqual(openableHref(`dir/a.${ext}`), true, ext);
    assert.strictEqual(openableHref(`dir/a.${ext.toUpperCase()}`), true, ext);
  }
});

test('openableHref refuses any type not on the list', () => {
  for (const h of ['evil.xbl', 'a.xbl', 'a.py', 'a.js', 'a.css', 'a.bin', 'a.exe', 'a.app', 'a.webloc', 'a.xsd', 'a.wsdl', 'a.pdfx', 'a.mdx', 'a.pdf1', 'a.toString', 'a.constructor', 'a.__proto__']) {
    assert.strictEqual(openableHref(h), false, h);
  }
});

test('openableHref goes by the file a link really opens, not a query or fragment', () => {
  for (const h of ['a.html?x.pdf', 'a.html#x.pdf', 'a.xbl?.txt', 'a.xbl#.txt', 'a.pdf?x', 'a.pdf#x', 'a.html?a=b/c.pdf', 'a.html#/c.pdf', 'a.html\\c.pdf']) {
    assert.strictEqual(openableHref(h), false, h);
  }
  assert.strictEqual(openableHref('a.html%3Fx.pdf'), true, 'an encoded ? is part of the name, and that name ends .pdf');
  assert.strictEqual(openableHref('a.pdf%3Fx'), false);
  assert.strictEqual(openableHref('a.pdf%23x'), false);
});

test('openableHref only follows relative links', () => {
  for (const h of ['javascript:x.pdf', 'file:///etc/a.pdf', 'https://a.test/a.pdf', 'data:text/html,x.pdf']) assert.strictEqual(openableHref(h), false, h);
});

test('openableHref never offers something a browser would run as a page', () => {
  for (const h of ['artefacts/a.html', 'a.htm', 'a.HTML', 'a.svg', 'a.xhtml', 'a.xht', 'a.shtml', 'a.xml', 'a.xsl', 'a.mhtml', 'a.mht', 'a.svgz', 'noextension', 'a.html%20', 'a.html.', 'a.html%00', '', null]) {
    assert.strictEqual(openableHref(h), false, String(h));
  }
  for (const h of ['artefacts/a.zip', 'a.pdf', 'a.tar.gz', 'dir.html/a.zip']) assert.strictEqual(openableHref(h), true, h);
});

// Uploads, attachments and project files.
function uploadChat(files, filesV2) {
  const c = JSON.parse(JSON.stringify(fixture));
  const m = c.chat_messages.find(x => x.uuid === 'm01');
  m.files = files;
  m.files_v2 = filesV2;
  return { c, of: chat => chat.messages.find(x => x.id === 'm01') };
}

test('TEXT_EMBED_LIMIT is 2 MB', () => {
  assert.strictEqual(V.TEXT_EMBED_LIMIT, 2 * 1024 * 1024);
});

test('uploads from files and files_v2 land on their message, once per key', () => {
  const { c, of } = uploadChat(
    [{ file_uuid: 'u1', file_name: 'a.png' }, { path: '/mnt/user-data/uploads/old one.txt' }],
    [{ file_uuid: 'u1', file_name: 'a.png' }, { file_uuid: 'u2', file_name: 'b.pdf' }, { file_uuid: 'u3', file_name: 'gone.pdf' }]);
  const ctx = { folder: 'A B', uploads: { u1: { path: 'uploads/p01_a.png', text: null }, u2: { path: 'uploads/p01_b.pdf', text: null }, 'old one.txt': { path: 'uploads/p01_old one.txt', text: 'hi' } } };
  const chat = buildViewerChat(c, ctx);
  assert.deepStrictEqual(of(chat).uploads, [
    { name: 'a.png', href: 'A%20B/uploads/p01_a.png', text: null },
    { name: 'old one.txt', href: 'A%20B/uploads/p01_old%20one.txt', text: 'hi' },
    { name: 'b.pdf', href: 'A%20B/uploads/p01_b.pdf', text: null },
    { name: 'gone.pdf', href: null, text: null },
  ]);
});

test('without ctx.uploads every upload is not in the export', () => {
  const { c, of } = uploadChat([], [{ file_uuid: 'u1', file_name: 'a.png' }]);
  assert.deepStrictEqual(of(buildViewerChat(c, {})).uploads, [{ name: 'a.png', href: null, text: null }]);
});

test('attachments pass their text through fixText', () => {
  const chat = buildViewerChat(fixture, { fixText: s => s + '!' });
  assert.deepStrictEqual(chat.messages.find(x => x.id === 'm03').attachments, [{ name: 'notes.txt', text: 'pasted notes!' }]);
});

test('project files link under the chat folder or the shared projects folder', () => {
  const docs = [{ name: 'Brief', text: 'Be kind' }];
  const own = buildViewerChat(fixture, { folder: '', project: { name: 'P', fileDir: 'project/files', fileNames: ['x.pdf', 'a b.txt'], docs, instructions: 'Rules' } }).project;
  assert.deepStrictEqual(own, { name: 'P', instructions: 'Rules', files: [{ name: 'x.pdf', href: 'project/files/x.pdf' }, { name: 'a b.txt', href: 'project/files/a%20b.txt' }], docs });
  const shared = buildViewerChat(fixture, { folder: 'A', project: { name: 'P', fileDir: '../projects/P/files', fileNames: ['x.pdf'], docs: [] } }).project;
  assert.deepStrictEqual(shared.files, [{ name: 'x.pdf', href: 'projects/P/files/x.pdf' }]);
  assert.strictEqual(shared.instructions, '');
  assert.strictEqual(buildViewerChat(fixture, {}).project, null);
});

const T = (id, parent, sender, text, extra = {}) => ({ id, parent, sender, at: '2026-01-01T00:00:0' + id.slice(-1) + 'Z', blocks: [{ t: 'text', text, cites: [] }], uploads: [], attachments: [], ...extra });
const searchable = [
  { id: 'c1', title: 'Alpha plans', project: { name: 'Alpha', files: [], docs: [] }, messages: [T('m1', null, 'human', 'hello'), T('m2', 'm1', 'assistant', 'old branch'), T('m3', 'm1', 'assistant', 'A Zebra crossed the road', { attachments: [{ name: 'notes.txt', text: 'pasted stripes' }], uploads: [{ name: 'photo.png', href: null, text: null }] })] },
  { id: 'c2', title: 'Plain', project: null, messages: [T('n1', null, 'human', 'x')] },
  { id: 'c3', title: 'Beta zebra notes', project: { name: 'Beta', files: [], docs: [] }, messages: [] },
  { id: 'c4', title: 'Other', project: { name: 'Alpha', files: [], docs: [] }, messages: [] },
];

test('search finds text case-insensitively, on every branch, and titles', () => {
  const idx = buildSearchIndex(searchable);
  assert.deepStrictEqual(searchChats(idx, 'ZEBRA').map(h => [h.chat, h.msg]), [['c1', 'm3'], ['c3', null]]);
  assert.deepStrictEqual(searchChats(idx, 'old branch').map(h => h.msg), ['m2']);
  assert.deepStrictEqual(searchChats(idx, 'stripes').map(h => h.msg), ['m3']);
  assert.deepStrictEqual(searchChats(idx, 'notes.txt').map(h => h.msg), ['m3']);
  assert.deepStrictEqual(searchChats(idx, 'PHOTO.png').map(h => h.msg), ['m3']);
  assert.ok(searchChats(idx, '  zebra ')[0].snippet.includes('Zebra'));
});

test('search edge cases: blank, long, limit, odd lowercasing', () => {
  const idx = buildSearchIndex(searchable);
  assert.deepStrictEqual(searchChats(idx, '   '), []);
  assert.deepStrictEqual(searchChats(idx, ''), []);
  assert.strictEqual(searchChats(idx, 'x'.repeat(5000)).length, 0);
  assert.strictEqual(searchChats(idx, 'a', 2).length, 2);
  const odd = buildSearchIndex([{ id: 'o', title: 'T', project: null, messages: [T('o1', null, 'human', '\u0130'.repeat(100) + ' needle ' + 'x'.repeat(100))] }]);
  const hit = searchChats(odd, 'needle')[0];
  assert.ok(hit.snippet.includes('needle'));
  assert.ok(hit.snippet.length <= 90);
  assert.ok(searchChats(odd, 'needle x')[0].snippet.includes('needle x'));
  assert.ok(searchChats(buildSearchIndex([{ id: 'e', title: 'Hi', project: null, messages: [T('e1', null, 'human', 'a'.repeat(300) + 'Z')] }]), 'z')[0].snippet.startsWith('\u2026'));
});

test('snippets are about 80 characters with ellipses where cut', () => {
  const text = 'a'.repeat(200) + 'MATCH' + 'b'.repeat(200);
  const hit = searchChats(buildSearchIndex([{ id: 'l', title: 'L', project: null, messages: [T('l1', null, 'human', text)] }]), 'match')[0];
  assert.ok(hit.snippet.startsWith('\u2026') && hit.snippet.endsWith('\u2026') && hit.snippet.includes('MATCH'));
  assert.ok(hit.snippet.length <= 84);
});

test('groupChats puts project chats under their project only, by name', () => {
  const g = groupChats(searchable);
  assert.deepStrictEqual(g.recents.map(c => c.id), ['c2']);
  assert.deepStrictEqual(g.projects.map(p => [p.name, p.chats.map(c => c.id)]), [['Alpha', ['c1', 'c4']], ['Beta', ['c3']]]);
  assert.deepStrictEqual(groupChats([]), { recents: [], projects: [] });
});

test('modelLabel names a model by family and version, whatever the id style', () => {
  const cases = { 'claude-opus-4-8': 'Opus 4.8', 'claude-opus-5': 'Opus 5', 'claude-opus-5-5': 'Opus 5.5', 'claude-sonnet-4-20250514': 'Sonnet 4', 'claude-sonnet-4-5-20250929': 'Sonnet 4.5', 'claude-3-5-sonnet-20241022': 'Sonnet 3.5', 'claude-haiku-5-5': 'Haiku 5.5', 'CLAUDE-OPUS-4-8': 'Opus 4.8' };
  for (const [id, label] of Object.entries(cases)) assert.strictEqual(V.modelLabel(id, 'FB'), label, id);
  for (const id of ['claude-x', '', null, undefined, 'gpt-5', 'claude-opus']) assert.strictEqual(V.modelLabel(id, 'FB'), 'FB', String(id));
});

test('odd shapes drop the odd item, never the chat', () => {
  const odd = JSON.parse(JSON.stringify(fixture));
  const base = buildViewerChat(odd, { folder: '' }).messages.length;
  odd.chat_messages.push(null);
  odd.chat_messages[1].attachments = { not: 'an array' };
  odd.chat_messages[2].attachments = [null, { file_name: 'a.txt', extracted_content: 'x' }];
  odd.chat_messages[1].files = 'oops';
  odd.chat_messages[2].files_v2 = { x: 1 };
  odd.chat_messages[3].content = [{ type: 'thinking', thinking: 'hm', summaries: [null] }, ...odd.chat_messages[3].content];
  const chat = buildViewerChat(odd, { folder: '', project: { name: 'P', fileDir: 'f', fileNames: ['a'], docs: [null, { name: 'd', text: 't' }] } });
  assert.strictEqual(chat.messages.length, base);
  assert.deepStrictEqual(chat.messages[2].attachments, [{ name: 'a.txt', text: 'x' }]);
  assert.deepStrictEqual(chat.messages[1].attachments, []);
  assert.deepStrictEqual(chat.project.docs, [{ name: 'd', text: 't' }]);
  assert.ok(chat.messages[3].blocks.some(b => b.t === 'thinking'));
});

test('copyText: a prompt is copied as typed', () => {
  assert.strictEqual(copyText({ sender: 'human', blocks: [{ t: 'text', text: '  two\n\n  lines  ' }] }), '  two\n\n  lines  ');
});

test('copyText: a response is the raw text of its text blocks, joined by a blank line', () => {
  const m = { sender: 'assistant', blocks: [
    { t: 'thinking', text: 'secret', summary: 's' },
    { t: 'text', text: 'Hello **bold** [1]', cites: [{ end: 5, url: 'https://x.test', title: 'X' }] },
    { t: 'tool', name: 'bash', label: 'Ran', input: 'ls', result: 'out', error: false, images: [] },
    { t: 'card', file: 'f1', version: 0 },
    { t: 'text', text: '| a | b |\n|---|---|\n| 1 | 2 |', cites: [] },
  ] };
  assert.strictEqual(copyText(m), 'Hello **bold** [1]\n\n| a | b |\n|---|---|\n| 1 | 2 |');
});

test('copyText: nothing to copy gives an empty string', () => {
  assert.strictEqual(copyText({ sender: 'assistant', blocks: [{ t: 'tool', name: 'x', label: 'x', input: '', result: '', error: false, images: [] }] }), '');
  assert.strictEqual(copyText({ sender: 'human', blocks: [{ t: 'text', text: '' }] }), '');
  assert.strictEqual(copyText({ sender: 'human' }), '');
});

test('copyText: hostile text stays literal', () => {
  const text = '<script>window.__hit=1</script><img src=x onerror=alert(1)>';
  assert.strictEqual(copyText({ sender: 'assistant', blocks: [{ t: 'text', text }] }), text);
});

test('splitFences turns only closed fences into code', () => {
  const { splitFences } = require('../viewer/viewer-logic.js');
  assert.deepStrictEqual(splitFences('plain *text*'), [{ t: 'text', text: 'plain *text*' }]);
  assert.deepStrictEqual(splitFences('see:\n\n```js\nlet a = 1;\n\nlet b;\n```\nafter'), [
    { t: 'text', text: 'see:\n' }, { t: 'code', lang: 'js', text: 'let a = 1;\n\nlet b;' }, { t: 'text', text: 'after' }]);
  assert.deepStrictEqual(splitFences('```\nno language\n```'), [{ t: 'code', lang: '', text: 'no language' }]);
  assert.deepStrictEqual(splitFences('````\n```\ninner\n```\n````'), [{ t: 'code', lang: '', text: '```\ninner\n```' }]);
  assert.deepStrictEqual(splitFences('~~~\nx\n~~~'), [{ t: 'code', lang: '', text: 'x' }]);
  assert.deepStrictEqual(splitFences('never closed\n```\nstill typed'), [{ t: 'text', text: 'never closed\n```\nstill typed' }]);
  assert.deepStrictEqual(splitFences('inline ```code``` stays'), [{ t: 'text', text: 'inline ```code``` stays' }]);
  assert.deepStrictEqual(splitFences('\n\nhi\n\n\n'), [{ t: 'text', text: '\n\nhi\n\n\n' }]);
  assert.deepStrictEqual(splitFences('a\n\n\n```\nx\n```\n\n\nb'), [{ t: 'text', text: 'a\n\n' }, { t: 'code', lang: '', text: 'x' }, { t: 'text', text: '\n\nb' }]);
  assert.deepStrictEqual(splitFences('```\r\nx\r\n```\r\n'), [{ t: 'code', lang: '', text: 'x' }]);
  const started = Date.now();
  assert.strictEqual(splitFences('```js\n'.repeat(40000)).length, 1);
  assert.ok(Date.now() - started < 500, 'many unclosed fences stay fast');
  assert.deepStrictEqual(splitFences('```\n<script>x</script>\n```'), [{ t: 'code', lang: '', text: '<script>x</script>' }]);
});

test('thinking keeps every summary when the text is hidden', () => {
  const { buildViewerChat } = require('../takeout-viewer.js');
  const data = { uuid: 'c', current_leaf_message_uuid: 'a', chat_messages: [{ uuid: 'a', parent_message_uuid: null, sender: 'assistant', content: [
    { type: 'thinking', thinking: '', thinking_hidden: true, summaries: [{ summary: ' First step. ' }, null, { summary: 'Second step.' }] },
    { type: 'thinking', thinking: '', thinking_hidden: true },
  ] }] };
  const [one, two] = buildViewerChat(data, {}).messages[0].blocks;
  assert.deepStrictEqual(one.summaries, ['First step.', 'Second step.']);
  assert.strictEqual(one.text, '');
  assert.deepStrictEqual(two.summaries, []);
});

// ---- Archive files ----

const { addedTree, filterAdded, addedForChat, addedFile, isAddedId } = require('../viewer/viewer-logic.js');
const addedEntry = (path, chat = null, extra = {}) => ({ path, chat, kind: 'md', size: 1, href: path, part: 1, key: path, ...extra });
const treeNames = node => ({ name: node.name, files: node.files.map(f => f.path), folders: node.folders.map(treeNames) });

test('addedTree nests folders and sorts folders and files by name', () => {
  const added = ['b/z.md', 'b/a.md', 'a/deep/er/x.md', 'a/f10.md', 'a/f2.md', 'root.md'].map(p => addedEntry(p));
  assert.deepStrictEqual(addedTree(added, 'c1').map(treeNames), [{
    name: '',
    files: ['root.md'],
    folders: [
      { name: 'a', files: ['a/f2.md', 'a/f10.md'], folders: [{ name: 'deep', files: [], folders: [{ name: 'er', files: ['a/deep/er/x.md'], folders: [] }] }] },
      { name: 'b', files: ['b/a.md', 'b/z.md'], folders: [] },
    ],
  }]);
});

test('addedTree hands back the Added entries themselves', () => {
  const entry = addedEntry('a/b.md');
  assert.strictEqual(addedTree([entry], 'c1')[0].folders[0].files[0], entry);
});

test('addedTree: a mega root file shows with every chat, a chat file only with its own', () => {
  const added = [addedEntry('_index.md'), addedEntry('one/a.md', 'c1'), addedEntry('two/b.md', 'c2')];
  const paths = id => { const out = []; const walk = n => { out.push(...n.files.map(f => f.path)); n.folders.forEach(walk); }; addedTree(added, id).forEach(walk); return out; };
  assert.deepStrictEqual(paths('c1'), ['_index.md', 'one/a.md']);
  assert.deepStrictEqual(paths('c2'), ['_index.md', 'two/b.md']);
  assert.deepStrictEqual(paths('c3'), ['_index.md']);
  assert.deepStrictEqual(addedForChat(added, 'c2').map(a => a.path), ['_index.md', 'two/b.md']);
});

test('addedTree has nothing to show for an empty view', () => {
  assert.deepStrictEqual(addedTree([], 'c1'), []);
  assert.deepStrictEqual(addedTree([addedEntry('a.md', 'c2')], 'c1'), []);
  assert.deepStrictEqual(addedTree(undefined, 'c1'), []);
});

test('addedTree keeps folders with prototype-like names as folders', () => {
  const [root] = addedTree([addedEntry('__proto__/a.md'), addedEntry('constructor/toString/b.md')], 'c1');
  assert.deepStrictEqual(root.folders.map(f => f.name), ['__proto__', 'constructor']);
  assert.strictEqual(root.folders[0].files[0].path, '__proto__/a.md');
});

test('filterAdded matches the file name, ignoring case', () => {
  const added = ['synthesis/Alpha.md', 'alphabet/beta.md', 'x/ALPHA.txt'].map(p => addedEntry(p));
  assert.deepStrictEqual(filterAdded(added, 'alpha').map(a => a.path), ['synthesis/Alpha.md', 'x/ALPHA.txt']);
  assert.deepStrictEqual(filterAdded(added, '  ALPHA ').length, 2);
  assert.deepStrictEqual(filterAdded(added, 'gamma'), []);
});

test('filterAdded takes the query as plain text, not a pattern', () => {
  const added = ['a/file(1).md', 'a/file2.md', 'a/.*.md'].map(p => addedEntry(p));
  assert.deepStrictEqual(filterAdded(added, '(1').map(a => a.path), ['a/file(1).md']);
  assert.deepStrictEqual(filterAdded(added, '.*').map(a => a.path), ['a/.*.md']);
  assert.deepStrictEqual(filterAdded(added, '[').length, 0);
});

test('filterAdded finds a name stored decomposed, as a Mac disk spells it', () => {
  const added = [addedEntry('a/Gödel.md')];
  assert.strictEqual(filterAdded(added, 'Gödel').length, 1);
  assert.strictEqual(filterAdded(added, 'gödel').length, 1);
});

test('filterAdded with an empty query gives everything', () => {
  const added = [addedEntry('a.md'), addedEntry('b.md')];
  assert.strictEqual(filterAdded(added, '   ').length, 2);
});

test('resolveFile opens x ids in range, for any chat', () => {
  const added = [addedEntry('a.md', 'other'), addedEntry('b.md')];
  assert.deepStrictEqual(resolveFile({}, 'x0', null, added), { file: 'x0', version: 0 });
  assert.deepStrictEqual(resolveFile(undefined, 'x1', 7, added), { file: 'x1', version: 0 });
});

test('resolveFile rejects any x id that is not an index into added', () => {
  const added = [addedEntry('a.md')];
  for (const id of ['x1', 'x-1', 'x', 'x01', 'x1e0', 'x0.0', 'x0 ', ' x0', 'x__proto__', 'xconstructor', 'xlength', 'x99999999999999999999', 'X0']) {
    assert.strictEqual(resolveFile({}, id, 0, added), null, id);
  }
  assert.strictEqual(resolveFile({}, 'x0', 0), null);
  assert.strictEqual(resolveFile({}, 'x0', 0, []), null);
  assert.strictEqual(resolveFile({}, 'x0', 0, 'x'), null);
  assert.strictEqual(isAddedId('x0'), true);
  assert.strictEqual(isAddedId('a0'), false);
  assert.strictEqual(isAddedId(null), false);
});

test('resolveFile still finds generated files with added present', () => {
  assert.deepStrictEqual(resolveFile({ a1: { versions: [{}] } }, 'a1', 0, [addedEntry('a.md')]), { file: 'a1', version: 0 });
});

test('addedFile builds a GenFile the panel can show', () => {
  const entry = addedEntry('notes/Plan.md', null, { key: '4', part: 2, href: 'notes/Plan.md' });
  assert.deepStrictEqual(addedFile([entry], 'x0'), {
    name: 'Plan.md', path: 'notes/Plan.md', kind: 'md', added: true, tooLarge: false,
    versions: [{ label: '', text: null, href: 'notes/Plan.md', part: 2, key: '4' }],
  });
  assert.strictEqual(addedFile([entry], 'x1'), null);
  assert.strictEqual(addedFile([entry], 'x__proto__'), null);
  assert.strictEqual(fileKindLabel(addedFile([entry], 'x0')), 'Document · MD');
});

test('addedFile: text with no part is too large, whatever its kind', () => {
  const big = (path, kind) => addedFile([addedEntry(path, null, { kind, part: null, key: null })], 'x0');
  for (const [path, kind] of [['a.html', 'html'], ['a.svg', 'svg'], ['a.md', 'md'], ['a.py', 'code'], ['a.jsx', 'react'], ['a.mmd', 'mermaid']]) {
    assert.strictEqual(big(path, kind).tooLarge, true, path);
  }
  for (const [path, kind] of [['a.png', 'image'], ['a.pdf', 'pdf'], ['a.zip', 'binary'], ['a.mp3', 'binary']]) {
    assert.strictEqual(big(path, kind).tooLarge, false, path);
  }
});

test('addedFile: audio and video go by their href, and only those types', () => {
  const kindOf = path => addedFile([addedEntry(path, null, { kind: 'binary', part: null, key: null })], 'x0').kind;
  for (const p of ['a.m4a', 'a.mp3', 'a.wav', 'a.ogg', 'a.MP3']) assert.strictEqual(kindOf(p), 'audio', p);
  for (const p of ['a.mp4', 'a.webm', 'a.mov']) assert.strictEqual(kindOf(p), 'video', p);
  for (const p of ['a.flac', 'a.avi', 'a.mp3.zip', 'mp3']) assert.strictEqual(kindOf(p), 'binary', p);
});

test('addedFile: an image is one only by its href', () => {
  const kindOf = (path, kind = 'image') => addedFile([addedEntry(path, null, { kind, part: null, key: null })], 'x0').kind;
  for (const p of ['a.png', 'a.jpg', 'a.jpeg', 'a.gif', 'a.webp', 'a.PNG']) assert.strictEqual(kindOf(p), 'image', p);
  assert.strictEqual(kindOf('a.bmp'), 'binary');
  assert.strictEqual(kindOf('a.png.exe'), 'binary');
});

test('addedFile: a .markdown file is Markdown', () => {
  const kindOf = (path, part = 1) => addedFile([addedEntry(path, null, { kind: 'code', part })], 'x0').kind;
  assert.strictEqual(kindOf('notes.markdown'), 'md');
  assert.strictEqual(kindOf('NOTES.MARKDOWN'), 'md');
  assert.strictEqual(kindOf('notes.markdown', null), 'md');
  assert.strictEqual(kindOf('notes.markdown.txt'), 'code');
});

test('fileViews gives audio and video a preview from a link', () => {
  assert.deepStrictEqual(fileViews('audio', { text: null, href: 'a.mp3' }), { views: ['preview'], note: '', missing: false });
  assert.deepStrictEqual(fileViews('video', { text: null, href: 'a.mp4' }), { views: ['preview'], note: '', missing: false });
  assert.strictEqual(fileViews('audio', { text: null, href: null }).missing, true);
  assert.strictEqual(fileKindLabel({ kind: 'audio', name: 'a.mp3' }), 'Audio · MP3');
  assert.strictEqual(fileKindLabel({ kind: 'video', name: 'a.mov' }), 'Video · MOV');
});
