// An Export Artifacts viewer.html over file:// in Chromium: the claude.ai-style grid. Cards newest first, tabs and
// search filter them, empty states, keyboard (Tab and Enter on a card, arrow keys on the tabs, / for search), a
// hostile title stays text, a saved card picture shows and a broken one falls back to the tile, relative times with
// an absolute date in their title, a globe on a public artifact. Artifact pages: #a=<id> routing (unknown -> home),
// the top bar (home, claude.ai link, Open file by the rule, badges), the Docs page, the Design poster, details pages
// (not exported, no start file, too large, other kinds), and a run without viewer-check.gif (tiles, "unzip first", no Open file).
// Previews: a nested page with its CSS, JS, image and a renamed file; a hostile shared page and self-navigations get
// nothing out; white frame in dark mode; forms and alerts; Markdown like the chat viewer; image, SVG, the remote note;
// Show saved files anyway; a shared poster's HTML and SVG rows have no Open file; a missing part says so; WebRTC to a local
// STUN listener gets nothing out of the page (a nested frame still can: logged as KNOWN RESIDUAL, not failed).
// No requests outside file:, no page errors.
// Run: PW=<playwright-core> CHROME_EXE=<chrome> node tests/e2e/artifacts-viewer.e2e.js [screenshot-dir]
const { chromium } = require(process.env.PW);
const fs = require('fs'), os = require('os'), path = require('path'), zlib = require('zlib');
const { runArtifacts } = require('../helpers');
const { HIT, ATTACKS, ATTACK_ENDS, hostileHtml, navArtifact } = require('./hostile');
const dgram = require('dgram');
const { uuidToBase58 } = require('../../export-core.js');

const DOCS_TYPE = 'c8f0b311-af6a-4d22-a07b-61eb818fc35d';
const DESIGN_TYPE = 'd3516e2a-8d6c-4f5e-9a7b-0c1d2e3f4a5b';
const LIVE = '1794783850-4a6e';
const U = n => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const ago = mins => new Date(Date.now() - mins * 60000).toISOString();
const art = (slug, title, extra = {}) => ({ slug, title, typeSlug: '', typeTitle: '', sourceSurface: 'chat', rel: 'mine', live: LIVE, updatedAt: ago(5), createdAt: '2026-10-01T00:00:00Z', ...extra });
const live = (title, files) => ({ title, live: LIVE, versions: { [LIVE]: { files } } });
const HOSTILE_TITLE = `Alpha <img src=x onerror="${HIT}"> & "co"`;

// A real 40x30 PNG, so the browser decodes it.
function png(w, h) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = b => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const rows = Buffer.concat(Array.from({ length: h }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 0x9c)])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
const GOOD = { status: 200, type: 'image/png', body: png(40, 30) };
// Right magic, nothing after it: saved, but the browser can't decode it.
const BROKEN = { status: 200, type: 'image/png', body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]) };

async function exportTo(frames, pages, thumbs) {
  const { raw } = await runArtifacts({ frames, pages, thumbs });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifacts-viewer-'));
  for (const [n, bytes] of Object.entries(raw)) {
    const p = path.join(dir, n);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, bytes);
  }
  if (!fs.existsSync(path.join(dir, 'viewer.html'))) throw new Error('no viewer.html written');
  return dir;
}

