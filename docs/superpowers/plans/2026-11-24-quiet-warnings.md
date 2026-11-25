# Quiet Warnings (v1.22.1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A warning means the owner is missing something. Everything else becomes a counted-nowhere note, and literal text swaps by command are replayed.

**Architecture:** `ExportErrorCollector` gains notes. A shared working-directory helper in `export-core.js` serves both the opaque-mutation detector and a new literal-swap replay inside `extractArtifacts` (mirrored in `extract_artifacts.py`). `populateConversationFolder` sorts each file's unreplayable changes into dropped, note or warning, using per-branch presentation and delivery positions. Smaller fixes cover `chatHealth`, the Claude Docs diagram post-pass, `WARNING_NOUNS` and the `web_image` hint.

**Tech Stack:** Plain JS (Chrome MV3, classic scripts, Node test runner), stdlib Python 3.

**Spec:** `docs/superpowers/specs/2026-11-24-quiet-warnings-design.md`

## Global Constraints

- `extract_artifacts.py` stays byte-identical to `extractArtifacts`: every replay shape gets a Python twin, and a parity test runs `pythonArtifacts(data)` against `fn('extractArtifacts')(data)`.
- No real chats in tests. Synthetic fixtures are built from the shapes in the spec, not copied text.
- Messages carry codes and counts only, never a token or picture URL.
- `popup.html` and `sidepanel.html` stay byte-identical.
- No `_`-prefixed files. Run Python with `-B`.
- `node --check popup.js` after every edit to it. `sh tests/run.sh` must be green before each commit.
- Commit as bearspear, with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never stage `.claude/`, `.superpowers/` or `.DS_Store`.
- Version 1.22.1: README changelog `### v1.22.1` and `manifest.json` `"version": "1.22.1"`.
- "When unsure, warn": every path that can't be resolved, every command shape not listed exactly, and every file with two candidate paths stays a warning.

## Review Focus

1. **A delivery from a sibling folder whose name is a string prefix** (`/home/claude/de` vs `/home/claude/de-luce`) must not count as "the folder or below". This is pinned in Task 6.
2. **A delivery before the last mutation** must not clear the entry or turn it into a note. A person expects a warning when the draft changed after the last delivery. This is pinned in Task 6.
3. **A `sed -i` with a regex metacharacter** (`s/a.b/c/`, `s/x/&y/`) must stay opaque, not be replayed as a literal. This is pinned in Task 4.
4. **A Python swap script with one extra statement** (an `import re`, a second file) must stay opaque. This is pinned in Task 5.
5. **A notes-only export** still writes `errors.txt` and the README section, but stays green with a zero warning count. This is pinned in Task 1.

---

### Task 1: Notes in the collector, `errors.txt` and the chat README

**Files:**
- Modify: `popup.js` (`ExportErrorCollector`, around lines 17–260; the README builder `readmeLines` around 2731; the `errors.txt` write around 2908)
- Test: `tests/export.test.js`

**Interfaces:**
- Produces:
  - `errorCollector.addNote(type, filename, message, details = {})` pushes `{ type, severity: 'note', filename, error: message, details: { uuid, path, note }, recovery: this._getNoteHint(type) }` onto `errorCollector.notes`.
  - `hasNotes()`.
  - `hasAny()` is true with notes only.
  - Note types are `'draft_superseded' | 'helper_script' | 'name_changed'`.
  - `readmeNoteLines(notes) -> string[]` is a pure top-level function in popup.js.

- [ ] **Step 1: Write failing tests.**
  - `test('collector notes: counted apart, reported under ## Notes')`. Use a real `ExportErrorCollector` (`fn('ExportErrorCollector')`) with one warning and one `addNote('draft_superseded', 'body_2.html', 'Draft …', { path: '/home/claude/verb/lorber/body.html' })`. Assert:
    - `c.warnings.length === 1` and `c.notes.length === 1`;
    - the report contains `**Notes:** 1 total`, then `## Notes`, then `### body_2.html` and `- **Type:** draft superseded`;
    - `## Notes` comes after `## Warnings`.
  - `test('collector: notes only still writes a report')`: `hasAny()` is true, `hasWarnings()` is false, and the report has `## Notes` and no `## Warnings`.
  - `test('readmeNoteLines groups by kind')`: given 2 draft notes and 1 helper note, it returns lines starting with `## About some files`, with sub-headings `### Drafts` (2 bullets `- \`body_2.html\`: …`) and `### Helper scripts` (1 bullet). An empty list gives `[]`.
