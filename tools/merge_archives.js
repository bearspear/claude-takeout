// Combines Claude Takeout archives, such as a full Mega-Zip and the "only new or changed" ones after it,
// into one new archive with one viewer.
//   node tools/merge_archives.js <archive folder or ZIP>... --out <folder> [--name <name>] [--dry-run] [--json]
// Each chat is taken once, from the archive with its newest copy: the latest updated_at in original.json,
// then the later export (export-manifest.json's exported_at), then the archive named later. The sources
// are only read. Artifacts and published pages of every layout (published/ before 1.17, published/ beside artifacts/
// in 1.17, artifacts/ in 1.18, Export Artifacts exports) go into one 1.18 artifacts/ store: one folder per artifact, a
// <ver>/ folder per version, each version taken whole from the newest source with a copy; the merged chats' links into
// published/ are rewritten to it. Everything is written into a new folder under --out, built under a temporary name
// and renamed when complete; ZIPs are extracted into a hidden temporary folder under --out and removed after.
// Exit code 0 when clean, 1 if anything failed.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const core = require('../export-core.js');
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
// Artifacts: one store
// ===================================================================

// Names an artifact folder may not take in artifacts/ (popup.js ARTIFACT_ROOT_NAMES), compared without case.
const ARTIFACT_ROOT_NAMES = ['index.md', 'index.html', 'export-manifest.json', 'errors.txt', 'write-errors.txt', 'viewer.html', 'viewer-check.gif', 'viewer-files'];
const ARTIFACTS_UNLISTED_HEADING = "Published from chats, not in claude.ai's list";
const ARTIFACTS_NO_LIST = "claude.ai's list isn't in this export";
const sha256File = abs => crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
const encodePath = p => String(p).split('/').map(encodeURIComponent).join('/');
// A version with something on disk to take: files in its folder, or a chat's own files (sameAs).
const hasCopy = v => !!((v.folder && v.files.some(f => f.abs)) || v.sameAs);

// Newest source first: the later export (export-manifest.json's exported_at), then the source named later.
function newestFirst(a, b) {
  const ta = time(a.exportedAt);
  const tb = time(b.exportedAt);
  if (ta !== tb) return ta > tb ? -1 : 1;
  return b.order - a.order || b.index - a.index;
}

// Every source archive's artifacts in whichever layout it has (lib.readArtifactStore), newest first. Each: { store,
// archive, order, index, exportedAt, decides (claude.ai's list in it decides listed: a full Export All whose artifact
// step ran, or an Export Artifacts; Export Changes never), chatOf (its chats' folders -> their copies; '' for a single
// chat), chatFolders (chat uuid -> folder), folders (a saved version's folder -> { uuid, ver, byFile: savedAs -> path }) }.
function readStores(sources, archivesOf, copies, report) {
  const out = [];
  for (const s of sources) {
    (archivesOf.get(s.order) || []).forEach((archive, index) => {
      const warnings = [];
      const store = lib.readArtifactStore(archive.root, { warnings });
      for (const w of warnings) report.warnings.push(`${archive.root}: ${w}`);
      const manifest = readJson(path.join(archive.root, 'export-manifest.json'));
      const step = !!manifest && !!manifest.artifacts && typeof manifest.artifacts === 'object' && !Array.isArray(manifest.artifacts);
      const mine = copies.filter(c => c.archive === archive);
      const rel = c => (archive.kind === 'mega' ? c.folder : '');
      const folders = new Map();
      for (const rec of store.records.values()) {
        for (const [ver, v] of rec.versions) {
          if (v.folder) folders.set(v.folder, { uuid: rec.uuid, ver, byFile: new Map(v.files.filter(f => f.savedAs).map(f => [f.savedAs, f.path])) });
        }
      }
      out.push({
        store, archive, order: s.order, index, exportedAt: store.exportedAt, decides: store.kind === 'artifacts' || (store.kind === 'full' && step),
        chatOf: new Map(mine.map(c => [rel(c), c])), chatFolders: new Map(mine.filter(c => c.uuid).map(c => [c.uuid, rel(c)])), folders,
      });
    });
  }
  return out.sort(newestFirst);
}

