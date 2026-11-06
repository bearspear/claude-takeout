# Offline Chat Viewer (v1.6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every Claude Takeout ZIP gets a `viewer.html` at its root: a read-only, offline copy of claude.ai for the exported chats.

**Architecture:** `takeout-viewer.js` runs in the extension and turns conversation JSON plus export bookkeeping into a compact data object, which it embeds with the viewer's code and vendored libraries into one HTML file. Inside that page, `viewer/viewer-logic.js` holds pure, Node-testable functions and `viewer/viewer-app.js` drives the DOM. Text is embedded in the page; binaries stay as relative links. Generated HTML runs only in a sandboxed `srcdoc` iframe.

**Tech Stack:** Vanilla JS (classic scripts, no build step), vendored `marked` and KaTeX, JSZip, Node's test runner, optional Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-11-05-offline-viewer-design.md`. Mockup: `docs/superpowers/specs/2026-11-05-offline-viewer-mockup.html`. Reference code: `/Users/mbehringer/Downloads/notebooklm-exporter` (`takeout-viewer.js`, `viewer/`).

## Global Constraints

- Offline from `file://`: no fonts, scripts, images or requests from the internet, and no `fetch` of local files.
- Read-only: no composer, editing, retry or sending.
- Sidebar reads "Claude Takeout" and shows read-only. No Anthropic logo or wordmark. No claude.ai code, fonts or images; CSS is hand-written with system fonts.
- Network in previews is always blocked, with no button to allow it.
- The viewer adds `viewer.html` and `viewer-check.gif`. Every other export file stays byte-for-byte what it would have been.
- Nothing `_`-prefixed in the repo. Tests use synthetic data only. Never commit real chats.
- `sh tests/run.sh` passes after every task. `node --check` on each edited `.js`.
- Commit as `bearspear`. Each task's commit needs the owner's OK. Don't push without it.
- Build on branch `feat/offline-viewer`, from `main` once the design docs are merged, or from `docs/offline-viewer-design` if they aren't yet.

## Review Focus

1. A chat with a broken tree (`current_leaf_message_uuid` null or unknown, a parent missing, a parent cycle, no messages): shows what can be reached and never hangs. Test in Task 1.
2. File and folder names with `#`, `?`, `%`, `[ ]`, spaces, accents, or `../`: links land on the right file and can't leave the export. Test in Task 2.
3. Chat text or artifacts containing `</script>`, `<!--`, `$&` or a template placeholder such as `/*APP_JS*/`: page stays intact and shows that text literally. Test in Task 2.
4. Viewer build failing partway (missing asset, odd message shape): the ZIP still downloads complete, and the user is told. Test in Task 9.
5. Switching chats while a long chat is still rendering: the old chat's messages never land in the new chat. Test in Task 3 e2e.

---

## File Map

| File | Role |
|---|---|
| `takeout-viewer.js` (new) | Extension side. Exposes `globalThis.CTViewer`, and `module.exports`. Builds data, assembles HTML. |
| `viewer/viewer-template.html` (new) | Page shell and all CSS. |
| `viewer/viewer-logic.js` (new) | Pure page logic. Top-level functions, plus `module.exports` under Node. |
| `viewer/viewer-app.js` (new) | DOM code. No exports; `viewer-logic.js` runs before it in the page. |
| `viewer/marked.min.js`, `katex.min.js`, `katex-inline.css`, `THIRD-PARTY-NOTICES.txt` (new) | Copied unchanged from NotebookLM's `viewer/`. |
| `popup.js`, `popup.html`, `sidepanel.html` | Export integration. |
| `tests/viewer.test.js` (new) | Unit tests for logic and builder. |
| `tests/e2e/viewer.e2e.js`, `tests/e2e/make-viewer.js` (new) | Chromium checks, and a page builder for review. |

## Data Contract

Every task uses this shape, written by `buildViewerChat` and read by the page.

