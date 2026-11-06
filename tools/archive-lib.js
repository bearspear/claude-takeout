// Archive viewer tool, shared library: find Claude Takeout archives on disk and list the files
// the owner added to them. Plain CommonJS, stdlib only. Never follows symlinks.
const fs = require('fs');
const path = require('path');

// ===================================================================
// Export layout (CLAUDE.md section 7)
// ===================================================================

const KNOWN_ROOT_FILES = [
  'README.md', 'meta.md', 'prompts.md', 'responses_text_only.md', 'full_chat.md', 'integrated_chat.md',
  'integrated_chat.txt', 'code_snippets.md', 'links_and_sources.md', 'errors.txt', 'original.json',
  'index.md', 'viewer.html', 'viewer-check.gif',
];
const KNOWN_DIRS = ['responses', 'artefacts', 'attachments', 'uploads', 'project', 'projects', 'viewer-files'];
const IGNORED_NAMES = ['.DS_Store', 'Thumbs.db', '__MACOSX', '.git', 'node_modules'];

const HEAD_BYTES = 64 * 1024;

const isIgnored = name => IGNORED_NAMES.includes(name) || name.startsWith('.');
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function lstat(p) {
  try { return fs.lstatSync(p); } catch (e) { return null; }
}
const isRealFile = p => { const s = lstat(p); return !!s && s.isFile(); };
const isRealDir = p => { const s = lstat(p); return !!s && s.isDirectory(); };

function realOrResolved(p) {
  try { return fs.realpathSync(p); } catch (e) { return path.resolve(p); }
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
      if (hasOriginal) {
        if (isRealFile(path.join(dir, 'conversation.json')) || !looksLikeChat(path.join(dir, 'original.json'))) {
          skipped.push({ path: dir, reason: 'not a Claude chat' });
        } else {
          archives.push({ root: dir, kind: 'single', chats: [{ dir, relDir: '.' }], hasViewer: isRealFile(path.join(dir, 'viewer.html')) });
        }
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
function scanAdded(archive) {
  const out = [];
  const chatRel = new Set(archive.kind === 'mega' ? archive.chats.map(c => c.relDir) : []);

  function addTree(dir, rel, chatDir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (isIgnored(e.name)) continue;
      const p = path.join(dir, e.name);
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) addTree(p, r, chatDir);
      else if (e.isFile()) out.push({ path: r, chatDir, size: fs.lstatSync(p).size });
    }
  }

  function scanLevel(dir, rel, chatDir, skipDirs) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (isIgnored(e.name)) continue;
      const p = path.join(dir, e.name);
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) {
        if (KNOWN_DIRS.includes(e.name) || skipDirs.has(e.name)) continue;
        addTree(p, r, chatDir);
      } else if (e.isFile()) {
        if (KNOWN_ROOT_FILES.includes(e.name)) continue;
        out.push({ path: r, chatDir, size: fs.lstatSync(p).size });
      }
    }
  }

  scanLevel(archive.root, '', null, chatRel);
  for (const c of archive.kind === 'mega' ? archive.chats : []) {
    scanLevel(c.dir, c.relDir, c.relDir, new Set());
  }
  return out.sort((a, b) => byCodeUnit(a.path, b.path));
}

module.exports = { findArchives, scanAdded, isGeneratedViewer, KNOWN_ROOT_FILES, KNOWN_DIRS, IGNORED_NAMES };
