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
  // A quote in an attribute name once put math's double quotes inside a live attribute value.
  `<div x'y="$x$" <q=" tabindex=1 autofocus onfocus=${HIT} ">hello</div>`,
  `<div x"y='$x$' <q=" tabindex=1 autofocus onfocus=${HIT} ">hello</div>`,
  `<div x'y="$x$ <img src=x onerror=${HIT}>">hello</div>`,
  '<frameset>',
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

// Assistant messages with these texts, each after a short user message. items: a string or a content block.
function turnsChat(id, name, items, updated) {
  const c = plainChat(id, name, items.length * 2, updated);
  items.forEach((item, i) => {
    c.chat_messages[i * 2].content[0].text = `question ${i}`;
    c.chat_messages[i * 2 + 1].content[0] = typeof item === 'string' ? { type: 'text', text: item } : { type: 'text', ...item };
  });
  return c;
}

// Each payload in a message of its own, so that one can't hide another.
function hostileChat() {
  const c = turnsChat('hostile', `<img src=x onerror="${HIT}">`, PIPELINE_PAYLOADS, '2026-01-01T00:00:00Z');
  c.chat_messages[0].content[0].text = PIPELINE_PAYLOADS.join('\n');
  return c;
}

const TAG_WORDS = {
  textarea: 'Use a <textarea> for input, and keep going.\n\nSecond paragraph stays.\n\n## This heading stays',
  script: 'The <script> tag runs code.\n\nThis second paragraph is important.',
  comment: 'Start <!-- not closed\n\nThis other paragraph is important.',
  rawCode: 'Inside <code> 1 < 2 <notatag and more.\n\nFinal paragraph.',
};

// Citations or math against a URL. href: what the link must point to, link: its text, text: what shows.
const LINK_CASES = [
  { item: { text: 'See https://example.com/docs. More.', citations: [{ end_index: 29, url: 'https://example.com/c1', title: 'C1' }] }, href: 'https://example.com/docs', link: 'https://example.com/docs', text: 'See https://example.com/docs.1 More.', cites: 1 },
  { item: { text: 'See https://example.com/docs now', citations: [{ end_index: 28, url: 'https://example.com/c2', title: 'C2' }] }, href: 'https://example.com/docs', link: 'https://example.com/docs', text: 'See https://example.com/docs1 now', cites: 1 },
  { item: { text: 'See www.example.com/docs now', citations: [{ end_index: 24, url: 'https://example.com/c3', title: 'C3' }] }, href: 'http://www.example.com/docs', link: 'www.example.com/docs', text: 'See www.example.com/docs1 now', cites: 1 },
  { item: { text: 'See <https://example.com/docs> now', citations: [{ end_index: 29, url: 'https://example.com/c4', title: 'C4' }] }, href: 'https://example.com/docs', link: 'https://example.com/docs', text: 'See https://example.com/docs1 now', cites: 1 },
  { item: 'Go https://a.test/?a=$x$&b=$y$ now', href: 'https://a.test/?a=$x$&b=$y$', link: 'https://a.test/?a=$x$&b=$y$', text: 'Go https://a.test/?a=$x$&b=$y$ now', cites: 0 },
  { item: '[go](https://a.test/$x$/$y$) now', href: 'https://a.test/$x$/$y$', link: 'go', text: 'go now', cites: 0 },
  { item: '[mail](mailto:me$x$@a.test) now', href: 'mailto:me$x$@a.test', link: 'mail', text: 'mail now', cites: 0 },
];