// One version order from several (each in claude.ai's order, oldest source first, so a version only an older export
// has comes before one only a newer has): a version not placed yet goes right after the one before it in its list,
// else right before the one after it, else last.
function mergeOrder(lists) {
  const out = [];
  for (const list of lists) {
    list.forEach((ver, i) => {
      if (out.includes(ver)) return;
      const before = list.slice(0, i).reverse().find(x => out.includes(x));
      if (before !== undefined) { out.splice(out.indexOf(before) + 1, 0, ver); return; }
      const after = list.slice(i + 1).find(x => out.includes(x));
      if (after !== undefined) out.splice(out.indexOf(after), 0, ver);
      else out.push(ver);
    });
  }
  return out;
}

// One record per artifact uuid from every store (newest first): its versions united, each taken whole from the newest
// source that has a copy of it (else the newest that lists it), publishedIn united. listed, current, title and
// claude.ai's card come from the newest store whose list decides (not listing it: listed false), else from the newest
// store that has it. The card picture from the newest store that has one.
function mergeRecords(stores) {
  const decider = stores.find(st => st.decides) || null;
  const byUuid = new Map();
  for (const st of stores) {
    for (const rec of st.store.records.values()) {
      if (!byUuid.has(rec.uuid)) byUuid.set(rec.uuid, []);
      byUuid.get(rec.uuid).push({ st, rec });
    }
  }
  const merged = [];
  for (const [uuid, have] of byUuid) {
    const fromDecider = decider ? have.find(h => h.st === decider) : null;
    const top = fromDecider || have[0];
    const versions = new Map();
    for (const { st, rec } of have) {
      for (const ver of rec.order) {
        const v = lib.sameFromChats(st.store, rec.versions.get(ver), st.chatFolders);
        const had = versions.get(ver);
        if (!had) { versions.set(ver, { st, v, publishedIn: v.publishedIn.slice() }); continue; }
        const seen = new Set(had.publishedIn.map(p => `${p.chat}\n${p.toolUseId}`));
        for (const p of v.publishedIn) if (!seen.has(`${p.chat}\n${p.toolUseId}`)) { seen.add(`${p.chat}\n${p.toolUseId}`); had.publishedIn.push(p); }
        if (!hasCopy(had.v) && hasCopy(v)) Object.assign(had, { st, v });
      }
    }
    const listed = decider ? !!(fromDecider && fromDecider.rec.listed) : !!top.rec.listed;
    // A page no source holds a version of, and claude.ai doesn't list, has nothing to keep.
    if (!versions.size && !listed) continue;
    merged.push({
      uuid, rec: top.rec, listed, thumbFrom: have.find(h => h.rec.thumb) || null,
      order: mergeOrder(have.slice().reverse().map(h => h.rec.order)), versions,
    });
  }
  return merged;
}

// Copies a file to dir/<savedAs ('/'-separated)>, making its folders; false when it can't (the name is taken).
function copyInto(src, dir, savedAs) {
  const dest = path.join(dir, ...savedAs.split('/'));
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL);
    return true;
  } catch (e) { return false; }
}

// A sameAs version's chat files as the merged chats hold them: { <published path>: <root-relative file> } when the
// merged copy of each chat has the file with the same bytes, else null.
function repointSameAs(st, v, byChat, building) {
  const out = {};
  for (const [p, rel] of Object.entries(v.sameAs)) {
    const segs = rel.split('/');
    const mega = st.archive.kind === 'mega';
    const copy = st.chatOf.get(mega ? segs[0] : '');
    const inChat = mega ? segs.slice(1).join('/') : rel;
    const chosen = copy && copy.uuid ? byChat.get(copy.uuid) : null;
    const there = chosen && inChat ? lib.realFileUnder(path.join(building, chosen.out), inChat) : null;
    if (!there || !v.sameAsAbs[p] || sha256File(there) !== sha256File(v.sameAsAbs[p])) return null;
    out[p] = `${chosen.out}/${inChat}`;
  }
  return out;
}

