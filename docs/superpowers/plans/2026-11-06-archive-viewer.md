# Viewer for Older Archives Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `node tools/build_viewer.js <folder>` gives every Claude export under a folder the v1.6 viewer, including files the owner added later, and a `build-archive-viewer` skill wraps it.

**Architecture:** The pure extractors move from `popup.js` to a shared `export-core.js`, so the tool rebuilds exactly what an export would. `tools/archive-lib.js` finds archives and turns disk contents into the same `buildViewerChat` context the export passes. Added text lives in `viewer-files/part-NNNN.js` scripts loaded on demand, so `viewer.html` stays small.

**Tech Stack:** Node 20+ with no new packages, the vendored `jszip.min.js`, existing `takeout-viewer.js` and `viewer/`, Node's test runner, Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-11-06-archive-viewer-design.md`. Earlier viewer spec: `docs/superpowers/specs/2026-11-05-offline-viewer-design.md`.

## Global Constraints

- Never change, move or delete an existing archive file. Never touch an original ZIP.
- The tool writes only `viewer.html`, `viewer-check.gif` and `viewer-files/`.
- Exports stay byte-identical apart from `viewer.html`. JS and Python parity tests keep passing.
- Added HTML and SVG are untrusted, and run only in the v1.6 preview sandbox. Chat and added text reach the DOM only through `textContent` or the sanitized path.
- No cloud access, no re-downloading, and no new npm packages.
- Node 20+. Nothing `_`-prefixed in the repo. Synthetic test data only; never commit real chats.
- Extracted archives are untrusted: pass paths as arguments, and reject ZIP entries that leave the target folder.
- `sh tests/run.sh` passes after every task. `node --check` each edited `.js`.
- Commit as `bearspear`, on branch `feat/archive-viewer`, from `docs/archive-viewer-design`. Don't push without the owner's OK.

## Review Focus

1. A mega archive with one truncated or invalid `original.json`: that chat is reported, and the rest still get a viewer. Test in Task 3.
2. Disk full or a read-only folder during a run: no half-written `viewer.html`, no partial `viewer-files/`, and the run reports it and continues. Test in Task 5.
3. A chat folder nested in another archive's added folder, or an output folder inside the input folder: nothing is counted twice, and a run's output is never rescanned. Test in Task 2.
4. Symlinks in a folder, including loops: not followed, and no hang. Test in Task 2.
5. macOS decomposed names (`Gödel`) on disk against composed names in JSON: they match, and links use the name on disk. Test in Task 3.

---

## File Map

| File | Role |
|---|---|
| `export-core.js` (new) | Pure extractors moved from `popup.js`. Classic script, plus `module.exports` under Node. |
| `tools/archive-lib.js` (new) | Find archives, scan added files, build chat context from disk. |
| `tools/archive-zip.js` (new) | Extract a ZIP safely with JSZip. |
| `tools/build_viewer.js` (new) | CLI, writing, report. |
| `viewer/viewer-app.js`, `viewer/viewer-logic.js`, `viewer/viewer-template.html` | "Archive files" section. |
| `tests/archive.test.js`, `tests/e2e/archive.e2e.js` (new) | Tool tests, with fixtures built in code. |
| `~/.claude-personal/skills/build-archive-viewer/SKILL.md` (new) | The skill. Outside the repo, like `validate-export`. |

## Data Contract Additions

```text
ViewerData.added = [Added] | absent           // absent for exports, so export viewers don't change
Added = { path, chat: chatId|null, kind, size, href: string|null, part: int|null, key: string|null }
        // path: relative to the archive root, on-disk spelling
        // chat: owning chat, or null for files at a mega archive's root (shown with every chat)
        // kind: same values as GenFile.kind
        // part/key: text is window.__archivePart data in viewer-files/part-NNNN.js
```

---

### Task 1: Move shared extractors to `export-core.js`

**Files:**
- Create: `export-core.js`
- Modify: `popup.js`, `popup.html`, `sidepanel.html`, `tests/helpers.js`, `tests/export.test.js`, `tests/e2e/make-viewer.js`, `CLAUDE.md`

