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
| Inline `show_widget` diagram (`renderDiagram`, `figure.diagram`) | SVG as `<img>` | The picture is wrapped in a `<button>` (keyboard: Enter/Space) that opens it as a one-item gallery, `cursor: zoom-in`; zoom happens there. The ⋯ menu stays outside that button, and opening it never opens the gallery. See "Gallery items" below. |
| Upload popup (`popupContent`, image kinds) | `.file-paper > img.file-image` | Picture, in place |
| Chat side panel (`previewNodes`), image kinds | `.file-paper > img.file-image` | Picture, in place |
| Chat side panel and Artifacts screen, `.svg` files | today an iframe | Picture: the SVG text as-is is shown as `<img src="data:image/svg+xml…">` (no sibling inlining: `inlineSiblings`/`inlineArtifact` only touch `<script src>`, `<link rel=stylesheet>` and `<img src>`, which do nothing for a picture). It stays today's sandboxed iframe, with the page bar (below), when the text has `<script` (any case) or an `on…=` attribute: such an SVG may need its script to look right. **Fallback:** an `<img>` SVG is parsed as strict XML, while today's iframe uses the forgiving HTML parser, so an SVG with no `xmlns`, an HTML entity like `&nbsp;` or a bare `&` would show blank. On the image's `error` event, or when it loads with `naturalWidth` 0, the view switches to today's iframe with the page bar. |
| Artifacts screen (`fillPreview`, `fillFile`), image kinds | `div.image > img` | Picture, in place |
| Chat side panel and Artifacts screen, HTML previews (`previewFrame`) | sandboxed iframe | Page |
| Artifacts screen, Design canvas (`openCanvas`, `canvasPage`) | boards as scaled iframes | Canvas |
| Single Design board (`openBoard`) | one board at native size | Page |

### Why an SVG as `<img>` is safe

The Artifacts screen today keeps SVG data URLs out of its `<img>` elements on purpose (`SAFE_IMAGE_URI`, `viewer/artifacts-app.js:642`, `(?!svg)`). This design reverses that for `.svg` files, and the PR updates that code's comment to say why: an SVG loaded as an image is stricter than the sandbox. It runs no script, loads nothing from outside (no `<image href>`, `<use href>`, CSS `@import`, `url()` or external entities), and `<foreignObject>` renders but runs nothing. The page CSPs already allow `img-src data:`. So the "stays an iframe" rule above is about **function** (a scripted SVG may need its script), not security: a missed detection costs a picture that looks incomplete, never a leak.

## Picture mode

- **Layout:** the picture sits in a scroll container (the existing stage, `.file-paper`, or `.image` box, made `overflow: auto`). Zoom sets the picture's rendered width and height; panning is that container's scroll position. This keeps native scrollbars, keyboard scrolling and two-finger trackpad panning working for free.
- **Centring:** these containers centre today with flex (`.gallery-stage`, `viewer-template.html:352`; `.file-paper`, `:405`; `.preview .image`, `artifacts.css:127`). With `overflow: auto` a flex-centred child that grows past the box gets its top and left cut off, unreachable by scrolling. Centre with `margin: auto` on the picture instead, and give `.file-paper` `min-height: 0` so the paper scrolls rather than `#panel-body`.
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
  - Where it lives: `renderPanelBody` rebuilds the panel body and sets `scrollTop = 0` (`viewer-app.js:1683`), so the zoom state is kept outside the DOM in a variable keyed like `panelFor`'s `fileKey` (`viewer-app.js:1741`), with the zoom as a **percentage** and the scroll as the fraction of the scrollable range. On the Artifacts screen, the same keyed by artifact uuid + file path.
  - If the new version's picture has a different natural size, the percentage is kept (clamped to the new range) and the scroll fractions are reapplied; if the reader was at Fit, it stays at Fit.
- **Tab trap:** the popup's Tab trap selects `a[href], button` (around `viewer-app.js:785`); add `[tabindex="0"]` so the focusable picture area is in the cycle.

## Gallery items

