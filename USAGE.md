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
| **Export All (Mega-Zip)** | A single `claude-takeout-<YYYY-MM-DD>.zip` containing one folder per conversation (full ZIP structure each), plus an `index.md` master table at the root. |
| **Export All (JSON)** | One `.json` per conversation. |

Progress shows below the buttons as `X / Y`. There's a 200–300 ms pause between conversations to be polite to Claude's API. 100 conversations takes about 30 seconds; 1000 will take under 10 minutes.

If a single conversation fails (deleted, server hiccup, rate limit), the bulk export continues with the rest and reports the failures at the end.

---

## Picking an export format

| You want… | Use |
|---|---|
| Something readable to skim later | **Markdown** |
| One file that's self-contained for sharing | **Embedded Markdown** or **ZIP** (depending on whether you need the artifact files separately) |
| To preserve everything — uploads, attachments, every artifact version, full chat history, the raw JSON for recovery | **ZIP** |
| To run analysis or import into another tool | **JSON** |
| To archive your whole account | **Mega-Zip** |

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

Under each prompt and response is a Copy button. A prompt copies as you typed it, and a response copies the Markdown of its text, leaving out thinking, tool steps, file cards and citation markers. If the browser won't allow the copy, the button says "Copy failed". When a chat belongs to a project, the project section starts with the project's instructions, then lists its files.

What to know about previews of generated HTML:

- The file's scripts run in a sandbox, cut off from the viewer, from other chats and from files on disk.
- Normal web requests from the preview are blocked.
- The browser doesn't let the viewer block every route. A generated file that contains injected code could still send out its own text, and the `.js` and `.css` files from that chat, when you preview it.
- So the viewer is not a security boundary for untrusted exports. Be careful previewing files from someone else's export. Your own exports of your own chats are the intended use.

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
| `presented_file` | A file Claude created via bash/Python and showed you couldn't be retrieved. | Often recoverable from `original.json`'s `tool_result` blocks. |
| `project_doc` | A document attached to the Claude Project couldn't be fetched. | Verify project access, re-export. |
| `project_metadata` | Project metadata fetch failed. `project.json` may be incomplete. | Re-export when the Project endpoint works. |
| `str_replace_failed` | A `str_replace` edit couldn't be applied to an artifact during reconstruction (the `old_str` didn't appear or appeared multiple times). | Usually mirrors what happened in Claude's actual sandbox — no action needed unless `original.json` shows the tool succeeded but the warning fired anyway. |
| `artifact_basename_collision` | Two distinct artifact paths produced files with the same basename. The second was renamed to avoid overwriting. | Inspect both source paths to confirm they were intentionally distinct files. |
| `viewer` | A chat couldn't be added to `viewer.html`. (If the whole viewer fails, only the status line says so.) | Nothing is lost: the chat data is all in the export and only the viewer is missing or incomplete. Use the Markdown files, or re-export. |
| `artifact_opaque_mutation` | A `bash_tool` command mutated an artifact in a way the extension can't reconstruct (Python heredoc, sed, awk, multi-step pipeline, etc.). | **Run `replay_bash.py`** — see next section. |

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

- **ZIPs.** A ZIP is never changed. It is extracted into a new folder under `--out`, and the viewer is built there. `--out` can't be inside an archive or be the folder you scanned. A ZIP whose destination already exists is skipped; run the tool on that folder instead.
- **Rerunning.** An archive that already has a `viewer.html` is skipped. `--force` replaces a viewer made by this tool or by the extension. It never replaces a `viewer.html` or `viewer-files/` that neither made: that archive is reported as failed and nothing is overwritten.
- **Your own files.** Folders and files you added to an archive, such as `synthesis/` or `_index.md`, appear in the viewer under "Archive files". Text opens in place and other files get a link.
- **Missing files.** Generated files are rebuilt from `original.json`, so they work even if the file is gone from `artefacts/`. Uploads and binaries need the real file. Anything not found, including expected files not found, is listed in the report. The tool doesn't search for them.
- **Size.** An archive with a lot of large uploaded text makes a large `viewer.html`. A real 24-chat archive came to 97 MB and opened in about 3 seconds.
- **Skipped.** Gemini and other non-Claude exports are skipped and listed in the report, as is anything that has no Claude chat in it.
- **Previews.** Added HTML and SVG get the same sandboxed preview as generated files, with the same limits listed under [Reading an export in the viewer](#reading-an-export-in-the-viewer). Be as careful with them as with files from someone else's export.
- **Sibling files.** Pages added to an archive don't load their sibling files in the preview, so a page that links its own `.css`, `.js` or images shows without them.
- **Open file.** The link appears only for documents, images, audio, video, archives and plain data files such as PDF, DOCX, PNG, MP4, ZIP, CSV and JSON. Other types, including HTML, can be previewed but not opened from the link.

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

---

## Settings and keyboard shortcuts

Click the gear icon in the popup to open the settings drawer.

| Setting | What it does |
|---|---|
| **Filename style** | `title`, `title_date`, or `date_title`. Affects all download filenames. |
| **Include thinking blocks** | Whether to include Claude's `<thinking>` content in markdown exports. |
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
