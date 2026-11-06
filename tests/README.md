# Tests

```sh
sh tests/run.sh
```

Needs Node 20+ and Python 3.10+, with no packages to install.

| File | Covers |
|---|---|
| `panel.test.js` | Side panel following the selected chat, refreshes and content script recovery |
| `export.test.js` | Artifact replay, heredocs, failed tool calls, binaries, delivered files, warnings, and JS and Python parity |
| `fixtures/export-baseline.json` | SHA-256 of every file an export writes for the fixture (dates scrubbed, `viewer.html` and `viewer-check.gif` left out), checked by `export.test.js` |
| `test_replay_bash.py` | `replay_bash.py` replay order and containment |
| `viewer.test.js` | Viewer tree, hash, Markdown steps and data building |
| `archive.test.js` | Old-archive tool: finding archives, ZIP extraction, added files, `--force`, and that existing files stay unchanged |
| `e2e/` | Real extension in Chromium against a mock claude.ai, and the viewer page over `file://` (`viewer.e2e.js`: rendering, previews, `sanitizeHtml`) (optional, see below). `archive.e2e.js` opens a viewer the old-archive tool built |

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
```

`viewer.e2e.js` is the only coverage for `sanitizeHtml`, so run it after changing anything in the viewer.

`node tests/e2e/make-viewer.js <original.json> <out.html>` builds a viewer from one exported chat so you can check the page by eye. Keep the output out of the repo, since it holds the chat.

## What these can't prove

The mock can't show claude.ai's real behavior, and that has caused bugs here before. After changing fetching or capture, also export a real conversation and validate it.
