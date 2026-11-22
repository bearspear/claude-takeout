# One folder per artifact, and the old-archive tools for artifacts (v1.18.0)

Date: 2026-11-22. Status: for the owner's approval (one builder check; findings folded in, marked *my call*).

## Intent

v1.17 gave Export All two stores for the same things: `published/` (each page version a chat published, since v1.14) and `artifacts/` (claude.ai's Artifacts list, current versions, since v1.17), joined by `savedIn` pointers. The owner wants one folder per artifact. v1.17 also made `build_viewer.js` and `merge_archives.js` refuse archives that include artifacts; the owner merges archives, so they must handle them. Both changes touch the same layout, so they ship together.

## Owner decisions (2026-11-21/22)

- Export All: one folder per artifact. `published/` folds into `artifacts/<Title>_<id>/`; older versions in subfolders. Single-chat exports keep `published/`.
- The standalone **Export Artifacts** export uses the same per-version layout.
- Merging archives: the merged archive always comes out in the new layout (option A). Sources may be pre-1.17 (`published/` only), 1.17 (`published/` + `artifacts/`) or 1.18. Chat Markdown links into `published/` are rewritten to the new place, only in the copies merge writes; sources are never touched.
- `build_viewer.js` keeps the Artifacts screen on archives that have artifacts.
- The Docs `artifact.json` note no longer says "export the chat that made it" when that chat is in the export.

## Goals

### Layout (Export All and Export Artifacts)
```
artifacts/                              (Export All: under the export root; Export Artifacts: the export root itself)
├── index.html, index.md, errors.txt
└── <Title>_<shortId>/
    ├── artifact.json                   format 2 (below)
    ├── <ver>/                          one folder per version saved: the current version and each older version a chat published (a `same` version has no folder; see sameAs)
    │   └── <files>                     names as published (publishedSegment), as today
    └── …
```
- Every version, the current one included, is in its own `<ver>/` folder (folder name `publishedSegment(ver)`; a version with no id, from an old url-only publish, is `current`). Nothing loose at the top except `artifact.json`.
- One folder per uuid: no artifact or version is ever stored twice. A version identical to a file a chat wrote (`same`) still isn't copied; `artifact.json` points at the chat's `artefacts/` file for it, as v1.17's `savedIn` did.
- **Every page a chat published lands here**, also ones claude.ai no longer lists and ones exported with the artifacts setting off. Only artifacts in claude.ai's list appear on All / Yours / Shared with you, and only when the list was fetched; the rest are reachable from their chats (and In chats is unchanged).
- Export All no longer writes `published/`. Chat READMEs, `full_chat.md` (`publishedLines`) and the viewer's published cards point into `artifacts/<Title>_<shortId>/<ver>/…`.
- Folder name: `<Title>_<shortId>`. In Export All the list is fetched before the chats, so a chat's publish of a listed artifact uses the list's title from the start; an unlisted page uses the publish's title, then page info (the v1.16.1 rename-on-first-info rule). *My call* (the two writers must agree on one name).
- Single-chat exports (the chat ZIP) keep `published/` unchanged.

### artifact.json (format 2)
- Keeps today's fields (title, type, source surface, rel, public, dates, note, thumb, start, needsRuntime), plus:
  - `format: 2`, `listed` (true when claude.ai's list had it), `current` (the current version id, or null when unknown);
  - `versions: { <ver>: { folder, files: [{ path, savedAs, size, contentType, sha256, verified }], start, startSaved, incomplete, missing, saved, sameAs?: { <published path>: <root-relative chat file> }, publishedIn: [{ chat, messageUuid, toolUseId, same, writtenAs }] } }` — what `published.json` held per version, for every version. `same`/`writtenAs` stay per publish (as today); `sameAs` is set only when no copy was saved, from the first publish whose chat is in this export and whose files all match (one-file versions as in v1.17; a multi-file `same` version is copied into `<ver>/`). *My call.*
- `published.json` is no longer written in Export All or Export Artifacts (its content lives in `artifact.json`).
- Docs note: "Text rebuilt from the chat <chat title>." when a linked chat in this export rebuilt it; otherwise today's note.

### Export All / Export Artifacts behaviour
- Export All: chats save their publishes into `artifacts/` as they run (in place of `published/`); the artifact step then adds the current version only when no folder for that uuid and version exists yet. The 1.17 dedup rules (reuse only whole versions; unchecked kept marked unchecked) become "the version folder already exists and is whole → done".
- Export Artifacts: current version into `<Title>_<shortId>/<ver>/`, `artifact.json` format 2.
- Export Changes, the record, the setting, card pictures, the guard frame, links: unchanged from v1.17.
- `index.html` / `index.md` list each artifact once, with its versions; links go to the current version's start file (or the newest saved version when the current wasn't saved).

### Viewer
- Same screens as v1.17. Artifact views and published cards read the new paths. The version menu lists every version in `artifact.json`.
- Artifacts not in claude.ai's list are not on All / Yours / Shared; their chats' published cards still open their versions, and **Open artifact** appears only for listed ones (as now).
- The Artifacts entry shows when the export has any artifact folder or any file Claude made in a chat (In chats). When claude.ai's list wasn't fetched (setting off, or a merge of only pre-1.17 sources), All / Yours / Shared say "claude.ai's list isn't in this export" instead of cards. *My call.*
- `artifacts/index.*` are written whenever `artifacts/` exists; unlisted pages are listed there under "Published from chats, not in claude.ai's list". *My call.*

### merge_archives.js
- Reads three source layouts: chat archives with `published/` (pre-1.17), combined 1.17 archives (`published/` + `artifacts/` with `savedIn`), and 1.18 archives (`artifacts/` only). Also standalone Export Artifacts exports (1.15-1.17 flat layout and 1.18), which have no chats.
- Writes one 1.18 `artifacts/` store: by uuid, the union of versions from all sources (no version is dropped); a version present in several sources is taken whole from the newest source (by its manifest `exported_at`), never merged file by file. `publishedIn` lists are unioned. This replaces today's union-without-overwrite of `published.json` for identical versions.
- `listed`, `current`, title, thumb and claude.ai metadata come from the newest **full** source whose artifact step ran (manifest `kind: "full"` or `"artifacts"` with an `artifacts` list); if that source doesn't list the artifact, `listed` is false (deleted on claude.ai). Changes exports never decide `listed`. With no such source, `listed` stays as the newest source had it. *My call.*
- A winning version stored as `sameAs` (no files of its own): if the merged chat copy has a file with the same bytes (sha256), point `sameAs` at it; otherwise copy the bytes from the source chat's file into `<ver>/`. A version is never lost; storing it once more is the fallback. *My call.*
- Single-chat sources (a chat folder with its own `published/`): its pages move into the root `artifacts/` and its links are rewritten from `published/…` to `../artifacts/…`, as for mega archives (consistent with option A). *My call.*
- Converts old layouts on the way: `published/<dir>/<ver>/` → `artifacts/<Title>_<id>/<ver>/`; a 1.17 flat `artifacts/<dir>/` current version → `<ver>/` (from its `artifact.json` `ver`); a 1.17 `savedIn` pointer → the version folder it pointed at.
- Rewrites links in the chat copies it writes: in `README.md`, `full_chat.md`, `integrated_chat.md` and `responses/*.md`, every link whose target starts with `../published/` or `published/` (the shared store) is mapped by uuid/version to the new path. A link it can't map is left as is and listed in the report.
- The merged `viewer.html` includes the Artifacts screen when any source had artifacts.
- Card pictures (`viewer-files/thumbs/<shortId>.*`) are carried over from the newest source that has one.
- An archive with only artifacts (standalone Export Artifacts) is accepted. The merged archive always has the Export All shape (`artifacts/` under the root, root `index.md`, `export-manifest.json` `kind: "merged"`), also when every source was artifacts-only. *My call.*
- The v1.17 refusal goes away. Write safety rules unchanged (new folders under `--out` only, sources read-only, temporary names).

### build_viewer.js
- On an archive with artifacts (1.17 or 1.18), rebuilds `viewer.html` with the Artifacts screen from `artifacts/` on disk (`artifact.json`, version files for previews, thumbs), using the same viewer data the extension writes. It still writes only `viewer.html`, `viewer-check.gif` and `viewer-files/`.
- It does not convert a 1.17 archive's layout in place (that is merge's job); it reads it as it is.
- It also accepts standalone Export Artifacts exports (no chats). As today, an archive that already has a generated `viewer.html` is skipped unless `--force`. *My call.*
- The v1.17 refusal goes away.

