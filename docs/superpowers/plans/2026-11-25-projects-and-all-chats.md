# Projects page and All chats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In a multi-chat offline viewer, add a claude.ai-like Projects page and project page, and replace the project-grouped sidebar with Projects / Chats entries, 30 Recents and View all (an All chats page).

**Architecture:** The export side adds `id`, `description`, `updated` to each viewer project (from the `project.json` record already fetched) and merges projects by `id` in `buildViewerData`. The viewer gets pure helpers in viewer-logic.js (tested in Node) and one new screen, `#lists-screen`, in viewer-app.js that shows `#projects`, `#project=<key>` or `#chats` in place of the chat, sharing the Artifacts screen's title hand-over.

**Tech Stack:** Plain JS (no build), Node test runner, playwright-core e2e over `file://`.

**Spec:** `docs/superpowers/specs/2026-11-25-projects-and-all-chats-design.md` (approved; read it first).

## Global Constraints

- Applies only when `chats.length > 1`; with one chat or none the viewer behaves exactly as today (even with an Artifacts screen).
- No new network request, no change to CSPs, sandboxing or `sanitizeHtml`.
- Every name, description, instruction and title is set as text (`el`/`textContent`): no Markdown, no `innerHTML`.
- Recents: 30 chats (`RECENT_LIMIT = 30`). Rows on All chats and a project page: 200 at a time (`LIST_PAGE = 200`) with **Show more**; filters search every row, not only those shown.
- Hashes: `#projects`, `#project=<key>` (key = project `id`, else `i<index>` into `ViewerData.projects`), `#chats`; routed after the Artifacts screen's hashes, before the chat viewer's; whole-hash matches only.
- Empty project name → "Untitled project"; empty chat title → "Untitled"; no date → no "Updated" line.
- `document.title`: "Projects - Claude Takeout", "<project name> - Claude Takeout", "Chats - Claude Takeout".
- Rows on the new pages never use the class `.item`.
- Commit as bearspear with trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never stage `.claude/`, `.superpowers/`, `.DS_Store`. `node --check` every edited JS file. No `_`-prefixed files.
- E2E command: `PW=/Users/mbehringer/.kage-studio/visual-check/node_modules/playwright-core CHROME_EXE=/Users/mbehringer/Library/Caches/ms-playwright/chromium-1194/chrome-mac/Chromium.app/Contents/MacOS/Chromium node tests/e2e/<name>.e2e.js` (one file at a time). combined.e2e has 3 known failures (navhttps, navdata, navblob), also on main.

## Review Focus

1. A project name or description holding HTML (`<img src=x onerror=…>`) shows as text on the card, the project page and the chat's fold bar, and nothing runs — pinned in Task 4's e2e.
2. A chat with no `updated` date sorts last in Recents and All chats and shows no "Updated" line — pinned in Task 2 (helper) and Task 4 (e2e).
3. An archive opened directly at `#projects` (or `#project=…`, `#chats`) shows that page, not a chat; Back from it to a chat restores the chat's title — pinned in Task 3's e2e.
4. An older archive's project with no real uuid (archive-lib's placeholder `'project'`) is never merged with another project and still gets a working `i<index>` page — pinned in Task 1 (archive test) and Task 4 (e2e).
5. 230 chats: the All chats page shows 200 then Show more, and the filter finds a chat beyond the first 200 — pinned in Task 4's e2e.

---

### Task 1: Project id, description and dates in the viewer data

**Files:**
- Modify: `export-core.js` (`viewerProject`, ~2636)
- Modify: `popup.js` (the `viewerProject` call in `populateConversationFolder`, ~3237)
- Modify: `tools/archive-lib.js` (~1244-1248)
- Modify: `takeout-viewer.js` (`buildProject` ~617, `buildViewerData` ~772-835, header comment for `ctx.project` ~55-62)
- Test: `tests/export.test.js`, `tests/viewer.test.js`, `tests/archive.test.js`

**Interfaces:**
- Produces: `viewerProject(data, projectFiles, projectFileMapping, fileDir, fileNames, instructions = '', limit = 2*1024*1024, meta = null)` returning today's object plus `id` (string, when known), `description` (string, when `meta.description` is a non-empty string; `fixMojibake`d, cut at `limit` with the same truncation note style as instructions but naming `project/project.json`), `updated` (string, `meta.updated_at`, when a string).
- Produces: each entry of `ViewerData.projects` may carry `id`, `description`, `updated` (strings only). Later tasks read them.

