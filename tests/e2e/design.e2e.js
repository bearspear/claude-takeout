// A Design artifact's canvas over file:// in Chromium (v1.20), in the Export Artifacts viewer and inside an Export All
// viewer: the boards from project/canvas.json in place, each titled, in its own sandboxed frame (in the guard frame
// when hosted), created only near the view; notes as text (HTML in a note never runs); badges for a board using
// claude.ai's templates and one with uploaded images; Open alone and Back to the canvas; a hostile board ends its
// attacks as an artifact page does; a Design artifact without canvas.json keeps the poster page. No request outside
// file:, no page error.
// Run: PW=<playwright-core> CHROME_EXE=<chrome> node tests/e2e/design.e2e.js
const { chromium } = require(process.env.PW);
const fs = require('fs'), os = require('os'), path = require('path'), vm = require('vm');
const { runArtifacts, exportPopup, assetRoutes, publishedFetcher } = require('../helpers');
const { ATTACKS, ATTACK_ENDS, hostileHtml } = require('./hostile');
const { uuidToBase58 } = require('../../export-core.js');

const LIVE = '1794783850-4a6e';
const DESIGN_TYPE = 'bcd2878f-a88d-4094-a616-8e39d8a5fd8a';
const U = n => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const art = (slug, title, extra = {}) => ({ slug, title, typeSlug: DESIGN_TYPE, typeTitle: 'Design', sourceSurface: 'chat', rel: 'mine', live: LIVE,
  updatedAt: '2026-11-01T00:00:00Z', createdAt: '2026-10-01T00:00:00Z', ...extra });
const board = (name, extra = '') => `<!doctype html><html><head><meta charset="utf-8"><script src="./support.js"></script></head><body><x-dc><helmet><style>body{margin:0}</style></helmet>`
  + `<div id="b" style="width:300px;height:200px;background:#eef">${name}${extra}</div></x-dc>`
  + `<script>const say = () => console.log('BOARD ${name}'); say(); setTimeout(say, 120);</script></body></html>`;
const attacks = { ...ATTACKS, storage: "(localStorage.setItem('k', 'v'), sessionStorage.setItem('s', 'w'), localStorage.getItem('k') + sessionStorage.getItem('s'))" };
const attackEnds = { ...ATTACK_ENDS, storage: 'gave vw' };
const CANVAS = {
  v: 3, title: 'Mockups',
  boards: {
    'Main.dc.html': { x: 0, y: 0, w: 300, h: 200, title: 'Home A' },
    'Tpl.dc.html': { x: 400, y: 0, w: 300, h: 200, title: 'Templated' },
    'Pics.dc.html': { x: 800, y: 0, w: 300, h: 200, title: 'With pictures' },
    'Hostile.dc.html': { x: 0, y: 400, w: 600, h: 400, title: 'Hostile board' },
    'Far.dc.html': { x: 0, y: 6000, w: 300, h: 200, title: 'Far away' },
    'Gone.dc.html': { x: 400, y: 400, w: 300, h: 200, title: 'Not saved' },
    'Off.dc.html': { x: 1e9, y: 0, w: 300, h: 200, title: 'Off canvas' },
  },
  notes: {
    t: { kind: 'title1', text: 'Section heading', x: 0, y: -120, maxW: 1100 },
    n1: { fill: 'teal', text: 'A sticky note <img src=x onerror="console.log(\'NOTE RAN\')">', x: 800, y: 400, w: 300 },
    n2: { fill: 'yellow', text: 'Right below Home A', x: 0, y: 205, w: 300 },
  },
  noteOrder: ['t', 'n1'],
};
const designFiles = {
  'index.html': '<!doctype html><script src="artifact-type/app.js"></script>',
  'project/canvas.json': { body: JSON.stringify(CANVAS), type: 'application/json' },
  'project/Main.dc.html': board('Main'),
  'project/Tpl.dc.html': board('Tpl', '<p>{{count}} items</p>'),
  'project/Pics.dc.html': board('Pics', '<img src="/_blob/abc">'),
  'project/Hostile.dc.html': hostileHtml(attacks),
  'project/Far.dc.html': board('Far'),
  'project/Off.dc.html': board('Off'),
};
const frames = [art(U(1), 'Mockups'), art(U(2), 'Bare design')];
const pages = {
  [U(1)]: { title: 'Mockups', live: LIVE, versions: { [LIVE]: { files: designFiles } } },
  [U(2)]: { title: 'Bare design', live: LIVE, versions: { [LIVE]: { files: { 'index.html': '<!doctype html><script src="artifact-type/app.js"></script>' } } } },
};

