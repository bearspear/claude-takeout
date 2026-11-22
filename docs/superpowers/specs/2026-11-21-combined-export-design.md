# Combined export: chats and artifacts in one Export All, one viewer

Date: 2026-11-21. Status: for the owner's approval (one builder check; its findings are folded in).

## Intent

Today there are two exports and two viewers. Export All saves chats, with the files Claude made in them in each chat's `artefacts/` and the pages chats published in `published/`. Export Artifacts (v1.15, viewer since v1.16) saves claude.ai's Artifacts list. On claude.ai these sit side by side in one app; in the exports they don't know about each other:

- The same page can be stored twice (a chat's `published/` copy and the Export Artifacts copy).
- A Claude Docs artifact shows only a picture and a note in the artifacts viewer, while its text is rebuilt in the chat export that made it.
- Neither viewer links an artifact to the chat that made it.
- The files Claude made in chats (161 in the owner's 26-chat account, against 19 listed artifacts) have no place to browse them across chats.

A coverage check of the owner's real exports (2026-11-21) showed the link is there to use: 15 of the 19 listed artifacts are named in a chat's tool results. It also showed that Export Artifacts holds the true current version of pages that bash changed after publishing, which the chat replay can't rebuild. So combining the exports fills real gaps, and isn't only tidier.

Goal: Export All also saves the artifacts and writes one `viewer.html` that works like claude.ai: Chats and Artifacts in one sidebar, linked both ways.

## Owner decisions (2026-11-21)

- Export All includes artifacts by default; a setting turns it off.
- The Artifacts screen has a fourth tab, **In chats**, for files Claude made in chats. All / Yours / Shared with you stay exactly claude.ai's list.
- The **Export Artifacts** button stays, unchanged, for an artifacts-only export.
- Layout as in the mockups (`.superpowers/brainstorm/87075-1795295323/content/combined-viewer-v2.html`): screens A, A2, B, C, D.

## Goals

### Export
- Export All (folder and ZIP, full and changes) runs the artifact step after the chats, unless the new setting **Include artifacts in Export All** (`exportAllArtifacts`, default on) is off. The step is Export Artifacts' own code (`listArtifacts`, `saveArtifact`, card pictures, viewer data), writing into `artifacts/` at the export root.
- **Nothing is stored twice.** When an artifact's listed version is a version this export already has from the chats (same uuid and version), the artifact's folder holds only `artifact.json` and nothing is fetched again. `artifact.json` gets `savedIn: { <published path>: <root-relative file> }`, one entry per file:
  - a version saved in `published/` points at those files;
  - a version recorded as `same` (not copied into `published/`, because it equals a chat's artefact) points at that chat's `artefacts/<writtenAs>` file(s);
  - a version that is `incomplete`, has unverified files, or wasn't saved is not reused: the artifact is fetched as usual.
  The artifact step reads the in-memory published record (Export All's shared record, before `writeSharedPublished` runs), not the folder. *(Settled from the code: same versions are never written to `published/`, popup.js `savePublishedPages`.)*
- **Failure stays contained.** The artifact step never fails or delays the chat export's files: a failed list or artifact is a warning in `artifacts/errors.txt` (type `artifact_export`, as in Export Artifacts), the status line says so, and `index.md` links it. The chat export's 401 handling and the artifact step's 401 latch stay separate; a 401 in the artifact step stops only that step.
- **Card pictures** follow the rule Export All already has for web-search images: Export All never asks for the optional permission (neither folder nor ZIP; no new prompt on Export All). With it granted, pictures are saved; without it, tiles, and `artifacts/index.md` says "Card pictures: 0 of N (needs …)" as v1.16 does. *(Builder's call, settled: Export All ZIP has no permission ask today, popup.js `exportAllZip`; adding one wasn't asked for.)*
- **Export Changes:** an artifact is included when its listed version differs from the one recorded at the last export (`exportRecord[org].artifacts[uuid] = ver`); with no record yet, all are included. The record is written with the chats' record after the export. Like the chats in a changes export, the Artifacts screen and `artifacts/index.*` then show only the included artifacts, headed "Changed since <date>: N of M listed". *(My call: consistent with how a changes export treats chats; the tabs still show only items from claude.ai's list.)*

### Layout
```
claude-takeout-<name>-<stamp>/
├── viewer.html                 one viewer: Chats and Artifacts
├── viewer-check.gif
├── viewer-files/               parts (chats and artifacts), thumbs/<shortId>.<ext>
├── index.md                    chats, then an "Artifacts" section linking artifacts/index.md
├── export-manifest.json        as today, plus artifacts: { listed, thumbs, items: [{ uuid, title, folder, ver }] } when the step ran
├── projects/, published/       unchanged
├── artifacts/
│   ├── index.html, index.md    as Export Artifacts writes them (links relative to artifacts/)
│   ├── errors.txt              only with warnings
│   └── <Title>_<shortId>/      current version + artifact.json (or artifact.json + savedIn)
└── <chat folders>/             unchanged
```
- `published` and `artifacts` are reserved chat folder names (a chat named so gets `_2`, as `published` does today).
- Export Artifacts' own export layout doesn't change.

### Linking chats and artifacts
An artifact is linked to every chat in the export whose tool calls name its uuid, by these rules only:
- a publish (`publishedPagesOf`: `publish_files` and the `Artifact` tool) of that uuid: "Published in";
- a Claude Docs batch whose result's leading JSON has `created.minted` equal to the uuid: "Made in" (the document `claudeDocCreated` rebuilds is that artifact's text). Checked on a real batch result (2026-11-21): `{ …, "acks": [...], "lids": {...}, "created": { "verdict": "allow", "minted": "<artifact uuid>", "bound": true }, "frame": { "slug": … } }`. The test fixture (tests/helpers.js) has an older shape (`acks[].minted`, `frame.url`) and should gain this one; when `created.minted` is absent, `frame.url`'s base58 id (`base58ToUuid`) is the fallback. The node id `claudeDocCreated` keys the rebuild by (`doc:<node id>`) is a different id;
- a Claude Docs call whose `input.container` is `{ kind: "project", id: <uuid> }`: "Edited in";
- `mcp__claude-artifacts__edit_version` (seen once in the owner's chats; input keys `base_version`, `edits`, `label`, `slug`) with `input.slug` equal to the uuid and a result without `is_error`: "Edited in". It changes the page on claude.ai only; nothing is replayed.

Mentions anywhere else (a pasted list, `list_artifacts` results, an `Artifact` open) don't link. A chat that only opened an artifact isn't "Made in".

### Viewer
- **One page.** The chat viewer gains an **Artifacts** entry in its sidebar (with the count), opening the v1.16 grid inside the chat viewer's shell. The chat viewer's behaviour is otherwise unchanged. An export without artifacts (setting off, or an older archive) has no Artifacts entry.
- **Tabs:** All / Yours / Shared with you (claude.ai's list, as v1.16) and **In chats** with its count.
- **All:** v1.16 cards plus a source line: 💬 with the number of linked chats, else Cowork, Code or Shared with you. A card whose file also appears in a chat says "also in chat".
- **Artifact page:** as v1.16, plus a line under the top bar: "Made in" / "Published in" / "Edited in" with each linked chat (a link to that chat at the linking message), and a version menu when chats published more versions of it than the current one (each opens that version's saved copy in `published/`).
- **Docs:** when a linked chat rebuilt the document, the Docs page shows that text (the chat's last version of it, through the chat viewer's Markdown renderer and `sanitizeHtml`), with the note "Rebuilt from the chat. Edits made on claude.ai aren't included." Otherwise the v1.16 Docs page.
- **In chats tab:** one card per file Claude made in a chat, across all chats in the export, newest first (by the message that made its last version), each with the chat's name and a kind tile:
  - Kinds and filter chips: Pages (`.html`), Docs (`.md` and Claude Docs), Diagrams (`.svg` and widgets), Code, Other. Counts per chip.
  - One card per file, not per version; the page's version menu lists the versions.
  - Not listed: uploads and pasted attachments, missing files, `published:` cards, and a file a chat published whose page is under All with the version that is the same as this file (`same`); that card says "also in chat" instead.
  - A click opens the file full page like an artifact page (same preview sandbox as v1.16's artifact page), with "Made in" linking to the chat.
  - Search on the Artifacts screen searches the current tab's titles (file names on In chats).
- **In a chat:** a published page's card gets **Open artifact** when that page is in the export's artifacts, opening its artifact page.
- **Routing:** `#a=<shortId>` an artifact (v1.16), a new hash for an In-chats file, and the chat viewer's existing routes. Back from an artifact returns to the grid; from "Made in" back returns to the artifact.
- **Not unzipped:** as both viewers today (`viewer-check.gif`): the grid renders, pictures fall back to tiles, opening a preview says to unzip.

### Data
- The viewer reuses what each export already produces: the chats' viewer data (files, versions, parts) for In chats and Docs text, and v1.16's `ArtifactView` records and parts for artifacts. Nothing is copied into a second store.
- `ViewerData` gains `artifacts` (the v1.16 records) and per artifact `links: [{ chat, messageUuid, how }]` (how: made, published, edited); the chat's published cards get the artifact's id when it's in the export.

## Non-goals
- Docs' live text from claude.ai (only the chat's rebuild).
- Small live previews on cards.
- Artifact version history beyond the versions chats published.
- Cowork and Claude Code sessions as chats.
- Artifact titles in the sidebar's chat search.
- Changing the standalone Export Artifacts export or its viewer.
- Old-archive tool support for combined archives (v1.18).

## Anti-goals
- A chat export that is slower to start, fails, or loses files because the artifact step failed.
- The same uuid and version fetched or stored twice.
- All / Yours / Shared with you showing anything claude.ai's list doesn't.
- The picture URL, asset token or any frame URL in any written file (v1.16's rule).
- An artifact's code reaching the viewer, chats, other artifacts or files on disk (v1.16's sandbox).
- A chat linked to an artifact it only mentioned.

## Constraints
- **No `file:` navigation from artifact previews.** v1.16 relies on the page's `frame-src 'none'` (viewer/artifacts-template.html) so a preview, including another person's shared artifact, can't move its frame to a `file:` URL; the chat viewer's page has `frame-src file:` (viewer/viewer-template.html). The combined viewer must keep v1.16's guarantee for artifact previews (the artifacts e2e `refusedFor` checks pass unchanged). How is the builder's call (for example, narrowing the page's `frame-src` if the chat viewer's file frames can work another way, or another mechanism Chrome enforces); if no mechanism holds, stop and ask rather than weaken it. In-chats previews of the owner's own chat files keep the chat viewer's current rules (documented in USAGE).
- The chat viewer page's CSP otherwise stays as it is; artifact and In-chats previews use v1.16's preview sandbox (`allow-scripts allow-forms allow-modals`, `PREVIEW_CSP` first, storage stand-in, WebRTC constructors removed). `tests/e2e/viewer.e2e.js` and `tests/e2e/artifacts-viewer.e2e.js` must pass.
- Viewer code never contains `claudeusercontent`, `__frame_t` or `_thumb` (v1.16's scan rule).
- Folder mode keeps its per-chat and per-artifact flush and memory bound.
- The manifest bump is 1.17.0, with README, USAGE, TECHNICAL and CLAUDE.md (§2, §7, §8).

### Old-archive tools (my call, recommended when the owner asked; to confirm on approval: refuse now, support in v1.18)
- `tools/build_viewer.js` and `tools/merge_archives.js` refuse an archive that has an `artifacts/` folder or `export-manifest.json` `artifacts`, before writing anything, with: "This archive includes artifacts (Claude Takeout 1.17 or later). build_viewer/merge_archives don't support those yet; its viewer.html is already complete." (exit code non-zero; `--json` reports it as a refused archive). In a merge with several sources, the refusal names the source and nothing is written.
- The `build-archive-viewer` skill and USAGE say so.
- Teaching both tools about `artifacts/` (rebuilding the Artifacts screen from disk; merging newest per uuid) is v1.18.

## Left to the builder
- How the chat viewer and `artifacts-app.js` are joined (one script, or the artifacts app loaded as a second script sharing `viewer-logic.js`), as long as one `viewer.html` results, with one part numbering and one `window.__archivePart` loader across chats and artifacts (both number from 1 today), keeping folder mode's flush order.
- The In-chats hash format, tile colours, the "also in chat" wording, and the source-line wording.
- Tests: unit for linking (each rule, and the non-links), dedup with `published/` and with `same` versions, the tools' refusal, Export Changes for artifacts, the reserved folder name, the setting off; e2e for the sidebar entry, In chats tab and filter, Made-in navigation both ways, the Docs page with chat text, Open artifact from a chat card, an export with the setting off, and no network requests.
