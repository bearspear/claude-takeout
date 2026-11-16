// claude.ai's product cards over file:// in Chromium: a carousel with arrows and dots, a featured card, a
// comparison table, pictures from images/ (a card for one not saved), the question tool hidden, citation
// pills with the site's name, and a search line with its query.
const { chromium } = require(process.env.PW);
const fs = require('fs'), os = require('os'), path = require('path');
const { buildHtml } = require('./make-viewer.js');
const { VIEWER_CHECK_BASE64, VIEWER_CHECK_FILE } = require('../../takeout-viewer.js');

const at = n => `2026-05-01T10:${String(n).padStart(2, '0')}:00Z`;
const msg = (uuid, parent, sender, n, content) => ({ uuid, parent_message_uuid: parent, sender, created_at: at(n), content, attachments: [], files: [], files_v2: [] });
const use = (id, name, input) => ({ type: 'tool_use', id, name, input });
const res = (id, name, content) => ({ type: 'tool_result', tool_use_id: id, name, content });
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const product = (n) => ({ name: `Headphone ${n}`, price: `~$${100 + n}`, blurb: `Blurb ${n}.` });
const imgs = (n) => [0, 1, 2].map(m => ({ id: `product_${n}_${m}`, url: `https://img.example/${n}_${m}.png`, title: `P${n}`, source: `site${m}.com` }));

