# Claude Takeout - Technical Documentation

How Claude Takeout gets a conversation from claude.ai, what the conversation JSON looks like, and how each part of an export is built from it. Current as of v1.7.0.

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
| `…show_widget` (visualize) | `title`, `widget_code` (an SVG or HTML fragment) | A diagram Claude drew in the chat, saved as `artefacts/<title>.svg` or `.html` (`widgetFile`), versioned under `widget:<title>`. |
| `image_search` | `query`; result has `images[]` (`title`, `url`, `thumbnail_url`, `page_url`, `source`) | Saved in `images/` with permission and shown under the search; listed as links otherwise. |
| `…publish_files` (claude-artifacts) | `files[]`, `title`; result's JSON has `url` | A page Claude published on claude.ai; the Markdown links it. |
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

### Diagrams drawn in the chat (`show_widget`)

claude.ai's visualize tool shows an SVG or HTML fragment inline, styled by claude.ai's own widget stylesheet: color classes such as `c-teal` and text classes `t`, `ts`, `th` that its guide documents. `extractArtifacts` saves each call as a file that stands alone (`widgetFile`): an SVG gets `xmlns` and `WIDGET_CSS`, which defines those classes and the CSS variables for light and dark, right after its opening tag, and is saved as `<title>.svg`; any other fragment is put in a page with the same stylesheet and a do-nothing `sendPrompt`, as `<title>.html`. Calls with the same title are versions of one file (`widgetKey`). `extract_artifacts.py` has the same stylesheet, byte for byte. `full_chat.md` and the response files link the file and show an SVG as an image; the viewer gives it a card. The tool's own guidance (`read_me`) and its acknowledgement are left out of the Markdown, as are the results of the claude-artifacts `guide` and `list_types` tools.

### Images from web searches

`webImagesOf` lists the images `image_search` results showed, once per https URL. They live on their own sites, so `saveWebImages` fetches them (`credentials: 'omit'`, no referrer, 20 seconds and 15 MB each, four at a time), the thumbnail when the image itself fails, and keeps PNG, JPEG, GIF and WebP by the type the site sends. Each is saved as `images/<key>_<title><ext>` (`webImageName`), the key being a hash of the URL, so the old-archive tool finds it again on disk. Fetching needs the optional `https://*/*` host permission: Chrome only grants it during a click, so Export ZIP asks for it before anything else when the chat has web images (`requestWebImages`), and the Settings checkbox "Save images from web searches" shows and changes it. Without it, one `web_image` warning says how many were left out; an image that fails gets its own. The Markdown shows each saved image under its link (`imageSearchLines`), and the viewer shows them as claude.ai does: one mosaic per response holding every search's images (`messageWebImages`, `renderWebMosaic` in viewer-app.js), the first four as tiles with the site on each and `+N` on the last, and a gallery that steps through all of them with the title and a link to the page (`openGallery`). It loads the saved copies from `images/` beside `viewer.html` (`ctx.webImages`, a tool block's `web`); an image not saved is a card with its title.

### Images Claude looked at

A tool result can hold an image claude.ai only links (`file_uuid`, `preview_url`), such as a photo Claude opened with `Read`. `toolImagesOf` lists them once per file, accepting only claude.ai preview paths, and `saveToolImages` downloads each from `https://claude.ai<preview_url>` with the session into `images/<first 8 of the uuid>_<name><ext>` (`toolImageName`; the name is the file the tool read). A failure is a `tool_image` warning. `full_chat.md` and the response files show each under its step; the viewer gets them through `ctx.toolImages` as the tool block's `images`, and the old-archive tool finds them on disk by that prefix.

### Steps in the viewer

The viewer folds what Claude did before its answer into one line per response, as claude.ai does (`renderSteps` in viewer-app.js): everything up to the last thinking or tool block. The line sums up the tools (`stepsSummary`: created, edited, read, ran, searched, fetched, in that order, the first two kinds and "and N more steps"), shows thumbnails of images Claude viewed, or, with no tools, the thinking's summary or "Thought for Ns" (from the block's timestamps). Opened, it is a box of rows: thinking, text between steps, and tools labelled as claude.ai labels them (`toolLabel`, `toolTarget`: a command by its `description`, a file by its name). Diagrams, web images and published pages are not steps. A response is split at each diagram (`renderAssistant`, `renderPart`): it shows inline where Claude drew it (`renderDiagram`, from the SVG text as a data URI image, a file the viewer data marks `widget`), with a menu to copy it, download it as SVG or as a PNG drawn on a canvas at twice its size (`diagramPng`), or open it in the side panel; the steps before and after it fold separately. Web images and published pages show after their group. Thinking with no text or summary is not a row, only time on the line, and the visualize tool's guide (`read_me`) is not shown.

