# Published Pages in Chat Exports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A chat export saves the version of every page Claude published in the chat (`publish_files`), and the viewer shows it once, as a card that opens in the side panel.

**Architecture:** `export-core.js` lists the pages a chat published (pure). `content.js` on claude.ai fetches a page's metadata and files; the asset token never leaves it, and files cross to the popup as base64, one per message. The popup's `savePublishedPages` decides per version whether the page is the same as a file the chat already holds (by SHA-256 of the text at publish time) and otherwise saves it: in the chat's `published/` folder, or, in Export All, once at the export root `published/` (like `projects/`), with `published.json` merged across chats and written once at the end. The viewer turns each publish into one card through the existing file-card path; the old-archive and merge tools learn the new folder.

**Tech Stack:** Chrome MV3 extension, plain JS (classic scripts), Node test runner, Playwright e2e.

**Spec:** No separate spec doc. Design agreed in chat 2026-11-16 from the spike (memory `claude-ai-docs-live-content.md`, section "2026-11-16 spike") and a plan review the same day; decisions taken: folder `published/` per chat and at the Export All root; one place per message (the card replaces the "Published on claude.ai" line and the attached copy's chip); older chats without a page id get the current version, labelled so; merge tool supports `published/`. Starts after PR #51 (v1.13.0) merges; branch `published-pages` from `main`. Version v1.14.0. The "Export Artifacts" button is a later feature.

## Global Constraints

- Endpoints (private, GET only): `https://claude.ai/api/frame/<uuid>?org=<org>[&ver=<ver>]` with header `X-Frame-CP: go`, `credentials: 'same-origin'` → `{ ver, history[], title, files[] (current version only), assetToken }`. `https://<uuid>.frame.claudeusercontent.com/_f/<ver>/_files.json?__frame_t=<token>` → `{ ver, files: { <path>: { sha256, size, contentType } } }`; `…/_f/<ver>/_src/<segments, each encodeURIComponent>?__frame_t=<token>`. Frame requests: `credentials: 'omit'`, `referrerPolicy: 'no-referrer'`, `redirect: 'error'`.
- The asset token is a secret: it stays inside `content.js`, is never returned, never put in an error string, `errors.txt`, `published.json`, `urlsTried` or a log our code writes. (Chrome itself may log a failed request's URL in DevTools; that can't be prevented.) Token expiry: 4th dot-separated part as epoch seconds; if not a finite number between now and now + 24 h, treat it as fetch time + 50 min. Refetch when under 60 s left, after a 403 (once), and when no cached token exists (e.g. content.js re-injected).
- Every content.js action wraps its body in try/catch and always calls `sendResponse`; errors are `{ error: 'HTTP <status>' | 'network' | 'too large' | …, status }`, built from codes, never from `e.message` or a URL.
- Caps: `PUBLISHED_MAX_FILE = 32 * 1024 * 1024` (raw bytes, checked from `_files.json` size before fetching), `PUBLISHED_MAX_BYTES = 50 * 1024 * 1024` per page version. Base64 is encoded in chunks (no `String.fromCharCode(...wholeArray)`).
- Skip paths starting `artifact-type/`. Reject a `_files.json` path with an empty, `.` or `..` segment or a leading `/` (warn, don't fetch).
- `ver` must match `/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/`; `uuid` `/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i`; anything else is ignored with a warning.
- Saved paths: each segment through `publishedSegment(name)` = `zipSafeName` plus `<>:"|?*` → `_`, trailing dots/spaces trimmed, Windows device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9`, any case, with or without extension) prefixed `_`; case-only and file/folder collisions get `_2`, `_3` with a `published_page` warning.
- Page folder name `<safeFileTitle(title) || 'page'>_<shortId>`, chosen once per uuid (titles change). Chat level: `<chat>/published/<page>/`; Export All: `published/<page>/` at the root. `published` is reserved as a chat folder name in `bulkExportZip` and as a root name in `merge_archives.js`.
- New warning type `published_page` with a `_getRecoveryHint` case (CLAUDE.md §11); one "signed out" warning per export for 401, not per page.
- Commit as bearspear with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; commit/push only with the owner's OK.

## Review Focus

1. Export All: a page published from two chats is stored once at the root, `published.json` lists both chats' versions, and both chats' cards link there (`href` starting `published/`). → Task 3 and Task 4 tests.
2. A page published, then edited in the chat, then published again: v1 compares against the text at v1's message, v2 against v2's; "same" is decided per version. → Task 3 test.
3. A page that can't be fetched (404, 401, 429, 5xx, network): the chat still exports, one warning with the page link and no token; a version whose start file failed gets no link. → Task 2 and Task 3 tests.
4. A message that published a page and got the page attached by claude.ai shows the page once (one card, one claude.ai link). → Task 4 e2e.
5. Unsafe paths from `_files.json` (`a/../b`, `con.txt`, `x:y`, `Index.html` beside `index.html`, `a` beside `a/b`) stay inside the page folder with distinct names. → Task 3 test.

---

### Task 1: List the pages a chat published

**Files:**
- Modify: `export-core.js` (add `isPublishTool` here and export it; popup.js's copy at popup.js:2960 is removed and uses this one), `export-core.js` `module.exports`
- Test: `tests/export.test.js`

**Interfaces:**
- Produces:
  - `isPublishTool(name) -> boolean` (`/(^|__|:)publish_files$/`).
  - `base58ToUuid(shortId) -> string | ''` (Bitcoin alphabet; '' unless the id is 21–22 alphabet characters, its value is below 2^128, and re-encoding the 16 bytes gives the same string; result is the canonical lowercase UUID).
  - `publishedPagesOf(data) -> Array<{ uuid, shortId, ver, title, url, current: boolean, publishes: Array<{ messageUuid, toolUseId }>, sources: Array<{ as, path }> }>`: from every `tool_use` matching `isPublishTool` and its `tool_result` found by `tool_use_id` (not by the result's name), skipping `is_error` results. From the result's leading JSON (`leadingJson(resultText(r))`): `slug` (uuid), `version`, `url`, `title`. When `slug`/`version` are missing but `url` is `https://claude.ai/artifact/<shortId>`, take `uuid = base58ToUuid(shortId)`, `ver = ''`, `current = true` (fetch the live version). One entry per uuid+ver (`ver ''` counts as one), in chat order over all messages, with every publishing message in `publishes`. A `current` entry is kept separate here; Task 3 merges it into an explicit-`ver` entry of the same chat when the live version resolves to that `ver`. Invalid uuid/ver per Global Constraints are dropped.

- [ ] **Step 1: Write the failing tests**
  - `publishedPagesOf lists each page version once with every message that published it`: two `publish_files` for one slug (`v1`, `v2`), a repeat of `v2` in a later message, a result without a `name` field, an `is_error` result, non-JSON text. Assert the entries `[uuid, ver, publishes.length]` are `[[U, 'v1', 1], [U, 'v2', 2]]`, `sources` is `[{ as: 'index.html', path: '/home/claude/guide.html' }]`.
  - `an old publish result with only a url gets the current version`: result `{ url: 'https://claude.ai/artifact/LkJGYP3ZBnSGbvhLfeWAG1', title: 'T' }` → `{ uuid: '9fe94226-9819-4551-8836-a76d0c116102', ver: '', current: true }`.
  - `bad ids and versions are dropped`: slug `../x`, version `../../a`, and a url-only result with short id `XYZ` (the existing `publishChat` fixture) → no entry; `base58ToUuid('XYZ') === ''`.
- [ ] **Step 2: Run** `node --test --test-name-pattern="publishedPagesOf|old publish result|bad ids" tests/export.test.js` — Expected: FAIL (not a function).
- [ ] **Step 3: Implement** the three functions; switch popup.js to the shared `isPublishTool`.
- [ ] **Step 4: Run** the same, then `sh tests/run.sh` — Expected: all pass.
- [ ] **Step 5: Commit** `Add publishedPagesOf: the pages a chat published`.

### Task 2: content.js fetches a published page

**Files:**
- Modify: `content.js` (two actions beside `fetchConversation`)
- Test: `tests/panel.test.js` (real `content.js` in a vm; sandbox gets `crypto` (`require('crypto').webcrypto`), `btoa`, `atob`, `TextEncoder`, `URL`, stub `fetch`)

**Interfaces:**
- Produces two `chrome.runtime.onMessage` actions (each `return true` and always `sendResponse`):
  - `{ action: 'publishedPageInfo', uuid, ver }` (`ver ''` = live) → `{ ver, title, history, files: [{ path, size, contentType, sha256 }] }` (from `_files.json`; `artifact-type/*` and bad paths removed, bad paths listed in `rejected: [path]`) or `{ error, status }`. Caches the token per `uuid:ver` (and under the resolved `ver` when `ver` was '').
  - `{ action: 'publishedPageFile', uuid, ver, path, size }` → `{ base64, contentType, size }` or `{ error, status }`. Refuses before fetching when the popup's `size` or the cached `_files.json` size exceeds `PUBLISHED_MAX_FILE` (`error: 'too large'`); on a cache miss it fetches `_files.json` again first. 403 → new token, one retry. 429 → one retry after `Retry-After` (≤ 10 s, else give up). 5xx → one retry after 1 s. Waits go through a module-level `publishedDelay(ms)` the tests replace.
- No response ever holds the token or a frame URL.

- [ ] **Step 0 (owner, before Step 1):** owner loads the branch unpacked, opens the dimmer chat, and in the extension's side-panel DevTools runs `chrome.tabs.sendMessage(<claude tab id>, { action: 'publishedPageInfo', uuid: '9fe94226-9819-4551-8836-a76d0c116102', ver: '' }, console.log)` then one `publishedPageFile` for `index.html` (a 10-line throwaway build of just these two actions is fine). Expected: info with `index.html`, file with base64. Step 0 decides Task 2's target file. If the isolated world is refused (CORS, missing header), the two fetches move into `injected.js` (page world) behind a `postMessage` request/response with a random nonce, the token stays there, Task 2's tests are rewritten against `injected.js` (same assertions), and the ledger records the ruling and the accepted exposure: file bytes pass through `window.postMessage`, readable by other scripts on claude.ai (the token is claude.ai's own and already in that world).
- [ ] **Step 1: Write the failing tests** in `tests/panel.test.js`:
  - `publishedPageInfo sends X-Frame-CP, drops the type runtime and bad paths, and returns no token`: `/api/frame` → `{ ver: 'V', title: 'T', history: ['V'], assetToken: 'a.b.c.<now+3600>' }`; `_files.json` → `index.html`, `data.json`, `artifact-type/x.js`, `../evil`. Assert header `X-Frame-CP: go`; files `['index.html', 'data.json']`; `rejected: ['../evil']`; `JSON.stringify(response)` has no `a.b.c` and no `__frame_t`.
  - `publishedPageFile retries once on 403 and encodes in chunks`: first `_src/index.html` → 403, second → 3 MB of bytes; assert base64 decodes back to the same bytes and `/api/frame` was called twice.
  - `an expired or missing token is fetched again before the file`: token with past expiry; and a fresh content.js with no cache → each makes one `/api/frame` call before `_src`.
  - `errors carry no token`: `_src` → 500 twice → `{ error: 'HTTP 500', status: 500 }`; `fetch` throwing `new Error('https://x.frame.claudeusercontent.com/_f/V/_src/a?__frame_t=a.b.c.9')` → `{ error: 'network' }`; neither contains `__frame_t` or `a.b.c`.
  - `a file over the cap is refused before fetching`: `_files.json` lists `big.bin` at 40 MB; `publishedPageFile` with `size: 40 * 1024 * 1024` → `{ error: 'too large' }`, no `_src` request; and with no cache, the re-fetched `_files.json` size refuses it the same way.
  - `429 waits once for Retry-After`: 429 with `Retry-After: 1` then 200 → success; `publishedDelay` stubbed to record `[1000]` and resolve at once.
- [ ] **Step 2: Run** `node --test tests/panel.test.js` — Expected: the new tests FAIL.
- [ ] **Step 3: Implement** both actions.
- [ ] **Step 4: Run** `node --test tests/panel.test.js`, then `sh tests/run.sh` — Expected: all pass.
- [ ] **Step 5: Commit** `content.js: fetch published pages for the export`.

### Task 3: Save published pages in the export

**Files:**
- Modify: `export-core.js` (`versionAsOf(entry, chain, messageUuid)` moved here from `takeout-viewer.js` `addCards`, which then uses it; `extractAttachedFiles` entries gain `messageUuid`; archive-lib.js:408 updated), `popup.js` (`savePublishedPages`; called from `populateConversationFolder` after the upload-inlining pass, so "same" compares final on-disk text; `createZipExport` and `bulkExportZip` pass a fetcher; `bulkExportZip` reserves `published`, adds `published: new Map()` to its shared object and writes merged root `published.json` files after the chat loop; `_getRecoveryHint` `case 'published_page'`; README.md per chat gets a "Published pages" section; `publishedLines` links the local copy)
- Test: `tests/export.test.js`, `tests/helpers.js` (sandbox gets `crypto`; a `publishedFetcher(pages)` stub helper)

**Interfaces:**
- Consumes: `publishedPagesOf` (Task 1); content.js actions (Task 2) through `ctx.fetchPublished(message) -> Promise<response>`.
- `fetchPublished` comes from the caller: single ZIP uses the tab id from `loadConversationForExport`'s tab; Export All uses its own `tab.id`; both send with `sendToTab` for the first call and `sendOnce` after (no re-injection loops). `bulkExport` (Markdown/JSON) never calls `savePublishedPages`. A ZIP/folder export with no claude.ai tab gets one `published_page` warning per chat: "page not fetched: no claude.ai tab". A 401 is warned once per export, in the `errors.txt` of the first chat that hit it; later pages in that export are skipped without fetching.
- Produces: `async function savePublishedPages(folder, data, ctx) -> Array<PublishedEntry>`, `ctx = { errorCollector, artifacts, artifactIndex, attached, fetchPublished, shared, chatFolder }`, where
  `PublishedEntry = { uuid, shortId, title, url, current, dir, versions: Array<{ ver, folderName, label, order, start, startSaved, same, writtenAs, incomplete, needsRuntime, text, publishes: [{ messageUuid, toolUseId }] }> }` — only the versions this chat published.
  - `dir`: always relative to the chat folder: `published/<page>` (chat level) or `../published/<page>` (Export All), like a project's `fileDir`.
  - `folderName`: the version's sanitized folder (`<ver>` or `current`); `startSaved`: the start file's saved name (`savedAs`); `order`: its index in `history[]` oldest first (`current` last); `needsRuntime`: the start text references `artifact-type/` or `/_f/`.
  - Per file: a `_files.json` path is matched to `sources[].as`; it is `same` when it is text and its published `sha256` equals the SHA-256 of the UTF-8 bytes on disk for its source at that publish: the artefact version as of the publishing message (`versionAsOf`, export-core.js) read as `viewerArtifacts[name] ?? artifacts[name]` (the inlined text, as written to disk), or a downloaded (`existing: false`) claude.ai-attached file of that message with the same name (`attached`, by `messageUuid`). A file with no source, a binary artefact, or an off-branch publish (not in `artifactIndex`) is never `same`. The version is `same` only when all its files are; then nothing is saved for this chat and `writtenAs` is the artefact file name (`<base>_vN<ext>` when versioned); otherwise all its files are saved under `<dir>/<folderName>/` and `writtenAs` is null. A `current` entry that resolves to a `ver` this chat also published explicitly is merged into that version.
  - `start`: `index.html` if present, else the first `.html`, else the first file; `incomplete: true` and no `start` when the start file failed; `text`: the start file's text when text and ≤ `CTViewer.TEXT_EMBED_LIMIT`, else null.
  - `label`: `v1`, `v2`, … in order of `history[]` (oldest first), `current` for `ver ''`.
- Writes `published.json` per page: `{ format: 1, title, url, shortId, uuid, versions: { <folderName>: { ver, label, order, saved, files: [{ path, savedAs, size, contentType, sha256 }], start, startSaved, incomplete, needsRuntime, missing: [path], publishedIn: [{ chat: <chat uuid>, messageUuid, toolUseId, same, writtenAs }] } } }` — `same`/`writtenAs` per chat, `saved` whether the files are stored, keys never `''`. Chat level: written per chat. Export All: merged in `shared.published` (keyed by uuid; folder chosen on first sight) and written once per page after the loop; a version stored by an earlier chat is not fetched again, but a `same` version is re-checked against each chat's own text and, when another chat isn't `same`, fetched and stored then.

- [ ] **Step 1: Write the failing tests** (`publishedFetcher` stub answers the two actions from a table, counts calls):
  - `a published page is saved in published/ with published.json, and no frame URL reaches any file` — page with `index.html` (differs from the written file) and `data.json`: files at `published/Guide_<shortId>/<ver>/…`; `published.json` as specified; `errors.txt` (if any) and `published.json` contain no `frame.claudeusercontent.com` and no `__frame_t`.
  - `a version identical to the text Claude wrote is not copied; one edited later is` (Review Focus 2) — v1 equals the guide as written before an Edit, v2 equals the edited guide: v1 `same`, `writtenAs: 'guide_v1.html'`; a third publish after an unrelated edit, with the page's own change, is copied.
  - `a page attached by claude.ai to the publishing message counts as the written copy` (downloaded attached file only; an `existing: true` attachment does not count by itself).
  - `a page whose source inlined an upload compares the inlined text on disk` (source references `/mnt/user-data/uploads/x.png`; published bytes equal the un-inlined text → not `same`).
  - `a two-file page where only index.html matches is copied` (per-file `same`).
  - `the extension's message wiring is used` — one `runBulkZip` with `sb.chrome.tabs.sendMessage` answering the two actions; assert the pages are saved and `chrome.scripting.executeScript` was not called.
  - `a binary artefact is never the same as a published file`.
  - `Export All stores a page published from two chats once and lists both` (Review Focus 1) — via `runBulkZip` with the stub: one root `published/<page>/`, `published.json` has both versions and both chats in `publishedIn`, one `/api/frame` info call per version; a chat titled `published` gets `published_2`.
  - `pages that can't be fetched are warnings, and the chat still exports` (Review Focus 3) — 404 → `published_page` warning with the `claude.ai/artifact/…` link; 401 on two pages → one warning; a version whose `index.html` failed sha256 → `incomplete`, no `start`, `missing: ['index.html']`.
  - `published file paths stay inside the page folder with distinct names` (Review Focus 5) — `_files.json` with `con.txt`, `x:y.txt`, `Index.html` + `index.html`, `a` + `a/b`, and rejected `../evil`: saved names, in `_files.json` order `Index.html`, `index.html`, `a`, `a/b`, `con.txt`, `x:y.txt`: `Index.html`, `index_2.html`, `a`… then `a/b` → `a_2/b`, `_con.txt`, `x_y.txt`; one warning listing the renames and the rejected path.
  - `a ZIP export without a claude.ai tab warns that pages were not fetched` — no `fetchPublished`: one warning "page not fetched: no claude.ai tab", nothing under `published/`.
- [ ] **Step 2: Run** `node --test --test-name-pattern="published|Published|Export All stores" tests/export.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** as specified (decode base64 to `Uint8Array` in chunks; verify SHA-256 in the popup over the decoded bytes; caps from Global Constraints).
- [ ] **Step 4: Run** `node --test tests/export.test.js`, then `sh tests/run.sh` — Expected: all pass. If `tests/fixtures/conversation.json` was not changed, `export-baseline.json` stays as is; if a publish was added there, refresh it per `tests/README.md`.
- [ ] **Step 5: Commit** `Save the pages a chat published, once per export`.

### Task 4: One card per publish in the viewer; the old-archive and merge tools

**Files:**
- Modify: `takeout-viewer.js` (`addCards`: a `publish_files` tool block gets a card from `ctx.published`, matched by uuid+ver from its own result via `toolUseId`; header comment documents `ctx.published`), `viewer/viewer-app.js` (`renderCard` labels a published file "Published page" and shows "Same as published" per version; `renderPublished` is not drawn for a publish that has a card; a claude.ai-attached upload chip of that message whose name equals the page's source is not drawn), `tools/archive-lib.js` (`KNOWN_DIRS` gains `published`; `chatFromDisk` rebuilds `published` from `<chat>/published/*/published.json` and, at a mega root, `<root>/published/*/published.json` matched by uuid to `publishedPagesOf(data)`), `tools/merge_archives.js` (reserves `published`; copies root `published/<page>/` per page by uuid, uniting version folders and merging `published.json` `versions`/`publishedIn`)
- Test: `tests/viewer.test.js`, `tests/archive.test.js`, `tests/merge.test.js`, new `tests/e2e/published.e2e.js`

**Interfaces:**
- Consumes: `PublishedEntry` (Task 3) as `ctx.published`.
- Produces: GenFile `{ name: title, kind: kindFor(startSaved || writtenAs, null, hasText), published: { url, current, needsRuntime }, versions: [{ label, text, href, same }] }`, key `published:<uuid>` (off-branch publishes use the same key, not `x:`-prefixed); `href` = `relHref(joinPath(folder, dir), folderName, startSaved)` (`dir` is always chat-relative, `joinPath` resolves `..`; never a raw `..` into `relHref`); for a `same` version `href` is the written artefact's href. Versions ordered by `order`. A version with `incomplete` and no `startSaved` has `href: null`. `isShared` treats `published:` keys as outputs. The card shows `title` with the sub-label "Published page", and "Needs claude.ai to run" when `needsRuntime`. `chatFromDisk` builds the same entries from `published.json`, keeping only versions whose `publishedIn` has `chat === data.uuid` and taking `publishes` from `publishedPagesOf(data)`.
- Known limit, stated in USAGE.md: the sandboxed preview shows the start file; its own scripts and styles from the page folder load only through the existing sibling lookup when their names match chat files, so multi-file pages preview incompletely; pages built on claude.ai's type runtime (`artifact-type/` referenced) get "needs claude.ai to run" on the card.

- [ ] **Step 1: Write the failing tests**:
  - viewer unit: `a publish gets one published-page card, with versions in order` (orders 0, 1, … 10 sort numerically); `a same version links the written file` ; `an Export All card links published/ at the export root` (chat folder `chatA`, `dir '../published/Guide_<id>'` → `href === 'published/Guide_<id>/<ver>/index.html'`); `a current version links current/` ; `a renamed start file links its saved name` ; `an incomplete version has no link`.
  - archive unit: `parity: published pages on disk rebuild the same viewer chat` (chat level and mega); `scanAdded does not list published/ at a mega root`.
  - merge unit: `merging two archives that share a page keeps one page with both versions`.
  - e2e `published.e2e.js`: one card per publish; no "Published on claude.ai" line and no duplicate chip on that message; exactly one `claude.ai/artifact` link in the message; opening the card shows the preview in the side panel; "Same as published" on a same version; mega layout card opens; no network requests; no page errors.
- [ ] **Step 2: Run** `node --test tests/viewer.test.js tests/archive.test.js tests/merge.test.js` and `PW=… CHROME_EXE=… node tests/e2e/published.e2e.js` — Expected: FAIL.
- [ ] **Step 3: Implement** as specified.
- [ ] **Step 4: Run** `sh tests/run.sh` and every viewer e2e (`viewer stepper navigation search files archive parts colors webimages steps prompts cards published`) — Expected: all pass except viewer.e2e.js's 3 Chrome-only failures that `main` has.
- [ ] **Step 5: Commit** `Show each published page once, as a card; teach the archive and merge tools published/`.

### Task 5: Docs, version, real-export check

**Files:**
- Modify: `manifest.json` (1.14.0), `README.md` (v1.14.0 entry; layout: `published/` per chat and at the Export All root), `USAGE.md` (`published_page` warning row; preview limits; what "current, not necessarily the published version" means), `TECHNICAL.md` (section "Published pages": endpoints, token rule, caps, same-per-version, layout, sharing in Export All; warning table row), `CLAUDE.md` (file map; §5.3 `publish_files` row; §7 layout; §11 warning; test list), `tests/README.md` (published.e2e.js), validate-export skill note (in the claude-skills repo, separately): `published/` is expected beside `artefacts/`.

- [ ] **Step 1:** Update the docs; `sh tests/run.sh` passes (manifest vs changelog test).
- [ ] **Step 2:** Owner reloads the extension and exports the dimmer chat (`5be2a7ae-…`) as a ZIP and with Export All to a folder. Check: `published/Dining_room_dimmer_swap_LkJG…/published.json` with `same: true` and `writtenAs: 'dimmer-guide.html'`; one card in the viewer; `grep -rl "__frame_t\|frame.claudeusercontent" <export>` finds nothing.
- [ ] **Step 3: Commit** `Docs for published pages (v1.14.0)`; open the PR after the owner's OK.
