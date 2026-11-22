# One Folder per Artifact Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Export All and Export Artifacts store each artifact once, as `artifacts/<Title>_<shortId>/<ver>/` with `artifact.json` format 2; `published/` leaves Export All; `merge_archives.js` and `build_viewer.js` read every older layout and handle artifacts.

**Architecture:** A shared store writer in `popup.js` (one record per uuid, one folder per version) is used by `savePublishedPages` in Export All and by `runArtifactStep`; `artifact.json` format 2 replaces `published.json` there. `tools/archive-lib.js` gains one reader that normalizes every layout (pre-1.17, 1.17, 1.18, standalone Export Artifacts) into one model, which `build_viewer.js` turns into viewer data and `merge_archives.js` merges and writes in the 1.18 layout, rewriting chat links.

**Tech Stack:** Chrome MV3 extension (classic scripts), Node 20 CLI tools, JSZip, Node's test runner, playwright-core e2e.

**Spec:** `docs/superpowers/specs/2026-11-22-one-folder-artifacts-design.md` (read it; every *my call* there is binding). Earlier designs: `docs/superpowers/specs/2026-11-21-combined-export-design.md`. Primer: `CLAUDE.md`.

## Global Constraints

- Branch `one-folder-artifacts`. Commits as bearspear with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (always this trailer). Never stage `.claude/`, `.superpowers/`, `.DS_Store`. No pushes.
- `sh tests/run.sh` passes after every task; `node --check` every edited JS file.
- Layout: `artifacts/<Title>_<shortId>/artifact.json` + `<ver>/` per version (`publishedSegment(ver)`; no id → `current`). Nothing else loose in an artifact folder.
- `artifact.json` `format: 2`; fields per the spec's "artifact.json (format 2)" section, exactly those names (`listed`, `current`, `versions`, `sameAs`, `publishedIn` entries with `same`/`writtenAs`).
- Export All writes no `published/`. Single-chat ZIP exports keep `published/` and `published.json` unchanged.
- Docs note copy: "Text rebuilt from the chat <chat title>." (when a linked chat in this export rebuilt it).
- Unlisted heading copy in `artifacts/index.*`: "Published from chats, not in claude.ai's list".
- Viewer copy when claude.ai's list isn't in the export (All / Yours / Shared): "claude.ai's list isn't in this export".
- Sources are never modified; the tools write only what CLAUDE.md allows (`viewer.html`, `viewer-check.gif`, `viewer-files/`, new folders under `--out`, temporary names).
- No picture URL, asset token or frame URL in any written file, status, warning, console or log. Preview sandbox and guard frame unchanged.
- Version 1.18.0 (manifest + README) in the last task only.
- e2e env: `PW=/private/tmp/claude-501/-Users-mbehringer-Downloads-claude-takeout/6422b81e-cafb-4efe-bae0-40de0502bcc8/scratchpad/pw/node_modules/playwright-core CHROME_EXE="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"`. `viewer.e2e.js` has 3 known PDF-viewer failures.

## Review Focus

1. Merging a 1.17 combined archive (with `savedIn` pointers) and a newer 1.18 archive of the same account: every version appears once, chat links in both chats open their pages, nothing lost. (Task 5 test.)
2. A chat whose two publishes are the same version under different names (`_2`) and `same` in one but not the other: one `<ver>/` folder or one `sameAs`, and both chats' links resolve. (Task 2 test.)
3. Export All with the artifacts setting off on an account that published pages from chats: `artifacts/` holds them, `artifacts/index.*` lists them under the unlisted heading, the viewer shows the Artifacts entry with the "list isn't in this export" note on All. (Tasks 2 and 3 tests.)
4. A merge where one source's chat folder was renamed (`_2`) because of a collision: rewritten links point at the right chat-relative paths. (Task 5 test.)
5. `build_viewer --force` on a 1.17 combined archive (not converted): the viewer keeps the Artifacts screen and resolves `savedIn` previews. (Task 4 test.)

