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
- JSON structure and data extraction
- Message chain/tree resolution for branched conversations
- Content block types (text, thinking, tool_use, tool_result)
- Artifact extraction from multiple tool types
- File handling (attachments, uploads, ephemeral blobs, project files)
- Web search sources and citation processing
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
