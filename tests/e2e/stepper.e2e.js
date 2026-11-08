// The in-chat "match N of M" bar over file:// in Chromium: stepping through every occurrence, across
// messages, onto another branch and far down a long chat, skipping matches the page doesn't show,
// keyboard, and closing.
const { chromium } = require(process.env.PW);
const fs = require('fs'), os = require('os'), path = require('path');
const { buildHtml } = require('./make-viewer.js');
const { VIEWER_CHECK_BASE64, VIEWER_CHECK_FILE } = require('../../takeout-viewer.js');

let n = 0;
const at = () => { const t = n++; return `2026-05-01T${String(10 + Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}:00Z`; };
const msg = (uuid, parent, sender, text) => ({ uuid, parent_message_uuid: parent, sender, created_at: at(), content: [{ type: 'text', text }], attachments: [], files: [], files_v2: [] });

function conversation() {
  const m = [
    msg('h1', null, 'human', 'start the survey work'),                          // 1
    msg('old', 'h1', 'assistant', 'an older survey reply'),                     // 1, on another branch
    msg('a1', 'h1', 'assistant', 'two survey mentions: survey here'),          // 2
    msg('h2', 'a1', 'human', 'thanks'),
    msg('a2', 'h2', 'assistant', 'Survey and **survey** with [a link](https://survey.example/x)'), // 3, one hidden in the URL
  ];
  let parent = 'a2';
  for (let i = 0; i < 70; i++) { m.push(msg(`f${i}`, parent, i % 2 ? 'assistant' : 'human', `filler ${i}`)); parent = `f${i}`; }
  m.push(msg('far', parent, 'assistant', 'the far survey'));                    // 1
  return { uuid: 's', name: 'Stepper chat', model: 'claude-x', created_at: at(), updated_at: '2026-05-02T00:00:00Z', settings: {}, current_leaf_message_uuid: 'far', chat_messages: m };
}
const other = { uuid: 'o', name: 'Other chat', created_at: '2026-04-01T00:00:00Z', updated_at: '2026-04-01T00:00:00Z', settings: {}, current_leaf_message_uuid: 'x',
  chat_messages: [{ uuid: 'x', parent_message_uuid: null, sender: 'human', created_at: '2026-04-01T00:00:00Z', content: [{ type: 'text', text: 'unrelated' }] }] };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stepper-'));
  const file = path.join(dir, 'viewer.html');
  fs.writeFileSync(path.join(dir, VIEWER_CHECK_FILE), Buffer.from(VIEWER_CHECK_BASE64, 'base64'));
  fs.writeFileSync(file, buildHtml([conversation(), other], '2026-11-08T12:00:00Z'));
  const browser = await chromium.launch({ executablePath: process.env.CHROME_EXE });
  let failed = 0;
  const check = (name, ok, x = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${ok ? '' : x}`); };
  const context = await browser.newContext({ viewport: { width: 1300, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.route('**/*', r => (r.request().url().startsWith('file:') ? r.continue() : r.abort()));
  await page.goto('file://' + file);
  await page.waitForSelector('.msg');

  const bar = page.locator('#findbar');
  const pos = () => page.textContent('#findbar .find-pos');
  // Where the one highlight is: its message and which visible occurrence in that message it is.
  const where = () => page.evaluate(() => {
    const marks = document.querySelectorAll('#chat mark');
    if (marks.length !== 1) return `marks:${marks.length}`;
    const msg = marks[0].closest('.msg');
    const before = document.createRange();
    before.setStart(msg, 0);
    before.setEndBefore(marks[0]);
    return `${msg.dataset.id}#${(before.toString().toLowerCase().match(/survey/g) || []).length}`;
  });
  const settle = () => page.waitForTimeout(250);
  const next = async () => { await page.click('#findbar .find-next'); await settle(); };
  const prev = async () => { await page.click('#findbar .find-prev'); await settle(); };

  await page.fill('.find input', 'survey');
  await page.waitForSelector('#results .group');
  await page.locator('#results .group-title').first().click();
  await page.waitForSelector('#chat mark');
  await settle();
  check('opening a result shows the bar', await bar.isVisible());
  check('it counts every occurrence the conversation shows', (await pos()) === '1 of 8', await pos());
  check('the first match is highlighted', (await where()) === 'h1#0', await where());

  await next();
  check('next goes to a match on another branch', (await pos()) === '2 of 8' && (await where()) === 'old#0' && (await page.evaluate(() => location.hash)).includes('leaf=old'), `${await pos()} ${await where()}`);
  await next();
  check('then back onto the branch that has the next one', (await pos()) === '3 of 8' && (await where()) === 'a1#0', `${await pos()} ${await where()}`);
  await next();
  check('a second match in the same message', (await pos()) === '4 of 8' && (await where()) === 'a1#1', `${await pos()} ${await where()}`);
  await next();
  await next();
  check('bold text still counts', (await pos()) === '6 of 8' && (await where()) === 'a2#1', `${await pos()} ${await where()}`);
  await next();
  check('a match hidden in a link address is skipped, far down the chat', (await pos()) === '8 of 8' && (await where()) === 'far#0', `${await pos()} ${await where()}`);
  check('the far match is scrolled into view', await page.evaluate(() => { const r = document.querySelector('#chat mark').getBoundingClientRect(), s = document.getElementById('scroll').getBoundingClientRect(); return r.top >= s.top && r.bottom <= s.bottom; }));
  check('next is disabled at the last match', await page.$eval('#findbar .find-next', b => b.disabled));
  await prev();
  check('previous goes back to the last match the page shows', (await pos()) === '6 of 8' && (await where()) === 'a2#1', `${await pos()} ${await where()}`);

  // Keyboard: Enter and Shift+Enter, from the page.
  await page.click('#top');
  await page.keyboard.press('Enter');
  await settle();
  check('Enter goes to the next match', (await pos()) === '8 of 8', await pos());
  await page.keyboard.press('Shift+Enter');
  await settle();
  check('Shift+Enter goes back', (await pos()) === '6 of 8', await pos());

  // Closing.
  await page.keyboard.press('Escape');
  check('Escape closes the bar and its highlight', !(await bar.isVisible()) && (await page.locator('#chat mark').count()) === 0);
  await page.locator('#results .snip').first().click();
  await page.waitForSelector('#chat mark');
  check('a snippet opens the bar at that match', (await bar.isVisible()) && /^1 of 8$/.test(await pos()), await pos());
  await page.click('#findbar .find-close');
  check('the close button closes it', !(await bar.isVisible()));
  await page.locator('#results .snip').nth(1).click();
  await page.waitForSelector('#findbar:not([hidden])');
  await page.click('.find .clear');
  check('clearing the search closes it', !(await bar.isVisible()));
  await page.fill('.find input', 'survey');
  await page.waitForSelector('#results .group');
  await page.locator('#results .group-title').first().click();
  await page.waitForSelector('#findbar:not([hidden])');
  await page.click('.find .clear');
  await page.locator('.item', { hasText: 'Other chat' }).click();
  check('opening another chat closes it', !(await bar.isVisible()));

  check('zero console errors', errors.length === 0, errors.join(' | '));
  await browser.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failed ? `${failed} failed` : 'all passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
