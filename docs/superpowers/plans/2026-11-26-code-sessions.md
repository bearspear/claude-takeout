# Code and Cowork sessions in Export All Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Export All saves Cowork sessions (and CLI sessions when a Settings switch is on) as `sessions/<Title>_<shortId>/` folders with a transcript, and the offline viewer lists and shows them, linked to their artifacts.

**Architecture:** A new pure classic script `session-core.js` (loaded in the content script before `content.js`, and in the panel) filters, strips and masks session data, so nothing dropped ever leaves `content.js`. `content.js` gains `listSessions` and a one-page `fetchSessionEvents`. `popup.js` lists sessions at the start of `bulkExportZip`, writes them in a new `runSessionStep` after the artifact step, and records them. `takeout-viewer.js` adapts kept events to the `chat_messages` shape `buildViewerChat` already draws; the viewer adds a Sessions entry, a `#sessions` list page and `#session=<id>` routes.

**Tech Stack:** Chrome MV3, plain JavaScript (classic scripts, `module.exports` under Node), JSZip, Node's test runner, Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-11-26-code-sessions-design.md` (approved 2026-11-26).

## Global Constraints

- Build on `main` after PR #80 (v1.24.3) is merged: rebase `code-sessions` onto it before Task 1. Version `1.25.0` (manifest and README changelog, Task 10).
- Endpoints (same origin, cookies): `GET /v1/code/sessions?exclude_tags=-&limit=100`; `GET /v1/sessions/<cse_id>/events?limit=200[&after_id=<id>]`; headers `anthropic-version: 2023-06-01`, `anthropic-beta: ccr-byoc-2025-07-29`, `x-organization-uuid: <org>`. `/v1/sessions/<cse_id>` (details) is never called.
- Kept session fields: `id`, `title`, `status_bucket`, `environment_kind`, `config.origin`, `config.model`, `created_at`, `updated_at`, `last_event_at`, `external_metadata.artifacts[]` (`artifact_id`, `title`, `updated_at`). Nothing else.
- Kept events: `user`/`assistant` (`uuid`, `created_at`, `parent_tool_use_id`, `message.role`, `message.model`, `message.content`), `result` (`uuid`, `created_at`, `is_error`, `num_turns`, `duration_ms`, `total_cost_usd`, `subtype`), `system` with `subtype: 'compact_boundary'` (`uuid`, `created_at`, `subtype`). All else dropped.
- Never written: `session_context`, headers, `env_manager_log`, other `system` subtypes, control events, `tags`, `url`, `session_url`, `<system-reminder>` spans.
- Mask (replace with `[masked]`): `sk-ant-…`, `ghp_…`, `gho_…`, `github_pat_…`, `AKIA[0-9A-Z]{16}`, `xox[bp]-…`, `Bearer <20+ token chars>`, `-----BEGIN … PRIVATE KEY----- … -----END … PRIVATE KEY-----`.
- Limits: event stub over 2 MB (`{ uuid, created_at, type, stub: 'too large (N MB)' }`); 100 pages of 200 per session; 64 MB of kept events per session; ZIP-mode total 256 MB; image over 5 MB left out; transcript and viewer tool results cut at 2 KB.
- Setting `exportCliSessions`, default `false`, label "Include Claude Code CLI sessions". Off: `environment_kind === 'bridge'` sessions get no events request and are counted as left out.
- Record: `exportRecord[org].sessions[<cse_id>] = last_event_at`.
- Warning type `session`: codes only, never response text, URLs or tokens.
- Synthetic fixtures only; never real session data in the repo. Never edit owner export folders.
- Unchanged: the chat export, the viewer's CSP, sandboxing and `sanitizeHtml`. `popup.html` and `sidepanel.html` stay byte-identical.

## Review Focus

