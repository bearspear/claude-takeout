// Published pages over file:// in Chromium: one card per publish_files call, in place of the "Published on
// claude.ai" line and of the copy claude.ai attached to the message, with one claude.ai link; the card opens the
// page in the side panel; a version that is the file Claude wrote says so; an Export All layout links the
// root published/ folder. No network requests, no page errors.
const { chromium } = require(process.env.PW);
const fs = require('fs'), os = require('os'), path = require('path');
const { buildHtml } = require('./make-viewer.js');
const { VIEWER_CHECK_BASE64, VIEWER_CHECK_FILE } = require('../../takeout-viewer.js');
const core = require('../../export-core.js');

const at = n => `2026-05-01T10:${String(n).padStart(2, '0')}:00Z`;
const PUB = 'mcp__claude-artifacts__publish_files';
const U = '0a1b2c3d-1111-4222-8333-444455556666';
const URL_A = 'https://claude.ai/artifact/ShortA';
const msg = (uuid, parent, sender, n, content, extra = {}) => ({ uuid, parent_message_uuid: parent, sender, created_at: at(n), content, attachments: [], files: [], files_v2: [], ...extra });
const publish = (id, ver) => [
  { type: 'tool_use', id, name: PUB, input: { title: 'Guide', files: [{ as: 'index.html', path: '/home/claude/guide.html' }] } },
  { type: 'tool_result', tool_use_id: id, name: PUB, content: [{ type: 'text', text: JSON.stringify({ slug: U, version: ver, url: URL_A, title: 'Guide' }) }] },
];

const chat = {
  uuid: 'k', name: 'Pages', model: 'claude-x', created_at: at(1), updated_at: at(5), settings: {}, current_leaf_message_uuid: 'a2',
  chat_messages: [
    msg('h1', null, 'human', 1, [{ type: 'text', text: 'make a guide' }]),
    msg('a1', 'h1', 'assistant', 2, [
      { type: 'tool_use', id: 'w', name: 'Write', input: { file_path: '/home/claude/guide.html', content: '<p>G1 as written</p>' } },
      { type: 'tool_result', tool_use_id: 'w', name: 'Write', content: [{ type: 'text', text: 'ok' }] },
      ...publish('p1', 'v1'),
      { type: 'text', text: 'Published it.' },
    ], { files_v2: [{ success: true, file_name: 'guide.html', file_uuid: 'att-1', file_kind: 'blob' }] }),
    msg('h2', 'a1', 'human', 3, [{ type: 'text', text: 'change it' }]),
    msg('a2', 'h2', 'assistant', 4, [...publish('p2', 'v2'), { type: 'text', text: 'Updated.' }]),
  ],
};

const entry = (dir, needsRuntime = false) => ({
  uuid: U, shortId: 'ShortA', title: 'Guide', url: URL_A, current: false, dir,
  versions: [
    { ver: 'v1', folderName: 'v1', label: 'v1', order: 0, start: 'index.html', startSaved: 'index.html', same: true, writtenAs: 'guide.html',
      incomplete: false, needsRuntime: false, text: '<p>G1 as written</p>', publishes: [{ messageUuid: 'a1', toolUseId: 'p1' }] },
    { ver: 'v2', folderName: 'v2', label: 'v2', order: 1, start: 'index.html', startSaved: 'index.html', same: false, writtenAs: null,
      incomplete: false, needsRuntime, text: '<p>v2 page</p>', publishes: [{ messageUuid: 'a2', toolUseId: 'p2' }] },
  ],
});