### Long prompts in the viewer

A prompt longer than about nine lines, counting a long line as the lines it wraps to (`longPrompt`), is collapsed to 200px with a fade and a **Show more** button, as claude.ai shows it (`renderHuman`, `setCollapsed`). Code fenced in a prompt wraps. A search match inside a collapsed prompt or a closed fold opens it (`reveal`).

### Product cards, comparisons and questions

claude.ai's display tools (`product_carousel_display_v0`, `featured_card_display_v0`, `comparison_card_display_v0`) carry products in their input (`name`, `price`, `blurb`, and for a comparison `attributes: [{ label, value }]`), and the carousel and featured cards' results carry their pictures as `images` with ids `product_<n>_<m>`. Those are web images (`isImageResultTool`), saved like image-search images. The viewer gets them as a tool block's `display` (`displayData`: kind, products, each with its pictures) and shows them where Claude placed them (`renderDisplay`): a scrolling carousel with arrows and dots, a featured card, or a comparison table. `ask_user_input_v0`, claude.ai's multiple-choice question, isn't shown once answered (the answers are the next prompt). `full_chat.md` writes the products as headings with price, description and pictures, a comparison as a table, and questions as lists (`displayLines`). A citation whose metadata names the site shows as a pill with that name (`citeSite`), and a web search's query follows its label (`toolDetail`).

### Files on Claude's messages

claude.ai can attach a file to Claude's own message, such as a page Claude published with `publish_files`. `extractUploadedFiles` lists only files on your messages; `extractAttachedFiles` lists these. One whose name a replayed or downloaded artifact already has is that file and is not saved again; any other is downloaded by UUID into `artefacts/` (a failure is a `delivered_file` error). The viewer shows them on Claude's message, linked to `artefacts/`. Exports before v1.11.0 saved them in `uploads/` as `p<NN>_<name>`, and the old-archive tool links them there.

### Claude Docs documents

Claude Docs, the editable documents on claude.ai, live there rather than in a sandbox, so the export rebuilds each one from its tool calls (`claudeDocCreated`, `renderClaudeDoc` in export-core.js; `extract_artifacts.py` mirrors them). A `batch` call creates the document from Markdown in which `<?claude block k?>` placeholders stand for a date, an author mention or a pending section; its result begins with JSON whose `acks` give the document's node id and an XML outline with the pending sections' ids, followed by plain instructions for Claude. Each `update` replaces one pending section, by that id, with Markdown, or replaces found text (`target.kind: "find"`, the `nth` match, the first by default; `applyDocOps`, `docFindAll`), and each `create` on the document adds a comment. A later `batch` on the existing document (`container.id`, no `create`) is replayed member by member: its prose `update` members like update calls, while a `widget` it creates (a diagram or chart) only shows through the section that embeds it, as `[embedded content: <caption>]`, the placeholder claude.ai's own Markdown export uses. A section fill can plant pending blocks of its own; their ids come from that call's reply (`docPendingIds`: the update's result, or the batch member's entry in `acks`), and they are filled as sections named `<section>/<key>`. The rebuilt text fills the placeholders (dates as written, mentions left out, unwritten sections noted), then appends the comments and the link to the live document. Chips a section brings with it (`with.blocks`) are filled in the same way, and a comment's later lines are indented so it stays one list item. It is versioned per turn like any artifact, under the key `doc:<node id>`, and saved as its title made safe by `safeFileTitle` (letters, digits and marks from any script). When the batch's result is missing, the document is still written, under `doc:pending:<call id>`, with its sections shown as not written and a `claude_doc_unreplayed` warning. An edit of another kind (an update with no operations, find text that isn't there or sits inside a table cell, any other operation or batch member) is not replayed and warns `claude_doc_unreplayed`, once per document. Diagrams themselves are not in the chat as pictures (claude.ai draws them only on the document's page, and its own HTML export of a document leaves them out too), and edits made by hand on claude.ai are not in it at all. A self-contained HTML copy Claude made of a document is its companion (`docCompanions`): an HTML file sent with `SendUserFile` or `present_files` in the message that exported the document (`Claude_Docs__export`, whose result's `frame.url` is the document's live link), or else a whole page (`<!doctype html` or `<html`) whose `<title>` or first `<h1>` is the document's title, compared without tags, entities, case or curly quotes; a delivered copy identical to one already found is left out. After the downloads, `populateConversationFolder` puts a note under the final document's title (`docCompanionNote`; the versions stay as rebuilt): with diagrams and a copy, it links the copy; with diagrams and none, a **Diagram not included** note says how to get one, and the document warns `doc_diagram`; with a copy and no diagrams, it links the copy. `extract_artifacts.py` writes the documents without this note, since it doesn't have the delivered files. In `full_chat.md` a document is linked by the name it was saved under; a single Markdown file links the live document. `populateConversationFolder` also writes `<title>.html`, a self-contained page rendered with `marked`: raw HTML shown as text (an inline tag never switches marked into copying raw text), only web and mail links and https images kept, attributes escaped once, and a CSP with no script. Its name is unique among the artefacts whatever the case, and README.md lists it.

