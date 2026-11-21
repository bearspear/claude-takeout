# Combined Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Export All also saves claude.ai's artifacts into `artifacts/` and writes one `viewer.html` with Chats and Artifacts (All / Yours / Shared with you / In chats), linked both ways.

**Architecture:** The Export Artifacts loop in `popup.js` becomes a reusable `runArtifactStep` writing under a path prefix; Export Artifacts calls it with `''`, Export All with `'artifacts/'` after its chat loop. `export-core.js` gains `artifactLinksOf` (chat → artifact links from tool calls). `takeout-viewer.js` puts the v1.16 `ArtifactView` records and the links into the chat viewer's data. `viewer/artifacts-app.js` becomes mountable, and the chat viewer mounts it as its Artifacts screen; the standalone artifacts viewer keeps working.

**Tech Stack:** Chrome MV3 extension, plain JS (classic scripts), JSZip, Node's test runner, playwright-core e2e.

**Spec:** `docs/superpowers/specs/2026-11-21-combined-export-design.md` (read it; the plan argues from it). Earlier design this builds on: `docs/superpowers/specs/2026-11-16-artifacts-viewer-design.md`. Codebase primer: `CLAUDE.md`.

## Global Constraints

- Branch `combined-export`. Commit per task as bearspear, trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never stage `.claude/`, `.superpowers/`, `.DS_Store`. No pushes.
- `sh tests/run.sh` passes after every task; `node --check` every edited JS file.
- Setting key `exportAllArtifacts`, default `true`; label "Include artifacts in Export All".
- Reserved Export All chat folder names: `projects`, `published`, `artifacts`.
- Viewer code never contains the strings `claudeusercontent`, `__frame_t` or `_thumb`. The picture URL, asset token or any frame URL never reaches a written file, status line, warning, console or log.
- Artifact previews in the combined viewer keep v1.16's guarantees: sandbox `allow-scripts allow-forms allow-modals`, `PREVIEW_CSP` first, `STORAGE_SHIM`, `RTC_SHIM`, and **no navigation to `file:`** (the `refusedFor` checks in `tests/e2e/artifacts-viewer.e2e.js`). If no mechanism keeps the last one, the implementer stops and reports (BLOCKED); it is not weakened.
- The standalone Export Artifacts export (layout, files, viewer) is unchanged; its existing tests pass untouched.
- Export All never asks for the optional `https://*/*` permission (no new prompt).
- Artifact step failures never fail, delay the start of, or remove chat files; artifact warnings go to `artifacts/errors.txt` (type `artifact_export`).
- Copy fixed by the spec, verbatim:
  - Docs note: "Rebuilt from the chat. Edits made on claude.ai aren't included."
  - Changes header: "Changed since <date>: N of M listed"
  - Tool refusal: "This archive includes artifacts (Claude Takeout 1.17 or later). build_viewer/merge_archives don't support those yet; its viewer.html is already complete." (with the tool's own name in place of `build_viewer/merge_archives`)
- Version 1.17.0 (manifest and README changelog) in the last task only.
- e2e env: `PW=<scratchpad>/pw/node_modules/playwright-core CHROME_EXE="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"`. `tests/e2e/viewer.e2e.js` currently has 3 failures on `main` (Chrome's PDF viewer's own requests); no new ones.

## Review Focus

1. An Export All whose artifact list call fails or answers 401: chats complete normally, `index.md` says the artifacts weren't exported and why, no `artifacts/` half-written without an `index.md`. (Task 4 test.)
2. A chat named "Artifacts" (any case) in an Export All: it gets `Artifacts_2`, and `artifacts/` stays the artifact store. (Task 4 test.)
3. An artifact whose current version a chat published as `same` (not in `published/`): no fetch, `artifact.json` `savedIn` points at the chat's `artefacts/` file, and the viewer's preview loads that text. (Tasks 3 and 6 tests.)
4. Export Changes where no chat changed but an artifact did: the export runs (does not stop at "Nothing changed"), holding only that artifact. (Task 4 test.)
5. Opening the combined `viewer.html` from an unzipped ZIP, or with the setting off: no Artifacts entry when there are no artifacts; tiles and "unzip first" when not unzipped; no requests outside `file:`. (Task 8 e2e.)

---

### Task 1: Chat ↔ artifact links (`artifactLinksOf`)

**Files:**
- Modify: `export-core.js` (near `publishedPagesOf`), its `module.exports`
- Modify: `tests/helpers.js` (`docTools`: add the real batch-result shape as an option)
- Test: `tests/export.test.js`

**Interfaces:**
- Consumes: `publishedPagesOf`, `claudeDocsAction`, `claudeDocKey`, `leadingJson`, `resultText`, `base58ToUuid`, `failedToolUseIds` (export-core.js).
- Produces: `function artifactLinksOf(data) -> Array<{ uuid: string, messageUuid: string, how: 'made'|'published'|'edited', docKey: string|null }>`, a function declaration (so `takeout-viewer.js` can reach it on `window`, as with `isArtifactPublish`). One entry per (uuid, how, messageUuid), in chat order, over all messages (any branch). `docKey` is the `extractArtifacts` index key of the rebuilt document (`doc:<node id>`) for `made` links, else null.

Rules (spec "Linking chats and artifacts"), and nothing else links:
- `published`: every publish in `publishedPagesOf(data)` (one entry per publish).
- `made`: a `Claude_Docs__batch` call whose result (not `is_error`) has leading JSON `created.minted` = a UUID; fallback when `created.minted` is absent: `frame.url` matching `^https://claude\.ai/artifact/<id>` → `base58ToUuid(id)`. `docKey = claudeDocKey(block, result)`.
- `edited`: any `Claude_Docs__*` call with `input.container` = `{ kind: 'project', id: <UUID> }` (not `is_error`); and `…__edit_version` (name matching `(^|__|:)edit_version$`) with `input.slug` a UUID and a result without `is_error`.
- UUIDs lowercased; anything not matching the UUID pattern is ignored.

- [ ] **Step 1: Extend `docTools`** with an option `{ realShape: true }` making the batch result `{ verdict, acks: [...same acks...], lids: {}, created: { verdict: 'allow', minted: DOC_U, bound: true }, frame: { slug: OTHER_U } }` where `DOC_U` and `OTHER_U` are new exported constants (`'d0c00000-1111-4222-8333-444455556666'`, `'0f0f0000-1111-4222-8333-444455556666'`). Default shape unchanged.

- [ ] **Step 2: Write the failing tests**

```js
test('artifactLinksOf: a Docs batch made the artifact named by created.minted, with its doc key', () => {
  const t = docTools(undefined, { realShape: true });
  const data = oneMessage([t.batch, t.batchResult]);
  assert.deepStrictEqual(plain(core.artifactLinksOf(data)), [{ uuid: DOC_U, messageUuid: data.chat_messages[0].uuid, how: 'made', docKey: 'doc:node-1' }]);
});
test('artifactLinksOf: without created.minted, frame.url gives the uuid', () => { /* default docTools shape with DOC_URL replaced by https://claude.ai/artifact/<uuidToBase58(DOC_U)>: one 'made' link to DOC_U */ });
test('artifactLinksOf: publishes link as published, Docs container ids and edit_version as edited', () => {
  // publish_files (pubResult with slug PUB_U), an Artifact tool publish of PUB_U2, a Claude_Docs__update with container { kind:'project', id: DOC_U },
  // mcp__claude-artifacts__edit_version { slug: PUB_U3, base_version:'v1', edits:[], label:'x' } with an ok result
  // expect (in order): [PUB_U,'published'], [PUB_U2,'published'], [DOC_U,'edited'], [PUB_U3,'edited']; docKey null for all
});
test('artifactLinksOf: mentions, opens, list results, errors and bad ids do not link', () => {
  // Artifact {action:'open', url}, a list_artifacts result text containing PUB_U, a text block containing PUB_U,
  // edit_version with is_error result, Docs container id 'proj' (not a UUID), Docs update with is_error
  assert.deepStrictEqual(plain(core.artifactLinksOf(data)), []);
});
```

- [ ] **Step 3: Run** `node --test --test-name-pattern=artifactLinksOf tests/export.test.js` — expect FAIL (`artifactLinksOf is not a function`).
- [ ] **Step 4: Implement `artifactLinksOf`** in `export-core.js` and export it.
- [ ] **Step 5: Run** the pattern, then `sh tests/run.sh` — expect all pass.
- [ ] **Step 6: Commit** `export-core.js tests/helpers.js tests/export.test.js` — "Link chats to the artifacts they made, published or edited".

---

### Task 2: Old-archive tools refuse a combined archive

**Files:**
- Modify: `tools/archive-lib.js` (new `hasArtifacts`), `tools/build_viewer.js` (`main`/`inspectRoot` path), `tools/merge_archives.js` (`main`, per source before any write)
- Modify: `USAGE.md` ("Adding a viewer to older archives" and the merge section: one sentence each)
- Test: `tests/archive.test.js`, `tests/merge.test.js`

**Interfaces:**
- Produces: `hasArtifacts(root: string) -> boolean` in `tools/archive-lib.js`: true when `<root>/artifacts` is a directory, or `<root>/export-manifest.json` parses with an `artifacts` key. For a ZIP source, the same checks on its entries (`artifacts/` prefix, or the manifest entry) before extracting.

- [ ] **Step 1: Failing tests**:
  - `build_viewer refuses an archive with artifacts/ and writes nothing`: tmp archive with a chat folder plus `artifacts/x/artifact.json`; `main([dir, '--force'])` returns non-zero; the directory's file list and `viewer.html` bytes are unchanged; stderr contains the refusal copy with `build_viewer`.
  - `build_viewer --json reports a refused archive`: JSON output has the archive with `refused: true` and the message.
  - `merge_archives refuses when any source has artifacts, before writing`: two sources, the second with manifest `{ ..., artifacts: { listed: 1, thumbs: 0, items: [] } }`; non-zero; `--out` has no new folder; message names that source and uses `merge_archives`.
  - `a ZIP source with artifacts/ entries is refused before extraction` (merge): no extracted folder under `--out`.
- [ ] **Step 2: Run** `node --test tests/archive.test.js tests/merge.test.js` — expect the new tests FAIL.
- [ ] **Step 3: Implement** `hasArtifacts` and the two refusals (exact copy from Global Constraints; exit code 1).
- [ ] **Step 4: Run** both files, then `sh tests/run.sh` — pass.
- [ ] **Step 5: Commit** — "Old-archive tools refuse archives that include artifacts".

---

### Task 3: `runArtifactStep`: the Export Artifacts loop, reusable under a prefix, with dedup

**Files:**
- Modify: `popup.js` (`exportArtifacts`, `saveArtifact`, `saveArtifactThumb`, `writeArtifactsViewer`, `artifactsIndexHtml`/`artifactsIndexMd` only where paths need the prefix)
- Test: `tests/export.test.js` (Export Artifacts tests stay as they are and must pass unchanged)

**Interfaces:**
- Produces:
  ```js
  // Saves every listed artifact under prefix ('' or 'artifacts/'). Never throws.
  async function runArtifactStep(root, {
    prefix, artifacts, full, listed, fetchPublished, picturesAllowed,
    reuse,          // (uuid, ver) -> null | { files: { <published path>: <root-relative file> }, texts: [[path, text]], images: [[path, dataUri]] }
    parts,          // CTViewer.artifactViewParts(...) or null; part files go to root `viewer-files/` (never prefixed)
    onProgress,     // (done, total) -> void
    run,            // truthy in folder mode: flush per artifact
  }) -> { views, rows, entries, thumbs, collector, writeFailures, partCount, signedOut }
  ```
  - Every artifact folder, `artifact.json`, card picture (`viewer-files/thumbs/` stays at the root, unprefixed) and the views' `folder`/`start` paths are root-relative (prefix applied), so the combined viewer finds them from the root.
  - `reuse(uuid, ver)` returning a value: no fetch; the folder gets only `artifact.json` with `savedIn` (= `files`), the view's files point at those root-relative paths, and the preview part is built from `texts`/`images` as from a fetch.
- `exportArtifacts` becomes: list → `runArtifactStep(root, { prefix: '', reuse: () => null, ... })` → viewer, indexes, manifest, errors.txt, status as today. Its written files must be byte-identical to before (the existing tests and `export-baseline.json` prove it).

- [ ] **Step 1: Failing tests** (call `runArtifactStep` through the popup sandbox with `publishedFetcher` and a `zipStub`):
  - `runArtifactStep under artifacts/ writes folders, artifact.json and views with root-relative paths` — folder `artifacts/Guide_<short>/index.html`; `view.folder` starts with `artifacts/`; thumbs at `viewer-files/thumbs/<short>.png`.
  - `reuse skips the fetch and records savedIn` — `reuse` returns `{ files: { 'index.html': 'Chat/artefacts/guide.html' }, texts: [['index.html', 'G1']], images: [] }`; `fetcher.count('publishedPageFile') === 0`; `artifact.json.savedIn` equals that map; no `index.html` under the artifact folder; the view's start resolves to `Chat/artefacts/guide.html`.
  - `reuse is not used for a typed or Docs artifact`, and a `reuse` that throws falls back to fetching.
  - `a 401 in the step stops only the step` — returns `signedOut: true`, rows for the rest marked not exported, no throw.
- [ ] **Step 2: Run** them — FAIL.
- [ ] **Step 3: Implement** by moving the loop out of `exportArtifacts` (no behaviour change at prefix `''` with `reuse` null).
- [ ] **Step 4: Run** `sh tests/run.sh` — all pass, including every pre-existing Export Artifacts test and the baseline.
- [ ] **Step 5: Commit** — "Export Artifacts loop as runArtifactStep, under a prefix, with reuse".

---

### Task 4: Export All runs the artifact step

**Files:**
- Modify: `popup.js` (`bulkExportZip`, `defaultSettings`/`loadSettings`/`applySettings` and the change handler, `loadExportRecord`/`saveExportRecord`), `popup.html`, `sidepanel.html` (checkbox in the settings drawer)
- Test: `tests/export.test.js` (settings tests live there too), refresh `tests/fixtures/export-baseline.json` only if an Export All baseline exists and changes (follow `tests/README.md`)

**Interfaces:**
- Consumes: `runArtifactStep` (Task 3), `artifactsFromList`, `sharedProjects.published` (the in-memory published record `savePublishedPages` fills in Export All).
- Produces (for Task 6): `bulkExportZip` passes `writeViewer(megaZip, viewerChats, { artifacts: { views, listed, exported }, firstPart })` where `firstPart = partCount + 1` of the artifact step; `writeViewer`'s new third parameter is optional and today's calls stay valid.
- `function publishedReuse(shared, chatFolders) -> (uuid, ver) => null | { files, texts, images }`: from `shared.published` (by uuid): a saved, complete, all-verified version → its `published/<dir>/<folder>/<file>` paths and texts; a version whose `publishedIn` has `same: true` → that chat's `artefacts/<writtenAs>` (from the chat folder in `chatFolders`, uuid → folder) and the written text; otherwise null.
- Export record: `{ at, chats, artifacts: { <uuid>: ver } }`; `changedArtifacts(list, recorded) -> list` (included when no record or `live` differs).

Behaviour (spec "Export", "Layout"):
- With `exportAllArtifacts` on: after the chat list, call `listArtifacts` once (before the chat loop) so the count is known and "Nothing changed" only stops when no chat and no artifact changed. A list failure is not fatal: chats export, `index.md` gets "Artifacts: not exported (<code>)", status line appends " Artifacts could not be listed."
- After `writeSharedPublished`, run the step with `prefix: 'artifacts/'`, `picturesAllowed: await webImagesAllowed()` (no ask), `reuse: publishedReuse(...)`. Write `artifacts/index.html`, `artifacts/index.md` (links relative to `artifacts/`; the viewer link points to `../viewer.html`), `artifacts/errors.txt` when warnings.
- `index.md` gains a section `## Artifacts` with "Listed by claude.ai: N", "Saved: N", a link to `artifacts/index.md`, and the changes header copy in a changes export.
- `export-manifest.json` gains `artifacts: { listed, thumbs, items: entries }` only when the step ran.
- Record artifacts' `ver` with the chats after a successful write (both folder and ZIP paths).

- [ ] **Step 1: Failing tests**:
  - `Export All with artifacts on writes artifacts/ beside the chats` — folder mode with a stub list of two artifacts; `artifacts/index.md`, `artifacts/<..>/artifact.json`, manifest `artifacts.items.length === 2`, root `index.md` has `## Artifacts`.
  - `the setting off writes no artifacts and makes no listArtifacts call`.
  - `a list failure leaves the chats complete and says so` (Review Focus 1).
  - `a chat named Artifacts gets Artifacts_2` (Review Focus 2).
  - `an artifact published by a chat is not fetched again` — chat publishes PUB_U v1 (saved in published/), list has PUB_U live v1 → `publishedPageFile` called once for that uuid in the whole export, `savedIn` points into `published/`.
  - `a same version points at the chat's artefacts file` (Review Focus 3).
  - `Export Changes includes changed artifacts only and records versions`; `Export Changes runs when only an artifact changed` (Review Focus 4).
  - `Export All never asks for the web permission` — `chrome.permissions.request` never called.
  - Settings: `exportAllArtifacts defaults to true and round-trips` (beside the existing settings tests in `tests/export.test.js`).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `sh tests/run.sh` — pass.
- [ ] **Step 5: Commit** — "Export All saves artifacts into artifacts/".

---

### Task 5: Viewer data for the combined viewer

**Files:**
- Modify: `takeout-viewer.js` (`buildViewerChat`, `buildViewerData`, `moveUploadText` call site contract, header comment), `popup.js` (`writeViewer` signature)
- Test: `tests/viewer.test.js`

**Interfaces:**
- Consumes: `artifactLinksOf` (Task 1, via `core()`), Task 4's `writeViewer(zip, chats, { artifacts, firstPart })`.
- Produces (for Tasks 6-8):
  - `ViewerData.artifacts: ArtifactView[]` (v1.16 records, unchanged fields) each plus `links: [{ chat: <index in data.chats>, messageUuid, how }]` and `docFile: { chat, file } | null` (the chat's `doc:` GenFile for a `made` link whose `docKey` matches a file key in that chat; the latest such chat).
  - `ViewerData.listed`, `ViewerData.exportedArtifacts` (ISO) and `ViewerData.artifactsSince` (ISO or null; set in an Export Changes run) when artifacts are present; no `artifacts` key at all when none. `writeViewer`'s `artifacts` option carries `since`.
  - On a chat's published-page GenFile (`published:<uuid>`): `artifact: <shortId>` when that uuid is in `data.artifacts`.
  - On each chat GenFile Claude made: `madeAt` (the message uuid of its last version) — used for In-chats order.
  - Part numbering: `moveUploadText(data, { firstPart })` with `firstPart` from Task 4; both use one `window.__archivePart(n, {...})` format, keys `u*`/`f*` (chats) and `a*` (artifacts) never collide.
- `buildViewerChat` keeps `ctx.links = artifactLinksOf(data)` on the chat; `buildViewerData` resolves chat indexes.

- [ ] **Step 1: Failing tests** in `tests/viewer.test.js`:
  - `artifacts and their links join the chats' viewer data` — two chats (one publishes PUB_U, one makes DOC_U via Docs), artifacts [PUB_U view, DOC_U view]: links resolve to chat indexes 0 and 1 with `how`; DOC_U `docFile` points at chat 1's `doc:node-1` file.
  - `a published card names its artifact only when that artifact is in the export`.
  - `no artifacts: the data has no artifacts key` (byte-identical data to today for a chats-only export).
  - `part numbers continue after the artifact parts` — `firstPart: 3` → first chat part is `part-0003.js`.
- [ ] **Step 2: Run** `node --test tests/viewer.test.js` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `sh tests/run.sh` — pass.
- [ ] **Step 5: Commit** — "Viewer data: artifacts, links and continued part numbers".

---

### Task 6: Mountable artifacts app and the Artifacts screen in the chat viewer

**Files:**
- Modify: `viewer/artifacts-app.js` (wrap in a mountable module), `viewer/artifacts-template.html` (CSS moves out), `viewer/viewer-template.html` (Artifacts sidebar entry, screen container, artifacts CSS), `viewer/viewer-app.js` (screen switch, routing, part loader shared), `takeout-viewer.js` (`VIEWER_ASSETS` gains the artifacts app and CSS; `ARTIFACTS_VIEWER_ASSETS` keeps working)
- Create: `viewer/artifacts.css` (the CSS now inline in `artifacts-template.html`, inserted into both templates by `assembleViewer` at a `/*ARTIFACTS_CSS*/` placeholder)
- Test: `tests/viewer.test.js` (assembly), `tests/e2e/artifacts-viewer.e2e.js` must pass unchanged; new `tests/e2e/combined.e2e.js`

**Interfaces:**
- Produces: `window.CTArtifactsApp = { mount(container, { data, loadPart, onOpenChat }) -> { route(hash): boolean, show(): void } }` defined by `artifacts-app.js`; in the standalone page it mounts itself on `document.body` as today (no behaviour change). `loadPart(n) -> Promise<object>` comes from the host; `onOpenChat(chatIndex, messageUuid)` navigates the chat viewer.
- Chat viewer: sidebar entry `#artifacts-nav` ("Artifacts" + count) shown only when `data.artifacts` is non-empty; selecting it shows `#artifacts-screen` (hiding `#main`'s chat); `#a=<shortId>` routes to an artifact page; the chat viewer's own hashes route as today. One `__archivePart` loader in `viewer-app.js`, passed to the mount as `loadPart`.
- **CSP step (constraint):** make previews unable to navigate to `file:` while PDFs still show. First try: page CSP `frame-src file:` kept, and check `refusedFor` in the combined e2e. If file navigation from an artifact preview is not refused, change the combined page's CSP to `frame-src 'none'` and render the chat viewer's PDF view as the existing Open-file link with a note "Open the PDF to view it" (no frame) — and report this in the task report as a behaviour change for the controller to rule on. If neither holds, BLOCKED.

- [ ] **Step 1: Failing tests**:
  - Unit: `the combined viewer includes the artifacts app and CSS once` (assembled HTML contains one `CTArtifactsApp` definition, no `claudeusercontent|__frame_t|_thumb`).
  - e2e `combined.e2e.js` (fixture: a built combined export in a tmp folder, generated via the popup sandbox like other e2e fixtures): Artifacts entry with count; click shows the grid with All/Yours/Shared tabs; a card opens `#a=<id>` with the sandboxed preview; Back returns to the grid; a chat link still opens a chat; no requests outside `file:`; hostile artifact from `tests/e2e/hostile.js` can't navigate to `file:` (`refusedFor`) nor reach `parent.document`.
  - e2e: an export with no artifacts shows no Artifacts entry.
- [ ] **Step 2: Run** the unit and e2e — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `sh tests/run.sh`, `combined.e2e.js`, `artifacts-viewer.e2e.js` (unchanged, all pass), `viewer.e2e.js` (no new failures).
- [ ] **Step 5: Commit** — "Chat viewer gets the Artifacts screen".

---

### Task 7: In chats tab

**Files:**
- Modify: `viewer/viewer-logic.js` (pure helpers), `viewer/artifacts-app.js` (tab, filter chips, file page), `viewer/artifacts.css`
- Test: `tests/viewer.test.js` (helpers), `tests/e2e/combined.e2e.js`

**Interfaces:**
- Consumes: `data.chats[].files` (GenFiles with `kind`, `versions`, `madeAt`, `published`), `data.artifacts[].links`.
- Produces in `viewer-logic.js`:
  - `inChatsFiles(data) -> Array<{ chat, file, name, kind: 'page'|'doc'|'diagram'|'code'|'other', madeAt, versions, alsoArtifact: shortId|null }>` newest first by `madeAt` message order (chat `updated_at` as tiebreak), excluding uploads, pasted attachments, `missing`, `published:` files, and files that are the `same` source of a publish whose page is in `data.artifacts` (those set `alsoArtifact` on the artifact instead: expose `alsoInChat(data) -> Set<shortId>`).
  - `fileKindGroup(name, kind) -> 'page'|'doc'|'diagram'|'code'|'other'`: `.html/.htm` page; `.md` and `doc:` keys doc; `.svg` and `widget:` keys diagram; code by the chat viewer's `kind === 'code'` or known code extensions; else other.
- Hash for an In-chats file: `#ac=<chatIndex>.<fileId>` (parse/format helpers `parseInChatsHash`, `formatInChatsHash`), exact pattern `^#ac=(\d{1,6})\.([A-Za-z0-9_:-]{1,128})$`.

- [ ] **Step 1: Failing tests**: helper tests for ordering, exclusions (each listed exclusion), kind groups; e2e: In chats tab with count, chips with counts filter, search filters by file name, a card opens `#ac=…` in the preview sandbox with "Made in <chat>" linking to the chat, version menu lists versions, an "also in chat" file is not listed.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** unit + combined e2e + artifacts e2e — pass.
- [ ] **Step 5: Commit** — "Artifacts screen: In chats tab".

---

### Task 8: Links in the viewer: source line, Made in, versions, Docs text, Open artifact

**Files:**
- Modify: `viewer/artifacts-app.js`, `viewer/viewer-app.js` (published card button), `viewer/artifacts.css`
- Test: `tests/e2e/combined.e2e.js`, `tests/viewer.test.js` where pure

**Interfaces:**
- Consumes: Task 5 data (`links`, `docFile`, `artifact` on published cards), Task 7 `alsoInChat`.
- Behaviour (spec "Viewer"):
  - All-tab card source line: "💬 N chat(s)" when linked, else "Cowork" / "Code" / "Shared with you" from the view; "also in chat" when in `alsoInChat`.
  - Artifact page line: "Made in" / "Published in" / "Edited in" + chat titles as links calling `onOpenChat(chat, messageUuid)` (chat opens scrolled to that message); Back returns to the artifact.
  - Version menu when chats published versions other than the current: each opens that version's saved copy (from the chats' `published:` GenFile versions).
  - Docs artifact with `docFile`: the chat file's last version rendered by the chat viewer's Markdown path (`markdownParser` + `sanitizeHtml`), with the Docs note copy; without `docFile`: the v1.16 Docs page.
  - Chat published card: **Open artifact** button when the GenFile has `artifact`, setting `#a=<shortId>`.
  - Not unzipped: as v1.16 (tiles, "unzip first" on previews).
  - In a changes export (`artifactsSince` set), the Artifacts screen heading line reads "Changed since <date>: N of M listed" (N = artifacts in the data, M = `listed`).
- [ ] **Step 1: Failing e2e**: each bullet above, plus Review Focus 5 (no artifacts → no entry; not-unzipped run; zero requests outside `file:` across all frames; no page errors), plus Review Focus 3's viewer half (a `savedIn` → `artefacts/` artifact previews its text).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** unit, `combined.e2e.js` (10 runs in a row, all pass), `artifacts-viewer.e2e.js`, `published.e2e.js`, `viewer.e2e.js` (no new failures).
- [ ] **Step 5: Commit** — "Artifacts and chats link to each other in the viewer".

---

### Task 9: Docs and version 1.17.0

**Files:**
- Modify: `README.md` (changelog `### v1.17.0` at the top; layout section), `USAGE.md` (combined export, the setting, In chats, the tools' refusal if not already in Task 2), `TECHNICAL.md` (Export All artifact step, `runArtifactStep`, `publishedReuse`, links, combined viewer), `CLAUDE.md` (§2 new files `viewer/artifacts.css`, `tests/e2e/combined.e2e.js`; §3 `runArtifactStep`; §7 Export All layout with `artifacts/`; §9 `exportAllArtifacts` and the record's `artifacts`), `manifest.json` → `1.17.0`, `tests/README.md` (combined e2e line)
- [ ] **Step 1:** Write the docs from the code as built (names and paths must exist: `grep` each).
- [ ] **Step 2: Run** `sh tests/run.sh` (the manifest/changelog version test passes).
- [ ] **Step 3: Commit** — "Combined export docs and version (v1.17.0)".