```text
ViewerData = { exported: ISO string, chats: Chat[] }
Chat = { id, title, model, created, updated, leaf, messages: Msg[],
         files: { [fileId]: GenFile }, project: Project | null }
Msg  = { id, parent, sender: 'human'|'assistant', at, blocks: Block[],
         uploads: Upload[], attachments: [{ name, text }] }
Block = { t:'text', text, cites:[{ end, url, title }] }
      | { t:'thinking', text, summary }
      | { t:'tool', name, label, input, result, error: bool, images: [dataUri] }
      | { t:'card', file: fileId, version: index }
Upload  = { name, href: string|null, text: string|null }   // href null: not in this export
GenFile = { name, kind, versions:[{ label, text: string|null, href: string|null }] }
          // kind: 'html'|'svg'|'md'|'code'|'image'|'pdf'|'react'|'mermaid'|'binary'|'missing'
Project = { name, files:[{ name, href }], docs:[{ name, text }] }
```

All `href` values are relative to `viewer.html` and URL-encoded.

---

### Task 1: Page logic: message tree and hash state

**Files:**
- Create: `viewer/viewer-logic.js`, `tests/viewer.test.js`

**Interfaces:**
- Produces, as top-level functions, also in `module.exports`:
  - `chainFrom(messages, leafId) -> Msg[]` root to leaf
  - `siblingsOf(messages, id) -> { ids: string[], index: number }`
  - `leafUnder(messages, id) -> string`
  - `switchBranch(messages, id, delta) -> string|null` new leaf
  - `parseHash(hash) -> { chat, leaf, file, version }`, with missing values `null`
  - `formatHash(state) -> string`

- [ ] **Step 1: Write failing tests** in `tests/viewer.test.js`, using a synthetic tree `r -> a1, r -> a2, a2 -> h3, h3 -> a4`.

```js
assert.deepStrictEqual(chainFrom(msgs, 'a4').map(m => m.id), ['r', 'a2', 'h3', 'a4']);
assert.deepStrictEqual(siblingsOf(msgs, 'a2'), { ids: ['a1', 'a2'], index: 1 });
assert.strictEqual(leafUnder(msgs, 'a2'), 'a4');
assert.strictEqual(switchBranch(msgs, 'a2', -1), 'a1');
assert.strictEqual(switchBranch(msgs, 'a2', 1), null);
// Review Focus 1
assert.deepStrictEqual(chainFrom([], null), []);
assert.deepStrictEqual(chainFrom(msgs, 'nope').map(m => m.id), ['r', 'a2', 'h3', 'a4']); // newest message
assert.deepStrictEqual(chainFrom([{ id: 'x', parent: 'y' }, { id: 'y', parent: 'x' }], 'x').length, 2); // cycle ends
assert.deepStrictEqual(chainFrom([{ id: 'z', parent: 'gone' }], 'z').map(m => m.id), ['z']);
// Hash
assert.deepStrictEqual(parseHash(formatHash({ chat: 'c 1', leaf: 'm', file: null, version: 2 })), { chat: 'c 1', leaf: 'm', file: null, version: 2 });
assert.deepStrictEqual(parseHash('#junk=%E0%A4'), { chat: null, leaf: null, file: null, version: null });
```

- [ ] **Step 2: Run** `node --test tests/viewer.test.js`. Expected: FAIL, cannot find module.

- [ ] **Step 3: Implement the six functions.** Siblings share `parent`, ordered by `at` then array order. Unknown leaf falls back to the message with the latest `at`. `leafUnder` follows the latest child at each step. `parseHash` must not throw on bad `%` escapes. End the file with `if (typeof module === 'object' && module.exports) module.exports = { ... };`.

- [ ] **Step 4: Run** `node --test tests/viewer.test.js`. Expected: PASS.

- [ ] **Step 5: Commit** `viewer/viewer-logic.js tests/viewer.test.js` as "Add viewer tree and hash logic".

---

### Task 2: Builder: chat data and page assembly (text only)

Files come in Task 5. This task covers messages, thinking, tools, citations, safety and assembly.

**Files:**
- Create: `takeout-viewer.js`, `viewer/viewer-template.html` (minimal shell with the placeholders), and the four vendored files (`cp /Users/mbehringer/Downloads/notebooklm-exporter/viewer/{marked.min.js,katex.min.js,katex-inline.css,THIRD-PARTY-NOTICES.txt} viewer/`)
- Modify: `tests/viewer.test.js`, `tests/fixtures/conversation.json` (add `thinking` block to `m02`, one `citations` entry on a text block, one `attachments` entry on `m03`; existing tests must still pass)

