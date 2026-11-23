# Claude Takeout — Usage Guide

End-to-end guide to installing the extension, exporting conversations, understanding what's in the export, and recovering anything that didn't come through cleanly.

If you're a developer working on the codebase, you want `CLAUDE.md` instead. This file is for people using the extension.

---

## Table of contents

1. [Quick start](#quick-start)
2. [Installation](#installation)
3. [Exporting one conversation](#exporting-one-conversation)
4. [Bulk export — all conversations](#bulk-export--all-conversations)
5. [Picking an export format](#picking-an-export-format)
6. [Inside a ZIP export](#inside-a-zip-export)
7. [Reading `errors.txt`](#reading-errorstxt)
8. [Companion CLIs](#companion-clis)
9. [Common workflows](#common-workflows)
10. [Settings and keyboard shortcuts](#settings-and-keyboard-shortcuts)
11. [Troubleshooting](#troubleshooting)

---

## Quick start

```
1. Load the extension once    (chrome://extensions → Load unpacked → pick this folder)
2. Open claude.ai
3. Click the extension icon
4. Pick a format and download
```

For most users: **Export as Zip** is the right default. It gives you everything in one self-contained folder with every artifact, every attachment, every uploaded file, and the raw JSON for recovery.

---

## Installation

1. Open Chrome and navigate to `chrome://extensions/`.
2. Toggle **Developer mode** on (top-right).
3. Click **Load unpacked** and select this `claude-takeout` folder.
4. (Optional but recommended) Click the toolbar puzzle icon and pin **Claude Takeout** so it's one click away.

After any code change to the extension you must come back here and click the circular reload icon — Chrome doesn't auto-pick-up edits.

The extension is fully local. No API keys. It uses your existing logged-in session on claude.ai.

---

## Exporting one conversation

1. Open a conversation on **claude.ai**.
2. **Refresh the page** once after installing — the extension can only see API responses for fetches that happen *after* it loads. You'll only need to do this once per session.
3. Click the **Claude Takeout** icon. The popup should say *"Ready to export!"* with the conversation title and message count.
4. Pick one button:

| Button | Output | When to pick it |
|---|---|---|
| **Export Current (Markdown)** | `<title>.md` | Quick share / pasting. Artifacts are referenced by filename, not embedded. |
| **Export Embedded** | `<title>_embedded.md` | Single `.md` with every artifact's source inlined as code blocks. Good for posting on GitHub gists. |
| **Export as Zip** | `<title>_claude-chat.zip` | The full archive — every artifact as a file, every upload downloaded, full chat in multiple shapes, raw JSON. See [Inside a ZIP export](#inside-a-zip-export). |
| **Export Current (JSON)** | `<title>.json` | Raw API payload. Backups, scripted post-processing, debugging. |

If the conversation is part of a Claude Project, the filename is prefixed with `[<Project-Name>-project]_` automatically.

---

## Bulk export — all conversations

For exporting your whole history:

1. Navigate to **claude.ai** (any page works — you don't need to be inside a specific conversation).
2. Hard-refresh once.
3. Click the extension icon.
4. Below the divider, pick one of:

| Button | What you get |
|---|---|
| **Export All (Markdown)** | One `.md` file per conversation in your downloads folder. |
| **Export All (Embedded)** | One `_embedded.md` per conversation, artifacts inlined. |
| **Export All (Folder)** | Asks for a folder, then writes into a new folder inside it, `claude-takeout-<your name>-<YYYY-MM-DD>_<HHMM>` (lowercase, your local time), the same as the Mega-Zip below holds, chat by chat. It runs in the side panel; from the popup, the button opens the side panel, where you click it again. Files the folder refuses are listed in `write-errors.txt`. |
| **Export All (Mega-Zip)** | With **Export All saves as: ZIP** in Settings: a single `claude-takeout-<your name>-<YYYY-MM-DD>_<HHMM>.zip` (your claude.ai display name; left out if claude.ai doesn't give one) containing one folder per conversation (full ZIP structure each), plus an `index.md` master table and an `export-manifest.json` listing every chat it holds, with each chat's `updated_at`, at the root. |
| **Export All (JSON)** | One `.json` per conversation. |
| **Export Artifacts (Folder)** or **(ZIP)** | Every artifact on claude.ai/artifacts, as it is now. See [Export Artifacts](#export-artifacts). |

**Only new or changed chats.** Set **Mega-Zip exports** in Settings to **Only new or changed**, and the Mega-Zip button becomes **Export Changes (Mega-Zip)**. It makes a `claude-takeout-<your name>-changes-<YYYY-MM-DD>_<HHMM>.zip` with only the chats that are new or changed since the last mega-ZIP made in this browser. The first time, or after the extension's storage is cleared, it exports everything and says so. If nothing changed, nothing downloads. Keep it with your earlier archives: it doesn't repeat the chats they hold. A chat or artifact that wasn't fully saved (a file that couldn't be written to the folder, or published pages skipped after claude.ai answered 401) isn't counted as exported, so the next Export Changes tries it again. The default is **All chats**.

**Artifacts in the same export.** With **Include artifacts in Export All** on in Settings (the default), Export All also saves what claude.ai/artifacts lists, after the chats, into `artifacts/` in the same folder or ZIP: one folder per artifact (`<Title>_<id>/`, with an `artifact.json` and a subfolder per version), `index.html`, `index.md` and, only with warnings, `errors.txt`. Pages a chat already saved are reused, not fetched again. Export All writes no `published/` folder: the pages chats published live in `artifacts/` too, see [Published pages](#published-pages). With **Include artifacts in Export All** off, `artifacts/` still holds every page a chat published, and nothing from claude.ai's list. A failed artifact step never removes or delays the chats. One `viewer.html` at the root holds both (see [The combined viewer](#the-combined-viewer)). Export All never asks for the card-picture permission, so without it cards are tiles. With **Only new or changed**, only artifacts whose version changed are included, and `index.md` says "Changed since <date>: N of M listed". An artifact saved only in part, with a file missing, is tried again next time. Export Artifacts, the separate button, works as before.

Progress shows below the buttons as `X / Y`. There's a 200–300 ms pause between conversations to be polite to Claude's API. 100 conversations takes about 30 seconds; 1000 will take under 10 minutes.

If a single conversation fails (deleted, server hiccup, rate limit), the bulk export continues with the rest and reports the failures at the end.

### Export Artifacts

Saves what claude.ai/artifacts lists: every artifact you made in any chat, project or Claude Code session, plus artifacts shared with you. It is separate from Export All and ignores its **Export All exports** setting. Open claude.ai in a tab, signed in; the button is the one after Export All (Folder or Mega-Zip). It saves into a folder or a ZIP as **Export All and Export Artifacts save as** says; use **Folder** for a large account, since a ZIP is built in memory. In a folder, the popup opens the side panel, where you click the button again.

You get `claude-takeout-artifacts-<your name>-<YYYY-MM-DD>_<HHMM>` with:

- `viewer.html` and `viewer-files/`: the viewer (see below). `viewer-files/thumbs/` holds the card pictures and `part-NNNN.js` the text and images the previews use. Card pictures need the same permission as web-search images (Settings > **Save web images and artifact card pictures**). Saving as a ZIP, Export Artifacts asks for it in the click, each time until you allow it. Saving to a folder, it doesn't ask (the folder picker needs the click): turn it on in Settings first. Without it, the cards show tiles, the status line says so, and `index.html` says "Card pictures: 0 of N (needs the web images permission ...)".
- `index.html`: a table of every artifact (title, kind, source, files, notes) and "Card pictures: N of M". The title opens the artifact's page from disk, except when an artifact shared with you (or one claude.ai doesn't mark as yours) starts with anything but documents, images, media, archives and plain data files; "claude.ai" opens it online; "Open the artifacts viewer" opens `viewer.html`, when it was written.
- `index.md` and `export-manifest.json` (`kind: "artifacts"`): the same list for other tools, with "Listed by claude.ai: N", the count claude.ai gave.
- One folder `<Title>_<id>/` per artifact: an `artifact.json` (format 2) and a subfolder per version saved, here the current version (named by its version id, or `current` when claude.ai gave none). When that version has two or more files, `<version>.zip` beside the folder holds them all, and `artifact.json` names it (`zip`).
- `errors.txt`, only when there are warnings (`artifact_export`).

Limits to know:

- **Claude Docs** documents are listed with their title and link, not saved: their text isn't available as a file. Export the chat that made one to get the document. In Export All, when that chat is in the export, the row says "Text rebuilt from the chat <chat title>." instead.
- Artifacts built on claude.ai's own page code (Design, and others with a type) save only their own files, or just `artifact.json` when they have none, and say "needs claude.ai to run" or "open on claude.ai".
- **Shared with you** artifacts are marked so, in both indexes and in `artifact.json`. They were written by someone else: HTML opened from disk runs with whatever that page contains, so open it only if you trust the sender. An artifact claude.ai lists without marking it as yours gets the same link rules, though it isn't labelled shared.
- claude.ai's quick list can't be paged, so the export also pages through its full list (the one claude.ai/artifacts reads) and saves what the quick list missed, without a card picture; `errors.txt` counts them. When the full list can't be read, or has more than 100 pages of 100 entries (folders count too), `errors.txt` warns that the export may be incomplete; compare "Listed by claude.ai" with claude.ai/artifacts. Its version isn't listed, so Export Changes compares claude.ai's update time for it instead (one with none is included every time), and one claude.ai serves no version of gets "no published version".
- Only the current version is saved, not older ones. (Export All also keeps each older version a chat published.)
- Artifacts from **Cowork** and **Claude Code**, and those shared with you, come without claude.ai's checksums. Their files are saved unchecked: `artifact.json` marks them `verified: false` and the note says "files not checked against claude.ai's checksum". The same goes for a page a chat published, in its `artifact.json` (`published.json` in a single chat's ZIP).
- Folder names are long. On Windows, a deep folder plus a long title can pass the path length limit and the file is listed in `write-errors.txt`; pick a short folder such as `C:\takeout`.
- The old-archive tools read an artifacts export: `build_viewer.js` rebuilds its viewer and `merge_archives.js` can merge it into an archive (see [Combining archives](#combining-archives)). Exports made before v1.18 (the current version's files directly in the artifact folder) are read too.
- If every card is a plain tile, the picture download failed; the export is otherwise complete.

#### The artifacts viewer

Open `viewer.html` in Chrome from the folder (unzip a ZIP first; opened from inside a ZIP the viewer says so). It shows a grid like claude.ai/artifacts, newest first, with tabs All, **Yours** and **Shared with you**. A card opens that artifact's page (`#a=<id>` in the address, so the browser's Back works). Pages made of HTML or SVG run in a sandbox; Markdown and images are shown; React, Mermaid, Claude Docs, Design and other artifacts that need claude.ai show a details page with the saved files and a claude.ai link. A start file over 2 MB is "too large to show here", except your own image, which shows from its saved file. An export of a huge account keeps preview data for the first 256 MB only; the rest show their details page.

**Open file** opens a saved file in the browser. It is shown for your own artifacts, and for files of any artifact that are documents, images, audio, video, archives or plain data. A page shared with you, or one claude.ai doesn't mark as yours, has no Open file for anything but documents, images, media, archives and plain data files (HTML, SVG and XML among them), since it was written by someone else and could run from disk with full access to your files. The viewer previews it in the sandbox instead, which is no safer than the other previews: see below.

**Download** saves a file the viewer holds: the start file in the top bar, and each file in the details page's list. The viewer holds HTML, SVG, CSS, JavaScript and Markdown files and images up to 2 MB each (its preview data); other files, such as plain text, JSON or binaries, have Open file only, since a page opened from disk can't read them. The file is saved, not opened, so an HTML or SVG page doesn't run. **Download ZIP** downloads the ZIP the export wrote of the current version, all its files; it says "some files missing" when some couldn't be saved. It isn't there for a one-file artifact, or for archives exported before v1.19.

What to know about artifact previews:

- Everything the page needs must be one of its saved files. Relative `<script src>`, `<link href>` and `<img src>` are filled in from the saved files (SVG `<image>`, `<source srcset>` and CSS `url()` are not); anything else is not fetched, since the preview has no network. Scripts that `fetch` or load a web font or library find nothing.
- Links between an artifact's pages don't work: a preview can't navigate. Open the file from the Files list instead (your own artifacts).
- CSS inlined from a saved file keeps its own `url(...)` and `@import`, which are not resolved, so a stylesheet's background image or font may be missing. Scripts that `import` modules are not inlined either.
- `localStorage` and `sessionStorage` work inside the preview but live in memory only, and are gone when you leave the page. Nothing is shared with the viewer.
- Claude's own page code (Design and other typed artifacts) is not run offline. A **Design** artifact shows its canvas instead: every board from `project/canvas.json` at its place and with its title, the canvas's notes as text, all scaled to fit. Each board runs in its own sandboxed preview, made only while it is near the view. **Open alone** shows one board at its size, with **Back to the canvas**. A board built on claude.ai's templates (placeholders such as `{{count}}`) shows as saved and says "Uses claude.ai's templates; shown as saved"; one using uploaded images says "Images not in this export", since those aren't exported. A Design artifact with no `canvas.json` keeps the "needs claude.ai to run" page.
- A page claude.ai served with its own frame code at the top (`<!-- frame-runtime -->`, as a public page shared with you is) isn't labelled "needs claude.ai to run" for that code; the page's own scripts still decide. Exports made before v1.20 keep their label until their viewer is rebuilt with `build_viewer.js --force`, which judges the start file again for archives made with v1.18 or later.
- In Markdown, images with a relative path don't show, and math appears as TeX source, not typeset.
- WebRTC is removed from the previewed page. A frame the page creates gets it back, and Chrome's content policy doesn't cover it, so injected code could still send its own text out. As with chat previews, the viewer is not a security boundary for untrusted exports.
- The ZIP route builds everything in memory: with parts near the 256 MB budget it needs about twice that. Use Folder for a large account.

---

## Picking an export format

| You want… | Use |
|---|---|
| Something readable to skim later | **Markdown** |
| One file that's self-contained for sharing | **Embedded Markdown** or **ZIP** (depending on whether you need the artifact files separately) |
| To preserve everything — uploads, attachments, every artifact version, full chat history, the raw JSON for recovery | **ZIP** |
| To run analysis or import into another tool | **JSON** |
| To archive your whole account | **Mega-Zip** |
| To keep that archive current | **Mega-Zip exports: Only new or changed** in Settings, after the first Mega-Zip |

When in doubt: **ZIP**. It's the only format with the structured `errors.txt` report, the per-turn artifact snapshots, and `original.json` for full recovery.

---

## Inside a ZIP export

Unzip and you'll see something like this:

```
[Project-Name-project]_<conversation>_claude-chat.zip
├── README.md                       Table of contents for the archive
├── meta.md                         Stats: model, message counts, features used
├── prompts.md                      Every user prompt, with links to attachments
├── responses_text_only.md          Combined pure-text Claude responses
├── full_chat.md                    Full conversation with artifacts as code blocks
├── integrated_chat.md              Same, but markdown artifacts flow inline
├── integrated_chat.txt             Plain-text version
├── code_snippets.md                Every ``` code block found in the chat
├── links_and_sources.md            URLs + web search sources grouped by domain
├── errors.txt                      ★ Recovery instructions if anything didn't come through (only present if there are warnings)
├── original.json                   The raw API payload — the source of truth for recovery
├── viewer.html                     Offline viewer — see "Reading an export in the viewer" below
├── viewer-check.gif                1x1 image the viewer uses to tell if you unzipped
│
├── published/                      Pages Claude published on claude.ai (only if the chat published some; a single chat's ZIP only, Export All uses artifacts/)
│   └── <Title>_<id>/published.json, <version>/<files>
│
├── responses/
│   ├── 001_response-title_response.md          Pure text
│   └── 001_response-title_response.full.md     With thinking blocks and embedded artifacts
│
├── artefacts/
│   ├── document.md                 Single-write artifact
│   ├── booklet.html                Edited artifact's final state
│   ├── booklet_v1.html             ⎫
│   ├── booklet_v2.html             ⎬ Per-turn snapshots — see "Per-turn artifact versions" below
│   └── booklet_v3.html             ⎭
│
├── attachments/
│   ├── p01_pasted_notes.txt        Files you pasted into a prompt (prefix = prompt number)
│   └── p02_research.txt
│
├── project/                        Only present for Project conversations
│   ├── project.json                Project metadata
│   ├── prompt_template.md          The Project's system prompt
│   ├── docs.json                   List of project documents
│   └── research_notes.md           Each project doc as a file
│
└── uploads/
    ├── p01_diagram.png             Uploaded files (prefix = prompt number)
    └── p03_dataset.csv
```

### Reading an export in the viewer

Unzip the archive first, then open `viewer.html` in Chrome. Opening it from inside the ZIP won't work, because the previews need the files beside it; the viewer shows a notice if it can't find them. A mega-ZIP has one `viewer.html` at the root that covers every chat.

The viewer lists the chats, searches across them, and shows each message with its thinking, tool calls, artifacts, uploads and project files. Click a file to open it in the side panel, as a preview or as code.

The text of uploads, and of files Claude made, over 64 KB is in `viewer-files/` beside `viewer.html`, and loads when you open the upload or file. Keep that folder with the viewer. Search covers prompts, responses, pasted text and file names. Tick **Also search inside files** under the search box to look in the text of uploads and of files Claude made too: those results come after the chats, under "Inside files", and open the upload or file. Their text loads part by part as you search, so this is slower on a large archive; the choice is remembered in that browser. Results are grouped by chat, best match first. Words match in any order; use quotes for an exact phrase, `OR` (in capitals) for either word, and `-word` to leave a word out. Press `/` to jump to the search box, the arrow keys to move through results, and Escape or ✕ to clear. Opening a result shows a bar with “match 1 of N”: its arrows, or Enter and Shift+Enter, step through every occurrence in that chat.

Code blocks with a language label get syntax colors as they scroll into view, as do files in Code view and text uploads. Blocks with no label stay plain, as do blocks over 200 KB and any that take too long to color.

Next to the chat's model and date, **Open on claude.ai** opens the chat on claude.ai in a new tab. It may no longer exist there if you deleted it.

The Files button in a chat's top bar lists every file in that chat: Outputs, the files Claude shared with you, each once with its version count; Uploads, what you uploaded or pasted; and Working files, what Claude wrote along the way without sharing, such as helper scripts. A file shared on another branch of the chat is listed under Outputs too. Click one to open it; Tab out of the list or press Escape to close it.

Under each prompt and response is a Copy button. A prompt copies as you typed it, and a response copies the Markdown of its text, leaving out thinking, tool steps, file cards and citation markers. If the browser won't allow the copy, the button says "Copy failed". Popups and the file panel have a Copy button in their header for the whole file: it copies the file's text, and in Preview the source rather than the rendered page. Beside it, **Wrap** wraps long lines of a file's text; the viewer remembers it for all files, and **Download** saves the file under its name (a version under its own, such as `report_v2.html`). Download saves the text the viewer holds, so HTML and SVG are saved, not opened; a large upload gets the button once its text has loaded. Images, PDFs and other binary files have Open file instead. When a chat belongs to a project, the project section starts with the project's instructions, then lists its files.

What to know about previews of generated HTML:

- The file's scripts run in a sandbox, cut off from the viewer, from other chats and from files on disk.
- Normal web requests from the preview are blocked.
- The browser doesn't let the viewer block every route. A generated file that contains injected code could still send out its own text, and the `.js` and `.css` files from that chat, when you preview it. WebRTC is one such route: Chrome's content policy doesn't cover it. The artifacts viewer removes WebRTC from the previewed page itself, but a frame the page creates gets it back.
- So the viewer is not a security boundary for untrusted exports. Be careful previewing files from someone else's export. Your own exports of your own chats are the intended use.

A viewer stays the version it was made with. To get later viewer fixes in an existing export, see [Updating a viewer](#updating-a-viewer).

If `viewer.html` couldn't be built at all, the export still downloads and the status line says "viewer.html could not be built." If only some chats couldn't be added to it, `errors.txt` lists them under a `viewer` warning. The Markdown files are unaffected either way.

### Per-turn artifact versions

When Claude creates an artifact and then edits it multiple times (`create_file` followed by `str_replace`s), the export captures **every intermediate state**, not just the final one:

- `<name>_v1<ext>` — what the artifact looked like after the assistant's first turn that touched it.
- `<name>_v2<ext>` — same, after the second turn.
- `<name>_vN<ext>` — and so on.
- `<name><ext>` (unversioned) — the **final state**, byte-identical to the highest `_vN`.

If an artifact was created once and never edited, only `<name><ext>` exists. No `_v1` clutter.

This is useful when you want the conversation's "before" snapshot of a refactor, an early draft of a document, or the original of a long iterative edit.

### `original.json` is the source of truth

Everything else in the export is derived from `original.json`. If something looks wrong in a generated file, `original.json` has the unmodified API payload — use it to verify what Claude actually produced.

---

## Reading `errors.txt`

`errors.txt` only appears in the export when something didn't come through cleanly. It's a structured Markdown report with three sections: **Summary**, **Errors**, **Warnings**, and a **Troubleshooting Guide** at the bottom.

Each entry includes:
- The filename or artifact affected
- The warning type
- A human-readable explanation
- A **Recovery** hint with the exact command (or steps) to fix it

### Warning types you might see

| Type | Means | What to do |
|---|---|---|
| `upload` | An uploaded file failed to download. Could be expired, session timeout, etc. | Re-export with a fresh session. The HTTP status and the URLs tried are in the entry. |
| `delivered_file` | A file Claude sent you (`SendUserFile`) could not be downloaded. | Open the chat on claude.ai and download it there; export again later. |
| `presented_file` | A file Claude created via bash/Python and showed you couldn't be retrieved. | Often recoverable from `original.json`'s `tool_result` blocks. |
| `project_doc` | A document attached to the Claude Project couldn't be fetched. | Verify project access, re-export. |
| `project_metadata` | Project metadata fetch failed. `project.json` may be incomplete. | Re-export when the Project endpoint works. |
| `str_replace_failed` | A `str_replace` edit couldn't be applied to an artifact during reconstruction (the `old_str` didn't appear or appeared multiple times). | Usually mirrors what happened in Claude's actual sandbox — no action needed unless `original.json` shows the tool succeeded but the warning fired anyway. |
| `artifact_basename_collision` | Two distinct artifact paths produced files with the same basename. The second was renamed to avoid overwriting. | Inspect both source paths to confirm they were intentionally distinct files. |
| `tool_image` | A picture Claude looked at in the chat (a photo it opened, a page it rendered) could not be downloaded from claude.ai. | Export again later; the picture still shows in the chat on claude.ai. |
| `web_image` | An image Claude found with image search was not saved: Claude Takeout may not fetch images from other sites, or the site refused it. | Turn on Settings > Save web images and artifact card pictures (Chrome asks once), then export again. The links in `full_chat.md` still point to the images. |
| `doc_diagram` | A Claude Docs document has diagrams, which claude.ai draws only on the document's page, and the chat has no self-contained HTML copy of the document. | Ask Claude in the chat to export the document as a self-contained HTML file, then export the chat again; the copy is saved in `artefacts/` and linked from the document. Or open the live document from the link in the note. |
| `claude_doc_unreplayed` | Claude edited a Claude Docs document in a way the export can't rebuild from the chat. | The exported `.md` and `.html` hold what could be rebuilt. Open the live document from the link in the note for the current version. |
| `published_page` | A page Claude published on claude.ai could not be saved, or only partly: no claude.ai tab open, signed out (one warning per export), the page no longer there, a file too large (over 32 MB, or 50 MB for one version), a checksum that didn't match, or a path renamed to be safe. | Open claude.ai in a tab, sign in, and export again. The page is still on claude.ai: the entry links it. |
| `artifact_export` | Export Artifacts could not save everything: signed out (one warning, then it stops fetching), an artifact or file gone, too large (over 32 MB a file, 50 MB an artifact), a checksum mismatch, a renamed path, or a list that could not be read in full (also a count of artifacts found only by paging). | Open claude.ai, sign in, export again. Each entry links the artifact on claude.ai. |
| `viewer` | A chat couldn't be added to `viewer.html`. (If the whole viewer fails, only the status line says so.) | Nothing is lost: the chat data is all in the export and only the viewer is missing or incomplete. Use the Markdown files, or re-export. |
| `artifact_opaque_mutation` | A `bash_tool` command mutated an artifact in a way the extension can't reconstruct (Python heredoc, sed, awk, multi-step pipeline, etc.). | **Run `replay_bash.py`** — see next section. |
| `export_health` | claude.ai's data for the chat looks incomplete: no messages although the chat was used, messages with no content, no current branch, content the exporter doesn't show yet, or several uploads that all failed. Usually a sign that claude.ai's API changed. | Check the chat on claude.ai. `original.json` has everything that came back. If it repeats, report it so the exporter can be updated. |

In `viewer.html`, a file with an `artifact_opaque_mutation`, `str_replace_failed` or `claude_doc_unreplayed` warning carries a **May not match** badge on its card and in the Files list, and the file panel explains why. Older exports get the badges when their viewer is rebuilt with `node tools/build_viewer.js <folder> --force`, which reads them from `errors.txt`.

### Published pages

A page Claude published on claude.ai (with `publish_files` or the `Artifact` tool) is saved in `published/<Title>_<id>/`, one folder per version, with `published.json` listing the files. A version identical to a file in `artefacts/` is not copied again (`published.json` says `same`). The export needs a claude.ai tab open and signed in to fetch them, and an export made earlier has no `published/` folder until you export again.

In Export All the same pages are saved in the shared `artifacts/<Title>_<id>/<version>/` instead, and `published.json`'s content moves into `artifact.json` (`versions`, each with its files, `publishedIn`, `incomplete` and, for a version identical to a chat's file, `sameAs`). The chat READMEs and `full_chat.md` link there. Every page a chat published gets a folder, also one claude.ai no longer lists and one exported with **Include artifacts in Export All** off. `artifacts/index.html` and `index.md` list those under "Published from chats, not in claude.ai's list", the root `index.md` says "Published from chats only: N", and a row whose version could not be saved whole says "some versions not saved (see the chats' errors.txt)". The viewer shows such pages on their chats' cards but not under All, Yours or Shared with you, which say "claude.ai's list isn't in this export" when the list wasn't fetched (setting off, or an archive made only from older exports). Limits to know:

- "Current" is the live version fetched when an older chat has no recorded version. It is not necessarily what was published at that time.
- The viewer previews a page's start file. A multi-file page's own scripts and styles may not load in the sandboxed preview, and the side panel shows only the start file.
- A page built on claude.ai's own page code shows its source and "Needs claude.ai to run"; it won't run offline.
- Merging archives rewrites the links in the merged chats to the new `artifacts/` folder, so they keep working. In a single chat's ZIP, a page's folder can be renamed once claude.ai gives the title, before anything is written.

The Troubleshooting Guide at the bottom of `errors.txt` includes a copy-paste-ready `python3 replay_bash.py` command pointing at the export folder.

---

## Companion CLIs

Two stdlib-only Python 3 scripts ship next to the extension, in the same folder. A Node tool for older archives, `tools/build_viewer.js`, is described at the end of this section.

### `extract_artifacts.py`

Reconstructs every artifact version (the `_v1`, `_v2`, … `_vN` and unversioned final) from a conversation's `original.json` — purely declarative replay, no bash execution.

**When to use it:**
- You only have `original.json` and need the artifacts (e.g. somebody sent you the JSON, not the ZIP).
- You want to verify the extension's artifact output is correct (`diff -r` the result against the export's `artefacts/`).
- You want to extract artifacts on a machine where you can't load the Chrome extension.

**Usage:**
```bash
# Default: writes to ./artefacts/ next to the input file
python3 extract_artifacts.py path/to/original.json

# Custom output directory
python3 extract_artifacts.py path/to/original.json -o /tmp/expected/

# Show what would be written without writing
python3 extract_artifacts.py path/to/original.json --list

# Capture warnings to a file
python3 extract_artifacts.py path/to/original.json --errors errors.txt
```

### `replay_bash.py`

The recovery tool. Replays every `bash_tool` and `Bash` command from a conversation's `original.json` in a tmpdir, so artifacts that Claude mutated via bash/Python scripts get reconstructed.

**This runs code from a conversation, so treat it as untrusted.** Commands can include anything Claude was led to write, including text from a web page it read. Read them with `--dry-run` first.

**When to use it:**
- `errors.txt` shows `artifact_opaque_mutation` warnings.
- An exported artifact is incomplete (e.g. an HTML file is missing the base64-embedded image Claude inlined via Python).
- The "Recovery" hint in `errors.txt` says to run it.

**Usage:**
```bash
# Per-command confirmation (y/n/A/s/q for show-full/quit) — safest mode
python3 replay_bash.py /path/to/export-folder

# Skip prompts, run every command in the OS sandbox
python3 replay_bash.py /path/to/export-folder --all

# Show every command without running anything
python3 replay_bash.py /path/to/export-folder --dry-run

# Replay in sandbox but don't sync changes back to the export
python3 replay_bash.py /path/to/export-folder --no-write

# Set a per-command timeout (default: 30s)
python3 replay_bash.py /path/to/export-folder --timeout 60

# Minimal output
python3 replay_bash.py /path/to/export-folder --all --quiet

# No OS sandbox: full permissions and network, every command prompted
python3 replay_bash.py /path/to/export-folder --no-isolation
```

**What protects you:**

| Protection | macOS | Elsewhere |
|---|---|---|
| OS sandbox (`sandbox-exec`, deny by default) | Yes | No. The tool refuses to run without `--no-isolation` |
| No network, clipboard or launching other apps | Yes | No |
| Writes only inside the tmpdir | Yes | No |
| No reads from home, other temp directories or external volumes | Yes | No |
| Minimal environment, so your tokens aren't passed to commands | Yes | Yes |
| Conversation paths can't escape the tmpdir (`..`, symlinks) | Yes | Yes |
| Originals saved to `artefacts_before_replay/` before any overwrite | Yes | Yes |
| Per-command prompt, default `n`, and a 30-second timeout | Yes | Yes |

`/home/claude`, `/mnt/user-data`, `/tmp` and `/root/.claude` are rewritten into the tmpdir, and `~` points there too.

**What it doesn't protect against:**
- **Bad output.** A command's result still lands in `artefacts/`, so an exported HTML file could contain anything. Check it before opening it.
- **CPU, memory and disk use** inside the tmpdir, apart from the timeout.
- **`sandbox-exec` itself.** Apple has deprecated it, though it still works. Treat it as a strong layer, not a guarantee.
- **`--no-isolation`.** Commands run as you, with your files and network. It can't be combined with `--all`.

**If commands fail:** failures don't stop the chain. Scripts can fail here because a package isn't installed, or because they used paths that only exist on Claude's side, such as `/mnt/skills`. When that happens the result may be wrong or worse than the original, so the tool warns you. Compare against `artefacts_before_replay/` before keeping it.

**What the output tells you:**
```
[1/15] msg 1, block 4 — Create working directory
  $ mkdir -p /home/claude/booklet && echo "created"
  ✓ created
...
============================================================
Commands ran:    15
Commands skipped:0
Commands failed: 0

Updated 1 artifact(s):
  karajan-opera-booklet.html: 34,868 → 161,135 chars + karajan-opera-booklet_v3.html
```

The summary at the end tells you exactly which artifacts changed and what their new sizes are. Both the unversioned file and the highest `_vN` snapshot get rewritten so they stay in sync.

For the why and the alternatives we considered, see `docs/WASM_REPLAY_APPROACH.md`.

### Adding a viewer to older archives

Exports made before v1.6 have no `viewer.html`. `tools/build_viewer.js` adds one to each. It needs Node 20+ and nothing else.

```bash
# Look first: nothing is written
node tools/build_viewer.js ~/Downloads/old-exports --dry-run

# Folders only
node tools/build_viewer.js ~/Downloads/old-exports

# A folder with ZIPs in it: --out is required
node tools/build_viewer.js ~/Downloads/old-exports --out ~/Downloads/old-exports-viewed

# Machine-readable report
node tools/build_viewer.js ~/Downloads/old-exports --json
```

Flags: `--out <folder>`, `--force`, `--dry-run`, `--json`. The exit code is 0 when everything worked and 1 if anything failed.

The tool finds every Claude export under the folder, single-chat or mega, by looking for `original.json`, so folder names don't matter. For each archive it writes only `viewer.html`, `viewer-check.gif` and a `viewer-files/` folder beside the chats. Nothing else in the archive changes. Open `viewer.html` in Chrome, as described in [Reading an export in the viewer](#reading-an-export-in-the-viewer).

Things to know:

- **ZIPs.** A ZIP is never changed. It is extracted into a new folder under `--out` (through a hidden `.<name>.partial` folder while it runs), and the viewer is built there. A ZIP in which two entries end up with the same name is refused. `--out` can't be inside an archive or be the folder you scanned. A ZIP whose destination already exists is skipped; run the tool on that folder instead.
- **Rerunning.** An archive that already has a `viewer.html` is skipped. `--force` replaces a viewer made by this tool or by the extension. It never replaces a `viewer.html` or `viewer-files/` that neither made: that archive is reported as failed and nothing is overwritten.
- **Your own files.** Folders and files you added to an archive, such as `synthesis/` or `_index.md`, appear in the viewer under "Archive files". Text opens in place. Other files get an Open file link only if their type is listed under Open file below, so HTML gets none, and a text file too big to show in place gets one only if its type is listed. Files and folders whose names start with a dot are not listed, nor is anything inside the export's own folders (`artefacts/`, `uploads/`, `images/`, `attachments/`, `responses/`, `project/`, `projects/`, `viewer-files/`) or with an export file's name, such as `README.md` or `meta.md`. A folder that is a link to somewhere else is never read.
- **Missing files.** Generated files are rebuilt from `original.json`, so they work even if the file is gone from `artefacts/`. Uploads and binaries need the real file. Anything not found is listed under Missing files in the report. The tool doesn't search for them.
- **Size.** An archive with a lot of large uploaded text makes a large `viewer.html`. A real 24-chat archive came to 97 MB and opened in about 3 seconds.
- **Skipped.** Gemini and other non-Claude exports are skipped and listed in the report, as is anything that has no Claude chat in it.
- **Previews.** Added HTML and SVG get the same sandboxed preview as generated files, with the same limits listed under [Reading an export in the viewer](#reading-an-export-in-the-viewer). Be as careful with them as with files from someone else's export.
- **Sibling files.** Pages added to an archive don't load their sibling files in the preview, so a page that links its own `.css`, `.js` or images shows without them.
- **Open file.** The link appears only for documents, images, audio, video, archives and plain data files such as PDF, DOCX, PNG, MP4, ZIP, CSV and JSON. Other types, including HTML, can be previewed but not opened from the link.

### Updating a viewer

A `viewer.html` stays the version it was made with. When a newer release improves the viewer, such as syntax colors, Copy buttons or smaller files, exports you already have don't change. To bring one up to date, rebuild its viewer with the same tool:

```bash
# See what would be replaced: nothing is written
node tools/build_viewer.js ~/Downloads/claude-takeout-2026-11-07 --force --dry-run

# Replace it
node tools/build_viewer.js ~/Downloads/claude-takeout-2026-11-07 --force
```

- **What it works on.** A single-chat export, a mega-ZIP or a folder holding many of either, as long as they are unzipped. For ZIPs, see [Adding a viewer to older archives](#adding-a-viewer-to-older-archives): they are extracted under `--out` first.
- **What it changes.** Only `viewer.html`, `viewer-check.gif` and `viewer-files/`. Your chat files, Markdown, downloads and anything you added stay as they are.
- **Archives with artifacts.** It reads every layout: chat archives with `published/` (before 1.17), 1.17 archives (`published/` beside `artifacts/`), 1.18 archives (`artifacts/` only) and a standalone Export Artifacts export (no chats), and builds the Artifacts screen from what is on disk. It doesn't convert the layout (merging does that). An archive that already has a viewer is still skipped without `--force`. Paths named in `artifact.json` or `published.json` are followed only through real folders, never through a link.
- **What it can't change.** The rebuilt viewer reads what the export already has on disk. Fixes to the export itself, such as a better Markdown file or a download that used to fail, need a fresh export from claude.ai.
- **Which releases.** The changelog in `README.md` says "Older exports get this when their viewer is rebuilt with `--force`" on each viewer change.

### Combining archives

If you back up with **Mega-Zip exports: Only new or changed**, you end up with one full archive and several smaller change archives. `tools/merge_archives.js` combines them into one new archive with one viewer, taking each chat once, from its newest copy:

```bash
# See what it would do: nothing is written
node tools/merge_archives.js ~/Downloads/claude-takeout-Mika-2026-11-01.zip ~/Downloads/claude-takeout-Mika-changes-2026-11-08.zip --out ~/Takeout --dry-run

# Write ~/Takeout/claude-takeout-merged-<today>
node tools/merge_archives.js ~/Downloads/claude-takeout-Mika-2026-11-01.zip ~/Downloads/claude-takeout-Mika-changes-2026-11-08.zip --out ~/Takeout
```

- **Sources.** Any number of Mega-Zips, single-chat exports, or folders holding them, as ZIPs or unzipped. ZIPs are extracted into a hidden temporary folder under `--out` and removed afterwards.
- **Which copy wins.** The one with the latest `updated_at` in its `original.json`. On a tie, the later export (from `export-manifest.json`), then the source named later. Shared project folders come from the newest source.
- **What it writes.** One new folder under `--out` (`claude-takeout-merged-<date>`, or `--name <name>`), built under a hidden temporary name and renamed when complete. It holds the chat folders, `projects/`, a new `index.md`, an `export-manifest.json` with `kind: "merged"` that names the source of each chat, and a new viewer. Your source archives are only read. An existing folder of that name stops the run.
- **Archives with artifacts.** Sources may be any mix of the layouts above, including archives with only artifacts (Export Artifacts, or an Export Changes made with no changed chat). The result always has the Export All shape: one `artifacts/` store (`<Title>_<id>/artifact.json` format 2 and a folder per version), `artifacts/index.html` and `index.md`, a root `index.md`, and an `export-manifest.json` with `kind: "merged"`. The rules:
  - **Versions.** Every version from every source is kept. A version in several sources comes whole from the newest source (by `exported_at`) whose copy is complete, never file by file; `publishedIn` lists are joined.
  - **`listed`.** The newest full source whose artifact step ran decides: an artifact it doesn't list is marked not listed, since it was deleted on claude.ai. A newer Export Changes that lists an artifact wins over it: the artifact is listed, and its current version, title and card come from that export. A changes archive never unlists an artifact. Sources are ranked by when claude.ai's list was taken, not when the archive was made: an earlier merge (from v1.20.6) records that in its manifest and decides and lists by it, so merging it with an older export never moves an artifact back. A merge made before v1.20.6 neither decides nor lists. With no full source, the newest source that lists the artifact wins, else the newest source's values stay.
  - **Same as a chat's file.** A version saved only as a pointer to a chat's file is re-pointed at the merged chat's copy when the bytes match (SHA-256); otherwise the bytes are copied into the version folder, preferring a real folder from an older source. A pointer version is also copied when any merged chat published it as not the same.
  - **Single-chat `published/`.** A single-chat export's `published/` is folded into the store. A `published/` folder merge can't read (no `published.json`) is kept as it is, at `published/<folder>`.
  - **Links.** In `README.md`, `full_chat.md`, `integrated_chat.md` and `responses/*.md` of the written chats, links into `published/` are rewritten to the new place, only in the copies; links inside code blocks are left alone. A link it can't map is listed in the report, and a broken one is also a warning.
  - **Notes and warnings.** An artifact's note follows what the merged archive holds: "not exported" or "not saved" is dropped when the merged current version is complete (in a folder or as a chat's own file), and the artifact stops counting as incomplete when that was the only reason. The sources' artifact warnings are collected in `artifacts/errors.txt`, one section per source.
  - **Failures.** A file that can't be copied fails the merge (exit code 1); the result is not renamed into place. A source ZIP entry that can't be extracted (an unsafe name, or two names that differ only in case) also ends with exit code 1, though the merged archive is written; the report's second line says why.
  - **Card pictures** come from the source the artifact's listing came from, else the newest source that has one.
  - **ZIPs.** The current version's `<version>.zip` is copied from the source whose folder the merged version came from, or else from another source whose folder holds the same files and is as complete; an older version's ZIP isn't kept, and a file that isn't a ZIP is left out with a warning. The tool never builds a ZIP itself.
- **Deleted chats.** A chat you deleted on claude.ai stays in the merged archive if an older source has it.

---

## Common workflows

### "I just want a clean export, no fiddling"

```
1. Export as Zip
2. Look at errors.txt if it exists
3. If it mentions artifact_opaque_mutation: run replay_bash.py
4. Done
```

### "I want to verify an export is complete"

```bash
# Compare the extension's output against the declarative replay
python3 extract_artifacts.py path/to/export/original.json -o /tmp/expected/
diff -r /tmp/expected/ path/to/export/artefacts/
```

Differences here mean either (a) the extension's `extractArtifacts` and the Python port diverged (file a bug), or (b) `replay_bash.py` was run against the export and changed an artifact that the Python tool wouldn't have touched.

### "I have a conversation in a different folder format"

`replay_bash.py` and `extract_artifacts.py` only need `original.json` plus (for `replay_bash.py`) an `artefacts/` folder. Both expect Claude Takeout's standard layout. If you have a custom export, you can still use `extract_artifacts.py` on just the JSON.

### "I want to see what would happen before committing"

Both CLIs have `--dry-run`. Use it.

### "An export is missing an image embedded in HTML"

This is the canonical `replay_bash.py` case. Run it. If the image was uploaded to Claude and Claude embedded it via a Python `base64.b64encode(...)` script, this is exactly what `replay_bash.py` handles.

### "I want to archive my whole Claude history"

Use **Export All (Mega-Zip)**. After download, optionally run `replay_bash.py` on each conversation folder that has an `artifact_opaque_mutation` warning. This loop prompts for each command, so you review what runs:

```bash
unzip claude-takeout-2026-06-06.zip -d takeout/
for folder in takeout/*/; do
  if grep -q artifact_opaque_mutation "$folder/errors.txt" 2>/dev/null; then
    python3 /path/to/claude-takeout/replay_bash.py "$folder"
  fi
done
```

Avoid `--all` across a whole archive: you'd be running every command from every conversation unread.

To keep that archive current without downloading everything again, set **Mega-Zip exports** to **Only new or changed**, export now and then, and combine the archives with [`tools/merge_archives.js`](#combining-archives).

#### The combined viewer

An Export All with artifacts has one `viewer.html`, with an Artifacts screen beside the chats. Its tabs are **All**, **Yours**, **Shared with you** and **In chats**. In chats lists the files Claude made inside your chats (files, diagrams, documents), each with the chat it came from and its versions. A chat links to the artifacts it made or published, and an artifact page links back to those chats.

Previews follow the same rules as in the artifacts viewer above, with two additions. Artifact and In chats previews run inside a guard frame that blocks navigation, so a page can't send the preview to a file on disk. An In chats preview sees only its own chat's files.

The Artifacts entry shows for any export with an artifact folder or any file Claude made in a chat. An archive built from older exports, or one made with **Include artifacts in Export All** off, has no claude.ai list, so All, Yours and Shared with you say "claude.ai's list isn't in this export" and only In chats and the chats' cards show artifacts. The old-archive tools can give older archives this screen (see [Adding a viewer to older archives](#adding-a-viewer-to-older-archives)).

---

## Settings and keyboard shortcuts

Click the gear icon in the popup to open the settings drawer.

| Setting | What it does |
|---|---|
| **Filename style** | `title`, `title_date`, or `date_title`. Applies to single-chat Markdown, Embedded Markdown and JSON downloads. ZIPs and bulk exports keep their own names. |
| **Include thinking blocks** | Whether to include Claude's `<thinking>` content in the Markdown exports and in a ZIP's `full_chat.md` and `integrated_chat.md`. The `responses/*.full.md` files always include it. |
| **Export All and Export Artifacts save as** | **Folder** (the default) or **ZIP**: whether Export All and Export Artifacts write into a folder you choose or download one ZIP. |
| **Export All exports** | **All chats** (the default) or **Only new or changed**: what Export All exports. With **Only new or changed**, it takes only the chats that are new or changed since the last mega-ZIP from this browser, and the button reads **Export Changes (Mega-Zip)**. |
| **Include artifacts in Export All** | On by default. Export All also saves claude.ai's artifacts into `artifacts/`. Off: chats only, as before. |
| **Show shortcuts** | Show keyboard shortcut hints next to buttons. |
| **Open as sidebar by default** | Use Chrome's side panel instead of the popup, so the export UI stays open while you browse conversations. |

### Keyboard shortcuts

(While the popup or sidebar is open and focused.)

| Key | Action |
|---|---|
| `Alt+M` | Export current conversation as Markdown |
| `Alt+E` | Export current conversation as Embedded Markdown |
| `Alt+Z` | Export current conversation as ZIP |
| `Alt+J` | Export current conversation as JSON |
| `Alt+A` | Export all conversations as Markdown |
| `Alt+R` | Refresh the active claude.ai tab |

Optional: assign a system-wide shortcut to open the extension at `chrome://extensions/shortcuts`.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Popup says **"Sign in to claude.ai and open a chat"** | The extension couldn't find your organization. Sign in and open a chat. |
| Popup says **"Open a chat to export it"** | You're on claude.ai but not in a specific conversation. Click into a chat first. Export All still works. |
| Export buttons all greyed out | The selected chat is loading or couldn't be loaded, or you're not on a chat page. The status message says which. |
| Bulk export feels slow | A ~300 ms gap between conversations is intentional rate-limit hygiene. 100 conversations ≈ 30 seconds. |
| Some conversations failed in bulk export | Common: deleted conversations, network blips. Re-run; the failures are listed at the end. |
| ZIP file is enormous | Likely an artifact has the image data embedded as base64 (often after running `replay_bash.py`). This is expected — the artifact is self-contained HTML. |
| Exported HTML doesn't render properly | Open `errors.txt`. If it mentions `artifact_opaque_mutation`, run `replay_bash.py`. |
| `replay_bash.py` says "command not found" | You're running it from the wrong directory or without `python3`. Use the full path: `python3 /path/to/claude-takeout/replay_bash.py <export>`. |
| `replay_bash.py` reports a failed script | If the script needs a non-stdlib Python package, install it (`pip install lxml` etc.) and re-run. Failures of *verification* scripts (Claude's own self-checks) are usually harmless — the artifact still reconstructs correctly. |
| Side panel mode doesn't work | Requires Chrome 114+. Older Chrome falls back to the popup. |

---

## Getting help

- Browser console for the extension (open `chrome://extensions/`, click "service worker" or "Inspect views").
- The `errors.txt` Troubleshooting Guide for upload/project failures.
- `docs/WASM_REPLAY_APPROACH.md` for why we recommend `replay_bash.py` over alternatives.
- `CLAUDE.md` for developer-facing architecture and conventions.

If a conversation can't be reconstructed cleanly even after running `replay_bash.py`, `original.json` has every bit Claude returned. Manual recovery is always possible from there.
