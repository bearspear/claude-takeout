// Viewer page: sidebar, top bar, message rendering and the file panel. Classic script, inlined after viewer-logic.js.
// Chat text is untrusted. Only sanitizeHtml's output reaches innerHTML; all else goes through textContent.
// KaTeX's output is the one addition, and goes in through fillPlaceholders. A generated file only ever
// runs in a frame with sandbox="allow-scripts"; its text reaches that frame as an attribute value.

const BATCH_SIZE = 10;
const FAST_BATCH_SIZE = 100; // messages a frame on the way to a search hit

const ICON_PATHS = {
  chevron: 'm9 6 6 6-6 6',
  close: 'M6 6l12 12M18 6 6 18',
  download: 'M12 4v11m-5-5 5 5 5-5M5 20h14',
  copy: 'M9 9h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1ZM5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1',
  check: 'm5 12.5 4.5 4.5L19 7.5',
  file: 'M6 3h8l5 5v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Zm8 0v5h5',
  terminal: 'm5 8 4 4-4 4M12 17h7',
  search: 'M11 17.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13ZM20 20l-4.4-4.4',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM3 12h18M12 3c2.5 2.6 3.7 5.6 3.7 9s-1.2 6.4-3.7 9c-2.5-2.6-3.7-5.6-3.7-9S9.5 5.6 12 3Z',
  pencil: 'M4 20l1-4L16 5a1.8 1.8 0 0 1 3 3L8 19l-4 1Z',
  wrap: 'M4 6h16M4 12h13a3 3 0 0 1 0 6h-5m0 0 2-2m-2 2 2 2M4 18h5',
  wrench: 'M15 6a4 4 0 0 1 5-1l-3 3 1.5 1.5 3-3a4 4 0 0 1-5.5 5L9 18a2 2 0 1 1-3-3l7-6.5A4 4 0 0 1 15 6Z',
};

const TOOL_ICONS = {
  web_search: 'search', web_fetch: 'globe', bash_tool: 'terminal', Bash: 'terminal',
  create_file: 'file', Write: 'file', view: 'file', read_file: 'file', Read: 'file', present_files: 'file',
  artifacts: 'file', SendUserFile: 'file', str_replace: 'pencil', Edit: 'pencil', str_replace_based_edit_tool: 'pencil',
};

const SAFE_IMAGE_URI = /^data:image\/(png|jpeg|gif|webp);base64,/;
const SVG_NS = 'http://www.w3.org/2000/svg';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function icon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', `ic ic-${name}`);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', ICON_PATHS[name]);
  svg.append(path);
  return svg;
}

function formatDate(iso, options) {
  const d = new Date(iso);
  return iso && !isNaN(d) ? d.toLocaleString(undefined, options) : '';
}
const shortDate = iso => formatDate(iso, { month: 'short', day: 'numeric', year: 'numeric' });
const fullDate = iso => formatDate(iso, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

function timeStamp(at) {
  const text = fullDate(at);
  if (!text) return null;
  const node = el('time', 'when', text);
  node.dateTime = at;
  return node;
}

// Raw HTML in a chat displays as the text it is (markdownParser, viewer-logic.js).
const markdown = markdownParser(marked);

function renderMath(src, displayMode) {
  return katex.renderToString(src, { displayMode, throwOnError: false });
}

function copyButton() {
  const button = el('button', 'copy');
  button.type = 'button';
  button.append(icon('copy'), el('span', '', 'Copy'));
  return button;
}

// Copy for a whole file in a popup or the panel header. Always the file's text, even when a preview shows it rendered.
function fileCopyButton(name, text) {
  const button = copyButton();
  button.setAttribute('aria-label', `Copy ${name}`);
  button.addEventListener('click', () => copyWithFeedback(button, text));
  return button;
}

// Wrap for a file's text in a popup or the panel: one setting for both, remembered.
const WRAP_KEY = 'claude-takeout-wrap';
function setWrap(on, remember = true) {
  document.body.classList.toggle('wrap-code', on);
  for (const b of document.querySelectorAll('button.wrap')) b.setAttribute('aria-pressed', String(on));
  if (remember) try { localStorage.setItem(WRAP_KEY, on ? '1' : '0'); } catch (e) { /* kept for this page only */ }
}
function wrapButton() {
  const button = el('button', 'wrap');
  button.type = 'button';
  button.title = 'Wrap long lines';
  button.setAttribute('aria-pressed', String(document.body.classList.contains('wrap-code')));
  button.append(icon('wrap'), el('span', '', 'Wrap'));
  button.addEventListener('click', () => setWrap(!document.body.classList.contains('wrap-code')));
  return button;
}
// The header tools for a file's text: Wrap and Copy.
// Download for a file's text the viewer holds: saved through a blob: link (saveBytes, viewer-logic.js), never a link
// to the file on disk, so an .html or .svg is saved, not opened.
function hrefName(href) {
  const last = String(href).split('/').pop();
  try { return decodeURIComponent(last); } catch (e) { return last; }
}
function fileDownloadButton(name, text) {
  const button = el('button', 'copy download');
  button.type = 'button';
  button.setAttribute('aria-label', `Download ${name}`);
  button.append(icon('download'), el('span', '', 'Download'));
  button.addEventListener('click', () => saveBytes(name, text));
  return button;
}

const fileTextTools = (name, text) => [wrapButton(), fileCopyButton(name, text), fileDownloadButton(name, text)];

// A code block's frame: a header with its language and a Copy button. The caller adds the pre.
function codeBlock(lang) {
  const wrap = el('div', 'code');
  const head = el('div', 'code-head');
  head.append(el('span', '', lang), copyButton());
  wrap.append(head);
  return wrap;
}

// ---- Syntax colors ----
// highlight.js can take minutes on some text, such as one very long word, so it runs in a worker
// that can be stopped. Colors are only ever added: a block that fails or runs late stays plain.
const HIGHLIGHT_TIMEOUT = 1500;
const HIGHLIGHT_WORKER = `
${tameMarkdown}
tameMarkdown(hljs);
self.onmessage = e => {
  let html = null;
  try {
    if (hljs.getLanguage(e.data.lang)) html = hljs.highlight(e.data.text, { language: e.data.lang, ignoreIllegals: true }).value;
  } catch (err) { html = null; }
  self.postMessage({ id: e.data.id, html });
};`;
const colorQueue = [];
let colorWorker = null, colorUrl = '', colorJob = null, colorTimer = 0, colorJobs = 0, colorsOff = false;

function stopColors() {
  colorsOff = true;
  colorQueue.length = 0;
  colorJob = null;
  clearTimeout(colorTimer);
  if (colorWorker) colorWorker.terminate();
  colorWorker = null;
}

function startColorWorker() {
  const source = document.getElementById('highlighter');
  colorUrl = colorUrl || URL.createObjectURL(new Blob([source.textContent, HIGHLIGHT_WORKER], { type: 'text/javascript' }));
  colorWorker = new Worker(colorUrl);
  colorWorker.onerror = stopColors;
  colorWorker.onmessage = e => {
    if (!colorJob || e.data.id !== colorJob.id) return;
    clearTimeout(colorTimer);
    const job = colorJob;
    colorJob = null;
    if (e.data.html !== null) applyColors(job, e.data.html);
    nextColor();
  };
}

function nextColor() {
  if (colorsOff || colorJob) return;
  // A block that has left the page (another version, file or chat) isn't worth coloring.
  let job;
  do job = colorQueue.shift(); while (job && !job.node.isConnected);
  if (!job) return;
  try {
    if (!colorWorker) startColorWorker();
    colorJob = job;
    colorTimer = setTimeout(() => {
      colorWorker.terminate();
      colorWorker = null;
      colorJob = null;
      nextColor();
    }, HIGHLIGHT_TIMEOUT);
    colorWorker.postMessage({ id: job.id, text: job.text, lang: job.lang });
  } catch (e) {
    stopColors();
  }
}

// The text must come back exactly as it went in, so Copy and search see what the chat holds.
function applyColors(job, html) {
  const { node, text } = job;
  if (!node.isConnected || node.childElementCount || node.textContent !== text) return;
  const colored = document.createElement('code');
  colored.innerHTML = sanitizeHtml(`<span>${html}</span>`, new DOMParser());
  if (colored.textContent !== text.replace(/\r\n?/g, '\n')) return;
  node.replaceChildren(...colored.childNodes);
  node.classList.add('colored');
}

const colorLanguages = new WeakMap();
const colorWatch = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    colorWatch.unobserve(entry.target);
    const lang = colorLanguages.get(entry.target);
    if (colorsOff || !lang) continue;
    colorQueue.push({ id: ++colorJobs, node: entry.target, text: entry.target.textContent, lang });
  }
  nextColor();
}, { scrollMargin: '400px' }) : null;

// node: an element holding only text. Colors arrive once it scrolls into view.
function colorWhenSeen(node, lang) {
  if (!colorWatch || !lang || node.childElementCount || node.textContent.length > HIGHLIGHT_LIMIT) return;
  colorLanguages.set(node, lang);
  colorWatch.observe(node);
}

// Code fences become code blocks. Wide tables scroll on their own.
function dressMarkdown(box) {
  box.querySelectorAll('pre').forEach(pre => {
    const code = pre.querySelector('code');
    const lang = code && /(?:^|\s)language-(\S+)/.exec(code.className);
    const wrap = codeBlock(lang ? lang[1] : '');
    pre.replaceWith(wrap);
    wrap.append(pre);
    if (lang) colorWhenSeen(code, lang[1]);
  });
  box.querySelectorAll('table').forEach(table => {
    const wrap = el('div', 'table');
    table.replaceWith(wrap);
    wrap.append(table);
  });
}

// sources: shared across the message, so numbers don't restart in a later block.
// EMPHASIS_LIMIT (viewer-logic.js): a block with more * and _ than this is shown as plain text.
const PLAIN_NOTE = "This message was too complex to format, so it's shown as plain text.";

function renderText(block, sources) {
  if ((block.text.match(/[*_]/g) || []).length > EMPHASIS_LIMIT) {
    const plain = el('div', 'prose plain');
    plain.append(el('p', 'plain-note', PLAIN_NOTE), document.createTextNode(block.text));
    addCitations(block.text, block.cites, sources);  // no markers in plain text, but the Sources list stays
    return plain;
  }
  const mark = placeholderMark(block.text);
  const cited = addCitations(block.text, block.cites, sources, mark);
  const safe = protectMath(cited.text, mark);
  const box = el('div', 'prose');
  box.innerHTML = sanitizeHtml(markdown.parse(safe.text), new DOMParser());
  fillPlaceholders(box, { mark, math: safe.math, sources, render: renderMath });
  dressMarkdown(box);
  return box;
}

function foldLine(kind, summaryParts, body) {
  const line = el('details', `line ${kind}`);
  const summary = el('summary');
  summary.append(...summaryParts, icon('chevron'));
  summary.lastChild.classList.add('chev');
  line.append(summary, body);
  return line;
}

// "Thought for 23s" when the block's timestamps say, else "Thought process".
const thoughtFor = block => (Number.isFinite(block.seconds) ? `Thought for ${block.seconds}s` : 'Thought process');

// Thinking as one line. claude.ai labels it by its summary; with none, how long it took.
function renderThinking(block) {
  const label = el('span', 'label', block.summary ? '' : thoughtFor(block));
  if (block.summary) label.append(el('span', 'gist', block.summary));
  const body = el('div', 'line-body');
  const steps = block.summaries || [];
  if (block.text.trim()) body.append(el('div', 'line-text', block.text));
  else {
    // claude.ai leaves the full text out of what it sends, often keeping only summaries.
    for (const step of steps) body.append(el('p', 'line-step', step));
    body.append(el('p', 'line-note', steps.length ? "Claude's full thinking isn't in this export, only these summaries." : "Claude's thinking isn't in this export."));
  }
  return foldLine('thinking', [label], body);
}

function toolPart(title, text, bad) {
  const part = el('div', bad ? 'tool-part bad' : 'tool-part');
  part.append(el('h4', '', title), el('pre', '', text));
  return part;
}

// A tool call as one of claude.ai's step rows: "Read IMG_3508.jpg", the file name darker, "Failed" in red,
// a thumbnail when the result has an image. Open, it shows the request and the response, and the images.
const toolImageOk = src => typeof src === 'string' && (SAFE_IMAGE_URI.test(src) || (SAVED_WEB_IMAGE.test(src) && !/(^|\/)\.\.?(\/|$)/.test(src)));
// gallery: the images of the step group this row is in, [{ href, title }], so a picture opens there.
const READ_TOOL = /^(Read|view|read_file)$/;
function renderTool(block, gallery = null) {
  const label = String(block.label || '');
  const target = block.target && label.endsWith(block.target) ? block.target : '';
  const parts = [el('span', 'label', target ? label.slice(0, label.length - target.length) : label)];
  if (target) parts[0].append(el('span', 'target', target));
  if (block.detail) parts.push(el('span', 'gist', block.detail));
  if (typeof block.link === 'string' && /^https?:\/\//i.test(block.link)) {
    const a = el('a', 'step-link', block.link);
    a.href = block.link; a.target = '_blank'; a.rel = 'noopener noreferrer';
    // Following the link mustn't also open or close the step.
    a.addEventListener('click', e => e.stopPropagation());
    parts.push(a);
  }
  if (block.error) parts.push(el('span', 'fail', 'Failed'));
  const body = el('div', 'line-body');
  const images = (block.images || []).filter(toolImageOk);
  // A file Claude read that was a picture opens to the picture alone, as on claude.ai.
  const pictureOnly = images.length && READ_TOOL.test(String(block.name)) && !block.error;
  const input = pictureOnly ? '' : toolInputText(block.input);
  if (input) body.append(toolPart('Request', input));
  if (block.result && !pictureOnly) body.append(toolPart('Response', block.result, block.error));
  if (images.length) {
    const row = el('div', 'tool-images');
    for (const src of images) {
      const button = el('button', 'tool-image');
      button.type = 'button';
      button.setAttribute('aria-label', `View image: ${block.label || 'Image'}`);
      const img = el('img');
      img.src = src;
      img.alt = block.label || 'Image from a tool result';
      img.loading = 'lazy';
      button.append(img);
      const items = gallery && gallery.length ? gallery : images.map(href => ({ href, title: block.label || '' }));
      const start = Math.max(0, items.findIndex(item => item.href === src));
      button.addEventListener('click', () => openGallery(items, start, button));
      row.append(button);
    }
    body.prepend(row);
  }
  const missing = block.missingImages || 0;
  if (missing > 0) body.append(el('div', 'tool-part missing-image', missing === 1 ? 'Image not in this export' : `${missing} images not in this export`));
  if (!input && !block.result && !missing && !images.length) body.append(el('div', 'line-text', 'No details in this export'));
  const line = foldLine('tool', parts, body);
  if (images.length) line.querySelector('summary').append(thumbs(images.slice(0, 1), 0));
  return [line];
}

