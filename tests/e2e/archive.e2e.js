// The "Archive files" section over file:// in Chromium, on a viewer the real tool builds for a synthetic archive.
// SHOT_DIR=<dir> also saves screenshots.
const { chromium } = require(process.env.PW);
const { execFileSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const { buildHtml } = require('./make-viewer.js');
const { HIT, ATTACK_ENDS, ATTACKS, hostileHtml, NAV_PAGES } = require('./hostile.js');
const { OPENABLE_EXTENSIONS } = require('../../viewer/viewer-logic.js');
const { REPO } = require('../helpers');
const { VIEWER_CHECK_BASE64, TEXT_EMBED_LIMIT } = require('../../takeout-viewer.js');

const TOOL = path.join(REPO, 'tools', 'build_viewer.js');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mNkYPhfz0AEYBxVSF+FAAhKDveksOjmAAAAAElFTkSuQmCC', 'base64');
const PDF = '%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n';
const MARKER = 'ADDED-TEXT-STAYS-OUT-OF-THE-VIEWER';
const ESCAPE_HTML = "<!doctype html><script>console.log('ESCAPED');fetch('https://remote.test/escaped')<\/script>";
const RUNS = "console.log('EVIL ran')";
const XHTML = `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><script>${RUNS}</script></body></html>`;
const HTML = `<!doctype html><html><body><script>${RUNS}</script></body></html>`;
const BAD_NAME = `x"><img src=x onerror=${HIT}>.md`;
const NOTES = `## Notes from ${MARKER}\n\nThe **variance** is $x^2$, for Gödel.\n\n<script>${HIT}</script>\n\n<img src=x onerror="${HIT}">\n\n![remote](https://remote.test/md.png)\n\n\`\`\`python\nprint("hi")\n\`\`\`\n`;
const BULK = 1000;
// An upload large enough for its text to move into a part of its own, after the added-file parts.
const UPLOAD_MARKER = 'UPLOAD-TEXT-IN-A-PART';
const BIG_UPLOAD = `# ${UPLOAD_MARKER}\n` + 'upload line\n'.repeat(8000);

function wav() {
  const rate = 8000, samples = 4000;
  const b = Buffer.alloc(44 + samples, 128);
  b.write('RIFF', 0); b.writeUInt32LE(36 + samples, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write('data', 36); b.writeUInt32LE(samples, 40);
  return b;
}

const put = (root, rel, data) => {
  const p = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
};

const chatJson = (uuid, name, updated, uploads = []) => JSON.stringify({
  uuid, name, created_at: '2026-01-01T00:00:00Z', updated_at: updated, model: 'claude-x', settings: {},
  chat_messages: [
    { uuid: `${uuid}-1`, sender: 'human', created_at: '2026-01-01T00:00:00Z', content: [{ type: 'text', text: `hello from ${name}` }], parent_message_uuid: null, files_v2: uploads },
    { uuid: `${uuid}-2`, sender: 'assistant', created_at: '2026-01-01T00:00:01Z', content: [{ type: 'text', text: 'hi' }], parent_message_uuid: `${uuid}-1` },
  ],
  current_leaf_message_uuid: `${uuid}-2`,
});

// A mega archive with two chats. Added: at its root, in chat-one and in chat-two.
function makeArchive(root, attacks) {
  put(root, 'index.md', '# Index');
  put(root, 'chat-one/original.json', chatJson('c1', 'First chat', '2026-03-01T00:00:00Z'));
  put(root, 'chat-one/README.md', 'readme');
  put(root, 'chat-two/original.json', chatJson('c2', 'Second chat', '2026-02-01T00:00:00Z', [{ file_uuid: 'up-big', file_name: 'big.md', success: true }]));
  put(root, 'chat-two/uploads/big.md', BIG_UPLOAD);

  put(root, '_index.md', '# Archive index\n\nEverything added by hand.');
  for (let i = 0; i < BULK; i++) put(root, `bulk/f${String(i).padStart(4, '0')}.md`, `note ${i}`);

  put(root, 'chat-one/synthesis/notes.md', NOTES);
  put(root, 'chat-one/synthesis/nested/deep/leaf.md', '# Leaf');
  put(root, 'chat-one/synthesis/script.py', `print("<b>code</b>")\n`);
  put(root, `chat-one/synthesis/${BAD_NAME}`, 'name test');
  put(root, 'chat-one/synthesis/hostile.html', hostileHtml(attacks));
  put(root, 'chat-one/synthesis/drawing.svg', `<svg xmlns="http://www.w3.org/2000/svg"><script>console.log('SVG ran')</script><text>svg</text></svg>`);
  put(root, 'chat-one/media/photo.png', PNG);
  put(root, 'chat-one/media/paper.pdf', Buffer.from(PDF, 'latin1'));
  put(root, 'chat-one/media/talk.wav', wav());
  put(root, 'chat-one/media/clip.mp4', 'not really a video');
  put(root, 'chat-one/media/odd.bmp', 'BM');
  put(root, 'chat-one/media/page.xml.zip', 'PK');
  put(root, 'chat-one/media/NOEXT', 'plain');
  put(root, 'chat-one/media/bad.m4a', 'not really audio');
  put(root, 'chat-one/unsafe/evil.xbl', XHTML);
  put(root, 'chat-one/unsafe/evil.rtf', HTML);
  put(root, 'chat-one/synthesis/plain.markdown', '# Long extension\n\n**bold**');
  put(root, 'chat-one/synthesis/flow.mmd', 'graph TD; A-->B');
  for (const nav of NAV_PAGES) put(root, `chat-one/nav/${nav.name}`, nav.versions[0]);
  put(root, 'chat-one/large/huge.html', ESCAPE_HTML + ' '.repeat(TEXT_EMBED_LIMIT + 10));
  put(root, 'chat-one/large/huge.md', '# Too much\n' + 'x'.repeat(TEXT_EMBED_LIMIT + 10));
  put(root, 'chat-one/large/huge.py', '#'.repeat(TEXT_EMBED_LIMIT + 10));
  put(root, 'chat-one/large/huge.txt', HTML + ' '.repeat(TEXT_EMBED_LIMIT + 10));
  // Three bodies that can't share a 4 MB part.
  for (const n of [1, 2, 3]) put(root, `chat-one/parts/block${n}.md`, `# Block ${n}\n\n` + 'word '.repeat(330000));

  put(root, 'chat-two/only-two.md', '# Second chat only');
}

const CHAT_ONE_FILES = 19 + 6 + NAV_PAGES.length, CHAT_TWO_FILES = 1, SHARED_FILES = 1 + BULK;

function runTool(folder) {
  return JSON.parse(execFileSync(process.execPath, [TOOL, folder, '--json'], { encoding: 'utf8', maxBuffer: 1 << 26 }));
}

function viewerDataOf(file) {
  const html = fs.readFileSync(file, 'utf8');
  return JSON.parse(/<script id="data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1]);
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'takeout-archive-'));
  const browser = await chromium.launch({ executablePath: process.env.CHROME_EXE });
  let failed = 0;
  const check = (n, ok, x = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n} ${ok ? '' : x}`); };

  const open = async (target, options = {}) => {
    const { delay, ...contextOptions } = options;
    const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, ...contextOptions });
    const page = await context.newPage();
    page.setDefaultTimeout(4000);
    const seen = { requests: [], errors: [], pageErrors: [], logs: [], files: [] };
    await page.route('**/*', async r => {
      const u = r.request().url();
      if (u.startsWith('file:') || u.startsWith('data:')) {
        seen.files.push(u);
        if (delay && delay.match(u)) await new Promise(done => { delay.release = done; });
        return r.continue();
      }
      seen.requests.push(u);
      return r.abort();
    });
    page.on('console', m => { seen.logs.push(m.text()); if (m.type() === 'error') seen.errors.push(m.text()); });
    page.on('pageerror', e => { seen.errors.push(e.message); seen.pageErrors.push(e.message); });
    await page.goto(target);
    await page.waitForSelector('.msg');
    return { page, seen, context };
  };
  const clean = (name, seen) => {
    check(`${name}: zero network requests`, seen.requests.length === 0, seen.requests.join());
    check(`${name}: zero console errors`, seen.errors.length === 0, seen.errors.join(' | '));
  };
  const waitLog = async (p, text) => {
    for (let i = 0; i < 80 && !p.seen.logs.some(l => l.includes(text)); i++) await p.page.waitForTimeout(50);
    return p.seen.logs.some(l => l.includes(text));
  };
  // The route holding a delayed file, once it has been reached. Call the result to let the file through.
  const held = async delay => {
    for (let i = 0; i < 80 && !delay.release; i++) await new Promise(done => setTimeout(done, 25));
    return delay.release;
  };
  const hash = p => p.page.evaluate(() => location.hash);
  const panelTitle = p => p.page.textContent('#panel .panel-title');
  const panelText = p => p.page.textContent('#panel-body');
  const tabs = p => p.page.$$eval('#panel .tab', b => b.map(x => x.textContent));
  const frameIn = async p => (await p.page.waitForSelector('#panel iframe', { state: 'attached' })).contentFrame();

  const openFold = async p => {
    if (!(await p.page.$eval('details.archive-files', d => d.open))) await p.page.click('details.archive-files > summary');
    await p.page.waitForSelector('.add-filter');
  };
  // Through the filter, as a person would. name: the file's name.
  const openAdded = async (p, rel) => {
    await openFold(p);
    await p.page.fill('.add-filter', rel.split('/').pop());
    await p.page.click(`.add-results .add-file[title=${JSON.stringify(rel)}]`);
    await p.page.waitForSelector('#panel:not([hidden])');
  };

  try {
    const home = path.join(dir, 'in');
    const root = path.join(home, 'archive');
    const reach = {
      'part-script': `new Promise(done => { const s = document.createElement('script'); s.onload = () => done('REACHED'); s.onerror = () => done('blocked'); s.src = ${JSON.stringify('file://' + fs.realpathSync(dir) + '/in/archive/viewer-files/part-0001.js')}; document.head.append(s); })`,
      'file-audio': `new Promise(done => { const a = new Audio(); a.onloadedmetadata = () => done('REACHED'); a.onerror = () => done('blocked'); a.src = ${JSON.stringify('file://' + fs.realpathSync(dir) + '/in/archive/chat-one/media/talk.wav')}; })`,
      'archive-part': "(parent.__archivePart(1, {}), 'REACHED')",
    };
    const REACH_ENDS = { 'part-script': 'gave blocked', 'file-audio': 'gave blocked', 'archive-part': 'threw SecurityError' };
    makeArchive(root, { ...reach, ...ATTACKS });
    const report = runTool(root);
    const built = report.archives[0];
    check('the tool wrote the viewer', built.status === 'written', JSON.stringify(built).slice(0, 300));
    const viewer = path.join(root, 'viewer.html');
    const url = 'file://' + viewer;
    const data = viewerDataOf(viewer);
    const idOf = rel => { const i = data.added.findIndex(a => a.path === rel); if (i < 0) throw new Error(`no added file ${rel}`); return `x${i}`; };
    const partsMade = fs.readdirSync(path.join(root, 'viewer-files')).sort();
    check('the text needs several parts', partsMade.length >= 2, partsMade.join());

    // viewer.html stays small: added text is not in it
    const exportDir = path.join(dir, 'export');
    fs.mkdirSync(exportDir);
    const exportFile = path.join(exportDir, 'viewer.html');
    fs.writeFileSync(exportFile, buildHtml([JSON.parse(chatJson('e1', 'Export chat', '2026-01-01T00:00:00Z'))], '2026-11-05T12:00:00Z'));
    fs.writeFileSync(path.join(exportDir, 'viewer-check.gif'), Buffer.from(VIEWER_CHECK_BASE64, 'base64'));
    const htmlText = fs.readFileSync(viewer, 'utf8');
    const extra = fs.statSync(viewer).size - fs.statSync(exportFile).size;
    check('viewer.html is about the size of an export viewer', extra < 400 * 1024, `${extra} bytes over`);
    check('added text is not in viewer.html', !htmlText.includes(MARKER));
    check('upload text is not in viewer.html', !htmlText.includes(UPLOAD_MARKER));
    const lastPart = fs.readFileSync(path.join(root, 'viewer-files', partsMade[partsMade.length - 1]), 'utf8');
    check('the upload part comes after the added-file parts', lastPart.includes(UPLOAD_MARKER) && lastPart.includes('"u0"') && !lastPart.includes(MARKER), partsMade.join());
    check('added text is in a part', fs.readdirSync(path.join(root, 'viewer-files')).some(f => fs.readFileSync(path.join(root, 'viewer-files', f), 'utf8').includes(MARKER)));

    const main = await open(url);
    const { page } = main;
    const count = CHAT_ONE_FILES + SHARED_FILES;
    check('the open chat is the newest', (await page.textContent('#title')) === 'First chat');
    check('the fold counts the chat\'s view', (await page.textContent('details.archive-files > summary')) === `Archive files · ${count}`, await page.textContent('details.archive-files > summary'));
    check('the fold is closed by default', await page.$eval('details.archive-files', d => !d.open));
    check('the fold is the only section of this project-less chat', (await page.$$('#project > details')).length === 1);
    check('no row is built before the fold opens', (await page.$$('.add-file')).length === 0);
    check('no tree is built before the fold opens', (await page.$$('.archive-files details')).length === 0);

    let start = Date.now();
    await page.click('details.archive-files > summary');
    await page.waitForSelector('.add-tree');
    const openMs = Date.now() - start;
    check('the tree opens in under 1 s', openMs < 1000, `${openMs} ms`);
    const top = await page.$$eval('.add-tree > .add-level > details > summary', s => s.map(x => x.textContent));
    check('top level folders show, sorted', top.join() === 'bulk,chat-one', top.join());
    check('a root file shows at the top level', (await page.$$eval('.add-tree > .add-level > .add-file', r => r.map(x => x.textContent))).join() === '_index.md');
    check('a closed folder builds no rows', (await page.$$('.add-file')).length === 1, String((await page.$$('.add-file')).length));
    start = Date.now();
    await page.click('.add-tree details:has(> summary:has-text("bulk")) > summary');
    await page.waitForFunction(n => document.querySelectorAll('.add-file').length === n + 1, BULK);
    const folderMs = Date.now() - start;
    check('a folder of 1000 files opens in under 1 s', folderMs < 1000, `${folderMs} ms`);
    check('files sort in the folder', await page.$$eval('.add-tree details:has(> summary:has-text("bulk")) .add-file', r => r[0].textContent === 'f0000.md' && r[999].textContent === 'f0999.md'));

    await page.click('.add-tree details:has(> summary:has-text("chat-one")) > summary');
    await page.click('.add-tree details:has(> summary:has-text("synthesis")) > summary');
    await page.click('.add-tree details:has(> summary:has-text("nested")) > summary');
    await page.click('.add-tree details:has(> summary:has-text("deep")) > summary');
    check('folders nest as details', (await page.textContent('.add-tree details:has(> summary:has-text("deep")) .add-file')) === 'leaf.md');
    check('a hostile file name stays text', (await page.$$('#project img')).length === 0 && (await page.$$eval('.add-file', r => r.some(x => x.textContent.includes('<img src=x')))));

    // Filter finds a file 900 entries deep
    await page.fill('.add-filter', 'F0900');
    await page.waitForSelector('.add-results .add-file');
    check('the filter finds a file 900 entries in', (await page.$$eval('.add-results .add-file', r => r.map(x => x.textContent))).join() === 'bulk/f0900.md');
    check('the tree hides while filtering', await page.$eval('.add-tree', t => t.hidden));
    await page.fill('.add-filter', '.md');
    await page.waitForFunction(() => /^Showing first 200 of \d+$/.test((document.querySelector('.add-count') || {}).textContent));
    check('a filter shows 200 rows at most', (await page.$$('.add-results .add-file')).length === 200);
    check('and says so', (await page.textContent('.add-count')) === `Showing first 200 of ${SHARED_FILES + 7}`, await page.textContent('.add-count'));
    await page.fill('.add-filter', '<img');
    await page.waitForSelector('.add-results .add-file');
    check('filter text is literal', (await page.textContent('.add-count')) === '1 file' && !(await page.evaluate(() => !!window.__hit)), await page.textContent('.add-count'));
    await page.fill('.add-filter', '(');
    await page.waitForFunction(() => document.querySelector('.add-count').textContent === 'No matches');
    check('a filter is not a pattern', (await page.$$('.add-results .add-file')).length === 0);
    await page.fill('.add-filter', 'only-two');
    await page.waitForFunction(() => document.querySelector('.add-count').textContent === 'No matches');
    check('a filter stays in the chat\'s view', true);
    await page.fill('.add-filter', '');
    await page.waitForSelector('.add-tree:not([hidden])');
    check('clearing the filter brings back the tree, still open', await page.$eval('.add-tree details:has(> summary:has-text("deep"))', d => d.open));

    // .md renders in the panel through the sanitized pipeline
    await page.click('.add-tree details:has(> summary:has-text("synthesis")) > .add-level > .add-file[title$="notes.md"]');
    await page.waitForSelector('#panel-body .prose h2');
    check('an added .md opens in the panel', (await panelTitle(main)) === 'notes.md');
    check('the panel names the kind', (await page.textContent('#panel .panel-kind')) === 'Document · MD');
    check('it offers Preview and Code', (await tabs(main)).join() === 'Preview,Code');
    check('the hash carries the x id', (await hash(main)).includes(`file=${idOf('chat-one/synthesis/notes.md')}&version=0`), await hash(main));
    check('Markdown renders', (await page.textContent('#panel-body .prose h2')).includes(MARKER) && (await page.$$('#panel-body .prose strong')).length === 1);
    check('math and code render as in chat', (await page.$$('#panel-body .katex')).length === 1 && (await page.textContent('#panel-body .code-head span')) === 'python');
    check('non-ASCII text survives the part', (await panelText(main)).includes('Gödel'));
    check('the open row is marked', await page.$$eval('.add-file.on', r => r.length === 1 && r[0].title.endsWith('notes.md')));
    const prose = await page.textContent('#panel-body .prose');
    check('a hostile <script> stays literal', prose.includes(`<script>${HIT}</script>`), prose.slice(0, 200));
    check('hostile Markdown runs nothing and loads nothing', !(await page.evaluate(() => !!window.__hit)) && (await page.$$('#panel-body script, #panel-body img[src^="https"], #panel-body img[onerror]')).length === 0);
    await page.click('#panel .tab:has-text("Code")');
    check('Code shows the source', (await page.textContent('#panel .file-code')).includes(`<img src=x onerror="${HIT}">`));
    check('Code keeps the focus on its tab', await page.evaluate(() => document.activeElement.textContent === 'Code'));
    await page.click('#panel .close');
    await page.waitForSelector('#panel', { state: 'hidden' });
    check('closing clears the hash', !(await hash(main)).includes('file='));
    check('closing unmarks the row', (await page.$$('.add-file.on')).length === 0);
    check('closing puts the focus back on the row', await page.evaluate(() => document.activeElement.classList.contains('add-file')));

    // Code goes through textContent
    await openAdded(main, 'chat-one/synthesis/script.py');
    await page.waitForSelector('#panel .file-code');
    check('code shows in the panel', (await page.textContent('#panel .file-code')).includes('<b>code</b>') && (await tabs(main)).join() === 'Code');
    check('main flow: nothing ran', !(await page.evaluate(() => !!window.__hit)));
    await openAdded(main, `chat-one/synthesis/${BAD_NAME}`);
    await page.waitForSelector('#panel-body .prose');
    check('a hostile name stays text in the panel', (await panelTitle(main)) === BAD_NAME && (await page.$$('#panel-head img')).length === 0);

    // An image and a PDF open from relative paths
    await openAdded(main, 'chat-one/media/photo.png');
    await page.waitForSelector('#panel .file-image');
    await page.waitForFunction(() => document.querySelector('#panel .file-image').naturalWidth > 0);
    check('an image opens from a relative path', (await page.getAttribute('#panel .file-image', 'src')) === 'chat-one/media/photo.png');
    check('an image has no Copy', (await page.locator('#panel-head .copy').count()) === 0);
    await openAdded(main, 'chat-one/media/paper.pdf');
    const pdf = await page.$eval('#panel iframe', f => ({ sandboxed: f.hasAttribute('sandbox'), src: f.getAttribute('src'), srcdoc: f.hasAttribute('srcdoc') }));
    check('a PDF uses a plain frame from a relative path', !pdf.sandboxed && !pdf.srcdoc && pdf.src === 'chat-one/media/paper.pdf', JSON.stringify(pdf));

    await openAdded(main, 'chat-one/media/talk.wav');
    await page.waitForSelector('#panel audio');
    await page.waitForFunction(() => document.querySelector('#panel audio').readyState >= 1);
    const audio = await page.$eval('#panel audio', a => ({ controls: a.controls, auto: a.autoplay, paused: a.paused, src: a.getAttribute('src'), kids: a.children.length, duration: a.duration }));
    check('audio loads from a relative path, with controls and no autoplay', audio.controls && !audio.auto && audio.paused && audio.src === 'chat-one/media/talk.wav' && audio.duration > 0.4, JSON.stringify(audio));
    // Held back, so the element is there to look at before the fake file fails.
    const videoGate = { match: u => u.endsWith('/clip.mp4') };
    const film = await open(url, { delay: videoGate });
    await openAdded(film, 'chat-one/media/clip.mp4');
    await film.page.waitForSelector('#panel video');
    const video = await film.page.$eval('#panel video', v => ({ controls: v.controls, auto: v.autoplay, paused: v.paused, src: v.getAttribute('src') }));
    check('video has controls and no autoplay', video.controls && !video.auto && video.paused && video.src === 'chat-one/media/clip.mp4', JSON.stringify(video));
    (await held(videoGate))();
    await film.page.waitForSelector('#panel .file-details');
    const filmText = await film.page.textContent('#panel .file-details');
    check('a video that fails says so, with its path', filmText.includes("This file can't play here") && filmText.includes('chat-one/media/clip.mp4'), filmText);
    check('a video that fails leaves no player', (await film.page.$$('#panel video')).length === 0);
    check('a video that fails still links to the file', (await film.page.getAttribute('#panel .file-details a', 'href')) === 'chat-one/media/clip.mp4');
    await film.context.close();
    await openAdded(main, 'chat-one/media/bad.m4a');
    await page.waitForSelector('#panel .file-details');
    const badText = await page.textContent('#panel .file-details');
    check('audio that fails says so, with its path', badText.includes("This file can't play here") && badText.includes('chat-one/media/bad.m4a') && (await page.$$('#panel audio')).length === 0, badText);
    await openAdded(main, 'chat-one/media/talk.wav');
    await page.waitForSelector('#panel audio');
    await page.waitForTimeout(150);
    check('audio that plays keeps its player', (await page.$$('#panel audio')).length === 1 && (await page.$$('#panel .file-details')).length === 0);

    await openAdded(main, 'chat-one/synthesis/plain.markdown');
    await page.waitForSelector('#panel-body .prose h1');
    check('a .markdown file renders as Markdown', (await page.textContent('#panel-body .prose h1')) === 'Long extension' && (await page.$$('#panel-body .prose strong')).length === 1);
    await openAdded(main, 'chat-one/synthesis/flow.mmd');
    await page.waitForSelector('#panel .file-code');
    check('a small .mmd shows its text, not "too large"', (await page.textContent('#panel .file-code')).includes('A-->B') && !(await panelText(main)).includes('too large'), await panelText(main));

    for (const [rel, link] of [['chat-one/media/odd.bmp', 'chat-one/media/odd.bmp'], ['chat-one/media/page.xml.zip', 'chat-one/media/page.xml.zip'], ['chat-one/media/NOEXT', null]]) {
      await openAdded(main, rel);
      await page.waitForSelector('#panel .file-details');
      check(`${rel} gets details, not a preview`, (await page.$$('#panel img, #panel iframe, #panel video, #panel audio')).length === 0);
      const href = await page.$eval('#panel .file-details a', a => a.getAttribute('href')).catch(() => null);
      check(`${rel} links only as openableHref allows`, href === link, String(href));
      if (!link) check(`${rel} says where it is`, (await page.textContent('#panel .file-details')).includes(rel));
    }

    // Too large to embed
    await openAdded(main, 'chat-one/large/huge.html');
    await page.waitForSelector('#panel .file-details');
    const hugeText = await page.textContent('#panel .file-details');
    check('oversized .html: the note and its path', hugeText.includes('This file is too large to preview here') && hugeText.includes('chat-one/large/huge.html'), hugeText);
    check('oversized .html: no link and no frame', (await page.$$('#panel a, #panel iframe')).length === 0);
    await openAdded(main, 'chat-one/large/huge.md');
    await page.waitForSelector('#panel .file-details');
    check('oversized .md: the note and a link', (await page.textContent('#panel .file-details')).includes('This file is too large to preview here') && (await page.getAttribute('#panel .file-details a', 'href')) === 'chat-one/large/huge.md');
    await openAdded(main, 'chat-one/large/huge.py');
    await page.waitForSelector('#panel .file-details');
    check('oversized code off the list: the note and no link', (await page.textContent('#panel .file-details')).includes('This file is too large to preview here') && (await page.$$('#panel a')).length === 0);
    await openAdded(main, 'chat-one/large/huge.txt');
    await page.waitForSelector('#panel .file-details a');
    check('oversized text on the list: the note and a link', (await page.textContent('#panel .file-details')).includes('This file is too large to preview here') && (await page.getAttribute('#panel .file-details a', 'href')) === 'chat-one/large/huge.txt');

    // Open file leaves the sandbox, so these really click.
    const clickOpen = async () => {
      const [tab] = await Promise.all([main.context.waitForEvent('page'), page.click('#panel .file-details a')]);
      const logs = [];
      tab.on('console', m => logs.push(m.text()));
      await tab.waitForLoadState().catch(() => {});
      await new Promise(done => setTimeout(done, 300));
      // A download closes its own tab.
      const type = await tab.evaluate(() => document.contentType).catch(() => 'closed');
      await tab.close().catch(() => {});
      return { logs, type };
    };
    const txt = await clickOpen();
    check('clicking Open file on HTML text in a .txt runs nothing', !txt.logs.includes('EVIL ran') && txt.type === 'text/plain', JSON.stringify(txt));
    await openAdded(main, 'chat-one/unsafe/evil.rtf');
    await page.waitForSelector('#panel .file-details a');
    const rtf = await clickOpen();
    check('clicking Open file on HTML in a .rtf runs nothing', !rtf.logs.includes('EVIL ran') && rtf.type !== 'text/html' && rtf.type !== 'application/xhtml+xml', JSON.stringify(rtf));
    await openAdded(main, 'chat-one/unsafe/evil.xbl');
    await page.waitForSelector('#panel .file-details');
    check('an XHTML .xbl offers no link', (await page.$$('#panel a')).length === 0);
    check('an XHTML .xbl gets no frame', (await page.$$('#panel iframe')).length === 0);
    check('an XHTML .xbl says it cannot open', (await page.textContent('#panel .file-details')).includes("This file can't open from the viewer."));
    check('an XHTML .xbl shows where it is', (await page.textContent('#panel .file-details')).includes('chat-one/unsafe/evil.xbl'));

    // Whatever the list offers has to stay inert when a browser opens it on its own.
    const sweep = await browser.newContext({ acceptDownloads: true });
    const runsAt = async (ext, body) => {
      const file = path.join(dir, `sweep.${ext}`);
      fs.writeFileSync(file, body);
      const tab = await sweep.newPage();
      let ran = false;
      tab.on('console', m => { if (m.text() === 'EVIL ran') ran = true; });
      await tab.goto('file://' + file, { timeout: 2500 }).catch(() => {});
      await tab.waitForTimeout(60);
      await tab.close();
      fs.rmSync(file);
      return ran;
    };
    check('control: an HTML page runs at the top level', await runsAt('html', HTML));
    check('control: an XHTML .xbl runs at the top level', await runsAt('xbl', XHTML));
    const ranAt = [];
    for (const ext of OPENABLE_EXTENSIONS) {
      if ((await runsAt(ext, HTML)) || (await runsAt(ext, XHTML))) ranAt.push(ext);
    }
    await sweep.close();
    check(`none of the ${OPENABLE_EXTENSIONS.size} listed types runs a page`, OPENABLE_EXTENSIONS.size > 40 && ranAt.length === 0, ranAt.join());
    check('the escape page never ran', !main.seen.logs.includes('ESCAPED'));

    // Hashes
    const reloaded = await open(url);
    const inChat = id => `${url}#chat=c1&file=${id}`;
    await reloaded.page.goto(inChat('x__proto__'));
    await reloaded.page.waitForTimeout(100);
    check('x__proto__ opens nothing', await reloaded.page.$eval('#panel', n => n.hidden) && !(await hash(reloaded)).includes('file='), await hash(reloaded));
    await reloaded.page.evaluate(() => { location.hash = '#chat=c1&file=x999999'; });
    await reloaded.page.waitForTimeout(100);
    check('an index out of range opens nothing', await reloaded.page.$eval('#panel', n => n.hidden) && !(await hash(reloaded)).includes('file='), await hash(reloaded));
    await reloaded.context.close();

    const restore = await open(url);
    await openAdded(restore, 'chat-one/synthesis/notes.md');
    await restore.page.waitForSelector('#panel-body .prose h2');
    await restore.page.reload();
    await restore.page.waitForSelector('#panel-body .prose h2');
    check('reload restores the open added file', (await panelTitle(restore)) === 'notes.md' && (await panelText(restore)).includes(MARKER));
    clean('reload flow', restore.seen);
    await restore.context.close();

    const shared = await open(`${url}#chat=c2&leaf=c2-2&file=${idOf('chat-one/synthesis/notes.md')}`);
    await shared.page.waitForSelector('#panel-body .prose h2');
    check('an x id for a file hidden from this chat still opens', (await shared.page.textContent('#title')) === 'Second chat' && (await panelTitle(shared)) === 'notes.md');
    check('the count follows the chat', (await shared.page.textContent('details.archive-files > summary')) === `Archive files · ${CHAT_TWO_FILES + SHARED_FILES}`);
    await openFold(shared);
    check('the tree follows the chat', (await shared.page.$$eval('.add-tree > .add-level > details > summary', s => s.map(x => x.textContent))).join() === 'bulk,chat-two');
    await shared.page.click('.item:has-text("First chat")');
    await shared.page.waitForFunction(() => document.getElementById('title').textContent === 'First chat');
    check('changing chat closes the file and rebuilds the count', await shared.page.$eval('#panel', n => n.hidden) && (await shared.page.textContent('details.archive-files > summary')) === `Archive files · ${count}`);
    clean('shared link flow', shared.seen);
    await shared.context.close();

    // loadPart
    const parts = await open(url);
    const load = n => parts.page.evaluate(v => loadPart(v), n);
    const firstPart = data.added.find(a => a.part === 1);
    const scriptCount = () => parts.seen.files.filter(u => u.includes('/viewer-files/')).length;
    for (const bad of [0, -1, 1.5, '1', 9999, null, '../x']) check(`loadPart refuses ${JSON.stringify(bad)}`, (await load(bad)) === null);
    check('a refused part loads nothing', scriptCount() === 0, parts.seen.files.join());
    const got = await load(1);
    check('loadPart gives the part', got && got[firstPart.key] === fs.readFileSync(path.join(root, firstPart.path), 'utf8'));
    await load(1);
    check('loadPart caches', scriptCount() === 1, String(scriptCount()));
    check('its script is gone from the page', (await parts.page.$$('script[src]')).length === 0);
    check('the zero-padded name was asked for', parts.seen.files.some(u => u.endsWith('/viewer-files/part-0001.js')));
    check('__archivePart ignores a part not being loaded', await parts.page.evaluate(k => {
      window.__archivePart(1, { [k]: 'forged' });
      window.__archivePart(2, { [k]: 'forged' });
      return loadPart(1).then(d => d[k] !== 'forged');
    }, firstPart.key));
    check('__archivePart cannot be replaced', await parts.page.evaluate(() => { const was = window.__archivePart; window.__archivePart = null; return window.__archivePart === was; }));
    clean('part flow', parts.seen);
    await parts.context.close();

    const twice = { match: u => u.endsWith('part-0002.js') };
    const dup = await open(url, { delay: twice });
    const firstWins = await dup.page.evaluate(() => {
      const pending = loadPart(2);
      window.__archivePart(2, { first: 1 });
      window.__archivePart(2, { second: 1 });
      return pending;
    });
    if (twice.release) twice.release();
    check('a second call for the same part is ignored', JSON.stringify(firstWins) === '{"first":1}', JSON.stringify(firstWins).slice(0, 80));
    await dup.context.close();

    // A slow part can't overwrite the file opened after it.
    const block = n => data.added.find(a => a.path === `chat-one/parts/block${n}.md`);
    check('the slow and quick files sit in different parts', block(1).part !== block(3).part, `${block(1).part} ${block(3).part}`);
    const slowPart = String(block(1).part).padStart(4, '0');
    const gate = { match: u => u.endsWith(`part-${slowPart}.js`) };
    const race = await open(url, { delay: gate });
    await openAdded(race, 'chat-one/parts/block1.md');
    await race.page.waitForSelector('#panel .file-loading');
    check('a slow part shows Loading…', (await race.page.textContent('#panel .file-loading')) === 'Loading…');
    check('the panel names the file while it loads', (await panelTitle(race)) === 'block1.md');
    await openAdded(race, 'chat-one/parts/block3.md');
    await race.page.waitForSelector('#panel-body .prose h1');
    check('the file opened next shows', (await race.page.textContent('#panel-body .prose h1')) === 'Block 3');
    (await held(gate))();
    await race.page.waitForTimeout(600);
    check('the slow part does not overwrite it', (await panelTitle(race)) === 'block3.md' && (await race.page.textContent('#panel-body .prose h1')) === 'Block 3');
    clean('slow part flow', race.seen);
    await race.context.close();

    const closing = { match: u => u.endsWith(`part-${slowPart}.js`) };
    const shut = await open(url, { delay: closing });
    await openAdded(shut, 'chat-one/parts/block1.md');
    await shut.page.waitForSelector('#panel .file-loading');
    await shut.page.click('#panel .close');
    (await held(closing))();
    await shut.page.waitForTimeout(600);
    check('closing during a load stays closed', await shut.page.$eval('#panel', n => n.hidden));
    await shut.context.close();

    // Added .html runs only in the sandboxed iframe
    const control = await open(url);
    const ctrlPage = await control.context.newPage();
    const ctrlSeen = [];
    await ctrlPage.route('**/*', r => { ctrlSeen.push(r.request().url()); return r.abort(); });
    await ctrlPage.setContent('<iframe srcdoc="<img src=https://remote.test/control.png>"></iframe>');
    await ctrlPage.waitForTimeout(300);
    check('control: a frame request with no policy is counted', ctrlSeen.includes('https://remote.test/control.png'), ctrlSeen.join());
    const rawPage = await control.context.newPage();
    const rawLogs = [];
    rawPage.on('console', m => rawLogs.push(m.text()));
    await rawPage.route('**/*', r => (r.request().url().startsWith('file:') ? r.continue() : r.abort()));
    await rawPage.goto('file://' + path.join(root, 'chat-one', 'synthesis', 'hostile.html'));
    for (let i = 0; i < 80 && !rawLogs.includes('ATTACK part-script gave REACHED'); i++) await rawPage.waitForTimeout(50);
    check('control: outside the sandbox the same page reaches a part', rawLogs.includes('ATTACK part-script gave REACHED'), rawLogs.filter(l => l.startsWith('ATTACK')).slice(0, 6).join(' | '));
    for (let i = 0; i < 80 && !rawLogs.includes('ATTACK file-audio gave REACHED'); i++) await rawPage.waitForTimeout(50);
    check('control: outside the sandbox the same page reaches a media file', rawLogs.includes('ATTACK file-audio gave REACHED'), rawLogs.filter(l => l.startsWith('ATTACK')).slice(0, 6).join(' | '));
    await control.context.close();

    const atk = await open(url);
    let popups = 0;
    atk.context.on('page', () => { popups++; });
    await openAdded(atk, 'chat-one/synthesis/hostile.html');
    const af = await frameIn(atk);
    await af.waitForSelector('h1');
    const attrs = await atk.page.$eval('#panel iframe', f => [...f.attributes].map(a => a.name).sort().join());
    check('the frame has sandbox and srcdoc, and nothing that loosens them', attrs === 'class,sandbox,srcdoc,title', attrs);
    check('sandbox is allow-scripts and nothing else', (await atk.page.$eval('#panel iframe', f => f.getAttribute('sandbox'))) === 'allow-scripts');
    check('hostile: the script ran to the end', await waitLog(atk, 'ATTACK finished yes'), atk.seen.logs.filter(l => l.startsWith('ATTACK')).join(' | '));
    check('hostile: the frame has no origin', atk.seen.logs.includes('ATTACK origin null'), atk.seen.logs.slice(0, 5).join(' | '));
    for (const [name, end] of Object.entries({ ...REACH_ENDS, ...ATTACK_ENDS })) {
      const said = atk.seen.logs.filter(l => l.startsWith(`ATTACK ${name} `)).map(l => l.slice(`ATTACK ${name} `.length));
      check(`hostile: ${name} was attempted`, said[0] === 'ran', said.join());
      check(`hostile: ${name} failed`, said[1] === end, said.join());
    }
    const violations = atk.seen.logs.filter(l => l.startsWith('VIOLATION'));
    for (const blocked of ['https://remote.test/fetch', 'https://remote.test/beacon', 'wss://remote.test/ws', 'https://remote.test/img.png', 'https://remote.test/tag.png', 'https://remote.test/f.woff', 'https://remote.test/bg.png', 'https://remote.test/s.css']) {
      check(`hostile: the policy stopped ${blocked}`, violations.some(v => v.endsWith(' ' + blocked)), violations.join(' | '));
    }
    const nestedSaid = () => atk.seen.logs.filter(l => l.startsWith('NESTED ')).join(' | ');
    const nestedRan = await waitLog(atk, 'NESTED ran');
    const nestedBlocked = await waitLog(atk, 'NESTED violation connect-src https://remote.test/nested');
    check('hostile: a nested frame ran', nestedRan, nestedSaid());
    check('hostile: the nested frame is held to the same policy', nestedBlocked && await waitLog(atk, 'NESTED fetch failed'), nestedSaid());
    await atk.page.waitForTimeout(400);
    check('hostile: no request left the page', atk.seen.requests.length === 0, atk.seen.requests.join());
    check('hostile: no window opened', popups === 0, String(popups));
    check('hostile: the viewer stays on its page', atk.page.url().startsWith(url), atk.page.url());
    check('hostile: the viewer title is untouched', (await atk.page.title()) === 'First chat - Claude Takeout', await atk.page.title());
    check('hostile: nothing ran in the viewer', !(await atk.page.evaluate(() => !!window.__hit)));
    await openAdded(atk, 'chat-one/synthesis/drawing.svg');
    check('an added SVG runs in the sandbox', await waitLog(atk, 'SVG ran'));
    check('an added SVG frame is sandboxed', (await atk.page.$eval('#panel iframe', f => f.getAttribute('sandbox'))) === 'allow-scripts');
    await atk.context.close();

    // Each leaves the document it runs in, so each opens on its own.
    for (const navPage of NAV_PAGES) {
      const { name, target } = navPage;
      const rawCtx = await browser.newContext();
      const raw = await rawCtx.newPage();
      const rawSeen = [];
      raw.on('console', m => rawSeen.push(m.text()));
      await raw.route('**/*', r => { const u = r.request().url(); if (!u.startsWith('file:') && !u.startsWith('blob:')) rawSeen.push(u); return u.startsWith('http') ? r.abort() : r.continue(); });
      await raw.goto('file://' + path.join(root, 'chat-one', 'nav', name)).catch(() => {});
      for (let i = 0; i < 40 && !rawSeen.includes(target); i++) await new Promise(done => setTimeout(done, 25));
      check(`control: ${name} leaves when it has no sandbox`, rawSeen.includes(target), rawSeen.join(' | '));
      await rawCtx.close();

      const nav = await open(url);
      let opened = 0;
      nav.context.on('page', () => { opened++; });
      await openAdded(nav, `chat-one/nav/${name}`);
      await frameIn(nav);
      // A zero-delay refresh can replace the page before its script logs. The refusal
      // naming the target proves the attempt, so it counts too, for this file only.
      const refused = () => name === 'nav-refresh.html' && nav.seen.logs.some(l => l.includes("Refused to frame 'https://remote.test/refresh"));
      const ran = await waitLog(nav, `NAV ran ${name}`) || refused();
      await nav.page.waitForTimeout(500);
      check(`${name}: the attempt ran`, ran, nav.seen.logs.join(' | '));
      check(`${name}: nothing got out`, !nav.seen.logs.some(l => l.includes('ESCAPED')) && nav.seen.requests.length === 0 && opened === 0, [...nav.seen.logs, ...nav.seen.requests].join(' | '));
      check(`${name}: the viewer stays`, nav.page.url().startsWith(url) && (await nav.page.title()) === 'First chat - Claude Takeout', nav.page.url());
      await nav.context.close();
    }

    // A chat with a project and added files gets all three folds.
    const projected = path.join(dir, 'project-chat');
    put(projected, 'original.json', JSON.stringify({ ...JSON.parse(chatJson('p1', 'Project chat', '2026-01-01T00:00:00Z')), project_uuid: 'P', project: { uuid: 'P', name: 'Budget project' } }));
    put(projected, 'project/project.json', JSON.stringify({ name: 'Budget project' }));
    put(projected, 'project/prompt_template.md', 'Always answer briefly.');
    put(projected, 'project/files/spec.pdf', Buffer.from(PDF, 'latin1'));
    put(projected, 'notes/extra.md', '# Extra note');
    runTool(projected);
    const both = await open('file://' + path.join(projected, 'viewer.html'));
    const folds = await both.page.$$eval('#project > details', d => d.map(x => [x.className, x.open, x.querySelector('summary').textContent]));
    check('project chat: three folds in order, all closed', JSON.stringify(folds) === JSON.stringify([['instructions', false, 'Project instructions'], ['project-files', false, 'Project · Budget project · 1 item'], ['archive-files', false, 'Archive files · 1']]), JSON.stringify(folds));
    await both.page.click('details.project-files > summary');
    check('project chat: the project file shows', (await both.page.textContent('details.project-files .chip')).includes('spec.pdf'));
    await openAdded(both, 'notes/extra.md');
    await both.page.waitForSelector('#panel-body .prose h1');
    check('project chat: the added file opens', (await both.page.textContent('#panel-body .prose h1')) === 'Extra note');
    check('project chat: the other folds stay as they were', await both.page.$eval('details.project-files', d => d.open));
    clean('project chat flow', both.seen);
    await both.context.close();

    // An added file reaches nothing of the chat that happens to be open.
    const neighbour = path.join(dir, 'neighbour');
    put(neighbour, 'original.json', JSON.stringify({
      uuid: 'n1', name: 'Neighbour', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z', settings: {},
      chat_messages: [
        { uuid: 'n-1', sender: 'human', created_at: '2026-01-01T00:00:00Z', content: [{ type: 'text', text: 'make it' }], parent_message_uuid: null },
        { uuid: 'n-2', sender: 'assistant', created_at: '2026-01-01T00:00:01Z', content: [{ type: 'tool_use', id: 't1', name: 'create_file', input: { path: '/mnt/user-data/outputs/secret.js', file_text: "console.log('SIBLING READ')" } }], parent_message_uuid: 'n-1' },
      ],
      current_leaf_message_uuid: 'n-2',
    }));
    put(neighbour, 'mine.html', `<!doctype html><script src="secret.js"></script><script>console.log('MINE ran')</script>`);
    runTool(neighbour);
    const sib = await open('file://' + path.join(neighbour, 'viewer.html'));
    await openAdded(sib, 'mine.html');
    check('an added page ran', await waitLog(sib, 'MINE ran'));
    check('an added page gets none of the chat\'s files inlined', !sib.seen.logs.some(l => l.includes('SIBLING READ')));
    await sib.context.close();

    // A renamed archive folder
    const moved = path.join(home, 'renamed folder ä');
    fs.cpSync(root, moved, { recursive: true });
    const ren = await open('file://' + encodeURI(path.join(moved, 'viewer.html')));
    await openAdded(ren, 'chat-one/media/photo.png');
    await ren.page.waitForFunction(() => document.querySelector('#panel .file-image').naturalWidth > 0);
    check('renamed: the image opens', true);
    await openAdded(ren, 'chat-one/media/paper.pdf');
    const renPdf = ren.seen.files.filter(u => u.endsWith('/chat-one/media/paper.pdf'));
    check('renamed: the PDF opens from the new folder', renPdf.length > 0 && renPdf.every(u => u.includes('/renamed%20folder%20')), renPdf.join());
    await openAdded(ren, 'chat-one/synthesis/notes.md');
    await ren.page.waitForSelector('#panel-body .prose h2');
    check('renamed: text loads from its part', (await panelText(ren)).includes(MARKER));
    clean('renamed flow', ren.seen);
    await ren.context.close();

    // A part with a missing file
    const gone = path.join(home, 'gone');
    fs.cpSync(root, gone, { recursive: true });
    const notes = data.added.find(a => a.path === 'chat-one/synthesis/notes.md');
    fs.rmSync(path.join(gone, 'viewer-files', `part-${String(notes.part).padStart(4, '0')}.js`));
    const miss = await open('file://' + path.join(gone, 'viewer.html'));
    await openAdded(miss, 'chat-one/synthesis/notes.md');
    await miss.page.waitForSelector('#panel .file-missing');
    check('a missing part says so', (await miss.page.textContent('#panel .file-missing')) === 'This file is not in this export.');
    check('a missing part makes no page error', miss.seen.pageErrors.length === 0, miss.seen.pageErrors.join(' | '));
    const noise = miss.seen.errors.filter(e => !e.includes('ERR_FILE_NOT_FOUND'));
    check('a missing part logs only the failed load', noise.length === 0, noise.join(' | '));
    await miss.context.close();

    // A viewer with media and no text: file: for media only.
    const audioOnly = path.join(dir, 'audio-only');
    put(audioOnly, 'original.json', chatJson('a1', 'Audio chat', '2026-01-01T00:00:00Z'));
    put(audioOnly, 'talks/talk.wav', wav());
    runTool(audioOnly);
    const aud = await open('file://' + path.join(audioOnly, 'viewer.html'));
    await openAdded(aud, 'talks/talk.wav');
    await aud.page.waitForFunction(() => document.querySelector('#panel audio').readyState >= 1);
    check('audio plays in a viewer with no parts', true);
    check('that viewer allows no script from disk', !/script-src[^;]*file:/.test(await aud.page.$eval('meta[http-equiv="Content-Security-Policy"]', m => m.content)));
    clean('audio only flow', aud.seen);
    await aud.context.close();

    // One chat, both kinds of part: its large upload and an added file.
    const mixed = await open(`${url}#chat=c2&leaf=c2-2`, { permissions: ['clipboard-read', 'clipboard-write'] });
    await mixed.page.click('button.chip:has-text("big.md")');
    await mixed.page.waitForFunction(t => document.querySelector('.pop .pop-body')?.textContent === t, BIG_UPLOAD, { timeout: 3000 }).catch(() => {});
    check('a large upload opens from its part in an archive', (await mixed.page.textContent('.pop .pop-body')) === BIG_UPLOAD);
    await mixed.page.click('.pop .close');
    await openAdded(mixed, 'chat-two/only-two.md');
    await mixed.page.waitForFunction(() => document.querySelector('#panel-body')?.textContent.includes('Second chat only'), null, { timeout: 3000 }).catch(() => {});
    check('an added file opens beside it', (await panelText(mixed)).includes('Second chat only'));
    await mixed.page.click('#panel-head .copy');
    check('an added file copies its text', (await mixed.page.evaluate(() => navigator.clipboard.readText())) === '# Second chat only');
    check('both kinds loaded from viewer-files', new Set(mixed.seen.files.filter(u => u.includes('/viewer-files/'))).size >= 2, mixed.seen.files.filter(u => u.includes('/viewer-files/')).join());
    clean('both kinds flow', mixed.seen);
    await mixed.context.close();

    // An export viewer still has no section
    const exp = await open('file://' + exportFile);
    check('an export viewer has no Archive files', (await exp.page.$$('details.archive-files')).length === 0);
    check('an export viewer hides the project bar', await exp.page.$eval('#project', p => p.hidden));
    const policy = await exp.page.$eval('meta[http-equiv="Content-Security-Policy"]', m => m.content);
    check('an export viewer has no file: in script-src', !/script-src[^;]*file:/.test(policy), policy);
    check('an export viewer has no file: in media-src', !/media-src[^;]*file:/.test(policy), policy);
    check('an export viewer has no __archivePart', !(await exp.page.evaluate(() => '__archivePart' in window)));
    check('an export viewer refuses any part', (await exp.page.evaluate(() => loadPart(1))) === null);
    clean('export flow', exp.seen);
    await exp.context.close();

    clean('main flow', main.seen);

    const shots = process.env.SHOT_DIR;
    if (shots) {
      for (const colorScheme of ['light', 'dark']) {
        const out = name => path.join(shots, `archive-${colorScheme}-${name}.png`);
        const ps = await open(url, { colorScheme });
        await ps.page.screenshot({ path: out('closed') });
        await openFold(ps);
        await ps.page.click('.add-tree details:has(> summary:has-text("chat-one")) > summary');
        await ps.page.click('.add-tree details:has(> summary:has-text("synthesis")) > summary');
        await ps.page.waitForTimeout(100);
        await ps.page.screenshot({ path: out('tree') });
        await ps.page.click('.add-tree details:has(> summary:has-text("synthesis")) > .add-level > .add-file[title$="notes.md"]');
        await ps.page.waitForSelector('#panel-body .prose h2');
        await ps.page.screenshot({ path: out('open') });
        await ps.page.fill('.add-filter', '.md');
        await ps.page.waitForSelector('.add-results .add-file');
        await ps.page.waitForTimeout(100);
        await ps.page.screenshot({ path: out('filter') });
        await openAdded(ps, 'chat-one/large/huge.html');
        await ps.page.waitForTimeout(100);
        await ps.page.screenshot({ path: out('too-large') });
        await openAdded(ps, 'chat-one/media/talk.wav');
        await ps.page.waitForTimeout(100);
        await ps.page.screenshot({ path: out('audio') });
        const phone = await open(url, { colorScheme, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
        await openFold(phone);
        await phone.page.waitForTimeout(100);
        await phone.page.screenshot({ path: out('phone') });
        await ps.context.close();
        await phone.context.close();
      }
    }
  } catch (e) {
    failed++;
    console.log('HARNESS ERROR', e.message);
  } finally {
    await browser.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})();
