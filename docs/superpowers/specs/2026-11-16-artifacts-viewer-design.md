# Artifacts viewer: design

Date: 2026-11-16. Status: approved by the owner (after one deep review; its findings are folded in).

## Intent

Export Artifacts (v1.15.0) writes one folder per artifact plus a plain `index.html` list. The owner wants the export to be browsed the way claude.ai/artifacts is, just as the chat exports' `viewer.html` mirrors claude.ai's chats: open one file offline, see a grid of cards that looks like claude.ai's Artifacts page, click a card and the artifact fills the page.

## Goals

### Home (the grid), like claude.ai/artifacts
- "Artifacts" heading. Tabs All / Yours / Shared with you: Yours = not shared, Shared = `isSharedArtifact(rel)` (an empty `rel` counts as Yours, as in popup.js). Tabs are a `role=tablist` with arrow keys.
- A search box filtering by title; `/` focuses it, as in the chat viewer.
- Cards newest first by `updatedAt`; unparsable dates last; ties by title.
- Each card: claude.ai's card picture (or a tile), the title, a relative time ("19m ago" style, counted from when the viewer is opened, as claude.ai does; an absolute date in its `title`), a globe on a public artifact, and a small kind label (`typeTitle || 'Page'`, as index.md does).
- Cards are links or buttons (Tab and Enter). Pictures use `loading="lazy"`; a picture that fails to load falls back to the tile.
- No "Make something new" row.
- Empty states: a tab with nothing ("Nothing shared with you"), a search with no matches.

### Card pictures (owner decision: save claude.ai's own)
- Observed 2026-11-16: 16 of 19 artifacts list `thumbImgURL` = `https://<uuid>.frame.claudeusercontent.com/_f/<ver>/_thumb.img?__frame_t=<token>`. The token is claude.ai's; the `<ver>` is not always the current version (8 of 16 differ). Docs have pictures (6 of 6); the shared one and 2 Design artifacts have none.
- Fetched only in `content.js`: `listArtifacts` keeps a private map uuid → `thumbImgURL` (never returned). It is validated exactly: https, host `<uuid>.frame.claudeusercontent.com` for that uuid, path `/_f/<ver matching PUBLISHED_VER>/_thumb.img`, exactly one query parameter `__frame_t`.
- A new action `artifactThumb { uuid }` fetches it with `credentials: 'omit'`, no referrer, `redirect: 'error'`, a 2 MB streaming cap, checks the leading bytes are PNG, JPEG or WebP (SVG and everything else rejected), and returns base64 plus the type, or a code. It never returns the URL or token. If it answers 403, it may retry once after a fresh `listArtifacts`-style refresh only if that is cheap; otherwise it gives up.
- Unverified: whether `_thumb.img` answers a content-script fetch (CORS). The owner's first real export decides. On any failure: the tile. Never move this fetch into the popup.
- The picture step is separate from saving the artifact's files and never fails them. A 401 here doesn't set the export's signed-out state. No warning; `index.md`, `index.html` and `export-manifest.json` say "Card pictures: N of M".
- Saved outside artifact folders, at `viewer-files/thumbs/<shortId>.<png|jpg|webp>`, so artifact folders stay exactly claude.ai's files. `artifact.json` records `thumb` as that root-relative path, or omits it.
- The `listArtifacts` comment ("no owner, thumbnail or URL") is updated: the thumbnail URL stays inside content.js.

### Artifact page (after a click)
- The artifact fills the page below a thin top bar: home button (back to the grid), title, kind, "Open on claude.ai" (`https://claude.ai/artifact/<shortId>`), and where it applies "Open file", "needs claude.ai to run", "not checked against claude.ai's checksum".
- The URL hash holds the open artifact (`#a=<shortId>`); tab and search are not in the hash. An unknown or stale hash goes home. The home button is the reliable way back (an artifact may push its own history entries).
- What fills the page depends on the start file's kind (`publishedStart`: index.html, else the first .html, else the first file), as the chat viewer's `fileViews` does:
  - HTML and SVG: the sandboxed preview (below).
  - Markdown: rendered through the chat viewer's renderer and `sanitizeHtml`.
  - Images: shown by relative path.
  - React or Mermaid source: the code with the offline note.
  - Anything else, no files, or no start file: a details page (file list, notes, links).
  - A start file over 2 MB (`TEXT_EMBED_LIMIT`): "too large to show here" plus details.
- **Docs:** a page with the existing note (export the chat that made it), the card picture large, and the claude.ai link.
- **Design and typed artifacts** (owner decision: poster): open on a poster page by default: claude.ai's picture large, "needs claude.ai to run", the file list, "Open on claude.ai", and a "Show saved files anyway" button that opens the sandboxed preview.
- **Not exported (error):** a details page pointing to `errors.txt` and claude.ai.