(async () => {
  const frames = [
    art(U(1), 'zebra game', { public: true, updatedAt: ago(5) }),
    art(U(2), HOSTILE_TITLE, { updatedAt: ago(70) }),
    art(U(3), 'Plan notes', { typeSlug: DOCS_TYPE, typeTitle: 'Docs', updatedAt: ago(150) }),
    art(U(4), 'Shared deck', { rel: 'shared', updatedAt: ago(3 * 1440 + 10) }),
    art(U(5), 'Undated board', { typeSlug: DESIGN_TYPE, typeTitle: 'Design', updatedAt: 'not a date' }),
  ];
  const pages = {
    [U(1)]: live('zebra game', { 'index.html': '<h1>Zebra page</h1>' }),
    [U(2)]: live('Alpha', { 'index.html': '<h1>Alpha page</h1>' }),
    [U(4)]: live('Shared deck', { 'deck.html': '<h1>Shared page</h1>' }),
    [U(5)]: live('Undated board', { 'index.html': '<h1>Board</h1>' }),
  };
  const dir = await exportTo(frames, pages, { [U(1)]: GOOD, [U(3)]: BROKEN });
  const onlyMine = await exportTo([art(U(7), 'Lonely page')], { [U(7)]: live('Lonely page', { 'index.html': '<h1>x</h1>' }) }, {});

  const browser = await chromium.launch({ executablePath: process.env.CHROME_EXE });
  let failed = 0;
  const check = (n, ok, x = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n} ${ok ? '' : x}`); };
  const open = async (folder, scheme = 'light', hash = '') => {
    const page = await (await browser.newContext({ viewport: { width: 1300, height: 900 }, colorScheme: scheme })).newPage();
    const errors = [], requests = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', r => { const u = r.request().url(); if (u.startsWith('file:')) return r.continue(); requests.push(u); return r.abort(); });
    await page.goto('file://' + path.join(folder, 'viewer.html') + hash);
    await page.waitForSelector(hash ? '#page' : '#grid .card');
    return { page, errors, requests };
  };
  const { page, errors, requests } = await open(dir);
  const titles = () => page.locator('#grid .card .title').allTextContents();

  check('heading', (await page.locator('#home h1').textContent()).trim() === 'Artifacts');
  check('cards newest first, undated last', JSON.stringify(await titles()) === JSON.stringify(['zebra game', HOSTILE_TITLE, 'Plan notes', 'Shared deck', 'Undated board']), JSON.stringify(await titles()));
  check('cards are buttons', await page.locator('#grid .card').evaluateAll(cs => cs.every(c => c.tagName === 'BUTTON')));
  check('hostile title is text, not markup', await page.evaluate(() => window.__hit) === undefined
    && await page.locator('#grid .card').nth(1).locator('.title img').count() === 0);

  const zebra = page.locator('#grid .card').nth(0);
  check('relative time', (await zebra.locator('time').textContent()).trim() === '5m ago', await zebra.locator('time').textContent());
  const abs = await zebra.locator('time').getAttribute('title');
  check('absolute date in the time\'s title', !!abs && /20\d\d/.test(abs), abs);
  check('globe on the public artifact only', await zebra.locator('.globe').count() === 1 && await page.locator('#grid .globe').count() === 1);
  check('kind labels', JSON.stringify(await page.locator('#grid .card .kind').allTextContents()) === JSON.stringify(['Page', 'Page', 'Docs', 'Page', 'Design']), JSON.stringify(await page.locator('#grid .card .kind').allTextContents()));
  check('undated card has no time text', ((await page.locator('#grid .card').nth(4).locator('time').textContent().catch(() => '')) || '').trim() === '');

  const pic = zebra.locator('.pic img');
  await page.waitForFunction(() => { const i = document.querySelector('#grid .card .pic img'); return i && i.complete; });
  check('saved picture shows, lazy', await pic.count() === 1 && await pic.getAttribute('loading') === 'lazy' && await pic.evaluate(i => i.naturalWidth) > 0);
  const plan = page.locator('#grid .card').nth(2);
  await page.waitForFunction(() => document.querySelectorAll('#grid .card')[2].querySelector('.tile'));
  check('broken picture falls back to the tile', await plan.locator('.pic img').count() === 0 && await plan.locator('.tile svg').count() === 1);
  check('no picture: tile', await page.locator('#grid .card').nth(3).locator('.tile svg').count() === 1);
  check('tiles by kind', await plan.locator('.tile').getAttribute('class') === 'tile docs' && await page.locator('#grid .card').nth(4).locator('.tile').getAttribute('class') === 'tile design');

  // Tabs.
  const tabs = page.locator('[role=tablist] [role=tab]');
  check('three tabs', JSON.stringify(await tabs.allTextContents()) === JSON.stringify(['All', 'Yours', 'Shared with you']));
  check('All selected', await tabs.nth(0).getAttribute('aria-selected') === 'true');
  await tabs.nth(2).click();
  check('Shared tab filters', JSON.stringify(await titles()) === JSON.stringify(['Shared deck']), JSON.stringify(await titles()));
  check('Shared tab selected', await tabs.nth(2).getAttribute('aria-selected') === 'true' && await tabs.nth(0).getAttribute('aria-selected') === 'false');
  await page.keyboard.press('ArrowLeft');
  check('ArrowLeft moves to Yours and focuses it', await tabs.nth(1).getAttribute('aria-selected') === 'true' && await tabs.nth(1).evaluate(t => t === document.activeElement));
  check('Yours tab filters', (await titles()).length === 4 && !(await titles()).includes('Shared deck'), JSON.stringify(await titles()));
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  check('ArrowRight wraps to All', await tabs.nth(0).getAttribute('aria-selected') === 'true' && (await titles()).length === 5);
  check('only the selected tab is in the Tab order', JSON.stringify(await tabs.evaluateAll(ts => ts.map(t => t.tabIndex))) === JSON.stringify([0, -1, -1]));

  // Search.
  await page.locator('#home h1').click();
  await page.keyboard.press('/');
  check('/ focuses search', await page.evaluate(() => document.activeElement && document.activeElement.id === 'search'));
  check('/ is not typed into the box', await page.locator('#search').inputValue() === '');
  await page.keyboard.type('ZEB');
  check('search filters by title, any case', JSON.stringify(await titles()) === JSON.stringify(['zebra game']), JSON.stringify(await titles()));
  await page.locator('#search').fill('qqq');
  check('no matches: empty state', (await page.locator('#empty').textContent()).trim() === 'No artifacts match' && await page.locator('#empty').isVisible() && (await titles()).length === 0);
  await page.locator('#search').fill('a');
  await tabs.nth(2).click();
  check('search and tab together', JSON.stringify(await titles()) === JSON.stringify(['Shared deck']), JSON.stringify(await titles()));
  await page.locator('#search').fill('');
  await tabs.nth(0).click();
  check('empty state hidden with results', !(await page.locator('#empty').isVisible()));

  // Keyboard on a card: Tab from search reaches the first card, Enter opens it.
  await page.locator('#search').focus();
  let reached = false;
  for (let i = 0; i < 6 && !reached; i++) {
    await page.keyboard.press('Tab');
    reached = await page.evaluate(() => document.activeElement && document.activeElement.classList.contains('card'));
  }
  check('Tab reaches a card', reached);
  const firstId = await page.evaluate(() => document.activeElement.dataset.id);
  await page.keyboard.press('Enter');
  check('Enter on a card sets #a=<id>', await page.evaluate(() => location.hash) === `#a=${uuidToBase58(U(1))}` && firstId === uuidToBase58(U(1)), await page.evaluate(() => location.hash));
  await page.evaluate(() => { location.hash = ''; });
  await page.locator('#grid .card').nth(3).click();
  check('click on a card sets its hash', await page.evaluate(() => location.hash) === `#a=${uuidToBase58(U(4))}`);

  // Screenshots for review.
  const shots = process.argv[2];
  if (shots) {
    await page.evaluate(() => { location.hash = ''; });
    await page.screenshot({ path: path.join(shots, 'grid-light.png'), fullPage: true });
    const dark = await open(dir, 'dark');
    await dark.page.waitForTimeout(200);
    await dark.page.screenshot({ path: path.join(shots, 'grid-dark.png'), fullPage: true });
    await dark.page.context().close();
  }

  check('no requests outside file:', requests.length === 0, requests.join(' '));
  check('no page errors', errors.length === 0, errors.join(' '));

  // A tab with nothing in it.
  const lonely = await open(onlyMine);
  await lonely.page.locator('[role=tab]', { hasText: 'Shared with you' }).click();
  check('empty Shared tab says so', (await lonely.page.locator('#empty').textContent()).trim() === 'Nothing shared with you' && await lonely.page.locator('#grid .card').count() === 0);
  check('no requests or errors (second export)', lonely.requests.length === 0 && lonely.errors.length === 0, lonely.requests.join(' ') + lonely.errors.join(' '));

  // ---- Artifact pages ----
  const p = n => uuidToBase58(U(n));
  const pagesDir = await exportTo([
    art(U(11), 'Own page'),
    art(U(12), 'Shared page', { rel: 'shared' }),
    art(U(13), 'Plan doc', { typeSlug: DOCS_TYPE, typeTitle: 'Docs', live: '' }),
    art(U(14), 'Board', { typeSlug: DESIGN_TYPE, typeTitle: 'Design' }),
    art(U(15), 'Broken fetch'),
    art(U(16), 'Never published', { live: '' }),
    art(U(17), 'Huge page'),
    art(U(18), 'Shared report', { rel: 'shared' }),
    art(U(19), 'Data only'),
  ], {
    [U(11)]: live('Own page', { 'index.html': '<h1>Own</h1>', 'notes.txt': 'hello', 'app.js': { body: 'x()', type: 'text/javascript', unverified: true } }),
    [U(12)]: live('Shared page', { 'index.html': '<h1>Shared</h1>', 'report.pdf': { body: '%PDF-1.4', type: 'application/pdf' } }),
    [U(14)]: live('Board', { 'index.html': '<h1>Board</h1>' }),
    [U(15)]: { error: { error: 'HTTP 500', status: 500 } },
    [U(17)]: live('Huge page', { 'index.html': '<p>' + 'x'.repeat(2.1 * 1024 * 1024) + '</p>' }),
    [U(18)]: live('Shared report', { 'report.pdf': { body: '%PDF-1.4', type: 'application/pdf' } }),
    [U(19)]: live('Data only', { 'data.csv': { body: 'a,b', type: 'text/csv' } }),
  }, { [U(13)]: GOOD, [U(14)]: GOOD });

  const ap = await open(pagesDir, 'light', `#a=${p(13)}`);
  const pg = ap.page;
  const shown = async () => ({ home: await pg.locator('#home').isVisible(), page: await pg.locator('#page').isVisible() });
  const go = async hash => { await pg.evaluate(h => { location.hash = h; }, hash); await pg.waitForTimeout(50); };
  const body = () => pg.locator('#page-body');
  const shots2 = process.argv[2];

  // Deep link to a Docs artifact.
  check('deep link opens the artifact page', JSON.stringify(await shown()) === JSON.stringify({ home: false, page: true }));
  check('top bar title and kind', (await pg.locator('#page-title').textContent()) === 'Plan doc' && (await pg.locator('#page-kind').textContent()) === 'Docs');
  const claude = pg.locator('#page-links a.open-claude');
  check('Open on claude.ai link', await claude.getAttribute('href') === `https://claude.ai/artifact/${p(13)}` && await claude.getAttribute('rel') === 'noopener noreferrer'
    && await claude.getAttribute('target') === '_blank' && (await claude.textContent()).trim() === 'Open on claude.ai');
  check('Docs page note', /export the chat that made it/.test(await body().locator('.docs-page').textContent()), await body().textContent());
  await pg.waitForFunction(() => { const i = document.querySelector('#page-body .big-pic img'); return i && i.complete && i.naturalWidth > 0; });
  check('Docs page shows the picture large', await body().locator('.big-pic img').count() === 1);
  check('Docs page has a claude.ai link', await body().locator(`a[href="https://claude.ai/artifact/${p(13)}"]`).count() === 1);
  check('Docs page: no Open file', await pg.locator('#page-links a.open-file').count() === 0);
  check('document title names the artifact', (await pg.title()).startsWith('Plan doc'));
  if (shots2) await pg.screenshot({ path: path.join(shots2, 'page-docs.png') });

  // Home button.
  await pg.locator('#home-button').click();
  check('home button returns to the grid', JSON.stringify(await shown()) === JSON.stringify({ home: true, page: false }) && await pg.evaluate(() => location.hash) === '');
  check('grid is there', (await pg.locator('#grid .card').count()) === 9);

  // A click on a card opens its page; browser Back goes home.
  await pg.locator('#grid .card', { hasText: 'Board' }).click();
  await pg.waitForSelector('#page .poster');
  check('card click opens its page', await pg.evaluate(() => location.hash) === `#a=${p(14)}`);
  // Design poster.
  const poster = body().locator('.poster');
  await pg.waitForFunction(() => { const i = document.querySelector('#page-body .poster .big-pic img'); return i && i.complete && i.naturalWidth > 0; });
  check('poster: picture large', await poster.locator('.big-pic img').count() === 1);
  check('poster: needs claude.ai to run (badge and note)', (await pg.locator('#page-badges').textContent()).includes('needs claude.ai to run') && (await poster.textContent()).includes('needs claude.ai to run'));
  check('poster: file list', JSON.stringify(await poster.locator('.files .path').allTextContents()) === JSON.stringify(['index.html']), JSON.stringify(await poster.locator('.files .path').allTextContents()));
  check('poster: claude.ai link', await poster.locator(`a[href="https://claude.ai/artifact/${p(14)}"]`).count() === 1);
  check('poster: own artifact has Open file', await pg.locator('#page-links a.open-file').count() === 1);
  if (shots2) await pg.screenshot({ path: path.join(shots2, 'page-poster.png') });
  await poster.getByRole('button', { name: 'Show saved files anyway' }).click();
  check('Show saved files anyway opens the preview', await body().locator('.preview').count() === 1 && await body().locator('.poster').count() === 0);
  await pg.goBack();
  await pg.waitForTimeout(50);
  check('Back goes home', JSON.stringify(await shown()) === JSON.stringify({ home: true, page: false }));

  // Own HTML page: preview, Open file on the start file, unverified badge.
  await go(`#a=${p(11)}`);
  check('HTML start opens the preview', await body().locator('.preview').count() === 1);
  const own = pg.locator('#page-links a.open-file');
  const ownFolder = JSON.parse(fs.readFileSync(path.join(pagesDir, 'export-manifest.json'), 'utf8')).artifacts.find(a => a.title === 'Own page').folder;
  check('own artifact: Open file links the saved start file', await own.count() === 1 && await own.getAttribute('href') === `${encodeURIComponent(ownFolder)}/${LIVE}/index.html` && await own.getAttribute('target') === '_blank', await own.getAttribute('href'));
  check('unverified badge', (await pg.locator('#page-badges').textContent()).includes("not checked against claude.ai's checksum"));
  check('no needs-claude.ai badge on a plain page', !(await pg.locator('#page-badges').textContent()).includes('needs claude.ai'));

  // Shared HTML page: no Open file.
  await go(`#a=${p(12)}`);
  check('shared HTML artifact: no Open file', await pg.locator('#page-links a.open-file').count() === 0 && await pg.locator('#page-links a.open-claude').count() === 1);
  // Shared PDF: openable, so Open file.
  await go(`#a=${p(18)}`);
  check('shared PDF start: details page with Open file', await body().locator('.details').count() === 1 && await pg.locator('#page-links a.open-file').count() === 1
    && /report\.pdf$/.test(await pg.locator('#page-links a.open-file').getAttribute('href')));

  // Details pages.
  await go(`#a=${p(15)}`);
  check('not exported: details page', await body().locator('.details').count() === 1 && /not exported/i.test(await body().textContent()));
  check('not exported: points to errors.txt', await body().locator('a[href="errors.txt"]').count() === 1);
  check('not exported: no Open file', await pg.locator('#page-links a.open-file').count() === 0);
  await go(`#a=${p(16)}`);
  check('no start file: details page', await body().locator('.details').count() === 1 && /no files were saved/i.test(await body().textContent()), await body().textContent());
  await go(`#a=${p(17)}`);
  check('too large: details page says so', await body().locator('.details').count() === 1 && /too large to show here/.test(await body().textContent()) && await body().locator('.preview').count() === 0);
  await go(`#a=${p(19)}`);
  check('other kind: details page with the file list', await body().locator('.details').count() === 1 && JSON.stringify(await body().locator('.files .path').allTextContents()) === JSON.stringify(['data.csv']));
  check('own data file: Open file', await body().locator('.files a.open-file').count() === 1);
  if (shots2) await pg.screenshot({ path: path.join(shots2, 'page-details.png') });

  // Unknown hashes go home.
  await go('#a=nope');
  check('unknown id: home', JSON.stringify(await shown()) === JSON.stringify({ home: true, page: false }));
  await go(`#a=${p(11)}`);
  await go('#garbage');
  check('malformed hash: home', JSON.stringify(await shown()) === JSON.stringify({ home: true, page: false }));
  check('no requests outside file: (pages)', ap.requests.length === 0, ap.requests.join(' '));
  check('no page errors (pages)', ap.errors.length === 0, ap.errors.join(' '));

  // Not unzipped: no viewer-check.gif.
  fs.unlinkSync(path.join(pagesDir, 'viewer-check.gif'));
  const zipped = await open(pagesDir);
  await zipped.page.waitForTimeout(200);
  const docCard = zipped.page.locator('#grid .card', { hasText: 'Plan doc' });
  check('not unzipped: pictures are tiles', await zipped.page.locator('#grid .card .pic img').count() === 0 && await docCard.locator('.tile').count() === 1);
  await docCard.click();
  await zipped.page.waitForSelector('#page');
  check('not unzipped: opening says to unzip', (await zipped.page.locator('#page-body').textContent()).includes('Unzip the export first, then open viewer.html again.'));
  await zipped.page.locator('#home-button').click();
  await zipped.page.locator('#grid .card', { hasText: 'Own page' }).click();
  await zipped.page.waitForSelector('#page-body .sheet');
  check('not unzipped: no preview', (await zipped.page.locator('#page-body').textContent()).includes('Unzip the export first') && await zipped.page.locator('#page-body .preview').count() === 0, await zipped.page.locator('#page-body').textContent() + ' ' + await zipped.page.evaluate(() => location.hash));
  check('no requests or errors (not unzipped)', zipped.requests.length === 0 && zipped.errors.length === 0, zipped.requests.join(' ') + zipped.errors.join(' '));
  check('not unzipped: no Open file anywhere', await zipped.page.locator('a.open-file').count() === 0);
  await zipped.page.locator('#home-button').click();
  await zipped.page.locator('#grid .card', { hasText: 'Data only' }).click();
  await zipped.page.waitForSelector('#page-body .sheet');
  check('not unzipped: no Open file in a file list', await zipped.page.locator('#page-body .files li').count() === 1 && await zipped.page.locator('a.open-file').count() === 0);

  // ---- Previews ----
  const SITE = '<!doctype html><html><head><link rel="stylesheet" href="./app.css"></head><body><h1 id="t">before</h1><img id="pic" src="img/a.png">'
    + '<script src="app.js"></script><script src="js/Util.js"></script><script src="js/util.js"></script><script src="../../escape.js"></script></body></html>';
  const FORMS = '<form id="f"><input name="q" value="1"><button id="b">Go</button></form><p id="out"></p><button id="al" type="button">Alert</button>'
    + "<script>document.getElementById('f').addEventListener('submit', e => { e.preventDefault(); document.getElementById('out').textContent = 'submitted'; });"
    + "document.getElementById('al').onclick = () => alert('x'); document.body.dataset.ready = '1';</script>";
  // With the storage shim, storage works inside the frame and stays there.
  const attacks = { ...ATTACKS, storage: "(localStorage.setItem('k', 'v'), sessionStorage.setItem('s', 'w'), localStorage.getItem('k') + sessionStorage.getItem('s'))" };
  const attackEnds = { ...ATTACK_ENDS, storage: 'gave vw' };
  const navs = [
    ['navhttps', "location.href = 'https://remote.test/nav';"],
    ['navhttp', "location.href = 'http://remote.test/nav';"],
    ['navlocal', `location.href = 'navlocal_${p(42)}/${LIVE}/index.html';`],
    ['navfile', `location.href = new URL('navfile_${p(43)}/${LIVE}/index.html', document.baseURI).href;`],
    ['navdata', "location.href = 'data:text/html,<script>console.log(%22ESCAPED%22)<\\/script>';"],
    ['navblob', "location.href = URL.createObjectURL(new Blob(['<script>console.log(\"ESCAPED\")<\\/script>'], { type: 'text/html' }));"],
    ['navrefresh', '', '<meta http-equiv="refresh" content="0;url=https://remote.test/refresh">'],
    ['navform', "const f = document.createElement('form'); f.action = 'https://remote.test/form'; f.method = 'post'; document.body.append(f); f.submit();"],
    ['navlink', "const a = document.createElement('a'); a.href = 'https://remote.test/link'; document.body.append(a); a.click();"],
    ['navtoplink', "const a = document.createElement('a'); a.href = 'https://remote.test/top-link'; a.target = '_top'; document.body.append(a); a.click();"],
  ];
  const navUuid = i => U(40 + i);
  // WebRTC: Chrome's CSP doesn't cover it, so the preview removes it. Each case has its own local STUN listener.
  const udpListener = () => new Promise(done => {
    const sock = dgram.createSocket('udp4');
    const got = [];
    sock.on('message', (m, r) => got.push(r.address + ':' + r.port));
    sock.bind(0, '127.0.0.1', () => done({ sock, got, port: sock.address().port }));
  });
  const rtcTop = await udpListener(), rtcNested = await udpListener();
  const rtcTry = (who, port, ctor) => `try { const pc = new (${ctor})({ iceServers: [{ urls: 'stun:127.0.0.1:${port}' }] }); pc.createDataChannel('x');`
    + ` pc.onicecandidate = e => say('cand ' + !!e.candidate); pc.createOffer().then(o => pc.setLocalDescription(o)).then(() => say('offer ok'), e => say('err ' + e.name)); say('made'); } catch (e) { say('threw ' + e.name); }`;
  const RTC_TOP = `<p>rtc</p><script>const say = m => console.log('RTC top ' + m); say('ran'); say('type ' + typeof RTCPeerConnection + ' ' + typeof webkitRTCPeerConnection + ' ' + typeof RTCDataChannel + ' ' + typeof RTCSessionDescription + ' ' + typeof RTCIceCandidate);`
    + ` ${rtcTry('top', rtcTop.port, 'window.RTCPeerConnection')} try { RTCPeerConnection = function () {}; } catch (e) {} try { delete window.RTCPeerConnection; } catch (e) {} say('after ' + typeof RTCPeerConnection);<\/script>`;
  // A frame of its own has a fresh window, with WebRTC in it again: a known residual unless Chrome's policy blocks it.
  const nestedCode = `const say = m => parent.postMessage('RTC nested ' + m, '*'); say('ran'); say('type ' + typeof RTCPeerConnection); ${rtcTry('nested', rtcNested.port, 'window.RTCPeerConnection')}`;
  const RTC_NESTED = `<p>rtc nested</p><script>window.addEventListener('message', e => { if (typeof e.data === 'string' && e.data.startsWith('RTC nested ')) console.log(e.data); }); const f = document.createElement('iframe'); f.srcdoc = '<script>' + ${JSON.stringify(nestedCode)} + '<\\/script>'; document.body.append(f);<\/script>`;
  const prevFrames = [
    art(U(31), 'Nested site'),
    art(U(32), 'Hostile', { rel: 'shared' }),
    art(U(33), 'Forms'),
    art(U(34), 'Notes md'),
    art(U(35), 'Board two', { typeSlug: DESIGN_TYPE, typeTitle: 'Design' }),
    art(U(36), 'Picture'),
    art(U(37), 'Diagram'),
    art(U(38), 'Remote script'),
    art(U(39), 'Shared board', { rel: 'shared', typeSlug: DESIGN_TYPE, typeTitle: 'Design' }),
    art(U(60), 'rtc top', { rel: 'shared' }),
    art(U(61), 'rtc nested', { rel: 'shared' }),
    art(U(62), 'Component'),
    art(U(63), 'Big picture'),
    art(U(64), 'Big shared picture', { rel: 'shared' }),
    ...navs.map(([name], i) => art(navUuid(i), name, { rel: 'shared' })),
  ];
  const prevPages = {
    [U(31)]: live('Nested site', {
      'site/index.html': SITE, 'site/app.css': 'h1#t { color: rgb(1, 2, 3); }', 'site/app.js': "document.getElementById('t').textContent = 'changed by script';",
      'site/img/a.png': { body: png(40, 30), type: 'image/png' }, 'site/js/Util.js': "document.body.dataset.first = '1';", 'site/js/util.js': "document.body.dataset.second = '1';",
      'escape.js': "document.body.dataset.escaped = '1';",
    }),
    [U(32)]: live('Hostile', { 'index.html': hostileHtml(attacks) }),
    [U(33)]: live('Forms', { 'index.html': FORMS }),
    [U(34)]: live('Notes md', { 'notes.md': '# Notes\n\nraw <b>x</b> here\n\n<script>window.__hit = 1</script>\n\n**bold**\n' }),
    [U(35)]: live('Board two', { 'index.html': '<h1 id="t">Board page</h1>' }),
    [U(36)]: live('Picture', { 'pic.png': { body: png(40, 30), type: 'image/png' } }),
    [U(37)]: live('Diagram', { 'd.svg': { body: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><rect id="r" width="100" height="50" fill="red"/></svg>', type: 'image/svg+xml' } }),
    [U(38)]: live('Remote script', { 'index.html': '<script src="https://cdn.remote.test/x.js"></script><p id="t">remote</p>' }),
    [U(60)]: live('rtc top', { 'index.html': RTC_TOP }),
    [U(61)]: live('rtc nested', { 'index.html': RTC_NESTED }),
    [U(62)]: live('Component', { 'App.jsx': 'export default () => <div/>', 'app.js': 'x()' }),
    // Over the 2 MB preview cap (padding after IEND, which the browser ignores): not in the part.
    [U(63)]: live('Big picture', { 'big.png': { body: Buffer.concat([png(40, 30), Buffer.alloc(2200000)]), type: 'image/png' } }),
    [U(64)]: live('Big shared picture', { 'big.png': { body: Buffer.concat([png(40, 30), Buffer.alloc(2200000)]), type: 'image/png' } }),
    [U(39)]: live('Shared board', { 'index.html': '<h1>Shared board</h1>', 'art.svg': { body: '<svg xmlns="http://www.w3.org/2000/svg"/>', type: 'image/svg+xml' }, 'notes.pdf': { body: '%PDF-1.4', type: 'application/pdf' } }),
  };
  navs.forEach(([name, attempt, head], i) => { prevPages[navUuid(i)] = live(name, { 'index.html': navArtifact(name, attempt, head).versions[0] }); });
  const { raw: prevRaw, views: prevViews } = await runArtifacts({ frames: prevFrames, pages: prevPages, thumbs: {} });
  const prevDir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifacts-preview-'));
  for (const [n, bytes] of Object.entries(prevRaw)) { const fp = path.join(prevDir, n); fs.mkdirSync(path.dirname(fp), { recursive: true }); fs.writeFileSync(fp, bytes); }
  const nested = prevViews.find(v => v.title === 'Nested site');
  check('fixture: a file was saved as _2', nested.files.some(f => f.path === 'site/js/util.js' && /_2\.js$/.test(f.savedAs)), JSON.stringify(nested.files));
  check('fixture: the nav folders are where the pages point', prevViews.find(v => v.title === 'navlocal').folder === `navlocal_${p(42)}/${LIVE}`, prevViews.find(v => v.title === 'navlocal').folder);

  const openPrev = async (hash, scheme = 'light') => {
    const context = await browser.newContext({ viewport: { width: 1300, height: 900 }, colorScheme: scheme });
    const page = await context.newPage();
    const seen = { errors: [], requests: [], events: [], logs: [], frames: [], dialogs: [], popups: 0 };
    page.on('pageerror', e => seen.errors.push(e.message));
    page.on('console', m => seen.logs.push(m.text()));
    page.on('request', r => { if (!r.url().startsWith('file:')) seen.events.push(r.url()); });
    page.on('framenavigated', f => { if (f !== page.mainFrame()) seen.frames.push(f.url()); });
    page.on('dialog', d => { seen.dialogs.push(d.message()); d.dismiss().catch(() => {}); });
    context.on('page', () => { seen.popups++; });
    await context.route('**/*', r => { const u = r.request().url(); if (u.startsWith('file:')) return r.continue(); seen.requests.push(u); return r.abort(); });
    const url = 'file://' + path.join(prevDir, 'viewer.html');
    await page.goto(url + hash);
    await page.waitForSelector('#page');
    return { page, seen, context, url };
  };
  const frameOf = async pv => {
    const handle = await pv.page.waitForSelector('#page-body .preview iframe', { timeout: 3000 });
    return handle.contentFrame();
  };
  const waitLog = async (pv, text, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (pv.seen.logs.some(l => l.includes(text))) return true; await pv.page.waitForTimeout(25); } return false; };
  const noFileFrames = seen => seen.frames.every(u => !/^(file|https?|data|blob):/i.test(u));

  // A nested start file with its CSS, JS, image and a file saved as _2.
  const ns = await openPrev(`#a=${p(31)}`);
  const nf = await frameOf(ns);
  await nf.waitForFunction(() => document.getElementById('t').textContent === 'changed by script', null, { timeout: 3000 }).catch(() => {});
  const nsState = await nf.evaluate(() => ({
    color: getComputedStyle(document.getElementById('t')).color, text: document.getElementById('t').textContent,
    img: document.getElementById('pic').naturalWidth, first: document.body.dataset.first, second: document.body.dataset.second, escaped: document.body.dataset.escaped,
  }));
  check('preview: CSS from ./app.css applies', nsState.color === 'rgb(1, 2, 3)', JSON.stringify(nsState));
  check('preview: a script changes the page', nsState.text === 'changed by script', JSON.stringify(nsState));
  check('preview: img/a.png shows', nsState.img > 0, JSON.stringify(nsState));
  check('preview: a file saved as _2 loads by its original path', nsState.first === '1' && nsState.second === '1', JSON.stringify(nsState));
  check('preview: ../../escape.js does not run', nsState.escaped === undefined, JSON.stringify(nsState));
  const frameAttrs = await ns.page.$eval('#page-body .preview iframe', f => ({ sandbox: f.getAttribute('sandbox'), src: f.getAttribute('src'), srcdoc: f.hasAttribute('srcdoc') }));
  check('preview: sandboxed srcdoc frame', frameAttrs.sandbox === 'allow-scripts allow-forms allow-modals' && frameAttrs.src === null && frameAttrs.srcdoc, JSON.stringify(frameAttrs));
  check('preview: the frame has no origin', await nf.evaluate(() => self.origin) === 'null');
  check('preview: no remote note on a page without remote scripts', await ns.page.locator('#page-note').isHidden());
  check('preview: no requests, no frame on a file:, no errors', ns.seen.requests.length === 0 && noFileFrames(ns.seen) && ns.seen.errors.length === 0, JSON.stringify(ns.seen));
  const shotPath = process.argv[2] ? path.join(process.argv[2], 'page-preview.png') : path.join(os.tmpdir(), 'page-preview.png');
  await ns.page.screenshot({ path: shotPath });
  // Back home and in again: the preview is rebuilt.
  await ns.page.locator('#home-button').click();
  check('home clears the preview', await ns.page.locator('#page-body iframe').count() === 0);
  await ns.context.close();

  // A hostile shared artifact.
  const hv = await openPrev(`#a=${p(32)}`);
  const hf = await frameOf(hv);
  await hf.waitForSelector('h1');
  check('hostile: the script ran to the end', await waitLog(hv, 'ATTACK finished yes'), hv.seen.logs.filter(l => l.startsWith('ATTACK')).join(' | '));
  check('hostile: the frame has no origin', hv.seen.logs.includes('ATTACK origin null'));
  for (const [name, end] of Object.entries(attackEnds)) {
    const said = hv.seen.logs.filter(l => l.startsWith(`ATTACK ${name} `)).map(l => l.slice(`ATTACK ${name} `.length));
    check(`hostile: ${name} attempted and ended ${end}`, said[0] === 'ran' && said[1] === end, said.join());
  }
  await hv.page.waitForTimeout(400);
  // Chrome can announce a request it then blocks by policy; none reaches the network (the route), and each
  // announced one has its violation.
  const violations = hv.seen.logs.filter(l => l.startsWith('VIOLATION'));
  check('hostile: no request left the page', hv.seen.requests.length === 0, hv.seen.requests.join(' '));
  check('hostile: every request Chrome started was stopped by the policy', hv.seen.events.every(u => violations.some(v => v.endsWith(' ' + u))), hv.seen.events.join(' ') + ' || ' + violations.join(' | '));
  for (const u of ['https://remote.test/fetch', 'https://remote.test/img.png', 'https://remote.test/tag.png', 'https://remote.test/s.css']) {
    check(`hostile: the policy stopped ${u}`, violations.some(v => v.endsWith(' ' + u)), violations.join(' | '));
  }
  check('hostile: no window opened', hv.seen.popups === 0);
  check('hostile: no frame on a file: or remote URL', noFileFrames(hv.seen), hv.seen.frames.join(' '));
  check('hostile: viewer URL and title unchanged', hv.page.url() === hv.url + `#a=${p(32)}` && (await hv.page.title()) === 'Hostile - Artifacts', hv.page.url() + ' ' + await hv.page.title());
  check("hostile: nothing reached the viewer's storage", await hv.page.evaluate(() => localStorage.length + sessionStorage.length) === 0);
  check('hostile: nothing ran in the viewer', !(await hv.page.evaluate(() => !!window.__hit)));
  check('hostile: no viewer page errors', hv.seen.errors.length === 0, hv.seen.errors.join(' '));
  await hv.context.close();

  // Each navigation in its own artifact.
  for (const [i, [name]] of navs.entries()) {
    const nv = await openPrev(`#a=${p(40 + i)}`);
    await frameOf(nv).catch(() => null);
    const REFUSAL = /Refused to (frame|navigate)|violates the following Content Security Policy|blocked/i;
    const refused = () => nv.seen.logs.some(l => REFUSAL.test(l));
    // Chrome may stop the navigation before the attempt's own log line; the policy's refusal of remote.test
    // shows it ran (navrefresh has no URL of its own, so any refusal counts).
    const refusedFor = (n) => (n === 'navrefresh' ? refused() : nv.seen.logs.some(l => l.includes('remote.test') && REFUSAL.test(l)));
    const ran = await waitLog(nv, `NAV ran ${name}`) || refusedFor(name);
    await nv.page.waitForTimeout(500);
    check(`${name}: the attempt ran`, ran, nv.seen.logs.join(' | '));
    check(`${name}: nothing got out`, !nv.seen.logs.some(l => l.includes('ESCAPED')) && nv.seen.requests.length === 0 && nv.seen.popups === 0, [...nv.seen.logs, ...nv.seen.requests].join(' | '));
    check(`${name}: no frame on a file: or remote URL`, noFileFrames(nv.seen), nv.seen.frames.join(' '));
    check(`${name}: the viewer stays`, nv.page.url() === nv.url + `#a=${p(40 + i)}` && (await nv.page.title()) === `${name} - Artifacts` && nv.seen.errors.length === 0, nv.page.url() + ' ' + nv.seen.errors.join(' '));
    await nv.context.close();
  }

  // Dark mode: the frame stays white with color-scheme normal.
  const dk = await openPrev(`#a=${p(31)}`, 'dark');
  await frameOf(dk);
  const dkStyle = await dk.page.$eval('#page-body .preview iframe', f => { const s = getComputedStyle(f); return { bg: s.backgroundColor, scheme: s.colorScheme }; });
  check('dark: the preview frame is white with color-scheme normal', dkStyle.bg === 'rgb(255, 255, 255)' && dkStyle.scheme === 'normal', JSON.stringify(dkStyle));
  const dkBody = await dk.page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  check('dark: the viewer itself is dark', dkBody !== 'rgb(255, 255, 255)', dkBody);
  await dk.context.close();

  // Forms and alerts.
  const fm = await openPrev(`#a=${p(33)}`);
  const ff = await frameOf(fm);
  // The frame's own script adds the handlers after the form is parsed: wait for it before clicking.
  await ff.waitForFunction(() => document.body && document.body.dataset.ready === '1', null, { timeout: 3000 }).catch(() => {});
  // Clicked from inside the frame: the check is that the sandbox lets the page's own submit handler run, and a
  // coordinate click could miss while the top bar settles.
  await ff.evaluate(() => document.getElementById('b').click());
  await ff.waitForFunction(() => document.getElementById('out').textContent === 'submitted', null, { timeout: 2000 }).catch(() => {});
  const fState = await ff.evaluate(() => ({ out: document.getElementById('out').textContent, ready: document.body.dataset.ready || '', url: location.href })).catch(e => ({ err: e.message }));
  check('forms: a submit handler runs', fState.out === 'submitted', JSON.stringify({ fState, logs: fm.seen.logs.slice(-5), errors: fm.seen.errors }));
  await ff.evaluate(() => document.getElementById('al').click());
  await fm.page.waitForTimeout(200);
  check('alerts: alert() shows a dialog', JSON.stringify(fm.seen.dialogs) === JSON.stringify(['x']), JSON.stringify(fm.seen.dialogs));
  check('forms: no requests, no errors', fm.seen.requests.length === 0 && fm.seen.errors.length === 0, JSON.stringify(fm.seen));
  await fm.context.close();

  // Markdown, image, SVG, remote note.
  const md = await openPrev(`#a=${p(34)}`);
  await md.page.waitForSelector('#page-body .preview .prose h1', { timeout: 3000 }).catch(() => {});
  const mdState = await md.page.evaluate(() => {
    const prose = document.querySelector('#page-body .preview .prose');
    return prose && { h1: prose.querySelector('h1') && prose.querySelector('h1').textContent, text: prose.textContent, b: prose.querySelectorAll('b').length, strong: prose.querySelectorAll('strong').length, scripts: prose.querySelectorAll('script').length, hit: !!window.__hit };
  });
  check('markdown: renders', !!mdState && mdState.h1 === 'Notes' && mdState.strong === 1, JSON.stringify(mdState));
  check('markdown: raw <b>x</b> shows as text', !!mdState && mdState.text.includes('<b>x</b>') && mdState.b === 0, JSON.stringify(mdState));
  check("markdown: a <script> doesn't run", !!mdState && !mdState.hit && mdState.scripts === 0, JSON.stringify(mdState));
  await md.page.goto(md.url + `#a=${p(36)}`);
  await md.page.waitForFunction(() => { const i = document.querySelector('#page-body .preview img'); return i && i.complete && i.naturalWidth > 0; }, null, { timeout: 3000 }).catch(() => {});
  const imgSrc = await md.page.$eval('#page-body .preview img', i => i.getAttribute('src')).catch(() => null);
  check('image: shown from the part', !!imgSrc && imgSrc.startsWith('data:image/png;base64,'), String(imgSrc).slice(0, 40));
  check('fixture: the big pictures are too large', prevViews.filter(v => /^Big/.test(v.title)).every(v => v.tooLarge && v.startKind === 'image'), JSON.stringify(prevViews.filter(v => /^Big/.test(v.title))));
  await md.page.goto(md.url + `#a=${p(63)}`);
  await md.page.waitForFunction(() => { const i = document.querySelector('#page-body .preview img'); return i && i.complete && i.naturalWidth > 0; }, null, { timeout: 3000 }).catch(() => {});
  const bigSrc = await md.page.$eval('#page-body .preview img', i => i.getAttribute('src')).catch(() => null);
  check("own image too large for the part: shown from its saved file", !!bigSrc && /^Big_picture_[^/]+\/1794783850-4a6e\/big\.png$/.test(bigSrc)
    && await md.page.$eval('#page-body .preview img', i => i.naturalWidth) === 40, String(bigSrc));
  await md.page.goto(md.url + `#a=${p(64)}`);
  await md.page.waitForSelector('#page-body .details', { timeout: 3000 }).catch(() => {});
  check("shared image too large: details page", await md.page.locator('#page-body .preview').count() === 0 && /too large to show here/.test(await md.page.locator('#page-body').textContent()));
  await md.page.goto(md.url + `#a=${p(37)}`);
  const sf = await frameOf(md);
  check('svg: shown in the sandboxed frame', await sf.waitForSelector('#r', { timeout: 3000 }).then(() => true).catch(() => false));
  await md.page.goto(md.url + `#a=${p(38)}`);
  await frameOf(md);
  check('remote script: the note shows', await md.page.locator('#page-note').isVisible()
    && (await md.page.locator('#page-note').textContent()) === 'This page loads a script from the internet, which the viewer blocks, so it may not work here.', await md.page.locator('#page-note').textContent());
  check('no note mentions a code view', !/code view/i.test(await md.page.locator('#page').textContent()));

  // React start: straight to the details page, no part load, no Loading.
  const partLoads = () => md.page.evaluate(() => performance.getEntriesByType('resource').filter(e => /part-\d+\.js$/.test(e.name)).length);
  await md.page.goto(md.url + `#a=${p(62)}`);
  await md.page.waitForSelector('#page-body .details');
  check('react start: details page at once, no part loaded', await md.page.locator('#page-body .preview').count() === 0 && await partLoads() === 0
    && /source code that needs claude\.ai to run/.test(await md.page.locator('#page-body').textContent()), await md.page.locator('#page-body').textContent());
  check('markdown/image/svg: no requests, no errors', md.seen.requests.length === 0 && md.seen.errors.length === 0, JSON.stringify(md.seen));

  // Show saved files anyway on a Design poster.
  await md.page.goto(md.url + `#a=${p(35)}`);
  await md.page.getByRole('button', { name: 'Show saved files anyway' }).click();
  const bf = await frameOf(md);
  check('Show saved files anyway opens the Design preview', await bf.waitForSelector('#t', { timeout: 3000 }).then(h => h.textContent()).catch(() => null) === 'Board page');

  // A shared Design poster: no Open file on its HTML or SVG rows.
  await md.page.goto(md.url + `#a=${p(39)}`);
  await md.page.waitForSelector('#page-body .poster');
  const rows = await md.page.$$eval('#page-body .files li', lis => lis.map(li => [li.querySelector('.path').textContent, !!li.querySelector('a.open-file')]));
  check('shared poster: no Open file on .html and .svg rows', JSON.stringify(rows) === JSON.stringify([['index.html', false], ['art.svg', false], ['notes.pdf', true]]), JSON.stringify(rows));
  check('shared poster: no top-bar Open file', await md.page.locator('#page-links a.open-file').count() === 0);
  await md.context.close();

  // WebRTC from the preview's own window gets nothing out.
  const rt = await openPrev(`#a=${p(60)}`);
  await frameOf(rt);
  await waitLog(rt, 'RTC top threw');
  await rt.page.waitForTimeout(1500);
  const topSaid = rt.seen.logs.filter(l => l.startsWith('RTC top'));
  check('webrtc: the attempt ran', topSaid.includes('RTC top ran'), topSaid.join(' | '));
  check('webrtc: every name is gone and stays gone', topSaid.includes('RTC top type undefined undefined undefined undefined undefined') && topSaid.includes('RTC top after undefined'), topSaid.join(' | '));
  check('webrtc: no peer connection could be made', topSaid.some(l => l.startsWith('RTC top threw')) && !topSaid.includes('RTC top made'), topSaid.join(' | '));
  check('webrtc: no packet reached the local STUN listener', rtcTop.got.length === 0, rtcTop.got.join(' '));
  check('webrtc: no viewer page errors', rt.seen.errors.length === 0, rt.seen.errors.join(' '));
  await rt.context.close();
  // From a nested frame's fresh window: logged, not failed, so the gap stays visible.
  const rn = await openPrev(`#a=${p(61)}`);
  await frameOf(rn);
  await waitLog(rn, 'RTC nested ran');
  await rn.page.waitForTimeout(1500);
  const nestedRtc = rn.seen.logs.filter(l => l.startsWith('RTC nested'));
  check('webrtc nested: the attempt ran', nestedRtc.includes('RTC nested ran'), nestedRtc.join(' | '));
  console.log(`${rtcNested.got.length ? 'KNOWN RESIDUAL' : 'INFO'}  webrtc from a nested frame's window: ${rtcNested.got.length} STUN packet(s) reached 127.0.0.1 (${nestedRtc.join(' | ')})`);
  check('webrtc nested: no viewer page errors', rn.seen.errors.length === 0, rn.seen.errors.join(' '));
  await rn.context.close();
  rtcTop.sock.close();
  rtcNested.sock.close();

  // An older version from the version menu: its own page, with its own sibling files.
  const histDir = await exportTo([art(U(8), 'History page')], { [U(8)]: { title: 'History page', live: LIVE, history: ['v1', LIVE], versions: {
    v1: { files: { 'index.html': '<link rel="stylesheet" href="style.css"><h1>Old</h1><!--V1-->', 'style.css': 'h1{color:rgb(1,2,3)}' } },
    [LIVE]: { files: { 'index.html': '<h1>New</h1>' } },
  } } }, {});
  const histView = await open(histDir, 'light', `#a=${uuidToBase58(U(8))}`);
  const menu = histView.page.locator('#page-from select');
  check('history: the version menu lists every version, oldest first', JSON.stringify(await menu.locator('option').allTextContents()) === JSON.stringify(['v1', 'v2 (current)']), JSON.stringify(await menu.locator('option').allTextContents()));
  await menu.selectOption({ label: 'v1' }, { timeout: 3000 }).catch(() => {});
  await histView.page.waitForSelector('#page-body .preview iframe', { timeout: 3000 }).catch(() => {});
  const oldDoc = await histView.page.$eval('#page-body .preview iframe', f => f.getAttribute('srcdoc')).catch(() => '');
  check('history: v1 previews its own page and its own stylesheet', oldDoc.includes('<!--V1-->') && oldDoc.includes('rgb(1,2,3)'), oldDoc.slice(0, 200));
  check('history: its Open file is in its own folder', decodeURIComponent((await histView.page.locator('#page-links a.open-file').getAttribute('href', { timeout: 3000 }).catch(() => '')) || '').endsWith('/v1/index.html'));
  check('history: no page errors, no requests', histView.errors.length === 0 && histView.requests.length === 0, JSON.stringify([histView.errors, histView.requests]));

  // A missing part says so.
  for (const n of fs.readdirSync(path.join(prevDir, 'viewer-files'))) if (/^part-\d+\.js$/.test(n)) fs.unlinkSync(path.join(prevDir, 'viewer-files', n));
  const mp = await openPrev(`#a=${p(31)}`);
  await mp.page.waitForFunction(() => /couldn't load/.test(document.getElementById('page-body').textContent), null, { timeout: 3000 }).catch(() => {});
  check('a missing part says so', (await mp.page.locator('#page-body').textContent()).includes("The artifact couldn't load, because viewer-files/ is missing or blocked.") && await mp.page.locator('#page-body iframe').count() === 0,
    await mp.page.locator('#page-body').textContent());
  check('a missing part: no page errors', mp.seen.errors.length === 0, mp.seen.errors.join(' '));
  await mp.context.close();

  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
