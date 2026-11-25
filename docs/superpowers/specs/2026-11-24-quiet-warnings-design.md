# v1.22.1: warnings that mean something is missing

Date: 2026-11-24. Builds on v1.22.0 (the panel redesign, branch `panel-redesign`).

## Why

The owner's real Export All (2026-11-24 16:15, 27 chats) ended "Done, with 32 warnings". A read of every warning against the chats' data found that only 4 of them mean the owner is missing anything:

| Warnings | Type | What is really the case |
|---|---|---|
| 19 in 5 chats | `artifact_opaque_mutation` | A bash command changed a draft or a helper script. In every case but one, Claude then delivered the finished file from the same folder, and the export holds it. One warning is stale: the file was presented afterwards and the export downloaded it. 5 more are literal text swaps the export could have replayed. |
| 4 | `artifact_basename_collision` | Two different files shared a name; one was renamed `_2`. Nothing is wrong. |
| 3 | `export_health` | claude.ai adds an empty assistant message about 60 ms after a complete one. The check counts it as hollow. |
| 2 | `doc_diagram` | The Claude Docs diagrams are not lost: Claude took a screenshot of each one, and the export already saved it in `images/`. The rebuilt document just doesn't show it. |
| 4 | `web_image` | Sites refused the image (2× 403, 2× 404). Really missing, and nothing can be done about it. |

A warning should mean "you are missing something". Today it often means "something happened the export can't follow", which turns most real exports amber. After a few exports the owner learns to ignore the amber, and then misses the warning that matters. A second harm: stale drafts sit in `artefacts/` beside the delivered finals with nothing saying which is which (`de-luce-reader.html` beside `Grosseteste_De_luce_reader.html`).

Success: the same export, re-run with v1.22.1, says "Done, with 4 warnings", all of them web images. Nothing the export saves today is dropped.

## Goals

1. Recover what can be recovered safely: literal text swaps done with `sed -i`, `cat >>`, and simple Python read/replace/write scripts.
2. Turn the warnings that don't mean a loss into notes: shown in the chat's README and the viewer, not counted, not amber.
3. Keep a warning wherever a loss is likely.
4. Name the right file in every warning and note, once per file.
5. Embed the Claude Docs diagram screenshots the export already has.
6. Stop the empty-tail messages from tripping `export_health`.

## Non-goals

- Running bash or Python in the extension (decided 2026-06-05, `docs/WASM_REPLAY_APPROACH.md`; unchanged).
- Fetching files from a still-live sandbox through claude.ai's `wiggle/download-file`. It works only minutes to hours after a chat, and it needs its own design. Backlog.
- Changing what `replay_bash.py` does, except where item 1 makes it apply an edit twice (see "For the builder").
- Changing the web-image download itself.

## Anti-goals

- **A note where a file is really missing.** Every rule that turns a warning into a note must be one where the finished file is in the export or the changed file was never meant for the user. When unsure, warn.
- **Replay that guesses.** A text swap is replayed only when the whole command is one of the exact shapes below. Anything else in the command leaves it opaque.
- **Fewer warnings by hiding them.** Notes stay in the export and are visible: in the README, in the viewer, and in `errors.txt` under their own heading.

## The design

### 1. Notes: a third kind of entry

`ExportErrorCollector` gains `addNote(type, filename, message, details)` and `notes`. Notes:

- are not counted in `warnings`, `warningList`, the Done screen's headline or the footer, and don't turn the status amber;
- are written in the chat's `README.md` under a section **"About some files"**, one line per file, grouped by kind;
- are written in `errors.txt` under `## Notes` (after Warnings), so one file still lists everything. An export with notes only still gets an `errors.txt`;
- reach the viewer: `viewerFlags` takes notes too. A file with a draft note gets the flag `draft` ("Draft: not the file Claude delivered"); a helper script gets `helper` ("Helper script Claude ran"). A file with a warning keeps its warning flag, which wins over a note's.

Note types: `draft_superseded`, `helper_script`, `name_changed`. Each has a hint in a new `_getNoteHint`, the same pattern as `_getRecoveryHint`.

