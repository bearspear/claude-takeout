# CLAUDE.md — Claude Takeout developer primer

A self-contained orientation document for any agent (human or LLM) picking up this codebase cold. Read this end-to-end and you should be ready to land a bug fix, enhancement, or feature without first having to spelunk through the source.

For deeper dives, two companion docs live alongside this one:
- `README.md` — user-facing feature list, install/usage instructions, changelog.
- `TECHNICAL.md` — long-form writeup: data loading, JSON structure, message chains, artifact versioning, files, citations, the ZIP, `errors.txt`, the viewer and the old-archive tool. Kept current; last checked at v1.23.0, its viewer section updated for v1.24.0, with sessions added for v1.25.0.

---

## 1. What this is

**Claude Takeout** is a Chrome Manifest V3 extension that exports Claude.ai conversations to Markdown, JSON, or comprehensive ZIP archives — single-conversation or all-conversations-at-once. It runs entirely client-side using your existing Claude session cookies; no API keys, no external servers.

- **GitHub:** `bearspear/claude-takeout` (push remote: `git@github.com-personal:bearspear/claude-takeout.git`).
- **Branch convention:** one branch per change, merged through a PR by the owner. Commit and push only with the owner's OK. Commit as `bearspear`; the repo's local git config is set for that.
- **Working dir on this machine:** `/Users/mbehringer/Downloads/claude-takeout`.
- **Versions:** `manifest.json` must not fall behind the newest README changelog entry, and a test enforces that. A PR adding a new changelog version bumps the manifest too. Tag releases `v<version>` on `main`.

---

## 2. File map (the whole repo)

