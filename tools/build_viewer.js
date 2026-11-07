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
const PART_HEAD = 'window.__archivePart(';
const SYSTEM_JUNK = ['.DS_Store', 'Thumbs.db'];
const LIST_SHOWN = 20;
const VIEWER_FILE = 'viewer.html';
const PARTS_DIR = 'viewer-files';
const USAGE = 'Usage: node tools/build_viewer.js <folder> [--out <folder>] [--force] [--dry-run] [--json]';

const lstat = p => { try { return fs.lstatSync(p); } catch (e) { return null; } };
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const isInside = (p, dir) => p === dir || p.startsWith(dir + path.sep);

// ===================================================================
// Stopping
// ===================================================================

// Set by SIGINT and SIGTERM. A handler only runs when the event loop does, so long loops call stopPoint.
const stop = { requested: false };
class Stopped extends Error {
  constructor() { super('stopped by a signal, so no viewer was written'); }
}
const breathe = () => new Promise(resolve => setImmediate(resolve));
async function stopPoint() {
  await breathe();
  if (stop.requested) throw new Stopped();
}

// ===================================================================
// Added files
// ===================================================================

// isTextFile leaves .mmd out, and exports keep to it.
const isAddedText = name => core.isTextFile(name) || /\.mmd$/i.test(name);