const ctxOf = (folder, dir, needsRuntime) => c => {
  const artifactIndex = {};
  const artifacts = core.extractArtifacts(c, null, artifactIndex);
  return { folder, artifacts, artifactIndex, uploads: { 'att-1': { path: 'artefacts/guide.html', text: null } }, published: [entry(dir, needsRuntime)] };
};

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'published-'));
  fs.writeFileSync(path.join(dir, VIEWER_CHECK_FILE), Buffer.from(VIEWER_CHECK_BASE64, 'base64'));
  fs.mkdirSync(path.join(dir, 'published', 'Guide_ShortA', 'v2'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'published', 'Guide_ShortA', 'v2', 'index.html'), '<p>v2 page</p>');
  const single = path.join(dir, 'viewer.html');
  fs.writeFileSync(single, buildHtml([chat], '2026-11-16T12:00:00Z', ctxOf('', 'published/Guide_ShortA', false)));
  const mega = path.join(dir, 'mega.html');
  fs.writeFileSync(mega, buildHtml([chat], '2026-11-16T12:00:00Z', ctxOf('chatA', '../published/Guide_ShortA', true)));

  const browser = await chromium.launch({ executablePath: process.env.CHROME_EXE });
  let failed = 0;
  const check = (n, ok, x = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n} ${ok ? '' : x}`); };
  const page = await (await browser.newContext({ viewport: { width: 1300, height: 900 } })).newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const requests = [];
  await page.route('**/*', r => { const u = r.request().url(); if (u.startsWith('file:')) return r.continue(); requests.push(u); return r.abort(); });

  await page.goto('file://' + single + '#chat=k');
  await page.waitForSelector('.msg');
  const first = page.locator('.msg.assistant').nth(0);
  const second = page.locator('.msg.assistant').nth(1);
  const pageCards = m => m.locator('.art', { hasText: 'Published page' });
  check('one card per publish', await pageCards(first).count() === 1 && await pageCards(second).count() === 1 && await second.locator('.art').count() === 1);
  const shown = (await page.locator('.msg').allTextContents()).join('\n');
  check('no "Published on claude.ai" line', !shown.includes('Published on claude.ai') && await page.locator('.msg .published').count() === 0);
  check('no duplicate chip on that message', await first.locator('.chips').count() === 0);
  await page.locator('#files-button').click();
  const rows = await page.locator('#files-menu .files-row b').allTextContents();
  const labels = await page.locator('#files-menu .files-lab').allTextContents();
  await page.keyboard.press('Escape');
  check('the Files list has the page once, and not its attached copy as an upload', rows.filter(r => r === 'Guide').length === 1 && !labels.includes('Uploads'), `${rows} / ${labels}`);
  for (const [n, m] of [['first', first], ['second', second]]) {
    const links = await m.locator('a[href*="claude.ai/artifact"]').evaluateAll(a => a.map(x => x.getAttribute('href')));
    check(`exactly one claude.ai link in the ${n} message`, links.length === 1 && links[0] === URL_A, links.join());
  }
  const card1 = (await pageCards(first).locator('small').textContent());
  check('the card says Published page and Same as published', card1.includes('Published page') && card1.includes('Same as published'), card1);
  const card2 = (await second.locator('.art small').textContent());
  check('a stored version is not same', card2.includes('Published page') && !card2.includes('Same as published'), card2);
  await second.locator('.art').click();
  await page.waitForSelector('#panel:not([hidden]) iframe.preview');
  const srcdoc = await page.locator('#panel iframe.preview').getAttribute('srcdoc');
  check('opening the card shows the page in the side panel', srcdoc.includes('v2 page'), srcdoc.slice(0, 200));
  check('the panel shows both versions', await page.locator('#panel-head .ver').count() === 2);
  await page.locator('#panel-head .ver', { hasText: 'v1' }).click();
  await page.waitForFunction(() => (document.querySelector('#panel iframe.preview') || {}).srcdoc?.includes('G1 as written'));
  check('the same version notes it in the panel', (await page.locator('#panel-body').textContent()).includes('Same as published'));

  await page.goto('file://' + mega + '#chat=k');
  await page.waitForSelector('.msg');
  const megaCard = page.locator('.msg.assistant').nth(1).locator('.art');
  check('mega layout: the card says it needs claude.ai to run', (await megaCard.locator('small').textContent()).includes('Needs claude.ai to run'));
  await megaCard.click();
  await page.waitForSelector('#panel:not([hidden]) iframe.preview');
  check('mega layout: the card opens', (await page.locator('#panel iframe.preview').getAttribute('srcdoc')).includes('v2 page'));
  const megaData = JSON.parse(/<script id="data" type="application\/json">([\s\S]*?)<\/script>/.exec(fs.readFileSync(mega, 'utf8'))[1]);
  const href = Object.values(megaData.chats[0].files).find(f => f.published).versions[1].href;
  check('mega layout: the version links published/ at the root', href === 'published/Guide_ShortA/v2/index.html', href);
  check('no network requests', requests.length === 0, requests.join());
  check('no page errors', errors.length === 0, errors.join(' | '));

  await browser.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e.message); process.exit(1); });
