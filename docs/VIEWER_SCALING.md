# viewer.html at mega-export scale

Possible improvements to the offline viewer for Export All (mega) archives, where one `viewer.html` covers every chat. Nothing here is planned yet; each idea needs its own design and plan. Written 2026-11-25, after v1.23.0.

## The problem

An Export All writes one `viewer.html` for the whole archive. Everything a chat needs is inlined as one JSON block (`<script id="data">`), except upload text and file versions over 64 KB (`UPLOAD_INLINE_LIMIT`), which already go to `viewer-files/part-NNNN.js` and load on demand.

The file therefore grows with the number of chats. A real export from 2026-11-25 (28 chats, read-only measurement):

| Part of viewer.html | Size | Share |
|---|---|---|
| Chat data (`chats`) | 15.2 MB | 92% |
| Projects, artifacts list, other data | 0.2 MB | 1% |
| Code: KaTeX (JS + CSS with fonts), highlight.js, marked, the viewer's own JS and CSS | 1.1 MB | 7% |
| **Total** | **16.5 MB** | |

Inside the chat data:

| Kind | Size | Needed by search? |
|---|---|---|
| Tool blocks (inputs, results, images as data URIs) | 7.3 MB | no |
| Generated files' version text (`files`, each version ≤ 64 KB) | 3.8 MB | no |
| Response text (`text` blocks) | 1.8 MB | yes |
| Pasted attachments | 1.3 MB | yes |
| Upload entries (text ≤ 64 KB, names) | 0.6 MB | names only |
| Thinking | 0.1 MB | no |

The median chat is about 290 KB; the largest is 2.9 MB. At that rate a 500-chat export would put well over 100 MB into one HTML file. At that size, opening the page means reading, parsing and holding all of it before anything shows, and Chrome's memory use grows several times over the JSON's size. **That is the scaling limit, not the code.**

What already scales well and needs no change: messages render in batches (`renderChat`, `BATCH_SIZE` 10 per frame, `FAST_BATCH_SIZE` 100 towards a search hit), code colouring runs in a worker as blocks scroll into view, previews and Design boards are made only when opened or near the view, and large uploads load from parts.

## Constraints any change must keep

- Opens from disk over `file://` with no server. Parts are local scripts (`window.__archivePart`), allowed by `script-src file:` only when an export has parts (`assembleViewer`'s `fileScripts`).
- A `viewer.html` opened inside a ZIP, or copied without `viewer-files/`, must still say what's wrong (`viewer-check.gif` detects the ZIP case today) and show what it can.
- No server, no new runtime library, no change to the security model: page CSPs, `PREVIEW_CSP`, sandboxed previews, `sanitizeHtml`.
- The old-archive tools write the same viewer: `tools/build_viewer.js` and `tools/merge_archives.js` must produce the new layout too, and read the old one.
- Search keeps working across all chats.

## Options

### 1. Load each chat's heavy parts when it's opened (biggest win)

Keep in `viewer.html` what the sidebar and search need: titles, dates, projects, the message tree, response text, attachment text and file/upload names. Move per chat into a part: tool blocks, thinking, file version text, upload text and card data. The viewer loads a chat's part when the chat opens (as it already does for large uploads), shows a short "Loading…" for that chat, and keeps loaded parts in memory, or drops the least recent ones in a very large archive.

- **Gain:** about 11–12 MB of the 15.2 MB in the measured export moves out (≈ 75%), so the page that opens is about a quarter of the size, and memory grows only with the chats actually opened.
- **Search is unaffected:** `buildSearchIndex` reads only `text` blocks, attachments and upload names, all of which stay inline.
- **Cost:** a new data contract in `takeout-viewer.js` (`buildViewerData`, `moveUploadText` generalised); `renderChat` waits for the part; the Files list, Artifacts screen "In chats" and anything else that reads tool blocks or file text across chats must load on demand or use summaries kept inline; build_viewer and merge must write and read it.
- **Risk:** a missing `viewer-files/` now loses tool steps and file previews, not only large uploads. The page must say so per chat.
- **Size:** L, written design first.

### 2. Stop storing generated files twice (to be measured)

A file Claude wrote with `create_file` / `Write` likely appears twice: as the tool block's input text and as the file's version text in `files`. If the tool block could point at the file version instead of repeating it, the data shrinks without any lazy loading.

- **Gain:** unknown until measured; possibly a large share of the 7.3 MB tool blocks.
- **Cost:** the viewer's tool rendering resolves the reference; `buildViewerChat` emits it. Small and self-contained.
- **Size:** S–M. Measure first: sum the tool inputs whose text equals a stored version.

### 3. Compress the inline data

Store the chat data gzip-compressed and base64-encoded, and decompress it on load with the browser's `DecompressionStream`. JSON of chat text typically compresses 4–8×, so even with base64's +33% the file on disk would be a fraction of today's.

- **Gain:** a much smaller file on disk and in a ZIP (the ZIP already compresses, so less there), and less to read from disk. Parse time and memory after decompression stay the same.
- **Cost:** gzip at export time (`CompressionStream` in the extension, `zlib` in the Node tools), a short async step before the viewer renders.
- **Risk:** low; `DecompressionStream` is in every current Chrome.
- **Size:** S. Combines well with 1 (compress the parts too).

### 4. Load KaTeX and highlight.js only when needed

Move KaTeX (JS and its font-carrying CSS, about 640 KB) and highlight.js (about 130 KB) into `viewer-files/` and load them the first time a chat has maths or a code block scrolls into view.

- **Gain:** about 0.8 MB less to parse at start-up, the same for every export, so it matters most for small exports.
- **Cost:** the highlighter worker is built from the `#highlighter` script tag today and would load from the file instead; KaTeX rendering becomes async.
- **Risk:** a `viewer.html` without its folder loses maths and colours (fall back to plain text, which is what a failure does today).
- **Size:** M.

### 5. Search for large archives

Search builds its index on first focus (`buildSearchIndex`), keeps a lower-cased copy of every text (doubling that memory), and scans every entry linearly on each query, debounced by 120 ms. That is fine at today's sizes. For thousands of chats:

- Build the index in a worker, or in chunks between frames, so the first focus doesn't freeze.
- Search in a worker and stream results.
- Or precompute a compact index at export time (for example per-term chat lists) and keep the full text only for highlighting.

**Size:** M. Only worth doing after measuring a slow search.

### 6. Rendering very long chats

Batched rendering already keeps the page responsive, but a chat with thousands of messages ends with thousands of DOM nodes. Options: render tool results and long code collapsed and build their content on first expand; or window the message list (render what's near the view, keep placeholders of known height elsewhere).

**Size:** M (collapsed content) to L (windowing). Only worth doing after measuring.

### 7. Minify the viewer's own code

The viewer's JS and CSS (about 330 KB) ship unminified. A dev-time minify step with the output checked in, or minifying at export, would roughly halve it.

**Size:** S–M, but it adds a build step the project doesn't have. The smallest gain here.

## Suggested order

1. **Measure** on a large real export (read-only, test Chromium): time until the chat list is usable, time to open the largest chat, one search keystroke, and the page's memory. Also measure option 2's duplication.
2. **Option 3 (compression)** if file size on disk is the complaint: small, low-risk, no format change visible to users.
3. **Option 2 (no duplicate file text)** if the measurement shows real duplication.
4. **Option 1 (per-chat parts)** when exports reach hundreds of chats or the first open is slow: the only option that keeps the page's size and memory flat as archives grow.
5. Options 4–7 only when a measurement points at them.