**Interfaces:**
- Produces, as top-level functions plus `module.exports`: `fixMojibake`, `isTextFile`, `getMessageChain`, `failedToolUseIds`, `isBashTool`, `heredocPath`, `HEREDOC_RE`, `heredocFiles`, `extractArtifacts(data, errorCollector, index)`, `extractUploadedFiles(data, organizationId)`, `extractPresentedFiles`, `extractDeliveredFiles`, `getModelName`, and new `buildViewerDeliveries(deliveredFiles) -> { [uuid]: { filename, path } }`, holding the first-name-wins loop now inline in `populateConversationFolder`.

- [ ] **Step 1: Write a failing guard test** in `tests/export.test.js`: `require('../export-core.js')` exports each name above; `popup.html` and `sidepanel.html` load `export-core.js`, then `takeout-viewer.js`, then `popup.js`, in that order.

- [ ] **Step 2: Run** `node --test tests/export.test.js`. Expected: FAIL.

- [ ] **Step 3: Record a baseline.** Before moving anything, write to the scratchpad the full output of `populateConversationFolder` on the fixture, every path and its bytes minus date lines, using the in-memory folder stub in `tests/export.test.js`.

- [ ] **Step 4: Move the code unchanged.** Include everything those functions need, such as the mojibake map, `typeToExt` and helpers. `convertToMarkdown` and the writers stay in `popup.js`. In `tests/helpers.js`, load `export-core.js` into the VM first. Make `tests/e2e/make-viewer.js` use `export-core.js` instead of loading `popup.js`.

- [ ] **Step 5: Verify.** `sh tests/run.sh`, then compare against the baseline. Expected: 0 files differ. Run `export.e2e.js` and `panel.e2e.js`.

- [ ] **Step 6: Commit** "Move shared extractors out of popup.js".

---

### Task 2: Find archives and added files

**Files:**
- Create: `tools/archive-lib.js`, `tests/archive.test.js`

**Interfaces:**
- Produces:
  - `findArchives(root, { exclude: string[] }) -> { archives: Archive[], skipped: [{ path, reason }], zips: string[] }`
  - `Archive = { root, kind: 'single'|'mega', chats: [{ dir, relDir }], hasViewer: bool }`
  - `isGeneratedViewer(html: string) -> bool`
  - `scanAdded(archive) -> [{ path, chatDir: string|null, size }]`
  - `KNOWN_ROOT_FILES`, `KNOWN_DIRS`, `IGNORED_NAMES`

Rules from the spec: a folder with `index.md` and subfolders holding `original.json` is one mega archive. Any other folder with `original.json` is a single. `conversation.json` beside it, or JSON with no `chat_messages`, is skipped with reason `not a Claude chat`. Known root files: the §7 list plus `index.md`, `viewer.html`, `viewer-check.gif`. Known dirs: `responses`, `artefacts`, `attachments`, `uploads`, `project`, `projects`, `viewer-files`. Ignored: `.DS_Store`, `Thumbs.db`, `__MACOSX`, `.git`, `node_modules`, dotfiles.

- [ ] **Step 1: Write failing tests**, building folders in a temp dir:

```js
// one single, one mega with a chat in a renamed folder, one parent of two singles
assert.strictEqual(find(tmp).archives.filter(a => a.kind === 'mega').length, 1);
// Review Focus 3
fs.mkdirSync(`${tmp}/single/synthesis/old-copy`, { recursive: true }); // holds its own original.json
assert.strictEqual(find(tmp).archives.length, before); // inside an archive: an added folder, not an archive
assert.ok(!findArchives(tmp, { exclude: [`${tmp}/out`] }).archives.some(a => a.root.startsWith(`${tmp}/out`)));
// Review Focus 4
fs.symlinkSync(tmp, `${tmp}/single/loop`);
assert.ok(find(tmp)); // returns, no hang
assert.ok(!scanAdded(single).some(f => f.path.startsWith('loop')));
// Gemini
assert.deepStrictEqual(find(tmp).skipped.map(s => s.reason), ['not a Claude chat']);
// Added
assert.deepStrictEqual(scanAdded(single).map(f => f.path), ['_index.md', 'synthesis/a.md']);
assert.ok(!scanAdded(single).some(f => /^uploads\/|\.DS_Store/.test(f.path)));
// Marker
assert.ok(isGeneratedViewer('<meta name="generator" content="Claude Takeout">'));
assert.ok(isGeneratedViewer('<script id="data" type="application/json">{}</script> function chainFrom('));
assert.ok(!isGeneratedViewer('<html>my own page</html>'));
```