1. A tool result holding a secret shape inside a larger text (an `env` dump with `GITHUB_TOKEN=ghp_…`) is masked in `session.json`, `transcript.md`, the viewer and search — Task 1 test `maskSecrets masks tokens inside larger text`.
2. A Changes only run where only a Cowork session changed exports it, writes a viewer and records it — Task 5 test `Changes only exports a session-only change`.
3. A user message that is only a `<system-reminder>` vanishes; one with a reminder and a prompt keeps only the prompt — Task 1 test `stripSystemReminders drops reminder-only messages`.
4. The list endpoint failing (HTTP 403 after an API change) leaves chats and artifacts exported with one `session` warning — Task 5 test `a failed session list is one warning and the chats export`.
5. A session title with Markdown or HTML (`[x](javascript:…)`, `<img onerror>`) is text in README, index.md, the list page and the top bar — Task 4 test `sessionReadmeMd escapes titles` and Task 8 e2e check `a hostile title is text`.

---

### Task 1: `session-core.js`, the pure filter

**Files:**
- Create: `session-core.js`
- Modify: `manifest.json` (content_scripts `js: ["session-core.js", "content.js"]`), `popup.js:4847` (`executeScript` files `['session-core.js', 'content.js']`), `popup.html` and `sidepanel.html` (a `<script src="session-core.js">` before `export-core.js`)
- Test: `tests/session.test.js` (new; `tests/run.sh` already runs `tests/`)

**Interfaces:**
- Produces (on `globalThis.CTSession`, and `module.exports`): `stripSystemReminders(text: string) -> string`, `maskSecrets(text: string) -> string`, `keepSession(raw: object) -> object | null` (null without a string `id` starting `cse_`), `keepSessionEvent(raw: object) -> object | null` (null when dropped; strips reminders from user text, masks every text string in `message.content` recursively including `tool_result` content and `tool_use.input` string values, turns a string `content` into `[{ type: 'text', text }]`, drops a user event left with no blocks, applies the 2 MB stub by `JSON.stringify` length in UTF-8 bytes), `sessionPage(raw: { data, has_more, last_id }) -> { events: object[], lastId: string | null, hasMore: boolean }` (`lastId`/`hasMore` from the raw page), constants `EVENT_STUB_BYTES = 2 * 1024 * 1024`, `SESSION_PAGE_LIMIT = 200`.

- [ ] **Step 1: Write the failing tests** in `tests/session.test.js`:
  - `keepSession keeps only the listed fields`: input with `tags`, `session_context`, `external_metadata.artifacts[0].url`, `config.mcp_connector_ids` → output deep-equals the kept shape only.
  - `keepSessionEvent drops machinery`: `env_manager_log`, `control_request`, `rate_limit_event`, `system`/`init`, `autocompact_state` → `null`; `system`/`compact_boundary` → `{ uuid, created_at, subtype }`; `result` keeps its 7 fields only.
  - `stripSystemReminders drops reminder-only messages`: `'<system-reminder>cwd /x</system-reminder>'` → `''` and the user event → `null`; `'hi <system-reminder>a\nb</system-reminder> there'` → `'hi  there'`; a reminder inside a `tool_result` text is kept (it is tool output) — assert unchanged.
  - `maskSecrets masks tokens inside larger text`: one assertion per shape in Global Constraints, each embedded in surrounding text (`'GITHUB_TOKEN=ghp_' + 'a'.repeat(36) + '\nPATH=/bin'` → `'GITHUB_TOKEN=[masked]\nPATH=/bin'`); `'Bearer short'` unchanged; a PEM block → `'[masked]'`.
  - `keepSessionEvent masks tool results and inputs`: a `tool_result` text and a `tool_use.input.command` with `sk-ant-…` come out masked.
  - `keepSessionEvent stubs an event over 2 MB`: a 2.1 MB text → `{ uuid, created_at, type, stub: 'too large (2.1 MB)' }`.
  - `sessionPage takes lastId and hasMore from the raw page`: last raw item an `env_manager_log` (no uuid) with `last_id: 'e9'` → `lastId === 'e9'`, events exclude it.
