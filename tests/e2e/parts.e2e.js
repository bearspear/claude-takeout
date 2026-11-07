// Upload text in viewer-files parts over file:// in Chromium: loading on open, chip notes, search, slow and missing parts.
const { chromium } = require(process.env.PW);
const fs = require('fs'), os = require('os'), path = require('path');
const { buildFiles } = require('./make-viewer.js');
const { VIEWER_CHECK_BASE64, VIEWER_CHECK_FILE } = require('../../takeout-viewer.js');

const BIG_PY = 'def quokka_only():\n    return 1\n' + '# filler line\n'.repeat(6000);
const BIG_MD = '# Notes\n' + 'wombat words here\n'.repeat(5000);
const SMALL = 'small upload text';
const PASTE = 'pasted text '.repeat(7000);

function conversation() {
  const human = {
    uuid: 'h', parent_message_uuid: null, sender: 'human', created_at: '2026-05-01T10:00:00Z',
    content: [{ type: 'text', text: 'prompt with zebrafinch' }],
    attachments: [{ file_name: 'paste.txt', extracted_content: PASTE }], files: [],
    files_v2: [{ file_uuid: 'f-py', file_name: 'big.py', success: true }, { file_uuid: 'f-md', file_name: 'big.md', success: true }, { file_uuid: 'f-small', file_name: 'small.txt', success: true }],
  };
  const reply = { uuid: 'a', parent_message_uuid: 'h', sender: 'assistant', created_at: '2026-05-01T10:01:00Z', content: [{ type: 'text', text: 'Read them.' }], attachments: [], files: [], files_v2: [] };
  return { uuid: 'parts', name: 'Parts', model: 'claude-x', created_at: '2026-05-01T10:00:00Z', updated_at: '2026-05-01T10:01:00Z', settings: {}, current_leaf_message_uuid: 'a', chat_messages: [human, reply] };
}
const ctx = () => ({ folder: '', uploads: {
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
  check('the page holds no large upload text', !html.includes('wombat words here\\nwombat') && !html.includes('quokka_only') && html.includes('pasted text pasted'));

  const context = await browser.newContext({ viewport: { width: 1300, height: 900 } });
  const page = await context.newPage();
  const errors = [], requests = [], partLoads = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', async r => {
    const u = r.request().url();
    if (!u.startsWith('file:') && !u.startsWith('data:')) { requests.push(u); return r.abort(); }
    if (u.includes('/viewer-files/')) { partLoads.push(u); if (page.slowParts) await new Promise(res => setTimeout(res, 600)); }
    return r.continue();
  });
  await page.goto('file://' + path.join(dir, 'viewer.html'));
  await page.waitForSelector('.msg');
  const chip = name => page.locator('button.chip', { hasText: name });
  const popupText = () => page.locator('.pop .pop-body').textContent();
  const close = () => page.locator('.pop .close').click();

  check('no part loads at start', partLoads.length === 0);
  check('the chip still shows the line count', (await chip('big.py').textContent()).includes(`${BIG_PY.split('\n').length} lines`), await chip('big.py').textContent());
  await chip('small.txt').click();
  check('a small upload stays inline', (await popupText()) === SMALL && partLoads.length === 0);
  await close();
  await chip('paste.txt').click();
  check('a large attachment stays inline', (await popupText()) === PASTE && partLoads.length === 0);
  await close();

  await chip('big.py').click();
  await page.locator('.pop .file-code .hljs-keyword').first().waitFor({ timeout: 3000 }).catch(() => {});
  check('a large upload opens from its part', (await popupText()) === BIG_PY && partLoads.length === 1);
  check('it gets colors', (await page.locator('.pop .file-code .hljs-keyword').count()) > 0);
  await close();
  await chip('big.md').click();
  await page.waitForFunction(t => document.querySelector('.pop .pop-body')?.textContent === t, BIG_MD, { timeout: 3000 }).catch(() => {});
  check('a second upload in the same part opens without another load', (await popupText()) === BIG_MD && partLoads.length === 1, partLoads.length);
  await close();

  await page.fill('.find input', 'zebrafinch');
  await page.waitForTimeout(300);
  check('search finds prompt text', (await page.locator('#results .hit').count()) === 1);
  await page.fill('.find input', 'quokka_only');
  await page.waitForTimeout(300);
  check('search does not read upload text, as before', (await page.locator('#results .hit').count()) === 0);
  await page.fill('.find input', '');
  await page.keyboard.press('Escape');

  // A fresh page, so nothing is cached: close a slow upload, then open another.
  const slow = await context.newPage();
  slow.on('pageerror', e => errors.push(e.message));
  slow.slowParts = true;
  await slow.route('**/*', async r => { if (r.request().url().includes('/viewer-files/')) await new Promise(res => setTimeout(res, 600)); return r.continue(); });
  await slow.goto('file://' + path.join(dir, 'viewer.html'));
  await slow.waitForSelector('.msg');
  await slow.locator('button.chip', { hasText: 'big.py' }).click();
  check('a slow part shows Loading', (await slow.locator('.pop .pop-body').textContent()) === 'Loading…');
  await slow.locator('.pop .close').click();
  await slow.locator('button.chip', { hasText: 'small.txt' }).click();
  await slow.waitForTimeout(900);
  check('closing before the part arrives keeps the text out of the next popup', (await slow.locator('.pop .pop-body').textContent()) === SMALL);
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
  check('a missing part says so', (await miss.locator('.pop .pop-body').textContent()) === 'This file is not in this export.');
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