- [ ] **Step 2:** Run `node --test tests/export.test.js`. Expected: the 3 new tests FAIL (`addNote is not a function`).
- [ ] **Step 3: Implement.** Add `addNote`, `notes`, `hasNotes` and `_getNoteHint(type)`, with one sentence per type:
  - draft: "The finished files from this folder are in the export; this draft is kept for reference. replay_bash.py can try to rebuild it.";
  - helper: "Claude's helper script, not a delivered file.";
  - name: "Both files are kept; only the name changed.".

  In `generateErrorReport`, notes add a `**Notes:** N total` summary line and a `## Notes` section in the warnings' entry format, placed after the warnings. `readmeNoteLines` provides the kind headings `Drafts`, `Helper scripts` and `Renamed files`. `populateConversationFolder` appends `readmeNoteLines(errorCollector.notes)` to the README before `## Extras`.
- [ ] **Step 4:** Run `node --check popup.js && sh tests/run.sh`. Expected: all pass. The export baseline is unchanged, since the fixture produces no notes yet.
- [ ] **Step 5:** Commit: "Errors report: notes, apart from warnings".

### Task 2: Notes reach the viewer and the Done screen

**Files:**
- Modify: `export-core.js` (`viewerFlags`, `FLAG_FOR_WARNING`), `viewer/viewer-logic.js` (`FLAG_NOTES`), `viewer/viewer-app.js` (the badge at about line 1082: "may not match" only for warning flags), `viewer/viewer-template.html` or `viewer/artifacts.css` (softer badge style), `popup.js` (`viewerFlags(...)` call at about 2898; `runResult`; `doneHeadline` and the Done list near `warningGroups` at about 6811), `takeout-viewer.js` (comment at line 7)
- Test: `tests/viewer.test.js`, `tests/screens.test.js`

**Interfaces:**
- Consumes: `errorCollector.notes` (Task 1).
- Produces:
  - `viewerFlags(warnings, notes = [])` returns flags. A warning flag (`script | edit | doc`) wins over a note flag. Notes map `draft_superseded → 'draft'` and `helper_script → 'helper'`; `name_changed` gives no flag.
  - `runResult({..., fileNotes = 0})` puts `fileNotes` on the result.
  - `doneNotesLine(result) -> string` gives `''` when there are none, else `` `${n} note${s} about drafts and renamed files ${n === 1 ? 'is' : 'are'} in each chat's README.` ``.

- [ ] **Step 1: Write failing tests.**
  - viewer.test: `viewerFlags([], [{ type: 'draft_superseded', filename: 'a.html' }, { type: 'helper_script', filename: 'b.py' }])` deep-equals `{ 'a.html': 'draft', 'b.py': 'helper' }`.
  - A warning `artifact_opaque_mutation` on `a.html` plus a draft note gives `{ 'a.html': 'script' }`.
  - `FLAG_NOTES.draft` and `FLAG_NOTES.helper` are non-empty.
  - screens.test: `doneNotesLine({ fileNotes: 0 }) === ''`, and `doneNotesLine({ fileNotes: 13 })` gives the 13-notes sentence. `doneHeadline` for `{ outcome: 'done', warnings: 0, fileNotes: 13 }` is the same as with no notes, which pins "notes don't count".
