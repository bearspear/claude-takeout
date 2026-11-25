// Zoom and pan in the chat viewer over file:// in Chromium: the gallery opens a picture at Fit, a plain
// wheel zooms about the pointer, a drag pans without closing, double-click and keys, and an inline
// diagram opens as a one-item gallery. In the side panel and the upload popup pictures zoom in place,
// and SVG files show as pictures, falling back to the sandboxed frame when the strict parser refuses them.
const { chromium } = require(process.env.PW);
const fs = require('fs'), os = require('os'), path = require('path'), zlib = require('zlib');
const { buildHtml } = require('./make-viewer.js');
const { VIEWER_CHECK_BASE64, VIEWER_CHECK_FILE } = require('../../takeout-viewer.js');
const core = require('../../export-core.js');

const at = n => `2026-05-01T10:${String(n).padStart(2, '0')}:00Z`;
const msg = (uuid, parent, sender, n, content) => ({ uuid, parent_message_uuid: parent, sender, created_at: at(n), content, attachments: [], files: [], files_v2: [] });
const use = (id, name, input) => ({ type: 'tool_use', id, name, input });
const res = (id, name, content) => ({ type: 'tool_result', tool_use_id: id, name, is_error: false, content });
const img = (n, extra = {}) => ({ url: `https://img.example/${n}.png`, title: `Picture ${n}`, source: 'example.com', page_url: `https://example.com/${n}`, ...extra });

// A real grayscale PNG of the given size, a gradient.
function png(width, height) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) raw[y * (width + 1) + 1 + x] = (x + y) & 0xff;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const BIG = png(2000, 1000);
const SMALL = png(1, 1);
const SVG = '<svg width="1600" height="1200" viewBox="0 0 1600 1200"><rect x="100" y="100" width="1400" height="1000" fill="#c96"/></svg>';

const chat = {
  uuid: 'z', name: 'Zoom', model: 'claude-x', created_at: at(1), updated_at: at(3), settings: {}, current_leaf_message_uuid: 'a1',
  chat_messages: [
    msg('h1', null, 'human', 1, [{ type: 'text', text: 'show me' }]),
    msg('a1', 'h1', 'assistant', 2, [
      use('s1', 'image_search', { query: 'big' }),
      res('s1', 'image_search', [{ type: 'text', text: 'Found 3' }, { images: [img(1), img(2), img(3)] }]),
      { type: 'text', text: 'Here they are.' },
      use('d1', 'mcp__visualize__show_widget', { title: 'plan', widget_code: SVG }), res('d1', 'mcp__visualize__show_widget', [{ type: 'text', text: 'shown' }]),
      { type: 'text', text: 'And a plan.' },
    ]),
  ],
};

const cf = (id, p, text) => use(id, 'create_file', { path: p, file_text: text });
const out = n => `/mnt/user-data/outputs/${n}`;
const CHART1 = '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1200"><rect x="100" y="100" width="1400" height="1000" fill="#69c"/></svg>';
const CHART2 = '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect x="50" y="50" width="700" height="500" fill="#c69"/></svg>';
const BARE = '<svg width="400" height="300"><rect width="400" height="300" fill="#9c6"/></svg>';
const NBSP = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><text x="10" y="40">a&nbsp;b</text></svg>';
const HUGE = '<svg xmlns="http://www.w3.org/2000/svg" width="100000" height="100"><rect width="100000" height="100" fill="#999"/></svg>';
const PCT = '<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 900 600"><rect width="900" height="600" fill="#c96"/></svg>';
const PHOTO = png(1200, 800);
const panelChat = {
  uuid: 'p', name: 'Panel pictures', model: 'claude-x', created_at: at(4), updated_at: at(9), settings: {}, current_leaf_message_uuid: 'pa2',
  chat_messages: [
    msg('ph1', null, 'human', 4, [{ type: 'text', text: 'draw' }]),
    msg('pa1', 'ph1', 'assistant', 5, [
      { type: 'text', text: 'Drawn.' },
      cf('c1', out('chart.svg'), CHART1), cf('c2', out('bare.svg'), BARE), cf('c3', out('nbsp.svg'), NBSP),
      cf('c4', out('huge.svg'), HUGE), cf('c5', out('pct.svg'), PCT), use('c7', 'present_files', { filepaths: [out('pic.png')] }),
    ]),
    { ...msg('ph2', 'pa1', 'human', 6, [{ type: 'text', text: 'smaller, and here is a photo' }]), files_v2: [{ file_uuid: 'u-png', file_name: 'photo.png', success: true }] },
    msg('pa2', 'ph2', 'assistant', 7, [{ type: 'text', text: 'Smaller.' }, cf('c6', out('chart.svg'), CHART2)]),
  ],
};

