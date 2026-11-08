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
    msg('a2', 'h2', 'assistant', 'Survey and **survey** with [a link](https://survey.example/x)'), // 2; the URL isn't counted
  ];
  let parent = 'a2';
  for (let i = 0; i < 70; i++) { m.push(msg(`f${i}`, parent, i % 2 ? 'assistant' : 'human', `filler ${i}`)); parent = `f${i}`; }
  m.push(msg('far', parent, 'assistant', 'the far survey'));                    // 1
  return { uuid: 's', name: 'Stepper chat', model: 'claude-x', created_at: at(), updated_at: '2026-05-02T00:00:00Z', settings: {}, current_leaf_message_uuid: 'far', chat_messages: m };
}
// One chat per case, each with its own word.
const simple = (uuid, name, msgs) => {
  let parent = null;
  const m = msgs.map(([id, sender, text, extra]) => { const x = { ...msg(id, parent, sender, text), ...(extra || {}) }; parent = id; return x; });
  return { uuid, name, created_at: at(), updated_at: '2026-04-02T00:00:00Z', settings: {}, current_leaf_message_uuid: parent, chat_messages: m };
};
const extraChats = [
  // A reference-style link: its address is counted but never shown, so the step there finds nothing.
  simple('dead', 'Dead step chat', [['d1', 'human', 'ask about quokka'], ['d2', 'assistant', 'see [the page][r]\n\n[r]: https://quokka.example/x']]),
  simple('tr', 'Turkish chat', [['t1', 'human', 'plan it'], ['t2', 'assistant', 'Trip to İzmir: the wombatplan is ready']]),
  simple('math', 'Math chat', [['k1', 'human', 'explain'], ['k2', 'assistant', 'The narwhal angle is $\\text{narwhal}$ here']]),
  simple('code', 'Code chat', [['c1', 'human', 'write it'], ['c2', 'assistant', 'The axolotl code:\n\n```python\nprint(1)\nx = 2\n```\n\nand with axolotl:\n\n```js\nconst axolotl = 1;\n```']]),
  simple('up', 'Upload chat', [
    ['u1', 'human', 'see attached', { files_v2: [{ file_uuid: 'up-1', file_name: 'okapi-notes.pdf', file_kind: 'document', success: true }] }],
    ['u2', 'assistant', 'the okapi part is here'],
  ]),
];
const other = { uuid: 'o', name: 'Other chat', created_at: '2026-04-01T00:00:00Z', updated_at: '2026-04-01T00:00:00Z', settings: {}, current_leaf_message_uuid: 'x',
  chat_messages: [{ uuid: 'x', parent_message_uuid: null, sender: 'human', created_at: '2026-04-01T00:00:00Z', content: [{ type: 'text', text: 'unrelated' }] }] };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stepper-'));
  const file = path.join(dir, 'viewer.html');
  fs.writeFileSync(path.join(dir, VIEWER_CHECK_FILE), Buffer.from(VIEWER_CHECK_BASE64, 'base64'));
  fs.writeFileSync(file, buildHtml([conversation(), other, ...extraChats], '2026-11-08T12:00:00Z'));
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
  check('it counts every occurrence the conversation shows, not link addresses', (await pos()) === '1 of 7', await pos());
  check('the first match is highlighted', (await where()) === 'h1#0', await where());

  await next();
  check('next goes to a match on another branch', (await pos()) === '2 of 7' && (await where()) === 'old#0' && (await page.evaluate(() => location.hash)).includes('leaf=old'), `${await pos()} ${await where()}`);
  await next();
  check('then back onto the branch that has the next one', (await pos()) === '3 of 7' && (await where()) === 'a1#0', `${await pos()} ${await where()}`);
  await next();
  check('a second match in the same message', (await pos()) === '4 of 7' && (await where()) === 'a1#1', `${await pos()} ${await where()}`);
  await next();
  await next();
  check('bold text still counts', (await pos()) === '6 of 7' && (await where()) === 'a2#1', `${await pos()} ${await where()}`);
  await next();
  check('a word in a link address is not a match; far down the chat', (await pos()) === '7 of 7' && (await where()) === 'far#0', `${await pos()} ${await where()}`);
  check('the far match is scrolled into view', await page.evaluate(() => { const r = document.querySelector('#chat mark').getBoundingClientRect(), s = document.getElementById('scroll').getBoundingClientRect(); return r.top >= s.top && r.bottom <= s.bottom; }));
  check('next is disabled at the last match', await page.$eval('#findbar .find-next', b => b.disabled));
  await prev();
  check('previous goes back to the last match the page shows', (await pos()) === '6 of 7' && (await where()) === 'a2#1', `${await pos()} ${await where()}`);

  // Keyboard: Enter and Shift+Enter, from the page.
  await page.click('#top');
  await page.keyboard.press('Enter');
  await settle();
  check('Enter goes to the next match', (await pos()) === '7 of 7', await pos());
  await page.keyboard.press('Shift+Enter');
  await settle();
  check('Shift+Enter goes back', (await pos()) === '6 of 7', await pos());

  // Closing.
  await page.keyboard.press('Escape');
  check('Escape closes the bar and its highlight', !(await bar.isVisible()) && (await page.locator('#chat mark').count()) === 0);
  await page.locator('#results .snip').first().click();
  await page.waitForSelector('#chat mark');
  check('a snippet opens the bar at that match', (await bar.isVisible()) && /^1 of 7$/.test(await pos()), await pos());
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

  // ---- second review ----
  const search = async q => { await page.fill('.find input', ''); await page.fill('.find input', q); await page.waitForSelector('#results .group'); };
  const marked = () => page.evaluate(() => [...document.querySelectorAll('#chat mark')].map(m => m.textContent).join('|'));

  await search('quokka');
  await page.locator('#results .group-title').first().click();
  await page.waitForSelector('#findbar:not([hidden])');
  await settle();
  await next();
  check('a step that finds nothing on the page keeps the last match, with Next off', (await bar.isVisible()) && (await marked()) === 'quokka' && (await page.$eval('#findbar .find-next', b => b.disabled)), `${await pos()} ${await marked()}`);
  await page.click('.find .clear');
  await search('quokka');
  await page.locator('#results .snip', { hasText: 'quokka.example' }).click();
  await settle();
  check('a hit with nothing to show opens its message without a bar that keeps the keys', !(await bar.isVisible()) && (await page.evaluate(() => location.hash)).includes('chat=dead'));

  await search('wombatplan');
  await page.locator('#results .group-title').first().click();
  await page.waitForSelector('#findbar:not([hidden])');
  await settle();
  check('a match beside a Turkish İ is highlighted', (await marked()) === 'wombatplan' && (await pos()) === '1 of 1', `${await pos()} ${await marked()}`);

  await search('narwhal');
  await page.locator('#results .group-title').first().click();
  await page.waitForSelector('#findbar:not([hidden])');
  await settle();
  check('math is not counted or marked', (await pos()) === '1 of 1' && (await marked()) === 'narwhal' && (await page.$eval('#findbar .find-next', b => b.disabled)), `${await pos()} ${await marked()}`);

  await page.click('.find .clear');
  await page.locator('.item', { hasText: 'Code chat' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.msg[data-id="c2"] code.colored').length === 2, null, { timeout: 10000 }).catch(() => {});
  const coloredBefore = await page.$$eval('.msg[data-id="c2"] code.colored', c => c.length);
  await search('axolotl');
  await page.locator('#results .group-title').first().click();
  await page.waitForSelector('#findbar:not([hidden])');
  await settle();
  check('stepping to prose keeps colors in code without the word', coloredBefore === 2 && (await page.$$eval('.msg[data-id="c2"] code.colored', c => c.length)) >= 1, `${coloredBefore}`);
  await page.click('#findbar .find-close');
  await page.waitForFunction(() => document.querySelectorAll('.msg[data-id="c2"] code.colored').length === 2, null, { timeout: 10000 }).catch(() => {});
  check('code made plain for a match is colored again when the bar closes', (await page.$$eval('.msg[data-id="c2"] code.colored', c => c.length)) === 2);

  await search('okapi');
  await page.locator('#results .group-title').first().click();
  await page.waitForSelector('#findbar:not([hidden])');
  await settle();
  check('a title opens the first match the conversation shows, not a file-name hit', (await marked()) === 'okapi' && (await page.evaluate(() => document.querySelector('#chat mark').closest('.msg').dataset.id)) === 'u2');
  await page.click('#findbar .find-close');
  await page.locator('#results .snip', { hasText: 'okapi-notes' }).click();
  await settle();
  check('a file-name hit opens without the bar', !(await bar.isVisible()));
  // A highlight left by a hit opened without the bar (found in the chat's text) goes when the search is cleared.
  await page.evaluate(() => { const t = document.querySelector('.msg[data-id="u2"] .prose p').firstChild; const m = document.createElement('mark'); t.splitText(4); m.append(t.nextSibling); t.after(m); });
  await page.click('.find .clear');
  check('clearing the search removes that highlight too', (await page.locator('#chat mark').count()) === 0);

  check('zero console errors', errors.length === 0, errors.join(' | '));
  await browser.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failed ? `${failed} failed` : 'all passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
