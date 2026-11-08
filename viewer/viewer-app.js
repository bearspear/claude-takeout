// Viewer page: sidebar, top bar, message rendering and the file panel. Classic script, inlined after viewer-logic.js.
// Chat text is untrusted. Only sanitizeHtml's output reaches innerHTML; all else goes through textContent.
// KaTeX's output is the one addition, and goes in through fillPlaceholders. A generated file only ever
// runs in a frame with sandbox="allow-scripts"; its text reaches that frame as an attribute value.

const BATCH_SIZE = 10;

const ICON_PATHS = {
  chevron: 'm9 6 6 6-6 6',
  close: 'M6 6l12 12M18 6 6 18',
  copy: 'M9 9h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1ZM5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1',
  check: 'm5 12.5 4.5 4.5L19 7.5',
  file: 'M6 3h8l5 5v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Zm8 0v5h5',
  terminal: 'm5 8 4 4-4 4M12 17h7',
  search: 'M11 17.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13ZM20 20l-4.4-4.4',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM3 12h18M12 3c2.5 2.6 3.7 5.6 3.7 9s-1.2 6.4-3.7 9c-2.5-2.6-3.7-5.6-3.7-9S9.5 5.6 12 3Z',
  pencil: 'M4 20l1-4L16 5a1.8 1.8 0 0 1 3 3L8 19l-4 1Z',
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

// Raw HTML in a chat displays as the text it is, as on claude.ai. marked would stop escaping the text
// after a tag like <code>, and stop linking after <a>, so its state is reset after every tag.
const markdown = new marked.Marked({
  gfm: true,
  renderer: {
    html(raw, block) {
      return block ? `<p class="raw-html">${escHtml(raw.trimEnd())}</p>` : escHtml(raw);
    },
  },
  tokenizer: {
    tag(src) {
      const token = marked.Tokenizer.prototype.tag.call(this, src);
      if (token) { this.lexer.state.inLink = false; this.lexer.state.inRawBlock = false; }
      return token;
    },
    url(src, ...rest) {
      return marked.Tokenizer.prototype.url.call(this, beforeCitation(src), ...rest);
    },
  },
});

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
// marked's emphasis parsing is quadratic, so a block with this many * and _ would hang the tab.
const EMPHASIS_LIMIT = 4000;
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

function renderThinking(block) {
  const label = el('span', 'label', 'Thought process');
  if (block.summary) {
    label.append(' ');
    label.append(el('span', 'gist', block.summary));
  }
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

function renderTool(block) {
  const parts = [icon(TOOL_ICONS[block.name] || 'wrench'), el('span', 'label', block.label)];
  if (block.error) parts.push(el('span', 'fail', 'Failed'));
  const body = el('div', 'line-body');
  const input = toolInputText(block.input);
  if (input) body.append(toolPart('Input', input));
  if (block.result) body.append(toolPart('Result', block.result, block.error));
  const missing = block.missingImages || 0;
  if (missing > 0) body.append(el('div', 'tool-part missing-image', missing === 1 ? 'Image not in this export' : `${missing} images not in this export`));
  if (!input && !block.result && !missing) body.append(el('div', 'line-text', 'No details in this export'));
  const line = foldLine('tool', parts, body);
  const images = (block.images || []).filter(src => SAFE_IMAGE_URI.test(src));
  if (!images.length) return [line];
  const row = el('div', 'tool-images');
  for (const src of images) {
    const img = el('img');
    img.src = src;
    img.alt = 'Image from a tool result';
    img.loading = 'lazy';
    row.append(img);
  }
  return [line, row];
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
    for (const part of splitFences(text)) {
      if (part.t === 'text') { bubble.append(el('div', 'typed', part.text)); continue; }
      const pre = document.createElement('pre');
      const code = el('code', '', part.text);
      pre.append(code);
      const block = codeBlock(part.lang);
      block.append(pre);
      colorWhenSeen(code, part.lang);
      bubble.append(block);
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

// Returns the body nodes and, for a file the header can offer, a link.
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
    const img = el('img', 'file-image');
    img.setAttribute('alt', name);
    img.setAttribute('src', item.href);
    const paper = el('div', 'file-paper');
    paper.append(img);
    return { nodes: [paper], link: openableHref(item.href) ? openLink(item.href) : null };
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
  const { veil, trigger } = popup;
  popup = null;
  veil.remove();
  document.getElementById('app').inert = false;
  if (document.contains(trigger)) trigger.focus({ preventScroll: true });
}

function popupKeys(e) {
  if (e.key === 'Escape') { e.preventDefault(); closePopup(); return; }
  if (e.key !== 'Tab') return;
  const pop = popup.veil.firstElementChild;
  const stops = [...pop.querySelectorAll('a[href], button')];
  const last = stops.length - 1;
  const at = stops.indexOf(document.activeElement);
  if (!stops.length) { e.preventDefault(); pop.focus(); }
  else if (e.shiftKey && at <= 0) { e.preventDefault(); stops[last].focus(); }
  else if (!e.shiftKey && at === last) { e.preventDefault(); stops[0].focus(); }
}

function openPopup(item, trigger) {
  closePopup();
  const { nodes, link, part } = popupContent(item);
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
  head.append(title, ...(typeof item.text === 'string' ? [fileCopyButton(item.name || 'Untitled', item.text)] : []), ...(link ? [link] : []), close);
  const body = el('div', 'pop-body');
  body.append(...nodes);
  pop.append(head, body);
  const veil = el('div', 'veil');
  veil.append(pop);
  veil.addEventListener('click', e => { if (e.target === veil) closePopup(); });
  veil.addEventListener('keydown', popupKeys);
  document.body.append(veil);
  document.getElementById('app').inert = true;
  const mine = popup = { veil, trigger };
  pop.focus({ preventScroll: true });
  // Large upload text is in a part. It lands only in the popup that asked for it.
  // The text is kept even when the popup has closed, so the next open is instant.
  if (part) loadPart(part).then(loaded => {
    const text = loaded && Object.prototype.hasOwnProperty.call(loaded, item.key) ? loaded[item.key] : null;
    if (typeof text === 'string') item.text = text;
    if (popup !== mine) return;
    body.replaceChildren(...(typeof text === 'string' ? popupContent(item).nodes : partMissing(item)));
    if (typeof text === 'string') title.after(fileCopyButton(item.name || 'Untitled', text));
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
const partsLoaded = new Map(); // n -> Promise<object|null>, the most recently used last
const PARTS_KEPT = 2; // a part is about 4 MB; older ones are dropped and load again if needed
const partsWaiting = new Map(); // n -> resolve, only while its script is loading

// Parts hold the text of added files and of large uploads.
function setupParts(data) {
  allAdded = Array.isArray(data.added) ? data.added : [];
  addedIds = new Map(allAdded.map((entry, i) => [entry, `x${i}`]));
  const uploads = (data.chats || []).flatMap(chat => (chat.messages || []).flatMap(m => m.uploads || []));
  const versions = (data.chats || []).flatMap(chat => Object.values(chat.files || {}).flatMap(f => (f && f.versions) || []));
  for (const entry of [...allAdded, ...uploads, ...versions]) if (entry && Number.isSafeInteger(entry.part) && entry.part > 0) partsListed.add(entry.part);
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
function loadPart(n) {
  if (!partsListed.has(n)) return Promise.resolve(null);
  if (partsLoaded.has(n)) {
    const cached = partsLoaded.get(n);
    partsLoaded.delete(n);
    partsLoaded.set(n, cached);
    return cached;
  }
  const loading = new Promise(resolve => {
    partsWaiting.set(n, resolve);
    const script = el('script');
    const finish = () => {
      script.remove();
      const done = partsWaiting.get(n);
      if (!done) return; // the part called in, and this was its load event
      partsWaiting.delete(n);
      partsLoaded.delete(n); // so opening the file later tries again
      done(null);
    };
    script.addEventListener('load', finish);
    script.addEventListener('error', finish);
    script.src = `viewer-files/part-${String(n).padStart(4, '0')}.js`;
    document.head.append(script);
  });
  partsLoaded.set(n, loading);
  while (partsLoaded.size > PARTS_KEPT) partsLoaded.delete(partsLoaded.keys().next().value);
  return loading;
}

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
  label.append(el('b', '', file.name || 'Untitled'), el('small', '', [fileKindLabel(file), version && version.label].filter(Boolean).join(' · ')));
  card.append(tile, label);
  card.title = file.name || '';
  return card;
}

function renderAssistant(m, chat) {
  const node = el('section', 'msg assistant');
  const sources = [];
  for (const block of m.blocks) {
    if (block.t === 'text') { if (block.text) node.append(renderText(block, sources)); }
    else if (block.t === 'thinking') node.append(renderThinking(block));
    else if (block.t === 'tool') node.append(...renderTool(block));
    else if (block.t === 'card') {
      const card = renderCard(block, chat);
      if (card) node.append(card);
    }
  }
  if (!node.hasChildNodes()) return null;
  if (sources.length) node.append(renderSources(sources));
  return node;
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
function renderChat(chat, leaf = chat.leaf, anchor = null) {
  const generation = ++renderGeneration;
  const box = document.getElementById('chat');
  const scroll = document.getElementById('scroll');
  const title = chat.title || 'Untitled';
  renderProject(chat);
  box.replaceChildren();
  if (!anchor) scroll.scrollTop = 0;
  document.getElementById('title').textContent = title;
  document.getElementById('meta').textContent = [chat.model, shortDate(chat.created)].filter(Boolean).join(' · ');
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
    const size = next === 0 && anchorAt >= 0 ? Math.max(BATCH_SIZE, anchorAt + 1) : BATCH_SIZE;
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

// Siblings are found by name, newest text of the last file with that name.
function siblingLookup(chat) {
  const texts = new Map();
  for (const file of Object.values(chat.files || {})) {
    const text = (file.versions || []).map(v => v.text).filter(t => t != null).pop();
    if (text != null) texts.set(file.name, text);
  }
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
  if (openableHref(version.href)) {
    const link = el('a', 'file-open', 'Open file');
    link.setAttribute('href', version.href);
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noopener');
    box.append(link);
  } else if (file.added && !file.tooLarge) {
    box.append(el('p', '', "This file can't open from the viewer. It's in this archive's folder."), el('small', 'file-path', file.path));
  } else if (!file.added) {
    box.append(el('p', '', "This file can't open from the viewer. It's in the artefacts folder of this export."));
  }
  return box;
}

function previewNodes(chat, file, version) {
  if (file.kind === 'md') return [renderText({ text: version.text, cites: [] }, [])];
  if (file.kind === 'image') {
    const img = el('img', 'file-image');
    img.setAttribute('alt', file.name || '');
    img.setAttribute('src', version.href);
    const paper = el('div', 'file-paper');
    paper.append(img);
    return [paper];
  }
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
  return doc.remote ? [el('div', 'file-note', REMOTE_NOTE), frame] : [frame];
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
  if (shape.missing) body.replaceChildren(el('div', 'file-missing', 'This file is not in this export.'));
  else if (!shape.views.length) body.replaceChildren(fileDetails(file, version));
  else if (panelView === 'preview') body.replaceChildren(...previewNodes(chat, file, version));
  else {
    const code = el('pre', 'file-code');
    code.textContent = version.text;
    colorWhenSeen(code, languageOfFile(file.name));
    body.replaceChildren(...(shape.note ? [el('div', 'file-note', shape.note)] : []), code);
  }
  body.scrollTop = 0;
}

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
    navigate({ ...parseHash(location.hash), file: null, version: null });
    if (card) card.focus({ preventScroll: true });
  });
  const version = file.versions[at];
  const copy = !shape.missing && shape.views.length && version && typeof version.text === 'string' ? [fileCopyButton(file.name || 'Untitled', version.text)] : [];
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

// Shows Loading… until the part arrives. A part that can't be read leaves the file missing, as a generated one would be.
function drawFromPart(chat, open, file, version) {
  const load = panelLoad;
  renderPanelHead(chat, open.file, file, open.version, { views: [] });
  document.getElementById('panel-body').replaceChildren(el('div', 'file-loading', 'Loading…'));
  loadPart(version.part).then(part => {
    if (load !== panelLoad) return;
    const text = part && Object.prototype.hasOwnProperty.call(part, version.key) ? part[version.key] : null;
    if (typeof text === 'string') {
      version.text = text;
      drawPanel(chat, open, file, version);
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
  if (!fileKey || !panelFor.startsWith(fileKey)) panelView = null; // a new file starts at its first view
  panelFor = key;
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
  showPanel(chat, open);
  const column = `${chat.id}\n${leaf}`;
  if (column === drawn) return;
  drawn = column;
  renderChat(chat, leaf, options.anchor);
}

function onHashChange() {
  if (location.hash === shown) return;
  navigate(parseHash(location.hash), { fromHash: true });
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
    if (text.parentElement.closest('button, time, .branch, .code-head, script, style')) continue;
    const lower = text.data.toLowerCase();
    if (lower.length !== text.data.length) continue;
    let at = -1, q = '';
    for (const t of wanted) {
      const i = lower.indexOf(t);
      if (i >= 0 && (at < 0 || i < at)) { at = i; q = t; }
    }
    if (at < 0) continue;
    const middle = text.splitText(at);
    middle.splitText(q.length);
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
  const { terms } = find;
  find = null;
  // An earlier search's highlight goes before this one is added.
  for (const old of document.querySelectorAll('#chat mark')) {
    const parent = old.parentNode;
    old.replaceWith(...old.childNodes);
    parent.normalize();
  }
  let mark = highlightIn(node, terms);
  if (!mark && node.querySelector('.colored')) {
    // Colors split code into pieces, and a match across them is skipped.
    node.querySelectorAll('.colored').forEach(code => { code.textContent = code.textContent; code.classList.remove('colored'); });
    mark = highlightIn(node, terms);
  }
  (mark || node).scrollIntoView({ block: 'center' });
}

// terms: the lowercase words to highlight in the message.
function openHit(hit, terms) {
  const chat = chatsById.get(hit.chat);
  if (!chat) return;
  setDrawer(false);
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
  if (!q) { holder.replaceChildren(); return; }
  if (!searchIndex) searchIndex = buildSearchIndex(allChats);
  const groups = groupHits(searchChats(searchIndex, q, Infinity));
  const messages = groups.reduce((n, g) => n + g.count, 0);
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const note = !groups.length ? 'No matches' : `${plural(groups.length, 'chat')} · ${plural(messages, 'message')}`;
  const list = el('div', 'list');
  for (const g of groups.slice(0, GROUP_LIMIT)) {
    const chat = chatsById.get(g.chat);
    const box = el('div', 'group');
    const title = el('button', 'group-title');
    title.type = 'button';
    const name = el('b');
    name.append(...withMarks((chat && chat.title) || 'Untitled', g.terms));
    title.append(name);
    if (g.count) title.append(el('small', '', plural(g.count, 'message')));
    const first = g.snippets[0] || { chat: g.chat, msg: null };
    title.addEventListener('click', () => openHit(first, g.terms));
    box.append(title);
    for (const hit of g.snippets) {
      const snip = el('button', 'snip');
      snip.type = 'button';
      snip.append(...withMarks(hit.snippet, hit.terms));
      snip.addEventListener('click', () => openHit(hit, hit.terms));
      box.append(snip);
    }
    list.append(box);
  }
  const shown = groups.length > GROUP_LIMIT ? [el('div', 'lab', `Showing the first ${GROUP_LIMIT} chats`)] : [];
  holder.replaceChildren(el('div', 'lab', note), list, ...shown);
  holder.scrollTop = 0;
}

function setupSearch() {
  const input = document.querySelector('.find input');
  const clear = document.querySelector('.find .clear');
  let timer = 0;
  input.disabled = false;
  const reset = () => { clearTimeout(timer); input.value = ''; showResults(''); };
  input.addEventListener('focus', () => { if (!searchIndex) searchIndex = buildSearchIndex(allChats); });
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
    if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
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
  allChats = linkProjects(data);
  allChats.forEach(chat => chatsById.set(chat.id, chat));
  renderSidebar(data.chats);
  setupSearch();
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
  if (data.chats.length) navigate(parseHash(location.hash), { replace: true });
  else document.getElementById('chat').append(el('div', 'empty', 'No chats in this archive'));
}

start();
