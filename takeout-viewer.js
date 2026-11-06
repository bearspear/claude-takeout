// Claude Takeout - offline viewer data builder
// Classic script. Exposes globalThis.CTViewer (and module.exports for tests):
//   buildViewerChat(data, ctx)         one conversation as the viewer's compact Chat (see the data contract).
//                                      ctx: { folder, model, fixText, artifacts, artifactIndex, uploads,
//                                      deliveries, heredocPaths, project }, all optional. data is never mutated.
//                                      artifacts: filename to text ('' for binaries). artifactIndex: extractArtifacts' index
//                                      (state key to { path, filename, versions, messages }). deliveries: file uuid to
//                                      { filename, path }. heredocPaths(command): paths a Bash command writes with a heredoc;
//                                      without it Bash blocks yield no cards.
//   buildViewerData(chats, {exported}) { exported, chats }, newest update first
//   relHref(...parts)                  URL-encoded relative link, or null when a part escapes upward
//   joinPath(folder, rel)              folder + rel with '..' resolved
//   escapeJson(data)                   JSON that is safe inside a <script> tag
//   assembleViewer({template, css, marked, katex, logic, app, data})  one self-contained HTML string
//   VIEWER_ASSETS                      paths of the six viewer files
//   TOOL_TEXT_LIMIT                    longest tool result text kept
(function (root) {
  'use strict';

  const TOOL_TEXT_LIMIT = 20000;
  const SAFE_IMAGE = /^image\/(png|jpeg|gif|webp)$/;

  const VIEWER_ASSETS = [
    'viewer/viewer-template.html', 'viewer/viewer-logic.js', 'viewer/viewer-app.js',
    'viewer/marked.min.js', 'viewer/katex.min.js', 'viewer/katex-inline.css'
  ];

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
      case 'web_search': return i.query ? `Searched the web: ${i.query}` : 'Searched the web';
      case 'web_fetch': return i.url ? `Fetched ${i.url}` : 'Fetched a page';
      case 'bash_tool': case 'Bash': return 'Ran a command';
      case 'create_file': case 'Write': return p ? `Created ${p}` : 'Created a file';
      case 'str_replace': case 'Edit': case 'str_replace_based_edit_tool': return p ? `Edited ${p}` : 'Edited a file';
      case 'view': case 'read_file': case 'Read': return p ? `Viewed ${p}` : 'Viewed a file';
      case 'present_files': return 'Presented files';
      case 'artifacts': return i.title ? `Artifact: ${i.title}` : 'Artifact';
      default: return `Used ${name || 'a tool'}`;
    }
  }

  function resultParts(content) {
    const items = Array.isArray(content) ? content : (typeof content === 'string' ? [{ type: 'text', text: content }] : []);
    const texts = [];
    const images = [];
    for (const it of items) {
      if (!it || typeof it !== 'object') continue;
      if (it.type === 'text' && typeof it.text === 'string') texts.push(it.text);
      else if (it.type === 'image' && it.source && it.source.type === 'base64' &&
               SAFE_IMAGE.test(String(it.source.media_type)) && /^[A-Za-z0-9+/=\s]*$/.test(String(it.source.data))) {
        images.push(`data:${it.source.media_type};base64,${it.source.data}`);
      }
    }
    return { text: cut(texts.join('\n')), images };
  }

  function buildCites(citations) {
    if (!Array.isArray(citations)) return [];
    return citations
      .filter(c => c && /^https?:\/\//i.test(String(c.url)))
      .map(c => ({ end: c.end_index, url: String(c.url), title: c.title || 'Source' }))
      .sort((a, b) => a.end - b.end);
  }

  // Same rule as getThinkingSummary in popup.js.
  function thinkingSummary(block) {
    const s = Array.isArray(block.summaries) ? block.summaries : [];
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

  const missingFile = name => ({ name, kind: 'missing', versions: [{ label: '', text: null, href: null }] });

  // Cards for the files each message made. Mutates the blocks of `messages` and returns the GenFile map.
  function addCards(source, messages, blockOf, leafId, c) {
    const index = c.artifactIndex || {};
    const arts = c.artifacts || {};
    const deliveries = c.deliveries || {};
    const folder = c.folder || '';
    const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
    const textOf = fn => (hasOwn(arts, fn) && typeof arts[fn] === 'string' && arts[fn] !== '' ? arts[fn] : null);
    const hrefOf = fn => relHref(folder, 'artefacts', fn);
    const entryFile = (name, fns, mime) => {
      fns = Array.from(fns);
      const versions = fns.map((fn, i) => ({ label: fns.length > 1 ? 'v' + (i + 1) : '', text: textOf(fn), href: hrefOf(fn) }));
      return { name, kind: kindFor(name, mime, versions.some(v => v.text !== null)), versions };
    };

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
    const versionAsOf = (entry, at) => {
      let v = -1;
      Array.from(entry.messages || []).forEach((id, i) => { if (pos.has(id) && (at == null || pos.get(id) <= at)) v = i; });
      return v;
    };

    // Same rule as failedToolUseIds in popup.js.
    const failed = new Set();
    const resultOf = new Map();
    for (const m of source) for (const b of Array.isArray(m.content) ? m.content : []) {
      if (b && b.type === 'tool_result' && b.tool_use_id != null) {
        resultOf.set(b.tool_use_id, b);
        if (b.is_error) failed.add(b.tool_use_id);
      }
    }
    const isBash = n => n === 'bash_tool' || n === 'Bash';
    const heredocs = command => (typeof c.heredocPaths === 'function' ? c.heredocPaths(String(command || '')) : []) || [];

    // Every delivered version of a path, in chain order, for the uuids the caller knows.
    const deliveredUuids = new Map();
    for (const m of chain) for (const b of Array.isArray(m.content) ? m.content : []) {
      for (const d of (b && Array.isArray(b.file_deliveries) ? b.file_deliveries : [])) {
        if (!d || !d.file_uuid || !d.path || !hasOwn(deliveries, d.file_uuid)) continue;
        if (!deliveredUuids.has(d.path)) deliveredUuids.set(d.path, []);
        if (!deliveredUuids.get(d.path).includes(d.file_uuid)) deliveredUuids.get(d.path).push(d.file_uuid);
      }
    }

    const files = {};
    const ids = new Map();
    let counter = 0;

    source.forEach((m, mi) => {
      const message = messages[mi];
      const active = pos.has(m.uuid);
      const at = active ? pos.get(m.uuid) : null;
      const touches = new Map(); // fileKey -> { after, build, version }; the last block touching a file wins
      const touch = (after, fileKey, build, version) => { touches.delete(fileKey); touches.set(fileKey, { after, build, version }); };
      const contentKey = (after, k, name, text, mime) => touch(after, k, () => ({ name, kind: kindFor(name, mime, true), versions: [{ label: '', text, href: null }] }), 0);
      const missingKey = (after, k, name) => touch(after, k, () => missingFile(name), 0);

      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (!b || b.type !== 'tool_use') continue;
        const after = blockOf.get(b);
        if (!after) continue;
        const input = b.input && typeof b.input === 'object' ? b.input : {};
        const bash = isBash(b.name);
        if (failed.has(b.id) && !bash) continue;

        // Keys in artifactIndex are extractArtifacts' state keys.
        let key = null, mime = null, name = null, text = null, edit = false;
        if (b.name === 'create_file') { key = input.path; text = input.file_text; }
        else if (b.name === 'Write') { key = input.file_path; text = input.content; }
        else if (b.name === 'rewrite' || b.name === 'create_or_overwrite') { key = input.path; text = input.file_text || input.content; }
        else if (b.name === 'str_replace' || b.name === 'Edit') { key = b.name === 'Edit' ? input.file_path : input.path; edit = true; }
        else if (b.name === 'artifacts' && (input.command === 'create' || input.command === 'update')) {
          if (input.content && (input.id || input.title)) {
            key = 'artifact:' + (input.id || input.title); mime = input.type || null; text = input.content;
            name = String(input.title || input.id);
          }
        }

        if (key && (edit || text)) {
          if (active) {
            const entry = hasOwn(index, key) ? index[key] : null;
            const v = entry ? versionAsOf(entry, at) : -1;
            if (entry && v >= 0) touch(after, key, () => entryFile(entry.filename, entry.versions, mime), v);
          } else if (edit) {
            missingKey(after, 'x:' + m.uuid + ':' + key, baseName(key));
          } else {
            contentKey(after, 'x:' + m.uuid + ':' + key, name || baseName(key), String(text), mime);
          }
        } else if (bash) {
          for (const p of heredocs(input.command)) {
            if (active) {
              const entry = hasOwn(index, p) ? index[p] : null;
              const v = entry ? versionAsOf(entry, at) : -1;
              if (entry && v >= 0) touch(after, p, () => entryFile(entry.filename, entry.versions, null), v);
            } else {
              missingKey(after, 'x:' + m.uuid + ':' + p, baseName(p));
            }
          }
        } else if (b.name === 'present_files') {
          const paths = Array.isArray(input.filepaths) ? input.filepaths : (Array.isArray(input.paths) ? input.paths : []);
          const where = effectivePos(m.uuid);
          for (const p of paths) {
            if (typeof p !== 'string' || !p) continue;
            const base = baseName(p);
            let entry = hasOwn(index, p) ? index[p] : null;
            if (!entry) entry = Object.values(index).find(e => e && e.filename === base) || null;
            if (entry) {
              const v = Math.max(versionAsOf(entry, where), 0);
              touch(after, entry.path, () => entryFile(entry.filename, entry.versions, null), v);
            } else if (hasOwn(arts, base)) {
              touch(after, 'name:' + base, () => entryFile(base, [base], null), 0);
            } else {
              touch(after, 'missing:' + p, () => missingFile(base), 0);
            }
          }
        } else if (b.name === 'SendUserFile' && active) {
          const r = resultOf.get(b.id);
          for (const d of (r && Array.isArray(r.file_deliveries) ? r.file_deliveries : [])) {
            if (!d || !d.path || !hasOwn(deliveries, d.file_uuid)) continue;
            const uuids = deliveredUuids.get(d.path) || [];
            const v = uuids.indexOf(d.file_uuid);
            if (v < 0) continue;
            touch(after, 'deliver:' + d.path, () => {
              const fns = uuids.map(u => deliveries[u].filename || baseName(d.path));
              // Several copies are named <base>_v1<ext> ...; the file itself is <base><ext>.
              const name = fns.length > 1 ? fns[0].replace(/_v1(?=(\.[^./]*)?$)/, '') : fns[0];
              return entryFile(name, fns, null);
            }, v);
          }
        }
      }

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
          }
          out.push({ t: 'card', file: ids.get(fileKey), version: t.version });
        }
      }
      message.blocks = out;
    });
    return files;
  }

  function buildViewerChat(data, ctx) {
    const c = ctx || {};
    const fix = typeof c.fixText === 'function' ? c.fixText : (s => s);
    const source = Array.isArray(data.chat_messages) ? data.chat_messages : [];

    // tool_use_id -> tool block, across every message, so a result can land in an earlier message's block.
    const toolById = new Map();
    const blockOf = new Map(); // raw tool_use block -> its viewer block
    const messages = source.map(m => {
      const blocks = [];
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (!b) continue;
        if (b.type === 'text') blocks.push({ t: 'text', text: String(b.text || ''), cites: buildCites(b.citations) });
        else if (b.type === 'thinking') blocks.push({ t: 'thinking', text: String(b.thinking || ''), summary: thinkingSummary(b) });
        else if (b.type === 'tool_use') {
          const input = compactInput(b.input);
          const tool = { t: 'tool', name: b.name || '', label: toolLabel(b.name, b.input), input, result: '', error: false, images: [] };
          blocks.push(tool);
          blockOf.set(b, tool);
          if (b.id != null) toolById.set(b.id, tool);
        }
      }
      return {
        id: m.uuid, parent: m.parent_message_uuid || null, sender: m.sender, at: m.created_at,
        blocks, uploads: [],
        attachments: (m.attachments || []).map(a => ({ name: a.file_name || '', text: fix(a.extracted_content || '') }))
      };
    });

    // Second pass: results may precede nothing, follow in the same message, or arrive in a later one.
    for (const m of source) {
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (!b || b.type !== 'tool_result') continue;
        const tool = toolById.get(b.tool_use_id);
        if (!tool) continue;
        const { text, images } = resultParts(b.content);
        tool.result = text;
        tool.images = images;
        tool.error = !!b.is_error;
      }
    }

    const files = addCards(source, messages, blockOf, data.current_leaf_message_uuid, c);

    return {
      id: data.uuid, title: data.name || '', model: c.model || data.model || '',
      created: data.created_at, updated: data.updated_at, leaf: data.current_leaf_message_uuid || null,
      messages, files, project: null
    };
  }

  function buildViewerData(chats, { exported } = {}) {
    return { exported, chats: chats.slice().sort((a, b) => String(b.updated || '').localeCompare(String(a.updated || ''))) };
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

  function joinPath(folder, rel) {
    const out = [];
    for (const s of `${folder || ''}/${rel || ''}`.split('/')) {
      if (s === '' || s === '.') continue;
      if (s === '..') out.pop();
      else out.push(s);
    }
    return out.join('/');
  }

  function escapeJson(data) {
    return JSON.stringify(data)
      .replace(/<\//g, '<\\/')
      .replace(/<!--/g, '\\u003c!--')
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029');
  }

  // One pass with function replacers: '$&' or a placeholder inside a value stays literal.
  // data: object (escaped here) or an already-escaped JSON string.
  function assembleViewer({ template, css, marked, katex, logic, app, data }) {
    const script = code => String(code).replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
    const values = {
      KATEX_CSS: () => String(css).replace(/<\/style/gi, '<\\/style'),
      DATA_JSON: () => (typeof data === 'string' ? data : escapeJson(data)),
      MARKED_JS: () => script(marked),
      KATEX_JS: () => script(katex),
      LOGIC_JS: () => script(logic),
      APP_JS: () => script(app)
    };
    return String(template).replace(/\/\*(KATEX_CSS|DATA_JSON|MARKED_JS|KATEX_JS|LOGIC_JS|APP_JS)\*\//g, (m, k) => values[k]());
  }

  const api = { buildViewerChat, buildViewerData, relHref, joinPath, escapeJson, assembleViewer, VIEWER_ASSETS, TOOL_TEXT_LIMIT };
  root.CTViewer = Object.assign(root.CTViewer || {}, api);
  if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis);
