# Panel Redesign (v1.22.0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the popup / side panel's ten-button stack with the two-section panel and its Exporting, Done, Export stopped and Settings screens, as specified.

**Architecture:** One HTML page (`popup.html`, with `sidepanel.html` a byte-identical copy) holding five `<section data-screen>` screens; `popup.js` shows one at a time with `showScreen(name)`. Bulk exports stop writing the status pill and instead report through a progress emitter and return a run result object, which the Exporting, Done and Stopped screens render. Pure view-model functions (summary text, export plan, warning groups) live in a new `// ==== Panel screens` section of `popup.js` and are unit-tested through `tests/helpers.js` `loadPopup`.

**Tech Stack:** Chrome MV3, plain JS (no build), Node's `node:test`, optional Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-11-24-panel-redesign-design.md` (read it; its "Calls made in review" section is binding). Boards: <https://claude.ai/artifact/6qFovU3tamE4iyQ2ot9dw7>; local copies in the session scratchpad `panel-design/project/*.dc.html` may be gone, the spec has every value.

## Global Constraints

- Version 1.22.0: `manifest.json` and a `### v1.22.0` README changelog entry in the same branch (a test enforces manifest ≥ changelog).
- No new permissions; `manifest.json` permissions unchanged.
- No change to what any export writes, except: bulk Markdown/Embedded/JSON removed; Stop as specified.
- Opening the panel or a tab change makes no more claude.ai calls than today (`requestData` only).
- Colors exactly as the spec: purple `#7c3aed`, outlined button text `#5b21b6`, green card `#e8f5e9`/`#c8e6c9`/`#1b5e20`, amber `#fffbeb`/`#fde68a`/`#78350f`, red `#fef2f2`/`#fecaca`/`#7f1d1d`, grey `#f3f4f6`/`#e5e7eb`, body text `#1f2937`, secondary `#4b5563`, pill border `#6b7280`, disabled `#f3f4f6` fill `#d1d5db` border `#4b5563` text, focus `2px solid #4c1d95` offset 2px.
- Targets: icon buttons 40 px, primary buttons 44 px, pills 32 px, checkbox rows 40 px with 18 px boxes, Settings Back 44 px.
- Dates in text `YYYY-MM-DD HH:MM` (local time).
- Never write the asset token or picture URL anywhere (unchanged rule; the new screens show codes and counts only).
- `node --check popup.js` after every edit; `sh tests/run.sh` green before every commit.
- Commits as bearspear, trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never stage `.claude/`, `.superpowers/`, `.DS_Store`. No push.

## Review Focus

1. A tab change while the Exporting or Done screen shows: the screen must stay (no `requestData` repaint over it); the deferred refresh runs after Back. Test in Task 1 and Task 6.
2. Stop clicked between writes in folder mode with Changes only: the record must not move (`saveExportRecord` not called), so the next Changes only run takes the same chats again. Test in Task 3.
3. Popup → sidebar handoff with Chats off + Artifacts on, Folder: the side panel must run `exportArtifacts`, not `bulkExportZip`. Test in Task 7.
4. Count clicked, then Artifacts unticked: summary drops the artifact count and Changes only stays allowed; Changes only + only Artifacts ticked is disabled even if `megaZipScope` is `'changes'` in storage. Test in Task 4.
5. Done screen with more than 5 warning groups shows 5 and "and N more"; zero warnings renders the green "Done" card, not amber. Test in Task 4.

---

### Task 1: Running flag and `withArtifacts` option (no UI change)

**Files:**
- Modify: `popup.js` (`scheduleRefresh` ~4574, `hideProgress` ~4429, `exclusiveExport` ~6110, `bulkExportZip` ~4868/4908)
- Test: `tests/screens.test.js` (new)

