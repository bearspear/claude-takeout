# Claude Takeout - Technical Documentation

How Claude Takeout gets a conversation from claude.ai, what the conversation JSON looks like, and how each part of an export is built from it. Kept current; last checked at v1.23.0, its viewer section updated for v1.24.0, with sessions added for v1.25.0.

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
10. [The panel](#the-panel)
11. [Error reporting](#error-reporting)
12. [Bash mutations and replay_bash.py](#bash-mutations-and-replay_bashpy)
13. [The offline viewer](#the-offline-viewer)
14. [Viewers for older archives](#viewers-for-older-archives)
15. [Security](#security)
16. [Limitations](#limitations)
17. [API endpoints](#api-endpoints)

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
| `…show_widget` (visualize) | `title`, `widget_code` (an SVG or HTML fragment) | A diagram Claude drew in the chat, saved as `artefacts/<title>.svg` or `.html` (`widgetFile`), versioned under `widget:<title>`. |
| `image_search` | `query`; result has `images[]` (`title`, `url`, `thumbnail_url`, `page_url`, `source`) | Saved in `images/` with permission and shown under the search; listed as links otherwise. |
| `…publish_files` (claude-artifacts) | `files[]` (`path`, `as`), `title`; result's JSON has `slug`, `version`, `url`, `title` (an old result only a `url`: the live version) | A page Claude published on claude.ai (`isPublishTool`, `publishedPagesOf`); each version is saved by `savePublishedPages`, and the Markdown links the saved copy. |
| `Artifact` (claude.ai's publish tool) | `file_path`, `description`, `icon`; or `action: "open"`, `url` | A publish (`isArtifactPublish`) is read from its reply text "Published <path> at https://claude.ai/artifact/<id> (Version N, version id <ver>)" (`artifactPublishReply`) and saved like `publish_files`. An open publishes nothing. |
| `…edit_version` | `slug` | Edits a published artifact; nothing is replayed, and `artifactLinksOf` links it as edited. |
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
3. Skip file tools whose `tool_result` has `is_error`, since they changed nothing. A bash command's `cat >` heredocs are never skipped, because a failed command can still have written them.
4. Apply each call:
   - A write (`create_file`, `rewrite`, `Write`, `artifacts create|update`, heredoc) sets `current`.
   - An edit (`str_replace`, `Edit`, or an `artifacts` `update` with `old_str`) needs `old_str` exactly once in `current`, as the real tool does. With 0 or more than 1 matches, the edit is skipped and a `str_replace_failed` warning is recorded. The warning is cleared if the file was later downloaded in its final state.
   - A bash command of one of the literal shapes (see [Bash mutations](#bash-mutations-and-replay_bashpy): `sed -i`, `cat >>`, a Python text swap) changes `current` in place, so the turn's snapshot carries it, but only on a file whose text is known and only when the command's result doesn't show a failure (`bashFailed`). Any other bash command that may change a file makes that file opaque, and from then on nothing bash does to it is replayed.
5. At the end of each message, every key edited in it gets a snapshot pushed onto `versions`.
6. Write out:
   - one version → `<base><ext>`
   - several → `<base>_v1<ext>` … `<base>_vN<ext>`, plus `<base><ext>` holding the final state
7. Each key claims every name it writes, `<base><ext>` and its `_vN` names. If any is taken, by another key with the same basename or by a file literally named `report_v1.html`, the base gets `_2`, `_3`, … and a `name_changed` note naming both sandbox paths (an `artifact_basename_collision` warning before v1.22.1, and still with a collector that has no `addNote`; `extract_artifacts.py` records it under that type and prints it as `note: name_changed`).

Snapshots are per turn, not per edit, because a turn is where Claude has "finished editing for now". A chat with 11 edits over 2 turns gives 2 useful versions instead of 12.

`artifacts` tool filenames come from `typeToExt` (a MIME type to extension map, `.txt` when unknown) applied to the title or ID.

When `index` is an object, it is filled with `{ key: { path, filename, versions, messages, skipped } }`, where `messages` lists the message that made each version and `skipped` the chain indexes of replay-shaped bash edits not applied (the file was already opaque, or the command failed). The viewer uses it to link tool calls to file versions; `populateConversationFolder` uses `skipped` to sort the file (see below). A fourth argument, a `Set`, gets `<tool_use id>|<path>` for each bash edit replayed, so the detector leaves those out.

**Invariants** (checked by the `validate-export` skill): `_v1` equals the first write, and the unversioned file equals `_vN`. Both still hold after a replayed bash swap, since it lands in the turn's snapshot. A download that replaces a file (rule a below) replaces the final and its last `_vN` together.

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

`extractPresentedFiles` lists the files in `present_files` results (`local_resource` items) on the current branch (`getMessageChain`), one entry per path from its latest presentation, with that message's index (`msgIndex`). One the replay already rebuilt is kept as is, unless the replay is off for it (`replayIsOff`: a `str_replace_failed` warning, or an unreplayed bash change, whether it ends as a warning or a note) and the presentation is at or after the file's last change of any kind: then the presented copy is downloaded and replaces the final file and its last `_vN`. Any other, such as a file a Python script wrote, is downloaded through `fetchUploadedFile` by its sandbox path into `artefacts/`. Two presented files with one name from different folders become `<base>_2<ext>` with a `name_changed` note. A download is the file's final state, so it clears that file's `str_replace_failed` warnings. `extractDeliveredFiles(data, takenNames, offPaths)` lists `SendUserFile` deliveries, which are downloaded by UUID into `artefacts/`, with a `delivered_file` error on failure. A delivery whose path is an artifact gets `<base>_delivered<ext>`, except the latest delivery of a path in `offPaths`: the replay is off for that artifact and the delivery is at or after its last change, so it takes the artifact's name and replaces its final and last `_vN`. The old-archive tool infers `offPaths` from the files on disk.

### Diagrams drawn in the chat (`show_widget`)

claude.ai's visualize tool shows an SVG or HTML fragment inline, styled by claude.ai's own widget stylesheet: color classes such as `c-teal` and text classes `t`, `ts`, `th` that its guide documents. `extractArtifacts` saves each call as a file that stands alone (`widgetFile`): an SVG gets `xmlns` and `WIDGET_CSS`, which defines those classes and the CSS variables for light and dark, right after its opening tag, and is saved as `<title>.svg`; any other fragment is put in a page with the same stylesheet and a do-nothing `sendPrompt`, as `<title>.html`. Calls with the same title are versions of one file (`widgetKey`). `extract_artifacts.py` has the same stylesheet, byte for byte. `full_chat.md` and the response files link the file and show an SVG as an image; the viewer gives it a card. The tool's own guidance (`read_me`) and its acknowledgement are left out of the Markdown, as are the results of the claude-artifacts `guide` and `list_types` tools.

### Images from web searches

`webImagesOf` lists the images `image_search` results showed, once per https URL. They live on their own sites, so `saveWebImages` fetches them (`credentials: 'omit'`, no referrer, 20 seconds and 15 MB each, four at a time), the thumbnail when the image itself fails, and keeps PNG, JPEG, GIF and WebP by the type the site sends. Each is saved as `images/<key>_<title><ext>` (`webImageName`), the key being a hash of the URL, so the old-archive tool finds it again on disk. Fetching needs the optional `https://*/*` host permission: Chrome only grants it during a click, so Export ZIP asks for it before anything else when the chat has web images (`requestWebImages`), and the Settings checkbox "Save web images and artifact card pictures" shows and changes it. Without it, one `web_image` warning says how many were left out; an image that fails gets its own. The Markdown shows each saved image under its link (`imageSearchLines`), and the viewer shows them as claude.ai does: one mosaic per response holding every search's images (`messageWebImages`, `renderWebMosaic` in viewer-app.js), the first four as tiles with the site on each and `+N` on the last, and a gallery that steps through all of them with the title and a link to the page (`openGallery`). It loads the saved copies from `images/` beside `viewer.html` (`ctx.webImages`, a tool block's `web`); an image not saved is a card with its title.

### Images Claude looked at

A tool result can hold an image claude.ai only links (`file_uuid`, `preview_url`), such as a photo Claude opened with `Read`. `toolImagesOf` lists them once per file, accepting only claude.ai preview paths, and `saveToolImages` downloads each (four at a time, `TOOL_IMAGE_WORKERS`, then written and warned in the chat's order) from `https://claude.ai<preview_url>` with the session into `images/<first 8 of the uuid>_<name><ext>` (`toolImageName`; the name is the file the tool read). A failure is a `tool_image` warning. `full_chat.md` and the response files show each under its step; the viewer gets them through `ctx.toolImages` as the tool block's `images`, and the old-archive tool finds them on disk by that prefix.

### Steps in the viewer

The viewer folds what Claude did before its answer into one line per response, as claude.ai does (`renderSteps` in viewer-app.js): everything up to the last thinking or tool block. The line sums up the tools (`stepsSummary`: created, edited, read, ran, searched, fetched, in that order, the first two kinds and "and N more steps"), shows thumbnails of images Claude viewed, or, with no tools, the thinking's summary or "Thought for Ns" (from the block's timestamps). Opened, it is a box of rows: thinking, text between steps, and tools labelled as claude.ai labels them (`toolLabel`, `toolTarget`: a command by its `description`, a file by its name). Diagrams, web images and published pages are not steps. A response is split at each diagram (`renderAssistant`, `renderPart`): it shows inline where Claude drew it (`renderDiagram`, from the SVG text as a data URI image, a file the viewer data marks `widget`), with a menu to copy it, download it as SVG or as a PNG drawn on a canvas at twice its size (`diagramPng`), or open it in the side panel; the steps before and after it fold separately. Web images and published pages show after their group. Thinking with no text or summary is not a row, only time on the line, and the visualize tool's guide (`read_me`) is not shown.

### Long prompts in the viewer

A prompt longer than about nine lines, counting a long line as the lines it wraps to (`longPrompt`), is collapsed to 200px with a fade and a **Show more** button, as claude.ai shows it (`renderHuman`, `setCollapsed`). Code fenced in a prompt wraps. A search match inside a collapsed prompt or a closed fold opens it (`reveal`).

### Product cards, comparisons and questions

claude.ai's display tools (`product_carousel_display_v0`, `featured_card_display_v0`, `comparison_card_display_v0`) carry products in their input (`name`, `price`, `blurb`, and for a comparison `attributes: [{ label, value }]`), and the carousel and featured cards' results carry their pictures as `images` with ids `product_<n>_<m>`. Those are web images (`isImageResultTool`), saved like image-search images. The viewer gets them as a tool block's `display` (`displayData`: kind, products, each with its pictures) and shows them where Claude placed them (`renderDisplay`): a scrolling carousel with arrows and dots, a featured card, or a comparison table. `ask_user_input_v0`, claude.ai's multiple-choice question, isn't shown once answered (the answers are the next prompt). `full_chat.md` writes the products as headings with price, description and pictures, a comparison as a table, and questions as lists (`displayLines`). A citation whose metadata names the site shows as a pill with that name (`citeSite`), and a web search's query follows its label (`toolDetail`).

### Files on Claude's messages

claude.ai can attach a file to Claude's own message, such as a page Claude published with `publish_files`. `extractUploadedFiles` lists only files on your messages; `extractAttachedFiles` lists these. One whose name a replayed or downloaded artifact already has is that file and is not saved again; any other is downloaded by UUID into `artefacts/` (a failure is a `delivered_file` error). The viewer shows them on Claude's message, linked to `artefacts/`. Exports before v1.11.0 saved them in `uploads/` as `p<NN>_<name>`, and the old-archive tool links them there.

### Claude Docs documents

Claude Docs, the editable documents on claude.ai, live there rather than in a sandbox, so the export rebuilds each one from its tool calls (`claudeDocCreated`, `renderClaudeDoc` in export-core.js; `extract_artifacts.py` mirrors them). A `batch` call creates the document from Markdown in which `<?claude block k?>` placeholders stand for a date, an author mention or a pending section; its result begins with JSON whose `acks` give the document's node id and an XML outline with the pending sections' ids, followed by plain instructions for Claude. Each `update` replaces one pending section, by that id, with Markdown, or replaces found text (`target.kind: "find"`, the `nth` match, the first by default; `applyDocOps`, `docFindAll`), and each `create` on the document adds a comment. A later `batch` on the existing document (`container.id`, no `create`) is replayed member by member: its prose `update` members like update calls, while a `widget` it creates (a diagram or chart) only shows through the section that embeds it, as `[embedded content: <caption>]`, the placeholder claude.ai's own Markdown export uses. A section fill can plant pending blocks of its own; their ids come from that call's reply (`docPendingIds`: the update's result, or the batch member's entry in `acks`), and they are filled as sections named `<section>/<key>`. The rebuilt text fills the placeholders (dates as written, mentions left out, unwritten sections noted), then appends the comments and the link to the live document. Chips a section brings with it (`with.blocks`) are filled in the same way, and a comment's later lines are indented so it stays one list item. It is versioned per turn like any artifact, under the key `doc:<node id>`, and saved as its title made safe by `safeFileTitle` (letters, digits and marks from any script). When the batch's result is missing, the document is still written, under `doc:pending:<call id>`, with its sections shown as not written and a `claude_doc_unreplayed` warning. An edit of another kind (an update with no operations, find text that isn't there or sits inside a table cell, any other operation or batch member) is not replayed and warns `claude_doc_unreplayed`, once per document. Diagrams themselves are not in the chat as pictures (claude.ai draws them only on the document's page, and its own HTML export of a document leaves them out too), and edits made by hand on claude.ai are not in it at all. A self-contained HTML copy Claude made of a document is its companion (`docCompanions`): an HTML file sent with `SendUserFile` or `present_files` in the message that exported the document (`Claude_Docs__export`, whose result's `frame.url` is the document's live link), or else a whole page (`<!doctype html` or `<html`) whose `<title>` or first `<h1>` is the document's title, compared without tags, entities, case or curly quotes; a delivered copy identical to one already found is left out. After the downloads, `populateConversationFolder` puts a note under the final document's title (`docCompanionNote`; the versions stay as rebuilt): with diagrams and a copy, it links the copy; with diagrams and none, a **Diagram not included** note says how to get one, and the document warns `doc_diagram`; with a copy and no diagrams, it links the copy. `extract_artifacts.py` writes the documents without this note, since it doesn't have the delivered files.

Diagrams Claude took a screenshot of are shown, since v1.22.1. Claude can read a widget back as a picture (`Claude_Docs__read` with `engine: "widget"`, `payload.kind: "screenshot"`, `ref.id` the widget's node id); the result links the picture like any image Claude viewed, and `saveToolImages` saves it in `images/`. `docWidgetShots` finds each widget's latest screenshot and whether a later `Claude_Docs__update` on that node changed it (`editedAfter`), `docWidgetEmbeds` which caption in which document embeds which node (from the batch's `lids`, or the ack in the member's place, `docBatchWidgets`), and `docWidgetCode` each widget's last code. Before the companion note, `populateConversationFolder` replaces each caption line whose diagram has a saved screenshot with `![<caption>](../images/<saved name>)` and the caption in italics below it, with "(screenshot taken before a later edit)" when that applies (`docDiagramPictures`); the `.html` shows it as an `<img>`. Same-caption widgets are matched in document order. Only the final document gets the pictures; its `_vN` versions stay as rebuilt, and `extract_artifacts.py` doesn't mirror this pass. A screenshot that failed to download (a `tool_image` warning) counts as absent. Only diagrams still shown by caption count for the note and `doc_diagram`. Each widget's code is written once as `artefacts/<document base>_diagram<N>.jsx` (N in the document's order, unique like the `.html`), with no versions or viewer card, and README.md lists it. `viewer.html` sits at the export's root and its sanitizer drops a `../images/` source, so the viewer gets the document as rebuilt, with every caption, and the note computed from the file's caption count (`docCompanionNote`'s third argument). In `full_chat.md` a document is linked by the name it was saved under; a single Markdown file links the live document. `populateConversationFolder` also writes `<title>.html`, a self-contained page rendered with `marked`: raw HTML shown as text (an inline tag never switches marked into copying raw text), only web and mail links and https images kept, attributes escaped once, and a CSP with no script. Its name is unique among the artefacts whatever the case, and README.md lists it.

### Published pages

A `publish_files` call (`isPublishTool`) puts a page on claude.ai; its result's JSON gives the page's URL, whose last part is the page's id in base58 (`base58ToUuid`). `publishedPagesOf` groups a chat's publishes by page id and records, per publish, the files sent (`path`, `as`) and the message. Newer chats publish with the `Artifact` tool instead (`isArtifactPublish`: an `input.file_path` and no `action`; `action: "open"` only opens one): its reply is text, "Published <path> at https://claude.ai/artifact/<id> (Version N, version id <ver>)", read by `artifactPublishReply`. Such a publish has one source with no `as`, titled by its file's name until the page info gives the title (its folder under `published/` is then renamed to that title, before anything is written); `savePublishedPages` matches the one published file to that one source when comparing checksums. `publishedReply` gives `{ title, url }` for either tool, for the Markdown (`publishedLines`) and the viewer, which marks the call `output` so it shows as the page's card, not a step. Fetching is `content.js`'s job, through two actions that popup.js reaches by `sendToTab`:

- `publishedPageInfo` calls `GET /api/frame/<uuid>?org=<org>[&ver=<ver>]` with the header `X-Frame-CP: go` (reply: version, history, title, current files, an asset token), then `GET https://<uuid>.frame.claudeusercontent.com/_f/<ver>/_files.json?__frame_t=<token>` for each file's size, type and SHA-256. It returns `ver`, `title`, `history`, `files[]` and any `rejected` paths.
- `publishedPageFile` fetches one file from `…/_f/<ver>/_src/<path>?__frame_t=<token>` and returns it as base64 (encoded in chunks).

Pages made outside a chat (Cowork, Claude Code) have no `_files.json` (404). Then `publishedFileList` uses the frame info's own file list, keeping only each `path` and `contentType`, with `size` and `sha256` null and `fromInfo` set. A file from that list is fetched from `_src/<path>` first and, on a 404, from `…/_f/<ver>/<path>` itself; its size is checked only while reading. A page shared with you publicly comes with no `assetToken`: its entry has an empty token, its requests carry no `__frame_t`, and a 403 is not retried for a new token. Without a token `_files.json` and `_src/` fail before any status (observed 2026-11-16), so such a page uses the frame info's list straight away and its files come from `…/_f/<ver>/<path>` directly; with no files in the frame info it fails with `HTTP 403`. In the popup, `fetchPublishedFiles` saves a file listed with no SHA-256 without that check, counts its real size against the 50 MB total, and `markUnverified` gives its entry in `published.json` or `artifact.json` the SHA-256 and size of the saved bytes and `verified: false`. Only a file with neither size nor SHA-256 is unverified; one with a size and no valid SHA-256 is still a bad listing, and a fallback status whose frame info lists no files keeps its error. In Export All an unverified version is shared, so once fetched, a later chat can judge it "same" by that SHA-256 while an earlier one could not: the result depends on chat order.

The token is a secret: it stays in `content.js` (cached per page and version, refetched when under 60 s are left, after a 403 once, or when none is cached), is never returned, and appears in no error, `errors.txt`, `published.json` or log we write. Frame requests send no cookies and no referrer, and refuse redirects. Errors come back as codes (`HTTP 404`, `network`, `too large`), never as text that could hold a URL. Caps: 32 MB per file (checked from `_files.json` before fetching and while reading) and 50 MB per page version. A `ver` and a uuid must match fixed patterns; paths in the listing with an empty, `.` or `..` segment, or a leading `/`, are rejected, and `artifact-type/` paths skipped. The popup passes the reply through `cleanPublishedInfo` and verifies each file's SHA-256 over the decoded bytes.

`savePublishedPages` makes one record per page per export, with a folder `<safeFileTitle(title)>_<shortId>` chosen once (titles change), and one version folder per version fetched (`<ver>`, or `current` for a publish with no version that matches none Claude named). Every saved segment goes through `publishedSegment` (`zipSafeName`, Windows-reserved characters and device names, case-only and file/folder clashes resolved with `_2`) and a rename warns `published_page`. A version is "same" when every listed file equals, by SHA-256, the text this export holds for its source as of the publishing message (`versionAsOf` on the artifact's versions) or a downloaded attached copy of that message; then nothing is copied and `published.json` says `same: true` with `writtenAs` (the artefact). Binary files are never same. The sameness is per file within a version, and per version across a page. `current`, for chats with no recorded version, is the live version, not necessarily the one published then. `published.json` (`format: 1`) holds title, url, short id, uuid and per version: ver, label, order, saved, files, start, startSaved, incomplete, needsRuntime, missing, publishedIn.

In an Export All the pages go into the shared artifacts store (see "The artifacts store" below), not `published/`: `publishedStoreRecord` finds or makes the page's record, each chat adds its `publishedIn` entries (`chat`, `messageUuid`, `toolUseId`, `same`, `writtenAs`), and the versions land in `artifacts/<Title>_<id>/<ver>/`. A chat's README ("Published pages") and `publishedLines` link the saved copy (`../artifacts/<Title>_<id>/<ver>/…`). `published` stays a reserved chat folder name. A single chat's ZIP is unchanged (`published/`, `published.json` format 1).

The viewer (`takeout-viewer.js` `addCards`) turns a page's publishes into one card keyed `published:<uuid>`, with a version per entry; `Same as published` and `Needs claude.ai to run` come from the data. The old-archive tools read `published/` and `artifacts/` through `readArtifactStore` (see "Viewers for older archives").

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

`populateConversationFolder` writes one chat's folder. The single-chat ZIP is that folder; the all-chats mega-ZIP holds one per chat, plus `index.md`, `export-manifest.json`, the shared `projects/` folder, and one viewer for all of them.

**Mega-ZIP name.** `bulkExportZip` asks `content.js` for the chat list with `withAccountName: true`; `fetchAccountName` reads `/api/account` and passes on only `display_name` (or `full_name` when that is empty). `megaZipName` lowercases it, keeps its letters, digits and marks, turns the rest into `_`, cuts it to 40 characters, and names the file `claude-takeout-<name>-[changes-]<stamp>.zip`, or without the name when there is none. The stamp is the local date and time the export started, `YYYY-MM-DD_HHMM` (`exportStamp`), as Grok and Gemini Takeout name their exports; the folder export uses the same name without `.zip`.

**Export All into a folder.** With `settings.megaFormat` at `'folder'` (the default; `'zip'` is the old Mega-Zip), the Export selected click (`folderExport`) opens `showDirectoryPicker` before anything is awaited, since Chrome only allows it straight after a click, and passes the folder to `bulkExportZip({ directory })`. The popup closes when a picker opens, or when it loses focus (a click on the claude.ai tab), which would end a run inside it, so there the click, Folder or ZIP, opens the side panel on the claude.ai tab instead (`chrome.sidePanel.open`) and leaves `folderExportNote` in `chrome.storage.session`, `{ at, choices }` with the popup's choices (`scope`, `chats`, `artifacts`, `format` `'folder'` or `'zip'`; `handoffChoices`), removed again when the panel fails to open. Only a popup without `chrome.sidePanel.open` runs a ZIP itself. The panel reads it in `takeHandoff` (after `loadSettings`), validates it (`handoffFrom`), applies the choices to its settings, shows the note and removes it; Dismiss or a click on Export selected ends the handoff. `makeRunFolder` makes a new folder inside the picked one, named as `megaZipName` would name the ZIP, with `_2` and so on when that exists. `createDiskFolder` takes the same `file()` and `folder()` calls the export makes on a JSZip, so `populateConversationFolder`, `writeViewer`, the index and the manifest are unchanged; writes run in the background in order per path, `flush()` after each chat waits for them, and a file that can't be written is listed in `write-errors.txt` at the root instead of stopping the export.

**Export Changes.** After each mega-ZIP, `saveExportRecord` adds the chats it holds to `chrome.storage.local.exportRecord[<org>]`, each with the `updated_at` the chat list gave, and `warnings` (the run's warning count, `runResult.warnings`; the panel's footer says "Last export <time> · N warnings"). With **Changes only** on the main screen (`settings.megaZipScope: 'changes'`; the default is `'all'`), passed as `bulkExportZip({ changesOnly: true })`, it loads that record and exports only the listed chats that are new or whose `updated_at` differs (`changedSince`), into `claude-takeout-<name>-changes-<stamp>.zip`, whose `index.md` is headed "Changes since <date>". With no record it exports everything; with nothing changed it downloads nothing. Chats that failed aren't recorded, so the next run tries them again. `export-manifest.json` (`format: 1`, `kind: full | changes`, `since`, `listed`, and every chat's `uuid`, `name`, `updated_at` and `folder`) lets the archive say what it holds without the browser; the old-archive tool treats it as part of the export.

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
├── errors.txt                 only with warnings or notes
├── original.json              the payload as fetched
├── viewer.html                offline viewer
├── viewer-check.gif           detects a ZIP opened without unzipping
├── viewer-files/part-NNNN.js  only when an upload's or a generated file's text is over 64 KB
├── responses/NNN_<title>_response.md, .full.md
├── artefacts/<base>(_vN)<ext>
├── attachments/pNN_<name>
├── uploads/pNN_<name>
├── published/<Title>_<id>/    pages published with publish_files or the Artifact tool: published.json and <version>/<files> (a single chat's ZIP; Export All saves them in artifacts/)
└── project/
```

Encoding rules:

- Every `.md` file gets a UTF-8 BOM (`addFileWithBOM`), because Chrome opens local Markdown as plain text and guesses the encoding.
- Text goes through `fixMojibake`, which repairs UTF-8 that was read as Latin-1.
- `getCodeFence` makes a fence one backtick longer than the longest run in the content.
- Every name from chat data that becomes a path in the ZIP goes through `zipSafeName` (`/`, `\\` and control characters become `_`; `.` and `..` become `_`). File and folder names from titles keep letters from any script.

---

### Sessions (Cowork and Claude Code)

Sessions are not chats: claude.ai's chat API answers 404 for them. Export All with the **Sessions** box ticked (`settings.exportAllSessions`, default `true`; `bulkExportZip`'s `withSessions`) reads them from three undocumented endpoints on claude.ai (all `GET`, with the cookies plus the headers `anthropic-version: 2023-06-01`, `anthropic-beta: ccr-byoc-2025-07-29` and `x-organization-uuid`; `sessionRequest` in `content.js` shares `fetchWithRetry` with `fetchConversation`: 429 and 5xx up to three times, Retry-After up to 30 s, else 2, 5, 10 s; errors carry codes only). `listSessions` asks for `/v1/code/sessions?exclude_tags=-&limit=100`. The endpoint returns at most 100 (a larger limit is HTTP 400) and can't be paged (`resume_token` is not a cursor), so a list of exactly 100 sets `incomplete` and the export warns. `fetchSessionEvents` asks for one page of `/v1/sessions/<cse_id>/events?limit=<n>[&after_id=<last_id>]` per message (`limit` from the request, an integer 1 to 200, else 200); the panel loops while `has_more`, taking `last_id` from the raw page, up to 20,000 events asked for (100 full pages). A kept page over 32 MB of JSON (`SESSION_MESSAGE_CAP`; Chrome's messages stop near 64 MiB) is answered `{ error: 'too large' }` without its events, and `runSessionStep` asks for the same `after_id` again down `SESSION_PAGE_LADDER` (200, 50, 10, 1), keeping the smaller size for the rest of that session; `too large` at 1 is a `session` warning and the session isn't recorded. It is never read as a gone tab. `content.js` loads once per tab: `globalThis.__claudeTakeoutContent` (with an `alive()` check on its `chrome.runtime.id`, so a copy left by a reloaded extension doesn't count) keeps a second injection from adding a second message listener.

**Kept fields** (`session-core.js`, loaded in `content.js` as `CTSession`; `keepSession`, `keepSessionEvent`, `sessionPage`): the session keeps `id`, `title`, `status_bucket`, `environment_kind`, `config.origin` and `config.model`, the three dates, and `external_metadata.artifacts[]` (`artifact_id`, `title`, `updated_at`). Events keep `user` and `assistant` (`uuid`, `created_at`, `parent_tool_use_id`, `message.role`, `message.model`, `message.content`), `result` (`is_error`, `num_turns`, `duration_ms`, `total_cost_usd`, `subtype`) and `system` of subtype `compact_boundary`. Everything else is dropped in `content.js`, so `session_context`, request headers, `env_manager_log`, `init` and control messages never reach the panel. A kept event over 2 MB (`EVENT_STUB_BYTES`) becomes a stub `{ uuid, created_at, type, stub }`.

**Stripping and masking.** `stripSystemReminders` removes every `<system-reminder>` span from user text (an unclosed one drops the rest of the text); a user event left empty is dropped. `maskSecrets` (`maskKeys`) replaces `sk-ant-`, `ghp_`/`gho_`/`ghs_`/`ghu_`/`ghr_`/`github_pat_`, `AKIA…`/`ASIA…`, `xox[bp]-` tokens, `Bearer` tokens of 20 or more characters (any case) and PEM private key blocks, truncated ones included, by `[masked]`, in every kept string (`maskDeep`). Best effort. Compaction summaries, `<command-name>` and `<local-command-stdout>` text are labelled in the transcript, not shown as the owner's words.

**CLI sessions.** `environment_kind: bridge` is a CLI session. `sessionsToFetch` is an allow-list: with `settings.exportCliSessions` off (the main screen's **Include CLI sessions (run on your computer)** under Sessions, default `false`, disabled while Sessions is unticked; it was a Settings switch before) it takes only `environment_kind: anthropic_cloud` (Cowork), and a CLI session or any other or missing kind gets no events request and is counted in `index.md` and the manifest ("Sessions not exported (Claude Code CLI or other): N"; `sessions.leftOut`). With it on, every kind is fetched.

**Export.** With `withSessions: false`, `bulkExportZip` sends no `listSessions` and has no session step, row, index section, manifest entry or record change. With `withChats: false` (Sessions or Artifacts without Chats), `fetchAllConversations` is sent with `withoutChats: true`, so `content.js` answers only the org and account name, and `index.md` says "Chats: not exported (not ticked)" in place of the conversations table; Changes only is allowed with Chats or Sessions ticked. `bulkExportZip` lists sessions next to the artifacts, so the plan, the Changes only early return and `viewerWanted` count them. `runSessionStep` runs after the artifact step, before the viewer: Stop is checked before each session and between its pages, and a gone tab skips the step. Limits: 64 MB of kept events per session (saved as far as it got, warned, not recorded), a 256 MB total for a ZIP run (later sessions skipped with one warning), a picture over 5 MB left out. A failed list or session is a `session` warning; chats are unaffected. A list answered HTTP 403 or 404 means the account has no sessions: no warning, a run note `SESSIONS_UNAVAILABLE_NOTE` ("Code and Cowork sessions: not available for this account") on Done and "Sessions: not available for this account" in `index.md`, and no manifest entry. The Exporting screen's Sessions row stays hidden (`beginRunScreen`) until the first `sessions` progress event (`runProgress`).

**Layout.** `sessions/<Title>_<shortId>/` beside `projects/` and `artifacts/` (`sessions` is a reserved chat folder name, claimed case-insensitively): `session.json` (`format: 1`; `{ session, events }`; an image's base64 replaced by a reference `{ image: 'images/<n>.<ext>' }`), `transcript.md` (`sessionTranscriptMd`: prompts, replies, thinking under "Thought process", one line per tool step with a fenced input and a result cut at 2 KB, images, a line per compaction; UTF-8 with BOM), `README.md` (`sessionReadmeMd`: dates, origin, counts, cost, and the artifacts it made linked to `../../artifacts/<folder>/` when the store has them), `images/` (`sessionImages`: type by leading bytes). `index.md` gets a Sessions table; `export-manifest.json` gets `sessions: { listed, leftOut, items: [{ id, title, folder, last_event_at }] }`.

**Record.** `exportRecord[<org>].sessions[<cse_id>] = sessionStamp(session)` (`last_event_at`, else `updated_at`, else `created_at`). `changedSessions` takes a session whose stamp differs or is new; `recordableExport` leaves out a session with a write failure under its folder, and a session that failed or hit a cap isn't recorded.

**Viewer.** `CTViewer.buildViewerSession` turns kept events into the `chat_messages` shape (one flat branch), groups them into turns (`sessionTurns`) and nests events with a `parent_tool_use_id` under their Agent step. Tool inputs and results are cut at 2 KB with a link to `session.json`; images load from `sessions/<folder>/images/` by relative path, never as data URIs. `ViewerData.sessions` feeds a **Sessions** sidebar entry (only with sessions), the `#sessions` list page and `#session=<id>[&msg=<turn id>]` (`parseHash`, `formatHash`, `parseListHash`). Sessions are not in Recents, All chats or Projects. Search includes session titles, prompts and replies (never tool output), labelled "Session"; the in-chat match bar stays chats-only. An artifact made in a session shows "Made in session" and the session lists its artifacts.

**Old archives.** `tools/archive-lib.js` `readSessions` reads `sessions/*/session.json` (256 MB cap each), `sessions` is in `KNOWN_DIRS` (not "Archive files"), and `isChatlessAll` recognizes an archive of sessions only. `build_viewer.js` keeps sessions in a rebuilt viewer; `merge_archives.js` (`pickSessions`) keeps the newest copy of each session by stamp, lists them in the merged `index.md` (a Sessions table: title, origin, last activity, folder link) and writes `sessions: { listed, skipped, items }` in its manifest, where `skipped` counts `session.json` files it could not read (an export's `leftOut` counts sessions it chose not to fetch).

**Not exported:** the files a session wrote (no `_vN` replay; its published artifacts are saved), sessions claude.ai doesn't list (including CLI sessions that never connected), and the `claude.ai/chat/<uuid>` address of a session.

### Export Artifacts

Export Artifacts (`exportArtifacts`) saves the artifacts claude.ai lists, not those found in chats. `content.js` `listArtifacts` calls `GET /api/frame/frames?org=<org>&limit=1000` (header `X-Frame-CP: go`, same-origin) and returns, per frame, only `slug`, `title`, `typeSlug`, `typeTitle`, `sourceSurface`, `rel`, `live`, `updatedAt`, `createdAt`, `public` (true when the audience is public; the audience itself is dropped); no owner or URL leaves it, and the picture URL stays in `content.js`; only `artifactThumbUrl` hands it to the popup, which fetches it. `artifactsFromList` (export-core.js) checks each again (the slug by the uuid rule, `live` by the version rule). This list has no paging (`offset`, `cursor`, `page`, `skip`, `start`, `before` are ignored; checked 2026-11-22), so `listArtifacts` also pages through `GET /api/frame/artifacts` (`fetchArtifactPages`: `rel=all`, 100 a page, `page_token` from `next_page_token`, at most 100 pages, folders counted; no `empty` filter, since claude.ai's own `empty=exclude` hides typed artifacts). An artifact there and not in the frames list is added with the same fields (`id`, `source`, `updated_at`, `created_at`, audience as `public`), `live: ''` and `paged: true`: that list has no live version, so `saveArtifact` fetches its page info at `ver: ''` and takes the resolved version, and the export record keeps `paged:<updatedAt>` for it (`listedArtifactVer`; with no update time it is not recorded and Export Changes includes it each time). When its page info fails with `bad response` or a 404 (a draft claude.ai serves no version of), it gets the note "no published version" and no warning. It has no card picture. `listArtifacts` returns `paging`: `{ status: 'ok' | 'capped', added }`, or `{ status: 'failed', code }` (an HTTP status, `network`, `bad response`, `repeated page`), in which case the frames list stands alone; `artifactsFromList` keeps it as plain values (`artifactPaging`). `runArtifactStep` warns `artifact_export` when paging failed or was capped (the export may be incomplete) and counts the artifacts found only by paging. `artifactsFromList` also returns `listed`, the number of artifacts claude.ai sent (both lists) before any was dropped; the indexes and the manifest use it. The list is fetched first through `tabPublishedFetcher`; an empty list or a failure writes nothing.

Each artifact is fetched at its listed version with the same code a chat's published page uses, `fetchPublishedFiles` (`publishedPageInfo` then `publishedPageFile`, the 32 MB and 50 MB caps, SHA-256, `publishedSegment` names, the 401 latch). `publishedPageInfo` also reports `runtimeSkipped`, the count of `artifact-type/` paths dropped; `needsRuntime` is true when that is above zero, when the artifact has a type, or when the start text needs claude.ai's page code. Claude Docs (type `c8f0b311-af6a-4d22-a07b-61eb818fc35d`, or title "Docs" when the type is missing) are not fetched: they get a row and the note that their text isn't a file. A typed artifact with no files of its own gets `artifact.json` only. A shared one (`rel` neither empty nor `mine`) is exported and labelled in `artifact.json`'s `note` and in the Source column. Cowork, Claude Code and shared artifacts are usually listed from the frame info (see Published pages): their saved files are marked `verified: false` and the note says "files not checked against claude.ai's checksum".

Layout: `claude-takeout-artifacts-<name>-<stamp>` (`megaZipName(name, 'artifacts', stamp)`), one folder `<safeFileTitle(title)>_<shortId>` per artifact (the title part cut to 200 bytes of UTF-8 at a character boundary, `shortId` from `uuidToBase58`, compared case-insensitively), with `artifact.json` (format 2) and the version's files in `<ver>/` (`publishedSegment(ver)`, or `current` when there is no id; nothing else sits loose in the folder, and a page file named `artifact.json` can't clash because files live a level down). Before v1.18 the files sat directly in the artifact folder and `artifact.json` was format 1; the old-archive tools still read that. The root has `index.html`, `index.md` and `export-manifest.json` (`kind: 'artifacts'`, `listed`, `artifacts[]`), and `errors.txt` from one collector labelled "Export Artifacts" (its report ends with one line, sign in and run Export Artifacts again, instead of the chat recovery steps). An artifact whose export throws unexpectedly still gets a row, a manifest entry with `ver: ''` and, when it can be written, `artifact.json`, with the note "not exported: unexpected error (see errors.txt)"; any other throw ends the export with an error status and hides the progress bar. `artifactsIndexHtml` is static: a CSP meta first (`default-src 'none'`), no scripts, every value escaped, local links `encodeURIComponent`-ed per segment, claude.ai links rebuilt from the short id with `rel="noopener noreferrer"`. `index.md` goes through `mdLinkText`. A folder export flushes after each artifact and writes `write-errors.txt` like Export All (`folderExport`; from the popup it stores the side panel's note with the choices before it opens the panel). The export ignores `megaZipScope` and never reads or writes `exportRecord`. `build_viewer.js` and `merge_archives.js` read it as an artifacts-only archive (manifest `kind: "artifacts"`, no chats).

#### Artifacts viewer

Export Artifacts also writes `viewer.html` (`writeArtifactsViewer` in popup.js, once at the end; `index.html` and `index.md` are written after it, and `index.html` links the viewer only when it was built). A failure never fails the export: the status line adds "viewer.html could not be built." The page is `viewer/artifacts-template.html` plus `viewer-logic.js`, `artifacts-app.js` and `marked.min.js` (`CTViewer.ARTIFACTS_VIEWER_ASSETS`), assembled by `assembleViewer`. It uses the chat viewer's CSP except `frame-src 'none'`, so a preview can't navigate to a saved file outside its sandbox.

Data: one `ArtifactView` record per artifact, including those that failed (`notExported`): id, title, kind, flags (`typed`, `docs`, `shared`, `public`, `needsRuntime`), dates, folder, start file path, saved name, kind and size, `tooLarge`, files with `verified`, `thumb`, and `part`/`key`. `artifact.json` gains `public` and `start`; `audience` is reduced to the `public` boolean by `listArtifacts` and never stored. Preview text and images go in parts, `viewer-files/part-NNNN.js`, in the chat viewer's format (`window.__archivePart`), made by `artifactViewParts`: per artifact a payload `{ texts: [[path, text]], images: [[path, dataURI]] }` of arrays keyed by the file's original path (so a path like `__proto__` is just data). Texts (html, htm, css, js, mjs, svg, md, markdown) and images (png, jpg, jpeg, gif, webp, avif, bmp, ico; `previewKind`) are each capped at 2 MB (`TEXT_EMBED_LIMIT`), and per artifact at 8 MB of texts plus 8 MB of images (`PREVIEW_TOTAL_MAX`); a part closes when the next payload would pass `PART_LIMIT`, and one artifact's payload is never split. The parts of one export share a 256 MB budget (`ARTIFACT_PARTS_BUDGET`); past it an artifact gets no payload and the viewer shows its details page. A ZIP export holds the part bodies in memory, about twice the budget at worst, so Folder is the route for a large account; a folder export writes each part when it reaches the part limit, so its memory stays bounded by one part.

Pictures: `listArtifacts` keeps each frame's picture URL inside `content.js` (`artifactThumbUrls`, keyed by lowercased uuid, accepted only when it has the exact shape: https, no port, user info or hash, host `<uuid>.frame.claudeusercontent.com` for that artifact, path `/_f/<ver>/_thumb.img` and a single query parameter). The frame host sends no CORS header for claude.ai on `_thumb.img` (unlike `_files.json` and `_src`), so a content-script fetch is refused; the popup, an extension page, fetches the picture instead, which needs the same optional `https://*/*` permission as web-search images. A ZIP export's click asks for it (`askForCardPictures`, before anything is awaited, and only when the popup doesn't already know it is granted); a folder export never asks, since `showDirectoryPicker` needs the click's activation. `exportArtifacts` checks `webImagesAllowed` once: without the permission no picture is asked for or fetched, cards get tiles, nothing warns, the status line ends "Card pictures need the web images permission (Settings)." and the indexes say "Card pictures: 0 of N (needs the web images permission: Settings, Save web images and artifact card pictures)" (`artifactThumbsLine`). With it, per artifact in turn, `fetchArtifactThumb` asks `content.js` for `artifactThumbUrl { uuid }` (`{ url }`, the URL rebuilt from the checked parts, or `{ error: 'no picture' }`), fetches it without cookies or referrer and without following redirects, capped at 2 MB while streaming, and types it by its leading bytes (PNG, JPEG, WebP; anything else, and any `text/*` or SVG reply, is refused). The first 403 of an export asks for `artifactThumbUrl { uuid, refresh: true }`, which re-lists once per export (one listing refreshes every picture URL), and retries once; a second 403 is final. The URL goes from `content.js` to the popup in memory, only for that fetch: it is never stored, written, shown in the status line, passed to a warning or logged. The popup writes `viewer-files/thumbs/<shortId>.<png|jpg|webp>` and records it as `thumb`. A picture failure never warns and doesn't count as signed out; "Card pictures: N of M" in the indexes and `thumbs` in `export-manifest.json` report the count. No URL or token reaches a written file, and the viewer code has none of those strings.

Viewing: `artifacts-app.js` routes on `#a=<id>` (anything else, or an unknown id, is the grid) with tabs All, Yours and Shared with you, sorted by `updatedAt` newest first. `openPreview` loads the artifact's part (`loadPart`, the chat viewer's way), then builds a `srcdoc` iframe with `sandbox="allow-scripts allow-forms allow-modals"` (never `allow-same-origin`, popups or top navigation) from `artifactPreviewDoc`: the preview CSP, then `STORAGE_SHIM` (in-memory `localStorage` and `sessionStorage`) and `RTC_SHIM` (WebRTC constructors removed), then the document. `inlineArtifact` resolves each relative `src`, `href` and `srcset` with `resolveArtifactPath` against the start file's folder (a scheme, a leading `/`, `//`, `?`, `#`, `..` past the root or a decoded segment with `/` is refused) and inlines saved scripts, styles and images; CSS keeps its own `url()` and `@import`, module imports aren't inlined, and links between pages don't work. Markdown goes through `markdownParser` (moved from viewer-app.js, shared with the chat viewer), `protectMath`, `sanitizeHtml`; math stays TeX and relative images don't show. A Claude Docs artifact gets the docs page, Design and other typed artifacts a poster page (with "Show saved files anyway" when the start file could preview), React and Mermaid the details page. The owner's own image start file that is too large or not in a part shows from its saved file. Open file links come from `openHref`: any saved file of an artifact that isn't shared, and only what `openableHref` allows for a shared one; a shared artifact's start file gets a local link in `index.html` and `index.md` only when `openableName` (export-core.js, a copy of `OPENABLE_EXTENSIONS` that a test keeps identical to the viewer's) allows it, so anything but documents, images, media, archives and plain data files never gets one. In a folder export the viewer is flushed before the indexes, and a viewer.html that failed to write counts as not built. `tests/e2e/artifacts-viewer.e2e.js` covers it, including hostile pages.

#### Export All with artifacts

With `settings.exportAllArtifacts` (default true; the **Artifacts** checkbox on the main screen), `bulkExportZip` lists artifacts first through `tabPublishedFetcher` (`listArtifacts`, then `artifactsFromList`), so a changes run knows whether any changed and a chat's publish of a listed artifact is named by the list's title from the start. A failed list leaves the listed artifacts out and adds "Artifacts could not be listed." to the status line; the chats export as usual. The chats save their publishes into the store as they run, and the artifact step (`runArtifactStep(root, { prefix: 'artifacts/', artifacts, ... })`, the loop Export Artifacts uses) then adds each listed artifact's current version only when no whole folder for that uuid and version exists. The step runs only for listed artifacts; `artifact.json` and the indexes are written whenever any page was published or any artifact listed: the step writes its own records, and `bulkExportZip` writes `artifact.json` and an index row (`storeRecordRow`) for every other record the chats saved something of. With the setting off there is no list and no step, so the chats' records write them all and nothing is `listed`. Every folder, `artifact.json` and view path carries the prefix so a viewer at the root finds them. Card pictures and preview parts stay in the root's `viewer-files/`. The step never throws; its warnings (`artifact_export`) go to `artifacts/errors.txt`, not the root's. Card pictures are fetched only if `webImagesAllowed()` already says yes; Export All never asks. `artifacts` joins `projects` and `published` in the reserved chat folder names.

#### The artifacts store

`artifactStore(root, { prefix })` (popup.js) is the one writer for Export All and Export Artifacts. `record(uuid, { title })` makes a record per uuid whose folder `<Title>_<shortId>` is claimed once (names never repeat without regard to case and never take a root name; `retitle` renames it only until something of it is written, the v1.16.1 rule); `folderName(rec, ver)` names a version's folder; `write(rec)` writes `artifact.json` from `artifactJsonV2`. A version that is already whole (`storeVersionWhole`: saved, nothing missing, every file with a saved name) is not fetched again; one saved in part is fetched again in the artifact step.

`artifact.json` format 2: `format`, `uuid`, `shortId`, `url`, `title`, `typeTitle`, `sourceSurface`, `rel`, `public`, `createdAt`, `updatedAt`, `listed` (claude.ai's list had it), `current` (the current version id or null), `start`, `needsRuntime`, `note`, `thumb`, a top-level `incomplete: true` when a fetch of the artifact failed, `order` and `versions`. `order` holds the version ids in claude.ai's history order, because a JSON object can't keep the order of numeric-looking keys; readers and the viewer's version menu follow it (`storeVersionList` in export-core.js). A version with no id is keyed by `storeNoIdKey` and lives in `current/`. Each entry of `versions` is `{ folder, files: [{ path, savedAs, size, contentType, sha256, verified }], start, startSaved, incomplete, missing, saved, sameAs?, publishedIn }`. `folder` is null when no copy was saved. `sameAs` (published path to root-relative chat file) is set only for a version not copied because a chat wrote it identically (one-file versions; a multi-file same version is copied). `publishedIn` entries are `{ chat, messageUuid, toolUseId, same, writtenAs }`. A version may also have `zip` (`<folder>.zip`), see below. `published.json` isn't written here.

**The frame preamble.** `publishedNeedsRuntime` (export-core.js) tests a start file's text for `artifact-type/` or `/_f/` after `withoutFramePreamble` leaves out claude.ai's preamble: when the text has `<!-- frame-runtime -->`, each `<script>` whose text starts with `window.__FRAME_PREAMBLE` and the script right after it (claude.ai's runtime, whose text names `/_f/`). Saved bytes are unchanged.

**Design canvas.** `previewKind` treats `.json` as text, and both payload builders (`fetchPublishedFiles`, archive-lib.js `payloadFromDisk`) keep `project/canvas.json` (`DESIGN_CANVAS_PATH`) right after the start file. On the Artifacts screen a Design view (`isDesign`) loads its payload; `designCanvas` (viewer-logic.js) turns `canvas.json` into boards (keys `<name>.dc.html` in `project/`, places within `DESIGN_COORD_MAX` (100,000) and sizes within `DESIGN_SIZE_MAX` (20,000), at most `DESIGN_BOARD_MAX` = 60, the rest in `skipped`; notes out of range are dropped, at most `DESIGN_NOTE_MAX` = 2,000; a heading's width is its `maxW`, a sticky note's its `w`, each falling back to the other when out of range; min and max by loops) and notes (`noteOrder`, `noteFill`'s palette), shifted to 0; `null` means the poster page. `canvasPage` scales the canvas to the page width (`canvasScale`: at most 1, at least 0.1, so a wider canvas scrolls) and builds each board's frame with `previewFrame` from `artifactPreviewDoc(text, 'project/<name>', payload)`, through an `IntersectionObserver` (600 px margin) that adds a frame near the view and removes it far away. `boardFlags` badges templated boards and `/_blob/` images; `canvasBadges` replaces "needs claude.ai to run" with "Design canvas". `openBoard` shows one board and focuses Back, `openCanvas(v, name)` comes back to it (on the canvas or its row in the skipped list) and focuses its Open alone; a `ResizeObserver` on the page rescales the canvas in place (`wrap.rescale`: positions, sizes and each frame's transform, so frames, focus and scroll stay) when the width changes by 20 px or more (`#page-body` keeps a stable scrollbar gutter, so a scrollbar coming and going can't make it oscillate), one per page (`stopCanvas` on leaving it, also for an In chats file page); a layout that throws shows the poster page. A board's title row is one line within the board (at least Open alone's width): Open alone first and whole, the title shortened, badges shortened first; its full text in a tooltip.

**The version ZIP.** `fetchPublishedFiles` takes `zip: { date }` and, when two or more files were saved, writes `<version folder>.zip` beside the folder (`writeVersionZip`, `versionZip`): the saved files at their saved names, in the version's order, DEFLATE, every entry dated from the artifact's `updatedAt` (else 1980-01-01), so the same files give the same bytes. Only the current version gets one: Export Artifacts' `saveArtifact` always asks, Export All's chats only for an included artifact's listed live version (`publishedPreviewWanted`), and a multi-file same version copied from a chat (`keepSame`) under the same rule. A ZIP that can't be built is left out. The version's `zip` is set when written, `artifactJsonV2` writes it, and `artifactView` carries the root-relative href as `zip`. The old-archive tools read it only when `artifact.json` names `<folder>.zip` and it is a real file beside the folder (`zipOf` in archive-lib.js); merge copies the merged current version's ZIP from the source whose folder it took (`isZip` checks `PK\x03\x04`) and never builds one.

Index and view code lives in export-core.js so Node reads it too: `artifactView` and the preview and kind helpers (`previewKind`, `artifactFileKind`), `storeRecordRow` (a store record to an index row, with the notes such as "some versions not saved (see the chats' errors.txt)"), `artifactsIndexMd` and `artifactsIndexHtml` with their helpers `formatTimestamp`, `mdLinkText`, `escapeHtmlText`, `encodePath` and `storeVersionList`. Rows of pages not in claude.ai's list go under "Published from chats, not in claude.ai's list" (`ARTIFACTS_UNLISTED_HEADING`); the root `index.md` adds "Published from chats only: N". Links go to the current version's start file, or the newest saved version when the current wasn't saved. A Claude Docs artifact whose text a chat in the export rebuilt says "Text rebuilt from the chat <chat title>." instead of the plain note.

The viewer reads it through `takeout-viewer.js` and `viewer/artifacts-app.js`: version menus follow `order`; picking an older version shows its own preview part first (`e.part`), else a chat's copy with the sibling files it was published with (`versionCopyTexts`: for a same version, each file's text from the chat version saved at its `sameAs` place, keyed by its published path; for a version in its own folder, none, since its files aren't in the page's data), never the chat's newest ones, and shows only that version's badges; the chat viewer calls `refocus()` after showing the screen, since `route()` focuses the title while it is hidden; the Artifacts entry shows when the export has any artifact folder or any In chats file; and when the list wasn't fetched (`listFetched` false; the old-archive tools read it from `export-manifest.json`: an `artifacts` block, or `kind: "artifacts"`) All, Yours and Shared with you show `ARTIFACTS_NO_LIST`, "claude.ai's list isn't in this export".

To bound memory, `savePublishedPages` keeps a version's preview (and the written text of a same version) only for an included artifact's listed live version (`publishedPreviewWanted`, built from the artifact list before the chat loop; nothing when the step won't run). `runArtifactStep` lets go of every preview an artifact's record holds once that artifact's part is written.

**Every version (v1.21).** `content.js` returns claude.ai's `history` oldest first (claude.ai sends it newest first; up to v1.20.7 it was kept as sent, so labels ran backwards, and archive-lib reverses a format-2 `order` whose current version is first). After the current version, whichever way it was saved (fetched, kept whole from the store, or a chat's own file), `saveArtifact` calls `saveHistory` (a failure there leaves the current version saved): each other version of `rec.history`, oldest to newest, into its own `store.versionFolder`, skipping one the store has whole or as a chat's file and one in `ctx.skipVersions`; when the current version came whole from a chat and its history isn't known, the info is asked once. An older Cowork/Claude Code version has no `_files.json` and claude.ai's info lists no files for it, so `publishedFileList` takes the live version's list (`listFromLive`; observed 2026-11-23 that `_src/<path>` under the older id returns that version's own bytes): unverified, a missing file doesn't fail it. 404 or no files: settled, noted; any other failure: incomplete, one `artifact_export` warning per artifact, the artifact not `whole`. After a 401 (here or earlier in the export) the versions not yet tried are `unfetched` and the artifact is not `whole` either, so Export Changes fetches them next time. `runArtifactStep` returns `versionsSaved` per artifact (the current version when whole, the history's saved and settled), which Export All joins into `exportRecord[org].artifactVersions` (through `recordableExport`), and Export Changes passes back as `skipVersions` (`changedArtifacts` also includes an artifact whose live version isn't among its recorded versions, and every artifact once when the record has none, from before v1.21); a full Export All and Export Artifacts skip nothing, and only Export All records. Each older version's payload goes into a part as soon as it is fetched (`ctx.placeOlder`, set by `runArtifactStep`) with `artifactViewParts.add(view, payload, { reserve: ARTIFACT_HISTORY_RESERVE })` (64 MB: an older preview never takes the last of the budget) and its place into `rec.versionPlaces` (`folder` root-relative, `part`, `key`, `startKind`), which `viewerStoreRecord` gives the viewer: Export All's data, and in Export Artifacts each view's `versions` (`CTViewer.recordVersions`). The version menu shows standalone too, and a Design artifact's older version opens its own canvas. `build_viewer.js` rebuilds an Export Artifacts viewer the same way.

What Export All records for Export Changes goes through `recordableExport`: a chat or artifact with a file in the folder writer's failures (`write-errors.txt`; for a chat also the `artifacts/` folders its published pages went into, `storeDirs`) is left out, and so is a chat whose published versions were left unsaved after a 401 (`savePublishedPages` returns them with `retry`; any of its versions left incomplete after the 401 points its README at errors.txt, and a chat after the one that met the 401 gets one `published_page` warning saying so). Both are tried again by the next Export Changes. An artifact view carries `foreign` (`artifactForeign`: shared, or listed without rel `mine`), which alone decides its local HTML/SVG links; `shared` keeps the tab and label.

The record: `exportRecord[<org>].artifacts` maps an artifact uuid to the live version claude.ai listed (`listedArtifactVer`), written after the export for artifacts the step saved whole (`step.whole`). `changedArtifacts` keeps the listed ones that are new or whose version differs, so one saved in part is retried. `export-manifest.json` gains `artifacts: { listed, thumbs, items }`. `index.md` gets an "Artifacts" section, with `artifactsChangedLine` for a changes run.

Viewer parts: `artifactViewParts({ firstPart })` and `moveUploadText({ firstPart })` number parts so the chats' upload parts continue after the artifact parts (`writeViewer` opts `{ artifacts, firstPart }`); one `viewer-files/part-NNNN.js` series, one `__archivePart`.

**Links.** `artifactLinksOf(data)` (export-core.js) lists, per chat, `{ uuid, messageUuid, how, docKey }` over every message of every branch: `published` for each publish `publishedPagesOf` finds; `made` for a `Claude_Docs__batch` whose result names the new artifact (`created.minted`, else `frame.url`); `edited` for any other `Claude_Docs__*` call on a project container id, or an `edit_version` call with a `slug` whose result isn't an error. Mentions, opens and lists link nothing; failed calls link nothing. `buildViewerData` turns these into each artifact's `links` (chat index, message, how) and `docFile`; a `published:<uuid>` file gets `artifact: <view id>`.

**The combined viewer.** `viewer/artifacts-app.js` exposes `window.CTArtifactsApp.mount(container, options)` and returns `{ route(hash), show() }`. Standalone (Export Artifacts' viewer) it owns the page. Hosted, by the chat viewer with `{ data, loadPart, onOpenChat }`, it lives in a shadow root, its CSS from `viewer/artifacts.css` (`ARTIFACTS_CSS` in the template, so the chat page's styles don't leak in) and uses the chat viewer's own part loader, so there is one `__archivePart` on the page. Hosted previews sit in a guard frame (`guardDoc`) whose own CSP is `frame-src 'none'`: a preview's navigations are checked against its parent's policy, and the chat viewer's page allows `file:` frames for PDFs. Both frames carry `allow-scripts allow-forms allow-modals`; the guard runs nothing. The In chats tab (`inChatsFiles`) shows each file a chat made, and its preview resolves relative files only from that chat's own files. A viewer built by `tools/build_viewer.js` carries empty artifacts placeholders (no artifacts, no In chats tab content), which are inert. `tests/e2e/combined.e2e.js` covers the combined archive.

## The panel

`popup.html` and `sidepanel.html` are the same file (`tests/screens.test.js` keeps them identical); `IS_POPUP` puts `popup` or `sidebar` on the body. The main screen has two sections, This chat (`exportZip`, `exportMd`, `exportMdEmbed`, `exportJson`) and Everything on claude.ai (`scopeAll`/`scopeChanges`, `pickChats`/`pickArtifacts`/`pickSessions` with `exportCliSessions` under Sessions, `formatFolder`/`formatZip`, `countBtn`, `exportSelected`); the other screens are Exporting, Done, Export stopped and Settings (`showScreen`). The bulk Markdown, Embedded and JSON exports (`bulkExport`) are gone. Every Export All chat folder already has them. Export Artifacts is the Artifacts-only run: `runSelected` asks `exportPlan` what to run: `bulkExportZip` (with `withChats`, `withArtifacts`, `withSessions`, and `changesOnly` only when a record exists) when Chats or Sessions is ticked, `exportArtifacts` when only Artifacts is, nothing when none is. The popup's handoff note carries `{ scope, chats, artifacts, sessions, format }` (`handoffChoices`; `handoffFrom` reads a missing `sessions` as `true`).

**Run result.** `bulkExportZip` and `exportArtifacts` never throw; they return `runResult(...)`: `{ outcome ('done' | 'stopped' | 'failed'), reason, target: { kind: 'folder' | 'zip', name }, saved: { chats, artifacts, versions }, warnings, warningList, errorFiles, notes, startedAt, endedAt }`. `notes` holds plain sentences the Done screen shows after the counts ("Nothing changed since ...").

**Progress and stopping.** Both take `options.onProgress`, called through `exportProgress` with `{ phase, done, total, sub, warnings }` (phases chats, artifacts, viewer); `options.onTarget({ kind, name })` (`exportTarget`) names the run folder or ZIP before any fetch; and `options.signal`, an object `{ stopped }` the Stop button sets, checked before each chat, artifact and older version (`stoppedRun`). A stopped folder run keeps the files written, writes no viewer, index or manifest and records nothing; a stopped ZIP run downloads nothing. The panel keeps one running flag (`exportRunning`, set by `exclusiveExport`), which `scheduleRefresh` also reads; `runSelected` also holds the Web Lock `claude-takeout-export` (`navigator.locks`, shared by the popup and every sidebar) for the run, so a second Export selected in another page flashes that another export is running. Export All asks for the next chat while it writes the current one (`fetchChat`: one request at a time, at least `CHAT_FETCH_GAP`, 200 ms, after the last one started; this replaced a fixed 200 ms pause after each chat; `content.js` `fetchConversation` tries a 429 or 5xx again up to three times, after its Retry-After up to 30 s, else 2, 5 and 10 s) through `sendToTab`, which re-injects `content.js` once, only into a tab `chrome.tabs.get` shows on `https://claude.ai/`; a tab that still doesn't answer ends the chat loop (`tabGone`): the artifact step is skipped, the run finishes with what it has and one warning (`TAB_GONE_REASON`, the number not exported), and only the exported chats are recorded. Shortcuts act on the main screen only and take `e.key` when it is an ASCII letter (QWERTZ, AZERTY), else `e.code` (`KeyZ`), since Option+letter on macOS types a symbol.

**Counts.** `countEverything` asks `content.js` only when Count is clicked and keeps `{ [org]: { chats, artifacts, changedChats, changedArtifacts, at } }` in `chrome.storage.session` under `takeoutCounts` for ten minutes (`cachedCounts`). Opening the panel fetches no list. Sessions are not counted, so with Sessions ticked `nothingChanged` is never true and the summary only names them ("Plus Claude Code and Cowork sessions.", or "Claude Code and Cowork sessions." alone).

## Error reporting

`ExportErrorCollector` collects errors (something is missing), warnings (something may be incomplete) and, since v1.22.1, notes (something about a file worth knowing, with nothing missing) during one export. `generateErrorReport` writes them to `errors.txt` with a recovery hint per type: warnings first, then notes under `## Notes`, and the summary counts them apart. Errors and warnings turn the status pill amber and are counted on the Done screen, in the panel footer (`exportRecord.warnings`) and in Export All's `index.md`. Notes are counted nowhere: they go in the chat's README.md under **About some files** (`readmeNoteLines`, grouped Drafts, Helper scripts, Renamed files), in `errors.txt` (which an export with only notes still gets), and to the viewer, where `viewerFlags` marks a file with a draft note `draft` and a helper-script note `helper` (a warning's flag wins). The Done screen adds one quiet line when there are notes.

| Type | Meaning |
|---|---|
| `upload` | An upload could not be downloaded. |
| `presented_file` | A `present_files` file could not be downloaded. |
| `delivered_file` | A `SendUserFile` delivery could not be downloaded. |
| `project_doc` | A project document is missing or only partly recovered. |
| `project_metadata` | The project's metadata request failed. |
| `str_replace_failed` | A successful edit could not be replayed. |
| `artifact_basename_collision` | Two paths had the same filename; one was renamed. A `name_changed` note since v1.22.1; still read in older archives (`_getRecoveryHint`, `warningsFromReport`). |
| `artifact_opaque_mutation` | A bash command changed a file in a way replay can't follow, and no download or note explains it (rule d below). One entry per file, counting its commands. |
| `doc_diagram` | A Claude Docs document's diagrams show only by caption, and the chat has no self-contained HTML copy of it; the note links the live document. |
| `tool_image` | An image Claude looked at (a tool result that links a claude.ai file) could not be downloaded. |
| `web_image` | An image from a web search was not saved: no permission to fetch from other sites (one warning for all), or the site refused it. |
| `claude_doc_unreplayed` | A Claude Docs edit could not be rebuilt from the chat; the note links the live document. |
| `export_health` | The chat's data looks incomplete, the likely sign of a change in claude.ai's API (`chatHealth`): no messages although the chat changed, messages with no content, no current branch in a branched chat, unknown content block types, or none of several uploads downloaded. An empty assistant message created within 5 s of a complete assistant parent is claude.ai's own tail and doesn't count. A mega-ZIP's `index.md` counts these chats, and the chats claude.ai listed. |
| `published_page` | A published page could not be saved, or only partly: no claude.ai tab, a failed request (401 once per export), a file too large, a checksum mismatch, a renamed or rejected path. |
| `artifact_export` | Export Artifacts could not save an artifact or part of one: a failed request (401 once, then it stops), a file too large, a checksum mismatch, a renamed or rejected path, a full list that could not be paged or was cut at its cap, or a count of artifacts found only by paging. |
| `viewer` | One chat could not be added to `viewer.html`. |

Each error records the URLs tried, HTTP status and fallback result. A new kind of failure gets a new type and a `_getRecoveryHint` case.

Note types (`addNote`, each with a `_getNoteHint` case):

| Type | Meaning |
|---|---|
| `draft_superseded` | A file changed by a command the export can't follow, after which Claude delivered or presented files from its folder or below; this draft is likely an earlier state of one of them (rule b). |
| `helper_script` | A run script (`.py .sh .bash .pl .rb`) changed that way and never presented or delivered: a script Claude ran (rule c). |
| `name_changed` | Two different files had one name; this one was saved under a new name. Both sandbox paths are given. |

A note never stands where a file may really be missing: when unsure, the entry stays a warning.

---

## Bash mutations and replay_bash.py

The extension replays file tools, `cat >` heredocs and, since v1.22.1, a few literal bash shapes. Everything else a bash command does to a tracked file is left to `replay_bash.py`.

**Working directory.** `commandCwds` (export-core.js) gives each bash call its directory: its own leading `cd <dir> &&` (or `;`, or a newline), else the directory an earlier call's leading `cd` left, since the sandbox shell keeps it. Any other change of directory (a second `cd`, one after `&&`/`||`, in a subshell or after `then`/`do`/`{`, `pushd`, `popd`, `chdir()`) leaves it unknown from there on, and so does a command that failed (`bashFailed`), since it may have stopped anywhere. `resolveSandboxPath` reads a relative word against it; with no directory, a word names a file only when exactly one known path ends in it, and such a file is never replayed, only named. A directory carried from an earlier call, or set by a leading `cd` followed by `;` or a newline rather than `&&`, may be wrong (a `cd` that failed doesn't always fail its command), so `commandCwds` reports those calls as uncertain; for them, a relative word whose join is no tracked file falls back to every tracked file of that name, unresolved (`resolveTouch`): never replayed, and a warning. Tracked paths are compared normalized (`//`, `/./`, a leading `./`; `normalizedKeys`), and a hit is filed under the path as the chat wrote it. The replay and the detector share these helpers.

**Replay of literal swaps** (`literalSwapCommand`, `extract_artifacts.py` byte for byte). A whole command is replayed only when every part is one of: `cd <dir>`, `&&`, `;`, a read-only tool (`grep`, `head`, `tail`, `wc`, `cat` with no redirect, `sed -n`, `ls`, `echo`/`printf` with no redirect, `test`/`[`), a `cp` onto a file that isn't tracked, or one of:

- `sed -i` (or `-i.bak`) with `s<d>A<d>B<d>[g]` scripts whose A has only escaped metacharacters and whose B has no `&`, back-references or newlines; applied line by line, the first match or every one with `g`, to each file named (`sedSubstitution`, `applySedSubstitutions`);
- `cat >> <file> << '<D>'` with a quoted delimiter: the body and a newline are appended;
- a Python script (`python3 - << 'D'` or `python3 -c`) that only reads one file, calls `s = s.replace(<literal>, <literal>[, 1])` (or a list of pairs and a loop), writes it back and maybe prints (`pythonSwapScript`, `applyPythonReplace`), replaced as `str.replace` does.

The edit lands in place, so the turn's `_vN` carries it. It needs the file's text known: created in the chat, with every change since replayed. A command whose result shows it failed (`bashFailed`: `is_error`, claude.ai's JSON `returncode` not 0, Claude Code's `Exit code N`) is never replayed and its files become opaque, since the shell may have stopped part-way. A command that isn't one of these shapes (`commandTouches`) makes opaque the tracked files it names or writes, and any command that can't be shown to write nothing else (any other Python, any script run, an unknown tool) makes every tracked file opaque. A file tool the replay doesn't model (`MultiEdit`, `NotebookEdit`, `str_replace_based_edit_tool`, anything new) whose `path`, `file_path`, `filepath` or `notebook_path` names a tracked file makes it opaque too and is recorded as a skipped edit; tools that only read (`view` and a `view` command, `Read`, `read_file`, `present_files`, `SendUserFile`, `Artifact` and the like, `READ_FILE_TOOLS`) don't. A file's replay stops at its first opaque command and never resumes, so `_vN` keeps meaning "what the declarative replay knows" and `replay_bash.py` starts from the same state. With `<<-`, leading tabs are removed only after a newline (`stripHeredocTabs`), as bash does, not after `\r` or a Unicode line separator.

**The detector.** `detectOpaqueMutations` (popup.js) names the files a command it didn't replay changes: Python writes (`open(p, 'w'|'a'|'x'|'r+')`, `Path(p).write_text/bytes`, `Path` variables, `open(file=...)`) on the whole command, and shell writes per simple command (`shellSegments`, `shellWords`, so quoted text is never a redirect): redirects, `sed`/`perl` in place, `awk -i inplace`, `tee`, `cp`/`mv`/`install` onto a file, `dd of=`. `cat` heredocs are removed first, and one with an unquoted delimiter whose body bash would expand is flagged. Commands the replay applied are skipped. All of one file's commands merge into one entry (`byFile`), with the count, the message numbers and the file's name in `artefacts/`. A file that `extractArtifacts` marked as having skipped edits (`index[key].skipped`, with their positions in `skippedAt`) gets an entry too. An entry whose name several files could be (no directory, or an uncertain one) is unresolved and keeps those files as `candidates`.

**Sorting** (`sortOpaque`). Each entry goes through these rules; the first that matches wins. Rules a and b need the entry's path resolved. "At or after" compares positions (message, then block within it) with the file's last change of any kind, replayed or not, so a presentation earlier in the same message than the change is before it; the same test decides whether a presentation or delivery may replace the replayed file.

| Rule | When | Result |
|---|---|---|
| a | A presentation or delivery saved under the file's own name in `artefacts/`, at or after its last change. This also matches a copy presented from another folder that took the file's export name. | Nothing listed: that download replaced the final file and its last `_vN`. A copy kept apart as `<base>_delivered` doesn't count. |
| b | Files presented or delivered and downloaded at or after its last change from its folder or below (whole path segments, `isUnderFolder`). For a draft under `/home/claude/`, also a file from `/mnt/user-data/outputs/` or below, but only when its name has the draft's stem, or when a bash command that didn't fail, at or after the draft's last change, names the draft (its path or name) and `/mnt/user-data/outputs`. | Note `draft_superseded`, naming up to three of them. |
| c | A run script (`.py .sh .bash .pl .rb`) never presented or delivered. An unresolved entry matches when every one of its candidates is such a script. | Note `helper_script`. |
| d | Anything else, including an unresolved entry with no candidates or any that isn't a run script. | Warning `artifact_opaque_mutation`, pointing to `replay_bash.py`. |

Rule b says "likely": it is a judgment that the delivered file holds the draft's work, not proof.

`replay_bash.py` reruns Claude's actual commands from `original.json` in a temporary folder, with `/home/claude`, `/mnt/user-data`, `/tmp` and `/root/.claude` mapped into it, asking before each command. Commands are untrusted. On macOS a deny-by-default `sandbox-exec` profile isolates them, paths leaving the folder are refused, results are read back without following any link (`read_sandbox_text`), and tokens are kept out of the environment. On Linux it refuses to run without `--no-isolation`. It updates the final file and its last `_vN`. `docs/WASM_REPLAY_APPROACH.md` explains why this is a CLI and not in-browser Python.

---

## The offline viewer

Every export includes `viewer.html`, a single page that shows the chats as they looked, opened from disk with no network.

**Building it.** `takeout-viewer.js` (`CTViewer`) holds the data contract:

- `buildViewerChat` turns one payload into the viewer's shape: every branch, rendered tool calls, file versions, uploads, the project. A file named in `ctx.flags` (`viewerFlags` over the export's warnings and notes; the old-archive tool gets warnings from `errors.txt` with `warningsFromReport`, which reads the Warnings section only, so a rebuilt viewer has no draft or helper badges) gets `flag`, and the viewer shows a "May not match" badge on its cards, a note in the Files list and an explanation in the file panel; a `draft` or `helper` flag shows a softer **Draft** or **Helper script** badge.
- `buildViewerData` gathers the chats and stores each distinct project once in `data.projects`; a chat's `project` is an index into it. `viewerProject(meta)` (export-core.js) gives each project `id`, `description` and `updated` from `project.json`'s `uuid`, `description` and `updated_at`, never the old-archive tool's placeholder id `project`; `popup.js` and `chatFromDisk` pass that metadata. `buildViewerData` merges projects by `id`: the newest `updated` wins, then the one with more docs plus files, else the first. A project without an id is grouped by a cheap key and compared in full only within a group, as before.
- `moveUploadText` moves upload text, and generated-file version text other than stylesheets and scripts, over `UPLOAD_INLINE_LIMIT` (64 KB of UTF-8) into parts of at most `PART_LIMIT` (4 MB). Each part is `viewer-files/part-NNNN.js`, which calls `window.__archivePart(n, { u0: text, f0: text, ... })`. When a part can't load, an upload or a file version falls back to its own copy in `uploads/` or `artefacts/`, when there is one.
- `assembleViewer` inlines the template, the data (`<script id="data">`), the app, `marked`, KaTeX and highlight.js into one HTML string. `writeViewer` in `popup.js` adds it to the ZIP.

A chat that fails to build gets a `viewer` warning. A viewer that fails as a whole is reported in the status line. Neither stops the export.

**Running it.** `viewer/viewer-app.js` renders the page, and `viewer/viewer-logic.js` holds its pure functions (tested in Node):

- Projects and All chats (only when the viewer has more than one chat). The sidebar's Recents are `recentChats(chats, RECENT_LIMIT)` (30, newest first, undated last); `projectList` orders projects by `updated` (the newest of the project's own date and its chats' dates, undated last), names a repeated name "Name (2)" in the projects' order (so a label doesn't change when another project gets a newer chat), and gives each a key (its id, else `i<n>`, with `~` added while a real id already has it); `filterByText` is a case-insensitive substring match (`foldCase` only lowercases, like sidebar search); `parseListHash` reads `#projects`, `#project=<key>` and `#chats` (`LIST_PAGE` = 200 rows at a time). `routeLists` sets `listState` and `showLists` shows `#lists-screen`, hiding the chat area and Artifacts (`body.lists-on`); `renderListPage` draws `projectsPage`, `projectPage` or `chatsPage` with `chatRows`. Titles are saved and restored by `chatTitles`/`restoreTitles`. `/` focuses the page's filter box. A page's filter text, chat rows shown and scroll are kept in its history entry's state (`saveListView`: 300 ms after typing or scrolling, at once on Show more, and a save still waiting is written on any click before a link navigates, `flushListView`; Safari allows only 100 history calls in 30 s; `savedListView`), so Back or Forward finds the page as it was; a new visit, or the Projects or Chats entry, starts afresh. A project's instructions start collapsed (12em) and lose the cut once drawn when they fit. `renderProject` adds `a.open-project` (and a "Project · name" line, with the name the lists screen gives it, when there is nothing to fold) in such a viewer. Every name is set as text.

- Chat text goes through escaped HTML, text placeholders and `sanitizeHtml`.
- Math renders with KaTeX.
- Syntax colors run in a blob worker, block by block as they scroll into view, and stop after `HIGHLIGHT_TIMEOUT`, since highlight.js can hang on some input. `tameMarkdown` keeps an underscore inside a word from turning the rest of a Markdown file italic.
- The Files button lists a chat's files (`chatFiles` in viewer-logic.js): outputs from its file cards, each once, ordered by the last card that shows it, and its uploads and pasted texts, each once. `buildViewerChat` marks each file `shared` when Claude sent it, presented it, saved it under `/mnt/user-data/outputs/` or made it with the artifacts tool; the others are listed as working files. A viewer built before the mark lists everything as outputs.
- Download (`fileDownloadButton`; on the Artifacts screen `downloadButton`) saves a file the viewer holds through `saveBytes` (viewer-logic.js): an `application/octet-stream` Blob, a `blob:` URL and a temporary `<a download>`, named by `downloadName` (the last path segment, cleaned, at most 200 characters). Chrome ignores `download` on a link to a `file:` URL and opens the file, so the viewer never links a file on disk for it. Chat viewer: beside Copy, for any file text it holds (a part-backed upload once loaded), named as the version's own file. Artifacts screen: the start file and each list row whose text or image is in the artifact's preview payload (`heldData`, `dataUrlBytes`), and In chats files; Download ZIP (`zipLink`) is a plain link to the view's `zip`, through `openableHref`.
- Popups and the file panel have a Copy button for a whole text file. It copies the source even in Preview. A Wrap button beside it (`wrapButton`, `setWrap`) toggles `body.wrap-code`, which wraps `.file-code`; it is stored in localStorage under `claude-takeout-wrap` and shows only with text, not in Preview.
- Search reads titles, prompt and reply text, attachment names and text, and upload names. It never reads upload or file text, which is why that text can live in parts. `buildSearchIndex` keeps each entry's lowercase text only, with the title or the message (`src`) to rebuild the shown text from (`messageSearchText`), and a hit's `snippet` is a getter, cut only for the hits the sidebar shows. "Also search inside files" (`#search-files`, off by default, remembered in `localStorage`) adds `searchInFiles`: `fileSearchSources` lists each chat's files (newest version) and uploads once, with their inline text or part; inline text is searched at once and parts are loaded one at a time through `loadPart`, `fileHit` matching each file's name and text against the same parsed query. A newer search stops it between parts (`fileSearchGen`), and at most `FILE_HIT_LIMIT` (100) files are listed. `parseQuery` turns a query into words that must all appear, `"phrases"`, `OR` alternatives and `-exclusions`; `searchChats` matches each title or message against it; `groupHits` groups the hits by chat and ranks them (title match, then most messages, then newest). Opening a hit starts the match bar: `findPlan` lists the chat's messages whose shown text matches (`shownText`: math and link and image addresses left out, kept per message for the next keystroke), with `countLower` occurrences each, and `markNth` marks one occurrence at a time in what the page shows (prose and prompt bubbles, not KaTeX), moving on when one isn't shown. When nothing further is shown in a direction, the bar returns to the last match it showed and turns that direction off. `foldCase` maps matches back to the text where lowercase changes its length. Only code blocks holding a match lose their colors while stepping, and `clearMarks` brings them back when the search ends.
- `start` parses the data script once and removes it, so the page doesn't keep the text beside the parsed copy.
- A part loads when its upload or file is opened, through a `<script>` tag. The last two loaded parts are kept (`PARTS_KEPT`); an older one loads again when needed. A `file://` page can load scripts beside it but can't `fetch` them.
- Generated HTML files preview in a sandboxed `srcdoc` frame with a narrow CSP. Sibling `.js` and `.css` files are inlined by `inlineSiblings`.
- **Zoom and drag** (since v1.23.0). Pure helpers in viewer-logic.js, tested in Node: `ZOOM_STEPS` (10% to 800%), `clampZoom`, `stepZoom`, `wheelFactor` (continuous zoom for a wheel or pinch), `zoomAbout` (keeps the point under the pointer still), `fitZoom`, `pictureRange` (min of Fit and 10% up to 800%, also capped so the longer side stays within `PICTURE_MAX_SIDE`, 32768 px), `doubleClickZoom`, `svgNaturalSize`, `svgHasScripts`, `svgDataUrl` and `pageFit`. Two DOM controllers use them. `pictureZoom(box, img, opts)` wraps a picture area in `.zoom-frame` with a `.zoom-bar`: it starts at Fit and refits on resize while at Fit, sizes the picture in px, zooms on Ctrl/Cmd+wheel and pinch (a non-passive `wheel` listener, since a trackpad pinch arrives as Ctrl+wheel; a plain wheel only with `plainWheel`, which only the gallery sets), drags with a 4 px threshold that swallows the click after a drag, and answers the keys `+ = - 0 1`. `destroy()` hides the bar and keeps the frame, so the gallery's next and previous never lose focus. A picture that fails to load calls `opts.onError`. `pageZoom(wrapper, frame, opts)` is the bar for a page frame, 25% to 200%: it sets `--page-zoom` on `.page-zoom`, and the CSS scales the iframe from the top left while sizing it to the wrapper divided by the zoom, so the iframe gets no new attribute. The bar sits in its own strip below the frame. **Fit width** is enabled only for a page wider than the frame and never enlarges. Both controllers give `state()` and `restore()`; the chat viewer's `panelZoom` and the Artifacts screen's `keptZoom` keep a state per file (and per picture or page kind, since the states differ) so another version of a file keeps its zoom and another file starts at Fit. The Design canvas has its own zoom in `canvasPage` in artifacts-app.js. Since v1.23.2 the canvas sits in a window, `.design-view` (overflow hidden, as tall as `#page-body`, a dotted background), and is placed by `translate` on `.design-canvas`; boards and notes are still laid out in px for the scale (`apply`), so their frames scale as before. Pure helpers in viewer-logic.js: `CANVAS_ZOOM_MIN` and `CANVAS_ZOOM_MAX` (10% and 200%), `canvasFit` (the whole layout in the window, never above 100%), `clampPan` (80 px of the canvas, or all of a smaller one, stay in the window) and `panAbout` (keeps the point under the pointer). The canvas opens fitted to the width from the top (`canvasScale`, `startView`); Fit (`fitAll`) shows the whole design above the bars; a resize redoes either while the reader hasn't zoomed or moved, and otherwise keeps the zoom and the middle of the window (`rescale`). The window never scrolls: a scroll the browser makes (focus, scrollIntoView) is turned into a move, and keyboard focus on something out of view centres it (a board above or left of the window is out of the browser's scroll range, so this is how Tab reaches it); focus from a press, between `pointerdown` and `pointerup`, never moves the canvas, or a click on Open alone would land elsewhere. With boards not drawn listed below, the window ends 72 px short, so the list shows and the page scrolls to it. Below 20% the canvas has the class `far`, which hides Open alone and badges, and (since v1.23.3) every board's frame is removed and its body gets the class `tile`; the IntersectionObserver makes no frame while far, and coming back from far observes every board afresh so those near the view get their frames. The IntersectionObserver that makes frames near the view has the window as its root. Two modes (since v1.23.1; `canvasMode`, `move` when the viewer loads, kept in memory for the mount, never stored), chosen in the pill `.canvas-modes` (the arrow and hand icons, keys V and H) at the bottom middle; the zoom bar `.canvas-zoom` sits bottom right. In Move the canvas has the class `moving`, whose CSS sets `pointer-events: none` on each `.board-frame` (the frames keep running), so a plain wheel zooms about the pointer (`wheelFactor` without pinch), Shift+wheel or a mostly sideways swipe moves sideways, and a drag anywhere moves the canvas. In Interact the boards take the mouse; from the background, a board's head or a note a plain wheel moves the canvas, Ctrl/Cmd+wheel zooms and a drag moves it. Touch drags like a mouse (`touch-action: none` on the window), so a touch pinch doesn't zoom. Space held in Interact is Move until keyup, window blur or the pointer leaving the window; it is ignored on repeats and when focus is in a field or on a button. Cmd+wheel zooms at the plain-wheel rate (only Ctrl, which a trackpad pinch sends, counts as a pinch for `wheelFactor`). `canvasZooms` keeps the view (`start`, `fit`, or a zoom and the canvas point in the middle) per artifact and version for Back from Open alone.
- **`SIZE_SCRIPT`.** `previewDoc` and `artifactPreviewDoc` end every preview document with `SIZE_SCRIPT`, a small script that posts `{ type: 'ct-size', width, view }` to `window.top` on load, on resize and from a `ResizeObserver`. `pageZoom` accepts it only when `e.source` is that preview's window (`opts.source`; the default is the frame's `contentWindow`, and hosted on the Artifacts screen it is the guard frame's `frames[0]`, since the page sits in the guard frame's inner frame; `guardDoc` itself did not change) and `pageFit` gets finite numbers. A message from any other window is ignored. The page CSP, `PREVIEW_CSP`, the sandbox flags and `sanitizeHtml` did not change.
- **SVG files as pictures.** A generated `.svg` with text and no script is shown as an `<img>` with a `data:image/svg+xml` URL (`svgDataUrl`, sized by `svgNaturalSize` from `width`/`height` or the `viewBox`), so it zooms like any picture. One whose size isn't known (no `viewBox`, no fixed width and height) would be drawn at the browser's default 300×150 and cropped, so it stays a page (`svgAsPicture`). That is safe because an SVG loaded as an image runs no script, loads nothing from outside the document and renders a `foreignObject` inertly, and the page policy allows `img-src data:`. `SAFE_IMAGE_URI` in artifacts-app.js still limits what an image or a preview may name; the SVG data URL is built by the viewer from the file's text, not taken from the data. The browser reads an image SVG as strict XML, so an SVG it refuses (no `xmlns`, a stray entity such as `&nbsp;`) fires `onError` and the picture is replaced by the sandboxed frame with the page bar, as before. An SVG with a script (`svgHasScripts`) is not turned into a picture and stays sandboxed, for the sake of its function.

The page's CSP allows no network. `file:` is added to `script-src` only when parts exist (`fileScripts`).

---

## Viewers for older archives

`tools/build_viewer.js` gives an export made before v1.6.0 a viewer, offline, from its `original.json` files:

```
node tools/build_viewer.js <folder> [--out <dir>] [--force] [--dry-run] [--json]
```

- `tools/archive-lib.js` finds archives and rebuilds each chat from disk (`chatFromDisk`). Artifacts, uploads and project files are read from the archive's own folders.
- `readArtifactStore(root)` reads every artifacts layout into one shape: chat archives with `published/` and `published.json` (before 1.17), 1.17 combined archives (`published/` beside a flat `artifacts/<dir>/` with format 1 `artifact.json`, whose `savedIn` points at the chats' copies), 1.18 archives (`artifacts/<dir>/<ver>/`, format 2), and standalone Export Artifacts exports (manifest `kind: "artifacts"`, the artifact folders at the root). `artifactJsonV2FromDisk` turns any of these records into the format 2 object, `artifactViewsFromDisk` into `ArtifactView` records for the viewer (with card pictures from `viewer-files/thumbs/`). Every path read from on-disk JSON (a version `folder`, a `savedIn` or `sameAs` target) goes through `realDirUnder(dir, rel)`: it resolves only through real folders, so a link anywhere on the way means the path is not read. `build_viewer.js` uses these to keep the Artifacts screen; it reads the layout as it is and never converts it, and a standalone Export Artifacts export gets its viewer the same way (`--force` is still needed to replace an existing one).
- Files the owner added to an archive after export are listed under "Archive files". Their text and media go into `viewer-files/` parts.
- `tools/archive-zip.js` extracts ZIPs into new folders under `--out`, refusing unsafe entries.
- The tool writes only `viewer.html`, `viewer-check.gif`, `viewer-files/` and new folders under `--out`, through temporary names that are swapped in.

The `build-archive-viewer` skill wraps it.

`tools/merge_archives.js` combines archives, typically a full Mega-Zip and the change archives after it:

```
node tools/merge_archives.js <archive folder or ZIP>... --out <dir> [--name <name>] [--dry-run] [--json]
```

- Each source is found with `findArchives`; ZIPs are first extracted with `extractZip` into `<out>/.merge-<pid>/`, which is removed at the end.
- `pickNewest` keeps one copy per chat uuid: latest `updated_at` in `original.json`, then the later `exported_at` from `export-manifest.json`, then the source named later. Chats without a uuid are all kept.
- The chosen chat folders are copied (`copyTree`: real files and folders only, never links, never overwriting) into `<out>/.<name>.partial-<pid>`, together with each mega source's `projects/` folders (newest source first, the first of a name wins), a new `index.md` and an `export-manifest.json` with `kind: "merged"`, `sources` and each chat's `from`. A single-chat source's `viewer.html`, `viewer-check.gif` and `viewer-files/` are left behind. The folder is then renamed to `<out>/<name>` (default `claude-takeout-merged-<date>`), and `writeViewer` from `build_viewer.js` gives it one viewer.
- The artifacts of every source go into one 1.18 `artifacts/` store (`readStores`, `mergeRecords`, `writeArtifacts`). By uuid, the union of versions in claude.ai's order (`mergeOrder`); a version in several sources comes whole from the newest source by `exported_at` (`newestFirst`) whose copy is complete (`wholeCopy`; else the newest with any copy), never file by file, and `publishedIn` lists are joined. `listed`, `current`, title and claude.ai metadata come from the newest source whose record says `listed: true` when it is newer than the deciding source, the newest full source whose artifact step ran (manifest `kind` `full` with an `artifacts` block, or `artifacts`); otherwise from the deciding source, where an artifact it doesn't list is `listed: false`. Newer and newest are by when claude.ai's list was asked (`decidedAt`, `listedAtOf`), not by the archive's `exported_at`: an export's own time, and a merged source's manifest `artifacts.decided_at` (the deciding list it used) and `artifacts.listed_at` (per listed uuid, the list that listed it), which `merge` writes from v1.20.6. So a newer changes source can list an artifact and move `current` forward, never unlist one, and a merge combined with an older export keeps its newer list; a merged source from before v1.20.6 neither decides nor lists. With no deciding source, the newest source that lists it wins, else the newest source's values stay. The merged manifest gets its `artifacts` block (claude.ai's list is in the archive: `listFetched`) when any source's manifest had one or was an Export Artifacts. A winning `sameAs` version is re-pointed at the merged chat's file with the same SHA-256 (`repointSameAs`), or its bytes are copied into `<ver>/` (`copiedVersion`; an older source's real folder is preferred), and any version a merged chat published as not-same is copied too. A single chat's `published/` is folded in; a `published/` folder with no readable `published.json` is kept as it is at `published/<dir>` (`keepUnreadPublished`). Card pictures come from the record the listing came from, else the newest source that has one. The current version's ZIP comes from the source whose folder was copied, else from another source whose folder has the same files, missing ones aside, and is as complete (`sameFiles`, `wholeCopy`). An artifact's note drops "not exported"/"not saved" parts when the merged current version is complete and "files saved with the chats" when it got a folder (`mergedNote`), and the record's `incomplete` goes with a dropped "not exported" when every merged version is whole; the sources' `artifacts/errors.txt` (an Export Artifacts' root `errors.txt`) are joined into the merged `artifacts/errors.txt`. A ZIP entry `extractZip` refused makes `report.ok` false (exit 1). An archive with only artifacts, or a changes archive with only artifacts, is accepted; the result always has the Export All shape (`artifacts/` under the root, root `index.md`, `export-manifest.json` with `kind: "merged"`), and `artifacts/index.html` and `index.md` are written with `artifactsIndexHtml` and `artifactsIndexMd`.
- `rewriteChatLinks(text, map)` (archive-lib.js) rewrites, in the written copies of `README.md`, `full_chat.md`, `integrated_chat.md` and `responses/*.md` (`rewriteLinks`), each Markdown link into `published/` (`published/…` or `../published/…`) to the page's new place under `artifacts/`, by uuid and version (`linkMapper`). Links inside code blocks and spans are left alone. A link it can't map stays and is listed in the report's `unmappedLinks`; one that is also broken in the merged archive is a warning. A file that can't be copied fails the merge: nothing is renamed into place.
- Sources are only read. An existing destination, or `--out` inside a source or an archive, stops the run before anything is written.

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
| `/api/frame/frames?org=<org>&limit=1000` (header `X-Frame-CP: go`) | `content.js` `listArtifacts` | The artifacts claude.ai lists (Export Artifacts); only the fields it needs are returned. No paging. |
| `/api/frame/artifacts?rel=all&…&limit=100&org=<org>[&page_token=…]` (header `X-Frame-CP: go`) | `content.js` `fetchArtifactPages` | claude.ai's full artifact list, paged; adds what the frames list missed. |
| `GET https://<uuid>.frame.claudeusercontent.com/_f/<ver>/_thumb.img` (query `__frame_t`, from the listing) | `content.js` `artifactThumbUrl`, fetched by `popup.js` `fetchArtifactThumb` | An artifact's card picture, for the artifacts viewer. Needs the optional `https://*/*` permission. No cookies, no referrer, no redirects, 2 MB cap; the URL is used only for that fetch, never stored, written or logged. |
| `/api/frame/<uuid>?org=<org>[&ver=<ver>]` (header `X-Frame-CP: go`) | `publishedPageInfo` | A published page's versions, title and asset token. |
| `https://<uuid>.frame.claudeusercontent.com/_f/<ver>/_files.json`, `…/_src/<path>` (query `__frame_t`) | `publishedPageFile`, `publishedPageInfo` | A published page's file list and files. No cookies sent. |
| `/v1/code/sessions?exclude_tags=-&limit=100` | `content.js` `listSessions` | Cowork and Claude Code sessions (Export All). At most 100, no paging. Headers `anthropic-version: 2023-06-01`, `anthropic-beta: ccr-byoc-2025-07-29`, `x-organization-uuid`. Only the kept fields are returned. |
| `/v1/sessions/<cse_id>/events?limit=<1..200>[&after_id=<last_id>]` | `content.js` `fetchSessionEvents` | One page of a session's events, kept, stripped and masked; `too large` over 32 MB kept. Same headers. |
| `/api/organizations/<org>/projects/<project>/files` | `fetchProjectFileList` | Project knowledge files. |
| `/api/organizations/<org>/files/<file>/contents` | `fetchUploadedFile`, project files, deliveries | A file's bytes. |
| `/api/organizations/<org>/conversations/<chat>/wiggle/download-file?path=<path>` | `fetchUploadedFile` | A sandbox file by path, including session-only uploads. |
| `/api/<org>/files/<file>/preview`, `/content`; `/api/organizations/<org>/files/<file>/content`, `/files/<file>` | `fetchUploadedFile` | Older fallbacks. |