**Interfaces:**
- Produces on `CTViewer`:
  - `buildViewerChat(data, ctx) -> Chat`. `ctx = { folder, model, fixText, artifacts, artifactIndex, uploads, deliveries, project }`; all optional here. `folder` is `''` for a single-chat ZIP.
  - `buildViewerData(chats, { exported }) -> ViewerData`, sorted by `updated`, newest first
  - `relHref(...parts) -> string|null`
  - `joinPath(folder, rel) -> string`, resolving `..`
  - `escapeJson(data) -> string`
  - `assembleViewer({ template, css, marked, katex, logic, app, data }) -> string`
  - `VIEWER_ASSETS`: `['viewer/viewer-template.html', 'viewer/viewer-logic.js', 'viewer/viewer-app.js', 'viewer/marked.min.js', 'viewer/katex.min.js', 'viewer/katex-inline.css']`
  - `TOOL_TEXT_LIMIT = 20000`
- Template placeholders: `/*KATEX_CSS*/`, `/*DATA_JSON*/` in `<script id="data" type="application/json">`, `/*MARKED_JS*/`, `/*KATEX_JS*/`, `/*LOGIC_JS*/`, `/*APP_JS*/`.

- [ ] **Step 1: Write failing tests.**

```js
const chat = buildViewerChat(fixture, { folder: '' });
assert.strictEqual(chat.messages.length, fixture.chat_messages.length); // all branches
assert.strictEqual(chat.leaf, 'm08');
const before = JSON.stringify(fixture);
buildViewerChat(fixture, {});
assert.strictEqual(JSON.stringify(fixture), before); // no mutation
// tool_use joined to its tool_result by id, even across messages
// a tool result longer than TOOL_TEXT_LIMIT is cut and says so
// Review Focus 2
assert.strictEqual(relHref('[p-project]_A#1', 'uploads', 'p01_a b?%.pdf'), '%5Bp-project%5D_A%231/uploads/p01_a%20b%3F%25.pdf');
assert.strictEqual(relHref('uploads', '../../etc/passwd'), null);
assert.strictEqual(joinPath('Chat', '../projects/P/files'), 'projects/P/files');
// Review Focus 3: run the assembled page's data element through JSON.parse
const hostile = '</script><!-- $& /*APP_JS*/';
const html = assembleViewer({ ...assets, data: buildViewerData([{ ...chat, title: hostile }], { exported: 'x' }) });
const raw = /<script id="data"[^>]*>([\s\S]*?)<\/script>/.exec(html)[1];
assert.strictEqual(JSON.parse(raw).chats[0].title, hostile);
assert.strictEqual((html.match(/<\/script>/g) || []).length, 5);
```

- [ ] **Step 2: Run** `node --test tests/viewer.test.js`. Expected: FAIL.

- [ ] **Step 3: Implement** `takeout-viewer.js`, wrapped as in NotebookLM's file. Port `escapeJson` and the one-pass `assembleViewer`, adding `LOGIC_JS`. Citations: read the same fields as `processTextWithCitations` in `popup.js`, and keep only `http(s)` URLs. `label` is a short line such as "Ran a command" or "Searched the web: <query>". Keep images from `tool_result` content only for `image/png|jpeg|gif|webp` base64 data; confirm this shape against a real export in Task 9. Apply `ctx.fixText` to attachment text.

- [ ] **Step 4: Run** `node --test tests/viewer.test.js`, then `sh tests/run.sh`. Expected: PASS.

- [ ] **Step 5: Commit** as "Build viewer data and assemble the page".

---

### Task 3: Look-only stage: layout and message rendering

**Files:**
- Modify: `viewer/viewer-template.html`, `viewer/viewer-logic.js`, `tests/viewer.test.js`
- Create: `viewer/viewer-app.js`, `tests/e2e/make-viewer.js`, `tests/e2e/viewer.e2e.js`

**Interfaces:**
- Consumes: Tasks 1 and 2.
- Produces in `viewer-logic.js`:
  - `protectMath(text) -> { text, math: string[] }` and `restoreMath(html, math, render) -> string`
  - `addCitations(text, cites) -> { text, sources: [{ n, url, title }] }`
  - `sanitizeHtml(html, parser) -> string`
- Produces in `viewer-app.js`: `renderChat(chat)`, run through a generation counter, so any later call cancels pending batches.
- Produces in `make-viewer.js`: `node tests/e2e/make-viewer.js <original.json> <out.html>` builds a viewer with no file context. With no arguments it prints usage and exits 0. This keeps real data out of the repo.