// Writes artifacts/ (one folder per artifact, a <ver>/ folder per version with a copy, artifact.json format 2) and the
// card pictures into viewer-files/thumbs/ for the viewer to keep. Returns { places: `${uuid}\n${ver}` -> where the
// version is now ({ dir, folder, savedAs: path -> savedAs } or { sameAs }), rows (for artifacts/index.md), listed, thumbs }.
function writeArtifacts(merged, building, chosen, report) {
  const base = path.join(building, 'artifacts');
  fs.mkdirSync(base);
  const used = new Set(ARTIFACT_ROOT_NAMES);
  const places = new Map();
  const rows = [];
  const byChat = new Map(chosen.filter(c => c.uuid).map(c => [c.uuid, c]));
  const thumbsTaken = new Set();
  let thumbs = 0;
  for (const m of merged) {
    const dir = freeName(path.posix.basename(m.rec.dir) || `artifact_${m.rec.shortId || m.uuid}`, used);
    fs.mkdirSync(path.join(base, dir));
    const taken = new Set(['artifact.json']);
    const versions = new Map();
    for (const ver of m.order) {
      const { st, v, publishedIn } = m.versions.get(ver);
      const folderFor = () => {
        const name = freeName(core.publishedSegment(ver), taken);
        fs.mkdirSync(path.join(base, dir, name));
        return name;
      };
      let out;
      if (v.folder && v.files.some(f => f.abs)) {
        const name = folderFor();
        const files = v.files.map(f => (f.abs && f.savedAs && copyInto(f.abs, path.join(base, dir, name), f.savedAs) ? f : { ...f, savedAs: null }));
        const startSaved = v.startSaved && files.some(f => f.savedAs === v.startSaved) ? v.startSaved : null;
        out = { ...v, folder: `artifacts/${dir}/${name}`, files, startSaved, sameAs: null };
      } else if (v.sameAs) {
        // A chat's own file stands for the version only while every merged chat that published it wrote it the same
        // (their links and cards open their own file); one that didn't needs the version's own folder, as an export
        // would have saved it.
        const allSame = publishedIn.every(p => p.same || !byChat.has(p.chat));
        const sameAs = allSame ? repointSameAs(st, v, byChat, building) : null;
        if (sameAs) out = { ...v, folder: null, sameAs };
        else {
          // The chat copy in the merged archive differs (or isn't there), or a chat links the version itself: its bytes,
          // from the source's chat file.
          const name = folderFor();
          const files = v.files.map(f => {
            const src = v.sameAsAbs[f.path];
            const savedAs = String(f.path).split('/').map(core.publishedSegment).join('/');
            return src && copyInto(src, path.join(base, dir, name), savedAs) ? { ...f, savedAs } : { ...f, savedAs: null };
          });
          const start = files.find(f => f.path === v.start && f.savedAs);
          out = { ...v, folder: `artifacts/${dir}/${name}`, files, saved: files.some(f => f.savedAs), startSaved: start ? start.savedAs : null, sameAs: null };
          report.sameCopied++;
        }
      } else out = { ...v, folder: null, saved: false, sameAs: null };
      out.publishedIn = publishedIn;
      versions.set(ver, out);
      places.set(`${m.uuid}\n${ver}`, out.folder
        ? { dir, folder: out.folder.split('/').pop(), savedAs: new Map(out.files.filter(f => f.savedAs).map(f => [f.path, f.savedAs])) }
        : { sameAs: out.sameAs || {} });
    }
    // The card picture, for a listed artifact (the viewer shows only those): viewer-files/thumbs/, where the viewer keeps it.
    let thumbRel = null;
    if (m.listed && m.thumbFrom) {
      const name = path.posix.basename(m.thumbFrom.rec.thumbRel);
      if (!thumbsTaken.has(name.toLowerCase())) {
        thumbsTaken.add(name.toLowerCase());
        const at = path.join(building, 'viewer-files', 'thumbs');
        fs.mkdirSync(at, { recursive: true });
        fs.copyFileSync(m.thumbFrom.rec.thumb, path.join(at, name), fs.constants.COPYFILE_EXCL);
        thumbRel = `viewer-files/thumbs/${name}`;
        thumbs++;
      }
    }
    const rec = { uuid: m.uuid, shortId: m.rec.shortId, title: m.rec.title, listed: m.listed, current: m.rec.current, meta: m.rec.meta, thumbRel, order: m.order, versions };
    fs.writeFileSync(path.join(base, dir, 'artifact.json'), JSON.stringify(lib.artifactJsonV2FromDisk(rec), null, 2), { flag: 'wx' });
    rows.push({ dir, rec });
  }
  return { places, rows, listed: merged.filter(m => m.listed).length, thumbs };
}