### Preview sandbox
- Same model as the chat viewer: a `srcdoc` iframe built by `previewDoc` (with `PREVIEW_CSP` first), no `allow-same-origin`, `allow-popups` or `allow-top-navigation`. For this viewer the sandbox is `allow-scripts allow-forms allow-modals` (forms can't navigate: `PREVIEW_CSP` has `form-action 'none'`). If this changes the shared `previewFrame`, run `tests/e2e/viewer.e2e.js`.
- A small in-memory `localStorage`/`sessionStorage` stand-in is injected ahead of the artifact's code, so pages that touch storage at start-up still run.
- The frame gets a white background and `color-scheme: normal`, so pages without a background look as on claude.ai, in dark mode too.
- **Multi-file artifacts:** the artifact's own text files are looked up by their original `path` (not the saved name, which may be `_2`), resolving each relative URL against the start file's folder, with no scheme, `?`, `#`, or `..` past the artifact root. Scripts and stylesheets are inlined (as `inlineSiblings` does); the artifact's own images are embedded as `data:` URIs (owner decision), each up to a size cap (builder's call, e.g. 2 MB, total per page capped). Data files a page fetches at runtime and claude.ai's Design runtime (never saved) don't load.
- The texts and images for this live in `viewer-files/` parts and load only when that artifact is opened (as the chat viewer's parts do); `viewer.html` holds metadata and small texts only.

### "Open file" (owner decision: own artifacts only)
- Offered for the owner's own artifacts (`rel` not shared) and for openable non-HTML types (`openableHref`'s allowlist). Never for a shared artifact's HTML or SVG: opening it from disk would run someone else's code unsandboxed, with network access and the shared `file://` storage.
- `index.html` (the existing plain list) also drops the local link for a shared artifact's HTML start file, keeping the claude.ai link. USAGE.md explains why.

### Not-unzipped ZIP
- Detected with `viewer-check.gif`, as the chat viewer does; the grid still renders from inline data, pictures fall back to tiles, and opening an artifact says to unzip first (the chat viewer's `partFailed` wording).

### Data
- The export records what the viewer needs per artifact as each one finishes (so folder mode keeps its per-artifact flush and memory bound): uuid, shortId, title, typeTitle, whether a type is set, `shared` and `public` booleans, created and updated dates, folder, start path and saved name, files `[{ path, savedAs, kind, verified }]`, needsRuntime, note, thumb, plus the text of html, css, js, mjs, svg, md files and the bytes of images (into parts).
- `fetchPublishedFiles` additionally returns those texts and image bytes for the export to hand on; chat exports ignore them.
- `artifact.json` gains `start`, `thumb` and `public`; nothing existing changes meaning (`format` stays 1).
- **Privacy:** `audience` is never stored raw: `listArtifacts` maps it to `public: audience === 'public'`.

### Placement
- `viewer.html`, `viewer-check.gif` and `viewer-files/` go at the root of every Export Artifacts export, folder and ZIP, beside `index.html`, `index.md`, `export-manifest.json`. `index.html` links to `viewer.html`.
- Built by a new `writeArtifactsViewer` that reuses `VIEWER_ASSETS`, `assembleViewer` (with `fileScripts` when there are parts) and `VIEWER_CHECK_*`, works with `createDiskFolder`, and never fails the export (failure: status line "viewer.html could not be built").
- Viewer code must not contain the strings `claudeusercontent`, `__frame_t` or `_thumb`, so the "no frame URL in any file" scans stay meaningful.
- Only Export Artifacts gets this viewer. Chat exports are unchanged; the old-archive and merge tools still ignore `kind: "artifacts"` (test that a Takeout `viewer.html` there doesn't change that).

## Non-goals
- No chats in this viewer.
- No live miniature previews on the cards.
- No Docs text.
- No artifact version history.
- No sort or filter menus beyond the tabs and title search.

## Anti-goals
- An artifact's code reaching the viewer, other artifacts, or files on disk.
- Any network request from the viewer or a preview.
- The picture URL, asset token or any frame URL in any written file.
- A grid that looks generic rather than like claude.ai's Artifacts page.

## Decided by the owner
- Layout like claude.ai/artifacts.
- Save claude.ai's own card pictures, tile fallback.
- Design and typed artifacts open on a poster page with "Show saved files anyway".
- "Open file" for HTML only on the owner's own artifacts; shared ones lose their local HTML link in `index.html` too.
- A page's own images are embedded, with a size cap.

## Left to the builder (my calls marked)
- **My call:** the kind label on cards.
- **My call:** `viewer.html` is added next to `index.html`, which stays.
- Tile colours and icons, top-bar wording and layout, relative time format, size caps within the rules above, page template structure (separate template or a mode of the existing one).
- Tests:
  - Unit: `artifactThumb` (good, bad magic, SVG, oversize, 401/403, invalid URL rejected, never returned); the path resolver (nested, renamed, `..`); the audience → public mapping; the viewer data; every written file (viewer.html and parts included) scanned for `claudeusercontent`, `__frame_t`, `_thumb.img` and the mock token; index.html without the shared HTML link; refresh `export-baseline.json` if affected.
  - e2e (new `tests/e2e/artifacts-viewer.e2e.js`, using `tests/e2e/hostile.js`): grid renders, tabs and search filter, keyboard; a click opens the sandboxed artifact; a hostile artifact (fetch, `top.location`, `parent.document`, localStorage, form submit) can't escape; nested CSS and an image load; Docs, Design poster and no-start-file pages; not-unzipped run with tiles; zero requests outside `file:` across all frames; no page errors.
- Docs: README changelog and layout, USAGE (viewer, Open file rule, sandbox limits), TECHNICAL, CLAUDE.md (§2 file map, §7 layout, §8 picture endpoint); manifest bump to 1.16.0.