- [ ] **Step 1: Write failing unit tests.**

```js
assert.deepStrictEqual(protectMath('costs $5 and $10').math, []);
assert.deepStrictEqual(protectMath('`$x$` and ```\n$y$\n```').math, []); // code untouched
assert.deepStrictEqual(protectMath('so $x^2$ and\n$$y$$').math, ['$x^2$', '$$y$$']);
const c = addCitations('Hello world', [{ end: 5, url: 'https://a.test', title: 'A' }]);
assert.strictEqual(c.sources[0].n, 1);
assert.ok(c.text.startsWith('Hello<sup class="cite">'));
```

- [ ] **Step 2: Write `tests/e2e/viewer.e2e.js`.** Same `PW=`/`CHROME_EXE=` style and `check()` helper as `export.e2e.js`. It writes a viewer built from the fixture to a temp folder, opens it over `file://`, and blocks and counts every non-`file:` request. Checks:
  - sidebar shows "Claude Takeout" and the chat title; user bubble and serif assistant text render
  - thinking and tool lines start collapsed, and expand on click
  - zero network requests, zero console errors
  - each payload rendered through `sanitizeHtml` in the page does nothing and sets no flag: `<script>`, `<img src=x onerror=...>`, `<a href="javascript:...">`, `<svg onload=...>`, `<iframe src=...>`, `<style>@import url(...)</style>`, `<img src="https://remote.test/x.png">`
  - Review Focus 5: with a synthetic 300-message chat and a short one, start the long chat, switch to the short one at once, wait, and the DOM contains only the short chat's messages

- [ ] **Step 3: Run** `node --test tests/viewer.test.js`. Expected: FAIL.

- [ ] **Step 4: Implement logic.** `protectMath` starts from NotebookLM's regex in `viewer-app.js` `md()`, but skips code fences and code spans. Port `sanitizeHtml` and its constants from NotebookLM's `viewer-app.js`, with one change: images and other loading attributes survive only as `data:image/` non-SVG, so a chat can't pull in remote or local files. Rendering order: citations, `protectMath`, `marked.parse(t, { gfm: true })`, `sanitizeHtml`, `restoreMath` with `katex.renderToString(src, { displayMode, throwOnError: false })`.

- [ ] **Step 5: Implement the page.** Follow the mockup: left sidebar (brand, search box as a placeholder until Task 8, "Recents", footer "Archive · N chats · read-only"), top bar (title, model, date), centered column with right-aligned user bubbles, serif assistant text, message timestamps. Thinking is a "Thought process" line, tool calls a label line; both collapsed. A tool block's `images` show inline, outside the collapsed part. Code fences have a language label and a Copy button. Colors are `:root` tokens with a `prefers-color-scheme: dark` set.
  - Add a CSP `<meta>` to the template: `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src file: data:; font-src data:; frame-src file:; object-src 'none'; base-uri 'none'; form-action 'none'`.
  - Render messages in batches of 10 per animation frame, with `content-visibility: auto` on each.
  - Parse data with `JSON.parse(document.getElementById('data').textContent)`.

- [ ] **Step 6: Run tests.** `sh tests/run.sh`, then the e2e command from `tests/README.md` with `tests/e2e/viewer.e2e.js`. Expected: all PASS.

- [ ] **Step 7: Commit** as "Add the viewer's layout and message rendering".

- [ ] **Step 8: STOP for owner review.** Build from one real chat into the scratchpad, never the repo: `node tests/e2e/make-viewer.js <unzipped-export>/original.json <scratchpad>/viewer.html`. Ask the owner to open it beside claude.ai. Don't start Task 4 until the owner accepts the feel. Fix what they raise here, because everything after builds on this page.

---

### Task 4: Branch arrows and refresh state

**Files:**
- Modify: `viewer/viewer-app.js`, `viewer/viewer-template.html`, `tests/e2e/viewer.e2e.js`

**Interfaces:**
- Consumes: `chainFrom`, `siblingsOf`, `switchBranch`, `parseHash`, `formatHash`.
- Produces: `navigate(state)`, the single path for changing chat, leaf or file: it updates `location.hash`, then renders. Tasks 6 and 8 call it.

