// Claude Code and Cowork sessions in the chat viewer, over file:// in Chromium: the Sessions entry and its count, the
// #sessions list page (newest first, filter), a session opened in the chat area (its title, folded thinking, a tool
// step cut at 2 KB, a subagent inside its step, its image from sessions/<folder>/images, a compaction and a command
// labelled), the fold bar's line and artifact link, the artifact's "Made in session" link back, search labelled
// Session opening the session at the message, a hostile title as text, sessions kept out of Recents and All chats,
// Back from a session to #sessions, a one-chat viewer with sessions, and a session's published pages (cards opening the
// side panel from the artifact step's part, the version menu, Back and Forward, the fold-bar link to the panel, Open
// artifact). No requests outside file:, no page errors.
// Run: PW=<playwright-core> CHROME_EXE=<chrome> node tests/e2e/sessions.e2e.js
const { chromium } = require(process.env.PW);
const fs = require('fs'), os = require('os'), path = require('path');
const { buildHtml } = require('./make-viewer.js');
const { VIEWER_CHECK_BASE64, VIEWER_CHECK_FILE, buildViewerSession } = require('../../takeout-viewer.js');
const { uuidToBase58 } = require('../../export-core.js');

const BASE = Date.UTC(2026, 0, 1);
const iso = h => new Date(BASE + h * 3600 * 1000).toISOString();
function chat(i) {
  const uuid = `c${i}`;
  const messages = [0, 1].map(n => ({
    uuid: `${uuid}-${n}`, parent_message_uuid: n ? `${uuid}-0` : null, sender: n ? 'assistant' : 'human',
    created_at: iso(i), content: [{ type: 'text', text: `Message ${n} of chat ${i}` }], attachments: [], files: [], files_v2: [],
  }));
  return { uuid, name: `Chat ${i}`, model: 'claude-x', created_at: iso(i), updated_at: iso(i), settings: {}, current_leaf_message_uuid: `${uuid}-1`, chat_messages: messages };
}
const CHATS = [0, 1, 2].map(chat);

const ART = 'abcdef01-2345-4678-89ab-cdef01234567';
const ART_ID = uuidToBase58(ART);
const HOSTILE = '<img src=x onerror="console.log(\'TITLE RAN\')">Hostile';
const ev = (uuid, type, content, extra = {}) => ({ type, uuid, created_at: iso(50), parent_tool_use_id: null,
  message: { role: type === 'user' ? 'user' : 'assistant', content }, ...extra });
const LONG = 'y'.repeat(5000);
const FOLDER_A = 'sessions/Fix_the_build_a1';
const SESSION_A = buildViewerSession({
  id: 'cse_a1', title: 'Fix the build', config: { origin: 'cowork', model: 'claude-opus-4-8' },
  created_at: iso(40), last_event_at: iso(60), external_metadata: { artifacts: [{ artifact_id: ART.toUpperCase(), title: 'x' }] },
}, [
  ev('a-compact', 'user', [{ type: 'text', text: 'This session is being continued from a previous conversation that ran out of context. Summary: earlier work.' }]),
  ev('a-cmd', 'user', [{ type: 'text', text: '<command-name>/review</command-name>\n<command-args>main</command-args>' }]),
  ev('a-p1', 'user', [{ type: 'text', text: 'Please deploy the zebra service' }, { type: 'image', file: 'images/1.png' }, { type: 'image', missing: 'not saved' }]),
  ev('a-r1', 'assistant', [{ type: 'thinking', thinking: 'Quietly pondering the plan' }]),
  ev('a-r2', 'assistant', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'cat big.log' } }]),
  ev('a-r3', 'user', [{ type: 'tool_result', tool_use_id: 't1', content: LONG }]),
  ev('a-r4', 'assistant', [{ type: 'tool_use', id: 'ag1', name: 'Agent', input: { description: 'Look around', prompt: 'Find the config' } }]),
  ev('a-c1', 'user', [{ type: 'text', text: 'Find the config' }], { parent_tool_use_id: 'ag1' }),
  ev('a-c2', 'assistant', [{ type: 'text', text: 'Subagent found config.yml' }], { parent_tool_use_id: 'ag1' }),
  ev('a-r5', 'user', [{ type: 'tool_result', tool_use_id: 'ag1', content: [{ type: 'text', text: 'config.yml' }] }]),
  ev('a-r6', 'assistant', [{ type: 'text', text: 'Deployed.' }]),
], { folder: FOLDER_A });
const SESSION_B = buildViewerSession({
  id: 'cse_b2', title: HOSTILE, config: { origin: 'claude-code' }, created_at: iso(10), last_event_at: iso(20),
}, [ev('b-p1', 'user', [{ type: 'text', text: 'Hello from the older session' }]), ev('b-r1', 'assistant', [{ type: 'text', text: 'Hi.' }])], { folder: 'sessions/Hostile_b2' });
const VIEW = { id: ART_ID, title: 'Session page', kind: 'Page', typed: false, docs: false, shared: false, public: false, createdAt: iso(41), updatedAt: iso(42),
  folder: 'artifacts/Session_page', start: null, files: [], url: `https://claude.ai/artifact/${ART_ID}` };
