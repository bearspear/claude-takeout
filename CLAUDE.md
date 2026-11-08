# CLAUDE.md — Claude Takeout developer primer

A self-contained orientation document for any agent (human or LLM) picking up this codebase cold. Read this end-to-end and you should be ready to land a bug fix, enhancement, or feature without first having to spelunk through the source.

For deeper dives, two companion docs live alongside this one:
- `README.md` — user-facing feature list, install/usage instructions, changelog.
- `TECHNICAL.md` — long-form writeup: data loading, JSON structure, message chains, artifact versioning, files, citations, the ZIP, `errors.txt`, the viewer and the old-archive tool. Current as of v1.6.9.

---

## 1. What this is

**Claude Takeout** is a Chrome Manifest V3 extension that exports Claude.ai conversations to Markdown, JSON, or comprehensive ZIP archives — single-conversation or all-conversations-at-once. It runs entirely client-side using your existing Claude session cookies; no API keys, no external servers.

- **GitHub:** `bearspear/claude-takeout` (push remote: `git@github.com-personal:bearspear/claude-takeout.git`).
- **Branch convention:** one branch per change, merged through a PR by the owner. Commit and push only with the owner's OK. Commit as `bearspear`; the repo's local git config is set for that.
- **Working dir on this machine:** `/Users/mbehringer/Downloads/claude-takeout`.
- **Versions:** `manifest.json` must not fall behind the newest README changelog entry, and a test enforces that. A PR adding a new changelog version bumps the manifest too. Tag releases `v<version>` on `main`.

---

## 2. File map (the whole repo)

