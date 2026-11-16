// Long prompts over file:// in Chromium: collapsed to their first lines with a fade and Show more, as
// claude.ai shows them; short ones whole; a search hit inside a collapsed prompt expands it.
const { chromium } = require(process.env.PW);
const fs = require('fs'), os = require('os'), path = require('path');
const { buildHtml } = require('./make-viewer.js');
const { VIEWER_CHECK_BASE64, VIEWER_CHECK_FILE } = require('../../takeout-viewer.js');

const at = n => `2026-05-01T10:${String(n).padStart(2, '0')}:00Z`;
const msg = (uuid, parent, sender, n, text) => ({ uuid, parent_message_uuid: parent, sender, created_at: at(n), content: [{ type: 'text', text }], attachments: [], files: [], files_v2: [] });
const long = '```\nThree options on the table for the 2027 year-end performance:\n\n' + Array.from({ length: 30 }, (_, i) => `OPTION ${i + 1}: a hall with ${300 + i} seats, described at some length here.`).join('\n\n') + '\n\nThe last line mentions a zebracorn.\n```\nWhich is best?';
const chat = {
  uuid: 'p', name: 'Venues', model: 'claude-x', created_at: at(1), updated_at: at(4), settings: {}, current_leaf_message_uuid: 'a2',
  chat_messages: [
    msg('h1', null, 'human', 1, long),
    msg('a1', 'h1', 'assistant', 2, 'Option 2.'),
    msg('h2', 'a1', 'human', 3, 'thanks, short one: https://github.com/juliusbrussee/caveman.'),
    { ...msg('a2', 'h2', 'assistant', 4, ''), content: [
      { type: 'tool_use', id: 'f1', name: 'web_fetch', input: { url: 'https://github.com/juliusbrussee/caveman' } },
      { type: 'tool_result', tool_use_id: 'f1', name: 'web_fetch', content: [{ type: 'text', text: 'page text' }] },
      { type: 'text', text: 'Welcome.' }] },
  ],
};

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompts-'));
  const file = path.join(dir, 'viewer.html');
  fs.writeFileSync(path.join(dir, VIEWER_CHECK_FILE), Buffer.from(VIEWER_CHECK_BASE64, 'base64'));
  fs.writeFileSync(file, buildHtml([chat], '2026-11-15T12:00:00Z'));
  const browser = await chromium.launch({ executablePath: process.env.CHROME_EXE });
  let failed = 0;
  const check = (n, ok, x = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n} ${ok ? '' : x}`); };
  const page = await (await browser.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('file://' + file + '#chat=p');
  await page.waitForSelector('.msg');

  const longBubble = page.locator('.msg.human .bubble').first();
  const shortBubble = page.locator('.msg.human .bubble').nth(1);
  const height = b => b.locator('.bubble-body').evaluate(e => e.getBoundingClientRect().height);
  check('a long prompt starts collapsed', (await longBubble.getAttribute('class')).includes('collapsed') && await height(longBubble) <= 200);
  check('it fades out', /gradient/.test(await longBubble.locator('.bubble-body').evaluate(e => getComputedStyle(e).webkitMaskImage)));
  check('its fence is a code block', await longBubble.locator('pre code').count() === 1);
  check('Show more is offered', (await longBubble.locator('.more-toggle').textContent()) === 'Show more');
  check('a short prompt shows whole, with no toggle', await shortBubble.locator('.more-toggle').count() === 0 && !(await shortBubble.getAttribute('class')).includes('collapsed'));
  await longBubble.locator('.more-toggle').click();
  check('Show more shows it all', await height(longBubble) > 400 && (await longBubble.locator('.more-toggle').textContent()) === 'Show less' && (await longBubble.locator('.more-toggle').getAttribute('aria-expanded')) === 'true');
  await longBubble.locator('.more-toggle').click();
  check('Show less collapses it again', (await longBubble.getAttribute('class')).includes('collapsed'));

  await page.fill('.find input', 'zebracorn');
  await page.waitForSelector('#results .group');
  await page.locator('#results .group-title').first().click();
  await page.waitForSelector('#chat mark');
  await page.waitForTimeout(300);
  check('a search hit inside a collapsed prompt expands it and is visible', !(await longBubble.getAttribute('class')).includes('collapsed')
    && await page.locator('#chat mark').evaluate(m => { const r = m.getBoundingClientRect(); return r.height > 0 && r.top >= 0 && r.bottom <= innerHeight; }));
  const link = shortBubble.locator('.typed a');
  check('a web address in a prompt is a link, its full stop left out', await link.count() === 1 && (await link.getAttribute('href')) === 'https://github.com/juliusbrussee/caveman'
    && (await shortBubble.locator('.typed').textContent()).endsWith('caveman.') && (await link.getAttribute('rel')).includes('noopener'));
  const fetchLine = page.locator('.msg.assistant').nth(1).locator(':scope > details.tool');
  check('a single fetch is its own line: Read <host> and the address', await fetchLine.count() === 1
    && (await fetchLine.locator(':scope > summary .label').textContent()).trim() === 'Read github.com'
    && (await fetchLine.locator('.step-link').getAttribute('href')) === 'https://github.com/juliusbrussee/caveman');
  check('no group line for one step', await page.locator('.msg.assistant').nth(1).locator(':scope > details.steps').count() === 0);
  check('no page errors', errors.length === 0, errors.join(' | '));

  await browser.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e.message); process.exit(1); });
