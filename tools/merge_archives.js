// Combines Claude Takeout archives, such as a full Mega-Zip and the "only new or changed" ones after it,
// into one new archive with one viewer.
//   node tools/merge_archives.js <archive folder or ZIP>... --out <folder> [--name <name>] [--dry-run] [--json]
// Each chat is taken once, from the archive with its newest copy: the latest updated_at in original.json,
// then the later export (export-manifest.json's exported_at), then the archive named later. The sources
// are only read. Everything is written into a new folder under --out, built under a temporary name and
// renamed when complete; ZIPs are extracted into a hidden temporary folder under --out and removed after.
// Exit code 0 when clean, 1 if anything failed.
const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const lib = require('./archive-lib.js');
const zipLib = require('./archive-zip.js');
const { writeViewer } = require('./build_viewer.js');

const USAGE = 'Usage: node tools/merge_archives.js <archive folder or ZIP>... --out <folder> [--name <name>] [--dry-run] [--json]';
// What a source archive's own viewer left beside a single chat; the merged archive gets a new viewer.
const VIEWER_NAMES = new Set(['viewer.html', 'viewer-check.gif', 'viewer-files']);
const SKIP_NAMES = new Set(['.DS_Store', 'Thumbs.db', '__MACOSX']);

class UsageError extends Error {}

const lstat = p => { try { return fs.lstatSync(p); } catch (e) { return null; } };
const isInside = (p, dir) => p === dir || p.startsWith(dir + path.sep);
const realOf = p => { try { return fs.realpathSync.native(p); } catch (e) { return path.resolve(p); } };
const stripBom = s => s.replace(/^\uFEFF/, '');
const time = s => { const t = Date.parse(s); return Number.isNaN(t) ? -Infinity : t; };

function readJson(file) {
  try { return JSON.parse(stripBom(fs.readFileSync(file, 'utf8'))); } catch (e) { return null; }
}

// Real path of a folder that may not exist yet.
function realPlanned(p) {
  const rest = [];
  let cur = path.resolve(p);
  while (!lstat(cur) && path.dirname(cur) !== cur) {
    rest.unshift(path.basename(cur));
    cur = path.dirname(cur);
  }
  return path.join(realOf(cur), ...rest);
}

// Copies a folder's real files and folders. Links are never followed or copied; nothing is overwritten.
function copyTree(from, to, { skipTop = null } = {}) {
  let files = 0;
  let bytes = 0;
  const skipped = [];
  const walk = (src, dest, top) => {
    fs.mkdirSync(dest);
    for (const name of fs.readdirSync(src).sort()) {
      if (SKIP_NAMES.has(name) || (top && skipTop && skipTop.has(name))) continue;
      const s = path.join(src, name);
      const d = path.join(dest, name);
      const st = lstat(s);
      if (!st) continue;
      if (st.isSymbolicLink()) skipped.push(path.relative(from, s));
      else if (st.isDirectory()) walk(s, d, false);
      else if (st.isFile()) {
        fs.copyFileSync(s, d, fs.constants.COPYFILE_EXCL);
        files++;
        bytes += st.size;
      }
    }
  };
  walk(from, to, true);
  return { files, bytes, skipped };
}

// ===================================================================
// Reading the sources
// ===================================================================

// Each source's archives and the copy of every chat in them.
function readSource(source, order, report) {
  const found = lib.findArchives(source.dir);
  for (const s of found.skipped) report.warnings.push(`${s.path}: ${s.reason}`);
  for (const z of found.zips) report.warnings.push(`${z}: a ZIP inside a source is not opened; name it as a source of its own`);
  const copies = [];
  for (const archive of found.archives) {
    const manifest = archive.kind === 'mega' ? readJson(path.join(archive.root, 'export-manifest.json')) : null;
    const exportedAt = manifest && typeof manifest.exported_at === 'string' ? manifest.exported_at : null;
    for (const chat of archive.chats) {
      const data = readJson(path.join(chat.dir, 'original.json'));
      if (!data || typeof data !== 'object') {
        report.warnings.push(`${chat.dir}: original.json could not be read, so this chat was left out`);
        continue;
      }
      copies.push({
        uuid: typeof data.uuid === 'string' && data.uuid ? data.uuid : null,
        name: typeof data.name === 'string' ? data.name : '',
        updatedAt: typeof data.updated_at === 'string' ? data.updated_at : null,
        exportedAt, order, source: source.label, archive, dir: chat.dir,
        folder: archive.kind === 'mega' ? chat.relDir : path.basename(archive.root),
        single: archive.kind === 'single',
      });
    }
  }
  return { archives: found.archives, copies };
}

// True when a is a newer copy of the same chat than b.
function newer(a, b) {
  const ta = time(a.updatedAt);
  const tb = time(b.updatedAt);
  if (ta !== tb) return ta > tb;
  const ea = time(a.exportedAt);
  const eb = time(b.exportedAt);
  if (ea !== eb && ea !== -Infinity && eb !== -Infinity) return ea > eb;
  return a.order > b.order;
}

