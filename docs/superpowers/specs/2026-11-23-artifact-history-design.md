# Every version of every artifact: a full history in Export Artifacts and Export All (v1.21.0)

Date: 2026-11-23. Status: for the owner's approval (builder check done; findings settled, marked *my call*).

## Intent

The owner wants the export to be a **full backup** of their artifacts: if claude.ai deletes a version, or a whole artifact, an export they already made still has it. Today Export Artifacts and Export All's artifact step save only each artifact's current version (plus, in Export All, the versions a chat published). The deep review of 2026-11-22 found claude.ai keeps 68 versions of the owner's 19 artifacts; about 31 of the older ones hold files the export doesn't have (the rest are Claude Docs, whose text claude.ai doesn't serve as files).

The owner decided (2026-11-23):
- **All versions, every time.** No setting; a bigger, slower first export is fine.
- **Preview every older version in the viewer**, from the artifact page's version menu, not only open its files on disk.

## What claude.ai serves (checked live, 2026-11-23, read-only, counts only)

- `/api/frame/<uuid>` `history` lists version ids **newest first**; the live version is `history[0]`.
- `/api/frame/<uuid>?ver=<older>` answers with that version (`ver` equal to the one asked) but an **empty `files` list**: only the live version's info lists files. An older version's file list comes from the frame host:
  - **Chat and Design artifacts** (also Design made in Claude Code): `/_f/<ver>/_files.json` answers for every older version with that version's own list and checksums (one Design artifact's lists grew 2, 4, 5 … 9 files over 12 versions). Saved exactly, verified, as the current version is today.
  - **Cowork and Claude Code pages** (no `_files.json`, 404): `/_f/<ver>/_src/<path>` with the live version's paths returns the older version's own content (both pages tried gave different bytes per version). *My call:* save an older version at the live version's paths, marked not checked (`verified: false`, no claude.ai checksum), as these pages' files already are; a path the older version doesn't have is `missing`, not a failure of the export.
