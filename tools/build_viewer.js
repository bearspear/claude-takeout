// Gives older Claude Takeout archives the offline viewer.
//   node tools/build_viewer.js <folder> [--out <folder>] [--force] [--dry-run] [--json]
// Exit code 0 when clean, 1 if anything failed. Writes only viewer.html, viewer-check.gif and viewer-files/
// beside an archive, and new folders under --out. Every other file is the owner's and is never changed:
// new content goes to temp names first, and a target that is already there is left alone unless it is provably ours.
const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const core = require('../export-core.js');
const CTViewer = require('../takeout-viewer.js');
const lib = require('./archive-lib.js');
const zipLib = require('./archive-zip.js'); // called through the module, so tests can stub free space

const PART_LIMIT = 4 * 1024 * 1024;
const PART_OVERHEAD = 64; // the window.__archivePart(n, {...}); around a part's entries
const MISSING_SHOWN = 20;
const VIEWER_FILE = 'viewer.html';
const PARTS_DIR = 'viewer-files';
const USAGE = 'Usage: node tools/build_viewer.js <folder> [--out <folder>] [--force] [--dry-run] [--json]';

const lstat = p => { try { return fs.lstatSync(p); } catch (e) { return null; } };
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ===================================================================
// Added files
// ===================================================================

// The text to embed for an added file, or null when it only gets a link.
function addedText(root, rel, size, warnings) {
  const parts = rel.split('/');
  if (!core.isTextFile(parts[parts.length - 1]) || size > CTViewer.TEXT_EMBED_LIMIT) return null;
  try {
    const text = lib.stripBom(fs.readFileSync(path.join(root, ...parts), 'utf8'));
    return text.length <= CTViewer.TEXT_EMBED_LIMIT ? core.fixMojibake(text) : null;
  } catch (e) {
    warnings.push(`added file ${rel}: ${e.message}`);
    return null;
  }
}

// added: [{ path, chat, size }], paths relative to root. Parts are filled in order and each is handed to
// onPart as soon as it is full, so only one part's text is in memory. With no onPart they come back in parts.
function buildParts(added, { root, onPart } = {}) {
  const parts = [];
  const emit = onPart || (p => parts.push(p));
  const entries = [];
  const warnings = [];
  let pending = [];
  let pendingBytes = 0;
  let count = 0;
  const flush = () => {
    if (!pending.length) return;
    count++;
    emit({ name: `part-${String(count).padStart(4, '0')}.js`, body: `window.__archivePart(${count}, {${pending.join(',')}});` });
    pending = [];
    pendingBytes = 0;
  };
  added.forEach((file, index) => {
    const name = file.path.split('/').pop();
    const text = addedText(root, file.path, file.size, warnings);
    const entry = {
      path: file.path, chat: file.chat == null ? null : file.chat, kind: CTViewer.kindFor(name, null, text !== null),
      size: file.size, href: CTViewer.relHref(file.path), part: null, key: null,
    };
    if (text !== null) {
      const key = String(index);
      const item = `${CTViewer.escapeJson(key)}:${CTViewer.escapeJson(text)}`;
      const bytes = Buffer.byteLength(item) + 1;
      if (pendingBytes + bytes + PART_OVERHEAD > PART_LIMIT) flush();
      pending.push(item);
      pendingBytes += bytes;
      entry.part = count + 1;
      entry.key = key;
    }
    entries.push(entry);
  });
  flush();
  return { entries, parts, warnings, partCount: count };
}

// ===================================================================
// What is at the archive root already
// ===================================================================

const checkGif = () => Buffer.from(CTViewer.VIEWER_CHECK_BASE64, 'base64');

function isOurGif(file, stat) {
  return stat.isFile() && fs.readFileSync(file).equals(checkGif());
}

function isOurParts(dir, stat) {
  if (!stat.isDirectory()) return false;
  return fs.readdirSync(dir, { withFileTypes: true }).every(e =>
    e.isFile() && (/^part-\d{4,}\.js$/.test(e.name) || lib.IGNORED_NAMES.includes(e.name)));
}