// A page Claude published on claude.ai: a link to it, as claude.ai shows the artifact after the steps.
function renderPublished(page) {
  const box = el('div', 'published');
  box.append(icon('globe'), el('span', 'label', 'Published on claude.ai: '));
  const link = el('a', '', page.title || page.url);
  link.href = page.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
  box.append(link);
  return box;
}

// The links under a published page's card: Open artifact, when the page is one of the export's artifacts (its page
// on the Artifacts screen), and the claude.ai link, the one place the message links the page.
const PAGE_URL = /^https:\/\/claude\.ai\/artifact\/[A-Za-z0-9_-]{1,64}$/;
function pageLink(file) {
  if (!file || !file.published) return null;
  const url = String(file.published.url || '');
  const artifact = artifactsApp && typeof file.artifact === 'string' && parseArtifactHash('#a=' + file.artifact) ? file.artifact : null;
  if (!PAGE_URL.test(url) && !artifact) return null;
  const box = el('div', 'page-link');
  if (artifact) {
    const open = el('a', 'open-artifact', 'Open artifact');
    open.href = '#a=' + artifact;
    box.append(open);
  }
  if (PAGE_URL.test(url)) {
    const link = el('a', '', 'Open on claude.ai');
    link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer';
    box.append(icon('globe'), link);
  }
  return box;
}

// Small pictures at the end of a step line; more: how many aren't shown.
function thumbs(srcs, more) {
  const box = el('span', 'thumbs');
  if (more > 0) box.append(el('span', 'more', `+${more}`));
  for (const src of srcs) {
    const img = el('img');
    img.src = src;
    img.alt = '';
    img.loading = 'lazy';
    box.append(img);
  }
  return box;
}

