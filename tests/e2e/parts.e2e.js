// Upload text in viewer-files parts over file:// in Chromium: loading on open, chip notes, search, slow and missing parts.
const { chromium } = require(process.env.PW);
const fs = require('fs'), os = require('os'), path = require('path');
const { buildFiles } = require('./make-viewer.js');
const { VIEWER_CHECK_BASE64, VIEWER_CHECK_FILE } = require('../../takeout-viewer.js');

const BIG_PY = 'def quokka_only():\n    return 1\n' + '# filler line\n'.repeat(6000);
const BIG_MD = '# Notes\n' + 'wombat words here\n'.repeat(5000);
const SMALL = 'small upload text';
const PASTE = 'pasted text '.repeat(7000);
// The marker is past the 20,000 characters a tool step keeps of its input.
const BIG_HTML = '<!doctype html><h1>Rows</h1>' + '<p>row</p>\n'.repeat(8000) + '<p>numbat_page</p>';

function conversation() {
  const human = {
    uuid: 'h', parent_message_uuid: null, sender: 'human', created_at: '2026-05-01T10:00:00Z',
    content: [{ type: 'text', text: 'prompt with zebrafinch' }],
    attachments: [{ file_name: 'paste.txt', extracted_content: PASTE }, { file_name: '', extracted_content: 'first paste\nline two' }, { extracted_content: 'second paste' }], files: [],
    files_v2: [{ file_uuid: 'f-py', file_name: 'big.py', success: true }, { file_uuid: 'f-md', file_name: 'big.md', success: true }, { file_uuid: 'f-small', file_name: 'small.txt', success: true }],
  };
  const reply = { uuid: 'a', parent_message_uuid: 'h', sender: 'assistant', created_at: '2026-05-01T10:01:00Z', content: [{ type: 'text', text: 'Read them.' }, { type: 'tool_use', id: 'cf', name: 'create_file', input: { path: '/mnt/user-data/outputs/big.html', file_text: BIG_HTML } }], attachments: [], files: [], files_v2: [] };
  return { uuid: 'parts', name: 'Parts', model: 'claude-x', created_at: '2026-05-01T10:00:00Z', updated_at: '2026-05-01T10:01:00Z', settings: {}, current_leaf_message_uuid: 'a', chat_messages: [human, reply] };
}
const ctx = () => ({ folder: '', artifacts: { 'big.html': BIG_HTML }, artifactIndex: { '/mnt/user-data/outputs/big.html': { path: '/mnt/user-data/outputs/big.html', filename: 'big.html', versions: ['big.html'], messages: ['a'] } }, uploads: {
  'f-py': { path: 'uploads/p01_big.py', text: BIG_PY }, 'f-md': { path: 'uploads/p01_big.md', text: BIG_MD }, 'f-small': { path: 'uploads/p01_small.txt', text: SMALL },
} });

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parts-'));
  const { html, parts } = buildFiles([conversation()], '2026-11-07T12:00:00Z', ctx);
  fs.writeFileSync(path.join(dir, 'viewer.html'), html);
  fs.writeFileSync(path.join(dir, VIEWER_CHECK_FILE), Buffer.from(VIEWER_CHECK_BASE64, 'base64'));
  fs.mkdirSync(path.join(dir, 'viewer-files'));
  for (const p of parts) fs.writeFileSync(path.join(dir, 'viewer-files', p.name), p.body);
  const browser = await chromium.launch({ executablePath: process.env.CHROME_EXE });
  let failed = 0;
  const check = (n, ok, x = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n} ${ok ? '' : x}`); };
  check('the page holds no large file text', !html.includes('numbat_page'));
  check('the page holds no large upload text', !html.includes('wombat words here\\nwombat') && !html.includes('quokka_only') && html.includes('pasted text pasted'));

  const context = await browser.newContext({ viewport: { width: 1300, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  const errors = [], requests = [], partLoads = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', async r => {
    const u = r.request().url();
    if (!u.startsWith('file:') && !u.startsWith('data:')) { requests.push(u); return r.abort(); }
    if (u.includes('/viewer-files/')) partLoads.push(u);
    return r.continue();
  });
  await page.goto('file://' + path.join(dir, 'viewer.html'));
  await page.waitForSelector('.msg');
  const chip = name => page.locator('button.chip', { hasText: name });
  const popupText = () => page.locator('.pop .pop-body').textContent();
  const close = () => page.locator('.pop .close').click();

  check('no part loads at start', partLoads.length === 0);
  check('the data text is dropped once parsed', await page.evaluate(() => document.getElementById('data') === null));
  check('the chip still shows the line count', (await chip('big.py').textContent()).includes(`${BIG_PY.split('\n').length} lines`), await chip('big.py').textContent());
  await chip('small.txt').click();
  check('a small upload stays inline', (await popupText()) === SMALL && partLoads.length === 0);
  await close();
  await chip('paste.txt').click();
  check('a large attachment stays inline', (await popupText()) === PASTE && partLoads.length === 0);
  await close();

  check('unnamed pastes are Pasted text, numbered', (await chip('Pasted text 1').textContent()).includes('Pasted · 2 lines') && (await chip('Pasted text 2').count()) === 1 && (await page.locator('button.chip', { hasText: 'Untitled' }).count()) === 0, await page.locator('.msg[data-id="h"] .chips, .msg[data-id="h"]').first().textContent());
  await chip('Pasted text 1').click();
  check('a paste popup is titled Pasted text', (await page.textContent('.pop .pop-title')) === 'Pasted text 1' && (await popupText()) === 'first paste\nline two');
  await close();

  await chip('big.py').click();
  await page.locator('.pop .file-code .hljs-keyword').first().waitFor({ timeout: 3000 }).catch(() => {});
  check('a large upload opens from its part', (await popupText()) === BIG_PY && partLoads.length === 1);
  check('it gets colors', (await page.locator('.pop .file-code .hljs-keyword').count()) > 0);
  await page.click('.pop-head .copy');
  check('a large upload copies once loaded', (await page.evaluate(() => navigator.clipboard.readText())) === BIG_PY);
  await close();
  await chip('big.md').click();
  await page.waitForFunction(t => document.querySelector('.pop .pop-body')?.textContent === t, BIG_MD, { timeout: 3000 }).catch(() => {});
  check('a second upload in the same part opens without another load', (await popupText()) === BIG_MD && partLoads.length === 1, partLoads.length);
  await close();

  await page.click('.msg[data-id="a"] .art');
  await page.waitForSelector('#panel iframe', { timeout: 3000 }).catch(() => {});
  const frameDoc = await page.$eval('#panel iframe', f => f.getAttribute('srcdoc') || '').catch(() => '');
  check('a large file opens from its part, in preview', frameDoc.includes('numbat_page'), frameDoc.slice(0, 80));
  await page.click('#panel .tab:has-text("Code")');
  check('and in Code view', (await page.textContent('#panel .file-code')) === BIG_HTML);
  await page.click('#panel .close');

  await page.fill('.find input', 'zebrafinch');
  await page.waitForTimeout(300);
  check('search finds prompt text', (await page.locator('#results .snip').count()) === 1);
  await page.fill('.find input', 'quokka_only');
  await page.waitForTimeout(300);
  check('search does not read upload text, as before', (await page.locator('#results .snip').count()) === 0);
  await page.fill('.find input', '');
  await page.keyboard.press('Escape');

  // A fresh page, so nothing is cached: close a slow upload, then open another.
  const slow = await context.newPage();
  slow.on('pageerror', e => errors.push(e.message));
  await slow.route('**/*', async r => { if (r.request().url().includes('/viewer-files/')) await new Promise(res => setTimeout(res, 600)); return r.continue(); });
  await slow.goto('file://' + path.join(dir, 'viewer.html'));
  await slow.waitForSelector('.msg');
  await slow.locator('button.chip', { hasText: 'big.py' }).click();
  check('a slow part shows Loading', (await slow.locator('.pop .pop-body').textContent()) === 'Loading…');
  check('no Copy while it loads', (await slow.locator('.pop-head .copy').count()) === 0);
  await slow.locator('.pop .close').click();
  await slow.locator('button.chip', { hasText: 'small.txt' }).click();
  await slow.waitForTimeout(900);
  check('closing before the part arrives keeps the text out of the next popup', (await slow.locator('.pop .pop-body').textContent()) === SMALL);
  await slow.locator('.pop .close').click();
  // Read in the same tick as the click: a cached text shows at once, with no Loading… in between.
  const reopened = await slow.evaluate(() => {
    [...document.querySelectorAll('button.chip')].find(b => b.textContent.includes('big.py')).click();
    return document.querySelector('.pop .pop-body').textContent;
  });
  check('the part that arrived after closing is kept, so reopening is instant', reopened === BIG_PY, reopened.slice(0, 40));
  await slow.close();

  const gone = path.join(dir, 'viewer-files.off');
  fs.renameSync(path.join(dir, 'viewer-files'), gone);
  const miss = await context.newPage();
  const missErrors = [];
  miss.on('pageerror', e => missErrors.push(e.message));
  await miss.goto('file://' + path.join(dir, 'viewer.html'));
  await miss.waitForSelector('.msg');
  await miss.locator('button.chip', { hasText: 'big.py' }).click();
  await miss.waitForFunction(() => document.querySelector('.pop .pop-body')?.textContent !== 'Loading…', null, { timeout: 3000 }).catch(() => {});
  const missText = await miss.locator('.pop .pop-body').textContent();
  check('a missing part offers no Copy', (await miss.locator('.pop-head .copy').count()) === 0);
  check('a missing part says so and points at the folder copy', missText.includes("The text couldn't load.") && missText.includes("It's in this export's folder."), missText);
  await miss.locator('.pop .close').click();
  await miss.locator('button.chip', { hasText: 'big.md' }).click();
  await miss.waitForFunction(() => document.querySelector('.pop .pop-body')?.textContent !== 'Loading…', null, { timeout: 3000 }).catch(() => {});
  check('a missing part offers the uploads copy when it can open', (await miss.locator('.pop .pop-body').textContent()).includes("The text couldn't load.") && (await miss.locator('.pop .pop-body a[href="uploads/p01_big.md"]').count()) === 1, await miss.locator('.pop .pop-body').innerHTML());
  await miss.locator('.pop .close').click();
  fs.renameSync(gone, path.join(dir, 'viewer-files'));
  await miss.locator('button.chip', { hasText: 'big.py' }).click();
  await miss.waitForFunction(t => document.querySelector('.pop .pop-body')?.textContent === t, BIG_PY, { timeout: 3000 }).catch(() => {});
  check('the next open tries again', (await miss.locator('.pop .pop-body').textContent()) === BIG_PY);
  check('a missing part throws nothing', missErrors.length === 0, missErrors.join(' | '));

  check('zero console errors', errors.length === 0, errors.join(' | '));
  check('zero network requests', requests.length === 0, requests.join());
  await browser.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failed ? `${failed} failed` : 'all passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
