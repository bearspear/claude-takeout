// Syntax colors over file:// in Chromium: chat, prompts, files, popups, hostile text and text that stalls the highlighter.
const { chromium } = require(process.env.PW);
const fs = require('fs'), os = require('os'), path = require('path');
const { buildHtml } = require('./make-viewer.js');
const { VIEWER_CHECK_BASE64, VIEWER_CHECK_FILE } = require('../../takeout-viewer.js');

const PY = 'def variance(actual, plan):\n    # compare\n    return actual - plan  # "done"\n';
const HOSTILE = '</code></pre><img src=x onerror="window.__hit=1"><script>window.__hit=1</script><b>bold</b>';
const STALL = 'a'.repeat(150000);
const LONG = 'const a = 1;\n'.repeat(16000);
const fence = (lang, text) => '```' + lang + '\n' + text + '\n```';
const CRLF = 'x = 1\r\ny = 2\r\n';
// A transcript whose title has an underscore: it must not turn the rest italic.
const NOTES = '# sept21_part1.m4a\n\n## Content\n\nSo, we need *one* more.\n\nIs he?\n';

function message(uuid, parent, sender, content, extra = {}) {
  return { uuid, parent_message_uuid: parent, sender, created_at: '2026-05-01T10:00:00Z', content, attachments: [], files: [], files_v2: [], ...extra };
}