// What a group of steps did, as claude.ai sums it up: "Read 9 files, ran 2 commands", or the first two
// kinds and "and 4 more steps". Kinds in this order; other tools count only as steps.
const STEP_KINDS = [
  [/^(create_file|Write)$/, 'created a file', n => `created ${n} files`],
  [/^(str_replace|Edit|str_replace_based_edit_tool)$/, 'edited a file', n => `edited ${n} files`],
  [/^(Read|view|read_file)$/, 'read a file', n => `read ${n} files`],
  [/^(Bash|bash_tool)$/, 'ran a command', n => `ran ${n} commands`],
  [/(^|__|:)(web_search|image_search)$/, 'searched the web', n => `ran ${n} searches`],
  [/^web_fetch$/, 'fetched a page', n => `fetched ${n} pages`],
];
function stepsSummary(tools) {
  const counts = STEP_KINDS.map(([re]) => tools.filter(t => re.test(t.name)).length);
  const phrases = [];
  let counted = 0;
  STEP_KINDS.forEach(([, one, many], i) => {
    if (!counts[i] || phrases.length === 2) return;
    phrases.push(counts[i] === 1 ? one : many(counts[i]));
    counted += counts[i];
  });
  const rest = tools.length - counted;
  let text;
  if (!phrases.length) text = tools.length === 1 ? String(tools[0].label || 'used a tool') : `took ${tools.length} steps`;
  else if (!rest) text = phrases.join(', ');
  else text = `${phrases.join(', ')}${phrases.length > 1 ? ',' : ''} and ${rest} more step${rest === 1 ? '' : 's'}`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// Everything Claude did before its answer, folded into one line as claude.ai does: thinking, tool calls and
// the text between them, as rows in a box. Thinking alone shows as its own line, labelled by its summary.
const OUTPUT_TOOL = /(^|__|:)(show_widget|image_search|publish_files|\w+_display_v\d+|ask_user_input_v\d+)$/;
// A tool block shown as output, not as a step: by its name, or marked by the data (an Artifact tool publish).
const isOutputTool = b => b.t === 'tool' && (!!b.output || OUTPUT_TOOL.test(String(b.name)));
function renderSteps(blocks, sources, first = true) {
  blocks = blocks.filter(b => !isOutputTool(b));
  // Thinking with nothing to show (no text, no summary) only adds to the time, as on claude.ai.
  const seconds = blocks.reduce((n, b) => n + (b.t === 'thinking' && Number.isFinite(b.seconds) ? b.seconds : 0), 0);
  const all = blocks;
  blocks = blocks.filter(b => !(b.t === 'thinking' && !String(b.text || '').trim() && !b.summary && !(b.summaries || []).length));
  if (!blocks.length) {
    const thought = all.find(b => b.t === 'thinking');
    return first && thought ? renderThinking({ ...thought, seconds: seconds || thought.seconds }) : null;
  }
  const tools = blocks.filter(b => b.t === 'tool');
  const thinking = blocks.filter(b => b.t === 'thinking');
  if (!tools.length && blocks.length === 1 && thinking.length === 1) return renderThinking(blocks[0]);
  // One step alone is its own line, as claude.ai shows it: "Read github.com https://github.com/...".
  if (blocks.length === 1 && tools.length === 1) return renderTool(tools[0])[0];
  const box = el('div', 'steps-box');
  const gallery = tools.flatMap(t => (t.images || []).filter(toolImageOk).map(href => ({ href, title: t.label || '' })));
  for (const block of blocks) {
    if (block.t === 'thinking') box.append(renderThinking(block, true));
    else if (block.t === 'tool') box.append(...renderTool(block, gallery));
    else if (block.t === 'text' && block.text) {
      const row = el('div', 'step-text');
      row.append(renderText(block, sources));
      box.append(row);
    }
  }
  const last = thinking.length ? thinking[thinking.length - 1] : null;
  const label = tools.length ? stepsSummary(tools) : ((last && last.summary) || thoughtFor({ seconds: seconds || (last && last.seconds) }));
  const line = foldLine('steps', [el('span', 'label', label)], box);
  const images = tools.flatMap(t => (t.images || []).filter(toolImageOk));
  if (images.length) line.querySelector('summary').append(thumbs(images.slice(0, 3), images.length - 3));
  return line;
}

// Images from web searches, as claude.ai shows them: one mosaic per response holding every search's
// images, the first four as tiles (three: a tall one and two stacked), the site on each, and a gallery
// that steps through them all. A saved copy is a relative path under images/ beside the viewer; one the
// export didn't save is a card with its title.
const SAVED_WEB_IMAGE = /^(?:[A-Za-z0-9%._~-]+\/)*images\/[A-Za-z0-9%._~-]+$/;
const MOSAIC_TILES = 4;
// A diagram (label 'Diagram') opens in the gallery from its SVG data URL; an image can't run its scripts.
const DIAGRAM_URL = 'data:image/svg+xml;charset=utf-8,';
const savedImage = item => toolImageOk(item.href) || (item.label === 'Diagram' && typeof item.href === 'string' && item.href.startsWith(DIAGRAM_URL));
// The size at 100% of a diagram's SVG, from its data URL.
function diagramNatural(item) {
  if (item.label !== 'Diagram' || !String(item.href).startsWith(DIAGRAM_URL)) return null;
  try { return svgNaturalSize(decodeURIComponent(item.href.slice(DIAGRAM_URL.length))); } catch (e) { return null; }
}
const httpsPage = item => (typeof item.page === 'string' && /^https:\/\//i.test(item.page) ? item.page : '');
const siteOf = item => item.source || (httpsPage(item) ? httpsPage(item).replace(/^https:\/\/(www\.)?/i, '').split('/')[0] : '');

// Every web image of a message, once each, in order.
function messageWebImages(m) {
  const seen = new Set();
  const out = [];
  for (const block of m.blocks) {
    if (block.t !== 'tool' || !Array.isArray(block.web)) continue;
    for (const item of block.web) {
      if (!item) continue;
      const key = savedImage(item) ? item.href : `${item.title}\n${item.page}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

function renderWebMosaic(items) {
  if (!items.length) return null;
  const box = el('div', 'web-results');
  // As claude.ai: tiles for the pictures that are there; one the export didn't save only fills a tile
  // when none was saved. The gallery still steps through them all.
  const saved = items.filter(savedImage);
  const shown = (saved.length ? saved : items).slice(0, MOSAIC_TILES);
  const grid = el('div', `web-mosaic n${shown.length}`);
  shown.forEach((item, i) => {
    const tile = el('button', 'tile');
    tile.type = 'button';
    tile.setAttribute('aria-label', `View image: ${item.title || 'Image'}`);
    if (savedImage(item)) {
      const img = el('img');
      img.src = item.href;
      img.alt = item.title || 'Image from a web search';
      img.loading = 'lazy';
      tile.append(img);
    } else {
      tile.classList.add('not-saved');
      tile.append(el('span', 'tile-title', item.title || 'Image'), el('span', 'tile-note', 'Not in this export'));
    }
    const site = siteOf(item);
    if (site) tile.append(el('span', 'tile-site', site));
    const more = items.length - shown.length;
    if (i === shown.length - 1 && more > 0) tile.append(el('span', 'tile-more', `+${more}`));
    tile.addEventListener('click', () => openGallery(items, items.indexOf(item), tile));
    grid.append(tile);
  });
  box.append(grid, el('div', 'web-caption', 'Results from the web'));
  return box;
}

function openGallery(items, start, trigger) {
  closePopup();
  let at = start;
  let zoom = null;
  const veil = el('div', 'veil gallery');
  const pop = el('div', 'gallery-pop');
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-modal', 'true');
  pop.setAttribute('aria-label', (items[start] && items[start].label) || 'Image preview');
  pop.tabIndex = -1;
  const close = el('button', 'close');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close');
  close.append(icon('close'));
  close.addEventListener('click', closePopup);
  const stage = el('div', 'gallery-stage');
  const info = el('div', 'gallery-info');
  const pos = el('span', 'pos');
  const step = (dir, label) => {
    const button = el('button', dir < 0 ? 'prev' : 'next');
    button.type = 'button';
    button.setAttribute('aria-label', label);
    button.append(icon('chevron'));
    button.addEventListener('click', () => show(at + dir));
    return button;
  };
  const prev = step(-1, 'Previous image');
  const next = step(1, 'Next image');
  const nav = el('div', 'gallery-nav');
  nav.append(prev, pos, next);
  const foot = el('div', 'gallery-foot');
  foot.append(info, nav);
  function show(i) {
    at = Math.max(0, Math.min(items.length - 1, i));
    const item = items[at];
    if (zoom) { zoom.destroy(); zoom = null; }
    if (savedImage(item)) {
      const img = el('img');
      img.src = item.href;
      img.alt = item.title || 'Image from a web search';
      stage.replaceChildren(img);
      zoom = pictureZoom(stage, img, { plainWheel: true, natural: diagramNatural(item) });
    } else {
      stage.replaceChildren(el('div', 'file-missing', 'This image is not in this export.'));
    }
    const parts = [];
    if (item.caption) parts.push(el('span', 'title', item.caption));
    else {
      const site = siteOf(item);
      if (site) parts.push(el('span', 'site', site));
      parts.push(el('span', 'title', item.title || 'Image'));
      const page = httpsPage(item);
      if (page) {
        const link = el('a', 'open', 'Open page');
        link.href = page; link.target = '_blank'; link.rel = 'noopener noreferrer';
        parts.push(link);
      }
    }
    info.replaceChildren(...parts);
    pos.textContent = `${at + 1} of ${items.length}`;
    prev.disabled = at === 0;
    next.disabled = at === items.length - 1;
    nav.hidden = items.length < 2;
  }
  pop.append(close, stage, foot);
  veil.append(pop);
  // A drag over the picture is not a click on the background.
  veil.addEventListener('click', e => { if ((e.target === veil || e.target === stage) && !(zoom && zoom.dragged)) closePopup(); });
  // Another picture starts at Fit; at either end, or with one picture, Left and Right do nothing.
  const go = dir => { const i = Math.max(0, Math.min(items.length - 1, at + dir)); if (i !== at) show(i); };
  veil.addEventListener('keydown', e => {
    if (zoom && zoom.key(e)) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
    else popupKeys(e);
  });
  show(start);
  document.body.append(veil);
  document.getElementById('app').inert = true;
  popup = { veil, trigger, onClose: () => { if (zoom) { zoom.destroy(); zoom = null; } } };
  pop.focus({ preventScroll: true });
}

function renderSources(sources) {
  const box = el('div', 'sources');
  const list = el('ol');
  for (const s of sources) {
    const item = el('li');
    const link = el('a', '', s.title || s.url);
    if (/^https?:\/\//i.test(s.url)) { link.href = s.url; link.target = '_blank'; link.rel = 'noopener'; }
    link.title = s.url;
    item.append(el('span', '', `${s.n}.`), link);
    list.append(item);
  }
  box.append(el('h4', '', 'Sources'), list);
  return box;
}

// item: { name, href, text } as the popup shows it.
function fileChip(item, note) {
  const name = item.name;
  const chip = el('button', 'chip');
  chip.type = 'button';
  chip.setAttribute('aria-haspopup', 'dialog');
  chip.addEventListener('click', () => openPopup(item, chip));
  const tile = el('span', 'tile');
  tile.append(icon('file'));
  const txt = el('span', 'txt');
  txt.append(el('b', '', name || 'Untitled'));
  if (note) txt.append(el('small', '', note));
  chip.append(tile, txt);
  chip.title = name || '';
  return chip;
}

// lines: the count kept for upload text that is in a part.
function fileNote(name, text, known) {
  const ext = (/\.([a-z0-9]{1,6})$/i.exec(name || '') || [])[1];
  const lines = text ? text.split('\n').length : (Number.isSafeInteger(known) ? known : 0);
  return [ext && ext.toUpperCase(), lines ? `${lines} line${lines === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ');
}

// Prompt text exactly as typed, with web addresses as links, as claude.ai shows them. A trailing
// full stop or bracket stays text.
const PROMPT_URL = /https?:\/\/[^\s<>"']+/g;
function typedText(text) {
  const box = el('div', 'typed');
  let at = 0;
  for (const m of String(text).matchAll(PROMPT_URL)) {
    let url = m[0];
    // Punctuation ending a sentence isn't part of the address; a ) is only when it opened no (.
    for (;;) {
      if (/[.,;:!?]$/.test(url)) url = url.slice(0, -1);
      else if (url.endsWith(')') && (url.match(/\)/g) || []).length > (url.match(/\(/g) || []).length) url = url.slice(0, -1);
      else break;
    }
    if (m.index > at) box.append(document.createTextNode(text.slice(at, m.index)));
    const a = el('a', '', url);
    a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
    box.append(a);
    at = m.index + url.length;
  }
  if (at < text.length) box.append(document.createTextNode(text.slice(at)));
  return box;
}

// About 200px of prompt: more than nine lines, counting a long line as the lines it wraps to.
const PROMPT_LINES = 9;
const PROMPT_LINE_CHARS = 70;
function longPrompt(text) {
  let lines = 0;
  for (const line of String(text).split('\n')) {
    lines += Math.max(1, Math.ceil(line.length / PROMPT_LINE_CHARS));
    if (lines > PROMPT_LINES) return true;
  }
  return false;
}

function setCollapsed(bubble, collapsed) {
  bubble.classList.toggle('collapsed', collapsed);
  const toggle = bubble.querySelector(':scope > .more-toggle');
  if (toggle) {
    toggle.textContent = collapsed ? 'Show more' : 'Show less';
    toggle.setAttribute('aria-expanded', String(!collapsed));
  }
}

// What a search hit needs to be seen: its folds open and its prompt expanded.
function reveal(mark) {
  for (let fold = mark && mark.closest('details'); fold; fold = fold.parentElement.closest('details')) fold.open = true;
  const bubble = mark && mark.closest('.bubble.collapsed');
  if (bubble) setCollapsed(bubble, false);
}

function renderHuman(m) {
  const node = el('section', 'msg human');
  const pasted = attachmentNames(m.attachments);
  const chips = [
    ...(m.uploads || []).map(u => {
      const item = u.name ? u : { ...u, name: uploadName(u) };
      return fileChip(item, fileNote(item.name, item.text, item.lines));
    }),
    ...(m.attachments || []).map((a, i) => fileChip({ name: pasted[i], href: null, text: a.text },
      a.name ? fileNote(a.name, a.text) : ['Pasted', fileNote('', a.text)].filter(Boolean).join(' · '))),
  ];
  if (chips.length) {
    const row = el('div', 'chips');
    row.append(...chips);
    node.append(row);
  }
  const text = m.blocks.filter(b => b.t === 'text').map(b => b.text).join('\n\n');
  if (text) {
    // Code fences show as code blocks. The rest stays exactly as typed.
    const bubble = el('div', 'bubble');
    const body = el('div', 'bubble-body');
    for (const part of splitFences(text)) {
      if (part.t === 'text') { body.append(typedText(part.text)); continue; }
      const pre = document.createElement('pre');
      const code = el('code', '', part.text);
      pre.append(code);
      const block = codeBlock(part.lang);
      block.append(pre);
      colorWhenSeen(code, part.lang);
      body.append(block);
    }
    bubble.append(body);
    // A long prompt shows its first lines, faded, with Show more, as claude.ai shows it.
    if (longPrompt(text)) {
      bubble.classList.add('long', 'collapsed');
      const toggle = el('button', 'more-toggle', 'Show more');
      toggle.type = 'button';
      toggle.setAttribute('aria-expanded', 'false');
      toggle.addEventListener('click', () => setCollapsed(bubble, !bubble.classList.contains('collapsed')));
      bubble.append(toggle);
    }
    node.append(bubble);
  }
  return chips.length || text ? node : null;
}

// The popup. Uploaded text only ever goes in through textContent, so an uploaded .html is source, never a page.
// Images and PDFs are chosen by name; the page's CSP allows them from file: only.
const POPUP_IMAGE = /\.(?:png|jpe?g|gif|webp)$/i;
const POPUP_PDF = /\.pdf$/i;
let popup = null; // { veil, trigger }

function openLink(href) {
  const link = el('a', 'file-open', 'Open file');
  link.setAttribute('href', href);
  link.setAttribute('target', '_blank');
  link.setAttribute('rel', 'noopener');
  return link;
}

// A picture in a .file-paper that zooms and pans in place (a plain wheel scrolls). Returns the frame to show
// and its controller. opts: pictureZoom's.
function zoomPaper(src, alt, opts = {}) {
  const img = el('img', opts.svg ? 'file-image svg-picture' : 'file-image');
  img.setAttribute('alt', alt);
  img.setAttribute('src', src);
  const paper = el('div', 'file-paper');
  paper.append(img);
  const zoom = pictureZoom(paper, img, opts);
  return { frame: zoom.frame, zoom };
}

// Returns the body nodes, the picture's zoom controller and, for a file the header can offer, a link.
function popupContent(item) {
  const name = item.name || 'Untitled';
  if (item.text === null && partsListed.has(item.part)) return { nodes: [el('div', 'file-loading', 'Loading…')], part: item.part };
  if (typeof item.text === 'string') {
    const code = el('pre', 'file-code');
    code.textContent = item.text;
    colorWhenSeen(code, languageOfFile(name));
    return { nodes: [code] };
  }
  if (!item.href) return { nodes: [el('div', 'file-missing', 'This file is not in this export.')] };
  if (POPUP_IMAGE.test(name)) {
    const { frame, zoom } = zoomPaper(item.href, name);
    return { nodes: [frame], zoom, link: openableHref(item.href) ? openLink(item.href) : null };
  }
  if (POPUP_PDF.test(name)) {
    const frame = el('iframe', 'preview');
    frame.setAttribute('title', name);
    frame.setAttribute('src', item.href);
    return { nodes: [frame], link: openableHref(item.href) ? openLink(item.href) : null };
  }
  const ext = (/\.([a-z0-9]{1,10})$/i.exec(name) || [])[1];
  const box = el('div', 'file-details');
  const tile = el('span', 'tile');
  tile.append(icon('file'));
  box.append(tile, el('b', '', name), el('small', '', ext ? `${ext.toUpperCase()} file` : 'File'));
  if (openableHref(item.href)) box.append(openLink(item.href));
  else box.append(el('p', '', "This file can't open from the viewer. It's in this export's folder."));
  return { nodes: [box] };
}

function closePopup() {
  if (!popup) return;
  const { veil, trigger, onClose } = popup;
  popup = null;
  if (onClose) onClose();
  veil.remove();
  document.getElementById('app').inert = false;
  if (document.contains(trigger)) trigger.focus({ preventScroll: true });
}

function popupKeys(e) {
  if (e.key === 'Escape') { e.preventDefault(); closePopup(); return; }
  if (e.key !== 'Tab') return;
  const pop = popup.veil.firstElementChild;
  const stops = [...pop.querySelectorAll('a[href], button, [tabindex="0"]')].filter(n => !n.disabled && !n.closest('[hidden]'));
  const last = stops.length - 1;
  const at = stops.indexOf(document.activeElement);
  if (!stops.length) { e.preventDefault(); pop.focus(); }
  else if (e.shiftKey && at <= 0) { e.preventDefault(); stops[last].focus(); }
  else if (!e.shiftKey && at === last) { e.preventDefault(); stops[0].focus(); }
}

function openPopup(item, trigger) {
  closePopup();
  const { nodes, link, part, zoom } = popupContent(item);
  const pop = el('div', 'pop');
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-modal', 'true');
  pop.setAttribute('aria-label', item.name || 'Untitled');
  pop.tabIndex = -1;
  const close = el('button', 'close');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close');
  close.append(icon('close'));
  close.addEventListener('click', closePopup);
  const head = el('div', 'pop-head');
  const title = el('b', 'pop-title', item.name || 'Untitled');
  head.append(title, ...(typeof item.text === 'string' ? fileTextTools(item.name || 'Untitled', item.text) : []), ...(link ? [link] : []), close);
  const body = el('div', 'pop-body');
  body.append(...nodes);
  pop.append(head, body);
  const veil = el('div', 'veil');
  veil.append(pop);
  veil.addEventListener('click', e => { if (e.target === veil) closePopup(); });
  veil.addEventListener('keydown', popupKeys);
  document.body.append(veil);
  document.getElementById('app').inert = true;
  const mine = popup = { veil, trigger, onClose: () => { if (zoom) zoom.destroy(); } };
  pop.focus({ preventScroll: true });
  // Large upload text is in a part. It lands only in the popup that asked for it.
  // The text is kept even when the popup has closed, so the next open is instant.
  if (part) loadPart(part).then(loaded => {
    const text = loaded && Object.prototype.hasOwnProperty.call(loaded, item.key) ? loaded[item.key] : null;
    if (typeof text === 'string') item.text = text;
    if (popup !== mine) return;
    body.replaceChildren(...(typeof text === 'string' ? popupContent(item).nodes : partMissing(item)));
    if (typeof text === 'string') title.after(...fileTextTools(item.name || 'Untitled', text));
  });
}

// A part that can't load: the upload's own copy, when the export has one, is still beside the viewer.
function partMissing(item) {
  if (!item.href) return [el('div', 'file-missing', 'This file is not in this export.')];
  const { nodes } = popupContent({ name: item.name, href: item.href });
  return [el('div', 'file-missing', "The text couldn't load."), ...nodes];
}

// The project's files and documents, under the top bar. Rebuilt only for another chat, so it stays open.
let projectFor = null;
function renderProject(chat) {
  if (projectFor === chat.id) return;
  projectFor = chat.id;
  const box = document.getElementById('project');
  const project = chat.project;
  const added = addedForChat(allAdded, chat.id);
  const items = project ? [
    ...(project.files || []).map(f => ({ name: f.name, href: f.href, text: null })),
    ...(project.docs || []).map(d => ({ name: d.name, href: null, text: d.text })),
  ] : [];
  const instructions = project && typeof project.instructions === 'string' ? project.instructions : '';
  box.hidden = !items.length && !instructions && !added.length;
  box.replaceChildren();
  if (box.hidden) return;
  const name = (project && project.name) || 'Untitled';
  // Folds, closed by default, because a project's prompt can be long.
  const fold = (kind, label) => {
    const details = el('details', kind);
    const head = el('summary');
    head.append(icon('chevron'), el('span', '', label));
    head.firstChild.classList.add('chev');
    details.append(head);
    box.append(details);
    return details;
  };
  if (instructions) {
    const text = el('div', 'instructions-text', instructions);
    text.tabIndex = 0;
    text.setAttribute('role', 'region');
    text.setAttribute('aria-label', 'Project instructions text');
    fold('instructions', items.length ? 'Project instructions' : `Project instructions · ${name}`).append(text);
  }
  if (items.length) {
    const row = el('div', 'chips');
    row.append(...items.map(item => fileChip(item, fileNote(item.name, item.text))));
    fold('project-files', `Project · ${name} · ${items.length} item${items.length === 1 ? '' : 's'}`).append(row);
  }
  if (added.length) {
    const details = fold('archive-files', `Archive files · ${added.length}`);
    details.addEventListener('toggle', () => { if (details.open && details.childElementCount === 1) details.append(addedBox(chat, added)); });
  }
}

// ---- Archive files ----
const ADDED_ROW_LIMIT = 200;
let allAdded = []; // ViewerData.added
let addedIds = new Map(); // entry -> its x id
const addedFiles = new Map(); // x id -> GenFile, holding its text once loaded

function addedRow(entry, label) {
  const row = el('button', 'add-file');
  row.type = 'button';
  row.title = entry.path;
  row.dataset.file = addedIds.get(entry);
  row.classList.toggle('on', openFile !== null && openFile.file === row.dataset.file);
  row.append(icon('file'), el('span', '', label));
  return row;
}

// One folder's rows, so a folder that stays closed costs nothing.
function addedLevel(node) {
  const level = el('div', 'add-level');
  for (const folder of node.folders) {
    const details = el('details');
    const head = el('summary');
    head.append(icon('chevron'), el('span', '', folder.name));
    head.firstChild.classList.add('chev');
    details.append(head);
    details.addEventListener('toggle', () => { if (details.open && details.childElementCount === 1) details.append(addedLevel(folder)); });
    level.append(details);
  }
  level.append(...node.files.map(entry => addedRow(entry, entry.path.split('/').pop())));
  return level;
}

function addedBox(chat, added) {
  const box = el('div', 'add-box');
  const filter = el('input', 'add-filter');
  filter.type = 'text';
  filter.placeholder = 'Filter by name';
  filter.autocomplete = 'off';
  filter.setAttribute('aria-label', 'Filter archive files by name');
  const tree = el('div', 'add-tree');
  tree.append(...addedTree(added, chat.id).map(addedLevel));
  const results = el('div', 'add-results');
  results.hidden = true;
  filter.addEventListener('input', () => {
    const q = filter.value.trim();
    tree.hidden = !!q;
    results.hidden = !q;
    results.replaceChildren();
    if (!q) return;
    const hits = filterAdded(added, q);
    const note = !hits.length ? 'No matches' : hits.length > ADDED_ROW_LIMIT ? `Showing first ${ADDED_ROW_LIMIT} of ${hits.length}` : `${hits.length} file${hits.length === 1 ? '' : 's'}`;
    results.append(el('div', 'add-count', note), ...hits.slice(0, ADDED_ROW_LIMIT).map(entry => addedRow(entry, entry.path)));
  });
  box.addEventListener('click', e => {
    const row = e.target.closest('.add-file');
    if (row) navigate({ ...parseHash(location.hash), file: row.dataset.file, version: 0 });
  });
  box.append(filter, results, tree);
  return box;
}

// A part's text arrives through window.__archivePart, called by viewer-files/part-NNNN.js. Page code can't read files.
const partsListed = new Set(); // the part numbers the data names
const partsLoaded = new Map(); // n -> the part's object, the most recently used last
const PARTS_KEPT = 2; // a part is about 4 MB; older ones are dropped and load again if needed
const partsWaiting = new Map(); // n -> resolve, only while its script is loading
const partsInFlight = new Map(); // n -> Promise<object|null>, only while loading; never evicted

// Parts hold the text of added files and of large uploads, and the Artifacts screen's texts and images (one numbering,
// one loader: the artifacts app is handed loadPart).
function setupParts(data) {
  allAdded = Array.isArray(data.added) ? data.added : [];
  addedIds = new Map(allAdded.map((entry, i) => [entry, `x${i}`]));
  const uploads = (data.chats || []).flatMap(chat => (chat.messages || []).flatMap(m => m.uploads || []));
  const versions = (data.chats || []).flatMap(chat => Object.values(chat.files || {}).flatMap(f => (f && f.versions) || []));
  const artifacts = Array.isArray(data.artifacts) ? data.artifacts : [];
  // An artifact's older versions read from disk by the old-archive tool can have previews of their own.
  const artifactVersions = artifacts.flatMap(a => (a && Array.isArray(a.versions) ? a.versions : []));
  for (const entry of [...allAdded, ...uploads, ...versions, ...artifacts, ...artifactVersions]) if (entry && Number.isSafeInteger(entry.part) && entry.part > 0) partsListed.add(entry.part);
  if (!partsListed.size) return;
  Object.defineProperty(window, '__archivePart', {
    value(n, data) {
      const done = partsWaiting.get(n);
      if (!done || data === null || typeof data !== 'object') return;
      partsWaiting.delete(n);
      done(data);
    },
  });
}

// The part's { key: text }, or null when it can't be loaded. Only a number from the data ever becomes a src.
// Loaded parts are kept (the PARTS_KEPT most recently used); one still loading is shared through partsInFlight,
// which nothing evicts, so a second load of it waits on the same script instead of replacing its resolver.
function loadPart(n) {
  if (!partsListed.has(n)) return Promise.resolve(null);
  if (partsLoaded.has(n)) {
    const kept = partsLoaded.get(n);
    partsLoaded.delete(n);
    partsLoaded.set(n, kept);
    return Promise.resolve(kept);
  }
  if (partsInFlight.has(n)) return partsInFlight.get(n);
  const loading = new Promise(resolve => {
    partsWaiting.set(n, resolve);
    const script = el('script');
    const finish = () => {
      script.remove();
      const done = partsWaiting.get(n);
      if (!done) return; // the part called in, and this was its load event
      partsWaiting.delete(n);
      done(null);
    };
    script.addEventListener('load', finish);
    script.addEventListener('error', finish);
    script.src = `viewer-files/part-${String(n).padStart(4, '0')}.js`;
    document.head.append(script);
  }).then(part => {
    partsInFlight.delete(n);
    // A part that failed isn't kept, so opening the file later tries again.
    if (part) {
      partsLoaded.set(n, part);
      while (partsLoaded.size > PARTS_KEPT) partsLoaded.delete(partsLoaded.keys().next().value);
    }
    return part;
  });
  partsInFlight.set(n, loading);
  return loading;
}

// FLAG_NOTES and flagNote (what a file's flag means) are in viewer-logic.js.

function renderCard(block, chat) {
  const file = resolveFile(chat.files, block.file, block.version) && chat.files[block.file];
  if (!file) return null;
  const card = el('button', 'art');
  card.type = 'button';
  card.dataset.file = block.file;
  card.dataset.version = String(block.version);
  card.classList.toggle('on', openFile !== null && openFile.file === block.file && openFile.version === block.version);
  const tile = el('span', 'tile');
  tile.append(icon('file'));
  const label = el('span', 'txt');
  const version = file.versions.length > 1 && file.versions[block.version];
  const shown = file.versions[block.version] || {};
  // A published page: whether this version is the file Claude wrote, and whether it only runs on claude.ai.
  const page = file.published ? [
    shown.same ? 'Same as published' : '',
    file.kind !== 'missing' && shown.text == null && shown.href == null ? 'Not in this export' : '',
    file.published.needsRuntime ? 'Needs claude.ai to run' : '',
  ] : [];
  label.append(el('b', '', file.name || 'Untitled'), el('small', '', [fileKindLabel(file), version && version.label, ...page].filter(Boolean).join(' · ')));
  card.append(tile, label);
  card.title = file.name || '';
  if (file.flag) {
    const soft = file.flag === 'draft' || file.flag === 'helper';
    card.append(el('span', soft ? 'flag soft' : 'flag', file.flag === 'draft' ? 'Draft' : file.flag === 'helper' ? 'Helper script' : 'May not match'));
    card.title = `${file.name || ''}\n${flagNote(file)}`;
  }
  return card;
}

// The Files list in the top bar: what Claude made, and what was uploaded or pasted, each once.
let filesOf = null; // chatFiles() for the chat on screen

function renderFilesButton(chat) {
  closeFilesMenu(false);
  filesOf = { chat, ...chatFiles(chat) };
  const count = filesOf.outputs.length + filesOf.uploads.length + filesOf.working.length;
  const button = document.getElementById('files-button');
  button.hidden = count === 0;
  button.querySelector('.n').textContent = String(count);
  button.setAttribute('aria-label', `Files in this chat: ${count}`);
}

function filesRow(name, note, onOpen) {
  const row = el('button', 'files-row');
  row.type = 'button';
  const tile = el('span', 'tile');
  tile.append(icon('file'));
  const txt = el('span', 'txt');
  txt.append(el('b', '', name), ...(note ? [el('small', '', note)] : []));
  row.append(tile, txt);
  row.title = name;
  row.addEventListener('click', onOpen);
  return row;
}

function openFilesMenu() {
  if (!filesOf) return;
  const { chat, outputs, working, uploads } = filesOf;
  const menu = document.getElementById('files-menu');
  const button = document.getElementById('files-button');
  const parts = [];
  const outputRows = list => list.map(o => {
    const file = chat.files[o.id];
    const note = [fileKindLabel(file), o.versions > 1 ? `${o.versions} versions` : '', file && file.flag ? (file.flag === 'draft' ? 'draft' : file.flag === 'helper' ? 'helper script' : 'may not match') : ''].filter(Boolean).join(' · ');
    return filesRow(o.name, note, () => {
      closeFilesMenu(false);
      panelReturn = button;
      navigate({ ...parseHash(location.hash), file: o.id, version: o.versions - 1 });
      // Keyboard focus goes to the panel, and back to the Files button when it closes.
      const close = document.querySelector('#panel-head .close');
      if (close) close.focus({ preventScroll: true });
    });
  });
  if (outputs.length) parts.push(el('div', 'files-lab', 'Outputs'), ...outputRows(outputs));
  if (uploads.length) {
    parts.push(el('div', 'files-lab', 'Uploads'));
    for (const u of uploads) {
      const note = u.pasted ? ['Pasted', fileNote('', u.item.text)].filter(Boolean).join(' · ') : fileNote(u.name, u.item.text, u.item.lines);
      parts.push(filesRow(u.name, note, () => {
        closeFilesMenu(false);
        openPopup(u.item, button);
      }));
    }
  }
  // Files Claude made along the way but didn't share, such as helper scripts.
  if (working.length) parts.push(el('div', 'files-lab', 'Working files'), ...outputRows(working));
  menu.replaceChildren(...parts);
  menu.setAttribute('role', 'dialog');  // only while open, so a closed list is no dialog
  menu.hidden = false;
  button.setAttribute('aria-expanded', 'true');
  const first = menu.querySelector('.files-row');
  if (first) first.focus({ preventScroll: true });
}

// refocus: put focus back on the button, as when the list is dismissed rather than used.
function closeFilesMenu(refocus = true) {
  const menu = document.getElementById('files-menu');
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  menu.removeAttribute('role');
  menu.replaceChildren();
  const button = document.getElementById('files-button');
  button.setAttribute('aria-expanded', 'false');
  if (refocus) button.focus({ preventScroll: true });
}

function setupFilesMenu() {
  const button = document.getElementById('files-button');
  const menu = document.getElementById('files-menu');
  button.addEventListener('click', () => (menu.hidden ? openFilesMenu() : closeFilesMenu()));
  menu.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFilesMenu(); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const rows = [...menu.querySelectorAll('.files-row')];
    const at = rows.indexOf(document.activeElement) + (e.key === 'ArrowDown' ? 1 : -1);
    if (rows[at]) rows[at].focus();
  });
  document.addEventListener('mousedown', e => {
    if (!menu.hidden && !menu.contains(e.target) && !button.contains(e.target)) closeFilesMenu(false);
  });
  // Tab out of the list closes it, as a click elsewhere does.
  menu.addEventListener('focusout', e => {
    const to = e.relatedTarget;
    if (!menu.hidden && to && !menu.contains(to) && !button.contains(to)) closeFilesMenu(false);
  });
}

// The visualize tool's guide, which claude.ai doesn't show as a step, and its multiple-choice
// questions, which it doesn't show once answered (the answers are the next prompt).
const HIDDEN_TOOL = /(^|__)visualize__read_me$|(^|__|:)ask_user_input_v\d+$/;
const inlineDiagram = (block, chat) => {
  const file = block.t === 'card' && chat.files ? chat.files[block.file] : null;
  return !!(file && file.widget && /\.svg$/i.test(file.name || ''));
};

// A response as claude.ai shows it: split at each diagram Claude drew, which shows inline where it was
// drawn; in each part, the steps fold into a line and the text after them is the answer.
function renderAssistant(m, chat) {
  const node = el('section', 'msg assistant');
  const sources = [];
  let part = [];
  let first = true;
  const flush = () => { renderPart(node, part, chat, sources, first); if (part.length) first = false; part = []; };
  for (const block of m.blocks) {
    if (block.t === 'tool' && HIDDEN_TOOL.test(String(block.name))) continue;
    if (block.t === 'tool' && block.display) {
      // Product cards show where Claude placed them, as on claude.ai.
      flush();
      const cards = renderDisplay(block.display);
      if (cards) node.append(cards);
      continue;
    }
    if (inlineDiagram(block, chat)) {
      flush();
      const diagram = renderDiagram(block, chat);
      if (diagram) node.append(diagram);
    } else part.push(block);
  }
  flush();
  if (!node.hasChildNodes()) return null;
  if (sources.length) node.append(renderSources(sources));
  return node;
}

function renderPart(node, blocks, chat, sources, first) {
  // The steps run up to the last thinking or tool block that isn't an output; the rest is the answer.
  let last = -1;
  blocks.forEach((block, i) => { if (block.t === 'thinking' || (block.t === 'tool' && !isOutputTool(block))) last = i; });
  const steps = blocks.slice(0, last + 1).filter(b => b.t !== 'card');
  const after = [...blocks.slice(0, last + 1).filter(b => b.t === 'card'), ...blocks.slice(last + 1)];
  const line = steps.length ? renderSteps(steps, sources, first) : null;
  if (line) node.append(line);
  const web = messageWebImages({ blocks });
  if (web.length) node.append(renderWebMosaic(web));
  for (const block of blocks) if (block.t === 'tool' && block.published) node.append(renderPublished(block.published));
  for (const block of after) {
    if (block.t === 'text') { if (block.text) node.append(renderText(block, sources)); }
    else if (block.t === 'card') {
      const card = renderCard(block, chat);
      if (card) node.append(card);
      const link = card && pageLink(chat.files[block.file]);
      if (link) node.append(link);
    }
  }
}

// claude.ai's product cards: a carousel of cards, one featured card, or a comparison table.
function renderDisplay(display) {
  const products = (display && display.products) || [];
  if (!products.length) return null;
  const box = el('div', `products ${display.kind}`);
  if (display.kind === 'comparison') {
    const table = el('div', 'compare');
    const head = el('div', 'compare-row compare-head');
    for (const p of products) {
      const cell = el('div');
      cell.append(el('div', 'product-name', p.name || ''));
      if (p.price) cell.append(el('div', 'product-price', p.price));
      head.append(cell);
    }
    table.append(head);
    const rows = Math.max(0, ...products.map(p => p.attributes.length));
    for (let r = 0; r < rows; r++) {
      const row = el('div', 'compare-row');
      for (const p of products) {
        const a = p.attributes[r] || { label: '', value: '' };
        const cell = el('div');
        cell.append(el('span', 'compare-label', a.label), el('span', 'compare-value', a.value));
        row.append(cell);
      }
      table.append(row);
    }
    box.append(table);
    return box;
  }
  const card = p => {
    const node = el('div', `product${display.kind === 'featured' ? ' featured' : ''}`);
    const pics = p.images.slice(0, 3);
    if (pics.length) {
      const grid = el('div', `product-pics n${pics.length}`);
      const items = p.images.map(img => ({ href: img.href, title: img.title || p.name, source: img.source, page: '' }));
      pics.forEach((img, i) => {
        const ok = savedImage({ href: img.href });
        const pic = el(ok ? 'button' : 'div', ok ? 'pic' : 'pic missing');
        if (ok) {
          pic.type = 'button';
          pic.setAttribute('aria-label', `View image: ${p.name || 'Product'}`);
          const im = el('img');
          im.src = img.href; im.alt = img.title || p.name || ''; im.loading = 'lazy';
          pic.append(im);
          pic.addEventListener('click', () => openGallery(items, i, pic));
        } else pic.textContent = 'Image unavailable';
        if (img.source && ok) pic.append(el('span', 'tile-site', img.source));
        grid.append(pic);
      });
      node.append(grid);
    }
    const body = el('div', 'product-body');
    body.append(el('div', 'product-name', p.name || ''));
    if (p.blurb) body.append(el('div', 'product-blurb', p.blurb));
    if (p.price) body.append(el('div', 'product-price', p.price));
    node.append(body);
    return node;
  };
  if (display.kind !== 'carousel' || products.length === 1) {
    box.append(...products.map(card));
    return box;
  }
  const track = el('div', 'carousel-track');
  track.append(...products.map(card));
  const nav = el('div', 'carousel-nav');
  const step = (dir, label) => {
    const b = el('button', dir < 0 ? 'prev' : 'next');
    b.type = 'button';
    b.setAttribute('aria-label', label);
    b.append(icon('chevron'));
    b.addEventListener('click', () => {
      const first = track.firstElementChild;
      track.scrollBy({ left: dir * (first ? first.getBoundingClientRect().width + 12 : 300), behavior: 'smooth' });
    });
    return b;
  };
  const prev = step(-1, 'Previous'), next = step(1, 'Next');
  const dots = el('div', 'carousel-dots');
  products.forEach(() => dots.append(el('span')));
  const update = () => {
    const max = track.scrollWidth - track.clientWidth;
    prev.disabled = track.scrollLeft <= 2;
    next.disabled = track.scrollLeft >= max - 2;
    const w = track.firstElementChild ? track.firstElementChild.getBoundingClientRect().width + 12 : 1;
    const at = Math.min(products.length - 1, Math.round(track.scrollLeft / w));
    [...dots.children].forEach((d, i) => d.classList.toggle('on', i === at));
  };
  track.addEventListener('scroll', update, { passive: true });
  requestAnimationFrame(update);
  nav.append(prev, dots, next);
  box.append(track, nav);
  return box;
}

// A diagram inline, drawn from its SVG, with claude.ai's menu: copy it, download it as SVG or PNG, and
// open it in the side panel.
function renderDiagram(block, chat) {
  const file = chat.files[block.file];
  const version = file && file.versions[block.version];
  const svg = version && typeof version.text === 'string' ? version.text : '';
  if (!/^\s*<svg[\s>]/i.test(svg)) return renderCard(block, chat);
  const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  const box = el('figure', 'diagram');
  const img = el('img');
  img.src = src;
  img.alt = file.name || 'Diagram';
  // The picture opens larger in a one-item gallery, where it zooms; the … menu stays outside this button.
  const title = String(file.name || 'Diagram').replace(/\.svg$/i, '');
  const open = el('button', 'diagram-open');
  open.type = 'button';
  open.setAttribute('aria-label', `Open ${title} larger`);
  open.append(img);
  open.addEventListener('click', () => openGallery([{ href: src, title, caption: title, label: 'Diagram' }], 0, open));
  box.append(open);
  const base = String(file.name || 'diagram').replace(/\.svg$/i, '');
  const more = el('button', 'diagram-more');
  more.type = 'button';
  more.setAttribute('aria-label', 'Diagram options');
  more.setAttribute('aria-haspopup', 'menu');
  more.textContent = '…';
  const menu = el('div', 'diagram-menu');
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  const note = el('span', 'diagram-note');
  const item = (label, run) => {
    const b = el('button', '', label);
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.addEventListener('click', async () => { close(); try { await run(); } catch (e) { flash("That didn't work here."); } });
    return b;
  };
  const flash = text => { note.textContent = text; clearTimeout(note.timer); note.timer = setTimeout(() => { note.textContent = ''; }, 2500); };
  const close = () => { menu.hidden = true; more.setAttribute('aria-expanded', 'false'); };
  const save = (href, name) => { const a = el('a'); a.href = href; a.download = name; document.body.append(a); a.click(); a.remove(); };
  menu.append(
    item('Copy as image', async () => {
      const png = await diagramPng(img);
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
      flash('Copied');
    }),
    item('Download as SVG', () => save(src, `${base}.svg`)),
    item('Download as PNG', async () => {
      const url = URL.createObjectURL(await diagramPng(img));
      save(url, `${base}.png`);
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    }),
    item('Open in sidebar', () => navigate({ ...parseHash(location.hash), file: block.file, version: block.version })),
  );
  more.addEventListener('click', () => {
    const open = menu.hidden;
    menu.hidden = !open;
    more.setAttribute('aria-expanded', String(open));
    if (open) menu.querySelector('button').focus();
  });
  box.addEventListener('keydown', e => { if (e.key === 'Escape' && !menu.hidden) { e.preventDefault(); close(); more.focus(); } });
  box.addEventListener('focusout', e => { if (!box.contains(e.relatedTarget)) close(); });
  box.append(more, menu, note);
  return box;
}

// The diagram as a PNG at twice its size, drawn from the SVG image already on the page.
async function diagramPng(img) {
  if (!img.complete) await new Promise((ok, bad) => { img.onload = ok; img.onerror = bad; });
  const w = img.naturalWidth || img.width || 680, h = img.naturalHeight || img.height || 400;
  const canvas = document.createElement('canvas');
  canvas.width = w * 2;
  canvas.height = h * 2;
  const ctx = canvas.getContext('2d');
  ctx.scale(2, 2);
  ctx.drawImage(img, 0, 0, w, h);
  return new Promise((ok, bad) => canvas.toBlob(b => (b ? ok(b) : bad(new Error('no image'))), 'image/png'));
}

// The ‹ 1 / 2 › control under a message with other versions. Buttons carry data-dir, -1 or 1.
function branchControl(sib) {
  const box = el('div', 'branch');
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', 'Message versions');
  const step = (dir, label) => {
    const button = el('button', dir < 0 ? 'prev' : 'next');
    button.type = 'button';
    button.dataset.dir = String(dir);
    button.setAttribute('aria-label', label);
    button.disabled = dir < 0 ? sib.index <= 0 : sib.index >= sib.ids.length - 1;
    button.append(icon('chevron'));
    return button;
  };
  box.append(step(-1, 'Previous version'), el('span', 'pos', `${sib.index + 1} / ${sib.ids.length}`), step(1, 'Next version'));
  return box;
}

function renderMessage(m, sib, chat) {
  let node;
  try {
    node = m.sender === 'human' ? renderHuman(m) : renderAssistant(m, chat);
  } catch (e) {
    console.warn('Could not display a message', m.id, e);
    node = el('section', 'msg failed', "This message couldn't be displayed");
  }
  if (!node) return null;
  node.dataset.id = m.id;
  // One row under the message: other versions, then the time and Copy, with
  // Copy on the outer edge of the bubble or response.
  const foot = el('div', 'foot');
  if (sib && sib.ids.length > 1) foot.append(branchControl(sib));
  const stamp = timeStamp(m.at);
  const human = m.sender === 'human';
  if (stamp && human) foot.append(stamp);
  const text = copyText(m);
  if (text && !node.classList.contains('failed')) {
    const copy = copyButton();
    copy.classList.add('copy-msg');
    copy.setAttribute('aria-label', human ? 'Copy prompt' : 'Copy response');
    copy.addEventListener('click', () => copyWithFeedback(copy, text));
    foot.append(copy);
  }
  if (stamp && !human) foot.append(stamp);
  if (foot.hasChildNodes()) node.append(foot);
  return node;
}

let renderGeneration = 0;

// Messages that share a parent with another message, by parent id. Roots share the key null.
function siblingCounts(messages) {
  const ids = new Set(messages.map(m => m.id));
  const counts = new Map();
  for (const m of messages) {
    const key = m.parent == null || !ids.has(m.parent) ? null : m.parent;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

// Any later call cancels the batches still pending from this one. leaf: the branch to show.
// anchor: { id, top } keeps that message where it was on screen, top being its offset in the scroll box.
// The chat's page on claude.ai, for a chat id that is a uuid; anything else gets no link.
function chatUrl(id) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id || '')) ? `https://claude.ai/chat/${id.toLowerCase()}` : null;
}

function renderChat(chat, leaf = chat.leaf, anchor = null) {
  const generation = ++renderGeneration;
  const box = document.getElementById('chat');
  const scroll = document.getElementById('scroll');
  const title = chat.title || 'Untitled';
  renderProject(chat);
  box.replaceChildren();
  if (!anchor) scroll.scrollTop = 0;
  document.getElementById('title').textContent = title;
  const meta = document.getElementById('meta');
  meta.textContent = [chat.model, shortDate(chat.created)].filter(Boolean).join(' · ');
  const live = chatUrl(chat.id);
  if (live) {
    const link = el('a', 'live-link', 'Open on claude.ai');
    link.href = live;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.title = 'The chat on claude.ai. It may no longer exist there.';
    if (meta.textContent) meta.append(' · ');
    meta.append(link);
  }
  renderFilesButton(chat);
  document.title = `${title} - Claude Takeout`;
  document.querySelectorAll('.item').forEach(item => item.setAttribute('aria-current', String(item.dataset.id === chat.id)));

  const chain = chainFrom(chat.messages, leaf);
  const counts = siblingCounts(chat.messages);
  const sibsOf = m => {
    const key = m.parent == null || !counts.has(m.parent) ? null : m.parent;
    return counts.get(key) > 1 ? siblingsOf(chat.messages, m.id) : null;
  };
  const place = () => {
    const node = anchor && box.querySelector(`.msg[data-id="${CSS.escape(anchor.id)}"]`);
    if (!node) return;
    scroll.scrollTop += node.getBoundingClientRect().top - scroll.getBoundingClientRect().top - anchor.top;
  };
  const anchorAt = anchor ? chain.findIndex(m => m.id === anchor.id) : -1;
  let next = 0;
  const batch = () => {
    if (generation !== renderGeneration) return;
    // The first batch reaches the anchor, so it can be put back in place at once.
    let size = next === 0 && anchorAt >= 0 ? Math.max(BATCH_SIZE, anchorAt + 1) : BATCH_SIZE;
    // A search hit or match far down is reached in bigger batches, not ten messages a frame.
    const target = find && find.msg ? chain.findIndex(m => m.id === find.msg) : -1;
    if (target >= next + size) size = Math.max(size, Math.min(target + 1 - next, FAST_BATCH_SIZE));
    const part = document.createDocumentFragment();
    for (const m of chain.slice(next, next + size)) {
      const node = renderMessage(m, sibsOf(m), chat);
      if (node) part.append(node);
    }
    const first = next === 0;
    next += size;
    box.append(part);
    if (first) place();
    tryFind();
    if (next < chain.length) requestAnimationFrame(batch);
    else if (anchor) requestAnimationFrame(place);
  };
  batch();
}

// True only when the text really reached the clipboard.
async function writeClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    const area = el('textarea');
    try {
      area.value = text;
      document.body.append(area);
      area.select();
      return document.execCommand('copy') === true;
    } catch (e2) {
      return false;
    } finally {
      area.remove();
    }
  }
}

// Shows "Copied" or "Copy failed" on a Copy button for a moment, then puts it back.
async function copyWithFeedback(button, text) {
  const ok = await writeClipboard(text);
  const label = button.querySelector('span');
  if (!label) return;
  clearTimeout(button.copyTimer);
  button.replaceChild(icon(ok ? 'check' : 'copy'), button.firstChild);
  label.textContent = ok ? 'Copied' : 'Copy failed';
  button.copyTimer = setTimeout(() => {
    button.replaceChild(icon('copy'), button.firstChild);
    label.textContent = 'Copy';
  }, 1500);
}

async function onCopy(button) {
  const code = button.closest('.code');
  const pre = code && code.querySelector('pre');
  if (pre) await copyWithFeedback(button, pre.textContent);
}

function setDrawer(open) {
  document.body.classList.toggle('drawer', open);
}

// The file panel. A chat's file, its version and the view: only the view isn't kept in the hash.
let openFile = null; // { file, version } as the hash has it
let panelFor = ''; // what the panel shows, so a hash change that leaves it alone doesn't reload a frame
let panelView = null;
// The picture in the panel and its zoom, kept across versions of one file. Ruling: a state restores only into the
// same kind of controller ('picture', or 'page' for a frame's own zoom).
let panelFileKey = ''; // `${chat}\n${file}\n`, as showPanel builds it, without the version
let panelPicture = null; // { fileKey, kind, controller }
let panelZoom = null; // { fileKey, kind, state }

// Keeps the zoom of the picture or page the panel shows, then lets it go. Called before the panel body changes.
function releasePanelPicture() {
  if (!panelPicture) return;
  const { fileKey, kind, controller } = panelPicture;
  panelPicture = null;
  if (!controller.failed) panelZoom = { fileKey, kind, state: controller.state() };
  controller.destroy();
}

// A zoom controller for the panel: starts where this file's last version was, else at Fit.
function panelPictureZoom(make) {
  const fileKey = panelFileKey;
  const made = make();
  panelPicture = { fileKey, kind: 'picture', controller: made.zoom };
  if (panelZoom && panelZoom.fileKey === fileKey && panelZoom.kind === 'picture') made.zoom.restore(panelZoom.state);
  return made;
}

// The same for a page in the panel: starts where this file's last version was, else at 100%.
function panelPageZoom(wrapper, frame) {
  const fileKey = panelFileKey;
  const controller = pageZoom(wrapper, frame);
  panelPicture = { fileKey, kind: 'page', controller };
  if (panelZoom && panelZoom.fileKey === fileKey && panelZoom.kind === 'page') controller.restore(panelZoom.state);
  return controller;
}

// Siblings are found by name, newest text of the last file with that name.
function siblingLookup(chat) {
  const texts = chatFileTexts(chat);
  return name => (texts.has(name) ? texts.get(name) : null);
}

// The order matters: sandbox goes on before the document does, and the frame only then joins the page.
function previewFrame(srcdoc, title) {
  const frame = el('iframe', 'preview');
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('title', title);
  frame.setAttribute('srcdoc', srcdoc);
  return frame;
}

function fileDetails(file, version) {
  const box = el('div', 'file-details');
  const tile = el('span', 'tile');
  tile.append(icon('file'));
  box.append(tile, el('b', '', file.name || 'Untitled'), el('small', '', fileKindLabel(file)));
  if (file.tooLarge) box.append(el('p', '', 'This file is too large to preview here'), el('small', 'file-path', file.path));
  if (version.partFailed) box.append(el('p', '', "The text couldn't load, because viewer-files/ is missing or blocked."));
  if (openableHref(version.href)) {
    const link = el('a', 'file-open', 'Open file');
    link.setAttribute('href', version.href);
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noopener');
    box.append(link);
  } else if (file.added && !file.tooLarge) {
    box.append(el('p', '', "This file can't open from the viewer. It's in this archive's folder."), el('small', 'file-path', file.path));
  } else if (!file.added) {
    const where = file.published && !version.same ? 'the published folder' : 'the artefacts folder';
    box.append(el('p', '', `This file can't open from the viewer. It's in ${where} of this export.`));
  }
  return box;
}

function previewNodes(chat, file, version) {
  if (file.kind === 'md') return [renderText({ text: version.text, cites: [] }, [])];
  if (file.kind === 'image') return [panelPictureZoom(() => zoomPaper(version.href, file.name || '')).frame];
  // An SVG shows as a picture, which runs nothing; one with scripts may need them, so it stays a page.
  if (file.kind === 'svg' && typeof version.text === 'string' && !svgHasScripts(version.text)) {
    let shown = null;
    // The strict XML parser refused it (no xmlns, an HTML entity, a bare &): the forgiving frame shows it.
    const fallback = zoom => {
      if (panelPicture && panelPicture.controller === zoom) panelPicture = null;
      zoom.destroy();
      if (shown && shown.parentNode) shown.replaceWith(...pageNodes(chat, file, version));
    };
    const { frame, zoom } = panelPictureZoom(() => zoomPaper(svgDataUrl(version.text), file.name || '', { svg: true, natural: svgNaturalSize(version.text), onError: fallback }));
    if (zoom.failed) return pageNodes(chat, file, version);
    shown = frame;
    return [frame];
  }
  return pageNodes(chat, file, version);
}

// Today's sandboxed preview of a file's text.
function pageNodes(chat, file, version) {
  if (file.kind === 'audio' || file.kind === 'video') {
    const media = el(file.kind, `file-${file.kind}`);
    media.controls = true;
    const paper = el('div', 'file-paper');
    media.addEventListener('error', () => {
      const box = fileDetails(file, version);
      box.append(el('p', '', "This file can't play here"), el('small', 'file-path', file.path));
      paper.replaceWith(box);
    });
    media.setAttribute('src', version.href);
    paper.append(media);
    return [paper];
  }
  if (file.kind === 'pdf') {
    // Chrome's PDF viewer refuses a sandboxed frame. fileViews only gives this view to a .pdf link.
    const frame = el('iframe', 'preview');
    frame.setAttribute('title', file.name || '');
    frame.setAttribute('src', version.href);
    return [frame];
  }
  // An added page is no part of the chat that happens to be open, so it gets none of that chat's files.
  const doc = previewDoc(version.text, file.added ? () => null : siblingLookup(chat));
  const frame = previewFrame(doc.srcdoc, file.name || '');
  // HTML, a scripted SVG and an SVG the picture refused: the page's own zoom bar.
  const wrapper = el('div', 'page-zoom');
  panelPageZoom(wrapper, frame);
  return doc.remote ? [el('div', 'file-note', REMOTE_NOTE), wrapper] : [wrapper];
}

function panelButton(className, text, pressed, onClick) {
  const button = el('button', className, text);
  button.type = 'button';
  button.classList.toggle('on', pressed);
  button.setAttribute('aria-pressed', String(pressed));
  button.addEventListener('click', onClick);
  return button;
}

function renderPanelBody(chat, file, version, shape) {
  const body = document.getElementById('panel-body');
  releasePanelPicture();
  const flagged = () => {
    if (file.flag) body.prepend(el('div', file.flag === 'draft' || file.flag === 'helper' ? 'file-note' : 'file-note flag-note', flagNote(file)));
    if (file.published && file.published.needsRuntime) body.prepend(el('div', 'file-note', 'This page uses claude.ai to run, so the preview here may not work. Open it on claude.ai.'));
    if (file.published && version.same) body.prepend(el('div', 'file-note', 'Same as published: claude.ai published this file as Claude wrote it.'));
  };
  if (shape.missing) body.replaceChildren(el('div', 'file-missing', 'This file is not in this export.'));
  else if (!shape.views.length) body.replaceChildren(fileDetails(file, version));
  else if (panelView === 'preview') body.replaceChildren(...previewNodes(chat, file, version));
  else {
    const code = el('pre', 'file-code');
    code.textContent = version.text;
    colorWhenSeen(code, languageOfFile(file.name));
    body.replaceChildren(...(shape.note ? [el('div', 'file-note', shape.note)] : []), code);
  }
  if (!shape.missing) flagged();
  body.scrollTop = 0;
}

// Where focus goes when the panel closes and no card shows its file: the Files button it was opened from.
let panelReturn = null;

function renderPanelHead(chat, id, file, at, shape) {
  const head = document.getElementById('panel-head');
  const focused = head.contains(document.activeElement) ? document.activeElement.textContent : null;
  const name = el('b', 'panel-title', file.name || 'Untitled');
  name.title = file.name || '';
  const tabs = shape.views.map(view => panelButton('tab', view === 'preview' ? 'Preview' : 'Code', view === panelView, () => {
    panelView = view;
    showPanel(chat, { file: id, version: at }, true);
  }));
  const versions = file.versions.length > 1 ? file.versions.map((v, i) => panelButton('ver', v.label || `v${i + 1}`, i === at, () => {
    navigate({ ...parseHash(location.hash), file: id, version: i }, { replace: true });
  })) : [];
  const row = el('div', 'vers');
  row.append(...versions);
  const close = el('button', 'close');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close file');
  close.append(icon('close'));
  close.addEventListener('click', () => {
    const card = document.querySelector('.art.on, .add-file.on');
    // Back where the file was opened from: the Files button, or else the card that shows it.
    const back = (panelReturn && panelReturn.isConnected && !panelReturn.hidden ? panelReturn : null) || card;
    panelReturn = null;
    navigate({ ...parseHash(location.hash), file: null, version: null });
    if (back) back.focus({ preventScroll: true });
  });
  const version = file.versions[at];
  // A version's own name (report_v2.html) from its link, else the file's.
  const versionName = version && typeof version.href === 'string' && version.href ? hrefName(version.href) : '';
  const copy = !shape.missing && shape.views.length && version && typeof version.text === 'string'
    ? [fileCopyButton(file.name || 'Untitled', version.text), fileDownloadButton(versionName || file.name || 'Untitled', version.text)] : [];
  // Wrap only shows with the code view; Preview renders the file.
  if (copy.length && panelView !== 'preview') copy.unshift(wrapButton());
  head.replaceChildren(name, el('small', 'panel-kind', fileKindLabel(file)), ...tabs, row, ...copy, close);
  if (focused) [...tabs, ...versions].find(b => b.textContent === focused)?.focus();
}

function panelFile(chat, id) {
  if (!isAddedId(id)) return chat.files[id];
  if (!addedFiles.has(id)) addedFiles.set(id, addedFile(allAdded, id));
  return addedFiles.get(id);
}

function drawPanel(chat, open, file, version) {
  const shape = fileViews(file.kind, version);
  if (!shape.views.includes(panelView)) panelView = shape.views[0] || null;
  renderPanelHead(chat, open.file, file, open.version, shape);
  renderPanelBody(chat, file, version, shape);
}

let panelLoad = 0; // goes up with every change of the panel, so a slow part can't draw over what came after it

// Shows Loading… until the part arrives. A part that can't be read leaves the file's own copy, or none.
function drawFromPart(chat, open, file, version) {
  const load = panelLoad;
  renderPanelHead(chat, open.file, file, open.version, { views: [] });
  releasePanelPicture();
  document.getElementById('panel-body').replaceChildren(el('div', 'file-loading', 'Loading…'));
  loadPart(version.part).then(part => {
    if (load !== panelLoad) return;
    const text = part && Object.prototype.hasOwnProperty.call(part, version.key) ? part[version.key] : null;
    if (typeof text === 'string') {
      version.text = text;
      drawPanel(chat, open, file, version);
    } else if (version.href) {
      // Its own copy in artefacts/ is still beside the viewer.
      drawPanel(chat, open, file, { ...version, text: null, partFailed: true });
    } else {
      drawPanel(chat, open, { ...file, kind: 'missing' }, { ...version, href: null });
    }
  });
}

// open: from resolveFile, or null to close. again: draw it even if it's what the panel already shows.
function showPanel(chat, open, again = false) {
  openFile = open;
  document.querySelectorAll('.art').forEach(card => {
    card.classList.toggle('on', open !== null && card.dataset.file === open.file && Number(card.dataset.version) === open.version);
  });
  document.querySelectorAll('.add-file').forEach(row => {
    row.classList.toggle('on', open !== null && row.dataset.file === open.file);
  });
  const panel = document.getElementById('panel');
  const fileKey = open ? `${chat.id}\n${open.file}\n` : '';
  const key = open ? fileKey + open.version : '';
  if (key === panelFor && !again) return;
  releasePanelPicture();
  // A new file starts at its first view, and its pictures at Fit.
  if (!fileKey || !panelFor.startsWith(fileKey)) { panelView = null; panelZoom = null; }
  panelFor = key;
  panelFileKey = fileKey;
  panelLoad++;
  panel.hidden = !open;
  if (!open) {
    document.getElementById('panel-head').replaceChildren();
    document.getElementById('panel-body').replaceChildren();
    return;
  }
  const file = panelFile(chat, open.file);
  const version = file.versions[open.version];
  if (version.part != null && version.text === null) drawFromPart(chat, open, file, version);
  else drawPanel(chat, open, file, version);
}

const chatsById = new Map();
let allChats = [];
let shown = ''; // the hash of what the page is showing, so a hashchange we caused isn't rendered again
let drawn = ''; // the chat and leaf in the column, which a change of file leaves alone

// The only way to change chat, leaf or file. Writes the hash, then renders. options.replace edits the
// current history entry; options.anchor keeps a message in place; options.fromHash means the hash is already set.
function navigate(state, options = {}) {
  const fromArtifacts = artifactsOn;
  showArtifacts(false);
  const known = chatsById.get(state.chat);
  const chat = known || allChats[0];
  if (!chat) return;
  // Leaf, file and version belong to the chat they came with, not to the one standing in for it.
  const want = known ? state : {};
  const ids = new Set(chat.messages.map(m => m.id));
  const chain = chainFrom(chat.messages, ids.has(want.leaf) ? want.leaf : chat.leaf);
  const leaf = chain.length ? chain[chain.length - 1].id : null;
  const open = resolveFile(chat.files, want.file, want.version, allAdded);
  const hash = formatHash({ chat: chat.id, leaf, file: open && open.file, version: open && open.version });
  if (!options.fromHash && hash !== location.hash) {
    if (options.replace) history.replaceState(null, '', hash);
    else location.hash = hash;
  } else if (options.fromHash && hash !== location.hash) history.replaceState(null, '', hash);
  shown = hash;
  if (fromArtifacts) document.querySelectorAll('.item').forEach(item => item.setAttribute('aria-current', String(item.dataset.id === chat.id)));
  if (stepper && stepper.chat !== chat.id) closeStepper();
  showPanel(chat, open);
  const column = `${chat.id}\n${leaf}`;
  if (column === drawn) return;
  drawn = column;
  renderChat(chat, leaf, options.anchor);
}

function onHashChange() {
  if (routeArtifacts(location.hash)) return;
  if (location.hash === shown && !artifactsOn) return;
  // An archive with artifacts and no chats has nothing else to show.
  if (!allChats.length && artifactsApp) { history.replaceState(null, '', '#artifacts'); routeArtifacts('#artifacts'); return; }
  navigate(parseHash(location.hash), { fromHash: true });
}

// ---- The Artifacts screen: the artifacts app (artifacts-app.js) in #artifacts-screen, in place of the chat ----
// #artifacts is its grid, #a=<id> an artifact and #ac=<chat>.<file> an In chats file; every other hash is the chat viewer's.
let artifactsApp = null; // the mounted app, only when the data has artifacts
let artifactsOn = false;
let titlesBefore = null; // the chat's page and top bar titles, put back when the screen closes

// The entry shows when the screen has something (artifactsEntry): a listed artifact or a file made in a chat.
function setupArtifacts(data) {
  const entry = artifactsEntry(data);
  if (!entry.show || !window.CTArtifactsApp) return;
  const nav = document.getElementById('artifacts-nav');
  nav.querySelector('.n').textContent = String(entry.count);
  nav.setAttribute('aria-label', `Artifacts, ${entry.count}`);
  nav.hidden = false;
  nav.addEventListener('click', () => {
    setDrawer(false);
    if (location.hash !== '#artifacts') location.hash = '#artifacts';
    else routeArtifacts('#artifacts');
  });
  artifactsApp = window.CTArtifactsApp.mount(document.getElementById('artifacts-screen'), { data, loadPart, onOpenChat: openChatAt });
}

// Shows the screen when hash is one of its own; returns whether it was.
function routeArtifacts(hash) {
  if (!artifactsApp) return false;
  // Taken before the app sets the page's title to the artifact's.
  const titles = artifactsOn ? null : { page: document.title, top: document.getElementById('title').textContent };
  if (!artifactsApp.route(hash)) return false;
  shown = hash;
  const wasOn = artifactsOn;
  showArtifacts(true, titles);
  // The page title took focus while the screen was hidden, which a browser ignores: again now it shows.
  if (!wasOn && typeof artifactsApp.refocus === 'function') artifactsApp.refocus();
  return true;
}

// titles: what to put back when the screen closes (opening only).
function showArtifacts(on, titles = null) {
  if (on === artifactsOn) return;
  if (!on && artifactsApp) artifactsApp.route(''); // lets go of an open artifact, whose page would keep running
  artifactsOn = on;
  document.body.classList.toggle('artifacts-on', on);
  document.getElementById('artifacts-screen').hidden = !on;
  document.getElementById('artifacts-nav').setAttribute('aria-current', String(on));
  const title = document.getElementById('title');
  if (on) {
    closeStepper();
    closeFilesMenu(false);
    titlesBefore = titles;
    title.textContent = 'Artifacts';
    document.querySelectorAll('.item').forEach(item => item.setAttribute('aria-current', 'false'));
  } else {
    if (titlesBefore) { document.title = titlesBefore.page; title.textContent = titlesBefore.top; }
    titlesBefore = null;
  }
}

// The artifacts app's way into a chat: chat is an index into the data's chats; the message, when it's there, is
// opened on its branch and scrolled to.
function openChatAt(index, messageUuid) {
  const chat = Number.isInteger(index) ? allChats[index] : null;
  if (!chat) return;
  closeStepper();
  if (!chat.messages.some(m => m.id === messageUuid)) { navigate({ chat: chat.id }); return; }
  find = { msg: messageUuid, terms: [], gen: null };
  navigate({ chat: chat.id, leaf: leafUnder(chat.messages, messageUuid) });
  if (!find) return;
  find.gen = renderGeneration;
  tryFind();
}

function switchTo(button) {
  const msg = button.closest('.msg');
  const hash = parseHash(location.hash);
  const chat = chatsById.get(hash.chat);
  if (!msg || !chat) return;
  const leaf = switchBranch(chat.messages, msg.dataset.id, Number(button.dataset.dir));
  if (leaf === null) return;
  const top = msg.getBoundingClientRect().top - document.getElementById('scroll').getBoundingClientRect().top;
  const next = chainFrom(chat.messages, leaf).find(m => m.parent === (chat.messages.find(x => x.id === msg.dataset.id) || {}).parent);
  const hadFocus = button.contains(document.activeElement) || document.activeElement === button;
  navigate({ ...hash, leaf }, { anchor: next ? { id: next.id, top } : null });
  // The control was rebuilt; keep keyboard focus on it, on the other arrow once this one is disabled.
  if (hadFocus && next) {
    const control = document.querySelector(`#chat .msg[data-id="${CSS.escape(next.id)}"] .branch`);
    const same = control && control.querySelector(`button[data-dir="${button.dataset.dir}"]`);
    const target = same && !same.disabled ? same : control && control.querySelector('button:not(:disabled)');
    if (target) target.focus({ preventScroll: true });
  }
}

function chatItem(chat) {
  const item = el('button', 'item', chat.title || 'Untitled');
  item.type = 'button';
  item.dataset.id = chat.id;
  item.title = chat.title || 'Untitled';
  item.addEventListener('click', () => { setDrawer(false); navigate({ chat: chat.id }); });
  return item;
}

function renderSidebar(chats) {
  const { recents, projects } = groupChats(chats);
  const holder = document.getElementById('recents');
  const list = document.getElementById('chat-list');
  list.append(...recents.map(chatItem));
  if (!recents.length) holder.firstElementChild.remove();
  for (const project of projects) {
    const group = el('div', 'list');
    group.append(...project.chats.map(chatItem));
    holder.append(el('div', 'lab', project.name), group);
  }
  if (!recents.length) list.remove();
  document.getElementById('archive').textContent = `Archive · ${chats.length} chat${chats.length === 1 ? '' : 's'} · read-only`;
}

// ---- Search ----
const GROUP_LIMIT = 200; // chats listed; each brings up to three snippets
let searchIndex = null;
let find = null; // { msg, terms, gen }: the highlight waiting for its message to be drawn

// Wraps the first match in a text node of the message with <mark>. A match across formatting is skipped.
// Marks the first occurrence in node of any of terms (lowercase), and returns the mark.
function highlightIn(node, terms) {
  const wanted = (terms || []).filter(Boolean);
  if (!wanted.length) return null;
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    if (text.parentElement.closest('button, time, .branch, .code-head, .katex, script, style')) continue;
    const { lower, at: map } = foldCase(text.data);
    let at = -1, q = '';
    for (const t of wanted) {
      const i = lower.indexOf(t);
      if (i >= 0 && (at < 0 || i < at || (i === at && t.length > q.length))) { at = i; q = t; }
    }
    if (at < 0) continue;
    const start = map ? map[at] : at, end = map ? map[at + q.length] : at + q.length;
    const middle = text.splitText(start);
    middle.splitText(end - start);
    const mark = document.createElement('mark');
    middle.replaceWith(mark);
    mark.append(middle);
    return mark;
  }
  return null;
}

