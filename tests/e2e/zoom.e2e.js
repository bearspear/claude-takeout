// Zoom and pan in the chat viewer over file:// in Chromium: the gallery opens a picture at Fit, a plain
// wheel zooms about the pointer, a drag pans without closing, double-click and keys, and an inline
// diagram opens as a one-item gallery.
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

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zoom-'));
  const file = path.join(dir, 'viewer.html');
  fs.writeFileSync(path.join(dir, VIEWER_CHECK_FILE), Buffer.from(VIEWER_CHECK_BASE64, 'base64'));
  fs.mkdirSync(path.join(dir, 'images'));
  const saved = {};
  for (const n of [1, 2, 3]) { fs.writeFileSync(path.join(dir, 'images', `k${n}_Picture.png`), n === 1 ? BIG : SMALL); saved[`https://img.example/${n}.png`] = `images/k${n}_Picture.png`; }
  const index = {};
  const artifacts = core.extractArtifacts(chat, null, index);
  fs.writeFileSync(file, buildHtml([chat], '2026-11-15T12:00:00Z', () => ({ webImages: saved, artifacts, artifactIndex: index, widgetFile: core.widgetFile, widgetKey: core.widgetKey })));
  const browser = await chromium.launch({ executablePath: process.env.CHROME_EXE });
  let failed = 0;
  const check = (n, ok, x = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n} ${ok ? '' : x}`); };
  const page = await (await browser.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
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

  check('no network requests', requests.length === 0, requests.join());
  check('no page errors', errors.length === 0, errors.join(' | '));

  await browser.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e.message); process.exit(1); });
