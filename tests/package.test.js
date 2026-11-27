const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const JSZip = require('../jszip.min.js');
const P = require('../tools/package_extension.js');

test('package: every file the extension references is packaged, and nothing is missing', () => {
  assert.deepStrictEqual(P.problems(), []);
  const files = new Set(P.packageFiles());
  for (const ref of P.runtimeRefs()) assert.ok(files.has(ref), ref);
});

test('package: the references include the pages, injected scripts and viewer assets', () => {
  const refs = P.runtimeRefs();
  for (const f of ['popup.html', 'sidepanel.html', 'background.js', 'content.js', 'session-core.js', 'injected.js',
    'popup.js', 'export-core.js', 'viewer/viewer-template.html', 'viewer/artifacts-template.html']) assert.ok(refs.includes(f), f);
});

test('package: no developer files', () => {
  for (const f of P.packageFiles()) {
    assert.ok(!/^(tests|docs|tools|\.superpowers|\.claude)\//.test(f), f);
    assert.ok(!/\.(py|md)$/.test(f), f);
  }
});

test('package: a reference left out of the list is reported', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-'));
  try {
    for (const f of P.packageFiles()) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.copyFileSync(path.join(__dirname, '..', f), path.join(dir, f));
    }
    const popup = path.join(dir, 'popup.html');
    fs.writeFileSync(popup, fs.readFileSync(popup, 'utf8').replace('</body>', '<script src="extra.js"></script></body>'));
    assert.ok(P.problems(dir).some(p => p.startsWith('extra.js ')), P.problems(dir).join('; '));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('package: the ZIP holds exactly the list, named by the manifest version', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-out-'));
  try {
    const r = await P.buildZip(out);
    const version = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8')).version;
    assert.strictEqual(path.basename(r.target), `claude-takeout-${version}.zip`);
    const zip = await JSZip.loadAsync(fs.readFileSync(r.target));
    const names = Object.keys(zip.files).filter(n => !zip.files[n].dir).sort();
    assert.deepStrictEqual(names, P.packageFiles().slice().sort());
    assert.strictEqual(JSON.parse(await zip.file('manifest.json').async('string')).version, version);
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});
