# Claude Code and Cowork sessions in Export All (v1.25.0)

Status: draft for the owner's approval. Written 2026-11-26. The owner skipped the questions; every choice marked "My call" is mine and open to change. A builder check and a critical review are done and folded in. The owner chose how CLI sessions are handled (below).

Depends on v1.24.3 (PR #80: the chat fetch retry and the Export All prefetch); build on main after it merges.

## Why

Export All saves every chat claude.ai lists, but Claude Code sessions (run from the CLI with remote control) and Cowork sessions (from the desktop app) are not in that list, and claude.ai's chat API answers 404 for them, even though they open at a `claude.ai/chat/<uuid>` address. Their artifacts are exported (with `sourceSurface: code`), the conversations that made them are not. The owner noticed this on "Takeout Panel Refresh": the artifact was in the export, its session was not.

## What we know (read-only study, 2026-11-26, three sessions on the owner's account)

- **List**: `GET /v1/code/sessions?exclude_tags=-&limit=100` with headers `anthropic-version: 2023-06-01`, `anthropic-beta: ccr-byoc-2025-07-29`, `x-organization-uuid: <org>` (cookies included). Reply `{ data, resume_token }`. Each session: `id` (`cse_…`), `title`, `status`, `status_bucket`, `environment_kind` (`bridge` for a CLI session, `anthropic_cloud` for Cowork), `config.origin` (`claude_code_cli`, `desktop_app`), `created_at`, `updated_at`, `last_event_at`, `tags`, `external_metadata`. The `exclude_tags` parameter is required (without it the list is empty).
- **Artifacts**: `external_metadata.artifacts[]` is `{ artifact_id, kind: "frame", title, updated_at, url }`, where `artifact_id` is the artifact's uuid (its slug). Cowork tags also carry `frame-artifact:<uuid>`. This links a session to its artifacts exactly.
- **Details**: `GET /v1/sessions/<cse_id>` adds `session_context` (with connector request headers), `bound_device`, `active_mount_paths`, `github_access`, `session_url` and more. The export doesn't call it.
- **Events**: `GET /v1/sessions/<cse_id>/events?limit=<n>[&after_id=<last_id>]`, reply `{ data, first_id, has_more, last_id }`. Oldest first, unique `uuid`s. Sizes seen: 41 events (146 KB), 97 events (229 KB), 8,227 events in 9 pages of 1000 (30 MB).
- **Event types**: `user`, `assistant` (with `message`, a standard Claude message: blocks `text`, `thinking`, `tool_use`, `tool_result` with text, image or tool_reference items, `image`; a user message's content may also be a plain string), `system` (subtypes `init`, `status`, `task_started`, `task_updated`, `task_notification`, `background_tasks_changed`, `compact_boundary`, `code_change_published`, `session_metadata`, `turn_handoff_available`, `worker_shutting_down`), `result` (per-turn stats, cost), `control_request`/`control_response`/`control_cancel_request`, `rate_limit_event`, `autocompact_state`, `env_manager_log` (`category, content, extra, level, timestamp`; no `uuid`).
- **Tools seen**: Bash (most), Agent, Edit, Read, Write, SendMessage, Artifact, Skill, ToolSearch, AskUserQuestion, MCP tools. Tool results reach 620 KB; images occur in user messages and tool results.
- **Not found**: where the `/chat/<uuid>` address maps to a session. It is in none of the three endpoints. Not needed (artifacts link by id).

All three endpoints are on `claude.ai`, same origin as the chat API, so `content.js` fetches them with the existing `https://claude.ai/*` host permission and cookies; the extra headers need nothing new. They are undocumented and may change without notice. How the list continues past one page (`resume_token`) wasn't seen (one page on the owner's account); the pre-build check tries it, and until it is known a reply with a `resume_token` the export can't follow warns that the list may be incomplete.

## Goals

1. Export All (Chats ticked) also saves each Cowork session, and each CLI session when the Settings switch is on: its kept events, a readable transcript, a README.
2. The viewer lists sessions and shows a session's transcript: prompts, replies, thinking (folded), tool steps (folded, as chat steps are), images.
3. An artifact made in a session links to it, and the session lists its artifacts, both ways, in the files and in the viewer.
4. Changes only takes a session again only when it changed, also when nothing else changed.
5. The session's settings and machinery never leave claude.ai: connector settings and headers, environment logs, startup details and control messages are never written. What the conversation itself holds (prompts, replies, tool output) is written as a chat's is, with the protections in "What a transcript holds"; USAGE says plainly that a session's tool output can include text from the machine it ran on.

## CLI sessions (the owner's decision)

A **CLI session** (`environment_kind: bridge`) runs on the owner's own computer: its tool results can hold whatever Claude read or ran there (a `.env`, `env` or `gh auth status` output, files under `~/.ssh`), and its user messages carry `<system-reminder>` text (CLAUDE.md, memory, working folder, git status). A chat on claude.ai and a **Cowork session** (`anthropic_cloud`) run in a sandbox instead. Options:

- **A. Cowork only in v1.** CLI sessions are listed in the README as not exported. Safest; the "notebook" session would be missing.
- **B. Both, with protections** (below: system reminders stripped, known token patterns masked, a USAGE warning). Complete, but masking is best effort.
- **C. Both, CLI ones only with a setting** in Settings, off by default.

**Owner's choice: C.** Cowork sessions are always exported. CLI sessions only with the Settings switch **Include Claude Code CLI sessions** (`settings.exportCliSessions`, default `false`), with the protections in "What a transcript holds". With the switch off, CLI sessions are not fetched at all (no events request); the export's README and `index.md` say how many were left out and how to include them. The switch's hint says their tool output can contain text from your computer.

## Non-goals

- Rebuilding the files a session wrote (the `_vN` replay chats get). The transcript shows each Write and Edit as a step; artifacts published from the session are already exported. *(My call: transcript only first.)*
- Sessions in a single-chat export, or the popup's This chat card on a session page.
- Sessions of other people, archived sessions the list doesn't return, and Claude Code sessions that never connected to claude.ai (local only).
- Search inside tool results (as for chats: search reads prompts, replies and names).
- Reaching a session from its `claude.ai/chat/<uuid>` address: that mapping wasn't found. Sessions are reached from the Sessions list, search and artifact links. *(My call.)*

## Anti-goals

- Never written: `session_context`, request headers, `env_manager_log`, `system` events other than `compact_boundary`, control requests and responses, `tags`, `url`, `session_url`. If a field isn't on the kept list, it isn't written.
- A failure of the session endpoints never fails or slows the chats: it is one warning, and the export goes on.
- No change to the chat export, the viewer's CSP, sandboxing or `sanitizeHtml`.

## Owner's change (2026-11-26, after the build): a Sessions checkbox

Sessions get their own choice on the main screen, replacing "sessions come with the Chats box": a third checkbox **Sessions** ("Claude Code and Cowork") under Artifacts, on by default (`settings.exportAllSessions`, default `true`), with the CLI switch moved under it as a sub-option "Include CLI sessions (run on your computer)" (`settings.exportCliSessions`, default `false`, disabled while Sessions is unticked; removed from the Settings screen). Sessions can be exported alone. Where the sections below say "with the Chats box ticked", read "with the Sessions box ticked".

## The export

### Order in `bulkExportZip`

`listSessions` is called at the start, next to `listArtifacts`, so a run knows its sessions up front: the plan's totals, the Changes only early return ("Nothing changed since …" only when no chat, artifact **or session** changed), `viewerWanted` (true with a saved session), and the record condition all count sessions. The sessions' events are fetched after the artifact step and before the viewer, so a session's README knows the artifacts' folders. A failed list is one `session` warning and no sessions; the run goes on. *(My call: no new checkbox; sessions come with the Chats box.)* Export Artifacts (Artifacts only) doesn't fetch sessions.

**Stop** is checked before each session and between its pages; a stopped run records no session, and `stoppedRun` counts `saved.sessions` (zero in ZIP mode, as for chats). **A gone tab** (`tabGone`) skips the sessions as it skips the artifact step, and the tab-gone warning says so.

### The panel

The setting joins `defaultSettings`, `loadSettings`, `applySettings` and the Settings screen of `popup.html` (copied to `sidepanel.html`). Count doesn't count sessions (it would cost the list request on every Count). The Exporting screen gets a phase `sessions` ("Session N of M"): a `#step-sessions` row in `popup.html` and `sidepanel.html` (kept identical), `runSteps`, `runTitleText`, `savedText` and `saved.sessions`. The Done and Export stopped sentences count saved sessions beside chats and artifacts ("29 chats, 3 sessions and 20 artifacts"), in the pure view-model functions `tests/screens.test.js` pins. Changes only's summary on the main screen stays about chats and artifacts. *(My calls.)*

### Fetching (content.js)

New actions, asked by the panel like the others:
- `listSessions`: the list, the org by the same rule as chats.
- `fetchSessionEvents` (`cse_id`, `after`): ONE page per message, asked with `limit=200` *(my call, so a page of kept events stays far below Chrome's message limit)*; the panel loops while `has_more`. `last_id` and `has_more` are taken from the raw page before any filtering (dropped types such as `env_manager_log` have no `uuid`).

`content.js` keeps only the kept fields (below), replaces any kept event over 2 MB with a stub `{ uuid, created_at, type, stub: 'too large (N MB)' }` before sending, and strips and masks as in "What a transcript holds", so nothing it drops reaches the panel. The PR #80 retry (inlined in `fetchConversation`) moves into a shared helper both use: 429 and 5xx up to three times, Retry-After up to 30 s, else 2, 5, 10 s. Codes only in errors, never response text.

### Kept fields

- **Session**: `id`, `title`, `status_bucket`, `environment_kind`, `config.origin`, `config.model`, `created_at`, `updated_at`, `last_event_at`, and `external_metadata.artifacts[]` (`artifact_id`, `title`, `updated_at`).
- **Events**: `user` and `assistant` (`uuid`, `created_at`, `parent_tool_use_id`, `message.role`, `message.model`, `message.content`), `result` (`uuid`, `created_at`, `is_error`, `num_turns`, `duration_ms`, `total_cost_usd`, `subtype`), and `system` of subtype `compact_boundary` (`uuid`, `created_at`, `subtype`). Every other type and field is dropped.

### What a transcript holds

- **Prompts**: a `user` event whose content is not only `tool_result` blocks. A plain-string content is one text block.
- **System reminders**: every `<system-reminder>…</system-reminder>` span is removed from user text (in `content.js`, so it is never written or searched). A user event left with nothing is dropped.
- **Labelled, not shown as the owner's words**: the compaction summary ("This session is being continued from a previous conversation…"), `<command-name>`/`<command-args>` (shown as "Ran /name"), and `<local-command-stdout>` (a folded "Command output" step).
- **Masked**: known token shapes in any kept text are replaced by `[masked]`: `sk-ant-…`, `ghp_…`/`gho_…`/`github_pat_…`, `AKIA…` access key ids, `xox[bp]-…`, `Bearer <long token>`, and `-----BEGIN … PRIVATE KEY-----` blocks. Best effort, said so in USAGE. *(My call on the list; a test pins each shape.)*

### Layout

`sessions/<Title>_<shortId>/` beside `projects/` and `artifacts/`; folder names claimed case-insensitively like `claimArtifactFolder`, titles cleaned with `safeFileTitle` and cut like artifact folders, `shortId` from the `cse_` id. `sessions` joins `usedFolderNames`, so a chat titled "sessions" gets `sessions_2`. Each session folder has:

- `session.json`: `{ format: 1, session: {...}, events: [...] }` with the kept, stripped and masked fields; an image's base64 is replaced by `{ image: 'images/<n>.<ext>' }` (no copy of the bytes).
- `transcript.md`: title, dates, origin and model, then each turn: the prompt, the reply text, thinking under "Thought process", tool steps as one line each with a fenced input and a short result (results over 2 KB cut with a note pointing at `session.json`), images linked from `images/`, a line per compaction. UTF-8 with BOM. Titles and names through `mdLinkText`.
- `README.md`: title, dates, origin, counts (turns, tool calls), cost when present, and the artifacts it made, each linked to `../../artifacts/<folder>/` when the export's store has it, else its title and claude.ai link (`https://claude.ai/artifact/<shortId>`, from the uuid).
- `images/<n>.<ext>`: PNG, JPEG, GIF or WebP by leading bytes; one over 5 MB is left out with a note. *(My call.)*

`index.md` gets a "Sessions" table (title, origin, last activity, turns). `export-manifest.json` gets `sessions: { listed, items: [{ id, title, folder, last_event_at }] }`.

### Links to artifacts

The link lives on the session side only: the session's README and `session.json` list its artifacts, and the viewer joins them both ways. `artifact.json` (format 2) and the artifacts indexes don't change. *(My call.)*

### Changes only

`exportRecord[org].sessions[<cse_id>] = last_event_at`. `saveExportRecord` keeps and joins `sessions` like `chats`, and sessions pass `recordableExport`'s write-failure filter. Changes only takes a session whose `last_event_at` differs, or is new. A session that failed, was cut by a cap or had a write failure isn't recorded. A session over the caps is therefore tried again (and warned) on every Changes run; acceptable, since such a session is rare and the warning says why. A session later deleted on claude.ai stays in older archives and in the record. *(My call: `last_event_at`, since a rename changes `updated_at` without new content.)*

### Limits and memory

Per session: 100 pages of 200 (20,000 events); kept events over 64 MB stop it (saved as far as it got, warned, not recorded). In a folder export each session is written and flushed before the next and its events are dropped. In ZIP mode a total session budget of 256 MB of kept events: sessions past it are skipped with one warning. *(My calls.)*

### Warnings

A new warning type `session` (with a `_getRecoveryHint` case and a `WARNING_NOUNS` entry): the list failed or may be incomplete (one warning), a session's events failed or were cut by a cap, the ZIP budget was reached, an image couldn't be saved. Codes only. The Done screen and `index.md` count them like other warnings.

## The viewer

### Data

`ViewerData.sessions`: per session `{ id, title, origin, created, updated, folder, artifacts: [uuid], messages: [...] }`, built by `CTViewer.buildViewerSession`. An adapter turns kept events into the `chat_messages` shape `buildViewerChat` reads (`sender`, `content` array, a flat single branch; each message's parent is the one before), so the chat renderer draws it. Additions to the chat renderer: a top-level `image` block in a user message, and the labelled prompts above. Events with a `parent_tool_use_id` go inside the step of the `Agent` call they belong to, in order. *(My call.)*

**Size**: tool results in the viewer are cut at 2 KB with "Full output in session.json" (a relative link); images are shown from `sessions/<folder>/images/<n>` by relative path (the CSP's `img-src file:` allows it), never as data URIs. So a large session adds its text, not its tool output, to `viewer.html`.

### Where

A **Sessions** entry in the sidebar under Projects and Chats, with a count, shown only when the export has sessions (also beside a single chat; a one-chat ZIP has none and is unchanged). It opens `#sessions`, a list page on the v1.24 lists screen (`routeLists`, `parseListHash` gain it): title, origin, last activity, filter, newest first. A session opens in the chat area at `#session=<cse_id>` (with `&msg=<uuid>` for a search hit; `parseHash`/`formatHash` gain both), read-only, its title in the top bar and a fold bar line "Session · <origin>" with links to its artifacts. Sessions don't appear in Recents, All chats or Projects, and don't change their counts. *(My call: its own entry.)*

### Search

The sidebar search also finds session titles, prompts and reply text (never system reminders, already stripped): results group by session like chat results, ranked by the same rules, each group labelled "Session"; a result opens the session at the message. `search.e2e.js`'s chat cases stay as they are.

### Artifacts screen

An artifact made in a session shows "Made in session <title>" linking to `#session=<id>`.

## Older archives and the archive tools

- A viewer without sessions shows no Sessions entry.
- `tools/archive-lib.js`: `sessions` joins `KNOWN_DIRS`, so `scanAdded` doesn't list session files as owner-added "Archive files"; `build_viewer.js` reads `sessions/*/session.json` so a rebuilt viewer keeps them.
- `tools/merge_archives.js`: `sessions` joins its reserved names and root-folder skipping; it copies each session folder from the source with the newest `last_event_at`, and the merged manifest lists them.

## Testing

- Unit: the CLI switch (off: no events request for a `bridge` session, the README and `index.md` count it as left out; on: exported); the field filter (each event type in, only kept fields out; `session_context`, headers, `env_manager_log` and `init` never out), system-reminder stripping, each masked token shape, labelled prompts, paging (`last_id` from the raw page) and caps, the 2 MB stub, `buildViewerSession` on fixture events (including a top-level image and a subagent event), `transcript.md`, the README's artifact links, the record and Changes only (a sessions-only change is exported, a capped session isn't recorded), the early return and `viewerWanted` with sessions, Stop and tab-gone, the reserved names, `KNOWN_DIRS`, merge, the warning type and hint, the panel sentences.
- Fixtures are synthetic, shaped from the study; never real session data in the repo.
- e2e: a viewer with two sessions: the entry and count, `#sessions`, a transcript (text, folded thinking, a tool step cut at 2 KB, an image from its file), the artifact link both ways, search finding a session prompt but not a stripped reminder, no network.
- `export.e2e.js`'s mock claude.ai gains a session list and paged events.
- Before building: re-check the three endpoints on the owner's account (read-only), including how `resume_token` continues the list.

## Docs

README changelog and manifest; USAGE (what is exported and what isn't; the CLI-session warning and that masking is best effort); TECHNICAL (endpoints, kept fields, stripping and masking, layout); CLAUDE.md (§2, §7 layout, §8 endpoints, §9 record, §11 warning type).

## Left to the builder

Exact transcript formatting within the rules above, CSS, icons, the wording of empty states, and how the chat renderer is shared with sessions.