- [ ] **Step 1: Write failing tests**

In `tests/export.test.js`:
```js
test('viewerProject takes id, description and updated from the project record', () => {
  const data = { project_uuid: 'p-1', project: { uuid: 'p-1', name: 'Alpha' } };
  const meta = { uuid: 'p-1', description: 'Plans Ã© notes', updated_at: '2026-05-01T00:00:00Z', created_at: '2026-01-01T00:00:00Z' };
  const p = viewerProject(data, {}, {}, 'project/files', [], '', 1000, meta);
  assert.strictEqual(p.id, 'p-1');
  assert.strictEqual(p.description, 'Plans é notes');
  assert.strictEqual(p.updated, '2026-05-01T00:00:00Z');
  assert.ok(!('created' in p));
  const bare = viewerProject(data, {}, {}, 'project/files', [], '', 1000);
  assert.strictEqual(bare.id, 'p-1');
  assert.ok(!('description' in bare) && !('updated' in bare));
});
```
In `tests/viewer.test.js` (buildViewerData):
```js
test('buildViewerData keeps the new project fields and merges one id', () => {
  // two chats of project p-1 with different copies: the newer `updated` wins; a third project without id stays apart
  // assert: data.projects.length === 2; the p-1 entry has description of the newer copy; both p-1 chats point at it;
  // a tie on updated prefers the copy with more docs + files.
});
```
(Write the three cases as concrete `buildViewerData([...], {})` calls with `buildViewerChat` inputs as other tests in that file do.)
In `tests/archive.test.js`: a chat folder whose original.json has no `project_uuid` but a `project/project.json` without `uuid` → its viewer project has no `id`; with `project.json` `{ uuid: 'p-9', description: 'D' }` → `id === 'p-9'`, `description === 'D'`.

- [ ] **Step 2: Run `sh tests/run.sh`** — Expected: the new tests FAIL (no `id`/`description`; projects not merged by id).

- [ ] **Step 3: Implement**
- `viewerProject`: add `meta`; `id` = `meta && typeof meta.uuid === 'string' && meta.uuid` || `data.project_uuid` || `data.project?.uuid` (never the literal `'project'`).
- popup.js: pass `projectMetadataJson` as `meta`.
- archive-lib.js: pass `meta`; do not let the placeholder `'project'` become the id (pass the real `data.project_uuid`/`data.project.uuid` only; `viewerProject` ignores `'project'`).
- `buildProject`: copy `id`, `description`, `updated` when strings.
- `buildViewerData`: before the content key, look up projects by `id`: same id → one index; keep the copy with newest `updated`, then more `docs.length + files.length`, then the first (replace `projects[i]` when a later copy wins). Without id, today's content rule.
- Update the `ctx.project` header comment.

- [ ] **Step 4: Run `sh tests/run.sh`** — Expected: all pass. `node --check` export-core.js, popup.js, takeout-viewer.js, tools/archive-lib.js.

- [ ] **Step 5: Commit** — `git add export-core.js popup.js tools/archive-lib.js takeout-viewer.js tests/export.test.js tests/viewer.test.js tests/archive.test.js` and commit "Viewer projects carry id, description and updated; one project per id".

---

### Task 2: Pure helpers for lists

**Files:**
- Modify: `viewer/viewer-logic.js` (near `groupChats` ~1360; add to `module.exports`)
- Test: `tests/viewer.test.js`

**Interfaces:**
- Produces (all exported):
  - `RECENT_LIMIT = 30`, `LIST_PAGE = 200`
  - `recentChats(chats, n) -> chat[]`: n newest by `updated` (ISO string compare), chats without a parseable `updated` last, ties in input order. Does not mutate.
  - `projectList(chats, projects) -> [{ key, name, description, updated, chats }]`: only projects with chats. `chats` = linked chat objects (chat.project is the object after `linkProjects`); `projects` = `ViewerData.projects` (for the index key). `key` = `project.id` or `'i' + projects.indexOf(project)`. `name` = project name or "Untitled project", second of one name "Name (2)" (by order of first appearance in the newest-first list). `updated` = newest of project.updated and its chats' updated ('' when none). Chats newest first (as `recentChats`). Sorted by `updated` newest first, '' last.
  - `filterByText(items, query, fields) -> items`: every whitespace-separated word of `query` (folded with `foldCase`) appears in at least one of `fields(item)` (an array of strings, folded). Empty query → items unchanged.
  - `parseListHash(hash) -> { page: 'projects' } | { page: 'chats' } | { page: 'project', key } | null`: whole-hash match of `#projects`, `#chats`, `#project=<non-empty, decoded>`.

