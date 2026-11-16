// The artifacts viewer page (viewer.html of an Export Artifacts export). Reads the inline data,
// { exported, listed, artifacts: ArtifactView[] } (see artifactView in popup.js), and shows the home page:
// a grid of cards like claude.ai/artifacts, with tabs (All / Yours / Shared with you) and a title search.
// Every text from the data goes in through textContent or attributes, never as markup.
// Clicking a card sets #a=<id>; the artifact page comes with the next step, until then the grid stays.
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

  function picture(v) {
    const box = el('span', 'pic');
    if (typeof v.thumb === 'string' && THUMB_PATH.test(v.thumb)) {
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

  // / anywhere outside a text field puts the cursor in the search box.
  document.addEventListener('keydown', e => {
    if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
    const t = e.target;
    if (t && t.closest && t.closest('input, textarea, select, [contenteditable]')) return;
    e.preventDefault();
    search.focus();
    search.select();
  });

  render();
})();
