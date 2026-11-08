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
const KNOWN_DIRS = ['responses', 'artefacts', 'attachments', 'uploads', 'project', 'projects', 'viewer-files'];
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

// True when dir is an archive as findArchives sees one: a chat, or index.md beside a chat folder.
function isArchiveRoot(dir) {
  if (isRealFile(path.join(dir, 'original.json'))) return true;
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
      if (e.isDirectory()) {
        if (KNOWN_DIRS.includes(e.name) || skipDirs.has(e.name)) continue;
        addTree(p, r, chatDir);
      } else if (e.isFile()) {
        // index.md is the export's only at a mega root; anywhere else it is the owner's.
        const known = KNOWN_ROOT_FILES.includes(e.name) && (e.name !== 'index.md' || (archive.kind === 'mega' && dir === archive.root));
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

// Rebuilds one chat's viewer data from its folder, the same ctx populateConversationFolder builds.
// Returns { viewerChat, missing, warnings }. Throws only when original.json can't be read or parsed.
function chatFromDisk(archive, chat) {
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
    deliveries: core.buildViewerDeliveries(savedDeliveries),
    heredocs: core.heredocFiles,
    docKey: core.claudeDocKey,
    project,
    // An older export's viewer had no badges; its errors.txt still names the files that may not match.
    flags: core.viewerFlags(core.warningsFromReport(readText(path.join(chat.dir, 'errors.txt')))),
  });
  return { viewerChat, missing, warnings };
}

module.exports = { findArchives, isArchiveRoot, scanAdded, isGeneratedViewer, chatFromDisk, NotAChat, matchFile, stripBom, embeddableText, isAddedText, LEFTOVER_NAME, KNOWN_ROOT_FILES, KNOWN_DIRS, IGNORED_NAMES };
