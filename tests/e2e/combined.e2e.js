// An Export All viewer.html with artifacts, over file:// in Chromium: the chat viewer with the Artifacts screen.
// The sidebar's Artifacts entry with its count; the screen in place of the chat, with the grid and its tabs; a card
// opens #a=<id> with the sandboxed preview, inside its guard frame; Back and the home button return to the grid; a
// chat in the sidebar still opens, and history goes back and forth; / searches the artifacts on their screen; a
// reused page links its file in published/. The In chats tab: a card per file Claude made (not the one a chat
// published as an artifact), kind chips with counts, search by name, a file page at #ac=<chat>.<file> previewed in the
// guard frame with only its own chat's stylesheet and scripts, Made in opening the chat, and the version menu; a file
// that may not match says so. Links: the All cards' source line and "also in chat", an artifact page's Made in /
// Published in / Edited in (each opening its chat at the message, Back returning) and its menu of the versions chats
// published, a Docs artifact's text rebuilt from its chat, Open artifact on a chat's published card, the heading of an
// Export Changes run, and a run not unzipped (tiles, "unzip first"). A hostile shared artifact gets nothing out and can't reach the viewer,
// and navigations to file: (an export file, an absolute path, a refresh, a link) are refused; data: and blob: are
// refused by the guard frame's own frame-src 'none', which the page's policy doesn't have. An export with the
// setting off has no Artifacts entry. No requests outside file:, no page errors.
// Run: PW=<playwright-core> CHROME_EXE=<chrome> node tests/e2e/combined.e2e.js
const { chromium } = require(process.env.PW);
const fs = require('fs'), os = require('os'), path = require('path'), vm = require('vm');
const { exportPopup, assetRoutes, publishedFetcher, docTools, DOC_U } = require('../helpers');
const { ATTACKS, ATTACK_ENDS, hostileHtml, navArtifact } = require('./hostile');
const { uuidToBase58 } = require('../../export-core.js');

const LIVE = '1794783850-4a6e';
const U = n => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const p = n => uuidToBase58(U(n));
const at = n => `2026-05-01T10:${String(n).padStart(2, '0')}:00Z`;
const art = (slug, title, extra = {}) => ({ slug, title, typeSlug: '', typeTitle: '', sourceSurface: 'chat', rel: 'mine', live: LIVE, updatedAt: at(30), createdAt: at(1), ...extra });
const live = (title, files) => ({ title, live: LIVE, versions: { [LIVE]: { files } } });
const msg = (uuid, parent, sender, n, content) => ({ uuid, parent_message_uuid: parent, sender, created_at: at(n), content, attachments: [], files: [], files_v2: [] });
const PUB = 'mcp__claude-artifacts__publish_files';
const EDIT = 'mcp__claude-artifacts__edit_version';
const DOCS_TYPE = 'c8f0b311-af6a-4d22-a07b-61eb818fc35d';
const OLD1 = '1794700000-0a01', OLD2 = '1794700001-0a02', LIVE2 = '1794799999-0b02';
const editVersion = (id, slug) => [
  { type: 'tool_use', id, name: EDIT, input: { slug, base_version: LIVE, edits: [], label: 'tweak' } },
  { type: 'tool_result', tool_use_id: id, name: EDIT, content: [{ type: 'text', text: 'ok' }] },
];
const publish = (id, slug, version, source) => [
  { type: 'tool_use', id, name: PUB, input: { title: 'Guide page', files: [{ as: 'index.html', path: source }] } },
  { type: 'tool_result', tool_use_id: id, name: PUB, content: [{ type: 'text', text: JSON.stringify({ slug, version, url: `https://claude.ai/artifact/${uuidToBase58(slug)}`, title: 'Guide page' }) }] },
];

// A chat that only talks, and one that writes a page and publishes it as artifact U(9).
const plainChat = {
  uuid: 'chat-plain', name: 'Plain talk', model: 'claude-x', created_at: at(1), updated_at: at(2), settings: {}, current_leaf_message_uuid: 'pa1',
  chat_messages: [msg('ph1', null, 'human', 1, [{ type: 'text', text: 'hello there' }]), msg('pa1', 'ph1', 'assistant', 2, [...editVersion('pe', U(1)), { type: 'text', text: 'Hi, plain reply.' }])],
};
// The pages say what they see on the console, twice: a line from a frame this new can be missed, one a moment later
// is not.
const GUIDE = '<!doctype html><h1 id="t">Guide written</h1><script>const say = () => console.log(\'REUSED \' + document.getElementById(\'t\').textContent); say(); setTimeout(say, 120);</script>';
const pubChat = {
  uuid: 'chat-pub', name: 'Publishing', model: 'claude-x', created_at: at(3), updated_at: at(6), settings: {}, current_leaf_message_uuid: 'qa1',
  chat_messages: [
    msg('qh1', null, 'human', 3, [{ type: 'text', text: 'make a guide' }]),
    msg('qa1', 'qh1', 'assistant', 4, [
      { type: 'tool_use', id: 'w', name: 'Write', input: { file_path: '/home/claude/guide.html', content: GUIDE } },
      { type: 'tool_result', tool_use_id: 'w', name: 'Write', content: [{ type: 'text', text: 'ok' }] },
      { type: 'tool_use', id: 'pb', name: PUB, input: { title: 'Guide', files: [{ as: 'index.html', path: '/home/claude/guide.html' }] } },
      { type: 'tool_result', tool_use_id: 'pb', name: PUB, content: [{ type: 'text', text: JSON.stringify({ slug: U(9), version: LIVE, url: `https://claude.ai/artifact/${p(9)}`, title: 'Guide' }) }] },
      { type: 'text', text: 'Published it.' },
    ]),
  ],
};
// A chat that makes files of every kind the In chats tab shows: a page with its own stylesheet (and a script that
// only another chat has), Markdown, a diagram in two versions, code, and Markdown too large for the page (a part).
const PAGE = '<!doctype html><link rel="stylesheet" href="style.css"><script src="other.js"></script><h1 id="t">Made page</h1>'
  + "<script>const say = () => console.log('MADE ' + [getComputedStyle(document.getElementById('t')).color, self.origin, typeof window.OTHER, document.querySelector('meta[http-equiv]').content.split(';')[0]].join(' | ')); say(); setTimeout(say, 120);</script>";