---

### Task 1: The store and `artifact.json` format 2; Export Artifacts uses it

**Files:**
- Modify: `popup.js` (`saveArtifact`, `runArtifactStep`, `artifactsIndexHtml`/`artifactsIndexMd`, `exportArtifacts`)
- Test: `tests/export.test.js`

**Interfaces:**
- Produces (popup.js, function declarations):
  - `function artifactStore(root, { prefix }) -> Store` where `Store = { record(uuid) -> Rec, has(uuid, ver) -> boolean, versionFolder(rec, ver) -> string /* root-relative '<prefix><dir>/<verFolder>/' */, write(rec) /* artifact.json */, records() -> Rec[] }`. `Rec = { uuid, shortId, dir, title, listed, current, meta: {...list fields}, versions: Map<ver, VersionRec> }`, `VersionRec` = the spec's per-version object (+ in-memory `preview`, non-enumerable).
  - `function artifactJsonV2(rec) -> object` (the exact format-2 JSON; pure; unit-testable).
  - `runArtifactStep(root, opts)` gains `opts.store` (a Store); with it, the current version goes into `store.versionFolder(rec, ver)` unless `store.has(uuid, ver)` and that version is whole; `artifact.json` is written via `store.write` once per artifact after the step.
- Standalone Export Artifacts: `prefix: ''`, its own Store; layout per spec; index lists each artifact once with its versions (only the current here).

- [ ] **Step 1: Failing tests:**
  - `artifactJsonV2 writes format 2 with versions, listed and current` (exact key set; a `same` version has `sameAs` and no `folder` files; publishedIn entries keep `same`/`writtenAs`).
  - `Export Artifacts writes <Title>_<id>/<ver>/ and artifact.json format 2` (no files loose in the artifact folder; `index.html` links `<Title>_<id>/<ver>/index.html`; Docs and typed artifacts: only `artifact.json`).
  - `a version with no id goes to current/`.
  - Existing Export Artifacts tests updated to the new paths (say which in the report).
- [ ] **Step 2:** Run `node --test --test-name-pattern="format 2|<Title>_<id>|no id goes" tests/export.test.js` — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `sh tests/run.sh` — pass.
- [ ] **Step 5:** Commit — "Artifacts store: one folder per artifact, artifact.json format 2".

---

### Task 2: Export All writes every published page into the store

**Files:**
- Modify: `popup.js` (`savePublishedPages`, `publishedJson`/`writeSharedPublished` (Export All path only), `publishedReadmeLines`, `publishedLinks`/`publishedLines`, `publishedReuse`, `bulkExportZip`), `takeout-viewer.js` only if published-card hrefs are built there
- Test: `tests/export.test.js`

**Interfaces:**
- Consumes: Task 1's `artifactStore`, `artifactJsonV2`, `runArtifactStep({ store })`.
- Produces: in Export All, `sharedProjects.store` (one Store, prefix `artifacts/`) created before the chat loop, seeded with the list's titles (`store.record(uuid)` titled from the list when listed); `savePublishedPages` in Export All writes each version into `store.versionFolder(rec, ver)` and adds `publishedIn`; links from chats (`README.md`, `full_chat.md`, viewer published cards) are `../artifacts/<dir>/<verFolder>/<file>` (or the chat's own `artefacts/<writtenAs>` for a `same` version, as today).
- `publishedReuse` is removed (or reduced to "version folder exists and is whole"); `savedIn` is gone; `sameAs` per spec (first publish whose chat is in the export and files match; one-file only; multi-file `same` copied).
- `artifact.json` per artifact written after the artifact step (or after the chats when the setting is off), `listed` from the list (false when no list), the Docs note copy when `docFile`-style link exists (a `made` link from a chat in this export).
- `artifacts/index.*` written whenever the store has records; unlisted ones under the heading copy.
- Single-chat ZIP path: unchanged (`published/`, `published.json`).

