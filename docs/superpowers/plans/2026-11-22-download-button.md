# Download Button and Artifact ZIPs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the offline viewer save any file whose bytes it holds (Download), and give each multi-file current artifact version a ZIP written at export time and linked from the viewer (Download ZIP).

**Architecture:** The export writes `<folder>.zip` beside the current version's `<folder>/` from the bytes it already has (JSZip, in `fetchPublishedFiles` and the multi-file `same` copy), records it as `versions[ver].zip` in `artifact.json` and as `zip` on the artifact view. The viewer gets one shared helper in `viewer-logic.js` that saves bytes through a `blob:` link, used by the chat viewer's popups and the Artifacts screen; Download ZIP is a plain link. The old-archive tools pass the ZIP through (build_viewer) or copy it (merge).

**Tech Stack:** Chrome MV3 extension JS (classic scripts), vendored JSZip, Node 20 tests (`node --test`), playwright-core e2e.

**Spec:** `docs/superpowers/specs/2026-11-22-download-button-design.md`

## Global Constraints

- `manifest.json` version `1.19.0`; README changelog `### v1.19.0` at the top.
- Downloaded Blob type is always `application/octet-stream`.
- Download never links to a file on disk and never runs inside a sandboxed preview frame; the preview sandbox is unchanged (no `allow-downloads`).
- No ZIP library in `viewer.html`; the Node tools never write ZIPs.
- ZIP only for the current version, only when its `<folder>/` holds two or more saved files (`savedAs` set); name `<folder>.zip` beside `<folder>/`; entries = the saved files at their saved names relative to `<folder>/`, in the version's file order, DEFLATE, every entry dated from the artifact's `updatedAt`, else `1980-01-01T00:00:00Z`.
- `artifact.json` format 2: `versions[ver].zip: "<folder>.zip"` only when written; the ZIP is not in `files`.
- Link label "Download ZIP"; when the version is incomplete, "Download ZIP (some files missing)".
- No URL, token or frame URL in any ZIP entry name or `zip` value; every written file passes the existing token scan.
- Never stage `.claude/`, `.superpowers/` or `.DS_Store`. Commit as bearspear with trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- A file name with characters illegal on disk (`a:b?.html`, a name with `/`): Download saves a cleaned base name, never a path → test in Task 2.
- A large upload whose text is in a `viewer-files/` part: no Download until the part has loaded, then Download appears and saves the full text → test in Task 2.
- An Export Changes run where an unchanged artifact is not written: no ZIP is written for it and nothing stale is referenced → test in Task 1.
- A merge whose current version comes from an older source without a ZIP while a newer source has a ZIP for a different version: the merged archive has no ZIP and no `zip` field → test in Task 3.
- A file whose name ends in `.html` downloaded from the Artifacts screen: nothing navigates, no frame or page loads it, no network request → e2e in Task 2.

---

### Task 1: ZIP per current multi-file version (export)

**Files:**
- Modify: `popup.js` (`fetchPublishedFiles` ~3340, `savePublishedPages` `fetchVersion`/`keepSame` ~3618-3690, `saveArtifact` ~5447-5590, `artifactJsonV2` ~5390)
- Modify: `export-core.js` (`artifactView` ~1628: add `zip`)
- Modify: `tests/export.test.js`, `tests/fixtures/export-baseline.json`