- [ ] **Step 2: Run** `node --test tests/archive.test.js`. Expected: FAIL.

- [ ] **Step 3: Implement.** Walk with `lstat` and never follow symlinks. Once a folder is an archive, don't descend for more archives. In a mega, added files in a chat folder get that `chatDir`; root ones get `null`. Add `<meta name="generator" content="Claude Takeout">` to `viewer/viewer-template.html`.

- [ ] **Step 4: Run** `sh tests/run.sh`. Expected: PASS.

- [ ] **Step 5: Commit** "Find archives and the files added to them".

---

### Task 3: Build chat context from disk

**Files:**
- Modify: `tools/archive-lib.js`, `tests/archive.test.js`

**Interfaces:**
- Consumes: `export-core.js`, `CTViewer` from `takeout-viewer.js`, `Archive`.
- Produces:
  - `chatFromDisk(archive, chat) -> { viewerChat: Chat, missing: string[], warnings: string[] }`, which throws only for unreadable JSON
  - `matchFile(expected, names) -> string|null`: exact, then NFC-equal, then loose; `null` if the loose match has two candidates

Passes `buildViewerChat` the same `ctx` as `populateConversationFolder`:
- `folder`: `chat.relDir`
- `model`: `modelLabel(data.model, getModelName(data))`
- `artifacts`: `extractArtifacts` output, overlaid with disk: text file on disk wins (BOM stripped, so inlined uploads and `replay_bash.py` results appear), binary gets `''`, and files only on disk are added
- `artifactIndex`, `deliveries` (`buildViewerDeliveries(extractDeliveredFiles(...))`), `heredocs: heredocFiles`, `fixText: fixMojibake`
- `uploads`: key `file.uuid || file.originalFilename`, `path` from `matchFile(file.filename, uploads/)`; `text` when `isTextFile` and at most `TEXT_EMBED_LIMIT`
- `project`: `fileDir` is `project/files`, or `../projects/<dir>/files` taken from the chat's `README.md` link. `fileNames` from that folder. `docs` from `project/*.md`, leaving out `prompt_template.md`. `instructions` from `project/prompt_template.md`, else `project.json`'s `prompt_template`.

- [ ] **Step 1: Write failing tests.**

```js
// Parity: a folder written by the real populateConversationFolder on the fixture
assert.deepStrictEqual(chatFromDisk(archive, chat).viewerChat, exportResult.viewerChat);
// Text survives a deleted artefact
fs.rmSync(`${dir}/artefacts/report.html`);
assert.ok(/* report.html GenFile still has its text */);
// Binary doesn't
fs.rmSync(`${dir}/artefacts/Minutes.odt`);
assert.deepStrictEqual(chatFromDisk(archive, chat).missing, ['Minutes.odt']);
// Older mega: no projects/, files in project/files/
// Renamed upload
assert.strictEqual(matchFile('p01_My Report.pdf', ['p01_My_Report.pdf']), 'p01_My_Report.pdf');
assert.strictEqual(matchFile('p01_a b.pdf', ['p01_a_b.pdf', 'p01_a-b.pdf']), null);
// Review Focus 5
assert.strictEqual(matchFile('p01_Gödel.md', ['p01_Gödel.md']), 'p01_Gödel.md');
// Review Focus 1
fs.writeFileSync(`${chatB}/original.json`, '{"chat_mess');
assert.throws(() => chatFromDisk(mega, b));
// Odd shapes lose detail, not the chat: a message with attachments: {} still returns the chat
```

- [ ] **Step 2: Run** `node --test tests/archive.test.js`. Expected: FAIL.

- [ ] **Step 3: Implement.** Read JSON with any BOM stripped. The `href` for a matched file uses the on-disk spelling.

- [ ] **Step 4: Run** `sh tests/run.sh`. Expected: PASS.

- [ ] **Step 5: Commit** "Rebuild a chat's viewer data from its folder".