**Interfaces:**
- Produces: `exportRunning` (existing `let`, now the only "busy" signal); `bulkExportZip({ changesOnly, directory, withArtifacts })` where `withArtifacts: boolean` defaults to `settings.exportAllArtifacts !== false`; `finishRun()` called in `exclusiveExport`'s `finally`, runs a deferred `requestData({ preserveStatus: true })` when `refreshDeferred`.

- [ ] **Step 1: Write failing tests** in `tests/screens.test.js` using `loadPopup`:
  - `'scheduleRefresh defers while an export runs, whatever the progress bar shows'`: set `exportRunning = true`, leave `#progress.style.display` `'none'`, call `scheduleRefresh()`, wait 200 ms, assert `refreshDeferred === true` and `chrome.tabs.query` not called.
  - `'bulkExportZip honours withArtifacts over the setting'`: stub `chrome.tabs.sendMessage` so `fetchAllConversations` returns `{ data: [], orgId: 'o' }`, record actions; with `settings.exportAllArtifacts = true` call `bulkExportZip({ withArtifacts: false })`; assert no `listArtifacts` message was sent.
- [ ] **Step 2: Run** `node --test tests/screens.test.js` — Expected: both FAIL.
- [ ] **Step 3: Implement.** `scheduleRefresh` checks `exportRunning`; move the deferred refresh from `hideProgress` into `finishRun()` called from `exclusiveExport`'s `finally` after `exportRunning = false`. `bulkExportZip` reads `options.withArtifacts` when boolean.
- [ ] **Step 4: Run** `sh tests/run.sh` — Expected: all pass (existing tests that relied on `#progress` display adjusted only if they assert the old mechanism; note any in the commit body).
- [ ] **Step 5: Commit** `git add popup.js tests/screens.test.js && git commit` — "Panel: one running flag; Export All takes withArtifacts".

### Task 2: Run results and warning totals

**Files:**
- Modify: `popup.js` (`bulkExportZip`, `exportArtifacts`, `saveExportRecord`)
- Test: `tests/screens.test.js`, existing `tests/export.test.js` assertions on final status text

**Interfaces:**
- Consumes: Task 1's `bulkExportZip` options.
- Produces: both `bulkExportZip(options)` and `exportArtifacts(options)` resolve to a `RunResult`:
  ```
  { outcome: 'done' | 'stopped' | 'failed', reason: string, // '' for done; 'stopped' → 'You stopped it'
    target: { kind: 'folder' | 'zip', name: string },        // run folder name or ZIP file name
    saved: { chats: number, artifacts: number, versions: number },
    warnings: number, warningList: [{ type: string, text: string }], // text: one line, codes only
    errorFiles: string[],                                    // e.g. ['errors.txt', 'artifacts/errors.txt'] that exist
    startedAt: string, endedAt: string }                     // ISO
  ```
  `warnings` = per spec call 7: every chat collector's warnings + errors, chats that failed outright, write failures, the artifacts collector's warnings, +1 if `viewer.html` could not be built. `saveExportRecord(org, at, chats, artifacts, versions, warnings)` stores `warnings` (number) on the entry.
  `loadExportRecord` unchanged (returns `warnings` when present).

- [ ] **Step 1: Write failing tests:**
  - `'bulkExportZip resolves a done RunResult with counts and warnings'` using `exportPopup`/`zipStub` from helpers with the fixture chat plus one chat whose upload 404s: assert `outcome === 'done'`, `saved.chats === 2`, `warnings >= 1`, `warningList[0].type === 'upload'`, `target.kind === 'zip'`.
  - `'a failed chat list resolves outcome failed with the error as reason'`: `fetchAllConversations` replies `{ error: 'HTTP 500' }`; assert `outcome === 'failed'`, `reason` contains `'500'`.
  - `'saveExportRecord keeps the warning count'`: call with `warnings = 3`, read back the stored entry, assert `.warnings === 3`.
  - `'exportArtifacts resolves a RunResult'`: with `runArtifacts` helper, assert `outcome === 'done'` and `saved.artifacts` equals the listed count.
