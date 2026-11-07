# Upload Text in viewer-files Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move large upload text out of `viewer.html` into `viewer-files/part-NNNN.js`, loaded when an upload is opened, in extension exports and in the old-archive tool.

**Architecture:** A pure function in `takeout-viewer.js` takes the finished viewer data, swaps each large `uploads[].text` for a part number and key, and returns the parts to write. The extension adds the parts to the ZIP, and the tool writes them next to the parts it already makes for added files. The viewer loads a part when its upload's popup opens, through the existing `loadPart`.

**Tech Stack:** Plain JS (classic scripts and Node 20), JSZip, Node test runner, Playwright e2e.

**Spec:** No separate document. The design was agreed with the owner in chat on 2026-11-07:
- Only `uploads[].text` moves. Search never reads it, so search stays exactly as it is.
- Pasted attachments (`attachments[].text`) stay in the page, because search does read them.
- Both the extension and `tools/build_viewer.js` write the parts.
- Measured on the April mega-ZIP: upload text is 35.6 MB of an 81 MB viewer.

## Global Constraints

- Part format stays `window.__archivePart(<n>, {<key>: <text>, ...});`, built with `CTViewer.escapeJson`, at most `PART_LIMIT` = 4 * 1024 * 1024 bytes each. A single text larger than the limit gets a part of its own.
- An upload's text moves only when its UTF-8 size is over `UPLOAD_INLINE_LIMIT` = 64 * 1024 bytes. Smaller uploads stay inline, so most single-chat exports change nothing.
- Upload keys are `u0`, `u1`, … in data order. Added-file keys stay as they are (`"0"`, `"1"`, …).
- `fileScripts: true` is passed to `assembleViewer` only when at least one part exists.
- `buildSearchIndex` and everything it reads are not changed.
- The input to `moveUploadText` is never mutated.
- Viewer failure never blocks the export (the existing `writeViewer` try/catch stays).
- Version 1.6.4 in `manifest.json` and a `### v1.6.4` README entry.

## Review Focus

1. **Multi-byte text near the limit**: sizes are UTF-8 bytes, not characters, so a 40,000-character text of emoji (about 160 KB) moves. Pinned in Task 1.
2. **Hostile upload text** (`</script>`, `<!--`, U+2028) must survive a part round trip byte for byte and run as valid JS. Pinned in Task 1.
3. **Closing a popup before its part loads**: the text must not land in a later popup. Pinned in Task 2.
4. **Old archives with both added files and large uploads**: upload parts must be numbered after the added-file parts, and both kinds must open. Pinned in Task 4.
5. **A missing or unloadable part** (deleted folder, unzipped ZIP): the popup shows "This file is not in this export." and the next open tries again. Pinned in Task 2.

---

### Task 1: `moveUploadText` in `takeout-viewer.js`

**Files:**
- Modify: `takeout-viewer.js` (header comment, constants, new function, `api`)
- Test: `tests/viewer.test.js`

**Interfaces:**
- Produces: `moveUploadText(data, { firstPart = 1, inlineLimit = UPLOAD_INLINE_LIMIT, partLimit = PART_LIMIT } = {}) -> { data, parts: [{ name: 'part-NNNN.js', body: string }] }`. In the returned `data`, a moved upload is `{ name, href, text: null, lines, part, key }`, where `lines` is `text.split('\n').length`. Untouched chats and uploads keep their identity where nothing changed.
- Produces: constants `PART_LIMIT`, `UPLOAD_INLINE_LIMIT` on `CTViewer`.

- [ ] **Step 1: Write the failing tests** in `tests/viewer.test.js`:
  - `moveUploadText moves only large upload text, numbered from firstPart`: three chats with uploads of 10 KB, 70 KB and 70 KB ASCII and a 70 KB attachment; `firstPart: 3`. Assert two uploads have `text === null`, `part === 3`, keys `u0` and `u1`, correct `lines`; the 10 KB upload and the attachment keep their text; `parts.map(p => p.name)` is `['part-0003.js']`; the input is unchanged (`JSON.stringify` before and after).
  - `moveUploadText leaves the search index unchanged`: `buildSearchIndex(linkProjects(clone(before)))` deep-equals the same for the moved data.
  - `moveUploadText splits at partLimit and keeps hostile text intact`: `partLimit: 100 * 1024`, uploads of 70 KB, 70 KB, and one of `'</script><!-- ' + '😀'.repeat(40000)`. Assert three parts, each body under the limit unless it holds one text, and evaluating each body with a stub `window.__archivePart` gives back the exact original texts.
  - `moveUploadText with nothing to move returns no parts`: `parts` is `[]`, and the data deep-equals the input.

- [ ] **Step 2: Run** `node --test tests/viewer.test.js`. Expected: the new tests FAIL with `moveUploadText is not a function`.

- [ ] **Step 3: Implement** `moveUploadText` and the two constants in `takeout-viewer.js`, add them to `api` and to the header comment. Count bytes with `new TextEncoder().encode(text).length`. Fill parts in data order, flushing before an item would push the body past `partLimit`, the same way `buildParts` in `tools/build_viewer.js` does.

- [ ] **Step 4: Run** `sh tests/run.sh`. Expected: all pass.

- [ ] **Step 5: Commit** `takeout-viewer.js` and `tests/viewer.test.js`: "Add moveUploadText for upload text parts".

### Task 2: The viewer loads upload text from parts

**Files:**
- Modify: `viewer/viewer-app.js` (`setupAdded`, `fileNote` call in `renderHuman`, `openPopup`)
- Modify: `tests/e2e/make-viewer.js` (new `buildFiles`)
- Create: `tests/e2e/parts.e2e.js`