const BIG = '# Big doc\n\n' + 'Long text. '.repeat(7000);
const write = (id, name, content) => [
  { type: 'tool_use', id, name: 'Write', input: { file_path: `/mnt/user-data/outputs/${name}`, content } },
  { type: 'tool_result', tool_use_id: id, name: 'Write', content: [{ type: 'text', text: 'ok' }] },
];
const makeChat = {
  uuid: 'chat-make', name: 'Making files', model: 'claude-x', created_at: at(7), updated_at: at(13), settings: {}, current_leaf_message_uuid: 'ma2',
  chat_messages: [
    msg('mh1', null, 'human', 7, [{ type: 'text', text: 'make files' }]),
    msg('ma1', 'mh1', 'assistant', 8, [
      ...write('w1', 'notes.md', '# Notes\n\nSome **bold** text.\n\n<script>console.log("MD SCRIPT")</script>'),
      { type: 'tool_use', id: 'c1', name: 'create_file', input: { path: '/home/claude/chart.svg', file_text: '<svg xmlns="http://www.w3.org/2000/svg"><circle r="5"/><!--V1--></svg>' } },
      { type: 'tool_result', tool_use_id: 'c1', name: 'create_file', content: [{ type: 'text', text: 'ok' }] },
      ...write('w2', 'page.html', PAGE),
      ...write('w3', 'style.css', 'h1#t { color: rgb(4, 5, 6); }'),
      ...write('w4', 'tool.py', 'print("made in a chat")\n'),
      { type: 'text', text: 'Made them.' },
    ]),
    msg('mh2', 'ma1', 'human', 9, [{ type: 'text', text: 'change the chart' }]),
    msg('ma2', 'mh2', 'assistant', 10, [
      { type: 'tool_use', id: 'e1', name: 'str_replace', input: { path: '/home/claude/chart.svg', old_str: '<!--V1-->', new_str: '<!--V2-->' } },
      { type: 'tool_result', tool_use_id: 'e1', name: 'str_replace', content: [{ type: 'text', text: 'ok' }] },
      // An edit the export can't replay: tool.py "may not match".
      { type: 'tool_use', id: 'e2', name: 'str_replace', input: { path: '/mnt/user-data/outputs/tool.py', old_str: 'NOT IN THE FILE', new_str: 'x' } },
      { type: 'tool_result', tool_use_id: 'e2', name: 'str_replace', content: [{ type: 'text', text: 'ok' }] },
      ...write('w5', 'big.md', BIG),
      { type: 'text', text: 'Changed it.' },
    ]),
  ],
};
// The publishing chat also writes a script, which the other chat's page names but must never get.
pubChat.chat_messages[1].content.splice(2, 0, ...write('wo', 'other.js', "window.OTHER = 1; console.log('OTHER CHAT LOADED');"));
// A chat that publishes Guide page (U(1)) twice, at older versions than its current one: first exactly the file it
// wrote (same), then a file claude.ai served differently (saved in published/); and edits the page.
const OLDA = '<!doctype html><h1>Old A</h1><!--OLDA-->';
const OLDB = '<!doctype html><h1>Old B served</h1><!--OLDB-->';
const editChat = {
  uuid: 'chat-edit', name: 'Editing', model: 'claude-x', created_at: at(14), updated_at: at(18), settings: {}, current_leaf_message_uuid: 'ea2',
  chat_messages: [
    msg('eh1', null, 'human', 14, [{ type: 'text', text: 'publish the old guide' }]),
    msg('ea1', 'eh1', 'assistant', 15, [
      { type: 'tool_use', id: 'ew1', name: 'Write', input: { file_path: '/home/claude/old.html', content: OLDA } },
      { type: 'tool_result', tool_use_id: 'ew1', name: 'Write', content: [{ type: 'text', text: 'ok' }] },
      ...publish('ep1', U(1), OLD1, '/home/claude/old.html'),
      { type: 'text', text: 'Published the old one.' },
    ]),
    msg('eh2', 'ea1', 'human', 16, [{ type: 'text', text: 'and the new one' }]),
    msg('ea2', 'eh2', 'assistant', 17, [
      { type: 'tool_use', id: 'ew2', name: 'Write', input: { file_path: '/home/claude/new.html', content: '<!doctype html><h1>New as written</h1>' } },
      { type: 'tool_result', tool_use_id: 'ew2', name: 'Write', content: [{ type: 'text', text: 'ok' }] },
      ...publish('ep2', U(1), OLD2, '/home/claude/new.html'),
      ...editVersion('ee', U(1)),
      { type: 'text', text: 'Published and edited.' },
    ]),
  ],
};
// A chat that makes a Claude Docs document, the artifact DOC_U.
const docT = docTools('mcp__Claude_Docs__', { realShape: true });
const docChat = {
  uuid: 'chat-doc', name: 'Docs chat', model: 'claude-x', created_at: at(20), updated_at: at(22), settings: {}, current_leaf_message_uuid: 'da1',
  chat_messages: [
    msg('dh1', null, 'human', 20, [{ type: 'text', text: 'write notes' }]),
    msg('da1', 'dh1', 'assistant', 21, [docT.batch, docT.batchResult, docT.update('du1', 'sess.10', '## Alpha\n\nAlpha text.'), docT.result('du1', '{}'), { type: 'text', text: 'Wrote the doc.' }]),
  ],
};
const chats = { [plainChat.uuid]: plainChat, [pubChat.uuid]: pubChat, [makeChat.uuid]: makeChat, [editChat.uuid]: editChat, [docChat.uuid]: docChat };
const list = Object.values(chats).map(c => ({ uuid: c.uuid, name: c.name, updated_at: c.updated_at }));

// Export All through the popup, with its artifact step: a ZIP (megaFormat zip), unzipped into a new folder.
async function exportAll({ frames, pages, off = false, store = {}, changes = false }) {
  const JSZip = require('../../jszip.min.js');
  const sb = exportPopup({ routes: assetRoutes() }).sandbox;
  const fetcher = publishedFetcher(pages);
  sb.chrome.storage.local.get = async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(k => k in store).map(k => [k, store[k]]));
  sb.chrome.storage.local.set = async (o) => { Object.assign(store, JSON.parse(JSON.stringify(o))); };
  sb.chrome.permissions = { contains: async () => false, request: async () => false };
  sb.chrome.tabs.query = async () => [{ id: 1, url: 'https://claude.ai/chat/x' }];
  sb.chrome.tabs.sendMessage = (id, m, cb) => {
    if (m.action === 'fetchAllConversations') cb({ data: list, orgId: 'org-1' });
    else if (m.action === 'fetchConversation') cb({ data: JSON.parse(JSON.stringify(chats[m.conversationId])) });
    else if (m.action === 'listArtifacts') cb({ frames: JSON.parse(JSON.stringify(frames)) });
    else if (/^publishedPage/.test(m.action)) fetcher.fetch(m).then(cb);
    else cb({});
  };
  sb.JSZip = JSZip;
  sb.Uint8Array = Uint8Array;
  let saved = null;
  sb.download = (blob) => { saved = blob; };
  sb.setTimeout = (f) => setTimeout(f, 0);
  vm.runInContext('orgId = "org-1"', sb);
  if (off) vm.runInContext('settings.exportAllArtifacts = false', sb);
  if (changes) vm.runInContext("settings.megaZipScope = 'changes'", sb);
  await vm.runInContext('bulkExportZip({})', sb);
  if (!saved) throw new Error('no download: ' + sb.document.getElementById('status').textContent);
  const zip = await JSZip.loadAsync(await saved.arrayBuffer());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'combined-'));
  for (const n of Object.keys(zip.files)) {
    if (zip.files[n].dir) continue;
    const fp = path.join(dir, n);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, await zip.file(n).async('nodebuffer'));
  }
  if (!fs.existsSync(path.join(dir, 'viewer.html'))) throw new Error('no viewer.html written');
  const html = fs.readFileSync(path.join(dir, 'viewer.html'), 'utf8');
  const data = JSON.parse(/<script id="data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1].replace(/<\\\//g, '</'));
  return { dir, data };
}