- [ ] **Step 2:** Run `node --test tests/viewer.test.js tests/screens.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **Where `fileNotes` comes from:** `bulkExportZip` sums `folderResult.errorCollector.notes.length` and passes it to `runResult`. The single-chat paths ignore it.
  - **Done screen:** it shows `doneNotesLine` as a muted line under the warnings list, as a new `<p id="doneNotes">` in `popup.html`, copied to `sidepanel.html`.
  - **Viewer badge:** a draft or helper flag shows "draft" or "helper script" in the file's meta instead of "may not match", styled with the muted text colour, not amber.
- [ ] **Step 4:** Run `node --check popup.js && sh tests/run.sh`, then `node tests/e2e/viewer.e2e.js`. Expected: all pass.
- [ ] **Step 5:** Commit: "Viewer and Done screen: notes are shown, not counted".

### Task 3: Working directory and per-file opaque entries

**Files:**
- Modify: `export-core.js` (new helpers near `heredocMatches`), `popup.js` (`detectOpaqueMutations`, lines 613–781)
- Test: `tests/export.test.js`

**Interfaces:**
- Produces, in `export-core.js` and exported for Node:
  - `commandCwds(messages) -> Map<toolUseId, string|null>` gives each bash `tool_use` its working directory:
    - a leading `cd <abs>` (`&&` or `;`) in its own command wins;
    - otherwise the last absolute `cd` seen in an earlier bash command of the chain;
    - `null` when there is neither.
  - `resolveSandboxPath(word, cwd, knownPaths: string[]) -> { path: string|null, candidates: string[] }`:
    - absolute: itself;
    - relative with a cwd: `cwd + '/' + word`, normalised (`./` and `..` handled);
    - no cwd: the one known path whose basename is the word, else `path: null` with all matches in `candidates`.
  - `isUnderFolder(file, folder) -> boolean`, comparing whole path segments.
- Produces, in `popup.js`: `detectOpaqueMutations(data, errorCollector, { replayed = new Set(), index = {} } = {})` returns `{ opaqueMutations, byFile }`.
  - `byFile` is `Map<path, { path, filename, msgIndexes: number[], lastMsgIndex, count, resolved: boolean }>`. `filename` is `index[path].filename` (the `artifactIndex` from `extractArtifacts`), falling back to the basename.
  - In this task it still adds one `artifact_opaque_mutation` warning per `byFile` entry. The message reads "Changed by N command(s) the export can't replay."
  - `replayed` holds `toolUseId + '|' + path` keys to skip, and Task 4 fills it.

- [ ] **Step 1: Write failing tests.**
  - `test('commandCwds: own cd wins, earlier cd carries, none is null')`.
  - `test('resolveSandboxPath: relative under cwd, unique basename without cwd, ambiguous gives candidates')`.
  - `test('isUnderFolder compares segments')`: `isUnderFolder('/home/claude/de-luce/x.html', '/home/claude/de')` is false; `isUnderFolder('/a/b/out/x.odt', '/a/b')` is true.
  - `test('detectOpaqueMutations: names the file under cd and merges its commands')`:
    - a chat with `Write /home/claude/verb/body.html` and `Write /home/claude/verb/lorber/body.html`;
    - followed by two `cd /home/claude/verb/lorber && python3 - <<'E'\nimport re\np='body.html';s=open(p).read()\nopen(p,'w').write(re.sub('a','b',s))\nE` commands (opaque because of `re.sub`);
    - expect exactly one warning, whose `filename` is the lorber file's name in `index` (`body_2.html`), whose `details.path` is `/home/claude/verb/lorber/body.html`, and whose message contains `2 commands`.
  - Existing detector tests keep passing. Where they assert one warning per command, they're updated to the per-file count, and the test says so.
- [ ] **Step 2:** Run `node --test tests/export.test.js`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.** Resolve each shell word and each Python literal through `resolveSandboxPath` with the command's cwd before matching against known paths. An unresolved word with several candidates files the entry under each candidate with `resolved: false`.
- [ ] **Step 4:** Run `node --check popup.js && sh tests/run.sh`. Expected: all pass.
- [ ] **Step 5:** Commit: "Opaque changes: the right file, one entry per file".

### Task 4: Replay literal `sed -i` and `cat >>`

**Files:**
- Modify: `export-core.js` (`extractArtifacts`; new `literalSwapCommand(command, cwd) -> null | { edits: [{ path, kind: 'sed'|'append', ... }] }`), `extract_artifacts.py` (twin `literal_swap_command(command, cwd)`), `popup.js` (pass `replayed` from `extractArtifacts` to `detectOpaqueMutations`)
- Test: `tests/export.test.js`

**Interfaces:**
- Consumes: `commandCwds` and `resolveSandboxPath` (Task 3), plus `detectOpaqueMutations(..., { replayed })`.
- Produces:
  - `extractArtifacts(data, errorCollector, index, replayed)`: a 4th optional `Set` filled with `toolUseId + '|' + path` for every replayed edit.
  - Python `extract_artifacts(data, warnings, names, replayed=None)`, the same.
  - A file whose state isn't known (never created in the chat, or an earlier unreplayed command touched it) is not replayed. From its first opaque command on, nothing more is replayed for it, per the spec's "My call".

- [ ] **Step 1: Write failing tests.** Each test uses a parity helper `bothReplay(data, file, want)`, which asserts JS `extractArtifacts(data)[file] === want` and `pythonArtifacts(data)[file] === want`.
  - `sed -i 's|<line y2="92"|<line y2="116"|' page.html` after `cd /home/claude/x` replays.
  - `sed -i` with `g`, `-e` twice, `-i.bak` and two target files each replay.
  - Per line: the first occurrence without `g`, every one with `g`.
  - These stay opaque, with no change and a warning: `s/a.b/c/`, `s/x/&y/`, `s/\(a\)/\1/`, `sed -i … | tee`, a pipe into another write, `sed -i` on an unknown file.
  - `cat >> page.html << 'E'\nmore\nE` appends `more\n`. An unquoted delimiter whose body has `$` stays opaque.
  - `cd /x && sed -i 's/a/b/' f.html && grep -c b f.html` replays (`grep` is read-only).
  - With `replayed` passed in, `detectOpaqueMutations` gives no warning for a replayed command.
  - Ordering: `sed` (replayed), then a `python3 … re.sub` (opaque), then `sed` again. The final equals the state after the first `sed` only, with one warning.
- [ ] **Step 2:** Run `node --test tests/export.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** both twins. These are the only allowed read-only tools in the rest of the command: `grep head tail wc cat(no redirect) sed -n ls echo printf(no redirect) test [`. The sed script parser accepts the escapes listed in the spec, section 3.
- [ ] **Step 4:** Run `sh tests/run.sh`. Expected: all pass. If the export baseline shifts, refresh it per `tests/README.md` and check the diff shows only replayed content.
- [ ] **Step 5:** Commit: "Replay: literal sed -i and cat >> appends".

