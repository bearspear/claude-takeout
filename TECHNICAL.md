# Claude Takeout - Technical Documentation

How Claude Takeout gets a conversation from claude.ai, what the conversation JSON looks like, and how each part of an export is built from it. Current as of v1.6.20.

This document describes behavior and names the functions that implement it, rather than copying their code. Search for a function name to find it. `CLAUDE.md` is the shorter developer primer, with the file map and conventions. `README.md` has the user-facing changelog.

## Table of Contents

1. [Getting the data](#getting-the-data)
2. [JSON structure](#json-structure)
3. [Message chain resolution](#message-chain-resolution)
4. [Content blocks](#content-blocks)
5. [Artifact extraction and versioning](#artifact-extraction-and-versioning)
6. [Files](#files)
7. [Web search and citations](#web-search-and-citations)
8. [Metadata](#metadata)
9. [ZIP export](#zip-export)
10. [Error reporting](#error-reporting)
11. [Bash mutations and replay_bash.py](#bash-mutations-and-replay_bashpy)
12. [The offline viewer](#the-offline-viewer)
13. [Viewers for older archives](#viewers-for-older-archives)
14. [Security](#security)
15. [Limitations](#limitations)
16. [API endpoints](#api-endpoints)

---

## Getting the data

claude.ai loads conversations over an RPC stream (`/claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/StreamTimeline`) that the extension can't read. Earlier versions captured conversations by wrapping the page's `fetch`; that no longer sees anything and was removed. All conversation data now comes from the REST API, called from the extension with the user's own session cookies (`credentials: 'include'`). There is no API key and no server of ours.

```
claude.ai tab                           popup.js (popup or side panel)
├─ injected.js (page world)             ├─ reads the chat ID from the tab URL
│    reads the org ID from fetch URLs   ├─ asks content.js for that chat
│         │ postMessage                 ├─ extracts, transforms, writes the ZIP
│         ▼                             └─ downloads it
└─ content.js (isolated world)  ◀── chrome messaging ──┘
     resolves the org ID, calls the REST API
```

- **Org ID:** `content.js`'s `getActiveOrgId` reads the `lastActiveOrg` cookie first, then the ID `injected.js` saw in a request URL, then the one stored from an earlier visit.
- **One chat:** `requestData` matches `/chat/<uuid>` in the tab URL. Each export button calls `loadConversationForExport`, which fetches the chat again through `content.js`'s `fetchConversation`, and fails rather than export an older copy.
- **Full payload:** `fetchConversation` adds `?tree=True&rendering_mode=messages&render_all_tools=true`, which returns every branch and the rendered tool calls.
- **Project name:** a payload often has `project_uuid` but no `project.name`. `ensureProjectName` fetches the project and sets `data.project = { uuid, name }` before the filename is made. Every single-chat handler and both bulk loops call it.
- **All chats:** `fetchAllConversations` lists the chats, and the bulk exports fetch each one in turn, 300 ms apart.
- **Stale tabs:** a tab open across an extension reload has no working content script. `sendToTab` injects `content.js` again on a connection error.

---

## JSON structure

Top level:

```javascript
{
  "uuid": "7cdf01ac-dda9-4910-982c-fd498973a1c6",
  "name": "Conversation Title",
  "model": "claude-sonnet-4-5-20250929",       // may be absent
  "created_at": "2025-11-28T17:05:46.423148+00:00",
  "updated_at": "2025-11-28T17:11:07.540785+00:00",
  "current_leaf_message_uuid": "019acb72-...",
  "settings": {
    "enabled_web_search": true,
    "paprika_mode": "extended",                // "extended", "normal", or absent
    // other feature flags
  },
  "project_uuid": "...",                       // when the chat is in a project
  "project": { "uuid": "...", "name": "..." }, // sometimes; see ensureProjectName
  "chat_messages": [ /* every message, every branch */ ]
}
```

Each message:

```javascript
{
  "uuid": "msg-uuid",
  "parent_message_uuid": "previous-msg-uuid",
  "sender": "human" | "assistant",
  "created_at": "ISO timestamp",
  "content": [ /* content blocks */ ],
  "attachments": [ /* pasted text, with extracted_content */ ],
  "files": [ /* older uploads */ ],
  "files_v2": [ /* newer uploads */ ]
}
```

| Field | Meaning |
|---|---|
| `current_leaf_message_uuid` | The last message of the branch the user is on. |
| `settings.paprika_mode` | Thinking mode: `"extended"`, `"normal"`, or absent. |
| `chat_messages` | A flat list of every message ever made, including regenerated ones. |

---

## Message chain resolution

Regenerating a response makes a branch, so `chat_messages` holds a tree linked by `parent_message_uuid`. `getMessageChain(data)` in `export-core.js` returns the branch the user is on:

1. Index the messages by `uuid`.
2. Start at `current_leaf_message_uuid` and follow `parent_message_uuid` until it leaves the list.
3. Reverse, for chronological order.

If the leaf is missing or unknown, it returns `chat_messages` as given.

Everything that renders the conversation uses this chain. A few whole-chat scans, such as finding uploads or project files Claude read, go through every message instead, since branch order doesn't matter there. The viewer keeps every branch and lets the reader switch between them.

---

## Content blocks

Each message's `content` is a list of typed blocks:

| `type` | Key fields | Notes |
|---|---|---|
| `text` | `text`, `citations[]` | See [citations](#web-search-and-citations). |
| `thinking` | `thinking`, `summaries[]`, `cut_off` | The last summary is the label shown. Exported under "Thought process" when `includeThinking` is on. |
| `tool_use` | `id`, `name`, `input` | Tool calls. |
| `tool_result` | `tool_use_id`, `name`, `content[]`, `is_error` | Match a result to its call by `tool_use_id`, not by position. |

Tools the exporter understands:

| `name` | `input` | Used for |
|---|---|---|
| `create_file` | `path`, `file_text` | Starts or replaces an artifact. |
| `str_replace` | `path`, `old_str`, `new_str` | Edits an artifact. |
| `rewrite`, `create_or_overwrite` | `path`, `file_text` or `content` | Replaces an artifact. |
| `Write` / `Edit` | `file_path`, `content` / `old_string`, `new_string`, `replace_all` | Newer names for the same two operations. |
| `artifacts` | `command` (`create`, `update`, `rewrite`), `id`, `title`, `type`, `content`, `old_str`, `new_str` | Older artifact tool, keyed `artifact:<id or title>`. An `update` usually carries an `old_str`/`new_str` edit. |
| `bash_tool` / `Bash` | `command` | A `cat > path << DELIM` or `cat << DELIM > path` heredoc counts as a file write (`heredocMatches`). Other changes are flagged; see [bash mutations](#bash-mutations-and-replay_bashpy). |
| `present_files` | `filepaths[]`; result has `local_resource` items | Files Claude showed the user; downloaded when replay didn't make them. |
| `SendUserFile` | `files[]`; result has `file_deliveries[]` | Files Claude sent; downloaded by UUID. |
| `…Claude_Docs__batch`, `__update`, `__create` | the document's Markdown with placeholders; section replacements; comments | A Claude Docs document, rebuilt into `artefacts/<title>.md` and `<title>.html`. |
| `view` / `read_file` | `path` | Its result may hold the text of an upload or project file. |
| `web_search`, `web_fetch` | `query`, `url` | Sources and citations. |

`convertToMarkdown` renders all of them, with fallbacks for tools it doesn't know.

---

## Artifact extraction and versioning

`extractArtifacts(data, errorCollector?, index?)` in `export-core.js` rebuilds every file Claude wrote, at every turn where it changed. `extract_artifacts.py` is a stdlib-only Python port with byte-identical output. Keep the two in sync.

**Algorithm:**

1. Walk `getMessageChain(data)` in order.
2. Keep `state[key] = { current, basename, versions, editedThisTurn }`. The key is the full path for file tools and heredocs, and `artifact:<id-or-title>` for the `artifacts` tool.
3. Skip file tools whose `tool_result` has `is_error`, since they changed nothing. Bash commands are never skipped, because a failed command can still have written its heredoc.
4. Apply each call:
   - A write (`create_file`, `rewrite`, `Write`, `artifacts create|update`, heredoc) sets `current`.
   - An edit (`str_replace`, `Edit`, or an `artifacts` `update` with `old_str`) needs `old_str` exactly once in `current`, as the real tool does. With 0 or more than 1 matches, the edit is skipped and a `str_replace_failed` warning is recorded. The warning is cleared if the file was later downloaded in its final state.
5. At the end of each message, every key edited in it gets a snapshot pushed onto `versions`.
6. Write out:
   - one version → `<base><ext>`
   - several → `<base>_v1<ext>` … `<base>_vN<ext>`, plus `<base><ext>` holding the final state
7. Each key claims every name it writes, `<base><ext>` and its `_vN` names. If any is taken, by another key with the same basename or by a file literally named `report_v1.html`, the base gets `_2`, `_3`, … and an `artifact_basename_collision` warning.

Snapshots are per turn, not per edit, because a turn is where Claude has "finished editing for now". A chat with 11 edits over 2 turns gives 2 useful versions instead of 12.

`artifacts` tool filenames come from `typeToExt` (a MIME type to extension map, `.txt` when unknown) applied to the title or ID.

When `index` is an object, it is filled with `{ key: { path, filename, versions, messages } }`, where `messages` lists the message that made each version. The viewer uses it to link tool calls to file versions.

**Invariants** (checked by the `validate-export` skill): `_v1` equals the first write, and the unversioned file equals `_vN`.

---

## Files

### Pasted text (`attachments`)

Text pasted into a prompt arrives with its text in `extracted_content`. `extractTextAttachments` writes each to `attachments/p<NN>_<name>`, where `NN` is the prompt number. A paste with no name gets a generated one. Office and PDF names whose text is all there is (`.pdf`, `.docx`, `.xlsx`, …) are saved as `.txt`. The viewer calls an unnamed paste "Pasted text".

### Uploads (`files`, `files_v2`)

`extractUploadedFiles` lists uploads from both arrays: `files` is the older form, with the name in `path`, and `files_v2` the newer, with `file_name`. Each is downloaded to `uploads/p<NN>_<name>`.

`fetchUploadedFile` tries these URLs in order and records every one it tried:

1. The asset URL from the JSON (`image_asset.url`, `document_asset.url`), when present. It may have expired.
2. The wiggle endpoint by sandbox path: `/api/organizations/<org>/conversations/<chat>/wiggle/download-file?path=<path>`, with `(` and `)` encoded too.
3. The same with the filename sanitized the way the sandbox does it (non-alphanumerics become `_`).
4. By file UUID: `/api/organizations/<org>/files/<uuid>/contents`, then older shapes (`/api/<org>/files/<uuid>/preview`, `/content`, `/api/organizations/<org>/files/<uuid>/content`, and the bare file URL).

If all fail, `extractBlobContent` looks for a full read of that file in the chat: a `Read` without offset or limit, or a `view` without `view_range` whose header names the file (the sandbox may have replaced odd characters with `_`). It rebuilds the text by stripping the line numbers. Directory listings and partial reads are never used. A file Claude never read and that the API no longer serves is lost; it is recorded as an `upload` error.

Binary files keep their bytes. `isTextFile` decides by extension, and only text files are decoded. Decoding a PDF as text destroys it.

### Sandbox paths inside artifacts

An artifact that refers to an upload by its sandbox path (`<img src="/mnt/user-data/uploads/photo.png">`) gets that path replaced with the upload's `data:` URI (`inlineSandboxPaths`), so the file works when opened from the export. This is plain substitution, not a guess at what the code meant.

### Files Claude made (`present_files`, `SendUserFile`)

`extractPresentedFiles` lists the files in `present_files` results (`local_resource` items). One the replay already rebuilt is kept as is, unless that file has a `str_replace_failed` or `artifact_opaque_mutation` warning: then the presented copy is downloaded and replaces the final file and its last `_vN`. Any other, such as a file a Python script wrote, is downloaded through `fetchUploadedFile` by its sandbox path into `artefacts/`. Two presented files with one name from different folders become `<base>_2<ext>` with an `artifact_basename_collision` warning. A download is the file's final state, so it clears that file's `str_replace_failed` warnings. `extractDeliveredFiles` lists `SendUserFile` deliveries, which are downloaded by UUID into `artefacts/`, with a `delivered_file` error on failure.

### Claude Docs documents

Claude Docs, the editable documents on claude.ai, live there rather than in a sandbox, so the export rebuilds each one from its tool calls (`claudeDocCreated`, `renderClaudeDoc` in export-core.js; `extract_artifacts.py` mirrors them). A `batch` call creates the document from Markdown in which `<?claude block k?>` placeholders stand for a date, an author mention or a pending section; its result begins with JSON whose `acks` give the document's node id and an XML outline with the pending sections' ids, followed by plain instructions for Claude. Each `update` replaces one pending section, by that id, with Markdown, and each `create` on the document adds a comment. The rebuilt text fills the placeholders (dates as written, mentions left out, unwritten sections noted), then appends the comments and the link to the live document. Chips a section brings with it (`with.blocks`) are filled in the same way, and a comment's later lines are indented so it stays one list item. It is versioned per turn like any artifact, under the key `doc:<node id>`, and saved as its title made safe by `safeFileTitle` (letters, digits and marks from any script). When the batch's result is missing, the document is still written, under `doc:pending:<call id>`, with its sections shown as not written and a `claude_doc_unreplayed` warning. An edit of another kind (a batch on an existing document, an update with no section text, any other operation) is not replayed and warns `claude_doc_unreplayed`, once per document. In `full_chat.md` a document is linked by the name it was saved under; a single Markdown file links the live document. `populateConversationFolder` also writes `<title>.html`, a self-contained page rendered with `marked`: raw HTML shown as text (an inline tag never switches marked into copying raw text), only web and mail links and https images kept, attributes escaped once, and a CSP with no script. Its name is unique among the artefacts whatever the case, and README.md lists it.

### Project files

For a chat in a project, `populateConversationFolder` writes `project/`:

- `project.json` and `prompt_template.md` from `/projects/<uuid>` (metadata failure → `project_metadata` warning)
- documents from `/projects/<uuid>/docs`, each read from `/docs/<doc>/content` (falling back to `/docs/<doc>`), as `<doc>.md` and `docs.json`
- knowledge files such as PDFs from `/projects/<uuid>/files`, downloaded through `/files/<uuid>/contents` into `project/files/`, with `files.json`

If the API doesn't return a document, `extractProjectFiles` falls back to the text of any `/mnt/project/...` file Claude read with `view` (a `project_doc` warning notes it may be partial). In a mega-ZIP, knowledge files go into one shared `projects/<project>/` folder at the root.

---

## Web search and citations

`extractWebSources` collects `knowledge` items from `web_search` results: title, URL, `metadata.site_domain`, `metadata.site_name`, `is_citable`, `is_missing`. Each URL is kept once. `links_and_sources.md` groups them by domain.

A `text` block's `citations[]` items carry `start_index`, `end_index`, `url`, `title` and `metadata`. `processTextWithCitations` numbers each distinct URL once, in order of first appearance, and inserts a linked marker at each citation's end, with backlinks from the reference list. `formatReferences` writes that list. The viewer does the same in `addCitations`.

---

## Metadata

- **Model:** `getModelName` turns `claude-sonnet-4-5-20250929` into "Claude 4.5 Sonnet". Without a `model` field it falls back to `paprika_mode` ("Claude (extended thinking)", "Claude (thinking)"), then to thinking blocks, then "Claude".
- **Features** in `meta.md`: Web Search when a search ran, Artifacts when any were made, and the thinking mode.
- **Stats** in `meta.md`: message, word and code-block counts, duration, files.

---

## ZIP export

`populateConversationFolder` writes one chat's folder. The single-chat ZIP is that folder; the all-chats mega-ZIP holds one per chat, plus `index.md`, the shared `projects/` folder, and one viewer for all of them.

```
[<Project>-project]_<chat>_claude-chat.zip
├── README.md                  table of contents
├── meta.md                    stats, model, features
├── prompts.md                 every prompt, with attachment links
├── responses_text_only.md     the assistant's text only
├── full_chat.md               everything, artifacts as code blocks
├── integrated_chat.md         .md artifacts inline
├── integrated_chat.txt        plain text
├── code_snippets.md           every code block
├── links_and_sources.md       URLs and sources by domain
├── errors.txt                 only when something failed
├── original.json              the payload as fetched
├── viewer.html                offline viewer
├── viewer-check.gif           detects a ZIP opened without unzipping
├── viewer-files/part-NNNN.js  only when an upload's text is over 64 KB
├── responses/NNN_<title>_response.md, .full.md
├── artefacts/<base>(_vN)<ext>
├── attachments/pNN_<name>
├── uploads/pNN_<name>
└── project/
```

Encoding rules:

- Every `.md` file gets a UTF-8 BOM (`addFileWithBOM`), because Chrome opens local Markdown as plain text and guesses the encoding.
- Text goes through `fixMojibake`, which repairs UTF-8 that was read as Latin-1.
- `getCodeFence` makes a fence one backtick longer than the longest run in the content.
- Every name from chat data that becomes a path in the ZIP goes through `zipSafeName` (`/`, `\\` and control characters become `_`; `.` and `..` become `_`). File and folder names from titles keep letters from any script.

---

## Error reporting

`ExportErrorCollector` collects errors (something is missing) and warnings (something may be incomplete) during one export. `generateErrorReport` writes them to `errors.txt` with a recovery hint per type, and the status pill turns amber.

| Type | Meaning |
|---|---|
| `upload` | An upload could not be downloaded. |
| `presented_file` | A `present_files` file could not be downloaded. |
| `delivered_file` | A `SendUserFile` delivery could not be downloaded. |
| `project_doc` | A project document is missing or only partly recovered. |
| `project_metadata` | The project's metadata request failed. |
| `str_replace_failed` | A successful edit could not be replayed. |
| `artifact_basename_collision` | Two paths had the same filename; one was renamed. |
| `artifact_opaque_mutation` | A bash command changed a file in a way replay can't follow. |
| `claude_doc_unreplayed` | A Claude Docs edit could not be rebuilt from the chat; the note links the live document. |
| `viewer` | One chat could not be added to `viewer.html`. |

Each error records the URLs tried, HTTP status and fallback result. A new kind of failure gets a new type and a `_getRecoveryHint` case.

---

## Bash mutations and replay_bash.py

The extension replays only file tools and heredocs. When a bash command changes a tracked file any other way (a Python script, `sed -i`, a pipeline), `detectOpaqueMutations` records `artifact_opaque_mutation` and points to `replay_bash.py`.

`cat` heredocs are removed from a command before it is checked, and a heredoc with an unquoted delimiter whose body bash would expand is flagged too. The shell checks also drop every other heredoc's body (a Python script is checked as Python) and split each simple command into words with `shellWords`, so quoted text is never a redirect. Every tracked file a command changes gets a warning. Python `Path` variables, `open(file=...)`, `./name`, globs and `awk -i inplace` are recognized.

`replay_bash.py` reruns Claude's actual commands from `original.json` in a temporary folder, with `/home/claude`, `/mnt/user-data`, `/tmp` and `/root/.claude` mapped into it, asking before each command. Commands are untrusted. On macOS a deny-by-default `sandbox-exec` profile isolates them, paths leaving the folder are refused, results are read back without following any link (`read_sandbox_text`), and tokens are kept out of the environment. On Linux it refuses to run without `--no-isolation`. It updates the final file and its last `_vN`. `docs/WASM_REPLAY_APPROACH.md` explains why this is a CLI and not in-browser Python.

---

## The offline viewer

Every export includes `viewer.html`, a single page that shows the chats as they looked, opened from disk with no network.

**Building it.** `takeout-viewer.js` (`CTViewer`) holds the data contract:

- `buildViewerChat` turns one payload into the viewer's shape: every branch, rendered tool calls, file versions, uploads, the project.
- `buildViewerData` gathers the chats and stores each distinct project once in `data.projects`; a chat's `project` is an index into it. Projects are grouped by a cheap key, then compared in full only within a group.
- `moveUploadText` moves upload text, and generated-file version text other than stylesheets and scripts, over `UPLOAD_INLINE_LIMIT` (64 KB of UTF-8) into parts of at most `PART_LIMIT` (4 MB). Each part is `viewer-files/part-NNNN.js`, which calls `window.__archivePart(n, { u0: text, ... })`.
- `assembleViewer` inlines the template, the data (`<script id="data">`), the app, `marked`, KaTeX and highlight.js into one HTML string. `writeViewer` in `popup.js` adds it to the ZIP.

A chat that fails to build gets a `viewer` warning. A viewer that fails as a whole is reported in the status line. Neither stops the export.

**Running it.** `viewer/viewer-app.js` renders the page, and `viewer/viewer-logic.js` holds its pure functions (tested in Node):

- Chat text goes through escaped HTML, text placeholders and `sanitizeHtml`.
- Math renders with KaTeX.
- Syntax colors run in a blob worker, block by block as they scroll into view, and stop after `HIGHLIGHT_TIMEOUT`, since highlight.js can hang on some input. `tameMarkdown` keeps an underscore inside a word from turning the rest of a Markdown file italic.
- The Files button lists a chat's files (`chatFiles` in viewer-logic.js): outputs from its file cards, each once, ordered by the last card that shows it, and its uploads and pasted texts, each once. `buildViewerChat` marks each file `shared` when Claude sent it, presented it, saved it under `/mnt/user-data/outputs/` or made it with the artifacts tool; the others are listed as working files. A viewer built before the mark lists everything as outputs.
- Popups and the file panel have a Copy button for a whole text file. It copies the source even in Preview.
- Search reads titles, prompt and reply text, attachment names and text, and upload names. It never reads upload or file text, which is why that text can live in parts. `parseQuery` turns a query into words that must all appear, `"phrases"`, `OR` alternatives and `-exclusions`; `searchChats` matches each title or message against it; `groupHits` groups the hits by chat and ranks them (title match, then most messages, then newest). Opening a hit starts the match bar: `findPlan` lists the chat's messages whose shown text matches (`shownText`: math and link and image addresses left out, kept per message for the next keystroke), with `countLower` occurrences each, and `markNth` marks one occurrence at a time in what the page shows (prose and prompt bubbles, not KaTeX), moving on when one isn't shown. When nothing further is shown in a direction, the bar returns to the last match it showed and turns that direction off. `foldCase` maps matches back to the text where lowercase changes its length. Only code blocks holding a match lose their colors while stepping, and `clearMarks` brings them back when the search ends.
- `start` parses the data script once and removes it, so the page doesn't keep the text beside the parsed copy.
- A part loads when its upload or file is opened, through a `<script>` tag. The last two loaded parts are kept (`PARTS_KEPT`); an older one loads again when needed. A `file://` page can load scripts beside it but can't `fetch` them.
- Generated HTML and SVG files preview in a sandboxed `srcdoc` frame with a narrow CSP. Sibling `.js` and `.css` files are inlined by `inlineSiblings`.

The page's CSP allows no network. `file:` is added to `script-src` only when parts exist (`fileScripts`).

---

## Viewers for older archives

`tools/build_viewer.js` gives an export made before v1.6.0 a viewer, offline, from its `original.json` files:

```
node tools/build_viewer.js <folder> [--out <dir>] [--force] [--dry-run] [--json]
```

- `tools/archive-lib.js` finds archives and rebuilds each chat from disk (`chatFromDisk`). Artifacts, uploads and project files are read from the archive's own folders.
- Files the owner added to an archive after export are listed under "Archive files". Their text and media go into `viewer-files/` parts.
- `tools/archive-zip.js` extracts ZIPs into new folders under `--out`, refusing unsafe entries.
- The tool writes only `viewer.html`, `viewer-check.gif`, `viewer-files/` and new folders under `--out`, through temporary names that are swapped in.

The `build-archive-viewer` skill wraps it.

---

## Security

- **Authentication:** the user's own claude.ai session cookies. No API key is stored.
- **Locality:** all processing happens in the browser. Nothing is sent anywhere but claude.ai, and the download goes straight to the Downloads folder.
- **Markdown:** filenames are sanitized, and code fences grow to fit their content.
- **Viewer:** chat text is sanitized. Previews of generated files are sandboxed, but they are not a security boundary for untrusted exports: a generated file's own text, and that chat's `.js` and `.css` files, can leave the page. The viewer itself, other chats and other files on disk can't be reached. `USAGE.md` has the details.
- **`replay_bash.py`:** see above.

---

## Limitations

1. An upload Claude never read is lost if the API no longer serves it.
2. A project document the API doesn't return is recovered only if Claude read it, and only as far as it read.
3. Only the active branch goes into the Markdown files. `original.json` and the viewer keep every branch.
4. Bash changes other than heredocs need `replay_bash.py`.
5. Images in tool results are links in the payload, not data, and are not exported.
6. Cowork sessions are not in the chat list and can't be exported.
7. Bulk export waits 300 ms between chats.

---

## API endpoints

All `GET`, all authenticated by session cookie.

| Endpoint | Used by | Purpose |
|---|---|---|
| `/api/organizations/<org>/chat_conversations` | `fetchAllConversations` | List chats. |
| `/api/organizations/<org>/chat_conversations/<chat>?tree=True&rendering_mode=messages&render_all_tools=true` | `fetchConversation` | One chat, every branch, rendered tools. |
| `/api/organizations/<org>/projects/<project>` | `ensureProjectName`, `fetchProjectDocs` | Project metadata. |
| `/api/organizations/<org>/projects/<project>/docs` | `fetchProjectDocs` | Project documents. |
| `/api/organizations/<org>/projects/<project>/docs/<doc>/content` | `fetchProjectDocs` | A document's text (falls back to `/docs/<doc>`). |
| `/api/organizations/<org>/projects/<project>/files` | `fetchProjectFileList` | Project knowledge files. |
| `/api/organizations/<org>/files/<file>/contents` | `fetchUploadedFile`, project files, deliveries | A file's bytes. |
| `/api/organizations/<org>/conversations/<chat>/wiggle/download-file?path=<path>` | `fetchUploadedFile` | A sandbox file by path, including session-only uploads. |
| `/api/<org>/files/<file>/preview`, `/content`; `/api/organizations/<org>/files/<file>/content`, `/files/<file>` | `fetchUploadedFile` | Older fallbacks. |