// The navigations, each in an artifact of its own: to a real file of the export (which would say ESCAPED), an
// absolute path, by a refresh, by a link, and to the web.
const navs = dir => [
  ['navfile', `location.href = ${JSON.stringify('file://' + path.join(dir, 'escape.html'))};`],
  ['navabs', "location.href = 'file:///etc/hosts';"],
  ['navrefresh', '', `<meta http-equiv="refresh" content="0;url=${'file://' + path.join(dir, 'escape.html')}">`],
  ['navlink', `const a = document.createElement('a'); a.href = ${JSON.stringify('file://' + path.join(dir, 'escape.html'))}; document.body.append(a); a.click();`],
  ['navhttps', "location.href = 'https://remote.test/nav';"],
  // The page's frame-src file: refuses these too, but only the guard's policy is frame-src 'none'.
  ['navdata', "location.href = 'data:text/html,<script>console.log(%22ESCAPED%22)<\\/script>';"],
  ['navblob', "location.href = URL.createObjectURL(new Blob(['<script>console.log(\"ESCAPED\")<\\/script>'], { type: 'text/html' }));"],
];

(async () => {
  const attacks = { ...ATTACKS, storage: "(localStorage.setItem('k', 'v'), sessionStorage.setItem('s', 'w'), localStorage.getItem('k') + sessionStorage.getItem('s'))" };
  const attackEnds = { ...ATTACK_ENDS, storage: 'gave vw' };
  const frames = [
    art(U(1), 'Guide page', { updatedAt: at(50) }),
    art(U(2), 'Hostile', { rel: 'shared', updatedAt: at(40) }),
    art(U(3), 'Shared deck', { rel: 'shared', updatedAt: at(35) }),
    art(U(9), 'Guide', { updatedAt: at(20) }),
    art(U(5), 'Cowork deck', { sourceSurface: 'cowork', updatedAt: at(33) }),
    art(U(6), 'Code dash', { sourceSurface: 'code', updatedAt: at(32) }),
    art(DOC_U, 'Lorber Notes', { typeSlug: DOCS_TYPE, typeTitle: 'Docs', updatedAt: at(31) }),
    art(U(7), 'Loose doc', { typeSlug: DOCS_TYPE, typeTitle: 'Docs', updatedAt: at(25) }),
  ];
  const pages = {
    [U(1)]: { ...live('Guide page', {
      'index.html': '<!doctype html><link rel="stylesheet" href="app.css"><h1 id="t">Guide page body</h1>'
        + "<script>const say = () => console.log('GUIDE ' + [getComputedStyle(document.getElementById('t')).color, self.origin, document.querySelector('meta[http-equiv]').content.split(';')[0]].join(' | ')); say(); setTimeout(say, 120);</script>",
      'app.css': 'h1#t { color: rgb(1, 2, 3); }',
    }), history: [OLD1, OLD2, LIVE] },
    [U(2)]: live('Hostile', { 'index.html': hostileHtml(attacks) }),
    [U(3)]: live('Shared deck', { 'deck.html': '<h1>Shared page</h1>' }),
    [U(9)]: live('Guide', { 'index.html': GUIDE }),
    [U(5)]: live('Cowork deck', { 'index.html': '<h1>Cowork</h1>' }),
    [U(6)]: live('Code dash', { 'index.html': '<h1>Code</h1>' }),
  };
  pages[U(1)].versions[OLD1] = { files: { 'index.html': OLDA } };
  pages[U(1)].versions[OLD2] = { files: { 'index.html': OLDB } };
  // The navigations need a real file's absolute path in their text, so it's in a folder made ahead of the export.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'combined-nav-'));
  fs.writeFileSync(path.join(base, 'escape.html'), "<!doctype html><script>console.log('ESCAPED')</script>");
  navs(base).forEach(([name, attempt, head], i) => {
    frames.push(art(U(40 + i), name, { rel: 'shared', updatedAt: at(10) }));
    pages[U(40 + i)] = live(name, { 'index.html': navArtifact(name, attempt, head).versions[0] });
  });
  const { dir, data } = await exportAll({ frames, pages });
  const { dir: offDir, data: offData } = await exportAll({ frames, pages, off: true });
  // Export Changes after a full run, where only one artifact changed on claude.ai.
  const store = {};
  await exportAll({ frames, pages, store });
  const changedFrames = frames.map(f => (f.slug === U(3) ? { ...f, live: LIVE2, updatedAt: at(59) } : f));
  const changedPages = { ...pages, [U(3)]: { title: 'Shared deck', live: LIVE2, versions: { [LIVE2]: { files: { 'deck.html': '<h1>Shared page, changed</h1>' } } } } };
  const { dir: changesDir, data: changesData } = await exportAll({ frames: changedFrames, pages: changedPages, store, changes: true });

  // Chrome gives sandboxed frames processes of their own, and Playwright doesn't attach to a sandboxed frame inside
  // another (the preview in its guard frame): its console, requests and frame would go unseen. In one process they
  // are seen; sandbox, origin and policies are the same either way.
  const browser = await chromium.launch({ executablePath: process.env.CHROME_EXE, args: ['--disable-features=IsolateSandboxedIframes'] });
  let failed = 0;
  const check = (n, ok, x = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n} ${ok ? '' : x}`); };

  check('fixture: the viewer data has the artifacts', Array.isArray(data.artifacts) && data.artifacts.length === frames.length, JSON.stringify((data.artifacts || []).map(v => v.title)));
  const reused = (data.artifacts || []).find(v => v.id === p(9));
  check("fixture: the published page is reused from the chat's files", !!reused && reused.reused === true && reused.startSaved === 'Publishing/artefacts/guide.html', JSON.stringify(reused));
  check('fixture: the setting off has no artifacts', !('artifacts' in offData));

  const open = async (folder, hash = '', viewport = { width: 1300, height: 900 }) => {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const seen = { errors: [], requests: [], logs: [], frames: [], popups: 0 };
    page.on('pageerror', e => seen.errors.push(e.message));
    page.on('console', m => seen.logs.push(m.text()));
    page.on('framenavigated', f => { if (f !== page.mainFrame()) seen.frames.push(f.url()); });
    context.on('page', () => { seen.popups++; });
    await context.route('**/*', r => { const u = r.request().url(); if (u.startsWith('file:')) return r.continue(); seen.requests.push(u); return r.abort(); });
    const url = 'file://' + path.join(folder, 'viewer.html');
    await page.goto(url + hash);
    await page.waitForSelector('#side');
    return { page, seen, context, url };
  };
  // The preview's guard frame in the screen, once it holds the artifact's own frame.
  const previewOf = async pv => {
    const guard = await (await pv.page.waitForSelector('#artifacts-screen #page-body .preview iframe', { timeout: 3000 })).contentFrame();
    await guard.waitForSelector('iframe', { timeout: 3000 });
    return guard;
  };
  const waitLog = async (pv, text, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (pv.seen.logs.some(l => l.includes(text))) return true; await pv.page.waitForTimeout(25); } return false; };
  const noOutsideFrames = seen => seen.frames.every(u => !/^(file|https?|data|blob):/i.test(u));
  const shown = async (page, sel) => page.locator(sel).isVisible();

  // ---- The entry and the grid ----
  const v = await open(dir);
  const { page } = v;
  const nav = page.locator('#artifacts-nav');
  check('sidebar: Artifacts entry with the count', await nav.isVisible() && (await nav.locator('.n').textContent()) === String(frames.length), await nav.textContent());
  check('a chat shows first', await shown(page, '#scroll') && !(await shown(page, '#artifacts-screen')));
  await nav.click();
  await page.waitForSelector('#artifacts-screen #grid .card');
  check('the entry shows the screen in place of the chat', await shown(page, '#artifacts-screen') && !(await shown(page, '#scroll')) && !(await shown(page, '#top')));
  check('the entry is current, no chat is', await nav.getAttribute('aria-current') === 'true' && await page.locator('#chat-list .item[aria-current="true"]').count() === 0);
  check('the grid hash', await page.evaluate(() => location.hash) === '#artifacts');
  check('the screen is the artifacts app, in its shadow root', await page.evaluate(() => { const s = document.getElementById('artifacts-screen'); return !!s.shadowRoot && !document.getElementById('grid'); }));
  const tabs = page.locator('#artifacts-screen [role=tablist] [role=tab]');
  check('tabs All / Yours / Shared with you / In chats with its count', JSON.stringify(await tabs.allTextContents()) === JSON.stringify(['All', 'Yours', 'Shared with you', 'In chats 10']), JSON.stringify(await tabs.allTextContents()));
  const titles = () => page.locator('#artifacts-screen #grid .card .title').allTextContents();
  check('cards, newest first', JSON.stringify(await titles()) === JSON.stringify(['Guide page', 'Hostile', 'Shared deck', 'Cowork deck', 'Code dash', 'Lorber Notes', 'Loose doc', 'Guide', ...navs(base).map(n => n[0]).sort()]), JSON.stringify(await titles()));
  await tabs.nth(1).click();
  check('Yours filters', JSON.stringify(await titles()) === JSON.stringify(['Guide page', 'Cowork deck', 'Code dash', 'Lorber Notes', 'Loose doc', 'Guide']), JSON.stringify(await titles()));
  await tabs.nth(2).click();
  check('Shared filters', (await titles()).length === frames.length - 6, JSON.stringify(await titles()));
  await tabs.nth(0).click();
  check('the screen keeps its own look (its CSS, not the chat viewer\'s)', await page.locator('#artifacts-screen #grid').evaluate(g => getComputedStyle(g).display) === 'grid'
    && await page.locator('#artifacts-screen .card').first().evaluate(c => getComputedStyle(c).borderRadius) === '10px');
  check('its CSS stays in it', await page.evaluate(() => getComputedStyle(document.querySelector('#chat-list .item')).borderRadius) === '8px');

  // ---- In chats ----
  const makeIndex = data.chats.findIndex(c => c.title === 'Making files');
  const fileId = name => Object.entries(data.chats[makeIndex].files).find(([, f]) => f.name === name)[0];
  check('kind filters only on In chats', await page.locator('#artifacts-screen #kinds').isHidden());
  await tabs.nth(3).click();
  check('In chats: one card per file Claude made, newest first; the published file is under All', JSON.stringify(await titles()) === JSON.stringify(['Lorber_Notes.md', 'new.html', 'old.html', 'big.md', 'chart.svg', 'notes.md', 'page.html', 'style.css', 'tool.py', 'other.js']), JSON.stringify(await titles()));
  const chips = page.locator('#artifacts-screen #kinds .chip');
  const searchBox = page.locator('#artifacts-screen #search');
  check('In chats: the search says files', await searchBox.getAttribute('placeholder') === 'Search files' && await searchBox.getAttribute('aria-label') === 'Search files');
  check("the published file's source is listed when the same publish isn't the artifact's current version", (await titles()).includes('old.html'));
  check('In chats: kind chips with counts', JSON.stringify(await chips.allTextContents()) === JSON.stringify(['All kinds', 'Pages 3', 'Docs 3', 'Diagrams 1', 'Code 3', 'Other 0']), JSON.stringify(await chips.allTextContents()));
  check('In chats: each card names its chat', JSON.stringify(await page.locator('#artifacts-screen #grid .card .from').allTextContents()) === JSON.stringify(['💬Docs chat', '💬Editing', '💬Editing', ...Array(6).fill('💬Making files'), '💬Publishing']), JSON.stringify(await page.locator('#artifacts-screen #grid .card .from').allTextContents()));
  check('In chats: a file with versions says how many', (await page.locator('#artifacts-screen #grid .card', { hasText: 'chart.svg' }).locator('.versions').textContent()) === '2 versions');
  await chips.nth(2).click();
  check('a chip filters by kind', JSON.stringify(await titles()) === JSON.stringify(['Lorber_Notes.md', 'big.md', 'notes.md']) && await chips.nth(2).getAttribute('aria-pressed') === 'true', JSON.stringify(await titles()));
  await page.locator('#artifacts-screen #search').fill('note');
  check('search and a kind together, the counts follow the search', JSON.stringify(await titles()) === JSON.stringify(['Lorber_Notes.md', 'notes.md']) && JSON.stringify(await chips.allTextContents()) === JSON.stringify(['All kinds', 'Pages 0', 'Docs 2', 'Diagrams 0', 'Code 0', 'Other 0']), JSON.stringify(await chips.allTextContents()));
  await chips.nth(0).click();
  await page.locator('#artifacts-screen #search').fill('.py');
  check('search filters by file name', JSON.stringify(await titles()) === JSON.stringify(['tool.py']), JSON.stringify(await titles()));
  await page.locator('#artifacts-screen #search').fill('');

  // A page: the guarded preview, with its own chat's stylesheet and not another chat's script.
  await page.locator('#artifacts-screen #grid .card', { hasText: 'page.html' }).click();
  await page.waitForSelector('#artifacts-screen #page:not([hidden])');
  check('a file card opens #ac=<chat>.<file>', await page.evaluate(() => location.hash) === `#ac=${makeIndex}.${fileId('page.html')}`, await page.evaluate(() => location.hash));
  check('its title and kind', (await page.locator('#artifacts-screen #page-title').textContent()) === 'page.html' && (await page.locator('#artifacts-screen #page-kind').textContent()) === 'Page' && await page.title() === 'page.html - Artifacts');
  const fileGuard = await previewOf(v);
  check('the file preview sits in the guard frame', await fileGuard.evaluate(() => document.querySelector('meta[http-equiv="Content-Security-Policy"]').content === "frame-src 'none'" && document.scripts.length === 0
    && document.querySelector('iframe').getAttribute('sandbox') === 'allow-scripts allow-forms allow-modals'));
  await waitLog(v, 'MADE ');
  const made = v.seen.logs.find(l => l.startsWith('MADE ')) || '';
  check("the page runs with its own chat's stylesheet, no origin, under the preview policy, without another chat's script", made === "MADE rgb(4, 5, 6) | null | undefined | default-src 'none'", made);
  check("another chat's script never loads", !v.seen.logs.some(l => l.includes('OTHER CHAT LOADED')));
  check('Made in names the chat', (await page.locator('#artifacts-screen #page-from').textContent()) === 'Made in Making files');
  check('no version menu for one version', await page.locator('#artifacts-screen #page-from select').count() === 0);
  await page.locator('#artifacts-screen #page-from .chat-link').click();
  await page.waitForSelector('#chat .msg');
  check('Made in opens the chat', await shown(page, '#scroll') && (await page.locator('#title').textContent()) === 'Making files' && !(await shown(page, '#artifacts-screen')));
  check('the preview is gone with the screen (file)', await page.locator('#artifacts-screen #page-body iframe').count() === 0);
  await page.goBack();
  await page.waitForSelector('#artifacts-screen #page:not([hidden])');
  check('Back returns to the file', await page.evaluate(() => location.hash) === `#ac=${makeIndex}.${fileId('page.html')}` && (await page.locator('#artifacts-screen #page-title').textContent()) === 'page.html');
  await page.locator('#artifacts-screen #home-button').click();
  check('home returns to the In chats grid', await page.locator('#artifacts-screen #tab-chats').getAttribute('aria-selected') === 'true' && (await titles()).length === 10);

  // A diagram in two versions: the menu lists both, the latest first shown.
  await page.locator('#artifacts-screen #grid .card', { hasText: 'chart.svg' }).click();
  const svgGuard = await previewOf(v);
  const options = page.locator('#artifacts-screen #page-from select option');
  check('the version menu lists the versions, the latest chosen', JSON.stringify(await options.allTextContents()) === JSON.stringify(['v1', 'v2 (latest)']) && await page.locator('#artifacts-screen #page-from select').inputValue() === '1', JSON.stringify(await options.allTextContents()));
  check('the latest version shows', (await svgGuard.$eval('iframe', f => f.getAttribute('srcdoc'))).includes('<!--V2-->'));
  await page.locator('#artifacts-screen #page-from select').selectOption('0');
  const v1Guard = await previewOf(v);
  check('choosing v1 shows v1', (await v1Guard.$eval('iframe', f => f.getAttribute('srcdoc'))).includes('<!--V1-->'));
  check('the diagram page', (await page.locator('#artifacts-screen #page-kind').textContent()) === 'Diagram');

  // Markdown through the sanitizer; Markdown from a part; code as code.
  await page.evaluate(h => { location.hash = h; }, `#ac=${makeIndex}.${fileId('notes.md')}`);
  await page.waitForSelector('#artifacts-screen #page-body .prose h1');
  check('Markdown renders, its script removed', (await page.locator('#artifacts-screen #page-body .prose h1').textContent()) === 'Notes'
    && await page.locator('#artifacts-screen #page-body .prose strong').count() === 1 && await page.locator('#artifacts-screen #page-body script').count() === 0 && !v.seen.logs.includes('MD SCRIPT'));
  check('Open file for Markdown', (await page.locator('#artifacts-screen #page-links a.open-file').getAttribute('href')) === `Making_files/artefacts/notes.md`, await page.locator('#artifacts-screen #page-links a.open-file').getAttribute('href'));
  check('the big Markdown is in a part', !!Object.values(data.chats[makeIndex].files).find(f => f.name === 'big.md').versions[0].part);
  await page.evaluate(h => { location.hash = h; }, `#ac=${makeIndex}.${fileId('big.md')}`);
  await page.waitForSelector('#artifacts-screen #page-body .prose h1', { timeout: 3000 });
  check('Markdown from a part renders', (await page.locator('#artifacts-screen #page-body .prose h1').textContent()) === 'Big doc');
  await page.evaluate(h => { location.hash = h; }, `#ac=${makeIndex}.${fileId('tool.py')}`);
  await page.waitForSelector('#artifacts-screen #page-body pre.code-view');
  check('code shows as code', (await page.locator('#artifacts-screen #page-body pre.code-view').textContent()) === 'print("made in a chat")\n' && (await page.locator('#artifacts-screen #page-kind').textContent()) === 'Code');
  check('no Open file for a script', await page.locator('#artifacts-screen #page-links a').count() === 0);
  check("a file that may not match says so, in the chat viewer's words", await shown(page, '#artifacts-screen #page-note')
    && (await page.locator('#artifacts-screen #page-note').textContent()) === "An edit Claude made to this file couldn't be replayed, so it may not match what Claude made.", await page.locator('#artifacts-screen #page-note').textContent());
  await page.evaluate(h => { location.hash = h; }, `#ac=${makeIndex}.${fileId('notes.md')}`);
  await page.waitForSelector('#artifacts-screen #page-body .prose h1');
  check('a file with no flag has no note', await page.locator('#artifacts-screen #page-note').isHidden());
  await page.evaluate(h => { location.hash = h; }, `#ac=${makeIndex}.nope`);
  await page.waitForSelector('#artifacts-screen #home:not([hidden])');
  check('an unknown file: the grid', await page.evaluate(() => location.hash) === '#artifacts');
  await tabs.nth(0).click();

  // ---- The All tab's source line ----
  check('All: the search says artifacts', await searchBox.getAttribute('placeholder') === 'Search artifacts' && await searchBox.getAttribute('aria-label') === 'Search artifacts');
  const cardText = async (title, sel) => {
    const c = page.locator('#artifacts-screen #grid .card').filter({ has: page.locator('.title', { hasText: new RegExp(`^${title}$`) }) });
    return (await c.locator(sel).count()) ? c.locator(sel).textContent() : '';
  };
  const wantSource = { 'Guide page': '💬 2 chats', Hostile: 'Shared with you', 'Shared deck': 'Shared with you', 'Cowork deck': 'Cowork', 'Code dash': 'Code', 'Lorber Notes': '💬 1 chat', 'Loose doc': '', Guide: '💬 1 chat', navfile: 'Shared with you' };
  for (const [title, want] of Object.entries(wantSource)) check(`source line: ${title}`, (await cardText(title, '.source')) === want, await cardText(title, '.source'));
  check('also in chat: only the page a chat wrote as it now is', (await cardText('Guide', '.also')) === 'also in chat' && (await cardText('Guide page', '.also')) === '' && await page.locator('#artifacts-screen #grid .card .also').count() === 1);

  // / searches the artifacts on their screen, not the chats.
  await page.locator('#artifacts-screen #home h1').click();
  await page.keyboard.press('/');
  check('/ focuses the artifacts search', await page.evaluate(() => { const s = document.getElementById('artifacts-screen').shadowRoot; return s.activeElement && s.activeElement.id === 'search'; }));
  await page.keyboard.type('guide');
  check('typing / in the artifacts search stays there', JSON.stringify(await titles()) === JSON.stringify(['Guide page', 'Guide']), JSON.stringify(await titles()));
  await page.keyboard.type('/');
  check('a / typed in the search is text', await page.locator('#artifacts-screen #search').inputValue() === 'guide/' && await page.evaluate(() => document.activeElement.id) === 'artifacts-screen');
  await page.locator('#artifacts-screen #search').fill('');

  // ---- An artifact page ----
  await page.locator('#artifacts-screen #grid .card', { hasText: 'Guide page' }).click();
  await page.waitForSelector('#artifacts-screen #page:not([hidden])');
  check('a card opens #a=<id>', await page.evaluate(() => location.hash) === `#a=${p(1)}`);
  check('its title', (await page.locator('#artifacts-screen #page-title').textContent()) === 'Guide page' && await page.title() === 'Guide page - Artifacts');
  const guard = await previewOf(v);
  await waitLog(v, 'GUIDE ');
  const said = v.seen.logs.find(l => l.startsWith('GUIDE ')) || '';
  check('the preview shows the page with its CSS, with no origin, under the preview policy', said === "GUIDE rgb(1, 2, 3) | null | default-src 'none'", said);
  const frameAttrs = await page.$eval('#artifacts-screen #page-body .preview iframe', f => ({ sandbox: f.getAttribute('sandbox'), src: f.getAttribute('src') }));
  check('the guard frame: sandboxed srcdoc', frameAttrs.sandbox === 'allow-scripts allow-forms allow-modals' && frameAttrs.src === null, JSON.stringify(frameAttrs));
  const guardState = await guard.evaluate(() => {
    const f = document.querySelector('iframe');
    return { policy: document.querySelector('meta[http-equiv="Content-Security-Policy"]').content, sandbox: f.getAttribute('sandbox'), scripts: document.scripts.length, frames: document.querySelectorAll('iframe').length };
  });
  check("the guard's policy is frame-src 'none', it runs nothing, and holds one frame", guardState.policy === "frame-src 'none'" && guardState.scripts === 0 && guardState.frames === 1, JSON.stringify(guardState));
  check('the preview frame: the same sandbox', guardState.sandbox === 'allow-scripts allow-forms allow-modals');
  check('the open-file link points at the saved file', fs.existsSync(path.join(dir, decodeURIComponent(await page.locator('#artifacts-screen #page-links a.open-file').getAttribute('href')))));
  const groups = page.locator('#artifacts-screen #page-from .link-group');
  check('the link line: Published in, then Edited in, each chat once', JSON.stringify(await groups.allTextContents()) === JSON.stringify(['Published in Editing', 'Edited in Editing, Plain talk']), JSON.stringify(await groups.allTextContents()));
  const verMenu = page.locator('#artifacts-screen #page-from select');
  check('the version menu: the older published versions, then the current one, chosen', JSON.stringify(await verMenu.locator('option').allTextContents()) === JSON.stringify(['v1', 'v2', 'Current']) && await verMenu.inputValue() === 'current', JSON.stringify(await verMenu.locator('option').allTextContents()));
  await verMenu.selectOption({ label: 'v1' });
  check('v1 opens the saved copy (the file the chat wrote)', (await (await previewOf(v)).$eval('iframe', f => f.getAttribute('srcdoc'))).includes('<!--OLDA-->'));
  await verMenu.selectOption({ label: 'v2' });
  const v2Guard = await previewOf(v);
  check('v2 opens the saved copy in published/', (await v2Guard.$eval('iframe', f => f.getAttribute('srcdoc'))).includes('<!--OLDB-->') && await v2Guard.evaluate(() => document.querySelector('meta[http-equiv]').content === "frame-src 'none'"));
  check('an older version has no claude.ai badge mix-up: its Open on claude.ai stays', await page.locator('#artifacts-screen #page-links a.open-claude').count() === 1);
  await verMenu.selectOption('current');
  check('Current goes back to the artifact', (await (await previewOf(v)).$eval('iframe', f => f.getAttribute('srcdoc'))).includes('Guide page body'));
  await groups.nth(0).locator('.chat-link').click();
  await page.waitForSelector('#chat .msg');
  check('Published in opens the chat at that message', (await page.locator('#title').textContent()) === 'Editing' && await page.locator('#chat .msg[data-id="ea1"]').count() === 1 && !(await shown(page, '#artifacts-screen')));
  await page.goBack();
  await page.waitForSelector('#artifacts-screen #page:not([hidden])');
  check('Back returns to the artifact', await page.evaluate(() => location.hash) === `#a=${p(1)}` && (await page.locator('#artifacts-screen #page-title').textContent()) === 'Guide page');
  await previewOf(v);
  await page.goBack();
  await page.waitForSelector('#artifacts-screen #home:not([hidden])');
  check('Back returns to the grid', await page.evaluate(() => location.hash) === '#artifacts' && await page.locator('#artifacts-screen #page-body iframe').count() === 0);
  await page.locator('#artifacts-screen #grid .card', { hasText: 'Shared deck' }).click();
  await page.waitForSelector('#artifacts-screen #page:not([hidden])');
  await page.locator('#artifacts-screen #home-button').click();
  check('the home button returns to the grid', await shown(page, '#artifacts-screen #home') && await page.evaluate(() => location.hash) === '#artifacts');

  // The reused page: its file is the one the chat saved.
  await page.locator('#artifacts-screen #grid .card', { hasText: /^Guide/ }).filter({ hasNotText: 'Guide page' }).click();
  await page.waitForSelector('#artifacts-screen #page:not([hidden])');
  const reusedHref = await page.locator('#artifacts-screen #page-links a.open-file').getAttribute('href');
  check("a reused page opens the chat's file", reusedHref === encodeURI(reused.startSaved) && fs.existsSync(path.join(dir, reused.startSaved)), reusedHref);
  await previewOf(v);
  check('a reused page previews', await waitLog(v, 'REUSED Guide written'));
  check('a page published only at its current version: no version menu', await page.locator('#artifacts-screen #page-from select').count() === 0
    && JSON.stringify(await page.locator('#artifacts-screen #page-from .link-group').allTextContents()) === JSON.stringify(['Published in Publishing']));

  // ---- Chats still open ----
  await page.locator('#chat-list .item', { hasText: 'Plain talk' }).click();
  await page.waitForSelector('#chat .msg');
  check('a chat in the sidebar opens it', await shown(page, '#scroll') && !(await shown(page, '#artifacts-screen')) && (await page.locator('#title').textContent()) === 'Plain talk', await page.locator('#title').textContent());
  check('the preview is gone with the screen', await page.locator('#artifacts-screen #page-body iframe').count() === 0);
  check('the chat is current, the entry not', await nav.getAttribute('aria-current') === 'false' && await page.locator('#chat-list .item[aria-current="true"]').textContent() === 'Plain talk');
  check('the chat text', (await page.locator('#chat').textContent()).includes('Hi, plain reply.'));
  await page.goBack();
  await page.waitForSelector('#artifacts-screen #page:not([hidden])');
  check('history goes back to the artifact', await page.evaluate(() => location.hash) === `#a=${p(9)}`);
  await page.goForward();
  await page.waitForSelector('#scroll', { state: 'visible' });
  check('and forward to the chat', (await page.locator('#title').textContent()) === 'Plain talk' && await page.title() === 'Plain talk - Claude Takeout', await page.title());
  // ---- Open artifact from a chat's published card ----
  await page.locator('#chat-list .item', { hasText: 'Editing' }).click();
  await page.waitForSelector('#chat .msg');
  const openArt = page.locator('#chat .page-link .open-artifact');
  check('a published card of an exported artifact: Open artifact', await openArt.count() === 2);
  await openArt.first().click();
  await page.waitForSelector('#artifacts-screen #page:not([hidden])');
  check('Open artifact opens its page', await page.evaluate(() => location.hash) === `#a=${p(1)}` && (await page.locator('#artifacts-screen #page-title').textContent()) === 'Guide page');
  await page.goBack();
  await page.waitForSelector('#chat .msg');
  check('Back returns to the chat', (await page.locator('#title').textContent()) === 'Editing');

  await page.locator('#artifacts-nav').click();
  await page.waitForSelector('#artifacts-screen #grid .card');
  await page.locator('#chat-list .item', { hasText: 'Plain talk' }).click();
  check('the same chat again, from the screen', await shown(page, '#scroll') && (await page.locator('#title').textContent()) === 'Plain talk' && await page.title() === 'Plain talk - Claude Takeout');
  await page.locator('#chat').click();
  await page.keyboard.press('/');
  check('/ on a chat still searches the chats', await page.evaluate(() => document.activeElement && document.activeElement.getAttribute('aria-label') === 'Search all chats'));
  check('no requests, no errors', v.seen.requests.length === 0 && v.seen.errors.length === 0, JSON.stringify([v.seen.requests, v.seen.errors]));
  await v.context.close();

  // ---- Docs: the text the chat rebuilt, and Made in both ways ----
  const docId = uuidToBase58(DOC_U);
  const dv = await open(dir, `#a=${docId}`);
  await dv.page.waitForSelector('#artifacts-screen #page-body .prose h1');
  check('Docs: the chat\'s text', (await dv.page.locator('#artifacts-screen #page-body .prose h1').textContent()) === 'Lorber Notes' && (await dv.page.locator('#artifacts-screen #page-body .prose').textContent()).includes('Alpha text.'));
  check('Docs: the note', (await dv.page.locator('#artifacts-screen #page-note').textContent()) === "Rebuilt from the chat. Edits made on claude.ai aren't included." && await shown(dv.page, '#artifacts-screen #page-note'));
  check('Docs: Made in its chat', JSON.stringify(await dv.page.locator('#artifacts-screen #page-from .link-group').allTextContents()) === JSON.stringify(['Made in Docs chat']));
  await dv.page.locator('#artifacts-screen #page-from .chat-link').click();
  await dv.page.waitForSelector('#chat .msg[data-id="da1"]');
  await dv.page.waitForTimeout(150);
  check('Made in opens the chat scrolled to the message', (await dv.page.locator('#title').textContent()) === 'Docs chat'
    && await dv.page.locator('#chat .msg[data-id="da1"]').evaluate(m => { const r = m.getBoundingClientRect(); return r.bottom > 0 && r.top < window.innerHeight; }));
  await dv.page.goBack();
  await dv.page.waitForSelector('#artifacts-screen #page-body .prose h1');
  check('Back from the chat returns to the Docs artifact', await dv.page.evaluate(() => location.hash) === `#a=${docId}`);
  await dv.page.evaluate(h => { location.hash = h; }, `#a=${p(7)}`);
  await dv.page.waitForSelector('#artifacts-screen #page-body .docs-page');
  check('Docs without a chat: the v1.16 page, no note, no link line', (await dv.page.locator('#artifacts-screen #page-body h2').textContent()) === 'Claude Docs document'
    && await dv.page.locator('#artifacts-screen #page-note').isHidden() && await dv.page.locator('#artifacts-screen #page-from').isHidden());
  check('the full export has no changes heading', await dv.page.locator('#artifacts-screen #since').count() === 0 || await dv.page.locator('#artifacts-screen #since').isHidden());
  check('no requests, no errors (Docs)', dv.seen.requests.length === 0 && dv.seen.errors.length === 0, JSON.stringify([dv.seen.requests, dv.seen.errors]));
  await dv.context.close();

  // ---- Export Changes: the heading line ----
  check('fixture: the changes run holds the changed artifact only', !!changesData.artifactsSince && JSON.stringify((changesData.artifacts || []).map(a => a.title)) === JSON.stringify(['Shared deck']), JSON.stringify(changesData.artifacts));
  const cv = await open(changesDir, '#artifacts');
  await cv.page.waitForSelector('#artifacts-screen #grid .card');
  const since = await cv.page.locator('#artifacts-screen #since').textContent();
  check('changes: "Changed since <date>: N of M listed"', new RegExp(`^Changed since .+\\d.*: 1 of ${frames.length} listed$`).test(since), since);
  check('no requests, no errors (changes)', cv.seen.requests.length === 0 && cv.seen.errors.length === 0, JSON.stringify([cv.seen.requests, cv.seen.errors]));
  await cv.context.close();

  // ---- Not unzipped: no viewer-check.gif beside the page ----
  const zippedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'combined-zipped-'));
  fs.cpSync(dir, zippedDir, { recursive: true });
  fs.unlinkSync(path.join(zippedDir, 'viewer-check.gif'));
  const zv = await open(zippedDir, '#artifacts');
  await zv.page.waitForSelector('#artifacts-screen #grid .card');
  await zv.page.waitForTimeout(150);
  check('not unzipped: the grid, with tiles', await zv.page.locator('#artifacts-screen #grid .card .pic img').count() === 0 && await zv.page.locator('#artifacts-screen #grid .card .tile').count() === frames.length);
  await zv.page.evaluate(h => { location.hash = h; }, `#a=${p(1)}`);
  await zv.page.waitForSelector('#artifacts-screen #page:not([hidden])');
  await zv.page.waitForTimeout(150);
  check('not unzipped: opening says to unzip, no preview', (await zv.page.locator('#artifacts-screen #page-body').textContent()).includes('Unzip the export first, then open viewer.html again.') && await zv.page.locator('#artifacts-screen #page-body iframe').count() === 0);
  check('not unzipped: no Open file', await zv.page.locator('#artifacts-screen a.open-file').count() === 0);
  check('no requests, no errors (not unzipped)', zv.seen.requests.length === 0 && zv.seen.errors.length === 0, JSON.stringify([zv.seen.requests, zv.seen.errors]));
  await zv.context.close();

  // Opened at an artifact's hash: its page, straight away.
  const direct = await open(dir, `#a=${p(3)}`);
  await direct.page.waitForSelector('#artifacts-screen #page:not([hidden])');
  check('opened at #a=<id>: the artifact', (await direct.page.locator('#artifacts-screen #page-title').textContent()) === 'Shared deck' && !(await shown(direct.page, '#scroll')));
  await direct.page.evaluate(() => { location.hash = '#a=NoSuchId'; });
  await direct.page.waitForSelector('#artifacts-screen #home:not([hidden])');
  check('an unknown id: the grid', await direct.page.evaluate(() => location.hash) === '#artifacts');
  const pubIndex = data.chats.findIndex(c => c.title === 'Publishing');
  const otherId = Object.entries(data.chats[pubIndex].files).find(([, f]) => f.name === 'other.js')[0];
  await direct.page.evaluate(h => { location.hash = h; }, `#ac=${pubIndex}.${otherId}`);
  await direct.page.waitForSelector('#artifacts-screen #page-from:not([hidden])');
  check('opened at #ac=: the file, from its chat', (await direct.page.locator('#artifacts-screen #page-title').textContent()) === 'other.js' && (await direct.page.locator('#artifacts-screen #page-from').textContent()) === 'Made in Publishing');
  const guideId = Object.entries(data.chats[pubIndex].files).find(([, f]) => f.name === 'guide.html')[0];
  await direct.page.evaluate(h => { location.hash = h; }, `#ac=${pubIndex}.${guideId}`);
  await direct.page.waitForSelector('#artifacts-screen #home:not([hidden])');
  check('the published file has no In chats page', await direct.page.evaluate(() => location.hash) === '#artifacts');
  check('no requests, no errors (direct)', direct.seen.requests.length === 0 && direct.seen.errors.length === 0, JSON.stringify([direct.seen.requests, direct.seen.errors]));
  await direct.context.close();

  // Phone width: the menu button stays, over the screen.
  const phone = await open(dir, '#artifacts', { width: 390, height: 800 });
  await phone.page.waitForSelector('#artifacts-screen #grid .card');
  check('phone: the menu button shows over the screen', await shown(phone.page, '#menu') && (await phone.page.locator('#title').textContent()) === 'Artifacts' && !(await shown(phone.page, '#files-button')));
  await phone.page.locator('#menu').click();
  await phone.page.locator('#chat-list .item', { hasText: 'Publishing' }).click();
  check('phone: a chat from the drawer', await shown(phone.page, '#scroll') && (await phone.page.locator('#title').textContent()) === 'Publishing');
  check('phone: no horizontal scroll', await phone.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await phone.context.close();

  // ---- A hostile shared artifact ----
  const hv = await open(dir, `#a=${p(2)}`);
  await previewOf(hv);
  check('hostile: the script ran to the end', await waitLog(hv, 'ATTACK finished yes'), hv.seen.logs.filter(l => l.startsWith('ATTACK')).join(' | '));
  check('hostile: the frame has no origin', hv.seen.logs.includes('ATTACK origin null'));
  for (const [name, end] of Object.entries(attackEnds)) {
    const said = hv.seen.logs.filter(l => l.startsWith(`ATTACK ${name} `)).map(l => l.slice(`ATTACK ${name} `.length));
    check(`hostile: ${name} attempted and ended ${end}`, said[0] === 'ran' && said[1] === end, said.join());
  }
  await hv.page.waitForTimeout(400);
  check('hostile: no request left the page', hv.seen.requests.length === 0, hv.seen.requests.join(' '));
  check('hostile: no window opened', hv.seen.popups === 0);
  check('hostile: no frame on a file: or remote URL', noOutsideFrames(hv.seen), hv.seen.frames.join(' '));
  check('hostile: viewer URL and title unchanged', hv.page.url() === hv.url + `#a=${p(2)}` && (await hv.page.title()) === 'Hostile - Artifacts', hv.page.url());
  check("hostile: nothing reached the viewer's storage", await hv.page.evaluate(() => localStorage.length + sessionStorage.length) === 0);
  check('hostile: nothing ran in the viewer', !(await hv.page.evaluate(() => !!window.__hit)));
  check('hostile: no viewer page errors', hv.seen.errors.length === 0, hv.seen.errors.join(' '));
  await hv.context.close();

  // ---- Navigations, file: above all ----
  // What each refusal must say, naming its target: Chrome's own rule for file:, the page's policy for the web, and
  // for data: and blob:, which the page's frame-src file: would refuse as well, the guard's frame-src 'none'.
  const esc = t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapeFile = 'file://' + path.join(base, 'escape.html');
  const refusal = name => ({
    navfile: new RegExp(`^Not allowed to load local resource: ${esc(escapeFile)}$`),
    navrefresh: new RegExp(`^Not allowed to load local resource: ${esc(escapeFile)}$`),
    navlink: new RegExp(`^Not allowed to load local resource: ${esc(escapeFile)}$`),
    navabs: /^Not allowed to load local resource: file:\/\/\/etc\/hosts$/,
    navhttps: /^Framing 'https:\/\/remote\.test\/' violates the following Content Security Policy directive: "frame-src /,
    navdata: /^Framing '' violates the following Content Security Policy directive: "frame-src 'none'"/,
    navblob: /^Framing '' violates the following Content Security Policy directive: "frame-src 'none'"/,
  })[name];
  for (const [i, [name]] of navs(base).entries()) {
    const nv = await open(dir, `#a=${p(40 + i)}`);
    await previewOf(nv).catch(() => null);
    const refusedFor = () => nv.seen.logs.some(l => refusal(name).test(l));
    const ran = await waitLog(nv, `NAV ran ${name}`) || refusedFor();
    await nv.page.waitForTimeout(500);
    check(`${name}: the attempt ran`, ran, nv.seen.logs.join(' | '));
    check(`${name}: refused`, refusedFor(), nv.seen.logs.join(' | '));
    check(`${name}: nothing got out`, !nv.seen.logs.some(l => l.includes('ESCAPED')) && nv.seen.requests.length === 0 && nv.seen.popups === 0, [...nv.seen.logs, ...nv.seen.requests].join(' | '));
    check(`${name}: no frame on a file: or remote URL`, noOutsideFrames(nv.seen), nv.seen.frames.join(' '));
    check(`${name}: the viewer stays`, nv.page.url() === nv.url + `#a=${p(40 + i)}` && (await nv.page.title()) === `${name} - Artifacts` && nv.seen.errors.length === 0, nv.page.url() + ' ' + nv.seen.errors.join(' '));
    await nv.context.close();
  }

  // ---- The setting off: no entry ----
  const off = await open(offDir);
  await off.page.waitForSelector('#chat .msg');
  check('setting off: no Artifacts entry', await off.page.locator('#artifacts-nav').isHidden() && await off.page.locator('#artifacts-screen').isHidden());
  await off.page.evaluate(() => { location.hash = '#artifacts'; });
  await off.page.waitForTimeout(200);
  check('setting off: #artifacts opens a chat', await shown(off.page, '#scroll') && await off.page.locator('#artifacts-screen').isHidden());
  await off.page.locator('#chat-list .item', { hasText: 'Publishing' }).click();
  await off.page.waitForSelector('#chat .page-link');
  check('setting off: a published card has no Open artifact', await off.page.locator('#chat .open-artifact').count() === 0);
  check('setting off: no requests, no errors', off.seen.requests.length === 0 && off.seen.errors.length === 0, JSON.stringify([off.seen.requests, off.seen.errors]));
  await off.context.close();

  await browser.close();
  console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