- [ ] **Step 1: Add failing e2e checks.** The fixture's `m05` has two replies, `m06` and `x01`. All fixture dates match, so array order applies: an arrow group shows `1 / 2` on `m06`; clicking forward shows `x01` and `2 / 2`; reload keeps that branch; an unknown chat in the hash opens the newest chat.

- [ ] **Step 2: Run the e2e.** Expected: new checks FAIL.

- [ ] **Step 3: Implement** arrows on any message with more than one sibling. Disable them at the ends. Look up IDs with `Map`, never plain-object keys. Keep the scroll position of the switched message.

- [ ] **Step 4: Run the e2e and `sh tests/run.sh`.** Expected: PASS.

- [ ] **Step 5: Commit** as "Browse branches with arrows and keep place on refresh".

---

### Task 5: Generated-file cards in the data

**Files:**
- Modify: `popup.js:529` (`extractArtifacts`), `takeout-viewer.js`, `tests/viewer.test.js`, `tests/export.test.js`

**Interfaces:**
- `extractArtifacts(data, errorCollector = null, index = null)`: when given, fills `index[key] = { path, filename, versions: [filename...], messages: [msgUuid...] }`, where `key` is the same state key the function already uses. Return value is unchanged. `extract_artifacts.py` needs no change, because output files don't change.
- `buildViewerChat` now reads:
  - `ctx.artifacts`: filename to text, `''` for binaries
  - `ctx.artifactIndex`: as above
  - `ctx.deliveries`: `{ [fileUuid]: { filename, path } }`
- It writes `Chat.files` and `card` blocks. `fileId` is `'a' + n`.

- [ ] **Step 1: Write failing tests.**

```js
const index = {};
const out = artifacts(fixture, null, index);
assert.deepStrictEqual(Object.keys(out), Object.keys(artifacts(fixture))); // same output
const k = '/tmp/work/notes.py'; // written in m06, edited in m08
assert.deepStrictEqual(index[k].messages, ['m06', 'm08']);
assert.strictEqual(index[k].versions.length, 2);
```

Builder tests with a fixture-derived `ctx`:
- A versioned artifact has one `GenFile`, one entry per `_vN`, and no separate entry for the final copy. Each has `label: 'v1'...` and its text.
- A card on message N points at the version as of N.
- `x01` on the inactive branch gets a card holding the `create_file` text from the tool call.
- A `str_replace` on an inactive branch gets `kind: 'missing'`.
- A `SendUserFile` delivery with `artifacts[name] === ''` gets `href` `artefacts/<name>` and `text: null`.
- With `folder: 'A B'`, that `href` is `A%20B/artefacts/<name>`.
- A failed `is_error` tool gets no card.
- One card per file per message, on the last block touching it.

- [ ] **Step 2: Run** `node --test tests/`. Expected: FAIL.

- [ ] **Step 3: Implement.** In `extractArtifacts`, record `msg.uuid` beside each `s.versions.push`, and fill `index` in the emit loop. In the builder, `kind` comes from the extension and tool type: `.html/.htm` html, `.svg` svg, `.md` md, `.png/.jpg/.jpeg/.gif/.webp` image, `.pdf` pdf, `.jsx/.tsx` and `application/vnd.ant.react` react, `.mmd` and `application/vnd.ant.mermaid` mermaid, other text code, other binary binary. Resolve `present_files` through the path in the index, then by basename in `ctx.artifacts`. Reuse the Bash heredoc rule: match the same pattern as `HEREDOC_RE` in `popup.js`, and pass it in through `ctx.heredocRe` so it has one definition.

- [ ] **Step 4: Run** `sh tests/run.sh`. Expected: PASS, including JS and Python parity.

- [ ] **Step 5: Commit** as "Link generated files to the messages that made them".

---

### Task 6: Side panel

**Files:**
- Modify: `viewer/viewer-logic.js`, `viewer/viewer-app.js`, `viewer/viewer-template.html`, `tests/viewer.test.js`, `tests/e2e/viewer.e2e.js`

**Interfaces:**
- Consumes: `Chat.files`, `navigate`.
- Produces in `viewer-logic.js`:
  - `inlineSiblings(html, lookup) -> string`, with `lookup(name) -> string|null`
  - `remoteScripts(html) -> number`
  - `previewDoc(text, lookup) -> { srcdoc, remote: number }`
  - `PREVIEW_CSP`

