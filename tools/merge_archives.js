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
const sha256File = abs => crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
const encodePath = p => String(p).split('/').map(encodeURIComponent).join('/');
// A version with something on disk to take: files in its folder, or a chat's own files (sameAs).
const hasFolder = v => !!(v.folder && v.files.some(f => f.abs));
const hasCopy = v => hasFolder(v) || !!v.sameAs;
// A copy with nothing missing: every listed file on disk, or a chat's own files.
const wholeCopy = v => (hasFolder(v) && !v.incomplete && !(v.missing && v.missing.length) && v.files.every(f => f.abs)) || (!!v.sameAs && !v.incomplete);
// Two versions' file lists the same (path and checksum each): a ZIP of one is a ZIP of the other.
const sameFiles = (a, b) => {
  const key = v => v.files.filter(f => f.savedAs).map(f => `${f.path}\n${f.sha256}`).sort().join('\n');
  return key(a) !== '' && key(a) === key(b);
};

// Newest source first: the later export (export-manifest.json's exported_at), then the source named later.
function newestFirst(a, b) {
  const ta = time(a.exportedAt);
  const tb = time(b.exportedAt);
  if (ta !== tb) return ta > tb ? -1 : 1;
  return b.order - a.order || b.index - a.index;
}

// Every source archive's artifacts in whichever layout it has (lib.readArtifactStore), newest first. Each: { store,
// archive, order, index, exportedAt, decides (claude.ai's list in it decides listed, absence too: a full Export All
// whose artifact step ran, or an Export Artifacts; an Export Changes can only list, in mergeRecords), chatOf (its
// chats' folders -> their copies; '' for a single chat), chatFolders (chat uuid -> folder), folders (a saved version's folder -> { uuid, ver, byFile: savedAs -> path }) }.
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
      // When claude.ai's list was asked: an export's own time; an earlier merge's from its manifest (decided_at: the full
      // list it was decided by; listed_at: per listed artifact, the list that listed it). A merge made before these
      // were written neither decides nor lists, as before.
      const merged = store.kind === 'merged';
      const arts = step ? manifest.artifacts : {};
      const decidedAt = merged ? (typeof arts.decided_at === 'string' ? arts.decided_at : null)
        : store.kind === 'artifacts' || (store.kind === 'full' && step) ? store.exportedAt : null;
      const listedAt = merged ? (arts.listed_at && typeof arts.listed_at === 'object' && !Array.isArray(arts.listed_at) ? arts.listed_at : {}) : null;
      out.push({
        store, archive, order: s.order, label: s.label, index, exportedAt: store.exportedAt, decides: decidedAt !== null, decidedAt,
        listedAtOf: rec => (!rec.listed ? null : merged ? (Object.prototype.hasOwnProperty.call(listedAt, rec.uuid) && typeof listedAt[rec.uuid] === 'string' ? listedAt[rec.uuid] : null) : store.exportedAt),
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
// source that has a copy of it (else the newest that lists it), publishedIn united; folders: every source's saved
// folder of it, newest first, for a sameAs version that can't stay one. listed, current, title and claude.ai's card
// come from the newest store that lists it (listed true, an Export Changes too; not an earlier merge, whose
// exported_at is when it was merged, not when claude.ai was asked), when that store is newer than the newest store
// whose list decides; else from that deciding store (not listing it: listed false); else from the newest store that
// has it. So a newer Export Changes can list an artifact and move its current version forward, never unlist it. The
// card picture from the newest store that has one.
function mergeRecords(stores) {
  // The newest full list (by when it was asked, not when its archive was made), and per artifact the newest list
  // that listed it; ties go to the newer source (stores are newest first).
  const decider = stores.filter(st => st.decides).reduce((best, st) => (!best || time(st.decidedAt) > time(best.decidedAt) ? st : best), null);
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
    const lister = have.filter(h => h.st.listedAtOf(h.rec) !== null)
      .reduce((best, h) => (!best || time(h.st.listedAtOf(h.rec)) > time(best.st.listedAtOf(best.rec)) ? h : best), null);
    const listedLater = !!lister && (!decider || time(lister.st.listedAtOf(lister.rec)) > time(decider.decidedAt));
    const top = listedLater ? lister : fromDecider || have[0];
    const versions = new Map();
    for (const { st, rec } of have) {
      for (const ver of rec.order) {
        const v = lib.sameFromChats(st.store, rec.versions.get(ver), st.chatFolders);
        const had = versions.get(ver);
        if (!had) { versions.set(ver, { st, v, publishedIn: v.publishedIn.slice(), folders: hasFolder(v) ? [{ st, v }] : [] }); continue; }
        if (hasFolder(v)) had.folders.push({ st, v });
        const seen = new Set(had.publishedIn.map(p => `${p.chat}\n${p.toolUseId}`));
        for (const p of v.publishedIn) if (!seen.has(`${p.chat}\n${p.toolUseId}`)) { seen.add(`${p.chat}\n${p.toolUseId}`); had.publishedIn.push(p); }
        // A version id's files don't change, so any whole copy will do: the newest, unless only an older one is whole.
        if ((!hasCopy(had.v) && hasCopy(v)) || (!wholeCopy(had.v) && wholeCopy(v))) Object.assign(had, { st, v });
      }
    }
    const listed = listedLater || (decider ? !!(fromDecider && fromDecider.rec.listed) : !!top.rec.listed);
    // A page no source holds a version of, and claude.ai doesn't list, has nothing to keep.
    if (!versions.size && !listed) continue;
    const listedAt = !listed ? null : listedLater ? lister.st.listedAtOf(lister.rec) : fromDecider ? decider.decidedAt : top.st.listedAtOf(top.rec);
    merged.push({
      uuid, rec: top.rec, listed, listedAt, thumbFrom: have.find(h => h.rec.thumb) || null,
      order: mergeOrder(have.slice().reverse().map(h => h.rec.order)), versions,
    });
  }
  merged.decidedAt = decider ? decider.decidedAt : null;
  return merged;
}

// A file that starts as a ZIP does (PK\x03\x04).
function isZip(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(4);
    return fs.readSync(fd, head, 0, 4, 0) === 4 && head.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  } catch (e) {
    return false;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

// Copies a file to dir/<savedAs ('/'-separated)>, making its folders. false only when another file of the version
// already took that name; any other failure throws, and the merge stops (a merge never loses files silently).
function copyInto(src, dir, savedAs) {
  const dest = path.join(dir, ...savedAs.split('/'));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL);
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw new Error(`could not copy ${src}: ${e.message}`);
  }
}

