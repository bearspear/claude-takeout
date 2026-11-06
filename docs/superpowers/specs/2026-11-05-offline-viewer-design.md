# Offline chat viewer (v1.6) design

## Intent

Every Claude Takeout ZIP gets a `viewer.html`: a read-only copy of claude.ai for the exported chats, opened from disk with no internet or login. The owner will use it for everything they'd do in the original: finding something, rereading a chat, and showing a chat to someone.

The owner's words: "it mimics the original chat". It follows the approach of the NotebookLM exporter's viewer, at `/Users/mbehringer/Downloads/notebooklm-exporter` (`viewer/`, `takeout-viewer.js`, `tools/build_viewer.js`).

## Success

Opening it feels like being on claude.ai. Getting that feel is the top priority, and small differences are acceptable where offline use requires them. The failure the owner would wince at is something that works but doesn't feel like the real site.

## Goals

- `viewer.html` at the root of every ZIP, single-chat and mega-ZIP, offline.
- Mega-ZIP: one viewer with all chats in a left sidebar, like claude.ai's. (Owner's decision.)
- Single-chat ZIP: the same viewer, with one chat in the sidebar. (Builder's assumption, not contradicted in playback.)
- Center: the chat, in claude.ai's style. User messages in bubbles, assistant text in the serif style, attachment chips, generated-file cards, timestamps.
- Uploads and attachments open in a popup over the chat. (Owner approved mockup.)
- Generated files open in a right side panel. (Owner approved mockup.)
- Thinking blocks and tool calls collapsed by default, and expandable. (Owner confirmed.)
- `< 2/3 >` arrows on regenerated messages, browsing the full tree, including branches the other export files skip. (Owner's decision.)
- Side panel: Preview and Code views, and version buttons when a file has `_vN` copies.
- Sidebar search across all chats' text.
- Project chats grouped under their project in the sidebar.
- Follows the system's light or dark mode.
- All Markdown and existing export files stay. The viewer adds to the export and replaces nothing.

## Non-goals

- Any writing or sending. It's read-only: no composer, no editing, no retry.
- Cowork sessions, which stay tabled.
- Any network use. No fonts, scripts, images or requests from the internet.
- A hosted version or sharing service.
- Fixing old archives automatically. A tool for that is a possible later addition.

## Anti-goals

- Looks like a generic document viewer rather than claude.ai.
- Generated content reaching the viewer page, other chats or files on disk, or making any network request the browser lets the viewer block. A few routes can't be blocked; the owner accepted them on 2026-11-06, as listed under **Generated file previews**.
- Any sign of Anthropic's logo or wordmark as if this were the official product. It reads "Claude Takeout", is marked read-only, and uses the look and layout only.
- Any change to what existing export files contain.

## Constraints

- **Offline from `file://`.** Page code can't `fetch` local files, so chat data is embedded in `viewer.html`. Binary files stay as relative links, so the page stays small. Users must unzip first, as with NotebookLM. A viewer opened from inside an unextracted ZIP must say so, not fail silently.
- **Generated content is untrusted.** Chat content can be shaped by prompt injection. Generated HTML and SVG run in a sandboxed `iframe` with no same-origin access and a content policy that blocks ordinary requests, but not every route out (see **Generated file previews**). Markdown is sanitized before display. Nothing from a chat runs in the viewer's own page.
- **Extension rules.** Nothing `_`-prefixed in the repo. `tests/run.sh` must pass. New code follows `CLAUDE.md`, and the manifest and changelog move together. New standalone files are justified here, as a non-trivial addition.
- **Private data.** Tests use the synthetic fixture only.
- **Size.** Must cope with a mega-ZIP like the owner's: 18 chats, one chat with 127 messages, and a 3 MB `original.json`. Artifact text and chat text can be large, so rendering a chat must not freeze the page.
- **Mega-ZIP paths.** Files live in per-chat folders, and project files in the shared `projects/` folder. The viewer must link to the right location in both layouts.

## How it gets made (builder's calls, for the owner to check)

- Same structure as NotebookLM: `viewer/viewer-template.html`, `viewer/viewer-app.js`, plus a `takeout-viewer.js` builder. `marked` and KaTeX are vendored with their notices, and inlined into the single page.
- The look is built from scratch by hand with CSS. No claude.ai code, fonts or images are copied. System fonts stand in for its typefaces.
- Pure logic, such as tree walking and URL handling, is kept in testable functions. Node tests use the synthetic fixture, extended with a branched conversation. `tests/e2e` adds a Chromium check of the unzipped viewer.
- A `tools/build_viewer.js`, as in NotebookLM, is a possible follow-up, not part of v1.6.

## Details

**Which files go where**

| Thing | Opens in |
|---|---|
| Uploaded file or pasted attachment | Popup. Images, PDFs and text display. Others show details and a link to open the file. |
| Replayed or presented artifact | Side panel |
| `SendUserFile` delivery | Side panel if displayable. Otherwise a file card with a link. |
| Project knowledge file | Popup, from a project section on the chat |
| Image in a tool result | Inline if available in the export |

**A failed or missing file** shows a clear "not in this export" state rather than a broken link, reusing what `errors.txt` knows where practical.

**State** such as open chat and panel survives a refresh through the URL hash.

**Branches:** the data includes all messages. The chat view starts at `current_leaf_message_uuid`, and arrows switch among siblings. Artifact cards on inactive branches show content from the tool call where available. Files that were never exported on those branches show the "not in this export" state.

**Rendering:** Markdown with code fences, tables and math. Citations appear as numbered links with their sources. Tool calls show as a collapsed line that expands to input and result.

**Generated file previews:** previews run scripts, because 55 of the owner's 61 generated HTML files use them. The content policy blocks ordinary requests, with no button to allow them. (Owner's decision, 2026-11-06.)

The browser doesn't let the viewer block these routes, and the owner accepted them:

- `<link rel=prerender>`, which sends its full URL
- WebRTC STUN and TURN
- a connection opened by a blocked navigation

So a malicious file could send out its own text, and any exported `.js` and `.css` files from the same chat, which is why only those are fed into the sandbox. It can't reach the viewer page, other chats or files on disk.

Across the owner's 61 generated HTML files, there's no React or Mermaid:

| Files | Preview |
|---|---|
| 9 self-contained | Displays as is |
| 44 with remote fonts or CSS | Displays with substitute fonts or partial styling |
| 6 loading a sibling script from `artefacts/` | The builder feeds that sibling into the sandbox |
| 2 needing a remote script | May be partly or fully broken, so the panel explains why and offers Code view |

If a file type can't display at all, such as `.py`, it opens in Code view. React and Mermaid runtimes aren't vendored, since nothing needs them yet; those types get Code view plus a clear "can't preview offline" note.

## Visual reference

`2026-11-05-offline-viewer-mockup.html`, beside this document, is what the owner reviewed: "roughly right". It uses made-up content, and needs the visual companion's frame or similar styling only for its outer page.

The builder may look at claude.ai for reference, but copies no code, fonts or images from it.

## Left to the builder

Exact spacing, icons and colors, within "feels like claude.ai". How large content is rendered without freezing. How search is indexed. Whether files stay `viewer/` or are merged. The order of work.

## Testing the feel

Mock tests can't judge feel. The first stage is therefore a look-only build of the layout and message rendering, using one chat, for the owner to review before the rest is built on it. The owner then reviews real exports in stages before release.
