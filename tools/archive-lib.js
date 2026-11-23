// Archive viewer tool, shared library: find Claude Takeout archives on disk and list the files
// the owner added to them. Plain CommonJS, stdlib only. Never follows symlinks.
const fs = require('fs');
const path = require('path');
const core = require('../export-core.js');
const CTViewer = require('../takeout-viewer.js');

// ===================================================================
// Export layout (CLAUDE.md section 7)
// ===================================================================

const KNOWN_ROOT_FILES = [
  'README.md', 'meta.md', 'prompts.md', 'responses_text_only.md', 'full_chat.md', 'integrated_chat.md',
  'integrated_chat.txt', 'code_snippets.md', 'links_and_sources.md', 'errors.txt', 'original.json',
  'index.md', 'viewer.html', 'viewer-check.gif', 'export-manifest.json',
];
// What an Export Artifacts root holds beside its artifact folders, besides KNOWN_ROOT_FILES.
const ARTIFACTS_ROOT_FILES = ['index.html', 'write-errors.txt'];
const KNOWN_DIRS = ['responses', 'artefacts', 'attachments', 'uploads', 'images', 'project', 'projects', 'viewer-files', 'published'];
const IGNORED_NAMES = ['.DS_Store', 'Thumbs.db', '__MACOSX', '.git', 'node_modules'];

// What a killed build_viewer run can leave at an archive root. Not added files; the tool reports them.
const LEFTOVER_NAME = /^(viewer\.html|viewer-check\.gif|viewer-files)\.tmp-\d+$|^viewer-files\.old-\d+$/;

const HEAD_BYTES = 64 * 1024;

const isIgnored = name => IGNORED_NAMES.includes(name) || name.startsWith('.');
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function lstat(p) {
  try { return fs.lstatSync(p); } catch (e) { return null; }
}
const isRealFile = p => { const s = lstat(p); return !!s && s.isFile(); };
const isRealDir = p => { const s = lstat(p); return !!s && s.isDirectory(); };

// .native gives the name as stored, whatever case it was typed in; the JS version keeps the typed case.
function realOrResolved(p) {
  try { return fs.realpathSync.native(p); } catch (e) { return path.resolve(p); }
}

// Immediate real subfolders, sorted. Symlinks and ignored names are left out.
function subdirs(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory() && !isIgnored(e.name))
    .map(e => e.name).sort(byCodeUnit);
}

// ===================================================================
// Is this original.json a Claude chat?
// ===================================================================

// Only the first 64 KB is read. A small file is parsed: valid JSON with no chat_messages is not a chat,
// invalid JSON (a truncated export) still is, so the run reports it as failed. A larger file can't be
// classified from its head, so it counts as a chat.
function looksLikeChat(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(HEAD_BYTES + 1);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    if (n > HEAD_BYTES) return true;
    let obj;
    try { obj = JSON.parse(buf.toString('utf8', 0, n)); } catch (e) { return true; }
    return !!obj && typeof obj === 'object' && !Array.isArray(obj) && 'chat_messages' in obj;
  } catch (e) {
    return true;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch (e) { /* ignore */ }
  }
}

// ===================================================================
// findArchives
// ===================================================================

// An Export Artifacts export (no chats): export-manifest.json says kind "artifacts", and a folder beside it holds
// artifact.json.
function isArtifactsExport(dir) {
  if (!isRealFile(path.join(dir, 'export-manifest.json'))) return false;
  try {
    const m = JSON.parse(stripBom(fs.readFileSync(path.join(dir, 'export-manifest.json'), 'utf8')));
    if (!m || typeof m !== 'object' || m.kind !== 'artifacts') return false;
    return subdirs(dir).some(n => isRealFile(path.join(dir, n, 'artifact.json')));
  } catch (e) { return false; }
}

// An Export All (or Export Changes, or a merged archive) that holds artifacts and no chats: index.md, an
// export-manifest.json of one of those kinds, and an artifacts/ folder (exact case) with a <folder>/artifact.json.
const ALL_KINDS = ['full', 'changes', 'merged'];
function isArtifactsOnlyAll(dir) {
  if (!isRealFile(path.join(dir, 'index.md')) || !isRealFile(path.join(dir, 'export-manifest.json'))) return false;
  try {
    const m = JSON.parse(stripBom(fs.readFileSync(path.join(dir, 'export-manifest.json'), 'utf8')));
    if (!m || typeof m !== 'object' || !ALL_KINDS.includes(m.kind) || !fs.readdirSync(dir).includes('artifacts')) return false;
    const base = path.join(dir, 'artifacts');
    return isRealDir(base) && subdirs(base).some(n => isRealFile(path.join(base, n, 'artifact.json')));
  } catch (e) { return false; }
}

function findArchives(root, { exclude = [] } = {}) {
  const excluded = exclude.map(realOrResolved);
  const archives = [];
  const skipped = [];
  const zips = [];

  const isExcluded = p => {
    const real = realOrResolved(p);
    return excluded.some(x => real === x || real.startsWith(x + path.sep));
  };

  function walk(dir) {
    if (isExcluded(dir)) return;
    try {
      const hasOriginal = isRealFile(path.join(dir, 'original.json'));
      const names = subdirs(dir);
      const chatNames = names.filter(n => isRealFile(path.join(dir, n, 'original.json')));

      // A folder with its own original.json is always a single chat, whatever else sits beside it.
      if (hasOriginal) {
        if (isRealFile(path.join(dir, 'conversation.json')) || !looksLikeChat(path.join(dir, 'original.json'))) {
          skipped.push({ path: dir, reason: 'not a Claude chat' });
        } else {
          archives.push({ root: dir, kind: 'single', chats: [{ dir, relDir: '.' }], hasViewer: isRealFile(path.join(dir, 'viewer.html')) });
        }
        return;
      }
      if (!chatNames.length && isArtifactsExport(dir)) {
        archives.push({ root: dir, kind: 'artifacts', chats: [], hasViewer: isRealFile(path.join(dir, 'viewer.html')) });
        return;
      }
      if (!chatNames.length && isArtifactsOnlyAll(dir)) {
        archives.push({ root: dir, kind: 'mega', chats: [], hasViewer: isRealFile(path.join(dir, 'viewer.html')) });
        return;
      }
      if (isRealFile(path.join(dir, 'index.md')) && chatNames.length) {
        const chats = [];
        for (const n of chatNames) {
          const cdir = path.join(dir, n);
          if (isExcluded(cdir)) continue;
          if (isRealFile(path.join(cdir, 'conversation.json')) || !looksLikeChat(path.join(cdir, 'original.json'))) {
            skipped.push({ path: cdir, reason: 'not a Claude chat' });
          } else chats.push({ dir: cdir, relDir: n });
        }
        archives.push({ root: dir, kind: 'mega', chats, hasViewer: isRealFile(path.join(dir, 'viewer.html')) });
        return;
      }
      for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => byCodeUnit(a.name, b.name))) {
        if (isIgnored(e.name)) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.isFile() && /\.zip$/i.test(e.name) && !isExcluded(p)) zips.push(p);
      }
    } catch (e) {
      skipped.push({ path: dir, reason: 'unreadable: ' + e.message });
    }
  }

  // The folder the user names may itself be a link; everything below it is not followed.
  walk(root);
  return { archives, skipped, zips };
}

// True when dir is an archive as findArchives sees one: a chat, index.md beside a chat folder, an Export
// Artifacts export, or an Export All with artifacts and no chats.
function isArchiveRoot(dir) {
  if (isRealFile(path.join(dir, 'original.json'))) return true;
  if (isArtifactsExport(dir)) return true;
  if (isArtifactsOnlyAll(dir)) return true;
  if (!isRealFile(path.join(dir, 'index.md'))) return false;
  try { return subdirs(dir).some(n => isRealFile(path.join(dir, n, 'original.json'))); } catch (e) { return false; }
}

// ===================================================================
// Generated-viewer marker
// ===================================================================