**Interfaces:**
- Consumes: Task 1's `moveUploadText` and the moved-upload shape.
- Produces: `buildFiles(conversations, exported, ctxOf) -> { html, parts }` in `tests/e2e/make-viewer.js`, the same as `buildHtml` with `moveUploadText` applied and `fileScripts` set when parts exist.

- [ ] **Step 1: Write `tests/e2e/parts.e2e.js`** in the style of `colors.e2e.js`: write `viewer.html`, `viewer-check.gif` and `viewer-files/` to a temp folder. Checks:
  - `a large upload opens from its part`: the popup shows the full text, with colors for a `.py` upload.
  - `the chip still shows the line count`.
  - `a small upload and a large attachment stay inline` (no part loaded: count `file:` requests to `viewer-files/`).
  - `search is unchanged`: a word in a prompt finds the chat, and a word only inside a large upload finds nothing, as before.
  - `closing before the part arrives keeps the text out of the next popup`: delay the part with a `page.route` that waits 500 ms, open upload A, close, open small upload B; B's popup shows B's text only.
  - `a missing part says so and the next open tries again`: delete `viewer-files/` before opening; expect "This file is not in this export."; restore the folder; reopen shows the text.
  - `zero console errors` and `zero network requests`.

- [ ] **Step 2: Run** it (command in `tests/README.md`). Expected: FAIL at the first check.

- [ ] **Step 3: Implement.** In `setupAdded`, also list part numbers from every chat's `messages[].uploads[].part`, and install `__archivePart` when any part is listed (rename it to `setupParts(data)` and call it with the whole data). In `renderHuman`, pass `u.text` or, when it is null, the stored `lines` to the chip note. In `openPopup`, for an item with `text === null` and a listed `part`, show `Loading…`, call `loadPart`, and draw the text only if that same popup is still open; on success store the text on the item so a reopen is instant; otherwise show "This file is not in this export.".

- [ ] **Step 4: Run** `parts.e2e.js`, `viewer.e2e.js` and `colors.e2e.js`. Expected: all pass.

- [ ] **Step 5: Commit** "Load large upload text from viewer-files in the viewer".

### Task 3: Extension exports write the parts

**Files:**
- Modify: `popup.js` (`writeViewer`)
- Test: `tests/export.test.js`

**Interfaces:**
- Consumes: `CTViewer.moveUploadText(data)`.

- [ ] **Step 1: Write the failing test** `writeViewer puts large upload text in viewer-files`: a chat whose upload text is 70 KB. Assert `zip.written` has `viewer-files/part-0001.js`, `viewer.html` does not contain the text, and its CSP `script-src` includes `file:`. Keep the existing test that expects only `viewer.html` and `viewer-check.gif` for small uploads.

- [ ] **Step 2: Run** `node --test tests/export.test.js`. Expected: the new test FAILS.

- [ ] **Step 3: Implement**: in `writeViewer`, run `moveUploadText` on the built data, add each part as `viewer-files/<name>`, and pass `fileScripts: parts.length > 0`. All of it stays inside the existing try, so a failure writes nothing.

- [ ] **Step 4: Run** `sh tests/run.sh` and `tests/e2e/export.e2e.js`. Expected: all pass, and the export baseline is unchanged.

- [ ] **Step 5: Commit** "Write upload text parts in extension exports".

### Task 4: The old-archive tool writes the parts

**Files:**
- Modify: `tools/build_viewer.js` (`writeViewer`, `PART_LIMIT` now from `CTViewer`)
- Test: `tests/archive.test.js`

**Interfaces:**
- Consumes: `CTViewer.moveUploadText(data, { firstPart: built.partCount + 1 })`, `CTViewer.PART_LIMIT`.

- [ ] **Step 1: Write the failing test** `writeViewer numbers upload parts after added-file parts`: an archive with one added text file and one 70 KB text upload. Assert `viewer-files/part-0001.js` holds the added file under key `"0"`, `part-0002.js` holds the upload under `u0`, and only the viewer, gif and parts are new files (reuse the existing untouched-files helper).

- [ ] **Step 2: Run** `node --test tests/archive.test.js`. Expected: FAIL.

- [ ] **Step 3: Implement**: after `buildViewerData`, call `moveUploadText` with `firstPart: built.partCount + 1`, write its parts through the same temp-folder writer used for `onPart`, and pass `fileScripts` when either kind of part exists. `PART_LIMIT` in the tool becomes `CTViewer.PART_LIMIT` and stays exported.

- [ ] **Step 4: Run** `sh tests/run.sh` and `tests/e2e/archive.e2e.js`. Expected: all pass. Then rebuild the scratch copy of the April mega-ZIP with `--force` and record the new `viewer.html` size; expected about 46 MB, opening with no console errors.

- [ ] **Step 5: Commit** "Write upload text parts in the old-archive tool".

### Task 5: Docs and version

**Files:**
- Modify: `manifest.json`, `README.md`, `USAGE.md`, `CLAUDE.md`, `tests/README.md`

- [ ] **Step 1:** Bump to 1.6.4. README entry: large upload text now loads from `viewer-files/`, with the measured April sizes. USAGE: exports may now include `viewer-files/`, and uploads open only after unzipping. CLAUDE.md §2 and §7: `viewer-files/` is written by both the extension and the tool, with the upload keys and `UPLOAD_INLINE_LIMIT`. `tests/README.md`: add `parts.e2e.js`.

- [ ] **Step 2: Run** `sh tests/run.sh` (the version test) and all six e2e suites. Expected: all pass.

- [ ] **Step 3: Commit** "Document upload text parts and bump to 1.6.4".
