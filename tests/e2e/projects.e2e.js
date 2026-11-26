// The Projects and Chats entries over file:// in Chromium: 30 Recents, View all, the lists screen and its routes
// (#projects, #project=<key>, #chats), titles kept and put back, and a one-chat viewer left as it was. Then the pages:
// the Projects grid, a project page, All chats, Open project from a chat, a phone and dark mode.
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
const INSTRUCTIONS = Array.from({ length: 12 }, (_, i) => `Rule ${i + 1}: be brief.`).join('\n');
const ALPHA = { id: 'p-a', name: 'Alpha', description: 'The alpha project', instructions: INSTRUCTIONS, fileDir: 'project/files', fileNames: ['spec.pdf'], docs: [{ name: 'notes.md', text: 'Alpha notes' }] };
// Beta's instructions: 6 lines of 45 characters, more than 8 by the 40-a-line estimate but short enough to show whole on a phone.
const BETA_INSTRUCTIONS = Array.from({ length: 6 }, (_, i) => `Line ${i + 1}: ` + 'x'.repeat(37)).join('\n');
const BETA = { id: 'p-b', name: 'Beta <img src=x onerror="console.log(\'NAME RAN\')">', instructions: BETA_INSTRUCTIONS, fileDir: 'project/files', fileNames: [], docs: [] };
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
  check('one chat: no Open project link', (await single.locator('#project a.open-project').count()) === 0 && await single.locator('#project').isVisible());
  await single.evaluate(() => { location.hash = '#projects'; });
  await single.waitForTimeout(200);
  check('one chat: #projects routes nowhere new', !(await single.locator('#lists-screen').isVisible()) && (await single.locator('#chat .msg').count()) > 0);


  // ---- The pages ----
  const pages = await open('file://' + file + '#projects');
  await pages.waitForSelector('#lists-screen h2.list-title');
  const ptxt = async sel => ((await pages.locator(sel).count()) ? pages.textContent(sel) : null);
  const cards = () => pages.$$eval('#lists-screen a.project-card', l => l.map(a => ({
    name: (a.querySelector('.name') || {}).textContent, desc: a.querySelector('.desc') ? a.querySelector('.desc').textContent : null,
    meta: (a.querySelector('.meta') || {}).textContent, href: a.getAttribute('href') })));
  let list = await cards();
  check('projects page: three cards, newest activity first', list.map(c => c.name).join('|') === `Gamma|${BETA.name}|Alpha`, list.map(c => c.name).join('|'));
  const alpha = list.find(c => c.name === 'Alpha') || {};
  check('projects page: a card has its description', alpha.desc === 'The alpha project', alpha.desc);
  check('projects page: no description, no .desc', list.length === 3 && list[1].desc === null);
  check('projects page: chats and updated', /^10 chats · Updated \S+/.test(alpha.meta || ''), alpha.meta);
  const clamp = await pages.$eval('#lists-screen a.project-card .desc', d => getComputedStyle(d).webkitLineClamp);
  check('projects page: the description is cut at two lines', clamp === '2', clamp);
  check('projects page: an HTML name is text', (await pages.locator('#lists-screen img').count()) === 0);
  const pFilter = pages.locator('#lists-screen input.list-filter');
  check('projects page: a filter box', (await pFilter.getAttribute('aria-label')) === 'Filter projects');
  await pFilter.fill('alp');
  list = await cards();
  check('projects page: filter "alp" leaves Alpha', list.map(c => c.name).join('|') === 'Alpha', list.map(c => c.name).join('|'));
  await pFilter.fill('');
  check('projects page: an empty filter shows all', (await cards()).length === 3);
  // '/' on a page with a filter box puts the cursor there.
  await pages.locator('#lists-screen h2.list-title').focus();
  await pages.keyboard.press('/');
  check("projects page: '/' focuses the filter box", await pages.evaluate(() => document.activeElement.matches('#lists-screen input.list-filter')));
  await pages.click('#lists-screen a.project-card:has-text("Alpha")');
  await pages.waitForFunction(() => location.hash === '#project=p-a');
  await pages.waitForFunction(() => document.title === 'Alpha - Claude Takeout');
  check('projects page: a card opens its project', true);

  // The project page (Alpha)
  const back = pages.locator('#lists-screen a.back');
  check('project page: a back link to All projects', (await back.textContent()).trim() === 'All projects' && (await back.getAttribute('href')) === '#projects');
  check('project page: its name', (await pages.textContent('#lists-screen h2.list-title')) === 'Alpha');
  check('project page: its description', (await ptxt('#lists-screen .project-desc')) === 'The alpha project');
  const rows = await pages.$$eval('#lists-screen a.chat-row', l => l.map(a => ({ title: a.textContent, href: a.getAttribute('href'), line: a.closest('.chat-line').textContent })));
  const alphaWant = Array.from({ length: 10 }, (_, i) => `Chat ${9 - i}`);
  check('project page: its chats, newest first', rows.map(r => r.title).join() === alphaWant.join(), rows.map(r => r.title).join());
  check('project page: a row says when it was updated', rows.length && rows.every(r => /Updated \S+/.test(r.line)), rows[0] && rows[0].line);
  check('project page: a row links its chat', rows[0] && rows[0].href === '#chat=c009', rows[0] && rows[0].href);
  check('project page: 10 chats, no filter box', (await pages.locator('#lists-screen input.list-filter').count()) === 0);
  check('project page: no row is an .item', (await pages.locator('#lists-screen .item').count()) === 0);
  const instr = pages.locator('#lists-screen .project-instructions');
  check('project page: the instructions', (await instr.textContent()).includes('Rule 12: be brief.'));
  const more = pages.locator('#lists-screen .project-panel button.more-toggle');
  check('project page: long instructions have Show more', (await more.count()) === 1 && (await more.textContent()) === 'Show more');
  const tall = async () => pages.$eval('#lists-screen .project-instructions', d => d.clientHeight < d.scrollHeight);
  check('project page: the instructions start cut', await tall());
  await more.click();
  check('project page: Show more shows them all', !(await tall()) && (await more.textContent()) === 'Show less');
  const chips = await pages.$$eval('#lists-screen .project-panel .chip', l => l.map(c => c.textContent));
  check('project page: knowledge chips = docs + files', chips.length === 2, chips.join('|'));
  await pages.click('#lists-screen .project-panel .chip:has-text("notes.md")');
  await pages.waitForSelector('.veil .pop');
  const fromPage = await pages.textContent('.veil .pop');
  check('project page: a doc chip opens its popup', fromPage.includes('Alpha notes'), fromPage);
  await pages.keyboard.press('Escape');
  await pages.waitForSelector('.veil', { state: 'detached' });

  // From a chat: Open project, and the fold bar's chip opens the same popup.
  await pages.click('#lists-screen a.chat-row >> nth=0');
  await pages.waitForFunction(() => location.hash.includes('chat=c009'));
  await pages.waitForSelector('#chat .msg');
  const openProject = pages.locator('#project a.open-project');
  check('a chat: Open project in the fold bar', (await openProject.count()) === 1 && (await openProject.textContent()) === 'Open project' && (await openProject.getAttribute('href')) === '#project=p-a');
  await pages.click('#project details.project-files summary');
  await pages.click('#project .chip:has-text("notes.md")');
  await pages.waitForSelector('.veil .pop');
  check('a chat: the fold bar chip opens the same popup', (await pages.textContent('.veil .pop')) === fromPage);
  await pages.keyboard.press('Escape');
  await pages.waitForSelector('.veil', { state: 'detached' });
  await openProject.click();
  await pages.waitForFunction(() => location.hash === '#project=p-a');
  check('a chat: Open project opens the project page', (await pages.textContent('#lists-screen h2.list-title')) === 'Alpha');
  await pages.click('#lists-screen a.back');
  await pages.waitForFunction(() => location.hash === '#projects');
  check('project page: back to the Projects page', (await pages.locator('#lists-screen a.project-card').count()) === 3);

  // Gamma: no id, reached from its card.
  await pages.click('#lists-screen a.project-card:has-text("Gamma")');
  await pages.waitForFunction(() => /^#project=i\d+$/.test(location.hash));
  await pages.waitForFunction(() => document.title === 'Gamma - Claude Takeout');
  const gRows = await pages.locator('#lists-screen a.chat-row').count();
  check('project page: Gamma (no id) renders from its card', gRows === 3 && (await ptxt('#lists-screen .project-panel')).includes('No instructions'), String(gRows));

  // All chats
  await pages.evaluate(() => { location.hash = '#chats'; });
  await pages.waitForFunction(() => document.title === 'Chats - Claude Takeout');
  check('all chats: the count', (await ptxt('#lists-screen .list-count')) === '230 chats', await ptxt('#lists-screen .list-count'));
  check('all chats: 200 rows first', (await pages.locator('#lists-screen a.chat-row').count()) === 200);
  const firstRows = await pages.$$eval('#lists-screen a.chat-row', l => l.slice(0, 3).map(a => a.textContent));
  check('all chats: newest first', firstRows.join() === 'Chat 228,Chat 227,Chat 226', firstRows.join());
  check('all chats: no row is an .item', (await pages.locator('#lists-screen .item').count()) === 0);
  const showMore = pages.locator('#lists-screen button.show-more');
  check('all chats: Show more', (await showMore.count()) === 1);
  await showMore.click();
  check('all chats: Show more shows the rest', (await pages.locator('#lists-screen a.chat-row').count()) === 230 && (await showMore.count()) === 0);
  const last = await pages.$eval('#lists-screen .chat-line:last-child', l => ({ title: l.querySelector('a.chat-row').textContent, text: l.textContent }));
  check('all chats: the undated chat is last, with no Updated', last.title === 'Chat 229' && !last.text.includes('Updated'), JSON.stringify(last));
  const projLink = pages.locator('#lists-screen .chat-line:has(a.chat-row:text-is("Chat 5")) a.chat-project');
  check('all chats: a row names its project', (await projLink.textContent()) === 'Alpha' && (await projLink.getAttribute('href')) === '#project=p-a');
  check('all chats: a row without a project has no project link', (await pages.locator('#lists-screen .chat-line:has(a.chat-row:text-is("Chat 100")) a.chat-project').count()) === 0);
  await pages.evaluate(() => { location.hash = '#projects'; });
  await pages.waitForFunction(() => document.title === 'Projects - Claude Takeout');
  await pages.evaluate(() => { location.hash = '#chats'; });
  await pages.waitForFunction(() => document.title === 'Chats - Claude Takeout');
  check('all chats: 200 rows again on a new visit', (await pages.locator('#lists-screen a.chat-row').count()) === 200);
  const cFilter = pages.locator('#lists-screen input.list-filter');
  check('all chats: a filter box', (await cFilter.getAttribute('aria-label')) === 'Filter chats');
  await cFilter.fill('Chat 215');
  const found = await pages.$$eval('#lists-screen a.chat-row', l => l.map(a => a.textContent));
  check('all chats: the filter searches every chat', found.join() === 'Chat 215', found.join());
  await cFilter.fill('');
  check('all chats: an empty filter shows 200 again', (await pages.locator('#lists-screen a.chat-row').count()) === 200);
  await pages.click('#lists-screen button.show-more');
  check('all chats: Show more after clearing the filter shows all 230', (await pages.locator('#lists-screen a.chat-row').count()) === 230);
  await cFilter.fill('Chat 12');
  await pages.locator('#lists-screen .chat-line:has(a.chat-row:text-is("Chat 12")) a.chat-project').click();
  await pages.waitForFunction(() => location.hash === '#project=p-b');
  check('all chats: the project link opens the project', (await pages.textContent('#lists-screen h2.list-title')) === BETA.name);
  // Back to a list page finds it as it was left: the filter, the rows shown and the scroll.
  await pages.goBack();
  await pages.waitForFunction(() => document.title === 'Chats - Claude Takeout');
  const backRows = await pages.$$eval('#lists-screen a.chat-row', l => l.map(a => a.textContent));
  check('back: the filter is kept', (await cFilter.inputValue()) === 'Chat 12' && backRows.length === 13 && backRows.includes('Chat 12') && backRows.includes('Chat 212'), `${await cFilter.inputValue()} ${backRows.length}`);
  await cFilter.fill('');
  await pages.click('#lists-screen button.show-more');
  await pages.evaluate(() => { document.getElementById('lists-screen').scrollTop = 3000; });
  await pages.waitForTimeout(250);
  const leftAt = await pages.evaluate(() => document.getElementById('lists-screen').scrollTop);
  await pages.locator('#lists-screen a.chat-row:text-is("Chat 40")').click();
  await pages.waitForFunction(() => location.hash.includes('chat=c040'));
  await pages.goBack();
  await pages.waitForFunction(() => document.title === 'Chats - Claude Takeout');
  await pages.waitForTimeout(100);
  const backAt = await pages.evaluate(() => document.getElementById('lists-screen').scrollTop);
  check('back: Show more and the scroll are kept', (await pages.locator('#lists-screen a.chat-row').count()) === 230 && leftAt > 1000 && Math.abs(backAt - leftAt) < 2, `${await pages.locator('#lists-screen a.chat-row').count()} ${leftAt} -> ${backAt}`);
  await pages.click('#chats-nav');
  await pages.waitForTimeout(100);
  check('the Chats entry starts the page afresh', (await pages.locator('#lists-screen a.chat-row').count()) === 200 && (await cFilter.inputValue()) === '' && await pages.evaluate(() => document.getElementById('lists-screen').scrollTop) === 0);

  // Two projects of one name, and instructions that wrap more than the line estimate.
  {
    const SAME_A = { id: 's1', name: 'Same', fileDir: 'project/files', fileNames: [], docs: [] };
    const SAME_B = { id: 's2', name: 'Same', fileDir: 'project/files', fileNames: [], docs: [] };
    const CJK = { id: 'cjk', name: 'Wide', instructions: Array.from({ length: 6 }, () => '漢'.repeat(40)).join('\n'), fileDir: 'project/files', fileNames: [], docs: [] };
    const few = [chat(0), chat(1), chat(2), chat(3)];
    const dup = path.join(dir, 'dup.html');
    fs.writeFileSync(dup, buildHtml(few, '2026-11-25T12:00:00Z', c => [{ project: SAME_A }, { project: SAME_B }, { project: CJK }, {}][Number(c.uuid.slice(1))]));
    const dp = await open('file://' + dup);
    const seen = [];
    for (const [id, n] of [['c000', 0], ['c001', 1]]) {
      await dp.evaluate(h => { location.hash = h; }, `#chat=${id}`);
      await dp.waitForFunction(t => document.title === t, `Chat ${n} - Claude Takeout`);
      await dp.waitForSelector('#project a.open-project');
      const line = await dp.textContent('#project .project-line').catch(() => null);
      await dp.click('#project a.open-project');
      await dp.waitForFunction(() => location.hash.startsWith('#project='));
      seen.push([line, await dp.textContent('#lists-screen h2.list-title')]);
    }
    check('fold bar: names the project as its page does', seen.every(([l, h]) => l === `Project · ${h}`) && seen.map(x => x[1]).sort().join() === 'Same,Same (2)', JSON.stringify(seen));
    await dp.evaluate(() => { location.hash = '#project=cjk'; });
    await dp.waitForFunction(() => document.title === 'Wide - Claude Takeout');
    await dp.waitForTimeout(100);
    const cut = await dp.evaluate(() => {
      const t = document.querySelector('#lists-screen .project-instructions');
      return { collapsed: t.classList.contains('collapsed'), toggle: !!document.querySelector('#lists-screen .more-toggle') };
    });
    check('project page: instructions that wrap past the estimate collapse', cut.collapsed && cut.toggle, JSON.stringify(cut));
    await dp.close();
  }

  // A phone: the drawer closes on Projects and the cards are one column.
  const phone = await browser.newContext({ viewport: { width: 420, height: 800 } });
  const ph = await phone.newPage();
  ph.on('pageerror', e => errors.push(e.message));
  await ph.route('**/*', r => { const u = r.request().url(); if (u.startsWith('file:')) r.continue(); else { requests.push(u); r.abort(); } });
  await ph.goto('file://' + file);
  await ph.waitForSelector('.msg');
  await ph.click('#menu');
  await ph.waitForFunction(() => document.body.classList.contains('drawer'));
  await ph.click('#projects-nav');
  await ph.waitForFunction(() => location.hash === '#projects');
  check('phone: Projects closes the drawer', !(await ph.evaluate(() => document.body.classList.contains('drawer'))));
  const lefts = await ph.$$eval('#lists-screen a.project-card', l => l.map(a => Math.round(a.getBoundingClientRect().left)));
  check('phone: the cards are one column', lefts.length === 3 && new Set(lefts).size === 1, lefts.join());
  const sw = await ph.evaluate(() => document.getElementById('lists-screen').scrollWidth <= document.getElementById('lists-screen').clientWidth);
  check('phone: no sideways scroll', sw);
  await ph.click('#lists-screen a.project-card:has-text("Alpha")');
  await ph.waitForFunction(() => location.hash === '#project=p-a');
  const order = await ph.evaluate(() => {
    const panel = document.querySelector('#lists-screen .project-panel').getBoundingClientRect();
    const chats = document.querySelector('#lists-screen .project-chats').getBoundingClientRect();
    return panel.top < chats.top;
  });
  check('phone: the panel comes before the chats', order);
  await ph.goto('file://' + file + '#project=p-b');
  await ph.waitForSelector('#lists-screen .project-instructions');
  await ph.waitForTimeout(100);
  const shortOk = await ph.evaluate(() => {
    const t = document.querySelector('#lists-screen .project-instructions');
    return !t.classList.contains('collapsed') && !document.querySelector('#lists-screen .more-toggle') && t.scrollHeight <= t.clientHeight + 1;
  });
  check('phone: instructions that fit get no Show more', shortOk);
  await phone.close();

  // Dark mode: the cards' text is readable.
  const dark = await browser.newContext({ viewport: { width: 1300, height: 900 }, colorScheme: 'dark' });
  const dk = await dark.newPage();
  dk.on('pageerror', e => errors.push(e.message));
  await dk.route('**/*', r => { const u = r.request().url(); if (u.startsWith('file:')) r.continue(); else { requests.push(u); r.abort(); } });
  await dk.goto('file://' + file + '#projects');
  await dk.waitForSelector('#lists-screen a.project-card');
  const colors = await dk.$eval('#lists-screen a.project-card', a => ({ fg: getComputedStyle(a.querySelector('.name')).color, bg: getComputedStyle(a).backgroundColor, page: getComputedStyle(document.body).backgroundColor }));
  check('dark: the card text differs from its background', colors.fg !== colors.bg && colors.bg !== 'rgba(0, 0, 0, 0)' && colors.page === 'rgb(38, 38, 36)', JSON.stringify(colors));
  await dark.close();

  check('no page error or script run', errors.length === 0, errors.join(' | '));
  check('no network request', requests.length === 0, requests.join(' | '));
  await browser.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failed ? `${failed} failed` : 'all passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
