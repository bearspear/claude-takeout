# Export Artifacts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An "Export Artifacts" button next to Export All saves the current version of every artifact listed on claude.ai/artifacts, as a folder or a ZIP (the "Export All saves as" setting), with an index.

**Architecture:** `content.js` gains `listArtifacts` (claude.ai's own artifact list) and reuses `publishedPageInfo` / `publishedPageFile` from v1.14.0 for each artifact's current files; the token stays in content.js. A new popup function `exportArtifacts` walks the list and writes one folder per artifact through the same JSZip / `createDiskFolder` target Export All uses, plus `index.md`, `index.html`, `export-manifest.json` and `errors.txt`. Claude Docs are listed but not fetched (their text isn't in any file).

**Tech Stack:** Chrome MV3 extension, plain JS, Node test runner, Playwright e2e.

**Spec:** No separate spec doc. Owner decisions 2026-11-16: button next to Export All; every artifact the user can access, including ones shared with them (labelled "shared with you"); current version only; folder or ZIP follows the "Export All saves as" setting; a static `index.html` instead of a viewer for now (a viewer can follow). Observed 2026-11-16 on the owner's account (19 artifacts): `rel` mine 18 / shared 1 (`audience` public); `source_surface` chat 11, cowork 4, code 3, missing 1; `type_slug` `c8f0b311-af6a-4d22-a07b-61eb818fc35d` = Docs (6), `bcd2878f-a88d-4094-a616-8e39d8a5fd8a` = Design (4), missing = plain page (9); `live` always a ver-shaped string (`1794783850-4a6e`). Plan reviewed once; findings applied. Builds on v1.14.0 (published pages) and the spike (memory `claude-ai-docs-live-content.md`). Version v1.15.0. Branch `export-artifacts` from `main` (7265fb1).

## Global Constraints

- List endpoint (GET, read-only): `https://claude.ai/api/frame/frames?org=<org>&limit=1000` with header `X-Frame-CP: go`, `credentials: 'same-origin'` → `{ frames: [{ slug, title, type_slug, type_title, source_surface, live, rel, updatedAt, created_at, … }] }`. No paging parameter is known (observed: `offset`, `cursor`, `page`, `skip` ignored; limits 60/200/1000/none all returned 19). Warn once (`artifact_export`) that the list may be incomplete when its length is ≥ 60 and a multiple of 10, or equals 1000. `index.md` / `index.html` say "Listed by claude.ai: N".
- Fields are minimized twice: `listArtifacts` in content.js already returns only the allowed fields, and `artifactsFromList` checks them again. From each frame keep only: `slug` (uuid, validated by the v1.14.0 uuid rule), `title` (string), `typeSlug`, `typeTitle` (strings or ''), `sourceSurface` (`chat` | `code` | `cowork` | other string), `rel` (`mine` | `shared` | other), `live` (ver rule), `updatedAt`, `createdAt` (strings). Never keep `owner_email`, `owner_account`, thumbnails or any URL from the reply.
- Per artifact: `publishedPageInfo { uuid, ver: live }` (the listed version; '' only when `live` is missing or fails the ver rule, in which case `artifact.json` is written with the note "no published version" and nothing is fetched), then `publishedPageFile` per file with the resolved `ver`, exactly as v1.14.0 (caps 32 MB per file, 50 MB per artifact, SHA-256 checked in the popup, `artifact-type/` skipped, `publishedSegment` names, collisions `_2`). The token never leaves content.js; no frame URL in any written file.
- Claude Docs (`typeSlug === 'c8f0b311-af6a-4d22-a07b-61eb818fc35d'`, or, only when `type_slug` is missing, `typeTitle === 'Docs'`): not fetched; listed with title and link and the note "Claude Docs text isn't available as a file; export the chat that made it to get the document." Design and other typed artifacts: own files only. `publishedPageInfo` gains `runtimeSkipped: <count of artifact-type/ paths dropped>`; `needsRuntime = runtimeSkipped > 0 || typeSlug !== '' || publishedNeedsRuntime(startText)`. A typed artifact with no own files gets `artifact.json` only, with the note "open on claude.ai". Shared artifacts (`rel !== 'mine'`) are exported too and labelled "shared with you" in both indexes and `artifact.json`.
- Layout (export root): `claude-takeout-artifacts-<name>-<YYYY-MM-DD>_<HHMM>` (lowercase; `megaZipName(name, 'artifacts', stamp)` puts the kind first on purpose; without a name `claude-takeout-artifacts-<stamp>`), containing `<safeFileTitle(title)||'artifact'>_<shortId>/` per artifact with the current version's files at that folder's top level and `artifact.json` (`{ format: 1, uuid, shortId, url, title, typeTitle, sourceSurface, rel, ver, createdAt, updatedAt, files: [{ path, savedAs, size, contentType, sha256 }], missing: [path], incomplete, needsRuntime, note }`); plus root `index.md`, `index.html`, `export-manifest.json` (`{ format: 1, kind: 'artifacts', exported_at, listed, artifacts: [{ uuid, title, folder, ver }] }`) and `errors.txt` when there are warnings. `shortId` = `uuidToBase58(uuid)`; `url` = `https://claude.ai/artifact/<shortId>`. `artifact.json` is reserved inside the folder (any case: a page file `artifact.json` or `ARTIFACT.json` becomes `artifact_2.json`). The start file follows `publishedStart` (index.html, else the first .html, else the first file). Artifact folder names are tracked case-insensitively, as Export All's chat folders are.
- `index.html` is static, self-contained, no scripts; every value from claude.ai goes in escaped; links are relative to the artifact's start file (`<folder>/<startSaved>`, each segment `encodeURIComponent`) and the claude.ai URL rebuilt from the shortId. The CSP meta comes first in `<head>`: `default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'none'`; claude.ai links carry `rel="noopener noreferrer"`. `index.md` titles go through `mdLinkText`, and local link targets have `(` `)` percent-encoded.
- Warnings use a new type `artifact_export` with its own `_getRecoveryHint` case (one collector for the whole export, constructed with the label "Export Artifacts" so the report header doesn't claim a conversation), written to root `errors.txt`; a 401 warns once and stops fetching the rest. Export Artifacts ignores `megaZipScope` and never reads or writes `exportRecord`.
- The list is fetched before any folder or ZIP is made: an empty list → status "No artifacts on claude.ai.", nothing written; a list failure → the error status (401: "Sign in to claude.ai, then try again."), nothing written. The active tab must be claude.ai (Export All's message); calls go through `sendToTab` first, then `sendOnce`. Folder mode flushes after each artifact and writes `write-errors.txt` as Export All does.
- Button `exportArtifacts` (label "Export Artifacts (Folder)" or "(ZIP)" from `settings.megaFormat`) in popup.html and sidepanel.html right after `exportAllZip`; part of `EXPORT_BUTTONS` (one export at a time). Folder mode: picker straight from the click; from the popup, open the side panel with a note, as Export All does — the stored note becomes `{ at, button }` and the side panel names the right button ("Click Export Artifacts (Folder) here…"). The settings label "Export All saves as" becomes "Export All and Export Artifacts save as". No keyboard shortcut.
- Commit as bearspear with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; commit/push only with the owner's OK.

## Review Focus

1. An artifact shared with you whose files claude.ai refuses (403/404): listed in the index as not exported with a warning; the rest export. → Task 2 test.
2. A Claude Docs artifact: no fetch, a folder with only `artifact.json` carrying the note, an index row saying so. → Task 2 test.
3. Two artifacts with the same title: distinct folders (shortId differs). → Task 2 test.
4. A title or path from claude.ai containing HTML or `../`: escaped in `index.html`, sanitized in paths, nothing outside the export folder. → Task 2 and Task 3 tests.
5. Folder mode from the popup hands off to the side panel and never opens a picker in the popup. → Task 2 test (popup stub) mirroring Export All's.

---

### Task 1: List artifacts (content.js) and short ids (export-core.js)

**Files:** Modify `content.js`, `export-core.js` (+ `module.exports`); Test `tests/panel.test.js`, `tests/export.test.js`.

**Interfaces:**
- Produces `uuidToBase58(uuid) -> string` (inverse of `base58ToUuid`; '' for an invalid uuid) in export-core.js.
- Produces `artifactsFromList(reply) -> { artifacts: [...cleaned frames per Global Constraints, invalid slugs dropped, deduped by uuid], full: boolean }` in export-core.js (`full` = the reply had 500 frames).
- Produces content.js action `{ action: 'listArtifacts', withAccountName }` → `{ frames: <frames with only the allowed fields>, accountName, orgId }` (accountName through the existing `fetchAccountName`) or `{ error, status }` (codes only: `HTTP n`, `network`, `bad response` for non-JSON or `frames` not an array, `no org`; try/catch; always `sendResponse`; `return true`).
- Changes `publishedPageInfo` to also return `runtimeSkipped`.
- Produces `uuidToBase58` as the exact inverse of `base58ToUuid` (unpadded: no leading `1` for leading zero bytes).

- [ ] **Step 1: failing tests**
  - `uuidToBase58 round-trips with base58ToUuid` — `uuidToBase58('9fe94226-9819-4551-8836-a76d0c116102') === 'LkJGYP3ZBnSGbvhLfeWAG1'`; round trip for 50 random uuids; `uuidToBase58('x') === ''`.
  - `artifactsFromList keeps only the safe fields` — a frame with `owner_email`, `thumbImgURL`, a URL in `title`-adjacent fields, an invalid slug, a duplicate slug: result has no `owner`/`thumb`/URL keys, the invalid one dropped, one entry per uuid; `full` true only for 500 frames.
  - `listArtifacts sends X-Frame-CP, returns only allowed fields and codes on failure` (panel test, real content.js in vm; add a `/api/frame/frames` route before the harness's catch-all `/api/frame/` route) — 200 → frames without `owner_email`/`thumbImgURL`, plus `accountName`; 401 → `{ error: 'HTTP 401', status: 401 }`; non-JSON or `frames: {}` → `bad response`; no org → `no org`; a throwing fetch → `{ error: 'network' }`.
  - `publishedPageInfo counts the runtime files it drops` — `runtimeSkipped` equals the number of `artifact-type/` paths.
  - `uuidToBase58 keeps leading zero bytes unpadded` — a uuid starting `00` round-trips.
- [ ] **Step 2: run** `node --test tests/export.test.js tests/panel.test.js` — FAIL.
- [ ] **Step 3: implement.**
- [ ] **Step 4: run** the same, then `sh tests/run.sh` — PASS.
- [ ] **Step 5: commit** `List claude.ai artifacts; short ids from uuids`.

### Task 2: Export Artifacts (popup) and the button

**Files:** Modify `popup.js` (first, a refactor: lift the file-fetching core out of `savePublishedPages`'s `fetchVersion` closure into a top-level `fetchPublishedFiles({ target, prefix, uuid, ver, files, names, state, warn, fetchPublished })` used by both — caps, 50 MB total, SHA-256, the 401 latch, missing/incomplete, needsRuntime; the existing published-page tests must pass unchanged; `publishedSavedNames(paths, reserved = [])` pre-seeds reserved names lowercased; then the new section "Export Artifacts": `exportArtifacts(options)`, `saveArtifact`, `artifactsIndexMd`, the click handler mirroring Export All's folder/ZIP/popup-handoff; `applySettings` sets the label), `popup.html`, `sidepanel.html`; Test `tests/export.test.js`, `tests/helpers.js` (a `runArtifacts({ frames, pages, options, stored })` harness modeled on `runBulkZip` in tests/export.test.js, exported from helpers for Task 3's e2e, reusing `publishedFetcher`; `loadPopup` gains a `location` option so `IS_POPUP` can be true in tests).

**Interfaces:**
- Consumes `artifactsFromList`, `uuidToBase58` (Task 1); content.js `listArtifacts`, `publishedPageInfo`, `publishedPageFile`; existing `createDiskFolder`, `makeRunFolder`, `megaZipName`, `exportStamp`, `publishedSegment`, `publishedSavedNames`, `cleanPublishedInfo`, `ExportErrorCollector`.
- Produces `async function exportArtifacts({ directory } = {})` (no directory → ZIP download named `megaZipName(name, 'artifacts', stamp)`), writing the layout in Global Constraints.
- Produces `artifactsIndexHtml(rows) -> string`: rows `{ title, typeTitle, sourceSurface, rel, folder, startSaved, url, note, needsRuntime, fileCount, missingCount }`; a table sorted by title (case-insensitive), each title linking to the local start file when there is one, a "claude.ai" link, kind, source, notes; light/dark styles; CSP per Global Constraints; no scripts.
- `megaZipName(accountName, 'artifacts', stamp)` → `claude-takeout-artifacts-<name>-<stamp>.zip` (extend `megaZipName` for the new kind; existing kinds unchanged).

- [ ] **Step 1: failing tests**
  - `Export Artifacts saves each artifact's current files with artifact.json and an index` — two pages (one multi-file) → folders `<Title>_<shortId>/` with files at top level, `artifact.json` per Global Constraints, `index.md` table (title, kind, source, files or note), `export-manifest.json` `kind: 'artifacts'`; ZIP name `claude-takeout-artifacts-mika-<stamp>.zip`.
  - `Export Artifacts to a folder writes the same files` — `options.directory` = the FakeDir from the v1.12.0 tests; same file list as the ZIP.
  - `a Claude Docs artifact is listed with a note and not fetched` (Review Focus 2).
  - `an artifact claude.ai refuses is a warning; the rest export` (Review Focus 1) — 404 for one, 401 for a later one: one 401 warning, no further info calls.
  - `same-titled artifacts get distinct folders, and unsafe titles and paths stay inside` (Review Focus 3, 4).
  - `a full list of 500 warns that it may be incomplete`.
  - `nothing private or token-shaped reaches a file` — plant `owner_email`, `thumbImgURL`/`thumbDarkURLs`, a title holding a frame URL with `__frame_t=S`, an error reply `{ error: 'https://x.frame.claudeusercontent.com/a?__frame_t=S' }` and a `rejected` path; scan every written file for the email, `__frame_t`, `frame.claudeusercontent.com` and `S` as a token value.
  - `a typed artifact is marked needs claude.ai to run; one with no own files has only artifact.json` and `a missing live version writes the no-published-version note without fetching`.
  - `shared artifacts are exported and labelled shared with you`.
  - `an empty list or a failed list writes nothing and says why` and `Export Artifacts leaves the export record alone` (with `megaZipScope: 'changes'`, the stored record is unchanged).
  - `a page file named artifact.json or ARTIFACT.json becomes artifact_2.json`.
  - `index.md escapes titles and link targets` — a title with `](javascript:x)` and `<b>`, a folder with `(`.
  - `the recovery hint for artifact_export` names Export Artifacts, and the errors.txt header doesn't say Conversation.
  - `EXPORT_BUTTONS includes exportArtifacts; both pages label it from the setting`.
  - `the popup hands Export Artifacts and Export All in folder mode to the side panel` (Review Focus 5) — popup sandbox (`location` popup.html, `currentTabId` set): `chrome.sidePanel.open` called, no `showDirectoryPicker`; the stored note names the clicked button; in the side panel sandbox, `showDirectoryPicker` is called before anything is awaited.
  - `index.html escapes everything from claude.ai and links only local files and claude.ai` (Review Focus 4) — a title `<img src=x onerror=alert(1)>` appears escaped; hrefs are relative paths or `https://claude.ai/artifact/<shortId>`; the CSP meta is there; no `<script`.
- [ ] **Step 2: run** `node --test tests/export.test.js` — FAIL.
- [ ] **Step 3: implement** (pace requests like Export All: 200 ms between artifacts; progress bar "n / total").
- [ ] **Step 4: run** `node --test tests/export.test.js tests/panel.test.js`, then `sh tests/run.sh` — PASS.
- [ ] **Step 5: commit** `Add Export Artifacts: every artifact's current version, as a folder or ZIP`.

### Task 3: Browser test, docs, version

**Files:** Modify `manifest.json` (1.15.0), `README.md` (v1.15.0 entry; layout), `USAGE.md` (the button, what's exported, Docs limit, shared artifacts and that their HTML opened from disk is untrusted, the incomplete-list warning, "use Folder for large accounts" (ZIP holds everything in memory), Windows path length, that the old-archive and merge tools ignore an artifacts export), `TECHNICAL.md` (section "Export Artifacts"; the tools ignore `kind: 'artifacts'`), `CLAUDE.md` (§2 file map incl. artifacts.e2e.js, §3 table, §7 layout, §8 list endpoint, §9 megaFormat governs two buttons, §11 `artifact_export`), `tests/README.md`; Test new `tests/e2e/artifacts.e2e.js`, `tests/archive.test.js` (an artifacts export → no archives found). Follow-up outside this repo: the validate-export skill should recognize or skip `kind: 'artifacts'`.

**Interfaces:** Consumes `exportArtifacts` and `artifactsIndexHtml` (Task 2).

- [ ] **Step 1: failing test** e2e `artifacts.e2e.js`: build an export with Task 2's harness, open its `index.html` over file:// — rows present and sorted, a title link opens the artifact's page file, a Docs row has its note and no local link, no network requests, no page errors.
- [ ] **Step 2: run** it — FAIL (the file doesn't exist yet; an e2e can't fail on behaviour before it exists).
- [ ] **Step 3: implement** the test; update the docs; bump the manifest.
- [ ] **Step 4: run** `sh tests/run.sh` and the e2e — PASS.
- [ ] **Step 5: commit** `Export Artifacts browser test and docs (v1.15.0)`.
- [ ] **Step 6 (owner):** reload the extension, click Export Artifacts (folder and ZIP), open `index.html`; check a Design artifact, a Docs artifact, the shared one and a published page; the index's "Listed by claude.ai" equals the count on claude.ai/artifacts; `grep -rl "__frame_t\|frame.claudeusercontent"` over the export finds nothing.
