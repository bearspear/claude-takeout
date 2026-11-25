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
const OLD = '1794700000-0abc';
const oldCanvas = { v: 3, title: 'Mockups', boards: { 'Early.dc.html': { x: 0, y: 0, w: 300, h: 200, title: 'Only in the first version' } } };
const pages = {
  [U(1)]: { title: 'Mockups', live: LIVE, history: [OLD, LIVE], versions: {
    [OLD]: { files: { 'index.html': designFiles['index.html'], 'project/canvas.json': { body: JSON.stringify(oldCanvas), type: 'application/json' }, 'project/Early.dc.html': board('Early') } },
    [LIVE]: { files: designFiles },
  } },
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
    const alone = await page.locator('#page-body .preview .page-zoom').evaluate(w => ({ frame: !!w.querySelector(':scope > iframe'), out: !!w.querySelector('.zoom-bar .zoom-out'), fit: !!w.querySelector('.zoom-bar .zoom-fit'), level: (w.querySelector('.zoom-level') || {}).textContent }), null, { timeout: 3000 }).catch(() => null);
    check(`${label}: Open alone: the board has the page bar`, !!alone && alone.frame && alone.out && alone.fit && alone.level === '100%', JSON.stringify(alone));
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

    // Zoom and drag (v1.23). The canvas is 1100 wide: at 1300 its Fit is 100% standalone, less hosted (the chat
    // viewer's column takes room).
    const level = () => page.locator('.canvas-zoom .zoom-level').textContent({ timeout: 1000 }).catch(() => null);
    const press = async (cls, n = 1) => { for (let i = 0; i < n; i++) await page.locator(`.canvas-zoom .${cls}`).click({ timeout: 1000 }).catch(() => {}); };
    const body = page.locator('#page-body');
    const scrollTo = (left, top) => body.evaluate((b, [l, t]) => { b.scrollLeft = l; b.scrollTop = t; }, [left, top]);
    const scrollOf = () => body.evaluate(b => [b.scrollLeft, b.scrollTop]);
    const boxOf = name => page.locator('.design-board', { hasText: name }).locator('.board-body').boundingBox();
    const startLevel = await level();
    const upTo = async want => { for (let i = 0; i < 9 && (await level()) !== want; i++) await press('zoom-in'); };
    await upTo('100%');
    await press('zoom-in');
    const firstIn = await level();
    await press('zoom-in', 5);
    const top = await level();
    const topWidth = (await canvas.boundingBox() || {}).width;
    check(`${label}: canvas: + zooms past 100% to 125%, 200% is the top`, parseFloat(startLevel) <= 100 && (isHosted || startLevel === '100%') && firstIn === '125%' && top === '200%' && Math.abs(topWidth - 2200) < 4, JSON.stringify([startLevel, firstIn, top, topWidth]));
    await press('zoom-fit');
    // Narrower: Fit below 100%, and − never goes under it.
    await page.setViewportSize({ width: 900, height: 900 });
    await page.waitForTimeout(500);
    const fitLevel = await level();
    const fitWidth = (await canvas.boundingBox()).width;
    await press('zoom-out', 2);
    check(`${label}: canvas: − stops at Fit`, !!fitLevel && parseFloat(fitLevel) < 100 && (await level()) === fitLevel && Math.abs((await canvas.boundingBox()).width - fitWidth) < 1, JSON.stringify([fitLevel, await level(), fitWidth]));
    await upTo('125%');
    const chosen = await level();
    await page.setViewportSize({ width: 1300, height: 900 });
    await page.waitForTimeout(500);
    const kept = await level();
    await press('zoom-fit');
    check(`${label}: canvas: resize at Fit refits; after zooming, resize keeps the zoom`, parseFloat(fitLevel) < parseFloat(startLevel) && chosen === '125%' && kept === chosen && (await level()) === startLevel, JSON.stringify([fitLevel, chosen, kept, await level()]));

    // Move and Interact (v1.23.1). The canvas opens in Move: boards ignore the mouse, a plain wheel zooms, a drag
    // anywhere pans.
    const mode = () => page.locator('.canvas-modes[role="group"] .canvas-mode[aria-pressed="true"]').allTextContents().catch(() => []);
    const framePE = () => page.locator('.design-board', { hasText: 'Home A' }).locator('iframe').evaluate(f => getComputedStyle(f).pointerEvents, null, { timeout: 1000 }).catch(() => null);
    const modeGroup = await page.locator('.canvas-zoom .canvas-modes').evaluate(g => ({ label: g.getAttribute('aria-label'), first: g === g.parentNode.firstElementChild,
      buttons: [...g.querySelectorAll('button.canvas-mode')].map(b => `${b.textContent}:${b.getAttribute('aria-pressed')}`) }), null, { timeout: 1000 }).catch(() => null);
    check(`${label}: canvas: opens in Move, Move | Interact first in the bar`, !!modeGroup && modeGroup.label === 'Canvas mode' && modeGroup.first && modeGroup.buttons.join() === 'Move:true,Interact:false', JSON.stringify(modeGroup));
    check(`${label}: canvas: in Move a board's frame ignores the mouse`, (await framePE()) === 'none', String(await framePE()));
    // From 125%, where the canvas is wider than the view: narrower, it stays centred, so no zoom can hold a point.
    await press('zoom-fit');
    await upTo('125%');
    await scrollTo(0, 0);
    const m0 = await boxOf('Home A');
    const mp = { x: m0.x + m0.width * 0.6, y: m0.y + m0.height * 0.6 };
    const mfrac = { x: (mp.x - m0.x) / m0.width, y: (mp.y - m0.y) / m0.height };
    const fitNow = await level();
    await page.mouse.move(mp.x, mp.y);
    await page.mouse.wheel(0, -40);
    await page.waitForTimeout(200);
    const m1 = await boxOf('Home A');
    const mmoved = [m1.x + mfrac.x * m1.width - mp.x, m1.y + mfrac.y * m1.height - mp.y];
    check(`${label}: canvas: Move: a plain wheel over a board zooms about the pointer`, parseFloat(await level()) > parseFloat(fitNow) && Math.abs(mmoved[0]) < 3 && Math.abs(mmoved[1]) < 3, JSON.stringify([fitNow, await level(), mmoved]));
    await upTo('125%');
    await scrollTo(0, 0);
    const beforeShift = await level();
    await page.mouse.move(mp.x, mp.y);
    await page.keyboard.down('Shift');
    await page.mouse.wheel(0, 100);
    await page.keyboard.up('Shift');
    await page.waitForTimeout(200);
    const shifted = await scrollOf();
    check(`${label}: canvas: Move: Shift+wheel scrolls sideways, no zoom`, shifted[0] > 0 && shifted[1] === 0 && (await level()) === beforeShift, JSON.stringify([shifted, beforeShift, await level()]));
    await scrollTo(0, 0);
    await page.mouse.wheel(100, 0);
    await page.waitForTimeout(200);
    const swiped = await scrollOf();
    check(`${label}: canvas: Move: a sideways swipe scrolls sideways, no zoom`, swiped[0] > 0 && swiped[1] === 0 && (await level()) === beforeShift, JSON.stringify([swiped, beforeShift, await level()]));
    await scrollTo(0, 0);
    const mb = await boxOf('Home A');
    const mstart = { x: mb.x + mb.width / 2, y: mb.y + mb.height / 2 };
    await page.mouse.move(mstart.x, mstart.y);
    await page.mouse.down();
    for (let i = 1; i <= 5; i++) await page.mouse.move(mstart.x - 20 * i, mstart.y - 16 * i);
    await page.mouse.up();
    const mdrag = await scrollOf();
    check(`${label}: canvas: Move: a drag starting over a board pans`, mdrag[0] >= 90 && mdrag[1] >= 70, JSON.stringify(mdrag));
    await scrollTo(0, 0);
    // In Move too: a drag ending on Open alone opens nothing; a click opens it, and Back keeps Move.
    const mopen = page.locator('.design-board', { hasText: 'Templated' }).locator('button.board-open');
    const mob = await mopen.boundingBox();
    const moc = { x: mob.x + mob.width / 2, y: mob.y + mob.height / 2 };
    await page.mouse.move(moc.x, moc.y);
    await page.mouse.down();
    await page.mouse.move(moc.x + 12, moc.y + 12);
    await page.mouse.move(moc.x + 24, moc.y + 24);
    await page.mouse.move(moc.x, moc.y);
    await page.mouse.up();
    await page.waitForTimeout(200);
    const mAfterDrag = await page.locator('button.canvas-back').count();
    if (mAfterDrag) { await page.locator('button.canvas-back').click(); await canvas.waitFor({ timeout: 3000 }).catch(() => {}); }
    await page.locator('.design-board', { hasText: 'Templated' }).locator('button.board-open').click({ timeout: 1000 }).catch(() => {});
    await page.locator('button.canvas-back').waitFor({ timeout: 3000 }).catch(() => {});
    const mOpened = await page.locator('button.canvas-back').count();
    check(`${label}: canvas: Move: a drag ending on Open alone doesn't open it; a click does`, mAfterDrag === 0 && mOpened === 1, JSON.stringify([mAfterDrag, mOpened]));
    await page.locator('button.canvas-back').click({ timeout: 1000 }).catch(() => {});
    await canvas.waitFor({ timeout: 3000 }).catch(() => {});

    // Ctrl+wheel over the background, between Home A and Templated: the point under the pointer stays.
    await press('zoom-fit');
    await scrollTo(0, 0);
    const t0 = await boxOf('Templated');
    const pointer = { x: t0.x - 50, y: t0.y + 100 };
    const frac = { x: (pointer.x - t0.x) / t0.width, y: (pointer.y - t0.y) / t0.height };
    await page.mouse.move(pointer.x, pointer.y);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -40);
    await page.keyboard.up('Control');
    await page.waitForTimeout(200);
    const t1 = await boxOf('Templated');
    const moved = [t1.x + frac.x * t1.width - pointer.x, t1.y + frac.y * t1.height - pointer.y];
    check(`${label}: canvas: Ctrl+wheel over the background zooms about the pointer`, parseFloat(await level()) > parseFloat(startLevel) && t1.width > t0.width && Math.abs(moved[0]) < 3 && Math.abs(moved[1]) < 3, JSON.stringify([await level(), moved]));

    // Drag: on the background it scrolls the page body; on a board's frame it doesn't.
    await press('zoom-fit');
    await upTo('125%');
    await scrollTo(0, 0);
    const t2 = await boxOf('Templated');
    const at = { x: t2.x - 40, y: t2.y + 100 };
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    for (let i = 1; i <= 5; i++) await page.mouse.move(at.x - 20 * i, at.y - 16 * i);
    await page.mouse.up();
    const dragged = await scrollOf();
    check(`${label}: canvas: drag on the background scrolls #page-body`, dragged[0] >= 90 && dragged[1] >= 70, JSON.stringify(dragged));
    // Interact: v1.23.0's canvas. Boards take the mouse, a plain wheel doesn't zoom.
    await page.locator('.canvas-zoom button.canvas-mode', { hasText: 'Interact' }).click({ timeout: 1000 }).catch(() => {});
    const pressed = await page.locator('.canvas-zoom button.canvas-mode').evaluateAll(bs => bs.map(b => `${b.textContent}:${b.getAttribute('aria-pressed')}`)).catch(() => []);
    check(`${label}: canvas: Interact is pressed, boards take the mouse again`, pressed.join() === 'Move:false,Interact:true' && (await framePE()) === 'auto', JSON.stringify([pressed, await framePE()]));
    await scrollTo(0, 0);
    const beforePlain = await level();
    const gap = await boxOf('Templated');
    await page.mouse.move(gap.x - 40, gap.y + 100);
    await page.mouse.wheel(0, -40);
    await page.waitForTimeout(200);
    check(`${label}: canvas: Interact: a plain wheel doesn't zoom`, (await level()) === beforePlain, JSON.stringify([beforePlain, await level()]));
    await scrollTo(0, 0);
    const h0 = await boxOf('Home A');
    const inFrame = { x: h0.x + h0.width / 2, y: h0.y + h0.height / 2 };
    await page.mouse.move(inFrame.x, inFrame.y);
    await page.mouse.down();
    for (let i = 1; i <= 5; i++) await page.mouse.move(inFrame.x - 20 * i, inFrame.y - 16 * i);
    await page.mouse.up();
    check(`${label}: canvas: drag on a board frame doesn't`, JSON.stringify(await scrollOf()) === '[0,0]', JSON.stringify(await scrollOf()));
    // Space held in Interact: Move until it is let go. Focus off the Interact button first (Space presses a button).
    await page.mouse.click(gap.x - 40, gap.y + 100);
    await scrollTo(0, 0);
    await page.keyboard.down('Space');
    const spacePE = await framePE();
    const s0 = await boxOf('Home A');
    const sAt = { x: s0.x + s0.width / 2, y: s0.y + s0.height / 2 };
    await page.mouse.move(sAt.x, sAt.y);
    await page.mouse.down();
    for (let i = 1; i <= 5; i++) await page.mouse.move(sAt.x - 20 * i, sAt.y - 16 * i);
    await page.mouse.up();
    const sDrag = await scrollOf();
    await page.keyboard.up('Space');
    check(`${label}: canvas: Space held in Interact: boards ignore the mouse and a drag over one pans`, spacePE === 'none' && sDrag[0] >= 90 && sDrag[1] >= 70, JSON.stringify([spacePE, sDrag]));
    check(`${label}: canvas: Space let go: back to Interact`, (await framePE()) === 'auto' && (await mode()).join() === 'Interact', JSON.stringify([await framePE(), await mode()]));
    await scrollTo(0, 0);

    // A press on Open alone that moves away and back is a drag: no board. A plain click opens it.
    const open = page.locator('.design-board', { hasText: 'Templated' }).locator('button.board-open');
    const ob = await open.boundingBox();
    const oc = { x: ob.x + ob.width / 2, y: ob.y + ob.height / 2 };
    await page.mouse.move(oc.x, oc.y);
    await page.mouse.down();
    await page.mouse.move(oc.x + 12, oc.y + 12);
    await page.mouse.move(oc.x + 24, oc.y + 24);
    await page.mouse.move(oc.x, oc.y);
    await page.mouse.up();
    await page.waitForTimeout(200);
    const afterDrag = await page.locator('button.canvas-back').count();
    if (afterDrag) { await page.locator('button.canvas-back').click(); await canvas.waitFor({ timeout: 3000 }).catch(() => {}); }
    await upTo('150%');
    await page.locator('.design-board', { hasText: 'Home A' }).locator('button.board-open').scrollIntoViewIfNeeded();
    const zoomBefore = await level();
    const homeBefore = await boxOf('Home A');
    await page.locator('.design-board', { hasText: 'Home A' }).locator('button.board-open').click();
    await page.locator('button.canvas-back').waitFor({ timeout: 3000 }).catch(() => {});
    check(`${label}: canvas: a board head click opens the board; a drag ending on Open alone doesn't`, afterDrag === 0 && await page.locator('button.canvas-back').count() === 1, String(afterDrag));
    await page.locator('button.canvas-back').click({ timeout: 1000 }).catch(() => {});
    await canvas.waitFor({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(100);
    const homeAfter = await boxOf('Home A');
    check(`${label}: canvas: Back from Open alone restores the zoom`, zoomBefore === '150%' && (await level()) === zoomBefore && Math.abs(homeAfter.x - homeBefore.x) < 3 && Math.abs(homeAfter.y - homeBefore.y) < 3,
      JSON.stringify([zoomBefore, await level(), homeBefore, homeAfter]));
    check(`${label}: canvas: the mode survives Open alone and Back`, (await mode()).join() === 'Interact' && (await framePE()) === 'auto', JSON.stringify([await mode(), await framePE()]));

    // Zoomed in, a far board's frame still comes when scrolled to.
    await press('zoom-in', 5);
    await scrollTo(0, 0);
    await page.waitForTimeout(300);
    const farFrames = () => page.locator('.design-board', { hasText: 'Far away' }).locator('iframe').count();
    const farBefore = await farFrames();
    await page.locator('.design-board', { hasText: 'Far away' }).scrollIntoViewIfNeeded();
    let farAfter = 0;
    for (let i = 0; i < 40 && !farAfter; i++) { await page.waitForTimeout(50); farAfter = await farFrames(); }
    check(`${label}: canvas: zoomed in, boards still load as they scroll into view`, (await level()) === '200%' && farBefore === 0 && farAfter === 1, JSON.stringify([await level(), farBefore, farAfter]));
    await press('zoom-fit');
    await scrollTo(0, 0);

    // An older version from the menu: its own canvas.
    await page.locator('#page-from select').selectOption({ label: 'v1' }, { timeout: 3000 }).catch(() => {});
    await page.locator('.design-board', { hasText: 'Only in the first version' }).waitFor({ timeout: 4000 }).catch(() => {});
    check(`${label}: an older version shows its own canvas`, await page.locator('.design-board', { hasText: 'Only in the first version' }).count() === 1 && await page.locator('.design-board', { hasText: 'Home A' }).count() === 0);
    await page.locator('#page-from select').selectOption('current', { timeout: 3000 }).catch(() => {});
    await canvas.waitFor({ timeout: 4000 }).catch(() => {});
    check(`${label}: and back to the current one`, await page.locator('.design-board', { hasText: 'Home A' }).count() === 1);
    check(`${label}: canvas: the mode survives a version switch`, (await mode()).join() === 'Interact', JSON.stringify(await mode()));

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