// Runs once the target message exists, and only for the render that was asked for.
function tryFind() {
  if (!find || find.gen === null) return;
  if (find.gen !== renderGeneration) { find = null; return; }
  const node = document.getElementById('chat').querySelector(`.msg[data-id="${CSS.escape(find.msg)}"]`);
  if (!node) return;
  const { terms, nth } = find;
  if (nth === undefined) find = null;
  // An earlier search's highlight goes before this one is added.
  removeMarks();
  // Colors split code into pieces, and an occurrence across them would be missed, so code holding a
  // match goes plain first. Code without one keeps its colors; all get them back when the search ends.
  for (const code of node.querySelectorAll('.colored')) {
    const lower = code.textContent.toLowerCase();
    if (!terms.some(t => t && lower.includes(t))) continue;
    code.textContent = code.textContent;
    code.classList.remove('colored');
    plainForSearch.add(code);
  }
  if (nth !== undefined) {
    const { mark, count } = markNth(node, terms, nth);
    reveal(mark);
    stepLanded(mark, count);
    return;
  }
  const mark = highlightIn(node, terms);
  reveal(mark);
  (mark || node).scrollIntoView({ block: 'center' });
}

// Code blocks made plain so a match could be marked in them.
const plainForSearch = new Set();

function removeMarks() {
  for (const old of document.querySelectorAll('#chat mark')) {
    const parent = old.parentNode;
    old.replaceWith(...old.childNodes);
    parent.normalize();
  }
}