**Interfaces:**
- Produces: `async function versionZip(entries: Array<[name: string, bytes: Uint8Array|string]>, date: string) -> Promise<Uint8Array>` in `popup.js` (JSZip, DEFLATE, each entry `date: new Date(date)`; invalid/empty date → `1980-01-01T00:00:00Z`).
- Produces: `fetchPublishedFiles({ ..., zip: { date } | null })` returns `zipped: boolean`; when `zip` is set and ≥2 files were saved, it writes `${prefix minus trailing '/'}.zip` into `target` and returns `zipped: true`.
- Produces: store version field `v.zip` (string `<folder>.zip` or absent) → `artifactJsonV2` writes `zip` on that version only when set; `artifactView(o)` takes `o.zip` (string|null, root-relative href) and returns it as `zip`.
- Callers: Export All `fetchVersion` passes `zip` when `wanted(rec.uuid, v.ver)` (the included artifact's listed version); `keepSame`'s multi-file copy builds the ZIP from the matched texts under the same condition; `saveArtifact` always passes `zip` for the version it saves. Each sets `v.zip = `${folder}.zip`` when zipped.

- [ ] **Step 1: Write the failing tests** in `tests/export.test.js`:
  - `versionZip is deterministic and dated`: two calls with the same entries give identical bytes; unzip (JSZip) lists entries in input order with `date` equal to the given date; an empty date gives 1980-01-01.
  - `Export Artifacts writes <ver>.zip for a multi-file current version`: fixture artifact with files `index.html`, `app.js` → `<Title>_<id>/<folder>.zip` exists, its entries equal `[savedAs…]` with identical bytes, and `artifact.json.versions[ver].zip === '<folder>.zip'`; the ZIP is not in `files`.
  - `no zip for one-file, sameAs, older or unlisted versions`: one-file version → no `.zip`, no `zip`; Export All version stored as `sameAs` → none; an older version a chat published → none; an unlisted published page → none.
  - `incomplete multi-file version zips what was saved`: 3 files, 1 fails → ZIP with 2 entries, `incomplete: true`; 2 files, 1 fails → no ZIP.
  - `multi-file same version copied from a chat gets a zip` (Export All, `keepSame` path).
  - `Export Changes writes no zip for an artifact it doesn't write` (Review Focus).
  - Token scan already covers new files; add the `.zip` entry names to the scanned strings.
- [ ] **Step 2: Run** `node --test tests/export.test.js` → the new tests FAIL (`versionZip is not defined`, missing `.zip`).
- [ ] **Step 3: Implement** `versionZip`, the `zip` option and `zipped` result in `fetchPublishedFiles` (collect saved `[savedName, bytes]` only when `zip` is set), the three call sites, `artifactJsonV2`'s `zip`, `artifactView`'s `zip`. Pass `date: rec.meta.updatedAt`.
- [ ] **Step 4: Run** `node --check popup.js && node --test tests/export.test.js` → PASS. Refresh the baseline per `tests/README.md`; check the diff only adds `.zip` files and `zip` fields.
- [ ] **Step 5: Run** `sh tests/run.sh` → `# fail 0`.
- [ ] **Step 6: Commit** `popup.js export-core.js tests/export.test.js tests/fixtures/export-baseline.json` — "Export: a ZIP of each artifact's current multi-file version".

### Task 2: Download and Download ZIP in the viewer

**Files:**
- Modify: `viewer/viewer-logic.js`, `viewer/viewer-app.js` (popup header ~784-830, panel header, published card ~1556), `viewer/artifacts-app.js` (top bar ~750, file list ~415-465), `viewer/artifacts.css` / viewer template CSS for the button, `takeout-viewer.js` if the view data needs `zip` passed through
- Modify: `tests/viewer.test.js`
- Create: `tests/e2e/download.e2e.js`

**Interfaces:**
- Consumes: artifact view `zip` (Task 1).
- Produces in `viewer-logic.js` (exported for Node tests like the other helpers):
  - `downloadName(name: string) -> string`: last path segment, characters `\ / : * ? " < > |` and control characters replaced by `_`, trimmed of leading/trailing dots and spaces, capped at 200 UTF-16 units keeping the extension, empty → `download`.
  - `saveBytes(name: string, data: string|Uint8Array) -> void` (DOM): `new Blob([data], { type: 'application/octet-stream' })` (string → UTF-8), `URL.createObjectURL`, temporary `<a download=downloadName(name)>` clicked, URL revoked after a tick.
  - `dataUrlBytes(url: string) -> Uint8Array|null` for a `data:<type>;base64,` image.
  - `downloadButton(name, getData: () => string|Uint8Array|null) -> HTMLButtonElement` labelled "Download", `aria-label` "Download <name>".
- Placement: chat popup header and panel header beside `fileCopyButton` whenever the item's text is a string (so a part-backed upload gains it when its text arrives); Artifacts page top bar for the shown file when its text or image is held; each held row in the artifact's file list. Artifacts top bar adds `<a class="btn" href=view.zip>` "Download ZIP" / "Download ZIP (some files missing)" when `view.zip` is set and `openableHref(view.zip)`.

- [ ] **Step 1: Write the failing unit tests** in `tests/viewer.test.js`: `downloadName` cases — `'dir/a:b?.html'` → `'a_b_.html'`, `'report_v2.html'` unchanged, `'..'` → `'download'`, a 300-char name keeps `.html` and is ≤200; `dataUrlBytes('data:image/png;base64,iVBORw0K')` starts with `0x89 0x50`; a non-data URL → `null`.
- [ ] **Step 2: Run** `node --test tests/viewer.test.js` → FAIL.
- [ ] **Step 3: Implement** the helpers and the placements above.
- [ ] **Step 4: Write the e2e** `tests/e2e/download.e2e.js` against a viewer built from the synthetic fixture plus an artifacts export with a two-file artifact (follow `combined.e2e.js` setup and its Chrome flags), `acceptDownloads: true`:
  - Download of a generated `.html`, an `.svg`, a `.md` and a preview image: one `download` event each, `suggestedFilename` as shown, saved bytes equal the source, page URL unchanged, no new frame loads the file, no `pageerror`, no network request.
  - A part-backed upload: no Download button before the part loads; after, Download saves the full text.
  - Download ZIP on the two-file artifact: `download` event named `<folder>.zip`; an artifact with no `zip` has no link.
- [ ] **Step 5: Run** `node --test tests/viewer.test.js` and `PW=… CHROME_EXE=… node tests/e2e/download.e2e.js` → PASS; also run `combined.e2e.js` and `artifacts-viewer.e2e.js` → PASS (CSP unchanged unless the download needs it; if it does, change it minimally and note it in the commit).
- [ ] **Step 6: Run** `sh tests/run.sh` → `# fail 0`.
- [ ] **Step 7: Commit** the viewer files, tests and e2e — "Viewer: Download for every file it holds, Download ZIP for artifacts".

### Task 3: Old-archive tools carry the ZIP

**Files:**
- Modify: `tools/archive-lib.js` (`artifactJsonV2FromDisk` ~852, `artifactViewsFromDisk` ~895, the format-2 reader), `tools/merge_archives.js` (where the merged current version is copied, near `copyInto` ~192)
- Modify: `tests/archive.test.js`, `tests/merge.test.js`

**Interfaces:**
- Consumes: `versions[ver].zip` in format-2 `artifact.json` (Task 1); view `zip` (Task 1/2).
- Produces: disk records keep `zip` per version only when `realFileUnder(<artifact dir>, zip)` holds and the name is `<folder>.zip`; `artifactJsonV2FromDisk` writes it like popup's (parity test); `artifactViewsFromDisk` sets view `zip` to the root-relative href of the current version's ZIP.
- Merge: when the merged current version is taken whole from a source whose record has `zip`, copy that file to `<merged artifact dir>/<merged folder>.zip` after checking its first 4 bytes are `50 4B 03 04`; on a failed check leave it out and add a report line `artifact <title>: ZIP left out (not a ZIP)`; never copy ZIPs of non-current versions.

- [ ] **Step 1: Write the failing tests**:
  - archive: `zip passes through only for a real file` (present → view `zip` set; named but missing → none; a symlink → none; a `.zip` not named in artifact.json → none); parity of `artifactJsonV2FromDisk` with popup's `artifactJsonV2` including `zip`.
  - merge: current version from a source with a ZIP → merged ZIP copied, `zip` set; current version from a source without one while another source has a ZIP for an older version → no ZIP, no `zip` (Review Focus); a source ZIP that isn't a ZIP → left out with the report line; a merged folder renamed `_2` → ZIP renamed to match.
- [ ] **Step 2: Run** `node --test tests/archive.test.js tests/merge.test.js` → FAIL.
- [ ] **Step 3: Implement** as in Interfaces.
- [ ] **Step 4: Run** the two test files → PASS; `sh tests/run.sh` → `# fail 0`; `node tests/e2e/archive.e2e.js` → PASS.
- [ ] **Step 5: Commit** — "Old-archive tools: keep the artifact ZIP (build_viewer links it, merge copies it)".

### Task 4: Docs and version

**Files:**
- Modify: `README.md` (changelog `### v1.19.0`, viewer and layout sections), `USAGE.md` (viewer: Download, Download ZIP and why some files have no Download; layout `<folder>.zip`; merge copies it), `TECHNICAL.md` (artifacts store: the ZIP; viewer: Download), `CLAUDE.md` (§2 file map: `tests/e2e/download.e2e.js`; §7 layout and `artifact.json` `zip`), `tests/README.md` (the new e2e), `manifest.json` → `1.19.0`.

- [ ] **Step 1:** Write the docs; the changelog says Download works for files the viewer holds (text, preview images) and why big binaries keep Open file only.
- [ ] **Step 2: Run** `sh tests/run.sh` → `# fail 0` (the manifest/changelog test passes).
- [ ] **Step 3: Commit** — "Download and artifact ZIP docs and version (v1.19.0)".
