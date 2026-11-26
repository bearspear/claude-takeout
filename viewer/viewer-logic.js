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
  let session = null, msg = null;
  text.split('&').forEach(part => {
    const eq = part.indexOf('=');
    if (eq < 0) return;
    const key = part.slice(0, eq);
    if (key === 'session' || key === 'msg') {
      const v = safeDecode(part.slice(eq + 1));
      if (v !== null && v !== '') { if (key === 'session') session = v; else msg = v; }
      return;
    }
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
  if (session !== null) return msg !== null ? { session, msg } : { session };
  return out;
}

function formatHash(state) {
  const parts = [];
  if (state && state.session) {
    parts.push('session=' + encodeURIComponent(state.session));
    if (state.msg) parts.push('msg=' + encodeURIComponent(state.msg));
    return '#' + parts.join('&');
  }
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
    if (!src) { src = { n: sources.length + 1, url: c.url, title: c.title, site: c.site || '' }; sources.push(src); }
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

// The Markdown parser both viewer pages use (marked is the library, passed in). Raw HTML displays as the text it is,
// as on claude.ai. marked would stop escaping the text after a tag like <code>, and stop linking after <a>, so its
// state is reset after every tag. Its output still goes through sanitizeHtml.
function markdownParser(marked) {
  return new marked.Marked({
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
}

// A citation as claude.ai shows it: a small pill with the site's name ("SoundGuys"), the number when there is none.
function citeNode(doc, source) {
  const sup = doc.createElement('sup');
  sup.className = 'cite';
  const link = doc.createElement('a');
  link.textContent = source.site || String(source.n);
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
// This is the backstop: raw HTML in a chat already arrives escaped, as markdownParser sets marked up.
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
const NO_IMAGE_ONE = new RegExp(NO_IMAGE_SPAN, 'g');

function noImageHtml(count) {
  return '<span class="no-image">' + (count > 1 ? count + ' images not available offline' : NO_IMAGE) + '</span>';
}

// Images side by side, or in paragraphs of their own, make one line.
function collapseNoImage(html) {
  return html.replace(NO_IMAGE_RUN, run => {
    let count = 0;
    run.replace(NO_IMAGE_ONE, (span, n) => { count += +n || 1; return span; });
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
function rewriteTags(html, visit, extra) {
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
    const swap = tag === 'script' || tag === 'link' || (extra && extra.has(tag)) ? visit(tag, read.attrs) : null;
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
    srcdoc: `<!doctype html><meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">${inlineSiblings(rest, lookup)}${SIZE_SCRIPT}`,
    remote: remoteScripts(rest),
  };
}

// ---- Artifacts ----
// An artifact's pages come with a part payload { texts: [[path, text]], images: [[path, dataUri]] }, keyed by the file's
// original path. Maps are built from those arrays and read with string paths only, so a path like __proto__ is plain data.

// The original path a relative URL in the start file points to, or null. Rejects a scheme, a leading /, //, ?, #,
// any .. past the artifact root and a decoded segment holding a slash. A backslash counts as a slash.
function resolveArtifactPath(startPath, url) {
  if (typeof startPath !== 'string' || typeof url !== 'string') return null;
  // C0 controls and spaces trimmed with index loops: a regex anchored at the end is quadratic on long inner runs.
  const clean = url.replace(/[\t\n\r]/g, '');
  let from = 0;
  let to = clean.length;
  while (from < to && clean.charCodeAt(from) <= 0x20) from++;
  while (to > from && clean.charCodeAt(to - 1) <= 0x20) to--;
  const raw = clean.slice(from, to).replace(/\\/g, '/');
  if (!raw || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw[0] === '/' || /[?#]/.test(raw)) return null;
  const stack = startPath.replace(/\\/g, '/').split('/').filter(Boolean);
  stack.pop();
  for (const part of raw.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (!stack.length) return null;
      stack.pop();
      continue;
    }
    const seg = safeDecode(part);
    if (seg === null || /[/\\]/.test(seg) || seg === '.' || seg === '..' || seg === '') return null;
    stack.push(seg);
  }
  return stack.length ? stack.join('/') : null;
}

const mapOf = pairs => new Map(Array.isArray(pairs) ? pairs.filter(p => Array.isArray(p) && typeof p[0] === 'string') : []);

// An attribute value as the browser reads it: character references decoded (named &amp; &quot; &apos; &lt; &gt;,
// decimal and hex), so src="R&amp;D.js" names R&D.js. Any other named reference stays as written.
const NAMED_REFS = { amp: '&', AMP: '&', quot: '"', QUOT: '"', apos: "'", lt: '<', LT: '<', gt: '>', GT: '>' };
function decodeAttr(value) {
  return String(value).replace(/&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([A-Za-z]+));?/g, (m, dec, hex, name) => {
    if (name !== undefined) return Object.prototype.hasOwnProperty.call(NAMED_REFS, name) ? NAMED_REFS[name] : m;
    const code = dec !== undefined ? Number(dec) : parseInt(hex, 16);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '\uFFFD';
  });
}

// Like inlineSiblings, resolving through resolveArtifactPath against payload.texts (scripts and stylesheets) and
// payload.images (img src, with the first srcset candidate when src is not saved). CSS keeps its own url() and @import
// unresolved, and module imports are not inlined.
function inlineArtifact(html, startPath, payload) {
  const texts = mapOf(payload && payload.texts);
  const images = mapOf(payload && payload.images);
  const text = (attr, type) => {
    const path = attr ? resolveArtifactPath(startPath, decodeAttr(attr.value)) : null;
    return path !== null && type.test(path) && texts.has(path) ? texts.get(path) : null;
  };
  const image = value => {
    const path = resolveArtifactPath(startPath, decodeAttr(value));
    const uri = path !== null && images.has(path) ? images.get(path) : null;
    return typeof uri === 'string' && /^data:image\//i.test(uri) && !/["'<>\s]/.test(uri) ? uri : null;
  };
  const late = [];
  const kept = attrs => attrs.map(a => ' ' + a.raw.replace(/^[\s/]+/, '')).join('');
  const out = rewriteTags(String(html), (tag, attrs) => {
    if (tag === 'img') {
      const src = attrOf(attrs, 'src');
      const set = attrOf(attrs, 'srcset');
      let uri = src ? image(src.value) : null;
      if (uri === null && set) {
        const first = decodeAttr(set.value).split(',')[0].trim().split(/\s+/)[0];
        uri = first ? image(first) : null;
      }
      if (uri === null) return null;
      const rest = kept(attrs.filter(a => a.name !== 'src' && a.name !== 'srcset'));
      return `<img${rest} src="${uri}">`;
    }
    if (tag === 'script') {
      const src = attrOf(attrs, 'src');
      const code = text(src, /\.m?js$/i);
      if (code == null) return null;
      const rest = kept(attrs.filter(a => a.name !== 'src'));
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
  }, new Set(['img']));
  return out + late.join('');
}

// Storage is blocked in a sandbox without allow-same-origin, and a page that touches it would throw; this gives it memory.
const STORAGE_SHIM = `<script>(function(){function mem(){var d=Object.create(null);return{getItem:function(k){k=String(k);return k in d?d[k]:null},setItem:function(k,v){d[String(k)]=String(v)},removeItem:function(k){delete d[String(k)]},clear:function(){d=Object.create(null)},key:function(i){var k=Object.keys(d);i=Number(i);return Number.isInteger(i)&&i>=0&&i<k.length?k[i]:null},get length(){return Object.keys(d).length}}}['localStorage','sessionStorage'].forEach(function(n){var ok=true;try{window[n].getItem('x')}catch(e){ok=false}if(!ok){try{Object.defineProperty(window,n,{value:mem(),configurable:true})}catch(e){}}})})()</script>`;

// WebRTC sends packets that Chrome's CSP doesn't stop. (Chrome doesn't know the webrtc directive and logs a console error
// for it, so PREVIEW_CSP leaves it out.) So the page's own window loses these names, for good. A frame the page makes
// has a fresh window with them back: a known gap (USAGE.md, "What to know about previews").
const RTC_SHIM = `<script>(function(){['RTCPeerConnection','webkitRTCPeerConnection','RTCDataChannel','RTCSessionDescription','RTCIceCandidate'].forEach(function(n){try{Object.defineProperty(window,n,{get:function(){return undefined},set:function(){},configurable:false,enumerable:false})}catch(e){try{delete window[n]}catch(e){}}})})()</script>`;

// The sandboxed document for an artifact's start file: policy first, then the storage and WebRTC shims, then the page.
function artifactPreviewDoc(text, startPath, payload) {
  const rest = String(text).replace(/^﻿?\s*<!doctype[^>]*>/i, '');
  return {
    srcdoc: `<!doctype html><meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">${STORAGE_SHIM}${RTC_SHIM}${inlineArtifact(rest, startPath, payload)}${SIZE_SCRIPT}`,
    remote: remoteScripts(rest),
  };
}

// tab: 'all' | 'yours' | 'shared'. Listed artifacts only (an artifact not in claude.ai's list has listed: false).
// Newest update first, an unparsable date last, ties by title.
function artifactTabs(views, tab, query) {
  const q = String(query || '').trim().toLowerCase();
  const time = v => { const t = Date.parse(v.updatedAt); return Number.isNaN(t) ? null : t; };
  return (views || [])
    .filter(v => v.listed !== false)
    .filter(v => (tab === 'yours' ? !v.shared : tab === 'shared' ? !!v.shared : true))
    .filter(v => !q || String(v.title || '').toLowerCase().includes(q))
    .sort((a, b) => {
      const x = time(a), y = time(b);
      if (x !== y) return x === null ? 1 : y === null ? -1 : y - x;
      return String(a.title || '').localeCompare(String(b.title || ''));
    });
}

// now: a Date or milliseconds.
function relativeTime(iso, now) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const secs = (+now - t) / 1000;
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  if (secs < 7 * 86400) return `${Math.floor(secs / 86400)}d ago`;
  return new Date(t).toISOString().slice(0, 10);
}

function parseArtifactHash(hash) {
  const m = /^#a=([A-Za-z0-9_-]{1,64})$/.exec(String(hash || ''));
  return m ? m[1] : null;
}

// ---- In chats: the files Claude made in the export's chats, the Artifacts screen's In chats tab ----

// A chat's file texts by name: the newest text of the last file with that name (the siblings a page can inline).
function chatFileTexts(chat) {
  const texts = new Map();
  for (const file of Object.values((chat && chat.files) || {})) {
    if (!file || typeof file.name !== 'string') continue;
    const text = (Array.isArray(file.versions) ? file.versions : []).map(v => v && v.text).filter(t => typeof t === 'string').pop();
    if (text != null) texts.set(file.name, text);
  }
  return texts;
}

// A version the same as a chat's files (e.same, e.files with savedAs the chat's own file, root-relative): each file's
// text from the chat version saved at that place (its href), keyed by the published path, so a page runs with the
// siblings it was published with, in their folders, not the chat's newest ones. [[path, text]]; [] for anything else.
function versionCopyTexts(chat, e) {
  if (!chat || !e || e.same !== true || !Array.isArray(e.files)) return [];
  const decode = t => { try { return decodeURIComponent(t); } catch (err) { return t; } };
  const byPlace = new Map();
  for (const file of Object.values(chat.files || {})) {
    for (const v of (file && Array.isArray(file.versions) ? file.versions : [])) {
      if (v && typeof v.text === 'string' && typeof v.href === 'string' && v.href) byPlace.set(decode(v.href), v.text);
    }
  }
  const out = [];
  for (const f of e.files) {
    if (!f || typeof f.path !== 'string' || typeof f.savedAs !== 'string' || !byPlace.has(f.savedAs)) continue;
    out.push([f.path, byPlace.get(f.savedAs)]);
  }
  return out;
}

const CODE_EXTENSIONS = new Set(('js mjs cjs ts jsx tsx py rb go rs java kt swift c h cc cpp hpp cs php sh bash zsh ps1 sql r lua pl ' +
  'scala dart css scss less json yaml yml toml xml ini').split(' '));

// The In chats filter a file falls under. key: the export's file key when known ('doc:<node id>', 'widget:<title>',
// either maybe off the branch as 'x:<message>:...'); in the viewer data a widget is marked by file.widget instead.
function fileKindGroup(name, kind, key = '') {
  const k = String(key || '');
  if (/^(x:[^:]*:)?widget:/.test(k)) return 'diagram';
  if (/^(x:[^:]*:)?doc:/.test(k)) return 'doc';
  const ext = ((/\.([a-z0-9]+)$/i.exec(String(name || '')) || [])[1] || '').toLowerCase();
  if (ext === 'html' || ext === 'htm') return 'page';
  if (ext === 'md') return 'doc';
  if (ext === 'svg') return 'diagram';
  if (kind === 'code' || CODE_EXTENSIONS.has(ext)) return 'code';
  return 'other';
}

// Both lists at once: the In chats entries, and the artifacts whose page a chat's file is, as that file now is.
// A published page's version that is the same as the file Claude wrote links that file (same: true, the file's href);
// when the page is one of the export's artifacts and that version is the artifact's current one (ver), the file whose
// last version that is isn't listed (the artifact's card says "also in chat"); a file matching any other same publish
// of that page is listed and names it in alsoArtifact.
// Order: newest first by the message that made the file's last version (its time; a message with no usable time
// stands in with its chat's update), then the chat's update, the message's place in the chat, the chat's place in
// the data and the name. Files with no madeAt come after, by the chat's place in the data, then name.
function inChatsSplit(data) {
  const chats = data && Array.isArray(data.chats) ? data.chats : [];
  // Each exported artifact's current version ('' when unknown, which no publish matches).
  const currentVer = new Map((data && Array.isArray(data.artifacts) ? data.artifacts : []).filter(v => v && typeof v.id === 'string')
    .map(v => [v.id, typeof v.ver === 'string' ? v.ver : '']));
  const time = iso => { const t = Date.parse(iso); return Number.isNaN(t) ? null : t; };
  const files = [];
  const also = new Set();
  chats.forEach((chat, ci) => {
    if (!chat || !chat.files || typeof chat.files !== 'object') return;
    const entries = Object.entries(chat.files).filter(([, f]) => f && typeof f === 'object' && Array.isArray(f.versions) && f.versions.length);
    const pageOfHref = new Map(); // href of a file Claude wrote -> the artifact published the same as it
    const currentOfHref = new Map(); // the same, for a publish that is the artifact's current version
    for (const [, f] of entries) {
      if (!f.published || !currentVer.has(f.artifact)) continue;
      for (const v of f.versions) {
        if (!v || !v.same || typeof v.href !== 'string') continue;
        pageOfHref.set(v.href, f.artifact);
        if (typeof v.ver === 'string' && v.ver && v.ver === currentVer.get(f.artifact)) currentOfHref.set(v.href, f.artifact);
      }
    }
    const messages = Array.isArray(chat.messages) ? chat.messages : [];
    const place = new Map(messages.map((m, i) => [m && m.id, i]));
    const chatTime = time(chat.updated);
    for (const [id, f] of entries) {
      if (f.published || f.kind === 'missing') continue;
      const last = f.versions[f.versions.length - 1];
      if (last && currentOfHref.has(last.href)) { also.add(currentOfHref.get(last.href)); continue; }
      const earlier = f.versions.find(v => v && pageOfHref.has(v.href));
      const madeAt = typeof f.madeAt === 'string' && f.madeAt ? f.madeAt : null;
      const at = madeAt && place.has(madeAt) ? messages[place.get(madeAt)].at : null;
      const name = String(f.name || 'Untitled');
      files.push({
        chat: ci, file: id, name, kind: fileKindGroup(name, f.kind, f.widget ? 'widget:' : ''), madeAt, versions: f.versions,
        alsoArtifact: earlier ? pageOfHref.get(earlier.href) : null,
        at: typeof at === 'string' ? at : null,
        sort: { time: madeAt ? (time(at) ?? chatTime) : null, chatTime, place: madeAt && place.has(madeAt) ? place.get(madeAt) : -1 },
      });
    }
  });
  const desc = (x, y) => (x === y ? 0 : x === null ? 1 : y === null ? -1 : y - x);
  files.sort((a, b) => {
    if (!!a.madeAt !== !!b.madeAt) return a.madeAt ? -1 : 1;
    if (a.madeAt) {
      const c = desc(a.sort.time, b.sort.time) || desc(a.sort.chatTime, b.sort.chatTime) || (a.chat === b.chat ? b.sort.place - a.sort.place : 0);
      if (c) return c;
    }
    return a.chat - b.chat || byName(a.name, b.name);
  });
  for (const f of files) delete f.sort;
  return { files, also };
}

// [{ chat (index in data.chats), file (its id), name, kind ('page'|'doc'|'diagram'|'code'|'other'), madeAt, versions,
//    alsoArtifact (an artifact id, or null), at (the madeAt message's time, or null) }], in the In chats order.
function inChatsFiles(data) { return inChatsSplit(data).files; }

// The ids of the artifacts whose page is, as it now is, a file a chat made: their card says "also in chat".
function alsoInChat(data) { return inChatsSplit(data).also; }

// ---- Chats and artifacts: what the Artifacts screen says about each artifact's chats ----

// An All-tab card's source line: the chats linked to it, else shared with you, else where claude.ai says it was made.
function artifactSourceLine(view) {
  const chats = new Set((view && Array.isArray(view.links) ? view.links : []).filter(l => l && Number.isInteger(l.chat)).map(l => l.chat));
  if (chats.size) return `💬 ${chats.size} chat${chats.size === 1 ? '' : 's'}`;
  if (view && view.shared) return 'Shared with you';
  const surface = view && typeof view.sourceSurface === 'string' ? view.sourceSurface.toLowerCase() : '';
  return surface === 'cowork' ? 'Cowork' : surface === 'code' ? 'Code' : '';
}

// An artifact page's line: its links grouped Made in, Published in, Edited in, each chat once (at its first message),
// chats not in chats left out.
const LINK_GROUPS = [['made', 'Made in'], ['published', 'Published in'], ['edited', 'Edited in']];
function artifactLinkGroups(view, chats) {
  const links = view && Array.isArray(view.links) ? view.links : [];
  const list = Array.isArray(chats) ? chats : [];
  const groups = [];
  for (const [how, label] of LINK_GROUPS) {
    const seen = new Set();
    const out = [];
    for (const l of links) {
      if (!l || l.how !== how || !Number.isInteger(l.chat) || l.chat < 0 || !list[l.chat] || seen.has(l.chat)) continue;
      seen.add(l.chat);
      out.push({ chat: l.chat, messageUuid: typeof l.messageUuid === 'string' ? l.messageUuid : undefined });
    }
    if (out.length) groups.push({ how, label, chats: out });
  }
  return groups;
}

// The chat viewer's Artifacts entry: shown when the data has the Artifacts screen (an Export All's) and the export has
// an artifact folder (storeCount, listed or not; a listed artifact not saved has a view only), or a file Claude made
// in a chat (In chats). count: the listed artifacts, else the In chats files, else the artifact folders. A page not in
// claude.ai's list is on no tab: its chat's card opens it.
function artifactsEntry(data) {
  if (!data || !Array.isArray(data.artifacts)) return { show: false, count: 0 };
  const listed = data.artifacts.filter(v => v && typeof v === 'object' && v.listed !== false).length;
  const folders = Number.isSafeInteger(data.storeCount) && data.storeCount > 0 ? data.storeCount : 0;
  const count = listed || inChatsFiles(data).length || folders;
  return { show: count > 0, count };
}

// What a file's flag means, for its badge and the note on its page (the chat viewer's and the Artifacts screen's).
const FLAG_NOTES = {
  script: "Claude changed this file with a command the export can't replay, so it may not match what Claude made. replay_bash.py beside the extension can rebuild it from the chat folder.",
  edit: "An edit Claude made to this file couldn't be replayed, so it may not match what Claude made.",
  draft: "Draft: not the file Claude delivered. A command the export can't follow changed it, and the files Claude delivered afterwards are in the export.",
  helper: "Helper script Claude ran. A command the export can't follow changed it, so this copy may be older than the one Claude ran.",
  doc: 'Some edits to this document couldn\'t be rebuilt from the chat. The live document on claude.ai is the current one.',
};
const flagNote = file => (file && file.flag ? FLAG_NOTES[file.flag] || FLAG_NOTES.edit : '');

// #ac=<chat index>.<file id>: an In chats file.
const IN_CHATS_HASH = /^#ac=(\d{1,6})\.([A-Za-z0-9_:-]{1,128})$/;
function parseInChatsHash(hash) {
  const m = IN_CHATS_HASH.exec(typeof hash === 'string' ? hash : '');
  return m ? { chat: Number(m[1]), file: m[2] } : null;
}
function formatInChatsHash(chat, file) {
  if (!Number.isInteger(chat) || chat < 0) return null;
  const hash = `#ac=${chat}.${file}`;
  return parseInChatsHash(hash) ? hash : null;
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
  if (file.published) return file.kind === 'missing' ? 'Published page · Not in this export' : 'Published page';
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

// The searchable text of a message: its text blocks, pasted text and its name, and upload names.
function messageSearchText(m) {
  const parts = [];
  for (const b of m.blocks || []) if (b && b.t === 'text' && b.text) parts.push(b.text);
  for (const a of m.attachments || []) { if (a.name) parts.push(a.name); if (a.text) parts.push(a.text); }
  for (const u of m.uploads || []) if (u.name) parts.push(u.name);
  return parts.join('\n');
}

// Search over every message on every branch, plus titles. One entry per message (and per title, msg null):
// { chat, msg, lower } plus the title or the message (src), whose text is rebuilt for a snippet, so a big archive
// holds only the lowercase copy.
function buildSearchIndex(chats, sessions = []) {
  const index = [];
  for (const chat of chats) {
    const title = chat.title || '';
    index.push({ chat: chat.id, msg: null, title, lower: title.toLowerCase() });
    for (const m of chat.messages || []) {
      const text = messageSearchText(m);
      if (!text) continue;
      index.push({ chat: chat.id, msg: m.id, src: m, lower: text.toLowerCase() });
    }
  }
  for (const session of sessions || []) {
    const chat = session.chat || {};
    const title = session.title || chat.title || '';
    index.push({ chat: null, session: session.id, msg: null, title, lower: title.toLowerCase() });
    for (const m of chat.messages || []) {
      const text = messageSearchText(m);
      if (!text) continue;
      index.push({ chat: null, session: session.id, msg: m.id, src: m, lower: text.toLowerCase() });
    }
  }
  return index;
}
const entryText = e => (e.msg === null ? e.title : messageSearchText(e.src));

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
// query's words found in that entry, for highlighting; the snippet is cut around the first of them, only when
// read (a getter): the sidebar shows few of a common word's hits.
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
    let snippet;
    hits.push({
      chat: e.chat, ...(e.session ? { session: e.session } : {}), msg: e.msg, terms,
      get snippet() { if (snippet === undefined) snippet = snippetAt(entryText(e), e.lower, at, len); return snippet; },
    });
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
    const key = h.session || h.chat;
    if (!groups.has(key)) {
      const created = { chat: h.chat, title: false, count: 0, snippets: [], order: i, terms: [] };
      if (h.session) { created.session = true; created.id = h.session; }
      groups.set(key, created);
    }
    const g = groups.get(key);
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

// ---- Lists: the sidebar's recent chats, the Projects page and the All chats page ----

const RECENT_LIMIT = 30;
const LIST_PAGE = 200;

const hasDate = c => typeof c.updated === 'string' && !Number.isNaN(Date.parse(c.updated));

// The n newest chats by `updated`; chats without a parseable date come last, ties keep their order. Doesn't mutate.
// Each date is parsed once (not in the comparator): thousands of chats sort quickly.
function recentChats(chats, n) {
  const dated = [], undated = [];
  for (const c of chats) {
    const t = typeof c.updated === 'string' ? Date.parse(c.updated) : NaN;
    if (Number.isNaN(t)) undated.push(c);
    else dated.push({ c, t });
  }
  dated.sort((a, b) => b.t - a.t);
  return dated.map(d => d.c).concat(undated).slice(0, n);
}

// Projects that have chats: { key, name, description, updated, chats }. key is the project's id, else 'i' + its index in
// `projects`. Chats are newest first; updated is the newest of the project's and its chats'; the list is newest first,
// no date last. A second project of one name is "Name (2)" (by order in the list).
function projectList(chats, projects) {
  const byProject = new Map();
  for (const chat of chats) {
    if (!chat.project) continue;
    if (!byProject.has(chat.project)) byProject.set(chat.project, []);
    byProject.get(chat.project).push(chat);
  }
  const time = iso => (iso ? Date.parse(iso) : -Infinity);
  const out = [];
  let extra = projects.length; // a project not in the list (an older viewer's inline copy) gets a key past its end
  for (const [project, list] of byProject) {
    const sorted = recentChats(list, list.length);
    let updated = hasDate(project) ? project.updated : '';
    for (const c of sorted) if (hasDate(c) && time(c.updated) > time(updated)) updated = c.updated;
    const at = projects.indexOf(project);
    const order = at === -1 ? extra++ : at;
    out.push({ key: project.id || 'i' + order, order, name: project.name || 'Untitled project',
      description: typeof project.description === 'string' ? project.description : '', updated, chats: sorted });
  }
  // An index key a real id already has (an odd project.json with id "i0") goes to "i<n>~", so every key opens its page.
  const taken = new Set(out.filter(p => p.key !== 'i' + p.order).map(p => p.key));
  for (const p of out) {
    if (p.key !== 'i' + p.order) continue;
    while (taken.has(p.key)) p.key += '~';
    taken.add(p.key);
  }
  // "Name (2)" in the projects' order, so a project keeps its label when another gets a newer chat.
  const named = new Map();
  for (const p of [...out].sort((a, b) => a.order - b.order)) {
    const n = (named.get(p.name) || 0) + 1;
    named.set(p.name, n);
    if (n > 1) p.name = `${p.name} (${n})`;
  }
  out.sort((a, b) => (a.updated === '') - (b.updated === '') || time(b.updated) - time(a.updated));
  for (const p of out) delete p.order;
  return out;
}

// The items where every word of query is in at least one of fields(item), case folded. An empty query keeps all.
// cache (optional, a WeakMap a page keeps): each item's folded fields, so typing doesn't fold every item again.
function filterByText(items, query, fields, cache = null) {
  const words = String(query).trim().split(/\s+/).filter(Boolean).map(w => foldCase(w).lower);
  if (!words.length) return items.slice();
  const folded = item => {
    let texts = cache ? cache.get(item) : undefined;
    if (!texts) {
      texts = fields(item).map(t => foldCase(t == null ? '' : t).lower);
      if (cache) cache.set(item, texts);
    }
    return texts;
  };
  return items.filter(item => {
    const texts = folded(item);
    return words.every(w => texts.some(t => t.includes(w)));
  });
}

// #projects, #chats or #project=<key>, whole hashes only; anything else is null.
function parseListHash(hash) {
  if (hash === '#projects') return { page: 'projects' };
  if (hash === '#chats') return { page: 'chats' };
  if (hash === '#sessions') return { page: 'sessions' };
  const m = /^#project=(.+)$/.exec(hash);
  if (!m) return null;
  try { return { page: 'project', key: decodeURIComponent(m[1]) }; } catch (e) { return null; }
}

// ---- Download: a file the viewer holds, saved through a blob: link (Chrome ignores download on a file: link and
// opens the file instead, so the viewer never links a file on disk for this) ----

// The name a download is saved under: the last path segment, with \ / : * ? " < > | and control characters made _,
// no leading or trailing dots or spaces, at most 200 characters with the extension kept; nothing left: download.
function downloadName(name) {
  const last = String(name == null ? '' : name).split(/[\\/]/).pop();
  let clean = last.replace(/[\u0000-\u001f\u007f:*?"<>|]/g, '_').replace(/^[.\s]+|[.\s]+$/g, '');
  if (clean.length > 200) {
    const ext = (/\.[^.]{1,16}$/.exec(clean) || [''])[0];
    clean = clean.slice(0, 200 - ext.length).replace(/[.\s]+$/, '') + ext;
  }
  return clean || 'download';
}

// The bytes of a data:<type>;base64,<data> URL (the Artifacts screen's preview images), or null.
function dataUrlBytes(url) {
  const m = /^data:[^,;]*;base64,([A-Za-z0-9+/]*={0,2})$/.exec(typeof url === 'string' ? url : '');
  if (!m) return null;
  try {
    const bin = atob(m[1]);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch (e) {
    return null;
  }
}

// Saves text (as UTF-8) or bytes under downloadName(name). The Blob is application/octet-stream, so the browser
// never shows or runs it on the way out.
function saveBytes(name, data) {
  if (typeof data !== 'string' && !(data instanceof Uint8Array)) return false;
  const url = URL.createObjectURL(new Blob([data], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = downloadName(name);
  a.hidden = true;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

// ---- A Design artifact's canvas (v1.20): its boards and notes from project/canvas.json, drawn without claude.ai ----

const DESIGN_BOARD_MAX = 60;
// Notes drawn at most (text boxes, cheap, but a canvas.json could hold any number).
const DESIGN_NOTE_MAX = 2000;
// Places and sizes past these are skipped: one far-off board or note would shrink everything else to nothing.
const DESIGN_COORD_MAX = 1e5;
const DESIGN_SIZE_MAX = 2e4;
const inPlace = v => v !== null && Math.abs(v) <= DESIGN_COORD_MAX;
const inSize = v => v !== null && v > 0 && v <= DESIGN_SIZE_MAX;

// The canvas's scale to fit avail pixels: at most 1 (never enlarged), at least 0.1 (the opening view of a wider canvas; it moves in its window, never scrolls).
function canvasScale(width, avail) {
  if (!(Number.isFinite(width) && width > 0 && Number.isFinite(avail) && avail > 0)) return 1;
  return Math.min(1, Math.max(0.1, avail / width));
}
// The Design canvas's window (v1.23.2): the canvas zooms from 10% to 200% and moves freely, off the window's edges.
const CANVAS_ZOOM_MIN = 0.1;
const CANVAS_ZOOM_MAX = 2;
// The zoom that shows the whole layout (w × h) in a window viewW × viewH with pad around it, never above 100%.
function canvasFit(w, h, viewW, viewH, pad = 40) {
  const ok = n => Number.isFinite(n) && n > 0;
  if (![w, h, viewW, viewH].every(ok)) return 1;
  const z = Math.min((viewW - 2 * pad) / w, (viewH - 2 * pad) / h);
  return Math.min(1, Math.max(CANVAS_ZOOM_MIN, Math.round(z * 1e6) / 1e6));
}
// The canvas's top left in the window (pan), moved only as far as keeps keep px of it (or all of a smaller one) inside.
function clampPan(pan, w, h, scale, viewW, viewH, keep = 80) {
  const axis = (p, size, view) => {
    const n = Number.isFinite(p) ? p : 0;
    const s = size * scale;
    if (!(Number.isFinite(s) && s > 0 && Number.isFinite(view) && view > 0)) return n;
    const k = Math.min(keep, s, view);
    return Math.min(view - k, Math.max(k - s, n));
  };
  return { x: axis(pan.x, w, viewW), y: axis(pan.y, h, viewH) };
}
// The pan that keeps the canvas point under point (in the window) in place from zoom from to zoom to.
function panAbout(pan, point, from, to) {
  if (from === to) return { x: pan.x, y: pan.y };
  return { x: point.x - (point.x - pan.x) * to / from, y: point.y - (point.y - pan.y) * to / from };
}
const NOTE_FILLS = new Set(['teal', 'orange', 'yellow', 'green', 'blue', 'pink', 'purple', 'red']);
const BOARD_NAME = /^[^/\\]+\.dc\.html$/;
const designOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const designObject = o => !!o && typeof o === 'object' && !Array.isArray(o);

// A note's fill as one of the palette's names, else grey.
function noteFill(fill) {
  return typeof fill === 'string' && NOTE_FILLS.has(fill) ? fill : 'grey';
}

// What a board's text needs that the viewer can't give: the type's templates ({{hole}}, <sc-…>, <dc-import>), or
// uploaded images (/_blob/<id>, not in the export).
function boardFlags(text) {
  const t = typeof text === 'string' ? text : '';
  return { templated: /\{\{|<sc-|<dc-import/i.test(t), blobs: t.includes('/_blob/') };
}

// The canvas from canvas.json's text: { width, height, title, boards: [{ name, path, x, y, w, h, title, held }],
// notes: [{ id, text, x, y, w, fill, heading }], skipped: [{ name, title }] }, shifted so the smallest x and y are 0;
// null when it isn't a canvas or no board's file is held (held(path) says). Boards: keys of boards naming a
// <name>.dc.html in project/, with finite x, y, w, h; at most DESIGN_BOARD_MAX drawn, the rest and the ones with bad
// numbers in skipped. Notes: in noteOrder, then the others, at most DESIGN_NOTE_MAX, each with finite x and y; a sticky
// note's width is w, else maxW, a heading's maxW, else w (one out of range falls back to the other; none given: 320). A note's
// height isn't known before it's drawn: the canvas leaves 200 below the lowest one.
function designCanvas(text, held) {
  let json;
  try { json = JSON.parse(text); } catch (e) { return null; }
  if (!designObject(json) || !designObject(json.boards)) return null;
  const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const str = v => (typeof v === 'string' ? v : '');
  const boards = [];
  const skipped = [];
  for (const name of Object.keys(json.boards)) {
    if (!BOARD_NAME.test(name) || name === '..') continue;
    const b = json.boards[name];
    const title = designObject(b) && str(b.title) ? b.title : name;
    const [x, y, w, h] = designObject(b) ? [num(b.x), num(b.y), num(b.w), num(b.h)] : [null, null, null, null];
    if (!inPlace(x) || !inPlace(y) || !inSize(w) || !inSize(h) || boards.length >= DESIGN_BOARD_MAX) { skipped.push({ name, title }); continue; }
    const path = `project/${name}`;
    boards.push({ name, path, x, y, w, h, title, held: !!held(path) });
  }
  if (!boards.some(b => b.held)) return null;
  const noteSrc = designObject(json.notes) ? json.notes : {};
  const ordered = Array.isArray(json.noteOrder) ? json.noteOrder.filter(id => typeof id === 'string' && designOwn(noteSrc, id)) : [];
  const ids = [...new Set([...ordered, ...Object.keys(noteSrc)])];
  const notes = [];
  for (const id of ids) {
    if (notes.length >= DESIGN_NOTE_MAX) break;
    const n = noteSrc[id];
    if (!designObject(n)) continue;
    const x = num(n.x);
    const y = num(n.y);
    if (!inPlace(x) || !inPlace(y)) continue;
    // A heading (title1) is as wide as its maxW (its w is the editor's measure of the text, and wraps it); a sticky
    // note is as wide as its w.
    const width = v => (num(v) !== null && v > 0 ? v : null);
    // The first that fits the canvas: a maxW out of range falls back to w, as w does to maxW. Widths given and none in
    // range: skipped; none given: 320.
    const given = (n.kind === 'title1' ? [n.maxW, n.w] : [n.w, n.maxW]).map(width).filter(c => c !== null);
    const w = given.length ? given.find(inSize) : 320;
    if (w === undefined) continue;
    notes.push({ id, text: str(n.text), x, y, w, fill: noteFill(n.fill), heading: n.kind === 'title1' });
  }
  // Loops, not Math.min(...list): a long list overflows the call stack.
  const all = [...boards, ...notes];
  let minX = Infinity;
  let minY = Infinity;
  for (const o of all) { if (o.x < minX) minX = o.x; if (o.y < minY) minY = o.y; }
  let width = 0;
  let height = 0;
  for (const o of all) {
    o.x -= minX;
    o.y -= minY;
    width = Math.max(width, o.x + o.w);
    height = Math.max(height, o.y + (o.h === undefined ? 200 : o.h));
  }
  return { width, height, title: str(json.title), boards, notes, skipped };
}

// ---- Zoom (v1.23) ----
const ZOOM_STEPS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.25, 1.5, 2, 3, 4, 6, 8];
const PICTURE_MAX_SIDE = 32768;

function clampZoom(z, min, max) {
  const n = Number.isFinite(z) ? z : 1;
  return Math.min(max, Math.max(min, n));
}

// The first step strictly beyond z in that direction, clamped; none beyond means the bound.
function stepZoom(z, dir, min, max) {
  const eps = 1e-6;
  let next = dir > 0 ? max : min;
  if (dir > 0) {
    for (const s of ZOOM_STEPS) if (s > z + eps) { next = s; break; }
  } else {
    for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) if (ZOOM_STEPS[i] < z - eps) { next = ZOOM_STEPS[i]; break; }
  }
  return clampZoom(next, min, max);
}

// deltaMode 0 pixels, 1 lines, 2 pages. A pinch arrives as a ctrl wheel and is faster.
function wheelFactor(deltaY, deltaMode, pinch) {
  const unit = deltaMode === 1 ? 16 : deltaMode === 2 ? 800 : 1;
  const d = Math.max(-200, Math.min(200, (Number(deltaY) || 0) * unit));
  return Math.exp(-d * (pinch ? 0.01 : 0.002));
}

// The scroll position that keeps the content point under `point` (viewport coordinates) in place when the zoom changes.
function zoomAbout({ from, to, point, scroll, offsetFrom = { x: 0, y: 0 }, offsetTo = { x: 0, y: 0 } }) {
  const cx = (scroll.left + point.x - offsetFrom.x) / from;
  const cy = (scroll.top + point.y - offsetFrom.y) / from;
  return {
    left: Math.max(0, cx * to + offsetTo.x - point.x),
    top: Math.max(0, cy * to + offsetTo.y - point.y),
  };
}

function fitZoom(natural, box) {
  const nums = [natural && natural.width, natural && natural.height, box && box.width, box && box.height];
  if (nums.some(n => !Number.isFinite(n) || n <= 0)) return 1;
  return Math.min(1, box.width / natural.width, box.height / natural.height);
}

function pictureRange(fit, natural) {
  const min = Math.min(fit, 0.1);
  const side = Math.max(natural.width, natural.height);
  return { min, max: Math.max(fit, Math.min(8, PICTURE_MAX_SIDE / side)) };
}

function doubleClickZoom(z, fit) {
  if (Math.abs(z - fit) < 1e-6) return 1 > fit + 1e-6 ? 1 : 2;
  return fit;
}

// The root <svg> tag's width and height when both are plain numbers or px, else its viewBox size, else null.
function svgNaturalSize(text) {
  const tag = /<svg\b[^>]*>/i.exec(String(text));
  if (!tag) return null;
  const attr = name => {
    const m = new RegExp('\\s' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\')', 'i').exec(tag[0]);
    return m ? (m[1] !== undefined ? m[1] : m[2]) : null;
  };
  const px = v => {
    const m = v === null ? null : /^\s*(\d+(?:\.\d+)?|\.\d+)\s*(?:px)?\s*$/i.exec(v);
    return m ? Number(m[1]) : null;
  };
  const w = px(attr('width'));
  const h = px(attr('height'));
  if (w > 0 && h > 0) return { width: w, height: h };
  const vb = attr('viewBox');
  if (vb !== null) {
    const n = vb.trim().split(/[\s,]+/).map(Number);
    if (n.length === 4 && n.every(Number.isFinite) && n[2] > 0 && n[3] > 0) return { width: n[2], height: n[3] };
  }
  return null;
}

// An SVG file shows as a picture when it runs nothing and its size is known (svgNaturalSize). With no viewBox and no
// fixed width and height, the browser draws it at its default 300x150 and crops it: then it stays a page.
function svgAsPicture(text) {
  return typeof text === 'string' && !svgHasScripts(text) && svgNaturalSize(text) !== null;
}

function svgHasScripts(text) {
  const t = String(text);
  return /<script\b/i.test(t) || /<[^>]*\son[a-z]+\s*=/i.test(t);
}

function svgDataUrl(text) {
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(String(text).replace(/^\uFEFF/, ''));
}

// A sandboxed preview reports its size by message; only a sane report counts.
function pageFit(report, containerWidth) {
  const ok = n => typeof n === 'number' && Number.isFinite(n) && n > 0;
  if (!report || report.type !== 'ct-size' || !ok(report.width) || !ok(report.view) || !ok(containerWidth)) return null;
  if (report.width <= report.view + 1) return { fit: 1, enabled: false };
  return { fit: clampZoom(containerWidth / report.width, 0.25, 1), enabled: true };
}

// Appended to every preview document. Inline scripts run under PREVIEW_CSP; the opaque origin needs target '*'.
// The load report can come before the frame's first real layout (it then reads 0 or the view's width), so a
// ResizeObserver on the root reports again once the page has been laid out.
const SIZE_SCRIPT = `<script>(function(){function r(){try{var d=document.documentElement;window.top.postMessage({type:'ct-size',width:d.scrollWidth,view:d.clientWidth},'*')}catch(e){}}window.addEventListener('load',r);window.addEventListener('resize',r);try{new ResizeObserver(function(){r()}).observe(document.documentElement)}catch(e){}})()</script>`;

// ---- Zoom: DOM controllers ----
// Page code only; never called at load. Works inside a shadow root: it touches only the elements it is
// given and their own document. The box keeps its tabindex and the frame after destroy, so a box that
// had focus keeps it.

// Zoom and pan for one picture. box becomes the scroll container; a div.zoom-frame takes its place and
// holds it and the bar (−, percentage, +, Fit), so the bar doesn't scroll. The frame and bar are reused
// when the same box gets a new controller (the gallery's next picture), so focus in them isn't lost.
// opts.plainWheel: a plain wheel zooms too (the gallery). opts.natural: the picture's size at 100%.
// opts.onError: called once when the picture fails to load, or loads with no width (controller.failed is set).
// Sizing waits until the box has a size: a detached or hidden box is fitted by the ResizeObserver once shown.
function pictureZoom(box, img, opts = {}) {
  const doc = box.ownerDocument;
  const make = (tag, cls, text) => { const n = doc.createElement(tag); if (cls) n.className = cls; if (text) n.textContent = text; return n; };
  let frame = box.parentElement && box.parentElement.classList.contains('zoom-frame') ? box.parentElement : null;
  if (!frame) {
    // Each place sizes its frame in CSS (.gallery-pop > .zoom-frame, #panel-body > .zoom-frame, ...).
    frame = make('div', 'zoom-frame');
    if (box.parentNode) box.replaceWith(frame);
    frame.append(box);
  }
  let bar = frame.querySelector(':scope > .zoom-bar');
  if (!bar) {
    bar = make('div', 'zoom-bar');
    const button = (cls, text, label) => { const b = make('button', cls, text); b.type = 'button'; b.setAttribute('aria-label', label); return b; };
    const out = make('output', 'zoom-level');
    out.setAttribute('aria-live', 'polite');
    bar.append(button('zoom-out', '−', 'Zoom out'), out, button('zoom-in', '+', 'Zoom in'), button('zoom-fit', 'Fit', 'Fit'));
    frame.append(bar);
  }
  bar.hidden = false;
  const levelOut = bar.querySelector('.zoom-level');
  if (!box.hasAttribute('tabindex')) box.tabIndex = 0;
  box.classList.add('zoom-box');
  box.classList.toggle('zoom-all', !!opts.plainWheel);
  img.draggable = false;

  const off = new AbortController();
  const on = (target, type, fn, o = {}) => target.addEventListener(type, fn, { ...o, signal: off.signal });
  let natural = null; // { width, height } at 100%
  let zoom = 1;
  let atFit = true;
  let pending = null; // a state to restore once the picture is ready
  let loaded = false; // the picture has loaded, or opts.natural made waiting unnecessary
  const controller = { frame, dragged: false, failed: false };

  const avail = () => {
    const cs = getComputedStyle(box);
    return {
      width: box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
      height: box.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom),
    };
  };
  const hasSize = () => { const a = avail(); return Number.isFinite(a.width) && Number.isFinite(a.height) && a.width > 0 && a.height > 0; };
  const fitNow = () => fitZoom(natural, avail());
  const range = () => pictureRange(fitNow(), natural);
  // The picture's top left in the scroll content, and a viewport point in the box's client area.
  const offset = () => {
    const r = box.getBoundingClientRect(), i = img.getBoundingClientRect();
    return { x: i.left - r.left - box.clientLeft + box.scrollLeft, y: i.top - r.top - box.clientTop + box.scrollTop };
  };
  const pointIn = (x, y) => { const r = box.getBoundingClientRect(); return { x: x - r.left - box.clientLeft, y: y - r.top - box.clientTop }; };
  const centre = () => ({ x: box.clientWidth / 2, y: box.clientHeight / 2 });
  const canPan = () => box.scrollWidth > box.clientWidth + 1 || box.scrollHeight > box.clientHeight + 1;

  function apply(z, point, fitting = false) {
    if (!natural) return;
    const { min, max } = range();
    const to = fitting ? fitNow() : clampZoom(z, min, max);
    const from = zoom;
    const p = point || centre();
    const before = offset();
    const scroll = { left: box.scrollLeft, top: box.scrollTop };
    zoom = to;
    atFit = fitting;
    img.style.width = `${natural.width * to}px`;
    img.style.height = `${natural.height * to}px`;
    const next = zoomAbout({ from, to, point: p, scroll, offsetFrom: before, offsetTo: offset() });
    box.scrollLeft = next.left;
    box.scrollTop = next.top;
    levelOut.textContent = `${Math.round(to * 100)}%`;
    box.classList.toggle('can-drag', canPan());
  }
  const setFit = () => apply(0, null, true);
  const setZoom = (z, point) => apply(z, point);

  // Natural size and Fit, once the picture is known and the box has a size; the ResizeObserver calls it again.
  function ready() {
    if (natural || !loaded || controller.failed || !hasSize()) return;
    const n = opts.natural;
    if (n && n.width > 0 && n.height > 0) natural = { width: n.width, height: n.height };
    else if (img.naturalWidth > 0 && img.naturalHeight > 0) natural = { width: img.naturalWidth, height: img.naturalHeight };
    else { const a = avail(); natural = { width: a.width, height: a.height }; }
    zoom = fitNow();
    setFit();
    if (pending) { const s = pending; pending = null; controller.restore(s); }
  }
  function fail() {
    if (controller.failed) return;
    controller.failed = true;
    bar.hidden = true;
    // Later, so the callback never runs before the controller is complete (destroy is assigned last).
    if (typeof opts.onError === 'function') queueMicrotask(() => opts.onError(controller));
  }
  // An <img> with no src is complete too; only one with a src that has no width has failed.
  const failedAlready = () => img.complete && !!img.getAttribute('src') && !img.naturalWidth;
  const onLoad = () => { if (!img.naturalWidth) { fail(); return; } loaded = true; ready(); };
  if (img.complete && img.naturalWidth) loaded = true;
  else if (failedAlready()) fail();
  else {
    if (opts.natural) loaded = true;
    on(img, 'load', onLoad);
    on(img, 'error', fail);
  }
  ready();

  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
    if (!natural) { ready(); return; }
    if (!hasSize()) return;
    if (atFit) setFit();
    else { const { min, max } = range(); if (zoom < min || zoom > max) setZoom(zoom); else box.classList.toggle('can-drag', canPan()); }
  }) : null;
  if (ro) ro.observe(box);

  const current = () => (atFit ? fitNow() : zoom);
  const step = dir => { const { min, max } = range(); setZoom(stepZoom(current(), dir, min, max)); };
  controller.key = e => {
    if (!natural || e.ctrlKey || e.metaKey || e.altKey) return false;
    if (e.key === '+' || e.key === '=') step(1);
    else if (e.key === '-') step(-1);
    else if (e.key === '0') setFit();
    else if (e.key === '1') setZoom(1);
    else return false;
    e.preventDefault();
    return true;
  };
  on(frame, 'keydown', e => { if (controller.key(e)) e.stopPropagation(); });
  on(bar.querySelector('.zoom-out'), 'click', () => step(-1));
  on(bar.querySelector('.zoom-in'), 'click', () => step(1));
  on(bar.querySelector('.zoom-fit'), 'click', () => setFit());

  on(box, 'wheel', e => {
    if (!natural || !(e.ctrlKey || e.metaKey || opts.plainWheel)) return;
    e.preventDefault();
    setZoom(current() * wheelFactor(e.deltaY, e.deltaMode, e.ctrlKey), pointIn(e.clientX, e.clientY));
  }, { passive: false });
  on(box, 'dblclick', e => {
    if (!natural) return;
    const z = doubleClickZoom(current(), fitNow());
    if (Math.abs(z - fitNow()) < 1e-6 && !atFit) setFit();
    else setZoom(z, pointIn(e.clientX, e.clientY));
  });
  on(box, 'dragstart', e => e.preventDefault());

  // Pointers: one drags (past 4 px), two touch pointers pinch about their midpoint.
  const pointers = new Map();
  let drag = null, pinch = null;
  const endDrag = () => { drag = null; box.classList.remove('dragging'); };
  const spread = () => { const [a, b] = [...pointers.values()]; return { d: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; };
  on(box, 'pointerdown', e => {
    controller.dragged = false;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2 && e.pointerType === 'touch' && natural) {
      endDrag();
      const s = spread();
      pinch = { d: s.d || 1, zoom: current() };
      return;
    }
    if (pointers.size === 1) drag = { id: e.pointerId, x: e.clientX, y: e.clientY, left: box.scrollLeft, top: box.scrollTop, moving: false };
  });
  on(box, 'pointermove', e => {
    if (!pointers.has(e.pointerId)) return;
    // A mouse released outside the box sent it no pointerup (capture starts only past 4 px): no button, no drag.
    if (e.pointerType === 'mouse' && e.buttons === 0) { lift(e); return; }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pointers.size === 2) {
      const s = spread();
      controller.dragged = true;
      setZoom(pinch.zoom * (s.d / pinch.d), pointIn(s.x, s.y));
      return;
    }
    if (!drag || drag.id !== e.pointerId) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moving) {
      if (Math.hypot(dx, dy) <= 4) return;
      drag.moving = true;
      controller.dragged = true;
      try { box.setPointerCapture(e.pointerId); } catch (err) { /* a pointer the browser doesn't know */ }
      if (canPan()) box.classList.add('dragging');
    }
    if (box.classList.contains('dragging')) {
      box.scrollLeft = drag.left - dx;
      box.scrollTop = drag.top - dy;
    }
  });
  const lift = e => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (drag && drag.id === e.pointerId) endDrag();
  };
  on(box, 'pointerup', lift);
  on(box, 'pointercancel', lift);
  on(box, 'lostpointercapture', lift);
  // The click after a drag is not a click.
  on(box, 'click', e => {
    if (!controller.dragged) return;
    controller.dragged = false;
    e.preventDefault();
    e.stopPropagation();
  }, { capture: true });

  controller.state = () => {
    const fx = box.scrollWidth - box.clientWidth, fy = box.scrollHeight - box.clientHeight;
    return { zoom: atFit ? 'fit' : zoom, fx: fx > 0 ? box.scrollLeft / fx : 0, fy: fy > 0 ? box.scrollTop / fy : 0 };
  };
  controller.restore = s => {
    if (!s) return;
    if (!natural) { pending = s; return; }
    if (s.zoom === 'fit') { setFit(); return; }
    setZoom(Number(s.zoom));
    const frac = v => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
    box.scrollLeft = frac(s.fx) * Math.max(0, box.scrollWidth - box.clientWidth);
    box.scrollTop = frac(s.fy) * Math.max(0, box.scrollHeight - box.clientHeight);
  };
  controller.destroy = () => {
    off.abort();
    if (ro) ro.disconnect();
    pointers.clear();
    endDrag();
    box.classList.remove('can-drag', 'zoom-all');
    const focused = frame.getRootNode().activeElement;
    bar.hidden = true;
    if (focused && bar.contains(focused)) box.focus({ preventScroll: true });
  };
  return controller;
}

// The zoom of a sandboxed page, applied from outside: the frame is laid out at wrapper size ÷ zoom and scaled
// by zoom from its top left, inside the wrapper (div.page-zoom) that clips it. A ResizeObserver on the wrapper
// keeps Fit width right for its new width. The bar (−, percentage, +,
// Fit width, Actual size) sits on the wrapper's edge. Fit width waits for the page's own size report
// (SIZE_SCRIPT), taken only from opts.source() (default: the frame's window); it stays disabled for a page
// that fits. The page's own events stay its own: no wheel, drag or keys over it.
function pageZoom(wrapper, frame, opts = {}) {
  const doc = wrapper.ownerDocument;
  const win = doc.defaultView;
  const make = (tag, cls, text) => { const n = doc.createElement(tag); if (cls) n.className = cls; if (text) n.textContent = text; return n; };
  const MIN = 0.25, MAX = 2;
  wrapper.classList.add('page-zoom');
  if (frame.parentNode !== wrapper) wrapper.append(frame);
  let bar = wrapper.querySelector(':scope > .zoom-bar');
  if (!bar) {
    bar = make('div', 'zoom-bar');
    const button = (cls, text, label) => { const b = make('button', cls, text); b.type = 'button'; b.setAttribute('aria-label', label); return b; };
    const out = make('output', 'zoom-level');
    out.setAttribute('aria-live', 'polite');
    bar.append(button('zoom-out', '−', 'Zoom out'), out, button('zoom-in', '+', 'Zoom in'),
      button('zoom-fit', 'Fit width', 'Fit width'), button('zoom-100', '100%', 'Actual size'));
    wrapper.append(bar);
  }
  bar.hidden = false;
  const levelOut = bar.querySelector('.zoom-level');
  const fitButton = bar.querySelector('.zoom-fit');
  const off = new AbortController();
  const on = (target, type, fn, o = {}) => target.addEventListener(type, fn, { ...o, signal: off.signal });
  let zoom = 1;
  let report = null; // the last size report that said the page is wider than its frame
  let fit = null; // { fit, enabled } from pageFit, null until a report counts

  // The CSS (.page-zoom > .preview) lays the frame out at 100% ÷ zoom of the wrapper and scales it by zoom,
  // so the frame itself gets no new attribute.
  function apply(z) {
    zoom = clampZoom(z, MIN, MAX);
    wrapper.style.setProperty('--page-zoom', String(zoom));
    levelOut.textContent = `${Math.round(zoom * 100)}%`;
  }
  function setFit(f) {
    fit = f;
    fitButton.disabled = !(f && f.enabled);
  }
  const fitWidth = () => { if (fit && fit.enabled) apply(fit.fit); };

  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
    if (report) { const f = pageFit(report, wrapper.clientWidth); if (f) setFit(f); }
  }) : null;
  if (ro) ro.observe(wrapper);

  // A report made while zoomed out was laid out wider than the wrapper, so "it fits" says nothing about the
  // wrapper's width: the last report that counted stands (Fit width would otherwise disable itself).
  on(win, 'message', e => {
    if (!frame.isConnected) { off.abort(); if (ro) ro.disconnect(); return; }
    const source = opts.source ? opts.source() : frame.contentWindow;
    if (!source || e.source !== source) return;
    const f = pageFit(e.data, wrapper.clientWidth);
    if (!f) return;
    if (f.enabled) { report = e.data; setFit(f); }
    else if (zoom >= 1 - 1e-6) { report = null; setFit(f); }
  });

  const step = dir => apply(stepZoom(zoom, dir, MIN, MAX));
  const controller = { frame, wrapper };
  controller.key = e => {
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    if (e.key === '+' || e.key === '=') step(1);
    else if (e.key === '-') step(-1);
    else if (e.key === '0') { if (fit && fit.enabled) fitWidth(); else apply(1); }
    else if (e.key === '1') apply(1);
    else return false;
    e.preventDefault();
    return true;
  };
  on(bar, 'keydown', e => { if (controller.key(e)) e.stopPropagation(); });
  on(bar.querySelector('.zoom-out'), 'click', () => step(-1));
  on(bar.querySelector('.zoom-in'), 'click', () => step(1));
  on(fitButton, 'click', fitWidth);
  on(bar.querySelector('.zoom-100'), 'click', () => apply(1));

  setFit(null);
  apply(1);
  controller.state = () => ({ zoom });
  controller.restore = s => { if (s && Number.isFinite(Number(s.zoom))) apply(Number(s.zoom)); };
  controller.destroy = () => {
    off.abort();
    if (ro) ro.disconnect();
    bar.hidden = true;
  };
  return controller;
}

if (typeof module === 'object' && module.exports) {
  module.exports = { markdownParser, splitFences, chainFrom, siblingsOf, leafUnder, switchBranch, parseHash, formatHash, placeholderMark, splitPlaceholders, protectMath, addCitations, beforeCitation, fillPlaceholders, sanitizeHtml, toolInputText, HIGHLIGHT_LIMIT, tameMarkdown, languageOfFile, PREVIEW_CSP, REMOTE_NOTE, inlineSiblings, remoteScripts, previewDoc, resolveArtifactPath, inlineArtifact, artifactPreviewDoc, STORAGE_SHIM, RTC_SHIM, decodeAttr, artifactTabs, relativeTime, parseArtifactHash, chatFileTexts, versionCopyTexts, fileKindGroup, inChatsFiles, alsoInChat, artifactSourceLine, artifactLinkGroups, artifactsEntry, FLAG_NOTES, flagNote, parseInChatsHash, formatInChatsHash, resolveFile, OPENABLE_EXTENSIONS, isAddedId, addedFile, addedForChat, addedTree, filterAdded, fileViews, fileKindLabel, openableHref, buildSearchIndex, searchChats, parseQuery, groupHits, markTerms, chatFiles, countTerms, foldCase, shownText, findPlan, groupChats, linkProjects, RECENT_LIMIT, LIST_PAGE, recentChats, projectList, filterByText, parseListHash, copyText, attachmentNames, uploadName, fileSearchSources, fileHit, downloadName, dataUrlBytes, saveBytes, designCanvas, boardFlags, noteFill, DESIGN_BOARD_MAX, DESIGN_NOTE_MAX, canvasScale, CANVAS_ZOOM_MIN, CANVAS_ZOOM_MAX, canvasFit, clampPan, panAbout, DESIGN_COORD_MAX, DESIGN_SIZE_MAX, ZOOM_STEPS, PICTURE_MAX_SIDE, clampZoom, stepZoom, wheelFactor, zoomAbout, fitZoom, pictureRange, doubleClickZoom, svgNaturalSize, svgHasScripts, svgAsPicture, svgDataUrl, pageFit, SIZE_SCRIPT, pageZoom };
}