function colorsChat() {
  const texts = [
    fence('python', PY.trimEnd()),
    fence('', PY.trimEnd()),
    fence('nosuchlang', 'def f(): pass'),
    fence('__proto__', 'def f(): pass'),
    fence('html', HOSTILE),
    fence('js', LONG.trimEnd()),
  ];
  const out = [message('h0', null, 'human', [{ type: 'text', text: 'Mine:\n\n' + fence('python', 'import os') }], { attachments: [{ file_name: 'pasted.py', extracted_content: PY }] })];
  texts.forEach((text, i) => {
    out.push(message(`a${i}`, i ? `h${i}` : 'h0', 'assistant', [{ type: 'text', text }]));
    out.push(message(`h${i + 1}`, `a${i}`, 'human', [{ type: 'text', text: `next ${i}` }]));
  });
  out.push(message('stall', 'h6', 'assistant', [{ type: 'text', text: fence('bash', STALL) + '\n\n' + fence('python', 'import after_stall') }]));
  out.push(message('h7', 'stall', 'human', [{ type: 'text', text: 'and a file' }]));
  out.push(message('filed', 'h7', 'assistant', [{ type: 'text', text: 'Made it.' }, { type: 'tool_use', id: 't1', name: 'create_file', input: { path: '/mnt/user-data/outputs/calc.py', file_text: PY } }, { type: 'tool_use', id: 't1b', name: 'create_file', input: { path: '/mnt/user-data/outputs/notes.md', file_text: NOTES } }]));
  out.push(message('h8', 'filed', 'human', [{ type: 'text', text: 'and a page' }]));
  out.push(message('paged', 'h8', 'assistant', [{ type: 'text', text: 'Page.' }, { type: 'tool_use', id: 't2', name: 'create_file', input: { path: '/mnt/user-data/outputs/worker.html', file_text: '<!doctype html><script>try{const w=new Worker(URL.createObjectURL(new Blob(["postMessage(1)"])));w.onmessage=()=>console.log("WORKER RAN");w.onerror=()=>console.log("WORKER BLOCKED")}catch(e){console.log("WORKER BLOCKED")}<\/script>' } }]));
  out.push(message('h9', 'paged', 'human', [{ type: 'text', text: 'line endings' }]));
  out.push(message('crlf', 'h9', 'assistant', [{ type: 'text', text: fence('python', CRLF.trimEnd()) }]));
  let filler = 'h10';
  out.push(message('h10', 'crlf', 'human', [{ type: 'text', text: 'long one' }]));
  for (let i = 0; i < 40; i++) { out.push(message(`f${i}`, filler, 'assistant', [{ type: 'text', text: 'Filler text.\n\n'.repeat(12) }])); filler = `f${i}`; }
  out.push(message('last', filler, 'assistant', [{ type: 'text', text: fence('python', 'import far_down') }]));
  return { uuid: 'colors', name: 'Colors', model: 'claude-x', created_at: '2026-05-01T10:00:00Z', updated_at: '2026-05-01T10:00:00Z', settings: {}, current_leaf_message_uuid: 'last', chat_messages: out };
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colors-'));
  const file = path.join(dir, 'viewer.html');
  fs.writeFileSync(path.join(dir, VIEWER_CHECK_FILE), Buffer.from(VIEWER_CHECK_BASE64, 'base64'));
  const conversation = colorsChat();
  fs.writeFileSync(file, buildHtml([conversation], '2026-11-06T12:00:00Z', () => ({ artifacts: { 'calc.py': PY, 'notes.md': NOTES, 'worker.html': conversation.chat_messages.find(m => m.uuid === 'paged').content[1].input.file_text }, artifactIndex: {
    '/mnt/user-data/outputs/calc.py': { path: '/mnt/user-data/outputs/calc.py', filename: 'calc.py', versions: ['calc.py'], messages: ['filed'] },
    '/mnt/user-data/outputs/notes.md': { path: '/mnt/user-data/outputs/notes.md', filename: 'notes.md', versions: ['notes.md'], messages: ['filed'] },
    '/mnt/user-data/outputs/worker.html': { path: '/mnt/user-data/outputs/worker.html', filename: 'worker.html', versions: ['worker.html'], messages: ['paged'] },
  } })));
  const browser = await chromium.launch({ executablePath: process.env.CHROME_EXE });
  let failed = 0;
  const check = (n, ok, x = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n} ${ok ? '' : x}`); };
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  const errors = [], logs = [];
  page.on('console', m => { logs.push(m.text()); if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('file://' + file);
  await page.waitForSelector('.msg');
  const block = id => page.locator(`.msg[data-id="${id}"] .code code`);
  const seen = async (id, nth = 0) => {
    await block(id).nth(nth).scrollIntoViewIfNeeded();
    return block(id).nth(nth).locator('.hljs-keyword, .hljs-built_in').first().waitFor({ timeout: 3000 }).then(() => true, () => false);
  };
  const quiet = async (id, nth = 0) => {
    await block(id).nth(nth).scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    return (await block(id).nth(nth).evaluate(n => n.childElementCount)) === 0;
  };

  check('a labelled fence gets colors', await seen('a0'));
  check('colors leave the text as it was', (await block('a0').textContent()) === PY);
  check('comments and strings have tokens', (await block('a0').locator('.hljs-comment').count()) === 2 && (await block('a0').locator('.hljs-title').count()) === 1);
  await page.locator('.msg[data-id="a0"] .code .copy').click();
  check('Copy gives the plain code', (await page.evaluate(() => navigator.clipboard.readText())).trimEnd() === PY.trimEnd());
  check('a prompt fence gets colors', await seen('h0'));
  check('no language stays plain', await quiet('a1'));
  check('an unknown language stays plain', await quiet('a2'));
  check('a built-in name stays plain', await quiet('a3'));

  await page.locator('.msg[data-id="a4"] .code code').scrollIntoViewIfNeeded();
  await page.locator('.msg[data-id="a4"] .code code span span').first().waitFor({ timeout: 3000 });
  check('hostile code stays text', (await block('a4').textContent()).trimEnd() === HOSTILE);
  check('hostile code makes only spans', await block('a4').evaluate(n => [...n.querySelectorAll('*')].every(e => e.tagName === 'SPAN' && [...e.attributes].every(a => a.name === 'class' && /^(hljs-[\w-]+|language-\w+|language_)( language_)?$/.test(a.value)))));
  check('hostile code does not run', !(await page.evaluate(() => !!window.__hit)));

  check('a block past the limit stays plain', await quiet('a5'));
  await block('stall').first().scrollIntoViewIfNeeded();
  const t0 = Date.now();
  await page.evaluate(() => new Promise(r => setTimeout(r, 50)));
  check('text that stalls the highlighter leaves the page free', Date.now() - t0 < 500, Date.now() - t0);
  check('colors go on after a block is stopped', await seen('stall', 1));
  check('the stopped block stays plain and whole', (await block('stall').first().evaluate(n => n.childElementCount)) === 0 && (await block('stall').first().textContent()).trimEnd() === STALL);
  check('CRLF code gets colors', await seen('crlf') || (await block('crlf').locator('span span').count()) > 0);

  check('a block out of sight waits', (await block('last').evaluate(n => n.childElementCount)) === 0);
  check('it colors once in view', await seen('last'));

  await page.click('.msg[data-id="filed"] .art');
  await page.waitForSelector('#panel');
  await page.click('#panel .tab:has-text("Code")').catch(() => {});
  await page.locator('#panel .file-code .hljs-keyword').first().waitFor({ timeout: 3000 });
  check('a file in Code view gets colors', (await page.textContent('#panel .file-code')) === PY);
  await page.click('#panel-head .copy');
  check('the panel copies the file', (await page.evaluate(() => navigator.clipboard.readText())) === PY);
  check('the panel Copy says Copied', (await page.textContent('#panel-head .copy span')) === 'Copied');
  await page.click('#panel .close');

  await page.click('.msg[data-id="filed"] .art:has-text("notes.md")');
  await page.waitForSelector('#panel .prose');
  await page.click('#panel-head .copy');
  check('Preview copies the Markdown source, not the page', (await page.evaluate(() => navigator.clipboard.readText())) === NOTES);
  await page.click('#panel .tab:has-text("Code")');
  await page.locator('#panel .file-code .hljs-section').first().waitFor({ timeout: 3000 });
  const emphasis = await page.$$eval('#panel .file-code .hljs-emphasis', n => n.map(e => e.textContent));
  check('an underscore in a word turns nothing italic', emphasis.join('|') === '*one*', emphasis.join('|'));
  check('headings after it still color', (await page.$$eval('#panel .file-code .hljs-section', n => n.map(e => e.textContent))).join('|') === '# sept21_part1.m4a|## Content');
  await page.click('#panel .close');

  await page.click('.msg[data-id="paged"] .art');
  await page.waitForFunction(() => document.querySelector('#panel iframe'));
  await page.waitForTimeout(500);
  await page.click('#panel-head .copy');
  check('an HTML preview copies its source', (await page.evaluate(() => navigator.clipboard.readText())) === conversation.chat_messages.find(m => m.uuid === 'paged').content[1].input.file_text);
  check('a preview cannot start a worker', logs.includes('WORKER BLOCKED') && !logs.includes('WORKER RAN'), logs.filter(l => /WORKER/.test(l)).join());
  await page.click('#panel .close');
  const blocked = errors.filter(e => /Worker|worker-src|blob:/.test(e));
  errors.splice(0, errors.length, ...errors.filter(e => !blocked.includes(e)));

  await page.locator('.msg[data-id="h0"] button.chip').first().click();
  await page.locator('.file-code .hljs-keyword').first().waitFor({ timeout: 3000 });
  check('an upload in a popup gets colors', (await page.locator('.file-code').first().textContent()) === PY);
  check('the popup Copy sits in its header', (await page.locator('.pop-head .copy').getAttribute('aria-label')) === 'Copy pasted.py');
  await page.click('.pop-head .copy');
  check('the popup copies the file', (await page.evaluate(() => navigator.clipboard.readText())) === PY);
  await page.keyboard.press('Escape');

  await block('a0').scrollIntoViewIfNeeded();
  const light = await block('a0').locator('.hljs-keyword').first().evaluate(n => getComputedStyle(n).color);
  await page.emulateMedia({ colorScheme: 'dark' });
  const dark = await block('a0').locator('.hljs-keyword').first().evaluate(n => getComputedStyle(n).color);
  check('dark theme has its own colors', light !== dark, light + ' ' + dark);
  await page.emulateMedia({ colorScheme: 'light' });

  await page.fill('.find input', 'def variance');
  await page.waitForTimeout(300);
  const hit = page.locator('#results .hit').nth(1);
  if (await hit.count()) {
    await hit.click();
    await page.waitForTimeout(300);
    const marks = await page.$$eval('mark', m => m.map(x => x.textContent)); check('search finds a phrase across tokens', marks.join() === 'def variance', JSON.stringify({ marks, hit: await page.evaluate(() => document.querySelector('#results')?.textContent.slice(0, 200)), hash: await page.evaluate(() => location.hash) }));
  } else check('search finds a phrase across tokens', false, 'no result row');
  check('zero console errors', errors.length === 0, errors.join(' | '));

  await browser.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failed ? `${failed} failed` : 'all passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
