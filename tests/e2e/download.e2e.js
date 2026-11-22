// Download over file:// in Chromium (v1.19). The chat viewer: an upload's popup has Download, and a large upload's
// only once its part has loaded; a generated .html, .svg and .md in the panel download under their own names, with
// their bytes, through a blob: link: nothing navigates, no frame loads the file, nothing runs, no request leaves.
// The Export Artifacts viewer: an artifact's page has Download for its start file (an HTML page, and an image from its
// preview data), a row per held file in the details page's list, and Download ZIP for a multi-file current version,
// which downloads the ZIP the export wrote; a one-file artifact has no ZIP link.
// Run: PW=<playwright-core> CHROME_EXE=<chrome> node tests/e2e/download.e2e.js
const { chromium } = require(process.env.PW);
const fs = require('fs'), os = require('os'), path = require('path');
const { buildFiles } = require('./make-viewer.js');
const { VIEWER_CHECK_BASE64, VIEWER_CHECK_FILE } = require('../../takeout-viewer.js');
const { runArtifacts } = require('../helpers');
const { uuidToBase58 } = require('../../export-core.js');

const PAGE = '<!doctype html><h1>Downloaded page</h1><script>console.log("RAN PAGE")</script>';
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="5"/><script>console.log("RAN SVG")</script></svg>';
const MD = '# Notes\n\nSome **bold** text.';
const BIG_MD = '# Big\n' + 'wombat words here\n'.repeat(5000);
const SMALL = 'small upload text';

function conversation() {
  const human = {
    uuid: 'h', parent_message_uuid: null, sender: 'human', created_at: '2026-05-01T10:00:00Z', content: [{ type: 'text', text: 'make files' }], attachments: [], files: [],
    files_v2: [{ file_uuid: 'f-md', file_name: 'big.md', success: true }, { file_uuid: 'f-small', file_name: 'small.txt', success: true }],
  };
  const make = (id, p, t) => ({ type: 'tool_use', id, name: 'create_file', input: { path: p, file_text: t } });
  const reply = { uuid: 'a', parent_message_uuid: 'h', sender: 'assistant', created_at: '2026-05-01T10:01:00Z', attachments: [], files: [], files_v2: [],
    content: [{ type: 'text', text: 'Made them.' }, make('c1', '/mnt/user-data/outputs/page.html', PAGE), make('c2', '/mnt/user-data/outputs/chart.svg', SVG), make('c3', '/mnt/user-data/outputs/notes.md', MD)] };
  return { uuid: 'dl', name: 'Downloads', model: 'claude-x', created_at: '2026-05-01T10:00:00Z', updated_at: '2026-05-01T10:01:00Z', settings: {}, current_leaf_message_uuid: 'a', chat_messages: [human, reply] };
}
const entry = (name) => ({ path: `/mnt/user-data/outputs/${name}`, filename: name, versions: [name], messages: ['a'] });
const ctx = () => ({
  folder: '', artifacts: { 'page.html': PAGE, 'chart.svg': SVG, 'notes.md': MD },
  artifactIndex: Object.fromEntries(['page.html', 'chart.svg', 'notes.md'].map(n => [`/mnt/user-data/outputs/${n}`, entry(n)])),
  uploads: { 'f-md': { path: 'uploads/p01_big.md', text: BIG_MD }, 'f-small': { path: 'uploads/p01_small.txt', text: SMALL } },
});

