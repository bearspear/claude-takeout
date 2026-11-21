# Artifacts Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every Export Artifacts export gets a `viewer.html` that browses the artifacts like claude.ai/artifacts: a card grid with claude.ai's own card pictures, and a click opens the artifact full page in a sandbox.

**Architecture:** The export (popup.js) records a small viewer record per artifact as it saves it, writes the artifact's preview texts and images into `viewer-files/` parts right away, and fetches claude.ai's card picture through a new content.js action. After the loop, a new page (`viewer/artifacts-template.html` + `viewer/artifacts-app.js`, reusing `viewer/viewer-logic.js` and `marked`) is assembled with `CTViewer.assembleViewer` into `viewer.html`.

**Tech Stack:** Chrome MV3, plain JS (classic scripts), JSZip / `createDiskFolder`, Node test runner, Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-11-16-artifacts-viewer-design.md` (owner-approved; read it — it is the authority).

## Global Constraints

- Branch `artifacts-viewer` (from main at v1.15.0). Version 1.16.0 (manifest + README changelog), in the last task.
- The card picture URL (`thumbImgURL`), the asset token and any frame URL never leave content.js and never reach any written file. Viewer code contains none of the strings `claudeusercontent`, `__frame_t`, `_thumb`.
- `thumbImgURL` is accepted only if: `https:`, no port, no userinfo, no hash, host exactly `<uuid>.frame.claudeusercontent.com` for that artifact's uuid (both lowercased; the map is keyed by lowercased uuid), path exactly `/_f/<ver>/_thumb.img` with `<ver>` matching content.js's `PUBLISHED_VER`, exactly one query parameter, named `__frame_t`.
- `artifactThumb { uuid }` → `{ base64, type }` or `{ error: <code> }`. The type (`image/png` | `image/jpeg` | `image/webp`) is decided by leading bytes only (PNG `89 50 4E 47 0D 0A 1A 0A`; JPEG `FF D8 FF`; WebP `RIFF` at 0-3 and `WEBP` at 8-11); a response whose content type is explicitly `text/*` or contains `svg` is rejected; anything else → `{ error: 'bad response' }`. Fetched from a URL rebuilt from the checked parts, `credentials: 'omit'`, `referrerPolicy: 'no-referrer'`, `redirect: 'error'`; cap 2 MB while streaming (`publishedReadBody` gains a `max` parameter). On the first 403 of an export, `artifactThumb` re-lists once (one `/api/frame/frames` call refreshes every picture URL) and retries that picture; a second 403 is final. Never returns or logs the URL. The popup re-checks the reply's type against the allowlist before choosing the extension.
- Pictures saved at `viewer-files/thumbs/<shortId>.<png|jpg|webp>`; `artifact.json` `thumb` = that root-relative path, omitted when none. A picture failure never fails or warns; it doesn't set `state.publishedSignedOut`.
- "Card pictures: N of M" (M = artifacts listed) in `index.md`, `index.html`; `export-manifest.json` gains `thumbs: N`.
- `audience` is never stored: `listArtifacts` returns `public: audience === 'public'` (boolean) instead; `artifact.json` gains `public` (boolean) and `start` (the start file's original path, or null). Nothing existing changes meaning; `format` stays 1.
- Viewer record per artifact (`ArtifactView`): `{ id: shortId || uuid, title, kind: typeTitle || 'Page', typed: boolean, docs: boolean, shared: boolean, public: boolean, createdAt, updatedAt, folder, start: path|null, startSaved: savedAs|null, startKind: 'html'|'svg'|'md'|'image'|'react'|'mermaid'|'other'|null, startSize: number|null, tooLarge: boolean, files: [{ path, savedAs, kind, verified: boolean }], needsRuntime, notExported: boolean, note, url, thumb: path|null, part: number|null, key: string|null }`. Every artifact gets one, including those from `unexpectedArtifactRow` (`notExported: true`).
- Part payload per artifact (key `a<index>`): `{ texts: [[path, text], …], images: [[path, 'data:image/...;base64,...'], …] }` (arrays, never object keys, so a path like `__proto__` is just data; the viewer builds Maps and looks up string paths only). Keyed by the file's original `path` (not its saved `_2` name). Texts of html, htm, css, js, mjs, svg, md files, each ≤ `TEXT_EMBED_LIMIT` (2 MB), total texts ≤ 8 MB per artifact; images png, jpeg, gif, webp each ≤ 2 MB, total ≤ 8 MB per artifact (over a cap: left out). Parts use the chat viewer's format (`viewer-files/part-NNNN.js` calling `window.__archivePart(n, {...})`); a part closes when the next payload would pass `PART_LIMIT`, and one artifact's payload is never split (a part may exceed `PART_LIMIT` by that one payload). Written as each artifact finishes, so folder mode keeps its per-artifact flush. Export-wide budget 256 MB of part bodies: past it, artifacts get no payload (`part: null`) and the viewer shows their details page.
- Start file over `TEXT_EMBED_LIMIT` (2 MB): no text in the part; the page says "too large to show here".
- `artifacts-template.html` uses the chat viewer's CSP except `frame-src 'none'` (no frame may load a file, so a preview can't navigate itself to a saved file outside the sandbox policy). Links between an artifact's pages don't work in the viewer.
- Preview: `srcdoc` iframe, `sandbox="allow-scripts allow-forms allow-modals"` (never `allow-same-origin`, `allow-popups`, `allow-top-navigation`), `PREVIEW_CSP` first (via `previewDoc`), then an in-memory `localStorage`/`sessionStorage` shim script, then the document. Frame style: white background, `color-scheme: normal`.
- Relative-URL resolver: against the start file's folder; `\\` counts as `/`; reject a scheme, a leading `/`, `//`, `?`, `#`, any `..` past the artifact root, and a decoded segment containing `/`; return the original path or null. Inlined CSS keeps its own `url()`/`@import` unresolved (they don't load), and module `import`s don't inline; both documented in USAGE.
- "Open file": only for `!shared` artifacts, or for files `openableHref` allows. `index.html` and `index.md` drop the local link of a shared artifact's HTML/SVG start file (my call for index.md, matching the owner's decision for index.html); `index.html` links `viewer.html` only when it was built (the index files are written after the viewer).
- Hash: `#a=<id>`; anything else or unknown → home. Tabs: All / Yours (`!shared`) / Shared with you (`shared`). Sort `updatedAt` desc, unparsable last, ties by title.
- `writeArtifactsViewer` never fails the export; on failure the status line adds "viewer.html could not be built." Only Export Artifacts gets it; chat exports, `tools/build_viewer.js` and `tools/merge_archives.js` unchanged (they still find no archive in an artifacts export).

## Review Focus

1. A shared artifact whose HTML tries `fetch`, `top.location = …`, `parent.document`, `localStorage`, a form submit, `window.open` → nothing leaves, nothing outside the frame changes, no page error in the viewer (Task 5 e2e).
2. A picture reply that is SVG, HTML or 3 MB → no `thumb`; a truncated PNG may be saved but the card falls back to the tile on load error; the export is complete either way (Task 1 + Task 2 tests, Task 4b e2e).
3. An artifact whose start file is nested (`site/index.html`) linking `./app.css`, `../../x.js` (escapes the root) and `img/a.png`, plus a file whose saved name became `_2` → app.css, the image and the renamed file load (by original path), x.js does not (Task 3 resolver tests + Task 5 e2e).
4. Opening viewer.html from inside an unzipped vs not-unzipped ZIP → grid renders both times; not-unzipped shows tiles and an "unzip first" message on open (Task 4c e2e).
5. A huge export (1000 listed, a 30 MB start file, a 30 MB app.js) → viewer.html stays small (metadata only), the big page says "too large to show here", the big script is left out (Task 2 unit + Task 4c e2e).
6. A preview that navigates itself (`location.href` to https or to a relative saved file, `<meta http-equiv=refresh>`, an `<a>` click) → nothing loads outside the sandbox (Task 5 e2e).

---

### Task 1: Card pictures and `public` in content.js

**Files:** Modify `content.js` (`listArtifacts`, new `artifactThumb` action + private `artifactThumbUrls` map), `export-core.js` (`artifactsFromList` keeps `public`, drops nothing else); Test `tests/panel.test.js`, `tests/export.test.js`.

**Interfaces:**
- Produces: `listArtifacts` frames gain `public: boolean` (no `audience`); action `{ action: 'artifactThumb', uuid }` → `{ base64, type }` | `{ error }`; `artifactsFromList(reply).artifacts[i].public: boolean`.

- [ ] **Step 1: failing tests** (panel, real content.js in vm; extend the harness routes as needed):
  - `listArtifacts maps audience to public and never returns it` — frame `{ audience: 'public' }` → `public: true`; `'owner'`/missing → `false`; reply JSON has no `audience`, no `thumbImgURL`, no `_thumb`.
  - `artifactThumb fetches the listed picture without credentials` — after `listArtifacts` with a valid `thumbImgURL`, `artifactThumb` → `{ base64, type: 'image/png' }` for PNG bytes; the request URL equals the listed one, `credentials: 'omit'`, `redirect: 'error'`; JPEG and WebP magic too.
  - `artifactThumb rejects what isn't a picture` — SVG bytes, HTML bytes, PNG magic with content type `text/html`, PNG magic with `image/svg+xml` → `{ error: 'bad response' }`; PNG magic with `application/octet-stream` → accepted; 2 MB + 1 byte → `{ error: 'too large' }`.
  - `artifactThumb re-lists once on 403` — first picture fetch 403, re-list gives a new URL, retry 200 → picture; a second 403 → `{ error: 'HTTP 403', status: 403 }`, and only one re-list per export session.
  - `artifactThumb refuses a URL that isn't exactly claude.ai's picture path` — other host, other uuid's host, `http:`, a port, userinfo, a hash, path `/_f/V/x.png`, two params, param not `__frame_t` → `{ error: 'no picture' }` and no fetch; also an unknown uuid and no prior `listArtifacts`; an uppercase uuid in the request matches.
  - Update the existing `tests/panel.test.js` listArtifacts test (~line 479, exact `res.frames` compare) for `public: false`.
  - `artifactThumb answers codes only` — 401 → `{ error: 'HTTP 401', status: 401 }`, throw → `{ error: 'network' }`; no reply contains the URL or token.
  - (export.test) `artifactsFromList keeps public as a boolean`.
- [ ] **Step 2: run** `node --test tests/panel.test.js tests/export.test.js` — new tests FAIL.
- [ ] **Step 3: implement.** Keep the uuid → URL map private in content.js, filled (replaced) on each `listArtifacts`; update its comment ("the thumbnail URL stays here").
- [ ] **Step 4: run** the two files, then `sh tests/run.sh` — PASS.
- [ ] **Step 5: commit** `Card pictures for artifacts, fetched inside content.js`.

### Task 2: The export records viewer data, pictures and parts

**Files:** Modify `popup.js` (`fetchPublishedFiles` also returns texts/images, `saveArtifact`, `unexpectedArtifactRow`, the `exportArtifacts` loop, `artifactsIndexHtml`, `artifactsIndexMd`), `takeout-viewer.js` (`artifactViewParts`); Test `tests/export.test.js`, `tests/helpers.js` (`runArtifacts`: mock gains `artifactThumb`, accepts `routes`, returns `raw` (path → Buffer) beside the string map; `assetRoutes` moves here from export.test.js ~line 429), `tests/e2e/artifacts.e2e.js` (its shared-row check ~lines 63-64 now expects no local link).

**Interfaces:**
- Consumes: Task 1's `artifactThumb`, `public`.
- Produces:
  - `fetchPublishedFiles(...)` result gains `texts: Map<path, string>` and `images: Map<path, { bytes: Uint8Array, type }>` (per the Global Constraints; chat exports ignore them).
  - `saveArtifact(root, a, ctx)` result gains `view: ArtifactView` (without `part`/`key`) and `payload: { texts, images } | null`.
  - `CTViewer.artifactViewParts({ partLimit })` → `{ add(view, payload) → view (with part/key set), flush() → [{ name, body }], count }` in takeout-viewer.js: accumulates payloads, emits a part whenever the next would exceed `partLimit`; part numbering from 1.
  - The export loop: `views[]` (in list order). The picture step and the parts step each run in their own try/catch after `saveArtifact` returns, so a throw there never marks the artifact not exported or warns; a picture/part failure just leaves `thumb`/`part` null. Each artifact's finished parts are written with `root.file('viewer-files/' + name, body)` before that artifact's `root.flush()`; `artifactViewParts.flush()` runs after the loop. Thumbnails at `viewer-files/thumbs/<shortId>.<ext>`. Order after the loop: remaining parts, then `writeArtifactsViewer` (Task 4a; until then a no-op), then the index files and manifest, then the final flush or `generateAsync`.
  - `artifactsIndexMd/Html(rows, { ..., thumbs })` print "Card pictures: N of M"; `index.html` links `viewer.html`.

- [ ] **Step 1: failing tests** (export.test via `runArtifacts`, ZIP and folder):
  - `each artifact gets a view record` — fields per `ArtifactView`; `kind` from `typeTitle || 'Page'`; `docs` for the Docs slug; `typed` when typeSlug set; `notExported` for a failed artifact; `startKind` from the start file name.
  - `preview texts and images go to parts, flushed per artifact` — a 3-file page (index.html, app.css, img/a.png) → its part holds texts for html/css and a `data:image/png;base64,` for the png; a 3 MB png and a `.bin` left out; in folder mode each part is written before that artifact's flush.
  - `a start file over 2 MB gets no text` — `startSize` set, part has no text for it.
  - `card pictures are saved outside artifact folders` — PNG reply → `viewer-files/thumbs/<shortId>.png`, `artifact.json` `thumb` = that path, view `thumb` same; error reply → no file, no `thumb`, no warning, export complete; a 401 from `artifactThumb` doesn't stop later artifacts.
  - `index and manifest count card pictures` — "Card pictures: 1 of 3" in index.md and index.html; manifest `thumbs: 1`.
  - `artifact.json gains start and public, nothing else changes` — existing fields equal v1.15 for the fixture.
  - `index.html drops a shared artifact's local HTML link and links the viewer`.
  - `no picture URL or token reaches any file` — the mocked `artifactThumb` reply carries extra fields (`url: 'https://x.frame.claudeusercontent.com/_f/V/_thumb.img?__frame_t=TOKEN9'`, `token: 'TOKEN9'`); scan every written file name and body (parts included) for `claudeusercontent`, `__frame_t`, `_thumb.img`, `TOKEN9`. Narrow the existing "nothing private or token-shaped reaches a file" test (~line 2559) from `thumb` to `_thumb.img` so the new `thumbs/` folder and `thumb` field pass.
  - `an artifact that throws unexpectedly still gets a view` (`notExported: true`), and `a throwing parts step leaves the artifact exported` (make `artifactViewParts.add` throw: no warning, `part: null`).
  - `large exports stay bounded` — 1000 listed frames → views for all, and a 30 MB start file → `tooLarge: true`, no text; a 30 MB `app.js` left out of the payload; with a small parts budget, later artifacts get `part: null`.
  - `index.md drops a shared artifact's local HTML link` too.
  - `artifactViewParts splits at the part limit` (unit, small `partLimit`).
- [ ] **Step 2: run** `node --test tests/export.test.js` — FAIL.
- [ ] **Step 3: implement.** Picture fetch: after the files step, for every listed artifact (Docs and typed included) call `artifactThumb`; it runs even when the files step failed, but not after `state.publishedSignedOut`.
- [ ] **Step 4: run** the file, then `sh tests/run.sh` (refresh `tests/fixtures/export-baseline.json` per tests/README.md if it covers this) — PASS.
- [ ] **Step 5: commit** `Export Artifacts records viewer data, card pictures and preview parts`.

### Task 3: Viewer logic — path resolver and artifact helpers

**Files:** Modify `viewer/viewer-logic.js`; Test `tests/viewer.test.js`.

**Interfaces:**
- Produces (pure functions in viewer-logic.js):
  - `resolveArtifactPath(startPath, url) → string | null` (Global Constraints rule; strips `./`; percent-decoding of each segment with `safeDecode`).
  - `inlineArtifact(html, startPath, payload) → string`: like `inlineSiblings` but resolving through `resolveArtifactPath` against `payload.texts` (scripts `.js/.mjs`, stylesheets `.css`), and replacing `<img src>` (and `srcset` first candidate) with `payload.images[path]` when present.
  - `artifactPreviewDoc(text, startPath, payload) → { srcdoc, remote }`: `PREVIEW_CSP` meta first, then `STORAGE_SHIM` (a `<script>` defining in-memory `localStorage`/`sessionStorage` on `window` when access throws), then `inlineArtifact(...)`.
  - `artifactTabs(views, tab, query) → views` (filter + sort per Global Constraints) and `relativeTime(iso, now) → string` ("just now", "5m ago", "3h ago", "2d ago", then a date).
  - `parseArtifactHash(hash) → id | null`.

- [ ] **Step 1: failing tests:**
  - `resolveArtifactPath` — (`site/index.html`, `./app.css`) → `site/app.css`; (`site/index.html`, `../x.js`) → `x.js`; (`index.html`, `../x.js`) → null; `https://a/b.js`, `//a/b.js`, `a.css?x`, `a.css#y`, `data:...` → null; `img/%61.png` → `img/a.png`.
  - `inlineArtifact` — nested CSS and JS inlined from `payload.texts`; `<img src="img/a.png">` → data URI; an unknown path left as is; a `</script>` in inlined code escaped (same as `inlineSiblings`).
  - `artifactPreviewDoc` — CSP meta is the first element after the doctype, the shim precedes the artifact's first script.
  - `artifactTabs` — Yours/Shared membership incl. empty rel, title search case-insensitive, sort with an unparsable date last and title ties.
  - `relativeTime` — the boundaries above with a fixed `now`.
  - `parseArtifactHash` — `#a=LkJG…` → id; `#chat=…`, `#a=`, `#a=<script>` → null.
- [ ] **Step 2: run** `node --test tests/viewer.test.js` — FAIL.
- [ ] **Step 3: implement.**
- [ ] **Step 4: run** it, then `sh tests/run.sh` — PASS.
- [ ] **Step 5: commit** `Viewer logic for artifacts: path resolver, inlining, tabs`.

### Task 4a: Building viewer.html in the export

**Files:** Create `viewer/artifacts-template.html` (the chat viewer's CSP with `frame-src 'none'`, `<meta name="generator" content="Claude Takeout">`, light/dark theme tokens, the `/*DATA_JSON*/`, `/*MARKED_JS*/`, `/*LOGIC_JS*/`, `/*APP_JS*/` placeholders), `viewer/artifacts-app.js` (skeleton: reads the data, shows the heading and the count); Modify `takeout-viewer.js` (`ARTIFACTS_VIEWER_ASSETS`), `popup.js` (`writeArtifactsViewer(root, views, { exported, listed, fileScripts })` in the post-loop order from Task 2; failure → status adds "viewer.html could not be built."; `viewer.html`, `viewer-check.gif`, `viewer-files` added to `ARTIFACT_ROOT_NAMES`); Test `tests/export.test.js`, `tests/viewer.test.js` (assets list).

**Interfaces:**
- Consumes: Task 2's `views` and parts.
- Produces: `viewer.html` (data `{ exported, listed, artifacts: ArtifactView[] }`) + `viewer-check.gif` at the root; `ARTIFACTS_VIEWER_ASSETS` = `viewer/artifacts-template.html`, `viewer/viewer-logic.js`, `viewer/artifacts-app.js`, `viewer/marked.min.js`. `index.html` links `viewer.html` only when it was built.

- [ ] **Step 1: failing tests:** `Export Artifacts writes viewer.html and viewer-check.gif` (ZIP and folder; viewer.html has the generator meta, `frame-src 'none'`, the data); `a viewer build failure leaves the export complete` (throwing asset fetch: status line says so, index.html has no viewer link); `viewer.html holds no artifact texts` (a fixture text marker is only in parts); `viewer.html stays small for 1000 artifacts` (under 1.5 MB); `ARTIFACTS_VIEWER_ASSETS` list.
- [ ] **Step 2: run** `node --test tests/export.test.js tests/viewer.test.js` — FAIL.
- [ ] **Step 3: implement.**
- [ ] **Step 4: run** them and `sh tests/run.sh` — PASS.
- [ ] **Step 5: commit** `Export Artifacts builds viewer.html`.

### Task 4b: The grid

**Files:** Modify `viewer/artifacts-app.js`, `viewer/artifacts-template.html` (styles); Test new `tests/e2e/artifacts-viewer.e2e.js` (fixture from `runArtifacts` with `routes` and `raw`, hostile titles from `tests/e2e/hostile.js`, written byte-exact to a temp folder).

**Interfaces:**
- Consumes: Task 3's `artifactTabs`, `relativeTime`.
- Produces: the home grid per spec: heading, tabs (`role=tablist`, arrow keys), search (`/` focuses), cards as buttons (picture `loading="lazy"`, tile fallback on load error, kind label, relative time with absolute `title`, globe when `public`), empty states "Nothing shared with you" / "No artifacts match". All text via `textContent`/`escHtml`.

- [ ] **Step 1: failing e2e:** cards sorted; tabs and search filter; empty states; keyboard (Tab/Enter, arrows, `/`); a hostile title shows as text; a saved picture shows (natural width > 0) and a broken one falls back to the tile; zero requests outside `file:`; no page errors.
- [ ] **Step 2: run** `PW=… CHROME_EXE=… node tests/e2e/artifacts-viewer.e2e.js` — FAIL.
- [ ] **Step 3: implement.**
- [ ] **Step 4: run** it and `sh tests/run.sh` — PASS.
- [ ] **Step 5: commit** `Artifacts viewer: a claude.ai-style grid`.

### Task 4c: Artifact pages and routing

**Files:** Modify `viewer/artifacts-app.js`; Test `tests/e2e/artifacts-viewer.e2e.js`.

**Interfaces:**
- Consumes: Task 3's `parseArtifactHash`; `openableHref`.
- Produces: the artifact page's top bar (home, title, kind, Open on claude.ai with `rel="noopener noreferrer"`, Open file per the rule, badges "needs claude.ai to run" / "not checked against claude.ai's checksum"); Docs page; Design/typed poster (picture large, note, file list, "Show saved files anyway" — calls Task 5's preview, a stub until then); details page for not exported / no start file / other kinds / too large ("too large to show here"); `#a=<id>` routing (unknown → home), home button; `viewer-check.gif` probe (fails → tiles, and opening an artifact says "Unzip the export first, then open viewer.html again.").