- [ ] **Step 1: Failing tests:**
  - `Export All writes no published/ and puts chat publishes in artifacts/<Title>_<id>/<ver>/`.
  - `a listed artifact's folder uses the list title from the first chat publish`.
  - `the artifact step adds the current version only when its folder isn't there` (fetch counts).
  - `Review Focus 2: same version under two names` — one folder or one `sameAs`; both chats' links resolve to existing files.
  - `Review Focus 3: setting off` — `artifacts/` with the chat pages, `listed: false`, index unlisted heading, no list call.
  - `Docs note names the chat that rebuilt it`.
  - `single-chat ZIP still writes published/ and published.json` (unchanged bytes for an existing fixture).
  - Token scan over a combined Export All (extend the v1.17 test).
- [ ] **Step 2:** Run those — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `sh tests/run.sh` — pass; refresh `tests/fixtures/export-baseline.json` per `tests/README.md` only if the Export All baseline changed, and say so.
- [ ] **Step 5:** Commit — "Export All: one artifacts/ store, no published/".

---

### Task 3: Viewer on the 1.18 layout

**Files:**
- Modify: `takeout-viewer.js` (artifact views and published GenFile versions from the store), `popup.js` (`writeViewer` call), `viewer/artifacts-app.js`, `viewer/viewer-app.js` (Artifacts entry rule)
- Test: `tests/viewer.test.js`, `tests/e2e/combined.e2e.js`

**Interfaces:**
- Consumes: Task 2's Store records (pass `store.records()` to `writeViewer` as `opts.artifacts.records`, plus `listed` presence).
- Produces: `buildViewerData(chats, { exported, artifacts: { views, records, listed, exported, since } })`; each view gains `versions: [{ ver, label, folder, start, startSaved, same }]` from its record; `data.listFetched: boolean`.
- Viewer: All / Yours / Shared show only `listed` views; when `data.listFetched` is false they show the copy "claude.ai's list isn't in this export"; the Artifacts entry shows when there is any view or any In-chats file; version menu built from `view.versions`.

- [ ] **Step 1: Failing tests:** unit — views carry `versions`; unlisted views are not in All; `listFetched` false with records → entry present. e2e — a 1.18 Export All fixture: version menu lists all versions and each preview loads from `<ver>/`; setting-off fixture shows the note and In chats; Open artifact only for listed; no requests; guard checks unchanged.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `sh tests/run.sh`, `combined.e2e.js` (3 runs), `artifacts-viewer.e2e.js`, `published.e2e.js`, `viewer.e2e.js` (3 known failures only).
- [ ] **Step 5:** Commit — "Viewer reads the one-folder layout".

---

### Task 4: Reading every layout from disk; build_viewer keeps artifacts

**Files:**
- Modify: `tools/archive-lib.js` (new reader; `publishedOnDisk`/`chatFromDisk` use it; `hasArtifacts` refusal removed from callers), `tools/build_viewer.js`
- Test: `tests/archive.test.js`, `tests/e2e/archive.e2e.js` (one combined case)

**Interfaces:**
- Produces (archive-lib.js):
  - `function readArtifactStore(archiveRoot) -> { layout: 'none'|'published'|'v17'|'v18'|'standalone-flat'|'standalone-v18', exportedAt: string|null, listFetched: boolean, kind: string|null, records: Map<uuid, DiskRec> }`, `DiskRec = { uuid, shortId, title, meta, listed, current, versions: Map<ver, { abs: string /* folder on disk, or null */, files: [{ path, abs }], sameAs: { path: abs }|null, publishedIn: [...] , start }>, thumb: abs|null }`. Reads: chat-local and root `published/<dir>/published.json` (pre-1.17), 1.17 `artifacts/<dir>/artifact.json` (flat current + `savedIn` → resolve to the `published/` version), 1.18 format 2, standalone Export Artifacts (flat 1.15-1.17 and 1.18).
  - `function artifactViewsFromDisk(store, chatFolders) -> { views, payloads }` building the same `ArtifactView` records and preview payloads the extension writes (reuse `CTViewer`/takeout-viewer helpers; no duplicated logic).