- [ ] **Step 1: Write failing tests** in `tests/viewer.test.js`:
```js
test('recentChats: newest first, undated last, n at most', () => {
  const c = (id, updated) => ({ id, updated });
  const got = recentChats([c('a', '2026-01-01T00:00:00Z'), c('b'), c('c', '2026-03-01T00:00:00Z'), c('d', '2026-02-01T00:00:00Z')], 3);
  assert.deepStrictEqual(got.map(x => x.id), ['c', 'd', 'a']);
  assert.deepStrictEqual(recentChats([c('b'), c('a', '2026-01-01T00:00:00Z')], 30).map(x => x.id), ['a', 'b']);
  assert.strictEqual(RECENT_LIMIT, 30); assert.strictEqual(LIST_PAGE, 200);
});
test('projectList: keyed by id or index, named, sorted by latest activity', () => {
  const P1 = { id: 'p1', name: 'Alpha', updated: '2026-01-05T00:00:00Z' }, P2 = { name: '' }, P3 = { name: 'Alpha' };
  const projects = [P1, P2, P3, { id: 'empty', name: 'No chats' }];
  const chats = [{ id: 'x', project: P1, updated: '2026-01-01T00:00:00Z' }, { id: 'y', project: P2, updated: '2026-04-01T00:00:00Z' },
    { id: 'z', project: P3, updated: '2026-02-01T00:00:00Z' }, { id: 'w', project: P1, updated: '2026-03-01T00:00:00Z' }, { id: 'v', project: null }];
  const list = projectList(chats, projects);
  assert.deepStrictEqual(list.map(p => [p.key, p.name, p.updated, p.chats.map(c => c.id).join()]), [
    ['i1', 'Untitled project', '2026-04-01T00:00:00Z', 'y'],
    ['p1', 'Alpha', '2026-03-01T00:00:00Z', 'w,x'],
    ['i2', 'Alpha (2)', '2026-02-01T00:00:00Z', 'z'],
  ]);
});
test('filterByText: every word, folded, across fields', () => {
  const items = [{ t: 'Café plans', d: 'Q3' }, { t: 'Other', d: 'cafe q3' }, { t: 'None', d: '' }];
  assert.deepStrictEqual(filterByText(items, 'cafe q3', i => [i.t, i.d]).map(i => i.t), ['Café plans', 'Other']);
  assert.strictEqual(filterByText(items, '  ', i => [i.t]).length, 3);
});
test('parseListHash: whole hashes only', () => {
  assert.deepStrictEqual(parseListHash('#projects'), { page: 'projects' });
  assert.deepStrictEqual(parseListHash('#chats'), { page: 'chats' });
  assert.deepStrictEqual(parseListHash('#project=p%201'), { page: 'project', key: 'p 1' });
  for (const h of ['', '#project=', '#projects&x=1', '#chat=abc', '#artifacts', '#chats2']) assert.strictEqual(parseListHash(h), null, h);
});
```
(Name "Alpha (2)" goes to the later of two same-named projects in newest-first order: P1 is newer than P3, so P3 is "(2)". `foldCase` makes "Café" match "cafe": check it does; if it doesn't strip accents, use only case in the test and say so in the ledger.)

- [ ] **Step 2: Run `node --test tests/viewer.test.js`** — Expected: FAIL (not defined).
- [ ] **Step 3: Implement** the four helpers and two constants; export them.
- [ ] **Step 4: Run `sh tests/run.sh`** — Expected: all pass.
- [ ] **Step 5: Commit** "Viewer helpers: recentChats, projectList, filterByText, parseListHash".

---

### Task 3: Sidebar entries, Recents, the lists screen and its routes

**Files:**
- Modify: `viewer/viewer-template.html` (sidebar markup beside `#artifacts-nav`; `#lists-screen` beside `#artifacts-screen`; CSS for the entries and screen)
- Modify: `viewer/viewer-app.js` (`renderSidebar`, `start`, `navigate`, `showArtifacts`/`routeArtifacts` title hand-over, new `routeLists`/`showLists`)
- Modify: `tests/e2e/viewer.e2e.js` (~1110-1120 group checks)
- Create: `tests/e2e/projects.e2e.js`

**Interfaces:**
- Consumes: Task 2's helpers; Task 1's project fields.
- Produces: `showLists(on, titles)`, `routeLists(hash) -> boolean`, and a page-render hook `renderListPage(state)` that Task 4 fills (in this task it renders a heading only: "Projects", the project's name, or "Chats", each an `h2` with `tabindex="-1"` and class `list-title`). `#lists-screen` element; buttons `#projects-nav` (class `nav`, text "Projects", count in `.n`) and `#chats-nav` (text "Chats").

- [ ] **Step 1: Write the failing e2e** `tests/e2e/projects.e2e.js` (harness as `tests/e2e/search.e2e.js`: `buildHtml` from `./make-viewer.js`, a temp dir, Chromium, network blocked except `file:`). Fixture: 230 chats (`updated` spread over days; chat 229 has no `updated`), projects Alpha (id `p-a`, description, instructions, one doc), Beta (id `p-b`, no description, name `Beta <img src=x onerror="console.log('NAME RAN')">`), Gamma (no id: pass a project without `id`). Checks in this task:
  - sidebar: `#projects-nav` visible with count `3`, `#chats-nav` visible with count `230`; `#recents .item` count 30, in newest-first order; no `#recents .lab` other than "Recents"; a "View all" button visible.
  - `#projects-nav` click → hash `#projects`, `#lists-screen` visible, `#scroll` hidden, `h2.list-title` text "Projects" and focused, `document.title === 'Projects - Claude Takeout'`, `#projects-nav[aria-current=true]`.
  - View all → `#chats`, title "Chats".
  - `page.goto(file + '#projects')` → lists screen shows, no chat drawn (`#chat .msg` count 0).
  - Back (history) from `#projects` to the chat → chat's title back in `#title`; going `#projects` → `#artifacts`-less path → a chat restores the chat title.
  - With search typed (sidebar results showing) the two entries stay visible.
  - A one-chat viewer: no `#projects-nav`/`#chats-nav` visible, sidebar as today.
  - No page error, no request.
  Update `viewer.e2e.js` ~1115-1119: the 8-chat sidebar now shows only "Recents" with 8 items newest first, and `#projects-nav` count 2 (Alpha, Zeta).

- [ ] **Step 2: Run** projects.e2e and viewer.e2e — Expected: the new checks FAIL.

- [ ] **Step 3: Implement**
  - Template: two buttons after `#artifacts-nav`, hidden by default, same look; `<div id="lists-screen" role="region" aria-label="Projects and chats" hidden></div>` after `#artifacts-screen`; `body.lists-on` hides `#scroll`, `#project`, `#findbar` and the top bar's file button as `body.artifacts-on` does (copy that CSS).
  - `renderSidebar(chats)`: if `chats.length <= 1` keep today's code. Else: Recents = `recentChats(chats, RECENT_LIMIT).map(chatItem)`; no project headings; when `chats.length > RECENT_LIMIT` append `button.view-all` "View all" → `location.hash = '#chats'`; show `#projects-nav` (count = `projectList(...).length`, hidden when 0) and `#chats-nav` (count = chats.length); both call `setDrawer(false)` then set the hash (or route directly when already there).
  - Screen state: one module-level `titlesBefore`, set only when leaving the chat for either screen, restored only when returning to a chat. `showArtifacts(true)` hides the lists screen and vice versa. `navigate` calls `showLists(false)` beside `showArtifacts(false)`, before its early return.
  - `onHashChange` and `start()`: `routeArtifacts(hash)` first, then `routeLists(hash)`, then the chat viewer. `routeLists` returns false when `chats.length <= 1` or `parseListHash` is null; an unknown project key routes as `#projects`.
  - `showLists(true)`: `aria-current` on the matching entry, all `.item` set `aria-current=false`, `closeStepper()`, `closeFilesMenu(false)`, `#title` text = page title, `document.title` per Global Constraints, focus the `h2.list-title`.

- [ ] **Step 4: Run** projects.e2e, viewer.e2e, search.e2e, files.e2e — Expected: all pass. `node --check viewer/viewer-app.js`; `sh tests/run.sh` passes.
- [ ] **Step 5: Commit** "Viewer: Projects and Chats entries, 30 Recents, the lists screen and its routes".

---

### Task 4: The three pages and Open project

**Files:**
- Modify: `viewer/viewer-app.js` (`renderListPage`, `renderProject` fold bar)
- Modify: `viewer/viewer-template.html` (CSS)
- Modify: `tests/e2e/projects.e2e.js`

**Interfaces:**
- Consumes: Task 3's `renderListPage(state)`, `#lists-screen`; Task 2's helpers; `relativeTime(iso, now)` (viewer-logic.js; `''` for no date); `fileChip(item, note)` and `fileNote` (viewer-app.js, as `renderProject` uses them).

- [ ] **Step 1: Write the failing e2e checks** (append to projects.e2e.js):
  - **Projects:** 3 cards (`a.project-card`) in order newest activity first; card has `.name`, `.desc` (two-line clamp; absent for Beta), `.meta` "N chats · Updated …"; Beta's name shows the literal `<img …>` text and `NAME RAN` never logs; filter "alp" leaves Alpha only; a card click → `#project=p-a`.
  - **Project page (Alpha):** `a.back` "All projects" → `#projects`; `h2.list-title` "Alpha", description text; chats list (`a.chat-row`) newest first with "Updated …"; Instructions box with **Show more** when longer than 8 lines; Knowledge chips count = docs + files; clicking a doc chip opens it as the fold bar's chip does (same popup).
  - **Gamma (no id):** reached from its card at `#project=i<n>`; page renders.
  - **All chats:** "230 chats"; 200 `a.chat-row` then `button.show-more` → 230; the undated chat is last with no "Updated" line; a row's project link → that project page; filter with the title of chat #215 finds it while only 200 rows were shown.
  - **From a chat:** open an Alpha chat → `#project` fold bar has `a.open-project` "Open project" → `#project=p-a`.
  - Phone width 420: the drawer closes on Projects; cards are one column.
  - Dark mode (`colorScheme: 'dark'`): cards' text colour differs from their background (computed styles).
- [ ] **Step 2: Run** projects.e2e — Expected: new checks FAIL.
- [ ] **Step 3: Implement** the three pages in `renderListPage` with `el()` only, per the spec's page sections; rows and cards are `<a href="#…">` (chat rows `href` = the chat viewer's own hash via `formatHash({ chat: id })`), never `.item`; Show more appends the next `LIST_PAGE`; filter inputs (`input.list-filter`, `aria-label` "Filter projects"/"Filter chats") re-render from the full list via `filterByText`; project page chat filter only when > 10 chats. In `renderProject`, when the viewer is multi-chat and the chat has a project, add `a.open-project` "Open project" to the fold bar linking `#project=<key>` (key as `projectList` computes). CSS with the template's existing tokens, light and dark; grid `repeat(auto-fill, minmax(260px, 1fr))`.
- [ ] **Step 4: Run** projects.e2e, viewer.e2e, search.e2e, files.e2e, archive.e2e, combined.e2e (3 known failures only) and `sh tests/run.sh` — Expected: pass.
- [ ] **Step 5: Commit** "Viewer: Projects, project and All chats pages; Open project from a chat".

---

### Task 5: Docs and version

**Files:** `README.md` (changelog `### v1.24.0` at the top; Features line for Offline Viewer mentions Projects and All chats), `manifest.json` (`1.24.0`), `USAGE.md` (viewer section: Projects, project page, Recents/View all, All chats), `TECHNICAL.md` (viewer section: the new fields, `buildViewerData` merge by id, the helpers, `#lists-screen` and its routes), `CLAUDE.md` (file map row for `tests/e2e/projects.e2e.js`; the `takeout-viewer.js`/§7 note that a viewer project carries `id`, `description`, `updated`).

- [ ] **Step 1:** Write the docs (plain, user-facing in README/USAGE; function names in TECHNICAL).
- [ ] **Step 2: Run `sh tests/run.sh`** — Expected: pass (the manifest/changelog test included).
- [ ] **Step 3: Commit** "v1.24.0: Projects and All chats in the viewer (docs)".