### 2. Opaque mutations: one entry per file, the right file, then sorted

**Attribution.** `detectOpaqueMutations` resolves a relative path against the command's working directory. The directory comes from a leading `cd <absolute dir> &&` or `cd <dir>;` in the same command. Without one, it is the last `cd <absolute dir>` seen in an earlier bash command of the chat (the sandbox shell keeps its directory between calls). Today `cd /home/claude/verb/lorber && python3 … 'body.html'` is filed under `body.html`, whose key is `/home/claude/verb/body.html`, so the warning names the wrong file. It should be `/home/claude/verb/lorber/body.html`, whose export name is `body_2.html`. The warning or note uses `index[key].filename`, the file's name in `artefacts/`.

*My call:* when there is no `cd` at all, a relative path resolves only if exactly one known file has that basename. Then the entry names that file, but section 3 never replays it: replay needs a resolved directory. With two or more candidates, the entry is filed under each candidate as today, and every one of them stays a warning (rule d), never a note.

**One entry per file.** All the mutations of one file merge into one entry. Its message counts them ("Changed by 3 commands") and its details carry `path` (the sandbox path) and the message numbers. Today `build.py` gets 4 warnings.

**Sorting.** For each file whose last mutation can't be replayed (after section 3), the rules apply in this order, and the first one that matches wins:

| # | Rule | Result |
|---|---|---|
| a | The same path was presented or delivered (`present_files`, `SendUserFile`) in the same message as the file's last mutation or later, and the download succeeded. | The download is the final state, and it replaces the artifact's final file and its last `_vN`, the way a presented file does today (`replayIsOff`). A delivered file with the same path as an artifact therefore stops being saved as `<base>_delivered<ext>` when the replay is off. It still is when the replay is not off, unchanged. The entry is dropped. Today a presented file only clears when the replay also rebuilt that name (`replayed` at popup.js `populateConversationFolder`), and a delivered file never clears. Both now clear, but only for a delivery at or after the last mutation. |
| b | A file was delivered or presented and downloaded, in the same message as the last mutation or later, from the file's own folder or a folder below it. | Note `draft_superseded`: "Draft changed by a command the export can't follow (N commands). The files Claude delivered from this folder afterwards are in the export: <names, up to 3>. This draft is likely an earlier state of one of them." |
| c | The file is code: its extension is one of `.py .sh .bash .js .mjs .cjs .ts .rb .pl .r .sql .awk .sed`, and it was never presented or delivered. | Note `helper_script`: "Helper script Claude ran; changed by a command the export can't follow, so this copy may be older than the one Claude ran. Scripts are not what Claude delivered." |
| d | Otherwise. | Warning `artifact_opaque_mutation`, as today, with the corrected name and the merged count. |

Rule b says "likely". It is a judgment, not proof that the delivered file contains the draft's edits. The owner accepted that: in the 16:15 export it holds for every draft. Rule c covers `build3.py` (Board chat, edited after the last delivery). "Folder or below" compares sandbox paths after the attribution fix: `/home/claude/de-luce/de-luce-reader.html` → `/home/claude/de-luce/Grosseteste_De_luce_reader.html`; `…/scratchpad/build.py` → `…/scratchpad/out/Minutes - 2026-09-21.odt`.

*My call:* rules a and b need to know when each file was presented. `extractPresentedFiles` today keeps the first presentation of a path, with no position, over every message. It is changed to walk the current branch (`getMessageChain`), and to keep every presentation with its message index. The export downloads the latest presentation of each path. That is the final state, and for most chats it is the same file as today's.

The replay-is-off rule for presented files (`replayIsOff`: the download replaces the final and its last `_vN`) is unchanged. It looks at warnings and notes of this kind together, since a noted file's replay is just as off.

### 3. Replay of literal text swaps

