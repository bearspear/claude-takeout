// Images from web searches over file:// in Chromium: one mosaic per response holding every search's
// images, a "+N" tile, a card for an image the export didn't save, and the gallery's keys and closing.
const { chromium } = require(process.env.PW);
const fs = require('fs'), os = require('os'), path = require('path');
const { buildHtml } = require('./make-viewer.js');
const { VIEWER_CHECK_BASE64, VIEWER_CHECK_FILE } = require('../../takeout-viewer.js');

const at = n => `2026-05-01T10:${String(n).padStart(2, '0')}:00Z`;
const msg = (uuid, parent, sender, n, content) => ({ uuid, parent_message_uuid: parent, sender, created_at: at(n), content, attachments: [], files: [], files_v2: [] });
const search = (id, query, images) => [
  { type: 'tool_use', id, name: 'image_search', input: { query } },
  { type: 'tool_result', tool_use_id: id, name: 'image_search', content: [{ type: 'text', text: `Found ${images.length}` }, { images }] },
];
const img = (n, extra = {}) => ({ url: `https://img.example/${n}.png`, title: `Picture ${n}`, source: 'example.com', page_url: `https://example.com/${n}`, ...extra });
// A 1x1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const chat = {
  uuid: 'w', name: 'Screws', model: 'claude-x', created_at: at(1), updated_at: at(3), settings: {}, current_leaf_message_uuid: 'a1',
  chat_messages: [
    msg('h1', null, 'human', 1, [{ type: 'text', text: 'show me' }]),
    msg('a1', 'h1', 'assistant', 2, [
      ...search('s1', 'one', [img(1), img(2), img(3)]),
      ...search('s2', 'two', [img(4), img(5), img(1)]),
      { type: 'text', text: 'Here they are.' },
    ]),
  ],
};

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webimages-'));
  const file = path.join(dir, 'viewer.html');
  fs.writeFileSync(path.join(dir, VIEWER_CHECK_FILE), Buffer.from(VIEWER_CHECK_BASE64, 'base64'));
  fs.mkdirSync(path.join(dir, 'images'));
  const saved = {};
  for (const n of [1, 2, 3, 5]) { fs.writeFileSync(path.join(dir, 'images', `k${n}_Picture.png`), PNG); saved[`https://img.example/${n}.png`] = `images/k${n}_Picture.png`; }
  fs.writeFileSync(file, buildHtml([chat], '2026-11-15T12:00:00Z', () => ({ webImages: saved })));
  const browser = await chromium.launch({ executablePath: process.env.CHROME_EXE });
  let failed = 0;
  const check = (n, ok, x = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n} ${ok ? '' : x}`); };
  const page = await (await browser.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const requests = [];
  await page.route('**/*', r => { const u = r.request().url(); if (u.startsWith('file:')) return r.continue(); requests.push(u); return r.abort(); });
  await page.goto('file://' + file + '#chat=w');
  await page.waitForSelector('.msg');

  check('one mosaic for both searches', await page.locator('.web-mosaic').count() === 1);
  const tiles = page.locator('.web-mosaic .tile');
  check('four tiles', await tiles.count() === 4);
  check('the last tile says +1', (await tiles.nth(3).locator('.tile-more').textContent()) === '+1');
  check('an unsaved image takes no tile while saved ones fill them, as on claude.ai', await page.locator('.web-mosaic .tile.not-saved').count() === 0
    && (await tiles.nth(3).getAttribute('aria-label')) === 'View image: Picture 5');
  check('saved images load from images/', await page.evaluate(() => [...document.querySelectorAll('.web-mosaic img')].every(i => i.complete && i.naturalWidth === 1 && /\/images\/k\d_Picture\.png$/.test(i.src))));
  check('site on each tile', (await tiles.nth(0).locator('.tile-site').textContent()) === 'example.com');
  check('caption', (await page.locator('.web-caption').textContent()) === 'Results from the web');

  await tiles.nth(3).click();
  check('a tile opens the gallery at its own picture', (await page.locator('.gallery-nav .pos').textContent()) === '5 of 5');
  await page.keyboard.press('Escape');
  await tiles.nth(1).click();
  const pos = page.locator('.gallery-nav .pos');
  check('gallery opens at the tile', (await pos.textContent()) === '2 of 5');
  check('gallery shows the title and an https page link', (await page.locator('.gallery-info .title').textContent()) === 'Picture 2' && (await page.locator('.gallery-info .open').getAttribute('href')) === 'https://example.com/2');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  check('arrow keys step', (await pos.textContent()) === '4 of 5');
  check('an unsaved image says so', (await page.locator('.gallery-stage').textContent()).includes('not in this export'));
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  check('stops at the last', (await pos.textContent()) === '5 of 5' && await page.locator('.gallery-nav .next').isDisabled());
  await page.keyboard.press('Escape');
  check('Escape closes and returns focus to the tile', await page.locator('.veil.gallery').count() === 0 && await page.evaluate(() => document.activeElement && document.activeElement.classList.contains('tile')));
  check('no network requests', requests.length === 0, requests.join());
  check('no page errors', errors.length === 0, errors.join(' | '));

  await browser.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e.message); process.exit(1); });
