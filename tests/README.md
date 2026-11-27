# Tests

```sh
sh tests/run.sh
```

Needs Node 20+ and Python 3.10+, with no packages to install.

| File | Covers |
|---|---|
| `helpers.js` | Not a test: loads the real `popup.js` in a VM with stubbed Chrome and DOM APIs, plus the fake claude.ai frame host (`publishedFetcher`) |
| `background.test.js` | `background.js`: the two side-panel toggles, every other message left alone, no Side Panel API, the stored preference applied on start |
| `panel.test.js` | Side panel following the selected chat, refreshes and content script recovery, `content.js` (published pages, artifact lists, sessions) |
| `screens.test.js` | The panel's screens: their sentences, the markup of both pages (identical, ids, colours), counts, folder handoff, the screens driven against fake elements |
| `export.test.js` | Artifact replay, heredocs, failed tool calls, binaries, delivered files, warnings, published pages, Export Artifacts and Export All's artifacts, card pictures, and JS and Python parity |
| `session.test.js` | Claude Code and Cowork sessions: the `session-core.js` filter, stripping and masking, transcript and README, `buildViewerSession`, the record |
| `fixtures/conversation.json` | The synthetic chat most tests export |
| `fixtures/export-baseline.json` | SHA-256 of every file an export writes for the fixture (dates scrubbed, `viewer.html` and `viewer-check.gif` left out), checked by `export.test.js` |
| `package.test.js` | `tools/package_extension.js`: every file the extension references is packaged, no developer files, the ZIP holds exactly the list |
| `test_replay_bash.py` | `replay_bash.py` replay order and containment |
| `viewer.test.js` | Viewer tree, hash, Markdown steps and data building |
| `archive.test.js` | Old-archive tool: finding archives (an Export Artifacts folder holds none), ZIP extraction, added files, `--force`, and that existing files stay unchanged, every artifacts layout (`readArtifactStore`, `artifactViewsFromDisk`), real-folder-only path resolution, `rewriteChatLinks`, and an Export Artifacts folder with a viewer being read as an artifacts-only archive |
| `merge.test.js` | `merge_archives.js`: newest copy per chat, the artifacts store from every source layout (newest source per version, `listed` rules, `sameAs` re-pointing, copies), link rewriting and unmapped links, kept `published/` folders, copy failures, artifacts-only archives |
| `e2e/` | Real extension in Chromium against a mock claude.ai, and viewer pages over `file://` (optional, see below). Each file is listed in CLAUDE.md's file map; `hostile.js` holds hostile-input fixtures and `make-viewer.js` builds a viewer to check by eye |

`test_replay_bash.py` makes real attempts to escape the sandbox, so its replay tests run only where `sandbox-exec` exists.

## Export baseline

`export.test.js` hashes every file `populateConversationFolder` writes for the synthetic fixture and compares it with `fixtures/export-baseline.json`. The test runs the export with `TZ=UTC` (put back afterwards), because `formatTimestamp` prints local time, so it passes in any time zone. Regenerate the manifest in any zone. A failure means an export's output changed. If the change is intended, refresh the manifest, then read the diff of the JSON to see which files moved:

```sh
UPDATE_EXPORT_BASELINE=1 node --test tests/export.test.js
```

## Private data

Never add real conversations or exports here. `fixtures/conversation.json` is synthetic, so add new scenarios to it.

To compare the JS and Python replay on your own exports, without copying them into the repo:

```sh
TAKEOUT_EXPORT_DIR=/path/to/unzipped/mega-zip node --test tests/export.test.js
```

## Browser tests

These need `playwright-core` and a Chromium binary, neither of which is a dependency of this project:

```sh
PW=/path/to/node_modules/playwright-core CHROME_EXE=/path/to/Chromium node tests/e2e/export.e2e.js
PW=/path/to/node_modules/playwright-core CHROME_EXE=/path/to/Chromium node tests/e2e/panel.e2e.js
PW=/path/to/node_modules/playwright-core CHROME_EXE=/path/to/Chromium node tests/e2e/viewer.e2e.js
PW=/path/to/node_modules/playwright-core CHROME_EXE=/path/to/Chromium node tests/e2e/archive.e2e.js
PW=/path/to/node_modules/playwright-core CHROME_EXE=/path/to/Chromium node tests/e2e/artifacts-viewer.e2e.js
PW=/path/to/node_modules/playwright-core CHROME_EXE=/path/to/Chromium node tests/e2e/artifacts.e2e.js
PW=/path/to/node_modules/playwright-core CHROME_EXE=/path/to/Chromium node tests/e2e/cards.e2e.js
PW=/path/to/node_modules/playwright-core CHROME_EXE=/path/to/Chromium node tests/e2e/colors.e2e.js
PW=/path/to/node_modules/playwright-core CHROME_EXE=/path/to/Chromium node tests/e2e/combined.e2e.js
PW=/path/to/node_modules/playwright-core CHROME_EXE=/path/to/Chromium node tests/e2e/design.e2e.js
PW=/path/to/node_modules/playwright-core CHROME_EXE=/path/to/Chromium node tests/e2e/download.e2e.js
PW=/path/to/node_modules/playwright-core CHROME_EXE=/path/to/Chromium node tests/e2e/files.e2e.js
PW=/path/to/node_modules/playwright-core CHROME_EXE=/path/to/Chromium node tests/e2e/navigation.e2e.js
PW=/path/to/node_modules/playwright-core CHROME_EXE=/path/to/Chromium node tests/e2e/parts.e2e.js
PW=/path/to/node_modules/playwright-core CHROME_EXE=/path/to/Chromium node tests/e2e/projects.e2e.js
PW=/path/to/node_modules/playwright-core CHROME_EXE=/path/to/Chromium node tests/e2e/prompts.e2e.js
PW=/path/to/node_modules/playwright-core CHROME_EXE=/path/to/Chromium node tests/e2e/published.e2e.js
PW=/path/to/node_modules/playwright-core CHROME_EXE=/path/to/Chromium node tests/e2e/search.e2e.js
PW=/path/to/node_modules/playwright-core CHROME_EXE=/path/to/Chromium node tests/e2e/sessions.e2e.js
PW=/path/to/node_modules/playwright-core CHROME_EXE=/path/to/Chromium node tests/e2e/stepper.e2e.js
PW=/path/to/node_modules/playwright-core CHROME_EXE=/path/to/Chromium node tests/e2e/steps.e2e.js
PW=/path/to/node_modules/playwright-core CHROME_EXE=/path/to/Chromium node tests/e2e/webimages.e2e.js
PW=/path/to/node_modules/playwright-core CHROME_EXE=/path/to/Chromium node tests/e2e/zoom.e2e.js
```

`combined.e2e.js` covers an Export All's viewer with artifacts, and `design.e2e.js` the Design canvas. Both launch Chromium with `--disable-features=IsolateSandboxedIframes`: Chrome gives sandboxed frames processes of their own, and Playwright doesn't attach to a sandboxed frame inside another (the preview in its guard frame), so its console, requests and frame would go unseen. In one process they are seen; the sandbox, origin and policies are the same either way.

`export.e2e.js` and `panel.e2e.js` load the repo as the extension; with `EXT_DIR=<folder>` they load that folder instead, such as a release ZIP from `node tools/package_extension.js` unzipped, to check the package runs.

`viewer.e2e.js` is the only coverage for `sanitizeHtml`, so run it after changing anything in the viewer.

`node tests/e2e/make-viewer.js <original.json> <out.html>` builds a viewer from one exported chat so you can check the page by eye. Keep the output out of the repo, since it holds the chat.

## What these can't prove

The mock can't show claude.ai's real behavior, and that has caused bugs here before. After changing fetching or capture, also export a real conversation and validate it.
