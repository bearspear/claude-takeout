// Viewer page logic: message tree, hash state and text rendering steps. Classic script, no imports.
// Messages use the compact shape { id, parent, sender, at, ... }.

function byAtThenIndex(a, b) {
  const x = a.m.at || '', y = b.m.at || '';
  if (x < y) return -1;
  if (x > y) return 1;
  return a.i - b.i;
}

// Each message list's children, built once: { roots, kids: parent id -> children, byId }, both ordered
// by `at` then array order. Rebuilt if the list changes length. Without it, walking a long chat's tree
// rescans every message at each step.
const treeIndex = new WeakMap();
function treeOf(messages) {
  const cached = treeIndex.get(messages);
  if (cached && cached.length === messages.length) return cached;
  const ids = new Set(messages.map(m => m.id));
  const roots = [], kids = new Map();
  messages.forEach((m, i) => {
    const e = { m, i };
    if (m.parent == null || !ids.has(m.parent)) roots.push(e);
    if (m.parent != null) {
      if (!kids.has(m.parent)) kids.set(m.parent, []);
      kids.get(m.parent).push(e);
    }
  });
  const order = list => list.sort(byAtThenIndex).map(e => e.m);
  const tree = { length: messages.length, roots: order(roots), kids: new Map(), byId: new Map(messages.map(m => [m.id, m])) };
  for (const [parent, list] of kids) tree.kids.set(parent, order(list));
  treeIndex.set(messages, tree);
  return tree;
}