| File | Role | Notes |
|---|---|---|
| `manifest.json` | MV3 declaration. | Hosts: `claude.ai/*`; optional `https://*/*`, only for saving web-search images and Export Artifacts' card pictures (`requestWebImages`, asked during a click; `askForCardPictures` in a ZIP export's click, only when not already granted; folder mode never asks). Perms: `activeTab`, `scripting`, `storage`, `sidePanel`. Web-accessible: `injected.js`. |
| `injected.js` | Page-context org ID fallback (runs in the page's world). | Wraps `window.fetch`, reads the org ID from request URLs, relays it via `window.postMessage`. |
| `content.js` | Isolated-world bridge (runs at `document_start`). | Loads once per tab (`globalThis.__claudeTakeoutContent`, ignored when left by a reloaded extension), so a re-injection adds no second listener. Injects `injected.js`, resolves the org ID, and exposes `getOrgId` / `fetchAllConversations` / `fetchConversation` / `listArtifacts` / `artifactThumbUrl` / `publishedPageInfo` / `publishedPageFile` to the popup via `chrome.runtime.onMessage`. The two published-page actions fetch a page's details and files from claude.ai's frame host; they keep the asset token to themselves and answer only with error codes, never URLs or messages. |
| `background.js` | MV3 service worker. | Only manages side-panel "open on action click" preference. Listens to `chrome.storage.onChanged` for `useSidePanel` to re-apply behavior. |
| `popup.html` | Popup UI (action click). | Five screens as `section[data-screen]`: main (This chat card and buttons; Everything on claude.ai choices and Export selected), Exporting (steps, Stop), Done, Export stopped, and Settings (its own screen, not a drawer). `IS_POPUP` puts `popup` or `sidebar` on the body. |
| `sidepanel.html` | Side Panel UI. | A byte-for-byte copy of `popup.html`; `tests/screens.test.js` fails if they differ. Edit one, copy it over the other. |
| `session-core.js` | Session data filter (Claude Code and Cowork sessions). | Classic script loaded by `content.js` (`globalThis.CTSession`; survives re-injection). Keeps only the listed session and event fields (`keepSession`, `keepSessionEvent`, `sessionPage`), strips `<system-reminder>` spans (`stripSystemReminders`) and masks key shapes (`maskSecrets`). The transcript, README and image builders (`sessionTranscriptMd`, `sessionReadmeMd`, `sessionImages`) are in `export-core.js`. |
| `export-core.js` | Shared pure extractors. | Classic script loaded before `popup.js` (plain top-level declarations, `module.exports` under Node only). Holds `fixMojibake`, `isTextFile`, `zipSafeName` (every name from chat data that becomes a ZIP path goes through it), `getMessageChain`, `extractArtifacts`, the heredoc helpers, `extractUploadedFiles`, `extractPresentedFiles`, `extractDeliveredFiles`, `getModelName`, `buildViewerDeliveries`, `viewerProject`, `heredocFiles`, `safeFileTitle`, the diagram files (`WIDGET_CSS`, `widgetFile`, `widgetKey`), `extractAttachedFiles`, the artifact list helpers (`uuidToBase58`, `artifactsFromList`), the artifacts store's views and indexes (`artifactView`, `previewKind`, `artifactFileKind`, `storeVersionList`, `storeRecordRow`, `artifactsIndexMd`, `artifactsIndexHtml` and their helpers `formatTimestamp`, `mdLinkText`, `escapeHtmlText`, `encodePath`) the Claude Docs rebuild (`claudeDocCreated`, `claudeDocKey`, `renderClaudeDoc`, `docCompanions`, `docCompanionNote`, and the diagram screenshots `docWidgetShots`, `docWidgetEmbeds`, `docWidgetCode`, `docDiagramPictures`), the bash replay helpers (`commandCwds`, `resolveSandboxPath`, `isUnderFolder`, `literalSwapCommand`, `pythonSwapScript`, `commandTouches`, `bashFailed`; see §10), and the artifact-opened chat helpers (`startedWithArtifact`, `openedArtifactLine`; v1.25.1). Used by `popup.js` and Node tools. |
| `popup.js` | **The brain.** About 7,000 lines. All export logic, all conversion, all UI wiring. Same script is loaded by both `popup.html` and `sidepanel.html`. | See §3 below for the internal layout. |
| `jszip.min.js` | ZIP library (vendored). | Used by both single-ZIP and mega-ZIP exports. |
| `extract_artifacts.py` | Stdlib-only Python port of `extractArtifacts`. | Reconstructs all per-turn artifact versions from `original.json` offline. Byte-identical output to the JS implementation. |
| `replay_bash.py` | Stdlib-only Python CLI for post-export bash replay. | Reconstruction, isolated by `sandbox-exec` on macOS, of artifacts the declarative replay can't reach (anything Claude mutated via `bash_tool`). See §10 below and `docs/WASM_REPLAY_APPROACH.md`. |
| `tools/archive-lib.js` | Archive scanning for the old-archive tool. | Finds archives (`findArchives`), scans owner-added files (`scanAdded`), recognizes generated viewers (`isGeneratedViewer`), matches files by name (`matchFile`) and rebuilds chats from disk (`chatFromDisk`). It reads every artifacts layout (`readArtifactStore`, `artifactJsonV2FromDisk`, `artifactViewsFromDisk`), follows on-disk JSON paths only through real folders (`realDirUnder`) and rewrites chat links (`rewriteChatLinks`). |
| `tools/archive-zip.js` | ZIP extraction for the old-archive tool. | Extracts into a new folder under `--out`; refuses unsafe entries and checks free space. |
| `tools/build_viewer.js` | CLI that gives older archives a viewer. | `node tools/build_viewer.js <folder> [--out] [--force] [--dry-run] [--json]`. Writes only `viewer.html`, `viewer-check.gif`, `viewer-files/`, and temporary `.tmp-<pid>` and `.old-<pid>` names. The write-safety rules live here: `inspectRoot`, `install`, `writeNew`, `assertFree`. It creates `--out` if absent, and extracts ZIPs into new folders under it. Needs Node 20+. |
| `tools/merge_archives.js` | CLI that combines archives into one. | `node tools/merge_archives.js <folder or ZIP>... --out <folder> [--name] [--dry-run] [--json]`. Takes each chat once, from its newest copy (`pickNewest`), copies it into a new folder under `--out` built under a temporary name, writes `index.md`, `export-manifest.json` (`kind: "merged"`) and a viewer through `writeViewer`. Merges the artifacts of every layout into one `artifacts/` store (newest source per version) and rewrites the chats' links into `published/`. Only reads its sources. |
| `tools/package_extension.js` | Builds the extension's ZIP for testers or the Chrome Web Store. | `node tools/package_extension.js [--out <folder>]` (default `dist/`, git-ignored) writes `claude-takeout-<version>.zip` with only the runtime files (`ROOT_FILES` plus all of `viewer/`). Refuses, writing nothing, when a file the manifest, the pages, `VIEWER_ASSETS` or an `executeScript` names is not in the list (`problems`). Add a new runtime file to `ROOT_FILES`. `tests/package.test.js` checks it; `EXT_DIR=<unzipped copy>` runs `export.e2e` and `panel.e2e` against the package. |
| `tests/session.test.js` | Unit tests for sessions: the `session-core.js` filter, stripping and masking, the transcript and README builders, `buildViewerSession`, the record and the CLI switch. | Run by `sh tests/run.sh`. |
| `tests/screens.test.js` | Unit tests for the panel: the screens' sentences (view-model functions), the markup of both pages (identical, ids, colours), counts, folder handoff, and the screens driven against fake elements. | Run by `sh tests/run.sh`. |
| `tests/archive.test.js` | Unit tests for the three `tools/` files. | Run by `sh tests/run.sh`. |
| `tests/merge.test.js` | Unit tests for `tools/merge_archives.js`. | Run by `sh tests/run.sh`. |
| `tests/e2e/archive.e2e.js` | Browser test of a built archive viewer. | Optional; needs `playwright-core` and Chromium. |
| `tests/e2e/colors.e2e.js` | Browser test of syntax colors. | Optional; needs `playwright-core` and Chromium. |
| `tests/e2e/stepper.e2e.js` | Browser test of the in-chat match bar: stepping across messages and branches, hidden matches, keyboard, closing. | Optional; needs `playwright-core` and Chromium. |
| `tests/e2e/files.e2e.js` | Browser test of the Files list in a chat's top bar. | Optional; needs `playwright-core` and Chromium. |
| `tests/e2e/search.e2e.js` | Browser test of sidebar search: grouping and ranking, bold matches, operators, the clear button, `/` and arrow keys. | Optional; needs `playwright-core` and Chromium. |
| `tests/e2e/navigation.e2e.js` | Browser test of keyboard version switching, search highlights, Sources on plain-text responses, the phone panel header and the color queue. | Optional; needs `playwright-core` and Chromium. |
| `tests/e2e/cards.e2e.js` | Browser test of product cards (carousel, featured, comparison), the hidden question, citation pills and search queries. | Optional; needs `playwright-core` and Chromium. |
| `tests/e2e/prompts.e2e.js` | Browser test of long prompts: collapsed with a fade and Show more, short ones whole, a search hit expands one. | Optional; needs `playwright-core` and Chromium. |
| `tests/e2e/steps.e2e.js` | Browser test of the step groups: the summary line, rows and their labels, viewed images in their row, thinking alone. | Optional; needs `playwright-core` and Chromium. |
| `tests/e2e/webimages.e2e.js` | Browser test of web-search images: one mosaic per response, `+N`, unsaved cards, the gallery's keys and closing. | Optional; needs `playwright-core` and Chromium. |
| `tests/e2e/parts.e2e.js` | Browser test of upload and generated-file text loaded from `viewer-files/`. | Optional; needs `playwright-core` and Chromium. |
| `tests/e2e/published.e2e.js` | Browser test of published-page cards: one card per page, versions, "Same as published", "Needs claude.ai to run", the claude.ai link, Export All links. | Optional; needs `playwright-core` and Chromium. |
| `tests/e2e/zoom.e2e.js` | Browser test of zoom and drag in the chat viewer: the gallery (wheel, drag, double-click, keys, inline diagrams), pictures in the panel and upload pop-ups, SVG files as pictures and their fallback to the frame, and the page zoom bar with Fit width. | Optional; needs `playwright-core` and Chromium. |
| `tests/e2e/artifacts-viewer.e2e.js` | Browser test of the Export Artifacts viewer: grid, tabs, routing, sandboxed previews and their files, shims, hostile pages, no-network checks. | Optional; needs `playwright-core` and Chromium. |
| `tests/e2e/artifacts.e2e.js` | Browser test of an Export Artifacts `index.html` over `file://`: rows sorted, title link opens the artifact, Docs row note and no local link, shared label, no network or page errors. | Optional; needs `playwright-core` and Chromium. |
| `tests/e2e/download.e2e.js` | Browser test of Download: popups and the panel (names, bytes, a part-backed upload once loaded), the Artifacts screen's start file, image and list rows, Download ZIP; nothing navigates or loads the file. | Optional; needs `playwright-core` and Chromium. |
| `tests/e2e/projects.e2e.js` | Browser test of the viewer's Projects, project and All chats pages: sidebar entries and counts, 30 Recents and View all, routes and Back/Forward, cards and filter, project page (instructions, knowledge, chats), Open project, 200-row paging, phone and dark, one-chat viewer unchanged, no network. | Optional; needs `playwright-core` and Chromium. |
| `tests/e2e/design.e2e.js` | Browser test of the Design canvas, standalone and hosted: the window (never scrolled, opening view, Fit of the whole design, 10% to 200%, tiles with no frames below 20%, the canvas never lost), zoom and drag, Move and Interact (the pill, V and H, wheel, Shift+wheel, drag over boards, Space held, the mode kept), boards in place and titled, sandboxed (guard frame hosted), made near the view, notes as text, badges, Open alone and back, a hostile board, the poster without `canvas.json`. | Optional; needs `playwright-core` and Chromium started with `--disable-features=IsolateSandboxedIframes`. |
| `tests/e2e/combined.e2e.js` | Browser test of an Export All with artifacts: the Artifacts screen and its tabs including In chats, links both ways, the guard frame's refusals, no network. | Optional; needs `playwright-core` and Chromium started with `--disable-features=IsolateSandboxedIframes`. |
| `tests/e2e/sessions.e2e.js` | Browser test of the viewer's Sessions: the entry and count, `#sessions`, a transcript (folded steps, cut results, images), artifact links both ways, search, no network. | Optional; needs `playwright-core` and Chromium. |
| `tests/e2e/viewer.e2e.js` | Browser test of the chat viewer over `file://`, built from the synthetic fixture; the only coverage of `sanitizeHtml`. | Optional; needs `playwright-core` and Chromium. |
| `tests/e2e/export.e2e.js` | The real extension in Chromium against a mock claude.ai: binary bytes through real ZIP exports. | Optional; needs `playwright-core` and Chromium. |
| `tests/e2e/panel.e2e.js` | The real extension's side panel against a mock claude.ai whose chats load over the StreamTimeline RPC. | Optional; needs `playwright-core` and Chromium. |
| `tests/e2e/make-viewer.js` | Builds a look-only viewer from one exported conversation, for checking by eye. | Not a test; keep its output out of the repo. |
| `tests/e2e/hostile.js` | Hostile-input fixtures for the viewer e2e tests. | Not a test by itself. |
| `takeout-viewer.js` | Builds the offline viewer's data. | Classic script loaded by `popup.html` and `sidepanel.html`, exposing `CTViewer` (`buildViewerChat`, `buildViewerData`, `assembleViewer`, ...). Header comment documents the contract. |
| `viewer/` | Viewer page sources. | `viewer-template.html`, `viewer-logic.js`, `viewer-app.js`, `artifacts-template.html`, `artifacts-app.js` and `artifacts.css` (the Artifacts screen: standalone in the Export Artifacts viewer, mounted as `CTArtifactsApp` in the chat viewer's shadow root; they share `viewer-logic.js`), `marked.min.js`, `katex.min.js`, `katex-inline.css`, `highlight.min.js`, `THIRD-PARTY-NOTICES.txt`. `writeViewer` inlines them into one `viewer.html`. |
| `tests/` | Regression tests. | `sh tests/run.sh`. Uses Node's and Python's built-in test runners, with a synthetic fixture only. Not used by the extension at runtime. |
| `docs/WASM_REPLAY_APPROACH.md` | Architecture record. | Comprehensive evaluation of running Pyodide in the extension as an alternative to the CLI. We chose the CLI; this doc explains why and what would change the answer. |
| `icon16.png` / `icon48.png` / `icon128.png` / `icon.svg` | Extension icons. | |
| `README.md` / `USAGE.md` / `TECHNICAL.md` | Documentation. | TECHNICAL.md names functions rather than copying their code; keep it accurate when behavior changes (§14). |

Files that are **not** part of the extension and may sit in the working tree: `transcript.en.vtt`, `transcript.txt` (stray), `.claude/settings.local.json` (Claude Code permission allowlist — local-only, don't commit), `.DS_Store`.

---

## 3. popup.js internal layout

`popup.js` is one big script with conceptual sections delimited by `// ====` banners. These are listed in file order; search for a function name to find its line.

| Section | What lives here |
|---|---|
| `export-core.js` (separate file) | Mojibake repair, `isTextFile`, `getMessageChain`, `extractArtifacts` (per-turn versioning + str_replace replay), `extractUploadedFiles`, `extractPresentedFiles`, `extractDeliveredFiles`, `getModelName`, `buildViewerDeliveries`, `viewerProject`, the heredoc helpers (`heredocMatches`, `heredocFiles`), `safeFileTitle`, the artifact list helpers (`uuidToBase58`, `artifactsFromList`), the Claude Docs rebuild (`claudeDocCreated`, `claudeDocKey`, `renderClaudeDoc`) and the artifact-opened chat helpers (`startedWithArtifact`: `settings.started_with_artifact.artifact_uuid`, the only settings field read; `openedArtifactLine`) live here, not in `popup.js`. Edit them there. |
| `ExportErrorCollector` class | Structured errors, warnings and notes per export (`addNote`, since v1.22.1: shown, never counted; see §11), builds `errors.txt` with recovery hints, troubleshooting guide. **All warning types must have a case in `_getRecoveryHint`, all note types one in `_getNoteHint`.** Existing types: `upload`, `presented_file`, `delivered_file`, `project_doc`, `project_metadata`, `str_replace_failed`, `artifact_basename_collision`, `artifact_opaque_mutation`, `viewer`, `claude_doc_unreplayed`, `doc_diagram`, `web_image`, `tool_image`, `published_page`, `artifact_export`, `export_health`, `session`. |
| BOM helpers | `withBOM(text)`, `addFileWithBOM(folder, path, content)`. The mojibake map and `fixMojibake` are in `export-core.js`. |
| Extractors and renderers | `extractTextAttachments`, `extractWebSources`, `extractBlobContent`, `extractProjectFiles`, `getLanguageFromFilename`, `processTextWithCitations`, `formatReferences`, `getLanguageFromType`, `getThinkingSummary`, `markdownToPlainText`. |
| ZIP/section builders | `extractCodeBlocks`, `extractUrls`, `sanitizeForFilename`, `extractFirstHeading`, `escapeMarkdown`, `extractResponseTextOnly`, `generateMeta`, `generatePrompts`, `generateResponsesTextOnly`, `generateCodeSnippets`, `generateLinksAndSources`. |
| `populateConversationFolder` | The shared ZIP layout writer used by both single-ZIP and mega-ZIP. Constructs `ExportErrorCollector`, calls all extractors, fetches project docs + uploaded files, writes every file in the folder. |
| `createZipExport` | Wraps `populateConversationFolder` for the single-conversation ZIP path; generates the filename + downloads the blob. |
| Offline viewer: `viewerUploadText`, `writeViewer` | Builds `viewer.html` for each export. `viewerUploadText` reads an upload's text for the viewer, and `writeViewer` assembles the page via `takeout-viewer.js` (`buildViewerChat`, `modelLabel`) and adds it to the ZIP. A failure here warns under `viewer` and never stops the export. |
| Published pages: `savePublishedPages`, `tabPublishedFetcher`, `publishedStoreRecord`, `publishedReadmeLines`, `publishedLines` | Saves the pages a chat published (see §5.3 `publish_files`). `tabPublishedFetcher` asks the claude.ai tab's `content.js` (first call through `sendToTab`, then `sendOnce`); `savePublishedPages` checks sizes and SHA-256, decides per version whether it is the same as the written file, writes `published/` and `published.json` per chat (a single-chat ZIP), or in Export All puts each version into the shared artifacts store (`publishedStoreRecord`, `artifactStore`) and writes no `published/`. `publishedReadmeLines` adds the README section; `publishedLines` links the saved copy in the Markdown. |
| Helpers: `formatTimestamp` | `getModelName` is in `export-core.js`; its model name parsing handles `data.model` (e.g. `claude-sonnet-4-5-20250929` → "Claude 4.5 Sonnet") and falls back to `paprika_mode` / thinking-block detection. |
| `convertToMarkdown` | The single-MD / embedded-MD renderer. Walks `getMessageChain`, formats prompts and responses, renders thinking blocks, tool uses (`create_file`, `present_files`, `web_search`, `bash_tool`, `str_replace`, `view`, etc.), citations, and references. Honors `embedArtifacts`, `seamlessMd`, `includeThinking`. |
| `extractTextContent`, `download`, `safeFilename` | Small utilities. |
| `updateUI`, `showProgress`, `hideProgress`, `requestData` | DOM glue. |
| `exportArtifacts`, `artifactsIndexHtml`, `artifactsIndexMd`, `saveArtifact`, `fetchPublishedFiles` | Export Artifacts: lists claude.ai's artifacts (`content.js` `listArtifacts`, then `artifactsFromList` in export-core.js), fetches each one's current files through `fetchPublishedFiles` (shared with `savePublishedPages`), writes a folder per artifact (`artifact.json` format 2 and a `<ver>/` folder per version, from `artifactStore`), plus `index.html`, `index.md`, `export-manifest.json` (`kind: "artifacts"`). Folder or ZIP by `settings.megaFormat`; `folderExport` is shared with Export All. `writeArtifactsViewer` builds its `viewer.html` (see TECHNICAL.md "Artifacts viewer"). See TECHNICAL.md "Export Artifacts". |
| `artifactStore`, `artifactJsonV2`, `runArtifactStep` | `artifactStore(root, { prefix })` is the one writer of the artifacts store (a record per uuid, `<Title>_<shortId>/<ver>/`, `artifact.json`), shared by chats' publishes (`savePublishedPages`), Export Artifacts (prefix `''`) and Export All (prefix `artifacts/`). `runArtifactStep(root, { prefix, artifacts, ... })` adds each listed artifact's current version when no whole folder for that version exists. See TECHNICAL.md "The artifacts store". |
| `bulkExportZip` | The multi-conversation path (the per-conversation Markdown/Embedded/JSON `bulkExport` was removed in v1.22: every Export All chat folder holds those). `bulkExportZip({ directory })` writes into a folder instead (`createDiskFolder`, `makeRunFolder`; the default, `settings.megaFormat`); otherwise it builds a single mega-zip with `index.md` + one folder per conversation reusing `populateConversationFolder`. Like `exportArtifacts` it never throws and returns a `runResult` (`outcome`, `reason`, `target`, `saved`, `warnings`, `warningList`, `errorFiles`, `notes`, `startedAt`, `endedAt`); `options.onProgress` (`exportProgress` events `{ phase, done, total, sub, warnings }`), `options.onTarget` and `options.signal` (`{ stopped }`) drive the Exporting screen and Stop. `options.withChats`, `withArtifacts` and `withSessions` follow the main screen's three boxes (`exportPlan`; `withChats` and `withSessions` default `true`). |
| Panel screens (`// ==== Panel screens`, then the UI block) | Pure view-model functions for every sentence the screens show (`exportPlan`, `everythingSummary`, `runResult` text helpers, `stoppedReasonText`, ...), then `showScreen`, `renderEverything`/`loadEverything`, `countEverything`/`cachedCounts` (Count, cached 10 min in `chrome.storage.session` `takeoutCounts`), `runSelected` (starts `bulkExportZip` or `exportArtifacts` per `exportPlan`), `showDone`/`showStopped`, the Settings screen and `takeHandoff`. Keep new sentences in the pure part so `tests/screens.test.js` can pin them. |
| Click handlers + `refresh` | Button → action mapping. Each per-conversation handler calls `ensureProjectName` before generating the filename or starting the ZIP. |
| Settings | `loadSettings`, `saveSettings`, `applySettings`; settings shape: `{ filenameStyle, includeThinking, megaZipScope, megaFormat, exportAllChats, exportAllArtifacts, exportAllSessions, exportCliSessions, showShortcuts, useSidePanel }` persisted under `chrome.storage.local.exporterSettings`. `useSidePanel` is mirrored at top-level for the background worker. |
| Keyboard shortcuts | `Alt+Z` (Export ZIP), `Alt+M` (Markdown), `Alt+E` (Markdown + files), `Alt+J` (JSON), `Alt+A` (Export selected), `Alt+R` (Refresh); the main screen only. The buttons list is `EXPORT_BUTTONS`. |
| `exclusiveExport`, `onExport` | One export at a time: the export buttons are disabled while one runs, and a second click or shortcut does nothing. Across pages, `runSelected` holds the Web Lock `EXPORT_LOCK`. |
| `generateFilename` | `[<Project>-project]_` prefix + filenameStyle, with an optional suffix such as `_embedded` added after the title is cut to length. |
| Bootstrap | `loadSettings()` then `requestData()`. |

When adding code: keep the banner-comment section structure and put helpers near the section that uses them. Do **not** create new files unless adding a non-trivial standalone tool (e.g. a second companion script).

---

## 4. Runtime data flow

```
   claude.ai page                       popup.js (popup or side panel)
   ├─ injected.js                       ├─ reads the chat ID from the tab URL
   │    reads org ID from fetch URLs    ├─ asks content.js for that chat
   │         │ postMessage              ├─ extracts, transforms, writes
   │         ▼                          └─ downloads via URL.createObjectURL
   └─ content.js  ◀── chrome messaging ──┘
        resolves the org ID
        calls the claude.ai REST API
```

- **The page itself isn't a data source:** claude.ai loads chats over `/claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/StreamTimeline`, which the extension can't read, so conversation data always comes from REST.
- **Selected chat comes from the tab URL:** `requestData` matches `/chat/<uuid>` and always fetches that chat over REST through `content.js`'s `fetchConversation`. Each single-chat handler calls `loadConversationForExport` to fetch again, and fails rather than export an older copy. `tabs.onActivated` and `tabs.onUpdated` trigger `scheduleRefresh`, which waits while an export's progress bar is showing.
- **`sendToTab` injects `content.js` on a connection error:** a tab open across an extension install or reload has no working content script, which used to show as "Refresh page to capture data."
- **Org ID comes from the `lastActiveOrg` cookie first:** `content.js`'s `getActiveOrgId`, then the captured ID, then the stored one.
- **`fetchConversation`** appends `?tree=True&rendering_mode=messages&render_all_tools=true` to get the fully-rendered payload (including nested `project.name`, which the page-side fetch often omits).
- **`ensureProjectName(data, orgId)`** is the bridge: for payloads that only have `project_uuid`, it re-fetches `/api/organizations/<orgId>/projects/<projectUuid>` and patches `data.project = { uuid, name }` before filename generation. Called at the top of every single-export click handler and at the start of each iteration in both bulk paths.

---

## 5. Conversation JSON: the shape that matters

Everything keys off `data.chat_messages[]`. Each message:

```jsonc
{
  "uuid": "msg-uuid",
  "parent_message_uuid": "previous-msg-uuid",  // null at root
  "sender": "human" | "assistant",
  "created_at": "ISO timestamp",
  "content": [ /* content blocks */ ],
  "attachments": [ /* pasted text files w/ extracted_content */ ],
  "files":       [ /* legacy uploads */ ],
  "files_v2":    [ /* modern uploads */ ]
}
```

Plus top-level: `uuid`, `name`, `model`, `settings.paprika_mode`, `created_at`, `updated_at`, `current_leaf_message_uuid`, `project_uuid`, `project` (sometimes — see §4), `project_context_files`.

### 5.1 Branched conversations

The user can regenerate a response, producing a tree. `current_leaf_message_uuid` is the active leaf. To get the active branch in chronological order: walk back via `parent_message_uuid`, collect, reverse. **`getMessageChain(data)` does this.** Always use it — never iterate `data.chat_messages` directly when generating export content. (It's fine for whole-conversation scans like uploads where the tree-shape doesn't matter, but be explicit about it.)

### 5.2 Content block types (assistant side mostly)

| `type` | Notable fields | Where it's rendered |
|---|---|---|
| `text` | `text`, optional `citations[]` | `convertToMarkdown` text branch + `processTextWithCitations`. |
| `thinking` | `thinking`, `summaries[]` | Code-fenced under "Thought process: <summary>" if `includeThinking` is on. |
| `tool_use` | `name`, `input` | See §6. |
| `tool_result` | `name`, `content[]`, `is_error` | Rendered inline for most tools; `view` results yield blob content. |

### 5.3 Tool calls of interest

| `name` | `input` fields used | What the extractor does |
|---|---|---|
| `create_file` | `path`, `file_text`, `description` | Initializes artifact state at `input.path`; emits new version. |
| `str_replace` | `path`, `old_str`, `new_str` | Replays edit against current state (single-match semantics); emits a `str_replace_failed` warning on 0 or >1 matches. |
| `rewrite` / `create_or_overwrite` | `path`, `file_text` or `content` | Defensive — overwrites artifact state; emits new version. |
| `artifacts` (cmd: `create`/`update`/`rewrite`) | `id`, `title`, `type`, `content`, `command`, `old_str`, `new_str` | Keyed by `artifact:<id-or-title>`. Filename = `safeFileTitle(title or id)` (letters, digits and marks from any script) + `typeToExt[type]` (fallback `.txt`). `create`, `rewrite` and an `update` with `content` set the text; an `update` with `old_str`/`new_str` is replayed like `str_replace`. |
| `bash_tool` (heredoc) | `command` matching `cat > <path> << DELIM ... DELIM` or `cat << DELIM > <path> ...`, any delimiter (`heredocMatches`) | Treated as create_file. |
| `present_files` | `filepaths[]` | `extractPresentedFiles` keeps each path's latest presentation on the current branch, with its message index. `populateConversationFolder` downloads a presented file the replay didn't make, or one whose replay is known to be off (`replayIsOff`: `str_replace_failed`, or an unreplayed bash change whether it ends as a warning or a note) when the presentation is at or after the file's last change: the download then replaces the final file and its last `_vN`. Same-named files from different folders become `<base>_2<ext>` with a `name_changed` note. In `convertToMarkdown`, looked up through `presentedNames` in the `artifacts` map for inline embedding; a binary one is linked. *Caveat:* with edited artifacts, lookup resolves to the FINAL versioned state, not the state at the moment of presentation. Acceptable trade-off; the per-turn versioned files exist on disk for cases where the precise moment matters. |
| `Write` / `Edit` | `file_path`, `content` / `old_string`, `new_string`, `replace_all` | Same replay as `create_file` / `str_replace`. Newer conversations use these names. |
| `Bash` | `command` | Same as `bash_tool`, in the extension and `replay_bash.py`. Uploads live at `/root/.claude/uploads/<session>/<uuid8>-<name>`. |
| `<connector>publish_files` (claude-artifacts) | `files[]` (`path`, `as`), `title`; result JSON has `slug` (page uuid), `version`, `url`, `title` | `isPublishTool` and `publishedPagesOf` (export-core.js) list each page and version a chat published (an old url-only result: `base58ToUuid`, the live version, labelled current). `savePublishedPages` (popup.js) fetches each version through `content.js` (`publishedPageInfo`, `publishedPageFile`; the asset token never leaves `content.js`) into `published/<page>/<version>/` with `published.json` in a single chat's ZIP, or in Export All into the shared `artifacts/<Title>_<shortId>/<ver>/` with the content of `published.json` inside `artifact.json` (format 2; every published page gets a folder, also unlisted ones and with the artifacts setting off), unless a version is the same, file by file, as the text the chat had written at that publish (SHA-256). Caps 32 MB per file, 50 MB per version; failures warn `published_page`. The chat's README lists the pages and `publishedLines` links the saved copy in the Markdown (`../artifacts/…` in Export All). The viewer shows one `published:<uuid>` card per publish in place of the "Published on claude.ai" line. The file claude.ai attaches to Claude's message is listed by `extractAttachedFiles`, not as an upload: saved in `artefacts/` unless an artifact has its name; the viewer hides that copy only when the version is the same. |
| `Artifact` (claude.ai's publish tool) | `file_path`, `description`, `icon`; or `action: "open"`, `url` | A publish (`isArtifactPublish`: `file_path`, no action) is read from its reply text "Published <path> at https://claude.ai/artifact/<id> (Version N, version id <ver>)" (`artifactPublishReply`) and joins `publishedPagesOf` with one source, saved by `savePublishedPages` like `publish_files`. An open publishes nothing: a step "Opened an artifact". In a session (v1.25.1), `buildViewerSession` gives each publish the same card from the artifacts store (`sessionPublished`; previews from the artifact step's parts), opening in the side panel at `#session=<id>&file=…&version=…`. A typed artifact's page (its start file is claude.ai's loader) is never previewed (`typedArtifactHash`): a Design shows its canvas in the panel, the Artifacts screen's page mounted again with `CTArtifactsApp.mount(host, { ..., embedded: true })` for that one artifact (`panelCanvas`, `pickVersion(ver)` for the panel's version; v1.25.3), other kinds a note linking `#a=<id>` (v1.25.2). |
| `SendUserFile` | `files[]`; result has `file_deliveries[]` with `file_uuid`, `path` | `extractDeliveredFiles(data, takenNames, offPaths)` lists them and `populateConversationFolder` downloads each by UUID into `artefacts/`. A delivery of an artifact's path is kept apart as `<base>_delivered<ext>`, except the latest one of a path in `offPaths` (replay off, delivery at or after the file's last change): it takes the artifact's name and replaces its final and last `_vN`. |
| `<connector>show_widget` (visualize) | `title`, `widget_code` | A diagram drawn inline. `extractArtifacts` saves it under key `widget:<title>` as `<title>.svg` (an SVG with `xmlns` and `WIDGET_CSS`, claude.ai's widget classes for light and dark) or `<title>.html` (`widgetFile`); same title = versions. `extract_artifacts.py` mirrors it byte for byte. Markdown links it and shows an SVG as an image; the viewer gives it a card. The tool's `read_me` result is left out of the Markdown (`isGuidanceTool`). |
| `product_carousel_display_v0`, `featured_card_display_v0`, `comparison_card_display_v0`, `ask_user_input_v0` | `products[]` (`name`, `price`, `blurb`, `attributes[]`); `questions[]`; carousel/featured results carry `images[]` ids `product_<n>_<m>` | Product pictures are web images (`isImageResultTool`). Viewer: cards inline (`displayData`, `renderDisplay`), questions hidden. Markdown: headings, a table, lists (`displayLines`). |
| `image_search` | `query`; result `images[]` | `saveWebImages` saves them in `images/<key>_<title><ext>` (`webImagesOf`, `webImageName`; key = hash of the URL) when the optional https permission is granted; Markdown lists them with the saved picture (`imageSearchLines`), the viewer shows them (`ctx.webImages`, tool block `web`). Without permission, or on failure, `web_image` warnings. |
| `<connector>Claude_Docs__batch` / `__update` / `__create` | batch: `container.create.{name, doc.{markdown, blocks}}`; its result's leading JSON gives the node id and the ids of the pending sections. A batch on an existing doc (`container.id`, `batch[]` members: `widget` creates, prose `update`s). update: `ref.id`, `payload.ops[]` replacing a pending id with Markdown, or found text (`target.kind: "find"`). create: a comment (`payload.value.body`, `parent.anchor`) | A Claude Docs document. `extractArtifacts` rebuilds it under key `doc:<node id>` as `<sanitized title>.md` (`claudeDocCreated`, `applyDocOps`, `renderClaudeDoc`); an embedded widget shows as `[embedded content: <caption>]`; pending blocks a fill plants are tracked from its reply (`docPendingIds`). Any other edit warns `claude_doc_unreplayed`. A self-contained HTML copy Claude made of a document (sent in the turn that called `Claude_Docs__export` on it, or a page titled like it; `docCompanions`) is linked by a note under the final document's title (`docCompanionNote`); a document with diagrams and no copy gets a **Diagram not included** note and warns `doc_diagram`. A diagram Claude took a screenshot of (`Claude_Docs__read`, `engine: "widget"`, `payload.kind: "screenshot"`; saved by `saveToolImages`) shows that picture in the final `.md` and `.html` where its caption stood (`docDiagramPictures`, a post-pass like the note; `_vN` stay as rebuilt), and doesn't count for the note or `doc_diagram`. Each widget's code is written as `<doc base>_diagram<N>.jsx` (no versions, no card). The viewer gets the document as rebuilt, captions and all (`viewerDocs`), since its sanitizer drops `../images/`. `populateConversationFolder` also writes `<title>.html` (`claudeDocHtml`, using `viewer/marked.min.js`, which popup.html and sidepanel.html load). `extract_artifacts.py` mirrors the `.md`, without that note or the pictures. |
| `<connector>edit_version` | `slug` | Edits a published artifact. Replays nothing; `artifactLinksOf` links it as `edited` when the result isn't an error. |
| `web_search` | `query` (input) / `content[]` (result) | Renders the query + formatted result list; citations harvested via `processTextWithCitations`. |
| `view` / `read_file` | `path` | Used by `extractBlobContent` to recover ephemeral upload content from tool_result blocks when the wiggle API 404s. |
| `web_fetch`, `str_replace_based_edit_tool`, etc. | varies | Rendered with sensible fallbacks in `convertToMarkdown`; not all are first-class extractors. |

If you add a new tool extractor, follow the same shape: a function `extractFoo(data)` returning a plain map / array; integrate into `populateConversationFolder` and (if it should appear inline) into `convertToMarkdown`.

---

## 6. Artifact extraction with per-turn versioning *(the load-bearing piece)*

This is the part most likely to break or need extending. As of v1.5.2:

**Algorithm** (`extractArtifacts(data, errorCollector?, index?)`):

1. Walk `getMessageChain(data)` in order.
2. Maintain `state[key] = { current, basename, versions: [], editedThisTurn }`. Key is:
   - The full path for `create_file` / `str_replace` / `rewrite` / `bash_tool` heredoc.
   - `artifact:<id-or-title>` for the `artifacts` tool.
3. Skip file tools whose `tool_result` has `is_error`: they changed nothing. Bash commands are never skipped, since a failed one can still have written its heredoc. For each remaining `tool_use` block, update state:
   - `create_file` / `rewrite` / `artifacts create|update` / heredoc → `state[key].current = content; editedThisTurn = true`.
   - `str_replace` → count occurrences of `old_str` in current content. Exactly 1 → replace, mark dirty. 0 → warn `str_replace_failed` ("not found"). >1 → warn `str_replace_failed` ("ambiguous"). This mirrors the real tool's strict semantics.
   - A bash command of a literal shape (`sed -i` with literal `s///`, `cat >>` with a quoted heredoc, a Python read/`replace`/write script; §10) → applied in place to `current`, mark dirty, and recorded in the optional `replayed` set (4th argument). Only on a file whose text is known (created in the chat, every change since replayed) and only when the result shows no failure (`bashFailed`). Any other bash change makes the file opaque (`commandTouches`); a file's replay stops at its first opaque command and never resumes. Replay-shaped edits left out are listed in `index[key].skipped`.
4. At the end of each message (assistant or human, defensively), any state entry with `editedThisTurn` gets its `current` pushed onto `versions[]` and the flag cleared.
5. After the loop, safety-net sweep for trailing dirty entries.
6. Emit:
   - `versions.length <= 1` → only `<base><ext>` (the single content).
   - Else → `<base>_v1<ext>` … `<base>_vN<ext>` + `<base><ext>` = final state.
7. Disambiguate collisions across distinct keys: each artifact claims every name it writes (`<base><ext>` and, when versioned, each `<base>_vN<ext>`). If any is taken, by another path with the same basename or by a file Claude itself named `report_v1.html`, append `_2`, `_3`, … to the base and add the note `name_changed` naming both paths (`artifact_basename_collision` warning before v1.22.1, and still when the collector has no `addNote`, as in `extract_artifacts.py`). `extract_artifacts.py` fills an optional `names` dict with the result, and `replay_bash.py` uses it to write to the same files.

**Why per-turn (not per-edit):** matches the natural "Claude finished editing for now" boundary. The bug-fixture conversation has 11 `str_replace` calls split across two assistant turns; per-turn gives 2 useful intermediate versions, per-edit would give 12 noisy ones. If a user requests per-edit later, the snapshot loop is the only place to change.

`index` is optional. When passed an object, it is filled with `{ <state key>: { path, filename, versions, messages } }`, where `messages` is the uuid of the message that made each version. The viewer uses it to link tool calls to artifact versions. The return value is the same with or without it. `extract_artifacts.py` has no equivalent and doesn't need one.

**Invariants the validator skill checks:**
- `md5(_v1<ext>) == md5(initial create_file.file_text)`.
- `md5(<base><ext>) == md5(<base>_vN<ext>)`. Drift here means the exporter regressed back to "stale v1 only". It still holds after a replayed bash swap (the swap lands in the turn's snapshot) and after a download replaces the final (it replaces the last `_vN` too).
- Number of files on disk for one logical artifact == `versions.length + (versions.length > 1 ? 1 : 0)`.

**Companion script:** `extract_artifacts.py` is a stdlib-only Python 3 port. Use it to reproduce expected output for any `original.json` and `diff -r` against an export's `artefacts/` for a fast regression check. Both implementations must stay in sync — if you change one, update the other.

---

## 7. ZIP export layout

`populateConversationFolder` writes this layout. Both single-ZIP and mega-ZIP use it (mega-ZIP nests one folder per conversation under the root + an `index.md`). The one difference: in a mega-ZIP, project knowledge files go in a shared root `projects/` folder, so those chat folders aren't self-contained.

```
[<Project>-project]_<conversation>_claude-chat.zip   (project prefix only when in a project)
├── README.md                  # Table of contents; "About some files" lists the notes
├── meta.md                    # Stats, word counts, features used
├── prompts.md                 # All user prompts with attachment links
├── responses_text_only.md     # Combined pure-text assistant responses
├── full_chat.md               # Complete conversation w/ artifacts as code blocks
├── integrated_chat.md         # Same, but seamlessMd embeds .md artifacts inline
├── integrated_chat.txt        # Plain-text ASCII version
├── code_snippets.md           # All ``` blocks extracted (incl. artifacts)
├── links_and_sources.md       # URLs + web search sources grouped by domain
├── errors.txt                 # Structured error/warning report, then notes (omitted if none)
├── original.json              # Raw API payload as fetched
├── viewer.html                # Offline viewer (see below)
├── viewer-check.gif           # 1x1 GIF; the viewer loads it to detect a ZIP that was not unzipped
├── viewer-files/part-NNNN.js  # text of uploads and generated files over UPLOAD_INLINE_LIMIT (64 KB), only when there are some
├── responses/<NNN>_<title>_response.md       (pure text)
├── responses/<NNN>_<title>_response.full.md  (thinking/tools/embedded)
├── artefacts/<base>(_vN)?<ext>               (versioning — see §6; a Claude Docs document also gets <title>.html and <title>_diagram<N>.jsx per diagram)
├── attachments/p01_<filename>, p02_<filename>, ...  (prompt-numbered)
├── project/project.json, prompt_template.md, docs.json, files.json, <doc> (text; .txt added when its name is not a text type), files/<name>
├── images/<key>_<title><ext>                 (images from web searches; only with the optional https permission)
├── images/<uuid8>_<name><ext>                (images Claude looked at, from claude.ai: toolImagesOf, saveToolImages)
├── published/<Title>_<id>/published.json, <version>/<files>   (only when the chat used publish_files; a version the same as an artefact is not copied; a single-chat ZIP only, Export All saves these in `artifacts/`)
└── uploads/p01_<filename>, p02_<filename>, ...
```

`p<NN>_` prefixes group files by the user prompt that introduced them (incremented on `sender === 'human'`).

`viewer.html` and `viewer-check.gif` are written by `writeViewer` once per export, at the root. In a single ZIP that is beside the chat files; in a mega-ZIP, one viewer at the root covers all chats (`populateConversationFolder` returns `viewerChat`, built by `CTViewer.buildViewerChat`). Failure to build never blocks the download: a chat that fails to build gets a `viewer` warning, and a whole-viewer failure shows only in the status line.

Upload text over `UPLOAD_INLINE_LIMIT` (64 KB of UTF-8) is not in `viewer.html` either, nor is the text of a generated file's version over that size, except `.css`/`.js`/`.mjs`, which previews inline from the page. `CTViewer.moveUploadText` swaps an upload for `{ text: null, lines, part, key }` (keys `u0`, `u1`, …) and a file version for `{ text: null, part, key }` (keys `f0`, `f1`, …), in parts of the same format, and both `writeViewer`s write those parts to `viewer-files/` (the tool numbers them after its added-file parts). The viewer loads a part when the upload's popup opens. Search never reads upload text, so it is unaffected; pasted attachments stay inline because search does read them.

`ViewerData.projects` holds each distinct project once, and a chat's `project` is an index into it; a project carries `id`, `description` and `updated` (from `project.json`; never the old-archive placeholder id `project`), and `buildViewerData` merges by id (newest `updated`, then more docs+files, else first), and merges identical projects without an id, so a mega-ZIP doesn't repeat a project's docs per chat, and the viewer's `linkProjects` puts them back on load. A chat claude.ai made when an artifact was opened has `startedWith` (the artifact's uuid, `startedWithArtifact`); with no messages, `buildViewerData` adds `opened: { title, file, version }` and that file (`o1`, the store record's saved versions, as a session's published-page card) or `opened: { title }` alone, and the viewer shows "Opened from the artifact <title>" and opens it in the side panel (not on first load with no hash: an Open artifact button). `ViewerData.added` lists files the owner put in an archive after export; only the old-archive tool writes it. Each entry is `{ path, chat, kind, size, href, part, key }`, and the viewer shows them under "Archive files". Their text and media are not inlined in `viewer.html`: `build_viewer.js` writes them as `viewer-files/part-NNNN.js` (about 4 MB each, calling `window.__archivePart(n, {...})`), loaded as local scripts. That is why `CTViewer.assembleViewer` takes `fileScripts` (adds `file:` to the page's `script-src` and `media-src`) and `fileMedia` (`media-src` only). Added HTML and SVG are untrusted and run only in the preview sandbox, and the sandboxed preview doesn't load sibling files. The viewer's Open file link goes through the `openableHref` allowlist (`OPENABLE_EXTENSIONS` in `viewer/viewer-logic.js`): only documents, images, audio, video, archives and plain data open. Everything else, HTML and SVG included, has no link. Keep it an allowlist.

Mega-ZIP only:
```
claude-takeout-[<display name>-][changes-]<YYYY-MM-DD>_<HHMM>.zip   (megaZipName, lowercase; exportStamp, local time; display name from /api/account; the folder export: same name, no .zip)
├── index.md                   # Master table w/ per-conversation issue counts
├── export-manifest.json       # { format, exported_at, kind: full|changes, since, listed, chats: [{ uuid, name, updated_at, folder }] }
├── projects/<project>/        # files/ and files.json, stored once and linked from each chat's README
├── <conversation-folder-1>/   # Same layout as above
├── <conversation-folder-2>/
└── ...
```

A mega-ZIP or folder also holds `artifacts/` whenever a chat published a page or (with `exportAllArtifacts` on, the default) claude.ai lists an artifact: one folder per artifact, `<Title>_<shortId>/`, with `artifact.json` and a `<ver>/` folder per version saved (every version in claude.ai's history since v1.21, fetched by `saveHistory`, and each version a chat published; a version a chat wrote identically has no folder, `sameAs` points at the chat's file; the current version with two or more files also as `<ver>.zip` beside its folder), plus `index.html`, `index.md` (pages claude.ai doesn't list under "Published from chats, not in claude.ai's list") and `errors.txt` only with warnings. Viewer parts and card pictures stay in the root's `viewer-files/`. `export-manifest.json` gains `artifacts: { listed, thumbs, items }`, `index.md` says "Published from chats only: N", and `artifacts` joins `projects` as a reserved chat folder name (`published` stays reserved, though Export All writes no `published/` any more). One root `viewer.html` covers chats and artifacts. `build_viewer.js` reads such an archive and every older layout; `merge_archives.js` merges them into this layout.

A mega-ZIP or folder also holds `sessions/` when Sessions is ticked (`exportAllSessions`, default on; Sessions alone runs `bulkExportZip` with `withChats: false`, no chat list) and claude.ai lists Cowork sessions (only `environment_kind: anthropic_cloud` unless "Include CLI sessions (run on your computer)" under Sessions, `exportCliSessions`, default off, is on; then every kind): `sessions/<Title>_<shortId>/` with `session.json` (format 1; images as `{ image: 'images/<n>.<ext>' }` references), `transcript.md`, `README.md` (artifacts it made, linked into `artifacts/`) and `images/`. `index.md` gets a Sessions table (and "Sessions not exported (Claude Code CLI or other): N"; a list answered 403/404 is "not available for this account", a Done note, no warning), `export-manifest.json` gains `sessions: { listed, leftOut, items }` (a merged archive's has `skipped`, unreadable files, instead of `leftOut`; its `index.md` lists the sessions), and `sessions` is a reserved chat folder name. Limits: 200 events a page (a kept page over 32 MB answers `too large` and `runSessionStep` asks again at 50, 10, 1), 20,000 events asked for, 64 MB kept events per session, 256 MB in ZIP mode, 2 MB event stub, image up to 5 MB, transcript and viewer tool results and inputs cut at 2 KB. The viewer gets a Sessions entry (`#sessions`, `#session=<id>`).

`artifact.json` format 2: `format`, `uuid`, `shortId`, `url`, `title`, `typeTitle`, `sourceSurface`, `rel`, `public`, `createdAt`, `updatedAt`, `listed`, `current`, `start`, `needsRuntime`, `note`, `thumb`, `incomplete` (top level, only when a fetch of it failed), `order` (version ids in claude.ai's history order; JSON can't keep the order of numeric-looking keys) and `versions` (`<ver>: { folder, files: [{ path, savedAs, size, contentType, sha256, verified }], start, startSaved, incomplete, missing, saved, sameAs?, zip? (`<folder>.zip`, only the current version with two or more saved files), publishedIn: [{ chat, messageUuid, toolUseId, same, writtenAs }] }`). A Claude Docs row's note says "Text rebuilt from the chat <chat title>." when a chat in the export rebuilt it.

Export Artifacts (a separate export, `claude-takeout-artifacts-[<name>-]<stamp>`, folder or ZIP; no chats; the old-archive tools read it as an artifacts-only archive):
```
├── viewer.html                # Cards and sandboxed previews (viewer/artifacts-*; opens from disk)
├── viewer-files/              # part-NNNN.js (preview text and images) and thumbs/<shortId>.<png|jpg|webp> (card pictures)
├── index.html, index.md       # Every artifact: title link to its start file, kind, source, files, notes; "Listed by claude.ai: N", "Card pictures: N of M"; a shared artifact's HTML/SVG gets no local link
├── export-manifest.json       # { format: 1, kind: "artifacts", exported_at, listed, thumbs, artifacts: [{ uuid, title, folder, ver }] }
├── errors.txt                 # Only with warnings (artifact_export)
└── <Title>_<shortId>/         # artifact.json (format 2) + <ver>/ per version saved (every version claude.ai keeps), + <ver>.zip of the current one when it has two or more files
```

---

## 8. API endpoints used

All called with `credentials: 'include'` so the user's existing Claude session authenticates them. No API key.

| Endpoint | Used by | Purpose |
|---|---|---|
| `GET /api/organizations/<orgId>/chat_conversations` | `content.js` `fetchAllConversations` | Bulk export conversation list. Not asked when the request has `withoutChats` (Export All with Chats unticked: org and account name only). |
| `GET /api/frame/frames?org=<orgId>&limit=1000` (header `X-Frame-CP: go`) | `content.js` `listArtifacts` | The artifacts claude.ai lists, for Export Artifacts. Only `slug`, `title`, type, source, `rel`, `live`, dates and `public` (a boolean) are kept, and the picture URL stays in `content.js`; this list has no paging. |
| `GET /api/frame/artifacts?rel=all&sort=last_viewed&with_folder=true&through_folders=true&limit=100&org=<orgId>[&page_token=…]` (header `X-Frame-CP: go`) | `content.js` `fetchArtifactPages` | claude.ai's full, paged artifact list (what claude.ai/artifacts reads; no `empty` filter, since `empty=exclude` hides typed artifacts). Up to 100 pages. Artifacts the frames list missed are added with `paged: true` and no `live` (the page info resolves it); `listArtifacts` returns `paging: { status: ok|capped, added } | { status: failed, code }`. The export record keeps `paged:<updatedAt>` for one; a paged one claude.ai serves no version of gets "no published version". |
| `GET https://<uuid>.frame.claudeusercontent.com/_f/<ver>/_thumb.img` (query `__frame_t`, from the listing) | `content.js` `artifactThumbUrl`, `popup.js` `fetchArtifactThumb` | An artifact's card picture. `content.js` keeps the URL (`artifactThumbUrls`), rebuilt from checked parts, and hands it to the popup only for this fetch; the popup fetches it with the optional `https://*/*` permission (the frame host sends no CORS header for claude.ai), without cookies, referrer or redirects, 2 MB cap, type by leading bytes; on a 403, one fresh URL per export (`refresh: true` re-lists once). Without the permission: no request, tiles. The URL is never stored, written, shown or logged. |
| `GET /v1/code/sessions?exclude_tags=-&limit=100` (headers `anthropic-version: 2023-06-01`, `anthropic-beta: ccr-byoc-2025-07-29`, `x-organization-uuid`) | `content.js` `listSessions` | Cowork and Claude Code sessions for Export All. At most 100 (more is HTTP 400), no working next page (`resume_token` is not a cursor); exactly 100 warns the list may be incomplete. Only `session-core.js`'s kept fields leave `content.js`. |
| `GET /v1/sessions/<cse_id>/events?limit=<1..200>[&after_id=<last_id>]` (same headers) | `content.js` `fetchSessionEvents` | One page of a session's events (`has_more`, `last_id` from the raw page). Kept fields only, `<system-reminder>` spans stripped, key shapes masked; over 32 MB kept, `{ error: 'too large' }`. Without `exportCliSessions` only `environment_kind: anthropic_cloud` sessions are fetched. |
| `GET /api/account` | `content.js` `fetchAccountName` | The display name for the mega-ZIP's file name. Only `display_name` (or `full_name`) leaves `content.js`. |
| `GET /api/organizations/<orgId>/chat_conversations/<convUuid>?tree=True&rendering_mode=messages&render_all_tools=true` | `content.js` `fetchConversation` | Bulk-mode full conversation re-fetch with project metadata included. A 429 or 5xx is tried again up to 3 times (Retry-After up to 30 s, else 2, 5, 10 s). |
| `GET /api/organizations/<orgId>/projects/<projectUuid>` | `popup.js` `ensureProjectName` + `fetchProjectDocs` | Project metadata, especially `name`. |
| `GET /api/organizations/<orgId>/projects/<projectUuid>/docs` | `fetchProjectDocs` | List of project documents. Empty for uploaded knowledge files. |
| `GET /api/organizations/<orgId>/projects/<projectUuid>/files` | `fetchProjectFileList` | Project knowledge files such as PDFs, downloaded through `/files/<uuid>/contents`. |
| `GET /api/organizations/<orgId>/projects/<projectUuid>/docs/<docUuid>/content` | `fetchProjectDocs` | Full document content (falls back to `/docs/<docUuid>`). |
| `GET /api/frame/<uuid>?org=<orgId>[&ver=<ver>]` (header `X-Frame-CP: go`) | `content.js` `publishedPageInfo` | A published page's versions, title and asset token. The token never leaves `content.js`. |
| `GET https://<uuid>.frame.claudeusercontent.com/_f/<ver>/_files.json` and `/_src/<path>` (query `__frame_t`) | `content.js` `publishedPageInfo`, `publishedPageFile` | A published page's file list and files; no cookies, no referrer. Cowork and Claude Code pages have no `_files.json` (404): the `/api/frame/<uuid>` reply's `files` (path, type) are used, fetched from `_src/<path>`, else `/_f/<ver>/<path>`, unverified. A public page shared with you has no asset token: no `__frame_t`, and since `_files.json` and `_src/` then fail before any status, it uses the info's list and `/_f/<ver>/<path>` straight away. No files in the info: the error stands. |
| `GET /api/organizations/<orgId>/files/<fileUuid>/...` (multiple URL patterns) | `fetchUploadedFile` | PDF/image/etc. blobs. Tries several path shapes including a sanitized-path fallback when the wiggle endpoint 404s. |

If a new endpoint becomes necessary, follow `fetchUploadedFile`'s pattern: try a primary URL, fall back, surface failures via `ExportErrorCollector`, and capture every URL tried in the error report's `urlsTried[]`.

---

## 9. Settings, storage, and the side-panel toggle

`chrome.storage.local` holds:

```jsonc
{
  "orgId": "uuid",
  "exporterSettings": {
    "filenameStyle": "title" | "title_date" | "date_title",
    "includeThinking": true,
    "megaZipScope": "all" | "changes",  // main screen: All / Changes only
    "megaFormat": "folder" | "zip",     // main screen: Folder (showDirectoryPicker, createDiskFolder) or ZIP
    "exportAllChats": true,             // main screen: the Chats box of Export selected
    "exportAllArtifacts": true,         // main screen: the Artifacts box; Artifacts alone (Chats and Sessions off) is the old Export Artifacts
    "exportAllSessions": true,          // main screen: the Sessions box (Claude Code and Cowork); can be ticked alone, Changes only works with it; loadSettings stores false for an older setup with Chats off
    "exportCliSessions": false,         // main screen, under Sessions: Include CLI sessions (run on your computer); disabled while Sessions is unticked
    "showShortcuts": true,
    "useSidePanel": false
  },
  "useSidePanel": false,  // mirrored at top level so background.js can read it
  "exportRecord": {       // written after each mega-ZIP; with megaZipScope "changes", the mega-ZIP takes chats whose listed updated_at differs
    "<org id>": { "at": "ISO time of that export", "warnings": 0 /* the run's warning count, for the panel footer */, "chats": { "<chat uuid>": "updated_at as the chat list gave it" }, "artifacts": { "<artifact uuid>": "its live version as listed (paged:<updatedAt> for one found only by paging); only artifacts saved whole and written" }, "sessions": { "<cse id>": "sessionStamp: last_event_at, else updated_at, else created_at; a session that failed, hit a cap or had a write failure is not recorded" }, "artifactVersions": { "<artifact uuid>": ["version ids an Export All saved whole or found gone (v1.21); Export Changes skips them"] } }
  },
  // chrome.storage.session (not local): "takeoutCounts" { <org>: { chats, artifacts, changedChats, changedArtifacts, at } }, Count's cache for 10 min;
  // "folderExportNote" { at, choices: { scope, chats, artifacts, sessions, format } } handoff from the popup's Export selected (folder or ZIP) to the sidebar
  // recordableExport leaves out chats and artifacts with a write failure, and chats whose published pages were skipped after a 401
}
```

- `background.js` watches `chrome.storage.onChanged` for `useSidePanel` and calls `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick })` accordingly.
- The popup checkbox + background worker are kept consistent via `enableSidePanelMode` / `disableSidePanelMode` messages.

---

## 10. Bash mutations and the recovery CLI

The exporter handles three classes of artifact mutation:

- **Declarative tool calls** (`create_file`, `str_replace`, `rewrite`, bash heredoc `cat > path << EOF`) → replayed in `extractArtifacts` to produce per-turn `_vN` snapshots and the unversioned final.
- **Literal bash swaps** (since v1.22.1; `literalSwapCommand`, twin in `extract_artifacts.py`) → replayed in place when the whole command is only `cd`, `&&`, `;`, read-only tools (`grep head tail wc`, `cat` without redirect, `sed -n`, `ls`, `echo`/`printf` without redirect, `test`/`[`), `cp` onto an untracked file, and: `sed -i`/`-i.bak` with literal `s<d>A<d>B<d>[g]` (escaped metacharacters only in A; no `&`, back-references or newlines in B), `cat >> f << 'D'` (quoted delimiter), or a Python script (`python3 - << 'D'` / `-c`) that only does `p = '<path>'`, `s = open(p).read()`, `s = s.replace(<lit>, <lit>[, 1])` (or a pair list and loop), the write back, and `print` of literals, `len(s)`, `s.count(<lit>)` (`pythonSwapScript`). A failed result (`bashFailed`: `is_error`, JSON `returncode` ≠ 0, `Exit code N` ≠ 0) is never replayed. Anything else that may write makes the files it names opaque, and a command not provably write-free (any other Python, any script run) makes every tracked file opaque. Replay of a file stops at its first opaque command.
- **Direct sandbox-path references** in artifact text (e.g. `<img src="/mnt/user-data/uploads/foo.png">`) → rewritten to base64 data URIs in `populateConversationFolder`'s inline-pass (Piece A — pure mechanical substitution, no inference).
- **Arbitrary `bash_tool` mutations** (Python scripts that compute what they write, non-literal `sed -i`, awk pipelines, etc.) → **the extension does not try to replay these.** `detectOpaqueMutations` names the file (relative paths read against `commandCwds`: the command's leading `cd`, else the last one carried from an earlier command, unknown after a failed command; `resolveSandboxPath`; with a carried directory or a leading `cd` not followed by `&&`, a join that is no known file falls back to every known file of that name, unresolved: `resolveTouch`; known paths compared normalized, `normalizedKeys`), merges each file's commands into one entry with its export name (`index[key].filename`), and `sortOpaque` sorts each entry, first match wins, "at or after" by (message, block): (a) presented or delivered under its own export name at or after its last change of any kind → dropped, the download replaces the final and last `_vN` (this also matches a copy presented from elsewhere that took the file's export name); (b) files delivered or presented at or after it from its folder or below (`isUnderFolder`, whole segments), or for a draft under `/home/claude/` from `/mnt/user-data/outputs/` when the stem matches or a non-failed bash command at or after the last change names the draft and outputs → note `draft_superseded`; (c) a run script (`.py .sh .bash .pl .rb`) never presented or delivered, or an unresolved entry whose candidates all are → note `helper_script`; (d) otherwise → warning `artifact_opaque_mutation` pointing at `replay_bash.py`. Files with skipped edits (`index[key].skipped`, `skippedAt`), including a file tool the replay doesn't model naming the file (`MultiEdit`, `NotebookEdit`, ...; not `READ_FILE_TOOLS`), get an entry even when the detector names no command.

The CLI does what the extension can't safely do: runs Claude's actual scripts in a tmpdir with `/home/claude`, `/mnt/user-data`, `/tmp` and `/root/.claude` path-rewritten into it, with per-command confirmation. Commands are untrusted: `sandbox_profile` applies a deny-by-default `sandbox-exec` profile, `sandbox_path` rejects paths and symlinks leaving the tmpdir, and `command_env` keeps tokens out. Never weaken these without saying so in `USAGE.md`. See `docs/WASM_REPLAY_APPROACH.md` for the architectural reasoning (we briefly shipped JS regex-based recipe matchers, then removed them once the CLI proved more reliable and covered more cases).

The detector checks Python writes (`open(p, 'w'|'a'|'x'|'r+', ...)`, `Path(p).write_text/bytes`) on the whole command, and shell writes per simple command (`shellSegments`, which respects quotes): redirects, `sed`/`perl` in place, `tee`, `cp`/`mv`/`install` onto the file, `dd of=`. Heredocs themselves (header and body) are removed before these checks, and a heredoc with an unquoted delimiter whose body has `$`, a backtick or `\\` is flagged, since bash expanded it. If you change the opaque-mutation detector's heuristics, the replay shapes or the sorting rules: keep them tight. When unsure, warn. The signal it produces is the only thing pointing users at the CLI, and a missed signal means a silently-incomplete export. `replay_bash.py` starts from its own declarative state before each command (`replay_steps`), so a swap the export already replayed is applied once (`tests/test_replay_bash.py` guards it).

## 11. Error reporting (`ExportErrorCollector`)

Anywhere in `populateConversationFolder` (or any function it calls) you can record:

```javascript
errorCollector.addError(type, filename, error, { uuid, path, urlsTried, httpStatus, fallbackAttempted, fallbackResult, rawError });
errorCollector.addWarning(type, filename, message, { uuid, path, note });
errorCollector.addNote(type, filename, message, { uuid, path, note });
```

A warning means something may be missing; a note (since v1.22.1) explains a file with nothing missing. Notes are never counted (Done headline, footer `exportRecord.warnings`, `index.md` issue counts) and don't turn the status amber; they go in the chat README's **About some files** (`readmeNoteLines`), `errors.txt` under `## Notes` (an export with only notes still gets one), the viewer (`viewerFlags`: `draft`, `helper` badges; a warning's flag wins) and one quiet line on Done. Note types, each with a `_getNoteHint` case: `draft_superseded`, `helper_script`, `name_changed` (see §10 and §6).

Recognized `type` values (all map to a case in `_getRecoveryHint`):
- `upload` — uploaded-file download failed.
- `presented_file` — `present_files` blob extraction failed.
- `project_doc` — project document fetch failed (or only available truncated from view tool results).
- `project_metadata` — `/projects/<uuid>` 4xx/5xx; `project.json` may be missing.
- `str_replace_failed` — an edit that succeeded in the conversation couldn't be replayed. Cleared if the file is then downloaded in its final state.
- `artifact_basename_collision` — two paths produced the same basename; one was renamed. New exports add the note `name_changed` instead; the type stays for older archives (`_getRecoveryHint`, `warningsFromReport`, `WARNING_NOUNS`).
- `artifact_opaque_mutation` — a bash command changed an artifact in a way replay can't follow, and rules a–c (§10) didn't explain it. One per file, counting its commands.
- `delivered_file` — a `SendUserFile` delivery could not be downloaded.
- `claude_doc_unreplayed` — a Claude Docs edit other than filling a pending section; the note links the live document.
- `doc_diagram` — a Claude Docs document has diagrams still shown by caption (no saved screenshot) and the chat has no self-contained HTML copy of it.
- `tool_image` — an image Claude looked at (tool result linking a claude.ai file, `toolImagesOf`) couldn't be downloaded into `images/`.
- `web_image` — an image from a web search wasn't saved in `images/`: no permission (one warning for all) or the site refused it.
- `published_page` — a page Claude published could not be saved, or only partly: no claude.ai tab, a failed request (one 401 warning per export), a file over the caps, a checksum mismatch, a renamed or rejected path. Messages carry codes only, never a URL or token.
- `artifact_export` — Export Artifacts, or Export All's artifact step, could not save an artifact or part of one: a failed request (one 401 warning, then it stops), a file over the caps, a checksum mismatch, a renamed or rejected path, a full list that could not be paged or was cut at its page cap, artifacts found only by paging (a count), or the step stopping early on an unexpected error. The standalone export writes it to its root `errors.txt` (collector labelled "Export Artifacts"); Export All writes it to `artifacts/errors.txt`. Codes only, never a URL or token.
- `export_health` — claude.ai's data for the chat looks incomplete (`chatHealth` in export-core.js: no messages although the chat changed, messages with no content, an unknown current branch in a branched chat, content block types the export doesn't show; and in `populateConversationFolder`, none of several uploads downloaded). The status line turns amber; single Markdown and JSON exports run `chatHealth` too (`exportedStatus`). Keep the checks calibrated on real chats: a chat opened and never used has no messages and is healthy, and an empty assistant message within 5 s of a complete assistant parent is claude.ai's own tail, not hollow.
- `session` — the session list failed or may be incomplete (exactly 100, the most claude.ai returns), a session's events failed or were cut by a cap (20,000 events, 64 MB), the ZIP's 256 MB session budget was reached, or an image couldn't be saved. Codes only. A failure never fails or slows the chats.
- `viewer` — one chat could not be added to `viewer.html` (`buildViewerChat` threw). A failure of `writeViewer` as a whole is not recorded here: the status line says "viewer.html could not be built." The export itself is complete.

`errors.txt` is built by `generateErrorReport()` and embedded into the ZIP only when `hasAny()` is true. The status pill turns amber (`.status.warning`) when there are warnings but the export still succeeded.

**Rule for new failures:** add a new `type`, add a `_getRecoveryHint` case, and make sure the `addWarning`/`addError` call site passes the useful `details` fields. Never silently swallow a fetch failure — surface it.

---

## 12. Encoding rules

- **All `.md` files written to ZIPs get a UTF-8 BOM** (`addFileWithBOM`). Reason: Chrome's `file://` opens markdown as text/plain and infers encoding from the BOM. Without it, em-dashes and umlauts mojibake when opening exports locally.
- **All text content is run through `fixMojibake`** at extraction time (text attachments, project docs, etc.). Map is built lazily on first use and covers Latin/Greek/Cyrillic/math/box-drawing/arrows/super-sub/emoji ranges.
- **Never decode a binary file as text:** `addArtefactBlob` keeps raw bytes unless `isTextFile` recognizes the extension. Calling `blob.text()` on a PDF, ODT or ZIP destroys it, and `file` still reports the type because the header survives. Test with `unzip -t` or a real viewer.
- **Code fences are dynamic:** `getCodeFence(content)` returns ```` ` ```` x4 when content already contains a triple backtick. Apply this whenever you emit a fenced block whose content is user/Claude-supplied.

---

## 13. Conventions

- **Commit message style** (see `git log`):
  - One-line subject summarizing the user-visible effect.
  - Bullet body describing each significant change.
  - A `Co-Authored-By` trailer naming the model that did the work.
  - Use HEREDOC for the `-m` arg to preserve formatting.
- **No automatic pushes.** Commit freely; only push when the user explicitly says so.
- **No mass `git add .`** — stage the specific tracked files plus any new files that genuinely belong to the project. Never accidentally commit `.claude/`, transcripts, or `.DS_Store`.
- **Tests:** run `sh tests/run.sh` before committing. See `tests/README.md`. Never put real conversations or exports in the repo, because they're private; add a synthetic case to `tests/fixtures/conversation.json` instead. Mocks have missed real claude.ai behavior here, so also export a real conversation for anything touching fetching or capture. `extract_artifacts.py` and the `validate-export` skill (bearspear/claude-skills, `plugins/archives/skills/validate-export/SKILL.md`; the `archives` plugin) must stay in sync with `export-core.js`. `tests/export.test.js` also pins every file an export writes against `tests/fixtures/export-baseline.json` (refresh steps in `tests/README.md`).
- **No `_`-prefixed files or folders:** Chrome refuses to load an extension containing one, including `__pycache__`. Run Python with `-B`, and never import these scripts without `sys.dont_write_bytecode = True`.
- **Viewer rendering:** the viewer renders chat text through escaped raw HTML, text-node placeholders and `sanitizeHtml`. Keep all three when changing it. `tests/e2e/viewer.e2e.js` is the only coverage for `sanitizeHtml`, so run it after viewer changes. The viewer page's CSP keeps `'unsafe-inline'` and `'unsafe-eval'` for scripts, and `'unsafe-inline'` for styles, because `srcdoc` previews inherit the page's policy and `PREVIEW_CSP` can only narrow it; removing either breaks previews (`new Function` in a generated file). Previews are sandboxed but not a security boundary for untrusted exports: a generated file's own text and that chat's `.js` and `.css` can leave, while the viewer, other chats and files on disk can't be reached (see `USAGE.md`). Every preview document ends with `SIZE_SCRIPT` (it posts the page size as `ct-size` to the viewer for the zoom bar's Fit width), and nothing else about a preview changed for zoom.
- **Syntax colors:** highlight.js can run for minutes on some text, such as one very long word, so never call it on the page. It runs in a blob worker (`worker-src blob:`) built from the `#highlighter` script tag, one block at a time, and is stopped after `HIGHLIGHT_TIMEOUT`. Colors only appear as a block scrolls into view, and any failure leaves the block plain. Unlabeled fences are not guessed. Before first use the worker runs `tameMarkdown` (in `viewer-logic.js`, passed in as source), which stops `_` inside a word from opening italics and ends italics and bold at a blank line. `tests/e2e/colors.e2e.js` covers this.
- **Syntax check after every edit:** `node --check popup.js`. Catches most copy/paste mistakes without launching Chrome.

---

## 14. Keeping TECHNICAL.md accurate

`TECHNICAL.md` describes how each part of an export is built (last checked at v1.23.0, its viewer section updated for v1.24.0, with sessions added for v1.25.0). It names functions instead of copying their code, so it doesn't go stale with every edit. When you change behavior it describes (data loading, versioning, the download order in `fetchUploadedFile`, the ZIP layout, warning types, the viewer, the old-archive tool), update its section in the same PR. This file stays the entry point.

---

## 15. Where to look for common tasks

| You want to… | Look at |
|---|---|
| Add a new export format | `popup.html` (button) + `popup.js` click handlers + a new `generate<Format>` function; the bulk path is `bulkExportZip`, which writes each chat through `populateConversationFolder`. |
| Render a new tool call inline | `convertToMarkdown`, in the `tool_use` branch. |
| Extract a new file type to disk | New `extract<Foo>(data)` function; call site in `populateConversationFolder`; possibly a new folder under the ZIP layout. |
| Add a new API fetch with retry | Pattern-match `fetchUploadedFile`: primary URL, fallbacks, per-URL `urlsTried`, surface failures via `errorCollector`. |
| Change versioning rules for artifacts | `extractArtifacts` (§6). Also update `extract_artifacts.py` to match. Re-run validation against the `Sudden_acid_reflux_in_young_adults` fixture if available locally. |
| Adjust the ZIP layout | `populateConversationFolder`. README's "ZIP Archive" section is the user-facing contract — update it too. |
| Change the offline viewer | `viewer/` (page), `takeout-viewer.js` (data contract), `writeViewer` in `popup.js`. Update `tests/viewer.test.js`, run `tests/e2e/viewer.e2e.js`, and keep the `USAGE.md` preview note accurate. |
| Change the old-archive tool | `tools/build_viewer.js`, `tools/archive-lib.js`, `tools/archive-zip.js`. Never let it write anything but `viewer.html`, `viewer-check.gif`, `viewer-files/` and new folders under `--out`. Merge changes go in `tools/merge_archives.js` (update `tests/merge.test.js`). Update `tests/archive.test.js`, run `tests/e2e/archive.e2e.js`, and keep the USAGE.md sections "Adding a viewer to older archives" and "Combining archives" accurate. The external `build-archive-viewer` skill documents the old refusal and needs the same update. |
| Add a setting | Add to `defaultSettings`, `loadSettings`, `applySettings`, the Settings screen's markup in `popup.html` (then copy the file to `sidepanel.html`; the pages must stay identical), and the change handler block. A choice that belongs next to Export selected goes on the main screen instead (see `setChoice`). |
| Add a keyboard shortcut | The `SHORTCUT_BUTTONS` map (key to button id) beside the `keydown` handler, and the `<span class="shortcut">` markup in the relevant button. |
| Bump README's changelog | Add a `### v<next>` section at the top of the changelog, and bump `manifest.json` in the same PR. |

---

## 16. Known fixtures / test conversations on this machine

- `~/Downloads/claude-takeout-2026-06-02/Sudden_acid_reflux_in_young_adults/original.json` — the per-turn versioning fixture. Two edited artifacts (`daily-supplement-protocol.html`: 3 versions; `anxiety-reflux-reference.html`: 6 versions). `md5(daily-supplement-protocol_v1.html) == dad1c8cccfdf02a55a20d1f0d95d7465`.
- `~/Downloads/[nr_5-project]_de_verbo_interno_claude-chat 2/original.json` — the "abandoned draft artifact" example (Claude `create_file`s a near-empty stub `diagrams.html`, then creates the real `canonical-lorber-diagrams.html`). Useful for exercising the basename-collision warning if you ever route those through the same key.

Both can be re-validated with:

```
python3 extract_artifacts.py path/to/original.json -o /tmp/expected/
diff -r /tmp/expected/ path/to/export/artefacts/
```

A clean diff (or only the unversioned-final equivalent to `_vN`) means the JS extractor is in sync with the Python port.

---

*Last updated 2026-11-25. Keep this file accurate — it's the contract a future agent reads before touching anything.*