// A version's files after copying (files: savedAs null for each not copied), with saved, startSaved, missing and
// incomplete saying so: a file the source had saved and this copy hasn't is missing, and the version incomplete.
function copiedVersion(v, files, folder, startSaved, report, label) {
  const lost = files.filter(f => !f.savedAs && !v.missing.includes(f.path)).map(f => f.path);
  for (const p of lost) report.warnings.push(`${label}: ${p} was not copied (its name is taken in the version folder, or the source has no file for it)`);
  const missing = [...v.missing, ...lost];
  return { ...v, folder, files, saved: files.some(f => f.savedAs), startSaved: startSaved && files.some(f => f.savedAs === startSaved) ? startSaved : null,
    missing, incomplete: !!v.incomplete || lost.length > 0, sameAs: null };
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

// The note of the source the listing came from, as the merged current version stands: what that source couldn't
// save, or saved with the chats, is dropped when the merged copy has it whole, or in a folder of its own.
function mergedNote(note, cur) {
  const parts = String(note || '').split('; ').filter(Boolean);
  if (!cur) return parts.join('; ');
  const whole = (cur.folder || cur.sameAs) && cur.saved !== false && !cur.incomplete && !(cur.missing && cur.missing.length);
  return parts.filter(p => !(whole && (/^not exported\b/.test(p) || /not saved \(see errors\.txt\)$/.test(p)))
    && !(cur.folder && p === 'files saved with the chats')).join('; ');
}

// Writes artifacts/ (one folder per artifact, a <ver>/ folder per version with a copy, artifact.json format 2) and the
// card pictures into viewer-files/thumbs/ for the viewer to keep. Returns { places: `${uuid}\n${ver}` -> where the
// version is now ({ dir, folder, savedAs: path -> savedAs } or { sameAs }), rows (index rows, export-core.js
// storeRecordRow's), listed, thumbs }.
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
      const { st, v, publishedIn, folders } = m.versions.get(ver);
      const folderFor = () => {
        const name = freeName(core.publishedSegment(ver), taken);
        fs.mkdirSync(path.join(base, dir, name));
        return name;
      };
      const label = `artifacts/${dir} ${ver}`;
      // The source version whose folder was copied: its ZIP, if any, matches what was copied.
      let copiedFrom = null;
      // A version's saved folder, copied file by file.
      const fromFolder = from => {
        copiedFrom = from;
        const name = folderFor();
        const files = from.files.map(f => (f.abs && f.savedAs && copyInto(f.abs, path.join(base, dir, name), f.savedAs) ? f : { ...f, savedAs: null }));
        return copiedVersion(from, files, `artifacts/${dir}/${name}`, from.startSaved, report, label);
      };
      let out;
      if (hasFolder(v)) out = fromFolder(v);
      else if (v.sameAs) {
        // A chat's own file stands for the version only while every merged chat that published it wrote it the same
        // (their links and cards open their own file); one that didn't needs the version's own folder, as an export
        // would have saved it.
        const allSame = publishedIn.every(p => p.same || !byChat.has(p.chat));
        const sameAs = allSame ? repointSameAs(st, v, byChat, building) : null;
        if (sameAs) out = { ...v, folder: null, sameAs };
        else if (folders.length) out = { ...fromFolder(folders[0].v), publishedIn };  // an older source saved it whole
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
          out = copiedVersion(v, files, `artifacts/${dir}/${name}`, start ? start.savedAs : null, report, label);
          report.sameCopied++;
        }
      } else out = { ...v, folder: null, saved: false, sameAs: null };
      out.publishedIn = publishedIn;
      // The ZIP (1.19): only the merged current version's, copied from the source whose folder it took; the tools write
      // no ZIP of their own.
      delete out.zip;
      delete out.zipAbs;
      // Another source's ZIP of the same files serves as well, when the copied folder's source has none.
      const zipFrom = copiedFrom && copiedFrom.zipAbs ? copiedFrom
        : copiedFrom ? (folders.find(f => f.v.zipAbs && sameFiles(f.v, copiedFrom)) || {}).v || null : null;
      if (ver === m.rec.current && out.folder && zipFrom) {
        const name = `${out.folder.split('/').pop()}.zip`;
        if (isZip(zipFrom.zipAbs)) {
          fs.copyFileSync(zipFrom.zipAbs, path.join(base, dir, name), fs.constants.COPYFILE_EXCL);
          out.zip = name;
        } else report.warnings.push(`${label}: ZIP left out (not a ZIP)`);
      }
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
    const rec = { uuid: m.uuid, shortId: m.rec.shortId, title: m.rec.title, listed: m.listed, current: m.rec.current, meta: { ...m.rec.meta, note: mergedNote(m.rec.meta.note, versions.get(m.rec.current)) }, thumbRel, order: m.order, versions };
    fs.writeFileSync(path.join(base, dir, 'artifact.json'), JSON.stringify(lib.artifactJsonV2FromDisk(rec), null, 2), { flag: 'wx' });
    // Its index row, as the extension builds one for a store record (export-core.js storeRecordRow): the record in
    // popup.js's store shape (version folders named inside the artifact folder, history its order).
    rows.push(core.storeRecordRow({
      title: rec.title, dir, listed: rec.listed, current: rec.current, history: rec.order, incomplete: !!rec.meta.incomplete,
      meta: { ...rec.meta, url: `https://claude.ai/artifact/${rec.shortId || rec.uuid}` },
      versions: new Map([...versions].map(([ver, v]) => [ver, { ...v, folder: v.folder ? v.folder.split('/').pop() : null }])),
    }));
  }
  return { places, rows, listed: merged.filter(m => m.listed).length, thumbs };
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
// it can't map are left as they are and listed in the report (broken: true when they open no file in the merge).
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
        // Left as it is: it still opens a file when its folder was kept in published/ (no published.json), else it is broken.
        let opened = null;
        try { opened = lstat(path.resolve(path.dirname(abs), ...t.split('/').map(decodeURIComponent))); } catch (e) { opened = null; }
        const works = !!opened && opened.isFile();
        report.unmappedLinks.push({ chat: c.out, file, target: t, broken: !works });
        if (!works) report.warnings.push(`${c.out}/${file}: the link to ${t} is broken in the merged archive: its page could not be mapped to artifacts/`);
      }
      if (got.text !== text) {
        fs.writeFileSync(abs, got.text);
        report.rewrittenFiles++;
      }
    }
  }
}