// { stop, reason } when this archive gets no viewer, otherwise what may be replaced: { viewer, gif, parts }.
function inspectRoot(root, force) {
  const viewerPath = path.join(root, VIEWER_FILE);
  const gifPath = path.join(root, CTViewer.VIEWER_CHECK_FILE);
  const partsPath = path.join(root, PARTS_DIR);
  const viewer = lstat(viewerPath), gif = lstat(gifPath), parts = lstat(partsPath);

  if (!viewer) {
    const stray = gif ? CTViewer.VIEWER_CHECK_FILE : parts ? PARTS_DIR + '/' : null;
    if (stray) return { stop: 'failed', reason: `${stray} is here with no viewer.html, so it counts as your file and was left alone` };
    return { viewer: false, gif: false, parts: false };
  }
  if (!force) return { stop: 'skipped', reason: 'it already has a viewer.html (--force replaces a generated one)' };
  if (!viewer.isFile() || !lib.isGeneratedViewer(fs.readFileSync(viewerPath, 'utf8'))) {
    return { stop: 'failed', reason: 'viewer.html was not generated by this tool or an export, so --force left it alone' };
  }
  if (gif && !isOurGif(gifPath, gif)) return { stop: 'failed', reason: `${CTViewer.VIEWER_CHECK_FILE} is not the one this tool writes, so it was left alone` };
  if (parts && !isOurParts(partsPath, parts)) return { stop: 'failed', reason: `${PARTS_DIR} holds something this tool did not write, so it was left alone` };
  return { viewer: true, gif: !!gif, parts: !!parts };
}

// ===================================================================
// Writing one archive
// ===================================================================

function collectChats(archive, report) {
  const chats = [];
  const idByDir = new Map();
  for (const chat of archive.chats) {
    try {
      const built = lib.chatFromDisk(archive, chat);
      chats.push(built.viewerChat);
      idByDir.set(chat.relDir, built.viewerChat.id);
      for (const file of built.missing) report.missing.push({ chat: chat.relDir, file });
      for (const w of built.warnings) report.warnings.push(`${chat.relDir}: ${w}`);
    } catch (e) {
      report.failedChats.push({ chat: chat.relDir, reason: e.message });
    }
  }
  return { chats, idByDir };
}

let assets = null;
function viewerHtml(data, fileScripts) {
  assets = assets || CTViewer.VIEWER_ASSETS.map(a => fs.readFileSync(path.join(__dirname, '..', a), 'utf8'));
  const [template, logic, app, marked, katex, css] = assets;
  return CTViewer.assembleViewer({ template, css, marked, katex, logic, app, data, fileScripts });
}

// Exclusive, so a name that is already there is never written to or claimed. temps lists what this run made.
function writeNew(file, data, temps) {
  const fd = fs.openSync(file, 'wx');
  temps.push(file);
  try { fs.writeFileSync(fd, data); } finally { fs.closeSync(fd); }
}

function assertFree(file) {
  if (lstat(file)) throw new Error(`${path.basename(file)} appeared during the run, so it was left alone`);
}

// Puts finished temps in place: parts, gif, then viewer last, so a viewer never points at parts that aren't there.
// Any failure undoes the earlier steps. Old viewer-files/ goes aside first and is deleted only after the new viewer is in.
function install(root, tmp, old, report) {
  const target = name => path.join(root, name);
  const parts = target(PARTS_DIR), gif = target(CTViewer.VIEWER_CHECK_FILE), viewer = target(VIEWER_FILE);
  const aside = target(`${PARTS_DIR}.old-${process.pid}`);
  const undo = [];
  try {
    if (old.parts) {
      assertFree(aside);
      fs.renameSync(parts, aside);
      undo.push(() => fs.renameSync(aside, parts));
    }
    if (tmp.parts) {
      assertFree(parts);
      fs.renameSync(tmp.parts, parts);
      undo.push(() => fs.rmSync(parts, { recursive: true }));
    }
    if (tmp.gif) {
      assertFree(gif);
      fs.renameSync(tmp.gif, gif);
      undo.push(() => fs.unlinkSync(gif));
    }
    if (!old.viewer) assertFree(viewer);
    fs.renameSync(tmp.viewer, viewer);
  } catch (e) {
    for (const step of undo.reverse()) {
      try { step(); } catch (u) { e.message += `; could not undo a step (${u.message})`; }
    }
    throw e;
  }
  if (old.parts) {
    try { fs.rmSync(aside, { recursive: true }); } catch (e) { report.warnings.push(`old parts left at ${aside}: ${e.message}`); }
  }
}

