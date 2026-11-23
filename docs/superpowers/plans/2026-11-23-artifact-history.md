# Artifact History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Save every version of every artifact (claude.ai's history) in Export Artifacts and Export All, fetch only new or failed ones in Export Changes, and preview each older version in the viewer.

**Architecture:** `content.js` returns history oldest first (claude.ai sends it newest first; exports up to v1.20.7 kept it reversed) and lists an older Cowork/Claude Code version's files from the live version's list. `saveArtifact` (popup.js) fetches the current version as today, then each older version into its own store folder (`saveHistory`), keeping each payload for a preview part (`versionPlaces`, the field `build_viewer.js` already fills from disk). Export All records the versions saved per artifact so Export Changes skips them.

**Tech Stack:** Classic-script JS (extension + viewer), Node 20 `node --test`, playwright-core e2e.

**Spec:** `docs/superpowers/specs/2026-11-23-artifact-history-design.md`

## Global Constraints

- `manifest.json` `1.21.0`; README changelog `### v1.21.0`.
- Every history version saved, every run (no setting). Docs skipped. Card pictures and ZIPs: current version only.
- A version already in the store whole (`storeVersionWhole`) or `sameAs` is not fetched again.
- Older Cowork/Claude Code versions: the live version's paths, `verified: false`; a path the older version lacks is `missing`.
- 404 or no files for a version: settled (not retried), noted in the artifact's note as `N older versions no longer on claude.ai`; any other failure: `incomplete`/`missing`, one `artifact_export` warning per artifact (codes only), retried next Export Changes. One 401 stops all fetching (existing `state.publishedSignedOut`).
- Only Export All writes the record. Old record without saved versions: fetch every version once.
- Older previews: only while at least 64 MB of `ARTIFACT_PARTS_BUDGET` (256 MB) is left; current version first within an artifact.
- No URL, token or picture URL in any file, log, status or error. Synthetic fixtures only. Commit as bearspear, trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- An older Cowork/Claude Code version whose live list names a file it doesn't have: that file `missing`, the version kept, no export failure → test in Task 3.
- A 401 in the middle of an artifact's history: the current version stays saved, fetching stops, later artifacts are not fetched → test in Task 3.
- Merging a v1.21 export with an archive from v1.20.7 or before (reversed `order`): merged order oldest first, current last → test in Task 1.
- Older previews never take the room a later artifact's current version needs → test in Task 5.
- Export Changes with a record from before v1.21 (no saved versions): every version fetched once, then recorded → test in Task 4.

---

### Task 1: Version history oldest first, also when reading older archives

**Files:**
- Modify: `content.js` (`publishedFrameInfo`: `history`)
- Modify: `tools/archive-lib.js` (where a format-2 `artifact.json`'s `order` is read into a record)
- Test: `tests/panel.test.js`, `tests/archive.test.js`, `tests/merge.test.js`

**Interfaces:**
- Produces: `publishedPageInfo` reply `history` oldest first (live last). Records read from disk: `order` oldest first.

- [ ] **Step 1: Failing tests**
  - panel.test.js `publishedPageInfo gives history oldest first`: harness `info` returns `history: ['v3', 'v2', 'v1']`, `ver: 'v3'` → reply `history` `['v1', 'v2', 'v3']`.
  - archive.test.js `an artifact.json from before v1.21 with its current version first is read oldest first`: format 2, `listed: true`, `current: 'v2'`, `order: ['v2', 'v1']` → record order `['v1', 'v2']`; `order: ['v1', 'v2']`, current `v2` → unchanged; one version → unchanged.
  - merge.test.js `merging a reversed-order archive with an oldest-first one keeps one order`: old archive `order ['v2','v1']` current v2, newer `order ['v1','v2','v3']` current v3 → merged `order ['v1','v2','v3']`.
- [ ] **Step 2: Run** `node --test tests/panel.test.js tests/archive.test.js tests/merge.test.js` → the three FAIL.
- [ ] **Step 3: Implement.** content.js: reverse claude.ai's list (observed newest first, 2026-11-23). archive-lib: a listed record whose `current` is `order[0]` with more than one version is reversed (written so by v1.20.7 and before; a current version is claude.ai's newest).
- [ ] **Step 4: Run** the three files → PASS; `sh tests/run.sh` → `# fail 0`.
- [ ] **Step 5: Commit** — "Version history oldest first (claude.ai sends it newest first), older archives read the same way".

### Task 2: Older Cowork and Claude Code versions list the live version's files

**Files:**
- Modify: `content.js` (`publishedFileList`, `publishedPageInfo`), `popup.js` (`cleanPublishedInfo`)
- Test: `tests/panel.test.js`, `tests/export.test.js`