// Pages: a fluid one with a button, one laid out 1600 px wide, a scripted SVG, and one whose nested frame
// posts a false size report to the viewer.
const FLUID = '<!doctype html><html><body><p>Fluid text that wraps to whatever width the frame has, as most pages do.</p><button id="b" onclick="console.log(\'fluid-click\')">Press</button></body></html>';
const WIDE = '<!doctype html><html><body style="margin:0"><div style="width:1600px;height:300px;background:#69c">wide</div></body></html>';
const SCRIPTED = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" onload="void 0"><rect width="400" height="300" fill="#69c"/></svg>';
const SPOOF = '<!doctype html><html><body><p>spoof</p><iframe srcdoc="<script>function s(){window.top.postMessage({type:\'ct-size\',width:99999,view:1},\'*\')}s();setTimeout(s,200);setTimeout(s,600)</script>"></iframe></body></html>';
const pageChat = {
  uuid: 'g', name: 'Pages', model: 'claude-x', created_at: at(10), updated_at: at(12), settings: {}, current_leaf_message_uuid: 'ga1',
  chat_messages: [
    msg('gh1', null, 'human', 10, [{ type: 'text', text: 'pages' }]),
    msg('ga1', 'gh1', 'assistant', 11, [
      { type: 'text', text: 'Made.' },
      cf('g1', out('fluid.html'), FLUID), cf('g2', out('wide.html'), WIDE), cf('g3', out('scripted.svg'), SCRIPTED), cf('g4', out('spoof.html'), SPOOF),
    ]),
  ],
};

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zoom-'));
  const file = path.join(dir, 'viewer.html');
  fs.writeFileSync(path.join(dir, VIEWER_CHECK_FILE), Buffer.from(VIEWER_CHECK_BASE64, 'base64'));
  fs.mkdirSync(path.join(dir, 'images'));
  const saved = {};
  for (const n of [1, 2, 3]) { fs.writeFileSync(path.join(dir, 'images', `k${n}_Picture.png`), n === 1 ? BIG : SMALL); saved[`https://img.example/${n}.png`] = `images/k${n}_Picture.png`; }
  const index = {};
  const artifacts = core.extractArtifacts(chat, null, index);
  const pIndex = {};
  const pArtifacts = core.extractArtifacts(panelChat, null, pIndex);
  const gIndex = {};
  const gArtifacts = core.extractArtifacts(pageChat, null, gIndex);
  // A picture Claude made: its bytes are in artefacts/, so it has no text.
  pArtifacts['pic.png'] = '';
  pIndex['/mnt/user-data/outputs/pic.png'] = { path: '/mnt/user-data/outputs/pic.png', filename: 'pic.png', versions: ['pic.png'], messages: ['pa1'] };
  fs.mkdirSync(path.join(dir, 'artefacts'));
  fs.writeFileSync(path.join(dir, 'artefacts', 'pic.png'), BIG);
  fs.mkdirSync(path.join(dir, 'uploads'));
  fs.writeFileSync(path.join(dir, 'uploads', 'p02_photo.png'), PHOTO);
  fs.writeFileSync(file, buildHtml([chat, panelChat, pageChat], '2026-11-15T12:00:00Z', c => (c.uuid === 'p'
    ? { folder: '', artifacts: pArtifacts, artifactIndex: pIndex, uploads: { 'u-png': { path: 'uploads/p02_photo.png', text: null } } }
    : c.uuid === 'g' ? { folder: '', artifacts: gArtifacts, artifactIndex: gIndex }
    : { webImages: saved, artifacts, artifactIndex: index, widgetFile: core.widgetFile, widgetKey: core.widgetKey })));
  const browser = await chromium.launch({ executablePath: process.env.CHROME_EXE });
  let failed = 0;
  const check = (n, ok, x = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n} ${ok ? '' : x}`); };
  const page = await (await browser.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const logs = [];
  page.on('console', m => logs.push(m.text()));
  // Every size report the viewer's window receives, accepted or not.
  await page.addInitScript(() => {
    window.__sizes = [];
    window.addEventListener('message', e => { if (e.data && e.data.type === 'ct-size') window.__sizes.push(e.data); });
  });
  const requests = [];
  await page.route('**/*', r => { const u = r.request().url(); if (u.startsWith('file:')) return r.continue(); requests.push(u); return r.abort(); });
  await page.goto('file://' + file + '#chat=z');
  await page.waitForSelector('.msg');

  const level = () => page.locator('.gallery-pop .zoom-level').textContent().catch(() => null);
  const pct = async () => parseFloat(await level());
  // The Fit zoom of the shown picture, from the stage's content box.
  const fitOf = (w, h) => page.evaluate(([w, h]) => {
    const s = document.querySelector('.gallery-stage');
    const cs = getComputedStyle(s);
    const aw = s.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const ah = s.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    return Math.min(1, aw / w, ah / h);
  }, [w, h]);
  const imgBox = () => page.locator('.gallery-stage img').evaluate(i => { const r = i.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
  const scroll = () => page.locator('.gallery-stage').evaluate(s => ({ left: s.scrollLeft, top: s.scrollTop }));
  const settle = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));

  await page.locator('.web-mosaic .tile').first().click();
  await page.waitForSelector('.gallery-stage img');
  await page.locator('.gallery-stage img').evaluate(i => i.complete && i.naturalWidth ? 0 : new Promise(r => i.addEventListener('load', r)));
  await settle();
  const fit = await fitOf(2000, 1000);
  const stageW = await page.locator('.gallery-stage').evaluate(s => s.clientWidth);
  let box = await imgBox();
  check('gallery: opens at Fit', box.w <= stageW && Math.abs(box.w - 2000 * fit) < 1.5 && (await level()) === `${Math.round(fit * 100)}%`, `${box.w} ${stageW} ${await level()} fit ${fit}`);

  const slow = await page.evaluate(() => new Promise(done => {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:0;top:0;width:400px;height:300px;display:flex;flex-direction:column';
    const b = document.createElement('div');
    b.style.cssText = 'flex:1;min-height:0';
    host.append(b);
    document.body.append(host);
    const i = document.createElement('img');
    b.append(i);
    let c;
    try { c = pictureZoom(b, i); } catch (e) { done({ error: e.message }); return; }
    i.addEventListener('load', () => requestAnimationFrame(() => {
      const w = i.getBoundingClientRect().width;
      const text = host.querySelector('.zoom-level') && host.querySelector('.zoom-level').textContent;
      c.destroy(); host.remove();
      done({ w, text });
    }));
    i.src = document.querySelector('.gallery-stage img').src;
  }));
  check('gallery: picture fits after a slow load', !slow.error && Number.isFinite(slow.w) && slow.w > 0 && slow.text && !/NaN/.test(slow.text), JSON.stringify(slow));

  // A point on the picture, 30% across and 40% down; after the wheel it should stay under the pointer.
  box = await imgBox();
  const px = box.x + box.w * 0.3, py = box.y + box.h * 0.4;
  await page.mouse.move(px, py);
  await page.mouse.wheel(0, -300);
  await settle();
  const after = await imgBox();
  const nx = after.x + after.w * 0.3, ny = after.y + after.h * 0.4;
  check('gallery: plain wheel zooms about the pointer', (await pct()) > Math.round(fit * 100) && Math.hypot(nx - px, ny - py) < 3, `${await level()} moved ${Math.hypot(nx - px, ny - py)}`);

  const before = await scroll();
  await page.mouse.move(600, 450);
  await page.mouse.down();
  for (let k = 1; k <= 6; k++) await page.mouse.move(600 - k * 10, 450);
  await page.mouse.up();
  await settle();
  const moved = await scroll();
  check('gallery: drag pans and doesn\'t close', Math.abs(moved.left - before.left) > 30 && await page.locator('.veil.gallery').count() === 1, `${before.left} -> ${moved.left}`);

  const cancelled = await page.locator('.gallery-stage').evaluate(s => {
    const o = { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1, clientX: 500, clientY: 400 };
    s.dispatchEvent(new PointerEvent('pointerdown', o));
    s.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: 470 }));
    s.dispatchEvent(new PointerEvent('pointercancel', o));
    return s.classList.contains('dragging');
  });
  await page.keyboard.press('0');
  await settle();
  await page.mouse.click(8, 300);
  check('gallery: pointercancel ends a drag', !cancelled && await page.locator('.veil.gallery').count() === 0, `dragging ${cancelled}, open ${await page.locator('.veil.gallery').count()}`);

  await page.locator('.web-mosaic .tile').first().click();
  await page.waitForSelector('.gallery-pop .zoom-level', { state: 'attached' });
  await settle();
  box = await imgBox();
  await page.mouse.dblclick(box.x + box.w / 2, box.y + box.h / 2);
  await settle();
  const at100 = await level();
  box = await imgBox();
  await page.mouse.dblclick(600, 400);
  await settle();
  check('gallery: double-click toggles Fit/100%', at100 === '100%' && (await level()) === `${Math.round(fit * 100)}%`, `${at100} then ${await level()}`);

  const seen = [];
  for (const k of ['+', '-', '-', '0', '1', '=']) { await page.keyboard.press(k); seen.push(await level()); }
  const fitPct = `${Math.round(fit * 100)}%`;
  const up = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1].find(s => s > fit + 1e-6);
  const down = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1].filter(s => s < up - 1e-6).pop();
  const down2 = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1].filter(s => s < down - 1e-6).pop();
  const want = [`${Math.round(up * 100)}%`, `${Math.round(down * 100)}%`, `${Math.round(down2 * 100)}%`, fitPct, '100%', '125%'];
  check('gallery: + - 0 1 keys', seen.join() === want.join(), `${seen.join()} want ${want.join()}`);

  await page.keyboard.press('ArrowRight');
  const pos2 = await page.locator('.gallery-nav .pos').textContent();
  await page.keyboard.press('ArrowLeft');
  await settle();
  const back = await level();
  const pos1 = await page.locator('.gallery-nav .pos').textContent();
  await page.keyboard.press('Escape');
  check('gallery: Right resets to Fit; Left/Right still change picture; Escape closes', pos2 === '2 of 3' && pos1 === '1 of 3' && back === fitPct && await page.locator('.veil.gallery').count() === 0, `${pos2} ${pos1} ${back}`);

  // At the last picture Next is disabled: Tab from Previous, the last stop that can take focus, wraps to Close.
  await page.locator('.web-mosaic .tile').first().click();
  await page.waitForSelector('.gallery-pop .zoom-level', { state: 'attached' });
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.locator('.gallery-nav .prev').focus();
  // A dispatched Tab moves nothing by itself, so only the trap can take focus to Close.
  const wrapped = await page.evaluate(() => {
    const e = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    document.activeElement.dispatchEvent(e);
    return e.defaultPrevented && !!document.activeElement && document.activeElement.matches('.gallery-pop > .close');
  });
  const nextOff = await page.locator('.gallery-nav .next').isDisabled();
  await page.keyboard.press('Escape');
  check('gallery: Tab skips a disabled last button and wraps', nextOff && wrapped, `next disabled ${nextOff}, wrapped ${wrapped}`);

  const diagram = page.locator('figure.diagram');
  const opener = diagram.locator('button.diagram-open');
  await opener.focus().catch(() => {});
  await page.keyboard.press('Enter');
  await settle();
  const pop = page.locator('.gallery-pop');
  const dfit = await fitOf(1600, 1200).catch(() => 0);
  check('diagram: Enter on it opens a one-item gallery labelled Diagram, no prev/next',
    await opener.count() === 1 && (await opener.getAttribute('aria-label')) === 'Open plan larger'
    && await pop.count() === 1 && (await pop.getAttribute('aria-label')) === 'Diagram'
    && await page.locator('.gallery-nav').isHidden() && (await page.locator('.gallery-info').textContent()) === 'plan'
    && (await level()) === `${Math.round(dfit * 100)}%`,
    `${await pop.count()} ${await level()} ${dfit}`);
  await page.keyboard.press('ArrowRight');
  check('diagram: Left/Right do nothing in a one-item gallery', await pop.count() === 1 && await page.locator('.gallery-stage img').count() === 1);
  await page.keyboard.press('Escape');
  check('diagram: Escape returns focus to the diagram', await page.locator('.veil.gallery').count() === 0 && await page.evaluate(() => document.activeElement && document.activeElement.classList.contains('diagram-open')));
  await diagram.hover();
  await diagram.locator('.diagram-more').click();
  check('diagram: the … menu doesn\'t open the gallery', await page.locator('.veil.gallery').count() === 0 && await diagram.locator('.diagram-menu').isVisible());

  // ---- The side panel and the upload popup ----
  await page.goto('file://' + file + '#chat=p');
  await page.waitForSelector('.msg');
  const plevel = () => page.locator('#panel-body .zoom-level').textContent().catch(() => null);
  const pbox = page.locator('#panel-body .zoom-box');
  const pimg = page.locator('#panel-body .zoom-box img');
  // The Fit zoom of a picture of that size in the panel's picture area.
  const panelFit = (w, h) => pbox.evaluate((b, [w, h]) => {
    const cs = getComputedStyle(b);
    const aw = b.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const ah = b.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    return Math.min(1, aw / w, ah / h);
  }, [w, h]).catch(() => -1);
  const openCard = async (name, n = 0) => {
    await page.locator('.art', { hasText: name }).nth(n).click();
    await page.waitForSelector('#panel:not([hidden])');
  };
  const loaded = async () => {
    await pimg.waitFor({ state: 'attached', timeout: 3000 }).catch(() => {});
    await pimg.evaluate(i => (i.complete ? 0 : new Promise(r => { i.addEventListener('load', r); i.addEventListener('error', r); }))).catch(() => {});
    await settle();
  };

  await openCard('pic.png');
  await loaded();
  await pbox.focus().catch(() => {});
  await page.keyboard.press('1');
  await settle();
  const pb = await pbox.boundingBox().catch(() => null);
  if (pb) await page.mouse.move(pb.x + pb.width / 2, pb.y + pb.height / 2);
  const top0 = await pbox.evaluate(b => b.scrollTop).catch(() => -1);
  await page.mouse.wheel(0, 200);
  await settle();
  const top1 = await pbox.evaluate(b => b.scrollTop).catch(() => -1);
  check('panel image: plain wheel scrolls the panel, doesn\'t zoom', top0 >= 0 && top1 > top0 && (await plevel()) === '100%', `${top0} -> ${top1} at ${await plevel()}`);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -200);
  await page.keyboard.up('Control');
  await settle();
  check('panel image: Ctrl+wheel zooms', parseFloat(await plevel()) > 100, await plevel());

  const shownLater = await page.evaluate(src => new Promise(done => {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:0;top:0;width:300px;height:200px;display:none;flex-direction:column';
    const b = document.createElement('div');
    b.style.cssText = 'flex:1;min-height:0';
    host.append(b);
    document.body.append(host);
    const i = document.createElement('img');
    i.onload = () => {
      let c;
      try { c = pictureZoom(b, i); } catch (e) { done({ error: e.message }); return; }
      host.style.display = 'flex';
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const w = i.getBoundingClientRect().width, bw = b.clientWidth;
        const text = host.querySelector('.zoom-level').textContent;
        c.destroy(); host.remove();
        done({ w, bw, text });
      }));
    };
    b.append(i);
    i.src = src;
  }), await pimg.getAttribute('src', { timeout: 3000 }).catch(() => ''));
  check('panel image: refits after the panel is shown', !shownLater.error && Number.isFinite(shownLater.w) && shownLater.w > 0 && shownLater.w <= shownLater.bw && !/NaN/.test(shownLater.text), JSON.stringify(shownLater));

  await openCard('chart.svg', 0);
  await loaded();
  const src = await pimg.getAttribute('src', { timeout: 3000 }).catch(() => '');
  check('panel svg: shown as <img>', /^data:image\/svg\+xml/.test(src || '') && await page.locator('#panel-body iframe').count() === 0, `${src && src.slice(0, 40)} frames ${await page.locator('#panel-body iframe').count()}`);
  await pbox.focus().catch(() => {});
  await page.keyboard.press('1');
  await page.keyboard.press('+');
  await settle();
  const z1 = await plevel();
  await page.locator('#panel-head .ver', { hasText: 'v2' }).click();
  await loaded();
  const z2 = await plevel();
  const v2src = await pimg.getAttribute('src', { timeout: 3000 }).catch(() => '');
  check('panel svg: version switch keeps the zoom (percentage)', z1 === '125%' && z2 === '125%' && v2src !== src && /^data:image\/svg\+xml/.test(v2src || ''), `${z1} -> ${z2}`);

  await openCard('pct.svg');
  await loaded();
  const pctFit = await panelFit(900, 600);
  const pctStart = await plevel();
  await pbox.focus().catch(() => {});
  await page.keyboard.press('1');
  await settle();
  const pctW = await pimg.evaluate(i => i.getBoundingClientRect().width).catch(() => -1);
  check('panel: another file resets to Fit', pctStart === `${Math.round(pctFit * 100)}%`, `${pctStart} fit ${pctFit}`);
  check('panel svg: width="100%" uses the viewBox', Math.abs(pctW - 900) < 1 && (await plevel()) === '100%', `${pctW}`);
  await openCard('chart.svg', 1);
  await loaded();
  const backFit = await panelFit(800, 600);
  check('panel: back to a file shown before starts at Fit', (await plevel()) === `${Math.round(backFit * 100)}%`, `${await plevel()} fit ${backFit}`);

  for (const [name, label] of [['bare.svg', 'no xmlns'], ['nbsp.svg', '&nbsp;']]) {
    await openCard(name);
    const frame = await page.waitForSelector('#panel-body iframe.preview', { timeout: 3000 }).catch(() => null);
    const srcdoc = frame ? await frame.getAttribute('srcdoc') : '';
    const sandbox = frame ? await frame.getAttribute('sandbox') : '';
    check(`panel svg: ${label} falls back to the frame`, !!frame && sandbox === 'allow-scripts' && srcdoc.includes('<svg') && await page.locator('#panel-body .zoom-box').count() === 0,
      `frame ${!!frame} boxes ${await page.locator('#panel-body .zoom-box').count()}`);
  }

  await openCard('huge.svg');
  await loaded();
  await pbox.focus().catch(() => {});
  let biggest = 0;
  for (let k = 0; k < 20; k++) {
    await page.keyboard.press('+');
    const r = await pimg.evaluate(i => ({ w: parseFloat(i.style.width), h: parseFloat(i.style.height) })).catch(() => ({ w: Infinity, h: 0 }));
    biggest = Math.max(biggest, r.w, r.h);
  }
  check('huge SVG: + stops at the cap', biggest > 0 && biggest <= 32768, `${biggest}`);

  await page.locator('#panel-head .close').click();
  await page.locator('.chip', { hasText: 'photo.png' }).click();
  const popImg = page.locator('.pop .zoom-box img');
  await popImg.waitFor({ state: 'attached', timeout: 3000 }).catch(() => {});
  await popImg.evaluate(i => (i.complete ? 0 : new Promise(r => i.addEventListener('load', r)))).catch(() => {});
  await settle();
  let reached = false, left = false;
  for (let k = 0; k < 8 && !reached; k++) {
    await page.keyboard.press('Tab');
    const where = await page.evaluate(() => ({ box: !!document.activeElement.closest('.pop .zoom-box') && document.activeElement.classList.contains('zoom-box'), inside: !!document.activeElement.closest('.pop') }));
    reached = where.box;
    if (!where.inside) left = true;
  }
  await page.keyboard.press('1');
  await page.keyboard.press('+');
  const popLevel = await page.locator('.pop .zoom-level').textContent().catch(() => null);
  check('upload popup: the picture zooms; Tab reaches the picture area', reached && !left && popLevel === '125%', `reached ${reached} left ${left} level ${popLevel}`);
  await page.keyboard.press('Escape');
  check('upload popup: Escape closes', await page.locator('.veil').count() === 0);


  // ---- Pages in the side panel ----
  await page.goto('file://' + file + '#chat=g');
  await page.waitForSelector('.msg');
  const glevel = () => page.locator('#panel-body .page-zoom .zoom-level').textContent({ timeout: 3000 }).catch(() => null);
  const gframe = page.locator('#panel-body .page-zoom iframe.preview');
  const scaleOf = () => gframe.evaluate(f => { const t = getComputedStyle(f).transform; if (!t || t === 'none') return 1; return parseFloat(t.slice(t.indexOf('(') + 1)); }).catch(() => -1);
  const sizes = () => page.evaluate(() => window.__sizes.length);
  // Waits for the shown page to report its size (a report after `from` reports), then a frame.
  const reported = async (from, pred = () => true) => {
    await page.waitForFunction(n => window.__sizes.length > n, from, { timeout: 3000 }).catch(() => {});
    await settle();
  };
  const fitBtn = page.locator('#panel-body .page-zoom .zoom-fit');
  const bar = page.locator('#panel-body .page-zoom .zoom-bar');

  let n0 = await sizes();
  await openCard('fluid.html');
  await reported(n0);
  const start = await glevel();
  const s0 = await scaleOf();
  await page.locator('#panel-body .page-zoom .zoom-in').click({ timeout: 3000 }).catch(() => {});
  await settle();
  const in1 = await glevel(), s1 = await scaleOf();
  const geo = await page.locator('#panel-body .page-zoom').evaluate(w => { const f = w.querySelector('iframe'); return { ww: w.clientWidth, fw: f.offsetWidth }; }).catch(() => ({}));
  await page.locator('#panel-body .page-zoom .zoom-out').click({ timeout: 3000 }).catch(() => {});
  await page.locator('#panel-body .page-zoom .zoom-out').click({ timeout: 3000 }).catch(() => {});
  await settle();
  const out2 = await glevel(), s2 = await scaleOf();
  check('page: starts at 100%, + and − change the frame\'s scale',
    start === '100%' && Math.abs(s0 - 1) < 1e-3 && in1 === '125%' && Math.abs(s1 - 1.25) < 1e-3 && Math.abs(geo.fw - geo.ww / 1.25) < 1.5 && out2 === '90%' && Math.abs(s2 - 0.9) < 1e-3,
    `${start} ${s0} | ${in1} ${s1} ${JSON.stringify(geo)} | ${out2} ${s2}`);
  check('page: fluid page has Fit width disabled', await fitBtn.count() === 1 && await fitBtn.isDisabled({ timeout: 3000 }).catch(() => null), `count ${await fitBtn.count()}`);

  // Clicks inside the page still reach it: at 150% the button is where the scale puts it.
  await bar.focus().catch(() => {});
  await page.locator('#panel-body .page-zoom .zoom-100').focus().catch(() => {});
  await page.keyboard.press('1');
  await page.keyboard.press('+');
  await page.keyboard.press('+');
  await settle();
  const at150 = await glevel();
  const fb = await gframe.boundingBox().catch(() => null);
  const bb = await page.frameLocator('#panel-body .page-zoom iframe.preview').locator('#b').evaluate(b => { const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }).catch(() => null);
  if (fb && bb) await page.mouse.click(fb.x + bb.x * 1.5, fb.y + bb.y * 1.5);
  await page.waitForTimeout(200);
  check('page: clicks inside the page still reach it', at150 === '150%' && logs.includes('fluid-click'), `${at150} ${!!fb} ${!!bb} logs ${logs.join(',')}`);

  n0 = await sizes();
  await openCard('wide.html');
  await reported(n0);
  await page.waitForFunction(() => { const b = document.querySelector('#panel-body .page-zoom .zoom-fit'); return b && !b.disabled; }, null, { timeout: 3000 }).catch(() => {});
  const wideStart = await glevel();
  const enabled = await fitBtn.isEnabled({ timeout: 3000 }).catch(() => null).catch(() => false);
  await fitBtn.click({ timeout: 3000 }).catch(() => {});
  await settle();
  const cw = await page.locator('#panel-body .page-zoom').evaluate(w => w.clientWidth).catch(() => 0);
  const wfit = Math.min(1, Math.max(0.25, cw / 1600));
  const ws = await scaleOf();
  await page.waitForTimeout(300);
  check('page: wide page\'s Fit width zooms to container ÷ 1600',
    wideStart === '100%' && enabled && Math.abs(ws - wfit) < 1e-3 && (await glevel()) === `${Math.round(wfit * 100)}%` && await fitBtn.isEnabled({ timeout: 3000 }).catch(() => null),
    `start ${wideStart} enabled ${enabled} scale ${ws} want ${wfit} level ${await glevel()} still ${await fitBtn.isEnabled({ timeout: 3000 }).catch(() => null)}`);
  await page.locator('#panel-body .page-zoom .zoom-100').click({ timeout: 3000 }).catch(() => {});
  await settle();
  check('page: Actual size goes back to 100%', (await glevel()) === '100%' && Math.abs((await scaleOf()) - 1) < 1e-3, await glevel());
  await bar.locator('.zoom-in').focus().catch(() => {});
  await page.keyboard.press('0');
  await settle();
  check('page: 0 is Fit width when enabled', (await glevel()) === `${Math.round(wfit * 100)}%`, await glevel());
  // The bar has its own strip below the frame, also at phone width.
  const strip = async () => page.locator('#panel-body .page-zoom').evaluate(w => {
    const f = w.querySelector(':scope > iframe').getBoundingClientRect(), b = w.querySelector(':scope > .zoom-bar').getBoundingClientRect(), r = w.getBoundingClientRect();
    return { below: b.top >= f.bottom - 0.5, inside: b.left >= r.left - 0.5 && b.right <= r.right + 0.5 && b.bottom <= r.bottom + 0.5, fits: b.right <= innerWidth + 0.5 };
  }).catch(() => ({}));
  const wideStrip = await strip();
  await page.setViewportSize({ width: 375, height: 700 });
  await settle();
  const phoneStrip = await strip();
  await page.setViewportSize({ width: 1200, height: 900 });
  await settle();
  check('page: the bar sits in its own strip below the frame, also at phone width', wideStrip.below && wideStrip.inside && phoneStrip.below && phoneStrip.inside && phoneStrip.fits, JSON.stringify([wideStrip, phoneStrip]));

  await openCard('spoof.html');
  await page.waitForFunction(() => window.__sizes.some(s => s.width === 99999), null, { timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(800);
  const spoofed = await page.evaluate(() => window.__sizes.some(s => s.width === 99999));
  check('page: a message from another window is ignored', spoofed && await fitBtn.count() === 1 && await fitBtn.isDisabled({ timeout: 3000 }).catch(() => null) && (await glevel()) === '100%', `posted ${spoofed} disabled ${await fitBtn.isDisabled({ timeout: 3000 }).catch(() => null).catch(() => null)} ${await glevel()}`);

  await openCard('scripted.svg');
  await gframe.waitFor({ state: 'attached', timeout: 3000 }).catch(() => {});
  check('page: scripted SVG stays a frame with the page bar',
    await gframe.count() === 1 && (await gframe.getAttribute("sandbox", { timeout: 3000 }).catch(() => null)) === 'allow-scripts' && await page.locator('#panel-body .zoom-box').count() === 0 && (await glevel()) === '100%',
    `frames ${await gframe.count()} level ${await glevel()}`);

  await page.goto('file://' + file + '#chat=p');
  await page.waitForSelector('.msg');
  await openCard('bare.svg');
  await gframe.waitFor({ state: 'attached', timeout: 3000 }).catch(() => {});
  await page.locator('#panel-body .page-zoom .zoom-in').click({ timeout: 3000 }).catch(() => {});
  await settle();
  check('page: SVG fallback (no xmlns) gets the page bar', await gframe.count() === 1 && (await glevel()) === '125%' && Math.abs((await scaleOf()) - 1.25) < 1e-3, `frames ${await gframe.count()} level ${await glevel()}`);

  check('no network requests', requests.length === 0, requests.join());
  check('no page errors', errors.length === 0, errors.join(' | '));

  await browser.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e.message); process.exit(1); });