## Non-goals
- Converting archives in place.
- Changing single-chat ZIP exports.
- Docs' live text.

## Anti-goals
- Any source archive changed.
- A version stored twice, or a version lost in a merge.
- A chat link that worked before a merge broken after it.
- The picture URL, asset token or any frame URL in any written file (unchanged rule).
- Weaker preview sandboxing (unchanged guard rules).

## Constraints
- `manifest.json` 1.18.0, README changelog, USAGE (layout, merge, build_viewer), TECHNICAL, CLAUDE.md (§2, §5.3 publish row, §7 layouts, §8 if needed).
- `tests/fixtures/export-baseline.json` refreshed for the new layout.
- `extract_artifacts.py` and `replay_bash.py` are unaffected (they read `artefacts/`, not `published/`); confirm.
- The validate-export skill (bearspear/claude-skills) may need a note about the new layout; out of this repo.

## Left to the builder
- How `savePublishedPages` and `runArtifactStep` share the store (one writer per uuid/version).
- Exact `index.*` rendering of versions.
- Tests: unit for the layout, `artifact.json` format 2, dedup per version, every-published-page-lands, setting off, merge of each source layout (and mixes), link rewriting (mapped and unmappable), newest-source wins per version, thumbs carried, artifacts-only merges, build_viewer on 1.17 and 1.18 archives; e2e for the viewer on a 1.18 export and on a merged archive; no network; token scan of every written file.
