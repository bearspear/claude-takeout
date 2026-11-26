# Claude Code and Cowork sessions in Export All (v1.25.0)

Status: draft for the owner's approval. Written 2026-11-26. The owner skipped the questions; every choice marked "My call" is mine and open to change. A builder check is done and its questions are answered below.

Depends on v1.24.3 (PR #80: the chat fetch retry and the Export All prefetch); build on main after it merges.

## Why

Export All saves every chat claude.ai lists, but Claude Code sessions (run from the CLI with remote control) and Cowork sessions (from the desktop app) are not in that list, and claude.ai's chat API answers 404 for them, even though they open at a `claude.ai/chat/<uuid>` address. Their artifacts are exported (with `sourceSurface: code`), the conversations that made them are not. The owner noticed this on "Takeout Panel Refresh": the artifact was in the export, its session was not.

## What we know (read-only study, 2026-11-26, three sessions on the owner's account)

- **List**: `GET /v1/code/sessions?exclude_tags=-&limit=100` with headers `anthropic-version: 2023-06-01`, `anthropic-beta: ccr-byoc-2025-07-29`, `x-organization-uuid: <org>` (cookies included). Reply `{ data, resume_token }`. Each session: `id` (`cse_…`), `title`, `status`, `status_bucket`, `environment_kind` (`bridge` for a CLI session, `anthropic_cloud` for Cowork), `config.origin` (`claude_code_cli`, `desktop_app`), `created_at`, `updated_at`, `last_event_at`, `tags`, `external_metadata`. The `exclude_tags` parameter is required (without it the list is empty).
- **Artifacts**: `external_metadata.artifacts[]` is `{ artifact_id, kind: "frame", title, updated_at, url }`, where `artifact_id` is the artifact's uuid (its slug). Cowork tags also carry `frame-artifact:<uuid>`. This links a session to its artifacts exactly.
- **Details**: `GET /v1/sessions/<cse_id>` adds `session_context` (with connector request headers), `bound_device`, `active_mount_paths`, `github_access`, `session_url` and more.
- **Events**: `GET /v1/sessions/<cse_id>/events?limit=1000[&after_id=<last_id>]`, reply `{ data, first_id, has_more, last_id }`. Oldest first, unique `uuid`s. Sizes seen: 41 events (146 KB), 97 events (229 KB), 8,227 events in 9 pages (30 MB).
- **Event types**: `user`, `assistant` (with `message`, a standard Claude message: blocks `text`, `thinking`, `tool_use`, `tool_result` with text, image or tool_reference items, `image`; a user message's content may also be a plain string), `system` (subtypes `init`, `status`, `task_started`, `task_updated`, `task_notification`, `background_tasks_changed`, `compact_boundary`, `code_change_published`, `session_metadata`, `turn_handoff_available`, `worker_shutting_down`), `result` (per-turn stats, cost), `control_request`/`control_response`/`control_cancel_request`, `rate_limit_event`, `autocompact_state`, `env_manager_log` (`category, content, extra, level, timestamp`).
- **Tools seen**: Bash (most), Agent, Edit, Read, Write, SendMessage, Artifact, Skill, ToolSearch, AskUserQuestion, MCP tools. Tool results reach 620 KB; images occur in user messages and tool results.
- **Not found**: where the `/chat/<uuid>` address maps to a session. It is in none of the three endpoints. Not needed (artifacts link by id).

All three endpoints are on `claude.ai`, same origin as the chat API, so `content.js` fetches them with the existing `https://claude.ai/*` host permission and cookies; the extra headers need nothing new. They are undocumented and may change without notice. How the list continues past one page (`resume_token`) wasn't seen (one page on the owner's account); the pre-build check tries it, and until it is known a reply with a `resume_token` the export can't follow warns that the list may be incomplete.

## Goals

1. Export All (Chats ticked) also saves each Code and Cowork session: its events, a readable transcript, a README.
2. The viewer lists sessions and shows a session's transcript: prompts, replies, thinking (folded), tool steps (folded, as chat steps are), images.
3. An artifact made in a session links to it, and the session lists its artifacts, both ways, in the files and in the viewer.
4. Changes only takes a session again only when it changed.
5. Nothing secret leaves claude.ai: connector headers, environment logs and startup details are never written.

## Non-goals

- Rebuilding the files a session wrote (the `_vN` replay chats get). The transcript shows each Write and Edit as a step; artifacts published from the session are already exported. *(My call: transcript only first.)*
- Sessions in a single-chat export, or the popup's This chat card on a session page.
- Sessions of other people, archived sessions the list doesn't return, and Claude Code sessions that never connected to claude.ai (local only).
- Search inside tool results (as for chats: search reads prompts, replies and names).
- Reaching a session from its `claude.ai/chat/<uuid>` address: that mapping wasn't found. Sessions are reached from the Sessions list, search and artifact links. *(My call.)*
- `merge_archives.js` and `build_viewer.js` understanding sessions in this version beyond copying the folder and keeping the viewer working. *(My call; they need it in a follow-up.)*

## Anti-goals

- No secret in any written file: never `session_context`, never request headers, never `env_manager_log`, never `system` `init` details (cwd, MCP servers, API key source, plugins, paths), never control requests. If a field isn't on the keep list below, it isn't written.
- A failure of the session endpoints never fails or slows the chats: it is one warning, and the export goes on.
- No change to the chat export, the viewer's CSP, sandboxing or `sanitizeHtml`.

## The export

### When

With the Chats box ticked, after the chats and after the artifact step, before the viewer, so a session's README knows the artifacts' folders. There is no new checkbox. *(My call: fewer choices on the main screen; a session is a kind of chat to the owner. A failure warns instead of stopping anything.)* Export Artifacts (Artifacts only) doesn't fetch sessions. Stop is checked before each session and between its pages; a stopped run records no session.

### The panel

Count doesn't count sessions (it would cost the list request on every Count). The Exporting screen gets a phase "sessions" (`exportProgress` phase `sessions`, "Session N of M"), and the Done and Export stopped sentences count saved sessions beside chats and artifacts ("29 chats, 3 sessions and 20 artifacts"), in the pure view-model functions `tests/screens.test.js` pins. Changes only's summary stays about chats and artifacts. *(My calls.)*

### Fetching (content.js)

New actions, asked by the panel like the others: `listSessions` (the list, the org from the same rule as chats) and `fetchSessionEvents` (`cse_id` and `after`, ONE page per message; the panel loops until `has_more` is false or a cap, so no message carries more than one page). They return only kept fields (below): the filtering happens in `content.js`, so nothing secret reaches the panel. 429 and 5xx retry as `fetchConversation` does (v1.24.3: up to three times, Retry-After up to 30 s, else 2, 5, 10 s; share the helper). Codes only in errors, never response text.

### Kept fields

- **Session**: `id`, `title`, `status_bucket`, `environment_kind`, `config.origin`, `config.model`, `created_at`, `updated_at`, `last_event_at`, and `external_metadata.artifacts[]` (`artifact_id`, `title`, `updated_at`). Nothing else (not `tags`, not `url`, not `session_url`).
- **Events**: only `user` and `assistant` (`uuid`, `created_at`, `parent_tool_use_id`, `message.role`, `message.model`, `message.content`), `result` (`uuid`, `created_at`, `is_error`, `num_turns`, `duration_ms`, `total_cost_usd`, `subtype`), and `system` of subtype `compact_boundary` (`uuid`, `created_at`, `subtype`). Every other type and field is dropped.
- Inside `message.content` everything is kept, as it is for chats (it is what the owner and Claude wrote and what tools returned).

### Layout

`sessions/<Title>_<shortId>/` (`shortId`: the `cse_` id's last 12 characters; titles cut and cleaned with `safeFileTitle` like artifact folders), beside `projects/` and `artifacts/`. `sessions` joins `usedFolderNames` (`projects`, `published`, `artifacts`), so a chat titled "sessions" gets `sessions_2` as those do. Each session folder has:

- `session.json`: the kept session fields and the kept events, `{ format: 1, session: {...}, events: [...] }`.
- `transcript.md`: title, dates, origin and model, then each turn: the prompt, the reply text, thinking under "Thought process", tool steps as one line each with a fenced input and a short result (results over 2 KB cut with a note), images saved under `images/` and linked, and a line per compaction. UTF-8 with BOM, like every Markdown file.
- `README.md`: title, dates, origin, counts (turns, tool calls), cost when present, and the artifacts it made, each linked to `../../artifacts/<folder>/` when that artifact is in the export's store, else its title and claude.ai link (`https://claude.ai/artifact/<shortId>`, from the uuid).
- `images/<n>.<ext>`: images from the events (base64 in the event), PNG, JPEG, GIF or WebP only, by leading bytes; one over 5 MB is left out with a note in the transcript. *(My call.)*

`index.md` gets a "Sessions" table (title, origin, last activity, turns). `export-manifest.json` gets `sessions: { listed, items: [{ id, title, folder, last_event_at }] }`.

### Links to artifacts

The link lives on the session side only: the session's README and `session.json` list its artifacts, and the viewer joins them both ways from `ViewerData.sessions[].artifacts`. `artifact.json` (format 2) and the artifacts indexes don't change. *(My call: the artifacts are written before the sessions, and the old-archive tools keep reading format 2 unchanged.)*

### Changes only

`exportRecord[org].sessions[<cse_id>] = last_event_at`. Changes only takes a session whose `last_event_at` differs, or is new. A session that failed or was cut by a cap isn't recorded. A session later deleted on claude.ai stays in older archives and in the record; nothing is ever removed. *(My call: `last_event_at`, not `updated_at`, since a rename changes `updated_at` without new content.)*

### Limits

Events per session: 20 pages (20,000 events). A single kept event over 2 MB is replaced by a stub saying so. A session's kept events over 64 MB stop it (as with a published version's cap): saved as far as it got, warned, not recorded. *(My calls: numbers to keep memory bounded; the 30 MB session fits.)*

### Warnings

A new warning type `session` (with a `_getRecoveryHint` case): the list failed (one warning, no sessions), a session's events failed or were cut by a cap, an image couldn't be saved. Codes only. The Done screen and `index.md` count them like other warnings.

## The viewer

### Data

`ViewerData.sessions`: per session `{ id, title, origin, created, updated, artifacts: [uuid], messages: [...] }`, built by a new `CTViewer.buildViewerSession` from the kept events: a flat, single-branch message list (no tree; each message's parent is the one before) in the same block shapes `buildViewerChat` gives the chat viewer (text, thinking, tool steps, images), so the chat renderer is reused. Events with a `parent_tool_use_id` (a subagent's own messages, none seen in the study but possible) go inside the step of the `Agent` call they belong to, in order. *(My call.)* Large tool results go to `viewer-files/` parts like large uploads.

### Where

A **Sessions** entry in the sidebar under Projects and Chats, with a count, shown only when the export has sessions; also in a viewer with a single chat plus sessions (the Projects and Chats entries keep their rule). A one-chat ZIP has no sessions and is unchanged. It opens a list page (the lists screen of v1.24: title, origin, last activity, filter, newest first). A session opens in the chat area like a chat, at `#session=<cse_id>`, read-only, with its title in the top bar and a fold bar line "Session · <origin>" with links to its artifacts. *(My call: its own entry, because sessions differ from chats: no branches, mostly tool steps, other ids.)* Sessions don't appear in Recents, All chats or Projects, and don't change their counts.

### Search

The sidebar search also finds session titles, prompts and reply text: session results group like chat results (by session), ranked by the same rules, each group marked with a "Session" label; a result opens the session at the message. `search.e2e.js`'s chat cases stay as they are.

### Artifacts screen

An artifact made in a session shows "Made in session <title>" linking to `#session=<id>` (joined in the viewer from the session data).

## Older archives

A viewer built from an archive without `sessions/` shows no Sessions entry. `build_viewer.js` reads `sessions/*/session.json` when present so a rebuilt viewer keeps them; `merge_archives.js` copies the newest copy of each session by `last_event_at`. *(These two are small; included so a merged archive doesn't lose sessions.)*

## Testing

- Unit: the field filter (a recorded, scrubbed event of each type in, only kept fields out; a `session_context` or header in the input never appears in the output), paging and caps, `buildViewerSession` on fixture events, `transcript.md`, the artifact link, the record and Changes only, the reserved name, the warning type and hint.
- Fixtures are synthetic, shaped from the study (never real session data in the repo).
- e2e: a viewer with two sessions: the entry and count, the list page, a session's transcript (text, folded thinking, a tool step, an image), the artifact link both ways, search finding a session prompt, no network.
- The real extension against the mock claude.ai (`export.e2e.js`) gains a session list and events.
- Before building: re-check the three endpoints on the owner's account (read-only), since they are undocumented.

## Docs

README changelog and manifest; USAGE (what is exported, what isn't: file rebuilds, local-only sessions); TECHNICAL (endpoints, kept fields, layout); CLAUDE.md (§2, §7 layout, §8 endpoints, §11 warning type).

## Left to the builder

Exact transcript formatting within the rules above, CSS, icons, the wording of empty states, and how the chat renderer is shared with sessions.
