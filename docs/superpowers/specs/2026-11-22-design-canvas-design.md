# Fewer "needs claude.ai to run" pages: the frame preamble, and a Design canvas view (v1.20.0)

Date: 2026-11-22. Status: for the owner's approval (builder check done; findings settled, marked *my call*).

## Intent

The spike of 2026-11-22 (no code) found that two kinds of artifact the viewer labels "needs claude.ai to run" mostly work offline:

1. **Pages served with claude.ai's frame preamble.** A copy fetched from `/_f/<ver>/` (a public page shared with you) starts with `<!-- frame-runtime -->` and two scripts claude.ai adds: `window.__FRAME_PREAMBLE={...}` (about 1 KB) and its runtime (about 42 KB, `claude.hot`: version hot-reload and messages to the parent frame). The runtime's text contains `/_f/`, so `publishedNeedsRuntime` marks the page. The page itself ("Alert Flow Before and After") rendered fully offline with the network blocked.
2. **Design artifacts.** Their content is `project/*.dc.html` boards and `project/canvas.json` (each board's `x`, `y`, `w`, `h`, `title`; sticky notes; a title). `index.html` is the type's editor app (`artifact-type/app.js`, not saved). 9 of 11 real boards are static HTML and render offline as they are; 2 use the type's templates (`{{hole}}`, `<sc-for>`, `<sc-if>`, `<dc-import>`, a `DCLogic` class), which need the type's `support.js` and show their placeholders offline. Uploaded images (`/_blob/<id>`) are not in the export.

The owner agreed (2026-11-22): fix the label, and show a Design artifact's boards in the viewer from `canvas.json`, without claude.ai's code. Not pulling claude.ai's bundles (token-bound, about 10 MB, someone else's code).

## Goals

### 1. The preamble doesn't decide the label
- `publishedNeedsRuntime(text)` ignores claude.ai's frame preamble: when the text has `<!-- frame-runtime -->`, the `<script>` elements whose text starts with `window.__FRAME_PREAMBLE` and the one right after it are left out before the `artifact-type/` / `/_f/` test. The page's own code is still tested, so a page that itself loads `/_f/` or `artifact-type/` keeps the label. *My call* on the exact rule (the marker and both scripts, as observed).
- Saved files are unchanged (bytes as claude.ai served them; checksums hold). The preview runs them as now; the preamble's messages go to the sandbox's parent and are ignored.
- Applies to new exports. Older archives keep the label they were exported with; `build_viewer.js` reads `needsRuntime` from `artifact.json` as today. *My call* (recomputing from disk is possible but changes what the tools read).

### 2. A Design canvas view
- **Which artifacts:** typed Design artifacts (`typeTitle` "Design") whose current version holds `project/canvas.json` and at least one board file it names in `boards`. Others keep today's poster page.
- **Preview data:** the export keeps `project/canvas.json` in the artifact's preview payload. `.json` becomes a preview text kind (`previewKind`), within the existing per-file 2 MB and per-artifact 8 MB budgets, so JSON files of any artifact also gain Download (v1.19). *My call* (one rule instead of a Design special case).
- **The view (Artifacts screen, standalone and inside the chat viewer):** in place of the poster, a canvas:
  - every board at its `x`/`y` and `w`×`h`, scaled together to fit the page width (never above 100%), each in its own sandboxed preview frame built like an artifact's page today (`artifactPreviewDoc`, the same sandbox, the guard frame when hosted), with its `title` above it;
  - `notes` as plain boxes at their place (text only, via `textContent`; `fill` maps to a small fixed palette, unknown fills are grey); a note with `kind` `title1` as a heading; `noteOrder` sets their order;
  - a board that uses templates (`{{`, `<sc-`, `<dc-import`) carries a badge "Uses claude.ai's templates; shown as saved"; a board that refers to `/_blob/` carries "Images not in this export". Both still render. *My call* (show it, labelled, rather than a blank tile);
  - clicking a board's title opens it alone at 100% in the page body, with "Back to the canvas"; no new hash. *My call*;
  - at most 60 boards are drawn; more are listed by title with "open alone". *My call* (bounds frames per page).
- **Top bar and badges:** the page keeps Open on claude.ai, Open file, Download and Download ZIP. The "needs claude.ai to run" badge is replaced by "Design canvas" plus, when any board uses templates, "some boards need claude.ai". *My call*.
- `artifact.json` is unchanged: `needsRuntime` stays true for typed artifacts (it describes the saved `index.html`, which does need claude.ai).

### Old-archive tools
- `build_viewer.js` / `merge_archives.js` give a Design artifact the same canvas when its files are on disk: `payloadFromDisk` follows `previewKind`, so `canvas.json` is read with the rest. Archives exported before v1.20 get the canvas once rebuilt (their files are there).

