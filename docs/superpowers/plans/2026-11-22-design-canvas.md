# Preamble Label Fix and Design Canvas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop claude.ai's frame preamble from labelling a page "needs claude.ai to run", and show a Design artifact's boards offline as a canvas on the Artifacts screen.

**Architecture:** `publishedNeedsRuntime` (export-core.js) drops the preamble's two scripts before testing. `.json` becomes a preview text kind and `project/canvas.json` is kept right after the start file in an artifact's payload (popup.js `fetchPublishedFiles`, archive-lib.js `payloadFromDisk`). Pure layout helpers in `viewer-logic.js` turn `canvas.json` plus the held paths into boards and notes; `artifacts-app.js` draws them, each board in the existing preview frame (and guard frame when hosted), created lazily.

**Tech Stack:** Classic-script JS (extension + viewer), Node 20 `node --test`, playwright-core e2e.

**Spec:** `docs/superpowers/specs/2026-11-22-design-canvas-design.md`

## Global Constraints

- `manifest.json` `1.20.0`; README changelog `### v1.20.0`.
- Preamble rule: only when the text has `<!-- frame-runtime -->`; drop `<script>` elements whose text starts with `window.__FRAME_PREAMBLE` and the `<script>` element right after it; then test `/artifact-type\/|\/_f\//` as today.
- Saved files, `artifact.json` and `needsRuntime` for typed artifacts unchanged.
- Canvas only for `typeTitle` "Design" with `project/canvas.json` parsed and ≥1 board file held; else today's poster page.
- Board keys: relative to `project/`, must end `.dc.html`, no `/`, `\`, `..`. Non-finite `x`/`y`/`w`/`h` → skipped (listed). Note `w` default 320, `maxW` used when no `w`. Shift so min `x`/`y` is 0. Scale = min(1, available width / canvas width).
- Palette: `teal`, `orange`, `yellow`, `green`, `blue`, `pink`, `purple`, `red`; anything else grey.
- Board badges: templated (`{{`, `<sc-`, `<dc-import`) → "Uses claude.ai's templates; shown as saved"; `/_blob/` → "Images not in this export". Not held → tile "Not in the viewer's files".
- At most 60 boards drawn; the rest listed by title with "Open alone". Frames created by `IntersectionObserver` near view, removed when far.
- Page badges: "Design canvas", plus "some boards need claude.ai" when any board is templated (replacing "needs claude.ai to run").
- Board frames: same sandbox attributes, `artifactPreviewDoc(text, 'project/<name>', payload)`, `guardDoc` when hosted. Note text only via `textContent`.
- Synthetic fixtures only. Commit as bearspear, trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- A `canvas.json` that isn't JSON, or has `boards` as an array or with hostile keys (`../x.dc.html`, `__proto__`): no throw, poster page or the bad boards skipped → test in Task 2.
- A note whose text holds HTML (`<img src=x onerror=…>`): shown as text, nothing runs → e2e in Task 3.
- A board whose own script tries to reach the viewer, the network or `file:` (navigation): same refusals as an artifact page → e2e in Task 3 (hostile board).
- A Design artifact whose `canvas.json` is over budget or missing from the payload: today's poster page, no error → test in Task 2 and e2e in Task 3.
- A page whose own code (after the preamble) loads `/_f/…`: keeps the label → test in Task 1.

---

### Task 1: Export — preamble rule, `.json` previews, `canvas.json` early

**Files:**
- Modify: `export-core.js` (`publishedNeedsRuntime` ~1579, `previewKind` ~1589)
- Modify: `popup.js` (`fetchPublishedFiles` candidate order), `tools/archive-lib.js` (`payloadFromDisk` order)
- Test: `tests/export.test.js`, `tests/archive.test.js`

**Interfaces:**
- Produces: `publishedNeedsRuntime(text: string) -> boolean` (preamble-aware); `previewKind('x.json') === 'text'`; payload order: start file, then `project/canvas.json` when present, then the rest.

- [ ] **Step 1: Failing tests** in `tests/export.test.js`:
  - `publishedNeedsRuntime ignores claude.ai's frame preamble`: a synthetic page `<!doctype html><html><head><!-- frame-runtime --><script>window.__FRAME_PREAMBLE={"v":1}</script><script>(function(){fetch("/_f/"+v+"/x")})()</script></head><body><h1>Hi</h1></body></html>` → `false`; the same plus `<script src="/_f/abc/app.js"></script>` in the body → `true`; no marker but `/_f/` in a script → `true`; `artifact-type/app.js` without preamble → `true`.
  - `previewKind keeps .json`: `previewKind('project/canvas.json') === 'text'`, `previewKind('a.JSON') === 'text'`.
  - `Export Artifacts keeps canvas.json in a Design artifact's preview, after the start file`: Design artifact (`typeTitle: 'Design'`, typeSlug DESIGN_TYPE) with `index.html`, `project/canvas.json`, `project/Main.dc.html` → the view's payload texts list order `['index.html', 'project/canvas.json', 'project/Main.dc.html']`.
  - `a served copy with only the preamble is not labelled`: Export Artifacts of a page whose `index.html` is the preamble page above → `artifact.json.needsRuntime === false`.
- In `tests/archive.test.js`: `payloadFromDisk keeps canvas.json right after the start file` (via `artifactViewsFromDisk` on a standalone 1.18 export with those three files).
- [ ] **Step 2: Run** `node --test tests/export.test.js tests/archive.test.js` → the new tests FAIL.
- [ ] **Step 3: Implement** the rule, `json` in `previewKind`'s text list, and the order in both payload builders (start, `project/canvas.json`, rest).
- [ ] **Step 4: Run** the two files → PASS; `sh tests/run.sh` → `# fail 0` (update any pinned payload expectation that now includes `.json`, and say so in the commit).
- [ ] **Step 5: Commit** — "Export: the frame preamble doesn't decide the label; .json and canvas.json in artifact previews".

### Task 2: Canvas layout helpers (viewer-logic.js)

**Files:**
- Modify: `viewer/viewer-logic.js` (new helpers, exported)
- Test: `tests/viewer.test.js`

**Interfaces:**
- Produces:
  - `designCanvas(canvasText: string, held: (path: string) => boolean) -> null | { width, height, title, boards: [{ name, path, x, y, w, h, title, held }], notes: [{ id, text, x, y, w, fill, heading }], skipped: [{ name, title }] }` — `null` when the text isn't a JSON object with an object `boards`, or no board is held. `path` = `project/<name>`. Coordinates shifted so min is 0; `width`/`height` cover boards and notes (a note's height counts as 0 — notes size to their text; add 200 to height for them). At most 60 boards; the rest go to `skipped`. Notes in `noteOrder`, then any not listed, by key.
  - `boardFlags(text: string) -> { templated: boolean, blobs: boolean }`.
  - `noteFill(fill: unknown) -> string` — one of the palette names, else `'grey'`.
  - `DESIGN_BOARD_MAX = 60`.

- [ ] **Step 1: Failing tests** in `tests/viewer.test.js` (`designCanvas lays out boards and notes`, `designCanvas refuses bad input`, `boardFlags`, `noteFill`): the spec's sample `canvas.json` with `t.y = -120` → boards at y 120, notes `t` heading at y 0, `n1` fill `teal` w 420; `held` false for HomeB → its `held: false`; `boards` as an array, invalid JSON, `{}`, a key `../x.dc.html`, `a/b.dc.html`, `x.html`, `__proto__` → skipped or `null` as the Global Constraints say; a board with `x: NaN` → in `skipped`; 61 boards → 60 drawn, 1 skipped; `boardFlags('<p>{{a}}</p>')` templated, `'<sc-for>'` templated, `'<dc-import>'` templated, `'<img src="/_blob/1">'` blobs, plain HTML neither; `noteFill('teal') === 'teal'`, `noteFill('magenta') === 'grey'`, `noteFill(null) === 'grey'`.
- [ ] **Step 2: Run** `node --test tests/viewer.test.js` → FAIL.
- [ ] **Step 3: Implement** the helpers (own-property checks only; `Object.keys` on plain objects).
- [ ] **Step 4: Run** → PASS; `sh tests/run.sh` → `# fail 0`.
- [ ] **Step 5: Commit** — "Viewer logic: lay out a Design canvas from canvas.json".

### Task 3: The canvas page on the Artifacts screen

**Files:**
- Modify: `viewer/artifacts-app.js` (`fillBody`, `showPage` badges, new `canvasPage`), `viewer/artifacts.css`
- Create: `tests/e2e/design.e2e.js`

**Interfaces:**
- Consumes: `designCanvas`, `boardFlags`, `noteFill`, `DESIGN_BOARD_MAX` (Task 2); payload with `project/canvas.json` (Task 1).
- Produces: `fillBody(v)` for a Design view: loads the payload (`heldPayload`), and when `designCanvas` returns a layout, renders `canvasPage(v, layout, payload)`; else `posterPage(v)`. Board frames via `previewFrame({ title }, artifactPreviewDoc(text, path, payload).srcdoc)`. "Open alone" replaces the body with that board's frame at 100% and a "Back to the canvas" button that re-renders the canvas and scrolls the board into view.

- [ ] **Step 1: Write the e2e** `tests/e2e/design.e2e.js`: build a synthetic Export Artifacts export with `runArtifacts` (Design artifact: `index.html` loading `artifact-type/app.js`, `project/canvas.json` (3 boards, one templated `{{x}}`, one with `/_blob/1`, 2 notes, one with `<img src=x onerror=console.log('NOTE RAN')>`), the boards, a hostile board using `hostileHtml` from `tests/e2e/hostile.js`; a second Design artifact with no `canvas.json`), and an Export All (hosted) export of the same, as `combined.e2e.js` does with its Chrome flag. Checks: badges "Design canvas" and "some boards need claude.ai"; each board's frame at its scaled place with its title; note text shown, `NOTE RAN` never logged; template and image badges; hostile board's attacks end as on an artifact page (`ATTACK_ENDS`); "Open alone" then "Back to the canvas"; the artifact without `canvas.json` shows the poster page; frames off-screen not created until scrolled; no request outside `file:`, no page error.
- [ ] **Step 2: Run** `PW=… CHROME_EXE=… node tests/e2e/design.e2e.js` → FAIL (no canvas).
- [ ] **Step 3: Implement** `canvasPage`, the `fillBody` branch, the badges and the CSS.
- [ ] **Step 4: Run** design, combined, artifacts-viewer and download e2e → PASS; `sh tests/run.sh` → `# fail 0`.
- [ ] **Step 5: Commit** — "Artifacts screen: a Design artifact's boards on a canvas".

### Task 4: Docs and version

**Files:** `README.md` (changelog `### v1.20.0`), `USAGE.md` (artifacts viewer: Design canvas; the label), `TECHNICAL.md` (`publishedNeedsRuntime` preamble rule; the canvas helpers and page), `CLAUDE.md` (§2 file map: `tests/e2e/design.e2e.js`; viewer-logic helpers if listed), `tests/README.md` (the new e2e), `manifest.json` → `1.20.0`.

- [ ] **Step 1:** Write the docs.
- [ ] **Step 2: Run** `sh tests/run.sh` → `# fail 0`.
- [ ] **Step 3: Commit** — "Design canvas and preamble docs and version (v1.20.0)".
