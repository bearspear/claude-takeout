// An Export Artifacts viewer.html over file:// in Chromium: the claude.ai-style grid. Cards newest first, tabs and
// search filter them, empty states, keyboard (Tab and Enter on a card, arrow keys on the tabs, / for search), a
// hostile title stays text, a saved card picture shows and a broken one falls back to the tile, relative times with
// an absolute date in their title, a globe on a public artifact. No requests outside file:, no page errors.
// Run: PW=<playwright-core> CHROME_EXE=<chrome> node tests/e2e/artifacts-viewer.e2e.js [screenshot-dir]
const { chromium } = require(process.env.PW);
const fs = require('fs'), os = require('os'), path = require('path'), zlib = require('zlib');
const { runArtifacts } = require('../helpers');
const { HIT } = require('./hostile');
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
const GOOD = { base64: png(40, 30).toString('base64'), type: 'image/png' };
// Right magic, nothing after it: saved, but the browser can't decode it.
const BROKEN = { base64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]).toString('base64'), type: 'image/png' };

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
  const open = async (folder, scheme = 'light') => {
    const page = await (await browser.newContext({ viewport: { width: 1300, height: 900 }, colorScheme: scheme })).newPage();
    const errors = [], requests = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', r => { const u = r.request().url(); if (u.startsWith('file:')) return r.continue(); requests.push(u); return r.abort(); });
    await page.goto('file://' + path.join(folder, 'viewer.html'));
    await page.waitForSelector('#grid .card');
    return { page, errors, requests };
  };
  const { page, errors, requests } = await open(dir);
  const titles = () => page.locator('#grid .card .title').allTextContents();

  check('heading', (await page.locator('h1').textContent()).trim() === 'Artifacts');
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
  await page.locator('h1').click();
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

  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
