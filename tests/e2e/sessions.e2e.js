// Claude Code and Cowork sessions in the chat viewer, over file:// in Chromium: the Sessions entry and its count, the
// #sessions list page (newest first, filter), a session opened in the chat area (its title, folded thinking, a tool
// step cut at 2 KB, a subagent inside its step, its image from sessions/<folder>/images, a compaction and a command
// labelled), the fold bar's line and artifact link, the artifact's "Made in session" link back, search labelled
// Session opening the session at the message, a hostile title as text, sessions kept out of Recents and All chats,
// Back from a session to #sessions, and a one-chat viewer with sessions. No requests outside file:, no page errors.
// Run: PW=<playwright-core> CHROME_EXE=<chrome> node tests/e2e/sessions.e2e.js
const { chromium } = require(process.env.PW);
const fs = require('fs'), os = require('os'), path = require('path');
const { buildHtml } = require('./make-viewer.js');
const { VIEWER_CHECK_BASE64, VIEWER_CHECK_FILE, buildViewerSession } = require('../../takeout-viewer.js');
const { uuidToBase58 } = require('../../export-core.js');

const BASE = Date.UTC(2026, 0, 1);
const iso = h => new Date(BASE + h * 3600 * 1000).toISOString();
function chat(i) {
  const uuid = `c${i}`;
  const messages = [0, 1].map(n => ({
    uuid: `${uuid}-${n}`, parent_message_uuid: n ? `${uuid}-0` : null, sender: n ? 'assistant' : 'human',
    created_at: iso(i), content: [{ type: 'text', text: `Message ${n} of chat ${i}` }], attachments: [], files: [], files_v2: [],
  }));
  return { uuid, name: `Chat ${i}`, model: 'claude-x', created_at: iso(i), updated_at: iso(i), settings: {}, current_leaf_message_uuid: `${uuid}-1`, chat_messages: messages };
}
const CHATS = [0, 1, 2].map(chat);

const ART = 'abcdef01-2345-4678-89ab-cdef01234567';
const ART_ID = uuidToBase58(ART);
const HOSTILE = '<img src=x onerror="console.log(\'TITLE RAN\')">Hostile';
const ev = (uuid, type, content, extra = {}) => ({ type, uuid, created_at: iso(50), parent_tool_use_id: null,
  message: { role: type === 'user' ? 'user' : 'assistant', content }, ...extra });
