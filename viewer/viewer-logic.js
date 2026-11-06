// Viewer page logic: message tree, hash state and text rendering steps. Classic script, no imports.
// Messages use the compact shape { id, parent, sender, at, ... }.

function byAtThenIndex(a, b) {
  const x = a.m.at || '', y = b.m.at || '';
  if (x < y) return -1;
  if (x > y) return 1;
  return a.i - b.i;
}

// Children of a parent id (null for roots), ordered by `at` then array order.
function childrenOf(messages, parentId) {
  const ids = new Set(messages.map(m => m.id));
  return messages
    .map((m, i) => ({ m, i }))
    .filter(e => parentId === null
      ? (e.m.parent == null || !ids.has(e.m.parent))
      : e.m.parent === parentId)
    .sort(byAtThenIndex)
    .map(e => e.m);
}

// Root to leaf. An unknown leaf falls back to the message with the latest `at`.
function chainFrom(messages, leafId) {
  if (!messages || !messages.length) return [];
  const byId = new Map(messages.map(m => [m.id, m]));
  let cur = byId.get(leafId);
  if (!cur) {
    const latest = messages.map((m, i) => ({ m, i })).sort(byAtThenIndex).pop();
    cur = latest.m;
  }
  const chain = [];
  const seen = new Set();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.push(cur);
    cur = cur.parent != null ? byId.get(cur.parent) : null;
  }
  return chain.reverse();
}

function siblingsOf(messages, id) {
  const msg = messages.find(m => m.id === id);
  if (!msg) return { ids: [], index: -1 };
  const ids = childrenOf(messages, msg.parent == null ? null : msg.parent)
    .filter(m => msg.parent == null || m.parent === msg.parent)
    .map(m => m.id);
  return { ids, index: ids.indexOf(id) };
}

// Follows the latest child at each step down to a leaf.
function leafUnder(messages, id) {
  const seen = new Set();
  let cur = id;
  while (!seen.has(cur)) {
    seen.add(cur);
    const kids = childrenOf(messages, cur);
    if (!kids.length) break;
    cur = kids[kids.length - 1].id;
  }
  return cur;
}

// New leaf after moving delta siblings over, or null when there is no such sibling.
function switchBranch(messages, id, delta) {
  const s = siblingsOf(messages, id);
  const next = s.ids[s.index + delta];
  if (s.index < 0 || next === undefined) return null;
  return leafUnder(messages, next);
}

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch (e) { return null; }
}

