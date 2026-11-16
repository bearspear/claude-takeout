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
    return { entry, title: body.title, history: body.history };
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

  // The version's files from _files.json. Pages made outside chats (Cowork, Claude Code) have none (404),
  // and a page without a token may not read it (403): those use the frame info's list, which has no
  // size or checksum.
  async function publishedFileList(uuid, ver, org) {
    let entry = await publishedToken(uuid, ver, org, false);
    let files;
    try {
      const res = await publishedFrameGet(uuid, ver, org, '_files.json');
      let body;
      try { body = await res.json(); } catch (e) { throw new PublishedError('bad response'); }
      files = body && body.files && typeof body.files === 'object' ? body.files : {};
    } catch (e) {
      entry = publishedTokens.get(uuid + ':' + ver) || entry;
      if (!(e instanceof PublishedError) || e.status !== (entry.token ? 404 : 403)) throw e;
      files = {};
      for (const f of entry.files || []) {
        files[f.path] = { contentType: f.contentType, size: null, sha256: null, fromInfo: true };
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
    return { ver: info.entry.ver, title: info.title, history: info.history, files, rejected, runtimeSkipped };
  }

  // Every artifact claude.ai lists for the account. Only the fields an export keeps leave this function
  // (no owner, thumbnail or URL), and a failure is a code, never a message.
  async function listArtifacts(request) {
    const org = await getOrgForPublished(request);
    if (!org) return { error: 'no org' };
    let res;
    try {
      res = await fetch('https://claude.ai/api/frame/frames?org=' + encodeURIComponent(org) + '&limit=1000',
        { credentials: 'same-origin', headers: { 'X-Frame-CP': 'go', 'Accept': 'application/json' } });
    } catch (e) { throw new PublishedError('network'); }
    if (!res.ok) throw new PublishedError('HTTP ' + res.status, res.status);
    let body;
    try { body = await res.json(); } catch (e) { throw new PublishedError('bad response'); }
    if (!body || !Array.isArray(body.frames)) throw new PublishedError('bad response');
    const str = (v) => (typeof v === 'string' ? v : '');
    const frames = body.frames.filter((f) => f && typeof f === 'object').map((f) => ({
      slug: str(f.slug), title: str(f.title), typeSlug: str(f.type_slug), typeTitle: str(f.type_title),
      sourceSurface: str(f.source_surface), rel: str(f.rel), live: str(f.live),
      updatedAt: str(f.updatedAt), createdAt: str(f.created_at),
    }));
    const accountName = request.withAccountName ? await fetchAccountName() : null;
    return { frames, accountName, orgId: org };
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
  async function publishedReadBody(res) {
    const body = res.body;
    if (!body || typeof body.getReader !== 'function') {
      let ab;
      try { ab = await res.arrayBuffer(); } catch (e) { throw new PublishedError('network'); }
      return ab.byteLength > PUBLISHED_MAX_FILE ? null : new Uint8Array(ab);
    }
    const reader = body.getReader();
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > PUBLISHED_MAX_FILE) { try { reader.cancel().catch(() => {}); } catch (e) {} return null; }
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
    let res;
    try {
      res = await publishedFrameGet(uuid, ver, org, '_src/' + encoded);
    } catch (e) {
      // A file from the frame info's list may be served only at its own path.
      const entry = publishedTokens.get(uuid + ':' + ver);
      if (!meta.fromInfo || !(e instanceof PublishedError) || !(e.status === 404 || (e.status === 403 && entry && !entry.token))) throw e;
      res = await publishedFrameGet(uuid, ver, org, encoded);
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

    if (request.action === 'publishedPageFile') {
      runPublished(publishedPageFile, request, sendResponse);
      return true;
    }
  });

  console.log('[Claude Takeout] Content script loaded');
})();