- [ ] **Step 1: failing e2e:** Docs page note; Design poster; not-exported, no-start-file and too-large details pages; the shared artifact has no Open file, an own one has it; deep link `#a=` and unknown hash → home; home button returns; a run with `viewer-check.gif` deleted shows tiles and the unzip message; no page errors.
- [ ] **Step 2: run** the e2e — FAIL.
- [ ] **Step 3: implement.**
- [ ] **Step 4: run** it, `tests/e2e/artifacts.e2e.js`, `sh tests/run.sh` — PASS.
- [ ] **Step 5: commit** `Artifacts viewer: artifact pages and routing`.

### Task 5: The artifact preview

**Files:** Modify `viewer/artifacts-app.js`; Test `tests/e2e/artifacts-viewer.e2e.js`.

**Interfaces:**
- Consumes: Task 3's `artifactPreviewDoc`, Task 2's parts (load the artifact's part with the chat viewer's `__archivePart` script-loading approach when it opens; failure → "The artifact couldn't load, because viewer-files/ is missing or blocked.").
- Produces: the full-page preview per start kind: html/svg → sandboxed iframe per Global Constraints (white, `color-scheme: normal`), with `REMOTE_NOTE` in the top bar when `remote`; md → the chat viewer's renderer (move its raw-HTML-escaping `Marked` setup from viewer-app.js ~lines 67-84 into a shared factory in viewer-logic.js, used by both pages, keeping escaped raw HTML, placeholders and `sanitizeHtml`); image → `<img>` from the part's data URI (or the relative saved path for the owner's own files); react/mermaid → code with `OFFLINE_NOTE`; "Show saved files anyway" on the poster opens this preview.

- [ ] **Step 1: failing e2e tests:**
  - `a page with nested CSS, JS and an image renders them` (start `site/index.html`: computed style from `./app.css`, a DOM change from a script, `img/a.png` natural width > 0, a file saved as `_2` loads by its original path); `../../escape.js` doesn't run.
  - `a hostile artifact can't reach out` — it tries `fetch`, `new Image().src`, `top.location`, `parent.document.title`, `window.open`, a form submit to `https://example.com`, `location.href = 'https://example.com'`, `location.href = '<its own folder>/index.html'`, `<meta http-equiv=refresh>`, an `<a href>` click → zero non-`file:` requests across all frames, no frame ever has a `file:` URL, the viewer's title and URL unchanged, no viewer page errors. (hostile.js's storage case: with the shim, `localStorage.setItem/getItem` works inside and nothing reaches the viewer's storage.)
  - `the preview frame is white with color-scheme normal in dark mode` (emulate `prefers-color-scheme: dark`).
  - `forms and alerts work` — a submit handler runs (`preventDefault`), and `alert('x')` fires a Playwright `dialog` event.
  - `markdown start file renders like the chat viewer` (raw `<b>x</b>` shows as text, a `<script>` doesn't run).
  - `Show saved files anyway` opens the Design artifact's preview.
  - `a missing part says so`.
- [ ] **Step 2: run** the e2e — new tests FAIL.
- [ ] **Step 3: implement.**
- [ ] **Step 4: run** it, `tests/e2e/viewer.e2e.js` (expect only its 3 known Chrome-only failures), `sh tests/run.sh` — PASS.
- [ ] **Step 5: commit** `Artifacts viewer: sandboxed previews with their own files`.

### Task 6: Docs, version, tools check, real export

**Files:** Modify `manifest.json` (1.16.0), `README.md` (v1.16.0 entry, layout), `USAGE.md` (the viewer; Open file rule and why; sandbox limits incl. storage shim, no runtime fetches, no Design runtime, links between an artifact's pages, CSS `url()`/`@import`, module imports), `TECHNICAL.md` (Artifacts viewer section; the picture endpoint), `CLAUDE.md` (§2 file map incl. the two new viewer files and the e2e, §3 table, §7 layout incl. `viewer-files/thumbs/`, §8 picture endpoint, §5.3/§11 if touched), `tests/README.md`; Test `tests/archive.test.js`.

- [ ] **Step 1: failing test** `an Export Artifacts folder with a viewer still holds no archive` (archive.test: build_viewer and merge find none; `isGeneratedViewer` matching the generator meta changes nothing).
- [ ] **Step 2: run** — FAIL or PASS; if PASS, note that it guards a regression and keep it.
- [ ] **Step 3: docs and version.**
- [ ] **Step 4: run** `sh tests/run.sh` (checks manifest vs changelog) and both artifacts e2e files — PASS.
- [ ] **Step 5: commit** `Artifacts viewer docs and version (v1.16.0)`.
- [ ] **Step 6 (owner):** reload the extension, Export Artifacts (folder), open `viewer.html`: the grid looks like claude.ai/artifacts; card pictures present (if all are tiles, report it — the picture fetch failed and needs a look); open a page, a Cowork page, a Docs page, a Design poster and the shared one; check the shared one has no Open file. Then `grep -rl "claudeusercontent\|__frame_t\|_thumb.img" <export>` may match artifact files and `viewer-files/part-*.js` (they hold artifact source text verbatim) but never `viewer.html`, any `artifact.json`, `viewer-files/thumbs/`, `index.*` or `export-manifest.json`.
