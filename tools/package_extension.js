#!/usr/bin/env node
// Builds the extension's ZIP for testers or the Chrome Web Store: only the files the extension loads at runtime,
// never tests/, docs/, tools/, the Python CLIs or the developer notes.
//
//   node tools/package_extension.js [--out <folder>]   (default: dist/)
//
// Writes <out>/claude-takeout-<version>.zip. Fails, writing nothing, when a file the extension references is missing
// from the list below or from disk, so a new script added to popup.html can't be left out of a release silently.
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// The root files the extension loads; every file in viewer/ is added (the viewer's sources and their notices).
const ROOT_FILES = [
  'manifest.json', 'background.js', 'content.js', 'injected.js', 'session-core.js', 'export-core.js',
  'popup.html', 'sidepanel.html', 'popup.js', 'takeout-viewer.js', 'jszip.min.js',
  'icon16.png', 'icon48.png', 'icon128.png',
];

function packageFiles(root = ROOT) {
  const viewer = fs.readdirSync(path.join(root, 'viewer'), { withFileTypes: true })
    .filter(d => d.isFile() && !d.name.startsWith('.'))
    .map(d => `viewer/${d.name}`)
    .sort();
  return [...ROOT_FILES, ...viewer];
}

// Every file the extension references: the manifest's, the pages' scripts, the viewer assets popup.js fetches and
// the scripts it injects.
function runtimeRefs(root = ROOT) {
  const refs = new Set();
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const add = v => { if (typeof v === 'string' && v) refs.add(v); };
  Object.values(manifest.icons || {}).forEach(add);
  Object.values((manifest.action && manifest.action.default_icon) || {}).forEach(add);
  add(manifest.action && manifest.action.default_popup);
  add(manifest.side_panel && manifest.side_panel.default_path);
  add(manifest.background && manifest.background.service_worker);
  for (const cs of manifest.content_scripts || []) (cs.js || []).concat(cs.css || []).forEach(add);
  for (const w of manifest.web_accessible_resources || []) (w.resources || []).forEach(add);
  for (const page of ['popup.html', 'sidepanel.html']) {
    const html = fs.readFileSync(path.join(root, page), 'utf8');
    for (const m of html.matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)="([^"#?:]+)"/g)) add(m[1]);
  }
  const viewer = require(path.join(root, 'takeout-viewer.js'));
  [...viewer.VIEWER_ASSETS, ...viewer.ARTIFACTS_VIEWER_ASSETS].forEach(add);
  const popup = fs.readFileSync(path.join(root, 'popup.js'), 'utf8');
  for (const m of popup.matchAll(/executeScript\([^)]*?files:\s*\[([^\]]*)\]/g)) {
    for (const f of m[1].matchAll(/'([^']+)'/g)) add(f[1]);
  }
  return [...refs].sort();
}

// The list's problems, as sentences; [] when it can be packaged.
function problems(root = ROOT) {
  const files = packageFiles(root);
  const listed = new Set(files);
  const out = [];
  for (const ref of runtimeRefs(root)) if (!listed.has(ref)) out.push(`${ref} is used by the extension but not packaged`);
  for (const f of files) {
    if (!fs.existsSync(path.join(root, f))) out.push(`${f} is missing`);
    // Chrome refuses to load an extension with a file or folder starting with _.
    if (f.split('/').some(part => part.startsWith('_'))) out.push(`${f} starts with _, which Chrome refuses`);
  }
  return out;
}

async function buildZip(outDir, root = ROOT) {
  const found = problems(root);
  if (found.length) throw new Error(found.join('\n'));
  const JSZip = require(path.join(root, 'jszip.min.js'));
  const { version } = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const zip = new JSZip();
  // A fixed date, so the same sources give the same ZIP.
  const date = new Date(Date.UTC(2020, 0, 1));
  for (const f of packageFiles(root)) zip.file(f, fs.readFileSync(path.join(root, f)), { date });
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
  fs.mkdirSync(outDir, { recursive: true });
  const target = path.join(outDir, `claude-takeout-${version}.zip`);
  fs.writeFileSync(target, bytes);
  return { target, version, files: packageFiles(root).length, size: bytes.length };
}

module.exports = { ROOT_FILES, packageFiles, runtimeRefs, problems, buildZip };

if (require.main === module) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--out');
  if (at >= 0 && !args[at + 1]) { console.error('--out needs a folder'); process.exit(2); }
  const outDir = path.resolve(at >= 0 ? args[at + 1] : path.join(ROOT, 'dist'));
  buildZip(outDir).then(r => {
    console.log(`Wrote ${r.target} (v${r.version}, ${r.files} files, ${(r.size / 1024).toFixed(0)} KB)`);
  }, e => { console.error(e.message); process.exit(1); });
}