**Interfaces:**
- Produces: `publishedPageInfo` reply `listFromLive: true` when an older version's files come from the live version's list (each `sha256: null`, `size: null`); `cleanPublishedInfo(r).listFromLive: boolean`.

- [ ] **Step 1: Failing tests** (panel.test.js) `an older version with no _files.json and no files of its own lists the live version's files`: `filesJson` → 404; `info(body)` → `files: []` for `ver=old`, `[{ path: 'index.html', contentType: 'text/html' }]` for the live call → reply `files` `[{ path: 'index.html', size: null, contentType: 'text/html', sha256: null }]`, `listFromLive: true`; live list empty too → `{ error: 'HTTP 404', status: 404 }`; a live version's own reply has no `listFromLive`. export.test.js: `cleanPublishedInfo` keeps `listFromLive` only as `true`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**: on the 404 path with an empty `entry.files` and `ver !== ''`, take `publishedToken(uuid, '', org)`'s `files` through `fromInfo`.
- [ ] **Step 4: Run** → PASS; suite `# fail 0`.
- [ ] **Step 5: Commit** — "content.js: an older Cowork/Claude Code version lists the live version's files".

### Task 3: Every older version into the store (saveHistory)

**Files:**
- Modify: `popup.js` (`saveArtifact`, new `saveHistory`, `runArtifactStep` `whole`)
- Test: `tests/export.test.js`

**Interfaces:**
- Consumes: Task 1 history order; Task 2 `listFromLive`.
- Produces: `saveHistory(root, rec, ctx, { skip: Set<string> }) -> Promise<{ payloads: Array<[ver, payload]>, settled: string[], saved: string[], failed: string[] }>` (`saved`: whole now or already); `saveArtifact` returns `history` (that object, or `null` for Docs and failures before the current version); `whole[i]` false when `history.failed.length`.

- [ ] **Step 1: Failing tests** (export.test.js, via `runArtifacts` with `livePage`-style pages holding `versions: { v1, v2, [LIVE] }`, `history: ['v1', 'v2', LIVE]`):
  - `every older version is saved in its own folder, oldest first in artifact.json`: files at `<folder>/v1/…`, `<folder>/v2/…`; `order` `['v1','v2',LIVE]`, `current` LIVE; each version `saved: true`, checksums verified; `publishedPageInfo` calls `[ [U, LIVE], [U,'v1'], [U,'v2'] ]` (current first, then oldest to newest).
  - `a version the store already has whole is not fetched again` (Export All: a chat saved v1) → no call for v1.
  - `an older version claude.ai no longer serves is settled and noted`: v1 info 404 → no warning, note includes `1 older version no longer on claude.ai`, `whole` true.
  - `an older version that fails is warned once and leaves the artifact not whole`: v1 checksum mismatch and v2 network → one warning naming 2 versions, codes only; v1/v2 `incomplete`; `whole` false.
  - `a 401 in the history stops fetching`: v1 → 401 → current saved, v2 not fetched, next artifact not fetched, one sign-in warning.
  - `an older Cowork version takes the live version's paths` (`listFromLive`): saved `verified: false`; a path missing in v1 → `missing: ['app.js']`, version kept.
  - `Claude Docs fetch no history`.
- [ ] **Step 2: Run** `node --test tests/export.test.js` → FAIL.
- [ ] **Step 3: Implement `saveHistory`** after the current version in `saveArtifact` (not for Docs, not when the current failed or sign-out is set): for each `ver` of `rec.history` other than the current, not in `skip`, not whole or `sameAs` in the store: `publishedPageInfo`, then `fetchPublishedFiles` into `store.versionFolder(rec, ver)` with `collect: true`, recording the version as the current one's record is built (`verified: false` for every file when `listFromLive`). 404 / no files → settled. Warning text: `Artifact "<name>": <n> older version(s) could not be saved: <codes>.`
- [ ] **Step 4: Run** → PASS; suite `# fail 0`.
- [ ] **Step 5: Commit** — "Export: every older version of an artifact in its own folder".

### Task 4: Export Changes fetches only new or failed versions

**Files:**
- Modify: `popup.js` (`bulkExportZip` record read/write, `saveExportRecord`, `recordableExport` input, `runArtifactStep`/`saveArtifact` `ctx.skipVersions`)
- Test: `tests/export.test.js`

**Interfaces:**
- Consumes: Task 3 `history.saved/settled/failed`.
- Produces: `exportRecord[org].artifactVersions: { <uuid>: string[] }` (saved whole or settled, union with the old list); `ctx.skipVersions: Map<uuid, Set<ver>>` (empty for Export Artifacts and when the record has none).