// The search is over: its highlights go, and code made plain for it is colored again.
function clearMarks() {
  removeMarks();
  for (const code of plainForSearch) {
    if (code.isConnected && colorLanguages.has(code)) colorWhenSeen(code, colorLanguages.get(code));
  }
  plainForSearch.clear();
}

// terms: the lowercase words to highlight in the message. query: the search, for the match bar.
function openHit(hit, terms, query = '') {
  const chat = chatsById.get(hit.chat);
  if (!chat) return;
  setDrawer(false);
  // The bar steps through every match the conversation shows. A hit only in pasted text or a file
  // name, or a chat matched only by its title, opens as before, without it.
  const plan = query ? findPlan(chat, query) : null;
  const at = plan ? (hit.msg === null ? 0 : plan.items.findIndex(item => item.msg === hit.msg)) : -1;
  if (plan && plan.items.length && at >= 0) {
    stepper = { chat: chat.id, query: query.trim(), terms: plan.terms, items: plan.items, total: plan.total, i: 0, k: 0, visible: 0 };
    stepTo(at, 0, 1);
    return;
  }
  closeStepper();
  if (hit.msg === null) { navigate({ chat: chat.id }); return; }
  const now = parseHash(location.hash);
  // A message on the branch already open stays on it; otherwise take the branch under the message.
  const onBranch = now.chat === chat.id && chainFrom(chat.messages, now.leaf).some(m => m.id === hit.msg);
  const leaf = onBranch ? now.leaf : leafUnder(chat.messages, hit.msg);
  find = { msg: hit.msg, terms, gen: null };
  navigate({ chat: chat.id, leaf });
  if (!find) return;
  find.gen = renderGeneration;
  tryFind();
}

