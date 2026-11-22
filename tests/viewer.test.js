// Viewer page logic: message tree and hash state.
const { test } = require('node:test');
const assert = require('node:assert');
const { chainFrom, siblingsOf, leafUnder, switchBranch, parseHash, formatHash, protectMath, placeholderMark, splitPlaceholders, addCitations, beforeCitation, toolInputText, buildSearchIndex, searchChats, parseQuery, groupHits, markTerms, chatFiles, countTerms, findPlan, groupChats, linkProjects, copyText, attachmentNames, uploadName, fileSearchSources, fileHit, resolveArtifactPath, inlineArtifact, artifactPreviewDoc, artifactTabs, relativeTime, parseArtifactHash } = require('../viewer/viewer-logic.js');

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
  assert.deepStrictEqual(m02.blocks[0], { t: 'thinking', text: 'Plan the report first.\nThen write it.', summaries: ['Planning the report'], summary: 'Planning the report', seconds: null });
  assert.deepStrictEqual(m02.blocks[1], { t: 'text', text: 'Creating it.', cites: [{ end: 8, url: 'https://example.com/a', title: 'Example A', site: '' }] });
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
  assert.strictEqual(a.blocks[0].label, 'Searched the web');
  assert.strictEqual(a.blocks[0].detail, 'cats');
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
  assert.deepStrictEqual(text.cites, [{ end: 2, url: 'http://ok.example/', title: 'ok', site: '' }]);
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

test('buildViewerData keeps an identical project once, and linkProjects puts it back', () => {
  const docs = [{ name: 'Brief', text: 'x'.repeat(5000) }];
  const planets = { name: 'Planets', files: [{ name: 'a.pdf', href: 'projects/Planets/files/a.pdf' }], instructions: 'Be brief.', docs };
  const mk = (id, updated, project) => ({ id, title: id, updated, messages: [], ...(project === undefined ? {} : { project }) });
  const chats = [
    mk('p1', '2026-01-01', planets), mk('p2', '2026-02-01', JSON.parse(JSON.stringify(planets))), mk('p3', '2026-03-01', { ...planets, instructions: 'Changed.' }),
    mk('solo', '2026-04-01', null), mk('none', '2026-05-01')
  ];
  const before = JSON.stringify(chats);
  const d = buildViewerData(chats, { exported: 'x' });
  assert.strictEqual(JSON.stringify(chats), before);
  assert.strictEqual(d.projects.length, 2);
  assert.strictEqual(JSON.stringify(d).split('x'.repeat(5000)).length - 1, 2);
  assert.deepStrictEqual(d.chats.map(c => c.project), [undefined, null, 0, 1, 1]);
  const back = linkProjects(JSON.parse(JSON.stringify(d)));
  const byId = Object.fromEntries(back.map(c => [c.id, c.project]));
  assert.deepStrictEqual(byId.p1, planets);
  assert.deepStrictEqual(byId.p2, planets);
  assert.strictEqual(byId.p3.instructions, 'Changed.');
  assert.strictEqual(byId.solo, null);
  assert.strictEqual(byId.none, null);
  assert.deepStrictEqual(buildViewerData([], {}).projects, []);
});