| File | Role | Notes |
|---|---|---|
| `manifest.json` | MV3 declaration. | Hosts: `claude.ai/*`. Perms: `activeTab`, `scripting`, `storage`, `sidePanel`. Web-accessible: `injected.js`. |
| `injected.js` | Page-context org ID fallback (runs in the page's world). | Wraps `window.fetch`, reads the org ID from request URLs, relays it via `window.postMessage`. |
| `content.js` | Isolated-world bridge (runs at `document_start`). | Injects `injected.js`, resolves the org ID, and exposes `getOrgId` / `fetchAllConversations` / `fetchConversation` to the popup via `chrome.runtime.onMessage`. |
| `background.js` | MV3 service worker. | Only manages side-panel "open on action click" preference. Listens to `chrome.storage.onChanged` for `useSidePanel` to re-apply behavior. |
| `popup.html` | Popup UI (action click). | Buttons, status pill, settings drawer. Includes `.status.ready` / `.waiting` / `.error` / `.warning` styles. |
| `sidepanel.html` | Side Panel UI. | Same buttons/handlers as the popup, just a different host. |
| `export-core.js` | Shared pure extractors. | Classic script loaded before `popup.js` (plain top-level declarations, `module.exports` under Node only). Holds `fixMojibake`, `isTextFile`, `zipSafeName` (every name from chat data that becomes a ZIP path goes through it), `getMessageChain`, `extractArtifacts`, the heredoc helpers, `extractUploadedFiles`, `extractPresentedFiles`, `extractDeliveredFiles`, `getModelName`, `buildViewerDeliveries`, `viewerProject`, `heredocFiles`. Used by `popup.js` and Node tools. |
| `popup.js` | **The brain.** About 3,900 lines. All export logic, all conversion, all UI wiring. Same script is loaded by both `popup.html` and `sidepanel.html`. | See §3 below for the internal layout. |
| `jszip.min.js` | ZIP library (vendored). | Used by both single-ZIP and mega-ZIP exports. |
| `extract_artifacts.py` | Stdlib-only Python port of `extractArtifacts`. | Reconstructs all per-turn artifact versions from `original.json` offline. Byte-identical output to the JS implementation. |
| `replay_bash.py` | Stdlib-only Python CLI for post-export bash replay. | Reconstruction, isolated by `sandbox-exec` on macOS, of artifacts the declarative replay can't reach (anything Claude mutated via `bash_tool`). See §10 below and `docs/WASM_REPLAY_APPROACH.md`. |
| `tools/archive-lib.js` | Archive scanning for the old-archive tool. | Finds archives (`findArchives`), scans owner-added files (`scanAdded`), recognizes generated viewers (`isGeneratedViewer`), matches files by name (`matchFile`) and rebuilds chats from disk (`chatFromDisk`). |
| `tools/archive-zip.js` | ZIP extraction for the old-archive tool. | Extracts into a new folder under `--out`; refuses unsafe entries and checks free space. |
| `tools/build_viewer.js` | CLI that gives older archives a viewer. | `node tools/build_viewer.js <folder> [--out] [--force] [--dry-run] [--json]`. Writes only `viewer.html`, `viewer-check.gif`, `viewer-files/`, and temporary `.tmp-<pid>` and `.old-<pid>` names. The write-safety rules live here: `inspectRoot`, `install`, `writeNew`, `assertFree`. It creates `--out` if absent, and extracts ZIPs into new folders under it. Needs Node 20+. |
| `tests/archive.test.js` | Unit tests for the three `tools/` files. | Run by `sh tests/run.sh`. |
| `tests/e2e/archive.e2e.js` | Browser test of a built archive viewer. | Optional; needs `playwright-core` and Chromium. |
| `tests/e2e/colors.e2e.js` | Browser test of syntax colors. | Optional; needs `playwright-core` and Chromium. |
| `tests/e2e/stepper.e2e.js` | Browser test of the in-chat match bar: stepping across messages and branches, hidden matches, keyboard, closing. | Optional; needs `playwright-core` and Chromium. |
| `tests/e2e/files.e2e.js` | Browser test of the Files list in a chat's top bar. | Optional; needs `playwright-core` and Chromium. |
| `tests/e2e/search.e2e.js` | Browser test of sidebar search: grouping and ranking, bold matches, operators, the clear button, `/` and arrow keys. | Optional; needs `playwright-core` and Chromium. |
| `tests/e2e/navigation.e2e.js` | Browser test of keyboard version switching, search highlights, Sources on plain-text responses, the phone panel header and the color queue. | Optional; needs `playwright-core` and Chromium. |
| `tests/e2e/parts.e2e.js` | Browser test of upload and generated-file text loaded from `viewer-files/`. | Optional; needs `playwright-core` and Chromium. |
| `tests/e2e/hostile.js` | Hostile-input fixtures for the viewer e2e tests. | Not a test by itself. |
| `takeout-viewer.js` | Builds the offline viewer's data. | Classic script loaded by `popup.html` and `sidepanel.html`, exposing `CTViewer` (`buildViewerChat`, `buildViewerData`, `assembleViewer`, ...). Header comment documents the contract. |
| `viewer/` | Viewer page sources. | `viewer-template.html`, `viewer-logic.js`, `viewer-app.js`, `marked.min.js`, `katex.min.js`, `katex-inline.css`, `highlight.min.js`, `THIRD-PARTY-NOTICES.txt`. `writeViewer` inlines them into one `viewer.html`. |
| `tests/` | Regression tests. | `sh tests/run.sh`. Uses Node's and Python's built-in test runners, with a synthetic fixture only. Not used by the extension at runtime. |
| `docs/WASM_REPLAY_APPROACH.md` | Architecture record. | Comprehensive evaluation of running Pyodide in the extension as an alternative to the CLI. We chose the CLI; this doc explains why and what would change the answer. |
| `icon16.png` / `icon48.png` / `icon128.png` / `icon.svg` | Extension icons. | |
| `README.md` / `USAGE.md` / `TECHNICAL.md` | Documentation. | TECHNICAL.md names functions rather than copying their code; keep it accurate when behavior changes (§14). |

Files that are **not** part of the extension and may sit in the working tree: `transcript.en.vtt`, `transcript.txt` (stray), `.claude/settings.local.json` (Claude Code permission allowlist — local-only, don't commit), `.DS_Store`.

---

## 3. popup.js internal layout

`popup.js` is one big script with conceptual sections delimited by `// ====` banners. These are listed in file order; search for a function name to find its line.

| Section | What lives here |
|---|---|
| `export-core.js` (separate file) | Mojibake repair, `isTextFile`, `getMessageChain`, `extractArtifacts` (per-turn versioning + str_replace replay), `extractUploadedFiles`, `extractPresentedFiles`, `extractDeliveredFiles`, `getModelName`, `buildViewerDeliveries`, `viewerProject`, `heredocFiles` live here, not in `popup.js`. Edit them there. |
| `ExportErrorCollector` class | Structured errors + warnings per export, builds `errors.txt` with recovery hints, troubleshooting guide. **All warning types must have a case in `_getRecoveryHint`.** Existing types: `upload`, `presented_file`, `project_doc`, `project_metadata`, `str_replace_failed`, `artifact_basename_collision`, `artifact_opaque_mutation`, `viewer`. |
| BOM helpers | `withBOM(text)`, `addFileWithBOM(folder, path, content)`. The mojibake map and `fixMojibake` are in `export-core.js`. |
| Extractors and renderers | `extractTextAttachments`, `extractWebSources`, `extractBlobContent`, `extractProjectFiles`, `getLanguageFromFilename`, `processTextWithCitations`, `formatReferences`, `getLanguageFromType`, `getThinkingSummary`, `markdownToPlainText`. |
| ZIP/section builders | `extractCodeBlocks`, `extractUrls`, `sanitizeForFilename`, `extractFirstHeading`, `escapeMarkdown`, `extractResponseTextOnly`, `generateMeta`, `generatePrompts`, `generateResponsesTextOnly`, `generateCodeSnippets`, `generateLinksAndSources`. |
| `populateConversationFolder` | The shared ZIP layout writer used by both single-ZIP and mega-ZIP. Constructs `ExportErrorCollector`, calls all extractors, fetches project docs + uploaded files, writes every file in the folder. |
| `createZipExport` | Wraps `populateConversationFolder` for the single-conversation ZIP path; generates the filename + downloads the blob. |
| Offline viewer: `viewerUploadText`, `writeViewer` | Builds `viewer.html` for each export. `viewerUploadText` reads an upload's text for the viewer, and `writeViewer` assembles the page via `takeout-viewer.js` (`buildViewerChat`, `modelLabel`) and adds it to the ZIP. A failure here warns under `viewer` and never stops the export. |
| Helpers: `formatTimestamp` | `getModelName` is in `export-core.js`; its model name parsing handles `data.model` (e.g. `claude-sonnet-4-5-20250929` → "Claude 4.5 Sonnet") and falls back to `paprika_mode` / thinking-block detection. |
| `convertToMarkdown` | The single-MD / embedded-MD renderer. Walks `getMessageChain`, formats prompts and responses, renders thinking blocks, tool uses (`create_file`, `present_files`, `web_search`, `bash_tool`, `str_replace`, `view`, etc.), citations, and references. Honors `embedArtifacts`, `seamlessMd`, `includeThinking`. |
| `extractTextContent`, `download`, `safeFilename` | Small utilities. |
| `updateUI`, `showProgress`, `hideProgress`, `requestData` | DOM glue. |
| `bulkExport`, `bulkExportZip` | Multi-conversation paths. `bulkExport` downloads one file per conversation (MD/embedded/JSON). `bulkExportZip` builds a single mega-zip with `index.md` + one folder per conversation reusing `populateConversationFolder`. |
| Click handlers + `refresh` | Button → action mapping. Each per-conversation handler calls `ensureProjectName` before generating the filename or starting the ZIP. |
| Settings | `loadSettings`, `saveSettings`, `applySettings`; settings shape: `{ filenameStyle, includeThinking, showShortcuts, useSidePanel }` persisted under `chrome.storage.local.exporterSettings`. `useSidePanel` is mirrored at top-level for the background worker. |
| Keyboard shortcuts | `Alt+M / E / Z / J / A / R`. |
| `exclusiveExport`, `onExport` | One export at a time: the export buttons are disabled while one runs, and a second click or shortcut does nothing. |
| `generateFilename` | `[<Project>-project]_` prefix + filenameStyle, with an optional suffix such as `_embedded` added after the title is cut to length. |
| Bootstrap | `loadSettings()` then `requestData()`. |

When adding code: keep the banner-comment section structure and put helpers near the section that uses them. Do **not** create new files unless adding a non-trivial standalone tool (e.g. a second companion script).

---

## 4. Runtime data flow

```
   claude.ai page                       popup.js (popup or side panel)
   ├─ injected.js                       ├─ reads the chat ID from the tab URL
   │    reads org ID from fetch URLs    ├─ asks content.js for that chat
   │         │ postMessage              ├─ extracts, transforms, writes
   │         ▼                          └─ downloads via URL.createObjectURL
   └─ content.js  ◀── chrome messaging ──┘
        resolves the org ID
        calls the claude.ai REST API
```

- **The page itself isn't a data source:** claude.ai loads chats over `/claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/StreamTimeline`, which the extension can't read, so conversation data always comes from REST.
- **Selected chat comes from the tab URL:** `requestData` matches `/chat/<uuid>` and always fetches that chat over REST through `content.js`'s `fetchConversation`. Each single-chat handler calls `loadConversationForExport` to fetch again, and fails rather than export an older copy. `tabs.onActivated` and `tabs.onUpdated` trigger `scheduleRefresh`, which waits while an export's progress bar is showing.
- **`sendToTab` injects `content.js` on a connection error:** a tab open across an extension install or reload has no working content script, which used to show as "Refresh page to capture data."
- **Org ID comes from the `lastActiveOrg` cookie first:** `content.js`'s `getActiveOrgId`, then the captured ID, then the stored one.
- **`fetchConversation`** appends `?tree=True&rendering_mode=messages&render_all_tools=true` to get the fully-rendered payload (including nested `project.name`, which the page-side fetch often omits).
- **`ensureProjectName(data, orgId)`** is the bridge: for payloads that only have `project_uuid`, it re-fetches `/api/organizations/<orgId>/projects/<projectUuid>` and patches `data.project = { uuid, name }` before filename generation. Called at the top of every single-export click handler and at the start of each iteration in both bulk paths.

---

## 5. Conversation JSON: the shape that matters

Everything keys off `data.chat_messages[]`. Each message:

```jsonc
{
  "uuid": "msg-uuid",
  "parent_message_uuid": "previous-msg-uuid",  // null at root
  "sender": "human" | "assistant",
  "created_at": "ISO timestamp",
  "content": [ /* content blocks */ ],
  "attachments": [ /* pasted text files w/ extracted_content */ ],
  "files":       [ /* legacy uploads */ ],
  "files_v2":    [ /* modern uploads */ ]
}
```

Plus top-level: `uuid`, `name`, `model`, `settings.paprika_mode`, `created_at`, `updated_at`, `current_leaf_message_uuid`, `project_uuid`, `project` (sometimes — see §4), `project_context_files`.

### 5.1 Branched conversations

The user can regenerate a response, producing a tree. `current_leaf_message_uuid` is the active leaf. To get the active branch in chronological order: walk back via `parent_message_uuid`, collect, reverse. **`getMessageChain(data)` does this.** Always use it — never iterate `data.chat_messages` directly when generating export content. (It's fine for whole-conversation scans like uploads where the tree-shape doesn't matter, but be explicit about it.)

### 5.2 Content block types (assistant side mostly)

| `type` | Notable fields | Where it's rendered |
|---|---|---|
| `text` | `text`, optional `citations[]` | `convertToMarkdown` text branch + `processTextWithCitations`. |
| `thinking` | `thinking`, `summaries[]` | Code-fenced under "Thought process: <summary>" if `includeThinking` is on. |
| `tool_use` | `name`, `input` | See §6. |
| `tool_result` | `name`, `content[]`, `is_error` | Rendered inline for most tools; `view` results yield blob content. |

### 5.3 Tool calls of interest

| `name` | `input` fields used | What the extractor does |
|---|---|---|
| `create_file` | `path`, `file_text`, `description` | Initializes artifact state at `input.path`; emits new version. |
| `str_replace` | `path`, `old_str`, `new_str` | Replays edit against current state (single-match semantics); emits a `str_replace_failed` warning on 0 or >1 matches. |
| `rewrite` / `create_or_overwrite` | `path`, `file_text` or `content` | Defensive — overwrites artifact state; emits new version. |
| `artifacts` (cmd: `create`/`update`/`rewrite`) | `id`, `title`, `type`, `content`, `command`, `old_str`, `new_str` | Keyed by `artifact:<id-or-title>`. Filename = sanitized(title or id) + `typeToExt[type]` (fallback `.txt`). `create`, `rewrite` and an `update` with `content` set the text; an `update` with `old_str`/`new_str` is replayed like `str_replace`. |
| `bash_tool` (heredoc) | `command` matching `cat > <path> << DELIM ... DELIM`, any delimiter (`HEREDOC_RE`) | Treated as create_file. |
| `present_files` | `filepaths[]` | `populateConversationFolder` downloads a presented file the replay didn't make, or one whose replay is known to be off (`str_replace_failed` or `artifact_opaque_mutation` for that name: the download then replaces the final file and its last `_vN`). Same-named files from different folders become `<base>_2<ext>`. In `convertToMarkdown`, looked up through `presentedNames` in the `artifacts` map for inline embedding; a binary one is linked. *Caveat:* with edited artifacts, lookup resolves to the FINAL versioned state, not the state at the moment of presentation. Acceptable trade-off; the per-turn versioned files exist on disk for cases where the precise moment matters. |
| `Write` / `Edit` | `file_path`, `content` / `old_string`, `new_string`, `replace_all` | Same replay as `create_file` / `str_replace`. Newer conversations use these names. |
| `Bash` | `command` | Same as `bash_tool`, in the extension and `replay_bash.py`. Uploads live at `/root/.claude/uploads/<session>/<uuid8>-<name>`. |
| `SendUserFile` | `files[]`; result has `file_deliveries[]` with `file_uuid`, `path` | `extractDeliveredFiles` lists them and `populateConversationFolder` downloads each by UUID into `artefacts/`. |
| `web_search` | `query` (input) / `content[]` (result) | Renders the query + formatted result list; citations harvested via `processTextWithCitations`. |
| `view` / `read_file` | `path` | Used by `extractBlobContent` to recover ephemeral upload content from tool_result blocks when the wiggle API 404s. |
| `web_fetch`, `str_replace_based_edit_tool`, etc. | varies | Rendered with sensible fallbacks in `convertToMarkdown`; not all are first-class extractors. |

If you add a new tool extractor, follow the same shape: a function `extractFoo(data)` returning a plain map / array; integrate into `populateConversationFolder` and (if it should appear inline) into `convertToMarkdown`.

---

## 6. Artifact extraction with per-turn versioning *(the load-bearing piece)*

This is the part most likely to break or need extending. As of v1.5.2:

**Algorithm** (`extractArtifacts(data, errorCollector?, index?)`):

1. Walk `getMessageChain(data)` in order.
2. Maintain `state[key] = { current, basename, versions: [], editedThisTurn }`. Key is:
   - The full path for `create_file` / `str_replace` / `rewrite` / `bash_tool` heredoc.
   - `artifact:<id-or-title>` for the `artifacts` tool.
3. Skip file tools whose `tool_result` has `is_error`: they changed nothing. Bash commands are never skipped, since a failed one can still have written its heredoc. For each remaining `tool_use` block, update state:
   - `create_file` / `rewrite` / `artifacts create|update` / heredoc → `state[key].current = content; editedThisTurn = true`.
   - `str_replace` → count occurrences of `old_str` in current content. Exactly 1 → replace, mark dirty. 0 → warn `str_replace_failed` ("not found"). >1 → warn `str_replace_failed` ("ambiguous"). This mirrors the real tool's strict semantics.
4. At the end of each message (assistant or human, defensively), any state entry with `editedThisTurn` gets its `current` pushed onto `versions[]` and the flag cleared.
5. After the loop, safety-net sweep for trailing dirty entries.
6. Emit:
   - `versions.length <= 1` → only `<base><ext>` (the single content).
   - Else → `<base>_v1<ext>` … `<base>_vN<ext>` + `<base><ext>` = final state.
7. Disambiguate collisions across distinct keys: each artifact claims every name it writes (`<base><ext>` and, when versioned, each `<base>_vN<ext>`). If any is taken, by another path with the same basename or by a file Claude itself named `report_v1.html`, append `_2`, `_3`, … to the base and emit `artifact_basename_collision`. `extract_artifacts.py` fills an optional `names` dict with the result, and `replay_bash.py` uses it to write to the same files.

**Why per-turn (not per-edit):** matches the natural "Claude finished editing for now" boundary. The bug-fixture conversation has 11 `str_replace` calls split across two assistant turns; per-turn gives 2 useful intermediate versions, per-edit would give 12 noisy ones. If a user requests per-edit later, the snapshot loop is the only place to change.

`index` is optional. When passed an object, it is filled with `{ <state key>: { path, filename, versions, messages } }`, where `messages` is the uuid of the message that made each version. The viewer uses it to link tool calls to artifact versions. The return value is the same with or without it. `extract_artifacts.py` has no equivalent and doesn't need one.

**Invariants the validator skill checks:**
- `md5(_v1<ext>) == md5(initial create_file.file_text)`.
- `md5(<base><ext>) == md5(<base>_vN<ext>)`. Drift here means the exporter regressed back to "stale v1 only".
- Number of files on disk for one logical artifact == `versions.length + (versions.length > 1 ? 1 : 0)`.

**Companion script:** `extract_artifacts.py` is a stdlib-only Python 3 port. Use it to reproduce expected output for any `original.json` and `diff -r` against an export's `artefacts/` for a fast regression check. Both implementations must stay in sync — if you change one, update the other.

---

## 7. ZIP export layout

`populateConversationFolder` writes this layout. Both single-ZIP and mega-ZIP use it (mega-ZIP nests one folder per conversation under the root + an `index.md`). The one difference: in a mega-ZIP, project knowledge files go in a shared root `projects/` folder, so those chat folders aren't self-contained.

```
[<Project>-project]_<conversation>_claude-chat.zip   (project prefix only when in a project)
├── README.md                  # Table of contents
├── meta.md                    # Stats, word counts, features used
├── prompts.md                 # All user prompts with attachment links
├── responses_text_only.md     # Combined pure-text assistant responses
├── full_chat.md               # Complete conversation w/ artifacts as code blocks
├── integrated_chat.md         # Same, but seamlessMd embeds .md artifacts inline
├── integrated_chat.txt        # Plain-text ASCII version
├── code_snippets.md           # All ``` blocks extracted (incl. artifacts)
├── links_and_sources.md       # URLs + web search sources grouped by domain
├── errors.txt                 # Structured error/warning report (omitted if none)
├── original.json              # Raw API payload as fetched
├── viewer.html                # Offline viewer (see below)
├── viewer-check.gif           # 1x1 GIF; the viewer loads it to detect a ZIP that was not unzipped
├── viewer-files/part-NNNN.js  # text of uploads and generated files over UPLOAD_INLINE_LIMIT (64 KB), only when there are some
├── responses/<NNN>_<title>_response.md       (pure text)
├── responses/<NNN>_<title>_response.full.md  (thinking/tools/embedded)
├── artefacts/<base>(_vN)?<ext>               (versioning — see §6)
├── attachments/p01_<filename>, p02_<filename>, ...  (prompt-numbered)
├── project/project.json, prompt_template.md, docs.json, files.json, <doc>.md, files/<name>
└── uploads/p01_<filename>, p02_<filename>, ...
```

`p<NN>_` prefixes group files by the user prompt that introduced them (incremented on `sender === 'human'`).

`viewer.html` and `viewer-check.gif` are written by `writeViewer` once per export, at the root. In a single ZIP that is beside the chat files; in a mega-ZIP, one viewer at the root covers all chats (`populateConversationFolder` returns `viewerChat`, built by `CTViewer.buildViewerChat`). Failure to build never blocks the download: a chat that fails to build gets a `viewer` warning, and a whole-viewer failure shows only in the status line.

Upload text over `UPLOAD_INLINE_LIMIT` (64 KB of UTF-8) is not in `viewer.html` either, nor is the text of a generated file's version over that size, except `.css`/`.js`/`.mjs`, which previews inline from the page. `CTViewer.moveUploadText` swaps an upload for `{ text: null, lines, part, key }` (keys `u0`, `u1`, …) and a file version for `{ text: null, part, key }` (keys `f0`, `f1`, …), in parts of the same format, and both `writeViewer`s write those parts to `viewer-files/` (the tool numbers them after its added-file parts). The viewer loads a part when the upload's popup opens. Search never reads upload text, so it is unaffected; pasted attachments stay inline because search does read them.

`ViewerData.projects` holds each distinct project once, and a chat's `project` is an index into it. `buildViewerData` merges identical projects, so a mega-ZIP doesn't repeat a project's docs per chat, and the viewer's `linkProjects` puts them back on load. `ViewerData.added` lists files the owner put in an archive after export; only the old-archive tool writes it. Each entry is `{ path, chat, kind, size, href, part, key }`, and the viewer shows them under "Archive files". Their text and media are not inlined in `viewer.html`: `build_viewer.js` writes them as `viewer-files/part-NNNN.js` (about 4 MB each, calling `window.__archivePart(n, {...})`), loaded as local scripts. That is why `CTViewer.assembleViewer` takes `fileScripts` (adds `file:` to the page's `script-src` and `media-src`) and `fileMedia` (`media-src` only). Added HTML and SVG are untrusted and run only in the preview sandbox, and the sandboxed preview doesn't load sibling files. The viewer's Open file link goes through the `openableHref` allowlist (`OPENABLE_EXTENSIONS` in `viewer/viewer-logic.js`): only documents, images, audio, video, archives and plain data open. Everything else, HTML and SVG included, has no link. Keep it an allowlist.

Mega-ZIP only:
```
claude-takeout-<YYYY-MM-DD>.zip
├── index.md                   # Master table w/ per-conversation issue counts
├── projects/<project>/        # files/ and files.json, stored once and linked from each chat's README
├── <conversation-folder-1>/   # Same layout as above
├── <conversation-folder-2>/
└── ...
```

---

## 8. API endpoints used

All called with `credentials: 'include'` so the user's existing Claude session authenticates them. No API key.

| Endpoint | Used by | Purpose |
|---|---|---|
| `GET /api/organizations/<orgId>/chat_conversations` | `content.js` `fetchAllConversations` | Bulk export conversation list. |
| `GET /api/organizations/<orgId>/chat_conversations/<convUuid>?tree=True&rendering_mode=messages&render_all_tools=true` | `content.js` `fetchConversation` | Bulk-mode full conversation re-fetch with project metadata included. |
| `GET /api/organizations/<orgId>/projects/<projectUuid>` | `popup.js` `ensureProjectName` + `fetchProjectDocs` | Project metadata, especially `name`. |
| `GET /api/organizations/<orgId>/projects/<projectUuid>/docs` | `fetchProjectDocs` | List of project documents. Empty for uploaded knowledge files. |
| `GET /api/organizations/<orgId>/projects/<projectUuid>/files` | `fetchProjectFileList` | Project knowledge files such as PDFs, downloaded through `/files/<uuid>/contents`. |
| `GET /api/organizations/<orgId>/projects/<projectUuid>/docs/<docUuid>/content` | `fetchProjectDocs` | Full document content (falls back to `/docs/<docUuid>`). |
| `GET /api/organizations/<orgId>/files/<fileUuid>/...` (multiple URL patterns) | `fetchUploadedFile` | PDF/image/etc. blobs. Tries several path shapes including a sanitized-path fallback when the wiggle endpoint 404s. |

If a new endpoint becomes necessary, follow `fetchUploadedFile`'s pattern: try a primary URL, fall back, surface failures via `ExportErrorCollector`, and capture every URL tried in the error report's `urlsTried[]`.

---

## 9. Settings, storage, and the side-panel toggle

`chrome.storage.local` holds:

```jsonc
{
  "orgId": "uuid",
  "exporterSettings": {
    "filenameStyle": "title" | "title_date" | "date_title",
    "includeThinking": true,
    "showShortcuts": true,
    "useSidePanel": false
  },
  "useSidePanel": false  // mirrored at top level so background.js can read it
}
```

- `background.js` watches `chrome.storage.onChanged` for `useSidePanel` and calls `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick })` accordingly.
- The popup checkbox + background worker are kept consistent via `enableSidePanelMode` / `disableSidePanelMode` messages.

---

## 10. Bash mutations and the recovery CLI

The exporter handles three classes of artifact mutation:

- **Declarative tool calls** (`create_file`, `str_replace`, `rewrite`, bash heredoc `cat > path << EOF`) → replayed in `extractArtifacts` to produce per-turn `_vN` snapshots and the unversioned final.
- **Direct sandbox-path references** in artifact text (e.g. `<img src="/mnt/user-data/uploads/foo.png">`) → rewritten to base64 data URIs in `populateConversationFolder`'s inline-pass (Piece A — pure mechanical substitution, no inference).
- **Arbitrary `bash_tool` mutations** (Python heredocs that mutate files via `open().write()`, shell `sed -i`, awk pipelines, etc.) → **the extension does not try to replay these.** `detectOpaqueMutations` flags each one with an `artifact_opaque_mutation` warning in `errors.txt` and points the user at `replay_bash.py`.

The CLI does what the extension can't safely do: runs Claude's actual scripts in a tmpdir with `/home/claude`, `/mnt/user-data`, `/tmp` and `/root/.claude` path-rewritten into it, with per-command confirmation. Commands are untrusted: `sandbox_profile` applies a deny-by-default `sandbox-exec` profile, `sandbox_path` rejects paths and symlinks leaving the tmpdir, and `command_env` keeps tokens out. Never weaken these without saying so in `USAGE.md`. See `docs/WASM_REPLAY_APPROACH.md` for the architectural reasoning (we briefly shipped JS regex-based recipe matchers, then removed them once the CLI proved more reliable and covered more cases).

The detector checks Python writes (`open(p, 'w'|'a'|'x'|'r+', ...)`, `Path(p).write_text/bytes`) on the whole command, and shell writes per simple command (`shellSegments`, which respects quotes): redirects, `sed`/`perl` in place, `tee`, `cp`/`mv`/`install` onto the file, `dd of=`. Heredocs themselves (header and body) are removed before these checks, and a heredoc with an unquoted delimiter whose body has `$`, a backtick or `\\` is flagged, since bash expanded it. If you change the opaque-mutation detector's heuristics: keep them tight. The signal it produces is the only thing pointing users at the CLI, and a missed signal means a silently-incomplete export.

## 11. Error reporting (`ExportErrorCollector`)

Anywhere in `populateConversationFolder` (or any function it calls) you can record:

```javascript
errorCollector.addError(type, filename, error, { uuid, path, urlsTried, httpStatus, fallbackAttempted, fallbackResult, rawError });
errorCollector.addWarning(type, filename, message, { uuid, path, note });
```

Recognized `type` values (all map to a case in `_getRecoveryHint`):
- `upload` — uploaded-file download failed.
- `presented_file` — `present_files` blob extraction failed.
- `project_doc` — project document fetch failed (or only available truncated from view tool results).
- `project_metadata` — `/projects/<uuid>` 4xx/5xx; `project.json` may be missing.
- `str_replace_failed` — an edit that succeeded in the conversation couldn't be replayed. Cleared if the file is then downloaded in its final state.
- `artifact_basename_collision` — two paths produced the same basename; one was renamed.
- `artifact_opaque_mutation` — a bash command changed an artifact in a way replay can't follow.
- `delivered_file` — a `SendUserFile` delivery could not be downloaded.
- `viewer` — one chat could not be added to `viewer.html` (`buildViewerChat` threw). A failure of `writeViewer` as a whole is not recorded here: the status line says "viewer.html could not be built." The export itself is complete.

`errors.txt` is built by `generateErrorReport()` and embedded into the ZIP only when `hasAny()` is true. The status pill turns amber (`.status.warning`) when there are warnings but the export still succeeded.

**Rule for new failures:** add a new `type`, add a `_getRecoveryHint` case, and make sure the `addWarning`/`addError` call site passes the useful `details` fields. Never silently swallow a fetch failure — surface it.

---

## 12. Encoding rules

- **All `.md` files written to ZIPs get a UTF-8 BOM** (`addFileWithBOM`). Reason: Chrome's `file://` opens markdown as text/plain and infers encoding from the BOM. Without it, em-dashes and umlauts mojibake when opening exports locally.
- **All text content is run through `fixMojibake`** at extraction time (text attachments, project docs, etc.). Map is built lazily on first use and covers Latin/Greek/Cyrillic/math/box-drawing/arrows/super-sub/emoji ranges.
- **Never decode a binary file as text:** `addArtefactBlob` keeps raw bytes unless `isTextFile` recognizes the extension. Calling `blob.text()` on a PDF, ODT or ZIP destroys it, and `file` still reports the type because the header survives. Test with `unzip -t` or a real viewer.
- **Code fences are dynamic:** `getCodeFence(content)` returns ```` ` ```` x4 when content already contains a triple backtick. Apply this whenever you emit a fenced block whose content is user/Claude-supplied.

---

## 13. Conventions

- **Commit message style** (see `git log`):
  - One-line subject summarizing the user-visible effect.
  - Bullet body describing each significant change.
  - A `Co-Authored-By` trailer naming the model that did the work.
  - Use HEREDOC for the `-m` arg to preserve formatting.
- **No automatic pushes.** Commit freely; only push when the user explicitly says so.
- **No mass `git add .`** — stage the specific tracked files plus any new files that genuinely belong to the project. Never accidentally commit `.claude/`, transcripts, or `.DS_Store`.
- **Tests:** run `sh tests/run.sh` before committing. See `tests/README.md`. Never put real conversations or exports in the repo, because they're private; add a synthetic case to `tests/fixtures/conversation.json` instead. Mocks have missed real claude.ai behavior here, so also export a real conversation for anything touching fetching or capture. `extract_artifacts.py` and the `validate-export` skill at `~/.claude/skills/validate-export/SKILL.md` must stay in sync with `export-core.js`. `tests/export.test.js` also pins every file an export writes against `tests/fixtures/export-baseline.json` (refresh steps in `tests/README.md`).
- **No `_`-prefixed files or folders:** Chrome refuses to load an extension containing one, including `__pycache__`. Run Python with `-B`, and never import these scripts without `sys.dont_write_bytecode = True`.
- **Viewer rendering:** the viewer renders chat text through escaped raw HTML, text-node placeholders and `sanitizeHtml`. Keep all three when changing it. `tests/e2e/viewer.e2e.js` is the only coverage for `sanitizeHtml`, so run it after viewer changes. The viewer page's CSP keeps `'unsafe-inline'` and `'unsafe-eval'` for scripts, and `'unsafe-inline'` for styles, because `srcdoc` previews inherit the page's policy and `PREVIEW_CSP` can only narrow it; removing either breaks previews (`new Function` in a generated file). Previews are sandboxed but not a security boundary for untrusted exports: a generated file's own text and that chat's `.js` and `.css` can leave, while the viewer, other chats and files on disk can't be reached (see `USAGE.md`).
- **Syntax colors:** highlight.js can run for minutes on some text, such as one very long word, so never call it on the page. It runs in a blob worker (`worker-src blob:`) built from the `#highlighter` script tag, one block at a time, and is stopped after `HIGHLIGHT_TIMEOUT`. Colors only appear as a block scrolls into view, and any failure leaves the block plain. Unlabeled fences are not guessed. Before first use the worker runs `tameMarkdown` (in `viewer-logic.js`, passed in as source), which stops `_` inside a word from opening italics and ends italics and bold at a blank line. `tests/e2e/colors.e2e.js` covers this.
- **Syntax check after every edit:** `node --check popup.js`. Catches most copy/paste mistakes without launching Chrome.

