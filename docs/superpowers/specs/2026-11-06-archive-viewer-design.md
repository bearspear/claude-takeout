# Viewer for older archives design

## Intent

The owner has older Claude Takeout archives, some kept in cloud storage and pulled down by hand. v1.6 gives new exports a `viewer.html`, but old archives don't have one. This work gives them the same viewer, so an old chat can be reread as it was. The owner's words: "recreate the original chat", and it "should adjust to the reality at hand": cope with export version bumps, renamed folders, and whatever is really in each archive.

## Success

Run it on a folder of old exports, and each one opens in the same viewer as a new export, with its chats, generated files, uploads and project files. Files the owner added to an archive later are reachable from the viewer too. Whatever can't be found is reported, not silently dropped.

## Goals

- `tools/build_viewer.js <folder>`: finds every Claude export under a folder, single-chat or mega, whether unzipped or a ZIP, and gives each a viewer.
- A chat is found by its `original.json`, so folder names don't matter. (Owner: handle renamed folders.)
- Each archive gets its own viewer. A mega-ZIP gets one viewer with all its chats, as in v1.6. (Owner approved in chat.)
- Same viewer as v1.6: same page, features and look.
- Text of generated files is rebuilt from `original.json`, so it works even if a file is gone from `artefacts/`. Binaries and uploads need the real file.
- Older layouts work, including mega-ZIPs with no shared `projects/` folder, and project files in each chat's `project/`.
- Files the owner added show in the viewer: an "Archive files" section listing folders like `synthesis/`, `analysis/`, `studies/`, `diagrams/`, `outlines/`, and root files like `_index.md`, which open in place. (Owner: it should adjust to the reality at hand.)
- A report per archive: chats found, viewer written, files missing, what was skipped.
- Then a `build-archive-viewer` skill wrapping the tool: find exports in a folder the owner names, unzip, check, search local folders for missing files, confirm, build, report.

## Non-goals

- Cloud access. The owner downloads archives by hand.
- Re-downloading from claude.ai.
- One viewer spanning several archives. Possible later.
- Gemini or other exports. They're skipped and reported.
- A button in the extension.

## Anti-goals

- Changing, moving or deleting any existing archive file. The owner's added work is irreplaceable.
- Touching an original ZIP.
- Claiming a file matches on name alone. Files found by search are copied only after the owner confirms each one.
- Added files gaining more trust than generated ones: added HTML and SVG are untrusted, and run only under the v1.6 preview sandbox.

## Constraints

- Offline from `file://`, as v1.6. Page code can't read local files, so text must be embedded or loaded as a local script.
- Size. Five archives hold 2,666 added files: 2,446 Markdown (102 MB), 38 PDFs (699 MB), images, audio and video, 1.2 GB overall. Added files can't all be embedded in `viewer.html`.
- Exports stay byte-identical. The extension's output must not change, so shared code is moved without behavior change, and the JS and Python parity tests keep passing.
- Tests use synthetic data only. Never commit real chats.
- Node 20+ with no packages to install, and ZIP reading must not add a dependency to the extension. The owner's Mac has `unzip`, which failed on one non-ASCII name in a restricted shell, so the tool needs a reliable route for names like `Gödel`.
- Extracted archives are untrusted data: pass paths as arguments, and reject ZIP entries that leave the target folder.

## How it gets made (builder's calls, for the owner to check)

- Reuse `takeout-viewer.js` and the `viewer/` page unchanged where possible, as the same code path as exports.
- Move the pure extractors the viewer needs out of `popup.js` into a shared file, loaded by both the extension and the tool. The existing tests prove no behavior change. Only what the viewer needs moves; `convertToMarkdown` and the export writers stay. The tool's viewer data matches an export's for the same synthetic chat.
- Added text loads on demand from small local script files beside the viewer, in a `viewer-files/` folder, so `viewer.html` stays small. Adding that folder is the one new thing written into an archive, beyond `viewer.html` and `viewer-check.gif`.
- Added Markdown renders with the chat pipeline. HTML and SVG use the sandboxed preview. Images, PDFs, audio and video open from their relative paths.
- Unzipped archives get the viewer written beside their files. ZIPs unzip into a new folder, named after the ZIP, in an output folder the owner picks. An existing `viewer.html` is skipped unless a `--force` flag is given.
- `--dry-run` reports what would happen and writes nothing.

## Details

**What counts as one archive (builder's call).** A folder holding `index.md` and chat folders with `original.json` is one mega archive, including old ones with no `projects/`. Any other folder with `original.json` is its own single-chat archive. So a parent folder of separate exports gets one viewer per chat. A mega archive's viewer is at its root.

**What counts as an added file (builder's call).** Anything in an archive root or chat folder that isn't in the export layout: known files are those in `CLAUDE.md` §7, plus `viewer.html`, `viewer-check.gif` and `viewer-files/`. Inside known folders like `uploads/`, nothing is listed as added. `.DS_Store` and similar system files are ignored. A loose ZIP inside an archive is listed, not opened.

**Matching.** Uploads match by exact expected name, then by a loose name match that ignores case and punctuation, as older names vary. Two candidates for one file count as no match, and go in the report.

**Skipping.** A folder with `conversation.json`, or an `original.json` with no `chat_messages`, is not a Claude chat. It is skipped and reported.

**Version bumps.** Newest fields are read defensively. An odd message shape loses that message's detail, never the chat or the run.

**Missing files (builder's call).** The skill does the search and confirmation. After a yes, it copies the file into that chat's expected folder under the expected name, never over an existing file, then runs the tool. The tool itself never searches or copies. Copying adds a file; it changes no existing one.

**Replacing a viewer (builder's call).** A generated `viewer.html` carries a marker. By default any existing viewer is skipped, including v1.6's. `--force` replaces only a marked viewer, with its `viewer-check.gif` and `viewer-files/`. An unmarked `viewer.html` is never replaced, and the report says so.

**ZIPs (builder's call).** A ZIP is extracted in full, because the viewer opens binaries by relative path. The tool checks free disk space first, and stops that archive with a clear message if it's short.

**Failure.** One bad archive is reported and the run continues. The exit code says if anything failed.

## Left to the builder

Script-file sizes and how they're split, search over added files, section placement within the look already approved, report format, and the order of work.

## Testing

Synthetic fixtures for each layout: single, mega, old mega, renamed folder, added files, Gemini folder, ZIP with a non-ASCII name, ZIP with a path that escapes. A test proves every pre-existing file is byte-identical after a run. The owner then runs it on real archives, oldest first, starting with one holding `synthesis/`.