- [ ] **Step 2: Run** `node --test tests/screens.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement.** Build the result where each path ends today; keep every existing status write for now (Task 6 removes them). Collect `warningList` from each chat's `errorCollector.warnings`/`errors` (type + first line of message) and the artifacts collector.
- [ ] **Step 4: Run** `sh tests/run.sh` — Expected: pass.
- [ ] **Step 5: Commit** "Export All and Export Artifacts return a run result".

### Task 3: Progress emitter and Stop

**Files:**
- Modify: `popup.js` (`bulkExportZip`, `runArtifactStep` ~5870, `saveHistory` ~5765, `exportArtifacts`)
- Test: `tests/screens.test.js`

**Interfaces:**
- Consumes: `RunResult` (Task 2).
- Produces:
  - `options.onProgress(event)` on `bulkExportZip` and `exportArtifacts`, event `{ phase: 'chats' | 'artifacts' | 'viewer', done: number, total: number, sub: string, warnings: number }`. `saveHistory` gets `ctx.onVersion(i, n)` so the artifacts `sub` reads `"<title> · version i of n"`; chats `sub` is the chat title. `showProgress` remains for single-chat ZIP only.
  - `options.signal` = `{ stopped: boolean }`, checked before each chat, each artifact and each version. When set: finish the file in hand, skip viewer/index/manifest writes, skip `saveExportRecord`, in ZIP mode skip `generateAsync`/download; resolve `{ outcome: 'stopped', reason: 'You stopped it', ... }` with `saved` counting what reached the folder (ZIP: all zero).

- [ ] **Step 1: Write failing tests:**
  - `'progress events name the phase in order'`: two chats + one artifact with two versions (helpers `runArtifacts`/`publishedFetcher`), collect events; assert phases appear in order `chats`, `artifacts`, `viewer`; an artifacts event has `sub` matching `/· version \d+ of 2$/`.
  - `'Stop in folder mode keeps files, writes no viewer and no record'` (Review Focus 2): `runFolder` helper, `changesOnly: true`, set `signal.stopped = true` from the first `chats` event with `done === 1`; assert outcome `stopped`, `saved.chats === 1`, folder has no `viewer.html`, `index.md`, `export-manifest.json`, and `chrome.storage.local.set` never received `EXPORT_RECORD_KEY`.
  - `'Stop in ZIP mode downloads nothing'`: same with `zipStub`; assert no download and `saved.chats === 0`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** as in Interfaces.
- [ ] **Step 4: Run** `sh tests/run.sh` — Expected: pass.
- [ ] **Step 5: Commit** "Export All and Export Artifacts report progress and can stop".

### Task 4: Panel view-model functions

**Files:**
- Modify: `popup.js` — new banner section `// ==== Panel screens` before the click handlers
- Test: `tests/screens.test.js`

