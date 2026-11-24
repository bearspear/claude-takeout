// Content script - runs in isolated world
// Injects script into page context and relays messages

(function() {
  'use strict';

  // Inject the fetch interceptor into the page
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('injected.js');
  script.onload = function() { this.remove(); };
  (document.head || document.documentElement).appendChild(script);

  let orgId = null;

  // Older versions cached a full conversation here, which is no longer used.
  chrome.storage.local.remove('conversationData');

  // Listen for messages from injected script
  window.addEventListener('message', function(event) {
    if (event.source !== window) return;

    if (event.data.type === 'CLAUDE_ORG_ID') {
      orgId = event.data.orgId;
      chrome.storage.local.set({ orgId: orgId });
    }
  });

  // The org claude.ai is using right now. The captured ID can be missing if the
  // page's first requests beat the interceptor, and the stored one can be from
  // another org, so the cookie comes first.
  function getActiveOrgId() {
    const match = document.cookie.match(/(?:^|;\s*)lastActiveOrg=([0-9a-f-]{36})/i);
    return match ? match[1] : null;
  }

  // Fetch a single conversation
  async function fetchConversation(orgId, conversationId) {
    const url = `https://claude.ai/api/organizations/${orgId}/chat_conversations/${conversationId}?tree=True&rendering_mode=messages&render_all_tools=true`;

    const response = await fetch(url, {
      credentials: 'include',
      headers: { 'Accept': 'application/json' }
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch conversation: ${response.status}`);
    }

    return await response.json();
  }

  // Fetch all conversations list
  async function fetchAllConversations(orgId) {
    const url = `https://claude.ai/api/organizations/${orgId}/chat_conversations`;

    const response = await fetch(url, {
      credentials: 'include',
      headers: { 'Accept': 'application/json' }
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch conversations: ${response.status}`);
    }

    return await response.json();
  }

  // The account's display name, for the mega-ZIP's file name. Only that one field leaves this function.
  async function fetchAccountName() {
    try {
      const response = await fetch('https://claude.ai/api/account', {
        credentials: 'include',
        headers: { 'Accept': 'application/json' }
      });
      if (!response.ok) return null;
      const account = await response.json();
      const name = account && (account.display_name || account.full_name);
      return typeof name === 'string' && name.trim() ? name.trim() : null;
    } catch (e) {
      return null;
    }
  }


  // ==== Published pages ====
  // A page a chat published is served from <uuid>.frame.claudeusercontent.com behind a short-lived
  // asset token. The token stays in this script: no response, error text or log holds it or a frame URL.
  const PUBLISHED_MAX_FILE = 32 * 1024 * 1024;
  const PUBLISHED_UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  const PUBLISHED_VER = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/;
  const publishedTokens = new Map(); // 'uuid:ver' -> { token ('' for a public page), expires (ms), ver (resolved), files }
  const publishedFileLists = new Map(); // 'uuid:resolved ver' -> { path: { sha256, size, contentType, fromInfo } }

  // Waits go through setTimeout here so tests can stub it.
  function publishedDelay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Errors that may reach a response carry only a code and a status, never a message from fetch.
  class PublishedError extends Error {
    constructor(code, status) { super(code); this.code = code; this.status = status; }
  }

  function publishedFail(e) {
    if (e instanceof PublishedError) return e.status ? { error: e.code, status: e.status } : { error: e.code };
    return { error: 'network' };
  }

  function publishedExpiry(token, fetchedAt) {
    const n = Number(String(token).split('.')[3]);
    const now = Date.now();
    if (Number.isFinite(n) && n * 1000 > now && n * 1000 <= now + 24 * 3600 * 1000) return n * 1000;
    return fetchedAt + 50 * 60 * 1000;
  }

  async function getOrgForPublished(request) {
    const stored = await new Promise((resolve) => chrome.storage.local.get(['orgId'], (r) => resolve(r || {})));
    return getActiveOrgId() || orgId || stored.orgId || request.orgId || null;
  }

  // Ask claude.ai for the page's asset token (and the title, history and file list). Caches the token under
  // the requested version and, for the live page (''), under the resolved one too. A page shared with the
  // account (public) comes with no token: its entry has token '' and its files are fetched without one.
  async function publishedFrameInfo(uuid, ver, org) {
    const url = 'https://claude.ai/api/frame/' + uuid + '?org=' + encodeURIComponent(org) +
      (ver ? '&ver=' + encodeURIComponent(ver) : '');
    let res;
    try {
      res = await fetch(url, { credentials: 'same-origin', headers: { 'X-Frame-CP': 'go', 'Accept': 'application/json' } });
    } catch (e) { throw new PublishedError('network'); }
    if (!res.ok) throw new PublishedError('HTTP ' + res.status, res.status);
    let body;
    try { body = await res.json(); } catch (e) { throw new PublishedError('bad response'); }
    const resolved = body && typeof body.ver === 'string' ? body.ver : '';
    if (!body || !PUBLISHED_VER.test(resolved) || (body.assetToken !== undefined && typeof body.assetToken !== 'string')) {
      throw new PublishedError('bad response');
    }
    const token = body.assetToken || '';
    // Only each file's path and type are kept; paths are checked where the list is used.
    const files = (Array.isArray(body.files) ? body.files : [])
      .filter((f) => f && typeof f.path === 'string' && f.path)
      .map((f) => ({ path: f.path, contentType: typeof f.contentType === 'string' ? f.contentType : '' }));
    const entry = { token, expires: publishedExpiry(token, Date.now()), ver: resolved, files };
    publishedTokens.set(uuid + ':' + resolved, entry);
    publishedTokens.set(uuid + ':' + ver, entry);
    // claude.ai lists history newest first (observed 2026-11-23); everything after this reads it oldest first.
    return { entry, title: body.title, history: Array.isArray(body.history) ? body.history.slice().reverse() : body.history };
  }

  async function publishedToken(uuid, ver, org, force) {
    const cached = publishedTokens.get(uuid + ':' + ver);
    if (!force && cached && cached.expires - Date.now() >= 60 * 1000) return cached;
    return (await publishedFrameInfo(uuid, ver, org)).entry;
  }

  // GET one file from the frame host. 403 gets a new token once (not for a page without a token),
  // 429 waits once (Retry-After up to 10 s), 5xx waits 1 s once.
  async function publishedFrameGet(uuid, ver, org, part) {
    let entry = await publishedToken(uuid, ver, org, false);
    let again403 = true, again429 = true, again5xx = true;
    for (;;) {
      const url = 'https://' + uuid + '.frame.claudeusercontent.com/_f/' + entry.ver + '/' + part +
        (entry.token ? '?__frame_t=' + encodeURIComponent(entry.token) : '');
      let res;
      try {
        res = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error' });
      } catch (e) { throw new PublishedError('network'); }
      if (res.ok) return res;
      const s = res.status;
      if (s === 403 && again403 && entry.token) { again403 = false; entry = await publishedToken(uuid, ver, org, true); continue; }
      if (s === 429 && again429) {
        const wait = parseFloat(res.headers && res.headers.get ? res.headers.get('Retry-After') : '');
        if (Number.isFinite(wait) && wait >= 0 && wait <= 10) { again429 = false; await publishedDelay(wait * 1000); continue; }
      }
      if (s >= 500 && again5xx) { again5xx = false; await publishedDelay(1000); continue; }
      throw new PublishedError('HTTP ' + s, s);
    }
  }

  function publishedPathOk(p) {
    if (typeof p !== 'string' || !p || p.charAt(0) === '/') return false;
    return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
  }

  // The version's files from _files.json. Pages made outside chats (Cowork, Claude Code) have none (404): those
  // use the frame info's list, which has no size or checksum. A page without a token (shared with you) can't
  // read _files.json at all (it fails before any status, observed 2026-11-16), so it uses that list directly.
  // With no files in the frame info, the error stands.
  async function publishedFileList(uuid, ver, org) {
    let entry = await publishedToken(uuid, ver, org, false);
    const fromInfo = (list = entry.files) => {
      const files = Object.create(null);
      for (const f of list || []) {
        files[f.path] = { contentType: f.contentType, size: null, sha256: null, fromInfo: true };
      }
      return files;
    };
    let files;
    if (!entry.token) {
      if (!entry.files || !entry.files.length) throw new PublishedError('HTTP 403', 403);
      files = fromInfo();
    } else {
      try {
        const res = await publishedFrameGet(uuid, ver, org, '_files.json');
        let body;
        try { body = await res.json(); } catch (e) { throw new PublishedError('bad response'); }
        files = body && body.files && typeof body.files === 'object' ? body.files : {};
      } catch (e) {
        entry = publishedTokens.get(uuid + ':' + ver) || entry;
        if (!(e instanceof PublishedError) || e.status !== 404) throw e;
        if (entry.files && entry.files.length) files = fromInfo();
        else {
          // An older version of such a page: claude.ai lists files only for the live version, and the older one's
          // own content sits at the same paths (observed 2026-11-23). Its files are fetched at those, unverified.
          const live = ver !== '' ? await publishedToken(uuid, '', org, false) : null;
          if (!live || !live.files || !live.files.length) throw e;
          files = fromInfo(live.files);
          Object.defineProperty(files, 'fromLive', { value: true });
        }
      }
    }
    publishedFileLists.set(uuid + ':' + entry.ver, files);
    return files;
  }

  async function publishedPageInfo(request) {
    const uuid = request.uuid, ver = request.ver == null ? '' : request.ver;
    if (typeof uuid !== 'string' || !PUBLISHED_UUID.test(uuid) || typeof ver !== 'string' ||
        (ver !== '' && !PUBLISHED_VER.test(ver))) return { error: 'bad request' };
    const org = await getOrgForPublished(request);
    if (!org) return { error: 'no org' };
    const info = await publishedFrameInfo(uuid, ver, org);
    const listing = await publishedFileList(uuid, ver, org);
    const files = [], rejected = [];
    let runtimeSkipped = 0;
    for (const p of Object.keys(listing)) {
      if (p.indexOf('artifact-type/') === 0) { runtimeSkipped++; continue; }
      if (!publishedPathOk(p)) { rejected.push(p); continue; }
      const f = listing[p] || {};
      files.push({ path: p, size: f.size, contentType: f.contentType, sha256: f.sha256 });
    }
    return { ver: info.entry.ver, title: info.title, history: info.history, files, rejected, runtimeSkipped, ...(listing.fromLive ? { listFromLive: true } : {}) };
  }

  // Every artifact claude.ai lists for the account. Only the fields an export keeps leave this function
  // (no owner, audience, thumbnail or URL), and a failure is a code, never a message. Each artifact's card
  // picture URL is checked and kept in artifactThumbUrls; only artifactThumbUrl hands one out, to the popup,
  // which fetches it (with the optional https permission) and keeps it nowhere.
  let artifactThumbUrls = null; // lowercased uuid -> rebuilt picture URL, replaced by each listing
  let artifactThumbRelisted = false; // one re-list on a 403 per export (reset by listArtifacts)

  // The picture URL rebuilt from its checked parts, or null: https, no port, userinfo or hash, host exactly
  // <uuid>.frame.claudeusercontent.com, path /_f/<ver>/_thumb.img, one query parameter, __frame_t.
  function checkThumbUrl(uuid, raw) {
    if (typeof raw !== 'string' || raw.indexOf('#') !== -1) return null;
    let u;
    try { u = new URL(raw); } catch (e) { return null; }
    const host = uuid.toLowerCase() + '.frame.claudeusercontent.com';
    if (u.protocol !== 'https:' || u.port !== '' || u.username !== '' || u.password !== '' || u.hash !== '' ||
        u.hostname !== host || u.host !== host) return null;
    const m = /^\/_f\/([^/]+)\/_thumb\.img$/.exec(u.pathname);
    if (!m || !PUBLISHED_VER.test(m[1])) return null;
    const params = Array.from(u.searchParams);
    if (params.length !== 1 || params[0][0] !== '__frame_t' || !params[0][1]) return null;
    // The token is kept as listed (decoding and encoding again would turn '+' into '%20'), and only in this
    // plain form: the query exactly as the listing wrote it, nothing the parser had to encode.
    const q = /^\?__frame_t=([A-Za-z0-9._~%+-]+)$/.exec(u.search);
    if (!q || raw.slice(raw.indexOf('?')) !== u.search) return null;
    return 'https://' + host + '/_f/' + m[1] + '/_thumb.img?__frame_t=' + q[1];
  }

  async function fetchFrameList(org) {
    let res;
    try {
      res = await fetch('https://claude.ai/api/frame/frames?org=' + encodeURIComponent(org) + '&limit=1000',
        { credentials: 'same-origin', headers: { 'X-Frame-CP': 'go', 'Accept': 'application/json' } });
    } catch (e) { throw new PublishedError('network'); }
    if (!res.ok) throw new PublishedError('HTTP ' + res.status, res.status);
    let body;
    try { body = await res.json(); } catch (e) { throw new PublishedError('bad response'); }
    if (!body || !Array.isArray(body.frames)) throw new PublishedError('bad response');
    const frames = body.frames.filter((f) => f && typeof f === 'object');
    const thumbs = new Map();
    for (const f of frames) {
      if (typeof f.slug !== 'string' || !PUBLISHED_UUID.test(f.slug)) continue;
      const url = checkThumbUrl(f.slug, f.thumbImgURL);
      if (url) thumbs.set(f.slug.toLowerCase(), url);
    }
    artifactThumbUrls = thumbs;
    return frames;
  }

  // claude.ai's paged artifact list (/api/frame/artifacts, what claude.ai/artifacts itself reads), every page, with
  // no empty filter (empty=exclude, the page's default, hides typed artifacts). /api/frame/frames, the quick list,
  // has no paging and may stop short; this one gives each artifact's fields but not its live version. Returns
  // { status: 'ok' | 'capped', items } or { status: 'failed', code }: an HTTP status, 'network', 'bad response'
  // or 'repeated page'. Only plain values are kept, never a URL.
  const ARTIFACT_PAGE_SIZE = 100;
  const ARTIFACT_PAGE_MAX = 100;
  async function fetchArtifactPages(org) {
    const items = [];
    const tokens = new Set();
    let token = '';
    for (let page = 0; page < ARTIFACT_PAGE_MAX; page++) {
      let res;
      try {
        res = await fetch('https://claude.ai/api/frame/artifacts?rel=all&sort=last_viewed&with_folder=true&through_folders=true&limit=' +
          ARTIFACT_PAGE_SIZE + '&org=' + encodeURIComponent(org) + (token ? '&page_token=' + encodeURIComponent(token) : ''),
          { credentials: 'same-origin', headers: { 'X-Frame-CP': 'go', 'Accept': 'application/json' } });
      } catch (e) { return { status: 'failed', code: 'network' }; }
      if (!res.ok) return { status: 'failed', code: 'HTTP ' + res.status };
      let body;
      try { body = await res.json(); } catch (e) { return { status: 'failed', code: 'bad response' }; }
      const next = body ? body.next_page_token : undefined;
      if (!body || !Array.isArray(body.artifacts) || (next != null && typeof next !== 'string')) return { status: 'failed', code: 'bad response' };
      for (const a of body.artifacts) if (a && typeof a === 'object' && a.kind !== 'folder') items.push(a);
      if (!next) return { status: 'ok', items };
      if (tokens.has(next)) return { status: 'failed', code: 'repeated page' };
      tokens.add(next);
      token = next;
    }
    return { status: 'capped', items };
  }

  async function listArtifacts(request) {
    const org = await getOrgForPublished(request);
    artifactThumbUrls = null; // a failed listing leaves no pictures
    if (!org) return { error: 'no org' };
    artifactThumbRelisted = false;
    const raw = await fetchFrameList(org);
    const str = (v) => (typeof v === 'string' ? v : '');
    const frames = raw.map((f) => ({
      slug: str(f.slug), title: str(f.title), typeSlug: str(f.type_slug), typeTitle: str(f.type_title),
      sourceSurface: str(f.source_surface), rel: str(f.rel), live: str(f.live),
      updatedAt: str(f.updatedAt), createdAt: str(f.created_at), public: f.audience === 'public',
    }));
    // What the quick list missed, from the paged list: its fields, no live version (the page info resolves it)
    // and no picture. A paging failure keeps the quick list as it is.
    let paging;
    const paged = await fetchArtifactPages(org);
    if (paged.status === 'failed') {
      paging = { status: 'failed', code: paged.code };
    } else {
      const seen = new Set(frames.map((f) => f.slug.toLowerCase()));
      let added = 0;
      for (const a of paged.items) {
        if (typeof a.id !== 'string' || !PUBLISHED_UUID.test(a.id) || seen.has(a.id.toLowerCase())) continue;
        seen.add(a.id.toLowerCase());
        added++;
        frames.push({
          slug: a.id, title: str(a.title), typeSlug: str(a.type_slug), typeTitle: str(a.type_title),
          sourceSurface: str(a.source), rel: str(a.rel), live: '',
          updatedAt: str(a.updated_at), createdAt: str(a.created_at), public: a.audience === 'public', paged: true,
        });
      }
      paging = { status: paged.status, added };
    }
    const accountName = request.withAccountName ? await fetchAccountName() : null;
    return { frames, paging, accountName, orgId: org };
  }

  // An artifact's card picture URL as { url }, checked when listed and rebuilt from its parts, or
  // { error: 'no picture' }. With refresh, the list is fetched again once per export (a 403 picture: one
  // /api/frame/frames call renews every URL); after that, the URL as it stands. Only the popup asks, and only
  // to fetch the picture; nothing here logs the URL.
  async function artifactThumbUrl(request) {
    const none = { error: 'no picture' };
    const uuid = typeof request.uuid === 'string' && PUBLISHED_UUID.test(request.uuid) ? request.uuid.toLowerCase() : null;
    if (!uuid || !artifactThumbUrls) return none;
    if (request.refresh === true && !artifactThumbRelisted) {
      artifactThumbRelisted = true;
      const org = await getOrgForPublished(request);
      if (!org) return none;
      try { await fetchFrameList(org); } catch (e) { artifactThumbUrls = null; return none; }
    }
    const url = artifactThumbUrls && artifactThumbUrls.get(uuid);
    return url ? { url } : none;
  }

  function publishedBase64(bytes) {
    const STEP = 3 * 8192; // a multiple of 3, so each piece encodes without padding
    let out = '';
    for (let i = 0; i < bytes.length; i += STEP) {
      out += btoa(String.fromCharCode.apply(null, bytes.subarray(i, i + STEP)));
    }
    return out;
  }

  // Read a body, stopping once it passes the cap whatever the listing claimed. Null means too large.
  async function publishedReadBody(res, max = PUBLISHED_MAX_FILE) {
    const body = res.body;
    if (!body || typeof body.getReader !== 'function') {
      let ab;
      try { ab = await res.arrayBuffer(); } catch (e) { throw new PublishedError('network'); }
      return ab.byteLength > max ? null : new Uint8Array(ab);
    }
    const reader = body.getReader();
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > max) { try { reader.cancel().catch(() => {}); } catch (e) {} return null; }
        chunks.push(value);
      }
    } catch (e) { throw new PublishedError('network'); }
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.byteLength; }
    return out;
  }

  async function publishedPageFile(request) {
    const uuid = request.uuid, ver = request.ver == null ? '' : request.ver, p = request.path;
    if (typeof uuid !== 'string' || !PUBLISHED_UUID.test(uuid) || typeof ver !== 'string' ||
        (ver !== '' && !PUBLISHED_VER.test(ver)) || !publishedPathOk(p) || p.indexOf('artifact-type/') === 0) {
      return { error: 'bad request' };
    }
    if (Number(request.size) > PUBLISHED_MAX_FILE) return { error: 'too large' };
    const org = await getOrgForPublished(request);
    if (!org) return { error: 'no org' };
    const cached = publishedTokens.get(uuid + ':' + ver);
    let listing = cached && publishedFileLists.get(uuid + ':' + cached.ver);
    if (!listing) listing = await publishedFileList(uuid, ver, org);
    const meta = listing[p];
    if (!meta) return { error: 'not found' };
    if (!meta.fromInfo) {
      if (!Number.isFinite(meta.size) || meta.size < 0) return { error: 'bad response' };
      if (meta.size > PUBLISHED_MAX_FILE) return { error: 'too large' };
    }
    const encoded = p.split('/').map(encodeURIComponent).join('/');
    const entry = publishedTokens.get(uuid + ':' + ver);
    let res;
    if (meta.fromInfo && entry && !entry.token) {
      // Without a token, _src fails before any status (observed 2026-11-16); the page is served at its own path.
      res = await publishedFrameGet(uuid, ver, org, encoded);
    } else {
      try {
        res = await publishedFrameGet(uuid, ver, org, '_src/' + encoded);
      } catch (e) {
        // A file from the frame info's list may be served only at its own path.
        if (!meta.fromInfo || !(e instanceof PublishedError) || e.status !== 404) throw e;
        res = await publishedFrameGet(uuid, ver, org, encoded);
      }
    }
    const buf = await publishedReadBody(res);
    if (!buf) return { error: 'too large' };
    return { base64: publishedBase64(buf), contentType: meta.contentType, size: buf.length };
  }

  function runPublished(fn, request, sendResponse) {
    (async () => {
      try { sendResponse(await fn(request)); } catch (e) { sendResponse(publishedFail(e)); }
    })();
  }

  // Listen for messages from popup
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {

    if (request.action === 'getOrgId') {
      chrome.storage.local.get(['orgId'], (result) => {
        sendResponse({ orgId: getActiveOrgId() || orgId || result.orgId });
      });
      return true;
    }

    if (request.action === 'fetchAllConversations') {
      chrome.storage.local.get(['orgId'], async (result) => {
        const id = getActiveOrgId() || orgId || result.orgId || request.orgId;
        if (!id) {
          sendResponse({ error: 'No org ID available. Refresh the page first.' });
          return;
        }
        try {
          const conversations = await fetchAllConversations(id);
          const accountName = request.withAccountName ? await fetchAccountName() : null;
          sendResponse({ data: conversations, orgId: id, accountName });
        } catch (e) {
          sendResponse({ error: e.message });
        }
      });
      return true;
    }

    if (request.action === 'fetchConversation') {
      chrome.storage.local.get(['orgId'], async (result) => {
        const id = getActiveOrgId() || orgId || result.orgId || request.orgId;
        if (!id) {
          sendResponse({ error: 'No org ID available.' });
          return;
        }
        try {
          const data = await fetchConversation(id, request.conversationId);
          sendResponse({ data: data });
        } catch (e) {
          sendResponse({ error: e.message });
        }
      });
      return true;
    }

    if (request.action === 'publishedPageInfo') {
      runPublished(publishedPageInfo, request, sendResponse);
      return true;
    }

    if (request.action === 'listArtifacts') {
      runPublished(listArtifacts, request, sendResponse);
      return true;
    }

    if (request.action === 'artifactThumbUrl') {
      runPublished(artifactThumbUrl, request, sendResponse);
      return true;
    }

    if (request.action === 'publishedPageFile') {
      runPublished(publishedPageFile, request, sendResponse);
      return true;
    }
  });

  console.log('[Claude Takeout] Content script loaded');
})();
