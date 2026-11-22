# Download in the viewer, and a ZIP per artifact (v1.19.0)

Date: 2026-11-22. Status: for the owner's approval (builder check done; findings settled below, marked *my call*).

## Intent

The owner wants to save files out of `viewer.html`: uploads, files Claude made, published pages and artifacts, HTML and SVG included (downloading doesn't run them). The viewer opens from `file://`, where Chrome ignores `<a download>` on a link to a file on disk and opens it instead (tested 2026-11-22: an HTML file would load and run). A `blob:` link with `download` works, from the page and from a sandboxed frame, headless and headed. A plain link to a `.zip` on disk downloads it without navigating (tested). The viewer can't read files from disk, so it can only download bytes it already holds.

So: per-file **Download** from bytes the viewer holds, and for an artifact with several files, a ZIP the extension writes at export time, linked from the viewer.

## Owner decisions (2026-11-22)

- Download button in file popups and on artifact pages, HTML/SVG included.
- Per file, not a whole artifact from the viewer; no ZIP code in `viewer.html`.
- The extension pre-zips multi-file artifacts at export time ("can we pre-zip via the extension" — yes); the viewer links the ZIP.
- Order: v1.19 = this; v1.20 = the `needsRuntime` false positive and the Design canvas view.

## Goals

### Download (viewer)
- A **Download** button, beside Copy / Open file, wherever the viewer holds a file's full contents:
  - chat viewer popups: uploads and pasted attachments with text (inline, or after their `viewer-files/` part loaded), generated files and each of their versions (text), published-page cards' files when their text is held;
  - Artifacts screen: the artifact page's top bar (the file being shown) and each row of its file list whose text or image the viewer holds (preview payload `texts`, `images` as data URLs).
- The click builds a `Blob` from those bytes, makes a `blob:` URL, clicks a temporary `<a download="<name>">`, and revokes the URL afterwards. Text is saved as UTF-8; an image from its data URL's bytes.
- The Blob's type is `application/octet-stream` for everything, so no file is ever shown or run by the browser on the way out. *My call.*
- The file name is the file's own base name (last path segment), cleaned of characters that aren't allowed in file names; never a path. *My call.*
- No Download where the viewer holds no bytes: images, PDFs and other binaries the viewer only links to (Open file stays, behind `openableHref`), a part that failed to load, a missing file. No new message; the button just isn't there.
- Downloaded text is the text the viewer shows (the same as Copy). *My call* (a `.md` the export wrote with a BOM downloads without it).

### A ZIP per multi-file artifact (export)
- Export All and Export Artifacts write `artifacts/<Title>_<shortId>/<ver>.zip` (Export Artifacts: `<Title>_<shortId>/<ver>.zip` under its root) for the **current** version when that version has its own `<ver>/` folder with **two or more** saved files. Older versions and one-file versions get none. *My call.*
- Contents: the version's saved files at their saved names (`savedAs`), relative to `<ver>/`, byte for byte. Built with the extension's JSZip from the bytes already in hand when the version is written; nothing is fetched again.
- `artifact.json` format 2 gains, on that version, `zip: "<ver>.zip"` (only when written). Readers that don't know it ignore it. A version saved incomplete still gets a ZIP of what was saved; `incomplete` already says so.
- Export Changes writes the ZIP whenever it writes that artifact's current version. Single-chat ZIPs (`published/`) get none.
- The ZIP is never counted as an artifact file (not in `files`, not hashed into `sha256`), and the folder-name rules keep `<ver>.zip` from colliding with a `<ver>/` folder name.

### Viewer link to the ZIP
- The artifact page's top bar shows **Download ZIP** when the current version's `zip` is set. It is a plain relative link (`<a href>`), allowed by `openableHref` (`.zip` is on the list). When the version is incomplete, the label says "Download ZIP (some files missing)". *My call.*
- Published cards in chats don't get the ZIP link (they show one published version, often not the current one). *My call.*

### Old-archive tools
- `build_viewer.js`: passes `zip` through when the file exists as a real file under the artifact folder (`realFileUnder`); otherwise leaves it out.
- `merge_archives.js`: when it takes the merged artifact's current version whole from a source, it copies that source's `<ver>.zip` too if the source's `artifact.json` names it and it is a real file; no ZIP otherwise (the tools don't write ZIPs). The copied ZIP is checked to be a ZIP (leading bytes `PK\x03\x04`) and nothing else; a failure leaves it out with a line in the report.

### Settled at the builder check (*my calls*)
- **When a version gets a ZIP:** decided from the version's final record, when its `artifact.json` is written (after any `sameAs` or `incomplete` change), in the one store writer both exports share. It needs a `<ver>/` folder and two or more files saved in it (`savedAs` set). A `sameAs` version has no folder and gets none; a multi-file `same` version is copied into `<ver>/` (v1.18) and counts. An incomplete version with two or more saved files gets one; with one, none. The ZIP holds only files in `<ver>/`, never chat files.
- **Name and staleness:** the ZIP is `<folder>.zip` beside `<folder>/` (folder = `publishedSegment(ver)`; version ids and `current` never end in `.zip`). Every export writes into a new run folder, so no stale ZIP is left; merge copies only the merged current version's ZIP, so a merged archive has no ZIP for an older version.
- **Old-archive scanning:** `scanAdded` already treats artifact folders as the export's, so a ZIP there is never an owner-added file. A ZIP not named in `artifact.json` is ignored (no link).
- **Which bytes count as held:** text inline, or a `viewer-files/` part once loaded (the button appears when the text arrives, as the text itself does; it never starts a load), and preview images held as data URLs. The same in the standalone Artifacts viewer and the Artifacts screen inside the chat viewer. A `sameAs` version whose text the viewer holds can be downloaded.
- **File name:** the name the viewer shows for that file, so a generated file's version downloads as `report_v2.html`.
- **Where:** the button lives in the viewer page only, never inside a sandboxed preview frame; the preview sandbox is unchanged (no `allow-downloads`). The e2e test runs against the real viewer CSP.
- **Deterministic ZIPs:** fixed entry order (the version's file order), DEFLATE, and every entry dated from the artifact's `updatedAt` (else 1980-01-01), so the same input gives the same bytes and the baseline can pin the ZIP.

## Non-goals
- Building ZIPs in the viewer or in the Node tools.
- ZIPs of older versions, of single-chat `published/` pages, or of chats.
- Downloading files the viewer only links to.

## Anti-goals
- Any downloaded or linked file opening or running in the viewer's origin.
- A path, URL, token or frame URL in a ZIP's names or in `artifact.json`'s `zip`.
- `viewer.html` growing by a ZIP library.
- A ZIP whose contents differ from the version's saved files.

## Constraints
- `manifest.json` 1.19.0; README changelog; USAGE (viewer: Download, Download ZIP; layout: `<ver>.zip`); TECHNICAL; CLAUDE.md (§7 layout and `artifact.json` fields).
- `tests/fixtures/export-baseline.json` refreshed for the new ZIP.
- The viewer page's CSP must allow the `blob:` download link (check; adjust only if needed, and say so).

## Left to the builder
- Button placement and styling (match Copy / Open file).
- How the viewer reaches a held file's bytes in each place.
- Tests: unit for when Download shows and its file name; `artifact.json` `zip` only for current multi-file versions; ZIP contents equal the saved files; Export Changes; merge copies or omits the ZIP; build_viewer passes `zip` only for a real file; e2e: Download of HTML, SVG, text and an image saves the right name and bytes with no navigation, no network and nothing run; Download ZIP downloads the file; token scan of the ZIP's names.
