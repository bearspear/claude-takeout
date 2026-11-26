// The Projects and Chats entries over file:// in Chromium: 30 Recents, View all, the lists screen and its routes
// (#projects, #project=<key>, #chats), titles kept and put back, and a one-chat viewer left as it was.
const { chromium } = require(process.env.PW);
const fs = require('fs'), os = require('os'), path = require('path');
const { buildHtml } = require('./make-viewer.js');
const { VIEWER_CHECK_BASE64, VIEWER_CHECK_FILE } = require('../../takeout-viewer.js');

const COUNT = 230;
const BASE = Date.UTC(2026, 0, 1);
function chat(i) {
  const uuid = `c${String(i).padStart(3, '0')}`;
  // Spread over days, newest last; the last chat has no date at all.
  const updated = i === COUNT - 1 ? undefined : new Date(BASE + i * 7 * 3600 * 1000).toISOString();
  const messages = [0, 1].map(n => ({
    uuid: `${uuid}-${n}`, parent_message_uuid: n ? `${uuid}-0` : null, sender: n ? 'assistant' : 'human',
    created_at: new Date(BASE).toISOString(), content: [{ type: 'text', text: `Message ${n} of chat ${i}` }], attachments: [], files: [], files_v2: [],
  }));
  const c = { uuid, name: `Chat ${i}`, model: 'claude-x', created_at: new Date(BASE).toISOString(), settings: {}, current_leaf_message_uuid: `${uuid}-1`, chat_messages: messages };
  if (updated) c.updated_at = updated;
  return c;
}
const CHATS = Array.from({ length: COUNT }, (_, i) => chat(i));
const ALPHA = { id: 'p-a', name: 'Alpha', description: 'The alpha project', instructions: 'Be brief.', fileDir: 'project/files', fileNames: [], docs: [{ name: 'notes.md', text: 'Alpha notes' }] };
const BETA = { id: 'p-b', name: 'Beta <img src=x onerror="console.log(\'NAME RAN\')">', fileDir: 'project/files', fileNames: [], docs: [] };
const GAMMA = { name: 'Gamma', fileDir: 'project/files', fileNames: [], docs: [] }; // an older archive's project: no id
function projectOf(c) {
  const i = Number(c.uuid.slice(1));
  if (i < 10) return { project: ALPHA };
  if (i < 15) return { project: BETA };
  if (i < 18) return { project: GAMMA };
  return {};
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'projects-'));
  const file = path.join(dir, 'viewer.html');
  const one = path.join(dir, 'one.html');
  fs.writeFileSync(path.join(dir, VIEWER_CHECK_FILE), Buffer.from(VIEWER_CHECK_BASE64, 'base64'));
  fs.writeFileSync(file, buildHtml(CHATS, '2026-11-25T12:00:00Z', projectOf));
  fs.writeFileSync(one, buildHtml([chat(3)], '2026-11-25T12:00:00Z', () => ({ project: ALPHA })));
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
  const visible = sel => page.locator(sel).isVisible();
  const hash = () => page.evaluate(() => location.hash);
  const txt = async sel => ((await page.locator(sel).count()) ? page.textContent(sel) : null);

  // The sidebar
  check('sidebar: Projects shows with its count', await visible('#projects-nav') && (await txt('#projects-nav .n')) === '3', await txt('#projects-nav'));
  check('sidebar: Chats shows with its count', await visible('#chats-nav') && (await txt('#chats-nav .n')) === '230', await txt('#chats-nav'));
  const items = await page.$$eval('#recents .item', l => l.map(x => x.textContent));
  const want = Array.from({ length: 30 }, (_, i) => `Chat ${COUNT - 2 - i}`);
  check('sidebar: 30 Recents, newest first', items.join() === want.join(), items.slice(0, 4).join());
  const labs = await page.$$eval('#recents .lab', l => l.map(x => x.textContent));
  check('sidebar: no project headings', labs.join('|') === 'Recents', labs.join('|'));
  check('sidebar: View all shows', await visible('#recents .view-all') && (await txt('#recents .view-all')) === 'View all');
  const firstTitle = await page.textContent('#title');
  check('a chat opens first', firstTitle === 'Chat 228', firstTitle);

  // Projects
  await page.click('#projects-nav');
  await page.waitForFunction(() => location.hash === '#projects');
  check('projects: the lists screen shows in place of the chat', await visible('#lists-screen') && !(await visible('#scroll')));
  check('projects: heading', (await page.textContent('#lists-screen h2.list-title')) === 'Projects');
  check('projects: the heading has focus', await page.evaluate(() => document.activeElement.matches('#lists-screen h2.list-title') && document.activeElement.getAttribute('tabindex') === '-1'));
  check('projects: page title', (await page.title()) === 'Projects - Claude Takeout', await page.title());
  check('projects: top bar title', (await page.textContent('#title')) === 'Projects');
  check('projects: the entry is current', (await page.getAttribute('#projects-nav', 'aria-current')) === 'true' && (await page.getAttribute('#chats-nav', 'aria-current')) === 'false');
  check('projects: no chat is current', (await page.locator('#recents .item[aria-current="true"]').count()) === 0);

  // Back to the chat puts its title back.
  await page.goBack();
  await page.waitForFunction(() => location.hash.includes('chat='));
  check('back: the chat shows again', !(await visible('#lists-screen')) && await visible('#scroll'));
  check('back: the chat title is back', (await page.textContent('#title')) === 'Chat 228' && (await page.title()) === 'Chat 228 - Claude Takeout', await page.title());
  check('back: the entry is no longer current', (await page.getAttribute('#projects-nav', 'aria-current')) === 'false');
  check('back: the chat is current again', (await page.getAttribute('#recents .item[data-id="c228"]', 'aria-current')) === 'true');
  await page.goForward();
  await page.waitForFunction(() => location.hash === '#projects');
  check('forward: Projects again', await visible('#lists-screen') && (await page.textContent('#title')) === 'Projects');

  // View all and Chats
  await page.click('#recents .view-all');
  await page.waitForFunction(() => location.hash === '#chats');
  check('view all: Chats', (await page.textContent('#lists-screen h2.list-title')) === 'Chats' && (await page.title()) === 'Chats - Claude Takeout');
  check('view all: the Chats entry is current', (await page.getAttribute('#chats-nav', 'aria-current')) === 'true' && (await page.getAttribute('#projects-nav', 'aria-current')) === 'false');
  await page.click('#chats-nav');
  check('chats entry: stays on Chats', (await hash()) === '#chats' && await visible('#lists-screen'));

  // Projects -> Chats -> another chat: that chat's title.
  await page.click('#recents .item[data-id="c220"]');
  await page.waitForFunction(() => location.hash.includes('chat=c220'));
  check('a chat from the lists screen: its title', (await page.textContent('#title')) === 'Chat 220' && (await page.title()) === 'Chat 220 - Claude Takeout' && !(await visible('#lists-screen')));
  await page.goBack();
  await page.waitForFunction(() => location.hash === '#chats');
  await page.goBack();
  await page.waitForFunction(() => location.hash === '#projects');
  await page.goBack();
  await page.waitForFunction(() => location.hash.includes('chat=c228'));
  check('back twice through the screens: the first chat and its title', (await page.textContent('#title')) === 'Chat 228' && await visible('#scroll'));

  // A project page: heading only in this task; an unknown key is Projects.
  await page.evaluate(() => { location.hash = '#project=p-a'; });
  await page.waitForFunction(() => document.title === 'Alpha - Claude Takeout');
  check('project: its name as the heading', (await page.textContent('#lists-screen h2.list-title')) === 'Alpha');
  check('project: the Projects entry is current', (await page.getAttribute('#projects-nav', 'aria-current')) === 'true');
  await page.evaluate(() => { location.hash = '#project=p-b'; });
  await page.waitForFunction(() => document.title.startsWith('Beta'));
  check('project: a name with HTML is text', (await page.textContent('#lists-screen h2.list-title')) === BETA.name && (await page.locator('#lists-screen img').count()) === 0);
  await page.evaluate(() => { location.hash = '#project=nope'; });
  await page.waitForFunction(() => document.title === 'Projects - Claude Takeout');
  check('project: an unknown key shows Projects', (await page.textContent('#lists-screen h2.list-title')) === 'Projects');

  // With search typed the entries stay.
  await page.locator('.find input').fill('Chat 1');
  await page.waitForFunction(() => !document.getElementById('results').hidden);
  check('search: the entries stay', await visible('#projects-nav') && await visible('#chats-nav') && !(await visible('#recents')));
  await page.locator('.find input').fill('');

  // Opened at #projects: no chat drawn.
  const direct = await open('file://' + file + '#projects');
  await direct.waitForSelector('#lists-screen h2.list-title');
  check('direct: #projects shows Projects', (await direct.textContent('#lists-screen h2.list-title')) === 'Projects' && await direct.locator('#lists-screen').isVisible());
  check('direct: no chat is drawn', (await direct.locator('#chat .msg').count()) === 0);
  check('direct: the hash stays', (await direct.evaluate(() => location.hash)) === '#projects');
  await direct.click('#recents .item[data-id="c200"]');
  await direct.waitForFunction(() => location.hash.includes('chat=c200'));
  await direct.waitForSelector('#chat .msg');
  check('direct: a chat from there shows with its title', (await direct.textContent('#title')) === 'Chat 200' && !(await direct.locator('#lists-screen').isVisible()));
  // Projects are kept in the order of their newest chat: Gamma (chats 15-17) is first, and has no id.
  const gamma = await open('file://' + file + '#project=i0');
  await gamma.waitForSelector('#lists-screen h2.list-title');
  const gammaTitle = await gamma.textContent('#lists-screen h2.list-title');
  check('direct: a project without an id opens by its index key', gammaTitle === 'Gamma' && (await gamma.title()) === 'Gamma - Claude Takeout', gammaTitle);

  // A one-chat viewer: as today.
  const single = await open('file://' + one);
  await single.waitForSelector('.msg');
  check('one chat: no Projects or Chats entry', !(await single.locator('#projects-nav').isVisible()) && !(await single.locator('#chats-nav').isVisible()));
  const singleLabs = await single.$$eval('#recents .lab', l => l.map(x => x.textContent));
  check('one chat: the sidebar groups as today', singleLabs.join('|') === 'Alpha' && (await single.locator('#recents .item').count()) === 1, singleLabs.join('|'));
  check('one chat: no View all', (await single.locator('.view-all').count()) === 0);
  await single.evaluate(() => { location.hash = '#projects'; });
  await single.waitForTimeout(200);
  check('one chat: #projects routes nowhere new', !(await single.locator('#lists-screen').isVisible()) && (await single.locator('#chat .msg').count()) > 0);

  check('no page error or script run', errors.length === 0, errors.join(' | '));
  check('no network request', requests.length === 0, requests.join(' | '));
  await browser.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failed ? `${failed} failed` : 'all passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