// Children of a parent id (null for roots), ordered by `at` then array order.
function childrenOf(messages, parentId) {
  const tree = treeOf(messages);
  return (parentId === null ? tree.roots : tree.kids.get(parentId) || []).slice();
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
  const msg = treeOf(messages).byId.get(id);
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

// Code fences, spans and web addresses are matched first and put back unchanged, so a `$` inside them
// is never math. An unclosed fence runs to the end, as it does in Markdown. A span can't cross a blank line.
const MATH_OR_CODE = new RegExp([
  '^ {0,3}(`{3,}|~{3,})[\\s\\S]*?(?:\\n {0,3}\\1[`~]*[ \\t]*(?=\\n|$)|(?![\\s\\S]))',
  '(`+)(?!`)(?:(?!\\n[ \\t]*\\n)[\\s\\S])*?[^`]\\2(?!`)',
  '(?<![A-Za-z0-9])(?:https?://|www\\.)[^\\s<]*',
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

// Where a bare address has to end: marked's autolink would otherwise take a citation in as part of it.
function beforeCitation(src) {
  const at = src.search(/⟦T\d+C\d+⟧/);
  return at < 0 ? src : src.slice(0, at);
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
// A citation in a link lands right after the link. marked percent-encodes any placeholder in a URL.
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
    const link = node.parentElement.closest('a');
    const part = doc.createDocumentFragment();
    const after = [];
    for (const p of splitPlaceholders(node.nodeValue, mark)) {
      if (typeof p === 'string' || !known(p)) part.append(typeof p === 'string' ? p : p.raw);
      else if (p.kind === 'M') part.append(mathNodes(math[p.index]));
      else if (link) after.push(citeNode(doc, sources[p.index - 1]));
      else part.append(citeNode(doc, sources[p.index - 1]));
    }
    node.replaceWith(part);
    if (link) link.after(...after);
  }
  const encoded = new RegExp(`${encodeURI(mark)}([MC]\\d+)${encodeURI(PLACEHOLDER_END)}`, 'g');
  root.querySelectorAll('*').forEach(n => {
    Array.from(n.attributes).forEach(a => {
      const value = a.value.replace(encoded, `${mark}$1${PLACEHOLDER_END}`);
      if (value.includes(mark)) a.value = bare(value);
    });
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

// Longest text that gets syntax colors. Past this the page gains too many elements to stay quick.
const HIGHLIGHT_LIMIT = 200000;

// highlight.js's Markdown opens italics or bold at any _ and runs to the next one, so "sept21_part1" turns
// the rest of a transcript italic. As in Markdown itself, _ inside a word opens nothing, and neither _ nor *
// carries past a blank line. Changes the language in place before its first use. The worker runs this
// function's own source, so it uses nothing from this file.
function tameMarkdown(hljs) {
  const md = hljs && typeof hljs.getLanguage === 'function' ? hljs.getLanguage('markdown') : null;
  if (!md) return;
  const done = new Set();
  const visit = mode => {
    if (!mode || typeof mode !== 'object' || done.has(mode)) return;
    done.add(mode);
    if ((mode.className === 'emphasis' || mode.className === 'strong') && Array.isArray(mode.variants)) {
      for (const v of mode.variants) {
        if (!v.begin || !v.end || v.tamed) continue;
        const underscore = String(v.begin.source || v.begin).startsWith('_');
        const begin = String(v.begin.source || v.begin), end = String(v.end.source || v.end);
        v.begin = new RegExp(underscore ? `(?<![A-Za-z0-9_])${begin}` : begin);
        v.end = new RegExp(underscore ? `${end}(?![A-Za-z0-9_])|\\n\\s*\\n` : `${end}|\\n\\s*\\n`);
        v.tamed = true;
      }
    }
    for (const list of [mode.contains, mode.variants]) if (Array.isArray(list)) list.forEach(visit);
  };
  visit(md);
}

// The highlighter's language name for a file. Its names cover most extensions as they are.
function languageOfFile(name) {
  const ext = /\.([a-z0-9+#-]+)$/i.exec(String(name || ''));
  if (!ext) return '';
  const lower = ext[1].toLowerCase();
  return lower === 'htm' ? 'xml' : lower;
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

// Generated files. Their text is hostile until shown otherwise: previews run in a sandboxed frame under this policy.
const PREVIEW_CSP = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; base-uri 'none'; form-action 'none'";

const OFFLINE_NOTE = "This file type can't preview offline. Code view shows the full source.";
const REMOTE_NOTE = 'This file loads a script from the internet, which the viewer blocks, so it may not work here. Code view shows the full source.';

const TAG_OPEN = /<!--|<([a-z][^\s/>]*)/gi;
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title']);
const TAG_ATTR = /[\s/]*(?:(>)|([^\s/>=][^\s/>=]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]*)))?)/y;

// Reads the attributes after a tag name. Null when the tag never closes, as then a browser drops it too.
function readAttrs(html, from) {
  const attrs = [];
  TAG_ATTR.lastIndex = from;
  for (let hit; (hit = TAG_ATTR.exec(html));) {
    if (hit[1]) return { attrs, end: TAG_ATTR.lastIndex };
    attrs.push({ name: hit[2].toLowerCase(), value: hit[3] ?? hit[4] ?? hit[5] ?? '', raw: hit[0] });
  }
  return null;
}

// Offers each script and link to visit(tag, attrs), skipping comments, attribute values and raw text such
// as a string in a script. visit returns a replacement or null. One pass that stops at anything unfinished, so a huge
// file of unclosed tags can't stall the page.
function rewriteTags(html, visit) {
  const out = [];
  let from = 0;
  const open = new RegExp(TAG_OPEN);
  for (let hit; (hit = open.exec(html));) {
    if (hit[0] === '<!--') {
      const end = html.indexOf('-->', open.lastIndex);
      if (end < 0) break;
      open.lastIndex = end + 3;
      continue;
    }
    const tag = hit[1].toLowerCase();
    const read = readAttrs(html, open.lastIndex);
    if (!read) break;
    let end = read.end;
    if (RAW_TEXT.has(tag)) {
      const close = new RegExp(`</${tag}[\\s/>]`, 'gi');
      close.lastIndex = end;
      const shut = close.exec(html);
      if (!shut) break;
      end = html.indexOf('>', shut.index);
      if (end < 0) break;
      end++;
    }
    open.lastIndex = end;
    const swap = tag === 'script' || tag === 'link' ? visit(tag, read.attrs) : null;
    if (swap !== null) {
      out.push(html.slice(from, hit.index), swap);
      from = end;
    }
  }
  out.push(html.slice(from));
  return out.join('');
}

// A file beside this one, by bare name or ./name. Null for anything that points elsewhere.
function siblingName(url) {
  const name = url.trim().replace(/^\.\//, '');
  return /^[^/\\:?#]+$/.test(name) && !name.includes('..') && name !== '.' ? name : null;
}

const attrOf = (attrs, name) => attrs.find(a => a.name === name);

// Puts files from the export into the document, since a sandboxed frame can't load them.
// Only scripts and stylesheets, by name: a script can read what lands in its document, so any other file
// in the chat would be a file it could read and send out.
// lookup(name): the sibling's text or null. What can't be found stays as it is, for the policy to block.
function inlineSiblings(html, lookup) {
  const text = (attr, type) => {
    const name = attr ? siblingName(attr.value) : null;
    return name !== null && type.test(name) ? lookup(name) : null;
  };
  // defer and async mean nothing on an inline script, so those go after the document, where they would have run.
  const late = [];
  const kept = attrs => attrs.map(a => ' ' + a.raw.replace(/^[\s/]+/, '')).join('');
  const out = rewriteTags(String(html), (tag, attrs) => {
    if (tag === 'script') {
      const src = attrOf(attrs, 'src');
      const code = text(src, /\.m?js$/i);
      if (code == null) return null;
      const rest = kept(attrs.filter(a => a !== src));
      // \x21 rather than \!, which a regular expression with the u flag rejects.
      const script = `<script${rest}>${String(code).replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\x21--')}</script>`;
      const type = attrOf(attrs, 'type');
      if ((attrOf(attrs, 'defer') || attrOf(attrs, 'async')) && !(type && /^\s*module\s*$/i.test(type.value))) {
        late.push(script);
        return '';
      }
      return script;
    }
    const rel = attrOf(attrs, 'rel');
    if (!rel || !/(^|\s)stylesheet(\s|$)/i.test(rel.value)) return null;
    const css = text(attrOf(attrs, 'href'), /\.css$/i);
    if (css == null) return null;
    const media = attrOf(attrs, 'media');
    return `<style${media ? kept([media]) : ''}>${String(css).replace(/<\/(style)/gi, '<\\/$1')}</style>`;
  });
  return out + late.join('');
}

function remoteScripts(html) {
  let count = 0;
  rewriteTags(String(html), (tag, attrs) => {
    const src = tag === 'script' ? attrOf(attrs, 'src') : null;
    if (src && /^\s*(?:https?:|[/\\]{2})/i.test(src.value)) count++;
    return null;
  });
  return count;
}

// The policy comes first, before anything the file wrote can be parsed.
function previewDoc(text, lookup) {
  const rest = String(text).replace(/^﻿?\s*<!doctype[^>]*>/i, '');
  return {
    srcdoc: `<!doctype html><meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">${inlineSiblings(rest, lookup)}`,
    remote: remoteScripts(rest),
  };
}

// The file and version a hash can really open, or null. A bad version means the latest.
// added: ViewerData.added. An x id opens from any chat, since a hash can be shared.
function resolveFile(files, id, version, added) {
  if (addedEntryFor(added, id)) return { file: id, version: 0 };
  if (id == null || !files || !Object.prototype.hasOwnProperty.call(files, id)) return null;
  const count = (files[id].versions || []).length;
  if (!count) return null;
  return { file: id, version: Number.isInteger(version) && version >= 0 && version < count ? version : count - 1 };
}

// views: the tabs this version gets, first one showing. None and not missing: details and maybe a link.
function fileViews(kind, version) {
  const text = version.text != null;
  const href = version.href != null;
  if (kind === 'missing' || (!text && !href)) return { views: [], note: '', missing: true };
  const preview = kind === 'html' || kind === 'svg' || kind === 'md' ? text
    : kind === 'image' || kind === 'audio' || kind === 'video' ? href
    : kind === 'pdf' && href && /\.pdf$/i.test(version.href);
  const views = [...(preview ? ['preview'] : []), ...(text ? ['code'] : [])];
  return { views, note: text && (kind === 'react' || kind === 'mermaid') ? OFFLINE_NOTE : '', missing: false };
}

const KIND_WORDS = { html: 'Document', md: 'Document', pdf: 'Document', svg: 'Image', image: 'Image', audio: 'Audio', video: 'Video', code: 'Code', react: 'Component', mermaid: 'Diagram', binary: 'File' };

function fileKindLabel(file) {
  if (file.kind === 'missing') return 'Not in this export';
  const ext = (/\.([a-z0-9]{1,6})$/i.exec(file.name || '') || [])[1];
  return [KIND_WORDS[file.kind] || 'File', ext && ext.toUpperCase()].filter(Boolean).join(' · ');
}

// Opening a link leaves the sandbox, so only for types a browser won't run as a page. A list of what is safe,
// because a list of what isn't always misses one: Chromium reads .xbl as XML, so it would run XHTML in one.
const OPENABLE_EXTENSIONS = new Set(('pdf doc docx xls xlsx ppt pptx odt ods odp rtf pages numbers key epub zip gz tar 7z rar ' +
  'csv tsv txt log md markdown json png jpg jpeg gif webp heic tif tiff bmp mp3 m4a wav ogg flac aac mp4 mov webm m4v mkv avi').split(' '));

// hrefs are relative and percent-encoded, so ?, #, : or \ means the name at the end isn't the file that opens.
function openableHref(href) {
  const text = String(href || '');
  if (/[?#:\\]/.test(text)) return false;
  const ext = /\.([a-z0-9]+)$/i.exec(text.split('/').pop());
  return !!ext && OPENABLE_EXTENSIONS.has(ext[1].toLowerCase());
}

// ---- Archive files ----
// Added = { path, chat, kind, size, href, part, key }. A null chat shows with every chat.
const ADDED_ID = /^x(0|[1-9]\d*)$/;
const ADDED_IMAGE = /\.(?:png|jpe?g|gif|webp)$/i;
const ADDED_AUDIO = /\.(?:m4a|mp3|wav|ogg)$/i;
const ADDED_VIDEO = /\.(?:mp4|webm|mov)$/i;
const ADDED_TEXT_KINDS = new Set(['html', 'svg', 'md', 'code', 'react', 'mermaid']);

const isAddedId = id => typeof id === 'string' && ADDED_ID.test(id);

function addedEntryFor(added, id) {
  if (!isAddedId(id) || !Array.isArray(added)) return null;
  const index = Number(id.slice(1));
  return index < added.length ? added[index] : null;
}

// The kind the panel goes by. Audio and video have no kind of their own in the data, and only these image types show.
function addedKind(entry) {
  const href = entry.href || '';
  if (ADDED_AUDIO.test(href)) return 'audio';
  if (ADDED_VIDEO.test(href)) return 'video';
  if (/\.markdown$/i.test(href)) return 'md'; // kindFor has only .md, and exports keep to that
  return entry.kind === 'image' && !ADDED_IMAGE.test(href) ? 'binary' : entry.kind;
}

// The GenFile for an x id, or null. Its text arrives later, from the part. Text with no part was too large to embed.
function addedFile(added, id) {
  const entry = addedEntryFor(added, id);
  if (!entry) return null;
  const kind = addedKind(entry);
  const part = entry.part == null ? null : entry.part;
  return {
    name: String(entry.path).split('/').pop(), path: entry.path, kind, added: true, tooLarge: part === null && ADDED_TEXT_KINDS.has(kind),
    versions: [{ label: '', text: null, href: entry.href == null ? null : entry.href, part, key: entry.key == null ? null : entry.key }],
  };
}

const addedForChat = (added, chatId) => (added || []).filter(a => a.chat == null || a.chat === chatId);

const byName = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

function sortedNode(node) {
  return {
    name: node.name,
    files: node.files.sort((a, b) => byName(a.path.split('/').pop(), b.path.split('/').pop())),
    folders: [...node.folders.values()].sort((a, b) => byName(a.name, b.name)).map(sortedNode),
  };
}

// One root node, named '', holding the view's top-level files and folders. [] when the view is empty.
function addedTree(added, chatId) {
  const shown = addedForChat(added, chatId);
  if (!shown.length) return [];
  const blank = name => ({ name, files: [], folders: new Map() });
  const root = blank('');
  for (const entry of shown) {
    const segments = String(entry.path).split('/');
    segments.pop();
    let node = root;
    for (const name of segments) {
      if (!node.folders.has(name)) node.folders.set(name, blank(name));
      node = node.folders.get(name);
    }
    node.files.push(entry);
  }
  return [sortedNode(root)];
}

// Disks on a Mac can hold names decomposed, so both sides are normalized. The query is plain text.
function filterAdded(added, query) {
  const fold = s => s.normalize('NFC').toLowerCase();
  const q = fold(String(query).trim());
  return (added || []).filter(a => fold(String(a.path).split('/').pop()).includes(q));
}

// A prompt split at its code fences: [{ t: 'text', text }, { t: 'code', lang, text }].
// Only fences change: other text stays as typed, and an unclosed fence stays text.
function splitFences(text) {
  const lines = String(text).split('\n');
  const parts = [];
  let plain = [];
  const flush = beforeFence => {
    if (!plain.length) return;
    const body = plain.join('\n');
    if (body.trim() || !parts.length && !beforeFence) parts.push({ t: 'text', text: body });
    plain = [];
  };
  // The shortest opener of each kind already known to have no closer. A longer one
  // can't have one either, so thousands of unclosed fences stay fast.
  const unclosed = { '`': Infinity, '~': Infinity };
  for (let i = 0; i < lines.length; i++) {
    const open = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/.exec(lines[i]);
    if (!open) { plain.push(lines[i]); continue; }
    const mark = open[1];
    let end = -1;
    if (mark.length < unclosed[mark[0]]) {
      for (let k = i + 1; k < lines.length; k++) {
        const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(lines[k]);
        if (close && close[1][0] === mark[0] && close[1].length >= mark.length) { end = k; break; }
      }
      if (end < 0) unclosed[mark[0]] = mark.length;
    }
    if (end < 0) { plain.push(lines[i]); continue; }
    flush(true);
    parts.push({ t: 'code', lang: open[2], text: lines.slice(i + 1, end).map(l => l.replace(/\r$/, '')).join('\n') });
    i = end;
  }
  flush(false);
  return parts;
}

// What the Copy button puts on the clipboard: the raw text of the message's text blocks, as sent or written
// (before citations and math are touched), joined by a blank line. '' when there is nothing to copy.
function copyText(msg) {
  const parts = [];
  for (const b of (msg && msg.blocks) || []) if (b && b.t === 'text' && b.text) parts.push(b.text);
  return parts.join('\n\n');
}

// Search over every message on every branch, plus titles. One entry per message (and per title, msg null).
function buildSearchIndex(chats) {
  const index = [];
  for (const chat of chats) {
    const title = chat.title || '';
    index.push({ chat: chat.id, msg: null, text: title, lower: title.toLowerCase() });
    for (const m of chat.messages || []) {
      const parts = [];
      for (const b of m.blocks || []) if (b && b.t === 'text' && b.text) parts.push(b.text);
      for (const a of m.attachments || []) { if (a.name) parts.push(a.name); if (a.text) parts.push(a.text); }
      for (const u of m.uploads || []) if (u.name) parts.push(u.name);
      if (!parts.length) continue;
      const text = parts.join('\n');
      index.push({ chat: chat.id, msg: m.id, text, lower: text.toLowerCase() });
    }
  }
  return index;
}

// Offset in text that matches `at` in text.toLowerCase(), which differs in length for a few characters.
function originalOffset(text, at) {
  let lowered = 0, i = 0;
  while (i < text.length && lowered < at) {
    const ch = String.fromCodePoint(text.codePointAt(i));
    lowered += ch.toLowerCase().length;
    i += ch.length;
  }
  return i;
}

const SNIPPET_LENGTH = 80;

function snippetAt(text, lower, at, length) {
  let start = at, end = at + length;
  if (lower.length !== text.length) { start = originalOffset(text, at); end = originalOffset(text, at + length); }
  let from = end - start > 50 ? start : Math.max(0, start - 30);
  let to = Math.min(text.length, from + SNIPPET_LENGTH);
  if (/[\uDC00-\uDFFF]/.test(text[from] || '')) from++;
  if (/[\uD800-\uDBFF]/.test(text[to - 1] || '')) to--;
  const body = text.slice(from, to).replace(/\s+/g, ' ');
  return (from > 0 ? '\u2026' : '') + body + (to < text.length ? '\u2026' : '');
}

// A search query, case-insensitive: words must all appear, in any order; "a phrase" must appear as
// written; a OR b takes either (a capital OR only); -word or -"a phrase" excludes. Returns
// { all: [[alternatives]...], none: [terms] }, every term lowercase.
function parseQuery(query) {
  const all = [], none = [];
  let orNext = false;
  const re = /(-?)"([^"]*)"?|(\S+)/g;
  for (let m; (m = re.exec(String(query || ''))) !== null;) {
    let term, negative = false;
    if (m[2] !== undefined) { term = m[2]; negative = m[1] === '-'; }
    else if (m[3] === 'OR') { orNext = all.length > 0; continue; }
    else if (/^-[^-]/.test(m[3])) { term = m[3].slice(1); negative = true; }
    else if (m[3] === '-') continue;
    else term = m[3];
    term = term.trim().toLowerCase();
    if (!term) continue;
    if (negative) none.push(term);
    else if (orNext) all[all.length - 1].push(term);
    else all.push([term]);
    orNext = false;
  }
  return { all, none };
}

// Up to `limit` hits, in index order: { chat, msg (null for a title), snippet, terms }. Each entry must
// hold every word or phrase (or one of its OR alternatives) and none of the excluded ones. terms: the
// query's words found in that entry, for highlighting; the snippet is cut around the first of them.
function searchChats(index, query, limit = 50) {
  const q = parseQuery(query);
  const hits = [];
  if (!q.all.length) return hits;
  for (const e of index) {
    if (hits.length >= limit) break;
    if (!queryMatches(q, e.lower)) continue;
    const terms = q.all.flat().filter(t => e.lower.includes(t));
    let at = -1, len = 0;
    for (const t of terms) {
      const i = e.lower.indexOf(t);
      if (at < 0 || i < at) { at = i; len = t.length; }
    }
    hits.push({ chat: e.chat, msg: e.msg, snippet: snippetAt(e.text, e.lower, at, len), terms });
  }
  return hits;
}

// Whether lowercase text satisfies a parsed query: every word or phrase (or an OR alternative), none excluded.
function queryMatches(q, lower) {
  return q.all.length > 0 && q.all.every(alts => alts.some(t => lower.includes(t))) && !q.none.some(t => lower.includes(t));
}

// Occurrences of any of the (lowercase) terms in text, scanning left to right; where two start at one
// spot the longer counts, and occurrences don't overlap. markTerms and the chat highlight scan the same way.
function countTerms(text, terms) {
  return countLower(String(text).toLowerCase(), terms);
}

// countTerms on text already in lowercase, jumping with indexOf from one occurrence to the next.
function countLower(lower, terms) {
  const wanted = [...new Set((terms || []).filter(Boolean))];
  if (!wanted.length) return 0;
  const next = wanted.map(w => lower.indexOf(w));
  let n = 0;
  for (let i = 0; ;) {
    let best = -1, len = 0;
    for (let j = 0; j < wanted.length; j++) {
      if (next[j] >= 0 && next[j] < i) next[j] = lower.indexOf(wanted[j], i);
      const p = next[j];
      if (p >= 0 && (best < 0 || p < best || (p === best && wanted[j].length > len))) { best = p; len = wanted[j].length; }
    }
    if (best < 0) return n;
    n++;
    i = best + len;
  }
}

// text.toLowerCase(), and where that changes the length (a Turkish İ), at: the offset in text of each
// offset in the lowercase text, so a match found in one can be cut out of the other. at is null otherwise.
function foldCase(text) {
  const t = String(text);
  const lower = t.toLowerCase();
  if (lower.length === t.length) return { lower, at: null };
  const at = [];
  let out = '';
  for (let i = 0; i < t.length;) {
    const ch = String.fromCodePoint(t.codePointAt(i));
    const l = ch.toLowerCase();
    for (let j = 0; j < l.length; j++) at.push(i);
    out += l;
    i += ch.length;
  }
  at.push(t.length);
  return { lower: out, at };
}

// marked's emphasis parsing is quadratic, so a text block with this many * and _ is shown as plain text.
const EMPHASIS_LIMIT = 4000;

// The text a text block shows in the conversation, near enough for counting matches: math (drawn by
// KaTeX) and link and image addresses left out, code and bare web addresses kept as written.
function shownText(markdown) {
  const md = String(markdown || '');
  if ((md.match(/[*_]/g) || []).length > EMPHASIS_LIMIT) return md;
  const code = [];
  const kept = md.replace(MATH_OR_CODE, m => {
    if (m[0] === '$') return ' ';
    if (/^(?: {0,3}[`~]|`)/.test(m)) { code.push(m); return `\uE010${code.length - 1}\uE011`; }
    return m;
  });
  return kept
    .replace(/!\[[^\]\n]*\]\((?:[^()\s]|\([^()\s]*\))*(?:\s+"[^"\n]*")?\)/g, ' ')
    .replace(/\[([^\]\n]*)\]\((?:[^()\s]|\([^()\s]*\))*(?:\s+"[^"\n]*")?\)/g, '$1')
    .replace(/\uE010(\d+)\uE011/g, (m, i) => code[i]);
}

// Each message's shown text in lowercase, kept for the next keystroke's search.
const shownLower = new WeakMap();
function messageShownLower(m) {
  if (!shownLower.has(m)) {
    const text = (m.blocks || []).filter(b => b && b.t === 'text' && b.text).map(b => shownText(b.text)).join('\n');
    shownLower.set(m, text.toLowerCase());
  }
  return shownLower.get(m);
}

// What the in-chat stepper walks: the messages whose visible text (prompts and replies, not thinking,
// tools, pasted text or upload names, which don't show in the conversation) matches the query, in the
// chat's message order, each with how many occurrences it shows (math and link addresses aside).
function findPlan(chat, query) {
  const q = parseQuery(query);
  const terms = q.all.flat();
  const items = [];
  for (const m of (chat && chat.messages) || []) {
    const lower = messageShownLower(m);
    if (!lower || !queryMatches(q, lower)) continue;
    const count = countLower(lower, terms);
    if (count) items.push({ msg: m.id, count });
  }
  return { terms, items, total: items.reduce((n, i) => n + i.count, 0) };
}

// Hits by chat, best first: chats whose title matched, then those with the most matching messages,
// then index order (newest chats first). Each: { chat, title, count, snippets: up to perChat message hits }.
function groupHits(hits, perChat = 3) {
  const groups = new Map();
  hits.forEach((h, i) => {
    if (!groups.has(h.chat)) groups.set(h.chat, { chat: h.chat, title: false, count: 0, snippets: [], order: i, terms: [] });
    const g = groups.get(h.chat);
    for (const t of h.terms || []) if (!g.terms.includes(t)) g.terms.push(t);
    if (h.msg === null) { g.title = true; return; }
    g.count++;
    if (g.snippets.length < perChat) g.snippets.push(h);
  });
  return [...groups.values()]
    .sort((a, b) => (b.title - a.title) || (b.count - a.count) || (a.order - b.order))
    .map(({ order, ...g }) => g);
}

// text split into [{ text, hit }] around every case-insensitive occurrence of the terms, longest first
// where two start together.
function markTerms(text, terms) {
  const t = String(text);
  const lower = t.toLowerCase();
  const wanted = (terms || []).filter(Boolean).slice().sort((a, b) => b.length - a.length);
  const out = [];
  let from = 0, i = 0;
  const offset = at => (lower.length === t.length ? at : originalOffset(t, at));
  while (i < lower.length) {
    const term = wanted.find(w => lower.startsWith(w, i));
    if (!term) { i++; continue; }
    const start = offset(i), end = offset(i + term.length);
    if (start > from) out.push({ text: t.slice(from, start), hit: false });
    out.push({ text: t.slice(start, end), hit: true });
    from = end;
    i += term.length;
  }
  if (from < t.length || !out.length) out.push({ text: t.slice(from), hit: false });
  return out;
}

// Chip names for pasted text: claude.ai gives it no name. Numbered when a prompt has several.
function attachmentNames(attachments) {
  const list = Array.isArray(attachments) ? attachments : [];
  const unnamed = list.filter(a => !(a && a.name)).length;
  let n = 0;
  return list.map(a => (a && a.name ? a.name : unnamed > 1 ? `Pasted text ${++n}` : 'Pasted text'));
}

// A chat's files for the Files list, newest first: outputs (each file Claude shared, once:
// { id, name, kind, versions }, ordered by the last card that shows it), working (files Claude made but
// didn't share, such as helper scripts; same shape) and uploads (every upload and pasted text in the
// chat, once: { name, item for the popup, pasted }). A viewer built before files carried `shared` has
// no working files: everything is an output, as it was.
function chatFiles(chat) {
  const files = (chat && chat.files) || {};
  const messages = (chat && Array.isArray(chat.messages)) ? chat.messages : [];
  const lastSeen = new Map();  // file id -> position of its last card in the chat
  let position = 0;
  for (const m of messages) {
    for (const b of m.blocks || []) if (b && b.t === 'card' && Object.prototype.hasOwnProperty.call(files, b.file)) lastSeen.set(b.file, position++);
  }
  const all = [...lastSeen.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => ({ id, name: files[id].name || 'Untitled', kind: files[id].kind, versions: (files[id].versions || []).length || 1 }));
  const outputs = all.filter(o => files[o.id].shared !== false);
  const working = all.filter(o => files[o.id].shared === false);
  const uploads = [];
  const seen = new Set();
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    for (const u of m.uploads || []) {
      if (!u) continue;
      const name = uploadName(u) || 'Untitled';
      const key = `u\n${u.href || ''}\n${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      uploads.push({ name, item: u.name ? u : { ...u, name }, pasted: false });
    }
    const pastedNames = attachmentNames(m.attachments);
    (m.attachments || []).forEach((a, j) => {
      if (!a || typeof a.text !== 'string') return;
      const key = `p\n${pastedNames[j]}\n${a.text}`;
      if (seen.has(key)) return;
      seen.add(key);
      uploads.push({ name: pastedNames[j], item: { name: pastedNames[j], href: null, text: a.text }, pasted: !a.name });
    });
  }
  return { outputs, working, uploads };
}

// What "Also search inside files" reads: each chat's generated files (their newest version) and its
// uploads, each once. Pasted text is left out, since the main search already reads it.
// [{ chat, kind: 'file' | 'upload', id (file id, for 'file'), version, item (the upload, for 'upload'),
//    name, text (inline text or null), part, key (where text that was moved out lives) }]
function fileSearchSources(chats) {
  const out = [];
  const where = v => {
    const text = v && typeof v.text === 'string' ? v.text : null;
    const part = v && Number.isSafeInteger(v.part) && v.part > 0 ? v.part : null;
    return { text, part, key: part ? v.key : null };
  };
  for (const chat of chats || []) {
    if (!chat) continue;
    const { outputs, working } = chatFiles(chat);
    for (const o of [...outputs, ...working]) {
      const versions = (chat.files[o.id] && chat.files[o.id].versions) || [];
      const version = versions.length - 1;
      const w = where(versions[version]);
      if (w.text !== null || w.part !== null) out.push({ chat: chat.id, kind: 'file', id: o.id, version, item: null, name: o.name, ...w });
    }
    const seen = new Set();
    for (const m of chat.messages || []) {
      for (const u of m.uploads || []) {
        const w = where(u);
        if (w.text === null && w.part === null) continue;
        const name = uploadName(u) || 'Untitled';
        const key = `${u.href || ''}\n${name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ chat: chat.id, kind: 'upload', id: null, version: null, item: u.name ? u : { ...u, name }, name, ...w });
      }
    }
  }
  return out;
}

// A file's hit for a parsed query (parseQuery), or null: { snippet, terms }. The name and the text are
// searched together; the snippet comes from the text when a term is in it, otherwise it is the name.
function fileHit(q, name, text) {
  const t = String(text || '');
  const lowerText = t.toLowerCase();
  const n = String(name || '');
  if (!queryMatches(q, `${n.toLowerCase()}\n${lowerText}`)) return null;
  const terms = q.all.flat().filter(w => lowerText.includes(w) || n.toLowerCase().includes(w));
  let at = -1, len = 0;
  for (const w of terms) {
    const i = lowerText.indexOf(w);
    if (i >= 0 && (at < 0 || i < at)) { at = i; len = w.length; }
  }
  return { snippet: at < 0 ? n : snippetAt(t, lowerText, at, len), terms };
}

// An upload with no name is called by the file it was saved as. '' when there is none.
function uploadName(u) {
  if (u && u.name) return u.name;
  const last = u && typeof u.href === 'string' ? u.href.split('/').pop() : '';
  try { return decodeURIComponent(last); } catch (e) { return last; }
}

// Gives each chat its project back from data.projects. An index that names no project means no project.
function linkProjects(data) {
  const projects = Array.isArray(data.projects) ? data.projects : [];
  for (const chat of data.chats) {
    const at = chat.project;
    if (at && typeof at === 'object') continue;
    chat.project = Number.isInteger(at) && at >= 0 && at < projects.length ? projects[at] : null;
  }
  return data.chats;
}

// Chats outside any project, and the projects sorted by name. Both keep the order of `chats`.
// Chats under their project. Two projects with one name but different instructions, docs or files are
// two groups, the later labelled "Name (2)". Equal ones are one group: older viewers give each chat its
// own copy of the project, so object identity alone can't tell.
function groupChats(chats) {
  const recents = [];
  const groups = new Map();
  const keyOf = p => JSON.stringify([p.name || '', typeof p.instructions === 'string' ? p.instructions.length : 0,
    (Array.isArray(p.docs) ? p.docs : []).map(d => [d && d.name, d && typeof d.text === 'string' ? d.text.length : 0]),
    (Array.isArray(p.files) ? p.files : []).map(f => f && f.name)]);
  for (const chat of chats) {
    if (!chat.project) { recents.push(chat); continue; }
    const key = keyOf(chat.project);
    if (!groups.has(key)) groups.set(key, { name: chat.project.name || 'Untitled project', chats: [] });
    groups.get(key).chats.push(chat);
  }
  const named = new Map();
  for (const g of groups.values()) {
    const n = (named.get(g.name) || 0) + 1;
    named.set(g.name, n);
    if (n > 1) g.name = `${g.name} (${n})`;
  }
  return { recents, projects: [...groups.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}

if (typeof module === 'object' && module.exports) {
  module.exports = { splitFences, chainFrom, siblingsOf, leafUnder, switchBranch, parseHash, formatHash, placeholderMark, splitPlaceholders, protectMath, addCitations, beforeCitation, fillPlaceholders, sanitizeHtml, toolInputText, HIGHLIGHT_LIMIT, tameMarkdown, languageOfFile, PREVIEW_CSP, REMOTE_NOTE, inlineSiblings, remoteScripts, previewDoc, resolveFile, OPENABLE_EXTENSIONS, isAddedId, addedFile, addedForChat, addedTree, filterAdded, fileViews, fileKindLabel, openableHref, buildSearchIndex, searchChats, parseQuery, groupHits, markTerms, chatFiles, countTerms, foldCase, shownText, findPlan, groupChats, linkProjects, copyText, attachmentNames, uploadName, fileSearchSources, fileHit };
}