// A session that published an artifact in the export's store (v1.25.1): its cards open the side panel, previews from
// the artifact step's part; a second artifact it published isn't in the store.
const PUB_ART = '22222222-3333-4444-8555-666666666666';
const PUB_ID = uuidToBase58(PUB_ART);
const GONE = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';
const GONE_ID = uuidToBase58(GONE);
const PUB_DIR = `artifacts/Shipped_page_${PUB_ID}`;
const publishEvents = (id, shortId, ver, n) => [
  ev(`call-${id}`, 'assistant', [{ type: 'tool_use', id, name: 'Artifact', input: { file_path: '/home/user/site/page.html', description: 'page' } }]),
  ev(`res-${id}`, 'user', [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: `Published /home/user/site/page.html at https://claude.ai/artifact/${shortId} (Version ${n}, version id ${ver})` }] }]),
];
const PUB_VIEW = { id: PUB_ID, title: 'Shipped page', kind: 'Page', typed: false, docs: false, shared: false, public: false, createdAt: iso(80), updatedAt: iso(82),
  folder: `${PUB_DIR}/pv2`, start: 'index.html', startSaved: 'index.html', startKind: 'html', files: [{ path: 'index.html', savedAs: 'index.html' }, { path: 'app.css', savedAs: 'app.css' }],
  url: `https://claude.ai/artifact/${PUB_ID}`, part: 1, key: 'a0', ver: 'pv2' };
const PUB_RECORD = {
  format: 2, uuid: PUB_ART, shortId: PUB_ID, url: `https://claude.ai/artifact/${PUB_ID}`, title: 'Shipped page', listed: true, current: 'pv2', start: 'index.html', needsRuntime: false,
  dir: PUB_DIR, versionOrder: ['pv1', 'pv2'],
  versions: {
    pv1: { folder: 'pv1', files: [{ path: 'index.html', savedAs: 'index.html' }], start: 'index.html', startSaved: 'index.html', saved: true, publishedIn: [] },
    pv2: { folder: 'pv2', files: [{ path: 'index.html', savedAs: 'index.html' }, { path: 'app.css', savedAs: 'app.css' }], start: 'index.html', startSaved: 'index.html', saved: true, publishedIn: [] },
  },
  versionPlaces: { pv1: { folder: `${PUB_DIR}/pv1`, part: 1, key: 'a1', startKind: 'html' } },
};
const PUB_STORE = { views: [PUB_VIEW], records: [PUB_RECORD] };
// A Design artifact: its start file is claude.ai's loader, which never finishes offline, so the side panel points at
// its canvas on the Artifacts screen instead of previewing it.
const DES_ART = '33333333-4444-4555-8666-777777777777';
const DES_ID = uuidToBase58(DES_ART);
const DES_DIR = `artifacts/Panel_mockups_${DES_ID}`;
const DES_VIEW = { id: DES_ID, title: 'Panel mockups', kind: 'Design', typed: true, docs: false, shared: false, public: false, createdAt: iso(80), updatedAt: iso(82),
  folder: `${DES_DIR}/dv1`, start: 'index.html', startSaved: 'index.html', startKind: 'html',
  files: [{ path: 'index.html', savedAs: 'index.html' }, { path: 'project/canvas.json', savedAs: 'project/canvas.json' }, { path: 'project/Main.dc.html', savedAs: 'project/Main.dc.html' }],
  url: `https://claude.ai/artifact/${DES_ID}`, ver: 'dv1', part: 1, key: 'a2' };
