// An Export All viewer.html with artifacts, over file:// in Chromium: the chat viewer with the Artifacts screen.
// The sidebar's Artifacts entry with its count; the screen in place of the chat, with the grid and its tabs; a card
// opens #a=<id> with the sandboxed preview, inside its guard frame; Back and the home button return to the grid; a
// chat in the sidebar still opens, and history goes back and forth; / searches the artifacts on their screen; a
// reused page links its file in published/. A hostile shared artifact gets nothing out and can't reach the viewer,
// and navigations to file: (an export file, an absolute path, a refresh, a link) are refused; data: and blob: are
// refused by the guard frame's own frame-src 'none', which the page's policy doesn't have. An export with the
// setting off has no Artifacts entry. No requests outside file:, no page errors.
// Run: PW=<playwright-core> CHROME_EXE=<chrome> node tests/e2e/combined.e2e.js
const { chromium } = require(process.env.PW);
const fs = require('fs'), os = require('os'), path = require('path'), vm = require('vm');
const { exportPopup, assetRoutes, publishedFetcher } = require('../helpers');
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

// A chat that only talks, and one that writes a page and publishes it as artifact U(9).
const plainChat = {
  uuid: 'chat-plain', name: 'Plain talk', model: 'claude-x', created_at: at(1), updated_at: at(2), settings: {}, current_leaf_message_uuid: 'pa1',
  chat_messages: [msg('ph1', null, 'human', 1, [{ type: 'text', text: 'hello there' }]), msg('pa1', 'ph1', 'assistant', 2, [{ type: 'text', text: 'Hi, plain reply.' }])],
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
const chats = { [plainChat.uuid]: plainChat, [pubChat.uuid]: pubChat };
const list = Object.values(chats).map(c => ({ uuid: c.uuid, name: c.name, updated_at: c.updated_at }));

// Export All through the popup, with its artifact step: a ZIP (megaFormat zip), unzipped into a new folder.
async function exportAll({ frames, pages, off = false }) {
  const JSZip = require('../../jszip.min.js');
  const sb = exportPopup({ routes: assetRoutes() }).sandbox;
  const store = {};
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
  ];
  const pages = {
    [U(1)]: live('Guide page', {
      'index.html': '<!doctype html><link rel="stylesheet" href="app.css"><h1 id="t">Guide page body</h1>'
        + "<script>const say = () => console.log('GUIDE ' + [getComputedStyle(document.getElementById('t')).color, self.origin, document.querySelector('meta[http-equiv]').content.split(';')[0]].join(' | ')); say(); setTimeout(say, 120);</script>",
      'app.css': 'h1#t { color: rgb(1, 2, 3); }',
    }),
    [U(2)]: live('Hostile', { 'index.html': hostileHtml(attacks) }),
    [U(3)]: live('Shared deck', { 'deck.html': '<h1>Shared page</h1>' }),
    [U(9)]: live('Guide', { 'index.html': GUIDE }),
  };
  // The navigations need a real file's absolute path in their text, so it's in a folder made ahead of the export.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'combined-nav-'));
  fs.writeFileSync(path.join(base, 'escape.html'), "<!doctype html><script>console.log('ESCAPED')</script>");
  navs(base).forEach(([name, attempt, head], i) => {
    frames.push(art(U(40 + i), name, { rel: 'shared', updatedAt: at(10) }));
    pages[U(40 + i)] = live(name, { 'index.html': navArtifact(name, attempt, head).versions[0] });
  });
  const { dir, data } = await exportAll({ frames, pages });
  const { dir: offDir, data: offData } = await exportAll({ frames, pages, off: true });

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
  check('tabs All / Yours / Shared with you', JSON.stringify(await tabs.allTextContents()) === JSON.stringify(['All', 'Yours', 'Shared with you']));
  const titles = () => page.locator('#artifacts-screen #grid .card .title').allTextContents();
  check('cards, newest first', JSON.stringify(await titles()) === JSON.stringify(['Guide page', 'Hostile', 'Shared deck', 'Guide', ...navs(base).map(n => n[0]).sort()]), JSON.stringify(await titles()));
  await tabs.nth(1).click();
  check('Yours filters', JSON.stringify(await titles()) === JSON.stringify(['Guide page', 'Guide']), JSON.stringify(await titles()));
  await tabs.nth(2).click();
  check('Shared filters', (await titles()).length === frames.length - 2, JSON.stringify(await titles()));
  await tabs.nth(0).click();
  check('the screen keeps its own look (its CSS, not the chat viewer\'s)', await page.locator('#artifacts-screen #grid').evaluate(g => getComputedStyle(g).display) === 'grid'
    && await page.locator('#artifacts-screen .card').first().evaluate(c => getComputedStyle(c).borderRadius) === '10px');
  check('its CSS stays in it', await page.evaluate(() => getComputedStyle(document.querySelector('#chat-list .item')).borderRadius) === '8px');

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
  await page.locator('#artifacts-nav').click();
  await page.waitForSelector('#artifacts-screen #grid .card');
  await page.locator('#chat-list .item', { hasText: 'Plain talk' }).click();
  check('the same chat again, from the screen', await shown(page, '#scroll') && (await page.locator('#title').textContent()) === 'Plain talk' && await page.title() === 'Plain talk - Claude Takeout');
  await page.locator('#chat').click();
  await page.keyboard.press('/');
  check('/ on a chat still searches the chats', await page.evaluate(() => document.activeElement && document.activeElement.getAttribute('aria-label') === 'Search all chats'));
  check('no requests, no errors', v.seen.requests.length === 0 && v.seen.errors.length === 0, JSON.stringify([v.seen.requests, v.seen.errors]));
  await v.context.close();

  // Opened at an artifact's hash: its page, straight away.
  const direct = await open(dir, `#a=${p(3)}`);
  await direct.page.waitForSelector('#artifacts-screen #page:not([hidden])');
  check('opened at #a=<id>: the artifact', (await direct.page.locator('#artifacts-screen #page-title').textContent()) === 'Shared deck' && !(await shown(direct.page, '#scroll')));
  await direct.page.evaluate(() => { location.hash = '#a=NoSuchId'; });
  await direct.page.waitForSelector('#artifacts-screen #home:not([hidden])');
  check('an unknown id: the grid', await direct.page.evaluate(() => location.hash) === '#artifacts');
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
  check('setting off: no requests, no errors', off.seen.requests.length === 0 && off.seen.errors.length === 0, JSON.stringify([off.seen.requests, off.seen.errors]));
  await off.context.close();

  await browser.close();
  console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
