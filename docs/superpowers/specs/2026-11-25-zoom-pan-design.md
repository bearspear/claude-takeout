# Zoom and pan in the viewer (v1.23.0): design

## Intent

Some artefacts are hard to read at the size the viewer shows them. Dense diagrams (the De luce cosmogony), wide posters and slide pages laid out wider than the panel, and Design canvases with many boards all need the reader to get closer or step back. The owner asked for zooming and dragging tools "where it makes sense" and skipped further questions, so the scope below is the proposal they accepted in chat:

- **Pictures** (the file *is* an image): zoom and drag.
- **Pages** (HTML that scrolls, selects text and may run scripts): zoom levels only, no drag, so the page keeps its own clicks and selection.
- **Design canvas:** zoom and drag.
- **Text, Markdown and code:** nothing; they wrap and browser zoom covers them.

Success: a reader can open any diagram, image, page or canvas in the viewer and read its smallest text without leaving the viewer, using a mouse, a trackpad, a keyboard or a phone.

## Goals

1. One shared zoom-and-pan helper used by the chat viewer (`viewer/viewer-app.js`), the Artifacts screen (`viewer/artifacts-app.js`, standalone and hosted in the chat viewer's shadow root) and the Design canvas. Its pure parts (clamping, steps, zoom about a point, fit) live in `viewer/viewer-logic.js` and are unit-tested in `tests/viewer.test.js`.
2. Pictures zoom and pan in every place they are shown large (list below).
3. HTML page previews get a zoom bar.
4. The Design canvas zooms past its current fit-only scale and pans by dragging its empty background.

## Non-goals

- Text, Markdown and code views (`pre.file-code`, rendered Markdown in the panel).
- Small pictures inside the chat flow (mosaic tiles, tool-image thumbnails, product pictures): they keep opening the gallery, which is where zoom happens.
- Remembering zoom across files, page loads or sessions. No storage.
- Rotating, cropping, measuring, annotating.
- Zooming *inside* a page's own content or changing how a page handles its own wheel and pointer events.
- PDF previews (the browser's PDF viewer has its own zoom).

## Anti-goals (would make this a failure even if it works)

- Weakening any security boundary: the page CSPs (`viewer-template.html`, `artifacts-template.html`), `PREVIEW_CSP`, the iframe `sandbox` flags, the hosted guard frame (`guardDoc`) and `sanitizeHtml` stay exactly as they are. Previews still don't get `allow-same-origin`.
- Breaking scrolling: a plain wheel or two-finger scroll over a picture in the panel or Artifacts page must still scroll that panel or page, not zoom it.
- Breaking the gallery's existing keys (Left/Right for previous/next, Escape, the Tab trap) or the click-outside-to-close.
- A new library. The viewer stays self-contained (`writeViewer` inlines everything).

## Where each mode applies

| Place | What is shown | Mode |
|---|---|---|
| Gallery (`openGallery`): web images, tool images, product pictures | `<img>` in `.gallery-stage` | Picture |
| Inline `show_widget` diagram (`renderDiagram`, `figure.diagram`) | SVG as `<img>` | Click opens it in the gallery as a one-item gallery, `cursor: zoom-in`; zoom happens there. The ⋯ menu stays. See "Gallery items" below. |
| Upload popup (`popupContent`, image kinds) | `.file-paper > img.file-image` | Picture, in place |
| Chat side panel (`previewNodes`), image kinds | `.file-paper > img.file-image` | Picture, in place |
| Chat side panel and Artifacts screen, `.svg` files | today an iframe | Picture: the same inlining runs first (`inlineSiblings` in the chat panel, `inlineArtifact` on the Artifacts screen), then the result is shown as `<img src="data:image/svg+xml…">`. It stays an iframe page with the zoom bar (below) when the SVG text has `<script`, an `on…=` attribute, or, after inlining, still refers to anything outside itself (an `http:`/`https:`/`//` URL, or an `href`/`src`/`url(…)` that isn't a `data:` URL or a `#fragment`; the case where today's preview shows `REMOTE_NOTE`). |
| Artifacts screen (`fillPreview`, `fillFile`), image kinds | `div.image > img` | Picture, in place |
| Chat side panel and Artifacts screen, HTML previews (`previewFrame`) | sandboxed iframe | Page |
| Artifacts screen, Design canvas (`openCanvas`, `canvasPage`) | boards as scaled iframes | Canvas |
| Single Design board (`openBoard`) | one board at native size | Page |

## Picture mode

- **Layout:** the picture sits in a scroll container (the existing stage, `.file-paper`, or `.image` box, made `overflow: auto`). Zoom sets the picture's rendered width and height; panning is that container's scroll position. This keeps native scrollbars, keyboard scrolling and two-finger trackpad panning working for free.
- **Start:** "Fit": the whole picture visible, never enlarged above 100% to fit (today's look). 100% means the picture's natural size; for an SVG, its `width`/`height` attributes, else its `viewBox`, else the fitted size.
- **Range:** from the smaller of Fit and 10%, up to 800%.
- **Zoom in and out:**
  - Pinch on a trackpad, and Ctrl/⌘ + wheel, zoom about the pointer everywhere (the listener must be non-passive and call `preventDefault`, so Chrome's page zoom doesn't fire over the picture).
  - In the **gallery only**, a plain wheel also zooms about the pointer, since there is nothing to scroll there. Everywhere else a plain wheel scrolls as it does today.
  - Touch: two-finger pinch zooms about the midpoint.
  - Buttons: −, the current percentage, +, Fit. Steps: 10, 25, 33, 50, 67, 75, 90, 100, 125, 150, 200, 300, 400, 600, 800 (%); + and − go to the next step beyond the current value.
  - Double-click (double-tap on touch): at Fit, go to 100% about the point (200% if 100% is not larger than Fit); otherwise back to Fit.
  - Keys, while the picture area or its bar has focus (and always in the gallery): `+`/`=` in, `-` out, `0` Fit, `1` 100%. They don't conflict with the gallery's Left/Right.
- **Drag:** when the picture is larger than its container, press-and-drag (mouse, pen, or one finger) pans; cursor `grab`/`grabbing`. At Fit, dragging does nothing. A press that moves more than 4 px is a drag, not a click, so the gallery's click-to-close doesn't fire after a drag.
- **The bar:** small, overlaid at the bottom right of the picture area, visible on hover and focus and always on touch screens. Buttons have `aria-label`s; the percentage is announced politely (`aria-live="polite"`). The picture area is focusable (`tabindex="0"`).
- **Reset:** zoom goes back to Fit when a different picture or file is shown (gallery previous/next, another file in the panel). Switching **versions of the same file** keeps the zoom and scroll position (readers compare versions).

## Gallery items

`openGallery` today takes web-image items only (`savedImage`, the site in the footer, "Image from a web search", label "Image preview"). It gets a generic item shape: `{ src, alt, caption, label }`, where the web-image, tool-image and product callers map their items onto it unchanged in what they show, and an inline diagram is `{ src: <its data URL>, alt: <title>, caption: <title>, label: 'Diagram' }`. A diagram opens a **one-item** gallery: with one item, previous/next buttons and the position counter are hidden and Left/Right do nothing. Existing gallery e2e checks (webimages, cards, steps) keep their expectations.

## Page mode

- **The bar:** above or below the preview, in the panel head or preview frame's edge: −, the percentage, +, Fit width, 100%. Same steps as pictures, range 25% to 200%.
- **Start and reset:** 100%, as pages look today. Pages never wait for a measurement to show.
- **How it scales:** from outside the frame only. The iframe gets a layout size of (container size ÷ zoom) and `transform: scale(zoom)` with `transform-origin: 0 0`, inside a wrapper that clips to the container. The page itself is never told or touched; it scrolls inside its own frame as today.
- **Fit width:** only for pages laid out wider than the container. Most pages are fluid and fit already; for them Fit width is 100% and the button is disabled. Rule: with the latest report's `width` and the frame's layout width when that report was taken, if `width` is not more than the layout width + 1 px, Fit is 100%; otherwise Fit = container width ÷ `width`, clamped to 25%–100%. Fit width never zooms in above 100%. Until a report arrives (or never, if the page's scripts fail), the button is disabled. The parent can't read a sandboxed frame's width, so the preview document the viewer builds (`previewDoc`, `artifactPreviewDoc`) gets a tiny measuring script that posts `{ type: 'ct-size', width: document.documentElement.scrollWidth }` to its parent on load and on resize. The viewer accepts the message only when `event.source` is that preview's own `contentWindow`, the width is a finite number, and it clamps the result to the range. A page could send a false width; the worst it can do is pick a zoom within 25%–200% for itself.
  - In **hosted mode** the board or page sits inside the guard frame. If relaying `ct-size` through the guard needs any change to the guard's CSP or sandbox, **don't**: Fit width is then absent in hosted mode and the other buttons remain. (Builder decides whether a relay is possible without loosening anything.)
- **Keys:** the same `+ - 0 1` keys while the bar has focus. Keys pressed inside the page go to the page.
- **No drag, no wheel zoom** over the page: its events are its own (and a sandboxed frame's events don't reach the viewer anyway).
- **Reset:** back to 100% for another file; kept across versions of the same file.

## Canvas mode (Design)

- **Today:** `canvasScale` fits the canvas width to the page, never enlarging (0.1–1); the page scrolls natively; a `ResizeObserver` rescales on window changes; boards load lazily through an `IntersectionObserver` rooted at `#page-body`.
- **New:** a zoom bar (−, percentage, +, Fit) at the canvas's top edge. Range: the smaller of Fit and 10%, up to 200%. Same steps.
- **Wheel:** pinch and Ctrl/⌘ + wheel zoom about the pointer when the pointer is over the canvas background or a board's head or a note; plain wheel scrolls as today. Over a board's frame the events belong to the board.
- **Drag:** press-and-drag on the empty canvas background, a board head or a note pans (by scrolling `#page-body`); cursor `grab` there. Dragging never starts on a board's frame. A board head's existing click (Open alone) still works after a press that didn't move more than 4 px.
- **Resize:** while the reader is at Fit, a window resize refits (today's behaviour). After they chose a zoom, a resize keeps their zoom and the point at the centre.
- **Lazy boards:** keep the `IntersectionObserver` and `CANVAS_MARGIN`; boards come and go as panning scrolls them in and out of view.
- **Hosted:** works the same inside the shadow root (use `composedPath()` where the code already does).

## Constraints

Existing e2e checks keep passing, except those that pin a behaviour this design changes on purpose; those are updated, not deleted: `tests/e2e/artifacts-viewer.e2e.js` "svg: shown in the sandboxed frame" becomes "svg: shown as a picture" (with a separate check that a scripted SVG stays sandboxed).

- No change to CSPs, sandbox flags, `guardDoc`, `sanitizeHtml`, `PREVIEW_CSP` (except the measuring script in the preview document, which runs under the same `PREVIEW_CSP` and sandbox as the page).
- CSS for the chat viewer goes in `viewer-template.html`'s `<style>`; CSS for the Artifacts screen and canvas in `viewer/artifacts.css` (it applies to the hosted mount too).
- `tests/e2e/viewer.e2e.js` and every existing e2e that touches these views (webimages, cards, steps, files, panel, navigation, artifacts-viewer, combined, design) keep passing.
- Light and dark themes: the bar uses the viewer's existing colour tokens.
- Works at phone width (the viewer's phone panel layout).
- Old archives get it when `tools/build_viewer.js` rebuilds their viewer, since it uses the same templates. No change to the old-archive tools.

## Tests

- Unit (`tests/viewer.test.js`): the pure helpers: clamping to a range, next/previous step, zoom about a point (the scroll offsets that keep the point under the pointer), fit, SVG natural size from `width`/`height`/`viewBox`, and the "SVG has scripts" check.
- Browser, new `tests/e2e/zoom.e2e.js` (and its row in CLAUDE.md's file map):
  - gallery: plain wheel zooms; drag pans; a drag doesn't close; double-click toggles; `+ - 0 1`; Left/Right still change picture and reset to Fit;
  - panel image: plain wheel scrolls the panel; Ctrl+wheel zooms; version switch keeps zoom; another file resets it;
  - SVG file: shown as `<img>`; a scripted SVG stays an iframe with the page bar;
  - HTML page: + and − change the frame's scale; Fit width uses the page's reported width; a message from another window is ignored;
  - canvas: bar zooms past 100%; drag on the background pans; drag doesn't start on a board frame; a board head click still opens the board; standalone and hosted;
  - no network requests and no page errors, as the other e2e files check.

## Release

v1.23.0: README changelog entry and `manifest.json` 1.23.0; `TECHNICAL.md` viewer section; `USAGE.md` (how to zoom, the keys); `CLAUDE.md` file map row for `zoom.e2e.js`.

## Calls I made (the owner skipped questions)

- Inline diagrams zoom in the gallery, not in place in the chat, so the chat keeps scrolling normally.
- Plain wheel zooms only in the gallery; elsewhere it needs pinch or Ctrl/⌘.
- SVG files become pictures (`<img>`, which also runs no scripts); a scripted SVG stays a page.
- Ranges: pictures up to 800%, pages 25–200%, canvas up to 200%.
- Zoom is kept when switching versions of the same file, reset for another file, never stored.
- Fit width uses a measuring script posting the page's width; in hosted mode it is dropped if the guard can't relay it unchanged.
- Pages start at 100%; Fit width is only for pages wider than the container and never enlarges.
- SVGs are inlined like today's previews before becoming pictures; one that still points outside itself stays a page.
- The gallery gets a generic item shape; a diagram is a one-item gallery with no previous/next.

## Left to the builder

- Exact bar placement and styling within the existing look.
- Pointer-event details (pointer capture, touch-action values), how the 4 px threshold is measured.
- How the shared helper is split between `viewer-logic.js` (pure) and each app (DOM wiring), as long as both apps use the same pure helpers.
- Whether a `ct-size` relay through the guard frame is possible without changing it.
