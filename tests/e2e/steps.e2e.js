// The steps before an answer, folded as claude.ai folds them, over file:// in Chromium: one line per response
// summing up the tools, rows for thinking, text and each tool (a command by its description, a file by its
// name), images Claude viewed in their row with a thumbnail, and outputs (diagrams, web images) after the group.
const { chromium } = require(process.env.PW);
const fs = require('fs'), os = require('os'), path = require('path');
const { buildHtml } = require('./make-viewer.js');
const { VIEWER_CHECK_BASE64, VIEWER_CHECK_FILE } = require('../../takeout-viewer.js');
const core = require('../../export-core.js');

const at = n => `2026-05-01T10:${String(n).padStart(2, '0')}:00Z`;
const msg = (uuid, parent, sender, n, content) => ({ uuid, parent_message_uuid: parent, sender, created_at: at(n), content, attachments: [], files: [], files_v2: [] });
const use = (id, name, input) => ({ type: 'tool_use', id, name, input });
const res = (id, name, content, isError = false) => ({ type: 'tool_result', tool_use_id: id, name, is_error: isError, content });
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const think = (summary, ms) => ({ type: 'thinking', thinking: summary ? 'x' : '', summaries: summary ? [{ summary }] : [], start_timestamp: '2026-05-01T10:00:00.000Z', stop_timestamp: new Date(Date.parse('2026-05-01T10:00:00.000Z') + ms).toISOString() });