### Published pages

A `publish_files` call (`isPublishTool`) puts a page on claude.ai; its result's JSON gives the page's URL, whose last part is the page's id in base58 (`base58ToUuid`). `publishedPagesOf` groups a chat's publishes by page id and records, per publish, the files sent (`path`, `as`) and the message. Fetching is `content.js`'s job, through two actions that popup.js reaches by `sendToTab`:

- `publishedPageInfo` calls `GET /api/frame/<uuid>?org=<org>[&ver=<ver>]` with the header `X-Frame-CP: go` (reply: version, history, title, current files, an asset token), then `GET https://<uuid>.frame.claudeusercontent.com/_f/<ver>/_files.json?__frame_t=<token>` for each file's size, type and SHA-256. It returns `ver`, `title`, `history`, `files[]` and any `rejected` paths.
- `publishedPageFile` fetches one file from `…/_f/<ver>/_src/<path>?__frame_t=<token>` and returns it as base64 (encoded in chunks).

The token is a secret: it stays in `content.js` (cached per page and version, refetched when under 60 s are left, after a 403 once, or when none is cached), is never returned, and appears in no error, `errors.txt`, `published.json` or log we write. Frame requests send no cookies and no referrer, and refuse redirects. Errors come back as codes (`HTTP 404`, `network`, `too large`), never as text that could hold a URL. Caps: 32 MB per file (checked from `_files.json` before fetching and while reading) and 50 MB per page version. A `ver` and a uuid must match fixed patterns; paths in the listing with an empty, `.` or `..` segment, or a leading `/`, are rejected, and `artifact-type/` paths skipped. The popup passes the reply through `cleanPublishedInfo` and verifies each file's SHA-256 over the decoded bytes.