// Never throws: a bad archive is a report, and the run goes on.
function writeViewer(archive, { force = false, dryRun = false } = {}) {
  const report = { root: archive.root, kind: archive.kind, status: 'failed', reason: '', chats: 0, failedChats: [], missing: [], added: 0, warnings: [], dryRun };
  const finish = (status, reason = '') => Object.assign(report, { status, reason });
  const temps = [];
  try {
    const old = inspectRoot(archive.root, force);
    if (old.stop) return finish(old.stop, old.reason);
    if (!archive.chats.length) return finish('skipped', 'no Claude chats in it');

    const { chats, idByDir } = collectChats(archive, report);
    report.chats = chats.length;
    if (!chats.length) return finish('failed', 'no chat could be read, so no viewer was written');

    const scan = lib.scanAdded(archive);
    for (const e of scan.errors) report.warnings.push(`added files, ${e.path || 'archive root'}: ${e.message}`);
    report.added = scan.files.length;
    if (dryRun) return finish('written', old.viewer ? 'would replace the viewer' : '');

    const name = base => path.join(archive.root, `${base}.tmp-${process.pid}`);
    const tmp = { parts: null, gif: null, viewer: name(VIEWER_FILE) };
    const added = scan.files.map(f => ({ path: f.path, size: f.size, chat: idByDir.get(f.chatDir) }));
    const built = buildParts(added, {
      root: archive.root,
      onPart: part => {
        if (!tmp.parts) {
          const dir = name(PARTS_DIR);
          fs.mkdirSync(dir);
          temps.push(dir);
          tmp.parts = dir;
        }
        writeNew(path.join(tmp.parts, part.name), part.body, temps);
      },
    });
    report.warnings.push(...built.warnings);

    const data = CTViewer.buildViewerData(chats, { exported: new Date().toISOString() });
    if (built.entries.length) data.added = built.entries;
    writeNew(tmp.viewer, viewerHtml(data, built.partCount > 0), temps);
    if (!old.gif) {
      tmp.gif = name(CTViewer.VIEWER_CHECK_FILE);
      writeNew(tmp.gif, checkGif(), temps);
    }
    install(archive.root, tmp, old, report);
    return finish('written', old.viewer ? 'replaced the viewer' : '');
  } catch (e) {
    for (const t of temps) {
      try { fs.rmSync(t, { recursive: true, force: true }); } catch (r) { report.warnings.push(`temp left at ${t}: ${r.message}`); }
    }
    return finish('failed', e.message);
  }
}

// ===================================================================
// ZIPs
// ===================================================================

async function processZip(zip, { outDir, force, dryRun, planned }) {
  const entry = { zip, dest: null, status: 'failed', reason: '', chats: 0, space: null, files: 0, rejected: [], archives: [], skipped: [], dryRun };
  const finish = (status, reason = '') => Object.assign(entry, { status, reason });
  try {
    if (!outDir) return finish('failed', 'ZIPs need --out <folder> to extract into');
    entry.dest = path.join(outDir, path.basename(zip).replace(/\.zip$/i, ''));
    if (lstat(entry.dest) || planned.has(entry.dest)) return finish('skipped', `${entry.dest} already exists, so it was left alone`);
    planned.add(entry.dest);

    const names = await zipLib.zipEntryNames(zip);
    entry.chats = names.filter(n => /(^|\/)original\.json$/.test(n)).length;
    if (!entry.chats) return finish('skipped', 'no Claude chat in it');

    entry.space = await zipLib.zipFreeSpaceOk(zip, outDir);
    if (!entry.space.ok) return finish('failed', `not enough free space: needs ${entry.space.needed} bytes, ${entry.space.free} free`);
    if (dryRun) return finish('written', `would extract to ${entry.dest}`);

    const extracted = await zipLib.extractZip(zip, entry.dest);
    entry.files = extracted.files;
    entry.rejected = extracted.rejected;
    const found = lib.findArchives(entry.dest);
    entry.skipped = [...found.skipped, ...found.zips.map(p => ({ path: p, reason: 'a ZIP inside a ZIP is not opened' }))];
    entry.archives = found.archives.map(archive => writeViewer(archive, { force }));
    if (entry.archives.some(a => a.status === 'failed')) return finish('failed', 'a viewer could not be written');
    return entry.archives.length ? finish('written') : finish('skipped', 'extracted, but no Claude chat was found');
  } catch (e) {
    return finish('failed', e.message);
  }
}

// ===================================================================
// The run
// ===================================================================

class UsageError extends Error {}

// Real path of a folder that may not exist yet: its nearest existing ancestor, resolved, plus the rest.
function realPlanned(p) {
  const rest = [];
  let cur = path.resolve(p);
  while (!lstat(cur) && path.dirname(cur) !== cur) {
    rest.unshift(path.basename(cur));
    cur = path.dirname(cur);
  }
  return path.join(fs.realpathSync(cur), ...rest);
}

const isFolder = p => { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } };

async function run(folder, { out = null, force = false, dryRun = false } = {}) {
  const input = path.resolve(folder);
  if (!isFolder(input)) throw new UsageError(`Not a folder: ${input}`);

  let outDir = null;
  const exclude = [];
  if (out) {
    outDir = path.resolve(out);
    const realIn = fs.realpathSync(input);
    const realOut = realPlanned(outDir);
    if (realIn === realOut || realIn.startsWith(realOut + path.sep)) throw new UsageError(`--out can't be the folder being scanned, or hold it: ${outDir}`);
    if (lstat(outDir) && !isFolder(outDir)) throw new UsageError(`--out is not a folder: ${outDir}`);
    if (!dryRun) fs.mkdirSync(outDir, { recursive: true });
    exclude.push(realOut);
  }

  const found = lib.findArchives(input, { exclude });
  const archives = found.archives.map(archive => writeViewer(archive, { force, dryRun }));
  const zips = [];
  const planned = new Set();
  for (const zip of found.zips) zips.push(await processZip(zip, { outDir, force, dryRun, planned }));

  const every = [...archives, ...zips.flatMap(z => z.archives)];
  const ok = !every.some(a => a.status === 'failed' || a.failedChats.length) && !zips.some(z => z.status === 'failed');
  return { folder: input, out: outDir, force, dryRun, ok, archives, zips, skipped: found.skipped };
}

function archiveLine(a) {
  const label = a.status === 'written' && a.dryRun ? 'would write' : a.status;
  const facts = [];
  if (a.chats) facts.push(plural(a.chats, 'chat'));
  if (a.failedChats.length) facts.push(`${a.failedChats.length} failed`);
  if (a.added) facts.push(`${a.added} added`);
  if (a.missing.length) facts.push(`${a.missing.length} missing`);
  if (a.warnings.length) facts.push(plural(a.warnings.length, 'warning'));
  return `${label}: ${a.root}${facts.length ? ` (${facts.join(', ')})` : ''}${a.reason ? `: ${a.reason}` : ''}`;
}

function zipLine(z) {
  const label = z.status === 'written' && z.dryRun ? 'would write' : z.status;
  const facts = z.rejected.length ? ` (${z.rejected.length} entries refused)` : '';
  return `${label}: ${z.zip}${facts}${z.reason ? `: ${z.reason}` : ''}`;
}

function formatReport(report) {
  const lines = [...report.archives.map(archiveLine)];
  for (const z of report.zips) {
    lines.push(zipLine(z));
    for (const a of z.archives) lines.push(archiveLine(a));
  }
  const every = [...report.archives, ...report.zips.flatMap(z => z.archives)];

  const failed = every.filter(a => a.failedChats.length);
  if (failed.length) lines.push('', 'Failed chats:');
  for (const a of failed) {
    lines.push(`  ${a.root}:`);
    for (const c of a.failedChats) lines.push(`    ${c.chat}: ${c.reason}`);
  }

  const missing = every.filter(a => a.missing.length);
  if (missing.length) lines.push('', 'Missing files:');
  for (const a of missing) {
    lines.push(`  ${a.root} (${a.missing.length}):`);
    for (const m of a.missing.slice(0, MISSING_SHOWN)) lines.push(`    ${m.chat === '.' ? m.file : `${m.chat}/${m.file}`}`);
    if (a.missing.length > MISSING_SHOWN) lines.push(`    ... and ${a.missing.length - MISSING_SHOWN} more`);
  }

  const skipped = [...report.skipped, ...report.zips.flatMap(z => z.skipped)];
  if (skipped.length) lines.push('', 'Skipped:');
  for (const s of skipped) lines.push(`  ${s.path}: ${s.reason}`);

  if (!report.archives.length && !report.zips.length) lines.unshift(`No Claude archives found in ${report.folder}`);
  return lines.join('\n');
}

async function main(argv) {
  const json = argv.includes('--json');
  const fail = message => {
    if (json) console.log(JSON.stringify({ ok: false, error: message }));
    console.error(message);
    return 1;
  };
  let args;
  try {
    args = parseArgs({ args: argv, allowPositionals: true, options: {
      out: { type: 'string' }, force: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, json: { type: 'boolean' },
    } });
  } catch (e) {
    return fail(`${e.message}\n${USAGE}`);
  }
  if (args.positionals.length !== 1) return fail(USAGE);
  const { out, force, 'dry-run': dryRun } = args.values;
  try {
    const report = await run(args.positionals[0], { out, force: !!force, dryRun: !!dryRun });
    console.log(json ? JSON.stringify(report) : formatReport(report));
    return report.ok ? 0 : 1;
  } catch (e) {
    return fail(e.message);
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; });
}

module.exports = { writeViewer, buildParts, run, formatReport, PART_LIMIT };