const DES_CANVAS = JSON.stringify({ v: 3, title: 'Panel mockups', boards: { 'Main.dc.html': { x: 0, y: 0, w: 300, h: 200, title: 'Home board' } } });
const DES_BOARD = '<!doctype html><html><body><div style="width:300px;height:200px">Board one body</div></body></html>';
const DES_RECORD = {
  format: 2, uuid: DES_ART, shortId: DES_ID, url: `https://claude.ai/artifact/${DES_ID}`, title: 'Panel mockups', listed: true, current: 'dv1', start: 'index.html', needsRuntime: true,
  dir: DES_DIR, versionOrder: ['dv1'],
  versions: { dv1: { folder: 'dv1', files: [{ path: 'index.html', savedAs: 'index.html' }, { path: 'project/canvas.json', savedAs: 'project/canvas.json' }], start: 'index.html', startSaved: 'index.html', saved: true, publishedIn: [] } },
  versionPlaces: {},
};
const LOADER = '<!doctype html><p>Loading…</p>';
const PAGE_V1 = '<!doctype html><p>Version one of the shipped page</p>';
const PAGE_V2 = '<!doctype html><link rel="stylesheet" href="app.css"><p>Version two of the shipped page</p><img src="dot.png" alt="dot">';
const DOT = `data:image/png;base64,${'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='}`;
const PAGE_CSS = 'p { color: rebeccapurple }';
const PART = `window.__archivePart(1, ${JSON.stringify({ a0: { texts: [['index.html', PAGE_V2], ['app.css', PAGE_CSS]], images: [['dot.png', DOT]] }, a1: { texts: [['index.html', PAGE_V1]], images: [] },
  a2: { texts: [['index.html', '<!doctype html><p>Loading…</p>'], ['project/canvas.json', DES_CANVAS], ['project/Main.dc.html', DES_BOARD]], images: [] } })});`;
const FOLDER_P = 'sessions/Ship_it_p1';
const SESSION_P = buildViewerSession({
  id: 'cse_p1', title: 'Ship it', config: { origin: 'cowork' }, created_at: iso(80), last_event_at: iso(90),
  external_metadata: { artifacts: [{ artifact_id: PUB_ART, title: 'x' }, { artifact_id: GONE, title: 'y' }] },
}, [
  ev('p-p1', 'user', [{ type: 'text', text: 'Make the page' }]),
  ...publishEvents('pt1', PUB_ID, 'pv1', 1),
  ev('p-r1', 'assistant', [{ type: 'text', text: 'First version is up.' }]),
  ev('p-p2', 'user', [{ type: 'text', text: 'Make it purple\n\n' + Array.from({ length: 80 }, (_, i) => `Detail ${i} of the request.`).join('\n\n') }]),
  ...publishEvents('pt2', PUB_ID, 'pv2', 2),
  ...publishEvents('pt3', GONE_ID, 'gv1', 1),
  ev('p-r2', 'assistant', [{ type: 'text', text: 'Done, and a second page.' }]),
], { folder: FOLDER_P, artifacts: PUB_STORE });
// Chats claude.ai made when an artifact was opened (settings.started_with_artifact), empty: one in the store, one not;
// and one with messages, which stays as it is.
const openedChat = (uuid, name, art, messages = []) => ({ uuid, name, model: 'claude-x', created_at: iso(96), updated_at: iso(96), current_leaf_message_uuid: messages.length ? messages[messages.length - 1].uuid : null,
  settings: { started_with_artifact: { artifact_uuid: art } }, chat_messages: messages });