`savePublishedPages` makes one record per page per export, with a folder `<safeFileTitle(title)>_<shortId>` chosen once (titles change), and one version folder per version fetched (`<ver>`, or `current` for a publish with no version that matches none Claude named). Every saved segment goes through `publishedSegment` (`zipSafeName`, Windows-reserved characters and device names, case-only and file/folder clashes resolved with `_2`) and a rename warns `published_page`. A version is "same" when every listed file equals, by SHA-256, the text this export holds for its source as of the publishing message (`versionAsOf` on the artifact's versions) or a downloaded attached copy of that message; then nothing is copied and `published.json` says `same: true` with `writtenAs` (the artefact). Binary files are never same. The sameness is per file within a version, and per version across a page. `current`, for chats with no recorded version, is the live version, not necessarily the one published then. `published.json` (`format: 1`) holds title, url, short id, uuid and per version: ver, label, order, saved, files, start, startSaved, incomplete, needsRuntime, missing, publishedIn.

In an Export All, `sharedProjects.published` holds each page once; files go to `published/<page>/` at the root, every chat adds its `publishedIn` entries (`chat`, `messageUuid`, `toolUseId`), and `writeSharedPublished` writes each `published.json` after the last chat. A chat folder named `published` is renamed (`published_2`). A chat's README ("Published pages") and `publishedLines` link the saved copy (`../published/…` in Export All).

The viewer (`takeout-viewer.js` `addCards`) turns a page's publishes into one card keyed `published:<uuid>`, with a version per entry; `Same as published` and `Needs claude.ai to run` come from the data. The old-archive tool reads `published/` (`KNOWN_DIRS`, `publishedFromDisk` in archive-lib.js, matching pages by uuid and trusting only real folders), and `merge_archives.js` reserves `published` as a root name, merges each page by uuid under the newest folder name, unites versions and `publishedIn`, and never overwrites.

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

**Export All into a folder.** With `settings.megaFormat` at `'folder'` (the default; `'zip'` is the old Mega-Zip), the click opens `showDirectoryPicker` before anything is awaited, since Chrome only allows it straight after a click, and passes the folder to `bulkExportZip({ directory })`. The popup closes when a picker opens, so there the click opens the side panel on the claude.ai tab instead (`chrome.sidePanel.open`) and leaves a note in `chrome.storage.session` that the panel shows. `makeRunFolder` makes a new folder inside the picked one, named as `megaZipName` would name the ZIP, with `_2` and so on when that exists. `createDiskFolder` takes the same `file()` and `folder()` calls the export makes on a JSZip, so `populateConversationFolder`, `writeViewer`, the index and the manifest are unchanged; writes run in the background in order per path, `flush()` after each chat waits for them, and a file that can't be written is listed in `write-errors.txt` at the root instead of stopping the export.

**Export Changes.** After each mega-ZIP, `saveExportRecord` adds the chats it holds to `chrome.storage.local.exportRecord[<org>]`, each with the `updated_at` the chat list gave. With the **Mega-Zip exports** setting at **Only new or changed** (`settings.megaZipScope: 'changes'`; the default is `'all'`), or with `bulkExportZip({ changesOnly: true })`, it loads that record and exports only the listed chats that are new or whose `updated_at` differs (`changedSince`), into `claude-takeout-<name>-changes-<stamp>.zip`, whose `index.md` is headed "Changes since <date>". With no record it exports everything; with nothing changed it downloads nothing. Chats that failed aren't recorded, so the next run tries them again. `export-manifest.json` (`format: 1`, `kind: full | changes`, `since`, `listed`, and every chat's `uuid`, `name`, `updated_at` and `folder`) lets the archive say what it holds without the browser; the old-archive tool treats it as part of the export.

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
├── viewer-files/part-NNNN.js  only when an upload's or a generated file's text is over 64 KB
├── responses/NNN_<title>_response.md, .full.md
├── artefacts/<base>(_vN)<ext>
├── attachments/pNN_<name>
├── uploads/pNN_<name>
├── published/<Title>_<id>/    pages published with publish_files: published.json and <version>/<files>
└── project/
```

Encoding rules:

- Every `.md` file gets a UTF-8 BOM (`addFileWithBOM`), because Chrome opens local Markdown as plain text and guesses the encoding.
- Text goes through `fixMojibake`, which repairs UTF-8 that was read as Latin-1.
- `getCodeFence` makes a fence one backtick longer than the longest run in the content.
- Every name from chat data that becomes a path in the ZIP goes through `zipSafeName` (`/`, `\\` and control characters become `_`; `.` and `..` become `_`). File and folder names from titles keep letters from any script.

---

### Export Artifacts

Export Artifacts (`exportArtifacts`) saves the artifacts claude.ai lists, not those found in chats. `content.js` `listArtifacts` calls `GET /api/frame/frames?org=<org>&limit=1000` (header `X-Frame-CP: go`, same-origin) and returns, per frame, only `slug`, `title`, `typeSlug`, `typeTitle`, `sourceSurface`, `rel`, `live`, `updatedAt`, `createdAt`; no owner, thumbnail or URL leaves it. `artifactsFromList` (export-core.js) checks each again (the slug by the uuid rule, `live` by the version rule). No paging parameter is known (`offset`, `cursor`, `page`, `skip` are ignored, and limits 60, 200, 1000 and none all returned the same 19), so a list whose length is 60 or more and a multiple of 10, or exactly 1000, warns `artifact_export` that it may be cut short. The list is fetched first through `tabPublishedFetcher`; an empty list or a failure writes nothing.

Each artifact is fetched at its listed version with the same code a chat's published page uses, `fetchPublishedFiles` (`publishedPageInfo` then `publishedPageFile`, the 32 MB and 50 MB caps, SHA-256, `publishedSegment` names, the 401 latch). `publishedPageInfo` also reports `runtimeSkipped`, the count of `artifact-type/` paths dropped; `needsRuntime` is true when that is above zero, when the artifact has a type, or when the start text needs claude.ai's page code. Claude Docs (type `c8f0b311-af6a-4d22-a07b-61eb818fc35d`, or title "Docs" when the type is missing) are not fetched: they get a row and the note that their text isn't a file. A typed artifact with no files of its own gets `artifact.json` only. A shared one (`rel` not `mine`) is exported and labelled in `artifact.json`'s `note` and in the Source column.

Layout: `claude-takeout-artifacts-<name>-<stamp>` (`megaZipName(name, 'artifacts', stamp)`), one folder `<safeFileTitle(title)>_<shortId>` per artifact (`shortId` from `uuidToBase58`, compared case-insensitively), the version's files at its top level, and `artifact.json` (a page file of that name becomes `artifact_2.json`). The root has `index.html`, `index.md` and `export-manifest.json` (`kind: 'artifacts'`, `listed`, `artifacts[]`), and `errors.txt` from one collector labelled "Export Artifacts". `artifactsIndexHtml` is static: a CSP meta first (`default-src 'none'`), no scripts, every value escaped, local links `encodeURIComponent`-ed per segment, claude.ai links rebuilt from the short id with `rel="noopener noreferrer"`. `index.md` goes through `mdLinkText`. A folder export flushes after each artifact and writes `write-errors.txt` like Export All (`folderExport` is shared by both buttons). The export ignores `megaZipScope` and never reads or writes `exportRecord`. The old-archive tool and `merge_archives.js` find no archive in it (no `original.json`, no chat folders) and ignore it.

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
| `doc_diagram` | A Claude Docs document's diagrams show only by caption, and the chat has no self-contained HTML copy of it; the note links the live document. |
| `tool_image` | An image Claude looked at (a tool result that links a claude.ai file) could not be downloaded. |
| `web_image` | An image from a web search was not saved: no permission to fetch from other sites (one warning for all), or the site refused it. |
| `claude_doc_unreplayed` | A Claude Docs edit could not be rebuilt from the chat; the note links the live document. |
| `export_health` | The chat's data looks incomplete, the likely sign of a change in claude.ai's API (`chatHealth`): no messages although the chat changed, messages with no content, no current branch in a branched chat, unknown content block types, or none of several uploads downloaded. A mega-ZIP's `index.md` counts these chats, and the chats claude.ai listed. |
| `published_page` | A published page could not be saved, or only partly: no claude.ai tab, a failed request (401 once per export), a file too large, a checksum mismatch, a renamed or rejected path. |
| `artifact_export` | Export Artifacts could not save an artifact or part of one: a failed request (401 once, then it stops), a file too large, a checksum mismatch, a renamed or rejected path, or a list that may be cut short. |
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

- `buildViewerChat` turns one payload into the viewer's shape: every branch, rendered tool calls, file versions, uploads, the project. A file named in `ctx.flags` (`viewerFlags` over the export's warnings; the old-archive tool gets them from `errors.txt` with `warningsFromReport`) gets `flag`, and the viewer shows a "May not match" badge on its cards, a note in the Files list and an explanation in the file panel.
- `buildViewerData` gathers the chats and stores each distinct project once in `data.projects`; a chat's `project` is an index into it. Projects are grouped by a cheap key, then compared in full only within a group.
- `moveUploadText` moves upload text, and generated-file version text other than stylesheets and scripts, over `UPLOAD_INLINE_LIMIT` (64 KB of UTF-8) into parts of at most `PART_LIMIT` (4 MB). Each part is `viewer-files/part-NNNN.js`, which calls `window.__archivePart(n, { u0: text, f0: text, ... })`. When a part can't load, an upload or a file version falls back to its own copy in `uploads/` or `artefacts/`, when there is one.
- `assembleViewer` inlines the template, the data (`<script id="data">`), the app, `marked`, KaTeX and highlight.js into one HTML string. `writeViewer` in `popup.js` adds it to the ZIP.

A chat that fails to build gets a `viewer` warning. A viewer that fails as a whole is reported in the status line. Neither stops the export.

**Running it.** `viewer/viewer-app.js` renders the page, and `viewer/viewer-logic.js` holds its pure functions (tested in Node):

- Chat text goes through escaped HTML, text placeholders and `sanitizeHtml`.
- Math renders with KaTeX.
- Syntax colors run in a blob worker, block by block as they scroll into view, and stop after `HIGHLIGHT_TIMEOUT`, since highlight.js can hang on some input. `tameMarkdown` keeps an underscore inside a word from turning the rest of a Markdown file italic.
- The Files button lists a chat's files (`chatFiles` in viewer-logic.js): outputs from its file cards, each once, ordered by the last card that shows it, and its uploads and pasted texts, each once. `buildViewerChat` marks each file `shared` when Claude sent it, presented it, saved it under `/mnt/user-data/outputs/` or made it with the artifacts tool; the others are listed as working files. A viewer built before the mark lists everything as outputs.
- Popups and the file panel have a Copy button for a whole text file. It copies the source even in Preview. A Wrap button beside it (`wrapButton`, `setWrap`) toggles `body.wrap-code`, which wraps `.file-code`; it is stored in localStorage under `claude-takeout-wrap` and shows only with text, not in Preview.
- Search reads titles, prompt and reply text, attachment names and text, and upload names. It never reads upload or file text, which is why that text can live in parts. "Also search inside files" (`#search-files`, off by default, remembered in `localStorage`) adds `searchInFiles`: `fileSearchSources` lists each chat's files (newest version) and uploads once, with their inline text or part; inline text is searched at once and parts are loaded one at a time through `loadPart`, `fileHit` matching each file's name and text against the same parsed query. A newer search stops it between parts (`fileSearchGen`), and at most `FILE_HIT_LIMIT` (100) files are listed. `parseQuery` turns a query into words that must all appear, `"phrases"`, `OR` alternatives and `-exclusions`; `searchChats` matches each title or message against it; `groupHits` groups the hits by chat and ranks them (title match, then most messages, then newest). Opening a hit starts the match bar: `findPlan` lists the chat's messages whose shown text matches (`shownText`: math and link and image addresses left out, kept per message for the next keystroke), with `countLower` occurrences each, and `markNth` marks one occurrence at a time in what the page shows (prose and prompt bubbles, not KaTeX), moving on when one isn't shown. When nothing further is shown in a direction, the bar returns to the last match it showed and turns that direction off. `foldCase` maps matches back to the text where lowercase changes its length. Only code blocks holding a match lose their colors while stepping, and `clearMarks` brings them back when the search ends.
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