// Export All (hosted), as combined.e2e.js runs it: a chat that only talks, and the artifacts.
async function exportAll() {
  const JSZip = require('../../jszip.min.js');
  const sb = exportPopup({ routes: assetRoutes() }).sandbox;
  const fetcher = publishedFetcher(pages);
  const chat = { uuid: 'c1', name: 'Talk', model: 'claude-x', created_at: '2026-05-01T10:00:00Z', updated_at: '2026-05-01T10:01:00Z', settings: {}, current_leaf_message_uuid: 'a1',
    chat_messages: [{ uuid: 'h1', parent_message_uuid: null, sender: 'human', created_at: '2026-05-01T10:00:00Z', content: [{ type: 'text', text: 'hi' }], attachments: [], files: [], files_v2: [] },
      { uuid: 'a1', parent_message_uuid: 'h1', sender: 'assistant', created_at: '2026-05-01T10:01:00Z', content: [{ type: 'text', text: 'Hello.' }], attachments: [], files: [], files_v2: [] }] };
  const store = {};
  sb.chrome.storage.local.get = async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(k => k in store).map(k => [k, store[k]]));
  sb.chrome.storage.local.set = async (o) => { Object.assign(store, JSON.parse(JSON.stringify(o))); };
  sb.chrome.permissions = { contains: async () => false, request: async () => false };
  sb.chrome.tabs.query = async () => [{ id: 1, url: 'https://claude.ai/chat/x' }];
  sb.chrome.tabs.sendMessage = (id, m, cb) => {
    if (m.action === 'fetchAllConversations') cb({ data: [{ uuid: 'c1', name: 'Talk', updated_at: chat.updated_at }], orgId: 'org-1' });
    else if (m.action === 'fetchConversation') cb({ data: JSON.parse(JSON.stringify(chat)) });
    else if (m.action === 'listArtifacts') cb({ frames: JSON.parse(JSON.stringify(frames)) });
    else if (/^publishedPage/.test(m.action)) fetcher.fetch(m).then(cb);
    else cb({});
  };
  sb.JSZip = JSZip;
  sb.Uint8Array = Uint8Array;
  let saved = null;
  sb.download = (blob) => { saved = blob; };
  sb.setTimeout = (f) => setTimeout(f, 0);
  vm.runInContext('orgId = "org-1"', sb);
  await vm.runInContext('bulkExportZip({})', sb);
  if (!saved) throw new Error('no download');
  return writeOut(await JSZip.loadAsync(await saved.arrayBuffer()));
}
async function writeOut(zip) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-'));
  for (const n of Object.keys(zip.files)) {
    if (zip.files[n].dir) continue;
    const fp = path.join(dir, n);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, await zip.file(n).async('nodebuffer'));
  }
  return dir;
}

