// Viewer page: sidebar, top bar and message rendering. Classic script, inlined after viewer-logic.js.
// Chat text is untrusted. Only sanitizeHtml's output reaches innerHTML; all else goes through textContent.

const BATCH_SIZE = 10;

const ICON_PATHS = {
  chevron: 'm9 6 6 6-6 6',
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

function renderMath(src, displayMode) {
  return katex.renderToString(src, { displayMode, throwOnError: false });
}

function copyButton() {
  const button = el('button', 'copy');
  button.type = 'button';
  button.append(icon('copy'), el('span', '', 'Copy'));
  return button;
}

// Code fences get a header with their language and a Copy button. Wide tables scroll on their own.
function dressMarkdown(box) {
  box.querySelectorAll('pre').forEach(pre => {
    const code = pre.querySelector('code');
    const lang = code && /(?:^|\s)language-(\S+)/.exec(code.className);
    const wrap = el('div', 'code');
    const head = el('div', 'code-head');
    head.append(el('span', '', lang ? lang[1] : ''), copyButton());
    pre.replaceWith(wrap);
    wrap.append(head, pre);
  });
  box.querySelectorAll('table').forEach(table => {
    const wrap = el('div', 'table');
    table.replaceWith(wrap);
    wrap.append(table);
  });
}

// sources: shared across the message, so numbers don't restart in a later block.
function renderText(block, sources) {
  const cited = addCitations(block.text, block.cites, sources);
  const safe = protectMath(cited.text);
  const clean = sanitizeHtml(marked.parse(safe.text, { gfm: true }), new DOMParser());
  const box = el('div', 'prose');
  box.innerHTML = restoreMath(clean, safe.math, renderMath);
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
  body.append(el('div', 'line-text', block.text));
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
  if (!input && !block.result) body.append(el('div', 'line-text', 'No details in this export'));
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

function fileChip(name, note) {
  const chip = el('div', 'chip');
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
    ...(m.uploads || []).map(u => fileChip(u.name, fileNote(u.name, u.text))),
    ...(m.attachments || []).map(a => fileChip(a.name, fileNote(a.name, a.text))),
  ];
  if (chips.length) {
    const row = el('div', 'chips');
    row.append(...chips);
    node.append(row);
  }
  const text = m.blocks.filter(b => b.t === 'text').map(b => b.text).join('\n\n');
  if (text) node.append(el('div', 'bubble', text));
  return chips.length || text ? node : null;
}

function renderAssistant(m) {
  const node = el('section', 'msg assistant');
  const sources = [];
  for (const block of m.blocks) {
    if (block.t === 'text') { if (block.text) node.append(renderText(block, sources)); }
    else if (block.t === 'thinking') node.append(renderThinking(block));
    else if (block.t === 'tool') node.append(...renderTool(block));
  }
  if (!node.hasChildNodes()) return null;
  if (sources.length) node.append(renderSources(sources));
  return node;
}

function renderMessage(m) {
  const node = m.sender === 'human' ? renderHuman(m) : renderAssistant(m);
  if (!node) return null;
  node.dataset.id = m.id;
  const stamp = timeStamp(m.at);
  if (stamp) node.append(stamp);
  return node;
}

let renderGeneration = 0;

// Any later call cancels the batches still pending from this one.
function renderChat(chat) {
  const generation = ++renderGeneration;
  const box = document.getElementById('chat');
  const title = chat.title || 'Untitled';
  box.replaceChildren();
  document.getElementById('scroll').scrollTop = 0;
  document.getElementById('title').textContent = title;
  document.getElementById('meta').textContent = [chat.model, shortDate(chat.created)].filter(Boolean).join(' · ');
  document.title = `${title} - Claude Takeout`;
  document.querySelectorAll('.item').forEach(item => item.setAttribute('aria-current', String(item.dataset.id === chat.id)));

  const chain = chainFrom(chat.messages, chat.leaf);
  let next = 0;
  const batch = () => {
    if (generation !== renderGeneration) return;
    const part = document.createDocumentFragment();
    for (const m of chain.slice(next, next + BATCH_SIZE)) {
      const node = renderMessage(m);
      if (node) part.append(node);
    }
    next += BATCH_SIZE;
    box.append(part);
    if (next < chain.length) requestAnimationFrame(batch);
  };
  batch();
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    const area = el('textarea');
    area.value = text;
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
}

async function onCopy(button) {
  await copyText(button.closest('.code').querySelector('pre').textContent);
  const label = button.querySelector('span');
  button.replaceChild(icon('check'), button.firstChild);
  label.textContent = 'Copied';
  setTimeout(() => {
    button.replaceChild(icon('copy'), button.firstChild);
    label.textContent = 'Copy';
  }, 1500);
}

function setDrawer(open) {
  document.body.classList.toggle('drawer', open);
}

function renderSidebar(chats) {
  const list = document.getElementById('chat-list');
  for (const chat of chats) {
    const item = el('button', 'item', chat.title || 'Untitled');
    item.type = 'button';
    item.dataset.id = chat.id;
    item.title = chat.title || 'Untitled';
    item.addEventListener('click', () => { setDrawer(false); renderChat(chat); });
    list.append(item);
  }
  document.getElementById('archive').textContent = `Archive · ${chats.length} chat${chats.length === 1 ? '' : 's'} · read-only`;
}

function start() {
  const data = JSON.parse(document.getElementById('data').textContent);
  renderSidebar(data.chats);
  document.getElementById('menu').addEventListener('click', () => setDrawer(true));
  document.getElementById('scrim').addEventListener('click', () => setDrawer(false));
  document.getElementById('chat').addEventListener('click', e => {
    const button = e.target.closest('.copy');
    if (button) onCopy(button);
  });
  if (data.chats.length) renderChat(data.chats[0]);
  else document.getElementById('chat').append(el('div', 'empty', 'No chats in this archive'));
}

start();