// One copy per chat uuid, the newest; chats without a uuid are all kept.
function pickNewest(copies) {
  const best = new Map();
  const loose = [];
  for (const c of copies) {
    if (!c.uuid) { loose.push(c); continue; }
    const had = best.get(c.uuid);
    if (!had || newer(c, had)) best.set(c.uuid, c);
  }
  const chosen = [...best.values(), ...loose];
  return { chosen, replaced: copies.length - chosen.length };
}

// ===================================================================
// Writing the merged archive
// ===================================================================

const cell = s => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');

function indexMd(chats, sources, at) {
  const lines = [
    '# Claude Takeout - Merged archive',
    '',
    `**Merged:** ${at}`,
    `**Total Conversations:** ${chats.length}`,
    '',
    '**Sources:**',
    ...sources.map(s => `- ${cell(s.label)} (${s.chats} chat${s.chats === 1 ? '' : 's'} taken)`),
    '',
    '| # | Conversation | Updated | From |',
    '|---|--------------|---------|------|',
    ...chats.map((c, i) => `| ${i + 1} | [${cell(c.name || 'Untitled')}](${encodeURI(c.out)}/README.md) | ${cell(c.updatedAt || '')} | ${cell(c.source)} |`),
  ];
  return '\uFEFF' + lines.join('\n') + '\n';
}

// A folder name that isn't taken yet, compared as a Mac compares them (case folded).
function freeName(name, used) {
  const base = name || 'chat';
  let out = base;
  for (let n = 2; used.has(out.normalize('NFC').toLowerCase()); n++) out = `${base}_${n}`;
  used.add(out.normalize('NFC').toLowerCase());
  return out;
}