`extractArtifacts` (and `extract_artifacts.py`, byte for byte) replays three exact command shapes on a file whose current state is known. "Known" means the file was created and every change so far was replayed. A file with an earlier unreplayed change stays opaque from there on. The replay happens in place, so the turn's snapshot (`_vN`) carries it. The rest of the command must be only `cd <dir>`, `&&`, `;` and read-only commands from this list: `grep`, `head`, `tail`, `wc`, `cat <file>` with no redirect, `sed -n`, `ls`, `echo`/`printf` with no redirect, `test`/`[`. Anything else, including a pipe into a write, leaves the command opaque.

- **`sed -i`** with one or more `-e`/plain scripts, each `s<d>A<d>B<d>[g]` (any delimiter). A must contain no unescaped regex metacharacters, so only `\` + the delimiter, `\.`, `\/`, `\*`, `\[`, `\]`, `\$`, `\^` escapes. B must contain no `&`, `\1`-style references or newlines. Replay per line, as sed does: the first occurrence on each line, or every one with `g`. Also `sed -i.bak` (the backup is ignored). Several files after the script: each is replayed.
- **`cat >> <file> << '<D>'`**, with a quoted delimiter: append the body plus a newline. An unquoted delimiter whose body has `$`, a backtick or `\` stays opaque, as today.
- **Python** run as `python3 - << '<D>'` or `python3 -c '<script>'`, whose script is only these statements, in this order:
  1. `p = '<path>'` (optional; a path or basename resolving to a known file under the working directory);
  2. `s = open(p).read()` or `open('<path>').read()`, with `encoding='utf-8'` optional;
  3. any number of `s = s.replace(<lit>, <lit>)`, or a list `r = [(<lit>, <lit>), …]` followed by `for a, b in r: s = s.replace(a, b)`, optionally with a `count` argument `1`;
  4. `open(p, 'w').write(s)`, or a `with open(p, 'w', …) as f: f.write(s)` block;
  5. optionally `print(...)` with any arguments not calling anything but `len`, `s.count`, or a literal.

  `<lit>` is a Python string literal: single, double or triple quotes, with the standard escapes (`\n \t \\ \' \" \xNN \uNNNN`). There is no f-string, no `r` prefix unless its content has no backslash, and no concatenation. Replay is Python's `str.replace`: every occurrence, or the first with count 1. An old string that isn't found changes nothing, exactly as Python. That's safe because the file's state is known.

  Several assignments to different files in one script, or any other statement, mean opaque.

*My call:* replay of a file stops at its first opaque command and never resumes, even for a later literal swap. Each turn's `_vN` holds the state after the last replayed command before that point. That matches today's meaning of `_vN` ("what the declarative replay knows"), so the validate-export invariants and `replay_bash.py`'s starting state keep their meaning.

What this recovers in the 16:15 export: `de-luce-reader.html` (3 of 3 edits), the Survey chat's `sed -i` ×3, `astral-body.html`, `match2.py`, and some of the `body_N.html` edits. The rest of body's edits use computed strings or read other files, so they stay opaque and fall to section 2.

### 4. Basename collisions become notes

`artifact_basename_collision` (both the `extractArtifacts` one and the presented-file one) becomes the note `name_changed`: "Two different files were named <name>; this one, from <sandbox path>, was saved as <new name>. The other is <other name> from <other path>." Both paths are shown. The warning type stays known to `_getRecoveryHint` and `warningsFromReport`, so older archives still read.

### 5. `export_health`: the empty tail

`chatHealth` does not count a message as hollow when all three hold:

- it is from the assistant;
- its parent is an assistant message with content;
- it was created within 5 s of that parent.

Everything else about the check is unchanged. A test pins one real-shaped case (empty content, 60 ms after a complete assistant parent) and the case it must still catch (an empty assistant reply to a human message).

### 6. Claude Docs diagrams from Claude's screenshots

