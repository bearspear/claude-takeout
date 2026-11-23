// The artifacts app: the viewer.html of an Export Artifacts export, and the Artifacts screen of the chat viewer.
// window.CTArtifactsApp.mount(container, options) builds it in container and returns { route(hash), show(), refocus() }.
//   Standalone (no options): container is document.body. The data is the page's inline #data,
//     { exported, listed, artifacts: ArtifactView[] } (see artifactView in popup.js); parts load through this
//     app's own window.__archivePart; the app follows the hash itself.
//   Hosted (options { data, loadPart, onOpenChat }, the chat viewer): the app lives in container's shadow root,
//     styled by the CSS in <template id="artifacts-style">; data is the chat viewer's ViewerData, with artifacts;
//     loadPart(n) -> Promise<object|null> is the host's part loader (one __archivePart on the page);
//     onOpenChat(chatIndex, messageUuid) opens a chat. The host calls route(hash) on each hash change: it returns
//     whether the hash is the Artifacts screen's (#artifacts, #a=<id>, #ac=<chat>.<file>), and on any other hash it lets
//     go of an open artifact. show() shows the grid without touching the hash.
// The home page: a grid of cards like claude.ai/artifacts, with tabs (All / Yours / Shared with you) and a title search.
// Hosted, a fourth tab, In chats, has a card per file Claude made in the chats (inChatsFiles), kind filters and a
// search on file names; a card sets #ac=<chat index>.<file id>, which opens the file's page: "Made in" its chat
// (onOpenChat), a version menu, and the file as an artifact's would show (an HTML or SVG file in the same guarded
// sandbox, with only its own chat's scripts and stylesheets), Markdown, code, an image, or details.
// Hosted, the screen also links artifacts and chats: an All card's source line (its linked chats, else Shared with you,
// Cowork or Code) and "also in chat"; on an artifact's page a line of Made in / Published in / Edited in chats (each
// opening that chat at its message) and a menu of every version the export saved (view.versions); a Docs
// artifact a chat rebuilt shows that chat's text; an Export Changes run says what it holds under the heading.
// All / Yours / Shared show only artifacts in claude.ai's list; when the list isn't in the export (data.listFetched
// false), they say so instead.
// Every text from the data goes in through textContent or attributes, never as markup.
// Clicking a card sets #a=<id>, which opens that artifact's page: a top bar (home, title, kind, badges, Open file,
// Open on claude.ai) above the artifact. What fills it (pageFor): a Docs page, a poster for Design and other typed
// artifacts, the preview (openPreview) for an HTML, SVG, Markdown or image start file, else a details page.
// Any other hash, or an id not in the data, shows the grid.
(function () {
  'use strict';

  // The home page and the artifact page: constant markup, no data in it.
  // Hosted, the grid has a fourth tab (In chats) with its kind filters, and a page a line under its top bar.
  const shell = (homeTag, hosted) => `<${homeTag} id="home">
  <h1>Artifacts</h1>${hosted ? `
  <p id="since" hidden></p>` : ''}
  <div class="bar">
    <div role="tablist" aria-label="Which artifacts">
      <button type="button" role="tab" id="tab-all" data-tab="all" aria-controls="grid">All</button>
      <button type="button" role="tab" id="tab-yours" data-tab="yours" aria-controls="grid">Yours</button>
      <button type="button" role="tab" id="tab-shared" data-tab="shared" aria-controls="grid">Shared with you</button>${hosted ? `
      <button type="button" role="tab" id="tab-chats" data-tab="chats" aria-controls="grid">In chats <span class="count"></span></button>` : ''}
    </div>
    <label class="search"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="7" cy="7" r="4.75"/><path d="m10.5 10.5 3.5 3.5" stroke-linecap="round"/></svg><input type="search" id="search" placeholder="Search artifacts" aria-label="Search artifacts" autocomplete="off" spellcheck="false"></label>
  </div>${hosted ? `
  <div id="kinds" role="group" aria-label="Kinds of file" hidden></div>` : ''}
  <div id="grid" role="tabpanel" aria-label="Artifacts"></div>
  <p id="empty" role="status" hidden></p>
</${homeTag}>
<section id="page" hidden aria-labelledby="page-title">
  <header class="topbar">
    <button type="button" class="icon-btn" id="home-button" aria-label="All artifacts" title="All artifacts"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 7.2 8 2.5l5.5 4.7V13a.5.5 0 0 1-.5.5H10V10H6v3.5H3a.5.5 0 0 1-.5-.5z"/></svg></button>
    <h1 id="page-title" tabindex="-1"></h1>
    <span id="page-kind"></span>
    <span class="spacer"></span>
    <span id="page-badges"></span>
    <span id="page-links"></span>
  </header>${hosted ? `
  <div id="page-from" hidden></div>` : ''}
  <p id="page-note" role="note" hidden></p>
  <div id="page-body"></div>
</section>
`;

  // Hosted only: the screen scrolls itself, and an open artifact fills it rather than the window.
  const HOSTED_CSS = `
:host { display: block; background: var(--bg); color: var(--ink); font: 14px/1.5 var(--sans); -webkit-font-smoothing: antialiased; }
#page { height: 100%; }
`;

  // A hosted preview sits in a guard frame whose own policy is frame-src 'none': the preview's navigations are
  // checked against its parent's policy, and the chat viewer's page allows file: frames (for PDFs). Both frames
  // carry the same sandbox; the guard runs nothing.
  const GUARD_STYLE = 'html,body{margin:0;height:100%;overflow:hidden}iframe{display:block;border:0;width:100%;height:100%;background:#fff;color-scheme:normal}';
  const attr = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  const guardDoc = (title, srcdoc) => `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="frame-src 'none'"><style>${GUARD_STYLE}</style></head>`
    + `<body><iframe sandbox="allow-scripts allow-forms allow-modals" title="${attr(title)}" srcdoc="${attr(srcdoc)}"></iframe></body></html>`;

  function readData() {
    try {
      const data = JSON.parse(document.getElementById('data').textContent);
      return data && Array.isArray(data.artifacts) ? data : { artifacts: [] };
    } catch (e) {
      return { artifacts: [] };
    }
  }

  function mount(container, options) {
    const hosted = !!(options && options.data);
    const data = hosted ? (Array.isArray(options.data.artifacts) ? options.data : { artifacts: [] }) : readData();
    const views = data.artifacts.filter(v => v && typeof v === 'object');
    // Where the app's elements are: the page itself, or the screen's shadow root.
    let root = document;
    if (hosted) {
      root = container.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      const source = document.getElementById('artifacts-style');
      const css = source ? (source.content ? source.content.textContent : source.textContent) : '';
      style.textContent = css.replace(/:root\b/g, ':host') + HOSTED_CSS;
      root.append(style);
      root.append(document.createRange().createContextualFragment(shell('div', true)));
    } else {
      container.insertAdjacentHTML('afterbegin', shell('main', false));
    }
    const byIdIn = id => root.getElementById(id);
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
      // Hosted: where it comes from, and whether a chat has it as it now is.
      if (hosted) {
        const source = artifactSourceLine(v);
        const also = alsoIds.has(v.id);
        if (source || also) {
          const line = el('span', 'src-line');
          if (source) line.append(el('span', 'source', source));
          if (also) line.append(el('span', 'also', 'also in chat'));
          info.append(line);
        }
      }
      button.append(picture(v), info);
      button.addEventListener('click', () => { location.hash = '#a=' + v.id; });
      return button;
    }

    // The artifacts a chat has as they now are (hosted): their cards say "also in chat".
    const alsoIds = hosted ? alsoInChat(data) : new Set();
    // Cards are built once and reused, so a picture loads (or falls back) only once.
    const cards = new Map(views.map(v => [v, card(v)]));

    const grid = byIdIn('grid');
    const empty = byIdIn('empty');
    const search = byIdIn('search');
    const tabs = [...root.querySelectorAll('[role=tab]')];
    let tab = 'all';

    const EMPTY_TAB = { all: 'No artifacts', yours: 'Nothing of yours here', shared: 'Nothing shared with you' };
    const NO_LIST = "claude.ai's list isn't in this export";

    // ---- In chats (hosted only): one card per file Claude made in the export's chats (inChatsFiles) ----
    const chats = hosted && Array.isArray(data.chats) ? data.chats : [];
    const inChats = hosted ? inChatsFiles(data) : [];
    const inChatsByHash = new Map();
    for (const f of inChats) {
      const hash = formatInChatsHash(f.chat, f.file);
      if (hash) inChatsByHash.set(hash, f);
    }
    const KIND_NAMES = { page: 'Page', doc: 'Doc', diagram: 'Diagram', code: 'Code', other: 'Other' };
    const KIND_CHIPS = [['', 'All kinds'], ['page', 'Pages'], ['doc', 'Docs'], ['diagram', 'Diagrams'], ['code', 'Code'], ['other', 'Other']];
    const chatTitle = i => String((chats[i] && chats[i].title) || 'Untitled chat');
    let kindFilter = '';

    function fileCard(f, hash) {
      const button = el('button', 'card file-card');
      button.type = 'button';
      button.dataset.id = hash;
      const when = relativeTime(f.at, now);
      const count = f.versions.length;
      button.setAttribute('aria-label', `${f.name}, ${KIND_NAMES[f.kind]}${count > 1 ? `, ${count} versions` : ''}${when ? `, ${when}` : ''}, made in ${chatTitle(f.chat)}`);
      const pic = el('span', 'pic');
      const kindTile = el('span', `tile kind-${f.kind}`);
      kindTile.append(el('span', 'word', KIND_NAMES[f.kind]));
      pic.append(kindTile);
      if (count > 1) pic.append(el('span', 'versions', `${count} versions`));
      const info = el('span', 'info');
      const name = el('span', 'title', f.name);
      name.title = f.name;
      const sub = el('span', 'sub');
      const time = el('time', '', when);
      const abs = absoluteTime(f.at);
      if (abs) { time.title = abs; time.dateTime = new Date(Date.parse(f.at)).toISOString(); }
      sub.append(time, el('span', 'dot', '·'), el('span', 'kind', KIND_NAMES[f.kind]));
      const from = el('span', 'from');
      from.append(el('span', 'chat-icon', '💬'), el('span', 'chat-name', chatTitle(f.chat)));
      from.firstChild.setAttribute('aria-hidden', 'true');
      from.title = chatTitle(f.chat);
      info.append(name, sub, from);
      button.append(pic, info);
      button.addEventListener('click', () => { location.hash = hash; });
      return button;
    }

    // Built the first time they show.
    const fileCards = new Map(); // hash -> card
    const fileCardFor = (hash, f) => {
      if (!fileCards.has(hash)) fileCards.set(hash, fileCard(f, hash));
      return fileCards.get(hash);
    };

    const kinds = byIdIn('kinds');
    const chips = kinds ? KIND_CHIPS.map(([kind, label]) => {
      const chip = el('button', 'chip');
      chip.type = 'button';
      chip.dataset.kind = kind;
      chip.append(el('span', 'label', label));
      if (kind) chip.append(document.createTextNode(' '), el('span', 'n'));
      chip.addEventListener('click', () => { kindFilter = kind; render(); });
      kinds.append(chip);
      return chip;
    }) : [];
    const chatsCount = byIdIn('tab-chats');
    if (chatsCount) chatsCount.querySelector('.count').textContent = String(inChatsByHash.size);

    // The In chats grid: the search on file names, counted by kind, then the kind chosen.
    function renderChats(query) {
      const q = query.trim().toLowerCase();
      const matching = [...inChatsByHash].filter(([, f]) => !q || f.name.toLowerCase().includes(q));
      const counts = {};
      for (const [, f] of matching) counts[f.kind] = (counts[f.kind] || 0) + 1;
      for (const chip of chips) {
        const kind = chip.dataset.kind;
        if (kind) chip.querySelector('.n').textContent = String(counts[kind] || 0);
        chip.setAttribute('aria-pressed', String(kind === kindFilter));
      }
      const shown = matching.filter(([, f]) => !kindFilter || f.kind === kindFilter);
      grid.replaceChildren(...shown.map(([hash, f]) => fileCardFor(hash, f)));
      empty.hidden = shown.length > 0;
      empty.textContent = shown.length ? '' : q ? 'No files match' : kindFilter ? 'No files of this kind' : 'No files made in chats';
    }

    function render() {
      const query = search.value;
      if (kinds) kinds.hidden = tab !== 'chats';
      const searchLabel = tab === 'chats' ? 'Search files' : 'Search artifacts';
      search.placeholder = searchLabel;
      search.setAttribute('aria-label', searchLabel);
      if (tab === 'chats') renderChats(query);
      else {
        // claude.ai's list not in the export (hosted): no artifact can be told listed, so these tabs say so.
        const shown = data.listFetched === false ? [] : artifactTabs(views, tab, query);
        grid.replaceChildren(...shown.map(v => cards.get(v)));
        empty.hidden = shown.length > 0;
        empty.textContent = shown.length ? '' : data.listFetched === false ? NO_LIST : query.trim() ? 'No artifacts match' : EMPTY_TAB[tab];
      }
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

    // / anywhere outside a text field puts the cursor in the search box (on the grid only, and hosted, only while the
    // screen shows). The first node of the event's path: a field in the shadow root shows as its host to the document.
    document.addEventListener('keydown', e => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || home.hidden || (hosted && container.hidden)) return;
      const t = e.composedPath()[0];
      if (t && t.closest && t.closest('input, textarea, select, [contenteditable]')) return;
      e.preventDefault();
      search.focus();
      search.select();
    });

    // ---- The artifact page ----
    const home = byIdIn('home');
    const page = byIdIn('page');
    const pageTitle = byIdIn('page-title');
    const pageKind = byIdIn('page-kind');
    const pageBadges = byIdIn('page-badges');
    const pageLinks = byIdIn('page-links');
    const pageBody = byIdIn('page-body');
    const homeTitle = hosted ? 'Artifacts - Claude Takeout' : document.title;
    // The grid's hash: none standalone; hosted, the chat viewer's hashes need one of its own.
    const HOME_HASH = hosted ? '#artifacts' : '';
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
    // A view reused from a chat's files (Export All) has its paths from viewer.html already, not from its folder.
    // The owner's own artifact, whose HTML or SVG may open from disk: foreign false (shared false for a view with no
    // foreign; artifactView always sets it).
    const ownArtifact = v => (typeof v.foreign === 'boolean' ? v.foreign === false : v.shared === false);
    function openHref(v, savedAs) {
      if (unzipped === false) return null;
      const href = v.reused === true ? relHref(savedAs) : relHref(v.folder, savedAs);
      if (!href) return null;
      return ownArtifact(v) || openableHref(href) ? href : null;
    }

    const claudeUrl = v => `https://claude.ai/artifact/${encodeURIComponent(v.id)}`;

    function link(cls, text, href, external) {
      const a = el('a', cls, text);
      a.setAttribute('href', href);
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', external ? 'noopener noreferrer' : 'noopener');
      return a;
    }

    // Download: a file whose text or image this page holds, saved through a blob: link (saveBytes, viewer-logic.js).
    // Never a link to the file on disk, which Chrome would open, and never from inside a preview frame.
    function downloadButton(name, data) {
      const button = el('button', 'btn download', 'Download');
      button.type = 'button';
      button.setAttribute('aria-label', `Download ${name}`);
      button.addEventListener('click', () => saveBytes(name, data));
      return button;
    }
    // A path's bytes in a payload: its text, or its image's bytes; null when the payload doesn't hold it.
    function heldData(payload, path) {
      const texts = pathMap(payload && payload.texts, t => typeof t === 'string');
      if (texts.has(path)) return texts.get(path);
      const images = pathMap(payload && payload.images, u => typeof u === 'string' && SAFE_IMAGE_URI.test(u));
      return images.has(path) ? dataUrlBytes(images.get(path)) : null;
    }
    // The current version's ZIP the export wrote beside its folder (Export All, Export Artifacts): a plain link, which
    // Chrome downloads. None inside a ZIP, and none the allowlist refuses.
    function zipLink(v) {
      if (unzipped === false || typeof v.zip !== 'string' || !v.zip) return null;
      const href = relHref(v.zip);
      if (!href || !openableHref(href)) return null;
      const a = el('a', 'btn download-zip', v.missingCount > 0 ? 'Download ZIP (some files missing)' : 'Download ZIP');
      a.setAttribute('href', href);
      // A tab of its own, as Open file: a ZIP gone from disk then can't take the viewer's tab to an error page.
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener');
      return a;
    }
    // A payload's holdings for a view, once loaded; the same promise for every caller.
    const heldPayloads = new WeakMap();
    function heldPayload(v) {
      if (!heldPayloads.has(v)) heldPayloads.set(v, payloadOf(v));
      return heldPayloads.get(v);
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
        // Download, when this page holds the file (its part loads once, for the whole list).
        if (!v.notExported) heldPayload(v).then(payload => {
          const data = heldData(payload, f.path);
          if (data !== null && li.isConnected) li.append(downloadButton(f.path, data));
        });
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
      if (v.notExported) extra.push(link('btn', 'Open errors.txt', hosted ? 'artifacts/errors.txt' : 'errors.txt', false));
      box.append(actions(v, ...extra), fileList(v));
      notes(v, box);
      return box;
    }

    // ---- Parts: an artifact's texts and images, in viewer-files/part-NNNN.js, which call window.__archivePart ----
    // (as the chat viewer's). Page code can't read files, so a part arrives as a script, and only a number from the
    // data ever becomes its src.
    const partsListed = new Set();
    for (const v of views) {
      if (Number.isSafeInteger(v.part) && v.part > 0) partsListed.add(v.part);
      // Versions with previews of their own (an archive the old-archive tool rebuilt the viewer for).
      for (const e of Array.isArray(v.versions) ? v.versions : []) if (e && Number.isSafeInteger(e.part) && e.part > 0) partsListed.add(e.part);
    }
    const partsLoaded = new Map(); // n -> the part's object, the most recently used last
    const PARTS_KEPT = 2; // a part is about 4 MB; older ones are dropped and load again if needed
    const partsWaiting = new Map(); // n -> resolve, only while its script is loading
    // Hosted, the page's one __archivePart is the host's, and its loader is used instead.
    if (partsListed.size && !hosted) {
      Object.defineProperty(window, '__archivePart', {
        value(n, part) {
          const done = partsWaiting.get(n);
          if (!done || part === null || typeof part !== 'object') return;
          partsWaiting.delete(n);
          done(part);
        },
      });
    }

    // Loaded parts are kept (the PARTS_KEPT most recently used); one still loading is shared through partsInFlight,
    // which nothing evicts, so a second open of it waits on the same script instead of replacing its resolver.
    const partsInFlight = new Map(); // n -> Promise<object|null>
    function loadPart(n) {
      if (!partsListed.has(n)) return Promise.resolve(null);
      if (partsLoaded.has(n)) {
        const kept = partsLoaded.get(n);
        partsLoaded.delete(n);
        partsLoaded.set(n, kept);
        return Promise.resolve(kept);
      }
      if (partsInFlight.has(n)) return partsInFlight.get(n);
      const loading = new Promise(resolve => {
        partsWaiting.set(n, resolve);
        const script = document.createElement('script');
        const finish = () => {
          script.remove();
          const done = partsWaiting.get(n);
          if (!done) return; // the part called in, and this was its load event
          partsWaiting.delete(n);
          done(null);
        };
        script.addEventListener('load', finish);
        script.addEventListener('error', finish);
        script.src = `viewer-files/part-${String(n).padStart(4, '0')}.js`;
        document.head.append(script);
      }).then(part => {
        partsInFlight.delete(n);
        // A part that failed isn't kept, so opening the artifact later tries again.
        if (part) {
          partsLoaded.set(n, part);
          while (partsLoaded.size > PARTS_KEPT) partsLoaded.delete(partsLoaded.keys().next().value);
        }
        return part;
      });
      partsInFlight.set(n, loading);
      return loading;
    }

    // The artifact's payload { texts: [[path, text]], images: [[path, dataUri]] }, or null when its part can't load.
    const PAYLOAD_KEY = /^a(0|[1-9]\d*)$/;
    async function payloadOf(v) {
      if (!partsListed.has(v.part) || typeof v.key !== 'string' || !PAYLOAD_KEY.test(v.key)) return null;
      const part = await (hosted ? options.loadPart(v.part) : loadPart(v.part));
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
    const pageNote = byIdIn('page-note');
    const PART_FAILED = "The artifact couldn't load, because viewer-files/ is missing or blocked.";
    // The chat viewer's REMOTE_NOTE points to its Code view, which this page doesn't have.
    const PAGE_REMOTE_NOTE = 'This page loads a script from the internet, which the viewer blocks, so it may not work here.';
    let mdParser = null;
    // The note under the top bar: empty and hidden, or one or more sentences.
    function clearNote() { pageNote.replaceChildren(); pageNote.hidden = true; }
    function addNote(text) { pageNote.append(pageNote.childNodes.length ? ` ${text}` : text); pageNote.hidden = false; }

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

    // The order matters: sandbox goes on before the document does, and the frame only then joins the page.
    // Never allow-same-origin, allow-popups or allow-top-navigation; frame-src 'none' keeps the frame from navigating
    // anywhere: the page's standalone, the guard frame's hosted (guardDoc).
    function previewFrame(v, srcdoc) {
      const frame = document.createElement('iframe');
      const title = String(v.title || 'Artifact');
      frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals');
      frame.setAttribute('title', title);
      frame.setAttribute('srcdoc', hosted ? guardDoc(title, srcdoc) : srcdoc);
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
        if (doc.remote) addNote(PAGE_REMOTE_NOTE);
        return box.replaceChildren(previewFrame(v, doc.srcdoc));
      }
      if (v.startKind === 'md') return box.replaceChildren(text === null ? failedPage(v) : markdownPage(text));
      if (v.startKind === 'image') {
        // The owner's own image can also come from its saved file.
        const src = images.has(v.start) ? images.get(v.start) : ownArtifact(v) ? openHref(v, v.startSaved) : null;
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
    // does, or an image. Its texts and images come from its part, loaded now.
    function openPreview(v) {
      const box = el('div', 'preview');
      box.dataset.id = String(v.id);
      box.append(el('p', 'loading', 'Loading…'));
      pageBody.replaceChildren(box);
      clearNote();
      payloadOf(v).then(payload => {
        // Another page, or the same one rebuilt, took its place meanwhile.
        if (box.isConnected) fillPreview(v, box, payload);
      });
    }

    // A Docs artifact a chat in the export rebuilt (hosted): that chat's last version of the document, as Markdown.
    // Returns false when there is none, for the v1.16 Docs page.
    const DOCS_NOTE = "Rebuilt from the chat. Edits made on claude.ai aren't included.";
    function chatDocPage(v) {
      const ref = hosted && v.docFile && typeof v.docFile === 'object' ? v.docFile : null;
      const chat = ref && Number.isInteger(ref.chat) ? chats[ref.chat] : null;
      const file = chat && chat.files && typeof ref.file === 'string' && Object.prototype.hasOwnProperty.call(chat.files, ref.file) ? chat.files[ref.file] : null;
      const last = file && Array.isArray(file.versions) && file.versions.length ? file.versions[file.versions.length - 1] : null;
      if (!last) return false;
      const inPart = Number.isSafeInteger(last.part) && last.part > 0 && typeof last.key === 'string';
      if (typeof last.text !== 'string' && !inPart) return false;
      addNote(DOCS_NOTE);
      if (file.flag) addNote(flagNote(file));
      const box = el('div', 'preview');
      box.dataset.id = String(v.id);
      pageBody.replaceChildren(box);
      if (typeof last.text === 'string') { box.replaceChildren(markdownPage(last.text)); return true; }
      box.append(el('p', 'loading', 'Loading…'));
      Promise.resolve(options.loadPart(last.part)).then(part => {
        const text = part && Object.prototype.hasOwnProperty.call(part, last.key) && typeof part[last.key] === 'string' ? part[last.key] : null;
        if (!box.isConnected) return;
        if (text !== null) return box.replaceChildren(markdownPage(text));
        const failed = sheet('details', "The text couldn't load, because viewer-files/ is missing or blocked.");
        failed.append(actions(v));
        box.replaceChildren(failed);
      });
      return true;
    }

    function fillBody(v) {
      if (v.docs) return chatDocPage(v) || pageBody.replaceChildren(docsPage(v));
      if (isDesign(v)) return openCanvas(v);
      if (isPoster(v)) return pageBody.replaceChildren(posterPage(v));
      const shown = !v.notExported && v.start && !v.tooLarge && unzipped !== false;
      if (shown && PREVIEW_KINDS.has(v.startKind) && !v.startMissing) return openPreview(v);
      // The owner's own image not in the part (too large, or past the budget) still shows from its saved file.
      if (v.startKind === 'image' && ownArtifact(v) && !v.notExported && v.start && unzipped !== false && openHref(v, v.startSaved)) return openPreview(v);
      pageBody.replaceChildren(detailsPage(v));
    }

    function badge(text) { return el('span', 'badge', text); }

    // ---- A Design artifact's canvas (v1.20): its boards from project/canvas.json, each in a preview frame of its own
    // (the same sandbox, and guard frame when hosted, as an artifact page), drawn without claude.ai's editor ----
    const isDesign = v => isPoster(v) && v.kind === 'Design' && !v.notExported && unzipped !== false;
    const CANVAS_MARGIN = '600px';

    // Loads the payload; a layout (designCanvas) shows the canvas, anything else the poster page.
    function openCanvas(v, focus = null) {
      const box = el('div', 'preview');
      box.dataset.id = String(v.id);
      box.append(el('p', 'loading', 'Loading…'));
      pageBody.replaceChildren(box);
      heldPayload(v).then(payload => {
        if (!box.isConnected) return;
        const texts = pathMap(payload && payload.texts, t => typeof t === 'string');
        const text = texts.has(DESIGN_CANVAS_FILE) ? texts.get(DESIGN_CANVAS_FILE) : null;
        const layout = text === null ? null : designCanvas(text, path => texts.has(path));
        if (!layout) return pageBody.replaceChildren(posterPage(v));
        let wrap = canvasPage(v, layout, payload, texts);
        pageBody.replaceChildren(wrap);
        canvasBadges(layout, texts);
        if (focus) {
          // A board on the canvas, or its row in the list of boards not drawn.
          const at = pageBody.querySelector(`.design-board[data-name="${CSS.escape(focus)}"], .design-skipped li[data-name="${CSS.escape(focus)}"]`);
          if (at) {
            at.scrollIntoView({ block: 'center' });
            // Keyboard focus back where it was: the board's Open alone.
            const open = at.querySelector('button.board-open');
            if (open) open.focus({ preventScroll: true });
          }
        }
        // The scale follows the page's width: laid out again when it changes, keeping the place in it.
        if (typeof ResizeObserver === 'function') {
          let width = pageBody.clientWidth;
          let timer = null;
          const resize = new ResizeObserver(() => {
            if (!wrap.isConnected) { resize.disconnect(); return; }
            clearTimeout(timer);
            timer = setTimeout(() => {
              if (!wrap.isConnected || Math.abs(pageBody.clientWidth - width) < 24) return;
              width = pageBody.clientWidth;
              const at = pageBody.scrollTop / Math.max(1, pageBody.scrollHeight);
              const next = canvasPage(v, layout, payload, texts);
              if (wrap.stopFrames) wrap.stopFrames();
              wrap.replaceWith(next);
              wrap = next;
              pageBody.scrollTop = at * pageBody.scrollHeight;
            }, 150);
          });
          resize.observe(pageBody);
        }
      }).catch(() => {
        // A canvas.json the layout chokes on: the poster page, as for none.
        if (box.isConnected) pageBody.replaceChildren(posterPage(v));
      });
    }
    const DESIGN_CANVAS_FILE = 'project/canvas.json';

    // In place of "needs claude.ai to run": Design canvas, and whether some boards need claude.ai's templates.
    function canvasBadges(layout, texts) {
      const ours = new Set(['needs claude.ai to run', 'Design canvas', 'some boards need claude.ai']);
      const keep = [...pageBadges.children].filter(b => !ours.has(b.textContent));
      const templated = layout.boards.some(b => b.held && boardFlags(texts.get(b.path)).templated);
      pageBadges.replaceChildren(badge('Design canvas'), ...(templated ? [badge('some boards need claude.ai')] : []), ...keep);
    }

    function boardDoc(b, payload, texts) {
      return artifactPreviewDoc(texts.get(b.path), b.path, payload).srcdoc;
    }

    function canvasPage(v, layout, payload, texts) {
      const wrap = el('div', 'design-wrap');
      const avail = Math.max(320, (pageBody.clientWidth || 1000) - 48);
      const scale = canvasScale(layout.width, avail);
      const canvas = el('div', 'design-canvas');
      canvas.style.width = `${Math.ceil(layout.width * scale)}px`;
      canvas.style.height = `${Math.ceil(layout.height * scale)}px`;
      const px = n => `${Math.round(n * scale)}px`;
      for (const n of layout.notes) {
        const note = el('div', n.heading ? 'design-note heading' : 'design-note');
        note.dataset.fill = n.fill;
        note.style.left = px(n.x);
        note.style.top = px(n.y);
        note.style.width = px(n.w);
        note.style.fontSize = `${Math.max(9, Math.round((n.heading ? 28 : 14) * scale))}px`;
        note.textContent = n.text;
        canvas.append(note);
      }
      // Frames come and go as boards near the view, so only about a screenful runs at once.
      const frameOf = new Map();
      const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
        for (const e of entries) {
          const b = frameOf.get(e.target);
          if (!b) continue;
          const holder = e.target.querySelector('.board-frame');
          if (e.isIntersecting && !holder.firstChild) {
            const frame = previewFrame({ title: b.title }, boardDoc(b, payload, texts));
            frame.style.width = `${b.w}px`;
            frame.style.height = `${b.h}px`;
            holder.append(frame);
          } else if (!e.isIntersecting && holder.firstChild) holder.replaceChildren();
        }
      }, { root: pageBody, rootMargin: CANVAS_MARGIN }) : null;
      for (const b of layout.boards) {
        const item = el('div', 'design-board');
        item.dataset.name = b.name;
        item.style.left = px(b.x);
        item.style.top = px(b.y);
        item.style.width = px(b.w);
        const head = el('div', 'board-head');
        head.append(el('span', 'board-title', b.title));
        if (b.held) {
          const open = el('button', 'board-open', 'Open alone');
          open.type = 'button';
          open.setAttribute('aria-label', `Open ${b.title} alone`);
          open.addEventListener('click', () => openBoard(v, b, payload, texts));
          head.append(open);
        }
        item.append(head);
        const body = el('div', 'board-body');
        body.style.height = px(b.h);
        if (b.held) {
          const flags = boardFlags(texts.get(b.path));
          if (flags.templated) head.append(el('span', 'board-badge', "Uses claude.ai's templates; shown as saved"));
          if (flags.blobs) head.append(el('span', 'board-badge', 'Images not in this export'));
          // The row is one line, so a small board cuts it: the whole of it on hover.
          head.title = [b.title, ...[...head.querySelectorAll('.board-badge')].map(x => x.textContent)].join(' · ');
          const holder = el('div', 'board-frame');
          holder.style.transform = `scale(${scale})`;
          body.append(holder);
          frameOf.set(item, b);
        } else {
          body.classList.add('missing');
          body.append(el('span', '', "Not in the viewer's files"));
        }
        item.append(body);
        canvas.append(item);
      }
      wrap.append(canvas);
      if (layout.skipped.length) {
        const more = el('div', 'design-skipped');
        more.append(el('p', 'files-head', 'Not drawn on the canvas'));
        const ul = el('ul', 'files');
        for (const s of layout.skipped) {
          const li = el('li');
          li.dataset.name = s.name;
          li.append(el('span', 'path', s.title));
          const path = `project/${s.name}`;
          if (texts.has(path)) {
            const open = el('button', 'btn board-open', 'Open alone');
            open.type = 'button';
            open.setAttribute('aria-label', `Open ${s.title} alone`);
            open.addEventListener('click', () => openBoard(v, { name: s.name, path, title: s.title }, payload, texts));
            li.append(open);
          }
          ul.append(li);
        }
        more.append(ul);
        wrap.append(more);
      }
      if (observer) queueMicrotask(() => { for (const item of frameOf.keys()) observer.observe(item); });
      else for (const [item, b] of frameOf) item.querySelector('.board-frame').append(previewFrame({ title: b.title }, boardDoc(b, payload, texts)));
      wrap.stopFrames = () => { if (observer) observer.disconnect(); };
      return wrap;
    }

    // One board alone, at its own size, with the way back to the canvas (no new hash: Back here, not in history).
    function openBoard(v, b, payload, texts) {
      const box = el('div', 'preview');
      box.dataset.id = String(v.id);
      const bar = el('p', 'canvas-bar');
      const back = el('button', 'btn canvas-back', 'Back to the canvas');
      back.type = 'button';
      back.addEventListener('click', () => openCanvas(v, b.name));
      bar.append(back, el('span', 'board-title', b.title));
      box.append(bar, previewFrame({ title: b.title }, boardDoc(b, payload, texts)));
      pageBody.replaceChildren(box);
      pageBody.scrollTop = 0;
      // The button that opened it is gone: focus the way back.
      back.focus({ preventScroll: true });
    }

    // The current version's badges (a Design canvas replaces the first with its own, canvasBadges).
    function pageBadgesOf(v) {
      const badges = [];
      if (v.needsRuntime || isPoster(v)) badges.push(badge('needs claude.ai to run'));
      if (unverified(v)) badges.push(badge("not checked against claude.ai's checksum"));
      return badges;
    }

    function showPage(v) {
      const title = String(v.title || 'Untitled');
      pageTitle.textContent = title;
      pageTitle.title = title;
      pageKind.textContent = String(v.kind || 'Page');
      document.title = `${title} - Artifacts`;
      pageBadges.replaceChildren(...pageBadgesOf(v));
      clearNote();
      artifactLinks(v);
      if (pageFrom) {
        const row = linkGroups(v);
        const menu = versionMenu(v);
        if (menu) row.push(menu);
        pageFrom.replaceChildren(...row);
        pageFrom.hidden = row.length === 0;
      }
      fillBody(v);
      pageBody.scrollTop = 0;
    }

    // The top bar's links for the artifact's own (current) files.
    function artifactLinks(v) {
      const links = [];
      const startHref = v.notExported ? null : openHref(v, v.startSaved);
      if (startHref) links.push(link('btn open-file', 'Open file', startHref, false));
      const zip = v.notExported ? null : zipLink(v);
      if (zip) links.push(zip);
      links.push(link('btn open-claude', 'Open on claude.ai', claudeUrl(v), true));
      pageLinks.replaceChildren(...links);
      // Download for the start file, once its part has loaded and only while these links are still the page's.
      if (v.notExported || !v.start) return;
      const first = links[0];
      heldPayload(v).then(payload => {
        const data = heldData(payload, v.start);
        if (data !== null && first.isConnected && first.parentNode === pageLinks) pageLinks.prepend(downloadButton(v.start, data));
      });
    }

    // A chat's name as a link to it, opening at messageUuid.
    function chatLink(chat, messageUuid) {
      const button = el('button', 'chat-link', chatTitle(chat));
      button.type = 'button';
      button.addEventListener('click', () => { if (typeof options.onOpenChat === 'function') options.onOpenChat(chat, messageUuid || undefined); });
      return button;
    }

    // Hosted: "Made in" / "Published in" / "Edited in" and the chats, each a link.
    function linkGroups(v) {
      if (!hosted) return [];
      return artifactLinkGroups(v, chats).map(g => {
        const group = el('span', 'link-group');
        group.append(el('span', '', `${g.label} `));
        g.chats.forEach((c, i) => {
          if (i) group.append(', ');
          group.append(chatLink(c.chat, c.messageUuid));
        });
        return group;
      });
    }

    // Hosted: every version the export saved of the artifact (v.versions, artifact.json's), the current one chosen;
    // null for one version or none. Another version shows the text a chat's card of it holds (its copy), else its own
    // preview when it has one (part, key), and Open file opens its file in its version folder (or, for one the same
    // as a chat's file, that file).
    function versionMenu(v) {
      if (!hosted) return null;
      const list = Array.isArray(v.versions) ? v.versions.filter(e => e && typeof e === 'object') : [];
      // One version, the current one: nothing to choose.
      if (!list.length || (list.length === 1 && list[0].current === true)) return null;
      const label = el('label', 'version-menu');
      const select = document.createElement('select');
      let chosen = false;
      for (const [i, e] of list.entries()) {
        const text = String(e.label || `v${i + 1}`);
        const option = el('option', '', e.current === true ? `${text} (current)` : text);
        option.value = e.current === true ? 'current' : String(i);
        if (e.current === true && !chosen) { option.selected = true; chosen = true; }
        select.append(option);
      }
      // The current version not among them (not saved): it is still the artifact's own page.
      if (!chosen) {
        const now = el('option', '', 'Current');
        now.value = 'current';
        now.selected = true;
        select.append(now);
      }
      select.addEventListener('change', () => {
        clearNote();
        if (select.value === 'current') { pageBadges.replaceChildren(...pageBadgesOf(v)); artifactLinks(v); fillBody(v); return; }
        const e = list[Number(select.value)];
        if (!e) return;
        const href = versionHref(v, e);
        pageLinks.replaceChildren(...(href ? [link('btn open-file', 'Open file', href, false)] : []), link('btn open-claude', 'Open on claude.ai', claudeUrl(v), true));
        // Badges of this version, not the current one's: only whether its own files were checked.
        pageBadges.replaceChildren(...(unverified(e) ? [badge("not checked against claude.ai's checksum")] : []));
        // A version with a preview of its own (from disk): shown as the artifact is, from its own folder, ahead of a
        // chat's copy, whose siblings may be the chat's later ones. This version's own files, place and payload;
        // nothing of the current version's (its files, missing count, ZIP or note) goes with it.
        if (Number.isSafeInteger(e.part) && e.part > 0 && typeof e.key === 'string' && typeof e.start === 'string' && PREVIEW_KINDS.has(e.startKind) && unzipped !== false) {
          return openPreview({ ...v, start: e.start, startSaved: e.startSaved, startKind: e.startKind, folder: e.folder, reused: e.same === true, part: e.part, key: e.key,
            files: Array.isArray(e.files) ? e.files : [], missingCount: 0, zip: null, note: '', startMissing: false, tooLarge: false });
        }
        const copy = e.copy && typeof e.copy === 'object' && Number.isInteger(e.copy.chat) ? e.copy : null;
        const chat = copy ? chats[copy.chat] : null;
        const file = chat && chat.files && typeof copy.file === 'string' && Object.prototype.hasOwnProperty.call(chat.files, copy.file) ? chat.files[copy.file] : null;
        const ver = file && Array.isArray(file.versions) ? file.versions[copy.version] : null;
        if (ver) {
          // The files it was published with, from the chat's versions they were saved as, at their own paths.
          const siblings = versionCopyTexts(chat, e);
          return showVersionBody({ chat: copy.chat, file: copy.file, name: String(file.name || v.title || 'Page') }, ver, String(v.id),
            siblings.length ? { texts: siblings, start: typeof e.start === 'string' && e.start ? e.start : null } : null);
        }
        const box = sheet('details', `${versionName(e)} can't be shown here.`);
        if (href) {
          const row = el('p', 'actions');
          row.append(link('btn', 'Open file', href, false));
          box.append(row);
        }
        pageBody.replaceChildren(box);
      });
      label.append(el('span', '', 'Version '), select);
      return label;
    }
    const versionName = e => String(e.label || 'This version');
    // A version's start file, under openHref's rules: in its version folder, or the chat's file for a same version.
    function versionHref(v, e) {
      if (typeof e.startSaved !== 'string' || !e.startSaved) return null;
      if (e.same === true) return openHref({ ...v, reused: true }, e.startSaved);
      if (typeof e.folder !== 'string' || !e.folder) return null;
      return openHref({ ...v, reused: false, folder: e.folder }, e.startSaved);
    }

    // ---- An In chats file's page (hosted): as an artifact's, with "Made in" its chat and a menu of its versions ----
    const pageFrom = byIdIn('page-from');
    const TEXT_KINDS = new Set(['html', 'svg', 'md', 'code', 'react', 'mermaid']);
    // Only what a browser won't run as a page opens, as in the chat viewer; none inside a ZIP.
    const fileHref = v => (unzipped !== false && typeof v.href === 'string' && openableHref(v.href) ? v.href : null);
    const fileOf = f => chats[f.chat].files[f.file];
    const decodeURIComponentSafe = t => { try { return decodeURIComponent(t); } catch (e) { return t; } };

    function fileDetails(f, v, partFailed) {
      const box = sheet('details', partFailed ? "The text couldn't load, because viewer-files/ is missing or blocked." : `${f.name} can't be shown here.`, fileKindLabel(fileOf(f)));
      const href = fileHref(v);
      if (href) {
        const row = el('p', 'actions');
        row.append(link('btn', 'Open file', href, false));
        box.append(row);
      } else {
        box.append(el('p', 'note', "This file can't open from the viewer. It's in the artefacts folder of this export."));
      }
      return box;
    }

    // text: the version's text, or null. A page or diagram runs in the same guarded sandbox as an artifact's, with
    // only its own chat's scripts and stylesheets beside it; Markdown renders as the chat viewer's; an image by its link.
    function fillFile(f, v, box, text, partFailed, own = null) {
      const file = fileOf(f);
      // Download for a text this page holds, named as the version's file is (report_v2.html).
      if (text !== null) {
        const name = typeof v.href === 'string' && v.href ? decodeURIComponentSafe(v.href.split('/').pop()) : file.name;
        pageLinks.prepend(downloadButton(name || file.name || 'download', text));
      }
      if ((file.kind === 'html' || file.kind === 'svg') && text !== null) {
        const doc = own ? artifactPreviewDoc(text, own.start || file.name, { texts: own.texts })
          : artifactPreviewDoc(text, file.name, { texts: [...chatFileTexts(chats[f.chat])] });
        if (doc.remote) addNote(PAGE_REMOTE_NOTE);
        return box.replaceChildren(previewFrame({ title: f.name }, doc.srcdoc));
      }
      if (file.kind === 'md' && text !== null) return box.replaceChildren(markdownPage(text));
      if (TEXT_KINDS.has(file.kind) && text !== null) return box.replaceChildren(el('pre', 'code-view', text));
      if (file.kind === 'image' && fileHref(v)) {
        const frame = el('div', 'image');
        const img = document.createElement('img');
        img.alt = f.name;
        img.src = fileHref(v);
        frame.append(img);
        return box.replaceChildren(frame);
      }
      box.replaceChildren(fileDetails(f, v, partFailed));
    }

    // One version: its Open file link, the file's "may not match" note and the body.
    function showFileVersion(f, at) {
      const v = f.versions[at] || {};
      const href = fileHref(v);
      pageLinks.replaceChildren(...(href ? [link('btn open-file', 'Open file', href, false)] : []));
      clearNote();
      const flag = flagNote(fileOf(f));
      if (flag) addNote(flag);
      showVersionBody(f, v, formatInChatsHash(f.chat, f.file) || '');
    }

    // A chat file's version in the page body (an In chats file, or a version of an artifact a chat published).
    // Text moved to a part loads from it.
    // own: { texts, start } for a version shown with the files it was published with (versionCopyTexts), else null.
    function showVersionBody(f, v, id, own = null) {
      const box = el('div', 'preview');
      box.dataset.id = id;
      pageBody.replaceChildren(box);
      const kind = fileOf(f).kind;
      if (typeof v.text === 'string' || !TEXT_KINDS.has(kind)) return fillFile(f, v, box, typeof v.text === 'string' ? v.text : null, false, own);
      if (!(Number.isSafeInteger(v.part) && v.part > 0 && typeof v.key === 'string')) return fillFile(f, v, box, null, false);
      box.append(el('p', 'loading', 'Loading…'));
      Promise.resolve(options.loadPart(v.part)).then(part => {
        const text = part && Object.prototype.hasOwnProperty.call(part, v.key) && typeof part[v.key] === 'string' ? part[v.key] : null;
        // Another page or version took its place meanwhile.
        if (box.isConnected) fillFile(f, v, box, text, text === null, own);
      });
    }

    function showFilePage(f, at) {
      const versions = f.versions.length;
      const pick = Number.isInteger(at) && at >= 0 && at < versions ? at : versions - 1;
      pageTitle.textContent = f.name;
      pageTitle.title = f.name;
      pageKind.textContent = KIND_NAMES[f.kind];
      document.title = `${f.name} - Artifacts`;
      pageBadges.replaceChildren();
      const made = el('button', 'chat-link', chatTitle(f.chat));
      made.type = 'button';
      made.addEventListener('click', () => { if (typeof options.onOpenChat === 'function') options.onOpenChat(f.chat, f.madeAt || undefined); });
      const madeIn = el('span', 'made-in');
      madeIn.append(el('span', '', 'Made in '), made);
      const row = [madeIn];
      if (versions > 1) {
        const label = el('label', 'version-menu');
        const select = document.createElement('select');
        f.versions.forEach((v, i) => {
          const option = el('option', '', String((v && v.label) || `v${i + 1}`) + (i === versions - 1 ? ' (latest)' : ''));
          option.value = String(i);
          option.selected = i === pick;
          select.append(option);
        });
        select.addEventListener('change', () => {
          fileVersion = Number(select.value);
          showFileVersion(f, fileVersion);
        });
        label.append(el('span', '', 'Version '), select);
        row.push(label);
      }
      pageFrom.replaceChildren(...row);
      pageFrom.hidden = false;
      fileVersion = pick;
      showFileVersion(f, pick);
      pageBody.scrollTop = 0;
    }

    let openId = null; // an artifact's id, or an In chats file's hash
    let fileVersion = -1; // the version an open In chats file shows
    let homeScroll = 0;

    // The scroll position of the grid: the window's standalone, the screen's hosted.
    const scrollTop = () => (hosted ? container.scrollTop : window.scrollY);
    const scrollBack = y => (hosted ? (container.scrollTop = y) : window.scrollTo(0, y));

    // Standalone: any hash. Hosted: returns whether the hash is this screen's; on another, an open artifact is let go.
    function route(hash = location.hash) {
      const id = parseArtifactHash(hash);
      const inChat = hosted ? parseInChatsHash(hash) : null;
      if (hosted && id === null && inChat === null && hash !== HOME_HASH) {
        openId = null;
        page.hidden = true;
        home.hidden = false;
        pageBody.replaceChildren();
        pageNote.hidden = true;
        return false;
      }
      const v = id != null && byId.has(id) ? byId.get(id) : null;
      const fileHash = inChat ? formatInChatsHash(inChat.chat, inChat.file) : null;
      const f = fileHash && inChatsByHash.has(fileHash) ? inChatsByHash.get(fileHash) : null;
      if (v || f) {
        if (openId === null) homeScroll = scrollTop();
        const key = v ? id : fileHash;
        const changed = openId !== key;
        openId = key;
        home.hidden = true;
        page.hidden = false;
        if (v) showPage(v);
        else {
          // Back to the grid lands on its tab.
          if (tab !== 'chats') { tab = 'chats'; render(); }
          showFilePage(f, changed ? -1 : fileVersion);
        }
        if (changed) pageTitle.focus({ preventScroll: true });
        return true;
      }
      const was = openId;
      openId = null;
      page.hidden = true;
      home.hidden = false;
      pageBody.replaceChildren();
      pageNote.hidden = true;
      document.title = homeTitle;
      // Only the hash this route is for: hosted, show() routes while the location still has another one.
      if (hash === location.hash && location.hash && location.hash !== '#' && location.hash !== HOME_HASH) {
        try { history.replaceState(null, '', location.pathname + location.search + HOME_HASH); } catch (e) { /* the hash just stays */ }
      }
      if (was !== null) {
        scrollBack(homeScroll);
        const back = [...grid.children].find(c => c.dataset.id === was);
        if (back) back.focus({ preventScroll: true });
      }
      return true;
    }

    // Back to the grid at once; the hashchange that follows finds it already shown.
    byIdIn('home-button').addEventListener('click', () => {
      if (location.hash !== HOME_HASH) location.hash = HOME_HASH;
      route(HOME_HASH);
    });
    if (!hosted) window.addEventListener('hashchange', () => route());

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
        else if (openId !== null && inChatsByHash.has(openId)) showFilePage(inChatsByHash.get(openId), fileVersion);
      };
      probe.src = 'viewer-check.gif';
    }

    // An Export Changes run (hosted): what the screen holds.
    const sinceLine = byIdIn('since');
    if (sinceLine && data.artifactsSince) {
      sinceLine.textContent = `Changed since ${absoluteTime(data.artifactsSince) || String(data.artifactsSince)}: ${views.length} of ${Number(data.listed) || 0} listed`;
      sinceLine.hidden = false;
    }

    checkUnzipped();
    render();
    if (!hosted) route();
    return {
      route(hash) { return route(hash); },
      show() { route(HOME_HASH); },
      // The host calls it once the screen is visible: route() focuses the page title while the screen may still be
      // hidden, which a browser ignores.
      refocus() { if (!page.hidden) pageTitle.focus({ preventScroll: true }); },
    };
  }

  window.CTArtifactsApp = Object.freeze({ mount });
})();