### Task 5: Replay simple Python text-swap scripts

**Files:**
- Modify: `export-core.js` (`literalSwapCommand` gains the Python shape; new `pyStringLiteral(src, i) -> { value, end } | null`), `extract_artifacts.py` (twins)
- Test: `tests/export.test.js`

**Interfaces:**
- Consumes: Task 4's `literalSwapCommand` and `replayed`.
- Produces: the `kind: 'pyreplace'` edit `{ path, pairs: [[old, new, count|null]] }`.

- [ ] **Step 1: Write failing tests**, with `bothReplay`.
  - These replay:
    - `python3 - <<'E'\np='page.html';s=open(p).read()\ns=s.replace('<stop offset="0" stop-color="x"/>','<stop offset="0" style="stop-color:x"/>')\nopen(p,'w').write(s)\nE`;
    - the list form `r=[('a','b'),('c','d')]\nfor a,b in r: s=s.replace(a,b)`;
    - `count` 1;
    - `with open(p,'w',encoding='utf-8') as f: f.write(s)`;
    - a trailing `print(s.count('b'))`;
    - triple-quoted and `\n`/`é` escapes;
    - `python3 -c '…'`.
  - Python semantics: `s.replace('a','b')` replaces every `a`, and an old string that isn't present changes nothing, without a warning.
  - These stay opaque: an `import re` line; `re.sub`; an f-string; a second `open(..., 'w')` on another file; `+` concatenation in a literal; `r'\d'`; a variable that isn't `p`/`s`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement** a statement-by-statement matcher over the script's lines. Each line must match one allowed statement from the spec, in order, or the whole command is opaque.
- [ ] **Step 4:** Run `sh tests/run.sh`. Expected: pass.
- [ ] **Step 5:** Commit: "Replay: simple Python text-swap scripts".

### Task 6: Sort each file's unreplayable changes (rules a–d)

**Files:**
- Modify: `export-core.js` (`extractPresentedFiles`, `extractDeliveredFiles`), `popup.js` (`populateConversationFolder`: the presented-download loop at about 2346–2420, and a new step after the deliveries that sorts `byFile`)
- Test: `tests/export.test.js` (using `exportPopup`/`runFolder` from `tests/helpers.js` with `withUploads`)

**Interfaces:**
- Consumes: `byFile` (Task 3), `isUnderFolder` (Task 3), `addNote` (Task 1).
- Produces:
  - `extractPresentedFiles(data)` walks `getMessageChain(data)` and returns one entry per path for its **latest** presentation, plus `msgIndex` (an index into the chain). The other fields are unchanged.
  - `extractDeliveredFiles` entries gain `msgIndex`.
  - `detectOpaqueMutations` no longer adds warnings itself. `populateConversationFolder` calls `sortOpaque(byFile, saved, errorCollector)`.
  - `sortOpaque` is a pure top-level popup.js function, where `saved` is `[{ path, filename, msgIndex }]`, the presentations and deliveries that downloaded.
  - The rules a–d, the exact note texts and the code-extension list `.py .sh .bash .js .mjs .cjs .ts .rb .pl .r .sql .awk .sed` are verbatim from the spec, section 2.

