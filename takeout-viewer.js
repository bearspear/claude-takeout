// Claude Takeout - offline viewer data builder
// Classic script. Exposes globalThis.CTViewer (and module.exports for tests):
//   buildViewerChat(data, ctx)         one conversation as the viewer's compact Chat (see the data contract).
//                                      ctx: { folder, model, fixText, artifacts, artifactIndex, uploads,
//                                      deliveries, heredocs, docKey, widgetFile, widgetKey, project, flags }, all optional.
//                                      data is never mutated. widgetFile, widgetKey: export-core.js's, for show_widget cards.
//                                      flags: file name to 'script' | 'edit' | 'doc' | 'draft' | 'helper' (viewerFlags in export-core.js);
//                                      a file with that name gets flag, for the viewer's "may not match" badge.
//                                      artifacts: filename to text ('' for binaries). artifactIndex: extractArtifacts' index
//                                      (state key to { path, filename, versions, messages }). deliveries: file uuid to
//                                      { filename, path }. heredocs(command): [{ path, text }], the files a Bash command
//                                      writes with a heredoc; without it Bash blocks yield no cards.
//   buildViewerSession(session, events, {folder})  a Claude Code or Cowork session for ViewerData.sessions:
//                                      { id, title, origin, created, updated, folder, artifacts: [uuid], chat }. chat is
//                                      buildViewerChat's shape without project: one flat branch, a reply per prompt,
//                                      labelled on a compaction or command prompt, tool results cut at 2 KB, images by
//                                      relative path under folder (sessions/<name>), every tool input string cut at 2 KB,
//                                      a subagent's messages in the Agent tool block's children (a group with no Agent
//                                      block joins the main line in time order). With ctx.sessionImages (only set here), a
//                                      top-level image block is { t: 'image', href }; chats leave it out as before.
//                                      opts.artifacts ({ views, records }, as buildViewerData takes them): each page the
//                                      session published (Artifact, publish_files) gets a chat's published-page card,
//                                      its versions linking the store's saved start file, no text, and part, key and
//                                      start (the artifact step's preview payload) for a text start file; a page or
//                                      version not in the store gets the card with the claude.ai link only. pages:
//                                      { <uuid>: file id } of those cards, only when there are some; a listed page's
//                                      file has artifact: <view id> (a listed record, or a view with no record, as chats).
//                                      A card holds one version per resolved id: a publish naming none is the current one.
//   buildViewerData(chats, {exported, artifacts, sessions}) { exported, chats, projects, sessions? }, newest update first;
//                                      sessions (newest activity first) only when given. A chat's project is an
//                                      index into projects, where identical projects are kept once. artifacts:
//                                      { views, records, listed, exported, since, listFetched } (Export All; records: each
//                                      artifact.json written, with dir, its folder from the root); with views, records or
//                                      listFetched false the data also has storeCount (records.length), artifacts (each view plus links: [{ chat (index
//                                      in chats), messageUuid, how }], docFile: { chat, file } | null, the latest chat's
//                                      rebuilt document, listed (its record's) and versions: [{ ver, label, folder, start,
//                                      startSaved, same, current, copy, and part, key, startKind for a version with
//                                      its own preview: records from disk, versionPlaces }] from its record), listed,
//                                      exportedArtifacts,
//                                      artifactsSince, listFetched; a published:<uuid> file of a listed artifact gets
//                                      artifact: <view id>.
//                                      A chat's links (artifactLinksOf) are a non-enumerable property of buildViewerChat's result.
//                                      A chat made when an artifact was opened has startedWith: <uuid> (startedWithArtifact);
//                                      with no messages, buildViewerData gives it opened: { title, file, version } and that
//                                      file (o1: the store's saved versions, as a session's card), or { title } alone.
//                                      A GenFile Claude made has madeAt: the message of its last version.
//   moveUploadText(data, {firstPart, inlineLimit, partLimit})  { data, parts: [{ name, body }] }: upload text over
//                                      UPLOAD_INLINE_LIMIT bytes moves into viewer-files parts; the upload keeps
//                                      { text: null, lines, part, key }. Keys are u0, u1, ... A generated file's
//                                      version over the limit (not .css/.js/.mjs) moves too and keeps
//                                      { text: null, part, key }, keys f0, f1, ...; code reading version.text
//                                      must allow for null until the part is loaded. Attachments stay
//   PART_LIMIT, UPLOAD_INLINE_LIMIT    4 MB per part; 64 KB of upload text stays in the page
//   artifactViewParts({partLimit, budget})  Export Artifacts' preview parts: { add(view, payload) -> view with
//                                      part and key, drain() -> parts closed so far, flush() -> the rest, count }.
//                                      Payload { texts: [[path, text]], images: [[path, dataUri]] }, keys a0, a1, ...;
//                                      ARTIFACT_PARTS_BUDGET (256 MB) bounds all part bodies of one export
//   relHref(...parts)                  URL-encoded relative link, or null when a part escapes upward
//   joinPath(folder, rel)              folder + rel with '..' resolved; null if it climbs above the folder
//   escapeJson(data)                   JSON that is safe inside a <script> tag
//   assembleViewer({template, css, marked, katex, highlight, logic, app, artifactsApp, artifactsCss, data, fileScripts,
//                  fileMedia})          one HTML string. artifactsApp and artifactsCss (viewer/artifacts-app.js and
//                                      viewer/artifacts.css) fill ARTIFACTS_APP_JS and ARTIFACTS_CSS ('' when left out).
//                                      fileScripts adds file: to the page's script-src and media-src, for viewer-files/
//                                      beside it and added audio and video. fileMedia adds it to media-src alone, for a
//                                      viewer with no parts. Exports set fileScripts only when moveUploadText made parts
//   kindFor(filename, mime, hasText)   a GenFile's kind
//   VIEWER_ASSETS                      paths of the nine viewer files: template, logic, app, marked, katex, KaTeX CSS,
//                                      highlight, the artifacts app and its CSS (the Artifacts screen), in that order
//   ARTIFACTS_VIEWER_ASSETS            Export Artifacts' viewer: template, logic, app, marked and CSS, in that order
//   TOOL_TEXT_LIMIT                    longest tool result text kept
//   TEXT_EMBED_LIMIT                   longest upload or project text a caller should pass in ctx
//   VIEWER_CHECK_FILE, VIEWER_CHECK_BASE64  a 1x1 GIF beside viewer.html: if it won't load, the ZIP wasn't unzipped
//   ctx.toolImages: file uuid to 'images/<name>', images in tool results the export saved (Claude's Read of a
//                picture links it on claude.ai); a tool block's images then holds their relative paths
//   ctx.webImages: image URL to 'images/<name>', the web images the export saved (saveWebImages in popup.js);
//                a tool block of an image_search gets web: [{ title, page, source, href }], href null when not saved
//   ctx.uploads: file uuid (or file name when there is none) to { path: 'uploads/<name>', text: string|null }; a file on
//                Claude's own message is { path: 'artefacts/<name>', text: null }
//   ctx.project: { name, fileDir, fileNames, docs: [{ name, text }], instructions, id?, description?, updated? }, fileDir relative to the chat folder;
//                id (project uuid), description and updated (ISO time) are copied when strings;
//                instructions: the project's prompt template ('' when none), cut at TEXT_EMBED_LIMIT
//   ctx.published: the pages the chat published (savePublishedPages in popup.js, chatFromDisk in tools/archive-lib.js),
//                [{ uuid, title, url, current, dir, versions: [{ label, order, startSaved, same, writtenAs, incomplete,
//                needsRuntime, text, folderName, publishes: [{ messageUuid, toolUseId }] }] }], dir relative to the chat
//                folder. Each publish_files call gets a card for the version its toolUseId is in, one GenFile per page
//                (key published:<uuid>, on or off the active branch) with published: { url, current, needsRuntime } and
//                versions in `order`, each { label, text, href, same }: a same version links the file Claude wrote, any
//                other its start file under dir, and one with nothing saved has no link; ver: claude.ai's version id,
//                when known (the Artifacts screen matches it with an artifact's current version). The card replaces the
//                tool's "Published on claude.ai" line, and an upload claude.ai attached to that message under the
//                name of one of the page's sources is dropped, so the page shows once. A version with part and key
//                (only a session's, from sessionPublished) keeps them and its start: the viewer reads its text from
//                that part's preview payload.
(function (root) {
  'use strict';

  const TOOL_TEXT_LIMIT = 20000;
  const TEXT_EMBED_LIMIT = 2 * 1024 * 1024; // longest upload or project text a caller should embed
  const PART_LIMIT = 4 * 1024 * 1024; // largest viewer-files part, unless one text alone is larger
  const UPLOAD_INLINE_LIMIT = 64 * 1024; // upload text over this many UTF-8 bytes goes to a part
  // An older version's preview goes in only while this much of the budget is left, for the current versions to come.
  const ARTIFACT_HISTORY_RESERVE = 64 * 1024 * 1024;
  const ARTIFACT_PARTS_BUDGET = 256 * 1024 * 1024; // Export Artifacts: all part bodies together, at most
  const VIEWER_CHECK_FILE = 'viewer-check.gif';
  const VIEWER_CHECK_BASE64 = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  const SAFE_IMAGE = /^image\/(png|jpeg|gif|webp)$/;

  const VIEWER_ASSETS = [
    'viewer/viewer-template.html', 'viewer/viewer-logic.js', 'viewer/viewer-app.js',
    'viewer/marked.min.js', 'viewer/katex.min.js', 'viewer/katex-inline.css', 'viewer/highlight.min.js',
    'viewer/artifacts-app.js', 'viewer/artifacts.css'
  ];
  // Export Artifacts' viewer.html: template, logic, app, marked, CSS (no KaTeX or highlight.js).
  const ARTIFACTS_VIEWER_ASSETS = ['viewer/artifacts-template.html', 'viewer/viewer-logic.js', 'viewer/artifacts-app.js', 'viewer/marked.min.js', 'viewer/artifacts.css'];

  function cut(text) {
    const s = String(text == null ? '' : text);
    return s.length > TOOL_TEXT_LIMIT
      ? s.slice(0, TOOL_TEXT_LIMIT) + `\n[... truncated: ${s.length - TOOL_TEXT_LIMIT} more characters]`
      : s;
  }

  // Tool input with long strings cut, so a whole file body in create_file does not bloat the page.
  function compactInput(input) {
    if (!input || typeof input !== 'object') return {};
    const out = {};
    for (const k of Object.keys(input)) out[k] = typeof input[k] === 'string' ? cut(input[k]) : input[k];
    return out;
  }

  function toolLabel(name, input) {
    const i = input && typeof input === 'object' ? input : {};
    const p = i.path || i.file_path || '';
    switch (name) {
      case 'web_search': return 'Searched the web';
      // As claude.ai: "Read github.com", the address after it as a link (toolLink).
      case 'web_fetch': { const host = hostOf(i.url); return host ? `Read ${host}` : 'Fetched a page'; }
      // As claude.ai labels its steps: a command by the description Claude gave it, a file by its name.
      case 'bash_tool': case 'Bash': return typeof i.description === 'string' && i.description.trim() ? i.description.trim() : 'Ran a command';
      case 'create_file': case 'Write': return p ? `Created ${baseName(p)}` : 'Created a file';
      case 'str_replace': case 'Edit': case 'str_replace_based_edit_tool': return p ? `Edited ${baseName(p)}` : 'Edited a file';
      case 'view': case 'read_file': case 'Read': return p ? `Read ${baseName(p)}` : 'Read a file';
      case 'ToolSearch': {
        const server = /mcp__([^_]+(?:_[^_]+)*?)__/.exec(String(i.query || ''));
        return server ? `Loaded ${server[1]}` : 'Loaded tools';
      }
      case 'present_files': return 'Presented files';
      case 'artifacts': return i.title ? `Artifact: ${i.title}` : 'Artifact';
      case 'Artifact':
        if (core('isArtifactPublish')(name, i)) return `Published a page: ${baseName(i.file_path)}`;
        return i.action === 'open' ? 'Opened an artifact' : 'Artifact';
      case 'image_search': return i.query ? `Searched for images: ${i.query}` : 'Searched for images';
      default: {
        // Tools under a connector prefix (mcp__visualize__show_widget) or with one: the visualize and
        // claude-artifacts tools by what they did.
        const tail = String(name || '').split(/__|:/).pop();
        if (tail !== name || /^(show_widget|publish_files|read_me)$/.test(tail)) {
          if (tail === 'show_widget') return i.title ? `Drew a diagram: ${i.title}` : 'Drew a diagram';
          if (tail === 'publish_files') return i.title ? `Published a page: ${i.title}` : 'Published a page';
          if (tail === 'image_search') return i.query ? `Searched for images: ${i.query}` : 'Searched for images';
          if (tail === 'read_me' && /visualize/i.test(String(name))) return 'Read the diagram guide';
          const server = /^mcp__(.+?)__/.exec(String(name || ''));
          if (server && /artifacts/i.test(server[1])) {
            if (tail === 'list_types') return 'Listed artifact types';
            if (tail === 'guide') return 'Used artifacts';
          }
          if (server && !/Claude_Docs/.test(server[1])) return `Used ${server[1]}`;
        }
        // Claude Docs tools come under a connector prefix, such as mcp__Claude_Docs__update.
        const doc = /Claude_Docs__(\w+)$/.exec(String(name || ''));
        // A batch creates a document only when it carries container.create; otherwise it edits one.
        if (doc && doc[1] === 'batch' && !(i.container && i.container.create)) return 'Edited the document';
        if (doc) return ({ batch: 'Created a document', update: 'Edited the document', create: 'Commented on the document', guide: 'Read the Claude Docs guide' })[doc[1]] || 'Used Claude Docs';
        return `Used ${name || 'a tool'}`;
      }
    }
  }

  // How long Claude thought, in whole seconds (at least 1), from the block's timestamps, or null.
  function thinkingSeconds(b) {
    const start = Date.parse(b.start_timestamp), stop = Date.parse(b.stop_timestamp);
    return Number.isFinite(start) && Number.isFinite(stop) && stop >= start ? Math.max(1, Math.round((stop - start) / 1000)) : null;
  }

  // claude.ai's product cards from a display tool's input, each with the images its result found
  // (ids product_<n>_<m>; href the saved copy, ctx.webImages): { kind, summary, products: [{ name, price,
  // blurb, attributes: [{ label, value }], images: [{ href, source, title }] }] }. kind: carousel, featured
  // or comparison.
  function displayData(name, input, content, c) {
    const i = input && typeof input === 'object' ? input : {};
    const kind = /product_carousel/.test(name) ? 'carousel' : /featured_card/.test(name) ? 'featured' : /comparison_card/.test(name) ? 'comparison' : 'cards';
    const saved = c.webImages && typeof c.webImages === 'object' ? c.webImages : {};
    const byProduct = new Map();
    for (const part of Array.isArray(content) ? content : []) {
      for (const img of (part && Array.isArray(part.images) ? part.images : [])) {
        const m = img && /^product_(\d+)_/.exec(String(img.id || ''));
        if (!m) continue;
        const url = /^https:\/\//i.test(String(img.url || '')) ? String(img.url) : '';
        const file = url && Object.prototype.hasOwnProperty.call(saved, url) ? saved[url] : null;
        if (!byProduct.has(m[1])) byProduct.set(m[1], []);
        byProduct.get(m[1]).push({ href: file ? relHref(c.folder || '', file) : null, source: String(img.source || ''), title: String(img.title || '') });
      }
    }
    const text = v => (typeof v === 'string' ? v : '');
    const products = (Array.isArray(i.products) ? i.products : []).filter(p => p && typeof p === 'object').map((p, n) => ({
      name: text(p.name), price: text(p.price), blurb: text(p.blurb),
      attributes: (Array.isArray(p.attributes) ? p.attributes : []).filter(a => a && typeof a === 'object').map(a => ({ label: text(a.label), value: text(a.value) })),
      images: byProduct.get(String(n)) || [],
    }));
    return { kind, summary: text(i.summary), products };
  }

  // The page a publish_files call put on claude.ai, from its reply's JSON: { title, url }, or null.
  function publishedPage(content) {
    const text = (Array.isArray(content) ? content : []).filter(p => p && p.type === 'text').map(p => String(p.text || '')).join('\n').trim();
    if (!text.startsWith('{')) return null;
    for (let end = text.indexOf('}'); end > 0; end = text.indexOf('}', end + 1)) {
      try {
        const reply = JSON.parse(text.slice(0, end + 1));
        return reply && /^https:\/\/claude\.ai\//.test(String(reply.url || '')) ? { title: String(reply.title || ''), url: String(reply.url) } : null;
      } catch (e) { /* not the end of the object yet */ }
    }
    return null;
  }

  // The host of an http(s) address, without www., or ''.
  function hostOf(url) {
    const m = /^https?:\/\/([^/?#\s]+)/i.exec(String(url || ''));
    return m ? m[1].replace(/^www\./i, '').toLowerCase() : '';
  }

  // Grey text after a step's label, as claude.ai shows a search's query, or ''.
  function toolDetail(name, input) {
    const i = input && typeof input === 'object' ? input : {};
    return String(name) === 'web_search' && typeof i.query === 'string' ? i.query : '';
  }

  // The web address a step read, shown as a link after its label, or ''.
  function toolLink(name, input) {
    const url = input && typeof input === 'object' ? String(input.url || '') : '';
    return /^(web_fetch)$/.test(String(name)) && /^https?:\/\/\S+$/i.test(url) ? url : '';
  }

  // The file name a step's label ends with, which claude.ai shows darker, or ''.
  function toolTarget(name, input) {
    const i = input && typeof input === 'object' ? input : {};
    const p = i.path || i.file_path || '';
    return p && /^(create_file|Write|str_replace|Edit|str_replace_based_edit_tool|view|read_file|Read)$/.test(String(name)) ? baseName(p) : '';
  }

  // The images an image_search result showed: { title, page, source, href }, href the saved copy under
  // images/ (ctx.webImages: image URL -> 'images/<name>') or null. page is an https link or ''.
  function webImages(content, c) {
    const saved = c.webImages && typeof c.webImages === 'object' ? c.webImages : {};
    const https = u => (typeof u === 'string' && /^https:\/\//i.test(u) ? u : '');
    const out = [];
    for (const part of Array.isArray(content) ? content : []) {
      for (const img of (part && Array.isArray(part.images) ? part.images : [])) {
        if (!img || typeof img !== 'object') continue;
        const url = https(img.url);
        const file = url && Object.prototype.hasOwnProperty.call(saved, url) ? saved[url] : null;
        out.push({ title: String(img.title || ''), page: https(img.page_url), source: String(img.source || ''), href: file ? relHref(c.folder || '', file) : null });
      }
    }
    return out;
  }

  // A result's text, and its images: inline base64 ones as data URIs, and ones claude.ai only links
  // (file_uuid, preview_url) as their saved copy under images/ (ctx.toolImages: file uuid -> path).
  function resultParts(content, c = {}) {
    const items = Array.isArray(content) ? content : (typeof content === 'string' ? [{ type: 'text', text: content }] : []);
    const savedImages = c.toolImages && typeof c.toolImages === 'object' ? c.toolImages : {};
    const texts = [];
    const images = [];
    let imageItems = 0;
    for (const it of items) {
      if (!it || typeof it !== 'object') continue;
      if (it.type === 'image') imageItems++;
      if (it.type === 'text' && typeof it.text === 'string') texts.push(it.text);
      else if (it.type === 'image' && it.source && it.source.type === 'base64' &&
               SAFE_IMAGE.test(String(it.source.media_type)) && /^[A-Za-z0-9+/=\s]*$/.test(String(it.source.data))) {
        images.push(`data:${it.source.media_type};base64,${it.source.data}`);
      } else if (it.type === 'image' && typeof it.file_uuid === 'string' && Object.prototype.hasOwnProperty.call(savedImages, it.file_uuid)) {
        const href = relHref(c.folder || '', savedImages[it.file_uuid]);
        if (href) images.push(href);
      }
    }
    return { text: cut(texts.join('\n')), images, missingImages: imageItems - images.length };
  }

  // The name claude.ai puts on a citation's pill: the site's name from its metadata, or '' when the
  // chat gives none (the viewer then shows the citation's number).
  function citeSite(c) {
    const m = c.metadata && typeof c.metadata === 'object' ? c.metadata : {};
    const src = Array.isArray(c.sources) && c.sources[0] && typeof c.sources[0] === 'object' ? c.sources[0] : {};
    return String(m.site_name || src.source || '');
  }

  function buildCites(citations) {
    if (!Array.isArray(citations)) return [];
    return citations
      .filter(c => c && /^https?:\/\//i.test(String(c.url)))
      .map(c => ({ end: c.end_index, url: String(c.url), title: c.title || 'Source', site: citeSite(c) }))
      .sort((a, b) => a.end - b.end);
  }

  // Every step's summary, oldest first. claude.ai often sends only these, with the
  // thinking text itself empty and thinking_hidden set.
  function thinkingSummaries(block) {
    const list = Array.isArray(block.summaries) ? block.summaries : [];
    return list.map(s => (s && typeof s.summary === 'string' ? s.summary.trim() : '')).filter(Boolean);
  }

  // Same rule as getThinkingSummary in popup.js.
  function thinkingSummary(block) {
    const s = (Array.isArray(block.summaries) ? block.summaries : []).filter(Boolean);
    if (s.length && s[s.length - 1].summary) return s[s.length - 1].summary;
    const first = String(block.thinking || '').split('\n')[0];
    return first.length > 80 ? first.substring(0, 77) + '...' : first;
  }

  const KIND_BY_EXT = {
    html: 'html', htm: 'html', svg: 'svg', md: 'md', png: 'image', jpg: 'image', jpeg: 'image', gif: 'image',
    webp: 'image', pdf: 'pdf', jsx: 'react', tsx: 'react', mmd: 'mermaid'
  };
  const KIND_BY_MIME = { 'application/vnd.ant.react': 'react', 'application/vnd.ant.mermaid': 'mermaid' };

  function baseName(p) { return String(p || '').split('/').pop(); }

  // mime (artifacts tool type) wins; then the extension; otherwise text is code and no text is binary.
  function kindFor(filename, mime, hasText) {
    if (mime && KIND_BY_MIME[mime]) return KIND_BY_MIME[mime];
    const dot = filename.lastIndexOf('.');
    const ext = dot > 0 ? filename.slice(dot + 1).toLowerCase() : '';
    if (Object.prototype.hasOwnProperty.call(KIND_BY_EXT, ext)) return KIND_BY_EXT[ext];
    return hasText ? 'code' : 'binary';
  }

  // A function of export-core.js: a global where export-core.js is loaded first, else required (Node).
  function core(name) {
    if (typeof root[name] === 'function') return root[name];
    return require('./export-core.js')[name];
  }
  function coreVersionAsOf() { return core('versionAsOf'); }
  // A publish call: publish_files, or the Artifact tool publishing a file.
  const isPublishCall = (name, input) => /(^|__|:)publish_files$/.test(String(name || '')) || core('isArtifactPublish')(name, input);

  const missingFile = name => ({ name, kind: 'missing', versions: [{ label: '', text: null, href: null }] });

  // A PublishedEntry (ctx.published) as its card's GenFile: { versions (sorted by order), build() -> GenFile }, or null
  // with no versions. hrefOf(name): a written file's link (a same version's).
  function publishedFile(entry, folder, hrefOf) {
    const versions = (Array.isArray(entry.versions) ? entry.versions : []).filter(Boolean)
      .map((v, i) => ({ v, i })).sort((a, b) => (Number(a.v.order) || 0) - (Number(b.v.order) || 0) || a.i - b.i).map(x => x.v);
    if (!versions.length) return null;
    const pageDir = joinPath(folder, entry.dir);
    const build = () => {
      const out = versions.map(v => {
        const text = typeof v.text === 'string' ? v.text : null;
        let href = null;
        if (v.same && v.writtenAs) href = hrefOf(v.writtenAs);
        else if (v.startSaved && pageDir !== null) href = relHref(pageDir, v.folderName, v.startSaved);
        // A session's version previews from the artifact step's part (sessionPublished); a chat's entries have no part.
        const part = Number.isSafeInteger(v.part) && v.part > 0 && typeof v.key === 'string' && v.key
          ? { part: v.part, key: v.key, ...(typeof v.start === 'string' && v.start ? { start: v.start } : {}) } : {};
        return { label: String(v.label || ''), text, href, same: !!v.same, ...(typeof v.ver === 'string' && v.ver ? { ver: v.ver } : {}), ...part };
      });
      const named = versions.map(v => v.startSaved || v.writtenAs).find(Boolean) || '';
      const hasText = out.some(v => v.text !== null || v.part != null);
      const kind = out.some(v => v.text !== null || v.href !== null) ? kindFor(String(named), null, hasText) : 'missing';
      return {
        name: String(entry.title || 'Published page'), kind,
        published: { url: String(entry.url || ''), current: !!entry.current, needsRuntime: versions.some(v => !!v.needsRuntime) },
        versions: out,
      };
    };
    return { versions, build };
  }

  // Cards for the files each message made. Mutates the blocks of `messages` and returns the GenFile map.
  function addCards(source, messages, blockOf, leafId, c) {
    const index = c.artifactIndex || {};
    const arts = c.artifacts || {};
    const deliveries = c.deliveries || {};
    const folder = c.folder || '';
    const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
    const textOf = fn => (hasOwn(arts, fn) && typeof arts[fn] === 'string' && arts[fn] !== '' ? arts[fn] : null);
    const hrefOf = fn => relHref(folder, 'artefacts', fn);
    // madeAt: the message that made the file's last version, for files Claude made (the viewer's In chats order).
    const entryFile = (name, fns, mime, madeAt) => {
      fns = Array.from(fns);
      const versions = fns.map((fn, i) => ({ label: fns.length > 1 ? 'v' + (i + 1) : '', text: textOf(fn), href: hrefOf(fn) }));
      return { name, kind: kindFor(name, mime, versions.some(v => v.text !== null)), versions, ...(typeof madeAt === 'string' && madeAt ? { madeAt } : {}) };
    };
    const madeBy = entry => (entry && Array.isArray(entry.messages) ? entry.messages[entry.messages.length - 1] : undefined);

    // The active chain, resolved like getMessageChain: no usable leaf means every message.
    const byUuid = new Map(source.map(m => [m.uuid, m]));
    const chain = [];
    const leaf = leafId ? byUuid.get(leafId) : null;
    if (leaf) {
      for (let m = leaf, seen = new Set(); m && !seen.has(m.uuid); m = byUuid.get(m.parent_message_uuid)) { seen.add(m.uuid); chain.push(m); }
      chain.reverse();
    } else {
      chain.push(...source);
    }
    const pos = new Map(chain.map((m, i) => [m.uuid, i]));
    // Position of a message on the chain, or of its nearest ancestor on it; null when it has none.
    const effectivePos = id => {
      for (let m = byUuid.get(id), seen = new Set(); m && !seen.has(m.uuid); m = byUuid.get(m.parent_message_uuid)) {
        seen.add(m.uuid);
        if (pos.has(m.uuid)) return pos.get(m.uuid);
      }
      return null;
    };
    // versionAsOf from export-core.js: the version of entry as of a message on chain (null: the last).
    const versionAsOf = coreVersionAsOf();

    // Same rule as failedToolUseIds in export-core.js.
    const failed = new Set();
    const resultOf = new Map();
    for (const m of source) for (const b of Array.isArray(m.content) ? m.content : []) {
      if (b && b.type === 'tool_result' && b.tool_use_id != null) {
        resultOf.set(b.tool_use_id, b);
        if (b.is_error) failed.add(b.tool_use_id);
      }
    }
    const isBash = n => n === 'bash_tool' || n === 'Bash';
    const heredocs = command => (typeof c.heredocs === 'function' ? c.heredocs(String(command || '')) : []) || [];
    // claudeDocKey from export-core.js: the 'doc:<node id>' a Claude Docs call writes to, or null.
    const docKeyOf = (block, result) => (typeof c.docKey === 'function' ? c.docKey(block, result) : null);
    // widgetFile and widgetKey from export-core.js: the file a show_widget call draws, and its state key.
    const widgetOf = block => (typeof c.widgetFile === 'function' && typeof c.widgetKey === 'function' && /(^|__|:)show_widget$/.test(String(block.name || ''))
      ? c.widgetFile(block.input) : null);

    // Every delivered version of a path, in chain order, for the uuids the caller knows.
    const deliveredUuids = new Map();
    const deliveredAt = new Map(); // file uuid -> the message that delivered it
    for (const m of chain) for (const b of Array.isArray(m.content) ? m.content : []) {
      for (const d of (b && Array.isArray(b.file_deliveries) ? b.file_deliveries : [])) {
        if (!d || !d.file_uuid || !d.path || !hasOwn(deliveries, d.file_uuid)) continue;
        if (!deliveredUuids.has(d.path)) deliveredUuids.set(d.path, []);
        if (!deliveredUuids.get(d.path).includes(d.file_uuid)) deliveredUuids.get(d.path).push(d.file_uuid);
        if (!deliveredAt.has(d.file_uuid)) deliveredAt.set(d.file_uuid, m.uuid);
      }
    }

    const files = {};
    const ids = new Map();
    let counter = 0;
    // Files Claude shared, as claude.ai's own Outputs list has them: sent, presented, saved under
    // /mnt/user-data/outputs, or made with the artifacts tool. The rest are working files.
    const sharedKeys = new Set();
    // Off-branch keys are 'x:<message>:<key>', and count by the key they wrap.
    const isShared = key => /^(x:[^:]*:)?(artifact:|doc:|widget:|deliver:|name:|missing:|published:)/.test(key) || /(^|:)\/mnt\/user-data\/outputs\//.test(key);
    // Off the active branch: the last off-branch file at each path, for a present_files there.
    const offBranch = new Map(); // path -> { key, build }

    // Published pages: each publish_files call, by its tool_use id, to its page and the version it made.
    const pageOf = new Map(); // toolUseId -> { key, build, version }, version an index in the page's sorted versions
    for (const entry of Array.isArray(c.published) ? c.published : []) {
      if (!entry || typeof entry.uuid !== 'string') continue;
      const page = publishedFile(entry, folder, hrefOf);
      if (!page) continue;
      const { versions, build } = page;
      versions.forEach((v, i) => {
        for (const p of Array.isArray(v.publishes) ? v.publishes : []) {
          if (p && p.toolUseId != null) pageOf.set(p.toolUseId, { key: 'published:' + entry.uuid, build, version: i, same: !!v.same, writtenAs: v.writtenAs ? String(v.writtenAs) : '' });
        }
      });
    }
    // The names of the files Claude wrote that a publish published (their sandbox paths), from the call itself.
    const sourceNames = input => (Array.isArray(input.files) ? input.files : typeof input.file_path === 'string' ? [{ path: input.file_path }] : [])
      .filter(f => f && typeof f === 'object').map(f => baseName(f.path)).filter(n => typeof n === 'string' && n);

    source.forEach((m, mi) => {
      const message = messages[mi];
      const pageSources = new Set();
      const active = pos.has(m.uuid);
      const touches = new Map(); // fileKey -> { after, build, version }; the last block touching a file wins
      const touch = (after, fileKey, build, version) => { touches.delete(fileKey); touches.set(fileKey, { after, build, version }); };
      const offKey = (k, build) => { if (k.startsWith('x:')) offBranch.set(k.slice(k.indexOf(':', 2) + 1), { key: k, build }); };
      const contentKey = (after, k, name, text, mime) => {
        const build = () => ({ name, kind: kindFor(name, mime, true), versions: [{ label: '', text, href: null }], madeAt: m.uuid });
        offKey(k, build);
        touch(after, k, build, 0);
      };
      const missingKey = (after, k, name) => { const build = () => missingFile(name); offKey(k, build); touch(after, k, build, 0); };

      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (!b || b.type !== 'tool_use') continue;
        const after = blockOf.get(b);
        if (!after) continue;
        const input = b.input && typeof b.input === 'object' ? b.input : {};
        const bash = isBash(b.name);
        if (failed.has(b.id) && !bash) continue;

        // Keys in artifactIndex are extractArtifacts' state keys.
        // A publish that savePublishedPages saw: its page's card, which carries the claude.ai link.
        if (pageOf.has(b.id) && isPublishCall(b.name, input)) {
          const page = pageOf.get(b.id);
          touch(after, page.key, page.build, page.version);
          sharedKeys.add(page.key);
          delete after.published;
          // Only a version the same as the written file makes claude.ai's attached copy a duplicate; otherwise the
          // attachment is Claude's own file, which differs from the page, and stays listed.
          if (page.same) for (const n of [...sourceNames(input), page.writtenAs]) if (n) pageSources.add(n);
          continue;
        }

        let key = null, mime = null, name = null, text = null, edit = false;
        if (b.name === 'create_file') { key = input.path; text = input.file_text; }
        else if (b.name === 'Write') { key = input.file_path; text = input.content; }
        else if (b.name === 'rewrite' || b.name === 'create_or_overwrite') { key = input.path; text = input.file_text || input.content; }
        else if (b.name === 'str_replace' || b.name === 'Edit') { key = b.name === 'Edit' ? input.file_path : input.path; edit = true; }
        else if (widgetOf(b)) { const f = widgetOf(b); key = c.widgetKey(input, b.id); name = f.name; text = f.text; } // show_widget: a diagram file
        else if (docKeyOf(b, resultOf.get(b.id))) { key = docKeyOf(b, resultOf.get(b.id)); edit = true; } // rebuilt by extractArtifacts
        else if (b.name === 'artifacts' && ['create', 'update', 'rewrite'].includes(input.command) && (input.id || input.title)) {
          key = 'artifact:' + (input.id || input.title); mime = input.type || null; name = String(input.title || input.id);
          if (input.content) text = input.content;
          else if (input.command === 'update' && typeof input.old_str === 'string') edit = true; // replayed by extractArtifacts
          else key = null;
        }

        if (key && (edit || text)) {
          if (active) {
            const entry = hasOwn(index, key) ? index[key] : null;
            const v = entry ? versionAsOf(entry, chain, m.uuid) : -1;
            if (entry && v >= 0) touch(after, key, () => entryFile(entry.filename, entry.versions, mime, madeBy(entry)), v);
          } else if (edit) {
            missingKey(after, 'x:' + m.uuid + ':' + key, baseName(key));
          } else {
            contentKey(after, 'x:' + m.uuid + ':' + key, name || baseName(key), String(text), mime);
          }
        } else if (bash) {
          for (const { path: p, text: body } of heredocs(input.command)) {
            if (active) {
              const entry = hasOwn(index, p) ? index[p] : null;
              const v = entry ? versionAsOf(entry, chain, m.uuid) : -1;
              if (entry && v >= 0) touch(after, p, () => entryFile(entry.filename, entry.versions, null, madeBy(entry)), v);
            } else if (body) {
              contentKey(after, 'x:' + m.uuid + ':' + p, baseName(p), String(body), null);
            }
          }
        } else if (b.name === 'present_files') {
          const paths = Array.isArray(input.filepaths) ? input.filepaths : (Array.isArray(input.paths) ? input.paths : []);
          const where = effectivePos(m.uuid);
          const whereId = where == null ? null : chain[where].uuid;
          for (const p of paths) {
            if (typeof p !== 'string' || !p) continue;
            const base = baseName(p);
            // Off the active branch, a file that branch made is the one presented, not the active copy.
            const off = active ? null : offBranch.get(p);
            if (off) {
              sharedKeys.add(off.key);
              touch(after, off.key, off.build, 0);
              continue;
            }
            let entry = hasOwn(index, p) ? index[p] : null;
            if (!entry) entry = Object.values(index).find(e => e && e.filename === base) || null;
            if (entry) {
              const v = Math.max(versionAsOf(entry, chain, whereId), 0);
              sharedKeys.add(entry.path);
              touch(after, entry.path, () => entryFile(entry.filename, entry.versions, null, madeBy(entry)), v);
            } else if (hasOwn(arts, base)) {
              touch(after, 'name:' + base, () => entryFile(base, [base], null), 0);
            } else {
              touch(after, 'missing:' + p, () => missingFile(base), 0);
            }
          }
        } else if (b.name === 'SendUserFile') {
          const r = resultOf.get(b.id);
          for (const d of (r && Array.isArray(r.file_deliveries) ? r.file_deliveries : [])) {
            if (!d || !d.path) continue;
            // Off the active branch, or not saved: the file isn't in this export.
            if (!active || !hasOwn(deliveries, d.file_uuid)) {
              sharedKeys.add('x:' + m.uuid + ':' + d.path);
              missingKey(after, 'x:' + m.uuid + ':' + d.path, baseName(d.path));
              continue;
            }
            // A file Claude wrote with a file tool and then sent is that file, listed once as an output.
            const written = hasOwn(index, d.path) ? index[d.path] : null;
            if (written) {
              sharedKeys.add(written.path);
              touch(after, written.path, () => entryFile(written.filename, written.versions, null, madeBy(written)), Math.max(versionAsOf(written, chain, m.uuid), 0));
              continue;
            }
            const uuids = deliveredUuids.get(d.path) || [];
            const v = uuids.indexOf(d.file_uuid);
            if (v < 0) continue;
            touch(after, 'deliver:' + d.path, () => {
              const fns = uuids.map(u => deliveries[u].filename || baseName(d.path));
              // Several copies are named <base>_v1<ext> ...; the file itself is <base><ext>.
              const name = fns.length > 1 ? fns[0].replace(/_v1(?=(\.[^./]*)?$)/, '') : fns[0];
              return entryFile(name, fns, null, deliveredAt.get(uuids[uuids.length - 1]));
            }, v);
          }
        }
      }

      // The copy of a published page claude.ai attached to the message is the card's page: not listed again.
      if (pageSources.size && Array.isArray(message.uploads)) message.uploads = message.uploads.filter(u => !pageSources.has(u.name));
      if (!touches.size) return;
      const out = [];
      for (const block of message.blocks) {
        out.push(block);
        for (const [fileKey, t] of touches) {
          if (t.after !== block) continue;
          if (!ids.has(fileKey)) {
            const id = 'a' + (++counter);
            ids.set(fileKey, id);
            files[id] = t.build();
            // A diagram claude.ai drew in the chat (show_widget): the viewer shows it inline.
            if (/^(x:[^:]*:)?widget:/.test(fileKey)) files[id].widget = true;
          }
          out.push({ t: 'card', file: ids.get(fileKey), version: t.version });
        }
      }
      message.blocks = out;
    });
    for (const [fileKey, id] of ids) files[id].shared = sharedKeys.has(fileKey) || isShared(fileKey);
    // file key ('doc:<node id>', 'published:<uuid>', ...) to file id; not enumerable, so it never reaches the data.
    Object.defineProperty(files, 'fileKeys', { value: ids, enumerable: false });
    return files;
  }

  // files and files_v2 both list uploads. One with no UUID is keyed by its message and name, the name
  // taken as extractUploadedFiles takes it (files: the path's name first; files_v2: file_name), so this
  // matches viewerUploadKey in export-core.js. Once per key per message.
  function buildUploads(m, c) {
    const known = c.uploads || {};
    const seen = new Set();
    const out = [];
    const list = v => (Array.isArray(v) ? v : []).filter(Boolean);
    const entries = [...list(m.files).map(f => [f, f.path ? baseName(f.path) : f.file_name]), ...list(m.files_v2).map(f => [f, f.file_name])];
    for (const [f, keyName] of entries) {
      const name = f.file_name || baseName(f.path);
      const key = f.file_uuid || (keyName ? `${m.uuid || ''}\n${keyName}` : '');
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const hit = Object.prototype.hasOwnProperty.call(known, key) ? known[key] : null;
      out.push({
        name,
        href: hit && hit.path ? relHref(c.folder, hit.path) : null,
        text: hit && typeof hit.text === 'string' ? hit.text : null
      });
    }
    return out;
  }

  function buildProject(p, folder) {
    if (!p) return null;
    const dir = joinPath(folder, p.fileDir);
    const extra = {};
    for (const k of ['id', 'description', 'updated']) if (typeof p[k] === 'string') extra[k] = p[k];
    return {
      name: p.name || '',
      ...extra,
      files: (Array.isArray(p.fileNames) ? p.fileNames : []).map(name => ({ name, href: relHref(dir, name) })),
      instructions: typeof p.instructions === 'string' ? p.instructions : '',
      docs: (Array.isArray(p.docs) ? p.docs : []).filter(Boolean).map(d => ({ name: d.name || '', text: String(d.text == null ? '' : d.text) }))
    };
  }

  function buildViewerChat(data, ctx) {
    const c = ctx || {};
    const fix = typeof c.fixText === 'function' ? c.fixText : (s => s);
    const source = (Array.isArray(data.chat_messages) ? data.chat_messages : []).filter(Boolean);

    // tool_use_id -> tool block, across every message, so a result can land in an earlier message's block.
    const toolById = new Map();
    const toolInputs = new Map(); // tool_use_id -> the call's input, uncut
    const blockOf = new Map(); // raw tool_use block -> its viewer block
    const messages = source.map(m => {
      const blocks = [];
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (!b) continue;
        if (b.type === 'text') blocks.push({ t: 'text', text: String(b.text || ''), cites: buildCites(b.citations) });
        else if (b.type === 'thinking') blocks.push({ t: 'thinking', text: String(b.thinking || ''), summaries: thinkingSummaries(b), summary: thinkingSummary(b), seconds: thinkingSeconds(b) });
        else if (b.type === 'image' && c.sessionImages === true) {
          // A picture in a session's message, shown from its saved copy (ctx.toolImages); never inline data.
          // Only for sessions (buildViewerSession sets the flag), so a chat's viewer data stays as it was.
          const saved = c.toolImages && typeof c.toolImages === 'object' ? c.toolImages : {};
          const href = typeof b.file_uuid === 'string' && Object.prototype.hasOwnProperty.call(saved, b.file_uuid) ? relHref(c.folder || '', saved[b.file_uuid]) : null;
          blocks.push({ t: 'image', href });
        } else if (b.type === 'tool_use') {
          const input = compactInput(b.input);
          const tool = { t: 'tool', name: b.name || '', label: toolLabel(b.name, b.input), target: toolTarget(b.name, b.input), link: toolLink(b.name, b.input), detail: toolDetail(b.name, b.input), input, result: '', error: false, images: [], missingImages: 0 };
          blocks.push(tool);
          blockOf.set(b, tool);
          if (b.id != null) { toolById.set(b.id, tool); toolInputs.set(b.id, b.input); }
        }
      }
      return {
        id: m.uuid, parent: m.parent_message_uuid || null, sender: m.sender, at: m.created_at,
        ...(typeof m.labelled === 'string' && m.labelled ? { labelled: m.labelled } : {}),
        blocks, uploads: buildUploads(m, c),
        attachments: (Array.isArray(m.attachments) ? m.attachments : []).filter(Boolean).map(a => ({ name: a.file_name || '', text: fix(a.extracted_content || '') }))
      };
    });

    // Second pass: results may precede nothing, follow in the same message, or arrive in a later one.
    for (const m of source) {
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (!b || b.type !== 'tool_result') continue;
        const tool = toolById.get(b.tool_use_id);
        if (!tool) continue;
        const { text, images, missingImages } = resultParts(b.content, c);
        tool.result = text;
        tool.images = images;
        tool.missingImages = missingImages;
        tool.error = !!b.is_error;
        if (/(^|__|:)image_search$/.test(String(b.name || tool.name))) tool.web = webImages(b.content, c);
        if (/(^|__|:)publish_files$/.test(String(b.name || tool.name))) tool.published = publishedPage(b.content);
        else if (core('isArtifactPublish')(tool.name, toolInputs.get(b.tool_use_id))) {
          const reply = core('publishedReply')(tool.name, b);
          // The reply names no title: the published file's name stands in.
          if (reply) { tool.published = { title: reply.title || baseName(toolInputs.get(b.tool_use_id).file_path), url: reply.url }; tool.output = true; }
        }
        if (/_display_v\d+$/.test(String(tool.name))) tool.display = displayData(tool.name, toolInputs.get(b.tool_use_id), b.content, c);
      }
    }

    const files = addCards(source, messages, blockOf, data.current_leaf_message_uuid, c);
    const flags = c.flags && typeof c.flags === 'object' ? c.flags : {};
    for (const f of Object.values(files)) if (f && Object.prototype.hasOwnProperty.call(flags, f.name)) f.flag = String(flags[f.name]);

    const chat = {
      id: data.uuid, title: data.name || '', model: c.model || data.model || '',
      created: data.created_at, updated: data.updated_at, leaf: data.current_leaf_message_uuid || null,
      messages, files, project: buildProject(c.project, c.folder)
    };
    // A chat claude.ai made when an artifact was opened: that artifact's uuid (buildViewerData opens it).
    const startedWith = core('startedWithArtifact')(data);
    if (startedWith) chat.startedWith = startedWith;
    // For buildViewerData, which joins chats and artifacts; not enumerable, so the chat's own data is unchanged.
    let links = [];
    try { links = core('artifactLinksOf')({ chat_messages: source }); } catch (e) { /* odd data links nothing */ }
    Object.defineProperty(chat, 'links', { value: links, enumerable: false });
    // tool_use id -> its tool block, for buildViewerSession (a subagent's messages go under their Agent step).
    Object.defineProperty(chat, 'toolBlocks', { value: toolById, enumerable: false });
    return chat;
  }

  // ---- Claude Code and Cowork sessions ----
  // A session's kept events (session-core.js, images as files by export-core.js's sessionImages) as the viewer's
  // compact Chat, drawn by the chat renderer. One flat branch: a prompt (a user event that is not only tool results)
  // is a human message; the assistant events after it, with the tool results between them, are one reply. A prompt
  // promptKind labels (compaction, command, command-output) gets labelled on its message. Events with a
  // parent_tool_use_id (a subagent's) go, as their own messages, into children of that Agent step's tool block.
  // Tool results are cut at SESSION_RESULT_LIMIT characters; images resolve to files under folder by relative path.
  const SESSION_RESULT_LIMIT = 2048;
  const SESSION_RESULT_MORE = '\n[… full output in session.json]';
  const SESSION_STUB_TEXT = '[event too large to keep]';
  const SESSION_INPUT_MORE = '\n[… full input in session.json]';

  // A string cut at SESSION_RESULT_LIMIT characters, never inside a surrogate pair, with more after it.
  function sessionCut(text, more) {
    if (text.length <= SESSION_RESULT_LIMIT) return text;
    let end = SESSION_RESULT_LIMIT;
    const last = text.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end--;
    return text.slice(0, end) + more;
  }

  // A tool call's input with every string in it, nested too, cut for the viewer: a Write's whole file stays in session.json.
  function cutInput(v, depth = 0) {
    if (typeof v === 'string') return sessionCut(v, SESSION_INPUT_MORE);
    if (!v || typeof v !== 'object' || depth > 50) return v;
    if (Array.isArray(v)) return v.map(x => cutInput(x, depth + 1));
    const out = {};
    for (const k of Object.keys(v)) out[k] = cutInput(v[k], depth + 1);
    return out;
  }

  function sessionLabelText(kind, text) {
    if (kind === 'command') {
      const tag = name => { const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text); return m ? m[1].trim() : ''; };
      const name = tag('command-name');
      const args = tag('command-args');
      return `Ran ${name}${args ? ' ' + args : ''}`.trim();
    }
    if (kind === 'command-output') return text.replace(/<\/?local-command-stdout>/g, '').trim();
    return text;
  }

  // The pages a session published (publishedPagesOf over its messages: Artifact and publish_files calls), as
  // ctx.published, from the export's artifacts store: artifacts { views, records } as buildViewerData takes them.
  // Each version a publish names that the store's record has links its saved start file (relative to the export
  // root, reached from folder by '..'), with no text: its preview is the artifact step's part, the view's for the
  // current version and versionPlaces' for an older one (part, key, start), and only for a text start file. A page
  // or version the store hasn't got has nothing to link, so its card shows the claude.ai link only.
  function sessionPublished(pages, artifacts, folder) {
    const records = artifacts && Array.isArray(artifacts.records) ? artifacts.records.filter(r => r && typeof r === 'object' && typeof r.uuid === 'string') : [];
    const views = artifacts && Array.isArray(artifacts.views) ? artifacts.views.filter(v => v && typeof v === 'object') : [];
    const recOf = new Map(records.map(r => [r.uuid.toLowerCase(), r]));
    const up = String(folder || '').split('/').filter(Boolean).map(() => '..').join('/');
    const previewKind = core('previewKind');
    const byUuid = new Map();
    for (const p of pages) {
      if (!byUuid.has(p.uuid)) byUuid.set(p.uuid, []);
      byUuid.get(p.uuid).push(p);
    }
    const entries = [];
    for (const [uuid, group] of byUuid) {
      const rec = recOf.get(uuid) || null;
      const shortId = (rec && typeof rec.shortId === 'string' && rec.shortId) || group[0].shortId || core('uuidToBase58')(uuid) || '';
      const view = views.find(v => String(v.id) === shortId || String(v.id).toLowerCase() === uuid) || null;
      const known = rec ? recordVersions(rec, new Map()) : [];
      // One version per resolved id: a publish naming no version stands for the record's current one, which an
      // explicit publish of it may name too. Versions not in the store follow, in publish order, the current one last.
      const byVer = new Map();
      group.forEach((p, i) => {
        const ver = p.ver || (rec && typeof rec.current === 'string' ? rec.current : '');
        const rv = ver ? known.find(x => x.ver === ver) || null : null;
        if (byVer.has(ver)) { byVer.get(ver).publishes.push(...p.publishes); return; }
        byVer.set(ver, { p, rv, ver, publishes: p.publishes.slice(), order: rv ? known.indexOf(rv) : known.length + i + (p.current ? group.length : 0) });
      });
      const versions = [...byVer.values()].map(({ rv, ver, publishes: list, order }) => {
        const publishes = list.map(x => ({ ...x }));
        if (!rv || !rv.startSaved) {
          return { ver, folderName: '', label: rv ? rv.label : ver || 'current', order,
            start: null, startSaved: null, same: false, writtenAs: null, incomplete: true, needsRuntime: false, text: null, publishes };
        }
        const own = rv.part != null ? { part: rv.part, key: rv.key } : rv.current && view && Number.isSafeInteger(view.part) && view.part > 0 && typeof view.key === 'string' ? { part: view.part, key: view.key } : null;
        const preview = own && rv.start && previewKind(rv.start) === 'text' ? { ...own, start: rv.start } : {};
        return { ver: rv.ver, folderName: rv.folder || '', label: rv.label, order, start: rv.start, startSaved: rv.startSaved, same: false,
          writtenAs: null, incomplete: false, needsRuntime: rv.current ? !!rec.needsRuntime : false, text: null, publishes, ...preview };
      });
      entries.push({ uuid, shortId, title: (rec && typeof rec.title === 'string' && rec.title) || String(group[0].title || ''),
        url: shortId ? `https://claude.ai/artifact/${shortId}` : String(group[0].url || ''), current: group.some(p => p.current), dir: up, versions,
        // As buildViewerData links a chat's card: listed by its record, or by the view when there is no record.
        ...(view && (rec ? rec.listed === true : view.listed !== false) ? { view: String(view.id) } : {}) });
    }
    return entries;
  }

  // The artifact an empty chat was opened from (buildViewerData): { opened: { title, file?, version? }, id?, file? }, or
  // null when the export knows nothing of it. The file is a published page's GenFile built as a session's card is
  // (sessionPublished), with each version the record saved; paths from the export root.
  function openedArtifact(uuid, views, records) {
    const rec = records.find(r => r.uuid.toLowerCase() === uuid) || null;
    let short = '';
    try { short = core('uuidToBase58')(uuid) || ''; } catch (e) { /* the uuid itself may be the id */ }
    const view = views.find(v => String(v.id) === short || String(v.id).toLowerCase() === uuid) || null;
    const title = (rec && typeof rec.title === 'string' && rec.title) || (view && typeof view.title === 'string' && view.title) || '';
    const known = rec ? recordVersions(rec, new Map()).filter(v => v.startSaved) : [];
    if (!known.length) return title ? { opened: { title } } : null;
    const pages = known.map(v => ({ uuid, shortId: short, ver: v.ver, current: false, title, url: '', publishes: [] }));
    const entry = sessionPublished(pages, { views, records: [rec] }, '')[0];
    const page = entry && publishedFile(entry, '', () => null);
    if (!page) return title ? { opened: { title } } : null;
    const file = { ...page.build(), shared: true, ...(entry.view ? { artifact: entry.view } : {}) };
    const at = page.versions.findIndex(v => v.ver === rec.current);
    const id = 'o1';
    return { id, file, opened: { title: title || null, file: id, version: at >= 0 ? at : page.versions.length - 1 } };
  }

  function buildViewerSession(session, events, opts = {}) {
    const s = session && typeof session === 'object' ? session : {};
    const folder = typeof opts.folder === 'string' ? opts.folder : '';
    const cfg = s.config && typeof s.config === 'object' ? s.config : {};
    const title = typeof s.title === 'string' && s.title.trim() ? s.title : 'Untitled session';
    const toolImages = {};
    let imageCount = 0;
    const image = b => {
      if (typeof b.file !== 'string' || !b.file) return { type: 'image' };
      const id = `img-${++imageCount}`;
      toolImages[id] = b.file;
      return { type: 'image', file_uuid: id };
    };
    const resultText = content => {
      const items = Array.isArray(content) ? content : [content];
      return items.map(it => (typeof it === 'string' ? it : it && it.type === 'text' ? String(it.text || '') : null)).filter(t => t !== null).join('\n');
    };
    const adaptResult = b => {
      const items = Array.isArray(b.content) ? b.content : [];
      const text = sessionCut(resultText(b.content), SESSION_RESULT_MORE);
      const imgs = items.filter(it => it && it.type === 'image').map(image);
      return { type: 'tool_result', tool_use_id: b.tool_use_id, is_error: !!b.is_error, content: [...(text ? [{ type: 'text', text }] : []), ...imgs] };
    };
    const adaptBlock = b => {
      if (!b || typeof b !== 'object') return null;
      if (b.type === 'image') return image(b);
      if (b.type === 'tool_result') return adaptResult(b);
      if (b.type === 'tool_use') return { ...b, input: cutInput(b.input) };
      if (b.type === 'text' || b.type === 'thinking') return b;
      return null;
    };
    const promptKind = core('promptKind');
    // One message list per group: '' is the main conversation, else a subagent's (its Agent call's tool_use id).
    const groups = new Map();
    const groupOf = key => { if (!groups.has(key)) groups.set(key, { messages: [], open: null }); return groups.get(key); };
    const order = []; // every message in event order, for one buildViewerChat pass
    const start = (g, e, sender, extra = {}) => {
      const m = { uuid: String(e.uuid || `ev-${order.length}`), parent_message_uuid: null, sender, created_at: e.created_at || null, content: [], ...extra };
      g.messages.push(m);
      order.push(m);
      g.open = sender === 'assistant' ? m : null;
      return m;
    };
    const reply = (g, e) => g.open || start(g, e, 'assistant');
    for (const e of Array.isArray(events) ? events : []) {
      if (!e || typeof e !== 'object') continue;
      const key = typeof e.parent_tool_use_id === 'string' && e.parent_tool_use_id ? e.parent_tool_use_id : '';
      const g = groupOf(key);
      if (e.stub) {
        // A user stub is most likely a large tool result: it joins the open reply when there is one.
        const m = e.type === 'assistant' || g.open ? reply(g, e) : start(g, e, 'human');
        m.content.push({ type: 'text', text: SESSION_STUB_TEXT });
        if (m.sender === 'human') g.open = null;
        continue;
      }
      if ((e.type !== 'user' && e.type !== 'assistant') || !e.message || typeof e.message !== 'object') continue;
      const raw = Array.isArray(e.message.content) ? e.message.content : typeof e.message.content === 'string' ? [{ type: 'text', text: e.message.content }] : [];
      const blocks = raw.map(adaptBlock).filter(Boolean);
      const role = e.message.role === 'assistant' || e.type === 'assistant' ? 'assistant' : 'user';
      if (role === 'assistant' || (blocks.length && blocks.every(b => b.type === 'tool_result'))) {
        reply(g, e).content.push(...blocks);
        continue;
      }
      if (!blocks.length) continue;
      const text = blocks.filter(b => b.type === 'text').map(b => String(b.text || '')).join('\n');
      const kind = promptKind(text);
      if (kind !== 'prompt') {
        start(g, e, 'human', { labelled: kind }).content.push({ type: 'text', text: sessionLabelText(kind, text) }, ...blocks.filter(b => b.type !== 'text'));
      } else start(g, e, 'human').content.push(...blocks);
    }
    // A subagent group whose Agent call isn't in the session (its event was stubbed) joins the main conversation
    // where it happened in time, so the session has one root and no made-up branches.
    const toolIds = new Set();
    for (const m of order) for (const b of m.content) if (b && b.type === 'tool_use' && b.id != null) toolIds.add(b.id);
    groupOf('');
    const mainKeys = new Set([...groups.keys()].filter(k => !k || !toolIds.has(k)));
    const inMain = new Set();
    for (const k of mainKeys) for (const m of groups.get(k).messages) inMain.add(m);
    const main = order.filter(m => inMain.has(m));
    // Each message's parent is the one before it in its group (the main line counts as one), so the main line is
    // the branch the viewer walks.
    const lines = [main, ...[...groups].filter(([k]) => !mainKeys.has(k)).map(([, g]) => g.messages)];
    for (const line of lines) line.forEach((m, i) => { m.parent_message_uuid = i ? line[i - 1].uuid : null; });
    const model = (cfg && typeof cfg.model === 'string' && cfg.model) || '';
    const published = sessionPublished(core('publishedPagesOf')({ chat_messages: order }), opts.artifacts, folder);
    const chat = buildViewerChat({
      uuid: s.id, name: title, model, created_at: s.created_at || null, updated_at: s.last_event_at || s.updated_at || null,
      chat_messages: order, current_leaf_message_uuid: main.length ? main[main.length - 1].uuid : null
    }, { folder, toolImages, sessionImages: true, ...(published.length ? { published } : {}) });
    // Each page's card file, by its uuid (the fold bar opens it in the side panel), and its artifact on the Artifacts
    // screen when that is a listed one in the export (the panel's Open artifact).
    const pages = {};
    const fileKeys = chat.files && chat.files.fileKeys instanceof Map ? chat.files.fileKeys : new Map();
    for (const entry of published) {
      const id = fileKeys.get('published:' + entry.uuid);
      if (id === undefined || !chat.files[id]) continue;
      pages[entry.uuid] = id;
      if (entry.view) chat.files[id] = { ...chat.files[id], artifact: entry.view };
    }
    // Subagent messages move under their Agent step, in order; a group whose step isn't in the session stays in place.
    const byId = new Map(chat.messages.map(m => [m.id, m]));
    const moved = new Set();
    for (const [key, g] of groups) {
      if (mainKeys.has(key)) continue;
      const step = chat.toolBlocks.get(key);
      if (!step) continue;
      step.children = g.messages.map(m => byId.get(m.uuid)).filter(Boolean);
      for (const m of g.messages) moved.add(m.uuid);
    }
    const out = { ...chat, messages: chat.messages.filter(m => !moved.has(m.id)) };
    delete out.project;
    const arts = s.external_metadata && Array.isArray(s.external_metadata.artifacts) ? s.external_metadata.artifacts : [];
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    return {
      id: s.id, title,
      origin: (typeof cfg.origin === 'string' && cfg.origin) || (typeof s.environment_kind === 'string' ? s.environment_kind : ''),
      created: s.created_at || null, updated: s.last_event_at || s.updated_at || null, folder,
      artifacts: [...new Set(arts.filter(a => a && typeof a.artifact_id === 'string' && uuidRe.test(a.artifact_id)).map(a => a.artifact_id.toLowerCase()))],
      ...(Object.keys(pages).length ? { pages } : {}),
      chat: out
    };
  }

  // The viewer's own model name ("Opus 4.8"); meta.md keeps getModelName's wording. Unknown ids get the fallback.
  function modelLabel(id, fallback) {
    const m = /^claude-(?:(opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?|(\d+)(?:-(\d{1,2}))?-(opus|sonnet|haiku))(?:-\d{8})?$/i.exec(String(id || '').trim());
    if (!m) return fallback;
    const family = (m[1] || m[6]).toLowerCase();
    const major = m[2] || m[4], minor = m[3] || m[5];
    return `${family[0].toUpperCase()}${family.slice(1)} ${major}${minor ? '.' + minor : ''}`;
  }

  // Identical projects are kept once in `projects`, and each chat's project becomes its index there,
  // so a mega-ZIP doesn't carry a project's docs once per chat. The viewer puts them back on load.
  // Projects are compared by a cheap key first (name, instructions, doc names and lengths, file names),
  // then in full only against projects with that key. Comparing in full is quick when the docs are the
  // same strings, as they are when an export reuses one fetch for every chat in a project.
  function sameValue(a, b) {
    if (a === b) return true;
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every(k => Object.prototype.hasOwnProperty.call(b, k) && sameValue(a[k], b[k]));
  }

  function projectKey(p) {
    const docs = Array.isArray(p.docs) ? p.docs.map(d => [d && d.name, d && typeof d.text === 'string' ? d.text.length : null]) : null;
    const files = Array.isArray(p.files) ? p.files.map(f => f && f.name) : null;
    return JSON.stringify([p.name, typeof p.instructions === 'string' ? p.instructions.length : null, docs, files, Object.keys(p).sort()]);
  }

  // A store record's versions for its view, in its versionOrder (claude.ai's; an object's keys put numeric-looking ids
  // first), then any other key: { ver, label (v1, v2, ... in that order),
  // folder (from the export root; null when no copy was saved), start, startSaved (in folder, or for a same version
  // the root-relative file a chat wrote), same, current, copy: { chat, file, version } | null, the chat card's version
  // that holds its text }. copies: 'ver' -> copy, from the chats' published cards of that page.
  // A record read from disk (tools/archive-lib.js) may add versionPlaces: { <ver>: { folder, part, key, startKind } }:
  // folder (from the export root) where that version's files are when not under dir (an older layout), and the
  // version's own preview payload in viewer-files (part, key, as an ArtifactView's) with its start file's kind;
  // the version then also has part, key and startKind.
  function recordVersions(rec, copies) {
    const dir = typeof rec.dir === 'string' ? rec.dir : '';
    const versions = rec.versions && typeof rec.versions === 'object' ? rec.versions : {};
    const own = ver => Object.prototype.hasOwnProperty.call(versions, ver) && versions[ver] && typeof versions[ver] === 'object';
    const places = rec.versionPlaces && typeof rec.versionPlaces === 'object' ? rec.versionPlaces : {};
    const order = Array.isArray(rec.versionOrder) ? rec.versionOrder.filter(k => typeof k === 'string' && own(k)) : [];
    const keys = [...new Set([...order, ...Object.keys(versions).filter(own)])];
    return keys.map((ver, i) => {
      const v = versions[ver];
      const place = Object.prototype.hasOwnProperty.call(places, ver) && places[ver] && typeof places[ver] === 'object' ? places[ver] : {};
      const start = typeof v.start === 'string' && v.start ? v.start : null;
      const files = Array.isArray(v.files) ? v.files.filter(f => f && typeof f.path === 'string') : [];
      const folder = typeof place.folder === 'string' && place.folder ? place.folder
        : typeof v.folder === 'string' && v.folder && dir ? `${dir}/${v.folder}` : null;
      const sameAs = !folder && v.sameAs && typeof v.sameAs === 'object' ? v.sameAs : null;
      const sameFile = sameAs ? sameAs[start || (files[0] && files[0].path)] : null;
      const same = typeof sameFile === 'string' && sameFile !== '';
      const preview = Number.isSafeInteger(place.part) && place.part > 0 && typeof place.key === 'string' && place.key
        ? { part: place.part, key: place.key, startKind: typeof place.startKind === 'string' ? place.startKind : null } : {};
      // The version's own files, saved where it is: in its folder (savedAs inside it), or a chat's file (root-relative)
      // for a same version. The artifact page lists these when this version is shown, never the current one's.
      const savedOf = f => (folder ? (typeof f.savedAs === 'string' && f.savedAs ? f.savedAs : null)
        : sameAs && typeof sameAs[f.path] === 'string' && sameAs[f.path] ? sameAs[f.path] : null);
      return {
        ver, label: `v${i + 1}`, folder, start,
        startSaved: same ? sameFile : folder && typeof v.startSaved === 'string' && v.startSaved ? v.startSaved : null,
        same, current: typeof rec.current === 'string' && rec.current === ver, copy: copies.get(ver) || null, ...preview,
        files: files.map(f => ({ path: f.path, savedAs: savedOf(f), verified: f.verified !== false })),
      };
    });
  }

  // artifacts: { views, records, listed, exported, since, listFetched } from Export All. records: each artifact.json
  // written (format 2) with dir, its folder from the export root, and versionOrder, its version keys in order. With views, records or listFetched false, the data
  // gains artifacts (each view plus links: [{ chat, messageUuid, how }], docFile: { chat, file } | null, listed (its
  // record's; true without one) and versions (recordVersions)), listed, exportedArtifacts, artifactsSince and
  // listFetched (whether claude.ai's list is in the export); a chat's published-page file gets artifact: <id> when
  // that page is a listed one.
  function buildViewerData(chats, { exported, artifacts, sessions } = {}) {
    const projects = [], byKey = new Map(), byId = new Map();
    let sorted = chats.slice().sort((a, b) => String(b.updated || '').localeCompare(String(a.updated || '')));
    const views = artifacts && Array.isArray(artifacts.views) ? artifacts.views.filter(v => v && typeof v === 'object') : [];
    const records = artifacts && Array.isArray(artifacts.records) ? artifacts.records.filter(r => r && typeof r === 'object' && typeof r.uuid === 'string') : [];
    const listFetched = artifacts ? artifacts.listFetched !== false : true;
    const recordOf = new Map(); // short id and uuid -> record
    for (const rec of records) {
      recordOf.set(rec.uuid.toLowerCase(), rec);
      if (typeof rec.shortId === 'string' && rec.shortId) recordOf.set(rec.shortId, rec);
    }
    const linked = new Map(); // view id -> { view, rec, links, doc: { at, chat, file } | null, copies: ver -> copy }
    for (const view of views) {
      const rec = recordOf.get(String(view.id)) || null;
      linked.set(String(view.id), { view, rec, listed: rec ? rec.listed === true : view.listed !== false, links: [], doc: null, copies: new Map() });
    }
    const viewOf = uuid => {
      let short = '';
      try { short = core('uuidToBase58')(uuid) || ''; } catch (e) { /* the uuid itself may be the id */ }
      return linked.get(short) || linked.get(uuid) || null;
    };
    if (views.length) {
      sorted = sorted.map((chat, ci) => {
        const links = Array.isArray(chat.links) ? chat.links : [];
        const fileKeys = chat.files && chat.files.fileKeys instanceof Map ? chat.files.fileKeys : new Map();
        let files = chat.files;
        for (const link of links) {
          const hit = viewOf(link.uuid);
          if (!hit) continue;
          hit.links.push({ chat: ci, messageUuid: link.messageUuid, how: link.how });
          // The latest chat (ties: the later one in the data) holding the rebuilt document.
          if (link.how === 'made' && link.docKey && fileKeys.has(link.docKey)) {
            const at = String(chat.updated || '');
            if (!hit.doc || at >= hit.doc.at) hit.doc = { at, chat: ci, file: fileKeys.get(link.docKey) };
          }
        }
        // A published page's card names its artifact when that artifact is a listed one in the export, and its
        // versions with text are the artifact's versions' copies (the first chat's, newest chat first).
        for (const [key, id] of fileKeys) {
          if (!key.startsWith('published:') || !chat.files[id]) continue;
          const hit = viewOf(key.slice('published:'.length));
          if (!hit) continue;
          (Array.isArray(chat.files[id].versions) ? chat.files[id].versions : []).forEach((v, i) => {
            const saved = v && (typeof v.text === 'string' || (Number.isSafeInteger(v.part) && v.part > 0));
            if (saved && typeof v.ver === 'string' && v.ver && !hit.copies.has(v.ver)) hit.copies.set(v.ver, { chat: ci, file: id, version: i });
          });
          if (!hit.listed) continue;
          if (files === chat.files) files = { ...chat.files };
          files[id] = { ...chat.files[id], artifact: String(hit.view.id) };
        }
        return files === chat.files ? chat : Object.assign({}, chat, { files });
      });
    }
    const out = sorted.map(chat => {
      if (!chat.project || typeof chat.project !== 'object') return chat;
      const pid = typeof chat.project.id === 'string' && chat.project.id ? chat.project.id : '';
      if (pid) {
        // One project per id: the newest `updated` wins, then the copy with more docs and files, then the first.
        let at = byId.get(pid);
        if (at === undefined) { at = projects.length; projects.push(chat.project); byId.set(pid, at); }
        else {
          const a = projects[at], b = chat.project;
          const time = (p) => { const t = typeof p.updated === 'string' ? Date.parse(p.updated) : NaN; return Number.isNaN(t) ? -Infinity : t; };
          const au = time(a), bu = time(b);
          const size = (p) => (Array.isArray(p.docs) ? p.docs.length : 0) + (Array.isArray(p.files) ? p.files.length : 0);
          if (bu > au || (bu === au && size(b) > size(a))) projects[at] = b;
        }
        return { ...chat, project: at };
      }
      const key = projectKey(chat.project);
      const candidates = byKey.get(key) || [];
      let index = candidates.find(i => sameValue(projects[i], chat.project));
      if (index === undefined) {
        index = projects.length;
        projects.push(chat.project);
        byKey.set(key, [...candidates, index]);
      }
      return { ...chat, project: index };
    });
    // A chat claude.ai made when an artifact was opened, with no messages: that artifact, from the store, as a
    // published page's file it opens in the side panel (opened: { title, file, version }, every version the store
    // saved, the current one shown), or only its title when the export has the artifact listed but not saved.
    for (let i = 0; i < out.length; i++) {
      const chat = out[i];
      if (!chat.startedWith || chat.messages.length) continue;
      const opened = openedArtifact(chat.startedWith, views, records);
      if (opened) out[i] = opened.file ? { ...chat, files: { ...chat.files, [opened.id]: opened.file }, opened: opened.opened } : { ...chat, opened: opened.opened };
    }
    const data = { exported, chats: out, projects };
    if (views.length || records.length || !listFetched) {
      // How many artifact folders the export has (listed or not): the Artifacts entry shows for any.
      data.storeCount = records.length;
      data.artifacts = views.map(view => {
        const { rec, listed, links, doc, copies } = linked.get(String(view.id));
        return { ...view, listed, links, docFile: doc ? { chat: doc.chat, file: doc.file } : null, versions: rec ? recordVersions(rec, copies) : [] };
      });
      data.listed = artifacts.listed == null ? null : artifacts.listed;
      data.exportedArtifacts = artifacts.exported || null;
      data.artifactsSince = artifacts.since || null;
      data.listFetched = listFetched;
    }
    // Sessions (buildViewerSession), newest activity first; apart from chats, so no chat count or project changes.
    if (Array.isArray(sessions) && sessions.length) {
      data.sessions = sessions.filter(x => x && typeof x === 'object')
        .sort((a, b) => String(b.updated || '').localeCompare(String(a.updated || '')));
    }
    return data;
  }

  // Large upload text, and large text of files Claude made, leaves the page for viewer-files/part-NNNN.js,
  // loaded when the upload or file is opened. Search reads neither, so it is unchanged. Stylesheets and
  // scripts stay, because a preview inlines them from the page (inlineSiblings). data is not mutated.
  function moveUploadText(data, { firstPart = 1, inlineLimit = UPLOAD_INLINE_LIMIT, partLimit = PART_LIMIT } = {}) {
    const encoder = new TextEncoder();
    const parts = [];
    let pending = [], pendingBytes = 0, number = firstPart, keys = 0;
    const head = n => `window.__archivePart(${n}, {`;
    const flush = () => {
      if (!pending.length) return;
      parts.push({ name: `part-${String(number).padStart(4, '0')}.js`, body: `${head(number)}${pending.join(',')}});` });
      number++;
      pending = [];
      pendingBytes = 0;
    };
    let fileKeys = 0;
    // Adds one text to the current part and returns where it went.
    const place = (key, text) => {
      const item = `${escapeJson(key)}:${escapeJson(text)}`;
      const bytes = encoder.encode(item).length + 1;
      if (pending.length && pendingBytes + bytes + head(number).length + 3 > partLimit) flush();
      pending.push(item);
      pendingBytes += bytes;
      return number;
    };
    const big = text => typeof text === 'string' && text.length > inlineLimit / 4 && encoder.encode(text).length > inlineLimit;
    const chats = data.chats.map(chat => {
      let changed = false;
      let files = chat.files;
      if (files && typeof files === 'object') {
        for (const [id, file] of Object.entries(chat.files)) {
          if (!file || !Array.isArray(file.versions) || /\.(css|m?js)$/i.test(file.name || '')) continue;
          if (!file.versions.some(v => v && big(v.text))) continue;
          const versions = file.versions.map(v => {
            if (!v || !big(v.text)) return v;
            const key = 'f' + fileKeys++;
            return { ...v, text: null, part: place(key, v.text), key };
          });
          if (files === chat.files) files = { ...chat.files };
          files[id] = { ...file, versions };
          changed = true;
        }
      }
      const messages = chat.messages.map(m => {
        if (!Array.isArray(m.uploads) || !m.uploads.some(u => u && typeof u.text === 'string')) return m;
        let moved = false;
        const uploads = m.uploads.map(u => {
          if (!u || typeof u.text !== 'string' || encoder.encode(u.text).length <= inlineLimit) return u;
          const key = 'u' + keys++;
          moved = true;
          return { ...u, text: null, lines: u.text.split('\n').length, part: place(key, u.text), key };
        });
        if (!moved) return m;
        changed = true;
        return { ...m, uploads };
      });
      return changed ? { ...chat, messages, files } : chat;
    });
    flush();
    return { data: parts.length ? { ...data, chats } : data, parts };
  }

  // Export Artifacts: each artifact's preview texts and images ({ texts: [[path, text]], images: [[path, dataUri]] })
  // go to viewer-files parts as the artifact finishes, under key a0, a1, ... (one key per add, in add order).
  // A part closes when the next payload would pass partLimit, or as soon as it reaches it; one payload is never
  // split, so a part may pass the limit by that payload. Past budget bytes of part bodies, payloads are left out (part: null) for the
  // rest of the export. add(view, payload) returns the view with part and key set (null without a payload);
  // drain() returns the parts closed since the last drain; flush() closes the open part and returns those
  // and any not yet drained. count: parts made so far.
  function artifactViewParts({ partLimit = PART_LIMIT, budget = ARTIFACT_PARTS_BUDGET, firstPart = 1 } = {}) {
    const encoder = new TextEncoder();
    const head = n => `window.__archivePart(${n}, {`;
    let pending = [], pendingBytes = 0, number = firstPart, keys = 0, used = 0, full = false, count = 0;
    let ready = [];
    const close = () => {
      if (!pending.length) return;
      ready.push({ name: `part-${String(number).padStart(4, '0')}.js`, body: `${head(number)}${pending.join(',')}});` });
      number++;
      count++;
      pending = [];
      pendingBytes = 0;
    };
    // reserve: room to leave for what comes later (an older version's preview, ARTIFACT_HISTORY_RESERVE); one that
    // doesn't fit within it is left out, and the budget is not marked full for the rest.
    const add = (view, payload, { reserve = 0 } = {}) => {
      const key = 'a' + keys++;
      const has = payload && ((Array.isArray(payload.texts) && payload.texts.length) || (Array.isArray(payload.images) && payload.images.length));
      if (!has || full) return { ...view, part: null, key: null };
      const item = `${escapeJson(key)}:${escapeJson({ texts: payload.texts || [], images: payload.images || [] })}`;
      const bytes = encoder.encode(item).length + 1;
      if (reserve > 0 && used + bytes > budget - reserve) return { ...view, part: null, key: null };
      if (used + bytes > budget) {
        full = true;
        return { ...view, part: null, key: null };
      }
      if (pending.length && pendingBytes + bytes + head(number).length + 3 > partLimit) close();
      pending.push(item);
      pendingBytes += bytes;
      used += bytes;
      const part = number;
      // A part that has reached the limit closes now, so it can be written with this artifact.
      if (pendingBytes + head(number).length + 3 >= partLimit) close();
      return { ...view, part, key };
    };
    const drain = () => { const out = ready; ready = []; return out; };
    const flush = () => { close(); return drain(); };
    return { add, drain, flush, get count() { return count; } };
  }

  // Each '/'-separated part is encoded per segment. '..' or '.' anywhere: null (never leave the export).
  function relHref(...parts) {
    const segs = [];
    for (const p of parts) {
      if (p == null) return null;
      for (const s of String(p).split('/')) {
        if (s === '') continue;
        if (s === '.' || s === '..') return null;
        segs.push(encodeURIComponent(s));
      }
    }
    return segs.length ? segs.join('/') : null;
  }

  // null when '..' would climb above the viewer's folder: such a link could only point outside the export.
  function joinPath(folder, rel) {
    const out = [];
    for (const s of `${folder || ''}/${rel || ''}`.split('/')) {
      if (s === '' || s === '.') continue;
      if (s === '..') {
        if (!out.length) return null;
        out.pop();
      } else out.push(s);
    }
    return out.join('/');
  }

  // One pass over the JSON, which on a large archive is tens of megabytes.
  const JSON_ESCAPES = { '</': '<\\/', '<!--': '\\u003c!--', '\u2028': '\\u2028', '\u2029': '\\u2029' };
  function escapeJson(data) {
    return JSON.stringify(data).replace(/<\/|<!--|[\u2028\u2029]/g, m => JSON_ESCAPES[m]);
  }

  // One pass with function replacers: '$&' or a placeholder inside a value stays literal.
  // data: object (escaped here) or an already-escaped JSON string.
  // fileScripts: the page may load viewer-files/ scripts and media from disk. fileMedia: only media.
  function assembleViewer({ template, css, marked, katex, highlight, logic, app, artifactsApp = '', artifactsCss = '', data, fileScripts, fileMedia }) {
    // \x21 rather than \!, which a regular expression with the u flag rejects.
    const script = code => String(code).replace(/<\/script/gi, '<\\/script').replace(/<!--/g, () => '<\\x21--');
    const style = text => String(text).replace(/<\/style/gi, '<\\/style');
    const values = {
      KATEX_CSS: () => style(css),
      ARTIFACTS_CSS: () => style(artifactsCss),
      ARTIFACTS_APP_JS: () => script(artifactsApp),
      DATA_JSON: () => (typeof data === 'string' ? data : escapeJson(data)),
      MARKED_JS: () => script(marked),
      KATEX_JS: () => script(katex),
      HIGHLIGHT_JS: () => script(highlight),
      LOGIC_JS: () => script(logic),
      APP_JS: () => script(app)
    };
    // On the template, before the scripts go in: the preview sandbox policy in logic must stay as it is.
    const allow = (html, directive) => html.replace(new RegExp(`(http-equiv="Content-Security-Policy" content="[^"]*${directive} [^;"]*)`), '$1 file:');
    let page = String(template);
    if (fileScripts) page = allow(page, 'script-src');
    if (fileScripts || fileMedia) page = allow(page, 'media-src');
    return page.replace(/\/\*(KATEX_CSS|ARTIFACTS_CSS|DATA_JSON|MARKED_JS|KATEX_JS|HIGHLIGHT_JS|LOGIC_JS|ARTIFACTS_APP_JS|APP_JS)\*\//g, (m, k) => values[k]());
  }

  const api = { buildViewerChat, buildViewerSession, SESSION_RESULT_LIMIT, modelLabel, kindFor, buildViewerData, relHref, joinPath, escapeJson, assembleViewer, VIEWER_ASSETS, ARTIFACTS_VIEWER_ASSETS, VIEWER_CHECK_FILE, VIEWER_CHECK_BASE64, TOOL_TEXT_LIMIT, TEXT_EMBED_LIMIT, moveUploadText, PART_LIMIT, UPLOAD_INLINE_LIMIT, artifactViewParts, ARTIFACT_PARTS_BUDGET, ARTIFACT_HISTORY_RESERVE, recordVersions };
  root.CTViewer = Object.assign(root.CTViewer || {}, api);
  if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis);