`PREVIEW_CSP` is exactly: `default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; base-uri 'none'; form-action 'none'`

- [ ] **Step 1: Write failing unit tests.**

```js
const look = n => ({ 'app.js': 'run("</script>")', 'a.css': 'b{}' })[n] ?? null;
assert.ok(inlineSiblings('<script src="./app.js"></script>', look).includes('run("<\\/script>")'));
assert.strictEqual(inlineSiblings('<script src="https://x.test/a.js"></script>', look), '<script src="https://x.test/a.js"></script>');
assert.ok(inlineSiblings('<link rel="stylesheet" href="a.css">', look).includes('<style>b{}</style>'));
assert.strictEqual(remoteScripts('<script src="https://x.test/a.js"></script><script src="b.js"></script>'), 1);
// The policy leads the document, so a comment holding "<head>" can't push it out of force
const d = previewDoc('<!doctype html><!-- <head> --><html><head></head>x', () => null);
assert.ok(d.srcdoc.startsWith(`<!doctype html><meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`));
```

- [ ] **Step 2: Add failing e2e checks.** With synthetic artifacts:
  - clicking a card opens the panel with the file's title, Preview and Code, and version buttons only when versions exceed 1
  - the iframe has `sandbox="allow-scripts"` and nothing else
  - a hostile artifact tries `fetch`, a remote `<img>`, reading `parent.document`, `top.location=`, and `window.open`: all fail, no non-`file:` request occurs, and the viewer stays on its page
  - a sibling-script artifact runs
  - a remote-script artifact shows the explanation with Code view offered
  - `.py` opens in Code view with no Preview tab
  - `react` and `mermaid` show Code view and "can't preview offline"
  - reload restores the open file and version

- [ ] **Step 3: Run tests.** Expected: FAIL.

- [ ] **Step 4: Implement.** `previewDoc` strips one leading doctype, then writes `<!doctype html><meta …CSP…>` + the rest. Render by `kind`:
  - html and svg: `previewDoc` in `<iframe sandbox="allow-scripts" srcdoc>`; the lookup finds the sibling's latest version in `Chat.files`
  - md: same render path as chat text
  - image: `<img src=href>`
  - pdf: plain `<iframe src=href>`, because Chrome's PDF viewer refuses a sandboxed frame; only ever for `kind: 'pdf'`
  - binary: details and an open link
  - missing: "not in this export"

  Code view uses `textContent` in a `<pre>`. On narrow windows, the panel covers the chat. A panel link never points at `.html`, `.htm`, `.svg` or `.xhtml`, as these would run outside the sandbox.

- [ ] **Step 5: Run tests.** Expected: PASS.

- [ ] **Step 6: Commit** as "Open generated files in a sandboxed side panel".

---

### Task 7: Popups: uploads, attachments, project files

**Files:**
- Modify: `takeout-viewer.js`, `viewer/viewer-app.js`, `viewer/viewer-template.html`, `tests/viewer.test.js`, `tests/e2e/viewer.e2e.js`

**Interfaces:**
- `buildViewerChat` now reads:
  - `ctx.uploads`: `{ [fileUuid]: { path: 'uploads/<name>', text: string|null } }`
  - `ctx.project`: `{ name, fileDir: 'project/files' | '../projects/<dir>/files', fileNames: [], docs: [{ name, text }] }`
- It writes `Msg.uploads`, `Msg.attachments` and `Chat.project`.
- `TEXT_EMBED_LIMIT = 2 * 1024 * 1024` is exported from `CTViewer` for Task 9.

- [ ] **Step 1: Write failing builder tests.**
  - both `files` and `files_v2` entries appear on their message, once each when they share a UUID
  - an upload absent from `ctx.uploads` has `href: null` and `text: null`, for failed downloads and inactive branches alike
  - `folder: 'A'`, `fileDir: '../projects/P/files'` gives `projects/P/files/x.pdf`
  - `folder: ''`, `fileDir: 'project/files'` gives `project/files/x.pdf`
  - attachments carry their `extracted_content`, passed through `ctx.fixText`

- [ ] **Step 2: Add failing e2e checks.** Clicking a chip opens a popup over the chat: an image displays, text shows literally (an uploaded `.html` shows as source and never runs), a PDF uses an iframe, `.odt` shows details and a link, an upload with `href: null` reads "not in this export". The popup closes with ✕, Escape and a click outside. A project section on the chat lists its files, which open in the popup.

