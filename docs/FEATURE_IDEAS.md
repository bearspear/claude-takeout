# Feature ideas

Candidate features for Claude Takeout after v1.6.12, with the problem each solves, a design sketch based on the current code, a rough size, and the risks. Nothing here is planned yet. Each idea goes through a design and plan of its own before any code is written.

**Size:** S is one PR of about a day, M is one or two PRs, L is several PRs with a written design first.

**Shipped since this list was written** (not on it, but the same kind of work): grouped and ranked search with operators (v1.6.13), the Files list in each chat's top bar (v1.6.14), and the in-chat "match N of M" bar (v1.6.15). From this list: the export health check (v1.6.22) warning badges in the viewer (v1.6.23), and incremental export as Export Changes (v1.7.0; combining a base archive with its updates offline is not built yet).

## Recommended order

1. [Export health check](#1-export-health-check) (S): protects every export against the biggest remaining risk, a silent change to claude.ai's API.
2. [Incremental export](#2-incremental-export) (M): makes regular backups cheap.
3. [Warning badges in the viewer](#4-warning-badges-in-the-viewer) (S): puts `errors.txt` where people actually look.

The rest follow when there is a need for them.

---

## Keeping the archive current

### 1. Export health check

**Problem.** Exports depend on claude.ai's undocumented REST API. When its shape changes (it already changed once, when conversations moved to an RPC stream), an export can come out thin, with empty messages or no uploads, and nothing says so. Today you would only notice by chance.

**Sketch.**
- After each chat is fetched, run a few cheap checks on the payload:
  - `chat_messages` is empty although the chat list showed it had activity;
  - messages have no `content` blocks;
  - `current_leaf_message_uuid` is missing or unknown;
  - every upload failed;
  - unknown content-block types or tool names appear.
- For a bulk export, also compare the number of chats listed with the number exported.
- Record the results as a new warning type, `export_health`, with its own `_getRecoveryHint` case (CLAUDE.md §11). Turn the status pill amber with a short message such as "3 chats look incomplete, see errors.txt".
- Unknown block types are worth listing even when the export is otherwise fine. They are the first sign of a new claude.ai feature the exporter doesn't render yet.

**Size:** S. **Risks:** false alarms on genuinely empty chats. The checks need thresholds tuned on real exports, and the 87 local `original.json` files are a ready test set.

### 2. Incremental export

**Problem.** "Export All" fetches and writes every chat every time. For someone archiving regularly, almost all of that is repeated work and repeated downloads.

**Sketch.**
- Keep a record of what was exported in `chrome.storage.local`, keyed by org: chat uuid → `updated_at` at export time.
- Add an "Export changes since last time" option. It fetches the chat list (one request), compares `updated_at`, and builds a mega-ZIP of only the new or changed chats.
- The mega-ZIP gets an `export-manifest.json` listing every chat it holds, with `updated_at`, so the archive itself records what it contains independent of the browser.
- Merging happens offline: idea 6's library viewer, or a small extension to `tools/build_viewer.js`, combines a base archive and its updates, with the newest copy of each chat winning.
- The browser never writes into an existing folder, which an extension can't do safely anyway.

**Size:** M. **Risks:** a chat edited on another device after export but with an unchanged `updated_at` would be missed, so check whether `updated_at` really moves on every new message. Clearing the extension's storage loses the record, but the manifest in each ZIP can rebuild it.

### 3. Selective bulk export

**Problem.** Bulk export is all or one. Exporting one project, one month, or the chats matching a word means many single exports.

**Sketch.** A filter step before a bulk export, in the side panel where there is room:
- project, from the chat list's project field;
- date range, from `updated_at`;
- title text.

The selected list feeds the existing `bulkExport` / `bulkExportZip` loops unchanged.

**Size:** S–M. **Risks:** the popup is small. The filter UI belongs in the side panel, or in a page the extension opens.

---

## Making the viewer more useful

### 4. Warning badges in the viewer

**Problem.** When Claude changed a file with a script, the export flags it in `errors.txt` and the exported file may be out of date. In the viewer that file looks normal. The validation on 2026-11-08 found 9 such files in one export, none of them visible as such.

**Sketch.**
- Pass the export's warnings into the viewer data. `ExportErrorCollector` already has them, as do `artifact_opaque_mutation` and `str_replace_failed` with file names.
- Show a small badge on the file card and in the panel header: "May not match what Claude made; see errors.txt". The panel note can name the `replay_bash.py` command for that chat folder.
- For older archives, `tools/build_viewer.js` can read `errors.txt` to do the same.

**Size:** S. **Risks:** keeping the wording calm, since most flagged files are fine or nearly so.

### 5. Search inside uploads and files

**Problem.** Search covers titles, prompts, replies and pasted text, but not the text of uploads or of files Claude made. Since v1.6.4 and v1.6.9 that text lives in `viewer-files/` parts, which the page doesn't load until a file is opened.

**Sketch.**
- An "Also search files" toggle in the search box.
- When it's on, load parts one at a time (`loadPart` already does this and keeps two), search their texts, and add hits as "in file `name`" results that open the file panel at the match.
- Show progress, since a large archive has many parts.
- Text kept inline in the page (small uploads and files) can be searched straight away.

**Size:** M. **Risks:** memory on very large archives. Searching part by part and keeping only the hits avoids holding all text at once.

### 6. One library across several exports

**Problem.** Each export has its own viewer. Years of exports mean many separate pages, with the same chats repeated across them.

**Sketch.**
- `node tools/build_viewer.js <folder> --library` finds every export under a folder, as it already does. It then writes one `library.html` at the top that covers all of them, with each chat taken from the newest export that has it (by `updated_at`).
- Files stay where they are. The library's links are relative paths into each export, which the tool already computes for mega-ZIPs.
- This also gives idea 2 its merge step.

**Size:** M–L. **Risks:** the write-safety rules for the tool (CLAUDE.md §15) must cover the new file. Links that cross export folders need the same `..` handling that v1.6.10 tightened in `joinPath`, deliberately allowed one level up for this case.

### 7. Print and PDF styling

**Problem.** There is no clean way to print a chat, or one branch of it, or to save it as PDF from the viewer.

**Sketch.** A print stylesheet (`@media print`):
- hides the sidebar, panel and controls;
- expands collapsed thinking and tool steps when asked;
- keeps code blocks from splitting across pages.

Add a "Print this chat" button that prints the branch on screen.

**Size:** S. **Risks:** few. Browser print differences are the main one.

### 8. "Open on claude.ai" link

**Problem.** From an archived chat there is no quick way back to the live conversation.

**Sketch.** A link in the chat header to `https://claude.ai/chat/<uuid>`. It opens outside the viewer (`noopener`), like other external links. The viewer's CSP already allows link navigation, since it blocks only requests.

**Size:** S. **Risks:** chats deleted from claude.ai give a 404. The link text can say "may no longer exist".

---

## Larger, previously discussed

### 9. Cowork export

Deferred by the owner on 2026-11-05. Cowork sessions are not in the chat list and the REST chat endpoint returns 404 for them. A private `/v1/code/sessions` list and events endpoint exist (see the project notes). This needs its own design: what a session's export looks like, how its events map to the viewer, and how much to rely on a private API.

**Size:** L.

### 10. Images in tool results

Not exported, by the owner's decision on 2026-11-06. These are links in the payload, not image data, and are mostly Claude's own render checks. Worth revisiting only if those screenshots turn out to be missed.

**Size:** M.

---

## Not proposed

- **Renaming ZIP and bulk exports by the Filename style setting.** This would rename every export people already have. The docs now say which downloads the setting affects.
- **Running `replay_bash.py` in the browser.** Weighed and rejected in `docs/WASM_REPLAY_APPROACH.md`. Idea 4 surfaces when it's needed instead.