// text of a viewer.html. True for a viewer this tool or the extension produced.
function isGeneratedViewer(html) {
  if (typeof html !== 'string') return false;
  if (/<meta\s+name=["']generator["']\s+content=["']Claude Takeout["']\s*\/?>/i.test(html)) return true;
  return /<script\s+id=["']data["']\s+type=["']application\/json["']/i.test(html) && html.includes('function chainFrom(');
}

// ===================================================================
// scanAdded
// ===================================================================

// Files the owner added: anything in an archive root or chat folder outside the export layout.
// Inside an added folder every file counts. Known folders (uploads/ and so on) list nothing.
// Chat folders of a mega (including skipped or excluded ones) are never "added" at the root.
// Returns { files: [{ path, chatDir, size }], errors: [{ path, message }] }; one unreadable folder
// or vanished file is recorded in errors and the scan goes on.
function scanAdded(archive) {
  const files = [];
  const errors = [];
  let chatRel = new Set();
  // The export's artifact folders: artifacts/ at a mega root (1.17 and later), and each <dir>/ holding artifact.json
  // at an Export Artifacts root.
  if (archive.kind === 'artifacts') {
    try { chatRel = new Set(subdirs(archive.root).filter(n => isRealFile(path.join(archive.root, n, 'artifact.json')))); } catch (e) {
      errors.push({ path: '', message: e.message });
    }
  }
  if (archive.kind === 'mega') {
    try { chatRel = new Set(subdirs(archive.root).filter(n => isRealFile(path.join(archive.root, n, 'original.json')))); } catch (e) {
      errors.push({ path: '', message: e.message });
    }
    for (const c of archive.chats) chatRel.add(c.relDir);
  }

  const relOf = (rel, name) => (rel ? rel + '/' + name : name);
  const addFile = (p, r, chatDir) => {
    try { files.push({ path: r, chatDir, size: fs.lstatSync(p).size }); } catch (e) { errors.push({ path: r, message: e.message }); }
  };
  const entries = (dir, rel) => {
    try { return fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { errors.push({ path: rel, message: e.message }); return []; }
  };

  function addTree(dir, rel, chatDir) {
    for (const e of entries(dir, rel)) {
      if (isIgnored(e.name)) continue;
      const p = path.join(dir, e.name);
      const r = relOf(rel, e.name);
      if (e.isDirectory()) addTree(p, r, chatDir);
      else if (e.isFile()) addFile(p, r, chatDir);
    }
  }

  function scanLevel(dir, rel, chatDir, skipDirs) {
    for (const e of entries(dir, rel)) {
      if (isIgnored(e.name) || (rel === '' && LEFTOVER_NAME.test(e.name))) continue;
      const p = path.join(dir, e.name);
      const r = relOf(rel, e.name);
      const atRoot = dir === archive.root;
      if (e.isDirectory()) {
        if (KNOWN_DIRS.includes(e.name) || skipDirs.has(e.name)) continue;
        if (atRoot && archive.kind === 'mega' && e.name === 'artifacts') continue;
        addTree(p, r, chatDir);
      } else if (e.isFile()) {
        // index.md is the export's only at a mega or Export Artifacts root; anywhere else it is the owner's.
        const known = (KNOWN_ROOT_FILES.includes(e.name) && (e.name !== 'index.md' || (atRoot && archive.kind !== 'single')))
          || (atRoot && archive.kind === 'artifacts' && ARTIFACTS_ROOT_FILES.includes(e.name));
        if (!known) addFile(p, r, chatDir);
      }
    }
  }

  scanLevel(archive.root, '', null, chatRel);
  if (archive.kind === 'mega') for (const c of archive.chats) scanLevel(c.dir, c.relDir, c.relDir, new Set());
  files.sort((a, b) => byCodeUnit(a.path, b.path));
  return { files, errors };
}


// ===================================================================
// matchFile
// ===================================================================

const looseKey = name => String(name).normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

const unnumbered = name => String(name).replace(/^p\d+_/, '');
const nfc = name => String(name).normalize('NFC');

// The name in `names` that stands for `expected`, trying four tiers in order: exact; NFC-equal; equal after
// dropping case and punctuation (older exports sanitised names differently); the same with the leading
// `p<N>_` prompt number dropped from both (older numbering differed). In the last two tiers two candidates
// are no match: null. maxTier (0 to 3) stops the search early, so a caller can take every exact match first.
function matchFile(expected, names, maxTier = 3) {
  if (names.includes(expected)) return expected;
  if (maxTier < 1) return null;
  const same = names.find(n => nfc(n) === nfc(expected));
  if (same !== undefined) return same;
  for (const [tier, key] of [[2, looseKey], [3, n => looseKey(unnumbered(n))]]) {
    if (maxTier < tier) break;
    const want = key(expected);
    if (!want) continue;
    const hits = names.filter(n => key(n) === want);
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) return null;
  }
  return null;
}

// ===================================================================
// chatFromDisk
// ===================================================================

const stripBom = text => (text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text);

// Real files directly in dir, sorted. A missing or unreadable folder lists nothing.
function fileNames(dir) {
  if (!isRealDir(dir)) return [];  // a missing folder, or a link to one elsewhere: never followed
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isFile() && !isIgnored(e.name)).map(e => e.name).sort(byCodeUnit);
  } catch (e) { return []; }
}

// Text of a file with any BOM removed, or null when it can't be read.
function readText(file) {
  try { return stripBom(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

// original.json parsed fine but is not a Claude chat (looksLikeChat can't tell from the head of a big file).
class NotAChat extends Error {}

function readChatJson(dir) {
  const file = path.join(dir, 'original.json');
  try {
    return JSON.parse(stripBom(fs.readFileSync(file, 'utf8')));
  } catch (e) {
    throw new Error(`${file}: ${e.message}`);
  }
}

// A file's text to embed in the viewer, or null when it only gets a link: not text by isText, over
// TEXT_EMBED_LIMIT, or unreadable (onError hears why). Uploads and added files both use it.
function embeddableText(file, name, { isText = core.isTextFile, onError = null } = {}) {
  try {
    if (!isText(name)) return null;
    const limit = CTViewer.TEXT_EMBED_LIMIT;
    if (fs.statSync(file).size > limit) return null;
    const text = stripBom(fs.readFileSync(file, 'utf8'));
    return text.length <= limit ? core.fixMojibake(text) : null;
  } catch (e) {
    if (onError) onError(e);
    return null;
  }
}

// An upload's text for the viewer: the sync twin of popup.js's viewerUploadText.
const uploadText = (file, name) => embeddableText(file, name);

// isTextFile leaves .mmd out, and exports keep to it; the viewer shows it as a diagram.
const isAddedText = name => core.isTextFile(name) || /\.mmd$/i.test(name);

const PROJECT_META_FILES = ['project.json', 'docs.json', 'files.json', 'prompt_template.md'];

// ===================================================================
// Published pages
// ===================================================================

const PAGE_URL = /^https:\/\/claude\.ai\/artifact\/[A-Za-z0-9_-]{1,64}$/;
const SHORT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const needsRuntime = core.publishedNeedsRuntime;
const plainSegments = rel => typeof rel === 'string' && rel !== '' && rel.split('/').every(s => s !== '' && s !== '.' && s !== '..' && !/[\\\0]/.test(s));

// A file under dir by its saved '/'-separated name, only through real folders (no links), or null.
function realFileUnder(dir, rel) {
  if (!plainSegments(rel)) return null;
  const segs = rel.split('/');
  let at = dir;
  for (let i = 0; i < segs.length - 1; i++) {
    at = path.join(at, segs[i]);
    if (!isRealDir(at)) return null;
  }
  at = path.join(at, segs[segs.length - 1]);
  return isRealFile(at) ? at : null;
}

// A folder under dir by its '/'-separated name, every segment a real folder (no links), or null. A name read from
// on-disk JSON (a version folder, a savedIn path) is resolved only through this: a link anywhere on the way, such as
// a published/ pointing outside the archive, could otherwise reach files elsewhere.
function realDirUnder(dir, rel) {
  if (!plainSegments(rel)) return null;
  let at = dir;
  for (const seg of rel.split('/')) {
    at = path.join(at, seg);
    if (!isRealDir(at)) return null;
  }
  return at;
}

// Markdown link targets into a store of published pages: the shared published/ of an Export All (../published/), a
// chat's own (published/), and 1.18's artifacts/ (../artifacts/), also from a folder deeper in the chat (responses/:
// ../../published/). merge_archives moves those, so it rewrites the links.
const STORE_LINK = /^(\.\.\/)*published\/|^(\.\.\/)+artifacts\//;
// A link: ](target), the target without spaces and with at most one level of balanced parentheses (a file named
// "page (1).html" keeps its parentheses through encodeURIComponent).
const MD_LINK = /\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g;

// text split into [{ code, text }]: fenced code blocks (``` or ~~~, three or more, closed by a fence of the same
// character at least as long, or the end) and inline code spans (a run of backticks closed by a run of the same length
// in the same paragraph; a backslash-escaped backtick opens none) are code; the rest is prose. Joined again, the
// pieces are the text.
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
function markdownPieces(text) {
  const pieces = [];
  const push = (code, t) => {
    if (!t) return;
    const last = pieces[pieces.length - 1];
    if (last && last.code === code) last.text += t;
    else pieces.push({ code, text: t });
  };
  // Inline code spans, in prose only, each within one paragraph (a blank line ends any span).
  const prose = t => { for (const para of t.split(/(?<=\n[ \t]*\n)/)) paragraph(para); };
  const paragraph = t => {
    const runs = /`+/g;
    let at = 0;
    let m;
    while ((m = runs.exec(t))) {
      // An odd number of backslashes before the run escapes its first backtick: the rest of the run may still open one.
      let slashes = 0;
      while (t[m.index - 1 - slashes] === '\\') slashes++;
      if (slashes % 2) { runs.lastIndex = m.index + 1; continue; }
      const close = new RegExp(`(?<!\`)${m[0]}(?!\`)`, 'g');
      close.lastIndex = m.index + m[0].length;
      const end = close.exec(t);
      if (!end) continue;  // no closing run: the backticks are text
      push(false, t.slice(at, m.index));
      push(true, t.slice(m.index, end.index + end[0].length));
      at = end.index + end[0].length;
      runs.lastIndex = at;
    }
    push(false, t.slice(at));
  };
  const lines = String(text).split(/(?<=\n)/);
  let fence = null;
  let buffer = '';
  for (const line of lines) {
    if (fence) {
      push(true, line);
      const m = FENCE.exec(line);
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && /^ {0,3}[`~]+\s*$/.test(line)) fence = null;
      continue;
    }
    const m = FENCE.exec(line);
    if (m && !(m[1][0] === '`' && line.slice(line.indexOf(m[1]) + m[1].length).includes('`'))) {
      prose(buffer);
      buffer = '';
      fence = m[1];
      push(true, line);
      continue;
    }
    buffer += line;
  }
  prose(buffer);
  return pieces;
}

// text with every Markdown link into a store (STORE_LINK) mapped: map(target) gives the new target, or null to leave
// the link as it is. Links in code (fenced blocks, inline code spans) are text, not links, and are left alone.
// Returns { text, unmapped: [target, ...] } (each target once, in the order found).
function rewriteChatLinks(text, map) {
  const unmapped = [];
  const out = markdownPieces(text).map(piece => (piece.code ? piece.text : piece.text.replace(MD_LINK, (whole, target) => {
    if (!STORE_LINK.test(target)) return whole;
    const to = map(target);
    if (typeof to !== 'string' || !to) {
      if (!unmapped.includes(target)) unmapped.push(target);
      return whole;
    }
    return `](${to})`;
  }))).join('');
  return { text: out, unmapped };
}

// A 1.18 store record as the published.json of a page (publishedFromDisk reads that shape): versions by folder name,
// each labelled v1, v2, ... in the record's order (artifact.json keeps no claude.ai version numbers).
function v18Page(store, rec) {
  const limit = CTViewer.TEXT_EMBED_LIMIT;
  const versions = {};
  const used = new Set();
  rec.order.forEach((ver, i) => {
    const v = rec.versions.get(ver);
    const want = v.folder ? v.folder.split('/').pop() : core.publishedSegment(ver);
    let name = want;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${want}_${n}`;
    used.add(name.toLowerCase());
    // needsRuntime is not in artifact.json: read from the start file, as the export judged it.
    let runtime = false;
    const startFile = v.folder && v.start ? v.files.find(f => f.path === v.start) : null;
    if (startFile && startFile.abs && core.isPublishedText(startFile)) {
      try { if (fs.statSync(startFile.abs).size <= limit * 4) runtime = core.publishedNeedsRuntime(new TextDecoder().decode(fs.readFileSync(startFile.abs))); } catch (e) { runtime = false; }
    }
    versions[name] = {
      ver, label: `v${i + 1}`, order: i, saved: !!v.folder && v.saved, files: v.files.map(f => ({ path: f.path, savedAs: f.savedAs, contentType: f.contentType })),
      start: v.start, startSaved: v.startSaved, incomplete: v.incomplete, needsRuntime: runtime, missing: v.missing, publishedIn: v.publishedIn,
    };
  });
  return { uuid: rec.uuid, title: rec.title, url: rec.meta.url, versions };
}

// A 1.18 record's page and folder, built once per store (publishedOnDisk runs for every chat of an archive).
const v18Pages = new WeakMap();
function v18PageOnDisk(store, rec) {
  if (!v18Pages.has(store)) v18Pages.set(store, new Map());
  const cache = v18Pages.get(store);
  if (!cache.has(rec.uuid)) {
    const abs = realDirUnder(store.root, rec.dir);
    cache.set(rec.uuid, abs ? { json: v18Page(store, rec), abs } : null);
  }
  return cache.get(rec.uuid);
}

// Every published page on disk this chat can reach, by page uuid: the chat's own published/ first, then, for a chat
// in an Export All, the shared published/ at the archive root (pre-1.17 and 1.17), then the archive's artifacts/
// (1.18). Each: { json (published.json's shape), dir (relative to the chat folder), abs }. store: readArtifactStore's.
function publishedOnDisk(archive, chat, store) {
  const found = new Map();
  const add = (uuid, entry) => { if (!found.has(uuid)) found.set(uuid, entry); };
  const inMega = archive.kind === 'mega' && chat.relDir !== '.' && !chat.relDir.includes('/');
  const own = archive.kind === 'mega' ? chat.relDir : null;
  for (const page of store.published) if (page.chat === own) add(page.json.uuid.toLowerCase(), { json: page.json, dir: `published/${path.basename(page.abs)}`, abs: page.abs });
  if (inMega) for (const page of store.published) if (page.chat === null) add(page.json.uuid.toLowerCase(), { json: page.json, dir: `../published/${path.basename(page.abs)}`, abs: page.abs });
  if (inMega) {
    for (const rec of store.records.values()) {
      if (rec.format !== 2 || rec.dir.split('/')[0] !== 'artifacts') continue;
      const page = v18PageOnDisk(store, rec);
      if (page) add(rec.uuid, { json: page.json, dir: `../${rec.dir}`, abs: page.abs });
    }
  }
  return found;
}

// ===================================================================
// Artifacts on disk: every layout
// ===================================================================

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VER_KEY = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/;
const THUMB_PATH = /^viewer-files\/thumbs\/[A-Za-z0-9_-]{1,64}\.(png|jpg|webp)$/;
const THUMB_MAX = 2 * 1024 * 1024;
const str = v => (typeof v === 'string' ? v : '');
const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);

// A JSON object from a real file, or null (a warning says why, unless the file is simply not there).
function readJsonObject(file, label, warnings) {
  if (!isRealFile(file)) return null;
  try {
    const obj = JSON.parse(readText(file));
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
  } catch (e) {
    warnings.push(`${label}: ${e.message}`);
    return null;
  }
}

// The export's own folder at root by its exact-case name, unless it is a link (warned) or a chat.
function exportFolder(root, name, warnings) {
  let names = [];
  try { names = fs.readdirSync(root); } catch (e) { return null; }
  if (!names.includes(name)) return null;
  const abs = path.join(root, name);
  const st = lstat(abs);
  if (st && st.isSymbolicLink()) { warnings.push(`${name}/ is a link to another folder, so it was not read`); return null; }
  if (!isRealDir(abs) || isRealFile(path.join(abs, 'original.json'))) return null;
  return abs;
}

// A file entry of artifact.json or published.json, with abs: the file on disk under dir (no links), or null.
function diskFile(f, dir) {
  const savedAs = typeof f.savedAs === 'string' && f.savedAs ? f.savedAs : null;
  return {
    path: f.path, savedAs, size: Number.isFinite(f.size) ? f.size : null, contentType: typeof f.contentType === 'string' ? f.contentType : null,
    sha256: typeof f.sha256 === 'string' ? f.sha256 : null, verified: f.verified !== false, abs: dir && savedAs ? realFileUnder(dir, savedAs) : null,
  };
}
const fileList = (files, dir) => (Array.isArray(files) ? files : []).filter(f => f && typeof f.path === 'string' && f.path).map(f => diskFile(f, dir));
const publishedInList = list => (Array.isArray(list) ? list : []).filter(p => p && typeof p === 'object').map(p => ({
  chat: p.chat, messageUuid: p.messageUuid, toolUseId: p.toolUseId, same: !!p.same, writtenAs: typeof p.writtenAs === 'string' ? p.writtenAs : null,
}));

// A version's sameAs ({ <published path>: <root-relative file> }), only names of real files inside the archive, and
// sameAsAbs, those files on disk.
function sameAsOf(map, root) {
  if (!map || typeof map !== 'object') return { sameAs: null, sameAsAbs: null };
  const sameAs = {};
  const sameAsAbs = {};
  for (const [p, rel] of Object.entries(map)) {
    // Only a real file inside the archive: a name through a link (or not there) points at nothing.
    const abs = typeof rel === 'string' ? realFileUnder(root, rel) : null;
    if (!abs) continue;
    sameAs[p] = rel;
    sameAsAbs[p] = abs;
  }
  return Object.keys(sameAs).length ? { sameAs, sameAsAbs } : { sameAs: null, sameAsAbs: null };
}

// A version folder (archive-relative) one '/'-separated name under the artifact folder, when it is a real folder.
function versionFolder(root, dir, name) {
  if (typeof name !== 'string' || !plainSegments(name) || name.includes('/')) return null;
  const rel = `${dir}/${name}`;
  const abs = realDirUnder(root, rel);
  return abs ? { rel, abs } : null;
}

// claude.ai's card data of an artifact.json (format 1 or 2), as a store record's meta.
function metaOf(json) {
  return {
    url: str(json.url), typeTitle: str(json.typeTitle), sourceSurface: str(json.sourceSurface), rel: str(json.rel), public: json.public === true,
    createdAt: str(json.createdAt), updatedAt: str(json.updatedAt), note: str(json.note), start: typeof json.start === 'string' && json.start ? json.start : null,
    needsRuntime: !!json.needsRuntime, incomplete: !!json.incomplete,
  };
}

function newRecord(uuid, shortId, title, dir) {
  let id = typeof shortId === 'string' && SHORT_ID.test(shortId) ? shortId : '';
  if (!id) { try { id = core.uuidToBase58(uuid); } catch (e) { id = ''; } }
  return {
    uuid, shortId: id, title: String(title || ''), dir, listed: false, current: null, format: null,
    meta: { url: `https://claude.ai/artifact/${id || uuid}`, typeTitle: '', sourceSurface: '', rel: '', public: false, createdAt: '', updatedAt: '', note: '', start: null, needsRuntime: false, incomplete: false },
    order: [], versions: new Map(), thumb: null, thumbRel: null,
  };
}

// The card picture an artifact.json names, when it is the export's own (viewer-files/thumbs/) and a real file.
function thumbOf(root, rel) {
  if (typeof rel !== 'string' || !THUMB_PATH.test(rel)) return null;
  const abs = realFileUnder(root, rel);
  if (!abs) return null;
  try { if (fs.statSync(abs).size > THUMB_MAX) return null; } catch (e) { return null; }
  return { rel, abs };
}

// A version's ZIP (1.19): named <folder>.zip in artifact.json and a real file beside the version folder, never
// reached through a link. { zip: <name>, zipAbs } or nothing.
function zipOf(root, dir, folder, zip) {
  if (typeof folder !== 'string' || typeof zip !== 'string' || zip !== `${folder}.zip`) return {};
  const abs = realFileUnder(root, `${dir}/${zip}`);
  return abs ? { zip, zipAbs: abs } : {};
}

// artifact.json format 2 (Claude Takeout 1.18): a version folder per version, sameAs for one a chat wrote the same.
function recordFromV2(root, dir, json) {
  const rec = newRecord(json.uuid.toLowerCase(), json.shortId, json.title, dir);
  Object.assign(rec, { format: 2, listed: json.listed === true, current: typeof json.current === 'string' && VER_KEY.test(json.current) ? json.current : null, meta: { ...rec.meta, ...metaOf(json) } });
  const versions = json.versions && typeof json.versions === 'object' && !Array.isArray(json.versions) ? json.versions : {};
  const keys = Object.keys(versions).filter(k => VER_KEY.test(k) && versions[k] && typeof versions[k] === 'object');
  const order = Array.isArray(json.order) ? json.order.filter(k => typeof k === 'string' && keys.includes(k)) : [];
  rec.order = [...new Set([...order, ...keys])];
  // Up to v1.20.7 the order was claude.ai's history as sent, newest first: the current version (claude.ai's newest)
  // first is read back oldest first.
  if (rec.current && rec.order.length > 1 && rec.order[0] === rec.current) rec.order.reverse();
  for (const ver of rec.order) {
    const v = versions[ver];
    const at = v.folder ? versionFolder(root, dir, v.folder) : null;
    rec.versions.set(ver, {
      folder: at ? at.rel : null, abs: at ? at.abs : null, files: fileList(v.files, at ? at.abs : null),
      start: typeof v.start === 'string' && v.start ? v.start : null, startSaved: at && typeof v.startSaved === 'string' && v.startSaved ? v.startSaved : null,
      incomplete: !!v.incomplete, missing: Array.isArray(v.missing) ? v.missing.filter(p => typeof p === 'string') : [], saved: !!v.saved && !!at,
      ...(at ? { sameAs: null, sameAsAbs: null } : sameAsOf(v.sameAs, root)), publishedIn: publishedInList(v.publishedIn),
      ...(at ? zipOf(root, dir, v.folder, v.zip) : {}),
    });
  }
  const thumb = thumbOf(root, json.thumb);
  if (thumb) { rec.thumb = thumb.abs; rec.thumbRel = thumb.rel; }
  return rec;
}

// artifact.json format 1 (1.15 to 1.17): the current version's files beside it, or savedIn naming the files the
// chats saved (root-relative): a published/<page>/<version>/ folder, or a chat's own file.
function recordFromV1(root, dir, abs, json) {
  const rec = newRecord(json.uuid.toLowerCase(), json.shortId, json.title, dir);
  const ver = typeof json.ver === 'string' && VER_KEY.test(json.ver) ? json.ver : '';
  Object.assign(rec, { format: 1, listed: true, current: ver || null, meta: { ...rec.meta, ...metaOf(json) } });
  const listing = Array.isArray(json.files) ? json.files.filter(f => f && typeof f.path === 'string' && f.path) : [];
  const start = rec.meta.start;
  const savedIn = json.savedIn && typeof json.savedIn === 'object' ? json.savedIn : null;
  let v = null;
  if (savedIn && Object.keys(savedIn).length) {
    const paths = Object.keys(savedIn).filter(p => typeof savedIn[p] === 'string' && plainSegments(savedIn[p]));
    const segs = paths.map(p => savedIn[p].split('/'));
    // Every file in one published/<page>/<version>/ folder: that version folder.
    const head = segs.length && segs.every(s => s.length > 3 && s[0] === 'published' && s[1] === segs[0][1] && s[2] === segs[0][2]) ? segs[0].slice(0, 3).join('/') : null;
    const headAbs = head ? realDirUnder(root, head) : null;
    const at = headAbs ? { rel: head, abs: headAbs } : null;
    const files = paths.map(p => {
      const listed = listing.find(f => f.path === p) || { path: p };
      return diskFile({ ...listed, savedAs: at ? savedIn[p].split('/').slice(3).join('/') : null }, at ? at.abs : null);
    });
    v = at
      ? { folder: at.rel, abs: at.abs, files, sameAs: null, sameAsAbs: null, saved: true, startSaved: start && has(savedIn, start) ? savedIn[start].split('/').slice(3).join('/') : null }
      : { folder: null, abs: null, files, ...sameAsOf(Object.fromEntries(paths.map(p => [p, savedIn[p]])), root), saved: false, startSaved: null };
  } else if (listing.length) {
    const files = fileList(listing, abs);
    const missing = Array.isArray(json.missing) ? json.missing : [];
    const saved = files.some(f => !missing.includes(f.path) && f.savedAs);
    const startFile = start ? files.find(f => f.path === start) : null;
    v = { folder: saved ? dir : null, abs: saved ? abs : null, files, sameAs: null, sameAsAbs: null, saved, startSaved: saved && startFile ? startFile.savedAs : null };
  }
  if (v) {
    rec.order = [ver || 'current'];
    rec.versions.set(ver || 'current', { ...v, start, incomplete: !!json.incomplete, missing: Array.isArray(json.missing) ? json.missing.filter(p => typeof p === 'string') : [], publishedIn: [] });
  }
  const thumb = thumbOf(root, json.thumb);
  if (thumb) { rec.thumb = thumb.abs; rec.thumbRel = thumb.rel; }
  return rec;
}

// The published/ folders of an archive, root first, then each chat folder's (a single chat's is the root's).
// Each published.json: { json, dir (archive-relative page folder), abs, chat (the chat folder's name, null at the root) }.
function publishedFolders(root, warnings) {
  const out = [];
  const places = [];
  const base = exportFolder(root, 'published', warnings);
  if (base) places.push({ base, rel: 'published', chat: null });
  let chats = [];
  try { chats = subdirs(root).filter(n => isRealFile(path.join(root, n, 'original.json'))); } catch (e) { /* unreadable */ }
  for (const n of chats) {
    const b = exportFolder(path.join(root, n), 'published', warnings);
    if (b) places.push({ base: b, rel: `${n}/published`, chat: n });
  }
  for (const { base, rel, chat } of places) {
    let names = [];
    try { names = subdirs(base); } catch (e) { warnings.push(`${rel}/: ${e.message}`); continue; }
    for (const name of names) {
      const json = readJsonObject(path.join(base, name, 'published.json'), `${rel}/${name}/published.json`, warnings);
      if (!json || typeof json.uuid !== 'string' || !UUID.test(json.uuid) || !json.versions || typeof json.versions !== 'object') continue;
      out.push({ json, dir: `${rel}/${name}`, abs: path.join(base, name), chat });
    }
  }
  return out;
}

// The versions of a published.json (pre-1.17 chats' pages, kept beside 1.17's artifacts/) added to a record: each
// version id not there yet. Returns the page's version ids in its order.
function addPublished(rec, page) {
  const list = Object.entries(page.json.versions).filter(([, v]) => v && typeof v === 'object' && typeof v.ver === 'string' && VER_KEY.test(v.ver))
    .sort((a, b) => (Number.isFinite(a[1].order) ? a[1].order : 0) - (Number.isFinite(b[1].order) ? b[1].order : 0));
  for (const [folderName, v] of list) {
    if (rec.versions.has(v.ver)) {
      // A 1.17 artifact's current version (artifact.json keeps no publishes): the chats' publishes of it from here.
      const had = rec.versions.get(v.ver);
      const seen = new Set(had.publishedIn.map(p => `${p.chat}\n${p.toolUseId}`));
      had.publishedIn.push(...publishedInList(v.publishedIn).filter(p => !seen.has(`${p.chat}\n${p.toolUseId}`)));
      continue;
    }
    rec.order.push(v.ver);
    const dirAbs = !folderName.includes('/') ? realDirUnder(page.abs, folderName) : null;
    const ok = !!dirAbs;
    const saved = v.saved === true && ok;
    rec.versions.set(v.ver, {
      folder: saved ? `${page.dir}/${folderName}` : null, abs: saved ? dirAbs : null, files: fileList(v.files, saved ? dirAbs : null),
      start: typeof v.start === 'string' && v.start ? v.start : null, startSaved: saved && typeof v.startSaved === 'string' && v.startSaved ? v.startSaved : null,
      incomplete: !!v.incomplete, missing: Array.isArray(v.missing) ? v.missing.filter(p => typeof p === 'string') : [], saved,
      sameAs: null, sameAsAbs: null, publishedIn: publishedInList(v.publishedIn), needsRuntime: !!v.needsRuntime,
    });
  }
  return list.map(([, v]) => v.ver);
}

// Every artifact an archive holds, in whichever layout it was written, as one kind of record:
//   'published'        pre-1.17: published/<page>/published.json at the root (Export All) or in a chat folder
//   'v17'              1.17 Export All: published/ as above, plus artifacts/<dir>/artifact.json (format 1), the
//                      current version's files beside it or savedIn pointing at the chats' copies
//   'v18'              1.18 Export All: artifacts/<dir>/artifact.json (format 2), a <ver>/ folder per version
//   'standalone-flat'  Export Artifacts 1.15 to 1.17: <dir>/artifact.json (format 1) at the root, files beside it
//   'standalone-v18'   Export Artifacts 1.18: <dir>/artifact.json (format 2) at the root
// Returns { layout, root, exportedAt, since, listFetched (claude.ai's list is in the archive), listed (how many it
// listed, or null), kind (the manifest's), records: Map<uuid, DiskRec>, published (each published.json, for
// chatFromDisk), warnings }. DiskRec: { uuid, shortId, title, dir (its artifact folder, archive-relative), listed,
// current, format, meta (artifact.json's card data: url, typeTitle, sourceSurface, rel, public, createdAt, updatedAt,
// note, start, needsRuntime, incomplete), order (version keys in claude.ai's order), versions: Map<ver, { folder
// (archive-relative, null when no copy is on disk), abs, files: [{ path, savedAs, size, contentType, sha256, verified,
// abs }], start, startSaved, incomplete, missing, saved, sameAs ({ <published path>: <root-relative file> } | null),
// sameAsAbs (those files on disk), publishedIn }>, thumb (abs | null), thumbRel }. Nothing is followed through a
// link, and nothing outside root is read.
function readArtifactStore(root, { warnings = [] } = {}) {
  const manifest = readJsonObject(path.join(root, 'export-manifest.json'), 'export-manifest.json', warnings) || {};
  const kind = typeof manifest.kind === 'string' ? manifest.kind : null;
  const store = {
    layout: 'none', root, exportedAt: typeof manifest.exported_at === 'string' ? manifest.exported_at : null, since: typeof manifest.since === 'string' ? manifest.since : null,
    listFetched: false, listed: null, kind, records: new Map(), published: [], warnings,
  };
  const standalone = kind === 'artifacts';
  const base = standalone ? root : exportFolder(root, 'artifacts', warnings);
  const prefix = standalone ? '' : 'artifacts/';
  let formats = new Set();
  if (base) {
    let names = [];
    try { names = subdirs(base); } catch (e) { warnings.push(`${prefix || './'}: ${e.message}`); }
    for (const name of names) {
      const abs = path.join(base, name);
      const json = readJsonObject(path.join(abs, 'artifact.json'), `${prefix}${name}/artifact.json`, warnings);
      if (!json || typeof json.uuid !== 'string' || !UUID.test(json.uuid)) continue;
      const rec = json.format === 2 ? recordFromV2(root, `${prefix}${name}`, json) : recordFromV1(root, `${prefix}${name}`, abs, json);
      if (store.records.has(rec.uuid)) continue;
      formats.add(rec.format);
      store.records.set(rec.uuid, rec);
    }
  }
  if (!standalone) store.published = publishedFolders(root, warnings);
  for (const page of store.published) {
    const uuid = page.json.uuid.toLowerCase();
    let rec = store.records.get(uuid);
    if (!rec) {
      rec = newRecord(uuid, page.json.shortId, page.json.title, page.dir);
      rec.format = 0;
      store.records.set(uuid, rec);
    }
    if (rec.format === 2) continue;  // 1.18 keeps no published/; a stray one is not read into its store
    const pageOrder = addPublished(rec, page);
    // A 1.17 artifact's current version (format 1) takes its place among the versions the chats published, or the last.
    if (rec.format === 1) rec.order = [...new Set([...pageOrder.filter(k => rec.versions.has(k)), ...rec.order])];
  }
  const any = store.records.size > 0;
  if (standalone) store.layout = formats.has(2) ? 'standalone-v18' : any ? 'standalone-flat' : 'none';
  else if (formats.has(2)) store.layout = 'v18';
  else if (formats.has(1)) store.layout = 'v17';
  else if (any) store.layout = 'published';
  const step = manifest.artifacts && typeof manifest.artifacts === 'object' && !Array.isArray(manifest.artifacts) ? manifest.artifacts : null;
  store.listed = standalone ? (Number.isFinite(manifest.listed) ? manifest.listed : null) : step && Number.isFinite(step.listed) ? step.listed : null;
  // As the extension: claude.ai's list is in an Export Artifacts, and in an Export All whose manifest has the artifact
  // step's block (a merge writes one when a source had the list); a record saying listed doesn't make it so.
  store.listFetched = standalone || !!step;
  return store;
}

// A preview payload ({ texts: [[path, text]], images: [[path, dataUri]] }) from files on disk ([{ path, abs }]), as
// fetchPublishedFiles in popup.js collects one: the start file first, PREVIEW_ITEM_MAX each and PREVIEW_TOTAL_MAX in all
// of each kind (previewKind). null when there is nothing to show.
function payloadFromDisk(files, start) {
  const texts = [];
  const images = [];
  let textBytes = 0;
  let imageBytes = 0;
  const decoder = new TextDecoder();
  // The start file first, then a Design canvas's layout (project/canvas.json) and its boards, then the rest.
  for (const f of files.slice().sort((a, b) => core.previewRank(a.path, start) - core.previewRank(b.path, start))) {
    const kind = core.previewKind(f.path);
    if (!kind || !f.abs) continue;
    let bytes;
    try {
      if (fs.statSync(f.abs).size > core.PREVIEW_ITEM_MAX) continue;
      bytes = fs.readFileSync(f.abs);
    } catch (e) { continue; }
    if (bytes.length > core.PREVIEW_ITEM_MAX) continue;
    if (kind === 'text') {
      if (textBytes + bytes.length > core.PREVIEW_TOTAL_MAX) continue;
      textBytes += bytes.length;
      texts.push([f.path, decoder.decode(bytes)]);
    } else {
      if (imageBytes + bytes.length > core.PREVIEW_TOTAL_MAX) continue;
      imageBytes += bytes.length;
      images.push([f.path, `data:${kind};base64,${bytes.toString('base64')}`]);
    }
  }
  return texts.length || images.length ? { texts, images } : null;
}

// A version's files as the viewer reaches them: saved in its folder, or a chat's own file (sameAs). [{ path, abs }]
const versionDiskFiles = v => (v.folder ? v.files.map(f => ({ path: f.path, abs: f.abs }))
  : v.sameAs ? v.files.map(f => ({ path: f.path, abs: v.sameAsAbs && v.sameAsAbs[f.path] || null })) : []);

// A pre-1.17 or 1.17 version no copy was saved of, which a chat in the archive wrote the same (published.json's
// publishedIn: same, writtenAs): that chat's file, as 1.18 points at it (sameAs). chatFolders: chat uuid -> its folder
// (archive-relative, '' for a single chat).
function sameFromChats(store, v, chatFolders) {
  if (v.folder || v.sameAs || v.files.length !== 1 || !(chatFolders instanceof Map)) return v;
  for (const p of v.publishedIn) {
    if (!p.same || !p.writtenAs || !chatFolders.has(p.chat)) continue;
    const at = chatFolders.get(p.chat);
    const rel = `${at ? `${at}/` : ''}artefacts/${p.writtenAs}`;
    const abs = realFileUnder(store.root, rel);
    if (abs) return { ...v, sameAs: { [v.files[0].path]: rel }, sameAsAbs: { [v.files[0].path]: abs } };
  }
  return v;
}

// artifact.json format 2 from a disk record (readArtifactStore's DiskRec, or one merge_archives builds), with the same
// keys in the same order as popup.js's artifactJsonV2 (a test runs both on one input). A version's folder is its
// archive-relative folder, written as its name inside the artifact folder; savedAs and startSaved only for a version
// with a folder. The claude.ai link is rebuilt from the short id, so nothing else read from disk becomes the link.
function artifactJsonV2FromDisk(rec) {
  const m = rec.meta || {};
  const versions = {};
  for (const ver of rec.order) {
    const v = rec.versions.get(ver);
    if (!v) continue;
    const folder = typeof v.folder === 'string' && v.folder ? v.folder.split('/').pop() : null;
    const out = {
      folder,
      files: (Array.isArray(v.files) ? v.files : []).map(f => ({
        path: f.path, savedAs: folder && typeof f.savedAs === 'string' ? f.savedAs : null, size: Number.isFinite(f.size) ? f.size : null,
        contentType: typeof f.contentType === 'string' ? f.contentType : null, sha256: typeof f.sha256 === 'string' ? f.sha256 : null, verified: f.verified !== false,
      })),
      start: v.start || null, startSaved: folder && v.startSaved || null, incomplete: !!v.incomplete,
      missing: Array.isArray(v.missing) ? v.missing.slice() : [], saved: !!folder && !!v.saved,
      ...(folder && typeof v.zip === 'string' && v.zip === `${folder}.zip` ? { zip: v.zip } : {}),
    };
    if (v.sameAs && typeof v.sameAs === 'object' && Object.keys(v.sameAs).length) out.sameAs = { ...v.sameAs };
    out.publishedIn = (Array.isArray(v.publishedIn) ? v.publishedIn : []).map(p => ({
      chat: p.chat, messageUuid: p.messageUuid, toolUseId: p.toolUseId, same: !!p.same, writtenAs: typeof p.writtenAs === 'string' ? p.writtenAs : null,
    }));
    versions[ver] = out;
  }
  return {
    format: 2, uuid: rec.uuid, shortId: rec.shortId, url: `https://claude.ai/artifact/${rec.shortId || rec.uuid}`, title: str(rec.title), typeTitle: str(m.typeTitle),
    sourceSurface: str(m.sourceSurface), rel: str(m.rel), public: m.public === true, createdAt: str(m.createdAt), updatedAt: str(m.updatedAt),
    listed: rec.listed === true, current: typeof rec.current === 'string' && rec.current ? rec.current : null,
    start: m.start || null, needsRuntime: !!m.needsRuntime, note: str(m.note),
    ...(typeof rec.thumbRel === 'string' && rec.thumbRel ? { thumb: rec.thumbRel } : {}),
    ...(m.incomplete ? { incomplete: true } : {}),
    order: rec.order.filter(ver => rec.versions.has(ver)),
    versions,
  };
}

// The Artifacts screen's data from a store (readArtifactStore), the same the extension writes:
//   views: an ArtifactView (export-core.js artifactView) per artifact claude.ai listed, with thumb (its card picture,
//          viewer-files/thumbs/<name>, when on disk), ver (its current version) and sourceSurface; part and key are the
//          caller's (CTViewer.artifactViewParts), from payloads[i]
//   payloads: the current version's preview payload per view, or null
//   records: one per artifact folder, as buildViewerData takes them: artifact.json (format 2) with dir, versionOrder
//          and versionPlaces ({ <ver>: { folder } }, where each version's files are)
//   versionPayloads: [{ uuid, ver, payload, startKind }], the other saved versions' previews (the menu of versions)
// chatFolders: chat uuid -> its folder, for an older version a chat wrote the same.
function artifactViewsFromDisk(store, chatFolders = new Map()) {
  const views = [];
  const payloads = [];
  const records = [];
  const versionPayloads = [];
  for (const rec of store.records.values()) {
    const versions = new Map([...rec.versions].map(([ver, v]) => [ver, sameFromChats(store, v, chatFolders)]));
    const m = rec.meta;
    const currentKey = rec.current && versions.has(rec.current) ? rec.current : rec.format === 1 && !rec.current && versions.has('current') ? 'current' : null;
    // The artifact folder's record: format 2, with where each version is.
    const places = {};
    for (const ver of rec.order) {
      const v = versions.get(ver);
      if (v.folder) places[ver] = { folder: v.folder };
      if (ver !== currentKey && store.layout !== 'standalone-v18' && store.layout !== 'standalone-flat') {
        const payload = payloadFromDisk(versionDiskFiles(v), v.start);
        if (payload) versionPayloads.push({ uuid: rec.uuid, ver, payload, startKind: core.artifactStartKind(v.start) });
      }
    }
    records.push({ ...artifactJsonV2FromDisk({ ...rec, versions }), dir: rec.dir, versionOrder: rec.order.slice(), versionPlaces: places });
    if (!rec.listed) continue;

    // The view, as saveArtifact in popup.js builds it from the version it saved (or the chats did).
    const shared = core.isSharedArtifact(m.rel);
    const docs = core.isClaudeDocsArtifact({ typeSlug: '', typeTitle: m.typeTitle });
    const note = shared ? m.note.replace(/^shared with you(; |$)/, '') : m.note;
    const cv = currentKey ? versions.get(currentKey) : null;
    let folder = rec.dir;
    let files = [];
    let missing = [];
    let startSaved = null;
    let reused = false;
    let payload = null;
    if (cv) {
      files = cv.files;
      missing = cv.missing;
      if (cv.folder) {
        folder = cv.folder;
        startSaved = cv.startSaved;
      } else if (cv.sameAs) {
        reused = true;
        files = cv.files.map(f => ({ ...f, savedAs: cv.sameAs[f.path] || null }));
        startSaved = m.start ? cv.sameAs[m.start] || null : null;
      }
      payload = payloadFromDisk(versionDiskFiles(cv), m.start);
    }
    const startFile = m.start ? files.find(f => f.path === m.start) : null;
    let startSize = startFile && Number.isFinite(startFile.size) ? startFile.size : null;
    if (startSize == null && startFile && startFile.abs) { try { startSize = fs.statSync(startFile.abs).size; } catch (e) { startSize = null; } }
    const view = core.artifactView({
      uuid: rec.uuid, shortId: rec.shortId, url: `https://claude.ai/artifact/${rec.shortId || rec.uuid}`, title: rec.title,
      // artifact.json keeps claude.ai's type name, not its id: a typed artifact is one with a type name, other than Docs.
      typeSlug: !docs && m.typeTitle ? 'typed' : '', typeTitle: m.typeTitle, shared, foreign: core.artifactForeign(m.rel, true), public: m.public, docs,
      createdAt: m.createdAt, updatedAt: m.updatedAt, folder, files, missing, start: m.start, startSaved, startSize, needsRuntime: m.needsRuntime,
      notExported: /(^|; )not exported/.test(note), note,
      inPayload: !!(m.start && payload && (payload.texts.some(t => t[0] === m.start) || payload.images.some(t => t[0] === m.start))), reused,
      zip: cv && cv.folder && typeof cv.zip === 'string' && cv.zip ? `${rec.dir}/${cv.zip}` : null,
    });
    // Export All's views also carry the current version and claude.ai's source line (popup.js combinedViews).
    const standalone = store.layout === 'standalone-v18' || store.layout === 'standalone-flat';
    views.push({ ...view, thumb: rec.thumbRel || null, ...(standalone ? {} : { ver: rec.current || '', sourceSurface: m.sourceSurface }) });
    payloads.push(payload);
  }
  return { views, payloads, records, versionPayloads };
}

// The pages this chat published, as savePublishedPages in popup.js returns them (PublishedEntry), from the
// published.json files it wrote. Only versions this chat published (publishedIn) are kept, and their publishes
// come from the chat itself (publishedPagesOf). A page or version with no published.json (its info call failed)
// still gets an entry, with nothing to link. artifacts: the chat's artefact text as on disk; diskName: the disk
// spelling of an artefact name.
function publishedFromDisk(archive, chat, data, artifacts, diskName, store) {
  const found = core.publishedPagesOf(data);
  if (!found.length) return [];
  const byUuid = new Map();
  for (const p of found) {
    if (!byUuid.has(p.uuid)) byUuid.set(p.uuid, []);
    byUuid.get(p.uuid).push(p);
  }
  const onDisk = publishedOnDisk(archive, chat, store);
  const limit = CTViewer.TEXT_EMBED_LIMIT;
  const entries = [];
  for (const [uuid, group] of byUuid) {
    const disk = onDisk.get(uuid) || null;
    const json = disk ? disk.json : null;
    const shortId = SHORT_ID.test(group[0].shortId || '') ? group[0].shortId : '';
    const publishes = group.flatMap(p => p.publishes);
    const covered = new Set();
    const versions = [];
    let lastOrder = 0;
    for (const [folderName, v] of Object.entries(json ? json.versions : {})) {
      if (!v || typeof v !== 'object') continue;
      const mine = (Array.isArray(v.publishedIn) ? v.publishedIn : []).filter(p => p && p.chat === data.uuid);
      const ids = new Set(mine.map(p => p.toolUseId));
      const its = publishes.filter(p => ids.has(p.toolUseId) && !covered.has(p.toolUseId));
      if (!its.length) continue;
      for (const p of its) covered.add(p.toolUseId);
      const own = mine.find(p => p.toolUseId === its[0].toolUseId);
      const order = Number.isFinite(v.order) ? v.order : 0;
      lastOrder = Math.max(lastOrder, order);
      const startSaved = typeof v.startSaved === 'string' && v.startSaved ? v.startSaved : null;
      const writtenAs = own.same && typeof own.writtenAs === 'string' && own.writtenAs ? diskName(own.writtenAs) : null;
      const base = { ver: typeof v.ver === 'string' ? v.ver : '', folderName, label: String(v.label || ''), order, publishes: its.map(p => ({ ...p })) };
      if (writtenAs) {
        const text = Object.prototype.hasOwnProperty.call(artifacts, writtenAs) && typeof artifacts[writtenAs] === 'string' && artifacts[writtenAs] !== '' ? artifacts[writtenAs] : null;
        versions.push({ ...base, start: typeof v.start === 'string' ? v.start : null, startSaved, same: true, writtenAs, incomplete: false,
          needsRuntime: needsRuntime(text), text: text !== null && text.length <= limit ? text : null });
        continue;
      }
      // Stored here, with its start file: the files were saved and the start file is on disk.
      // The version folder itself must be a real folder: a link to somewhere else is never read.
      const versionDir = !folderName.includes('/') ? realDirUnder(disk.abs, folderName) : null;
      const startFile = v.saved === true && startSaved && versionDir ? realFileUnder(versionDir, startSaved) : null;
      if (!startFile) {
        versions.push({ ...base, start: null, startSaved: null, same: false, writtenAs: null, incomplete: true, needsRuntime: !!v.needsRuntime, text: null });
        continue;
      }
      const listed = (Array.isArray(v.files) ? v.files : []).find(f => f && f.savedAs === startSaved) || {};
      const isText = core.isTextFile(String(listed.path || startSaved)) || /^text\//i.test(String(listed.contentType || ''));
      let text = null;
      if (isText) {
        try { if (fs.statSync(startFile).size <= limit * 4) text = readText(startFile); } catch (e) { text = null; }
      }
      versions.push({ ...base, start: typeof v.start === 'string' ? v.start : null, startSaved, same: false, writtenAs: null, incomplete: !!v.incomplete,
        needsRuntime: !!v.needsRuntime, text: text !== null && text.length <= limit ? text : null });
    }
    // Versions whose info call failed: in no published.json. As the export lists them: named ones, then the current one.
    for (const p of group) {
      const its = p.publishes.filter(x => !covered.has(x.toolUseId));
      if (!its.length) continue;
      const order = (json ? lastOrder + 1 : 0) + (p.current ? 1 : 0);
      versions.push({ ver: p.ver, folderName: p.ver ? core.publishedSegment(p.ver) : 'current', label: p.ver || 'current', order, start: null, startSaved: null,
        same: false, writtenAs: null, incomplete: true, needsRuntime: false, text: null, publishes: its.map(x => ({ ...x })) });
    }
    versions.sort((a, b) => a.order - b.order);
    const url = json && typeof json.url === 'string' && PAGE_URL.test(json.url) ? json.url : (shortId ? `https://claude.ai/artifact/${shortId}` : '');
    const title = json && typeof json.title === 'string' ? json.title : String(group[0].title || '');
    entries.push({ uuid, shortId, title, url, current: group.some(p => p.current), dir: disk ? disk.dir : '', versions });
  }
  return entries;
}

// Rebuilds one chat's viewer data from its folder, the same ctx populateConversationFolder builds.
// Returns { viewerChat, missing, warnings }. Throws only when original.json can't be read or parsed.
// store: the archive's readArtifactStore, read once by the caller; without it the chat reads it (and its warnings).
function chatFromDisk(archive, chat, store = null) {
  const data = readChatJson(chat.dir);
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.chat_messages)) {
    throw new NotAChat('not a Claude chat');
  }
  const warnings = [];
  const missing = [];
  for (const name of ['artefacts', 'uploads', 'project']) {
    const s = lstat(path.join(chat.dir, name));
    if (s && s.isSymbolicLink()) warnings.push(`${name}/ is a link to another folder, so it was not read`);
  }
  // The shared projects/ folder of a mega-archive (or beside a chat), unless it is a link out of the archive.
  const realProjects = p => { const s = lstat(p); return !!s && s.isDirectory(); };
  // An odd shape in one extractor costs that detail, never the chat.
  const safe = (label, fallback, fn) => {
    try { return fn(); } catch (e) { warnings.push(`${label}: ${e.message}`); return fallback; }
  };

  const artifactIndex = {};
  const artifacts = safe('artifacts', {}, () => core.extractArtifacts(data, null, artifactIndex));

  // Names taken before the disk is looked at: the export picks delivered-file names around these.
  const takenNames = Object.keys(artifacts);

  // artefacts/: text on disk wins over the replay (inlined uploads, replay_bash.py results); binaries are ''.
  // Names are compared as NFC (a Mac may hand back a decomposed spelling), and the disk spelling is the one used.
  const artefactNames = fileNames(path.join(chat.dir, 'artefacts'));
  const diskByNfc = new Map();
  for (const name of artefactNames) if (!diskByNfc.has(nfc(name))) diskByNfc.set(nfc(name), name);
  const diskName = name => diskByNfc.get(nfc(name)) || name;
  for (const key of Object.keys(artifacts)) if (diskName(key) !== key) delete artifacts[key];
  // A name isTextFile doesn't know (flow.mmd, Makefile) keeps the replayed text rather than becoming
  // binary; the export's own viewer has that text too.
  for (const name of artefactNames) {
    const text = core.isTextFile(name) ? readText(path.join(chat.dir, 'artefacts', name)) : null;
    if (text !== null) artifacts[name] = text;
    else if (!(typeof artifacts[name] === 'string' && artifacts[name] !== '')) artifacts[name] = '';
  }
  for (const entry of Object.values(artifactIndex)) {
    if (!entry) continue;
    if (typeof entry.filename === 'string') entry.filename = diskName(entry.filename);
    if (Array.isArray(entry.versions)) entry.versions = entry.versions.map(diskName);
  }

  // Presented files the export downloads when the replay didn't produce them: gone from disk is missing.
  for (const file of safe('presented files', [], () => core.extractPresentedFiles(data))) {
    if (!file.filename || (takenNames.includes(file.filename) && artifacts[diskName(file.filename)])) continue;
    if (diskByNfc.has(nfc(file.filename))) takenNames.push(file.filename);
    else if (!missing.includes(file.filename)) missing.push(file.filename);
  }

  // Deliveries: names are worked out around the taken ones, as the export does, then kept if on disk.
  const delivered = safe('delivered files', [], () => core.extractDeliveredFiles(data, takenNames));
  const savedDeliveries = [];
  for (const file of delivered) {
    if (diskByNfc.has(nfc(file.filename))) savedDeliveries.push({ ...file, filename: diskName(file.filename) });
    else if (!missing.includes(file.filename)) missing.push(file.filename);
  }

  // uploads/: exact matches across the whole chat first, then each looser tier on the files left, so a loose
  // match never takes a file another upload names exactly.
  const uploadNames = fileNames(path.join(chat.dir, 'uploads'));
  const uploads = {};
  const wanted = [];
  const used = new Set();
  for (const file of safe('uploads', [], () => core.extractUploadedFiles(data))) {
    // As the export names them (freeUploadName in popup.js): compared case-insensitively, and a name
    // starting with a dot has no extension.
    const dot = file.filename.lastIndexOf('.');
    const base = dot > 0 ? file.filename.slice(0, dot) : file.filename;
    const ext = dot > 0 ? file.filename.slice(dot) : '';
    let expected = file.filename;
    for (let counter = 1; used.has(expected.toLowerCase()); counter++) expected = `${base}_${counter}${ext}`;
    used.add(expected.toLowerCase());
    wanted.push({ file, expected, found: null });
  }
  let free = uploadNames.slice();
  const tierKey = { 2: looseKey, 3: n => looseKey(unnumbered(n)) };
  const unsure = new Set();  // loose keys several uploads want: no file is given to any of them
  for (let tier = 0; tier <= 3; tier++) {
    if (tierKey[tier]) {
      const wantedBy = new Map();
      for (const w of wanted) if (w.found === null) {
        const k = tierKey[tier](w.expected);
        wantedBy.set(k, (wantedBy.get(k) || 0) + 1);
      }
      for (const [k, count] of wantedBy) if (count > 1 && k) unsure.add(`${tier}:${k}`);
    }
    for (const w of wanted) {
      if (w.found !== null) continue;
      if (tierKey[tier] && unsure.has(`${tier}:${tierKey[tier](w.expected)}`)) continue;
      const hit = matchFile(w.expected, free, tier);
      if (hit === null) continue;
      w.found = hit;
      free = free.filter(n => n !== hit);
    }
  }
  const warnedUnsure = new Set();
  for (const { file, expected, found } of wanted) {
    if (found === null) {
      missing.push(expected);
      const key3 = looseKey(unnumbered(expected));
      const candidates = free.filter(n => looseKey(unnumbered(n)) === key3);
      if (candidates.length > 1) warnings.push(`upload ${expected} matches several files: ${candidates.join(', ')}`);
      else if (candidates.length === 1 && unsure.has(`3:${key3}`) && !warnedUnsure.has(key3)) {
        warnedUnsure.add(key3);
        warnings.push(`several uploads could be ${candidates[0]}, so it was given to none of them`);
      }
      continue;
    }
    uploads[core.viewerUploadKey(file)] = { path: `uploads/${found}`, text: uploadText(path.join(chat.dir, 'uploads', found), found) };
  }

  // Files on Claude's own messages: in artefacts/ since v1.11.0; an older export put them in uploads/ as p<NN>_<name>.
  for (const file of safe('attached files', [], () => core.extractAttachedFiles(data, takenNames))) {
    if (diskByNfc.has(nfc(file.filename))) {
      uploads[file.uuid] = { path: `artefacts/${diskName(file.filename)}`, text: null };
      continue;
    }
    const old = uploadNames.find(n => /^p\d+_/.test(n) && nfc(n.replace(/^p\d+_/, '')) === nfc(file.filename));
    if (old) uploads[file.uuid] = { path: `uploads/${old}`, text: null };
  }

  // images/: web-search images the export saved, named by a hash of their URL (webImageName).
  const imageNames = fileNames(path.join(chat.dir, 'images'));
  const webImages = {};
  for (const img of safe('web images', [], () => core.webImagesOf(data))) {
    const hit = imageNames.find(n => n.startsWith(img.key) && /^[_.]/.test(n.slice(img.key.length)));
    if (hit) webImages[img.url] = `images/${hit}`;
  }

  // Images Claude viewed, saved as images/<first 8 of the uuid>_<name><ext> (toolImageName).
  const toolImages = {};
  for (const img of safe('tool images', [], () => core.toolImagesOf(data))) {
    const key = img.uuid.slice(0, 8);
    const hit = imageNames.find(n => n.startsWith(key) && /^[_.]/.test(n.slice(key.length)));
    if (hit) toolImages[img.uuid] = `images/${hit}`;
  }

  // project: this chat's project/ folder, or the shared projects/<dir> its README links to.
  const projectDir = path.join(chat.dir, 'project');
  const hasProjectDir = isRealDir(projectDir);
  const hasUuid = !!(data.project_uuid || (data.project && data.project.uuid));
  let project = null;
  if (hasUuid || hasProjectDir) {
    let meta = null;
    if (isRealFile(path.join(projectDir, 'project.json'))) {
      try { meta = JSON.parse(stripBom(fs.readFileSync(path.join(projectDir, 'project.json'), 'utf8'))); } catch (e) {
        warnings.push(`project/project.json: ${e.message}`);
      }
    }
    let fileDir = 'project/files';
    const readme = readText(path.join(chat.dir, 'README.md'));
    const link = readme && /\.\.\/projects\/([^/)\s]+)\/files\//.exec(readme);
    if (link) {
      let dir = link[1];
      try { dir = decodeURIComponent(dir); } catch (e) { /* keep it as written */ }
      if (dir !== '.' && dir !== '..' && !/[\\/]/.test(dir)) {
        // A mega whose index.md was removed is read as single chats, so projects/ sits beside the chat folder.
        const rootProjects = path.join(archive.root, 'projects');
        const besideProjects = path.resolve(chat.dir, '..', 'projects');
        const linked = [rootProjects, besideProjects].some(p => { const s = lstat(p); return !!s && s.isSymbolicLink(); });
        const inside = realProjects(rootProjects) && isRealDir(path.join(rootProjects, dir));
        const beside = !inside && archive.kind === 'single' && realProjects(besideProjects) && isRealDir(path.join(besideProjects, dir));
        const shared = inside || beside;
        if (shared) fileDir = `../projects/${dir}/files`;
        if (beside) warnings.push(`project files are in ../projects/${dir}, outside this folder, so the viewer lists them without links`);
        else if (!shared && linked) warnings.push('projects/ is a link to another folder, so it was not read; project files are taken from project/files');
        else if (!shared) warnings.push(`README.md links to projects/${dir}/files, which is not there, so project files are taken from project/files`);
      }
    }
    const docs = {};
    for (const name of fileNames(projectDir)) {
      if (PROJECT_META_FILES.includes(name) || !core.isTextFile(name)) continue;
      const text = readText(path.join(projectDir, name));
      if (text !== null) docs[name] = text;
    }
    const mapping = Object.fromEntries(Object.keys(docs).map(n => [n, n]));
    let instructions = readText(path.join(projectDir, 'prompt_template.md'));
    if (instructions === null) instructions = meta && meta.prompt_template ? core.fixMojibake(String(meta.prompt_template)) : '';
    // The export patches the name into original.json; an older one may only have it in project.json.
    const named = { ...data, project_uuid: data.project_uuid || (data.project && data.project.uuid) || 'project',
      project: { ...(data.project || {}), name: (data.project && data.project.name) || (meta && meta.name) || '' } };
    project = core.viewerProject(named, docs, mapping, fileDir, fileNames(path.resolve(chat.dir, fileDir)), instructions, CTViewer.TEXT_EMBED_LIMIT);
  }

  const viewerChat = CTViewer.buildViewerChat(data, {
    folder: chat.relDir === '.' ? '' : chat.relDir,
    model: CTViewer.modelLabel(data.model, safe('model', 'Claude', () => core.getModelName(data))),
    fixText: core.fixMojibake,
    artifacts,
    artifactIndex,
    uploads,
    webImages,
    toolImages,
    deliveries: core.buildViewerDeliveries(savedDeliveries),
    heredocs: core.heredocFiles,
    docKey: core.claudeDocKey,
    widgetFile: core.widgetFile,
    widgetKey: core.widgetKey,
    project,
    published: safe('published pages', [], () => publishedFromDisk(archive, chat, data, artifacts, diskName, store || readArtifactStore(archive.root, { warnings }))),
    // An older export's viewer had no badges; its errors.txt still names the files that may not match.
    flags: core.viewerFlags(core.warningsFromReport(readText(path.join(chat.dir, 'errors.txt')))),
  });
  return { viewerChat, missing, warnings };
}

module.exports = { readArtifactStore, artifactViewsFromDisk, artifactJsonV2FromDisk, sameFromChats, rewriteChatLinks, realFileUnder, realDirUnder, payloadFromDisk, findArchives, isArchiveRoot, scanAdded, isGeneratedViewer, chatFromDisk, NotAChat, matchFile, stripBom, embeddableText, isAddedText, LEFTOVER_NAME, KNOWN_ROOT_FILES, KNOWN_DIRS, IGNORED_NAMES };
