// Safe ZIP extraction for archive-viewer tooling. ZIPs are untrusted input: the ZIP itself is only
// ever read, entries that could escape the target are refused, and a failed run removes only the
// '.<name>.partial' folder it created. CommonJS, Node stdlib plus the vendored JSZip.
const fs = require('fs');
const path = require('path');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const JSZip = require('../jszip.min.js');

const MAX_ZIP_BYTES = 2 * 1024 * 1024 * 1024;
const GB = 1024 * 1024 * 1024;
const SYMLINK = 0o120000;
const TYPE_MASK = 0o170000;
// Per-entry filesystem errors that mean this name can't be stored here; the rest of the ZIP goes on.
const NAME_ERRORS = new Set(['EEXIST', 'ENOTDIR', 'ENAMETOOLONG', 'EISDIR', 'EINVAL']);

const mb = n => (n / (1024 * 1024)).toFixed(1) + ' MB';

// Returns a reason string if the entry name is unsafe, '' if fine.
function unsafeName(name, target) {
  if (name.includes('\0')) return 'contains a NUL byte';
  if (name.startsWith('/') || name.startsWith('\\')) return 'absolute path';
  if (/^[A-Za-z]:/.test(name)) return 'drive letter';
  if (name.split(/[\\/]/).includes('..')) return 'contains ".." segment';
  const full = path.resolve(target, name);
  if (full !== target && !full.startsWith(target + path.sep)) return 'resolves outside the target folder';
  return '';
}

const isSkipped = name => name.split('/').some(s => s === '__MACOSX' || s === '.DS_Store');

// The number of entries the ZIP's central directory declares, or null when it can't be told
// (ZIP64, or no end record found).
function declaredEntryCount(buf) {
  const stop = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= stop; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      const count = buf.readUInt16LE(i + 10);
      return count === 0xffff ? null : count;
    }
  }
  return null;
}

// Loads the ZIP once. Pass the result to zipEntryNames, zipFreeSpaceOk and extractZip as `loaded`,
// so a big ZIP is read and parsed once, not once per step.
async function loadZip(zipPath) {
  const size = fs.statSync(zipPath).size;
  if (size > MAX_ZIP_BYTES) {
    throw new Error(`ZIP is ${mb(size)}, over the 2 GB limit this tool can read safely: ${zipPath}`);
  }
  let zip;
  const buf = fs.readFileSync(zipPath);
  try {
    zip = await JSZip.loadAsync(buf);
  } catch (e) {
    throw new Error(`Not a valid ZIP file (${e.message}): ${zipPath}`);
  }
  // JSZip keys entries by their cleaned names, so 'x/../original.json' silently replaces
  // 'original.json'. Fewer entries than the ZIP declares means two collided.
  const declared = declaredEntryCount(buf);
  const collided = declared !== null && declared > Object.keys(zip.files).length;
  return { zip, size, collided };
}

function declaredSize(entry) {
  const d = entry._data;
  return d && typeof d.uncompressedSize === 'number' ? d.uncompressedSize : 0;
}

// The staging folder beside dest. Dot-prefixed, so no ZIP's destination can have this name, and
// findArchives never treats it as an archive.
const partialOf = dest => path.join(path.dirname(dest), `.${path.basename(dest)}.partial`);

// opts.maxBytes overrides the zip-bomb limit (tests). opts.loaded: a loadZip result to reuse.
async function extractZip(zipPath, destDir, opts = {}) {
  const dest = path.resolve(destDir);
  const partial = partialOf(dest);
  if (fs.existsSync(dest)) throw new Error(`Destination already exists, not touching it: ${dest}`);
  if (fs.existsSync(partial)) {
    throw new Error(`A leftover from an earlier failed run of this tool exists. Remove it and run again: ${partial}`);
  }
  const { zip, size, collided } = opts.loaded || await loadZip(zipPath);
  if (collided) throw new Error(`Two entries in this ZIP have the same name once cleaned up, so one would hide the other. Not extracted: ${zipPath}`);
  const maxBytes = opts.maxBytes != null ? opts.maxBytes : size * 50 + GB;

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.mkdirSync(partial);
  const rejected = [];
  let files = 0;
  let bytes = 0;
  const tooLarge = () => new Error(
    `Extraction stopped: contents exceed ${mb(maxBytes)} (50 times the ZIP size plus 1 GB), which looks like a zip bomb.`);
  try {
    let declared = 0;
    for (const entry of Object.values(zip.files)) declared += declaredSize(entry);
    if (declared > maxBytes) throw tooLarge();

    for (const entry of Object.values(zip.files)) {
      // JSZip (3.8+) sanitizes entry.name on load; the raw name is what a hostile ZIP really holds.
      const name = entry.unsafeOriginalName || entry.name;
      if (isSkipped(name)) continue;
      if (unsafeName(name, partial)) { rejected.push(name); continue; }
      if (entry.unixPermissions != null && (entry.unixPermissions & TYPE_MASK) === SYMLINK) {
        rejected.push(name);
        continue;
      }
      const out = path.resolve(partial, name);
      let wrote = false;
      try {
        if (entry.dir) { fs.mkdirSync(out, { recursive: true }); continue; }
        fs.mkdirSync(path.dirname(out), { recursive: true });
        if (fs.existsSync(out)) { rejected.push(name); continue; } // duplicate entry name
        const counter = new Transform({
          transform(chunk, _enc, cb) {
            bytes += chunk.length;
            cb(bytes > maxBytes ? tooLarge() : null, chunk);
          },
        });
        wrote = true;
        await pipeline(entry.nodeStream('nodebuffer'), counter, fs.createWriteStream(out, { flags: 'wx' }));
        files++;
      } catch (e) {
        if (wrote) { try { fs.rmSync(out, { force: true }); } catch (_) { /* best effort */ } } // half-written file
        if (!NAME_ERRORS.has(e.code)) throw e; // bomb error and anything unexpected
        rejected.push(name);
      }
    }
    fs.renameSync(partial, dest);
  } catch (e) {
    fs.rmSync(partial, { recursive: true, force: true });
    throw e;
  }
  return { files, bytes, rejected };
}

// Needed = sum of uncompressed sizes + 10%. Async because reading entry metadata loads the ZIP.
async function zipFreeSpaceOk(zipPath, destParent, loaded = null) {
  const { zip } = loaded || await loadZip(zipPath);
  let total = 0;
  for (const entry of Object.values(zip.files)) total += declaredSize(entry);
  const needed = Math.ceil(total * 1.1);
  let dir = path.resolve(destParent);
  while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  const st = fs.statfsSync(dir);
  const free = st.bavail * st.bsize;
  return { ok: free >= needed, needed, free };
}

// Names as the ZIP holds them, for a look before extracting. Nothing is written.
async function zipEntryNames(zipPath, loaded = null) {
  const { zip } = loaded || await loadZip(zipPath);
  return Object.values(zip.files).map(entry => entry.unsafeOriginalName || entry.name);
}

module.exports = { loadZip, extractZip, zipFreeSpaceOk, zipEntryNames, partialOf, MAX_ZIP_BYTES };