---

### Task 4: Extract ZIPs safely

**Files:**
- Create: `tools/archive-zip.js`
- Modify: `tests/archive.test.js`

**Interfaces:**
- Produces: `extractZip(zipPath, destDir) -> Promise<{ files: number, bytes: number, rejected: string[] }>`, and `zipFreeSpaceOk(zipPath, destParent) -> { ok, needed, free }`, using `fs.statfsSync`.

- [ ] **Step 1: Write failing tests**, making ZIPs with `require('../jszip.min.js')`:

```js
// A name with ö round-trips; bytes of a binary match
// An entry '../escape.txt' and an absolute entry are refused and listed in rejected
assert.ok(!fs.existsSync(path.join(tmp, 'escape.txt')));
// A symlink entry (unixPermissions 0o120777) is refused
// __MACOSX/ entries are skipped
// An existing destDir: extractZip rejects, and writes nothing
// A corrupt ZIP rejects with a clear message
```

- [ ] **Step 2: Run.** Expected: FAIL.

- [ ] **Step 3: Implement.** Load with `JSZip.loadAsync(fs.readFileSync(zipPath))`, and refuse files over 2 GB with a clear message. Extract into `destDir + '.partial'`, then rename, so a failed run leaves nothing that looks finished. Resolve each entry and check it stays under the target.

- [ ] **Step 4: Run** `sh tests/run.sh`. Expected: PASS.

- [ ] **Step 5: Commit** "Extract archives safely".

---

### Task 5: The command

**Files:**
- Create: `tools/build_viewer.js`
- Modify: `takeout-viewer.js`, `tools/archive-lib.js`, `tests/archive.test.js`

**Interfaces:**
- Usage: `node tools/build_viewer.js <folder> [--out <folder>] [--force] [--dry-run] [--json]`. Exit code 0 when clean, 1 if any archive failed. `--out` is required when ZIPs are found.
- `assembleViewer` gains `fileScripts: bool`: when true, ` file:` is added to `script-src` in the assembled page. Exports never set it, so their page and its policy stay as they are.
- Produces: `writeViewer(archive, { force, dryRun }) -> { status: 'written'|'skipped'|'failed', reason, chats, missing, added, warnings }`, and `buildParts(added) -> { entries: Added[], parts: [{ name, body }] }`.
- Constants: `PART_LIMIT = 4 * 1024 * 1024`. Text kinds embed in parts when at most `TEXT_EMBED_LIMIT`; bigger ones get `href` only. A part is `window.__archivePart(n, <escapeJson data>);`.

- [ ] **Step 1: Write failing tests.**

```js
// Every pre-existing file is byte-identical after a run: hash the tree before and after
// Only viewer.html, viewer-check.gif and viewer-files/ are new
// --dry-run: tree unchanged, report lists what would happen
// A viewer exists: skipped. --force on a marked one: replaced. --force on a hand-made one: refused
// An old mega gets one viewer at its root with all chats
// ZIP: extracted to <out>/<zip name>, viewer there, original ZIP hash unchanged
// ZIPs with no --out: clear message, exit 1, folders still processed
// Out folder exists: reported, not merged
// Too little free space (stub zipFreeSpaceOk): that ZIP is reported, the others run
// Review Focus 1: one bad original.json: the other chats get a viewer, and it's in the report as failed
// Review Focus 2: read-only archive folder: status failed, no temp files, the next archive still runs
// buildParts: a 5 MB set splits at PART_LIMIT; a part with </script> stays valid JS
// exports: assembleViewer without fileScripts equals the previous output
```

- [ ] **Step 2: Run** `node --test tests/archive.test.js`. Expected: FAIL.

- [ ] **Step 3: Implement.** Write into temp names beside the target, then rename, removing temps on failure. Replacing `viewer-files/` under `--force` happens last, by rename. Read viewer assets from the repo with `VIEWER_ASSETS`. Pass `exclude: [outDir]` to `findArchives`. Call `zipFreeSpaceOk` before each ZIP, and report and skip that ZIP when short. The default report is plain text: one line per archive, then missing files, then skipped folders. Full detail goes in `--json`.

- [ ] **Step 4: Run** `sh tests/run.sh`. Expected: PASS.