// A source's published/ folder (exact-case name, a real folder, not a chat), or null.
function publishedBase(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return null; }
  const base = path.join(dir, 'published');
  const st = lstat(base);
  return names.includes('published') && st && st.isDirectory() && !lstat(path.join(base, 'original.json')) ? base : null;
}

// What a published/ folder holds that its store didn't read as a page (no readable published.json beside it): kept as
// it is in dest (shown: dest as the report names it), so links into it keep working. A name dest already has (an
// older source's, at the root) is left out with a warning.
function keepUnreadPublished(base, read, dest, shown, report) {
  for (const name of fs.readdirSync(base).sort()) {
    const from = path.join(base, name);
    const st = lstat(from);
    if (SKIP_NAMES.has(name) || read.has(from) || !st) continue;
    if (st.isSymbolicLink()) { report.warnings.push(`${from} is a link, so it was not copied`); continue; }
    if (!st.isDirectory() && !st.isFile()) continue;
    const to = path.join(dest, name);
    if (lstat(to)) { report.warnings.push(`${from}: ${shown}/${name} is taken by a newer source, so it was not kept`); continue; }
    fs.mkdirSync(dest, { recursive: true });
    if (st.isDirectory()) {
      const copied = copyTree(from, to);
      report.files += copied.files;
      report.bytes += copied.bytes;
      for (const l of copied.skipped) report.warnings.push(`${from}: ${l} is a link, so it was not copied`);
    } else {
      fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
      report.files++;
      report.bytes += st.size;
    }
    report.keptPublished.push({ from, to: `${shown}/${name}` });
    report.warnings.push(`${from}: kept in ${shown}/${name} (no published.json)`);
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
  const report = { out: outDir, dest, dryRun, ok: false, status: 'failed', reason: '', sources: [], chats: 0, replaced: 0, artifacts: 0, sameCopied: 0, rewrittenFiles: 0, unmappedLinks: [], keptPublished: [], files: 0, bytes: 0, viewer: null, warnings: [] };
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
      report.rejected = (report.rejected || 0) + extracted.rejected.length;
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
      // A chat's own published/ (a chat ZIP's): the pages its store read move into the root artifacts/; anything else
      // in it stays in the chat's published/.
      const own = publishedBase(c.dir);
      const skipTop = new Set([...(c.single ? VIEWER_NAMES : []), ...(own ? ['published'] : [])]);
      const copied = copyTree(c.dir, path.join(building, c.out), { skipTop });
      report.files += copied.files;
      report.bytes += copied.bytes;
      for (const l of copied.skipped) report.warnings.push(`${c.dir}: ${l} is a link, so it was not copied`);
      const st = storeOf.get(c.archive);
      if (own) keepUnreadPublished(own, new Set(st ? st.store.published.map(page => page.abs) : []), path.join(building, c.out, 'published'), `${c.out}/published`, report);
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
    // The root published/ of mega sources: what no store read as a page is kept there, newest source first.
    for (const st of stores) {
      const base = st.archive.kind === 'mega' ? publishedBase(st.archive.root) : null;
      if (base) keepUnreadPublished(base, new Set(st.store.published.map(page => page.abs)), path.join(building, 'published'), 'published', report);
    }
    // Every source's artifacts and published pages, in one artifacts/ store; the chats' links follow them.
    const at = now.toISOString();
    // claude.ai's list is in the merged archive when it was in a source (its manifest says so: readArtifactStore's
    // listFetched), an Export Changes too.
    const hadList = stores.some(st => st.store.listFetched);
    let written = null;
    if (merged.length) {
      written = writeArtifacts(merged, building, chosen, report);
      // The indexes the extension writes (export-core.js); viewer.html is linked, as the merge writes one.
      const indexOpts = { listed: hadList ? written.listed : null, exportedAt: at, thumbs: written.thumbs, viewer: true, base: 'artifacts/' };
      fs.writeFileSync(path.join(building, 'artifacts', 'index.md'), '\uFEFF' + core.artifactsIndexMd(written.rows, indexOpts), { flag: 'wx' });
      fs.writeFileSync(path.join(building, 'artifacts', 'index.html'), core.artifactsIndexHtml(written.rows, indexOpts), { flag: 'wx' });
      // The sources' artifact warnings, which notes still point at ("see errors.txt"), one section per source.
      const reports = [];
      for (const st of stores) {
        const at = st.store.kind === 'artifacts' ? lib.realFileUnder(st.archive.root, 'errors.txt') : lib.realFileUnder(st.archive.root, 'artifacts/errors.txt');
        if (at) reports.push(`## From ${st.label}${stores.filter(x => x.label === st.label).length > 1 ? ` (${path.basename(st.archive.root)})` : ''}\n\n${fs.readFileSync(at, 'utf8').replace(/^\uFEFF/, '').trim()}\n`);
      }
      if (reports.length) fs.writeFileSync(path.join(building, 'artifacts', 'errors.txt'), `# Artifact warnings from the merged archives\n\n${reports.join('\n')}`, { flag: 'wx' });
    }
    rewriteLinks(chosen, stores, written ? written.places : new Map(), building, report);
    fs.writeFileSync(path.join(building, 'index.md'), indexMd(chosen, sources, at, merged.length), { flag: 'wx' });
    fs.writeFileSync(path.join(building, 'export-manifest.json'), JSON.stringify({
      format: 1, exported_at: at, kind: 'merged', since: null, listed: null,
      sources: sources.map(s => s.label),
      chats: chosen.map(c => ({ uuid: c.uuid, name: c.name, updated_at: c.updatedAt, folder: c.out, from: c.source })),
      // readArtifactStore reads this key for listFetched.
      // decided_at and listed_at: when claude.ai's lists were asked, so a later merge ranks this one by them.
      ...(written && hadList ? { artifacts: { listed: written.listed, thumbs: written.thumbs, decided_at: merged.decidedAt,
        listed_at: Object.fromEntries(merged.filter(m => m.listed && m.listedAt).map(m => [m.uuid, m.listedAt])) } } : {}),
    }, null, 2), { flag: 'wx' });
    if (lstat(dest)) throw new Error(`${dest} appeared while merging, so it was left alone`);
    fs.renameSync(building, dest);

    // One viewer for the merged archive.
    const archive = lib.findArchives(dest).archives.find(a => a.root === dest);
    report.viewer = archive ? await writeViewer(archive) : { status: 'failed', reason: 'the merged folder was not recognized as an archive' };
    if (report.viewer.status !== 'written') report.warnings.push(`viewer.html: ${report.viewer.reason || report.viewer.status}`);
    report.status = 'written';
    // A source file left out (refused ZIP entry) means the merge isn't whole: say so by the exit status too.
    report.ok = report.viewer.status === 'written' && !report.rejected;
    if (report.rejected) report.reason = `${report.rejected} source ZIP entr${report.rejected === 1 ? 'y was' : 'ies were'} not extracted (see the warnings)`;
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
  if (r.keptPublished && r.keptPublished.length) lines.push(`${r.keptPublished.length} published/ ${r.keptPublished.length === 1 ? 'entry' : 'entries'} with no published.json kept as they were`);
  if (r.unmappedLinks && r.unmappedLinks.length) {
    const broken = r.unmappedLinks.filter(l => l.broken).length;
    lines.push(`${r.unmappedLinks.length} link${r.unmappedLinks.length === 1 ? '' : 's'} left as they were${broken ? `, ${broken} broken in the merged archive (see Warnings)` : ''}`);
  }
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