(async () => {
  const { raw } = await runArtifacts({ frames, pages });
  const standalone = fs.mkdtempSync(path.join(os.tmpdir(), 'design-art-'));
  for (const [n, bytes] of Object.entries(raw)) { const fp = path.join(standalone, n); fs.mkdirSync(path.dirname(fp), { recursive: true }); fs.writeFileSync(fp, bytes); }
  const hosted = await exportAll();

  const browser = await chromium.launch({ executablePath: process.env.CHROME_EXE, args: ['--disable-features=IsolateSandboxedIframes'] });
  let failed = 0;
  const check = (n, ok, x = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n} ${ok ? '' : x}`); };

  for (const [label, dir, isHosted] of [['standalone', standalone, false], ['hosted', hosted, true]]) {
    const context = await browser.newContext({ viewport: { width: 1300, height: 900 } });
    const page = await context.newPage();
    const seen = { errors: [], requests: [], logs: [], popups: 0 };
    page.on('pageerror', e => seen.errors.push(e.message));
    page.on('console', m => seen.logs.push(m.text()));
    context.on('page', () => { seen.popups++; });
    await context.route('**/*', r => { const u = r.request().url(); if (u.startsWith('file:')) return r.continue(); seen.requests.push(u); return r.abort(); });
    const waitLog = async (text, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (seen.logs.some(l => l.includes(text))) return true; await page.waitForTimeout(25); } return false; };
    await page.goto('file://' + path.join(dir, 'viewer.html') + `#a=${uuidToBase58(U(1))}`);
    const canvas = page.locator('.design-canvas');
    await canvas.waitFor({ timeout: 4000 }).catch(() => {});
    check(`${label}: a Design artifact shows its canvas`, await canvas.count() === 1);
    const badges = await page.locator('#page-badges .badge').allTextContents();
    check(`${label}: badges say Design canvas and that some boards need claude.ai`, badges.includes('Design canvas') && badges.includes('some boards need claude.ai') && !badges.includes('needs claude.ai to run'), badges.join('|'));
    const titles = await page.locator('.design-board .board-title').allTextContents();
    check(`${label}: every board has its title`, ['Home A', 'Templated', 'With pictures', 'Hostile board', 'Far away', 'Not saved'].every(t => titles.some(x => x.includes(t))), titles.join('|'));
    const place = await page.locator('.design-board', { hasText: 'Templated' }).evaluate(el => [el.style.left, el.style.top]);
    check(`${label}: a board sits at its place on the canvas`, place[0] !== '' && place[1] !== '' && place[0] !== '0px', place.join());
    check(`${label}: the board renders`, await waitLog('BOARD Main'));
    const srcdoc = await page.locator('.design-board', { hasText: 'Home A' }).locator('iframe').getAttribute('srcdoc');
    const sandbox = await page.locator('.design-board', { hasText: 'Home A' }).locator('iframe').getAttribute('sandbox');
    check(`${label}: the board's frame is sandboxed as an artifact page${isHosted ? ', inside its guard frame' : ''}`,
      sandbox === 'allow-scripts allow-forms allow-modals' && (isHosted ? srcdoc.includes("frame-src 'none'") : !srcdoc.includes("frame-src 'none'")), sandbox);
    check(`${label}: a far board has no frame yet`, await page.locator('.design-board', { hasText: 'Far away' }).locator('iframe').count() === 0);
    await page.locator('.design-board', { hasText: 'Far away' }).scrollIntoViewIfNeeded();
    check(`${label}: and gets one when scrolled to`, await waitLog('BOARD Far'));
    check(`${label}: template badge`, (await page.locator('.design-board', { hasText: 'Templated' }).locator('.board-badge').allTextContents()).includes("Uses claude.ai's templates; shown as saved"));
    check(`${label}: images badge`, (await page.locator('.design-board', { hasText: 'With pictures' }).locator('.board-badge').allTextContents()).includes('Images not in this export'));
    check(`${label}: a board not saved is a tile`, (await page.locator('.design-board', { hasText: 'Not saved' }).textContent()).includes("Not in the viewer's files"));
    const note = page.locator('.design-note', { hasText: 'A sticky note' });
    check(`${label}: a note shows its text as text`, (await note.textContent()).includes('<img src=x onerror=') && (await note.locator('img').count()) === 0);
    check(`${label}: the heading note`, (await page.locator('.design-note.heading').textContent()) === 'Section heading');
    // A note just below a board is not covered by it: the board's title sits above the board, not inside its place.
    const below = await page.locator('.design-note', { hasText: 'Right below Home A' }).boundingBox();
    const mainBody = await page.locator('.design-board', { hasText: 'Home A' }).locator('.board-body').boundingBox();
    check(`${label}: a note just below a board is not covered`, below.y >= mainBody.y + mainBody.height - 0.5, JSON.stringify([below.y, mainBody.y + mainBody.height]));
    const mainBox = await page.locator('.design-board', { hasText: 'Home A' }).boundingBox();
    check(`${label}: a board's body starts at its place`, Math.abs(mainBody.y - mainBox.y) < 1, JSON.stringify([mainBody.y, mainBox.y]));

    // The hostile board.
    await page.locator('.design-board', { hasText: 'Hostile board' }).scrollIntoViewIfNeeded();
    check(`${label}: the hostile board ran to the end`, await waitLog('ATTACK finished yes'));
    for (const [name, end] of Object.entries(attackEnds)) {
      const said = seen.logs.filter(l => l.startsWith(`ATTACK ${name} `)).map(l => l.slice(`ATTACK ${name} `.length));
      check(`${label}: hostile ${name} ended ${end}`, said[0] === 'ran' && said[1] === end, said.join());
    }
    check(`${label}: nothing ran in the viewer`, !(await page.evaluate(() => !!window.__hit)));

    const deepActive = () => page.evaluate(() => { let a = document.activeElement; while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement; return a ? (a.id || a.getAttribute('aria-label') || a.className) : null; });
    // Opened by its address (the chat viewer routes it): focus is on the page title, not left on a hidden column.
    check(`${label}: focus on the page title when opened by its address`, (await deepActive()) === 'page-title', String(await deepActive()));

    // Open alone, and back.
    await page.locator('.design-board', { hasText: 'Home A' }).locator('button.board-open').click();
    await page.locator('button.canvas-back').waitFor({ timeout: 3000 }).catch(() => {});
    check(`${label}: Open alone shows the board by itself`, await page.locator('.design-canvas').count() === 0 && await page.locator('#page-body .preview iframe').count() === 1);
    check(`${label}: Open alone puts focus on Back to the canvas`, String(await deepActive()).includes('canvas-back'), String(await deepActive()));
    await page.locator('button.canvas-back').click();
    await canvas.waitFor({ timeout: 3000 }).catch(() => {});
    check(`${label}: Back to the canvas`, await page.locator('.design-canvas').count() === 1);
    await page.locator('.design-board', { hasText: 'Home A' }).locator('button.board-open').click();
    await page.locator('button.canvas-back').click();
    await canvas.waitFor({ timeout: 3000 }).catch(() => {});
    const focused = await page.evaluate(() => { let a = document.activeElement; while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement; return a ? a.getAttribute('aria-label') : null; });
    check(`${label}: Back puts focus on the board it left`, focused === 'Open Home A alone', String(focused));
    // A board listed under the canvas (out of range): Open alone, and Back lands on its row.
    await page.locator('.design-skipped button.board-open').click();
    await page.locator('button.canvas-back').click();
    await canvas.waitFor({ timeout: 3000 }).catch(() => {});
    check(`${label}: Back from a board not drawn lands on its row`, (await deepActive()) === 'Open Off canvas alone', String(await deepActive()));
    // Narrow: each board's title row stays one line; then wide again, and the canvas follows the width.
    const wideWidth = (await canvas.boundingBox()).width;
    // Title rows: never wider than the board (a long title or badge shortens), the title never squeezed to nothing.
    const rows = () => page.locator('.design-board').evaluateAll(bs => bs.map(b => {
      const head = b.querySelector('.board-head');
      const title = head.querySelector('.board-title');
      return { name: b.dataset.name, board: b.getBoundingClientRect().width, row: head.getBoundingClientRect().width, title: title.getBoundingClientRect().width };
    }));
    const wideRows = await rows();
    check(`${label}: no title row is wider than its board`, wideRows.every(r => r.row <= r.board + 1), JSON.stringify(wideRows));
    check(`${label}: a badge doesn't squeeze the title away`, wideRows.every(r => r.title >= 20), JSON.stringify(wideRows));
    // Keyboard focus on a board, its frame marked: a resize keeps both.
    await page.locator('.design-board', { hasText: 'Home A' }).locator('button.board-open').focus();
    await page.locator('.design-board', { hasText: 'Home A' }).locator('iframe').evaluate(f => { f.dataset.kept = 'yes'; });
    await page.setViewportSize({ width: 420, height: 900 });
    await page.waitForTimeout(500);
    check(`${label}: a resize keeps keyboard focus on the board`, (await deepActive()) === 'Open Home A alone', String(await deepActive()));
    check(`${label}: and keeps its frame (no reload)`, await page.locator('.design-board', { hasText: 'Home A' }).locator('iframe[data-kept="yes"]').count() === 1);
    const clipped = await page.locator('.design-board .board-head').evaluateAll(hs => hs.filter(h => h.querySelector('button.board-open')).map(h => {
      const b = h.querySelector('button.board-open').getBoundingClientRect();
      const r = h.getBoundingClientRect();
      return b.left >= r.left - 0.5 && b.right <= r.right + 0.5 ? null : [Math.round(b.left - r.left), Math.round(b.right - r.right)];
    }).filter(Boolean));
    check(`${label}: Open alone stays whole on small boards`, clipped.length === 0, JSON.stringify(clipped));
    const narrowRows = await rows();
    check(`${label}: small boards' rows stay about their width`, narrowRows.every(r => r.row <= Math.max(r.board, 6.5 * 12) + 1), JSON.stringify(narrowRows));
    const narrowWidth = (await canvas.boundingBox()).width;
    const heads = await page.locator('.design-board .board-head').evaluateAll(hs => hs.map(h => h.getBoundingClientRect().height));
    check(`${label}: the canvas follows a narrower window`, narrowWidth < wideWidth * 0.6, JSON.stringify([wideWidth, narrowWidth]));
    check(`${label}: board title rows stay one line when small`, heads.every(h => h <= 30), JSON.stringify(heads));
    await page.setViewportSize({ width: 1300, height: 900 });
    await page.waitForTimeout(500);
    check(`${label}: and a wider one`, Math.abs((await canvas.boundingBox()).width - wideWidth) < 40, String((await canvas.boundingBox()).width));
    const again = await page.locator('#page-badges .badge').allTextContents();
    check(`${label}: badges stay single after Back`, again.filter(b => b === 'Design canvas').length === 1 && again.filter(b => b === 'some boards need claude.ai').length === 1, again.join('|'));

    // A Design artifact with no canvas.json keeps the poster page.
    await page.evaluate(id => { location.hash = `#a=${id}`; }, uuidToBase58(U(2)));
    await page.waitForSelector('.sheet.poster', { timeout: 3000 }).catch(() => {});
    check(`${label}: no canvas.json: the poster page`, await page.locator('.sheet.poster').count() === 1 && await page.locator('.design-canvas').count() === 0);

    await page.waitForTimeout(300);
    check(`${label}: NOTE never ran`, !seen.logs.some(l => l.includes('NOTE RAN')));
    check(`${label}: no request left, no window opened, no page error`, seen.requests.length === 0 && seen.popups === 0 && seen.errors.length === 0, JSON.stringify([seen.requests, seen.popups, seen.errors]));
    check(`${label}: viewer URL unchanged by the boards`, page.url().endsWith(`#a=${uuidToBase58(U(2))}`), page.url());
    await context.close();
  }
  await browser.close();
  console.log(failed ? `${failed} failed` : 'all passed');
  process.exit(failed ? 1 : 0);
})();