`openGallery` today takes web-image items: `{ href, title, source, page }` (`viewer-app.js:331`, `:1242`), and its footer shows the site (`siteOf`), an "Open page" link (`httpsPage`), and "This image is not in this export." for a missing image (`viewer-app.js:552-567`). **Keep that shape** and add two optional fields: `label` (the dialog's label, default "Image preview") and `caption` (shown in the footer instead of site and link when set). An inline diagram is `{ href: <its data URL>, title: <title>, caption: <title>, label: 'Diagram' }`. A diagram opens a **one-item** gallery: with one item, previous/next buttons and the position counter are hidden and Left/Right do nothing. Existing gallery e2e checks (webimages, cards, steps) keep their expectations.

## Page mode

- **The bar:** above or below the preview, in the panel head or preview frame's edge: −, the percentage, +, Fit width, 100%. Same steps as pictures, range 25% to 200%.
- **Start and reset:** 100%, as pages look today. Pages never wait for a measurement to show.
- **How it scales:** the zoom is applied from outside the frame. The iframe gets a layout size of (container size ÷ zoom) and `transform: scale(zoom)` with `transform-origin: 0 0`, inside a wrapper that clips to the container. The page's own code is unchanged and it scrolls inside its own frame as today; the only addition to its document is the measuring script below.
- **Fit width:** only for pages laid out wider than their frame. Most pages are fluid and fit already; for them Fit width is 100% and the button is disabled. The parent can't read a sandboxed frame's width, so the preview document the viewer builds (`previewDoc`, `artifactPreviewDoc`) gets a tiny measuring script, appended after the page's content, that posts `{ type: 'ct-size', width: document.documentElement.scrollWidth, view: document.documentElement.clientWidth }` to `window.top` on load and on resize. Each report carries its own layout width (`view`), so there is no race with the parent's layout. Rule: if `width ≤ view + 1`, Fit is 100%; otherwise Fit = container width ÷ `width`, clamped to 25%–100%. Fit width never zooms in above 100%. Until a report arrives (or never, if the page's scripts fail), the button is disabled. The viewer accepts the message only when `event.source` is that preview's window (standalone: `frame.contentWindow`; hosted: `guardFrame.contentWindow.frames[0]`, readable across origins) and both numbers are finite and positive. A page could send a false width; the worst it can do is pick a zoom within 25%–200% for itself.
  - **Hosted mode:** the page posts straight to `window.top`, past the guard frame, so `guardDoc` stays unchanged and Fit width works hosted too.
- **Keys:** the same `+ - 0 1` keys while the bar has focus. Keys pressed inside the page go to the page.
- **No drag, no wheel zoom** over the page: its events are its own (and a sandboxed frame's events don't reach the viewer anyway). A pinch over a page or a board therefore triggers Chrome's own page zoom; `USAGE.md` says so and points at the bar.
- **Reset:** back to 100% for another file; kept across versions of the same file.

## Canvas mode (Design)

- **Today:** `canvasScale` fits the canvas width to the page, never enlarging (0.1–1); the page scrolls natively; a `ResizeObserver` rescales on window changes; boards load lazily through an `IntersectionObserver` rooted at `#page-body`.
- **New:** a zoom bar (−, percentage, +, Fit) at the canvas's top edge. Range: **Fit** (never below it, so zooming out never brings more boards into view than today's fit and the lazy loader isn't swamped) up to 200%. Same steps above Fit.
- **Wheel:** pinch and Ctrl/⌘ + wheel zoom about the pointer when the pointer is over the canvas background or a board's head or a note; plain wheel scrolls as today. Over a board's frame the events belong to the board. The canvas is centred with `margin: 0 auto` (`artifacts.css:163`); the zoom-about-a-point math takes that offset into account.
- **Back from Open alone:** `openCanvas(v, b.name)` (`artifacts-app.js:977`) rebuilds the canvas at Fit today. Keep the zoom and centre point per canvas (in memory, keyed by artifact uuid + version) and restore them on Back.
- **Drag:** press-and-drag on the empty canvas background, a board head or a note pans (by scrolling `#page-body`); cursor `grab` there. Dragging never starts on a board's frame. A board head's existing click (Open alone) still works after a press that didn't move more than 4 px.
- **Resize:** while the reader is at Fit, a window resize refits (today's behaviour). After they chose a zoom, a resize keeps their zoom and the point at the centre.
- **Lazy boards:** keep the `IntersectionObserver` and `CANVAS_MARGIN`; boards come and go as panning scrolls them in and out of view.
- **Hosted:** works the same inside the shadow root (use `composedPath()` where the code already does).

## Constraints

Existing checks keep passing, except those that pin a behaviour this design changes on purpose; those are updated, not deleted:
- `tests/e2e/artifacts-viewer.e2e.js` "svg: shown in the sandboxed frame" becomes "svg: shown as a picture" (with a separate check that a scripted SVG stays sandboxed).
- `tests/e2e/combined.e2e.js:366-372` reads the hosted `chart.svg` through `iframe[srcdoc]`; it now reads the `<img>`'s data URL.
- `tests/viewer.test.js:758-768` pins `previewDoc`'s exact `srcdoc`, and `:1729` / `:1806` pin `artifactPreviewDoc`'s output; they gain the measuring script.

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
  - SVG file: shown as `<img>`; a scripted SVG stays an iframe with the page bar; an SVG with no `xmlns` (or an `&nbsp;`) falls back to the iframe; natural size from `width="100%"` or units falls back to `viewBox`;
  - inline diagram: Enter on it opens the one-item gallery; the ⋯ menu doesn't;
  - HTML page: + and − change the frame's scale; Fit width uses the page's reported width, standalone and hosted; a message from another window is ignored;
  - canvas: bar zooms past 100% and not below Fit; drag on the background pans; drag doesn't start on a board frame; a board head click still opens the board, a drag ending on it doesn't; Back from Open alone restores the zoom; standalone and hosted;
  - no network requests and no page errors, as the other e2e files check.

## Release

v1.23.0: README changelog entry and `manifest.json` 1.23.0; `TECHNICAL.md` viewer section; `USAGE.md` (how to zoom, the keys); `CLAUDE.md` file map row for `zoom.e2e.js`.

## Calls I made (the owner skipped questions)

- Inline diagrams zoom in the gallery, not in place in the chat, so the chat keeps scrolling normally.
- Plain wheel zooms only in the gallery; elsewhere it needs pinch or Ctrl/⌘.
- SVG files become pictures (`<img>`, which also runs no scripts); a scripted SVG stays a page.
- Ranges: pictures up to 800%, pages 25–200%, canvas up to 200%.
- Zoom is kept when switching versions of the same file, reset for another file, never stored.
- Fit width uses a measuring script posting the page's width and its own layout width to `window.top`, which also works hosted without touching the guard frame.
- Pages start at 100%; Fit width is only for pages wider than their frame and never enlarges.
- SVGs become pictures as-is; only a scripted one stays a page, and one the strict XML parser rejects falls back to the page.
- The gallery keeps its item shape and gains optional `label` and `caption`; a diagram is a one-item gallery with no previous/next.
- The canvas never zooms out below Fit; its zoom survives Open alone and Back.

## Left to the builder

- Exact bar placement and styling within the existing look.
- Pointer-event details (pointer capture, touch-action values), how the 4 px threshold is measured.
- How the shared helper is split between `viewer-logic.js` (pure) and each app (DOM wiring), as long as both apps use the same pure helpers.

## Review

A fresh reviewer read this spec against the code on 2026-11-25 (2 critical, 6 important, 5 minor findings). All are folded in above: the SVG rule (every SVG has an `http://` namespace, so the old "refers outside" rule matched all of them), the strict-XML fallback, the `SAFE_IMAGE_URI` reversal, the extra tests that change, the `window.top` relay, the `view` width in reports, the gallery shape, flex centring, where zoom state lives, the canvas floor and Back, browser pinch over frames, the diagram button and Tab trap, and the missing tests.