// The text to embed for an added file, or null when it only gets a link.
function addedText(root, rel, size, warnings) {
  const parts = rel.split('/');
  if (!isAddedText(parts[parts.length - 1]) || size > CTViewer.TEXT_EMBED_LIMIT) return null;
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
async function buildParts(added, { root, onPart } = {}) {
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
  for (const [index, file] of added.entries()) {
    await stopPoint();
    const name = file.path.split('/').pop();
    const text = addedText(root, file.path, file.size, warnings);
    const entry = {
      path: file.path, chat: file.chat == null ? null : file.chat, kind: CTViewer.kindFor(name, null, isAddedText(name)),
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
  }
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

function startsLikePart(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(PART_HEAD.length);
    const n = fs.readSync(fd, head, 0, head.length, 0);
    return head.toString('utf8', 0, n) === PART_HEAD;
  } finally { fs.closeSync(fd); }
}

// --force deletes this folder, so a name alone isn't enough: a part has to be one by content too.
function isOurParts(dir, stat) {
  if (!stat.isDirectory()) return false;
  return fs.readdirSync(dir, { withFileTypes: true }).every(e => e.isFile() && (SYSTEM_JUNK.includes(e.name) ||
    (/^part-\d{4,}\.js$/.test(e.name) && startsLikePart(path.join(dir, e.name)))));
}

// { stop, reason } when this archive gets no viewer, otherwise what may be replaced: { viewer, gif, parts }.
function inspectRoot(root, force) {
  const viewerPath = path.join(root, VIEWER_FILE);
  const gifPath = path.join(root, CTViewer.VIEWER_CHECK_FILE);
  const partsPath = path.join(root, PARTS_DIR);
  const viewer = lstat(viewerPath), gif = lstat(gifPath), parts = lstat(partsPath);

  if (!viewer) {
    const stray = gif ? CTViewer.VIEWER_CHECK_FILE : parts ? PARTS_DIR + '/' : null;
    // Our own gif left behind by a deleted viewer.html is no one's file: it is rewritten with the viewer.
    if (gif && !parts && isOurGif(gifPath, gif)) return { viewer: false, gif: true, parts: false };
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

async function collectChats(archive, report) {
  const chats = [];
  const idByDir = new Map();
  for (const chat of archive.chats) {
    await stopPoint();
    try {
      const built = lib.chatFromDisk(archive, chat);
      chats.push(built.viewerChat);
      idByDir.set(chat.relDir, built.viewerChat.id);
      for (const file of built.missing) report.missing.push({ chat: chat.relDir, file });
      for (const w of built.warnings) report.warnings.push(`${chat.relDir}: ${w}`);
    } catch (e) {
      if (e instanceof lib.NotAChat) report.skippedChats.push({ path: chat.dir, reason: 'not a Claude chat' });
      else report.failedChats.push({ chat: chat.relDir, reason: e.message });
    }
  }
  return { chats, idByDir };
}

let assets = null;
function viewerHtml(data, policy) {
  assets = assets || CTViewer.VIEWER_ASSETS.map(a => fs.readFileSync(path.join(__dirname, '..', a), 'utf8'));
  const [template, logic, app, marked, katex, css, highlight] = assets;
  return CTViewer.assembleViewer({ template, css, marked, katex, highlight, logic, app, data, ...policy });
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
    // Looked at again: nothing else here deletes what was there before the run, and it may have been long.
    try {
      if (isOurParts(aside, fs.lstatSync(aside))) fs.rmSync(aside, { recursive: true });
      else report.notices.push(`Old viewer parts kept at ${aside}: something else is in that folder now`);
    } catch (e) { report.notices.push(`Old viewer parts left at ${aside}: ${e.message}`); }
  }
}

// Never rejects: a bad archive is a report, and the run goes on.
async function writeViewer(archive, { force = false, dryRun = false } = {}) {
  const report = { root: archive.root, kind: archive.kind, status: 'failed', reason: '', chats: 0, failedChats: [], skippedChats: [], missing: [], added: 0, notices: [], warnings: [], dryRun };
  const finish = (status, reason = '') => Object.assign(report, { status, reason });
  const temps = [];
  try {
    await stopPoint();
    for (const name of fs.readdirSync(archive.root)) {
      if (lib.LEFTOVER_NAME.test(name)) report.notices.push(`Left alone, from an interrupted run: ${name}`);
    }
    // Before any early return: these need seeing whether or not this archive gets a viewer.
    const scan = lib.scanAdded(archive);
    for (const e of scan.errors) report.warnings.push(`added files, ${e.path || 'archive root'}: ${e.message}`);
    for (const f of scan.files) {
      if (path.posix.basename(f.path) === 'original.json') {
        report.notices.push(`Another export is inside this archive at ${path.posix.dirname(f.path)}; run the tool on that folder.`);
      }
    }
    report.added = scan.files.length;

    const old = inspectRoot(archive.root, force);
    if (old.stop) return finish(old.stop, old.reason);
    if (!archive.chats.length) return finish('skipped', 'no Claude chats in it');

    const { chats, idByDir } = await collectChats(archive, report);
    report.chats = chats.length;
    if (!chats.length && report.skippedChats.length && !report.failedChats.length) return finish('skipped', 'no Claude chats in it');
    if (!chats.length) return finish('failed', 'no chat could be read, so no viewer was written');

    if (dryRun) return finish('written', old.viewer ? 'would replace the viewer' : '');

    const name = base => path.join(archive.root, `${base}.tmp-${process.pid}`);
    const tmp = { parts: null, gif: null, viewer: name(VIEWER_FILE) };
    const added = scan.files.map(f => ({ path: f.path, size: f.size, chat: idByDir.get(f.chatDir) }));
    const built = await buildParts(added, {
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
    writeNew(tmp.viewer, viewerHtml(data, { fileScripts: built.partCount > 0, fileMedia: built.entries.length > 0 }), temps);
    if (!old.gif) {
      tmp.gif = name(CTViewer.VIEWER_CHECK_FILE);
      writeNew(tmp.gif, checkGif(), temps);
    }
    await stopPoint();
    install(archive.root, tmp, old, report); // no stop point inside: it runs to the end or undoes itself
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

async function processZip(zip, { outDir, force, dryRun, claims }) {
  const entry = { zip, dest: null, status: 'failed', reason: '', chats: 0, space: null, files: 0, rejected: [], archives: [], skipped: [], dryRun };
  const finish = (status, reason = '') => Object.assign(entry, { status, reason });
  try {
    if (!outDir) return finish('failed', 'ZIPs need --out <folder> to extract into');
    entry.dest = path.join(outDir, path.basename(zip).replace(/\.zip$/i, ''));

    const names = await zipLib.zipEntryNames(zip);
    entry.chats = names.filter(n => /(^|\/)original\.json$/.test(n)).length;
    if (!entry.chats) return finish('skipped', 'no Claude chat in it');

    // Every ZIP with a chat in it holds its name, on every run, so a clash shows even once the folder exists.
    // Case folds, as it does on a Mac.
    const claim = entry.dest.normalize('NFC').toLowerCase();
    if (claims.has(claim)) return finish('failed', `it extracts to the same folder as ${claims.get(claim)}: ${entry.dest}. Rename one ZIP.`);
    claims.set(claim, zip);
    if (lstat(entry.dest)) return finish('skipped', `${entry.dest} already exists, so it was left alone. To give it a viewer, run the tool on that folder.`);

    entry.space = await zipLib.zipFreeSpaceOk(zip, outDir);
    if (!entry.space.ok) return finish('failed', `not enough free space: needs ${entry.space.needed} bytes, ${entry.space.free} free`);
    if (dryRun) return finish('written', `would extract to ${entry.dest}`);

    await stopPoint();
    const extracted = await zipLib.extractZip(zip, entry.dest);
    entry.files = extracted.files;
    entry.rejected = extracted.rejected;
    const found = lib.findArchives(entry.dest);
    entry.skipped = [...found.skipped, ...found.zips.map(p => ({ path: p, reason: 'a ZIP inside a ZIP is not opened' }))];
    for (const archive of found.archives) {
      if (stop.requested) break;
      entry.archives.push(await writeViewer(archive, { force }));
    }
    entry.skipped.push(...entry.archives.flatMap(a => a.skippedChats));
    if (stop.requested) return finish('failed', `stopped by a signal, after it was extracted to ${entry.dest}. To finish, run the tool on that folder.`);
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
  return path.join(fs.realpathSync.native(cur), ...rest);
}

const isFolder = p => { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } };

async function run(folder, { out = null, force = false, dryRun = false } = {}) {
  const input = path.resolve(folder);
  if (!isFolder(input)) throw new UsageError(`Not a folder: ${input}`);

  let outDir = null;
  const exclude = [];
  if (out) {
    outDir = path.resolve(out);
    const realIn = fs.realpathSync.native(input);
    const realOut = realPlanned(outDir);
    if (isInside(realIn, realOut)) throw new UsageError(`--out can't be the folder being scanned, or hold it: ${outDir}`);
    if (lstat(outDir) && !isFolder(outDir)) throw new UsageError(`--out is not a folder: ${outDir}`);
    // Extracting there would add to an archive, wherever it is.
    for (let dir = realOut; ; dir = path.dirname(dir)) {
      if (lib.isArchiveRoot(dir)) throw new UsageError(`--out can't be inside an archive: ${dir}`);
      if (path.dirname(dir) === dir) break;
    }
    if (!dryRun) fs.mkdirSync(outDir, { recursive: true });
    exclude.push(realOut);
  }

  const found = lib.findArchives(input, { exclude });
  const archives = [];
  const zips = [];
  const notRun = [];
  const claims = new Map();
  for (const archive of found.archives) {
    await breathe();
    if (stop.requested) notRun.push(archive.root);
    else archives.push(await writeViewer(archive, { force, dryRun }));
  }
  for (const zip of found.zips) {
    await breathe();
    if (stop.requested) notRun.push(zip);
    else zips.push(await processZip(zip, { outDir, force, dryRun, claims }));
  }

  const every = [...archives, ...zips.flatMap(z => z.archives)];
  const allSkipped = [...found.skipped, ...zips.flatMap(z => z.skipped)];
  const ok = !stop.requested &&
    !every.some(a => a.status === 'failed' || a.failedChats.length) &&
    !zips.some(z => z.status === 'failed' || z.rejected.length) &&
    !allSkipped.some(s => s.reason.startsWith('unreadable'));
  return { folder: input, out: outDir, force, dryRun, ok, stopped: stop.requested, notRun, archives, zips, skipped: [...found.skipped, ...archives.flatMap(a => a.skippedChats)] };
}

function archiveLine(a) {
  const label = a.status === 'written' && a.dryRun ? 'would write' : a.status;
  const facts = [];
  if (a.chats) facts.push(plural(a.chats, 'chat'));
  if (a.failedChats.length) facts.push(`${a.failedChats.length} failed`);
  if (a.added) facts.push(`${a.added} added`);
  if (a.missing.length) facts.push(`${a.missing.length} missing`);
  const warnings = a.notices.length + a.warnings.length;
  if (warnings) facts.push(plural(warnings, 'warning'));
  return `${label}: ${a.root}${facts.length ? ` (${facts.join(', ')})` : ''}${a.reason ? `: ${a.reason}` : ''}`;
}

function zipLine(z) {
  const label = z.status === 'written' && z.dryRun ? 'would write' : z.status;
  const facts = z.rejected.length ? ` (${z.rejected.length} entries refused)` : '';
  return `${label}: ${z.zip}${facts}${z.reason ? `: ${z.reason}` : ''}`;
}

// Names in a report come from archives, so they can hold anything: this keeps each on its own line and
// keeps control codes from the terminal. C0, DEL, C1, line separators and bidi overrides.
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
const printable = line => line.replace(UNPRINTABLE, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

// A heading, then per owner its list, cut at shown. groups: [{ owner, items: [string] }]
function section(lines, heading, groups, shown = LIST_SHOWN) {
  const used = groups.filter(g => g.items.length);
  if (used.length) lines.push('', heading);
  for (const { owner, items } of used) {
    lines.push(`  ${owner} (${items.length}):`);
    for (const item of items.slice(0, shown)) lines.push(`    ${item}`);
    if (items.length > shown) lines.push(`    ... and ${items.length - shown} more`);
  }
}

function formatReport(report) {
  const lines = [...report.archives.map(archiveLine)];
  for (const z of report.zips) {
    lines.push(zipLine(z));
    for (const a of z.archives) lines.push(archiveLine(a));
  }
  const every = [...report.archives, ...report.zips.flatMap(z => z.archives)];
  const inChat = (chat, text) => (chat === '.' ? text : `${chat}/${text}`);

  section(lines, 'Needs attention:', every.map(a => ({ owner: a.root, items: a.notices })), Infinity);
  if (report.stopped) section(lines, 'Stopped by a signal. Not processed:', [{ owner: report.folder, items: report.notRun }]);
  section(lines, 'Failed chats:', every.map(a => ({ owner: a.root, items: a.failedChats.map(c => `${c.chat}: ${c.reason}`) })));
  section(lines, 'Missing files:', every.map(a => ({ owner: a.root, items: a.missing.map(m => inChat(m.chat, m.file)) })));
  section(lines, 'Refused ZIP entries:', report.zips.map(z => ({ owner: z.zip, items: z.rejected })));
  section(lines, 'Warnings:', every.map(a => ({ owner: a.root, items: a.warnings })));

  const skipped = [...report.skipped, ...report.zips.flatMap(z => z.skipped)];
  if (skipped.length) lines.push('', 'Skipped:');
  for (const s of skipped) lines.push(`  ${s.path}: ${s.reason}`);

  if (!report.archives.length && !report.zips.length) lines.unshift(`No Claude archives found in ${report.folder}`);
  return lines.map(printable).join('\n');
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
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    if (stop.requested) process.exit(130); // a second signal: some steps have no stop point
    stop.requested = true;
  });
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
