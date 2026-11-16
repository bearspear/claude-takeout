// The artifacts viewer page (viewer.html of an Export Artifacts export). Reads the inline data,
// { exported, listed, artifacts: ArtifactView[] } (see artifactView in popup.js), and shows the home page:
// a grid of cards like claude.ai/artifacts, with tabs (All / Yours / Shared with you) and a title search.
// Every text from the data goes in through textContent or attributes, never as markup.
// Clicking a card sets #a=<id>, which opens that artifact's page: a top bar (home, title, kind, badges, Open file,
// Open on claude.ai) above the artifact. What fills it (pageFor): a Docs page, a poster for Design and other typed
// artifacts, the preview (openPreview) for an HTML, SVG, Markdown or image start file, else a details page.
// Any other hash, or an id not in the data, shows the grid.
(function () {
  'use strict';

  function readData() {
    try {
      const data = JSON.parse(document.getElementById('data').textContent);
      return data && Array.isArray(data.artifacts) ? data : { artifacts: [] };
    } catch (e) {
      return { artifacts: [] };
    }
  }

  const data = readData();
  const views = data.artifacts.filter(v => v && typeof v === 'object');
  // Relative times count from when the page was opened, as claude.ai's do.
  const now = Date.now();

  const SVG_NS = 'http://www.w3.org/2000/svg';
  // Static icons, built from these constant shapes only.
  const ICONS = {
    // A page with lines: Docs.
    docs: [['path', { d: 'M7 3.5h7.5L19 8v12.5H7z' }], ['path', { d: 'M14.5 3.5V8H19' }], ['path', { d: 'M10 12h6M10 15h6M10 18h4' }]],
    // A pen nib over a square: Design.
    design: [['rect', { x: 4, y: 4, width: 16, height: 16, rx: 3 }], ['path', { d: 'M8.5 15.5 14 10l1.5 1.5-5.5 5.5H8.5z' }], ['path', { d: 'M15 9l1-1 1 1-1 1' }]],
    // A browser window: any other page.
    page: [['rect', { x: 3.5, y: 5, width: 17, height: 14, rx: 2 }], ['path', { d: 'M3.5 9h17' }], ['path', { d: 'M6.5 7h.01M8.5 7h.01' }]],
    house: [['path', { d: 'M2.5 7.2 8 2.5l5.5 4.7V13a.5.5 0 0 1-.5.5H10V10H6v3.5H3a.5.5 0 0 1-.5-.5z' }]],
    globe: [['circle', { cx: 8, cy: 8, r: 6.25 }], ['path', { d: 'M1.75 8h12.5M8 1.75c1.7 1.8 2.5 3.9 2.5 6.25S9.7 12.45 8 14.25C6.3 12.45 5.5 10.35 5.5 8S6.3 3.55 8 1.75z' }]],
  };

  function icon(name, size, cls) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', size > 16 ? '1.4' : '1.2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    if (cls) svg.setAttribute('class', cls);
    for (const [tag, attrs] of ICONS[name]) {
      const shape = document.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(attrs)) shape.setAttribute(k, String(v));
      svg.append(shape);
    }
    return svg;
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function tileKind(v) {
    if (v.docs) return 'docs';
    if (v.typed && String(v.kind).toLowerCase() === 'design') return 'design';
    return 'page';
  }

  function tile(v) {
    const kind = tileKind(v);
    const node = el('span', `tile ${kind}`);
    node.append(icon(kind, 24));
    return node;
  }

  // Only a picture the export saved, at viewer-files/thumbs/<id>.<ext>, relative to this page.
  const THUMB_PATH = /^viewer-files\/thumbs\/[A-Za-z0-9-]{1,64}\.(?:png|jpg|webp)$/;

  // false once viewer-check.gif fails to load: the page was opened from inside a ZIP, so no file beside it loads.
  let unzipped = null;

  function picture(v, cls = 'pic') {
    const box = el('span', cls);
    if (unzipped !== false && typeof v.thumb === 'string' && THUMB_PATH.test(v.thumb)) {
      const img = document.createElement('img');
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.addEventListener('error', () => img.replaceWith(tile(v)), { once: true });
      img.src = v.thumb;
      box.append(img);
    } else {
      box.append(tile(v));
    }
    return box;
  }

  function absoluteTime(iso) {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return '';
    return new Date(t).toLocaleString(undefined, { year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  function card(v) {
    const button = el('button', 'card');
    button.type = 'button';
    button.dataset.id = String(v.id);
    const title = String(v.title || 'Untitled');
    const when = relativeTime(v.updatedAt, now);
    button.setAttribute('aria-label', `${title}, ${v.kind || 'Page'}${when ? `, ${when}` : ''}${v.public ? ', public' : ''}`);
    const info = el('span', 'info');
    const name = el('span', 'title', title);
    name.title = title;
    const sub = el('span', 'sub');
    const time = el('time', '', when);
    const abs = absoluteTime(v.updatedAt);
    if (abs) { time.title = abs; time.dateTime = new Date(Date.parse(v.updatedAt)).toISOString(); }
    sub.append(time, el('span', 'dot', '·'), el('span', 'kind', String(v.kind || 'Page')));
    if (v.public === true) {
      const globe = icon('globe', 16, 'globe');
      globe.removeAttribute('aria-hidden');
      globe.setAttribute('role', 'img');
      const label = document.createElementNS(SVG_NS, 'title');
      label.textContent = 'Public';
      globe.prepend(label);
      sub.append(globe);
    }
    info.append(name, sub);
    button.append(picture(v), info);
    button.addEventListener('click', () => { location.hash = '#a=' + v.id; });
    return button;
  }

  // Cards are built once and reused, so a picture loads (or falls back) only once.
  const cards = new Map(views.map(v => [v, card(v)]));

  const grid = document.getElementById('grid');
  const empty = document.getElementById('empty');
  const search = document.getElementById('search');
  const tabs = [...document.querySelectorAll('[role=tab]')];
  let tab = 'all';

  const EMPTY_TAB = { all: 'No artifacts', yours: 'Nothing of yours here', shared: 'Nothing shared with you' };

  function render() {
    const query = search.value;
    const shown = artifactTabs(views, tab, query);
    grid.replaceChildren(...shown.map(v => cards.get(v)));
    empty.hidden = shown.length > 0;
    empty.textContent = shown.length ? '' : query.trim() ? 'No artifacts match' : EMPTY_TAB[tab];
    for (const t of tabs) {
      const on = t.dataset.tab === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
    }
  }

  function selectTab(name, focus) {
    tab = name;
    render();
    if (focus) tabs.find(t => t.dataset.tab === name).focus();
  }

  for (const t of tabs) {
    t.addEventListener('click', () => selectTab(t.dataset.tab, false));
    t.addEventListener('keydown', e => {
      const at = tabs.indexOf(t);
      let to = null;
      if (e.key === 'ArrowRight') to = (at + 1) % tabs.length;
      else if (e.key === 'ArrowLeft') to = (at - 1 + tabs.length) % tabs.length;
      else if (e.key === 'Home') to = 0;
      else if (e.key === 'End') to = tabs.length - 1;
      if (to === null) return;
      e.preventDefault();
      selectTab(tabs[to].dataset.tab, true);
    });
  }

  search.addEventListener('input', render);
  search.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (search.value) { search.value = ''; render(); } else search.blur();
  });

  // / anywhere outside a text field puts the cursor in the search box (on the grid only).
  document.addEventListener('keydown', e => {
    if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || home.hidden) return;
    const t = e.target;
    if (t && t.closest && t.closest('input, textarea, select, [contenteditable]')) return;
    e.preventDefault();
    search.focus();
    search.select();
  });

  // ---- The artifact page ----
  const home = document.getElementById('home');
  const page = document.getElementById('page');
  const pageTitle = document.getElementById('page-title');
  const pageKind = document.getElementById('page-kind');
  const pageBadges = document.getElementById('page-badges');
  const pageLinks = document.getElementById('page-links');
  const pageBody = document.getElementById('page-body');
  const homeTitle = document.title;
  // The first view with an id wins; ids are claude.ai's short ids, so they don't repeat.
  const byId = new Map();
  for (const v of views) if (typeof v.id === 'string' && !byId.has(v.id)) byId.set(v.id, v);

  const PREVIEW_KINDS = new Set(['html', 'svg', 'md', 'image']);
  const UNZIP_TEXT = 'Unzip the export first, then open viewer.html again.';

  // A saved file's link, relative to viewer.html: <folder>/<savedAs>, each segment percent-encoded; null for an
  // empty path or one with . or .. segments (as takeout-viewer.js's relHref).
  function relHref(...parts) {
    const segs = [];
    for (const part of parts) {
      if (typeof part !== 'string') return null;
      for (const s of part.split('/')) {
        if (s === '') continue;
        if (s === '.' || s === '..') return null;
        segs.push(encodeURIComponent(s));
      }
    }
    return segs.length ? segs.join('/') : null;
  }

  // Open file: any saved file of the owner's own artifacts; of any other, only what openableHref allows (never
  // HTML or SVG, which would run someone else's code from disk, unsandboxed). None inside a ZIP, where it can't open.
  function openHref(v, savedAs) {
    if (unzipped === false) return null;
    const href = relHref(v.folder, savedAs);
    if (!href) return null;
    return v.shared === false || openableHref(href) ? href : null;
  }

  const claudeUrl = v => `https://claude.ai/artifact/${encodeURIComponent(v.id)}`;

  function link(cls, text, href, external) {
    const a = el('a', cls, text);
    a.setAttribute('href', href);
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', external ? 'noopener noreferrer' : 'noopener');
    return a;
  }

  const isPoster = v => v.typed === true && !v.docs;
  const files = v => (Array.isArray(v.files) ? v.files.filter(f => f && typeof f.path === 'string') : []);
  const unverified = v => files(v).some(f => f.verified === false);

  function fileList(v) {
    const list = files(v);
    const frag = document.createDocumentFragment();
    if (!list.length) return frag;
    frag.append(el('p', 'files-head', list.length === 1 ? 'Saved file' : `Saved files (${list.length})`));
    const ul = el('ul', 'files');
    for (const f of list) {
      const li = el('li');
      li.append(el('span', 'path', f.path));
      if (f.verified === false) li.append(el('span', 'unchecked', 'not checked'));
      const href = openHref(v, f.savedAs);
      if (href) li.append(link('open-file', 'Open file', href, false));
      ul.append(li);
    }
    frag.append(ul);
    return frag;
  }

  function notes(v, sheet) {
    if (v.missingCount > 0) sheet.append(el('p', 'note', `${v.missingCount === 1 ? '1 file' : `${v.missingCount} files`} listed by claude.ai ${v.missingCount === 1 ? 'was' : 'were'} not saved (see errors.txt).`));
    if (v.note && !v.docs) sheet.append(el('p', 'note', String(v.note)));
  }

  function actions(v, ...extra) {
    const row = el('p', 'actions');
    row.append(...extra, link('btn', 'Open on claude.ai', claudeUrl(v), true));
    return row;
  }

  function sheet(cls, heading, ...leads) {
    const box = el('div', `sheet ${cls}`);
    if (unzipped === false) box.append(el('p', 'unzip', UNZIP_TEXT));
    box.append(el('h2', '', heading));
    for (const text of leads) if (text) box.append(el('p', 'lead', text));
    return box;
  }

  function docsPage(v) {
    const box = sheet('docs-page', 'Claude Docs document', v.note || "Claude Docs text isn't available as a file; export the chat that made it to get the document.");
    box.insertBefore(picture(v, 'big-pic'), box.querySelector('h2'));
    box.append(actions(v));
    return box;
  }

  function posterPage(v) {
    const box = sheet('poster', `${v.kind || 'Typed'} artifact`, 'This artifact needs claude.ai to run; its saved files may not work on their own.');
    box.insertBefore(picture(v, 'big-pic'), box.querySelector('h2'));
    const extra = [];
    if (unzipped !== false && PREVIEW_KINDS.has(v.startKind) && !v.tooLarge && !v.startMissing && !v.notExported) {
      const show = el('button', 'btn', 'Show saved files anyway');
      show.type = 'button';
      show.addEventListener('click', () => openPreview(v));
      extra.push(show);
    }
    box.append(actions(v, ...extra), fileList(v));
    notes(v, box);
    return box;
  }

  // Why there is nothing to show, for the details page.
  function detailsWhy(v) {
    if (v.notExported) return ['Not exported.', 'errors.txt says why. It can still be opened on claude.ai.'];
    if (!v.start) return files(v).length ? ['No start file to show.'] : ['No files were saved for this artifact.', 'It can be opened on claude.ai.'];
    if (PREVIEW_KINDS.has(v.startKind) && v.tooLarge) return [`${v.start} is too large to show here.`];
    if (PREVIEW_KINDS.has(v.startKind) && v.startMissing) return [`${v.start} isn't in the viewer's files, so it can't be shown here.`];
    if (unzipped === false) return [`${v.start} can't be shown from inside a ZIP.`];
    if (v.startKind === 'react' || v.startKind === 'mermaid') return [`${v.start} is source code that needs claude.ai to run.`];
    return [`${v.start} can't be shown here.`];
  }

  function detailsPage(v) {
    const [heading, lead] = detailsWhy(v);
    const box = sheet('details', heading, lead);
    const extra = [];
    if (v.notExported) extra.push(link('btn', 'Open errors.txt', 'errors.txt', false));
    box.append(actions(v, ...extra), fileList(v));
    notes(v, box);
    return box;
  }

  // ---- Parts: an artifact's texts and images, in viewer-files/part-NNNN.js, which call window.__archivePart ----
  // (as the chat viewer's). Page code can't read files, so a part arrives as a script, and only a number from the
  // data ever becomes its src.
  const partsListed = new Set();
  for (const v of views) if (Number.isSafeInteger(v.part) && v.part > 0) partsListed.add(v.part);
  const partsLoaded = new Map(); // n -> Promise<object|null>, the most recently used last
  const PARTS_KEPT = 2; // a part is about 4 MB; older ones are dropped and load again if needed
  const partsWaiting = new Map(); // n -> resolve, only while its script is loading
  if (partsListed.size) {
    Object.defineProperty(window, '__archivePart', {
      value(n, part) {
        const done = partsWaiting.get(n);
        if (!done || part === null || typeof part !== 'object') return;
        partsWaiting.delete(n);
        done(part);
      },
    });
  }

  function loadPart(n) {
    if (!partsListed.has(n)) return Promise.resolve(null);
    if (partsLoaded.has(n)) {
      const cached = partsLoaded.get(n);
      partsLoaded.delete(n);
      partsLoaded.set(n, cached);
      return cached;
    }
    const loading = new Promise(resolve => {
      partsWaiting.set(n, resolve);
      const script = document.createElement('script');
      const finish = () => {
        script.remove();
        const done = partsWaiting.get(n);
        if (!done) return; // the part called in, and this was its load event
        partsWaiting.delete(n);
        partsLoaded.delete(n); // so opening the artifact later tries again
        done(null);
      };
      script.addEventListener('load', finish);
      script.addEventListener('error', finish);
      script.src = `viewer-files/part-${String(n).padStart(4, '0')}.js`;
      document.head.append(script);
    });
    partsLoaded.set(n, loading);
    while (partsLoaded.size > PARTS_KEPT) partsLoaded.delete(partsLoaded.keys().next().value);
    return loading;
  }

  // The artifact's payload { texts: [[path, text]], images: [[path, dataUri]] }, or null when its part can't load.
  const PAYLOAD_KEY = /^a(0|[1-9]\d*)$/;
  async function payloadOf(v) {
    if (!partsListed.has(v.part) || typeof v.key !== 'string' || !PAYLOAD_KEY.test(v.key)) return null;
    const part = await loadPart(v.part);
    if (!part || !Object.prototype.hasOwnProperty.call(part, v.key)) return null;
    const payload = part[v.key];
    return payload && typeof payload === 'object' ? payload : null;
  }

  // Looked up by string path only, so a path like __proto__ is just data.
  function pathMap(pairs, ok) {
    const map = new Map();
    if (Array.isArray(pairs)) for (const p of pairs) if (Array.isArray(p) && typeof p[0] === 'string' && ok(p[1])) map.set(p[0], p[1]);
    return map;
  }
  const SAFE_IMAGE_URI = /^data:image\/(?!svg)[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]*$/i;

  // ---- The preview ----
  const pageNote = document.getElementById('page-note');
  const PART_FAILED = "The artifact couldn't load, because viewer-files/ is missing or blocked.";
  let mdParser = null;

  function markdownPage(text) {
    if ((text.match(/[*_]/g) || []).length > EMPHASIS_LIMIT) {
      const plain = el('div', 'prose plain');
      plain.append(el('p', 'plain-note', "This file was too complex to format, so it's shown as plain text."), document.createTextNode(text));
      return plain;
    }
    if (!mdParser) mdParser = markdownParser(marked);
    const mark = placeholderMark(text);
    const safe = protectMath(text, mark);
    const box = el('div', 'prose');
    box.innerHTML = sanitizeHtml(mdParser.parse(safe.text), new DOMParser());
    // No KaTeX here: math shows as its source.
    fillPlaceholders(box, { mark, math: safe.math, sources: [], render: (src, display) => `<code class="math">${escHtml(display ? `$$${src}$$` : `$${src}$`)}</code>` });
    for (const a of box.querySelectorAll('a[href]')) {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    }
    return box;
  }

  function codePage(text) {
    const box = el('div', 'code-page');
    const pre = el('pre');
    pre.append(el('code', '', text));
    box.append(el('p', 'note', OFFLINE_NOTE), pre);
    return box;
  }

  // The order matters: sandbox goes on before the document does, and the frame only then joins the page.
  // Never allow-same-origin, allow-popups or allow-top-navigation; the page's frame-src 'none' keeps the frame from
  // navigating anywhere.
  function previewFrame(v, srcdoc) {
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals');
    frame.setAttribute('title', String(v.title || 'Artifact'));
    frame.setAttribute('srcdoc', srcdoc);
    return frame;
  }

  function failedPage(v) {
    const box = sheet('details', PART_FAILED);
    box.append(actions(v), fileList(v));
    return box;
  }

  function fillPreview(v, box, payload) {
    const texts = pathMap(payload && payload.texts, t => typeof t === 'string');
    const images = pathMap(payload && payload.images, u => typeof u === 'string' && SAFE_IMAGE_URI.test(u));
    const text = texts.has(v.start) ? texts.get(v.start) : null;
    if (v.startKind === 'html' || v.startKind === 'svg') {
      if (text === null) return box.replaceChildren(failedPage(v));
      const doc = artifactPreviewDoc(text, v.start, payload);
      if (doc.remote) { pageNote.textContent = REMOTE_NOTE; pageNote.hidden = false; }
      return box.replaceChildren(previewFrame(v, doc.srcdoc));
    }
    if (v.startKind === 'md') return box.replaceChildren(text === null ? failedPage(v) : markdownPage(text));
    if (CODE_KINDS.has(v.startKind)) return box.replaceChildren(text === null ? detailsPage(v) : codePage(text));
    if (v.startKind === 'image') {
      // The owner's own image can also come from its saved file.
      const src = images.has(v.start) ? images.get(v.start) : v.shared === false ? openHref(v, v.startSaved) : null;
      if (!src) return box.replaceChildren(failedPage(v));
      const frame = el('div', 'image');
      const img = document.createElement('img');
      img.alt = String(v.title || '');
      img.src = src;
      frame.append(img);
      return box.replaceChildren(frame);
    }
    box.replaceChildren(detailsPage(v));
  }

  // The start file, shown in place: an HTML or SVG page in a sandboxed frame, Markdown rendered as the chat viewer
  // does, an image, or React and Mermaid source as code. Its texts and images come from its part, loaded now.
  function openPreview(v) {
    const box = el('div', 'preview');
    box.dataset.id = String(v.id);
    box.append(el('p', 'loading', 'Loading…'));
    pageBody.replaceChildren(box);
    pageNote.hidden = true;
    payloadOf(v).then(payload => {
      // Another page, or the same one rebuilt, took its place meanwhile.
      if (box.isConnected) fillPreview(v, box, payload);
    });
  }

  const CODE_KINDS = new Set(['react', 'mermaid']);

  function fillBody(v) {
    if (v.docs) return pageBody.replaceChildren(docsPage(v));
    if (isPoster(v)) return pageBody.replaceChildren(posterPage(v));
    const shown = !v.notExported && v.start && !v.tooLarge && unzipped !== false;
    if (shown && PREVIEW_KINDS.has(v.startKind) && !v.startMissing) return openPreview(v);
    if (shown && CODE_KINDS.has(v.startKind) && partsListed.has(v.part)) return openPreview(v);
    pageBody.replaceChildren(detailsPage(v));
  }

  function badge(text) { return el('span', 'badge', text); }

  function showPage(v) {
    const title = String(v.title || 'Untitled');
    pageTitle.textContent = title;
    pageTitle.title = title;
    pageKind.textContent = String(v.kind || 'Page');
    document.title = `${title} - Artifacts`;
    const badges = [];
    if (v.needsRuntime || isPoster(v)) badges.push(badge('needs claude.ai to run'));
    if (unverified(v)) badges.push(badge("not checked against claude.ai's checksum"));
    pageBadges.replaceChildren(...badges);
    pageNote.hidden = true;
    pageNote.textContent = '';
    const links = [];
    const startHref = v.notExported ? null : openHref(v, v.startSaved);
    if (startHref) links.push(link('btn open-file', 'Open file', startHref, false));
    links.push(link('btn open-claude', 'Open on claude.ai', claudeUrl(v), true));
    pageLinks.replaceChildren(...links);
    fillBody(v);
    pageBody.scrollTop = 0;
  }

  let openId = null;
  let homeScroll = 0;

  function route() {
    const id = parseArtifactHash(location.hash);
    const v = id != null && byId.has(id) ? byId.get(id) : null;
    if (v) {
      if (openId === null) homeScroll = window.scrollY;
      const changed = openId !== id;
      openId = id;
      home.hidden = true;
      page.hidden = false;
      showPage(v);
      if (changed) pageTitle.focus({ preventScroll: true });
      return;
    }
    const was = openId;
    openId = null;
    page.hidden = true;
    home.hidden = false;
    pageBody.replaceChildren();
    pageNote.hidden = true;
    document.title = homeTitle;
    if (location.hash && location.hash !== '#') {
      try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* the hash just stays */ }
    }
    if (was !== null) {
      window.scrollTo(0, homeScroll);
      const back = [...grid.children].find(c => c.dataset.id === was);
      if (back) back.focus({ preventScroll: true });
    }
  }

  // Back to the grid at once; the hashchange that follows finds it already shown.
  document.getElementById('home-button').addEventListener('click', () => {
    if (location.hash) location.hash = '';
    route();
  });
  window.addEventListener('hashchange', route);

  // A browser can open viewer.html from inside a ZIP, but not the files beside it (the chat viewer does the same).
  // The name matches VIEWER_CHECK_FILE in takeout-viewer.js.
  function checkUnzipped() {
    const probe = new Image();
    probe.onload = () => { unzipped = true; };
    probe.onerror = () => {
      unzipped = false;
      for (const [v, c] of cards) {
        const img = c.querySelector('.pic img');
        if (img) img.replaceWith(tile(v));
      }
      if (openId !== null && byId.has(openId)) showPage(byId.get(openId));
    };
    probe.src = 'viewer-check.gif';
  }

  checkUnzipped();
  render();
  route();
})();