function textChat() {
  return turnsChat('text', 'Text chat', [
    ...Object.values(TAG_WORDS),
    'Literal XMATHX0XEND and \u27E6T0M0\u27E7 with $y^2$ beside them.',
    { text: 'Area $x^2$ was **Done.** and more.', citations: [{ end_index: 25, url: 'https://example.com/a?x="1"&y=<2>', title: '"><b>Title</b>' }, { end_index: 2, url: 'https://example.com/z', title: 'Zed' }] },
    { text: 'Before.\n\n```\n$x$ in a fence\n```\n\n    $z$ indented\n\nInline `$q$` too, and [$w$](https://example.com/w "$t$").', citations: [{ end_index: 16, url: 'https://example.com/f', title: 'In a fence' }] },
    'See <https://example.com/auto> here.',
    ...LINK_CASES.map(c => c.item),
  ], '2026-01-02T00:00:00Z');
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'takeout-viewer-'));
  const file = path.join(dir, 'viewer.html');
  fs.writeFileSync(file, buildHtml([richChat(), plainChat('long', 'Long chat', 300, '2026-03-01T00:00:00Z'), plainChat('short', 'Short chat', 2, '2026-02-01T00:00:00Z'), textChat(), hostileChat()], '2026-11-05T12:00:00Z'));
  const url = 'file://' + file;
  const browser = await chromium.launch({ executablePath: process.env.CHROME_EXE });
  let failed = 0;
  const check = (n, ok, x = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n} ${ok ? '' : x}`); };
  const open = async (options = {}, target = url) => {
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
    await page.goto(target);
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
    check('sidebar lists every chat', chats.length === 5 && chats.includes('Short chat'), chats.join());
    check('footer counts the chats', (await page.textContent('#archive')) === 'Archive · 5 chats · read-only');
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
    await hostile.page.click('.item >> nth=4');
    await hostile.page.waitForSelector('.msg.assistant');
    await hostile.page.waitForFunction(n => document.querySelectorAll('.msg').length >= n, PIPELINE_PAYLOADS.length * 2, { timeout: 3000 }).catch(() => {});
    await hostile.page.waitForTimeout(500);
    const dom = await hostile.page.evaluate(() => {
      const box = document.getElementById('chat');
      return {
        hit: !!window.__hit, focused: !!document.activeElement.closest('.msg'), shown: box.querySelectorAll('.msg').length, bad: box.querySelectorAll('.prose script, .prose iframe, .prose svg:not(.ic), .prose style, .prose video, .prose audio').length,
        remote: [...box.querySelectorAll('.prose [src]')].filter(n => !n.src.startsWith('data:image/png')).length,
        js: box.querySelectorAll('a[href^="javascript" i]').length,
        clobbered: typeof document.getElementById !== 'function',
        styled: box.querySelectorAll('.prose [style]:not(.katex *)').length,
        bubble: box.querySelector('.bubble').textContent.includes('<script>'),
      };
    });
    check('hostile chat: nothing runs', !dom.hit, JSON.stringify(dom));
    check('hostile chat: no onfocus or autofocus takes the focus', !dom.focused, JSON.stringify(dom));
    check('hostile chat: every message shows', dom.shown === PIPELINE_PAYLOADS.length * 2, JSON.stringify(dom));
    const rawText = await hostile.page.$$eval('.msg.assistant .prose', p => p.map(x => x.textContent).join('\n'));
    check('hostile chat: raw HTML shows as text', rawText.includes('<frameset>') && rawText.includes(`<div x'y="$x$" <q=`), rawText.slice(-400));
    check('hostile chat: no dangerous element survives', dom.bad === 0, JSON.stringify(dom));
    check('hostile chat: nothing loads', dom.remote === 0, JSON.stringify(dom));
    check('hostile chat: no script links', dom.js === 0);
    check('hostile chat: no clobbering', !dom.clobbered);
    check('hostile chat: no inline styles', dom.styled === 0, JSON.stringify(dom));
    check('hostile chat: user text stays text', dom.bubble);
    check('hostile title stays text', (await hostile.page.textContent('#title')).startsWith('<img') && (await hostile.page.$$('#side img, #top img')).length === 0);

    await hostile.page.click('.item >> nth=3');
    await hostile.page.waitForFunction(() => document.querySelectorAll('.msg').length === 30, null, { timeout: 3000 }).catch(() => {});
    const proses = await hostile.page.$$eval('.msg.assistant', m => m.map(x => x.textContent.replace(/\s+/g, ' ')));
    Object.entries(TAG_WORDS).forEach(([name, text], i) => {
      const words = text.replace(/\n\n## /, ' ').replace(/\s+/g, ' ');
      check(`tag word shows literally: ${name}`, (proses[i] || '').includes(words), proses[i]);
    });
    check('a typed placeholder stays literal', (proses[4] || '').includes('Literal XMATHX0XEND and \u27E6T0M0\u27E7 with'), proses[4]);
    const marks = await hostile.page.evaluate(() => {
      const m = [...document.querySelectorAll('.msg.assistant')];
      const links = n => [...m[n].querySelectorAll('sup.cite a')].map(a => [a.textContent, a.getAttribute('href'), a.title]);
      return {
        typed: m[4].querySelectorAll('.katex').length, math: m[5].querySelectorAll('.katex').length, bold: m[5].querySelector('strong')?.textContent,
        cites: links(5), fenced: links(6).length, fence: m[6].querySelector('.code code')?.textContent,
        indented: m[6].querySelectorAll('.code code')[1]?.textContent, inline: m[6].querySelector('.prose :not(pre) > code')?.textContent,
        linkMath: m[6].querySelectorAll('.prose a .katex').length, linkTitle: m[6].querySelector('.prose a[title]')?.title,
        leftovers: document.getElementById('chat').textContent.includes('\u27E6T1'), auto: m[7].querySelector('a')?.getAttribute('href'),
      };
    });
    check('math renders beside a typed placeholder', marks.typed === 1, JSON.stringify(marks));
    check('math and citations render', marks.math === 1 && marks.cites.length === 2, JSON.stringify(marks));
    check('citation values stay intact', marks.cites[1] && marks.cites[1][1] === 'https://example.com/a?x="1"&y=<2>' && marks.cites[1][2] === '"><b>Title</b>', JSON.stringify(marks));
    check('a citation after bold leaves the bold working', marks.bold === 'Done.', JSON.stringify(marks));
    check('dollars in a fence stay literal', /^\$x\$ in a fence/.test(marks.fence || ''), JSON.stringify(marks));
    check('dollars in indented code stay literal', /^\$z\$ indented/.test(marks.indented || ''), JSON.stringify(marks));
    check('dollars in inline code stay literal', marks.inline === '$q$', JSON.stringify(marks));
    check('a citation inside code is dropped, not shown', marks.fenced === 0 && !marks.leftovers, JSON.stringify(marks));
    check('math in link text and titles', marks.linkMath === 1 && marks.linkTitle === '$t$', JSON.stringify(marks));
    check('angle-bracket links still work', marks.auto === 'https://example.com/auto', JSON.stringify(marks));

    const links = await hostile.page.evaluate(() => [...document.querySelectorAll('.msg.assistant')].slice(8).map(m => {
      const prose = m.querySelector('.prose');
      const a = prose.querySelector('a:not(sup a)');
      return {
        href: a && a.getAttribute('href'), link: a && a.textContent, text: prose.textContent.trim(), cites: prose.querySelectorAll('sup.cite').length,
        nested: prose.querySelectorAll('a sup, a a').length, math: prose.querySelectorAll('.katex').length,
      };
    }));
    LINK_CASES.forEach((c, i) => {
      const got = links[i] || {};
      const name = String(c.item.text || c.item).slice(0, 30);
      check(`link stays clean: ${name}`, got.href === c.href && got.link === c.link, JSON.stringify(got));
      check(`link text and citation in place: ${name}`, got.text === c.text && got.cites === c.cites && got.nested === 0 && got.math === 0, JSON.stringify(got));
    });
    const encoded = await hostile.page.$$eval('#chat *', els => els.flatMap(e => [...e.attributes]).filter(a => /%E2%9F%A[67]|\u27E6T\d/i.test(a.value)).map(a => a.value));
    check('no placeholder remains in any attribute', encoded.length === 0, encoded.join(' '));

    const broken = await hostile.page.evaluate(() => {
      const msg = (id, parent, blocks) => ({ id, parent, sender: 'assistant', at: '2026-01-01T00:00:00Z', blocks, uploads: [], attachments: [] });
      renderChat({ id: 'broken', title: 'Broken', messages: [msg('a', null, [{ t: 'text', text: 'first', cites: [] }]), msg('b', 'a', null), msg('c', 'b', [{ t: 'text', text: 'third', cites: [] }])], leaf: 'c' });
      return [...document.querySelectorAll('.msg')].map(m => m.textContent);
    });
    check('a failed message leaves the rest showing', broken.length === 3 && broken[0].includes('first') && broken[1].includes("This message couldn't be displayed") && broken[2].includes('third'), broken.join(' | '));

    const odd = await hostile.page.evaluate(() => ({
      names: sanitizeHtml('<div x\'y="1" a"b="2" data-ok="3" title="t">z</div>', new DOMParser()),
      comment: sanitizeHtml('a<!-- " x -->b', new DOMParser()),
      frames: sanitizeHtml('<frameset><frame></frameset>', new DOMParser()),
    }));
    check('sanitizeHtml drops odd attribute names', odd.names === '<div data-ok="3" title="t">z</div>', odd.names);
    check('sanitizeHtml drops comments', odd.comment === 'ab', odd.comment);
    check('sanitizeHtml survives a frameset', odd.frames === '', odd.frames);

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

    // autofocus only fires on a page's first chat, before anything has been clicked.
    for (const [i, payload] of PIPELINE_PAYLOADS.filter(t => t.includes('autofocus')).entries()) {
      const one = path.join(dir, `focus${i}.html`);
      fs.writeFileSync(one, buildHtml([turnsChat('one', 'One', [payload], '2026-01-01T00:00:00Z')], '2026-11-05T12:00:00Z'));
      const s = await open({}, 'file://' + one);
      await s.page.waitForTimeout(400);
      const state = await s.page.evaluate(() => ({ hit: !!window.__hit, focused: document.activeElement.tagName }));
      check(`no onfocus fires on open: ${payload.slice(0, 12)}`, !state.hit && state.focused === 'BODY', JSON.stringify(state));
      clean(`autofocus payload ${i}`, s.seen);
    }

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