- [ ] **Step 3: Run tests.** Expected: FAIL.

- [ ] **Step 4: Implement.** Popup content by `text`, else by extension. Put the project section below the top bar, collapsed. Offer "Open file" only for binaries, under the same exclusion as Task 6.

- [ ] **Step 5: Run tests.** Expected: PASS.

- [ ] **Step 6: Commit** as "Open uploads and project files in a popup".

---

### Task 8: Sidebar search and project grouping

**Files:**
- Modify: `viewer/viewer-logic.js`, `viewer/viewer-app.js`, `viewer/viewer-template.html`, `tests/viewer.test.js`, `tests/e2e/viewer.e2e.js`

**Interfaces:**
- Produces in `viewer-logic.js`:
  - `buildSearchIndex(chats) -> [{ chat, msg, text, lower }]`, over text blocks, attachment names and text, upload names and chat titles, on all branches
  - `searchChats(index, query, limit = 50) -> [{ chat, msg, snippet }]`
  - `groupChats(chats) -> { recents: Chat[], projects: [{ name, chats: Chat[] }] }`, projects sorted by name

- [ ] **Step 1: Write failing tests.**

```js
const idx = buildSearchIndex(chats);
assert.deepStrictEqual(searchChats(idx, 'ZEBRA').map(h => h.msg), ['m3']); // case-insensitive
assert.deepStrictEqual(searchChats(idx, '   '), []);
assert.ok(searchChats(idx, 'zebra')[0].snippet.includes('zebra'));
assert.ok(searchChats(idx, 'x'.repeat(5000)).length === 0); // long query is fine
assert.deepStrictEqual(groupChats(chats).projects.map(p => p.name), ['Alpha', 'Beta']);
```

- [ ] **Step 2: Add failing e2e checks.** Typing shows results; clicking a hit on an inactive branch opens that chat with the hit's branch selected, using `leafUnder(messages, hit.msg)`, and scrolls to it with the match highlighted. Project chats appear under the project's heading. A one-chat viewer still renders properly.

- [ ] **Step 3: Run tests.** Expected: FAIL.

- [ ] **Step 4: Implement.** Build the index on first focus of the box and debounce typing by 120 ms. Show snippets with `textContent`, never `innerHTML`. Escape clears the search.

- [ ] **Step 5: Run tests.** Expected: PASS.

- [ ] **Step 6: Commit** as "Add search across chats and group project chats".

---

### Task 9: Add the viewer to every ZIP

**Files:**
- Modify: `popup.js` (`populateConversationFolder`, `createZipExport`, `bulkExportZip`, the `ExportErrorCollector` hint switch), `popup.html`, `sidepanel.html`, `takeout-viewer.js`, `viewer/viewer-app.js`, `tests/helpers.js`, `tests/export.test.js`, `tests/e2e/export.e2e.js`, `tests/e2e/viewer.e2e.js`

**Interfaces:**
- Consumes: `CTViewer.buildViewerChat`, `buildViewerData`, `assembleViewer`, `VIEWER_ASSETS`, `TEXT_EMBED_LIMIT`.
- Produces:
  - `populateConversationFolder` returns `viewerChat: Chat | null` as well, and takes `folderName = ''` as a new last parameter
  - `writeViewer(zip, chats) -> Promise<boolean>` in `popup.js`
  - `CTViewer.VIEWER_CHECK_FILE = 'viewer-check.gif'`, `CTViewer.VIEWER_CHECK_BASE64`, a 1×1 GIF
- New warning type `viewer`, with a `_getRecoveryHint` case: "The chat data is all in this export. Only viewer.html is missing or incomplete; the Markdown files are unaffected."

- [ ] **Step 1: Write failing tests** in `tests/export.test.js`, through the real `populateConversationFolder` with an in-memory folder stub:
  - `viewerChat` has the right cards, and `folder` prefixes `href`s
  - a failed upload ends up with `href: null`
  - Review Focus 4: when `CTViewer.buildViewerChat` is replaced by a throwing stub, every other file is still written, `viewerChat` is `null`, and `errors.txt` has a `viewer` warning
  - `writeViewer` with a rejecting asset fetch returns `false` and writes nothing
  - file list and contents match, ignoring `viewer.html` and `viewer-check.gif`, between a run with the viewer and one with `CTViewer` throwing
  - a guard test: `popup.html` and `sidepanel.html` load `takeout-viewer.js` before `popup.js`, and every `VIEWER_ASSETS` path exists