- [ ] **Step 2: Run** `node --test tests/session.test.js` — Expected: FAIL, `Cannot find module '../session-core.js'`.
- [ ] **Step 3: Implement `session-core.js`** as a classic script like `export-core.js` (top-level declarations, `globalThis.CTSession = {...}`, `module.exports` under Node). No DOM, no fetch.
- [ ] **Step 4: Run** `node --test tests/session.test.js` then `sh tests/run.sh` — Expected: PASS; `screens.test.js` still finds the two pages identical.
- [ ] **Step 5: Commit** `session-core.js manifest.json popup.js popup.html sidepanel.html tests/session.test.js` — "Sessions: session-core.js keeps, strips and masks session data".

### Task 2: `content.js` actions and the shared retry

**Files:**
- Modify: `content.js` (the PR #80 retry in `fetchConversation`; the `onMessage` switch near `request.action === 'fetchConversation'`)
- Test: `tests/panel.test.js` (extend `contentWith` to load `session-core.js` then `content.js` in one context)

**Interfaces:**
- Consumes: Task 1 `CTSession.keepSession`, `CTSession.sessionPage`, `SESSION_PAGE_LIMIT`.
- Produces: `fetchWithRetry(url, init) -> Response` (429/5xx up to 3 retries, Retry-After ≤ 30 s else `[2000, 5000, 10000]`, waits through `publishedDelay`), used by `fetchConversation` and both new actions. Action `listSessions` → `{ sessions: object[] (kept), incomplete: boolean (reply had a resume_token), orgId }` or `{ error: 'HTTP <n>' | 'network' | 'bad response' }`. Action `fetchSessionEvents` `{ id, after }` → `{ events, lastId, hasMore }` or `{ error }`. `id` must match `/^cse_[A-Za-z0-9]+$/` else `{ error: 'bad id' }`. Org by the same rule `fetchAllConversations` uses.

- [ ] **Step 1: Write the failing tests** in `tests/panel.test.js`:
  - `listSessions sends the session headers and keeps only kept fields`: fake fetch records `init.headers`; assert the three headers, the URL `/v1/code/sessions?exclude_tags=-&limit=100`, and no `session_context` in the reply.
  - `listSessions says a list with a resume token may be incomplete`.
  - `fetchSessionEvents asks one page of 200 after the given id`: URL ends `&after_id=e5`; reply `{ events, lastId, hasMore }`.
  - `fetchSessionEvents refuses a bad id`: `'../x'` → `{ error: 'bad id' }`, no fetch.
  - `session requests retry a 429 like chats`: 429 then 200 → success, 2 fetches.
  - `a failed session request answers with a code only`: 500×4 → `{ error: 'HTTP 500' }`; the error string has no URL.
- [ ] **Step 2: Run** `node --test --test-name-pattern="listSessions|fetchSessionEvents|session requests|failed session" tests/panel.test.js` — Expected: FAIL (no such action: the callback gets no reply / undefined).
- [ ] **Step 3: Implement** `fetchWithRetry` (move the loop out of `fetchConversation`), `listSessions`, `fetchSessionEvents` in `content.js`.
- [ ] **Step 4: Run** the same command, then `sh tests/run.sh` — Expected: PASS, including the v1.24.3 `fetchConversation tries a 429 or 5xx again` test.
- [ ] **Step 5: Commit** — "Sessions: content.js lists sessions and pages their events".

### Task 3: Record, plan and setting helpers (pure, `popup.js`)

**Files:**
- Modify: `popup.js` — `recordableExport` (~5035), `saveExportRecord` (~5093), `defaultSettings`/`loadSettings`/`applySettings` (~7386), `runSteps`, `runTitleText`, `savedText` (~6692-6745), `WARNING_NOUNS` (~6639), `ExportErrorCollector._getRecoveryHint` (~91); `popup.html` + `sidepanel.html` (Settings switch `#exportCliSessions` with hint "Their tool output can contain text from your computer.", and `<li id="step-sessions">` in the Exporting steps between artifacts and viewer)
- Test: `tests/screens.test.js`, `tests/export.test.js`

**Interfaces:**
- Produces: `changedSessions(list: object[], recorded: object | undefined) -> object[]` (by `last_event_at`; all when `recorded` is not an object); `sessionsToFetch(list, settings) -> { fetch: object[], leftOut: number }` (`bridge` left out unless `settings.exportCliSessions === true`); `recordableExport(chats, artifacts, writeFailures, versions, sessions = [])` returns also `sessions` (each `{ id, last_event_at, folder }`, dropped on a write failure under `folder`); `saveExportRecord(org, at, chats, artifacts, versions, warnings, sessions = [])` keeps and joins `sessions` like `chats`; `runSteps(plan)` includes `'sessions'` after `'artifacts'` when `plan.run === 'bulk'`; `runTitleText(plan, totals)` and `savedText(result, plan)` name sessions only when `totals.sessions` / `result.saved.sessions` is a number > 0 ("29 chats, 3 sessions and 20 artifacts"); `WARNING_NOUNS.session = ['session problem', 'session problems']`; a `session` case in `_getRecoveryHint`.

- [ ] **Step 1: Write the failing tests:**
  - `changedSessions takes new and changed sessions`: recorded `{ cse_a: 't1' }`; list `[cse_a@t1, cse_b@t1]` → `[cse_b]`; list `[cse_a@t2]` → `[cse_a]`; recorded `undefined` → the whole list.
  - `sessionsToFetch leaves CLI sessions out unless the setting is on` (`bridge` + `anthropic_cloud`: off → fetch 1, leftOut 1; on → fetch 2, leftOut 0).
  - `saveExportRecord keeps sessions and joins them` (old `{cse_a:'t1'}` + new `cse_b` → both; an entry without sessions keeps none).
  - `recordableExport drops a session with a write failure`.
  - `savedText and runTitleText name sessions` (exact strings: `'29 chats, 3 sessions and 20 artifacts (40 versions)'`; with 0 sessions the v1.24 strings unchanged).
  - `runSteps lists sessions for a bulk run`.
  - `the Settings switch for CLI sessions saves and loads` (default `false`; click → `settings.exportCliSessions === true` stored).
  - `every warning type has a recovery hint and a noun` (extend the existing check to `session`).
- [ ] **Step 2: Run** `node --test tests/screens.test.js tests/export.test.js` — Expected: the new tests FAIL (`changedSessions is not defined`, string mismatches).
- [ ] **Step 3: Implement** the helpers and markup (copy `popup.html` to `sidepanel.html` after editing).
- [ ] **Step 4: Run** `sh tests/run.sh` — Expected: PASS (pages identical, colour check passes).
- [ ] **Step 5: Commit** — "Sessions: record, plan, setting and panel sentences".

### Task 4: Transcript, README and images (pure, `export-core.js`)

**Files:**
- Modify: `export-core.js` (new section "Code and Cowork sessions", exported like the rest)
- Test: `tests/session.test.js`

**Interfaces:**
- Consumes: kept events (Task 1 shape).
- Produces:
  - `sessionImages(events) -> { events: object[], images: [{ name, base64 }], skipped: number }`: each base64 image (top-level or in a `tool_result`), PNG/JPEG/GIF/WebP by leading bytes, ≤ 5 MB decoded, becomes `{ type: 'image', file: 'images/<n>.<ext>' }` in a copy of the events (n from 1); others become `{ type: 'image', missing: 'not saved (<reason>)' }`.
  - `promptKind(text) -> 'prompt' | 'compaction' | 'command' | 'command-output'` (`/^This session is being continued from a previous conversation/`, `<command-name>`, `<local-command-stdout>`).
  - `sessionTranscriptMd(session, events) -> string` (no BOM; the writer adds it via `addFileWithBOM`): title, dates, origin, model; per turn the prompt (labelled per `promptKind`), reply text, "Thought process" fences, one line per tool step with a fenced input and result cut at 2048 chars plus `[… N more characters in session.json]`, images as `![](images/<n>.<ext>)`, "— Conversation compacted —" per `compact_boundary`; fences via `getCodeFence`.
  - `sessionReadmeMd(session, events, artifactLinks) -> string`: `artifactLinks` = `[{ uuid, title, href | null }]`, `href` relative (`../../artifacts/<folder>/`) or null → claude.ai link `https://claude.ai/artifact/<uuidToBase58(uuid)>`; counts of turns and tool calls; cost when a `result` has `total_cost_usd`.
  - `sessionShortId(id) -> string` (`id` without `cse_`, last 12 chars).

- [ ] **Step 1: Write the failing tests:** `sessionImages saves PNG and JPEG by leading bytes and skips others`; `sessionImages leaves out an image over 5 MB`; `promptKind labels compaction, commands and output`; `sessionTranscriptMd cuts a long tool result at 2 KB`; `sessionTranscriptMd marks a compaction`; `sessionReadmeMd links artifacts in the export and on claude.ai`; `sessionReadmeMd escapes titles` (a title `[x](javascript:alert(1)) <img onerror=1>` appears escaped through `mdLinkText`, no raw `](javascript:`).
- [ ] **Step 2: Run** `node --test tests/session.test.js` — Expected: FAIL (`sessionImages is not a function`).
- [ ] **Step 3: Implement** in `export-core.js`.
- [ ] **Step 4: Run** `sh tests/run.sh` — Expected: PASS; `tests/fixtures/export-baseline.json` unchanged (no chat output changed).
- [ ] **Step 5: Commit** — "Sessions: transcript, README and images".

### Task 5: The export (`bulkExportZip` and `runSessionStep`)

**Files:**
- Modify: `popup.js` — `bulkExportZip` (~5238-5640), `usedFolderNames` (~5311), a new `runSessionStep` after `runArtifactStep`, `index.md` lines, `export-manifest.json`
- Test: `tests/screens.test.js` (extend `bulkRun`'s fake `sendMessage` with `listSessions`/`fetchSessionEvents`)

**Interfaces:**
- Consumes: Task 2 actions (through `sendToTab`), Task 3 helpers, Task 4 builders.
- Produces: `runSessionStep(root, { sessions, artifactFolders: Map<uuid, folder>, fetchPage: (id, after) -> Promise<reply>, signal, run: boolean, budget: number, onProgress: (done, total, sub) }) -> Promise<{ saved: [{ id, last_event_at, folder }], rows: [{ title, folder, origin, last_event_at, turns }], warnings: string[], stopped: boolean }>`. Each session: pages while `hasMore` (≤ 100 pages, ≤ 64 MB), writes `sessions/<folder>/session.json` (`{ format: 1, session, events }`, images as references), `transcript.md` and `README.md` with BOM, `images/<n>.<ext>`; `root.flush()` after each when `run` (folder mode). Folder names claimed case-insensitively against `usedFolderNames` and each other. `saved` excludes capped, failed and stopped sessions. In `bulkExportZip`: `listSessions` right after `listArtifacts` when `plan.run === 'bulk'`; `includedSessions = since ? changedSessions(...) : list` then `sessionsToFetch`; the early return requires no included sessions; totals include `sessions`; `tabGone` skips sessions (the warning text adds ", and no sessions"); `stoppedRun` sets `saved.sessions`; `viewerWanted` true with a saved session; the record gets `sessions`; `index.md` gets "## Sessions" (title, origin, last activity, turns) and "CLI sessions not exported: N (Settings, Include Claude Code CLI sessions)" when N > 0; the manifest gets `sessions: { listed, leftOut, items: [{ id, title, folder, last_event_at }] }`; the phase `'sessions'` is emitted.

- [ ] **Step 1: Write the failing tests:**
  - `Export All writes a Cowork session folder`: one chat + one `anthropic_cloud` session with a prompt, a reply, a tool step and a PNG → ZIP has `sessions/<Title>_<shortId>/session.json`, `transcript.md` (BOM), `README.md`, `images/1.png`; `session.json` has no base64; `result.saved.sessions === 1`.
  - `a CLI session is left out unless the setting is on`: no `fetchSessionEvents` call for it; `index.md` says `CLI sessions not exported: 1`; with the setting on it is exported.
  - `Changes only exports a session-only change`: record with chats and the session at an older `last_event_at`, no chat or artifact changed → outcome `done`, the session folder and `viewer.html` written, record updated.
  - `a failed session list is one warning and the chats export` (reply `{ error: 'HTTP 403' }`).
  - `a session list that may be incomplete is warned` (reply `{ sessions: [...], incomplete: true }` → one `session` warning naming it, the listed sessions still exported).
  - `a session over 100 pages is warned and not recorded`.
  - `Stop during sessions records none`; `a gone tab skips sessions`.
  - `a chat titled "sessions" gets sessions_2`.
  - `session folders are flushed one by one in folder mode` (FakeDir flush count ≥ sessions).
- [ ] **Step 2: Run** `node --test --test-name-pattern="session" tests/screens.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `sh tests/run.sh` — Expected: PASS, including every existing bulk test.
- [ ] **Step 5: Commit** — "Sessions: Export All writes and records sessions".

### Task 6: Viewer data (`takeout-viewer.js`, `writeViewer`)

**Files:**
- Modify: `takeout-viewer.js` (`buildViewerChat`: a top-level `image` content block → `{ t: 'image', href }`; `buildViewerData` gains `sessions`), `popup.js` `writeViewer` (~514, pass `opts.sessions`; viewer also wanted with sessions only), `bulkExportZip` (collect `buildViewerSession` results)
- Test: `tests/viewer.test.js`

**Interfaces:**
- Consumes: Task 4 `sessionImages` output (events with `{ type: 'image', file }`).
- Produces: `CTViewer.buildViewerSession(session, events, { folder }) -> { id, title, origin, created, updated, folder, artifacts: string[], chat }` where `chat` is `buildViewerChat` of an adapted `{ uuid: session.id, name: title, created_at, updated_at, chat_messages, current_leaf_message_uuid }`: user/assistant events in order, each message's parent the one before, `sender` from `message.role`, labelled prompts as a text block prefixed by a marker the viewer reads (`labelled: 'compaction' | 'command' | 'command-output'` on the message), tool results cut at 2048 chars with `[… full output in session.json]`, images through `ctx.toolImages` (`{ 'img-<n>': 'images/<n>.<ext>' }`, `ctx.folder = 'sessions/<folder>'`), `parent_tool_use_id` messages attached under the matching `Agent` tool block as `children`. `buildViewerData(chats, { exported, artifacts, sessions })` sets `data.sessions` (newest `updated` first). `ViewerData.sessions[i].chat` has no `project`.

- [ ] **Step 1: Write the failing tests:** `buildViewerSession makes a single-branch chat`; `buildViewerSession cuts tool results at 2 KB`; `buildViewerSession shows images from their files, never data URIs` (no `data:` in the JSON); `buildViewerSession labels a compaction and a command`; `buildViewerSession puts subagent messages under their Agent step`; `buildViewerData keeps sessions apart from chats` (chats count unchanged, `data.sessions.length === 2`); `a chat's top-level image block shows from its saved file`.
- [ ] **Step 2: Run** `node --test tests/viewer.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `sh tests/run.sh` — Expected: PASS.
- [ ] **Step 5: Commit** — "Sessions: viewer data".

### Task 7: Viewer logic (routes and search)

**Files:**
- Modify: `viewer/viewer-logic.js` — `parseHash`/`formatHash` (~94/114), `parseListHash` (~1446), `buildSearchIndex`
- Test: `tests/viewer.test.js`

**Interfaces:**
- Produces: `parseHash('#session=cse_ab&msg=u1') -> { session: 'cse_ab', msg: 'u1' }` and `formatHash({ session, msg })` round-trip (a `session` state never carries `chat`); `parseListHash('#sessions') -> { page: 'sessions' }`; `buildSearchIndex(chats, sessions = [])` adds entries `{ chat: null, session: id, msg, … }` for session titles, prompts and replies; `searchChats` hits carry `session`; `groupHits` groups by `session || chat` and sets `g.session = true` for session groups.

- [ ] **Step 1: Write the failing tests:** `session hashes round-trip`; `parseListHash reads #sessions`; `search finds a session prompt and groups it as a session`; `search never finds tool output in a session` (a word only in a `tool_result` → no hit).
- [ ] **Step 2: Run** `node --test tests/viewer.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `sh tests/run.sh` — Expected: PASS (existing hash and search tests unchanged).
- [ ] **Step 5: Commit** — "Sessions: routes and search".

### Task 8: Viewer UI and e2e

**Files:**
- Modify: `viewer/viewer-template.html` (`#sessions-nav` button with class `nav` after `#chats-nav`; styles for the session label and labelled prompts), `viewer/viewer-app.js` (sidebar entry, `#sessions` list page on the lists screen, `#session=` opening a session in the chat area through `renderChat` with its `chat`, fold bar "Session · <origin>" with artifact links, top-level image blocks, labelled prompts, search result groups labelled "Session"), `viewer/artifacts-app.js` ("Made in session <title>" linking `#session=<id>`, joined from `data.sessions[].artifacts`)
- Create: `tests/e2e/sessions.e2e.js` (a viewer from `make-viewer.js` with 3 chats and 2 synthetic sessions, one with a hostile title, one artifact made in a session)
- Test: also run `projects`, `viewer`, `search`, `combined` e2e

**Interfaces:**
- Consumes: Task 6 data, Task 7 routes and search.
- Produces: nothing later tasks use.

- [ ] **Step 1: Write the failing e2e** `tests/e2e/sessions.e2e.js` checks: `the Sessions entry shows with its count`; `#sessions lists sessions newest first and filters`; `a session opens with its title, folded thinking and a tool step cut at 2 KB`; `its image loads from sessions/<folder>/images`; `a compaction and a command are labelled, not shown as prompts`; `the fold bar links its artifact, and the artifact links back`; `search finds a session prompt, labelled Session, and opens it at the message`; `a hostile title is text`; `sessions are not in Recents or All chats`; `Back from a session returns to #sessions`; `no network, no page error`.
- [ ] **Step 2: Run** `PW=… CHROME_EXE=… node tests/e2e/sessions.e2e.js` — Expected: FAIL (`#sessions-nav` not found).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** sessions, projects, viewer, search, navigation e2e — Expected: all passed; `combined.e2e.js` only its 3 known failures (navhttps, navdata, navblob).
- [ ] **Step 5: Commit** — "Sessions: Sessions entry, list page and session view".

### Task 9: Archive tools

**Files:**
- Modify: `tools/archive-lib.js` (`KNOWN_DIRS` gains `'sessions'`; a reader `readSessions(root) -> [{ session, events, folder }]` of `sessions/*/session.json`, `format: 1` only, through `realDirUnder`), `tools/build_viewer.js` (passes sessions to the viewer), `tools/merge_archives.js` (`sessions` in `used`; copies each session folder from the source with the newest `last_event_at`; manifest `sessions`)
- Test: `tests/archive.test.js`, `tests/merge.test.js`

**Interfaces:**
- Consumes: Task 6 `buildViewerSession`.

- [ ] **Step 1: Write the failing tests:** `scanAdded ignores sessions/`; `build_viewer keeps an archive's sessions`; `merge takes the newest copy of a session`; `a session.json of another format is skipped with a note`.
- [ ] **Step 2: Run** `node --test tests/archive.test.js tests/merge.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `sh tests/run.sh` and `node tests/e2e/archive.e2e.js` (with PW/CHROME_EXE) — Expected: PASS.
- [ ] **Step 5: Commit** — "Sessions: old-archive tools keep and merge sessions".

### Task 10: Mock claude.ai, docs, version

**Files:**
- Modify: `tests/e2e/export.e2e.js` (mock serves `/v1/code/sessions` and two pages of events for one Cowork and one CLI session), `README.md` (v1.25.0 changelog), `manifest.json` (`1.25.0`), `USAGE.md` (what is exported and not; the CLI switch and its warning; masking is best effort), `TECHNICAL.md` (endpoints, kept fields, stripping and masking, layout, record), `CLAUDE.md` (§2 `session-core.js` and `tests/session.test.js`/`sessions.e2e.js` rows, §7 layout, §8 endpoints, §9 record and setting, §11 `session`)
- Test: `tests/e2e/export.e2e.js`

- [ ] **Step 1: Write the failing e2e check** in `export.e2e.js`: `Export All saves the Cowork session and leaves the CLI one out` (folder present; `index.md` line `CLI sessions not exported: 1`).
- [ ] **Step 2: Run** `node tests/e2e/export.e2e.js` (with PW/CHROME_EXE) — Expected: FAIL before the mock routes exist / PASS after.
- [ ] **Step 3: Write the docs and bump the version.**
- [ ] **Step 4: Run** `sh tests/run.sh` (the version test checks README against the manifest) and `export.e2e.js`, `panel.e2e.js` — Expected: PASS.
- [ ] **Step 5: Commit** — "v1.25.0: Code and Cowork sessions in Export All".

### Task 11: A Sessions checkbox (owner's change)

**Files:**
- Modify: `popup.html` + `sidepanel.html` (main screen: `#pickSessions` checkbox after `#pickArtifacts`, title "Sessions", sub "Claude Code and Cowork", and under it `#exportCliSessions` "Include CLI sessions (run on your computer)" moved from the Settings screen), `popup.js` (`defaultSettings.exportAllSessions = true`; `exportPlan`, `currentPlan`, `exportDisabledReason`, `everythingSummary`, `renderEverything`, `handoffChoices`/`handoffFrom`/`takeHandoff` carry `sessions`; `runSelected` passes `withSessions`; `bulkExportZip` honours `options.withChats` and `options.withSessions`), docs (README v1.25.0 entry, USAGE, TECHNICAL, CLAUDE.md §9)
- Test: `tests/screens.test.js`, `tests/e2e/panel.e2e.js` if it pins the main screen

**Interfaces:**
- `exportPlan(choices)`: `run: 'bulk'` when Chats or Sessions is ticked; plan gains `withChats: boolean`, `withSessions: boolean`. Nothing ticked → disabled as today ("Tick Chats, Artifacts or Sessions").
- `bulkExportZip({ withChats, withArtifacts, withSessions, ... })`: `withChats === false` → no chat list request and no chat folders (index.md says chats were not chosen); `withSessions === false` → no `listSessions` request, no session step, no Sessions row, no record change for sessions. Defaults: `true` (existing callers unchanged).
- The CLI sub-checkbox is disabled while Sessions is unticked; its value persists in `settings.exportCliSessions`.
- The handoff note's choices gain `sessions: boolean` (an older note without it means `true`).

- [ ] **Step 1: Write the failing tests:** `exportPlan maps Sessions`; `Sessions unticked: no listSessions request and no Sessions row`; `Sessions alone exports sessions without asking for chats`; `the CLI sub-option is under Sessions, disabled when Sessions is unticked, and saved`; `the Settings screen no longer has the CLI switch`; `the summary names sessions`; `a handoff note carries sessions (missing means true)`; pages stay identical.
- [ ] **Step 2: Run** `node --test tests/screens.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `sh tests/run.sh`, and export, panel, sessions e2e (env inline) — Expected: PASS.
- [ ] **Step 5: Commit** — "Sessions: their own checkbox on the main screen".

### Before Task 1 (controller, read-only)

Re-check the endpoints on the owner's account from the browser, structure only: the list and events still answer as in the spec, and whether the list continues with `resume_token` (a query parameter name). If the list continues, add that loop to Task 2's `listSessions` (≤ 20 pages) in place of the `incomplete` flag, and ledger it as a ruling.