**Interfaces:**
- Produces (all pure):
  - `formatStamp(iso: string) -> 'YYYY-MM-DD HH:MM'` (local).
  - `exportPlan({ chats: boolean, artifacts: boolean, scope: 'all' | 'changes', hasRecord: boolean }) -> { run: 'bulk' | 'artifacts' | null, changesOnly: boolean, withArtifacts: boolean, changesAllowed: boolean }` — the spec's mapping table; `changesAllowed = hasRecord && chats`; `changesOnly = scope === 'changes' && changesAllowed`; both off → `run: null`.
  - `everythingSummary({ plan, counts, format, since, isPopup }) -> string` where `counts` is `null` or `{ chats, artifacts, changedChats, changedArtifacts, at }`. Exact sentences from the spec's Main section: "Tick Chats or Artifacts.", "27 chats and 19 artifacts." / "3 changed chats and 2 changed artifacts.", "Everything, whatever was exported before." / "Only what changed since the last Export All, <since>.", "Changes only needs Chats ticked." (only when chats off, artifacts on, and hasRecord), folder: "Into a new folder inside one you pick, written as it goes." plus " From the popup, this continues in the sidebar." when `isPopup`, zip: "One ZIP download when it finishes.", and "Nothing changed since <since>." when changes, counted, and both changed counts of the ticked parts are 0.
  - `exportDisabledReason(plan, counts) -> string | ''` — '' when enabled; "Tick Chats or Artifacts." / "Nothing changed since <since>.".
  - `warningGroups(list: [{type,text}], max = 5) -> { lines: string[], more: number }` — group by `type`, line `"<count> <noun phrase> (<first text>)"`; noun phrases per type: `upload` "upload(s) could not be downloaded", `published_page`/`artifact_export` "artifact problem(s)", others "<type> warning(s)"; plural by count.
  - `doneHeadline(result) -> { tone: 'ok' | 'warn', text }` — "Done" or "Done, with N warning(s)".
  - `doneTargetText(result) -> string` — folder: "inside the folder you picked. Open viewer.html in it to browse."; zip: "Saved to Downloads as <name>."
  - `runSteps(plan) -> ('chats' | 'artifacts' | 'viewer')[]` — leaves out unticked parts (artifacts-only: `['artifacts', 'viewer']`).

- [ ] **Step 1: Write failing tests** with exact expected strings, including Review Focus 4 (`exportPlan({chats:false, artifacts:true, scope:'changes', hasRecord:true})` → `run:'artifacts', changesOnly:false, changesAllowed:false`; summary after unticking artifacts has no artifact count) and Review Focus 5 (7 groups → 5 lines, `more: 2`; zero warnings → tone `ok`, text `'Done'`).
- [ ] **Step 2: Run** — Expected: FAIL (not defined).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `node --test tests/screens.test.js` — Expected: pass.
- [ ] **Step 5: Commit** "Panel: summary, export plan and warning text".

### Task 5: Count on demand with a session cache

**Files:**
- Modify: `popup.js` (Panel screens section)
- Test: `tests/screens.test.js`

**Interfaces:**
- Produces: `async countEverything({ org, tabId, withArtifacts }) -> counts` (shape in Task 4) — sends `fetchAllConversations` and, if `withArtifacts`, `listArtifacts`; computes changed counts with `changedSince` / `changedArtifacts` against `loadExportRecord(org)`; caches in `chrome.storage.session` key `takeoutCounts` as `{ [org]: counts }`, reused when `Date.now() - Date.parse(at) < 600000`. `cachedCounts(org) -> counts | null` reads it without network.

- [ ] **Step 1: Write failing tests:** `'countEverything caches for 10 minutes'` (two calls → one `fetchAllConversations`); `'cache older than 10 minutes refetches'`; `'requestData never asks for the chat or artifact list'` (drive `requestData` on a chat URL, assert sent actions ⊆ `{getOrgId, fetchConversation}`).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — pass.
- [ ] **Step 5: Commit** "Panel: count chats and artifacts on demand".

### Task 6: New markup and screens