function parseHash(hash) {
  const out = { chat: null, leaf: null, file: null, version: null };
  const text = String(hash || '').replace(/^#/, '');
  text.split('&').forEach(part => {
    const eq = part.indexOf('=');
    if (eq < 0) return;
    const key = part.slice(0, eq);
    if (!Object.prototype.hasOwnProperty.call(out, key)) return;
    const value = safeDecode(part.slice(eq + 1));
    if (value === null || value === '') return;
    if (key === 'version') {
      const n = parseInt(value, 10);
      out.version = isNaN(n) ? null : n;
    } else {
      out[key] = value;
    }
  });
  return out;
}

function formatHash(state) {
  const parts = [];
  ['chat', 'leaf', 'file', 'version'].forEach(key => {
    const v = state && state[key];
    if (v !== null && v !== undefined && v !== '') parts.push(key + '=' + encodeURIComponent(v));
  });
  return parts.length ? '#' + parts.join('&') : '';
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Math and citations cross marked and sanitizeHtml as plain text, and come back in fillPlaceholders.
// The brackets are punctuation to Markdown, so emphasis beside a placeholder closes as it would beside
// the math or link it stands for. The mark is one the text doesn't contain, so it can't be typed.
const PLACEHOLDER_END = '⟧';

function placeholderMark(text) {
  const t = String(text == null ? '' : text);
  let n = 0;
  while (t.includes(`⟦T${n}`)) n++;
  return `⟦T${n}`;
}

// Strings and { kind: 'M'|'C', index, raw } in order. kind M: index into math. kind C: a source's n.
function splitPlaceholders(text, mark) {
  const parts = [];
  const re = new RegExp(`${mark}([MC])(\\d+)${PLACEHOLDER_END}`, 'g');
  let from = 0, hit;
  while ((hit = re.exec(text))) {
    if (hit.index > from) parts.push(text.slice(from, hit.index));
    parts.push({ kind: hit[1], index: +hit[2], raw: hit[0] });
    from = re.lastIndex;
  }
  if (from < text.length) parts.push(text.slice(from));
  return parts;
}

// Code fences and spans are matched first and put back unchanged, so a `$` inside them is never math.
// An unclosed fence runs to the end, as it does in Markdown. A span can't cross a blank line.
const MATH_OR_CODE = new RegExp([
  '^ {0,3}(`{3,}|~{3,})[\\s\\S]*?(?:\\n {0,3}\\1[`~]*[ \\t]*(?=\\n|$)|(?![\\s\\S]))',
  '(`+)(?!`)(?:(?!\\n[ \\t]*\\n)[\\s\\S])*?[^`]\\2(?!`)',
  '\\\\\\$',
  '\\$\\$[\\s\\S]+?\\$\\$',
  '\\$(?![\\s\\d])(?:[^$\\n]*?[^\\s$])\\$(?![\\dA-Za-z])'
].join('|'), 'gm');

function protectMath(text, mark = placeholderMark(text)) {
  const math = [];
  const out = String(text).replace(MATH_OR_CODE, m => {
    if (m[0] !== '$') return m;
    math.push(m);
    return `${mark}M${math.length - 1}${PLACEHOLDER_END}`;
  });
  return { text: out, math, mark };
}

// Puts a placeholder per citation into Markdown text. cites: [{ end, url, title }].
// seen: the source list so far, when a message has several text blocks.
function addCitations(text, cites, seen, mark = placeholderMark(text)) {
  const t = String(text);
  const sources = seen || [];
  const at = c => (Number.isFinite(c.end) ? Math.min(Math.max(c.end, 0), t.length) : t.length);
  const marks = (cites || []).map((c, i) => ({ c, i, end: at(c) })).sort((a, b) => a.end - b.end || a.i - b.i);
  let out = '', from = 0;
  for (const { c, end } of marks) {
    let src = sources.find(s => s.url === c.url);
    if (!src) { src = { n: sources.length + 1, url: c.url, title: c.title }; sources.push(src); }
    out += `${t.slice(from, end)}${mark}C${src.n}${PLACEHOLDER_END}`;
    from = end;
  }
  return { text: out + t.slice(from), sources, mark };
}

function citeNode(doc, source) {
  const sup = doc.createElement('sup');
  sup.className = 'cite';
  const link = doc.createElement('a');
  link.textContent = source.n;
  link.setAttribute('title', source.title || '');
  if (/^https?:\/\//i.test(source.url)) {
    link.setAttribute('href', source.url);
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noopener');
  }
  sup.append(link);
  return sup;
}

// Works on the parsed, sanitized DOM, so a placeholder only ever becomes markup inside a text node.
// In code and attributes it goes back to its source text instead, and a citation there just goes.
// render(src, displayMode) returns HTML. A placeholder with no entry stays as it is.
function fillPlaceholders(root, { mark, math, sources, render }) {
  const doc = root.ownerDocument;
  const known = p => (p.kind === 'M' ? math[p.index] !== undefined : sources[p.index - 1] !== undefined);
  const bare = text => splitPlaceholders(text, mark).map(p => {
    if (typeof p === 'string') return p;
    if (!known(p)) return p.raw;
    return p.kind === 'M' ? bare(math[p.index]) : '';
  }).join('');
  const mathNodes = raw => {
    const box = doc.createElement('template');
    try {
      box.innerHTML = render(bare(raw).replace(/^\$+|\$+$/g, ''), raw.startsWith('$$'));
      return box.content;
    } catch (e) {
      return doc.createTextNode(bare(raw));
    }
  };

  const walker = doc.createTreeWalker(root, 4); // NodeFilter.SHOW_TEXT
  const texts = [];
  while (walker.nextNode()) if (walker.currentNode.nodeValue.includes(mark)) texts.push(walker.currentNode);
  for (const node of texts) {
    if (node.parentElement.closest('code, pre, .raw-html')) { node.nodeValue = bare(node.nodeValue); continue; }
    const part = doc.createDocumentFragment();
    for (const p of splitPlaceholders(node.nodeValue, mark)) {
      if (typeof p === 'string' || !known(p)) part.append(typeof p === 'string' ? p : p.raw);
      else part.append(p.kind === 'M' ? mathNodes(math[p.index]) : citeNode(doc, sources[p.index - 1]));
    }
    node.replaceWith(part);
  }
  root.querySelectorAll('*').forEach(n => {
    Array.from(n.attributes).forEach(a => { if (a.value.includes(mark)) a.value = bare(a.value); });
  });
}

// Sanitizer, ported from the NotebookLM viewer. Differences: nothing that loads keeps a URL except a
// non-SVG data:image, so a chat can't reach remote or local files. svg and math go too, since their
// foreign content is the usual way past a sanitizer, and KaTeX output is added after this step.
// This is the backstop: raw HTML in a chat already arrives escaped, as marked is set up in viewer-app.js.
const DANGEROUS_TAGS = 'script,style,iframe,object,embed,link,meta,form,base,frame,frameset,applet,noscript,template,svg,math,noembed,noframes,xmp,plaintext,listing,textarea,title,select,video,audio,source,track';
const URL_ATTRS = /^(href|src|xlink:href|action|formaction|srcdoc|poster|data)$/i;
const BAD_URL = /^[\s\u0000-\u001f]*(javascript|vbscript|data\s*:\s*text\/html)/i;
const LOADING_ATTRS = /^(src|srcset|lowsrc|dynsrc|poster|data|href|xlink:href)$/i;
const DROP_ATTRS = /^(on|(ping|background|srcdoc|action|formaction|style|id|name)$)/i; // id, name: DOM clobbering
const LINK_URL = /^(https?:|mailto:)/i;
const ATTR_NAME = /^[a-z][a-z0-9-]*$/; // A quote in a name would survive serializing, unescaped.

const NO_IMAGE = 'Image not available offline';
const URL_TEXT = /[a-z][a-z0-9+.-]*:\/\/|(^|\s)(\/\/|www\.)/i;
const NO_IMAGE_SPAN = '<span class="no-image">(?:Image|(\\d+) images) not available offline</span>';
const NO_IMAGE_RUN = new RegExp(NO_IMAGE_SPAN + '(?:(?:\\s|<br>|</?p>)*' + NO_IMAGE_SPAN + ')+', 'g');

function noImageHtml(count) {
  return '<span class="no-image">' + (count > 1 ? count + ' images not available offline' : NO_IMAGE) + '</span>';
}

// Images side by side, or in paragraphs of their own, make one line.
function collapseNoImage(html) {
  return html.replace(NO_IMAGE_RUN, run => {
    let count = 0;
    run.replace(new RegExp(NO_IMAGE_SPAN, 'g'), (span, n) => { count += +n || 1; return span; });
    return noImageHtml(count);
  });
}

function bareUrl(v) { return String(v).replace(/[\u0000-\u001f\s]+/g, ''); }
function isDataImage(v) { return /^data:image\/(?!svg)/i.test(bareUrl(v)); }

// parser: a DOMParser. Links stay clickable only for web and mail addresses.
function sanitizeHtml(html, parser) {
  const doc = parser.parseFromString(String(html), 'text/html');
  doc.querySelectorAll(DANGEROUS_TAGS).forEach(n => n.remove());
  if (!doc.body) return ''; // <frameset> takes the place of body
  const comments = doc.createTreeWalker(doc, 128); // NodeFilter.SHOW_COMMENT
  const dropped = [];
  while (comments.nextNode()) dropped.push(comments.currentNode);
  dropped.forEach(n => n.remove());
  doc.querySelectorAll('*').forEach(n => {
    const tag = String(n.tagName).toLowerCase();
    const link = tag === 'a' || tag === 'area';
    Array.from(n.attributes).forEach(a => {
      if (!ATTR_NAME.test(a.name)) n.removeAttributeNode(a);
      else if (DROP_ATTRS.test(a.name) || (URL_ATTRS.test(a.name) && BAD_URL.test(bareUrl(a.value)))) n.removeAttribute(a.name);
      else if (link && /^href$/i.test(a.name)) { if (!LINK_URL.test(bareUrl(a.value))) n.removeAttribute(a.name); }
      else if (LOADING_ATTRS.test(a.name) && (/^srcset$/i.test(a.name) || !isDataImage(a.value))) n.removeAttribute(a.name);
    });
    if (tag === 'img' && !n.getAttribute('src')) {
      // A failed download often has its URL as alt text, which is never shown.
      const alt = n.getAttribute('alt');
      const span = doc.createElement('span');
      span.className = 'no-image';
      span.textContent = alt && !URL_TEXT.test(alt) ? alt : NO_IMAGE;
      n.replaceWith(span);
    }
    if (link) { n.setAttribute('target', '_blank'); n.setAttribute('rel', 'noopener'); }
  });
  return collapseNoImage(doc.body.innerHTML);
}

// Plain text for an expanded tool call: the one thing it was given, or its whole input as JSON.
function toolInputText(input) {
  if (input == null) return '';
  if (typeof input !== 'object') return String(input);
  const keys = Object.keys(input);
  if (!keys.length) return '';
  if (typeof input.command === 'string') return input.command;
  if (keys.length === 1 && typeof input[keys[0]] === 'string') return input[keys[0]];
  return JSON.stringify(input, null, 2);
}

if (typeof module === 'object' && module.exports) {
  module.exports = { chainFrom, siblingsOf, leafUnder, switchBranch, parseHash, formatHash, placeholderMark, splitPlaceholders, protectMath, addCitations, fillPlaceholders, sanitizeHtml, toolInputText };
}
