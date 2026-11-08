// Branch switching by keyboard, search highlights, Sources on plain-text responses, the phone panel
// header, and the syntax-color queue, over file:// in Chromium.
const { chromium } = require(process.env.PW);
const fs = require('fs'), os = require('os'), path = require('path');
const { buildHtml } = require('./make-viewer.js');
const { VIEWER_CHECK_BASE64, VIEWER_CHECK_FILE } = require('../../takeout-viewer.js');

const at = n => `2026-05-01T10:${String(n).padStart(2, '0')}:00Z`;
const msg = (uuid, parent, sender, n, content, extra = {}) =>
  ({ uuid, parent_message_uuid: parent, sender, created_at: at(n), content, attachments: [], files: [], files_v2: [], ...extra });
const text = t => [{ type: 'text', text: t }];
// Over EMPHASIS_LIMIT underscores, so it is shown as plain text.
const PLAIN = 'snake_case '.repeat(4200) + 'end of answer';
const PY = 'def f(x):\n    return x * 2  # double\n';

function conversation() {
  const messages = [
    msg('h1', null, 'human', 1, text('first question')),
    msg('a1', 'h1', 'assistant', 2, text('version one')),
    msg('a2', 'h1', 'assistant', 3, text('version two')),
    msg('a3', 'h1', 'assistant', 4, text('version three')),
    msg('h2', 'a3', 'human', 5, text('tell me about zebrafinch')),
    msg('a4', 'h2', 'assistant', 6, [{ type: 'text', text: PLAIN, citations: [{ url: 'https://example.com/one', title: 'Source One', end_index: 20 }, { url: 'https://example.com/two', title: 'Source Two', end_index: 40 }] }]),
    msg('h3', 'a4', 'human', 7, text('and the quokka')),
    msg('a5', 'h3', 'assistant', 8, [{ type: 'text', text: 'Made it.' }, { type: 'tool_use', id: 't1', name: 'create_file', input: { path: '/mnt/user-data/outputs/calc.py', file_text: PY } }]),
  ];
  return { uuid: 'nav', name: 'Navigation', model: 'claude-x', created_at: at(1), updated_at: at(8), settings: {}, current_leaf_message_uuid: 'a5', chat_messages: messages };
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nav-'));
  const file = path.join(dir, 'viewer.html');
  fs.writeFileSync(path.join(dir, VIEWER_CHECK_FILE), Buffer.from(VIEWER_CHECK_BASE64, 'base64'));
  fs.writeFileSync(file, buildHtml([conversation()], '2026-11-08T12:00:00Z', () => ({
    artifacts: { 'calc.py': PY },
    artifactIndex: { '/mnt/user-data/outputs/calc.py': { path: '/mnt/user-data/outputs/calc.py', filename: 'calc.py', versions: ['calc.py'], messages: ['a5'] } },
  })));
  const browser = await chromium.launch({ executablePath: process.env.CHROME_EXE });
  let failed = 0;
  const check = (n, ok, x = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n} ${ok ? '' : x}`); };
  const errors = [];
  const open = async (viewport = { width: 1300, height: 900 }) => {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await page.route('**/*', r => (r.request().url().startsWith('file:') ? r.continue() : r.abort()));
    await page.goto('file://' + file);
    await page.waitForSelector('.msg');
    return { page, context };
  };

  const { page, context } = await open();

  // Keyboard branch switching keeps focus on the control.
  const focusedIn = () => page.evaluate(() => {
    const a = document.activeElement;
    const m = a && a.closest('.msg');
    return m ? `${m.dataset.id}:${a.dataset.dir}` : (a ? a.tagName : 'none');
  });
  await page.focus('.msg[data-id="a3"] .branch button[data-dir="-1"]');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.msg[data-id="a2"]');
  check('after Previous version, focus stays on the control', (await focusedIn()) === 'a2:-1', await focusedIn());
  await page.keyboard.press('Enter');
  await page.waitForSelector('.msg[data-id="a1"]');
  check('at the first version, focus moves to Next version', (await focusedIn()) === 'a1:1', await focusedIn());
  await page.keyboard.press('Enter');
  await page.waitForSelector('.msg[data-id="a2"]');
  check('Next version keeps focus too', (await focusedIn()) === 'a2:1', await focusedIn());
  await page.goto('file://' + file + '#chat=nav&leaf=a5');
  await page.waitForSelector('.msg[data-id="a5"]');

  // Plain-text responses keep their Sources.
  const plain = page.locator('.msg[data-id="a4"]');
  check('a long response is shown as plain text', (await plain.locator('.plain-note').count()) === 1);
  check('and still lists its sources', (await plain.locator('.sources li').count()) === 2, await plain.innerHTML().then(h => h.slice(-300)));

  // Search highlights don't pile up.
  const search = async q => {
    await page.fill('.find input', q);
    await page.waitForFunction(word => [...document.querySelectorAll('#results .hit small')].some(h => h.textContent.toLowerCase().includes(word)), q);
    await page.locator('#results .hit', { has: page.locator('small') }).first().click();
    await page.waitForFunction(word => [...document.querySelectorAll('#chat mark')].some(m => m.textContent.toLowerCase() === word), q, { timeout: 4000 });
  };
  await search('zebrafinch');
  await search('quokka');
  const marks = await page.$$eval('#chat mark', ms => ms.map(m => m.textContent.toLowerCase()));
  check('only the latest search is highlighted', marks.join() === 'quokka', marks.join());
  await page.fill('.find input', '');

  // A color job whose block left the page is dropped, so the block on screen colors.
  await page.evaluate(() => {
    // One long word stalls highlight.js until HIGHLIGHT_TIMEOUT, so each of these costs 1.5 s if it runs.
    for (let i = 0; i < 3; i++) colorQueue.push({ id: 1e6 + i, node: document.createElement('code'), text: 'a'.repeat(150000), lang: 'bash' });
  });
  await page.click('.msg[data-id="a5"] .art');
  await page.click('#panel .tab:has-text("Code")').catch(() => {});
  const t0 = Date.now();
  await page.locator('#panel .file-code .hljs-keyword').first().waitFor({ timeout: 4000 }).catch(() => {});
  check('stale color jobs are skipped', (await page.locator('#panel .file-code .hljs-keyword').count()) > 0 && Date.now() - t0 < 1500, `${Date.now() - t0} ms`);
  await context.close();

  // Phone: the panel title comes first, Copy after it.
  const phone = await open({ width: 390, height: 800 });
  await phone.page.click('.msg[data-id="a5"] .art');
  await phone.page.waitForSelector('#panel-head .copy');
  const order = await phone.page.$eval('#panel-head', head => {
    const x = sel => head.querySelector(sel).getBoundingClientRect();
    const title = x('.panel-title'), copy = x('.copy');
    // Same row (within a few pixels) and further left, or on an earlier row.
    return { titleFirst: Math.abs(title.top - copy.top) < 12 ? title.left < copy.left : title.top < copy.top };
  });
  check('on a phone the file name comes before Copy', order.titleFirst);
  await phone.context.close();

  check('zero console errors', errors.length === 0, errors.join(' | '));
  await browser.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failed ? `${failed} failed` : 'all passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
