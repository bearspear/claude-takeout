# Panel redesign (v1.22.0)

Owner asked 2026-11-24 for a redesign of the extension's popup and side panel. Boards on the design canvas (private artifact, owner's account): <https://claude.ai/artifact/6qFovU3tamE4iyQ2ot9dw7>. Three reviews (coverage, usability and accessibility, feasibility) were folded in; the owner accepted the three defaults below ("yes", 2026-11-24).

## Why

Today's panel is a stack of ten buttons of equal weight ("Export Current (Markdown)", "Export All (Embedded)", "Export Artifacts (Folder)" …) with the choices that change what they do (scope, folder or ZIP, artifacts) hidden in the settings drawer. A user can't tell which button they want, or what Export All will do, without opening settings. The redesign splits the panel into **this chat** and **everything on claude.ai**, puts the choices beside the one button they affect, and gives the long exports their own progress and result screens.

## Goals

- Two sections: **This chat** (one primary action, Export ZIP, plus Markdown, Markdown + files, JSON) and **Everything on claude.ai** (one action, Export selected, with its choices beside it).
- The panel says plainly whether this chat can be exported (green card), why not (grey card), and what a single-chat export just saved.
- A long export has a screen of its own with steps, a way to stop, and a result screen that says where it went and what went wrong.
- Opening the panel makes no more calls to claude.ai than today.
- Accessible: WCAG AA text contrast, 3:1 for control borders, visible focus, targets at least 32 px, live regions for status.

## Non-goals

- No change to what any export writes (layouts, file names, `errors.txt`, viewer), except the bulk formats dropped below.
- No new permissions. In particular no `downloads` permission, so no "Show folder" or "Open file" buttons.
- No time-left estimate.
- No dark theme (the panel has none today).

## Anti-goals

- Counts that call claude.ai on every tab change (`requestData` runs on `tabs.onActivated` / `onUpdated`).
- A combined Export that silently writes something different from what the checkboxes say.
- Breaking the popup → side panel handoff for folder exports.

## Owner decisions (2026-11-24)

1. **Bulk Markdown, Embedded and JSON exports are dropped** (`exportAllMd`, `exportAllEmbed`, `exportAllJson` → `bulkExport`). Export All is the folder or ZIP export only. Changelog says so, and points to the per-chat Markdown and JSON files every export already has.
2. **"Changes only" needs Chats.** With only Artifacts ticked, Changes only is disabled (shown struck through) and the run is a full artifacts export. No artifacts-only change record is built.
3. **Chats only still saves published pages.** Pages a chat published go into `artifacts/` with Artifacts unticked, as today with `exportAllArtifacts` off; the Chats row says so when Artifacts is unticked.

## Screens

All screens are 340 px wide in the popup and fill the side panel (320–400 px). Header on every screen: "Claude Takeout", a Refresh icon button (Alt+R, 40 px) and a Settings icon button (40 px). Purple `#7c3aed` stays the brand color. `:focus-visible` outline 2 px `#4c1d95`, offset 2 px, everywhere. Dates: `YYYY-MM-DD HH:MM` in text; folder names keep `exportStamp`'s form.

### Main, ready (board "Proposed: ready")