// ---- The match bar: "match N of M" in the open chat ----
let stepper = null; // { chat, query, terms, items: [{ msg, count }], total, i, k, visible }

// Goes to occurrence k (or the last one, for -1) of stepper.items[i]. dir is where to go on when that
// occurrence isn't on the page (a word inside a link address): 1 onward, -1 back.
function stepTo(i, k, dir, tries = 0) {
  const s = stepper;
  const item = s && s.items[i];
  if (!s) return;
  if (!item || tries > s.items.length + 1) { closeStepper(); return; }
  s.i = i; s.k = k;
  const chat = chatsById.get(s.chat);
  const now = parseHash(location.hash);
  const onBranch = now.chat === chat.id && chainFrom(chat.messages, now.leaf).some(m => m.id === item.msg);
  const leaf = onBranch ? now.leaf : leafUnder(chat.messages, item.msg);
  find = { msg: item.msg, terms: s.terms, nth: k, dir, tries, gen: null };
  navigate(now.chat === chat.id ? { ...now, leaf } : { chat: chat.id, leaf });
  if (!find) return;
  find.gen = renderGeneration;
  tryFind();
}

function stepBy(dir) {
  const s = stepper;
  if (!s) return;
  if (dir > 0) {
    if (s.k + 1 < s.visible) stepTo(s.i, s.k + 1, 1);
    else if (s.i + 1 < s.items.length) stepTo(s.i + 1, 0, 1);
  } else if (s.k > 0) stepTo(s.i, s.k - 1, -1);
  else if (s.i > 0) stepTo(s.i - 1, -1, -1);
}