const LONG = 'y'.repeat(5000);
const FOLDER_A = 'sessions/Fix_the_build_a1';
const SESSION_A = buildViewerSession({
  id: 'cse_a1', title: 'Fix the build', config: { origin: 'cowork', model: 'claude-opus-4-8' },
  created_at: iso(40), last_event_at: iso(60), external_metadata: { artifacts: [{ artifact_id: ART.toUpperCase(), title: 'x' }] },
}, [
  ev('a-compact', 'user', [{ type: 'text', text: 'This session is being continued from a previous conversation that ran out of context. Summary: earlier work.' }]),
  ev('a-cmd', 'user', [{ type: 'text', text: '<command-name>/review</command-name>\n<command-args>main</command-args>' }]),
  ev('a-p1', 'user', [{ type: 'text', text: 'Please deploy the zebra service' }, { type: 'image', file: 'images/1.png' }, { type: 'image', missing: 'not saved' }]),
  ev('a-r1', 'assistant', [{ type: 'thinking', thinking: 'Quietly pondering the plan' }]),
  ev('a-r2', 'assistant', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'cat big.log' } }]),
  ev('a-r3', 'user', [{ type: 'tool_result', tool_use_id: 't1', content: LONG }]),
  ev('a-r4', 'assistant', [{ type: 'tool_use', id: 'ag1', name: 'Agent', input: { description: 'Look around', prompt: 'Find the config' } }]),
  ev('a-c1', 'user', [{ type: 'text', text: 'Find the config' }], { parent_tool_use_id: 'ag1' }),
  ev('a-c2', 'assistant', [{ type: 'text', text: 'Subagent found config.yml' }], { parent_tool_use_id: 'ag1' }),
  ev('a-r5', 'user', [{ type: 'tool_result', tool_use_id: 'ag1', content: [{ type: 'text', text: 'config.yml' }] }]),
  ev('a-r6', 'assistant', [{ type: 'text', text: 'Deployed.' }]),
], { folder: FOLDER_A });
const SESSION_B = buildViewerSession({
  id: 'cse_b2', title: HOSTILE, config: { origin: 'claude-code' }, created_at: iso(10), last_event_at: iso(20),
}, [ev('b-p1', 'user', [{ type: 'text', text: 'Hello from the older session' }]), ev('b-r1', 'assistant', [{ type: 'text', text: 'Hi.' }])], { folder: 'sessions/Hostile_b2' });
const VIEW = { id: ART_ID, title: 'Session page', kind: 'Page', typed: false, docs: false, shared: false, public: false, createdAt: iso(41), updatedAt: iso(42),
  folder: 'artifacts/Session_page', start: null, files: [], url: `https://claude.ai/artifact/${ART_ID}` };
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-'));
  const file = path.join(dir, 'viewer.html');
  const one = path.join(dir, 'one.html');
  fs.writeFileSync(path.join(dir, VIEWER_CHECK_FILE), Buffer.from(VIEWER_CHECK_BASE64, 'base64'));
  fs.mkdirSync(path.join(dir, FOLDER_A, 'images'), { recursive: true });
  fs.writeFileSync(path.join(dir, FOLDER_A, 'images', '1.png'), Buffer.from(PNG, 'base64'));
  const opts = { sessions: [SESSION_B, SESSION_A], artifacts: { views: [VIEW], listed: 1, exported: iso(70), since: null } };
  fs.writeFileSync(file, buildHtml(CHATS, iso(70), () => ({}), opts));
  fs.writeFileSync(one, buildHtml([chat(5)], iso(70), () => ({}), { sessions: [SESSION_A] }));
  const browser = await chromium.launch({ executablePath: process.env.CHROME_EXE });
  let failed = 0;
  const check = (n, ok, x = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n} ${ok ? '' : x}`); };
  const context = await browser.newContext({ viewport: { width: 1300, height: 900 } });
  const errors = [], requests = [];
  async function open(url) {
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error' || m.text().includes('RAN')) errors.push(m.text()); });
    await page.route('**/*', r => { const u = r.request().url(); if (u.startsWith('file:')) r.continue(); else { requests.push(u); r.abort(); } });
    await page.goto(url);
    return page;
  }
  const page = await open('file://' + file);
  await page.waitForSelector('.msg');
  const visible = sel => page.locator(sel).first().isVisible();
  const hash = () => page.evaluate(() => location.hash);
  const txt = async sel => ((await page.locator(sel).count()) ? page.textContent(sel) : null);

  // The entry
  check('the Sessions entry shows with its count', (await page.locator('#sessions-nav').count()) === 1 && await visible('#sessions-nav') && (await txt('#sessions-nav .n')) === '2', await txt('#sessions-nav'));
  check('sessions are not in Recents or All chats: the Chats count', (await txt('#chats-nav .n')) === '3');
  const recents = await page.$$eval('#recents .item', l => l.map(x => x.textContent));
  check('sessions are not in Recents', recents.join() === 'Chat 2,Chat 1,Chat 0', recents.join());

  // #sessions
  await page.click('#sessions-nav');
  await page.waitForFunction(() => location.hash === '#sessions');
  const rows = await page.$$eval('#lists-screen a.chat-row', l => l.map(a => [a.textContent, a.getAttribute('href')]));
  check('#sessions lists sessions newest first', rows.length === 2 && rows[0][0] === 'Fix the build' && rows[0][1] === '#session=cse_a1' && rows[1][0] === HOSTILE, JSON.stringify(rows));
  check('#sessions: heading, titles and the entry current', (await txt('#lists-screen h2.list-title')) === 'Sessions' && (await page.title()) === 'Sessions - Claude Takeout'
    && (await page.getAttribute('#sessions-nav', 'aria-current')) === 'true' && (await page.getAttribute('#chats-nav', 'aria-current')) === 'false'
    && (await page.getAttribute('#projects-nav', 'aria-current')) === 'false');
  const sub = await txt('#lists-screen .chat-line .chat-sub');
  check('#sessions: a row names its origin and activity', /cowork/.test(sub || '') && /Updated/.test(sub || ''), sub);
  check('a hostile title is text in the list', (await page.locator('#lists-screen img').count()) === 0);
  await page.fill('#lists-screen input.list-filter', 'build');
  await page.waitForFunction(() => document.querySelectorAll('#lists-screen a.chat-row').length === 1);
  check('#sessions filters', (await txt('#lists-screen a.chat-row')) === 'Fix the build');

  // A session
  await page.click('#lists-screen a.chat-row');
  await page.waitForFunction(() => location.hash === '#session=cse_a1');
  await page.waitForSelector('#chat .msg');
  check('a session opens with its title', (await txt('#title')) === 'Fix the build' && (await page.title()) === 'Fix the build - Claude Takeout' && await visible('#scroll') && !(await visible('#lists-screen')));
  check('a session: thinking is folded', (await page.locator('#chat details.line.thinking').count()) >= 1 && !(await page.locator('#chat details.line.thinking').first().evaluate(d => d.open)));
  const stepText = await page.evaluate(() => {
    for (const d of document.querySelectorAll('#chat details')) d.open = true;
    return [...document.querySelectorAll('#chat .tool-part pre')].map(p => p.textContent).find(t => t.startsWith('yyy')) || '';
  });
  check('a session: a tool step cut at 2 KB', stepText === 'y'.repeat(2048) + '\n[… full output in session.json]', stepText.length);
  await page.waitForFunction(() => [...document.querySelectorAll('#chat .tool-children')].some(b => b.textContent.includes('Subagent found config.yml')));
  check('a session: a subagent shows inside its step', true);
  const img = await page.evaluate(() => {
    const i = document.querySelector('#chat .msg.human img.prompt-image');
    return i ? new Promise(ok => { const done = () => ok([i.getAttribute('src'), i.naturalWidth]); if (i.complete) done(); else { i.onload = done; i.onerror = done; } }) : null;
  });
  check('its image loads from sessions/<folder>/images', img && img[0] === `${FOLDER_A}/images/1.png` && img[1] > 0, JSON.stringify(img));
  check('a missing image says so', /Image not saved/.test(await txt('#chat .msg.human .image-missing') || ''));
  const labelled = await page.$$eval('#chat .msg.labelled', l => l.map(x => x.className + '|' + x.textContent));
  const prompts = await page.$$eval('#chat .msg.human .bubble', l => l.map(x => x.textContent).join('\n'));
  check('a compaction and a command are labelled, not shown as prompts', labelled.length === 2 && /compaction/.test(labelled[0]) && /Ran \/review main/.test(labelled[1])
    && !/continued from a previous/.test(prompts) && !/Ran \/review/.test(prompts) && /zebra/.test(prompts), JSON.stringify(labelled));

  // The fold bar and the artifact both ways
  check('the fold bar says Session · <origin>', /Session · cowork/.test(await txt('#project') || '') && await visible('#project'), await txt('#project'));
  const artLink = page.locator(`#project a[href="#a=${ART_ID}"]`);
  check('the fold bar links its artifact', (await artLink.count()) === 1 && (await artLink.textContent()) === 'Session page');
  await artLink.click();
  await page.waitForFunction(id => location.hash === '#a=' + id, ART_ID);
  const back = page.locator('#artifacts-screen a.session-link');
  await back.first().waitFor();
  const made = await page.locator('#artifacts-screen #page-from').textContent();
  check('the artifact links back: Made in session <title>', /Made in session Fix the build/.test(made) && (await back.getAttribute('href')) === '#session=cse_a1', made);
  await back.click();
  await page.waitForFunction(() => location.hash === '#session=cse_a1');
  await page.waitForSelector('#chat .msg');
  check('the link back opens the session', (await txt('#title')) === 'Fix the build' && !(await visible('#artifacts-screen')));

  // Back from a session returns to #sessions
  await page.goBack(); // the artifact
  await page.waitForFunction(id => location.hash === '#a=' + id, ART_ID);
  await page.goBack(); // the session
  await page.waitForFunction(() => location.hash === '#session=cse_a1');
  await page.goBack();
  await page.waitForFunction(() => location.hash === '#sessions');
  check('Back from a session returns to #sessions', await visible('#lists-screen') && (await txt('#lists-screen h2.list-title')) === 'Sessions');
  check('Back to #sessions keeps its filter', (await page.inputValue('#lists-screen input.list-filter')) === 'build');
  await page.goForward();
  await page.waitForFunction(() => location.hash === '#session=cse_a1');
  check('Forward to the session: its title', (await txt('#title')) === 'Fix the build');

  // All chats
  await page.click('#chats-nav');
  await page.waitForFunction(() => location.hash === '#chats');
  const chatRows = await page.$$eval('#lists-screen a.chat-row', l => l.map(a => a.textContent));
  check('sessions are not in All chats', chatRows.join() === 'Chat 2,Chat 1,Chat 0', chatRows.join());

  // A chat, then search
  await page.click('#recents .item[data-id="c1"]');
  await page.waitForFunction(() => location.hash.includes('chat=c1'));
  check('a chat after a session: its title and no session line', (await txt('#title')) === 'Chat 1' && !/Session ·/.test(await txt('#project') || ''));
  await page.locator('.find input').fill('zebra');
  await page.waitForFunction(() => !document.getElementById('results').hidden && document.querySelector('#results .group'));
  const group = await page.$eval('#results .group', g => g.textContent);
  check('search finds a session prompt, labelled Session', /Session/.test(group) && /Fix the build/.test(group), group);
  await page.click('#results .group .snip');
  await page.waitForFunction(() => location.hash.startsWith('#session=cse_a1'));
  await page.waitForSelector('#chat mark');
  const at = await page.evaluate(() => [location.hash, document.querySelector('#chat mark').textContent.toLowerCase(), document.querySelector('#chat mark').closest('.msg').dataset.id]);
  check('search opens the session at the message', at[0] === '#session=cse_a1&msg=a-p1' && at[1] === 'zebra' && at[2] === 'a-p1', JSON.stringify(at));
  await page.locator('.find input').fill('');

  // The hostile session
  await page.evaluate(() => { location.hash = '#session=cse_b2'; });
  await page.waitForFunction(() => document.getElementById('title').textContent.endsWith('Hostile'));
  check('a hostile title is text', (await txt('#title')) === HOSTILE && (await page.title()) === `${HOSTILE} - Claude Takeout` && (await page.locator('#title img, #main img[src="x"]').count()) === 0);
  check('a session with no artifacts: the line without links', /Session · claude-code/.test(await txt('#project') || '') && (await page.locator('#project a').count()) === 0);

  // A one-chat viewer with sessions
  const single = await open('file://' + one);
  await single.waitForSelector('.msg');
  check('a one-chat viewer with sessions shows the entry', await single.locator('#sessions-nav').isVisible() && (await single.textContent('#sessions-nav .n')) === '1');
  await single.click('#sessions-nav');
  await single.waitForFunction(() => location.hash === '#sessions');
  check('a one-chat viewer: #sessions lists it', (await single.$$eval('#lists-screen a.chat-row', l => l.length)) === 1);
  check('a one-chat viewer: no Chats or Projects entry', !(await single.locator('#chats-nav').isVisible()) && !(await single.locator('#projects-nav').isVisible()));
  await single.goBack();
  await single.waitForFunction(() => location.hash.includes('chat=c5'));
  check('a one-chat viewer: Back to its chat', (await single.textContent('#title')) === 'Chat 5');

  check('no network, no page error', errors.length === 0 && requests.length === 0, errors.concat(requests).join(' | '));
  await browser.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failed ? `${failed} failed` : 'all passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