// artifacts/index.md: each artifact once, claude.ai's first, by title, linked to its current version's start file (or
// the newest version with one), with its versions. A shared artifact's start file is linked only when the viewer
// would open its type (export-core.js openableName), as the extension's index does.
function artifactsIndexMd(rows, { at, listed }) {
  const cell = t => String(t || '').replace(/[\r\n]+/g, ' ').replace(/[\[\]<>|*_`#\\]/g, '\\$&');
  const target = local => encodePath(local).replace(/[()]/g, c => (c === '(' ? '%28' : '%29'));
  const startOf = (rec, ver) => {
    const v = rec.versions.get(ver);
    const local = v.folder && v.startSaved ? `${v.folder.slice('artifacts/'.length)}/${v.startSaved}` : v.sameAs && v.start && v.sameAs[v.start] ? `../${v.sameAs[v.start]}` : null;
    if (!local || (core.isSharedArtifact(rec.meta.rel) && !core.openableName(local))) return null;
    return target(local);
  };
  const lines = ['# Claude Takeout - Artifacts', '', `**Merged:** ${at}`, `**Listed by claude.ai:** ${listed == null ? ARTIFACTS_NO_LIST : listed}`];
  const table = list => {
    lines.push('', '| # | Artifact | Kind | Versions |', '|---|----------|------|----------|');
    list.forEach(({ rec }, i) => {
      const newest = [rec.current, ...rec.order.slice().reverse()].find(ver => ver && rec.versions.has(ver) && startOf(rec, ver));
      const local = newest ? startOf(rec, newest) : null;
      const name = cell(rec.title || 'Untitled');
      const versions = rec.order.map(ver => {
        const link = startOf(rec, ver);
        return `${link ? `[${cell(ver)}](${link})` : cell(ver)}${ver === rec.current ? ' (current)' : ''}`;
      }).join(', ');
      lines.push(`| ${i + 1} | ${local ? `[${name}](${local})` : name} · [claude.ai](https://claude.ai/artifact/${rec.shortId || rec.uuid}) | ${cell(rec.meta.typeTitle || 'Page')} | ${versions} |`);
    });
  };
  const byTitle = (a, b) => String(a.rec.title).toLowerCase().localeCompare(String(b.rec.title).toLowerCase()) || a.dir.localeCompare(b.dir);
  const inList = rows.filter(r => r.rec.listed).sort(byTitle);
  const unlisted = rows.filter(r => !r.rec.listed).sort(byTitle);
  if (inList.length || !unlisted.length) table(inList);
  if (unlisted.length) {
    lines.push('', `## ${ARTIFACTS_UNLISTED_HEADING}`);
    table(unlisted);
  }
  return '﻿' + lines.join('\n') + '\n';
}

// The Markdown files of a chat that link pages: README.md, full_chat.md, integrated_chat.md and responses/*.md.
function chatMarkdownFiles(dir) {
  const out = ['README.md', 'full_chat.md', 'integrated_chat.md'].filter(n => lstat(path.join(dir, n)) && lstat(path.join(dir, n)).isFile());
  const responses = path.join(dir, 'responses');
  if (lstat(responses) && lstat(responses).isDirectory()) {
    for (const n of fs.readdirSync(responses).sort()) if (/\.md$/i.test(n) && lstat(path.join(responses, n)).isFile()) out.push(`responses/${n}`);
  }
  return out;
}

// Where a link in file (chat-relative) of chat c into its source's published/ (or a 1.18 source's artifacts/) now goes,
// relative to that file in the merged chat: mapped by page uuid and version to its folder in artifacts/, or the chat
// file it is the same as. null when the target isn't a saved file of a version the source's store knows.
function linkMapper(c, st, places, file) {
  const from = path.posix.join(c.archive.kind === 'mega' ? c.folder : '.', path.posix.dirname(file));
  const to = path.posix.join(c.out, path.posix.dirname(file));
  return target => {
    let rel;
    try { rel = target.split('/').map(decodeURIComponent).join('/'); } catch (e) { return null; }
    const joined = path.posix.normalize(path.posix.join(from, rel));
    if (joined === '..' || joined.startsWith('../')) return null;
    const segs = joined.split('/');
    for (let i = segs.length - 1; i > 0; i--) {
      const hit = st.folders.get(segs.slice(0, i).join('/'));
      if (!hit) continue;
      const p = hit.byFile.get(segs.slice(i).join('/'));
      const place = p == null ? null : places.get(`${hit.uuid}\n${hit.ver}`);
      const now = !place ? null : place.savedAs ? place.savedAs.has(p) && `artifacts/${place.dir}/${place.folder}/${place.savedAs.get(p)}` : place.sameAs[p];
      return now ? encodePath(path.posix.relative(to, now)) : null;
    }
    return null;
  };
}

