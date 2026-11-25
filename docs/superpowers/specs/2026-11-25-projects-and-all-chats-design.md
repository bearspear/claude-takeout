# Projects page and All chats in the offline viewer (v1.24.0)

Status: draft for the owner's approval; builder check and a critical review done, answers folded in (marked "My call" where it was my decision). Written 2026-11-25.

## Why

In a multi-chat export the viewer's sidebar lists every chat, grouped under one heading per project. There is no place to see a project itself (its instructions, knowledge and chats together), and the sidebar becomes one very long list in a big Export All. The owner wants it to work like claude.ai: a **Projects** page and a project page, and a sidebar with a short **Recents** list plus **View all**.

## Goals

1. A **Projects** page: a grid of project cards, like claude.ai's.
2. A **project page**: the project's name and description, its chats, its instructions and its knowledge files and documents.
3. The sidebar of a multi-chat viewer: **Projects** and **Chats** entries, then **Recents** (the newest chats) and **View all**.
4. An **All chats** page: every chat, newest first, filterable.

## Non-goals

- Projects with no chats. They stay out (owner: "empty ones can be excluded"), so the export needs no new request: projects are still found through their chats.
- Editing, starring, sorting menus, or anything claude.ai offers beyond reading.
- Changing search. The sidebar search and its results work as today.
- A single-chat ZIP's viewer: unchanged.

## Anti-goals

- No new network request at view time, no change to the page's CSP, sandboxing or `sanitizeHtml`.
- No new export request: what the cards show comes from data already fetched.
- Older archives must not break: a viewer built by `tools/build_viewer.js` or `merge_archives.js` from an older export shows the same pages, with less on a card when the data lacks it.

## Data (export side)

`viewerProject` (export-core.js) gains an optional last parameter `meta`: the project record claude.ai returns, which `populateConversationFolder` already holds as `projectMetadataJson` (written as `project/project.json`) and `tools/archive-lib.js` already reads as `meta`. Both pass it. From it the viewer's project gets `id` (`meta.uuid`, else the chat's real `project_uuid` or `project.uuid`; never the placeholder `'project'` that `tools/archive-lib.js` sets when original.json has none, so unrelated older projects are never joined), `description` (`meta.description`) and `updated` (`meta.updated_at`). Missing fields stay absent; a failed metadata fetch (no record) gives only the `id` from the chat. (`created` is not needed: nothing shows it.)

`buildProject` in takeout-viewer.js, which rebuilds the project for `ViewerData` with only `name`, `files`, `instructions` and `docs`, passes the new fields through when they are strings, and the `ctx.project` contract in takeout-viewer.js's header comment says so. Description text goes through `fixMojibake` like the instructions, and is cut at the same limit. *(My call: the record's field names are claude.ai's `uuid`, `description`, `created_at`, `updated_at`; the e2e fixture and a real export check them.)*

`buildViewerData` still stores each project once (`ViewerData.projects`, chats point at an index). Two chats' projects with the same `id` are one project even if their copies differ (an older and a newer fetch): the copy with the newest `updated` wins; on a tie (or no dates) the copy with more docs and files, since a failed fetch gives a thinner copy; else the first. Every chat of that project then shows the winner's instructions and knowledge in its fold bar too. Without an `id` (older archives), today's rule (equal content) stands, and two such projects with one name keep "Name (2)".

## The viewer

### When it applies

A viewer with more than one chat (`chats.length > 1`: Export All, merged archives, the old-archive tool on a folder of exports). With one chat or none, nothing changes, even when the viewer has an Artifacts screen.

### Sidebar

