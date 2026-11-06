// Viewer page: sidebar, top bar and message rendering. Classic script, inlined after viewer-logic.js.
// Chat text is untrusted. Only sanitizeHtml's output reaches innerHTML; all else goes through textContent.
// KaTeX's output is the one addition, and goes in through fillPlaceholders.

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

function renderMessage(m, sib) {
  let node;
  try {
    node = m.sender === 'human' ? renderHuman(m) : renderAssistant(m);
  } catch (e) {
    console.warn('Could not display a message', m.id, e);
    node = el('section', 'msg failed', "This message couldn't be displayed");
  }
  if (!node) return null;
  node.dataset.id = m.id;
  if (sib && sib.ids.length > 1) node.append(branchControl(sib));
  const stamp = timeStamp(m.at);
  if (stamp) node.append(stamp);
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
      const node = renderMessage(m, sibsOf(m));
      if (node) part.append(node);
    }
    const first = next === 0;
    next += size;
    box.append(part);
    if (first) place();
    if (next < chain.length) requestAnimationFrame(batch);
    else if (anchor) requestAnimationFrame(place);
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

const chatsById = new Map();
let allChats = [];
let shown = ''; // the hash of what the page is showing, so a hashchange we caused isn't rendered again

// The only way to change chat, leaf or file. Writes the hash, then renders. options.replace edits the
// current history entry; options.anchor keeps a message in place; options.fromHash means the hash is already set.
function navigate(state, options = {}) {
  const chat = chatsById.get(state.chat) || allChats[0];
  if (!chat) return;
  const ids = new Set(chat.messages.map(m => m.id));
  const chain = chainFrom(chat.messages, ids.has(state.leaf) ? state.leaf : (state.leaf ? null : chat.leaf));
  const leaf = chain.length ? chain[chain.length - 1].id : null;
  const hash = formatHash({ chat: chat.id, leaf, file: state.file, version: state.version });
  if (!options.fromHash && hash !== location.hash) {
    if (options.replace) history.replaceState(null, '', hash);
    else location.hash = hash;
  } else if (options.fromHash && hash !== location.hash) history.replaceState(null, '', hash);
  shown = hash;
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

function renderSidebar(chats) {
  const list = document.getElementById('chat-list');
  for (const chat of chats) {
    const item = el('button', 'item', chat.title || 'Untitled');
    item.type = 'button';
    item.dataset.id = chat.id;
    item.title = chat.title || 'Untitled';
    item.addEventListener('click', () => { setDrawer(false); navigate({ chat: chat.id }); });
    list.append(item);
  }
  document.getElementById('archive').textContent = `Archive · ${chats.length} chat${chats.length === 1 ? '' : 's'} · read-only`;
}

function start() {
  const data = JSON.parse(document.getElementById('data').textContent);
  allChats = data.chats;
  allChats.forEach(chat => chatsById.set(chat.id, chat));
  renderSidebar(data.chats);
  document.getElementById('menu').addEventListener('click', () => setDrawer(true));
  document.getElementById('scrim').addEventListener('click', () => setDrawer(false));
  document.getElementById('chat').addEventListener('click', e => {
    const button = e.target.closest('.copy');
    if (button) { onCopy(button); return; }
    const arrow = e.target.closest('.branch button');
    if (arrow && !arrow.disabled) switchTo(arrow);
  });
  window.addEventListener('hashchange', onHashChange);
  if (data.chats.length) navigate(parseHash(location.hash), { replace: true });
  else document.getElementById('chat').append(el('div', 'empty', 'No chats in this archive'));
}

start();