---

## 14. Keeping TECHNICAL.md accurate

`TECHNICAL.md` describes how each part of an export is built, current as of v1.6.9. It names functions instead of copying their code, so it doesn't go stale with every edit. When you change behavior it describes (data loading, versioning, the download order in `fetchUploadedFile`, the ZIP layout, warning types, the viewer, the old-archive tool), update its section in the same PR. This file stays the entry point.

---

## 15. Where to look for common tasks

| You want to… | Look at |
|---|---|
| Add a new export format | `popup.html` (button) + `popup.js` click handlers + a new `generate<Format>` function + bulk path in `bulkExport`. |
| Render a new tool call inline | `convertToMarkdown`, in the `tool_use` branch. |
| Extract a new file type to disk | New `extract<Foo>(data)` function; call site in `populateConversationFolder`; possibly a new folder under the ZIP layout. |
| Add a new API fetch with retry | Pattern-match `fetchUploadedFile`: primary URL, fallbacks, per-URL `urlsTried`, surface failures via `errorCollector`. |
| Change versioning rules for artifacts | `extractArtifacts` (§6). Also update `extract_artifacts.py` to match. Re-run validation against the `Sudden_acid_reflux_in_young_adults` fixture if available locally. |
| Adjust the ZIP layout | `populateConversationFolder`. README's "ZIP Archive" section is the user-facing contract — update it too. |
| Change the offline viewer | `viewer/` (page), `takeout-viewer.js` (data contract), `writeViewer` in `popup.js`. Update `tests/viewer.test.js`, run `tests/e2e/viewer.e2e.js`, and keep the `USAGE.md` preview note accurate. |
| Change the old-archive tool | `tools/build_viewer.js`, `tools/archive-lib.js`, `tools/archive-zip.js`. Never let it write anything but `viewer.html`, `viewer-check.gif`, `viewer-files/` and new folders under `--out`. Update `tests/archive.test.js`, run `tests/e2e/archive.e2e.js`, and keep the USAGE.md section "Adding a viewer to older archives" accurate. |
| Add a setting | Add to `defaultSettings`, `loadSettings`, `applySettings`, `popup.html` settings drawer markup, optional `sidepanel.html` markup, and the change handler block. |
| Add a keyboard shortcut | The `keydown` switch and the `<span class="shortcut">` markup in the relevant button. |
| Bump README's changelog | Add a `### v<next>` section at the top of the changelog, and bump `manifest.json` in the same PR. |

---

## 16. Known fixtures / test conversations on this machine

- `~/Downloads/claude-takeout-2026-06-02/Sudden_acid_reflux_in_young_adults/original.json` — the per-turn versioning fixture. Two edited artifacts (`daily-supplement-protocol.html`: 3 versions; `anxiety-reflux-reference.html`: 6 versions). `md5(daily-supplement-protocol_v1.html) == dad1c8cccfdf02a55a20d1f0d95d7465`.
- `~/Downloads/[nr_5-project]_de_verbo_interno_claude-chat 2/original.json` — the "abandoned draft artifact" example (Claude `create_file`s a near-empty stub `diagrams.html`, then creates the real `canonical-lorber-diagrams.html`). Useful for exercising the basename-collision warning if you ever route those through the same key.

Both can be re-validated with:

```
python3 extract_artifacts.py path/to/original.json -o /tmp/expected/
diff -r /tmp/expected/ path/to/export/artefacts/
```

A clean diff (or only the unversioned-final equivalent to `_vN`) means the JS extractor is in sync with the Python port.

---

*Last updated 2026-11-08. Keep this file accurate — it's the contract a future agent reads before touching anything.*
