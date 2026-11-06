// The viewer page over file:// in Chromium, built from the synthetic fixture. SHOT_DIR=<dir> also saves screenshots.
const { chromium } = require(process.env.PW);
const fs = require('fs'), os = require('os'), path = require('path');
const { buildHtml } = require('./make-viewer.js');
const fixture = require('../fixtures/conversation.json');

const HIT = 'window.__hit=1';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mNkYPhfz0AEYBxVSF+FAAhKDveksOjmAAAAAElFTkSuQmCC';
const PAYLOADS = [
  `<script>${HIT}</script>`,
  `<img src=x onerror="${HIT}">`,
  `<a id="js" href="javascript:${HIT}">click</a>`,
  `<svg onload="${HIT}"></svg>`,
  `<iframe src="javascript:parent.__hit=1"></iframe>`,
  '<style>@import url(https://remote.test/x.css);</style>',
  '<img src="https://remote.test/x.png">',
];
// Things only the whole pipeline can reach.
const PIPELINE_PAYLOADS = [
  ...PAYLOADS,
  `<a title="$x$ <img src=x onerror=${HIT}>">math in an attribute</a>`,
  '![remote](https://remote.test/y.png)',
  '<img src="file:///etc/hosts">',
  `<img name="getElementById" src="${PNG}">`,
  '<div style="background:url(https://remote.test/z.png);width:9px;height:9px"></div>',
  `<video src="https://remote.test/v.mp4" autoplay></video><audio src="https://remote.test/a.mp3" autoplay></audio>`,
];

const RICH = `## Spending by team

The third quarter closed **under plan**, with one *notable* exception. See \`travel_total\` in the sheet.

### What changed

- Travel rose 12% over plan
- Software licences fell after the renewal
  - Two seats were dropped
- Hiring moved to the fourth quarter

| Team | Plan | Actual | Change |
|---|---:|---:|---:|
| Design | 40 | 38 | -5% |
| Field | 75 | 84 | +12% |
| Platform | 120 | 117 | -2.5% |

> Figures are rounded to the nearest thousand.

The variance is $\\Delta = \\frac{A - P}{P}$, so the total at a cost of $5 stays simple:

$$\\sum_{i=1}^{n} \\frac{A_i - P_i}{P_i} = 0.045$$

\`\`\`python
def variance(actual, plan):
    # share of plan, $ signs stay literal here
    return (actual - plan) / plan
\`\`\`

1. Confirm the travel figures
2. Send the summary to [finance](https://example.com/finance)

---

That covers the quarter.`;

function clone(o) { return JSON.parse(JSON.stringify(o)); }

function richChat() {
  const c = clone(fixture);
  c.name = 'Quarterly budget review';
  c.model = 'claude-opus-4-8-20260101';
  c.updated_at = '2026-11-05T12:00:00Z';
  const text = c.chat_messages.find(m => m.uuid === 'm01').content[0];
  text.text = 'Can you turn this into a one-page summary?\n\nKeep the tables, and show how the variance is worked out.';
  const m = c.chat_messages.find(x => x.uuid === 'm02');
  const cited = m.content.find(b => b.type === 'text');
  cited.text = "Here's the summary, with spending by team and what to check next.";
  cited.citations = [{ end_index: 18, url: 'https://example.com/a', title: 'Budget guidance' }, { end_index: 66, url: 'https://example.org/b', title: 'Team spending report' }];
  m.content.push({ type: 'text', text: RICH });
  c.chat_messages.find(x => x.uuid === 'm06').content.push({ type: 'text', text: 'The wording is fixed.' });
  const shot = c.chat_messages.find(x => x.uuid === 'm08').content.find(b => b.tool_use_id === 't12');
  shot.content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.split(',')[1] } });
  return c;
}

function plainChat(id, name, count, updated) {
  const messages = [];
  for (let i = 0; i < count; i++) {
    messages.push({
      uuid: `${id}-${i}`, parent_message_uuid: i ? `${id}-${i - 1}` : null, sender: i % 2 ? 'assistant' : 'human',
      created_at: `2026-02-01T10:${String(i % 60).padStart(2, '0')}:00Z`, content: [{ type: 'text', text: `${name} message ${i}` }],
      attachments: [], files: [], files_v2: [],
    });
  }
  return { uuid: id, name, model: 'claude-x', created_at: '2026-02-01T10:00:00Z', updated_at: updated, settings: {}, current_leaf_message_uuid: `${id}-${count - 1}`, chat_messages: messages };
}