const OPENED = [
  openedChat('c-open', 'Opened page', PUB_ART.toUpperCase()),
  openedChat('c-gone', 'Opened gone', GONE),
  openedChat('c-design', 'Opened design', DES_ART),
  openedChat('c-msgs', 'Opened and used', PUB_ART, [{ uuid: 'cm-0', parent_message_uuid: null, sender: 'human', created_at: iso(96), content: [{ type: 'text', text: 'A real prompt' }], attachments: [], files: [], files_v2: [] }]),
];
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-'));
  const file = path.join(dir, 'viewer.html');
  const one = path.join(dir, 'one.html');
  fs.writeFileSync(path.join(dir, VIEWER_CHECK_FILE), Buffer.from(VIEWER_CHECK_BASE64, 'base64'));
  fs.mkdirSync(path.join(dir, FOLDER_A, 'images'), { recursive: true });
  fs.writeFileSync(path.join(dir, FOLDER_A, 'images', '1.png'), Buffer.from(PNG, 'base64'));
  const opts = { sessions: [SESSION_B, SESSION_A], artifacts: { views: [VIEW], listed: 1, exported: iso(70), since: null } };
  fs.writeFileSync(file, buildHtml(CHATS, iso(70), () => ({}), opts));
  fs.writeFileSync(one, buildHtml([chat(5)], iso(70), () => ({}), { sessions: [SESSION_A] }));
  // The published session's viewer: the store's files on disk and the artifact step's part in viewer-files/.
  const pub = path.join(dir, 'pub.html');
  for (const [ver, files] of [['pv1', [['index.html', PAGE_V1]]], ['pv2', [['index.html', PAGE_V2], ['app.css', PAGE_CSS]]]]) {
    fs.mkdirSync(path.join(dir, PUB_DIR, ver), { recursive: true });
    for (const [name, text] of files) fs.writeFileSync(path.join(dir, PUB_DIR, ver, name), text);
  }
  fs.mkdirSync(path.join(dir, DES_DIR, 'dv1', 'project'), { recursive: true });
  fs.writeFileSync(path.join(dir, DES_DIR, 'dv1', 'index.html'), LOADER);
  fs.writeFileSync(path.join(dir, DES_DIR, 'dv1', 'project', 'canvas.json'), '{}');
  fs.mkdirSync(path.join(dir, 'viewer-files'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'viewer-files', 'part-0001.js'), PART);
  fs.writeFileSync(pub, buildHtml([...CHATS, ...OPENED], iso(95), () => ({}), { sessions: [SESSION_P], artifacts: { views: [PUB_VIEW, DES_VIEW], records: [PUB_RECORD, DES_RECORD], listed: 2, exported: iso(95), since: null } }, { fileScripts: true }));
  const browser = await chromium.launch({ executablePath: process.env.CHROME_EXE });
  let failed = 0;
  const check = (n, ok, x = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n} ${ok ? '' : x}`); };
  const context = await browser.newContext({ viewport: { width: 1300, height: 900 } });
  const errors = [], requests = [];
  async function open(url) {
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error' || m.text().includes('RAN')) errors.push(m.text()); });
    await page.route('**/*', r => { const u = r.request().url(); if (u.startsWith('file:')) r.continue(); else { requests.push(u); r.abort(); } });
    await page.goto(url);
    return page;
  }
  const page = await open('file://' + file);
  await page.waitForSelector('.msg');
  const visible = sel => page.locator(sel).first().isVisible();
  const hash = () => page.evaluate(() => location.hash);
  const txt = async sel => ((await page.locator(sel).count()) ? page.textContent(sel) : null);

  // The entry
  check('the Sessions entry shows with its count', (await page.locator('#sessions-nav').count()) === 1 && await visible('#sessions-nav') && (await txt('#sessions-nav .n')) === '2', await txt('#sessions-nav'));
  check('sessions are not in Recents or All chats: the Chats count', (await txt('#chats-nav .n')) === '3');
  const recents = await page.$$eval('#recents .item', l => l.map(x => x.textContent));
  check('sessions are not in Recents', recents.join() === 'Chat 2,Chat 1,Chat 0', recents.join());

  // #sessions
  await page.click('#sessions-nav');
  await page.waitForFunction(() => location.hash === '#sessions');
  const rows = await page.$$eval('#lists-screen a.chat-row', l => l.map(a => [a.textContent, a.getAttribute('href')]));
  check('#sessions lists sessions newest first', rows.length === 2 && rows[0][0] === 'Fix the build' && rows[0][1] === '#session=cse_a1' && rows[1][0] === HOSTILE, JSON.stringify(rows));
  check('#sessions: heading, titles and the entry current', (await txt('#lists-screen h2.list-title')) === 'Sessions' && (await page.title()) === 'Sessions - Claude Takeout'
    && (await page.getAttribute('#sessions-nav', 'aria-current')) === 'true' && (await page.getAttribute('#chats-nav', 'aria-current')) === 'false'
    && (await page.getAttribute('#projects-nav', 'aria-current')) === 'false');
  const sub = await txt('#lists-screen .chat-line .chat-sub');
  check('#sessions: a row names its origin and activity', /cowork/.test(sub || '') && /Updated/.test(sub || ''), sub);
  check('a hostile title is text in the list', (await page.locator('#lists-screen img').count()) === 0);
  await page.fill('#lists-screen input.list-filter', 'build');
  await page.waitForFunction(() => document.querySelectorAll('#lists-screen a.chat-row').length === 1);
  check('#sessions filters', (await txt('#lists-screen a.chat-row')) === 'Fix the build');

  // A session
  await page.click('#lists-screen a.chat-row');
  await page.waitForFunction(() => location.hash === '#session=cse_a1');
  await page.waitForSelector('#chat .msg');
  check('a session opens with its title', (await txt('#title')) === 'Fix the build' && (await page.title()) === 'Fix the build - Claude Takeout' && await visible('#scroll') && !(await visible('#lists-screen')));
  check('a session: thinking is folded', (await page.locator('#chat details.line.thinking').count()) >= 1 && !(await page.locator('#chat details.line.thinking').first().evaluate(d => d.open)));
  const stepText = await page.evaluate(() => {
    for (const d of document.querySelectorAll('#chat details')) d.open = true;
    return [...document.querySelectorAll('#chat .tool-part pre')].map(p => p.textContent).find(t => t.startsWith('yyy')) || '';
  });
  check('a session: a tool step cut at 2 KB', stepText === 'y'.repeat(2048) + '\n[… full output in session.json]', stepText.length);
  await page.waitForFunction(() => [...document.querySelectorAll('#chat .tool-children')].some(b => b.textContent.includes('Subagent found config.yml')));
  check('a session: a subagent shows inside its step', true);
  const img = await page.evaluate(() => {
    const i = document.querySelector('#chat .msg.human img.prompt-image');
    return i ? new Promise(ok => { const done = () => ok([i.getAttribute('src'), i.naturalWidth]); if (i.complete) done(); else { i.onload = done; i.onerror = done; } }) : null;
  });
  check('its image loads from sessions/<folder>/images', img && img[0] === `${FOLDER_A}/images/1.png` && img[1] > 0, JSON.stringify(img));
  check('a missing image says so', /Image not saved/.test(await txt('#chat .msg.human .image-missing') || ''));
  const labelled = await page.$$eval('#chat .msg.labelled', l => l.map(x => x.className + '|' + x.textContent));
  const prompts = await page.$$eval('#chat .msg.human .bubble', l => l.map(x => x.textContent).join('\n'));
  check('a compaction and a command are labelled, not shown as prompts', labelled.length === 2 && /compaction/.test(labelled[0]) && /Ran \/review main/.test(labelled[1])
    && !/continued from a previous/.test(prompts) && !/Ran \/review/.test(prompts) && /zebra/.test(prompts), JSON.stringify(labelled));

  // The fold bar and the artifact both ways
  check('the fold bar says Session · <origin>', /Session · cowork/.test(await txt('#project') || '') && await visible('#project'), await txt('#project'));
  const artLink = page.locator(`#project a[href="#a=${ART_ID}"]`);
  check('the fold bar links its artifact', (await artLink.count()) === 1 && (await artLink.textContent()) === 'Session page');
  await artLink.click();
  await page.waitForFunction(id => location.hash === '#a=' + id, ART_ID);
  const back = page.locator('#artifacts-screen a.session-link');
  await back.first().waitFor();
  const made = await page.locator('#artifacts-screen #page-from').textContent();
  check('the artifact links back: Made in session <title>', /Made in session Fix the build/.test(made) && (await back.getAttribute('href')) === '#session=cse_a1', made);
  await back.click();
  await page.waitForFunction(() => location.hash === '#session=cse_a1');
  await page.waitForSelector('#chat .msg');
  check('the link back opens the session', (await txt('#title')) === 'Fix the build' && !(await visible('#artifacts-screen')));

  // Back from a session returns to #sessions
  await page.goBack(); // the artifact
  await page.waitForFunction(id => location.hash === '#a=' + id, ART_ID);
  await page.goBack(); // the session
  await page.waitForFunction(() => location.hash === '#session=cse_a1');
  await page.goBack();
  await page.waitForFunction(() => location.hash === '#sessions');
  check('Back from a session returns to #sessions', await visible('#lists-screen') && (await txt('#lists-screen h2.list-title')) === 'Sessions');
  check('Back to #sessions keeps its filter', (await page.inputValue('#lists-screen input.list-filter')) === 'build');
  await page.goForward();
  await page.waitForFunction(() => location.hash === '#session=cse_a1');
  check('Forward to the session: its title', (await txt('#title')) === 'Fix the build');

  // All chats
  await page.click('#chats-nav');
  await page.waitForFunction(() => location.hash === '#chats');
  const chatRows = await page.$$eval('#lists-screen a.chat-row', l => l.map(a => a.textContent));
  check('sessions are not in All chats', chatRows.join() === 'Chat 2,Chat 1,Chat 0', chatRows.join());

  // A chat, then search
  await page.click('#recents .item[data-id="c1"]');
  await page.waitForFunction(() => location.hash.includes('chat=c1'));
  check('a chat after a session: its title and no session line', (await txt('#title')) === 'Chat 1' && !/Session ·/.test(await txt('#project') || ''));
  await page.locator('.find input').fill('zebra');
  await page.waitForFunction(() => !document.getElementById('results').hidden && document.querySelector('#results .group'));
  const group = await page.$eval('#results .group', g => g.textContent);
  check('search finds a session prompt, labelled Session', /Session/.test(group) && /Fix the build/.test(group), group);
  await page.click('#results .group .snip');
  await page.waitForFunction(() => location.hash.startsWith('#session=cse_a1'));
  await page.waitForSelector('#chat mark');
  const at = await page.evaluate(() => [location.hash, document.querySelector('#chat mark').textContent.toLowerCase(), document.querySelector('#chat mark').closest('.msg').dataset.id]);
  check('search opens the session at the message', at[0] === '#session=cse_a1&msg=a-p1' && at[1] === 'zebra' && at[2] === 'a-p1', JSON.stringify(at));
  await page.locator('.find input').fill('');

  // The hostile session
  await page.evaluate(() => { location.hash = '#session=cse_b2'; });
  await page.waitForFunction(() => document.getElementById('title').textContent.endsWith('Hostile'));
  check('a hostile title is text', (await txt('#title')) === HOSTILE && (await page.title()) === `${HOSTILE} - Claude Takeout` && (await page.locator('#title img, #main img[src="x"]').count()) === 0);
  check('a session with no artifacts: the line without links', /Session · claude-code/.test(await txt('#project') || '') && (await page.locator('#project a').count()) === 0);

  // A one-chat viewer with sessions
  const single = await open('file://' + one);
  await single.waitForSelector('.msg');
  check('a one-chat viewer with sessions shows the entry', await single.locator('#sessions-nav').isVisible() && (await single.textContent('#sessions-nav .n')) === '1');
  await single.click('#sessions-nav');
  await single.waitForFunction(() => location.hash === '#sessions');
  check('a one-chat viewer: #sessions lists it', (await single.$$eval('#lists-screen a.chat-row', l => l.length)) === 1);
  check('a one-chat viewer: no Chats or Projects entry', !(await single.locator('#chats-nav').isVisible()) && !(await single.locator('#projects-nav').isVisible()));
  await single.goBack();
  await single.waitForFunction(() => location.hash.includes('chat=c5'));
  check('a one-chat viewer: Back to its chat', (await single.textContent('#title')) === 'Chat 5');

  // A session's published pages open in the side panel (v1.25.1)
  const pp = await open(`file://${pub}#session=cse_p1`);
  await pp.waitForSelector('#chat .msg');
  const phash = () => pp.evaluate(() => location.hash);
  const cards = await pp.$$eval('#chat .art', l => l.map(c => [c.closest('.msg').dataset.id, c.textContent, c.dataset.file, c.dataset.version]));
  check('a session: one card per publish, in the reply that published it', cards.length === 3 && cards[0][0] === 'call-pt1' && /Shipped page/.test(cards[0][1]) && /v1/.test(cards[0][1])
    && cards[1][0] === 'call-pt2' && /v2/.test(cards[1][1]) && /Not in this export/.test(cards[2][1]), JSON.stringify(cards));
  check('a session: the cards replace the "Published on claude.ai" lines', (await pp.locator('#chat .published').count()) === 0);
  const fileId = cards[1][2];
  check('a session: the card links its artifact and claude.ai', (await pp.locator(`#chat .page-link a.open-artifact[href="#a=${PUB_ID}"]`).count()) >= 1
    && (await pp.locator(`#chat .page-link a[href="https://claude.ai/artifact/${GONE_ID}"]`).count()) === 1);
  check('a session: the panel starts closed', !(await pp.locator('#panel').isVisible()));
  await pp.locator('#chat .art').nth(1).click();
  await pp.waitForFunction(f => location.hash === `#session=cse_p1&file=${encodeURIComponent(f)}&version=1`, fileId);
  await pp.waitForFunction(() => ((document.querySelector('#panel:not([hidden]) iframe.preview') || {}).srcdoc || '').includes('Version two'));
  const doc2 = await pp.locator('#panel iframe.preview').getAttribute('srcdoc');
  check('a card click opens the side panel with the page preview, from its part', doc2.includes('Version two of the shipped page') && doc2.includes('rebeccapurple'), doc2.slice(0, 300));
  check("the page's picture comes from its preview part, as on the Artifacts screen", doc2.includes(`src="${DOT}"`) && !doc2.includes('src="dot.png"'), doc2.slice(0, 600));
  check('the panel names the page and its versions', /Shipped page/.test(await pp.textContent('#panel-head')) && (await pp.locator('#panel-head .ver').count()) === 2);
  await pp.locator('#panel-head .ver', { hasText: 'v1' }).click();
  await pp.waitForFunction(() => ((document.querySelector('#panel iframe.preview') || {}).srcdoc || '').includes('Version one'));
  check('the version menu shows the older version', (await phash()).endsWith('&version=0') && (await pp.locator('#chat .art.on').count()) === 1
    && (await pp.locator('#chat .art.on').getAttribute('data-version')) === '0');
  await pp.goBack();
  await pp.waitForFunction(() => location.hash === '#session=cse_p1');
  check('Back closes the panel', !(await pp.locator('#panel').isVisible()) && (await pp.textContent('#title')) === 'Ship it');
  await pp.goForward();
  await pp.waitForFunction(() => location.hash.includes('&file='));
  await pp.waitForSelector('#panel:not([hidden]) iframe.preview');
  check('Forward opens it again', await pp.locator('#panel').isVisible());
  await pp.locator('#panel-head .close').click();
  await pp.waitForFunction(() => location.hash === '#session=cse_p1');
  check('closing the panel keeps the session', !(await pp.locator('#panel').isVisible()) && (await pp.locator('#chat .msg').count()) > 0);
  // The fold bar: the published artifact opens in the panel, its newest version; one not in the store goes to claude.ai.
  const foldLinks = await pp.$$eval('#project a.session-artifact', l => l.map(a => [a.textContent, a.getAttribute('href')]));
  check('the fold bar links the artifact to the side panel', foldLinks.length === 2 && foldLinks[0][0] === 'Shipped page'
    && foldLinks[0][1] === `#session=cse_p1&file=${encodeURIComponent(fileId)}&version=1`, JSON.stringify(foldLinks));
  await pp.locator('#project a.session-artifact').first().click();
  await pp.waitForFunction(() => ((document.querySelector('#panel:not([hidden]) iframe.preview') || {}).srcdoc || '').includes('Version two'));
  check('the fold-bar link opens the panel', (await phash()).endsWith('&version=1') && !(await pp.locator('#artifacts-screen').isVisible()));
  await pp.goBack();
  await pp.waitForFunction(() => location.hash === '#session=cse_p1');
  check('Back from the fold-bar link closes the panel', !(await pp.locator('#panel').isVisible()));
  // The panel's way to the Artifacts screen.
  await pp.locator('#chat .art').nth(1).click();
  await pp.waitForSelector('#panel:not([hidden])');
  await pp.locator(`#chat .page-link a.open-artifact[href="#a=${PUB_ID}"]`).first().click();
  await pp.waitForFunction(id => location.hash === '#a=' + id, PUB_ID);
  check('Open artifact goes to the Artifacts screen', await pp.locator('#artifacts-screen').isVisible());

  // Opened from a search hit: msg stays in the hash, and a card click doesn't jump back to the hit.
  // The viewer opened with no hash lands on its newest chat, here one opened from an artifact: the line and an Open
  // artifact button, no panel until it is clicked.
  const sh = await open(`file://${pub}`);
  await sh.waitForSelector('#chat .opened-from');
  await sh.waitForTimeout(300);
  check('landing on an artifact chat: the line, no panel', (await sh.evaluate(() => location.hash)) === '#chat=c-open' && !(await sh.locator('#panel').isVisible()));
  await sh.click('#chat .opened-from button.open-artifact');
  await sh.waitForFunction(() => ((document.querySelector('#panel:not([hidden]) iframe.preview') || {}).srcdoc || '').includes('Version two'));
  check('its Open artifact button opens the panel', /^#chat=c-open&file=[^&]+&version=1$/.test(await sh.evaluate(() => location.hash)));
  await sh.locator('.find input').fill('purple');
  await sh.waitForFunction(() => !document.getElementById('results').hidden && document.querySelector('#results .group'));
  await sh.click('#results .group .snip');
  await sh.waitForFunction(() => location.hash === '#session=cse_p1&msg=p-p2');
  await sh.waitForSelector('#chat mark');
  await sh.locator('.find input').fill('');
  const before = await sh.evaluate(() => {
    const card = document.querySelectorAll('#chat .art')[1];
    card.scrollIntoView({ block: 'center' });
    return document.getElementById('scroll').scrollTop;
  });
  await sh.evaluate(() => document.querySelectorAll('#chat .art')[1].click());
  await sh.waitForSelector('#panel:not([hidden]) iframe.preview');
  await sh.waitForTimeout(300);
  const after = await sh.evaluate(() => [document.getElementById('scroll').scrollTop, location.hash]);
  check('after a search hit, a card click opens the panel and the column stays put', Math.abs(after[0] - before) < 2 && /msg=p-p2&file=/.test(after[1]), JSON.stringify([before, after]));
  await sh.locator('#panel-head .ver', { hasText: 'v1' }).click();
  await sh.waitForFunction(() => location.hash.endsWith('&version=0'));
  await sh.waitForTimeout(300);
  check('a version pick keeps the column too', Math.abs((await sh.evaluate(() => document.getElementById('scroll').scrollTop)) - before) < 2);

  // A chat opened from an artifact: the line, and the artifact in the side panel at once.
  const oc = await open(`file://${pub}#chat=c-open`);
  await oc.waitForSelector('#chat .opened-from');
  check('an artifact-opened chat says where it came from', (await oc.textContent('#chat .opened-from a')) === 'Shipped page'
    && (await oc.textContent('#chat .opened-from')).startsWith('Opened from the artifact Shipped page') && (await oc.locator('#chat .opened-from button.open-artifact').count()) === 1, await oc.textContent('#chat .opened-from'));
  await oc.waitForFunction(() => ((document.querySelector('#panel:not([hidden]) iframe.preview') || {}).srcdoc || '').includes('Version two'));
  check('it opens the artifact in the side panel, its current version', /^#chat=c-open&file=[^&]+&version=1$/.test(await oc.evaluate(() => location.hash)), await oc.evaluate(() => location.hash));
  await oc.locator('#panel-head .close').click();
  await oc.waitForFunction(() => !location.hash.includes('file='));
  await oc.waitForTimeout(300);
  check('closing the panel keeps it closed', !(await oc.locator('#panel').isVisible()) && (await oc.locator('#chat .opened-from').count()) === 1);
  await oc.evaluate(() => { location.hash = '#chat=c-gone'; });
  await oc.waitForFunction(() => (document.querySelector('#chat .opened-from') || {}).textContent === 'Opened from an artifact');
  check('one the export lacks has no Open artifact button', (await oc.locator('#chat .opened-from button').count()) === 0);
  const goneLink = await oc.$eval('#chat .opened-from a', a => [a.getAttribute('href'), a.target, a.rel]);
  check('one the export lacks links to claude.ai, no panel', goneLink[0] === `https://claude.ai/artifact/${GONE_ID}` && goneLink[1] === '_blank' && /noopener/.test(goneLink[2])
    && !(await oc.locator('#panel').isVisible()), JSON.stringify(goneLink));
  await oc.evaluate(() => { location.hash = '#chat=c-design'; });
  // A Design: its canvas in the side panel (the Artifacts screen's page, embedded), never claude.ai's loader.
  await oc.waitForFunction(() => { const h = document.querySelector('#panel:not([hidden]) .panel-canvas'); return h && h.shadowRoot && h.shadowRoot.querySelector('.design-board'); });
  const des = await oc.evaluate(() => { const r = document.querySelector('#panel .panel-canvas').shadowRoot;
    const board = r.querySelector('.design-board');
    return { title: board.querySelector('.board-title').textContent, frame: !!board.querySelector('iframe'), home: getComputedStyle(r.getElementById('home')).display,
      pageTitle: getComputedStyle(r.getElementById('page-title')).display, loader: [...r.querySelectorAll('iframe')].some(f => /Loading…/.test(f.srcdoc || '')) }; });
  check('a Design shows its canvas in the side panel', des.title === 'Home board' && des.frame && !des.loader, JSON.stringify(des));
  check('the embedded page has no grid or title of its own', des.home === 'none' && des.pageTitle === 'none', JSON.stringify(des));
  check('it keeps the chat: hash, page title, no note', /^#chat=c-design&file=/.test(await oc.evaluate(() => location.hash)) && (await oc.title()).startsWith('Opened design')
    && (await oc.locator('#panel .design-note').count()) === 0 && !(await oc.locator('#artifacts-screen').isVisible()), await oc.title());
  await oc.locator('#panel-head .close').click();
  await oc.waitForFunction(() => !location.hash.includes('file='));
  check('closing the panel removes the canvas', (await oc.locator('.panel-canvas').count()) === 0);
  await oc.evaluate(() => { location.hash = '#chat=c-msgs'; });
  await oc.waitForFunction(() => document.getElementById('title').textContent === 'Opened and used');
  check('a chat with messages is unchanged', (await oc.locator('#chat .opened-from').count()) === 0 && /A real prompt/.test(await oc.textContent('#chat')) && !(await oc.locator('#panel').isVisible()));
  check('they stay in Recents', (await oc.$$eval('#recents .item', l => l.map(x => x.dataset.id))).includes('c-open'));

  check('no network, no page error', errors.length === 0 && requests.length === 0, errors.concat(requests).join(' | '));
  await browser.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failed ? `${failed} failed` : 'all passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