const LIVE = '1794783850-4a6e';
const U = n => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const art = (slug, title) => ({ slug, title, typeSlug: '', typeTitle: '', sourceSurface: 'chat', rel: 'mine', live: LIVE, updatedAt: '2026-11-01T00:00:00Z', createdAt: '2026-10-01T00:00:00Z' });
const live = (title, files) => ({ title, live: LIVE, versions: { [LIVE]: { files } } });
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const GAME = '<!doctype html><link rel="stylesheet" href="app.css"><h1>Game</h1><script>console.log("RAN GAME")</script>';

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_EXE });
  let failed = 0;
  const check = (n, ok, x = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n} ${ok ? '' : x}`); };

  const open = async (dir, hash = '') => {
    const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1300, height: 900 } });
    const page = await context.newPage();
    const seen = { errors: [], requests: [], logs: [], frames: [], popups: 0 };
    page.on('pageerror', e => seen.errors.push(e.message));
    page.on('console', m => seen.logs.push(m.text()));
    page.on('framenavigated', f => { if (f !== page.mainFrame()) seen.frames.push(f.url()); });
    context.on('page', () => { seen.popups++; });
    await context.route('**/*', r => { const u = r.request().url(); if (u.startsWith('file:') || u.startsWith('data:') || u.startsWith('blob:')) return r.continue(); seen.requests.push(u); return r.abort(); });
    await page.goto('file://' + path.join(dir, 'viewer.html') + hash);
    return { context, page, seen };
  };
  // Clicks and waits for one download: { name, bytes, url (the page's, after) }.
  const download = async (page, locator) => {
    const before = page.url();
    const [d] = await Promise.all([page.waitForEvent('download', { timeout: 4000 }), locator.click()]);
    const bytes = fs.readFileSync(await d.path());
    return { name: d.suggestedFilename(), bytes, stayed: page.url() === before };
  };

  // ---- The chat viewer ----
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'download-'));
  const { html, parts } = buildFiles([conversation()], '2026-11-07T12:00:00Z', ctx);
  fs.writeFileSync(path.join(dir, 'viewer.html'), html);
  fs.writeFileSync(path.join(dir, VIEWER_CHECK_FILE), Buffer.from(VIEWER_CHECK_BASE64, 'base64'));
  fs.mkdirSync(path.join(dir, 'viewer-files'));
  for (const p of parts) fs.writeFileSync(path.join(dir, 'viewer-files', p.name), p.body);
  const chatView = await open(dir);
  const { page } = chatView;
  await page.waitForSelector('.msg');

  await page.locator('button.chip', { hasText: 'small.txt' }).click();
  await page.waitForSelector('.pop');
  let got = await download(page, page.locator('.pop .pop-head button.download'));
  check('an upload downloads from its popup', got.name === 'small.txt' && got.bytes.toString('utf8') === SMALL && got.stayed, JSON.stringify([got.name, got.stayed]));
  await page.locator('.pop .close').click();

  // The large upload: its popup has no Download until the part's text is in.
  await page.route('**/viewer-files/**', async r => { await new Promise(res => setTimeout(res, 400)); return r.continue(); });
  await page.locator('button.chip', { hasText: 'big.md' }).click();
  await page.waitForSelector('.pop');
  check('a large upload has no Download before its part loads', (await page.locator('.pop .pop-head button.download').count()) === 0);
  await page.waitForSelector('.pop .pop-head button.download', { timeout: 4000 });
  got = await download(page, page.locator('.pop .pop-head button.download'));
  check('and downloads its whole text after', got.name === 'big.md' && got.bytes.toString('utf8') === BIG_MD, `${got.name} ${got.bytes.length}`);
  await page.locator('.pop .close').click();
  await page.unroute('**/viewer-files/**');

  for (const [name, body] of [['page.html', PAGE], ['chart.svg', SVG], ['notes.md', MD]]) {
    await page.locator('.msg[data-id="a"] .art', { hasText: name }).first().click();
    await page.waitForSelector('#panel:not([hidden]) #panel-head button.download');
    const framesBefore = chatView.seen.frames.length;
    got = await download(page, page.locator('#panel-head button.download'));
    await page.waitForTimeout(200);
    const newFrames = chatView.seen.frames.slice(framesBefore);
    check(`${name} downloads from the panel with its bytes`, got.name === name && got.bytes.toString('utf8') === body && got.stayed, JSON.stringify([got.name, got.stayed]));
    check(`${name}: no frame loads a file or blob`, newFrames.every(u => !/^(file|blob|https?):/i.test(u)), newFrames.join());
    await page.locator('#panel .close').click();
  }
  // (The panel's own sandboxed preview runs the page, as before; a download adds no frame, page or request.)
  check('chat viewer: no request, no error, no new page',
    chatView.seen.requests.length === 0 && chatView.seen.errors.length === 0 && chatView.seen.popups === 0,
    JSON.stringify(chatView.seen));
  await chatView.context.close();

  // ---- The Export Artifacts viewer ----
  const frames = [art(U(1), 'Game'), art(U(2), 'Picture'), art(U(3), 'Single'), art(U(4), 'Data')];
  const pages = {
    [U(1)]: live('Game', { 'index.html': GAME, 'app.css': 'h1 { color: red; }' }),
    [U(2)]: live('Picture', { 'pic.png': { body: PNG, type: 'image/png' } }),
    [U(3)]: live('Single', { 'index.html': '<h1>one</h1>' }),
    [U(4)]: live('Data', { 'data.bin': { body: 'BINARY', type: 'application/octet-stream' }, 'style.css': { body: 'p { color: red; }', type: 'text/css' } }),
  };
  const { raw } = await runArtifacts({ frames, pages });
  const adir = fs.mkdtempSync(path.join(os.tmpdir(), 'download-art-'));
  for (const [n, bytes] of Object.entries(raw)) { const fp = path.join(adir, n); fs.mkdirSync(path.dirname(fp), { recursive: true }); fs.writeFileSync(fp, bytes); }
  const folder = n => fs.readdirSync(adir).find(x => x.endsWith(`_${uuidToBase58(U(n))}`));

  const av = await open(adir, `#a=${uuidToBase58(U(1))}`);
  const ap = av.page;
  await ap.waitForSelector('#page-links button.download', { timeout: 4000 });
  got = await download(ap, ap.locator('#page-links button.download'));
  check('an artifact page downloads its start file', got.name === 'index.html' && got.bytes.toString('utf8') === GAME && got.stayed, JSON.stringify([got.name, got.stayed]));
  const zipLink = ap.locator('#page-links a.download-zip');
  check('a two-file artifact has Download ZIP', (await zipLink.count()) === 1 && (await zipLink.textContent()) === 'Download ZIP');
  got = await download(ap, zipLink);
  const zipFile = fs.readFileSync(path.join(adir, folder(1), `${LIVE}.zip`));
  check('Download ZIP saves the ZIP the export wrote', got.name === `${LIVE}.zip` && got.bytes.equals(zipFile) && got.stayed, got.name);
  // A ZIP gone from disk: the viewer stays where it was (the link opens in a tab of its own).
  fs.renameSync(path.join(adir, folder(1), `${LIVE}.zip`), path.join(adir, 'moved.zip'));
  const hereBefore = ap.url();
  await zipLink.click();
  await ap.waitForTimeout(500);
  check('a missing ZIP leaves the viewer in place', ap.url() === hereBefore && (await ap.locator('#page-links a.download-zip').count()) === 1, ap.url());
  for (const p of av.context.pages()) if (p !== ap) await p.close();
  av.seen.popups = 0;

  await ap.evaluate(id => { location.hash = `#a=${id}`; }, uuidToBase58(U(2)));
  await ap.waitForSelector('#page-links button.download', { timeout: 4000 });
  got = await download(ap, ap.locator('#page-links button.download'));
  check('an image artifact downloads the image bytes from its preview data', got.name === 'pic.png' && got.bytes.equals(PNG), got.name);

  await ap.evaluate(id => { location.hash = `#a=${id}`; }, uuidToBase58(U(3)));
  await ap.waitForSelector('#page-links button.download', { timeout: 4000 });
  check('a one-file artifact has no Download ZIP', (await ap.locator('#page-links a.download-zip').count()) === 0);

  // A details page (no preview for data.bin): the list's held text row gets Download, the binary row doesn't.
  await ap.evaluate(id => { location.hash = `#a=${id}`; }, uuidToBase58(U(4)));
  await ap.waitForSelector('ul.files li');
  await ap.waitForSelector('ul.files li button.download', { timeout: 4000 }).catch(() => {});
  const rows = await ap.$$eval('ul.files li', lis => lis.map(li => [li.querySelector('.path').textContent, !!li.querySelector('button.download')]));
  check('the file list offers Download only for held files', JSON.stringify(rows) === JSON.stringify([['data.bin', false], ['style.css', true]]), JSON.stringify(rows));
  got = await download(ap, ap.locator('ul.files li', { hasText: 'style.css' }).locator('button.download'));
  check('and it saves that file', got.name === 'style.css' && got.bytes.toString('utf8') === 'p { color: red; }', got.name);

  check('artifacts viewer: no request, no error, no new page, no frame loading a file or blob',
    av.seen.requests.length === 0 && av.seen.errors.length === 0 && av.seen.popups === 0 && av.seen.frames.every(u => !/^(file|blob|https?):/i.test(u)), JSON.stringify(av.seen));
  await av.context.close();

  await browser.close();
  console.log(failed ? `${failed} failed` : 'all passed');
  process.exit(failed ? 1 : 0);
})();