// Called once a step's occurrence is on the page (mark) or turned out not to be (null).
function stepLanded(mark, count) {
  const s = stepper;
  if (!s || !find) return;
  const { dir, tries } = find;
  find = null;
  if (!mark) {
    // Nothing to show here: move on in the same direction.
    if (dir > 0 && s.i + 1 < s.items.length) { stepTo(s.i + 1, 0, 1, tries + 1); return; }
    if (dir < 0 && s.i > 0) { stepTo(s.i - 1, -1, -1, tries + 1); return; }
    // Nothing further this way: back to the last match shown, with this direction closed. With none
    // shown yet, the bar closes and the message is shown without it.
    const last = s.last;
    if (!last || dir === 0) {
      const msg = s.items[s.i] && s.items[s.i].msg;
      closeStepper();
      const node = msg && document.querySelector(`#chat .msg[data-id="${CSS.escape(msg)}"]`);
      if (node) node.scrollIntoView({ block: 'center' });
      return;
    }
    s.end = { at: `${last.i}:${last.k}`, dir };
    stepTo(last.i, last.k, 0, tries + 1);
    return;
  }
  s.visible = count;
  if (s.k < 0) s.k = count - 1;
  s.last = { i: s.i, k: s.k };
  showStepper();
  mark.scrollIntoView({ block: 'center' });
}

function showStepper() {
  const s = stepper;
  const bar = document.getElementById('findbar');
  const before = s.items.slice(0, s.i).reduce((n, item) => n + item.count, 0);
  const at = Math.min(before + s.k + 1, s.total);
  bar.querySelector('.find-q').textContent = `“${s.query}”`;
  bar.querySelector('.find-pos').textContent = `${at} of ${s.total}`;
  // A direction found to hold nothing more on the page is closed at the match it came back to.
  const here = `${s.i}:${s.k}`;
  const ended = d => !!s.end && s.end.dir === d && s.end.at === here;
  bar.querySelector('.find-prev').disabled = (s.i === 0 && s.k === 0) || ended(-1);
  bar.querySelector('.find-next').disabled = (s.i === s.items.length - 1 && s.k >= s.visible - 1) || ended(1);
  bar.hidden = false;
}