Top to bottom, under the search box: **Artifacts** (as today, when present), then **Projects** and **Chats** as entries beside `#artifacts-nav`, outside `#recents` (search hides `#recents` while it shows results; the entries stay). Like Artifacts, each closes the phone drawer (`setDrawer(false)`). **Projects** has a count (only when at least one chat has a project), **Chats** with a count (it opens the same All chats page as View all), then the label **Recents** and the 30 most recently updated chats (by the chat's `updated`, project chats included). The per-project headings in the sidebar go away in a multi-chat viewer: projects live on their own pages now. Below Recents, when there are more than 30 chats, **View all** opens the All chats page. The current chat is marked when it is in Recents; a chat outside Recents (opened from search, All chats or a project page) is not added to the list, as on claude.ai.

### Routes

New hashes, beside the chat viewer's own and the Artifacts screen's (`#artifacts`, `#a=`, `#ac=`): `#projects` (the grid), `#project=<key>` (a project page; key = the project's `id`, else `i<index>`, its index in `ViewerData.projects` after `buildViewerData` and `linkProjects`, for an older archive's project without one; such a key may change when the archive is rebuilt, which is acceptable) and `#chats` (All chats). Back and Forward move between them like any other hash. They are routed after the Artifacts screen's hashes and before the chat viewer's. An unknown project key shows the Projects page.

The three pages are one screen, `#lists-screen`, in `main` in place of the chat, built by viewer-app.js (like the Artifacts screen: the chat's top bar title becomes the page's, and closing it puts the chat's back). The Projects and Chats entries are marked `aria-current` while their page shows.

Screen state, so titles and screens never get mixed up:
- One saved title pair (`titlesBefore`), taken only when leaving the chat for either screen, put back only when returning to a chat. Going Projects → Artifacts → a chat puts the chat's title back.
- The lists screen and the Artifacts screen hide each other.
- `navigate` closes the lists screen as it calls `showArtifacts(false)`, including on its early return when the chat is already drawn.
- `start()` routes the list hashes (after the Artifacts screen's, before the chat viewer's), so opening the file at `#projects` shows Projects, not a chat.
- `parseListHash` matches whole hashes only (`#projects`, `#project=<key>`, `#chats`), so no chat hash matches.
- Rows on the new pages never use the class `.item`, so the sidebar's `aria-current` loops don't mark them.
- Each page has a heading (`tabindex="-1"`) that takes focus when the page opens, and `document.title` becomes "Projects - Claude Takeout", "<project name> - Claude Takeout" or "Chats - Claude Takeout".

### Rendering

Every name, description, instruction and title on these pages is plain text, set through `el`/`textContent` as `renderProject` does today: no Markdown, no `innerHTML`. An empty project name shows "Untitled project", an empty chat title "Untitled". A chat or project with no date shows no "Updated" line (`relativeTime('')` is empty).

### Projects page

Title "Projects", a filter box (matches name and description, case-insensitive), and a grid of cards (responsive: one column on a phone). Each card: the name, the description (two lines, cut with an ellipsis; none when empty), and "N chats · Updated <relative time>". The time is the newest of the project's `updated` (when the data has it) and its chats' `updated`. Cards are sorted by that time, newest first. A card is a link to the project page. Two projects with one name keep today's "Name (2)".

### Project page

A back link "All projects", the name, the description. Then two columns (one on a phone, the panel first):

- **Chats**: each of the project's chats, newest first: its title (a link that opens the chat) and "Updated <relative time>" (the chat's `updated`). A filter box when the project has more than 10 chats. Rows come 200 at a time with **Show more**, as on All chats.
- **Panel**: **Instructions** (the project's prompt, collapsed to about 8 lines with Show more, when there is one) and **Knowledge** (the files and documents, as the chips the chat's project fold shows today, opening the same way). "No instructions" / "No knowledge" when empty.

### All chats page

Title "Chats", "N chats", a filter box (matches the title), and rows newest first: the title, the project's name when it has one (a link to the project page), and "Updated <relative time>" (the chat's `updated`). For a large archive the rows come 200 at a time with **Show more**, so the page opens quickly. Every filter searches all the chats or projects, not only the rows shown.

### From a chat to its project

The fold bar of a project chat (`#project`) gets a link "Open project" that opens its project page.

## Pure helpers (viewer-logic.js, tested in Node)

- `recentChats(chats, n)` → the n newest by `updated` (missing dates last, then the array's order).
- `projectList(chats, projects)` → the projects that have chats, each `{ key, name, description, updated, chats }` (chats newest first, name "Name (2)" as `groupChats` does for a second project of one name), sorted newest first. `groupChats` stays for the single-chat sidebar.
- `filterByText(items, query, fields)` → the items whose fields contain every word of the query (case-insensitive, `foldCase`).
- `parseListHash(hash)` → `{ page: 'projects' | 'project' | 'chats', key }` or null.

## Testing

- Unit tests for the helpers and for `viewerProject`'s new fields (`tests/viewer.test.js`, `tests/export.test.js` or the matching file), and for `buildViewerData` merging by `id`.
- A new browser test `tests/e2e/projects.e2e.js` on a synthetic multi-chat viewer (more than 30 chats, three projects, one without description, one older-format project without an `id`): the sidebar (Projects, Chats, 30 Recents, View all), the Projects grid (cards, counts, order, filter), a project page (chats, instructions, knowledge chip opens), All chats (order, project link, filter, Show more), Open project from a chat, Back/Forward, a single-chat viewer unchanged, no network, no page error.
- `viewer.e2e.js`'s sidebar group checks (an 8-chat viewer expecting the headings `Recents|Alpha|Zeta` and project chats under them) are rewritten for Recents plus the Projects page. `groupChats` and its unit test stay (the single-chat sidebar uses it).
- `search.e2e.js`, `files.e2e.js`, `combined.e2e.js` and `archive.e2e.js` still pass (combined.e2e's three known failures, also on main, aside).

## Docs

README changelog (v1.24.0) and manifest; USAGE.md viewer section; TECHNICAL.md viewer section; CLAUDE.md test table (the new e2e row).

## Left to the builder

Exact CSS (follow the viewer's existing tokens, light and dark), icons, and wording of empty states beyond those above.