**This chat** section:
- Green card (`#e8f5e9`, border `#c8e6c9`, check icon): "Ready to export", the chat title (one line, ellipsis, full title in `title`), and "<model> · <N> messages · <N> files". "Files" is what `extractArtifacts` finds in the chat; the word "artifacts" is kept for claude.ai's artifacts.
- A `role=status aria-live=polite` line in the card shows a single-chat result: "Saved Markdown, 84 KB", "Saved ZIP, 2.1 MB", or amber with "N warnings" when `chatHealth` or the collector found any (the card then turns amber: `#fffbeb`, border `#fde68a`, text `#78350f`).
- **Export ZIP** button: 44 px, filled purple, "Alt+Z" at 12 px.
- "Also as" row, wrapping: three pill buttons 32 px tall, border `#6b7280`: **Markdown** (Alt+M), **Markdown + files** (today's Embedded, Alt+E; tooltip "Markdown with the chat's files written inline"), **JSON** (Alt+J). Shortcuts in each `title`; with Show keyboard shortcuts on, also shown after the label.

**Everything on claude.ai** section (separated by a 6 px `#f3f4f6` band):
- Heading row with a **Count** button (32 px, outlined). Until clicked the counts show "–". Clicking fetches the chat list and the artifact list once, shows the numbers and "Counted HH:MM", and caches them for the panel's life (and in `chrome.storage.session`, 10 minutes). Never fetched by `requestData`.
- Segmented control "All" / "Changes only" (`aria-pressed`). Changes only is **hidden** when there is no export record for this org, and **disabled** when only Artifacts is ticked (decision 2).
- Checkbox rows, 40 px tall, 18 px boxes, whole row clickable:
  - **Chats**, sub-line "With their files and pages", or with Artifacts unticked "Pages they published still go in artifacts/" (decision 3). Count on the right.
  - **Artifacts**, sub-line "Every version claude.ai keeps". Count on the right.
- "Save as" Folder / ZIP segmented control (`aria-labelledby` its label).
- **Export selected** button: 44 px, outlined (2 px `#7c3aed` border, text `#5b21b6`, white), "Alt+A". Fixed label; counts are in the summary below. Disabled look: `#f3f4f6` fill, `#d1d5db` border, `#4b5563` text, `aria-describedby` the summary.
- Summary line (`id=summary`), built from the choices: counts when counted ("27 chats and 19 artifacts." / "3 changed chats and 2 changed artifacts."), the scope ("Everything, whatever was exported before." / "Only what changed since the last Export All, 2026-11-23 09:51."), the destination ("Into a new folder inside one you pick, written as it goes. From the popup, this continues in the sidebar." / "One ZIP download when it finishes."). Disabled reasons: "Tick Chats or Artifacts." and, when counted with Changes only and nothing changed, "Nothing changed since 2026-11-23 09:51."
- Footer: "Last export 2026-11-23 09:51 · no warnings" (or "· N warnings"), and Help (padded to 28 px). Hidden with no record.

### No chat open (board "Proposed: no chat open")

Grey card (`#f3f4f6`, info icon) with the reason, `role=status`:
- On claude.ai, no chat in the URL: "Open a chat to export it".
- Not on claude.ai: "Open claude.ai to export." Everything is disabled as well.
- Chat failed to load: "Couldn't load this chat" with a Try again link (runs Refresh).
Export ZIP and the three pills are disabled (grey, `aria-describedby` the card). Everything works on any claude.ai page.

### Sidebar after a popup folder export (board "Proposed: sidebar after popup folder export")

Today, a folder export clicked in the popup opens the side panel, which must take the click (Chrome lets only a page with a user gesture pick a folder). New: the side panel opens with a purple note (`#f5f3ff`, `role=status`): "Continued from the popup. Chrome lets only the sidebar pick a folder. Your choices came along: <scope>, <chats/artifacts>, Folder. Click Export selected to pick where it goes." The This chat section is folded until the export starts or the note is dismissed; Export selected is filled purple here with a 4 px `#ddd6fe` ring. The choices travel in storage, not in the button label (today's `FOLDER_LABEL_RE` match goes away).

### Exporting (board "Proposed: exporting")

Replaces the panel's content while an Everything export runs. Refresh and Settings disabled.
- Card (`#f5f3ff`): "Exporting 27 chats and 19 artifacts", "Saving to <run folder or ZIP name>" (wraps anywhere).
- Steps list: **Chats** n of N, **Artifacts** n of N, **Viewer and index**; done = green check, current = purple ring with bold label, a `role=progressbar` bar and an `aria-live=polite` sub-line ("<artifact title> · version 9 of 17", or the chat title), pending = grey ring. Steps for unticked parts are left out.
- `role=status` amber strip "N warnings so far" when there are any.
- **Stop** button (44 px, outlined). Stop finishes the file being written, ends the run, keeps what was saved, records none of it, and shows the Export stopped screen with the reason "You stopped it".
- Note: "Stop keeps what is saved so far and records none of it. Other exports wait until this one ends. Keep the claude.ai tab open."
- Footer: "Started HH:MM". No time-left estimate.

Single-chat exports keep today's inline progress bar in the This chat section; they don't take over the panel.

### Done (board "Proposed: done, with warnings")

- Card, green with check when no warnings ("Done"), amber when there are ("Done, with N warnings"), `role=status`.
- "27 chats and 19 artifacts (49 versions) saved to", then the run folder name in its own box (wraps anywhere), then "inside the folder you picked. Open viewer.html in it to browse." For a ZIP: "Saved to Downloads as <name>.zip."
- Up to 5 warnings as a list, grouped by type with counts ("1 upload could not be downloaded (Trip notes)"), then "and N more" if longer; then "What to do about each is in errors.txt and artifacts/errors.txt in that folder." (only the files that exist).
- **Back to export** (filled). The Done screen stays until Back is clicked or the panel is closed; tab changes don't replace it (today's `preserveStatus`).
- Footer: "Took N min N s".

### Export stopped (board "Proposed: export stopped")

Red card (`#fef2f2`, border `#fecaca`, text `#7f1d1d`, `role=alert`): "Export stopped", the reason in words with the code ("You stopped it", "The folder could not be written", "claude.ai's chat list could not be loaded (HTTP 500)"), what was saved and where, and "They are not recorded, so the next Changes only export takes them again." Then the fix ("Check the folder is still there and writable, then try again."). **Try again** (filled) reruns with the same choices; **Back to export** (outlined). A cancelled folder picker is not a failure: it returns to Main with the summary line "No folder picked." for 5 seconds.

### Settings (board "Proposed: settings")

Full screen with Back (44 px). Files: File names (select), Thinking blocks, Web images and card pictures ("Chrome asks once, during a ZIP export. If you say no, cards show tiles."). Panel: Open as sidebar, Show keyboard shortcuts. Note that scope, chats/artifacts and folder/ZIP live on the main screen. Footer: "Version <manifest version>" and a "What's new" link to the README changelog on GitHub.

## Settings and storage

- `megaZipScope`, `megaFormat`, `exportAllArtifacts` keep their names and storage; they are now set from the main screen. Add `exportAllChats` (default `true`).
- Drop `megaZipScope`'s relabeling of buttons. The keys `exportAllMd` etc. disappear from `EXPORT_BUTTONS`.
- `exportRecord[org]` gains `warnings` (number). A stopped or failed run writes no record, as today.
- Counts cache: `chrome.storage.session` `takeoutCounts[org] = { at, chats, artifacts, changedChats, changedArtifacts }`, 10 minutes.

## Mapping the Export selected button

| Chats | Artifacts | Scope | Runs |
|---|---|---|---|
| on | on | All / Changes | `bulkExportZip({ changesOnly, withArtifacts: true })` |
| on | off | All / Changes | `bulkExportZip({ changesOnly, withArtifacts: false })` (published pages still saved) |
| off | on | All only | `exportArtifacts()` (its own layout, `kind: "artifacts"`) |
| off | off | — | disabled |

`bulkExportZip` takes `withArtifacts` as an option instead of reading `settings.exportAllArtifacts` (popup.js ~4908). Folder or ZIP from `megaFormat` as today.

## Keyboard

Alt+Z ZIP, Alt+M Markdown, Alt+E Markdown + files, Alt+J JSON, Alt+A Export selected (was Export All Markdown), Alt+R Refresh. A keydown counts as a user gesture for the folder picker; the e2e test checks Alt+A in folder mode.

## Build notes (from the feasibility review)

- One page source for popup and side panel: `popup.html` and `sidepanel.html` differ only by width, box-sizing and a "Sidebar" badge. Make `sidepanel.html` the same markup with a class set from `IS_POPUP`, or generate one from the other; a test keeps them identical.
- Replace the `#progress` `display === 'block'` check in `scheduleRefresh` with an `exportRunning` flag.
- A progress emitter `{ phase, done, total, sub, warnings }` from `bulkExportZip`, `runArtifactStep` and `saveHistory` (which reports nothing today); `showProgress` becomes one listener.
- Stop: an `AbortController`-style flag checked between chats, between artifacts and between versions.
- Done's warning list: keep each chat's collector warnings (today thrown away) and the artifacts collector's, summarized by type.
- Tests pinning ids and labels to rewrite: `tests/export.test.js` (labels and markup for both pages), `tests/e2e/export.e2e.js` (`#exportAllZip`), `tests/e2e/panel.e2e.js` (`#exportZip`), `tests/helpers.js` fake elements.
- README (features, shortcuts, changelog v1.22.0), USAGE and TECHNICAL updated; manifest 1.22.0. The stale Export Artifacts tooltip ("The current version of every artifact") goes with the button.

## Calls made in review (mine, not the owner's; check these)

The builder check asked seven questions. None changes what the owner decided; each was settled toward "behave as today":

1. **What ends a run.** Same as today. A run ends in **Export stopped** only when today's code ends it with a red error (an exception out of `bulkExportZip` / `exportArtifacts`, the chat list failing, the folder failing to be written), or when the user clicks Stop. A 401 during the artifact step stays a warning: the run ends on **Done, with warnings**, and chats are recorded as today. The Failed board shows a folder write failure.
2. **Stop, folder mode:** files already written stay; no `viewer.html`, `index.md` or `export-manifest.json` is written for them; nothing is recorded. **Stop, ZIP mode:** the ZIP is discarded (nothing reaches disk before the end); the screen says "Nothing was saved. A ZIP is written only when the export finishes."
3. **Single-chat failures** stay in the This chat card (red variant: `#fef2f2`, `#7f1d1d`), never the Export stopped screen. The note on the Failed board saying otherwise is dropped.
4. **Try again** starts a new run with the same choices: folder mode opens the folder picker again and writes a new run folder. No resume.
5. **Counts are an estimate.** Export selected fetches the lists afresh, as today, and the Exporting screen shows the real totals. The summary keeps "Counted HH:MM" beside the counts so their age is visible. Count with Artifacts ticked may take a while; the button shows "Counting…" and is disabled meanwhile.
6. **"Since" date** is `exportRecord[org].at`, the last Export All (chats on). The summary says "since the last Export All, 2026-11-23 09:51". Artifacts-only runs don't move it and don't show in the footer. No separate artifact time.
7. **"N warnings"** (Done card, footer, `exportRecord.warnings`) = every chat collector's warnings and errors + chats that failed outright + write failures (`write-errors.txt` lines) + the artifacts collector's warnings + 1 if `viewer.html` could not be built. Same set the progress strip counts.

## Left to the builder

- Exact markup and CSS structure; whether the screens are sections toggled by a class or rendered by one function.
- Icon drawings (the boards use simple inline SVG strokes).
- Wording of reasons for failure codes not listed here, in the same style: what happened, what was saved, what to do.