// Ends the match bar, and any highlight a search left, with or without the bar.
function closeStepper() {
  if (find && find.nth !== undefined) find = null;
  if (stepper) {
    stepper = null;
    document.getElementById('findbar').hidden = true;
  }
  clearMarks();
}

function setupStepper() {
  const bar = document.getElementById('findbar');
  bar.querySelector('.find-prev').addEventListener('click', () => stepBy(-1));
  bar.querySelector('.find-next').addEventListener('click', () => stepBy(1));
  bar.querySelector('.find-close').addEventListener('click', closeStepper);
  // Enter and Shift+Enter step, and Escape closes, from anywhere that isn't a field or a control.
  document.addEventListener('keydown', e => {
    if (!stepper || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    if (popup || !document.getElementById('files-menu').hidden) return;
    const t = e.target;
    if (t && t.closest && t.closest('input, textarea, select, [contenteditable], button, a, summary')) return;
    if (e.key === 'Enter') { e.preventDefault(); stepBy(e.shiftKey ? -1 : 1); }
    else if (e.key === 'Escape') { e.preventDefault(); closeStepper(); }
  });
}

// Marks occurrence nth (or the last, for -1) of any term in what node shows as text (its prose and
// prompt bubbles; not thinking, tools or controls), scanning as countTerms does. Returns
// { mark, count }, count being how many occurrences node shows.
function markNth(node, terms, nth) {
  const wanted = (terms || []).filter(Boolean).slice().sort((a, b) => b.length - a.length);
  const found = [];
  for (const region of node.querySelectorAll('.prose, .bubble')) {
    if (region.closest('.line') && !region.closest('.step-text')) continue;
    const walker = document.createTreeWalker(region, NodeFilter.SHOW_TEXT);
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      if (text.parentElement.closest('button, time, .branch, .code-head, .plain-note, .katex, script, style')) continue;
      const { lower, at: map } = foldCase(text.data);
      const orig = j => (map ? map[j] : j);
      for (let i = 0; i < lower.length;) {
        const term = wanted.find(w => lower.startsWith(w, i));
        if (term) { found.push({ text, at: orig(i), len: orig(i + term.length) - orig(i) }); i += term.length; } else i++;
      }
    }
  }
  const index = nth < 0 ? found.length + nth : nth;
  const hit = found[index];
  if (!hit) return { mark: null, count: found.length };
  const middle = hit.text.splitText(hit.at);
  middle.splitText(hit.len);
  const mark = document.createElement('mark');
  middle.replaceWith(mark);
  mark.append(middle);
  return { mark, count: found.length };
}

// text with the search words in <mark>, as nodes. Matched words are shown, never parsed as HTML.
function withMarks(text, terms) {
  return markTerms(text, terms).map(p => (p.hit ? el('mark', '', p.text) : document.createTextNode(p.text)));
}

// One group per chat, best first; a title button that opens its first match (or the chat), and up to
// three snippets, each opening its message.
function showResults(query) {
  const holder = document.getElementById('results');
  const q = query.trim();
  holder.hidden = !q;
  document.getElementById('recents').hidden = !!q;
  document.querySelector('.find .clear').hidden = !query;
  fileSearchGen++;  // a file search still running for an earlier query stops
  if (!q) { holder.replaceChildren(); closeStepper(); return; }
  if (!searchIndex) searchIndex = buildSearchIndex(allChats);
  const groups = groupHits(searchChats(searchIndex, q, Infinity));
  // Matches are counted as the match bar counts them: in what the conversation shows.
  const plans = new Map(groups.slice(0, GROUP_LIMIT).map(g => [g.chat, findPlan(chatsById.get(g.chat), q)]));
  const matches = [...plans.values()].reduce((n, p) => n + p.total, 0);
  const plural = (n, w, s = 's') => `${n} ${w}${n === 1 ? '' : s}`;
  // Matches are counted in the chats listed, so past GROUP_LIMIT the summary says so.
  const note = !groups.length ? 'No matches'
    : `${plural(groups.length, 'chat')} · ${plural(matches, 'match', 'es')}${groups.length > GROUP_LIMIT ? ` in the first ${GROUP_LIMIT}` : ''}`;
  const list = el('div', 'list');
  for (const g of groups.slice(0, GROUP_LIMIT)) {
    const chat = chatsById.get(g.chat);
    const box = el('div', 'group');
    const title = el('button', 'group-title');
    title.type = 'button';
    const name = el('b');
    name.append(...withMarks((chat && chat.title) || 'Untitled', g.terms));
    title.append(name);
    const plan = plans.get(g.chat);
    if (plan && plan.total) title.append(el('small', '', `${plural(plan.total, 'match', 'es')} in ${plural(plan.items.length, 'message')}`));
    else if (g.count) title.append(el('small', '', 'In pasted text or file names'));
    // The title opens the first match the conversation shows; a hit only in pasted text comes after.
    const first = plan && plan.items.length ? { chat: g.chat, msg: plan.items[0].msg } : (g.snippets[0] || { chat: g.chat, msg: null });
    title.addEventListener('click', () => openHit(first, g.terms, q));
    box.append(title);
    for (const hit of g.snippets) {
      const snip = el('button', 'snip');
      snip.type = 'button';
      snip.append(...withMarks(hit.snippet, hit.terms));
      snip.addEventListener('click', () => openHit(hit, hit.terms, q));
      box.append(snip);
    }
    list.append(box);
  }
  const shown = groups.length > GROUP_LIMIT ? [el('div', 'lab', `Showing the first ${GROUP_LIMIT} chats`)] : [];
  holder.replaceChildren(el('div', 'lab', note), list, ...shown);
  holder.scrollTop = 0;
  if (searchFilesOn()) searchInFiles(q);
}

// ---- "Also search inside files": uploads and generated files, text loaded part by part ----
const FILE_HIT_LIMIT = 100;
const SEARCH_FILES_KEY = 'claude-takeout-search-files';
let fileSearchGen = 0;
let fileSources = null;

function searchFilesOn() {
  const box = document.getElementById('search-files');
  return !!(box && box.checked);
}

// Appends an "In files" section to the results. Inline text is searched at once; text in viewer-files/
// is loaded one part at a time, and a newer search stops this one between parts.
async function searchInFiles(query) {
  const gen = fileSearchGen;
  const holder = document.getElementById('results');
  const lab = el('div', 'lab', 'Searching inside files\u2026');
  const list = el('div', 'list');
  const box = el('div', 'file-hits');
  box.append(lab, list);
  holder.append(box);
  if (!fileSources) fileSources = fileSearchSources(allChats);
  const q = parseQuery(query);
  let found = 0, failed = 0;
  const check = (src, text) => {
    if (found >= FILE_HIT_LIMIT) return;
    const hit = fileHit(q, src.name, text);
    if (!hit) return;
    found++;
    list.append(fileHitRow(src, hit));
  };
  for (const src of fileSources) if (src.text !== null) check(src, src.text);
  const byPart = new Map();
  for (const src of fileSources) {
    if (src.text !== null || src.part === null) continue;
    if (!byPart.has(src.part)) byPart.set(src.part, []);
    byPart.get(src.part).push(src);
  }
  const parts = [...byPart.keys()].sort((a, b) => a - b);
  for (const [i, n] of parts.entries()) {
    if (found >= FILE_HIT_LIMIT) break;
    lab.textContent = `Searching inside files\u2026 ${i + 1} of ${parts.length}`;
    const data = await loadPart(n);
    if (gen !== fileSearchGen) return;
    if (!data) { failed += byPart.get(n).length; continue; }
    for (const src of byPart.get(n)) {
      const text = Object.prototype.hasOwnProperty.call(data, src.key) ? data[src.key] : null;
      if (typeof text === 'string') check(src, text);
      else failed++;
    }
  }
  if (gen !== fileSearchGen) return;
  const count = found >= FILE_HIT_LIMIT ? `the first ${FILE_HIT_LIMIT} files` : `${found} file${found === 1 ? '' : 's'}`;
  lab.textContent = found ? `Inside files \u00b7 ${count}` : 'No matches inside files';
  if (failed) box.append(el('div', 'lab', `${failed} file${failed === 1 ? '' : 's'} couldn't be read, because viewer-files/ is missing or blocked.`));
}

function fileHitRow(src, hit) {
  const chat = chatsById.get(src.chat);
  const row = el('button', 'group-title file-hit');
  row.type = 'button';
  const name = el('b');
  name.append(...withMarks(src.name || 'Untitled', hit.terms));
  row.append(name, el('small', '', `${src.kind === 'upload' ? 'Upload' : 'File'} in ${(chat && chat.title) || 'Untitled'}`));
  const snip = el('span', 'snip');
  snip.append(...withMarks(hit.snippet, hit.terms));
  row.append(snip);
  row.addEventListener('click', () => {
    setDrawer(false);
    closeStepper();
    if (src.kind === 'file') {
      navigate({ chat: src.chat, file: src.id, version: src.version });
      return;
    }
    navigate({ chat: src.chat });
    openPopup(src.item, document.querySelector('.find input'));
  });
  return row;
}

function setupSearch() {
  const input = document.querySelector('.find input');
  const clear = document.querySelector('.find .clear');
  let timer = 0;
  input.disabled = false;
  const reset = () => { clearTimeout(timer); input.value = ''; showResults(''); };
  input.addEventListener('focus', () => { if (!searchIndex) searchIndex = buildSearchIndex(allChats); });
  const files = document.getElementById('search-files');
  try { files.checked = localStorage.getItem(SEARCH_FILES_KEY) === '1'; } catch (e) { /* no storage: off */ }
  files.addEventListener('change', () => {
    try { localStorage.setItem(SEARCH_FILES_KEY, files.checked ? '1' : '0'); } catch (e) { /* kept for this page only */ }
    if (input.value.trim()) showResults(input.value);
  });
  input.addEventListener('input', () => {
    clearTimeout(timer);
    if (!input.value.trim()) showResults(input.value);
    else timer = setTimeout(() => showResults(input.value), 120);
  });
  clear.addEventListener('click', () => { reset(); input.focus(); });
  // Escape clears; ArrowDown goes to the first result, and the arrows move between results.
  const results = () => [...document.querySelectorAll('#results button')];
  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); reset(); }
    else if (e.key === 'ArrowDown' && results().length) { e.preventDefault(); results()[0].focus(); }
  });
  document.getElementById('results').addEventListener('keydown', e => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Escape') return;
    e.preventDefault();
    if (e.key === 'Escape') { input.focus(); return; }
    const all = results();
    const at = all.indexOf(document.activeElement) + (e.key === 'ArrowDown' ? 1 : -1);
    if (at < 0) input.focus();
    else if (at < all.length) all[at].focus();
  });
  // / anywhere outside a text field puts the cursor in the search box.
  document.addEventListener('keydown', e => {
    if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || artifactsOn) return;
    const t = e.target;
    if (t && (t.closest('input, textarea, select, [contenteditable]') || popup)) return;
    e.preventDefault();
    setDrawer(true);
    input.focus();
    input.select();
  });
}

// A browser can open viewer.html from inside a ZIP, but not the files beside it.
// The name matches VIEWER_CHECK_FILE in takeout-viewer.js.
function checkUnzipped() {
  const probe = new Image();
  probe.onerror = () => {
    const banner = el('div', '', "Unzip this archive first. Files can't open from inside a ZIP.");
    banner.id = 'unzip';
    banner.setAttribute('role', 'status');
    document.getElementById('main').prepend(banner);
  };
  probe.src = 'viewer-check.gif';
}

function start() {
  checkUnzipped();
  // The data is parsed once, and its text dropped: on a large archive it would otherwise
  // stay in memory beside the parsed copy for as long as the page is open.
  const holder = document.getElementById('data');
  const data = JSON.parse(holder.textContent);
  holder.remove();
  setupParts(data);
  setupArtifacts(data);
  setupFilesMenu();
  setupStepper();
  allChats = linkProjects(data);
  allChats.forEach(chat => chatsById.set(chat.id, chat));
  renderSidebar(data.chats);
  setupSearch();
  try { setWrap(localStorage.getItem(WRAP_KEY) === '1', false); } catch (e) { /* no storage: off */ }
  document.getElementById('menu').addEventListener('click', () => setDrawer(true));
  document.getElementById('scrim').addEventListener('click', () => setDrawer(false));
  document.getElementById('panel-body').addEventListener('click', e => {
    const button = e.target.closest('.copy');
    if (button) onCopy(button);
  });
  document.getElementById('chat').addEventListener('click', e => {
    const button = e.target.closest('.code .copy');
    if (button) { onCopy(button); return; }
    const card = e.target.closest('.art');
    if (card) { navigate({ ...parseHash(location.hash), file: card.dataset.file, version: Number(card.dataset.version) }); return; }
    const arrow = e.target.closest('.branch button');
    if (arrow && !arrow.disabled) switchTo(arrow);
  });
  window.addEventListener('hashchange', onHashChange);
  if (!data.chats.length) document.getElementById('chat').append(el('div', 'empty', 'No chats in this archive'));
  if (routeArtifacts(location.hash)) return;
  if (data.chats.length) navigate(parseHash(location.hash), { replace: true });
  else if (artifactsApp) { history.replaceState(null, '', '#artifacts'); routeArtifacts('#artifacts'); }
}

start();
