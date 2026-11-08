// Sidebar search over file:// in Chromium: grouped and ranked results, matched words in bold, the
// clear button, the / shortcut, arrow keys, and operators.
const { chromium } = require(process.env.PW);
const fs = require('fs'), os = require('os'), path = require('path');
const { buildHtml } = require('./make-viewer.js');
const { VIEWER_CHECK_BASE64, VIEWER_CHECK_FILE } = require('../../takeout-viewer.js');

let clock = 0;
const at = () => `2026-05-01T10:${String(clock++).padStart(2, '0')}:00Z`;
function chat(uuid, name, updated, texts) {
  const messages = texts.map((text, i) => ({
    uuid: `${uuid}-${i}`, parent_message_uuid: i ? `${uuid}-${i - 1}` : null, sender: i % 2 ? 'assistant' : 'human',
    created_at: at(), content: [{ type: 'text', text }], attachments: [], files: [], files_v2: [],
  }));
  return { uuid, name, model: 'claude-x', created_at: updated, updated_at: updated, settings: {}, current_leaf_message_uuid: messages[messages.length - 1].uuid, chat_messages: messages };
}

// Newest first in the sidebar: busy (newest), then survey-title, then other.
const CHATS = [
  chat('busy', 'Board minutes', '2026-05-03T00:00:00Z', ['the survey was sent', 'survey results in', 'another survey note', 'survey four', 'final survey draft']),
  chat('titled', 'Survey analysis', '2026-05-02T00:00:00Z', ['what did people say', 'they liked the poll']),
  chat('other', 'Lunch', '2026-05-01T00:00:00Z', ['feedback on the survey menu', 'the menu feedback was good']),
];

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'search-'));
  const file = path.join(dir, 'viewer.html');
  fs.writeFileSync(path.join(dir, VIEWER_CHECK_FILE), Buffer.from(VIEWER_CHECK_BASE64, 'base64'));
  fs.writeFileSync(file, buildHtml(CHATS, '2026-11-08T12:00:00Z'));
  const browser = await chromium.launch({ executablePath: process.env.CHROME_EXE });
  let failed = 0;
  const check = (n, ok, x = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n} ${ok ? '' : x}`); };
  const context = await browser.newContext({ viewport: { width: 1300, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.route('**/*', r => (r.request().url().startsWith('file:') ? r.continue() : r.abort()));
  await page.goto('file://' + file);
  await page.waitForSelector('.msg');

  const input = page.locator('.find input');
  const search = async q => {
    await input.fill(q);
    await page.waitForFunction(() => !document.getElementById('results').hidden && document.querySelector('#results .lab'));
    await page.waitForTimeout(200);
  };
  const groups = () => page.$$eval('#results .group', gs => gs.map(g => g.querySelector('.group-title b').textContent));

  // The / shortcut puts the cursor in the box.
  await page.click('#chat');
  await page.keyboard.press('/');
  check('/ focuses the search box', await page.evaluate(() => document.activeElement === document.querySelector('.find input')));

  await search('survey');
  check('one group per chat', (await groups()).length === 3, (await groups()).join(' | '));
  check('the chat whose title matches comes first, then the busiest', (await groups()).join(' | ') === 'Survey analysis | Board minutes | Lunch', (await groups()).join(' | '));
  check('the summary counts chats and matches', /3 chats · 6 matches/.test(await page.textContent('#results .lab')), await page.textContent('#results .lab'));
  const busy = page.locator('#results .group').nth(1);
  check('a group counts matches and messages, as the match bar does', (await busy.locator('.group-title small').textContent()) === '5 matches in 5 messages', await busy.locator('.group-title small').textContent());
  check('one match reads in the singular', (await page.locator('#results .group').nth(2).locator('.group-title small').textContent()) === '1 match in 1 message');
  check('a chat matched only by its title shows no count', (await page.locator('#results .group').first().locator('.group-title small').count()) === 0);
  check('at most three snippets per chat', (await busy.locator('.snip').count()) === 3);
  check('matched words are bold', (await busy.locator('.snip mark').first().textContent()).toLowerCase() === 'survey');
  check('a matching title is bold too', (await page.locator('#results .group').first().locator('.group-title mark').count()) === 1);

  // A chat that matches only by its title opens at the top, with nothing highlighted.
  await page.locator('#results .group').first().locator('.group-title').click();
  await page.waitForFunction(() => location.hash.includes('chat=titled'));
  await page.waitForTimeout(200);
  check('a title-only match opens the chat with no highlight', (await page.locator('#chat mark').count()) === 0);

  // Clicking a snippet opens that message, highlighted.
  await busy.locator('.snip').nth(1).click();
  await page.waitForFunction(() => document.querySelector('#chat mark'));
  check('a snippet opens its message', (await page.evaluate(() => location.hash)).includes('chat=busy') && (await page.$eval('#chat mark', m => m.closest('.msg').dataset.id)) === 'busy-1');

  // Words in any order, operators.
  await search('feedback survey');
  check('words match in any order', (await groups()).join() === 'Lunch', (await groups()).join());
  await search('"menu feedback"');
  check('quotes match a phrase', (await page.locator('#results .snip').count()) === 1);
  await search('survey -draft');
  check('-word excludes', !(await page.textContent('#results')).includes('final survey draft'));
  await search('poll OR menu');
  check('OR takes either', (await groups()).length === 2, (await groups()).join());
  await search('zebra');
  check('no match says so', (await page.textContent('#results .lab')) === 'No matches');

  // Arrow keys move through results; Enter opens one.
  await search('survey');
  await input.press('ArrowDown');
  const first = await page.evaluate(() => document.activeElement.className);
  await page.keyboard.press('ArrowDown');
  const second = await page.evaluate(() => document.activeElement.className + ':' + document.activeElement.textContent.slice(0, 30));
  check('ArrowDown moves from the box into the results and on', /group-title/.test(first) && /snip|group-title/.test(second), `${first} / ${second}`);
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  check('ArrowUp from the first result goes back to the box', await page.evaluate(() => document.activeElement === document.querySelector('.find input')));

  // The clear button.
  const clear = page.locator('.find .clear');
  check('the clear button shows when there is text', await clear.isVisible());
  await clear.click();
  check('clear empties the box and shows the chat list again', (await input.inputValue()) === '' && await page.$eval('#results', r => r.hidden) && !(await page.$eval('#recents', r => r.hidden)));
  check('the clear button hides again', !(await clear.isVisible()));
  check('focus stays in the box', await page.evaluate(() => document.activeElement === document.querySelector('.find input')));
  await search('survey');
  await input.press('Escape');
  check('Escape still clears', (await input.inputValue()) === '' && await page.$eval('#results', r => r.hidden));

  check('zero console errors', errors.length === 0, errors.join(' | '));
  await browser.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failed ? `${failed} failed` : 'all passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