test('linkProjects turns an index that names no project into no project', () => {
  const p = { name: 'P', files: [], instructions: '', docs: [] };
  const chats = [-1, 1, 1.5, '0', '__proto__', true, {}, 0].map((project, i) => ({ id: 'c' + i, project }));
  const out = linkProjects({ chats, projects: [p] });
  assert.deepStrictEqual(out.map(c => c.project), [null, null, null, null, null, null, {}, p]);
  assert.deepStrictEqual(linkProjects({ chats: [{ id: 'a', project: 0 }] }).map(c => c.project), [null]);
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
  assert.strictEqual((html.match(/<\/script>/g) || []).length, 7);
  assert.ok(!/\/\*(KATEX_CSS|ARTIFACTS_CSS|DATA_JSON|MARKED_JS|KATEX_JS|HIGHLIGHT_JS|LOGIC_JS|ARTIFACTS_APP_JS|APP_JS)\*\//.test(html.replace(raw, '')));
  for (const s of ['var marked=1;', 'var katex=1;', 'var hljs=1;', 'var logic=1;', 'var app=1;', '.k{}']) assert.ok(html.includes(s));
  assert.strictEqual(escapeJson({ a: '</x' }), '{"a":"<\\/x"}');
});

test('VIEWER_ASSETS lists the nine viewer files', () => {
  assert.deepStrictEqual(VIEWER_ASSETS, ['viewer/viewer-template.html', 'viewer/viewer-logic.js', 'viewer/viewer-app.js', 'viewer/marked.min.js', 'viewer/katex.min.js', 'viewer/katex-inline.css', 'viewer/highlight.min.js', 'viewer/artifacts-app.js', 'viewer/artifacts.css']);
});

test('ARTIFACTS_VIEWER_ASSETS lists the artifacts viewer\'s five files, and each exists', () => {
  assert.deepStrictEqual(V.ARTIFACTS_VIEWER_ASSETS, ['viewer/artifacts-template.html', 'viewer/viewer-logic.js', 'viewer/artifacts-app.js', 'viewer/marked.min.js', 'viewer/artifacts.css']);
  for (const f of V.ARTIFACTS_VIEWER_ASSETS) assert.ok(fs.existsSync(path.join(__dirname, '..', f)), f);
});

test('the artifacts template keeps the chat viewer\'s policy, with no frames', () => {
  const art = fs.readFileSync(path.join(__dirname, '../viewer/artifacts-template.html'), 'utf8');
  const policy = (t) => /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(t)[1];
  assert.strictEqual(policy(art), policy(template).replace("frame-src file:", "frame-src 'none'"));
  assert.ok(art.includes('<meta name="generator" content="Claude Takeout">'));
  for (const p of ['ARTIFACTS_CSS', 'DATA_JSON', 'MARKED_JS', 'LOGIC_JS', 'APP_JS']) assert.strictEqual(art.split(`/*${p}*/`).length, 2, p);
  for (const f of ['viewer/artifacts-template.html', 'viewer/artifacts-app.js', 'viewer/artifacts.css']) {
    const text = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    for (const s of ['claudeusercontent', '__frame_t', '_thumb']) assert.ok(!text.includes(s), `${f}: ${s}`);
  }
});

// The chat viewer carries the artifacts app (the Artifacts screen) and its CSS, once each; the CSS sits in an inert
// <template>, so it styles only the screen's shadow root. The standalone artifacts viewer gets the same CSS as its page style.
test('the combined viewer includes the artifacts app and CSS once', () => {
  const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const [tpl, logic, app, marked, katex, css, highlight, artifactsApp, artifactsCss] = VIEWER_ASSETS.map(read);
  const views = [{ id: 'Abc', uuid: 'u-1', title: 'Guide', kind: 'Page', folder: 'artifacts/Guide_Abc', start: 'index.html', startSaved: 'index.html', startKind: 'html', files: [], part: 1, key: 'a0' }];
  const data = buildViewerData([buildViewerChat(fixture, {})], { exported: 'x', artifacts: { views, listed: 1, exported: 'x' } });
  const html = assembleViewer({ template: tpl, css, marked, katex, highlight, logic, app, artifactsApp, artifactsCss, data });
  const count = (text, s) => text.split(s).length - 1;
  assert.strictEqual(count(html, 'window.CTArtifactsApp = '), 1);
  assert.strictEqual(count(artifactsApp, 'window.CTArtifactsApp = '), 1);
  const sample = '#grid { display: grid;';
  assert.strictEqual(count(artifactsCss, sample), 1);
  assert.strictEqual(count(html, sample), 1);
  assert.ok(/<template id="artifacts-style"><style>:root \{/.test(html), 'the CSS is in the inert template');
  assert.ok(html.indexOf('window.CTArtifactsApp = ') < html.indexOf('function setupArtifacts('), 'the app is defined before the chat viewer mounts it');
  for (const s of ['claudeusercontent', '__frame_t', '_thumb']) assert.ok(!html.includes(s), s);
  // The chat viewer's policy is as before: file: frames for PDFs (the screen's previews have their own guard frame).
  assert.match(html, /frame-src file:;/);
  // The standalone viewer: the same CSS as its page style, mounted on the body.
  const [aTpl, aLogic, aApp, aMarked, aCss] = V.ARTIFACTS_VIEWER_ASSETS.map(read);
  const standalone = assembleViewer({ template: aTpl, css: '', artifactsCss: aCss, marked: aMarked, katex: '', highlight: '', logic: aLogic, app: aApp, data: { artifacts: views } });
  assert.strictEqual(count(standalone, sample), 1);
  assert.ok(standalone.includes('<style>:root {'));
  assert.ok(standalone.includes('<script>CTArtifactsApp.mount(document.body);</script>'));
  assert.match(standalone, /frame-src 'none';/);
  assert.ok(!/\/\*[A-Z_]+_(JS|CSS)\*\//.test(standalone));
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

// highlight.js as the worker runs it: the bundle, then tameMarkdown.
function workerHljs() {
  const vm = require('vm');
  const { tameMarkdown } = require('../viewer/viewer-logic.js');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../viewer/highlight.min.js'), 'utf8'), ctx);
  tameMarkdown(ctx.hljs);
  return text => ctx.hljs.highlight(text, { language: 'markdown', ignoreIllegals: true }).value;
}
const spans = (html, kind) => [...html.matchAll(new RegExp(`<span class="hljs-${kind}">([\\s\\S]*?)</span>`, 'g'))].map(m => m[1]);

test('tameMarkdown: an underscore inside a word starts no italics', () => {
  const md = workerHljs();
  const html = md('# sept21_part1.m4a\n\n## Content\n\nSo, we need one more.\n\nIs he?\n');
  assert.deepStrictEqual(spans(html, 'emphasis'), []);
  assert.ok(html.includes('<span class="hljs-section">## Content</span>'), html);
  assert.deepStrictEqual(spans(md('a snake__case__name here\n'), 'strong'), []);
  assert.deepStrictEqual(spans(md('a snake_case_name here\n'), 'emphasis'), []);
});

test('tameMarkdown: italics and bold still work, and stop at a blank line', () => {
  const md = workerHljs();
  assert.deepStrictEqual(spans(md('some _real_ and *star* text\n'), 'emphasis'), ['_real_', '*star*']);
  assert.deepStrictEqual(spans(md('some __bold__ and **more** text\n'), 'strong'), ['__bold__', '**more**']);
  assert.ok(spans(md('a * b and _open\n\nnext paragraph_ here\n'), 'emphasis').every(t => !t.includes('next paragraph')));
  assert.ok(spans(md('**open\n\nnext paragraph** here\n'), 'strong').every(t => !t.includes('next paragraph')));
});

test('tameMarkdown leaves an hljs without markdown alone', () => {
  const { tameMarkdown } = require('../viewer/viewer-logic.js');
  tameMarkdown({ getLanguage: () => undefined });
  tameMarkdown(undefined);
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
  return Object.assign({ folder: '', artifacts: plain, artifactIndex, deliveries, heredocs: popup.fn('heredocFiles'), docKey: popup.fn('claudeDocKey') }, extra);
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

test('artifacts-tool update edits and rewrites get a card for their version', () => {
  const art = (id, input) => ({ type: 'tool_use', id, name: 'artifacts', input: { id: 'doc', title: 'Doc', type: 'text/markdown', ...input } });
  const msgs = [];
  let parent = null;
  [[art('1', { command: 'create', content: 'hello world' })], [art('2', { command: 'update', old_str: 'world', new_str: 'there' })], [art('3', { command: 'rewrite', content: 'fresh' })]]
    .forEach((content, i) => {
      msgs.push({ uuid: `h${i}`, parent_message_uuid: parent, sender: 'human', created_at: '2026-01-01T00:00:00Z', content: [{ type: 'text', text: 'go' }] });
      msgs.push({ uuid: `a${i}`, parent_message_uuid: `h${i}`, sender: 'assistant', created_at: '2026-01-01T00:00:01Z', content });
      parent = `a${i}`;
    });
  const data = { uuid: 'c', name: 'Doc chat', current_leaf_message_uuid: parent, chat_messages: msgs };
  const chat = buildViewerChat(data, ctxFor(data));
  const cards = ['a0', 'a1', 'a2'].map(id => cardsOf(chat, id));
  assert.deepStrictEqual(cards.map(c => c.length), [1, 1, 1]);
  assert.deepStrictEqual(cards.map(c => c[0].version), [0, 1, 2]);
  assert.deepStrictEqual(fileOf(chat, cards[0][0]).versions.map(v => v.text), ['hello world', 'hello there', 'fresh']);
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
  assert.strictEqual(inlineSiblings('<script src="app.js"></script>', () => 'x="<!--<script>"'), '<script>x="<\\x21--<script>"</script>');
});

test('inlineSiblings keeps a u-flag regular expression with <!-- valid', () => {
  const code = 'globalThis.hit = /<!--/u.test("a<!--b") && "<!--".length === 4;';
  const body = /^<script>([\s\S]*)<\/script>$/.exec(inlineSiblings('<script src="re.js"></script>', () => code))[1];
  assert.notStrictEqual(body, code);
  delete globalThis.hit;
  new Function(body)();
  assert.strictEqual(globalThis.hit, true);
  delete globalThis.hit;
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
  const ctx = { folder: 'A B', uploads: { u1: { path: 'uploads/p01_a.png', text: null }, u2: { path: 'uploads/p01_b.pdf', text: null }, 'm01\nold one.txt': { path: 'uploads/p01_old one.txt', text: 'hi' } } };  // no UUID: message and name
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

test('chatFiles puts files Claude never shared under working files', () => {
  const card = (file, version) => ({ t: 'card', file, version });
  const chat = {
    files: {
      a1: { name: 'build.py', kind: 'code', shared: false, versions: [{ label: '', text: 'x', href: 'a' }] },
      a2: { name: 'Minutes.odt', kind: 'binary', shared: true, versions: [{ label: '', text: null, href: 'b' }] },
    },
    messages: [{ id: 'a', sender: 'assistant', blocks: [card('a1', 0), card('a2', 0)] }],
  };
  const f = JSON.parse(JSON.stringify(chatFiles(chat)));
  assert.deepStrictEqual(f.outputs.map(o => o.name), ['Minutes.odt']);
  assert.deepStrictEqual(f.working.map(o => o.name), ['build.py']);
});

test('buildViewerChat marks a file shared when Claude sent, presented, saved to outputs or made it as an artifact', () => {
  const use = (id, name, input) => ({ type: 'tool_use', id, name, input });
  const data = {
    uuid: 'c', name: 'c', current_leaf_message_uuid: 'a',
    chat_messages: [
      { uuid: 'h', parent_message_uuid: null, sender: 'human', created_at: '2026-01-01T00:00:00Z', content: [{ type: 'text', text: 'go' }] },
      { uuid: 'a', parent_message_uuid: 'h', sender: 'assistant', created_at: '2026-01-01T00:00:01Z', content: [
        use('1', 'create_file', { path: '/home/claude/build.py', file_text: 'print(1)' }),
        use('2', 'create_file', { path: '/home/claude/page.html', file_text: '<p>x</p>' }),
        use('3', 'present_files', { filepaths: ['/home/claude/page.html'] }),
        { type: 'tool_result', tool_use_id: '3', name: 'present_files', content: [] },
        use('4', 'create_file', { path: '/mnt/user-data/outputs/report.md', file_text: '# r' }),
        use('5', 'artifacts', { command: 'create', id: 'd', title: 'Doc', type: 'text/markdown', content: '# d' }),
      ] },
    ],
  };
  const chat = buildViewerChat(data, ctxFor(data));
  const shared = Object.fromEntries(Object.values(chat.files).map(f => [f.name, f.shared]));
  assert.deepStrictEqual(shared, { 'build.py': false, 'page.html': true, 'report.md': true, 'Doc.md': true });
});

test('a Claude Docs document gets a card, as an output', () => {
  const { docTools } = require('./helpers');
  const t = docTools();
  const data = { uuid: 'c', name: 'c', current_leaf_message_uuid: 'a', chat_messages: [
    { uuid: 'h', parent_message_uuid: null, sender: 'human', created_at: '2026-01-01T00:00:00Z', content: [{ type: 'text', text: 'go' }] },
    { uuid: 'a', parent_message_uuid: 'h', sender: 'assistant', created_at: '2026-01-01T00:00:01Z', content: [t.batch, t.batchResult, t.update('u1', 'sess.10', '## Alpha'), t.result('u1', '{}')] },
  ] };
  const chat = buildViewerChat(data, ctxFor(data));
  const files = Object.values(chat.files);
  assert.deepStrictEqual(files.map(f => [f.name, f.kind, f.shared]), [['Lorber_Notes.md', 'md', true]]);
  assert.ok(files[0].versions[0].text.includes('## Alpha'));
  assert.strictEqual(chat.messages.find(m => m.id === 'a').blocks.filter(b => b.t === 'card').length, 1, 'one card for the document');
  assert.deepStrictEqual(chat.messages.find(m => m.id === 'a').blocks.filter(b => b.t === 'tool').map(b => b.label), ['Created a document', 'Edited the document']);
  const editBatch = { type: 'tool_use', id: 'be', name: 'mcp__Claude_Docs__batch', input: { container: { kind: 'project', id: 'node-1' }, batch: [] } };
  assert.strictEqual(buildViewerChat(Object.assign({}, data, { chat_messages: [data.chat_messages[0], Object.assign({}, data.chat_messages[1], { content: [editBatch] })] }), ctxFor(data))
    .messages.find(m => m.id === 'a').blocks.find(b => b.t === 'tool').label, 'Edited the document', 'a batch without create edits');
});

test('countTerms counts every occurrence of any term, longest first, without overlaps', () => {
  assert.strictEqual(countTerms('survey Survey SURVEYS', ['survey']), 3);
  assert.strictEqual(countTerms('survey feedback, survey', ['survey', 'feedback']), 3);
  assert.strictEqual(countTerms('aaaa', ['aa']), 2);
  assert.strictEqual(countTerms('surveys', ['survey', 'surveys']), 1, 'the longer term wins at one spot');
  assert.strictEqual(countTerms('nothing', ['survey']), 0);
  assert.strictEqual(countTerms('x', []), 0);
});

test('findPlan: matching messages in chat order, counted from what the conversation shows', () => {
  const msg = (id, text, extra = {}) => ({ id, parent: null, sender: 'assistant', blocks: [{ t: 'text', text, cites: [] }], uploads: [], attachments: [], ...extra });
  const chat = { messages: [
    msg('m1', 'the survey and the survey again'),
    msg('m2', 'no match here', { attachments: [{ name: 'p.txt', text: 'survey survey survey' }] }),
    msg('m3', 'Survey draft'),
    msg('m4', 'survey feedback came in', { blocks: [{ t: 'thinking', text: 'survey survey' }, { t: 'text', text: 'survey feedback came in', cites: [] }] }),
  ] };
  const plan = q => JSON.parse(JSON.stringify(findPlan(chat, q)));
  assert.deepStrictEqual(plan('survey'), { terms: ['survey'], items: [{ msg: 'm1', count: 2 }, { msg: 'm3', count: 1 }, { msg: 'm4', count: 1 }], total: 4 });
  assert.deepStrictEqual(plan('survey -draft').items.map(i => i.msg), ['m1', 'm4']);
  assert.deepStrictEqual(plan('survey feedback'), { terms: ['survey', 'feedback'], items: [{ msg: 'm4', count: 2 }], total: 2 });
  assert.deepStrictEqual(plan('"no match"').items, [{ msg: 'm2', count: 1 }]);
  assert.deepStrictEqual(plan(''), { terms: [], items: [], total: 0 });
});

test('chatFiles: outputs once each, newest first, and every upload and paste', () => {
  const card = (file, version) => ({ t: 'card', file, version });
  const chat = {
    files: {
      a1: { name: 'Minutes 09 21.odt', kind: 'binary', versions: [{ label: '', text: null, href: 'x' }] },
      a2: { name: 'notes.md', kind: 'md', versions: [{ label: 'v1', text: 'a', href: 'y1' }, { label: 'v2', text: 'b', href: 'y2' }] },
      a3: { name: 'gone.html', kind: 'missing', versions: [{ label: '', text: null, href: null }] },
    },
    messages: [
      { id: 'h1', sender: 'human', blocks: [], uploads: [{ name: 'rec.m4a.md', href: 'uploads/p01_rec.m4a.md', text: 'hi' }], attachments: [{ name: '', text: 'pasted one' }] },
      { id: 'a1', sender: 'assistant', blocks: [card('a1', 0), card('a2', 0)] },
      { id: 'h2', sender: 'human', blocks: [], uploads: [{ name: 'photo.png', href: 'uploads/p02_photo.png', text: null }, { name: 'rec.m4a.md', href: 'uploads/p01_rec.m4a.md', text: 'hi' }], attachments: [] },
      { id: 'a2', sender: 'assistant', blocks: [card('a2', 1), card('a3', 0)] },
    ],
  };
  const f = JSON.parse(JSON.stringify(chatFiles(chat)));
  assert.deepStrictEqual(f.outputs.map(o => [o.id, o.name, o.versions]), [['a3', 'gone.html', 1], ['a2', 'notes.md', 2], ['a1', 'Minutes 09 21.odt', 1]]);
  assert.deepStrictEqual(f.uploads.map(u => [u.name, u.pasted]), [['photo.png', false], ['rec.m4a.md', false], ['Pasted text', true]]);
  assert.strictEqual(f.uploads[1].item.href, 'uploads/p01_rec.m4a.md', 'an upload is listed once');
  assert.deepStrictEqual(f.working, [], 'files from an older viewer, with no shared flag, are all outputs');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(chatFiles({ files: {}, messages: [] }))), { outputs: [], working: [], uploads: [] });
});

test('parseQuery: words, "phrases", OR and -exclusions', () => {
  const q = text => JSON.parse(JSON.stringify(parseQuery(text)));
  assert.deepStrictEqual(q('Survey feedback'), { all: [['survey'], ['feedback']], none: [] });
  assert.deepStrictEqual(q('"Survey feedback"'), { all: [['survey feedback']], none: [] });
  assert.deepStrictEqual(q('survey OR poll'), { all: [['survey', 'poll']], none: [] });
  assert.deepStrictEqual(q('minutes survey OR poll OR vote'), { all: [['minutes'], ['survey', 'poll', 'vote']], none: [] });
  assert.deepStrictEqual(q('survey -draft -"old copy"'), { all: [['survey']], none: ['draft', 'old copy'] });
  assert.deepStrictEqual(q('cats or dogs'), { all: [['cats'], ['or'], ['dogs']], none: [] }, 'only a capital OR is an operator');
  assert.deepStrictEqual(q('OR survey OR'), { all: [['survey']], none: [] }, 'a stray OR is ignored');
  assert.deepStrictEqual(q('"open phrase'), { all: [['open phrase']], none: [] });
  assert.deepStrictEqual(q('- -- ""'), { all: [['--']], none: [] });
  assert.deepStrictEqual(q('   '), { all: [], none: [] });
});

test('search matches every word in any order, with OR and exclusions', () => {
  const idx = buildSearchIndex([
    { id: 'a', title: 'Notes', project: null, messages: [T('a1', null, 'human', 'Please send the survey and collect feedback.'), T('a2', 'a1', 'assistant', 'Survey draft attached.')] },
    { id: 'b', title: 'Poll', project: null, messages: [T('b1', null, 'human', 'Feedback from the survey came back.')] },
    { id: 'c', title: 'Vote', project: null, messages: [T('c1', null, 'human', 'A quick poll for the board.')] },
  ]);
  const msgs = q => searchChats(idx, q, Infinity).map(h => h.msg);
  assert.deepStrictEqual(msgs('survey feedback'), ['a1', 'b1']);
  assert.deepStrictEqual(msgs('feedback survey'), ['a1', 'b1']);
  assert.deepStrictEqual(msgs('"survey feedback"'), []);
  assert.deepStrictEqual(msgs('"the survey"'), ['a1', 'b1']);
  assert.deepStrictEqual(msgs('survey -draft'), ['a1', 'b1']);
  assert.deepStrictEqual(msgs('survey OR poll'), ['a1', 'a2', null, 'b1', 'c1'], 'chat b: its title, Poll, then its message');
  assert.deepStrictEqual(searchChats(idx, 'feedback survey', Infinity)[0].terms, ['feedback', 'survey']);
  assert.ok(searchChats(idx, 'feedback survey', Infinity)[0].snippet.includes('survey'), 'the snippet starts near the first word found');
  assert.deepStrictEqual(msgs('-draft'), [], 'exclusions alone find nothing');
});

test('groupHits: one entry per chat, title matches first, then most matches, then order', () => {
  const hits = [
    { chat: 'x', msg: 'x1', snippet: 's1', terms: ['survey'] },
    { chat: 'y', msg: 'y1', snippet: 's2', terms: ['survey'] },
    { chat: 'y', msg: 'y2', snippet: 's3', terms: ['survey'] },
    { chat: 'z', msg: null, snippet: 'Survey title', terms: ['survey'] },
    { chat: 'z', msg: 'z1', snippet: 's4', terms: ['survey'] },
    { chat: 'y', msg: 'y3', snippet: 's5', terms: ['survey'] },
    { chat: 'y', msg: 'y4', snippet: 's6', terms: ['survey'] },
  ];
  const groups = JSON.parse(JSON.stringify(groupHits(hits, 3)));
  assert.deepStrictEqual(groups.map(g => [g.chat, g.title, g.count]), [['z', true, 1], ['y', false, 4], ['x', false, 1]]);
  assert.deepStrictEqual(groups[1].snippets.map(s => s.msg), ['y1', 'y2', 'y3'], 'at most three snippets');
  assert.deepStrictEqual(groups[0].snippets.map(s => s.msg), ['z1']);
});

test('markTerms splits text into plain and matched pieces', () => {
  const pieces = JSON.parse(JSON.stringify(markTerms('Survey results: the survey feedback', ['survey', 'feedback'])));
  assert.deepStrictEqual(pieces, [
    { text: 'Survey', hit: true }, { text: ' results: the ', hit: false }, { text: 'survey', hit: true },
    { text: ' ', hit: false }, { text: 'feedback', hit: true },
  ]);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(markTerms('nothing here', ['zebra']))), [{ text: 'nothing here', hit: false }]);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(markTerms('\u0130 survey', ['survey']))).map(p => p.hit), [false, true]);
});

test('snippets are about 80 characters with ellipses where cut', () => {
  const text = 'a'.repeat(200) + 'MATCH' + 'b'.repeat(200);
  const hit = searchChats(buildSearchIndex([{ id: 'l', title: 'L', project: null, messages: [T('l1', null, 'human', text)] }]), 'match')[0];
  assert.ok(hit.snippet.startsWith('\u2026') && hit.snippet.endsWith('\u2026') && hit.snippet.includes('MATCH'));
  assert.ok(hit.snippet.length <= 84);
});

test('groupChats keeps different projects with one name apart, and equal ones together', () => {
  const chats = [
    { id: 'a', title: 'a', project: { name: 'Research', instructions: '', docs: [{ name: 'x.md', text: 'one' }], files: [] }, messages: [] },
    { id: 'b', title: 'b', project: { name: 'Research', instructions: '', docs: [{ name: 'y.md', text: 'two' }], files: [] }, messages: [] },
    { id: 'c', title: 'c', project: { name: 'Research', instructions: '', docs: [{ name: 'x.md', text: 'one' }], files: [] }, messages: [] },
  ];
  const g = groupChats(chats);
  assert.deepStrictEqual(g.projects.map(p => [p.name, p.chats.map(c => c.id)]), [['Research', ['a', 'c']], ['Research (2)', ['b']]]);
});

test('tree lookups stay fast on a long chat', () => {
  const long = Array.from({ length: 4000 }, (_, i) => ({ id: 'm' + i, parent: i ? 'm' + (i - 1) : null, sender: i % 2 ? 'assistant' : 'human', at: String(i).padStart(6, '0') }));
  const t0 = Date.now();
  assert.strictEqual(leafUnder(long, 'm0'), 'm3999');
  assert.strictEqual(switchBranch(long, 'm1', 1), null);
  assert.deepStrictEqual(siblingsOf(long, 'm1'), { ids: ['m1'], index: 0 });
  assert.ok(Date.now() - t0 < 150, `took ${Date.now() - t0} ms`);
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

// ---- upload text parts (moveUploadText) ----
{
  const { moveUploadText, PART_LIMIT, UPLOAD_INLINE_LIMIT } = V;
  const KB = n => 'a'.repeat(n * 1024);
  const upload = (name, text) => ({ name, href: 'uploads/' + name, text });
  const chatWith = (id, uploads, attachments = []) => ({ id, title: id, updated: id, messages: [{ id: id + '-m', sender: 'human', blocks: [{ t: 'text', text: 'prompt about ' + id }], uploads, attachments }] });
  const runPart = body => { let got = null; new Function('window', body)({ __archivePart: (n, d) => { got = { n, d }; } }); return got; };

  test('moveUploadText moves only large upload text, numbered from firstPart', () => {
    assert.strictEqual(PART_LIMIT, 4 * 1024 * 1024);
    assert.strictEqual(UPLOAD_INLINE_LIMIT, 64 * 1024);
    const big1 = KB(70) + '\nline2', big2 = KB(70);
    const data = buildViewerData([
      chatWith('c3', [upload('small.md', KB(10))]),
      chatWith('c2', [upload('big1.md', big1)], [{ name: 'paste.txt', text: KB(70) }]),
      chatWith('c1', [upload('big2.py', big2)]),
    ], { exported: 'x' });
    const before = JSON.stringify(data);
    const { data: out, parts } = moveUploadText(data, { firstPart: 3 });
    assert.strictEqual(JSON.stringify(data), before);
    const ups = out.chats.flatMap(c => c.messages[0].uploads);
    assert.deepStrictEqual(ups.map(u => [u.name, u.text === null, u.part, u.key, u.lines]), [
      ['small.md', false, undefined, undefined, undefined], ['big1.md', true, 3, 'u0', 2], ['big2.py', true, 3, 'u1', 1]]);
    assert.strictEqual(ups[1].href, 'uploads/big1.md');
    assert.strictEqual(out.chats[1].messages[0].attachments[0].text, KB(70));
    assert.deepStrictEqual(parts.map(p => p.name), ['part-0003.js']);
    assert.deepStrictEqual(runPart(parts[0].body), { n: 3, d: { u0: big1, u1: big2 } });
  });

  test('moveUploadText leaves the search index unchanged', () => {
    const data = buildViewerData([chatWith('c1', [upload('big.md', KB(80) + ' quokka')], [{ name: 'p.txt', text: KB(70) + ' wombat' }])], {});
    const index = d => buildSearchIndex(linkProjects(JSON.parse(JSON.stringify(d))));
    assert.deepStrictEqual(index(moveUploadText(data).data), index(data));
  });

  test('moveUploadText splits at partLimit and keeps hostile text intact', () => {
    const hostile = '</script><!-- ' + '😀'.repeat(40000);
    assert.ok(hostile.length < 100 * 1024 && new TextEncoder().encode(hostile).length > 64 * 1024);
    const texts = [KB(70), KB(70), hostile];
    const data = buildViewerData([chatWith('c1', texts.map((t, i) => upload(`f${i}.md`, t)))], {});
    const { data: out, parts } = moveUploadText(data, { partLimit: 100 * 1024 });
    assert.strictEqual(parts.length, 3);
    const got = {};
    parts.forEach((p, i) => {
      const r = runPart(p.body);
      assert.strictEqual(r.n, i + 1);
      assert.ok(Buffer.byteLength(p.body) <= 100 * 1024 || Object.keys(r.d).length === 1);
      Object.assign(got, r.d);
    });
    out.chats[0].messages[0].uploads.forEach((u, i) => assert.strictEqual(got[u.key], texts[i]));
  });

  test('moveUploadText also moves large file text, but not stylesheets or scripts a preview inlines', () => {
    const file = (name, ...texts) => ({ name, kind: 'html', versions: texts.map((text, i) => ({ label: texts.length > 1 ? 'v' + (i + 1) : '', text, href: 'artefacts/' + name })) });
    const chat = { ...chatWith('c1', [upload('big.md', KB(70))]), files: { a1: file('page.html', KB(70) + ' one', KB(70) + ' two'), a2: file('style.css', KB(70)), a3: file('app.js', KB(70)), a4: file('small.html', KB(1)) } };
    const data = buildViewerData([chat], {});
    const before = JSON.stringify(data);
    const { data: out, parts } = moveUploadText(data);
    assert.strictEqual(JSON.stringify(data), before, 'input untouched');
    const files = out.chats[0].files;
    assert.deepStrictEqual(files.a1.versions.map(v => [v.text, v.key]), [[null, 'f0'], [null, 'f1']]);
    assert.ok(files.a1.versions.every(v => v.part === 1 && v.href === 'artefacts/page.html'));
    assert.strictEqual(files.a2.versions[0].text, KB(70));
    assert.strictEqual(files.a3.versions[0].text, KB(70));
    assert.strictEqual(files.a4.versions[0].text, KB(1));
    assert.strictEqual(out.chats[0].messages[0].uploads[0].key, 'u0');
    const got = {};
    for (const p of parts) Object.assign(got, runPart(p.body).d);
    assert.deepStrictEqual([got.f0, got.f1], [KB(70) + ' one', KB(70) + ' two']);
    const index = d => buildSearchIndex(linkProjects(JSON.parse(JSON.stringify(d))));
    assert.deepStrictEqual(index(out), index(data));
  });

  test('buildViewerData keeps one copy of projects that are equal but not the same object', () => {
    const docs = [{ name: 'a.md', text: 'x'.repeat(1000) }];
    const project = () => ({ name: 'P', instructions: 'i', docs: docs.map(d => ({ ...d })), files: [] });
    const chats = ['c1', 'c2', 'c3'].map(id => ({ ...chatWith(id, []), project: project() }));
    chats.push({ ...chatWith('c4', []), project: { ...project(), docs: [{ name: 'a.md', text: 'y'.repeat(1000) }] } });
    const out = buildViewerData(chats, {});
    assert.strictEqual(out.projects.length, 2);
    const byId = Object.fromEntries(out.chats.map(c => [c.id, c.project]));
    assert.ok(byId.c1 === byId.c2 && byId.c2 === byId.c3 && byId.c4 !== byId.c1, JSON.stringify(byId));
  });

  test('moveUploadText with nothing to move returns no parts', () => {
    const data = buildViewerData([chatWith('c1', [upload('a.md', KB(1)), upload('b.png', null)])], {});
    const { data: out, parts } = moveUploadText(data);
    assert.deepStrictEqual(parts, []);
    assert.deepStrictEqual(out, data);
  });
}

test('attachmentNames calls unnamed pasted text Pasted text, numbered when there are several', () => {
  assert.deepStrictEqual(attachmentNames([{ name: '', text: 'a' }]), ['Pasted text']);
  assert.deepStrictEqual(attachmentNames([{ name: '', text: 'a' }, { name: 'notes.txt', text: 'b' }, { text: 'c' }]), ['Pasted text 1', 'notes.txt', 'Pasted text 2']);
  assert.deepStrictEqual(attachmentNames([{ name: 'Untitled', text: 'a' }]), ['Untitled']);
  assert.deepStrictEqual(attachmentNames([]), []);
  assert.deepStrictEqual(attachmentNames(undefined), []);
});

test('uploadName falls back to the saved file name, never to Untitled itself', () => {
  assert.strictEqual(uploadName({ name: 'Untitled', href: 'uploads/p01_x.md' }), 'Untitled');
  assert.strictEqual(uploadName({ name: 'a.md', href: 'uploads/p01_a.md' }), 'a.md');
  assert.strictEqual(uploadName({ name: '', href: 'Chat%20A/uploads/p01_my%20file.md' }), 'p01_my file.md');
  assert.strictEqual(uploadName({ name: '', href: 'uploads/%E0%A4%A' }), '%E0%A4%A');
  assert.strictEqual(uploadName({ name: '', href: null }), '');
});

// ---- second review: viewer search, match bar and Files list ----
test('countTerms jumps with indexOf and counts as the character scan did', () => {
  const slow = (text, terms) => {
    const lower = String(text).toLowerCase();
    const wanted = terms.filter(Boolean).slice().sort((a, b) => b.length - a.length);
    let n = 0;
    for (let i = 0; i < lower.length;) { const t = wanted.find(w => lower.startsWith(w, i)); if (t) { n++; i += t.length; } else i++; }
    return n;
  };
  const texts = ['aaaa', 'the theme then', 'surveys survey SURVEY', 'abcabcab', '', 'x'.repeat(50)];
  const sets = [['a'], ['aa'], ['the', 'them'], ['survey', 'surveys'], ['bca', 'abc', 'cab'], ['xx', 'xxx']];
  for (const t of texts) for (const s of sets) assert.strictEqual(countTerms(t, s), slow(t, s), `${t} / ${s}`);
});

test('findPlan leaves out math and link addresses, which the conversation does not show as text', () => {
  const { shownText } = require('../viewer/viewer-logic.js');
  assert.strictEqual(shownText('See [the docs](https://example.com/docs) for docs, and $x$ here'), 'See the docs for docs, and   here');
  assert.strictEqual(shownText('`[a](b)` and ![pic](https://e.com/p.png)'), '`[a](b)` and  ');
  assert.strictEqual(shownText('Bare https://github.com/x stays'), 'Bare https://github.com/x stays');
  const chat = { messages: [{ id: 'm', blocks: [{ t: 'text', text: 'See [the docs](https://example.com/docs) for docs, and $x$ here' }] }] };
  assert.strictEqual(findPlan(chat, 'docs').total, 2);
  assert.strictEqual(findPlan(chat, 'example').total, 0);
});

test('foldCase maps lowercase offsets back to the text when lowercasing changes its length', () => {
  const { foldCase } = require('../viewer/viewer-logic.js');
  const { lower, at } = foldCase('İzmir trip');
  const i = lower.indexOf('trip');
  assert.strictEqual('İzmir trip'.slice(at[i], at[i + 4]), 'trip');
  assert.strictEqual(foldCase('plain').at, null);
});

test('Files list: off-branch artifacts stay outputs, a written file that was sent is listed once, off-branch presents point at their own branch', () => {
  const use = (id, name, input) => ({ type: 'tool_use', id, name, input });
  const res = (id, name, extra = {}) => ({ type: 'tool_result', tool_use_id: id, name, content: [], ...extra });
  const art = id => use(id, 'artifacts', { command: 'create', id: 'plan', title: 'Plan', type: 'text/markdown', content: '# ' + id });
  const twoBranches = (off, on) => ({ uuid: 'c', name: 'c', current_leaf_message_uuid: 'a2', chat_messages: [
    { uuid: 'h', parent_message_uuid: null, sender: 'human', created_at: '2026-01-01T00:00:00Z', content: [{ type: 'text', text: 'go' }] },
    { uuid: 'a1', parent_message_uuid: 'h', sender: 'assistant', created_at: '2026-01-01T00:00:01Z', content: off },
    { uuid: 'a2', parent_message_uuid: 'h', sender: 'assistant', created_at: '2026-01-01T00:00:02Z', content: on },
  ] });
  const lists = data => { const f = chatFiles(buildViewerChat(data, ctxFor(data))); return { outputs: f.outputs.map(o => o.name).sort(), working: f.working.map(o => o.name).sort() }; };
  assert.deepStrictEqual(lists(twoBranches([art('1')], [art('2')])), { outputs: ['Plan', 'Plan.md'], working: [] });

  const present = (id, p) => [use(id, 'present_files', { filepaths: [p] }), res(id, 'present_files')];
  const page = (id, text) => use(id, 'create_file', { path: '/home/claude/page.html', file_text: text });
  assert.deepStrictEqual(lists(twoBranches([page('1', 'old'), ...present('2', '/home/claude/page.html')], [page('3', 'new'), ...present('4', '/home/claude/page.html')])),
    { outputs: ['page.html', 'page.html'], working: [] });
  const old = [use('5', 'create_file', { path: '/home/claude/old.html', file_text: 'o' }), ...present('6', '/home/claude/old.html')];
  assert.deepStrictEqual(lists(twoBranches(old, [page('7', 'new')])), { outputs: ['old.html'], working: ['page.html'] });

  const sent = { uuid: 'c', name: 'c', current_leaf_message_uuid: 'a', chat_messages: [
    { uuid: 'h', parent_message_uuid: null, sender: 'human', created_at: '2026-01-01T00:00:00Z', content: [{ type: 'text', text: 'go' }] },
    { uuid: 'a', parent_message_uuid: 'h', sender: 'assistant', created_at: '2026-01-01T00:00:01Z', content: [
      use('w', 'Write', { file_path: '/root/report.md', content: '# r' }),
      use('s', 'SendUserFile', { files: ['/root/report.md'] }),
      res('s', 'SendUserFile', { file_deliveries: [{ file_uuid: 'u-1', path: '/root/report.md' }] }),
    ] },
  ] };
  assert.deepStrictEqual(lists(sent), { outputs: ['report.md'], working: [] });
});

// ---- warning badges ----
test('viewerFlags keeps the warnings that mean a file may not match, by file name', () => {
  const { viewerFlags } = require('../export-core.js');
  assert.deepStrictEqual(viewerFlags([
    { type: 'artifact_opaque_mutation', filename: 'page.html' },
    { type: 'str_replace_failed', filename: 'notes.md' },
    { type: 'str_replace_failed', filename: 'page.html' },
    { type: 'claude_doc_unreplayed', filename: 'Plan.md' },
    { type: 'upload', filename: 'a.pdf' },
  ]), { 'page.html': 'script', 'notes.md': 'edit', 'Plan.md': 'doc' });
});

test('warningsFromReport reads the warnings back out of errors.txt', () => {
  const { warningsFromReport } = require('../export-core.js');
  const report = '# Export Errors\n\n## Errors\n\n### a.pdf\n\n- **Type:** upload\n\n---\n\n## Warnings\n\n### page.html\n\n- **Type:** artifact opaque mutation\n- **Message:** x\n\n**Recovery:** y\n\n### notes.md\n\n- **Type:** str replace failed\n\n---\n\n## Troubleshooting Guide\n\n### Common HTTP Status Codes\n';
  assert.deepStrictEqual(warningsFromReport(report), [{ type: 'artifact_opaque_mutation', filename: 'page.html' }, { type: 'str_replace_failed', filename: 'notes.md' }]);
  assert.deepStrictEqual(warningsFromReport(''), []);
});

test('buildViewerChat marks flagged files', () => {
  const use = (id, name, input) => ({ type: 'tool_use', id, name, input });
  const data = { uuid: 'c', name: 'c', current_leaf_message_uuid: 'a', chat_messages: [
    { uuid: 'h', parent_message_uuid: null, sender: 'human', created_at: '2026-01-01T00:00:00Z', content: [{ type: 'text', text: 'go' }] },
    { uuid: 'a', parent_message_uuid: 'h', sender: 'assistant', created_at: '2026-01-01T00:00:01Z', content: [
      use('1', 'create_file', { path: '/home/claude/page.html', file_text: '<p>x</p>' }),
      use('2', 'create_file', { path: '/home/claude/ok.md', file_text: '# ok' }),
    ] },
  ] };
  const chat = buildViewerChat(data, ctxFor(data, { flags: { 'page.html': 'script' } }));
  assert.deepStrictEqual(Object.values(chat.files).map(f => [f.name, f.flag || null]), [['page.html', 'script'], ['ok.md', null]]);
});

test('fileSearchSources lists newest file versions and uploads once, with inline text or a part, and skips pasted text', () => {
  const chat = {
    id: 'c',
    files: {
      f1: { name: 'report.md', versions: [{ text: 'old' }, { text: 'new text' }] },
      f2: { name: 'big.html', shared: false, versions: [{ text: null, part: 3, key: 'f0' }] },
      f3: { name: 'pic.png', versions: [{ text: null, href: 'artefacts/pic.png' }] },
    },
    messages: [
      { id: 'h', uploads: [{ name: 'a.txt', href: 'uploads/a.txt', text: 'upload words' }, { name: 'b.py', href: 'uploads/b.py', text: null, part: 2, key: 'u0' }, { name: 'doc.pdf', href: 'uploads/doc.pdf', text: null }],
        attachments: [{ name: 'paste.txt', text: 'pasted' }], blocks: [] },
      { id: 'a', blocks: [{ t: 'card', file: 'f1', version: 1 }, { t: 'card', file: 'f2', version: 0 }, { t: 'card', file: 'f3', version: 0 }] },
      { id: 'h2', uploads: [{ name: 'a.txt', href: 'uploads/a.txt', text: 'upload words' }], blocks: [] },
    ],
  };
  const got = fileSearchSources([chat]).map(s => [s.kind, s.name, s.text, s.part, s.key, s.kind === 'file' ? s.version : null]);
  assert.deepStrictEqual(got, [
    ['file', 'report.md', 'new text', null, null, 1],
    ['file', 'big.html', null, 3, 'f0', 0],
    ['upload', 'a.txt', 'upload words', null, null, null],
    ['upload', 'b.py', null, 2, 'u0', null],
  ]);
});

test('fileHit searches name and text together and cuts the snippet from the text', () => {
  const q = parseQuery('wombat');
  assert.strictEqual(fileHit(q, 'notes.md', 'nothing here'), null);
  const hit = fileHit(q, 'notes.md', 'a'.repeat(200) + ' wombat ' + 'b'.repeat(200));
  assert.match(hit.snippet, /^\u2026a+ wombat b+\u2026$/);
  assert.deepStrictEqual(hit.terms, ['wombat']);
  assert.strictEqual(fileHit(parseQuery('wombat'), 'wombat.md', 'plain').snippet, 'wombat.md');
  assert.ok(fileHit(parseQuery('wombat plain'), 'wombat.md', 'plain text'), 'one word in the name, one in the text');
  assert.strictEqual(fileHit(parseQuery('wombat -plain'), 'wombat.md', 'plain text'), null);
});

// ---- Published pages: one card per publish (ctx.published, PublishedEntry from popup.js) ----
const PUB_TOOL = 'mcp__claude-artifacts__publish_files';
const PAGE_U = '0a1b2c3d-1111-4222-8333-444455556666';
const PAGE_URL = 'https://claude.ai/artifact/Short1';
const pubBlocks = (id, ver, files = [{ as: 'index.html', path: '/home/claude/guide.html' }]) => [
  { type: 'tool_use', id, name: PUB_TOOL, input: { title: 'Guide', files } },
  { type: 'tool_result', tool_use_id: id, name: PUB_TOOL, content: [{ type: 'text', text: JSON.stringify(ver === '' ? { url: PAGE_URL, title: 'Guide' } : { slug: PAGE_U, version: ver, url: PAGE_URL, title: 'Guide' }) }] },
];
// n assistant messages in a row, message i publishing ver<i>.
const pubChain = (n, extra = {}) => ({
  uuid: 'c', name: 'c', current_leaf_message_uuid: `m${n - 1}`,
  chat_messages: Array.from({ length: n }, (_, i) => ({ uuid: `m${i}`, parent_message_uuid: i ? `m${i - 1}` : null, sender: 'assistant', content: pubBlocks(`p${i}`, `ver${i}`) })),
  ...extra,
});
const pubVersion = (i, extra = {}) => ({
  ver: `ver${i}`, folderName: `ver${i}`, label: `v${i + 1}`, order: i, start: 'index.html', startSaved: 'index.html', same: false, writtenAs: null,
  incomplete: false, needsRuntime: false, text: `<p>${i}</p>`, publishes: [{ messageUuid: `m${i}`, toolUseId: `p${i}` }], ...extra,
});
const pageEntry = (versions, extra = {}) => ({ uuid: PAGE_U, shortId: 'Short1', title: 'Guide', url: PAGE_URL, current: false, dir: 'published/Guide_Short1', versions, ...extra });
const pageCards = chat => chat.messages.map(m => m.blocks.filter(b => b.t === 'card'));

test('a publish gets one published-page card, with versions in order', () => {
  const data = pubChain(11);
  const versions = Array.from({ length: 11 }, (_, i) => pubVersion(i)).reverse();
  const chat = buildViewerChat(data, ctxFor(data, { published: [pageEntry(versions)] }));
  const ids = Object.keys(chat.files);
  assert.strictEqual(ids.length, 1);
  const file = chat.files[ids[0]];
  assert.strictEqual(file.name, 'Guide');
  assert.strictEqual(file.kind, 'html');
  assert.strictEqual(file.shared, true);
  assert.deepStrictEqual(file.published, { url: PAGE_URL, current: false, needsRuntime: false });
  assert.deepStrictEqual(file.versions.map(v => v.label), Array.from({ length: 11 }, (_, i) => `v${i + 1}`));
  assert.deepStrictEqual(file.versions.map(v => v.href), Array.from({ length: 11 }, (_, i) => `published/Guide_Short1/ver${i}/index.html`));
  assert.ok(file.versions.every((v, i) => v.text === `<p>${i}</p>` && v.same === false));
  assert.deepStrictEqual(pageCards(chat), Array.from({ length: 11 }, (_, i) => [{ t: 'card', file: ids[0], version: i }]));
  // The card carries the page; the tool block no longer draws its own "Published on claude.ai" line.
  assert.ok(chat.messages.every(m => m.blocks.filter(b => b.t === 'tool').every(b => !b.published)));
});

test('a same version links the written file', () => {
  const data = pubChain(1);
  const chat = buildViewerChat(data, ctxFor(data, { published: [pageEntry([pubVersion(0, { same: true, writtenAs: 'guide_v1.html', text: 'G1' })])] }));
  const [file] = Object.values(chat.files);
  assert.deepStrictEqual(file.versions, [{ label: 'v1', text: 'G1', href: 'artefacts/guide_v1.html', same: true, ver: 'ver0' }]);
});

test('an Export All card links published/ at the export root', () => {
  const data = pubChain(1);
  const entry = pageEntry([pubVersion(0)], { dir: '../published/Guide_Short1' });
  const chat = buildViewerChat(data, ctxFor(data, { folder: 'chatA', published: [entry] }));
  assert.strictEqual(Object.values(chat.files)[0].versions[0].href, 'published/Guide_Short1/ver0/index.html');
  // A dir that climbs out of the export links nothing.
  const out = buildViewerChat(data, ctxFor(data, { folder: '', published: [{ ...entry }] }));
  assert.strictEqual(Object.values(out.files)[0].versions[0].href, null);
});

test('a current version links current/', () => {
  const data = { uuid: 'c', name: 'c', current_leaf_message_uuid: 'm0', chat_messages: [{ uuid: 'm0', parent_message_uuid: null, sender: 'assistant', content: pubBlocks('p0', '') }] };
  const entry = pageEntry([pubVersion(0, { ver: 'live7', folderName: 'current', label: 'current', order: 3 })], { current: true });
  const chat = buildViewerChat(data, ctxFor(data, { published: [entry] }));
  const [file] = Object.values(chat.files);
  assert.strictEqual(file.versions[0].href, 'published/Guide_Short1/current/index.html');
  assert.strictEqual(file.versions[0].label, 'current');
  assert.strictEqual(file.published.current, true);
});

test('a renamed start file links its saved name', () => {
  const data = pubChain(1);
  const chat = buildViewerChat(data, ctxFor(data, { published: [pageEntry([pubVersion(0, { start: 'Index.html', startSaved: 'sub dir/index_2.html' })])] }));
  assert.strictEqual(Object.values(chat.files)[0].versions[0].href, 'published/Guide_Short1/ver0/sub%20dir/index_2.html');
});

test('an incomplete version has no link', () => {
  const data = pubChain(2);
  const entry = pageEntry([pubVersion(0, { incomplete: true, start: null, startSaved: null, text: null }), pubVersion(1, { needsRuntime: true })]);
  const chat = buildViewerChat(data, ctxFor(data, { published: [entry] }));
  const [file] = Object.values(chat.files);
  assert.deepStrictEqual(file.versions[0], { label: 'v1', text: null, href: null, same: false, ver: 'ver0' });
  assert.strictEqual(file.published.needsRuntime, true);
  // A page with nothing in the export is a missing file.
  const none = buildViewerChat(pubChain(1), ctxFor(pubChain(1), { published: [pageEntry([pubVersion(0, { incomplete: true, start: null, startSaved: null, text: null })])] }));
  assert.strictEqual(Object.values(none.files)[0].kind, 'missing');
});

test('an off-branch publish shares the page card, and an attached copy of a version that differs stays listed', () => {
  const data = pubChain(2);
  // m1b: another answer to m0, off the active branch, publishing ver1 again.
  data.chat_messages.push({ uuid: 'm1b', parent_message_uuid: 'm0', sender: 'assistant', content: pubBlocks('p1b', 'ver1'),
    files_v2: [{ success: true, file_name: 'guide.html', file_uuid: 'att-b' }, { success: true, file_name: 'other.txt', file_uuid: 'att-o' }] });
  data.chat_messages[1].files_v2 = [{ success: true, file_name: 'guide.html', file_uuid: 'att-1' }];
  const entry = pageEntry([pubVersion(0), pubVersion(1, { publishes: [{ messageUuid: 'm1', toolUseId: 'p1' }, { messageUuid: 'm1b', toolUseId: 'p1b' }] })]);
  const uploads = { 'att-1': { path: 'artefacts/guide.html', text: null }, 'att-b': { path: 'artefacts/guide_2.html', text: null }, 'att-o': { path: 'artefacts/other.txt', text: null } };
  const chat = buildViewerChat(data, ctxFor(data, { published: [entry], uploads }));
  assert.strictEqual(Object.keys(chat.files).length, 1);
  const id = Object.keys(chat.files)[0];
  assert.deepStrictEqual(pageCards(chat), [[{ t: 'card', file: id, version: 0 }], [{ t: 'card', file: id, version: 1 }], [{ t: 'card', file: id, version: 1 }]]);
  // ver1 is not the same as the file Claude wrote, so claude.ai's attached copy is Claude's own file and stays.
  assert.deepStrictEqual(chat.messages.map(m => m.uploads.map(u => u.name)), [[], ['guide.html'], ['guide.html', 'other.txt']]);
});

test('the attached copy of a same version is not listed again; an upload named like the published file is', () => {
  const data = pubChain(1);
  data.chat_messages[0].files_v2 = [{ success: true, file_name: 'guide.html', file_uuid: 'att-1' }, { success: true, file_name: 'index.html', file_uuid: 'att-i' }];
  const uploads = { 'att-1': { path: 'artefacts/guide.html', text: null }, 'att-i': { path: 'artefacts/index.html', text: null } };
  const entry = pageEntry([pubVersion(0, { same: true, writtenAs: 'guide.html', text: 'G' })]);
  const chat = buildViewerChat(data, ctxFor(data, { published: [entry], uploads }));
  assert.deepStrictEqual(chat.messages[0].uploads.map(u => u.name), ['index.html']);
});

test('resolveArtifactPath trims long runs of spaces in linear time', () => {
  const url = 'a' + ' '.repeat(100000) + 'b.png';
  let t = Date.now();
  assert.strictEqual(resolveArtifactPath('index.html', url), url);
  assert.ok(Date.now() - t < 100, `resolveArtifactPath took ${Date.now() - t} ms`);
  assert.strictEqual(resolveArtifactPath('index.html', ' \t\x00 a.png \x1f '), 'a.png');
  assert.strictEqual(resolveArtifactPath('index.html', ' '.repeat(5)), null);
  const html = `<img src="${' '.repeat(1500000)}x">`;
  t = Date.now();
  inlineArtifact(html, 'index.html', { texts: [], images: [] });
  assert.ok(Date.now() - t < 500, `inlineArtifact took ${Date.now() - t} ms`);
});

test('resolveArtifactPath', () => {
  assert.strictEqual(resolveArtifactPath('site/index.html', './app.css'), 'site/app.css');
  assert.strictEqual(resolveArtifactPath('site/index.html', '../x.js'), 'x.js');
  assert.strictEqual(resolveArtifactPath('index.html', '../x.js'), null);
  for (const u of ['https://a/b.js', '//a/b.js', '/a.js', 'a.css?x', 'a.css#y', 'data:text/css,a', 'a%2Fb.js', '..%2f..%2fx.js', '']) assert.strictEqual(resolveArtifactPath('site/index.html', u), null, u);
  assert.strictEqual(resolveArtifactPath('index.html', 'img/%61.png'), 'img/a.png');
  assert.strictEqual(resolveArtifactPath('index.html', 'img\\a.png'), 'img/a.png');
  assert.strictEqual(resolveArtifactPath('index.html', '..\\a.png'), null);
  assert.strictEqual(resolveArtifactPath('index.html', '%E0%A4%A'), null);
});

test('inlineArtifact', () => {
  const payload = { texts: [['css/a.css', 'body{}'], ['js/m.js', 'x="</script><!--"'], ['__proto__', 'p']], images: [['img/a.png', 'data:image/png;base64,AAA']] };
  const html = '<link rel="stylesheet" href="css/a.css"><script src="js/m.js"></script><img src="img/a.png" alt="a"><img src="img/none.png"><img srcset="img/a.png 1x, b.png 2x"><script src="__proto__"></script>';
  const out = inlineArtifact(html, 'index.html', payload);
  assert.ok(out.includes('<style>body{}</style>'));
  assert.ok(out.includes('x="<\\/script><\\x21--"'));
  assert.ok(out.includes('<img alt="a" src="data:image/png;base64,AAA">'));
  assert.ok(out.includes('<img src="img/none.png">'));
  assert.ok(out.includes('<img src="data:image/png;base64,AAA">') && !out.includes('srcset'));
  assert.ok(out.includes('src="__proto__"'));
  const nested = inlineArtifact('<script src="a.js"></script>', 'site/index.html', { texts: [['site/a.js', 'ok()']], images: [] });
  assert.strictEqual(nested, '<script>ok()</script>');
});

test('artifactPreviewDoc puts the policy and shim first', () => {
  const { srcdoc } = artifactPreviewDoc('<!doctype html><script src="a.js"></script>', 'index.html', { texts: [['a.js', 'go()']], images: [] });
  assert.ok(srcdoc.startsWith('<!doctype html><meta http-equiv="Content-Security-Policy"'));
  const shim = srcdoc.indexOf('sessionStorage');
  assert.ok(shim > 0 && shim < srcdoc.indexOf('go()'));
});

test('artifactTabs and relativeTime', () => {
  const v = [
    { title: 'b', shared: false, updatedAt: '2026-01-01T00:00:00Z' },
    { title: 'A', shared: true, updatedAt: '2026-01-02T00:00:00Z' },
    { title: 'c', updatedAt: 'nope' },
    { title: 'a', shared: false, updatedAt: '2026-01-01T00:00:00Z' },
  ];
  assert.deepStrictEqual(artifactTabs(v, 'all', '').map(x => x.title), ['A', 'a', 'b', 'c']);
  assert.deepStrictEqual(artifactTabs(v, 'yours', '').map(x => x.title), ['a', 'b', 'c']);
  assert.deepStrictEqual(artifactTabs(v, 'shared', '').map(x => x.title), ['A']);
  assert.deepStrictEqual(artifactTabs(v, 'all', ' B ').map(x => x.title), ['b']);
  const now = Date.parse('2026-03-10T12:00:00Z');
  const ago = s => new Date(now - s * 1000).toISOString();
  assert.strictEqual(relativeTime(ago(59), now), 'just now');
  assert.strictEqual(relativeTime(ago(60), now), '1m ago');
  assert.strictEqual(relativeTime(ago(3599), now), '59m ago');
  assert.strictEqual(relativeTime(ago(3600), now), '1h ago');
  assert.strictEqual(relativeTime(ago(86400), now), '1d ago');
  assert.strictEqual(relativeTime(ago(7 * 86400), now), '2026-03-03');
  assert.strictEqual(relativeTime('x', now), '');
});

test('parseArtifactHash', () => {
  assert.strictEqual(parseArtifactHash('#a=LkJG_x-1'), 'LkJG_x-1');
  for (const h of ['#chat=abc', '#a=', '#a=<script>', '', null]) assert.strictEqual(parseArtifactHash(h), null);
});

test('artifact logic edges', () => {
  assert.strictEqual(resolveArtifactPath('index.html', 'java\tscript:x'), null);
  assert.strictEqual(resolveArtifactPath('index.html', ' \x01a.css '), 'a.css');
  assert.strictEqual(resolveArtifactPath('index.html', 'a\n/b.css'), 'a/b.css');
  const p = { texts: [['a.js', 'go()']], images: [['i.png', 'data:image/png;base64,AAA']] };
  assert.strictEqual(inlineArtifact('<img src="i.png" src="x.png">', 'index.html', p), '<img src="data:image/png;base64,AAA">');
  assert.strictEqual(inlineArtifact('<script src="a.js" src="b.js"></script>', 'index.html', p), '<script>go()</script>');
  const { STORAGE_SHIM } = require('../viewer/viewer-logic.js');
  assert.ok(STORAGE_SHIM.includes('i>=0&&i<k.length'));
  assert.strictEqual(parseArtifactHash('#chat=x&a=abc'), null);
  assert.strictEqual(parseArtifactHash('#a=abc&x=1'), null);
});

test('STORAGE_SHIM: key() answers null for an index that is not a whole number in range', () => {
  const { STORAGE_SHIM } = require('../viewer/viewer-logic.js');
  const vm = require('vm');
  const blocked = { get() { throw new Error('SecurityError'); }, configurable: true };
  const win = {};
  Object.defineProperty(win, 'localStorage', blocked);
  Object.defineProperty(win, 'sessionStorage', blocked);
  win.window = win;
  vm.runInNewContext(STORAGE_SHIM.replace(/^<script>|<\/script>$/g, ''), win);
  const ls = win.localStorage;
  ls.setItem('a', 1);
  ls.setItem('b', 2);
  assert.strictEqual(ls.key(0), 'a');
  assert.strictEqual(ls.key('1'), 'b');
  for (const i of [0.5, 1.5, -1, 2, NaN, Infinity, 'x']) assert.strictEqual(ls.key(i), null, String(i));
  assert.strictEqual(ls.length, 2);
});

test('markdownParser: raw HTML stays text, Markdown still renders, after a tag too', () => {
  const marked = require('../viewer/marked.min.js');
  const { markdownParser } = require('../viewer/viewer-logic.js');
  const md = markdownParser(marked);
  const html = md.parse('# Hi\n\nraw <b>x</b> and **bold**\n\n<script>alert(1)</script>\n');
  assert.ok(html.includes('<h1>Hi</h1>'), html);
  assert.ok(html.includes('&lt;b&gt;x&lt;/b&gt;') && html.includes('<strong>bold</strong>'), html);
  assert.ok(!html.includes('<script>') && html.includes('<p class="raw-html">&lt;script&gt;'), html);
  // Two parsers don't share state.
  assert.notStrictEqual(markdownParser(marked), md);
});

test('artifactPreviewDoc removes WebRTC before the page runs', () => {
  const { srcdoc } = artifactPreviewDoc('<script>go()</script>', 'index.html', { texts: [], images: [] });
  const shim = srcdoc.indexOf('RTCPeerConnection');
  assert.ok(shim > 0 && shim < srcdoc.indexOf('go()'));
  for (const n of ['webkitRTCPeerConnection', 'RTCDataChannel', 'RTCSessionDescription', 'RTCIceCandidate']) assert.ok(srcdoc.includes(n), n);
  // Runs: in a fake window, every name reads undefined and can't be put back.
  const { RTC_SHIM } = require('../viewer/viewer-logic.js');
  const vm = require('vm');
  const win = { RTCPeerConnection: function () {}, RTCDataChannel: function () {} };
  win.window = win;
  vm.runInNewContext(RTC_SHIM.replace(/^<script>|<\/script>$/g, ''), win);
  assert.strictEqual(win.RTCPeerConnection, undefined);
  win.RTCPeerConnection = function () {};
  assert.strictEqual(win.RTCPeerConnection, undefined);
  assert.throws(() => Object.defineProperty(win, 'RTCDataChannel', { value: 1 }));
});

test('inlineArtifact decodes entities in src and href; inlineSiblings is unchanged', () => {
  const p = { texts: [['R&D.js', 'rd()'], ['a"b.css', 'x{}'], ["it's.js", 'q()'], ['é.js', 'e()']], images: [['R&D.png', 'data:image/png;base64,AAA']] };
  assert.strictEqual(inlineArtifact('<script src="R&amp;D.js"></script>', 'index.html', p), '<script>rd()</script>');
  assert.strictEqual(inlineArtifact('<link rel="stylesheet" href="a&quot;b.css">', 'index.html', p), '<style>x{}</style>');
  assert.strictEqual(inlineArtifact('<script src="it&#39;s.js"></script>', 'index.html', p), '<script>q()</script>');
  assert.strictEqual(inlineArtifact('<script src="&#xe9;.js"></script>', 'index.html', p), '<script>e()</script>');
  assert.strictEqual(inlineArtifact('<script src="&#233;.js"></script>', 'index.html', p), '<script>e()</script>');
  assert.strictEqual(inlineArtifact('<img src="R&amp;D.png">', 'index.html', p), '<img src="data:image/png;base64,AAA">');
  assert.strictEqual(inlineArtifact('<img srcset="R&amp;D.png 2x">', 'index.html', p), '<img src="data:image/png;base64,AAA">');
  // An entity can't smuggle in a path the resolver rejects.
  assert.strictEqual(inlineArtifact('<script src="&#46;&#46;/&#46;&#46;/x.js"></script>', 'site/index.html', { texts: [['x.js', 'bad()']] }), '<script src="&#46;&#46;/&#46;&#46;/x.js"></script>');
  assert.strictEqual(inlineArtifact('<script src="&#x2F;x.js"></script>', 'index.html', { texts: [['x.js', 'bad()']] }), '<script src="&#x2F;x.js"></script>');
  // The chat viewer's inliner keeps taking the value as written.
  assert.strictEqual(inlineSiblings('<script src="R&amp;D.js"></script>', n => (n === 'R&D.js' ? 'rd()' : null)), '<script src="R&amp;D.js"></script>');
});

// ---- Combined viewer data: artifacts and their links to chats ----
{
  const { docTools, DOC_U } = require('./helpers');
  const view = (id, extra = {}) => ({ id, title: id, kind: 'Page', typed: false, docs: false, shared: false, public: false, createdAt: '', updatedAt: '', folder: 'artifacts/' + id, start: null, files: [], ...extra });
  const docChat = (id, updated) => {
    const t = docTools('mcp__Claude_Docs__', { realShape: true });
    return { uuid: id, name: id, updated_at: updated, current_leaf_message_uuid: id + 'a', chat_messages: [
      { uuid: id + 'h', parent_message_uuid: null, sender: 'human', created_at: updated, content: [{ type: 'text', text: 'go' }] },
      { uuid: id + 'a', parent_message_uuid: id + 'h', sender: 'assistant', created_at: updated, content: [t.batch, t.batchResult, t.update('u1', 'sess.10', '## Alpha'), t.result('u1', '{}')] },
    ] };
  };
  const pubChat = () => Object.assign(pubChain(1), { updated_at: '2026-02-01T00:00:00Z' });
  const built = (data, extra = {}) => buildViewerChat(data, ctxFor(data, extra));
  const shortOf = uuid => popup.fn('uuidToBase58')(uuid);
  const pubView = view(shortOf(PAGE_U)), docView = view(shortOf(DOC_U));
  const withUpdated = (chat, updated) => Object.assign(chat, { updated });

  test('artifacts and their links join the chats\' viewer data', () => {
    const pub = withUpdated(built(pubChat(), { published: [pageEntry([pubVersion(0)])] }), '2026-02-01T00:00:00Z');
    const doc = withUpdated(built(docChat('d', '2026-01-01T00:00:00Z')), '2026-01-01T00:00:00Z');
    // The newest chat is first in the data: the publishing chat is 0, the document's is 1.
    const data = buildViewerData([doc, pub], { exported: 'x', artifacts: { views: [pubView, docView], listed: 7, exported: '2026-03-01T00:00:00Z', since: null } });
    assert.deepStrictEqual(data.chats.map(c => c.id), ['c', 'd']);
    const [p, d] = data.artifacts;
    assert.deepStrictEqual(p.links, [{ chat: 0, messageUuid: 'm0', how: 'published' }]);
    assert.strictEqual(p.docFile, null);
    assert.deepStrictEqual(d.links, [{ chat: 1, messageUuid: 'da', how: 'made' }]);
    const fileId = Object.keys(data.chats[1].files).find(k => data.chats[1].files[k].name === 'Lorber_Notes.md');
    assert.deepStrictEqual(d.docFile, { chat: 1, file: fileId });
    assert.deepStrictEqual([data.listed, data.exportedArtifacts, data.artifactsSince], [7, '2026-03-01T00:00:00Z', null]);
    assert.strictEqual(buildViewerData([doc], { artifacts: { views: [docView], listed: 1, exported: 'e', since: '2026-01-01T00:00:00Z' } }).artifactsSince, '2026-01-01T00:00:00Z');
  });

  test('docFile names the latest chat that rebuilt the document; a tie goes to the later chat', () => {
    const older = withUpdated(built(docChat('o', '2026-01-01T00:00:00Z')), '2026-01-01T00:00:00Z');
    const newer = withUpdated(built(docChat('n', '2026-05-01T00:00:00Z')), '2026-05-01T00:00:00Z');
    const data = buildViewerData([older, newer], { artifacts: { views: [docView], listed: 1, exported: 'e', since: null } });
    assert.deepStrictEqual(data.chats.map(c => c.id), ['n', 'o']);
    assert.strictEqual(data.artifacts[0].docFile.chat, 0);
    assert.strictEqual(data.artifacts[0].links.length, 2);
    const a = withUpdated(built(docChat('a', 'T')), 'T'), b = withUpdated(built(docChat('b', 'T')), 'T');
    assert.strictEqual(buildViewerData([a, b], { artifacts: { views: [docView], listed: 1, exported: 'e', since: null } }).artifacts[0].docFile.chat, 1);
  });

  test('a published card names its artifact only when that artifact is in the export', () => {
    const pub = () => built(pubChat(), { published: [pageEntry([pubVersion(0)])] });
    const withArt = buildViewerData([pub()], { artifacts: { views: [pubView], listed: 1, exported: 'e', since: null } });
    assert.deepStrictEqual(Object.values(withArt.chats[0].files).map(f => f.artifact), [shortOf(PAGE_U)]);
    const other = buildViewerData([pub()], { artifacts: { views: [docView], listed: 1, exported: 'e', since: null } });
    assert.ok(Object.values(other.chats[0].files).every(f => !('artifact' in f)));
  });

  // artifact.json (format 2) of the page, with dir: its folder from the export root.
  const pageRecord = (extra = {}) => ({
    format: 2, uuid: PAGE_U, shortId: shortOf(PAGE_U), dir: 'artifacts/Guide_X', title: 'Guide', listed: true, current: 'ver2',
    versions: {
      ver0: { folder: null, files: [{ path: 'index.html', savedAs: null }], start: 'index.html', startSaved: null, sameAs: { 'index.html': 'c/artefacts/guide.html' }, publishedIn: [] },
      ver1: { folder: 'ver1', files: [{ path: 'index.html', savedAs: 'index.html' }], start: 'index.html', startSaved: 'index.html', publishedIn: [] },
      ver2: { folder: 'ver2', files: [{ path: 'index.html', savedAs: 'index.html' }], start: 'index.html', startSaved: 'index.html', publishedIn: [] },
    },
    ...extra,
  });

  test("an artifact's view carries every version of its record, each with the chat copy that holds its text", () => {
    const chat = built(pubChain(2), { published: [pageEntry([pubVersion(0), pubVersion(1)])] });
    const data = buildViewerData([chat], { artifacts: { views: [{ ...pubView, ver: 'ver2' }], records: [pageRecord()], listed: 1, exported: 'e', since: null, listFetched: true } });
    const fileId = Object.keys(data.chats[0].files)[0];
    assert.strictEqual(data.artifacts[0].listed, true);
    assert.deepStrictEqual(data.artifacts[0].versions, [
      { ver: 'ver0', label: 'v1', folder: null, start: 'index.html', startSaved: 'c/artefacts/guide.html', same: true, current: false, copy: { chat: 0, file: fileId, version: 0 } },
      { ver: 'ver1', label: 'v2', folder: 'artifacts/Guide_X/ver1', start: 'index.html', startSaved: 'index.html', same: false, current: false, copy: { chat: 0, file: fileId, version: 1 } },
      { ver: 'ver2', label: 'v3', folder: 'artifacts/Guide_X/ver2', start: 'index.html', startSaved: 'index.html', same: false, current: true, copy: null },
    ]);
    assert.strictEqual(data.listFetched, true);
    // No record: no versions.
    assert.deepStrictEqual(buildViewerData([chat], { artifacts: { views: [pubView], listed: 1, exported: 'e', since: null } }).artifacts[0].versions, []);
  });

  test("versions follow the record's versionOrder, not its object's key order (a numeric-looking id would go first)", () => {
    const rec = pageRecord({ current: '7', versionOrder: ['ver1', '7', 'ver0'] });
    rec.versions = { ver0: rec.versions.ver0, 7: rec.versions.ver2, ver1: rec.versions.ver1 };
    assert.deepStrictEqual(Object.keys(rec.versions), ['7', 'ver0', 'ver1']);
    const got = buildViewerData([], { artifacts: { views: [pubView], records: [rec], listFetched: true } }).artifacts[0].versions;
    assert.deepStrictEqual(got.map(e => [e.ver, e.label, e.current]), [['ver1', 'v1', false], ['7', 'v2', true], ['ver0', 'v3', false]]);
    // A key missing from versionOrder comes after; one in it but not in versions is skipped.
    const partial = buildViewerData([], { artifacts: { views: [pubView], records: [{ ...rec, versionOrder: ['ver0', 'gone'] }], listFetched: true } }).artifacts[0].versions;
    assert.deepStrictEqual(partial.map(e => e.ver), ['ver0', '7', 'ver1']);
  });

  test('an unlisted artifact stays off All / Yours / Shared, and a published card of it has no Open artifact', () => {
    const chat = built(pubChain(1), { published: [pageEntry([pubVersion(0)])] });
    const data = buildViewerData([chat], { artifacts: { views: [pubView], records: [pageRecord({ listed: false })], listed: 0, exported: 'e', since: null, listFetched: true } });
    assert.strictEqual(data.artifacts[0].listed, false);
    assert.ok(Object.values(data.chats[0].files).every(f => !('artifact' in f)));
    assert.deepStrictEqual(artifactTabs(data.artifacts, 'all', ''), []);
    assert.deepStrictEqual(artifactTabs(data.artifacts, 'yours', ''), []);
  });

  test("claude.ai's list not fetched: the data has the screen's keys and listFetched false, and the entry shows for In chats files", () => {
    const { artifactsEntry } = require('../viewer/viewer-logic.js');
    const chat = built(pubChain(1), { published: [pageEntry([pubVersion(0)])] });
    const data = buildViewerData([chat], { artifacts: { views: [], records: [pageRecord({ listed: false })], listed: null, exported: 'e', since: null, listFetched: false } });
    assert.deepStrictEqual([data.artifacts, data.listFetched, data.storeCount], [[], false, 1]);
    // An artifact folder, listed or not, shows the entry; the published card is no In chats file.
    assert.deepStrictEqual(artifactsEntry(data), { show: true, count: 1 });
    assert.deepStrictEqual(artifactsEntry({ ...data, storeCount: 0 }), { show: false, count: 0 });
    // A file Claude made shows it too, counted before the folders.
    const made = { ...data, storeCount: 0, chats: [{ ...data.chats[0], files: { ...data.chats[0].files, f1: { name: 'a.md', kind: 'md', versions: [{ label: 'v1', text: '# a', href: 'c/artefacts/a.md' }] }, f2: { name: 'b.md', kind: 'md', versions: [{ label: 'v1', text: '# b', href: 'c/artefacts/b.md' }] } } }] };
    assert.deepStrictEqual(artifactsEntry(made), { show: true, count: 2 });
    assert.deepStrictEqual(artifactsEntry({ ...made, storeCount: 3 }), { show: true, count: 2 });
    // Listed views count; unlisted ones don't.
    assert.deepStrictEqual(artifactsEntry({ chats: [], artifacts: [{ id: 'A' }, { id: 'B', listed: false }] }), { show: true, count: 1 });
    // A viewer without the screen (a single chat's) never shows it.
    assert.deepStrictEqual(artifactsEntry({ chats: made.chats, storeCount: 2 }), { show: false, count: 0 });
  });

  test('no artifacts: the data has no artifacts key and chats are unchanged', () => {
    const chat = built(pubChat(), { published: [pageEntry([pubVersion(0)])] });
    const plain = buildViewerData([chat], { exported: 'x' });
    assert.deepStrictEqual(Object.keys(plain), ['exported', 'chats', 'projects']);
    assert.strictEqual(JSON.stringify(plain), JSON.stringify({ exported: 'x', chats: [JSON.parse(JSON.stringify(chat))], projects: [] }));
    assert.deepStrictEqual(Object.keys(buildViewerData([chat], { exported: 'x', artifacts: { views: [], listed: 0, exported: 'e', since: null } })), ['exported', 'chats', 'projects']);
    assert.ok(Object.values(plain.chats[0].files).every(f => !('artifact' in f)));
  });

  test('files Claude made carry madeAt, the message of their last version', () => {
    const chat = buildViewerChat(fixture, ctxFor(fixture));
    const report = Object.values(chat.files).find(f => f.name === 'report.html');
    assert.strictEqual(report.madeAt, 'm06');
    const doc = Object.values(built(docChat('d', 'T')).files)[0];
    assert.strictEqual(doc.madeAt, 'da');
    const pub = Object.values(built(pubChat(), { published: [pageEntry([pubVersion(0)])] }).files)[0];
    assert.ok(!('madeAt' in pub), 'a published page card has none');
  });

  test('part numbers continue after the artifact parts', () => {
    const big = 'x'.repeat(70 * 1024);
    const chat = { id: 'c', title: 'c', updated: 'u', messages: [{ id: 'm', sender: 'human', blocks: [], uploads: [{ name: 'a.md', href: 'uploads/a.md', text: big }], attachments: [] }], files: {} };
    const data = buildViewerData([chat], { artifacts: { views: [view('A', { part: 1, key: 'a0' })], listed: 1, exported: 'e', since: null } });
    const { data: out, parts } = V.moveUploadText(data, { firstPart: 3 });
    assert.deepStrictEqual(parts.map(p => p.name), ['part-0003.js']);
    assert.strictEqual(out.chats[0].messages[0].uploads[0].part, 3);
    assert.strictEqual(out.chats[0].messages[0].uploads[0].key, 'u0');
    assert.deepStrictEqual(out.artifacts, data.artifacts);
  });
}

// ---- In chats: the files Claude made, across the export's chats ----
{
  const { inChatsFiles, alsoInChat, fileKindGroup, parseInChatsHash, formatInChatsHash, chatFileTexts, artifactSourceLine, artifactLinkGroups, flagNote } = require('../viewer/viewer-logic.js');
  const ver = (href, extra = {}) => ({ label: '', text: 'x', href, ...extra });
  const msg = (id, at) => ({ id, parent: null, sender: 'assistant', at, blocks: [], uploads: [], attachments: [] });
  const inChatsData = () => ({
    chats: [
      {
        id: 'c0', title: 'Older chat', updated: '2026-05-02T00:00:00Z',
        messages: [msg('m1', '2026-05-01T10:00:00Z'), msg('m2', '2026-05-01T11:00:00Z')],
        files: {
          a1: { name: 'early.html', kind: 'html', versions: [ver('C0/artefacts/early.html')], madeAt: 'm1' },
          a2: { name: 'later.py', kind: 'code', versions: [ver('C0/artefacts/later.py')], madeAt: 'm2' },
          a3: { name: 'gone.txt', kind: 'missing', versions: [{ label: '', text: null, href: null }] },
          a4: { name: 'Guide', kind: 'html', published: { url: 'u', current: true }, artifact: 'Art1', versions: [ver('C0/artefacts/guide.html', { same: true, ver: 'G1' })] },
          a5: { name: 'guide.html', kind: 'html', versions: [ver('C0/artefacts/guide.html')], madeAt: 'm2' },
          a6: { name: 'attached.csv', kind: 'code', versions: [ver('C0/artefacts/attached.csv')] },
        },
      },
      {
        id: 'c1', title: 'Newer chat', updated: '2026-06-02T00:00:00Z',
        messages: [msg('n1', '2026-06-01T10:00:00Z'), msg('n2', 'not a date')],
        files: {
          a1: { name: 'chart.svg', kind: 'svg', versions: [ver('C1/artefacts/chart_v1.svg'), ver('C1/artefacts/chart_v2.svg')], madeAt: 'n1' },
          // A page published at v1 whose file changed afterwards: listed, with the artifact named.
          a2: { name: 'deck.html', kind: 'html', versions: [ver('C1/artefacts/deck_v1.html'), ver('C1/artefacts/deck_v2.html')], madeAt: 'n1' },
          a3: { name: 'Deck', kind: 'html', published: { url: 'u', current: true }, artifact: 'Art2', versions: [ver('C1/artefacts/deck_v1.html', { same: true, ver: 'D1' })] },
          // The same source of a page that isn't in the export's artifacts: listed.
          a4: { name: 'Solo', kind: 'html', published: { url: 'u', current: true }, versions: [ver('C1/artefacts/solo.html', { same: true })] },
          a5: { name: 'solo.html', kind: 'html', versions: [ver('C1/artefacts/solo.html')], madeAt: 'n2' },
          a6: { name: 'Flow', kind: 'html', widget: true, versions: [ver(null)], madeAt: 'n1' },
          a7: { name: 'notes.md', kind: 'md', versions: [ver('C1/artefacts/notes.md')], madeAt: 'n1' },
        },
      },
    ],
    artifacts: [{ id: 'Art1', title: 'Guide', ver: 'G1' }, { id: 'Art2', title: 'Deck', ver: 'D2' }],
  });

  test('inChatsFiles: newest first by the message that made the last version, then the undated by chat order', () => {
    const got = inChatsFiles(inChatsData());
    // A message with no usable date stands in with its chat's update (2026-06-02), the newest time here; equal times go by name.
    assert.deepStrictEqual(got.map(f => f.name), ['solo.html', 'chart.svg', 'deck.html', 'Flow', 'notes.md', 'later.py', 'early.html', 'attached.csv']);
    const deck = got.find(f => f.name === 'deck.html');
    assert.deepStrictEqual({ chat: deck.chat, file: deck.file, kind: deck.kind, madeAt: deck.madeAt, versions: deck.versions.length, alsoArtifact: deck.alsoArtifact },
      { chat: 1, file: 'a2', kind: 'page', madeAt: 'n1', versions: 2, alsoArtifact: 'Art2' });
    assert.strictEqual(got.find(f => f.name === 'solo.html').alsoArtifact, null);
    assert.strictEqual(got.find(f => f.name === 'attached.csv').madeAt, null);
  });

  test('inChatsFiles leaves out missing files, published cards and the same source of a page in the artifacts', () => {
    const names = inChatsFiles(inChatsData()).map(f => f.name);
    for (const left of ['gone.txt', 'Guide', 'guide.html', 'Deck', 'Solo']) assert.ok(!names.includes(left), left);
    assert.deepStrictEqual([...alsoInChat(inChatsData())], ['Art1']);
    // Without that artifact in the export, the source is listed and nothing is "also in chat".
    const data = inChatsData();
    data.artifacts = data.artifacts.filter(v => v.id !== 'Art1');
    assert.ok(inChatsFiles(data).some(f => f.name === 'guide.html'));
    assert.deepStrictEqual([...alsoInChat(data)], []);
  });

  test("inChatsFiles hides a page's source only when the same publish is the artifact's current version", () => {
    // Guide was published the same as guide.html at G1; the artifact is now at G2: the file is listed, naming it.
    const data = inChatsData();
    data.artifacts[0].ver = 'G2';
    const guide = inChatsFiles(data).find(f => f.name === 'guide.html');
    assert.ok(guide, 'listed');
    assert.strictEqual(guide.alsoArtifact, 'Art1');
    assert.deepStrictEqual([...alsoInChat(data)], []);
    // A version with no ver, or an artifact with none, never counts as the current one.
    const nover = inChatsData();
    delete nover.chats[0].files.a4.versions[0].ver;
    assert.ok(inChatsFiles(nover).some(f => f.name === 'guide.html'));
    const noArtVer = inChatsData();
    delete noArtVer.artifacts[0].ver;
    assert.deepStrictEqual([...alsoInChat(noArtVer)], []);
  });

  test('inChatsFiles: uploads and pasted text are never listed, and odd data lists nothing', () => {
    const data = inChatsData();
    data.chats[0].messages[0].uploads = [{ name: 'up.pdf', href: 'C0/uploads/up.pdf', text: null }];
    data.chats[0].messages[0].attachments = [{ name: 'paste.txt', text: 'pasted' }];
    const names = inChatsFiles(data).map(f => f.name);
    assert.ok(!names.includes('up.pdf') && !names.includes('paste.txt'));
    assert.deepStrictEqual(inChatsFiles({}), []);
    assert.deepStrictEqual(inChatsFiles({ chats: [null, { files: { a1: null, a2: { name: 'v.txt', versions: [] } } }] }), []);
    assert.deepStrictEqual([...alsoInChat({ chats: [] })], []);
  });

  test('fileKindGroup', () => {
    const cases = [
      [['index.html', 'html'], 'page'], [['old.HTM', 'html'], 'page'],
      [['notes.md', 'md'], 'doc'], [['Plan', 'md', 'doc:node-1'], 'doc'],
      [['chart.svg', 'svg'], 'diagram'], [['Flow.html', 'html', 'widget:Flow'], 'diagram'], [['Flow.svg', 'svg', 'x:m:widget:Flow'], 'diagram'],
      [['a.py', 'code'], 'code'], [['App.jsx', 'react'], 'code'], [['big.js', 'binary'], 'code'], [['data.csv', 'code'], 'code'],
      [['photo.png', 'image'], 'other'], [['report.pdf', 'pdf'], 'other'], [['blob', 'binary'], 'other'], [['flow.mmd', 'mermaid'], 'other'],
    ];
    for (const [args, want] of cases) assert.strictEqual(fileKindGroup(...args), want, args.join(' '));
  });

  test('parseInChatsHash and formatInChatsHash', () => {
    assert.deepStrictEqual(parseInChatsHash('#ac=3.a12'), { chat: 3, file: 'a12' });
    assert.deepStrictEqual(parseInChatsHash('#ac=0.x:m_1-2'), { chat: 0, file: 'x:m_1-2' });
    for (const h of ['#ac=', '#ac=1', '#ac=a.a1', '#ac=1234567.a1', '#ac=1.', '#ac=1.a/b', '#ac=1.' + 'a'.repeat(129), '#a=abc', '#chat=x&ac=1.a1', ' #ac=1.a1', null, undefined]) {
      assert.strictEqual(parseInChatsHash(h), null, String(h));
    }
    assert.strictEqual(formatInChatsHash(3, 'a12'), '#ac=3.a12');
    for (const [c, f] of [[-1, 'a1'], [1.5, 'a1'], ['1', 'a1'], [1, 'a<b'], [1, '']]) assert.strictEqual(formatInChatsHash(c, f), null, `${c} ${f}`);
  });

  test('artifactSourceLine: linked chats, else shared, else Cowork or Code', () => {
    assert.strictEqual(artifactSourceLine({ links: [{ chat: 0, how: 'made' }] }), '💬 1 chat');
    assert.strictEqual(artifactSourceLine({ links: [{ chat: 0, how: 'made' }, { chat: 0, how: 'edited' }, { chat: 2, how: 'published' }], shared: true }), '💬 2 chats');
    assert.strictEqual(artifactSourceLine({ links: [], shared: true, sourceSurface: 'cowork' }), 'Shared with you');
    assert.strictEqual(artifactSourceLine({ links: [], sourceSurface: 'cowork' }), 'Cowork');
    assert.strictEqual(artifactSourceLine({ sourceSurface: 'code' }), 'Code');
    assert.strictEqual(artifactSourceLine({ sourceSurface: 'chat' }), '');
    assert.strictEqual(artifactSourceLine({ links: [{ chat: 'x' }, null] }), '');
  });

  test('artifactLinkGroups: Made in, Published in, Edited in; each chat once, at its first message; missing chats skipped', () => {
    const chats = [{ title: 'A' }, { title: 'B' }];
    const view = { links: [
      { chat: 1, messageUuid: 'b1', how: 'edited' }, { chat: 0, messageUuid: 'a1', how: 'published' }, { chat: 0, messageUuid: 'a2', how: 'published' },
      { chat: 1, messageUuid: 'b2', how: 'made' }, { chat: 0, messageUuid: 'a3', how: 'edited' }, { chat: 5, messageUuid: 'z', how: 'made' }, { chat: 0, how: 'opened' },
    ] };
    assert.deepStrictEqual(artifactLinkGroups(view, chats), [
      { how: 'made', label: 'Made in', chats: [{ chat: 1, messageUuid: 'b2' }] },
      { how: 'published', label: 'Published in', chats: [{ chat: 0, messageUuid: 'a1' }] },
      { how: 'edited', label: 'Edited in', chats: [{ chat: 1, messageUuid: 'b1' }, { chat: 0, messageUuid: 'a3' }] },
    ]);
    assert.deepStrictEqual(artifactLinkGroups({}, chats), []);
  });

  test("flagNote: the chat viewer's may-not-match wording", () => {
    assert.ok(/may not match/.test(flagNote({ flag: 'script' })) && /replay_bash\.py/.test(flagNote({ flag: 'script' })));
    assert.strictEqual(flagNote({ flag: 'odd' }), flagNote({ flag: 'edit' }));
    assert.strictEqual(flagNote({}), '');
    assert.strictEqual(flagNote(null), '');
  });

  test('chatFileTexts: the newest text of the last file with each name', () => {
    const texts = chatFileTexts({ files: { a1: { name: 's.css', versions: [{ text: 'old' }, { text: 'new' }, { text: null }] }, a2: { name: 'b.js', versions: [{ text: null }] } } });
    assert.deepStrictEqual([...texts], [['s.css', 'new']]);
    assert.deepStrictEqual([...chatFileTexts(null)], []);
  });
}

// ---- Download (v1.19): a file's bytes the viewer holds, saved under a clean name ----
const { downloadName, dataUrlBytes } = require('../viewer/viewer-logic.js');

test('downloadName keeps the last path segment, cleaned', () => {
  assert.strictEqual(downloadName('dir/a:b?.html'), 'a_b_.html');
  assert.strictEqual(downloadName('report_v2.html'), 'report_v2.html');
  assert.strictEqual(downloadName('a\\b\\c<d>|e*.txt'), 'c_d__e_.txt');
  assert.strictEqual(downloadName('x\u0000y\u001f.md'), 'x_y_.md');
  for (const bad of ['..', '.', '', '   ', 'dir/', null, undefined]) assert.strictEqual(downloadName(bad), 'download', String(bad));
  assert.strictEqual(downloadName(' .hidden. '), 'hidden');
  const long = downloadName(`${'a'.repeat(300)}.html`);
  assert.ok(long.length <= 200 && long.endsWith('.html'), long);
  assert.strictEqual(downloadName('Über café.svg'), 'Über café.svg');
});

test('dataUrlBytes decodes a base64 data URL, and nothing else', () => {
  const bytes = dataUrlBytes('data:image/png;base64,iVBORw0KGgo=');
  assert.deepStrictEqual([...bytes.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  for (const bad of ['https://x/y.png', 'data:image/png,plain', 'data:image/png;base64,***', '', null]) assert.strictEqual(dataUrlBytes(bad), null, String(bad));
});

// ---- v1.20: a Design artifact's canvas from project/canvas.json ----
const { designCanvas, boardFlags, noteFill, DESIGN_BOARD_MAX } = require('../viewer/viewer-logic.js');
const SAMPLE_CANVAS = {
  v: 3, title: 'Panel mockups',
  boards: { 'Main.dc.html': { x: 0, y: 0, w: 380, h: 720, title: 'Home A' }, 'HomeB.dc.html': { x: 460, y: 0, w: 380, h: 720, title: 'Home B' } },
  notes: { t: { kind: 'title1', text: 'Section heading', x: 0, y: -120, maxW: 2420 }, n1: { fill: 'teal', text: 'A sticky note.', x: 0, y: 900, w: 420 } },
  noteOrder: ['t', 'n1'],
};
const heldAll = () => true;

test('designCanvas lays out boards and notes', () => {
  const c = designCanvas(JSON.stringify(SAMPLE_CANVAS), p => p !== 'project/HomeB.dc.html');
  assert.strictEqual(c.title, 'Panel mockups');
  assert.deepStrictEqual(c.boards.map(b => [b.name, b.path, b.x, b.y, b.w, b.h, b.title, b.held]),
    [['Main.dc.html', 'project/Main.dc.html', 0, 120, 380, 720, 'Home A', true], ['HomeB.dc.html', 'project/HomeB.dc.html', 460, 120, 380, 720, 'Home B', false]]);
  assert.deepStrictEqual(c.notes.map(n => [n.id, n.text, n.x, n.y, n.w, n.fill, n.heading]),
    [['t', 'Section heading', 0, 0, 2420, 'grey', true], ['n1', 'A sticky note.', 0, 1020, 420, 'teal', false]]);
  assert.strictEqual(c.width, 2420);
  assert.strictEqual(c.height, 1020 + 200);
  assert.deepStrictEqual(c.skipped, []);
});

test('designCanvas refuses bad input', () => {
  for (const bad of ['not json', '[]', '{}', '{"boards":[]}', '{"boards":null}', JSON.stringify({ boards: { 'Main.dc.html': { x: 0, y: 0, w: 1, h: 1 } } }).replace('Main', '../Main')]) {
    assert.strictEqual(designCanvas(bad, heldAll), null, bad);
  }
  assert.strictEqual(designCanvas(JSON.stringify(SAMPLE_CANVAS), () => false), null, 'no board held');
  const odd = { boards: {
    'Main.dc.html': { x: 0, y: 0, w: 10, h: 10, title: 'ok' }, '../x.dc.html': { x: 0, y: 0, w: 1, h: 1 }, 'a/b.dc.html': { x: 0, y: 0, w: 1, h: 1 },
    'a\\b.dc.html': { x: 0, y: 0, w: 1, h: 1 }, 'x.html': { x: 0, y: 0, w: 1, h: 1 }, 'Bad.dc.html': { x: 'NaN', y: 0, w: 1, h: 1, title: 'Bad' },
  } };
  const text = JSON.stringify(odd).replace('"x.html"', '"__proto__":{"x":0,"y":0,"w":1,"h":1},"x.html"');
  const c = designCanvas(text, heldAll);
  assert.deepStrictEqual(c.boards.map(b => b.name), ['Main.dc.html']);
  assert.deepStrictEqual(c.skipped, [{ name: 'Bad.dc.html', title: 'Bad' }]);
  const many = { boards: Object.fromEntries(Array.from({ length: DESIGN_BOARD_MAX + 1 }, (_, i) => [`B${i}.dc.html`, { x: i * 10, y: 0, w: 5, h: 5, title: `B${i}` }])) };
  const m = designCanvas(JSON.stringify(many), heldAll);
  assert.deepStrictEqual([m.boards.length, m.skipped.map(s => s.name)], [60, [`B${DESIGN_BOARD_MAX}.dc.html`]]);
  const notes = designCanvas(JSON.stringify({ boards: SAMPLE_CANVAS.boards, notes: { b: { text: 'B', x: 0, y: 0 }, a: { text: 'A', x: 0, y: 0 }, z: { text: 'Z', x: 'no', y: 0 } }, noteOrder: ['b'] }), heldAll);
  assert.deepStrictEqual(notes.notes.map(n => [n.id, n.w]), [['b', 320], ['a', 320]]);
});

test('boardFlags', () => {
  assert.deepStrictEqual(boardFlags('<p>{{a}}</p>'), { templated: true, blobs: false });
  assert.deepStrictEqual(boardFlags('<sc-for each="x">'), { templated: true, blobs: false });
  assert.deepStrictEqual(boardFlags('<dc-import src="a">'), { templated: true, blobs: false });
  assert.deepStrictEqual(boardFlags('<img src="/_blob/1">'), { templated: false, blobs: true });
  assert.deepStrictEqual(boardFlags('<p>plain</p>'), { templated: false, blobs: false });
  assert.deepStrictEqual(boardFlags(null), { templated: false, blobs: false });
});

test('noteFill', () => {
  for (const f of ['teal', 'orange', 'yellow', 'green', 'blue', 'pink', 'purple', 'red']) assert.strictEqual(noteFill(f), f);
  for (const f of ['magenta', null, undefined, 3, 'TEAL ']) assert.strictEqual(noteFill(f), 'grey', String(f));
});

// ---- v1.20.1: outliers don't collapse the canvas ----
const { canvasScale, DESIGN_COORD_MAX, DESIGN_SIZE_MAX } = require('../viewer/viewer-logic.js');

test('designCanvas skips boards and notes placed or sized out of range', () => {
  const c = designCanvas(JSON.stringify({
    boards: {
      'Main.dc.html': { x: 0, y: 0, w: 300, h: 200, title: 'ok' },
      'Far.dc.html': { x: 1e9, y: 0, w: 300, h: 200, title: 'far' },
      'Huge.dc.html': { x: 0, y: 0, w: 1e308, h: 1e308, title: 'huge' },
      'Neg.dc.html': { x: -(DESIGN_COORD_MAX + 1), y: 0, w: 10, h: 10, title: 'neg' },
    },
    notes: { a: { text: 'near', x: 10, y: 10 }, b: { text: 'far', x: 0, y: 1e12 }, c: { text: 'wide', x: 0, y: 0, w: DESIGN_SIZE_MAX + 1 } },
  }), () => true);
  assert.deepStrictEqual(c.boards.map(b => b.name), ['Main.dc.html']);
  assert.deepStrictEqual(c.skipped.map(s => s.title), ['far', 'huge', 'neg']);
  assert.deepStrictEqual(c.notes.map(n => n.id), ['a']);
  assert.ok(Number.isFinite(c.width) && Number.isFinite(c.height) && c.width === 330, JSON.stringify([c.width, c.height]));
});

test('canvasScale fits the width, never above 1 or below 0.1', () => {
  assert.strictEqual(canvasScale(500, 1000), 1);
  assert.strictEqual(canvasScale(2000, 1000), 0.5);
  assert.strictEqual(canvasScale(1e6, 1000), 0.1);
  for (const bad of [0, -1, NaN, Infinity]) assert.strictEqual(canvasScale(bad, 1000), 1, String(bad));
});

test('a heading note takes its maxW, a sticky note its w', () => {
  const c = designCanvas(JSON.stringify({ boards: SAMPLE_CANVAS.boards, notes: {
    t: { kind: 'title1', text: 'Heading', x: 0, y: 0, w: 240, maxW: 2420 },
    n: { text: 'Sticky', x: 0, y: 900, w: 420, maxW: 2000 },
  } }), heldAll);
  assert.deepStrictEqual(c.notes.map(n => [n.id, n.w]), [['t', 2420], ['n', 420]]);
});