**Files:**
- Modify: `popup.html` (rewrite body and styles), `sidepanel.html` (byte-identical copy), `popup.js` (`updateUI`, single-chat handlers, settings wiring, keydown, `EXPORT_BUTTONS`; remove `bulkExport`, `exportAllMd`/`exportAllEmbed`/`exportAllJson` handlers)
- Test: `tests/screens.test.js`; rewrite id/label assertions in `tests/export.test.js` (~522, 641, 1531-1542, 3004-3018) and `tests/panel.test.js`; `tests/helpers.js` if element stubs need `dataset`/`hidden`.

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces, element ids (kept): `exportZip`, `exportMd`, `exportMdEmbed` (label "Markdown + files"), `exportJson`, `refresh`, `status` (now the result line inside the chat card), `progress`/`progressFill`/`progressText` (single-chat ZIP only, inside This chat), `filenameStyle`, `includeThinking`, `webImages`, `showShortcuts`, `useSidePanel`, `helpLink`.
  New ids: `chatCard`, `chatTitle`, `chatMeta`, `countBtn`, `scopeAll`, `scopeChanges`, `pickChats`, `pickArtifacts`, `chatsSub`, `chatCount`, `artifactCount`, `formatFolder`, `formatZip`, `exportSelected`, `summary`, `lastExport`, `settingsOpen`, `settingsBack`, `runTitle`, `runTarget`, `runSteps`, `runWarnings`, `stopBtn`, `runStarted`, `doneCard`, `doneSummary`, `doneTarget`, `doneWarnings`, `doneErrorFiles`, `doneBack`, `doneTook`, `stoppedReason`, `stoppedSaved`, `stoppedFix`, `tryAgain`, `stoppedBack`, `handoffNote`, `handoffDismiss`.
  Removed ids: `settingsToggle`, `settingsPanel`, `settingsClose`, `megaFormat`, `megaZipScope`, `exportAllArtifacts`, `info`, `exportAllMd`, `exportAllEmbed`, `exportAllZip`, `exportArtifacts`, `exportAllJson`.
  `showScreen(name: 'main' | 'settings' | 'exporting' | 'done' | 'stopped')` sets `hidden` on `section[data-screen]`; Refresh and Settings buttons disabled on `exporting`. `requestData` repaints only on `main`. `document.body.classList` gets `popup` or `sidebar` from `IS_POPUP` (CSS width 340 px vs fluid).
  `EXPORT_BUTTONS = ['exportMd', 'exportMdEmbed', 'exportZip', 'exportJson', 'exportSelected']`. Settings `exportAllChats` (default `true`) added to `defaultSettings`; `megaZipScope`, `megaFormat`, `exportAllArtifacts` bound to the main-screen controls.
  Card states via `chatCard.dataset.tone = 'ready' | 'warn' | 'error' | 'idle'` with the spec's texts ("Ready to export", "Open a chat to export it", "Open claude.ai to export.", "Couldn't load this chat"); `#status` shows "Saved Markdown, 84 KB" style results (size from the Blob given to `download`) and single-chat errors in the red tone.
  Keyboard: Alt+Z/M/E/J unchanged, Alt+A → `exportSelected`, Alt+R → refresh.

- [ ] **Step 1: Write failing tests:**
  - `'popup.html and sidepanel.html are identical'` (byte compare).
  - `'the page has the new ids and none of the removed ones'` (regex over popup.html for every id in both lists).
  - `'no chat: chat buttons disabled, card idle with the spec text'` and `'not on claude.ai: Export selected disabled too'`.
  - `'a tab change on the Done screen keeps it'` (Review Focus 1): `showScreen('done')`, fire `tabs.onActivated`, wait, assert Done still shown; click `doneBack`, assert `requestData` ran.
  - `'Markdown export reports its size in the card'`: assert `#status.textContent` matches `/^Saved Markdown, \d+(\.\d)? (B|KB|MB)$/`.
  - `'Alt+A clicks Export selected'`.
  - `'Changes only is hidden with no record'`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** markup and CSS from the spec's Screens section and the Global Constraints values; wire `updateUI` to the card; wire the Everything controls to `exportPlan`/`everythingSummary`/`exportDisabledReason`; Export selected → `exportPlan.run` via the existing `folderExport` (Task 7 reworks the handoff), rendering Exporting from `onProgress`, then Done or Stopped from the `RunResult` (`doneHeadline`, `warningGroups`, `formatStamp`); Count shows "Counting…" and is disabled while `countEverything` runs, then "Counted HH:MM"; Stop sets `signal.stopped = true`; Try again reruns the last plan (folder: picker again); a cancelled picker shows "No folder picked." in `#summary` for 5 s. Remove the bulk status-pill writes made redundant by the screens. Footer `lastExport` from `loadExportRecord` ("Last export <stamp> · no warnings" / "· N warnings"; hidden without a record). Settings screen footer "Version <chrome.runtime.getManifest().version>" and "What's new" → `https://github.com/bearspear/claude-takeout#changelog`.