- [ ] **Step 5: Commit** "Add build_viewer for older archives".

---

### Task 6: "Archive files" in the viewer

**Files:**
- Modify: `viewer/viewer-app.js`, `viewer/viewer-logic.js`, `viewer/viewer-template.html`, `tests/viewer.test.js`
- Create: `tests/e2e/archive.e2e.js`

**Interfaces:**
- Consumes: `ViewerData.added`, the side panel's `renderFile`, `navigate`.
- Produces in `viewer-logic.js`: `addedTree(added, chatId) -> [{ name, files: Added[], folders: [...] }]`, `filterAdded(added, query) -> Added[]`.
- Produces in `viewer-app.js`: `loadPart(n) -> Promise<object>`, caching and adding one `<script src="viewer-files/part-NNNN.js">`. A failed load resolves to `null`.
- Added files use file ids `x<index>` in the hash. `resolveFile` treats them through a `GenFile` built from the `Added` entry, so the side panel renders them as it does generated files.

The section is a third fold in `#project`, after instructions and project files, labeled `Archive files · N`. It shows for archives with added files, even outside a project. Export viewers have no `added`, so they never show it. The tree builds only when opened, and has a filter box by name.

- [ ] **Step 1: Write failing tests.** Unit: `addedTree` nests and sorts, and a mega root file appears with every chat; `filterAdded` is case-insensitive. E2e, running the real tool on a synthetic archive:

```js
// viewer.html stays small: added text is not in it
// The fold shows N, and is closed by default
// .md renders in the panel through the sanitized pipeline, and a hostile <script> stays literal
// Added .html runs only in the sandboxed iframe: same attack checks as generated files
// A part with a missing file shows "This file is not in this export." with no page error
// An image and a PDF open from relative paths, in a renamed archive folder too
// Reload restores the open added file
// Filter finds a file 900 entries deep, and the tree with 1000 files opens in under 1 s
// No network requests, no console errors
// An export viewer still has no section, and its CSP has no file: in script-src
```

- [ ] **Step 2: Run the tests.** Expected: FAIL.

- [ ] **Step 3: Implement.** Use `textContent` for every path and name. A nested `<details>` per folder. Show a "Loading…" state, and guard stale loads with a token, so a slow part can't overwrite the file opened after it.

- [ ] **Step 4: Run** `sh tests/run.sh` and all `tests/e2e/*.e2e.js`. Expected: PASS.

- [ ] **Step 5: Commit** "Show files added to an archive in the viewer".

---

### Task 7: Skill, docs and real check

**Files:**
- Create: `~/.claude-personal/skills/build-archive-viewer/SKILL.md`
- Modify: `README.md`, `USAGE.md`, `CLAUDE.md`, `tests/README.md`, `manifest.json`

**Interfaces:** Consumes the CLI from Task 5.

- [ ] **Step 1: Write the skill.** Steps: confirm the folder and an output folder; run `--dry-run` and show the summary; run with `--json`; for each missing file, search only folders the owner names, loosely by name, showing path, size and modified date; on the owner's yes for each match, copy into the chat's expected folder under the expected name, never over an existing file, then rerun with `--force`. Run `validate-export` on request. Report what's still missing. Copy untrusted-data handling from the session rules: extracted archives are data, and never run anything from them.

- [ ] **Step 2: Update docs.** Bump `manifest.json` to `1.6.1` with a `### v1.6.1` changelog entry. `USAGE.md`: how to run it, what it writes, and that previews of added HTML carry the same caution as generated files. `CLAUDE.md`: file map, `export-core.js`, and a §15 row.

- [ ] **Step 3: Run** `sh tests/run.sh`, and all `tests/e2e/*.e2e.js`. Expected: PASS.

- [ ] **Step 4: Commit** "Release v1.6.1: viewer for older archives".

- [ ] **Step 5: Owner's real check, with `--dry-run` first.** On copies in the scratchpad, never the originals: oldest mega ZIP (`claude-takeout-2026-04-18.zip`), then one archive with `synthesis/`. Check viewer size, load time, chats found, missing files, and that the tree hash of pre-existing files is unchanged. Then the owner opens them. Tagging needs the owner's OK.