- [ ] **Step 1: Write failing tests**, for the pure `sortOpaque`.
  - Rule a: same path saved at `lastMsgIndex` or later. No entry.
  - Rule a ordering: same path saved before `lastMsgIndex`. Not rule a (falls through).
  - Rule b: `/h/c/de-luce/draft.html`, last change at 7, and `/h/c/de-luce/Final.html` saved at 7. A `draft_superseded` note naming `Final.html`.
  - Rule b subfolder: `/a/s/build.py` and `/a/s/out/M.odt`. A note.
  - Rule b prefix trap: `/h/c/de/x.html` with a delivery in `/h/c/de-luce/`. Not b.
  - Rule c: `/h/c/build3.py` with no later delivery. A `helper_script` note.
  - Rule d: `/h/c/page.html` with no later delivery. An `artifact_opaque_mutation` warning.
  - Unresolved (`resolved: false`): always d.
  - Through `populateConversationFolder`: a delivered `SendUserFile` with the same path as a replayed artifact, delivered after its opaque change, replaces `artefacts/<base><ext>` and its last `_vN`, and writes no `_delivered`. The same without an opaque change still writes `<base>_delivered<ext>`.
  - A presented file presented twice: the download uses the second presentation's uuid.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `replayIsOff(name)` looks at the `byFile` entries, not at the warnings.
  - In `extractDeliveredFiles`, a delivery whose path has an off replay goes over the artifact's name: pass the set of off paths as a new 3rd argument `offPaths = new Set()`.
- [ ] **Step 4:** Run `node --check popup.js && sh tests/run.sh`. Expected: pass. Refresh the export baseline if the fixture's file list changes, and justify each changed name in the commit body.
- [ ] **Step 5:** Commit: "Opaque changes: a note when a final copy exists".

### Task 7: Basename collisions become notes

**Files:**
- Modify: `export-core.js` (around line 1165, the `artifact_basename_collision` warning in `extractArtifacts`), `popup.js` (around 2371, the presented-file collision), `extract_artifacts.py` (keeps its warning list type, but the CLI prints it as a note)
- Test: `tests/export.test.js`

**Interfaces:**
- Consumes: `addNote` (Task 1).
- Produces: a `name_changed` note with `details.path` = this file's sandbox path and `details.note` = `Other file: <other name> from <other path>`. When `errorCollector.addNote` is absent (the old collector stubs in tests), it falls back to `addWarning`.

- [ ] **Step 1: Write a failing test.** Two `create_file` calls at `/a/x.html` and `/b/x.html`. The collector gets 0 warnings and 1 note `name_changed` on `x_2.html`, whose message contains `/b/x.html`, and whose `details.note` contains `x.html` and `/a/x.html`. The same for two presented files.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement.** Keep `artifact_basename_collision` in `_getRecoveryHint` and `warningsFromReport` for older archives.
- [ ] **Step 4:** Run `sh tests/run.sh`. Expected: pass.
- [ ] **Step 5:** Commit: "Renamed files: a note, both paths shown".

### Task 8: `chatHealth` skips the empty assistant tail

**Files:**
- Modify: `export-core.js` (`chatHealth`, line 133)
- Test: `tests/export.test.js` (next to the `chatHealth` tests at about 1394)

- [ ] **Step 1: Write failing tests.**
  - Healthy: an assistant message with `content: []` whose parent is an assistant message with one text block, created 60 ms after it.
  - Still `empty_messages`: an empty assistant message whose parent is a human message.
  - Still `empty_messages`: an empty assistant message 6 s after a complete assistant parent.
  - Still `empty_messages`: an empty assistant message whose assistant parent is itself empty.
- [ ] **Step 2:** Run. Expected: the first test FAILS, the others pass.
- [ ] **Step 3: Implement** the three-condition skip from the spec, section 5.
- [ ] **Step 4:** Run `sh tests/run.sh`. Expected: pass.
- [ ] **Step 5:** Commit: "Export health: an empty assistant tail is not a problem".

### Task 9: Claude Docs diagrams from Claude's screenshots

**Files:**
- Modify: `export-core.js` (new `docWidgetShots(data) -> Map<nodeId, { fileUuid, msgIndex, editedAfter: boolean }>`, `docWidgetCode(data) -> Map<nodeId, string>`, and `docDiagramPictures(markdown, pictures: [{ caption, src, note }]) -> { markdown, missing: number }`), `popup.js` (the doc post-pass at about 2437–2460: call it after `docCompanionNote`, using `toolImages` from `saveToolImages` at line 2176; write the `.jsx` files; raise `doc_diagram` only for `missing > 0` with no companion), `popup.js` `claudeDocHtml` (an `<img>` comes through marked unchanged, so check that it renders)
- Test: `tests/export.test.js`