// Rewrites the merged copies' links into published/ (and a 1.18 source's artifacts/) to the merged artifacts/. Links
// it can't map are left as they are and listed in the report.
function rewriteLinks(chosen, stores, places, building, report) {
  const storeOf = new Map(stores.map(st => [st.archive, st]));
  for (const c of chosen) {
    const st = storeOf.get(c.archive);
    if (!st) continue;
    const dir = path.join(building, c.out);
    for (const file of chatMarkdownFiles(dir)) {
      const abs = path.join(dir, ...file.split('/'));
      const text = fs.readFileSync(abs, 'utf8');
      const got = lib.rewriteChatLinks(text, linkMapper(c, st, places, file));
      for (const t of got.unmapped) {
        report.unmappedLinks.push({ chat: c.out, file, target: t });
        report.warnings.push(`${c.out}/${file}: a link to ${t} could not be mapped to artifacts/, so it was left as it is`);
      }
      if (got.text !== text) {
        fs.writeFileSync(abs, got.text);
        report.rewrittenFiles++;
      }
    }
  }
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
    const manifest = archive.kind !== 'single' ? readJson(path.join(archive.root, 'export-manifest.json')) : null;
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

function indexMd(chats, sources, at, artifacts = 0) {
  const lines = [
    '# Claude Takeout - Merged archive',
    '',
    `**Merged:** ${at}`,
    `**Total Conversations:** ${chats.length}`,
    ...(artifacts ? [`**Artifacts:** ${artifacts} ([list](artifacts/index.md))`] : []),
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
  const report = { out: outDir, dest, dryRun, ok: false, status: 'failed', reason: '', sources: [], chats: 0, replaced: 0, artifacts: 0, sameCopied: 0, rewrittenFiles: 0, unmappedLinks: [], files: 0, bytes: 0, viewer: null, warnings: [] };
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
    const stores = readStores(sources, archivesOf, all, report);
    const merged = mergeRecords(stores);
    report.artifacts = merged.length;
    if (!all.length && !merged.length) throw new Error('no Claude chats or artifacts were found in the sources');
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
    const used = new Set(['projects', 'published', 'artifacts', 'index.md', 'export-manifest.json', 'viewer.html', 'viewer-check.gif', 'viewer-files'].map(n => n.toLowerCase()));
    const storeOf = new Map(stores.map(st => [st.archive, st]));
    for (const c of chosen) {
      c.out = freeName(c.folder, used);
      // A chat's own published/ (a chat ZIP's) moves into the root artifacts/, so the copy leaves it out.
      const st = storeOf.get(c.archive);
      const own = st && st.store.published.some(page => page.chat === (c.archive.kind === 'mega' ? c.folder : null));
      const skipTop = new Set([...(c.single ? VIEWER_NAMES : []), ...(own ? ['published'] : [])]);
      const copied = copyTree(c.dir, path.join(building, c.out), { skipTop });
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
    // Every source's artifacts and published pages, in one artifacts/ store; the chats' links follow them.
    const at = now.toISOString();
    const decided = stores.some(st => st.decides);
    let written = null;
    if (merged.length) {
      written = writeArtifacts(merged, building, chosen, report);
      fs.writeFileSync(path.join(building, 'artifacts', 'index.md'), artifactsIndexMd(written.rows, { at, listed: decided ? written.listed : null }), { flag: 'wx' });
      rewriteLinks(chosen, stores, written.places, building, report);
    }
    fs.writeFileSync(path.join(building, 'index.md'), indexMd(chosen, sources, at, merged.length), { flag: 'wx' });
    fs.writeFileSync(path.join(building, 'export-manifest.json'), JSON.stringify({
      format: 1, exported_at: at, kind: 'merged', since: null, listed: null,
      sources: sources.map(s => s.label),
      chats: chosen.map(c => ({ uuid: c.uuid, name: c.name, updated_at: c.updatedAt, folder: c.out, from: c.source })),
      // claude.ai's list is in the merged archive when a source's list decided listed (readArtifactStore reads this key).
      ...(written && decided ? { artifacts: { listed: written.listed, thumbs: written.thumbs } } : {}),
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
  if (r.artifacts) lines.push(`${r.artifacts} artifact${r.artifacts === 1 ? '' : 's'} in artifacts/${r.rewrittenFiles ? `; links rewritten in ${r.rewrittenFiles} chat file${r.rewrittenFiles === 1 ? '' : 's'}` : ''}`);
  if (r.unmappedLinks && r.unmappedLinks.length) lines.push(`${r.unmappedLinks.length} link${r.unmappedLinks.length === 1 ? '' : 's'} left as they were (see Warnings)`);
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