`tools/merge_archives.js` combines archives, typically a full Mega-Zip and the change archives after it:

```
node tools/merge_archives.js <archive folder or ZIP>... --out <dir> [--name <name>] [--dry-run] [--json]
```

- Each source is found with `findArchives`; ZIPs are first extracted with `extractZip` into `<out>/.merge-<pid>/`, which is removed at the end.
- `pickNewest` keeps one copy per chat uuid: latest `updated_at` in `original.json`, then the later `exported_at` from `export-manifest.json`, then the source named later. Chats without a uuid are all kept.
- The chosen chat folders are copied (`copyTree`: real files and folders only, never links, never overwriting) into `<out>/.<name>.partial-<pid>`, together with each mega source's `projects/` folders (newest source first, the first of a name wins), a new `index.md` and an `export-manifest.json` with `kind: "merged"`, `sources` and each chat's `from`. A single-chat source's `viewer.html`, `viewer-check.gif` and `viewer-files/` are left behind. The folder is then renamed to `<out>/<name>` (default `claude-takeout-merged-<date>`), and `writeViewer` from `build_viewer.js` gives it one viewer.
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
| `/api/frame/frames?org=<org>&limit=1000` (header `X-Frame-CP: go`) | `content.js` `listArtifacts` | The artifacts claude.ai lists (Export Artifacts); only the fields it needs are returned. |
| `/api/frame/<uuid>?org=<org>[&ver=<ver>]` (header `X-Frame-CP: go`) | `publishedPageInfo` | A published page's versions, title and asset token. |
| `https://<uuid>.frame.claudeusercontent.com/_f/<ver>/_files.json`, `…/_src/<path>` (query `__frame_t`) | `publishedPageFile`, `publishedPageInfo` | A published page's file list and files. No cookies sent. |
| `/api/organizations/<org>/projects/<project>/files` | `fetchProjectFileList` | Project knowledge files. |
| `/api/organizations/<org>/files/<file>/contents` | `fetchUploadedFile`, project files, deliveries | A file's bytes. |
| `/api/organizations/<org>/conversations/<chat>/wiggle/download-file?path=<path>` | `fetchUploadedFile` | A sandbox file by path, including session-only uploads. |
| `/api/<org>/files/<file>/preview`, `/content`; `/api/organizations/<org>/files/<file>/content`, `/files/<file>` | `fetchUploadedFile` | Older fallbacks. |