async function merge(inputs, { out, name = null, dryRun = false, now = new Date() } = {}) {
  if (!inputs.length) throw new UsageError(USAGE);
  if (!out) throw new UsageError(`--out <folder> is needed: the merged archive is written there.\n${USAGE}`);
  const outDir = path.resolve(out);
  const realOut = realPlanned(outDir);
  if (lstat(outDir) && !lstat(outDir).isDirectory()) throw new UsageError(`--out is not a folder: ${outDir}`);
  for (let dir = realOut; ; dir = path.dirname(dir)) {
    if (lib.isArchiveRoot(dir)) throw new UsageError(`--out can't be inside an archive: ${dir}`);
    if (path.dirname(dir) === dir) break;
  }
  const sources = inputs.map((p, i) => {
    const abs = path.resolve(p);
    const st = lstat(abs);
    if (!st) throw new UsageError(`Not found: ${abs}`);
    const zip = st.isFile() && /\.zip$/i.test(abs);
    if (!zip && !fs.statSync(abs).isDirectory()) throw new UsageError(`Not a folder or a ZIP: ${abs}`);
    if (!zip && isInside(realOut, realOf(abs))) throw new UsageError(`--out can't be inside a source: ${abs}`);
    return { input: abs, zip, label: path.basename(abs), order: i, dir: zip ? null : abs, chats: 0 };
  });

  const dateStr = now.toISOString().slice(0, 10);
  const folderName = name || `claude-takeout-merged-${dateStr}`;
  if (/[\\/]/.test(folderName) || folderName === '.' || folderName === '..') throw new UsageError(`--name must be a plain folder name: ${folderName}`);
  const dest = path.join(outDir, folderName);
  const report = { out: outDir, dest, dryRun, ok: false, status: 'failed', reason: '', sources: [], chats: 0, replaced: 0, files: 0, bytes: 0, viewer: null, warnings: [] };
  if (lstat(dest)) throw new UsageError(`${dest} already exists, so nothing was written. Pick another --name or --out.`);

  const scratch = path.join(outDir, `.merge-${process.pid}`);
  const building = path.join(outDir, `.${folderName}.partial-${process.pid}`);
  try {
    if (!dryRun) fs.mkdirSync(outDir, { recursive: true });
    // ZIPs are extracted first, into the hidden scratch folder.
    for (const s of sources.filter(x => x.zip)) {
      if (dryRun) {
        const names = await zipLib.zipEntryNames(s.input);
        report.warnings.push(`${s.label}: holds ${names.filter(n => /(^|\/)original\.json$/.test(n)).length} chats; a dry run doesn't extract it`);
        continue;
      }
      if (!lstat(scratch)) fs.mkdirSync(scratch);
      const space = await zipLib.zipFreeSpaceOk(s.input, outDir);
      if (!space.ok) throw new Error(`not enough free space to extract ${s.label}: needs ${space.needed} bytes, ${space.free} free`);
      s.dir = path.join(scratch, String(s.order));
      const extracted = await zipLib.extractZip(s.input, s.dir);
      for (const r of extracted.rejected) report.warnings.push(`${s.label}: entry not extracted: ${r.name || r}`);
    }

    const all = [];
    const archivesOf = new Map();
    for (const s of sources) {
      if (!s.dir) continue;
      const got = readSource(s, s.order, report);
      archivesOf.set(s.order, got.archives);
      all.push(...got.copies);
    }
    if (!all.length) throw new Error('no Claude chats were found in the sources');
    const { chosen, replaced } = pickNewest(all);
    chosen.sort((a, b) => time(b.updatedAt) - time(a.updatedAt) || a.folder.localeCompare(b.folder));
    report.replaced = replaced;
    report.chats = chosen.length;
    for (const s of sources) s.chats = chosen.filter(c => c.order === s.order).length;
    report.sources = sources.map(s => ({ path: s.input, chats: s.chats }));

    if (dryRun) {
      report.status = 'written';
      report.reason = `would write ${dest}`;
      report.ok = true;
      return report;
    }

    // Built under a hidden name, then renamed: a merged archive is there complete or not at all.
    fs.mkdirSync(building);
    const used = new Set(['projects', 'index.md', 'export-manifest.json', 'viewer.html', 'viewer-check.gif', 'viewer-files'].map(n => n.toLowerCase()));
    for (const c of chosen) {
      c.out = freeName(c.folder, used);
      const copied = copyTree(c.dir, path.join(building, c.out), { skipTop: c.single ? VIEWER_NAMES : null });
      report.files += copied.files;
      report.bytes += copied.bytes;
      for (const l of copied.skipped) report.warnings.push(`${c.dir}: ${l} is a link, so it was not copied`);
    }
    // Shared project folders of mega archives, newest source first; the first copy of a name wins.
    const takenProjects = new Set();
    for (const s of [...sources].sort((a, b) => b.order - a.order)) {
      for (const archive of archivesOf.get(s.order) || []) {
        const projects = path.join(archive.root, 'projects');
        const st = lstat(projects);
        if (archive.kind !== 'mega' || !st || !st.isDirectory()) continue;
        for (const dir of fs.readdirSync(projects).sort()) {
          const from = path.join(projects, dir);
          const fst = lstat(from);
          if (!fst || !fst.isDirectory() || takenProjects.has(dir.toLowerCase())) continue;
          takenProjects.add(dir.toLowerCase());
          if (!lstat(path.join(building, 'projects'))) fs.mkdirSync(path.join(building, 'projects'));
          const copied = copyTree(from, path.join(building, 'projects', dir));
          report.files += copied.files;
          report.bytes += copied.bytes;
        }
      }
    }
    const at = now.toISOString();
    fs.writeFileSync(path.join(building, 'index.md'), indexMd(chosen, sources, at), { flag: 'wx' });
    fs.writeFileSync(path.join(building, 'export-manifest.json'), JSON.stringify({
      format: 1, exported_at: at, kind: 'merged', since: null, listed: null,
      sources: sources.map(s => s.label),
      chats: chosen.map(c => ({ uuid: c.uuid, name: c.name, updated_at: c.updatedAt, folder: c.out, from: c.source })),
    }, null, 2), { flag: 'wx' });
    if (lstat(dest)) throw new Error(`${dest} appeared while merging, so it was left alone`);
    fs.renameSync(building, dest);

    // One viewer for the merged archive.
    const archive = lib.findArchives(dest).archives.find(a => a.root === dest);
    report.viewer = archive ? await writeViewer(archive) : { status: 'failed', reason: 'the merged folder was not recognized as an archive' };
    if (report.viewer.status !== 'written') report.warnings.push(`viewer.html: ${report.viewer.reason || report.viewer.status}`);
    report.status = 'written';
    report.ok = report.viewer.status === 'written';
    return report;
  } catch (e) {
    try { fs.rmSync(building, { recursive: true, force: true }); } catch (r) { report.warnings.push(`left at ${building}: ${r.message}`); }
    report.status = 'failed';
    report.reason = e.message;
    return report;
  } finally {
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (r) { report.warnings.push(`left at ${scratch}: ${r.message}`); }
  }
}

function formatReport(r) {
  const lines = [];
  if (r.status === 'failed') lines.push(`failed: ${r.reason}`);
  else lines.push(r.dryRun ? `would write: ${r.dest}` : `written: ${r.dest}`);
  if (r.chats) lines.push(`${r.chats} chats${r.replaced ? `; ${r.replaced} older ${r.replaced === 1 ? 'copy' : 'copies'} left out` : ''}`);
  for (const s of r.sources) lines.push(`  ${s.chats} from ${s.path}`);
  if (r.viewer && r.viewer.status === 'written') lines.push('viewer.html written');
  if (r.warnings.length) lines.push('', 'Warnings:', ...r.warnings.map(w => `  ${w}`));
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
      out: { type: 'string' }, name: { type: 'string' }, 'dry-run': { type: 'boolean' }, json: { type: 'boolean' },
    } });
  } catch (e) {
    return fail(`${e.message}\n${USAGE}`);
  }
  try {
    const report = await merge(args.positionals, { out: args.values.out, name: args.values.name || null, dryRun: !!args.values['dry-run'] });
    console.log(json ? JSON.stringify(report) : formatReport(report));
    return report.ok ? 0 : 1;
  } catch (e) {
    return fail(e.message);
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; });
}

module.exports = { merge, pickNewest, formatReport };