- [ ] **Step 2: Add failing e2e checks.**
  - In `export.e2e.js`: single-chat ZIP and mega-ZIP each hold `viewer.html` and `viewer-check.gif` at root. The mega-ZIP has one viewer with all chats. Bytes of an uploaded binary are unchanged.
  - In `viewer.e2e.js`: unzip the mega-ZIP, open `viewer.html`, and confirm an upload image and a shared project PDF load from their links, with two chats sharing one project.
  - In `viewer.e2e.js`: a `viewer.html` alone in a folder, with no `viewer-check.gif`, shows a banner starting "Unzip this archive first".

- [ ] **Step 3: Run tests.** Expected: FAIL.

- [ ] **Step 4: Implement `populateConversationFolder` changes.**
  - In the upload loop, record `viewerUploads[file.uuid] = { path: 'uploads/' + name, text }`, in both success paths. `text` is read only when `isTextFile(name)` and the size is at most `TEXT_EMBED_LIMIT`.
  - Build `deliveries` from `deliveredFiles`, and pass an `artifactIndex` object to the existing `extractArtifacts` call.
  - Just before `errors.txt` is written, call `buildViewerChat` in `try/catch`. On failure, add a `viewer` warning.
  - Only add to what exists: no README or index change.

- [ ] **Step 5: Implement ZIP writing.** `writeViewer` fetches assets with `chrome.runtime.getURL`, assembles, and writes both root files. On any failure it logs and returns `false`. `createZipExport` passes `[result.viewerChat]`; `bulkExportZip` collects chats and passes each `folderName`. Both skip `null` chats. When it returns `false`, `createZipExport` and `bulkExportZip` include "viewer.html could not be built" in the status text and use the amber `.status.warning`. In `tests/helpers.js`, load `takeout-viewer.js` into the VM before `popup.js`. Add `<script src="takeout-viewer.js"></script>` right before `popup.js` in both HTML files.

- [ ] **Step 6: Implement the unzip banner** in `viewer-app.js`: on load, `new Image()` with `src` `viewer-check.gif`. `onerror` shows the banner: "Unzip this archive first. Files can't open from inside a ZIP." Chat text still displays.

- [ ] **Step 7: Run** `sh tests/run.sh`, `export.e2e.js`, `panel.e2e.js`, `viewer.e2e.js`. Expected: all PASS. `panel.e2e.js` guards against the extension failing to load.

- [ ] **Step 8: Commit** as "Add viewer.html to every export".

---

### Task 10: Docs, version and real-export check

**Files:**
- Modify: `manifest.json` (`1.6.0`), `README.md`, `USAGE.md`, `CLAUDE.md`, `tests/README.md`

**Interfaces:**
- Consumes: everything above. Produces nothing for code.

- [ ] **Step 1: Update docs.**
  - `README.md`: `### v1.6.0` changelog entry, plus `viewer.html` and `viewer-check.gif` in the ZIP layout.
  - `USAGE.md`: unzip, then open `viewer.html`; previews never use the network.
  - `CLAUDE.md`: file map rows, §7 layout, the `viewer` warning in §11, a §15 row for viewer changes, the fact that `extractArtifacts` has an `index` parameter.
  - `tests/README.md`: rows for `viewer.test.js` and `viewer.e2e.js`.

- [ ] **Step 2: Run** `sh tests/run.sh`. Expected: PASS, including the manifest and changelog test.

- [ ] **Step 3: Commit** as "Release v1.6.0: offline viewer".

- [ ] **Step 4: Owner's real-export review.** Ask the owner to reload the extension and export one single chat and one mega-ZIP. Then, with the files unzipped into new, empty folders:
  - run `validate-export` on a chat folder, to confirm nothing regressed
  - check real tool-result images and citations against what Task 2 assumed
  - check the 61-HTML-file preview tiers from the spec: self-contained, sibling script, remote CSS, remote script
  - time opening the 127-message chat

  Fix what turns up, with a test for each fix. The owner judges feel against claude.ai before release. Tagging `v1.6.0` needs the owner's OK.