- [ ] **Step 1: Failing tests**:
  - `Export Changes skips older versions an earlier Export All saved`: stored `artifacts: { [U]: 'old' }`, `artifactVersions: { [U]: ['v1'] }`, live changed → v1 not fetched, v2 and LIVE fetched; record afterwards `artifactVersions[U]` `['v1','v2',LIVE]` (any order) and `artifacts[U]` LIVE.
  - `a failed older version keeps the artifact in the next Export Changes`: v2 fails → `artifacts[U]` not recorded, `artifactVersions[U]` lacks v2; a second run with v2 fixed fetches only v2 (and the current, kept from the store or fetched as today).
  - `a record from before v1.21 fetches every version once`: stored `artifacts: { [U]: LIVE }` only, history changed live → all versions fetched, then recorded.
  - `Export Artifacts records nothing`: `exportRecord` unchanged.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**: read `artifactVersions` with the record; pass `skipVersions` to the step; after a written run, union the saved/settled lists into the record (through `recordableExport`, so a write failure under the artifact's folder records nothing for it).
- [ ] **Step 4: Run** → PASS; suite `# fail 0`.
- [ ] **Step 5: Commit** — "Export Changes: older versions an earlier export saved are not fetched again".

### Task 5: Every older version previews in the viewer

**Files:**
- Modify: `takeout-viewer.js` (`artifactViewParts` `add` options, export `recordVersions`), `popup.js` (`runArtifactStep` older parts and `rec.versionPlaces`, `storeRecords`, `writeArtifactsViewer` versions for standalone views), `viewer/artifacts-app.js` (version menu: a Design view's older version opens its canvas)
- Test: `tests/viewer.test.js`, `tests/export.test.js`, `tests/e2e/combined.e2e.js`, `tests/e2e/artifacts-viewer.e2e.js`, `tests/e2e/design.e2e.js`

**Interfaces:**
- Consumes: Task 3 `history.payloads`.
- Produces: `artifactViewParts().add(view, payload, { reserve = 0 } = {})` (skips without filling when `used + bytes > budget - reserve`); `rec.versionPlaces: { <ver>: { folder, part, key, startKind } }` with `folder` root-relative (`<prefix><dir>/<versionFolder>`); standalone views carry `versions` (`CTViewer.recordVersions`).

- [ ] **Step 1: Failing tests**:
  - viewer.test.js `artifactViewParts reserve`: budget 1000, reserve 400 → an older payload of 700 bytes skipped, a following current one of 500 added; without reserve the 700 one is added.
  - export.test.js `older versions get preview parts and places`: views' records have `versionPlaces.v1.part` set; standalone `views[i].versions` lists v1, v2, LIVE with `part` for the older ones; a tiny budget leaves older versions without part, current with.
  - e2e combined/artifacts-viewer: pick `v1` → its own text in the preview (`<!--V1-->`), its Download and Open file from `…/v1/`; badges its own.
  - e2e design: an older Design version → its own canvas (a board only v1 has).
- [ ] **Step 2: Run** unit + e2e → FAIL.
- [ ] **Step 3: Implement** the reserve (64 MB, `ARTIFACT_HISTORY_RESERVE` in takeout-viewer.js), the older parts in `runArtifactStep` right after the current one's, `versionPlaces` into `storeRecords` and the standalone views, the Design branch in the version menu (`isDesign(v) && e.part` → `openCanvas` with that version's part, key, folder and files).
- [ ] **Step 4: Run** unit, design, combined, artifacts-viewer, download e2e → PASS; suite `# fail 0`.
- [ ] **Step 5: Commit** — "Viewer: every older artifact version previews from the version menu".

### Task 6: Docs, version, and a merge round trip

**Files:** `README.md` (`### v1.21.0`, also the version order fix), `USAGE.md` (Export Artifacts, Export All, Export Changes, the version menu, sizes), `TECHNICAL.md` (history fetch, `listFromLive`, record `artifactVersions`, reserve, `versionPlaces` from the extension, order fix), `CLAUDE.md` (§7 store holds every version; §9 `artifactVersions`), `manifest.json` → `1.21.0`; `tests/merge.test.js`.

- [ ] **Step 1: Failing test** merge.test.js `a v1.21 export merges and rebuilds with every version`: two exports, each with history versions, merged → every version folder present once, `order` oldest first, viewer data versions with parts.
- [ ] **Step 2: Run** → PASS expected without code change (the tools read any number of versions); if it fails, fix in archive-lib/merge and say so in the commit.
- [ ] **Step 3: Write the docs; bump the manifest.**
- [ ] **Step 4: Run** `sh tests/run.sh` → `# fail 0`.
- [ ] **Step 5: Commit** — "Every version of every artifact: docs and version (v1.21.0)".
- [ ] **Step 6:** After merge-ready, ask the owner for a real Export All; check every non-Docs history version is saved (count against claude.ai's history), labels oldest first, previews open.