When Claude read a widget with `Claude_Docs__read` (`engine: "widget"`, `payload.kind: "screenshot"`, `ref.id` the widget's node id), the tool result carries an image block (`file_uuid`). `saveToolImages` already saves it in `images/` as `<uuid8>_<name><ext>`, with the extension taken from the downloaded bytes. The rebuilt document shows that picture where the widget's caption stood:

- in `.md` as `![<caption>](../images/<saved name>)`;
- in `.html` as an `<img>`.

The caption is kept below the picture. If the widget was edited after the screenshot (a later `Claude_Docs__update` on that node id), the caption adds "(screenshot taken before a later edit)". The latest screenshot of each node wins.

*My calls:*
- **A post-pass, like the companion note.** The picture is added after `saveToolImages` has run, in the same place and the same way as `docCompanionNote` (popup.js, after the downloads), using the names `saveToolImages` actually wrote. Only the final document gets the pictures; its `_vN` versions stay as rebuilt. `extract_artifacts.py` doesn't mirror this pass, just as it doesn't mirror the companion note. Byte identity holds for what both produce.
- **A failed download.** A screenshot whose download failed (a `tool_image` warning) is treated as absent: the caption stays as today, and `doc_diagram` is raised if the diagram has no other copy.
- **The `.jsx` files are not artifacts.** Each widget's JSX (`payload.code`, the last code sent for that node) is written once by `populateConversationFolder` as `artefacts/<doc base>_diagram<N>.jsx`, uniquely named the same way as the doc's `.html`. They have no versions, no viewer card, no Python mirror, and aren't subject to rules a–d. They are listed in README's file list.

The `doc_diagram` warning is raised only for diagrams with no saved screenshot and no HTML copy (`docCompanions`, unchanged).

In the 16:15 export both `doc_diagram` warnings go away: the Metaphysics chat has 2 screenshots and the Noack chat has 1.

### 7. Smaller fixes

- `WARNING_NOUNS` gains `doc_diagram` ("diagram not included", "diagrams not included"), `claude_doc_unreplayed`, `published_page` (kept), and `artifact_basename_collision` (for old runs).
- The `web_image` hint says what happened by cause: "the site refused it (403) or it is gone (404); nothing in Claude Takeout can fetch it". The Settings advice appears only when the warning is the no-permission one.

## Where it shows

| Place | Change |
|---|---|
| Done screen | The headline and list count warnings only. When there are notes, one quiet line under the list says "N notes about drafts and renamed files are in each chat's README". |
| Chat `README.md` | New section "About some files". |
| `errors.txt` | `## Notes` section. Its header line counts warnings and notes separately. |
| Export All `index.md` | The per-chat issue count counts warnings only. |
| Viewer | `draft` and `helper` badges on file cards, styled softer than the warning badges. |
| `exportRecord.warnings` | Warnings only. |

## Constraints

- `extract_artifacts.py` stays byte-identical to `extractArtifacts`. Every replay shape in section 3 gets a Python twin and a shared fixture case.
- The `validate-export` skill (bearspear/claude-skills) is updated in step: the new note types, and the fact that `final == vN` still holds after a replayed swap.
- No real chats in tests. Synthetic fixtures model each shape in this spec, built from the patterns above, not copied text.
- TECHNICAL.md, CLAUDE.md §10–11, README (changelog `v1.22.1`, `manifest.json` 1.22.1) and USAGE.md are updated in the same branch.
- Codes and counts only in messages, as before. No token or picture URL anywhere.
- Branch `quiet-warnings`, from `panel-redesign` (or from `main` once v1.22.0 is merged).

## For the builder

- **`replay_bash.py` and replayed swaps.** The CLI replays the chat's bash commands from the declarative state. If it starts from the export's `_v1`/final, now that a `sed -i` is already applied there, it may apply the swap again. Check how it chooses its starting state. If needed, make it skip commands `extract_artifacts.py` replayed: `extract_artifacts.py` can fill a `replayed` set of (message, block) ids the way it fills `names`.
- **The cwd carried between commands** is new state for the detector and the replay. Keep one helper that both use, in `export-core.js`.
- **Rule b's folder test** uses sandbox paths, which differ between chat kinds (`/home/claude`, `/mnt/user-data/outputs`, `/tmp/claude-0/…/scratchpad`). Compare whole path segments, never a string prefix: `/home/claude/de` is not the parent of `/home/claude/de-luce`.
- **What's left to your judgment:** the exact README and viewer wording beyond the sentences fixed above, and the badge styling.
