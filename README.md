# Claude Takeout

A Chrome extension to export Claude.ai conversations to Markdown, JSON, or comprehensive ZIP archives.

## Features

- **Multiple Export Formats** - Markdown, Embedded Markdown, ZIP Archive, JSON
- **ZIP Archive Export** - Full archive with responses, artifacts, metadata, code snippets
- **Bulk Export** - Export all your Claude conversations at once
- **Project Support** - Exports project files, system prompts, and prefixes filenames with project name
- **Keyboard Shortcuts** - Quick export with Alt+key combinations
- **Branched Conversation Handling** - Correctly follows conversation tree
- **Artifact Extraction** - Extracts and embeds created files
- **Thinking Blocks** - Preserves Claude's reasoning with proper summaries
- **Tool Use Display** - Formatted display of web search, bash, file operations
- **Offline Viewer** - Every ZIP includes `viewer.html`, a page for reading the exported chats in a browser without the extension
- **Sidebar Mode** - Keep the exporter open while browsing conversations
- **No Configuration Required** - Auto-detects your organization ID

## Installation

1. Download or clone this repository
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable **Developer mode** (toggle in top right)
4. Click **Load unpacked**
5. Select the `claude-takeout` folder

## Usage

### Export Current Conversation

1. Navigate to a conversation on [claude.ai](https://claude.ai)
2. Click the Claude Takeout extension icon
3. Choose your export format

### Export All Conversations

1. Navigate to [claude.ai](https://claude.ai) (any page)
2. Click the Claude Takeout extension icon
3. Choose your bulk export format:
   - **Export All (Markdown)** - One `.md` file per conversation
   - **Export All (Embedded)** - One `.md` file per conversation with artifacts inline
   - **Export All (Mega-Zip)** - Single zip containing all conversations
   - **Export All (JSON)** - One `.json` file per conversation
5. Watch the progress bar as conversations are exported

## Export Formats

### Markdown
**"Export Current (Markdown)"**
- Single `.md` file with full conversation
- Artifacts referenced (compatible with `replace_filepaths.py`)
- Includes thinking blocks, tool use, timestamps

### Embedded Markdown
**"Export Embedded (Artifacts Inline)"**
- Single `.md` file with artifacts embedded in code blocks
- Self-contained, no external file references

### ZIP Archive
**"Export as Zip (Full Archive)"**

Creates a comprehensive archive:

```
[Project_Name-project]_{conversation}_claude-chat.zip
├── README.md                    # Table of contents
├── meta.md                      # Statistics, word counts, metadata
├── prompts.md                   # All prompts with response links
├── responses_text_only.md       # Combined pure text responses
├── full_chat.md                 # Complete conversation (artifacts in code blocks)
├── integrated_chat.md           # Markdown artifacts flow seamlessly
├── integrated_chat.txt          # Plain text version (no markdown formatting)
├── code_snippets.md             # All extracted code blocks
├── links_and_sources.md         # URLs + web search sources by domain
├── errors.txt                   # Detailed error report with recovery hints (only if failures occurred)
├── original.json                # Original JSON export
├── viewer.html                  # Offline viewer (unzip first, then open it)
├── viewer-check.gif             # 1x1 image the viewer uses to detect an unzipped folder
├── viewer-files/part-NNNN.js    # text of large uploads, only when there are some
├── responses/
│   ├── 001_title_response.md       # Pure text response
│   ├── 001_title_response.full.md  # Response with thinking/tools/embedded artifacts
│   └── ...
├── artefacts/
│   ├── document.md
│   ├── script.py
│   └── ...
├── attachments/                 # Pasted text files (extracted content)
│   ├── meeting_notes.txt
│   └── ...
├── project/                     # Claude Project data (if conversation is in a project)
│   ├── project.json                # Project metadata
│   ├── prompt_template.md          # System prompt/instructions
│   ├── docs.json                   # Document list metadata
│   ├── research_notes.md           # Full file (from API)
│   ├── large_file_truncated.md     # Truncated file (from view tool fallback)
│   └── ...
└── uploads/                     # Downloaded PDFs, images, etc.
    ├── document.pdf
    ├── image.png
    └── ...
```

*Note: The `[Project_Name-project]_` prefix only appears for conversations that are part of a Claude Project.*

**Offline viewer:** unzip the archive, then open `viewer.html` in Chrome. It lists the chats, searches across them, and shows messages, thinking, tool calls, artifacts, uploads and project files. A mega-ZIP has one `viewer.html` at its root covering every chat. It needs no network. Previews of generated HTML files run their scripts in a sandbox, cut off from the viewer, other chats and your disk, and normal web requests are blocked. The browser doesn't let the viewer block every route, though, so a generated file containing injected code could send out its own text and the `.js` and `.css` files from that chat when previewed. Be careful previewing files from someone else's export.

### JSON
**"Export Current (JSON)"**
- Raw API response with complete data
- Useful for backup or custom processing

### Mega-Zip (Bulk Export)
**"Export All (Mega-Zip)"**

Creates a single archive containing all your conversations:

```
claude-takeout-2026-01-01.zip
├── index.md                         # Master list with links to all conversations
├── export-manifest.json             # Every chat in the archive, with its updated_at
├── conversation_one/
│   ├── README.md
│   ├── meta.md
│   ├── prompts.md
│   ├── responses_text_only.md
│   ├── full_chat.md
│   ├── integrated_chat.md
│   ├── code_snippets.md
│   ├── links_and_sources.md
│   ├── original.json
│   ├── responses/
│   │   └── ...
│   ├── artefacts/
│   │   └── ...
│   └── project/
│       └── ...
├── conversation_two/
│   └── ... (same structure)
└── ...
```

Each conversation folder has the identical structure to individual ZIP exports.

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Alt+M` | Export Current (Markdown) |
| `Alt+E` | Export Embedded |
| `Alt+Z` | Export as Zip |
| `Alt+J` | Export Current (JSON) |
| `Alt+R` | Refresh |

*Shortcuts work when the popup or sidebar is open*

## Sidebar Mode

The extension can open as a sidebar panel that stays visible while you browse conversations.

### Opening the Sidebar

**One-time:**
- Right-click the extension icon → **Open side panel**

**Make it default:**
1. Click the extension icon to open popup
2. Click the gear icon (Settings)
3. Enable **"Open as sidebar by default"**
4. Now clicking the icon opens the sidebar instead of the popup

### Benefits of Sidebar Mode

- Stays open while navigating between conversations
- No need to re-open for each export
- Wider view on larger screens
- Auto-updates when conversation data changes

## Technical Features

### Branched Conversation Handling
Correctly traces the conversation tree via `current_leaf_message_uuid` to handle regenerated responses - only exports the active conversation branch.

### Artifact Extraction
Automatically extracts artifacts from both `create_file` and `artifacts` tool calls and makes them available in exports. Supports 24+ content types with automatic file extension mapping (e.g., `text/markdown` → `.md`).

### Text Attachments
Extracts pasted text files that have `extracted_content` in the JSON. These are files you pasted or dropped into the conversation. Saved to the `attachments/` folder in ZIP exports with full text content preserved.

*Note: Binary files (PDF, DOCX, XLSX, etc.) are saved as `.txt` since only the extracted text content is available in the JSON.*

### Project Support
When exporting conversations from Claude Projects, the extension provides comprehensive project data:

**Filename Prefix**: All exports from project conversations are prefixed with `[Project_Name-project]_` for easy identification:
- `[My_Research-project]_conversation_name.md`
- `[My_Research-project]_conversation_name_claude-chat.zip`

The prefix is applied on every export path (single MD / Embedded MD / ZIP / JSON and the bulk equivalents). When the page-side fetch only returns `project_uuid` without the nested `project.name`, the extension transparently resolves the name from the `/projects/<uuid>` endpoint before generating the filename.

**Project Metadata** (ZIP exports):
- `project/project.json` - Full project metadata from API
- `project/prompt_template.md` - System prompt/instructions extracted as markdown
- `project/docs.json` - Document list metadata

**Project Documents**: Full project files are downloaded via API when available. Falls back to extracting viewed portions from conversation if API fails.
- Uploaded knowledge files: `project/files/` in a single-chat ZIP, or the shared `projects/<project>/files/` in a mega-ZIP
- Full files: `project/filename.md`
- Truncated files (from view tool): `project/filename_truncated.md`

### Uploaded Files (PDFs, Images)
Downloads uploaded files (PDFs, images, etc.) directly from Claude's servers using your session authentication. Saved to the `uploads/` folder in ZIP exports. Includes:
- PDF documents (with page count metadata)
- Images (PNG, JPG, etc.)
- Other uploaded file types

The extension tries multiple URL patterns when downloading, including constructing URLs from file UUIDs when no direct URL is available.

*Note: The Python companion script can only extract metadata for uploaded files since it doesn't have browser session access.*

### Web Search Sources
Extracts metadata from web search results, including:
- Source title and URL
- Site domain and name
- Citation status (citable, missing)

Sources are grouped by domain in `links_and_sources.md` alongside conversation links.

### Thinking Block Summaries
Uses Claude's actual `summaries` array when available for accurate thinking block descriptions.

### Dynamic Code Fences
Automatically uses ```` (4 backticks) when content contains ``` to prevent nesting issues.

### UTF-8 Encoding & Mojibake Repair
All markdown files include a UTF-8 BOM (Byte Order Mark) to ensure browsers correctly interpret encoding when opening files via `file://` URLs.

Additionally, text content is scanned and repaired for mojibake (UTF-8 bytes misinterpreted as Windows-1252). Supports comprehensive character ranges including Greek, Cyrillic, box drawing, mathematical symbols, subscripts/superscripts, and emojis.

### Tool Use Display
Specific formatting for common tools:
- `web_search` - Shows query and formatted results
- `web_fetch` - Shows URL being fetched
- `bash_tool` - Shows truncated command
- `str_replace` - Shows "Edit: filename"
- `view` / `read_file` - Shows "Reading: filename"
- `create_file` - Shows "Creating artifact: filename"
- `artifacts` - Shows "Creating/Updating artifact: title"

### Citation References
When Claude uses web search, citations are converted to linked references with Wikipedia-style back-links:

**In text:** `...text about Hildegard[[1]](#ref-1) and more[[1]](#ref-1)...`

**References:**
```
1. [Hildegard of Bingen](https://wikipedia.org/...) - wikipedia.org [[1]](#cite-1), [[1:1]](#cite-1-1), [[1:2]](#cite-1-2)
2. [Another Source](https://example.com/...) - example.com [[2]](#cite-2), [[2:1]](#cite-2-1)
```

- Each citation in text links to its reference
- Back-links `[[1]], [[1:1]], [[1:2]]` link back to each citation position
- Replaces multiple ↩︎ arrows with numbered clickable links

### Statistics & Metadata
ZIP export includes:
- **Model name** - Parsed to show variant (e.g., "Claude 4.5 Sonnet")
- **Duration** - Time between first and last message
- **Starred status** - Whether conversation is starred
- **Features used** - Web Search, Artifacts, Extended Thinking
- Message counts (prompts, responses)
- Word counts (prompts, responses, total)
- Artifact count
- Text attachment count
- Project file count
- Uploaded file count
- Web search sources count
- Code block count with language breakdown
- URL count grouped by domain
- Timeline (first message, last message, export time)

## How It Works

The extension reads the chat in your tab's URL and requests it directly:

- `GET /api/organizations/{orgId}/chat_conversations` - List all conversations
- `GET /api/organizations/{orgId}/chat_conversations/{id}` - Get full conversation

Your existing session cookies are used for authentication (no API keys needed).

## Files

| File | Purpose |
|------|---------|
| `manifest.json` | Extension configuration (Manifest V3) |
| `background.js` | Service worker for sidebar panel behavior |
| `injected.js` | Org ID fallback (runs in page context) |
| `content.js` | Bridge between page and extension |
| `popup.html` | Extension popup UI |
| `sidepanel.html` | Sidebar panel UI |
| `popup.js` | Export logic and markdown conversion |
| `takeout-viewer.js`, `viewer/` | Builds `viewer.html` for ZIP exports |
| `export-core.js` | Extractors shared by the extension and the tools |
| `tools/` | `build_viewer.js`, which adds a viewer to older archives |
| `jszip.min.js` | ZIP generation library |

## Troubleshooting

### "Sign in to claude.ai and open a chat"
The extension couldn't find your organization. Sign in, then open a chat.

### "Open a chat to export it"
You're on Claude but not viewing a specific conversation. Click into a chat. Export All still works.

### "Can't reach this tab"
The extension couldn't connect to the page. Reload the Claude tab.

### Export buttons disabled
The selected chat is loading, couldn't be loaded, or you're not on a chat page. Check the status message.

### Bulk export is slow
Each conversation requires a separate API request. A 300ms delay is added between requests to avoid rate limiting. For 100 conversations, expect ~30 seconds.

### Some conversations failed to export
Check the browser console for error details. Common causes:
- Conversation was deleted
- Network timeout
- Rate limiting (try again later)

### ZIP export fails
- Check browser console for specific error
- Try exporting as Markdown first to verify data capture
- Large conversations may take a moment to process

## Privacy & Security

- **No external servers** - All processing happens locally in your browser
- **No API keys stored** - Uses your existing Claude session
- **No data collection** - Nothing is sent anywhere except to your downloads folder
- **Open source** - Full source code visible in extension files

## Technical Documentation

See [TECHNICAL.md](TECHNICAL.md) for a comprehensive technical writeup covering:
- How conversations are loaded, and the JSON structure
- Message chain resolution for branched conversations
- Content blocks and the tools the exporter understands
- Artifact extraction with per-turn versions
- Files: pasted text, uploads, files Claude made, project files
- Web search sources and citations
- The ZIP layout, `errors.txt`, and `replay_bash.py`
- The offline viewer and viewers for older archives
- API endpoints and authentication

## Companion CLIs

Two stdlib-only Python 3 scripts and one Node tool ship with the extension:

| Tool | Purpose |
|---|---|
| `extract_artifacts.py` | Offline reconstruction of every artifact version from `original.json`. Byte-identical output to the extension's `extractArtifacts`. Useful when you only have the JSON, or for validating exports via `diff -r`. |
| `replay_bash.py` | Post-export recovery: replays Claude's `bash_tool` commands in a tmpdir, under an OS sandbox on macOS, with per-command confirmation, to reconstruct artifacts the extension flagged as `artifact_opaque_mutation`. |

`tools/build_viewer.js` (Node 20+) gives archives from before v1.6 an offline viewer. Run it on a folder of exports: `node tools/build_viewer.js <folder> --dry-run` first, then without `--dry-run`.

See [USAGE.md](USAGE.md) for full CLI documentation, and [docs/WASM_REPLAY_APPROACH.md](docs/WASM_REPLAY_APPROACH.md) for the architectural reasoning behind keeping bash replay in a separate CLI rather than embedding it in the extension.

## Changelog

### v1.9.2

- **Claude Docs documents come out complete** - A section Claude filled together with a diagram, a correction Claude made by find-and-replace, and a section Claude planted inside another one are now rebuilt, so the exported `.md` and `.html` match the document on claude.ai and no longer show **May not match** for these edits. A diagram appears as `[embedded content: <caption>]`, as in claude.ai's own Markdown export. Edits made by hand on claude.ai still aren't in the chat. `extract_artifacts.py` rebuilds the same way. Needs a fresh export.

### v1.9.1

- **Wrap long lines** - Popups and the file panel's Code view have a **Wrap** button next to Copy, so a text file with long lines, such as a transcript, reads without scrolling sideways. The viewer remembers the choice. Older exports get this when their viewer is rebuilt with `--force`.

### v1.9.0

- **Search inside files** - The viewer's search box has a new **Also search inside files** checkbox. When ticked, search also looks in the text of uploads and of files Claude made, loading their text part by part, and lists matches under "Inside files". Off by default, since it is slower on a large archive. Older exports get this when their viewer is rebuilt with `--force`.

### v1.8.0

- **Combining archives** - New `tools/merge_archives.js` combines a full Mega-Zip with the change archives after it, or any set of exports, into one new archive with one viewer. Each chat is taken once, from its newest copy; your source archives are only read. See USAGE.md, "Combining archives".

### v1.7.2

- **Your name in the Mega-Zip's file name** - A Mega-Zip is now `claude-takeout-<your display name>-<date>.zip`, so archives from different accounts don't mix. The name comes from your claude.ai account; only the display name is read.
- **Open on claude.ai** - The viewer links each chat back to its page on claude.ai, next to the model and date.

### v1.7.1

- **Export Changes is a setting** - The separate Export Changes button is gone. **Mega-Zip exports** in Settings chooses what the Mega-Zip button exports: **All chats** (the default) or **Only new or changed**, which makes it Export Changes (Mega-Zip).

### v1.7.0

- **Export Changes** - A new **Export Changes (Mega-Zip)** button makes a mega-ZIP of only the chats that are new or changed since the last mega-ZIP from this browser, so a regular backup no longer downloads every chat again. The first time it exports everything and says so; when nothing changed, it says so and downloads nothing. A chat that failed is tried again next time.
- **export-manifest.json** - Every mega-ZIP now lists the chats it holds, with each chat's `updated_at`, in `export-manifest.json` at its root, so an archive records what it contains without the browser that made it.

### v1.6.23

- **Warning badges in the viewer** - A file the export warned about (changed by a command it can't replay, an edit it couldn't replay, or a Claude Docs edit it couldn't rebuild) now shows a **May not match** badge on its card and in the Files list, and the file panel says why and how to rebuild it. Before, such files looked normal in the viewer and the warning was only in `errors.txt`. Older exports get the badges when their viewer is rebuilt with `--force`; the tool reads them from `errors.txt`.

### v1.6.22

- **Export health check** - Each export now checks that claude.ai's data looks complete, since an unannounced change to its API could otherwise leave an export thin without anything saying so. A chat with no messages although it was used, messages that came back empty, a branched chat with no current branch, content the exporter doesn't show yet, or several uploads that all failed is listed in `errors.txt` under `export_health`, and the status line turns amber. Markdown and JSON exports show it in the status line. A mega-ZIP's `index.md` counts these chats and shows how many chats claude.ai listed.

### v1.6.21

The last fixes from the second full review: the tool that adds a viewer to older archives, and the docs.

- **No false projects warning** - `tools/build_viewer.js` no longer warns that a mega-archive's shared `projects/` folder "is not there" when it is.
- **A linked `projects/` folder is not read** - When `projects/` at an archive's root is a link to another folder, the tool leaves it alone and says so, as it already did for `project/`, `uploads/` and `artefacts/`.
- **Uploads that differ only in case** - `Photo.PNG` and `photo.png` in one prompt are matched to the files the export saved, instead of one being reported missing.
- **Less memory for big ZIPs** - The tool lets go of a ZIP's bytes once it is extracted, before building the viewers.
- **A file whose text can't load** - When `viewer-files/` is missing or blocked, a large generated file now says its text couldn't load and that it is in the artefacts folder, instead of "not in this export".
- **Docs** - TECHNICAL.md and CLAUDE.md describe what `viewer-files/` parts hold, every warning type, and where the shared export code lives.

### v1.6.20

Viewer fixes from the second full review. Rebuild an older export's viewer with `--force` to get them; see [Updating a viewer](USAGE.md#updating-a-viewer).

- **Match counts agree with the page** - Words in link addresses and in math are no longer counted, so the match bar no longer shows "3 of 3" with Next still on, or highlights inside hidden math.
- **No dead steps** - When the next match turns out not to be on the page, the bar stays on the last one it showed and turns Next (or Previous) off, instead of losing the highlight. A result with nothing to show opens its message without the bar.
- **Text with a Turkish İ** - Matches in a paragraph holding İ, or another letter that changes length in lowercase, are highlighted and stepped to.
- **Faster search** - Counting matches for the results list is about ten times faster, so typing no longer freezes a large viewer.
- **Search hits far down a long chat** open sooner: the messages before them are drawn in bigger batches.
- **Results summary** - Past 200 chats, the summary says its match count covers the first 200.
- **Group titles** open the first match the conversation shows, not a hit in a file name or pasted text.
- **Highlights and colors** - Clearing the search removes every highlight. Stepping makes only code blocks that hold the word plain, and they get their colors back when the bar closes.
- **Files list** - A regenerated reply's artifacts and documents stay under Outputs. A file Claude wrote and then sent is listed once. A file presented on another branch opens that branch's copy. Tab out of the list closes it, and a file opened from it takes keyboard focus to the panel and back to the Files button.

### v1.6.19

Fixes from a second full review of the export code. None were critical.

- **Heredocs written either way round** - `cat << 'EOF' > file` and `cat >file << EOF` now count as file writes, like `cat > file << EOF`, in the extension, `extract_artifacts.py` and `replay_bash.py`.
- **Titles in any script** - Artifact and Claude Docs titles in Cyrillic, Greek, Japanese and other scripts keep their letters in file names, instead of becoming `.md`, `.md_2`, ...
- **Claude Docs** - A document whose tool reply is missing from the chat is still exported, with a warning. Edits made with a batch, and updates with no section text, now warn instead of passing silently. Date and mention chips inside a section are filled in, a comment of several paragraphs stays one list item, and odd block shapes no longer stop `extract_artifacts.py`.
- **Documents in the Markdown files** - `full_chat.md` links each document by the name it was saved under (two documents with one title are `Notes.md` and `Notes_2.md`). A single Markdown file links the live document instead of a ZIP path, and a multi-paragraph comment stays one quote.
- **Document pages** - In a document's `.html`, text after an inline `<code>` tag is escaped, and link and image attributes are escaped once. The page's name never clashes with another file in a different case, and README.md lists it.
- **Presented files** - A presented file is matched to the file Claude wrote at that exact path, so a draft with the same name elsewhere no longer stands in for it.
- **Changed-file warnings** - A command that changes several tracked files warns for each one. Python `Path` variables, `open(file=...)`, `./name`, globs such as `*.html` and `awk -i inplace` are recognized. Text inside a heredoc or in quotes is no longer read as a redirect.
- **integrated_chat.txt** - Link paths and words such as `MAX_RETRIES` keep their underscores, and `2 * 3 * 4` keeps its stars.
- **Pasted files** - `Notes.txt` and `notes.txt` pasted in one prompt are saved as two files on every system.
- **Export buttons** - A bulk export keeps the other export buttons off until it has finished, and a button that was off before an export stays off after it.

### v1.6.18

- **Files list no longer hidden behind the project bar** - In a chat that belongs to a project, the top of the Files list (the Outputs heading and the first file) was drawn under the project bar. It now opens above it, and above the match bar. Older exports get this when their viewer is rebuilt with `--force`; see [Updating a viewer](USAGE.md#updating-a-viewer).

### v1.6.17

- **Claude Docs documents are exported** - When Claude writes a Claude Docs document (the editable docs on claude.ai), the export rebuilds it from the chat: `artefacts/<title>.md`, with Claude's comments and a link to the live document at the end, and a matching `artefacts/<title>.html` to read, print or share, styled for light and dark and with no scripts. A document written over several turns gets `_v1`, `_v2` versions like other files. In the viewer it has a card and appears under Outputs in the Files list; `full_chat.md` shows the document instead of raw tool calls, and the tool steps read "Created a document" and "Edited the document". Edits the chat can't rebuild are flagged in `errors.txt` with the link to the live document; edits made by hand on claude.ai aren't in the chat. `extract_artifacts.py` rebuilds the `.md` the same way. Needs a fresh export.

### v1.6.16

- **Working files kept apart** - In the Files list, Outputs now holds only what Claude shared with you (sent, presented, saved to its outputs folder, or made as an artifact), as on claude.ai. Helper scripts and other files it wrote along the way are listed under a new Working files group.
- **Search counts match the match bar** - Each chat in the results now says how many matches it has and in how many messages ("144 matches in 47 messages"), counted the way the match bar counts them, and the summary gives the total matches. A chat that matches only in pasted text or file names says so.

Both reach older exports when their viewer is rebuilt with `--force`; see [Updating a viewer](USAGE.md#updating-a-viewer).

### v1.6.15

- **Step through every match in a chat** - Opening a search result shows a bar at the top of the conversation: “survey” · 1 of 144 · ‹ › ✕. The arrows, or Enter and Shift+Enter, go to the next or previous occurrence, highlighted, including matches on an earlier version of a response and far down a long chat. Escape or ✕ closes it, as does clearing the search or opening another chat. It counts the words the conversation shows: pasted text and file names still lead search to a chat, but aren't stepped through. Older exports get it when their viewer is rebuilt with `--force`; see [Updating a viewer](USAGE.md#updating-a-viewer).

### v1.6.14

- **Files list in the viewer** - A Files button in each chat's top bar, with a count, lists everything in that chat in one place: Outputs (each file Claude made or sent, once, newest first, with how many versions it has) and Uploads (your uploads and pasted text). An output opens in the file panel at its latest version, an upload in the popup. Like claude.ai's own files panel, but it also lists the working files Claude wrote along the way. Older exports get it when their viewer is rebuilt with `--force`; see [Updating a viewer](USAGE.md#updating-a-viewer).

### v1.6.13

Better search in the viewer. Older exports get it when their viewer is rebuilt with `--force`; see [Updating a viewer](USAGE.md#updating-a-viewer).

- **One result per chat, best first** - Results are grouped by chat, with how many messages match and up to three snippets. Chats whose title matches come first, then those with the most matches. Nothing is cut off at 50 rows any more.
- **Matched words in bold** - In titles and snippets.
- **Clear button** - A ✕ in the search box clears it; Escape still works. Press `/` anywhere to jump to the box.
- **Words in any order** - `survey feedback` finds messages with both words wherever they are. `"survey feedback"` finds the exact phrase, `survey OR poll` either word, and `survey -draft` leaves out messages with "draft".
- **Keyboard** - The arrow keys move from the box through the results, and Enter opens one.

### v1.6.12

Cleanup and the last fixes from the code review.

- **Heredocs** - A file written with an empty heredoc no longer swallows the commands after it, and `<<-` heredocs lose their leading tabs as bash removes them. A heredoc without quotes around its delimiter, whose text bash would expand (`$`, a backtick or `\`), now gets the `artifact_opaque_mutation` warning pointing to `replay_bash.py`, since the file Claude got differs from the text. Text inside a heredoc is no longer mistaken for a command that changes another file. Same in `extract_artifacts.py` and `replay_bash.py`.
- **A file named `__proto__`** is kept, as it already was in `extract_artifacts.py`.
- **One export at a time** - The export buttons are disabled while an export runs, so a second click or shortcut can't start another.
- **Small fixes** - The progress line no longer shows "undefined" while a project chat's ZIP fetches project files; Export All no longer fails silently in the side panel on a tab that isn't claude.ai; Embedded Markdown keeps its `_embedded` suffix on long titles.
- **`replay_bash.py` reads results without following links** - Each folder and file is opened so no link can redirect the read out of the temporary folder, and a file with more than one hard link is skipped. A process a command left running can no longer slip a file from elsewhere into the export.
- **`extract_artifacts.py`** writes `.md` files with the BOM an export gives them, so `diff -r` against an export compares cleanly.
- **Cleanup** - Two unused functions and a comment describing removed code are gone, and USAGE.md now says which downloads the Filename style and thinking settings affect.

### v1.6.11

Smaller viewer fixes from the code review. Older exports get them when their viewer is rebuilt with `--force`; see [Updating a viewer](USAGE.md#updating-a-viewer).

- **Keyboard version switching** - Pressing Enter on ‹ or › under a message kept focus on the control, so you can step through versions without tabbing back from the top.
- **One search highlight at a time** - Opening a search result clears the previous one.
- **Sources on long responses** - A response shown as plain text, because it was too complex to format, still lists its sources.
- **Projects with the same name** - Two different projects with one name are listed apart in the sidebar, the second as "Name (2)".
- **Uploads with no file ID** - Two uploads with the same name in different prompts each open their own file; before, both opened the later one. This needs a fresh export or a rebuilt viewer.
- **Faster on long chats** - Switching versions or opening a search result in a chat with thousands of messages no longer freezes the page.
- **Less memory** - Only the last two loaded `viewer-files/` parts are kept; an older one loads again when needed. Syntax coloring skips blocks that have left the screen.
- **Phone layout** - The file panel's Copy button comes after the file name.
- **A damaged chat can't hang an export** - A loop in the message parents in `original.json` ends the walk instead of running until memory runs out, in the extension, `extract_artifacts.py` and `replay_bash.py`.

### v1.6.10

Fixes to `tools/build_viewer.js`, the tool that gives older exports a viewer, from the code review.

- **Files with less common types keep their text** - A rebuilt viewer showed Claude's `.mmd` diagrams, `Makefile`s and other files whose type isn't on the text list as binary, with no preview. They keep their text now, as in an export's own viewer.
- **Linked folders are not followed** - A `project/`, `uploads/` or `artefacts/` folder that is a link to somewhere else is no longer read, so files from outside the archive can't end up in `viewer.html`. The report says the link was skipped.
- **Each ZIP is read once** - A ZIP was read from disk and parsed three times; now once.
- **Safer ZIP handling** - A ZIP named `foo.partial.zip` no longer blocks `foo.zip`; the tool's own work folder is now hidden (`.foo.partial`). A ZIP in which two entries end up with the same name is refused instead of silently losing one.
- **Uploads go to the right prompt** - When several uploads could match one file on disk, none of them gets it and the report says so, instead of the first one taking it.
- **Rebuilding after deleting `viewer.html`** - The tool's own `viewer-check.gif` and `viewer-files/` are replaced as expected; only a file the tool didn't write stops it, and the message names that file.
- **Project links** - A chat folder taken out of a mega-ZIP lists its project files without links, since the files are outside the folder; before, the links pointed nowhere.
- **Your `index.md` is listed** - An `index.md` you added to a single-chat archive shows under "Archive files". Only a mega-ZIP's own `index.md` is left out.

Rebuilt viewers of two real exports are identical to before.

### v1.6.9

Viewer size and export memory, from the code review.

- **Large files Claude made load when opened** - Their text over 64 KB now goes into `viewer-files/` like large uploads, instead of into `viewer.html`. Stylesheets and scripts stay, because previews use them. On an 18-chat archive `viewer.html` went from 15 to 8.8 MB, and the page used 17 MB of memory instead of 29 MB; all 218 files open as before. Older exports get this when their viewer is rebuilt with `--force`; see [Updating a viewer](USAGE.md#updating-a-viewer).
- **The viewer keeps one copy of its data** - The page no longer holds the raw data text beside the parsed copy for as long as it is open.
- **Less memory while exporting** - An upload is turned into an inline image only when one of Claude's files refers to it, instead of every upload being encoded and held until the chat finished.
- **One fetch per project in a mega-ZIP** - Chats in the same project reuse its metadata and documents, instead of fetching them again for each chat.
- **Faster viewer building** - Finding duplicate projects and escaping the data each take one cheap pass over large archives.

### v1.6.8

More fixes from the code review, to the Markdown files and to file names. They need a fresh export from claude.ai.

- **Pasted text in Markdown exports** - The single Markdown and Embedded Markdown exports left out text pasted into a prompt. It is now written under the prompt, and uploaded files are named. In a ZIP, `full_chat.md` and `integrated_chat.md` link to the files in `attachments/` and `uploads/` instead.
- **Links in `prompts.md` work** - Upload links were rebuilt from the original names, so two pasted `image.png` files, names with accents, or an upload that failed gave broken links. They now point to the names actually saved, and a failed upload is named with a note instead of a link. `Photo.PNG` and `photo.png` no longer overwrite each other on macOS or Windows.
- **Files Claude showed you are all kept** - Two shown files with one name from different folders (`en/index.html`, `de/index.html`) now become `index.html` and `index_2.html`, with a warning; before, one was lost. When a script changed a file in a way the export can't replay, the copy Claude showed is downloaded and used as the final version. `full_chat.md` links shown binary files such as `.docx` instead of saying "(not found)".
- **`code_snippets.md` stays readable** - A file containing code fences no longer breaks the rest of the page, and code blocks inside Claude's files aren't listed twice.
- **Project documents with the same title are all kept** - Two documents named `notes.md`, or one named `project.json`, overwrote each other or the project's own files. They now get `_2` names.
- **Titles in any script** - Chats titled in Cyrillic, Japanese and other scripts get readable file and folder names instead of underscores or "untitled". English titles give the same names as before.
- **Safe names** - A name from the chat containing `/`, `\`, `..` or control characters can no longer create folders or escape its place in the ZIP.

### v1.6.7

Fixes from a full code review. These change what goes into a new export, so they need a fresh export from claude.ai; rebuilding a viewer doesn't apply them.

- **Edits made with the older artifacts tool are kept** - Chats that used claude.ai's earlier `artifacts` tool exported the first draft only: its `update` edits (old text to new text) and `rewrite` commands were ignored. They are now applied, with a version per turn, and an edit that can't be applied is listed in `errors.txt`.
- **A file Claude named `report_v1.html` no longer overwrites a version** - When Claude edited `report.html` and also saved its own `report_v1.html`, one silently replaced the other, because the export writes versions under those names. The later file is now renamed (`report_v1_2.html`) with a warning. `extract_artifacts.py` and `replay_bash.py` follow the same names.
- **An upload rebuilt from the chat is the right text** - When an upload can't be downloaded, its text is recovered from the chat. A folder listing that mentioned the file, a partial read, or a file with a similar name could be saved in its place. Only a full read of that file is used now.
- **More script edits are flagged** - Commands that changed a file with `open(p, 'w', encoding=...)`, `Path(p).write_text`, `sed -E -i` or `--in-place`, `perl -i`, `tee`, `cp` or `mv` went unnoticed, so the exported file could be out of date with no pointer to `replay_bash.py`. They now get the `artifact_opaque_mutation` warning. On 87 real chats the warnings are unchanged, so nothing new is flagged by mistake.
- **`integrated_chat.txt` keeps code intact** - Code blocks lost underscores, asterisks and backticks (`__init__` became `init`, `a*b*c` became `abc`). Code is now kept as written, between separator lines.

### v1.6.6

- **Copy a whole file** - Upload and pasted-text popups, the file panel and the "Archive files" panel have a Copy button in their header. It copies the file's text, and in Preview it copies the source, not the rendered page. Images, PDFs and other non-text files have none. A large upload's Copy appears once its text has loaded. Older exports get this when their viewer is rebuilt with `--force`; see [Updating a viewer](USAGE.md#updating-a-viewer).
- **Underscores no longer turn Markdown italic** - A file named like `sept21_part1` in a Markdown heading made the rest of the file italic in Code view. An underscore inside a word now starts nothing, and italics or bold stop at a blank line, as in Markdown itself. Older exports get this when their viewer is rebuilt with `--force`; see [Updating a viewer](USAGE.md#updating-a-viewer).

### v1.6.5

- **Preview scripts with `<!--` run** - A generated file whose script held `<!--` inside a regular expression with the `u` flag failed to run in the viewer's preview. It now runs. Older exports get this when their viewer is rebuilt with `--force`; see [Updating a viewer](USAGE.md#updating-a-viewer).
- **A large upload that can't load points to its copy** - If an upload's text can't load from `viewer-files/`, the popup says so and shows the upload's own file in `uploads/`, with an open link where the file type allows it. Older exports get this when their viewer is rebuilt with `--force`; see [Updating a viewer](USAGE.md#updating-a-viewer).
- **Reopening a large upload is instant** - Text that finished loading after its popup was closed is kept. Older exports get this when their viewer is rebuilt with `--force`; see [Updating a viewer](USAGE.md#updating-a-viewer).

### v1.6.4

- **Large uploads load when opened** - Upload text over 64 KB is no longer stored inside `viewer.html`. It goes into `viewer-files/` beside it, and loads when you open the upload. Search works as before, since it never read upload text. A test archive's viewer shrank from 81 to 44 MB and opens in under a second. Older exports get this when their viewer is rebuilt with `--force`; see [Updating a viewer](USAGE.md#updating-a-viewer).
- **Pasted text is labeled** - Text pasted into a prompt shows as "Pasted text" in the viewer, numbered when a prompt has several, instead of "Untitled". An upload with no name shows the name of its saved file. Older exports get this when their viewer is rebuilt with `--force`; see [Updating a viewer](USAGE.md#updating-a-viewer).

### v1.6.3

- **Smaller viewers for mega-ZIPs** - A project shared by several chats is stored once in `viewer.html`, instead of once per chat. A test archive with four chats in one project shrank from 97 to 81 MB. Older exports get this when their viewer is rebuilt with `--force`; see [Updating a viewer](USAGE.md#updating-a-viewer).

### v1.6.2

- **Syntax colors in the viewer** - Labeled code blocks, plus files in Code view and text uploads, now have colors, in light and dark themes. Blocks are colored as they scroll into view, in the background, so a long chat stays quick. Blocks with no language label stay plain, as do blocks over 200 KB and any that take too long. Older exports get this when their viewer is rebuilt with `--force`; see [Updating a viewer](USAGE.md#updating-a-viewer).

### v1.6.1

- **Viewer for older archives** - `tools/build_viewer.js` gives exports made before v1.6 a `viewer.html`, from a folder or a ZIP. It changes none of the existing files. Files you added to an archive show in the viewer under "Archive files". See [USAGE.md](USAGE.md#adding-a-viewer-to-older-archives).
- **Open file limited to safe types** - In every viewer, the Open file link appears only for documents, images, audio, video, archives and plain data files. HTML, SVG and other types that run in the browser can still be previewed in the sandbox, but have no link that opens them directly.

### v1.6.0

- **Offline viewer** - Every ZIP export now includes `viewer.html` (plus a small `viewer-check.gif`). Unzip, then open `viewer.html` to browse, search and read the exported chats, with artifacts and uploads previewed in place. A mega-ZIP gets one viewer for all chats, with project chats grouped. The other export files are unchanged. If the viewer can't be built, the export still downloads and the status line says so. Chats that couldn't be added to it are listed in `errors.txt`.
- **Copy in the viewer** - Every prompt and response has a Copy button. A prompt copies as you typed it; a response copies its Markdown text, without thinking, tool steps, file cards or citation markers. The button says "Copy failed" if the browser refused, and code blocks do the same.
- **Thought process** - Shows every summary claude.ai provides, and says so when the full thinking isn't in the export.
- **Code in prompts** - Fenced code in a prompt shows as a code block in the viewer, as it does in a response.
- **Project instructions in the viewer** - A project's instructions sit in their own fold at the top of the chat, above a separate fold for its files, even for a project with no files. Very long instructions are cut in the viewer, with the whole text still in `project/prompt_template.md`.

### v1.5.10

- **Smaller mega-ZIPs for projects** - Each project's knowledge files are stored once in a `projects/` folder and linked from each chat's `README.md`, instead of being copied into every chat. Moving a chat folder elsewhere leaves those files behind. Single-chat ZIPs are unchanged.

### v1.5.9

- **`replay_bash.py` covers newer chats** - It now replays the `Bash`, `Write` and `Edit` tools, and finds uploads where those sessions keep them. `artifact_opaque_mutation` warnings from `Bash` commands now have a recovery path.

### v1.5.8

- **Refresh stays put** - Refresh reloads the current chat in place, instead of reloading your tab and closing the popup or panel. The button now just says Refresh.
- **No refresh needed to start** - The first-use instruction to refresh the page is gone, along with messages that mentioned it.
- **Dead capture removed** - The extension no longer watches for conversations on the page, which stopped working when claude.ai changed how it loads them. Old cached copies are cleared from storage.

### v1.5.7

- **Project files exported** - Files added to a project's knowledge, such as PDFs, are now saved to `project/files/` with their metadata in `project/files.json`. They were missing with no warning, because claude.ai lists them outside `/docs`.
- **Missing project content is reported** - `errors.txt` now warns if a project reports more items than the export found.

### v1.5.6

- **Failed tool calls no longer change artifacts** - A `create_file`, `str_replace`, `Write` or `Edit` that failed in the conversation was still replayed, so an artifact could contain an edit that never happened, or content the tool had rejected. They're now skipped, in `extract_artifacts.py` and `replay_bash.py` too. Re-export chats that relied on this.
- **All heredocs tracked** - `cat > file << DELIM` now works with any delimiter, not only `EOF`, and with several in one command. `artifact_opaque_mutation` also checks commands that contain a heredoc.
- **Fewer false `str_replace_failed` warnings** - No warning for edits that really failed, or for files downloaded in their final state.

### v1.5.5

- **`replay_bash.py` is now isolated** - Earlier versions called it sandboxed, but commands ran with your full permissions and network. On macOS, commands now run under a deny-by-default `sandbox-exec` profile. Without it the tool refuses to run unless you pass `--no-isolation`, which can't be combined with `--all`.
- **Safer replay** - Commands get a minimal environment, conversation paths can't escape the tmpdir, symlinks can't pull in outside files, and prompts show control characters safely and say when a command is cut off. Originals are saved to `artefacts_before_replay/`.
- **Correct replay** - File edits and scripts now run in conversation order, commands start in `/home/claude`, bare `/home/claude` and `/tmp` paths are rewritten, and artifacts sharing a basename no longer overwrite each other.

### v1.5.4

- **Binary files no longer corrupted** - Files Claude presented, such as PDF, DOCX, ODT, PNG and ZIP, were decoded as text and came out unreadable. They now stay as raw bytes. Re-export any archive you rely on.
- **Delivered files exported** - Files Claude sends through `SendUserFile` are saved to `artefacts/`. A file delivered more than once keeps every copy as `_vN`, with the latest under its plain name. A delivered file that shares a name with a replayed artifact gets a `_delivered` suffix.
- **Failed uploads recovered** - Downloads now try the `/files/<uuid>/contents` endpoint, which serves uploads the old URLs reported as 404.
- **Newer tools supported** - `Write` and `Edit` count as artifacts, `Bash` counts like `bash_tool`, and `Read` results can recover blob files.
- **Mega-ZIP folders stay separate** - Chats whose titles match, or match once shortened, get a numbered folder instead of merging.
- **Smaller fixes** - Compaction summaries appear in the Markdown, filenames are normalized to NFC, and `meta.md` reports the features a chat used and any failed uploads.

### v1.5.3

- **Side panel follows the selected chat** - The panel now updates when you select another chat or switch tabs. Previously it stayed on the chat it opened with, and its export buttons exported that old chat.
- **Chats load by ID** - claude.ai now loads chats over an RPC stream that the fetch interceptor can't read, so the extension fetches the chat in the tab URL itself. Single-chat exports fetch it again first, so they include the latest messages, and report an error rather than export an older copy. Export is disabled while a chat loads and on pages that aren't a chat.
- **Open tabs keep working after an extension reload** - The panel injects its content script into a tab that doesn't have one, so the tab no longer needs reloading. Load failures now show the real error rather than "Refresh page to capture data."
- **Active org** - The `lastActiveOrg` cookie now decides which organization requests go to, ahead of any captured or stored ID.

### v1.5.2

- **Per-turn artifact versioning + `str_replace` replay** - `extractArtifacts` now walks the message chain in chronological order, replays `str_replace` edits against running content, and snapshots each artifact at the end of every assistant turn in which it changed. Edited artifacts get `<base>_v1<ext>` … `<base>_vN<ext>` plus the unversioned final. Fixes the "artifacts frozen at v1" data-loss bug.
- **`extract_artifacts.py` companion** - stdlib-only Python 3 port of `extractArtifacts` for offline reconstruction; byte-identical output.
- **`replay_bash.py` recovery CLI** - sandboxed post-export replay of `bash_tool` commands. Handles every case the extension can't reconstruct declaratively (Python heredocs that mutate artifacts, `sed -i`, `awk`, multi-step pipelines). Per-command confirmation, timeout, `--dry-run` / `--all` modes.
- **`artifact_opaque_mutation` warning** - any `bash_tool` command that mutates a tracked artifact path is now flagged in `errors.txt` with the exact recovery command. Variable bindings (`f='foo.html'; open(f,'w')`) are detected as artifact references.
- **Sandbox-path → base64 inlining** - any artifact reference to `/mnt/user-data/uploads/<filename>` is automatically rewritten as a `data:` URI in the on-disk export, producing self-contained HTML for the common case.
- **`docs/WASM_REPLAY_APPROACH.md`** - architecture record evaluating Pyodide-in-the-extension as an alternative to the post-export CLI.

### v1.5.1
- **Reliable project prefix on every export path** - `[Project_Name-project]_` is now applied to single MD/Embedded MD/ZIP/JSON exports and to all four bulk export paths, not just the ones whose captured payload happened to include `project.name`. When the page-side fetch only returns `project_uuid`, the extension resolves the name from `/api/organizations/<orgId>/projects/<projectUuid>` before generating the filename.
- **Structured error report with recovery hints** - `ExportErrorCollector` produces a categorized `errors.txt` (errors + warnings, HTTP status, URLs tried, fallback results, troubleshooting guide) when any file extraction fails.
- **Warning status state** - Popup and sidebar now show a distinct amber warning state for partial-success exports (e.g. ZIP succeeded but one upload couldn't be downloaded).

### v1.5.0
- **Presented files download** - Files created via bash/Python scripts and presented to user are now downloaded and included in artefacts folder
- **Comprehensive error reporting** - Failed file extractions logged to `errors.txt` with:
  - Detailed error messages and HTTP status codes
  - All URLs attempted for each failed file
  - Recovery hints for manual fixing
  - Troubleshooting guide with common solutions
  - Warnings for truncated project files
- **Markdown escaping in README** - Response titles with special characters (backticks, asterisks, etc.) are now properly escaped to prevent malformed rendering
- **Artifact embedding in full_chat.md** - Artifacts from `create_file` tool now embedded as code blocks in `full_chat.md` and included in `code_snippets.md`
- **Plain text integrated chat** - Generates `integrated_chat.txt` with clean ASCII formatting (no markdown syntax)
- **Blob file path normalization** - Files with special characters (semicolons, parentheses, commas, periods) now correctly extracted from view tool fallback when API returns 404
- **Sanitized path fallback for API** - When downloading files via wiggle endpoint, also tries sanitized path (underscores for special chars)
- **Project filename prefix** - Exports from project conversations prefixed with `[Project_Name-project]_`
- **Full project file download** - Downloads complete project files via API (falls back to truncated view tool results)
- **Project metadata export** - Saves `project.json` and `docs.json` in ZIP exports
- **System prompt extraction** - Extracts `prompt_template` field as `prompt_template.md`
- **Truncated file indicator** - Files from view tool fallback named with `_truncated` suffix
- **UTF-8 BOM for markdown files** - Ensures browsers correctly render files opened via `file://` URLs
- **Bash heredoc artifact extraction** - Extracts files created via `bash_tool` with `cat > file << 'EOF'` commands
- **Mojibake repair** - Fixes UTF-8 encoding corruption with comprehensive character support:
  - Greek letters (α β γ ζ), Cyrillic
  - Box drawing (┌ ─ │ └), geometric shapes (□ ◇ ○)
  - Math symbols (∀ ∃ ∈ ∅), arrows (→ ← ↔)
  - Subscripts/superscripts (₀ ₁ ² ³)
  - Emojis (🔥 😀 🚀 🤔)

### v1.4.0
- **Project files extraction** - Extracts files from Claude Projects that were viewed during conversation
- **Attachment linking in prompts** - Attachments now properly linked in prompts.md, including auto-generated filenames
- **Empty filename handling** - Attachments without filenames get generated names like `attachment_1.txt`

### v1.3.0
- **Web search sources extraction** - Extracts and displays sources from web search results
- **Combined links_and_sources.md** - Links and web sources in a single file, grouped by domain
- **Model name detection** - Parses model to show variant (e.g., "Claude 4.5 Sonnet")
- **Enhanced metadata** - Duration, starred status, features used (Web Search, Artifacts, Extended Thinking)
- **Image URL construction** - Constructs download URLs for images without direct URLs in JSON
- **Binary attachment handling** - PDF/DOCX/etc. attachments saved as .txt (extracted text only)
- Renamed `embedded_full_chat.md` to `integrated_chat.md`

### v1.2.0
- Added sidebar mode (stays open while browsing)
- New setting: "Open as sidebar by default"
- Added Export All (Embedded) - bulk embedded markdown export
- Added Export All (Mega-Zip) - single zip with all conversations
- Each mega-zip conversation folder matches individual zip structure
- Added support for `artifacts` tool (in addition to `create_file`)
- Automatic file extension mapping for 24+ content types
- Individual response.full.md files now embed associated artifacts with syntax highlighting
- ZIP exports now include uploaded files (PDFs, images) downloaded from Claude's servers
- ZIP exports now include pasted text attachments with extracted content
- Citation footnotes - web search citations converted to footnote-style references
- Added background service worker
- Renamed to Claude Takeout

### v1.1.0
- Added ZIP export with full archive structure
- Added keyboard shortcuts
- Improved tool handling (bash, str_replace, view, etc.)
- Better thinking block summaries using summaries array
- Dynamic code fence selection
- Branched conversation handling
- Progress indicator for operations
- Enhanced error handling

### v1.0.0
- Initial release
- Markdown and JSON export
- Bulk export all conversations
- Basic artifact handling

## License

MIT License - Feel free to modify and distribute.