- build_viewer: archives with artifacts (any layout above) and standalone artifacts-only archives get the full viewer (chats + Artifacts screen) or the artifacts-only page; `--force` still required when a generated viewer exists; refusal removed.

- [ ] **Step 1: Failing tests:** `readArtifactStore` on a fixture for each layout (pre-1.17 mega and single-chat, 1.17 with `savedIn`, 1.18, standalone flat, standalone 1.18) returns the same normalized records for the same data; `build_viewer --force on a 1.17 combined archive keeps the Artifacts screen and resolves savedIn previews` (Review Focus 5); `build_viewer on a standalone Export Artifacts archive`; refusal tests from v1.17 removed/inverted.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `sh tests/run.sh`; `archive.e2e.js`.
- [ ] **Step 5:** Commit — "Old-archive tools read every artifacts layout; build_viewer keeps the Artifacts screen".

---

### Task 5: merge_archives writes one 1.18 store and rewrites chat links

**Files:**
- Modify: `tools/merge_archives.js` (replace `mergePublished`; remove the refusal), `tools/archive-lib.js` (link rewriter helper)
- Test: `tests/merge.test.js`

**Interfaces:**
- Consumes: Task 4's `readArtifactStore`, `artifactViewsFromDisk`; Task 1's format-2 shape (re-implemented as a pure writer in archive-lib: `artifactJsonV2FromDisk(rec)` producing the same keys — share the key list with popup.js via a test that compares both outputs on the same input).
- Produces: `function rewriteChatLinks(text, map) -> { text, unmapped: string[] }` where `map(target) -> newTarget|null` for targets starting `../published/` or `published/`; applied to the merged copies of `README.md`, `full_chat.md`, `integrated_chat.md`, `responses/*.md`.
- Merge rules exactly as the spec's "merge_archives.js" section and its *my calls* (newest source per version by `exported_at`; union of versions and `publishedIn`; `listed` from the newest full source whose artifact step ran; `sameAs` re-pointed by sha256 or bytes copied; single-chat `published/` moved to root; thumbs from newest; artifacts-only sources accepted; output always Export All shape with `kind: "merged"`).

- [ ] **Step 1: Failing tests:** merge of (a) pre-1.17 mega + single-chat, (b) 1.17 combined + 1.18 (Review Focus 1), (c) colliding chat names (Review Focus 4), (d) only standalone artifacts sources, (e) a deleted-on-claude.ai artifact (newer full source unlists it), (f) a `sameAs` whose chat copy differs (bytes copied), (g) an unmappable link (left as is, reported); every merged chat link to a page resolves to an existing file; sources unchanged (hash before/after); `--dry-run` writes nothing.
- [ ] **Step 2:** Run `node --test tests/merge.test.js` — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `sh tests/run.sh`.
- [ ] **Step 5:** Commit — "merge_archives: one artifacts store, links rewritten".

---

### Task 6: Docs and version 1.18.0

**Files:** `README.md` (changelog `### v1.18.0`, layout), `USAGE.md` (layout, merge, build_viewer, setting-off behaviour), `TECHNICAL.md` (store, format 2, reader, merge rules, link rewriting), `CLAUDE.md` (§2, §5.3 publish rows, §7 layouts, §11 if warning text changed), `tests/README.md`, `manifest.json` → `1.18.0`; the `build-archive-viewer` skill lives outside this repo — note the needed change in the report only.
- [ ] **Step 1:** Write from the code as built (grep every name). Confirm in the report that `extract_artifacts.py` and `replay_bash.py` read only `artefacts/` and are unaffected (spec Constraints).
- [ ] **Step 2:** `sh tests/run.sh` (version test).
- [ ] **Step 3:** Commit — "One folder per artifact docs and version (v1.18.0)".