- [ ] **Step 4: Run** `sh tests/run.sh` — Expected: pass.
- [ ] **Step 5: Commit** "Panel redesign: two sections, export screens, settings screen".

### Task 7: Popup → sidebar handoff carries the choices

**Files:**
- Modify: `popup.js` (`folderExport`, the side panel's `folderExportNote` reader; remove `FOLDER_BUTTON_LABELS`, `FOLDER_LABEL_RE`)
- Test: rewrite `'the popup hands … to the side panel'` in `tests/export.test.js` (~3020) into `tests/screens.test.js`

**Interfaces:**
- Consumes: `exportPlan` (Task 4), ids (Task 6).
- Produces: session note `folderExportNote = { at: number, choices: { scope, chats, artifacts, format: 'folder' } }`. The side panel, within 60 s, applies `choices` to the controls, shows `#handoffNote` with "Continued from the popup", "Chrome lets only the sidebar pick a folder. Your choices came along: <All|Changes only>, <chats and artifacts|chats|artifacts>, Folder.", "Click Export selected to pick where it goes.", adds `body.classList` `handoff` (folds This chat, rings Export selected) until `exportSelected` is clicked or `handoffDismiss` is clicked. A note with a bad shape is ignored.

- [ ] **Step 1: Write failing tests:** `'popup folder export stores the choices and opens the side panel'`; `'side panel applies stored choices and runs exportArtifacts for artifacts only'` (Review Focus 3; stub `exportArtifacts`/`bulkExportZip` and assert which ran); `'a malformed note is ignored'`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `sh tests/run.sh` — pass.
- [ ] **Step 5: Commit** "Panel: the sidebar takes over a popup folder export with its choices".

### Task 8: Browser tests

**Files:**
- Modify: `tests/e2e/export.e2e.js` (`#exportAllZip` → `#exportSelected` with ZIP chosen), `tests/e2e/panel.e2e.js`
- Create: none

**Interfaces:**
- Consumes: Task 6 ids.

- [ ] **Step 1:** Update clicks to the new ids; add to `panel.e2e.js`: tick off Artifacts, choose ZIP, click Export selected, wait for the Done screen, assert `#doneCard` text starts with "Done"; press Alt+A on the main screen in folder mode (side panel) and assert the folder picker was requested (stub `showDirectoryPicker` via `page.addInitScript`).
- [ ] **Step 2: Run** `node tests/e2e/export.e2e.js && node tests/e2e/panel.e2e.js` — Expected: pass (needs `playwright-core` + Chromium; if unavailable, record that in the ledger and say so in the final report).
- [ ] **Step 3: Commit** "Browser tests follow the new panel".

### Task 9: Docs and version

**Files:**
- Modify: `manifest.json` (1.22.0), `README.md` (features, shortcuts table, `### v1.22.0` changelog: the new panel, bulk Markdown/Embedded/JSON removed with the pointer to per-chat files, Stop, counts on demand), `USAGE.md` (panel walkthrough, folder handoff), `TECHNICAL.md` (progress emitter, RunResult, record `warnings`), `CLAUDE.md` (§2 popup/sidepanel rows, §3 Panel screens section and removed `bulkExport`, §9 settings shape with `exportAllChats` and record `warnings`, §15 "Add a setting" row)
- Test: existing manifest-vs-changelog test

- [ ] **Step 1: Run** `sh tests/run.sh` after editing — Expected: pass.
- [ ] **Step 2: Commit** "v1.22.0: the new panel".
- [ ] **Step 3:** Ask the owner to reload the unpacked extension and run one real Export selected (ZIP, Changes only) and one single-chat Markdown export; record what they report in the ledger. Do not push.