function hostileChat() {
  const c = plainChat('hostile', `<img src=x onerror="${HIT}">`, 2, '2026-01-01T00:00:00Z');
  c.chat_messages[0].content[0].text = PIPELINE_PAYLOADS.join('\n');
  c.chat_messages[1].content[0].text = PIPELINE_PAYLOADS.join('\n\n');
  return c;
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'takeout-viewer-'));
  const file = path.join(dir, 'viewer.html');
  fs.writeFileSync(file, buildHtml([richChat(), plainChat('long', 'Long chat', 300, '2026-03-01T00:00:00Z'), plainChat('short', 'Short chat', 2, '2026-02-01T00:00:00Z'), hostileChat()], '2026-11-05T12:00:00Z'));
  const url = 'file://' + file;
  const browser = await chromium.launch({ executablePath: process.env.CHROME_EXE });
  let failed = 0;
  const check = (n, ok, x = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n} ${ok ? '' : x}`); };
  const open = async (options = {}) => {
    const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, ...options });
    const page = await context.newPage();
    const seen = { requests: [], errors: [] };
    await page.route('**/*', r => {
      const u = r.request().url();
      if (u.startsWith('file:') || u.startsWith('data:')) return r.continue();
      seen.requests.push(u);
      return r.abort();
    });
    page.on('console', m => { if (m.type() === 'error') seen.errors.push(m.text()); });
    page.on('pageerror', e => seen.errors.push(e.message));
    await page.goto(url);
    await page.waitForSelector('.msg');
    return { page, seen, context };
  };
  const clean = (name, seen) => {
    check(`${name}: zero network requests`, seen.requests.length === 0, seen.requests.join());
    check(`${name}: zero console errors`, seen.errors.length === 0, seen.errors.join(' | '));
  };

  try {
    const { page, seen } = await open();
    const chats = await page.$$eval('.item', els => els.map(e => e.textContent));
    check('sidebar shows the brand', (await page.textContent('.brand')) === 'Claude Takeout');
    check('sidebar lists every chat', chats.length === 4 && chats.includes('Short chat'), chats.join());
    check('footer counts the chats', (await page.textContent('#archive')) === 'Archive · 4 chats · read-only');
    check('newest chat opens first', (await page.textContent('#title')) === 'Quarterly budget review');
    check('open chat is marked in the sidebar', (await page.textContent('.item[aria-current="true"]')) === 'Quarterly budget review');
    check('top bar shows the model', (await page.textContent('#meta')).startsWith('Opus 4.8 · '));
    check('page has a CSP', await page.$eval('meta[http-equiv="Content-Security-Policy"]', m => /default-src 'none'.*img-src file: data: blob:; media-src data: blob:/.test(m.content)));

    const box = await page.$eval('.bubble', b => { const r = b.getBoundingClientRect(), c = document.getElementById('chat').getBoundingClientRect(); return { right: c.right - r.right, left: r.left - c.left }; });
    check('user bubble sits on the right', box.right < box.left && box.right < 40, JSON.stringify(box));
    check('user text is literal', (await page.textContent('.bubble')).includes('one-page summary?\n\nKeep'));
    check('assistant text is serif', /Charter/.test(await page.$eval('.prose', p => getComputedStyle(p).fontFamily)));
    check('chips render', (await page.textContent('.chip')).normalize('NFC').includes('Gödel.md'.normalize('NFC')));
    check('timestamps render', await page.$$eval('time.when', t => t.length > 0 && t.every(x => x.dateTime)));
    check('dark tokens exist', await page.evaluate(() => [...document.styleSheets].some(s => [...s.cssRules].some(r => r.media && /prefers-color-scheme: dark/.test(r.media.mediaText)))));

    check('table renders', (await page.$$('.prose .table table td')).length === 12);
    check('headings render', (await page.$$('.prose h2, .prose h3')).length === 2);
    check('math renders', (await page.$$('.prose .katex')).length === 2 && (await page.$$('.prose .katex-display')).length === 1);
    check('money stays text', (await page.textContent('.assistant')).includes('a cost of $5 stays simple'));
    check('dollars in code stay literal', (await page.textContent('.code code')).includes('$ signs stay literal'));
    check('code has a language label', (await page.textContent('.code-head span')) === 'python');
    check('citations are numbered links', (await page.$$eval('sup.cite a', a => a.map(x => x.textContent).join())) === '1,2');
    check('sources are listed', (await page.textContent('.sources')).includes('Team spending report'));
    await page.click('.copy');
    await page.waitForFunction(() => document.querySelector('.copy span').textContent === 'Copied');
    check('Copy reports success', true);

    check('thinking and tools start collapsed', await page.$$eval('details.line', d => d.length > 8 && d.every(x => !x.open)));
    check('thinking line is labelled', (await page.textContent('details.thinking summary')).includes('Thought process'));
    await page.click('details.thinking summary');
    check('thinking expands on click', await page.$eval('details.thinking', d => d.open && d.textContent.includes('Then write it.') && d.querySelector('.line-text').offsetHeight > 0));
    await page.click('details.tool summary');
    check('tool expands to input and result', await page.$eval('details.tool', d => d.open && d.textContent.includes('Input') && d.textContent.includes('report.html') && d.textContent.includes('Result')));
    await page.focus('details.tool:nth-of-type(3) summary');
    await page.keyboard.press('Enter');
    check('tool expands from the keyboard', await page.$eval('details.tool:nth-of-type(3)', d => d.open));
    const failing = await page.$$eval('details.tool', d => d.filter(x => x.querySelector('.fail')).map(x => x.textContent));
    check('failed tool calls say so', failing.length === 2, failing.join());
    check('tool images show outside the fold', await page.$$eval('.tool-images img', i => i.length === 1 && !i[0].closest('details') && i[0].naturalWidth > 0));
    check('off-branch messages stay out', !(await page.textContent('#chat')).includes('abandoned'));

    // Review Focus 5: a later render cancels what is still pending.
    await page.evaluate(() => { const by = t => [...document.querySelectorAll('.item')].find(i => i.textContent === t); by('Long chat').click(); by('Short chat').click(); });
    await page.waitForTimeout(600);
    const ids = await page.$$eval('.msg', m => m.map(x => x.dataset.id));
    check('switching chats cancels pending batches', ids.join() === 'short-0,short-1', ids.join());
    check('rapid switch leaves the title right', (await page.textContent('#title')) === 'Short chat');
    await page.click('.item:has-text("Long chat")');
    await page.waitForFunction(() => document.querySelectorAll('.msg').length === 300, null, { timeout: 5000 });
    check('a long chat finishes rendering', true);
    check('messages use content-visibility', await page.$eval('.msg', m => getComputedStyle(m).contentVisibility === 'auto'));
    clean('main flow', seen);

    const hostile = await open();
    await hostile.page.click('.item >> nth=3');
    await hostile.page.waitForSelector('.msg.assistant');
    await hostile.page.waitForTimeout(300);
    const dom = await hostile.page.evaluate(() => {
      const box = document.getElementById('chat');
      return {
        hit: !!window.__hit, bad: box.querySelectorAll('.prose script, .prose iframe, .prose svg:not(.ic), .prose style, .prose video, .prose audio').length,
        remote: [...box.querySelectorAll('.prose [src]')].filter(n => !n.src.startsWith('data:image/png')).length,
        js: box.querySelectorAll('a[href^="javascript" i]').length,
        clobbered: typeof document.getElementById !== 'function',
        styled: box.querySelectorAll('.prose [style]:not(.katex *)').length,
        bubble: box.querySelector('.bubble').textContent.includes('<script>'),
      };
    });
    check('hostile chat: nothing runs', !dom.hit, JSON.stringify(dom));
    check('hostile chat: no dangerous element survives', dom.bad === 0, JSON.stringify(dom));
    check('hostile chat: nothing loads', dom.remote === 0, JSON.stringify(dom));
    check('hostile chat: no script links', dom.js === 0);
    check('hostile chat: no clobbering', !dom.clobbered);
    check('hostile chat: no inline styles', dom.styled === 0, JSON.stringify(dom));
    check('hostile chat: user text stays text', dom.bubble);
    check('hostile title stays text', (await hostile.page.textContent('#title')).startsWith('<img') && (await hostile.page.$$('#side img, #top img')).length === 0);

    for (const payload of PAYLOADS) {
      const out = await hostile.page.evaluate(html => {
        const host = document.createElement('div');
        const safe = sanitizeHtml(html, new DOMParser());
        host.innerHTML = safe;
        document.body.append(host);
        const link = host.querySelector('a');
        if (link) link.click();
        return new Promise(done => setTimeout(() => {
          const res = { safe, hit: !!window.__hit, kids: host.querySelectorAll('script,iframe,svg,style').length, loads: [...host.querySelectorAll('[src],[href]')].length };
          host.remove();
          done(res);
        }, 120));
      }, payload);
      check(`sanitizeHtml disarms ${payload.slice(0, 34)}`, !out.hit && out.kids === 0 && out.loads === 0, JSON.stringify(out));
    }
    const kept = await hostile.page.evaluate(src => sanitizeHtml(`<img alt="x" src="${src}"><a href="https://a.test">y</a>`, new DOMParser()), PNG);
    check('sanitizeHtml keeps data images and web links', kept.includes('src="data:image/png') && kept.includes('href="https://a.test"') && kept.includes('rel="noopener"'), kept);
    const svgData = await hostile.page.evaluate(() => sanitizeHtml('<img src="data:image/svg+xml;base64,PHN2Zz4=">', new DOMParser()));
    check('sanitizeHtml drops SVG data images', !svgData.includes('<img'), svgData);
    clean('hostile flow', hostile.seen);

    const phone = await open({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    check('phone: no sideways scroll', await phone.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    check('phone: sidebar starts hidden', await phone.page.$eval('#side', s => s.getBoundingClientRect().right <= 0));
    await phone.page.click('#menu');
    await phone.page.waitForFunction(() => document.getElementById('side').getBoundingClientRect().left >= 0);
    await phone.page.click('.item:has-text("Short chat")');
    check('phone: picking a chat closes the drawer', (await phone.page.textContent('#title')) === 'Short chat' && !(await phone.page.evaluate(() => document.body.classList.contains('drawer'))));

    if (process.env.SHOT_DIR) {
      const out = n => path.join(process.env.SHOT_DIR, n);
      for (const colorScheme of ['light', 'dark']) {
        const s = await open({ colorScheme });
        await s.page.screenshot({ path: out(`${colorScheme}-top.png`) });
        await s.page.$$eval('details.line', d => { d[0].open = true; d[1].open = true; });
        await s.page.evaluate(() => { document.getElementById('scroll').scrollTop = 0; });
        await s.page.screenshot({ path: out(`${colorScheme}-expanded.png`) });
        await s.page.$$eval('details.line', d => { d[0].open = false; d[1].open = false; });
        await s.page.evaluate(() => { document.getElementById('scroll').scrollTop = 620; });
        await s.page.waitForTimeout(150);
        await s.page.screenshot({ path: out(`${colorScheme}-table.png`) });
        await s.page.evaluate(() => { document.getElementById('scroll').scrollTop = 1250; });
        await s.page.waitForTimeout(150);
        await s.page.screenshot({ path: out(`${colorScheme}-code.png`) });
        const p = await open({ colorScheme, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
        await p.page.screenshot({ path: out(`${colorScheme}-phone.png`) });
        await p.page.evaluate(() => { document.getElementById('scroll').scrollTop = 900; });
        await p.page.waitForTimeout(150);
        await p.page.screenshot({ path: out(`${colorScheme}-phone-table.png`) });
        await p.page.click('#menu');
        await p.page.waitForTimeout(300);
        await p.page.screenshot({ path: out(`${colorScheme}-phone-drawer.png`) });
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
