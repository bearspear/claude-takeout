// An Export Artifacts folder's index.html over file:// in Chromium: one row per artifact, sorted by title; a title
// links the artifact's start file; a Docs row has its note and no local link; a shared artifact is labelled and its
// HTML has no local link;
// claude.ai links are rebuilt from the short id. No network requests, no page errors.
const { chromium } = require(process.env.PW);
const fs = require('fs'), os = require('os'), path = require('path');
const { runArtifacts } = require('../helpers');
const { uuidToBase58 } = require('../../export-core.js');

const DOCS_TYPE = 'c8f0b311-af6a-4d22-a07b-61eb818fc35d';
const LIVE = '1794783850-4a6e';
const U = n => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const art = (slug, title, extra = {}) => ({ slug, title, typeSlug: '', typeTitle: '', sourceSurface: 'chat', rel: 'mine', live: LIVE, updatedAt: '2026-11-01T00:00:00Z', createdAt: '2026-10-01T00:00:00Z', ...extra });
const live = (title, files) => ({ title, live: LIVE, versions: { [LIVE]: { files } } });

(async () => {
  const frames = [
    art(U(1), 'zebra game', { sourceSurface: 'code' }),
    art(U(2), 'Alpha <report> & "co"'),
    art(U(3), 'Plan notes', { typeSlug: DOCS_TYPE, typeTitle: 'Docs' }),
    art(U(4), 'Shared deck', { rel: 'shared' }),
  ];
  const pages = {
    [U(1)]: live('zebra game', { 'index.html': '<h1>Zebra page</h1><script src="app.js"></script>', 'app.js': 'void 0' }),
    [U(2)]: live('Alpha', { 'index.html': '<h1>Alpha page</h1>' }),
    [U(4)]: live('Shared deck', { 'deck.html': '<h1>Shared page</h1>' }),
  };
  const { files } = await runArtifacts({ frames, pages });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifacts-'));
  for (const [n, text] of Object.entries(files)) {
    const p = path.join(dir, n);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  }

  const browser = await chromium.launch({ executablePath: process.env.CHROME_EXE });
  let failed = 0;
  const check = (n, ok, x = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n} ${ok ? '' : x}`); };
  const page = await (await browser.newContext({ viewport: { width: 1300, height: 900 } })).newPage();
  const errors = [], requests = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', r => { const u = r.request().url(); if (u.startsWith('file:')) return r.continue(); requests.push(u); return r.abort(); });

  await page.goto('file://' + path.join(dir, 'index.html'));
  const rows = page.locator('tbody tr');
  check('four rows', await rows.count() === 4, await rows.count());
  const titles = await rows.evaluateAll(trs => trs.map(tr => tr.cells[0].firstChild.textContent.trim()));
  check('sorted by title, case-insensitive', JSON.stringify(titles) === JSON.stringify(['Alpha <report> & "co"', 'Plan notes', 'Shared deck', 'zebra game']), JSON.stringify(titles));
  check('meta shows the listed count', (await page.locator('.meta').textContent()).includes('Listed by claude.ai: 4'));

  const zebra = rows.nth(3);
  check('claude.ai link rebuilt from the short id', await zebra.locator('a.remote').getAttribute('href') === `https://claude.ai/artifact/${uuidToBase58(U(1))}`
    && (await zebra.locator('a.remote').getAttribute('rel')) === 'noopener noreferrer');
  await zebra.locator('a').first().click();
  await page.waitForLoadState();
  check('title link opens the artifact page file', page.url().endsWith('/index.html') && page.url().includes(uuidToBase58(U(1))) && (await page.locator('h1').textContent()) === 'Zebra page', page.url());
  await page.goBack();
  await page.waitForSelector('tbody tr');

  const docs = page.locator('tbody tr').nth(1);
  check('Docs row has its note and no local link', (await docs.textContent()).includes("Claude Docs text isn't available as a file")
    && await docs.locator('a:not(.remote)').count() === 0 && await docs.locator('a.remote').count() === 1);
  const shared = page.locator('tbody tr').nth(2);
  check('shared row is labelled', (await shared.textContent()).includes('shared with you'));
  check('shared row has no local link to its HTML, only claude.ai', await shared.locator('a:not(.remote)').count() === 0 && await shared.locator('a.remote').count() === 1);
  check('hostile title is text, not markup', await page.locator('tbody tr').nth(0).locator('a').first().textContent() === 'Alpha <report> & "co"');

  check('no network requests', requests.length === 0, requests.join(' '));
  check('no page errors', errors.length === 0, errors.join(' '));
  await browser.close();
  process.exit(failed ? 1 : 0);
})();