- Claude Docs are skipped as today (24 of the 68 versions).
- **Found while planning:** exports up to v1.20.7 keep `history` as claude.ai sends it (newest first) while the code reads it as oldest first, so the version menu labels the current version `v1` (the owner's export of 2026-11-22 has one such artifact). v1.21 turns it oldest first in `content.js` and reads older archives' `artifact.json` the same way (a listed record whose current version is first is reversed).

## Goals

1. **Every version saved.** For each artifact the export saves (Export Artifacts, and Export All's artifact step, also for Export Changes), every version in claude.ai's history (the `history` list `/api/frame/<uuid>` returns) is saved into the artifacts store as its own `<ver>/` folder beside the current one, with its entry in `artifact.json` `versions` and `order` (format 2, unchanged). Files, checksums, caps (32 MB a file, 50 MB a version), path safety, renames and warnings are exactly as for the current version today (`fetchPublishedFiles`).
2. **Nothing fetched twice in one export.** A version already in the store (a chat in this Export All saved it whole, or wrote it identically: `sameAs`) is not fetched again, as today for the current version.
3. **Export Changes fetches only what's new.** Versions never change once made. Export Changes fetches, for each artifact it includes, only the versions no earlier export from this browser saved whole (recorded per artifact in `chrome.storage.local` `exportRecord`). A version that failed is not recorded, so the next Export Changes tries it again. The record shape is the builder's; it must stay small (version ids, not files) and must not break an existing record (an old record means "versions unknown": fetch them all once).
   - Which artifacts Export Changes includes stays as today (new, or current version changed, `changedArtifacts`), plus: one whose recorded versions miss any of its history (a failed or new older version).
   - *My call:* only Export All (full or changes) writes the record, as today. A standalone Export Artifacts saves every version but records nothing, so the Export All series the owner merges never loses a version to it.
   - *My call:* an artifact Export Changes includes always gets its current version (fetched, or kept from the store as today), so its card and page in that archive show it; `artifact.json` lists only the versions this archive holds (as a changes archive does today). Older versions saved by earlier exports stay in those archives; `merge_archives.js` unites them, and since v1.20.6 a complete copy wins over an incomplete one, so a version marked missing here never replaces a full copy.
   - *My call:* a version claude.ai answers 404 for, or lists with no files, is recorded as settled (gone, not retried) and noted once; any other failure (network, 5xx, 401, checksum, cap) is not recorded and is retried by the next Export Changes.
4. **Failures are visible and retried.** A version that can't be fetched (or only partly) is marked `incomplete`/`missing` in `artifact.json`, warned once per artifact in `errors.txt` (`artifact_export`, codes only), and doesn't stop the other versions or artifacts. One 401 stops fetching for the export, as today.
5. **Every older version previews in the viewer.** In the version menu of an artifact's page, picking an older version shows it as the current one is shown: its start file in the sandboxed preview, with its own sibling files, its Download and Open file; a Design version shows its own canvas (its `project/canvas.json` and boards). This uses the existing route: each saved version gets its own preview payload in `viewer-files/` parts and its place in the record's `versionPlaces` (as `build_viewer.js` already does for archives on disk), and the version menu already prefers a version's own part (v1.20.7).
6. **Docs, card pictures, ZIPs.**
   - Claude Docs: unchanged (no files to save; the note and link stay).
   - Card pictures: one per artifact, as today.
   - ZIPs: current version only, as today.

## Non-goals

- A setting to turn history off or limit it to N versions (the owner chose all, every time).
- Saving claude.ai's own editor/runtime code of typed artifacts (`artifact-type/`), as today.
- Recovering artifacts claude.ai no longer lists: an export can only save what claude.ai still has. Older exports plus `merge_archives.js` (which already keeps every version from every source) are how a deleted one stays in a combined archive.
- Single-chat ZIP exports: their `published/` keeps only what the chat published.
- Older versions in `index.md`/`index.html` beyond what rows list today (`artifactRowVersions` already lists the versions a record has).

## Anti-goals

- Any URL, asset token or picture URL in a file, log, status or error (codes and counts only), as everywhere.
- A preview of an older version that reaches more than a current version's preview does (same sandbox, same CSP, guard frame when hosted).
- An older version's preview running with another version's files.
- Export Changes skipping a version that no export ever saved whole.

## Constraints

- `manifest.json` 1.21.0; README changelog `### v1.21.0`; USAGE (Export Artifacts, Export All, Export Changes, the viewer's version menu, sizes), TECHNICAL (the artifact step, the record, the viewer data), CLAUDE.md (§7 artifacts layout and `artifact.json`, §9 `exportRecord`).
- Memory on a large account: payloads are written into parts and let go per artifact (v1.20.5); older versions' previews count against the same `ARTIFACT_PARTS_BUDGET` (256 MB). *My call:* within an artifact the current version's preview goes in first; an older version's preview goes in only while at least 64 MB of the budget is left, a reserve for the current versions of the artifacts still to come (parts are streamed, so there is no second pass). An older version without a preview is still saved on disk, and the menu opens its files.
- Rate: versions are fetched one after another with the existing pacing between artifacts; no parallel burst.
- The old-archive tools (`build_viewer.js`, `merge_archives.js`) already read and merge any number of versions; they should need no change. Verify with a test that a v1.21 export merges and rebuilds with every version.
- Tests: unit (store gets every version; nothing fetched twice; Export Changes fetches only new or failed versions; an old record fetches all once; failures warned and retried; budget order), e2e (combined and artifacts-viewer: picking an older version previews its own files; a Design version shows its own canvas). Synthetic fixtures only; a real export on the owner's account to confirm the counts.

## Left to the builder

- The `exportRecord` shape for saved versions, and how `changedArtifacts` reads it.
- Where in `saveArtifact`/`runArtifactStep` the history loop lives, and its progress text.
- How older versions' payloads reach `artifactViewParts` and `versionPlaces` in the extension (the field already exists for records from disk).
- Ordering of fetches within an artifact (current first is suggested: it matters most if the run stops; then newest to oldest, the order `history` gives).