### Settled at the builder check (*my calls*, from the two real Design artifacts)
- **`canvas.json` as observed** (`v: 3`). Only these keys are read; others (`createdOnFiles`, `launch`, `pages`, `order`, `attachments`, `designSystems`) are ignored:
  ```json
  {
    "v": 3,
    "title": "Panel mockups",
    "boards": { "Main.dc.html": { "x": 0, "y": 0, "w": 380, "h": 720, "title": "Home A" },
                "HomeB.dc.html": { "x": 460, "y": 0, "w": 380, "h": 720, "title": "Home B" } },
    "notes": { "t":  { "kind": "title1", "text": "Section heading", "x": 0, "y": -120, "maxW": 2420 },
               "n1": { "fill": "teal", "text": "A sticky note.", "x": 0, "y": 900, "w": 420 } },
    "noteOrder": ["t", "n1"]
  }
  ```
  `boards` is an object keyed by the board's file name relative to `project/`; a key with `/`, `\`, `..` or not ending in `.dc.html` is skipped. Coordinates may be negative or fractional: the canvas is shifted so the smallest `x`/`y` is 0. A board or note with a non-finite `x`, `y`, `w` or `h` (notes: `w` defaults to 320) is skipped; a skipped or missing board is listed by title under the canvas. Observed fills are `teal` and `orange`; the palette maps `teal`, `orange`, `yellow`, `green`, `blue`, `pink`, `purple`, `red`, else grey. A note's text is plain (`textContent`); a note with no `w` and `maxW` uses `maxW`. The canvas shows when `canvas.json` parses and at least one board's file is held; otherwise the poster page, as today.
- **Board documents.** Boards are self-contained HTML; their only outside references are `./support.js` (the type's, not saved: dropped as any missing sibling is) and a Google Fonts `<link>` (blocked offline, as for any preview). Each board's document is built with `artifactPreviewDoc(text, 'project/<name>', payload)`, so sibling CSS/JS held in the payload is inlined as for an artifact page.
- **Frames.** Each board is its own preview frame, hosted inside its own guard frame (`guardDoc`, unchanged), exactly as an artifact page's preview. Frames are created only when their board scrolls near the view (`IntersectionObserver`), and removed again when far away, so at most about a screenful runs at once; the 60-board cap still bounds the page.
- **Budgets.** In the payload, `project/canvas.json` is kept right after the start file, ahead of the boards, within the existing 2 MB per file and 8 MB per artifact. A board not held (over budget) is drawn as a tile with its title and "Not in the viewer's files" (plus Open file where allowed).
- **`.json` as a preview kind.** It only adds `.json` files to artifacts' preview payloads (Export Artifacts, Export All's artifact step, `payloadFromDisk`), which gives them Download. A JSON start file still gets the details page (no new start kind). Chat file previews and single-chat ZIPs are untouched, so `export-baseline.json` doesn't change.
- **Old archives.** A rebuilt older archive can show a Design canvas while a preamble-only page keeps its old label. Accepted: the label comes from `artifact.json`.
- **Open alone / Back.** "Open alone" shows the board in the page body (the same preview path); "Back to the canvas" re-renders the canvas and scrolls back to that board.

## Non-goals
- Running the Design type's templates or editor; fetching `support.js`, `artifact-type/` files or `/_blob/` images.
- Chat viewer published cards of a Design page (they keep today's card).
- Pan/zoom controls beyond fit-to-width; editing.
- Any other typed artifact (Slides, Dashboard): their formats aren't known from real exports yet.

## Anti-goals
- A board running outside the existing preview sandbox, or with more than an artifact page's preview gets (same CSP, same guard).
- claude.ai's code or any URL/token written into the export.
- A page without the preamble losing its label when it needs claude.ai.

## Constraints
- `manifest.json` 1.20.0; README changelog; USAGE (the artifacts viewer, the label); TECHNICAL (`publishedNeedsRuntime`, the canvas); CLAUDE.md where the file map or layout changes.
- Tests: unit for the preamble rule (preamble alone → no label; preamble plus the page's own `/_f/` → label; no marker → as today) and for `previewKind('x.json')`; viewer logic for the canvas layout (scale, positions, note palette, template/blob detection) as pure functions in `viewer-logic.js`; e2e on a synthetic Design artifact (boards in place, titles, notes, badges, open alone and back, no network, sandbox intact, hosted and standalone).
- Synthetic fixtures only; no real artifact content in the repo.

## Left to the builder
- The canvas's CSS and the exact scale math.
- How the board frames are sized inside the scaled canvas.
- Where the pure helpers' names fall.