const chat = {
  uuid: 'k', name: 'Cards', model: 'claude-x', created_at: at(1), updated_at: at(5), settings: {}, current_leaf_message_uuid: 'a2',
  chat_messages: [
    msg('h1', null, 'human', 1, [{ type: 'text', text: 'options?' }]),
    msg('a1', 'h1', 'assistant', 2, [
      use('s1', 'web_search', { query: 'best open back' }), res('s1', 'web_search', []),
      { type: 'text', text: 'A few worth looking at.', citations: [{ end_index: 3, url: 'https://www.soundguys.com/x', title: 'Review', metadata: { site_name: 'SoundGuys', site_domain: 'soundguys.com' } }] },
      use('c1', 'product_carousel_display_v0', { products: [0, 1, 2, 3].map(product) }),
      res('c1', 'product_carousel_display_v0', [{ type: 'text', text: '{}' }, { images: [0, 1, 2, 3].flatMap(imgs) }]),
      use('q1', 'ask_user_input_v0', { questions: [{ type: 'single_select', question: 'Need a mic?', options: ['Yes', 'No'] }] }),
      res('q1', 'ask_user_input_v0', [{ type: 'text', text: '{}' }]),
      { type: 'text', text: 'Pricing varies.' },
    ]),
    msg('h2', 'a1', 'human', 3, [{ type: 'text', text: 'Q: Need a mic?\nA: No' }]),
    msg('a2', 'h2', 'assistant', 4, [
      use('f1', 'featured_card_display_v0', { products: [product(9)], summary: 'My pick.' }), res('f1', 'featured_card_display_v0', [{ type: 'text', text: '{}' }, { images: imgs(0).map((i, m) => ({ ...i, id: `product_0_${m}` })) }]),
      use('m1', 'comparison_card_display_v0', { products: [
        { name: 'A', price: '$1', attributes: [{ label: 'Design', value: 'Open' }, { label: 'Mic', value: 'No' }] },
        { name: 'B', price: '$2', attributes: [{ label: 'Design', value: 'Closed' }, { label: 'Mic', value: 'Yes' }] }] }),
      res('m1', 'comparison_card_display_v0', [{ type: 'text', text: '{}' }]),
      { type: 'text', text: 'That is it.' },
    ]),
  ],
};

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cards-'));
  const file = path.join(dir, 'viewer.html');
  fs.writeFileSync(path.join(dir, VIEWER_CHECK_FILE), Buffer.from(VIEWER_CHECK_BASE64, 'base64'));
  fs.mkdirSync(path.join(dir, 'images'));
  const saved = {};
  for (const n of [0, 1, 2, 3]) for (const m of [0, 1, 2]) {
    if (n === 0 && m === 2) continue;  // one picture the site refused
    fs.writeFileSync(path.join(dir, 'images', `i${n}${m}.png`), PNG);
    saved[`https://img.example/${n}_${m}.png`] = `images/i${n}${m}.png`;
  }
  fs.writeFileSync(file, buildHtml([chat], '2026-11-15T12:00:00Z', () => ({ webImages: saved })));
  const browser = await chromium.launch({ executablePath: process.env.CHROME_EXE });
  let failed = 0;
  const check = (n, ok, x = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n} ${ok ? '' : x}`); };
  const page = await (await browser.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const requests = [];
  await page.route('**/*', r => { const u = r.request().url(); if (u.startsWith('file:')) return r.continue(); requests.push(u); return r.abort(); });
  await page.goto('file://' + file + '#chat=k');
  await page.waitForSelector('.msg');

  const first = page.locator('.msg.assistant').first();
  const kids = await first.evaluate(s => [...s.children].map(c => c.matches('.products.carousel') ? 'C' : c.matches('.prose') ? 'P' : c.matches('details') ? 'S' : '').join(''));
  check('the carousel shows where Claude placed it, between the texts', /^SPC.*P/.test(kids), kids);
  check('the question tool is not shown', !(await first.textContent()).includes('Need a mic?'));
  const search = first.locator(':scope > details.tool > summary');
  check('a search line shows its query', (await search.locator('.label').textContent()).trim() === 'Searched the web' && (await search.locator('.gist').textContent()) === 'best open back');
  check('a citation is a pill with the site name', (await first.locator('.cite a').textContent()) === 'SoundGuys');
  const cards = first.locator('.carousel-track > .product');
  check('four product cards', await cards.count() === 4);
  check('a card has its name, blurb and price', (await cards.nth(1).locator('.product-name').textContent()) === 'Headphone 1' && (await cards.nth(1).locator('.product-blurb').textContent()) === 'Blurb 1.' && (await cards.nth(1).locator('.product-price').textContent()) === '~$101');
  check('pictures load from images/, three per card, the site on each', await cards.nth(1).locator('.pic img').evaluateAll(i => i.length === 3 && i.every(x => x.complete && x.naturalWidth === 1)) && (await cards.nth(1).locator('.tile-site').first().textContent()) === 'site0.com');
  check('a picture not saved says so', (await cards.nth(0).locator('.pic.missing').textContent()) === 'Image unavailable');
  const prev = first.locator('.carousel-nav .prev'), next = first.locator('.carousel-nav .next');
  check('dots, one per card, the first on; Previous off', await first.locator('.carousel-dots span').count() === 4 && await first.locator('.carousel-dots span.on').count() === 1 && await prev.isDisabled());
  await next.click();
  await page.waitForTimeout(700);
  check('Next scrolls the cards', await first.locator('.carousel-track').evaluate(t => t.scrollLeft > 0) && !(await prev.isDisabled()));
  await cards.nth(1).locator('.pic').first().click();
  check('a picture opens the gallery', (await page.locator('.gallery-nav .pos').textContent()) === '1 of 3');
  await page.keyboard.press('Escape');
  const second = page.locator('.msg.assistant').nth(1);
  check('a featured card is one wide card', await second.locator('.products.featured .product').count() === 1 && (await second.locator('.products.featured .product-name').textContent()) === 'Headphone 9');
  const rows = second.locator('.compare .compare-row');
  check('a comparison is a table: names and prices, then a row per attribute', await rows.count() === 3
    && (await rows.nth(0).textContent()).replace(/\s+/g, '') === 'A$1B$2' && (await rows.nth(2).textContent()).replace(/\s+/g, '') === 'MicNoMicYes');
  check('no network requests', requests.length === 0, requests.join());
  check('no page errors', errors.length === 0, errors.join(' | '));

  await browser.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e.message); process.exit(1); });