const chat = {
  uuid: 's', name: 'Steps', model: 'claude-x', created_at: at(1), updated_at: at(9), settings: {}, current_leaf_message_uuid: 'a2',
  chat_messages: [
    msg('h1', null, 'human', 1, [{ type: 'text', text: 'look at this' }]),
    msg('a1', 'h1', 'assistant', 2, [
      think('', 23000),
      { type: 'text', text: 'I will convert the photos.' },
      use('b1', 'Bash', { command: 'ls', description: 'Check uploads' }), res('b1', 'Bash', [{ type: 'text', text: 'Exit code 1' }], true),
      use('r1', 'Read', { file_path: '/home/claude/imgs/IMG_1.jpg' }), res('r1', 'Read', [{ type: 'image', file_uuid: 'f1', preview_url: '/api/o/files/f1/preview' }]),
      use('r2', 'Read', { file_path: '/home/claude/imgs/IMG_2.jpg' }), res('r2', 'Read', [{ type: 'image', file_uuid: 'f2', preview_url: '/api/o/files/f2/preview' }]),
      use('w1', 'Write', { file_path: '/home/claude/guide.html', content: '<p>x</p>' }), res('w1', 'Write', [{ type: 'text', text: 'ok' }]),
      use('t1', 'ToolSearch', { query: 'select:mcp__claude-artifacts__list_types' }), res('t1', 'ToolSearch', []),
      use('d1', 'mcp__visualize__show_widget', { title: 'wiring', widget_code: '<svg viewBox="0 0 4 4"></svg>' }), res('d1', 'mcp__visualize__show_widget', [{ type: 'text', text: 'shown' }]),
      think('Checking the leads.', 1000),
      { type: 'text', text: 'Here is **the answer**.' },
    ]),
    msg('h2', 'a1', 'human', 3, [{ type: 'text', text: 'and now?' }]),
    msg('a2', 'h2', 'assistant', 4, [think('Weighing the tester.', 2000), { type: 'text', text: 'Use a tester.' }]),
  ],
};

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'steps-'));
  const file = path.join(dir, 'viewer.html');
  fs.writeFileSync(path.join(dir, VIEWER_CHECK_FILE), Buffer.from(VIEWER_CHECK_BASE64, 'base64'));
  fs.mkdirSync(path.join(dir, 'images'));
  fs.writeFileSync(path.join(dir, 'images', 'f1_IMG_1.png'), PNG);
  const index = {};
  const artifacts = core.extractArtifacts(chat, null, index);
  fs.writeFileSync(file, buildHtml([chat], '2026-11-15T12:00:00Z', () => ({ toolImages: { f1: 'images/f1_IMG_1.png' }, artifacts, artifactIndex: index, widgetFile: core.widgetFile, widgetKey: core.widgetKey })));
  const browser = await chromium.launch({ executablePath: process.env.CHROME_EXE });
  const downloads = [];
  let failed = 0;
  const check = (n, ok, x = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n} ${ok ? '' : x}`); };
  const page = await (await browser.newContext({ viewport: { width: 1200, height: 900 }, acceptDownloads: true })).newPage();
  page.on('download', d => downloads.push(d.suggestedFilename()));
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('file://' + file + '#chat=s');
  await page.waitForSelector('.msg');

  const group = page.locator('.msg.assistant').first().locator(':scope > details.steps');
  check('one group line for the steps', await group.count() === 1);
  const label = (await group.locator(':scope > summary .label').textContent()).trim();
  check('the line sums up the tools, diagrams aside', label === 'Created a file, read 2 files, and 2 more steps', label);
  check('a thumbnail of the viewed image on the line', await group.locator(':scope > summary .thumbs img').count() === 1);
  check('the group starts closed', !(await group.evaluate(d => d.open)));
  check('the answer is outside the group', (await page.locator('.msg.assistant').first().locator(':scope > .prose').textContent()).includes('the answer'));
  await group.locator(':scope > summary').click();
  const rows = group.locator('.steps-box > *');
  const texts = (await rows.allTextContents()).map(t => t.replace(/\s+/g, ' ').trim());
  check('rows in order, empty thinking left out', texts[0] === 'I will convert the photos.' && /^Check uploads/.test(texts[1]) && /^Read IMG_1\.jpg/.test(texts[2]), texts.join(' | '));
  check('a failed command says so', (await rows.nth(1).locator('.fail').textContent()) === 'Failed');
  check('the file name is set apart', (await rows.nth(2).locator('.target').textContent()) === 'IMG_1.jpg');
  check('ToolSearch reads as Loaded', texts.some(t => t.startsWith('Loaded claude-artifacts')), texts.join(' | '));
  check('the diagram is not a row', !texts.some(t => /diagram/i.test(t)));
  check('thinking after the diagram is its own line, by its summary', (await page.locator('.msg.assistant').first().locator(':scope > details.thinking > summary').textContent()).trim() === 'Checking the leads.');
  await rows.nth(2).locator(':scope > summary').click();
  check('the opened Read row shows the image', await rows.nth(2).evaluate(d => { const i = d.querySelector('.line-body .tool-images img'); return !!i && i.naturalWidth === 1; }));
  check('a Read row with a picture shows only the picture', (await rows.nth(2).locator('.tool-part').count()) === 0);
  await rows.nth(2).locator('.tool-image').click();
  check('the picture opens the step gallery, labelled by its step', (await page.locator('.gallery-nav .pos').textContent()) === '1 of 1' && (await page.locator('.gallery-info .title').textContent()) === 'Read IMG_1.jpg');
  await page.keyboard.press('Escape');
  check('the other Read row says its image is missing', (await rows.nth(3).locator('.missing-image').textContent()) === 'Image not in this export');
  const only = page.locator('.msg.assistant').nth(1).locator(':scope > details.thinking > summary');
  check('thinking alone is its own line, by its summary', (await only.textContent()).trim() === 'Weighing the tester.');
  // A diagram shows inline where Claude drew it, with claude.ai's menu and a way to the side panel.
  const diagram = page.locator('.msg.assistant').first().locator(':scope > figure.diagram');
  check('the diagram shows inline, after the steps and before the answer', await diagram.count() === 1
    && await page.locator('.msg.assistant').first().evaluate(s => { const k = [...s.children].map(c => c.matches('figure.diagram') ? 'D' : c.matches('details.steps') ? 'S' : c.matches('.prose') ? 'P' : ''); return k.indexOf('S') < k.indexOf('D') && k.indexOf('D') < k.lastIndexOf('P'); }));
  check('the diagram is drawn from its SVG', await diagram.locator('img').evaluate(i => i.complete && i.naturalWidth > 0 && i.src.startsWith('data:image/svg+xml')));
  await diagram.hover();
  await diagram.locator('.diagram-more').click();
  check('the menu has four options', (await diagram.locator('.diagram-menu button').allTextContents()).join('|') === 'Copy as image|Download as SVG|Download as PNG|Open in sidebar');
  await diagram.locator('.diagram-menu button', { hasText: 'Download as SVG' }).click();
  await diagram.hover();
  await diagram.locator('.diagram-more').click();
  await diagram.locator('.diagram-menu button', { hasText: 'Download as PNG' }).click();
  await page.waitForTimeout(500);
  check('downloads are named after the diagram', downloads.join('|') === 'wiring.svg|wiring.png', downloads.join('|'));
  await diagram.hover();
  await diagram.locator('.diagram-more').click();
  await page.keyboard.press('Escape');
  check('Escape closes the menu', await diagram.locator('.diagram-menu').isHidden());
  await diagram.locator('.diagram-more').click();
  await diagram.locator('.diagram-menu button', { hasText: 'Open in sidebar' }).click();
  await page.waitForTimeout(400);
  check('Open in sidebar opens the diagram in the panel', /[#&]file=a\d+/.test(await page.evaluate(() => location.hash)));
  check('no page errors', errors.length === 0, errors.join(' | '));

  await browser.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e.message); process.exit(1); });
