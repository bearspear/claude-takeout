// The Files list in the chat's top bar over file:// in Chromium: count, outputs and uploads, opening
// each, keyboard and closing.
const { chromium } = require(process.env.PW);
const fs = require('fs'), os = require('os'), path = require('path');
const { buildHtml } = require('./make-viewer.js');
const { VIEWER_CHECK_BASE64, VIEWER_CHECK_FILE } = require('../../takeout-viewer.js');

const at = n => `2026-05-01T10:${String(n).padStart(2, '0')}:00Z`;
const msg = (uuid, parent, sender, n, content, extra = {}) =>
  ({ uuid, parent_message_uuid: parent, sender, created_at: at(n), content, attachments: [], files: [], files_v2: [], ...extra });
const cf = (id, p, text) => ({ type: 'tool_use', id, name: 'create_file', input: { path: p, file_text: text } });
const sr = (id, p, o, n) => ({ type: 'tool_use', id, name: 'str_replace', input: { path: p, old_str: o, new_str: n } });

function withFiles() {
  return {
    uuid: 'f', name: 'Minutes chat', model: 'claude-x', created_at: at(1), updated_at: at(9), settings: {}, current_leaf_message_uuid: 'a2',
    chat_messages: [
      msg('h1', null, 'human', 1, [{ type: 'text', text: 'draft the minutes' }], {
        attachments: [{ file_name: '', extracted_content: 'pasted agenda\nline two' }],
        files_v2: [{ file_uuid: 'u-rec', file_name: 'recording.m4a.md', success: true }],
      }),
      msg('a1', 'h1', 'assistant', 2, [{ type: 'text', text: 'Here.' }, cf('t0', '/home/claude/build.py', 'print(1)'), cf('t1', '/mnt/user-data/outputs/minutes.md', '# Minutes v1'), cf('t2', '/mnt/user-data/outputs/agenda.md', '# Agenda')]),
      msg('h2', 'a1', 'human', 3, [{ type: 'text', text: 'fix the date' }], { files_v2: [{ file_uuid: 'u-png', file_name: 'photo.png', success: true }] }),
      msg('a2', 'h2', 'assistant', 4, [{ type: 'text', text: 'Fixed.' }, sr('t3', '/mnt/user-data/outputs/minutes.md', 'v1', 'v2')]),
    ],
  };
}
const empty = {
  uuid: 'e', name: 'No files here', model: 'claude-x', created_at: at(0), updated_at: at(0), settings: {}, current_leaf_message_uuid: 'x',
  chat_messages: [msg('x', null, 'human', 0, [{ type: 'text', text: 'hello' }])],
};

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'files-'));
  const file = path.join(dir, 'viewer.html');
  fs.writeFileSync(path.join(dir, VIEWER_CHECK_FILE), Buffer.from(VIEWER_CHECK_BASE64, 'base64'));
  fs.writeFileSync(file, buildHtml([withFiles(), empty], '2026-11-08T12:00:00Z', c => (c.uuid !== 'f' ? {} : {
    artifacts: { 'build.py': 'print(1)', 'minutes_v1.md': '# Minutes v1', 'minutes_v2.md': '# Minutes v2', 'minutes.md': '# Minutes v2', 'agenda.md': '# Agenda' },
    flags: { 'agenda.md': 'script' },
    artifactIndex: {
      '/home/claude/build.py': { path: '/home/claude/build.py', filename: 'build.py', versions: ['build.py'], messages: ['a1'] },
      '/mnt/user-data/outputs/minutes.md': { path: '/mnt/user-data/outputs/minutes.md', filename: 'minutes.md', versions: ['minutes_v1.md', 'minutes_v2.md'], messages: ['a1', 'a2'] },
      '/mnt/user-data/outputs/agenda.md': { path: '/mnt/user-data/outputs/agenda.md', filename: 'agenda.md', versions: ['agenda.md'], messages: ['a1'] },
    },
    uploads: { 'u-rec': { path: 'uploads/p01_recording.m4a.md', text: 'the recording text' }, 'u-png': { path: 'uploads/p02_photo.png', text: null } },
    project: { name: 'Board', fileDir: 'project/files', fileNames: ['charter.pdf'], docs: [], instructions: '' },
  })));
  const browser = await chromium.launch({ executablePath: process.env.CHROME_EXE });
  let failed = 0;
  const check = (n, ok, x = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n} ${ok ? '' : x}`); };
  const context = await browser.newContext({ viewport: { width: 1300, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.route('**/*', r => (r.request().url().startsWith('file:') ? r.continue() : r.abort()));
  await page.goto('file://' + file + '#chat=f');
  await page.waitForSelector('.msg');

  const button = page.locator('#files-button');
  check('the Files button shows how many files the chat has', (await button.isVisible()) && (await button.textContent()).trim() === '6', await button.textContent());
  await button.click();
  const menu = page.locator('#files-menu');
  check('it opens the list', await menu.isVisible());
  const sections = await menu.locator('.files-lab').allTextContents();
  check('outputs, uploads and working files are listed apart', sections.join('|') === 'Outputs|Uploads|Working files', sections.join('|'));
  const rows = await menu.locator('.files-row b').allTextContents();
  check('outputs newest first, then uploads and pastes newest first', rows.join('|') === 'minutes.md|agenda.md|photo.png|recording.m4a.md|Pasted text|build.py', rows.join('|'));
  check('an edited file says how many versions it has', /2 versions/.test(await menu.locator('.files-row').first().textContent()));
  check('focus moves into the list', await page.evaluate(() => document.activeElement && document.activeElement.closest('#files-menu') !== null));
  check('the project bar is showing, as in a project chat', await page.$eval('#project', p => !p.hidden));
  // Nothing may cover the list: what's on top at its heading and first row must be the list itself.
  const covered = await page.evaluate(() => [...document.querySelectorAll('#files-menu .files-lab, #files-menu .files-row')].slice(0, 3)
    .filter(e => { const r = e.getBoundingClientRect(); const top = document.elementFromPoint(r.left + 20, r.top + r.height / 2); return !top || !e.contains(top); })
    .map(e => e.textContent.trim().slice(0, 30)));
  check('the list is drawn above the project bar', covered.length === 0, covered.join(' | '));

  // An output opens in the file panel, at its newest version.
  await menu.locator('.files-row').first().click();
  await page.waitForSelector('#panel:not([hidden])');
  check('an output opens its newest version in the panel', (await page.textContent('#panel .panel-title')) === 'minutes.md' && (await page.evaluate(() => location.hash)).includes('version=1'));
  check('the list closes', !(await menu.isVisible()));

  // An upload opens in the popup.
  await button.click();
  await menu.locator('.files-row', { hasText: 'recording.m4a.md' }).click();
  await page.waitForSelector('.pop');
  check('an upload opens in the popup', (await page.textContent('.pop .pop-body')) === 'the recording text');
  await page.keyboard.press('Escape');
  await button.click();
  await menu.locator('.files-row', { hasText: 'Pasted text' }).click();
  await page.waitForSelector('.pop');
  check('a paste opens in the popup', (await page.textContent('.pop .pop-body')) === 'pasted agenda\nline two');
  await page.keyboard.press('Escape');

  // A file whose export warned that it may not match what Claude made carries a badge everywhere it shows.
  const agendaCard = page.locator('.msg[data-id="a1"] .art', { hasText: 'agenda.md' });
  check('a flagged file\'s card has a badge', (await agendaCard.locator('.flag').textContent()) === 'May not match' && (await page.locator('.art .flag').count()) === 1);
  await button.click();
  check('the Files list notes it', /may not match/.test(await menu.locator('.files-row', { hasText: 'agenda.md' }).textContent()));
  await page.keyboard.press('Escape');
  await agendaCard.click();
  await page.waitForSelector('#panel:not([hidden])');
  check('the panel explains it and names replay_bash.py', /may not match what Claude made/.test(await page.textContent('#panel-body .flag-note')) && /replay_bash\.py/.test(await page.textContent('#panel-body .flag-note')));
  await page.click('#panel .close');

  // Keyboard: Tab out closes the list; a file opened from it takes focus to the panel and back.
  await button.click();
  for (let i = 0; i < 12 && await menu.isVisible(); i++) await page.keyboard.press('Tab');
  check('Tab out of the list closes it', !(await menu.isVisible()) && await page.evaluate(() => !document.activeElement.closest('#files-menu')));
  await button.click();
  await page.keyboard.press('Enter');
  await page.waitForSelector('#panel:not([hidden])');
  check('opening a file from the list focuses the panel', await page.evaluate(() => !!document.activeElement.closest('#panel-head')));
  await page.keyboard.press('Enter');
  await page.waitForTimeout(100);
  check('closing it returns focus to the Files button', await page.evaluate(() => document.activeElement && document.activeElement.id === 'files-button'));

  // Closing: Escape, a click outside, the button again.
  await button.click();
  await page.keyboard.press('Escape');
  check('Escape closes the list and returns focus to the button', !(await menu.isVisible()) && await page.evaluate(() => document.activeElement && document.activeElement.id === 'files-button'));
  await button.click();
  await page.mouse.click(700, 500);
  check('a click outside closes it', !(await menu.isVisible()));
  await button.click();
  await button.click();
  check('the button toggles it', !(await menu.isVisible()));

  // A chat with no files has no button.
  await page.goto('file://' + file + '#chat=e');
  await page.waitForSelector('.msg[data-id="x"]');
  check('a chat with no files shows no Files button', !(await button.isVisible()));

  check('zero console errors', errors.length === 0, errors.join(' | '));
  await browser.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failed ? `${failed} failed` : 'all passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
