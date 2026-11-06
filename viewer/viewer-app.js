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

// A code block's frame: a header with its language and a Copy button. The caller adds the pre.
function codeBlock(lang) {
  const wrap = el('div', 'code');
  const head = el('div', 'code-head');
  head.append(el('span', '', lang), copyButton());
  wrap.append(head);
  return wrap;
}

// Code fences become code blocks. Wide tables scroll on their own.
function dressMarkdown(box) {
  box.querySelectorAll('pre').forEach(pre => {
    const code = pre.querySelector('code');
    const lang = code && /(?:^|\s)language-(\S+)/.exec(code.className);
    const wrap = codeBlock(lang ? lang[1] : '');
    pre.replaceWith(wrap);
    wrap.append(pre);
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

function fileNote(name, text) {
  const ext = (/\.([a-z0-9]{1,6})$/i.exec(name || '') || [])[1];
  const lines = text ? text.split('\n').length : 0;
  return [ext && ext.toUpperCase(), lines ? `${lines} line${lines === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ');
}

function renderHuman(m) {
  const node = el('section', 'msg human');
  const chips = [
    ...(m.uploads || []).map(u => fileChip(u, fileNote(u.name, u.text))),
    ...(m.attachments || []).map(a => fileChip({ name: a.name, href: null, text: a.text }, fileNote(a.name, a.text))),
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
      pre.append(el('code', '', part.text));
      const block = codeBlock(part.lang);
      block.append(pre);
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
  if (typeof item.text === 'string') {
    const code = el('pre', 'file-code');
    code.textContent = item.text;
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
  const { nodes, link } = popupContent(item);
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
  head.append(el('b', 'pop-title', item.name || 'Untitled'), ...(link ? [link] : []), close);
  const body = el('div', 'pop-body');
  body.append(...nodes);
  pop.append(head, body);
  const veil = el('div', 'veil');
  veil.append(pop);
  veil.addEventListener('click', e => { if (e.target === veil) closePopup(); });
  veil.addEventListener('keydown', popupKeys);
  document.body.append(veil);
  document.getElementById('app').inert = true;
  popup = { veil, trigger };
  pop.focus({ preventScroll: true });
}

// The project's files and documents, under the top bar. Rebuilt only for another chat, so it stays open.
let projectFor = null;
function renderProject(chat) {
  if (projectFor === chat.id) return;
  projectFor = chat.id;
  const box = document.getElementById('project');
  const project = chat.project;
  const items = project ? [
    ...(project.files || []).map(f => ({ name: f.name, href: f.href, text: null })),
    ...(project.docs || []).map(d => ({ name: d.name, href: null, text: d.text })),
  ] : [];
  const instructions = project && typeof project.instructions === 'string' ? project.instructions : '';
  box.hidden = !items.length && !instructions;
  box.replaceChildren();
  if (box.hidden) return;
  const name = project.name || 'Untitled';
  // Two folds, closed by default, because a project's prompt can be long.
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
  if (openableHref(version.href)) {
    const link = el('a', 'file-open', 'Open file');
    link.setAttribute('href', version.href);
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noopener');
    box.append(link);
  } else {
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
  if (file.kind === 'pdf') {
    // Chrome's PDF viewer refuses a sandboxed frame. fileViews only gives this view to a .pdf link.
    const frame = el('iframe', 'preview');
    frame.setAttribute('title', file.name || '');
    frame.setAttribute('src', version.href);
    return [frame];
  }
  const doc = previewDoc(version.text, siblingLookup(chat));
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
    const card = document.querySelector('.art.on');
    navigate({ ...parseHash(location.hash), file: null, version: null });
    if (card) card.focus({ preventScroll: true });
  });
  head.replaceChildren(name, el('small', 'panel-kind', fileKindLabel(file)), ...tabs, row, close);
  if (focused) [...tabs, ...versions].find(b => b.textContent === focused)?.focus();
}

// open: from resolveFile, or null to close. again: draw it even if it's what the panel already shows.
function showPanel(chat, open, again = false) {
  openFile = open;
  document.querySelectorAll('.art').forEach(card => {
    card.classList.toggle('on', open !== null && card.dataset.file === open.file && Number(card.dataset.version) === open.version);
  });
  const panel = document.getElementById('panel');
  const fileKey = open ? `${chat.id}\n${open.file}\n` : '';
  const key = open ? fileKey + open.version : '';
  if (key === panelFor && !again) return;
  if (!fileKey || !panelFor.startsWith(fileKey)) panelView = null; // a new file starts at its first view
  panelFor = key;
  panel.hidden = !open;
  if (!open) {
    document.getElementById('panel-head').replaceChildren();
    document.getElementById('panel-body').replaceChildren();
    return;
  }
  const file = chat.files[open.file];
  const version = file.versions[open.version];
  const shape = fileViews(file.kind, version);
  if (!shape.views.includes(panelView)) panelView = shape.views[0] || null;
  renderPanelHead(chat, open.file, file, open.version, shape);
  renderPanelBody(chat, file, version, shape);
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
  const open = resolveFile(chat.files, want.file, want.version);
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
  navigate({ ...hash, leaf }, { anchor: next ? { id: next.id, top } : null });
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
const RESULT_LIMIT = 50;
let searchIndex = null;
let find = null; // { msg, query, gen }: the highlight waiting for its message to be drawn

// Wraps the first match in a text node of the message with <mark>. A match across formatting is skipped.
function highlightIn(node, query) {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    if (text.parentElement.closest('button, time, .branch, .code-head, script, style')) continue;
    const lower = text.data.toLowerCase();
    if (lower.length !== text.data.length) continue;
    const at = lower.indexOf(q);
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
  const { query } = find;
  find = null;
  (highlightIn(node, query) || node).scrollIntoView({ block: 'center' });
}

function openHit(hit, query) {
  const chat = chatsById.get(hit.chat);
  if (!chat) return;
  setDrawer(false);
  if (hit.msg === null) { navigate({ chat: chat.id }); return; }
  const now = parseHash(location.hash);
  // A message on the branch already open stays on it; otherwise take the branch under the message.
  const onBranch = now.chat === chat.id && chainFrom(chat.messages, now.leaf).some(m => m.id === hit.msg);
  const leaf = onBranch ? now.leaf : leafUnder(chat.messages, hit.msg);
  find = { msg: hit.msg, query, gen: null };
  navigate({ chat: chat.id, leaf });
  if (!find) return;
  find.gen = renderGeneration;
  tryFind();
}

function showResults(query) {
  const holder = document.getElementById('results');
  const q = query.trim();
  holder.hidden = !q;
  document.getElementById('recents').hidden = !!q;
  if (!q) { holder.replaceChildren(); return; }
  if (!searchIndex) searchIndex = buildSearchIndex(allChats);
  const hits = searchChats(searchIndex, q, RESULT_LIMIT + 1);
  const shownHits = hits.slice(0, RESULT_LIMIT);
  const note = !hits.length ? 'No matches' : hits.length > RESULT_LIMIT ? `Showing first ${RESULT_LIMIT} results` : `${hits.length} result${hits.length === 1 ? '' : 's'}`;
  const list = el('div', 'list');
  for (const hit of shownHits) {
    const chat = chatsById.get(hit.chat);
    const button = el('button', 'hit');
    button.type = 'button';
    button.append(el('b', '', (chat && chat.title) || 'Untitled'));
    if (hit.msg !== null) button.append(el('small', '', hit.snippet));
    button.addEventListener('click', () => openHit(hit, q));
    list.append(button);
  }
  holder.replaceChildren(el('div', 'lab', note), list);
  holder.scrollTop = 0;
}

function setupSearch() {
  const input = document.querySelector('.find input');
  let timer = 0;
  input.disabled = false;
  input.addEventListener('focus', () => { if (!searchIndex) searchIndex = buildSearchIndex(allChats); });
  input.addEventListener('input', () => {
    clearTimeout(timer);
    if (!input.value.trim()) showResults('');
    else timer = setTimeout(() => showResults(input.value), 120);
  });
  input.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    clearTimeout(timer);
    input.value = '';
    showResults('');
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
  const data = JSON.parse(document.getElementById('data').textContent);
  allChats = data.chats;
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