**Interfaces:**
- Consumes: `saveToolImages` returns `{ <file uuid>: 'images/<name>' }`; widget node ids come from the batch result's ack, which `claudeDocCreated` already reads. The implementer maps a `$lid` to its node id the same way.
- Produces: `.jsx` names `<doc base>_diagram<N>.jsx` (N from 1, in document order), made unique the same way as the doc `.html`.

- [ ] **Step 1: Write failing tests**, through `populateConversationFolder` with a `Claude_Docs__batch` whose widget is captioned `Fig 1`, a `Claude_Docs__read` screenshot of that node whose result has an image block `file_uuid U`, and `withUploads` serving U as PNG.
  - The final `.md` contains `![Fig 1](../images/` and the saved name, and the `.html` contains `<img`.
  - There is no `doc_diagram` warning.
  - `artefacts/<base>_diagram1.jsx` holds the widget code.
  - A later `Claude_Docs__update` on that node adds `(screenshot taken before a later edit)`.
  - The image fetch failing (404) leaves the caption, gives a `tool_image` warning and the `doc_diagram` warning.
  - `pythonArtifacts(data)[<base>.md]` still equals JS's rebuilt `.md` from `extractArtifacts`, before the post-pass.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run `node --check popup.js && sh tests/run.sh`. Expected: pass.
- [ ] **Step 5:** Commit: "Claude Docs: diagrams shown from Claude's screenshots, source kept".

### Task 10: Words: `WARNING_NOUNS` and the `web_image` hint

**Files:**
- Modify: `popup.js` (`WARNING_NOUNS` at about 6248; `_getRecoveryHint` case `web_image` at about 111)
- Test: `tests/screens.test.js`, `tests/export.test.js`

- [ ] **Step 1: Write failing tests.**
  - `warningGroups` gives `2 diagrams not included` for 2 `doc_diagram` entries, `1 Claude Docs edit not rebuilt` for 1 `claude_doc_unreplayed`, and `1 file renamed` for 1 `artifact_basename_collision`.
  - `_getRecoveryHint('web_image', { note: 'HTTP 403' })` does not contain `Settings`, and contains `403`.
  - The no-permission warning's hint (the one call site that warns without permission passes `details.note` starting `No permission`) contains `Settings`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement.** In `_getRecoveryHint`, branch on `details.note` for `web_image`, and make the no-permission call site pass `note: 'No permission to fetch images from other sites'`. Check `saveWebImages`' call sites for what they pass now.
- [ ] **Step 4:** Run `sh tests/run.sh`. Expected: pass.
- [ ] **Step 5:** Commit: "Done list and errors.txt: clearer words for diagrams and web images".

### Task 11: Docs, version 1.22.1, and the replay CLI check

**Files:**
- Modify: `README.md` (changelog `### v1.22.1`), `manifest.json` (1.22.1), `TECHNICAL.md` (warnings and notes, replay shapes, diagrams), `CLAUDE.md` (§10 replay shapes and sorting, §11 note types, §2 nothing new), `USAGE.md` (what a draft note means, and that `replay_bash.py` still helps)
- Test: `tests/test_replay_bash.py`

- [ ] **Step 1: Write a failing test.** In `tests/test_replay_bash.py`: a chat with `create_file page.html` = `a`, then `bash: cd /home/claude && sed -i 's/a/b/' page.html`. Run `replay_bash.py --all` in its sandbox over an export folder built with `extract_artifacts.py`. Assert `page.html` is `b`, not doubly swapped. That proves the CLI computes its own pre-bash state (`replay_steps`) and isn't thrown by the export's already-replayed file. If the test passes at once, record it as a guard, not a fix, in the ledger.
- [ ] **Step 2:** Run `python3 -B tests/test_replay_bash.py`.
- [ ] **Step 3:** Write the docs.
- [ ] **Step 4:** Run `sh tests/run.sh`. Expected: pass, including the manifest/changelog version test.
- [ ] **Step 5:** Commit: "v1.22.1: warnings that mean something is missing".

**Outside this repo (owner follow-up, listed in the PR body):** the `validate-export` skill in bearspear/claude-skills needs:
- the note types;
- the replay shapes;
- the fact that `final == vN` holds after a replayed swap.
